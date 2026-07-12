export type ULID = string;

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const RESOURCE_CURSOR_PATTERN = /^(?:0|[1-9][0-9]*)$/;

/** Exact app-minted ULID syntax. Lowercase and ambiguous Crockford characters
 * are rejected so durable/browser identity checks agree with SQLite. */
export function isUlid(value: unknown): value is ULID {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/** Canonical non-negative SQLite rowid cursor. It is safe to convert to a JS
 * number and cannot carry leading zeroes, signs, decimals, or exponents. */
export function isResourceCursor(value: unknown): value is string {
  if (typeof value !== 'string' || !RESOURCE_CURSOR_PATTERN.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

export type ApiErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: ApiErrorCode; details?: unknown };

export type ApiOk<T extends object = {}> = { ok: true } & T;

export interface ApiErr<TDetails = unknown> {
  ok: false;
  error: string;
  code?: ApiErrorCode;
  details?: TDetails;
}

export type ApiResult<TOk extends object, TDetails = unknown> =
  | ApiOk<TOk>
  | ApiErr<TDetails>;

export function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function parseErr(
  error: string,
  code: ApiErrorCode = 'VALIDATION',
  details?: unknown,
): ParseResult<never> {
  return details === undefined
    ? { ok: false, error, code }
    : { ok: false, error, code, details };
}
