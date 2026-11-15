import { auth } from './auth/_auth.mjs';
import { fromNodeHeaders } from 'better-auth/node';
import {
  pool,
  getLegacyProfile,
  getBusiness,
  googleJson,
  normalize,
  approveGmailEmail,
  syncGmailAccount,
} from './_gmail-sales-core.mjs';

async function accessTokenForAccount(req, accountId) {
  const headers = fromNodeHeaders(req.headers);
  const token = await auth.api.getAccessToken({ headers, body: { accountId } });
  if (!token?.accessToken) {
    const error = new Error('Reconnect Google in Account to resume Gmail sales sync.');
    error.code = 'GMAIL_RECONNECT';
    throw error;
  }
  return token.accessToken;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (!session?.user) return res.status(401).json({ error: 'Unauthorized' });

  const client = await pool.connect();
  try {
    const profile = await getLegacyProfile(client, session.user);
    const business = await getBusiness(client, profile, session.user);
    if (!business?.base44_id) return res.status(400).json({ error: 'No Art Flow business workspace was found.' });

    const force = req.method === 'POST' && Boolean(req.body?.force);
    const depopPhotosOnly = req.method === 'POST' && req.body?.depop_photos_only === true;
    const depopPhotoStats = async () => {
      const result = await client.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE COALESCE(data->>'image_url','') ~*
                 '^https://(media(-photos)?[.]depop[.]com|[^/]+[.]cloudfront[.]net)/')::int AS photos
        FROM artflow.orders
        WHERE business_id=$1 AND archived IS NOT TRUE AND lower(platform)='depop'
      `, [business.base44_id]);
      return result.rows[0] || { total: 0, photos: 0 };
    };
    const photoStatsBefore = depopPhotosOnly ? await depopPhotoStats() : null;

    const accounts = await auth.api.listUserAccounts({ headers: fromNodeHeaders(req.headers) });
    const googleAccounts = (accounts || []).filter((account) => account.providerId === 'google' && account.id);

    if (req.method === 'GET') {
      const connectedAccounts = [];
      let reconnectRequired = false;
      const allowedEmails = new Set(
        [business.primary_email, business.data?.primary_email, ...(business.data?.sales_emails || [])]
          .map(normalize).filter(Boolean)
      );
      for (const account of googleAccounts) {
        try {
          const accessToken = await accessTokenForAccount(req, account.id);
          const profileData = await googleJson(accessToken, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
          const gmailAddress = normalize(profileData?.emailAddress || '');
          if (!gmailAddress) continue;
          if (!allowedEmails.has(gmailAddress)) {
            // A user explicitly connected this Gmail inbox from the Sales Inbox
            // workflow. Register it to the active business immediately so the
            // status check and the first sync agree instead of showing a false
            // "not listed as a sales email" warning.
            await approveGmailEmail(client, business, gmailAddress);
            allowedEmails.add(gmailAddress);
          }
          connectedAccounts.push({ email: gmailAddress, approved: true });
        } catch (error) {
          if (error?.code === 'GMAIL_RECONNECT' || error?.status === 401) reconnectRequired = true;
        }
      }
      const connectedEmailSet = new Set(connectedAccounts.map((item) => normalize(item.email)));
      const salesInboxes = Array.from(allowedEmails);
      const forwardOnlyInboxes = salesInboxes.filter((email) => !connectedEmailSet.has(normalize(email)));

      return res.status(200).json({
        configured: googleAccounts.length > 0,
        connected: connectedAccounts.some((item) => item.approved),
        gmail_access: connectedAccounts.length > 0,
        reconnect_required: reconnectRequired && connectedAccounts.length === 0,
        accounts: connectedAccounts,
        sales_inboxes: salesInboxes,
        forward_only_inboxes: forwardOnlyInboxes,
        message: connectedAccounts.length
          ? 'Gmail access is connected.'
          : googleAccounts.length
            ? 'Google is linked, but Gmail permission still needs to be approved.'
            : 'Connect Gmail to turn on automatic marketplace sale-email syncing.',
      });
    }

    if (!googleAccounts.length) {
      return res.status(409).json({ error: 'Connect Gmail in Account to turn on automatic Gmail sales sync.', code: 'GMAIL_NOT_LINKED' });
    }

    let matchedAccounts = 0;
    let permissionErrors = 0;
    let hardError = null;
    let scanned = 0;
    let parsed = 0;
    let imported = 0;
    let rateLimited = false;

    for (const account of googleAccounts) {
      try {
        const accessToken = await accessTokenForAccount(req, account.id);
        const result = await syncGmailAccount(client, business, accessToken, { force, depopPhotosOnly });
        if (result.reconnectRequired) {
          permissionErrors += 1;
          continue;
        }
        if (!result.matched) continue;
        matchedAccounts += 1;
        scanned += result.scanned;
        parsed += result.parsed;
        imported += result.imported;
        rateLimited = rateLimited || result.throttled;
      } catch (error) {
        if (error?.code === 'GMAIL_RECONNECT' || error?.status === 401) {
          permissionErrors += 1;
          continue;
        }
        hardError = error;
        console.warn('Gmail sales sync account failed', error?.message || error);
      }
    }

    if (!matchedAccounts && hardError) {
      const rateLimited = hardError?.code === 'GMAIL_RATE_LIMIT';
      return res.status(500).json({
        error: rateLimited
          ? 'Google temporarily limited Gmail syncing. Art Flow will retry automatically.'
          : hardError?.message || 'Gmail sales import failed.',
        code: rateLimited ? 'GMAIL_RATE_LIMIT' : 'GMAIL_IMPORT_ERROR',
      });
    }
    if (!matchedAccounts && permissionErrors) {
      return res.status(409).json({
        error: 'Reconnect Google in Account so Art Flow can read marketplace sale emails.',
        code: 'GMAIL_RECONNECT',
      });
    }
    if (!matchedAccounts) {
      return res.status(409).json({
        error: 'The connected Google account is not listed as a sales email for this business.',
        code: 'GMAIL_NOT_APPROVED',
      });
    }

    if (depopPhotosOnly) {
      const photoStatsAfter = await depopPhotoStats();
      const total = Number(photoStatsAfter.total) || 0;
      const photos = Number(photoStatsAfter.photos) || 0;
      const recovered = Math.max(0, photos - (Number(photoStatsBefore?.photos) || 0));
      return res.status(200).json({
        ok: true,
        accounts: matchedAccounts,
        scanned,
        recovered,
        photos,
        total,
        remaining: Math.max(0, total - photos),
        throttled: rateLimited,
        message: rateLimited
          ? `Google paused Gmail requests because of its quota. ${recovered} photos recovered; ${photos} of ${total} Depop photos saved so far.`
          : `Checked ${scanned} Depop sale emails. ${recovered} photos recovered; ${photos} of ${total} Depop photos saved.`,
      });
    }

    return res.status(200).json({
      ok: true,
      accounts: matchedAccounts,
      scanned,
      parsed,
      imported,
      message: imported > 0
        ? `Imported ${imported} new sale${imported === 1 ? '' : 's'} from Gmail.`
        : 'Gmail sales are up to date.',
    });
  } catch (error) {
    console.error('gmail sales sync error', error?.message || error);
    return res.status(500).json({ error: error?.message || 'Could not sync Gmail sales.', code: 'GMAIL_SYNC_ERROR' });
  } finally {
    client.release();
  }
}
