# Interface changes

Status: implemented locally on 2026-10-23; pending publication. Existing downloaded questions are reused.

## Topic start actions — requested 2026-10-23

Implemented in the current interface update.

- Place `Продолжить основное прохождение` on a separate row below `Пройти новые`, with balanced vertical spacing, including the bottom gap before the question list.
- On hover/focus over `Продолжить основное прохождение`, show the number completed and remaining in the main attempt, excluding newly added questions. Reuse existing statistics where possible. Do not backfill extra historical statistics just for old attempts; record additional statistics for future attempts if needed.
- Remove the inline question count (for example, `7 вопросов`) from the `Пройти новые` button.
- Show the new-question count in a tooltip above `Пройти новые`.
- Also show the count as small secondary text in the orange New badge inside the button, as requested; the count must be smaller than the New label.
- Preserve existing New eligibility, attempt history and progress semantics.

Reference screenshot supplied in chat: codex-clipboard-6eaf7a59-7c55-4f20-9380-70d5b47ccf61.png.

## Persistent answer result — requested 2026-10-23

Implemented with the current interface update.

- Keep the answer options scrollable between the question heading and navigation controls.
- Move the correct/incorrect result panel out of the scrolling content so that it stays visible while scrolling answers.
- Anchor the panel above the Previous/Next question controls, preserving the requested fixed 16 px top spacing. Use a sticky or separate fixed layout region as appropriate; avoid covering usable answer content.
- Add directional arrow controls on the result panel to move it into the left-hand column under the photograph.
- In the photograph column, use a narrower layout while retaining the result indicator and explanation control.
- Provide the reverse arrow control to return the panel to its original location above navigation.
- Preserve correct/incorrect colours, the prominent check/cross and the explanation button.

Reference screenshot supplied in chat: codex-clipboard-bc5051ba-0a5f-4dd7-aa0f-4c7f3be02258.png.

## Statistics: chronological answer stream — requested 2026-10-23

Implemented with the current interface update.

- Add a `Статистика` entry aligned to the right of the second header row on the learning dashboard, alongside the existing ticket/deferred counts.
- On the statistics page, add a `Линейная` subsection showing the current user's latest N answer events across all topics and ticket collections in chronological answer order. Retain repeated answers from distinct attempts instead of collapsing by canonical question.
- Default N to 30; offer 30, 50, 100, 250, 500 and 1000.
- Wrap chips across multiple rows. Each chip shows its sequential position within the displayed stream and a shortened topic name with ellipsis. Use green/red background according to the recorded result.
- On chip hover/focus, show a rich question popover: answer date and time above the question, question content/image and every answer option, including the recorded selection and correct/incorrect indications, consistent with the question page. Keep the popover usable for longer content.
- Show overall correct/incorrect percentages for the selected stream (and counts where useful).
- Use the topic recorded for that attempt when available; do not rewrite historical context according to today's topic classification. Provide an appropriate source-ticket or primary-topic fallback for ticket attempts.
- Read actual per-attempt answer records, not the latest-only question_progress view and not topic_run_inherited snapshots. Deduplicate legacy answers copied into topic runs during migration so one real response is not counted twice.
- Preserve user scoping and display timestamps in the user's local time.

Data inspection: topic_run_answers records run/question identity, selected text, correctness and answered_at; topic_runs provides user/topic and review-parent context. attempt_answers records attempt/question identity, selected letter, correctness and answered_at; attempts provides user/source ticket and mode. Existing records support a historical stream of preserved attempts. Current primary keys allow one stored answer per question per attempt/run, so overwritten intermediate selections within the same attempt cannot be reconstructed; do not invent missing events. Add an append-only event log for future interactions if full click-by-click history is required.

Reference screenshot supplied in chat: codex-clipboard-3a713262-91d2-4f8d-9e01-a53377d84277.png.

## Version release details — requested 2026-10-23

Implemented with the current interface update.

- Hovering or focusing the version in the upper-right corner should show the deployment date/time and the main changes in that release.
- Maintain a dedicated versioned release-history file in the repository, containing version, actual deployment timestamp and concise user-facing highlights for each release.
- Generate or record the actual successful deployment time through the release workflow; do not present a commit/build timestamp as the deployment time.
- Keep machine timestamps in UTC and display local date/time in the interface. User-facing release highlights should follow the interface language; repository documentation and implementation comments remain English.
- Ensure the displayed details match the deployed version and commit. For historic releases, use verified workflow timestamps rather than guessed dates.
- Preserve the existing patch-version increment and verified deployed-commit tag procedures.
