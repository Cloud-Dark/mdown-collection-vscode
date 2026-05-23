# Doc Bridge

Doc Bridge adalah tools untuk import dokumentasi dari:

- https://github.com/Cloud-Dark/mdown-collection

langsung ke VS Code dengan cepat dan mudah.

## Features

- Browse docs dalam struktur folder (tree) seperti di GitHub
- Search file langsung dari panel Doc Bridge
- Klik file untuk preview markdown
- Highlight & edit placeholder `{{VARIABLE}}` sebelum import
- Import ke workspace saat siap
- Drag & drop support

## Requirements

Tidak perlu backend lokal.
Extension mengambil data langsung dari public GitHub API.

## Settings

| Setting | Default | Description |
|---|---|---|
| `docBridge.docsFolder` | *(empty = root)* | Folder di repo yang mau di-browse |
| `docBridge.recursive` | `true` | Include subfolder secara rekursif |
| `docBridge.saveFolder` | *(empty = workspace root)* | Folder tujuan saat import ke workspace |

## Quick Usage

1. Buka panel **Doc Bridge** di Activity Bar
2. Klik **Search files...** jika ingin filter file tertentu
3. Klik file untuk buka preview
4. (Opsional) edit `{{VARIABLE}}` di preview
5. Klik **Import to Workspace** untuk menyimpan file ke project kamu
