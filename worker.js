/**
 * Food Plan — AI nutrition estimator (Cloudflare Workers AI, free)
 * Uses the built-in Workers AI binding (no external API key needed).
 *
 * Setup in Cloudflare:
 *   Settings -> Bindings -> Add -> Workers AI -> Variable name: AI
 *   (Optional) Settings -> Variables -> ALLOWED_ORIGIN = https://surasitk.github.io
 *
 * The app POSTs: { "images": ["data:image/jpeg;base64,...", ...], "description": "..." }
 * Returns: { calories, protein, fats, carbs, items, confidence, note }
 */

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const PROMPT = `You are a careful nutrition estimator. You are given a food photo (optional), a text description (optional), or both, describing ONE meal. Estimate the TOTAL nutrition for the whole meal. If a text description is provided, weigh it heavily.
Reply with ONLY a JSON object, no markdown, no extra words, exactly this shape:
{"calories":<kcal number>,"protein":<grams number>,"fats":<grams number>,"carbs":<grams number>,"items":["dish - est portion","..."],"confidence":"low|medium|high","note":"<short note in Thai>"}
Rules: numbers only (no units, no ranges). Account for cooking oil and sauces. If portion is unclear assume one typical serving.`;

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
    if (!env.AI) return json({ error: "Workers AI binding 'AI' is not configured" }, 500, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON body" }, 400, cors); }

    const images = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
    const description = (body.description || "").toString().trim();
    if (!images.length && !description) return json({ error: "No images or description provided" }, 400, cors);

    const content = [{ type: "text", text: description ? PROMPT + "\n\nUser description (weigh heavily): " + description : PROMPT }];
    for (const img of images) {
      if (typeof img === "string" && img.startsWith("data:")) {
        content.push({ type: "image_url", image_url: { url: img } });
      }
    }

    let out;
    try {
      out = await runModel(env, { messages: [{ role: "user", content }], max_tokens: 700, temperature: 0.2 });
    } catch (e) {
      return json({ error: "AI run failed", detail: String(e && e.message || e) }, 502, cors);
    }

    const text = pickText(out);
    const parsed = extractJSON(text);
    if (!parsed) return json({ error: "Could not parse model output", raw: JSON.stringify(out).slice(0, 600) }, 502, cors);

    return json({
      calories: numOf(parsed.calories),
      protein: numOf(parsed.protein),
      fats: numOf(parsed.fats),
      carbs: numOf(parsed.carbs),
      items: Array.isArray(parsed.items) ? parsed.items.slice(0, 12) : [],
      confidence: parsed.confidence || "",
      note: parsed.note || "",
    }, 200, cors);
  },
};

async function runModel(env, payload) {
  try {
    return await env.AI.run(MODEL, payload);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/agree|license|consent|accept/i.test(msg)) {
      try { await env.AI.run(MODEL, { prompt: "agree" }); } catch (_) {}
      return await env.AI.run(MODEL, payload);
    }
    throw e;
  }
}

function pickText(out) {
  if (out == null) return "";
  if (typeof out === "string") return out;
  const r = out.response;
  if (typeof r === "string") return r;
  if (r && typeof r === "object") {
    if (typeof r.content === "string") return r.content;
    if (typeof r.text === "string") return r.text;
    if (Array.isArray(r.content)) return r.content.map(c => (c && (c.text || c.content)) || "").join("\n");
    return JSON.stringify(r);
  }
  if (typeof out.result === "string") return out.result;
  if (out.result && typeof out.result.response === "string") return out.result.response;
  if (typeof out.text === "string") return out.text;
  if (Array.isArray(out.choices) && out.choices[0]) {
    const m = out.choices[0].message || out.choices[0];
    if (m && typeof m.content === "string") return m.content;
  }
  return JSON.stringify(out);
}
function numOf(v) {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(/[, ]/g, ""));
  return isNaN(n) ? 0 : n;
}
function extractJSON(t) {
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}
