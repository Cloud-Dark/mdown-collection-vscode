# Doc Bridge

Browse & pull markdown docs dari **private GitHub repo** ke VS Code — via Node.js bridge server.

```
GitHub Private Repo (docs/)
        ↓  PAT Token (aman di server)
Node.js Bridge Server  →  GET /files  →  JSON
        ↓
VS Code Extension (TreeView)
        ↓  klik / drag
Local Workspace
```

---

## Struktur Project

```
doc-bridge/
├── server/              ← Node.js Express API
│   ├── index.js
│   ├── .env.example
│   └── package.json
│
└── vscode-extension/    ← VS Code Extension
    ├── src/
    │   ├── extension.ts
    │   ├── fileProvider.ts
    │   └── bridgeClient.ts
    ├── package.json
    └── tsconfig.json
```

---

## Setup: Server

```bash
cd server
cp .env.example .env
# edit .env: isi GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO

npm install
npm start
# → running di http://localhost:3456
```

### GitHub Personal Access Token

1. Buka https://github.com/settings/tokens
2. Generate new token (Fine-grained)
3. Repository access → pilih repo yang dimau
4. Permissions → **Contents: Read-only**
5. Copy token → paste ke `.env` sebagai `GITHUB_TOKEN`

### Test server

```bash
# list files
curl http://localhost:3456/files?path=docs

# download satu file
curl "http://localhost:3456/file?path=docs/setup.md"

# health check
curl http://localhost:3456/health
```

---

## Setup: VS Code Extension

```bash
cd vscode-extension
npm install
npm run compile

# Tekan F5 di VS Code → buka Extension Development Host
```

### Settings (VS Code)

Buka Settings → cari "Doc Bridge":

| Setting | Default | Keterangan |
|---|---|---|
| `docBridge.serverUrl` | `http://localhost:3456` | URL bridge server |
| `docBridge.apiKey` | _(kosong)_ | API key jika server di-protect |
| `docBridge.docsFolder` | `docs` | Folder di repo GitHub |
| `docBridge.recursive` | `false` | Include subfolder |
| `docBridge.saveFolder` | _(kosong)_ | Subfolder tujuan save di workspace |

---

## Cara Pakai

1. Jalankan bridge server (`npm start`)
2. Buka VS Code → klik icon **Doc Bridge** di sidebar kiri
3. List file `.md` dari GitHub repo muncul
4. **Klik** file → otomatis download & buka di editor
5. **Drag** file dari panel ke workspace explorer → save ke local

---

## Deploy Server (Production)

Kalau mau server jalan terus (bukan localhost), bisa deploy ke:

- **VPS sendiri** pakai PM2: `pm2 start index.js --name doc-bridge`
- **Railway / Render** — free tier cukup
- **Docker**:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
CMD ["node", "index.js"]
```

Setelah deploy, update `docBridge.serverUrl` di VS Code Settings ke URL production.

---

## API Reference

### `GET /files`

| Query | Default | Keterangan |
|---|---|---|
| `path` | `docs` | Folder di repo |
| `recursive` | `false` | Rekursif subfolder |

Response:
```json
{
  "success": true,
  "repo": "owner/repo",
  "branch": "main",
  "path": "docs",
  "count": 3,
  "files": [
    {
      "name": "setup.md",
      "path": "docs/setup.md",
      "size": 1024,
      "sha": "abc123",
      "download_url": "..."
    }
  ]
}
```

### `GET /file?path=docs/setup.md`

Response:
```json
{
  "success": true,
  "name": "setup.md",
  "path": "docs/setup.md",
  "sha": "abc123",
  "size": 1024,
  "content": "# Setup\n\n..."
}
```

### `GET /health`

```json
{ "status": "ok", "repo": "owner/repo", "branch": "main" }
```
