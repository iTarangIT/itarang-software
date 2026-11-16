// AI dialer list item 6 — contact details a call learned, the pure half.
//
// The analyser (signals-2.5.0) reads the owner's name, the owner's own mobile
// and any other number the dealer asked us to call. Numbers are spoken, so
// they are checked here before anything is stored or dialled: a ten-digit
// Indian mobile (6–9 first digit, Devanagari digits allowed, +91 / 0 dropped),
// not a run of one digit, and not the number we dialled or the lead's own.
// I/O: contactStore.ts.

export type ContactKind = "owner_mobile" | "alternate";
export const CONTACT_KINDS: readonly ContactKind[] = ["owner_mobile", "alternate"];

export type CapturedContact = { kind: ContactKind; phone: string; name: string | null };

const DEVANAGARI_ZERO = 0x0966;

/** "+91 98110 22422", "०९८११०२२४२२" → "9811022422"; null unless a valid Indian mobile. */
export function normaliseIndianMobile(raw: string | null | undefined): string | null {
    const ascii = (raw ?? "").replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - DEVANAGARI_ZERO));
    let digits = ascii.replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    if (!/^[6-9]\d{9}$/.test(digits)) return null;
    if (/^(\d)\1{9}$/.test(digits)) return null; // 9999999999
    return digits;
}

function lastTen(raw: string | null | undefined): string | null {
    const d = (raw ?? "").replace(/\D/g, "");
    return d.length >= 10 ? d.slice(-10) : null;
}

/** The contacts worth keeping from one call's signals, owner mobile first. */
export function contactsFromSignals(
    signals: { owner_name?: string; owner_mobile?: string; alternate_number?: string } | null | undefined,
    own: { leadPhone?: string | null; dialledPhone?: string | null },
): CapturedContact[] {
    if (!signals) return [];
    const exclude = new Set([lastTen(own.leadPhone), lastTen(own.dialledPhone)].filter(Boolean) as string[]);
    const name = (signals.owner_name ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
    const out: CapturedContact[] = [];
    const owner = normaliseIndianMobile(signals.owner_mobile);
    if (owner && !exclude.has(owner)) {
        out.push({ kind: "owner_mobile", phone: owner, name });
        exclude.add(owner);
    }
    const alt = normaliseIndianMobile(signals.alternate_number);
    if (alt && !exclude.has(alt)) out.push({ kind: "alternate", phone: alt, name: null });
    return out;
}

/** The one to dial instead of a switchboard / landline main number: owner mobile first, newest first. */
export function pickDialableContact(
    contacts: ReadonlyArray<{ kind: ContactKind; phone: string; status: string; capturedAt: Date }>,
    blocked: ReadonlySet<string>,
): { kind: ContactKind; phone: string } | null {
    const rank = (k: ContactKind) => (k === "owner_mobile" ? 0 : 1);
    const ok = contacts
        .filter((c) => c.status === "active" && !blocked.has(c.phone))
        .sort((a, b) => rank(a.kind) - rank(b.kind) || b.capturedAt.getTime() - a.capturedAt.getTime());
    return ok[0] ? { kind: ok[0].kind, phone: ok[0].phone } : null;
}
