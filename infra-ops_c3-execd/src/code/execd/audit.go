package execd

import (
	"fmt"
	"io"
	"sync"
	"time"
)

// Auditor writes one line per call in audit.ts's stderr format. Arguments are never logged
// (an argv can carry secrets); only the tool, a caller-supplied short target and the result.
type Auditor struct {
	mu  sync.Mutex
	w   io.Writer
	now func() time.Time
}

func NewAuditor(w io.Writer) *Auditor { return &Auditor{w: w, now: time.Now} }

func (a *Auditor) Log(tool, target, result string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	fmt.Fprintf(a.w, "[c3-execd] [AUDIT] %s %s %s → %s\n", a.now().UTC().Format("2006-01-02T15:04:05.000Z"), tool, target, result)
}
