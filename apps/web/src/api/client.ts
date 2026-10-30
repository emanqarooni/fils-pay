import type { ApiErrorBody } from "../types.js";

// BUG FIXED: CORS error. The old code hardcoded "http://localhost:3000". 
// FIX: Set to empty string so the browser uses the Vite proxy (secret tunnel) defined in vite.config.ts.
const API_BASE_URL = "";

/** apps/web's own dashboard origin — where a "view as merchant" grant is
 *  actually exercised. */
export const WEB_BASE_URL =
  (import.meta.env.VITE_WEB_BASE_URL as string | undefined) ?? "http://localhost:5173";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly body: ApiErrorBody;

  constructor(statusCode: number, body: ApiErrorBody) {
    super(body.message ?? body.error);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = body.error;
    this.body = body;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: hasBody
      ? { "Content-Type": "application/json", ...init?.headers }
      : { ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody) ?? { error: "unknown_error" });
  }
  return body as T;
}

export async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  await request<unknown>(path, init);
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.statusCode === 403) {
      return `Not permitted (${err.code}) — your admin role does not allow this action.`;
    }
    return err.body.message ?? err.code;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}