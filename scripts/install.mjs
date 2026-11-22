#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const HOME = os.homedir();

function posixPath(p) {
  return p.replace(/\\/g, "/");
}

function parseArgs(argv) {
  const opts = { harnesses: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--harness" && argv[i + 1]) {
      opts.harnesses.push(...argv[++i].split(",").map((s) => s.trim().toLowerCase()));
    } else if (!a.startsWith("-")) {
      opts.harnesses.push(a.trim().toLowerCase());
    }
  }
  return opts;
}

function copyDir(src, dest, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] copy ${src} -> ${dest}`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function writeFile(dest, content, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] write ${dest}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, "utf8");
}

function renderSkillWithCliPath(cliPath) {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "skills", "agent-comms", "SKILL.md"), "utf8");
  return raw.replaceAll("agent-comms ", `node ${posixPath(cliPath)} `);
}

function installAntigravityBundle(dest, label, dryRun) {
  const mcpPath = posixPath(path.join(dest, "server", "mcp.mjs"));
  const cliPath = posixPath(path.join(dest, "server", "cli.mjs"));

  copyDir(path.join(REPO_ROOT, "server"), path.join(dest, "server"), dryRun);
  copyDir(path.join(REPO_ROOT, "skills"), path.join(dest, "skills"), dryRun);
  copyDir(path.join(REPO_ROOT, "rules"), path.join(dest, "rules"), dryRun);
  writeFile(
    path.join(dest, "plugin.json"),
    fs.readFileSync(path.join(REPO_ROOT, "plugin.json"), "utf8"),
    dryRun
  );
  writeFile(
    path.join(dest, "README.md"),
    fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8"),
    dryRun
  );
  writeFile(
    path.join(dest, "mcp_config.json"),
    JSON.stringify(
      {
        mcpServers: {
          agent_comms: {
            command: "node",
            args: [mcpPath],
          },
        },
      },
      null,
      2
    ) + "\n",
    dryRun
  );
  console.log(`\n[${label}] Installed plugin to ${dest}`);
  console.log(`  MCP server: node ${mcpPath}`);
  console.log(`  CLI wait:   node ${cliPath} wait --id <your-id> --direct-only --timeout 1800`);
}

function installAntigravity(dryRun) {
  installAntigravityBundle(
    path.join(HOME, ".gemini", "config", "plugins", "agent-comms"),
    "antigravity",
    dryRun
  );
}

function installAgy(dryRun) {
  installAntigravityBundle(
    path.join(HOME, ".gemini", "antigravity-cli", "plugins", "agent-comms"),
    "agy",
    dryRun
  );
  console.log(`  Or install directly with agy:`);
  console.log(`    agy plugin install https://github.com/tobiowo/agent-comms`);
}

function installClaudeCode(dryRun) {
  const mcpPath = posixPath(path.join(REPO_ROOT, "server", "mcp.mjs"));
  const cliPath = posixPath(path.join(REPO_ROOT, "server", "cli.mjs"));
  const skillDest = path.join(HOME, ".claude", "skills", "agent-comms", "SKILL.md");

  writeFile(skillDest, renderSkillWithCliPath(cliPath), dryRun);
  console.log(`\n[claude-code] Installed skill to ${skillDest}`);
  console.log(`  Register MCP server by running:`);
  console.log(`    claude mcp add agent_comms -- node ${mcpPath}`);
  console.log(`  Or install as a Claude Code plugin from GitHub:`);
  console.log(`    /plugin marketplace add tobiowo/agent-comms`);
  console.log(`    /plugin install agent-comms@agent-comms`);
}

function installCursor(dryRun) {
  const mcpPath = posixPath(path.join(REPO_ROOT, "server", "mcp.mjs"));
  const cliPath = posixPath(path.join(REPO_ROOT, "server", "cli.mjs"));
  const skillDest = path.join(HOME, ".cursor", "skills", "agent-comms", "SKILL.md");

  writeFile(skillDest, renderSkillWithCliPath(cliPath), dryRun);
  console.log(`\n[cursor] Installed skill to ${skillDest}`);
  console.log(`  Add to ~/.cursor/mcp.json (or project .cursor/mcp.json):`);
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          agent_comms: { command: "node", args: [mcpPath] },
        },
      },
      null,
      2
    )
  );
}

function installCodex(dryRun) {
  const mcpPath = posixPath(path.join(REPO_ROOT, "server", "mcp.mjs"));
  const cliPath = posixPath(path.join(REPO_ROOT, "server", "cli.mjs"));
  const skillDest = path.join(HOME, ".codex", "skills", "agent-comms", "SKILL.md");

  writeFile(skillDest, renderSkillWithCliPath(cliPath), dryRun);
  console.log(`\n[codex] Installed skill to ${skillDest}`);
  console.log(`  Add to ~/.codex/config.toml:`);
  console.log(`    [mcp_servers.agent_comms]`);
  console.log(`    command = "node"`);
  console.log(`    args = ["${mcpPath}"]`);
}

function installDeepSeek(dryRun) {
  const mcpPath = posixPath(path.join(REPO_ROOT, "server", "mcp.mjs"));
  const cliPath = posixPath(path.join(REPO_ROOT, "server", "cli.mjs"));
  const skillDest = path.join(HOME, ".dsh", "skills", "agent-comms", "SKILL.md");

  writeFile(skillDest, renderSkillWithCliPath(cliPath), dryRun);
  console.log(`\n[deepseek] Installed skill to ${skillDest}`);
  console.log(`  Add to ~/.dsh/cordis.patch.yml (or configure in the dsh Web/Desktop MCP panel):`);
  console.log(`    - id: mcp-agent-comms`);
  console.log(`      name: '@deepseek-ai/dsh-mcp-client'`);
  console.log(`      config:`);
  console.log(`        serverName: agent_comms`);
  console.log(`        transport: stdio`);
  console.log(`        command: node`);
  console.log(`        args: ['${mcpPath}']`);
}

const { harnesses, dryRun } = parseArgs(process.argv.slice(2));
if (harnesses.length === 0) {
  console.log(
    `Usage: node scripts/install.mjs --harness <antigravity|agy|claude-code|cursor|codex|deepseek|all> [--dry-run]`
  );
  process.exit(0);
}

const targets = harnesses.includes("all")
  ? ["antigravity", "agy", "claude-code", "cursor", "codex", "deepseek"]
  : Array.from(new Set(harnesses));

for (const t of targets) {
  switch (t) {
    case "antigravity":
      installAntigravity(dryRun);
      break;
    case "agy":
      installAgy(dryRun);
      break;
    case "claude-code":
      installClaudeCode(dryRun);
      break;
    case "cursor":
      installCursor(dryRun);
      break;
    case "codex":
      installCodex(dryRun);
      break;
    case "deepseek":
      installDeepSeek(dryRun);
      break;
    default:
      console.error(`Unknown harness: ${t}`);
      process.exit(1);
  }
}
