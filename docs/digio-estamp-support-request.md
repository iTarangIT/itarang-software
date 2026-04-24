# Email to DigiO Support — E-Stamp Integration Request

**To:** support@digio.in (cc: your DigiO account manager if you have one)
**Subject:** E-Stamp integration on existing uploadpdf flow — technical clarifications + demo request

---

Hi DigiO Support Team,

We are iTarang (Client ID: `ACK260331203716696WHO78ZQ4S3YWVB` — prod; sandbox Client ID: `ACK260318144213661GFJLKWS32WAJYK`). We run a dealer onboarding flow that already uses `POST /v2/client/document/uploadpdf` with Aadhaar e-Sign for our dealer agreements, and we are now integrating e-Stamping on top of it using the `estamp_request` field.

We have **50 × KA-100-General (Rs.100 Karnataka)** stamp papers loaded in our sandbox account and want to verify our integration before moving to production. Our target flow: **prepend a Rs.100 Karnataka e-stamp as page 1, keep the dealer agreement as pages 2+, and have all signers Aadhaar e-sign across both the stamp page and agreement pages.**

Below are our specific technical questions and resource requests. Numbered for easy reply.

---

## 1. Technical clarifications on `estamp_request`

Our current payload (sent to `/v2/client/document/uploadpdf`):

```json
{
  "file_name": "dealer-agreement.pdf",
  "file_data": "<base64 of agreement PDF>",
  "expire_in_days": 5,
  "notify_signers": true,
  "send_sign_link": true,
  "include_authentication_url": true,
  "sequential": true,
  "signers": [
    { "identifier": "dealer@example.com", "name": "Dealer Signatory", "reason": "dealer signer", "sign_type": "aadhaar" },
    { "identifier": "itarang1@example.com", "name": "iTarang Signer 1", "reason": "iTarang signer 1", "sign_type": "aadhaar" },
    { "identifier": "itarang2@example.com", "name": "iTarang Signer 2", "reason": "iTarang signer 2", "sign_type": "aadhaar" }
  ],
  "estamp_request": {
    "tags": { "KA-100-General": 1 },
    "note_content": "",
    "note_on_page": "first",
    "sign_on_page": "all"
  }
}
```

Please confirm:

1.1 **Stamp placement** — Does `note_on_page: "first"` **prepend** the e-stamp certificate as a new page 1 of the final signed PDF, or does it **overlay/emboss** the stamp onto the first page of the uploaded PDF?

1.2 **`note_on_page` semantics** — Does `"first"` / `"last"` refer to where the stamp is placed in the *final document*, or where the description/note text appears *on the stamp certificate itself*?

1.3 **`sign_on_page: "all"`** — With this value and **no explicit `sign_coordinates`**, are Aadhaar signatures automatically placed on both the stamp page and every page of the agreement? Or do we need to supply explicit per-page `sign_coordinates` to make signatures appear on the stamp page?

1.4 **Response timing** — Does `attached_estamp_details` (e.g. `{ "KA-100-General": ["IN-KA..."] }`) come back **synchronously** in the `/uploadpdf` response, or **asynchronously** after stamp attachment completes (requiring a poll of `GET /v2/client/document/{id}` or a webhook)?

1.5 **Error contract when stamps are exhausted** — What is the exact HTTP status code, `error_code`, and `message` returned when the account has zero remaining stamps for the requested tag? We want to show an actionable error to our admin user.

1.6 **Jurisdiction / cross-state rule** — If the dealer is located in (for example) Maharashtra but our company is registered in Karnataka, is `KA-100-General` legally valid, or must we use the state-specific stamp of the dealer's state (e.g. `MH-100-General`)? Please share the rule DigiO expects us to follow for pan-India dealer agreements.

1.7 **`estamp_request` + `template_id` compatibility** — Can `estamp_request` be combined with `template_id` in the same `/uploadpdf` call? We use `template_id` on our consent flow and may want to combine both in the future.

---

## 2. Additional APIs we would like access to

2.1 **Inventory check API** — An endpoint that returns the remaining stamp count per tag (e.g. how many `KA-100-General` stamps are left on our account) so we can pre-flight before initiating an agreement and alert our ops team when inventory is low.

2.2 **Stamp purchase / top-up API** — If available, so our procurement team can automate inventory refills instead of using the dashboard manually.

2.3 **Webhook events for e-stamping** — Do webhook events fire when a stamp is attached, re-issued, or fails to attach? If yes, please share the event names and payload shapes. Our webhook endpoint for lead-consent events is already configured at `/api/webhooks/digio`.

2.4 **Programmatic certificate download** — Is the e-stamp certificate itself (separate from the signed combined PDF) downloadable via API by certificate ID? Useful for audit trails when we need to surface just the stamp to compliance reviewers.

---

## 3. Demo / walkthrough request

3.1 **Video walkthrough** — Could you share a short video or screen recording that demonstrates **a complete end-to-end e-stamp + Aadhaar e-sign flow on an already-uploaded PDF** (our exact scenario), from initiate → stamp attached → signers sign → download of the final stamped + signed PDF? The existing written docs don't make the page-placement and sign-coordinate behavior obvious.

3.2 **Sandbox sample** — A reference sandbox document ID we can call `GET /v2/client/document/{id}` against to see the full response shape of a **completed** stamped + signed document (with `attached_estamp_details` populated and all signers signed). This would let us verify our parser matches reality.

3.3 **Postman collection / sample code** — If you have a Postman collection or SDK sample that demonstrates `estamp_request` in action, please share it.

---

## 4. Production readiness

4.1 How do we procure production stamp inventory? Is the process the same as sandbox (dashboard order), or is there a separate commercial onboarding step?

4.2 Is there a **staging / prod separation** concern — i.e. do we need a separate enterprise agreement for production e-stamping, or do our existing production API credentials automatically grant access once we have stamp inventory?

4.3 What is the typical turnaround for a prod stamp top-up order after payment?

---

Thank you — a prompt reply on section 1 (technical clarifications) would unblock our sandbox verification this week. Sections 2–4 we can receive over a slightly longer timeline but are needed before we go live in production.

Regards,
[Your name]
iTarang
[Your phone / email]

---

## Notes to self (not part of the email)

- Fill in your name, phone, and preferred reply email before sending.
- The sandbox Client ID shown above is from `.env.local` line 66; double-check it's the right one you want to share.
- If DigiO has assigned you a named account manager / CSM, loop them in on CC — they usually expedite enterprise tickets.
- Attach a screenshot of your sandbox stamp inventory page (the one at `https://ext-enterprise.digio.in/#/estamps/orders/order-items/...`) so support can immediately verify the tag name and quantity they should be testing against.
