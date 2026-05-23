import * as vscode from "vscode";

const GITHUB_OWNER = "Cloud-Dark";
const GITHUB_REPO  = "mdown-collection";
const GITHUB_BRANCH = "main";
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

export interface DocFile {
  name: string;
  path: string;
  size: number;
  sha: string;
  download_url: string;
}

export interface FileContentResponse {
  success: boolean;
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string;
}

interface GitHubContentItem {
  type: "file" | "dir";
  name: string;
  path: string;
  size: number;
  sha: string;
  download_url: string;
  content?: string;
  encoding?: string;
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("docBridge");
  return {
    docsFolder: cfg.get<string>("docsFolder") || "",
    recursive: cfg.get<boolean>("recursive") ?? true,
    saveFolder: cfg.get<string>("saveFolder") || "",
  };
}

function isDocFile(name: string): boolean {
  return /\.(md|mdx|txt|rst)$/i.test(name);
}

async function githubGet(path: string): Promise<Response> {
  const res = await fetch(path, {
    headers: {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json() as { message?: string };
      if (err.message) msg = err.message;
    } catch {
      // ignore parse errors
    }
    throw new Error(msg);
  }

  return res;
}

export async function fetchFileList(): Promise<DocFile[]> {
  const { docsFolder, recursive } = getConfig();
  const folder = (!docsFolder || docsFolder === "docs") ? "" : docsFolder;

  if (recursive) {
    return getFilesRecursive(folder);
  }

  const url = `${GITHUB_API_BASE}/contents/${encodeURIComponent(folder)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const res = await githubGet(url);
  const data = await res.json() as GitHubContentItem[];

  return data
    .filter(item => item.type === "file" && isDocFile(item.name))
    .map(item => ({
      name: item.name,
      path: item.path,
      size: item.size,
      sha: item.sha,
      download_url: item.download_url,
    }));
}

async function getFilesRecursive(folderPath: string): Promise<DocFile[]> {
  const pathPart = folderPath ? `/${folderPath.split("/").map(encodeURIComponent).join("/")}` : "";
  const url = `${GITHUB_API_BASE}/contents${pathPart}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const res = await githubGet(url);
  const data = await res.json() as GitHubContentItem[] | GitHubContentItem;

  const items = Array.isArray(data) ? data : [data];
  const out: DocFile[] = [];

  for (const item of items) {
    if (item.type === "file" && isDocFile(item.name)) {
      out.push({
        name: item.name,
        path: item.path,
        size: item.size,
        sha: item.sha,
        download_url: item.download_url,
      });
    } else if (item.type === "dir") {
      const children = await getFilesRecursive(item.path);
      out.push(...children);
    }
  }

  return out;
}

export async function fetchFileContent(filePath: string): Promise<FileContentResponse> {
  const pathPart = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `${GITHUB_API_BASE}/contents/${pathPart}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

  const res = await githubGet(url);
  const data = await res.json() as GitHubContentItem;

  if (data.type !== "file") {
    throw new Error("Path bukan file");
  }

  if (!data.content || data.encoding !== "base64") {
    throw new Error("Konten file tidak tersedia");
  }

  const normalized = data.content.replace(/\n/g, "");
  const content = Buffer.from(normalized, "base64").toString("utf-8");

  return {
    success: true,
    name: data.name,
    path: data.path,
    sha: data.sha,
    size: data.size,
    content,
  };
}

export async function checkHealth(): Promise<boolean> {
  try {
    const url = `${GITHUB_API_BASE}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const res = await githubGet(url);
    return res.ok;
  } catch {
    return false;
  }
}

export function getSaveFolder(): string {
  return getConfig().saveFolder;
}
