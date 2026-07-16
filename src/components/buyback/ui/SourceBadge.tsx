/**
 * Source badge — proto srcBadge() (iTarang Portal.dc.html:466), stripped of
 * the prototype's WhatsApp-intake-modal deep link (out of scope for a
 * read-only atom — the caller decides what a click does, if anything).
 * Accepts either the DB's `buyback_source_channel` enum (WEB/WHATSAPP/CSV)
 * or the prototype's own display strings ("Portal"/"WhatsApp"), matched
 * case-insensitively.
 */
export default function SourceBadge({ source }: { source: string }) {
  const key = (source ?? "").toUpperCase();
  const isWhatsApp = key === "WHATSAPP";
  const isCsv = key === "CSV";
  const label = isWhatsApp ? "WhatsApp" : isCsv ? "CSV" : "Portal";

  return (
    <span
      className={`rounded-[5px] px-[7px] py-[2px] text-[10px] font-bold ${
        isWhatsApp ? "bg-green-100 text-green-700" : "bg-[#EEF2F7] text-slate-500"
      }`}
    >
      {label}
    </span>
  );
}
