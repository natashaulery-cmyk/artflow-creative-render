import test from 'node:test';
import assert from 'node:assert/strict';

import { GMAIL_QUERIES } from '../api/_gmail-sales-core.mjs';
import { insertOrders } from '../api/_official-sync-shared.mjs';

test('historical Gmail marketplace queries are not limited to 180 days', () => {
  assert.equal(GMAIL_QUERIES.length, 6);
  for (const query of GMAIL_QUERIES) {
    assert.doesNotMatch(query, /newer_than:/i);
  }
  assert.match(GMAIL_QUERIES.join('\n'), /from:poshmark\.com/i);
  assert.match(GMAIL_QUERIES.join('\n'), /Please do not ship/i);
  assert.match(GMAIL_QUERIES.join('\n'), /noreply@marketplace\.facebook\.com/i);
  assert.match(GMAIL_QUERIES.join('\n'), /alerts\.us\.mercari\.com/i);
});

test('official marketplace sync removes duplicate rows inside one batch', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT created_by_id/.test(sql)) return { rows: [{ created_by_id: 'user-1' }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const repeated = {
    platform: 'eBay',
    sale_date: '2026-09-20',
    order_id: 'ORDER-123',
    product_name: '8x10 Butterfly Print',
    quantity: 1,
    unit_price: 12,
    sale_total: 12,
  };

  await insertOrders(client, 'business-1', [repeated, { ...repeated }], 'ebay_official_oauth');

  const payload = JSON.parse(calls[1].params[0]);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].order_id, 'ORDER-123');
});
