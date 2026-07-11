// Specialist instruction package — provider-neutral text the adapter compiles
// into its native instruction surface (Claude: system prompt).
//
// Charter (the pod's stored prompt) + the `## Your contract` block: the
// expected-output spec and derived acceptance criteria VERBATIM, plus the
// submit discipline. Delivery via pc_submit_deliverable is the SOLE done-signal
// — a run that ends its turn without submitting fails `no-deliverable`.

import type { AcceptanceCriteria, ExpectedOutput } from '@pc/domain';

export interface SpecialistPromptInput {
  charter: string;
  podName: string;
  expectedOutput: ExpectedOutput;
  acceptanceCriteria: AcceptanceCriteria;
  /** Set for repo-kind dispatches — the isolated worktree the agent runs in. */
  worktreeDir?: string | null;
}

export function buildSpecialistInstructions(input: SpecialistPromptInput): string {
  const parts: string[] = [];
  parts.push(input.charter.trim() || `You are the "${input.podName}" specialist agent.`);

  parts.push(`
## Your contract

This dispatch carries a machine-checked WORK CONTRACT. Your deliverable is
verified against it after your run ends — meeting the contract, not ending your
turn, is what counts as done.

Expected output (the spec you must satisfy):

\`\`\`json
${JSON.stringify(input.expectedOutput, null, 2)}
\`\`\`

Acceptance criteria (machine-evaluated against your submission):

\`\`\`json
${JSON.stringify(input.acceptanceCriteria, null, 2)}
\`\`\`

Rules:
- Re-read your live contract any time with \`pc_get_contract\` and self-check
  against the acceptance criteria BEFORE submitting.
- Submit your typed deliverable with \`pc_submit_deliverable\` (kind matching
  the expected output) as your FINAL action. That submission — not your
  end-of-turn text — is what gets captured and verified. A run that ends with
  nothing submitted is recorded as a failure (\`no-deliverable\`).
- If the brief is missing a detail you cannot responsibly decide, call
  \`pc_ask_orchestrator\` (one clear question), then END YOUR TURN and wait —
  the answer arrives as your next message.`);

  if (input.expectedOutput.kind === 'repo' && input.worktreeDir) {
    parts.push(`
## Repo work — isolated worktree

You are running inside an isolated git worktree: \`${input.worktreeDir}\`
(your working directory). Rules:
- Do all work HERE. Never touch the main project checkout.
- COMMIT everything you want verified — verification reads the COMMITTED diff
  against the dispatch base; uncommitted changes are invisible to it. Commit
  before you submit your deliverable.
- Do not push, do not switch branches, do not create new branches.
- Submit \`{ kind: "repo", branch, commit }\` (your branch name and final
  commit SHA — \`git rev-parse HEAD\`) via \`pc_submit_deliverable\`. After
  verification passes, your branch is landed into the base branch by the
  orchestrator's review (or automatically when the contract opted in) — you
  never merge it yourself.`);
  }

  return parts.join('\n');
}

/** First message for a full-review dispatch: ties the reviewer to the target
 *  contract + SEALED commit (guard 4 — review consumes a sealed commit) and
 *  restates the read-only boundary. The charter carries the craft; this
 *  carries the facts. */
export function buildReviewBrief(input: {
  contractId: string;
  podName: string | null;
  worktreeDir: string;
  branch: string | null;
  sealedCommit: string;
  baseBranch: string | null;
  baseSha: string | null;
  expectedOutput: ExpectedOutput;
  report: string | null;
  reviewRound: number;
}): string {
  const lines: string[] = [];
  lines.push(
    `Independent review (round ${input.reviewRound}) of contract ${input.contractId}` +
      (input.podName ? ` (built by agent '${input.podName}')` : '') +
      '.',
  );
  lines.push('');
  lines.push(
    `Review checkout (your cwd — a disposable detached checkout of the sealed commit, READ-ONLY): ${input.worktreeDir}`,
  );
  if (input.branch) lines.push(`Branch: ${input.branch}`);
  lines.push(`Sealed commit under review: ${input.sealedCommit}`);
  if (input.baseBranch || input.baseSha) {
    lines.push(`Base: ${input.baseBranch ?? '?'}${input.baseSha ? ` @ ${input.baseSha}` : ''}`);
  }
  if (input.baseSha) {
    lines.push(`Review exactly this range: git diff ${input.baseSha}..${input.sealedCommit}`);
  }
  lines.push('');
  lines.push("The contract's expected output (what the sealed work must satisfy):");
  lines.push('```json');
  lines.push(JSON.stringify(input.expectedOutput, null, 2));
  lines.push('```');
  if (input.report) {
    lines.push('');
    lines.push(`Builder's report: ${input.report}`);
  }
  lines.push('');
  lines.push(
    'Judge the sealed commit against the contract, then submit your verdict via pc_submit_deliverable ' +
      '{ kind: "payload", data: { verdict: "approve" | "reject", findings: [{ file, line?, summary, severity }] } }. ' +
      'Approve lands the commit with no further human look; reject sends it to a Fix cycle carrying your findings.',
  );
  return lines.join('\n');
}

/** The `[agent-…]` terminal envelope injected into the orchestrator chat. */
export function buildTerminalEnvelope(input: {
  kind: 'agent-completed' | 'agent-failed';
  runId: string;
  podName: string;
  result: string | null;
  failureCause?: string | null;
  failureReason?: string | null;
  contractId?: string | null;
  verificationStatus?: string | null;
  verificationNotes?: string | null;
  landingStatus?: string | null;
  /** Full-review policy: an independent review run is in flight. */
  reviewInFlight?: boolean;
  deliverableSummary?: string | null;
  /** F10: the external PM-item ref (AInativePM) this run was dispatched
   *  against, if any — ties a completion back to its PM item from the chat
   *  text alone. */
  pmRef?: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`[${input.kind}] agent=${input.podName} runId=${input.runId}`);
  if (input.pmRef) lines.push(`pmRef: ${input.pmRef}`);
  if (input.result) lines.push(`Result: ${input.result}`);
  if (input.failureCause) {
    lines.push(`Failure: ${input.failureCause}${input.failureReason ? ` — ${input.failureReason}` : ''}`);
  }
  if (input.deliverableSummary) lines.push(`Deliverable: ${input.deliverableSummary}`);
  if (input.contractId) {
    const verdict = input.verificationStatus ?? 'not-verified';
    lines.push(`Verification: ${verdict}${input.verificationNotes ? ` — ${input.verificationNotes}` : ''} (contract ${input.contractId})`);
  }
  if (input.landingStatus) lines.push(`Landing: ${input.landingStatus}`);
  else if (input.reviewInFlight) {
    lines.push('Landing: independent review in flight (full-review policy) — the verdict lands or opens a Fix cycle; no action needed unless you want to override via pc_review_contract.');
  } else if (input.kind === 'agent-completed' && input.verificationStatus === 'passed' && input.deliverableSummary?.startsWith('repo ')) {
    lines.push('Landing: merge-ready — review the diff, then pc_review_contract accept to merge into the base branch.');
  }
  lines.push(
    `(Use pc_get_deliverable for the full deliverable, pc_review_contract to sign off a pending review, pc_continue_agent runId=${input.runId} for follow-ups.)`,
  );
  return lines.join('\n');
}

/** The `[agent-asks]` pause envelope injected into the orchestrator chat. */
export function buildAskEnvelope(input: {
  runId: string;
  podName: string;
  pendingAskId: string;
  kind: 'orchestrator' | 'approval';
  promptBody: string;
  context?: string | null;
  options?: ReadonlyArray<{ label: string; value: string }> | null;
}): string {
  const lines: string[] = [];
  lines.push(`[agent-asks] agent=${input.podName} runId=${input.runId} pendingAskId=${input.pendingAskId}`);
  lines.push(input.kind === 'approval' ? `Approval requested: ${input.promptBody}` : `Question: ${input.promptBody}`);
  if (input.context) lines.push(`Context: ${input.context}`);
  if (input.options && input.options.length > 0) {
    lines.push(`Options: ${input.options.map((o) => `${o.label} (${o.value})`).join(' | ')}`);
  }
  lines.push(
    `Answer with pc_answer_pending pendingAskId=${input.pendingAskId} (answeredBy="orchestrator"), or relay to the user first if only they can decide.`,
  );
  return lines.join('\n');
}
