# Risks and Rollback

| Risk | Detection | Prevention | Rollback |
|---|---|---|---|
| CoreがProvider対応に引きずられる | Core PRにAdapter／secret変更 | Milestone境界とarchitecture CI | Provider変更をPRから除外 |
| CLI並列が2へ低下 | CLI-only concurrency test | built-in rate admission除外 | Provider Scheduler flag OFF |
| migrationで履歴消失 | DB fixture、row count、audit order | backup、transaction、dual-read | pre-migration backup復元 |
| 新Pickerで既存Chatが壊れる | OFF／ON parity | feature flag、同じrepository | flag OFF |
| OpenRouter catalogでUI停止 | 1000件fixture、DOM count | Main index、paging、virtualization | V2 Picker OFF |
| secret leak | canary scan | Main-only store、logger redaction | Connection disable、log quarantine |
| 1 Connectionがqueue占有 | fairness／starvation test | FIFO＋round-robin＋aging | Scheduler profile rollback |
| 429 retry storm | retry count、deadline test | Retry-After、jitter、既定3回 | Connection pause |
| unknownを低品質扱い | catalog invariant | source付きvalue | catalog revision rollback |
| UI delegationがscope超過 | file／diff count | max files、1000行、3往復 | worktree破棄、再分割 |

## Feature rollback

- Provider Registry、Scheduler、Picker V2は独立flagを持ち、Core CLI pathを残す。
- Picker V2の既定ONと旧Picker削除を同じPRにしない。
- legacy列、compatibility facade、旧Pickerを同時に削除しない。
- Provider Profile失敗をgeneric Runtimeの条件分岐で隠さない。

## Data rollback

- migration前backupを保持
- schema migration失敗時は新DBを使わずbackupへ戻す
- connection ID解決不能でもlegacy snapshotを履歴表示
- rollback後も新ProviderのsecretをRenderer／logへ出さない

## Release stop conditions

- BLOCKER／CRITICALが1件以上
- secret canary検出
- migration fixture破損
- CLI-only並列回帰
- queue starvation
- Provider raw error／payloadのRenderer流出
- U3前の旧Picker削除
