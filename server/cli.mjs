#!/usr/bin/env node
import {
  DEFAULT_COMMS_DIR,
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
} from "./bus.mjs";
import { configureGithub, getGithubConfig, syncFromGithub } from "./github.mjs";

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function usage() {
  console.log(`agent-comms CLI v0.4.0 (bus: ${DEFAULT_COMMS_DIR})

Usage:
  agent-comms status [--include-stale] [--recent <n>]
  agent-comms register --id <agentId> [--runtime <name>] [--workspace <path>] [--note <text>] [--status <active|idle|offline>]
  agent-comms rename --from <oldId> --to <newId> [--force]
  agent-comms unregister --id <agentId>
  agent-comms agents [--active-only] [--stale-minutes <n>]

  agent-comms send --from <agentId> [--to <id1,id2|all>] [--subject <text>] --body <text> [--tags <a,b>] [--attach <p1,p2>] [--reply-to <msgId>] [--relay | --no-relay]
  agent-comms inbox --id <agentId> [--from <agentId>] [--tag <tag>] [--direct-only] [--strict-direct] [--all] [--exclude-self] [--limit <n>] [--no-sync]
  agent-comms ack --id <agentId> (--msg <id1,id2,...> | --all | --before <iso>)

  agent-comms wait --id <agentId> [--from <agentId>] [--tag <tag>] [--direct-only] [--strict-direct] [--timeout <sec>] [--sync-github]
  agent-comms watch --id <agentId> [--from <agentId>] [--tag <tag>] [--direct-only] [--strict-direct] [--sync-github]

  agent-comms lock --resource <name> --holder <agentId> [--ttl <min>] [--note <text>] [--enqueue] [--force]
  agent-comms unlock --resource <name> --holder <agentId> [--force]
  agent-comms locks [--include-expired]

  agent-comms barrier-create --name <name> (--expected <a,b> | --count <n>) [--notify <agentId|all>] [--from <agentId>] [--note <text>] [--ttl <min>]
  agent-comms barrier-checkin --name <name> --id <agentId> [--note <text>]
  agent-comms barriers [--include-released]

  agent-comms prune [--hours <n>]
  agent-comms sync-github [--repo <owner/name> --issue <n>] [--allow-authors <u1,u2>]
  agent-comms channels

Global option:
  --channel <name>   Isolate state under ~/.agent-comms/channels/<name>/ (default: ~/.agent-comms/)
`);
}

const [cmd, ...rest] = process.argv.slice(2);
const { flags } = parseFlags(rest);
const BUS_DIR = resolveBusDir(DEFAULT_COMMS_DIR, flags.channel);

async function main() {
  switch (cmd) {
    case "channels": {
      console.log(JSON.stringify({ channels: listChannels(DEFAULT_COMMS_DIR) }, null, 2));
      break;
    }
    case "status": {
      const res = fleetStatus(
        {
          includeStale: Boolean(flags["include-stale"]),
          recentLimit: flags.recent ? Number(flags.recent) : 10,
        },
        BUS_DIR
      );
      console.log(
        JSON.stringify(
          { channel: flags.channel || "default", channels: listChannels(DEFAULT_COMMS_DIR), ...res },
          null,
          2
        )
      );
      break;
    }
    case "register": {
      const res = registerAgent(
        {
          agentId: flags.id,
          runtime: flags.runtime,
          workspace: flags.workspace,
          note: flags.note,
          status: flags.status,
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "rename": {
      const res = renameAgent(
        {
          fromId: flags.from,
          toId: flags.to,
          force: Boolean(flags.force),
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "unregister": {
      const res = unregisterAgent({ agentId: flags.id }, BUS_DIR);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "agents": {
      const res = listAgents(
        {
          includeStale: !flags["active-only"],
          staleMinutes: flags["stale-minutes"] ? Number(flags["stale-minutes"]) : 120,
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "send": {
      const relay = flags["no-relay"] ? false : flags.relay ? true : undefined;
      const res = sendMessage(
        {
          from: flags.from,
          to: flags.to || "all",
          subject: flags.subject || "",
          body: flags.body,
          tags: flags.tags
            ? String(flags.tags)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
          attachments: flags.attach
            ? String(flags.attach)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
          replyTo: flags["reply-to"] || null,
          relay,
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "inbox": {
      const strictDirect = Boolean(flags["strict-direct"]);
      const res = readInbox(
        {
          agentId: flags.id,
          from: flags.from || null,
          tag: flags.tag || null,
          directOnly: Boolean(flags["direct-only"] || strictDirect),
          includeUrgent: !strictDirect,
          includeAcked: Boolean(flags.all),
          excludeSelf: Boolean(flags["exclude-self"]),
          limit: flags.limit ? Number(flags.limit) : 50,
          syncGithub: !flags["no-sync"],
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "ack": {
      const ids = flags.msg
        ? String(flags.msg)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const res = ackMessages(
        {
          agentId: flags.id,
          messageIds: ids,
          all: Boolean(flags.all),
          before: flags.before || null,
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "wait": {
      const strictDirect = Boolean(flags["strict-direct"]);
      const res = await waitForMessages(
        {
          agentId: flags.id,
          from: flags.from || null,
          tag: flags.tag || null,
          directOnly: Boolean(flags["direct-only"] || strictDirect),
          includeUrgent: !strictDirect,
          timeoutSeconds: flags.timeout !== undefined ? Number(flags.timeout) : 1800,
          syncGithub: Boolean(flags["sync-github"]),
          stream: false,
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "watch": {
      const strictDirect = Boolean(flags["strict-direct"]);
      await waitForMessages(
        {
          agentId: flags.id,
          from: flags.from || null,
          tag: flags.tag || null,
          directOnly: Boolean(flags["direct-only"] || strictDirect),
          includeUrgent: !strictDirect,
          timeoutSeconds: 0,
          syncGithub: Boolean(flags["sync-github"]),
          stream: true,
          onMessage: (m) => {
            process.stdout.write(JSON.stringify(m) + "\n");
          },
        },
        BUS_DIR
      );
      break;
    }
    case "lock": {
      const res = acquireLock(
        {
          resource: flags.resource,
          holder: flags.holder,
          ttlMinutes: flags.ttl ? Number(flags.ttl) : 60,
          note: flags.note || "",
          enqueue: Boolean(flags.enqueue),
          force: Boolean(flags.force),
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok && !res.queued) process.exit(2);
      break;
    }
    case "unlock": {
      const res = releaseLock(
        {
          resource: flags.resource,
          holder: flags.holder,
          force: Boolean(flags.force),
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exit(2);
      break;
    }
    case "locks": {
      const res = listLocks({ includeExpired: Boolean(flags["include-expired"]) }, BUS_DIR);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "barrier-create": {
      const expected = flags.expected
        ? String(flags.expected)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const res = createBarrier(
        {
          name: flags.name,
          expected,
          expectedCount: flags.count ? Number(flags.count) : null,
          notify: flags.notify || "all",
          createdBy: flags.from || "coordinator",
          note: flags.note || "",
          ttlMinutes: flags.ttl ? Number(flags.ttl) : 180,
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "barrier-checkin": {
      const res = checkinBarrier(
        {
          name: flags.name,
          agentId: flags.id,
          note: flags.note || "",
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "barriers": {
      const res = listBarriers(
        {
          includeReleased: Boolean(flags["include-released"]),
          includeExpired: Boolean(flags["include-expired"]),
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "prune": {
      const res = archiveOldMessages(
        {
          maxAgeHours: flags.hours ? Number(flags.hours) : 72,
          force: true,
        },
        BUS_DIR
      );
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "sync-github": {
      if (flags.repo && flags.issue) {
        const allowedAuthors = flags["allow-authors"]
          ? String(flags["allow-authors"])
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : null;
        configureGithub(
          { repo: flags.repo, issueNumber: Number(flags.issue), allowedAuthors },
          BUS_DIR
        );
      }
      const res = syncFromGithub({ force: true }, BUS_DIR);
      console.log(
        JSON.stringify(
          { channel: flags.channel || "default", config: getGithubConfig(BUS_DIR), ...res },
          null,
          2
        )
      );
      break;
    }
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
