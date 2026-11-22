/**
 * Container probing for video inputs (no ffmpeg): format, codec, size, frame rate
 * (port of media.py). Best effort: unknown fields are `null`.
 */

import { pyRound } from "./pyfmt.js";

export const VIDEO_EXTENSIONS: Record<string, string> = {
  ".mp4": "mp4",
  ".m4v": "mp4",
  ".mov": "mov",
  ".webm": "webm",
  ".mkv": "mkv",
  ".gif": "gif",
  ".webp": "webp",
};
export const MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/mp4",
  webm: "video/webm",
  mkv: "video/webm",
  gif: "image/gif",
  webp: "image/webp",
};
const MP4_CODECS: Record<string, string> = {
  avc1: "h264",
  avc3: "h264",
  hvc1: "hevc",
  hev1: "hevc",
  av01: "av1",
  vp09: "vp9",
  vp08: "vp8",
  mp4v: "mpeg4",
};
const MKV_CODECS: Record<string, string> = {
  V_VP8: "vp8",
  V_VP9: "vp9",
  V_AV1: "av1",
  "V_MPEG4/ISO/AVC": "h264",
  "V_MPEGH/ISO/HEVC": "hevc",
};

/** What the container says about the (first) video track. */
export interface Probe {
  container: string;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frameCount: number | null;
  duration: number | null;
}

export const isAnimatedImage = (p: Probe) => p.container === "gif" || p.container === "webp";

const ascii = (data: Uint8Array, s: number, e: number) => String.fromCharCode(...data.subarray(s, e));

/** Container from magic bytes (`null` if not a supported video/animated image). */
export function sniff(data: Uint8Array): string | null {
  if (ascii(data, 4, 8) === "ftyp") return ascii(data, 8, 12) === "qt  " ? "mov" : "mp4";
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    return ascii(data, 0, 64).includes("webm") ? "webm" : "mkv";
  }
  const head = ascii(data, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return "gif";
  if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") return "webp";
  return null;
}

/** Parse the container header (`container` is used if the magic bytes are unknown). */
export function probe(data: Uint8Array, container: string | null = null): Probe {
  const kind = sniff(data) ?? container;
  if (kind === null) throw new Error("Not a supported video or animated image (mp4, mov, webm, mkv, gif, webp)");
  const out: Probe = { container: kind, codec: null, width: null, height: null, fps: null, frameCount: null, duration: null };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  try {
    if (kind === "mp4" || kind === "mov") mp4(data, view, out);
    else if (kind === "webm" || kind === "mkv") matroska(data, view, out);
    else if (kind === "gif") {
      out.codec = "gif";
      out.width = view.getUint16(6, true);
      out.height = view.getUint16(8, true);
    } else if (kind === "webp") {
      out.codec = "webp";
      webp(data, view, out);
    }
  } catch {
    // Truncated or unusual header: keep what was found.
  }
  if (out.fps !== null) out.fps = pyRound(out.fps, 3);
  if (out.duration !== null) out.duration = pyRound(out.duration, 4);
  return out;
}

// ISO BMFF -------------------------------------------------------------------------------

const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

function* boxes(data: Uint8Array, view: DataView, start: number, end: number): Generator<[string, number, number]> {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const kind = ascii(data, pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) return;
    yield [kind, pos + header, Math.min(pos + size, end)];
    pos += size;
  }
}

function mp4(data: Uint8Array, view: DataView, out: Probe): void {
  for (const [kind, start, end] of boxes(data, view, 0, data.length)) {
    if (kind !== "moov") continue;
    for (const [tkind, ts, te] of boxes(data, view, start, end)) {
      if (tkind === "trak" && mp4Track(data, view, ts, te, out)) return;
    }
  }
}

function mp4Track(data: Uint8Array, view: DataView, start: number, end: number, out: Probe): boolean {
  const found = new Map<string, [number, number]>();
  const walk = (s: number, e: number) => {
    for (const [kind, cs, ce] of boxes(data, view, s, e)) {
      if (MP4_CONTAINERS.has(kind)) walk(cs, ce);
      else if (!found.has(kind)) found.set(kind, [cs, ce]);
    }
  };
  walk(start, end);
  const hdlr = found.get("hdlr");
  if (!hdlr || ascii(data, hdlr[0] + 8, hdlr[0] + 12) !== "vide") return false;
  let timescale = 0;
  const mdhd = found.get("mdhd");
  if (mdhd) {
    const s = mdhd[0];
    let duration: number;
    if (data[s] === 1) {
      timescale = view.getUint32(s + 20);
      duration = Number(view.getBigUint64(s + 24));
    } else {
      timescale = view.getUint32(s + 12);
      duration = view.getUint32(s + 16);
    }
    if (timescale) out.duration = duration / timescale;
  }
  const stsd = found.get("stsd");
  if (stsd) {
    const entry = stsd[0] + 8;
    const fourcc = ascii(data, entry + 4, entry + 8);
    out.codec = MP4_CODECS[fourcc] ?? (fourcc.trim() || null);
    out.width = view.getUint16(entry + 32);
    out.height = view.getUint16(entry + 34);
  }
  const stts = found.get("stts");
  if (stts && timescale) {
    const count = view.getUint32(stts[0] + 4);
    let frames = 0;
    let total = 0;
    for (let i = 0; i < count; i++) {
      const n = view.getUint32(stts[0] + 8 + 8 * i);
      const delta = view.getUint32(stts[0] + 12 + 8 * i);
      frames += n;
      total += n * delta;
    }
    if (frames) out.frameCount = frames;
    if (total) out.fps = (frames * timescale) / total;
  }
  return true;
}

// Matroska / WebM ------------------------------------------------------------------------

const MKV_ENTER = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xe0, 0x1f43b675, 0xa0]);
const TRACK_ENTRY = 0xae;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const CODEC_ID = 0x86;
const TRACK_UINTS: Record<number, string> = {
  0xd7: "number",
  0x83: "type",
  0x23e383: "default_duration",
  0xb0: "width",
  0xba: "height",
};
const BLOCKS = new Set([0xa3, 0xa1]);

/** EBML variable-length integer -> [value, length, all-ones = unknown size]. */
function vint(data: Uint8Array, pos: number, strip: boolean): [number, number, boolean] {
  const first = data[pos];
  if (first === undefined) throw new Error("truncated");
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8) throw new Error("bad EBML vint");
  let value = strip ? first & (mask - 1) : first;
  for (let i = 1; i < length; i++) {
    const b = data[pos + i];
    if (b === undefined) throw new Error("truncated");
    value = value * 256 + b;
  }
  const unknown = strip && value === 2 ** (7 * length) - 1;
  return [value, length, unknown];
}

function uint(data: Uint8Array, s: number, e: number): number {
  let v = 0;
  for (let i = s; i < e; i++) v = v * 256 + data[i];
  return v;
}

function matroska(data: Uint8Array, view: DataView, out: Probe): void {
  const tracks: Record<string, number | string>[] = [];
  const blocks = new Map<number, number>();
  let timescale = 1_000_000;
  let duration: number | null = null;
  const [headerSize, headerLen] = vint(data, 4, true);
  let pos = 4 + headerLen + headerSize;
  const end = data.length;
  while (pos < end) {
    const [eid, ilen] = vint(data, pos, false);
    const [size, slen, unknown] = vint(data, pos + ilen, true);
    const body = pos + ilen + slen;
    if (MKV_ENTER.has(eid)) {
      pos = body;
      continue;
    }
    if (eid === TRACK_ENTRY) {
      tracks.push({});
      pos = body;
      continue;
    }
    if (unknown) break;
    const stop = Math.min(body + size, end);
    const track = tracks.length ? tracks[tracks.length - 1] : {};
    if (eid === TIMECODE_SCALE) timescale = uint(data, body, stop);
    else if (eid === DURATION) duration = size === 4 ? view.getFloat32(body) : view.getFloat64(body);
    else if (eid === CODEC_ID) track.codec = ascii(data, body, stop).replace(/\0+$/, "");
    else if (eid in TRACK_UINTS) track[TRACK_UINTS[eid]] = uint(data, body, stop);
    else if (BLOCKS.has(eid)) {
      const number = vint(data, body, true)[0];
      blocks.set(number, (blocks.get(number) ?? 0) + 1);
    }
    pos = stop;
  }
  if (duration !== null) out.duration = (duration * timescale) / 1e9;
  const video = tracks.find((t) => t.type === 1);
  if (!video) return;
  const codec = String(video.codec ?? "");
  out.codec = MKV_CODECS[codec] ?? (codec.replace(/^V_/, "").toLowerCase() || null);
  out.width = typeof video.width === "number" ? video.width : null;
  out.height = typeof video.height === "number" ? video.height : null;
  const count = typeof video.number === "number" ? blocks.get(video.number) : undefined;
  out.frameCount = count || null;
  const dd = video.default_duration;
  if (typeof dd === "number" && dd > 0) out.fps = 1e9 / dd;
  else if (count && out.duration) out.fps = count / out.duration;
}

// WebP -----------------------------------------------------------------------------------

function webp(data: Uint8Array, view: DataView, out: Probe): void {
  let pos = 12;
  let frames = 0;
  let totalMs = 0;
  const u24 = (p: number) => data[p] | (data[p + 1] << 8) | (data[p + 2] << 16);
  while (pos + 8 <= data.length) {
    const kind = ascii(data, pos, pos + 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (kind === "VP8X") {
      out.width = 1 + u24(body + 4);
      out.height = 1 + u24(body + 7);
    } else if (kind === "ANMF") {
      frames++;
      totalMs += u24(body + 12);
    } else if (kind === "VP8 " && out.width === null) {
      out.width = view.getUint16(body + 6, true) & 0x3fff;
      out.height = view.getUint16(body + 8, true) & 0x3fff;
    } else if (kind === "VP8L" && out.width === null) {
      const bits = view.getUint32(body + 1, true);
      out.width = (bits & 0x3fff) + 1;
      out.height = ((bits >>> 14) & 0x3fff) + 1;
    }
    pos = body + size + (size & 1);
  }
  out.frameCount = frames || 1;
  if (totalMs) out.duration = totalMs / 1000;
}
