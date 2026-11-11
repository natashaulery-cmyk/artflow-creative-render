import test from 'node:test';
import assert from 'node:assert/strict';
import { isMercariSender, parseMercariSaleEmail } from '../api/_mercari-email.mjs';
import { GMAIL_QUERIES, parseSaleEmail } from '../api/_gmail-sales-core.mjs';

const notice = [
  'Congratulations!',
  'You made a sale.',
  'Item details',
  '8x8 Framed Pink Rose & Butterfly Art Print Vintage Floral Wall Decor',
  'ID: m49684344679',
  'Price',
  'Selling fee',
  '$10.00',
  '-$1.59',
  'Earnings',
  '$8.41',
  'Tax charged to buyer',
  'Buyer protection fee',
  '$0.79',
  '$0.57',
  'Shipping to',
  'FrostedLady',
  'Wichita, KS'
].join('\n');

test('recognizes actual Mercari seller notification', () => {
  assert.equal(isMercariSender('Mercari <no-reply@alerts.us.mercari.com>'), true);
  assert.equal(isMercariSender('fake@example.com'), false);
});

test('captures gross sale, fees and listing ID, not buyer tax', () => {
  const rows = parseSaleEmail(
    'Mercari <no-reply@alerts.us.mercari.com>',
    "You've made a sale: 8x8 Framed Pink Rose & Butterfly Art Print Vintage Floral Wall Decor",
    notice
  );
  assert.equal(rows.length, 1);
  const sale = rows[0];
  assert.equal(sale.platform, 'Mercari');
  assert.equal(sale.size, '8x8');
  assert.equal(sale.order_id, 'm49684344679');
  assert.equal(sale.sale_total, 10);
  assert.equal(sale.selling_fee, 1.59);
  assert.equal(sale.earnings, 8.41);
  assert.equal(sale.buyer, 'FrostedLady');
  assert.equal(sale.source_url, 'https://www.mercari.com/us/item/m49684344679/');
});

test('Mercari Gmail discovery query targets confirmed sales', () => {
  assert.ok(GMAIL_QUERIES.some((query) => query.includes('alerts.us.mercari.com') && query.includes('made a sale')));
});

test('does not import offers, missing amounts or missing IDs', () => {
  assert.deepEqual(parseMercariSaleEmail('Offer received', notice), []);
  assert.deepEqual(parseMercariSaleEmail("You've made a sale: Tulips", 'Buyer made an offer'), []);
  assert.deepEqual(parseMercariSaleEmail("You've made a sale: Tulips", 'Congratulations! You made a sale. Price $10.00'), []);
});

test('supports a compact price/fee format', () => {
  const rows = parseMercariSaleEmail("You've made a sale: 5x7 Cat Art",
    'Congratulations! You made a sale. ID: m12345678901 Price Selling fee $15.00 -$2.10 Earnings $12.90');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sale_total, 15);
  assert.equal(rows[0].selling_fee, 2.1);
});
