"""トップの「100体の群れ」の図（SVG）を作る。手で書かないこと。

    py -I website/tools/make-swarm.py

- index.html のマーカー <!-- swarm:hero -->…<!-- /swarm:hero -->、swarm:fill、swarm:real の間を
  インラインの SVG に書き換える（色と動きは styles.css の .swarm で付ける）。
- assets/swarm-v1.svg（全点灯）と assets/swarm-v1-real.svg（6点灯＋94輪郭）を書き出す。
  こちらは <img> で使うため、色を fill / stroke 属性で焼き込み、外部の CSS に頼らない。
  /assets は immutable で配信するので、絵を変えたらファイル名の v を上げること。

図の決まり（README の honesty rules も参照）
- リーダー1体（数に入れない）＋ 部長10・担当90 = 100体。部長と担当の分け方は図の一例。
- .lit の6個は、どの図でも同じ位置。点の位置は数だけを表し、実演でどの役割が動いたかではない。
- DOM の順は wires → collines → ld-ring → ld → cols（col が10個、各 col は mg 1個 → n 9個）。
  styles.css の nth-child で列と行の番号（--c / --row）を出すため、この順を必ず守る。
"""

import pathlib
import re

SITE = pathlib.Path(__file__).resolve().parent.parent
INDEX = SITE / "index.html"
ASSETS = SITE / "assets"

COLS = [39 + 58 * c for c in range(10)]
LEADER = (300, 28, 14)
LIT = {(2, 1), (4, 3), (3, 5), (6, 6), (5, 8), (7, 2)}  # (行, 列)

LABEL_ALL = (
    "図：リーダー1体と、部長と担当あわせて100体。同時に動かせる上限を表すイメージで、"
    "映像ではありません。部長と担当の分け方は一例です"
)
LABEL_REAL = (
    "図：100個の点のうち6個だけが光っている。6個は実演で同時に動いたAIの数、"
    "残り94個は上限までの数で、映像ではありません"
)

# 静止画（<img>）に焼き込む色。styles.css の :root と同じ値
LIME = "#ceff52"
SKY = "#7cc4ff"
INK = "#f3f6ee"
WIRE = "rgba(206,255,82,.28)"
DIM = "#8a938a"


def row_y(row: int) -> int:
    return 110 + 56 * row


def body(baked: str | None) -> str:
    """図の中身。baked=None はインライン（CSS で塗る）、'all' / 'real' は静止画用に色を焼き込む。
    静止画の色は親の <g> に付けて子へ継ぎ、違う点だけ上書きする（ファイルを小さく保つ）。"""
    still = baked is not None
    line = f' fill="none" stroke="{WIRE}" stroke-width="1.5"' if still else ""
    if baked == "real":
        cols = f' fill="none" stroke="{DIM}" stroke-width="1.5" stroke-opacity=".5"'
        mg = ""
        lit = f' fill="{LIME}" stroke="{INK}" stroke-width="2.5" stroke-opacity="1"'
    elif baked == "all":
        cols = f' fill="{LIME}"'
        mg = f' fill="{SKY}"'
        lit = f' stroke="{INK}" stroke-width="2.5"'
    else:
        cols = mg = lit = ""

    out = [f'<g class="wires"{line}>']
    for x in COLS:
        out.append(f'<path class="wire" pathLength="1" d="M300 42 C300 76 {x} 76 {x} 99"/>')
    out.append(f'</g><g class="collines"{line}>')
    for x in COLS:
        out.append(f'<path class="colline" pathLength="1" d="M{x} 121 V614"/>')
    out.append("</g>")
    lx, ly, lr = LEADER
    if not still:
        out.append(f'<circle class="ld-ring" cx="{lx}" cy="{ly}" r="{lr}"/>')
    out.append(f'<circle class="ld" cx="{lx}" cy="{ly}" r="{lr}"' + (f' fill="{LIME}"' if still else "") + "/>")
    out.append(f'<g class="cols"{cols}>')
    for c, x in enumerate(COLS):
        out.append('<g class="col">')
        out.append(f'<circle class="u mg" cx="{x}" cy="{row_y(0)}" r="11"{mg}/>')
        for row in range(1, 10):
            on = (row, c) in LIT
            cls = "u n lit" if on else "u n"
            out.append(f'<circle class="{cls}" cx="{x}" cy="{row_y(row)}" r="9"{lit if on else ""}/>')
        out.append("</g>")
    out.append("</g>")
    return "".join(out)

def inline(variant: str) -> str:
    cls = {"hero": "swarm", "fill": "swarm fill", "real": "swarm real"}[variant]
    label = LABEL_REAL if variant == "real" else LABEL_ALL
    return (
        f'<svg class="{cls}" viewBox="0 0 600 640" width="600" height="640" role="img" '
        f'aria-label="{label}">{body(None)}</svg>'
    )


def standalone(baked: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 640" width="600" height="640">'
        f"{body(baked)}</svg>\n"
    )


def main() -> None:
    html = INDEX.read_text(encoding="utf-8")
    for variant in ("hero", "fill", "real"):
        pat = re.compile(rf"(<!-- swarm:{variant} -->).*?(<!-- /swarm:{variant} -->)", re.S)
        html, n = pat.subn(lambda m: m.group(1) + inline(variant) + m.group(2), html)
        if n != 1:
            raise SystemExit(f"index.html: marker swarm:{variant} found {n} times (expected 1)")
    INDEX.write_text(html, encoding="utf-8", newline="\n")
    for name, baked in (("swarm-v1.svg", "all"), ("swarm-v1-real.svg", "real")):
        path = ASSETS / name
        path.write_text(standalone(baked), encoding="utf-8", newline="\n")
        print(f"{path.name}: {path.stat().st_size / 1024:.1f} KB")
    print("index.html: 3 swarm markers updated")


if __name__ == "__main__":
    main()
