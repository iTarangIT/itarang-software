"use client";

/**
 * NbfcKycReviewPanel — sanchit-only KYC review surface.
 *
 * Two stacked panels: NBFC entity verifications (CIN/PAN/GSTIN) and
 * director KYC (PAN/Aadhaar/RC). Each row exposes a "Run verify" CTA, a
 * status pill, and a collapsible JSON card with the raw provider response
 * for the audit trail.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";

type EntityRow = {
  id: number;
  verification_type: "cin" | "pan" | "gstin";
  id_number: string;
  status: "pending" | "success" | "failed";
  raw_response: unknown;
  verified_at: string;
};

type DirectorRow = {
  id: number;
  full_name: string;
  email: string | null;
  phone: string | null;
  pan_number: string | null;
  aadhaar_last4: string | null;
  rc_number: string | null;
  kyc_status: string;
  verifications: Array<{
    id: number;
    verification_type: "pan" | "aadhaar" | "rc";
    status: "pending" | "success" | "failed";
    raw_response: unknown;
    verified_at: string;
  }>;
};

type PageData = {
  ok: true;
  nbfc: {
    id: number;
    legal_name: string;
    cin: string;
    pan_number: string;
    gst_number: string;
    status: string;
  };
  entityVerifications: EntityRow[];
  directors: DirectorRow[];
};

const ENTITY_LABEL: Record<EntityRow["verification_type"], string> = {
  cin: "CIN — Corporate Identification Number",
  pan: "PAN — entity PAN",
  gstin: "GSTIN — Goods & Services Tax",
};

const DIRECTOR_LABEL: Record<DirectorRow["verifications"][number]["verification_type"], string> = {
  pan: "PAN — director",
  aadhaar: "Aadhaar — OTP",
  rc: "RC — Registration Certificate",
};

function StatusPill({ status }: { status: "pending" | "success" | "failed" }) {
  if (status === "success") {
    return (
      <span className="status-pill-success inline-flex items-center gap-1.5">
        <CheckCircle2 className="w-3 h-3" /> Verified
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="status-pill-danger inline-flex items-center gap-1.5">
        <XCircle className="w-3 h-3" /> Failed
      </span>
    );
  }
  return <span className="status-pill-neutral">Pending</span>;
}

function lastFor<T extends { verification_type: string; verified_at: string }>(
  rows: T[],
  type: string,
): T | null {
  const matching = rows.filter((r) => r.verification_type === type);
  if (!matching.length) return null;
  return matching[matching.length - 1];
}

function RawResponseToggle({ raw }: { raw: unknown }) {
  const [open, setOpen] = useState(false);
  if (!raw) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[12px] text-[color:var(--color-ink-muted)] inline-flex items-center gap-1 hover:text-[color:var(--color-brand-navy)] transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        Provider response
      </button>
      {open ? (
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-[color:var(--color-bg)] border border-[color:var(--color-border)] p-3 text-[11px] leading-snug font-mono text-[color:var(--color-brand-navy)]">
          {JSON.stringify(raw, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export default function NbfcKycReviewPanel({ nbfcId }: { nbfcId: number }) {
  const [data, setData] = useState<PageData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [aadhaarInput, setAadhaarInput] = useState("");
  const [rcInput, setRcInput] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/nbfc/${nbfcId}/kyc`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setLoadError(`Failed to load KYC state (HTTP ${res.status}).`);
        return;
      }
      const json = (await res.json()) as PageData;
      setData(json);
      setLoadError(null);
      const rcSeed = json.directors[0]?.rc_number ?? "";
      if (rcSeed && !rcInput) setRcInput(rcSeed);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Network error");
    }
  }, [nbfcId, rcInput]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runEntity = useCallback(
    async (type: "cin" | "pan" | "gstin") => {
      setBusyKey(`entity:${type}`);
      try {
        await fetch(`/api/admin/nbfc/${nbfcId}/kyc/${type}/verify`, {
          method: "POST",
        });
        await refresh();
      } finally {
        setBusyKey(null);
      }
    },
    [nbfcId, refresh],
  );

  const runDirector = useCallback(
    async (
      directorId: number,
      type: "pan" | "aadhaar" | "rc",
      payload?: Record<string, unknown>,
    ) => {
      setBusyKey(`director:${directorId}:${type}`);
      try {
        const slug = type === "aadhaar" ? "aadhaar/initiate" : `${type}/verify`;
        await fetch(
          `/api/admin/nbfc/${nbfcId}/director/${directorId}/kyc/${slug}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload ?? {}),
          },
        );
        await refresh();
      } finally {
        setBusyKey(null);
      }
    },
    [nbfcId, refresh],
  );

  const allEntityGreen = useMemo(() => {
    if (!data) return false;
    return (["cin", "pan", "gstin"] as const).every(
      (t) => lastFor(data.entityVerifications, t)?.status === "success",
    );
  }, [data]);

  const allDirectorGreen = useMemo(() => {
    if (!data || !data.directors[0]) return false;
    const verifs = data.directors[0].verifications;
    return (["pan", "aadhaar", "rc"] as const).every(
      (t) => lastFor(verifs, t)?.status === "success",
    );
  }, [data]);

  if (loadError) {
    return (
      <div
        className="card-iTarang p-6 text-sm"
        style={{ color: "var(--color-danger)" }}
      >
        {loadError}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="card-iTarang p-8 flex items-center gap-3 text-sm text-[color:var(--color-ink-muted)]">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading KYC state…
      </div>
    );
  }

  const director = data.directors[0];

  return (
    <div className="space-y-6">
      <header className="card-iTarang p-6 flex items-start gap-4">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center"
          style={{ background: "var(--color-info-bg)" }}
        >
          <ShieldCheck
            className="w-6 h-6"
            style={{ color: "var(--color-brand-sky)" }}
          />
        </div>
        <div className="flex-1">
          <p className="section-label-muted">KYC Review</p>
          <h2 className="text-xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
            {data.nbfc.legal_name}
          </h2>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
            Run all six verifications before opening the final approval gate.
            Each call hits Decentro and records the raw response for the
            RBI Digital Lending audit trail.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className={
              allEntityGreen && allDirectorGreen
                ? "status-pill-success"
                : "status-pill-neutral"
            }
          >
            {allEntityGreen && allDirectorGreen
              ? "Ready for approval"
              : "KYC pending"}
          </span>
          <span className="text-[11px] text-[color:var(--color-ink-muted)]">
            NBFC status: {data.nbfc.status}
          </span>
        </div>
      </header>

      <section className="card-iTarang">
        <div className="px-6 py-5 border-b border-[color:var(--color-border)]">
          <p className="section-label-muted">Section 1 of 2</p>
          <h3 className="text-base font-semibold text-[color:var(--color-brand-navy)] mt-1">
            NBFC entity verifications
          </h3>
          <p className="text-[13px] text-[color:var(--color-ink-muted)] mt-1">
            Decentro public-registry checks against the NBFC's own filings.
          </p>
        </div>
        <div className="divide-y divide-[color:var(--color-border)]">
          {(["cin", "pan", "gstin"] as const).map((type) => {
            const last = lastFor(data.entityVerifications, type);
            const idNumber =
              type === "cin"
                ? data.nbfc.cin
                : type === "pan"
                  ? data.nbfc.pan_number
                  : data.nbfc.gst_number;
            const status = last?.status ?? "pending";
            const busy = busyKey === `entity:${type}`;
            return (
              <div
                key={type}
                className="px-6 py-5 flex items-start gap-5"
                data-testid={`nbfc-kyc-entity-row-${type}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-[color:var(--color-brand-navy)]">
                    {ENTITY_LABEL[type]}
                  </p>
                  <p className="text-[12px] font-mono text-[color:var(--color-ink-muted)] mt-0.5 truncate">
                    {idNumber}
                  </p>
                  <div className="mt-3">
                    <RawResponseToggle raw={last?.raw_response} />
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <StatusPill status={status} />
                  <button
                    type="button"
                    onClick={() => runEntity(type)}
                    disabled={busy}
                    data-testid={`nbfc-kyc-entity-run-${type}`}
                    className="btn-primary inline-flex items-center gap-1.5 text-[12px]"
                  >
                    {busy ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Running…
                      </>
                    ) : last?.status === "success" ? (
                      "Re-verify"
                    ) : (
                      "Run verify"
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card-iTarang">
        <div className="px-6 py-5 border-b border-[color:var(--color-border)]">
          <p className="section-label-muted">Section 2 of 2</p>
          <h3 className="text-base font-semibold text-[color:var(--color-brand-navy)] mt-1">
            Director KYC
          </h3>
          <p className="text-[13px] text-[color:var(--color-ink-muted)] mt-1">
            Verifications on the NBFC's primary contact / authorized signatory.
          </p>
        </div>
        {director ? (
          <div className="divide-y divide-[color:var(--color-border)]">
            <div className="px-6 py-5 grid grid-cols-2 gap-4 text-[13px]">
              <div>
                <p className="section-label-muted">Name</p>
                <p className="font-semibold text-[color:var(--color-brand-navy)] mt-0.5">
                  {director.full_name}
                </p>
              </div>
              <div>
                <p className="section-label-muted">Email</p>
                <p className="font-mono mt-0.5">{director.email ?? "—"}</p>
              </div>
              <div>
                <p className="section-label-muted">PAN on record</p>
                <p className="font-mono mt-0.5">
                  {director.pan_number ?? "—"}
                </p>
              </div>
              <div>
                <p className="section-label-muted">Aadhaar last 4</p>
                <p className="font-mono mt-0.5">
                  {director.aadhaar_last4 ?? "—"}
                </p>
              </div>
            </div>

            {/* PAN row */}
            <div
              className="px-6 py-5 flex items-start gap-5"
              data-testid="nbfc-kyc-director-row-pan"
            >
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[color:var(--color-brand-navy)]">
                  {DIRECTOR_LABEL.pan}
                </p>
                <p className="text-[12px] font-mono text-[color:var(--color-ink-muted)] mt-0.5">
                  {director.pan_number ?? "Add PAN to nbfc.directors first"}
                </p>
                <div className="mt-3">
                  <RawResponseToggle
                    raw={lastFor(director.verifications, "pan")?.raw_response}
                  />
                </div>
              </div>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <StatusPill
                  status={
                    lastFor(director.verifications, "pan")?.status ?? "pending"
                  }
                />
                <button
                  type="button"
                  onClick={() => runDirector(director.id, "pan")}
                  disabled={busyKey === `director:${director.id}:pan`}
                  data-testid="nbfc-kyc-director-run-pan"
                  className="btn-primary inline-flex items-center gap-1.5 text-[12px]"
                >
                  {busyKey === `director:${director.id}:pan` ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Running…
                    </>
                  ) : (
                    "Run verify"
                  )}
                </button>
              </div>
            </div>

            {/* Aadhaar row */}
            <div
              className="px-6 py-5 flex items-start gap-5"
              data-testid="nbfc-kyc-director-row-aadhaar"
            >
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[color:var(--color-brand-navy)]">
                  {DIRECTOR_LABEL.aadhaar}
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={12}
                  placeholder="12-digit Aadhaar"
                  value={aadhaarInput}
                  onChange={(e) => setAadhaarInput(e.target.value)}
                  data-testid="nbfc-kyc-director-aadhaar-input"
                  className="mt-2 w-56 rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-[13px] font-mono"
                />
                <div className="mt-3">
                  <RawResponseToggle
                    raw={
                      lastFor(director.verifications, "aadhaar")?.raw_response
                    }
                  />
                </div>
              </div>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <StatusPill
                  status={
                    lastFor(director.verifications, "aadhaar")?.status ??
                    "pending"
                  }
                />
                <button
                  type="button"
                  onClick={() =>
                    runDirector(director.id, "aadhaar", {
                      aadhaarNumber: aadhaarInput,
                    })
                  }
                  disabled={
                    busyKey === `director:${director.id}:aadhaar` ||
                    !/^\d{12}$/.test(aadhaarInput)
                  }
                  data-testid="nbfc-kyc-director-run-aadhaar"
                  className="btn-primary inline-flex items-center gap-1.5 text-[12px]"
                >
                  {busyKey === `director:${director.id}:aadhaar` ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Sending OTP…
                    </>
                  ) : (
                    "Send OTP"
                  )}
                </button>
              </div>
            </div>

            {/* RC row */}
            <div
              className="px-6 py-5 flex items-start gap-5"
              data-testid="nbfc-kyc-director-row-rc"
            >
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[color:var(--color-brand-navy)]">
                  {DIRECTOR_LABEL.rc}
                </p>
                <input
                  type="text"
                  placeholder="e.g. MH12AB1234"
                  value={rcInput}
                  onChange={(e) => setRcInput(e.target.value.toUpperCase())}
                  data-testid="nbfc-kyc-director-rc-input"
                  className="mt-2 w-56 rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-[13px] font-mono"
                />
                <div className="mt-3">
                  <RawResponseToggle
                    raw={lastFor(director.verifications, "rc")?.raw_response}
                  />
                </div>
              </div>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <StatusPill
                  status={
                    lastFor(director.verifications, "rc")?.status ?? "pending"
                  }
                />
                <button
                  type="button"
                  onClick={() =>
                    runDirector(director.id, "rc", { rcNumber: rcInput })
                  }
                  disabled={
                    busyKey === `director:${director.id}:rc` || !rcInput.trim()
                  }
                  data-testid="nbfc-kyc-director-run-rc"
                  className="btn-primary inline-flex items-center gap-1.5 text-[12px]"
                >
                  {busyKey === `director:${director.id}:rc` ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Running…
                    </>
                  ) : (
                    "Run verify"
                  )}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="px-6 py-8 text-sm text-[color:var(--color-ink-muted)]">
            No director on record. The director should be seeded automatically
            when the NBFC master form is submitted.
          </div>
        )}
      </section>
    </div>
  );
}
