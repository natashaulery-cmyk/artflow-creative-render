import React, { useCallback, useEffect, useRef, useState } from "react";
import { Landmark, RefreshCw, Link2, Unlink, AlertCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

const PENDING_LINK = "artflow-bank-link-pending";
const asMoney = (value, currency = "USD") => value == null ? "Unavailable" :
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value));
const timeLabel = (value) => {
  if (!value) return "Not yet updated";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Update time unknown" : "Updated " + date.toLocaleString();
};
async function api(action, body = {}) {
  const response = await fetch("/api/bank-balances", {
    method: "POST", credentials: "include", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Bank request failed");
  return data;
}
function loadPlaid() {
  if (window.Plaid?.create) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-artflow-plaid="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Could not open secure bank connection")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.async = true;
    script.dataset.artflowPlaid = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load secure bank connection"));
    document.head.appendChild(script);
  });
}
export default function BankBalancesCard() {
  const [status, setStatus] = useState({ configured: false, connections: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const linkRef = useRef(null);
  const inFlight = useRef(false);

  const load = useCallback(async (force = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const response = await fetch("/api/bank-balances" + (force ? "?force=1" : ""), {
        credentials: "include", cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not refresh bank balances");
      setStatus(data);
      setError("");
    } catch (e) {
      setError(e.message || "Bank balances unavailable");
    } finally {
      inFlight.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const launchLink = useCallback(async (token, updateItemId = null, receivedRedirectUri = undefined) => {
    await loadPlaid();
    if (!window.Plaid?.create) throw new Error("Secure bank connection is unavailable");
    if (linkRef.current) linkRef.current.destroy?.();
    linkRef.current = window.Plaid.create({
      token,
      ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
      onSuccess: async (publicToken, metadata) => {
        try {
          sessionStorage.removeItem(PENDING_LINK);
          if (updateItemId) await api("reconnected", { item_id: updateItemId });
          else await api("exchange", {
            public_token: publicToken,
            institution: metadata?.institution?.name || "Bank",
          });
          toast.success("Bank connected", { description: "Balances update automatically when you use ArtFlow." });
          await load(true);
        } catch (e) {
          toast.error("Bank connection could not be saved", { description: e.message });
        } finally { setConnecting(false); }
      },
      onExit: (err) => {
        setConnecting(false);
        sessionStorage.removeItem(PENDING_LINK);
        if (err) toast.error("Bank connection closed", { description: err.display_message || err.error_message });
      },
    });
    linkRef.current.open();
  }, [load]);

  const connect = async (itemId = null) => {
    if (connecting) return;
    setConnecting(true);
    try {
      const data = await api("link_token", itemId ? { item_id: itemId } : {});
      sessionStorage.setItem(PENDING_LINK, JSON.stringify({ token: data.link_token, itemId }));
      await launchLink(data.link_token, itemId);
    } catch (e) {
      setConnecting(false);
      toast.error("Could not open bank connection", { description: e.message });
    }
  };

  const disconnect = async (itemId, name) => {
    if (!window.confirm("Disconnect " + name + " from ArtFlow? No money will move.")) return;
    try {
      await api("disconnect", { item_id: itemId });
      toast.success("Bank disconnected from ArtFlow");
      await load();
    } catch (e) { toast.error("Could not disconnect bank", { description: e.message }); }
  };

  useEffect(() => {
    load();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 5 * 60 * 1000);
    const onFocus = () => load();
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
      linkRef.current?.destroy?.();
    };
  }, [load]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const oauth = url.searchParams.has("oauth_state_id");
    if (!oauth) return;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(PENDING_LINK) || "null"); }
    catch { /* expired link session */ }
    if (pending?.token) {
      setConnecting(true);
      launchLink(pending.token, pending.itemId || null, window.location.href).catch((e) => {
        setConnecting(false);
        toast.error("Could not resume bank login", { description: e.message });
      });
    }
    url.searchParams.delete("oauth_state_id");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }, [launchLink]);

  const connections = status.connections || [];
  const hasConnections = connections.length > 0;
  return (
    <section className="bg-card rounded-3xl p-4 lg:p-5 border border-[hsl(var(--border))] space-y-3" aria-label="Bank balances">
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-2.5 items-center">
          <span className="w-10 h-10 rounded-2xl bg-muted flex justify-center items-center"><Landmark className="w-5 h-5" /></span>
          <div>
            <h2 className="font-heading font-semibold text-base">Bank Balances</h2>
            <p className="text-xs text-muted-foreground">Read-only · Automatically checks while ArtFlow is open</p>
          </div>
        </div>
        {hasConnections && <button type="button" onClick={() => load(true)} disabled={refreshing}
          className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center disabled:opacity-50"
          aria-label="Refresh bank balances">
          <RefreshCw className={"w-4 h-4" + (refreshing ? " animate-spin" : "")} />
        </button>}
      </div>

      {loading ? <p className="text-xs text-muted-foreground">Checking bank connections…</p> : null}
      {error && <div className="flex items-center gap-2 text-xs text-destructive"><AlertCircle className="w-4 h-4" />{error}</div>}
      {!loading && !status.configured && (
        <p className="text-xs text-muted-foreground">
          Bank linking needs secure Plaid account setup before it can be activated. No bank credentials are stored in ArtFlow.
        </p>
      )}
      {!loading && status.configured && !hasConnections && (
        <p className="text-sm text-muted-foreground">Connect your bank once to display checking and savings balances here.</p>
      )}
      {connections.map((connection) => (
        <div key={connection.item_id} className="rounded-2xl border border-[hsl(var(--border))] p-3.5 space-y-2.5">
          <div className="flex justify-between gap-3 items-center">
            <strong className="text-sm font-medium">{connection.institution}</strong>
            <span className="text-[11px] text-muted-foreground">{timeLabel(connection.refreshed_at)}</span>
          </div>
          {(connection.accounts || []).map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-3 py-1">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{account.name}{account.mask ? " ••••" + account.mask : ""}</p>
                <p className="text-xs text-muted-foreground capitalize">{account.subtype || account.type}</p>
              </div>
              <div className="text-right">
                <p className="text-lg font-heading font-semibold tabular-nums">{asMoney(account.available ?? account.current, account.currency)}</p>
                <p className="text-[10px] text-muted-foreground">Available balance</p>
              </div>
            </div>
          ))}
          {connection.last_error && <p className="text-xs text-amber-700 dark:text-amber-300">
            Bank update unavailable. Balances may be outdated.
          </p>}
          <div className="flex gap-4 pt-1">
            {connection.reconnect_required && <button type="button" onClick={() => connect(connection.item_id)}
              className="text-xs font-semibold underline">Reconnect bank</button>}
            <button type="button" onClick={() => disconnect(connection.item_id, connection.institution)}
              className="text-xs text-muted-foreground inline-flex items-center gap-1"><Unlink className="w-3.5 h-3.5" />Disconnect</button>
          </div>
        </div>
      ))}
      {status.configured && <button type="button" onClick={() => connect()} disabled={connecting}
        className="w-full min-h-11 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-2xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50">
        <Link2 className="w-4 h-4" />{connecting ? "Opening secure bank connection…" : hasConnections ? "Connect Another Bank" : "Connect Bank"}
      </button>}
      <p className="flex gap-1.5 items-center text-[11px] text-muted-foreground">
        <ShieldCheck className="w-3.5 h-3.5" /> No transfers, no transaction downloads, no repeat sign-in unless your bank requires it.
      </p>
    </section>
  );
}
