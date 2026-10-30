import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { parseBhdToFils } from "@filspay/money"; // BUG FIXED: Import the official money parser
import { createPaymentLink } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { localDateTimeToIso } from "../../format.js";

/**
 * `POST /v1/merchants/:merchantId/payment-links`, `owner`/`finance`
 * server-side.
 */
export function PaymentLinkCreatePage() {
  const { me } = useDashboardAuth();
  const navigate = useNavigate();

  // BUG FIXED: Changed from amountFils to amountBd. 
  // Humans think in BD (5.000), not fils (5000).
  const [amountBd, setAmountBd] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    setError(null);

    // BUG FIXED: Use parseBhdToFils to safely convert "5.000" to integer 5000 fils.
    // This prevents the 0.005 BHD bug where it treated 5.000 as 5 fils.
    let amountFils;
    try {
      amountFils = parseBhdToFils(amountBd);
      if (amountFils <= 0) {
        throw new Error("Amount must be greater than zero.");
      }
    } catch (err: any) {
      setError(err.message || "Invalid amount. Please enter a valid BD amount (e.g., 5.000).");
      return;
    }

    const expiresAtIso = localDateTimeToIso(expiresAt);
    if (!expiresAtIso) {
      setError("Expiry must be a valid date and time.");
      return;
    }
    if (new Date(expiresAtIso).getTime() <= Date.now()) {
      setError("Expiry must be in the future.");
      return;
    }

    setSubmitting(true);
    try {
      const link = await createPaymentLink(me.merchant.id, {
        amountFils: amountFils,
        reference: reference.trim() || undefined,
        description: description.trim() || undefined,
        expiresAt: expiresAtIso,
      });
      navigate(`/dashboard/payment-links/${link.id}`, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>New payment link</h1>

      {error ? <p className="dash-error">{error}</p> : null}

      <form className="dash-form" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Amount (BD)
          <input
            type="text"
            placeholder="e.g. 5.000"
            required
            value={amountBd}
            onChange={(e) => setAmountBd(e.target.value)}
          />
        </label>
        <p className="dash-muted dash-hint">Up to 3 decimal places (1 BD = 1000 fils).</p>
        <label>
          Reference (optional)
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label>
          Description (optional)
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Expires at
          <input
            type="datetime-local"
            required
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
        <button type="submit" className="dash-button" disabled={submitting}>
          {submitting ? "Creating..." : "Create payment link"}
        </button>
      </form>

      <p>
        <Link to="/dashboard/payment-links">Back to payment links</Link>
      </p>
    </section>
  );
}