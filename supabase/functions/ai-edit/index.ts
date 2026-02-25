/**
 * Supabase Edge Function: ai-edit
 * ─────────────────────────────────────────────────────────────────────────────
 * Receives a selected text + full note context, calls Anthropic server-side,
 * and returns 2-3 alternative rewrites in strict JSON.
 *
 * Request  (POST):
 * {
 *   action:       "rewrite"|"shorter"|"clearer"|"fix"|"tone"|"expand"|"bullets"|"example"
 *   tone:         "Professional"|"Casual"|"Strong"|"Friendly"|null
 *   noteTitle:    string|null
 *   noteContent:  string          — full note as plain text (no HTML)
 *   selectedText: string          — exact text the user highlighted
 *   before:       string|null     — up to 800 chars before selection
 *   after:        string|null     — up to 800 chars after selection
 *   languageHint: "es"|"en"|null
 * }
 *
 * Response (200):
 * { "alternatives": [ { "label": "Option 1", "text": "..." }, ... ] }
 *
 * Error:
 * { "error": "..." }
 *
 * Secrets required:
 *   ANTHROPIC_API_KEY  — set via `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`
 *
 * Deploy with:
 *   supabase functions deploy ai-edit --no-verify-jwt
 */

// ── CORS ─────────────────────────────────────────────────────────────────────
// Must be on EVERY response, including errors and the OPTIONS preflight.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Model ─────────────────────────────────────────────────────────────────────
const MODEL = "claude-sonnet-4-5-20251001";

// ── JSON schema hints ─────────────────────────────────────────────────────────
const SCHEMA_3 = `\
Return ONLY valid JSON — no prose, no markdown fences.
Schema (exactly 3 alternatives):
{"alternatives":[{"label":"Option 1","text":"..."},{"label":"Option 2","text":"..."},{"label":"Option 3","text":"..."}]}`;

const SCHEMA_2 = `\
Return ONLY valid JSON — no prose, no markdown fences.
Schema (exactly 2 alternatives):
{"alternatives":[{"label":"Option 1","text":"..."},{"label":"Option 2","text":"..."}]}`;

// ── Base system prompt ────────────────────────────────────────────────────────
const BASE_SYSTEM = `\
You are a world-class editor inside a writing app.
You will receive: note title, full note text, the exact selected text, and surrounding context.
Your job: produce alternative rewrites of ONLY the selected text.
Rules:
• Do NOT edit anything outside the selection.
• Keep consistent with the note's voice, terminology, and style.
• Do NOT introduce new facts not already present in the note or selection.
• Keep the same language as the selection (unless the action explicitly changes tone/style).
• Keep roughly the same length unless the action calls for expansion or condensation.`;

// ── Action → instruction mapping ──────────────────────────────────────────────
const ACTION_INSTRUCTIONS: Record<string, string> = {
  rewrite:
    `ACTION — Rewrite: improve flow and readability. Keep meaning identical.\n${SCHEMA_3}`,

  shorter:
    `ACTION — Shorter: condense the selection, remove redundancy, preserve core meaning. ` +
    `Trim without losing essential information.\n${SCHEMA_3}`,

  clearer:
    `ACTION — Clearer: simplify sentence structure, reduce jargon, improve comprehension. ` +
    `Do not change meaning.\n${SCHEMA_3}`,

  fix:
    `ACTION — Fix: correct grammar, spelling, and punctuation. ` +
    `Option 1 = minimal fix (change as little as possible). ` +
    `Options 2–3 = slightly more polished but still fully faithful to original.\n${SCHEMA_3}`,

  expand:
    `ACTION — Expand: elaborate slightly using ONLY ideas already present in the selection ` +
    `or note. Do NOT introduce new facts or examples not in the note.\n${SCHEMA_2}`,

  bullets:
    `ACTION — Bullets: convert the selection to a bullet list using "• " prefix for each ` +
    `item. Preserve ALL content — just restructure.\n${SCHEMA_2}`,

  example:
    `ACTION — Example: add a short, generic illustrative example that does NOT introduce ` +
    `unverifiable facts. If that is impossible, improve clarity instead.\n${SCHEMA_3}`,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildSystemPrompt(action: string, tone: string | null): string {
  if (action === "tone" && tone) {
    return (
      BASE_SYSTEM +
      `\n\nACTION — Tone (${tone}): rewrite to match this tone: ${tone}. ` +
      `Keep meaning identical. Do not add new facts.\n${SCHEMA_3}`
    );
  }
  const instruction =
    ACTION_INSTRUCTIONS[action] ?? ACTION_INSTRUCTIONS["rewrite"];
  return `${BASE_SYSTEM}\n\n${instruction}`;
}

function buildUserMessage(params: {
  noteTitle: string;
  noteContent: string;
  selectedText: string;
  before: string;
  after: string;
  action: string;
  tone: string | null;
}): string {
  return [
    "TITLE:",
    params.noteTitle || "(untitled)",
    "",
    "FULL NOTE:",
    params.noteContent || "(empty)",
    "",
    "SELECTION:",
    params.selectedText,
    "",
    "SURROUNDING CONTEXT:",
    "BEFORE:",
    params.before || "(start of note)",
    "AFTER:",
    params.after || "(end of note)",
    "",
    "ACTION:",
    params.action + (params.tone ? ` (tone: ${params.tone})` : ""),
  ].join("\n");
}

function getTemperature(action: string): number {
  return action === "tone" || action === "rewrite" || action === "example"
    ? 0.3
    : 0.2;
}

// Wraps every JSON response with CORS headers — used for ALL paths.
function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface Alternative {
  label: string;
  text: string;
}

interface ParsedResult {
  alternatives?: Alternative[];
}

function parseAlternatives(raw: string): ParsedResult {
  const clean = raw
    .replace(/```json[\s\S]*?```/g, (s) => s.replace(/```json|```/g, "").trim())
    .replace(/```[\s\S]*?```/g, (s) => s.replace(/```/g, "").trim())
    .trim();

  const jsonStart = clean.indexOf("{");
  const jsonEnd = clean.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < 0) {
    throw new Error("No JSON object found in model response");
  }
  return JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {

  // ✅ OPTIONS preflight — must return 200 immediately, no auth, no body parsing.
  // Browsers send this before every cross-origin POST; if it fails the real
  // request is never sent and the user sees a CORS error.
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  // All remaining logic is inside try/catch so that every error path —
  // including unexpected throws — still returns CORS headers.
  try {

    if (req.method !== "POST") {
      return jsonRes({ error: "Method not allowed" }, 405);
    }

    // ── API key ──────────────────────────────────────────────────────────
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      console.error("[ai-edit] ANTHROPIC_API_KEY secret not set");
      return jsonRes({ error: "API key not configured" }, 500);
    }

    // ── Parse body ───────────────────────────────────────────────────────
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonRes({ error: "Invalid JSON body" }, 400);
    }

    const {
      action,
      tone = null,
      noteTitle = "",
      noteContent = "",
      selectedText,
      before = "",
      after = "",
      // languageHint accepted but unused: model preserves source language naturally
    } = body as {
      action: string;
      tone?: string | null;
      noteTitle?: string;
      noteContent?: string;
      selectedText: string;
      before?: string;
      after?: string;
      languageHint?: string | null;
    };

    // ── Validate ─────────────────────────────────────────────────────────
    if (!action || typeof action !== "string") {
      return jsonRes({ error: 'Missing or invalid "action"' }, 400);
    }

    const selectedTrimmed = String(selectedText ?? "").trim();
    if (!selectedTrimmed) {
      return jsonRes({ error: 'Missing or empty "selectedText"' }, 400);
    }

    const validActions = [
      "rewrite", "shorter", "clearer", "fix",
      "tone", "expand", "bullets", "example",
    ];
    if (!validActions.includes(action)) {
      return jsonRes({ error: `Unknown action: ${action}` }, 400);
    }
    if (action === "tone" && !tone) {
      return jsonRes(
        { error: '"tone" value is required when action is "tone"' },
        400,
      );
    }

    // ── Build prompts ────────────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(action, tone as string | null);
    const userMessage = buildUserMessage({
      noteTitle:    String(noteTitle   || ""),
      noteContent:  String(noteContent || ""),
      selectedText: selectedTrimmed,
      before:       String(before || ""),
      after:        String(after  || ""),
      action,
      tone: tone as string | null,
    });

    // ── Call Anthropic ───────────────────────────────────────────────────
    let anthropicRes: Response;
    try {
      anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key":         apiKey,
          "anthropic-version": "2023-06-01",
          "content-type":      "application/json",
        },
        body: JSON.stringify({
          model:       MODEL,
          max_tokens:  2000,
          temperature: getTemperature(action),
          system:      systemPrompt,
          messages:    [{ role: "user", content: userMessage }],
        }),
      });
    } catch (err) {
      console.error("[ai-edit] Anthropic network error:", err);
      return jsonRes({ error: "Network error reaching AI" }, 502);
    }

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text().catch(() => "");
      console.error(
        "[ai-edit] Anthropic API error:",
        anthropicRes.status,
        errBody,
      );
      return jsonRes({ error: `AI API error: ${anthropicRes.status}` }, 502);
    }

    // ── Parse response ───────────────────────────────────────────────────
    const responseData = await anthropicRes.json();
    const raw: string = responseData.content?.[0]?.text ?? "";

    let parsed: ParsedResult;
    try {
      parsed = parseAlternatives(raw);
    } catch (parseErr) {
      console.error("[ai-edit] JSON parse failed. Raw:", raw, parseErr);
      return jsonRes({ error: "parse_failed", raw }, 200);
    }

    if (!parsed.alternatives || !Array.isArray(parsed.alternatives)) {
      console.error("[ai-edit] bad_schema. Parsed:", parsed);
      return jsonRes({ error: "bad_schema" }, 200);
    }

    // Normalise + filter empty options
    const alternatives: Alternative[] = parsed.alternatives
      .map((alt, i) => ({
        label: String(alt.label ?? `Option ${i + 1}`),
        text:  String(alt.text  ?? ""),
      }))
      .filter((alt) => alt.text.trim().length > 0);

    if (alternatives.length === 0) {
      return jsonRes({ error: "empty_alternatives" }, 200);
    }

    return jsonRes({ alternatives });

  } catch (err) {
    // Last-resort catch: any unhandled throw still gets CORS headers so the
    // browser receives a readable error instead of an opaque network failure.
    console.error("[ai-edit] Unhandled error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
