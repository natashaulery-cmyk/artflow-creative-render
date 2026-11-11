// Parse confirmed Mercari U.S. seller sale notices only.
const clean = (value = '') => String(value ?? '').replace(/\r/g, '').trim();

export function isMercariSender(value = '') {
  const raw = clean(value).toLowerCase();
  const email = raw.match(/<([^>]+)>/)?.[1] || raw;
  return email.endsWith('@alerts.us.mercari.com') || email.endsWith('@mercari.com');
}

export function parseMercariSaleEmail(subject = '', text = '') {
  const normalizedSubject = clean(subject).replace(/^(?:(?:fwd?|fw):\s*)+/i, '');
  const title = clean(normalizedSubject.match(/^You['’]ve made a sale:\s*(.+)$/i)?.[1] || '');
  if (!title) return [];
  const body = clean(text);
  if (!/Congratulations!\s*You made a sale|You made a sale\./i.test(body)) return [];

  const itemId = clean(body.match(/\bID:\s*(m\d{8,})\b/i)?.[1] || '');
  if (!itemId) return [];

  // The label order in sale notices is "Price / Selling fee / $price / -$fee / Earnings".
  // Buyer tax and buyer protection fee occur after Earnings and are not seller revenue.
  const block = body.match(/\bPrice\b([\s\S]{0,450}?)\bEarnings\b/i)?.[1] || '';
  const amounts = [...block.matchAll(/(-?)\$\s*([\d,]+(?:\.\d{2})?)/g)];
  const price = amounts.length ? Number(amounts[0][2].replace(/,/g, '')) : 0;
  if (!Number.isFinite(price) || price <= 0) return [];
  const sellingFee = amounts.slice(1).filter((match) => match[1] === '-')
    .reduce((sum, match) => sum + Number(match[2].replace(/,/g, '')), 0);
  const earnings = Number(body.match(/\bEarnings\s*\$([\d,]+(?:\.\d{2})?)/i)?.[1]?.replace(/,/g, '') || 0);
  const buyer = clean(body.match(/\bShipping to\s+([^\n]+)/i)?.[1] || '');
  const size = title.match(/\b(\d{1,2}(?:\.\d+)?)\s*[x×]\s*(\d{1,2}(?:\.\d+)?)\b/i);
  return [{
    platform: 'Mercari',
    product_name: title,
    quantity: 1,
    size: size ? size[1] + 'x' + size[2] : 'Other',
    sale_total: price,
    unit_price: price,
    order_id: itemId,
    buyer,
    selling_fee: Number(sellingFee.toFixed(2)),
    earnings,
    source_url: 'https://www.mercari.com/us/item/' + encodeURIComponent(itemId) + '/',
  }];
}
