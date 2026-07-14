"use client";

/**
 * Filter pill — proto filterPill() (iTarang Portal.dc.html:819), turned into
 * a real control: a native <select> sits invisible on top of the pill so the
 * filter works without a popover/portal library. "use client" because it
 * attaches onChange to that <select> — illegal from a Server Component.
 */
export default function FilterPill({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const selected = options.find((o) => o.value === value);

  return (
    <div className="relative flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-[7px] text-[12.5px] font-semibold text-slate-600">
      <span>
        {label}: {selected?.label ?? value}
      </span>
      <span>▾</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
