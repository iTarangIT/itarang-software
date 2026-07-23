------------------------------------------------------------------------------
-- E-208: Step-4 pre-sanction document bucket on product_selections.
--
-- Change (dealer pre-sanction docs): the dealer can attach up to 10 items of any
-- format (image / video / zip / pdf) on Step-4 Product Selection — installation
-- images, NBFC-signed docs, agreements, etc. A combined PDF (images/PDFs merged
-- server-side) counts as one item. The column holds an array of
-- { url, name, type, size }; viewable by the NBFC (Acquire dossier) + admin.
--
-- Additive + idempotent. Mirrors the existing battery_photo_urls/charger_photo_urls
-- jsonb-array pattern.
------------------------------------------------------------------------------

ALTER TABLE product_selections
  ADD COLUMN IF NOT EXISTS pre_sanction_doc_urls jsonb DEFAULT '[]'::jsonb;
