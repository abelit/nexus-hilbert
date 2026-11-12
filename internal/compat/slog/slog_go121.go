//go:build go1.21

// Package slog re-exports log/slog on Go 1.21+ and golang.org/x/exp/slog on
// older toolchains. The package name stays "slog" so the legacy Edge build can
// rewrite the import path without changing call sites.
package slog

import (
	"context"
	"io"
	stdslog "log/slog"
	"time"
)

// Types.
type (
	Attr           = stdslog.Attr
	Handler        = stdslog.Handler
	HandlerOptions = stdslog.HandlerOptions
	JSONHandler    = stdslog.JSONHandler
	Kind           = stdslog.Kind
	Level          = stdslog.Level
	Leveler        = stdslog.Leveler
	LevelVar       = stdslog.LevelVar
	Logger         = stdslog.Logger
	LogValuer      = stdslog.LogValuer
	Record         = stdslog.Record
	Source         = stdslog.Source
	TextHandler    = stdslog.TextHandler
	Value          = stdslog.Value
)

// Levels.
const (
	LevelDebug = stdslog.LevelDebug
	LevelInfo  = stdslog.LevelInfo
	LevelWarn  = stdslog.LevelWarn
	LevelError = stdslog.LevelError
)

// Constructors and handlers.
func New(h Handler) *Logger { return stdslog.New(h) }

func NewTextHandler(w io.Writer, opts *HandlerOptions) *TextHandler {
	return stdslog.NewTextHandler(w, opts)
}

func NewJSONHandler(w io.Writer, opts *HandlerOptions) *JSONHandler {
	return stdslog.NewJSONHandler(w, opts)
}

func Default() *Logger     { return stdslog.Default() }
func SetDefault(l *Logger) { stdslog.SetDefault(l) }

// Attributes.
func Any(key string, value any) Attr            { return stdslog.Any(key, value) }
func Bool(key string, v bool) Attr              { return stdslog.Bool(key, v) }
func Duration(key string, v time.Duration) Attr { return stdslog.Duration(key, v) }
func Group(key string, args ...any) Attr        { return stdslog.Group(key, args...) }
func Int(key string, value int) Attr            { return stdslog.Int(key, value) }
func Int64(key string, value int64) Attr        { return stdslog.Int64(key, value) }
func String(key, value string) Attr             { return stdslog.String(key, value) }
func Time(key string, v time.Time) Attr         { return stdslog.Time(key, v) }
func Uint64(key string, v uint64) Attr          { return stdslog.Uint64(key, v) }

// Logging entry points.
func Debug(msg string, args ...any) { stdslog.Debug(msg, args...) }
func DebugContext(ctx context.Context, msg string, args ...any) {
	stdslog.DebugContext(ctx, msg, args...)
}
func Info(msg string, args ...any) { stdslog.Info(msg, args...) }
func InfoContext(ctx context.Context, msg string, args ...any) {
	stdslog.InfoContext(ctx, msg, args...)
}
func Warn(msg string, args ...any) { stdslog.Warn(msg, args...) }
func WarnContext(ctx context.Context, msg string, args ...any) {
	stdslog.WarnContext(ctx, msg, args...)
}
func Error(msg string, args ...any) { stdslog.Error(msg, args...) }
func ErrorContext(ctx context.Context, msg string, args ...any) {
	stdslog.ErrorContext(ctx, msg, args...)
}
func Log(ctx context.Context, level Level, msg string, args ...any) {
	stdslog.Log(ctx, level, msg, args...)
}
func LogAttrs(ctx context.Context, level Level, msg string, attrs ...Attr) {
	stdslog.LogAttrs(ctx, level, msg, attrs...)
}
