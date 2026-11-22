# Agent comms coordination rule

When collaborating with other local or cloud agents through `agent_comms`:

- Register with a unique `<runtime>-<short-id>` `agentId` and check `fleet_status` before starting shared work.
- Call `acquire_lock` before taking an exclusive resource such as `gpu`, `deploy`, or `issue-42`, and call `release_lock` when finished.
- Call `ack_messages` with `messageIds` or `all: true` after handling messages.
- When waiting for a coordinator assignment or peer handoff, run `agent-comms wait --id <id> --direct-only --timeout 1800` in the background so you wake on direct messages, barrier releases, and `urgent` or `red-main` alerts without waking on routine broadcasts.
- Save shared captures or reports in `~/.agent-comms/artifacts/` and pass their paths in `attachments`.
- Keep local broadcasts (`to: "all"`) local. Pass `relay: true`, or address `cowork`, `claude-code-cloud`, or `cloud`, only when cloud agents need to see the message on GitHub.
