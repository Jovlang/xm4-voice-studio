# XM4 Voice Studio

Standalone Astro website for creating and installing custom voice prompts on Sony WH-1000XM4 headphones. Pack creation runs in the browser.

**Live site:** https://sadsarches.codeberg.page/xm4-voice-studio/

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in dist/
npm test         # installer state-machine checks
```

The starter sounds are bundled in `public/sounds/`. `npm run dev` and `npm run build` generate their index automatically.

## Deploying

`.forgejo/workflows/pages.yml` builds the site and publishes `dist/` to Codeberg Pages
(`https://<owner>.codeberg.page/xm4-voice-studio/`) on every push to `main`. Actions must be enabled in the
repository settings. The build sets `SITE_BASE=/xm4-voice-studio/` because the site is served from a subpath;
leave it unset when hosting at a domain root.

Sony's CDN sends no CORS headers, so the site serves its own copies of the 10 voice packs and their `info.xml`
manifests from `public/sony/HP002/` (same paths as on `info.update.sony.net`). If a file is missing, the page
falls back to a download link and a drop zone.

## Sharing packs

The **Share pack** button zips the user's own sounds plus their prompt choices, uploads the zip to a public
[Supabase Storage](https://supabase.com/docs/guides/storage) bucket straight from the browser, and gives a
`#pack=<id>` link. Opening the link downloads the zip and adds it to the visitor's tapes. Library sounds aren't
uploaded; the zip refers to them by name.

To enable it, create a Supabase project and run this in its SQL editor:

```sql
-- Public bucket: anyone can download; only zips up to 2 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('packs', 'packs', true, 2097152, array['application/zip']);

-- Anyone can upload a new pack (no overwriting, listing or deleting).
create policy "anyone can upload packs" on storage.objects for insert to anon
with check (bucket_id = 'packs' and name ~ '^[A-Za-z0-9]{12}\.zip$');
```

Then set `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` (see `.env.example`) for `npm run dev` / `npm run build`.
Both are public by design. Without them the Share button is hidden.

## Layout

| Path | What |
|---|---|
| `src/lib/voicepack.ts` | Decrypt/decompress/repack/sign `VP_*.bin` (AES-128-CBC, LZMA1, TLV patch, SHA-256 signature) |
| `src/lib/manifest.ts` | Forge `info.xml` (AES-128-ECB, SHA-1 MAC + digest, language rewrite) |
| `src/lib/lzma.ts` | LZMA1 with Sony's params (16 KiB dictionary) on top of vendored [lzma1](src/lib/vendor/lzma1) (MIT) |
| `src/lib/audio.ts` | Any audio → 48 kHz mono 64 kbps MP3 via Web Audio + lamejs |
| `src/lib/share.ts` | Zip/unzip shared packs and upload/download them from Supabase Storage |
| `src/lib/store.ts` | IndexedDB cache for Sony files and uploaded sounds |
| `src/scripts/app.ts` | Page UI |

## Notes

- The LZMA stream differs byte-wise from Python's (different encoder) but decompresses to the identical
  image; the header, signature and manifest logic match the Python output exactly (`npm test`).
- Bluetooth installation requires a desktop browser with Web Bluetooth support.
- Sony and WH-1000XM4 are trademarks of their respective owners. This is an independent community project and is not affiliated with Sony.

## License

GPL-3.0-or-later; see [LICENSE](LICENSE). The vendored [lzma1](src/lib/vendor/lzma1) code is MIT.
