package federation

import (
	"sync"
	"time"
)

// cacheEntry is one TTL-bounded value. The cache is intentionally tiny: it
// absorbs repeated fleet queries and stats polling, never the per-viewer lens.
type cacheEntry struct {
	value   any
	expires time.Time
}

type ttlCache struct {
	mu    sync.Mutex
	items map[string]cacheEntry
}

func newTTLCache() *ttlCache { return &ttlCache{items: map[string]cacheEntry{}} }

func (c *ttlCache) get(key string) (any, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.items[key]
	if !ok || time.Now().After(entry.expires) {
		return nil, false
	}
	return entry.value, true
}

func (c *ttlCache) set(key string, value any, ttl time.Duration) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	// Opportunistic sweep: the key space is small (fleet queries), so this
	// keeps the map from growing without a background goroutine.
	if len(c.items) > 64 {
		now := time.Now()
		for k, entry := range c.items {
			if now.After(entry.expires) {
				delete(c.items, k)
			}
		}
	}
	c.items[key] = cacheEntry{value: value, expires: time.Now().Add(ttl)}
}
