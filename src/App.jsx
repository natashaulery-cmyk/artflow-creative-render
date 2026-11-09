import { Toaster } from "@/components/ui/toaster"
import { Toaster as SonnerToaster } from "@/components/ui/sonner"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { useState, useEffect } from 'react';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
import ProtectedRoute from '@/components/ProtectedRoute';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
import IndependentLogin from '@/pages/IndependentLogin';
import IndependentRegister from '@/pages/IndependentRegister';
import Layout from '@/components/Layout';
import Taxes from '@/pages/Taxes';
import Reports from '@/pages/Reports';
import AverageOrderCost from '@/pages/AverageOrderCost';
import BusinessPlan from '@/pages/BusinessPlan';
import Budget from '@/pages/Budget';
import { Navigate } from 'react-router-dom';
import { ThemeProvider } from "next-themes";
import Account from '@/pages/Account';
import Calendar from '@/pages/Calendar';
import Mileage from '@/pages/Mileage';
import PrivacyPolicy from '@/pages/PrivacyPolicy';
import TermsOfService from '@/pages/TermsOfService';
import AboutArtFlow from '@/pages/AboutArtFlow';
import Support from '@/pages/Support';
import MobileSaleCapture from '@/pages/MobileSaleCapture';
import AppleSubscriptionGate from '@/components/AppleSubscriptionGate';
import Logo from '@/components/Logo';
import Shop from '@/pages/Shop';
import ShopProduct from '@/pages/ShopProduct';
import ShopCart from '@/pages/ShopCart';
import ShopCheckout from '@/pages/ShopCheckout';
import ShopAccount from '@/pages/ShopAccount';
import StoreProducts from '@/pages/StoreProducts';
// Add page imports here

const TabShell = () => null;

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError } = useAuth();
  const [startupStalled, setStartupStalled] = useState(false);

  useEffect(() => {
    // Safety net for hung network requests (common on mobile connections):
    // if the auth check never resolves, offer a way into the app after 12s
    // instead of spinning forever.
    const timer = window.setTimeout(() => setStartupStalled(true), 12000);
    return () => window.clearTimeout(timer);
  }, []);

  // Legal pages must be publicly accessible for Google OAuth verification and app users.
  const publicPath = window.location.pathname.replace(/\/+$/, '') || '/';
  if (publicPath === '/' || publicPath === '/about' || publicPath === '/privacy' || publicPath === '/privacy-policy' || publicPath === '/terms-of-service' || publicPath === '/terms' || publicPath === '/support') {
    return (
      <Routes>
        <Route path="/" element={<AboutArtFlow />} />
        <Route path="/about" element={<AboutArtFlow />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/privacy-policy" element={<PrivacyPolicy />} />
        <Route path="/terms-of-service" element={<TermsOfService />} />
        <Route path="/terms" element={<TermsOfService />} />
        <Route path="/support" element={<Support />} />
        <Route path="*" element={<Navigate to="/privacy-policy" replace />} />
      </Routes>
    );
  }

  // Login and recovery pages must render even while authentication is broken or unresolved.
  if (publicPath === '/login' || publicPath === '/register' || publicPath === '/forgot-password' || publicPath === '/reset-password') {
    return (
      <Routes>
        <Route path="/login" element={<IndependentLogin />} />
        <Route path="/register" element={<IndependentRegister />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Show a visible branded splash while checking app public settings or auth.
  // A bare white page with a faint spinner looks like a blank screen on mobile.
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-5 bg-[hsl(var(--background))]">
        <Logo size={48} />
        <div className="w-9 h-9 border-4 border-[hsl(var(--border))] border-t-[hsl(var(--primary))] rounded-full animate-spin" />
        {startupStalled && (
          <p className="text-xs text-muted-foreground">
            Still starting…{' '}
            <a href="/login" className="text-[hsl(var(--primary))] font-semibold underline">
              Open the login screen
            </a>
          </p>
        )}
      </div>
    );
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      return <Navigate to="/login" replace />;
    }
  }

  // Render the main app
  return (
    <Routes>
      <Route path="/login" element={<IndependentLogin />} />
      <Route path="/register" element={<IndependentRegister />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/about" element={<AboutArtFlow />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/privacy-policy" element={<PrivacyPolicy />} />
      <Route path="/terms-of-service" element={<TermsOfService />} />
      <Route path="/terms" element={<TermsOfService />} />
      <Route path="/support" element={<Support />} />
      <Route path="/shop" element={<Shop />} />
      <Route path="/shop/product/:id" element={<ShopProduct />} />
      <Route path="/shop/cart" element={<ShopCart />} />
      <Route path="/shop/checkout" element={<ShopCheckout />} />
      <Route path="/shop/account" element={<ShopAccount />} />
      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        <Route element={<AppleSubscriptionGate><Layout /></AppleSubscriptionGate>}>
          <Route path="/dashboard" element={<TabShell />} />
          <Route path="/orders" element={<TabShell />} />
          <Route path="/inventory" element={<TabShell />} />
          <Route path="/expenses" element={<TabShell />} />
          <Route path="/taxes" element={<Taxes />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/average-order-cost" element={<AverageOrderCost />} />
          <Route path="/planning" element={<BusinessPlan />} />
          <Route path="/budget" element={<Budget />} />
          <Route path="/account" element={<Account />} />
          <Route path="/send-sale" element={<MobileSaleCapture />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/gallery" element={<Navigate to="/orders" replace />} />
          <Route path="/mileage" element={<Mileage />} />
          <Route path="/store-products" element={<StoreProducts />} />
        </Route>
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const isAuthPage = path === '/login' || path === '/register' || path === '/forgot-password' || path === '/reset-password';
  const isLegalPage = path === '/' || path === '/about' || path === '/privacy' || path === '/privacy-policy' || path === '/terms-of-service' || path === '/terms' || path === '/support';
  const isShopPage = path === '/shop' || path.startsWith('/shop/');

  // Render public/auth recovery pages without mounting AuthProvider at all.
  // This guarantees they still render even if the application auth service
  // is temporarily unavailable during startup.
  if (isAuthPage || isLegalPage || isShopPage) {
    return (
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem storageKey="artflow-theme-v57">
        <QueryClientProvider client={queryClientInstance}>
          <Router>
            <ScrollToTop />
            <Routes>
              <Route path="/login" element={<IndependentLogin />} />
              <Route path="/register" element={<IndependentRegister />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/shop" element={<Shop />} />
            <Route path="/shop/product/:id" element={<ShopProduct />} />
            <Route path="/shop/cart" element={<ShopCart />} />
            <Route path="/shop/checkout" element={<ShopCheckout />} />
            <Route path="/shop/account" element={<ShopAccount />} />
            <Route path="/" element={<AboutArtFlow />} />
            <Route path="/about" element={<AboutArtFlow />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
              <Route path="/privacy-policy" element={<PrivacyPolicy />} />
              <Route path="/terms-of-service" element={<TermsOfService />} />
              <Route path="/terms" element={<TermsOfService />} />
              <Route path="/support" element={<Support />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
          </Router>
          <Toaster />
          <SonnerToaster position="top-center" />
        </QueryClientProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem storageKey="artflow-theme-v57">
      <AuthProvider>
        <QueryClientProvider client={queryClientInstance}>
          <Router>
            <ScrollToTop />
            <AuthenticatedApp />
          </Router>
          <Toaster />
          <SonnerToaster position="top-center" />
        </QueryClientProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

export default App
