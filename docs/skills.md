# Sprint Coder Skills

Sprint CoderはSkillを管理コピーへ取り込み、内容のdigestをTurnごとに固定して実行します。
元のClaude Code／Codex Skillは変更しません。

## 互換レベル

- **Portable**: Codex、Claude Code、API Providerで同じ指示として利用できます。
- **Codex Native**: `agents/openai.yaml`をCodexで利用し、他RuntimeではPortable部分を使います。
- **Claude Native**: Claude Code固有のinvocation機能を利用します。完全隔離を確認できないため、import時にambient Skill発見の注意を確認する必要があります。

Runtimeで意味を保持できないfield、`!command`、未対応の参照は無視されません。Settingsで
「変換が必要」と表示され、AIでPortable版を作成して内容を確認するまで実行できません。

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
再度previewと確認が必要です。

作成済みSkillは元形式、またはPortable Exportとして書き出せます。Exportには管理manifest、
ローカル絶対パス、無効化・自動発火marker、認証情報を含めません。
