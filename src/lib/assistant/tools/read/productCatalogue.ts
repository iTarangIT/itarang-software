// product_catalogue — find products to put on a quote (the Update Commercials
// modal's product picker). Active rows of the three product masters, matched on
// name / model / detail. The product_id it returns is the ONLY way create_quote
// accepts a product.
//
// Names and models only: the OEM reference price is the CEO's approval floor
// and is never handed to a rep (listOemCatalogue's price columns are dropped in
// loadCatalogue before anything reaches here).

import { z } from "zod";
import { OEM_ASSET_TYPES } from "@/lib/leads/oemPrices";
import { MAX_TOOL_ROWS, type ToolResult } from "../../types";
import { defineTool, type ToolFactory } from "../spec";
import { filterCatalogue, loadCatalogue } from "../quotes";

export const productCatalogue: ToolFactory = () =>
    defineTool({
        name: "product_catalogue",
        kind: "read",
        description:
            "Search the product catalogue (batteries, chargers, paraphernalia) for products to put on a quote. " +
            "Returns product_id, name, model and specs (first 10 matches plus the total). No prices.",
        schema: z.object({
            query: z
                .string()
                .trim()
                .max(60)
                .optional()
                .describe('Words from the product name, model or spec, e.g. "51.2V 105Ah" or "charger". Omit to list everything.'),
            asset_type: z.enum(OEM_ASSET_TYPES).optional(),
        }),
        run: async (_ctx, input): Promise<ToolResult> => {
            const all = await loadCatalogue();
            const hits = filterCatalogue(all, input.query, input.asset_type);
            return { kind: "products", rows: hits.slice(0, MAX_TOOL_ROWS), total: hits.length };
        },
    });
