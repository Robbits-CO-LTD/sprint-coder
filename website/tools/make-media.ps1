# Sprint Coder 公式サイトの映像素材を、プロモ v2 の実画面録画から作り直す。
# どの録画の何秒を使ったかの正本。素材はすべて 2026-10-20 に最新版アプリを
# CDP の画面配信で収録したもの（説明: F:\work\scp2\説明\実演の確認記録.md）。
#
#   pwsh -File website/tools/make-media.ps1 [-Rec F:\work\scp2\public\rec] [-Deliver F:\work\scp2\deliver]
#
# 出力: website/media/<name>.mp4（無音・H.264・1600px 幅）と <name>.jpg（ポスター）、
#       promo-720.mp4 / promo-1080.webm（フル版 4:02、各 25MiB 未満）、bgm.m4a。
param(
  [string]$Rec = 'F:\work\scp2\public\rec',
  [string]$Deliver = 'F:\work\scp2\deliver',
  [string]$Audio = 'F:\work\scp2\public\audio\bgm.wav'
)
$ErrorActionPreference = 'Stop'
$Out = Join-Path $PSScriptRoot '..\media'
New-Item -ItemType Directory -Force $Out | Out-Null

# name, 録画, 開始秒, 使う長さ(秒・録画の時間), 速さ(1 = 等速), 下端を切る割合（任意）
# 下端を切るのは、アプリの通知（「Runtime Hostから無効なイベント」）が出る帯を外すため。中身は元の録画のまま
$Clips = @(
  @('hero',      'v2_runB',      722, 32, 4),   # 全員のカードを引きで見渡して寄る（早送り ×4）
  @('setup',     'v2_setup',     0.3, 12, 1),   # 最初の設定
  @('request',   'v2_runA',      8,   8,  1),   # 依頼を入力して送信
  @('hires',     'v2_hires',     0.5, 9,  1, 0.06),   # リーダーが部長 3 人を採用（実演の直後に記録を開いて収録）
  @('assemble',  'v2_runA',      85,  90, 10),  # 部長と担当がそろっていく（早送り ×10）
  @('together',  'v2_runB',      903, 8,  1),   # やり直しの間も別々のAIが同時に作業
  @('settings',  'v2_settings2', 2.4, 10, 1),   # 部署ごとのAIの選び方を書く設定
  @('answers',   'v2_answers',   0.5, 10, 1, 0.21),  # この録画は窓が撮影範囲より短く、通知が上にある   # このPCのAIが考えたテストの案（実演の直後）
  @('code',      'v2_runB',      225, 8,  1),   # 作る担当がコードを直す
  @('review',    'v2_runB',      762, 8,  1),   # チェック役のAIが確認
  @('redo',      'v2_runB',      1524, 6, 1),   # 1 回だけやり直し
  @('recheck',   'v2_answers',   33.3, 10, 1, 0.21),  # 弱点をもう一度さがす（実演の直後）
  @('final',     'v2_final',     0,   14, 1, 0.06)    # リーダーの最終報告（実演の直後）
)

foreach ($c in $Clips) {
  $name, $src, $ss, $dur, $speed, $cut = $c
  $in = Join-Path $Rec "$src.mp4"
  $mp4 = Join-Path $Out "$name.mp4"
  $jpg = Join-Path $Out "$name.jpg"
  $crop = if ($cut) { "crop=iw:ih*$(1 - $cut):0:0," } else { '' }
  $vf = "$($crop)setpts=PTS/$speed,fps=30,scale=1600:-2:flags=lanczos"
  ffmpeg -v error -y -ss $ss -t $dur -i $in -an -vf $vf -c:v libx264 -preset slow -crf 27 `
    -pix_fmt yuv420p -profile:v high -movflags +faststart $mp4
  # ポスターは再生が始まるコマと同じ（読み込み後に絵が飛ばないように）
  ffmpeg -v error -y -i $mp4 -frames:v 1 -q:v 4 $jpg
  Write-Host ("{0,-10} {1,7:N0} KB" -f $name, ((Get-Item $mp4).Length / 1KB))
}

# フル版（4:02）: Cloudflare Pages の 1 ファイル 25MiB 上限に収める
$full = Get-ChildItem $Deliver -Filter '*_1080p_web.mp4' | Select-Object -First 1
ffmpeg -v error -y -i $full.FullName -vf 'scale=1280:-2:flags=lanczos' -c:v libx264 -preset slow `
  -b:v 560k -maxrate 900k -bufsize 1800k -c:a aac -b:a 96k -movflags +faststart (Join-Path $Out 'promo-720.mp4')
# 2 パス・上限つき（25MiB を超えないように）。作った後に大きさを確かめる
$webm = Join-Path $Out 'promo-1080.webm'
$log = Join-Path ([IO.Path]::GetTempPath()) 'promo-vp9'
$vp9 = @('-c:v', 'libvpx-vp9', '-b:v', '560k', '-maxrate', '800k', '-bufsize', '1600k', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-passlogfile', $log)
ffmpeg -v error -y -i $full.FullName @vp9 -pass 1 -an -f null NUL
ffmpeg -v error -y -i $full.FullName @vp9 -pass 2 -c:a libopus -b:a 96k $webm
foreach ($f in @($webm, (Join-Path $Out 'promo-720.mp4'))) {
  if ((Get-Item $f).Length -ge 24MB) { throw "$f が 24MiB を超えた（Cloudflare Pages の上限は 25MiB）" }
}
$poster = Get-ChildItem $Deliver -Filter '*_poster.jpg' | Select-Object -First 1
ffmpeg -v error -y -i $poster.FullName -vf 'scale=1600:-2' -q:v 4 (Join-Path $Out 'promo.jpg')

# BGM（プロモ用に合成したもの・外部素材なし）。先頭 64 秒
ffmpeg -v error -y -t 64 -i $Audio -af 'afade=t=in:d=1.5,afade=t=out:st=61:d=3' -c:a aac -b:a 96k (Join-Path $Out 'bgm.m4a')

Get-ChildItem $Out | ForEach-Object { '{0,-20} {1,8:N0} KB' -f $_.Name, ($_.Length / 1KB) }
