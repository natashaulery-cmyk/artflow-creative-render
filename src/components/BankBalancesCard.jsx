import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Landmark, Plus, Pencil, Trash2, RefreshCw, X, Save } from "lucide-react";
import { toast } from "sonner";

const blankAccount = {
  bank_name: "",
  account_name: "",
  account_type: "checking",
  balance: "",
};
const money = (amount) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
}).format(Number(amount) || 0);

async function request(action, payload = {}) {
  const response = await fetch("/api/bank-balances", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not save your account.");
  return data;
}

export default function BankBalancesCard() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankAccount);
  const [error, setError] = useState("");

  const total = useMemo(
    () => accounts.reduce((sum, account) => sum + (Number(account.balance) || 0), 0),
    [accounts]
  );

  const load = useCallback(async () => {
    setReloading(true);
    try {
      const response = await fetch("/api/bank-balances", {
        credentials: "include", cache: "no-store",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not load balances.");
      setAccounts(Array.isArray(result.accounts) ? result.accounts : []);
      setError("");
    } catch (e) {
      setError(e.message || "Could not load balances.");
    } finally {
      setLoading(false);
      setReloading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const onActive = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onActive);
    return () => document.removeEventListener("visibilitychange", onActive);
  }, [load]);

  const startCreate = () => {
    setForm({ ...blankAccount });
    setEditingId(null);
    setEditorOpen(true);
  };
  const startEdit = (account) => {
    setForm({
      bank_name: account.bank_name || "",
      account_name: account.account_name || "",
      account_type: account.account_type || "checking",
      balance: Number(account.balance).toFixed(2),
    });
    setEditingId(account.id);
    setEditorOpen(true);
  };
  const closeEditor = () => {
    setEditorOpen(false);
    setEditingId(null);
  };
  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const data = await request(editingId ? "update" : "create", {
        ...(editingId ? { id: editingId } : {}),
        ...form,
      });
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
      setError("");
      closeEditor();
      toast.success(editingId ? "Balance updated" : "Account added");
    } catch (e) {
      toast.error("Could not save balance", { description: e.message });
    } finally {
      setSaving(false);
    }
  };
  const remove = async (account) => {
    const title = account.account_name || account.bank_name || "this account";
    if (!window.confirm("Remove " + title + " from ArtFlow? This does not affect your bank.")) return;
    try {
      const data = await request("delete", { id: account.id });
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
      if (editingId === account.id) closeEditor();
      toast.success("Manual account removed");
    } catch (e) {
      toast.error("Could not remove account", { description: e.message });
    }
  };

  return (
    <section className="bg-card rounded-3xl p-4 lg:p-5 border border-[hsl(var(--border))] space-y-4" aria-label="Manual bank balances">
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-3 items-center">
          <div className="w-10 h-10 rounded-2xl bg-muted flex items-center justify-center shrink-0">
            <Landmark className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-heading text-base font-semibold">Bank Balances</h2>
            <p className="text-xs text-muted-foreground">Manual tracking · No bank connection or fees</p>
          </div>
        </div>
        <button type="button" onClick={load} disabled={reloading}
          title="Reload saved balances" aria-label="Reload saved balances"
          className="w-10 h-10 rounded-xl bg-muted flex justify-center items-center disabled:opacity-50">
          <RefreshCw className={reloading ? "w-4 h-4 animate-spin" : "w-4 h-4"} />
        </button>
      </div>

      {accounts.length > 0 && (
        <div className="rounded-2xl bg-muted/50 p-4">
          <p className="text-xs text-muted-foreground">Total balances entered</p>
          <p className="font-heading text-2xl font-bold mt-1 tabular-nums">{money(total)}</p>
        </div>
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading your saved balances…</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {!loading && accounts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Add your checking or savings balance. Enter the amount whenever it changes.
        </p>
      )}
      {accounts.map((account) => (
        <div key={account.id} className="rounded-2xl border border-[hsl(var(--border))] p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground truncate">{account.bank_name}</p>
              <p className="text-sm font-semibold truncate">{account.account_name}</p>
              <p className="text-xs text-muted-foreground capitalize">{account.account_type}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="font-heading text-xl font-semibold tabular-nums">{money(account.balance)}</p>
              <p className="text-[10px] text-muted-foreground">Manually entered</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-[hsl(var(--border))]">
            <p className="text-[10px] text-muted-foreground">
              Updated {account.updated_at ? new Date(account.updated_at).toLocaleDateString() : "—"}
            </p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => startEdit(account)}
                className="min-h-9 px-3 rounded-xl bg-muted text-xs font-semibold flex items-center gap-1.5">
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
              <button type="button" onClick={() => remove(account)}
                aria-label={"Remove " + account.account_name}
                className="w-9 h-9 flex justify-center items-center rounded-xl bg-muted">
                <Trash2 className="w-4 h-4 text-destructive" />
              </button>
            </div>
          </div>
        </div>
      ))}

      {!editorOpen ? (
        <button type="button" onClick={startCreate}
          className="w-full min-h-11 rounded-2xl bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] font-semibold text-sm flex justify-center items-center gap-2">
          <Plus className="w-4 h-4" /> Add Account
        </button>
      ) : (
        <form onSubmit={save} className="rounded-2xl border border-[hsl(var(--border))] p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{editingId ? "Edit Balance" : "Add Manual Account"}</h3>
            <button type="button" onClick={closeEditor} aria-label="Close account form"
              className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center">
              <X className="w-4 h-4" />
            </button>
          </div>
          <label className="block text-xs font-semibold space-y-1">
            <span>Bank name</span>
            <input type="text" maxLength={80} required autoComplete="off"
              placeholder="e.g. My Bank"
              className="form-input w-full"
              value={form.bank_name}
              onChange={(e) => setForm((v) => ({ ...v, bank_name: e.target.value }))} />
          </label>
          <label className="block text-xs font-semibold space-y-1">
            <span>Account name</span>
            <input type="text" maxLength={80} required autoComplete="off"
              placeholder="e.g. Business Checking"
              className="form-input w-full"
              value={form.account_name}
              onChange={(e) => setForm((v) => ({ ...v, account_name: e.target.value }))} />
          </label>
          <label className="block text-xs font-semibold space-y-1">
            <span>Account type</span>
            <select className="form-input w-full" value={form.account_type}
              onChange={(e) => setForm((v) => ({ ...v, account_type: e.target.value }))}>
              <option value="checking">Checking</option>
              <option value="savings">Savings</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="block text-xs font-semibold space-y-1">
            <span>Current balance ($)</span>
            <input type="text" inputMode="decimal" required autoComplete="off"
              placeholder="0.00"
              className="form-input w-full tabular-nums"
              value={form.balance}
              onChange={(e) => setForm((v) => ({ ...v, balance: e.target.value }))} />
          </label>
          <p className="text-xs text-muted-foreground">
            Enter amounts yourself. ArtFlow saves them securely with your account and does not contact your bank.
          </p>
          <button type="submit" disabled={saving}
            className="w-full min-h-11 rounded-2xl bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50">
            <Save className="w-4 h-4" /> {saving ? "Saving…" : "Save Balance"}
          </button>
        </form>
      )}
    </section>
  );
}
