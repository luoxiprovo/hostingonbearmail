# Hosting — Use guide

How to run sites on this server with Hosting.

The dashboard is **localhost only** (`127.0.0.1:8787`). Public visitors hit **Caddy → your project’s port**, not the dashboard.

## 1. Open the dashboard

From your laptop:

```bash
ssh -L 8787:127.0.0.1:8787 USER@THIS_SERVER
```

Open http://127.0.0.1:8787

On the server itself:

```bash
hosting status          # is the API up?
hosting doctor          # git, node, caddy, dashboard
```

The control plane is `hosting.service`:

```bash
sudo systemctl status hosting
sudo systemctl restart hosting
```

## 2. Add a project

### Dashboard

1. **New project**
2. **Name** — `landing`, `docs`, `app` (lowercase, numbers, hyphens)
3. **Type**
   - **Static** — landing pages, Vite/Next static export, plain `index.html`
   - **Node** — a long-lived `node` process that listens on `PORT`
4. **Git clone URL** — `https://github.com/org/repo.git`
5. Optional: GitHub token (private repos), branch, domain, port, build/start/output
6. **Submit & clone** — this only clones. It does not go live yet.

Wait until status is **stopped** (clone done) or **error** (see Deploy log).

### CLI

```bash
hosting add landing --repo https://github.com/org/site.git --type static
hosting add api --repo https://github.com/org/app.git --type node --domain api.example.com --token ghp_...
```

Flags: `--type` `static|node`, `--domain`, `--branch`, `--token`, `--port`, `--build`, `--start`, `--out`

## 3. Set `.env` (optional)

Secrets and public URLs belong in the **project** `.env`, not in git.

- Dashboard: project page → `.env` → **Save .env**
- CLI:

```bash
hosting env landing                 # print
hosting env landing --set < .env    # replace from stdin
```

File on disk: `/home/luoxi23vr/hosting-data/projects/<name>/.env`

Hosting copies it into `repo/.env` on clone and on every deploy. **Save does not restart the app.** Deploy or Start after you change it.

## 4. Deploy

Dashboard: **Deploy**. CLI: `hosting deploy landing`

Deploy will:

1. `git fetch` and reset to the tracked branch (clone first if needed)
2. Copy `.env` into the repo
3. Stop whatever was running
4. Install packages if `package.json` has dependencies
5. Build and start

Then status should become **running**. Open `http://127.0.0.1:<port>/` from the server (or an SSH tunnel to that port).

If the project has a domain, the dashboard shows the **DNS records** to add (A/AAAA for the domain and `www`). The CLI prints the same table after `hosting deploy` and `hosting add`.

```bash
hosting logs landing                 # deploy log
hosting logs landing --kind runtime  # process output
```

If it fails, status is **error** and `lastError` is on the project page.

## 5. What “static” vs “node” does

### Static

Use this for sites that become HTML/CSS/JS files.

- If there is a build (`npm run build` or your Build command), Hosting serves `dist`, `out`, or `build` (or the Output dir you set).
- If there is no build but the repo has `index.html`, it serves the repo root.
- Hosting’s own static server binds `127.0.0.1:<port>`.

Typical: marketing page, Vite SPA, `next export` / `out`.

### Node

Use this when the repo is a server.

- Optional build, then a long-lived process.
- Hosting sets `PORT` and `HOST=127.0.0.1`. The app **must listen on `process.env.PORT`**.
- Start command defaults: a `node …` start script as written, otherwise `npm run start`, otherwise `node <main>`.

Typical: Express/Fastify, Next in server mode, a small API.

## 6. Domains and HTTPS

1. Set **Domain** on the project (dashboard Save settings, or `hosting add … --domain app.example.com`).
2. After Deploy, copy the **DNS records** from the project page (or the CLI output) into your DNS provider. Typical rows:
   - `A` `app.example.com` → this server’s public IPv4
   - `A` `www.app.example.com` → same IPv4
   - `AAAA` as well if the server has a public IPv6
3. Hosting adds that site to the Caddy Bearmail already installed, then reloads Caddy. Bearmail’s hostnames stay in place.
4. Optional: dashboard **Settings** → ACME email for Let’s Encrypt. One Caddy instance has one ACME email.

Until DNS points here, certificate issuance will fail. You can still use `http://127.0.0.1:<port>/` locally.

If the detected IP is wrong (NAT, extra NIC), set `HOSTING_PUBLIC_IPV4` and/or `HOSTING_PUBLIC_IPV6` on the Hosting process.

Caddy proxies:

`https://app.example.com` → `127.0.0.1:<project-port>`

Hosting does not replace `/etc/caddy/Caddyfile`. It writes `/etc/caddy/hosting.caddy` and keeps this import in the system file:

```caddyfile
# BEGIN hosting
import /etc/caddy/hosting.caddy
# END hosting
```

Change a Hosting domain in the dashboard or CLI. Leave the Bearmail site blocks alone. A domain Bearmail already serves is rejected (`ambiguous site definition`).

## 7. Day-to-day

| I want to… | Dashboard | CLI |
| --- | --- | --- |
| See everything | Home + sidebar | `hosting list` |
| Update code | Deploy | `hosting deploy NAME` |
| Restart without rebuild | Start / Stop | `hosting start NAME` / `hosting stop NAME` |
| Rename | Settings → Name → Save settings | `hosting rename OLD NEW` |
| Change domain or port | Settings → Save settings | (patch via dashboard) |
| Change env | Save .env, then Deploy or Start | `hosting env NAME --set < file` then deploy |
| Remove it | Delete (removes the local folder) | `hosting delete NAME` |

You cannot delete or deploy while status is **cloning** or **building**.

After a reboot, `hosting.service` comes back and restarts projects that were **running**.

## 8. Names, ports, folders

- Names: `^[a-z0-9][a-z0-9-]{0,62}$`
- Ports: 1024–65535, unique. Default range starts at **4100**. Dashboard port **8787** is reserved.
- Folder: `/home/luoxi23vr/hosting-data/projects/<name>/` (`HOSTING_DATA_DIR`)

```text
hosting-data/projects/landing/
  repo/          # the git checkout; do not treat this as the source of truth for .env
  .env
  logs/deploy.log
  logs/runtime.log
```

`pnpm` and `yarn` must be installed on the server for repos that ship those lockfiles. This machine has `pnpm@9` at `/usr/local/bin/pnpm`.

## 9. Private GitHub repos

Create a PAT with `repo` (or Contents read) access. Paste it in **GitHub token** on create or on the project page. Hosting stores it in `data/hosting.json` and does not show it again (`Token: set`).

## 10. Troubleshooting

**Dashboard won’t load remotely**
It is bound to 127.0.0.1. Use the SSH tunnel in §1. Check `hosting doctor` and `sudo systemctl status hosting`.

**Clone error**
Wrong URL, private repo without token, or missing `git`. See the Deploy log.

**Deploy error: no dist/out/build**
Static type expected a built folder. Set **Output dir**, or fix the build, or switch to Node if it is a server.

**Deploy error: port never opened**
The process started but did not listen on `PORT`. For Node apps, bind `process.env.PORT` (and preferably `127.0.0.1`). Check the Runtime log.

**Site works on the port, not on the domain**
DNS is not pointing here yet, or Caddy failed to reload. `hosting status` shows whether Caddy is active. Confirm the domain field and wait for TLS.

**Save failed: ambiguous site definition**
That hostname is already in the system Caddyfile (for example a Bearmail name). Use a different domain.

**`.env` changes have no effect**
Save, then **Deploy** or **Start**.

**Need a clean rebuild**
Deploy already `git reset --hard origin/<branch>` then install/build. Local edits inside `repo/` are thrown away.

**CLI says it cannot reach the API**

```bash
sudo systemctl start hosting
hosting doctor
```

## 11. Commands (CLI)

```text
hosting serve                         # start the dashboard (if not using systemd)
hosting list
hosting add <name> --repo <url>
    --type static|node
    --domain example.com
    --branch main
    --token <github_pat>
    --port 4101
    --build "npm run build"
    --start "npm start"
    --out dist
hosting deploy <name>
hosting start <name>
hosting stop <name>
hosting delete <name>
hosting rename <old> <new>
hosting logs <name> [--kind deploy|runtime]
hosting env <name>
hosting env <name> --set              # stdin
hosting status
hosting doctor
```

Environment: `HOSTING_URL` (CLI → API), `HOSTING_HOST` / `HOSTING_PORT` (server bind), `HOSTING_DATA_DIR`.

## 12. Build / install (this machine)

Already installed. For a rebuild after code changes:

```bash
cd /home/luoxi23vr/hosting
npm install
npm run build
sudo systemctl restart hosting
```

Unit file: `deploy/hosting.service`.
