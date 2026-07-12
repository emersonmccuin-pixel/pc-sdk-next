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
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { isSubscriptionQuotaIdentity } from '@pc/contracts';
import { getProjectById } from '@pc/db';
import { withProjectSettingsDefaults } from '@pc/domain';
import type { ULID } from '@pc/domain';
import { withoutAmbientGitRepositorySelectors } from '../operations/git-environment.ts';

export interface Account {
  id: string;
  /** Owning runtime adapter. Equal account ids may exist under peer runtimes. */
  runtimeId: string;
  /** Absolute path to the Claude Code config dir this account logs in from. */
  configDir: string;
}

export const DEFAULT_ACCOUNT_ID = 'personal';

export class AccountUnavailableError extends Error {
  readonly code = 'account-unavailable' as const;

  constructor(runtimeId: string, accountId: string) {
    super(`account unavailable for runtime ${runtimeId}: ${accountId}`);
    this.name = 'AccountUnavailableError';
  }
}

/** The seeded registry: personal + work under the user's home dir. */
export function defaultAccounts(
  home = homedir(),
  runtimeId = 'claude-agent-sdk',
): Account[] {
  return [
    { id: 'personal', runtimeId, configDir: join(home, '.claude') },
    { id: 'work', runtimeId, configDir: join(home, '.claude-work') },
  ];
}

export class AccountRegistry {
  private readonly accounts: Map<string, Account>;
  private readonly defaultId: string;

  constructor(accounts: Account[] = defaultAccounts(), defaultId = DEFAULT_ACCOUNT_ID) {
    if (!isCanonicalIdentity(defaultId)) throw new Error('default account id must be canonical');
    const validated = accounts.map(validateAccount);
    this.accounts = new Map(validated.map((account) => [
      accountKey(account.runtimeId, account.id),
      account,
    ]));
    if (this.accounts.size !== validated.length) throw new Error('duplicate runtime account id');
    const credentialHomes = new Set<string>();
    for (const account of validated) {
      const key = credentialHomeKey(account.runtimeId, account.configDir);
      if (credentialHomes.has(key)) throw new Error('duplicate runtime credential home');
      credentialHomes.add(key);
    }
    this.defaultId = defaultId;
  }

  list(): Account[] {
    return [...this.accounts.values()].map(cloneAccount);
  }

  has(runtimeId: string, id: string): boolean {
    return this.accounts.has(accountKey(runtimeId, id));
  }

  get(runtimeId: string, id: string): Account | null {
    const account = this.accounts.get(accountKey(runtimeId, id));
    return account ? cloneAccount(account) : null;
  }

  defaultAccountId(runtimeId: string): string {
    const preferred = this.get(runtimeId, this.defaultId);
    if (preferred) return preferred.id;
    throw new AccountUnavailableError(runtimeId, this.defaultId);
  }

  /** The account a project's new sessions run under: its stored default when
   *  absent, else the exact stored account. An unknown stored identity is
   *  typed failure evidence and never selects another credential home. */
  resolveForProject(projectId: ULID, runtimeId: string): Account {
    const project = getProjectById(projectId);
    const wanted = project ? withProjectSettingsDefaults(project.settings).defaultAccountId : null;
    if (wanted) {
      const selected = this.get(runtimeId, wanted);
      if (selected) return selected;
      throw new AccountUnavailableError(runtimeId, wanted);
    }
    const selectedDefault = this.get(runtimeId, this.defaultAccountId(runtimeId));
    if (!selectedDefault) throw new AccountUnavailableError(runtimeId, this.defaultId);
    return selectedDefault;
  }

  /** Build the per-query env for an account. Spreads `process.env` (the SDK
   *  REPLACES the subprocess env entirely — PATH/HOME must survive), scrubs the
   *  subscription-shadowing credentials, and points `CLAUDE_CONFIG_DIR` at the
   *  account's login. */
  buildEnv(
    runtimeId: string,
    accountId: string,
    base: NodeJS.ProcessEnv = process.env,
  ): Record<string, string> {
    const account = this.get(runtimeId, accountId);
    if (!account) throw new Error(`unknown account for runtime ${runtimeId}: ${accountId}`);
    return buildAccountEnv(account.configDir, base);
  }
}

function accountKey(runtimeId: string, accountId: string): string {
  return `${runtimeId}\u0000${accountId}`;
}

function isCanonicalIdentity(value: unknown): value is string {
  return isSubscriptionQuotaIdentity(value);
}

function validateAccount(account: Account): Account {
  if (
    account === null || typeof account !== 'object' ||
    !isCanonicalIdentity(account.id) ||
    !isCanonicalIdentity(account.runtimeId)
  ) throw new Error('runtime account identity must be canonical');
  if (
    typeof account.configDir !== 'string' ||
    !account.configDir.trim() ||
    account.configDir !== account.configDir.trim() ||
    account.configDir.includes('\u0000') ||
    !isAbsolute(account.configDir)
  ) throw new Error('runtime credential home must be an absolute canonical path');
  return Object.freeze(cloneAccount(account));
}

function cloneAccount(account: Account): Account {
  return {
    id: account.id,
    runtimeId: account.runtimeId,
    configDir: account.configDir,
  };
}

function credentialHomeKey(runtimeId: string, configDir: string): string {
  const canonical = normalize(resolve(configDir));
  return `${runtimeId}\u0000${process.platform === 'win32' ? canonical.toLowerCase() : canonical}`;
}

/** Pure env builder — extracted so the child-env scrub is unit-testable away
 *  from the registry. Deletes subscription-shadowing credentials and ambient
 *  Git repository selectors, then forces `CLAUDE_CONFIG_DIR`. */
export function buildAccountEnv(
  configDir: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (
    typeof configDir !== 'string' ||
    !configDir.trim() ||
    configDir !== configDir.trim() ||
    configDir.includes('\u0000') ||
    !isAbsolute(configDir)
  ) throw new Error('runtime credential home must be an absolute canonical path');
  const env: Record<string, string> = {};
  const blocked = new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
  ]);
  for (const [key, value] of Object.entries(withoutAmbientGitRepositorySelectors(base))) {
    if (value !== undefined && !blocked.has(key.toUpperCase())) env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}
