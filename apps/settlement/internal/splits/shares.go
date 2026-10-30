package splits

import "github.com/filspay/settlement/internal/money"

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ChildShares distributes netPayout across children by their weights.
//
// BUG (finance memo): "the three child payouts don't add up to the parent's
// total. It's small, a few tens of fils each batch, but it happens every
// batch since launch. Where do the missing fils go?"
//
// ROOT CAUSE: each child was computed independently with ApplyRateFils
// (basis-point rounding). Rounding is per-child, so sum(round(x_i)) can be
// less than netPayout — every batch leaves a few fils unallocated, and
// nothing in the ledger ever picks them up.
//
// FIX: largest-remainder allocation. Compute each child's exact share as an
// integer division (floor), sum the floors, then distribute the leftover
// fils one at a time to the children with the largest remainder. The result
// is guaranteed to sum exactly to netPayout (a conservation invariant the
// reconciliation report can then rely on), and is deterministic: ties are
// broken by ascending index.
//
// Same family as packages/money allocateRemainder (TS) and
// apps/settlement/internal/money's bankers-rounding helpers.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	if len(children) == 0 || netPayout <= 0 {
		return out
	}

	var totalWeight int64
	for _, c := range children {
		if c.WeightBps < 0 {
			// Negative weights are a config error, not something to paper
			// over silently — treat the row as zero so a stray row cannot
			// pull another child's share below zero.
			continue
		}
		totalWeight += c.WeightBps
	}
	if totalWeight <= 0 {
		return out
	}

	remainders := make([]int64, len(children))
	var allocated int64
	for i, c := range children {
		if c.WeightBps < 0 {
			continue
		}
		num := int64(netPayout) * c.WeightBps
		share := num / totalWeight
		remainders[i] = num % totalWeight
		out[i] = money.Fils(share)
		allocated += share
	}

	// leftover < len(children): floor division loses strictly fewer fils
	// than there are children (each floor loses < 1). Distribute to the
	// largest remainders, ties by lower index.
	leftover := int64(netPayout) - allocated
	for leftover > 0 {
		best := -1
		for i := range children {
			if remainders[i] < 0 {
				continue
			}
			if best == -1 || remainders[i] > remainders[best] {
				best = i
			}
		}
		if best == -1 {
			break
		}
		out[best]++
		remainders[best] = -1 // this child already took its extra fil
		leftover--
	}

	return out
}