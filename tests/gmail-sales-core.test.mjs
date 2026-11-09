import test from 'node:test';
import assert from 'node:assert/strict';

import { GMAIL_QUERIES, parsePoshmarkCancellation, parseSaleEmail } from '../api/_gmail-sales-core.mjs';

test('parses a multiline Poshmark sold email with the full item price', () => {
  const rows = parseSaleEmail(
    'Poshmark <orders@poshmark.com>',
    '"8x10 Plum Botanical Art Print" just sold to @artbuyer on Poshmark!',
    [
      'Order ID',
      'abc-123-def',
      'Item',
      'Price',
      '8x10 Plum Botanical Art Print',
      '$24.00',
      'Your Earnings',
      '$19.20',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'Poshmark');
  assert.equal(rows[0].order_id, 'abc-123-def');
  assert.equal(rows[0].sale_total, 24);
  assert.equal(rows[0].buyer, 'artbuyer');
});

test('parses a forwarded Poshmark sold email with an inline item price', () => {
  const rows = parseSaleEmail(
    'orders@poshmark.com',
    'Fwd: "5x7 Skeleton Floral Print" just sold to @collector on Poshmark!',
    'Order ID: 9988-7766\nItem Price: $12.50\nPackaging Reminder'
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].product_name, '5x7 Skeleton Floral Print');
  assert.equal(rows[0].sale_total, 12.5);
  assert.equal(rows[0].size, '5x7');
});

test('parses a flattened Poshmark sold email with size before price', () => {
  const rows = parseSaleEmail(
    'Poshmark <orders@poshmark.com>',
    '"8 X 8 Black Framed Quilled Butterfly 7 E 89" just sold to @luxierose on Poshmark!',
    [
      'Great news - you just sold "8 X 8 Black Framed Quilled Butterfly 7 E 89" on Poshmark.',
      'Order ID 6ab2df928a91b8c0d4d9aff0',
      'Item Price 8 X 8 Black Framed Quilled Butterfly 7 E 89 Size: OS $10.00',
      'Your Earnings (minus fee and taxes) $7.05',
    ].join(' ')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].order_id, '6ab2df928a91b8c0d4d9aff0');
  assert.equal(rows[0].sale_total, 10);
  assert.equal(rows[0].unit_price, 10);
});

test('parses current unquoted Poshmark sold email subjects', () => {
  const rows = parseSaleEmail(
    'Poshmark <orders@poshmark.com>',
    '10x8 Framed Swirling Night Wall Art just sold to @thehappy186 on Poshmark!',
    'Order ID 6bc49c2e8da91b8c0d4d9aff0\nItem Price $12.00\nYour Earnings $9.05'
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].product_name, '10x8 Framed Swirling Night Wall Art');
  assert.equal(rows[0].buyer, 'thehappy186');
  assert.equal(rows[0].sale_total, 12);
  assert.equal(rows[0].order_id, '6bc49c2e8da91b8c0d4d9aff0');
});

test('parses current unquoted Poshmark bundles with accepted offer amount', () => {
  const rows = parseSaleEmail(
    'orders@poshmark.com',
    'Bundle of 8x10 Framed Quilling-Style and 4 more items just sold to @pmcm207 on Poshmark!',
    'Great news - you just sold 5 items in a bundle.\nOrder ID 6bc49c2e8da91b8c0d4d9aff1\nOffer Price $50.00\nYour Earnings $38.00'
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 5);
  assert.equal(rows[0].sale_total, 50);
  assert.equal(rows[0].unit_price, 10);
});

test('does not treat Poshmark offers as completed sales', () => {
  assert.deepEqual(parseSaleEmail(
    'orders@poshmark.com',
    'New buyer offer on 8x10 Framed Art from @buyer',
    'Offer Price $30.00'
  ), []);
});

test('ignores unrelated Poshmark email subjects', () => {
  const rows = parseSaleEmail(
    'orders@poshmark.com',
    'Your weekly Poshmark report',
    'Item Price: $20.00'
  );

  assert.deepEqual(rows, []);
});


test('uses the accepted offer price for a Poshmark bundle', () => {
  const rows = parseSaleEmail(
    'Poshmark <orders@poshmark.com>',
    '"Bundle of 8 X 8 Framed Quilled Bear and 1 more item" just sold to @confusedfox on Poshmark!',
    [
      'Great news - you just sold 2 items in a bundle.',
      'Order ID',
      '6aafc5d18fa3339dfdab5614',
      'Item',
      'Price',
      '8 X 8 Framed Quilled Bear Family Cd 39',
      'Size: OS',
      '$12.00',
      '8 X 8 Framed Quilled Wolf And Edf 5',
      'Size: OS',
      '$18.00',
      'Offer Price $25.00',
      'Shipping Discount -$1.50',
      'Your Earnings (minus fee and taxes) $18.50',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'Poshmark');
  assert.equal(rows[0].order_id, '6aafc5d18fa3339dfdab5614');
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].sale_total, 25);
  assert.equal(rows[0].unit_price, 12.5);
});


test('parses a prefixed Poshmark sold email with smart quotes', () => {
  const rows = parseSaleEmail(
    'Poshmark <orders@poshmark.com>',
    'Congrats! “8x8 Celestial Skeleton Print” just sold to @moonbuyer on Poshmark!',
    'Order ID: smart-123\nItem Price: $18.00\nPackaging Reminder'
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'Poshmark');
  assert.equal(rows[0].sale_total, 18);
  assert.equal(rows[0].order_id, 'smart-123');
});


test('sums item prices for a legacy Poshmark bundle without a total line', () => {
  const rows = parseSaleEmail(
    'Poshmark <orders@poshmark.com>',
    '"Bundle of Tulip Art and 1 more item" just sold to @buyer on Poshmark!',
    [
      'Great news - you just sold 2 items in a bundle.',
      'Order ID',
      'legacy-bundle-2',
      'Item',
      'Price',
      '8x8 Tulip Art',
      '$12.00',
      '8x8 Floral Art',
      '$12.00',
      'Your Earnings (minus fee and taxes) $19.20',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].sale_total, 24);
  assert.equal(rows[0].unit_price, 12);
});

test('uses discounted Total Price for a legacy Poshmark bundle', () => {
  const rows = parseSaleEmail(
    'Poshmark <orders@poshmark.com>',
    '"Bundle of Quilling Art and 2 more items" just sold to @buyer on Poshmark!',
    [
      'Great news - you just sold 3 items in a bundle.',
      'Order ID',
      'legacy-bundle-3',
      'Item',
      'Price',
      'Art One',
      '$12.00',
      'Art Two',
      '$18.00',
      'Art Three',
      '$12.00',
      'Subtotal $42.00',
      'Seller Discount (20%) -$8.40',
      'Total Price $33.60',
      'Your Earnings (minus fee and taxes) $26.88',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 3);
  assert.equal(rows[0].sale_total, 33.6);
  assert.equal(rows[0].unit_price, 11.2);
});


test('recognizes a Poshmark cancellation and its order id', () => {
  const cancellation = parsePoshmarkCancellation(
    'Please do not ship: "Bundle of 8x8 Paper Quilling Tulip Wall and 1 more item" for @mellymelteaches was canceled',
    [
      'Re: Order Id 6aa45ffa0826402f6551ab6f',
      'Hi Natasha\'s closet,',
      'We wanted to let you know that this order was canceled.',
    ].join('\n')
  );

  assert.deepEqual(cancellation, {
    order_id: '6aa45ffa0826402f6551ab6f',
    product_name: 'Bundle of 8x8 Paper Quilling Tulip Wall and 1 more item',
  });
});

test('Gmail sync includes Poshmark cancellation messages', () => {
  assert.ok(
    GMAIL_QUERIES.some((query) => /poshmark/i.test(query) && /Please do not ship/i.test(query) && /canceled/i.test(query))
  );
});

test('Gmail sync includes Facebook seller shipping-label messages', () => {
  assert.ok(GMAIL_QUERIES.some((query) =>
    query.includes('marketplace.facebook.com')
      && query.includes('Shipping label for your Marketplace order')
  ));
});


test('parses the current Vinted bundle sale email format', () => {
  const rows = parseSaleEmail(
    'Team Vinted <no-reply@vinted.com>',
    'You sold an item on Vinted',
    [
      'Hello natashaulery,',
      'cgulley5 has bought',
      '2',
      'Bundle 2 items',
      '$12.00',
      'We will transfer the buyer\'s payment to your Vinted Wallet once the order is completed.',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'Vinted');
  assert.equal(rows[0].buyer, 'cgulley5');
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].product_name, 'Bundle of 2 items');
  assert.equal(rows[0].sale_total, 12);
  assert.equal(rows[0].unit_price, 6);
});

test('collapses the current Depop multi-item sale confirmation into one bundle order', () => {
  const rows = parseSaleEmail(
    'Depop <sold@alerts.depop.com>',
    'Your USPS shipping label and sale confirmation for @battybonesx.',
    [
      "You've made a sale!",
      'Order details',
      '8x8 Black Framed Black Cat & Crescent...',
      '$8.28',
      '8x8 Black Framed Celestial Black Cat Art...',
      '$8.10',
      'Ship to',
      'China Lund',
      'Buyer',
      'battybonesx',
      'Payment details',
      'Subtotal',
      '$16.38',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'Depop');
  assert.equal(rows[0].buyer, 'battybonesx');
  assert.equal(rows[0].product_name, 'Bundle of 2 items');
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].sale_total, 16.38);
  assert.equal(rows[0].unit_price, 8.19);
  assert.equal(rows[0].depop_bundle, true);
});

test('removes Depop image alt text from a current single-item sale title', () => {
  const rows = parseSaleEmail(
    'Depop <sold@alerts.depop.com>',
    'Your USPS shipping label and sale confirmation for @hanik_911.',
    [
      "You've made a sale!",
      'Order details',
      'image 4x4 Golden Girls Acrylic Magnet | Live...',
      '$7.00',
      'Ship to',
      'Buyer',
      'hanik_911',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].product_name, '4x4 Golden Girls Acrylic Magnet | Live...');
  assert.equal(rows[0].sale_total, 7);
  assert.equal(rows[0].buyer, 'hanik_911');
});

test('ignores eBay listing activity that is not a completed sale', () => {
  const rows = parseSaleEmail(
    'eBay <ebay@ebay.com>',
    'Your listing is live',
    'Your listing is active. Listing price $29.99. Send an offer to interested buyers.'
  );

  assert.deepEqual(rows, []);
});


test('parses the current eBay You made the sale email format', () => {
  const rows = parseSaleEmail(
    'eBay <ebay@ebay.com>',
    'You made the sale for 5x11 Black Framed Celestial Skeleton Art',
    [
      'Next, pack it up and ship it out.',
      'Order total',
      '$24.00',
      'Quantity',
      '1',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'eBay');
  assert.equal(rows[0].product_name, '5x11 Black Framed Celestial Skeleton Art');
  assert.equal(rows[0].sale_total, 24);
  assert.equal(rows[0].quantity, 1);
});


test('keeps exact eBay sale email when the email body omits the sale amount', () => {
  const rows = parseSaleEmail(
    'eBay <ebay@ebay.com>',
    'You made the sale for 5x11 Black Framed Celestial Skeleton Art',
    'Next, pack it up and ship it out.'
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'eBay');
  assert.equal(rows[0].product_name, '5x11 Black Framed Celestial Skeleton Art');
  assert.equal(rows[0].sale_total, 0);
  assert.equal(rows[0].amount_pending, true);
});


test('does not reject an eBay sale just because the email footer mentions a listing', () => {
  const rows = parseSaleEmail(
    'eBay <ebay@ebay.com>',
    'You made the sale for 5x11 Black Framed Celestial Snake Wall Art | Floral',
    [
      'Next, pack it up and ship it out.',
      'Order total',
      '$24.00',
      'Manage your listing',
      'Promote your listing to reach more buyers.',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'eBay');
  assert.equal(rows[0].sale_total, 24);
});


test('parses eBay sale total when email uses USD without a dollar sign', () => {
  const rows = parseSaleEmail(
    'eBay <ebay@ebay.com>',
    'You made the sale for 8x8 Black Framed Quilled Floral Skull Wall Art',
    [
      'Buyer paid',
      'USD 18.50',
      'Ship your item',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'eBay');
  assert.equal(rows[0].sale_total, 18.5);
  assert.equal(rows[0].amount_pending, false);
});


test('keeps parsing eBay dollar sale totals after USD support', () => {
  const rows = parseSaleEmail(
    'eBay <ebay@ebay.com>',
    'You made the sale for 5x11 Black Framed Celestial Snake Wall Art',
    [
      'Order total',
      '$24.00',
      'Ship your item',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sale_total, 24);
  assert.equal(rows[0].amount_pending, false);
});


test('parses eBay Sold label format with shipping shown separately', () => {
  const rows = parseSaleEmail(
    'eBay <ebay@ebay.com>',
    'You made the sale for 8x8 Black Framed Hocus Pocus Quote Wall Art | Billy',
    [
      'Your buyer has paid and now it’s time to get a shipping label.',
      '8x8 Black Framed Hocus Pocus Quote Wall Art | Billy',
      'Sold:',
      '$12.00',
      'Shipping:',
      '$5.83',
      'Order:',
      '20-15234-17601',
      'Date sold:',
      'Oct 04, 2026',
      'Buyer:',
      'lunchbox_1313',
      'Quantity sold:',
      '1',
    ].join('\n')
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'eBay');
  assert.equal(rows[0].product_name, '8x8 Black Framed Hocus Pocus Quote Wall Art | Billy');
  assert.equal(rows[0].sale_total, 12);
  assert.equal(rows[0].unit_price, 12);
  assert.equal(rows[0].order_id, '20-15234-17601');
  assert.equal(rows[0].buyer, 'lunchbox_1313');
  assert.equal(rows[0].quantity, 1);
  assert.equal(rows[0].amount_pending, false);
});
