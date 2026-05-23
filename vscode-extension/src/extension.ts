import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { DocFileProvider, DocDragDropController, DocItem } from "./fileProvider";
import { fetchFileContent, checkHealth, getSaveFolder, fetchFileList } from "./bridgeClient";
import { KanbanService } from "./kanban/kanbanService";
import { OpenAiKanbanService } from "./kanban/aiService";
import { FileEditProposal, KanbanHostMessage, KanbanWebviewMessage } from "./kanban/types";

// track panel yang sedang terbuka agar tidak dobel
const openPanels = new Map<string, vscode.WebviewPanel>();
let kanbanPanel: vscode.WebviewPanel | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log("Doc Bridge activated");

  const provider = new DocFileProvider();
  const dnd      = new DocDragDropController();
  const kanbanService = new KanbanService(context.workspaceState);
  const aiService = new OpenAiKanbanService(context, () => {
    const cfg = vscode.workspace.getConfiguration("docBridge");
    return {
      baseUrl: cfg.get<string>("kanban.openaiBaseUrl", "http://127.0.0.1:50667/v1"),
      model: cfg.get<string>("kanban.model", "gpt-4.1-mini"),
    };
  });

  const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const resolveSafePath = (relativePath: string): string => {
    const root = workspaceRoot();
    if (!root) throw new Error("Buka folder workspace dulu.");
    const cleaned = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleaned || cleaned.includes("..")) throw new Error(`Path tidak aman: ${relativePath}`);
    const full = path.resolve(root, cleaned);
    const rel = path.relative(root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path di luar workspace: ${relativePath}`);
    return full;
  };

  const applyApprovedProposal = async (proposal: FileEditProposal): Promise<{ ok: boolean; message: string }> => {
    const fullPath = resolveSafePath(proposal.filePath);
    const uri = vscode.Uri.file(fullPath);
    const exists = fs.existsSync(fullPath);

    if (proposal.action === "create" && exists) {
      const pick = await vscode.window.showQuickPick(["Replace file existing", "Skip"], { placeHolder: `${proposal.filePath} sudah ada` });
      if (pick !== "Replace file existing") return { ok: false, message: "Skipped by user" };
    }

    if (proposal.action === "replace" && !exists) {
      const pick = await vscode.window.showQuickPick(["Create instead", "Skip"], { placeHolder: `${proposal.filePath} belum ada` });
      if (pick !== "Create instead") return { ok: false, message: "Skipped by user" };
    }

    const wsEdit = new vscode.WorkspaceEdit();
    if (exists) {
      const current = fs.readFileSync(fullPath, "utf-8");
      const end = new vscode.Position(current.split(/\r?\n/).length + 1, 0);
      wsEdit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), proposal.content);
    } else {
      wsEdit.createFile(uri, { ignoreIfExists: false, overwrite: true });
      wsEdit.insert(uri, new vscode.Position(0, 0), proposal.content);
    }
    const applied = await vscode.workspace.applyEdit(wsEdit);
    if (!applied) return { ok: false, message: "WorkspaceEdit gagal di-apply" };
    return { ok: true, message: `Applied ${proposal.filePath}` };
  };

  const postKanbanState = (panel: vscode.WebviewPanel) => {
    const message: KanbanHostMessage = { type: "KANBAN_STATE", board: kanbanService.getBoard() };
    void panel.webview.postMessage(message);
  };

  const openKanbanPanel = () => {
    if (kanbanPanel) {
      kanbanPanel.reveal(vscode.ViewColumn.One);
      postKanbanState(kanbanPanel);
      return kanbanPanel;
    }

    kanbanPanel = vscode.window.createWebviewPanel("docBridgeKanban", "Doc Bridge Kanban", vscode.ViewColumn.One, { enableScripts: true });
    kanbanPanel.webview.html = kanbanHtml();
    kanbanPanel.onDidDispose(() => {
      kanbanPanel = undefined;
    });

    kanbanPanel.webview.onDidReceiveMessage(async (msg: KanbanWebviewMessage) => {
      try {
        if (msg.type === "KANBAN_READY") {
          postKanbanState(kanbanPanel!);
          return;
        }

        if (msg.type === "KANBAN_SET_PLANNING_TYPE") {
          kanbanService.setPlanningType(msg.cardId, msg.planningType);
          postKanbanState(kanbanPanel!);
          return;
        }

        if (msg.type === "KANBAN_MOVE_CARD") {
          kanbanService.moveCard(msg.cardId, msg.to);
          postKanbanState(kanbanPanel!);
          return;
        }

        if (msg.type === "KANBAN_NEW_FROM_WEBVIEW") {
          const req = msg.requirement.trim();
          if (!req) {
            void kanbanPanel?.webview.postMessage({ type: "KANBAN_ERROR", message: "Requirement tidak boleh kosong." } satisfies KanbanHostMessage);
            return;
          }
          kanbanService.createBoard(req);
          void kanbanPanel?.webview.postMessage({ type: "KANBAN_BUSY", busy: true, message: "Generating planning..." } satisfies KanbanHostMessage);
          const plan = await aiService.generatePlan({ requirement: req });
          kanbanService.setPlanningCards(plan.cards);
          void kanbanPanel?.webview.postMessage({ type: "KANBAN_BUSY", busy: false } satisfies KanbanHostMessage);
          postKanbanState(kanbanPanel!);
          return;
        }

        if (msg.type === "KANBAN_ATTACH_DOC_REFS") {
          const files = await fetchFileList();
          if (!files.length) {
            void kanbanPanel?.webview.postMessage({ type: "KANBAN_ERROR", message: "Doc Bridge file list kosong." } satisfies KanbanHostMessage);
            return;
          }
          const picks = await vscode.window.showQuickPick(
            files.map((f) => ({ label: f.name, description: f.path })),
            { canPickMany: true, placeHolder: "Pilih file Doc Bridge untuk context card" }
          );
          if (!picks?.length) return;
          kanbanService.setCardDocRefs(msg.cardId, picks.map((p) => p.description || p.label));
          postKanbanState(kanbanPanel!);
          return;
        }

        if (msg.type === "KANBAN_ATTACH_DOC_REFS_DROP") {
          if (!Array.isArray(msg.paths) || msg.paths.length === 0) return;
          kanbanService.appendCardDocRefs(msg.cardId, msg.paths);
          postKanbanState(kanbanPanel!);
          return;
        }

        if (msg.type === "KANBAN_IMPLEMENT") {
          const board = kanbanService.getBoard();
          if (!board) {
            void kanbanPanel?.webview.postMessage({ type: "KANBAN_ERROR", message: "Board belum dibuat." } satisfies KanbanHostMessage);
            return;
          }
          const targets = kanbanService.getInProgress(msg.cardIds);
          if (!targets.length) {
            void kanbanPanel?.webview.postMessage({ type: "KANBAN_ERROR", message: "Tidak ada card Doing yang dipilih." } satisfies KanbanHostMessage);
            return;
          }
          void kanbanPanel?.webview.postMessage({ type: "KANBAN_BUSY", busy: true, message: "Generating edit proposals..." } satisfies KanbanHostMessage);
          const result = await aiService.implementCards({ requirement: board.requirement, cards: targets });
          const updates: Array<{ cardId: string; summary: string; success: boolean; error?: string }> = [];

          for (const proposal of result.proposals) {
            const pick = await vscode.window.showQuickPick(["Approve", "Reject"], {
              placeHolder: `[${proposal.cardId}] ${proposal.summary} → ${proposal.filePath}`,
            });
            if (pick !== "Approve") {
              updates.push({ cardId: proposal.cardId, success: false, summary: "Rejected", error: "Perubahan ditolak user." });
              continue;
            }
            try {
              const applied = await applyApprovedProposal(proposal);
              updates.push({ cardId: proposal.cardId, success: applied.ok, summary: applied.message, error: applied.ok ? undefined : applied.message });
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              updates.push({ cardId: proposal.cardId, success: false, summary: "Failed", error: message });
            }
          }

          kanbanService.completeCards(updates);
          void kanbanPanel?.webview.postMessage({ type: "KANBAN_BUSY", busy: false } satisfies KanbanHostMessage);
          postKanbanState(kanbanPanel!);
          return;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        void kanbanPanel?.webview.postMessage({ type: "KANBAN_BUSY", busy: false } satisfies KanbanHostMessage);
        void kanbanPanel?.webview.postMessage({ type: "KANBAN_ERROR", message } satisfies KanbanHostMessage);
      }
    }, undefined, context.subscriptions);

    postKanbanState(kanbanPanel);
    return kanbanPanel;
  };

  const treeView = vscode.window.createTreeView("docBridge", {
    treeDataProvider: provider,
    dragAndDropController: dnd,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  function updateTitle() {
    treeView.title = "Doc Bridge";
    treeView.description = provider.getFilter() ? `filtered: ${provider.getFilter()}` : undefined;
  }

  // ─── Health check ────────────────────────────────────────────────────────
  const healthy = await checkHealth();
  if (!healthy) {
    vscode.window.showWarningMessage(
      "Doc Bridge: Server tidak terdeteksi. Pastikan bridge server sudah running.",
      "Open Settings"
    ).then(action => {
      if (action === "Open Settings") {
        vscode.commands.executeCommand("workbench.action.openSettings", "docBridge");
      }
    });
  }

  // ─── Refresh ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.refresh", () => {
      provider.setFilter("");
      updateTitle();
      provider.refresh();
    })
  );

  // ─── Search (ikon di atas panel) ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.search", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Cari file markdown...",
        placeHolder: "Nama file atau path — Enter kosong untuk reset",
        value: provider.getFilter(),
      });
      if (input === undefined) return;
      provider.setFilter(input);
      updateTitle();
    })
  );

  // copy link GitHub file
  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.copyLink", async (item: DocItem) => {
      const url = `https://github.com/Cloud-Dark/mdown-collection/blob/main/${item.file.path}`;
      await vscode.env.clipboard.writeText(url);
      vscode.window.showInformationMessage("🔗 Link copied");
    })
  );

  updateTitle();
  provider.refresh();
  treeView.message = undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.clearSearch", () => {
      provider.setFilter("");
      updateTitle();
    })
  );

  // ─── Preview (klik file) ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.openPreview", async (item: DocItem) => {
      // kalau panel sudah terbuka untuk file ini, fokus ke sana
      const existing = openPanels.get(item.file.path);
      if (existing) {
        existing.reveal(vscode.ViewColumn.One);
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        "docBridgePreview",
        item.file.name,
        vscode.ViewColumn.One,
        { enableScripts: true }
      );

      openPanels.set(item.file.path, panel);
      panel.onDidDispose(() => openPanels.delete(item.file.path));

      // loading state
      panel.webview.html = loadingHtml(item.file.name);

      try {
        const data = await fetchFileContent(item.file.path);
        panel.webview.html = previewHtml(data.name, data.path, data.size, data.content);

        // pesan dari webview (tombol Import diklik)
        panel.webview.onDidReceiveMessage(async msg => {
          if (msg.command === "import") {
            const finalContent = typeof msg.content === "string" ? msg.content : data.content;
            await saveToWorkspace(data.path, data.name, finalContent);
          }
        }, undefined, context.subscriptions);

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        panel.webview.html = errorHtml(msg);
      }
    })
  );

  // ─── Import (dari context menu / drag drop) ───────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.copyToLocal", async (item: DocItem) => {
      const data = await fetchFileContent(item.file.path).catch((e: unknown) => {
        vscode.window.showErrorMessage(`Doc Bridge: ${e instanceof Error ? e.message : e}`);
        return null;
      });
      if (!data) return;
      await saveToWorkspace(data.path, data.name, data.content);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.copyToLocalByPath", async (filePath: string) => {
      const fileName = path.basename(filePath);
      const data = await fetchFileContent(filePath).catch((e: unknown) => {
        vscode.window.showErrorMessage(`Doc Bridge: ${e instanceof Error ? e.message : e}`);
        return null;
      });
      if (!data) return;
      await saveToWorkspace(filePath, fileName, data.content);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.kanbanSetApiKey", async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: "Masukkan API key untuk endpoint OpenAI-compatible",
        password: true,
        ignoreFocusOut: true,
      });
      if (!apiKey?.trim()) return;
      await context.secrets.store("docBridge.kanban.apiKey", apiKey.trim());
      vscode.window.showInformationMessage("Kanban API key tersimpan aman di SecretStorage.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.kanbanConfigureAi", async () => {
      const cfg = vscode.workspace.getConfiguration("docBridge");
      const currentBaseUrl = cfg.get<string>("kanban.openaiBaseUrl", "http://127.0.0.1:50667/v1");
      const currentModel = cfg.get<string>("kanban.model", "gpt-4.1-mini");

      const baseUrl = await vscode.window.showInputBox({
        prompt: "Set OpenAI-compatible Base URL",
        value: currentBaseUrl,
        ignoreFocusOut: true,
      });
      if (!baseUrl?.trim()) return;

      const model = await vscode.window.showInputBox({
        prompt: "Set model name",
        value: currentModel,
        ignoreFocusOut: true,
      });
      if (!model?.trim()) return;

      const apiKey = await vscode.window.showInputBox({
        prompt: "Set API key",
        password: true,
        ignoreFocusOut: true,
      });
      if (!apiKey?.trim()) return;

      await cfg.update("kanban.openaiBaseUrl", baseUrl.trim(), vscode.ConfigurationTarget.Workspace);
      await cfg.update("kanban.model", model.trim(), vscode.ConfigurationTarget.Workspace);
      await context.secrets.store("docBridge.kanban.apiKey", apiKey.trim());
      vscode.window.showInformationMessage("Kanban AI config tersimpan (base URL, model, API key).");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.kanbanOpen", () => {
      openKanbanPanel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.kanbanNew", async () => {
      const requirement = await vscode.window.showInputBox({
        prompt: "Masukkan kebutuhan awal (contoh: buat aplikasi todo list)",
        placeHolder: "buat aplikasi todo list",
      });
      if (!requirement?.trim()) return;
      const panel = openKanbanPanel();
      kanbanService.createBoard(requirement.trim());
      void panel.webview.postMessage({ type: "KANBAN_BUSY", busy: true, message: "Generating planning..." } satisfies KanbanHostMessage);
      try {
        const plan = await aiService.generatePlan({ requirement: requirement.trim() });
        kanbanService.setPlanningCards(plan.cards);
      } finally {
        void panel.webview.postMessage({ type: "KANBAN_BUSY", busy: false } satisfies KanbanHostMessage);
      }
      postKanbanState(panel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("docBridge.kanbanImplementInProgress", async () => {
      const board = kanbanService.getBoard();
      if (!board) {
        vscode.window.showErrorMessage("Kanban board belum dibuat.");
        return;
      }
      const targets = kanbanService.getInProgress();
      if (!targets.length) {
        vscode.window.showInformationMessage("Belum ada card di Doing.");
        return;
      }
      const panel = openKanbanPanel();
      void panel.webview.postMessage({ type: "KANBAN_BUSY", busy: true, message: "Generating edit proposals..." } satisfies KanbanHostMessage);
      try {
        const result = await aiService.implementCards({ requirement: board.requirement, cards: targets });
        const updates: Array<{ cardId: string; summary: string; success: boolean; error?: string }> = [];
        for (const proposal of result.proposals) {
          const pick = await vscode.window.showQuickPick(["Approve", "Reject"], {
            placeHolder: `[${proposal.cardId}] ${proposal.summary} → ${proposal.filePath}`,
          });
          if (pick !== "Approve") {
            updates.push({ cardId: proposal.cardId, success: false, summary: "Rejected", error: "Perubahan ditolak user." });
            continue;
          }
          try {
            const applied = await applyApprovedProposal(proposal);
            updates.push({ cardId: proposal.cardId, success: applied.ok, summary: applied.message, error: applied.ok ? undefined : applied.message });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            updates.push({ cardId: proposal.cardId, success: false, summary: "Failed", error: message });
          }
        }
        kanbanService.completeCards(updates);
      } finally {
        void panel.webview.postMessage({ type: "KANBAN_BUSY", busy: false } satisfies KanbanHostMessage);
      }
      postKanbanState(panel);
    })
  );

  context.subscriptions.push({ dispose: () => { kanbanPanel?.dispose(); } });

  if (kanbanService.getBoard()) {
    openKanbanPanel();
  }
}

// ─── Helper: simpan ke workspace ─────────────────────────────────────────────

async function saveToWorkspace(filePath: string, fileName: string, content: string) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    vscode.window.showErrorMessage("Doc Bridge: Buka dulu folder/workspace di VS Code.");
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Saving ${fileName}...`, cancellable: false },
    async () => {
      const workspacePath = workspaceFolders[0].uri.fsPath;
      const saveFolder    = getSaveFolder();
      const destDir       = saveFolder ? path.join(workspacePath, saveFolder) : workspacePath;

      fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, fileName);
      fs.writeFileSync(destPath, content, "utf-8");

      const uri = vscode.Uri.file(destPath);
      await vscode.window.showTextDocument(uri, { preview: false });
      vscode.window.showInformationMessage(`✅ ${fileName} saved to workspace`);
    }
  );
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function loadingHtml(name: string): string {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem">
    <p>Loading <strong>${esc(name)}</strong>...</p>
  </body></html>`;
}

function kanbanHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Agent Kanban</title>
<style>
  :root {
    --bg-main: #0d1117;
    --bg-sidebar: #010409;
    --bg-card: #161b22;
    --bg-lane: #0d1117;
    --border-color: #30363d;
    --text-primary: #c9d1d9;
    --text-secondary: #8b949e;
    --accent-blue: #238636; /* Using green-ish for buttons like in image, or blue */
    --accent-primary: #1f6feb;
    --priority-high: #da3633;
    --priority-medium: #d29922;
    --priority-low: #3fb950;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
    color: var(--text-primary);
    background: var(--bg-main);
    margin: 0;
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Sidebar ── */
  .sidebar {
    width: 240px;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    padding: 16px;
    flex-shrink: 0;
  }
  .sidebar-header {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    margin-bottom: 12px;
    letter-spacing: 0.5px;
  }
  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    color: var(--text-primary);
  }
  .nav-item:hover { background: #21262d; }
  .nav-item.active { background: var(--accent-primary); color: white; }
  .nav-item .count { margin-left: auto; color: var(--text-secondary); font-size: 11px; }

  .sidebar-stats {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--border-color);
  }
  .stat-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    margin-bottom: 8px;
    color: var(--text-secondary);
  }

  /* ── Main Content ── */
  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* ── Top Bar ── */
  .top-bar {
    padding: 12px 20px;
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-main);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--border-color);
    background: #21262d;
    color: var(--text-primary);
    transition: 0.2s;
  }
  .btn:hover { background: #30363d; border-color: #8b949e; }
  .btn-primary {
    background: var(--accent-primary);
    border-color: rgba(240,246,252,0.1);
    color: white;
  }
  .btn-primary:hover { background: #388bfd; }

  .search-box {
    flex: 1;
    max-width: 400px;
    position: relative;
  }
  .search-box input {
    width: 100%;
    background: #0d1117;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 6px 12px;
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
  }
  .search-box input:focus { border-color: var(--accent-primary); box-shadow: 0 0 0 3px rgba(31,111,235,0.3); }

  /* ── Board ── */
  .board-container {
    flex: 1;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 20px;
    display: flex;
    gap: 20px;
    align-items: flex-start;
  }
  .lane {
    width: 320px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    max-height: 100%;
    background: transparent;
  }
  .lane-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 4px;
    margin-bottom: 12px;
  }
  .lane-icon { opacity: 0.6; }
  .lane-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .lane-count {
    background: #21262d;
    color: var(--text-secondary);
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 10px;
    margin-left: auto;
  }

  .cards-container {
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
    padding-right: 4px;
  }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 16px;
    cursor: grab;
    transition: transform 0.1s, box-shadow 0.1s;
  }
  .card:hover { border-color: #8b949e; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
  .card:active { cursor: grabbing; }
  .card.drop-target { outline: 2px dashed var(--accent-primary); outline-offset: 4px; }

  .card-priority {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    margin-bottom: 8px;
  }
  .priority-high { background: rgba(218, 54, 51, 0.2); color: #ff7b72; }
  .priority-medium { background: rgba(210, 153, 34, 0.2); color: #d29922; }
  .priority-low { background: rgba(63, 185, 80, 0.2); color: #7ee787; }

  .card-title {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 8px 0;
    line-height: 1.4;
  }
  .card-desc {
    font-size: 12px;
    color: var(--text-secondary);
    margin-bottom: 12px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
  }
  .card-assignee {
    width: 24px;
    height: 24px;
    background: #30363d;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
  }
  .card-date {
    font-size: 11px;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .card-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border-color);
  }
  .card-btn {
    padding: 4px 8px;
    font-size: 11px;
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
  }
  .card-btn:hover { color: var(--text-primary); border-color: #8b949e; }

  .error { color: #ff7b72; font-size: 12px; margin-top: 8px; }
  .busy-overlay {
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #161b22;
    border: 1px solid var(--border-color);
    padding: 12px 20px;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 13px;
    z-index: 1000;
  }
  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255,255,255,0.1);
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Custom scrollbar */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 10px; }
  ::-webkit-scrollbar-thumb:hover { background: #484f58; }
</style>
</head>
<body>
  <div class="sidebar">
    <div class="sidebar-header">Agent Kanban: Board</div>
    <div class="sidebar-nav">
      <div class="nav-item active">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25ZM9.5 3h3.5v2h-3.5Zm0 4h3.5v2h-3.5Zm0 4h3.5v2h-3.5ZM3 3h4.5v2H3Zm0 4h4.5v2H3Zm0 4h4.5v2H3Z"/></svg>
        Open Board
      </div>
    </div>

    <div class="sidebar-stats">
      <div class="stat-row"><span id="active-tasks-count">0 active tasks</span></div>
      <div class="sidebar-header" style="margin-top:16px">Lanes</div>
      <div class="stat-row"><span>TODO</span><span id="count-todo">0</span></div>
      <div class="stat-row"><span>DOING</span><span id="count-doing">0</span></div>
      <div class="stat-row"><span>DONE</span><span id="count-done">0</span></div>
    </div>
  </div>

  <div class="main-content">
    <div class="top-bar">
      <button class="btn btn-primary" id="newBtn">+ New Task</button>
      <button class="btn" id="addLaneBtn">+ Add Lane</button>
      <div class="search-box">
        <input id="req" placeholder="Cari atau buat task baru..." />
      </div>
      <button class="btn" id="implBtn">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM4.5 5.5v5l5-2.5-5-2.5Z"/></svg>
        Implement
      </button>
    </div>

    <div class="board-container">
      <div class="lane">
        <div class="lane-header">
          <span class="lane-icon">≡</span>
          <span class="lane-title">TODO</span>
          <span class="lane-count" id="badge-todo">0</span>
        </div>
        <div class="cards-container" id="todo"></div>
      </div>

      <div class="lane">
        <div class="lane-header">
          <span class="lane-icon">≡</span>
          <span class="lane-title">DOING</span>
          <span class="lane-count" id="badge-doing">0</span>
        </div>
        <div class="cards-container" id="doing"></div>
      </div>

      <div class="lane">
        <div class="lane-header">
          <span class="lane-icon">≡</span>
          <span class="lane-title">DONE</span>
          <span class="lane-count" id="badge-done">0</span>
        </div>
        <div class="cards-container" id="done"></div>
      </div>
    </div>
  </div>

  <div class="busy-overlay" id="busy" style="display:none">
    <div class="spinner"></div>
    <span id="busy-msg">Processing...</span>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  let board = null;

  const busyEl = document.getElementById('busy');
  const busyMsg = document.getElementById('busy-msg');
  const reqEl = document.getElementById('req');

  document.getElementById('newBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'KANBAN_NEW_FROM_WEBVIEW', requirement: reqEl.value || '' });
  });
  document.getElementById('implBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'KANBAN_IMPLEMENT' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'KANBAN_STATE') {
      board = msg.board;
      render();
      return;
    }
    if (msg.type === 'KANBAN_BUSY') {
      busyEl.style.display = msg.busy ? 'flex' : 'none';
      busyMsg.textContent = msg.message || 'Processing...';
      return;
    }
    if (msg.type === 'KANBAN_ERROR') {
      busyEl.style.display = 'flex';
      busyMsg.innerHTML = '<span style="color:#ff7b72">Error: ' + msg.message + '</span>';
      setTimeout(() => { busyEl.style.display = 'none'; }, 5000);
      return;
    }
  });

  function render() {
    if (!board) return;

    const counts = { todo: 0, doing: 0, done: 0 };
    board.cards.forEach(c => { if(counts[c.column] !== undefined) counts[c.column]++; });

    // Update counts
    ['todo','doing','done'].forEach(col => {
      document.getElementById('count-' + col).textContent = counts[col];
      document.getElementById('badge-' + col).textContent = counts[col];
    });
    document.getElementById('active-tasks-count').textContent = (counts.todo + counts.doing) + ' active tasks';

    ['todo','doing','done'].forEach(col => {
      const root = document.getElementById(col);
      root.innerHTML = '';
      const cards = board.cards.filter(c => c.column === col);

      cards.forEach(card => {
        const wrap = document.createElement('div');
        wrap.className = 'card';
        wrap.draggable = true;

        const priority = card.priority || 'medium';
        const dateStr = card.dueDate || new Date(card.createdAt).toLocaleDateString();
        const initial = card.assignee?.name?.charAt(0) || 'G';

        let html = '';
        if (col !== 'done') {
          html += '<div class="card-priority priority-' + priority + '">' + priority.charAt(0).toUpperCase() + priority.slice(1) + '</div>';
        }
        html += '<h4 class="card-title">' + escapeHtml(card.title) + '</h4>';
        html += '<div class="card-desc">' + escapeHtml(card.description) + '</div>';

        html += '<div class="card-footer">';
        html += '  <div class="card-assignee">' + initial + '</div>';
        html += '  <div class="card-date">';
        html += '    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.75 0a.75.75 0 0 1 .75.75V2h5V.75a.75.75 0 0 1 1.5 0V2h1.25c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25V3.75C1 2.784 1.784 2 2.75 2H4V.75A.75.75 0 0 1 4.75 0ZM2.5 7.5v6.75c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V7.5Zm10.75-4H2.75a.25.25 0 0 0-.25.25V6h11V3.75a.25.25 0 0 0-.25-.25Z"/></svg>';
        html += '    ' + dateStr;
        html += '  </div>';
        html += '</div>';

        // Actions
        html += '<div class="card-actions">';
        if (col === 'todo') {
          const select = document.createElement('select');
          select.className = 'card-btn';
          select.innerHTML =
            '<option value="">Type</option>' +
            '<option value="prd" ' + (card.planningType === 'prd' ? 'selected' : '') + '>PRD</option>' +
            '<option value="tech_plan" ' + (card.planningType === 'tech_plan' ? 'selected' : '') + '>Plan</option>' +
            '<option value="task_breakdown" ' + (card.planningType === 'task_breakdown' ? 'selected' : '') + '>Task</option>';
          select.addEventListener('change', () => {
            if (select.value) vscode.postMessage({ type: 'KANBAN_SET_PLANNING_TYPE', cardId: card.id, planningType: select.value });
          });
          wrap.appendChild(select);

          const move = document.createElement('button');
          move.className = 'card-btn';
          move.textContent = 'Start';
          move.addEventListener('click', () => vscode.postMessage({ type: 'KANBAN_MOVE_CARD', cardId: card.id, to: 'doing' }));
          wrap.appendChild(move);
        } else if (col === 'doing') {
          const moveDone = document.createElement('button');
          moveDone.className = 'card-btn';
          moveDone.textContent = 'Finish';
          moveDone.addEventListener('click', () => vscode.postMessage({ type: 'KANBAN_MOVE_CARD', cardId: card.id, to: 'done' }));
          wrap.appendChild(moveDone);
        } else {
          const summary = document.createElement('div');
          summary.className = 'card-desc';
          summary.style.marginTop = '8px';
          summary.textContent = card.implementationSummary || 'Done';
          wrap.appendChild(summary);
        }
        html += '</div>';

        const content = document.createElement('div');
        content.innerHTML = html;
        // Append elements that have listeners
        const actions = content.querySelector('.card-actions');
        wrap.innerHTML = content.innerHTML;
        // Re-attach buttons because innerHTML breaks listeners
        wrap.querySelectorAll('button, select').forEach(btn => {
           // This is tricky with innerHTML, better use appendChild for everything or delegated listeners
        });

        // Simplified render logic for listeners
        renderCard(wrap, card, col);

        root.appendChild(wrap);
      });
    });
  }

  function renderCard(wrap, card, col) {
    wrap.innerHTML = '';
    const priority = card.priority || 'medium';
    const dateStr = card.dueDate || new Date(card.createdAt).toLocaleDateString().split('T')[0];
    const initial = card.assignee?.name?.charAt(0) || 'G';

    if (col !== 'done') {
      const prio = document.createElement('div');
      prio.className = 'card-priority priority-' + priority;
      prio.textContent = priority.charAt(0).toUpperCase() + priority.slice(1);
      wrap.appendChild(prio);
    }

    const title = document.createElement('h4');
    title.className = 'card-title';
    title.textContent = card.title;
    wrap.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'card-desc';
    desc.textContent = card.description;
    wrap.appendChild(desc);

    const footer = document.createElement('div');
    footer.className = 'card-footer';
    footer.innerHTML = '<div class="card-assignee">' + initial + '</div>' +
      '<div class="card-date">' +
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.75 0a.75.75 0 0 1 .75.75V2h5V.75a.75.75 0 0 1 1.5 0V2h1.25c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25V3.75C1 2.784 1.784 2 2.75 2H4V.75A.75.75 0 0 1 4.75 0ZM2.5 7.5v6.75c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V7.5Zm10.75-4H2.75a.25.25 0 0 0-.25.25V6h11V3.75a.25.25 0 0 0-.25-.25Z"/></svg>' +
      ' ' + dateStr + '</div>';
    wrap.appendChild(footer);

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    if (col === 'todo') {
      const select = document.createElement('select');
      select.className = 'card-btn';
      select.innerHTML =
        '<option value="">Type</option>' +
        '<option value="prd" ' + (card.planningType === 'prd' ? 'selected' : '') + '>PRD</option>' +
        '<option value="tech_plan" ' + (card.planningType === 'tech_plan' ? 'selected' : '') + '>Plan</option>' +
        '<option value="task_breakdown" ' + (card.planningType === 'task_breakdown' ? 'selected' : '') + '>Task</option>';
      select.addEventListener('change', () => {
        if (select.value) vscode.postMessage({ type: 'KANBAN_SET_PLANNING_TYPE', cardId: card.id, planningType: select.value });
      });
      actions.appendChild(select);

      const move = document.createElement('button');
      move.className = 'card-btn';
      move.textContent = 'Start';
      move.addEventListener('click', () => vscode.postMessage({ type: 'KANBAN_MOVE_CARD', cardId: card.id, to: 'doing' }));
      actions.appendChild(move);
    } else if (col === 'doing') {
      const moveDone = document.createElement('button');
      moveDone.className = 'card-btn';
      moveDone.textContent = 'Finish';
      moveDone.addEventListener('click', () => vscode.postMessage({ type: 'KANBAN_MOVE_CARD', cardId: card.id, to: 'done' }));
      actions.appendChild(moveDone);
    } else {
      const summary = document.createElement('div');
      summary.className = 'card-desc';
      summary.style.marginTop = '0';
      summary.textContent = card.implementationSummary || 'Done';
      actions.appendChild(summary);
    }
    wrap.appendChild(actions);

    if (card.error) {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = card.error;
      wrap.appendChild(err);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  vscode.postMessage({ type: 'KANBAN_READY' });
</script>
</body>
</html>`;
}

function errorHtml(msg: string): string {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;color:#f44">
    <p>Error: ${esc(msg)}</p>
  </body></html>`;
}

function previewHtml(name: string, filePath: string, size: number, content: string): string {
  const sizeStr   = size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
  const variables = extractVariables(content);
  const rendered  = safeRenderMarkdown(content, variables);
  const varCss    = buildVarCss(variables);
  const varList   = JSON.stringify(variables);
  const rawJson   = JSON.stringify(content);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 14px;
         color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }

  /* ── top bar ── */
  .topbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 12px;
    padding: 10px 20px;
    background: var(--vscode-editorGroupHeader-tabsBackground, #1e1e1e);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
  }
  .topbar .meta { flex: 1; min-width: 0; }
  .topbar .meta h2 { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .topbar .meta span { font-size: 11px; opacity: .6; }

  .btn-import {
    flex-shrink: 0;
    display: flex; align-items: center; gap: 6px;
    padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer;
    font-size: 13px; font-weight: 600;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    transition: opacity .15s;
  }
  .btn-import:hover { opacity: .85; }
  .btn-import svg { width: 14px; height: 14px; fill: currentColor; }

  .view-toggle {
    display: inline-flex;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 4px;
    overflow: hidden;
    margin-right: 8px;
  }
  .view-toggle button {
    border: none;
    background: transparent;
    color: var(--vscode-foreground);
    font-size: 12px;
    padding: 5px 10px;
    cursor: pointer;
  }
  .view-toggle button.active {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
  }

  .raw {
    display: none;
    margin: 16px 24px 24px;
    padding: 14px;
    border-radius: 6px;
    background: var(--vscode-textCodeBlock-background,#2d2d2d);
    overflow-x: auto;
    white-space: pre-wrap;
    line-height: 1.5;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }
  .raw.show { display: block; }
  .md.hide { display: none; }

  /* ── markdown body ── */
  .md { padding: 24px 28px; max-width: 860px; line-height: 1.7; }
  .md h1,.md h2,.md h3,.md h4 { margin: 1.2em 0 .4em; font-weight: 600; }
  .md h1 { font-size: 1.8em; border-bottom: 1px solid var(--vscode-panel-border,#333); padding-bottom: .3em; }
  .md h2 { font-size: 1.4em; border-bottom: 1px solid var(--vscode-panel-border,#444); padding-bottom: .2em; }
  .md p  { margin: .6em 0; }
  .md ul,.md ol { padding-left: 1.6em; margin: .4em 0; }
  .md li { margin: .2em 0; }
  .md code { font-family: monospace; font-size: .9em;
             background: var(--vscode-textCodeBlock-background,#2d2d2d);
             padding: .1em .35em; border-radius: 3px; }
  .md pre  { background: var(--vscode-textCodeBlock-background,#2d2d2d);
             padding: 1em; border-radius: 6px; overflow-x: auto; margin: .8em 0; }
  .md pre code { background: none; padding: 0; }
  .md blockquote { border-left: 3px solid var(--vscode-panel-border,#555);
                   padding-left: 1em; opacity: .75; margin: .6em 0; }
  .md table { border-collapse: collapse; width: 100%; margin: .8em 0; }
  .md th,.md td { border: 1px solid var(--vscode-panel-border,#444); padding: 6px 10px; text-align: left; }
  .md th { background: var(--vscode-textCodeBlock-background,#2d2d2d); }
  .md a  { color: var(--vscode-textLink-foreground,#4ea9d1); }
  .md hr { border: none; border-top: 1px solid var(--vscode-panel-border,#444); margin: 1em 0; }

  /* ── variable highlights ── */
  .var {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-weight: 500;
    cursor: pointer;
    color: #2a2a2a;
    transition: filter .1s, box-shadow .1s;
    border: 1px solid transparent;
  }
  .var:hover { filter: brightness(.95); box-shadow: 0 1px 3px rgba(0,0,0,.2); }
  .var.edited { border: 1px dashed rgba(0,0,0,.35); }
  .var.edited::after { content: " ✎"; font-size: .75em; opacity: .55; }
  ${varCss}

  /* ── popover editor ── */
  .popover {
    position: absolute; z-index: 100;
    min-width: 240px;
    padding: 10px 12px;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-focusBorder, #007acc);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,.4);
    display: none;
  }
  .popover.show { display: block; }
  .popover .pop-label {
    font-size: 11px; opacity: .7; margin-bottom: 6px;
    text-transform: uppercase; letter-spacing: .5px;
  }
  .popover .pop-name {
    font-family: monospace; font-weight: 600;
    color: var(--vscode-textLink-foreground, #4ea9d1);
  }
  .popover input {
    width: 100%;
    padding: 6px 8px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 3px;
    font-size: 13px;
    outline: none;
  }
  .popover input:focus { border-color: var(--vscode-focusBorder, #007acc); }
  .popover .pop-actions {
    display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end;
  }
  .popover button {
    padding: 4px 12px; border-radius: 3px; cursor: pointer;
    font-size: 12px; border: none;
  }
  .popover .btn-save {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .popover .btn-cancel {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, #444);
  }
  .popover .btn-clear {
    background: transparent;
    color: var(--vscode-errorForeground, #f48771);
    border: 1px solid var(--vscode-panel-border, #444);
    margin-right: auto;
  }
  .popover .pop-arrow {
    position: absolute; top: -6px; left: 16px;
    width: 10px; height: 10px;
    background: var(--vscode-editorWidget-background, #252526);
    border-left: 1px solid var(--vscode-focusBorder, #007acc);
    border-top: 1px solid var(--vscode-focusBorder, #007acc);
    transform: rotate(45deg);
  }

  /* ── variable panel ── */
  .var-panel {
    position: sticky; top: 52px; z-index: 9;
    padding: 8px 20px;
    background: var(--vscode-editorWidget-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    font-size: 12px;
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  }
  .var-panel .label { opacity: .7; margin-right: 4px; }
  .var-panel .chip {
    padding: 2px 8px; border-radius: 3px; cursor: pointer;
    color: #1a1a1a; font-weight: 600;
  }
  .var-panel .chip:hover { opacity: .8; }
  .var-panel .reset {
    margin-left: auto; padding: 3px 10px; border-radius: 3px; cursor: pointer;
    background: transparent; border: 1px solid var(--vscode-panel-border, #444);
    color: var(--vscode-foreground); font-size: 11px;
  }
  .var-panel .reset:hover { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>

<div class="topbar">
  <div class="meta">
    <h2>${esc(name)}</h2>
    <span>${esc(filePath)} &nbsp;·&nbsp; ${sizeStr}</span>
  </div>
  <div class="view-toggle" role="group" aria-label="Preview mode">
    <button id="btnRendered" class="active" onclick="switchView('rendered')">Rendered</button>
    <button id="btnRaw" onclick="switchView('raw')">Raw</button>
  </div>
  <button class="btn-import" id="btnImport" onclick="importFile()">
    <svg viewBox="0 0 16 16"><path d="M7 1v8.586L4.707 7.293a1 1 0 0 0-1.414 1.414l4 4a1 1 0 0 0 1.414 0l4-4a1 1 0 0 0-1.414-1.414L9 9.586V1a1 1 0 0 0-2 0zm-5 13a1 1 0 0 0 0 2h12a1 1 0 0 0 0-2H2z"/></svg>
    Import to Workspace
  </button>
</div>

${variables.length > 0 ? `
<div class="var-panel">
  <span class="label">Variables (klik untuk edit):</span>
  ${variables.map((v, i) =>
    `<span class="chip var-c${i}" data-var="${v}" title="Edit ${v}">${v}</span>`
  ).join('')}
  <button class="reset" onclick="resetVars()">Reset</button>
</div>` : ''}

<div class="md" id="renderedView">${rendered}</div>
<pre class="raw" id="rawView">${esc(content)}</pre>

<div class="popover" id="popover">
  <div class="pop-arrow"></div>
  <div class="pop-label">Edit <span class="pop-name" id="popName"></span></div>
  <input type="text" id="popInput" placeholder="Masukkan nilai..." />
  <div class="pop-actions">
    <button class="btn-clear" onclick="clearVar()">Clear</button>
    <button class="btn-cancel" onclick="hidePopover()">Cancel</button>
    <button class="btn-save" onclick="saveVar()">Save</button>
  </div>
</div>

<script>
  const vscode       = acquireVsCodeApi();
  const ORIGINAL     = ${rawJson};
  const replacements = {};
  let activeVar = null;

  const popover      = document.getElementById('popover');
  const popName      = document.getElementById('popName');
  const popInput     = document.getElementById('popInput');
  const renderedView = document.getElementById('renderedView');
  const rawView      = document.getElementById('rawView');
  const btnRendered  = document.getElementById('btnRendered');
  const btnRaw       = document.getElementById('btnRaw');

  function switchView(mode) {
    if (mode === 'raw') {
      renderedView.classList.add('hide');
      rawView.classList.add('show');
      btnRendered.classList.remove('active');
      btnRaw.classList.add('active');
      hidePopover();
      return;
    }
    renderedView.classList.remove('hide');
    rawView.classList.remove('show');
    btnRendered.classList.add('active');
    btnRaw.classList.remove('active');
  }

  function showPopover(name, anchorEl) {
    activeVar = name;
    popName.textContent = '{{' + name + '}}';
    popInput.value = replacements[name] || '';

    const rect = anchorEl.getBoundingClientRect();
    const scrollY = window.scrollY || window.pageYOffset;
    const scrollX = window.scrollX || window.pageXOffset;

    popover.classList.add('show');
    // ukur dulu agar tidak keluar viewport
    const popW = popover.offsetWidth;
    const vw   = window.innerWidth;
    let left = rect.left + scrollX;
    if (left + popW > vw - 12) left = vw - popW - 12;
    if (left < 12) left = 12;

    popover.style.top  = (rect.bottom + scrollY + 8) + 'px';
    popover.style.left = left + 'px';

    setTimeout(() => popInput.focus(), 0);
    popInput.select();
  }

  function hidePopover() {
    popover.classList.remove('show');
    activeVar = null;
  }

  function saveVar() {
    if (!activeVar) return;
    const val = popInput.value;
    if (val === '') {
      delete replacements[activeVar];
    } else {
      replacements[activeVar] = val;
    }
    applyReplacements();
    hidePopover();
  }

  function clearVar() {
    if (!activeVar) return;
    delete replacements[activeVar];
    applyReplacements();
    hidePopover();
  }

  function resetVars() {
    for (const k of Object.keys(replacements)) delete replacements[k];
    applyReplacements();
    hidePopover();
  }

  function applyReplacements() {
    document.querySelectorAll('.var').forEach(el => {
      const name = el.dataset.var;
      if (replacements[name] !== undefined) {
        el.textContent = replacements[name];
        el.classList.add('edited');
      } else {
        el.textContent = '{{' + name + '}}';
        el.classList.remove('edited');
      }
    });
  }

  function getFinalContent() {
    let out = ORIGINAL;
    for (const [k, v] of Object.entries(replacements)) {
      out = out.split('{{' + k + '}}').join(v);
    }
    return out;
  }

  function importFile() {
    const btn = document.getElementById('btnImport');
    const original = btn.innerHTML;
    btn.textContent = 'Importing...';
    btn.disabled = true;
    vscode.postMessage({ command: 'import', content: getFinalContent() });
    setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 2000);
  }

  // klik variable di body atau chip di panel
  document.addEventListener('click', e => {
    const el = e.target.closest('.var, .chip');
    if (el && el.dataset.var) {
      e.stopPropagation();
      showPopover(el.dataset.var, el);
      return;
    }
    // klik di luar popover → tutup
    if (popover.classList.contains('show') && !popover.contains(e.target)) {
      hidePopover();
    }
  });

  // keyboard: Enter save, Esc cancel
  popInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveVar(); }
    else if (e.key === 'Escape') { e.preventDefault(); hidePopover(); }
  });
</script>
</body>
</html>`;
}

// ─── Variable highlighting ────────────────────────────────────────────────────

const HIGHLIGHT_PALETTE = [
  "#fff59d", // soft yellow
  "#ffcc80", // soft orange
  "#f8bbd0", // soft pink
  "#c8e6c9", // soft green
  "#bbdefb", // soft blue
  "#e1bee7", // soft purple
  "#ffab91", // soft peach
  "#b2ebf2", // soft cyan
  "#f0f4c3", // soft lime
  "#ffe0b2", // soft cream
  "#d7ccc8", // soft brown
  "#cfd8dc", // soft grey
];

function extractVariables(content: string): string[] {
  const re = /\{\{([A-Za-z0-9_\-\.]+)\}\}/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    seen.add(m[1]);
  }
  return [...seen];
}

function buildVarCss(variables: string[]): string {
  if (variables.length === 0) return "";
  if (variables.length === 1) {
    return `.var-c0, .chip.var-c0 { background: ${HIGHLIGHT_PALETTE[0]}; }`;
  }
  return variables.map((_, i) => {
    const color = HIGHLIGHT_PALETTE[i % HIGHLIGHT_PALETTE.length];
    return `.var-c${i}, .chip.var-c${i} { background: ${color}; }`;
  }).join("\n  ");
}

// ─── Minimal markdown → HTML renderer ────────────────────────────────────────

function safeRenderMarkdown(md: string, variables: string[] = []): string {
  try {
    return renderMarkdown(md, variables);
  } catch {
    return `<p><em>Rendered preview gagal. Silakan gunakan mode Raw.</em></p><pre><code>${esc(md)}</code></pre>`;
  }
}

function renderMarkdown(md: string, variables: string[] = []): string {
  let html = esc(md);

  // code blocks
  html = html.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${code.trimEnd()}</code></pre>`);

  // inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // headings
  html = html.replace(/^######\s(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s(.+)$/gm,  '<h5>$1</h5>');
  html = html.replace(/^####\s(.+)$/gm,   '<h4>$1</h4>');
  html = html.replace(/^###\s(.+)$/gm,    '<h3>$1</h3>');
  html = html.replace(/^##\s(.+)$/gm,     '<h2>$1</h2>');
  html = html.replace(/^#\s(.+)$/gm,      '<h1>$1</h1>');

  // hr
  html = html.replace(/^---+$/gm, '<hr>');

  // blockquote
  html = html.replace(/^&gt;\s(.+)$/gm, '<blockquote>$1</blockquote>');

  // bold / italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g,         '<em>$1</em>');

  // links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // unordered list
  html = html.replace(/((?:^[-*]\s.+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n')
      .map(l => `<li>${l.replace(/^[-*]\s/, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // ordered list
  html = html.replace(/((?:^\d+\.\s.+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n')
      .map(l => `<li>${l.replace(/^\d+\.\s/, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // tables
  html = html.replace(/((?:^\|.+\|\n?)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(r => !/^\|[-| :]+\|$/.test(r.trim()));
    const [head, ...body] = rows;
    const thCells = head.split('|').filter(Boolean).map(c => `<th>${c.trim()}</th>`).join('');
    const tdRows  = body.map(r =>
      `<tr>${r.split('|').filter(Boolean).map(c => `<td>${c.trim()}</td>`).join('')}</tr>`
    ).join('');
    return `<table><thead><tr>${thCells}</tr></thead><tbody>${tdRows}</tbody></table>`;
  });

  // paragraphs (double newline)
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = `<p>${html}</p>`;

  // single newline → <br> inside paragraphs
  html = html.replace(/(?<!>)\n(?!<)/g, '<br>');

  // wrap {{VARIABLES}} dengan span warna-warni
  if (variables.length > 0) {
    const idx = new Map(variables.map((v, i) => [v, i]));
    html = html.replace(/\{\{([A-Za-z0-9_\-\.]+)\}\}/g, (full, name) => {
      const i = idx.get(name);
      if (i === undefined) return full;
      return `<span class="var var-c${i}" data-var="${name}">{{${name}}}</span>`;
    });
  }

  return html;
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function deactivate() {}
