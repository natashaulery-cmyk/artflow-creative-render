import React, { useEffect, useState } from "react";
import { Check, Loader2, Store } from "lucide-react";
import { useMarketplacePreferences } from "@/lib/useMarketplacePreferences";
import { toast } from "sonner";

const SITE_HELP = {
  Vinted: "Sync Vinted orders and sales",
  Depop: "Sync Depop orders and sales",
  eBay: "Sync eBay orders and sales",
  Poshmark: "Sync Poshmark orders and sales",
  "Facebook Marketplace": "Track Facebook Marketplace / Seller app sales. Add completed sales in Orders.",
  Mercari: "Track Mercari sales automatically from a connected Gmail inbox, or add a sale manually.",
};

export default function MarketplaceTrackingCard() {
  const { selected, loading, save, supported } = useMarketplacePreferences();
  const [draft, setDraft] = useState([]);
  const [savingSite, setSavingSite] = useState("");

  useEffect(() => {
    setDraft(selected);
  }, [selected.join("|")]);

  const toggleAndSave = async (name) => {
    if (savingSite) return;
    const wasActive = draft.includes(name);
    const next = wasActive
      ? draft.filter((item) => item !== name)
      : [...draft, name];

    setDraft(next);
    setSavingSite(name);
    try {
      await save(next);
      const action = ["Facebook Marketplace", "Mercari"].includes(name) ? "tracking" : "sync";
      toast.success(wasActive ? `${name} ${action} turned off` : `${name} selected for ${action}`);
    } catch (error) {
      setDraft(draft);
      toast.error(`Could not update ${name}`, { description: error?.message });
    } finally {
      setSavingSite("");
    }
  };

  return (
    <section className="bg-card rounded-3xl p-5 border border-[hsl(var(--border))] space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-2xl pastel-blue flex items-center justify-center shrink-0">
          <Store className="w-5 h-5" />
        </div>
        <div>
          <h2 className="font-heading text-lg">Marketplaces</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Choose the marketplaces you use to track your sales.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((n) => <div key={n} className="h-16 rounded-2xl bg-muted animate-pulse" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {supported.map((name) => {
            const active = draft.includes(name);
            const saving = savingSite === name;
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggleAndSave(name)}
                disabled={Boolean(savingSite)}
                aria-pressed={active}
                className={`min-h-20 rounded-2xl border p-3 text-left transition-colors disabled:opacity-70 ${
                  active
                    ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10"
                    : "border-[hsl(var(--border))] bg-muted/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm">{name}</span>
                  <span className={`w-7 h-7 rounded-full flex items-center justify-center ${active ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]" : "bg-background border border-[hsl(var(--border))]"}`}>
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : active ? <Check className="w-4 h-4" /> : null}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{SITE_HELP[name]}</p>
                <p className={`text-[11px] font-semibold mt-2 ${active ? "text-[hsl(var(--primary))]" : "text-muted-foreground"}`}>
                  {saving ? "Saving…" : ["Facebook Marketplace", "Mercari"].includes(name) ? (active ? "Tracking on" : "Tap to track") : active ? "Sync on" : "Tap to sync"}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
