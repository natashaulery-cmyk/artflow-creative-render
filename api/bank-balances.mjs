import crypto from 'node:crypto';
import pg from 'pg';
import { auth } from './auth/_auth.mjs';
import { fromNodeHeaders } from 'better-auth/node';
import { pooledDatabaseUrl } from './_db.mjs';

const pool = new pg.Pool({ connectionString: pooledDatabaseUrl(), ssl: { rejectUnauthorized: false }, max: 2 });
const configured = () => Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET && process.env.BANK_TOKEN_ENCRYPTION_KEY);
const plaidUrl = () => process.env.PLAID_ENV === 'sandbox' ? 'https://sandbox.plaid.com' : 'https://production.plaid.com';

function cryptoKey() {
  const key = Buffer.from(process.env.BANK_TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('Bank token encryption key must contain 32 bytes');
  return key;
}
function seal(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const value = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), value.toString('base64')].join('.');
}
function unseal(value) {
  const [nonce, tag, ciphertext] = String(value || '').split('.');
  if (!nonce || !tag || !ciphertext) throw new Error('Bank connection token invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), Buffer.from(nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
async function plaid(path, payload) {
  const response = await fetch(plaidUrl() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, ...payload }),
    signal: AbortSignal.timeout(40000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.display_message || 'The bank provider could not complete this request.');
    error.code = String(body.error_code || 'BANK_PROVIDER_ERROR');
    throw error;
  }
  return body;
}
function publicAccounts(accounts) {
  return (accounts || []).filter((a) => ['depository', 'credit'].includes(a.type)).map((a) => ({
    id: String(a.account_id || ''),
    name: String(a.name || 'Account').slice(0, 100),
    mask: String(a.mask || '').slice(-4),
    type: String(a.type || ''),
    subtype: String(a.subtype || ''),
    current: typeof a.balances?.current === 'number' ? a.balances.current : null,
    available: typeof a.balances?.available === 'number' ? a.balances.available : null,
    currency: String(a.balances?.iso_currency_code || 'USD'),
  }));
}
async function ensureTable(client) {
  await client.query("CREATE TABLE IF NOT EXISTS artflow.bank_balance_links (user_id text NOT NULL, item_id text NOT NULL, institution_name text NOT NULL DEFAULT 'Bank', encrypted_access_token text NOT NULL, accounts jsonb NOT NULL DEFAULT '[]'::jsonb, refreshed_at timestamptz, attempted_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, item_id))");
}
function sanitize(row) {
  return {
    item_id: row.item_id, institution: row.institution_name,
    accounts: Array.isArray(row.accounts) ? row.accounts : [],
    refreshed_at: row.refreshed_at,
    last_error: row.last_error || null,
    reconnect_required: row.last_error === 'ITEM_LOGIN_REQUIRED' || row.last_error === 'INVALID_ACCESS_TOKEN',
  };
}
async function getConnections(client, userId) {
  const result = await client.query("SELECT item_id,institution_name,accounts,refreshed_at,last_error FROM artflow.bank_balance_links WHERE user_id=$1 ORDER BY created_at ASC", [userId]);
  return result.rows.map(sanitize);
}
async function refreshBalances(client, userId, { force = false } = {}) {
  const rows = (await client.query("SELECT item_id,encrypted_access_token FROM artflow.bank_balance_links WHERE user_id=$1 ORDER BY created_at ASC", [userId])).rows;
  for (const row of rows) {
    // Atomic refresh lease prevents duplicate requests from multiple open browser tabs.
    // Refresh automatically every 15 minutes; manual refresh is limited to once per minute.
    const lease = await client.query("UPDATE artflow.bank_balance_links SET attempted_at=now() WHERE user_id=$1 AND item_id=$2 AND (attempted_at IS NULL OR attempted_at < now() - CASE WHEN $3::boolean THEN interval '1 minute' ELSE interval '15 minutes' END) RETURNING item_id", [userId, row.item_id, force]);
    if (!lease.rowCount) continue;
    try {
      const response = await plaid('/accounts/balance/get', { access_token: unseal(row.encrypted_access_token) });
      await client.query("UPDATE artflow.bank_balance_links SET accounts=$3::jsonb,refreshed_at=now(),last_error=NULL WHERE user_id=$1 AND item_id=$2",
        [userId, row.item_id, JSON.stringify(publicAccounts(response.accounts))]);
    } catch (error) {
      console.warn('Bank balance refresh unavailable', error.code || 'BANK_PROVIDER_ERROR');
      await client.query("UPDATE artflow.bank_balance_links SET last_error=$3 WHERE user_id=$1 AND item_id=$2",
        [userId, row.item_id, error.code || 'BANK_PROVIDER_ERROR']);
    }
  }
}
function originAllowed(req) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  try { return Boolean(origin && host && new URL(origin).host === host && new URL(origin).protocol === 'https:'); }
  catch { return false; }
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (!session?.user?.id) return res.status(401).json({ error: 'Sign in to ArtFlow to view bank balances.' });
  if (req.method === 'POST' && !originAllowed(req)) return res.status(403).json({ error: 'Invalid request origin.' });
  if (!configured()) return res.status(req.method === 'GET' ? 200 : 503).json({
    configured: false, connections: [], error: req.method === 'GET' ? undefined : 'Secure bank linking has not been activated yet.',
  });
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const userId = String(session.user.id);
    if (req.method === 'GET') {
      await refreshBalances(client, userId, { force: String(req.query?.force || '') === '1' });
      return res.status(200).json({ configured: true, connections: await getConnections(client, userId) });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '');
    if (action === 'link_token') {
      const options = {
        user: { client_user_id: userId },
        client_name: 'ArtFlow Creative',
        products: ['auth'],
        country_codes: ['US'],
        language: 'en',
      };
      if (process.env.PLAID_REDIRECT_URI) options.redirect_uri = process.env.PLAID_REDIRECT_URI;
      if (body.item_id) {
        const item = (await client.query("SELECT encrypted_access_token FROM artflow.bank_balance_links WHERE user_id=$1 AND item_id=$2", [userId, String(body.item_id)])).rows[0];
        if (!item) return res.status(404).json({ error: 'Bank connection not found.' });
        options.access_token = unseal(item.encrypted_access_token);
        delete options.products;
      }
      const result = await plaid('/link/token/create', options);
      return res.status(200).json({ link_token: result.link_token });
    }
    if (action === 'exchange') {
      const publicToken = String(body.public_token || '');
      if (!publicToken || publicToken.length > 1000) return res.status(400).json({ error: 'Invalid connection token.' });
      const result = await plaid('/item/public_token/exchange', { public_token: publicToken });
      const bankName = String(body.institution || 'Bank').slice(0, 100);
      await client.query("INSERT INTO artflow.bank_balance_links (user_id,item_id,institution_name,encrypted_access_token) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,item_id) DO UPDATE SET institution_name=EXCLUDED.institution_name,encrypted_access_token=EXCLUDED.encrypted_access_token,attempted_at=NULL,last_error=NULL",
        [userId, result.item_id, bankName, seal(result.access_token)]);
      await refreshBalances(client, userId, { force: true });
      return res.status(200).json({ configured: true, connections: await getConnections(client, userId) });
    }
    if (action === 'reconnected') {
      const updated = await client.query("UPDATE artflow.bank_balance_links SET attempted_at=NULL,last_error=NULL WHERE user_id=$1 AND item_id=$2 RETURNING item_id", [userId, String(body.item_id || '')]);
      if (!updated.rowCount) return res.status(404).json({ error: 'Bank connection not found.' });
      await refreshBalances(client, userId, { force: true });
      return res.status(200).json({ configured: true, connections: await getConnections(client, userId) });
    }
    if (action === 'disconnect') {
      const itemId = String(body.item_id || '');
      const row = (await client.query("SELECT encrypted_access_token FROM artflow.bank_balance_links WHERE user_id=$1 AND item_id=$2", [userId, itemId])).rows[0];
      if (!row) return res.status(404).json({ error: 'Bank connection not found.' });
      try { await plaid('/item/remove', { access_token: unseal(row.encrypted_access_token) }); }
      catch (error) { if (error.code !== 'INVALID_ACCESS_TOKEN' && error.code !== 'ITEM_NOT_FOUND') throw error; }
      await client.query("DELETE FROM artflow.bank_balance_links WHERE user_id=$1 AND item_id=$2", [userId, itemId]);
      return res.status(200).json({ configured: true, connections: await getConnections(client, userId) });
    }
    return res.status(400).json({ error: 'Unknown bank action.' });
  } catch (error) {
    console.warn('Bank balances request failed', error.code || 'BANK_API_ERROR');
    return res.status(502).json({ error: error.message || 'Bank balance request failed.', code: error.code || 'BANK_API_ERROR' });
  } finally {
    client.release();
  }
}
