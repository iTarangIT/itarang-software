import path from "path";
import { createWorker, type Worker } from "tesseract.js";
import sharp from "sharp";

let workerPromise: Promise<Worker> | null = null;

// Simple semaphore/queue to avoid concurrent recognize() calls on same worker
let isBusy = false;
const queue: Array<() => void> = [];

async function acquireWorker(): Promise<void> {
    if (!isBusy) {
        isBusy = true;
        return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
}

function releaseWorker(): void {
    const next = queue.shift();
    if (next) next();
    else isBusy = false;
}

/**
 * Create + initialize a singleton worker for Tesseract.js v7
 * Note: In v5+, createWorker() accepts languages and handles loading/initialization.
 */
async function getWorker(): Promise<Worker> {
    if (workerPromise) return workerPromise;

    workerPromise = (async () => {
        const workerPath = path.join(process.cwd(), "node_modules", "tesseract.js", "src", "worker-script", "node", "index.js");

        // In v7, languages are passed directly to createWorker to handle load/init
        const worker = await createWorker("eng", 1, {
            workerPath
        });
        return worker;
    })();

    // If initialization fails once, allow future retries
    workerPromise.catch(() => {
        workerPromise = null;
    });

    return workerPromise;
}

async function preprocessImage(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
        .grayscale()
        .resize({ width: 2000, withoutEnlargement: true, fit: "inside" })
        .toBuffer();
}

function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Operation'): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
        promise.then(
            val => { clearTimeout(timer); resolve(val); },
            err => { clearTimeout(timer); reject(err); }
        );
    });
}

export async function extractTextFromImageBuffer(buffer: Buffer): Promise<string> {
    await acquireWorker();
    try {
        const processed = await preprocessImage(buffer);
        const worker = await withTimeout(getWorker(), 10000, 'Worker initialization');
        const result = await withTimeout(worker.recognize(processed), 15000, 'OCR processing');
        return result?.data?.text ?? "";
    } finally {
        releaseWorker();
    }
}
