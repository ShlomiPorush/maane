# AGENTS.md

## Project

Maane is a self-hosted helpdesk for email only. Mail reaches one Microsoft 365 shared mailbox through transport rules and is read through Microsoft Graph. Replies go out through SMTP2GO with a plain SMTP failover. Agents work in a Hebrew-first web UI. Correct Hebrew and RTL text, in the UI and in customer email, is the hard requirement. Maane replaces a Zendesk account and keeps all of its history.

**Stage: preparation.** Read these before any change:

- Product requirements: `docs/requirements.md`
- Foundation plan, decisions, order of work, and status: `docs/project-foundation.md`

The foundation plan is the desired state. Items marked planned do not exist yet. Check the repository before assuming a file, command, or feature exists. Today the repository holds the workspace baseline (1a): manifests, the lockfile, `packages/shared` with the locale files, the toolchain image, the guards, `scripts/verify.sh`, CI, and Dependabot; the phase 0 Zendesk backup tool; and the server and worker of foundation 1b (sign-in, setup, settings, audit log, job queue). No web UI, Compose file, application image, or other workflow script exists yet.

UI follows the `v3-ui-style` skill.

## Layout

Exists:

- `packages/shared`: the locale files `src/locales/en.json` and `src/locales/he.json` and `src/locales.ts` (locales, default Hebrew, direction). Imported as TypeScript source; no build step.
- `config/tsconfig.base.json`: shared compiler settings. `biome.json` stays at the root (see Traps).
- `docker/toolchain.Dockerfile`: Node, pnpm, git, jq, shellcheck, and shfmt for the scripts and CI.
- `scripts/verify.sh`, and `scripts/lib/`: `common.sh` (shared helpers), `guards.sh` (repository guards), `test-guards.sh` (plants each violation in a scratch repository and expects its guard to fail).
- `.github/`: `workflows/ci.yml`, `dependabot.yml`, the pull request template.

- `packages/zendesk`: the Zendesk API client (the token goes only to the API origin; downloads follow redirects without it, HTTPS only, with a size limit), the archive format (`archive.ts`), one backup run (`backup.ts`), and the offline check (`check.ts`). `src/testing/stand-in.ts` is a stand-in Zendesk API with a second origin for files; tests never reach Zendesk.
- `apps/zendesk-backup`: the phase 0 command line (`backup`, `check`), bundled by esbuild into `dist/zendesk-backup.mjs` for Node 24 and later. It reads the token from a terminal only and refuses an archive folder inside a Git working tree. How to run it: `docs/zendesk-backup.md`.

- `apps/server`: Hono on Node.js with Drizzle over `pg` (migrations in `apps/server/drizzle`, generated with `drizzle-kit generate`, run on start). `src/config.ts` reads and checks the environment and refuses missing or placeholder secrets and `BETTER_AUTH_*`. `src/auth/auth.ts` is Better Auth (username, twoFactor, admin) with the closed route list and its three groups, the setup window (`setup-window.ts`), and the audit rows from its documented hooks. `src/http/app.ts` mounts `/healthz/*`, `/api/auth/*`, `/api/setup/status`, `/api/v1` (session with two-factor, CSRF header and Origin, admin-only settings and audit log), and the built UI with its Content Security Policy. `src/settings/` holds the encrypted settings (`crypto.ts`) and their service. `src/testing/` holds the integration helpers: a migrated database per test file, a cookie-jar browser, an independent TOTP. Tests named `*.integration.test.ts` need the PostgreSQL that `scripts/verify.sh` starts.
- `apps/worker`: pg-boss (schema `pgboss`) with the `heartbeat` job; its health check reads the heartbeat file. Imports the server's config, database, and log through `@maane/server/*`.

Planned, not created (see the architecture table in `docs/project-foundation.md`):

- `apps/web`: React and Vite UI. Hebrew and English, RTL and LTR, light and dark.
- `scripts/local.sh`, `scripts/try-pr.sh`, `scripts/release.sh`. `docker/`: the application Dockerfile, the development Compose template, env examples.

## Commands

All scripts are Bash for WSL or Linux with Docker. Node, pnpm, shellcheck, and shfmt run inside the toolchain container, so the host needs only Docker.

- `scripts/verify.sh [--changed [BASE]] [--guards-only] [--skip-integration]`: the only verification entry point. Guards and their tests, then install from the lockfile, Biome, types, unit tests, builds, a check that the schema needs no missing migration, and the integration tests against a disposable PostgreSQL (`postgres:18.6-bookworm` on a private network, a password new for every run, passed only through an owner-only `--env-file`). `--changed` compares with `BASE` (default `origin/main`): documentation only runs the guards; changes only inside `apps/` or `packages/` run the changed packages and their dependents; anything else runs everything.
- Ad-hoc commands in the toolchain: `source scripts/lib/common.sh && build_toolchain && in_toolchain "pnpm ..."`.
- The planned contracts for `scripts/local.sh`, `scripts/try-pr.sh`, and `scripts/release.sh` are in `docs/project-foundation.md`.

Verify in proportion to the risk, and report what ran and its result:

- **Documentation only** (`docs/`, `README.md`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE`): `scripts/verify.sh --changed`, which then runs only the guards.
- **Anything else**: the full `scripts/verify.sh` before opening the pull request.

CI (`.github/workflows/ci.yml`) runs `Detect changes`, `Guards` always, `Checks` (`verify.sh --changed` against the base branch on pull requests, the full sweep on `main`, manual runs, and the weekly Monday sweep) unless only documentation changed, and `CI summary`, the one check to require.

## Traps

- Some editing tools turn `\u` escapes in the text they write into the literal characters. After writing a file that needs Hebrew code points or bidirectional controls in source, build them from code points (`String.fromCodePoint(0x5d0)`) or check the file: the guards fail on literal Hebrew outside `he.json` and on any literal bidirectional control.
- Tests and guard tests assemble secret-like values at run time (`"gh""p_..."`), because the guards and GitHub push protection scan the literal text.
- Only images, fonts, PDFs, and GeoIP databases may hold binary content (`BINARY_EXTENSIONS` in `scripts/lib/guards.sh`): grep skips binary files, so any other binary file would hide from the text guards. The Compose and workflow guards read YAML with `yq`, so quoting or flow style cannot hide `build:` or an unpinned `uses:`.
- The guards scan tracked files and new files that are not ignored. The deny list `docs/private/deny-list.txt` exists only on the owner's machine; in CI the guard is skipped, and CI output never repeats a matched line.
- pnpm 12 reads its settings only from `pnpm-workspace.yaml`. A dependency that needs an install script must be allowed there under `allowBuilds`.
- Biome 2 must find `biome.json` at the repository root; a config under `config/` fails with "nested root configuration". Its Markdown and YAML formatters are off.
- Inside the toolchain container pnpm keeps its store in `node_modules/.pnpm-store` (ignored).
- New migration after a schema change: `in_toolchain "pnpm --filter @maane/server db:generate --name <change>"`. `scripts/verify.sh` fails when the schema and the migrations disagree. Never edit a generated migration.
- **Better Auth is used only as it documents itself** (see Repository policies). The closed route list lives in `hooks.before` in `apps/server/src/auth/auth.ts`; a new Better Auth route stays closed until it is listed in one of the three groups, and `auth.integration.test.ts` fails when a listed path no longer exists.
- Better Auth's session read does not refuse a banned user: the hook refuses one on every protected route, and `/api/v1` refuses one too. Keep both.
- The setup admin (`setup_admin`) can be neither demoted nor banned (owner's decision, 2026-11-11). The accepted sign-in gaps are listed in "Foundation 1b design" in the foundation plan; each has a test that pins it.
- Better Auth keys its rate limits on the client address: integration tests give each browser its own documentation-range address (`nextIp()`), or 5 sign-ins exhaust the limit.
- A test that needs a URL with a password builds it at run time; the guards refuse credentials in a URL literal unless the password is a placeholder (`$NAME`, `${...}`, `%s`, `<name>`, or asterisks).

## Repository policies

- The repository is public. Everything tracked is in English, except `packages/shared/src/locales/he.json`. Tests read Hebrew from that file. Hebrew in fixtures is MIME-encoded or written as `\u` escapes, never literal. Bidirectional control characters are always escapes.
- Never commit organization details, real email addresses, domains, tenant details, hostnames, IP addresses, local paths, or customer data. Examples use `example.com` and invented people. Local notes go in the ignored `docs/private/`. The Zendesk archive and real mail samples never enter any repository.
- **Secrets.** No tracked file of any kind holds a working value for a secret-like setting: a password, key, token, signing or encryption secret, or a connection string with credentials. Development, test, and CI get no exception, and neither does a value labelled fake, dev-only, test, or not a secret, bound only to loopback, or said to guard nothing real. Environment files are tracked only as examples (`*.env.example`) with names and empty values or obvious placeholders. App-owned secrets (PostgreSQL password, `MAANE_AUTH_SECRETS`, `MAANE_SETTINGS_KEYS`, the VAPID key pair) come from a cryptographically secure random generator: in development once, on the developer's machine, into an ignored owner-only file that is never overwritten; in tests and CI new for each run; in production once, on the server, into an owner-only file by a step that refuses to overwrite. External credentials (Graph application, SMTP2GO API key, failover SMTP, Zendesk token) come from the local or CI secret store, stand-ins in tests, or the admin UI (encrypted) in production, never from a tracked file. The stack refuses to start when a required secret is missing or equals a placeholder. A value that was ever committed is public: never reuse it, and tell the owner where it must be replaced. Never copy values from other projects' `.env` files. An existing file that breaks these rules is not a precedent: report it. In work that touches secret-like settings, put these rules in every brief and reviewer prompt, and treat a violation as a blocker.
- **Better Auth is used only as it documents itself.** Its built-in features, options, official plugins, and documented hooks. Never a wrapper around its handler, a lock around its requests, own session clocks, or post-processing of its answers. A requirement those cannot meet is a gap for the owner, not code. Put this rule in every reviewer prompt.
- Every setting the owner manages is stored in the database with a default and edited in the admin UI. An environment variable may override one field and locks it in the UI. Only the database connection, file paths, deployment wiring, and keys live in the environment alone.
- Organization scope is enforced on the server for every read and write. The send point itself refuses customer sends in listening mode.
- Keep the repository root minimal. Every root file is listed and justified in `docs/project-foundation.md`.
- Add user-visible or operational changes under `Unreleased` in `CHANGELOG.md`. Do not bump versions in pull requests; the release workflow does that.
- Install with the lockfile (`pnpm install --frozen-lockfile`, done by the scripts).
- Pin every GitHub Action to a full commit SHA with the version in a comment. A guard enforces it.
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
