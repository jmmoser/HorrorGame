import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // The whole slice is code + canvas textures; cache everything up front
        // so the building is still there when the signal is gone.
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'The Descent Ledger',
        short_name: 'Descent Ledger',
        description:
          'A building inspector documents a condemned high-rise, floor by floor, descending.',
        start_url: '.',
        display: 'fullscreen',
        orientation: 'any',
        background_color: '#050505',
        theme_color: '#050505',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
});
