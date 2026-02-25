/**
 * /api/ai-edit  —  AI selection-editing endpoint
 *
 * Called by the client-side AI Edit Bar when the user clicks a quick action
 * (Rewrite, Shorter, Clearer, Fix, Tone, Expand, Bullets) on selected text.
 *
 * Contract
 * ────────
 * POST /api/ai-edit
 * Request body (JSON):
 * {
 *   action:           "rewrite" | "shorter" | "clearer" | "fix" | "tone" |
 *                     "expand"  | "bullets" | "example",
 *   tone:             "Professional" | "Casual" | "Strong" | "Friendly" | null,
 *   noteId:           string | null,
 *   noteTitle:        string | null,
 *   noteContent:      string,           // full note plain-text (no HTML)
 *   selectedText:     string,           // exact text to rewrite
 *   selectionContext: { before: string, after: string },   // ±800 chars
 *   languageHint:     "es" | "en" | null
 * }
 *
 * Response (200):
 * { "alternatives": [ { "label": "Option 1", "text": "..." }, ... ] }
 *
 * Error (4xx/5xx):
 * { "error": "..." }
 */

export const config = { runtime: 'edge' };

// ── Model ────────────────────────────────────────────────────────────────────
// Use Sonnet class (better quality than Haiku for editing tasks).
const MODEL = 'claude-sonnet-4-6';

// ── JSON schema hint appended to every system prompt ────────────────────────
const SCHEMA_3 =
  'Return ONLY valid JSON — no prose, no markdown fences.\n' +
  'Schema (exactly 3 alternatives):\n' +
  '{"alternatives":[' +
  '{"label":"Option 1","text":"..."},' +
  '{"label":"Option 2","text":"..."},' +
  '{"label":"Option 3","text":"..."}' +
  ']}';

const SCHEMA_2 =
  'Return ONLY valid JSON — no prose, no markdown fences.\n' +
  'Schema (exactly 2 alternatives):\n' +
  '{"alternatives":[' +
  '{"label":"Option 1","text":"..."},' +
  '{"label":"Option 2","text":"..."}' +
  ']}';

// ── Base system prompt (common to all actions) ───────────────────────────────
const BASE_SYSTEM = `\
You are a world-class editor inside a writing app.
You will receive: note title, full note text, the exact selected text, and surrounding context.
Your job: produce alternative rewrites of ONLY the selected text.
Rules:
• Do NOT edit anything outside the selection.
• Keep consistent with the note's voice, terminology, and style.
• Do NOT introduce new facts not already present in the note or selection.
• Keep the same language as the selection (unless the action changes tone/style).
• Keep roughly the same length unless the action calls for expansion/condensation.`;

// ── Build author profile context block ──────────────────────────────────────
function buildProfileContext(userProfile) {
  if (!userProfile) return '';
  const lines = [];
  if (userProfile.tone)       lines.push(`• Preferred tone: ${userProfile.tone}`);
  if (userProfile.audience)   lines.push(`• Target audience: ${userProfile.audience}`);
  if (userProfile.intent)     lines.push(`• Writing intent: ${userProfile.intent}`);
  if (userProfile.languages && userProfile.languages.length > 0) {
    lines.push(`• Languages: ${userProfile.languages.join(', ')}`);
  }
  if (userProfile.style_notes && userProfile.style_notes.trim()) {
    lines.push(`• Style notes: ${userProfile.style_notes.trim()}`);
  }
  if (!lines.length) return '';
  return '\n\nAUTHOR PROFILE (adapt your output to match these preferences):\n' + lines.join('\n');
}

// ── Action → instruction mapping ─────────────────────────────────────────────
// Each value is appended to BASE_SYSTEM to form the final system prompt.
const ACTION_INSTRUCTIONS = {
  rewrite:
    'ACTION — Rewrite: improve flow and readability. ' +
    'Keep meaning identical.\n' + SCHEMA_3,

  shorter:
    'ACTION — Shorter: condense the selection, remove redundancy, keep core meaning. ' +
    'Trim without losing essential information.\n' + SCHEMA_3,

  clearer:
    'ACTION — Clearer: simplify sentence structure, reduce jargon, improve comprehension. ' +
    'Do not change meaning.\n' + SCHEMA_3,

  fix:
    'ACTION — Fix: correct grammar, spelling, and punctuation. ' +
    'Option 1 = minimal fix (change as little as possible). ' +
    'Options 2–3 = slightly more polished but still fully faithful to original.\n' + SCHEMA_3,

  tone:
    // Filled in by buildSystemPrompt when tone is provided
    '',

  expand:
    'ACTION — Expand: elaborate slightly using ONLY ideas already present in the selection or note. ' +
    'Do NOT introduce new facts or examples not in the note.\n' + SCHEMA_2,

  bullets:
    'ACTION — Bullets: convert the selection to a bullet list using "• " prefix for each item. ' +
    'Preserve ALL content — just restructure.\n' + SCHEMA_2,

  example:
    'ACTION — Example: add a short, generic illustrative example that does NOT introduce ' +
    'unverifiable facts. If that is impossible, improve clarity instead.\n' + SCHEMA_3,
};

function buildSystemPrompt(action, tone, userProfile) {
  const profileCtx = buildProfileContext(userProfile);
  if (action === 'tone' && tone) {
    return (
      BASE_SYSTEM +
      profileCtx +
      '\n\n' +
      `ACTION — Tone (${tone}): rewrite to match this tone: ${tone}. ` +
      'Keep meaning identical. Do not add new facts.\n' +
      SCHEMA_3
    );
  }
  const instruction = ACTION_INSTRUCTIONS[action] || ACTION_INSTRUCTIONS.rewrite;
  return BASE_SYSTEM + profileCtx + '\n\n' + instruction;
}

// ── User message builder ─────────────────────────────────────────────────────
function buildUserMessage({ noteTitle, noteContent, selectedText, selectionContext, action, tone }) {
  const before = (selectionContext && selectionContext.before) || '';
  const after  = (selectionContext && selectionContext.after)  || '';

  return [
    'TITLE:',
    noteTitle || '(untitled)',
    '',
    'FULL NOTE:',
    noteContent || '(empty)',
    '',
    'SELECTION:',
    selectedText,
    '',
    'SURROUNDING CONTEXT:',
    'BEFORE:',
    before || '(start of note)',
    'AFTER:',
    after  || '(end of note)',
    '',
    'ACTION:',
    action + (tone ? ` (tone: ${tone})` : ''),
  ].join('\n');
}

// ── Temperature per action ───────────────────────────────────────────────────
function getTemperature(action) {
  // Slightly higher for creative/tone actions; tight for corrections
  if (action === 'tone' || action === 'rewrite' || action === 'example') return 0.3;
  return 0.2;
}

// ── JSON parse helper ────────────────────────────────────────────────────────
function parseAlternatives(raw) {
  // Strip accidental markdown fences
  const clean = raw
    .replace(/```json[\s\S]*?```/g, s => s.replace(/```json|```/g, '').trim())
    .replace(/```[\s\S]*?```/g,    s => s.replace(/```/g, '').trim())
    .trim();

  const jsonStart = clean.indexOf('{');
  const jsonEnd   = clean.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < 0) throw new Error('No JSON object found');

  const parsed = JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
  if (!parsed.alternatives || !Array.isArray(parsed.alternatives)) {
    throw new Error('Missing alternatives array');
  }
  return parsed;
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonError('Method not allowed', 405);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[ai-edit] ANTHROPIC_API_KEY not set');
    return jsonError('API key not configured', 500);
  }

  // ── Parse request ────────────────────────────────────────────────────
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const {
    action,
    tone         = null,
    noteId       = null,
    noteTitle    = '',
    noteContent  = '',
    selectedText,
    selectionContext = {},
    languageHint = null,
    userProfile  = null,
  } = body;

  // ── Validate ─────────────────────────────────────────────────────────
  if (!action || typeof action !== 'string') {
    return jsonError('Missing or invalid "action"', 400);
  }
  if (!selectedText || !selectedText.trim()) {
    return jsonError('Missing or empty "selectedText"', 400);
  }

  const validActions = ['rewrite', 'shorter', 'clearer', 'fix', 'tone',
                        'expand', 'bullets', 'example'];
  if (!validActions.includes(action)) {
    return jsonError(`Unknown action: ${action}`, 400);
  }
  if (action === 'tone' && !tone) {
    return jsonError('"tone" value required when action is "tone"', 400);
  }

  // ── Build prompts ─────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(action, tone, userProfile);
  const userMessage  = buildUserMessage({
    noteTitle,
    noteContent,
    selectedText: selectedText.trim(),
    selectionContext,
    action,
    tone,
  });

  // ── Call Anthropic ────────────────────────────────────────────────────
  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:       MODEL,
        max_tokens:  2000,
        temperature: getTemperature(action),
        system:      systemPrompt,
        messages:    [{ role: 'user', content: userMessage }],
      }),
    });
  } catch (err) {
    console.error('[ai-edit] Anthropic fetch error:', err);
    return jsonError('Network error reaching AI', 502);
  }

  if (!anthropicRes.ok) {
    const errBody = await anthropicRes.text().catch(() => '');
    console.error('[ai-edit] Anthropic API error:', anthropicRes.status, errBody);
    return jsonError('AI API error: ' + anthropicRes.status, 502);
  }

  // ── Parse response ────────────────────────────────────────────────────
  const data = await anthropicRes.json();
  const raw  = data.content?.[0]?.text || '';

  let result;
  try {
    result = parseAlternatives(raw);
  } catch (parseErr) {
    console.error('[ai-edit] JSON parse failed. Raw:', raw, parseErr);
    return new Response(
      JSON.stringify({ error: 'parse_failed', raw }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Ensure labels are present
  result.alternatives = result.alternatives.map((alt, i) => ({
    label: alt.label || `Option ${i + 1}`,
    text:  alt.text  || '',
  })).filter(alt => alt.text.trim());

  if (result.alternatives.length === 0) {
    return new Response(
      JSON.stringify({ error: 'bad_schema' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Helper ────────────────────────────────────────────────────────────────────
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
