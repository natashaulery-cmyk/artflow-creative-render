import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthContext";

export const TRACKABLE_MARKETPLACES = ["Vinted", "Depop", "eBay", "Poshmark", "Facebook Marketplace", "Mercari"];

const normalizeSelection = (items = []) =>
  TRACKABLE_MARKETPLACES.filter((name) => Array.isArray(items) && items.includes(name));

export function useMarketplacePreferences() {
  const { user } = useAuth();
  const [selected, setSelected] = useState([]);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const response = await fetch("/api/marketplace-preferences", {
        credentials: "include",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not load marketplace choices");
      setSelected(normalizeSelection(data.selected));
      setConfigured(Boolean(data.configured));
    } catch (error) {
      console.error("Could not load marketplace preferences", error);
      setSelected([]);
      setConfigured(false);
    } finally {
      setLoading(false);
    }
  }, [user]);

  const save = useCallback(async (nextSelection) => {
    const next = normalizeSelection(nextSelection);
    if (!user) return next;

    const response = await fetch("/api/marketplace-preferences", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected: next }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not save marketplace choices");
    setSelected(normalizeSelection(data.selected));

    setConfigured(true);
    window.dispatchEvent(new CustomEvent("artflow:marketplaces-changed", { detail: { selected: next } }));
    return next;
  }, [user]);

  useEffect(() => {
    load();
    const onChanged = () => load();
    window.addEventListener("artflow:marketplaces-changed", onChanged);
    return () => window.removeEventListener("artflow:marketplaces-changed", onChanged);
  }, [load]);

  return { selected, configured, loading, save, reload: load, supported: TRACKABLE_MARKETPLACES };
}
