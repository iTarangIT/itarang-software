"use client";

/**
 * NbfcReviewSignersSection — read-only listing of every Step 3 signatory for
 * an NBFC, surfaced on the CEO approval / review page so the CEO can see
 * who's signing the LSP Agreement and verify their identity documents
 * before approving.
 *
 * E-111 — each name/email/designation/identity-document spot gets a
 * FlagButton so the CEO can flag a specific signer attribute or identity
 * document for correction.
 */
import { Eye, Mail, User } from "lucide-react";
import NbfcFlagButton from "./NbfcFlagButton";
import {
  signerFieldKey,
  signerIdentityDocKey,
} from "@/lib/nbfc/admin/correction-catalog";

export interface SignerReviewRow {
  id: number;
  signer_order: number;
  party: string; // "nbfc" | "itarang" (stored as string in DB)
  full_name: string;
  email: string;
  designation: string;
  identity_document_url: string;
  identity_document_size: number | null;
}

interface Props {
  signers: SignerReviewRow[];
}

function SignerCard({
  signer,
  index,
}: {
  signer: SignerReviewRow;
  index: number;
}) {
  const isNbfc = signer.party === "nbfc";
  const accent = isNbfc ? "var(--color-brand-sky)" : "var(--color-brand-teal)";
  const party = isNbfc ? "nbfc" : "itarang";
  return (
    <div
      className="rounded-xl border-l-4 border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4 space-y-2"
      style={{ borderLeftColor: accent }}
    >
      <div className="flex items-center gap-2">
        <div
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold"
          style={{ backgroundColor: accent }}
        >
          {index}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-sm font-semibold text-[color:var(--color-brand-navy)] truncate">
              {signer.full_name || "—"}
            </p>
            <NbfcFlagButton
              kind="signer_field"
              targetKey={signerFieldKey(party, signer.signer_order, "full_name")}
              targetRefId={signer.id}
            />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-[11px] text-[color:var(--color-ink-muted)] truncate">
              {signer.designation || "—"}
            </p>
            <NbfcFlagButton
              kind="signer_field"
              targetKey={signerFieldKey(party, signer.signer_order, "designation")}
              targetRefId={signer.id}
            />
          </div>
        </div>
        <span
          className="shrink-0 inline-flex items-center text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full"
          style={{ backgroundColor: `${accent}1a`, color: accent }}
        >
          Signs {ordinal(signer.signer_order)}
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-ink-muted)] flex-wrap">
        <Mail className="w-3 h-3" />
        <span className="truncate">{signer.email}</span>
        <NbfcFlagButton
          kind="signer_field"
          targetKey={signerFieldKey(party, signer.signer_order, "email")}
          targetRefId={signer.id}
        />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <a
          href={signer.identity_document_url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost text-xs inline-flex items-center gap-1.5 flex-1 justify-center"
        >
          <Eye className="w-3.5 h-3.5" />
          View identity document
        </a>
        <NbfcFlagButton
          kind="signer_identity_doc"
          targetKey={signerIdentityDocKey(party, signer.signer_order)}
          targetRefId={signer.id}
        />
      </div>
    </div>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function NbfcReviewSignersSection({ signers }: Props) {
  const nbfcSigners = signers.filter((s) => s.party === "nbfc");
  const itarangSigners = signers.filter((s) => s.party === "itarang");

  return (
    <section className="card-iTarang p-6 md:p-7 space-y-5">
      <header>
        <p className="section-label">Step 3 · Signatories</p>
        <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)] mt-1">
          Sequential signing order
        </h2>
        <p className="text-xs text-[color:var(--color-ink-muted)] mt-0.5">
          {nbfcSigners.length} NBFC + {itarangSigners.length} iTarang ={" "}
          {signers.length} total signers. Identity documents stay in iTarang's
          records and are not sent to Digio.
        </p>
      </header>

      {signers.length === 0 ? (
        <div
          className="rounded-xl border border-dashed p-6 text-center text-sm text-[color:var(--color-ink-muted)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          <User className="w-8 h-8 mx-auto mb-2 opacity-50" />
          No signatories recorded for this NBFC yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-3">
            <p
              className="section-label"
              style={{ color: "var(--color-brand-sky)" }}
            >
              NBFC ({nbfcSigners.length})
            </p>
            {nbfcSigners.length === 0 && (
              <p className="text-xs italic text-[color:var(--color-ink-muted)]">
                No NBFC signatories.
              </p>
            )}
            {nbfcSigners.map((s) => (
              <SignerCard key={s.id} signer={s} index={s.signer_order} />
            ))}
          </div>
          <div className="space-y-3">
            <p
              className="section-label"
              style={{ color: "var(--color-brand-teal)" }}
            >
              iTarang ({itarangSigners.length})
            </p>
            {itarangSigners.length === 0 && (
              <p className="text-xs italic text-[color:var(--color-ink-muted)]">
                No iTarang signatories.
              </p>
            )}
            {itarangSigners.map((s) => (
              <SignerCard key={s.id} signer={s} index={s.signer_order} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
