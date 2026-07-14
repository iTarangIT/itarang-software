/**
 * Perceptual hashing for battery photos (M03).
 *
 *   AC: "duplicate phash across dealers raises a flag."
 *
 * WHY A PERCEPTUAL HASH AND NOT A CHECKSUM: an MD5 changes completely if a single
 * pixel changes, so re-saving a JPEG, cropping a border or shrinking it defeats
 * it entirely. Someone selling the same battery to us twice will not upload a
 * byte-identical file. A perceptual hash survives re-compression, resizing and
 * minor colour shifts, because it describes what the image LOOKS like.
 *
 * The algorithm is dHash (difference hash): shrink to 9×8 greyscale, then emit one
 * bit per adjacent horizontal pixel pair — 1 if the left pixel is brighter than
 * the right. 64 bits, hex-encoded. It is deliberately simple: it compares the
 * GRADIENT between neighbouring pixels rather than absolute brightness, so it is
 * unbothered by exposure and white-balance differences between two phones
 * photographing the same battery.
 *
 * Uses `sharp`, already a dependency. No new library.
 *
 * NOT CRYPTOGRAPHIC. Two different images CAN collide, which is exactly why a
 * match raises a FLAG for a human rather than rejecting the upload. The cost of a
 * false positive is an admin glancing at two photos; the cost of a false negative
 * is paying twice for one battery.
 */

import sharp from "sharp";

/** Hamming distance under which two hashes are "the same picture". */
export const DUPLICATE_THRESHOLD = 6;

/**
 * dHash of an image buffer → 16 hex chars (64 bits), or null if the bytes are not
 * a decodable image.
 *
 * Returns null rather than throwing: a corrupt upload must not take down the
 * nightly sweep for every other photo.
 */
export async function computePhash(image: Buffer): Promise<string | null> {
  try {
    // 9 wide × 8 tall → 8 comparisons per row × 8 rows = 64 bits.
    const { data } = await sharp(image)
      .greyscale()
      .resize(9, 8, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let bits = "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = data[row * 9 + col];
        const right = data[row * 9 + col + 1];
        bits += left > right ? "1" : "0";
      }
    }

    // 64 bits → 16 hex chars.
    let hex = "";
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}

/**
 * How many bits differ between two hashes.
 *
 * 0 = the same image. Under ~6 = the same photo, re-saved or lightly edited.
 * Over ~20 = unrelated pictures.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;

  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    // XOR the nibbles and count the set bits.
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

export function isDuplicate(a: string, b: string, threshold = DUPLICATE_THRESHOLD): boolean {
  return hammingDistance(a, b) <= threshold;
}
