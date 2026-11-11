import test from 'node:test';
import assert from 'node:assert/strict';
import { orderSourceUrl, mercariArtworkUrl } from '../src/lib/platforms.js';

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


test('existing Mercari orders recover a stable artwork thumbnail, not an email logo', () => {
  const order = { platform: 'Mercari', order_id: 'm12345678901' };
  const photo = 'https://u-mercari-images.mercdn.net/thumb/photos/m12345678901_1.jpg';
  assert.equal(mercariArtworkUrl(order), photo);
  assert.equal(mercariArtworkUrl(order, 'https://u-mercari-images.mercdn.net/assets/img/mail_responsive/common/logo-blue.png'), photo);
  assert.equal(mercariArtworkUrl(order, 'https://u-mercari-images.mercdn.net/thumb/photos/m99999999999_1.jpg'), photo);
  assert.equal(mercariArtworkUrl(order, photo + '?version=1'), photo + '?version=1');
  assert.equal(mercariArtworkUrl({ platform: 'Mercari', order_id: 'invalid' }), '');
});
