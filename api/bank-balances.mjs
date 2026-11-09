import pg from 'pg';
import { auth } from './auth/_auth.mjs';
import { fromNodeHeaders } from 'better-auth/node';
import { pooledDatabaseUrl } from './_db.mjs';

const { Pool } = pg;
const pool = new Pool({
  connectionString: pooledDatabaseUrl(),
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const ACCOUNT_TYPES = new Set(['checking', 'savings', 'other']);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function originAllowed(req) {
  const rawOrigin = String(req.headers.origin || '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  try {
    const origin = new URL(rawOrigin);
    return origin.protocol === 'https:' && origin.host === host;
  } catch {
    return false;
  }
}

function validatedAccount(body = {}) {
  const bankName = String(body.bank_name || '').trim();
  const accountName = String(body.account_name || '').trim();
  const accountType = String(body.account_type || '').toLowerCase();
  const balanceText = String(body.balance ?? '').trim();
  if (bankName.length < 1 || bankName.length > 80) throw new Error('Enter a bank name (up to 80 characters).');
  if (accountName.length < 1 || accountName.length > 80) throw new Error('Enter an account name (up to 80 characters).');
  if (!ACCOUNT_TYPES.has(accountType)) throw new Error('Choose Checking, Savings, or Other.');
  if (!/^-?\d{1,9}(?:\.\d{1,2})?$/.test(balanceText)) throw new Error('Enter a balance with no more than two decimal places.');
  const balance = Number(balanceText);
  if (!Number.isFinite(balance)) throw new Error('Enter a valid balance.');
  return { bankName, accountName, accountType, balance };
}

async function ensureTable(client) {
  await client.query("CREATE TABLE IF NOT EXISTS artflow.manual_bank_balances (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, bank_name text NOT NULL, account_name text NOT NULL, account_type text NOT NULL, balance numeric(14,2) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())");
  await client.query("CREATE INDEX IF NOT EXISTS manual_bank_balances_user_idx ON artflow.manual_bank_balances (user_id, created_at)");
}

async function listAccounts(client, userId) {
  const result = await client.query(
    "SELECT id::text, bank_name, account_name, account_type, balance::numeric, created_at, updated_at FROM artflow.manual_bank_balances WHERE user_id=$1 ORDER BY created_at ASC",
    [userId]
  );
  const accounts = result.rows.map((row) => ({
    id: row.id,
    bank_name: row.bank_name,
    account_name: row.account_name,
    account_type: row.account_type,
    balance: Number(row.balance),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  return { mode: 'manual', accounts };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (!session?.user?.id) return res.status(401).json({ error: 'Sign in to ArtFlow to view balances.' });
  if (req.method === 'POST' && !originAllowed(req)) return res.status(403).json({ error: 'Invalid request origin.' });

  const client = await pool.connect();
  try {
    await ensureTable(client);
    const userId = String(session.user.id);
    if (req.method === 'GET') return res.status(200).json(await listAccounts(client, userId));

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '').toLowerCase();
    if (action === 'create') {
      const account = validatedAccount(body);
      await client.query(
        "INSERT INTO artflow.manual_bank_balances (user_id,bank_name,account_name,account_type,balance) VALUES ($1,$2,$3,$4,$5)",
        [userId, account.bankName, account.accountName, account.accountType, account.balance]
      );
    } else if (action === 'update') {
      const id = String(body.id || '');
      if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid account ID.' });
      const account = validatedAccount(body);
      const changed = await client.query(
        "UPDATE artflow.manual_bank_balances SET bank_name=$3,account_name=$4,account_type=$5,balance=$6,updated_at=now() WHERE user_id=$1 AND id=$2::uuid RETURNING id",
        [userId, id, account.bankName, account.accountName, account.accountType, account.balance]
      );
      if (!changed.rowCount) return res.status(404).json({ error: 'Account not found.' });
    } else if (action === 'delete') {
      const id = String(body.id || '');
      if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid account ID.' });
      const deleted = await client.query(
        "DELETE FROM artflow.manual_bank_balances WHERE user_id=$1 AND id=$2::uuid RETURNING id",
        [userId, id]
      );
      if (!deleted.rowCount) return res.status(404).json({ error: 'Account not found.' });
    } else {
      return res.status(400).json({ error: 'Unknown action.' });
    }
    return res.status(200).json(await listAccounts(client, userId));
  } catch (error) {
    if (error.message?.startsWith('Enter ') || error.message?.startsWith('Choose ')) {
      return res.status(400).json({ error: error.message });
    }
    console.warn('Manual bank balances error:', error.code || 'DATABASE_ERROR');
    return res.status(500).json({ error: 'Could not save balances. Please try again.' });
  } finally {
    client.release();
  }
}
