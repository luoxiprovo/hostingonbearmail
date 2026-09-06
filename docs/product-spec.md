# Hosting — Product spec

**Version:** 0.1.0
**Status:** shipped on this Linux server
**Date:** 2026-09-04

## 1. Summary

Hosting is a personal PaaS for **this Linux server**. You give it a GitHub repo (usually a static landing page or a Node web UI). Hosting clones it into a local folder, keeps a project-level `.env`, runs it on its own port, and can map a domain in front with Caddy (automatic HTTPS).

It is a control plane for one operator, not a multi-tenant product.

## 2. Goals

- Deploy many small sites and Node apps on one machine without writing systemd units or Caddy config by hand.
- Keep each project isolated by folder and port.
- Let the operator work from a localhost dashboard **and** a CLI.
- Make clone and deploy two explicit steps: submit clones; Deploy pulls, builds, and starts.

## 3. Non-goals (v1)

- Multi-user accounts, roles, or billing
- Authentication on the dashboard (it is localhost-only)
- Docker / arbitrary language runtimes
- Auto-deploy on every git push / GitHub webhooks
- Preview environments, PR apps, or rollbacks
- Databases, object storage, or secrets managers
- Changing DNS for the operator

## 4. Users

One operator who controls this server (SSH, sudo, DNS). They open the dashboard over an SSH tunnel or run `hosting` on the machine.

## 5. Decisions that define v1

| Topic | Choice |
| --- | --- |
| Where it runs | This Linux server |
| What a repo can be | Static site (install, optional build, serve `dist`/`out`/`build` or root `index.html`) or Node long-lived process |
| How you operate it | Dashboard + CLI |
| How repos arrive | Paste a clone URL; optional GitHub PAT for private repos |
| When a project updates | After Submit (clone) and a separate Deploy button / `hosting deploy` |
| Domains and HTTPS | Hosting owns Caddy; operator points DNS at the server |
| Who can open the dashboard | Localhost only, no auth |

## 6. Product surface

### 6.1 Dashboard

- Binds **`127.0.0.1:8787`** by default. Not exposed on the public interface.
- Create a project, watch clone/deploy status, edit settings, edit `.env`, read logs, start/stop/delete.
- Settings: optional Let’s Encrypt ACME email.

Open from a laptop:

```bash
ssh -L 8787:127.0.0.1:8787 USER@THIS_SERVER
```

Then http://127.0.0.1:8787

### 6.2 CLI

Same operations as the dashboard, talking to the local API:

`serve`, `list`, `add`, `deploy`, `start`, `stop`, `delete`, `logs`, `env`, `status`, `doctor`

### 6.3 Public traffic

Project processes listen on `127.0.0.1:<port>`. If a domain is set, Caddy reverse-proxies that hostname to the port and terminates TLS.

## 7. Project model

### Identity

- **Name:** lowercase letters, numbers, hyphens; 1–63 chars; must start with a letter or number. Unique. Can be renamed later (moves `projects/<name>/`; refused while cloning or deploying).
- **Git URL:** `https://`, `http://`, `git@`, `ssh://`, `file://`, or an absolute local path.
- **Type:** `static` or `node`.
- **Port:** integer 1024–65535, unique. Auto-assigned from 4100 if omitted.
- **Domain:** optional FQDN, unique across projects.

### Optional fields

Branch, GitHub token, build command, start command, static output directory.

### Status

`idle` · `cloning` · `building` · `running` · `stopped` · `error`

Clone and deploy cannot overlap on the same project. Delete is refused while cloning or building.

### Layout on disk

```text
$HOSTING_DATA_DIR/             # default: /home/luoxi23vr/hosting-data
  hosting.json                 # settings + project records (token stored here)
  caddy/Caddyfile              # generated, then copied to /etc/caddy/Caddyfile
  projects/<name>/
    repo/                      # git clone
    .env                       # operator-owned; copied into repo on clone/deploy
    logs/deploy.log
    logs/runtime.log
```

Data lives **outside** the Hosting app tree so a project’s TypeScript does not pick up Hosting’s `node_modules/@types`. Override with `HOSTING_DATA_DIR`.

## 8. Behaviors

### 8.1 Create / Submit

1. Validate name, URL, type, domain, port.
2. Allocate port, create folders, write empty `.env`.
3. Return immediately; clone runs in the background.
4. On success status is `stopped`. Deploy is a separate action.

Private HTTPS GitHub repos use `GIT_TERMINAL_PROMPT=0` plus an `Authorization: Basic` extra header from the PAT (`x-access-token:<token>`). The API never returns the token; it only returns `gitTokenSet`.

### 8.2 Deploy

1. Pull (`git fetch` + hard reset to `origin/<branch>`), or clone if the folder is missing.
2. Copy `$HOSTING_DATA_DIR/projects/<name>/.env` into `repo/.env`.
3. Stop the current process.
4. Install dependencies if `package.json` has any (`npm` / `pnpm` / `yarn` / `bun` from lockfiles).
5. **static:** run build if configured or `scripts.build` exists; serve `outputDir` or `dist` / `out` / `build`; else serve repo-root `index.html`.
6. **node:** optional build; start `startCommand`, or a `node …` start script as-is, or `npm run start` / `package.json#main`.
7. Inject `PORT`, `HOST=127.0.0.1`, `HOSTNAME=127.0.0.1`, parsed `.env`, and `CI=true` (install/build) / `NODE_ENV=production` (runtime).
8. Wait until `127.0.0.1:<port>` accepts connections before marking `running`.

Install/build timeout: 60 minutes. Port-ready wait: 60 seconds. If a command finishes successfully after the timer, Hosting still treats it as success.

### 8.3 Start / stop / resume

- Start requires a previous successful deploy (`runtimeCommand` + `runtimeRoot`).
- Stop sends SIGTERM to the process group, then SIGKILL if needed.
- On control-plane shutdown, running projects are stopped but kept as `running` so they are started again on boot.
- Unexpected process exit → `error` (or `stopped` if exit code 0).

### 8.4 Domains

On create, patch, delete, or ACME email change, Hosting writes a Caddyfile, `caddy validate`s it, copies it to `/etc/caddy/Caddyfile`, and reloads Caddy.

Each domain block:

```caddyfile
example.com {
    encode gzip
    reverse_proxy 127.0.0.1:<port>
}
```

Hosting **replaces** the system Caddyfile. This machine’s public HTTP/HTTPS is whatever Hosting generated.

The operator must point DNS A/AAAA at this server before certificates can be issued. ACME email is optional (Settings).

### 8.5 `.env`

Stored only under `$HOSTING_DATA_DIR/projects/<name>/.env`. Copied into the clone on clone and on every deploy. Editing `.env` does not restart the process; Deploy or Start is required to pick up changes.

## 9. API (localhost)

Base: `http://127.0.0.1:8787/api`

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | Caddy status, bind, project count |
| GET/PATCH | `/settings` | PATCH accepts `acmeEmail` |
| GET/POST | `/projects` | POST creates and starts clone |
| GET/PATCH/DELETE | `/projects/:name` | PATCH `name` renames the project and folder |
| POST | `/projects/:name/deploy` | 202, work in background |
| POST | `/projects/:name/start` | |
| POST | `/projects/:name/stop` | |
| GET | `/projects/:name/logs?kind=deploy\|runtime` | tail, ~200 KB |
| GET/PUT | `/projects/:name/env` | PUT body `{ "content": "…" }` |

JSON errors: `{ "error": "…" }` with 4xx/5xx.

## 10. Operations

- Process: `systemd` unit `hosting.service` (`User=luoxi23vr`, `ExecStart=/usr/bin/node …/dist/server.js`).
- Dashboard bind: `HOSTING_HOST` / `HOSTING_PORT` or settings (`127.0.0.1:8787`).
- CLI default API: `HOSTING_URL` or `http://127.0.0.1:8787`.
- Requires: `git`, `node`, `npm`, `caddy`, passwordless `sudo` for Caddy reload.

## 11. Security posture (v1)

- Dashboard and API are loopback-only. Do not bind `0.0.0.0` without adding auth.
- Git tokens live in `data/hosting.json` in plaintext. File permissions follow the service user.
- Project processes are not containerized; they run as the Hosting user.
- Generated Caddy config only reverse-proxies to `127.0.0.1:<project-port>`.
- Git URLs reject newlines; names/domains are constrained.

## 12. Success criteria

v1 is successful if the operator can:

1. Add a public or PAT-gated GitHub repo from the dashboard or CLI.
2. Set `.env` and Deploy.
3. Reach a static site or Node app on `127.0.0.1:<port>`.
4. Map a DNS name to that port through Caddy with HTTPS.
5. Read deploy/runtime logs and stop/start/delete without logging into each app’s folder.

## 13. Future (not committed)

- Deploy-on-push webhooks
- Dashboard auth if it is ever bound publicly
- Docker / Python / other runtimes
- Releases and instant rollback
- Health checks beyond “port is open”
