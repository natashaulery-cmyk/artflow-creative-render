import pg from 'pg';
import { pooledDatabaseUrl } from './_db.mjs';
import { isMercariSender, parseMercariSaleEmail } from './_mercari-email.mjs';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: pooledDatabaseUrl(),
  ssl: { rejectUnauthorized: false },
  max: 1,
});

export const clean = (value = '') => String(value ?? '').replace(/\r/g, '').trim();
export const normalize = (value = '') => clean(value).toLowerCase();

export function addressOnly(value = '') {
  const text = normalize(value);
  const angle = text.match(/<([^>]+)>/);
  return clean(angle?.[1] || text).replace(/^mailto:/, '');
}

export function isAllowedMarketplaceSender(value = '') {
  const email = addressOnly(value);
  return [
    '@vinted.com',
    '@poshmark.com',
    '@alerts.depop.com',
    '@ohhey.depop.com',
    '@ebay.com',
    '@marketplace.facebook.com',
    '@alerts.us.mercari.com',
  ].some((suffix) => email.endsWith(suffix));
}

function htmlToText(value = '') {
  return clean(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function localDate(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Indiana/Indianapolis',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function sizeFromTitle(title = '') {
  const match = clean(title).match(/\b(\d{1,2}(?:\.\d+)?)\s*[x×]\s*(\d{1,2}(?:\.\d+)?)\b/i);
  return match ? `${match[1]}x${match[2]}` : 'Other';
}

function costsFor(title = '', quantity = 1) {
  const qty = Math.max(1, Number(quantity) || 1);
  if (/\bbundle\b/i.test(title) || qty > 1) {
    const total = Number((qty * 1.59 + 0.40).toFixed(2));
    return { base_item_cost: total, paper_ink_cost: 0, packaging_cost: 0, total_cost: total };
  }

  const size = sizeFromTitle(title);
  const baseBySize = {
    '4x4': 1.00,
    '4x6': 1.25,
    '5x7': 1.50,
    '8x8': 2.00,
    '8x10': 2.00,
    '11x14': 3.00,
  };
  const base = baseBySize[size] ?? 0;
  if (!base) return { base_item_cost: 0, paper_ink_cost: 0, packaging_cost: 0, total_cost: 0 };
  const paper = 0.09;
  const packaging = size === '11x14' ? 2.00 : 0.40;
  return {
    base_item_cost: base,
    paper_ink_cost: paper,
    packaging_cost: packaging,
    total_cost: Number((base + paper + packaging).toFixed(2)),
  };
}

function vintedRows(subject, text) {
  if (!/you sold an item on vinted/i.test(subject)) return [];
  const match = text.match(/Hello\s+[^,\n]+,\s*([\w.-]+)\s+has bought\s+([\s\S]*?)\s+\$([\d,.]+)/i);
  if (!match) return [];
  let rawTitle = clean(match[2]).replace(/\s+/g, ' ');
  const price = Number(match[3].replace(/,/g, '')) || 0;
  let quantity = 1;
  const bundle = rawTitle.match(/^(\d+)\s+Bundle\s+(\d+)\s+items?/i) || rawTitle.match(/^Bundle\s+(\d+)\s+items?/i);
  if (bundle) {
    quantity = Number(bundle[1] || bundle[2]) || 1;
    rawTitle = `Bundle of ${quantity} items`;
  }
  return [{
    platform: 'Vinted',
    product_name: rawTitle,
    quantity,
    size: bundle ? 'Other' : sizeFromTitle(rawTitle),
    sale_total: price,
    unit_price: quantity > 1 ? Number((price / quantity).toFixed(2)) : price,
    buyer: clean(match[1]),
    order_id: '',
  }];
}

function poshmarkRows(subject, text) {
  const normalizedSubject = clean(subject).replace(/^(?:(?:fwd?|fw):\s*)+/i, '');
  const subjectMatch = normalizedSubject.match(/^(?:Congrats!\s*)?(.+?)\s+just sold to\s+@([^\s!]+)\s+on Poshmark!\s*$/i);
  if (!subjectMatch) return [];

  const title = clean(subjectMatch[1]).replace(/^["“]|["”]$/g, '').trim();
  const buyer = clean(subjectMatch[2]);
  const orderId = clean(text.match(/Order\s*ID\s*(?:\n|:)?\s*([a-z0-9-]+)/i)?.[1] || '');
  const itemBlock = text.match(/Item\s+(?:Price\s*)?([\s\S]*?)(?:Your Earnings|Sales tax|Packaging Reminder)/i)?.[1] || '';
  const titleIndex = String(text).toLowerCase().lastIndexOf(title.toLowerCase());
  const titlePriceText = titleIndex >= 0
    ? (String(text).slice(titleIndex + title.length, titleIndex + title.length + 320).match(/\$([\d,.]+)/)?.[1] || '')
    : '';

  // For bundle orders, Poshmark lists each item's original price and then the
  // accepted Offer Price. The offer is the real gross sale amount and must win
  // over the first individual item price.
  const offerPriceText =
    text.match(/(?:Offer|Bundle)\s+Price\s*\$([\d,.]+)/i)?.[1]
    || '';
  const firstItemPriceText =
    itemBlock.match(/\$([\d,.]+)/)?.[1]
    || titlePriceText
    || text.match(/(?:Item|Listing|Order)\s*Price\s*(?:\n|:)?\s*\$([\d,.]+)/i)?.[1]
    || text.match(/Price\s*(?:\n|:)\s*[\s\S]{0,220}?\$([\d,.]+)/i)?.[1]
    || '';

  const explicitBundleQty = Number(text.match(/sold\s+(\d+)\s+items?\s+in a bundle/i)?.[1] || 0);
  const subjectMoreCount = Number(title.match(/\band\s+(\d+)\s+more\s+items?\b/i)?.[1] || 0);
  const quantity = Math.max(1, explicitBundleQty || (subjectMoreCount ? subjectMoreCount + 1 : 1));

  // Older Poshmark bundle emails do not always include an Offer Price.
  // Prefer an explicit Total Price (after seller discounts); otherwise sum
  // all item prices in the bundle instead of using only the first item.
  const totalPriceText = text.match(/\bTotal\s+Price\s*\$([\d,.]+)/i)?.[1] || '';
  const bundleItemPrices = quantity > 1
    ? Array.from(itemBlock.matchAll(/\$([\d,.]+)/g), (match) => Number(match[1].replace(/,/g, '')) || 0)
    : [];
  const bundleItemsTotal = bundleItemPrices.reduce((sum, value) => sum + value, 0);
  const saleTotal = Number(
    (offerPriceText || totalPriceText || (bundleItemsTotal > 0 ? String(bundleItemsTotal) : firstItemPriceText))
      .replace(/,/g, '')
  ) || 0;

  return [{
    platform: 'Poshmark',
    product_name: title,
    quantity,
    size: sizeFromTitle(title),
    sale_total: saleTotal,
    unit_price: quantity > 1 ? Number((saleTotal / quantity).toFixed(2)) : saleTotal,
    buyer,
    order_id: orderId || null,
  }];
}

export function parsePoshmarkCancellation(subject = '', text = '') {
  const normalizedSubject = clean(subject).replace(/^(?:(?:fwd?|fw):\s*)+/i, '');
  if (!/please do not ship:/i.test(normalizedSubject) || !/was canceled/i.test(normalizedSubject)) return null;

  const orderId = clean(
    text.match(/(?:Re:\s*)?Order\s+Id\s*[:#]?\s*([a-z0-9-]+)/i)?.[1]
      || text.match(/order\s*#\s*([a-z0-9-]+)/i)?.[1]
      || ''
  );
  const title = clean(
    normalizedSubject.match(/Please do not ship:\s*[\"“]([\s\S]+?)[\"”]\s+for\s+@[^\s]+\s+was canceled/i)?.[1]
      || ''
  );

  return orderId || title
    ? { order_id: orderId || null, product_name: title }
    : null;
}

function depopRows(subject, text) {
  if (!/sale confirmation for\s+@/i.test(subject) || !/you've made a sale!/i.test(text)) return [];
  const buyer = clean(subject.match(/sale confirmation for\s+@([^\.\s]+)/i)?.[1] || '');
  const block = text.match(/Order details\s*\n([\s\S]*?)\n\s*Ship to\b/i)?.[1] || '';
  if (!block) return [];

  const lines = block.split('\n').map(clean).filter(Boolean);
  const items = [];

  for (let i = 0; i < lines.length - 1; i += 1) {
    if (/^\$[\d,.]+$/.test(lines[i + 1]) && !/^\$/.test(lines[i])) {
      // Depop's plain-text sale template prefixes the item name with the
      // image alt text (for example, "image 4x4 Golden Girls Magnet").
      // Keep that presentation label out of the imported product name.
      const title = lines[i].replace(/^image\s+/i, '').trim();
      const price = Number(lines[i + 1].slice(1).replace(/,/g, '')) || 0;
      if (!title || !price) continue;
      items.push({ title, price });
      i += 1;
    }
  }

  if (!items.length) return [];

  if (items.length > 1) {
    const subtotalText = text.match(/\bSubtotal\s*\n?\s*\$([\d,.]+)/i)?.[1] || '';
    const summed = items.reduce((sum, item) => sum + item.price, 0);
    const saleTotal = Number(String(subtotalText).replace(/,/g, '')) || Number(summed.toFixed(2));
    const quantity = items.length;

    return [{
      platform: 'Depop',
      product_name: `Bundle of ${quantity} items`,
      quantity,
      size: 'Other',
      sale_total: saleTotal,
      unit_price: Number((saleTotal / quantity).toFixed(2)),
      buyer,
      order_id: '',
      depop_bundle: true,
      bundle_item_count: quantity,
      bundle_item_titles: items.map((item) => item.title),
    }];
  }

  const item = items[0];
  return [{
    platform: 'Depop',
    product_name: item.title,
    quantity: 1,
    size: sizeFromTitle(item.title),
    sale_total: item.price,
    unit_price: item.price,
    buyer,
    order_id: '',
  }];
}


function facebookMarketplaceRows(subject = '', text = '') {
  const normalizedSubject = clean(subject).replace(/^(?:(?:fwd?|fw):\s*)+/i, '');
  const subjectMatch = normalizedSubject.match(/^New Marketplace order for\s+(.+?)\s*$/i);
  const shippingLabel = /^Shipping label for your Marketplace order$/i.test(normalizedSubject);
  if (!subjectMatch && !shippingLabel) return [];

  // Facebook sometimes sends the shipping label as the only seller-side sale
  // email. Accept that format only when it contains the same durable order
  // link, price, fulfillment state, and recent-sale footer as a confirmation.
  const orderId = clean(
    String(text).match(/facebook\.com\/marketplace\/you\/shipping_orders\/(\d+)/i)?.[1]
      || String(text).match(/\/marketplace\/you\/shipping_orders\/(\d+)/i)?.[1]
      || ''
  );
  const sellerSale = /Congrats on your Marketplace order!/i.test(text) || /recent sale on Facebook/i.test(text);
  const verifiedShippingLabel = shippingLabel
    && Boolean(orderId)
    && /prepaid shipping label for .+?'s order is attached/i.test(text)
    && /To be shipped/i.test(text)
    && sellerSale;
  if (!sellerSale || (shippingLabel && !verifiedShippingLabel)) {
    return [];
  }

  const title = clean(
    subjectMatch?.[1]
      || String(text).match(/={3,}\s*\n+\s*([^\n$]+?)\s*\$[\d,]+(?:\.\d{2})?\s*To be shipped/i)?.[1]
      || String(text).match(/\n\s*([^\n$]+?)\s*\$[\d,]+(?:\.\d{2})?\s*To be shipped/i)?.[1]
      || ''
  ).replace(/[.!]+$/, '');
  if (!title) return [];

  const titleIndex = String(text).toLowerCase().indexOf(title.toLowerCase());
  const nearbyText = titleIndex >= 0
    ? String(text).slice(titleIndex + title.length, titleIndex + title.length + 240)
    : String(text);
  const priceText =
    nearbyText.match(/(?:US\s*)?\$\s*([\d,]+(?:\.\d{2})?)/i)?.[1]
    || String(text).match(/(?:US\s*)?\$\s*([\d,]+(?:\.\d{2})?)/i)?.[1]
    || '';
  const saleTotal = Number(String(priceText).replace(/,/g, '')) || 0;
  if (saleTotal <= 0) return [];

  const sourceUrl = orderId
    ? `https://www.facebook.com/marketplace/you/shipping_orders/${orderId}/`
    : '';
  const buyer = shippingLabel
    ? clean(String(text).match(/prepaid shipping label for\s+(.+?)'s order is attached/i)?.[1] || '')
    : '';

  return [{
    platform: 'Facebook Marketplace',
    product_name: title,
    quantity: 1,
    size: sizeFromTitle(title),
    sale_total: saleTotal,
    unit_price: saleTotal,
    buyer,
    order_id: orderId || null,
    source_url: sourceUrl,
  }];
}


function ebayRows(subject, text) {
  const normalizedSubject = clean(subject).replace(/^(?:(?:fwd?|fw):\s*)+/i, '');
  const explicitSellerSaleSubject =
    /\byou made (?:a|the) sale(?: for)?\b/i.test(normalizedSubject)
    || /\byour (?:ebay )?item (?:has )?sold\b/i.test(normalizedSubject)
    || /^\s*sold[:!\s-]/i.test(normalizedSubject);

  // eBay sale emails can contain footer/help text mentioning "your listing".
  // Never let those footer phrases override an explicit seller-sale subject.
  const listingNoise =
    !explicitSellerSaleSubject &&
    /\b(?:your listing|listing (?:created|live|active|ended|renewed|updated|published|removed)|item listed|listed item|watcher|watching|listing views?|listing activity|listing performance|offer received|send offer|price drop|sell similar|relist|draft listing|promote your listing)\b/i.test(`${normalizedSubject}\n${text || ''}`);
  if (listingNoise) return [];

  const oldSale = normalizedSubject.match(/You made the sale for\s+(.+?)(?:!|$)/i)
    || normalizedSubject.match(/You made (?:a|the) sale[:!\s-]+(.+?)(?:!|$)/i)
    || normalizedSubject.match(/Sold[:!\s-]+(.+?)(?:!|$)/i);
  const paymentSale = normalizedSubject.match(/The payment from\s+(.+?)\s+is confirmed:\s*(.+)$/i)
    || normalizedSubject.match(/Payment from\s+(.+?)\s+(?:is\s+)?confirmed:\s*(.+)$/i);
  const receivedPayment = normalizedSubject.match(/(?:You have received|You've received) a payment(?: from\s+(.+?))?(?::|\s+-)?\s*(.*)$/i);
  const soldSubject = /\b(?:your eBay item sold|congratulations[,!]?(?: your)? item sold|congratulations[,!]?(?: on)? your sale|your item (?:has )?sold|you sold (?:an|your) item|item sold|you made (?:a|the) sale|you have (?:a|a new) sale|sale confirmed|sale complete|ready to ship|ship your item|time to ship|paid[\s:!\-–—]+ship now|buyer (?:has )?paid|your buyer (?:has )?paid|order paid|you got paid|payment received|new order from|you have a new order|ship by)\b/i.test(normalizedSubject);

  const sellerBodySignal =
    /\b(?:you (?:made|completed) (?:a|the) sale|you have (?:a|a new) sale|your item (?:sold|has sold)|you sold|sold for|quantity sold|buyer (?:has )?paid|your buyer (?:has )?paid|sale price|order paid|you got paid|payment received|ready to ship|time to ship|ship by|ship(?:ping)? to buyer|ship (?:this|your) item|new order from|you have a new order|payment from .+ (?:is )?confirmed|you(?:'ve| have) received a payment)\b/i.test(text)
    || /(?:^|\n)\s*Buyer(?: username)?\s*(?:\n|:)\s*[^\n]+/i.test(text);

  // Buyer order confirmations can contain "Item", "Total", and order IDs too.
  // Only treat an eBay email as a sale when it has seller-side wording.
  if (!oldSale && !paymentSale && !receivedPayment && !soldSubject && !sellerBodySignal) return [];

  const subjectFallback = clean(
    normalizedSubject
      .replace(/^.*?\b(?:you made (?:a|the) sale|your item (?:has )?sold|item sold|sold)\b\s*[:!\-–—]*\s*/i, '')
      .replace(/\s*[|•]\s*eBay.*$/i, '')
  );

  const title = clean(
    oldSale?.[1]
      || paymentSale?.[2]
      || receivedPayment?.[2]
      || text.match(/(?:Item|Listing)\s*(?:title)?\s*(?:\n|:)\s*([^\n]+)/i)?.[1]
      || text.match(/(?:Item sold|Sold item|You sold)\s*(?:\n|:)\s*([^\n]+)/i)?.[1]
      || text.match(/Quantity sold\s*(?:\n|:)\s*\d+\s*\n+([^\n$]+)/i)?.[1]
      || text.match(/(?:Item name|Product)\s*(?:\n|:)\s*([^\n]+)/i)?.[1]
      || subjectFallback
      || ''
  ).replace(/[.!]+$/, '');
  let normalizedTitle = clean(title)
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const buyer = clean(
    paymentSale?.[1]
      || receivedPayment?.[1]
      || text.match(/Buyer\s*(?:username)?\s*(?:\n|:)\s*([^\n]+)/i)?.[1]
      || ''
  );

  const orderId = clean(
    text.match(/(?:^|\n)\s*Order\s*(?:(?:number|ID)\s*)?(?:\n|:|#)\s*([A-Z0-9-]{8,})/im)?.[1]
      || text.match(/(?:Order\s*(?:number|ID)|Order #)\s*(?:\n|:|#)?\s*([A-Z0-9-]{8,})/i)?.[1]
      || ''
  );

  const uniqueDollarAmounts = Array.from(new Set(
    Array.from(String(text || '').matchAll(/(?:US\s*)?\$\s*([\d,]+(?:\.\d{2})?)/gi))
      .map((match) => Number(String(match[1] || '').replace(/,/g, '')))
      .filter((value) => Number.isFinite(value) && value > 0)
  ));
  const totalText =
    text.match(/(?:^|\n)\s*Sold\s*(?:\n|:)\s*(?:US\s*)?\$\s*([\d,.]+)/im)?.[1]
    || text.match(/(?:Order total|Total paid|Buyer paid|Sale total|Sale price|Order amount|Order value|Item subtotal|Item total|Total amount|Your total|Subtotal|Total)\s*(?:\n|:)?\s*(?:US\s*)?\$\s*([\d,.]+)/i)?.[1]
    || text.match(/(?:Sold for|Item price|Price|Amount|Your earnings|Earnings|Payout|Funds available)\s*(?:\n|:)?\s*(?:US\s*)?\$\s*([\d,.]+)/i)?.[1]
    || text.match(/(?:Order total|Total paid|Buyer paid|Sale total|Sale price|Order amount|Order value|Item subtotal|Item total|Total amount|Your total|Subtotal|Total)[\s\S]{0,80}?\bUSD\s*([\d,.]+)/i)?.[1]
    || text.match(/(?:Sold for|Item price|Price|Amount|Your earnings|Earnings|Payout|Funds available)[\s\S]{0,80}?\bUSD\s*([\d,.]+)/i)?.[1]
    || normalizedSubject.match(/(?:US\s*)?\$\s*([\d,.]+)/i)?.[1]
    || normalizedSubject.match(/\bUSD\s*([\d,.]+)/i)?.[1]
    || normalizedSubject.match(/([\d,.]+)\s*(?:USD|US dollars?)/i)?.[1]
    || (uniqueDollarAmounts.length === 1 ? String(uniqueDollarAmounts[0]) : '')
    || '';
  const saleTotal = Number(String(totalText).replace(/,/g, '')) || 0;
  const amountPending = saleTotal <= 0 && Boolean(oldSale);
  if (saleTotal <= 0 && !amountPending) return [];

  if (!normalizedTitle || normalizedTitle.length < 3 || !/[a-z0-9]/i.test(normalizedTitle)) {
    normalizedTitle = orderId ? `eBay Order ${orderId}` : 'eBay Order';
  }

  const quantity = Math.max(1, Number(
    text.match(/Quantity(?:\s+sold)?\s*(?:\n|:)?\s*(\d+)/i)?.[1] || 1
  ));

  return [{
    platform: 'eBay',
    product_name: normalizedTitle,
    quantity,
    size: sizeFromTitle(normalizedTitle),
    sale_total: saleTotal,
    unit_price: Number((saleTotal / quantity).toFixed(2)),
    buyer,
    order_id: orderId || null,
    source_url: orderId ? `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(orderId)}` : '',
    amount_pending: amountPending,
  }];
}

export function parseSaleEmail(from, subject, text, trustedForwarder = false) {
  const email = addressOnly(from);
  if (email.endsWith('@vinted.com')) return vintedRows(subject, text);
  if (email.endsWith('@poshmark.com')) return poshmarkRows(subject, text);
  if (email.endsWith('@alerts.depop.com') || email.endsWith('@ohhey.depop.com')) return depopRows(subject, text);
  if (email.endsWith('@ebay.com')) return ebayRows(subject, text);
  if (email.endsWith('@marketplace.facebook.com')) return facebookMarketplaceRows(subject, text);
  if (isMercariSender(email)) return parseMercariSaleEmail(subject, text);
  if (trustedForwarder && /\bebay\b/i.test(`${subject}\n${text}`)) return ebayRows(subject, text);
  if (trustedForwarder && /(?:new marketplace order for|congrats on your marketplace order)/i.test(`${subject}\n${text}`)) {
    return facebookMarketplaceRows(subject, text);
  }
  return [];
}

function decodeBase64Url(value = '') {
  if (!value) return '';
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function bodyTextFromPayload(payload = {}) {
  const plain = [];
  const html = [];
  const walk = (part) => {
    if (!part || typeof part !== 'object') return;
    const mime = String(part.mimeType || '').toLowerCase();
    const data = part?.body?.data;
    if (data && mime === 'text/plain') plain.push(decodeBase64Url(data));
    else if (data && mime === 'text/html') html.push(decodeBase64Url(data));
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  if (plain.length) return clean(plain.join('\n'));
  if (html.length) return htmlToText(html.join('\n'));
  const fallback = decodeBase64Url(payload?.body?.data || '');
  return payload?.mimeType === 'text/html' ? htmlToText(fallback) : clean(fallback);
}


function bodyHtmlFromPayload(payload = {}) {
  const html = [];
  const walk = (part) => {
    if (!part || typeof part !== 'object') return;
    const mime = String(part.mimeType || '').toLowerCase();
    const data = part?.body?.data;
    if (data && mime === 'text/html') html.push(decodeBase64Url(data));
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  if (html.length) return clean(html.join('\n'));
  if (String(payload?.mimeType || '').toLowerCase() === 'text/html') {
    return clean(decodeBase64Url(payload?.body?.data || ''));
  }
  return '';
}

function decodeHtmlUrl(value = '') {
  return clean(value)
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function marketplaceSourceUrl(platform = '', html = '') {
  const domains = {
    Vinted: 'vinted.com',
    Poshmark: 'poshmark.com',
    Depop: 'depop.com',
    'Facebook Marketplace': 'facebook.com',
  };
  const domain = domains[platform];
  if (!domain || !html) return '';

  const values = [];
  for (const match of String(html).matchAll(/href\s*=\s*["']([^"']+)["']/gi)) values.push(match[1]);
  for (const match of String(html).matchAll(/https?:\/\/[^"'<>\s]+/gi)) values.push(match[0]);

  const candidates = [];
  const addCandidate = (raw) => {
    let value = decodeHtmlUrl(raw);
    if (!value) return;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch { break; }
    }
    if (value.startsWith('//')) value = `https:${value}`;

    const embedded = value.match(/https?:\/\/[^"'<>\s]+/gi) || [];
    const variants = /^https?:\/\//i.test(value) ? [value, ...embedded] : embedded;

    for (const variant of variants) {
      try {
        const url = new URL(variant);
        const host = url.hostname.toLowerCase();
        if (host !== domain && !host.endsWith(`.${domain}`)) continue;
        url.hash = '';
        const text = `${url.pathname}${url.search}`;
        let score = 1;
        if (/order|transaction|item|listing|product|sale|sold|purchase/i.test(text)) score += 8;
        if (/unsubscribe|privacy|terms|help|support|download|preferences/i.test(text)) score -= 12;
        if (url.pathname === '/' || url.pathname === '') score -= 2;
        candidates.push({ url: url.toString(), score });
      } catch {}
    }
  };

  values.forEach(addCandidate);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.url || '';
}

export function marketplaceImageUrl(platform = '', html = '', title = '') {
  if (!html) return '';

  const key = (value = '') => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const titleKey = key(title);
  const candidates = [];

  for (const match of String(html).matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const srcRaw = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    const alt = decodeHtmlUrl(tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] || '');
    let src = decodeHtmlUrl(srcRaw);
    if (!src) continue;
    if (src.startsWith('//')) src = `https:${src}`;
    if (!/^https:\/\//i.test(src)) continue;

    const lower = src.toLowerCase();
    const width = Number(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || 0);
    const height = Number(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || 0);

    if (
      /email[_-]?track|tracking|spacer|pixel|transparent|vinted_logo|logo\.(?:png|jpg|jpeg|gif|webp)/i.test(lower)
      || (platform === 'Facebook Marketplace' && /facebook_icon\.png|\/images\/email\/facebook_/i.test(lower))
      || (width > 0 && width <= 2)
      || (height > 0 && height <= 2)
    ) continue;

    let score = 0;
    const altKey = key(alt);
    if (titleKey && altKey) {
      if (altKey === titleKey) score += 40;
      else if (altKey.includes(titleKey) || titleKey.includes(altKey)) score += 28;
    }

    if (platform === 'Vinted' && /(?:^|\.)vinted\.net|(?:^|\.)vinted\.com/i.test(new URL(src).hostname)) score += 12;
    if (platform === 'Poshmark' && /poshmark|cloudfront|cloudinary/i.test(lower)) score += 10;
    if (platform === 'Depop' && /depop|cloudfront|cloudinary/i.test(lower)) score += 10;
    if (platform === 'Facebook Marketplace') {
      // Facebook seller emails contain both the 32x32 Facebook brand icon and
      // the actual sold-item thumbnail. Never let the brand asset win.
      if (/facebook_icon|facebook[_-]?(?:logo|icon)|\/images\/email\/facebook_/i.test(lower)) continue;
      if (/scontent\.[^/]*fbcdn\.net|fbcdn\.net/i.test(lower)) score += 60;
      else if (/facebook\.com/i.test(lower)) score -= 20;
      if (width >= 48 && height >= 48) score += 8;
    }
    if (/\b(?:150x210|200x|300x|item|product|listing)\b/i.test(lower)) score += 4;
    if (width >= 40 || height >= 40) score += 2;

    candidates.push({ src, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.src || '';
}

function headerValue(message, name) {
  const headers = message?.payload?.headers || [];
  return clean(headers.find((header) => String(header?.name || '').toLowerCase() === name.toLowerCase())?.value || '');
}

export async function getLegacyProfile(client, user) {
  const email = normalize(user?.email);
  if (!email) return null;
  const result = await client.query(
    `SELECT * FROM artflow.legacy_users
       WHERE auth_user_id = $1 OR lower(email) = $2
       ORDER BY CASE WHEN active_business_id IS NOT NULL THEN 0 ELSE 1 END, CASE WHEN auth_user_id = $1 THEN 0 ELSE 1 END, created_date NULLS LAST
       LIMIT 1`,
    [user.id, email]
  );
  return result.rows[0] || null;
}

export async function getBusiness(client, profile, user) {
  const email = normalize(user?.email);
  const active = profile?.active_business_id || profile?.data?.active_business_id || null;
  const result = await client.query(`SELECT base44_id, name, primary_email, data FROM artflow.businesses ORDER BY name NULLS LAST`);
  const accessible = result.rows.filter((row) => {
    if (active && row.base44_id === active) return true;
    const data = row.data || {};
    const emails = [
      row.primary_email,
      data.primary_email,
      ...(Array.isArray(data.member_emails) ? data.member_emails : []),
      ...(Array.isArray(data.sales_emails) ? data.sales_emails : []),
    ].map(normalize).filter(Boolean);
    return email && emails.includes(email);
  });
  return accessible.find((row) => row.base44_id === active) || accessible[0] || null;
}

export function approvedSalesEmails(business = {}) {
  const data = business?.data || {};
  return new Set([
    business.primary_email,
    data.primary_email,
    ...(Array.isArray(data.sales_emails) ? data.sales_emails : []),
  ].map(normalize).filter(Boolean));
}

export async function approveGmailEmail(client, business, email) {
  const normalized = normalize(email);
  if (!normalized || !business?.base44_id) return;
  const data = business.data || {};
  const add = (list) => Array.from(new Set([...(Array.isArray(list) ? list : []), normalized].map(normalize).filter(Boolean)));
  const next = {
    ...data,
    member_emails: add(data.member_emails),
    sales_emails: add(data.sales_emails),
    expense_emails: add(data.expense_emails),
    connected_google_email: normalized,
  };
  await client.query(`UPDATE artflow.businesses SET data=$2::jsonb WHERE base44_id=$1`, [business.base44_id, JSON.stringify(next)]);
  business.data = next;
}

export async function googleJson(accessToken, url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(`Google Gmail request failed (${response.status})${text ? `: ${text.slice(0, 180)}` : ''}`);
    error.status = response.status;
    error.code = response.status === 429 || /quota exceeded|rate limit/i.test(text)
      ? 'GMAIL_RATE_LIMIT'
      : response.status === 401 || response.status === 403
        ? 'GMAIL_RECONNECT'
        : 'GMAIL_REQUEST_ERROR';
    throw error;
  }
  return response.json();
}

const GMAIL_YEAR_START = `${new Date().getFullYear()}/01/01`;
export const GMAIL_QUERIES = [
  `from:no-reply@vinted.com subject:"You sold an item on Vinted" after:${GMAIL_YEAR_START}`,
  `from:poshmark.com "just sold to" "on Poshmark" after:${GMAIL_YEAR_START}`,
  `from:poshmark.com subject:"Please do not ship:" "was canceled" after:${GMAIL_YEAR_START}`,
  `{from:alerts.depop.com from:ohhey.depop.com} subject:"Sale confirmation for" after:${GMAIL_YEAR_START}`,
  `from:noreply@marketplace.facebook.com {subject:"New Marketplace order for" subject:"Shipping label for your Marketplace order"} after:${GMAIL_YEAR_START}`,
  `from:no-reply@alerts.us.mercari.com subject:"made a sale" after:${GMAIL_YEAR_START}`,
];

async function listMessageIds(accessToken) {
  // A short, rotating search across marketplaces keeps one busy marketplace
  // from consuming the full Gmail request budget before others are checked.
  const groups = [];
  for (const query of GMAIL_QUERIES) {
    const ids = [];
    let pageToken = '';
    for (let page = 0; page < 2; page += 1) {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      url.searchParams.set('q', query);
      url.searchParams.set('maxResults', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const data = await googleJson(accessToken, url);
      for (const message of data?.messages || []) if (message?.id) ids.push(message.id);
      pageToken = clean(data?.nextPageToken || '');
      if (!pageToken) break;
    }
    groups.push(ids);
  }
  const messageIds = new Set();
  const maxLength = Math.max(0, ...groups.map((group) => group.length));
  for (let i = 0; i < maxLength; i += 1) {
    for (const group of groups) if (group[i]) messageIds.add(group[i]);
  }
  return [...messageIds];
}
async function readMessage(accessToken, messageId) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set('format', 'full');
  return googleJson(accessToken, url);
}

async function insertRows(client, businessId, messageId, receivedAt, rows) {
  const createdBy = (await client.query(
    `SELECT created_by_id FROM artflow.orders WHERE business_id=$1 AND created_by_id IS NOT NULL ORDER BY created_date DESC LIMIT 1`,
    [businessId]
  )).rows[0]?.created_by_id || null;

  const inserted = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const sourceEmailId = rows.length > 1 ? `${messageId}:${index + 1}` : messageId;
    const costs = costsFor(row.product_name, row.quantity);
    const sellingFee = row.platform === 'Mercari' ? Math.max(0, Number(row.selling_fee) || 0) : 0;
    const totalCost = Number((Number(costs.total_cost || 0) + sellingFee).toFixed(2));
    const profit = Number((Number(row.sale_total || 0) - totalCost).toFixed(2));
    const values = [
      businessId,
      localDate(receivedAt),
      row.platform,
      row.order_id,
      sourceEmailId,
      createdBy,
      JSON.stringify({
        source: 'gmail_direct_sales',
        gmail_message_id: messageId,
        source_link_parser_version: 1,
        source_image_parser_version: 1,
        ...(row.source_url ? { source_url: row.source_url } : {}),
        ...(row.image_url ? { image_url: row.image_url } : {}),
        ...(row.depop_bundle ? {
          depop_bundle: true,
          bundle_item_count: row.bundle_item_count || row.quantity || 1,
          bundle_item_titles: Array.isArray(row.bundle_item_titles) ? row.bundle_item_titles : [],
        } : {}),
        ...(row.platform === 'Poshmark' ? { poshmark_parser_version: 4 } : {}),
        ...(row.platform === 'Mercari' ? { mercari_selling_fee: sellingFee, mercari_earnings: row.earnings } : {}),
        ...(row.platform === 'Facebook Marketplace' ? { facebook_image_parser_version: 3 } : {}),
      }),
      row.product_name,
      row.quantity,
      row.size,
      row.unit_price,
      row.sale_total,
      row.buyer,
      costs.base_item_cost,
      costs.paper_ink_cost,
      costs.packaging_cost,
      totalCost,
      profit,
    ];

    // Repair an earlier incomplete import in place. This is especially useful
    // for old Poshmark rows that were saved before the email price parser was
    // broadened and therefore never contributed to dashboard totals.
    const result = await client.query(`
      WITH sync_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended($1::text || ':' || $5::text, 0)
        )
      ), repaired AS (
        UPDATE artflow.orders
           SET sale_date=$2,
               platform=$3,
               order_id=COALESCE(NULLIF($4::text,''),order_id),
               source_email_id=$5,
               updated_date=now(),
               data=COALESCE(data,'{}'::jsonb)||$7::jsonb,
               product_name=$8,
               quantity=$9,
               size=$10,
               unit_price=$11,
               sale_total=$12,
               buyer=$13,
               base_item_cost=$14,
               paper_ink_cost=$15,
               packaging_cost=$16,
               total_cost=$17,
               estimated_profit=$18,
               sync_source='gmail_direct_sales'
          FROM sync_lock
         WHERE business_id=$1
           AND (
             source_email_id=$5 OR
             ($4::text IS NOT NULL AND $4::text<>'' AND order_id=$4::text AND platform=$3) OR
             (platform=$3 AND lower(product_name)=lower($8) AND sale_date=$2 AND COALESCE(sale_total,0)=0)
           )
         RETURNING base44_id,product_name,platform,sale_total
      ), inserted AS (
        INSERT INTO artflow.orders (
          base44_id,business_id,sale_date,platform,archived,order_id,source_email_id,created_by_id,created_date,updated_date,data,
          product_name,quantity,size,unit_price,sale_total,buyer,base_item_cost,paper_ink_cost,packaging_cost,total_cost,estimated_profit,sync_source
        )
        SELECT gen_random_uuid()::text,$1,$2,$3,false,$4::text,$5,$6,now(),now(),$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'gmail_direct_sales'
         WHERE NOT EXISTS (SELECT 1 FROM repaired)
           AND NOT EXISTS (
             SELECT 1 FROM artflow.orders
              WHERE business_id=$1 AND (
                source_email_id=$5 OR
                ($4::text IS NOT NULL AND $4::text<>'' AND order_id=$4::text AND platform=$3) OR
                (platform=$3 AND lower(product_name)=lower($8) AND sale_date=$2 AND abs(COALESCE(sale_total,0)-$12)<0.01)
              )
           )
        RETURNING base44_id,product_name,platform,sale_total
      )
      SELECT * FROM repaired
      UNION ALL
      SELECT * FROM inserted
      LIMIT 1
    `, values);
    if (result.rows[0]) inserted.push(result.rows[0]);
  }
  return inserted;
}

async function archivePoshmarkCancellation(client, businessId, messageId, subject, text) {
  const cancellation = parsePoshmarkCancellation(subject, text);
  if (!cancellation) return 0;

  const result = await client.query(
    `UPDATE artflow.orders
        SET archived=true,
            updated_date=now(),
            data=COALESCE(data,'{}'::jsonb) || jsonb_build_object(
              'poshmark_canceled',true,
              'cancellation_email_id',$4::text,
              'canceled_at',now()
            )
      WHERE business_id=$1
        AND platform='Poshmark'
        AND archived IS NOT TRUE
        AND (
          ($2::text<>'' AND order_id=$2::text)
          OR ($3::text<>'' AND lower(product_name)=lower($3::text))
        )
      RETURNING base44_id`,
    [businessId, cancellation.order_id || '', cancellation.product_name || '', messageId]
  );
  return Number(result.rowCount || 0);
}

async function archiveLegacyDepopBundleRows(client, businessId, messageId, rows) {
  const bundle = rows.length === 1 && rows[0]?.platform === 'Depop' && rows[0]?.depop_bundle;
  if (!bundle) return 0;

  const result = await client.query(
    `UPDATE artflow.orders
        SET archived=true,
            updated_date=now(),
            data=COALESCE(data,'{}'::jsonb) || jsonb_build_object(
              'replaced_by_depop_bundle', true,
              'bundle_message_id', $2::text
            )
      WHERE business_id=$1
        AND platform='Depop'
        AND archived IS NOT TRUE
        AND split_part(COALESCE(source_email_id,''), ':', 1)=$2
        AND COALESCE(source_email_id,'')<>$2
      RETURNING base44_id`,
    [businessId, messageId]
  );

  return Number(result.rowCount || 0);
}

// Sync one Gmail mailbox into the given business workspace. Returns the counts
// the callers aggregate for their status responses. Permission problems are
// reported via reconnectRequired instead of throwing; other errors bubble up.
export async function syncGmailAccount(client, business, accessToken, { force = false } = {}) {
  const result = { matched: 0, scanned: 0, parsed: 0, imported: 0, canceled: 0, reconnectRequired: false, throttled: false, gmailAddress: '' };
  if (!business?.base44_id) return result;

  let gmailAddress = '';
  try {
    const profileData = await googleJson(accessToken, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
    gmailAddress = normalize(profileData?.emailAddress || '');
  } catch (error) {
    if (error?.code === 'GMAIL_RECONNECT' || error?.status === 401) {
      result.reconnectRequired = true;
      return result;
    }
    throw error;
  }
  if (!gmailAddress) return result;
  result.gmailAddress = gmailAddress;

  const syncState = business?.data?.gmail_sales_sync || {};
  const previous = syncState?.[gmailAddress] || {};
  const lastAt = previous?.last_at ? new Date(previous.last_at).getTime() : 0;
  if (!force && lastAt && Date.now() - lastAt < 5 * 60 * 1000) {
    result.matched = 1;
    result.throttled = true;
    return result;
  }

  const allowedEmails = approvedSalesEmails(business);
  if (!allowedEmails.has(gmailAddress)) {
    // The user explicitly granted Gmail access through Art Flow. Attach that
    // mailbox to the business workspace so it does not have to be typed in
    // separately under Sales/Expense email settings.
    await approveGmailEmail(client, business, gmailAddress);
  }
  result.matched = 1;

  // Re-read older Poshmark orders that were imported before the current
  // price/bundle parser. These rows already know their Gmail message IDs, so
  // repair them before spending Gmail quota on broad mailbox searches.
  const repairCandidates = await client.query(`
    SELECT DISTINCT split_part(source_email_id, ':', 1) AS message_id
      FROM artflow.orders
     WHERE business_id=$1
       AND sync_source='gmail_direct_sales'
       AND COALESCE(source_email_id,'')<>''
       AND (
         COALESCE(data->>'source_image_parser_version','') <> '1'
         OR (
           platform='Poshmark'
           AND (
             COALESCE(sale_total,0)=0
             OR COALESCE(data->>'poshmark_parser_version','') <> '4'
           )
         )
         OR (
           platform='Depop'
           AND source_email_id LIKE '%:%'
         )
         OR (
           platform='Facebook Marketplace'
           AND COALESCE(data->>'facebook_image_parser_version','') <> '3'
         )
       )
     ORDER BY 1
  `, [business.base44_id]);
  const repairMessageIds = repairCandidates.rows
    .map((row) => clean(row.message_id))
    .filter(Boolean);

  // If a full repair batch is already known, skip the expensive mailbox list
  // queries on this run. The next automatic/manual sync continues the backlog.
  const messageIds = !force && repairMessageIds.length >= 200
    ? []
    : await listMessageIds(accessToken);

  const completed = await client.query(`
    SELECT message_id
      FROM (
        SELECT split_part(source_email_id, ':', 1) AS message_id
          FROM artflow.orders
         WHERE business_id=$1
           AND sync_source='gmail_direct_sales'
           AND COALESCE(source_email_id,'')<>''
         GROUP BY 1
        HAVING bool_and(
          COALESCE(sale_total,0)>0
          AND (
            platform <> 'Poshmark'
            OR COALESCE(data->>'poshmark_parser_version','') = '4'
          )
          AND COALESCE(data->>'source_link_parser_version','') = '1'
          AND COALESCE(data->>'source_image_parser_version','') = '1'
          AND (
            platform <> 'Facebook Marketplace'
            OR COALESCE(data->>'facebook_image_parser_version','') = '3'
          )
        )
        UNION
        SELECT data->>'cancellation_email_id' AS message_id
          FROM artflow.orders
         WHERE business_id=$1
           AND platform='Poshmark'
           AND COALESCE(data->>'poshmark_canceled','false')='true'
           AND COALESCE(data->>'cancellation_email_id','')<>''
      ) completed_messages
     WHERE COALESCE(message_id,'')<>''
  `, [business.base44_id]);
  const completedIds = new Set(completed.rows.map((row) => clean(row.message_id)).filter(Boolean));
  // New sale emails take priority over older orders needing image repairs.
  // Keep each refresh small enough to stay within Gmail's per-user quota.
  const existingMessages = await client.query(`
    SELECT DISTINCT split_part(source_email_id, ':', 1) AS message_id
      FROM artflow.orders
     WHERE business_id=$1
       AND sync_source='gmail_direct_sales'
       AND COALESCE(source_email_id,'')<>''
  `, [business.base44_id]);
  const existingIds = new Set(existingMessages.rows.map((row) => clean(row.message_id)).filter(Boolean));
  const freshIds = messageIds.filter((id) => !existingIds.has(id) && !completedIds.has(id));
  const pendingMessageIds = Array.from(new Set([
    ...freshIds,
    ...repairMessageIds,
    ...messageIds.filter((id) => !completedIds.has(id)),
  ])).slice(0, force ? 40 : 30);
  result.scanned = pendingMessageIds.length;
  for (let index = 0; index < pendingMessageIds.length; index += 10) {
    const batchIds = pendingMessageIds.slice(index, index + 10);
    let messages = [];
    try {
      messages = await Promise.all(batchIds.map((messageId) => readMessage(accessToken, messageId)));
    } catch (error) {
      if (error?.code === 'GMAIL_RATE_LIMIT') {
        result.throttled = true;
        break;
      }
      throw error;
    }
    for (let offset = 0; offset < messages.length; offset += 1) {
      const messageId = batchIds[offset];
      const message = messages[offset];
      const from = headerValue(message, 'From');
      const senderEmail = addressOnly(from);
      const trustedForwarder = allowedEmails.has(senderEmail);
      if (!isAllowedMarketplaceSender(from) && !trustedForwarder) continue;
      const subject = headerValue(message, 'Subject');
      const text = bodyTextFromPayload(message?.payload || {});
      const html = bodyHtmlFromPayload(message?.payload || {});

      const canceled = await archivePoshmarkCancellation(
        client,
        business.base44_id,
        messageId,
        subject,
        text
      );
      if (canceled) {
        result.canceled += canceled;
        continue;
      }

      // Some marketplace messages put the item price only in the HTML table
      // while the text/plain part contains the order wording but omits the
      // amount. Parse a combined representation so a valid Poshmark sale is
      // never saved as $0 merely because Gmail's plain part was incomplete.
      const combinedText = [text, html ? htmlToText(html) : ''].filter(Boolean).join('\n');
      const rows = parseSaleEmail(from, subject, combinedText, trustedForwarder);
      if (!rows.length) continue;
      for (const row of rows) {
        if (row.platform === 'Poshmark' && /^[a-f0-9]{24}$/i.test(clean(row.order_id))) {
          row.source_url = `https://poshmark.com/order/sales/${clean(row.order_id)}`;
        } else {
          const sourceUrl = marketplaceSourceUrl(row.platform, html);
          if (sourceUrl) row.source_url = sourceUrl;
        }

        if (!row.depop_bundle) {
          const imageUrl = marketplaceImageUrl(row.platform, html, row.product_name);
          if (imageUrl) row.image_url = imageUrl;
        }
      }
      result.parsed += rows.length;
      const receivedAt = Number(message?.internalDate)
        ? new Date(Number(message.internalDate)).toISOString()
        : headerValue(message, 'Date') || new Date().toISOString();

      await archiveLegacyDepopBundleRows(client, business.base44_id, messageId, rows);
      const saved = await insertRows(client, business.base44_id, messageId, receivedAt, rows);
      result.imported += saved.length;
    }
  }

  const nextBusinessData = {
    ...(business.data || {}),
    gmail_sales_sync: {
      ...((business.data || {}).gmail_sales_sync || {}),
      [gmailAddress]: {
        last_at: new Date().toISOString(),
        last_scanned: result.scanned,
        last_parsed: result.parsed,
        last_imported: result.imported,
        last_canceled: result.canceled,
      },
    },
  };
  await client.query(
    `UPDATE artflow.businesses SET data=$2::jsonb, updated_date=now() WHERE base44_id=$1`,
    [business.base44_id, JSON.stringify(nextBusinessData)]
  ).catch(() => {});
  business.data = nextBusinessData;

  return result;
}

const ARTFLOW_GOOGLE_CLIENT_ID = "280802752102-m7pnv9mdpjrehg3maln9kjk4du8m80nb.apps.googleusercontent.com";

function cleanGoogleEnvValue(value = '') {
  const text = String(value || '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function googleOAuthCredentials() {
  let clientId = cleanGoogleEnvValue(process.env.GOOGLE_CLIENT_ID);
  let clientSecret = cleanGoogleEnvValue(process.env.GOOGLE_CLIENT_SECRET);
  const looksLikeClientId = (value = '') => /\.apps\.googleusercontent\.com$/i.test(String(value || '').trim());

  // Keep background token refresh aligned with Better Auth. Some earlier
  // deployments had these two Vercel variables entered in opposite fields.
  if (!looksLikeClientId(clientId) && looksLikeClientId(clientSecret)) {
    [clientId, clientSecret] = [clientSecret, clientId];
  }
  if (process.env.VERCEL_ENV === 'production') clientId = ARTFLOW_GOOGLE_CLIENT_ID;

  return { clientId, clientSecret };
}

// Refresh (or reuse) the Google access token for a better-auth account row so
// background jobs can read Gmail without a browser session. Persists the new
// token so signed-in sessions keep working too.
export async function googleAccessTokenFor(client, account) {
  const expiresAt = account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt).getTime() : 0;
  if (account.accessToken && expiresAt - Date.now() > 60_000) return account.accessToken;
  if (!account.refreshToken) {
    const error = new Error('Google account has no refresh token; reconnect in Account.');
    error.code = 'GMAIL_RECONNECT';
    throw error;
  }

  const { clientId, clientSecret } = googleOAuthCredentials();
  if (!clientId || !clientSecret) {
    const error = new Error('Google OAuth credentials are not configured for background Gmail sync.');
    error.code = 'GMAIL_RECONNECT';
    throw error;
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(`Google token refresh failed (${response.status})${text ? `: ${text.slice(0, 180)}` : ''}`);
    error.status = response.status;
    error.code = response.status === 400 || response.status === 401 ? 'GMAIL_RECONNECT' : 'GMAIL_REFRESH';
    throw error;
  }
  const data = await response.json();
  if (!data?.access_token) throw new Error('Google token refresh returned no access token.');
  await client.query(
    `UPDATE account SET "accessToken"=$1, "accessTokenExpiresAt"=$2, "updatedAt"=now() WHERE id=$3`,
    [data.access_token, new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000), account.id]
  );
  return data.access_token;
}
