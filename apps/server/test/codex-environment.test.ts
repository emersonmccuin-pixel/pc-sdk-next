import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCodexEnvironment,
  CodexEnvironmentError,
  type CodexEnvironmentErrorCode,
  type CodexEnvironmentFileSystem,
} from '../src/runner/codex/environment.ts';

function existingDirectory(canonicalHome: string): CodexEnvironmentFileSystem {
  return {
    realpath(requestedHome) {
      assert.equal(requestedHome, canonicalHome);
      return canonicalHome;
    },
    isDirectory(requestedHome) {
      assert.equal(requestedHome, canonicalHome);
      return true;
    },
  };
}

function assertRejected(
  action: () => unknown,
  code: CodexEnvironmentErrorCode,
  sensitiveValue?: string,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CodexEnvironmentError);
    assert.equal(error.name, 'CodexEnvironmentError');
    assert.equal(error.code, code);
    assert.equal(error.message, `Codex environment rejected: ${code}`);
    assert.equal('cause' in error, false);
    if (sensitiveValue) assert.equal(error.message.includes(sensitiveValue), false);
    return true;
  });
}

test('POSIX builds from the shared allowlist and adds only the explicit Codex selector', () => {
  const codexHome = '/home/operator/.codex';
  const baseEnvironment: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/operator',
    CODEX_HOME: '/home/ambient/.codex',
    codex_home: '/home/alias/.codex',
    CLAUDE_CONFIG_DIR: '/home/operator/.claude',
    OPENAI_API_KEY: 'raw-api-key',
    OPENAI_BASE_URL: 'https://provider.invalid',
    OPENAI_ORG_ID: 'raw-org',
    CODEX_ACCESS_TOKEN: 'raw-access-token',
    ANTHROPIC_API_KEY: 'peer-api-key',
    AZURE_OPENAI_ENDPOINT: 'https://azure.invalid',
  };
  const before = { ...baseEnvironment };

  assert.deepEqual(buildCodexEnvironment(codexHome, {
    baseEnvironment,
    platform: 'linux',
    fileSystem: existingDirectory(codexHome),
  }), {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/operator',
    CODEX_HOME: codexHome,
  });
  assert.deepEqual(baseEnvironment, before);
});

test('Windows canonicalizes allowlisted OS names but never ambient Codex aliases', () => {
  const codexHome = 'C:\\Users\\Operator\\.codex';
  const baseEnvironment: NodeJS.ProcessEnv = {
    Path: 'C:\\Windows\\System32',
    userProfile: 'C:\\Users\\Operator',
    CODEX_HOME: 'C:\\Users\\Ambient\\.codex',
    Codex_Home: 'C:\\Users\\Alias\\.codex',
    OPENAI_API_KEY: 'raw-api-key',
    OpenAI_Base_URL: 'https://provider.invalid',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\Operator\\.claude',
  };

  assert.deepEqual(buildCodexEnvironment(codexHome, {
    baseEnvironment,
    platform: 'win32',
    fileSystem: existingDirectory(codexHome),
  }), {
    PATH: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\Operator',
    CODEX_HOME: codexHome,
  });
  assert.deepEqual(Object.keys(baseEnvironment), [
    'Path',
    'userProfile',
    'CODEX_HOME',
    'Codex_Home',
    'OPENAI_API_KEY',
    'OpenAI_Base_URL',
    'CLAUDE_CONFIG_DIR',
  ]);
});

test('platform validation rejects relative and platform-mismatched paths before filesystem access', () => {
  let filesystemCalls = 0;
  const fileSystem: CodexEnvironmentFileSystem = {
    realpath() {
      filesystemCalls += 1;
      return '/unexpected';
    },
    isDirectory() {
      filesystemCalls += 1;
      return true;
    },
  };

  assertRejected(
    () => buildCodexEnvironment('relative/.codex', { platform: 'linux', fileSystem }),
    'codex-home-not-absolute',
  );
  assertRejected(
    () => buildCodexEnvironment('C:\\Users\\Operator\\.codex', {
      platform: 'linux',
      fileSystem,
    }),
    'codex-home-not-absolute',
  );
  assertRejected(
    () => buildCodexEnvironment('C:relative\\.codex', { platform: 'win32', fileSystem }),
    'codex-home-not-absolute',
  );
  assertRejected(
    () => buildCodexEnvironment('\\root-relative\\.codex', {
      platform: 'win32',
      fileSystem,
    }),
    'codex-home-not-absolute',
  );
  assert.equal(filesystemCalls, 0);
});

test('lexical aliases, Windows case aliases, and filesystem aliases are noncanonical', () => {
  assertRejected(
    () => buildCodexEnvironment('/home/operator/../operator/.codex', {
      platform: 'linux',
      fileSystem: existingDirectory('/home/operator/.codex'),
    }),
    'codex-home-not-canonical',
  );
  assertRejected(
    () => buildCodexEnvironment('C:/Users/Operator/.codex', {
      platform: 'win32',
      fileSystem: existingDirectory('C:\\Users\\Operator\\.codex'),
    }),
    'codex-home-not-canonical',
  );

  const windowsAlias = 'C:\\users\\Operator\\.codex';
  assertRejected(
    () => buildCodexEnvironment(windowsAlias, {
      platform: 'win32',
      fileSystem: {
        realpath: () => 'C:\\Users\\Operator\\.codex',
        isDirectory: () => true,
      },
    }),
    'codex-home-not-canonical',
    windowsAlias,
  );

  const symlinkAlias = '/home/operator/codex-link';
  assertRejected(
    () => buildCodexEnvironment(symlinkAlias, {
      platform: 'linux',
      fileSystem: {
        realpath: () => '/home/operator/.codex',
        isDirectory: () => true,
      },
    }),
    'codex-home-not-canonical',
    symlinkAlias,
  );
});

test('missing, inaccessible, and non-directory homes return typed redacted failures', () => {
  const missingHome = '/private/missing-codex-home';
  assertRejected(
    () => buildCodexEnvironment(missingHome, {
      platform: 'linux',
      fileSystem: {
        realpath() {
          throw new Error(`ENOENT: ${missingHome}`);
        },
        isDirectory: () => true,
      },
    }),
    'codex-home-unavailable',
    missingHome,
  );

  const inaccessibleHome = '/private/inaccessible-codex-home';
  assertRejected(
    () => buildCodexEnvironment(inaccessibleHome, {
      platform: 'linux',
      fileSystem: {
        realpath: () => inaccessibleHome,
        isDirectory() {
          throw new Error(`EACCES: ${inaccessibleHome}`);
        },
      },
    }),
    'codex-home-unavailable',
    inaccessibleHome,
  );

  const fileHome = '/private/credential-file';
  assertRejected(
    () => buildCodexEnvironment(fileHome, {
      platform: 'linux',
      fileSystem: {
        realpath: () => fileHome,
        isDirectory: () => false,
      },
    }),
    'codex-home-not-directory',
    fileHome,
  );
});

test('empty, whitespace-padded, and NUL-bearing homes fail before filesystem access', () => {
  const fileSystem: CodexEnvironmentFileSystem = {
    realpath() {
      assert.fail('invalid input must not reach the filesystem');
    },
    isDirectory() {
      assert.fail('invalid input must not reach the filesystem');
    },
  };

  for (const requestedHome of ['', '   ', ' /home/operator/.codex',
    '/home/operator/.codex ', '/home/operator/\u0000.codex']) {
    assertRejected(
      () => buildCodexEnvironment(requestedHome, { platform: 'linux', fileSystem }),
      'codex-home-invalid',
    );
  }
});

test('an ambient home is never a fallback when the explicit selection is absent or invalid', () => {
  const baseEnvironment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    CODEX_HOME: '/home/ambient/.codex',
    OPENAI_API_KEY: 'ambient-api-key',
  };
  const fileSystem: CodexEnvironmentFileSystem = {
    realpath() {
      assert.fail('ambient CODEX_HOME must never reach selection');
    },
    isDirectory() {
      assert.fail('ambient CODEX_HOME must never reach selection');
    },
  };

  assertRejected(
    () => buildCodexEnvironment(undefined as unknown as string, {
      baseEnvironment,
      platform: 'linux',
      fileSystem,
    }),
    'codex-home-invalid',
  );
  assertRejected(
    () => buildCodexEnvironment('relative/.codex', {
      baseEnvironment,
      platform: 'linux',
      fileSystem,
    }),
    'codex-home-not-absolute',
  );
  assert.deepEqual(baseEnvironment, {
    PATH: '/usr/bin',
    CODEX_HOME: '/home/ambient/.codex',
    OPENAI_API_KEY: 'ambient-api-key',
  });
});

test('caller-owned options and environment remain unchanged', () => {
  const codexHome = '/home/operator/.codex';
  const baseEnvironment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/operator',
    CODEX_HOME: '/home/ambient/.codex',
  };
  const fileSystem = existingDirectory(codexHome);
  const options = { baseEnvironment, platform: 'linux' as const, fileSystem };
  const environmentBefore = { ...baseEnvironment };

  const result = buildCodexEnvironment(codexHome, options);

  result.PATH = '/mutated-result-only';
  result.CODEX_HOME = '/mutated-result-home';
  assert.deepEqual(baseEnvironment, environmentBefore);
  assert.equal(options.baseEnvironment, baseEnvironment);
  assert.equal(options.fileSystem, fileSystem);
  assert.equal(options.platform, 'linux');
});
