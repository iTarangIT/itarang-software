/**
 * journey-recorder — Phase 2 NBFC journey instrumentation.
 *
 * Wraps a Playwright `page` so each labelled step records:
 *   • console.error / console.warn events emitted during the step
 *   • any 4xx / 5xx HTTP response observed during the step
 *   • a screenshot at end-of-step
 *   • a per-step Playwright trace fragment (delegated to test.use trace setting)
 *
 * Events are appended as one JSON object per line to the path given by
 * NBFC_E2E_RAW_JSONL (set by scripts/run_e2e_journey.sh).
 *
 * The recorder is intentionally state-light. It does NOT throw on captured
 * errors — the test body decides whether to assert. This way a step can
 * record a non-fatal warning and still move on.
 */
import { Page, Response, ConsoleMessage, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Kind = 'response_error' | 'console_error' | 'db_snapshot_mismatch' | 'step_failure';

type Event = {
  kind: Kind;
  step: string;
  ts: string;
  url?: string;
  status?: number;
  body?: string;
  message?: string;
  diff?: string;
  units?: string[];
};

function rawPath(): string {
  const p = process.env.NBFC_E2E_RAW_JSONL;
  if (!p) {
    // Fall back to a per-process path inside the project so tests still work
    // when run ad-hoc from VSCode / playwright UI mode.
    const dir = path.resolve(process.cwd(), 'docs/nbfc/_convergence');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `iter_adhoc_${process.pid}.e2e.raw.jsonl`);
  }
  return p;
}

function appendEvent(ev: Event) {
  try {
    fs.appendFileSync(rawPath(), JSON.stringify(ev) + '\n', { encoding: 'utf8' });
  } catch {
    // Never let recorder I/O take the test down.
  }
}

export type RecorderHandle = {
  /** Wrap an async block; captures all errors & non-2xx responses observed during it. */
  step: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /** Record a DB-snapshot mismatch attributable to one or more unit_ids. */
  dbMismatch: (label: string, units: string[], diff: string) => void;
  /** Wait for and assert a response was successful — appended-on-failure. */
  expectResponseOk: (resp: Promise<Response> | Response, label: string) => Promise<void>;
};

export function attachRecorder(page: Page): RecorderHandle {
  let currentStep = '';

  page.on('console', (msg: ConsoleMessage) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') {
      const text = msg.text();
      // De-noise: skip Next.js dev-only HMR warnings.
      if (/HMR|Fast Refresh|Webpack/i.test(text)) return;
      appendEvent({
        kind: 'console_error',
        step: currentStep,
        ts: new Date().toISOString(),
        url: page.url(),
        message: `[${t}] ${text}`,
      });
    }
  });

  page.on('response', async (resp: Response) => {
    const status = resp.status();
    if (status < 400) return;
    let body = '';
    try { body = (await resp.text()).slice(0, 2000); } catch {}
    appendEvent({
      kind: 'response_error',
      step: currentStep,
      ts: new Date().toISOString(),
      url: resp.url(),
      status,
      body,
    });
  });

  return {
    async step<T>(label: string, fn: () => Promise<T>): Promise<T> {
      currentStep = label;
      const ts = new Date().toISOString();
      try {
        const out = await fn();
        // Best-effort screenshot at end of step. Folder set by run script.
        const traceDir = process.env.NBFC_E2E_TRACE_DIR;
        if (traceDir) {
          const safe = label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
          try { await page.screenshot({ path: path.join(traceDir, `${safe}.png`), fullPage: true, timeout: 5000 }); } catch {}
        }
        return out;
      } catch (err) {
        appendEvent({
          kind: 'step_failure',
          step: label,
          ts,
          url: page.url(),
          message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
        throw err;
      } finally {
        currentStep = '';
      }
    },

    dbMismatch(label, units, diff) {
      appendEvent({
        kind: 'db_snapshot_mismatch',
        step: label,
        ts: new Date().toISOString(),
        units,
        diff,
      });
    },

    async expectResponseOk(respOrPromise, label) {
      const resp = await Promise.resolve(respOrPromise);
      const status = resp.status();
      if (status >= 400) {
        let body = '';
        try { body = (await resp.text()).slice(0, 2000); } catch {}
        appendEvent({
          kind: 'response_error',
          step: label,
          ts: new Date().toISOString(),
          url: resp.url(),
          status,
          body,
        });
        // Surface as test failure too — recorder records, expect() throws.
        expect(status, `${label}: expected 2xx, got ${status} from ${resp.url()}`).toBeLessThan(400);
      }
    },
  };
}

/**
 * Cheap in-memory persona registry loader for journey specs that need to look
 * up storage-state paths or emails by persona_id without re-reading disk.
 */
export function loadPersonas(): Record<string, { persona_id: string; email: string; role: string; storage_state_path: string }> {
  const root = process.cwd();
  const p = path.join(root, 'docs/nbfc/personas.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const out: Record<string, any> = {};
  const arr: any[] = Array.isArray(raw) ? raw : raw.personas || [];
  for (const r of arr) out[r.persona_id] = r;
  return out;
}
