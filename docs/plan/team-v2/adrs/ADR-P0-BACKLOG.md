# Provider P0 ADR Backlog

- Status: Accepted
- Slice: Provider P0

P0はコードを変更せず、次の判断をsourceと実測付きで確定した。

| Topic | Evidence | Decision |
|---|---|---|
| Provider／Connection／Runtime／Model責務 | 現行Runtimeと保存経路 | [ADR-003](ADR-003-provider-domain-boundaries.md) |
| official APIとCLI | process／auth／usage差分 | [ADR-003](ADR-003-provider-domain-boundaries.md) |
| built-in rate admission | Core 8並列 | [ADR-004](ADR-004-two-stage-admission-fairness.md) |
| Profile Engine | official wire docs | [ADR-006](ADR-006-profiles-verification-secrets.md) |
| Capability source | discovery APIとcuration差 | [ADR-005](ADR-005-capability-catalog-picker.md) |
| Scheduler統合／fairness | durable queueとProvider limits | [ADR-004](ADR-004-two-stage-admission-fairness.md) |
| Picker移行 | global state、max32、render cost | [ADR-005](ADR-005-capability-catalog-picker.md) |
| legacy migration | v35列追加と既存row | [ADR-007](ADR-007-legacy-identity-migration.md) |
| Core identity | Coreで生成したDB | [ADR-007](ADR-007-legacy-identity-migration.md) |
| dependency direction | Main／Runtime Host境界 | [ADR-003](ADR-003-provider-domain-boundaries.md) |

Provider公式仕様はP0実行時の一次資料だけを使用し、URL、version、reviewedAtを記録する。
