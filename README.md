# XM4 Voice Studio

Standalone Astro website for creating and installing custom voice prompts on Sony WH-1000XM4 headphones. Pack creation runs in the browser.

This GitHub fork is maintained at [Jovlang/xm4-voice-studio](https://github.com/Jovlang/xm4-voice-studio),
based on [SadsArches/xm4-voice-studio on Codeberg](https://codeberg.org/SadsArches/xm4-voice-studio/).
The upstream [live site](https://sadsarches.codeberg.page/xm4-voice-studio/) is a separate deployment;
changes in this fork do not automatically appear there.

## Changes in this fork

- **Commit diagnostics:** Timestamped `Commit +…` logs show each parsed incoming RACE frame's type,
  command, and payload. They distinguish a positive commit response, rejection, device cancellation,
  missing responses, malformed payloads, and channel closure with an unknown cause. A timeout no longer
  claims the headphones accepted the command without evidence. The command sequence, 45-second wait,
  remain unchanged. Device cancellation is acknowledged and stops the commit. Timeout, receive errors,
  and channel closure now report an unconfirmed outcome rather than success; no cancellation or
  update-mode command is sent after an uncertain commit.
- **Control-channel opening diagnostics:** `Control +…` logs show secure-context and Web Serial
  availability, the Sony service UUID, picker completion, port information, open parameters, stream
  availability, and the original error name/message. These logs identify the failing stage without
  claiming to diagnose the underlying Windows or headset fault. No connection commands were added.
- **Sound import recovery:** Successfully saved imports update the sound list directly instead of
  fetching the bundled library again. Conversion and storage errors remain visible, controls are
  restored even after failure, and overlapping imports are prevented.
- **Local ZIP export:** **Export pack ZIP** downloads `xm4-voice-pack.zip` with the base language,
  prompt assignments, and assigned custom MP3s. It works without Supabase. Bundled sounds are referenced
  by filename rather than copied. Use **Open pack ZIP** on another compatible instance to import it.
- **Windows asset indexing:** The sound-index script uses `fileURLToPath` so Windows paths resolve correctly.
- **Reliable pack import:** Pack IDs are marked verified only after successful application. Older unverified
  markers are retried. Missing sounds are shown explicitly instead of silently resetting choices to stock;
  installation refuses missing assignments. IndexedDB writes wait for transaction completion, and blocked
  database opening and network requests report errors rather than leaving an indefinite loading indicator.
- **Source volume retained:** Audio imports retain their source level through conversion and silence trimming.
  No normalization, gain adjustment, or dynamic compression is applied. ZIP imports retain their encoded audio.
- **Connection safeguards:** A same-headset confirmation is required before Check/Install/Restore, wrong
  service IDs are refused, and Disconnect releases both ports. Confirmation resets when a channel changes.

## Running locally

```bash
npm install
npm run dev -- --background  # http://localhost:4321 (or the next available port)
npm run build    # static output in dist/
npm test         # FOTA state-machine, commit diagnostics, and sound-import checks
```

The starter sounds are bundled in `public/sounds/`. `npm run dev` and `npm run build` generate their index automatically.
Manage the background server with `npx astro dev status`, `npx astro dev logs`, and `npx astro dev stop`.
Stop it before branch switches or merges, then restart it afterward so temporary conflict markers do not
disrupt the running app. Sounds and prompt choices are stored in the browser, separately for each site origin.

## Deploying

`.forgejo/workflows/pages.yml` builds the site and publishes `dist/` to Codeberg Pages
(`https://<owner>.codeberg.page/xm4-voice-studio/`) on every push to `main`. Actions must be enabled in the
repository settings. The build sets `SITE_BASE=/xm4-voice-studio/` because the site is served from a subpath;
leave it unset when hosting at a domain root.

Sony's CDN sends no CORS headers, so the site serves its own copies of the bundled voice packs and their `info.xml`
manifests from `public/sony/HP002/` (same paths as on `info.update.sony.net`). If a file is missing, the page
falls back to a download link and a drop zone.

## Sharing packs

For a file-based transfer, click **Export pack ZIP** locally and **Open pack ZIP** on the destination site.
Confirm replacing existing prompt choices if asked. Only custom sounds used by the exported assignments
are included; unused sounds in your library are omitted. This is an editor pack, not an installable Sony `.bin`.

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
Sharing from localhost generates a localhost link. To send it to someone else, replace its origin and
path with the compatible public site's URL while keeping `#pack=<id>` intact; both instances must use
the same Supabase bucket. Content blockers can prevent the sharing panel or Supabase requests from working.

## Validation and hardware boundaries

The combined changes passed the production Astro build, existing FOTA state-machine simulations,
twelve commit-outcome scenarios, five sound-import scenarios, import retry/cancellation checks,
and IndexedDB commit/abort checks. Control-port opening was also checked
with simulated picker failure, port-open failure, and success. Browser ZIP export was checked for all
assigned custom files, and the exported pack was successfully imported on the upstream site.
These checks do not establish physical installation success on every XM4 unit.

- Web Serial exposes Bluetooth service IDs, not a common physical-device address. The same-headset checkbox
  is an operator safeguard, not automatic identity verification. Keep other headsets off while selecting ports.
  Automatic matching needs a verified device-identity protocol or a native helper.
- A successful commit response and disconnect do not prove the new audio became active. The app reports
  that outcome as unconfirmed; check voice guidance on the headset after restart. Hardware testing is still
  needed to verify device-specific installation behavior.

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

- The LZMA encoder differs from the original Python implementation. The current automated tests cover
  installer decisions and diagnostics, not a Python-versus-browser binary-format comparison.
- Bluetooth installation requires a desktop browser with Web Serial Bluetooth Classic RFCOMM support.
- Sony and WH-1000XM4 are trademarks of their respective owners. This is an independent community project and is not affiliated with Sony.

## License

GPL-3.0-or-later; see [LICENSE](LICENSE). The vendored [lzma1](src/lib/vendor/lzma1) code is MIT.
