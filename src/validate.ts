/**
 * Shared input validation for workflow tools (FR-02).
 *
 * Validation runs before anything is sent to the console. Failures are collected into a list so
 * the client sees every problem at once; `validationFailure()` in results.ts turns the list into
 * an OperationResult with outcome `failed` and no steps.
 */

export class ValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Collects validation errors; `check()` runs a validator and records its message instead of throwing. */
export class Validator {
  readonly errors: string[] = [];

  check<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ValidationError) {
        this.errors.push(err.message);
        return undefined;
      }
      throw err;
    }
  }

  fail(message: string): void {
    this.errors.push(message);
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }
}

export interface NumberOptions {
  min?: number;
  max?: number;
  integer?: boolean;
  /** Accept null/undefined and return undefined. */
  optional?: boolean;
}

/** A finite number within bounds. Rejects NaN, ±Infinity, strings and booleans. */
export function finiteNumber(field: string, value: unknown, opts: NumberOptions = {}): number | undefined {
  if (value === undefined || value === null) {
    if (opts.optional) return undefined;
    throw new ValidationError(`${field} is required`, field);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number (got ${describe(value)})`, field);
  }
  if (opts.integer && !Number.isInteger(value)) throw new ValidationError(`${field} must be an integer (got ${value})`, field);
  if (opts.min !== undefined && value < opts.min) throw new ValidationError(`${field} must be >= ${opts.min} (got ${value})`, field);
  if (opts.max !== undefined && value > opts.max) throw new ValidationError(`${field} must be <= ${opts.max} (got ${value})`, field);
  return value;
}

/** A time in seconds: zero is a deliberate value, negatives and non-finite values are refused. */
export function timeSeconds(field: string, value: unknown, opts: { optional?: boolean; max?: number } = {}): number | undefined {
  return finiteNumber(field, value, { min: 0, max: opts.max ?? 3600, optional: opts.optional });
}

/** A positive integer object number (sequence, page, executor, group, fixture ...). */
export function objectNumber(field: string, value: unknown, opts: { optional?: boolean; max?: number } = {}): number | undefined {
  return finiteNumber(field, value, { min: 1, max: opts.max ?? 99999, integer: true, optional: opts.optional });
}

/**
 * Validate a percentage 0..100 (the documented scale for RGB colour values and fader levels).
 */
export function percent(field: string, value: unknown, opts: { optional?: boolean } = {}): number | undefined {
  return finiteNumber(field, value, { min: 0, max: 100, optional: opts.optional });
}

/**
 * Cue numbers: a positive number with up to three decimals, given as a number or a string such as
 * "2.5" or "10.001". Returned in canonical string form (no trailing zeros, no exponent).
 */
export function cueNumber(field: string, value: unknown, opts: { optional?: boolean; allowZero?: boolean } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (opts.optional) return undefined;
    throw new ValidationError(`${field} is required`, field);
  }
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(`${field} must be a finite cue number`, field);
    text = value.toFixed(3).replace(/\.?0+$/, "");
    if (Math.abs(Number(text) - value) > 1e-9) throw new ValidationError(`${field} has more than three decimals (got ${value})`, field);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    throw new ValidationError(`${field} must be a number or numeric string (got ${describe(value)})`, field);
  }
  if (!/^\d{1,5}(\.\d{1,3})?$/.test(text)) {
    throw new ValidationError(`${field} must be a cue number like 1, 2.5 or 10.001 (got ${JSON.stringify(text)})`, field);
  }
  const n = Number(text);
  if (n === 0 && !opts.allowZero) throw new ValidationError(`${field} must be greater than 0`, field);
  return String(n);
}

/** Cue part number 0..999 (part 0 is the main part of a cue). */
export function partNumber(field: string, value: unknown, opts: { optional?: boolean } = {}): number | undefined {
  return finiteNumber(field, value, { min: 0, max: 999, integer: true, optional: opts.optional });
}

/**
 * Only one of the named options may be set. `options` maps option name to whether it was given.
 */
export function mutuallyExclusive(options: Record<string, unknown>, what = "options"): void {
  const given = Object.entries(options)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k]) => k);
  if (given.length > 1) throw new ValidationError(`${what} are mutually exclusive: ${given.join(", ")} were all given`);
}

/** Exactly one of the named options must be set. */
export function exactlyOne(options: Record<string, unknown>, what = "options"): string {
  const given = Object.entries(options)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k]) => k);
  if (given.length === 0) throw new ValidationError(`one of ${Object.keys(options).join(", ")} is required (${what})`);
  if (given.length > 1) throw new ValidationError(`${what} are mutually exclusive: ${given.join(", ")} were all given`);
  return given[0];
}

/**
 * Characters grandMA3 removes from object names, whether the name arrives through the command line
 * (`Label`, `Store ... "Name"`) or through the Lua `Set("Name")` API (verified on onPC 2.5.1: the
 * console silently drops them, so "Look 2.5" would become "Look 25"). Names containing them are
 * refused instead of being altered behind the client's back.
 */
export const NAME_FORBIDDEN_CHARS = '\\"$&*?,.;^{}|~';
const NAME_FORBIDDEN_RE = /[\\"$&*?,.;^{}|~]/;

/**
 * An object name (cue, sequence, executor, group ...). The console trims leading and trailing
 * whitespace itself, so the name is returned trimmed. Control characters and line breaks are refused
 * (a newline would end a command early), as are the characters the console would strip
 * (see NAME_FORBIDDEN_CHARS). Names with other characters, including `'`, `:`, `/`, `(`, `)`, `+`,
 * `-`, `_`, `=`, `!`, `@`, `#`, `%`, `<`, `>` and non-ASCII letters, are kept as given.
 */
export function objectName(field: string, value: unknown, opts: { optional?: boolean; maxLength?: number } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (opts.optional) return undefined;
    throw new ValidationError(`${field} is required`, field);
  }
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string (got ${describe(value)})`, field);
  if (/[\x00-\x1f\x7f]/.test(value)) throw new ValidationError(`${field} must not contain control characters or line breaks`, field);
  const max = opts.maxLength ?? 200;
  if (value.length > max) throw new ValidationError(`${field} is longer than ${max} characters`, field);
  const m = value.match(NAME_FORBIDDEN_RE);
  if (m) {
    throw new ValidationError(
      `${field} contains ${JSON.stringify(m[0])}, which grandMA3 removes from names; the console accepts none of ${NAME_FORBIDDEN_CHARS} in a name`,
      field,
    );
  }
  const trimmed = value.trim();
  if (trimmed === "") throw new ValidationError(`${field} must not be empty`, field);
  return trimmed;
}

/**
 * True when a name cannot be placed inside a quoted command-line string and must be set via the `set`
 * op. After `objectName()` validation this only happens for names that bypassed it (raw quotes,
 * padding, empty); it is kept so callers can defend against unvalidated input.
 */
export function needsPropertySet(name: string): boolean {
  return name.includes('"') || name.trim() !== name || name === "";
}

/** Quote a validated name for a command line. Throws if the name cannot be quoted safely. */
export function quoteName(name: string): string {
  if (needsPropertySet(name)) throw new ValidationError(`name ${JSON.stringify(name)} cannot be placed in a command line; set it as a property instead`);
  return `"${name}"`;
}

/**
 * Attribute names as grandMA3 shows them ("Dimmer", "Pan", "ColorRGB_R", "Gobo1"). Letters, digits,
 * underscore and dot only; no spaces or quotes so the name is safe inside a command.
 */
export function attributeName(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} is required`, field);
  const v = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(v)) {
    throw new ValidationError(`${field} must be an attribute name such as Dimmer, Pan or ColorRGB_R (got ${JSON.stringify(v)})`, field);
  }
  return v;
}

/**
 * A fixture selection expression in command syntax: fixture IDs and ranges ("1", "1 Thru 10",
 * "1 + 3 + 5 Thru 8", "Fixture 101 Thru 110", "Group 5", "Group 'Front Wash'" is NOT allowed
 * because of the quotes; use the group number). Returns the normalised expression with an
 * explicit object keyword.
 */
export function fixtureSelection(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} is required`, field);
  const v = value.trim().replace(/\s+/g, " ");
  // Allowed tokens: object keywords, numbers (with dotted sub-ids), Thru, +, -, and parentheses are not needed.
  const token = /^(?:Fixture|Group|Channel|Subfixture|Thru|\+|-|\d+(?:\.\d+)*)$/i;
  for (const t of v.split(" ")) {
    if (!token.test(t)) throw new ValidationError(`${field} contains an unsupported token ${JSON.stringify(t)}; use fixture IDs, ranges with Thru/+/- and Group <n>`, field);
  }
  if (/^\d/.test(v) || /^(Thru|\+|-)/i.test(v)) return `Fixture ${v}`;
  return v.replace(/^(fixture|group|channel|subfixture)/i, (m) => m[0].toUpperCase() + m.slice(1).toLowerCase());
}

/** A command-line object reference restricted to safe characters (no quotes, no newlines). */
export function safeRef(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} is required`, field);
  const v = value.trim();
  if (/["\x00-\x1f\x7f]/.test(v)) throw new ValidationError(`${field} must not contain quotes or control characters`, field);
  return v;
}

export function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[], opts: { optional?: boolean } = {}): T | undefined {
  if (value === undefined || value === null) {
    if (opts.optional) return undefined;
    throw new ValidationError(`${field} is required (one of ${allowed.join(", ")})`, field);
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(", ")} (got ${describe(value)})`, field);
  }
  return value as T;
}

export function describe(value: unknown): string {
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return typeof value;
}
