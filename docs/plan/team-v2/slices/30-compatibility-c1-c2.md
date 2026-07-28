# Compatibility Slices C1–C2

## C1 — Profile Engine and Pack A

- Base URL、auth header、catalog、capability override、error mapping
- conformance harness
- Mistral、DeepSeek、GroqCloud
- Provider別config、conformance result、real smoke result

Profileだけで対応できる場合は1つのreview可能なPack PRにまとめる。専用Adapterが必要になっても
C1を拡大せず、将来Sliceへ分離する。

### C1 progress

- C1a: `ProviderProfile` schema、Profile Registry、generic OpenAI-compatible Runtime、
  Chat Completions SSE conformance parserを完了。ProfileはBase URL、変更可否、auth header、
  protocol、model path、credential要件、error override、公式sourceを宣言する。model APIが
  返したcontext／output上限だけを`provider_api`として採用し、能力は推測せず`unknown`を維持する。
  contracts 29件、conformance 4件、対象lintがgreen
- C1b1: Mistral／DeepSeek／GroqCloudの公式Profile、Profile一覧、generic Connection作成、
  Registry統合を完了。3社は専用Adapterを持たず、同じ`openai_compatible` Runtimeを使用する。
  対象10件、contracts 29件、対象lintがgreen
- C1b2: 設定UIへMain-owned Profile一覧を追加。RendererはPack A IDを持たず、generic create、
  optional Base URL、required Account IDをProfile宣言だけから表示する。Profile一覧の部分失敗、
  stale Profile選択のfail-closed、secret field消去を含むcomponent test 38件と対象lintがgreen。
  実API smokeはfinal gateへ留保する

## C2 — Pack B

- Moonshot
- MiniMax
- Zhipu
- NVIDIA NIM
- Cloudflare Workers AI

原則は設定データとconformance testだけを追加する。失敗時はProfile、共通protocol extension、
将来専用Adapter、保留のいずれかをADRで選ぶ。

### C2 progress

- C2a: Moonshot／MiniMax／Zhipu／NVIDIA NIM／Cloudflare Workers AIのProfile設定を完了。
  Moonshot／MiniMax／NIMは`/models`、Zhipu／Cloudflareは公式curated catalogと1 tokenの
  最小verification probeを使用する。NIMのcustom Base URL、CloudflareのAccount IDもProfile宣言で
  generic UIへ現れる。5社に専用Adapterやgeneric Runtime内のProvider名分岐は追加していない。
  対象52件、contracts 29件、対象lintがgreen
- C2b: Provider別のopt-in実API smoke harnessと保護workflowを追加。required指定時はsecret／model
  不足をfailedとし、verification、catalog、実streaming、resolution、usage、completionを
  Provider別JSON evidenceへ記録する。資格情報を用いたPack B実行と費用記録はfinal gateで行い、
  それまではPack B GAと判定しない

## Independence

C1／C2はMulti-Provider Initial GAの完成条件に含めない。C2はC1の完成条件にも含めない。
