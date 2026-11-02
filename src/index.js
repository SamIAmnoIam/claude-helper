// claude-helper: reads photos (receipts, pool test strips) with Claude for Sam's apps.
// Only signed-in users of an allowed app can use it, so nobody else can run up the bill.

const APPS = {
  "https://shopping-app.gunn-pax-bellum.workers.dev": "SHOPPING",
  // Add the pool app's address here when it is wired up, e.g.:
  // "https://pool-app.gunn-pax-bellum.workers.dev": "POOL",
};
const MODEL = "claude-sonnet-5-5";
const MAX_IMAGES = 6;
const MAX_BODY = 12 * 1024 * 1024; // 12 MB of photos per request

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const app = APPS[origin];
    const cors = {
      "Access-Control-Allow-Origin": app ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Vary": "Origin",
    };
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { status: app ? 204 : 403, headers: cors });
    if (!app) return reply(403, { error: "app_not_allowed" });
    if (req.method !== "POST") return reply(405, { error: "post_only" });
    if (Number(req.headers.get("Content-Length") || 0) > MAX_BODY) return reply(413, { error: "too_large" });

    // 1. Check the person is signed in to that app's Supabase project.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return reply(401, { error: "not_signed_in" });
    const sbUrl = env[`${app}_SUPABASE_URL`], sbKey = env[`${app}_SUPABASE_KEY`];
    const who = await fetch(`${sbUrl}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: sbKey } });
    if (!who.ok) return reply(401, { error: "not_signed_in" });

    // 2. Validate the request.
    let body;
    try { body = await req.json(); } catch { return reply(400, { error: "bad_json" }); }
    const { prompt, images } = body || {};
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 40000) return reply(400, { error: "bad_prompt" });
    if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGES) return reply(400, { error: "bad_images" });
    const ok = ["image/jpeg", "image/png", "image/webp"];
    if (images.some(i => !ok.includes(i?.media_type) || typeof i?.data !== "string")) return reply(400, { error: "bad_images" });

    // 3. Ask Claude.
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: "Reply with only the JSON requested. No preamble, no markdown fences.",
        messages: [{
          role: "user",
          content: [
            ...images.map(i => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    if (r.status === 429) return reply(429, { error: "rate_limited" });
    if (!r.ok) return reply(502, { error: "claude_error", status: r.status });
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    return reply(200, { text });
  },
};
