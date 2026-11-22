#!/usr/bin/env node
import readline from "node:readline";
import {
  DEFAULT_COMMS_DIR,
  ackMessages,
  acquireLock,
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
} from "./bus.mjs";
import { configureGithub, getGithubConfig, syncFromGithub } from "./github.mjs";

const SERVER_INFO = {
  name: "agent-comms",
  version: "0.3.0",
};

const TOOLS = [
  {
    name: "fleet_status",
    description:
      "Get a single unified snapshot of all active agents (with their held locks), all active resource locks, active message count, artifactsDir, and recent message headers.",
    inputSchema: {
      type: "object",
      properties: {
        includeStale: {
          type: "boolean",
          description: "Include stale agents (default false).",
        },
        staleMinutes: {
          type: "number",
          description: "Stale threshold in minutes (default 120).",
        },
        recentLimit: {
          type: "number",
          description: "Number of recent message headers to include (default 10, max 50).",
        },
      },
    },
  },
  {
    name: "register_agent",
    description:
      "Register or update an agent's presence on the local cross-runtime message bus. Partial updates preserve existing runtime/workspace/status.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description:
            "Unique worker name, e.g. 'claude-code-7c2d', 'cursor-a1b2', 'codex-1', 'antigravity-a3af'.",
        },
        runtime: {
          type: "string",
          description: "Runtime/harness name, e.g. 'antigravity', 'claude-code', 'cursor', 'codex', 'deepseek'.",
        },
        workspace: {
          type: "string",
          description: "Current repo or worktree path the agent is operating in.",
        },
        note: {
          type: "string",
          description: "Short note about current task or focus (e.g. 'Issue #42 auth refactor').",
        },
        status: {
          type: "string",
          description: "Agent status: 'active', 'idle', or 'offline'.",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "list_agents",
    description:
      "List all agents registered on the local bus, their runtimes, workspaces, active locks, current notes, and last-seen timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        includeStale: {
          type: "boolean",
          description: "Include agents not seen recently (default true).",
        },
        staleMinutes: {
          type: "number",
          description: "Threshold in minutes to flag an agent as stale (default 120).",
        },
      },
    },
  },
  {
    name: "send_message",
    description:
      "Send a direct message to a specific agent or broadcast to 'all' (local-only by default; auto-relays to GitHub only for 'cowork'/'claude-code-cloud'/'cloud' or relay: true). Supports optional attachments.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Sender agentId.",
        },
        to: {
          type: "string",
          description: "Recipient agentId, or 'all' to broadcast locally.",
        },
        subject: {
          type: "string",
          description: "Optional short subject line.",
        },
        body: {
          type: "string",
          description: "Message content.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional tags like ['claim', 'handoff', 'learning', 'urgent', 'red-main']. 'urgent'/'red-main' wake --direct-only listeners.",
        },
        attachments: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional file paths (e.g. screenshots or audit JSONs in ~/.agent-comms/artifacts/).",
        },
        replyTo: {
          type: "string",
          description: "Optional message ID this message replies to.",
        },
        relay: {
          type: "boolean",
          description:
            "Optional. Relay to the configured GitHub Agent Bus issue for cloud agents. Defaults to true only for cloud recipients, false otherwise.",
        },
      },
      required: ["from", "body"],
    },
  },
  {
    name: "sync_github",
    description:
      "Pull new messages from the configured GitHub Agent Bus issue (for cloud agents) into the local bus, or configure the repo/issue.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Optional 'owner/name' to configure the GitHub Agent Bus issue.",
        },
        issueNumber: {
          type: "number",
          description: "Optional issue number to configure.",
        },
        allowedAuthors: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional GitHub usernames allowed to inject messages (defaults to the repo owner; prevents untrusted comments on public repos).",
        },
        force: {
          type: "boolean",
          description: "Bypass the 30-second cooldown and fetch immediately (default true).",
        },
      },
    },
  },
  {
    name: "read_inbox",
    description:
      "Read direct messages and broadcasts addressed to an agent. Defaults to unacknowledged messages only.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Your agentId.",
        },
        from: {
          type: "string",
          description: "Optional filter by sender agentId.",
        },
        tag: {
          type: "string",
          description: "Optional filter by tag.",
        },
        directOnly: {
          type: "boolean",
          description:
            "If true, return only direct messages to agentId (plus urgent/red-main broadcasts unless includeUrgent is false).",
        },
        includeUrgent: {
          type: "boolean",
          description: "When directOnly is true, still include urgent/red-main broadcasts (default true).",
        },
        includeAcked: {
          type: "boolean",
          description: "If true, also return already-acknowledged messages (default false).",
        },
        excludeSelf: {
          type: "boolean",
          description: "If true, omit your own broadcasts (default false).",
        },
        syncGithub: {
          type: "boolean",
          description: "Auto-pull from GitHub Agent Bus with 30s cooldown (default true).",
        },
        limit: {
          type: "number",
          description: "Maximum messages to return (default 50, max 200).",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "ack_messages",
    description:
      "Acknowledge specific message IDs, all current messages (all: true), or messages up to a timestamp (before).",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Your agentId.",
        },
        messageIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of message IDs to mark as acknowledged.",
        },
        all: {
          type: "boolean",
          description: "If true, mark all messages up to now as acknowledged (cursor-based).",
        },
        before: {
          type: "string",
          description: "Optional ISO timestamp; marks all messages at or before this time as acknowledged.",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "acquire_lock",
    description:
      "Atomically acquire (or renew) an exclusive TTL lock on a shared resource (e.g. 'gpu', 'db', 'deploy', 'issue-42'). Auto-marks holder active; fails cleanly with current holder if already locked.",
    inputSchema: {
      type: "object",
      properties: {
        resource: {
          type: "string",
          description: "Resource name, e.g. 'gpu', 'deploy', 'issue-42'.",
        },
        holder: {
          type: "string",
          description: "Your agentId.",
        },
        ttlMinutes: {
          type: "number",
          description: "Lock expiry in minutes (default 60).",
        },
        note: {
          type: "string",
          description: "Short reason/task description.",
        },
        force: {
          type: "boolean",
          description: "Override an existing non-expired lock (default false).",
        },
      },
      required: ["resource", "holder"],
    },
  },
  {
    name: "release_lock",
    description: "Release a resource lock held by your agentId.",
    inputSchema: {
      type: "object",
      properties: {
        resource: {
          type: "string",
          description: "Resource name to release.",
        },
        holder: {
          type: "string",
          description: "Your agentId.",
        },
        force: {
          type: "boolean",
          description: "Release even if held by another agent (default false).",
        },
      },
      required: ["resource", "holder"],
    },
  },
  {
    name: "list_locks",
    description: "List all active resource locks on the bus.",
    inputSchema: {
      type: "object",
      properties: {
        includeExpired: {
          type: "boolean",
          description: "Include expired locks instead of pruning them (default false).",
        },
      },
    },
  },
  {
    name: "create_barrier",
    description:
      "Create an MPI-style wave barrier that automatically sends a wakeup message to 'notify' once all expected agents (or expectedCount) check in.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Barrier name, e.g. 'wave-hud' or 'publish-batch-9'.",
        },
        expected: {
          type: "array",
          items: { type: "string" },
          description: "List of expected agentIds (e.g. ['worker-a', 'worker-b']).",
        },
        expectedCount: {
          type: "number",
          description: "Alternative to 'expected': release once this many distinct agents check in.",
        },
        notify: {
          type: "string",
          description: "AgentId (or 'all') to notify automatically when the barrier releases.",
        },
        createdBy: {
          type: "string",
          description: "Your agentId.",
        },
        note: {
          type: "string",
          description: "Optional context included in the release notification.",
        },
        ttlMinutes: {
          type: "number",
          description: "Expiry in minutes (default 180).",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "barrier_checkin",
    description:
      "Check in to an active barrier. When the final expected agent checks in, the barrier releases and wakes the 'notify' target.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Barrier name.",
        },
        agentId: {
          type: "string",
          description: "Your agentId.",
        },
        note: {
          type: "string",
          description: "Optional completion note (e.g. 'PR #569 merged').",
        },
      },
      required: ["name", "agentId"],
    },
  },
  {
    name: "list_barriers",
    description: "List active (unreleased) barriers and which agents have checked in.",
    inputSchema: {
      type: "object",
      properties: {
        includeReleased: {
          type: "boolean",
          description: "Include already-released barriers (default false).",
        },
        includeExpired: {
          type: "boolean",
          description: "Include expired barriers instead of pruning them (default false).",
        },
      },
    },
  },
  {
    name: "unregister_agent",
    description:
      "Remove an agent's presence record from the local bus when a session ends or to clean up stale entries.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID to remove from the active registry.",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "rename_agent",
    description:
      "Rename a registered agentId, migrating its presence record and ack history.",
    inputSchema: {
      type: "object",
      properties: {
        fromId: {
          type: "string",
          description: "Current agentId.",
        },
        toId: {
          type: "string",
          description: "New unique agentId.",
        },
        force: {
          type: "boolean",
          description: "Overwrite target agentId if it already exists (default false).",
        },
      },
      required: ["fromId", "toId"],
    },
  },
];

function withChannelSchema(tools) {
  return tools.map((tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema?.properties || {}),
        channel: {
          type: "string",
          description:
            "Optional channel namespace (default '' uses ~/.agent-comms/; a named channel isolates agents, locks, barriers, and messages under ~/.agent-comms/channels/<name>/).",
        },
      },
    },
  }));
}

const CHANNEL_TOOLS = withChannelSchema(TOOLS);

function sendRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handleToolCall(name, args = {}) {
  const dir = resolveBusDir(DEFAULT_COMMS_DIR, args.channel);
  switch (name) {
    case "fleet_status":
      return {
        channel: args.channel || "default",
        channels: listChannels(DEFAULT_COMMS_DIR),
        ...fleetStatus(args, dir),
      };
    case "register_agent":
      return registerAgent(args, dir);
    case "list_agents":
      return { busDir: dir, channel: args.channel || "default", agents: listAgents(args, dir) };
    case "send_message":
      return sendMessage(args, dir);
    case "read_inbox":
      return {
        agentId: args.agentId,
        channel: args.channel || "default",
        messages: readInbox(args, dir),
      };
    case "ack_messages":
      return ackMessages(args, dir);
    case "acquire_lock":
      return acquireLock(args, dir);
    case "release_lock":
      return releaseLock(args, dir);
    case "list_locks":
      return { channel: args.channel || "default", locks: listLocks(args, dir) };
    case "create_barrier":
      return createBarrier(args, dir);
    case "barrier_checkin":
      return checkinBarrier(args, dir);
    case "list_barriers":
      return { channel: args.channel || "default", barriers: listBarriers(args, dir) };
    case "unregister_agent":
      return unregisterAgent(args, dir);
    case "rename_agent":
      return renameAgent(args, dir);
    case "sync_github": {
      if (args.repo && args.issueNumber) {
        configureGithub(
          { repo: args.repo, issueNumber: args.issueNumber, allowedAuthors: args.allowedAuthors },
          dir
        );
      }
      const syncResult = syncFromGithub({ force: args.force !== false }, dir);
      return {
        channel: args.channel || "default",
        config: getGithubConfig(dir),
        ...syncResult,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = req;
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      if (!isNotification) {
        sendRpc({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        });
      }
      return;
    }

    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return;
    }

    if (method === "ping") {
      if (!isNotification) sendRpc({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      if (!isNotification) sendRpc({ jsonrpc: "2.0", id, result: { tools: CHANNEL_TOOLS } });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = handleToolCall(toolName, toolArgs);
        if (!isNotification) {
          sendRpc({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            },
          });
        }
      } catch (err) {
        if (!isNotification) {
          sendRpc({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `Error: ${err.message}` }],
              isError: true,
            },
          });
        }
      }
      return;
    }

    if (!isNotification) {
      sendRpc({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  } catch (err) {
    if (!isNotification) {
      sendRpc({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err.message },
      });
    }
  }
});
