export const PLATFORMS = ["Vinted", "Depop", "eBay", "Poshmark", "Facebook Marketplace", "Mercari"]; 

export const PLATFORM_TONE = {
  Vinted: "pastel-lavender text-[hsl(var(--primary))]",
  Depop: "pastel-mint text-slate-600",
  eBay: "pastel-blue text-slate-600",
  Poshmark: "bg-pink-100 text-pink-700",
  "Facebook Marketplace": "bg-blue-100 text-blue-700",
  Mercari: "bg-red-100 text-red-700",
  Legacy: "bg-muted text-muted-foreground",
};

export const PLATFORM_BAR = {
  Vinted: "bg-[hsl(var(--primary))]",
  Depop: "bg-slate-400",
  eBay: "bg-blue-400",
  Poshmark: "bg-pink-400",
  "Facebook Marketplace": "bg-blue-600",
  Mercari: "bg-red-500",
  Legacy: "bg-slate-300",
};

const SUPPORTED = new Set(PLATFORMS);

// Preserve old sales records without continuing to advertise retired seller
// platforms. Historical unsupported rows appear only as Legacy in the UI.
export function displayPlatform(value) {
  const raw = String(value || "").trim();
  if (SUPPORTED.has(raw)) return raw;
  const lowered = raw.toLowerCase();
  if (["facebook", "facebook marketplace", "seller", "seller app"].includes(lowered)) return "Facebook Marketplace";
  const canonical = PLATFORMS.find((platform) => platform.toLowerCase() === lowered);
  return canonical || "Legacy";
}

export function displayProductName(order) {
  const name = String(order?.product_name || "").trim();
  return name || `${displayPlatform(order?.platform)} sale`;
}

export function orderSourceUrl(order) {
  const platform = displayPlatform(order?.platform);
  const orderId = String(order?.order_id || "").trim();

  if (platform === "Poshmark" && /^[a-f0-9]{24}$/i.test(orderId)) {
    return `https://poshmark.com/order/sales/${orderId}`;
  }
  if (platform === "Mercari" && /^[mb]\d{8,}$/i.test(orderId)) {
    return `https://www.mercari.com/us/item/${encodeURIComponent(orderId)}/`;
  }
  if (platform === "eBay" && /^\d{2}-\d{5}-\d{5}$/.test(orderId)) {
    return `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(orderId)}`;
  }

  const direct = String(order?.source_url || order?.data?.source_url || "").trim();
  if (/^https:\/\//i.test(direct) && !/support\.poshmark\.com/i.test(direct)) {
    return direct;
  }

  // Historical Sheet imports often do not contain the original order URL.
  // Keep the action useful without pretending we know a specific order page:
  // newer records still use their exact source URL, while old records fall
  // back to the marketplace itself.
  const fallback = {
    Vinted: "https://www.vinted.com/",
    Depop: "https://www.depop.com/",
    eBay: "https://www.ebay.com/",
    Poshmark: "https://poshmark.com/",
    "Facebook Marketplace": "https://www.facebook.com/marketplace/",
    Mercari: "https://www.mercari.com/",
  };
  return fallback[platform] || "";
}
