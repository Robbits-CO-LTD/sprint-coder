"""トップの「100体の実演」の図を、実演の実行記録から作る。手で書かないこと。

    py -I website/tools/make-hundred.py

- 入力: tools/data/run100.json（実行記録）と tools/data/zukan.json（絵と担当の対応）。
  どちらもプロモ「100人のAIチーム」の制作一式（非公開リポジトリ yusei531642/sprintcoder-promo-100ai、
  commit 22cd317 の video/src/data/）の写し。run100.json はアプリの DB の写しから capture/export_v3.py で作られた。
  絵は同じリポジトリの video/public/zukan/ の写しで、assets/zukan-v1/ に置く（担当のAIが本番で描いた SVG そのもの）。
- index.html のマーカー <!-- h100:hire -->…<!-- /h100:hire -->、h100:run、h100:curve、h100:mosaic の間を書き換える。
- assets/run100-curve-v1.svg（同時に実行中の数の曲線。下層ページの <img> 用、色を焼き込む）を書き出す。

図の決まり（README の honesty rules も参照）
- 100体 = リーダー1（Task 本体の GPT-6.1-Sol。実行記録には入らない）＋ 部長9 ＋ 担当90。
- 「同時に実行中」は実行記録で running だった数（担当が書き終えて、成果の統合を待つ時間を含む）。最大93。
- 時間は早送り。採用の図は送信から最後の採用（256.4秒）まで、稼働の図は最後の実行の完了（1494.7秒）まで。
- 値は data-style の --h（採用）・--s（開始）・--e（完了）・--o（完成の順）に 0..1 で入れ、styles.css が --r と比べて出す。
"""

import json
import pathlib
import re

SITE = pathlib.Path(__file__).resolve().parent.parent
INDEX = SITE / "index.html"
DATA = SITE / "tools" / "data"

run = json.loads((DATA / "run100.json").read_text(encoding="utf-8"))
zukan = json.loads((DATA / "zukan.json").read_text(encoding="utf-8"))

AGENTS = run["agents"]
RUNNING = run["running"]  # 送信からの秒ごとの running の数
SPAN = AGENTS and max(a["endSec"] for a in AGENTS)
HIRE_END = max(a["hiredSec"] for a in AGENTS)
MODEL = {
    "claude-opus-5-5": "Claude Opus 5.5",
    "claude-sonnet-5-5": "Claude Sonnet 5.5",
    "claude-haiku-5-5": "Claude Haiku 5.5",
    "gpt-6-astra": "GPT-6-Astra",
    "gpt-6-luna": "GPT-6-Luna",
    "gpt-5.6-terra": "GPT-5.6-Terra",
    "gemma4:12b": "Gemma 4 12B",
}
VENDOR = {"claude": "Claude", "codex": "Codex", "local": "このパソコン"}

managers = sorted((a for a in AGENTS if a["depth"] == 1), key=lambda a: a["dept"])
DEPTS = [m["role"].removesuffix("部長") for m in managers]
assert len(managers) == 9 and len(AGENTS) == 99


def worker_of(entry):
    """絵の担当を実行記録から探す（同じ部署で、完了の時刻が同じ実行）。"""
    d = DEPTS.index(entry["dept"])
    found = [a for a in AGENTS if a["depth"] == 2 and a["dept"] == d and abs(a["endSec"] - entry["endSec"]) < 0.06]
    assert len(found) == 1, entry["role"]
    return found[0]


for e in zukan:
    e["agent"] = worker_of(e)
assert len({id(e["agent"]) for e in zukan}) == 90


def f(v):
    return f"{v:.4f}".rstrip("0").rstrip(".") or "0"


def series(fn, n=101):
    """--r（0..1）に合わせて数字を出すための値（film.js の data-values）。"""
    return ",".join(str(fn(i / (n - 1))) for i in range(n))


def clock(sec):
    sec = round(sec)
    return f"{sec // 60}:{sec % 60:02d}"


def depts_html(kind):
    """部署ごとの列（部長1＋担当10）。担当は 1〜5 番（Claude）が左、6〜10 番（Codex）が右の列。"""
    out = []
    for d, mg in enumerate(managers):
        rows = sorted((e for e in zukan if e["dept"] == DEPTS[d]), key=lambda e: e["no"])
        if kind == "hire":
            mv = f"--h: {f(mg['hiredSec'] / HIRE_END)}"
        else:
            mv = f"--s: {f(mg['startSec'] / SPAN)}; --e: {f(mg['endSec'] / SPAN)}"
        cells = []
        for e in rows:
            a = e["agent"]
            tip = f"{e['name']}の担当 · {MODEL[a['model']]}"
            if kind == "hire":
                cells.append(f'<i class="{a["vendor"]}" data-style="--h: {f(a["hiredSec"] / HIRE_END)}" title="{tip}"></i>')
            else:
                v = f"--s: {f(a['startSec'] / SPAN)}; --e: {f(a['endSec'] / SPAN)}"
                cells.append(
                    f'<i class="{a["vendor"]}" data-style="{v}" title="{tip}">'
                    f'<img src="/assets/zukan-v1/{e["folder"]}/{e["slug"]}.svg" alt="" width="40" height="40" loading="lazy" decoding="async" /></i>'
                )
        out.append(
            f'<li class="o-dept {mg["vendor"]}" data-style="{mv}"><span class="o-mg" title="{DEPTS[d]}の部長 · {MODEL[mg["model"]]}">{DEPTS[d]}</span>'
            f'<span class="o-cells">{"".join(cells)}</span></li>'
        )
    return "".join(out)


def hire_html():
    team = series(lambda r: 1 + sum(1 for a in AGENTS if a["hiredSec"] <= r * HIRE_END))
    label = (
        f"図：実演の記録から作図。送信から{clock(HIRE_END)}までに、リーダーの下に部長9体、"
        "部長の下に担当90体が雇われた順番。色はAIの種類（Claude・Codex・このパソコンの中のAI）"
    )
    return (
        f'<div class="org100 hire" data-range="0.5,0.8" role="img" aria-label="{label}">'
        '<div class="o-top"><span class="o-lead codex">リーダー <small>GPT-6.1-Sol</small></span>'
        f'<p class="o-hud" aria-hidden="true"><span><small>送信から</small><b data-clock="{round(HIRE_END)}">{clock(HIRE_END)}</b></span>'
        f'<span><small>チーム</small><b data-values="{team}">100</b><em>体</em></span></p></div>'
        f'<ol class="o-depts">{depts_html("hire")}</ol></div>'
    )


def run_html():
    def active(r):
        t = r * SPAN
        return sum(1 for a in AGENTS if a["startSec"] <= t < a["endSec"])

    def done(r):
        t = r * SPAN
        return sum(1 for a in AGENTS if a["endSec"] <= t)

    label = (
        "図：実演の記録から作図。送信から約25分の記録を早送りで見せる。部長と担当の実行中は光り、"
        "担当の実行が終わると、その担当のAIが描いた絵に変わる。99件の実行はすべて完了"
    )
    return (
        f'<div class="org100 run" data-range="0.64,0.94" role="img" aria-label="{label}">'
        '<div class="o-top"><span class="o-lead codex">リーダー <small>GPT-6.1-Sol</small></span>'
        f'<p class="o-hud" aria-hidden="true"><span><small>経過</small><b data-clock="{round(SPAN)}">{clock(SPAN)}</b></span>'
        f'<span class="o-act"><small>実行中</small><b data-values="{series(active)}">0</b><em>体</em></span>'
        f'<span class="o-done"><small>完了</small><b data-values="{series(done)}">99</b><em>件</em></span></p></div>'
        f'<ol class="o-depts">{depts_html("run")}</ol></div>'
    )


# ---- 同時に実行中の曲線
W, H, PAD_L, PAD_B, TOP = 640, 260, 34, 30, 14
PH = H - PAD_B - TOP
PW = W - PAD_L - 8


def pt(t, n):
    return PAD_L + t / SPAN * PW, TOP + PH - n / 100 * PH


def curve_paths():
    pts = [pt(t, RUNNING[t]) for t in range(0, len(RUNNING), 3)] + [pt(len(RUNNING) - 1, RUNNING[-1])]
    line = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts)
    x0, y0 = pt(0, 0)
    x1, _ = pts[-1]
    area = f"{line} L{x1:.1f} {y0:.1f} L{x0:.1f} {y0:.1f} Z"
    return line, area


def curve_svg(inline):
    line, area = curve_paths()
    px, py = pt(run["peakAt"], run["peak"])
    grid = []
    for n in (0, 25, 50, 75, 100):
        y = TOP + PH - n / 100 * PH
        grid.append(f'<line class="c-grid" x1="{PAD_L}" y1="{y:.1f}" x2="{W - 8}" y2="{y:.1f}"/>')
        grid.append(f'<text class="c-tick" x="{PAD_L - 8}" y="{y + 4:.1f}" text-anchor="end">{n}</text>')
    base = TOP + PH
    axis = (
        f'<text class="c-tick" x="{PAD_L}" y="{base + 20}">送信</text>'
        f'<text class="c-tick" x="{W - 8}" y="{base + 20}" text-anchor="end">{clock(SPAN)}</text>'
    )
    peak = (
        f'<g class="c-peak"><line x1="{px:.1f}" y1="{py:.1f}" x2="{px:.1f}" y2="{base}"/>'
        f'<circle cx="{px:.1f}" cy="{py:.1f}" r="5"/>'
        f'<text x="{px + 10:.1f}" y="{py + 4:.1f}">最大{run["peak"]}体 · 送信から{clock(run["peakAt"])}</text></g>'
    )
    label = (
        f"グラフ：同時に実行中だったAIの数を、実演の記録から1秒ごとに数えたもの。送信から{clock(run['peakAt'])}に"
        f"最大の{run['peak']}体、{clock(SPAN)}で全員完了。統合の順番待ちを含む"
    )
    if inline:
        return (
            f'<svg class="curve" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{label}">'
            + "".join(grid)
            + axis
            + f'<path class="c-area" d="{area}"/><path class="c-line" d="{line}"/>'
            + peak
            + "</svg>"
        )
    # 下層ページの <img> 用。CSP（style-src 'self'）の下でも崩れないよう、<style> ではなく属性で色を焼き込む
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
        '<rect width="100%" height="100%" fill="#0a0c0a"/>'
        + "".join(grid)
        + axis
        + f'<path class="c-area" d="{area}"/><path class="c-line" d="{line}"/>'
        + peak
        + "</svg>\n"
    )
    for cls, attrs in (
        ("c-grid", 'stroke="#242a24"'),
        ("c-tick", 'fill="#8a938a" font-family="ui-monospace,Menlo,monospace" font-size="12"'),
        ("c-area", 'fill="#ffb547" fill-opacity="0.18"'),
        ("c-line", 'fill="none" stroke="#ffb547" stroke-width="2.5" stroke-linejoin="round"'),
    ):
        svg = svg.replace(f'class="{cls}"', attrs)
    return (
        svg.replace('<g class="c-peak"><line', '<g><line stroke="#ffb547" stroke-dasharray="3 4"')
        .replace('r="5"/>', 'r="5" fill="#ffb547"/>')
        .replace(f'<text x="{px + 10:.1f}"', f'<text fill="#f3f6ee" font-family="system-ui,sans-serif" font-size="13" font-weight="700" x="{px + 10:.1f}"')
    )


def curve_html():
    peak_series = series(lambda r: max(RUNNING[: max(1, round(r * (len(RUNNING) - 1)) + 1)]))
    return (
        '<div class="meter" data-range="0.1,0.24">'
        f'<p class="bignum"><b data-values="{peak_series}" aria-hidden="true">{run["peak"]}</b><span aria-hidden="true">体</span>'
        f'<span class="visually-hidden">最大{run["peak"]}体</span></p>'
        f'{curve_svg(True)}</div>'
    )


def mosaic_html():
    order = sorted(zukan, key=lambda e: e["endSec"])
    n = len(order)
    items = []
    for i, e in enumerate(order):
        a = e["agent"]
        items.append(
            f'<li data-style="--o: {f(i / (n - 1) * 0.9)}" title="{e["name"]} · {e["dept"]} · {MODEL[a["model"]]}">'
            f'<img src="/assets/zukan-v1/{e["folder"]}/{e["slug"]}.svg" alt="" width="80" height="80" loading="lazy" decoding="async" /></li>'
        )
    count = series(lambda r: sum(1 for i in range(n) if i / (n - 1) * 0.9 <= r))
    return (
        '<div class="mosaic-wrap" data-range="0.12,0.62">'
        f'<p class="mosaic-count" aria-hidden="true"><b data-values="{count}">{n}</b> / {n}枚</p>'
        f'<ol class="mosaic" aria-label="担当のAIが描いた{n}枚の絵。完成した順（アプリの記録の順番）">{"".join(items)}</ol></div>'
    )


def main():
    html = INDEX.read_text(encoding="utf-8")
    for name, body in (("hire", hire_html()), ("run", run_html()), ("curve", curve_html()), ("mosaic", mosaic_html())):
        pat = re.compile(rf"(<!-- h100:{name} -->).*?(<!-- /h100:{name} -->)", re.S)
        html, k = pat.subn(lambda m: m.group(1) + body + m.group(2), html)
        if k != 1:
            raise SystemExit(f"index.html: marker h100:{name} found {k} times (expected 1)")
    INDEX.write_text(html, encoding="utf-8")
    (SITE / "assets" / "run100-curve-v1.svg").write_text(curve_svg(False), encoding="utf-8")
    print(f"index.html: 4 markers updated · peak {run['peak']} at {clock(run['peakAt'])} · span {clock(SPAN)}")


if __name__ == "__main__":
    main()
