import pg from 'pg';
import { auth } from './auth/_auth.mjs';
import { fromNodeHeaders } from 'better-auth/node';
import { pooledDatabaseUrl } from './_db.mjs';

const pool = new pg.Pool({
  connectionString: pooledDatabaseUrl(),
  ssl: { rejectUnauthorized: false },
  max: 1,
});

function isMonth(value) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(value || ''));
  return Boolean(m && Number(m[1]) >= 2020 && Number(m[1]) <= 2100);
}
function previousMonth(key) {
  const [year, month] = key.split('-').map(Number);
  return month === 1 ? String(year - 1) + '-12' : String(year) + '-' + String(month - 1).padStart(2, '0');
}
function amount(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(text)) throw new Error('Enter a valid ' + label + ' (0 or more, up to two decimals).');
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error('Enter a valid ' + label + '.');
  return n;
}
function categoryName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 80) throw new Error('Category name must be 1 to 80 characters.');
  return name;
}
function originAllowed(req) {
  const raw = String(req.headers.origin || '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  try {
    const origin = new URL(raw);
    return origin.protocol === 'https:' && origin.host === host;
  } catch { return false; }
}
async function ensureTables(client) {
  await client.query("CREATE TABLE IF NOT EXISTS artflow.monthly_budget_plans (user_id text NOT NULL, month_key text NOT NULL, income_target numeric(12,2) NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,month_key))");
  await client.query("CREATE TABLE IF NOT EXISTS artflow.monthly_budget_categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, month_key text NOT NULL, category text NOT NULL, planned numeric(12,2) NOT NULL DEFAULT 0, manual_spent numeric(12,2) NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())");
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS monthly_budget_categories_unique ON artflow.monthly_budget_categories (user_id,month_key,lower(category))");
}
async function snapshot(client, userId, month) {
  const [plan, rows, bank] = await Promise.all([
    client.query("SELECT income_target::text, updated_at FROM artflow.monthly_budget_plans WHERE user_id=$1 AND month_key=$2", [userId, month]),
    client.query("SELECT id::text,category,planned::text,manual_spent::text,created_at,updated_at FROM artflow.monthly_budget_categories WHERE user_id=$1 AND month_key=$2 ORDER BY created_at ASC, category ASC", [userId, month]),
    client.query("SELECT coalesce(sum(balance),0)::text AS total, count(*)::int AS account_count FROM artflow.manual_bank_balances WHERE user_id=$1", [userId]).catch((e) => {
      if (e.code === '42P01') return {rows:[{ total:'0', account_count:0 }]};
      throw e;
    }),
  ]);
  return {
    month,
    income_target: Number(plan.rows[0]?.income_target || 0),
    categories: rows.rows.map((r) => ({
      ...r, planned: Number(r.planned), manual_spent: Number(r.manual_spent),
    })),
    bank_balance: Number(bank.rows[0]?.total || 0),
    bank_account_count: Number(bank.rows[0]?.account_count || 0),
    bank_balance_note: 'Manually entered bank balances; not automatically adjusted by the budget.',
  };
}
function jsonBody(req) {
  return req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (!session?.user?.id) return res.status(401).json({error:'Sign in to ArtFlow to use your budget.'});
  if (req.method === 'POST' && !originAllowed(req)) return res.status(403).json({error:'Invalid request origin.'});
  const body = jsonBody(req);
  const month = String(req.method === 'GET' ? req.query?.month || '' : body.month || '');
  if (!isMonth(month)) return res.status(400).json({error:'Choose a valid budget month.'});
  const client = await pool.connect();
  try {
    await ensureTables(client);
    const userId = String(session.user.id);
    if (req.method === 'GET') return res.status(200).json(await snapshot(client,userId,month));
    const action = String(body.action || '').toLowerCase();
    if (action === 'set_income') {
      const target = amount(body.income_target,'income target');
      await client.query("INSERT INTO artflow.monthly_budget_plans (user_id,month_key,income_target) VALUES ($1,$2,$3) ON CONFLICT (user_id,month_key) DO UPDATE SET income_target=excluded.income_target,updated_at=now()", [userId,month,target]);
    } else if (action === 'save_category') {
      const name = categoryName(body.category);
      const planned = amount(body.planned,'planned budget');
      const manualSpent = amount(body.manual_spent,'additional spending');
      const id = String(body.id || '');
      if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({error:'Invalid budget item.'});
      }
      if (id) {
        const changed = await client.query("UPDATE artflow.monthly_budget_categories SET category=$4,planned=$5,manual_spent=$6,updated_at=now() WHERE user_id=$1 AND month_key=$2 AND id=$3::uuid RETURNING id", [userId,month,id,name,planned,manualSpent]);
        if (!changed.rowCount) return res.status(404).json({error:'Budget category not found.'});
      } else {
        await client.query("INSERT INTO artflow.monthly_budget_categories (user_id,month_key,category,planned,manual_spent) VALUES ($1,$2,$3,$4,$5)", [userId,month,name,planned,manualSpent]);
      }
    } else if (action === 'delete_category') {
      const id = String(body.id || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return res.status(400).json({error:'Invalid budget item.'});
      const result = await client.query("DELETE FROM artflow.monthly_budget_categories WHERE user_id=$1 AND month_key=$2 AND id=$3::uuid RETURNING id", [userId,month,id]);
      if (!result.rowCount) return res.status(404).json({error:'Budget category not found.'});
    } else if (action === 'copy_previous') {
      const previous = previousMonth(month);
      if (!isMonth(previous)) return res.status(400).json({error:'Previous month unavailable.'});
      await client.query("INSERT INTO artflow.monthly_budget_plans (user_id,month_key,income_target) SELECT user_id,$2,income_target FROM artflow.monthly_budget_plans WHERE user_id=$1 AND month_key=$3 ON CONFLICT (user_id,month_key) DO NOTHING", [userId,month,previous]);
      await client.query("INSERT INTO artflow.monthly_budget_categories (user_id,month_key,category,planned,manual_spent) SELECT user_id,$2,category,planned,0 FROM artflow.monthly_budget_categories WHERE user_id=$1 AND month_key=$3 ON CONFLICT DO NOTHING", [userId,month,previous]);
    } else {
      return res.status(400).json({error:'Unknown budget action.'});
    }
    return res.status(200).json(await snapshot(client,userId,month));
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({error:'This category already exists for the selected month.'});
    if (error.message?.startsWith('Enter ') || error.message?.startsWith('Category ')) return res.status(400).json({error:error.message});
    console.warn('ArtFlow budget request failed',error.code || 'DATABASE_ERROR');
    return res.status(500).json({error:'Could not load or save the budget. Please try again.'});
  } finally { client.release(); }
}
