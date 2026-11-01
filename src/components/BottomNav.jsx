import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Home,
  ShoppingBag,
  Package,
  Receipt,
  MoreHorizontal,
  Calendar as CalendarIcon,
  Car,
  UserRound,
  Palette,
  BarChart3,
  Target,
  Calculator,
} from "lucide-react";

const primary = [
  { label: "Home", to: "/dashboard", icon: Home },
  { label: "Orders", to: "/orders", icon: ShoppingBag },
  { label: "Inventory", to: "/inventory", icon: Package },
  { label: "Expenses", to: "/expenses", icon: Receipt },
];

const more = [
  { label: "Reports", to: "/reports", icon: BarChart3 },
  { label: "Average Order Cost", to: "/average-order-cost", icon: BarChart3 },
  { label: "Mileage", to: "/mileage", icon: Car },
  { label: "Products", to: "/store-products", icon: Palette },
  { label: "Taxes", to: "/taxes", icon: Calculator },
  { label: "Business Plan", to: "/planning", icon: Target },
  { label: "Calendar", to: "/calendar", icon: CalendarIcon },
  { label: "Account", to: "/account", icon: UserRound },
];

const swipeTabs = [...primary, ...more];

export default function BottomNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  const [lastTap, setLastTap] = useState({});
  const swipeStartRef = useRef(null);

  useEffect(() => {
    const shouldIgnoreSwipe = (target) => {
      if (!(target instanceof Element)) return false;

      if (
        target.closest(
          "input, textarea, select, button, a, [role='slider'], [contenteditable='true'], [data-no-tab-swipe='true']"
        )
      ) {
        return true;
      }

      let node = target;
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        const horizontallyScrollable =
          /(auto|scroll)/.test(style.overflowX) &&
          node.scrollWidth > node.clientWidth + 4;

        if (horizontallyScrollable) return true;
        node = node.parentElement;
      }

      return false;
    };

    const handleTouchStart = (event) => {
      if (
        !window.matchMedia("(max-width: 1023px)").matches ||
        event.touches.length !== 1 ||
        shouldIgnoreSwipe(event.target)
      ) {
        swipeStartRef.current = null;
        return;
      }

      const touch = event.touches[0];
      swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
    };

    const handleTouchEnd = (event) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;

      if (!start || event.changedTouches.length !== 1) return;

      const touch = event.changedTouches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;

      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.35) return;

      const currentIndex = swipeTabs.findIndex((item) =>
        item.to === "/dashboard"
          ? pathname === "/dashboard"
          : pathname === item.to || pathname.startsWith(item.to + "/")
      );

      if (currentIndex < 0) return;

      const nextIndex = dx < 0 ? currentIndex + 1 : currentIndex - 1;
      if (nextIndex < 0 || nextIndex >= swipeTabs.length) return;

      setMoreOpen(false);
      navigate(swipeTabs[nextIndex].to);
      window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const clearSwipe = () => {
      swipeStartRef.current = null;
    };

    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });
    document.addEventListener("touchcancel", clearSwipe, { passive: true });

    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("touchcancel", clearSwipe);
    };
  }, [navigate, pathname]);

  const isActive = (to) =>
    to === "/dashboard"
      ? pathname === "/dashboard"
      : pathname === to || pathname.startsWith(to + "/");

  const moreActive = more.some((item) => isActive(item.to));

  const handleTab = (to) => {
    const now = Date.now();

    if (isActive(to) && lastTap[to] && now - lastTap[to] < 300) {
      navigate(to);
      window.scrollTo({ top: 0, behavior: "smooth" });
      setLastTap((state) => ({ ...state, [to]: 0 }));
      return;
    }

    setLastTap((state) => ({ ...state, [to]: now }));
    setMoreOpen(false);
    navigate(to);
  };

  const go = (to) => {
    setMoreOpen(false);
    navigate(to);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const tabs = [...primary, { label: "More", to: "__more", icon: MoreHorizontal }];

  return (
    <>
      {moreOpen && (
        <button
          type="button"
          aria-label="Close More menu"
          onClick={() => setMoreOpen(false)}
          className="fixed inset-0 z-[44] bg-black/5"
        />
      )}

      {moreOpen && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(max(1rem,env(safe-area-inset-bottom))+6.15rem)] z-[55] px-4">
          <div className="mx-auto flex max-w-md justify-end">
            <div
              className="pointer-events-auto w-[calc(100%-1.1rem)] max-w-[360px] rounded-[2rem] border border-white/5 p-3 shadow-[0_24px_70px_rgba(0,0,0,.52)] backdrop-blur-2xl"
              style={{
                background:
                  "linear-gradient(180deg, rgba(31,24,33,.97) 0%, rgba(26,20,29,.98) 100%)",
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                {more.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.to);

                  return (
                    <button
                      type="button"
                      key={item.to}
                      onClick={() => go(item.to)}
                      className={`flex min-h-[108px] flex-col items-center justify-center gap-3 rounded-[1.7rem] border px-3 py-4 text-center transition active:scale-[0.98] ${
                        active
                          ? "border-white/16 bg-white/14 text-white"
                          : "border-white/[0.035] bg-white/[0.075] text-white/90"
                      }`}
                    >
                      <Icon
                        className="h-7 w-7 text-white/85"
                        strokeWidth={1.8}
                      />
                      <span className="text-[15px] font-semibold leading-tight text-white/90">
                        {item.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <nav className="pointer-events-none fixed inset-x-0 bottom-0 z-50 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
        <div className="pointer-events-auto mx-auto max-w-md">
          <div className="flex items-center justify-between rounded-[1.75rem] border border-white/5 bg-[#050506] px-2 py-2 shadow-[0_16px_42px_rgba(0,0,0,.42)]">
            {tabs.map((item) => {
              const isMore = item.to === "__more";
              const active = isMore ? moreActive || moreOpen : isActive(item.to);
              const Icon = item.icon;

              return (
                <button
                  type="button"
                  key={item.label}
                  onClick={
                    isMore
                      ? () => setMoreOpen((open) => !open)
                      : () => handleTab(item.to)
                  }
                  className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 py-1.5"
                  aria-label={item.label}
                  aria-expanded={isMore ? moreOpen : undefined}
                >
                  <span
                    className={`grid h-11 w-12 place-items-center rounded-full transition ${
                      active
                        ? "bg-white text-black shadow-[0_8px_22px_rgba(255,255,255,.12)]"
                        : "text-[#8d8990]"
                    }`}
                  >
                    <Icon
                      className="h-[22px] w-[22px]"
                      strokeWidth={active ? 2.45 : 2}
                    />
                  </span>

                  <span
                    className={`text-xs font-medium transition-colors ${
                      active ? "text-white" : "text-[#9b97a0]"
                    }`}
                  >
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </nav>
    </>
  );
}
