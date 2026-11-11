import React, { useEffect, useMemo, useState } from "react";
import { ExternalLink, Link2, Loader2, Save } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { toast } from "sonner";

const MARKETPLACES = ["eBay", "Depop", "Vinted", "Poshmark", "Facebook Marketplace", "Mercari"];

const PLACEHOLDERS = {
  eBay: "https://www.ebay.com/usr/yourstore",
  Depop: "https://www.depop.com/yourshop/",
  Vinted: "https://www.vinted.com/member/yourshop",
  Poshmark: "https://poshmark.com/closet/yourshop",
  "Facebook Marketplace": "https://www.facebook.com/marketplace/profile/yourprofile",
  Mercari: "https://www.mercari.com/u/yourprofile/",
};

const emptyLinks = () => Object.fromEntries(MARKETPLACES.map((name) => [name, ""]));

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only website links are allowed");
  return parsed.toString();
}

function normalizeLinks(value) {
  const next = emptyLinks();
  if (!value || typeof value !== "object") return next;
  for (const name of MARKETPLACES) next[name] = String(value[name] || "");
  return next;
}

export default function MarketplaceLinksCard() {
  const { user } = useAuth();
  const [links, setLinks] = useState(emptyLinks);
  const [savedLinks, setSavedLinks] = useState(emptyLinks);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!user) return;
      setLoading(true);
      try {
        const response = await fetch("/api/marketplace-preferences", {
          credentials: "include",
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not load marketplace links");
        const loaded = normalizeLinks(data.links);
        if (!cancelled) {
          setLinks(loaded);
          setSavedLinks(loaded);
        }
      } catch (error) {
        console.error("Could not load marketplace links", error);
        if (!cancelled) toast.error("Could not load marketplace links");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [user]);

  const dirty = useMemo(
    () => MARKETPLACES.some((name) => String(links[name] || "").trim() !== String(savedLinks[name] || "").trim()),
    [links, savedLinks]
  );

  const saveLinks = async () => {
    if (!user || saving) return;
    const normalized = emptyLinks();
    try {
      for (const name of MARKETPLACES) normalized[name] = normalizeUrl(links[name]);
    } catch {
      toast.error("Check the marketplace links", { description: "Each saved link must be a valid website address." });
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/marketplace-preferences", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links: normalized }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save marketplace links");
      const saved = normalizeLinks(data.links);
      setLinks(saved);
      setSavedLinks(saved);
      toast.success("Marketplace links saved");
    } catch (error) {
      toast.error("Could not save marketplace links", { description: error?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-card rounded-3xl p-5 border border-[hsl(var(--border))] space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-2xl pastel-lavender flex items-center justify-center shrink-0">
          <Link2 className="w-5 h-5" />
        </div>
        <div>
          <h2 className="font-heading text-lg">Marketplace Links</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Paste the exact shop or listing link you want to open. These are simple saved links — no API or marketplace login is required.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((n) => <div key={n} className="h-14 rounded-2xl bg-muted animate-pulse" />)}
        </div>
      ) : (
        <div className="space-y-3">
          {MARKETPLACES.map((name) => {
            const openUrl = String(savedLinks[name] || "").trim();
            return (
              <div key={name}>
                <label className="text-sm font-semibold block mb-1.5">{name}</label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={links[name] || ""}
                    onChange={(e) => setLinks((current) => ({ ...current, [name]: e.target.value }))}
                    placeholder={PLACEHOLDERS[name]}
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="form-input flex-1 min-w-0"
                  />
                  {openUrl && (
                    <a
                      href={openUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center shrink-0 active:scale-[0.98] transition-transform"
                      aria-label={`Open ${name}`}
                      title={`Open ${name}`}
                    >
                      <ExternalLink className="w-5 h-5" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={saveLinks}
        disabled={loading || saving || !dirty}
        className="w-full h-12 rounded-2xl bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] font-semibold flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.98] transition-transform"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        {saving ? "Saving…" : "Save Marketplace Links"}
      </button>
    </section>
  );
}
