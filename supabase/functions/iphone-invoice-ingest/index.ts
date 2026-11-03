import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const authorization = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return json({ error: "authentication_required" }, 401);
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !anon) return json({ error: "server_not_configured" }, 503);
    const db = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
    const { data: { user }, error: authError } = await db.auth.getUser(authorization.replace(/^Bearer\s+/i, ""));
    if (authError || !user) return json({ error: "invalid_session" }, 401);
    if (Number(req.headers.get("content-length") || 0) > 12_000_000) return json({ error: "request_too_large" }, 413);
    const body = await req.json();
    const { organization_id: org, venue_id: venue, image_base64: encoded, ocr_text: ocrText } = body || {};
    if (!UUID.test(org || "") || !UUID.test(venue || "") || typeof encoded !== "string" ||
        typeof ocrText !== "string" || ocrText.length > 150_000) return json({ error: "invalid_payload" }, 400);
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16) return json({ error: "image_too_large" }, 413);
    const { data: membership, error: membershipError } = await db.from("memberships").select("role")
      .eq("organization_id", org).eq("user_id", user.id).maybeSingle();
    if (membershipError || !membership || !["owner", "manager", "staff"].includes(membership.role))
      return json({ error: "access_denied" }, 403);
    const { data: validVenue, error: venueError } = await db.from("venues").select("id")
      .eq("id", venue).eq("organization_id", org).maybeSingle();
    if (venueError || !validVenue) return json({ error: "venue_not_found" }, 403);
    const raw = encoded.replace(/^data:image\/(jpeg|png);base64,/i, "");
    if (!/^[a-z0-9+/]+={0,2}$/i.test(raw) || raw.length % 4 !== 0)
      return json({ error: "invalid_base64" }, 400);
    const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return json({ error: "image_size_invalid" }, 413);
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes.slice(0, 8).every((v, i) => v === [137,80,78,71,13,10,26,10][i]);
    if (!jpeg && !png) return json({ error: "unsupported_image" }, 415);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map(x => x.toString(16).padStart(2, "0")).join("");
    const { data: existing, error: lookupError } = await db.from("invoice_capture_jobs")
      .select("id,status").eq("organization_id", org).eq("source_fingerprint", hash).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) return json({ status: "duplicate", job_id: existing.id });
    const jobId = crypto.randomUUID();
    const ext = jpeg ? "jpg" : "png";
    const path = `${org}/${venue}/${user.id}/${jobId}.${ext}`;
    const { error: uploadError } = await db.storage.from("invoice-sources").upload(path, bytes, {
      contentType: jpeg ? "image/jpeg" : "image/png", upsert: false,
    });
    if (uploadError) throw uploadError;
    const { error: insertError } = await db.from("invoice_capture_jobs").insert({
      id: jobId, organization_id: org, venue_id: venue, created_by: user.id,
      source_path: path, source_file_name: `iphone-${jobId}.${ext}`,
      source_fingerprint: hash, mime_type: jpeg ? "image/jpeg" : "image/png",
      status: "queued", apple_ocr_text: ocrText,
    });
    if (insertError) {
      await db.storage.from("invoice-sources").remove([path]);
      if (insertError.code === "23505") return json({ status: "duplicate" });
      throw insertError;
    }
    return json({ status: "queued", job_id: jobId }, 202);
  } catch (error) {
    console.error("iphone invoice ingest", error);
    return json({ error: "ingest_failed" }, 500);
  }
});
