import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: the page talks to the gateway through this same origin (/rpc is proxied),
// exactly as it does when the gateway serves the built UI in production.
const gateway = process.env.ADG_GATEWAY ?? 'http://127.0.0.1:3290'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/rpc': { target: gateway, ws: true } },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 900 },
})
