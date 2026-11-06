# Projectフォルダの再起動後の誤判定

## 原因と範囲

2026-10-25、macOSの実フォルダ `/Users/yusei/sprint-coder` のinodeは19956708で不変だった。
保存済みroot digestはdev=16777232、現在のdigestはdev=16777234で完全に再現できた。
`workspaceMutationBinding` は `SHA256(['workspace-root-v2', dev, ino, 'directory'])` を
永続化し、Turn開始時にも同じ式を使う。このため起動間でのデバイス番号変更を
フォルダ差し替えと誤判定する。`app.isPackaged` による分岐はなく配布版も対象。

## 修正の境界

- APFSでnativeの開いたdirectory descriptorからvolume UUID・inode・birthtimeを取得し、
  別の永続識別digestとしてProject root登録に保存する（migration 106）。
- dev/inoを含む既存の実行時seal、workspace mutation key、native sessionは変更しない。
- 起動時のrecovery後、保存済みの永続識別情報が一致するrootだけを既存の
  `replaceProjectFolders` 経路で更新する。ID・参照ファイルを維持し、policy/context epochを更新する。
- 履歴Turn・grant・recovery journalのsealは書き換えない。
- 作業中、未回収lease、quarantine、識別不能、別path、別volume、別inode、別birthtimeは
  自動更新しない。multi-rootは一括で判定する。
- 健全な旧登録は起動時に証拠を追加する。証拠がまだない旧登録がすでにstaleな場合は、
  一度だけ明示的な再リンクが必要。pathだけで自動承認しない。
- APFS以外では従来のfail-closed動作を維持する。

Apple仕様: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/getattrlist.2
`ATTR_VOL_UUID` はfilesystem UUID。local SDKとAPFS上のfgetattrlistで実取得を確認。

## 検証

- DBを閉じて再openし、デバイス番号のみ変化した旧登録を自動更新する回帰テスト。
- 実APFS native witnessと、旧dev番号で生成したruntime sealを使う結合テスト。
  更新前の参照status=workspace_changed、更新後status=healthy。
- root ID維持、旧Turn snapshot不変、legacy登録の健全時enrollment、stale時拒否、
  永続識別不一致・取得不能・作業中・multi-rootの取得失敗の拒否。
- nativeでのdev/ino不一致拒否、symlink拒否、同pathのdirectory差し替え検出。
- macOS自体の再起動・Windows/Linux実機での挙動は、この作業の検証とは区別する。

## ローカルでの適用結果

2026-10-25、origin/mainからの隔離worktreeで検証し、同じ修正だけを既存開発checkoutにも反映した。
両checkoutで対象typecheckとProject persistence/native identityテストを通過。
隔離worktreeではSQLite persistence全体、path guard、reference reader、directory rules、lint、formatも通過。
既存profileを使って開発版を正常終了・native再build・再起動し、手動再リンクなしで既存rootへの
persistent identityの追加と、同じCodexモデルの応答完了をComputer UseとDBで確認。
配布版の公開と実OS再起動の受入れは未実施。
