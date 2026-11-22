# agent-comms

A local message bus for coordinating coding agents across separate tools on one machine. Antigravity, Claude Code, Cursor, OpenAI Codex, DeepSeek, and cloud agents can exchange messages, hold resource locks, wait for wave barriers, and share file paths without Redis, Docker, or a background daemon.

```text
  Antigravity (MCP + wait) --+
  Claude Code (MCP + wait) --+--> ~/.agent-comms/ (atomic JSON files and O_EXCL locks)
  Cursor / Codex (MCP)     --+         ^
  DeepSeek / CLI (cli.mjs) --+         | optional bridge (gh api)
                                       v
                           Pinned GitHub issue <--> Cloud agents (Cowork, CI)
```

## What it does

- Runs on Node.js 18 or newer with no npm dependencies on macOS, Linux, and Windows.
- Returns active agents, their held locks, active barriers, the `artifacts` directory path, and recent message headers from one `fleet_status` call.
- Uses `O_EXCL` lock files in `locks/<resource>.json` with a time-to-live so two agents cannot claim `gpu`, `db`, `deploy`, or `issue-42` at the same time. Acquiring a lock also sets the holder's status to `active`.
- Coordinates wave handoffs with `create_barrier`, `barrier_checkin`, and `list_barriers`. When the final expected agent checks in, the bus sends a direct message to the `notify` target.
- Wakes idle agents with `wait --direct-only`, which watches `~/.agent-comms/messages/` with `fs.watch`. Routine broadcasts do not wake sleeping workers, while direct messages and broadcasts tagged `urgent` or `red-main` wake them immediately.
- Stores a timestamp cursor for `ack_messages(all: true)` and moves messages older than 72 hours into `messages/archive/YYYY-MM-DD/`.
- Accepts file paths in `attachments` on `send_message` and creates `~/.agent-comms/artifacts/` for shared screenshots or reports.
- Supports optional channel namespaces (`channel` argument, `--channel <name>`, or `AGENT_COMMS_CHANNEL`). Leaving `channel` empty uses `~/.agent-comms/` directly; naming a channel isolates agents, locks, barriers, messages, and GitHub sync under `~/.agent-comms/channels/<name>/`.
- Syncs with a pinned GitHub issue through `gh` when cloud agents need access. Local broadcasts to `all` stay local unless `relay: true` is passed or the recipient is `cowork`, `claude-code-cloud`, or `cloud`.

## How agents learn to use it

Installing `agent-comms` gives an agent three pieces of context:

1. **Tool schemas from the MCP server (`server/mcp.mjs`).** When an MCP client connects, `tools/list` exposes all 15 tools with their descriptions and JSON argument schemas directly in the model's tool list.
2. **Workflow instructions from the skill (`skills/agent-comms/SKILL.md`).** The installer copies this file into your client's skills directory (`~/.gemini/config/plugins/agent-comms/skills/`, `~/.claude/skills/`, `~/.cursor/skills/`, `~/.codex/skills/`, or `~/.dsh/skills/`). It covers agent naming, locks, wave barriers, and running `wait --direct-only` as a background task.
3. **Always-on habits from the rule (`rules/AGENTS.md`).** Antigravity loads `rules/AGENTS.md` automatically while the plugin is enabled. For Claude Code, Cursor, Codex, or CLI-only agents, copy the bullets from `rules/AGENTS.md` into your repository's `AGENTS.md` or `CLAUDE.md` so agents check `fleet_status` and acquire locks on their own.

CLI-only agents without MCP can read `skills/agent-comms/SKILL.md` and run `node server/cli.mjs` with no arguments to print the full command list.

## Install by client

Clone the repository and run the test suite first:

```bash
git clone https://github.com/tobiowo/agent-comms.git
cd agent-comms
npm test
```

Preview what the installer copies and writes before changing any files:

```bash
node scripts/install.mjs --harness all --dry-run
```

### [Antigravity](https://antigravity.google)

```bash
node scripts/install.mjs --harness antigravity
```

This copies `plugin.json`, `skills/agent-comms/SKILL.md`, `rules/AGENTS.md`, and `server/` into `~/.gemini/config/plugins/agent-comms/` and writes `mcp_config.json` with your local path to `server/mcp.mjs`.

### [Antigravity CLI (`agy`)](https://github.com/google-antigravity/antigravity-cli)

Install from GitHub with `agy`:

```bash
agy plugin install https://github.com/tobiowo/agent-comms
```

Or install from your local clone into `~/.gemini/antigravity-cli/plugins/agent-comms/`:

```bash
node scripts/install.mjs --harness agy
```

### [Claude Code](https://github.com/anthropics/claude-code)

Install from GitHub as a Claude Code plugin:

```text
/plugin marketplace add tobiowo/agent-comms
/plugin install agent-comms@agent-comms
```

Or install from your local clone:

```bash
node scripts/install.mjs --harness claude-code
claude mcp add agent_comms -- node /path/to/agent-comms/server/mcp.mjs
```

### [Cursor](https://github.com/cursor)

```bash
node scripts/install.mjs --harness cursor
```

This copies the skill to `~/.cursor/skills/agent-comms/SKILL.md` and prints the JSON entry to add to `~/.cursor/mcp.json`.

### [OpenAI Codex](https://github.com/openai/codex)

```bash
node scripts/install.mjs --harness codex
```

This copies the skill to `~/.codex/skills/agent-comms/SKILL.md` and prints the `[mcp_servers.agent_comms]` block to add to `~/.codex/config.toml`.

### [DeepSeek](https://github.com/deepseek-ai/deepseek-harness)

```bash
node scripts/install.mjs --harness deepseek
```

This copies the skill into `~/.dsh/skills/agent-comms/SKILL.md`. Register the stdio MCP server in `~/.dsh/cordis.patch.yml` (or through the `dsh` Web/Desktop MCP settings panel):

```yaml
- id: mcp-agent-comms
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: agent_comms
    transport: stdio
    command: node
    args: ['/path/to/agent-comms/server/mcp.mjs']
```

`dsh` exposes the tools as `mcp__agent_comms__<tool>`.

### Other CLI agents

Any client without MCP can call `server/cli.mjs` directly:

```bash
node /path/to/agent-comms/server/cli.mjs status
node /path/to/agent-comms/server/cli.mjs register --id worker-1 --runtime cli --workspace "$PWD"
node /path/to/agent-comms/server/cli.mjs lock --resource gpu --holder worker-1 --ttl 60 --note "Batch run"
node /path/to/agent-comms/server/cli.mjs wait --id worker-1 --direct-only --timeout 1800
node /path/to/agent-comms/server/cli.mjs unlock --resource gpu --holder worker-1
```

### Cloud agents

1. Open a pinned coordination issue in your repository, such as `owner/repo#42`.
2. Configure the bridge on your local machine:
   ```bash
   node server/cli.mjs sync-github --repo owner/repo --issue 42
   ```
3. Have cloud agents post structured comments on that issue:
   ```markdown
   <!-- agent-comms: {"from":"claude-code-cloud","to":"all","subject":"PR #50 ready","tags":["handoff"]} -->
   Your message here.
   ```

## Hub and spoke dispatch

When running three to six agents at once, assign one coordinator to dispatch file-disjoint tasks with direct messages. Have idle workers run `wait --direct-only` in the background and end their turn:

```bash
agent-comms wait --id worker-a --direct-only --timeout 1800
```

Routine `claim` and `done` broadcasts to `all` stay out of their way. Direct assignments, barrier releases, and `urgent` or `red-main` alerts wake them as soon as the file lands on disk.

## MCP tools

| Tool | Purpose |
| :--- | :--- |
| `fleet_status` | Return active agents, held locks, active locks, active barriers, and recent message headers |
| `register_agent` | Register or partially update presence (`agentId`, `runtime`, `workspace`, `note`, `status`) |
| `list_agents` | List registered agents with held locks and stale flags |
| `acquire_lock` | Acquire or renew an `O_EXCL` lock with a time-to-live and mark the holder `active` |
| `release_lock` | Release a lock held by your `agentId` |
| `list_locks` | List active locks and delete expired lock files |
| `create_barrier` | Create a wave barrier with `expected` IDs or `expectedCount` and a `notify` target |
| `barrier_checkin` | Record a check-in and notify the target when the last expected agent arrives |
| `list_barriers` | List unreleased barriers and remaining agents |
| `send_message` | Send a direct message or local broadcast with optional `attachments`, `tags`, `replyTo`, and `relay` |
| `read_inbox` | Read unread messages with optional `directOnly`, `includeUrgent`, `includeAcked`, `from`, and `tag` filters |
| `ack_messages` | Mark specific `messageIds`, all current messages (`all: true`), or messages up to `before` as read |
| `sync_github` | Pull comments from the configured GitHub coordination issue |
| `rename_agent` | Rename an `agentId` and merge its ack history |
| `unregister_agent` | Remove an agent's presence file |

## License

MIT
