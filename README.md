# Road Rules Trainer

A Spanish/English driving-test trainer with Russian explanations, a React
frontend, and a Go + SQLite backend. The backend owns all 33 tickets, 956
questions, correct answers, authentication, attempts, and per-question
statistics.

## Architecture

- React 19 + Vite frontend. It never receives the answer key with a question.
- Go HTTP API using the standard library router.
- SQLite through the pure-Go `modernc.org/sqlite` driver; WAL mode and foreign
  keys are enabled.
- Passwordless authentication by a six-digit email code.
- HttpOnly, SameSite session cookies; only SHA-256 session-token hashes and
  HMAC login-code hashes are stored.
- Resend's official Go SDK for production email. `EMAIL_MODE=log` prints codes
  to the backend console during local development.
- The source ticket JSON is embedded in the Go binary and idempotently imported
  into SQLite on startup. Original question images remain immutable web assets.

See [docs/backend.md](docs/backend.md) for the API and data model.

## Local development

Requirements: Go 1.24+, Node.js 22+.

```bash
npm ci
npm run dev:api
```

In a second terminal:

```bash
npm run dev
```

Open `http://127.0.0.1:5173`. The Vite server proxies `/api` to port 8080.
With the default `EMAIL_MODE=log`, the login code appears in the API terminal.
Local SQLite data is written to `data/road-rules.db` and ignored by Git.

## Verification

```bash
npm run lint
npm run build
go test ./backend/...
go vet ./backend/...
docker build -t road-rules-trainer .
```

## Docker

The final image contains one non-root Go process. It serves both `/api/*` and
the built frontend on port 8080. Persist `/app/data`:

```bash
docker run --rm -p 127.0.0.1:5050:8080 \
  -v road-rules-trainer-data:/app/data \
  -e SESSION_SECRET='replace-with-a-long-random-secret' \
  -e EMAIL_MODE=log \
  road-rules-trainer
```

## Production prerequisites

The feature branch is not deployed: GitHub Actions deploys only pushes to
`main`. Before merging, configure these repository settings:

- secret `ROAD_RULES_SESSION_SECRET`: at least 24 random characters;
- secret `RESEND_API_KEY`;
- optional variable `ROAD_RULES_EMAIL_FROM`, defaulting to
  `Road Rules Trainer <login@mail.domyshev.com>`.

Email setup:

1. Create a free Resend account and add `mail.domyshev.com` as a sending domain.
2. Add the DKIM and SPF records shown by Resend to Cloudflare DNS. Keep those
   records in `DNS only` mode; using a dedicated mail subdomain avoids a conflict
   with the `driving.domyshev.com` tunnel hostname.
3. Create a sending-only Resend API key restricted to that domain and save it
   as the `RESEND_API_KEY` repository secret. The key is displayed only once.

No mailbox at `login@mail.domyshev.com` is required for sending login codes.
After authentication, browsers with legacy LocalStorage results show a mandatory
confirmation screen. The user must explicitly transfer those attempts before
opening the trainer; the endpoint is idempotent and the local copy is retained.

The deploy workflow creates the persistent Docker volume
`road-rules-trainer-data` and keeps the existing host binding
`127.0.0.1:5050`.
