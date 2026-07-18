export const PRESEAL_CONFIG_AUTHORITY_PROJECTION_ALGORITHM =
  'pc-sdk.cx-004.preseal-config-authority-projection.v1';

export const PRESEAL_RECEIPT_BINDING_SENTINEL =
  'pc-sdk.cx-004.preseal-receipt-binding-sentinel.v1';

export const MAX_PRESEAL_PAYLOAD_MEMBERS = 16_384;

function fail(message) {
  throw new Error(`CX-004 preseal config projection: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function countPresealPayloadMembers(value) {
  if (value === null || typeof value !== 'object') return 1;
  if (Array.isArray(value)) {
    return 1 + value.reduce((total, entry) => total + countPresealPayloadMembers(entry), 0);
  }
  return 1 + Object.entries(value).reduce(
    (total, [key, entry]) => (
      total + 1 + countPresealPayloadMembers(key) + countPresealPayloadMembers(entry)
    ),
    0,
  );
}

export function presealConfigAuthorityProjection(config) {
  if (!isPlainObject(config) || !isPlainObject(config.root) ||
      !isPlainObject(config.root.provenance) ||
      !Object.hasOwn(config.root.provenance, 'presealReceipt') ||
      !Array.isArray(config.surfaces)) {
    fail('input did not contain the exact receipt-bearing config structure');
  }
  const receiptSurfaceIndexes = [];
  for (const [index, surface] of config.surfaces.entries()) {
    if (!isPlainObject(surface) || typeof surface.surfaceId !== 'string') {
      fail('surface closure was malformed');
    }
    if (surface.surfaceId === 'preseal-receipt') receiptSurfaceIndexes.push(index);
  }
  if (receiptSurfaceIndexes.length !== 1) {
    fail('config must contain exactly one preseal-receipt surface');
  }

  const projection = structuredClone(config);
  projection.root.provenance.presealReceipt = PRESEAL_RECEIPT_BINDING_SENTINEL;
  projection.surfaces.splice(receiptSurfaceIndexes[0], 1);
  return projection;
}
