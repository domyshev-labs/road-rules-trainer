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

Every production deployment automatically creates a SQLite online backup in
`/app/data/backups/` before replacing the container. Both `quick_check` and
`foreign_key_check` must pass or deployment stops. Only after verification,
backups older than 72 hours are removed and the ten newest copies are retained.
The first installation may proceed without a database on an empty volume.

Each deployment increments the highest release tag's minor version (starting
from the package version), resets the patch to zero, embeds that version beside
the account menu, and publishes `/version.json` with the version and commit.
After production health succeeds, an annotated `v<version>` tag marks that commit.
Failed deployments are not tagged. Normal tag pushes do not trigger deployment.

### Topic navigation and progress

The home page keeps collection shortcuts and search above a separately scrolling topic tree. The taxonomy has two levels: sections and leaf topics. Document-related deadlines are direct children of Documents and deadlines; stable topic identifiers preserve existing answers when a leaf moves between sections.

`GET /api/topics/progress` returns authenticated per-leaf totals, answered/correct/wrong counts, answered question states and the first unanswered question number. Counts exclude deferred questions and stale memberships. Both the home list and topic trainer use canonical-ID ordering and independent topic progress. Source-ticket attempts remain separate. Russian interface labels include translated thematic ticket names while captured source titles remain unchanged.

Question lists show their own sequence number followed by the Russian prompt, without repeating the topic name or an English second line. Russian navigation translations are stored by canonical question ID in `materials/question-titles-ru.json` and included in both library artifacts by the importer. They were generated locally with Argos en_ru 1.9, with road terminology corrections and manual overrides; source prompts, answer keys and progress identities are unchanged. Topic API responses include the same `question_ru` field. Coverage tests verify consistency of existing translations; newly captured questions may retain their original prompt.

Leaving a custom topic with either Topics by section or Return preserves saved answers and restores the home view's search, expanded branches and topic scroll offset. Starting a new full topic run archives the previous results; unfinished runs cannot be reset. Section/topic captions follow their names; feedback uses a prominent green check or red cross independently of the blue interface palette.

On desktop, question wording and bottom navigation stay fixed while answer content scrolls only when needed. The answer region has 16 px gaps above and below; navigation ends 16 px above the panel bottom. On smaller screens, question wording and answers share a scrolling region so long prompts remain accessible. Source-reference data is retained but its visual line is hidden. The shared authenticated account menu shows the current email and a separated sign-out action on every route. Topic continuation text uses one horizontal line.


### Topic run history and mistake reviews

Full topic runs are stored in `topic_runs` with immutable answers in `topic_run_answers`. Existing `topic_answers` records are copied once into the first run without losing their original timestamps. The legacy table remains the current full-run snapshot used by the main topic counters and question markers. Review answers never update that snapshot or source-ticket statistics.

Completed runs containing mistakes offer a filtered review of their incorrect questions, with independent local numbering. `POST /api/topics/{topicID}/reviews/{runID}` starts or resumes that run's single review; `GET /api/topics/{topicID}?review={reviewID}` loads it and the answer endpoint accepts an optional `review_id`. Reviews are user- and topic-scoped, idempotent, and complete once every review question is answered, including any remaining errors. Starting a full repeat retains previous runs and associated reviews. The progress response includes their timestamps, counts and completion state. The interactive history panel opens on hover, focus or tap on a leaf topic's counters and offers review actions for individual completed runs.


### Newly added topic questions

Each full topic run freezes its canonical question membership in `topic_run_members`. Newly verified questions or newly assigned canonical members outside that baseline make the topic incomplete again. Adding another source-ticket occurrence of an existing canonical question does not create a new question. Unanswered original questions stay part of their original run rather than being relabeled as new.

The home action becomes **Пройти новые**, with the remaining count inline and an adjacent New badge describing the change. `POST /api/topics/{topicID}/new` starts or resumes a separate `kind=new` run; `GET /api/topics/{topicID}?run={runID}` returns only its snapshot, numbered from one. Answers include `run_id`, update the current topic-cycle aggregate, and cannot modify a prior completed full run. History retains the original counts and records each new batch separately, with its own mistake-review action. Batch completion requires every question to be answered. Additions arriving during an active batch form the next batch after it, rather than expanding its historical total. A full repeat takes a fresh baseline and keeps all prior full/new/review history. Responses include `completed`, `new_count`, `new_question_ids` and `question_runs` for accurate home navigation.

Legacy completed runs recover their fixed membership from saved answers. Incomplete legacy runs did not record unanswered membership, so their available current membership becomes the baseline during migration.

### Browser navigation and section shortcuts

Training screens and question positions use URL query routes and the browser
history API. Back/Forward restore the home panel, a topic/run and its canonical
question, or a source ticket and question ordinal. Refreshing a question URL
restores the same position. Home history entries retain their expanded branches,
search, collection and scroll snapshot. Navigation never resets answer history.

Hovering, focusing or tapping the section name in a topic opens an interactive
section panel using the same hierarchy, statistics and topic actions as home.
Section counts summarize completed leaf topics rather than question totals.
