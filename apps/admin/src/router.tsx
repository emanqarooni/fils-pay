import { createBrowserRouter, Navigate, useRouteError } from "react-router-dom";
import { AdminLayout } from "./components/AdminLayout.js";
import { RequireAdminAuth } from "./components/RequireAdminAuth.js";
import { AdjustmentImportPage } from "./pages/adjustments/AdjustmentImportPage.js";
import { CreditsPage } from "./pages/credits/CreditsPage.js";
import { LoginPage } from "./pages/login/LoginPage.js";
import { MerchantListPage } from "./pages/merchants/MerchantListPage.js";
import { MerchantDetailPage } from "./pages/merchants/MerchantDetailPage.js";
import { SettlementPage } from "./pages/settlement/SettlementPage.js";
import { WebhookReplayPage } from "./pages/webhooks/WebhookReplayPage.js";

// BUG FIXED: React Router shows an ugly default screen if a route crashes or is missing.
// We create a custom ErrorBoundary to catch it and show a nice page.
function ErrorBoundary() {
  const error = useRouteError() as any;
  return (
    <div className="admin-centered">
      <h1>Something went wrong</h1>
      <p className="admin-error">
        {error?.statusText || error?.message || "The page you are looking for does not exist."}
      </p>
      <a href="/merchants">Go back to the dashboard</a>
    </div>
  );
}

export const router = createBrowserRouter([
  { 
    path: "/login", 
    element: <LoginPage />,
    errorElement: <ErrorBoundary />, 
  },
  {
    // Everything below the login screen shares one shell and one guard.
    element: (
      <RequireAdminAuth>
        <AdminLayout />
      </RequireAdminAuth>
    ),
    errorElement: <ErrorBoundary />,
    children: [
      { path: "/", element: <Navigate to="/merchants" replace /> },
      { path: "/merchants", element: <MerchantListPage /> },
      { path: "/merchants/:id", element: <MerchantDetailPage /> },
      { path: "/credits", element: <CreditsPage /> },
      { path: "/settlement", element: <SettlementPage /> },
      { path: "/adjustment-imports", element: <AdjustmentImportPage /> },
      { path: "/webhooks", element: <WebhookReplayPage /> },
      { path: "/webhooks/:merchantId", element: <WebhookReplayPage /> },
      // BUG FIXED: Added a catch-all wildcard route.
      // If someone types a bad URL, it redirects them safely instead of crashing.
      { path: "*", element: <Navigate to="/merchants" replace /> },
    ],
  },
]);