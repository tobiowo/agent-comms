import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { configureGithub, getGithubConfig, isAuthorAllowed } from "../server/github.mjs";

import {
  ackMessages,
  acquireLock,
  archiveOldMessages,
  checkinBarrier,
  createBarrier,
  fleetStatus,
  listAgents,
  listBarriers,
  listChannels,
  listLocks,
  readInbox,
  registerAgent,
  releaseLock,
  renameAgent,
  resolveBusDir,
  sendMessage,
  unregisterAgent,
  waitForMessages,
} from "../server/bus.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_PATH = path.resolve(__dirname, "..", "server", "mcp.mjs");
const CLI_PATH = path.resolve(__dirname, "..", "server", "cli.mjs");

function makeTmpBus() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-comms-test-"));
}

test("registerAgent preserves fields on partial update and warns on workspace collision", () => {
  const dir = makeTmpBus();
  try {
    const first = registerAgent(
      { agentId: "worker-1", runtime: "claude-code", workspace: "/repo/a", note: "init" },
      dir
    );
    assert.equal(first.runtime, "claude-code");
    assert.equal(first.status, "active");

    const updated = registerAgent({ agentId: "worker-1", note: "working" }, dir);
    assert.equal(updated.runtime, "claude-code");
    assert.equal(updated.workspace, "/repo/a");
    assert.equal(updated.note, "working");
    assert.equal(updated.warning, undefined);

    const collided = registerAgent({ agentId: "worker-1", workspace: "/repo/b" }, dir);
    assert.match(collided.warning, /different workspace/i);

    const renamed = renameAgent({ fromId: "worker-1", toId: "worker-2" }, dir);
    assert.equal(renamed.toId, "worker-2");
    assert.equal(listAgents({}, dir).length, 1);

    const removed = unregisterAgent({ agentId: "worker-2" }, dir);
    assert.equal(removed.removed, true);
    assert.equal(listAgents({}, dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic TTL locks prevent double-claims, support renewal, and sync agent active status", () => {
  const dir = makeTmpBus();
  try {
    registerAgent({ agentId: "a", runtime: "antigravity", status: "idle" }, dir);
    registerAgent({ agentId: "b", runtime: "claude-code", status: "idle" }, dir);

    const acq = acquireLock({ resource: "gpu", holder: "a", ttlMinutes: 30, note: "train" }, dir);
    assert.equal(acq.ok, true);
    assert.equal(acq.acquired, true);

    // Agent A is auto-marked active and lists held lock
    const agentA = listAgents({}, dir).find((x) => x.agentId === "a");
    assert.equal(agentA.status, "active");
    assert.deepEqual(agentA.locks, ["gpu"]);

    // Agent B is blocked
    const blocked = acquireLock({ resource: "gpu", holder: "b" }, dir);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.heldBy.holder, "a");

    // Agent A renews cleanly
    const renewed = acquireLock({ resource: "gpu", holder: "a", ttlMinutes: 60 }, dir);
    assert.equal(renewed.ok, true);
    assert.equal(renewed.renewed, true);

    // Agent B cannot release A's lock without force
    const badRel = releaseLock({ resource: "gpu", holder: "b" }, dir);
    assert.equal(badRel.ok, false);

    // Agent A releases
    const rel = releaseLock({ resource: "gpu", holder: "a" }, dir);
    assert.equal(rel.ok, true);
    assert.equal(rel.released, true);
    assert.equal(listLocks({}, dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("messaging, directOnly + urgent bypass, attachments, cursor ack, and archiving", () => {
  const dir = makeTmpBus();
  try {
    sendMessage({ from: "coord", to: "all", subject: "fyi", body: "routine update" }, dir);
    sendMessage(
      { from: "coord", to: "all", subject: "broken", body: "main red", tags: ["red-main"] },
      dir
    );
    const dm = sendMessage(
      {
        from: "coord",
        to: "w1",
        subject: "task",
        body: "take #42",
        attachments: ["/tmp/shot.png"],
      },
      dir
    );
    assert.deepEqual(dm.attachments, ["/tmp/shot.png"]);

    // directOnly skips routine broadcast, keeps DM + red-main urgent broadcast
    const direct = readInbox({ agentId: "w1", directOnly: true, syncGithub: false }, dir);
    assert.equal(direct.length, 2);

    // strict direct (includeUrgent: false) keeps only DM
    const strict = readInbox(
      { agentId: "w1", directOnly: true, includeUrgent: false, syncGithub: false },
      dir
    );
    assert.equal(strict.length, 1);
    assert.equal(strict[0].id, dm.id);

    // Cursor ack clears all current messages
    const ack = ackMessages({ agentId: "w1", all: true }, dir);
    assert.equal(ack.clearedIds, true);
    assert.equal(readInbox({ agentId: "w1", syncGithub: false }, dir).length, 0);

    // fleetStatus returns unified view
    const st = fleetStatus({ includeStale: true }, dir);
    assert.equal(st.activeMessageCount, 3);
    assert.ok(st.artifactsDir.endsWith("artifacts"));

    // Archiving moves old messages into messages/archive/YYYY-MM-DD
    const oldFile = path.join(dir, "messages", "2020-01-01T00-00-00-000Z-old.json");
    fs.writeFileSync(
      oldFile,
      JSON.stringify({
        id: "2020-01-01T00-00-00-000Z-old",
        from: "a",
        to: "all",
        body: "old",
        createdAt: "2020-01-01T00:00:00.000Z",
      })
    );
    const arch = archiveOldMessages({ maxAgeHours: 24, force: true }, dir);
    assert.equal(arch.archived, 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(
      fs.existsSync(
        path.join(dir, "messages", "archive", "2020-01-01", "2020-01-01T00-00-00-000Z-old.json")
      ),
      true
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForMessages wakes reactively on direct message while ignoring routine broadcast", async () => {
  const dir = makeTmpBus();
  try {
    const waitPromise = waitForMessages(
      { agentId: "w1", directOnly: true, timeoutSeconds: 5, pollIntervalMs: 500 },
      dir
    );

    setTimeout(() => {
      sendMessage({ from: "other", to: "all", body: "noise" }, dir);
    }, 80);

    setTimeout(() => {
      sendMessage({ from: "coord", to: "w1", body: "wake up!" }, dir);
    }, 200);

    const res = await waitPromise;
    assert.equal(res.timedOut, false);
    assert.equal(res.messages.length, 1);
    assert.equal(res.messages[0].body, "wake up!");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("barriers release once all expected agents check in and wake notify target", async () => {
  const dir = makeTmpBus();
  try {
    createBarrier(
      { name: "wave-1", expected: ["w1", "w2"], notify: "coord", note: "ready to publish" },
      dir
    );
    assert.equal(listBarriers({}, dir).length, 1);

    const waitPromise = waitForMessages(
      { agentId: "coord", directOnly: true, timeoutSeconds: 5, pollIntervalMs: 500 },
      dir
    );

    const c1 = checkinBarrier({ name: "wave-1", agentId: "w1", note: "PR #1" }, dir);
    assert.equal(c1.justReleased, false);
    assert.deepEqual(c1.remaining, ["w2"]);

    const c2 = checkinBarrier({ name: "wave-1", agentId: "w2", note: "PR #2" }, dir);
    assert.equal(c2.justReleased, true);
    assert.deepEqual(c2.remaining, []);
    assert.ok(c2.notification);

    // Re-checking in is idempotent and does not double-notify
    const c3 = checkinBarrier({ name: "wave-1", agentId: "w2", note: "PR #2" }, dir);
    assert.equal(c3.justReleased, false);
    assert.equal(c3.notification, null);

    // Released barrier drops from default listBarriers
    assert.equal(listBarriers({}, dir).length, 0);
    assert.equal(listBarriers({ includeReleased: true }, dir).length, 1);

    // Coordinator woke up on the barrier release message
    const woke = await waitPromise;
    assert.equal(woke.timedOut, false);
    assert.equal(woke.messages.length, 1);
    assert.match(woke.messages[0].subject, /Barrier released: wave-1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("channels isolate agents, locks, and messages while keeping default channel backward-compatible", () => {
  const root = makeTmpBus();
  try {
    assert.equal(resolveBusDir(root, ""), root);
    assert.equal(resolveBusDir(root, "default"), root);

    const chB = resolveBusDir(root, "repo-b");
    assert.ok(chB.endsWith(path.join("channels", "repo-b")));

    registerAgent({ agentId: "w1", runtime: "claude-code" }, root);
    registerAgent({ agentId: "w2", runtime: "cursor" }, chB);
    acquireLock({ resource: "gpu", holder: "w1" }, root);
    acquireLock({ resource: "gpu", holder: "w2" }, chB);
    sendMessage({ from: "w1", to: "all", body: "default msg" }, root);
    sendMessage({ from: "w2", to: "all", body: "repo-b msg" }, chB);

    assert.deepEqual(
      listAgents({}, root).map((a) => a.agentId),
      ["w1"]
    );
    assert.deepEqual(
      listAgents({}, chB).map((a) => a.agentId),
      ["w2"]
    );
    assert.equal(readInbox({ agentId: "w1", syncGithub: false }, root).length, 1);
    assert.equal(readInbox({ agentId: "w2", syncGithub: false }, chB).length, 1);
    assert.deepEqual(listChannels(root), ["default", "repo-b"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP stdio server exposes all 15 tools and handles tool calls", async () => {
  const dir = makeTmpBus();
  try {
    const proc = spawn("node", [MCP_PATH], {
      env: { ...process.env, AGENT_COMMS_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = [];
    let buf = "";
    let resolveDone;
    const done = new Promise((r) => {
      resolveDone = r;
    });
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) {
          lines.push(JSON.parse(line));
          if (lines.some((l) => l.id === 2) && lines.some((l) => l.id === 3)) {
            resolveDone();
          }
        }
      }
    });

    const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "fleet_status", arguments: {} },
    });

    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
    proc.kill();

    const toolsResp = lines.find((l) => l.id === 2);
    assert.equal(toolsResp.result.tools.length, 15);
    const statusResp = JSON.parse(lines.find((l) => l.id === 3).result.content[0].text);
    assert.equal(statusResp.busDir, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI end-to-end with channels, locks, barriers, messaging, and GitHub config", () => {
  const dir = makeTmpBus();
  try {
    const env = { ...process.env, AGENT_COMMS_DIR: dir };
    const runCli = (args) =>
      JSON.parse(execFileSync("node", [CLI_PATH, ...args], { env, encoding: "utf8" }));

    const reg = runCli(["register", "--id", "w1", "--runtime", "cli", "--channel", "proj-x"]);
    assert.equal(reg.agentId, "w1");

    const lk = runCli(["lock", "--resource", "deploy", "--holder", "w1", "--channel", "proj-x"]);
    assert.equal(lk.acquired, true);

    runCli([
      "barrier-create",
      "--name",
      "release-1",
      "--expected",
      "w1",
      "--notify",
      "coord",
      "--channel",
      "proj-x",
    ]);
    const chk = runCli(["barrier-checkin", "--name", "release-1", "--id", "w1", "--channel", "proj-x"]);
    assert.equal(chk.justReleased, true);

    const inbox = runCli(["inbox", "--id", "coord", "--channel", "proj-x", "--no-sync"]);
    assert.equal(inbox.length, 1);
    assert.match(inbox[0].subject, /Barrier released: release-1/);

    const st = runCli(["status", "--channel", "proj-x"]);
    assert.equal(st.channel, "proj-x");
    assert.ok(st.channels.includes("proj-x"));

    const ghCfg = configureGithub({ repo: "owner/repo", issueNumber: 42 }, dir);
    assert.equal(ghCfg.issueNumber, 42);
    assert.deepEqual(getGithubConfig(dir), {
      repo: "owner/repo",
      issueNumber: 42,
      allowedAuthors: ["owner"],
    });
    assert.equal(isAuthorAllowed("Owner", ghCfg.allowedAuthors), true);
    assert.equal(isAuthorAllowed("stranger", ghCfg.allowedAuthors), false);

    const ghCustom = configureGithub(
      { repo: "owner/repo", issueNumber: 42, allowedAuthors: ["owner", "collab"] },
      dir
    );
    assert.equal(isAuthorAllowed("collab", ghCustom.allowedAuthors), true);
    assert.equal(isAuthorAllowed("stranger", ghCustom.allowedAuthors), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("security: rejects traversal IDs, reserved prototype keys, oversized IDs, and malformed GitHub repos", () => {
  const dir = makeTmpBus();
  try {
    assert.throws(() => resolveBusDir(dir, ".."), /\.\./);
    assert.throws(() => resolveBusDir(dir, "a/../b"), /\.\./);
    assert.throws(() => registerAgent({ agentId: "---" }, dir), /invalid/i);
    assert.throws(() => registerAgent({ agentId: "__proto__" }, dir), /invalid/i);
    assert.throws(() => registerAgent({ agentId: "constructor" }, dir), /invalid/i);
    assert.throws(() => registerAgent({ agentId: "a".repeat(65) }, dir), /at most 64/i);

    assert.throws(() => configureGithub({ repo: "owner/repo/extra", issueNumber: 1 }, dir), /owner\/name/);
    assert.throws(() => configureGithub({ repo: "owner/repo?x=1", issueNumber: 1 }, dir), /owner\/name/);
    assert.throws(() => configureGithub({ repo: "owner/..", issueNumber: 1 }, dir), /owner\/name/);

    // Barrier checks own properties, not Object.prototype
    createBarrier({ name: "proto-check", expected: ["tostring", "w1"], notify: "coord" }, dir);
    const res = checkinBarrier({ name: "proto-check", agentId: "w1" }, dir);
    assert.equal(res.justReleased, false);
    assert.deepEqual(res.remaining, ["tostring"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FIFO lock queue auto-transfers on release and wakes next waiter reactively", async () => {
  const dir = makeTmpBus();
  try {
    registerAgent({ agentId: "a", runtime: "antigravity" }, dir);
    registerAgent({ agentId: "b", runtime: "claude-code", status: "idle" }, dir);
    registerAgent({ agentId: "c", runtime: "deepseek", status: "idle" }, dir);

    assert.equal(acquireLock({ resource: "local-check", holder: "a", note: "PR #1" }, dir).ok, true);

    const qB = acquireLock(
      { resource: "local-check", holder: "b", enqueue: true, note: "PR #2" },
      dir
    );
    assert.equal(qB.acquired, false);
    assert.equal(qB.queued, true);
    assert.equal(qB.position, 1);

    const qC = acquireLock(
      { resource: "local-check", holder: "c", enqueue: true, note: "PR #3" },
      dir
    );
    assert.equal(qC.queued, true);
    assert.equal(qC.position, 2);

    const waitB = waitForMessages(
      { agentId: "b", directOnly: true, timeoutSeconds: 5, pollIntervalMs: 500 },
      dir
    );

    const relA = releaseLock({ resource: "local-check", holder: "a" }, dir);
    assert.equal(relA.released, true);
    assert.equal(relA.transferredTo, "b");
    assert.equal(relA.lock.holder, "b");
    assert.equal(relA.lock.queue.length, 1);

    const wokeB = await waitB;
    assert.equal(wokeB.timedOut, false);
    assert.match(wokeB.messages[0].subject, /Lock granted: local-check/);

    // c can cleanly dequeue itself via releaseLock
    const deqC = releaseLock({ resource: "local-check", holder: "c" }, dir);
    assert.equal(deqC.ok, true);
    assert.equal(deqC.dequeued, true);

    // Now when b releases, the lock is fully removed
    const relB = releaseLock({ resource: "local-check", holder: "b" }, dir);
    assert.equal(relB.released, true);
    assert.equal(relB.transferredTo, undefined);
    assert.equal(listLocks({}, dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-recipient sendMessage delivers directly to all listed recipients and excludes others", () => {
  const dir = makeTmpBus();
  try {
    const msg = sendMessage(
      { from: "coord", to: ["a", "b", "a"], subject: "update", body: "advisory now" },
      dir
    );
    assert.deepEqual(msg.to, ["a", "b"]);

    const msgCsv = sendMessage(
      { from: "coord", to: "b, c", subject: "csv", body: "hi b and c" },
      dir
    );
    assert.deepEqual(msgCsv.to, ["b", "c"]);

    assert.equal(readInbox({ agentId: "a", directOnly: true, syncGithub: false }, dir).length, 1);
    assert.equal(readInbox({ agentId: "b", directOnly: true, syncGithub: false }, dir).length, 2);
    assert.equal(readInbox({ agentId: "c", directOnly: true, syncGithub: false }, dir).length, 1);
    assert.equal(readInbox({ agentId: "d", directOnly: true, syncGithub: false }, dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
