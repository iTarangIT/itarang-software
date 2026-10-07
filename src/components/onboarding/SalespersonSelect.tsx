"use client";

// The salesperson dropdown on the dealer onboarding wizard (tracker ID 66):
// every active ISR, ASM and Sales Head, stored as a user id. Replaces the typed
// sales-manager name / email / mobile, which the server now fills in from the
// picked user.

import { useEffect, useState } from "react";

export type SalespersonOption = { id: string; name: string; role: string };

const ROLE_LABEL: Record<string, string> = {
  inside_sales_rep: "Inside Sales",
  asm: "ASM",
  sales_head: "Sales Head",
};

let cached: Promise<SalespersonOption[]> | null = null;

function loadSalespeople(): Promise<SalespersonOption[]> {
  if (!cached) {
    cached = fetch("/api/dealer-onboarding/salespeople", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => (Array.isArray(j?.salespeople) ? (j.salespeople as SalespersonOption[]) : []))
      .catch(() => {
        cached = null;
        return [];
      });
  }
  return cached;
}

export function SalespersonSelect({
  id,
  value,
  typedName,
  onPick,
  className,
  disabled,
}: {
  id?: string;
  /** users.id of the picked salesperson, "" when none. */
  value: string;
  /** A name typed before the dropdown existed — shown as a hint, never saved as the pick. */
  typedName?: string;
  onPick: (option: SalespersonOption | null) => void;
  className?: string;
  disabled?: boolean;
}) {
  const [options, setOptions] = useState<SalespersonOption[] | null>(null);

  useEffect(() => {
    let alive = true;
    loadSalespeople().then((list) => {
      if (alive) setOptions(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <select
        id={id}
        value={value}
        disabled={disabled || options === null}
        onChange={(e) => onPick(options?.find((o) => o.id === e.target.value) ?? null)}
        className={className}
      >
        <option value="">{options === null ? "Loading…" : "Select salesperson"}</option>
        {(options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} — {ROLE_LABEL[o.role.toLowerCase()] ?? o.role}
          </option>
        ))}
      </select>
      {!value && typedName?.trim() ? (
        <p className="mt-1.5 text-xs text-slate-500">
          Entered earlier as “{typedName.trim()}” — pick the same person from the list.
        </p>
      ) : null}
      {options !== null && options.length === 0 ? (
        <p className="mt-1.5 text-xs text-amber-700">
          The salesperson list could not be loaded. Reload the page to try again.
        </p>
      ) : null}
    </>
  );
}
