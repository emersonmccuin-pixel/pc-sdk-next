// Immutable append-oriented sequence for stable presentation history. Each
// append copies at most one small tail chunk instead of the full prior array.
// The representation is plain data so projector states remain structuredClone-
// safe and branchable.

export const PERSISTENT_SEQUENCE_CHUNK_SIZE = 32;

export interface PersistentSequenceChunk<Value> {
  readonly previous: PersistentSequenceChunk<Value> | null;
  readonly values: readonly Value[];
}

export interface PersistentSequence<Value> {
  readonly length: number;
  readonly tail: PersistentSequenceChunk<Value> | null;
}

export function emptySequence<Value>(): PersistentSequence<Value> {
  return { length: 0, tail: null };
}

export function sequenceAppend<Value>(
  sequence: PersistentSequence<Value>,
  value: Value,
): PersistentSequence<Value> {
  const tail = sequence.tail;
  if (!tail) {
    return { length: 1, tail: { previous: null, values: [value] } };
  }
  if (tail.values.length < PERSISTENT_SEQUENCE_CHUNK_SIZE) {
    return {
      length: sequence.length + 1,
      tail: { previous: tail.previous, values: [...tail.values, value] },
    };
  }
  return {
    length: sequence.length + 1,
    tail: { previous: tail, values: [value] },
  };
}

export function sequenceToArray<Value>(sequence: PersistentSequence<Value>): Value[] {
  const values = new Array<Value>(sequence.length);
  let offset = sequence.length;
  let chunk = sequence.tail;
  while (chunk) {
    offset -= chunk.values.length;
    for (let index = 0; index < chunk.values.length; index += 1) {
      values[offset + index] = chunk.values[index]!;
    }
    chunk = chunk.previous;
  }
  return values;
}
