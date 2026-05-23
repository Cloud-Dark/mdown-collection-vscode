const express = require("express");
const cors = require("cors");
const { Octokit } = require("@octokit/rest");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3456;

// ─── Octokit instance ─────────────────────────────────────────────────────────
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const OWNER  = process.env.GITHUB_OWNER;
const REPO   = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || "main";

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// optional: simple API key auth biar gak sembarang orang akses
app.use((req, res, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next(); // skip kalau API_KEY tidak di-set

  const provided = req.headers["x-api-key"];
  if (provided !== apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /files?path=docs
 * List semua file .md di folder tertentu (recursive optional)
 */
app.get("/files", async (req, res) => {
  const rawPath = req.query.path;
  const folderPath = (!rawPath || rawPath === "docs") ? "" : rawPath;
  const recursive  = req.query.recursive === "true";

  try {
    const files = await getFiles(folderPath, recursive);
    res.json({
      success: true,
      repo: `${OWNER}/${REPO}`,
      branch: BRANCH,
      path: folderPath,
      count: files.length,
      files,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /file?path=docs/setup.md
 * Download raw content satu file
 */
app.get("/file", async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: "path required" });

  try {
    const { data } = await octokit.repos.getContent({
      owner: OWNER,
      repo: REPO,
      path: filePath,
      ref: BRANCH,
    });

    if (data.type !== "file") {
      return res.status(400).json({ error: "Path bukan file" });
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");

    res.json({
      success: true,
      name: data.name,
      path: data.path,
      sha: data.sha,
      size: data.size,
      content,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /health
 * Health check + info koneksi
 */
app.get("/health", async (req, res) => {
  try {
    await octokit.repos.get({ owner: OWNER, repo: REPO });
    res.json({
      status: "ok",
      repo: `${OWNER}/${REPO}`,
      branch: BRANCH,
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Rekursif ambil semua file .md dari folder
 */
async function getFiles(folderPath, recursive = false) {
  const { data } = await octokit.repos.getContent({
    owner: OWNER,
    repo: REPO,
    path: folderPath,
    ref: BRANCH,
  });

  const results = [];

  for (const item of data) {
    if (item.type === "file" && isDocFile(item.name)) {
      results.push({
        name: item.name,
        path: item.path,
        size: item.size,
        sha: item.sha,
        download_url: item.download_url,
      });
    } else if (item.type === "dir" && recursive) {
      const subFiles = await getFiles(item.path, true);
      results.push(...subFiles);
    }
  }

  return results;
}

function isDocFile(name) {
  return /\.(md|mdx|txt|rst)$/i.test(name);
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Doc Bridge running at http://localhost:${PORT}`);
  console.log(`   Repo: ${OWNER}/${REPO} (${BRANCH})`);
});
