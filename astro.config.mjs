// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // Served from a subpath on Codeberg Pages (e.g. SITE_BASE=/xm4-voice-studio/); "/" everywhere else.
  base: process.env.SITE_BASE || '/',
});
