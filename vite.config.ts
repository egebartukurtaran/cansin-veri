import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative base so the app works under any GitHub Pages sub-path.
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Rapor → SPSS Listesi',
        short_name: 'Rapor→SPSS',
        description: 'Laboratuvar ve eko PDF raporlarından SPSS listesine veri aktarımı',
        lang: 'tr',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f4f5f7',
        theme_color: '#1f5fbf',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png}'],
        // pdf.js worker is ~1 MB
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
