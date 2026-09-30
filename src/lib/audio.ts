// Browser replacement for `ffmpeg -ar 48000 -ac 1 -b:a 64k`: decode anything the browser
// can play, downmix + resample to 48 kHz mono, encode 64 kbps MP3 (raw frames, no ID3/Xing).
import { Mp3Encoder } from "@breezystack/lamejs";

const RATE = 48000;
const KBPS = 64;
const FRAME = 1152;

export async function toSlotMp3(file: Blob): Promise<Uint8Array> {
  const decoded = await new AudioContext().decodeAudioData(await file.arrayBuffer());
  const length = Math.ceil(decoded.duration * RATE);
  const ctx = new OfflineAudioContext(1, length, RATE);
  const src = ctx.createBufferSource();
  src.buffer = decoded; // a mono destination downmixes automatically
  src.connect(ctx.destination);
  src.start();
  const pcm = (await ctx.startRendering()).getChannelData(0);

  const samples = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const encoder = new Mp3Encoder(1, RATE, KBPS);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < samples.length; i += FRAME) {
    chunks.push(encoder.encodeBuffer(samples.subarray(i, i + FRAME)));
  }
  chunks.push(encoder.flush());
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/** Approximate duration of a 64 kbps MP3. */
export const mp3Seconds = (bytes: number) => bytes / (KBPS * 125);
