import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // three ships its WebGPU/TSL entrypoints as separate exports; pre-bundling
    // them keeps the first paint from stalling on a few hundred module requests.
    include: ['three/webgpu', 'three/tsl'],
    // Re-optimize on boot. The React 18 -> 19 upgrade left a stale pre-bundle
    // that kept serving React 18 internals (`ReactCurrentDispatcher`) to a
    // React 19 tree, which blanked the page.
    force: true,
  },
  server: {
    port: 3000,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/health': { target: 'http://localhost:3001', changeOrigin: true },
      '/metrics': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
