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

Each deployment increments the highest release tag's patch version (starting
from the package version), allows multi-digit patch numbers, embeds that version beside
the account menu, and publishes `/version.json` with the version and commit.
After production health succeeds, an annotated `v<version>` tag marks that commit.
Minor and major increments are agreed with the user separately. Failed deployments are not tagged. Normal tag pushes do not trigger deployment.

### Topic navigation and progress

The home page keeps collection shortcuts and search above a separately scrolling topic tree. The taxonomy has two levels: sections and leaf topics. Document-related deadlines are direct children of Documents and deadlines; stable topic identifiers preserve existing answers when a leaf moves between sections.

`GET /api/topics/progress` returns authenticated per-leaf totals, answered/correct/wrong counts, answered question states and the first unanswered question number. Counts exclude deferred questions and stale memberships. Both the home list and topic trainer use canonical-ID ordering. Question coverage is shared across topics and source tickets by user and canonical content ID. Source-ticket attempts and topic-run history remain separate immutable event records. Russian interface labels include translated thematic ticket names while captured source titles remain unchanged.

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

### Content-based taxonomy and shared question coverage

The taxonomy has eleven subject sections and exactly two levels. Classification
reads only question prompts and answer choices, never explanations. The tested
fact determines a primary leaf and directly relevant secondary leaves. Stable
canonical IDs and existing leaf IDs survive reparenting. Editorial exceptions
are in `materials/topic-overrides.json`; `scripts/audit-topics.py` checks complete
coverage, valid leaves, primary labels and preservation of all prior question IDs.
`materials/reviewed-exam-topics.json` is retained as historical material and is
not consumed by the new classifier. New captures without a classification must
be reviewed before the taxonomy audit can pass.

`question_progress` derives the user's latest normal answer from legacy topic
answers, actual topic-run answers and full source-ticket attempts. Mistake
reviews cannot replace this normal-training result. No original answer events
are rewritten. The authenticated `/api/questions/progress` endpoint exposes
feedback only for questions the current user has already answered.

First topic runs carry earlier answers in a separate `topic_run_inherited`
snapshot; history labels these as inherited rather than fabricated new answers.
Fresh intentional repeats remain blank and completed historical runs remain
frozen. When a topic loses members, a new current snapshot reflects the new
membership, while historical runs and reviews can still load removed questions.

Persistent taxonomy membership changes identify unanswered additions following
reorganization, including topics without an existing run. New markers survive
restarts and disappear when that question is answered anywhere in normal
training. Previously answered additions are immediately covered. Truly new
questions use the existing isolated new-question batch workflow. API responses
and client requests bypass HTTP caches to avoid stale progress.


## Answer timeline and release history

The authenticated `/api/statistics/linear?paged=1&offset=0` endpoint returns the current user's persisted answer events newest first, in pages of 50 with totals across the complete history. There is no user-facing history limit. The original unpaged response remains available for older clients. Events include topic and ticket attempts, including mistake reviews. Inherited progress is excluded and migrated legacy rows are deduplicated. Answer records remain one per question per attempt; overwritten intermediate choices cannot be recovered.

`/api/statistics/topics` aggregates the same events by their recorded topic or source ticket. It supports `filter=errors|perfect|all`, `sort=wrong|correct`, `direction=desc|asc`, and `offset` (30 topic rows per page). Sorting compares percentages, with answer counts breaking ties; percentages and counts are displayed together. Source tickets are returned in the two `collections` groups, separately from subject-topic rows. Each group has independently sortable ticket rows. Topic rows expose their IDs for dashboard navigation. Optional `from` and `to` dates are inclusive UTC calendar days, and `days` lists available answer dates for the month/week calendar. Each query is scoped to the authenticated user. The two collapsible panels share the viewport equally; only their row areas scroll, and the table header remains pinned.

Release highlights live in `backend/seed/releases.json`. Before a release, add an entry for the next patch version with `deployed_at: null` and concise interface-language highlights. After production passes its health check, the workflow records the actual UTC deployment timestamp and deployed commit, atomically publishes the metadata in the persistent data directory, and commits the release record with `[skip ci]`. The annotated version tag always points to the deployed application commit, not the subsequent metadata-only commit. Normal pushes are used; concurrent branch changes cause a safe push rejection rather than rewriting history. `/api/releases` serves the recorded history, with the embedded history as the initial fallback. The interface formats timestamps in the browser's local timezone.
