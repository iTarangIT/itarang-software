/**
 * Resume helpers for the full-BRD headed journey.
 *
 * Persists per-unit progress + cross-test `state` to a single JSON file so a
 * paused-on-failure run can be resumed mid-chain after Claude applies a fix.
 *
 *   RESUME_FROM=E-007:AC2  → tests numerically before E-007 are test.skip()'d;
 *                            inside E-007 the recorder begins at AC2.
 *   RESET_JOURNEY=1        → wipe progress + state at startup.
 *
 * The state shape mirrors the module-level `state` object in
 * _journey_full_brd.headed.spec.ts. We don't enforce a schema — anything JSON-
 * serialisable goes through.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROGRESS_PATH = path.resolve(process.cwd(), 'docs/nbfc/_convergence/_progress.json');

export type Progress = {
  last_completed_unit?: string;
  completed_units: string[];
  state: Record<string, any>;
  updated_at?: string;
};

function emptyProgress(): Progress {
  return { completed_units: [], state: {} };
}

export function loadProgress(): Progress {
  if (process.env.RESET_JOURNEY === '1') {
    try { fs.unlinkSync(PROGRESS_PATH); } catch {}
    return emptyProgress();
  }
  try {
    const raw = fs.readFileSync(PROGRESS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      last_completed_unit: parsed.last_completed_unit,
      completed_units: Array.isArray(parsed.completed_units) ? parsed.completed_units : [],
      state: parsed.state ?? {},
      updated_at: parsed.updated_at,
    };
  } catch {
    return emptyProgress();
  }
}

export function saveProgress(unitId: string, state: Record<string, any>): void {
  const cur = loadProgress();
  if (!cur.completed_units.includes(unitId)) cur.completed_units.push(unitId);
  cur.last_completed_unit = unitId;
  cur.state = { ...cur.state, ...state };
  cur.updated_at = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(cur, null, 2), { encoding: 'utf8' });
  } catch {
    // Don't take the test down on disk error.
  }
}

/** Numeric ordering for E-### ids so RESUME_FROM works without lexicographic surprises. */
function unitNum(id: string): number {
  const m = /^E-(\d+)/i.exec(id);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/** Should this whole unit be skipped because the resume cursor is past it? */
export function shouldSkipUnit(unitId: string): { skip: boolean; reason?: string } {
  const resume = process.env.RESUME_FROM;
  if (!resume) return { skip: false };
  const cursorUnit = resume.split(':')[0];
  if (unitNum(unitId) < unitNum(cursorUnit)) {
    return { skip: true, reason: `RESUME_FROM=${resume} — already past ${unitId}` };
  }
  return { skip: false };
}

/** Should this AC inside the resume-cursor unit be skipped? */
export function shouldSkipAc(unitId: string, acId: string): boolean {
  const resume = process.env.RESUME_FROM;
  if (!resume) return false;
  const [cursorUnit, cursorAc] = resume.split(':');
  if (unitId !== cursorUnit) return false;
  if (!cursorAc) return false;
  const acNum = (s: string) => {
    const m = /^AC(\d+)/i.exec(s);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  return acNum(acId) < acNum(cursorAc);
}
