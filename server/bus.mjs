import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pushToGithub, syncFromGithub } from "./github.mjs";

export const DEFAULT_COMMS_DIR =
  process.env.AGENT_COMMS_DIR || path.join(os.homedir(), ".agent-comms");

const CLOUD_RECIPIENTS = new Set(["cowork", "claude-code-cloud", "cloud"]);
const URGENT_TAGS = new Set(["urgent", "red-main", "emergency"]);
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype", ".", ".."]);
const DEFAULT_ARCHIVE_HOURS = 72;
const MAX_ID_LENGTH = 64;

export function resolveBusDir(
  baseDir = DEFAULT_COMMS_DIR,
  channel = process.env.AGENT_COMMS_CHANNEL || ""
) {
  const raw = typeof channel === "string" ? channel.trim().toLowerCase() : "";
  if (!raw || raw === "default" || raw === "world") {
    return baseDir;
  }
  const clean = sanitizeId(raw, "channel");
  return path.join(baseDir, "channels", clean);
}

export function listChannels(baseDir = DEFAULT_COMMS_DIR) {
  const channels = ["default"];
  const channelsDir = path.join(baseDir, "channels");
  if (fs.existsSync(channelsDir)) {
    for (const entry of fs.readdirSync(channelsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) channels.push(entry.name);
    }
  }
  return channels.sort();
}

function sanitizeId(id, label = "agentId") {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const trimmed = id.trim().toLowerCase();
  if (trimmed.includes("..")) {
    throw new Error(`${label} must not contain '..'`);
  }
  const clean = trimmed
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!clean || RESERVED_IDS.has(clean)) {
    throw new Error(`${label} '${id}' is invalid`);
  }
  if (clean.length > MAX_ID_LENGTH) {
    throw new Error(`${label} must be at most ${MAX_ID_LENGTH} characters`);
  }
  return clean;
}

function normalizeWorkspace(p) {
  if (!p) return "";
  return String(p).trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function ensureLayout(baseDir = DEFAULT_COMMS_DIR) {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  for (const sub of ["agents", "messages", "acks", "locks", "artifacts", "barriers"]) {
    fs.mkdirSync(path.join(baseDir, sub), { recursive: true, mode: 0o700 });
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

// --- Agents ---

export function registerAgent(
  { agentId, runtime, workspace, note, status } = {},
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  const id = sanitizeId(agentId);
  const now = new Date().toISOString();
  const agentPath = path.join(baseDir, "agents", `${id}.json`);
  const existing = readJsonSafe(agentPath, null);

  let warning = null;
  if (existing && workspace) {
    const existingWs = normalizeWorkspace(existing.workspace);
    const incomingWs = normalizeWorkspace(workspace);
    const lastMs = Date.parse(existing.lastSeen || existing.registeredAt || 0);
    const recentlyActive =
      existing.status !== "offline" &&
      Number.isFinite(lastMs) &&
      Date.now() - lastMs < 120 * 60 * 1000;
    if (recentlyActive && existingWs && incomingWs && existingWs !== incomingWs) {
      warning = `Agent '${id}' was recently active in a different workspace (${existing.workspace}). Prefer a unique <runtime>-<short-id> name (e.g. '${id}-2') to avoid clobbering another live session.`;
    }
  }

  const record = {
    agentId: id,
    runtime:
      runtime !== undefined && String(runtime).trim()
        ? String(runtime).trim()
        : existing?.runtime || "unknown",
    workspace:
      workspace !== undefined ? String(workspace) : existing?.workspace || "",
    note: note !== undefined ? String(note) : existing?.note || "",
    status:
      status !== undefined && String(status).trim()
        ? String(status).trim()
        : existing?.status || "active",
    registeredAt: existing?.registeredAt || now,
    lastSeen: now,
  };
  writeJsonAtomic(agentPath, record);
  return warning ? { ...record, warning } : record;
}

export function touchAgent(agentId, baseDir = DEFAULT_COMMS_DIR, { status } = {}) {
  const id = sanitizeId(agentId);
  const agentPath = path.join(baseDir, "agents", `${id}.json`);
  const existing = readJsonSafe(agentPath, null);
  if (!existing) return null;
  existing.lastSeen = new Date().toISOString();
  if (status) existing.status = String(status);
  writeJsonAtomic(agentPath, existing);
  return existing;
}

export function unregisterAgent({ agentId }, baseDir = DEFAULT_COMMS_DIR) {
  ensureLayout(baseDir);
  const id = sanitizeId(agentId);
  const agentPath = path.join(baseDir, "agents", `${id}.json`);
  if (!fs.existsSync(agentPath)) {
    return { agentId: id, removed: false };
  }
  fs.unlinkSync(agentPath);
  return { agentId: id, removed: true };
}

export function renameAgent({ fromId, toId, force = false }, baseDir = DEFAULT_COMMS_DIR) {
  ensureLayout(baseDir);
  const oldId = sanitizeId(fromId, "fromId");
  const newId = sanitizeId(toId, "toId");
  if (oldId === newId) {
    throw new Error("fromId and toId must be different");
  }
  const oldPath = path.join(baseDir, "agents", `${oldId}.json`);
  const newPath = path.join(baseDir, "agents", `${newId}.json`);
  const existingOld = readJsonSafe(oldPath, null);
  if (!existingOld) {
    throw new Error(`Agent '${oldId}' is not registered`);
  }
  if (!force && fs.existsSync(newPath)) {
    throw new Error(`Agent '${newId}' is already registered (pass force: true to overwrite)`);
  }
  const now = new Date().toISOString();
  const updated = { ...existingOld, agentId: newId, lastSeen: now };
  writeJsonAtomic(newPath, updated);
  fs.unlinkSync(oldPath);

  const oldAckPath = path.join(baseDir, "acks", `${oldId}.json`);
  const newAckPath = path.join(baseDir, "acks", `${newId}.json`);
  const oldAcks = readJsonSafe(oldAckPath, null);
  if (oldAcks) {
    const newAcks = readJsonSafe(newAckPath, { agentId: newId, ackedIds: [], ackedBefore: null });
    const merged = Array.from(
      new Set([...(newAcks.ackedIds || []), ...(oldAcks.ackedIds || [])])
    ).slice(-2000);
    const ackedBefore =
      [newAcks.ackedBefore, oldAcks.ackedBefore].filter(Boolean).sort().pop() || null;
    writeJsonAtomic(newAckPath, { agentId: newId, ackedIds: merged, ackedBefore, updatedAt: now });
  }
  return { fromId: oldId, toId: newId, agent: updated };
}

export function listAgents(
  { includeStale = true, staleMinutes = 120 } = {},
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  const activeLocks = listLocks({ includeExpired: false }, baseDir);
  const locksByHolder = new Map();
  for (const lk of activeLocks) {
    if (!locksByHolder.has(lk.holder)) locksByHolder.set(lk.holder, []);
    locksByHolder.get(lk.holder).push(lk.resource);
  }

  const agentsDir = path.join(baseDir, "agents");
  const cutoffMs = Date.now() - staleMinutes * 60 * 1000;
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
  const agents = [];
  for (const file of files) {
    const rec = readJsonSafe(path.join(agentsDir, file));
    if (!rec) continue;
    const lastMs = Date.parse(rec.lastSeen || rec.registeredAt || 0);
    const isStale = Number.isFinite(lastMs) ? lastMs < cutoffMs : true;
    if (!includeStale && isStale) continue;
    agents.push({
      ...rec,
      locks: locksByHolder.get(rec.agentId) || [],
      isStale,
    });
  }
  agents.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  return agents;
}

// --- Atomic Resource / Issue Locks ---

export function acquireLock(
  { resource, holder, ttlMinutes = 60, note = "", force = false } = {},
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  const resId = sanitizeId(resource, "resource");
  const holderId = sanitizeId(holder, "holder");
  const ttlMs = Math.max(1, Number(ttlMinutes) || 60) * 60 * 1000;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const lockPath = path.join(baseDir, "locks", `${resId}.json`);

  const record = {
    resource: resId,
    holder: holderId,
    note: String(note || ""),
    acquiredAt: now.toISOString(),
    expiresAt,
  };

  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record, null, 2) + "\n", "utf8");
    } finally {
      fs.closeSync(fd);
    }
    touchAgent(holderId, baseDir, { status: "active" });
    return { ok: true, acquired: true, renewed: false, lock: record };
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }

  const existing = readJsonSafe(lockPath, null);
  const isExpired =
    !existing ||
    !existing.expiresAt ||
    Date.now() > Date.parse(existing.expiresAt);

  if (force || isExpired || existing?.holder === holderId) {
    const renewed = !isExpired && existing?.holder === holderId;
    const nextRecord = {
      ...record,
      acquiredAt: renewed ? existing.acquiredAt : record.acquiredAt,
    };
    writeJsonAtomic(lockPath, nextRecord);
    touchAgent(holderId, baseDir, { status: "active" });
    return {
      ok: true,
      acquired: true,
      renewed,
      replacedExpired: isExpired && !renewed,
      lock: nextRecord,
    };
  }

  return {
    ok: false,
    acquired: false,
    resource: resId,
    heldBy: existing,
  };
}

export function releaseLock(
  { resource, holder, force = false } = {},
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  const resId = sanitizeId(resource, "resource");
  const holderId = holder ? sanitizeId(holder, "holder") : null;
  const lockPath = path.join(baseDir, "locks", `${resId}.json`);
  const existing = readJsonSafe(lockPath, null);
  if (!existing) {
    return { ok: true, released: false, reason: "not_locked", resource: resId };
  }
  const isExpired =
    !existing.expiresAt || Date.now() > Date.parse(existing.expiresAt);
  if (!force && !isExpired && holderId && existing.holder !== holderId) {
    return {
      ok: false,
      released: false,
      reason: "held_by_another",
      resource: resId,
      heldBy: existing,
    };
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already removed
  }
  if (holderId) touchAgent(holderId, baseDir);
  return { ok: true, released: true, resource: resId, previousHolder: existing.holder };
}

export function listLocks({ includeExpired = false } = {}, baseDir = DEFAULT_COMMS_DIR) {
  ensureLayout(baseDir);
  const locksDir = path.join(baseDir, "locks");
  const files = fs.readdirSync(locksDir).filter((f) => f.endsWith(".json"));
  const locks = [];
  const nowMs = Date.now();
  for (const file of files) {
    const full = path.join(locksDir, file);
    const rec = readJsonSafe(full, null);
    if (!rec) continue;
    const expMs = Date.parse(rec.expiresAt || 0);
    const expired = !Number.isFinite(expMs) || nowMs > expMs;
    if (expired && !includeExpired) {
      try {
        fs.unlinkSync(full);
      } catch {
        // ignore race
      }
      continue;
    }
    locks.push({ ...rec, expired });
  }
  locks.sort((a, b) => a.resource.localeCompare(b.resource));
  return locks;
}

// --- Archiving / Retention ---

export function archiveOldMessages(
  { maxAgeHours = DEFAULT_ARCHIVE_HOURS, force = false } = {},
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  const statePath = path.join(baseDir, "archive-state.json");
  const state = readJsonSafe(statePath, { lastRunAt: null });
  if (!force && state.lastRunAt) {
    const elapsed = Date.now() - Date.parse(state.lastRunAt);
    if (Number.isFinite(elapsed) && elapsed < 60 * 60 * 1000) {
      return { skipped: true, archived: 0 };
    }
  }

  const cutoffMs =
    Date.now() - Math.max(1, Number(maxAgeHours) || DEFAULT_ARCHIVE_HOURS) * 3600 * 1000;
  const msgDir = path.join(baseDir, "messages");
  const files = fs.readdirSync(msgDir).filter((f) => f.endsWith(".json"));
  let archived = 0;

  for (const file of files) {
    const full = path.join(msgDir, file);
    const msg = readJsonSafe(full, null);
    if (!msg) continue;
    const ts = Date.parse(msg.createdAt || 0);
    if (!Number.isFinite(ts) || ts >= cutoffMs) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    const destDir = path.join(msgDir, "archive", day);
    fs.mkdirSync(destDir, { recursive: true });
    try {
      fs.renameSync(full, path.join(destDir, file));
      archived++;
    } catch {
      // ignore concurrent move
    }
  }

  writeJsonAtomic(statePath, { lastRunAt: new Date().toISOString(), lastArchived: archived });
  return { skipped: false, archived, maxAgeHours };
}

// --- Messaging ---

export function sendMessage(
  {
    from,
    to = "all",
    subject = "",
    body,
    tags = [],
    attachments = [],
    replyTo = null,
    relay = undefined,
  },
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  if (typeof body !== "string" || !body.trim()) {
    throw new Error("body must be a non-empty string");
  }
  const sender = sanitizeId(from, "from");
  const recipient = to === "all" || to === "*" ? "all" : sanitizeId(to, "to");
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const shortRand = crypto.randomBytes(3).toString("hex");
  const id = `${stamp}-${shortRand}`;
  const cleanAttachments = Array.isArray(attachments)
    ? attachments.map((a) => String(a).trim()).filter(Boolean)
    : [];
  const msg = {
    id,
    from: sender,
    to: recipient,
    subject: String(subject || ""),
    body: body.trim(),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    ...(cleanAttachments.length ? { attachments: cleanAttachments } : {}),
    replyTo: replyTo ? String(replyTo) : null,
    createdAt: now.toISOString(),
  };
  writeJsonAtomic(path.join(baseDir, "messages", `${id}.json`), msg);
  touchAgent(sender, baseDir);
  archiveOldMessages({}, baseDir);

  const shouldRelay =
    relay === true || (relay !== false && CLOUD_RECIPIENTS.has(recipient));
  if (shouldRelay) {
    const githubRelay = pushToGithub(msg, baseDir);
    return { ...msg, githubRelay };
  }
  return msg;
}

function getAckState(agentId, baseDir) {
  const ackPath = path.join(baseDir, "acks", `${agentId}.json`);
  const data = readJsonSafe(ackPath, { agentId, ackedIds: [], ackedBefore: null });
  return {
    ackedSet: new Set(Array.isArray(data.ackedIds) ? data.ackedIds : []),
    ackedBefore: data.ackedBefore || null,
  };
}

function hasUrgentTag(msg) {
  return Array.isArray(msg.tags) && msg.tags.some((t) => URGENT_TAGS.has(String(t).toLowerCase()));
}

export function readInbox(
  {
    agentId,
    from = null,
    tag = null,
    includeAcked = false,
    excludeSelf = false,
    directOnly = false,
    includeUrgent = true,
    limit = 50,
    syncGithub = true,
  } = {},
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  if (syncGithub) {
    syncFromGithub({ force: false }, baseDir);
  }
  const id = sanitizeId(agentId);
  touchAgent(id, baseDir);
  const { ackedSet, ackedBefore } = getAckState(id, baseDir);
  const msgDir = path.join(baseDir, "messages");
  const files = fs
    .readdirSync(msgDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const fromFilter = from ? sanitizeId(from, "from") : null;
  const results = [];
  for (const file of files) {
    const msg = readJsonSafe(path.join(msgDir, file));
    if (!msg) continue;
    const isDirect = msg.to === id;
    const isBroadcast = msg.to === "all";
    if (!isDirect && !isBroadcast) continue;
    if (directOnly && !isDirect && !(includeUrgent && hasUrgentTag(msg))) continue;
    if (excludeSelf && msg.from === id) continue;
    const isAcked =
      ackedSet.has(msg.id) ||
      Boolean(ackedBefore && msg.createdAt && msg.createdAt <= ackedBefore);
    if (!includeAcked && isAcked) continue;
    if (fromFilter && msg.from !== fromFilter) continue;
    if (tag && (!Array.isArray(msg.tags) || !msg.tags.includes(tag))) continue;
    results.push({ ...msg, acked: isAcked });
  }

  const max = Math.max(1, Math.min(Number(limit) || 50, 200));
  return results.slice(-max);
}

export function ackMessages(
  { agentId, messageIds = [], all = false, before = null } = {},
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  const id = sanitizeId(agentId);
  const ackPath = path.join(baseDir, "acks", `${id}.json`);
  const existing = readJsonSafe(ackPath, { agentId: id, ackedIds: [], ackedBefore: null });
  const now = new Date().toISOString();

  if (all || before) {
    const cursor = before ? new Date(before).toISOString() : now;
    const nextCursor =
      existing.ackedBefore && existing.ackedBefore > cursor ? existing.ackedBefore : cursor;
    const next = {
      agentId: id,
      ackedIds: [],
      ackedBefore: nextCursor,
      updatedAt: now,
    };
    writeJsonAtomic(ackPath, next);
    touchAgent(id, baseDir);
    return { agentId: id, ackedBefore: nextCursor, clearedIds: true };
  }

  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new Error("Provide messageIds (non-empty array), all: true, or before: <ISO>");
  }
  const set = new Set(Array.isArray(existing.ackedIds) ? existing.ackedIds : []);
  let added = 0;
  for (const mid of messageIds) {
    if (typeof mid === "string" && mid.trim() && !set.has(mid.trim())) {
      set.add(mid.trim());
      added++;
    }
  }
  const next = {
    agentId: id,
    ackedIds: Array.from(set).slice(-2000),
    ackedBefore: existing.ackedBefore || null,
    updatedAt: now,
  };
  writeJsonAtomic(ackPath, next);
  touchAgent(id, baseDir);
  return { agentId: id, newlyAcked: added, totalAcked: next.ackedIds.length };
}

// --- Barriers (MPI_Barrier-style wave synchronization) ---

export function createBarrier(
  { name, expected = [], expectedCount = null, notify = "all", createdBy = "coordinator", note = "", ttlMinutes = 180 } = {},
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  const barrierId = sanitizeId(name, "name");
  const expectedList = Array.isArray(expected)
    ? Array.from(new Set(expected.map((e) => sanitizeId(e, "expected"))))
    : [];
  const count =
    expectedList.length > 0
      ? expectedList.length
      : Math.max(1, Number(expectedCount) || 1);
  if (expectedList.length === 0 && (!expectedCount || Number(expectedCount) < 1)) {
    throw new Error("Provide either a non-empty 'expected' agentId array or 'expectedCount' >= 1");
  }
  const now = new Date();
  const ttlMs = Math.max(1, Number(ttlMinutes) || 180) * 60 * 1000;
  const record = {
    name: barrierId,
    createdBy: sanitizeId(createdBy, "createdBy"),
    expected: expectedList,
    expectedCount: count,
    notify: notify === "all" || notify === "*" ? "all" : sanitizeId(notify, "notify"),
    note: String(note || ""),
    arrived: {},
    released: false,
    releasedAt: null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  writeJsonAtomic(path.join(baseDir, "barriers", `${barrierId}.json`), record);
  return record;
}

export function checkinBarrier(
  { name, agentId, note = "" } = {},
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  const barrierId = sanitizeId(name, "name");
  const id = sanitizeId(agentId, "agentId");
  const barrierPath = path.join(baseDir, "barriers", `${barrierId}.json`);
  const record = readJsonSafe(barrierPath, null);
  if (!record) {
    throw new Error(`Barrier '${barrierId}' does not exist`);
  }

  const now = new Date().toISOString();
  record.arrived = record.arrived || {};
  record.arrived[id] = { at: now, note: String(note || "") };

  const arrivedIds = Object.keys(record.arrived);
  const remaining =
    record.expected.length > 0
      ? record.expected.filter((e) => !Object.hasOwn(record.arrived, e))
      : [];
  const isComplete =
    record.expected.length > 0
      ? remaining.length === 0
      : arrivedIds.length >= record.expectedCount;

  let notification = null;
  const justReleased = isComplete && !record.released;
  if (justReleased) {
    record.released = true;
    record.releasedAt = now;
  }

  writeJsonAtomic(barrierPath, record);
  touchAgent(id, baseDir);

  if (justReleased) {
    const summary = arrivedIds
      .map((a) => `${a}${record.arrived[a]?.note ? ` (${record.arrived[a].note})` : ""}`)
      .join(", ");
    notification = sendMessage(
      {
        from: id,
        to: record.notify,
        subject: `Barrier released: ${barrierId}`,
        body: `All expected agents checked in for barrier '${barrierId}' (${arrivedIds.length}/${record.expectedCount}): ${summary}.${record.note ? ` Note: ${record.note}` : ""}`,
        tags: ["barrier", "handoff"],
        relay: false,
      },
      baseDir
    );
  }

  return {
    barrier: record,
    justReleased,
    remaining,
    notification,
  };
}

export function listBarriers({ includeReleased = false, includeExpired = false } = {}, baseDir = DEFAULT_COMMS_DIR) {
  ensureLayout(baseDir);
  const dir = path.join(baseDir, "barriers");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const nowMs = Date.now();
  const barriers = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const rec = readJsonSafe(full, null);
    if (!rec) continue;
    const expMs = Date.parse(rec.expiresAt || 0);
    const expired = !Number.isFinite(expMs) || nowMs > expMs;
    if (expired && !includeExpired) {
      try {
        fs.unlinkSync(full);
      } catch {
        // ignore
      }
      continue;
    }
    if (rec.released && !includeReleased) continue;
    const arrivedIds = Object.keys(rec.arrived || {});
    const remaining =
      rec.expected?.length > 0
        ? rec.expected.filter((e) => !rec.arrived || !Object.hasOwn(rec.arrived, e))
        : [];
    barriers.push({ ...rec, expired, arrivedCount: arrivedIds.length, remaining });
  }
  barriers.sort((a, b) => a.name.localeCompare(b.name));
  return barriers;
}

// --- Unified Fleet Status ---

export function fleetStatus(
  { includeStale = false, staleMinutes = 120, recentLimit = 10 } = {},
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  archiveOldMessages({}, baseDir);
  const agents = listAgents({ includeStale, staleMinutes }, baseDir);
  const locks = listLocks({ includeExpired: false }, baseDir);
  const barriers = listBarriers({ includeReleased: false, includeExpired: false }, baseDir);

  const msgDir = path.join(baseDir, "messages");
  const files = fs
    .readdirSync(msgDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const recent = [];
  for (const file of files.slice(-Math.max(1, Math.min(Number(recentLimit) || 10, 50)))) {
    const m = readJsonSafe(path.join(msgDir, file));
    if (!m) continue;
    recent.push({
      id: m.id,
      createdAt: m.createdAt,
      from: m.from,
      to: m.to,
      subject: m.subject,
      tags: m.tags,
      attachments: m.attachments || undefined,
    });
  }

  return {
    busDir: baseDir,
    artifactsDir: path.join(baseDir, "artifacts"),
    activeMessageCount: files.length,
    agents,
    locks,
    barriers,
    recentMessages: recent,
  };
}

// --- Reactive Push Wait / Watch ---

export function waitForMessages(
  {
    agentId,
    from = null,
    tag = null,
    directOnly = false,
    includeUrgent = true,
    timeoutSeconds = 1800,
    pollIntervalMs = 5000,
    syncGithub = false,
    stream = false,
    onMessage = null,
  } = {},
  baseDir = DEFAULT_COMMS_DIR
) {
  ensureLayout(baseDir);
  const id = sanitizeId(agentId);
  const msgDir = path.join(baseDir, "messages");
  const emitted = new Set();

  const check = (doGithubSync = false) => {
    const msgs = readInbox(
      {
        agentId: id,
        from,
        tag,
        includeAcked: false,
        excludeSelf: true,
        directOnly,
        includeUrgent,
        limit: 50,
        syncGithub: doGithubSync,
      },
      baseDir
    );
    return msgs.filter((m) => !emitted.has(m.id));
  };

  return new Promise((resolve) => {
    const initial = check(syncGithub);
    if (initial.length > 0) {
      if (stream && onMessage) {
        for (const m of initial) {
          emitted.add(m.id);
          onMessage(m);
        }
      } else {
        resolve({ agentId: id, timedOut: false, messages: initial });
        return;
      }
    }

    let settled = false;
    let watcher = null;
    let pollTimer = null;
    let timeoutTimer = null;
    let lastGhCheck = Date.now();

    const cleanup = () => {
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        watcher = null;
      }
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };

    const triggerCheck = (allowGh = false) => {
      if (settled) return;
      const shouldGh = allowGh && syncGithub && Date.now() - lastGhCheck >= 30_000;
      if (shouldGh) lastGhCheck = Date.now();
      const found = check(shouldGh);
      if (found.length === 0) return;
      if (stream && onMessage) {
        for (const m of found) {
          emitted.add(m.id);
          onMessage(m);
        }
        return;
      }
      settled = true;
      cleanup();
      resolve({ agentId: id, timedOut: false, messages: found });
    };

    try {
      watcher = fs.watch(msgDir, { persistent: true }, () => {
        setTimeout(() => triggerCheck(false), 40);
      });
    } catch {
      // Fallback to polling timer below
    }

    pollTimer = setInterval(
      () => triggerCheck(true),
      Math.max(500, Number(pollIntervalMs) || 5000)
    );

    if (!stream && timeoutSeconds > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ agentId: id, timedOut: true, messages: [] });
      }, timeoutSeconds * 1000);
    }

    process.once("SIGINT", () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ agentId: id, timedOut: false, interrupted: true, messages: [] });
      }
    });
  });
}
