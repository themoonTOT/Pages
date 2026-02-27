/**
 * POST /api/generate-draft
 * Input:  { url, destination, articleText? }
 * Output: { title, content }   ← content is clean HTML
 *
 * Fetches an article URL, extracts readable text (no heavy deps —
 * pure regex, safe for Edge runtime), then calls Claude to produce
 * a destination-specific draft in Spanish (neutral LATAM).
 *
 * Graceful fallback: if the URL can't be fetched (e.g. LinkedIn 403,
 * paywall, bot-block) — or if the caller provides articleText directly —
 * Claude infers the topic from the URL slug and still generates a
 * high-quality first draft.
 */

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
};

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
const errRes = (msg, status = 400) => jsonRes({ error: msg }, status);

// ── Lightweight HTML → text (no JSDOM needed in Edge) ────────────────────────
function extractText(html) {
  return html
    // Remove entire blocks we don't want
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<figure[\s\S]*?<\/figure>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    // Keep first 12k chars — enough for Claude without blowing token budget
    .slice(0, 12000);
}

// ── Destination-specific prompt instructions ──────────────────────────────────
const DEST_INSTRUCTIONS = {
  linkedin: `Crea un post para LinkedIn en español (español neutro latinoamericano).
Estructura:
- Frase de apertura contundente (el gancho). Sin empezar con "Hoy vengo a hablar de…" ni clichés.
- 3–4 párrafos cortos con saltos de línea (estilo LinkedIn).
- Un insight o aprendizaje clave.
- Una pregunta de cierre que invite a la conversación.
- Sin hashtags (o máximo 1–2 muy relevantes al final).
- Tono: primera persona, conversacional pero reflexivo. Sin jerga corporativa.
- Extensión: 180–280 palabras.`,

  substack: `Crea una entrada de newsletter para Substack en español (español neutro latinoamericano).
Estructura:
- Párrafo de apertura que atrape al lector.
- 2–3 secciones con encabezados <h2>.
- Tono analítico y personal, con perspectiva propia.
- Cierre con reflexión o llamado a suscribirse.
- Extensión: 400–600 palabras.`,

  x: `Crea un hilo de Twitter/X en español (español neutro latinoamericano).
Estructura:
- Tweet 1: El gancho — debe hacer querer leer el resto.
- Tweets 2–7: Ideas principales, una por tweet, cada una autocontenida.
- Tweet final: Resumen + llamado a la acción.
- Cada tweet debe tener menos de 280 caracteres.
- Numerarlos: 1/ 2/ 3/ etc.
- Cada tweet va en un tag <p> separado.
- Extensión: 6–8 tweets en total.`,

  company: `Crea una entrada de blog formal para empresa en español (español neutro latinoamericano).
Estructura:
- Introducción clara que presenta el tema.
- 3–4 secciones con encabezados <h2>.
- Tono profesional y objetivo. Sin primera persona del singular.
- Conclusión con próximos pasos o recomendaciones.
- Sin emojis. Sin hipérboles.
- Extensión: 400–500 palabras.`,
};

/** Prompt when we have the full article text */
function buildPrompt(text, destination) {
  const instructions = DEST_INSTRUCTIONS[destination] || DEST_INSTRUCTIONS.linkedin;
  return `Eres un escritor de contenido experto. A partir del texto del artículo que aparece abajo, crea un post original. NO copies el artículo — extrae los insights y reescribe con tu propia voz.

TEXTO DEL ARTÍCULO:
"""
${text}
"""

INSTRUCCIONES:
${instructions}

IMPORTANTE: Responde SÓLO con un JSON válido en este formato exacto (sin bloques de markdown, sin texto adicional):
{
  "title": "Título corto del post (5–8 palabras)",
  "content": "<p>Contenido HTML aquí...</p>"
}

Usa únicamente estos tags HTML en el campo "content": <p>, <h2>, <h3>, <strong>, <em>, <ul>, <ol>, <li>, <blockquote>
No incluyas el título dentro del campo "content".`;
}

/**
 * Prompt when the article couldn't be fetched (LinkedIn 403, paywall, etc.).
 * Claude infers the topic from the URL slug and generates a realistic draft
 * as if the author just read and is sharing insights from that article.
 */
function buildUrlPrompt(url, destination) {
  const instructions = DEST_INSTRUCTIONS[destination] || DEST_INSTRUCTIONS.linkedin;

  // Extract a readable slug from the URL for context hints
  const slug = url
    .replace(/^https?:\/\/[^/]+\//, '')   // remove scheme + domain
    .replace(/[?#].*$/, '')               // remove query string / hash
    .replace(/[-_]/g, ' ')               // hyphens/underscores → spaces
    .replace(/\//g, ' · ')               // path separators → bullets
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);

  return `Eres un escritor de contenido experto. El usuario quiere crear un post basado en un artículo, pero no fue posible acceder al texto completo (el sitio puede requerir login, tener paywall, o bloquear acceso automático).

URL del artículo: ${url}
Contexto inferido de la URL: "${slug}"

A partir de la URL, infiere el tema principal del artículo (presta atención a las palabras clave del slug). Luego crea un post original en primera persona, como si el autor acabara de leer ese artículo y quisiera compartir los aprendizajes más valiosos con su audiencia.

Si la URL no ofrece suficiente contexto temático, genera un post valioso y reflexivo sobre el área general que se infiere del dominio o del slug.

INSTRUCCIONES:
${instructions}

IMPORTANTE: Responde SÓLO con un JSON válido en este formato exacto (sin bloques de markdown, sin texto adicional):
{
  "title": "Título corto del post (5–8 palabras)",
  "content": "<p>Contenido HTML aquí...</p>"
}

Usa únicamente estos tags HTML en el campo "content": <p>, <h2>, <h3>, <strong>, <em>, <ul>, <ol>, <li>, <blockquote>
No incluyas el título dentro del campo "content".`;
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS });
  if (req.method !== 'POST')   return errRes('Method not allowed', 405);

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return errRes('AI not configured on server', 503);

  // Parse body
  let body;
  try { body = await req.json(); } catch { return errRes('Invalid JSON body', 400); }

  // articleText is optional — lets callers bypass the fetch (e.g. for LinkedIn)
  const { url, destination = 'linkedin', articleText: providedText } = body;

  if (!url || typeof url !== 'string' || !url.match(/^https?:\/\//i)) {
    return errRes('A valid URL starting with http:// or https:// is required', 400);
  }
  if (!['linkedin', 'substack', 'x', 'company'].includes(destination)) {
    return errRes('destination must be one of: linkedin, substack, x, company', 400);
  }

  // ── Step 1: Resolve article text ─────────────────────────────────────────
  let articleText = null;

  // If the caller already supplied the text (paste fallback), use it directly
  if (providedText && typeof providedText === 'string' && providedText.trim().length >= 80) {
    articleText = providedText.trim().slice(0, 12000);
  } else {
    // Try to fetch the URL — but never hard-fail on blocked sites
    try {
      const fetchRes = await fetch(url, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (compatible; DraftBot/1.0; +https://letscolab.in)',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es,en;q=0.9',
          'Accept-Encoding': 'identity',
        },
        signal: AbortSignal.timeout(12_000),
        redirect: 'follow',
      });

      if (fetchRes.ok) {
        const html      = await fetchRes.text();
        const extracted = extractText(html);
        if (extracted.length >= 80) {
          articleText = extracted;
        }
        // If extracted < 80 chars, articleText stays null → URL-inference fallback
      }
      // If !fetchRes.ok (e.g. 403 from LinkedIn), articleText stays null → fallback
    } catch (_e) {
      // Network error / timeout — articleText stays null → URL-inference fallback
    }
  }

  // ── Step 2: Build prompt — full text OR URL-inference ────────────────────
  const prompt = articleText
    ? buildPrompt(articleText, destination)
    : buildUrlPrompt(url, destination);

  // ── Step 3: Call Claude ──────────────────────────────────────────────────
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
        max_tokens: 1800,
        messages:   [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(55_000),
    });
  } catch (e) {
    return errRes('La solicitud a la IA falló: ' + String(e), 502);
  }

  if (!aiRes.ok) {
    const errText = await aiRes.text().catch(() => '');
    return errRes('AI error ' + aiRes.status + ': ' + errText.slice(0, 200), 502);
  }

  // ── Step 4: Parse response ───────────────────────────────────────────────
  const aiData  = await aiRes.json();
  const rawText = (aiData.content?.[0]?.text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let result;
  try {
    result = JSON.parse(rawText);
  } catch {
    return errRes('No se pudo parsear la respuesta de la IA: ' + rawText.slice(0, 200), 502);
  }

  if (!result.title || !result.content) {
    return errRes('La IA devolvió una respuesta incompleta', 502);
  }

  return jsonRes({
    title:   String(result.title).trim(),
    content: String(result.content).trim(),
  });
}
