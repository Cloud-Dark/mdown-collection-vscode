import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { DocFileProvider, DocDragDropController, DocItem } from "./fileProvider";
import { fetchFileContent, checkHealth, getSaveFolder } from "./bridgeClient";

// track panel yang sedang terbuka agar tidak dobel
const openPanels = new Map<string, vscode.WebviewPanel>();

export async function activate(context: vscode.ExtensionContext) {
  console.log("Doc Bridge activated");

  const provider = new DocFileProvider();
  const dnd      = new DocDragDropController();

  const treeView = vscode.window.createTreeView("docBridge", {
    treeDataProvider: provider,
    dragAndDropController: dnd,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  function updateTitle() {
    const q = provider.getFilter();
    treeView.title = q ? `Doc Bridge  🔍 "${q}"` : "Doc Bridge";
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

  // ─── Search ──────────────────────────────────────────────────────────────
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

function errorHtml(msg: string): string {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;color:#f44">
    <p>Error: ${esc(msg)}</p>
  </body></html>`;
}

function previewHtml(name: string, filePath: string, size: number, content: string): string {
  const sizeStr   = size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
  const variables = extractVariables(content);
  const rendered  = renderMarkdown(content, variables);
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

<div class="md">${rendered}</div>

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

  const popover  = document.getElementById('popover');
  const popName  = document.getElementById('popName');
  const popInput = document.getElementById('popInput');

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
