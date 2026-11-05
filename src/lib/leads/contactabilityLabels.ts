// The contactability vocabulary and its words, without the database: shared by
// contactability.ts (which re-exports both) and pure code such as the data
// downloads (ID 224), whose tests cannot load the database client.

export type Contactability = "dead_number" | "non_responsive";

export const CONTACTABILITY_LABEL: Record<Contactability, string> = {
    dead_number: "Dead number",
    non_responsive: "Non-responsive (6 calls on 6 days, 45 days, no answer)",
};
