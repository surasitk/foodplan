/**
 * Food Plan — AI nutrition estimator (Cloudflare Worker)
 * Proxies food photos to the Anthropic (Claude) vision API and returns estimated macros.
 *
 * Secrets / vars to set in Cloudflare:
 *   ANTHROPIC_API_KEY  (required, set as a Secret — never commit it)
 *   MODEL              (optional, default "claude-sonnet-4-6")
 *   ALLOWED_ORIGIN     (optional, e.g. "https://surasitk.github.io" — default "*")
 *
 * The app POSTs: { "images": ["data:image/jpeg;base64,...", ...] }
 * The Worker returns: { calories, protein, fats, carbs, items, confidence, note }
 */

const PROMPT = `You are a careful nutrition estimator. You are given a food photo (optional), a text description (optional), or both — describing ONE meal (there may be several dishes, or the same meal from multiple angles — do NOT double count).
Estimate the TOTAL nutrition for the whole meal. If a text description is provided, weigh it heavily (it may specify ingredients or portions the photo can't show).
Reply with ONLY a JSON object, no markdown, no prose, exactly in this shape:
{"calories":<kcal as number>,"protein":<grams number>,"fats":<grams number>,"carbs":<grams number>,"items":["dish — est. portion", "..."],"confidence":"low|medium|high","note":"<short note in Thai>"}
Rules: numbers only (no units, no ranges — pick a single best estimate). Account for cooking oil and sauces. If portion is unclear, assume a typical single serving.`;

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "Use POST" }, 405, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Server is missing ANTHROPIC_API_KEY" }, 500, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON body" }, 400, cors); }

    const images = Array.isArray(body.images) ? body.images : [];
    const description = (body.description || "").toString().trim();
    if (!images.length && !description) return json({ error: "No images or description provided" }, 400, cors);

    const content = [];
    for (const img of images.slice(0, 6)) {
      const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(img || "");
      const media_type = m ? m[1] : "image/jpeg";
      const data = m ? m[2] : img;
      content.push({ type: "image", source: { type: "base64", media_type, data } });
    }
    const promptText = description
      ? PROMPT + "\n\nUser-provided description (ingredients / portions — weigh this heavily): " + description
      : PROMPT;
    content.push({ type: "text", text: promptText });

    const payload = {
      model: env.MODEL || "claude-sonnet-4-6",
      max_tokens: 700,
      messages: [{ role: "user", content }],
    };

    let resp;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json({ error: "Failed to reach Anthropic", detail: String(e) }, 502, cors);
    }

    if (!resp.ok) {
      const detail = await resp.text();
      return json({ error: "Anthropic API error", status: resp.status, detail }, 502, cors);
    }

    const out = await resp.json();
    const text = (out.content || []).map(c => c.text || "").join("\n");
    const parsed = extractJSON(text);
    if (!parsed) return json({ error: "Could not parse model output", raw: text }, 502, cors);

    // normalise to numbers
    const clean = {
      calories: numOf(parsed.calories),
      protein: numOf(parsed.protein),
      fats: numOf(parsed.fats),
      carbs: numOf(parsed.carbs),
      items: Array.isArray(parsed.items) ? parsed.items.slice(0, 12) : [],
      confidence: parsed.confidence || "",
      note: parsed.note || "",
    };
    return json(clean, 200, cors);
  },
};

function numOf(v) {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(/[, ]/g, ""));
  return isNaN(n) ? 0 : n;
}
function extractJSON(t) {
  try { return JSON.parse(t); } catch {}
  const m = t && t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}
