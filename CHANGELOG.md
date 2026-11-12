# Changelog

All notable changes to Maane. Add each user-visible or operational change under `Unreleased` while making it. The release workflow turns `Unreleased` into a version.

## Unreleased

- Sign-in: local accounts with a username, a password, and mandatory two-factor authentication. The first admin is created on a setup screen that stays open for 5 minutes after the server starts, while no user exists. Admins create users and set their role (admin or agent).
- Settings the admin manages, stored encrypted where secret; an environment variable can set and lock a field.
- An audit log of sign-ins, setting changes, and user administration.
- The web UI, in Hebrew (right to left, the default) and English, with light and dark themes, from phone to desktop: the setup screen for the first admin, two-factor setup with a QR code and backup codes, sign-in with an authenticator code or a backup code, and an empty ticket list. Every user has an Account page (password, signed-in sessions, backup codes, a new authenticator app). Admins have Users (add, change role, set a password, end sessions, disable and enable; the first admin stays protected), Settings (default language, session length; a value the environment sets shows locked with its variable), and the audit log. The default language applies until a browser chooses its own.
- Deployment: one container image for the server and the worker, running as an unprivileged user, and `docker-compose.yml` for a Docker host behind Traefik, with `.env.example` (the image version and the domain) and `docker/env/` (the database password and the keys, which reach each container only from its own owner-only file) as its environment contract.
- `zendesk-backup`: saves a Zendesk account (raw records, comments and internal notes, audits, attachments, and inline images) into a local archive, continues from where the last run stopped, and checks the archive without access to Zendesk. See `docs/zendesk-backup.md`.
- Development: the pnpm workspace, the toolchain container, the repository guards, `scripts/verify.sh` (with the container stack stage), CI, end-to-end tests of the web UI against the container stack, `scripts/local.sh` for a development stack, and `scripts/try-pr.sh` to run a pull request beside it.
