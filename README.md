# Doc Bridge

Doc Bridge membantu kamu browse dokumen dari repo publik mdown-collection, preview markdown, lalu import ke workspace VS Code.

## Features

### Docs Browser
- Browse docs dalam struktur tree seperti GitHub
- Search file langsung dari panel Doc Bridge
- Preview markdown (Rendered/Raw)
- Highlight & edit placeholder `{{VARIABLE}}` sebelum import
- Import ke workspace saat siap
- Drag & drop file dari tree

### Kanban + AI (v0.2.5)
- Kanban board: **Todo / Doing / Done**
- Planning type per card (`prd`, `tech_plan`, `task_breakdown`)
- Attach referensi dokumen ke card:
  - tombol **Attach Docs**
  - drag dari Doc Bridge tree ke card Planning
- Implement card dengan endpoint OpenAI-compatible
- Approval dulu sebelum apply perubahan file ke workspace

## Requirements

- Tidak perlu backend lokal untuk fitur Doc Bridge (langsung pakai GitHub API publik)
- Untuk Kanban AI, butuh endpoint OpenAI-compatible + API key

## Setup (Extension)

```bash
cd vscode-extension
npm install
npm run compile
```

Lalu jalankan Extension Development Host dari VS Code (`F5`) atau package ke `.vsix`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `docBridge.docsFolder` | *(empty = root)* | Folder di repo yang mau di-browse |
| `docBridge.recursive` | `true` | Include subfolder secara rekursif |
| `docBridge.saveFolder` | *(empty = workspace root)* | Folder tujuan saat import ke workspace |
| `docBridge.kanban.openaiBaseUrl` | `http://127.0.0.1:50667/v1` | Base URL OpenAI-compatible untuk Kanban AI |
| `docBridge.kanban.model` | `gpt-4.1-mini` | Model name untuk endpoint AI |

## Commands

- `Kanban: Configure AI` → set base URL, model, API key
- `Kanban: Set API Key` → update API key saja
- `Kanban: New`
- `Kanban: Open`
- `Kanban: Implement Doing`

## Quick Usage

### Doc Bridge
1. Buka panel **Doc Bridge** di Activity Bar
2. Klik **Search** jika ingin filter file tertentu
3. Klik file untuk preview
4. (Opsional) edit `{{VARIABLE}}`
5. Klik **Import to Workspace**

### Kanban AI
1. Jalankan **Kanban: Configure AI**
2. Buat board lewat **Kanban: New**
3. Atur planning type dan attach docs ke card
4. Pindahkan card ke **Doing**
5. Jalankan **Kanban: Implement Doing**
6. Approve/reject proposal edit file per item
7. Card sukses pindah ke **Done**

## Version

Current package: **0.2.5**

## Notes

File `.vsix` harus sesuai versi terbaru saat install.
Jika masih tampil versi lama, install ulang file terbaru: `vscode-extension/doc-bridge-0.2.5.vsix`.
