# Deploying Maane

Status: written before the first release. Nothing here has been run against a production server. The Release workflow has passed two dry runs on GitHub; no version is published yet. Section 8 ran once in a throwaway stack, not on a server. What was checked, and how, is listed in [What was verified](#what-was-verified).

These notes are for the owner, who deploys production. Agents never deploy. The examples use `maane.example.com`, the folder `~/maane`, and the documentation range `192.0.2.0/24`. Replace them with your own values on the server, and keep real values out of every repository.

Every command block below runs in Bash on the Docker host and is safe to run again: a block that would overwrite something you already have refuses and changes nothing. A block in parentheses runs in a subshell, so its settings (`set -e`, `umask`) do not stay in your shell.

## What you deploy

- **Image.** `ghcr.io/shlomiporush/maane:<version>`, published by the Release workflow. Each release has an immutable version tag (for example `0.1.0`) and moves `latest`, and carries the two labels of a zero-downtime rollout ([section 8](#8-roll-out-a-release-without-downtime)). Run a version tag, never `latest`: `docker-compose.yml` refuses to start without `VERSION`.
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

The shipped labels on `server` ask Traefik for two routers to the same service: `maane` for everything on `DOMAIN`, and `maane-links` for the tracked links and download links (`/l/` and `/f/` only) on `LINK_DOMAIN` ([Link tracking](#link-tracking)):

| Label | Shipped value | Change it when |
|---|---|---|
| `traefik.docker.network` and the `networks:` entry | `traefik` | Your proxy uses another Docker network |
| `traefik.http.routers.maane.entrypoints` | `https` | Your HTTPS entry point has another name |
| `traefik.http.routers.maane.rule` | ``Host(`${DOMAIN}`)`` | Never: set `DOMAIN` in `.env` instead |
| `traefik.http.routers.maane.tls` | `true` | Add `traefik.http.routers.maane.tls.certresolver=<resolver>` if your Traefik needs a resolver per router |
| `traefik.http.routers.maane.middlewares` | `default@file` | Your middleware chain has another name |
| `traefik.http.routers.maane-links.rule` | ``Host(`${LINK_DOMAIN}`) && (PathPrefix(`/l/`) \|\| PathPrefix(`/f/`))`` | Never: set `LINK_DOMAIN` in `.env` instead |
| `traefik.http.routers.maane-links.entrypoints`, `.tls`, `.middlewares` | as for `maane` | As for `maane` |
| `traefik.http.services.maane.loadbalancer.server.port` | `8080` | Never |

Two conditions make the client address safe to trust, and Maane's rate limits depend on it. Keep both:

- Maane is reachable only through Traefik. The Compose file publishes no port; do not add one.
- Traefik replaces the forwarding headers that clients send. Do not set `forwardedHeaders.insecure` or `forwardedHeaders.trustedIPs` on the entry point Maane uses.

The agent UI, the setup screen, the tracked links and the download links, and later the SMTP2GO webhook are all public. Serve them only over HTTPS with a certificate browsers trust: with an `https://` public URL the sign-in cookies are `Secure`, so plain HTTP does not work.

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
| `.env` | Compose only, to fill in `docker-compose.yml`; no container receives it | `VERSION`, `DOMAIN`, and `LINK_DOMAIN`. No secret. |
| `postgres.env` | The `postgres` service only | The database user, name, and password |
| `app.env` | `server` and `worker` | `DATABASE_URL` with the same password, `MAANE_AUTH_SECRETS`, `MAANE_SETTINGS_KEYS`, `MAANE_TRUSTED_PROXIES`, and the VAPID key pair of browser notifications ([its own block](#browser-notification-keys-once)) |

The secrets reach the containers only through these files, never through Compose's variable substitution, so `docker compose config --no-env-resolution` does not show them. Plain `docker compose config` reads the files and prints every secret in them. Generate the files once, on the server, and keep `postgres.env` and `app.env` with your backup: a restore without them cannot open the data (see [Back up](#5-back-up)).

The block fills in:

- `POSTGRES_PASSWORD` in `postgres.env`, and the same value in `app.env`'s `DATABASE_URL`: 32 random bytes as hex. Hex keeps the URL valid, and the server refuses a password that is not random hex.
- `MAANE_AUTH_SECRETS` and `MAANE_SETTINGS_KEYS`: `1:` and 32 random bytes as hex each, different from each other and from the password.
- `VERSION`, `DOMAIN`, and `LINK_DOMAIN` in `.env`, the link domain the same as `DOMAIN`; change it as [Link tracking](#link-tracking) describes.
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
        /^LINK_DOMAIN=/ { print "LINK_DOMAIN=" ENVIRON["V_DOMAIN"]; next }
        /^POSTGRES_PASSWORD=$/ { print "POSTGRES_PASSWORD=" ENVIRON["V_PG"]; next }
        /^DATABASE_URL=$/ { print "DATABASE_URL=postgres://maane:" ENVIRON["V_PG"] "@postgres:5432/maane"; next }
        /^MAANE_AUTH_SECRETS=$/ { print "MAANE_AUTH_SECRETS=" ENVIRON["V_AUTH"]; next }
        /^MAANE_SETTINGS_KEYS=$/ { print "MAANE_SETTINGS_KEYS=" ENVIRON["V_SETTINGS"]; next }
        /^MAANE_TRUSTED_PROXIES=$/ { print "MAANE_TRUSTED_PROXIES=" ENVIRON["V_PROXIES"]; next }
        # The VAPID pair comes from its own block below, which appends both lines.
        /^MAANE_VAPID_(PUBLIC|PRIVATE)_KEY=$/ { next }
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
  expect .env '^VERSION=[0-9.]+$' '^DOMAIN=[A-Za-z0-9.-]+$' '^LINK_DOMAIN=[A-Za-z0-9.-]+$'
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

### Browser notification keys (once)

Browser notifications (Web Push) need a VAPID key pair in `app.env`: `MAANE_VAPID_PUBLIC_KEY` and `MAANE_VAPID_PRIVATE_KEY`. The server and the worker refuse to start without them, or with values that are not one key pair. The image makes them with web-push's own generator. Run this block once, after the block above on a new deployment, and before you start a release with browser notifications on an existing one.

It appends the two lines to `app.env` (after a line break when its last line has none) and changes nothing else in it. It refuses, and writes nothing, when `app.env` is missing or not mode 600, when `app.env` already sets either key in any form Compose reads (set or empty, also indented, after `export`, or with spaces around `=`), when the generator fails or prints something else, or when another run holds the file. It prints no key. Set `version` to the release you run or are about to run:

```bash
(
  set -euo pipefail
  umask 077
  version=0.1.0
  cd "$HOME/maane"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must look like 1.2.3" >&2; exit 1; }
  [ -f app.env ] && [ ! -L app.env ] || { echo "error: app.env is missing; generate it first" >&2; exit 1; }
  [ "$(stat -c %a app.env)" = 600 ] || { echo "error: app.env is not mode 600; nothing was written" >&2; exit 1; }
  # One run at a time: the lock is on app.env itself.
  exec 9<app.env
  flock -n 9 || { echo "error: another run is changing app.env; nothing was written" >&2; exit 1; }
  # Any form Compose reads counts: leading spaces, export, and spaces or another separator after the name.
  if grep -qE '^[[:space:]]*(export[[:space:]]+)?MAANE_VAPID_(PUBLIC|PRIVATE)_KEY([^][A-Za-z0-9_.-]|$)' app.env; then
    echo "error: app.env already sets a VAPID key; nothing was written (a new pair disconnects every device)" >&2
    exit 1
  fi
  # web-push's generateVAPIDKeys in the release's image, without network or privileges.
  keys="$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "ghcr.io/shlomiporush/maane:$version" dist/worker/vapid-keys.js)"
  shape=$'^MAANE_VAPID_PUBLIC_KEY=[A-Za-z0-9_-]{87}\nMAANE_VAPID_PRIVATE_KEY=[A-Za-z0-9_-]{43}$'
  [[ "$keys" =~ $shape ]] || { echo "error: the generator printed something unexpected; nothing was written" >&2; exit 1; }
  # A last line without its newline would take the first key as part of its value.
  separator=""
  if [ -n "$(tail -c 1 app.env)" ]; then separator=$'\n'; fi
  printf '%s%s\n' "$separator" "$keys" >>app.env
  [ "$(grep -cE '^MAANE_VAPID_(PUBLIC|PRIVATE)_KEY=.+' app.env)" = 2 ] && [ "$(stat -c %a app.env)" = 600 ] ||
    { echo "error: app.env does not hold the two keys as expected; check it before you start Maane" >&2; exit 1; }
  echo "Added the VAPID key pair to $HOME/maane/app.env. Keep app.env with your backup."
)
```

Keep the pair with your backup of `app.env`. Never generate it again for a running deployment: a new pair disconnects every device, and each user must turn notifications on again on each device. A device whose push service no longer takes a subscription (the user turned notifications off in the browser, or uninstalled it) is removed by itself on the next notification.

Notifications need `https`: the push services refuse a VAPID subject that is not, so Maane uses its `https://` public address. Maane sends only to the push services of Chrome and Android (`fcm.googleapis.com`), Firefox (`updates.push.services.mozilla.com`), Edge (`*.notify.windows.com`), and Safari (`*.push.apple.com`), over HTTPS; the server needs outbound HTTPS to them.

## 4. Start and complete setup

The setup screen is open for 5 minutes after `server` starts, and only while no user exists. Have the authenticator app ready, then start:

```bash
cd "$HOME/maane" && test -f docker-compose.yml && docker compose pull && docker compose up -d && docker compose ps
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
3. In Maane, open Settings, Microsoft Graph, and fill in the tenant (its ID or a domain such as `example.onmicrosoft.com`), the application ID, the client secret, and the intake mailbox; then Save changes. The secret is stored encrypted and never shown again; to replace it, type a new one. Each field can instead come from `app.env` (`MAANE_GRAPH_TENANT_ID`, `MAANE_GRAPH_CLIENT_ID`, `MAANE_GRAPH_CLIENT_SECRET`, `MAANE_GRAPH_MAILBOX`), which locks it in Settings; Maane refuses to start when the secret there reads as an example value. Maane is live from the first moment: once a default address exists (Admin, Organizations), each message in the intake mailbox opens or joins a ticket, so keep the Microsoft 365 rules pointing at Zendesk until [setup day](#setup-day-from-zendesk-to-maane), and connect Graph only after the first import.
4. Press Test Graph. It reads only the Inbox folder's details of the saved mailbox and shows Connected, or what failed with the code Entra or Graph gave (for example `AADSTS7000215` for a wrong secret, `ErrorAccessDenied` when the application may not read the mailbox).

Within a minute the worker starts reading the mailbox. Changing the tenant or the mailbox later starts a new intake source: what Maane already took in from the old one stays, and its files that still wait for the scanner become unavailable once Graph refuses the old mailbox.

#### Your checks against the real tenant

A passing Test Graph shows that Maane can read the intake mailbox; it does not show that it can read nothing else. Do these checks once, before you point the Microsoft 365 rules at the intake mailbox, and again after any change to the application or its scope. They only read.

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
3. **The routing cases** (requirements 6.1). Right after step 4 of [setup day](#setup-day-from-zendesk-to-maane), never before it (each test ticket takes a number the last import may need), send deliberate mail from an outside address to: an alias, an address that exists only in a transport rule, an address the wildcard rule catches, a support address as a blind copy, two support addresses in one message, an address that bounces, and a mailbox with an automatic reply. Each message opens or joins a ticket like any customer's mail (solve the test tickets afterwards); automated mail opens none. Read what Maane did on the Intake log page (admins): each entry shows the outcome, the support address and organization, the ticket, the reason, and the review flags. The same records, read on the server; this query only reads:

   ```bash
   cd "$HOME/maane" && docker compose exec -T postgres psql -U maane -d maane -c "select m.received_at, m.from_address, m.subject, r.outcome, r.classification, r.support_address, r.reason, m.review_flags from intake_record r join message m on m.id = r.message_id order by m.received_at desc limit 50"
   ```

   Each case passes when the address is the one the rule meant (or the default address where the original recipient is not kept), a message to two support addresses that arrives twice shows one record and one `copy`, and the bounce and the automatic reply show `automated`. If a case went to the wrong organization, fix the addresses under Organizations and move the ticket.

### Connect SMTP2GO's delivery status

Maane learns what happened to a reply after SMTP2GO accepted it (delivered, bounced, rejected, or reported as spam) in two ways: SMTP2GO calls Maane's webhook on each event, and every ten minutes the worker asks SMTP2GO's activity search about recipients that still have no final status. Both only change what the ticket view shows; neither sends anything. You set them up at SMTP2GO; Maane changes nothing there.

1. **Turn off SMTP2GO's own tracking.** Maane tracks links itself ([Link tracking](#link-tracking)) and does not track opens. At SMTP2GO, open the SMTP user Maane sends with (Sending, SMTP Users, the user, Tracking & Status in SMTP2GO's current menus) and turn off Open Tracking and Click Tracking. SMTP2GO's menu names change from time to time; the settings are per SMTP user.
2. **Make the webhook's address and token.** In Maane, open Settings, SMTP2GO, and press Make address and token under Delivery webhook. Maane shows the webhook URL (`https://maane.example.com/hooks/smtp2go/<secret part>`) and a Bearer token once. Copy both now; Maane keeps them encrypted and never shows them again. Make new ones whenever either may have leaked: the old ones stop working at once.
3. **Add the webhook at SMTP2GO** (Settings, Webhooks, Add webhook):
   - URL: the webhook URL from step 2.
   - Output format: JSON (form also works).
   - Authorization header: the type Bearer, and the token from step 2 as its value.
   - Events: Delivered, Bounce, Reject, and Spam. Maane ignores the others.
   - Usernames: the SMTP user Maane sends with.

   A request without the right address answers as an address that does not exist; the right address without the right token is refused. SMTP2GO retries a refused or failed call for up to 48 hours.
4. **Give Maane an API key for the activity search.** At SMTP2GO (Sending, API Keys), add a key for Maane and limit its permissions to the activity search (`/activity/search`) where SMTP2GO offers that, and paste it into Settings, SMTP2GO, API key (or `MAANE_SMTP2GO_API_KEY` in `app.env`, which locks the field). It is stored encrypted and never shown again. Without a key the activity search does not run, and only the webhook reports delivery status.
5. **Keep the secret address out of logs.** Maane never logs the webhook's path, its header, or its body. Traefik's access log, when it is on, records each request's path, the webhook's secret part included: keep the access log off for Maane's router, or make sure it drops the request path. If a log ever recorded it, make new webhook secrets (step 2) and update SMTP2GO (step 3).

Replies sent through the backup server have no webhook: their bounces come back to the bounce address, which reaches the intake mailbox, and Maane reads each delivery report there. Only the recipients a report names as `failed` count as bounced; a report that does not say which recipient failed shows on the reply.

Check it with a real send, in the [rehearsal](#rehearsal) and after Finish import, never between the first import and Finish import of [setup day](#setup-day-from-zendesk-to-maane) (a test ticket takes a number): reply to a test ticket at an address of yours, and within a minute the reply's recipient shows Delivered. A reply to an address that does not exist shows Bounced, and the ticket shows Delivery failed until a later reply to that address is accepted.

### Link tracking

While Settings, Link tracking, Track links is on (the default), the links an agent writes in a reply lead through Maane as `https://<link domain>/l/<code>`, and each click is recorded with its address, its location, and its browser before the customer is sent on. Files of earlier messages in a reply's history always get a download link, `https://<link domain>/f/<code>`. Turn tracking off there (or with `MAANE_LINK_TRACKING=off` in `app.env`) to send links as written and record nothing; links in replies already sent keep working either way. Keep SMTP2GO's own click tracking off.

**The link domain.** Section 3 sets `LINK_DOMAIN` to `DOMAIN`, so links use the agent UI's host name, and nothing more is needed. To use another host name, for example `links.example.com`:

1. Point its DNS record at your Traefik, as for `DOMAIN`, and make sure Traefik has a certificate for it.
2. Set `LINK_DOMAIN=links.example.com` in `.env`. The `maane-links` router then answers on that name, for `/l/` and `/f/` only; the agent UI stays on `DOMAIN`.
3. Set Settings, Link tracking, Link domain to the same name (or `MAANE_LINK_DOMAIN` in `app.env`).
4. `cd "$HOME/maane" && docker compose up -d`, then open `https://links.example.com/l/test` in a browser: Maane answers that the link does not work. That page proves the route; a reply's real links work the same way.

Change the link domain only while the old name still reaches Maane: replies already sent keep their old links.

**Location (GeoLite2).** Maane reads the location of a click from MaxMind GeoLite2 files on the host, never from an outside service. Your existing updater keeps them current; Maane only reads them. `docker-compose.yml` mounts the folder `./geoip` next to it read only at `/geoip` in `server`, and reads `GeoLite2-City.mmdb` (country, city, region) and `GeoLite2-ASN.mmdb` (ISP and AS number) from it. Each file is optional and fails alone: without one, its part of the location stays empty and clicks are still recorded. Maane looks at the files at most once a minute and reads a file again when its modification time changes, so an update needs no restart; a file that cannot be read (for example one your updater is still writing) leaves the last good copy in use until the next look. Point `./geoip` at your updater's folder with a link (here `/srv/geoip`, where `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb` sit), or have your updater write into `./geoip` itself. Docker creates an empty `./geoip` on the first start; the block replaces it only while it is empty, stops when the target is not a folder or `./geoip` holds files or links elsewhere, and can run again after it stopped halfway. It recreates `server`, which sees a new link only then:

```bash
(
  set -euo pipefail
  target=/srv/geoip
  cd "$HOME/maane"
  [ -d "$target" ] || { echo "error: $target is not a folder; nothing was changed" >&2; exit 1; }
  [ ! -L geoip ] || [ "$(readlink geoip)" = "$target" ] || { echo "error: ./geoip points elsewhere; nothing was changed" >&2; exit 1; }
  [ -L geoip ] || [ ! -e geoip ] || rmdir geoip
  ln -sfnT "$target" geoip
  docker compose up -d --force-recreate server
)
```

The folder must be readable by UID 1000; the server never writes to it. Check what the server sees:

```bash
cd "$HOME/maane" && docker compose exec -T server ls -l /geoip
```

**The client address** of a click and of the rate limits (60 requests a minute per address over both routes) comes from `X-Forwarded-For` only when the request came from one of `MAANE_TRUSTED_PROXIES`; set it to the subnets of the `traefik` network as section 3 does. Without it every click records Traefik's own address, and all clients share the sign-in limit of that one address.

### Import from Zendesk

Admin, Import brings the history of the phase 0 archive ([zendesk-backup.md](zendesk-backup.md)) into Maane, on [setup day](#setup-day-from-zendesk-to-maane). It reads the archive and never calls Zendesk, so it needs no token. `docker-compose.yml` mounts the folder `./zendesk-archive` next to it read only at `/zendesk-archive` in `server` (the page shows the archive's brands, tags, and state) and in `worker` (the import reads it). Maane never writes to it. Point `./zendesk-archive` at the archive's folder with a link (here `/srv/zendesk-archive`, the folder that holds `archive.json`). Docker creates an empty `./zendesk-archive` on the first start; the block replaces it only while it is empty, stops when the target holds no `archive.json` or `./zendesk-archive` holds files or links elsewhere, and can run again after it stopped halfway. It recreates `server` and `worker`, which see a new link only then:

```bash
(
  set -euo pipefail
  target=/srv/zendesk-archive
  cd "$HOME/maane"
  [ -f "$target/archive.json" ] || { echo "error: $target holds no archive.json; nothing was changed" >&2; exit 1; }
  [ ! -L zendesk-archive ] || [ "$(readlink zendesk-archive)" = "$target" ] ||
    { echo "error: ./zendesk-archive points elsewhere; nothing was changed" >&2; exit 1; }
  [ -L zendesk-archive ] || [ ! -e zendesk-archive ] || rmdir zendesk-archive
  ln -sfnT "$target" zendesk-archive
  docker compose up -d --force-recreate server worker
)
```

The folder must be readable by UID 1000. Check what the worker sees:

```bash
cd "$HOME/maane" && docker compose exec -T worker ls -l /zendesk-archive/archive.json /zendesk-archive/state.json
```

Then, on the Import page: map each brand to an organization (a brand without one is not imported), map the tags you want to categories (each ticket keeps its tags as they are), choose the Maane user that Zendesk agents' comments are written by, save, and start. A run refuses, and says why, while a backup holds the archive's lock, when the archive fails the strict check of `zendesk-backup check`, or when it comes from another Zendesk account than earlier imports. A backup that runs during an import stops it; start again afterwards, and the run goes over every ticket. Run the import again after each new backup: it updates the same tickets and adds no duplicate. Files come from the archive too, through the scanner, into `./data` like any attachment: the report lists each file the backup could not download, and each the scanner found infected or of a blocked type, which Maane does not store. A later backup that downloads a failed file lets the next run add it. While the scanner does not answer (with its unavailable policy `block`), the run stops and goes on by itself once it does.

The import is open until an admin presses **Finish import** on the Import page (step 4 of setup day), which is final: it is refused while a run is open, recorded in the audit log, and afterwards every import is refused. Until then imported tickets are read-only for agents, while customer mail still joins them. After each run, new Maane tickets continue right after the highest imported number, and the numbering never moves back.

### Rehearsal

Rehearse on the production server before setup day: the first deployment is a rehearsal with your real Zendesk archive, Microsoft 365, and SMTP2GO, and only your own test mail. When it ends, its whole folder is set aside and you deploy again from section 2, with a new database, new secrets, and the settings entered once more. A rehearsal's database can never become the real one: a ticket cannot be deleted, so each test ticket keeps a number, and the import skips the Zendesk ticket that gets the same number later.

1. **Mark it.** After section 2 and before anything starts, run this block. It refuses once the deployment has ever started, so a deployment in use can never be marked:

   ```bash
   (
     set -euo pipefail
     cd "$HOME/maane"
     [ -f docker-compose.yml ] || { echo "error: download the files first (section 2)" >&2; exit 1; }
     [ ! -e postgres-data ] || { echo "error: this deployment has already started; nothing was changed" >&2; exit 1; }
     touch REHEARSAL
     echo "$HOME/maane is marked as a rehearsal"
   )
   ```

2. **Deploy and configure it** with sections 3 and 4. Provider credentials come from your secret store and go into Settings. Keep the Zendesk archive outside `~/maane`, with `./zendesk-archive` a link to it.
3. **Give it a mailbox of its own**, for example `maane-rehearsal@example.com`: a shared mailbox hidden from the address lists, added to the application's management scope while the rehearsal lasts. For mail to the support addresses, add one transport rule above the Zendesk rules that matches only your own test addresses as the sender, redirects to that mailbox (not a copy, so Zendesk opens no ticket), and stops processing more rules. Set the bounce address of the backup server to one that reaches only that mailbox.
4. **Rehearse.** Run the Zendesk backup and the import, and read the report. Then connect Microsoft Graph to the rehearsal mailbox, send test mail, reply, and check the delivery status, the links, and notifications on your devices. The real transport rules are tested only after setup day's Finish import. Two rules:
   - Write only from and to your own addresses, with nobody else in To or Cc.
   - Never press Finish import. Until it is pressed, imported tickets are read-only for agents, so nobody can answer a real customer.

   Upgrade with section 7 when a release fixes what you find.
5. **End it.** Turn notifications off on your test devices (Account, Notifications), then run this block. It disables the rehearsal's Compose file first, so nothing can start the rehearsal again, then stops it and renames its folder; nothing in the folder is deleted. It refuses in a folder that is not marked, and can run again after it stopped halfway:

   ```bash
   (
     set -euo pipefail
     cd "$HOME/maane"
     [ -f REHEARSAL ] || { echo "error: $HOME/maane is not a rehearsal; nothing was changed" >&2; exit 1; }
     [ ! -e docker-compose.yml ] || mv -- docker-compose.yml docker-compose.yml.rehearsal
     docker compose -f docker-compose.yml.rehearsal down
     mv -T -- "$HOME/maane" "$HOME/maane-rehearsal"
     echo "The rehearsal is stopped, in $HOME/maane-rehearsal"
   )
   ```

   Remove the transport rule and take the rehearsal mailbox out of the application's scope. Do not answer the rehearsal's mail: its links no longer work, and its ticket numbers will belong to other tickets. Then do sections 2 to 4 again for the version the rehearsal ended on, without step 1, and go on with setup day. At SMTP2GO, change the rehearsal's webhook to the new address and token instead of adding a second one.
6. **Remove it** after setup day, when you no longer need it. The folder holds customer data. This block deletes it for good, and refuses when a Zendesk archive is inside. A link such as `./zendesk-archive` is removed as a link; the folder it points to stays:

   ```bash
   (
     set -euo pipefail
     dir="$HOME/maane-rehearsal"
     [ -f "$dir/REHEARSAL" ] && [ ! -L "$dir" ] || { echo "error: $dir is not a rehearsal; nothing was deleted" >&2; exit 1; }
     archive="$(sudo find "$dir" -name archive.json -print -quit)"
     [ -z "$archive" ] || { echo "error: a Zendesk archive is inside ($archive); move it out first. Nothing was deleted" >&2; exit 1; }
     sudo rm -rf --one-file-system -- "$dir"
     echo "Removed $dir"
   )
   ```

### Setup day: from Zendesk to Maane

Maane is live from the first moment (owner's decision, 2026-11-17): there is no listening period, no cutover, and no rollback. Do these steps in this order on one day:

1. **Set Maane up.** Sections 1 to 4: the server, the domains, the organizations with their support addresses and a default address, SMTP2GO (Settings, Sending, and [its delivery status](#connect-smtp2gos-delivery-status)), and the Zendesk archive mounted as above. Run the import. Only when it is done, connect Microsoft Graph: a message that already waits in the intake mailbox opens a ticket at once, and before the import it would take a number of a Zendesk ticket, which is then not imported.
2. **Point the Microsoft 365 rules at the intake mailbox** instead of Zendesk. From here Maane receives and answers all new mail.
3. **At least five minutes later, back up and import again.** Run the Zendesk backup again ([zendesk-backup.md](zendesk-backup.md); it continues where it stopped), then start the import again, so mail Zendesk received before the rules changed is in Maane too. Zendesk's API leaves out the most recent minute, so the wait is required.
4. **Press Finish import** on the Import page once the last run is done. Imported tickets become ordinary tickets, and nothing more can be imported.

Between steps 2 and 4 the import and live mail can meet on the same ticket:

- A customer who answers an imported ticket by its number (`[#1234]` in the subject) joins it, and the ticket becomes open as for any customer reply. A run after that still updates the ticket's imported comments, notes, and files, but keeps the ticket's own status, last activity, participants, organization, categories, and subject as live mail left them; the report lists the ticket as "Mail arrived in Maane for this ticket".
- The same mail can arrive both ways while the rules change: once through the intake mailbox and once as a Zendesk comment. Maane keeps both visible and flags the ticket **Possible duplicate** for you to look at.
- A ticket Zendesk opened after the backup of step 1 can carry a number that Maane has since given a new ticket. The run then skips it, and the report lists it as "A Maane ticket has this number: not imported". After Finish import it cannot be imported, so check the report before step 4. To keep such tickets rare, run the backup and the import of step 1 right before step 2.
- A reply to old Zendesk mail without Maane's `[#n]` opens a new ticket for now. Joining such replies to their imported tickets waits until you forward one or two old Zendesk emails with their full headers.

## 5. Back up

Your backup must hold:

| What | Where | Why |
|---|---|---|
| The database | `./postgres-data`, copied while the stack is stopped, or a dump (below) | All of Maane's data: users, settings, the audit log, the job queue, and each device's notification subscription |
| `app.env` and `postgres.env` | `~/maane/app.env`, `~/maane/postgres.env` | `MAANE_AUTH_SECRETS` decrypts every user's two-factor secret and backup codes: without it nobody can sign in after a restore. `MAANE_SETTINGS_KEYS` decrypts the secrets stored in Settings. The database password opens the database. Keep every key version you ever used. |
| `.env` | `~/maane/.env` | `VERSION`, `DOMAIN`, and `LINK_DOMAIN`; no secret |
| `docker-compose.yml` | `~/maane/docker-compose.yml` | Your copy, with any label you changed |
| Attachments | `./data` | Attachments and inline images are stored as files, named by their SHA-256, not in the database. Copy it after the dump: a dump taken after the copy of `./data` can name a file the copy lacks. |
| The VAPID key pair | `app.env` (`MAANE_VAPID_PUBLIC_KEY`, `MAANE_VAPID_PRIVATE_KEY`) | Every device subscribed with it. A restore without it starts only with a new pair, and then every user must turn notifications on again on each device. |
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

Test a restore before setup day, and again from time to time. Run it on another Docker host or virtual machine with its own Traefik, never beside production: `docker-compose.yml` names its project `maane` and its Traefik router `maane`, so a second copy on the production host would take them over.

1. On the test host, create the folder `~/maane-restore` with the block of section 2, with `dir="$HOME/maane-restore"` and `version` set to the release the backup came from. Copy the backup's `.env`, `postgres.env`, and `app.env` into it (mode 600). Edit three lines of the copies: `DOMAIN` and `LINK_DOMAIN` in `.env` to the test host name, for example `maane-restore.example.com`, so Traefik on the test host claims no production name, and `MAANE_TRUSTED_PROXIES` in `app.env` to the subnets of the test host's `traefik` network. Leave every key and the password as they are: the test checks that they open the data.
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

This upgrade stops Maane for the length of a dump and a restart. A release that may run beside the one you run can be deployed without downtime instead ([section 8](#8-roll-out-a-release-without-downtime)).

1. Read the release notes of the new version on the repository's Releases page. They say when `docker-compose.yml` or `.env.example` changed, and any step the host needs by hand, such as a new variable in `app.env` or a changed file under `docker/clamav/`; compare your copy with the new tag's file and do those steps before you continue. The first release with browser notifications needs the VAPID key pair in `app.env` before it starts: run [its block](#browser-notification-keys-once) with the new `version` first.
2. Set `version`, then run the block. It pulls the new image, stops `server` and `worker`, so nothing writes to the database after the dump, then takes a dump into `~/maane/backups` (migrations only move forward: the dump is the way back), and only then sets `VERSION` in `.env` and starts the new release. When the pull fails, it stops with nothing changed. When the dump fails, it starts the stopped `server` and `worker` again on the running version, with `.env` unchanged.

   ```bash
   (
     set -euo pipefail
     umask 077
     unset VERSION
     version=0.2.0
     cd "$HOME/maane"
     [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must look like 1.2.3" >&2; exit 1; }
     [ "$(grep -c '^VERSION=' .env)" = 1 ] || { echo "error: .env must have one VERSION line" >&2; exit 1; }
     docker pull "ghcr.io/shlomiporush/maane:$version"
     mkdir -p backups
     file="backups/maane-before-$version-$(date -u +%Y%m%dT%H%M%SZ).dump"
     partial="$(mktemp backups/.partial-XXXXXX)"
     trap 'rm -f -- "$partial"; docker compose start server worker' EXIT
     docker compose stop server worker
     docker compose exec -T postgres pg_dump -U maane -d maane -Fc >"$partial"
     # Only this run's own dump, published under a name nothing else holds, lets the upgrade go on.
     ln -- "$partial" "$file"
     echo "Wrote $HOME/maane/$file"
     sed -i "s/^VERSION=.*/VERSION=$version/" .env
     trap 'rm -f -- "$partial"' EXIT
     docker compose up -d --wait
     docker compose ps
   )
   ```

   The server applies the new migrations on start; the worker starts after it is healthy. `sed -i` keeps the mode of `.env`.

3. Check `https://maane.example.com/healthz/ready` and sign in.

To go back to an earlier version, restore the dump the block took (section 6, into an empty `postgres-data`), set the earlier `VERSION`, and start it. Starting an older version on a database that newer migrations changed is not supported. A restore loses everything after the dump, and it brings back as waiting the replies the new release sent after it: the worker sends them again when it starts.

## 8. Roll out a release without downtime

Maane can also be updated with a zero-downtime rollout through [docker rollout](https://github.com/wowu/docker-rollout): each service gets a new container beside the old one, and the old one stops once the new one is healthy. `server` rolls out first, then `worker`, both from the same image. `postgres` and `clamav` are not part of it: they do not use `VERSION`, and you update them yourself. Release notes still apply: read them first, as in section 7.

The first release is a fresh install (sections 2 to 4). Every later release whose `maane.rollout-from` is not newer than the release you run rolls out; any other release is deployed with section 7.

### What the image says

Each release's image carries two labels that tell whether it may roll out over the release you run:

| Label | Value |
|---|---|
| `maane.compose-sha256` | The sha256 of `docker-compose.yml` at the release's tag. It differs from the running image's when the release changed that file: compare your copy with the tag's file and deploy that release with section 7. |
| `maane.rollout-from` | The oldest running release this image may run beside. |

`docker/rollout.txt` declares every change a release brings that matters for a rollout, one line each, `expand` or `breaking`:

- every migration under `apps/server/drizzle/`. `expand` is only a migration that creates new tables, their indexes and constraints, and new types, with no foreign key to an existing table: it locks nothing the running release uses. Anything that touches an existing table is `breaking`, adding a column included. To ship a change that should roll out, put the new data in a new table beside the existing one;
- each pg-boss schema number (`pg-boss-schema-<N>`), always `breaking`: pg-boss migrates its own schema when the new server starts, and its documentation does not promise that an older release keeps working on the migrated schema. A pg-boss update that keeps the schema number needs nothing;
- any other change a release since `maane.rollout-from` cannot run beside, such as a job an older worker reads wrongly or a step the host needs by hand.

`maane.rollout-from` is the oldest release that already had the release's newest `breaking` line, or the release itself when that line is new. So it stays on the same release until a breaking change raises it, and a release that adds only `expand` changes may skip releases back to it. A unit test fails on a migration without its line, on an `expand` migration whose statements are not of the allowed kinds, and on a pg-boss schema without its line; the release refuses a line that an earlier release had and that is gone, and a released migration that changed.

Read the labels of a pulled image with:

```bash
docker image inspect --format '{{index .Config.Labels "maane.rollout-from"}} {{index .Config.Labels "maane.compose-sha256"}}' ghcr.io/shlomiporush/maane:0.2.0
```

### What your files need

Your `docker-compose.yml` and `.env` stay yours. A rollout needs these in them:

- `name: maane` at the top of `docker-compose.yml`.
- `server` and `worker` with `image: ghcr.io/shlomiporush/maane:${VERSION}`, and exactly one `VERSION=X.Y.Z` line in `.env`. A rollout changes only that line.
- On `server` and `worker`: no `container_name`, no published port, no `network_mode: host`, no `build`, and one replica, because a rollout runs two containers of a service for a moment. Requests reach `server` through Traefik's labels.
- `worker` keeps its own `healthcheck:` (`node dist/worker/healthcheck.js`): the health check in the image is the server's.
- `stop_grace_period: 60s` on `server` and on `worker`, so a request in flight has a minute to finish and a reply being sent has up to 50 seconds. Docker fixes a container's stop timeout when it creates the container: add the lines, then apply them once with `env -u VERSION docker compose up -d --no-deps server worker`. The shipped `docker-compose.yml` does not set them.
- No `pull_policy: always` on `server` or `worker`.

### How the old server leaves

The image carries the label `docker-rollout.pre-stop-hook`, which docker rollout runs in the old container before it stops it: it creates `/tmp/drain` and waits 45 seconds. While that file exists, the server's health check fails, Docker marks the container unhealthy after three failed checks (about 36 seconds at the shipped interval of 10 seconds), and Traefik, which routes only to healthy containers, stops sending it requests before docker rollout stops it, and the server finishes the requests it still has. docker rollout stops the old container even when the hook could not run (for example when `docker exec` fails); then a request in its last moment can fail. A server removes `/tmp/drain` when it starts. The worker gets the same hook from the shared image: its rollout waits 45 seconds longer, and its own health check ignores the file.

### The minutes in between

While the old and the new containers of a service run together:

- Each job goes to one worker, and Maane's jobs lock what they change, so two workers never do the same work twice. Each worker reports healthy from its own reads from the job queue.
- A worker that starts takes the same lock as a save of the Graph settings, so a mailbox saved during a rollout is never undone.
- A page whose script or stylesheet is gone after the switch (its hashed file belongs to the other release) reloads once by itself; so does an open tab whose lazily loaded part, such as the PDF viewer, is gone. A missing file answers 404 that no cache keeps. A page that hits the other release again in the same seconds stays as it is until you reload it.
- A request still running on the old server a minute after its stop signal is cut, such as a very slow upload; send it again.
- A reply still being sent when the old worker has waited 50 seconds is cut and shows as unknown on its ticket: use Send again or Mark as sent, as after any interruption; it is never sent twice. A browser notification still going out to several devices then misses the remaining ones.
- A change of the session length in Settings reaches only the server that saved it, until the other one restarts. Change it outside a rollout, or restart `server` after the rollout.
- The rate limits of the link routes count on each server apart.
- If two servers ever start together with the same migration waiting, one of them fails its start and restarts; a rollout starts one new server, so this does not happen in one.

### A rollout that stopped half way

Check every container of the project:

```bash
cd "$HOME/maane" && grep '^VERSION=' .env && docker ps -a --filter label=com.docker.compose.project=maane --format '{{.ID}} {{.Label "com.docker.compose.service"}} {{.Image}} {{.Status}}'
```

Each of `server` and `worker` should show exactly one container, `Up` and `(healthy)`, on the `VERSION` in `.env`. When one does not, read why in its logs (`docker logs <id>`) and fix that first. The blocks below each take a container's ID and its release from the check; with either left empty, or with an ID that is not that release's Maane container, a block stops at its first check and changes nothing. Then, for that service, in this order:

1. **A container that is not running is left over** (stopped, or created and never started). Remove it before anything else, because docker rollout would otherwise take it for a finished rollout:

   ```bash
   ID=
   RELEASE=
   [ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{.Config.Image}} {{.State.Running}}' "$ID")" = "maane ghcr.io/shlomiporush/maane:$RELEASE false" ] &&
     docker rm "$ID"
   ```

2. **The old server is up but unhealthy, with a drain left behind** (the new one failed). Remove the drain; it turns healthy and serves again:

   ```bash
   ID=
   RELEASE=
   [ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{.Config.Image}}' "$ID")" = "maane ghcr.io/shlomiporush/maane:$RELEASE" ] &&
     docker exec "$ID" rm -f /tmp/drain
   ```

3. **An old and a new container run.** Set `SERVICE` (`server` or `worker`), `OLD` and `OLD_RELEASE` for the old container, `NEW` and `NEW_RELEASE` for the new one. The block checks that they are two different containers of that service, and that the new one is healthy; it then drains the old container as the rollout would, and stops and removes it only when the new one is still healthy after the drain; otherwise it removes the drain and leaves the old one serving:

   ```bash
   SERVICE=
   OLD=
   OLD_RELEASE=
   NEW=
   NEW_RELEASE=
   identity() { docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} {{.Config.Image}}' "$1"; }
   [ -n "$OLD" ] && [ "$OLD" != "$NEW" ] &&
     [ "$(identity "$OLD")" = "maane $SERVICE ghcr.io/shlomiporush/maane:$OLD_RELEASE" ] &&
     [ "$(identity "$NEW")" = "maane $SERVICE ghcr.io/shlomiporush/maane:$NEW_RELEASE" ] &&
     [ "$(docker inspect --format '{{.State.Health.Status}}' "$NEW")" = healthy ] &&
     docker exec "$OLD" touch /tmp/drain && sleep 45 &&
     if [ "$(docker inspect --format '{{.State.Health.Status}}' "$NEW")" = healthy ]; then
       docker stop "$OLD" && docker rm "$OLD"
     else
       docker exec "$OLD" rm -f /tmp/drain
     fi
   ```

4. **Only its old container runs, healthy.** Roll the service out again with docker rollout, as the deployment does; it drains the old server the same way.

## What was verified

Zero-downtime rollout (2026-11-27): a live run of section 8 in a throwaway Compose project with Traefik v3.6.2 (both routers), PostgreSQL 18.6, Mailpit as the SMTP server with STARTTLS, and two images built from this branch: A, and B with an `expand` migration (a new table) and a changed UI string. docker rollout v0.14 ran as a deployment does, `server` then `worker`, with the drain hook taken from the image's label, while a load driver went through Traefik. 15,371 requests (the health route, the setup status, the UI shell, the signed-in ticket list, and a tracked link on the link domain) had no failure, no timeout and no connection error, and both releases answered. The old server turned unhealthy 29 s after the hook ran, Traefik sent it its last request 1 s later, and it got its stop signal 16 s after that; it received no request after the signal. A 1 MB upload streamed over 20 s on the old server succeeded. 143 replies, 127 sent at once and 16 scheduled (6 of them due in the 60 s when both workers ran), were each accepted once and reached the SMTP server exactly once. All 199 job queue jobs of the run completed, none failed or stayed open, and every scheduled slot had exactly one job. B's migration ran while A still served. A page holding A's HTML got 404 for A's script from B, reloaded once by itself, and showed B's sign-in. Every container, image, network, volume and secret of the run was removed afterwards. Not run: TLS at Traefik, the host's `default@file` middleware, and the `/f/` download route.

Compose values (2026-11-24): `scripts/verify.sh` checked `docker-compose.yml` with `.env` made from `.env.example`, valid and with no variable missing. The `.env` block of section 3 and the two link blocks of [Link tracking](#link-tracking) and [Import from Zendesk](#import-from-zendesk) ran against a stand-in `docker`: `.env` got `LINK_DOMAIN` equal to `DOMAIN`, and each link block replaced a missing or empty folder and its own earlier link, and stopped on a folder with files, a link elsewhere, or a target that does not hold the expected files. In Docker, a bind mount of a link to a folder showed the folder's files. Not run against a real deployment.

Rehearsal (2026-11-24): its three blocks ran as written, as an unprivileged user with `sudo`, in a throwaway Docker-in-Docker container with the real `docker-compose.yml`, an image built from this repository, real PostgreSQL, and secrets made in it by the blocks of section 3 (`server` and `postgres` only; no `worker`, `clamav`, or Traefik). The mark refuses without the files and once the deployment started. The end disables the Compose file, stops the stack, and renames the folder; it changes nothing in a folder that is not marked, and when Docker does not answer or the target name is taken it leaves a rehearsal that section 4 cannot start, and finishes when run again. A deployment made again from sections 2 to 4 had new secrets, no organization, and an unused ticket number sequence. The removal refuses a folder that is not marked, a symbolic link, and a folder with a Zendesk archive, and leaves the running deployment as it was. The rehearsal itself, with a real mailbox and real providers, has not run.

Phase 6 (2026-11-17): live from the first moment, Finish import, and the overlap between the import and live mail ran only against stand-ins and invented archives, in the integration tests and the stack stage of `scripts/verify.sh`; the migrations that remove listening mode ran on a database filled with invented listening and live data. Nothing reached Microsoft, SMTP2GO, or Zendesk, and the steps of [setup day](#setup-day-from-zendesk-to-maane) have not run.

Phase 5.1 (2026-11-16): the import ran only against invented archives that the phase 0 backup wrote from its stand-in Zendesk API: in the integration tests, and in a scratch stack from the development template with such an archive mounted read only at `/zendesk-archive` in `server` and `worker`, scanned by the real ClamAV, for the screenshots. `docker compose config` accepted `docker-compose.yml` with the new mount in the full `scripts/verify.sh` sweep. Nothing ran against your archive or a real Zendesk account, and section 3's block was not run again (it copies the new empty line of `.env.example` as it is). The field paths the import reads were taken from Zendesk's API reference; a comment's Message-ID in `metadata.system.message_id` is not in that reference and stays unchecked until your archive.

Phase 3.4 (2026-11-13): `docker compose config` accepted `docker-compose.yml` with and without `LINK_DOMAIN` and `GEOIP_DIR` (the `maane-links` rule and the `/geoip` mount resolved as described); the `maane-links` router and the mount were never run behind a real Traefik. In a stack from the development template, with the GeoLite2 test databases mounted read only at `/geoip` and the stack's Docker networks trusted as proxies, clicks and a download through the published port were redirected, served as an attachment, and recorded with the forwarded documentation addresses and their locations; with the networks not yet trusted, the forwarded header was ignored and the proxy's address recorded. Section 3's block was not run again; it copies the new empty lines of `.env.example` as they are.

Phase 3.3 (2026-11-13): delivery status ran only against stand-ins, in the integration tests: the webhook through the server app with secrets generated for the test, the activity search against a stand-in HTTPS API that accepts only a key generated for the run, and failover bounces through the stand-in Graph. Nothing reached SMTP2GO. The steps of [Connect SMTP2GO's delivery status](#connect-smtp2gos-delivery-status) have not run: SMTP2GO's menus, the exact Authorization value it sends for the Bearer type, the format of its `time` field, and that its webhook's `email_id` is the queue ID in its final SMTP reply are unchecked until your first real send.

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
  - No Maane release exists yet, and nothing has been deployed. The Release workflow has run on GitHub only with `dry_run`.
  - Pulling `ghcr.io/shlomiporush/maane` on a server without `docker login` after the package is made public.
  - Since sections 5 to 7 were run, the dump and upgrade blocks write to a temporary file of their own and publish it with `ln`. That version ran only with a stand-in `docker`: two dumps in the same second leave one dump and stop the other run, and a failing `pg_dump` leaves no file.
