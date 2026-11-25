import { z } from 'zod';
import { currentWorkspaceRootIdentityDigest } from './path-guard';
import type { PersistenceClient } from './persistence';
import {
  globalPermissionSource,
  loadGlobalPermissionSettings,
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

type PermissionSource = {
  root: string;
  key: string;
  scope: 'global' | 'project';
  load: () => ProjectPermissionSettings;
};

const invalidRules: ProjectPermissionSettings = { valid: false, allow: [], deny: [], digest: '' };

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
  constructor(
    private readonly store: TrustStore,
    private readonly globalHome?: string,
  ) {}

  snapshot(root: string, expectedRootIdentity?: string): ProjectPermissionSettings {
    const global = this.globalSource();
    if (global === null) return invalidRules;
    const project = this.readTrusted({
      root,
      key: root,
      scope: 'project',
      load: () => loadProjectPermissionSettings(root, expectedRootIdentity, global?.root),
    });
    if (!project.valid || global === undefined) return project;
    const settings = this.readTrusted(global);
    if (!settings.valid) return settings;
    return {
      valid: true,
      digest: `${settings.digest}:${project.digest}`,
      allow: [...new Set([...settings.allow, ...project.allow])],
      deny: [...new Set([...settings.deny, ...project.deny])],
    };
  }

  private globalSource(): PermissionSource | null | undefined {
    if (this.globalHome === undefined) return undefined;
    const source = globalPermissionSource(this.globalHome);
    if (source === null) return null;
    return {
      root: source.root,
      key: source.trustKey,
      scope: 'global',
      load: () => loadGlobalPermissionSettings(source.root),
    };
  }

  private readTrusted(source: PermissionSource): ProjectPermissionSettings {
    const live = source.load();
    if (!live.valid) return live;
    try {
      const raw = this.store.readProjectPermissionTrust(source.key);
      if (raw === null) return { ...live, allow: [] };
      const saved = savedRulesSchema.parse(JSON.parse(raw));
      if (
        saved.digest === live.digest &&
        saved.rootIdentity === currentWorkspaceRootIdentityDigest(source.root)
      )
        return live;
      return { ...live, allow: [], deny: [...new Set([...live.deny, ...saved.deny])] };
    } catch {
      return invalidRules;
    }
  }

  async review(
    roots: readonly string[],
    confirm: (
      root: string,
      rules: ProjectPermissionSettings,
      scope: PermissionSource['scope'],
    ) => Promise<boolean>,
    stillCurrent: () => boolean,
  ): Promise<string> {
    const global = this.globalSource();
    if (global === null) return 'ホームの設定フォルダーを確認してください。';
    if (roots.length === 0 && global === undefined)
      return '先にプロジェクトのフォルダーを選んでください。';
    const sources: PermissionSource[] = roots.map((root) => ({
      root,
      key: root,
      scope: 'project',
      load: () => loadProjectPermissionSettings(root, undefined, global?.root),
    }));
    if (global !== undefined) sources.unshift(global);
    const changes = [];
    let alreadyApplied = false;
    for (const source of sources) {
      const { root, key, scope, load } = source;
      const rootIdentity = currentWorkspaceRootIdentityDigest(root);
      const live = load();
      const previous = this.store.readProjectPermissionTrust(key);
      if (!live.valid)
        return scope === 'global'
          ? 'ホームの .sprint-coder/settings.json の内容と読み取り権限を確認してください。'
          : `${root} の .sprint-coder/settings.json と settings.local.json の内容と読み取り権限を確認してください。`;
      if (!live.allow.length && !live.deny.length && previous === null) continue;
      if (!rootIdentity || currentWorkspaceRootIdentityDigest(root) !== rootIdentity)
        return 'フォルダーの場所を確認できませんでした。';
      if (scope === 'global' && previous !== null) {
        const saved = savedRulesSchema.safeParse(parseSavedRules(previous));
        if (
          saved.success &&
          saved.data.digest === live.digest &&
          saved.data.rootIdentity === rootIdentity
        ) {
          alreadyApplied = true;
          continue;
        }
      }
      if (!(await confirm(root, live, scope))) return '権限ルールの確認をキャンセルしました。';
      changes.push({ source, live, previous, rootIdentity });
    }
    if (!changes.length)
      return alreadyApplied
        ? '確認した全体の権限ルールを適用しています。'
        : 'ホームまたはプロジェクトの .sprint-coder/settings.json、もしくはプロジェクトの settings.local.json に権限ルールを指定してください。';
    if (
      !stillCurrent() ||
      changes.some(
        ({ source, live, previous, rootIdentity }) =>
          source.load().digest !== live.digest ||
          currentWorkspaceRootIdentityDigest(source.root) !== rootIdentity ||
          this.store.readProjectPermissionTrust(source.key) !== previous,
      )
    )
      return '確認中にフォルダーまたは設定が変わりました。もう一度ルールを確認してください。';
    this.store.saveProjectPermissionTrust(
      changes.map(({ source, live, rootIdentity }) => ({
        root: source.key,
        value: JSON.stringify({ rootIdentity, digest: live.digest, deny: live.deny }),
      })),
    );
    return '確認した権限ルールを適用しました。';
  }
}

function parseSavedRules(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
