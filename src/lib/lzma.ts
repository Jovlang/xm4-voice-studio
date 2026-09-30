// Raw LZMA1 with the 13-byte "LZMA alone" header Sony uses:
//   u8 props (lc/lp/pb), u32 dict_size, u64 uncompressed_size, then the range-coded stream.
// Wraps the vendored lzma1 encoder/decoder so we can pin dict_size to Sony's value (16 KiB —
// the headphones' decoder has a tiny window, so a bigger dictionary could emit
// back-references it can't resolve).
import { Decoder } from "./vendor/lzma1/decoder.js";
import { Encoder } from "./vendor/lzma1/encoder.js";
import { InputBuffer, OutputBuffer } from "./vendor/lzma1/streams.js";

export interface LzmaParams {
  lc: number;
  lp: number;
  pb: number;
  dictSize: number;
  propsByte: number;
}

export function parseLzmaProps(blob: Uint8Array): LzmaParams {
  const props = blob[0];
  const dictSize = new DataView(blob.buffer, blob.byteOffset + 1, 4).getUint32(0, true);
  return { lc: props % 9, lp: Math.floor(props / 9) % 5, pb: Math.floor(props / 45), dictSize, propsByte: props };
}

/** Decode a header-prefixed stream. Trailing bytes after the declared size (Sony's 0xff pad) are ignored. */
export function lzmaDecompress(blob: Uint8Array): Uint8Array {
  const out = new OutputBuffer(0x100000);
  new Decoder().decompress(new InputBuffer(blob), out);
  return out.toArray();
}

/** Encode with Sony's params. Output includes the 13-byte header with the true size, plus an EOS marker. */
export function lzmaCompress(payload: Uint8Array, params: LzmaParams): Uint8Array {
  if (params.propsByte !== 0x5d) {
    // Encoder is fixed at lc=3 lp=0 pb=2 (0x5d), which is what every known Sony pack uses.
    throw new Error(`unsupported LZMA props 0x${params.propsByte.toString(16)} (expected 0x5d)`);
  }
  const dictBits = Math.log2(params.dictSize);
  if (!Number.isInteger(dictBits)) throw new Error(`dict size ${params.dictSize} is not a power of two`);
  const out = new OutputBuffer(payload.length + 1024);
  new Encoder().compress(new InputBuffer(payload), out, {
    searchDepth: dictBits,
    filterStrength: 0x80,
    modeIndex: 1,
  });
  const result = out.toArray();
  const got = parseLzmaProps(result);
  if (got.propsByte !== params.propsByte || got.dictSize !== params.dictSize) {
    throw new Error("LZMA encoder wrote unexpected header");
  }
  return result;
}
