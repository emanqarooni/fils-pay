-- BUG: this insert used columns (code, account_type) that chart_of_accounts does not have.
-- FIX: use the real columns (id, name, kind) and kind = asset, like scheme_rounding_residue in 0007.
-- Additional suspense accounts for future reconciliation lanes.
-- Uses the real chart_of_accounts columns (id, name, kind); suspense
-- accounts are modelled as 'asset', same as scheme_rounding_residue (0007).

-- BUG FIXED: The old developer used columns (code, account_type, description) 
-- which do not exist in the 0007 schema. The actual columns are (id, name, kind).
-- Also, the 'kind' column has a CHECK constraint allowing only 'asset', 'liability', or 'revenue'.
-- We use 'asset' to match the existing 'scheme_rounding_residue' account.

INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX Rounding Difference', 'asset'),
  ('chargeback_suspense', 'Chargeback Suspense', 'asset')
ON CONFLICT (id) DO NOTHING;
