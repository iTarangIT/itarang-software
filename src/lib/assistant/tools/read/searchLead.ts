// search_lead — find leads in the user's scope by dealer name, shop or phone.
// Gate 3 wires the queue search clause under the scope predicate.

import { z } from "zod";
import { defineTool, type ToolFactory } from "../spec";

export const searchLead: ToolFactory = () => defineTool({
    name: "search_lead",
    kind: "read",
    description:
        "Find leads the user can see by dealer name, shop name or phone number (max 10). " +
        "If more than one lead matches, show the candidates and ask which one — never pick one yourself.",
    schema: z.object({
        query: z.string().trim().min(2).max(60).describe("Name, shop or phone digits, as the user wrote them"),
    }),
    run: async () => ({ kind: "unavailable", message: "Search arrives in the next release." }),
});
