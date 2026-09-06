# Backend design

## Authentication flow

1. `POST /api/auth/request-code` validates and normalizes an email address.
2. A cryptographically random six-digit code is valid for ten minutes. Only
   its HMAC-SHA-256 digest is stored.
3. Requests are limited to five per email and twenty per source IP per hour,
   with a one-minute resend delay. Verification is limited to five attempts.
4. `POST /api/auth/verify-code` creates the user on first successful login and
   returns a 30-day opaque session in an HttpOnly cookie. SQLite stores only a
   SHA-256 digest of the session token.

In production, codes are transactional emails sent through Resend. The free
plan currently permits 3,000 emails per month and 100 per day. Development uses
the local log sender and never calls an external service.

## Main API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Container/database health |
| `POST` | `/api/auth/request-code` | Send a login code |
| `POST` | `/api/auth/verify-code` | Verify code and start a session |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/auth/logout` | Revoke current session |
| `GET` | `/api/catalog` | Ticket list |
| `GET` | `/api/tests/{id}` | Questions, choices, images and trilingual help |
| `POST` | `/api/attempts` | Start a full or mistakes attempt |
| `POST` | `/api/attempts/{id}/answers` | Persist and validate one answer |
| `POST` | `/api/attempts/{id}/complete` | Mark an attempt completed |
| `GET` | `/api/tests/{id}/statistics` | Every attempt and per-question aggregate |
| `GET` | `/api/progress` | Latest per-ticket counters for the menu |
| `POST` | `/api/progress/import` | Idempotently migrate legacy local attempts |

Except for health and the two login endpoints, every route requires a valid
session. Correct-answer flags are never included in the ticket response; the
answer endpoint returns correctness only after persisting the selected choice.

## SQLite tables

- `users`, `login_codes`, `sessions`
- `tests`, `questions`, `answers`
- `attempts`, `attempt_answers`

Every answer is immutable within an attempt due to the composite primary key
`(attempt_id, question_id)`. Attempts belong to a user, and answer validation
checks that ownership before writing.

## Backups

The database lives at `/app/data/road-rules.db` in the named Docker volume.
For an online backup use SQLite's backup command rather than copying only the
main file while WAL mode is active:

```bash
docker exec road-rules-trainer sqlite3 /app/data/road-rules.db \
  ".backup '/app/data/road-rules-backup.db'"
```
