import fs from 'node:fs';
import path from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import ExcelJS from 'exceljs';

/**
 * Workflow report — the single, business-facing Excel deliverable.
 *
 * One sheet, six columns exactly as specified:
 *   Workflow/Module | Test Case Name | Status | Execution Time (s) |
 *   Error Message | Execution Date & Time
 *
 * Guarantees:
 *   - Written in onEnd(), which Playwright always calls even when tests fail,
 *     so a partial/failed run still produces the file.
 *   - Every discovered test is pre-registered in onBegin(), so tests that were
 *     filtered out or never ran still appear as "Skipped" rather than vanishing.
 *   - Output lands in reports/ (NOT test-results/, which Playwright wipes on the
 *     next run). Timestamped filename — never overwrites a prior run.
 *
 * This reporter is intentionally separate from the richer eval reporter
 * (reporters/excel-reporter.ts) so each can evolve independently.
 */

type ReporterOptions = { outputDir?: string };

type Row = {
  module: string;
  name: string;
  status: 'Pass' | 'Fail' | 'Skipped';
  durationSec: number;
  error: string;
  timestamp: string;
};

/** One "code-by-code" step, parsed from a `step-detail` attachment emitted by
 * the detailStep() helper in tests/e2e/flows/_flow-helpers.ts. */
type StepDetail = {
  description: string;
  expected: string;
  actual: string;
  status: 'Pass' | 'Fail';
  error: string;
  durationMs: number;
};

/** A step row joined to its owning test (module + clean test name). */
type StepRow = StepDetail & { module: string; test: string; index: number };

const STATUS_FILL: Record<Row['status'], string> = {
  Pass: 'FFC6EFCE',
  Fail: 'FFFFC7CE',
  Skipped: 'FFD9D9D9',
};

// Folder (first segment under tests/e2e/) → human module label. Falls back to a
// title-cased folder name for anything not listed here.
const FOLDER_MODULE: Record<string, string> = {
  coverage: 'Workflow Smoke',
  onboarding: 'Dealer Onboarding',
  leads: 'Lead Management',
  kyc: 'KYC Verification',
  nbfc: 'NBFC Portal',
  prod: 'Production',
  live: 'Live (paid)',
};

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[[0-9;]*m/g, '');
}

function firstLine(msg: string, max = 300): string {
  const one = stripAnsi(msg).split('\n')[0]?.trim() ?? '';
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Strip the bracketed [tag] tokens from a test title for a clean name. */
function cleanName(title: string): string {
  return title.replace(/\s*\[[a-z0-9-:]+\]/gi, '').trim() || title;
}

function timestampForFilename(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function titleCase(s: string): string {
  return s
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

class WorkflowReporter implements Reporter {
  private outputDir: string;
  private runStart = new Date(0);
  private rows = new Map<string, Row>();
  private attempts = new Map<string, TestResult[]>();
  // Ordered per-step detail parsed from `step-detail` attachments, keyed by test id.
  private steps = new Map<string, StepDetail[]>();

  constructor(options: ReporterOptions = {}) {
    this.outputDir = options.outputDir ?? 'reports';
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.runStart = new Date();
    for (const test of suite.allTests()) {
      this.rows.set(test.id, this.buildShell(test));
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.attempts.has(test.id)) this.attempts.set(test.id, []);
    this.attempts.get(test.id)!.push(result);

    // Collect the code-by-code step detail for the second worksheet. The final
    // attempt wins, so reset any detail from a prior (retried) attempt.
    const parsed: StepDetail[] = [];
    for (const att of result.attachments) {
      if (att.name !== 'step-detail' || !att.body) continue;
      try {
        parsed.push(JSON.parse(att.body.toString()) as StepDetail);
      } catch {
        // ignore a malformed attachment — the summary row is unaffected.
      }
    }
    if (parsed.length) this.steps.set(test.id, parsed);
  }

  async onEnd(_result: FullResult): Promise<void> {
    for (const [testId, attempts] of this.attempts) {
      const row = this.rows.get(testId);
      if (!row) continue;
      // Final attempt wins (retries collapse to the last outcome).
      this.populate(row, attempts[attempts.length - 1]);
    }

    // Drop the "setup" project rows — auth infrastructure, not workflows.
    const rows = [...this.rows.values()].filter((r) => r.module !== '__setup__');
    rows.sort((a, b) =>
      a.module !== b.module
        ? a.module.localeCompare(b.module)
        : a.name.localeCompare(b.name),
    );

    // Build the per-step rows for the "Detailed Steps" sheet, joined to their
    // owning test's module + clean name (from the pre-registered shell).
    const stepRows: StepRow[] = [];
    for (const [testId, details] of this.steps) {
      const owner = this.rows.get(testId);
      if (!owner || owner.module === '__setup__') continue;
      details.forEach((d, i) => {
        stepRows.push({ ...d, module: owner.module, test: owner.name, index: i + 1 });
      });
    }
    stepRows.sort((a, b) =>
      a.module !== b.module
        ? a.module.localeCompare(b.module)
        : a.test !== b.test
          ? a.test.localeCompare(b.test)
          : a.index - b.index,
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = 'iTarang Workflow Reporter';
    wb.created = this.runStart;
    this.writeSheet(wb, rows);
    this.writeStepsSheet(wb, stepRows);

    fs.mkdirSync(this.outputDir, { recursive: true });
    const outPath =
      process.env.WORKFLOW_REPORT_OUTPUT ||
      path.join(
        this.outputDir,
        `crm-workflow-report-${timestampForFilename(this.runStart)}.xlsx`,
      );
    await wb.xlsx.writeFile(outPath);

    const pass = rows.filter((r) => r.status === 'Pass').length;
    const fail = rows.filter((r) => r.status === 'Fail').length;
    const skip = rows.filter((r) => r.status === 'Skipped').length;
    // eslint-disable-next-line no-console
    console.log(
      `\n[workflow-report] ${rows.length} tests, ${stepRows.length} detailed steps → ${outPath} ` +
        `(Pass ${pass} / Fail ${fail} / Skipped ${skip})`,
    );
  }

  private buildShell(test: TestCase): Row {
    return {
      module: this.moduleFor(test),
      name: cleanName(test.titlePath().slice(3).join(' › ') || test.title),
      status: 'Skipped', // default for a test that never runs
      durationSec: 0,
      error: '',
      timestamp: '',
    };
  }

  private moduleFor(test: TestCase): string {
    if (test.parent.project()?.name === 'setup') return '__setup__';

    // 1) explicit annotation: test.info().annotations.push({ type: 'module', ... })
    const ann = test.annotations.find((a) => a.type === 'module');
    if (ann?.description) return ann.description;

    // 2) [module:xxx] token embedded in the title
    const tokenMatch = test
      .titlePath()
      .join(' ')
      .match(/\[module:([a-z0-9 -]+)\]/i);
    if (tokenMatch) return titleCase(tokenMatch[1]);

    // 3) fall back to the first folder segment under tests/e2e/
    const rel = test.location.file.replace(/\\/g, '/');
    const m = rel.match(/tests\/e2e\/([^/]+)\//);
    const folder = m?.[1] ?? 'other';
    return FOLDER_MODULE[folder] ?? titleCase(folder);
  }

  private populate(row: Row, result: TestResult): void {
    row.durationSec = Number((result.duration / 1000).toFixed(2));
    row.timestamp = (result.startTime ?? this.runStart).toLocaleString();

    switch (result.status) {
      case 'passed':
        row.status = 'Pass';
        break;
      case 'failed':
      case 'timedOut':
      case 'interrupted':
        row.status = 'Fail';
        break;
      default:
        row.status = 'Skipped';
    }

    if (row.status === 'Fail' && result.error) {
      row.error = firstLine(result.error.message ?? result.error.value ?? '');
    } else if (row.status === 'Skipped') {
      // Surface the skip reason (e.g. NOT_IMPLEMENTED / missing auth) if present.
      const reason =
        result.errors?.map((e) => e.message).find(Boolean) ??
        result.annotations?.find((a) => a.type === 'skip')?.description ??
        '';
      row.error = firstLine(reason);
    }
  }

  private writeSheet(wb: ExcelJS.Workbook, rows: Row[]): void {
    const ws = wb.addWorksheet('Test Results');
    ws.columns = [
      { header: 'Workflow/Module', key: 'module', width: 24 },
      { header: 'Test Case Name', key: 'name', width: 66 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Execution Time (s)', key: 'duration', width: 18 },
      { header: 'Error Message', key: 'error', width: 70 },
      { header: 'Execution Date & Time', key: 'timestamp', width: 24 },
    ];

    for (const r of rows) {
      ws.addRow({
        module: r.module,
        name: r.name,
        status: r.status,
        duration: r.durationSec,
        error: r.error,
        timestamp: r.timestamp,
      });
    }

    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F4E78' },
    };
    header.height = 22;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };

    // Colour the Status cell and wrap the long text columns.
    for (let i = 2; i <= ws.rowCount; i++) {
      const statusCell = ws.getRow(i).getCell(3);
      const fill = STATUS_FILL[statusCell.value as Row['status']];
      if (fill) {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      }
      for (const col of [2, 5]) {
        ws.getRow(i).getCell(col).alignment = { wrapText: true, vertical: 'top' };
      }
    }
  }

  /**
   * Second worksheet: the "code-by-code" breakdown. One row per detailStep()
   * across every test — what was tested, what we expected, what we observed,
   * pass/fail, and per-step duration. Empty (header only) when no spec emits
   * step-detail attachments, so it never breaks a plain run.
   */
  private writeStepsSheet(wb: ExcelJS.Workbook, steps: StepRow[]): void {
    const ws = wb.addWorksheet('Detailed Steps');
    ws.columns = [
      { header: 'Workflow/Module', key: 'module', width: 24 },
      { header: 'Test Case', key: 'test', width: 48 },
      { header: 'Step #', key: 'index', width: 8 },
      { header: 'Step Description', key: 'description', width: 52 },
      { header: 'Expected', key: 'expected', width: 46 },
      { header: 'Actual', key: 'actual', width: 46 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Duration (s)', key: 'duration', width: 12 },
      { header: 'Error', key: 'error', width: 60 },
    ];

    for (const s of steps) {
      ws.addRow({
        module: s.module,
        test: s.test,
        index: s.index,
        description: s.description,
        expected: s.expected,
        actual: s.actual,
        status: s.status,
        duration: Number((s.durationMs / 1000).toFixed(2)),
        error: firstLine(s.error ?? ''),
      });
    }

    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    header.height = 22;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 9 } };

    // Colour the Status cell (Pass/Fail only here) and wrap the long columns.
    for (let i = 2; i <= ws.rowCount; i++) {
      const statusCell = ws.getRow(i).getCell(7);
      const fill = STATUS_FILL[statusCell.value as Row['status']];
      if (fill) {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      }
      for (const col of [4, 5, 6, 9]) {
        ws.getRow(i).getCell(col).alignment = { wrapText: true, vertical: 'top' };
      }
    }
  }
}

export default WorkflowReporter;
