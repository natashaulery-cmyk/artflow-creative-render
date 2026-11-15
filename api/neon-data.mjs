import pg from 'pg';
import crypto from 'node:crypto';
import { auth } from './auth/_auth.mjs';
import { fromNodeHeaders } from 'better-auth/node';
import { pooledDatabaseUrl } from './_db.mjs';

const { Pool } = pg;
const pool = new Pool({
  connectionString: pooledDatabaseUrl(),
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const normalize = (v = '') => String(v || '').trim().toLowerCase();

async function runSequential(tasks) {
  const results = [];
  for (const task of tasks) results.push(await task());
  return results;
}

async function getSession(req) {
  return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
}

async function getLegacyProfile(client, user) {
  const email = normalize(user?.email);
  if (!email) return null;
  const found = await client.query(
    `SELECT * FROM artflow.legacy_users
     WHERE auth_user_id = $1 OR lower(email) = $2
     ORDER BY CASE WHEN auth_user_id = $1 THEN 0 ELSE 1 END, created_date NULLS LAST
     LIMIT 1`,
    [user.id, email]
  );
  let row = found.rows[0] || null;
  if (row && !row.auth_user_id) {
    await client.query(`UPDATE artflow.legacy_users SET auth_user_id=$2 WHERE base44_id=$1`, [row.base44_id, user.id]);
    row.auth_user_id = user.id;
  }

  // A previous auth migration can leave more than one legacy profile for the
  // same email. If the canonical profile already knows the real workspace,
  // inherit that link onto any duplicate instead of letting a later login
  // fall back to a new/empty workspace.
  if (row?.active_business_id) {
    await client.query(
      `UPDATE artflow.legacy_users
          SET active_business_id=$3, updated_date=now()
        WHERE lower(email)=$2
          AND (auth_user_id=$1 OR auth_user_id IS NULL)
          AND active_business_id IS NULL`,
      [user.id, email, row.active_business_id]
    );
  }
  return row;
}

function businessEmails(row) {
  const d = row?.data || {};
  return [
    row?.primary_email,
    d.primary_email,
    ...(d.member_emails || []),
    ...(d.sales_emails || []),
    ...(d.expense_emails || []),
  ].map(normalize).filter(Boolean);
}

function businessMatchesEmail(row, email) {
  return Boolean(email && businessEmails(row).includes(normalize(email)));
}

async function getAccessibleBusinesses(client, profile, user) {
  const email = normalize(user?.email);
  const active = profile?.active_business_id || profile?.data?.active_business_id || null;
  const result = await client.query(`
    SELECT b.base44_id, b.name, b.primary_email, b.created_by_id, b.data,
           (
             (SELECT count(*) FROM artflow.orders o WHERE o.business_id = b.base44_id AND o.archived IS NOT TRUE) +
             (SELECT count(*) FROM artflow.marketplace_listings m WHERE m.business_id = b.base44_id) +
             (SELECT count(*) FROM artflow.expenses e WHERE e.business_id = b.base44_id AND e.archived IS NOT TRUE)
           )::int AS activity_score
      FROM artflow.businesses b
     ORDER BY activity_score DESC, b.name NULLS LAST
  `);
  return result.rows.filter((row) => {
    const owns = businessMatchesEmail(row, email)
      || row.created_by_id === profile?.base44_id
      || row.created_by_id === user?.id;
    if (!owns) return false;
    if (active && row.base44_id === active) return true;
    return owns;
  });
}

function businessIds(businesses) {
  return Array.from(new Set((businesses || []).map((b) => b.base44_id).filter(Boolean)));
}

async function ensureWorkspace(client, user) {
  let profile = await getLegacyProfile(client, user);
  const email = normalize(user?.email);

  if (!profile) {
    const profileId = `neon-user:${user.id}`;
    await client.query(
      `INSERT INTO artflow.legacy_users
       (base44_id,email,full_name,role,active_business_id,disabled,auth_user_id,created_date,updated_date,data)
       VALUES ($1,$2,$3,'user',NULL,false,$4,now(),now(),'{}'::jsonb)
       ON CONFLICT (base44_id) DO NOTHING`,
      [profileId, user.email, user.name || null, user.id]
    );
    profile = await getLegacyProfile(client, user);
  }

  let businesses = await getAccessibleBusinesses(client, profile, user);
  if (!businesses.length) {
    const businessId = `business:${crypto.randomUUID()}`;
    const data = {
      member_emails: email ? [email] : [],
      sales_emails: email ? [email] : [],
      expense_emails: email ? [email] : [],
      tracked_marketplaces: [],
    };
    await client.query(
      `INSERT INTO artflow.businesses
       (base44_id,name,primary_email,created_by_id,created_date,updated_date,data)
       VALUES ($1,$2,$3,$4,now(),now(),$5::jsonb)`,
      [businessId, user.name ? `${user.name}'s Art Business` : 'My Art Business', user.email, profile?.base44_id || user.id, JSON.stringify(data)]
    );
    if (profile?.base44_id) {
      await client.query(
        `UPDATE artflow.legacy_users SET active_business_id=$2, updated_date=now() WHERE base44_id=$1`,
        [profile.base44_id, businessId]
      );
      profile.active_business_id = businessId;
    }
    businesses = await getAccessibleBusinesses(client, profile, user);
  }

  const ids = businessIds(businesses);
  // Prefer a workspace that explicitly belongs to the signed-in email. This
  // prevents old placeholder "My Business" rows from becoming active merely
  // because they were created during an earlier auth/setup attempt.
  const canonicalBusiness = businesses.find((business) => businessMatchesEmail(business, email)) || null;
  const preferredBusinessId = canonicalBusiness?.base44_id || ids[0] || null;
  if (preferredBusinessId && profile?.base44_id && profile.active_business_id !== preferredBusinessId) {
    await client.query(
      `UPDATE artflow.legacy_users SET active_business_id=$2, updated_date=now() WHERE base44_id=$1`,
      [profile.base44_id, preferredBusinessId]
    );
    profile.active_business_id = preferredBusinessId;
  }

  // Keep every legacy profile for this email pinned to the same canonical
  // workspace. This prevents a duplicate auth-migration row from selecting an
  // older empty workspace on a later login.
  if (preferredBusinessId && email) {
    await client.query(
      `UPDATE artflow.legacy_users
          SET active_business_id=$2, updated_date=now()
        WHERE lower(email)=$1
          AND active_business_id IS DISTINCT FROM $2`,
      [email, preferredBusinessId]
    );
  }
  return { profile, businesses, ids, email };
}

async function ensureUserProfileOnly(client, user) {
  let profile = await getLegacyProfile(client, user);
  if (!profile) {
    const profileId = `neon-user:${user.id}`;
    await client.query(
      `INSERT INTO artflow.legacy_users
       (base44_id,email,full_name,role,active_business_id,disabled,auth_user_id,created_date,updated_date,data)
       VALUES ($1,$2,$3,'user',NULL,false,$4,now(),now(),'{}'::jsonb)
       ON CONFLICT (base44_id) DO NOTHING`,
      [profileId, user.email || '', user.name || null, user.id]
    );
    profile = await getLegacyProfile(client, user);
  }
  return profile;
}

async function existingWorkspace(client, user) {
  const profile = await ensureUserProfileOnly(client, user);
  const email = normalize(user?.email);
  const businesses = await getAccessibleBusinesses(client, profile, user);
  return { profile, businesses, ids: businessIds(businesses), email };
}

async function countBusinessRows(client, table, ids, email, archivedColumn = false, currentYearColumn = '') {
  const params = [ids, email];
  const archived = archivedColumn ? `AND archived IS NOT TRUE` : '';
  const currentYear = currentYearColumn === 'sale_date'
    ? `AND left(COALESCE(sale_date,''),4)=to_char(CURRENT_DATE,'YYYY')`
    : '';
  const result = await client.query(
    `SELECT count(*)::int AS count
       FROM artflow.${table}
      WHERE (
        business_id = ANY($1::text[])
        OR EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(data->'access_emails')='array' THEN data->'access_emails' ELSE '[]'::jsonb END) e(value)
           WHERE lower(e.value) = $2
        )
      ) ${archived} ${currentYear}`,
    [ids, normalize(email)]
  );
  return result.rows[0]?.count || 0;
}

async function listOrders(client, session) {
  const { ids, email } = await existingWorkspace(client, session.user);
  const listingScopes = Array.from(new Set([`user:${session.user.id}`, ...ids]));
  const result = await client.query(
    `WITH scoped_orders AS (
       SELECT o.*,
         regexp_replace(COALESCE(o.sale_date,''),'T.*$','') AS dedupe_day,
         round(COALESCE(o.sale_total,0)::numeric,2) AS dedupe_total,
         COALESCE(o.quantity,1) AS dedupe_qty,
         lower(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 COALESCE(o.product_name,''),
                 '^\\s*[0-9]+(?:\\.[0-9]+)?\\s*x\\s*[0-9]+(?:\\.[0-9]+)?\\s*[-–—|:]?\\s*',
                 '',
                 'i'
               ),
               '\\m(of|the|a|an)\\M',
               '',
               'gi'
             ),
             '[^a-z0-9]+',
             '',
             'g'
           )
         ) AS dedupe_title
       FROM artflow.orders o
       WHERE o.archived IS NOT TRUE
         AND left(COALESCE(o.sale_date,''),4)=to_char(CURRENT_DATE,'YYYY')
         AND NOT (
           lower(COALESCE(o.platform,''))='ebay'
           AND COALESCE(o.sync_source,'')='yahoo_direct_sales'
           AND (
             COALESCE(o.product_name,'') ~ '^\\s*&(?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z]+);\\s*$'
             OR length(regexp_replace(COALESCE(o.product_name,''),'[^A-Za-z0-9]','','g')) < 3
           )
         )
         AND (
           o.business_id = ANY($1::text[])
           OR EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(o.data->'access_emails')='array' THEN o.data->'access_emails' ELSE '[]'::jsonb END) e(value)
              WHERE lower(e.value) = $2
           )
         )
     ),
     visible_orders AS (
       SELECT s.*
       FROM scoped_orders s
       WHERE NOT (
         s.sync_source LIKE 'google_sheet%'
         AND EXISTS (
           SELECT 1
           FROM scoped_orders g
           WHERE g.sync_source LIKE 'gmail_direct_sales%'
             AND lower(g.platform)=lower(s.platform)
             AND g.dedupe_day=s.dedupe_day
             AND g.dedupe_total=s.dedupe_total
             AND g.dedupe_qty=s.dedupe_qty
             AND s.dedupe_title<>''
             AND g.dedupe_title<>''
             AND (
               g.dedupe_title=s.dedupe_title
               OR (length(s.dedupe_title)>=12 AND g.dedupe_title LIKE '%'||s.dedupe_title||'%')
               OR (length(g.dedupe_title)>=12 AND s.dedupe_title LIKE '%'||g.dedupe_title||'%')
             )
         )
       )
     ),
     deduped_orders AS (
       SELECT *
       FROM (
         SELECT v.*,
           row_number() OVER (
             PARTITION BY
               lower(COALESCE(v.platform,'')),
               CASE
                 WHEN NULLIF(trim(v.order_id),'') IS NOT NULL
                      AND NOT (
                        lower(COALESCE(v.platform,''))='ebay'
                        AND lower(trim(v.order_id)) LIKE 'yahoo-ebay-%'
                      )
                   THEN 'order:' || lower(trim(v.order_id))
                 WHEN NULLIF(trim(v.source_email_id),'') IS NOT NULL
                   THEN 'email:' || lower(trim(v.source_email_id))
                 WHEN lower(COALESCE(v.platform,''))='ebay'
                   THEN 'fallback:' || COALESCE(v.dedupe_day,'') || '|' || COALESCE(v.dedupe_title,'') || '|' || COALESCE(v.dedupe_qty,1)::text
                 ELSE 'fallback:' || COALESCE(v.dedupe_day,'') || '|' || COALESCE(v.dedupe_title,'') || '|' || COALESCE(v.dedupe_qty,1)::text || '|' || COALESCE(v.dedupe_total,0)::text
               END
             ORDER BY
               CASE WHEN COALESCE(v.sale_total,0) > 0 THEN 0 ELSE 1 END,
               CASE
                 WHEN v.sync_source LIKE 'gmail_direct_sales%' THEN 0
                 WHEN v.sync_source LIKE '%official%' THEN 1
                 ELSE 2
               END,
               v.updated_date DESC NULLS LAST,
               v.created_date DESC NULLS LAST
           ) AS duplicate_rank
         FROM visible_orders v
       ) ranked
       WHERE duplicate_rank = 1
     )
     SELECT
       base44_id AS id,
       base44_id,
       created_by_id,
       created_date,
       updated_date,
       sale_date,
       platform,
       order_id,
       product_name,
       quantity,
       size,
       unit_price,
       sale_total,
       buyer,
       source_email_id,
       data->>'source_url' AS source_url,
       COALESCE(
         NULLIF(data->>'image_url',''),
         NULLIF(data->>'product_image_url',''),
         NULLIF(data->>'marketplace_image_url',''),
         NULLIF(data->>'thumbnail_url',''),
         NULLIF(data->>'photo_url',''),
         CASE
           WHEN lower(COALESCE(platform,'')) IN ('ebay','depop') THEN (
             SELECT COALESCE(
               NULLIF(img.data->>'image_url',''),
               NULLIF(img.data->>'product_image_url',''),
               NULLIF(img.data->>'marketplace_image_url',''),
               NULLIF(img.data->>'thumbnail_url',''),
               NULLIF(img.data->>'photo_url','')
             )
             FROM scoped_orders img
             WHERE lower(COALESCE(img.platform,''))=lower(COALESCE(deduped_orders.platform,''))
               AND img.dedupe_day=deduped_orders.dedupe_day
               AND img.dedupe_qty=deduped_orders.dedupe_qty
               AND img.dedupe_title<>''
               AND deduped_orders.dedupe_title<>''
               AND (
                 img.dedupe_title=deduped_orders.dedupe_title
                 OR (
                   length(deduped_orders.dedupe_title)>=12
                   AND img.dedupe_title LIKE '%'||deduped_orders.dedupe_title||'%'
                 )
                 OR (
                   length(img.dedupe_title)>=12
                   AND deduped_orders.dedupe_title LIKE '%'||img.dedupe_title||'%'
                 )
               )
               AND COALESCE(
                 NULLIF(img.data->>'image_url',''),
                 NULLIF(img.data->>'product_image_url',''),
                 NULLIF(img.data->>'marketplace_image_url',''),
                 NULLIF(img.data->>'thumbnail_url',''),
                 NULLIF(img.data->>'photo_url','')
               ) IS NOT NULL
             ORDER BY img.updated_date DESC NULLS LAST, img.created_date DESC NULLS LAST
             LIMIT 1
           )
         END,
         CASE
           WHEN lower(COALESCE(platform,'')) IN ('ebay','depop') THEN (
             SELECT NULLIF(ml.image_url,'')
             FROM artflow.marketplace_listings ml
             WHERE ml.business_id = ANY($3::text[])
               AND lower(COALESCE(ml.platform,''))=lower(COALESCE(deduped_orders.platform,''))
               AND COALESCE(ml.image_url,'')<>''
               AND deduped_orders.dedupe_title<>''
               AND (
                 lower(
                   regexp_replace(
                     regexp_replace(
                       regexp_replace(
                         COALESCE(ml.title,''),
                         '^\\s*[0-9]+(?:\\.[0-9]+)?\\s*x\\s*[0-9]+(?:\\.[0-9]+)?\\s*[-–—|:]?\\s*',
                         '',
                         'i'
                       ),
                       '\\m(of|the|a|an)\\M',
                       '',
                       'gi'
                     ),
                     '[^a-z0-9]+',
                     '',
                     'g'
                   )
                 ) = deduped_orders.dedupe_title
                 OR (
                   length(deduped_orders.dedupe_title)>=12
                   AND lower(
                   regexp_replace(
                     regexp_replace(
                       regexp_replace(
                         COALESCE(ml.title,''),
                         '^\\s*[0-9]+(?:\\.[0-9]+)?\\s*x\\s*[0-9]+(?:\\.[0-9]+)?\\s*[-–—|:]?\\s*',
                         '',
                         'i'
                       ),
                       '\\m(of|the|a|an)\\M',
                       '',
                       'gi'
                     ),
                     '[^a-z0-9]+',
                     '',
                     'g'
                   )
                 )
                       LIKE '%'||deduped_orders.dedupe_title||'%'
                 )
                 OR (
                   length(lower(
                   regexp_replace(
                     regexp_replace(
                       regexp_replace(
                         COALESCE(ml.title,''),
                         '^\\s*[0-9]+(?:\\.[0-9]+)?\\s*x\\s*[0-9]+(?:\\.[0-9]+)?\\s*[-–—|:]?\\s*',
                         '',
                         'i'
                       ),
                       '\\m(of|the|a|an)\\M',
                       '',
                       'gi'
                     ),
                     '[^a-z0-9]+',
                     '',
                     'g'
                   )
                 ))>=12
                   AND deduped_orders.dedupe_title
                       LIKE '%'||lower(
                   regexp_replace(
                     regexp_replace(
                       regexp_replace(
                         COALESCE(ml.title,''),
                         '^\\s*[0-9]+(?:\\.[0-9]+)?\\s*x\\s*[0-9]+(?:\\.[0-9]+)?\\s*[-–—|:]?\\s*',
                         '',
                         'i'
                       ),
                       '\\m(of|the|a|an)\\M',
                       '',
                       'gi'
                     ),
                     '[^a-z0-9]+',
                     '',
                     'g'
                   )
                 )||'%'
                 )
               )
             ORDER BY
               CASE
                 WHEN lower(
                   regexp_replace(
                     regexp_replace(
                       regexp_replace(
                         COALESCE(ml.title,''),
                         '^\\s*[0-9]+(?:\\.[0-9]+)?\\s*x\\s*[0-9]+(?:\\.[0-9]+)?\\s*[-–—|:]?\\s*',
                         '',
                         'i'
                       ),
                       '\\m(of|the|a|an)\\M',
                       '',
                       'gi'
                     ),
                     '[^a-z0-9]+',
                     '',
                     'g'
                   )
                 ) = deduped_orders.dedupe_title THEN 0
                 ELSE 1
               END,
               CASE WHEN ml.status='Active' THEN 0 ELSE 1 END,
               ml.last_seen_at DESC NULLS LAST
             LIMIT 1
           )
         END
       ) AS image_url,
       base_item_cost,
       paper_ink_cost,
       packaging_cost,
       total_cost,
       estimated_profit,
       archived,
       sync_source,
       business_id,
       (COALESCE(data->>'shipped','false') = 'true') AS shipped,
       NULLIF(data->>'shipped_at','') AS shipped_at,
       CASE
         WHEN lower(COALESCE(platform,''))='poshmark'
           THEN jsonb_strip_nulls(jsonb_build_object('poshmark_earnings', data->>'poshmark_earnings'))
         ELSE '{}'::jsonb
       END AS data
     FROM deduped_orders
     ORDER BY sale_date DESC NULLS LAST, created_date DESC NULLS LAST
     LIMIT 10000`,
    [ids, email, listingScopes]
  );
  return result.rows;
}

async function listExpenses(client, session) {
  const { ids, email } = await ensureWorkspace(client, session.user);
  const result = await client.query(
    `SELECT
       e.base44_id AS id,
       e.base44_id,
       e.created_by_id,
       e.created_date,
       e.updated_date,
       e.expense_date AS date,
       e.category,
       COALESCE(e.data->>'description', '') AS description,
       e.amount,
       NULLIF(e.data->>'deductible_percent', '')::numeric AS deductible_percent,
       NULLIF(e.data->>'deductible_amount', '')::numeric AS deductible_amount,
       e.source,
       COALESCE(e.data->>'status','approved') AS status,
       e.receipt_id,
       e.data->>'notes' AS notes,
       e.archived,
       COALESCE(e.data->>'sync_source', e.data->>'source') AS sync_source,
       e.business_id,
       jsonb_strip_nulls(jsonb_build_object(
         'recurring', e.data->>'recurring',
         'recurring_series_id', e.data->>'recurring_series_id'
       )) AS data
     FROM artflow.expenses e
     WHERE e.archived IS NOT TRUE
       AND (
         e.business_id = ANY($1::text[])
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.data->'access_emails')='array' THEN e.data->'access_emails' ELSE '[]'::jsonb END) access(value)
            WHERE lower(access.value) = $2
         )
       )
     ORDER BY e.expense_date DESC NULLS LAST, e.created_date DESC NULLS LAST
     LIMIT 10000`,
    [ids, email]
  );
  return result.rows;
}

async function listInventory(client, session) {
  const { ids } = await ensureWorkspace(client, session.user);
  const result = await client.query(
    `SELECT
       base44_id AS id,
       base44_id,
       business_id,
       name,
       category,
       size,
       base_item_cost,
       paper_ink_cost,
       packaging_cost,
       total_unit_cost,
       quantity_on_hand,
       low_stock_level,
       created_by_id,
       created_date,
       updated_date,
       data->>'image_url' AS image_url
     FROM artflow.inventory_costs
     WHERE business_id = ANY($1::text[])
     ORDER BY created_date DESC NULLS LAST, name NULLS LAST`,
    [ids]
  );
  return result.rows;
}

function requestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch {}
  }
  return {};
}

async function writeInventory(client, session, req) {
  const profile = await getLegacyProfile(client, session.user);
  const businesses = await getAccessibleBusinesses(client, profile, session.user);
  const ids = businessIds(businesses);
  if (!ids.length) throw new Error('Business workspace not found');

  const body = requestBody(req);
  const action = String(body.action || '').toLowerCase();
  const numericFields = new Set(['base_item_cost','paper_ink_cost','packaging_cost','total_unit_cost','quantity_on_hand','low_stock_level']);
  const textFields = new Set(['name','category','size']);

  if (action === 'create') {
    const active = profile?.active_business_id || profile?.data?.active_business_id || null;
    const businessId = ids.includes(body.business_id) ? body.business_id : (ids.includes(active) ? active : ids[0]);
    const id = String(body.id || crypto.randomUUID());
    const data = {
      ...(body.data && typeof body.data === 'object' ? body.data : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'image_url') ? { image_url: body.image_url || null } : {}),
    };
    const values = {
      name: String(body.name || '').trim() || null,
      category: String(body.category || 'Supply').trim() || 'Supply',
      size: body.size == null ? null : String(body.size).trim() || null,
      base_item_cost: Number(body.base_item_cost) || 0,
      paper_ink_cost: Number(body.paper_ink_cost) || 0,
      packaging_cost: Number(body.packaging_cost) || 0,
      total_unit_cost: Number(body.total_unit_cost ?? body.base_item_cost) || 0,
      quantity_on_hand: Number(body.quantity_on_hand) || 0,
      low_stock_level: Number(body.low_stock_level) || 0,
    };
    const inserted = await client.query(
      `INSERT INTO artflow.inventory_costs
       (base44_id,business_id,name,category,size,base_item_cost,paper_ink_cost,packaging_cost,total_unit_cost,quantity_on_hand,low_stock_level,created_by_id,created_date,updated_date,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now(),$13::jsonb)
       RETURNING base44_id AS id, *`,
      [id,businessId,values.name,values.category,values.size,values.base_item_cost,values.paper_ink_cost,values.packaging_cost,values.total_unit_cost,values.quantity_on_hand,values.low_stock_level,session.user.id,JSON.stringify(data)]
    );
    return inserted.rows[0];
  }

  if (action === 'delete') {
    const id = String(body.id || '').trim();
    if (!id) throw new Error('Inventory item id is required');
    const deleted = await client.query(
      `DELETE FROM artflow.inventory_costs
        WHERE base44_id=$1 AND business_id = ANY($2::text[])
        RETURNING base44_id`,
      [id, ids]
    );
    if (!deleted.rows[0]) throw new Error('Inventory item not found');
    return { id: deleted.rows[0].base44_id, deleted: true };
  }

  if (action === 'update') {
    const id = String(body.id || '').trim();
    if (!id) throw new Error('Inventory item id is required');
    const fields = [];
    const params = [id, ids];
    let p = 3;
    for (const [key, value] of Object.entries(body)) {
      if (textFields.has(key)) {
        fields.push(`${key}=$${p++}`);
        params.push(value == null ? null : String(value).trim() || null);
      } else if (numericFields.has(key)) {
        fields.push(`${key}=$${p++}`);
        params.push(Number(value) || 0);
      } else if (key === 'data' && value && typeof value === 'object') {
        fields.push(`data=COALESCE(data,'{}'::jsonb)||$${p++}::jsonb`);
        params.push(JSON.stringify(value));
      } else if (key === 'image_url') {
        fields.push(`data=COALESCE(data,'{}'::jsonb)||$${p++}::jsonb`);
        params.push(JSON.stringify({ image_url: value || null }));
      }
    }
    if (!fields.length) throw new Error('No inventory fields to update');
    const updated = await client.query(
      `UPDATE artflow.inventory_costs
          SET ${fields.join(', ')}, updated_date=now()
        WHERE base44_id=$1 AND business_id = ANY($2::text[])
        RETURNING base44_id AS id, *`,
      params
    );
    if (!updated.rows[0]) throw new Error('Inventory item not found');
    return updated.rows[0];
  }

  throw new Error('Unknown inventory action');
}

async function listMarketplaceListings(client, session) {
  const { businesses } = await existingWorkspace(client, session.user);
  const scopes = Array.from(new Set([`user:${session.user.id}`, ...businessIds(businesses)]));
  await client.query(`CREATE TABLE IF NOT EXISTS artflow.marketplace_listings (
    id text PRIMARY KEY,
    business_id text NOT NULL,
    platform text NOT NULL,
    listing_id text,
    title text NOT NULL,
    price numeric DEFAULT 0,
    currency text DEFAULT 'USD',
    image_url text,
    listing_url text NOT NULL,
    status text DEFAULT 'Active',
    last_seen_at timestamptz DEFAULT now(),
    sync_source text,
    data jsonb DEFAULT '{}'::jsonb
  )`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS marketplace_listings_business_platform_url_idx ON artflow.marketplace_listings (business_id, platform, listing_url)`);
  const result = await client.query(
    `SELECT DISTINCT ON (
         platform,
         CASE
           WHEN platform='Vinted' THEN COALESCE(NULLIF(listing_id,''), substring(listing_url from '/items/([0-9]+)'), listing_url)
           ELSE COALESCE(NULLIF(listing_id,''), listing_url)
         END
       )
       id,business_id,platform,listing_id,title,price,currency,image_url,listing_url,status,last_seen_at,sync_source,data
       FROM artflow.marketplace_listings
      WHERE business_id = ANY($1::text[]) AND status IN ('Active','Sold','Inactive')
      ORDER BY
        platform,
        CASE
          WHEN platform='Vinted' THEN COALESCE(NULLIF(listing_id,''), substring(listing_url from '/items/([0-9]+)'), listing_url)
          ELSE COALESCE(NULLIF(listing_id,''), listing_url)
        END,
        last_seen_at DESC NULLS LAST`,
    [scopes]
  );
  return result.rows;
}

function userCreatorIds(profile, user) {
  return Array.from(new Set([profile?.base44_id, user?.id].filter(Boolean)));
}

function selectedBusinessId(profile, ids, requested) {
  if (requested && ids.includes(requested)) return requested;
  if (profile?.active_business_id && ids.includes(profile.active_business_id)) return profile.active_business_id;
  return ids[0] || null;
}

async function listArtPieces(client, session) {
  const { profile, email } = await existingWorkspace(client, session.user);
  const creators = userCreatorIds(profile, session.user);
  const result = await client.query(
    `SELECT base44_id AS id,title,medium,size,price,status,sale_price,sale_date,buyer,platform,created_by_id,created_date,updated_date,data
       FROM artflow.art_pieces
      WHERE created_by_id = ANY($1::text[])
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(data->'access_emails')='array' THEN data->'access_emails' ELSE '[]'::jsonb END) e(value) WHERE lower(e.value)=$2)
      ORDER BY created_date DESC NULLS LAST`,
    [creators, email]
  );
  return result.rows.map((row) => ({ ...row, ...(row.data || {}), id: row.id }));
}

async function writeArtPiece(client, session, req) {
  const { profile, email } = await ensureWorkspace(client, session.user);
  const creators = userCreatorIds(profile, session.user);
  const body = requestBody(req);
  const action = String(body.action || '').toLowerCase();
  if (action === 'delete') {
    const deleted = await client.query(
      `DELETE FROM artflow.art_pieces WHERE base44_id=$1 AND (created_by_id = ANY($2::text[]) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(data->'access_emails')='array' THEN data->'access_emails' ELSE '[]'::jsonb END) e(value) WHERE lower(e.value)=$3)) RETURNING base44_id`,
      [String(body.id || ''), creators, email]
    );
    if (!deleted.rows[0]) throw new Error('Artwork not found');
    return { id: deleted.rows[0].base44_id, deleted: true };
  }
  const id = String(body.id || crypto.randomUUID());
  const data = {
    ...(body.data && typeof body.data === 'object' ? body.data : {}),
    image_url: body.image_url || null,
    notes: body.notes || null,
    access_emails: Array.isArray(body.access_emails) ? body.access_emails : (email ? [email] : []),
  };
  const values = [body.title || null, body.medium || null, body.size || null, Number(body.price) || 0, body.status || 'Available', body.sale_price == null ? null : Number(body.sale_price) || 0, body.sale_date || null, body.buyer || null, body.platform || null, JSON.stringify(data)];
  if (action === 'update') {
    const updated = await client.query(
      `UPDATE artflow.art_pieces SET title=$3,medium=$4,size=$5,price=$6,status=$7,sale_price=$8,sale_date=$9,buyer=$10,platform=$11,data=COALESCE(data,'{}'::jsonb)||$12::jsonb,updated_date=now() WHERE base44_id=$1 AND created_by_id = ANY($2::text[]) RETURNING base44_id AS id,*`,
      [id, creators, ...values]
    );
    if (!updated.rows[0]) throw new Error('Artwork not found');
    return { ...updated.rows[0], ...(updated.rows[0].data || {}) };
  }
  const inserted = await client.query(
    `INSERT INTO artflow.art_pieces (base44_id,title,medium,size,price,status,sale_price,sale_date,buyer,platform,created_by_id,created_date,updated_date,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now(),$12::jsonb) RETURNING base44_id AS id,*`,
    [id, ...values.slice(0,9), profile?.base44_id || session.user.id, values[9]]
  );
  return { ...inserted.rows[0], ...(inserted.rows[0].data || {}) };
}

async function listMileage(client, session) {
  const { profile, email } = await ensureWorkspace(client, session.user);
  const creators = userCreatorIds(profile, session.user);
  const result = await client.query(
    `SELECT base44_id AS id,log_date AS date,destination,purpose,miles,rate,deduction,created_by_id,created_date,updated_date,data FROM artflow.mileage_logs WHERE created_by_id = ANY($1::text[]) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(data->'access_emails')='array' THEN data->'access_emails' ELSE '[]'::jsonb END) e(value) WHERE lower(e.value)=$2) ORDER BY log_date DESC NULLS LAST`,
    [creators, email]
  );
  return result.rows.map((row) => ({ ...row, ...(row.data || {}), id: row.id, date: row.date }));
}

async function writeMileage(client, session, req) {
  const { profile, email } = await ensureWorkspace(client, session.user);
  const creators = userCreatorIds(profile, session.user);
  const body = requestBody(req);
  const action = String(body.action || '').toLowerCase();
  const id = String(body.id || crypto.randomUUID());
  if (action === 'delete') {
    const result = await client.query(`DELETE FROM artflow.mileage_logs WHERE base44_id=$1 AND created_by_id = ANY($2::text[]) RETURNING base44_id`, [id, creators]);
    if (!result.rows[0]) throw new Error('Mileage entry not found');
    return { id, deleted: true };
  }
  const data = JSON.stringify({ ...(body.data || {}), notes: body.notes || null, access_emails: Array.isArray(body.access_emails) ? body.access_emails : (email ? [email] : []) });
  if (action === 'update') {
    const result = await client.query(`UPDATE artflow.mileage_logs SET log_date=$3,destination=$4,purpose=$5,miles=$6,rate=$7,deduction=$8,data=COALESCE(data,'{}'::jsonb)||$9::jsonb,updated_date=now() WHERE base44_id=$1 AND created_by_id = ANY($2::text[]) RETURNING base44_id AS id,*`, [id, creators, body.date || null, body.destination || null, body.purpose || null, Number(body.miles) || 0, Number(body.rate) || 0, Number(body.deduction) || 0, data]);
    if (!result.rows[0]) throw new Error('Mileage entry not found');
    return { ...result.rows[0], ...(result.rows[0].data || {}), date: result.rows[0].log_date };
  }
  const result = await client.query(`INSERT INTO artflow.mileage_logs (base44_id,log_date,destination,purpose,miles,rate,deduction,created_by_id,created_date,updated_date,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now(),$9::jsonb) RETURNING base44_id AS id,*`, [id, body.date || null, body.destination || null, body.purpose || null, Number(body.miles) || 0, Number(body.rate) || 0, Number(body.deduction) || 0, profile?.base44_id || session.user.id, data]);
  return { ...result.rows[0], ...(result.rows[0].data || {}), date: result.rows[0].log_date };
}

async function listSchedule(client, session) {
  const { profile, email } = await ensureWorkspace(client, session.user);
  const creators = userCreatorIds(profile, session.user);
  const result = await client.query(`SELECT base44_id AS id,title,event_date AS date,event_time AS time,type,google_event_id,created_by_id,created_date,updated_date,data FROM artflow.schedule_events WHERE created_by_id = ANY($1::text[]) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(data->'access_emails')='array' THEN data->'access_emails' ELSE '[]'::jsonb END) e(value) WHERE lower(e.value)=$2) ORDER BY event_date ASC NULLS LAST,event_time ASC NULLS LAST`, [creators,email]);
  return result.rows.map((row) => ({ ...row, ...(row.data || {}), id: row.id, date: row.date, time: row.time }));
}

async function writeSchedule(client, session, req) {
  const { profile, email } = await ensureWorkspace(client, session.user);
  const creators = userCreatorIds(profile, session.user);
  const body = requestBody(req);
  const action = String(body.action || '').toLowerCase();
  const id = String(body.id || crypto.randomUUID());
  if (action === 'delete') {
    const result = await client.query(`DELETE FROM artflow.schedule_events WHERE base44_id=$1 AND created_by_id = ANY($2::text[]) RETURNING base44_id`, [id, creators]);
    if (!result.rows[0]) throw new Error('Event not found');
    return { id, deleted: true };
  }
  const data = JSON.stringify({ ...(body.data || {}), notes: body.notes || '', access_emails: Array.isArray(body.access_emails) ? body.access_emails : (email ? [email] : []) });
  if (action === 'update') {
    const result = await client.query(`UPDATE artflow.schedule_events SET title=$3,event_date=$4,event_time=$5,type=$6,data=COALESCE(data,'{}'::jsonb)||$7::jsonb,updated_date=now() WHERE base44_id=$1 AND created_by_id = ANY($2::text[]) RETURNING base44_id AS id,*`, [id,creators,body.title || null,body.date || null,body.time || '',body.type || 'Other',data]);
    if (!result.rows[0]) throw new Error('Event not found');
    return { ...result.rows[0], ...(result.rows[0].data || {}), date: result.rows[0].event_date, time: result.rows[0].event_time };
  }
  const result = await client.query(`INSERT INTO artflow.schedule_events (base44_id,title,event_date,event_time,type,created_by_id,created_date,updated_date,data) VALUES ($1,$2,$3,$4,$5,$6,now(),now(),$7::jsonb) RETURNING base44_id AS id,*`, [id,body.title || null,body.date || null,body.time || '',body.type || 'Other',profile?.base44_id || session.user.id,data]);
  return { ...result.rows[0], ...(result.rows[0].data || {}), date: result.rows[0].event_date, time: result.rows[0].event_time };
}

async function listBusinesses(client, session) {
  const { businesses } = await ensureWorkspace(client, session.user);
  return businesses.map((row) => ({ id: row.base44_id, ...row.data, name: row.name || row.data?.name || 'Business', primary_email: row.primary_email || row.data?.primary_email || session.user.email }));
}

async function writeBusiness(client, session, req) {
  const { businesses, ids } = await ensureWorkspace(client, session.user);
  const body = requestBody(req);
  const id = String(body.id || '').trim();
  if (!id || !ids.includes(id)) throw new Error('Business workspace not found');
  const current = businesses.find((item) => item.base44_id === id);
  const dataFields = ['member_emails','sales_emails','expense_emails','tracked_marketplaces','spreadsheet_id','business_plan'];
  const patch = { ...(current?.data || {}) };
  for (const key of dataFields) if (Object.prototype.hasOwnProperty.call(body,key)) patch[key] = body[key];
  const result = await client.query(`UPDATE artflow.businesses SET name=COALESCE($2,name),primary_email=COALESCE($3,primary_email),data=$4::jsonb,updated_date=now() WHERE base44_id=$1 RETURNING base44_id AS id,name,primary_email,data`, [id, body.name || null, body.primary_email || null, JSON.stringify(patch)]);
  return { ...result.rows[0], ...(result.rows[0]?.data || {}) };
}

async function writeExpense(client, session, req) {
  const { profile, ids, email } = await ensureWorkspace(client, session.user);
  const body = requestBody(req);
  const action = String(body.action || '').toLowerCase();
  const id = String(body.id || crypto.randomUUID());
  const businessId = selectedBusinessId(profile, ids, body.business_id);
  if (!businessId) throw new Error('Business workspace not found');
  if (action === 'delete') {
    const result = await client.query(`UPDATE artflow.expenses SET archived=true,updated_date=now() WHERE base44_id=$1 AND business_id = ANY($2::text[]) RETURNING base44_id`, [id,ids]);
    if (!result.rows[0]) throw new Error('Expense not found');
    return { id, deleted: true };
  }
  if (action === 'approve') {
    const result = await client.query(`UPDATE artflow.expenses SET data=COALESCE(data,'{}'::jsonb)||$3::jsonb,updated_date=now() WHERE base44_id=$1 AND business_id = ANY($2::text[]) RETURNING base44_id`, [id, ids, JSON.stringify({ status: 'approved' })]);
    if (!result.rows[0]) throw new Error('Expense not found');
    return { id, approved: true };
  }
  const data = JSON.stringify({ ...(body.data || {}), description: body.description || '', deductible_percent: body.deductible_percent == null ? 100 : Number(body.deductible_percent), deductible_amount: body.deductible_amount == null ? null : Number(body.deductible_amount), notes: body.notes || null, access_emails: Array.isArray(body.access_emails) ? body.access_emails : (email ? [email] : []) });
  if (action === 'update') {
    const result = await client.query(`UPDATE artflow.expenses SET expense_date=$3,category=$4,amount=$5,source=COALESCE($6,source),data=COALESCE(data,'{}'::jsonb)||$7::jsonb,updated_date=now() WHERE base44_id=$1 AND business_id = ANY($2::text[]) RETURNING base44_id AS id,*`, [id,ids,body.date || null,body.category || null,Number(body.amount)||0,body.source || null,data]);
    if (!result.rows[0]) throw new Error('Expense not found');
    return result.rows[0];
  }
  const result = await client.query(`INSERT INTO artflow.expenses (base44_id,business_id,expense_date,category,amount,archived,source,created_by_id,created_date,updated_date,data) VALUES ($1,$2,$3,$4,$5,false,$6,$7,now(),now(),$8::jsonb) RETURNING base44_id AS id,*`, [id,businessId,body.date||null,body.category||null,Number(body.amount)||0,body.source||'manual',profile?.base44_id||session.user.id,data]);
  return result.rows[0];
}

async function writeOrder(client, session, req) {
  const { profile, ids, email } = await ensureWorkspace(client, session.user);
  const body = requestBody(req);
  const action = String(body.action || 'create').toLowerCase();

  if (action === 'set_shipped') {
    const id = String(body.id || '').trim();
    if (!id) throw new Error('Order id is required');
    const shipped = Boolean(body.shipped);
    const patch = {
      shipped,
      shipped_at: shipped ? new Date().toISOString() : null,
    };
    const updated = await client.query(
      `UPDATE artflow.orders
          SET data=COALESCE(data,'{}'::jsonb)||$4::jsonb,
              updated_date=now()
        WHERE base44_id=$1
          AND (
            business_id = ANY($2::text[])
            OR EXISTS (
              SELECT 1
                FROM jsonb_array_elements_text(
                  CASE
                    WHEN jsonb_typeof(data->'access_emails')='array' THEN data->'access_emails'
                    ELSE '[]'::jsonb
                  END
                ) access(value)
               WHERE lower(access.value)=$3
            )
          )
        RETURNING base44_id AS id,
                  (COALESCE(data->>'shipped','false')='true') AS shipped,
                  NULLIF(data->>'shipped_at','') AS shipped_at`,
      [id, ids, email, JSON.stringify(patch)]
    );
    if (!updated.rows[0]) throw new Error('Order not found');
    return updated.rows[0];
  }

  const businessId = selectedBusinessId(profile, ids, body.business_id);
  if (!businessId) throw new Error('Business workspace not found');
  const id = String(body.id || crypto.randomUUID());
  const quantity = Math.max(1, Number(body.quantity) || 1);
  const unitPrice = Number(body.unit_price) || 0;
  const saleTotal = body.sale_total == null ? quantity * unitPrice : Number(body.sale_total) || 0;
  const totalCost = Number(body.total_cost) || 0;
  const estimatedProfit = body.estimated_profit == null ? saleTotal - totalCost : Number(body.estimated_profit) || 0;
  const data = JSON.stringify({ ...(body.data || {}), access_emails: Array.isArray(body.access_emails) ? body.access_emails : (email ? [email] : []) });
  const result = await client.query(`INSERT INTO artflow.orders (base44_id,business_id,sale_date,platform,archived,order_id,source_email_id,created_by_id,created_date,updated_date,data,product_name,quantity,size,unit_price,sale_total,buyer,base_item_cost,paper_ink_cost,packaging_cost,total_cost,estimated_profit,sync_source) VALUES ($1,$2,$3,$4,false,$5,$6,$7,now(),now(),$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'manual') RETURNING base44_id AS id,*`, [id,businessId,body.sale_date||null,body.platform||null,body.order_id||null,body.source_email_id||null,profile?.base44_id||session.user.id,data,body.product_name||null,quantity,body.size||null,unitPrice,saleTotal,body.buyer||null,Number(body.base_item_cost)||0,Number(body.paper_ink_cost)||0,Number(body.packaging_cost)||0,totalCost,estimatedProfit]);
  return result.rows[0];
}

async function advisorSnapshot(client, session) {
  const { businesses, ids, email } = await ensureWorkspace(client, session.user);
  const accessSql = `(
    business_id = ANY($1::text[])
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(data->'access_emails')='array' THEN data->'access_emails' ELSE '[]'::jsonb END) access(value)
       WHERE lower(access.value) = $2
    )
  )`;

  const [totals, platforms, sizes, products, expenseCategories, inventory, monthTrend, dataQuality] = await runSequential([
    () => client.query(
      `SELECT
         COALESCE(sum(sale_total),0)::numeric AS total_sales,
         count(DISTINCT COALESCE(NULLIF(order_id,''), NULLIF(split_part(source_email_id, ':', 1),''), base44_id))::int AS total_orders,
         COALESCE(sum(COALESCE(quantity,1)),0)::numeric AS total_items,
         COALESCE(sum(total_cost),0)::numeric AS order_costs,
         COALESCE(sum(estimated_profit),0)::numeric AS gross_profit,
         COALESCE(sum(sale_total) FILTER (WHERE left(COALESCE(sale_date,''),7)=to_char(CURRENT_DATE,'YYYY-MM')),0)::numeric AS month_sales,
         (count(DISTINCT COALESCE(NULLIF(order_id,''), NULLIF(split_part(source_email_id, ':', 1),''), base44_id)) FILTER (WHERE left(COALESCE(sale_date,''),7)=to_char(CURRENT_DATE,'YYYY-MM')))::int AS month_orders,
         COALESCE(sum(total_cost) FILTER (WHERE left(COALESCE(sale_date,''),7)=to_char(CURRENT_DATE,'YYYY-MM')),0)::numeric AS month_costs,
         COALESCE(sum(sale_total) FILTER (WHERE left(COALESCE(sale_date,''),4)=to_char(CURRENT_DATE,'YYYY')),0)::numeric AS year_sales,
         COALESCE(sum(total_cost) FILTER (WHERE left(COALESCE(sale_date,''),4)=to_char(CURRENT_DATE,'YYYY')),0)::numeric AS year_costs
       FROM artflow.orders
       WHERE archived IS NOT TRUE
         AND left(COALESCE(sale_date,''),4)=to_char(CURRENT_DATE,'YYYY')
         AND ${accessSql}`,
      [ids, email]
    ),
    () => client.query(
      `SELECT COALESCE(NULLIF(platform,''),'Unknown') AS name,
              COALESCE(sum(sale_total),0)::numeric AS sales,
              count(DISTINCT COALESCE(NULLIF(order_id,''), NULLIF(split_part(source_email_id, ':', 1),''), base44_id))::int AS orders,
              COALESCE(sum(COALESCE(quantity,1)),0)::numeric AS items,
              COALESCE(sum(estimated_profit),0)::numeric AS gross_profit
         FROM artflow.orders
        WHERE archived IS NOT TRUE AND ${accessSql}
          AND left(COALESCE(sale_date,''),4)=to_char(CURRENT_DATE,'YYYY')
        GROUP BY 1 ORDER BY sales DESC, orders DESC LIMIT 10`,
      [ids, email]
    ),
    () => client.query(
      `SELECT COALESCE(NULLIF(size,''),'Unknown') AS name,
              COALESCE(sum(sale_total),0)::numeric AS sales,
              COALESCE(sum(COALESCE(quantity,1)),0)::numeric AS items,
              count(DISTINCT COALESCE(NULLIF(order_id,''), NULLIF(split_part(source_email_id, ':', 1),''), base44_id))::int AS orders
         FROM artflow.orders
        WHERE archived IS NOT TRUE AND ${accessSql}
          AND left(COALESCE(sale_date,''),4)=to_char(CURRENT_DATE,'YYYY')
        GROUP BY 1 ORDER BY items DESC, sales DESC LIMIT 12`,
      [ids, email]
    ),
    () => client.query(
      `SELECT COALESCE(NULLIF(product_name,''),'Unknown item') AS name,
              COALESCE(sum(sale_total),0)::numeric AS sales,
              COALESCE(sum(COALESCE(quantity,1)),0)::numeric AS items,
              count(DISTINCT COALESCE(NULLIF(order_id,''), NULLIF(split_part(source_email_id, ':', 1),''), base44_id))::int AS orders,
              COALESCE(sum(estimated_profit),0)::numeric AS gross_profit
         FROM artflow.orders
        WHERE archived IS NOT TRUE AND ${accessSql}
          AND left(COALESCE(sale_date,''),4)=to_char(CURRENT_DATE,'YYYY')
        GROUP BY 1 ORDER BY items DESC, sales DESC LIMIT 12`,
      [ids, email]
    ),
    () => client.query(
      `SELECT COALESCE(NULLIF(category,''),'Uncategorized') AS name,
              COALESCE(sum(amount),0)::numeric AS amount,
              count(*)::int AS count
         FROM artflow.expenses
        WHERE archived IS NOT TRUE
          AND COALESCE(data->>'status','approved') <> 'pending'
          AND ${accessSql}
        GROUP BY 1 ORDER BY amount DESC LIMIT 12`,
      [ids, email]
    ),
    () => client.query(
      `SELECT
         count(*)::int AS item_types,
         COALESCE(sum(quantity_on_hand),0)::numeric AS units_on_hand,
         COALESCE(sum(quantity_on_hand * total_unit_cost),0)::numeric AS inventory_value,
         COALESCE(jsonb_agg(jsonb_build_object(
           'name', name,
           'size', size,
           'quantity', quantity_on_hand,
           'lowStockLevel', low_stock_level,
           'unitCost', total_unit_cost
         ) ORDER BY quantity_on_hand ASC) FILTER (WHERE quantity_on_hand <= low_stock_level), '[]'::jsonb) AS low_stock
       FROM artflow.inventory_costs
       WHERE business_id = ANY($1::text[])`,
      [ids]
    ),
    () => client.query(
      `SELECT
         COALESCE(sum(sale_total) FILTER (WHERE left(COALESCE(sale_date,''),7)=to_char(CURRENT_DATE,'YYYY-MM')),0)::numeric AS current_sales,
         COALESCE(sum(sale_total) FILTER (WHERE left(COALESCE(sale_date,''),7)=to_char(CURRENT_DATE - interval '1 month','YYYY-MM')),0)::numeric AS previous_sales,
         (count(DISTINCT COALESCE(NULLIF(order_id,''), NULLIF(split_part(source_email_id, ':', 1),''), base44_id)) FILTER (WHERE left(COALESCE(sale_date,''),7)=to_char(CURRENT_DATE,'YYYY-MM')))::int AS current_orders,
         (count(DISTINCT COALESCE(NULLIF(order_id,''), NULLIF(split_part(source_email_id, ':', 1),''), base44_id)) FILTER (WHERE left(COALESCE(sale_date,''),7)=to_char(CURRENT_DATE - interval '1 month','YYYY-MM')))::int AS previous_orders
       FROM artflow.orders
       WHERE archived IS NOT TRUE
         AND left(COALESCE(sale_date,''),4)=to_char(CURRENT_DATE,'YYYY')
         AND ${accessSql}`,
      [ids, email]
    ),
    () => client.query(
      `SELECT
         (count(*) FILTER (WHERE COALESCE(total_cost,0)=0))::int AS orders_missing_cost,
         (count(*) FILTER (WHERE COALESCE(NULLIF(platform,''),'')=''))::int AS orders_missing_platform,
         (count(*) FILTER (WHERE COALESCE(NULLIF(size,''),'')=''))::int AS orders_missing_size
       FROM artflow.orders
       WHERE archived IS NOT TRUE
         AND left(COALESCE(sale_date,''),4)=to_char(CURRENT_DATE,'YYYY')
         AND ${accessSql}`,
      [ids, email]
    ),
  ]);

  const expenseTotals = await client.query(
    `SELECT
       COALESCE(sum(amount) FILTER (WHERE COALESCE(data->>'status','approved') <> 'pending'),0)::numeric AS total_expenses,
       COALESCE(sum(amount) FILTER (WHERE COALESCE(data->>'status','approved') <> 'pending' AND left(COALESCE(expense_date,''),7)=to_char(CURRENT_DATE,'YYYY-MM')),0)::numeric AS month_expenses,
       COALESCE(sum(amount) FILTER (WHERE COALESCE(data->>'status','approved') <> 'pending' AND left(COALESCE(expense_date,''),4)=to_char(CURRENT_DATE,'YYYY')),0)::numeric AS year_expenses,
       (count(*) FILTER (WHERE COALESCE(data->>'status','approved')='pending'))::int AS pending_expenses
     FROM artflow.expenses
     WHERE archived IS NOT TRUE AND ${accessSql}`,
    [ids, email]
  );

  const num = (value) => Number(value) || 0;
  const mapRows = (rows) => rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, ['sales','gross_profit','amount','orders','items','count'].includes(key) ? num(value) : value])
  ));
  const t = totals.rows[0] || {};
  const e = expenseTotals.rows[0] || {};
  const inv = inventory.rows[0] || {};
  const trend = monthTrend.rows[0] || {};
  const quality = dataQuality.rows[0] || {};
  const totalSales = num(t.total_sales);
  const orderCosts = num(t.order_costs);
  const totalExpenses = num(e.total_expenses);
  const monthSales = num(t.month_sales);
  const monthCosts = num(t.month_costs);
  const monthExpenses = num(e.month_expenses);
  const yearSales = num(t.year_sales);
  const yearCosts = num(t.year_costs);
  const yearExpenses = num(e.year_expenses);

  return {
    generatedAt: new Date().toISOString(),
    business: businesses[0] ? { id: businesses[0].base44_id, name: businesses[0].name || 'Business' } : null,
    metrics: {
      totalSales,
      totalOrders: num(t.total_orders),
      totalItems: num(t.total_items),
      orderCosts,
      totalExpenses,
      netProfit: totalSales - orderCosts - totalExpenses,
      averageOrder: num(t.total_orders) ? totalSales / num(t.total_orders) : 0,
      monthSales,
      monthOrders: num(t.month_orders),
      monthCosts,
      monthExpenses,
      monthNet: monthSales - monthCosts - monthExpenses,
      yearSales,
      yearCosts,
      yearExpenses,
      yearNet: yearSales - yearCosts - yearExpenses,
    },
    trend: {
      currentSales: num(trend.current_sales),
      previousSales: num(trend.previous_sales),
      currentOrders: num(trend.current_orders),
      previousOrders: num(trend.previous_orders),
    },
    platforms: mapRows(platforms.rows),
    sizes: mapRows(sizes.rows),
    products: mapRows(products.rows),
    expenseCategories: mapRows(expenseCategories.rows),
    inventory: {
      itemTypes: num(inv.item_types),
      unitsOnHand: num(inv.units_on_hand),
      inventoryValue: num(inv.inventory_value),
      lowStock: Array.isArray(inv.low_stock) ? inv.low_stock : [],
    },
    dataQuality: {
      ordersMissingCost: num(quality.orders_missing_cost),
      ordersMissingPlatform: num(quality.orders_missing_platform),
      ordersMissingSize: num(quality.orders_missing_size),
      pendingExpenses: num(e.pending_expenses),
    },
  };
}

async function summary(client, session) {
  const { profile, businesses, ids } = await ensureWorkspace(client, session.user);
  const email = normalize(session.user.email);
  const [orders, expenses, emailImports, syncStates, orderMetrics, expenseMetrics] = await runSequential([
    () => countBusinessRows(client, 'orders', ids, email, true, 'sale_date'),
    () => countBusinessRows(client, 'expenses', ids, email, true),
    () => countBusinessRows(client, 'email_import_messages', ids, email, false),
    () => countBusinessRows(client, 'sync_states', ids, email, false),
    () => client.query(
      `WITH scoped_orders AS (
         SELECT o.*,
           regexp_replace(COALESCE(o.sale_date,''),'T.*$','') AS dedupe_day,
           round(COALESCE(o.sale_total,0)::numeric,2) AS dedupe_total,
           COALESCE(o.quantity,1) AS dedupe_qty,
           lower(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   COALESCE(o.product_name,''),
                   '^\\s*[0-9]+(?:\\.[0-9]+)?\\s*x\\s*[0-9]+(?:\\.[0-9]+)?\\s*[-–—|:]?\\s*',
                   '',
                   'i'
                 ),
                 '\\m(of|the|a|an)\\M',
                 '',
                 'gi'
               ),
               '[^a-z0-9]+',
               '',
               'g'
             )
           ) AS dedupe_title
         FROM artflow.orders o
         WHERE o.archived IS NOT TRUE
           AND left(COALESCE(o.sale_date,''),4)=to_char(CURRENT_DATE,'YYYY')
           AND NOT (
             lower(COALESCE(o.platform,''))='ebay'
             AND COALESCE(o.sync_source,'')='yahoo_direct_sales'
             AND (
               COALESCE(o.product_name,'') ~ '^\\s*&(?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z]+);\\s*$'
               OR length(regexp_replace(COALESCE(o.product_name,''),'[^A-Za-z0-9]','','g')) < 3
             )
           )
           AND (
             o.business_id = ANY($1::text[])
             OR EXISTS (
               SELECT 1
                 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(o.data->'access_emails')='array' THEN o.data->'access_emails' ELSE '[]'::jsonb END) e(value)
                WHERE lower(e.value) = $2
             )
           )
       ),
       visible_orders AS (
         SELECT s.*
         FROM scoped_orders s
         WHERE NOT (
           s.sync_source LIKE 'google_sheet%'
           AND EXISTS (
             SELECT 1
             FROM scoped_orders g
             WHERE g.sync_source LIKE 'gmail_direct_sales%'
               AND lower(g.platform)=lower(s.platform)
               AND g.dedupe_day=s.dedupe_day
               AND g.dedupe_total=s.dedupe_total
               AND g.dedupe_qty=s.dedupe_qty
               AND s.dedupe_title<>''
               AND g.dedupe_title<>''
               AND (
                 g.dedupe_title=s.dedupe_title
                 OR (length(s.dedupe_title)>=12 AND g.dedupe_title LIKE '%'||s.dedupe_title||'%')
                 OR (length(g.dedupe_title)>=12 AND s.dedupe_title LIKE '%'||g.dedupe_title||'%')
               )
           )
         )
       ),
       deduped_orders AS (
         SELECT *
         FROM (
           SELECT v.*,
             row_number() OVER (
               PARTITION BY
                 lower(COALESCE(v.platform,'')),
                 CASE
                   WHEN NULLIF(trim(v.order_id),'') IS NOT NULL
                     THEN 'order:' || lower(trim(v.order_id))
                   WHEN NULLIF(trim(v.source_email_id),'') IS NOT NULL
                     THEN 'email:' || lower(trim(v.source_email_id))
                   ELSE 'fallback:' || COALESCE(v.dedupe_day,'') || '|' || COALESCE(v.dedupe_title,'') || '|' || COALESCE(v.dedupe_qty,1)::text || '|' || COALESCE(v.dedupe_total,0)::text
                 END
               ORDER BY
                 CASE WHEN COALESCE(v.sale_total,0) > 0 THEN 0 ELSE 1 END,
                 CASE
                   WHEN v.sync_source LIKE 'gmail_direct_sales%' THEN 0
                   WHEN v.sync_source LIKE '%official%' THEN 1
                   ELSE 2
                 END,
                 v.updated_date DESC NULLS LAST,
                 v.created_date DESC NULLS LAST
             ) AS duplicate_rank
           FROM visible_orders v
         ) ranked
         WHERE duplicate_rank = 1
       )
       SELECT
         COALESCE(sum(sale_total),0)::numeric AS total_sales,
         count(DISTINCT COALESCE(NULLIF(order_id,''), NULLIF(split_part(source_email_id, ':', 1),''), base44_id))::int AS total_orders,
         COALESCE(sum(COALESCE(quantity,1)),0)::numeric AS total_items,
         COALESCE(sum(total_cost),0)::numeric AS order_costs,
         COALESCE(sum(sale_total) FILTER (WHERE left(COALESCE(sale_date,''),7)=to_char(CURRENT_DATE,'YYYY-MM')),0)::numeric AS month_sales,
         COALESCE(sum(total_cost) FILTER (WHERE left(COALESCE(sale_date,''),7)=to_char(CURRENT_DATE,'YYYY-MM')),0)::numeric AS month_costs
       FROM deduped_orders`,
      [ids, email]
    ),
    () => client.query(
      `SELECT
         COALESCE(sum(
           COALESCE(
             NULLIF(data->>'deductible_amount','')::numeric,
             amount * COALESCE(NULLIF(data->>'deductible_percent','')::numeric,100) / 100
           )
         ),0)::numeric AS deductible_expenses,
         COALESCE(sum(
           COALESCE(
             NULLIF(data->>'deductible_amount','')::numeric,
             amount * COALESCE(NULLIF(data->>'deductible_percent','')::numeric,100) / 100
           )
         ) FILTER (WHERE left(COALESCE(expense_date,''),7)=to_char(CURRENT_DATE,'YYYY-MM')),0)::numeric AS month_deductions
       FROM artflow.expenses
       WHERE archived IS NOT TRUE
         AND COALESCE(data->>'status','approved') <> 'pending'
         AND (
           business_id = ANY($1::text[])
           OR EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(data->'access_emails')='array' THEN data->'access_emails' ELSE '[]'::jsonb END) e(value)
              WHERE lower(e.value) = $2
           )
         )`,
      [ids, email]
    ),
  ]);

  const om = orderMetrics.rows[0] || {};
  const em = expenseMetrics.rows[0] || {};
  const totalSales = Number(om.total_sales) || 0;
  const totalOrders = Number(om.total_orders) || 0;
  const totalItems = Number(om.total_items) || 0;
  const orderCosts = Number(om.order_costs) || 0;
  const deductibleExpenses = Number(em.deductible_expenses) || 0;
  const monthSales = Number(om.month_sales) || 0;
  const monthCosts = Number(om.month_costs) || 0;
  const monthDeductions = Number(em.month_deductions) || 0;

  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name || profile?.full_name || null,
      legacyProfileLinked: Boolean(profile),
      legacyProfileId: profile?.base44_id || null,
      activeBusinessId: profile?.active_business_id || profile?.data?.active_business_id || null,
    },
    businesses: businesses.map((b) => ({ id: b.base44_id, name: b.name || b.data?.name || 'Business' })),
    counts: { orders: totalOrders, expenses, emailImports, syncStates },
    metrics: {
      totalSales,
      totalOrders,
      totalItems,
      orderCosts,
      deductibleExpenses,
      netProfit: totalSales - orderCosts - deductibleExpenses,
      monthSales,
      monthCosts,
      monthDeductions,
      monthNet: monthSales - monthCosts - monthDeductions,
      averageOrder: totalOrders ? totalSales / totalOrders : 0,
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const session = await getSession(req).catch(() => null);
  if (!session?.user) return res.status(401).json({ error: 'Unauthorized' });

  const client = await pool.connect();
  try {
    const op = String(req.query?.op || 'summary');
    if (req.method === 'POST') {
      if (op === 'inventory') return res.status(200).json({ item: await writeInventory(client, session, req) });
      if (op === 'expenses') return res.status(200).json({ item: await writeExpense(client, session, req) });
      if (op === 'orders') return res.status(200).json({ item: await writeOrder(client, session, req) });
      if (op === 'art-pieces') return res.status(200).json({ item: await writeArtPiece(client, session, req) });
      if (op === 'mileage') return res.status(200).json({ item: await writeMileage(client, session, req) });
      if (op === 'schedule') return res.status(200).json({ item: await writeSchedule(client, session, req) });
      if (op === 'businesses') return res.status(200).json({ item: await writeBusiness(client, session, req) });
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (op === 'summary') return res.status(200).json(await summary(client, session));
    if (op === 'advisor') return res.status(200).json(await advisorSnapshot(client, session));
    if (op === 'orders') return res.status(200).json({ orders: await listOrders(client, session) });
    if (op === 'expenses') return res.status(200).json({ expenses: await listExpenses(client, session) });
    if (op === 'inventory') return res.status(200).json({ inventory: await listInventory(client, session) });
    if (op === 'listings') return res.status(200).json({ listings: await listMarketplaceListings(client, session) });
    if (op === 'art-pieces') return res.status(200).json({ records: await listArtPieces(client, session) });
    if (op === 'mileage') return res.status(200).json({ records: await listMileage(client, session) });
    if (op === 'schedule') return res.status(200).json({ records: await listSchedule(client, session) });
    if (op === 'businesses') return res.status(200).json({ records: await listBusinesses(client, session) });
    return res.status(400).json({ error: 'Unknown operation' });
  } catch (e) {
    console.error('neon data error', e?.message || e);
    return res.status(500).json({ error: 'Data request failed' });
  } finally {
    client.release();
  }
}
