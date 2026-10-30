import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { logout as logoutRequest, me as fetchMe } from "../api/dashboardAuth.js";
import type { DashboardMe } from "../types.js";

export type DashboardAuthStatus = "loading" | "authenticated" | "anonymous";

export interface DashboardAuthValue {
  status: DashboardAuthStatus;
  me: DashboardMe | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const DashboardAuthReactContext = createContext<DashboardAuthValue | null>(null);

const LAST_MERCHANT_ID_KEY = "filspay.dashboard.lastMerchantId";

export function readLastMerchantId(): string {
  try {
    return window.localStorage.getItem(LAST_MERCHANT_ID_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeLastMerchantId(merchantId: string): void {
  try {
    window.localStorage.setItem(LAST_MERCHANT_ID_KEY, merchantId);
  } catch {
    // Nothing depends on this succeeding.
  }
}

// BUG FIXED: Added a clear function so we can wipe the saved ID on logout.
export function clearLastMerchantId(): void {
  try {
    window.localStorage.removeItem(LAST_MERCHANT_ID_KEY);
  } catch {}
}

export function DashboardAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DashboardAuthStatus>("loading");
  const [me, setMe] = useState<DashboardMe | null>(null);

  const refresh = useCallback(async () => {
    try {
      const current = await fetchMe();
      setMe(current);
      setStatus("authenticated");
    } catch {
      setMe(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      setMe(null);
      setStatus("anonymous");
      // BUG FIXED: Clear the saved merchant ID so the next login is clean. 
      // Before, it kept the old ID and confused the next login.
      clearLastMerchantId();
    }
  }, []);

  const value = useMemo<DashboardAuthValue>(
    () => ({ status, me, refresh, signOut }),
    [status, me, refresh, signOut],
  );

  return (
    <DashboardAuthReactContext.Provider value={value}>{children}</DashboardAuthReactContext.Provider>
  );
}

export function useDashboardAuth(): DashboardAuthValue {
  const value = useContext(DashboardAuthReactContext);
  if (!value) {
    throw new Error("useDashboardAuth: must be used inside <DashboardAuthProvider>");
  }
  return value;
}