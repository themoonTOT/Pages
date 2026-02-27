/**
 * /api/substack-import — Fetch & parse a Substack publication RSS feed
 *
 * POST { url: "username.substack.com" }
 * Returns { publication: { name, url, description }, posts: [...], total: n }
 *
 * No credentials needed — Substack publishes a public RSS feed at /feed.
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

// ── RSS parser ────────────────────────────────────────────────────────────────
// Edge runtime doesn't have DOMParser — parse with regex.

function unwrapCdata(str) {
  const m = str.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/s);
  return m ? m[1].trim() : str.trim();
}

function getTag(xml, tag) {
  // Handles both <tag>content</tag> and <ns:tag>content</ns:tag>
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'is');
  const m  = xml.match(re);
  return m ? unwrapCdata(m[1]) : '';
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g,  ' ')
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function safeIso(dateStr) {
  if (!dateStr) return null;
  try { return new Date(dateStr).toISOString(); } catch { return null; }
}

function parseRSS(xml) {
  // Channel metadata — from the section before the first <item>
  const beforeFirst = xml.split(/<item[\s>]/i)[0];
  const channelTitle = getTag(beforeFirst, 'title');
  const channelDesc  = stripHtml(getTag(beforeFirst, 'description')).slice(0, 280);

  const posts = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;

  while ((m = itemRe.exec(xml)) !== null) {
    const raw   = m[1];
    const title = getTag(raw, 'title');
    if (!title) continue;

    // <link> in RSS 2.0 is a bare text node; in some feeds it's an attribute
    const linkNode = raw.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i)
                  || raw.match(/<link[^>]*\/>\s*(https?:\/\/[^\s<]+)/i)
                  || raw.match(/<link>(https?:\/\/[^\s<]+)<\/link>/i);
    const link  = linkNode ? linkNode[1].trim() : '';

    const pubDate = getTag(raw, 'pubDate') || getTag(raw, 'dc:date');
    const guid    = getTag(raw, 'guid') || link;

    // Prefer full content:encoded, fallback to description
    const contentRaw = raw.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/is)?.[1];
    const descRaw    = getTag(raw, 'description');
    const bodyText   = stripHtml(contentRaw ? unwrapCdata(contentRaw) : descRaw);
    const excerpt    = bodyText.slice(0, 300) + (bodyText.length > 300 ? '…' : '');

    posts.push({
      title,
      url:          link,
      guid:         guid || link,
      excerpt,
      published_at: safeIso(pubDate),
    });
  }

  return { channelTitle, channelDesc, posts };
}

// ── Normalise input URL ───────────────────────────────────────────────────────
function normaliseUrl(raw) {
  let s = raw.trim().replace(/\/+$/, '');
  if (!s) return null;

  // Accept bare username ("juansmith"), subdomain, or full URL
  if (!s.startsWith('http')) {
    if (!s.includes('.')) s = s + '.substack.com';
    s = 'https://' + s;
  }

  try {
    const u = new URL(s);
    return u.origin; // strips path, keeps scheme + host
  } catch {
    return null;
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS });
  if (req.method !== 'POST')   return err('Method not allowed', 405);

  let body;
  try { body = await req.json(); } catch { return err('JSON body inválido', 400); }

  const origin = normaliseUrl(body.url || '');
  if (!origin) return err('URL inválida. Ej: username.substack.com', 400);

  const feedUrl = origin + '/feed';

  let feedRes;
  try {
    feedRes = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Pages-App/1.0)',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    return err('No se pudo conectar: ' + String(e), 502);
  }

  if (!feedRes.ok) {
    return err(
      feedRes.status === 404
        ? 'Publicación no encontrada. Verificá el nombre de usuario.'
        : `El feed devolvió ${feedRes.status}. Verificá la URL.`,
      502,
    );
  }

  const xml = await feedRes.text();
  if (!xml.includes('<rss') && !xml.includes('<channel') && !xml.includes('<feed')) {
    return err('La URL no apunta a un feed RSS válido de Substack.', 400);
  }

  const { channelTitle, channelDesc, posts } = parseRSS(xml);

  return json({
    publication: {
      name:        channelTitle || 'Substack Publication',
      url:         origin,
      description: channelDesc,
    },
    posts,
    total: posts.length,
  });
}
