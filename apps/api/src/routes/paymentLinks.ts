import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { createPaymentLink } from "../paymentLinks/create.js";
import { getPublicPaymentLink } from "../paymentLinks/read.js";
import { payPaymentLink } from "../paymentLinks/pay.js";
import { cancelPaymentLink } from "../paymentLinks/cancel.js";
import { listPaymentLinks } from "../paymentLinks/query.js";
import { serializePaymentLink } from "../paymentLinks/serialize.js"; // BUG FIXED: Need this to serialize the single link
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import type { SimulatedCardInput } from "../acquirer/types.js";

interface MerchantIdParams {
  merchantId: string;
}

interface MerchantLinkIdParams extends MerchantIdParams {
  id: string;
}

interface TokenParams {
  token: string;
}

interface CreatePaymentLinkBody {
  amountFils?: number;
  reference?: string;
  description?: string;
  expiresAt?: string;
}

interface PayPaymentLinkBody {
  card?: SimulatedCardInput;
}

interface ListPaymentLinksQuery {
  status?: string | string[];
  limit?: string;
  cursor?: string;
}

function assertOwnMerchant(request: FastifyRequest<{ Params: MerchantIdParams }>): void {
  if (!request.merchantAuth || request.merchantAuth.merchantId !== request.params.merchantId) {
    throw new ForbiddenError("forbidden");
  }
}

function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

export async function paymentLinkMerchantRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: CreatePaymentLinkBody }>(
    "/:merchantId/payment-links",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      const { amountFils, reference, description, expiresAt } = request.body ?? {};
      if (amountFils === undefined || !expiresAt) {
        throw new BadRequestError("invalid_request", "amountFils and expiresAt are required");
      }

      const writer = requireMerchantWriterActor(request.merchantAuth!);
      const link = await createPaymentLink(app.db, app.config, {
        merchantId: request.params.merchantId,
        amountFils,
        reference,
        description,
        expiresAt,
        createdByType: writer.type,
        createdById: writer.id,
      });
      reply.code(201).send(link);
    },
  );

  app.get<{ Params: MerchantIdParams; Querystring: ListPaymentLinksQuery }>(
    "/:merchantId/payment-links",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertOwnMerchant(request);
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = q.limit !== undefined ? Number.parseInt(q.limit, 10) : undefined;

      return listPaymentLinks(app.db, app.config, {
        merchantId: request.params.merchantId,
        status,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );

  // BUG FIXED: Added a secure endpoint to fetch ONE specific payment link.
  // Previously, the UI downloaded all 100 links and filtered them in the browser, which was slow and leaked other merchants' data.
  app.get<{ Params: MerchantLinkIdParams }>(
    "/:merchantId/payment-links/:id",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertOwnMerchant(request);
      
      // Securely query by BOTH link ID and Merchant ID
      const result = await app.db.query(
        `SELECT * FROM payment_links WHERE id = $1 AND merchant_id = $2`,
        [request.params.id, request.params.merchantId]
      );
      
      if (result.rows.length === 0) {
        throw new NotFoundError("payment_link_not_found");
      }
      
      return serializePaymentLink(result.rows[0], app.config.checkoutBaseUrl);
    }
  );

  app.delete<{ Params: MerchantLinkIdParams }>(
    "/:merchantId/payment-links/:id",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      // BUG FIXED: pass merchantId to prevent Merchant A from canceling Merchant B's link
      const result = await cancelPaymentLink(app.db, {
        id: request.params.id,
        merchantId: request.params.merchantId,
      });
      if (result.outcome === "canceled") {
        reply.code(204).send();
        return;
      }
      if (result.outcome === "not_found") {
        throw new NotFoundError("payment_link_not_found");
      }
      throw new ConflictError("not_cancelable", `status: ${result.status}`);
    },
  );
}

export async function paymentLinkPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: TokenParams }>("/:token", async (request) => {
    const link = await getPublicPaymentLink(
      app.db,
      request.params.token,
      app.config.paymentLinkReservationTimeoutSeconds,
    );
    if (!link) {
      throw new NotFoundError("payment_link_not_found");
    }
    return link;
  });

  app.post<{ Params: TokenParams; Body: PayPaymentLinkBody }>("/:token/pay", async (request, reply) => {
    const idempotencyKey = getIdempotencyKey(request);
    const { card } = request.body ?? {};
    if (!card) {
      throw new BadRequestError("invalid_request", "card is required");
    }

    const result = await payPaymentLink(
      app.db,
      app.acquirer,
      { paymentLinkReservationTimeoutSeconds: app.config.paymentLinkReservationTimeoutSeconds },
      { token: request.params.token, card, idempotencyKey },
    );
    reply.code(result.statusCode).send(result.body);
  });
}