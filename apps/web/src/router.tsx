import { createBrowserRouter, Navigate, Outlet, useRouteError } from "react-router-dom";
import { CheckoutPage } from "./pages/checkout/CheckoutPage.js";
import { DashboardAuthProvider } from "./auth/DashboardAuthContext.js";
import { RequireDashboardAuth } from "./auth/RequireDashboardAuth.js";
import { RoleGatedPage } from "./auth/RequireRole.js";
import { DashboardLayout } from "./components/DashboardLayout.js";
import { LoginPage } from "./pages/dashboard-login/LoginPage.js";
import { TransactionListPage } from "./pages/transactions/TransactionListPage.js";
import { TransactionDetailPage } from "./pages/transactions/TransactionDetailPage.js";
import { PaymentLinkListPage } from "./pages/payment-links/PaymentLinkListPage.js";
import { PaymentLinkCreatePage } from "./pages/payment-links/PaymentLinkCreatePage.js";
import { PaymentLinkDetailPage } from "./pages/payment-links/PaymentLinkDetailPage.js";
import { WebhookEndpointListPage } from "./pages/webhooks/WebhookEndpointListPage.js";
import { WebhookEndpointCreatePage } from "./pages/webhooks/WebhookEndpointCreatePage.js";
import { WebhookEndpointDetailPage } from "./pages/webhooks/WebhookEndpointDetailPage.js";
import { SettlementBatchListPage } from "./pages/settlement/SettlementBatchListPage.js";
import { SettlementBatchDetailPage } from "./pages/settlement/SettlementBatchDetailPage.js";
import { ReconciliationPage } from "./pages/settlement/ReconciliationPage.js";
import { OverviewPage } from "./pages/overview/OverviewPage.js";

// BUG FIXED: Added a custom ErrorBoundary to catch crashes and 404s gracefully.
function ErrorBoundary() {
  const error = useRouteError() as any;
  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>Unexpected Application Error!</h1>
      <p style={{ color: "red" }}>
        {error?.statusText || error?.message || "The page you are looking for does not exist."}
      </p>
      <a href="/dashboard">Go back to the dashboard</a>
    </div>
  );
}

export const router = createBrowserRouter([
  // BUG FIXED: Added a redirect for the root "/" so it doesn't crash.
  { path: "/", element: <Navigate to="/dashboard" replace />, errorElement: <ErrorBoundary /> },
  
  { path: "/pay/:token", element: <CheckoutPage />, errorElement: <ErrorBoundary /> },

  {
    element: (
      <DashboardAuthProvider>
        <Outlet />
      </DashboardAuthProvider>
    ),
    errorElement: <ErrorBoundary />,
    children: [
      { path: "/dashboard/login", element: <LoginPage /> },
      {
        element: (
          <RequireDashboardAuth>
            <DashboardLayout />
          </RequireDashboardAuth>
        ),
        children: [
          { path: "/dashboard", element: <Navigate to="/dashboard/transactions" replace /> },
          { path: "/dashboard/transactions", element: <TransactionListPage /> },
          { path: "/dashboard/transactions/:id", element: <TransactionDetailPage /> },
          { path: "/dashboard/payment-links", element: <PaymentLinkListPage /> },
          {
            path: "/dashboard/payment-links/new",
            element: (
              <RoleGatedPage allow={["owner", "finance"]} title="New payment link">
                <PaymentLinkCreatePage />
              </RoleGatedPage>
            ),
          },
          { path: "/dashboard/payment-links/:id", element: <PaymentLinkDetailPage /> },
          {
            path: "/dashboard/webhooks",
            element: (
              <RoleGatedPage allow={["owner", "finance"]} title="Webhook endpoints">
                <WebhookEndpointListPage />
              </RoleGatedPage>
            ),
          },
          {
            path: "/dashboard/webhooks/new",
            element: (
              <RoleGatedPage allow={["owner", "finance"]} title="New webhook endpoint">
                <WebhookEndpointCreatePage />
              </RoleGatedPage>
            ),
          },
          {
            path: "/dashboard/webhooks/:id",
            element: (
              <RoleGatedPage allow={["owner", "finance"]} title="Webhook endpoint">
                <WebhookEndpointDetailPage />
              </RoleGatedPage>
            ),
          },
          { path: "/dashboard/settlement", element: <SettlementBatchListPage /> },
          { path: "/dashboard/settlement/:id", element: <SettlementBatchDetailPage /> },
          { path: "/dashboard/reconciliation", element: <ReconciliationPage /> },
          { path: "/dashboard/overview", element: <OverviewPage /> },
        ],
      },
    ],
  },
  // BUG FIXED: Added a wildcard catch-all to redirect any bad URL back to the dashboard.
  { path: "*", element: <Navigate to="/dashboard" replace /> },
]);