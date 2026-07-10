# CLAUDE.md

Project instructions live in **`AGENTS.md`** (canonical). Read it first — it has the locked design decisions, the port map from PC-PTY-Chat, and the phase plan.

The provider boundary is defined in **`docs/agent-runtime-architecture.md`**.
PC-SDK owns product behavior; Claude Agent SDK, OpenAI Codex, and future agent
runtimes plug in through adapters. Do not introduce Claude- or Codex-specific
types or conditionals outside an adapter.

Repository mutation and landing are defined in
**`docs/worktree-lifecycle.md`**. Every write-capable agent uses a recorded
worktree regardless of task size. The main working copy is read-only to agents;
merge and teardown are guarded PC-SDK service operations.
