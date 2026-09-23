/** A growable byte buffer with LEB128 varints and length-prefixed strings. */
export class ByteWriter {
  private buffer = new Uint8Array(256);
  private length = 0;

  private reserve(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  u8(value: number): void {
    this.reserve(1);
    this.buffer[this.length++] = value & 0xff;
  }

  u32(value: number): void {
    this.reserve(4);
    const v = value >>> 0;
    this.buffer[this.length++] = v & 0xff;
    this.buffer[this.length++] = (v >>> 8) & 0xff;
    this.buffer[this.length++] = (v >>> 16) & 0xff;
    this.buffer[this.length++] = (v >>> 24) & 0xff;
  }

  varint(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(`varint out of range: ${value}`);
    }
    let v = value;
    while (v >= 0x80) {
      this.u8((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.u8(v);
  }

  bytes(data: Uint8Array): void {
    this.reserve(data.length);
    this.buffer.set(data, this.length);
    this.length += data.length;
  }

  string(value: string): void {
    const encoded = encodeUtf8(value);
    this.varint(encoded.length);
    this.bytes(encoded);
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

export class ByteReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.data.length;
  }

  u8(): number {
    if (this.offset >= this.data.length) throw new Error("Unexpected end of data.");
    return this.data[this.offset++]!;
  }

  u32(): number {
    const a = this.u8();
    const b = this.u8();
    const c = this.u8();
    const d = this.u8();
    return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
  }

  varint(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new Error("Malformed varint.");
  }

  bytes(length: number): Uint8Array {
    if (this.offset + length > this.data.length) throw new Error("Unexpected end of data.");
    const out = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  string(): string {
    return decodeUtf8(this.bytes(this.varint()));
  }
}

// UTF-8 and base64 are written out here rather than taken from TextEncoder,
// btoa and atob. Those are host globals, not part of the language, and core
// has to run anywhere.

export function encodeUtf8(value: string): Uint8Array {
  const out: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

export function decodeUtf8(data: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < data.length) {
    const a = data[i++]!;
    let code: number;
    if (a < 0x80) {
      code = a;
    } else if (a >= 0xf0) {
      code = ((a & 0x07) << 18) | ((data[i++]! & 0x3f) << 12) | ((data[i++]! & 0x3f) << 6) | (data[i++]! & 0x3f);
    } else if (a >= 0xe0) {
      code = ((a & 0x0f) << 12) | ((data[i++]! & 0x3f) << 6) | (data[i++]! & 0x3f);
    } else {
      code = ((a & 0x1f) << 6) | (data[i++]! & 0x3f);
    }
    out += String.fromCodePoint(code);
  }
  return out;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = new Map<string, number>([...BASE64].map((c, i) => [c, i]));

export function toBase64(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i]!;
    const b = data[i + 1];
    const c = data[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!;
    out += b === undefined ? "=" : BASE64[(n >> 6) & 63]!;
    out += c === undefined ? "=" : BASE64[n & 63]!;
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const values = [0, 1, 2, 3].map((k) => {
      const ch = clean[i + k];
      if (ch === undefined) return 0;
      const v = BASE64_LOOKUP.get(ch);
      if (v === undefined) throw new Error("Invalid base64 data.");
      return v;
    });
    const n = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}
