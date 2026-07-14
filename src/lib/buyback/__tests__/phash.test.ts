/**
 * M03 — the hash has to survive re-saving, or it catches nothing.
 *
 * Someone selling the same battery to two dealers will not upload a byte-
 * identical file: it will have been through WhatsApp, re-compressed, maybe
 * resized. A checksum would miss all of that. These tests exist to prove the
 * perceptual hash does not.
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { computePhash, hammingDistance, isDuplicate } from "../phash";

/** A deterministic "photo": a gradient with a couple of blobs, so it has structure. */
async function fakePhoto(seed: number, size = 400): Promise<Buffer> {
  const px = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const blob = Math.sin((x + seed * 40) / 30) * Math.cos((y + seed * 25) / 35);
      const v = Math.max(0, Math.min(255, Math.round(((x + y) / (2 * size)) * 200 + blob * 55)));
      px[i] = v;
      px[i + 1] = Math.max(0, Math.min(255, v - seed * 7));
      px[i + 2] = Math.max(0, Math.min(255, 255 - v));
    }
  }
  return sharp(px, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

describe("computePhash", () => {
  it("produces a 16-char (64-bit) hex hash", async () => {
    const h = await computePhash(await fakePhoto(1));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic — the same bytes give the same hash", async () => {
    const img = await fakePhoto(2);
    expect(await computePhash(img)).toBe(await computePhash(img));
  });

  it("returns null on bytes that are not an image, rather than throwing", async () => {
    // A corrupt upload must not take down the nightly sweep for every other photo.
    expect(await computePhash(Buffer.from("this is not a jpeg"))).toBeNull();
  });
});

describe("THE POINT — the hash survives what a real re-upload does to a photo", () => {
  it("survives JPEG re-compression", async () => {
    const original = await fakePhoto(3);
    const recompressed = await sharp(original).jpeg({ quality: 60 }).toBuffer();

    const a = (await computePhash(original))!;
    const b = (await computePhash(recompressed))!;

    expect(isDuplicate(a, b)).toBe(true);
  });

  it("survives being resized (WhatsApp shrinks everything)", async () => {
    const original = await fakePhoto(4, 400);
    const shrunk = await sharp(original).resize(160).jpeg({ quality: 70 }).toBuffer();

    const a = (await computePhash(original))!;
    const b = (await computePhash(shrunk))!;

    expect(isDuplicate(a, b)).toBe(true);
  });

  it("survives a brightness shift — two phones, same battery", async () => {
    const original = await fakePhoto(5);
    const brighter = await sharp(original).modulate({ brightness: 1.25 }).toBuffer();

    const a = (await computePhash(original))!;
    const b = (await computePhash(brighter))!;

    // dHash compares the GRADIENT between neighbouring pixels, not absolute
    // brightness — which is exactly why exposure differences do not defeat it.
    expect(isDuplicate(a, b)).toBe(true);
  });

  it("does NOT match two genuinely different photos", async () => {
    // The other half of the AC. A hash that flags everything is as useless as one
    // that flags nothing — every honest dealer would be accused of fraud.
    const a = (await computePhash(await fakePhoto(1)))!;
    const b = (await computePhash(await fakePhoto(9)))!;

    expect(isDuplicate(a, b)).toBe(false);
    expect(hammingDistance(a, b)).toBeGreaterThan(6);
  });
});

describe("hammingDistance", () => {
  it("is 0 for identical hashes", () => {
    expect(hammingDistance("f0e1d2c3b4a59687", "f0e1d2c3b4a59687")).toBe(0);
  });

  it("counts differing bits", () => {
    // 0x0 = 0000, 0x1 = 0001 → one bit.
    expect(hammingDistance("0000000000000000", "0000000000000001")).toBe(1);
    // 0xf = 1111 → four bits.
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4);
  });

  it("refuses to compare hashes of different lengths", () => {
    expect(hammingDistance("abcd", "abcdef")).toBe(Number.MAX_SAFE_INTEGER);
  });
});
