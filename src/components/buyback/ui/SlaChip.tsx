/**
 * SLA aging chip — proto (iTarang Portal.dc.html:833), the "Xd in queue"
 * badge shown in the admin review queue.
 */
export default function SlaChip({ days, hours }: { days: number; hours?: number }) {
  const label = days >= 1 ? `${days}d in queue` : `${hours ?? 0}h in queue`;

  return (
    <span className="rounded-md bg-amber-100 px-2 py-[2px] text-[11.5px] font-bold text-amber-700">{label}</span>
  );
}
