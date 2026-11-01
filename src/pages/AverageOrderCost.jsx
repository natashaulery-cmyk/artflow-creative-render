import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import PageHeader from '@/components/PageHeader';
import { useOrders } from '@/lib/useOrders';
import { formatMoney } from '@/lib/format';
import { averageOrderCost } from '@/lib/averageOrderCost';

export default function AverageOrderCost() {
  const { records, loading, reload } = useOrders();
  const [searchParams] = useSearchParams();
  const now = new Date();
  const monthKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
  const [month, setMonth] = useState(() => searchParams.get('period') === 'last3' ? '' : monthKey(new Date(now.getFullYear(), now.getMonth()-1, 1)));
  const monthKeys = new Set(records.map(order => String(order.sale_date || '').slice(0,7)).filter(value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value)));
  for (let i = 0; i <= now.getMonth(); i++) monthKeys.add(monthKey(new Date(now.getFullYear(),i,1)));
  monthKeys.add(monthKey(new Date(now.getFullYear(),now.getMonth()-1,1)));
  const months = [...monthKeys].sort().reverse();
  const costs = averageOrderCost(records, now, month);
  return <div className="space-y-5 pb-8">
    <PageHeader title="Average Order Cost" subtitle="Plan how much to set aside for supplies" />
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-2">
        <label htmlFor="order-cost-month" className="block text-sm font-medium">View costs for</label>
        <select id="order-cost-month" value={month} onChange={event => setMonth(event.target.value)} className="rounded-xl border bg-background px-3 py-2 text-sm max-w-full">
          {months.map(value => <option key={value} value={value}>{new Date(`${value}-01T12:00:00`).toLocaleDateString(undefined,{month:'long',year:'numeric'})}{value === monthKey(now) ? ' (so far)' : ''}</option>)}
          <option value="">Last 3 complete months</option>
        </select>
        <p className="text-xs text-muted-foreground">{costs.period}</p>
      </div>
      <button type="button" className="rounded-xl border px-4 py-2 text-sm" disabled={loading} onClick={() => reload()}>Refresh</button>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <section className="bg-card border rounded-3xl p-6">
        <h2 className="text-sm text-muted-foreground">Average cost per order</h2>
        <p className="text-3xl font-semibold mt-3">{loading || !costs.hasCosts ? '—' : formatMoney(costs.average)}</p>
        <p className="text-sm text-muted-foreground mt-2">Supply costs divided by {costs.count} orders</p>
      </section>
      <section className="bg-card border rounded-3xl p-6">
        <h2 className="text-sm text-muted-foreground">{month ? 'Resupply costs for this month' : 'Monthly resupply reserve'}</h2>
        <p className="text-3xl font-semibold mt-3">{loading || !costs.hasCosts ? '—' : formatMoney(costs.monthly)}</p>
        <p className="text-sm text-muted-foreground mt-2">{month ? 'Based on recorded supply costs in the selected month' : 'Estimated amount to set aside each month'}</p>
      </section>
    </div>
    <section className="bg-card border rounded-3xl overflow-hidden">
      <h2 className="font-semibold px-5 pt-5">Cost Breakdown by Size</h2>
      <div className="overflow-x-auto" data-no-tab-swipe="true">
        <table className="w-full text-sm text-left mt-3">
          <caption className="sr-only">Recorded order costs by size, {costs.period}</caption>
          <thead className="border-b text-muted-foreground"><tr>
            <th scope="col" className="p-4">Size</th><th scope="col" className="p-4 text-right">Orders</th>
            <th scope="col" className="p-4 text-right">Total Cost</th>
            <th scope="col" className="p-4 text-right">Avg. per Order</th>
            {!month && <th scope="col" className="p-4 text-right">Monthly Reserve</th>}
          </tr></thead>
          <tbody>{!loading && costs.sizes.map(row => <tr key={row.size} className="border-b">
            <th scope="row" className="p-4 whitespace-nowrap font-medium">{row.size}</th>
            <td className="p-4 text-right">{row.count}</td>
            <td className="p-4 text-right">{row.hasCosts ? formatMoney(row.total) : '—'}</td>
            <td className="p-4 text-right">{row.hasCosts ? formatMoney(row.average) : '—'}</td>
            {!month && <td className="p-4 text-right">{row.hasCosts ? formatMoney(row.monthly) : '—'}</td>}
          </tr>)}</tbody>
          <tfoot className="font-semibold bg-muted/40"><tr>
            <th scope="row" className="p-4">Total — All Sizes</th>
            <td className="p-4 text-right">{loading ? '—' : costs.count}</td>
            <td className="p-4 text-right">{loading || !costs.hasCosts ? '—' : formatMoney(costs.total)}</td>
            <td className="p-4 text-right">{loading || !costs.hasCosts ? '—' : formatMoney(costs.average)}</td>
            {!month && <td className="p-4 text-right">{loading || !costs.hasCosts ? '—' : formatMoney(costs.monthly)}</td>}
          </tr></tfoot>
        </table>
      </div>
      <p className="p-5 text-xs text-muted-foreground">Swipe the table sideways to see every column. A bundle with multiple sizes can appear in more than one size row; the total counts each order once.</p>
    </section>
    <section className="bg-card border rounded-3xl p-5 space-y-3 text-sm">
      <p>Total recorded order costs: <strong>{loading ? '—' : formatMoney(costs.total)}</strong></p>
      <p>Includes recorded frames, paper, ink and packaging costs. A selected month shows only that month’s costs. The three-month view divides its total costs by 3 to estimate a monthly reserve. General expenses are excluded to avoid counting supplies twice.</p>
      {!loading && !costs.count && <p>No orders found for this period.</p>}
      {!loading && costs.missing > 0 && <p role="status">{costs.missing} order rows have no positive cost recorded. The estimate may be low; add their costs before relying on this amount.</p>}
      <Link to="/inventory" className="inline-block underline">Review supply costs in Inventory</Link>
    </section>
  </div>;
}
