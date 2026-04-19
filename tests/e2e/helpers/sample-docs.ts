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

// 1×1 transparent PNG — used as a fallback if downloads fail.
const FALLBACK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
  'base64',
);

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
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
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
