// @ts-check
import { defineConfig } from 'astro/config';

// /sony/* → Sony's update CDN. Sony sends no CORS headers, so the browser fetches voice packs and
// manifests through the site's own origin. This covers `astro dev`/`astro preview`; when hosted,
// functions/sony/[[path]].ts does the same job.
const sonyRelay = {
  '/sony': {
    target: 'https://info.update.sony.net',
    changeOrigin: true,
    rewrite: (/** @type {string} */ p) => p.replace(/^\/sony/, ''),
  },
};

// https://astro.build/config
export default defineConfig({
  vite: {
    server: { proxy: sonyRelay },
    preview: { proxy: sonyRelay },
  },
});
