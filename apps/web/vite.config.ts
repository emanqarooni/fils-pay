import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // BUG: login failed with "Failed to fetch". The browser blocked calls from
    // :5173 to the API on :3000 (CORS), because the API sends no CORS headers.
    // FIX: proxy /v1 through Vite so the browser only talks to :5173, and set
    // VITE_API_BASE_URL= (empty) in apps/web/.env.local so requests stay same-origin.
    proxy: {
      "/v1": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
});
