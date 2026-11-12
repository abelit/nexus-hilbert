//go:build !go1.21

// Package slog re-exports log/slog on Go 1.21+ and golang.org/x/exp/slog on
// older toolchains. The package name stays "slog" so the legacy Edge build can
// rewrite the import path without changing call sites.
package slog

import (
	"context"
	"io"
	"time"

	expslog "golang.org/x/exp/slog"
)

// Types.
type (
	Attr           = expslog.Attr
	Handler        = expslog.Handler
	HandlerOptions = expslog.HandlerOptions
	JSONHandler    = expslog.JSONHandler
	Kind           = expslog.Kind
	Level          = expslog.Level
	Leveler        = expslog.Leveler
	LevelVar       = expslog.LevelVar
	Logger         = expslog.Logger
	LogValuer      = expslog.LogValuer
	Record         = expslog.Record
	Source         = expslog.Source
	TextHandler    = expslog.TextHandler
	Value          = expslog.Value
)

// Levels.
const (
	LevelDebug = expslog.LevelDebug
	LevelInfo  = expslog.LevelInfo
	LevelWarn  = expslog.LevelWarn
	LevelError = expslog.LevelError
)

// Constructors and handlers.
func New(h Handler) *Logger { return expslog.New(h) }

func NewTextHandler(w io.Writer, opts *HandlerOptions) *TextHandler {
	return expslog.NewTextHandler(w, opts)
}

func NewJSONHandler(w io.Writer, opts *HandlerOptions) *JSONHandler {
	return expslog.NewJSONHandler(w, opts)
}

func Default() *Logger     { return expslog.Default() }
func SetDefault(l *Logger) { expslog.SetDefault(l) }

// Attributes.
func Any(key string, value any) Attr            { return expslog.Any(key, value) }
func Bool(key string, v bool) Attr              { return expslog.Bool(key, v) }
func Duration(key string, v time.Duration) Attr { return expslog.Duration(key, v) }
func Group(key string, args ...any) Attr        { return expslog.Group(key, args...) }
func Int(key string, value int) Attr            { return expslog.Int(key, value) }
func Int64(key string, value int64) Attr        { return expslog.Int64(key, value) }
func String(key, value string) Attr             { return expslog.String(key, value) }
func Time(key string, v time.Time) Attr         { return expslog.Time(key, v) }
func Uint64(key string, v uint64) Attr          { return expslog.Uint64(key, v) }

// Logging entry points.
func Debug(msg string, args ...any) { expslog.Debug(msg, args...) }
func DebugContext(ctx context.Context, msg string, args ...any) {
	expslog.DebugContext(ctx, msg, args...)
}
func Info(msg string, args ...any) { expslog.Info(msg, args...) }
func InfoContext(ctx context.Context, msg string, args ...any) {
	expslog.InfoContext(ctx, msg, args...)
}
func Warn(msg string, args ...any) { expslog.Warn(msg, args...) }
func WarnContext(ctx context.Context, msg string, args ...any) {
	expslog.WarnContext(ctx, msg, args...)
}
func Error(msg string, args ...any) { expslog.Error(msg, args...) }
func ErrorContext(ctx context.Context, msg string, args ...any) {
	expslog.ErrorContext(ctx, msg, args...)
}
func Log(ctx context.Context, level Level, msg string, args ...any) {
	expslog.Log(ctx, level, msg, args...)
}
func LogAttrs(ctx context.Context, level Level, msg string, attrs ...Attr) {
	expslog.LogAttrs(ctx, level, msg, attrs...)
}
