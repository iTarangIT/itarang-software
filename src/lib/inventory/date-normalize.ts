// Inventory CSV/XLSX date normalizer.
//
// Excel rewrites date cells to the system locale on "Save As CSV" — so a value
// the admin typed as 2026-01-15 ends up as 15-01-2026 on en-IN machines, even
// when the source XLSX column was Text-formatted. We accept both shapes (and a
// few other common ones) here and emit canonical YYYY-MM-DD so the strict Zod
// regex downstream still validates.
//
// Indian locale assumption: when a string matches NN-NN-YYYY / NN/NN/YYYY we
// treat the first group as the day. That matches what Excel writes on en-IN
// and what users type by hand in this market.

const ISO_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const DMY_RE = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/;
const DMY_SHORT_RE = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/;

const pad = (n: number | string) => String(n).padStart(2, "0");

function isValidYMD(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function fromDate(d: Date): string {
  // Use local components — xlsx with cellDates returns a Date constructed at
  // local midnight, so toISOString() would shift to the previous day in IST.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromExcelSerial(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  // Excel epoch is 1899-12-30 (it has the 1900 leap-year bug baked in).
  const ms = Math.round(serial * 86400 * 1000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function normalizeDateCell(value: unknown): unknown {
  if (value == null || value === "") return value;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? value : fromDate(value);
  }

  if (typeof value === "number") {
    return fromExcelSerial(value) ?? value;
  }

  if (typeof value !== "string") return value;
  const s = value.trim();
  if (!s) return value;

  const iso = s.match(ISO_RE);
  if (iso) {
    const [, y, m, d] = iso;
    const yn = Number(y), mn = Number(m), dn = Number(d);
    return isValidYMD(yn, mn, dn) ? `${y}-${pad(m)}-${pad(d)}` : value;
  }

  const dmy = s.match(DMY_RE);
  if (dmy) {
    const [, d, m, y] = dmy;
    const yn = Number(y), mn = Number(m), dn = Number(d);
    return isValidYMD(yn, mn, dn) ? `${y}-${pad(m)}-${pad(d)}` : value;
  }

  const dmyShort = s.match(DMY_SHORT_RE);
  if (dmyShort) {
    const [, d, m, yy] = dmyShort;
    const yn = 2000 + Number(yy);
    const mn = Number(m), dn = Number(d);
    return isValidYMD(yn, mn, dn) ? `${yn}-${pad(m)}-${pad(d)}` : value;
  }

  return value;
}
