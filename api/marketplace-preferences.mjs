import pg from 'pg';
import { pooledDatabaseUrl } from './_db.mjs';
import { auth } from './auth/_auth.mjs';
import { fromNodeHeaders } from 'better-auth/node';

const { Pool } = pg;
const pool = new Pool({
  connectionString: pooledDatabaseUrl(),
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const SUPPORTED = ['Vinted', 'Depop', 'eBay', 'Poshmark', 'Facebook Marketplace', 'Mercari'];
const normalize = (value = '') => String(value || '').trim().toLowerCase();

function normalizeLinks(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(SUPPORTED.map((name) => [name, String(source[name] || '').trim()]));
}

async function getSession(req) {
  return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
}

async function getProfile(client, user) {
  const email = normalize(user?.email);
  const result = await client.query(
    `SELECT * FROM artflow.legacy_users
     WHERE auth_user_id=$1 OR lower(email)=$2
     ORDER BY CASE WHEN auth_user_id=$1 THEN 0 ELSE 1 END, created_date NULLS LAST
     LIMIT 1`,
    [user.id, email]
  );
  return result.rows[0] || null;
}

async function ensureProfile(client, user) {
  let profile = await getProfile(client, user);
  if (profile) return profile;
  const id = `neon-user:${user.id}`;
  await client.query(
    `INSERT INTO artflow.legacy_users
      (base44_id,email,full_name,role,active_business_id,disabled,auth_user_id,created_date,updated_date,data)
     VALUES ($1,$2,$3,'user',NULL,false,$4,now(),now(),'{}'::jsonb)
     ON CONFLICT (base44_id) DO NOTHING`,
    [id, user.email || '', user.name || null, user.id]
  );
  profile = await getProfile(client, user);
  if (!profile) throw new Error('Art Flow user profile could not be created');
  return profile;
}

function businessEmails(row) {
  const d = row?.data || {};
  return [
    row?.primary_email,
    d.primary_email,
    ...(Array.isArray(d.member_emails) ? d.member_emails : []),
    ...(Array.isArray(d.sales_emails) ? d.sales_emails : []),
    ...(Array.isArray(d.expense_emails) ? d.expense_emails : []),
  ].map(normalize).filter(Boolean);
}

async function findBusiness(client, profile, user) {
  const active = profile?.active_business_id || profile?.data?.active_business_id || null;
  const email = normalize(user?.email);
  const result = await client.query(`SELECT base44_id, name, primary_email, created_by_id, data FROM artflow.businesses ORDER BY name NULLS LAST`);
  const owns = (row) => Boolean(row && ((email && businessEmails(row).includes(email)) || row.created_by_id === profile?.base44_id || row.created_by_id === user?.id));
  const activeRow = result.rows.find((row) => active && row.base44_id === active && owns(row)) || null;
  const emailRow = result.rows.find((row) => owns(row)) || null;
  return activeRow || emailRow || null;
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSession(req).catch(() => null);
  if (!session?.user) return res.status(401).json({ error: 'Unauthorized' });

  const client = await pool.connect();
  try {
    const profile = await ensureProfile(client, session.user);
    const business = await findBusiness(client, profile, session.user);
    const profileData = profile.data || {};
    const businessData = business?.data || {};
    const inheritedSelection = Array.isArray(businessData.tracked_marketplaces) ? businessData.tracked_marketplaces : [];
    const configured = Array.isArray(profileData.tracked_marketplaces) || inheritedSelection.length > 0;
    const current = (Array.isArray(profileData.tracked_marketplaces) ? profileData.tracked_marketplaces : inheritedSelection)
      .filter((item) => SUPPORTED.includes(item));
    const currentLinks = normalizeLinks({ ...(businessData.marketplace_links || {}), ...(profileData.marketplace_links || {}) });

    if (req.method === 'GET') {
      return res.status(200).json({
        supported: SUPPORTED,
        selected: current,
        links: currentLinks,
        configured,
      });
    }

    const body = parseBody(req);
    const selected = Array.isArray(body?.selected)
      ? SUPPORTED.filter((item) => body.selected.includes(item))
      : current;
    const links = body?.links && typeof body.links === 'object'
      ? normalizeLinks(body.links)
      : currentLinks;
    const nextProfileData = { ...profileData, tracked_marketplaces: selected, marketplace_links: links };
    await client.query(
      `UPDATE artflow.legacy_users SET data=$2::jsonb,updated_date=now() WHERE base44_id=$1`,
      [profile.base44_id, JSON.stringify(nextProfileData)]
    );

    // Keep an existing business workspace in sync for older accounting features,
    // but never create a business just to save marketplace preferences.
    if (business) {
      const nextBusinessData = { ...businessData, tracked_marketplaces: selected, marketplace_links: links };
      await client.query(
        `UPDATE artflow.businesses SET data=$2::jsonb WHERE base44_id=$1`,
        [business.base44_id, JSON.stringify(nextBusinessData)]
      );
    }

    return res.status(200).json({ ok: true, supported: SUPPORTED, selected, links, configured: true });
  } catch (error) {
    console.error('marketplace preferences error', error?.message || error);
    return res.status(500).json({ error: 'Could not save marketplace preferences' });
  } finally {
    client.release();
  }
}
