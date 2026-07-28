# Provider P0 ADR Backlog

- Status: Proposed
- Slice: Provider P0

P0はコードを変更せず、次の判断をsourceと実測付きでAccepted／Rejected／Supersededへ確定する。

| Topic | Required evidence | Default |
|---|---|---|
| Provider／Connection／Runtime／Model責務 | 現行Runtimeと保存経路 | `03-provider-architecture.md` |
| official APIとCLI | process／auth／usage差分 | 別Runtime kind |
| built-in rate admission | Core 8並列回帰 | API limit除外 |
| Profile Engine | Pack A/B wire conformance | config-first |
| Capability source | API／公式文書の取得可能性 | 3 source model |
| Scheduler統合 | Team queueとProvider headers | two-stage |
| fairness | saturation／starvation simulation | FIFO＋RR＋aging |
| Picker移行 | global state、max32、render cost | catalog client＋flag |
| legacy migration | v34と過去fixture | dual-read |
| Core identity | Coreで生成したDB | ADR-002を確認 |
| dependency direction | TS import graph | Team→interfaces only |

Provider公式仕様はP0実行時の一次資料だけを使用し、URL、version、reviewedAtを記録する。
