# Compatibility Slices C1–C2

## C1 — Profile Engine and Pack A

- Base URL、auth header、catalog、capability override、error mapping
- conformance harness
- Mistral、DeepSeek、GroqCloud
- Provider別config、conformance result、real smoke result

Profileだけで対応できる場合は1つのreview可能なPack PRにまとめる。専用Adapterが必要になっても
C1を拡大せず、将来Sliceへ分離する。

## C2 — Pack B

- Moonshot
- MiniMax
- Zhipu
- NVIDIA NIM
- Cloudflare Workers AI

原則は設定データとconformance testだけを追加する。失敗時はProfile、共通protocol extension、
将来専用Adapter、保留のいずれかをADRで選ぶ。

## Independence

C1／C2はMulti-Provider Initial GAの完成条件に含めない。C2はC1の完成条件にも含めない。
