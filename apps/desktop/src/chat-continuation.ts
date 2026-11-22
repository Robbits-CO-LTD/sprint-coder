export const WORKSPACE_REQUEST = '作業フォルダーを選んでください。';
export const WORKSPACE_REQUEST_GUIDANCE = `依頼に作業フォルダーが必要なら、理由を説明し、回答の最後の行に「${WORKSPACE_REQUEST}」とだけ書く。このチャットにフォルダー選択ボタンが表示される。`;
export const SKILL_REQUEST_GUIDANCE =
  '依頼に合う有効な手動選択Skillがカタログにあり、現在のモデルで利用可能で未選択なら、使う理由を説明して承認を求める。回答の最後の行に 使用するSkill「source/id」 と書き、source と id をカタログの値に置き換える。承認後のTurnで本文を使う。外部SkillをSprint Coder用に作り直すには、カタログの builtin/skill-creator を候補にする。作業フォルダーが先に必要なら、先にその選択を求める。';

export function requestedSkill(line: string) {
  return /^使用するSkill「([a-z]+)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})」$/u.exec(line);
}
