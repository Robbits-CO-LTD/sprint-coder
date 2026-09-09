import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // CLI isolation can unpack plugin HTML here during a turn. It is runtime data, not a page
  // source; reloading the renderer would disconnect its live event and approval subscriptions.
  server: { watch: { ignored: ['**/.vite-user-data/**'] } },
});
