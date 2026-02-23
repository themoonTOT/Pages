export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let topic;
  try {
    const body = await req.json();
    topic = (body.topic || '').trim();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!topic) {
    return new Response('Missing topic', { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response('API key not configured', { status: 500 });
  }

  const systemPrompt = `Sos un asistente experto en redacción. Tu tarea es generar el esqueleto estructurado de una nota en HTML.

Reglas estrictas:
- Respondé SOLO con un objeto JSON válido, sin texto extra, sin markdown, sin bloques de código
- El JSON debe tener exactamente dos campos: "title" (string) y "body" (string con HTML)
- El HTML del body debe usar: <h1>, <p>, <ul>, <li>. Nada más.
- Generá entre 4 y 6 secciones con <h1>, cada una con contenido relevante
- El contenido debe ser específico al tema, no genérico
- Todo en español, tono profesional y claro
- El título debe ser conciso (máximo 6 palabras)`;

  const userPrompt = `Generá el draft para una nota sobre: "${topic}"`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error('Anthropic error:', err);
      return new Response('Anthropic API error', { status: 502 });
    }

    const data = await anthropicRes.json();
    const text = data.content?.[0]?.text || '';

    // Parse the JSON response from Claude
    let draft;
    try {
      // Strip any accidental markdown fences
      const clean = text.replace(/```json|```/g, '').trim();
      draft = JSON.parse(clean);
    } catch {
      // Fallback: return raw text as body if JSON parse fails
      draft = {
        title: topic.charAt(0).toUpperCase() + topic.slice(1),
        body: '<p>' + text.replace(/\n/g, '</p><p>') + '</p>'
      };
    }

    return new Response(JSON.stringify(draft), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Handler error:', err);
    return new Response('Internal error', { status: 500 });
  }
}
