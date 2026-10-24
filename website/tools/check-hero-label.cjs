// 序章の録画ラベル（.hero-screen .rec）が本文の文字やボタンに重ならず、画面内に収まるかを測る。
// ラベルの文言や序章の配置を変えたら実行すること（56 サイズ × 序章の始め・終わり）。
//
//   python3 -m http.server 4174 --directory website   # 別のターミナルで
//   node website/tools/check-hero-label.cjs [http://127.0.0.1:4174/]
//
// 文言を今の倍ほどに長くすると、幅 600px 前後でボタンと重なることが分かっている（max-width で折り返す）。
const { chromium } = require('playwright');

const base = process.argv[2] || 'http://127.0.0.1:4174/';
const WIDTHS = [320, 340, 360, 375, 414, 600, 900, 1280];
const HEIGHTS = [480, 568, 640, 667, 740, 800, 900];

(async () => {
  const browser = await chromium.launch();
  const bad = [];
  let n = 0;
  for (const w of WIDTHS)
    for (const h of HEIGHTS) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2400); // 序章の登場の動きが終わるまで待つ
      for (const pos of [0, 0.98]) {
        const r = await page.evaluate(async (pos) => {
          const label = document.querySelector('.hero-screen .rec');
          const scene = document.getElementById('top');
          window.scrollTo(0, scene.offsetTop + Math.max(0, scene.offsetHeight - innerHeight) * pos);
          await new Promise((res) => setTimeout(res, 350));
          const lr = label.getBoundingClientRect();
          const hit = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
          const overlaps = [...document.querySelectorAll('#top .beat *')]
            .filter((e) => e.children.length === 0 && e.textContent.trim() && getComputedStyle(e).opacity !== '0')
            .filter((e) => {
              const range = document.createRange();
              range.selectNodeContents(e);
              const rr = range.getBoundingClientRect();
              return rr.width > 0 && hit(lr, rr);
            })
            .map((e) => e.textContent.trim().slice(0, 12));
          return { overlaps, inView: lr.left >= 0 && lr.right <= innerWidth };
        }, pos);
        n++;
        if (r.overlaps.length || !r.inView) bad.push(`${w}x${h} p=${pos} ${JSON.stringify(r)}`);
      }
      await page.close();
    }
  await browser.close();
  if (bad.length) {
    console.error(bad.join('\n'));
    process.exit(1);
  }
  console.log(`OK: hero label has no overlap and stays in view (${n} cases)`);
})();
