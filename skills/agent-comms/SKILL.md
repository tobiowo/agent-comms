---
name: agent-comms
license: MIT
description: Local cross-runtime messaging, atomic resource locks, wave barriers, reactive push wakeup, artifact attachments, and optional GitHub issue sync for coding agents via the agent_comms MCP server and CLI (~/.agent-comms). Use when registering an agent, checking fleet status, waiting for peer messages, acquiring locks, checking in to barriers, sending messages, or acknowledging handled messages.
---

# Agent comms protocol

`agent-comms` stores shared state in `~/.agent-comms/` (override with `AGENT_COMMS_DIR`) so agents in Antigravity, Claude Code, Cursor, Codex, and DeepSeek can coordinate on one machine. An optional GitHub issue bridge connects cloud sandboxes. Pass `channel` (or `--channel <name>` / `AGENT_COMMS_CHANNEL`) to isolate a separate project under `~/.agent-comms/channels/<name>/`; leave it empty for the default shared bus.

## Identity convention

Pick a unique lowercase `<runtime>-<short-id>` name so concurrent sessions do not overwrite each other:

- Local agents: `claude-code-7c2d`, `cursor-a1b2`, `antigravity-a3af`, `codex-1`, `deepseek`
- Cloud agents: `cowork`, `claude-code-cloud`, `cloud`

`register_agent` keeps existing `runtime`, `workspace`, and `status` values on partial updates. It returns a warning if you reuse an active ID from a different workspace.

## MCP tools

1. `fleet_status` returns active agents with their held locks, active locks, active barriers, active message count, `artifactsDir`, and recent message headers.
2. `register_agent` creates or updates your `agentId`, `runtime`, `workspace`, `note`, and `status` (`active`, `idle`, or `offline`).
3. `list_agents` lists agents, runtimes, workspaces, held locks, and last-seen timestamps.
4. `acquire_lock`, `release_lock`, and `list_locks` manage `O_EXCL` locks with a time-to-live for exclusive resources such as `gpu`, `db`, `deploy`, or `issue-42`. Acquiring a lock marks the holder `active`.
5. `create_barrier`, `barrier_checkin`, and `list_barriers` coordinate waves of work. When the last expected agent checks in, the bus sends a direct message to `notify`.
6. `send_message` sends a direct message (`to: "coordinator"`) or a local broadcast (`to: "all"`). Pass file paths in `attachments` when sharing files from `~/.agent-comms/artifacts/`. Broadcasts stay local unless `relay: true` is passed or `to` is a cloud recipient. Tag fleet-wide alerts with `["urgent"]` or `["red-main"]` to wake `--direct-only` listeners.
7. `read_inbox` reads unread messages with optional `directOnly`, `includeUrgent`, `includeAcked`, `excludeSelf`, `from`, `tag`, and `syncGithub` filters.
8. `ack_messages` marks specific `messageIds` as read, or advances a timestamp cursor with `all: true` or `before`.
9. `sync_github` pulls new comments from the configured GitHub coordination issue or sets `repo` and `issueNumber`.
10. `rename_agent` and `unregister_agent` rename a session ID while keeping its ack history, or remove a finished session.

Messages older than 72 hours move automatically into `~/.agent-comms/messages/archive/YYYY-MM-DD/`. Run `agent-comms prune --hours <n>` to archive earlier.

## Reactive wakeup

Idle workers should wait with `--direct-only` so routine broadcasts from other workers do not wake them:

```bash
agent-comms wait --id <your-id> --direct-only --timeout 1800
```

Run `wait` as a background task and end your turn. It watches `~/.agent-comms/messages/` with `fs.watch` and exits with JSON as soon as a direct message, barrier release, or `urgent`/`red-main` broadcast arrives. Pass `--strict-direct` to ignore `urgent` broadcasts, or omit `--direct-only` to wake on all broadcasts.

Use `agent-comms watch --id <your-id>` for continuous NDJSON output, or call `read_inbox` to poll on demand.
