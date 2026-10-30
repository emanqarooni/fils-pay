FilsPay Correctness & Security Findings Report
Team: Debug Detectives
Prepared by: Eman Qarooni, Fatima Zaid

1. Executive Summary
This report documents the critical correctness and security bugs found in FilsPay, drawn from the provided case files (FilsPay_1_Briefing_Card, FilsPay_2_Finance_Memo, FilsPay_3_Incident_Log).

During the audit, we identified 15 major bugs affecting money handling, tenant isolation, and settlement integrity. All critical bugs have been fixed using the smallest possible changes, with a strong emphasis on database-level constraints, row locking, and idempotency.

Key fixes include:

Preventing cross-merchant refunds and refunds exceeding captured amounts.

Eliminating race conditions in concurrent refunds and payment links.

Fixing settlement rounding errors and timezone drift.

Ensuring webhook signatures match exactly what is sent.

2. Critical Money & Security Fixes (API)
F-01 & F-02: Cross-Merchant Refunds & Authorization Bypass
Severity: Critical

Files: apps/api/src/refunds/initiateMerchantRefund.ts, apps/api/src/payments/processRefund.ts

Root Cause: The refund lookup used the transaction ID only. A merchant could pass another merchant's transaction ID and refund it. Additionally, client-supplied body fields could override the authenticated merchantId and actor.

Fix:

initiateMerchantRefund.ts now explicitly checks if (!txn || txn.merchant_id !== input.merchantId) before proceeding.

processRefund.ts takes merchantId and actor strictly from the authenticated context. It uses a SQL query scoped to the merchant: WHERE id = $1 AND merchant_id = $2.

Verification: Code comment: "BUG FIXED: Must check if transaction belongs to this merchant."

F-03: Refund Exceeding Captured Amount
Severity: Critical

File: apps/api/src/payments/refundValidation.ts

Root Cause: The refund limit was using the authorized amount instead of the captured amount.

Fix: The refundableAmount() function now strictly calculates capturedFils - refundedFils. The validation explicitly rejects requests where requested > refundable.

Verification: Code comment: "BUG FIXED: pass refundedFils directly."

F-04: Concurrent Refunds (Double-Spend)
Severity: Critical

File: apps/api/src/payments/processRefund.ts

Root Cause: Two simultaneous refund requests could read the same pre-refund balance and both succeed.

Fix: The entire refund operation is wrapped in a database transaction (withTransaction). It uses SELECT ... FOR UPDATE on the transaction row to lock it, preventing concurrent reads. It also uses an idempotency key (claimIdempotencyKey) to deduplicate retries.

Verification: Code comment: "BUG FIXED: Hold the lock through the acquirer call so two refunds can't double-spend."

F-20: Cross-Merchant Payment Link Cancellation
Severity: High

File: apps/api/src/paymentLinks/cancel.ts

Root Cause: The cancellation route was scoped by link ID only.

Fix: The SQL query now enforces WHERE id = $1 AND merchant_id = $2 AND status = 'active'. If Merchant A tries to cancel Merchant B's link, the query affects 0 rows and returns not_found.

3. Payment Link Race Conditions (Checkout)
F-05: Expired Payment Link Charged
Severity: Critical

File: apps/api/src/paymentLinks/pay.ts

Root Cause: The server trusted the checkout page's client-side submittedAt timestamp to check expiry.

Fix: The code now strictly uses server time: const expiryCheckTime = new Date(); and adds AND expires_at > $3 to the atomic claim query.

Verification: Code comment: "BUG FIXED: Always use server time, ignore buyer's submittedAt."

F-06: Double-Charged Payment Link
Severity: Critical

File: apps/api/src/paymentLinks/pay.ts

Root Cause: A slow payment allowed a second buyer to claim the same link before the first finished.

Fix: The link is claimed atomically using an UPDATE ... SET status = 'reserved' query. A server-generated idempotency key is bound directly to the link (paylink:${link.id}:process), preventing a second authorization.

Verification: Code comment: "BUG FIXED: Idempotency key is bound to the link, not the client. Two buyers cannot double charge."

4. Settlement & Reconciliation Fixes (Go Daemon)
F-17: Daily Close Running at 3 AM
Severity: Medium

File: apps/settlement/internal/settlement/window.go

Root Cause: The host timezone (UTC) was used to calculate the business day boundary, causing the close to drift into the early hours of the next day.

Fix: The code explicitly loads Asia/Bahrain time and converts the date to Bahrain time before extracting the day, month, and year.

Verification: Code comment: "BUG FIXED: date.Date() uses the host's timezone... We must convert to Bahrain time first."

F-18: Test Merchants Settled in Production
Severity: High

File: apps/settlement/internal/settlement/batch.go

Root Cause: The settlement query did not filter out merchants marked as test accounts.

Fix: Both RunDailyBatch and CloseBatch now explicitly filter WHERE status = 'active' AND test_mode = false.

Verification: Code line: SELECT id FROM merchants WHERE status = 'active' AND test_mode = false.

F-12: Scheme Statement Total Rounding Error
Severity: High

File: apps/settlement/internal/settlement/batch.go

Root Cause: Truncating settlement amounts to 2 decimals (multiples of 10 fils) left a residue that was lost, causing the scheme total to be higher than FilsPay's ledger.

Fix: Inside CloseBatch, the code calculates the residue := line.grossFils - truncated. It then inserts double-entry ledger rows debiting scheme_rounding_residue and crediting card_scheme_clearing.

Verification: Code comment: "BUG FIXED (ADR-0002): Journal scheme rounding residue at export."

F-14: Split Payouts & Lifetime Estimate Drift
Severity: High

File: apps/settlement/internal/settlement/payable.go

Root Cause: The code used float32 and math.Round to calculate net payouts, violating ADR-0001 (integer fils).

Fix: The function now simply returns grossFils - feeFils.

Verification: Code comment: "BUG FIXED: Used float32... Money is integer fils. Just subtract."

F-09: MDR Recalculation Changing Paid Batches
Severity: High

File: apps/settlement/internal/settlement/recalculate_mdr.go

Root Cause: The query to recalculate MDR was touching batches that were already paid out.

Fix: The SQL query now explicitly filters AND status = 'closed'. This prevents it from touching paid batches.

Verification: Code snippet: AND status = 'closed'.

5. Webhooks & Data Import Fixes
F-15: Merchants Rejecting Webhook Signatures
Severity: High

File: apps/api/src/webhooks/sign.ts

Root Cause: The signing side serialized objects differently than the sending side, causing the HMAC to mismatch.

Fix: Added getPayloadString(). If a raw string (the exact bytes sent over the wire) is passed, it signs it as-is. It also enforces constant-time comparison (timingSafeEqualHex).

Verification: Code comment: "Helper to ensure we sign exactly what we send."

F-11: CSV Import Misreading BD Amounts
Severity: High

File: apps/api/src/admin/adjustmentCsvParsing.ts

Root Cause: The old code parsed decimal BD values as cents (×100), so 4.75 became 0.475.

Fix: The parser now uses a strict regex ^-?\d+(\.\d{1,3})?$ and parses the value to integer fils using Math.round(parsed * 1000).

Verification: Code comment: "BUG FIXED: Finance memo says '4.755 BD became 0.475'. Old code parsed as cents... We must parse to fils."

6. Authentication & Admin Fixes
F-19: Login Bypassing OTP
Severity: Critical

Files: apps/web/src/pages/dashboard-login/LoginPage.tsx, apps/web/src/auth/DashboardAuthContext.tsx

Root Cause: The login flow was not enforcing the OTP step, and stale merchant IDs were persisting.

Fix: LoginPage.tsx now uses a strict state machine (Step = { kind: "credentials" } | { kind: "otp" }). It forces the user into the OTP step and calls verifyOtp before granting access. DashboardAuthContext.tsx now calls clearLastMerchantId() on logout to prevent session bleed.

Verification: Code comment: "BUG FIXED: Added a clear function so we can wipe the saved ID on logout."

Admin Router Safety
File: apps/admin/src/router.tsx

Fix: Added an ErrorBoundary and a catch-all wildcard route { path: "*", element: <Navigate to="/merchants" replace /> } to prevent crashes on invalid URLs.

7. Setup & Migration Fixes (from BUGFIXES.md)
These were previously documented and confirmed fixed:

Dockerfile: Created missing ops/Dockerfile.node.

Migration 0054: Fixed view to use transaction_events.settlement_batch_id.

Migration 0055: Fixed column names to id, name, kind.

Seed Key: Fixed encryption key to be exactly 32 bytes.

CORS: Added Vite proxy in vite.config.ts to fix "Failed to fetch".