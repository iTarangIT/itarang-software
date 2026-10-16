import { describe, expect, it } from "vitest";
import { groupColumns } from "../layout";
import type { DatasetColumn } from "../types";

const col = (key: string): DatasetColumn => ({ key, header: key, meaning: "" });

describe("groupColumns", () => {
    it("puts columns in their boxes and never drops one the layout does not know", () => {
        const groups = groupColumns("visits", [col("visit_date"), col("photos"), col("brand_new_column"), col("lead_id")]);
        expect(groups.map((g) => g.name)).toEqual(["Visit", "Proof", "Other"]);
        expect(groups[0].columns.map((c) => c.key)).toEqual(["visit_date", "lead_id"]);
        expect(groups[2].columns.map((c) => c.key)).toEqual(["brand_new_column"]);
        expect(groups.flatMap((g) => g.columns)).toHaveLength(4);
    });
    it("customer loan files: the iTarang push columns sit together, not under Other (ID 33)", () => {
        const groups = groupColumns("customer_loan_files", [col("file_id"), col("dealer"), col("pushed_by_itarang_on"), col("pushed_by"), col("pushed_to"), col("nbfc")]);
        expect(groups.map((g) => g.name)).toEqual(["File", "iTarang help", "Decision"]);
        expect(groups[1].columns.map((c) => c.key)).toEqual(["pushed_by_itarang_on", "pushed_by", "pushed_to"]);
    });
    it("an unknown dataset shows everything under Other", () => {
        expect(groupColumns("nope", [col("a"), col("b")])).toEqual([{ name: "Other", columns: [col("a"), col("b")] }]);
    });
});
