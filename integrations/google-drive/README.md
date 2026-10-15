# Google Drive → PUB INVOICES

The importer polls one explicitly configured folder, preserves the original bytes
in the existing private `invoice-sources` bucket, computes SHA-256, and creates an
existing `invoice_capture_jobs` record. It never approves invoices, inserts stock
movements, updates purchase prices or writes financial records.

## Install

1. Apply `supabase/migrations/20261014054956_invoice_drive_import.sql` after the
   existing capture-queue migrations. The migration adds isolated tables/RPCs and
   allows HEIC/HEIF in the private bucket; it does not rewrite existing invoices.
2. Deploy `supabase/functions/invoice-drive-import` with `verify_jwt=false`. This
   is required for the dedicated 256-bit import capability; **the function still
   authenticates every request** against its hash and source in the database.
   Browser roles cannot execute `invoice_drive_worker`. The service key comes
   from automatic Supabase function environment variables and stays on the server.
3. Deploy the web change. In Faktury → Automatický import z Drive → Propojit
   složku, a signed-in owner/manager pastes the folder URL. The destination venue
   is shown explicitly. One active folder cannot route to two destinations.
4. Copy the generated manifest and script into a **private** Apps Script project
   belonging to the Google user who can read that folder. Run `configurePubGuru`.
   Google consent is required once; the trigger runs approximately every 5 minutes.
   Reconfiguration rotates the capability and stops old in-flight requests.
5. Follow [the iPhone guide](iphone.html). The existing Photos/iCloud album may
   stay in use; selected invoices are shared to Google Drive. The public iCloud
   sharing URL is not scraped or used as a permanent authentication mechanism.

The Google connector connected to ChatGPT does not grant a separately deployed
app an OAuth refresh token. This design deliberately requires consent in the
user's Google account. Apps Script's short-lived read-only access token is sent
to the importer for that invocation only, never persisted or logged. The scope
is Google's `drive.readonly`, which authorizes reading the user's accessible
Drive files; the importer itself limits listing and downloading to the pinned
folder and verifies each file's parents before and after download. No Drive
file is moved, modified, marked or deleted. There is no public Apps Script web
app endpoint and no stored Google password or refresh token.

## Recovery, integrity and scope

- Each poll has a 5-minute fenced lease. A later poll recovers after a killed
  function. Each file/version is reserved durably; repeated failures have bounded
  backoff and become visible. An owner/manager can retry without changing originals.
- The cursor advances only after a fully handled page. Invalid cursors restart
  the scan. Full recurring rescans catch older files moved into the folder and
  items inserted during pagination. Every poll checks the most recently modified
  page before continuing older pages, so new files do not wait behind a large
  backfill. Only direct children are scanned; subfolders,
  Google document types, Drive shortcuts and unsupported files are ignored.
- Downloads are streamed with an 8 MB cap, format signatures and version/parent
  checks. A changed file is retried as a new Drive version. Metadata links keep
  the original Drive file ID, version and filename independently of the queue.
- After existing OCR completes, a metadata-only trigger links those imports to
  the reviewed invoice. That association survives deletion of a completed job.
  The Drive link opens the current file; the captured version's original bytes
  remain in private storage even if the Drive file is later changed.
- Content hashes deduplicate renamed copies within the existing organization-wide
  index. A duplicate assigned to another venue is a visible routing error with
  no foreign invoice/job link. A shared per-hash transaction lock and source
  scope triggers also protect manual captures racing the importer. They run on
  source/scope inserts or changes, not on approval status updates. Different
  organizations retain independent jobs.
- Deterministic storage paths recover uploads whose HTTP response was lost.
  A pre-existing object must have matching SHA-256; it is never overwritten or
  deleted on retry. This also stores an exact original when an older manual
  invoice/queue job only retained a compressed image or no image; an existing
  invoice is linked without creating another one. Each import retains its own
  original storage path and offers authenticated download in the status panel.
  Enqueue and source association commit together. Lost enqueue
  responses reconcile via an idempotent failure command.
- The user's live owner/manager membership is checked for each worker operation.
  Disconnecting or rotating invalidates the capability and any live lease.
  Capability hashes and cursors are private and not readable by browser roles.

## OCR and approval

The existing browser queue automatically claims imported jobs while Faktury is
open. Safari/PWA uses the existing Tesseract path; the installed native wrapper
may use Apple Vision. HEIC is decoded natively when possible, otherwise via a
pinned local `heic2any@0.0.4` asset. Only the temporary reading copy changes;
the existing queued original fingerprint stays attached to the invoice.

Import runs with the browser closed; **current OCR does not**. Server AI PR #34
has a separate provider/hosting configuration prerequisite. This change neither
enables an unconfigured provider nor silently substitutes an AI result. It is
compatible with the queue/price integration PR #35 and leaves invoice capture,
validation, approval and posting implementations unchanged.

## Verify

Use fictional fixtures only:

```sh
node --test tests/pos-web/invoice-drive-db.test.cjs tests/pos-web/invoice-drive-api.test.cjs
npm test --prefix tests/pos-web
node --test tests/*.test.js
npm run test:drive-import --prefix tests/pos-browser
```

The Drive/Storage network is intercepted and queue/RLS transitions execute real
SQL in isolated PGlite. Header fixtures test routing and transport; they do not
prove a real invoice's OCR accuracy. Device permission dialogs, Google consent,
the first trigger run and on-device iPhone sharing must be verified after setup.
The browser test additionally decodes a real synthetic HEIC with the pinned WASM
decoder, runs the actual crop/parser/queue pipeline with a simulated fictional
OCR result, and verifies exactly one review invoice, no stock, preserved original
bytes and layouts at 390/820/1440 px. CI gates publication on this test.

## Disable

Use Odpojit in PUB INVOICES first; it revokes the source capability. Run
`stopPubGuru` in Apps Script to remove its trigger, then delete/revoke the private
script as desired. Disconnecting leaves imported originals, jobs and history intact.
