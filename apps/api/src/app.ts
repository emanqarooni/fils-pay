import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { createAcquirerSimulator } from "./acquirer/simulator.js";
import { cookiesPlugin } from "./plugins/cookies.js";
import { multipartPlugin } from "./plugins/multipart.js";
import { errorHandler } from "./plugins/errorHandler.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { businessProfileRoutes } from "./routes/businessProfile.js";
import { kycRoutes } from "./routes/kyc.js";
import { apiKeyRoutes } from "./routes/apiKeys.js";
import { transactionRoutes } from "./routes/transactions.js";
import { refundRoutes } from "./routes/refunds.js";
import { paymentLinkMerchantRoutes, paymentLinkPublicRoutes } from "./routes/paymentLinks.js";
import { webhookEndpointRoutes } from "./routes/webhooks.js";
import { settlementRoutes } from "./routes/settlement.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { reportingRoutes } from "./routes/reporting.js";
import { adminRoutes, type AdminRoutesOptions } from "./routes/admin.js";
import { acquirerCallbackRoutes } from "./routes/acquirerCallbacks.js";
import { createFetchTransport, type WebhookTransport } from "./webhooks/transport.js";

export interface BuildAppOptions {
  admin?: AdminRoutesOptions;
  webhookTransport?: WebhookTransport;
}

export function buildApp(config: Config, pool: Pool, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  app.decorate("db", pool);
  app.decorate("config", config);
  app.decorate("acquirer", createAcquirerSimulator(config));
  app.decorate("webhookTransport", options.webhookTransport ?? createFetchTransport());

  // BUG FIXED: Added CORS support. Without this, apps/web (5173) and apps/admin (5174) 
  // get blocked by the browser because the API is on port 3000.
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && (origin.startsWith("http://localhost:") || origin.includes("filspay"))) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, Acquirer-Callback-Signature");
    }
    
    if (request.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  app.register(cookiesPlugin);
  app.register(multipartPlugin, { config });
  app.setErrorHandler(errorHandler);

  app.register(healthRoutes);
  app.register(authRoutes, { prefix: "/v1/auth" });
  app.register(businessProfileRoutes, { prefix: "/v1/merchants" });
  app.register(kycRoutes, { prefix: "/v1/merchants" });
  app.register(apiKeyRoutes, { prefix: "/v1/merchants" });
  app.register(transactionRoutes, { prefix: "/v1/transactions" });
  app.register(refundRoutes, { prefix: "/v1/refunds" });
  app.register(paymentLinkMerchantRoutes, { prefix: "/v1/merchants" });
  app.register(paymentLinkPublicRoutes, { prefix: "/v1/payment-links" });
  app.register(webhookEndpointRoutes, { prefix: "/v1/merchants" });
  app.register(settlementRoutes, { prefix: "/v1/settlement" });
  app.register(analyticsRoutes, { prefix: "/v1/analytics" });
  app.register(reportingRoutes, { prefix: "/v1/reporting" });
  app.register(acquirerCallbackRoutes, { prefix: "/v1/acquirer" });
  app.register(adminRoutes, { ...(options.admin ?? {}), prefix: "/v1/admin" });

  return app;
}