import * as vscode from "vscode";
import { DocFile, fetchFileList } from "./bridgeClient";

// ─── Tree Nodes ───────────────────────────────────────────────────────────────

export class SearchItem extends vscode.TreeItem {
  constructor(query: string) {
    super(query ? `Search: ${query}` : "Search files...", vscode.TreeItemCollapsibleState.None);
    this.contextValue = "docSearch";
    this.iconPath = new vscode.ThemeIcon("search");
    this.description = query ? "filtered" : "all files";
    this.command = { command: "docBridge.searchInline", title: "Search Inline" };
    this.tooltip = query
      ? "Klik untuk ubah pencarian (Enter kosong untuk reset)"
      : "Klik untuk cari file berdasarkan nama/path";
  }
}

export class FolderItem extends vscode.TreeItem {
  children: TreeNode[] = [];

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
    this.command = {
      command: "docBridge.openPreview",
      title: "Preview",
      arguments: [this],
    };
  }
}

export type TreeNode = SearchItem | FolderItem | DocItem;

// ─── Tree Data Provider ───────────────────────────────────────────────────────

export class DocFileProvider
  implements vscode.TreeDataProvider<TreeNode> {

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private _allFiles: DocFile[] = [];
  private _rootTree: TreeNode[] = [];
  private _filter = "";
  private _loading = false;

  getTreeItem(item: TreeNode): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: TreeNode): TreeNode[] {
    if (parent instanceof DocItem || parent instanceof SearchItem) {
      return [];
    }

    if (this._filter) {
      if (parent) return [];
      const q = this._filter.toLowerCase();
      const filtered = this._allFiles
        .filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
        .map(f => new DocItem(f));
      return [new SearchItem(this._filter), ...filtered];
    }

    if (!parent) {
      if (this._allFiles.length === 0 && !this._loading) {
        this._loadFiles();
      }
      return [new SearchItem(this._filter), ...this._rootTree];
    }

    if (parent instanceof FolderItem) {
      return parent.children;
    }

    return [];
  }

  refresh(): void {
    this._allFiles = [];
    this._rootTree = [];
    this._filter = "";
    this._onDidChange.fire();
  }

  reloadKeepFilter(): void {
    this._allFiles = [];
    this._rootTree = [];
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
  implements vscode.TreeDragAndDropController<TreeNode> {

  readonly dropMimeTypes = [MIME];
  readonly dragMimeTypes = [MIME];

  handleDrag(items: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    const paths = items
      .filter((i): i is DocItem => i instanceof DocItem)
      .map(i => i.file.path);
    dataTransfer.set(MIME, new vscode.DataTransferItem(paths));
  }

  async handleDrop(_target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(MIME);
    if (!item) return;
    for (const filePath of item.value as string[]) {
      await vscode.commands.executeCommand("docBridge.copyToLocalByPath", filePath);
    }
  }
}

// ─── Tree Builder ─────────────────────────────────────────────────────────────

function buildTree(files: DocFile[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const folderMap = new Map<string, FolderItem>();

  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    const parts = file.path.split(/[\\/]/);

    if (parts.length === 1) {
      roots.push(new DocItem(file));
      continue;
    }

    let siblings: TreeNode[] = roots;
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;

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

  return sortTree(roots);
}

function sortTree(items: TreeNode[]): TreeNode[] {
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
