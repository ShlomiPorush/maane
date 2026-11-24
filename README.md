# Maane

A self-hosted helpdesk for email only, with correct Hebrew and right-to-left text in the agent UI and in the email customers receive.

![A ticket in Maane's agent UI, in Hebrew](docs/images/ticket.png)

Maane answers customer email for several organizations from one place. Mail reaches one Microsoft 365 shared mailbox through transport rules and is read through Microsoft Graph; replies go out through SMTP2GO with a plain SMTP failover. Agents work in a web UI in Hebrew or English, and every reply reaches the customer laid out correctly in both directions. It replaces a Zendesk account and imports all of its history.

Not released yet: the first version is being prepared.

## Main features

- Tickets from email, threaded and matched to the right organization by its support addresses, including wildcard patterns.
- Replies laid out per paragraph in the right direction, with the conversation's history, sent with delivery status and bounce tracking.
- Scheduled replies, snooze, statuses, categories, search, and an automatic reminder while a ticket waits for the customer.
- Every file scanned by ClamAV before it is kept, with previews in the browser.
- Tracked links and download links in customer email.
- Sign-in with mandatory two-factor authentication, agents scoped to their organizations, and an audit log.
- Browser notifications, as an installable web app.
- An import of the full Zendesk history from a backup archive.

## Installation

Requirements: a Docker host with Traefik on an external network, a Microsoft 365 shared mailbox with an Entra application that may read it, and an SMTP2GO account (plus a second SMTP server for the failover).

Follow [the deployment notes](docs/deployment.md): download the release's `docker-compose.yml` and examples, generate the settings and secrets once, start the stack, and create the first admin within five minutes on the setup screen. Updating is one block in the same notes; uninstalling is `docker compose down` and removing the folder after a final backup.

## Common questions

- **Can Maane use a ClamAV server I already run?** Yes. Set its address in Settings, Files and scanning.
- **Does the import call Zendesk?** No. The Zendesk backup tool writes an archive, and the import reads only that archive.
- **Where do settings live?** In the admin UI. An environment variable can set and lock a field; the UI then shows which variable sets it.

## Documents

- [Deployment](docs/deployment.md)
- [Zendesk backup](docs/zendesk-backup.md)
- [Product requirements](docs/requirements.md)
- [Foundation plan, decisions, and status](docs/project-foundation.md)
- [Changelog](CHANGELOG.md)
- [Agent instructions](AGENTS.md)

<details>
<summary>Stack</summary>

TypeScript on Node.js, pnpm workspaces. Server: Hono, Better Auth, Drizzle ORM on PostgreSQL. Worker: pg-boss, the Microsoft Graph SDK, mailparser, Nodemailer, web-push. Web: React, React Router, TanStack Query, Tiptap, Vite. ClamAV, MaxMind GeoLite2, Docker Compose behind Traefik. Tests: Vitest and Playwright.

</details>

## License

MIT. See [LICENSE](LICENSE).
