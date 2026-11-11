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

2. Choose an archive folder outside every Git working tree, on a disk that your backup covers. The tool refuses a folder inside a repository, also through a link or a junction, because the archive holds customer data.

3. Run the backup in a terminal. `acme` stands for the account name in `acme.zendesk.com`:

   ```bash
   node apps/zendesk-backup/dist/zendesk-backup.mjs backup --subdomain acme --email agent@example.com --out /path/to/zendesk-archive
   ```

   The tool asks for the API token and does not echo it. It reads the token only from a terminal and never writes it anywhere: not to the archive, a log, or a file.

4. Read the report at the end. `Archive check: complete` means the check below found no problem. The exit code is 0 only then. Notes list what the archive could not hold, such as a file Zendesk did not serve.

To continue a backup that stopped, or to add what changed since the last one, run the same command again with the same folder. Each run continues from the saved position.

## Check an archive

```bash
node apps/zendesk-backup/dist/zendesk-backup.mjs check --out /path/to/zendesk-archive
```

The check needs no token and no network. It reads one file at a time and confirms:

- Every raw page is listed in `raw-index.jsonl` with the SHA-256 it was written with, and still has it. A page changed after the backup fails the check, also when it is still valid JSON.
- Every export has its pages from the first to the saved position with no gap, and its last page ends the stream.
- The newest version of every ticket has its marker, `version.json`, which a run writes last, and every page of the lists the marker names: comments, audits, and, when the run could read them, the side conversations and each one's events. Each list links from every page to the next and ends on a page without a next link.
- The newest run of each collection is complete, or records why the account could not read it.
- Every file any saved version of a ticket lists, and every file in `manifest.json`, is stored with a matching SHA-256 and the size Zendesk reported, or is recorded as a failure with its reason.

## What the tool saves

- **Raw records.** Each API page is stored as Zendesk sent it, byte for byte.
- **Tickets.** The cursor-based incremental export, with each ticket's metrics (`include=metric_sets`). Deleted tickets appear with status `deleted`; files that pages saved before the deletion list still get a manifest entry.
- **Users and organizations.** The cursor-based and the time-based incremental exports.
- **Each ticket's newest version.** All comments, public comments and internal notes, with inline images listed (`include_inline_images=true`); the full audit history; and, when the account has the side conversations add-on, every side conversation with its events. Each run asks again whether side conversations can be read; a ticket deleted while it is saved does not turn them off for the others. An earlier version's pages stay in the archive when a ticket changes, and a saved version is never written over.
- **Files.** Attachments and inline images of comments, and attachments of side conversation messages.
- **Collections**, read in full on every run: brands, support addresses, groups, tags, ticket fields and forms, custom statuses, user and organization fields, satisfaction ratings, macros, triggers, and automations. A collection the account or token cannot read is recorded as unavailable and the run goes on.

Not saved yet: the answers of Zendesk's newer CSAT surveys, which Zendesk keeps apart from `satisfaction_ratings`. Check on the real account whether it uses them before relying on the archive for them. The `tags` collection lists only recently used tags; every ticket's own tags are in its raw record.

## How the tool behaves

- **Continuing.** Each export continues from the saved cursor or start time. A page is on disk, flushed, and indexed before the saved position moves past it, so a run that stops reads that page again into the same file.
- **Coverage.** The incremental export leaves out changes of the last minute. The report states the time up to which changes are in the archive, by Zendesk's own clock: the Date header of its last export answer, less one minute. For the final import at cutover, run the backup at least 5 minutes after the cutover point and confirm that this time is after it.
- **Files.** Downloaded, hashed, and stored by SHA-256. A file is recorded as failed, with the reason, when it is larger than `--max-file-mb` (default 100), its size differs from what Zendesk reported, Zendesk does not serve it in full, or it has no content URL. A rate limit, a server error, or a connection that drops, also in the middle of the file, is retried up to 3 times. Every later run asks Zendesk's Show Attachment for a fresh link to each failed comment file and tries it again; a side conversation file is tried again with the link it has. A file recorded as saved whose stored copy is missing or the wrong size is fetched again. A file is flushed to disk before it is recorded as saved. Side conversation attachments have not been checked against a real account yet.
- **The token.** It goes only to `https://<subdomain>.zendesk.com`. A link to any other host in an API answer stops the run. A file download that redirects to Zendesk's content host continues without the token. Every hop must use HTTPS and reach the API host or a Zendesk host (`*.zendesk.com`, `*.zdusercontent.com`), and a download follows at most 5 redirects.
- **Untrusted answers.** A ticket ID that is not a number, a side conversation ID with unexpected characters, a list whose next link repeats, or a path that would leave the archive stops the run.
- **Rate limits.** A `429` answer waits for `Retry-After`. A `5xx` answer or a dropped connection is retried with a growing wait, up to 6 attempts.
- **One run at a time.** A run holds `.lock` in the archive folder. A second run refuses to start while it exists, also when the run that made it has ended. If no run is active, remove `.lock` and run again.
- **Messages.** Errors name the API path only, never the host or the token.

## Archive layout

| Path | Content |
|---|---|
| `archive.json` | Format, version, and the API origin the archive belongs to. A run against another account is refused. |
| `state.json` | The saved position of each export, each ticket's newest version and the version whose pages are saved, whether the account has side conversations, and the coverage time. |
| `manifest.json` | Every expected file by attachment ID: ticket, comment (or `side:<event id>`), name, type, inline flag, the size Zendesk reported, and either `ok` with SHA-256 and size, or `failed` with the reason. |
| `raw-index.jsonl` | One line per raw page written: its path, SHA-256, and size. A later line for the same path wins. A line a crash cut short is removed by the next run. |
| `raw/incremental/<tickets, users, organizations>/<page>.json` | Export pages, numbered across runs. |
| `raw/collections/<name>/<run>/<page>.json` | Collections, by run. `unavailable.json` when the account could not read one. |
| `raw/tickets/<id>/<updated_at>/comments-<page>.json`, `audits-<page>.json`, `side_conversations-<page>.json`, `side_conversations/<id>/events-<page>.json`, `version.json` | One version of a ticket, and its marker. |
| `files/<first two characters>/<sha256>` | File content, stored once per distinct content. |
| `runs/<run>.json` | A summary of each finished run. |

Keep the archive for ever, as part of your backup. A file that ClamAV blocks on import stays only here.
