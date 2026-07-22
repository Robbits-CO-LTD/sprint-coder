import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: ['electron/utility'],
      output: { entryFileNames: 'runtime-host.js' },
    },
  },
});
