"""トップの「100体の実演」の映像素材を、本番の収録から作り直す。どの収録の何秒・どこを使ったかの正本。

    py -I website/tools/make-media-100.py <rec のフォルダ> [ffmpeg]

<rec のフォルダ> には、プロモ「100人のAIチーム」の制作一式（非公開リポジトリ yusei531642/sprintcoder-promo-100ai）の
Release v1 に添付した本番の収録 run.mp4 / settings.mp4 / final.mp4（3840x2160・実時間どおりの 30fps）と、
納品動画 sprintcoder_100ai_team_152s_1080p_web.mp4 を置く。収録は 2026-10-23 に、開発中のアプリの窓の中身だけを
Chrome DevTools Protocol の画面配信で記録したもの（他の窓や通知は写っていない）。
run.mp4 は送信の 8.6 秒前から始まる（送信からの秒 = 収録の秒 − 8.6）。

出力: media/c100-<name>.mp4（無音・H.264・1600px 幅・CRF 27、make-media.ps1 と同じ設定）と .jpg（最初のコマ）、
      media/promo100.mp4（フル版 2:32。v1 の Web 用＝合成の BGM つき。faststart にしただけで再エンコードしない）、
      media/promo100.jpg（フル版の 97 秒目のコマ）、assets/sprint-coder-og-100.jpg（同じコマから 1200x630）。

区間と寄りの位置は、プロモの src/recs.ts（実画面の区間の正本）に合わせた。寄りは素材の画素での中心 (cx, cy) と
倍率 s（1 = 幅いっぱい）で、切り取る範囲が画面の外に出るときは内側へずらす。
2026-10-27 の作成では、手元の ffmpeg（Remotion 同梱）に crop フィルタが無かったため、同じ範囲を Pillow で切り取って
同じ設定でエンコードした。crop のある ffmpeg なら、このスクリプトで同じ範囲になる。
"""

import pathlib
import subprocess
import sys

SITE = pathlib.Path(__file__).resolve().parent.parent
MEDIA = SITE / "media"

# name, 収録, 開始秒, 長さ(秒), cx, cy, s, 何が映っているか
CLIPS = [
    ("cards", "run", 799.0, 6.0, 1920, 1080, 1.0, "送信から約13分。アプリのカメラが寄った、カードが画面いっぱいに並ぶ区間（序章の背景）"),
    ("request", "run", 2.0, 7.0, 2183, 1960, 2.3, "お願いの入力と送信"),
    ("hire", "run", 112.5, 5.0, 1920, 1760, 2.5, "送信から約2分。リーダーと部長が次々に雇う（採用の通知が流れる）"),
    ("limit", "settings", 3.0, 4.6, 2050, 1000, 2.0, "本番の前の設定: 新しいTeamの既定値（同時に動かせるWorkerの数 100・使う量の上限なし）"),
    ("guide", "settings", 22.0, 8.0, 2170, 1170, 2.2, "本番の前の設定: AIを選ぶときの指示を入れる"),
    ("wall", "run", 811.0, 5.6, 1920, 1080, 1.0, "送信から約13分のカードの壁（この時点で実行中は44体）"),
    ("dive", "run", 443.3, 5.0, 1500, 1080, 1.25, "送信から約7分。担当のカードの寄り（実行中は76体）"),
    ("local", "run", 524.0, 1.8, 2200, 1700, 1.9, "送信から約8分半。宇宙飛行士の担当（このパソコンの中のAI）のカード"),
    ("final", "final", 12.0, 7.0, 2180, 1480, 2.0, "本番の直後に開いたリーダーの最終報告"),
]
SW, SH = 3840, 2160


def crop_box(cx, cy, s):
    w = round(SW / s / 2) * 2
    h = round(SH / s / 2) * 2
    x = min(max(0, round(cx - w / 2)), SW - w)
    y = min(max(0, round(cy - h / 2)), SH - h)
    return w, h, x, y


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    rec = pathlib.Path(sys.argv[1])
    ff = sys.argv[2] if len(sys.argv) > 2 else "ffmpeg"
    for name, src, ss, dur, cx, cy, s, _ in CLIPS:
        w, h, x, y = crop_box(cx, cy, s)
        out = MEDIA / f"c100-{name}.mp4"
        vf = f"crop={w}:{h}:{x}:{y},scale=1600:-2:flags=lanczos"
        subprocess.run(
            [ff, "-v", "error", "-y", "-ss", str(ss), "-t", str(dur), "-i", str(rec / f"{src}.mp4"), "-an", "-vf", vf,
             "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", "-profile:v", "high",
             "-movflags", "+faststart", str(out)],
            check=True,
        )
        # ポスターは再生が始まるコマと同じ（読み込み後に絵が飛ばないように）
        subprocess.run([ff, "-v", "error", "-y", "-i", str(out), "-frames:v", "1", "-q:v", "4", str(out.with_suffix(".jpg"))], check=True)
        print(f"c100-{name:<8} {out.stat().st_size // 1024:>6} KB  crop {w}x{h}+{x}+{y}")

    full = rec / "sprintcoder_100ai_team_152s_1080p_web.mp4"
    subprocess.run([ff, "-v", "error", "-y", "-i", str(full), "-c", "copy", "-movflags", "+faststart", str(MEDIA / "promo100.mp4")], check=True)
    if (MEDIA / "promo100.mp4").stat().st_size >= 24 * 1024 * 1024:
        raise SystemExit("promo100.mp4 が 24MiB を超えた（公開の上限は 25MiB）")
    subprocess.run([ff, "-v", "error", "-y", "-ss", "97", "-i", str(full), "-frames:v", "1", "-vf", "scale=1600:-2", "-q:v", "4", str(MEDIA / "promo100.jpg")], check=True)
    og = SITE / "assets" / "sprint-coder-og-100.jpg"
    subprocess.run([ff, "-v", "error", "-y", "-ss", "97", "-i", str(full), "-frames:v", "1", "-vf", "scale=1200:675,crop=1200:630:0:22", "-q:v", "3", str(og)], check=True)


if __name__ == "__main__":
    main()
