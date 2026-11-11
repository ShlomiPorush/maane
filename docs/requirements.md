# Maane product requirements

Status: approved by the owner, not implemented. Nothing in this document exists yet. The repository contract, the order of work, and the status of each part are in [project-foundation.md](project-foundation.md).

Maane is a self-hosted helpdesk for email only. It replaces the owner's Zendesk account and keeps all Zendesk history. Correct Hebrew and right-to-left text, in the agent UI and in the email customers receive, is the hard requirement. Volume is low.

Examples in this document use `example.com`. Real addresses, domains, tenant details, organization names, and customer data never go into the repository.

## 1. Decisions

| Subject | Decision | Reason |
|---|---|---|
| Build or adopt | Build. | Hebrew and RTL are a hard requirement. The open-source helpdesks checked (Zammad, Chatwoot, FreeScout) have no proven support, and some have open issues about outgoing Hebrew mail. |
| Name | Maane | One word that says what the system does. |
| Scope | Email only. | No chat, help center, or SLA. |
| Intake | One central shared mailbox in Microsoft 365, read through Microsoft Graph. | A mailbox per address is needless work and cannot cover the wildcard rule. Only the target of the transport rules changes. |
| Sending | SMTP2GO through its API as the primary provider, plain SMTP over TLS as the failover, from any address in the owner's domains. | This is how Zendesk sends today, with no dependency on Microsoft 365 and no mailbox per address. The SMTP2GO API reports delivery for each message. |
| Organizations | Several organizations. Each email source, an exact address or a wildcard pattern, belongs to one organization. | The owner answers for several organizations from one system. A ticket belongs to the organization of the address the customer wrote to. |
| Addresses | Exact addresses and wildcard patterns, each tied to an organization, plus a default address for mail whose support address cannot be identified. | Replaces the Zendesk support addresses. Everything is configured in the admin UI. |
| Sender display name | `Agent Name (Organization Name)`. Automated mail, such as a reminder, shows the organization name only. | Matches Zendesk today. |
| Reply-from address | The exact address the customer wrote to by default. The agent can choose any address of the same organization for each reply. | Moving a ticket to another organization is an explicit action, never a side effect of changing the address. |
| Permissions | An admin sees everything. An agent belongs to one or more organizations and sees, answers, and gets notifications only for tickets of those organizations. | One user today, but the model is ready for agents per organization. |
| Customer email layout | Built by the rules of the owner's `html-email` skill, verified with real test sends. | `dir` on `html`, `body`, and the tables, neutral colors for Outlook dark mode, and control of links the client adds by itself. |
| Stack | Same as the owner's n8n-ops and Mikud projects: TypeScript, Hono, Better Auth, Drizzle, PostgreSQL, React, Vite, and Docker Compose, with `apps/server`, `apps/web`, and a separate `apps/worker`, a PostgreSQL job queue, encrypted settings edited in the admin UI, and an audit log. | See [project-foundation.md](project-foundation.md). |
| Libraries for mail | Intake, sending, and sanitizing are written in TypeScript with established libraries, used through their documented interfaces: the Microsoft Graph SDK, a MIME parsing library, `nodemailer`, `web-push`, and an HTML sanitizing library. | No own MIME builder or parser, Graph client, or sanitizer. The owner's Python project Desk is inspiration for intake logic only, not a code source. |
| Users | Local Better Auth accounts. | Giving someone access needs no Microsoft 365 user. The tenant is used only to read the shared mailbox. |
| Repository | `ShlomiPorush/maane`, public, to use GitHub code scanning. | Docs, code, and commits are in English, and no organization detail enters the repository. |
| Runtime host | The owner's existing Docker host with Traefik. | Maane ships as Docker Compose with Traefik labels. Traefik provides public HTTPS. |
| Auto-close | Not in v1. | |
| Zendesk after cutover | How long Zendesk stays open is decided after the old Zendesk mail is checked during preparation. | |
| Per-organization content | A signature and reminder templates per organization. Categories are shared. No per-organization logo in v1. | |
| First-run setup | A web setup screen, open for 5 minutes after the server starts and only while no user exists. See section 9.1. | Owner's decision over a one-time setup code or setup before the route is exposed. |

## 2. How mail flows

No path needs the server to accept mail from the internet.

### 2.1 Intake

- A customer writes to any address in the owner's domains: a mailbox, an alias, an address that exists only in a rule, or an address that matches the wildcard rule.
- A Microsoft 365 transport rule, keyed on the recipient address, copies the message to the shared intake mailbox (for example `maane@example.com`). The rule does not forward a whole mailbox, so unrelated mail that reaches the same mailbox does not enter Maane. The intake mailbox and the bounce address are excluded from the wildcard rule.
- The worker reads the mailbox through Graph with a delta query and immutable IDs. The permission is read-only and limited to this mailbox.
- The worker stores each message in the database before it advances the cursor. Storing the same message again creates no duplicate. A malformed message is flagged for review and does not stop intake.
- If the delta token expires, the worker runs a full sync of the mailbox and skips messages already stored. At this volume a full sync is cheap, and no mail can be lost in a gap. Maane never deletes or moves messages in the mailbox.

### 2.2 Classification and matching

- **Automated mail.** Each message is classified first. Bounces, out-of-office replies, mailing lists, and mail that Maane itself sent never open a ticket, never reopen one, and never reset timers. A bounce is linked to the outgoing message that failed.
- **Support address.** Maane compares `To`, then `Cc`, with the list in the admin UI. An exact address wins over a pattern, and a more specific pattern wins over a general one. With no match, the default address applies. The chosen address is stored on the ticket and never changes by itself, even if someone later copies another support address.
- **One message, one ticket.** Mail sent to two support addresses arrives twice and is stored once.
- **Threading in three layers.** Every outgoing message carries an identifier in three places:
  1. The subject carries the ticket number, for example `[#1234]`.
  2. A small line at the top of the body, in both the HTML and the plain-text part, carries a random reference code that cannot be guessed, for example `Ref: K7QX-92MF`. The code is isolated as LTR so it does not flip inside Hebrew. It sits at the top so a client that clips long mail never cuts it.
  3. The `In-Reply-To` and `References` headers.

  A reply matches by the first layer found: headers, then the body reference code, then the subject number. A reply still reaches the right ticket when the customer's client drops the headers or the customer edits the subject. Every layer is only a hint. If the sender is not a participant of the ticket, Maane opens a new ticket, links it to the old one, and flags it for review. The new ticket does not join the old one, does not reopen it, and adds nobody to its recipients.

### 2.3 Sending

- **Primary provider, SMTP2GO.** A reply goes out from the chosen address with its display name. Maane builds the complete MIME message itself, with its own `Message-ID`, and sends it through the API's MIME endpoint (`/v3/email/mime`). SMTP2GO returns a message ID used to track delivery. If the `Message-ID` changes in transit, the body reference code and the subject number still match replies.
- **Failover, plain SMTP over TLS.** The same message goes through another SMTP server. Maane fails over only when SMTP2GO definitely did not accept the message: no connection, or a documented error that says the message was refused. If acceptance is unclear, for example a timeout after the request was sent, Maane does not fail over, because that could send the same reply twice. The message becomes `unknown`. Each message records which provider sent it. Unencrypted SMTP is not an option.
- **Per-recipient tracking.** Each send attempt is stored before it is sent. For each recipient of the attempt (the customer and every copy), Maane stores separately whether it was accepted or refused, from the per-recipient result the library returns. A retry or a failover goes only to recipients that definitely were not accepted, so no recipient gets the message twice. The state of the message derives from its recipients.
- **Message states.** Each outgoing message is stored with its `Message-ID` before it is sent. The states are `pending`, `sending`, `accepted`, `failed`, and `unknown`. An automatic retry happens only when both providers definitely did not accept the message, by their results and documented errors. Every other outcome becomes `unknown`: a crash, a timeout, a dropped connection, or a cancellation in the middle of submission. In `unknown` the owner decides whether to send again, so a customer never gets the same reply twice without the owner knowing.
- **Delivery status.** For a message sent through SMTP2GO, SMTP2GO calls a Maane webhook on each change. The webhook is authenticated by a secret path and a secret `Authorization` header that is configured at SMTP2GO, with no further API verification (owner's decision). Maane updates the status by the provider message ID. If the server crashed after SMTP2GO accepted a message and before the provider ID was stored, Maane matches the event to the stored attempt by its own `Message-ID` and the recipient, which the event carries. An event that matches no known attempt is dropped. As a safety net, a periodic job queries `/v3/activity/search` to complete the status of messages whose webhook never arrived. Duplicate, late, or reordered events are reconciled by attempt, recipient, and event time, so an old event never overwrites a newer state. The statuses are delivered, hard or soft bounce, rejected, and marked as spam. The status shows next to each message in the ticket. A bounce or a rejection flags the ticket and stops only the reminders of the waiting period that this message started. A later successful send clears the flag. A message sent through the failover shows "Sent through the backup server, no delivery tracking".
- **Versioned actions.** A scheduled reply, a reminder, and a snooze are actions with a version. When an action runs, Maane checks again that it still applies: if the customer already replied, or the action was cancelled or replaced, it does not run. Maane also checks permissions: the agent who scheduled it is still active and still belongs to the ticket's organization, and the sender address still belongs to that organization. Moving a ticket to another organization cancels its scheduled replies and rebuilds its reminders from the new organization's templates. The time zone is `Asia/Jerusalem`, including daylight saving changes.
- **`Auto-Submitted`.** Only automatic reminders carry `Auto-Submitted`. A reply an agent writes does not.
- **Bounces.** With SMTP2GO, bounces reach SMTP2GO and appear in the delivery status. With the failover server, the envelope sender (`Return-Path`) is a bounce address in the owner's domain that routes to the intake mailbox. In both cases a bounce flags the ticket and stops its reminders.
- **Domain alignment.** Every sending domain is verified at SMTP2GO (DKIM records and a custom `Return-Path`), and the failover server is in the same domain's SPF and DKIM. Mail from either provider then passes DMARC. This is checked on received mail from each provider by its `Authentication-Results`.
- **Link tracking by Maane.** SMTP2GO open and click tracking is off. Maane tracks links itself (section 3.4). Open tracking is not included because it is unreliable.

## 3. What the system does

### 3.1 Tickets and workflow

| Capability | Requirement |
|---|---|
| Statuses | New, open, pending (waiting for the customer), on hold, solved, closed. This is the Zendesk set, so imported data stays true to its source. |
| Organizations | Each organization has a name (used in the display name), its addresses and patterns, a signature, and reminder templates. The main list shows tickets of every organization the user may see, with a filter by organization. On import, each Zendesk brand becomes an organization through an explicit mapping. |
| Categories | A list managed in the admin UI. On import, the mapping from Zendesk tags to categories is explicit, and the original tags are kept beside the mapping. |
| Snooze | The ticket leaves the list and comes back on the chosen date, or earlier if the customer replies. |
| Scheduled reply | Write now and choose when to send. The agent can cancel until the message enters `sending`. The UI shows its exact state. |
| Automatic reminder | A ticket that waits for the customer for X days sends the customer a reminder from a template. X and the template are edited in the admin UI. Waiting periods imported from Zendesk never trigger a reminder. A ticket that was imported and then answered in Maane and set to pending starts a new waiting period, and reminders apply to it as usual. |
| Auto-close | Not in v1. |
| Reply | An editor with a direction per paragraph, so mixed Hebrew and English display correctly. The agent can choose the sender address, attach files, and add an internal note. An internal note never enters the quote sent to the customer. |
| Incoming mail view | The customer's HTML is sanitized by an established library and shown isolated. Remote images are blocked until the agent allows them. |
| Search | Over all history, including tickets imported from Zendesk. Search runs in PostgreSQL with partial matching of Hebrew words. |
| Agent notifications | Browser notifications only, no email, for a new ticket and for a customer reply. See section 3.5. |
| Admin UI | Organizations, addresses and patterns and their organization, the default address, categories, reminder templates and signatures per organization, agent membership in organizations, SMTP2GO and the failover server, the intake mailbox, users, and the audit log. |

### 3.2 File preview

- Maane previews images (JPEG, PNG, GIF, WebP), PDF, and text files. It decides the type from the content (magic bytes), never from the extension or the type the sender declared.
- PDF is shown in pdf.js with scripting off.
- SVG is never previewed because it can contain script. Office files are never previewed. Both are download only.
- A preview is shown only to a signed-in user with access to the ticket's organization, and only after the file was scanned and found clean. The file is served with `X-Content-Type-Options: nosniff` and an isolating Content Security Policy.
- Download links in customer email stay download only.

### 3.3 File scanning

- Scanning follows the owner's existing pattern: a ClamAV container (`clamav/clamav`, with freshclam updating signatures), and a scan of the file content through the clamd `INSTREAM` command.
- Every file is scanned before it is stored: attachments and inline images of incoming mail, files an agent uploads, and files imported from Zendesk.
- An infected file is never stored. The message itself is stored, and in place of the file Maane shows "Blocked: malicious file found" with the signature name. The block is written to the audit log. For incoming mail, the original stays only in the Microsoft 365 mailbox, because Maane does not keep the raw message when it contains an infected file. For a file imported from Zendesk, the original stays only in the phase 0 archive, so that archive is kept for ever and is part of the owner's backup. Maane records why the file is unavailable.
- Dangerous file types, executables and scripts, are blocked like an infected file. The list is edited in the admin UI and applies to the file itself, not to files inside an archive.
- ClamAV scans inside archives, but a password-protected archive or one beyond the scan limits is not fully scanned. ClamAV's documented alerts for those cases are on, and such a file is marked "not fully scanned": no preview, and never treated as clean.
- When the scanner is unavailable, the admin UI decides the behavior. The default is to block. Incoming mail marks the file "waiting for scan" and scans it again automatically when the scanner returns. An agent upload is refused with a clear message. If the owner chooses to allow, the file is stored marked "not scanned". Maane never shows a file as clean when the scanner did not answer.
- The clamd address, the unavailable-scanner policy, and a connection test are in the admin UI.

### 3.4 Link tracking

- In the HTML part of an outgoing reply, Maane replaces each link the agent wrote with a Maane URL in the owner's domain with a random code, for example `https://maane.example.com/l/9fK2...`. A click is recorded and the customer is redirected at once to the original URL.
- There is no open redirect. The original URL is stored in the database and never appears in the link, so nobody can use Maane to redirect to another site. An unknown code returns an error. The route is public and rate limited.
- Maane does not replace `mailto:` and `tel:` links, links inside the quote of an earlier message, or links in the plain-text part. Links keep their look as `html-email` requires.
- Each click stores the time, IP address, country, city, region, ISP and AS number, device type, operating system, browser, and the full user agent. Every string is length-limited.
- Location comes from local MaxMind GeoLite2 City and ASN files in a directory mounted read-only into the container. The owner's existing updater keeps them current. Customer addresses are never sent to an external service. Each file is optional and fails alone: without a file, that part of the location stays empty, and the click is still recorded and redirected. TypeScript reads the files with the `maxmind` library and parses the user agent with the standard uap-core rules.
- The real client IP comes from proxy headers only when the request came from the configured proxy. Otherwise a client could forge the header.
- Next to each message the ticket shows which links were clicked, how many times, and when. Each click shows the country flag first in reading order, then the IP address isolated as LTR. A tooltip shows the city, region, and ISP.
- Security scanners, such as Microsoft Safe Links, click links before the customer does. A click within the first seconds after delivery, from the user agent of a known scanner, or from the AS of a known scanning provider is marked "possibly a scanner". The mark states uncertainty, not a verdict: a Microsoft AS also serves ordinary users.
- Links in sent mail work only while Maane answers at that address. They never expire, also in closed tickets.
- The admin UI turns tracking on and off and sets the link domain.

### 3.5 Browser notifications

- Maane is a PWA that can be installed on a computer and on Android. Notifications arrive through standard Web Push, also with the tab closed, using established libraries.
- Each user turns notifications on per device and can turn them off. A subscription the browser revoked is deleted automatically.
- A notification shows only the ticket number and the customer name, never message content.
- A subscription belongs to a user and a device. Before each send Maane checks that the user is still authorized, within the same time limit as the session. If authorization expired or is unknown, notifications pause. If authorization was revoked, the user's subscriptions are deleted.
- A full Android app is considered only if the PWA is not enough.

## 4. Customer email layout

A conversation, as in Zendesk: it is clear who said what and when. The structure is that of an ordinary email reply, so mail clients can fold the history themselves.

### 4.1 Structure

- **Header.** A line that says the customer can reply to this email to update the conversation, and below it the reference code line. The code is at the top, not the bottom, because Gmail clips mail whose HTML exceeds about 102 KB and the code must never be clipped.
- **New message.** An open conversation block: a picture or initials, the name, the date and time in Israel time, then the content.
- **History.** An ordinary attribution line, such as "On 22 July 2026, 00:18, Jane Doe wrote:", then the whole conversation inside `<blockquote type="cite">`, newest first. Each history message uses the same conversation-block design. Gmail, Apple Mail, and Outlook on mobile and on the web fold it. Outlook for Windows shows it open. The number of messages is not limited. Only when the mail nears the Gmail limit are the oldest messages shown in short form.
- Internal notes are never included.

### 4.2 Improvements over Zendesk

- Inline images never overflow the conversation column. The server reads the image size and sets a width no wider than the column, both as an attribute and as a style, with proportional height. Outlook for Windows ignores `max-width`, so this is required. A large image is downscaled before sending.
- History that a customer quoted in a reply is detected by an established reply-parsing library and hidden in the email and in the ticket view. This is a display aid only: each message has a button that shows the full sanitized original, and a message the library is not sure about, such as a reply between quoted paragraphs, is shown in full. The library is chosen after a test on samples in Hebrew, from Outlook, forwarded messages, and replies inside the quote.
- Direction is set per paragraph by the server, never through `dir="auto"`, which Outlook supports poorly. An English message shows left to right inside a Hebrew email.
- Initials replace an empty avatar: a circle built from a table cell, not an image, so it shows with images blocked and in dark mode.
- Long addresses and strings break across lines and never widen the email, as `html-email` requires.
- Dark mode and Outlook: neutral greys, `dir` on `html`, `body`, and the tables, and handling of links the client adds by itself, as `html-email` requires.

### 4.3 Images and files

- An image embedded in the body is sent embedded (CID). An image attached as a file is sent as an attachment. The rule also applies to history messages, with downscaling before sending. If the mail nears a size limit, images in old messages show only their names.
- Files of the current message are attached. Files from earlier messages show their names with a download link.
- A download link is a Maane URL with a random code per file and no sign-in, because the customer does not use the system. The file is served as a download, never displayed inline, and the route is rate limited. A download is recorded like a link click, with IP and location. Deleting a file or a ticket disables the link. Files of internal notes never get a link.

### 4.4 Sender name

`Agent Name (Organization Name)`, with the organization of the address. Automated mail, such as a reminder, shows the organization name only. The same name appears in the conversation block of the message.

## 5. Phases

Each phase is a separate pull request with tests and green CI. No merge, release, or deployment happens without the owner's explicit approval.

| # | Phase | Content | Result |
|---|---|---|---|
| 0 | Zendesk backup | A standalone command-line tool. See section 5.1. | A complete local archive that passed a restore check. It does not mean Zendesk can be closed; that happens only after cutover. |
| 1 | Foundation | Repository, Compose, workflow scripts, CI, sign-in, encrypted settings, audit log, and job queue, based on n8n-ops and Mikud with the changes in section 8. | An empty admin UI you can sign in to. |
| 2 | Intake | Graph intake, automated-mail classification, address matching, threading, file scanning, tickets, the list, the ticket view, and file preview. Against a test mailbox it creates tickets. Against the real mailbox, until cutover, it only records (listening mode, section 6.2). | Incoming mail becomes tickets, with no sending at all. |
| 3 | Sending | Replies, addresses and display names, the outbox with its states, bounces, the email template by `html-email`, and test sends only to test addresses the owner provides. | Replies work, but only to test addresses until cutover. |
| 4 | Workflow | Statuses, categories, snooze, scheduled replies, reminders, search, and notifications. | The system covers everything the owner does in Zendesk today. |
| 5 | Import | See section 5.2. | All history inside Maane. |
| 6 | Listening and cutover | See section 6. | Maane answers customers, and Zendesk receives no new mail. |

### 5.1 Phase 0: Zendesk backup

- **Content.** The tool saves the raw API records as they are: tickets, public comments and internal notes, audit history, users, organizations, groups, tags, definitions of fields and statuses, and identifiers such as `encoded_id`.
- **Files.** It downloads the attachments themselves, including inline images (`include_inline_images`).
- **Resumable.** A run that stops can continue where it stopped.
- **Manifest.** Every expected file is tied to a verified download or to an explicit failure.
- **Token.** The API token goes only to the Zendesk API host. A file download from any other host is made without the token, with redirect checks and a size limit. The token is entered at run time and never written to a file.
- **Restore check.** The tool reads the archive without access to Zendesk and checks that everything is readable.
- The archive holds customer data. It lives outside the repository and is kept for ever as part of the owner's backup.

### 5.2 Phase 5: Import

- **Source.** Import reads the archive. Each ticket and each comment has a unique source key, so a repeated run creates no duplicates.
- **Numbers.** The Zendesk ticket number is stored in its own field. The Maane numbering floor is set at cutover, not before.
- **Fidelity.** Internal notes stay internal. Original authors, dates, fields, and statuses are kept as they are.
- **No side effects.** Import bypasses all live behavior: it reopens nothing, sends no notifications, and triggers no reminders.
- **Report.** Counts, and a list of what did not map.

## 6. Cutover

The owner makes every change in Microsoft 365 and DNS. For each step, Maane's documentation gives commands that are safe to run top to bottom. The principle: at any moment only one system answers customers.

### 6.1 Preparation

- **Mapping.** Read-only PowerShell commands list the transport rules with their priority and "stop processing" flag, the aliases and their mailbox owners, and existing forwarding. The output becomes the table of addresses and patterns in the admin UI.
- **Old Zendesk mail.** Check a few messages Zendesk sent in the past, in full: which address a customer replies to, and which identifiers the headers and body carry. A customer who replies to an address at `zendesk.com` bypasses the Microsoft 365 rules.
- **Mailbox and permission.** Create the intake mailbox and give the application read access to that mailbox only, with no general mail permission in Entra. Check that access to this mailbox works and that access to any other mailbox is refused.
- **SPF and DKIM.** Verify each sending domain at SMTP2GO, and add the failover server to the records. Zendesk stays in the records.

### 6.2 Listening (instead of running in parallel)

- Each rule gets the intake mailbox as an extra recipient beside Zendesk. Zendesk keeps answering as usual.
- In listening mode, sending to customers is blocked at the send point itself, not only in the UI. Reminders and automations are off. Only sends to test addresses the owner sets are allowed.
- In listening mode Maane opens no tickets and assigns no numbers. It records each message that arrived beside what it would have done: the chosen address, the ticket it would have matched, and its classification. The comparison with Zendesk uses this record. So there are never two versions of one message, one from Graph and one from the import.
- Rare cases are tested with deliberate mail: an alias, an address that exists only in a rule, the wildcard, a blind copy, two support addresses in one message, a bounce, and an auto-reply. Cutover happens when every case passed and the comparison with Zendesk is clean, with no minimum duration.

### 6.3 Cutover

- **Cutover point.** Choose a time. Stop answering in Zendesk, and turn off both its automations and the triggers that send notifications and receipts.
- **Routing.** Remove Zendesk from the rules, and wait for mail already in transit to arrive.
- **Final import.** Wait at least 5 minutes after the cutover point. Run an updated Zendesk backup that continues from the saved position of the previous backup, and check that it covers time after the cutover point. Only then import. The Zendesk API does not return the last minute, so the gap is required.
- **Reconciliation.** Mail that reached Maane after the cutover point is matched against what was imported, by `Message-ID` and sender. An ambiguous match is shown to the owner and decided before activation.
- **Numbering.** The first Maane ticket gets a number above the highest Zendesk number, with a gap. Zendesk numbers are kept in their own field and shown as `Zendesk #1234`. The email subject carries only the Maane number.
- **Activation.** Only after reconciliation is clean, turn on sending to customers and automations in Maane.
- **Old replies.** While Zendesk stays open, a recurring job pulls new comments and new tickets from it. A customer who replies to a closed ticket makes Zendesk open a follow-up ticket, and the job links it to the original. Progress is saved, and a repeated run creates no duplicates. Before anything pulled affects Maane, it passes the same reconciliation: if the same message already reached Maane directly, the link between both sources is kept and no second message is created. An ambiguous match, or a message without enough identifiers, goes to the owner's review list, not to the live flow. Only what passed reconciliation enters Maane as ordinary activity, with a Maane number and a notification. The owner decides when to stop this job and close Zendesk.
- **SPF.** Remove Zendesk from the records only after the rollback period ended.

### 6.4 Rollback

1. Always first: return Maane to listening mode, so sending to customers is blocked, and decide each message in `sending` or `unknown`.
2. **Routing.** Put Zendesk back in the rules, without turning its triggers and automations on yet.
3. **Restore.** Maane exports everything that happened since the cutover point, per ticket: each incoming and outgoing message with full content, attachments, and current status. Each message is marked public or internal, and sent to the customer or not sent. The owner enters the export into Zendesk by hand, keeping public and internal apart. At this volume the work is small. At the end, check ticket by ticket against the export: the messages, their visibility, and the status.
4. **Mapping.** Maane keeps a table of Maane number against the restored Zendesk ticket number. A customer who later replies to mail that Maane sent opens a new ticket in Zendesk, because Zendesk does not know Maane's identifiers. Merge it by hand into the right ticket with Zendesk's merge tool, using the table. If the target ticket is solved, reopen it in the merge, because the merge does not do so by itself. If it is closed, merging into it is not possible: create a follow-up (**Create follow-up**), update the table to the new ticket, and merge into it. Test this on at least one reply, including a solved ticket and a closed ticket.
5. Only at the end, turn the Zendesk triggers and automations back on. Turned on earlier, Zendesk would send the customer every reply that is entered by hand.

## 7. Secrets

No tracked file holds a working value for a secret-like setting, also not for development, tests, or CI. The repository holds only `.env.example` files with names and empty values. The system refuses to start when a required secret is missing or equals an example value. A value ever committed is public: it is never reused, and the owner must be told where it is still in use so it can be replaced. Values are never copied from the `.env` files of n8n-ops, Mikud, or any other project.

| Secret | Development | Tests and CI | Production |
|---|---|---|---|
| PostgreSQL password, Better Auth secret, settings encryption key | Generated once on the developer's machine by a cryptographically secure generator, into an ignored owner-only file, never overwritten. | New for each run. | Generated once on the server the same way, into an owner-only file. The encryption key and the Better Auth secret must be in the owner's backup with the database: the Better Auth secret encrypts the two-factor secrets, and without it nobody can sign in after a restore. |
| Entra application credentials, for Graph only | A separate development application, from the local secret store. Automated tests use a stand-in Graph with no real credentials. | Graph is a stand-in. | Entered in the admin UI and stored encrypted, or set through an environment variable that locks the field. |
| SMTP2GO webhook secret | Not needed. | New for each run. | Generated in the admin UI by a cryptographically secure generator, stored encrypted, and entered at SMTP2GO as the path and the `Authorization` header. The admin UI can replace it. |
| SMTP2GO API key and failover SMTP credentials | A stand-in API and a local SMTP server, with no real credentials. Real test sends use a separate key from the local secret store. | A stand-in API and SMTP server. | Entered in the admin UI and stored encrypted, or set through an environment variable that locks the field. The SMTP2GO key has the least permissions: send and read activity. |
| VAPID key for browser notifications | Generated once on the machine with the Web Push library's tool, into an ignored owner-only file, never overwritten. | New for each run. | Generated once on the server the same way, and backed up. Replacing it disconnects every notification subscription, so it is never generated again on start. |
| Zendesk API token | Not needed. Tests use a stand-in API. | A stand-in API. | Entered at run time through a secure prompt, and stored encrypted only while the old-replies job is active. Never written to a file. |

## 8. Security

- **Sign-in.** Better Auth, used as it documents itself: its routes, plugins, options, and hooks, with no wrapper around its mechanisms. As in Mikud, only a closed list of auth routes is open to the browser. Username and password (`username` plugin), and mandatory two-factor (`twoFactor` plugin). No open sign-up. The first user comes from the setup screen (section 9.1). An admin creates every other user in the admin UI.
- **Two-factor enrollment.** A new user who has not set up an authenticator can reach only the setup screen and sign-out. The server blocks every other route through Better Auth's documented interfaces, like Mikud's check. Two-factor counts as on only after a code was verified. The same rule applies after two-factor is turned off, until it is set up again.
- **Organization scope.** An agent belongs to one or more organizations. The server checks every request against that membership: lists, search, views, replies, files, notifications, and exports. An agent cannot send from an address of another organization. Removing an agent from an organization stops that organization's notifications at once. Membership is managed by Better Auth's `organization` plugin if the plugin supports a unified view across several organizations. If it does not, the gap goes back to the owner before anything custom is built.
- **Roles.** Admin and agent, through Better Auth's `admin` plugin, enforced on the server. Disabling a user or changing a role ends all of that user's sessions at once, through the plugin's documented actions. Sessions have a limited length, and sign-in attempts are rate limited.
- **Graph.** Mail read only, limited to the intake mailbox through Exchange Online RBAC for Applications. No general mail permission in Entra, because permissions add up and would bypass the limit.
- **Settings.** Every setting the owner manages is edited in the admin UI and stored encrypted where it is secret. An environment value wins and locks the field. The failover server has no unencrypted option. The SMTP2GO webhook has a secret path and a secret `Authorization` header configured at SMTP2GO. A request without the right header is refused, and an event about a message ID that Maane did not send is ignored. If the secret leaks, the damage is limited to a wrong delivery status and stopped reminders, and the admin UI replaces it.
- **Incoming content.** Incoming HTML is sanitized and shown isolated. Every file is scanned by ClamAV before it is stored, and stored by hash with a size limit. Preview exists only for safe types, by content, and only for a clean file. Everything else is a download.
- **Notification subscriptions.** Subscribing and unsubscribing need a signed-in user and CSRF protection. The server decides who owns a subscription, never the browser. Maane sends only to HTTPS endpoints of the supported browsers' push services, and never to an internal or private address, also not through a redirect. Subscription endpoints and keys are never logged and never returned to another user. Tests show that a user cannot change another user's subscription, that an internal address is refused, and that removing authorization stops notifications without affecting an authorized user.
- **Audit log.** Every sensitive action is recorded: a setting change, an address or template change, a send, a deletion, an import, and a switch between listening and sending. Secret values are never logged.
- **Backup and restore.** Not part of the application. The owner's own stack runs backups. Maane documents what a backup must include: the database, the attachments directory, the settings encryption key, the Better Auth secret, the VAPID key, and the phase 0 Zendesk archive. Without the encryption key, backed-up settings cannot be read. Without the Better Auth secret, the two-factor secrets cannot be read and nobody can sign in. One restore is tested before cutover, including a sign-in with an existing user and that user's existing authenticator.

## 9. Accepted residual risks

### 9.1 Setup screen

Owner's decision: a short window, as in Portainer. The setup screen is open only for 5 minutes after the server starts and only while no user exists. After the window closes with no setup, the screen says that setup closed and that restarting the server opens it again. A restart opens a new window. Creation is atomic, so two parallel requests never create two admins. The alternatives presented were a one-time setup code in the log and setup before the Traefik route is exposed.

Residual risk: anyone who reaches the address within those 5 minutes before the owner can become the admin. Complete setup right after the first start.

## 10. Not verified yet

Each item needs evidence before Maane relies on it.

- How Exchange actually routes aliases, rule-only addresses, the wildcard, blind copies, overlapping rules, and several support addresses in one message. Checked in listening mode with deliberate mail and message trace.
- Whether Exchange keeps the original recipient in the headers after a rule. Not checked, so a default address was decided. If the recipient is kept, Maane uses it.
- Limiting Graph to one mailbox through RBAC for Applications. Documented, but not tested against a real tenant.
- What Zendesk put in the mail it sent in the past, and which identifiers its API exposes for threading.
- A full restore of the archive, and a comparison that goes beyond counts: internal notes, inline images, custom fields, and an interrupted run.
- DMARC alignment of SMTP2GO and the failover server for each sending domain.
- That `/v3/email/mime` keeps Maane's `Message-ID` and returns a message ID, and which statuses `/v3/activity/search` actually returns. Checked with a real send before Maane relies on it. If the `Message-ID` changes, threading suffers and the issue goes back to the owner.
- Which SMTP2GO errors mean for certain that a message was not accepted, and so allow failover.
- Hebrew and RTL in the UI and in the customer's email: mixed text, quotes, attachments, light and dark mode. The `html-email` skill was measured on Outlook for Android and Outlook on the web. Outlook for iOS, the Gmail apps, and Apple Mail are checked with the phase 3 sends.
- Hebrew search quality on the owner's real content.
- Browser notifications on the owner's devices: Windows, and Android with the PWA installed, including with the tab closed. Android battery saving may delay notifications, and this is checked in practice.
- Link tracking: how much customers' security scanners inflate clicks, and whether rewritten links hurt delivery at mail providers. Checked with the real sends of phase 3.
- Email layout: whether history folds in Gmail, Outlook for Android, Outlook on the web, and Outlook for Windows, whether large images stay inside the conversation, and where exactly Gmail clips long mail. Checked with the real sends of phase 3, with a long conversation, a large image, an English message, and a quote.
- Scanning: ClamAV needs about 1.5 to 3 GB of memory for its signature database. This is an estimate, and the server must have room. If the owner's other ClamAV deployment runs on the same host, Maane can point at its clamd instead of a second container. Scanning is tested with the standard EICAR test file.

## 11. Review history

The plan passed six rounds of cross-provider review with 35 findings. The fixes for findings P25 to P34 (backup of the Better Auth secret, two-factor enrollment, per-recipient acceptance, crash before the provider ID is stored, reconciliation of old bounces, scheduled replies after a permission or organization change, encrypted archives, files blocked on import, quote parsing, and the place of the reference code) were not reviewed again. They are reviewed in the result review when the code is written.
