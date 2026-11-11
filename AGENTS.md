# AGENTS.md

## Project

Maane is a self-hosted helpdesk for email only. Mail reaches one Microsoft 365 shared mailbox through transport rules and is read through Microsoft Graph. Replies go out through SMTP2GO with a plain SMTP failover. Agents work in a Hebrew-first web UI. Correct Hebrew and RTL text, in the UI and in customer email, is the hard requirement. Maane replaces a Zendesk account and keeps all of its history.

**Stage: preparation.** Read these before any change:

- Product requirements: `docs/requirements.md`
- Foundation plan, decisions, order of work, and status: `docs/project-foundation.md`

The foundation plan is the desired state. Items marked planned do not exist yet. Check the repository before assuming a file, command, or feature exists. Today the repository holds documentation and repository metadata only: no package manifest, script, workflow, Dockerfile, or Compose file.

UI follows the `v3-ui-style` skill.

## Planned layout

Planned, not created. See the architecture table in `docs/project-foundation.md`.

- `apps/server`: Hono, Better Auth, Drizzle with PostgreSQL, the UI API, the public routes, and the built UI.
- `apps/web`: React and Vite UI. Hebrew and English, RTL and LTR, light and dark.
- `apps/worker`: the PostgreSQL job queue consumer: Graph intake, sending, delivery polling, scheduled actions, Web Push, import.
- `apps/zendesk-backup` and `packages/zendesk`: the phase 0 backup tool, and the Zendesk client and archive format it shares with the import.
- `packages/shared`: schemas, codes, date helpers, and the locale files `src/locales/en.json` and `src/locales/he.json`.
- `scripts/`: `local.sh`, `verify.sh`, `try-pr.sh`, `release.sh`, Bash for WSL. `docker/`: Dockerfiles, the development Compose template, env examples. `config/`: movable tool configuration.

## Commands

None exist yet. The planned contracts for `scripts/local.sh`, `scripts/verify.sh`, `scripts/try-pr.sh`, and `scripts/release.sh` are in `docs/project-foundation.md`. The 1a task adds the first ones and updates this section.

## Repository policies

- The repository is public. Everything tracked is in English, except `packages/shared/src/locales/he.json`. Tests read Hebrew from that file. Hebrew in fixtures is MIME-encoded or written as `\u` escapes, never literal. Bidirectional control characters are always escapes.
- Never commit organization details, real email addresses, domains, tenant details, hostnames, IP addresses, local paths, or customer data. Examples use `example.com` and invented people. Local notes go in the ignored `docs/private/`. The Zendesk archive and real mail samples never enter any repository.
- **Secrets.** No tracked file of any kind holds a working value for a secret-like setting: a password, key, token, signing or encryption secret, or a connection string with credentials. Development, test, and CI get no exception, and neither does a value labelled fake, dev-only, test, or not a secret, bound only to loopback, or said to guard nothing real. Environment files are tracked only as examples (`*.env.example`) with names and empty values or obvious placeholders. App-owned secrets (PostgreSQL password, `MAANE_AUTH_SECRETS`, `MAANE_SETTINGS_KEYS`, the VAPID key pair) come from a cryptographically secure random generator: in development once, on the developer's machine, into an ignored owner-only file that is never overwritten; in tests and CI new for each run; in production once, on the server, into an owner-only file by a step that refuses to overwrite. External credentials (Graph application, SMTP2GO API key, failover SMTP, Zendesk token) come from the local or CI secret store, stand-ins in tests, or the admin UI (encrypted) in production, never from a tracked file. The stack refuses to start when a required secret is missing or equals a placeholder. A value that was ever committed is public: never reuse it, and tell the owner where it must be replaced. Never copy values from other projects' `.env` files. An existing file that breaks these rules is not a precedent: report it. In work that touches secret-like settings, put these rules in every brief and reviewer prompt, and treat a violation as a blocker.
- **Better Auth is used only as it documents itself.** Its built-in features, options, official plugins, and documented hooks. Never a wrapper around its handler, a lock around its requests, own session clocks, or post-processing of its answers. A requirement those cannot meet is a gap for the owner, not code. Put this rule in every reviewer prompt.
- Every setting the owner manages is stored in the database with a default and edited in the admin UI. An environment variable may override one field and locks it in the UI. Only the database connection, file paths, deployment wiring, and keys live in the environment alone.
- Organization scope is enforced on the server for every read and write. The send point itself refuses customer sends in listening mode.
- Keep the repository root minimal. Every root file is listed and justified in `docs/project-foundation.md`.
- Add user-visible or operational changes under `Unreleased` in `CHANGELOG.md` once it exists. Do not bump versions in pull requests; the release workflow does that.
- Install with the lockfile once one exists.
- Commits use the GitHub noreply address as `user.email`. No AI or authorship attribution in commits, pull requests, Issues, or code.
- Desk, Pay, and hub are the owner's private projects. They are inspiration and reference only. Never copy code from them into this public repository without checking its license and content.

## Docker

Planned, not created. Details and the container table are in `docs/project-foundation.md`, "Docker decisions".

- `docker-compose.yml` (tracked) is the production deployment: `server`, `worker`, `postgres`, `clamav`, published images only, behind Traefik on the external `traefik` network with no published port.
- `docker-compose-dev.yml` (root, ignored, never committed) is the development stack, copied from `docker/docker-compose-dev.example.yml` and used only through `scripts/local.sh`. CI, verify, and release use the tracked template.
- Compose files never contain `build:`. The scripts build images explicitly, and a guard enforces it.
- Runtime variables come through `env_file`. Production reads `.env` (contract in `.env.example`). Development and verification read generated owner-only files. Interpolation is limited to values Compose resolves itself.
- Every application container runs as a non-root user with a real health check. The scripts fail when an application process runs as UID 0.
- Persistent data uses bind-mounted host directories, never named volumes. `down` keeps them. Only a confirmed `nuke` deletes the validated development data directory. Development data lives on the Linux file system, not under `/mnt/c`.
- Logs go to stdout and stderr.

## Safety

- Production deployment, releases, merges, and every change in Microsoft 365, DNS, SMTP2GO, or Zendesk belong to the owner. Agents prepare safe commands and never run them against production.
- Development and tests use stand-ins for Graph, SMTP2GO, failover SMTP, and Zendesk. Nothing real is sent from a development or test stack, except test sends to test addresses the owner provides in phase 3.
