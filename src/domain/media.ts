import zlib from 'node:zlib';

const MAX_MEDIA_BYTES = 2_000_000;

export function detectImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length === 0 || buf.length > MAX_MEDIA_BYTES) return null;
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(png)) return { mime: 'image/png', ext: 'png' };
  const gif = buf.length >= 6 ? buf.subarray(0, 6).toString('ascii') : '';
  if (gif === 'GIF87a' || gif === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

export function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const index = row + 1 + x * 4;
      raw[index] = rgba[0];
      raw[index + 1] = rgba[1];
      raw[index + 2] = rgba[2];
      raw[index + 3] = rgba[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function safeDisplayName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'upload';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
  return cleaned || 'upload';
}
