import test from 'node:test';
import assert from 'node:assert/strict';
import { orderSourceUrl } from '../src/lib/platforms.js';

test('Mercari item IDs open original listings', () => {
  assert.equal(orderSourceUrl({ platform: 'Mercari', order_id: 'm12345678901' }),
    'https://www.mercari.com/us/item/m12345678901/');
  assert.equal(orderSourceUrl({ platform: 'Mercari', order_id: 'internal-id' }),
    'https://www.mercari.com/');
});

test('eBay details use marketplace order IDs, never internal email import IDs', () => {
  assert.equal(orderSourceUrl({ platform: 'eBay', order_id: '20-12345-67890' }),
    'https://www.ebay.com/sh/ord/details?orderid=20-12345-67890');
  const imported = { platform: 'eBay', order_id: 'yahoo-ebay-receipt-message' };
  assert.equal(orderSourceUrl(imported), 'https://www.ebay.com/');
  assert.equal(orderSourceUrl({ ...imported, data: { source_url: 'https://www.ebay.com/itm/123456789012' } }),
    'https://www.ebay.com/itm/123456789012');
});
