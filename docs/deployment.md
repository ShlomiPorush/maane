# Deploying Maane

Status: written before the first release. Nothing here has been run against a production server, and the Release workflow has not run on GitHub yet. What was checked, and how, is listed in [What was verified](#what-was-verified).

These notes are for the owner, who deploys production. Agents never deploy. The examples use `maane.example.com`, the folder `~/maane`, and the documentation range `192.0.2.0/24`. Replace them with your own values on the server, and keep real values out of every repository.

Every command block below runs in Bash on the Docker host and is safe to run again: a block that would overwrite something you already have refuses and changes nothing. A block in parentheses runs in a subshell, so its settings (`set -e`, `umask`) do not stay in your shell.

## What you deploy

- **Image.** `ghcr.io/shlomiporush/maane:<version>`, published by the Release workflow. Each release has an immutable version tag (for example `0.1.0`) and moves `latest`. Run a version tag, never `latest`: `docker-compose.yml` refuses to start without `VERSION`.
- **Package visibility.** GitHub creates a new package as private, also for a public repository, and a server that is not logged in cannot pull a private one. Once, after the first release and before the first deployment, open the package on GitHub (the repository's Packages, `maane`, Package settings) and change its visibility to public. To keep it private instead, log the server in with a token that can only read packages, taken from your secret store and piped to `docker login ghcr.io --username <your GitHub user> --password-stdin`; never type it on the command line.
- **Services.** `docker-compose.yml` runs `server` (the web UI and the API, behind Traefik), `worker` (background jobs), `postgres` (PostgreSQL 18, data in `./postgres-data`), and `clamav` (ClamAV 1.5.4, the virus scanner, signatures in `./clamav`). `server` and `worker` run as `node` and share the attachments in `./data`; `clamav` runs as `clamav` (UID 100) through the image's unprivileged entrypoint, with Maane's configuration from `./docker/clamav/`. `server`, `worker`, and `clamav` run with no capabilities, no new privileges, and a read-only root file system. Only `server` is on the `traefik` network. `postgres` is on a network with no route outside the stack. `clamav`, `server`, and `worker` share the `scanner` network, which can reach the internet: freshclam downloads signatures, and the worker will reach Microsoft Graph. No port is published.
- **Memory.** ClamAV holds its signature database in memory, about 1.5 to 3 GB, twice that for a moment while it loads new signatures. Make room for it on the host, or point Maane at a clamd you already run ([An outside clamd](#an-outside-clamd)).
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

This block creates `~/maane` and downloads, from the release's tag, `docker-compose.yml`, `.env.example`, the two secret contracts `postgres.env.example` and `app.env.example` (from `docker/env/` in the repository), and ClamAV's configuration `docker/clamav/clamd.conf` and `docker/clamav/freshclam.conf` (kept at the same path, where `docker-compose.yml` mounts them; they hold no secret). Set `version` to the release you deploy. It refuses when any of these files is already there.

```bash
(
  set -euo pipefail
  version=0.1.0
  dir="$HOME/maane"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must look like 1.2.3" >&2; exit 1; }
  base="https://raw.githubusercontent.com/ShlomiPorush/maane/v$version"
  mkdir -p "$dir"
  cd "$dir"
  files="docker-compose.yml .env.example postgres.env.example app.env.example docker/clamav/clamd.conf docker/clamav/freshclam.conf"
  for file in $files; do
    [ ! -e "$file" ] || { echo "error: $dir/$file exists; nothing was downloaded" >&2; exit 1; }
  done
  tmp="$(mktemp -d "$dir/.download.XXXXXX")"
  trap 'rm -rf -- "$tmp"' EXIT
  curl -fsSL -o "$tmp/docker-compose.yml" "$base/docker-compose.yml"
  curl -fsSL -o "$tmp/.env.example" "$base/.env.example"
  curl -fsSL -o "$tmp/postgres.env.example" "$base/docker/env/postgres.env.example"
  curl -fsSL -o "$tmp/app.env.example" "$base/docker/env/app.env.example"
  mkdir -p "$tmp/docker/clamav" docker/clamav
  curl -fsSL -o "$tmp/docker/clamav/clamd.conf" "$base/docker/clamav/clamd.conf"
  curl -fsSL -o "$tmp/docker/clamav/freshclam.conf" "$base/docker/clamav/freshclam.conf"
  # ln refuses an existing name, so nothing is overwritten even by a run that started at the same time.
  for file in $files; do ln "$tmp/$file" "$file"; done
  echo "Downloaded $files of v$version into $dir"
)
```

Then create the two data folders, once. `./data` holds the attachments and belongs to UID 1000, the `node` user of the server and the worker; `./clamav` holds ClamAV's signatures and belongs to UID 100, the `clamav` user. The block creates only a folder that is missing, never changes one you have, and prints the owner of each:

```bash
(
  set -euo pipefail
  cd "$HOME/maane"
  [ -e data ] || sudo install -d -o 1000 -g 1000 -m 750 data
  [ -e clamav ] || sudo install -d -o 100 -g 101 -m 755 clamav
  stat -c '%n: owner %u:%g, mode %a' data clamav
)
```

It prints `data: owner 1000:1000, mode 750` and `clamav: owner 100:101, mode 755`. Another owner means the folder was there before; give it the owner above, or the server and the worker cannot store files, and ClamAV cannot keep its signatures.

## 3. Generate the settings and secrets once

Three files sit beside `docker-compose.yml`:

| File | Read by | Holds |
|---|---|---|
| `.env` | Compose only, to fill in `docker-compose.yml`; no container receives it | `VERSION` and `DOMAIN`. No secret. |
| `postgres.env` | The `postgres` service only | The database user, name, and password |
| `app.env` | `server` and `worker` | `DATABASE_URL` with the same password, `MAANE_AUTH_SECRETS`, `MAANE_SETTINGS_KEYS`, `MAANE_TRUSTED_PROXIES` |

The secrets reach the containers only through these files, never through Compose's variable substitution, so `docker compose config --no-env-resolution` does not show them. Plain `docker compose config` reads the files and prints every secret in them. Generate the files once, on the server, and keep `postgres.env` and `app.env` with your backup: a restore without them cannot open the data (see [Back up](#5-back-up)).

The block fills in:

- `POSTGRES_PASSWORD` in `postgres.env`, and the same value in `app.env`'s `DATABASE_URL`: 32 random bytes as hex. Hex keeps the URL valid, and the server refuses a password that is not random hex.
- `MAANE_AUTH_SECRETS` and `MAANE_SETTINGS_KEYS`: `1:` and 32 random bytes as hex each, different from each other and from the password.
- `VERSION` and `DOMAIN` in `.env`.
- `MAANE_TRUSTED_PROXIES`: the subnets of the `traefik` network.

It refuses, and leaves no file of its own, when any of the three files exists, when a contract is missing or not as expected, when a value cannot be generated or read, or when `DOMAIN` is still the example. The files are readable by you only (mode 600). It prints no secret. It publishes the three files only when none exists; if another run published one meanwhile, it removes the ones it published itself and stops.

Set `version` and `domain` before you run it:

```bash
(
  set -euo pipefail
  umask 077
  version=0.1.0
  domain=maane.example.com
  cd "$HOME/maane"
  for file in .env postgres.env app.env; do
    [ ! -e "$file" ] && [ ! -L "$file" ] || { echo "error: $file exists; nothing was written" >&2; exit 1; }
  done
  for file in .env.example postgres.env.example app.env.example; do
    [ -f "$file" ] || { echo "error: $file is missing; download it first (section 2)" >&2; exit 1; }
  done
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must look like 1.2.3" >&2; exit 1; }
  [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "error: domain is not a host name" >&2; exit 1; }
  case "$domain" in *example.com) echo "error: set domain to your own host name" >&2; exit 1 ;; esac
  proxies="$(docker network inspect traefik --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}')"
  proxies="$(echo $proxies | tr ' ' ',')"
  [[ "$proxies" =~ ^[0-9A-Fa-f:.,/]+$ ]] || { echo "error: cannot read the subnets of the traefik network" >&2; exit 1; }
  pg="$(openssl rand -hex 32)" && auth="$(openssl rand -hex 32)" && settings="$(openssl rand -hex 32)" ||
    { echo "error: openssl could not generate the values" >&2; exit 1; }
  for value in "$pg" "$auth" "$settings"; do
    [[ "$value" =~ ^[0-9a-f]{64}$ ]] || { echo "error: openssl did not return 32 random bytes" >&2; exit 1; }
  done
  [ "$pg" != "$auth" ] && [ "$pg" != "$settings" ] && [ "$auth" != "$settings" ] ||
    { echo "error: the generated values are not distinct" >&2; exit 1; }
  tmp="$(mktemp -d .secrets.new.XXXXXX)"
  published=()
  done=0
  # On any failure, remove only what this run published (the same file as its own copy), then the temporary folder.
  cleanup() {
    if [ "$done" = 0 ]; then
      for file in "${published[@]}"; do [ "$file" -ef "$tmp/$file" ] && rm -f -- "$file"; done
    fi
    rm -rf -- "$tmp"
  }
  trap cleanup EXIT
  # The values reach awk through its environment, never its command line, so other users cannot see them.
  fill() {
    V_VERSION="$version" V_DOMAIN="$domain" V_PROXIES="$proxies" V_PG="$pg" V_AUTH="1:$auth" V_SETTINGS="1:$settings" \
      awk '
        /^VERSION=$/ { print "VERSION=" ENVIRON["V_VERSION"]; next }
        /^DOMAIN=/ { print "DOMAIN=" ENVIRON["V_DOMAIN"]; next }
        /^POSTGRES_PASSWORD=$/ { print "POSTGRES_PASSWORD=" ENVIRON["V_PG"]; next }
        /^DATABASE_URL=$/ { print "DATABASE_URL=postgres://maane:" ENVIRON["V_PG"] "@postgres:5432/maane"; next }
        /^MAANE_AUTH_SECRETS=$/ { print "MAANE_AUTH_SECRETS=" ENVIRON["V_AUTH"]; next }
        /^MAANE_SETTINGS_KEYS=$/ { print "MAANE_SETTINGS_KEYS=" ENVIRON["V_SETTINGS"]; next }
        /^MAANE_TRUSTED_PROXIES=$/ { print "MAANE_TRUSTED_PROXIES=" ENVIRON["V_PROXIES"]; next }
        { print }
      ' "$1.example" >"$tmp/$1"
  }
  expect() {
    local file="$1"
    shift
    for pattern in "$@"; do
      [ "$(grep -cE "$pattern" "$tmp/$file")" = 1 ] ||
        { echo "error: $file.example does not have the expected lines; nothing was written" >&2; exit 1; }
    done
  }
  fill .env
  fill postgres.env
  fill app.env
  expect .env '^VERSION=[0-9.]+$' '^DOMAIN=[A-Za-z0-9.-]+$'
  expect postgres.env '^POSTGRES_USER=maane$' '^POSTGRES_DB=maane$' '^POSTGRES_PASSWORD=[0-9a-f]{64}$'
  # The URL is checked in two parts: its scheme, user, and password, then its host and database.
  expect app.env '^DATABASE_URL=postgres://maane:[0-9a-f]{64}' '^DATABASE_URL=[^ ]*[0-9a-f]@postgres:5432/maane$' \
    '^MAANE_AUTH_SECRETS=1:[0-9a-f]{64}$' '^MAANE_SETTINGS_KEYS=1:[0-9a-f]{64}$' '^MAANE_TRUSTED_PROXIES=[0-9A-Fa-f:.,/]+$'
  # ln refuses an existing name, also one that appeared while this block ran.
  for file in postgres.env app.env .env; do
    ln "$tmp/$file" "$file"
    published+=("$file")
  done
  done=1
  echo "Wrote .env, postgres.env, and app.env in $HOME/maane (mode $(stat -c %a app.env)). Keep postgres.env and app.env with your backup."
)
```

Check the result without printing a value: `cd "$HOME/maane" && docker compose config --quiet && echo "Compose reads its files"`. Never run `docker compose config` without `--quiet` or `--no-env-resolution`, and never `cat` `postgres.env` or `app.env`, where others can see the screen: both print the secrets.

Everything else is set in Maane itself, in Settings. A variable in the lower part of `app.env` may override a setting instead; Settings then shows that field locked. Never set a `BETTER_AUTH_*` or `AUTH_SECRET` variable: the server refuses to start with one.

**Rotating a key.** Both key sets are versioned: `MAANE_AUTH_SECRETS=2:<new>,1:<old>`. The first entry signs and encrypts new data; the others only decrypt. Keep an old version listed until nothing needs it, and keep every version you ever used with the backup of `app.env`. A settings value whose key version is gone reads as not set, and Settings asks for it again. Rotation has not been tried on a deployment yet.

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

The first start of `clamav` downloads the signatures (about 110 MB) and loads them, which takes a few minutes; it reports healthy when clamd answers. Until then, and whenever the scanner fails its self-test, Settings, Files and scanning, shows the scanner as failed and incoming files wait (the default policy). Once it is healthy, open that section and press Test connection: it passes when the scanner finds the EICAR test file and alerts on an encrypted ZIP and an encrypted PDF.

Check from any machine that the server is up and migrated: `curl -fsS https://maane.example.com/healthz/ready` answers `{"ok":true,"database":"ok","version":"<version>"}`. `docker compose ps` shows `server`, `worker`, and `clamav` as `healthy`.

### An outside clamd

To scan with a clamd you already run instead of the bundled one, set Settings, Files and scanning, Scanner address to its `host:port` (or `MAANE_SCANNER_ADDRESS` in `app.env`), make it reachable from the `scanner` network, and remove the `clamav` service from your `docker-compose.yml`. That clamd must have these settings in its `clamd.conf`; compare them with `docker/clamav/clamd.conf`:

- `AlertEncrypted yes`, `AlertEncryptedArchive yes`, and `AlertEncryptedDoc yes`. Maane's self-test proves these: the scanner fails it otherwise, and counts as unavailable.
- `AlertExceedsMax yes`. No sample can prove this one, so check it yourself: without it, a file beyond a scan limit comes back clean instead of not fully scanned.
- `StreamMaxLength` at least the largest file in Settings (50 MB by default, at most 100 MB). A longer stream is refused, not scanned, and the file waits.
- A `TCPSocket` the worker can reach, and nothing else listening on it: clamd has no authentication, so keep it off any network but the one it shares with Maane.

### Connect Microsoft Graph

Maane reads one shared intake mailbox (for example `maane@example.com`) through Microsoft Graph, read only: delta queries of its Inbox and Junk Email folders, and each new message's content. It never sends, moves, marks, or deletes mail. The worker reaches `login.microsoftonline.com` and `graph.microsoft.com` over HTTPS through the `scanner` network, the only one with outbound access.

In Entra and Exchange Online (you do this; Maane changes nothing in Microsoft 365):

1. Register an application for Maane, add a client secret, and note the tenant ID, the application (client) ID, and the secret. Give the application **no** Microsoft Graph mail permission in Entra: permissions add up, and an Entra permission would bypass the limit of the next step.
2. Limit the application to the intake mailbox with Exchange Online RBAC for Applications: a service principal for the application, a management scope that holds only the intake mailbox, and the role `Application Mail.Read` assigned to the application in that scope. Microsoft documents the cmdlets in "Role Based Access Control for Applications in Exchange Online".
3. In Maane, open Settings, Microsoft Graph, and fill in the tenant (its ID or a domain such as `example.onmicrosoft.com`), the application ID, the client secret, and the intake mailbox; then Save changes. The secret is stored encrypted and never shown again; to replace it, type a new one. Each field can instead come from `app.env` (`MAANE_GRAPH_TENANT_ID`, `MAANE_GRAPH_CLIENT_ID`, `MAANE_GRAPH_CLIENT_SECRET`, `MAANE_GRAPH_MAILBOX`), which locks it in Settings; Maane refuses to start when the secret there reads as an example value. Keep the intake mode on Listening.
4. Press Test Graph. It reads only the Inbox folder's details of the saved mailbox and shows Connected, or what failed with the code Entra or Graph gave (for example `AADSTS7000215` for a wrong secret, `ErrorAccessDenied` when the application may not read the mailbox).

Within a minute the worker starts reading the mailbox. Changing the tenant or the mailbox later starts a new intake source: what Maane already took in from the old one stays, and its files that still wait for the scanner become unavailable once Graph refuses the old mailbox.

#### Your checks against the real tenant

A passing Test Graph shows that Maane can read the intake mailbox; it does not show that it can read nothing else. Do these checks once, before cutover, and again after any change to the application or its scope. They only read.

1. **Access to the intake mailbox.** Settings, Microsoft Graph, Test Graph shows Connected for the intake mailbox.
2. **Refusal on any other mailbox.** In Exchange Online PowerShell (`Connect-ExchangeOnline` first), set the three values in the first lines, then run the block. It stops before testing anything while a value is still the example, and it only reads:

   ```powershell
   & {
     $ErrorActionPreference = 'Stop'
     $appId   = '00000000-0000-0000-0000-000000000000'   # the application (client) ID
     $intake  = 'maane@example.com'                       # the intake mailbox
     $other   = 'someone@example.com'                     # any other mailbox of the tenant
     if ($appId -eq '00000000-0000-0000-0000-000000000000' -or $intake -like '*@example.com' -or $other -like '*@example.com') {
       throw 'Set $appId, $intake, and $other to your values first.'
     }
     Test-ServicePrincipalAuthorization -Identity $appId -Resource $intake | Format-Table RoleName, InScope
     Test-ServicePrincipalAuthorization -Identity $appId -Resource $other | Format-Table RoleName, InScope
   }
   ```

   The first table shows `Application Mail.Read` with `InScope` `True`; the second shows `InScope` `False` for every role. Also check in Entra, the application's API permissions, that it holds no Microsoft Graph `Mail.*` permission.
3. **The routing cases of listening mode** (requirements 6.2). While the intake mode is Listening, send deliberate mail from an outside address to: an alias, an address that exists only in a transport rule, an address the wildcard rule catches, a support address as a blind copy, two support addresses in one message, an address that bounces, and a mailbox with an automatic reply. Maane opens no ticket in listening mode; for each message it records the support address and organization it chose, the ticket or conversation it would have matched, and its classification. Until the intake log page arrives (phase 2.4), read those records on the server; this query only reads:

   ```bash
   cd "$HOME/maane" && docker compose exec -T postgres psql -U maane -d maane -c "select m.received_at, m.from_address, m.subject, r.outcome, r.classification, r.support_address, r.reason, m.review_flags from intake_record r join message m on m.id = r.message_id order by m.received_at desc limit 50"
   ```

   Each case passes when the address is the one the rule meant (or the default address where the original recipient is not kept), a message to two support addresses that arrives twice shows one record and one `copy`, and the bounce and the automatic reply show `automated`. Compare the records with what Zendesk did with the same messages.

## 5. Back up

Your backup must hold:

| What | Where | Why |
|---|---|---|
| The database | `./postgres-data`, copied while the stack is stopped, or a dump (below) | All of Maane's data: users, settings, the audit log, and the job queue |
| `app.env` and `postgres.env` | `~/maane/app.env`, `~/maane/postgres.env` | `MAANE_AUTH_SECRETS` decrypts every user's two-factor secret and backup codes: without it nobody can sign in after a restore. `MAANE_SETTINGS_KEYS` decrypts the secrets stored in Settings. The database password opens the database. Keep every key version you ever used. |
| `.env` | `~/maane/.env` | `VERSION` and `DOMAIN`; no secret |
| `docker-compose.yml` | `~/maane/docker-compose.yml` | Your copy, with any label you changed |
| Attachments | `./data` | Attachments and inline images are stored as files, named by their SHA-256, not in the database. Copy it after the dump: a dump taken after the copy of `./data` can name a file the copy lacks. |
| The VAPID key pair (from phase 4) | `app.env` | Push notifications stop for every device when it changes |
| The Zendesk archive (phase 0) | Wherever you keep it, outside every repository | The only full copy of the Zendesk history |

`./clamav` is not part of the backup: it holds only ClamAV's signatures, which freshclam downloads again into an empty folder.

Treat the backup as secret: `app.env` and `postgres.env` open the data they sit next to.

A dump, while the stack runs. It writes an owner-only file under `~/maane/backups` and never replaces one:

```bash
(
  set -euo pipefail
  umask 077
  cd "$HOME/maane"
  mkdir -p backups
  file="backups/maane-$(date -u +%Y%m%dT%H%M%SZ).dump"
  # This run's own partial file, removed however the block ends.
  partial="$(mktemp backups/.partial-XXXXXX)"
  trap 'rm -f -- "$partial"' EXIT
  docker compose exec -T postgres pg_dump -U maane -d maane -Fc >"$partial"
  # ln refuses an existing name, also one another run created meanwhile: a dump is never replaced.
  ln -- "$partial" "$file"
  echo "Wrote $HOME/maane/$file"
)
```

Then the attachments, after the dump, so every file the dump names is in the archive. The archive keeps the owners and modes the server and the worker need (`--numeric-owner`, read by root), is written owner-only under `~/maane/backups`, and never replaces one:

```bash
(
  set -euo pipefail
  umask 077
  cd "$HOME/maane"
  [ -d data ] || { echo "error: $HOME/maane/data is missing" >&2; exit 1; }
  mkdir -p backups
  file="backups/maane-data-$(date -u +%Y%m%dT%H%M%SZ).tar"
  partial="$(mktemp backups/.partial-XXXXXX)"
  trap 'rm -f -- "$partial"' EXIT
  sudo tar --numeric-owner -cpf - data >"$partial"
  # ln refuses an existing name: an archive is never replaced.
  ln -- "$partial" "$file"
  echo "Wrote $HOME/maane/$file"
)
```

Copy the dump, the data archive, `postgres.env`, `app.env`, and `.env` off the host with your own backup tools. A copy of `./postgres-data` instead of a dump is consistent only when taken with the stack stopped (`cd "$HOME/maane" && docker compose stop`, then copy keeping owners and modes, then `docker compose start`).

## 6. Test a restore

Test a restore before the cutover from Zendesk, and again from time to time. Run it on another Docker host or virtual machine with its own Traefik, never beside production: `docker-compose.yml` names its project `maane` and its Traefik router `maane`, so a second copy on the production host would take them over.

1. On the test host, create the folder `~/maane-restore` with the block of section 2, with `dir="$HOME/maane-restore"` and `version` set to the release the backup came from. Copy the backup's `.env`, `postgres.env`, and `app.env` into it (mode 600). Edit two lines of the copies: `DOMAIN` in `.env` to the test host name, for example `maane-restore.example.com`, and `MAANE_TRUSTED_PROXIES` in `app.env` to the subnets of the test host's `traefik` network. Leave every key and the password as they are: the test checks that they open the data.
2. Put the database back, before `server` ever starts on this host:
   - From a copy of `./postgres-data`: restore it as `postgres-data` in the folder with owners and modes kept.
   - From a dump: start PostgreSQL alone on the empty folder, then restore into it. Set `dump` to the dump's path:

     ```bash
     (
       set -euo pipefail
       dump="$HOME/maane-restore/maane.dump"
       cd "$HOME/maane-restore"
       [ -f "$dump" ] && [ "$(head -c 5 "$dump")" = PGDMP ] || { echo "error: $dump is not a dump from section 5" >&2; exit 1; }
       [ ! -e postgres-data ] || { echo "error: postgres-data exists; restore only into an empty folder" >&2; exit 1; }
       docker compose up -d --wait postgres
       docker compose exec -T postgres pg_restore -U maane -d maane --no-owner --exit-on-error --single-transaction <"$dump"
     )
     ```

3. Put the attachments back, also before `server` starts: unpack the data archive of section 5 as `data`, with its owners (UID 1000) and modes. Set `archive` to the archive's path:

   ```bash
   (
     set -euo pipefail
     archive="$HOME/maane-restore/maane-data.tar"
     cd "$HOME/maane-restore"
     [ -f "$archive" ] || { echo "error: $archive is missing" >&2; exit 1; }
     [ ! -e data ] || { echo "error: data exists; restore only into a folder without it" >&2; exit 1; }
     [ -z "$(tar -tf "$archive" | grep -v '^data\(/\|$\)')" ] || { echo "error: $archive holds more than data/" >&2; exit 1; }
     sudo tar --numeric-owner -xpf "$archive"
     sudo stat -c '%n: owner %u:%g, mode %a' data
   )
   ```

   It prints `data: owner 1000:1000, mode 750`.
4. Start the server and PostgreSQL only, never the worker. From phase 2 the worker reads the shared mailbox and sends mail, and a restored worker would act on real mail:

   ```bash
   cd "$HOME/maane-restore" && docker compose up -d --wait server
   ```

5. Check that the attachments came back with the database: the newest file the restored database references must be readable by the server, with the content its name says. With no stored file yet (a backup from before the first message with a file), it says so:

   ```bash
   (
     set -euo pipefail
     cd "$HOME/maane-restore"
     sha="$(docker compose exec -T postgres psql -U maane -d maane -Atc 'select sha256 from stored_file order by created_at desc limit 1')"
     if [ -z "$sha" ]; then echo "The restored database references no stored file yet; nothing to check"; exit 0; fi
     [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "error: the database did not answer with a hash" >&2; exit 1; }
     read_back="$(docker compose exec -T server sha256sum "/data/files/${sha:0:2}/$sha")" ||
       { echo "error: the server cannot read the file $sha; restore data (step 3)" >&2; exit 1; }
     [ "${read_back%% *}" = "$sha" ] || { echo "error: the file $sha does not match its hash" >&2; exit 1; }
     echo "The server reads the newest stored file, $sha, and it matches its hash"
   )
   ```

6. Open `https://maane-restore.example.com` and sign in with an existing user: the username, the password, and a current code from that user's authenticator app. This proves that the database and `MAANE_AUTH_SECRETS` restore together. Open the audit log and check that the latest entries match the time of the backup. From phase 2, also open Settings and check that the stored secrets read as set: that proves `MAANE_SETTINGS_KEYS`.
7. Remove the test stack and its data. The folder holds real data:

   ```bash
   cd "$HOME/maane-restore" && docker compose down && cd "$HOME" && sudo rm -rf -- "$HOME/maane-restore"
   ```

**After a real restore** in production, a restored database can hold sessions that ended after the backup was taken. Sign in, end the other sessions, and check the users and their roles. If `app.env` or the backup may have leaked, put a new version first in `MAANE_AUTH_SECRETS` (keep the old one listed so two-factor secrets stay readable), run `cd "$HOME/maane" && docker compose up -d`, and end every user's sessions.

## 7. Upgrade to a release

1. Read the release notes of the new version on the repository's Releases page. They say when `docker-compose.yml` or `.env.example` changed; compare your copy with the new tag's file before you continue.
2. Set `version`, then run the block. It pulls the new image, then takes a dump into `~/maane/backups` (migrations only move forward: the dump is the way back), and only then sets `VERSION` in `.env` and restarts. When the pull or the dump fails, it stops with `.env` unchanged and the running version untouched.

   ```bash
   (
     set -euo pipefail
     umask 077
     version=0.2.0
     cd "$HOME/maane"
     [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must look like 1.2.3" >&2; exit 1; }
     [ "$(grep -c '^VERSION=' .env)" = 1 ] || { echo "error: .env must have one VERSION line" >&2; exit 1; }
     docker pull "ghcr.io/shlomiporush/maane:$version"
     mkdir -p backups
     file="backups/maane-before-$version-$(date -u +%Y%m%dT%H%M%SZ).dump"
     partial="$(mktemp backups/.partial-XXXXXX)"
     trap 'rm -f -- "$partial"' EXIT
     docker compose exec -T postgres pg_dump -U maane -d maane -Fc >"$partial"
     # Only this run's own dump, published under a name nothing else holds, lets the upgrade go on.
     ln -- "$partial" "$file"
     echo "Wrote $HOME/maane/$file"
     sed -i "s/^VERSION=.*/VERSION=$version/" .env
     docker compose up -d --wait
     docker compose ps
   )
   ```

   The server applies the new migrations on start; the worker starts after it is healthy. `sed -i` keeps the mode of `.env`.

3. Check `https://maane.example.com/healthz/ready` and sign in.

To go back to an earlier version, restore the dump the block took (section 6, into an empty `postgres-data`), set the earlier `VERSION`, and start it. Starting an older version on a database that newer migrations changed is not supported.

## What was verified

Phase 2.3 (2026-11-12): Graph intake ran only against a stand-in Entra and Graph, in the integration tests and in the stack stage of `scripts/verify.sh` (a message became a ticket in live mode and an intake record in listening mode, scanned by the real ClamAV). Nothing reached Microsoft. The steps of [Connect Microsoft Graph](#connect-microsoft-graph) and the checks against the real tenant have not run.

Phase 2.2 (2026-11-12): the `clamav` service of the development template, which matches `docker-compose.yml` but for its paths, ran with `scripts/local.sh` and `scripts/verify.sh` (UID 100, healthy, the hardening checks, a signature reload on the read-only root, a restart that kept the signatures), and `docker compose config` accepted `docker-compose.yml`. The two blocks of section 2 ran as root in a throwaway container with a stand-in `curl` and `sudo`: the six files land, ClamAV's two under `docker/clamav/`, a second run refuses and keeps them, and the data folders get their owners and modes, a second run changing nothing. An outside clamd was not tried.

The data archive of section 5 and steps 3 and 5 of section 6 ran the same way, as root with a stand-in `sudo` and a stand-in `docker` that answers the database query and reads the restored folder: the archive is written mode 600 and keeps UID 1000 and the modes, which the restore puts back (`data: owner 1000:1000, mode 750`, a file `1000:1000 600`); the restore refuses an existing `data` and an archive that holds more than `data/`; the check passes for a file the database names, says so when it names none, and fails for a missing file and for changed content. Not run against a real stack.

Checked on 2026-11-11, before the first release, with stand-ins and throwaway containers. Nothing ran on a server.

- Section 2 (the folder), with a stand-in `curl`: the four files land, a second run refuses and keeps them, and a failed download leaves nothing.
- Section 3 (the three files), with a stand-in `docker network inspect`, against the examples of this release:
  - `.env`, `postgres.env`, and `app.env` get mode 600. `.env` holds only `VERSION` and `DOMAIN`; the password in `postgres.env` and in `app.env`'s `DATABASE_URL` is the same; the three values are 64 hex characters and differ; no value is printed; no temporary folder is left.
  - A second run, an existing `app.env`, the example domain, a missing `app.env.example`, or a failing `openssl` each stop the block and leave no file of its own.
  - Two runs at once: one publishes a matching set, the other stops and leaves nothing of its own.
- Sections 5 and 6, against PostgreSQL 18.6 in two throwaway Compose projects run from the `docker-compose.yml` of the time, before its secrets moved to `postgres.env` and `app.env`, with PostgreSQL's data on tmpfs through an override file instead of `./postgres-data`: the dump block writes one custom-format dump and no partial file. The restore block brings every row back into an empty database, and refuses a missing dump and an existing `postgres-data`.
- Section 7 (upgrade), with a stand-in `docker`: only `VERSION` changes, `.env` keeps mode 600, and the dump is written first. A failed pull or a failed dump stops the block with `.env` byte for byte as it was, and without `.env` the block stops before `docker`.
- Not verified:
  - The `./postgres-data` bind mount, and `server` or `worker` started on a restored database.
  - Traefik routing, the setup screen in a browser, the restore test's sign-in, an upgrade with real migrations, and key rotation.
  - No Maane release exists yet, nothing has been deployed, and the Release workflow has not run on GitHub.
  - Pulling `ghcr.io/shlomiporush/maane` on a server without `docker login` after the package is made public.
  - Since sections 5 to 7 were run, the dump and upgrade blocks write to a temporary file of their own and publish it with `ln`. That version ran only with a stand-in `docker`: two dumps in the same second leave one dump and stop the other run, and a failing `pg_dump` leaves no file.
