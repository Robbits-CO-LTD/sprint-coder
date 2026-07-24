# ADR: Custom DOM world for the Team Canvas (React Flow not adopted)

- Status: Accepted
- Date: 2026-07-24
- Scope: Phase 6 Slice 6.1–6.4 Team Canvas

## Context

実装計画のSlice 6.1はReact Flow viewportを第一候補とし、設計書§spike 3は「React Flow custom node内で720px ChatSurface、nested scroll、keyboard、10 nodeの性能」を検証対象、性能不足時のfallbackを「custom DOM world + spatial index」と定義していた。Phase 6着手時点で、視覚正本 `demo/index.html` のTeam mode(カメラのFLIP的シード、ドット格子とbackground-position同期、SVGケーブル、spawn演出)はref直接変異による自前カメラで既に忠実に再現・検証済みだった。

## Decision

React Flowを導入せず、設計書が定義するfallback構成(custom DOM world)をTeam Canvasの正式実装として採用する。カメラは `useCamera`(ref + 直接style変異、React再レンダリングなしの60fps pan/zoom)、ノードはworld座標のabsolute配置、ケーブルはworld内SVG、LODはカメラscale閾値の `data-lod` 属性、位置・視点は `canvas_views`(migration v29、revision付き楽観ロック)で永続化する。

## Rationale

- モックのカメラ演出(morph時のシード→セトル、背景格子の追従、ケーブルのworld座標同期)はReact Flowのviewportモデルに載せ替えるとFLIP連続性の制御点が失われ、忠実度が下がる。
- ノード数は設計上限が小さく(Leader 1 + Worker 3、将来10)、spatial indexやvirtualizationを要する規模ではないため、React Flowの主要な利点が効かない。
- 依存を増やさず、SurfaceLayer(単一ChatSurface instance常駐)とanchor再親付けによるmount count維持がプレーンなDOM操作で成立している。

## Consequences

- selection・keyboard navigation・fit/focus・drag・位置永続化はReact Flow相当を自前で維持する(Slice 6.1で実装済み)。将来ノード種類や数が拡大しReact Flow導入が再検討される場合、`canvas_views` のデータモデルとCameraDirectorのownership modelはそのまま移植可能な境界として設計してある。
- 性能はNFR-PERF-03(pan/zoom fps)の実測でゲートする。spatial indexは現行規模では未実装であり、ノード数上限を引き上げる際の必須検討事項として残る。
