# NBFC Implementation Notes

## Known issue: profile dropdown shows `dealer` for sales_head Supabase login

**Symptom:** Logging in as `sales_head` (e.g. `anirudh@itarang.com`) and opening the avatar dropdown in the header shows the role chip as `dealer`.

**Root cause:** The chip reads `user.role` from `AuthProvider` → `/api/user/profile` → `requireAuth()` → `users.role` column. For some test personas the `users` row carries `role='dealer'` instead of the expected role string.

**Likely propagation paths:**

1. **`docs/nbfc/personas.json`** — if a persona's `role` field is wrong, `tests/e2e/helpers/seed-personas.ts:178+` writes that value into `users.role` via `upsertUser()` (`role: persona.role`).
2. **Original signup** — production users created via the dealer-onboarding flow are inserted with `role='dealer'` regardless of who they actually are. If a `sales_head` user reuses a stale dealer-onboarding email, they'll inherit the `dealer` role until corrected.

**Recommended fix (out of scope for the visual redesign PR):**

```sql
update users
set role = 'sales_head', updated_at = now()
where email in (
  'anirudh@itarang.com',
  'e2e-sh@itarang.com',
  -- … any other sales_head email mistakenly carrying role='dealer'
);
```

Then re-run `npx playwright test --config=tests/e2e/nbfc-loop.config.ts --project=setup-personas` to refresh storage states and `/api/user/profile`'s app_metadata sync (`src/app/api/user/profile/route.ts:13–16`).

## Server-side doc-type vocabulary divergence

The compliance-documents POST route at `src/app/api/admin/nbfc/[nbfcId]/compliance-documents/route.ts` accepts:

```
certificate_of_incorporation, pan_card_company, gst_registration
```

But the approval gate at `src/lib/nbfc/admin/required-docs.ts` requires:

```
incorporation_certificate, pan_card, gst_certificate
```

The `nbfc-onboarding` headed test papers over this with `seedRequiredVerifiedDocs()` in `tests/e2e/helpers/digio-test-helper.ts`, but **production** still requires uploads under both vocabularies for an NBFC to be approvable. Pick one slug system in both modules.

## CEO approval gate

Approval is now CEO-only:

- `POST /api/admin/nbfc/[id]/approve` requires `role='ceo'` OR `email='sanchit@itarang.com'`.
- `POST /api/admin/nbfc/[id]/transition` to `pending_admin_review` requires `sales_head|ceo|admin`; to `approved` requires `ceo`; to `active` requires `ceo|admin`.

The `via='test_bypass'` headers used by the headed spec bypass these checks so the green test stays green.
