import { createHash } from 'node:crypto';
import { createServer, type Server as NetServer } from 'node:net';

export type KernelWitnessKind = 'windows-named-pipe' | 'linux-abstract-socket';

export interface KernelWitness {
  readonly server: NetServer;
  readonly kind: KernelWitnessKind;
  readonly address: string;
}

/** Stable SHA-256 address material shared by every cooperative process. */
export function kernelWitnessDigest(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

/**
 * Bind one non-filesystem, process-owned witness.
 *
 * `prefix` is part of the compatibility protocol. It must remain stable across
 * builds that are expected to exclude one another.
 */
export async function acquireKernelWitness(
  prefix: string,
  identity: string,
): Promise<KernelWitness> {
  if (!/^[a-z0-9-]+$/.test(prefix)) {
    throw Object.assign(new Error('kernel witness prefix is invalid'), {
      code: 'INVALID_WITNESS_PREFIX',
    });
  }
  const address = kernelWitnessAddress(prefix, identity);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address.path);
  });
  // A witness is authority while the engine is alive, but it must not keep an
  // otherwise-finished process alive. Unexpected post-listen errors retain
  // Node's default fatal behavior.
  server.unref();
  return { server, kind: address.kind, address: address.path };
}

export function closeKernelWitness(server: NetServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error?: Error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function kernelWitnessAddress(
  prefix: string,
  identity: string,
): { path: string; kind: KernelWitnessKind } {
  const digest = kernelWitnessDigest(identity);
  if (process.platform === 'win32') {
    return {
      path: `\\\\.\\pipe\\${prefix}-${digest}`,
      kind: 'windows-named-pipe',
    };
  }
  if (process.platform === 'linux') {
    return {
      path: `\0${prefix}-${digest}`,
      kind: 'linux-abstract-socket',
    };
  }
  throw Object.assign(
    new Error(`kernel witnesses are not implemented for ${process.platform}`),
    { code: 'UNSUPPORTED_WITNESS_PLATFORM' },
  );
}
