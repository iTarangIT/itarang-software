export function QualityScoreBadge({ score }: { score: number | null }) {
    if (score === null || score === undefined) return null;

    const colors: Record<number, string> = {
        1: 'bg-red-100 text-red-700',
        2: 'bg-orange-100 text-orange-700',
        3: 'bg-yellow-100 text-yellow-700',
        4: 'bg-green-100 text-green-700',
        5: 'bg-emerald-100 text-emerald-700',
    };

    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[score] ?? 'bg-gray-100 text-gray-700'}`}>
            Q{score}/5
        </span>
    );
}
