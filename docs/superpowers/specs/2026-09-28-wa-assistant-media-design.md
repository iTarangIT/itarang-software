# WhatsApp Sales Assistant — photos, PDFs and location pins (E-311)

**Date:** 2026-09-28 · **Status:** built on `Aditya`, E-311 applied to sandbox (database-1) only

## Goal

Let ASMs and ISRs do CRM work from what they naturally send in the field, with the
same safety as typed messages (preview → Confirm → one transaction → audit):

1. **Visit proof** — shop photos and a location pin attached to a logged visit.
2. **Read a document into a lead** — visiting card / shop board / GST certificate →
   create a lead or fill in an existing one.
3. **File documents on a lead** — GST certificate, PAN card, shop licence, PO, photos.

Out of scope: "just answer questions about a file", CRM-side upload, Word/Excel files,
video, WhatsApp live location (not delivered to business numbers).

## Decisions (agreed in chat)

| Question | Decision |
|---|---|
| Which lead a file belongs to | Caption or the lead in this conversation; otherwise the agent asks. Nothing is saved without Confirm. |
| Location vs the dealer's address | Recorded as the visit's GPS check-in; flagged when > 1 km from the geocoded shop (15 km when only the city is known). Never blocks. |
| Approach | Media is agent input: the file is stored on arrival and the agent sees an attachment id + caption. Only `read_document` sends the file to a model. |
| Storage | S3, logical bucket `documents` (session-only via `/api/files`) — NOT `dealer-documents`, which is served without a session. |
| CRM view | "Documents & photos" tab on the lead page (ISR and ASM share `LeadActivityPanes`), view-only. |

## Flow

```
WhatsApp image | document | location (+ caption)
  → webhook (records every message of the batch first) → router step 5
      image/document: download from Meta (≤ 10 MB, jpg/png/webp/pdf) → S3 documents/wa-assistant/<user>/<yyyy-mm>/<uuid>.<ext>
      location: coordinates from the message
      → assistant_media row, short ref "m7k2q9" (unique per user)
  → quiet 4 s; a newer photo/PDF/pin from the same sender already recorded → media_batched, no reply
  → agent turn: "[Attachments … m7k2q9: photo caption "…" (11:00)]" + caption as the text
      read_document(ref) → doc kind + checked fields (no PAN/Aadhaar field, Invariant 8)
      create_lead / update_lead / attach_document / log_visit(photo_ids, location_id) → card
  → Confirm → executor: consumeMedia (used once; a race rejects "attachment_used") + the writes
```

A turn now ends as soon as a card is proposed (saves a model call; keeps
read → search → details → write within the 4-call limit).

## Tools

| Tool | Kind | Roles | Writes on Confirm |
|---|---|---|---|
| `read_document` | read | ASM, ISR | — |
| `attach_document` | write | ASM, ISR | `dealer_lead_documents` rows |
| `update_lead` | write | ASM, ISR | `dealer_leads` shop_name / area / city / state / pincode / contact_email / gstin (+ optional source document). From a document it only FILLS empty fields; a disagreeing value is kept and named on the card. |
| `create_lead` (extended) | write | ASM, ISR | + area / pincode / email / GSTIN, + the source card filed |
| `log_visit` (extended) | write | ASM | `lead_visits.photos` + `gps_check_in_lat/lng`, distance note in the remarks |

Field changes are audited by the existing E-304 trigger (the executor sets `app.actor_id`).

## Data (E-311, additive)

- `assistant_media` — every received image / document / location; `used_at`, `used_by_action_id`.
- `dealer_lead_documents` — documents on a dealer lead (`lead_documents` is the customer/loan family).

## Error handling

| Case | Reply / behaviour |
|---|---|
| > 10 MB | fixed "too big" reply |
| Word / Excel / other type | fixed "photos or PDFs" reply (refused before download when Meta names the type) |
| Download / S3 failure | fixed "couldn't save that file, nothing was changed" |
| Sticker / video / contact | fixed reply naming what works |
| Reader fails | `unavailable` → the agent asks the rep to type the details |
| Malformed GSTIN / email / pincode / phone | dropped by the reader; a question from the write tools |
| Wrong dealer's document | the agent asks; server-side `update_lead` never replaces a filled field from a document |
| Geocoder down / address unknown | "location saved (shop address not mapped)" |
| E-311 not applied | turn context skips attachments; storing fails → fixed reply; documents tab shows visit photos only |
| Kill switch | `WA_ASSIST_MEDIA_DISABLED=true` → the old "typed / voice only" reply |

## Testing

- Unit: `media-tools.test.ts` (tools + appliers), `media-helpers.test.ts` (refs, context block, reader checks + fallback, geo), router attachment tests, parser tests.
- Live on sandbox (`scripts/_media-e2e.mts`, applies each proposed write in a rolled-back transaction):
  new dealer's visiting card → `create_lead` with the card filed; the wrong dealer's GST certificate → the agent asks;
  the right one → `update_lead` fills only empty fields + files the PDF; E-304 audit names the rep.
