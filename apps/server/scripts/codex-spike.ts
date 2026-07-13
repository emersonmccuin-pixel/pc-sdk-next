import { startCodexAppServer } from '../src/runner/codex/app-server-client.ts';
import {
  parseCodexSpikeArguments,
  runCodexAdmissionSpike,
  safeCodexSpikeFailureCode,
} from '../src/runner/codex/spike.ts';

async function main(): Promise<void> {
  try {
    const options = parseCodexSpikeArguments(process.argv.slice(2));
    const receipt = await runCodexAdmissionSpike(options, {
      clientFactory: startCodexAppServer,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: { code: safeCodexSpikeFailureCode(error) },
    })}\n`);
    process.exitCode = 1;
  }
}

void main();
