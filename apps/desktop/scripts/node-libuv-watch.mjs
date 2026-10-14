// Issue #734: Windows サンドボックスの修正（libuv 1.53.0）が入った公式 Node が公開されたかを判定する。
// nodejs.org の dist index.json だけを読み、該当する版を JSON で標準出力に書く。それ以外の副作用はない。
import process from 'node:process';

export const MIN_FIXED_LIBUV = '1.53.0';

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(typeof text === 'string' ? text : '');
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) throw new Error(`invalid version: ${a} / ${b}`);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

// 版や libuv の欄が欠けている・形式が不正なエントリは「修正入り」と数えない（fail closed）。
export function findFixedReleases(index, minLibuv = MIN_FIXED_LIBUV) {
  if (!Array.isArray(index)) throw new Error('dist index must be an array');
  return index
    .filter((entry) => parseVersion(entry?.version) !== null && parseVersion(entry?.uv) !== null)
    .filter((entry) => compareVersions(entry.uv, minLibuv) >= 0)
    .map((entry) => ({
      version: entry.version,
      date: entry.date,
      uv: entry.uv,
      lts: entry.lts || false,
    }));
}

if (process.argv.includes('--run')) {
  const response = await globalThis.fetch('https://nodejs.org/dist/index.json');
  if (!response.ok) throw new Error(`dist index fetch failed: ${response.status}`);
  process.stdout.write(`${JSON.stringify(findFixedReleases(await response.json()))}\n`);
}
