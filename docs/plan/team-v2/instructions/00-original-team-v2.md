# Original Team v2 request

- Source: current Codex task, first Team request
- Recorded: 2026-07-28
- Status: superseded where later instructions or ADRs conflict
- Referenced image: `/Users/yusei/Desktop/スクリーンショット 2026-07-28 16.21.49.png`

## Verbatim request

team機能は完璧と言える？
team機能の完璧の定義を言っておくね
chatからteam(5人で 3人でなど)でユーザーがteamで作業をして欲しい場合に自動でteamを展開してworkerを呼び出す機能です
そしてteamでleaderはworkerを呼び出す際にどのモデルにするのか使用できるモデルの中から特徴を汲み取ってその作業内容に合ったモデルをそのworkerに割り当てる
そしてleaderはworkerがスコープを広げすぎていたり、おかしいところを実装していたり、ダメなところがある時にはその作業しているときにリアルタイムで、そこはこうするよって指摘できるようにして
そして、worker同士で通信もできるようにして
あと、会社のようにleader=社長 で社長から部長に作業を任せるそして部長はそこからmcp等でどんどんworkerを呼んで作業をやらせる、そして作業をしたら部長が社長に報告する
そして、chatでなんだけどmcpがあると思うんだけどteamで雇った時には~~を雇いましたのように表示して欲しい履歴のようにね(画像を参考に)
そしてteamは完璧に使用できるようにしてほしい
なので君がcomputeruseでテストして絶対に動くという確証を持ってください
テストでAIを使用することを許可します(お金をかかることを許可します)
そんな感じで実装していって欲しいんだよね
