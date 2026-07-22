import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standard Vite + React setup.
// - Build output goes to dist/, which the Node server serves via express.static.
// - `npm run dev` starts Vite's dev server (with HMR) and proxies the API/WS
//   endpoints to the Node server so you can run the real backend alongside.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/config': 'http://localhost:3000',
      // WebSocket signaling endpoint.
      '/ws': { target: 'http://localhost:3000', ws: true },
    },
  },
});
