import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LegacyBody,
  SETTINGS_SECTIONS,
  SettingsDialog,
  WorkspaceBody,
  availabilityOf,
  integerOptions,
  recoveryText,
  runtimeStatusText,
  samePolicy,
} from './SettingsDialog';

// UI slice A: the settings workspace behind `settingsWorkspaceV2`. What is covered here is what the
// dialog decides on its own — which body it renders for the flag, which nav row a scroll position
// lights up, and the two read-only lines the 詳細 section writes from store state. The controls
// themselves belong to the sections they were reused from and are covered where they live.

const TEAM_POLICY = {
  maxAgentDepth: 4,
  maxConcurrentExecutions: 8,
  allowWorkerDirectMessages: true,
  budgetMode: 'bounded',
} as const;

/** Enough of the preload bridge for `supported` to be true and for the Team/Skill/Provider sections
 * to mount. Every method is a stub that is never awaited: effects do not run under SSR. */
function stubBridge(): void {
  vi.stubGlobal('window', {
    sprintCoder: {
      settings: {
        getRuntime: () => Promise.resolve(),
        getTeamModelResearch: () => Promise.resolve({ researchBeforeHiring: false }),
        setTeamModelResearch: () => Promise.resolve(),
        getTeamModelSettings: () =>
          Promise.resolve({
            restriction: { mode: 'all', allowedModels: [] },
            availableModels: [],
          }),
        setTeamModelRestriction: () => Promise.resolve(),
        getDefaultTeamPolicy: () => Promise.resolve(TEAM_POLICY),
        setDefaultTeamPolicy: () => Promise.resolve(),
      },
    },
  });
}

// The two bodies are rendered directly rather than switched through the store: zustand v5 answers
// `useSyncExternalStore`'s server snapshot from `getInitialState`, so a `setState` before an SSR
// render is not visible to it. The flag *wiring* is one ternary in SettingsDialog, and the dialog
// below is rendered through it; what each body renders is what these cases are about.
const workspace = () => renderToStaticMarkup(<WorkspaceBody open supported onClose={() => {}} />);
const legacy = () => renderToStaticMarkup(<LegacyBody open supported onClose={() => {}} />);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which body the flag selects', () => {
  it('renders the workspace, with one nav row per section, when the flag is on', () => {
    stubBridge();
    // The store's initial `settingsWorkspaceV2` is true, so the dialog itself is the flag-on case.
    const html = renderToStaticMarkup(<SettingsDialog open onClose={() => {}} />);

    expect(html).toContain('class="settings-dialog settings-dialog-v2"');
    expect(html).toContain('class="settings-workspace"');
    for (const { id, label } of SETTINGS_SECTIONS) {
      expect(html).toContain(`data-testid="settings-nav-${id}"`);
      expect(html).toContain(`>${label}</span>`);
    }
    // Pages stay mounted so form drafts survive navigation, but only the selected category is
    // visible. This is page navigation, not one long settings document.
    expect(html).toContain('data-testid="settings-model"');
    expect(html).toContain('data-testid="settings-effort"');
    expect(html).toContain('data-testid="settings-cli-codex"');
    expect(html).toContain('data-testid="settings-team-research"');
    expect(html).toContain('data-testid="settings-team-defaults"');
    expect(html).toContain('data-testid="settings-team-models"');
    expect(html).toMatch(/data-testid="settings-page-models"[^>]*>/);
    expect(html).toMatch(/data-testid="settings-page-team"[^>]*hidden=""/);
  });

  it('keeps the shipped one-column body as the fallback when the flag is off', () => {
    stubBridge();
    const html = legacy();

    expect(html).toContain('class="settings-body"');
    expect(html).not.toContain('class="settings-nav"');
    expect(html).not.toContain('class="settings-page"');
    // The same controls remain available without duplicating the Composer's Runtime picker.
    expect(html).toContain('data-testid="settings-model"');
    expect(html).toContain('data-testid="settings-cli-claude"');
    expect(html).not.toContain('settings-runtime-');
  });

  it('closes and labels the same way in both bodies, and says so when the bridge is missing', () => {
    stubBridge();
    for (const html of [workspace(), legacy()]) {
      expect(html).toContain('data-testid="settings-close"');
      expect(html).toContain('id="settings-dialog-title"');
    }
    // The older-shell path, which must be a stated notice rather than a blank sheet or a throw —
    // and with no nav, since none of its rows would lead anywhere.
    const unsupported = renderToStaticMarkup(
      <WorkspaceBody open supported={false} onClose={() => {}} />,
    );
    expect(unsupported).toContain('data-testid="settings-unsupported"');
    expect(unsupported).not.toContain('class="settings-nav"');
  });

  it('shows the MIT License information in both settings layouts', () => {
    stubBridge();
    for (const html of [workspace(), legacy()]) {
      expect(html).toContain('data-testid="settings-license"');
      expect(html).toContain('MIT License');
      expect(html).toContain('Copyright (c) 2026 株式会社Robbits');
      expect(html).toContain('data-testid="settings-license-details"');
      expect(html).toContain('Permission is hereby granted, free of charge');
      expect(html).toContain('THE SOFTWARE IS PROVIDED');
    }
  });

  it('does not add a second heading called Skills', () => {
    // The Skill section's own heading is contributed by SkillSettingsSection. A page heading by the
    // same name would give the sheet two, which is ambiguous to a rotor and to a by-name locator.
    stubBridge();
    const headings = workspace().match(/Skills<\/h[1-6]>/g) ?? [];
    expect(headings).toHaveLength(1);
  });
});

describe('CLI detection status', () => {
  it('keeps an installed but unauthenticated CLI detected while explaining that login is needed', () => {
    expect(
      availabilityOf('codex', {
        codexReadiness: 'authentication_required',
        claudeReadiness: 'unavailable',
      }),
    ).toEqual({
      available: true,
      reason: 'Codexはインストール済みですが、ログインが必要です',
    });
  });
});

describe('the Team defaults form', () => {
  it('offers exactly the range the contract accepts', () => {
    expect(integerOptions({ min: 1, max: 4 })).toEqual([1, 2, 3, 4]);
    expect(integerOptions({ min: 1, max: 8 })).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('treats a policy as unchanged only when every field matches', () => {
    expect(samePolicy(TEAM_POLICY, { ...TEAM_POLICY })).toBe(true);
    expect(samePolicy(TEAM_POLICY, { ...TEAM_POLICY, maxAgentDepth: 2 })).toBe(false);
    expect(samePolicy(TEAM_POLICY, { ...TEAM_POLICY, budgetMode: 'unlimited' })).toBe(false);
    expect(samePolicy(TEAM_POLICY, { ...TEAM_POLICY, allowWorkerDirectMessages: false })).toBe(
      false,
    );
    // A form that has not loaded yet is not "the same as" a loaded one, and is not dirty either.
    expect(samePolicy(null, null)).toBe(true);
    expect(samePolicy(null, TEAM_POLICY)).toBe(false);
  });

  it('says it applies to new Teams only', () => {
    stubBridge();
    expect(workspace()).toContain('すでに動いているTeamの設定は変わりません');
  });
});

describe('the read-only lines in 詳細', () => {
  it('names the Runtime and its state, and carries the backend message when there is one', () => {
    expect(runtimeStatusText(null)).toBe('まだ通知はありません');
    expect(
      runtimeStatusText({
        kind: 'claude',
        state: 'running',
        taskId: null,
        errorCode: null,
        userMessage: null,
      }),
    ).toBe('Claude Code · 実行中');
    expect(
      runtimeStatusText({
        kind: 'codex',
        state: 'failed',
        taskId: 't1',
        errorCode: 'SPAWN',
        userMessage: 'CLIを起動できません',
      }),
    ).toBe('Codex · 失敗 · CLIを起動できません');
  });

  it('reports the launch recovery without inventing a verdict', () => {
    expect(recoveryText(null)).toBe('まだ読み込まれていません');
    expect(
      recoveryText({
        corruptionDetected: false,
        restoredFromBackup: false,
        freshStart: false,
        interruptedTurns: 0,
      }),
    ).toBe('問題なく起動しました');
    expect(
      recoveryText({
        corruptionDetected: true,
        restoredFromBackup: true,
        freshStart: false,
        interruptedTurns: 2,
      }),
    ).toBe('破損を検出 · バックアップから復元 · 中断されたターン 2件');
  });
});
