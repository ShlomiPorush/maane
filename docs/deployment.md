# Deploying Maane

Status: written before the first release. Nothing here has been run against a production server, and the Release workflow has not run on GitHub yet. What was checked, and how, is listed in [What was verified](#what-was-verified).

These notes are for the owner, who deploys production. Agents never deploy. The examples use `maane.example.com`, the folder `~/maane`, and the documentation range `192.0.2.0/24`. Replace them with your own values on the server, and keep real values out of every repository.

Every command block below runs in Bash on the Docker host and is safe to run again: a block that would overwrite something you already have refuses and changes nothing. A block in parentheses runs in a subshell, so its settings (`set -e`, `umask`) do not stay in your shell.

## What you deploy

- **Image.** `ghcr.io/shlomiporush/maane:<version>`, published by the Release workflow. Each release has an immutable version tag (for example `0.1.0`) and moves `latest`. Run a version tag, never `latest`: `docker-compose.yml` refuses to start without `VERSION`.
- **Services.** `docker-compose.yml` runs `server` (the web UI and the API, behind Traefik), `worker` (background jobs), and `postgres` (PostgreSQL 18, data in `./postgres-data`). `server` and `worker` run as `node`, with no capabilities, no new privileges, and a read-only root file system. Only `server` is on the `traefik` network; `postgres` and `worker` are on a network with no route outside the stack. No port is published.
- **Migrations** run every time `server` starts, before it reports healthy. The worker starts after the server is healthy. There is no separate migration step.
- **Backups** are yours. Maane has no backup feature. [Back up](#5-back-up) lists what your backup must hold.

## 1. Prepare the Docker host

You need Docker with Compose, `curl`, and `openssl` on the host, and Traefik running on an external Docker network named `traefik`. Check the network:

```bash
docker network inspect traefik --format '{{.Name}}: {{range .IPAM.Config}}{{.Subnet}} {{end}}'
```

It prints the network's name and subnets, for example `traefik: 192.0.2.0/24`. If it fails, create the network and attach Traefik to it as your Traefik setup describes. Maane does not run Traefik.

The shipped labels on `server` ask Traefik for one router:

| Label | Shipped value | Change it when |
|---|---|---|
| `traefik.docker.network` and the `networks:` entry | `traefik` | Your proxy uses another Docker network |
| `traefik.http.routers.maane.entrypoints` | `https` | Your HTTPS entry point has another name |
| `traefik.http.routers.maane.rule` | ``Host(`${DOMAIN}`)`` | Never: set `DOMAIN` in `.env` instead |
| `traefik.http.routers.maane.tls` | `true` | Add `traefik.http.routers.maane.tls.certresolver=<resolver>` if your Traefik needs a resolver per router |
| `traefik.http.routers.maane.middlewares` | `default@file` | Your middleware chain has another name |
| `traefik.http.services.maane.loadbalancer.server.port` | `8080` | Never |

Two conditions make the client address safe to trust, and Maane's rate limits depend on it. Keep both:

- Maane is reachable only through Traefik. The Compose file publishes no port; do not add one.
- Traefik replaces the forwarding headers that clients send. Do not set `forwardedHeaders.insecure` or `forwardedHeaders.trustedIPs` on the entry point Maane uses.

The agent UI, the setup screen, and later the tracked links, the download links, and the SMTP2GO webhook are all public. Serve them only over HTTPS with a certificate browsers trust: with an `https://` public URL the sign-in cookies are `Secure`, so plain HTTP does not work.

## 2. Create the deployment folder

This block creates `~/maane` and downloads `docker-compose.yml` and `.env.example` from the release's tag. Set `version` to the release you deploy. It refuses when either file is already there.

```bash
(
  set -euo pipefail
  version=0.1.0
  dir="$HOME/maane"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must look like 1.2.3" >&2; exit 1; }
  mkdir -p "$dir"
  cd "$dir"
  for file in docker-compose.yml .env.example; do
    [ ! -e "$file" ] || { echo "error: $dir/$file exists; nothing was downloaded" >&2; exit 1; }
  done
  tmp="$(mktemp -d "$dir/.download.XXXXXX")"
  trap 'rm -rf -- "$tmp"' EXIT
  for file in docker-compose.yml .env.example; do
    curl -fsSL -o "$tmp/$file" "https://raw.githubusercontent.com/ShlomiPorush/maane/v$version/$file"
  done
  # ln refuses an existing name, so nothing is overwritten even by a run that started at the same time.
  for file in docker-compose.yml .env.example; do ln "$tmp/$file" "$file"; done
  echo "Downloaded docker-compose.yml and .env.example of v$version into $dir"
)
```

## 3. Generate `.env` once

`.env` holds the database password and the two key sets. Generate it once, on the server, and keep it with your backup: a restore without it cannot open the data (see [Back up](#5-back-up)).

This block builds `.env` from `.env.example`:

- `POSTGRES_PASSWORD`: 32 random bytes as hex. Hex keeps the database URL that Compose builds from it valid.
- `MAANE_AUTH_SECRETS` and `MAANE_SETTINGS_KEYS`: `1:` and 32 random bytes as hex each, different from each other.
- `VERSION` and `DOMAIN`.
- `MAANE_TRUSTED_PROXIES`: the subnets of the `traefik` network.

It refuses, and writes nothing, when `.env` exists, when a value cannot be generated or read, or when `DOMAIN` is still the example. The file is readable by you only (mode 600). It prints no secret.

Set `version` and `domain` before you run it:

```bash
(
  set -euo pipefail
  umask 077
  version=0.1.0
  domain=maane.example.com
  cd "$HOME/maane"
  [ ! -e .env ] && [ ! -L .env ] || { echo "error: .env exists; it was left as it is" >&2; exit 1; }
  [ -f .env.example ] || { echo "error: .env.example is missing; download it first" >&2; exit 1; }
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must look like 1.2.3" >&2; exit 1; }
  [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "error: domain is not a host name" >&2; exit 1; }
  case "$domain" in *example.com) echo "error: set domain to your own host name" >&2; exit 1 ;; esac
  proxies="$(docker network inspect traefik --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}')"
  proxies="$(echo $proxies | tr ' ' ',')"
  [[ "$proxies" =~ ^[0-9A-Fa-f:.,/]+$ ]] || { echo "error: cannot read the subnets of the traefik network" >&2; exit 1; }
  pg="$(openssl rand -hex 32)"
  auth="$(openssl rand -hex 32)"
  settings="$(openssl rand -hex 32)"
  for value in "$pg" "$auth" "$settings"; do
    [[ "$value" =~ ^[0-9a-f]{64}$ ]] || { echo "error: openssl did not return 32 random bytes" >&2; exit 1; }
  done
  [ "$pg" != "$auth" ] && [ "$pg" != "$settings" ] && [ "$auth" != "$settings" ] ||
    { echo "error: the generated values are not distinct" >&2; exit 1; }
  tmp="$(mktemp .env.new.XXXXXX)"
  trap 'rm -f -- "$tmp"' EXIT
  # The values reach awk through its environment, never its command line, so other users cannot see them.
  V_VERSION="$version" V_DOMAIN="$domain" V_PROXIES="$proxies" V_PG="$pg" V_AUTH="1:$auth" V_SETTINGS="1:$settings" \
    awk '
      /^VERSION=$/ { print "VERSION=" ENVIRON["V_VERSION"]; next }
      /^DOMAIN=/ { print "DOMAIN=" ENVIRON["V_DOMAIN"]; next }
      /^POSTGRES_PASSWORD=$/ { print "POSTGRES_PASSWORD=" ENVIRON["V_PG"]; next }
      /^MAANE_AUTH_SECRETS=$/ { print "MAANE_AUTH_SECRETS=" ENVIRON["V_AUTH"]; next }
      /^MAANE_SETTINGS_KEYS=$/ { print "MAANE_SETTINGS_KEYS=" ENVIRON["V_SETTINGS"]; next }
      /^MAANE_TRUSTED_PROXIES=$/ { print "MAANE_TRUSTED_PROXIES=" ENVIRON["V_PROXIES"]; next }
      { print }
    ' .env.example >"$tmp"
  for pattern in '^VERSION=[0-9.]+$' '^DOMAIN=[A-Za-z0-9.-]+$' '^POSTGRES_PASSWORD=[0-9a-f]{64}$' \
    '^MAANE_AUTH_SECRETS=1:[0-9a-f]{64}$' '^MAANE_SETTINGS_KEYS=1:[0-9a-f]{64}$' '^MAANE_TRUSTED_PROXIES=[0-9A-Fa-f:.,/]+$'; do
    [ "$(grep -cE "$pattern" "$tmp")" = 1 ] ||
      { echo "error: .env.example does not have the expected lines; .env was not written" >&2; exit 1; }
  done
  # ln refuses an existing .env, also one that appeared while this block ran.
  ln "$tmp" .env
  echo "Wrote $HOME/maane/.env (mode $(stat -c %a .env)). Keep a copy with your backup."
)
```

Check the result without printing a value: `cd "$HOME/maane" && docker compose config --quiet && echo "Compose reads .env"`. Never run `docker compose config` without `--quiet`, and never `cat .env` where others can see the screen: both print the secrets.

Everything else is set in Maane itself, in Settings. A variable in the lower part of `.env.example` may override a setting instead; Settings then shows that field locked. Never set a `BETTER_AUTH_*` or `AUTH_SECRET` variable: the server refuses to start with one.

**Rotating a key.** Both key sets are versioned: `MAANE_AUTH_SECRETS=2:<new>,1:<old>`. The first entry signs and encrypts new data; the others only decrypt. Keep an old version listed until nothing needs it, and keep every version you ever used with the backup of `.env`. A settings value whose key version is gone reads as not set, and Settings asks for it again. Rotation has not been tried on a deployment yet.

## 4. Start and complete setup

The setup screen is open for 5 minutes after `server` starts, and only while no user exists. Have the authenticator app ready, then start:

```bash
cd "$HOME/maane" && docker compose pull && docker compose up -d && docker compose ps
```

1. Within 5 minutes, open `https://maane.example.com`. The setup screen creates the first admin: a username and a password.
2. Enable two-factor authentication right away; it is required. Scan the QR code with an authenticator app and enter the code it shows.
3. Save the backup codes the screen shows, somewhere apart from this device. They are shown once.

If the window closed before you created the admin, the setup screen says so. Restart the server; a restart opens a new 5-minute window only while no user exists:

```bash
cd "$HOME/maane" && docker compose restart server
```

Check from any machine that the server is up and migrated: `curl -fsS https://maane.example.com/healthz/ready` answers `{"ok":true,"database":"ok","version":"<version>"}`. `docker compose ps` shows `server` and `worker` as `healthy`.

## 5. Back up

Your backup must hold:

| What | Where | Why |
|---|---|---|
| The database | `./postgres-data`, copied while the stack is stopped, or a dump (below) | All of Maane's data: users, settings, the audit log, and the job queue |
| `.env` | `~/maane/.env` | `MAANE_AUTH_SECRETS` decrypts every user's two-factor secret and backup codes: without it nobody can sign in after a restore. `MAANE_SETTINGS_KEYS` decrypts the secrets stored in Settings. `POSTGRES_PASSWORD` opens the database. Keep every key version you ever used. |
| `docker-compose.yml` | `~/maane/docker-compose.yml` | Your copy, with any label you changed |
| Attachments (from phase 2) | `./data`, once the release that adds it is deployed | Attachments and inline images are stored as files, not in the database |
| The VAPID key pair (from phase 4) | `.env` | Push notifications stop for every device when it changes |
| The Zendesk archive (phase 0) | Wherever you keep it, outside every repository | The only full copy of the Zendesk history |

Treat the backup as secret: `.env` opens the data it sits next to.

A dump, while the stack runs. It writes an owner-only file under `~/maane/backups` and never replaces one:

```bash
(
  set -euo pipefail
  umask 077
  cd "$HOME/maane"
  mkdir -p backups
  file="backups/maane-$(date -u +%Y%m%dT%H%M%SZ).dump"
  [ ! -e "$file" ] || { echo "error: $file exists" >&2; exit 1; }
  docker compose exec -T postgres pg_dump -U maane -d maane -Fc >"$file.partial"
  mv -n -- "$file.partial" "$file"
  echo "Wrote $HOME/maane/$file"
)
```

Copy the dump and `.env` off the host with your own backup tools. A copy of `./postgres-data` instead of a dump is consistent only when taken with the stack stopped (`cd "$HOME/maane" && docker compose stop`, then copy keeping owners and modes, then `docker compose start`).

## 6. Test a restore

Test a restore before the cutover from Zendesk, and again from time to time. Run it on another Docker host or virtual machine with its own Traefik, never beside production: `docker-compose.yml` names its project `maane` and its Traefik router `maane`, so a second copy on the production host would take them over.

1. On the test host, create the folder with the same release's `docker-compose.yml` (section 2). Copy the backup's `.env` into it (mode 600). Edit two lines of that copy: `DOMAIN` to the test host name, for example `maane-restore.example.com`, and `MAANE_TRUSTED_PROXIES` to the subnets of the test host's `traefik` network. Leave every key as it is: the test checks that they open the data.
2. Put the database back, before `server` ever starts on this host:
   - From a copy of `./postgres-data`: restore it as `postgres-data` in the folder with owners and modes kept.
   - From a dump: start PostgreSQL alone on the empty folder, then restore into it. Set `dump` to the dump's path:

     ```bash
     (
       set -euo pipefail
       dump="$HOME/maane-restore/maane.dump"
       cd "$HOME/maane-restore"
       [ ! -e postgres-data ] || { echo "error: postgres-data exists; restore only into an empty folder" >&2; exit 1; }
       docker compose up -d --wait postgres
       docker compose exec -T postgres pg_restore -U maane -d maane --no-owner --exit-on-error --single-transaction <"$dump"
     )
     ```

3. Start the server and PostgreSQL only, never the worker. From phase 2 the worker reads the shared mailbox and sends mail, and a restored worker would act on real mail:

   ```bash
   cd "$HOME/maane-restore" && docker compose up -d --wait server
   ```

4. Open `https://maane-restore.example.com` and sign in with an existing user: the username, the password, and a current code from that user's authenticator app. This proves that the database and `MAANE_AUTH_SECRETS` restore together. Open the audit log and check that the latest entries match the time of the backup. From phase 2, also open Settings and check that the stored secrets read as set: that proves `MAANE_SETTINGS_KEYS`.
5. Remove the test stack and its data. The folder holds real data:

   ```bash
   cd "$HOME/maane-restore" && docker compose down && cd "$HOME" && sudo rm -rf -- "$HOME/maane-restore"
   ```

**After a real restore** in production, a restored database can hold sessions that ended after the backup was taken. Sign in, end the other sessions, and check the users and their roles. If `.env` or the backup may have leaked, put a new version first in `MAANE_AUTH_SECRETS` (keep the old one listed so two-factor secrets stay readable), run `cd "$HOME/maane" && docker compose up -d`, and end every user's sessions.

## 7. Upgrade to a release

1. Read the release notes of the new version on the repository's Releases page. They say when `docker-compose.yml` or `.env.example` changed; compare your copy with the new tag's file before you continue.
2. Take a dump (section 5). Migrations only move forward: the backup is the way back.
3. Set `version`, then run:

   ```bash
   (
     set -euo pipefail
     version=0.2.0
     cd "$HOME/maane"
     [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must look like 1.2.3" >&2; exit 1; }
     [ "$(grep -c '^VERSION=' .env)" = 1 ] || { echo "error: .env must have one VERSION line" >&2; exit 1; }
     sed -i "s/^VERSION=.*/VERSION=$version/" .env
     docker compose pull
     docker compose up -d --wait
     docker compose ps
   )
   ```

   The server applies the new migrations on start; the worker starts after it is healthy. `sed -i` keeps the mode of `.env`.

4. Check `https://maane.example.com/healthz/ready` and sign in.

To go back to an earlier version, restore the dump from step 2 (section 6, into an empty `postgres-data`), set the earlier `VERSION`, and start it. Starting an older version on a database that newer migrations changed is not supported.

## What was verified

Checked on 2026-11-11, before the first release, with stand-ins and throwaway containers. Nothing ran on a server.

- Section 2 (the folder), with a stand-in `curl`: both files land, a second run refuses and keeps them, and a failed download leaves nothing.
- Section 3 (`.env`), with a stand-in `docker network inspect`:
  - `.env` gets mode 600, also under a umask of 022.
  - The three values are 64 hex characters and differ from each other. Every other line stays as in `.env.example`, and no value is printed.
  - The example domain is refused. A second run refuses and leaves `.env` byte for byte.
  - A missing `.env.example`, a failing `docker` or `openssl`, `openssl` output that is not hex, or an edited example each leave no `.env` and no temporary file.
- Sections 5 and 6, against PostgreSQL 18.6 in two throwaway Compose projects: the dump block writes one custom-format dump and no partial file. The restore block brings every row back into an empty database, and refuses an existing `postgres-data`.
- Section 7 (upgrade), with a stand-in `docker`: only `VERSION` changes, `.env` keeps mode 600, and without `.env` the block stops before `docker`.
- Not verified:
  - Traefik routing, the setup screen in a browser, the restore test's sign-in, an upgrade with real migrations, and key rotation.
  - No Maane release exists yet, nothing has been deployed, and the Release workflow has not run on GitHub.
  - Whether the server can pull `ghcr.io/shlomiporush/maane` without `docker login`. That depends on the package's visibility on GitHub after the first release; check it then.
