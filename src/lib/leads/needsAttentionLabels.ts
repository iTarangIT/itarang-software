// The needs-attention list's display labels. Kept apart from needsAttention.ts
// (which imports the database client) so the client view can import them
// without webpack pulling postgres into the browser bundle.

export type CountedFrom = "follow_up" | "handed_over" | "last_worked" | "created";

export const COUNTED_FROM_LABEL: Record<CountedFrom, string> = {
    follow_up: "Follow-up",
    handed_over: "Handed over",
    last_worked: "Last worked",
    created: "Created",
};
