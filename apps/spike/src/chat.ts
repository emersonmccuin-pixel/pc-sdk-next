// PC-SDK cost spike — orchestrator-style chat on the Anthropic SDK tool runner.
// Purpose: feel out SDK chat vs the PTY app, and measure real per-turn cost.
// Run: set ANTHROPIC_API_KEY (or put it in .env at repo root), then `pnpm spike`.

import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

// --- tiny .env loader (no dep) ---
const envPath = path.resolve(process.cwd(), "../../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set. Export it or add it to PC-SDK/.env");
  process.exit(1);
}

const MODEL = "claude-opus-4-8";
// $/MTok: input 5, output 25, cache read 0.5 (0.1x), cache write 6.25 (1.25x, 5m TTL)
const PRICE = { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 };

// Tools are sandboxed to this directory (default: where you launch from).
const ROOT = path.resolve(process.env.SPIKE_ROOT ?? process.cwd());
function safePath(p: string): string {
  const resolved = path.resolve(ROOT, p);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error(`path escapes sandbox root ${ROOT}`);
  }
  return resolved;
}

const listDir = betaTool({
  name: "list_dir",
  description:
    "List files and directories at a path relative to the sandbox root. Call this to explore the project before reading files.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Relative path, '.' for root" } },
    required: ["path"],
    additionalProperties: false,
  } as const,
  run: async (input) => {
    const entries = fs.readdirSync(safePath((input as { path: string }).path), { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") || "(empty)";
  },
});

const readFile = betaTool({
  name: "read_file",
  description: "Read a UTF-8 text file at a path relative to the sandbox root (max ~50KB returned).",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  } as const,
  run: async (input) => {
    const text = fs.readFileSync(safePath((input as { path: string }).path), "utf8");
    return text.length > 50_000 ? text.slice(0, 50_000) + "\n...[truncated]" : text;
  },
});

const saveNote = betaTool({
  name: "save_note",
  description:
    "Append a note to the spike scratchpad (notes.md in the sandbox root). Use when the user asks you to remember or record something.",
  inputSchema: {
    type: "object",
    properties: { note: { type: "string" } },
    required: ["note"],
    additionalProperties: false,
  } as const,
  run: async (input) => {
    fs.appendFileSync(path.join(ROOT, "notes.md"), `\n- ${(input as { note: string }).note}`);
    return "saved";
  },
});

const SYSTEM = `You are the orchestrator of a local-first project workspace (PC-SDK spike).
You help the user explore and reason about the project at the sandbox root, using your tools.
Be direct and terse. Lead with the answer. Use tools when the answer depends on file contents rather than guessing.`;

const client = new Anthropic();
const history: Anthropic.Beta.BetaMessageParam[] = [];
const total = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };

function costUsd(u: typeof total): number {
  return (
    (u.in * PRICE.in + u.out * PRICE.out + u.cacheRead * PRICE.cacheRead + u.cacheWrite * PRICE.cacheWrite) / 1e6
  );
}

async function turn(userText: string): Promise<void> {
  history.push({ role: "user", content: userText });
  const turnUsage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive", display: "summarized" },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: [listDir, readFile, saveNote],
    messages: history,
    stream: true,
  });

  let finalContent: Anthropic.Beta.BetaContentBlock[] = [];
  for await (const stream of runner) {
    let inThinking = false;
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "thinking") {
          inThinking = true;
          process.stdout.write("\x1b[2m[thinking] ");
        } else if (event.content_block.type === "tool_use") {
          process.stdout.write(`\x1b[36m[tool: ${event.content_block.name}]\x1b[0m\n`);
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          if (inThinking) { process.stdout.write("\x1b[0m"); inThinking = false; }
          process.stdout.write(event.delta.text);
        } else if (event.delta.type === "thinking_delta") {
          process.stdout.write(`\x1b[2m${event.delta.thinking}\x1b[0m`);
        }
      } else if (event.type === "content_block_stop" && inThinking) {
        process.stdout.write("\x1b[0m\n");
        inThinking = false;
      }
    }
    const msg = await stream.finalMessage();
    finalContent = msg.content;
    turnUsage.in += msg.usage.input_tokens;
    turnUsage.out += msg.usage.output_tokens;
    turnUsage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    turnUsage.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
  }

  // Spike simplification: only the final assistant message is kept in history
  // (intermediate tool_use/tool_result turns are dropped). Fine for cost-feel;
  // the real app will persist the full event stream.
  history.push({ role: "assistant", content: finalContent });

  total.in += turnUsage.in;
  total.out += turnUsage.out;
  total.cacheRead += turnUsage.cacheRead;
  total.cacheWrite += turnUsage.cacheWrite;
  console.log(
    `\n\x1b[33m[turn: ${turnUsage.in} in / ${turnUsage.out} out / ${turnUsage.cacheRead} cached = $${costUsd(turnUsage).toFixed(4)}]` +
      ` [session total: $${costUsd(total).toFixed(4)}]\x1b[0m`,
  );
}

async function main(): Promise<void> {
  console.log(`PC-SDK spike — ${MODEL} — sandbox root: ${ROOT}`);
  console.log(`Type a message, or "exit".\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = (await rl.question("\x1b[32myou>\x1b[0m ")).trim();
    if (!line) continue;
    if (line === "exit" || line === "quit") break;
    try {
      await turn(line);
    } catch (err) {
      console.error(`\n[error] ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log();
  }
  rl.close();
  console.log(
    `\nSession: ${total.in} in / ${total.out} out / ${total.cacheRead} cache-read / ${total.cacheWrite} cache-write = $${costUsd(total).toFixed(4)}`,
  );
}

void main();
