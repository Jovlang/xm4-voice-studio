// Sony WH-1000XM4 voice pack (VP_*_UPG_03.bin) reader/writer.
// Port of pack_voice_pack.py — see NOTES.md §5, §9, §16 for the format and why each step exists.
import { cbc } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { lzmaCompress, lzmaDecompress, parseLzmaProps, type LzmaParams } from "./lzma";

const enc = new TextEncoder();
const KEY = enc.encode("eibohjeCh6uegahf");
const IV = enc.encode("miefeinuShu9eilo");
export const HEADER_SIZE = 0x1000;
export const IMAGE_SIZE = 0x100000; // fixed decompressed voice-image size

// TLV tags in the 4 KiB header (starting at 0x100): u16 tag, u16 len, value.
const TAG_COMPRESSION = 0x0011; // value+6: u32 body_size
const TAG_IMAGE_INFO = 0x0012; //  value+8: u32 decompressed_size
const TAG_DIGEST = 0x0014; //      value+4: SHA-256(decompressed image)

export const SLOT_LABELS: Record<number, string> = {
  0: "Power on", 1: "Power off", 2: "Bluetooth pairing",
  3: "Bluetooth connected", 4: "Bluetooth disconnected",
  5: "Recharge / power off (battery low)", 6: "Noise canceling",
  7: "Ambient Sound Control off", 8: "Ambient sound",
  9: "Google Assistant unavailable during update", 15: "Battery fully charged",
  16: "Battery about 70%", 17: "Battery about 50%", 18: "Battery about 20%",
  21: "Google Assistant not connected",
  24: "Alexa not connected", 27: "Assistant prompt (unknown)",
  35: "Optimizer start", 36: "Optimizer finished", 38: "Speech prompt (unknown)",
  34: "Low battery: recharge headset", 43: "Speak-to-chat on", 44: "Speak-to-chat off",
};
for (const i of [10, 11, 12, 13, 14, 19, 20, 22, 23, 25, 26, 37, 39, 40, 41, 42, 45, 46]) SLOT_LABELS[i] = "Notification tone / chime";
for (const [i, label] of Object.entries({28:"Battery about 90%",29:"Battery about 80%",30:"Battery about 60%",31:"Battery about 40%",32:"Battery about 30%",33:"Battery about 10%"})) SLOT_LABELS[Number(i)] = label;
SLOT_LABELS[47] = "Bluetooth device 1 connected";
SLOT_LABELS[48] = "Bluetooth device 1 disconnected";
SLOT_LABELS[49] = "Bluetooth device 2 connected";
SLOT_LABELS[50] = "Bluetooth device 2 disconnected";
SLOT_LABELS[51] = "Bluetooth device 1 replaced";
SLOT_LABELS[52] = "Bluetooth device 2 replaced";
SLOT_LABELS[53] = "Bluetooth second device connected";

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export interface VoicePack {
  header: Uint8Array;
  lzma: LzmaParams;
  version: number;
  baseOffset: number;
  slots: Uint8Array[];
}

export function isVoicePack(raw: Uint8Array): boolean {
  if (raw.length < HEADER_SIZE + 16) return false;
  try {
    walkTlv(raw.subarray(0, HEADER_SIZE));
    return findTlv(raw.subarray(0, HEADER_SIZE), TAG_DIGEST) !== undefined;
  } catch {
    return false;
  }
}

export function loadPack(raw: Uint8Array): VoicePack {
  if (raw.length < HEADER_SIZE + 16) throw new Error("file is too small to be a voice pack");
  const header = raw.slice(0, HEADER_SIZE);
  const body = raw.subarray(HEADER_SIZE);
  const plain = cbc(KEY, IV, { disablePadding: true }).decrypt(body.subarray(0, body.length & ~15));
  const lzma = parseLzmaProps(plain);
  const image = lzmaDecompress(plain);

  const v = dv(image);
  const version = v.getUint32(0, true);
  const n = v.getUint32(4, true);
  if (n === 0 || n > 256) throw new Error(`implausible slot count ${n}`);
  const baseOffset = v.getUint32(12, true) - (8 + n * 8);
  const slots: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const size = v.getUint32(8 + i * 8, true);
    const off = v.getUint32(12 + i * 8, true) - baseOffset;
    slots.push(image.slice(off, off + size));
  }
  return { header, lzma, version, baseOffset, slots };
}

/** Bytes serializeImage spends before the first slot's data. */
export function imageOverhead(nSlots: number): number {
  return (8 + nSlots * 8 + 3) & ~3;
}

export function serializeImage(pack: VoicePack, slots: Uint8Array[]): Uint8Array {
  const total = imageOverhead(slots.length) + slots.reduce((a, s) => a + s.length, 0);
  if (total > IMAGE_SIZE) {
    throw new Error(`voice image is ${total} B, exceeds ${IMAGE_SIZE} B. Use shorter sounds.`);
  }
  const out = new Uint8Array(IMAGE_SIZE); // zero-padded to the fixed size, like Sony's
  const v = dv(out);
  v.setUint32(0, pack.version, true);
  v.setUint32(4, slots.length, true);
  let pos = imageOverhead(slots.length);
  slots.forEach((data, i) => {
    v.setUint32(8 + i * 8, data.length, true);
    v.setUint32(12 + i * 8, pack.baseOffset + pos, true);
    out.set(data, pos);
    pos += data.length;
  });
  return out;
}

function walkTlv(header: Uint8Array): Map<number, number> {
  const v = dv(header);
  const tags = new Map<number, number>(); // tag -> offset of value
  let pos = 0x100;
  while (pos + 4 <= HEADER_SIZE) {
    const tag = v.getUint16(pos, true);
    const len = v.getUint16(pos + 2, true);
    if (tag === 0 || tag === 0xffff || pos + 4 + len > HEADER_SIZE) break;
    tags.set(tag, pos + 4);
    pos += 4 + len;
  }
  return tags;
}

function findTlv(header: Uint8Array, tag: number): number | undefined {
  return walkTlv(header).get(tag);
}

function requireTlv(header: Uint8Array, tag: number): number {
  const off = findTlv(header, tag);
  if (off === undefined) throw new Error(`TLV tag 0x${tag.toString(16).padStart(4, "0")} missing`);
  return off;
}

/** Rebuild a signed VP_*.bin with the given slot contents. */
export function buildPack(pack: VoicePack, slots: Uint8Array[]): Uint8Array {
  const image = serializeImage(pack, slots);
  const compressed = lzmaCompress(image, pack.lzma);
  // Sony pads to the AES block size with 0xff (NOR erase state).
  const padded = new Uint8Array(Math.ceil(compressed.length / 16) * 16).fill(0xff);
  padded.set(compressed);
  const body = cbc(KEY, IV, { disablePadding: true }).encrypt(padded);

  const file = new Uint8Array(HEADER_SIZE + body.length);
  file.set(pack.header);
  file.set(body, HEADER_SIZE);
  const v = dv(file);
  v.setUint32(requireTlv(file, TAG_COMPRESSION) + 6, body.length, true);
  v.setUint32(requireTlv(file, TAG_IMAGE_INFO) + 8, image.length, true);
  file.set(sha256(image), requireTlv(file, TAG_DIGEST) + 4);
  // The device's CheckIntegrity compares SHA-256(file[0x100:]) with file[0:32] (NOTES.md §16).
  file.set(sha256(file.subarray(0x100)), 0);
  return file;
}
