-- Additional suspense accounts for future reconciliation lanes.

-- BUG FIXED: The old developer used columns (code, account_type, description) 
-- which do not exist in the 0007 schema. The actual columns are (id, name, kind).
-- Also, the 'kind' column has a CHECK constraint allowing only 'asset', 'liability', or 'revenue'.
-- We use 'asset' to match the existing 'scheme_rounding_residue' account.

INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX Rounding Difference', 'asset'),
  ('chargeback_suspense', 'Chargeback Suspense', 'asset')
ON CONFLICT (id) DO NOTHING;