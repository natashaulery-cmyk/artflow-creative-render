import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Plus, Pencil, Trash2, Copy, Wallet, RefreshCw, Save, X } from "lucide-react";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { useEntity } from "@/lib/useBusinessData";
import { EXPENSE_CATEGORIES } from "@/lib/expenseCategories";
import { formatMoney, monthLabel } from "@/lib/format";
import { budgetSummary, localMonthKey, shiftMonth } from "@/lib/budgetMath";

const DEFAULT_FORM = { category: "", planned: "", manual_spent: "0" };
const SUGGESTED = [
  "Art Materials & Supplies", "Frames & Display", "Paper & Print Media",
  "Ink & Printing Supplies", "Packaging & Shipping Supplies",
  "Shipping & Postage", "Marketplace & Selling Fees",
  "Software & Subscriptions", "Groceries", "Bills", "Car Payment",
  "Savings", "Taxes", "Equipment", "Personal", "Other",
];
const suggestions = [...new Set([...SUGGESTED, ...EXPENSE_CATEGORIES])];

async function saveBudget(action, payload) {
  const response = await fetch("/api/budget", {
    method: "POST", cache: "no-store", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not save budget.");
  return data;
}

export default function Budget() {
  const [month, setMonth] = useState(() => localMonthKey());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [income, setIncome] = useState("0");
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [editingId, setEditingId] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const requestSeq = useRef(0);
  const { records: expenses = [], reload: reloadExpenses } = useEntity("Expense", "-date", 10000);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setRefreshing(true);
    try {
      const response = await fetch("/api/budget?month=" + encodeURIComponent(month), {
        credentials: "include", cache: "no-store",
      });
      const next = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(next.error || "Could not load your budget.");
      if (seq !== requestSeq.current) return;
      setData(next);
      setIncome(String(next.income_target ?? 0));
      setError("");
    } catch (e) {
      if (seq === requestSeq.current) setError(e.message || "Could not load budget.");
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [month]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setEditorOpen(false);
    refresh();
    return () => { requestSeq.current += 1; };
  }, [refresh]);

  const summary = useMemo(
    () => budgetSummary(data?.categories || [], expenses, month, data?.income_target || 0),
    [data, expenses, month]
  );

  const apply = async (action, values, message) => {
    if (busy) return false;
    setBusy(true);
    try {
      const next = await saveBudget(action, { month, ...values });
      setData(next);
      setIncome(String(next.income_target ?? 0));
      setError("");
      if (message) toast.success(message);
      return true;
    } catch (e) {
      toast.error("Budget not saved", { description: e.message });
      return false;
    } finally { setBusy(false); }
  };
  const saveIncome = async (event) => {
    event.preventDefault();
    await apply("set_income", { income_target: income }, "Income target saved");
  };
  const addCategory = () => {
    setForm({ ...DEFAULT_FORM });
    setEditingId(null);
    setEditorOpen(true);
  };
  const editCategory = (row) => {
    setForm({
      category: row.category,
      planned: String(row.planned),
      manual_spent: String(row.manual_spent),
    });
    setEditingId(row.id);
    setEditorOpen(true);
  };
  const saveCategory = async (event) => {
    event.preventDefault();
    const saved = await apply("save_category", { ...form, ...(editingId ? { id: editingId } : {}) },
      editingId ? "Budget category updated" : "Budget category added");
    if (saved) { setEditingId(null); setEditorOpen(false); setForm({ ...DEFAULT_FORM }); }
  };
  const deleteCategory = async (row) => {
    if (!window.confirm("Remove " + row.category + " from the " + monthLabel(month) + " budget? Your expense records will stay unchanged.")) return;
    const done = await apply("delete_category", { id: row.id }, "Budget category removed");
    if (done && editingId === row.id) setEditorOpen(false);
  };
  const copyPrevious = async () => {
    if (!window.confirm("Copy last month's income target and category limits? Existing entries in this month will not be replaced, and last month's spending will not be copied.")) return;
    await apply("copy_previous", {}, "Previous month's plan copied");
  };
  const reload = async () => {
    await Promise.allSettled([refresh(), reloadExpenses()]);
  };
  const update = (field, value) => setForm((v) => ({ ...v, [field]: value }));

  return (
    <div className="space-y-5 pt-4 lg:pt-0 pb-8">
      <PageHeader title="Budget" subtitle="Plan monthly spending, savings, and expenses" />
      <div className="bg-card rounded-3xl p-4 border border-[hsl(var(--border))] space-y-4">
        <div className="flex justify-between items-center gap-3">
          <button type="button" onClick={() => setMonth((m) => shiftMonth(m, -1))}
            aria-label="Previous month" className="h-10 w-10 flex justify-center items-center rounded-xl bg-muted"><ArrowLeft className="w-5 h-5" /></button>
          <div className="text-center">
            <h2 className="font-heading font-semibold">{monthLabel(month)}</h2>
            <p className="text-[11px] text-muted-foreground">Monthly plan</p>
          </div>
          <button type="button" onClick={() => setMonth((m) => shiftMonth(m, 1))}
            aria-label="Next month" className="h-10 w-10 flex justify-center items-center rounded-xl bg-muted"><ArrowRight className="w-5 h-5" /></button>
        </div>
        <form onSubmit={saveIncome} className="flex flex-wrap sm:flex-nowrap items-end gap-2">
          <label className="flex-1 min-w-[150px] text-xs font-semibold space-y-1">
            <span>Expected monthly income ($)</span>
            <input required type="text" inputMode="decimal" autoComplete="off"
              className="form-input w-full tabular-nums" placeholder="0.00" value={income}
              onChange={(e) => setIncome(e.target.value)} />
          </label>
          <button type="submit" disabled={busy || !data} className="h-11 px-5 rounded-xl bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
            <Save className="w-4 h-4" /> Save Income
          </button>
        </form>
        <p className="text-[11px] text-muted-foreground">Income is a planning estimate, not your bank balance or actual sales.</p>
      </div>

      {error && <p role="alert" className="bg-card border border-destructive/30 p-4 rounded-2xl text-destructive text-sm">{error}</p>}
      {loading ? <p className="text-sm text-muted-foreground text-center py-4">Loading budget…</p> : null}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Planned", value: summary.planned, detail: "Category limits" },
              { label: "Spent", value: summary.spent, detail: "Approved expenses + manual" },
              { label: "Still to allocate", value: summary.unallocated, detail: "Income target minus planned" },
              { label: "Left in budget", value: summary.budgetRemaining, detail: "Within category limits" },
            ].map((metric) => (
              <section key={metric.label} className="bg-card rounded-2xl border border-[hsl(var(--border))] p-4 min-w-0">
                <p className="text-[11px] text-muted-foreground">{metric.label}</p>
                <p className={"font-heading font-semibold text-xl mt-1 tabular-nums " + (metric.value < 0 ? "text-destructive" : "")}>{formatMoney(metric.value)}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{metric.detail}</p>
              </section>
            ))}
          </div>

          <section className="bg-card rounded-2xl p-4 border border-[hsl(var(--border))] flex items-start gap-3">
            <Wallet className="w-5 h-5 mt-1 text-[hsl(var(--primary))] shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Your manual bank balances</p>
              <p className="font-heading text-xl font-semibold tabular-nums mt-1">{data.bank_account_count ? formatMoney(data.bank_balance) : "No balances added yet"}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                These are manually entered snapshots. Budget entries do not withdraw or subtract money from your accounts.
              </p>
            </div>
            <Link to="/account" className="shrink-0 text-xs underline font-semibold">Edit</Link>
          </section>

          <section className="space-y-3">
            <div className="flex justify-between items-center gap-2">
              <div>
                <h2 className="font-heading text-lg font-semibold">Budget categories</h2>
                <p className="text-xs text-muted-foreground">Edit planned limits and additional spending.</p>
              </div>
              <button type="button" onClick={reload} disabled={refreshing} aria-label="Reload budget and expenses"
                className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center disabled:opacity-50">
                <RefreshCw className={"w-4 h-4 " + (refreshing ? "animate-spin" : "")} />
              </button>
            </div>
            {summary.rows.map((row) => {
              const pct = row.planned > 0 ? Math.min(100, Math.max(0, row.spent / row.planned * 100)) : (row.spent > 0 ? 100 : 0);
              return (
                <article key={row.id} className="bg-card border border-[hsl(var(--border))] rounded-2xl p-4 space-y-3">
                  <div className="flex justify-between items-start gap-3">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-sm">{row.category}</h3>
                      <p className="text-xs text-muted-foreground mt-1">Limit: {formatMoney(row.planned)}</p>
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <button type="button" onClick={() => editCategory(row)} aria-label={"Edit " + row.category}
                        className="h-9 w-9 rounded-xl bg-muted flex items-center justify-center"><Pencil className="w-4 h-4" /></button>
                      <button type="button" onClick={() => deleteCategory(row)} aria-label={"Delete " + row.category}
                        className="h-9 w-9 rounded-xl bg-muted flex items-center justify-center"><Trash2 className="w-4 h-4 text-destructive" /></button>
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div className={"h-full rounded-full " + (row.remaining < 0 ? "bg-red-500" : "bg-[hsl(var(--primary))]")}
                      style={{ width: pct + "%" }} />
                  </div>
                  <div className="flex items-end justify-between gap-2">
                    <div>
                      <p className="text-[10px] text-muted-foreground">Spent / set aside</p>
                      <p className="text-sm font-semibold tabular-nums">{formatMoney(row.spent)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-muted-foreground">{row.remaining < 0 ? "Over budget" : "Remaining"}</p>
                      <p className={"text-sm font-semibold tabular-nums " + (row.remaining < 0 ? "text-destructive" : "")}>{formatMoney(Math.abs(row.remaining))}</p>
                    </div>
                  </div>
                  {(row.automatic !== 0 || row.manual_spent !== 0) && <p className="text-[11px] text-muted-foreground">
                    {formatMoney(row.automatic)} from approved ArtFlow expenses · {formatMoney(row.manual_spent)} entered manually
                  </p>}
                </article>
              );
            })}
            {!summary.rows.length && !editorOpen && (
              <div className="bg-card border border-dashed border-[hsl(var(--border))] rounded-2xl p-5 text-sm text-muted-foreground">
                No category limits yet. Add one for supplies, shipping, bills, groceries, savings, or anything else.
              </div>
            )}
            {summary.unbudgetedExpenses !== 0 && <div className="bg-card border border-[hsl(var(--border))] rounded-2xl p-4 text-xs text-muted-foreground">
              <strong className="text-foreground">{formatMoney(summary.unbudgetedExpenses)}</strong> in approved ArtFlow expenses is not assigned to a category limit yet. This spending is included in the total Spent above.
              <Link to="/expenses" className="ml-2 underline">View expenses</Link>
            </div>}

            {!editorOpen ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button onClick={addCategory} type="button"
                  className="h-11 rounded-2xl bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-sm font-semibold flex items-center justify-center gap-2">
                  <Plus className="w-4 h-4" /> Add Category
                </button>
                <button onClick={copyPrevious} type="button" disabled={busy}
                  className="h-11 rounded-2xl bg-muted text-foreground text-sm font-semibold flex justify-center items-center gap-2 disabled:opacity-50">
                  <Copy className="w-4 h-4" /> Copy Previous Month
                </button>
              </div>
            ) : (
              <form onSubmit={saveCategory} className="bg-card rounded-2xl border border-[hsl(var(--border))] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold text-sm">{editingId ? "Edit Category" : "Add Budget Category"}</h3>
                  <button type="button" onClick={() => setEditorOpen(false)} aria-label="Close category form"
                    className="w-9 h-9 rounded-xl bg-muted flex justify-center items-center"><X className="w-4 h-4" /></button>
                </div>
                <label className="block text-xs font-semibold space-y-1">
                  <span>Category</span>
                  <input list="budget-category-suggestions" required maxLength={80} autoComplete="off"
                    className="form-input w-full" placeholder="e.g. Frames & Display, Savings, Groceries"
                    value={form.category} onChange={(e) => update("category", e.target.value)} />
                  <datalist id="budget-category-suggestions">
                    {suggestions.map((item) => <option key={item} value={item} />)}
                  </datalist>
                </label>
                <label className="block text-xs font-semibold space-y-1">
                  <span>Monthly limit ($)</span>
                  <input required type="text" inputMode="decimal" className="form-input w-full tabular-nums"
                    placeholder="0.00" value={form.planned} onChange={(e) => update("planned", e.target.value)} />
                </label>
                <label className="block text-xs font-semibold space-y-1">
                  <span>Extra spent or saved manually ($)</span>
                  <input required type="text" inputMode="decimal" className="form-input w-full tabular-nums"
                    value={form.manual_spent} onChange={(e) => update("manual_spent", e.target.value)} />
                </label>
                <p className="text-xs text-muted-foreground">
                  Approved ArtFlow expenses in this exact category are counted automatically.
                  Enter only additional spending not already recorded in Expenses to avoid double counting.
                  For Savings, enter the amount you've actually set aside.
                </p>
                <button type="submit" disabled={busy}
                  className="w-full h-11 rounded-2xl bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50">
                  <Save className="w-4 h-4" /> {busy ? "Saving…" : "Save Category"}
                </button>
              </form>
            )}
          </section>
        </>
      )}
    </div>
  );
}
