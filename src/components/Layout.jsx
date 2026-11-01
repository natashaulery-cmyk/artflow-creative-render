import React, { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import {
  LayoutDashboard,
  ShoppingCart,
  Receipt,
  Package,
  BarChart3,
  CalendarDays,
  Settings,
  LogOut,
  Sun,
  Moon,
  Search,
  Bell,
  Palette,
  Percent,
  Car,
  Target,
} from "lucide-react";

import BottomNav from "@/components/BottomNav";
import Dashboard from "@/pages/Dashboard";
import Orders from "@/pages/Orders";
import Inventory from "@/pages/Inventory";
import Expenses from "@/pages/Expenses";
import Logo from "@/components/Logo";
import { useAuth } from "@/lib/AuthContext";
import SyncStatus from "@/components/SyncStatus";

const tabs = [
  { path: "/dashboard", Comp: Dashboard },
  { path: "/orders", Comp: Orders },
  { path: "/inventory", Comp: Inventory },
  { path: "/expenses", Comp: Expenses },
];

const tabPaths = new Set(tabs.map((item) => item.path));

const navItems = [
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { label: "Orders", to: "/orders", icon: ShoppingCart },
  { label: "Expenses", to: "/expenses", icon: Receipt },
  { label: "Inventory", to: "/inventory", icon: Package },
  { label: "Reports", to: "/reports", icon: BarChart3 },
  { label: "Average Order Cost", to: "/average-order-cost", icon: BarChart3 },
  { label: "Business Plan", to: "/planning", icon: Target },
  { label: "Taxes", to: "/taxes", icon: Percent },
  { label: "Mileage", to: "/mileage", icon: Car },
  { label: "Calendar", to: "/calendar", icon: CalendarDays },
  { label: "Products", to: "/store-products", icon: Palette },
  { label: "Settings", to: "/account", icon: Settings },
];

export default function Layout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [searchQuery, setSearchQuery] = useState("");

  const firstName =
    String(user?.full_name || user?.name || "Artist")
      .trim()
      .split(/\s+/)[0] || "Artist";

  const isActive = (to) => {
    if (to === "/dashboard") return pathname === "/dashboard";
    return pathname === to || pathname.startsWith(`${to}/`);
  };

  const submitSearch = (event) => {
    event.preventDefault();
    const query = searchQuery.trim();
    navigate(query ? `/orders?search=${encodeURIComponent(query)}` : "/orders");
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="hidden lg:flex fixed inset-y-0 left-0 z-50 w-[260px] p-3">
        <div className="artflow-glass w-full h-full rounded-[26px] border flex flex-col overflow-y-auto no-scrollbar">

          <button
            type="button"
            onClick={() => navigate("/dashboard")}
            className="flex items-center gap-3 px-5 py-5 text-left"
          >
            <Logo size={42} />

            <div>
              <div className="text-xl font-semibold artflow-gradient-text">
                ART FLOW
              </div>

              <div className="text-[10px] tracking-[0.3em] text-muted-foreground">
                CREATIVE
              </div>
            </div>
          </button>

          <nav className="px-3 space-y-1">
            {navItems.map(({ label, to, icon: Icon }) => {
              const active = isActive(to);

              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => navigate(to)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-2xl text-sm font-medium transition ${
                    active
                      ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_10px_24px_rgba(110,55,105,0.24)]"
                      : "text-foreground/75 hover:bg-white/60 hover:text-foreground dark:hover:bg-white/5"
                  }`}
                >
                  <Icon className="w-5 h-5" strokeWidth={1.8} />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>          <div className="flex-1" />

          <div className="mx-3 mb-3">
            <SyncStatus />
          </div>

          <div className="mx-3 mb-3 rounded-[20px] border border-[hsl(var(--border))] bg-white/65 dark:bg-white/5 p-3">
            <p className="text-xs font-semibold">
              {firstName}
            </p>

            <p className="text-[10px] text-muted-foreground truncate">
              {user?.email || "Art Flow Creative"}
            </p>
          </div>

          <div className="mx-3 mb-3 rounded-[20px] border border-[hsl(var(--border))] bg-white/65 dark:bg-white/5 p-3 flex items-center">
            <span className="text-[11px] font-medium">
              Theme
            </span>

            <div className="ml-auto flex gap-1">
              <button
                type="button"
                onClick={() => setTheme("light")}
                className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                  theme !== "dark"
                    ? "bg-white shadow-sm text-purple-600"
                    : "text-muted-foreground"
                }`}
              >
                <Sun className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={() => setTheme("dark")}
                className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                  theme === "dark"
                    ? "bg-[hsl(var(--primary))] text-white"
                    : "text-muted-foreground"
                }`}
              >
                <Moon className="w-4 h-4" />
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => logout(true)}
            className="mx-3 mb-4 flex items-center gap-2 px-4 py-3 rounded-2xl text-xs font-medium text-pink-500 hover:bg-pink-50 dark:hover:bg-pink-500/10"
          >
            <LogOut className="w-4 h-4" />
            Log Out
          </button>
        </div>
      </aside>
      <div className="lg:ml-[260px] min-h-screen">
        <header className="hidden lg:flex sticky top-0 z-30 items-center px-7 xl:px-10 pt-5 pb-3">
          <div className="ml-auto flex items-center gap-3">
            <form
              onSubmit={submitSearch}
              className="artflow-glass w-[380px] h-11 rounded-full border flex items-center px-4"
              role="search"
            >
              <Search className="w-4 h-4 text-muted-foreground" />

              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search orders by product or order ID..."
                aria-label="Search orders"
                className="flex-1 bg-transparent border-0 outline-none px-3 text-xs text-foreground placeholder:text-muted-foreground"
              />
            </form>

            <button
              type="button"
              onClick={() => navigate("/orders")}
              aria-label="View recent orders"
              title="View recent orders"
              className="artflow-glass relative w-11 h-11 rounded-2xl border flex items-center justify-center"
            >
              <Bell className="w-5 h-5 text-[hsl(var(--primary))]" />
            </button>
          </div>
        </header>

        <main className="max-w-[1700px] mx-auto px-4 sm:px-5 lg:px-7 xl:px-10 pb-28 lg:pb-10 overflow-x-hidden">
          {tabs.map(({ path, Comp }) => (
            <div
              key={path}
              style={{
                display: pathname === path ? "block" : "none",
              }}
            >
              <Comp />
            </div>
          ))}

          {!tabPaths.has(pathname) && (
            <div key={pathname} className="screen-slide">
              <Outlet />
            </div>
          )}
        </main>
      </div>

      <div className="lg:hidden">
        <BottomNav />
      </div>
    </div>
  );
}
