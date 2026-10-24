# Sprint Coder 公式サイト トップ刷新 実装仕様「最大100体のAIを 同時に動かす」

対象: `F:/sc-site/website`（ブランチ `site/hundred-ai` は作成済み。作業 → PR → ReviewBOT → squash merge。main へ直接 push しない）
土台にする案: spectacle（規模で殴る）
接ぎ木する案: proof（序章の比較の札、信頼の札、「実演 REAL」の札）、product（1/6/50/100 の段とバッジ）
直す点: 審査員が挙げた問題（111体に読める、過去形に読める、「100体 始動」、章が長い、群れを5か所に置く、実画面と図を重ねる、「人」が残る）はすべて直す。

---

## 0. 事前に確かめた事実（コード）

- `F:/sprint-coder` のローカル main（b5d27782）は古く、`TEAM_MAX_CONCURRENT_EXECUTIONS = 8` のまま。origin/main と **v0.6.0 タグ**では `TEAM_MAX_CONCURRENT_EXECUTIONS = 100`、`TEAM_DEFAULT_CONCURRENT_EXECUTIONS = 50` になっている（commit cf50df1c、PR #858）。配布中の正式版 0.6.0 に 1〜100 の設定が入っている。
- 設定は2つある。設定 > Team の「アプリ全体で同時に動かせるWorkerの数」（既定50、1〜100）と、Team ポリシーの `maxConcurrentExecutions`（1〜100）。このためサイトでは **「1チームで」とは書かず**、「同時に動かせる上限」と書く。
- 上限を超えた割り当ては、拒否されずに `queued` で待つ（commit の本文と `team-coordinator.test.ts` で確認）。開始のペースは 60秒あたり100件。テストは「上限100の設定で101件を割り当て、100件が完了し、101件目は失敗せずに queued で待つ」ことを確かめている。**訂正（2026-10-24 再確認）**: 101件目が待つ理由は開始のペース（`TEAM_ASSIGNMENT_RATE_LIMIT`）で、同時実行の上限100ではない（テストのコメントにも Team は "may run all at once" とある）。100件が同時に実行中であること（activeCount=100）を確かめるテストはない（同時実行の上限で待つことは 50 と 8 でテスト済み）。そのため「100体が同時に動いて」「確認済み」とは書かない。
- 「雇える数に上限なし」は確かめきれなかった。起動枠（spawnSlots）が満杯のときに雇うと失敗するテストのコメントがあり、予算の設定（bounded）の影響もある。そのため **トップには載せない**。ai-team の詳しい話でも条件付きでしか書かない（§5 を参照）。
- 部長は `hireWorker` で雇われる Worker として数えられる（Manager policy）。リーダーは Worker ではない。そこで図は「リーダー1体 ＋ 部長と担当あわせて100体（部長10・担当90）」にする。これで同時に動く数が111体に読める問題がなくなる。実装時に `team-coordinator.ts` の manager hire の経路で、もう一度確かめる。リーダーも数に入る場合は、§1 の caption を「リーダーを含めて100体」に変え、担当を89体にする。
- ネットのAIは接続ごとに `maxConcurrentRequests` を持ち、提供元の利用制限もかかる。このパソコンの中のAI（managed local runtime）は `maxConcurrentRequests: 1` で動く。この2点は ai-team の詳しい話に書く。

---

## 1. 全体の構成（序章＋8章＋始動。今と同じ10ブロック）

| no | id | data-title | 主役 | --len | data-steps | 実演の札 |
|---|---|---|---|---|---|---|
| 00 | top | 序章 | 100体の群れの弾け（図） | 190vh | なし | — |
| 01 | ch-solo | 一斉 | ひとり vs 一斉（図） | 240vh | 0.12,0.42,0.7 | — |
| 02 | ch-scale | 規模 | 群れが1→100に育つ、1/6/50/100 の段、上限、信頼の札 | 460vh | 0.1,0.4,0.76,0.88 | — |
| 03 | ch-real | 実演 | 「ここまでは図」→「ここから本物」→ 6体 → お願い | 400vh | 0.1,0.3,0.55,0.75 | data-real |
| 04 | ch-team | チーム | 採用 → 組織図 → ネットとこのパソコン → 組み上がり | 420vh | 0.08,0.3,0.5,0.78 | data-real |
| 05 | ch-together | 同時 | 6体の帯グラフ | 400vh | 0.1,0.36,0.56 | data-real |
| 06 | ch-check | 確認 | 作る・確かめる・やり直す | 440vh | 0.06,0.3,0.52,0.74 | data-real |
| 07 | ch-done | 完成 | 36分32秒・9件 | 360vh | 0.08,0.32,0.56 | data-real |
| 08 | ch-safe | 安心 | 4枚のカード | 200vh | 0.12 | — |
| 09 | start（.finale） | 始動 | ダウンロード | — | — | — |

- 削除: 今の `ch-problem`（01 に作り直す）、`ch-mix`（使い分け。04 に統合）。トップでは settings.mp4 を使わない（ファイルは残す）。
- 群れの図の置き場所は、インラインで3か所だけ（00・02・03）。始動と ai-team は静止画の `<img>`（`/assets/swarm-v1*.svg`）にする。
- 数え方は全ページ「体」。見出し・題には「。」を付けない。トップの一行コピー（.lead の一行）にも「。」を付けない。「。」を使ってよいのは、文章の注記（.note・カード本文の複数文）だけ。

---

## 2. 正直さのルール（実装と README に入れる）

**A. 上限の「100」**
- 「最大」「まで」「上限」のどれかと必ず組にする。「100体が動いた」「100体のチームで作った」のような過去形・実績の言い方はしない。「100体 始動」のように、今100体が動き出すと読める言い方もしない。
- 100の図には必ず `.tag-fig`「図 · 映像ではありません」を付ける。置き場所と形は `.rec` と同じにするが、点は灰色で点滅させず、枠は破線にする。03 の 6体の図だけ「図 · 実演で同時に動いた数」にする。
- 100が出る画面には、注記「設定で上限を100にした場合（標準は50）」を同じ画面の中に置く。
- 02 の最後に、信頼の札「上限100体は 試験で確認」を大きく出す（試験用の仮のAI、本物のAIで100体の映像はまだない、と書く。§0 の訂正のとおり、テストで確かめた範囲だけを書く）。
- 実画面の映像と100の図を、同じ画面に重ねない（序章から hero.mp4 を外す）。
- 帯グラフ・数字の段・フル版動画の説明には「100」を混ぜない。

**B. 実演の「6・15件・1回・9件・36分32秒」**
- 出すのは 03〜07 だけ。例外: 上限との対比として「6」だけは、00 の札「実演 6体」・02 の段「6体 実演」・始動の .watch・フル版のモーダル・meta に置いてよい（必ず「実演」と組にする。15・1・9・36分32秒は 03〜07 の外に出さない）。再生バーの札は 03 では拍3（request.mp4）から出す（`data-real-from="3"`）。章タグには `<span class="real-tag">実演 REAL</span>` を付ける。再生バーには「実演 · 2026年10月20日 · 実際のアプリと実際のAI」の札を出す（`data-real` の章にいる間ずっと）。
- 映像の .rec ラベル（等速／早送り ×N／実演の直後に収録）は全部残す。
- 03 では「ここまでは イメージ図」から「ここから 本物」へ切り替え、境目をはっきり見せる。
- 6個の光る点（.lit）は、どの図でも同じ位置に置く。点の位置は数だけを表し、実演でどの役割が動いたかではない（README に書く）。
- 部長10・担当90 という分け方は、図の一例として扱う（caption と aria-label で示す）。

---

## 3. 章ごとの仕様（見える文言はこのとおりに書く）

> **レビュー後の差し替え（2026-10-24）**: 下の文言のうち次は、事実と正直さのルールに合わせて実装で替えた（実装が正）。
> 02 trust の題「上限100体は<br>試験で確認」と本文（§0 の訂正）、count-label「同時に動ける最大の数」、
> 「ひとりは 順番待ち」→「1体は 順番待ち」、「ひとりのAIは」→「1体のAIは」、段の「ひとり」→「単独」、
> 03 の tag-fig「図 · 映像ではありません · 6は実演の数」、凡例「6体 実演で同時に動いた数」、
> 01 の lime の拍・02 beat A・03 拍2 に注記「設定で上限を100にした場合（標準は50）」を追加、
> .definition の末尾に「（AIの利用料は別）」、始動の注記「開発中の版で収録」。
> ai-team: og/twitter の「部長と担当のAIが」、#scale の注記と詳しい話の「上限100の設定は…」（§0 の訂正）、
> 開始のペースは「同時に動かせる上限（最大100体）とは別に、新しく始められる仕事は1分あたり100件まで」。

### 00 序章 `#top`（`.scene.hero`、data-no="00"、data-title="序章"、--len: 190vh）

**stage の中身（上から順）**
1. `.ghost-word`: 「×100」（白抜き文字。今の --p で左へ流れる）
2. `.scanlines`
3. `<div class="flash" aria-hidden="true"></div>`
4. `<span class="tag-fig">図 · 映像ではありません</span>`（`.stage > .tag-fig`。右上で `.stage > .rec` と同じ位置）
5. `<figure class="swarm-wrap side-swarm">`: 群れの SVG（variant `hero`）と `<figcaption class="swarm-cap">リーダー 1 ＋ 部長と担当 最大100</figcaption>`
6. `.beat`（左の列。max-width: min(620px, 52%)）
   - h1（.display.hero-title）:
     ```html
     <h1 class="display hero-title">
       <span class="h-kick">AIを 最大</span>
       <span class="h-num"><b class="count" data-count-intro="100" aria-hidden="true">100</b><span class="visually-hidden">100</span>体</span>
       <span class="h-line">同時に動かす</span>
     </h1>
     ```
     - `.h-kick`: clamp(22px, 3.2vw, 44px)、太さ 900、色 --ink-2
     - `.count`: clamp(140px, 26vw, 360px)、lime、line-height .82、`font-variant-numeric: tabular-nums`、`text-shadow: 0 0 60px var(--lime-glow)`
     - 「体」と `.h-line`: .display の大きさで白
   - `.proof-pair`（proof から。比較の札2枚）:
     ```html
     <div class="proof-pair">
       <a class="pp pp-real" href="/media/promo-720.mp4" data-open-promo><small>実演</small><b>6<span>体</span></b><em>本物の画面で見る 4:02 ▶</em></a>
       <span class="pp-arrow" aria-hidden="true">→</span>
       <div class="pp pp-cap"><small>上限</small><b>100<span>体</span></b><em>設定で上限を100にした場合</em></div>
     </div>
     ```
   - `.definition`: `<b>Sprint Coder</b>＝AIをチームにして 最大100体まで同時に動かせる無料のアプリ`
   - `.hero-actions`: 「自動で再生する」（btn-primary、data-autoplay、href="#ch-solo"）と「無料でダウンロード」（href="#start"）
   - `.note.hero-note`: 「100は同時に動かせる上限です（設定で上限を100にした場合。標準は50）。図はイメージで、実際の画面は03章からです。」
   - `.scroll-cue`: 「スクロールで再生」（640px以下では隠す）
- `.hud` と hero.mp4 の `.hero-screen` は削除する（HUD の情報は proof-pair と caption で伝える。右下で群れと重なる問題もなくなる）。

**配置**
- 961px以上: 群れは `position:absolute; right:max(24px, calc((100vw - 1200px)/2)); top:50%; transform:translateY(-50%); height:min(64svh, 600px); aspect-ratio:600/640`。後ろに `::before` で放射グラデーション（rgba(206,255,82,.16)）を敷き、光のにじみを出す（filter は使わない）。
- 960px以下: 群れは上の中央に置く（top: header+8px、width: min(88vw, 44svh*0.94)、opacity .55）。文字は下に寄せる（今の `align-content:end`）。
- 640px以下: proof-pair は1行で横に2枚（pp b は 28px）、ボタンは btn-sm で横に並べる、note は2行まで。

**最初の5秒（`.js:not(.rm):not(.motion-off)` のときだけ、1回だけ）**
| 時刻 | 動き | 作り方 |
|---|---|---|
| 0.0s | リーダーの点が灯り、輪が1回広がる | `.ld-ring` に keyframes ring 0.6s |
| 0.3s | 部長への線10本が走る | `.wire` の stroke-dashoffset 1→0、0.4s |
| 0.6〜1.6s | 100個の点が波のように出る | `.u` に animation pop .35s、遅れは `calc(.6s + var(--i)*10ms)`、fill-mode both |
| 0.6〜1.6s | カウンターが 000 → 100 | film.js の rAF（easeOutExpo） |
| 1.6s | 画面が80msだけ白く光る（不透明度最大0.12、1回だけ） | `.flash` に keyframes |
| 1.7s | 見出しを叩きつける | 今の slamInHero を `.h-num`、`.h-line` に（遅れ1.7s） |
| 2.2s | proof-pair・説明・ボタン・注記がせり上がる | 今の fadeUp を `.hero-after` 相当のまとまりに（遅れ2.2s） |
| 2.4s〜 | 列ごとの「仕事中」のまたたき | `.is-live` のときだけ（§4） |

- **JSなし・動きを減らす設定・motion-off**: 点は最初から全部見え、カウンターは HTML に書いた「100」のまま。光とまたたきはなし。文言はすべて HTML にある。
- **intro を実行する条件**: film.js の実行時点で `performance.now() < 1500`。これより遅れた場合は数え上げを飛ばし、「100」のまま見せる（100 → 000 と後から飛ぶのを防ぐ）。

### 01 一斉 `#ch-solo`（data-no="01"、data-title="一斉"、--len: 240vh、data-steps="0.12,0.42,0.7"）

- `.colorfield`（lime）は data-show="2"
- `.ghost-word` の中に `<span class="gw-a">ONE</span><span class="gw-b">×100</span>`。拍2以降は `.scene:is([data-step="2"],[data-step="3"]) .gw-a{opacity:0}` で `.gw-b` に入れ替える。
- `.tag-fig`（data-show="0-1"）: 「図 · 映像ではありません」。`.tag-fig.ink`（data-show="2"、lime の上で暗い色）: 同じ文言。
- beat（data-show="0-1"）
  - chapter-tag: `<b>01</b>一斉 AT ONCE`
  - h2.headline#h-solo: 「ひとりは<br>順番待ち」
  - `.queue`（data-range="0.12,0.42"）: lime の点1つと、仕事カード12枚（`<i data-style="--i: 0">`〜`--i: 11`）。カードは `opacity: clamp(0, calc(var(--i) + 1 - var(--r,1)*4), 1)`。その横に「残り <b data-count="8" data-from="12">8</b>件」。拍が進んでも4件しか片付かず、遅さが見える（JSなしでも r=1 で「残り8件」と、つじつまが合う）。
  - .lead.fx-up（data-show="1"）: 「ひとりのAIは ひとつ終えてから次へ」
- beat.on-lime（data-show="2"）
  - chapter-tag（lime-ink の色）: `<b>01</b>一斉 AT ONCE`
  - p.display.fx-slam（data-show="2"）: 「最大100体なら<br>一斉に」
  - `.bars.fx-up`（data-show="3"、data-range="0.7,0.95"、aria-hidden）: 1要素で、帯100本（10×10）が同時に伸びる（CSS は §4）
  - .lead.fx-up（data-show="3"）: 「調べる 作る 確かめる 全部同時に」

### 02 規模 `#ch-scale`（data-no="02"、data-title="規模"、--len: 460vh、data-steps="0.1,0.4,0.76,0.88"）

- `<div class="stage" data-range="0.12,0.72">`。stage 全体に --r を流し、群れ・カウンター・段が同じ値で動く。
- `.stage > .tag-fig`: 「図 · 映像ではありません」
- `.stage > figure.swarm-wrap.side-swarm`: 群れの SVG（variant `fill`、class `swarm fill`）と caption「リーダー 1 ＋ 部長と担当 最大100 · 分け方は一例」
- beat A（data-show="0-2"、左の列）
  - chapter-tag: `<b>02</b>規模 SCALE`
  - h2.headline#h-scale: 「1体から<br><span class="em">最大100体</span>」
  - `<p class="count-big"><b class="count" data-count="100" data-from="1" data-pad="3" aria-hidden="true">100</b><span>体</span><span class="visually-hidden">最大100体</span></p>`、`<p class="count-label">同時に動ける数</p>`
  - `.tiers`（product の段。スクロールだけで動き、手で操作するスライダーは付けない）:
    ```html
    <ol class="tiers" aria-label="同時に動かせる数の目安">
      <li data-style="--at: 0"><b>1<small>体</small></b><span>ひとり</span></li>
      <li class="t-real" data-style="--at: 0.0505"><b>6<small>体</small></b><span>実演</span><em class="badge real">実演 · 映像あり</em></li>
      <li data-style="--at: 0.4949"><b>50<small>体</small></b><span>標準の設定</span></li>
      <li class="t-cap" data-style="--at: 1"><b>100<small>体</small></b><span>最大</span><em class="badge cap">上限 · 映像なし</em></li>
    </ol>
    ```
    --at は (n-1)/99。カウンターの値（from 1 → to 100）がちょうど n になるときに、その段が灯る。
  - .lead.fx-up（data-show="1-1"）: 「リーダーが部長を雇い 部長が担当を雇う」
  - .lead.fx-up（data-show="2-2"）: 「部長と担当 あわせて最大100体が同時に動ける」
- beat B（data-show="3-3"）
  - chapter-tag（同じ）
  - p.headline.fx-slam: 「上限は<br><span class="em">自分で決める</span>」
  - .lead: 「同時に動かす数は 1から100まで 標準は50」
  - `.limit-bar`（aria-hidden。目盛りの図）: 「1」「50 標準」「100 最大」。つまみは100の位置で lime に光り、.on のときに輪（ring）が1回広がる。
  - .note: 「設定で上限を100にした場合」
- beat C（data-show="4"）
  - `.kcard.trust.fx-up`:
    - label: 「確かめ方」
    - p.title: 「100体は<br><span class="em">試験で確認済み</span>」
    - p: 「試験用の仮のAIで101体を雇い、100体が同時に動いて仕事を終え、101体目は順番を待つことを、自動のテストで確かめています。本物のAIで100体を動かした映像は、まだありません。」
    - `.hero-actions`: 「無料でダウンロード」（btn-primary、#start）と「本物の実演を見る 4:02」（btn、data-open-promo、href=/media/promo-720.mp4）← ダウンロードの入口（ヘッダー・序章・ここ・始動の4か所）
- 拍0では r=0 なので、点はリーダーだけが灯り、残りの100個は薄い影（opacity .1）になる。これで「これだけ入る」という枠が見える。range が終わると100個がすべて灯り、stage に `.is-full` が付いて、カウンターが1回脈打つ。

### 03 実演 `#ch-real`（data-no="03"、data-title="実演"、data-real、--len: 400vh、data-steps="0.1,0.3,0.55,0.75"、data-dim="4"）

- `.colorfield.sky`（data-show="1-1"）
- `.footage-layer`（data-show="3"）: request.mp4（今の --fx/--fy/--zoom）。`.stage > .rec`（data-show="3"）: 「実際の画面 <b>等速</b>」
- `.stage > .tag-fig`（data-show="2-2"）: 「図 · 実演で同時に動いた数」
- beat 0（data-show="0-0"）: chapter-tag `<b>03</b>実演 <span class="real-tag">REAL</span>` / p.headline: 「ここまでは<br>イメージ図」
- beat 1.on-sky（data-show="1-1"）: chapter-tag（濃いインク色）/ h2.display.fx-slam#h-real: 「ここから<br>本物」 / .lead: 「2026年10月20日 実際のアプリと実際のAIで収録」
- beat 2（data-show="2-2"、.split）
  - 左: `<p class="bignum fx-slam" data-show="2"><b>6</b><span>体が同時に</span></p>`、.lead: 「本物の実演で 同時に動いた最大の数」、p.title.fx-up: 「100は上限 <span class="em">6は実演</span>」
  - 右: `figure.swarm-wrap.real-fig`（data-show="2"）の中に群れの SVG（variant `real`、class `swarm real`）と、
    ```html
    <ul class="fig-legend"><li class="is-real"><i></i>6体 実演 · 映像あり</li><li><i></i>残り94体 上限まで · 映像なし</li></ul>
    ```
  - 動き: 図が出た瞬間は100個とも灯っていて、0.5秒後に94個が0.6秒かけて輪郭だけに沈み、.lit の6個だけが残る。
- beat 3（data-show="3-3"）: p.headline: 「お願いは<br>ひとつだけ」
- beat 4（data-show="4"）: 今の kcard（label「実際のお願い（要点）」、blockquote は今のまま）。中の p: 「部署の分け方も 使うAIも ふつうの文章で頼める」

### 04 チーム `#ch-team`（data-no="04"、data-title="チーム"、data-real、--len: 420vh、data-steps="0.08,0.3,0.5,0.78"）

- 今の ch-org の構造（`.stage.top-screen` > `.beat.split.rev` > `.screen-stack` と `.copy`）をそのまま使う。
- screen-stack: hires（data-show="0-1"、rec「実際の画面 等速」と「実演の直後に収録」）→ `.org`（data-show="2-3"、data-range="0.3,0.6"、SVG と aria-label は今のまま。「実演で実際に採用された組織とAI（記録から）」も残す）→ assemble（data-show="4"、rec「実際の画面 ▶▶ 早送り ×10」）
- copy:
  - chapter-tag: `<b>04</b>チーム TEAM <span class="real-tag">実演 REAL</span>`
  - h2.headline#h-team: 「AIが<br><span class="em">AIを雇う</span>」
  - .lead.fx-up（data-show="1-1"）: 「リーダーが部長を雇い 部長が担当を雇う」
  - .lead.fx-up（data-show="2-2"）: 「どのAIを なぜ選んだかが 画面に残る」
  - `.mix-mini.fx-up`（data-show="3-3"。ch-mix の統合）:
    `<div class="mix-col cloud"><h3>ネットのAI</h3><div class="chips">GPT-6.1-Sol / GPT-6-Astra / GPT-5.6-Terra / Claude Sonnet 5 / Claude Opus 5.5</div></div>`
    `<div class="mix-col local"><h3>このパソコンの中のAI</h3><div class="chips">Gemma 4 12B</div></div>`（説明文は書かない）。拍3では、組織図の `.where-local` の札を sky の枠で強める（`#ch-team[data-step="3"] .org .where-local{...}`）。
  - .lead.fx-up（data-show="4"）: 「カードが並び 線でつながり 動き出す」

### 05 同時 `#ch-together`（data-no="05"、data-title="同時"、data-real、--len: 400vh、data-steps="0.1,0.36,0.56"、data-dim="1"）

- 映像と rec は今のまま（together.mp4「実際の画面 等速」）。
- beat 0: chapter-tag `<b>05</b>同時 TOGETHER <span class="real-tag">実演 REAL</span>` / p.headline: 「別々のAIが<br><span class="em">同じ時間に</span>」
- beat 1-2: h2.visually-hidden#h-together: 「同時に6体」 / bignum: `<b>6</b><span>体が同時に</span>` / .lead（data-show="2"）: 「記録から1秒ずつ数えた 同時に動いたAIの最大」
- beat 3: gantt は今のまま（見出し「最初の採用から最後の確認まで · 約31分」「AIの仕事 15件」、帯、凡例）。note は1文に縮める: 「実演の記録（アプリに残る開始・終了の時刻）から作図。帯は仕事を受けてから終えるまで。」（「2人が同時に…1人ずつ」「74秒」は ai-team へ移す）

### 06 確認 `#ch-check`（data-real、そのほかは今のまま）

- chapter-tag: `<b>06</b>確認 CHECK <span class="real-tag">実演 REAL</span>`
- 見出しは今のまま「作る 確かめる<br><span class="em">やり直す</span>」
- flow の小さい文字: 作る「作る担当が保存のしかたを直す」/ チェック「別のAIが別の目で確かめる」/ やり直しを頼む「足りないテストをリーダーが1回だけ頼む」/ もう一度確かめる「直した後をあらためて調べる」

### 07 完成 `#ch-done`（data-real、そのほかは今のまま）

- chapter-tag（2か所とも）: `<b>07</b>完成 RESULT <span class="real-tag">実演 REAL</span>`
- beat 0 の長い文は p.headline「最後は<br>リーダーが報告」に替える
- display「完成」、「お願いを送ってから最終報告まで <b>36分32秒</b>」、「テスト <span class="em">9件</span> すべて成功」とチェック9個は今のまま
- stats: 「3部署」開発・セキュリティ・チェック /「6<small>体</small>」同時に動いたAIの最大 /「15件」AIが受け持った仕事（1件は途中で止まり、やり直し）/「1回」やり直しを頼んだ回数。6 の b は `.em`（lime）にして、03・05 の「6」と色をそろえる。
- note は今のまま

### 08 安心 `#ch-safe`（背景は今の haze の hero.jpg のまま）

- chapter-tag `<b>08</b>安心 CONTROL`
- h2: 「何体いても<br><span class="em">決めるのは人</span>」
- カード（h3 と1行）: 01「記録はこのパソコンに」送るのは その仕事に必要な分だけ / 02「大事な操作は先に確認」書き換えや実行は 確かめてから進められる / 03「AIは選べる 混ぜられる」ネットのAIも このパソコンの中のAIも / 04「中身はすべて公開」無料 オープンソース（MITライセンス）· 株式会社Robbits。「→」のリンクは今のまま。

### 09 始動 `#start`（.finale）

- 背景: hero.mp4 の footage-layer をやめ、`<img class="finale-swarm" src="/assets/swarm-v1.svg" alt="" width="600" height="640" loading="lazy">`（opacity .28、右に寄せる）と `.ghost-word`「100」にする。`.tag-fig` 「図 · 映像ではありません」は小さく右上に置く。
- chapter-tag `<b>09</b>始動 GET STARTED`
- h2.display#h-start: 「今すぐ<br><span class="em">始動</span>」
- p.title: 「1体から 最大100体まで」
- .lead: 「無料のデスクトップアプリ 正式版 0.6.0」
- .dl の3つは今のまま
- .note（文章）: 「Windows版は署名がないため、初回に警告が出ることがあります。配布元（GitHub の Robbits-CO-LTD）を確かめてから実行してください。映像は2026年10月20日時点の開発中buildで収録したもので、正式版 0.6.0 とは画面が異なる場合があります。ネットのAIを使うと、その会社の利用料がかかる場合があります。100は同時に動かせる上限で、設定で上限を100にした場合です（標準は50）。変更内容と過去の試作版は<a href="/releases/">リリース案内</a>で確認できます。」
- ボタン3つは今のまま
- `.watch`: 「フル版を見る 4:02」/「本物の実演（6体が同時に動いた回）を1本で。音が出ます。」。thumb の上に `<span class="rec">本物の実演 <b>4:02</b></span>`
- dialog の .modal-bar: 「実際のアプリと実際のAIの実行を収録（同時に動いたのは最大6体）。早送りの場面は画面に倍率を表示しています。」

### head / meta（index.html）

- `<title>Sprint Coder | 最大100体のAIを同時に動かすアプリ</title>`
- description: 「Sprint Coderは、AIをチームにして最大100体まで同時に動かせる無料のデスクトップアプリ。リーダー・部長・担当のAIが手分けして、作って確かめて完成まで届けます。実演は、6体が同時に動いた回を実際の画面と実際のAIで紹介します。」
- og:title / twitter:title: 「Sprint Coder | AIを最大100体 同時に動かす」
- og:description: 「AIを最大100体まで同時に動かせる（100は設定できる上限）。実演では6体が同時に動いた本物の画面を見せます。」。twitter:description: 「AIを最大100体まで同時に。100は上限、実演は6体の本物の画面。」
- og:image は今の実画面のまま（100の図は入れない）
- JSON-LD の SoftwareApplication.description: 「AIをチームにして最大100体まで同時に動かせる、オープンソースのAIコーディング・デスクトップアプリ。」。VideoObject.description の最後に「同時に動いたのは最大6体。」を足す。
- head の inline script の先頭に、次の1行を足す: `try{if(localStorage.getItem('sc-motion')==='off')document.documentElement.classList.add('motion-off')}catch(e){}`（序章の intro が始まる前に止めるため）
- `?v=20261025`: styles.css・film.js・film.js の preload・font の preload（すべてのページ）

---

## 4. 100体の群れの作り方

### 4.1 生成: `website/tools/make-swarm.py`（新規。手では書かない）

- `py -I website/tools/make-swarm.py` で次を行う。
  - index.html のマーカー `<!-- swarm:hero -->…<!-- /swarm:hero -->`、`swarm:fill`、`swarm:real` の間を書き換える
  - `assets/swarm-v1.svg`（全点灯）と `assets/swarm-v1-real.svg`（6点灯＋94輪郭）を書き出す。色は fill/stroke 属性で焼き込み、外部 CSS には頼らない。/assets は immutable なので、変えたら名前の v を上げる。
- 座標: viewBox 0 0 600 640。列 c=0..9 の x = 39 + 58c。
  - リーダー `<circle class="ld" cx="300" cy="28" r="14"/>` と `<circle class="ld-ring" …同じ…/>`
  - 部長（行0）`<circle class="u mg" cx=x cy="110" r="11"/>`
  - 担当（行1..9）`<circle class="u n" cx=x cy=110+56*row r="9"/>`（最後の行は y=614）
  - 線: `<g class="wires">` に path 10本 `M300 42 C300 76 {x} 76 {x} 99`（pathLength="1"）。`<g class="collines">` に path 10本 `M{x} 121 V614`（pathLength="1"）。線は合わせて20本。
  - DOM の順: wires → collines → ld-ring → ld → `<g class="cols">` の中に `<g class="col">` が10個。各 col の子は mg 1個 → n 9個の順（CSS の nth-child で番号を出すため、この順を必ず守る）。
- .lit（6個、全 variant で同じ位置）: (行,列) = (2,1) (4,3) (3,5) (6,6) (5,8) (7,2)。`class="u n lit"`。
- aria:
  - hero・fill: `role="img" aria-label="図：リーダー1体と、部長と担当あわせて100体。同時に動かせる上限を表すイメージで、映像ではありません。部長と担当の分け方は一例です"`
  - real: `aria-label="図：100個の点のうち6個だけが光っている。6個は実演で同時に動いたAIの数、残り94個は上限までの数で、映像はありません"`
- 大きさ: 1枚あたり約6KB、gzip 後は約1KB。

### 4.2 CSS（styles.css に足す。値は data-style ではなく CSS に書く）

```css
.swarm{width:100%;height:auto;overflow:visible}
.swarm .ld,.swarm .ld-ring{fill:var(--lime)} .swarm .ld-ring{fill:none;stroke:var(--lime);opacity:0}
.swarm .mg{fill:var(--sky)} .swarm .n{fill:var(--lime)}
.swarm .lit{stroke:var(--ink);stroke-width:2.5}
.swarm .wire,.swarm .colline{fill:none;stroke:rgba(206,255,82,.28);stroke-width:1.5}
/* 番号（JS に頼らない）: 列10ルール＋行10ルール */
.swarm .col:nth-child(1){--c:0} … .swarm .col:nth-child(10){--c:9}
.swarm .col>.u:nth-child(1){--row:0} … .swarm .col>.u:nth-child(10){--row:9}
.swarm .u{--i:calc(var(--row)*10 + var(--c));transform-box:fill-box;transform-origin:center}
/* 序章の弾け */
.js:not(.rm):not(.motion-off) .hero .swarm .u{animation:pop .35s var(--slam) calc(.6s + var(--i)*10ms) both}
.js:not(.rm):not(.motion-off) .hero .swarm .wire{stroke-dasharray:1;animation:draw .4s var(--ease) .3s both}
.js:not(.rm):not(.motion-off) .hero .swarm .ld-ring{animation:ring .6s var(--ease) both}
/* 02: スクロールで1個ずつ灯る（既定値1を先に書き、古いブラウザでは全点灯） */
.js .swarm.fill .u{opacity:1;opacity:clamp(.1,calc(var(--r,1)*100 - var(--i)),1);transform:scale(clamp(.5,calc(var(--r,1)*100 - var(--i)),1))}
.js .swarm.fill .wire{stroke-dasharray:1;stroke-dashoffset:calc(1 - clamp(0,var(--r,1)*10,1))}
.js .swarm.fill .colline{stroke-dasharray:1;stroke-dashoffset:calc(1 - clamp(0,var(--r,1)*1.111 - .111,1))}
/* 03: 94個が沈む */
.swarm.real .u:not(.lit){transition:fill .6s .5s,stroke .6s .5s,opacity .6s .5s}
.js .real-fig.on .swarm.real .u:not(.lit),html:not(.js) .swarm.real .u:not(.lit),.js.fit-off .swarm.real .u:not(.lit){fill:transparent;stroke:var(--line);stroke-width:1.5;opacity:.6}
/* 仕事中のまたたき: 動かすのは列の g 10個だけ */
.js:not(.motion-off) .scene.is-live .swarm .col{animation:twinkle 2.6s ease-in-out calc(var(--c)*-.26s) infinite}
.js:not(.motion-off) .hero.is-live .swarm .col{animation-delay:calc(2.4s + var(--c)*.12s)}
.motion-off .swarm,.motion-off .swarm *,.motion-off .flash{animation:none!important}
@keyframes pop{from{opacity:0;transform:scale(0)}}
@keyframes draw{from{stroke-dashoffset:1}}
@keyframes ring{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(3)}}
@keyframes twinkle{50%{opacity:.55}}
@keyframes flash{0%,100%{opacity:0}40%{opacity:.12}}
.flash{position:absolute;inset:0;z-index:5;background:#fff;opacity:0;pointer-events:none}
.js:not(.rm):not(.motion-off) .flash{animation:flash .08s linear 1.6s 1 both}
```
- `.tag-fig`: `.rec` と同じ大きさ・位置（`.stage > .tag-fig` は `.stage > .rec` と同じ）。`border:1px dashed rgba(255,255,255,.22)`、`::before` は灰色（--ink-3）の点で、animation なし。`.tag-fig.ink` は lime の上で使う（color --lime-ink、枠 rgba(15,19,9,.35)）。fit-off のときは `.rec` と同じく本文の流れに入れる（既存の `.js.fit-off .stage > .rec` のセレクタに `.tag-fig` を足す）。
- `.bars`（01）:
  ```css
  .bars{height:clamp(120px,22vh,220px);width:min(100%,680px);margin-top:24px;
   background:repeating-linear-gradient(90deg,var(--lime-ink) 0 calc(var(--r,1)*8.4%),rgba(15,19,9,.14) 0 8.4%,transparent 0 10%);
   -webkit-mask:repeating-linear-gradient(180deg,#000 0 6.5%,transparent 0 10%);mask:repeating-linear-gradient(180deg,#000 0 6.5%,transparent 0 10%)}
  ```
- `.tiers li`: `opacity:1;opacity:clamp(.28,calc((var(--r,1) - var(--at,0))*60 + 1),1)`。`.badge` の出方も同じ式にする。`.badge.real` は lime の実線の枠、`.badge.cap` は破線の枠。
- `.count-big .count`: clamp(110px, 18vw, 260px)、lime、tabular-nums。`.is-full .count-big` には pulse 0.5s を1回（motion-off では付けない）。
- `.colorfield.sky{background:var(--sky)}`、`.on-sky{color:#06121c}`（no-JS と fit-off では、今の .on-lime と同じく面を背景色で塗った箱にする）。
- `.real-tag`: chapter-tag の中の小さな枠。lime の文字、細い枠。
- `.player .p-real`: 今の .p-chapter の右に置く札。`.player:not(.is-real) .p-real{display:none}`。全文の span と短い span（「実演 10/20」）の2つを持ち、640px以下では短い方だけ出す。
- `.side-swarm`、`.real-fig`、`.swarm-cap`、`.fig-legend`、`.proof-pair/.pp`、`.queue`、`.limit-bar`、`.kcard.trust`、`.mix-mini`、`.finale-swarm`、`.hero-title` の各部分: 配置は §3 のとおり。960px以下と640px以下の段も書く。
- フォント: `website/tools/make-font.py` の `opts.layout_features` に `"tnum"` を足す（足さないと tabular-nums が効かず、数え上げの間に数字の幅が揺れる）。

### 4.3 film.js に足すもの（約45行。今の仕組みは変えない）

1. model に counts を足す:
   ```js
   counts: all('[data-count]', el).map(function (n) {
     return { el: n, to: +n.dataset.count, from: +(n.dataset.from || 0), pad: +(n.dataset.pad || 0), host: n.closest('[data-range]'), last: null };
   }),
   live: false
   ```
2. sceneUpdate:
   - m.visible を計算した直後: `if (m.visible !== m.live) { m.live = m.visible; m.el.classList.toggle('is-live', m.visible); }`
   - ranges のループ: `var rv = clamp(...); r.el.style.setProperty('--r', rv.toFixed(4)); r.el._r = rv; r.el.classList.toggle('is-full', rv >= 1);`
   - その後で counts を更新する: `var r = c.host && c.host._r !== undefined ? c.host._r : 1; var v = Math.round(c.from + (c.to - c.from) * r); if (v !== c.last) { c.last = v; c.el.textContent = c.pad ? String(v).padStart(c.pad, '0') : String(v); }`
3. 序章の数え上げ（film の早期 return より後に置くので、reduce と fallback では動かない）:
   ```js
   var intro = document.querySelector('[data-count-intro]');
   if (intro && !userStop && performance.now() < 1500) {
     var goal = +intro.dataset.countIntro;
     intro.textContent = '000';
     requestAnimationFrame(function tick(ts) {
       var k = clamp((ts - 700) / 1000, 0, 1), v = k >= 1 ? goal : Math.round(goal * (1 - Math.pow(2, -10 * k)));
       intro.textContent = String(v).padStart(3, '0');
       if (k < 1) requestAnimationFrame(tick);
     });
   }
   ```
4. updatePlayer の `cur !== lastCur` の中: `player.classList.toggle('is-real', m.el.hasAttribute('data-real'));`
5. ファイル冒頭のコメントに、data-count / data-from / data-pad / data-count-intro / is-live / is-full / data-real の説明を足す。
- 性能: 毎フレーム計算するのは、02 の群れ100点の CSS だけ。またたきは g 10個だけで、画面の外では is-live を外して止める。filter と box-shadow は点に付けない。スマホの実機で引っかかる場合の逃げ道（README に書く）: 02 の data-range をやめ、10段の data-steps と、行ごとのクラス（`[data-step="n"] .col>.u:nth-child(-n+k)`）で点灯させる。

---

## 5. ai-team/index.html の変更

1. lead: 「AIを横に並べるだけではありません。リーダーのAIがお願いを受け取り、部長と担当のAIへ分け、最大100体まで同時に動かして、結果をひとつの仕事へ戻します。」
2. カード02: h3「リーダーが人を集める」→「リーダーがAIを集める」。本文の最後に「同時に動くのは最大100体まで。」を足す。
3. POINTS の直後に `<section class="section" id="scale" aria-labelledby="h-scale">` を入れる。
   - eyebrow「SCALE」、h2.headline「同時に<br><span class="em">最大100体</span>」
   - .reel: 左に `<div class="fig"><img src="/assets/swarm-v1-real.svg" alt="図：100個の点のうち6個だけが光っている。6個は実演で同時に動いた数、残り94個は上限までの数" width="600" height="640" loading="lazy"><span class="tag-fig">図 · 映像ではありません</span></div>` と fig-legend。右に stats 4つ: 「100<small>体</small>」同時に動かせる上限 /「50<small>体</small>」標準の設定 /「1〜100」自分で選べる /「6<small>体</small>」実演で同時に動いた最大（実際のAI）
   - note: 「100体が同時に動くことは、試験用の仮のAIを使った自動のテストで確かめています（101体を雇い、100体が同時に動いて仕事を終え、101体目は順番を待つことを確認）。本物のAIで100体を動かした実演はまだありません。このページの映像と数字は、すべて同時に最大6体が動いた実演のものです。設定で上限を100にした場合（標準は50）。」
4. reel の title「何人ものAIが同時に動く」→「実演では 6体が同時に」。lead「順番待ちではなく、いくつもの担当が同じ時間に手を動かす。この映像は実演で、同時に動いたのは最大6体。」
5. 数字の段: 「6<small>人</small>」→「6<small>体</small>」
6. 詳しい話に h2「同時に動く数の上限」を足す（技術の言葉はここだけ）:
   - 「Workerの同時実行数は、設定 > Team の『アプリ全体で同時に動かせるWorkerの数』（既定50、1〜100）と、TeamごとのPolicy `maxConcurrentExecutions`（1〜100）で決まります。Managerも雇われたWorkerとして数え、Leaderは含みません。」（Manager と Leader の扱いは §0 で再確認してから書く）
   - 「上限を超えた割り当ては拒否されず、枠が空くまで queued で待ちます。開始のペースは60秒あたり100件です。」
   - 「100並行は、mock runtime を使った unit test で検証しています（101体のWorkerを採用し、100体が完了、101体目は待機）。実際のproviderで100体を同時に動かす検証はまだで、2026-10-20 の実演での同時実行のピークは6です。」
   - 「ネットのAIは、接続ごとの同時リクエスト数の設定と、提供元の rate limit・利用料の影響を受けます。このパソコンの中のAIは、パソコンの性能に左右されます。実演では、このパソコンの中のAIの2体が同時に仕事を受け、中では1体ずつ順番に処理しました。ネットのAIとこのパソコンの中のAIが同時に動いた時間は合計74秒です。」
   - 採用数の上限には触れない。触れる場合は、コードで確かめた条件（予算・起動枠）を必ず添える。
7. 「このページの映像と数字」の「6人」→「6体」。最後に「100は上限の値で、映像は同時に最大6体の実演のものです。」を足す。
8. og:description / twitter:description に「最大100体まで同時に」を足す。JSON-LD の description も同じ。dateModified は 2026-10-25。?v は 20261025。
9. 最後の CTA「最初の仕事を、チームで」はそのまま。
10. ほかのページ: grep で数え方の「人」を探したところ、該当は ai-team の2か所とトップだけ（about の「人が」、managed-harness の「人が決める」は人間の意味なので変えない）。about・providers・getting-started・local-first-security・managed-harness・releases は ?v の更新だけ。

---

## 6. ファイルごとの作業

| ファイル | 変更 |
|---|---|
| website/index.html | §3 のとおり全面的に組み替える。swarm マーカー3つ、meta、head の script |
| website/styles.css | §4.2 の追加。.hero-screen と .hero .hud のトップ専用の規則のうち使わなくなったものは消す（下層の page-hero の .rec の規則は残す）。@font-face の ?v=20261025 |
| website/film.js | §4.3 |
| website/tools/make-swarm.py | 新規 |
| website/tools/make-font.py | layout_features に "tnum" を足す |
| website/assets/swarm-v1.svg, swarm-v1-real.svg | 新規（生成） |
| website/fonts/noto-sans-jp-sub.woff2 | `py -I website/tools/make-font.py` で作り直す（新しい字: 斉・規・模・限・試・験・桁・仮・図・始・済・雇・枠 など） |
| website/ai-team/index.html | §5 |
| website/{about,providers,getting-started,local-first-security,managed-harness,releases}/index.html | styles.css・film.js・font preload の ?v=20261025 |
| website/README.md | 「How the homepage works」を新しい章の構成にする。data-count / data-count-intro / is-live / is-full / data-real と再生バーの札、make-swarm.py、.tag-fig の決まり、honesty rules の続き（§2 の A・B を全部）、性能の逃げ道を書き足す |
| tasks/todo.md | CLAUDE.md のとおり、計画のチェックリストとレビューの節を書く |

---

## 7. 受け入れチェック

- [ ] `grep -n 'style="' website -r` と `<style` が0件（CSP）。要素ごとの値は data-style だけ
- [ ] すべてのページで styles.css・film.js・フォントの ?v が 20261025 にそろっている
- [ ] フォントの漏れがない: fontTools で woff2 の cmap を読み、全 HTML の文字が入っていることをスクリプトで確かめる（漏れ0件）。tnum が入り、数え上げ中に数字の幅が揺れない
- [ ] 正直さの grep: 「100体が動」「100体で作」「100体 始動」「1チームで」が0件。数え方の「人」（6人・何人・2人・1人ずつ）が0件。100の図（00・01・02・03・始動・ai-team）のすぐそばに必ず .tag-fig がある。100が出る画面に「設定で上限を100にした場合」がある
- [ ] 03〜07 の章タグに「実演 REAL」があり、再生バーに実演の札が出る（00〜02・08 では出ない）
- [ ] JSなし: すべての文言が読め、点は全部見え、カウンターは100、03 の図は6点灯・94輪郭、段は全部灯っている
- [ ] prefers-reduced-motion: 章が縦に並び、点は静止、数え上げなし、光なし、動画はポスターだけ
- [ ] 「動きを止める」: 読み込み時に設定が off なら intro が始まらない。押せばまたたきと動画が止まる
- [ ] fit-off（高さ560px以下、文字の拡大200%）: 02 の群れと段、03 の図と凡例が縦に並び、すべて見える
- [ ] 序章の5秒の拍（§3 の表）が出る。光は1回だけ
- [ ] 02 で、カウンター6のときに「6体 実演 · 映像あり」が灯り、50で標準、100で「上限 · 映像なし」が灯って脈打つ。点の数とカウンターがだいたい合う
- [ ] 03 で、図が出て0.5秒後に94個が沈む。request.mp4 は拍3からで、図と同じ画面に重ならない
- [ ] 再生バーの章の目印が9つ（00〜08）、aria-valuetext が新しい章名、自動再生が最後まで進む
- [ ] スマホの性能: 375×812 のスロットリングで、02 のスクロール中に長いタスクがない（DevTools Performance）。画面外の章は is-live が外れている
- [ ] README のとおり Computer Use で56の画面サイズ × 序章の開始と終了の位置を確かめる。tag-fig・proof-pair・note・ボタンが重ならず、画面からはみ出さない。PASS / FAIL / SKIP / BLOCKED を記録する。Computer Use が使えなければ BLOCKED と報告する（静的なビルドは画面の証拠にならない）
- [ ] ローカルで確認: `python3 -m http.server 4174 --directory website` で、全ページの console にエラーがない
- [ ] PR を作り、ReviewBOT の指摘を直して承認を得てから squash merge する

---

## 8. 残るリスク

- 序章から実画面を外したので、最初は図の印象が強い。proof-pair の「実演 6体 · 本物の画面で見る 4:02」と、03 の「ここまでは イメージ図 / ここから本物」で補っている。それでも弱く感じる場合は、依頼主の判断で序章の下端に実画面のサムネイルを足す（群れの図には重ねない）。
- 本物のAIでの100並行は未検証。provider の制限・利用料・パソコンの性能によっては、実際には100体に届かない。そのため 02 の信頼の札と、始動・ai-team の注記は削れない。
- og:title の「最大100体」と、og:image（実画面）の組み合わせは、og:description の「100は設定できる上限 実演は6体」で補っている。群れの図で OG 画像を作る場合は、新しいファイル名にする。
- プロモ動画（4:02）のナレーションや字幕が「人」で数えている場合、サイトの「体」とずれる。確かめて、ずれていれば watch の説明に1行足す。
- Manager と Leader を上限の数に入れるかどうかは、実装前にコードで再確認する（§0）。結果によって、caption と ai-team の文を変える。
- ローカルの `F:/sprint-coder` main は古い（上限8のまま）。事実は origin/main と v0.6.0 で確かめること。

## 追記（2026-10-24 代替レビュー後）

- 02 の信頼の札の題を「上限100体は 試験で確認」から「101件目は 順番を待つ」に変えた（上限100そのものを試験したように読めるため）。本文に「100件が同時に動くこと自体は、まだ試験していません」を足した。
- APIキーで使う接続は1接続あたり同時2件が標準（画面からは下げることしかできない）。Codex・Claude Code 経由のAIはこの制限を受けない。序章の注記・02 の札・/ai-team/ に書いた。
