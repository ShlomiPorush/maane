# Maane project foundation

Status: Foundation 1a (repository baseline) built and verified locally on 2026-11-11, on its pull request. No application code, Compose file, or application Dockerfile exists.

This document separates what exists in the repository from the approved foundation that later tasks build. A planned item does not exist until its status and its verification evidence say so. Product behavior is in [requirements.md](requirements.md). This document covers the repository contract, the architecture, the order of work, and how each part is verified.

## Current truth

- On `main`: documentation and repository metadata: `README.md`, `AGENTS.md`, `LICENSE` (MIT), `.gitignore`, `.gitattributes`, `docs/requirements.md`, and this document.
- On the 1a pull request (branch `foundation-1a-baseline`): the pnpm workspace (`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`), `biome.json`, `config/tsconfig.base.json`, `packages/shared` with the two locale files and a unit test, `CHANGELOG.md`, `docker/toolchain.Dockerfile`, `scripts/verify.sh` with `scripts/lib/common.sh`, `guards.sh`, and `test-guards.sh`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, and the pull request template.
- No application, Compose file, application Dockerfile, environment example, or other workflow script exists.
- The local Git repository uses the GitHub noreply address as `user.email`. `core.autocrlf` is on for the owner's machine, so `.gitattributes` forces LF for every text file.
- GitHub repository `ShlomiPorush/maane` exists, public, default branch `main`, with the approved settings read back on 2026-11-11. See [GitHub configuration](#github-configuration).
- Verified locally on 2026-11-11 in WSL (Docker 29.8.2): the `scripts/verify.sh` full sweep passes (guards; the 38 planted violations in `test-guards.sh` each fail with their own guard, without repeating the planted value in CI output, and pass once removed; install from the lockfile; Biome; `tsc`; 3 unit tests). CI results are on the 1a pull request.

## Product intent and boundaries

- **Problem.** The owner answers customer email for several organizations through Zendesk. Zendesk handles Hebrew and right-to-left text poorly in both the agent UI and the email customers receive, and the open-source alternatives checked have no proven support.
- **Product.** A self-hosted helpdesk for email only. Mail reaches one Microsoft 365 shared mailbox through transport rules, the worker reads it through Microsoft Graph, and replies go out through SMTP2GO with a plain SMTP failover. Agents work in a Hebrew-first web UI with correct RTL. Maane keeps all Zendesk history.
- **Users.** The owner as admin today. Later, agents scoped to one or more organizations. Customers never sign in; they use email, tracked links, and download links only.
- **Volume.** Low. Design for correctness and recoverability, not throughput.
- **Stage.** Preparation. Phases 0 to 6 in [requirements.md](requirements.md#5-phases) follow, in the order this document sets.
- **Deployment shape.** Docker Compose on the owner's existing Docker host, behind the owner's Traefik on its external network, with public HTTPS from Traefik. The agent UI, the setup screen, tracked links, download links, and the SMTP2GO webhook are all reachable from the internet.
- **Non-goals for v1.** Chat, help center, SLA, auto-close, a per-organization logo, email notifications to agents, a native mobile app, an API or MCP access for AI agents, and backup inside the application.
- **Constraints.** Hebrew and RTL correctness is the hard requirement. Only one system answers customers at any moment, so listening mode blocks sending at the send point. No customer may receive the same reply twice without the owner knowing.

## Preparation decisions

| Decision | Status | Choice | Rationale or blocker |
|---|---|---|---|
| Publication posture | Approved | Public-ready. The repository is public. | The owner wants GitHub code scanning for free. |
| Repository language | Approved | English for docs, code, comments, commits, pull request titles and bodies, and Issues. Hebrew only in `packages/shared/src/locales/he.json`. | Public-ready posture. One locale file keeps the Hebrew guard exception exact. |
| Repository content | Approved | No organization details, real addresses, domains, tenant details, or customer data. Examples use `example.com`. | Public repository. |
| License | Approved | MIT | Owner's choice, as in n8n-ops and Mikud. |
| Runtime shape | Approved | Docker Compose: `server`, `worker`, `postgres`, `clamav`, behind Traefik. | Matches the owner's host. See [Docker decisions](#docker-decisions). |
| Stack | Approved | TypeScript pnpm monorepo, Hono, Better Auth, Drizzle, PostgreSQL, React and Vite, a PostgreSQL job queue, encrypted settings, an audit log. | Same as n8n-ops and Mikud. The foundation (sign-in, settings, audit, queue) is taken from them with the changes in [Security design](#security-design). |
| Layout | Approved | `apps/server`, `apps/web`, `apps/worker`, `packages/shared`, as in n8n-ops. Phase 0 adds `apps/zendesk-backup` and `packages/zendesk`. | `packages/zendesk` holds the Zendesk API client and the archive format that the backup tool, the import, and the old-replies job share. |
| Versions | Approved for 1a, provisional for the rest | Pinned in 1a: Node.js 26.13.1 (toolchain image), pnpm 12.18.0, TypeScript 7.0.2, Biome 2.6.6, Vitest 5.1.0, `@types/node` 26.6.6. Starting points for later tasks: Better Auth 1.7, Hono 4.13, Drizzle ORM 0.45 with drizzle-kit 0.31, the `postgres` driver 4, React 19.3, Vite 8.3, Playwright 1.64, PostgreSQL 18. | 1a pinned the current releases. Each later task pins what it adds and records it here. |
| UI design language | Approved | The `v3-ui-style` skill, as in Mikud. | Owner's choice. Mikud already runs it with Hebrew, RTL, and both themes. |
| UI localization | Approved | Hebrew (default) and English, RTL and LTR, light and dark themes, phone to desktop. | Baseline for a UI, and Hebrew is the hard requirement. |
| Customer email | Approved | Built server-side by the rules of the owner's `html-email` skill. Customer-facing fixed text comes from the locale files. Per-organization templates and signatures are data in the database. | [requirements.md](requirements.md#4-customer-email-layout) |
| Workflow scripts | Approved | WSL Bash under `scripts/`: `local.sh`, `verify.sh`, `try-pr.sh`, `release.sh`. Tooling runs in a toolchain container. | Baseline. The host needs Docker only, as in n8n-ops and Mikud. |
| Root layout | Approved | Minimal root, every file justified in [Planned repository root](#planned-repository-root). | Baseline. |
| Release artifact | Provisional | One image, `ghcr.io/shlomiporush/maane`, that runs the server or the worker by command. SemVer tags plus `latest`. | The worker runs on the same host as the server, so a second image buys nothing. n8n-ops has two only because its worker runs on other hosts. The foundation task confirms. |
| Versioning | Approved | SemVer from the root `package.json` `version`, and `CHANGELOG.md` with `Unreleased`. Only the release workflow bumps the version. | Baseline. Same as n8n-ops and Mikud. |
| Order of work | Approved | 1a (repository baseline), then 0 (Zendesk backup), then 1b (rest of the foundation), then phases 2 to 6. | Owner's decision. Phase 0 handles a token and customer data, so it lands only after the guards and CI exist. |
| First-run setup | Approved | Web setup screen, open for 5 minutes after the server starts and only while no user exists, created atomically. Never a CLI command. | Owner's decision with the residual risk recorded in [requirements.md](requirements.md#91-setup-screen). |
| Backup | Approved | Done by the owner's own stack. Maane documents what to include. | [requirements.md](requirements.md#8-security) |
| GitHub configuration | Approved | See [GitHub configuration](#github-configuration). | Owner approved the exact list on 2026-11-11. |

## Publication and language policy

- The repository is public. Every tracked file is in English except `packages/shared/src/locales/he.json`. The Hebrew guard in `scripts/verify.sh` scans tracked files and new files that are not ignored, and excludes only that path. No broad allowlist.
- Tests read Hebrew text from `he.json`. Hebrew in test fixtures is never literal: email fixtures carry it in MIME transfer encoding (base64 or quoted-printable), and source code writes it as `\u` escapes. Bidirectional control characters are always written as escapes.
- Fixtures, screenshots, and examples use invented people, organizations, and mail at `example.com`. Real Zendesk data, real mail samples, and real tenant details stay outside the repository. Local notes go in the ignored `docs/private/`.
- Commits, pull requests, Issues, and review comments are in English and carry no AI or authorship attribution.
- User-facing strings live in the locale files from the first UI commit. Statuses, roles, and other codes are stored as English codes, and labels come from the locale files.

## Planned architecture

| Component | Responsibility | Expected path | Status | Dependencies or blockers |
|---|---|---|---|---|
| Repository baseline | Workspace manifests, lockfile, Biome, TypeScript base config, toolchain image, guards, CI, Dependabot, `CHANGELOG.md`, pull request template | root, `config/`, `docker/`, `scripts/`, `.github/` | Built (1a pull request) | None |
| `zendesk-backup` | Phase 0 command-line tool: raw records, attachments with inline images, resumable runs, a manifest, a restore check | `apps/zendesk-backup` | Planned (0) | 1a. See [Phase 0 contract](#phase-0-contract). |
| `zendesk` | Zendesk API client with the token-host rule, and the archive format and reader | `packages/zendesk` | Planned (0) | 1a |
| `shared` | Schemas, enum codes, the locale files `en.json` and `he.json`, date and time helpers for `Asia/Jerusalem` | `packages/shared` | Skeleton built (1a pull request), content planned (1b) | None |
| `server` | Hono app: Better Auth at `/api/auth`, the setup screen API, the UI API, the public routes (link redirect, file download, SMTP2GO webhook), health endpoints, the built UI, and migrations on start | `apps/server` | Planned (1b) | Better Auth evidence in [Known unknowns](#known-unknowns-and-blockers) |
| `web` | React UI in the `v3-ui-style` design: sign-in, setup, two-factor enrollment, an empty shell, Settings, users, and the audit log in 1b. PWA manifest and service worker arrive in phase 4. | `apps/web` | Planned (1b) | None |
| `worker` | Job queue consumer: Graph intake (phase 2), sending and delivery polling (phase 3), scheduled actions and Web Push (phase 4), import (phase 5) | `apps/worker` | Planned (1b runs the queue and a no-op job) | None |
| Database schema | Drizzle schema and generated migrations. 1b creates the Better Auth tables, settings, the audit log, and the job queue. | `apps/server/src/db`, `apps/server/drizzle` | Planned (1b) | None |
| Image | Multi-stage build, esbuild bundles, runs as `node` with a health check | `docker/maane.Dockerfile` | Planned (1b) | None |
| Toolchain image | Node, pnpm, git, jq, shellcheck, shfmt for the scripts and CI | `docker/toolchain.Dockerfile` | Built (1a pull request) | None |
| Production Compose | `server`, `worker`, `postgres`, `clamav` with Traefik labels | `docker-compose.yml` | Planned (1b) | ClamAV runtime user in [Known unknowns](#known-unknowns-and-blockers) |
| Deployment notes | Traefik, secret generation on the server, the setup window, backup contents, the restore test | `docs/deployment.md` | Planned (1b) | None |

Boundaries:

- Only `server` and `worker` open the database. `worker` holds the Graph, SMTP2GO, failover SMTP, and clamd clients. `server` never calls Graph or sends mail.
- Organization scope is enforced in the server's service layer for every read and write: lists, search, views, replies, files, notifications, and exports. The UI never decides scope.
- Every write goes through the service layer and writes an audit row. Secret values never reach the audit log or the application log.
- The send point itself refuses customer sends in listening mode (phase 2 onward). The UI state is not the guard.
- Settings the owner manages live in the database with a default and are edited in the admin UI. An environment variable may override one field and locks it in the UI. Only the database connection, file paths, deployment wiring, and the keys stay in the environment alone.

### Security design

These requirements apply from 1b. They come from [requirements.md](requirements.md#8-security) and from Mikud, with the differences that a multi-user, public Maane needs.

- **Better Auth as it documents itself.** Built-in features, configuration, official plugins, and documented hooks only. No wrapper around its handler, no lock around its requests, no own session clocks, no post-processing of its answers. A requirement those cannot meet is a gap for the owner, not code. Every reviewer prompt carries this rule.
- **Plugins.** `username`, `twoFactor` (TOTP with backup codes), and `admin` (roles `admin` and `agent`). The `organization` plugin only if the evidence item in [Known unknowns](#known-unknowns-and-blockers) passes. `bearer()` and API keys are not planned, because Maane has no agent API in v1. Leaving `bearer()` out also avoids Mikud's accepted gap G10.
- **Closed route list.** A documented `hooks.before` admits a fixed list of Better Auth route patterns over HTTP and answers 404 to every other one, including routes a later version adds, as `ALLOWED_PATHS` does in Mikud. A test fails when a listed path no longer exists. Open sign-up is not on the list.
- **Two-factor is mandatory.** Better Auth cannot require it. Maane's own routes accept a session only while `user.twoFactorEnabled` is true, and a session of a user without two-factor reaches only the enrollment screen and sign-out. Two-factor counts as on only after a verified code. The same rule applies after two-factor is turned off. The restriction also covers direct requests to Better Auth's own routes, such as the `admin` plugin's routes, through the documented `hooks.before`, and HTTP tests cover those direct requests.
- **Setup screen.** Open only within 5 minutes of server start and only while no user exists. After the window closes with no user, the screen says a restart opens it again. Creation must be atomic under parallel requests, through documented Better Auth interfaces plus a database-level guarantee. n8n-ops' `setup.ts` is not a precedent here: it counts users and then signs up, with no time window, so two parallel requests can both pass. Mikud's single-owner index does not fit a multi-user system. If documented interfaces cannot give atomic creation, the gap goes to the owner before the screen ships. The first user gets the `admin` role.
- **Users and roles.** No open sign-up. An admin creates users in the admin UI through the `admin` plugin. Disabling a user or changing a role ends all of that user's sessions at once, through the plugin's documented actions. Sessions have a limited length. Sign-in is rate limited by Better Auth's limiter.
- **Client address.** The real client IP comes from forwarding headers only when the request came from the configured trusted proxy (`MAANE_TRUSTED_PROXIES`). This holds only while Maane is reachable through Traefik alone and Traefik replaces client forwarding headers. Rate limits, link clicks, and downloads all use this address.
- **CSRF.** Better Auth's origin check stays on in every environment, also under `NODE_ENV=test`. State-changing requests to Maane's own API carry a custom header and an `Origin` equal to the configured public URL.
- **Keys.** Two key families, never sharing a value: the Better Auth secret and the settings encryption key. See [Secrets](#secrets) for names.
- **Content Security Policy.** `script-src 'self'` and `connect-src 'self'` for the UI. Incoming mail HTML renders sanitized in an isolated frame with remote images blocked until allowed.
- **Gaps to bring to the owner.** Mikud's owner accepted gaps G6 (a password sign-in during enrollment can keep a session without the second factor) and G7 (enrollment is not atomic) for a single user on a private network. Maane is multi-user on public HTTPS. These gaps are not inherited: the 1b task checks whether they exist in Maane's design and brings each one that remains to the owner as a decision.

### Secrets

These rules are not defaults. Any breach is a `blocker` in review. Every implementation brief and reviewer prompt that sets up a runtime, development, test, or CI environment, or touches a secret-like setting, carries them.

- No tracked file of any kind holds a working value for a secret-like setting: a password, key, token, signing or encryption secret, or a connection string with credentials. Development, test, and CI get no exception, and neither does a value labelled fake, dev-only, test, or not a secret, bound only to loopback, or said to guard nothing real.
- Environment files are tracked only as examples (`.env.example`, `docker/env/*.env.example`) with names and empty values or obvious placeholders. A guard fails on a tracked environment file that is not an example.
- App-owned secrets come from a cryptographically secure random generator:
  - **Development.** `scripts/local.sh` generates them once on the developer's machine into an ignored owner-only file (mode 0600, directory 0700) on the Linux file system, before PostgreSQL first starts, and never overwrites it. If the file is missing while the database directory exists, the script stops instead of generating new values that cannot open the data.
  - **Test and CI.** `scripts/verify.sh` and CI generate new values for each run in a temporary directory and remove it afterwards. Tests generate the credentials they hand to anything that accepts them, with `node:crypto`, new for each run.
  - **Production.** Generated once on the server into an owner-only file. The generation step itself refuses to overwrite an existing file (for example `umask 077` with `set -o noclobber`), so running it twice is safe. `docs/deployment.md` gives the step.
- External credentials (the Entra application for Graph, the SMTP2GO API key, the failover SMTP credentials, the Zendesk API token) come from the local or CI secret store in development, from stand-ins in tests, and from the admin UI (stored encrypted) or a locking environment variable in production. They never come from a tracked file. The Zendesk token is entered at run time and never written to a file.
- The server and worker refuse to start when a required secret is missing or equals an example placeholder. The production `postgres` service gets only its own `POSTGRES_*` values, so the application's secrets never reach it.
- Planned names, final in 1b: `POSTGRES_PASSWORD`, `DATABASE_URL`, `MAANE_AUTH_SECRETS` (Better Auth's versioned `secrets` option), `MAANE_SETTINGS_KEYS` (settings encryption, versioned for rotation), `MAANE_VAPID_PUBLIC_KEY` and `MAANE_VAPID_PRIVATE_KEY`.
- The product plan calls the Better Auth secret `BETTER_AUTH_SECRET`. Maane uses `MAANE_AUTH_SECRETS` instead, as Mikud does, and refuses to start while any `BETTER_AUTH_*` or `AUTH_SECRET` variable is set, because Better Auth reads those on its own when an option is missing. `MAANE_AUTH_SECRETS` is the value the backup list means.
- A value that was ever committed is public. Moving it to an ignored file does not fix that. Never reuse it, and tell the owner where it must be replaced.
- Never copy values from the `.env` files of n8n-ops, Mikud, or any other project. A pattern in a sibling project that breaks these rules is not a precedent: record it as a finding.
- Customer data follows the same discipline: the Zendesk archive, real mail, and real tenant details never enter the repository. The backup tool refuses an output directory inside a Git working tree.

## Planned repository root

Every file the completed foundation keeps at the root:

| Root file | Git tracking policy | Why this exact root location is required | Status |
|---|---|---|---|
| `README.md` | Tracked | GitHub landing page and contributor convention | Exists |
| `AGENTS.md` | Tracked | Agent instruction discovery | Exists |
| `LICENSE` | Tracked | GitHub license detection | Exists |
| `.gitignore` | Tracked | Git reads it from the root | Exists |
| `.gitattributes` | Tracked | Git reads it from the root. Forces LF. | Exists |
| `CHANGELOG.md` | Tracked | The release workflow and readers expect it at the root | Exists (1a pull request) |
| `package.json` | Tracked | pnpm workspace root and the product version | Exists (1a pull request) |
| `pnpm-workspace.yaml` | Tracked | pnpm requires it at the workspace root. pnpm 12 reads its settings, including `allowBuilds`, only from this file. | Exists (1a pull request) |
| `pnpm-lock.yaml` | Tracked | pnpm writes the lockfile at the workspace root | Exists (1a pull request) |
| `biome.json` | Tracked | Biome 2 rejects a configuration outside the scanned root ("nested root configuration") | Exists (1a pull request) |
| `docker-compose.yml` | Tracked | Production deployment contract, run from the deployment directory | Planned (1b) |
| `.env.example` | Tracked | Environment contract that Compose reads beside `docker-compose.yml`. Names with empty values only. | Planned (1b) |
| `docker-compose-dev.yml` | Ignored, never committed | Machine-local development stack, used only through `scripts/local.sh`. Created with `cp docker/docker-compose-dev.example.yml docker-compose-dev.yml`. | Planned (1b) |
| `.env` | Ignored | Real values on a deployment only | Never created in the repository |

Directories: `apps/` and `packages/` (code), `scripts/` (workflow scripts and `scripts/lib/`), `docker/` (Dockerfiles with per-Dockerfile ignore files, the development Compose template, `docker/env/*.env.example`), `config/` (movable tool configuration: the TypeScript base config and others that support an explicit path), `docs/` (documentation, with the ignored `docs/private/`), `.github/` (workflows, Dependabot, pull request template). A tool configuration moves to the root only when the tool cannot read it elsewhere, and this table records why.

## Docker decisions

Docker is part of the runtime, development, and verification architecture. Nothing below exists yet.

- **Compose files.** Tracked `docker-compose.yml` is the production file and references published images. Ignored root `docker-compose-dev.yml` is the development file, copied from the tracked `docker/docker-compose-dev.example.yml` and used only through `scripts/local.sh`, which fails with a clear message when it is missing and never falls back to the production file. CI, verify, and release use the tracked template, never the ignored copy. Neither Compose file contains `build:`. A guard enforces it.
- **Images.** Built only by the scripts, explicitly, before the running environment changes. Development images are named `maane:dev`.
- **Environment.** Runtime variables come through Compose `env_file`, not a long `environment` list. Interpolation is limited to values Compose itself resolves: in production `VERSION`, `DOMAIN`, and the host path of the GeoLite2 directory. The development file loads secrets only from the generated owner-only file.
- **Traefik.** Production services join the external `traefik` network with labels and publish no port. Only `server` gets a router. `postgres` and `clamav` are not on the `traefik` network and publish no port. `postgres` sits on a network with no outside access (`internal: true`). `clamav` needs outbound access for freshclam to download signatures, so its network must not be `internal`, and clamd stays reachable only from `server` and `worker`.
- **Runtime identity.** Every application container runs as an unprivileged user, and the final image declares it. `scripts/local.sh status` and `scripts/verify.sh` fail when an application process runs as UID 0. An exception needs a concrete reason, the owner's approval, and documented containment.
- **Health.** Every long-running container has a health check that tests readiness, not only a running process.
- **Persistent data.** Bind-mounted host directories, no named volumes. `down` keeps them. Only a confirmed `nuke` removes the validated development data directory. Development data lives on the Linux file system, not under `/mnt/c`, because PostgreSQL fails on the Windows mount. Logs go to stdout and stderr.

| Service | Runtime user | Health check | Persistent state | Host directory | Named volume | Backup lifecycle |
|---|---|---|---|---|---|---|
| `server` | `node`, UID 1000 | Readiness endpoint that queries the database | Attachments and inline images, stored by hash (shared with `worker`) | `./data` (production), `<dev data dir>/data` (development) | None | In the owner's backup with the database |
| `worker` | `node`, UID 1000 | Heartbeat of the queue loop, recent enough | Same attachments directory as `server` | `./data` (shared) | None | Same as `server` |
| `postgres` | `postgres`, UID 999 (official entrypoint drops privileges) | `pg_isready` | Database files | `./postgres-data` (production), `<dev data dir>/postgres` (development) | None | Owner's backup. A restore test runs before cutover. |
| `clamav` | To be verified (see [Known unknowns](#known-unknowns-and-blockers)) | The image's clamd check (`PING`) | Signature database, kept so freshclam does not download it again on every start | `./clamav` | None | Disposable. Rebuilt by freshclam. |
| GeoLite2 files | Not a container | Not applicable | City and ASN databases, maintained by the owner's existing updater | Host directory mounted read-only into `server` | None | Not Maane's. Each file is optional. |

The owner may point Maane at an existing clamd instead of running `clamav`. The clamd address is a setting in the admin UI.

## Foundation implementation plan

Each row is one pull request or a coherent set of pull requests, each green in CI before merge. The owner merges.

| Order | Deliverable | Status | Acceptance criteria | Required verification |
|---|---|---|---|---|
| 1a.1 | Repository baseline | Done locally (1a pull request) | Root manifests with `packageManager` pinned, the lockfile, Biome, `config/tsconfig.base.json`, `packages/shared` skeleton with the two locale files, `CHANGELOG.md` with `Unreleased`, pull request template | `pnpm install --frozen-lockfile`, Biome, and `tsc` pass inside the toolchain container |
| 1a.2 | Toolchain image | Done locally (1a pull request) | `docker/toolchain.Dockerfile` with Node, pnpm, git, jq, shellcheck, shfmt. The host needs only Docker in WSL. | Every script runs in WSL with no Node on the host |
| 1a.3 | Guards | Done locally (1a pull request) | Hebrew outside `he.json`, a tracked environment file that is not an example, secret-like literals and private IPv4 addresses (with a local deny list in `docs/private/` that CI skips), `build:` in Compose files, shellcheck, shfmt, executable bits, LF, actions not pinned to a commit SHA, `en.json` and `he.json` keys out of sync | Each guard fails on a planted violation and passes once it is removed |
| 1a.4 | `scripts/verify.sh` (first cut) | Done locally (1a pull request) | Guards, Biome, types, unit tests, builds, with `--changed [BASE]` and `--guards-only` | Full sweep passes locally |
| 1a.5 | Path-filtered CI | Built; runs on the 1a pull request | Change detection, guards always, checks gated by changes, a final summary job, cancelled superseded pull request runs, never-cancelled `main` runs, manual full run, weekly full sweep, read-only token, SHA-pinned actions | Green run on the 1a pull request. A documentation-only change runs the guards only. |
| 1a.6 | Dependency management | Done locally (1a pull request) | `.github/dependabot.yml`: weekly npm, GitHub Actions, and Docker updates, minor and patch grouped, majors separate, no auto-merge | Dependabot shows the configuration as valid |
| 0 | Zendesk backup | Planned | [Phase 0 contract](#phase-0-contract) | Tests against a stand-in Zendesk API, run by `verify.sh`. A real run and a restore check by the owner. |
| 1b.1 | Server, worker, schema | Planned | Hono server with health endpoints, Drizzle migrations on start, the job queue with a no-op job, the audit log, startup refusal on missing or placeholder secrets and on `BETTER_AUTH_*` | Integration tests against a disposable PostgreSQL |
| 1b.2 | Sign-in and setup | Planned | [Security design](#security-design): closed route list, username and password, mandatory two-factor with enrollment-only sessions, the `admin` plugin with roles, the 5-minute setup window, atomic first admin | HTTP tests: parallel setup requests create one admin, the window closes after 5 minutes on a movable clock, routes not on the list answer 404, a session without two-factor reaches only enrollment and sign-out, a role change ends sessions, rate limits with a forged forwarding header |
| 1b.3 | Encrypted settings | Planned | Settings with defaults, encrypted secret fields, environment override that locks a field and shows the variable name | Unit and integration tests, including a locked field refused with `setting_locked` |
| 1b.4 | Web shell | Planned | `v3-ui-style` shell, sign-in, setup, enrollment with backup codes, empty home, Settings, users, audit log. Hebrew and English, RTL and LTR, light and dark. | Playwright in both languages and both themes, desktop and phone widths |
| 1b.5 | Image and Compose | Planned | `docker/maane.Dockerfile`, `docker-compose.yml`, `docker/docker-compose-dev.example.yml`, `.env.example`, `docker/env/*.env.example`, [Docker decisions](#docker-decisions) | Stack healthy, no UID 0 application process, no `build:` |
| 1b.6 | `scripts/local.sh` | Planned | [Workflow contracts](#required-workflow-contracts) | `start`, `status`, `down`, `start` again with data kept, `nuke` confirmed and refused, the secrets file never rewritten |
| 1b.7 | `scripts/verify.sh` (full) | Planned | Adds integration tests, the image with health and UID checks, and Playwright against the stack | Full sweep passes locally and in CI |
| 1b.8 | `scripts/try-pr.sh` | Planned | [Workflow contracts](#required-workflow-contracts) | Exercised on a real pull request, then `restore` |
| 1b.9 | `scripts/release.sh` and the Release workflow | Planned | [Workflow contracts](#required-workflow-contracts) | Tests for each way a run can stop, and a dry run on GitHub |
| 1b.10 | Deployment notes | Planned | `docs/deployment.md`: Traefik labels, production secret generation that refuses to overwrite, the setup window, the backup list, the restore test | Reviewed by the owner. Never deployed by an agent. |

Phases 2 to 6 follow [requirements.md](requirements.md#5-phases), each as its own planned task with its own brief.

### Phase 0 contract

- **Scope.** The content in [requirements.md](requirements.md#51-phase-0-zendesk-backup): raw API records as returned, attachments including inline images, resumable runs, a manifest that ties each expected file to a verified download or an explicit failure, and a restore check that reads the archive with no Zendesk access.
- **Token.** Entered at run time through a hidden prompt and held in memory only. Never a file, a command-line argument, or an environment variable. Sent only to the Zendesk API host. Downloads from any other host go without the token, with redirect checks and a size limit. Never logged.
- **Output.** A directory outside the repository. The tool refuses a path inside a Git working tree. The archive holds customer data and is kept for ever in the owner's backup.
- **Incremental runs.** A later run continues from the saved position of the previous one. The cutover depends on this (requirements section 6.3).
- **Tests.** A stand-in Zendesk API covers pagination, rate-limit answers, an interrupted run, a redirect to another host (token not sent), an oversized file, and a failed download recorded in the manifest. No real data in fixtures.

## Required workflow contracts

All four scripts are Bash run inside WSL (or any Linux with Docker), with `#!/usr/bin/env bash`, `set -euo pipefail`, LF line endings, and the executable bit. Each script finds the repository root from its own location. Node, pnpm, shellcheck, and shfmt run inside the toolchain container. Shared helpers live in `scripts/lib/`. No PowerShell or other shell counterparts.

- **`scripts/local.sh build|up|start|down|status|logs|nuke`.** Builds `maane:dev` explicitly and stops on the first failed build. Requires root `docker-compose-dev.yml`. Generates the development secrets once before PostgreSQL first starts and never overwrites them. `start` waits for health and checks runtime UIDs. `down` keeps data and removes orphan containers. `nuke` asks for the word `nuke` and deletes only a directory whose name marks it as Maane's development data. Development stand-ins: a stand-in Graph, a stand-in SMTP2GO API, and a local SMTP server for the failover, so nothing real is sent.
- **`scripts/verify.sh [--changed [BASE]] [--guards-only] [--skip-integration] [--only checks|integration|e2e]`.** The one verification entry point, the same in local work, CI, and release. Guards, Biome, types, unit tests, builds, a check that the schema needs no missing migration, integration tests against a disposable PostgreSQL, the image with health and UID checks, then Playwright. New secrets for each run, and full cleanup afterwards.
- **`scripts/try-pr.sh <number>|status|restore`.** Builds the pull request in a disposable worktree and runs it as a separate Compose project with its own disposable database, generated secrets, invented fixtures, and every outbound integration on stand-ins. Never touches the development stack. Never merges, pushes, or edits the working tree. `restore` removes the stack, its data, image, and worktree.
- **`scripts/release.sh --target ghcr --bump patch|minor|major [--dry-run]`.** Run by the Release workflow on `main`, which reuses a green CI run of the commit or runs CI itself. Preflight: on `main`, clean, synchronized with `origin/main`, release notes under `Unreleased`, tag and image version unused. Then version and changelog update, a release commit of exactly `package.json` and `CHANGELOG.md`, an immutable annotated tag, the image on GHCR with the version and then `latest`, and the GitHub Release from the changelog section. Never uses `git add .`, never force-pushes a tag, never overwrites a published version, never prints secrets, never deploys. Agents run it only with `--dry-run`.

## GitHub configuration

Approved by the owner on 2026-11-11. Applied after the first push on 2026-11-11 and read back from the GitHub API the same day. Every item below matched, except as noted for CodeQL.

- Repository `ShlomiPorush/maane`, public, default branch `main`. Issues on. Wiki, Projects, and Discussions off. Merge options at GitHub defaults, auto-merge off, automatic branch deletion off.
- Secret scanning and push protection on. Dependabot alerts and Dependabot security updates on. Private vulnerability reporting on.
- CodeQL default setup, default query suite. Read back as `configured` with no languages, because the repository has no code yet. The 1a task checks that the setup lists `actions` and `javascript-typescript` once its workflow and TypeScript land, and sets them if it does not.
- Actions enabled with all actions allowed. Workflows pin every action to a commit SHA, and a guard enforces it. The default `GITHUB_TOKEN` is read-only, and Actions may not approve pull requests.
- A ruleset, `Protect main`, on the default branch that blocks force pushes and deletion only. It requires no pull request and no status check, because `scripts/release.sh` pushes the release commit to `main`.
- GitHub's default labels only. Dependabot adds its own.

## Known unknowns and blockers

| Question or blocker | Why it matters | Evidence or decision needed | Owner |
|---|---|---|---|
| Does Better Auth's `organization` plugin support a unified inbox across several organizations? | Membership model and server-side scoping | Read the plugin's documentation and test: one user in several organizations, listing tickets of all of them at once with no active-organization switch. If it does not fit, bring the gap to the owner before building membership. | 1b or phase 2 task, then Shlomi |
| Atomic first-admin creation through documented Better Auth interfaces | Two parallel setup requests must not create two admins | A design that uses documented hooks plus a database-level guarantee, with a test of parallel requests. Otherwise a gap for the owner. | 1b task, then Shlomi |
| Do Mikud's gaps G6 and G7 exist in Maane? | Multi-user, public deployment | Check against the 1b design and bring each one that remains to the owner | 1b task, then Shlomi |
| ClamAV container runtime user | Baseline requires a non-root application process | Inspect `clamav/clamav`: whether clamd and freshclam run as an unprivileged user. If not, an exception needs the owner's approval, or Maane uses the owner's existing clamd. | 1b task, then Shlomi |
| Real clamd in verification | The EICAR test needs real clamd, and signature downloads are slow and rate limited | Decide whether `verify.sh` runs real ClamAV every time, only in the weekly full sweep, or with a cached signature directory | Phase 2 task |
| Provenance and license of the country flag images | They would be copied into a public repository | Find the source and license of the images the owner's other project uses, or pick a set with a known permissive license | Phase 3 task |
| Production secret generation mechanism | Production secrets must be created once and never overwritten | Write the step in `docs/deployment.md`. It must refuse to overwrite on its own. | 1b task |
| Where the Zendesk backup runs and where the archive lives | Customer data, the token, and the cutover's incremental run | Owner's workstation in WSL or the Docker host. The archive path stays outside every repository. | Phase 0 task, then Shlomi |
| Test fixtures for Hebrew mail | The Hebrew guard allows Hebrew only in `he.json` | Confirm that MIME-encoded `.eml` fixtures and `\u` escapes cover the quote-parsing and RTL tests | Phase 2 task |
| Items in [requirements.md section 10](requirements.md#10-not-verified-yet) | Each needs evidence before Maane relies on it | As listed there | Phase tasks and Shlomi |
| Plan findings P25 to P34 were not reviewed again | Their fixes may hold gaps | Covered in the result review of the phase that implements each one | Phase tasks |

## Ready-for-implementation criteria

- The owner approved the product plan and the decisions in this document. Done on 2026-11-11.
- The repository exists on GitHub with the approved settings. Done on 2026-11-11. See [GitHub configuration](#github-configuration).
- The 1a task has a brief that carries the [Secrets](#secrets) rules and the Better Auth rule, and its review follows the owner's cross-provider review tier for CI, release, and agent-instruction changes.

## Handoff to foundation implementation

The first implementation task is 1a: rows 1a.1 to 1a.6. It creates the workspace, the toolchain image, the guards, the first cut of `scripts/verify.sh`, CI, and Dependabot. Its permitted scope is repository infrastructure only: no server, web, or worker code, no Dockerfile other than the toolchain, no Compose file, and no product logic. It stops when its pull request is green in CI and handed to the owner. It updates this document's statuses and `AGENTS.md` with what now exists and how it was verified.

Phase 0 follows as its own task, then 1b. Product features beyond the foundation stay out of scope until their phase task is approved. No task deploys, releases, or merges without the owner's explicit approval.
