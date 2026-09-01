import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // The commit this bundle was built from (set via Dockerfile ARG/ENV);
  // 'dev' outside Docker. Shown in the UI alongside the backend/config
  // versions from GET /api/version.
  //
  // __DEFAULT_HOUSE__: which house this particular build "is" — empty for
  // the general frontend (phone/laptop), set for a satellite's own build
  // once one is deployed. When set, the house chooser in capture.js
  // defaults to it and shows a "this is where you are" indicator, rather
  // than relying purely on a remembered (sticky) choice. See
  // designs/satellites.md's House attribution section.
  define: {
    __GIT_SHA__: JSON.stringify(process.env.GIT_SHA ?? 'dev'),
    __DEFAULT_HOUSE__: JSON.stringify(process.env.DEFAULT_HOUSE ?? ''),
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
