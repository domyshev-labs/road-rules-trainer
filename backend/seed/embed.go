package seed

import "embed"

// Files contains the immutable source dataset used to populate SQLite.
//
//go:embed *.json
var Files embed.FS
