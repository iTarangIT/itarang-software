-- E-103 (Sync Audit G-05): rename product_selections.sub_category to
-- product_selections.model_number and widen VARCHAR(50) -> VARCHAR(100).
-- Same FK semantics; column carries the canonical battery-model identifier
-- (e.g. '51.2V-105AH').

ALTER TABLE product_selections RENAME COLUMN sub_category TO model_number;
ALTER TABLE product_selections ALTER COLUMN model_number TYPE varchar(100);
