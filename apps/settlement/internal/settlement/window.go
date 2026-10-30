package settlement

import (
	"fmt"
	"time"
)

// businessDayLocation is the settlement business day's fixed timezone:
// Asia/Bahrain local time (UTC+3, no DST).
var businessDayLocation = mustLoadLocation("Asia/Bahrain")

func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(fmt.Sprintf("settlement: failed to load timezone %q: %v", name, err))
	}
	return loc
}

// BusinessDayWindow returns the [start, end) UTC instants bounding the
// given calendar date's Asia/Bahrain business day.
func BusinessDayWindow(date time.Time) (start, end time.Time) {
	// BUG FIXED: date.Date() uses the host's timezone (often UTC). 
	// If it's 11 PM UTC, it's already the next day in Bahrain. 
	// We must convert to Bahrain time first, then extract the date.
	dateInBahrain := date.In(businessDayLocation)
	y, m, d := dateInBahrain.Date()
	
	start = time.Date(y, m, d, 0, 0, 0, 0, businessDayLocation)
	end = start.AddDate(0, 0, 1)
	return start, end
}