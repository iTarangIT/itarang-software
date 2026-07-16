import Card from "./Card";

/**
 * Empty-state card — proto emptyState() (iTarang Portal.dc.html:782).
 */
export default function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <Card>
      <div className="px-5 py-[52px] text-center">
        <div className="mb-2.5 text-[36px]">{icon}</div>
        <div className="text-[15px] font-bold text-slate-900">{title}</div>
        <div className="mt-[5px] text-[13px] text-slate-500">{body}</div>
      </div>
    </Card>
  );
}
