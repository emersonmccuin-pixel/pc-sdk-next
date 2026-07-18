import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertManifestSetMatchesDisk,
  generateManifestSetFromConfig,
  writeManifestSet,
} from './manifest-set.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(SCRIPT_DIRECTORY, 'native-build-input.config.json');

export function parseGenerateArguments(argv) {
  const options = {
    check: false,
    configPath: DEFAULT_CONFIG,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
    } else if (argument === '--help') {
      options.help = true;
    } else {
      throw new Error(`unsupported argument ${JSON.stringify(argument)}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseGenerateArguments(argv);
  if (options.help) {
    process.stdout.write(
      'Usage: node toolchain/generate-native-build-input.mjs [--check]\n',
    );
    return;
  }
  const generated = await generateManifestSetFromConfig(options.configPath);
  const receipt = options.check
    ? await assertManifestSetMatchesDisk(generated.manifestSet, generated.outputDirectory, {
      forbiddenSubstrings: generated.forbiddenSubstrings,
    })
    : await writeManifestSet(generated.manifestSet, generated.outputDirectory, {
      forbiddenSubstrings: generated.forbiddenSubstrings,
    });
  process.stdout.write(`${JSON.stringify({
    action: options.check ? 'source-inputs-checked' : 'generated',
    ...receipt,
  })}\n`);
}

const invokedPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`CX-004 native-build-input generation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
