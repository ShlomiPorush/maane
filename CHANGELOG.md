# Changelog

All notable changes to Maane. Add each user-visible or operational change under `Unreleased` while making it. The release workflow turns `Unreleased` into a version.

## Unreleased

- Sign-in: local accounts with a username, a password, and mandatory two-factor authentication. The first admin is created on a setup screen that stays open for 5 minutes after the server starts, while no user exists. Admins create users and set their role (admin or agent).
- Settings the admin manages, stored encrypted where secret; an environment variable can set and lock a field.
- An audit log of sign-ins, setting changes, and user administration.
- `zendesk-backup`: saves a Zendesk account (raw records, comments and internal notes, audits, attachments, and inline images) into a local archive, continues from where the last run stopped, and checks the archive without access to Zendesk. See `docs/zendesk-backup.md`.
- Development: the pnpm workspace, the toolchain container, the repository guards, `scripts/verify.sh`, and CI.
