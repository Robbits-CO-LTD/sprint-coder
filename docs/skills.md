# Sprint Coder Skills

タスクでモデルを選び、入力欄に `$` または `/` を入力し、候補からSkillを選びます。選んだSkillは本文中で青い `$Skill名` になります。また、行頭や空白の後に `&review` のように `&` と利用可能なSkillの正確なIDを入力すると、候補を選ばずに青い `$review` に変換されます。`review-pr` など同じ先頭の長いIDもあるときは、短い方のIDに続けてスペースを入力して確定します。同じIDのSkillが複数の出所にあるときは `$` の候補から選びます。同じ操作でChat Skillを最大5件、Team Skillを最大1件指定できます。名前を本文から削除すると、その送信から外れます。Sprint Coderの内蔵・作成済みSkillとCLI用Skillを同時に選択できます。CLI用Skillは手動選択したものだけを、そのターン用のリビジョンに固定して渡します。

| 選択したモデルの接続 | 探索するCLI用Skill                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code          | プロジェクトの各フォルダーの `.claude/skills`、次にユーザーの `~/.claude/skills`（`CLAUDE_CONFIG_DIR` 指定時はその配下）                                         |
| Codex CLI            | プロジェクトの各フォルダーの `.agents/skills` と `.codex/skills`、次にユーザーの `~/.agents/skills` と `~/.codex/skills`（後者は `CODEX_HOME` 指定時はその配下） |

各ディレクトリの `<Skill ID>/SKILL.md` を読みます。同じCLI内で同じIDが複数ある場合は表の探索順で最初の候補を使います。選択後に内容が変わった場合は選び直してください。CLIを切り替えると利用可能なSkillも変わります。設定画面ではSprint Coderが管理するSkillを編集できます。

## 互換レベル

- **Portable**: Codex、Claude Code、API Providerで同じ指示として利用できます。
- **Codex Native**: `agents/openai.yaml`をCodexで利用し、他RuntimeではPortable部分を使います。
- **Claude Native**: Sprint Coderで作成したSkillのClaude Code固有invocation機能を利用します。

Runtimeで意味を保持できないfield、`!command`、未対応の参照は無視されません。Skill Creatorで
Portable版を作成して内容を確認するまで実行できません。

## 発火と権限

手動選択は送信1回だけ有効です。Settingsで「自動選択 ON」にしたSkillだけが、次のTurnから
AIの候補になります。候補はTurn開始時にdigest固定され、最大32件です。候補として表示された
だけでは「使用済み」にならず、`skill_activate`が成功した場合だけ履歴に発火が記録されます。

`allowed-tools`はSprint Coderの権限を増やしません。利用可能なTool、workspace、承認、shellは
常にそのTurnのManaged HarnessとAccess設定が上限です。Claude Nativeでも内蔵Toolや
`!command`からこの境界を迂回できません。

## 作成、更新、Export

`SKILL.md`には`name`と`description`が必要です。Open Agent Skillsの標準metadataと、任意の
`scripts/`、`references/`、`assets/`を同梱できます。更新で互換性や権限要求が変わった場合は
再度内容の確認が必要です。

### フルアクセスのチャットでGitHubから取り込む

GitHub CLI（`gh`）で対象リポジトリを読める端末では、フルアクセスのタスクに次のように送信すると、Sprint Coderが実装用のChat Skillを1件選んで登録します。

```text
https://github.com/OWNER/REPO このリポジトリから実装系skillを入れて
```

「実装系」のように用途で頼むと、Sprint Coderが候補の `SKILL.md` を読み、関連する候補の名前と説明を選択中のモデルに渡して比較し、選定理由をチャットに表示します。同じチャットで「他の実装系のskillを入れて」と頼むと、直近で指定したリポジトリから登録済みの候補を除いて選びます。

名前で指定する場合は「このリポジトリから frontend-design スキルを入れて」とURLを一緒に送信します。Sprint Coderが同じコミットからSkillフォルダーの全ファイルを取得し、原本との一致を確認します。チャットに取得元のリンクが出ます。非公開リポジトリにはアクセス権のあるアカウントでの `gh` ログインが必要です。

対象は原文のUTF-8ファイルで利用できるChat Skillです。既存の同名Skillの内容が異なる場合や、変換が必要な場合は理由を表示して停止します。

### Skill Draftを作成する

`skill_draft_create`は、インストール前の確認用Draftを作ります。入力には次の3項目が必要です。

```json
{
  "kind": "chat",
  "skillId": "review-helper",
  "files": [
    {
      "path": "SKILL.md",
      "content": "---\nname: Review Helper\ndescription: Review code safely.\n---\n"
    }
  ]
}
```

- `kind`: `chat`または`team`
- `skillId`: 英数字で始まる128文字以内のID
- `files`: `path`と`content`を持つ1件以上の配列

Team Skillでは、`files`へ`team/blueprint.json`を必ず含めてください。Blueprintには
`version`、`kind`、`policy`、`leaderInstructions`、1件以上の`roles`が必要です。

作成に成功すると、応答へDraft ID、Skill ID、種類、ファイル一覧が入ります。Draft IDを
確認できない場合は未作成です。不正なBlueprintでは、エラーが`roles[0].parentKey`のように
修正対象を示します。

作成済みSkillは元形式、またはPortable Exportとして書き出せます。Exportには管理manifest、
ローカル絶対パス、無効化・自動発火marker、認証情報を含めません。
