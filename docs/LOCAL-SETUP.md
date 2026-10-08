# Local setup

For a developer receiving this folder for the first time.

---

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 20 or 22 (22 recommended) | `node -v` |
| pnpm | 9+ | `pnpm -v` |
| Git | any | `git --version` |

Install pnpm if you do not have it:

```bash
npm install -g pnpm
```

### Native build toolchain

`better-sqlite3` ships prebuilt binaries for common platforms. If none matches
your Node version it compiles from source and needs:

- **macOS** — `xcode-select --install`
- **Ubuntu / Debian** — `sudo apt install -y build-essential python3`
- **Windows** — Node 20/22 installers offer "Tools for Native Modules"; tick it.
  Otherwise: `npm install -g windows-build-tools`, or install Visual Studio Build
  Tools with the "Desktop development with C++" workload plus Python 3.

If the compile fails with a `node-gyp` header download error behind a corporate
proxy, point it at your local Node headers:

```bash
npm_config_nodedir="$(dirname "$(dirname "$(which node)")")" pnpm install
```

## 2. Install and run

```bash
git clone <repository-url> TekRevol-Finsys
cd TekRevol-Finsys
pnpm install
pnpm run dev:all
```

- Frontend: http://localhost:5000
- API: http://localhost:3001 (proxied at `/api` from the frontend)

Stop with `Ctrl+C`. To run the two halves in separate terminals instead:

```bash
pnpm run dev:api    # terminal 1 — Express on :3001
pnpm run dev        # terminal 2 — Vite on :5000
```

### Windows note

`dev:all` and the other scripts are plain Node commands and work in PowerShell,
CMD and Git Bash. If a port is already taken:

```powershell
$env:PORT=5100; $env:SERVER_PORT=3101; pnpm run dev:all
```

(and set `API_PROXY_TARGET=http://localhost:3101` so the proxy follows.)

## 3. Environment variables

Copy the template and fill in only what you need:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | Vite dev/preview port; in production, the port Express serves on |
| `SERVER_PORT` | `3001` | Express port in development |
| `API_PROXY_TARGET` | `http://localhost:3001` | Where the dev server proxies `/api` |
| `BASE_PATH` | `/` | Base path for the built frontend (set if hosting under a sub-path) |
| `NODE_ENV` | — | Set to `production` to make Express serve `dist/public` |
| `PLAID_CLIENT_ID` | — | Optional. Plaid bank sync |
| `PLAID_SECRET` | — | Optional. Plaid bank sync |
| `SESSION_SECRET` | — | Reserved for the authentication work in the roadmap |

Without Plaid credentials the Bank Transactions screen still works: you can add
manual bank profiles and upload statements. Nothing else degrades.

`.env` is gitignored. Never commit real credentials.

## 4. Production build

```bash
pnpm run build
NODE_ENV=production PORT=5000 pnpm run start
```

Express then serves the API and the built SPA from `dist/public` on one port,
which is what you want behind nginx, a Docker container or any PaaS.

## 5. The database

SQLite, one file: `server/finance.db`. Created automatically at first boot if
missing; the schema is applied idempotently on every start.

```bash
# inspect
sqlite3 server/finance.db ".tables"
sqlite3 server/finance.db "select count(*) from revenue;"

# back up (safe while running — WAL mode)
sqlite3 server/finance.db ".backup backup-$(date +%F).db"
```

The file is currently committed to the repository. Until that changes (see
`docs/ROADMAP.md`), be aware that pulling can overwrite local data and that two
developers editing data will conflict.

## 6. Handing the folder to another developer

The repository is self-contained. Either:

**Push to GitHub or Bitbucket**

```bash
git remote set-url origin <new-repo-url>   # or: git remote add origin <url>
git push -u origin main
```

**Or ship the folder directly** — zip the project *excluding* build artefacts:

```bash
zip -r TekRevol-Finsys.zip . -x "node_modules/*" "dist/*" ".git/*"
```

The recipient runs `pnpm install && pnpm run dev:all`. Nothing else is required.

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot find package 'tsx'` | Run `pnpm install` from the repo root, not from `server/` |
| `EADDRINUSE` on 5000 or 3001 | Another process has the port; set `PORT` / `SERVER_PORT` |
| API calls 404 in the browser | The API is not running, or `API_PROXY_TARGET` points at the wrong port |
| `better-sqlite3` build failure | Install the toolchain in §1, then `pnpm rebuild better-sqlite3` |
| Blank page after `pnpm run start` | You did not `pnpm run build` first, or `NODE_ENV` is not `production` |
| `ENOSPC` file watcher error (Linux) | `echo fs.inotify.max_user_watches=524288 \| sudo tee -a /etc/sysctl.conf && sudo sysctl -p` |
