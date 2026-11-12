package slog

import (
	"bytes"
	"strings"
	"testing"
)

func TestTextHandlerOutput(t *testing.T) {
	var buf bytes.Buffer
	logger := New(NewTextHandler(&buf, &HandlerOptions{Level: LevelInfo}))
	logger.Info("hello", String("key", "value"), Int("n", 3))

	out := buf.String()
	for _, want := range []string{"level=INFO", "msg=hello", "key=value", "n=3"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output %q does not contain %q", out, want)
		}
	}
}

func TestLevelFiltering(t *testing.T) {
	var buf bytes.Buffer
	logger := New(NewTextHandler(&buf, &HandlerOptions{Level: LevelWarn}))
	logger.Info("dropped")
	logger.Warn("kept")

	if strings.Contains(buf.String(), "dropped") {
		t.Fatalf("info record should have been filtered: %q", buf.String())
	}
	if !strings.Contains(buf.String(), "kept") {
		t.Fatalf("warn record should have been written: %q", buf.String())
	}
}

func TestAttrHelpers(t *testing.T) {
	if got := String("k", "v").Key; got != "k" {
		t.Fatalf("String key = %q, want k", got)
	}
	if got := Group("g", String("k", "v")).Key; got != "g" {
		t.Fatalf("Group key = %q, want g", got)
	}
}
