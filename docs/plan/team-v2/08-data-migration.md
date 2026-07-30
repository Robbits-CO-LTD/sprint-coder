# Data Migration

## Canonical identity

- `builtin:claude-cli`
- `builtin:codex-cli`

実際のmigrationで既存命名との衝突を確認し、変更時はADRへ記録する。test-only mockは
user-facing Provider数へ含めない。

## Core-first columns

CoreでProvider Adapterを追加せず、Chat selection、Agent、execution、attemptへnullableな
connection ID、requested provider/model、resolved provider/modelを先行追加する。Core期間に
作られる新規CLIデータはbuilt-in connection ID付きで保存する。

旧`runtime_kind`と`model`は削除しない。Core migrationとlegacy列削除を同じPRにしない。

## P1A backfill

- Turn historyはlegacy runtime/modelをbuilt-in connectionへ対応付ける。
- Taskの現在selectionは最新Turnを優先し、履歴がなければ既存global settingを使う。
- Agentはagent thread runtime kindからconnection IDを解決し、modelがなければTeam／Task既定を
  requested modelとして保存する。
- 解決不能値は`unknown legacy runtime`として元文字列と共に表示する。
- resolved値をlegacy modelから推測しない。

compatibility facadeが旧`getRuntime/getModel/setRuntime/setModel`と新selection repositoryを
dual-read／dual-writeし、両Pickerを同じ保存データで動かす。

## Migration properties

- transaction
- idempotent
- 外部API／APIキー不要
- 実行前backupとrollback
- 既存履歴を削除しない
- audit orderを変更しない
- Task、conversation、Team参照を維持
- 途中失敗時は元DBを使用可能

## Required fixtures

- 初期versionからlatest
- Team導入前からlatest
- production v34からlatest
- Claude-only
- Codex-only
- mixed Claude／Codex
- running attempt
- interrupted attempt
- unknown legacy model

各fixtureでmigrationを2回実行し、Chat、Team、Agent model、execution、timeline pagination、
restartを検証する。

## Removal

legacy列削除は次の条件を満たす独立cleanup Sliceとする。

- dual-read telemetry／testでlegacy fallbackが不要
- 旧Picker削除条件を満たす
- rollback snapshotがある
- 全migration fixture green
- BLOCKER／CRITICAL 0件
