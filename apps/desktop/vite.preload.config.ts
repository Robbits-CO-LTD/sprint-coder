import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // main と preload の両entryが index.ts のため、既定だと双方 .vite/build/index.js に
        // 出力されて上書きし合う。preload だけ明示的に preload.js へ分離する。
        entryFileNames: 'preload.js',
      },
    },
  },
});
