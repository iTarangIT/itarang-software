import { inr } from "@/lib/buyback/format";

import Card from "./Card";

export interface NegLine {
  label: string;
  amount: number;
}

export interface NegRound {
  actor: string;
  side: "dealer" | "admin";
  note?: string;
  at?: string;
  lines?: NegLine[];
  amount?: number;
  isFinal?: boolean;
  isAccept?: boolean;
  isInfo?: boolean;
  isReject?: boolean;
}

/**
 * Negotiation thread — proto negThread() (iTarang Portal.dc.html:690-716),
 * RENDER ONLY. No composer/input here on purpose: dealer and admin send a
 * counter through very different flows (a free-text box vs. a per-SKU form),
 * so each screen bolts its own composer beneath this.
 */
export default function NegotiationThread({
  rounds,
  viewer,
  offerVersion,
}: {
  rounds: NegRound[];
  viewer: "dealer" | "admin";
  offerVersion?: number;
}) {
  if (rounds.length === 0) {
    return (
      <Card className="py-2">
        <div className="p-6 text-center text-[13px] text-slate-400">No negotiation yet.</div>
      </Card>
    );
  }

  return (
    <Card className="py-2">
      {rounds.map((round, i) => {
        const isAdmin = round.side === "admin";
        // viewer=dealer: admin bubbles left, dealer bubbles right.
        // viewer=admin: admin bubbles right, dealer bubbles left.
        const alignRight = viewer === "dealer" ? !isAdmin : isAdmin;
        const bubbleClass = round.isReject
          ? "bg-[#FEF2F2] border-[#FECACA]"
          : round.isInfo
            ? "bg-[#FFFBEB] border-[#FDE68A]"
            : round.isFinal
              ? "bg-[#FFF7ED] border-[#FED7AA]"
              : isAdmin
                ? "bg-slate-100 border-gray-200"
                : "bg-blue-50 border-gray-200";
        const nameColor = isAdmin ? "text-bb-navy" : "text-blue-600";

        return (
          <div key={i} className={`flex flex-col px-4 py-[7px] ${alignRight ? "items-end" : "items-start"}`}>
            <div className={`max-w-[72%] rounded-xl border p-[10px_13px] ${bubbleClass}`}>
              <div className="mb-[3px] flex items-center gap-2">
                <span className={`text-xs font-bold ${nameColor}`}>{round.actor}</span>
                {round.isFinal && (
                  <span className="rounded bg-[#F59E0B] px-1.5 py-[1px] text-[9.5px] font-bold text-white">
                    FINAL{offerVersion != null && ` v${offerVersion}`}
                  </span>
                )}
                {round.isAccept && (
                  <span className="rounded bg-green-600 px-1.5 py-[1px] text-[9.5px] font-bold text-white">
                    ACCEPTED
                  </span>
                )}
              </div>

              {round.lines && round.lines.length > 0 && (
                <div className="my-1.5 min-w-[220px] overflow-hidden rounded-lg border border-black/[.06]">
                  {round.lines.map((line, k) => (
                    <div
                      key={k}
                      className={`flex items-center justify-between gap-3 p-[5px_9px] text-xs tabular-nums ${
                        k % 2 ? "bg-white/50" : ""
                      }`}
                    >
                      <span className="text-slate-600">{line.label}</span>
                      <b className="whitespace-nowrap">{inr(line.amount)}/u</b>
                    </div>
                  ))}
                </div>
              )}

              {round.amount != null && (
                <div className="text-[18px] font-extrabold tabular-nums text-slate-900">
                  {inr(round.amount)}/unit
                </div>
              )}

              {round.note && <div className="mt-0.5 text-[12.5px] text-slate-600">{round.note}</div>}
              {round.at && <div className="mt-1 text-[10.5px] text-slate-400">{round.at}</div>}
            </div>
          </div>
        );
      })}
    </Card>
  );
}
