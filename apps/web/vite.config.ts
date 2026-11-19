import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: the page talks to the gateway through this same origin (/rpc is proxied),
// exactly as it does when the gateway serves the built UI in production.
const gateway = process.env.ADG_GATEWAY ?? 'http://127.0.0.1:3290'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: './',
  // The dev server only: the gateway token the dev host was started with (scripts/dev-open.mjs, .claude/launch.json
  // set a fixed one), so a page opened by hand needs no ?token=. A build never carries one.
  define: { __ADG_DEV_TOKEN__: JSON.stringify(command === 'serve' ? process.env['ADG_GATEWAY_TOKEN'] ?? '' : '') },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/rpc': { target: gateway, ws: true } },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 900 },
}))
