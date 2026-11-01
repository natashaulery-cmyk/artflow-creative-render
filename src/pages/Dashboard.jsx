import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ShoppingBag,
  Package,
  Receipt,
  ArrowUpRight,
  RefreshCw,
  Plus,
  BarChart3,
  Activity,
  Target,
  MoreHorizontal,
} from "lucide-react";

import PullToRefresh from "@/components/PullToRefresh";
import { useEntity, isApprovedExpense } from "@/lib/useBusinessData";
import { useOrders } from "@/lib/useOrders";
import {
  formatMoney,
  formatDate,
  currentMonthKey,
  monthLabel,
} from "@/lib/format";
import { displayPlatform, PLATFORMS } from "@/lib/platforms";
import ProfitScoreBadge from "@/components/ProfitScoreBadge";
import { useAuth } from "@/lib/AuthContext";
import { toast } from "sonner";
import { averageOrderCost } from "@/lib/averageOrderCost";

const numberValue = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const orderIdentity = (order) =>
  String(
    order?.order_id ||
      order?.source_email_id ||
      order?.id ||
      ""
  ).trim();

const expenseDeduction = (expense) => {
  if (expense?.deductible_amount != null) {
    return numberValue(expense.deductible_amount);
  }

  const amount = numberValue(expense?.amount);
  const percent = numberValue(
    expense?.deductible_percent ?? 100
  );

  return amount * (percent / 100);
};

const orderTitle = (order) =>
  String(
    order?.product_name ||
      order?.item_name ||
      order?.listing_title ||
      order?.title ||
      order?.name ||
      "Art Order"
  ).trim();

const imageMatchKey = (value = "") =>
  String(value || "")
    .toLowerCase()
    .replace(/^\s*[0-9]+(?:\.[0-9]+)?\s*x\s*[0-9]+(?:\.[0-9]+)?\s*[-–—|:]?\s*/i, "")
    .replace(/\b(of|the|a|an)\b/gi, "")
    .replace(/[^a-z0-9]+/g, "");

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

const orderDate = (order) =>
  order?.sale_date ||
  order?.created_date ||
  order?.created_at ||
  "";

const expenseDate = (expense) =>
  expense?.date ||
  expense?.created_date ||
  expense?.created_at ||
  "";

function DashboardThumbnail({ src, alt = "", fallback = "Art" }) {
  const [failed, setFailed] = useState(false);
  const usable = Boolean(src) && !failed;

  return (
    <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-purple-100/70 dark:border-white/10 bg-gradient-to-br from-purple-100 via-pink-50 to-cyan-50 flex items-center justify-center">
      {usable ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-[9px] font-semibold text-purple-600/80 px-1 text-center">
          {fallback}
        </span>
      )}
    </div>
  );
}

function Card({ children, className = "" }) {
  return (
    <div
      className={`artflow-panel rounded-[22px] border ${className}`}
    >
      {children}
    </div>
  );
}

function MetricCard({
  icon: Icon,
  title,
  value,
  subtitle,
  accent,
  loading,
  to,
}) {
  const content = (
    <Card className="p-4 lg:p-5 min-h-[128px]">
      <div className="flex items-start justify-between gap-3">
        <div
          className={`w-10 h-10 rounded-2xl flex items-center justify-center ${accent}`}
        >
          <Icon className="w-5 h-5" />
        </div>

        <ArrowUpRight className="w-4 h-4 text-muted-foreground" />
      </div>

      <p className="text-[11px] text-muted-foreground mt-4">
        {title}
      </p>

      <p className="text-xl lg:text-2xl font-semibold tracking-tight mt-1">
        {loading ? "—" : value}
      </p>

      <p className="text-[10px] text-muted-foreground mt-1">
        {loading ? "Updating..." : subtitle}
      </p>
    </Card>
  );

  if (!to) return content;

  return (
    <Link
      to={to}
      aria-label={`Open ${title}`}
      className="block rounded-[22px] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
    >
      {content}
    </Link>
  );
}

function EmptyState({ text }) {
  return (
    <div className="py-8 text-center text-xs text-muted-foreground">
      {text}
    </div>
  );
}

function ProgressBar({ value, max, className = "", color }) {
  const width =
    max > 0 ? Math.max(4, (value / max) * 100) : 0;

  return (
    <div className="h-2 rounded-full bg-purple-100/60 dark:bg-white/5 overflow-hidden">
      <div
        className={`h-full rounded-full ${className}`}
        style={{
          width: `${Math.min(width, 100)}%`,
          backgroundColor: color || undefined,
        }}
      />
    </div>
  );
}

function DonutChart({ rows, total }) {
  const colors = [
    "#a78bfa",
    "#f472b6",
    "#67e8f9",
    "#fbbf24",
    "#34d399",
    "#818cf8",
  ];

  let running = 0;

  const segments = rows.map((row, index) => {
    const start = total ? (running / total) * 100 : 0;
    running += row.value;
    const end = total ? (running / total) * 100 : 0;

    return `${colors[index % colors.length]} ${start}% ${end}%`;
  });

  return (
    <div
      className="relative w-36 h-36 rounded-full shrink-0"
      style={{
        background:
          rows.length && total
            ? `conic-gradient(${segments.join(", ")})`
            : "conic-gradient(#eadff7 0 100%)",
      }}
    >
      <div className="absolute inset-[18px] rounded-full bg-card flex flex-col items-center justify-center">
        <span className="text-[10px] text-muted-foreground">
          Total
        </span>

        <span className="text-sm font-semibold mt-1">
          {formatMoney(total)}
        </span>
      </div>
    </div>
  );
}

function SalesLineChart({ rows }) {
  const width = 620;
  const height = 190;
  const paddingX = 22;
  const paddingY = 22;

  if (!rows.length) {
    return <EmptyState text="No sales history yet" />;
  }

  const values = rows.map((row) => row.sales);
  const maxValue = Math.max(...values, 1);

  const points = rows.map((row, index) => {
    const x =
      rows.length === 1
        ? width / 2
        : paddingX +
          (index / (rows.length - 1)) *
            (width - paddingX * 2);

    const y =
      height -
      paddingY -
      (row.sales / maxValue) *
        (height - paddingY * 2);

    return {
      x,
      y,
      row,
    };
  });

  const polyline = points
    .map((point) => `${point.x},${point.y}`)
    .join(" ");

  const areaPath = [
    `M ${points[0].x} ${height - paddingY}`,
    ...points.map(
      (point) => `L ${point.x} ${point.y}`
    ),
    `L ${points[points.length - 1].x} ${
      height - paddingY
    }`,
    "Z",
  ].join(" ");

  return (
    <div>
      <div className="w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-[190px]"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient
              id="salesFill"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor="#a78bfa"
                stopOpacity="0.32"
              />
              <stop
                offset="100%"
                stopColor="#a78bfa"
                stopOpacity="0"
              />
            </linearGradient>
          </defs>

          {[0.25, 0.5, 0.75].map((fraction) => (
            <line
              key={fraction}
              x1="0"
              y1={height * fraction}
              x2={width}
              y2={height * fraction}
              stroke="currentColor"
              strokeOpacity="0.08"
              strokeDasharray="5 7"
            />
          ))}

          <path d={areaPath} fill="url(#salesFill)" />

          <polyline
            points={polyline}
            fill="none"
            stroke="#8b5cf6"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {points.map((point) => (
            <circle
              key={point.row.key}
              cx={point.x}
              cy={point.y}
              r="4"
              fill="#8b5cf6"
              stroke="white"
              strokeWidth="2"
            />
          ))}
        </svg>
      </div>

      <div
        className="grid gap-1 mt-1"
        style={{
          gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))`,
        }}
      >
        {rows.map((row) => (
          <div
            key={row.key}
            className="text-center text-[9px] text-muted-foreground"
          >
            {monthLabel(row.key).split(" ")[0]}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const {
    records: orders = [],
    loading: ordersLoading,
    reload: reloadOrders,
  } = useOrders();
  const resupplyMetrics = averageOrderCost(orders);

  const {
    records: allExpenses = [],
    loading: expensesLoading,
    reload: reloadExpenses,
  } = useEntity("Expense", "-created_date", 10000);
  const expenses = allExpenses.filter(isApprovedExpense);

  const {
    records: inventory = [],
    loading: inventoryLoading,
    reload: reloadInventory,
  } = useEntity("InventoryCost", "-created_date", 1000);

  const { user } = useAuth();
  const [serverMetrics, setServerMetrics] = useState(null);
  const [marketplaceListings, setMarketplaceListings] = useState([]);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const loadServerMetrics = React.useCallback(async () => {
    try {
      const response = await fetch("/api/neon-data?op=summary", {
        credentials: "include",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Dashboard summary ${response.status}`);
      setServerMetrics(data.metrics || null);
    } catch (error) {
      console.error("Failed to load dashboard summary:", error);
      setServerMetrics(null);
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  const loadMarketplaceListings = React.useCallback(async () => {
    try {
      const response = await fetch("/api/neon-data?op=listings", {
        credentials: "include",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Listings ${response.status}`);
      setMarketplaceListings(Array.isArray(data.listings) ? data.listings : []);
    } catch (error) {
      console.error("Failed to load marketplace listing images:", error);
      setMarketplaceListings([]);
    }
  }, []);

  useEffect(() => {
    loadServerMetrics();
    loadMarketplaceListings();
    const onSynced = () => {
      loadServerMetrics();
      loadMarketplaceListings();
    };
    window.addEventListener("artflow:data-synced", onSynced);
    return () => window.removeEventListener("artflow:data-synced", onSynced);
  }, [loadServerMetrics, loadMarketplaceListings]);

  const loading = ordersLoading || expensesLoading || inventoryLoading || metricsLoading;
  const currentMonth = currentMonthKey();

  // Marketplace preferences control which connections Art Flow syncs. They
  // must never hide a real sale that is already in the business ledger.
  const activeOrders = orders.filter((order) => displayPlatform(order.platform) !== "Legacy");

  const imageSources = useMemo(() => {
    const listingByUrl = new Map();
    const listingByKey = new Map();
    const inventoryByKey = new Map();

    for (const listing of marketplaceListings) {
      const image = directImageUrl(listing);
      if (!image) continue;

      const url = String(listing?.listing_url || "").trim();
      if (url) listingByUrl.set(url, image);

      const key = imageMatchKey(listing?.title);
      if (key && !listingByKey.has(key)) listingByKey.set(key, image);
    }

    for (const item of inventory) {
      const key = imageMatchKey(item?.name || item?.title);
      const image = directImageUrl(item);
      if (key && image && !inventoryByKey.has(key)) inventoryByKey.set(key, image);
    }

    return { listingByUrl, listingByKey, inventoryByKey };
  }, [marketplaceListings, inventory]);

  const actualOrderImage = React.useCallback((order) => {
    const bundleOrder =
      /\bbundle\b/i.test(String(orderTitle(order))) ||
      Number(order?.quantity || 1) > 1;

    if (bundleOrder) return "/bundle-placeholder.svg";

    const direct = directImageUrl(order);
    return direct || "";
  }, []);

  const imageForOrder = React.useCallback(
    (order) => {
      const bundleOrder =
        /\bbundle\b/i.test(String(orderTitle(order))) ||
        Number(order?.quantity || 1) > 1;
      if (bundleOrder) return "/bundle-placeholder.svg";

      const direct = directImageUrl(order);
      if (direct) return direct;

      const source = String(order?.source_url || order?.data?.source_url || "").trim();
      if (source && imageSources.listingByUrl.has(source)) {
        return imageSources.listingByUrl.get(source);
      }

      const key = imageMatchKey(orderTitle(order));
      if (!key) return "";

      if (imageSources.listingByKey.has(key)) return imageSources.listingByKey.get(key);
      if (imageSources.inventoryByKey.has(key)) return imageSources.inventoryByKey.get(key);

      for (const [candidate, image] of imageSources.listingByKey.entries()) {
        if (key.length >= 8 && candidate.length >= 8 && (key.includes(candidate) || candidate.includes(key))) {
          return image;
        }
      }
      for (const [candidate, image] of imageSources.inventoryByKey.entries()) {
        if (key.length >= 8 && candidate.length >= 8 && (key.includes(candidate) || candidate.includes(key))) {
          return image;
        }
      }

      return "";
    },
    [imageSources]
  );

  const dashboard = useMemo(() => {
    const uniqueOrderIds = new Set(
      activeOrders
        .map(orderIdentity)
        .filter(Boolean)
    );

    const totalSales = activeOrders.reduce(
      (sum, order) =>
        sum + numberValue(order?.sale_total),
      0
    );

    const totalItems = activeOrders.reduce(
      (sum, order) =>
        sum + numberValue(order?.quantity || 1),
      0
    );

    const orderCosts = activeOrders.reduce(
      (sum, order) =>
        sum + numberValue(order?.total_cost),
      0
    );

    const deductibleExpenses = expenses.reduce(
      (sum, expense) =>
        sum + expenseDeduction(expense),
      0
    );

    const netProfit =
      totalSales -
      orderCosts -
      deductibleExpenses;

    const monthOrders = activeOrders.filter(
      (order) =>
        String(orderDate(order)).slice(0, 7) ===
        currentMonth
    );

    const monthExpenses = expenses.filter(
      (expense) =>
        String(expenseDate(expense)).slice(0, 7) ===
        currentMonth
    );

    const monthSales = monthOrders.reduce(
      (sum, order) =>
        sum + numberValue(order?.sale_total),
      0
    );

    const monthCosts = monthOrders.reduce(
      (sum, order) =>
        sum + numberValue(order?.total_cost),
      0
    );

    const monthDeductions =
      monthExpenses.reduce(
        (sum, expense) =>
          sum + expenseDeduction(expense),
        0
      );

    const monthNet =
      monthSales -
      monthCosts -
      monthDeductions;

    const averageOrder = uniqueOrderIds.size
      ? totalSales / uniqueOrderIds.size
      : 0;

    const platformMap = new Map(
      PLATFORMS.map((platform) => [platform, 0])
    );

    for (const order of activeOrders) {
      const platform = displayPlatform(
        order?.platform
      );

      platformMap.set(
        platform,
        (platformMap.get(platform) || 0) +
          numberValue(order?.sale_total)
      );
    }

    const platforms = Array.from(
      platformMap.entries()
    )
      .map(([name, value]) => ({
        name,
        value,
      }))
      .sort((a, b) => b.value - a.value);

    const expenseMap = new Map();

    for (const expense of expenses) {
      const category =
        String(
          expense?.category || "Other"
        ).trim() || "Other";

      expenseMap.set(
        category,
        (expenseMap.get(category) || 0) +
          numberValue(expense?.amount)
      );
    }

    const expenseCategories = Array.from(
      expenseMap.entries()
    )
      .map(([name, value]) => ({
        name,
        value,
      }))
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value);

    const monthKeys = Array.from(
      new Set(
        [
          currentMonth,
          ...activeOrders.map((order) =>
            String(orderDate(order)).slice(0, 7)
          ),
        ].filter((key) =>
          /^\d{4}-\d{2}$/.test(key)
        )
      )
    )
      .sort()
      .slice(-6);

    const salesHistory = monthKeys.map(
      (key) => ({
        key,
        sales: activeOrders
          .filter(
            (order) =>
              String(orderDate(order)).slice(
                0,
                7
              ) === key
          )
          .reduce(
            (sum, order) =>
              sum +
              numberValue(order?.sale_total),
            0
          ),
      })
    );

    const listingMap = new Map();

    for (const order of activeOrders) {
      const name = orderTitle(order);

      const existing = listingMap.get(name) || {
        name,
        sales: 0,
        quantity: 0,
        image_url: imageForOrder(order),
      };

      existing.sales += numberValue(
        order?.sale_total
      );

      existing.quantity += numberValue(
        order?.quantity || 1
      );

      if (!existing.image_url) {
        existing.image_url = imageForOrder(order);
      }

      listingMap.set(name, existing);
    }

    const topListings = Array.from(
      listingMap.values()
    )
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 5);

    const recentOrders = [...activeOrders]
      .sort(
        (a, b) =>
          new Date(orderDate(b) || 0) -
          new Date(orderDate(a) || 0)
      )
      .slice(0, 5)
      .map((order) => ({
        ...order,
        dashboard_image_url: actualOrderImage(order),
      }));

    const inventoryPreview = [...inventory]
      .filter((item) => item?.name || item?.title)
      .sort((a, b) => {
        const imageDiff = Number(Boolean(directImageUrl(b))) - Number(Boolean(directImageUrl(a)));
        if (imageDiff) return imageDiff;
        return new Date(b?.updated_date || b?.created_date || 0) - new Date(a?.updated_date || a?.created_date || 0);
      })
      .slice(0, 4);

    const recentExpenses = [...expenses]
      .sort(
        (a, b) =>
          new Date(expenseDate(b) || 0) -
          new Date(expenseDate(a) || 0)
      )
      .slice(0, 3);

    const activities = [
      ...recentOrders.slice(0, 3).map((order) => ({
        type: "order",
        title: "New order",
        detail: `${displayPlatform(
          order?.platform
        )} · ${orderTitle(order)}`,
        amount: numberValue(order?.sale_total),
        date: orderDate(order),
      })),

      ...recentExpenses.slice(0, 3).map(
        (expense) => ({
          type: "expense",
          title: "Expense added",
          detail:
            expense?.category ||
            expense?.merchant ||
            "Business expense",
          amount: numberValue(expense?.amount),
          date: expenseDate(expense),
        })
      ),
    ]
      .sort(
        (a, b) =>
          new Date(b.date || 0) -
          new Date(a.date || 0)
      )
      .slice(0, 5);

    return {
      totalSales,
      totalOrders: uniqueOrderIds.size,
      totalItems,
      netProfit,
      monthSales,
      monthNet,
      averageOrder,
      deductibleExpenses,
      orderCosts,
      platforms,
      expenseCategories,
      salesHistory,
      topListings,
      recentOrders,
      inventoryPreview,
      activities,
    };
  }, [
    activeOrders,
    expenses,
    inventory,
    currentMonth,
    imageForOrder,
    actualOrderImage,
  ]);

  const refresh = async () => {
    if (syncing) return;
    setSyncing(true);

    const publishSyncState = (state) => {
      try {
        localStorage.setItem("artflow_last_sync", JSON.stringify(state));
      } catch {}
      window.dispatchEvent(new CustomEvent("artflow:sync-state", { detail: state }));
    };

    publishSyncState({ status: "syncing", at: new Date().toISOString() });

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

      const results = await Promise.all([
        runSync("/api/gmail-sales-sync", { force: true }),
        runSync("/api/gmail-expense-sync"),
        runSync("/api/yahoo-mail", { action: "sync" }),
        runSync("/api/ebay-official", { action: "sync" }),
      ]);

      const hardFailure = results.find(
        ({ response }) => !response.ok && ![400, 409].includes(response.status)
      );
      const connectorMessage = results
        .filter(({ response }) => [400, 409].includes(response.status))
        .map(({ data }) => data?.error)
        .find(Boolean);

      await Promise.all([
        reloadOrders?.(),
        reloadExpenses?.(),
        reloadInventory?.(),
        loadServerMetrics(),
        loadMarketplaceListings(),
      ]);

      const state = {
        status: hardFailure ? "error" : "ok",
        at: new Date().toISOString(),
        message: hardFailure?.data?.error || connectorMessage,
      };
      publishSyncState(state);
      window.dispatchEvent(new CustomEvent("artflow:data-synced", { detail: state }));

      if (hardFailure) {
        toast.error("Sync needs attention", { description: state.message });
      } else if (results.some(({ response }) => response.ok)) {
        toast.success("Sales, eBay, and expenses are up to date");
      } else {
        toast.info("Saved data refreshed", { description: connectorMessage });
      }
    } catch (error) {
      const state = {
        status: "error",
        at: new Date().toISOString(),
        message: error?.message || "Sync failed",
      };
      publishSyncState(state);
      toast.error("Could not sync business data", { description: state.message });
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    const syncEbayOnDashboardOpen = async () => {
      const key = "artflow_ebay_dashboard_sync_at";
      try {
        const last = Number(localStorage.getItem(key) || 0);
        if (Date.now() - last < 2 * 60 * 1000) return;
        localStorage.setItem(key, String(Date.now()));
      } catch {}

      try {
        const response = await fetch("/api/ebay-official", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sync" }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || cancelled) return;

        if (Number(data?.saved || 0) > 0) {
          await Promise.all([
            reloadOrders?.(),
            loadServerMetrics(),
          ]);
          window.dispatchEvent(new CustomEvent("artflow:data-synced", {
            detail: { status: "ok", at: new Date().toISOString() },
          }));
        }
      } catch (error) {
        console.warn("Dashboard eBay sync skipped:", error?.message || error);
      }
    };

    syncEbayOnDashboardOpen();
    return () => {
      cancelled = true;
    };
  }, [reloadOrders, loadServerMetrics]);

  // Use the normalized client ledger for sales KPIs. It includes historical
  // Poshmark gross-sale recovery for rows that were imported with a $0 total.
  const kpis = {
    totalSales: dashboard.totalSales,
    totalOrders: dashboard.totalOrders,
    totalItems: dashboard.totalItems,
    netProfit: dashboard.netProfit,
    monthSales: dashboard.monthSales,
    monthNet: dashboard.monthNet,
    averageOrder: dashboard.averageOrder,
  };

  const firstName =
    String(
      user?.full_name ||
        user?.name ||
        "Artist"
    )
      .trim()
      .split(/\s+/)[0] || "Artist";

  const hour = new Date().getHours();

  const greeting =
    hour < 12
      ? "Good morning"
      : hour < 17
      ? "Good afternoon"
      : "Good evening";

  const maxPlatform = Math.max(
    ...dashboard.platforms.map(
      (row) => row.value
    ),
    1
  );

  const expenseTotal =
    dashboard.expenseCategories.reduce(
      (sum, row) => sum + row.value,
      0
    );

  return (
    <div className="dashboard-page space-y-5 lg:space-y-6 pt-4 lg:pt-0">
      <PullToRefresh onRefresh={refresh} />

      {/* V57 FINTECH HERO */}
      <section className="dashboard-hero">
        <div className="dashboard-hero-glow" aria-hidden="true" />
        <div className="relative z-10">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="dashboard-hero-kicker">{greeting}, {firstName}</p>
              <p className="dashboard-hero-label">Total business sales</p>
              <h1 className="dashboard-hero-value">{loading ? "—" : formatMoney(kpis.totalSales)}</h1>
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={syncing}
              className="dashboard-hero-sync"
              aria-label="Sync business data"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div className="dashboard-hero-actions mt-6" aria-label="Quick business actions">
            <Link to="/orders" className="dashboard-hero-action">
              <span><ShoppingBag className="w-5 h-5" /></span>
              <small>Orders</small>
            </Link>
            <Link to="/expenses" className="dashboard-hero-action">
              <span><Receipt className="w-5 h-5" /></span>
              <small>Expenses</small>
            </Link>
            <Link to="/inventory" className="dashboard-hero-action">
              <span><Package className="w-5 h-5" /></span>
              <small>Inventory</small>
            </Link>
            <Link to="/reports" className="dashboard-hero-action is-accent">
              <span><MoreHorizontal className="w-5 h-5" /></span>
              <small>More</small>
            </Link>
          </div>

          <div className="dashboard-hero-summary mt-4">
            <div>
              <span>Items sold</span>
              <strong>{loading ? "—" : String(kpis.totalItems)}</strong>
            </div>
            <div>
              <span>Orders</span>
              <strong>{loading ? "—" : String(kpis.totalOrders)}</strong>
            </div>
            <div>
              <span>Avg. order revenue</span>
              <strong>{loading ? "—" : formatMoney(kpis.averageOrder)}</strong>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="home-supply-averages" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="home-supply-averages" className="text-sm font-semibold">Supply Cost Averages</h2>
            <p className="text-xs text-muted-foreground mt-1">Last 3 complete months · {resupplyMetrics.period}</p>
          </div>
          <Link to="/average-order-cost?period=last3" className="text-xs font-medium underline">View breakdown</Link>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Link to="/average-order-cost?period=last3" className="block rounded-3xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            <Card className="p-4 lg:p-5 h-full">
              <h3 className="text-xs text-muted-foreground">Average Cost per Order</h3>
              <p className="text-2xl font-semibold mt-2">{ordersLoading || !resupplyMetrics.hasCosts ? "—" : formatMoney(resupplyMetrics.average)}</p>
              <p className="text-xs text-muted-foreground mt-2">Recorded costs ÷ {resupplyMetrics.count} orders</p>
            </Card>
          </Link>
          <Link to="/average-order-cost?period=last3" className="block rounded-3xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            <Card className="p-4 lg:p-5 h-full">
              <h3 className="text-xs text-muted-foreground">Average Monthly Resupply Cost</h3>
              <p className="text-2xl font-semibold mt-2">{ordersLoading || !resupplyMetrics.hasCosts ? "—" : formatMoney(resupplyMetrics.monthly)}</p>
              <p className="text-xs text-muted-foreground mt-2">Amount to set aside per month</p>
            </Card>
          </Link>
        </div>
        {!ordersLoading && !resupplyMetrics.count && <p className="text-xs text-muted-foreground">No orders recorded in this period yet.</p>}
        {!ordersLoading && resupplyMetrics.missing > 0 && <p className="text-xs text-muted-foreground">{resupplyMetrics.missing} order rows are missing costs; these averages may be low. Review the breakdown to check them.</p>}
      </section>

      {/* SALES + PLATFORM */}
      <section className="grid grid-cols-1 xl:grid-cols-[1.7fr_1fr] gap-4">
        <Card className="p-5 lg:p-6">
          <div className="flex items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="text-sm font-semibold">
                Sales Overview
              </h2>

              <p className="text-[10px] text-muted-foreground mt-1">
                Revenue over the last several months
              </p>
            </div>

            <div className="flex items-center gap-2 text-[10px] text-purple-600 font-medium">
              <span className="w-2 h-2 rounded-full bg-purple-500" />
              Sales
            </div>
          </div>

          <SalesLineChart
            rows={dashboard.salesHistory}
          />
        </Card>

        <Card className="p-5 lg:p-6">
          <div className="mb-5">
            <h2 className="text-sm font-semibold">
              Market Performance
            </h2>

            <p className="text-[10px] text-muted-foreground mt-1">
              Sales across all marketplaces
            </p>
          </div>

          {!dashboard.platforms.length ? (
            <EmptyState text="No marketplace sales yet" />
          ) : (
            <div className="space-y-4">
              {dashboard.platforms
                .slice(0, 6)
                .map((row) => {
                  const brandColors = {
                    Poshmark: "#610721",
                    Vinted: "#027783",
                    Depop: "#E4001D",
                    eBay: "#0064D2",
                  };
                  const color = brandColors[row.name] || "#8B5CF6";

                  return (
                    <div key={row.name}>
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <span className="flex items-center gap-2 text-xs font-medium">
                          <span
                            className="h-2.5 w-2.5 rounded-full ring-2 ring-white/70 dark:ring-black/20"
                            style={{ backgroundColor: color }}
                            aria-hidden="true"
                          />
                          {row.name}
                        </span>

                        <span className="text-xs font-semibold">
                          {formatMoney(
                            row.value
                          )}
                        </span>
                      </div>

                      <ProgressBar
                        value={row.value}
                        max={maxPlatform}
                        color={color}
                      />
                    </div>
                  );
                })}
            </div>
          )}
        </Card>
      </section>

      {/* RECENT ORDERS + EXPENSES */}
      <section className="grid grid-cols-1 xl:grid-cols-[1.65fr_1fr] gap-4">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-5 lg:px-6 py-5 border-b border-purple-100/60 dark:border-white/5">
            <div>
              <h2 className="text-sm font-semibold">
                Recent Orders
              </h2>

              <p className="text-[10px] text-muted-foreground mt-1">
                Latest sales across your connected shops
              </p>
            </div>

            <Link
              to="/orders"
              className="text-[10px] font-semibold text-purple-600 flex items-center gap-1"
            >
              View all
              <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>

          {!dashboard.recentOrders.length ? (
            <EmptyState text="No recent orders yet" />
          ) : (
            <div>
              {dashboard.recentOrders.map(
                (order, index) => (
                  <div
                    key={
                      orderIdentity(order) ||
                      `${index}`
                    }
                    className="grid grid-cols-[auto_1fr_auto] sm:grid-cols-[auto_1.5fr_.7fr_.7fr_auto] gap-3 items-center px-5 lg:px-6 py-4 border-b last:border-b-0 border-purple-100/50 dark:border-white/5"
                  >
                    <DashboardThumbnail
                      src={order.dashboard_image_url}
                      alt={orderTitle(order)}
                      fallback="Order"
                    />

                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate">
                        {orderTitle(order)}
                      </p>

                      <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1.5">
                        {displayPlatform(
                          order?.platform
                        )}
                        <ProfitScoreBadge order={order} />
                      </p>
                    </div>

                    <div className="hidden sm:block">
                      <p className="text-[10px] text-muted-foreground">
                        Qty
                      </p>

                      <p className="text-xs font-medium mt-1">
                        {numberValue(
                          order?.quantity || 1
                        )}
                      </p>
                    </div>

                    <div className="hidden sm:block">
                      <p className="text-[10px] text-muted-foreground">
                        Date
                      </p>

                      <p className="text-xs font-medium mt-1">
                        {formatDate(orderDate(order)) || "—"}
                      </p>
                    </div>

                    <p className="text-sm font-semibold text-right">
                      {formatMoney(
                        numberValue(
                          order?.sale_total
                        )
                      )}
                    </p>
                  </div>
                )
              )}
            </div>
          )}
        </Card>

        <Card className="p-5 lg:p-6">
          <div className="mb-5">
            <h2 className="text-sm font-semibold">
              Expenses Overview
            </h2>

            <p className="text-[10px] text-muted-foreground mt-1">
              Total approved business spending
            </p>
          </div>

          {!dashboard.expenseCategories.length ? (
            <EmptyState text="No expenses recorded yet" />
          ) : (
            <div className="flex flex-col sm:flex-row xl:flex-col 2xl:flex-row items-center gap-6">
              <DonutChart
                rows={
                  dashboard.expenseCategories
                }
                total={expenseTotal}
              />

              <div className="w-full space-y-3">
                {dashboard.expenseCategories.map(
                  (row, index) => {
                    const colors = [
                      "bg-purple-400",
                      "bg-pink-400",
                      "bg-cyan-400",
                      "bg-amber-400",
                      "bg-emerald-400",
                      "bg-fuchsia-400",
                    ];

                    return (
                      <div
                        key={row.name}
                        className="flex items-center gap-2"
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            colors[
                              index %
                                colors.length
                            ]
                          }`}
                        />

                        <span className="text-[10px] text-muted-foreground flex-1 truncate">
                          {row.name}
                        </span>

                        <span className="text-[10px] font-semibold">
                          {formatMoney(
                            row.value
                          )}
                        </span>
                      </div>
                    );
                  }
                )}
              </div>
            </div>
          )}
        </Card>
      </section>

      {/* INVENTORY PREVIEW */}
      <Card className="p-5 lg:p-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-semibold">Inventory Preview</h2>
            <p className="text-[10px] text-muted-foreground mt-1">
              Your saved products and artwork
            </p>
          </div>
          <Link
            to="/inventory"
            className="text-[10px] font-semibold text-purple-600 flex items-center gap-1"
          >
            View inventory
            <ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>

        {!dashboard.inventoryPreview.length ? (
          <EmptyState text="Add inventory images to see them here" />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {dashboard.inventoryPreview.map((item) => (
              <Link
                key={item.id || item.name}
                to="/inventory"
                className="group rounded-2xl border border-purple-100/70 dark:border-white/5 bg-purple-50/40 dark:bg-white/5 overflow-hidden"
              >
                <div className="aspect-[4/3] bg-gradient-to-br from-purple-100 via-pink-50 to-cyan-50 overflow-hidden">
                  {directImageUrl(item) ? (
                    <img
                      src={directImageUrl(item)}
                      alt={item.name || "Inventory item"}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Package className="w-6 h-6 text-purple-400" />
                    </div>
                  )}
                </div>
                <div className="p-3">
                  <p className="text-xs font-semibold truncate">
                    {item.name || item.title}
                  </p>
                  <p className="text-[9px] text-muted-foreground mt-1">
                    {numberValue(item.quantity_on_hand)} in stock
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>

      {/* ACTIVITY + QUICK ACTIONS */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5 lg:p-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-sm font-semibold">
                Recent Activity
              </h2>

              <p className="text-[10px] text-muted-foreground mt-1">
                Latest changes in Art Flow
              </p>
            </div>

            <Activity className="w-4 h-4 text-pink-500" />
          </div>

          {!dashboard.activities.length ? (
            <EmptyState text="No recent activity yet" />
          ) : (
            <div className="space-y-4">
              {dashboard.activities.map(
                (activity, index) => (
                  <div
                    key={`${activity.type}-${index}`}
                    className="flex items-start gap-3"
                  >
                    <div
                      className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                        activity.type ===
                        "order"
                          ? "bg-purple-100 text-purple-600"
                          : "bg-pink-100 text-pink-600"
                      }`}
                    >
                      {activity.type ===
                      "order" ? (
                        <ShoppingBag className="w-4 h-4" />
                      ) : (
                        <Receipt className="w-4 h-4" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold">
                        {activity.title}
                      </p>

                      <p className="text-[10px] text-muted-foreground truncate mt-1">
                        {activity.detail}
                      </p>
                    </div>

                    <span
                      className={`text-[10px] font-semibold ${
                        activity.type ===
                        "order"
                          ? "text-emerald-600"
                          : "text-pink-500"
                      }`}
                    >
                      {activity.type ===
                      "order"
                        ? "+"
                        : "-"}
                      {formatMoney(
                        activity.amount
                      )}
                    </span>
                  </div>
                )
              )}
            </div>
          )}
        </Card>

        <Card className="p-5 lg:p-6 lg:col-span-2 2xl:col-span-1">
          <div className="mb-4">
            <h2 className="text-sm font-semibold">
              Quick Actions
            </h2>

            <p className="text-[10px] text-muted-foreground mt-1">
              Jump right to common tasks
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Link
              to="/orders"
              className="rounded-2xl bg-purple-100/80 dark:bg-purple-500/10 p-4 hover:-translate-y-0.5 transition"
            >
              <ShoppingBag className="w-5 h-5 text-purple-600" />

              <p className="text-xs font-semibold mt-3">
                Orders
              </p>

              <p className="text-[9px] text-muted-foreground mt-1">
                View sales
              </p>
            </Link>

            <Link
              to="/expenses"
              className="rounded-2xl bg-pink-100/80 dark:bg-pink-500/10 p-4 hover:-translate-y-0.5 transition"
            >
              <Plus className="w-5 h-5 text-pink-600" />

              <p className="text-xs font-semibold mt-3">
                Expense
              </p>

              <p className="text-[9px] text-muted-foreground mt-1">
                Add spending
              </p>
            </Link>

            <Link
              to="/inventory"
              className="rounded-2xl bg-cyan-100/80 dark:bg-cyan-500/10 p-4 hover:-translate-y-0.5 transition"
            >
              <Package className="w-5 h-5 text-cyan-600" />

              <p className="text-xs font-semibold mt-3">
                Inventory
              </p>

              <p className="text-[9px] text-muted-foreground mt-1">
                Manage costs
              </p>
            </Link>

            <Link
              to="/reports"
              className="rounded-2xl bg-amber-100/80 dark:bg-amber-500/10 p-4 hover:-translate-y-0.5 transition"
            >
              <BarChart3 className="w-5 h-5 text-amber-600" />

              <p className="text-xs font-semibold mt-3">
                Reports
              </p>

              <p className="text-[9px] text-muted-foreground mt-1">
                See analytics
              </p>
            </Link>
          </div>

          <Link
            to="/planning"
            className="mt-4 rounded-2xl border border-purple-100/70 dark:border-white/5 bg-white/45 dark:bg-white/5 p-4 flex items-center gap-3 hover:-translate-y-0.5 transition"
          >
            <Target className="w-5 h-5 text-purple-500" />

            <div>
              <p className="text-[11px] font-semibold">
                {monthLabel(currentMonth)} business plan
              </p>

              <p className="text-[9px] text-muted-foreground mt-1">
                {formatMoney(kpis.monthSales)} sales · {formatMoney(kpis.monthNet)} net
              </p>
            </div>

            <ArrowUpRight className="w-4 h-4 ml-auto text-muted-foreground" />
          </Link>
        </Card>
      </section>
    </div>
  );
}
