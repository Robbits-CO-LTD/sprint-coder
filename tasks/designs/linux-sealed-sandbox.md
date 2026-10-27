# Linux sandboxでの封印済み実行ファイル

承認済みの可変実行ファイルはMainがsealed memfdとして保持する。sandbox外では`/proc/<Main pid>/fd/<fd>`を使用するが、bubblewrapのPID名前空間から親PIDは見えない。このためsandbox内には、封印済みバイト列の読み取り専用コピーを渡す。

## 境界

- `PreparedExecutionImage.linuxSealedSources`は、Mainが作った実行ファイルと単一shebang interpreterのmemfdだけを保持する。最大2件。通常の利用者引数からコピー元を推測しない。
- `CommandRunner`はLinuxのsandbox実行時だけ、生成したlaunch path・最後のscript引数・Nodeの既知pin環境変数を固定mount先へ変換する。shebangのその他の引数と承認された`spec.argv`は変えない。
- helperの追加形式は`--exec workspace-write ROOT --protected-home HOME --sealed-images JSON -- EXECUTABLE ARGS...`。旧形式も受理する。追加形式はLinux限定。
- helperは名前空間を分ける前にsourceを開き、その同じFDで4種のsealを確認してからregular fileと512MiB上限を確認する。負のseal結果、未封印ファイル、異常なproc path、過大な一覧は拒否する。mutableな元ファイルへのfallbackはない。
- bubblewrapの専用`/dev`を作った後、`/dev/sprint-coder-execution`をprivate tmpfsとし、`--ro-bind-data`で`image-0`・`image-1`へ配置する。各画像とディレクトリを読み取り専用にする。追加FDはbubblewrapへの受け渡しまで所有し、失敗時は解放する。
- PID・network名前空間、readonly root、workspace内だけの書込み、protected-home mask、seccomp、Landlock、停止・子孫終了・Mainの元image cleanupは維持する。

## Nodeとスクリプト

data-backed mountから実行したNodeは`process.execPath`に`(deleted)`を付ける場合がある。既存の固定preloadとpin環境をinterpreterから継承し、sandbox内の安定したmount先へ変換する。子Nodeも承認済みバイト列を実行する。

## 回帰検証

`prepared-execution-image.test.ts`は生成パスと通常引数の区別を確認する。Linuxの`command-runner.test.ts`は元の実行ファイル・interpreter・scriptをspawn直前に置換しても承認済み本文と子Nodeだけが動くこと、mountのreadonly属性・書換え拒否・source FD非漏出を確認する。`linux-sealed-sandbox.test.ts`は実helperへ不正JSON、通常ファイル、未封印・部分封印memfd、FIFO、上限超過などを渡して拒否を確認する。

helperの実検証前には`build-sandbox-runner.mjs`で実行先とdigestを更新する。`cargo build`だけでは`build/Release`の実行先は更新されない。rollbackはMainの変換とhelper拡張を一緒に戻す。その場合、元のLinux PID名前空間内でのmemfd起動失敗が再発する。
