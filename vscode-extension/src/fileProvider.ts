import * as vscode from "vscode";
import { DocFile, fetchFileList } from "./bridgeClient";

// ─── Tree Nodes ───────────────────────────────────────────────────────────────

export class FolderItem extends vscode.TreeItem {
  children: (FolderItem | DocItem)[] = [];

  constructor(public readonly label: string, public readonly folderPath: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath     = new vscode.ThemeIcon("folder");
    this.contextValue = "docFolder";
    this.tooltip      = folderPath;
  }
}

export class DocItem extends vscode.TreeItem {
  constructor(public readonly file: DocFile) {
    super(file.name, vscode.TreeItemCollapsibleState.None);
    this.tooltip      = `${file.path}\n${formatSize(file.size)}`;
    this.description  = formatSize(file.size);
    this.contextValue = "docItem";
    this.iconPath     = new vscode.ThemeIcon("markdown");
    // klik = preview dulu, bukan langsung download
    this.command = {
      command: "docBridge.openPreview",
      title: "Preview",
      arguments: [this],
    };
  }
}

// ─── Tree Data Provider ───────────────────────────────────────────────────────

export class DocFileProvider
  implements vscode.TreeDataProvider<FolderItem | DocItem> {

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private _allFiles: DocFile[]               = [];
  private _rootTree: (FolderItem | DocItem)[] = [];
  private _filter   = "";
  private _loading  = false;

  getTreeItem(item: FolderItem | DocItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: FolderItem | DocItem): (FolderItem | DocItem)[] {
    if (parent instanceof DocItem) {
      return [];
    }

    if (this._filter) {
      if (parent) {
        return [];
      }
      const q = this._filter.toLowerCase();
      return this._allFiles
        .filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
        .map(f => new DocItem(f));
    }

    if (!parent) {
      if (this._allFiles.length === 0 && !this._loading) {
        this._loadFiles();
      }
      return this._rootTree;
    }

    if (parent instanceof FolderItem) {
      return parent.children;
    }

    return [];
  }

  refresh(): void {
    this._allFiles = [];
    this._rootTree = [];
    this._filter   = "";
    this._onDidChange.fire();
  }

  setFilter(text: string): void {
    this._filter = text.trim();
    this._onDidChange.fire();
  }

  getFilter(): string {
    return this._filter;
  }

  private async _loadFiles(): Promise<void> {
    this._loading = true;
    try {
      this._allFiles = await fetchFileList();
      this._rootTree = buildTree(this._allFiles);
      this._onDidChange.fire();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Doc Bridge: ${msg}`);
    } finally {
      this._loading = false;
    }
  }
}

// ─── Drag & Drop ─────────────────────────────────────────────────────────────

const MIME = "application/vnd.code.tree.docBridge";

export class DocDragDropController
  implements vscode.TreeDragAndDropController<FolderItem | DocItem> {

  readonly dropMimeTypes = [MIME];
  readonly dragMimeTypes = [MIME];

  handleDrag(items: readonly (FolderItem | DocItem)[], dataTransfer: vscode.DataTransfer): void {
    const paths = items
      .filter((i): i is DocItem => i instanceof DocItem)
      .map(i => i.file.path);
    dataTransfer.set(MIME, new vscode.DataTransferItem(paths));
  }

  async handleDrop(_target: FolderItem | DocItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(MIME);
    if (!item) return;
    for (const filePath of item.value as string[]) {
      await vscode.commands.executeCommand("docBridge.copyToLocalByPath", filePath);
    }
  }
}

// ─── Tree Builder ─────────────────────────────────────────────────────────────

function buildTree(files: DocFile[]): (FolderItem | DocItem)[] {
  const roots: (FolderItem | DocItem)[] = [];
  const folderMap = new Map<string, FolderItem>();

  // Sort files by path to ensure folders are created consistently
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    // Handle both / and \ separators (useful for Windows)
    const parts = file.path.split(/[\\\/]/);

    if (parts.length === 1) {
      roots.push(new DocItem(file));
      continue;
    }

    let siblings: (FolderItem | DocItem)[] = roots;
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue; // Skip empty parts from leading/trailing slashes

      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let folder = folderMap.get(currentPath);
      if (!folder) {
        folder = new FolderItem(part, currentPath);
        siblings.push(folder);
        folderMap.set(currentPath, folder);
      }
      siblings = folder.children;
    }

    siblings.push(new DocItem(file));
  }

  // Final sort: Folders first, then files alphabetically
  return sortTree(roots);
}

function sortTree(items: (FolderItem | DocItem)[]): (FolderItem | DocItem)[] {
  return items.sort((a, b) => {
    const isAFolder = a instanceof FolderItem;
    const isBFolder = b instanceof FolderItem;

    if (isAFolder && !isBFolder) return -1;
    if (!isAFolder && isBFolder) return 1;

    const labelA = typeof a.label === "string" ? a.label : (a.label?.label || "");
    const labelB = typeof b.label === "string" ? b.label : (b.label?.label || "");
    return labelA.localeCompare(labelB);
  }).map(item => {
    if (item instanceof FolderItem) {
      item.children = sortTree(item.children);
    }
    return item;
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
