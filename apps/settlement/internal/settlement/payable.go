package settlement

import (
	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	// BUG FIXED: Used float32 and math.Round, violating ADR-0001.
	// This caused the "Lifetime payout estimate drifts" and small fils gaps.
	// Money is integer fils. Just subtract.
	return grossFils - feeFils
}