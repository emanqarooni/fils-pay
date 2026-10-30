import type { FastifyInstance } from "fastify";
import { requireMerchantAuth } from "../auth/requireMerchantAuth.js";
import { initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";

export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", { preHandler: requireMerchantAuth }, async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    if (!idempotencyKey) {
      throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
    }

    // We assume initiateMerchantRefund handles validation of the body safely
    const result = await initiateMerchantRefund(app.db, app.acquirer, {
      merchantId: request.merchantAuth!.merchantId,
      ...(request.body as any),
      idempotencyKey,
    });
    
    reply.code(result.statusCode).send(result.body);
  });
}