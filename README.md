# Hosting

Deploy GitHub repos onto this Linux server. Each project gets a local folder, an optional `.env`, its own port, and an optional domain through Caddy (auto HTTPS).

- Product spec: [docs/product-spec.md](docs/product-spec.md)
- Use guide: [docs/use-guide.md](docs/use-guide.md)

The dashboard listens on **localhost only** (`127.0.0.1:8787`). Public traffic goes through Caddy to each project’s port.

## Use

SSH tunnel to open the dashboard from your laptop:

```bash
ssh -L 8787:127.0.0.1:8787 USER@THIS_SERVER
```

Then open http://127.0.0.1:8787

Or use the CLI on the server:

```bash
hosting add landing --repo https://github.com/org/site.git --type static --domain example.com
hosting env landing --set < .env
hosting deploy landing
hosting logs landing
hosting list
```

Supported project types:

- **static** — `npm install`, optional `npm run build`, serve `dist` / `out` / `build` (or `index.html` at the repo root)
- **node** — `npm install`, optional build, then a long-lived process with `PORT` set

Submit clones the repo. **Deploy** is a separate step (pull, build, start).

## Layout

```text
/home/luoxi23vr/hosting-data/
  projects/<name>/
    repo/     # git clone
    .env      # edited in the dashboard; copied into repo on deploy
    logs/     # deploy.log, runtime.log
  hosting.json
  caddy/hosting.caddy   # imported by /etc/caddy/Caddyfile; Bearmail sites stay put
```

Private repos: paste a GitHub personal access token on the project.

DNS: after deploy, the dashboard and CLI show the A/AAAA records to add. Hosting reloads Caddy. Optional Let’s Encrypt email is in Settings.

## Run

```bash
npm install
npm run build
npm start                 # or: hosting serve
```

systemd unit: `deploy/hosting.service`

```bash
sudo cp deploy/hosting.service /etc/systemd/system/hosting.service
sudo systemctl daemon-reload
sudo systemctl enable --now hosting
```
