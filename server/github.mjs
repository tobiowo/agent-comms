import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function getGithubConfig(baseDir) {
  const envRepo = process.env.AGENT_COMMS_GH_REPO;
  const envIssue = process.env.AGENT_COMMS_GH_ISSUE;
  const envAuthors = process.env.AGENT_COMMS_GH_ALLOWED_AUTHORS;
  if (envRepo && envIssue) {
    const owner = envRepo.split("/")[0].toLowerCase();
    const allowedAuthors = envAuthors
      ? envAuthors.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [owner];
    return { repo: envRepo, issueNumber: Number(envIssue), allowedAuthors };
  }
  const cfg = readJsonSafe(path.join(baseDir, "github.json"), null);
  if (cfg?.repo && cfg?.issueNumber) {
    const repo = String(cfg.repo);
    const owner = repo.split("/")[0].toLowerCase();
    const allowedAuthors = Array.isArray(cfg.allowedAuthors) && cfg.allowedAuthors.length
      ? cfg.allowedAuthors.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
      : [owner];
    return { repo, issueNumber: Number(cfg.issueNumber), allowedAuthors };
  }
  return null;
}

export function configureGithub({ repo, issueNumber, allowedAuthors = null }, baseDir) {
  if (!repo || !String(repo).includes("/")) {
    throw new Error("repo must be in 'owner/name' format");
  }
  const num = Number(issueNumber);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error("issueNumber must be a positive integer");
  }
  const cleanRepo = String(repo).trim();
  const owner = cleanRepo.split("/")[0].toLowerCase();
  const cleanAuthors =
    Array.isArray(allowedAuthors) && allowedAuthors.length
      ? Array.from(new Set(allowedAuthors.map((s) => String(s).trim().toLowerCase()).filter(Boolean)))
      : [owner];
  const cfg = {
    repo: cleanRepo,
    issueNumber: num,
    allowedAuthors: cleanAuthors,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(baseDir, "github.json"), cfg);
  return cfg;
}

export function isAuthorAllowed(login, allowedAuthors) {
  if (!Array.isArray(allowedAuthors) || allowedAuthors.length === 0) return false;
  if (allowedAuthors.includes("*")) return true;
  if (!login) return false;
  return allowedAuthors.includes(String(login).trim().toLowerCase());
}

function ghApi(args) {
  const out = execFileSync("gh", ["api", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return JSON.parse(out);
}

function parseCommentMetadata(body, fallbackUser) {
  const match = String(body || "").match(/<!--\s*agent-comms:\s*(\{[\s\S]*?\})\s*-->/);
  if (match) {
    try {
      const meta = JSON.parse(match[1]);
      const cleanBody = String(body)
        .replace(match[0], "")
        .replace(/^\*\*From:\*\*[^\n]*\n+/i, "")
        .replace(/\n*Posted by:\s*[^\n]+\s*$/i, "")
        .trim();
      return {
        from: meta.from || fallbackUser || "github",
        to: meta.to || "all",
        subject: meta.subject || "",
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        replyTo: meta.replyTo || null,
        localId: meta.id || null,
        body: cleanBody || String(body).trim(),
      };
    } catch {
      // fall through to plain parsing
    }
  }
  const postedMatch = String(body || "").match(/Posted by:\s*([A-Za-z0-9._ -]+)/i);
  const sender = postedMatch
    ? postedMatch[1].trim().toLowerCase().replace(/\s+/g, "-")
    : fallbackUser || "cloud";
  return {
    from: sender,
    to: "all",
    subject: "",
    tags: ["github"],
    replyTo: null,
    localId: null,
    body: String(body || "").trim(),
  };
}

export function pushToGithub(msg, baseDir) {
  const cfg = getGithubConfig(baseDir);
  if (!cfg) {
    return { ok: false, skipped: true, reason: "github_not_configured" };
  }
  const meta = {
    id: msg.id,
    from: msg.from,
    to: msg.to,
    subject: msg.subject || "",
    tags: msg.tags || [],
    replyTo: msg.replyTo || null,
  };
  const header = `**From:** \`${msg.from}\` → **To:** \`${msg.to}\`${msg.subject ? ` — *${msg.subject}*` : ""}`;
  const tagLine = msg.tags?.length ? `\n\n_Tags: ${msg.tags.join(", ")}_` : "";
  const commentBody = `<!-- agent-comms: ${JSON.stringify(meta)} -->\n${header}\n\n${msg.body}${tagLine}\n\nPosted by: ${msg.from}`;

  try {
    const created = ghApi([
      `repos/${cfg.repo}/issues/${cfg.issueNumber}/comments`,
      "-X",
      "POST",
      "-f",
      `body=${commentBody}`,
    ]);
    const seenPath = path.join(baseDir, "github-seen.json");
    const seen = readJsonSafe(seenPath, { commentIds: [], lastSyncAt: null });
    const set = new Set(Array.isArray(seen.commentIds) ? seen.commentIds : []);
    if (created?.id) set.add(Number(created.id));
    writeJsonAtomic(seenPath, {
      ...seen,
      commentIds: Array.from(set).slice(-2000),
    });
    return { ok: true, commentId: created?.id, url: created?.html_url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function syncFromGithub({ force = false, limit = 100 } = {}, baseDir) {
  const cfg = getGithubConfig(baseDir);
  if (!cfg) {
    return { ok: false, skipped: true, reason: "github_not_configured", imported: 0 };
  }

  const seenPath = path.join(baseDir, "github-seen.json");
  const seen = readJsonSafe(seenPath, { commentIds: [], lastSyncAt: null });
  if (!force && seen.lastSyncAt) {
    const elapsedMs = Date.now() - Date.parse(seen.lastSyncAt);
    if (Number.isFinite(elapsedMs) && elapsedMs < 30_000) {
      return { ok: true, cached: true, imported: 0 };
    }
  }

  try {
    const sinceParam = seen.lastCommentAt
      ? `&since=${encodeURIComponent(new Date(Date.parse(seen.lastCommentAt) - 60_000).toISOString())}`
      : "";
    const pages = ghApi([
      "--paginate",
      "--slurp",
      `repos/${cfg.repo}/issues/${cfg.issueNumber}/comments?per_page=${Math.max(1, Math.min(Number(limit) || 100, 100))}${sinceParam}`,
    ]);
    const comments = Array.isArray(pages) ? pages.flat() : [];
    const seenSet = new Set(Array.isArray(seen.commentIds) ? seen.commentIds : []);
    const msgDir = path.join(baseDir, "messages");
    fs.mkdirSync(msgDir, { recursive: true });
    let imported = 0;
    let skippedUntrusted = 0;
    let maxCreatedAt = seen.lastCommentAt || null;

    for (const c of comments) {
      const createdAt = c.created_at || new Date().toISOString();
      if (!maxCreatedAt || createdAt > maxCreatedAt) maxCreatedAt = createdAt;
      const cid = Number(c.id);
      if (!cid || seenSet.has(cid)) continue;
      seenSet.add(cid);

      if (!isAuthorAllowed(c.user?.login, cfg.allowedAuthors)) {
        skippedUntrusted++;
        continue;
      }

      const parsed = parseCommentMetadata(c.body, c.user?.login);
      if (!parsed.body) continue;
      if (parsed.localId && fs.existsSync(path.join(msgDir, `${parsed.localId}.json`))) {
        continue;
      }

      const stamp = createdAt.replace(/[:.]/g, "-");
      const id = `${stamp}-gh-${cid}`;
      const msg = {
        id,
        from: String(parsed.from).toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
        to:
          parsed.to === "all" || parsed.to === "*"
            ? "all"
            : String(parsed.to).toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
        subject: parsed.subject,
        body: parsed.body,
        tags: Array.from(new Set([...(parsed.tags || []), "github"])),
        replyTo: parsed.replyTo,
        createdAt,
        githubCommentId: cid,
        githubUrl: c.html_url || null,
      };
      writeJsonAtomic(path.join(msgDir, `${id}.json`), msg);
      imported++;
    }

    writeJsonAtomic(seenPath, {
      commentIds: Array.from(seenSet).slice(-2000),
      lastSyncAt: new Date().toISOString(),
      lastCommentAt: maxCreatedAt,
    });
    return { ok: true, repo: cfg.repo, issueNumber: cfg.issueNumber, imported, skippedUntrusted };
  } catch (err) {
    return { ok: false, error: err.message, imported: 0 };
  }
}
