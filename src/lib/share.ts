// Share prompt assignments as a zip in a public Supabase Storage bucket, and read them back.
// Only the uploader's own sounds go in the zip; library sounds ship with the site and are referenced by id.
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

const SUPABASE_URL = (import.meta.env.PUBLIC_SUPABASE_URL as string | undefined)?.replace(/\/+$/, "");
const SUPABASE_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;
const BUCKET = (import.meta.env.PUBLIC_SUPABASE_BUCKET as string | undefined) || "packs";
/** Sharing needs a Supabase project; without one the Share button stays hidden. */
export const shareEnabled = !!(SUPABASE_URL && SUPABASE_KEY);

// A whole voice image is 1 MiB, so no honest pack's sounds come close to these.
const MAX_ZIP = 2 * 1024 * 1024;
const MAX_SOUND = 1024 * 1024;
const MAX_SOUNDS = 64;
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ID_RE = /^[A-Za-z0-9]{12}$/;
const NAME_RE = /^[\w.\- ]{1,80}$/;

export interface SharedPack {
  source: string;
  /** Slot number → "library/<file>" or "custom/<name>". */
  assignments: Record<string, string>;
  /** Custom sound name → MP3 bytes. */
  sounds: Record<string, Uint8Array>;
}

/** The pack id in a share link (#pack=<id>), if this page was opened from one. */
export function linkedPackId(hash = location.hash): string | undefined {
  const id = new URLSearchParams(hash.slice(1)).get("pack");
  return id && ID_RE.test(id) ? id : undefined;
}

export const shareLink = (id: string) => `${location.origin}${location.pathname}#pack=${id}`;

const objectUrl = (id: string) => `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${id}.zip`;
const publicUrl = (id: string) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${id}.zip`;

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join("");
}

export function zipPack(pack: SharedPack): Uint8Array {
  const files: Zippable = { "pack.json": strToU8(JSON.stringify({ version: 1, source: pack.source, assignments: pack.assignments })) };
  for (const [name, data] of Object.entries(pack.sounds)) files[`sounds/${name}.mp3`] = data;
  return zipSync(files);
}

/** An MP3 starts with a frame sync, or with an ID3 tag. */
const isMp3 = (b: Uint8Array) => b.length > 3 && ((b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || strFromU8(b.subarray(0, 3)) === "ID3");

/** Parse and validate a shared zip. Throws with a readable message if anything is off. */
export function unzipPack(zip: Uint8Array): SharedPack {
  let files: Record<string, Uint8Array>;
  try {
    // The filter runs before inflating, so an oversized (or zip-bomb) entry is never expanded.
    files = unzipSync(zip, { filter: (f) => f.originalSize <= MAX_SOUND && (f.name === "pack.json" || /^sounds\/[^/]+\.mp3$/.test(f.name)) });
  } catch {
    throw new Error("the shared file isn't a valid zip");
  }
  if (!files["pack.json"]) throw new Error("the shared zip has no pack.json");
  let meta;
  try {
    meta = JSON.parse(strFromU8(files["pack.json"]));
  } catch {
    throw new Error("pack.json is malformed");
  }
  if (meta?.version !== 1) throw new Error("this pack was made by a newer version of the site");
  if (typeof meta.source !== "string" || typeof meta.assignments !== "object" || !meta.assignments) throw new Error("pack.json is malformed");

  const sounds: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(files)) {
    if (path === "pack.json") continue;
    const name = path.slice("sounds/".length, -".mp3".length);
    if (!NAME_RE.test(name) || !isMp3(data)) throw new Error(`${path} isn't a valid sound`);
    sounds[name] = data;
  }
  if (Object.keys(sounds).length > MAX_SOUNDS) throw new Error("the pack has too many sounds");

  const assignments: Record<string, string> = {};
  for (const [slot, id] of Object.entries(meta.assignments)) {
    if (!/^\d{1,3}$/.test(slot) || typeof id !== "string") throw new Error("pack.json has an invalid prompt");
    if (id.startsWith("custom/") && !sounds[id.slice(7)]) throw new Error(`the pack is missing ${id.slice(7)}`);
    if (!id.startsWith("custom/") && !/^library\/[\w.\- ]+$/.test(id)) throw new Error("pack.json has an invalid sound");
    assignments[slot] = id;
  }
  return { source: meta.source, assignments, sounds };
}

/** Upload a pack and return its id for the share link. */
export async function uploadPack(pack: SharedPack): Promise<string> {
  const zip = zipPack(pack);
  if (zip.length > MAX_ZIP) throw new Error("the pack is too big to share");
  const id = newId();
  const r = await fetch(objectUrl(id), {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY!,
      // Legacy anon keys are JWTs and go in Authorization too; publishable keys (sb_publishable_…) only go in apikey.
      ...(SUPABASE_KEY!.startsWith("eyJ") ? { Authorization: `Bearer ${SUPABASE_KEY}` } : {}),
      "Content-Type": "application/zip",
      "x-upsert": "false",
    },
    body: new Blob([zip as BlobPart], { type: "application/zip" }),
  });
  if (!r.ok) {
    const detail = await r.json().then((j) => j.message || j.error, () => "");
    throw new Error(`upload failed (HTTP ${r.status}${detail ? `: ${detail}` : ""})`);
  }
  return id;
}

export async function downloadPack(id: string): Promise<SharedPack> {
  const r = await fetch(publicUrl(id));
  if (r.status === 400 || r.status === 404) throw new Error("this shared pack doesn't exist (it may have been removed)");
  if (!r.ok) throw new Error(`download failed (HTTP ${r.status})`);
  const zip = new Uint8Array(await r.arrayBuffer());
  if (zip.length > MAX_ZIP) throw new Error("the shared file is too big");
  return unzipPack(zip);
}
