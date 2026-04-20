-- Adds a blob column on digilocker_transactions for the eAadhaar PDF
-- returned by Decentro when we call the eAadhaar endpoint with
-- generate_pdf=true. Binary, stored inline (base64-decoded bytes).
ALTER TABLE "digilocker_transactions"
  ADD COLUMN IF NOT EXISTS "aadhaar_pdf" bytea;
