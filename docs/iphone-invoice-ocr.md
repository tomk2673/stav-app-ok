# iPhone OCR invoice intake (work in progress)

This branch adds a Supabase Edge Function `iphone-invoice-ingest` and the `apple_ocr_text` column. It does **not** yet implement automatic posting or unattended processing.

## Deployment prerequisites
1. Apply `database/20261103_iphone_invoice_ocr.sql`.
2. Deploy the Edge Function with JWT verification enabled.
3. Authenticate with a **user** JWT, never a service-role key stored in Shortcuts.
4. Test storage RLS for `invoice-sources` and insertion RLS for `invoice_capture_jobs`.

## Endpoint
`POST /functions/v1/iphone-invoice-ingest`
Authorization: Bearer <user access token>
Content-Type: application/json

Body:
```json
{
  "organization_id": "<uuid>",
  "venue_id": "<uuid>",
  "ocr_text": "Apple Extract Text from Image result",
  "image_base64": "<base64 encoded JPEG or PNG>"
}
```
Success: HTTP 202 `{"status":"queued","job_id":"..."}`. Duplicates return `{"status":"duplicate",...}`.

## Remaining blockers before user rollout
- Build a secure, refreshable sign-in flow for iOS Shortcuts. Do not embed a long-lived service-role or API secret in a shared shortcut.
- Build a server-side queue worker, since current `pub_guru/invoice-queue.js` only runs in an open browser.
- Make worker prefer `apple_ocr_text` when valid, then run existing parser/validation; test on real invoices.
- Post only through existing audited invoice approval path. Never automatically create stock movements from unverified OCR.
- Add integration tests for RLS, duplicates, retries, invoice line matching, and stock posting.
- Produce and install an actual iOS Shortcut and perform an end-to-end test.

This feature is intentionally NOT production-ready.
