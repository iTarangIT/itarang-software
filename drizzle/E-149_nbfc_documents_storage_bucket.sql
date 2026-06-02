-- E-149 — Private Supabase Storage bucket for NBFC documents.
--
-- Backs the migration of NBFC file uploads off local disk (public/nbfc-uploads/)
-- and into Supabase Storage: FI visit photos, FI agent reference photos,
-- compliance documents, LSP agreement templates, signer identity docs, and
-- cached signed/audit PDFs. The bucket is PRIVATE — objects are reached only via
-- the authenticated /api/nbfc-uploads/[...path] route (service-role signed
-- download), never a public URL. KYC PII must not sit on a public path.
--
-- Idempotent: re-running is a no-op.

INSERT INTO storage.buckets (id, name, public)
VALUES ('nbfc-documents', 'nbfc-documents', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- No public RLS policies are added on purpose: all access goes through the
-- server using the service-role key, which bypasses storage RLS. If you later
-- want authenticated client-side reads, add narrowly-scoped policies here.
