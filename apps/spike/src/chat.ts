// PC-SDK spike — orchestrator-style chat on the Claude Agent SDK, running on the
// Max subscription (Claude Code login), with an account switcher.
// No API key: auth comes from the Claude Code credential in the selected config dir.
// Run: `pnpm spike` (from repo root) or `pnpm start` here. Commands: /account, /new, exit.

import {
  query,
  tool,
  createSdkMcpServer,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

// --- account switcher: CLAUDE_CONFIG_DIR selects which Claude Code login is used ---
const ACCOUNTS: Record<string, string> = {
  personal: "C:\\Users\\emers\\.claude",
  work: "C:\\Users\\emers\\.claude-work",
};
let account = process.argv.includes("--work") ? "work" : "personal";

function accountEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // Subscription auth: an API key or auth token would shadow the Claude Code login.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CONFIG_DIR = ACCOUNTS[account];
  return env;
}

// --- one in-process custom tool, to prove the SDK MCP path works ---
const saveNote = tool(
  "save_note",
  "Append a note to the spike scratchpad (notes.md in the working directory). Use when the user asks you to remember or record something.",
  { note: z.string().describe("The note to record") },
  async ({ note }) => {
    fs.appendFileSync(path.join(process.cwd(), "notes.md"), `\n- ${note}`);
    return { content: [{ type: "text", text: "saved" }] };
  },
);
const spikeServer = createSdkMcpServer({ name: "spike", version: "1.0.0", tools: [saveNote] });

const SYSTEM = `You are the orchestrator of a local-first project workspace (PC-SDK spike).
You help the user explore and reason about the project in the working directory, using your tools.
Be direct and terse. Lead with the answer. Read files instead of guessing.`;

let sessionId: string | undefined; // resumed across turns; cleared on /account or /new
const total = { in: 0, out: 0, cacheRead: 0, usd: 0, turns: 0 };

async function turn(userText: string): Promise<void> {
  const q = query({
    prompt: userText,
    options: {
      model: "opus",
      systemPrompt: SYSTEM,
      env: accountEnv(),
      cwd: process.cwd(),
      resume: sessionId,
      maxTurns: 30,
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Glob", "Grep", "mcp__spike__save_note"],
      mcpServers: { spike: spikeServer },
    },
  });

  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
    } else if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          process.stdout.write(block.text + "\n");
        } else if (block.type === "thinking" && block.thinking) {
          process.stdout.write(`\x1b[2m${block.thinking}\x1b[0m\n`);
        } else if (block.type === "tool_use") {
          process.stdout.write(`\x1b[36m[tool: ${block.name}]\x1b[0m\n`);
        }
      }
    } else if (msg.type === "result") {
      const usd = msg.total_cost_usd ?? 0;
      const tin = msg.usage.input_tokens ?? 0;
      const tout = msg.usage.output_tokens ?? 0;
      const tcache = msg.usage.cache_read_input_tokens ?? 0;
      total.in += tin;
      total.out += tout;
      total.cacheRead += tcache;
      total.usd += usd;
      total.turns += 1;
      console.log(
        `\x1b[33m[turn: ${tin} in / ${tout} out / ${tcache} cached | API-equiv $${usd.toFixed(4)} — covered by ${account} Max plan]` +
          ` [session: $${total.usd.toFixed(4)}]\x1b[0m`,
      );
      if (msg.subtype !== "success") {
        console.log(`\x1b[31m[result: ${msg.subtype}]\x1b[0m`);
      }
    }
  }
}

async function main(): Promise<void> {
  console.log(`PC-SDK spike — Agent SDK on Max subscription`);
  console.log(`account: ${account} (${ACCOUNTS[account]}) | cwd: ${process.cwd()}`);
  console.log(`Commands: /account personal|work, /new, exit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = (await rl.question(`\x1b[32m${account}>\x1b[0m `)).trim();
    if (!line) continue;
    if (line === "exit" || line === "quit") break;
    if (line.startsWith("/account")) {
      const next = line.split(/\s+/)[1];
      if (next && ACCOUNTS[next]) {
        account = next;
        sessionId = undefined; // sessions live in the config dir — switching = fresh session
        console.log(`switched to ${account} (${ACCOUNTS[account]}) — new session\n`);
      } else {
        console.log(`accounts: ${Object.keys(ACCOUNTS).join(", ")}\n`);
      }
      continue;
    }
    if (line === "/new") {
      sessionId = undefined;
      console.log("new session\n");
      continue;
    }
    try {
      await turn(line);
    } catch (err) {
      console.error(`\n[error] ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log();
  }
  rl.close();
  console.log(
    `\nSession: ${total.turns} turns, ${total.in} in / ${total.out} out / ${total.cacheRead} cache-read, API-equiv $${total.usd.toFixed(4)} (subscription-covered)`,
  );
}

void main();
