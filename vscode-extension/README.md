# Doc Bridge

Browse and pull markdown docs directly from public GitHub repo inside VS Code.

## Features

- Folder tree view of all `.md` files in your repo
- Search by filename or path
- One-click download to workspace
- Markdown preview without saving
- Drag & drop support

## Requirements

Run the local bridge server before using the extension:

```bash
cd server
node index.js
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `docBridge.serverUrl` | `http://localhost:3456` | Bridge server URL |
| `docBridge.apiKey` | *(empty)* | API key if set on server |
| `docBridge.docsFolder` | *(empty = root)* | Folder in repo to browse |
| `docBridge.recursive` | `true` | Include subfolders |
| `docBridge.saveFolder` | *(empty = workspace root)* | Local save destination |
