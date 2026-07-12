/**
 * Git repository selectors inherited from the launcher can redirect a child
 * away from the cwd whose repository lease PC-SDK proved. Keep repository
 * selection cwd-derived at every app-owned Git/provider child boundary.
 */
const GIT_REPOSITORY_SELECTOR_NAMES = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
]);

/** Clone an environment and remove ambient Git repository selectors.
 *
 * Environment keys are compared case-insensitively because Windows exposes a
 * case-insensitive environment even when a supplied test/object preserves a
 * caller's original spelling.
 */
export function withoutAmbientGitRepositorySelectors(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (GIT_REPOSITORY_SELECTOR_NAMES.has(key.toUpperCase())) delete env[key];
  }
  return env;
}
