-- E-265: the customer as an author on the offer-negotiation thread.
--
-- COMMENT-ONLY. There is no DDL here and nothing breaks if this file is never
-- applied — it exists so the database describes its own vocabulary, exactly as
-- E-245 did for the 'close' round. Same shape, same reason.
--
-- WHY NO DDL IS NEEDED.
--
-- `nbfc_offer_negotiations.party` is varchar(8) with no CHECK constraint. E-238
-- chose route-layer enforcement deliberately (see its header, "WHY NO CHECK
-- CONSTRAINTS ON party / kind / negotiation_status"), and 'customer' is exactly
-- eight characters. So a borrower writing from their own WhatsApp chat can be
-- recorded as a first-class third party without touching the schema.
--
-- WHY `negotiation_status` DOES NOT GAIN A MATCHING VALUE.
--
-- It is varchar(16). 'customer_countered' is nineteen characters and would be
-- rejected on write. Rather than widen a live column to carry a distinction that
-- is already recorded elsewhere, a customer's counter leaves the status at
-- 'dealer_countered' — read as "the BORROWER SIDE countered".
--
-- The division of labour is therefore:
--   negotiation_status  →  whose TURN it is  (lender vs borrower side)
--   party               →  who actually TYPED (nbfc | dealer | customer)
--
-- Every existing reader keys off the status: `can_act` on the NBFC offer panel,
-- the "Revise offer" button, the dealer's Negotiate gate. None of them needed to
-- change, which is the point.
--
-- WHY `created_by` CAN BE NULL ON THESE ROWS.
--
-- A self-serve customer has no `users` row. `created_by` is already nullable, so
-- it is left NULL rather than filled with an invented author. The compliance
-- trail is not lost: `nbfc_audit_log.user_id` is NOT NULL, so the audit row for
-- a customer-authored round carries the user accountable for the lead (its
-- dealer's uploader), and `after_state.party` records that the customer is who
-- actually spoke.

COMMENT ON COLUMN nbfc_offer_negotiations.party IS
  'E-238/E-265: nbfc | dealer | customer. ''customer'' is the borrower writing '
  'from their own WhatsApp chat, as opposed to a dealer countering on their '
  'behalf from the portal. No CHECK — enforced in the service layer '
  '(src/lib/nbfc/offer-negotiation.ts NEGOTIATION_PARTIES).';

COMMENT ON COLUMN nbfc_offer_negotiations.created_by IS
  'E-265: users.id of the author, or NULL for a self-serve customer who has no '
  'users row. Never invent an author here — the accountable user is on the '
  'matching nbfc_audit_log row.';

COMMENT ON COLUMN nbfc_financing_offers.negotiation_status IS
  'E-238/E-265: open | dealer_countered | fixed | closed. varchar(16), so there '
  'is deliberately NO ''customer_countered'' (19 chars, would not fit): a '
  'customer''s counter also sets ''dealer_countered''. The status says whose '
  'TURN it is — lender vs borrower side — and nbfc_offer_negotiations.party says '
  'who typed. No CHECK — enforced in the route/service layer.';
