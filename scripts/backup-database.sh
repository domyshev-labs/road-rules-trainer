#!/bin/sh
set -eu
umask 077
root=${DATABASE_DIRECTORY:-/app/data}
database="$root/road-rules.db"
# An empty volume is valid only for the first installation.
if [ ! -e "$database" ]; then
  test -z "$(find "$root" -maxdepth 1 -name 'road-rules.db*' -print)"
  echo 'No existing database: first installation.'
  exit 0
fi
mkdir -p "$root/backups"
backup="$root/backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-${RELEASE_ID:?}.db"
test ! -e "$backup"
sqlite3 "$database" '.timeout 30000' ".backup '$backup'"
test "$(sqlite3 "$backup" 'PRAGMA quick_check;')" = ok
test -z "$(sqlite3 "$backup" 'PRAGMA foreign_key_check;')"
echo "Verified backup: $backup"
sha256sum "$backup"
# Prune only after a successful snapshot; exact seconds avoid day rounding.
cutoff=$(( $(date +%s) - 259200 ))
for file in "$root"/backups/*.db; do
  [ -f "$file" ] || continue
  [ "$(stat -c %Y "$file")" -ge "$cutoff" ] || rm -- "$file"
done
# Names are generated internally without whitespace. Keep the ten newest copies.
ls -1t "$root"/backups/*.db | tail -n +11 | while IFS= read -r file; do rm -- "$file"; done
