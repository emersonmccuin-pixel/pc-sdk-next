import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertManifestSetMatchesDisk,
  generateManifestSetFromConfig,
  ROOT_FILE_NAME,
  verifyManifestSet,
} from './manifest-set.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(SCRIPT_DIRECTORY, 'native-build-input.config.json');

export function parseVerifyArguments(argv) {
  const options = {
    forbiddenSubstrings: [],
    rootPath: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const takeValue = () => {
      index += 1;
      if (index >= argv.length || argv[index].startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      return argv[index];
    };
    if (argument === '--root') {
      options.rootPath = path.resolve(takeValue());
    } else if (argument === '--forbid') {
      options.forbiddenSubstrings.push(takeValue());
    } else if (argument === '--help') {
      options.help = true;
    } else {
      throw new Error(`unsupported argument ${JSON.stringify(argument)}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseVerifyArguments(argv);
  if (options.help) {
    process.stdout.write(
      'Usage: node toolchain/verify-native-build-input.mjs [--root FILE] [--forbid TEXT]\n',
    );
    return;
  }
  let receipt;
  let action;
  if (options.rootPath !== undefined) {
    receipt = await verifyManifestSet({
      forbiddenSubstrings: options.forbiddenSubstrings,
      rootPath: options.rootPath,
    });
    action = 'closure-verified';
  } else {
    const generated = await generateManifestSetFromConfig(DEFAULT_CONFIG);
    receipt = await assertManifestSetMatchesDisk(generated.manifestSet, generated.outputDirectory, {
      forbiddenSubstrings: [...generated.forbiddenSubstrings, ...options.forbiddenSubstrings],
    });
    action = 'source-inputs-verified';
  }
  process.stdout.write(`${JSON.stringify({ action, ...receipt })}\n`);
}

const invokedPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`CX-004 native-build-input verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
