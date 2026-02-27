/**
 * /api/voice/analyze
 * POST { samples: [{source, content}], sliders?: {formal, concise, opinionated} }
 * Returns { chips: [{label, value}], learned_text, sliders }
 *
 * Calls Anthropic Claude to infer writing voice from sample(s).
 * Reuses the same edge-function pattern as /api/ai-edit.js.
 */

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
function err(msg, status = 400) { return json({ error: msg }, status); }

// ── Deterministic prompt ──────────────────────────────────────────────────────
const SYSTEM = `You are a writing-voice analyst. Given one or more writing samples, analyze the author's voice and return a JSON object. Be specific and insightful — avoid generic statements. Reference actual patterns from the text.`;

const USER_TEMPLATE = `Analyze the writing sample(s) below and return ONLY valid JSON in exactly this format (no markdown fences, no extra text):

{
  "chips": [
    {"label": "Tone",      "value": "..."},
    {"label": "Clarity",   "value": "..."},
    {"label": "Structure", "value": "..."},
    {"label": "Energy",    "value": "..."},
    {"label": "Length",    "value": "..."},
    {"label": "Language",  "value": "..."}
  ],
  "learned_text": "2-3 sentences. Be concrete. Reference actual phrases or patterns from the sample. No openers like 'Your writing shows…'.",
  "sliders": {"formal": 50, "concise": 50, "opinionated": 50}
}

Rules for each chip:
- Tone: 1-3 adjectives capturing authentic voice (e.g. "Analytical, Wry", "Warm, Direct").
- Clarity: High / Medium / Low.
- Structure: e.g. "Argument-driven", "Narrative arcs", "List-heavy", "Essay-style", "Stream of consciousness".
- Energy: e.g. "Calm authority", "Urgent", "Contemplative", "Assertive", "Playful".
- Length: Short / Medium / Long (based on typical sentence and paragraph length).
- Language: Primary language(s) used (e.g. "English", "Spanish", "Spanish / English").

Rules for sliders (0–100):
- formal:      0 = very conversational, 100 = very formal.
- concise:     0 = very expressive / verbose, 100 = very concise.
- opinionated: 0 = neutral / objective, 100 = strongly opinionated.

Writing sample(s):
`;

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS });
  if (req.method !== 'POST')   return err('Method not allowed', 405);

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return err('AI not configured', 503);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON body', 400); }

  const { samples, sliders: clientSliders } = body;
  if (!Array.isArray(samples) || samples.length === 0) {
    return err('At least one sample required', 400);
  }

  // Build the content block
  const samplesBlock = samples
    .filter(s => s.content && s.content.trim())
    .map((s, i) => `=== Sample ${i + 1} [${s.source || 'paste'}] ===\n${s.content.slice(0, 6000)}`)
    .join('\n\n');

  if (!samplesBlock.trim()) return err('No usable content in samples', 400);

  const userMessage = USER_TEMPLATE + samplesBlock;

  // Call Anthropic
  let aiRes;
  try {
    aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-5',
        max_tokens: 700,
        system:     SYSTEM,
        messages:   [{ role: 'user', content: userMessage }],
      }),
      signal: AbortSignal.timeout(28_000),
    });
  } catch (e) {
    return err('AI request failed: ' + String(e), 502);
  }

  if (!aiRes.ok) {
    const t = await aiRes.text().catch(() => '');
    return err('AI error ' + aiRes.status + ': ' + t.slice(0, 200), 502);
  }

  const aiData  = await aiRes.json();
  const rawText = (aiData.content?.[0]?.text || '').trim();

  // Strip markdown code fences if present
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let result;
  try {
    result = JSON.parse(cleaned);
  } catch {
    return err('Failed to parse AI response: ' + cleaned.slice(0, 200), 502);
  }

  // Normalise
  if (!Array.isArray(result.chips))       result.chips       = [];
  if (typeof result.learned_text !== 'string') result.learned_text = '';
  if (!result.sliders || typeof result.sliders !== 'object') {
    result.sliders = { formal: 50, concise: 50, opinionated: 50 };
  }

  // Merge client slider overrides (when called after user moves a slider)
  if (clientSliders && typeof clientSliders === 'object') {
    result.sliders = { ...result.sliders, ...clientSliders };
  }

  return json({
    chips:        result.chips,
    learned_text: result.learned_text,
    sliders:      result.sliders,
  });
}
