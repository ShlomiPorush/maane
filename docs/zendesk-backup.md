# Zendesk backup

`zendesk-backup` saves a Zendesk account into a local archive and checks that the archive is complete without access to Zendesk. It is phase 0 of [requirements.md](requirements.md#51-phase-0-zendesk-backup). The phase 5 import and the old-replies job after cutover read the same archive through `packages/zendesk`.

A finished backup does not mean Zendesk can be closed. That happens only after the cutover.

## Run a backup

You need Node.js 24 or later, a Zendesk API token, and the address of the Zendesk user the token belongs to. The token needs read access to tickets, users, organizations, and settings, so use a token of an admin.

1. Build the tool from the repository, in WSL:

   ```bash
   source scripts/lib/common.sh && build_toolchain && in_toolchain "pnpm install --frozen-lockfile && pnpm --filter @maane/zendesk-backup build"
   ```

   The result is one file with no dependencies: `apps/zendesk-backup/dist/zendesk-backup.mjs`.

2. Choose an archive folder outside every Git working tree, on a disk that your backup covers. The tool refuses a folder inside a repository, because the archive holds customer data.

3. Run the backup in a terminal. `acme` stands for the account name in `acme.zendesk.com`:

   ```bash
   node apps/zendesk-backup/dist/zendesk-backup.mjs backup --subdomain acme --email agent@example.com --out /path/to/zendesk-archive
   ```

   The tool asks for the API token and does not echo it. It reads the token only from a terminal and never writes it anywhere: not to the archive, a log, or a file.

4. Read the report at the end. `Archive check: complete` means every ticket's newest version has its comments and audits, and every file a comment lists is either stored with a verified SHA-256 or recorded as a failure with its reason. The exit code is 0 only then.

To continue a backup that stopped, or to add what changed since the last one, run the same command again with the same folder. Each run continues from the saved position.

## Check an archive

```bash
node apps/zendesk-backup/dist/zendesk-backup.mjs check --out /path/to/zendesk-archive
```

The check needs no token and no network. It parses every JSON file, rebuilds the newest version of each ticket from the export pages, and hashes every stored file again.

## What the tool does and refuses

- **Raw records.** Each API page is stored as Zendesk sent it, byte for byte.
- **Incremental exports.** Tickets and users use Zendesk's cursor-based incremental export; organizations use the time-based one. Each run continues from the saved cursor or start time. A page is on disk before the saved position moves past it, so a run that stops reads that page again into the same file.
- **Coverage.** The incremental export leaves out changes of the last minute. The report states the time up to which changes are in the archive (`Changes covered until`). For the final import at cutover, run the backup at least 5 minutes after the cutover point and confirm that this time is after it.
- **Tickets.** For the newest version of each ticket that is not deleted, the tool saves all comments (public comments and internal notes, with inline images listed) and the full audit history. An earlier version's pages stay in the archive when a ticket changes.
- **Files.** Attachments and inline images are downloaded, hashed, and stored by SHA-256. A file larger than `--max-file-mb` (default 100), a file Zendesk does not serve, or a file without a content URL is recorded as failed with the reason. Later runs try a failed file again, up to 5 attempts in all.
- **The token.** It goes only to `https://<subdomain>.zendesk.com`. A link to any other host in an API answer stops the run. A file download that redirects to another host, such as Zendesk's content host, continues without the token. Every hop must use HTTPS, and a download follows at most 5 redirects.
- **Rate limits.** A `429` answer waits for `Retry-After`. A `5xx` answer or a dropped connection is retried with a growing wait, up to 6 attempts.
- **One run at a time.** A second run on the same folder refuses to start while the first runs. A lock left by a run that crashed is taken over.
- **Messages.** Errors name the API path only, never the host or the token.

## Archive layout

| Path | Content |
|---|---|
| `archive.json` | Format, version, and the API origin the archive belongs to. A run against another account is refused. |
| `state.json` | The saved position of each export, each ticket's newest version and the version whose pages are saved, and the coverage time. |
| `manifest.json` | Every expected file by attachment ID: ticket, comment, name, type, inline flag, the size Zendesk reported, and either `ok` with SHA-256 and size, or `failed` with the reason. |
| `raw/incremental/<tickets, users, organizations>/<page>.json` | Export pages, numbered across runs. |
| `raw/collections/<name>/<run>/<page>.json` | Brands, support addresses, groups, tags, ticket fields and forms, custom statuses, user fields, and organization fields, read in full on each run. |
| `raw/tickets/<id>/<updated_at>/comments-<page>.json` and `audits-<page>.json` | Comments and audits of one version of a ticket. |
| `files/<first two characters>/<sha256>` | File content, stored once per distinct content. |
| `runs/<run>.json` | A summary of each finished run. |

Keep the archive for ever, as part of your backup. A file that ClamAV blocks on import stays only here.
