// A one-off cron service entrypoint for Railway. Set a service's start
// command to: node scripts/railway-cron.mjs gmail-sales-cron
// Requires CRON_SECRET and ARTFLOW_CRON_TARGET_URL on each cron service.
const jobs = new Set([
  'gmail-sales-cron', 'marketplace-orders-cron',
  'yahoo-mail-cron', 'gmail-expense-cron',
]);
const job = process.argv[2];
const secret = String(process.env.CRON_SECRET || '');
const origin = String(process.env.ARTFLOW_CRON_TARGET_URL || '');
if (!jobs.has(job) || !secret || !/^https:\/\//i.test(origin)) {
  console.error('Missing or invalid job, CRON_SECRET, or HTTPS ARTFLOW_CRON_TARGET_URL');
  process.exitCode = 1;
} else {
  try {
    const url = new URL('/api/' + job, origin);
    const response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + secret },
      signal: AbortSignal.timeout(110000),
    });
    const result = await response.text();
    console.log(job + ': ' + response.status + ' ' + result.slice(0, 1000));
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    console.error(job + ' failed:', error?.message || error);
    process.exitCode = 1;
  }
}
