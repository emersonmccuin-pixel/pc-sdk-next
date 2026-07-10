// Account registry + per-query env — the account switcher (AGENTS.md locked
// decision). Each account is a Claude Code login living in its own config dir;
// `CLAUDE_CONFIG_DIR` in the SDK's per-query env selects which one runs. On the
// Max subscription an API key or auth token would SHADOW the Claude Code login,
// so both are scrubbed from every env we build (the spike proved this path).
//
// Registry defaults: personal → <home>\.claude, work → <home>\.claude-work.
// Per-project default account lives in `projects.settings.defaultAccountId`;
// switching it mints a new session (sessions live per config dir).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProjectById } from '@pc/db';
import { withProjectSettingsDefaults } from '@pc/domain';
import type { ULID } from '@pc/domain';

export interface Account {
  id: string;
  /** Absolute path to the Claude Code config dir this account logs in from. */
  configDir: string;
}

export const DEFAULT_ACCOUNT_ID = 'personal';

/** The seeded registry: personal + work under the user's home dir. */
export function defaultAccounts(home = homedir()): Account[] {
  return [
    { id: 'personal', configDir: join(home, '.claude') },
    { id: 'work', configDir: join(home, '.claude-work') },
  ];
}

export class AccountRegistry {
  private readonly accounts: Map<string, Account>;
  private readonly defaultId: string;

  constructor(accounts: Account[] = defaultAccounts(), defaultId = DEFAULT_ACCOUNT_ID) {
    this.accounts = new Map(accounts.map((a) => [a.id, a]));
    // Fall back to the first registered account if the named default is absent.
    this.defaultId = this.accounts.has(defaultId)
      ? defaultId
      : (accounts[0]?.id ?? DEFAULT_ACCOUNT_ID);
  }

  list(): Account[] {
    return [...this.accounts.values()];
  }

  has(id: string): boolean {
    return this.accounts.has(id);
  }

  get(id: string): Account | null {
    return this.accounts.get(id) ?? null;
  }

  get defaultAccountId(): string {
    return this.defaultId;
  }

  /** The account a project's new sessions run under: its stored default when
   *  valid, else the registry default. */
  resolveForProject(projectId: ULID): Account {
    const project = getProjectById(projectId);
    const wanted = project ? withProjectSettingsDefaults(project.settings).defaultAccountId : null;
    if (wanted && this.accounts.has(wanted)) return this.accounts.get(wanted)!;
    return this.accounts.get(this.defaultId)!;
  }

  /** Build the per-query env for an account. Spreads `process.env` (the SDK
   *  REPLACES the subprocess env entirely — PATH/HOME must survive), scrubs the
   *  subscription-shadowing credentials, and points `CLAUDE_CONFIG_DIR` at the
   *  account's login. */
  buildEnv(accountId: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`unknown account: ${accountId}`);
    return buildAccountEnv(account.configDir, base);
  }
}

/** Pure env builder — extracted so the credential scrub is unit-testable away
 *  from the registry. Deletes `ANTHROPIC_API_KEY` + `ANTHROPIC_AUTH_TOKEN`,
 *  forces `CLAUDE_CONFIG_DIR`. */
export function buildAccountEnv(
  configDir: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}
