# Accessibility Audit — Team MVP gate (Phase 7)

- Date: 2026-07-24
- Scope: blocking subset item「keyboard-only golden path、Canvasと同等のList View、contrast、reduced motion」+ §10.3
- 対象OS: macOS (この監査環境)。Windows/NVDAは未実施(下記Limitations)。

## 1. 機械検証済み (automated evidence)

| 項目 | 証跡 (test) | 内容 |
|---|---|---|
| Keyboard-only golden path | `tests/e2e/a11y-keyboard-golden-path.spec.ts` | Task作成→送信→応答→Team昇格→Leaderへ依頼(チームテストシナリオ)→Canvasキーボード操作(矢印/Tab選択・Enter・Esc・f/l)→List表示切替→Chat復帰までキーボードのみで完走。activeElementがbodyに落ちないこと、Tabトラップがないことをアサート |
| axe監査 (serious/critical 0) | `tests/e2e/a11y-axe.spec.ts` | 実アプリにaxe-coreを注入し、chat / team canvas / list view / approval表示状態でserious・critical違反0を検証 |
| コントラスト (WCAG AA) | `apps/desktop/src/renderer/lib/contrast.ts` + `contrast.test.ts` (29 cases) | index.cssのデザイントークン実値から本文/セカンダリ/アクセント/状態色×背景の全used pairを計算しAA(4.5:1 / UI 3:1)を検証 |
| Reduced motion | `tests/e2e/a11y-reduced-motion.spec.ts` + `team-cables.spec.ts`(既存) | `prefers-reduced-motion: reduce`下で: Team突入シード飛行なし・スポーンがフェードのみ・morph出口が即時・ケーブルは静的ハイライト+テキストイベント代替 |
| 200% zoom | `tests/e2e/a11y-zoom.spec.ts` | zoomFactor 2.0でchat/list両ビューに水平スクロールなし、Composer・戻る等の操作可能性を検証(このために.team-list-viewの狭幅オーバーレイ化+ヘッダwrapを実装) |
| List View情報同等性 | `tests/e2e/a11y-list-view-parity.spec.ts` | Leader主導チーム完了状態で、List表示がCanvasと同一の情報集合(role/objective/state/activity/usage/timeline/state chip)を持つことをDOMテキストで機械diff |
| フォーカスリング常時可視 | `index.css :focus-visible`(NFR-A11Y-02) + golden path spec中の目視相当アサート | 全インタラクティブ要素に2pxリング |

## 2. aria-live インベントリ

| 場所 | 属性 | 発火内容 |
|---|---|---|
| ChatSurface | `aria-live="polite"` (visually-hidden) | Run stage遷移のアナウンス(streaming本文はverbatim送出しない: NFR-A11Y-03) |
| TeamCanvas | `aria-live="polite"` (visually-hidden) | Team状態・Worker数・キーボード選択のアナウンス |
| TeamCanvas `team-cable-announcer` | `aria-live="polite"` | 雇用「Leaderが 調査 を雇用しました」/ 配送・報告イベント(全モーションモードでミラー) |
| TeamListView | `aria-live="polite"` (visually-hidden) | List表示でのTeam状態アナウンス |

## 3. スクリーンリーダー手動テスト台本 (VoiceOver / macOS)

自動化不能のため、リリース前に以下を人手で1回実施する:

1. VO起動(Cmd+F5)→ アプリ起動 → VO+右矢印でサイドバー「新しいTask」到達・実行。
2. Composerへフォーカス移動 → ラベル「メッセージを送信…」が読まれること → 適当な文を入力し送信 → Run Cardのstage遷移がpoliteに読み上げられること(本文の逐語読み上げが起きないこと)。
3. 「Team」ボタン実行 → Canvas突入がアナウンスされること → Leader Composerから「チームテスト:…」送信 → 「Leaderが 調査 を雇用しました」等の雇用・報告アナウンスが順に聞こえること。
4. 矢印キーでWorker選択 → 選択が読み上げられる → Enterで停止ボタンへ → Escで戻る。
5. 「List表示」実行 → 見出し・Worker一覧・タイムラインをVO+右矢印で順に走査し、Canvasで得た情報と同等の内容が線形に読めること。
6. 「Chatに戻る」実行 → Composerへフォーカスが復帰すること。

## 4. Limitations / open items

- NVDA(Windows)は対象OS未所持のため未実施。Phase 8 beta gateの対象OS実機E2Eに含めること。
- VoiceOver台本はスクリプト化のみ(本監査時点で人手実施は未完)。リリース前チェックリストに残す。
- axeはコンポーネント単位(jsdom)ではなくlive-app注入方式を採用(レンダラにDOMテスト基盤を追加しないため)。カバーする状態は4画面に限定。
