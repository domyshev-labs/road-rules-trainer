package app

import (
	"errors"
	"os"
	"strings"
)

type Config struct {
	Address       string
	DatabasePath  string
	StaticDir     string
	SessionSecret string
	EmailMode     string
	ResendAPIKey  string
	EmailFrom     string
	CookieSecure  bool
}

func LoadConfig() (Config, error) {
	cfg := Config{
		Address:       envOr("ADDRESS", ":8080"),
		DatabasePath:  envOr("DATABASE_PATH", "data/road-rules.db"),
		StaticDir:     envOr("STATIC_DIR", "dist"),
		SessionSecret: envOr("SESSION_SECRET", "development-only-change-me"),
		EmailMode:     strings.ToLower(envOr("EMAIL_MODE", "log")),
		ResendAPIKey:  os.Getenv("RESEND_API_KEY"),
		EmailFrom:     envOr("EMAIL_FROM", "Road Rules Trainer <login@driving.domyshev.com>"),
		CookieSecure:  strings.EqualFold(envOr("COOKIE_SECURE", "false"), "true"),
	}
	if cfg.EmailMode != "log" && cfg.EmailMode != "resend" {
		return Config{}, errors.New("EMAIL_MODE must be log or resend")
	}
	if cfg.EmailMode == "resend" && cfg.ResendAPIKey == "" {
		return Config{}, errors.New("RESEND_API_KEY is required in resend mode")
	}
	if cfg.EmailMode == "resend" && cfg.SessionSecret == "development-only-change-me" {
		return Config{}, errors.New("SESSION_SECRET must be configured in resend mode")
	}
	if len(cfg.SessionSecret) < 24 {
		return Config{}, errors.New("SESSION_SECRET must contain at least 24 characters")
	}
	return cfg, nil
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
