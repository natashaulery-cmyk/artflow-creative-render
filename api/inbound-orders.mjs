import pg from 'pg';
import { pooledDatabaseUrl } from './_db.mjs';
import getRawBody from 'raw-body';
import { Resend } from 'resend';
import { isMercariSender, parseMercariSaleEmail } from './_mercari-email.mjs';

const { Pool } = pg;
const pool = new Pool({
  connectionString: pooledDatabaseUrl(),
  ssl: { rejectUnauthorized: false },
  max: 1,
});

// Construct Resend lazily: the SDK throws in its constructor when the API key
// is missing, which would crash the whole function at module load. Resolving
// it on first use turns a missing key into a clean logged error instead.
const getResend = () => {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  return new Resend(process.env.RESEND_API_KEY);
};

export const config = {
  api: {
    bodyParser: false,
  },
};

const clean = (value = '') => String(value ?? '').replace(/\r/g, '').trim();

function addressOnly(value = '') {
  const text = clean(value).toLowerCase();
  const angle = text.match(/<([^>]+)>/);
  return clean(angle?.[1] || text).replace(/^mailto:/, '');
}

function isAllowedMarketplaceSender(value = '') {
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

function approvedBusinessForwarders(config = {}) {
  const data = config?.business_data || {};
  return [
    config?.primary_email,
    data.primary_email,
    ...(Array.isArray(data.sales_emails) ? data.sales_emails : []),
  ].map(addressOnly).filter(Boolean);
}

function isApprovedBusinessForwarder(config, value = '') {
  const email = addressOnly(value);
  return Boolean(email && approvedBusinessForwarders(config).includes(email));
}

function forwardedMarketplaceSender(text = '') {
  const fromLines = [...String(text || '').matchAll(/(?:^|\n)\s*From:\s*([^\n]+)/gim)];
  for (const match of fromLines) {
    const sender = addressOnly(match?.[1] || '');
    if (isAllowedMarketplaceSender(sender)) return sender;
  }
  const addresses = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return addresses.map(addressOnly).find(isAllowedMarketplaceSender) || '';
}

function originalForwardedSubject(subject = '') {
  return clean(subject).replace(/^(?:(?:fwd?|fw):\s*)+/i, '');
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
    order_id: null,
  }];
}

function poshmarkRows(subject, text) {
  const subjectMatch = subject.match(/^"([\s\S]+?)"\s+just sold to\s+@([^\s!]+)\s+on Poshmark!/i);
  if (!subjectMatch) return [];
  const title = clean(subjectMatch[1]);
  const buyer = clean(subjectMatch[2]);
  const orderId = clean(text.match(/Order ID\s*\n\s*([a-z0-9]+)/i)?.[1] || '');
  const itemBlock = text.match(/Item\s*\n\s*Price\s*\n([\s\S]*?)(?:Your Earnings|Sales tax|Packaging Reminder)/i)?.[1] || '';
  const price = Number((itemBlock.match(/\$([\d,.]+)/)?.[1] || '').replace(/,/g, '')) || 0;
  return [{
    platform: 'Poshmark',
    product_name: title,
    quantity: Math.max(1, Number(text.match(/Quantity(?:\s+sold)?\s*(?:\n|:)?\s*(\d+)/i)?.[1] || 1)),
    size: sizeFromTitle(title),
    sale_total: price,
    unit_price: price,
    buyer,
    order_id: orderId || null,
  }];
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

  // A Depop bundle is one sale and must stay one order. Saving every product
  // as a separate order overstates the order count and loses the bundle's
  // gross subtotal when this message arrives through the forwarding webhook.
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
      order_id: null,
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
    order_id: null,
  }];
}

function facebookMarketplaceRows(subject = '', text = '') {
  const normalizedSubject = clean(subject).replace(/^(?:(?:fwd?|fw):\s*)+/i, '');
  const subjectMatch = normalizedSubject.match(/^New Marketplace order for\s+(.+?)\s*$/i);
  const shippingLabel = /^Shipping label for your Marketplace order$/i.test(normalizedSubject);
  if (!subjectMatch && !shippingLabel) return [];

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
  if (!sellerSale || (shippingLabel && !verifiedShippingLabel)) return [];

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
  const priceText = nearbyText.match(/(?:US\s*)?\$\s*([\d,]+(?:\.\d{2})?)/i)?.[1]
    || String(text).match(/(?:US\s*)?\$\s*([\d,]+(?:\.\d{2})?)/i)?.[1]
    || '';
  const saleTotal = Number(String(priceText).replace(/,/g, '')) || 0;
  if (saleTotal <= 0) return [];

  return [{
    platform: 'Facebook Marketplace',
    product_name: title,
    quantity: 1,
    size: sizeFromTitle(title),
    sale_total: saleTotal,
    unit_price: saleTotal,
    buyer: shippingLabel
      ? clean(String(text).match(/prepaid shipping label for\s+(.+?)'s order is attached/i)?.[1] || '')
      : '',
    order_id: orderId || null,
    source_url: orderId ? `https://www.facebook.com/marketplace/you/shipping_orders/${orderId}/` : '',
  }];
}

function firstAmount(text, patterns = []) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = Number((match?.[1] || '').replace(/,/g, ''));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function ebayRows(subject, text) {
  if (!/sold|sale/i.test(subject)) return [];
  const title = clean(
    subject.match(/you made (?:a|the) sale for\s+(.+?)[.!]*\s*$/i)?.[1] ||
    subject.match(/you sold an item\s*:?\s*(.+?)[.!]*\s*$/i)?.[1] ||
    subject.match(/^eBay item sold\s*:?\s*(.+)/i)?.[1] ||
    text.match(/item\s+title\s*:?\s*([^\n]+)/i)?.[1] ||
    text.match(/sold\s+item\s*:?\s*([^\n]+)/i)?.[1] ||
    'eBay sale'
  ).slice(0, 120);
  const orderId = clean(text.match(/order\s*(?:number|#)?\s*[:#]?\s*([\d-]{6,})/i)?.[1] || '') || null;
  const saleTotal = firstAmount(text, [
    /(?:^|\n)\s*Sold\s*(?:\n|:)\s*\$([\d,]+(?:\.\d{2})?)/im,
    /(?:order )?total[:\s]*\$([\d,]+(?:\.\d{2})?)/i,
    /\$([\d,]+\.\d{2})/,
  ]);
  if (!saleTotal) return [];
  return [{
    platform: 'eBay',
    product_name: title,
    quantity: 1,
    size: sizeFromTitle(title),
    sale_total: saleTotal,
    unit_price: saleTotal,
    buyer: clean(text.match(/buyer(?: name)?\s*:?\s*([^\n,]+)/i)?.[1] || ''),
    order_id: orderId,
  }];
}

export function parseSaleEmail(from, subject, text) {
  const email = addressOnly(from);
  if (email.endsWith('@vinted.com')) return vintedRows(subject, text);
  if (email.endsWith('@poshmark.com')) return poshmarkRows(subject, text);
  if (email.endsWith('@alerts.depop.com') || email.endsWith('@ohhey.depop.com')) return depopRows(subject, text);
  if (email.endsWith('@ebay.com')) return ebayRows(subject, text);
  if (email.endsWith('@marketplace.facebook.com')) return facebookMarketplaceRows(subject, text);
  if (isMercariSender(email)) return parseMercariSaleEmail(subject, text);
  return [];
}

async function readWebhookConfig(client) {
  const result = await client.query(`
    SELECT s.business_id, s.data, b.primary_email, b.data AS business_data
    FROM artflow.sync_states s
    LEFT JOIN artflow.businesses b ON b.base44_id = s.business_id
    WHERE s.source='resend_inbound_orders'
    ORDER BY s.updated_date DESC NULLS LAST, s.created_date DESC NULLS LAST
  `);
  return result.rows;
}

export async function insertRows(client, businessId, emailId, receivedAt, rows) {
  const createdBy = (await client.query(`SELECT created_by_id FROM artflow.orders WHERE business_id=$1 AND created_by_id IS NOT NULL ORDER BY created_date DESC LIMIT 1`, [businessId])).rows[0]?.created_by_id || null;
  const inserted = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const sourceEmailId = rows.length > 1 ? `${emailId}:${index + 1}` : emailId;
    const costs = costsFor(row.product_name, row.quantity);
    const sellingFee = row.platform === 'Mercari' ? Math.max(0, Number(row.selling_fee) || 0) : 0;
    const totalCost = Number((Number(costs.total_cost || 0) + sellingFee).toFixed(2));
    const profit = Number((Number(row.sale_total || 0) - totalCost).toFixed(2));
    const result = await client.query(`
      INSERT INTO artflow.orders (
        base44_id,business_id,sale_date,platform,archived,order_id,source_email_id,created_by_id,created_date,updated_date,data,
        product_name,quantity,size,unit_price,sale_total,buyer,base_item_cost,paper_ink_cost,packaging_cost,total_cost,estimated_profit,sync_source
      )
      SELECT gen_random_uuid()::text,$1,$2,$3,false,$4::text,$5,$6,now(),now(),$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'resend_inbound_email'
      WHERE NOT EXISTS (
        SELECT 1 FROM artflow.orders
        WHERE business_id=$1 AND (
          source_email_id=$5 OR
          ($4::text IS NOT NULL AND $4::text<>'' AND order_id=$4::text AND platform=$3) OR
          (platform=$3 AND lower(product_name)=lower($8) AND sale_date=$2 AND abs(COALESCE(sale_total,0)-$12)<0.01)
        )
      )
      RETURNING base44_id,product_name,platform,sale_total
    `,[
      businessId,
      localDate(receivedAt),
      row.platform,
      row.order_id,
      sourceEmailId,
      createdBy,
      JSON.stringify({
        source: 'resend_inbound_email',
        resend_email_id: emailId,
        ...(row.platform === 'Mercari' ? { mercari_selling_fee: sellingFee, mercari_earnings: row.earnings, ...(row.source_url ? { source_url: row.source_url } : {}) } : {}),
        ...(row.depop_bundle ? {
          depop_bundle: true,
          bundle_item_count: row.bundle_item_count || row.quantity || 1,
          bundle_item_titles: Array.isArray(row.bundle_item_titles) ? row.bundle_item_titles : [],
        } : {}),
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
    ]);
    if (result.rows[0]) inserted.push(result.rows[0]);
  }
  return inserted;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (error) {
    console.error('Inbound order email: could not read raw body', error?.message || error);
    return res.status(400).send('Error');
  }

  const client = await pool.connect();
  try {
    const configs = await readWebhookConfig(client);
    const webhookSecret = clean(configs.find((row) => row.data?.webhook_secret)?.data?.webhook_secret || process.env.RESEND_WEBHOOK_SECRET);
    if (!webhookSecret) {
      console.error('Inbound order email: webhook secret is not configured');
      return res.status(503).send('Not configured');
    }

    const event = getResend().webhooks.verify({
      payload: rawBody.toString('utf8'),
      headers: {
        'svix-id': req.headers['svix-id'],
        'svix-timestamp': req.headers['svix-timestamp'],
        'svix-signature': req.headers['svix-signature'],
      },
      secret: webhookSecret,
    });

    if (event?.type !== 'email.received') return res.status(200).send('OK');

    const recipients = (Array.isArray(event?.data?.to) ? event.data.to : [event?.data?.to])
      .map(addressOnly)
      .filter(Boolean);
    const config = configs.find((row) => recipients.includes(addressOnly(row.data?.inbound_email)));
    if (!config?.business_id) {
      console.warn('Inbound order email: no business mapping for recipient');
      return res.status(200).send('OK');
    }

    const received = await getResend().emails.receiving.get(event.data.email_id);
    const email = received?.data || received;
    const rawSubject = clean(email?.subject || event?.data?.subject || '');
    const text = clean(email?.text || htmlToText(email?.html || ''));
    const outerSender = addressOnly(event?.data?.from);
    let marketplaceSender = outerSender;
    let subject = rawSubject;

    if (!isAllowedMarketplaceSender(outerSender)) {
      if (!isApprovedBusinessForwarder(config, outerSender)) {
        console.warn('Inbound order email: rejected sender', outerSender);
        return res.status(200).send('OK');
      }
      marketplaceSender = forwardedMarketplaceSender(text);
      subject = originalForwardedSubject(rawSubject);
      if (!marketplaceSender) {
        console.warn('Inbound order email: approved forward missing marketplace sender');
        return res.status(200).send('OK');
      }
    }

    const parsedRows = parseSaleEmail(marketplaceSender, subject, text);
    if (!parsedRows.length) return res.status(200).send('OK');

    const inserted = await insertRows(client, config.business_id, event.data.email_id, email?.created_at || event?.created_at || new Date().toISOString(), parsedRows);
    console.log('Inbound order email processed', { platform: parsedRows[0]?.platform, parsed: parsedRows.length, inserted: inserted.length });
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Inbound order email error', error?.message || error);
    return res.status(400).send('Error');
  } finally {
    client.release();
  }
}
