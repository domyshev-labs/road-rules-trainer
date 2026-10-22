# Repository instructions

- Write repository comments, documentation and README content in English.
- Never use `git push --force`.

## Mandatory database backup before every deployment

Before every production deployment, including manual deployments, workflow dispatches and pushes that trigger automatic deployment, create a consistent SQLite backup of the current production database. Do not start deployment until the backup has completed successfully and passed `PRAGMA quick_check`.

Use the SQLite online backup API (or another SQLite-supported consistent snapshot mechanism) while the application is running. Do not copy only the live `.db` file: the application uses WAL mode. Save the backup under `/app/data/backups/` in the persistent production volume with a unique UTC timestamp and release identifier; never overwrite an existing backup. Record its location and integrity-check result in the deployment notes. If backup creation or verification fails, stop deployment and resolve the failure first.

When connecting over SSH, record every executed command in the infrastructure repository's `agents-logs` directory without secrets or passwords. Follow the user's infrastructure documentation requirements for infrastructure changes.

## Release procedure

The human replaced remote history on 2026-10-21. Normal fetches and pushes are permitted. Never force push. Every deployment increments the patch version; minor or major increments require agreement with the user. Patch numbers may exceed nine. The workflow tags the verified deployed commit. Backups are verified before replacement, then pruned to at most ten copies and three days of age.
