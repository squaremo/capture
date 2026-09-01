import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // The commit this bundle was built from (set via Dockerfile ARG/ENV);
  // 'dev' outside Docker. Shown in the UI alongside the backend/config
  // versions from GET /api/version. This is genuine build identity, so
  // it's the one thing still baked in at build time — deployment-specific
  // values (which house this is, where the backend is) are runtime
  // config instead, fetched from /config.json (see src/config.js and
  // designs/satellites.md's House attribution section) so the same build
  // works everywhere, satellites included.
  define: {
    __GIT_SHA__: JSON.stringify(process.env.GIT_SHA ?? 'dev'),
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Capture',
        short_name: 'Capture',
        description: 'Zero-friction personal capture tool',
        theme_color: '#0d0d0d',
        background_color: '#0d0d0d',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: '/icons/192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly'
          }
        ]
      }
    })
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
})
