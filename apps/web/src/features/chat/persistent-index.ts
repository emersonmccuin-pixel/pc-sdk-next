// A small immutable ordered index for projector receipts. Nodes are path-copied
// on update, so every previously returned ChatState remains branchable. The
// heap rank is derived from the key, which also makes the final tree shape
// independent of insertion order (unlike a mutable Map or insertion-shaped
// search tree).

export interface PersistentIndexNode<Value> {
  readonly key: string;
  readonly rank: number;
  readonly value: Value;
  readonly left: PersistentIndexNode<Value> | null;
  readonly right: PersistentIndexNode<Value> | null;
  readonly size: number;
}

export type PersistentIndex<Value> = PersistentIndexNode<Value> | null;

function keyRank(key: string): number {
  // FNV-1a followed by an avalanche mix. The key is the deterministic
  // tie-breaker, so even a 32-bit rank collision has one canonical ordering.
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function node<Value>(
  key: string,
  value: Value,
  left: PersistentIndex<Value>,
  right: PersistentIndex<Value>,
  rank = keyRank(key),
): PersistentIndexNode<Value> {
  return {
    key,
    rank,
    value,
    left,
    right,
    size: 1 + (left?.size ?? 0) + (right?.size ?? 0),
  };
}

function before<Value>(
  left: PersistentIndexNode<Value>,
  right: PersistentIndexNode<Value>,
): boolean {
  return left.rank < right.rank || (left.rank === right.rank && left.key < right.key);
}

function rotateRight<Value>(root: PersistentIndexNode<Value>): PersistentIndexNode<Value> {
  const pivot = root.left!;
  const movedRoot = node(root.key, root.value, pivot.right, root.right, root.rank);
  return node(pivot.key, pivot.value, pivot.left, movedRoot, pivot.rank);
}

function rotateLeft<Value>(root: PersistentIndexNode<Value>): PersistentIndexNode<Value> {
  const pivot = root.right!;
  const movedRoot = node(root.key, root.value, root.left, pivot.left, root.rank);
  return node(pivot.key, pivot.value, movedRoot, pivot.right, pivot.rank);
}

export function indexGet<Value>(
  root: PersistentIndex<Value>,
  key: string,
): Value | undefined {
  let current = root;
  while (current) {
    if (key === current.key) return current.value;
    current = key < current.key ? current.left : current.right;
  }
  return undefined;
}

export function indexSet<Value>(
  root: PersistentIndex<Value>,
  key: string,
  value: Value,
): PersistentIndexNode<Value> {
  if (!root) return node(key, value, null, null);
  if (key === root.key) {
    if (Object.is(value, root.value)) return root;
    return node(root.key, value, root.left, root.right, root.rank);
  }
  if (key < root.key) {
    const next = node(
      root.key,
      root.value,
      indexSet(root.left, key, value),
      root.right,
      root.rank,
    );
    return before(next.left!, next) ? rotateRight(next) : next;
  }
  const next = node(
    root.key,
    root.value,
    root.left,
    indexSet(root.right, key, value),
    root.rank,
  );
  return before(next.right!, next) ? rotateLeft(next) : next;
}

function merge<Value>(
  left: PersistentIndex<Value>,
  right: PersistentIndex<Value>,
): PersistentIndex<Value> {
  if (!left) return right;
  if (!right) return left;
  if (before(left, right)) {
    return node(left.key, left.value, left.left, merge(left.right, right), left.rank);
  }
  return node(right.key, right.value, merge(left, right.left), right.right, right.rank);
}

export function indexDelete<Value>(
  root: PersistentIndex<Value>,
  key: string,
): PersistentIndex<Value> {
  if (!root) return root;
  if (key === root.key) return merge(root.left, root.right);
  if (key < root.key) {
    const left = indexDelete(root.left, key);
    return left === root.left
      ? root
      : node(root.key, root.value, left, root.right, root.rank);
  }
  const right = indexDelete(root.right, key);
  return right === root.right
    ? root
    : node(root.key, root.value, root.left, right, root.rank);
}

export function indexEntries<Value>(
  root: PersistentIndex<Value>,
): Array<readonly [string, Value]> {
  const entries: Array<readonly [string, Value]> = [];
  const stack: PersistentIndexNode<Value>[] = [];
  let current = root;
  while (current || stack.length > 0) {
    while (current) {
      stack.push(current);
      current = current.left;
    }
    const next = stack.pop()!;
    entries.push([next.key, next.value] as const);
    current = next.right;
  }
  return entries;
}
