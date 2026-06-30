// Shared [start, end) date-window resolver for CEO dashboard drill-downs.
//   ?month=YYYY-MM  → that calendar month
//   ?period=fy      → financial year to date (India FY starts 1 April), open-ended
//   default / mtd   → current calendar month
// Returns local date strings (YYYY-MM-DD); endStr is null for the open-ended FY.

export function resolveWindow(
    month: string | null,
    period: string | null,
): { startStr: string; endStr: string | null } {
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const curYear = now.getFullYear();
    const curMonth = now.getMonth();

    const monthMatch = month?.match(/^(\d{4})-(\d{2})$/);
    if (monthMatch) {
        const y = Number(monthMatch[1]);
        const mo = Number(monthMatch[2]);
        const ey = mo === 12 ? y + 1 : y;
        const em = mo === 12 ? 1 : mo + 1;
        return { startStr: `${y}-${pad2(mo)}-01`, endStr: `${ey}-${pad2(em)}-01` };
    }
    if ((period || "mtd") === "fy") {
        const fyStartYear = curMonth >= 3 ? curYear : curYear - 1;
        return { startStr: `${fyStartYear}-04-01`, endStr: null };
    }
    const ey = curMonth === 11 ? curYear + 1 : curYear;
    const em = curMonth === 11 ? 1 : curMonth + 2;
    return {
        startStr: `${curYear}-${pad2(curMonth + 1)}-01`,
        endStr: `${ey}-${pad2(em)}-01`,
    };
}
