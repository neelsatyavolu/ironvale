// Browser side of map-export: sends finished files to the Vite dev server, which writes
// them under the output directory chosen by run.mjs (see the writer plugin there).

/** Writes `data` to `<out>/<path>` through the export server. */
export async function writeFile(path: string, data: ArrayBuffer | Uint8Array | string): Promise<void> {
  const body = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const response = await fetch(`/__map-export/write?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    body: body as BodyInit,
    headers: { 'content-type': 'application/octet-stream' },
  });
  if (!response.ok) throw new Error(`write ${path} failed: ${response.status} ${await response.text()}`);
}

/** Canonical JSON: two-space indent, trailing newline, so committed files diff cleanly. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Growable little-endian byte writer. */
export class ByteWriter {
  private buffer = new ArrayBuffer(1 << 16);
  private view = new DataView(this.buffer);
  private bytes = new Uint8Array(this.buffer);
  length = 0;

  private reserve(extra: number): void {
    if (this.length + extra <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength;
    while (size < this.length + extra) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  ascii(text: string): void {
    this.reserve(text.length);
    for (let i = 0; i < text.length; i++) this.bytes[this.length++] = text.charCodeAt(i) & 0xff;
  }

  u8(value: number): void {
    this.reserve(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  u32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  f32(value: number): void {
    this.reserve(4);
    this.view.setFloat32(this.length, value, true);
    this.length += 4;
  }

  f64(value: number): void {
    this.reserve(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  /** Pads with zero bytes to a multiple of `alignment`. */
  align(alignment: number): void {
    while (this.length % alignment !== 0) this.u8(0);
  }

  raw(data: ArrayBufferView): void {
    const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.reserve(src.length);
    this.bytes.set(src, this.length);
    this.length += src.length;
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
