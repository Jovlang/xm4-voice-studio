# XM4 Voice Studio

Standalone Astro website for creating and installing custom voice prompts on Sony WH-1000XM4 headphones. Pack creation runs in the browser.

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in dist/
npm test         # installer state-machine checks
```

The starter sounds are bundled in `public/sounds/`. `npm run dev` and `npm run build` generate their index automatically.

## Layout

| Path | What |
|---|---|
| `src/lib/voicepack.ts` | Decrypt/decompress/repack/sign `VP_*.bin` (AES-128-CBC, LZMA1, TLV patch, SHA-256 signature) |
| `src/lib/manifest.ts` | Forge `info.xml` (AES-128-ECB, SHA-1 MAC + digest, language rewrite) |
| `src/lib/lzma.ts` | LZMA1 with Sony's params (16 KiB dictionary) on top of vendored [lzma1](src/lib/vendor/lzma1) (MIT) |
| `src/lib/audio.ts` | Any audio → 48 kHz mono 64 kbps MP3 via Web Audio + lamejs |
| `src/lib/store.ts` | IndexedDB cache for Sony files and uploaded sounds |
| `src/scripts/app.ts` | Page UI |

## Notes

- Sony's CDN sends no CORS headers, so users download the pack + `info.xml` via links and drop them in.
- The LZMA stream differs byte-wise from Python's (different encoder) but decompresses to the identical
  image; the header, signature and manifest logic match the Python output exactly (`npm test`).
- Bluetooth installation requires a desktop browser with Web Bluetooth support.
- Sony and WH-1000XM4 are trademarks of their respective owners. This is an independent community project and is not affiliated with Sony.
