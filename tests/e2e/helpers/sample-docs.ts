import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

const CACHE_DIR = path.join(os.tmpdir(), 'itarang-e2e-fixtures');
fs.mkdirSync(CACHE_DIR, { recursive: true });

// Public-domain sources. If any go down, fetchOrFallback writes a tiny inline
// PDF/PNG so the upload still succeeds.
const SOURCES: Record<string, string> = {
  'sample-doc.pdf': 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
  'sample-photo.png': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/120px-PNG_transparency_demonstration_1.png',
};

// 70-byte minimal valid PDF — used as a fallback if downloads fail.
const FALLBACK_PDF = Buffer.from(
  '255044462D312E0A25C2A50A312030206F626A0A3C3C3E3E0A656E646F626A0A747261696C65720A3C3C2F526F6F7420312030205220>>0A2525454F46',
  'hex',
);

// 100×100 solid-colour PNG (~440 bytes) — generated programmatically so we
// don't ship a binary. Some prod upload validators reject suspiciously small
// images (the previous 70-byte 1×1 fallback got bounced).
const FALLBACK_PNG: Buffer = (() => {
  // Minimal hand-rolled PNG with one IDAT chunk containing a deflated 100×100
  // image of solid mid-grey. We use zlib synchronously to keep the module
  // load order clean.
  const zlib = require('node:zlib') as typeof import('node:zlib');
  const W = 100, H = 100;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    raw[row] = 0; // filter byte: None
    for (let x = 0; x < W; x++) {
      const off = row + 1 + x * 3;
      raw[off] = 0xCC;
      raw[off + 1] = 0xCC;
      raw[off + 2] = 0xCC;
    }
  }
  const idat = zlib.deflateSync(raw);

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  function crc32(buf: Buffer): number {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return c ^ 0xFFFFFFFF;
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
})();

function download(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          download(res.headers.location, destPath).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', (err) => {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        reject(err);
      });
  });
}

async function fetchOrFallback(name: string, fallback: Buffer): Promise<string> {
  const dest = path.join(CACHE_DIR, name);
  // Treat anything under 200 bytes as a stale fallback from before the
  // larger-PNG fix and re-fetch. Real PDFs and PNGs are always larger.
  if (fs.existsSync(dest) && fs.statSync(dest).size > 200) return dest;
  const url = SOURCES[name];
  if (url) {
    try {
      await download(url, dest);
      if (fs.statSync(dest).size > 0) return dest;
    } catch (err) {
      console.warn(`[sample-docs] download failed for ${name}: ${(err as Error).message} — using fallback`);
    }
  }
  fs.writeFileSync(dest, fallback);
  return dest;
}

export async function getSamplePdf(suffix = 'doc'): Promise<string> {
  const dest = path.join(CACHE_DIR, `sample-${suffix}.pdf`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const source = await fetchOrFallback('sample-doc.pdf', FALLBACK_PDF);
  fs.copyFileSync(source, dest);
  return dest;
}

export async function getSamplePng(suffix = 'photo'): Promise<string> {
  const dest = path.join(CACHE_DIR, `sample-${suffix}.png`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const source = await fetchOrFallback('sample-photo.png', FALLBACK_PNG);
  fs.copyFileSync(source, dest);
  return dest;
}

export async function preloadAllSamples(): Promise<{ pdfs: Record<string, string>; pngs: Record<string, string> }> {
  const [itr, bank, cheques, udyam, gst, panFile, photo, ownerPhoto] = await Promise.all([
    getSamplePdf('itr'),
    getSamplePdf('bank-statement'),
    getSamplePdf('undated-cheques'),
    getSamplePdf('udyam'),
    getSamplePdf('gst-cert'),
    getSamplePdf('pan-card'),
    getSamplePng('passport-photo'),
    getSamplePng('owner-photo'),
  ]);
  return {
    pdfs: { itr, bank, cheques, udyam, gst, panFile },
    pngs: { photo, ownerPhoto },
  };
}
