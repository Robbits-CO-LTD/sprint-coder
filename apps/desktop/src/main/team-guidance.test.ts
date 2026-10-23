import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTEXT_SYSTEM_PROMPT } from './context-ledger';
import {
  isExistingTeamFollowupInput,
  isTeamContinuationInput,
  isTeamScenarioInput,
  requiresTeamWorkersInput,
  LEADER_MCP_SYSTEM_PROMPT,
  LEADER_PROVIDER_TOOLS,
  TEAM_HIRE_WORKER_TOOL,
} from './team-tools';
import { teamGuidance } from './ipc';
import {
  attachBuiltinTeamSkill,
  BUILTIN_TEAM_SKILL_CONTENT,
  BUILTIN_TEAM_SKILL_DIGEST,
  BUILTIN_TEAM_SKILL_FRAGMENT_ID,
  installBuiltinTeamSkill,
  verifyBuiltinTeamSkillAcceptance,
} from './team-skill';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('builtin Team skill', () => {
  it('routes team-related conversation through the builtin Team skill', () => {
    expect(CONTEXT_SYSTEM_PROMPT).toContain('必ず組み込みSkill `sprint-coder-team` を使い');
    expect(CONTEXT_SYSTEM_PROMPT).toContain(
      'subagent機能、外部Skill、別のMCPで代用してはいけません',
    );
    expect(CONTEXT_SYSTEM_PROMPT).toContain('架空のリーダーやメンバーを作らず');
    expect(isTeamScenarioInput('チームで二人雇って挨拶して')).toBe(true);
  });

  it('is the single source of Leader guidance', () => {
    expect(LEADER_MCP_SYSTEM_PROMPT).toBe(BUILTIN_TEAM_SKILL_CONTENT);
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_list_models');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_send_message');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_read_messages');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_hire_worker');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('writeCapable: true');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('agentKind: "manager"');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('maxDelegationLevels: 1');
    expect(BUILTIN_TEAM_SKILL_CONTENT).not.toContain('maxDelegationDepth');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_get_status');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_steer_execution');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('liveOutput');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_wait_reports');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('未着report');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('全execution ID');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('終端済みの旧Workerは再利用できない');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain(
      'Team状態がfailedなどcompleted以外なら再形成できると判断せず',
    );
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain(
      '新しいWorkerの採用によって完了済みTeamは安全に再形成される',
    );
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain(
      '採用失敗だけを理由に「新しいTeamが必要」と判断してはならない',
    );
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('builtin:claude-cli');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('OpenRouter上のClaudeよりClaude CLIを優先');
  });

  it('adds the saved model-selection policy to Team guidance', () => {
    const guidance = teamGuidance(
      'base',
      false,
      'APIを使う前にユーザーへ確認する。ClaudeはClaude CLIを選ぶ。',
    );
    expect(guidance).toContain('<team-model-selection-guidance>');
    expect(guidance).toContain('APIを使う前にユーザーへ確認する');
    expect(guidance).toContain('必ず従ってください');
  });

  it('recognizes explicit Team and worker-count intent without activating ordinary turns', () => {
    for (const input of [
      'チームで進めて',
      'Codexでチーム編成して',
      'チーム作成してください',
      'チーム編成をお願いします',
      'チーム内で挨拶して',
      'チーム内の会話を読んで',
      'チームメンバー同士で挨拶して',
      'チームのメンバーに会話させて',
      'チームの会話を読んで',
      'チームのメンバーに挨拶して',
      'Teamでお願い',
      'team使える？',
      'team 使える？',
      'team　使える？',
      'team 　使える？',
      'Team作成は完了できませんでした。利用上限なら別のAIへfallbackしてください。',
      'Teamがfailed状態です。利用可能なWorkerだけ追加してください。',
      'Team実行ツールは現在のTurnで利用できません。',
      'team 2り雇って挨拶を交わして',
      '2人雇って調査して',
      '数学と実装の観点を2人体制で並行に検討して',
      '5人で作業して',
      '八人でレビューして',
      '10人で監査して',
      '１０人で実装して',
      '合計10名構成で検証して',
      '合計10名（深度0×1・1×3・2×6）を作成して',
      '/team リポジトリを並列調査して',
      '/TEAM\n設計と実装を分担して',
      '会社のような組織を Team で作れるかのテストです。部長を 3 人雇ってください。',
      'Team　を組んで調査して',
      '3 人雇って調査して',
      '合計10 名構成で検証して',
      'team 2 り雇って挨拶を交わして',
    ])
      expect(isTeamScenarioInput(input), input).toBe(true);
    for (const input of [
      '簡単に説明して',
      '一人称を直して',
      'teamworkについて説明して',
      'team\t使える？',
      'team\n使える？',
      'READMEに team 使える？ と書いて',
      'チームの意味を説明して',
      'チーム編成について説明して',
      'チーム作成とは何か説明して',
      '/team',
      '/teamworkについて説明して',
      'READMEに /team 調査して と書いて',
      'our team is great',
      'team\t で使える？',
      'The team で is not Japanese',
    ])
      expect(isTeamScenarioInput(input), input).toBe(false);
  });

  it('recognizes explicit leader/worker role assignments without activating explanations', () => {
    const executions = [
      'Sprint Coderで現在選択しているモデルをリーダーにしてOllamaのローカルLLMをワーカーにした実装skillを構築して',
      'Use Codex as the leader and Ollama as the worker to implement this feature',
      'リーダーをCodex、ワーカーをOllamaへ変更して作業を進めて',
      'Codexをリーダー、Ollamaをワーカーにして実装して',
      'Make Codex the leader and Ollama the worker and implement this feature',
      'Use Codex as the leader and Ollama as the worker to implement this without adding dependencies',
      'Use Codex as the leader and Ollama as the worker to implement this and never modify tests',
      'Set Codex as the leader and Ollama as the worker, then implement this feature',
      'Make Codex the leader and Ollama the worker, then implement this feature',
    ];
    const consultations = [
      'リーダーとワーカーの違いを説明して',
      'リーダーにする方法とワーカーにする方法を説明して',
      'リーダーモデルとワーカーモデルを比較して',
      'リーダーとワーカーの設定について相談したい',
      'リーダーとワーカーを割り当てずに説明して',
      'リーダーをCodexにしてワーカーをOllamaにしないで実装して',
      'リーダーについて説明し、ワーカーをOllamaへ変更して実装して',
      'リーダー候補を比較し、ワーカーをOllamaにして実装して',
      "Don't use Codex as the leader or Ollama as the worker; review this plan",
      'Never use Codex as the leader and Ollama as the worker; implement it yourself',
      "Codex shouldn't be used as the leader and Ollama as the worker; review this plan",
      'Review the sentence “Use Codex as the leader and Ollama as the worker to implement this feature” for grammar',
      '次の文「CodexをリーダーにしてOllamaをワーカーにした機能を実装して」を添削して',
      'Codexをリーダーにしてはいけない、Ollamaをワーカーにして実装して',
      'リーダーをCodexと比較し、ワーカーをOllamaと比較し、実装して',
      'リーダーをCodexと比較し、ワーカーをOllamaにして実装して',
      'リーダーをCodexと対比し、ワーカーをOllamaにして実装して',
      'リーダーをCodexと評価し、ワーカーをOllamaにして実装して',
      "Use the sentence 'Codex as the leader and Ollama as the worker' and review its grammar",
      'Use the sentence Codex as the leader and Ollama as the worker and review its grammar',
      'Use this sentence as an example: Codex as the leader and Ollama as the worker and review its grammar',
      'Use the following text: Codex as the leader and Ollama as the worker and review it',
      'Use Codex as the leader but do not use Ollama as the worker and implement this feature',
      'Use Codex not as the leader and Ollama not as the worker and implement this feature',
      'Codexをリーダーにしたくない、Ollamaをワーカーにして実装して',
      'Codexをリーダーにしてほしくない、Ollamaをワーカーにして実装して',
      'Codexをリーダーにして欲しくない、Ollamaをワーカーにして実装して',
      'Codexをリーダーへ変更して欲しくない、Ollamaをワーカーにして実装して',
      'Use Codex as the leader and Ollama as the worker to implement this, or would another setup be better?',
      'Use Codex as the leader and Ollama as the worker to implement this—actually, don’t.',
    ];
    for (const input of executions) {
      expect(isTeamScenarioInput(input), input).toBe(true);
      expect(requiresTeamWorkersInput(input), input).toBe(true);
    }
    for (const input of consultations) {
      expect(isTeamScenarioInput(input), input).toBe(false);
      expect(requiresTeamWorkersInput(input), input).toBe(false);
    }
  });

  it('separates Team consultation from requests that must create Workers', () => {
    expect(isTeamScenarioInput('teamで並列編集できますか？')).toBe(true);
    expect(requiresTeamWorkersInput('teamで並列編集できますか？')).toBe(false);
    expect(requiresTeamWorkersInput('Workerを3名雇って編集して')).toBe(true);
    expect(requiresTeamWorkersInput('チームでコードを書いて')).toBe(true);
    expect(requiresTeamWorkersInput('チームで編集してください')).toBe(true);
    expect(requiresTeamWorkersInput('Workerを3名雇ってください')).toBe(true);
    expect(requiresTeamWorkersInput('Teamで実行してほしい')).toBe(true);
    expect(requiresTeamWorkersInput('Team で実行してほしい')).toBe(true);
    expect(requiresTeamWorkersInput('3 人雇って調査して')).toBe(true);
    expect(requiresTeamWorkersInput('チームでの編集をお願いします')).toBe(true);
    expect(
      requiresTeamWorkersInput('Workerを3名雇って実装してください。完了後に結果を教えて'),
    ).toBe(true);
    expect(requiresTeamWorkersInput('/team リポジトリを並列調査して')).toBe(true);
    expect(requiresTeamWorkersInput('チームで何ができますか？')).toBe(false);
    expect(requiresTeamWorkersInput('チームの使い方を説明して')).toBe(false);
  });

  it.each([
    '部長が担当を雇って絵を描かせます。',
    '担当を雇って1人1件ずつ資料（TXT）と説明を docs/ に書かせます。',
    '担当を雇って資料を docs/ に書かせます。',
    '担当を雇って1人1件ずつ資料を作成してください。',
    '担当を雇って1人ずつ2件を調査して。',
    '担当を雇って2名ずつ3枚（PNG）を作成させます。',
    '担当を雇って3人ずつ4件と報告を outputs/ に書かせます。',
    '担当を雇って2件を調査して。',
    'ワーカーを雇って２人三枚ずつ画像（SVG）と報告を outputs/ に作成させます。',
    '担当を雇って3名2本ずつ図（PNG）や報告を artifacts/images/ に書かせます。',
    '担当を雇って資料(CSV)と概要をreports/に書かせます。',
    '担当を雇って`README.md`を書かせます。',
    '担当を雇って「設計書」を作成させます。',
    '担当を雇ってIssue#12を修正させます。',
    '担当を雇ってＡＰＩを実装させます。',
    '担当を雇ってください。',
    '担当を雇って資料を作成してください。',
    '担当を雇用して絵を描かせます。',
    'ワーカーを雇って。',
    'Worker を雇ってください。',
    'Agent　を　雇用してください。',
    '担当者を雇ってください。',
    'メンバーを雇ってください。',
    'リーダーを雇ってください。',
    '担当 ２ 名を雇って絵を描かせます。',
    'Workerを三人雇って資料を作成してください。',
    '「作業のきまり」に従い、担当を雇って絵を描かせます。',
    '担当を雇って絵を描かせ、結果を教えて。',
    '担当を雇って絵を描かせます。依存関係は変更しないでください。',
    '依存関係は変更しないで、担当を雇って資料を作成してください。',
    '担当を雇ってもらえますか？',
    '担当を雇っていただけますか？',
    '担当を雇ってくれませんか？',
    '担当を雇ってもらえないでしょうか。',
    '担当を雇っていただけませんでしょうか。',
    '担当を雇ってくれない？',
    '担当を雇っていただくようお願いします。',
    '担当を雇っていただいて、資料を作成してください。',
    '担当を雇ってもらえますか？とても助かります。',
    '担当を雇って資料を作成して、実装方法を教えて。',
    "Don't change dependencies. 担当を雇ってください。",
    '「担当を雇ってはいけません」は引用です。担当を雇ってください。',
    '担当を雇ってはいけません。ワーカーを雇ってください。',
  ])('recognizes explicit member hiring without another sentence-final action: %s', (input) => {
    expect(isTeamScenarioInput(input)).toBe(true);
    expect(requiresTeamWorkersInput(input)).toBe(true);
  });

  it.each([
    '「担当を雇って絵を描かせます」という文を添削して。',
    '『担当を雇ってください。』を訳して。',
    '“担当を雇ってください。”を訳して。',
    '"担当を雇ってください。"を訳して。',
    "'担当を雇ってください。'を訳して。",
    '`担当を雇ってください` をREADMEに追記して。',
    '``担当を雇ってください`` をREADMEに追記して。',
    '```text\n担当を雇ってください。\n```\nこの例を添削して。',
    '~~~text\n担当を雇ってください。\n~~~\nこの例を添削して。',
    '次の引用を添削して。「担当を雇ってください。',
    '次のコードを説明して。`担当を雇ってください。',
    '担当「を雇ってください」という例です。',
    '担当を雇ってはいけません。',
    '担当を雇ってはならない。',
    '担当を雇ってはなりません。',
    'まだ担当を雇ってない。',
    '担当を雇ってるので、追加は不要です。',
    '担当を雇ってあります。',
    '担当を雇ってもいいですが、今回は自分で進めてください。',
    'ワーカーを雇ってもエラーになる原因を調べて。',
    '担当を雇ってはだめです。',
    '担当を雇ってほしくありません。',
    '担当を雇って欲しくない。',
    '担当を雇ってはほしくない。',
    '担当を雇ってほしいわけではありません。',
    '担当を雇ってほしいわけじゃないです。',
    '担当を雇ってもらわないでください。',
    '担当を雇ってもらえません。',
    '担当を雇ってもらいたくありません。',
    '担当を雇っていただきたくない。',
    '担当を雇ってくれなくて構いません。',
    '担当を雇ってなどいません。',
    '担当を雇っていいですか？',
    '担当を雇って進める方法を教えて。',
    '担当を雇って進める手順を説明してください。',
    '担当を雇って絵を描かせることはできますか？',
    '担当を雇って何ができますか？',
    '担当を雇って進められますか？',
    '担当を雇って、何ができますか？',
    '担当を雇ってからエラーが出ます。原因を調べて。',
    '勝手に担当を雇って作業させないでください。',
    '勝手に担当を雇って作業させないで自分で実装してください。',
    '担当を雇って2人3件ずつ作業させないで自分で実装してください。',
    '担当を雇って資料と作業させないで自分で実装してください。',
    '担当を雇って資料を docs/ に置かないで実装して。',
    '担当を雇って資料（作業させないで）を実装して。',
    '担当を雇って「資料」を書かせないで自分で実装して。',
    '担当を雇って`x`と作業させないで自分で実装してください。',
    '担当を雇って資料を自分で実装して。',
    '担当を雇って1人ずつ2件を調査しないでください。',
    '担当を雇ってほしいのではなく自分で実装してください。',
    '担当を雇って進めるのはやめて自分で実装して。',
    '担当を雇っている理由を調査して。',
    'ワーカーを雇って進める必要はありません。',
    '担当を雇ってほしいとは思いません。',
    '担当を雇っては困ります。',
    '担当を雇ってはいかがですか？',
    '担当を雇ってもらっているので、追加は不要です。',
    '担当を雇ってくれてるので、追加は不要です。',
    '担当を雇っていただいたので、資料はできています。',
    '担当を雇ってはどうですか？',
    '担当を雇ってもらうにはどうすればいいですか？',
    '担当を雇っている理由を説明して。',
    '担当を雇っていました。',
    '担当を雇っておりません。',
    '担当を雇ってもらいました。',
    '担当を雇って資料を作りました。',
    '担当を雇って絵を描かせた。',
    '担当を雇って、絵を描かせました。',
    '担当を雇ってください、と伝えました。',
    '担当を雇ってください、と言われましたが、今回は雇わず説明だけしてください。',
    '担当を雇ってください、と伝えられました。',
    '担当を雇ってください、と頼まれました。',
    '担当を雇ってください、と指示されました。',
    '担当を雇ってください、と依頼されました。',
    '担当を雇ってもらえますか、と伝えました。',
    '担当を雇ってもらえますか？と伝えました。',
    'ワーカーを雇ってくださいと送ったら、エラーになりました。',
    '担当を雇ってください、と頼んだら断られました。',
    'リーダーの案を採用してください。',
    'Web Workerを採用して実装して。',
    '担当者に確認し、新しいライブラリを採用して。',
    '担当の案を雇用してください。',
    '担当を決めてからライブラリを雇用して。',
  ])('does not infer member hiring from quoted, prohibited or descriptive text: %s', (input) => {
    expect(isTeamScenarioInput(input)).toBe(false);
    expect(requiresTeamWorkersInput(input)).toBe(false);
  });

  it.each([
    ['担当を雇って\nはいけません。自分で実装してください。', false],
    ['ワーカーを雇用して\r\nはなりません。', false],
    ['担当を雇って\rいました。', false],
    ['担当を雇って\nほしいわけではありません。', false],
    ['担当を雇ってください\nと伝えました。', false],
    ['担当を雇ってもらえますか？\nと伝えました。', false],
    ['担当を雇って\n資料を作成してください。', true],
    ['担当を雇って\r\nください。', true],
    ['担当を雇って資料を\n作成してください。', true],
    ['担当を雇ってください。\n依存関係は変更しないでください。', true],
    ['担当を雇ってください\n- 調査\n- 実装', true],
    ['担当を雇ってください\nREADMEを更新して', true],
    ['担当を雇ってください\nよろしくお願いします。', true],
    ['担当を雇ってください\nあと、READMEを更新して', true],
    ['担当を雇って資料を作成して\nください。', true],
    ['担当を雇ってください\nとは言っていません。', false],
    ['担当を雇ってほしい\n訳ではありません。', false],
    ['Web\nWorkerを雇ってください。', true],
    ['Work\nerを雇ってください。', false],
  ])('keeps a hiring clause connected across line breaks: %s', (input, expected) => {
    expect(isTeamScenarioInput(input)).toBe(expected);
    expect(requiresTeamWorkersInput(input)).toBe(expected);
  });

  it.each([
    ['担当を雇ってほしい、というわけではありません。自分で実装してください。', false],
    ['担当を雇って欲しい,という意味ではありません。', false],
    ['担当を雇ってください、というのは例文です。', false],
    ['担当を雇って絵を描かせ、という話を読んだだけです。', false],
    ['担当を雇って資料を作成して、結果を教えて、という意味ではありません。', false],
    ['担当を雇ってほしい、まだ決めていません。', false],
    ['担当を雇って、方法を教えて。', false],
    ['担当を雇って絵を描かせ、結果を教えて。', true],
    ['担当を雇って資料を作成して、実装方法を教えて。', true],
    ['担当を雇っていただいて、資料を作成してください。', true],
    ['担当を雇っていただいて、資料を作成してください、結果を教えて。', true],
    ['担当を雇って、資料を作成してください、結果を報告してください。', true],
  ])('requires affirmative continuations after every hiring comma: %s', (input, expected) => {
    expect(isTeamScenarioInput(input)).toBe(expected);
    expect(requiresTeamWorkersInput(input)).toBe(expected);
  });

  it.each([
    ['担当を雇ってもらえますか？と聞かれました。返答文を考えてください。', false],
    ['担当を雇ってもらえますか？ と尋ねられました。', false],
    ['担当を雇ってください！って聞かれました。', false],
    ['担当を雇ってください。という文を添削してください。', false],
    ['担当を雇ってください？！。　と尋ねられました。', false],
    ['担当を雇ってもらえますか!? と聞かれました。', false],
    ['担当を雇ってください。 、 と聞かれました。', false],
    ['担当を雇ってもらえますか？とても助かります。', true],
    ['担当を雇ってください！　とても助かります。', true],
    ['担当を雇ってください。という例です。ワーカーを雇ってください。', true],
  ])('keeps quoted continuations attached across punctuation runs: %s', (input, expected) => {
    expect(isTeamScenarioInput(input)).toBe(expected);
    expect(requiresTeamWorkersInput(input)).toBe(expected);
  });

  it.each([
    ['担当を雇ってもらえますか？なんて聞かれました。', false],
    ['担当を雇ってください！みたいな依頼が来ました。', false],
    ['担当を雇ってください！みたいに言われました。', false],
    ['担当を雇ってください。などと書かれていました。', false],
    ['担当を雇ってもらえますか？\nなんて言われました。', false],
    ['担当を雇ってください！のような文を添削して。', false],
    ['担当を雇ってください。のように書かれていました。', false],
    ['担当を雇ってもらえますか？とても助かります！って言われました。', false],
    ['担当を雇ってください。とても助かります。なんて聞かれました。', false],
    ['”担当を雇ってください。”を訳して。', false],
    ['＂担当を雇ってください。＂を訳して。', false],
    ['〝担当を雇ってください。〟という文を添削して。', false],
    ['〝担当を雇ってください。〞という文を添削して。', false],
    ['担当を雇っていただいて！本当に助かりました。', false],
    ['担当を雇っていただいて、資料を作成してください。', true],
    ['担当を雇ってもらえますか？とても助かります。', true],
    ['担当を雇ってください。とても助かります！とても助かります。', true],
    ['”担当を雇ってはいけません。”は例です。担当を雇ってください。', true],
    ['Don’t change dependencies. 担当を雇ってください。', true],
    ['担当を雇って、担当を雇って、資料を作成してください。', true],
    ['担当を雇ってメンバーを雇ってください。', true],
    ['担当を雇ってメンバーを雇ってはいけません。', false],
  ])('keeps quotation syntax and trailing courtesy distinct from hiring: %s', (input, expected) => {
    expect(isTeamScenarioInput(input)).toBe(expected);
    expect(requiresTeamWorkersInput(input)).toBe(expected);
  });

  it('keeps bounded punctuation runs and grouped quotation segments inert', () => {
    const prefix = '担当を雇ってもらえますか';
    const suffix = 'と聞かれました。';
    const inputs = [
      '？'.repeat(100_000),
      prefix + '？！。'.repeat(Math.floor((100_000 - prefix.length - suffix.length) / 3)) + suffix,
      (prefix + '？' + suffix).repeat(4_000),
      prefix + '？' + 'と補足します。'.repeat(10_000),
    ];
    for (const input of inputs) {
      expect(isTeamScenarioInput(input)).toBe(false);
      expect(requiresTeamWorkersInput(input)).toBe(false);
    }
  });

  it('does not infer work from many hiring matches before an unknown continuation', () => {
    for (const input of [
      '担当を雇って、'.repeat(14_000) + '結果を見ました。',
      '担当を雇って\n'.repeat(14_000) + 'あ',
      '担当を雇って'.repeat(14_000) + 'あ',
    ]) {
      expect(input.length).toBeLessThanOrEqual(100_000);
      expect(isTeamScenarioInput(input)).toBe(false);
      expect(requiresTeamWorkersInput(input)).toBe(false);
    }
  });

  it.each([
    ['次の引用文を添削してください。\n> 担当を雇ってください。', false],
    ['> 引用文です。\n担当を雇ってください。', false],
    ['> > 担当を雇ってください。', false],
    ['- > 担当を雇ってください。', false],
    ['例を説明してください。\n\n    担当を雇ってください。', false],
    ['\t担当を雇ってください。', false],
    ['- 例:\n\n      担当を雇ってください。', false],
    ['```text\n担当を雇ってください。\n```', false],
    ['~~~text\n担当を雇ってください。\n~~~', false],
    ['次のHTML例を説明してください。\n\n<!-- 担当を雇ってください。 -->', false],
    ['次のHTML例を説明してください。\n\n<pre>担当を雇ってください。</pre>', false],
    ['<!-- 担当を雇ってはいけません。 -->\n\n担当を雇ってください。', true],
    ['> 引用文です。\n\n担当を雇ってください。', true],
    ['> 担当を雇ってはいけません。\n\n担当を雇ってください。', true],
    ['    担当を雇ってはいけません。\n\n担当を雇ってください。', true],
    ['```text\n担当を雇ってはいけません。\n```\n担当を雇ってください。', true],
    ['前置きです。\n    担当を雇ってください。', true],
    ['   担当を雇ってください。', true],
    ['🌊 例です。\n\n> 担当を雇ってください。', false],
  ])('distinguishes Markdown examples from member hiring instructions: %s', (input, expected) => {
    expect(isTeamScenarioInput(input)).toBe(expected);
    expect(requiresTeamWorkersInput(input)).toBe(expected);
  });

  it('masks an unclosed escaped quotation through a trailing backslash', () => {
    for (const quote of ['"', "'"]) {
      const input = quote + `\\${quote}`.repeat(4_000) + '担当を雇ってください\\';
      expect(isTeamScenarioInput(input)).toBe(false);
      expect(requiresTeamWorkersInput(input)).toBe(false);
    }
  });

  it('does not infer hiring work from a long quantity prefix without an object or action', () => {
    const input = '担当を雇って' + '1人'.repeat(10_000) + 'あ';
    expect(isTeamScenarioInput(input)).toBe(false);
    expect(requiresTeamWorkersInput(input)).toBe(false);
  });

  it('routes Team diagnostics without requiring a Worker', () => {
    const roleAssignment =
      'Sprint Coderで現在選択しているモデルをリーダーにしてOllamaのローカルLLMをワーカーにした実装skillを構築して';
    const diagnostics = [
      ['そもそもなぜsprint-coder-teamが使えないのか調査して。ログファイルを見て', true],
      ['Team Skillのログを見て', true],
      ['Team MCPの不具合を確認して', true],
      ['チームの使い方を説明して', false],
    ] as const;

    expect(isTeamScenarioInput(roleAssignment)).toBe(true);
    expect(requiresTeamWorkersInput(roleAssignment)).toBe(true);
    for (const [input, teamScenario] of diagnostics) {
      expect(isTeamScenarioInput(input), input).toBe(teamScenario);
      expect(requiresTeamWorkersInput(input), input).toBe(false);
    }
    expect(requiresTeamWorkersInput('Teamで原因を調査して')).toBe(true);
    expect(requiresTeamWorkersInput('Workerを2名雇ってログを調査して')).toBe(true);
    expect(requiresTeamWorkersInput('チームに調査してほしい')).toBe(true);
    expect(requiresTeamWorkersInput('Team MCPを使って調査して')).toBe(true);
    expect(requiresTeamWorkersInput('チーム内のメンバーでレビューして')).toBe(true);
    expect(requiresTeamWorkersInput('チームのメンバーに調査して')).toBe(true);
    expect(requiresTeamWorkersInput('チーム編成して')).toBe(true);
  });

  it('recognizes narrow retry and Team member reassignment instructions as continuation input', () => {
    for (const input of [
      'continue',
      'Resume',
      'retry',
      '続けて',
      '再開してください',
      'リトライ',
      'やって',
      'やってください。',
      '進めて',
      '実行してほしい',
      'お願いします',
      'codex to ollamanisite',
      'CodexとOllamaにして',
      '担当をCodexとOllamaへ変更して',
      'Ollama担当にして',
    ])
      expect(isTeamContinuationInput(input), input).toBe(true);
    for (const input of [
      '続きを説明して',
      'やってはいけない',
      'やっていいか説明して',
      '実行しないで',
      '「やって」とREADMEに書いて',
      'continue implementing this feature',
      '通常の依頼です',
      'モデルを変更して',
      '使用モデルをClaudeにして',
      'Codexに変更して',
      'ワーカーをOllamaにした理由を説明して',
      'workerのtechnisiteを説明して',
    ])
      expect(isTeamContinuationInput(input), input).toBe(false);
  });

  it('recognizes follow-up actions that target an existing Team without the Team keyword', () => {
    for (const input of [
      'worker同士で挨拶して',
      'メンバーからの報告を確認して',
      'リーダーにもう一度連絡して',
      'もう一回挨拶して',
      '再度会話させて',
      'workerに実装させて',
      'メンバーへ調査を依頼して',
    ])
      expect(isExistingTeamFollowupInput(input), input).toBe(true);
    for (const input of [
      '続きを説明して',
      'もう一回ビルドして',
      'もう一回実装して',
      'worker.tsを編集して',
      'メンバー変数を実装して',
      'agentの実装をレビューして',
      'workerの実装を確認して',
      '通常の依頼です',
    ])
      expect(isExistingTeamFollowupInput(input), input).toBe(false);
  });

  it('keeps the built-in and Provider hire schemas on the same discriminated contract', () => {
    const builtInSchema = TEAM_HIRE_WORKER_TOOL.inputSchema as Record<string, unknown>;
    const providerSchema = LEADER_PROVIDER_TOOLS.find(({ name }) => name === 'team_hire_worker')
      ?.inputSchema as unknown as Record<string, unknown>;
    expect(providerSchema['properties']).toEqual(builtInSchema['properties']);
    expect(providerSchema['allOf']).toEqual(builtInSchema['allOf']);
    expect(providerSchema['required']).toEqual(
      expect.arrayContaining(['agentKind', 'role', 'objective']),
    );
  });

  it('injects the authority-bearing fragment only for a Team turn', () => {
    const prepared = {
      fragments: [],
      projectItems: [],
      projectSnapshotDigest: null,
      usageEvents: [],
      compacted: false,
    };
    expect(attachBuiltinTeamSkill(prepared, 'task-1', false)).toBe(prepared);
    const attached = attachBuiltinTeamSkill(prepared, 'task-1', true);
    expect(attached.fragments).toHaveLength(1);
    expect(attached.fragments[0]).toMatchObject({
      id: BUILTIN_TEAM_SKILL_FRAGMENT_ID,
      source: 'system',
      trust: 'system',
      content: BUILTIN_TEAM_SKILL_CONTENT,
    });
    expect(BUILTIN_TEAM_SKILL_FRAGMENT_ID).toContain(BUILTIN_TEAM_SKILL_DIGEST);
  });

  it('fails acceptance when the expected fragment is absent or unexpectedly present', () => {
    expect(verifyBuiltinTeamSkillAcceptance(true, [BUILTIN_TEAM_SKILL_FRAGMENT_ID])).toBe(true);
    expect(verifyBuiltinTeamSkillAcceptance(true, [])).toBe(false);
    expect(verifyBuiltinTeamSkillAcceptance(false, [BUILTIN_TEAM_SKILL_FRAGMENT_ID])).toBe(false);
    expect(verifyBuiltinTeamSkillAcceptance(false, [])).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'installs a private versioned snapshot in the builtin namespace',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-team-skill-'));
      roots.push(root);
      await installBuiltinTeamSkill(root);
      const path = join(root, '.sprintcoder', 'skills', 'builtin', 'sprint-coder-team');
      expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(BUILTIN_TEAM_SKILL_CONTENT);
      expect(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))).toMatchObject({
        source: 'builtin',
        digest: BUILTIN_TEAM_SKILL_DIGEST,
        activationMode: 'system',
        replaceable: false,
      });
    },
  );
});
