export const config = { runtime: 'edge' };

// ── System prompts keyed by action ──────────────────────────────────────────
const SCHEMA_HINT =
  'Return ONLY valid JSON, no prose, no markdown fences.\n' +
  'Schema: {"alternatives":[{"label":"Option 1","text":"..."},{"label":"Option 2","text":"..."},{"label":"Option 3","text":"..."}]}';

const SYSTEM_PROMPTS = {
  rewrite:
    'You are a professional editor.\n' +
    'Rewrite the text to improve flow and readability.\n' +
    'Keep meaning identical and language unchanged.\n' +
    'Return 3 alternatives.\n' + SCHEMA_HINT,

  shorter:
    'You are a professional editor.\n' +
    'Condense the text while preserving meaning. Remove redundancy. Keep tone similar.\n' +
    'Return 3 alternatives.\n' + SCHEMA_HINT,

  clearer:
    'You are a professional editor.\n' +
    'Improve clarity and structure. Prefer simpler sentence construction.\n' +
    'Avoid jargon where possible without changing meaning.\n' +
    'Return 3 alternatives.\n' + SCHEMA_HINT,

  fix:
    'You are a copy editor.\n' +
    'Fix grammar, spelling, punctuation, and small style issues.\n' +
    'Do not change tone or meaning.\n' +
    'Return 3 alternatives (Option 1 = minimal fix; Options 2–3 = slightly improved but still faithful).\n' +
    SCHEMA_HINT,

  expand:
    'You are a professional editor.\n' +
    'Add detail ONLY by elaborating existing ideas — do not introduce new facts.\n' +
    'Return 2 alternatives.\n' +
    'Return ONLY valid JSON, no prose, no markdown fences.\n' +
    'Schema: {"alternatives":[{"label":"Option 1","text":"..."},{"label":"Option 2","text":"..."}]}',

  bullets:
    'You are a professional editor.\n' +
    'Preserve all content but format as a concise bullet list using "• " prefix for each item.\n' +
    'Return 2 alternatives.\n' +
    'Return ONLY valid JSON, no prose, no markdown fences.\n' +
    'Schema: {"alternatives":[{"label":"Option 1","text":"..."},{"label":"Option 2","text":"..."}]}',
};

function tonePrompt(tone) {
  return (
    'You are a professional editor.\n' +
    `Rewrite the text to match this tone: ${tone}.\n` +
    'Keep meaning identical. Do not add new facts. Language stays the same.\n' +
    'Return 3 alternatives.\n' + SCHEMA_HINT
  );
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response('API key not configured', { status: 500 });
  }

  let action, tone, text;
  try {
    ({ action, tone, text } = await req.json());
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!action || !text || !text.trim()) {
    return new Response('Missing action or text', { status: 400 });
  }

  let systemPrompt;
  if (action === 'tone' && tone) {
    systemPrompt = tonePrompt(tone);
  } else {
    systemPrompt = SYSTEM_PROMPTS[action];
  }
  if (!systemPrompt) {
    return new Response('Unknown action', { status: 400 });
  }

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Text to edit:\n' + text.trim() }],
      }),
    });
  } catch (err) {
    console.error('Anthropic fetch error:', err);
    return new Response('Network error reaching AI', { status: 502 });
  }

  if (!anthropicRes.ok) {
    const errBody = await anthropicRes.text().catch(() => '');
    console.error('Anthropic API error:', anthropicRes.status, errBody);
    return new Response('AI API error', { status: 502 });
  }

  const data = await anthropicRes.json();
  const raw = data.content?.[0]?.text || '';

  let result;
  try {
    const clean = raw.replace(/```json[\s\S]*?```|```[\s\S]*?```/g, s =>
      s.replace(/```json|```/g, '').trim()
    ).trim();
    // Find the outermost JSON object
    const jsonStart = clean.indexOf('{');
    const jsonEnd   = clean.lastIndexOf('}');
    result = JSON.parse(jsonStart >= 0 ? clean.slice(jsonStart, jsonEnd + 1) : clean);
  } catch (parseErr) {
    console.error('JSON parse failed. Raw:', raw, parseErr);
    return new Response(
      JSON.stringify({ error: 'parse_failed', raw }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!result.alternatives || !Array.isArray(result.alternatives)) {
    return new Response(
      JSON.stringify({ error: 'bad_schema' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
