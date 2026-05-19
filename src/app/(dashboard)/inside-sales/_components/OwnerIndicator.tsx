// "You" / [other rep / ASM name] / "Unassigned" — BRD §0.5 header element.

import { User2 } from "lucide-react";

type Props = {
    currentOwnerId: string | null;
    currentOwnerName: string | null;
    viewerId: string;
    asmName?: string | null;
};

export function OwnerIndicator({ currentOwnerId, currentOwnerName, viewerId, asmName }: Props) {
    if (!currentOwnerId) {
        return (
            <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                <User2 className="h-3.5 w-3.5" />
                Unassigned
            </span>
        );
    }
    const isYou = currentOwnerId === viewerId;
    const label = isYou ? "You" : currentOwnerName ?? asmName ?? "Other rep";
    return (
        <span
            className={`inline-flex items-center gap-1.5 text-xs font-medium ${isYou ? "text-emerald-700" : "text-gray-700"}`}
        >
            <User2 className="h-3.5 w-3.5" />
            {label}
        </span>
    );
}
