const sizeLabel = value => String(value || '').trim().toLowerCase()
  .replace(/[×✕]/g, 'x').replace(/\s*x\s*/g, 'x').replace(/\s+/g, ' ') || 'Size not recorded';
const key = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-01`;
const emptyGroup = size => ({ size, total: 0, missing: 0, rows: 0, ids: new Set() });
const summarize = group => ({ size: group.size, total: group.total,
  count: group.ids.size, average: group.ids.size ? group.total/group.ids.size : 0,
  monthly: group.total/3, missing: group.missing, hasCosts: group.rows > group.missing });

// Completed months keep a partial current month from depressing the reserve.
export function averageOrderCost(orders, now = new Date()) {
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = new Date(now.getFullYear(), now.getMonth()-3, 1);
  const totals = emptyGroup('All sizes');
  const sizes = new Map();
  const seen = new Set();
  for (const [i,order] of orders.entries()) {
    const date = String(order.sale_date || '').slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < key(start) || date >= key(end) || order.archived ||
      /^(cancelled|canceled|refunded)$/i.test(String(order.status || ''))) continue;
    // Retain separate bundle lines but ignore a repeated copy of the same record.
    if (order.id && seen.has(order.id)) continue;
    if (order.id) seen.add(order.id);
    const identity = `${order.platform || ''}:${order.order_id || order.source_email_id || order.id || i}`;
    const size = sizeLabel(order.size);
    if (!sizes.has(size)) sizes.set(size, emptyGroup(size));
    const cost = Number(order.total_cost);
    const hasCost = Number.isFinite(cost) && cost > 0;
    for (const group of [totals, sizes.get(size)]) {
      group.ids.add(identity);
      group.rows++;
      if (hasCost) group.total += cost;
      else group.missing++;
    }
  }
  return { ...summarize(totals), sizes: [...sizes.values()].map(summarize)
    .sort((a,b)=>a.size.localeCompare(b.size,undefined,{numeric:true})),
    period: `${start.toLocaleDateString(undefined,{month:'short',year:'numeric'})} – ${new Date(end.getFullYear(),end.getMonth(),0).toLocaleDateString(undefined,{month:'short',year:'numeric'})}` };
}
