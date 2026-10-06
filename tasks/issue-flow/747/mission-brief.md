# #747 background command監査終端

目的は、Grok実受入で確認したbackground終了後の元managed tool監査の未終端を解消すること。ユーザーの対象repo「Grok関係すべて終わらせて」の既存承認内で、実装・直接検証・必須review/CI・PR/merge/closeoutまで扱う。署名は元依頼で許可済みだが、この局所sliceでは旧署名物を変更しない。

Base `f307f290747e885b91daa4179e6ef9c5e0fe73d4`、7316 sourceと全tree一致。関連open PRなし、対象外#743のみ。#747 OPEN/bug/implementing、attachments_viewed: 0/0 (NO_ATTACHMENTS)、全取得manifest確認済み。

RCA Root Cause Confirmed（A/B/C/D YES）。native command canceled・Turn canceled・9 owned identity GONE・次会話completedと、元tool backgrounded/finished_at nullの限定metadataを照合。Broker dispatchがyield後に終端通知を持たず、default-toolsの単一wait/finalizeがcommand/activityのみを完了する。backgrounded非終端定義と一致。自然終了待ち/実プロセス残存/UIだけのstaleを除外。

計画正本はタスク専用grok-evidence/grok-background-tool-completion-plan.md。Brokerのoriginal closureだけがaudit identity/終端を所有し、Main-local optional completion Promise通知から既存finalize後の実結果を一度だけ記録する。共有domain/IPC/DB schema/catalog/model payload、auth/承認/epoch/native guard、歴史DB補修、新依存/CI/Frameworkは変更しない。

許可変更はapps/desktop/src/mainのtool-broker.ts、default-tools.tsと直接関係する既存test family。別ファイルのMain-local型を既存パターン上必要と判断した場合はrootへ理由を先に示す。completion早着/後着/複数通知/終端済み、explicit/auto background、foreground/非ゼロexit、schema/result order/abort/epoch/finishTurn/terminationUnconfirmedを対象範囲で検証。新native E2Eやwhole suiteを自動追加しない。

JP-19: native証拠+定義で第一仮説を確認、foreground/異常/停止/終了未確認保護を周辺影響に固定、identity所有をBrokerへ維持、局所通知と単一Promiseに限定、直接race/rejectテストで別経路確認。実装前focused独立レビューを1担当で必要全観点確認し、latest diff/CI/指定BOTを省略しない。主担当のsource裏取りは独立レビューと区別する。レビュー起動後は対象が変わらない間に重複レビューを追加しない。

rollbackはこの局所変更の通常revert。migration/旧DB修復不要。永続化失敗を成功へ変換/直SQL/retryしない。ログはsecureLoggerの固定metadataだけ、raw error/output/argv/env/credentialsは含めない。必須review/CI未達ならOPEN/implementingを維持する。
