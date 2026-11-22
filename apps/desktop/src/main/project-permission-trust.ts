import { z } from 'zod';
import { currentWorkspaceRootIdentityDigest } from './path-guard';
import type { PersistenceClient } from './persistence';
import {
  loadProjectPermissionSettings,
  type ProjectPermissionSettings,
} from './project-permission-settings';

const savedRulesSchema = z.object({
  rootIdentity: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  deny: z.array(z.string()),
});

type TrustStore = Pick<
  PersistenceClient,
  'readProjectPermissionTrust' | 'saveProjectPermissionTrust'
>;

/** Keep every reviewed rule visible in a native dialog, including long command lines. */
export function projectRuleReviewPages(rules: ProjectPermissionSettings): string[] {
  const lines = [
    ...rules.allow.map((rule) => `許可 ${rule}`),
    ...rules.deny.map((rule) => `禁止 ${rule}`),
  ];
  if (!lines.length) return ['以前に確認したルールを解除します。'];
  const pages: string[] = [];
  let page = '';
  for (const line of lines) {
    if (page.length + line.length > 1400 || page.split('\n').length >= 14) {
      pages.push(page);
      page = '';
    }
    page = page ? `${page}\n${line}` : line;
  }
  pages.push(page);
  return pages;
}

/** Only the native confirmation writes trust. Workspace files alone can add restrictions. */
export class ProjectPermissionTrust {
  constructor(private readonly store: TrustStore) {}

  snapshot(root: string): ProjectPermissionSettings {
    const live = loadProjectPermissionSettings(root);
    if (!live.valid) return live;
    try {
      const raw = this.store.readProjectPermissionTrust(root);
      if (raw === null) return { ...live, allow: [] };
      const saved = savedRulesSchema.parse(JSON.parse(raw));
      if (
        saved.digest === live.digest &&
        saved.rootIdentity === currentWorkspaceRootIdentityDigest(root)
      )
        return live;
      return { ...live, allow: [], deny: [...new Set([...live.deny, ...saved.deny])] };
    } catch {
      return { valid: false, allow: [], deny: [], digest: '' };
    }
  }

  async review(
    roots: readonly string[],
    confirm: (root: string, rules: ProjectPermissionSettings) => Promise<boolean>,
    stillCurrent: () => boolean,
  ): Promise<string> {
    if (roots.length === 0) return '先にプロジェクトのフォルダーを選んでください。';
    const changes = [];
    for (const root of roots) {
      const live = loadProjectPermissionSettings(root);
      const previous = this.store.readProjectPermissionTrust(root);
      if (!live.valid)
        return `${root} の .sprint-coder/settings.json と settings.local.json の内容と読み取り権限を確認してください。`;
      if (!live.allow.length && !live.deny.length && previous === null) continue;
      const rootIdentity = currentWorkspaceRootIdentityDigest(root);
      if (!rootIdentity) return 'フォルダーの場所を確認できませんでした。';
      if (!(await confirm(root, live))) return '権限ルールの確認をキャンセルしました。';
      changes.push({ root, live, previous, rootIdentity });
    }
    if (!changes.length)
      return 'プロジェクト内の .sprint-coder/settings.json または .sprint-coder/settings.local.json に permissions.allow と permissions.deny を指定してください。';
    if (
      !stillCurrent() ||
      changes.some(
        ({ root, live, previous, rootIdentity }) =>
          loadProjectPermissionSettings(root).digest !== live.digest ||
          currentWorkspaceRootIdentityDigest(root) !== rootIdentity ||
          this.store.readProjectPermissionTrust(root) !== previous,
      )
    )
      return '確認中にフォルダーまたは設定が変わりました。もう一度ルールを確認してください。';
    this.store.saveProjectPermissionTrust(
      changes.map(({ root, live, rootIdentity }) => ({
        root,
        value: JSON.stringify({ rootIdentity, digest: live.digest, deny: live.deny }),
      })),
    );
    return '確認した権限ルールを適用しました。';
  }
}
