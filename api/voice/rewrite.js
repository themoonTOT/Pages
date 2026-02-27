/**
 * /api/voice/rewrite
 * POST { text, voice_profile, sliders }
 * Returns { alternatives: [{title, text}] }
 *
 * Calls Anthropic Claude to produce 3 rewrites of a passage
 * in the user's established voice: Default, Bolder, Shorter.
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

// ── Prompt builders ──────────────────────────────────────────────────────────

function buildSystem(voiceProfile, sliders) {
  const s = sliders || { formal: 50, concise: 50, opinionated: 50 };

  // Map 0-100 sliders to plain-English descriptors
  const formalDesc     = s.formal      < 34 ? 'conversational and informal'
                       : s.formal      > 66 ? 'formal and professional'
                       :                      'semi-formal';
  const conciseDesc    = s.concise     < 34 ? 'expressive and elaborated'
                       : s.concise     > 66 ? 'very concise and tight'
                       :                      'balanced in length';
  const opinionDesc    = s.opinionated < 34 ? 'neutral and objective'
                       : s.opinionated > 66 ? 'strongly opinionated and direct'
                       :                      'mildly opinionated';

  // Voice profile summary (chips + learned_text if available)
  let voiceDesc = '';
  if (voiceProfile) {
    const chips = Array.isArray(voiceProfile.chips)
      ? voiceProfile.chips.map(c => `${c.label}: ${c.value}`).join(', ')
      : '';
    const learned = voiceProfile.learned_text || '';
    if (chips)   voiceDesc += `\nVoice profile: ${chips}.`;
    if (learned) voiceDesc += `\n${learned}`;
  }

  return `You are a writing assistant that rewrites passages in the author's established voice.${voiceDesc}

Style constraints:
- Register: ${formalDesc}
- Length style: ${conciseDesc}
- Stance: ${opinionDesc}

Always preserve the core meaning and facts of the original. Do not add information that isn't implied by the source. Output ONLY valid JSON — no markdown fences, no commentary.`;
}

const USER_TEMPLATE = (text) => `Rewrite the passage below in three distinct ways. Return ONLY valid JSON:

{
  "alternatives": [
    {
      "title": "Default",
      "text": "A faithful rewrite in the author's voice, respecting all style constraints."
    },
    {
      "title": "Bolder",
      "text": "Same content but with stronger word choices, more confident stance, punchier sentences. Still within the voice profile."
    },
    {
      "title": "Shorter",
      "text": "Tightest possible version — cut every unnecessary word without losing the core idea."
    }
  ]
}

Rules:
- Each alternative must be meaningfully different from the others.
- "Bolder" should feel assertive but not aggressive.
- "Shorter" must be at least 20% shorter than the Default.
- Never add placeholder text like "..." or "[...]".
- Output only the JSON object above, nothing else.

Original passage:
"""
${text.slice(0, 4000)}
"""`;

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS });
  if (req.method !== 'POST')   return err('Method not allowed', 405);

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return err('AI not configured', 503);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON body', 400); }

  const { text, voice_profile, sliders } = body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return err('text is required', 400);
  }
  if (text.trim().length < 10) {
    return err('text is too short to rewrite', 400);
  }

  const systemPrompt = buildSystem(voice_profile, sliders);
  const userMessage  = USER_TEMPLATE(text.trim());

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
        max_tokens: 1200,
        system:     systemPrompt,
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

  // Strip markdown fences if model adds them anyway
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

  // Validate / normalise
  if (!Array.isArray(result.alternatives) || result.alternatives.length === 0) {
    return err('Unexpected AI response structure', 502);
  }

  const alternatives = result.alternatives.map(alt => ({
    title: String(alt.title || 'Variant'),
    text:  String(alt.text  || ''),
  })).filter(a => a.text.trim());

  return json({ alternatives });
}
