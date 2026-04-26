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

type ReporterOptions = { outputDir?: string };

type Row = {
  testId: string;
  file: string;
  title: string;
  project: string;
  feature: string;
  scenario: string;
  tags: string;
  status: string;
  durationSec: number;
  error: string;
  steps: string;
  reason: string;
  timestamp: string;
  runEnv: 'sandbox' | 'prod';
  consoleErrors: string;
  networkErrors: string;
};

type SweepAttachment = {
  url: string;
  tag: string;
  totalDiscovered: number;
  clicked: { name: string; postClickUrl: string }[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; error: string }[];
  consoleErrors: string[];
  pageErrors: string[];
  networkErrors: { url: string; status: number }[];
};

const FEATURE_TOKENS = [
  'onboarding',
  'lead-creation',
  'kyc-review',
  'login',
  'dealer-verification',
  'button-sweep',
  'other',
];
const STATUS_COLORS: Record<string, string> = {
  Passed: 'FFC6EFCE',
  Failed: 'FFFFC7CE',
  'Timed Out': 'FFFFC7CE',
  'Skipped — Not Implemented': 'FFFFEB9C',
  'Skipped — Other': 'FFD9D9D9',
  Flaky: 'FFFCE4D6',
};

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

function extractTags(title: string): string[] {
  return Array.from(title.matchAll(/\[([a-z0-9-]+)\]/gi)).map((m) => m[1]);
}

function featureFromTags(tags: string[]): string {
  const match = tags.find((t) => FEATURE_TOKENS.includes(t));
  return match ?? 'other';
}

function scenarioFromTitle(title: string): string {
  return title.replace(/\s*\[[a-z0-9-]+\]/gi, '').trim();
}

function firstLine(msg: string, max = 240): string {
  const one = stripAnsi(msg).split('\n')[0] ?? '';
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function timestampForFilename(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

class ExcelReporter implements Reporter {
  private outputDir: string;
  private runStart!: Date;
  private baseURL = '';
  private rows = new Map<string, Row>();
  // retry handling — keep every attempt keyed by test id
  private attempts = new Map<string, TestResult[]>();
  // sweep attachments collected across the run, keyed by test id
  private sweepResults = new Map<string, SweepAttachment>();

  constructor(options: ReporterOptions = {}) {
    // Default to eval-reports/ so Playwright's test-results cleanup doesn't
    // delete the xlsx on the next run. Playwright only wipes test-results/.
    this.outputDir = options.outputDir ?? 'eval-reports';
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.runStart = new Date();
    const firstProject = config.projects[0];
    this.baseURL = (firstProject?.use?.baseURL as string) ?? '';

    // Pre-register every discovered test so skipped/filtered tests still appear.
    for (const test of suite.allTests()) {
      const row = this.buildRowShell(test);
      this.rows.set(test.id, row);
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.attempts.has(test.id)) this.attempts.set(test.id, []);
    this.attempts.get(test.id)!.push(result);

    // Pull sweep attachments off the result. The button-sweep helper attaches
    // a single JSON blob named 'sweep-result' per test.
    for (const att of result.attachments) {
      if (att.name !== 'sweep-result' || !att.body) continue;
      try {
        const parsed = JSON.parse(att.body.toString()) as SweepAttachment;
        this.sweepResults.set(test.id, parsed);
      } catch {
        // ignore malformed attachments — the row will still be present.
      }
    }
  }

  async onEnd(result: FullResult): Promise<void> {
    // Collapse retries → final attempt wins; if attempts disagreed, mark Flaky.
    for (const [testId, attempts] of this.attempts) {
      const row = this.rows.get(testId);
      if (!row) continue;
      const final = attempts[attempts.length - 1];
      this.populateRow(row, final);

      const statuses = new Set(attempts.map((a) => a.status));
      if (statuses.size > 1 && !statuses.has('skipped')) {
        row.status = 'Flaky';
      }
    }

    // Filter out "setup" project rows — they're infrastructure, not tests.
    const rows = [...this.rows.values()].filter(
      (r) => r.project !== 'setup',
    );

    rows.sort((a, b) => {
      if (a.feature !== b.feature) return a.feature.localeCompare(b.feature);
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.title.localeCompare(b.title);
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Playwright Excel Reporter';
    workbook.created = this.runStart;

    // Fold sweep attachments into row-level fields BEFORE writing sheets.
    for (const [testId, sweep] of this.sweepResults) {
      const row = this.rows.get(testId);
      if (!row) continue;
      const consoleLines = [...sweep.consoleErrors, ...sweep.pageErrors].slice(0, 5);
      if (consoleLines.length) row.consoleErrors = consoleLines.join('\n');
      const netLines = sweep.networkErrors
        .slice(0, 10)
        .map((n) => `${n.status} ${n.url}`);
      if (netLines.length) row.networkErrors = netLines.join('\n');
      if (sweep.failed.length) {
        const failedNames = sweep.failed
          .map((f) => `${f.name}: ${f.error}`)
          .slice(0, 5)
          .join(' | ');
        row.error = row.error
          ? `${row.error} | Buttons failed: ${failedNames}`
          : `Buttons failed: ${failedNames}`;
      }
    }

    this.writeResultsSheet(workbook, rows);
    this.writeSummarySheet(workbook, rows, result);
    this.writeButtonSweepSheet(workbook);
    this.writeNotImplementedSheet(workbook, rows);

    fs.mkdirSync(this.outputDir, { recursive: true });
    const outPath =
      process.env.EXCEL_REPORT_OUTPUT ||
      path.join(
        this.outputDir,
        `eval-report-${timestampForFilename(this.runStart)}.xlsx`,
      );

    await workbook.xlsx.writeFile(outPath);
    // eslint-disable-next-line no-console
    console.log(`\n[excel-reporter] wrote ${rows.length} rows → ${outPath}`);
  }

  private buildRowShell(test: TestCase): Row {
    const title = test.titlePath().slice(2).join(' > ') || test.title;
    const tags = extractTags(title);
    const file = path.basename(test.location.file);
    return {
      testId: test.id,
      file,
      title,
      project: test.parent.project()?.name ?? '',
      feature: featureFromTags(tags),
      scenario: scenarioFromTitle(title),
      tags: tags.length ? tags.map((t) => `[${t}]`).join(' ') : '',
      status: 'Skipped — Other', // default for tests that never ran
      durationSec: 0,
      error: '',
      steps: '',
      reason: '',
      timestamp: this.runStart.toISOString(),
      runEnv: this.detectEnv(),
      consoleErrors: '',
      networkErrors: '',
    };
  }

  private detectEnv(): 'sandbox' | 'prod' {
    return /crm\.itarang\.com/i.test(this.baseURL) ? 'prod' : 'sandbox';
  }

  private populateRow(row: Row, result: TestResult): void {
    row.durationSec = Number((result.duration / 1000).toFixed(2));

    const stepTitles = result.steps
      .filter((s) => s.category === 'test.step')
      .map((s) => s.title);
    row.steps =
      stepTitles.length > 0
        ? (stepTitles.join(' → ').slice(0, 500))
        : '';

    if (result.error) {
      row.error = firstLine(
        result.error.message ?? result.error.value ?? '',
        240,
      );
    }

    switch (result.status) {
      case 'passed':
        row.status = 'Passed';
        break;
      case 'failed':
        row.status = 'Failed';
        break;
      case 'timedOut':
        row.status = 'Timed Out';
        break;
      case 'skipped': {
        // Playwright surfaces test.skip(true, 'reason') via test annotations
        // accessible through result.errors — but the cleanest source is the
        // test.expectedStatus annotation list on TestCase, not on TestResult.
        // We approximate by scanning the error message and any annotation text.
        const reasonCandidates = [
          ...(result.errors?.map((e) => e.message || '') ?? []),
          ...(result.annotations ?? []).map((a) => a.description || ''),
        ];
        const reason = reasonCandidates.find((r) =>
          r.includes('NOT_IMPLEMENTED:'),
        );
        if (reason) {
          row.status = 'Skipped — Not Implemented';
          row.reason = reason.replace(/^.*?NOT_IMPLEMENTED:\s*/, '').trim();
        } else {
          row.status = 'Skipped — Other';
          row.reason = reasonCandidates[0]?.trim() ?? '';
        }
        break;
      }
      default:
        row.status = 'Skipped — Other';
    }
  }

  private writeResultsSheet(wb: ExcelJS.Workbook, rows: Row[]): void {
    const ws = wb.addWorksheet('Results');
    ws.columns = [
      { header: 'Test ID', key: 'testId', width: 46 },
      { header: 'Env', key: 'env', width: 10 },
      { header: 'Feature', key: 'feature', width: 16 },
      { header: 'Scenario', key: 'scenario', width: 48 },
      { header: 'Tags', key: 'tags', width: 22 },
      { header: 'Status', key: 'status', width: 26 },
      { header: 'Duration (s)', key: 'duration', width: 12 },
      { header: 'Error', key: 'error', width: 60 },
      { header: 'Network Errors', key: 'networkErrors', width: 50 },
      { header: 'Console Errors', key: 'consoleErrors', width: 50 },
      { header: 'Steps', key: 'steps', width: 60 },
      { header: 'Reason / Note', key: 'reason', width: 40 },
      { header: 'Timestamp', key: 'timestamp', width: 22 },
      { header: 'Project', key: 'project', width: 14 },
    ];

    for (const r of rows) {
      ws.addRow({
        testId: `${r.file} > ${r.scenario}`,
        env: r.runEnv,
        feature: r.feature,
        scenario: r.scenario,
        tags: r.tags,
        status: r.status,
        duration: r.durationSec,
        error: r.error,
        networkErrors: r.networkErrors,
        consoleErrors: r.consoleErrors,
        steps: r.steps,
        reason: r.reason,
        timestamp: r.timestamp,
        project: r.project,
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
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: ws.columnCount },
    };

    // Column order is now: Test ID(1) Env(2) Feature(3) Scenario(4) Tags(5)
    // Status(6) Duration(7) Error(8) NetworkErrors(9) ConsoleErrors(10)
    // Steps(11) Reason(12) Timestamp(13) Project(14).
    const statusColIdx = 6;
    for (let i = 2; i <= ws.rowCount; i++) {
      const statusCell = ws.getRow(i).getCell(statusColIdx);
      const color = STATUS_COLORS[String(statusCell.value)];
      if (color) {
        statusCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: color },
        };
      }
      // Wrap the long-text columns so the report stays readable.
      for (const colIdx of [4, 8, 9, 10, 11, 12]) {
        ws.getRow(i).getCell(colIdx).alignment = { wrapText: true, vertical: 'top' };
      }
    }
  }

  private writeSummarySheet(
    wb: ExcelJS.Workbook,
    rows: Row[],
    result: FullResult,
  ): void {
    const ws = wb.addWorksheet('Summary');

    ws.mergeCells('A1:F1');
    ws.getCell('A1').value = 'iTarang E2E Evaluation Report';
    ws.getCell('A1').font = { bold: true, size: 16 };

    const pass = rows.filter((r) => r.status === 'Passed').length;
    const total = rows.length;
    const passRate = total > 0 ? (pass / total) * 100 : 0;
    const durationMs = Date.now() - this.runStart.getTime();

    ws.getCell('A3').value = 'Run timestamp';
    ws.getCell('B3').value = this.runStart.toISOString();
    ws.getCell('A4').value = 'Base URL';
    ws.getCell('B4').value = this.baseURL;
    ws.getCell('A5').value = 'Run env';
    ws.getCell('B5').value = this.detectEnv();
    ws.getCell('A6').value = 'Total duration (s)';
    ws.getCell('B6').value = Number((durationMs / 1000).toFixed(1));
    ws.getCell('A7').value = 'Pass rate';
    ws.getCell('B7').value = passRate / 100;
    ws.getCell('B7').numFmt = '0.00%';
    ws.getCell('A8').value = 'Overall Playwright status';
    ws.getCell('B8').value = result.status;

    // Button-sweep aggregate counters
    let totalSwept = 0;
    let totalFailed = 0;
    const pagesWithConsoleErrors = new Set<string>();
    for (const sweep of this.sweepResults.values()) {
      totalSwept += sweep.totalDiscovered;
      totalFailed += sweep.failed.length;
      if (sweep.consoleErrors.length || sweep.pageErrors.length) {
        pagesWithConsoleErrors.add(sweep.tag);
      }
    }
    ws.getCell('A9').value = 'Total buttons swept';
    ws.getCell('B9').value = totalSwept;
    ws.getCell('A10').value = 'Buttons failed';
    ws.getCell('B10').value = totalFailed;
    ws.getCell('A11').value = 'Pages with console errors';
    ws.getCell('B11').value = pagesWithConsoleErrors.size;

    for (const row of [3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      ws.getCell(`A${row}`).font = { bold: true };
    }

    const featureHeaderRow = 13;
    ws.getRow(featureHeaderRow).values = [
      'Feature',
      'Passed',
      'Failed',
      'Skipped — Not Implemented',
      'Skipped — Other',
      'Flaky',
      'Total',
    ];
    ws.getRow(featureHeaderRow).font = { bold: true };
    ws.getRow(featureHeaderRow).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F4E78' },
    };
    ws.getRow(featureHeaderRow).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    const features = Array.from(new Set(rows.map((r) => r.feature))).sort();
    let nextRow = featureHeaderRow + 1;
    const totals = { pass: 0, fail: 0, skipNI: 0, skipOther: 0, flaky: 0 };
    for (const feature of features) {
      const sub = rows.filter((r) => r.feature === feature);
      const p = sub.filter((r) => r.status === 'Passed').length;
      const f = sub.filter(
        (r) => r.status === 'Failed' || r.status === 'Timed Out',
      ).length;
      const ni = sub.filter(
        (r) => r.status === 'Skipped — Not Implemented',
      ).length;
      const so = sub.filter((r) => r.status === 'Skipped — Other').length;
      const fl = sub.filter((r) => r.status === 'Flaky').length;
      ws.getRow(nextRow).values = [feature, p, f, ni, so, fl, sub.length];
      nextRow++;
      totals.pass += p;
      totals.fail += f;
      totals.skipNI += ni;
      totals.skipOther += so;
      totals.flaky += fl;
    }
    ws.getRow(nextRow).values = [
      'TOTAL',
      totals.pass,
      totals.fail,
      totals.skipNI,
      totals.skipOther,
      totals.flaky,
      rows.length,
    ];
    ws.getRow(nextRow).font = { bold: true };

    ws.getColumn(1).width = 26;
    for (let c = 2; c <= 7; c++) ws.getColumn(c).width = 16;
  }

  private writeButtonSweepSheet(wb: ExcelJS.Workbook): void {
    if (this.sweepResults.size === 0) return;
    const ws = wb.addWorksheet('Button Sweep');
    ws.columns = [
      { header: 'Page', key: 'page', width: 32 },
      { header: 'Button', key: 'button', width: 36 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Reason / Error', key: 'reason', width: 50 },
      { header: 'Post-click URL', key: 'postUrl', width: 50 },
      { header: 'Console Errors', key: 'consoleErrors', width: 50 },
      { header: 'Network Errors', key: 'networkErrors', width: 50 },
    ];

    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    for (const sweep of this.sweepResults.values()) {
      const consoleAggregate = [...sweep.consoleErrors, ...sweep.pageErrors].slice(0, 5).join('\n');
      const networkAggregate = sweep.networkErrors
        .slice(0, 10)
        .map((n) => `${n.status} ${n.url}`)
        .join('\n');

      for (const c of sweep.clicked) {
        ws.addRow({
          page: sweep.tag,
          button: c.name,
          status: 'Clicked',
          reason: '',
          postUrl: c.postClickUrl,
          consoleErrors: consoleAggregate,
          networkErrors: networkAggregate,
        });
      }
      for (const s of sweep.skipped) {
        ws.addRow({
          page: sweep.tag,
          button: s.name,
          status: 'Skipped',
          reason: s.reason,
          postUrl: '',
          consoleErrors: '',
          networkErrors: '',
        });
      }
      for (const f of sweep.failed) {
        ws.addRow({
          page: sweep.tag,
          button: f.name,
          status: 'Failed',
          reason: f.error,
          postUrl: '',
          consoleErrors: consoleAggregate,
          networkErrors: networkAggregate,
        });
      }
    }

    const STATUS_FILL: Record<string, string> = {
      Clicked: 'FFC6EFCE',
      Skipped: 'FFD9D9D9',
      Failed: 'FFFFC7CE',
    };
    const statusColIdx = 3;
    for (let i = 2; i <= ws.rowCount; i++) {
      const statusCell = ws.getRow(i).getCell(statusColIdx);
      const fill = STATUS_FILL[String(statusCell.value)];
      if (fill) {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      }
      for (const colIdx of [4, 5, 6, 7]) {
        ws.getRow(i).getCell(colIdx).alignment = { wrapText: true, vertical: 'top' };
      }
    }

    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  }

  private writeNotImplementedSheet(wb: ExcelJS.Workbook, rows: Row[]): void {
    const ws = wb.addWorksheet('Not Implemented');
    ws.columns = [
      { header: 'Feature', key: 'feature', width: 16 },
      { header: 'Scenario', key: 'scenario', width: 60 },
      { header: 'Reason', key: 'reason', width: 50 },
      { header: 'Source Pointer', key: 'source', width: 50 },
    ];
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F4E78' },
    };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const ni = rows.filter((r) => r.status === 'Skipped — Not Implemented');
    for (const r of ni) {
      // Reason shape: "short description (path/to/file.ts)"
      const pathMatch = r.reason.match(/\(([^)]+)\)\s*$/);
      const source = pathMatch?.[1] ?? '';
      const humanReason = pathMatch ? r.reason.slice(0, pathMatch.index).trim() : r.reason;
      ws.addRow({
        feature: r.feature,
        scenario: r.scenario,
        reason: humanReason,
        source,
      });
    }
    for (let i = 2; i <= ws.rowCount; i++) {
      for (const col of [2, 3, 4]) {
        ws.getRow(i).getCell(col).alignment = { wrapText: true, vertical: 'top' };
      }
    }
  }
}

export default ExcelReporter;
