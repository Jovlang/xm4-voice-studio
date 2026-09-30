// Forge a Sony info.xml so it advertises a patched VP_*.bin. Port of pack_info_xml.py.
import { ecb } from "@noble/ciphers/aes.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { asset } from "./base";

// From com.sony.songpal.automagic Y6.d.
const INFO_XML_KEY = new Uint8Array([0x4f, 0xa2, 0x79, 0x99, 0xff, 0xd0, 0x8b, 0x1f, 0xe4, 0xd2, 0x60, 0xd5, 0x7b, 0x6d, 0x3c, 0x17]);
export const MODEL = "HP002";

export const LANG_NAMES: Record<string, string> = {
  "01": "english", "02": "french", "03": "german", "04": "spanish", "05": "italian",
  "06": "portuguese", "07": "dutch", "08": "swedish", "09": "finnish", "10": "turkish",
};
export const langPackId = (code: string) => `VGIDLPB04${code}`;
const CDN = "https://info.update.sony.net";
// Paths on Sony's CDN. Sony sends no CORS headers, so the site serves copies of these files itself,
// mirrored under public/sony/ with the same paths.
export const packPath = (code: string) =>
  `/${MODEL}/${langPackId(code)}/contents/0002/VP_${LANG_NAMES[code]}_UPG_03.bin`;
export const infoPath = (code: string) => `/${MODEL}/${langPackId(code)}/info/info.xml`;
export const packUrl = (code: string) => CDN + packPath(code);
export const infoUrl = (code: string) => CDN + infoPath(code);
export const mirrorUrl = (path: string) => asset(`sony${path}`);

const te = new TextEncoder();
const td = new TextDecoder();

export function isInfoXml(raw: Uint8Array): boolean {
  return td.decode(raw.subarray(0, 5)) === "eaid:";
}

/** Split the plaintext eaid:/daid:/digest: lines from the encrypted body. */
function splitHeader(buf: Uint8Array): { lines: string[]; body: Uint8Array } {
  let end = 0;
  for (let i = 0; i < 3; i++) {
    end = buf.indexOf(0x0a, end) + 1;
    if (end === 0) throw new Error("info.xml header is truncated");
  }
  while (end < buf.length && (buf[end] === 0x0a || buf[end] === 0x0d)) end++;
  const lines = td.decode(buf.subarray(0, end)).split(/\r?\n/).filter((l) => l.trim());
  return { lines, body: buf.subarray(end) };
}

function decrypt(body: Uint8Array): Uint8Array {
  const plain = ecb(INFO_XML_KEY, { disablePadding: true }).decrypt(body.subarray(0, body.length & ~15));
  let n = plain.length;
  while (n > 0 && plain[n - 1] === 0) n--;
  return plain.subarray(0, n);
}

function encrypt(plain: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(plain.length / 16) * 16);
  padded.set(plain);
  return ecb(INFO_XML_KEY, { disablePadding: true }).encrypt(padded);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function forgeManifest(
  raw: Uint8Array,
  patchedBin: Uint8Array,
  target: string,
  opts: { distId?: string; log?: (s: string) => void } = {},
): Uint8Array {
  const { distId = "FW", log = () => {} } = opts;
  const { lines, body } = splitHeader(raw);
  const plain = decrypt(body);
  let xml = td.decode(plain);
  if (!xml.includes("<InformationFile")) throw new Error("info.xml didn't decrypt to an InformationFile XML");

  // Patch Size + MAC (SHA-1) of the FW Distribution.
  const size = patchedBin.length;
  const mac = bytesToHex(sha1(patchedBin));
  const re = new RegExp(`(<Distribution\\b[^>]*\\bID="${escapeRe(distId)}"[^>]*?)/?>`);
  const m = re.exec(xml);
  if (!m) throw new Error(`Distribution ID="${distId}" not found in manifest`);
  const block = m[1];
  const newBlock = block.replace(/\bSize="\d+"/, `Size="${size}"`).replace(/\bMAC="[0-9a-fA-F]+"/, `MAC="${mac}"`);
  if (!/\bSize="/.test(block) || !/\bMAC="/.test(block)) throw new Error("Distribution is missing Size/MAC");
  xml = xml.slice(0, m.index) + newBlock + xml.slice(m.index + block.length);
  log(`Manifest: Size=${size} MAC=${mac}`);

  // Make the manifest look native to the target language.
  const src = /VGIDLPB04(\d{2})/.exec(xml)?.[1];
  if (!src || !LANG_NAMES[src]) throw new Error("couldn't find the source language in the manifest");
  if (!LANG_NAMES[target]) throw new Error(`unknown target language ${target}`);
  if (src !== target) {
    xml = xml.replaceAll(`VGIDLPB04${src}`, `VGIDLPB04${target}`)
      .replaceAll(`VP_${LANG_NAMES[src]}_`, `VP_${LANG_NAMES[target]}_`);
    log(`Manifest: rewrote ${LANG_NAMES[src]} → ${LANG_NAMES[target]}`);
  }

  const newPlain = te.encode(xml);
  // digest = SHA1_hex( SHA1_hex(plain) + lang_pack + model )
  const digest = bytesToHex(sha1(te.encode(bytesToHex(sha1(newPlain)) + langPackId(target) + MODEL)));
  const header = lines.map((l) => (l.startsWith("digest:") ? `digest:${digest}` : l)).join("\n") + "\n\n";
  const newBody = encrypt(newPlain);
  const out = new Uint8Array(te.encode(header).length + newBody.length);
  out.set(te.encode(header));
  out.set(newBody, out.length - newBody.length);
  return out;
}
