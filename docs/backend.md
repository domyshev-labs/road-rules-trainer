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

Legacy browser history is never uploaded silently. If meaningful LocalStorage
attempts exist, the frontend blocks access after login until the user explicitly
confirms the transfer. Successful imports are marked per user and browser;
`source_id` makes retries idempotent, and local data is not deleted.

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

Tickets have a required `collection`: `Thematic Test` or `Exam Test`. All 33
existing tickets (956 questions) belong to `Thematic Test`. A question inherits
its collection through `questions.test_id`; its wording alone does not determine
the collection. Both the catalog and ticket API include this field.

The seed importer rejects missing or unsupported collections. New tickets must
declare their collection explicitly in the source JSON. On older databases,
startup adds the collection column and classifies existing tickets as thematic,
preserving question IDs, answers, attempts, and statistics. This classification
does not yet implement exam timing, scoring, or feedback behavior.

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

## Shared question identity and collection memberships

`question_contents` stores shared prompt and explanation content under a stable canonical ID. `question_memberships` connects existing question rows (ticket positions) to that content. The canonical ID hashes normalized bilingual prompt, source image filename and sorted answer texts, so collection IDs and shuffled answer letters do not create new content. Ticket positions and their answer-letter mappings remain separate to preserve historical attempts and source ordering. Only exact content matches are merged; answer-key conflicts must be reviewed rather than silently reconciled.

The original thematic ticket IDs remain unchanged. Exam training IDs are `100000 + source ticket number`. Source question numbers and image filenames retain the original ordinal even when unconfirmed questions are excluded from training. `public/library.json` contains topic labels, canonical IDs and ticket memberships, without answer keys. Topic counts and lists deduplicate canonical IDs; collection lists preserve source memberships. Topics are labels, not generated copies of questions.

Captured source records and deferred questions are kept under `materials/exam/`. Rebuild the import and navigation with `python3 scripts/import-exam-captures.py --materials <capture directory>`. The capture directory must contain `exam-*-capture.json`, corresponding JPEG images for new questions and `deferred-questions.json`. Existing imported images can be reused. Reviewed classifications are in `materials/reviewed-exam-topics.json`; other classifications are provisional and should be reviewed. `materials/taxonomy.json` defines the hierarchy independently of collection membership.
