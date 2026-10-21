"""サイトで使う文字だけを含む Noto Sans JP（可変・太さ 400〜900）の woff2 を作る。

本番の CSP は font-src 'self' / style-src 'self' のため、外部のフォント配信は使えない。
ページの文言を変えたら作り直すこと（含まれない文字は system の書体で表示される）。

    py -I website/tools/make-font.py [C:/Windows/Fonts/NotoSansJP-VF.ttf]

書体: Noto Sans JP（SIL Open Font License 1.1）。
"""

import pathlib
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

SITE = pathlib.Path(__file__).resolve().parent.parent
SRC = sys.argv[1] if len(sys.argv) > 1 else "C:/Windows/Fonts/NotoSansJP-VF.ttf"
OUT = SITE / "fonts" / "noto-sans-jp-sub.woff2"

# ページの文字＋よく使う記号・英数字・かな（後から少し文言を足しても崩れにくいように）
chars = set()
for p in list(SITE.rglob("*.html")) + [SITE / "styles.css", SITE / "film.js"]:
    text = p.read_text(encoding="utf-8")
    text = re.sub(r"<script type=\"application/ld\+json\">.*?</script>", "", text, flags=re.S)
    chars.update(text)
chars.update(chr(c) for c in range(0x20, 0x7F))
chars.update(chr(c) for c in range(0x3041, 0x3097))  # ひらがな
chars.update(chr(c) for c in range(0x30A1, 0x30FB))  # カタカナ
chars.update("ー・「」『』（）、。！？：；〜…‐―→←↑↓×÷＝＋％＆＃＠／○●◆■□▶▼")
chars = {c for c in chars if not c.isspace() or c == " "}

font = TTFont(SRC)
opts = subset.Options()
opts.flavor = "woff2"
opts.layout_features = ["ccmp", "locl", "kern", "palt", "liga"]  # palt は styles.css で使う
opts.name_IDs = ["*"]
opts.notdef_outline = True
opts.hinting = False
sub = subset.Subsetter(opts)
sub.populate(text="".join(sorted(chars)))
sub.subset(font)
OUT.parent.mkdir(exist_ok=True)
font.flavor = "woff2"
font.save(OUT)
print(f"{len(chars)} chars -> {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")
