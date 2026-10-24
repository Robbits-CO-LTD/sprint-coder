# 公式サイト・動画ラベル

共通前提・結果の付け方は[README](README.md)。開発エージェントのComputer Useでブラウザを操作する。旧 `tests/website/site.spec.ts` の9ケースを2構成で実施する18件と、旧 `website/tools/check-hero-label.cjs` の112条件を引き継ぐ。

## 共通前提と測定

- 対象OS: macOS／Windows／Linux上のChromiumまたはChrome。実施OS・ブラウザversionを記録する。mobileはブラウザのmobile/touchエミュレーションであり、実iOS / Androidの受入証拠にはしない。
- source SHAと差分を記録したcheckoutから `node ci-website.mjs serve` でローカルサイトを起動する。既定originは `http://127.0.0.1:4175`。既存の別checkoutのserverは流用せず、portを変えた場合はoriginを記録する。shellでの起動・HTTP照合・ログ採取は補助として使える。
- 新しい隔離ブラウザprofileを用意し、Service Workerを無効化する。ブラウザの設定・開発者ツールをComputer Useで操作してviewportとmedia条件を設定する。desktopは **1280×800 CSS px**、mobileは **375×740 CSS px、mobile=true、touch=true**。実際のviewport値と設定を記録する。window外寸で代用しない。
- 各caseは指定URLへ移動してdocumentのHTTP **200**とload完了、使用fontの読込完了を確認する。HTMLソースが200でもブラウザの実navigationが失敗していればPASSにしない。
- case開始前から終了までブラウザのConsole / Networkを記録する。**未処理JavaScript例外0、HTTP 400以上0、失敗したresource request 0、外部originへの要求0**。resource転送の意図的なnavigation / 動画pauseによる `net::ERR_ABORTED` だけは除外する。他の失敗は除外しない。同一originと `data:` / `blob:` 以外への要求は失敗とし、テスト環境ではその通信を遮断する。監視・遮断を準備できなければ当該保証はBLOCKED。
- aria値、HTML属性、video.paused、font状態、scroll座標、寸法は、利用可能な読み取り専用のアクセシビリティ情報／ブラウザ開発者ツール／補助計測で照合する。画面操作・クリック・スクロール・focusはComputer Useから行い、DOMやiframeへの注入、内部スクリプトによる状態変更で代用しない。
- 元のtimeoutはcase全体30秒、期待値の待機10秒だった。Computer Use呼出しの遅延と製品応答時間を分けて記録し、応答に10秒以上要した箇所は黙って合格にしない。自動retryで失敗を消さない。
- 各IDごとにbuild / OS / browser / viewport / media条件、操作、期待値と実測値、画面、Console / Network記録と補助測定の所在、`PASS` / `FAIL` / `SKIP` / `BLOCKED` を残す。数値、HTTP、例外、ARIAなどの必要証拠を取得できなければ、見た目が正常でもそのcaseはBLOCKED。

## サイトケース（18件）

### 共通のroute受入条件

各route caseは **prefers-reduced-motion: reduce** で開始する。以下を全て確認する。

1. ページtitleに空白以外が1文字以上ある。正確なaccessible nameが「Sprint Coder トップ」のlink、main landmark、level 1 headingが表示される。HTMLの `lang` は正確に `ja`。
2. motion切替control（旧識別子 `[data-motion]`）は非表示。全video要素が **paused=true**。静止画に見えるだけでは動画pauseの証拠にしない。
3. **documentElement.scrollWidth ≤ innerWidth + 1 CSS px**。横にはみ出していないことを画面と測定の両方で確認する。
4. headerのprimary download linkをComputer Useでクリックする。元routeが `/` の場合はURLが **`/#start`** で終わり、`#start` sectionがviewport内にある。それ以外はURLが **`/releases/`** で終わり、level 1 headingが表示される。
5. 移動先を含め、共通のConsole / Network条件を満たす。

### 共通の動画control受入条件

ホームを **prefers-reduced-motion: no-preference** で開く。

1. motion切替controlが表示される。1回クリック後は **aria-pressed=true** かつHTMLのclassに **motion-off** がある。再度クリック後は **aria-pressed=false** かつmotion-off classがない。
2. 「自動で再生」をクリックするとaccessible nameが **一時停止** になり、**scrollY > 5 CSS px** まで自動で進む。「一時停止」をクリックするとaccessible nameが **自動で再生** に戻る。
3. position sliderへキーボードfocusを移す。ArrowRightで **aria-valuenow=1**、Homeで **aria-valuenow=0**。見た目のprogressだけでは数値を代用しない。
4. 最初に表示されている全編動画の起動controlをクリックし、dialogの表示を確認する。正確な名前が **閉じる** のbuttonをクリックするとdialogが非表示になり、**開いたcontrolへfocusが戻る**。
5. 全操作中、共通のConsole / Network条件を満たす。

<a id="site-01"></a>

## site-01

旧ケース: `tests/website/site.spec.ts` — homepage controls play, pause, seek, and close the full-video dialog（desktop）

- 前提: 共通の隔離profile・計測・通信監視、desktop構成（1280×800 CSS px）、reduced motion=no-preference。対象OSはmacOS／Windows／Linux。
- 操作: `/`を開き、motion切替を2回、再生→一時停止、sliderのArrowRight→Home、全編動画を開く→閉じるをComputer Useで実施する。
- 合格条件: 共通の動画control受入条件1〜5を全て満たす。
- 証拠・制約: 切替前後・再生・seek・dialog開閉の画面、pressed / class / label / slider値、scrollY、閉じた後のfocus、Console / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-02"></a>

## site-02

旧ケース: `tests/website/site.spec.ts` — renders / with reduced motion and working download navigation（desktop）

- 前提: 共通の隔離profile・計測・通信監視、desktop構成（1280×800 CSS px）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/#startとstart sectionのviewport内表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-03"></a>

## site-03

旧ケース: `tests/website/site.spec.ts` — renders /about/ with reduced motion and working download navigation（desktop）

- 前提: 共通の隔離profile・計測・通信監視、desktop構成（1280×800 CSS px）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/about/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-04"></a>

## site-04

旧ケース: `tests/website/site.spec.ts` — renders /ai-team/ with reduced motion and working download navigation（desktop）

- 前提: 共通の隔離profile・計測・通信監視、desktop構成（1280×800 CSS px）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/ai-team/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-05"></a>

## site-05

旧ケース: `tests/website/site.spec.ts` — renders /getting-started/ with reduced motion and working download navigation（desktop）

- 前提: 共通の隔離profile・計測・通信監視、desktop構成（1280×800 CSS px）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/getting-started/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-06"></a>

## site-06

旧ケース: `tests/website/site.spec.ts` — renders /local-first-security/ with reduced motion and working download navigation（desktop）

- 前提: 共通の隔離profile・計測・通信監視、desktop構成（1280×800 CSS px）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/local-first-security/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-07"></a>

## site-07

旧ケース: `tests/website/site.spec.ts` — renders /managed-harness/ with reduced motion and working download navigation（desktop）

- 前提: 共通の隔離profile・計測・通信監視、desktop構成（1280×800 CSS px）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/managed-harness/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-08"></a>

## site-08

旧ケース: `tests/website/site.spec.ts` — renders /providers/ with reduced motion and working download navigation（desktop）

- 前提: 共通の隔離profile・計測・通信監視、desktop構成（1280×800 CSS px）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/providers/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-09"></a>

## site-09

旧ケース: `tests/website/site.spec.ts` — renders /releases/ with reduced motion and working download navigation（desktop）

- 前提: 共通の隔離profile・計測・通信監視、desktop構成（1280×800 CSS px）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/releases/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-10"></a>

## site-10

旧ケース: `tests/website/site.spec.ts` — homepage controls play, pause, seek, and close the full-video dialog（mobile）

- 前提: 共通の隔離profile・計測・通信監視、mobile構成（375×740 CSS px、mobile=true、touch=true）、reduced motion=no-preference。対象OSはmacOS／Windows／Linux。
- 操作: `/`を開き、motion切替を2回、再生→一時停止、sliderのArrowRight→Home、全編動画を開く→閉じるをComputer Useで実施する。
- 合格条件: 共通の動画control受入条件1〜5を全て満たす。
- 証拠・制約: 切替前後・再生・seek・dialog開閉の画面、pressed / class / label / slider値、scrollY、閉じた後のfocus、Console / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-11"></a>

## site-11

旧ケース: `tests/website/site.spec.ts` — renders / with reduced motion and working download navigation（mobile）

- 前提: 共通の隔離profile・計測・通信監視、mobile構成（375×740 CSS px、mobile=true、touch=true）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/#startとstart sectionのviewport内表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-12"></a>

## site-12

旧ケース: `tests/website/site.spec.ts` — renders /about/ with reduced motion and working download navigation（mobile）

- 前提: 共通の隔離profile・計測・通信監視、mobile構成（375×740 CSS px、mobile=true、touch=true）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/about/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-13"></a>

## site-13

旧ケース: `tests/website/site.spec.ts` — renders /ai-team/ with reduced motion and working download navigation（mobile）

- 前提: 共通の隔離profile・計測・通信監視、mobile構成（375×740 CSS px、mobile=true、touch=true）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/ai-team/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-14"></a>

## site-14

旧ケース: `tests/website/site.spec.ts` — renders /getting-started/ with reduced motion and working download navigation（mobile）

- 前提: 共通の隔離profile・計測・通信監視、mobile構成（375×740 CSS px、mobile=true、touch=true）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/getting-started/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-15"></a>

## site-15

旧ケース: `tests/website/site.spec.ts` — renders /local-first-security/ with reduced motion and working download navigation（mobile）

- 前提: 共通の隔離profile・計測・通信監視、mobile構成（375×740 CSS px、mobile=true、touch=true）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/local-first-security/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-16"></a>

## site-16

旧ケース: `tests/website/site.spec.ts` — renders /managed-harness/ with reduced motion and working download navigation（mobile）

- 前提: 共通の隔離profile・計測・通信監視、mobile構成（375×740 CSS px、mobile=true、touch=true）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/managed-harness/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-17"></a>

## site-17

旧ケース: `tests/website/site.spec.ts` — renders /providers/ with reduced motion and working download navigation（mobile）

- 前提: 共通の隔離profile・計測・通信監視、mobile構成（375×740 CSS px、mobile=true、touch=true）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/providers/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

<a id="site-18"></a>

## site-18

旧ケース: `tests/website/site.spec.ts` — renders /releases/ with reduced motion and working download navigation（mobile）

- 前提: 共通の隔離profile・計測・通信監視、mobile構成（375×740 CSS px、mobile=true、touch=true）、reduced motion=reduce。対象OSはmacOS／Windows／Linux。
- 操作: `/releases/`へ移動しtitle・トップlink・main・h1・motion control・動画と横幅を確認後、headerのdownload linkをComputer Useでクリックする。
- 合格条件: 共通のroute受入条件1〜5を全て満たす。download後は/releases/とlevel 1 headingの表示。
- 証拠・制約: 初期routeと移動先の画面・URL、lang=ja、全動画のpaused値、scrollWidthとinnerWidth、font完了、HTTP 200とConsole / Network。必要な補助観測が不可ならBLOCKED。

## 序章の録画ラベル（112条件）

旧検査: `website/tools/check-hero-label.cjs` — hero label has no overlap and stays in view

- 対象OS: macOS／Windows／Linux上のChromiumまたはChrome。元検査はdesktop contextのviewport変更であり、幅375等でもmobile/touch emulationは有効にしない。
- 前提: 各行ごとに新しいpage、reduced motion=no-preference、ホーム表示、network idle。序章の登場animationが終わるまで **2400ms以上** 待つ。viewport幅は **320 / 340 / 360 / 375 / 414 / 600 / 900 / 1280**、高さは **480 / 568 / 640 / 667 / 740 / 800 / 900 CSS px**。旧default URLは4174だったが本チェックリストでは共通のローカルoriginでよい。
- 操作: Computer Useでviewportを行の寸法に設定し、序章 `#top` の開始位置と終わり直前へスクロールする。到達すべきYは **scene.offsetTop + max(0, scene.offsetHeight − innerHeight) × p**、pは **0** または **0.98**。読み取り専用の補助測定でtargetと実scrollYが対応したことを確認し、スクロール後 **350ms以上** 待って記録する。JavaScriptのscrollToなどで操作しない。精度の確認ができなければBLOCKED。
- 合格条件（数値）: `.hero-screen .rec` のrectについて **left ≥ 0、right ≤ innerWidth**。さらに `#top .beat` 内の、子要素がなくtrim後textが空でなくcomputed opacityが `0` ではない全要素を対象に、text内容のRange rectのwidthが正の場合、ラベルrectと一切重ならない。接するだけは非重複とし、各text rectとの間で **label.right ≤ text.left または text.right ≤ label.left または label.bottom ≤ text.top または text.bottom ≤ label.top** の少なくとも1つが成立すること。
- 合格条件（画面）: ラベルの文言と序章本文・buttonが読め、重なりや欠けがない。元検査のinViewは左右端だけだったため、縦方向の画面外判定を旧検査の実測済み保証と混同しない。明らかな縦の欠けは別途Findingとして記録する。
- 証拠・制約: 各IDのviewport / p / target Y / 実scrollY / 待機時間、画面、ラベルrect、対象text rectとopacity・leaf/text条件、重複件数 **0**、左右端の測定を保存する。rect / opacity / text条件を観測できない、scroll位置を実測できない場合は **BLOCKED**。目視や静的HTML検査だけを旧px境界検証のPASSにしない。共通のConsole / Network保証も別欄で記録する。

下表は56viewport×2位置を全て列挙したもの。各行が独立したcaseであり、まとめて「代表サイズでPASS」とは報告しない。ラベル文言や序章の配置を変更した場合は全112条件を対象とする。

| ID                                                    | viewport（CSS px） | p    | 前提・操作・合格条件・証拠                     |
| ----------------------------------------------------- | ------------------ | ---- | ---------------------------------------------- |
| <a id="check-hero-label-001"></a>check-hero-label-001 | 320×480            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-002"></a>check-hero-label-002 | 320×480            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-003"></a>check-hero-label-003 | 320×568            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-004"></a>check-hero-label-004 | 320×568            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-005"></a>check-hero-label-005 | 320×640            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-006"></a>check-hero-label-006 | 320×640            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-007"></a>check-hero-label-007 | 320×667            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-008"></a>check-hero-label-008 | 320×667            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-009"></a>check-hero-label-009 | 320×740            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-010"></a>check-hero-label-010 | 320×740            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-011"></a>check-hero-label-011 | 320×800            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-012"></a>check-hero-label-012 | 320×800            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-013"></a>check-hero-label-013 | 320×900            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-014"></a>check-hero-label-014 | 320×900            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-015"></a>check-hero-label-015 | 340×480            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-016"></a>check-hero-label-016 | 340×480            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-017"></a>check-hero-label-017 | 340×568            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-018"></a>check-hero-label-018 | 340×568            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-019"></a>check-hero-label-019 | 340×640            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-020"></a>check-hero-label-020 | 340×640            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-021"></a>check-hero-label-021 | 340×667            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-022"></a>check-hero-label-022 | 340×667            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-023"></a>check-hero-label-023 | 340×740            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-024"></a>check-hero-label-024 | 340×740            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-025"></a>check-hero-label-025 | 340×800            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-026"></a>check-hero-label-026 | 340×800            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-027"></a>check-hero-label-027 | 340×900            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-028"></a>check-hero-label-028 | 340×900            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-029"></a>check-hero-label-029 | 360×480            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-030"></a>check-hero-label-030 | 360×480            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-031"></a>check-hero-label-031 | 360×568            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-032"></a>check-hero-label-032 | 360×568            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-033"></a>check-hero-label-033 | 360×640            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-034"></a>check-hero-label-034 | 360×640            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-035"></a>check-hero-label-035 | 360×667            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-036"></a>check-hero-label-036 | 360×667            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-037"></a>check-hero-label-037 | 360×740            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-038"></a>check-hero-label-038 | 360×740            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-039"></a>check-hero-label-039 | 360×800            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-040"></a>check-hero-label-040 | 360×800            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-041"></a>check-hero-label-041 | 360×900            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-042"></a>check-hero-label-042 | 360×900            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-043"></a>check-hero-label-043 | 375×480            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-044"></a>check-hero-label-044 | 375×480            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-045"></a>check-hero-label-045 | 375×568            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-046"></a>check-hero-label-046 | 375×568            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-047"></a>check-hero-label-047 | 375×640            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-048"></a>check-hero-label-048 | 375×640            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-049"></a>check-hero-label-049 | 375×667            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-050"></a>check-hero-label-050 | 375×667            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-051"></a>check-hero-label-051 | 375×740            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-052"></a>check-hero-label-052 | 375×740            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-053"></a>check-hero-label-053 | 375×800            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-054"></a>check-hero-label-054 | 375×800            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-055"></a>check-hero-label-055 | 375×900            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-056"></a>check-hero-label-056 | 375×900            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-057"></a>check-hero-label-057 | 414×480            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-058"></a>check-hero-label-058 | 414×480            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-059"></a>check-hero-label-059 | 414×568            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-060"></a>check-hero-label-060 | 414×568            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-061"></a>check-hero-label-061 | 414×640            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-062"></a>check-hero-label-062 | 414×640            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-063"></a>check-hero-label-063 | 414×667            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-064"></a>check-hero-label-064 | 414×667            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-065"></a>check-hero-label-065 | 414×740            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-066"></a>check-hero-label-066 | 414×740            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-067"></a>check-hero-label-067 | 414×800            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-068"></a>check-hero-label-068 | 414×800            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-069"></a>check-hero-label-069 | 414×900            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-070"></a>check-hero-label-070 | 414×900            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-071"></a>check-hero-label-071 | 600×480            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-072"></a>check-hero-label-072 | 600×480            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-073"></a>check-hero-label-073 | 600×568            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-074"></a>check-hero-label-074 | 600×568            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-075"></a>check-hero-label-075 | 600×640            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-076"></a>check-hero-label-076 | 600×640            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-077"></a>check-hero-label-077 | 600×667            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-078"></a>check-hero-label-078 | 600×667            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-079"></a>check-hero-label-079 | 600×740            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-080"></a>check-hero-label-080 | 600×740            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-081"></a>check-hero-label-081 | 600×800            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-082"></a>check-hero-label-082 | 600×800            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-083"></a>check-hero-label-083 | 600×900            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-084"></a>check-hero-label-084 | 600×900            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-085"></a>check-hero-label-085 | 900×480            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-086"></a>check-hero-label-086 | 900×480            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-087"></a>check-hero-label-087 | 900×568            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-088"></a>check-hero-label-088 | 900×568            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-089"></a>check-hero-label-089 | 900×640            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-090"></a>check-hero-label-090 | 900×640            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-091"></a>check-hero-label-091 | 900×667            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-092"></a>check-hero-label-092 | 900×667            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-093"></a>check-hero-label-093 | 900×740            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-094"></a>check-hero-label-094 | 900×740            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-095"></a>check-hero-label-095 | 900×800            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-096"></a>check-hero-label-096 | 900×800            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-097"></a>check-hero-label-097 | 900×900            | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-098"></a>check-hero-label-098 | 900×900            | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-099"></a>check-hero-label-099 | 1280×480           | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-100"></a>check-hero-label-100 | 1280×480           | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-101"></a>check-hero-label-101 | 1280×568           | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-102"></a>check-hero-label-102 | 1280×568           | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-103"></a>check-hero-label-103 | 1280×640           | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-104"></a>check-hero-label-104 | 1280×640           | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-105"></a>check-hero-label-105 | 1280×667           | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-106"></a>check-hero-label-106 | 1280×667           | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-107"></a>check-hero-label-107 | 1280×740           | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-108"></a>check-hero-label-108 | 1280×740           | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-109"></a>check-hero-label-109 | 1280×800           | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-110"></a>check-hero-label-110 | 1280×800           | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-111"></a>check-hero-label-111 | 1280×900           | 0    | 上記共通条件をこの寸法・位置で実施し、個別記録 |
| <a id="check-hero-label-112"></a>check-hero-label-112 | 1280×900           | 0.98 | 上記共通条件をこの寸法・位置で実施し、個別記録 |
