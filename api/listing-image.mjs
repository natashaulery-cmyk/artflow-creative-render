const LISTING_HOST_SUFFIXES = [
  'vinted.com',
  'depop.com',
  'ebay.com',
  'poshmark.com',
  'facebook.com',
];

const IMAGE_HOST_SUFFIXES = [
  'vinted.net',
  'vinted.com',
  'depop.com',
  'ebayimg.com',
  'ebay.com',
  'poshmark.com',
  'di2ponv0v5otw.cloudfront.net',
  'd2zlsagv0ouax1.cloudfront.net',
  'fbcdn.net',
  'facebook.com',
];

const clean = (value = '') => String(value || '').trim();
const hostMatches = (host, suffixes) => suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));

function safeHttpsUrl(raw, suffixes) {
  try {
    const url = new URL(clean(raw));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (!hostMatches(host, suffixes)) return null;
    return url;
  } catch {
    return null;
  }
}

function decodeEntities(text = '') {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/');
}

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i'),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match?.[1]) return decodeEntities(match[1]).trim();
  }
  return '';
}

function imageFromJsonLd(html = '') {
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts.slice(0, 20)) {
    const body = script.replace(/^.*?>/s, '').replace(/<\/script>\s*$/i, '').trim();
    try {
      const parsed = JSON.parse(decodeEntities(body));
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length) {
        const item = stack.shift();
        if (!item || typeof item !== 'object') continue;
        const image = item.image;
        if (typeof image === 'string' && /^https:\/\//i.test(image)) return image;
        if (Array.isArray(image)) {
          const first = image.find((value) => typeof value === 'string' && /^https:\/\//i.test(value));
          if (first) return first;
        }
        if (image && typeof image === 'object' && typeof image.url === 'string') return image.url;
        if (Array.isArray(item['@graph'])) stack.push(...item['@graph']);
      }
    } catch {}
  }
  return '';
}

function imageFromHtml(html = '') {
  const candidates = [
    metaContent(html, 'og:image:secure_url'),
    metaContent(html, 'og:image'),
    metaContent(html, 'twitter:image'),
    metaContent(html, 'twitter:image:src'),
    imageFromJsonLd(html),
    html.match(/itemprop=["']image["'][^>]+(?:content|src)=["']([^"']+)["']/i)?.[1],
    html.match(/(?:content|src)=["']([^"']+)["'][^>]+itemprop=["']image["']/i)?.[1],
  ];
  return clean(candidates.find(Boolean));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

async function discoverImage(listingUrl) {
  try {
    const response = await fetchWithTimeout(listingUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (response.ok) {
      const html = await response.text();
      const found = imageFromHtml(html);
      if (found) return found;
    }
  } catch {}

  try {
    const endpoint = new URL('https://api.microlink.io/');
    endpoint.searchParams.set('url', listingUrl);
    const response = await fetchWithTimeout(endpoint, { headers: { accept: 'application/json' } }, 12000);
    if (response.ok) {
      const payload = await response.json();
      const image = payload?.data?.image;
      const found = typeof image === 'string' ? image : image?.url;
      if (found) return clean(found);
    }
  } catch {}
  return '';
}

async function fetchImage(url, listingUrl = '') {
  const headers = {
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  };
  if (listingUrl) headers.referer = listingUrl;
  return fetchWithTimeout(url, { headers }, 12000);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const listing = safeHttpsUrl(req.query?.listing, LISTING_HOST_SUFFIXES);
  let image = safeHttpsUrl(req.query?.image, IMAGE_HOST_SUFFIXES);

  if (!image && listing) {
    const discovered = await discoverImage(listing.toString());
    image = safeHttpsUrl(discovered, IMAGE_HOST_SUFFIXES);
  }

  if (!image) {
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
    return res.status(404).end();
  }

  async function sendImage(candidate) {
    const response = await fetchImage(candidate.toString(), listing?.toString() || '');
    if (!response.ok) return false;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) return false;
    const body = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(body);
    return true;
  }

  try {
    if (await sendImage(image)) return;

    // Marketplace CDN image URLs can expire even while the listing is still live.
    // If the saved image fails, rediscover the current image from the listing and retry.
    if (listing) {
      const discovered = await discoverImage(listing.toString());
      const refreshedImage = safeHttpsUrl(discovered, IMAGE_HOST_SUFFIXES);
      if (refreshedImage && refreshedImage.toString() !== image.toString() && await sendImage(refreshedImage)) return;
    }

    return res.status(404).end();
  } catch (error) {
    console.warn('listing image proxy failed', {
      imageHost: image?.hostname || '',
      listingHost: listing?.hostname || '',
      error: error?.message || 'unknown',
      cause: error?.cause?.code || '',
    });
    return res.status(502).end();
  }
}
