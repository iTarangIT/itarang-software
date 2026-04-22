// Tier-2 OCR fallback for the dealer Aadhaar auto-fill flow.
//
// Decentro is the primary provider. This module runs only when Decentro
// has already failed or returned unusable data; it uses Tesseract.js +
// strict validators to salvage what it can. The validators are tuned
// to err on the side of returning *nothing* rather than returning a
// garbage value that gets auto-filled into the dealer's form — "Lod"
// or "Rrarsh Fw" was the exact failure mode before this pass.
//
// Two-pass preprocessing, chosen per side:
//
//   Back  — right-half crop FIRST (Aadhaar backs always put Devanagari
//           on the left and English on the right; cropping the photo
//           out of the input is what gives Tesseract a clean column).
//           Full-image fallback only if crop yields < 2 validated
//           fields (handles pre-cropped uploads).
//   Front — full image FIRST (the photo and the English name live on
//           different rows, not columns, so cropping loses content).
//           Center crop fallback only if primary yields nothing.
//
// The orchestrator also enforces a confidence gate: if fewer than two
// fields pass validation across both sides, we return empty objects
// and the route surfaces the "couldn't read this Aadhaar" error
// instead of filling a single-field form with unverifiable data.

import sharp from "sharp";
import type { Buffer as NodeBuffer } from "node:buffer";
import { extractTextFromImageBuffer } from "./tesseractOcr";
import { parseAadhaarText, type AadhaarParsed } from "./aadhaarParser";
import {
    validateFullName,
    validateFatherName,
    validateDob,
    validateAddress,
    validateAadhaarNumber,
    validateGender,
} from "./aadhaarFieldValidators";

export type FallbackFields = AadhaarParsed;

// Keep ASCII letters/digits and the punctuation that matters for Aadhaar
// address lines. Strip every other code point — this is what removes
// the Devanagari / Marathi glyphs that Tesseract (English-only) would
// otherwise render as noise. Lines shorter than 3 chars are dropped.
function stripNonAscii(text: string): string {
    return text
        .split("\n")
        .map((line) =>
            line
                .replace(/[^A-Za-z0-9 ,.\-/:()]/g, "")
                .replace(/\s+/g, " ")
                .trim(),
        )
        .filter((line) => line.length >= 3)
        .join("\n");
}

// Grayscale + auto-contrast + resize to 2000px wide (no upscale). The
// normalise() call is the single most effective preprocessing step for
// underexposed phone photos — Tesseract's threshold pass does much
// better work on a stretched histogram.
async function preprocessFull(buffer: NodeBuffer): Promise<NodeBuffer> {
    return sharp(buffer)
        .grayscale()
        .normalise()
        .resize({ width: 2000, withoutEnlargement: true, fit: "inside" })
        .toBuffer();
}

async function preprocessRightCrop(buffer: NodeBuffer): Promise<NodeBuffer> {
    const meta = await sharp(buffer).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 200 || height < 100) return preprocessFull(buffer);
    const left = Math.round(width * 0.45);
    const cropWidth = Math.round(width * 0.55);
    return sharp(buffer)
        .extract({ left, top: 0, width: cropWidth, height })
        .grayscale()
        .normalise()
        .resize({ width: 2000, withoutEnlargement: true, fit: "inside" })
        .toBuffer();
}

// Front-specific: drop the photo area (roughly the leftmost 28% of the
// card), keep the rest. The photo is printed at a fixed location on
// every Aadhaar front and blocks Tesseract's row reconstruction.
async function preprocessFrontPhotoCrop(buffer: NodeBuffer): Promise<NodeBuffer> {
    const meta = await sharp(buffer).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 200 || height < 100) return preprocessFull(buffer);
    const left = Math.round(width * 0.28);
    const cropWidth = width - left;
    return sharp(buffer)
        .extract({ left, top: 0, width: cropWidth, height })
        .grayscale()
        .normalise()
        .resize({ width: 2000, withoutEnlargement: true, fit: "inside" })
        .toBuffer();
}

function validateAll(parsed: AadhaarParsed): FallbackFields {
    return {
        fullName: validateFullName(parsed.fullName) || undefined,
        fatherName: validateFatherName(parsed.fatherName) || undefined,
        dob: validateDob(parsed.dob) || undefined,
        address: validateAddress(parsed.address) || undefined,
        aadhaarNumber: validateAadhaarNumber(parsed.aadhaarNumber) || undefined,
        gender: validateGender(parsed.gender) || undefined,
    };
}

function countFields(fields: FallbackFields): number {
    return Object.values(fields).filter((v) => !!v).length;
}

async function runOcrPass(
    buffer: NodeBuffer,
    preprocess: (b: NodeBuffer) => Promise<NodeBuffer>,
    label: string,
): Promise<FallbackFields> {
    try {
        const processed = await preprocess(buffer);
        const raw = await extractTextFromImageBuffer(processed);
        const cleaned = stripNonAscii(raw);
        const parsed = parseAadhaarText(cleaned);
        return validateAll(parsed);
    } catch (err) {
        console.warn(`[AadhaarFallback] ${label} threw:`, (err as Error)?.message);
        return {};
    }
}

function mergeFields(a: FallbackFields, b: FallbackFields): FallbackFields {
    return {
        fullName: a.fullName ?? b.fullName,
        fatherName: a.fatherName ?? b.fatherName,
        dob: a.dob ?? b.dob,
        address: a.address ?? b.address,
        aadhaarNumber: a.aadhaarNumber ?? b.aadhaarNumber,
        gender: a.gender ?? b.gender,
    };
}

async function ocrBack(buffer: NodeBuffer): Promise<FallbackFields> {
    // Back: right-half crop is the PRIMARY strategy. Always run it
    // first — the two-column Devanagari/English layout is universal,
    // and cropping gives Tesseract a clean English column to read.
    const cropResult = await runOcrPass(buffer, preprocessRightCrop, "back right-crop");
    if (countFields(cropResult) >= 2) return cropResult;

    // Backstop for pre-cropped uploads: run full image too, merge
    // anything new (but don't overwrite fields already found).
    const fullResult = await runOcrPass(buffer, preprocessFull, "back full");
    return mergeFields(cropResult, fullResult);
}

async function ocrFront(buffer: NodeBuffer): Promise<FallbackFields> {
    // Front: full image first. Name and DOB live in the center/right
    // area, often on their own rows, so full-image reads usually get
    // them cleanly after the per-character ASCII strip.
    const fullResult = await runOcrPass(buffer, preprocessFull, "front full");
    if (countFields(fullResult) >= 2) return fullResult;

    // Fallback: crop out the photo on the left (fixed location).
    const cropResult = await runOcrPass(buffer, preprocessFrontPhotoCrop, "front photo-crop");
    return mergeFields(fullResult, cropResult);
}

export async function extractWithTesseract({
    front,
    back,
}: {
    front: NodeBuffer;
    back: NodeBuffer;
}): Promise<{ front: FallbackFields; back: FallbackFields }> {
    // Sequential, not parallel — extractTextFromImageBuffer uses a
    // singleton Tesseract worker with an internal queue, so Promise.all
    // gains nothing but doubles peak memory on the VPS.
    const frontFields = await ocrFront(front);
    const backFields = await ocrBack(back);

    // Confidence gate: across both sides, require at least two
    // validated fields to emit anything. A lone "fullName" with no
    // DOB and no address is much more likely to be a false positive
    // (some OCR misread that happened to match the name regex) than
    // a genuine but-partial extraction.
    const total = countFields(frontFields) + countFields(backFields);
    if (total < 2) {
        console.warn(
            "[AadhaarFallback] Confidence gate tripped — only",
            total,
            "field(s) across both sides. Returning empty.",
        );
        return { front: {}, back: {} };
    }

    return { front: frontFields, back: backFields };
}
