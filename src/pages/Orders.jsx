import React, { useState, useMemo, useEffect } from "react";
import { Search, Plus, RefreshCw, ExternalLink, Smartphone, Image as ImageIcon } from "lucide-react";
import { useEntity } from "@/lib/useBusinessData";
import { useOrders } from "@/lib/useOrders";
import { formatMoney, formatDate, currentMonthKey, monthShort } from "@/lib/format";
import { EmptyRow } from "@/components/Cards";
import OrderForm from "@/components/OrderForm";
import ProfitScoreBadge from "@/components/ProfitScoreBadge";
import PageHeader from "@/components/PageHeader";
import { useModalRoute } from "@/hooks/useModalRoute";
import { useLocation, useNavigate } from "react-router-dom";
import PullToRefresh from "@/components/PullToRefresh";
import SyncStatus from "@/components/SyncStatus";
import { PLATFORM_TONE, displayPlatform, displayProductName, orderSourceUrl, mercariArtworkUrl } from "@/lib/platforms";
import { useMarketplacePreferences } from "@/lib/useMarketplacePreferences";
import { toast } from "sonner";

const hasRecordedSaleAmount = (order) => {
  const sale = Number(order?.sale_total);
  return Number.isFinite(sale) && sale > 0;
};

const directImageUrl = (item = {}) =>
  item?.image_url ||
  item?.product_image_url ||
  item?.marketplace_image_url ||
  item?.thumbnail_url ||
  item?.photo_url ||
  item?.data?.image_url ||
  item?.data?.product_image_url ||
  item?.data?.marketplace_image_url ||
  item?.data?.thumbnail_url ||
  item?.data?.photo_url ||
  "";

function OrderThumbnail({ src, alt }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  return (
    <div className="w-20 h-20 rounded-2xl overflow-hidden shrink-0 border border-[hsl(var(--border))] bg-muted flex items-center justify-center">
      {src && !failed ? (
        <img
          src={src}
          alt={alt || "Order artwork"}
          loading="lazy"
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <ImageIcon className="w-6 h-6 text-muted-foreground/60" />
      )}
    </div>
  );
}

export default function Orders() {
  const { records: orders, reload: reloadOrders, setOrderShipped } = useOrders();
  const { selected: trackedSites, configured: sitesConfigured, loading: sitesLoading } = useMarketplacePreferences();
  // Connection preferences decide which marketplaces sync; they do not remove
  // historical sales that are already part of the business ledger.
  const activeOrders = orders.filter((order) => displayPlatform(order.platform) !== "Legacy");
  const { records: inventoryCosts } = useEntity("InventoryCost", "size");
  const refresh = async () => {
    await reloadOrders();
  };
  const { pathname, search: locationSearch } = useLocation();
  const navigate = useNavigate();
  const [platformFilter, setPlatformFilter] = useState("All");
  const [monthFilter, setMonthFilter] = useState("All");
  const [search, setSearch] = useState("");
  // This tab stays mounted between visits. Reset it to the newest month whenever
  // the user opens Orders so an older selection such as January cannot persist.
  useEffect(() => {
    if (pathname === "/orders") {
      setMonthFilter("All");
      setPlatformFilter("All");
      setSearch(new URLSearchParams(locationSearch).get("search") || "");
      reloadOrders();
    }
  }, [pathname, locationSearch, reloadOrders]);
  const { isOpen: formOpen, open: openForm, close: closeForm } = useModalRoute();
  const [importingEmail, setImportingEmail] = useState(false);
  const [updatingShipment, setUpdatingShipment] = useState(() => new Set());

  const updateShipment = async (order, shipped) => {
    const id = order?.id || order?.base44_id;
    if (!id) return;
    setUpdatingShipment((current) => new Set(current).add(id));
    try {
      await setOrderShipped(id, shipped);
    } catch (error) {
      toast.error("Couldn’t update shipping status", {
        description: error?.message || "Please try again.",
      });
    } finally {
      setUpdatingShipment((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const hasLegacyFacebookLogo = useMemo(
    () => activeOrders.some((order) =>
      displayPlatform(order?.platform) === "Facebook Marketplace"
      && /facebook_icon\.png|\/images\/email\/facebook_/i.test(String(directImageUrl(order) || ""))
    ),
    [activeOrders]
  );

  useEffect(() => {
    if (pathname !== "/orders" || !hasLegacyFacebookLogo) return;
    const key = "artflow_facebook_image_repair_v2";
    if (sessionStorage.getItem(key) === "1") return;
    sessionStorage.setItem(key, "1");

    (async () => {
      try {
        const response = await fetch("/api/gmail-sales-sync", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        });
        if (!response.ok) {
          sessionStorage.removeItem(key);
          return;
        }
        await reloadOrders();
      } catch {
        sessionStorage.removeItem(key);
      }
    })();
  }, [pathname, hasLegacyFacebookLogo, reloadOrders]);

  const importEmailSales = async () => {
    setImportingEmail(true);
    try {
      const runSync = async (url, body = null) => {
        const response = await fetch(url, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        return { response, data: await response.json().catch(() => ({})) };
      };

      const gmail = await runSync("/api/gmail-sales-sync", { force: true });
      const yahoo = await runSync("/api/yahoo-mail", { action: "sync" });
      const ebay = await runSync("/api/ebay-official", { action: "sync" });
      const results = [gmail, yahoo, ebay];

      const hardFailure = results.find(
        ({ response }) => !response.ok && ![400, 409].includes(response.status)
      );
      if (hardFailure) {
        throw new Error(hardFailure.data?.error || "Sales sync failed");
      }

      await reloadOrders();

      const ebaySaved = Number(ebay.data?.saved || 0);
      if (ebaySaved > 0) {
        toast.success("Sales are up to date", {
          description: `${ebaySaved} new eBay order${ebaySaved === 1 ? "" : "s"} imported.`,
        });
      } else if (results.some(({ response }) => response.ok)) {
        toast.success("Sales are up to date", {
          description: "Gmail, Yahoo, and eBay were checked.",
        });
      } else {
        const message = results
          .map(({ data }) => data?.error)
          .find(Boolean);
        toast.info(message || "No connected sales source needed an update.");
      }
    } catch (e) {
      toast.error("Sales sync failed", { description: e?.message });
    } finally {
      setImportingEmail(false);
    }
  };

  // Build the month list from real order history (plus the current month),
  // sorted newest-first so the most recent month — August — always leads
  // instead of a hardcoded January start.
  const months = useMemo(() => {
    const set = new Set([currentMonthKey()]);
    activeOrders.forEach((o) => {
      if (o.sale_date) set.add(o.sale_date.slice(0, 7));
    });
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [activeOrders]);

  const isBundle = (o) => /bundle/i.test(o.product_name || "");
  const visiblePlatformTabs = useMemo(() => {
    const tracked = (trackedSites || []).map((platform) => displayPlatform(platform)).filter((platform) => platform !== "Legacy");
    const actual = activeOrders.map((order) => displayPlatform(order.platform)).filter((platform) => platform !== "Legacy");
    return Array.from(new Set([...tracked, ...actual]));
  }, [trackedSites, activeOrders]);

  const platformCounts = useMemo(() => {
    const counts = {};
    activeOrders.forEach((order) => {
      const platform = displayPlatform(order.platform);
      counts[platform] = (counts[platform] || 0) + 1;
    });
    return counts;
  }, [activeOrders]);

  const choosePlatform = (platform) => {
    setPlatformFilter(platform);
    setMonthFilter("All");
    setSearch("");
  };

  const imageForOrder = React.useCallback((order) => {
    const bundleOrder =
      /\bbundle\b/i.test(String(order?.product_name || "")) ||
      Number(order?.quantity || 1) > 1;

    if (bundleOrder) return "/bundle-placeholder.svg";

    const direct = String(directImageUrl(order) || "").trim();
    const platform = displayPlatform(order?.platform);
    const listing = String(order?.source_url || "").trim();

    if (platform === "Mercari") return mercariArtworkUrl(order, direct);

    if (platform === "Facebook Marketplace") {
      const isFacebookImage = /^https:\/\/(?:[^/]+\.)?(?:fbcdn\.net|facebook\.com)\//i.test(direct);
      const isFacebookListing = /^https:\/\/(?:[^/]+\.)?facebook\.com\/marketplace\//i.test(listing);

      if (isFacebookImage) {
        const params = new URLSearchParams({ image: direct });
        if (isFacebookListing) params.set("listing", listing);
        return `/api/listing-image?${params.toString()}`;
      }

      if (direct) return direct;
      return "";
    }

    if (platform === "eBay") {
      const badGraphic =
        /ebaystatic\.com|app[ _-]?store|google[ _-]?play|download[^/ ]*app/i.test(direct);

      // eBay CDN images frequently reject direct browser hotlinking. Route
      // real ebayimg.com thumbnails through our existing safe image proxy.
      if (!badGraphic && /^https:\/\/(?:[^/]+\.)?ebayimg\.com\//i.test(direct)) {
        const params = new URLSearchParams({ image: direct });
        if (/^https:\/\/(?:[^/]+\.)?ebay\.com\/.*\/itm\//i.test(listing)) {
          params.set("listing", listing);
        }
        return `/api/listing-image?${params.toString()}`;
      }

      if (/^https:\/\/(?:[^/]+\.)?ebay\.com\/.*\/itm\//i.test(listing)) {
        return `/api/listing-image?listing=${encodeURIComponent(listing)}`;
      }

      if (direct && !badGraphic) return direct;
      return "";
    }

    return direct || "";
  }, []);

  const filtered = useMemo(() => {
    return activeOrders
      .filter((o) => {
        if (platformFilter === "Bundles") {
          if (!isBundle(o)) return false;
        } else if (platformFilter !== "All" && displayPlatform(o.platform) !== platformFilter) return false;
        if (monthFilter !== "All" && (o.sale_date || "").slice(0, 7) !== monthFilter) return false;
        if (search) {
          const q = search.toLowerCase();
          if (!`${o.product_name} ${o.order_id || ""}`.toLowerCase().includes(q))
            return false;
        }
        return true;
      })
      .sort((a, b) => (b.sale_date || "").localeCompare(a.sale_date || ""))
      .map((order) => ({
        ...order,
        display_image_url: imageForOrder(order),
      }));
  }, [activeOrders, platformFilter, monthFilter, search, imageForOrder]);

  const summary = useMemo(() => {
    const completedSales = filtered.filter(hasRecordedSaleAmount);
    const sales = completedSales.reduce((s, o) => s + Number(o.sale_total || 0), 0);
    const profit = completedSales.reduce((s, o) => s + Number(o.estimated_profit || 0), 0);
    const count = filtered.length;
    return { sales, profit, count };
  }, [filtered]);

  return (
    <div className="space-y-5">
      <PullToRefresh onRefresh={refresh} />
      <PageHeader title="Orders" subtitle="Sold items across platforms" />
      <SyncStatus totalOrders={activeOrders.length} />

      <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
        <button
          onClick={() => setMonthFilter("All")}
          className={`px-4 h-9 rounded-full text-sm font-medium shrink-0 ${
            monthFilter === "All"
              ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
              : "bg-muted text-foreground"
          }`}
        >
          All months
        </button>
        {months.map((m) => (
          <button
            key={m}
            onClick={() => setMonthFilter(m)}
            className={`px-4 h-9 rounded-full text-sm font-medium shrink-0 ${
              monthFilter === m
                ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                : "bg-muted text-foreground"
            }`}
          >
            {monthShort(m)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="pastel-lavender rounded-2xl p-4 border border-[hsl(var(--border))]">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase">Sales</p>
          <p className="font-heading text-lg mt-1 text-foreground">{formatMoney(summary.sales)}</p>
        </div>
        <div className="pastel-blue rounded-2xl p-4 border border-[hsl(var(--border))]">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase">Orders</p>
          <p className="font-heading text-lg mt-1 text-foreground">{summary.count}</p>
        </div>
        <div className="pastel-mint rounded-2xl p-4 border border-[hsl(var(--border))]">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase">Profit</p>
          <p className="font-heading text-lg mt-1 text-foreground">{formatMoney(summary.profit)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <button
          onClick={() => navigate("/send-sale")}
          className="w-full h-12 rounded-2xl bg-muted text-foreground flex items-center justify-center gap-2 text-sm font-semibold"
        >
          <Smartphone className="w-4 h-4" />
          Send Sale from Phone / iPad
        </button>

        <button
          onClick={importEmailSales}
          disabled={importingEmail}
          className="w-full h-12 rounded-2xl bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] flex items-center justify-center gap-2 text-sm font-semibold disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${importingEmail ? "animate-spin" : ""}`} />
          {importingEmail ? "Syncing all sales…" : "Sync All Sales Now"}
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search product or order ID"
          className="form-input pl-11"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {["All", ...visiblePlatformTabs, "Bundles"].map((p) => {
          const count =
            p === "All"
              ? activeOrders.length
              : p === "Bundles"
              ? activeOrders.filter(isBundle).length
              : platformCounts[p] || 0;
          return (
            <button
              key={p}
              onClick={() => choosePlatform(p)}
              className={`px-3 h-9 rounded-full text-sm font-medium ${
                platformFilter === p
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "bg-muted text-foreground"
              }`}
            >
              {p} <span className="opacity-70">({count})</span>
            </button>
          );
        })}
      </div>

      {(platformCounts.Poshmark || 0) > 0 && platformFilter !== "Poshmark" && (
        <button
          type="button"
          onClick={() => choosePlatform("Poshmark")}
          className="w-full rounded-2xl border border-pink-200 bg-pink-50 px-4 py-3 text-left flex items-center justify-between gap-3"
        >
          <div>
            <p className="text-sm font-semibold text-pink-800">Poshmark orders are available</p>
            <p className="text-xs text-pink-700">{platformCounts.Poshmark} Poshmark orders in your history</p>
          </div>
          <span className="text-xs font-semibold text-pink-800 shrink-0">Show</span>
        </button>
      )}

      {!sitesLoading && !sitesConfigured && activeOrders.length === 0 && (
        <div className="rounded-2xl bg-muted p-4 text-sm text-muted-foreground">
          Choose the marketplaces you sell on in Account before starting sales tracking.
        </div>
      )}

      <div className="space-y-2">
        {filtered.length === 0 && sitesConfigured && <EmptyRow text="No orders match your filters" />}
        {filtered.map((o) => {
          const sourceUrl = orderSourceUrl(o);
          const saleRecorded = hasRecordedSaleAmount(o);
          return (
          <div
            key={o.id}
            className="bg-card rounded-2xl p-4 border border-[hsl(var(--border))]"
          >
            <div className="flex items-start gap-3 mb-3">
              <OrderThumbnail
                src={o.display_image_url}
                alt={displayProductName(o)}
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{displayProductName(o)}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      <span className="text-foreground">{o.size}</span> · Qty <span className="text-foreground">{o.quantity}</span> · <span className="text-foreground">{formatDate(o.sale_date)}</span>
                    </p>
                  </div>

                  <div className="shrink-0 flex items-center gap-1.5">
                    <ProfitScoreBadge order={o} />
                    <span
                      className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                        PLATFORM_TONE[displayPlatform(o.platform)] || "bg-muted text-muted-foreground"
                      }`}
                    >
                      {displayPlatform(o.platform)}
                    </span>
                    {sourceUrl && <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />}
                  </div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center pt-2 border-t border-[hsl(var(--border))]">
              <div>
                <p className="text-[10px] text-muted-foreground uppercase">Sale</p>
                <p className="font-heading text-sm">{saleRecorded ? formatMoney(o.sale_total) : "Pending"}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase">Cost</p>
                <p className="font-heading text-sm">{formatMoney(o.total_cost)}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase">Profit</p>
                <p className="font-heading text-sm text-foreground">
                  {saleRecorded ? formatMoney(o.estimated_profit) : "Pending"}
                </p>
              </div>
            </div>

            <label className="mt-3 min-h-11 px-4 rounded-xl border border-[hsl(var(--border))] bg-background flex items-center justify-between gap-3 cursor-pointer select-none">
              <span className="text-sm font-semibold text-foreground">Sent / Shipped</span>
              <input
                type="checkbox"
                checked={Boolean(o.shipped)}
                disabled={updatingShipment.has(o.id || o.base44_id)}
                onChange={(event) => updateShipment(o, event.target.checked)}
                className="h-5 w-5 rounded border-[hsl(var(--border))] accent-[hsl(var(--primary))] disabled:opacity-50"
                aria-label={`Mark ${displayProductName(o)} as sent or shipped`}
              />
            </label>

            {sourceUrl && (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 h-10 px-4 rounded-xl bg-muted text-foreground text-sm font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition-transform"
                aria-label={`Open on ${displayPlatform(o.platform)}`}
              >
                <ExternalLink className="w-4 h-4" />
                Open on {displayPlatform(o.platform)}
              </a>
            )}
          </div>
          );
        })}
      </div>

      <button
        onClick={openForm}
        className="fixed bottom-24 right-5 max-w-md mx-auto w-14 h-14 rounded-full bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-lg shadow-[hsl(var(--primary))]/40 flex items-center justify-center active:scale-95 transition-transform z-30"
        style={{ left: "50%", transform: "translateX(calc(50vw - 2.75rem - 1.25rem))" }}
        aria-label="Add order"
      >
        <Plus className="w-6 h-6" strokeWidth={2.5} />
      </button>

      <OrderForm
        open={formOpen}
        onClose={closeForm}
        inventoryCosts={inventoryCosts}
      />
    </div>
  );
}
