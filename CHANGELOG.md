# Changelog

All notable changes to Maane. Add each user-visible or operational change under `Unreleased` while making it. The release workflow turns `Unreleased` into a version.

## Unreleased

- `zendesk-backup`: saves a Zendesk account (raw records, comments and internal notes, audits, attachments, and inline images) into a local archive, continues from where the last run stopped, and checks the archive without access to Zendesk. See `docs/zendesk-backup.md`.
- Development: the pnpm workspace, the toolchain container, the repository guards, `scripts/verify.sh`, and CI.
