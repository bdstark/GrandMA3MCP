import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Validator,
  ValidationError,
  finiteNumber,
  timeSeconds,
  objectNumber,
  percent,
  cueNumber,
  partNumber,
  mutuallyExclusive,
  exactlyOne,
  objectName,
  needsPropertySet,
  quoteName,
  attributeName,
  fixtureSelection,
  safeRef,
  oneOf,
} from "../src/validate.ts";

const throws = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ValidationError && re.test((e as Error).message));

test("finiteNumber rejects NaN, infinities, strings and out-of-range values; zero is accepted", () => {
  assert.equal(finiteNumber("x", 0, { min: 0 }), 0);
  assert.equal(finiteNumber("x", 2.5), 2.5);
  throws(() => finiteNumber("x", Number.NaN), /finite number/);
  throws(() => finiteNumber("x", Number.POSITIVE_INFINITY), /finite number/);
  throws(() => finiteNumber("x", "3"), /finite number/);
  throws(() => finiteNumber("x", -1, { min: 0 }), />= 0/);
  throws(() => finiteNumber("x", 1.5, { integer: true }), /integer/);
  throws(() => finiteNumber("x", undefined), /required/);
  assert.equal(finiteNumber("x", undefined, { optional: true }), undefined);
});

test("time and percent helpers", () => {
  assert.equal(timeSeconds("fade", 0), 0);
  throws(() => timeSeconds("fade", -0.1), />= 0/);
  throws(() => timeSeconds("fade", Number.NaN), /finite/);
  assert.equal(percent("r", 100), 100);
  throws(() => percent("r", 101), /<= 100/);
  assert.equal(objectNumber("seq", 1), 1);
  throws(() => objectNumber("seq", 0), />= 1/);
  throws(() => objectNumber("seq", 1.5), /integer/);
});

test("cue numbers: integers, fractions up to three decimals, canonical form", () => {
  assert.equal(cueNumber("cue", 1), "1");
  assert.equal(cueNumber("cue", 2.5), "2.5");
  assert.equal(cueNumber("cue", "10.001"), "10.001");
  assert.equal(cueNumber("cue", "3.10"), "3.1");
  throws(() => cueNumber("cue", 0), /greater than 0/);
  assert.equal(cueNumber("cue", 0, { allowZero: true }), "0");
  throws(() => cueNumber("cue", 1.0001), /three decimals/);
  throws(() => cueNumber("cue", "1.2.3"), /cue number like/);
  throws(() => cueNumber("cue", "abc"), /cue number like/);
  throws(() => cueNumber("cue", -1), /cue number like/);
  throws(() => cueNumber("cue", '1 "x'), /cue number like/);
  assert.equal(partNumber("part", 0), 0);
  throws(() => partNumber("part", -1), />= 0/);
});

test("mutually exclusive and exactly-one option checks", () => {
  mutuallyExclusive({ merge: true, overwrite: undefined });
  throws(() => mutuallyExclusive({ merge: true, overwrite: true }), /mutually exclusive: merge, overwrite/);
  assert.equal(exactlyOne({ fixtures: "1 Thru 5", use_selection: false }), "fixtures");
  throws(() => exactlyOne({ fixtures: undefined, use_selection: false }), /one of fixtures, use_selection is required/);
  throws(() => exactlyOne({ fixtures: "1", use_selection: true }), /mutually exclusive/);
});

test("names: control characters and console-stripped characters refused, whitespace trimmed", () => {
  assert.equal(objectName("name", "Front Wash"), "Front Wash");
  assert.equal(objectName("name", "  padded  "), "padded", "the console trims names itself");
  assert.equal(objectName("name", "Café Ünïcode (2) + 'x' @ 50%"), "Café Ünïcode (2) + 'x' @ 50%");
  throws(() => objectName("name", "a\nb"), /control characters/);
  throws(() => objectName("name", 5), /must be a string/);
  throws(() => objectName("name", "   "), /must not be empty/);
  // Verified on onPC 2.5.1: these are silently removed from a name by both Label and Set("Name").
  for (const ch of ['\\', '"', "$", "&", "*", "?", ",", ".", ";", "^", "{", "}", "|", "~"]) {
    throws(() => objectName("name", `a${ch}b`), /removes from names/);
  }
  throws(() => objectName("name", "Look 2.5"), /removes from names/);
  assert.equal(needsPropertySet('He said "hi"'), true);
  assert.equal(needsPropertySet(" padded"), true);
  assert.equal(needsPropertySet(""), true);
  assert.equal(needsPropertySet("Plain"), false);
  assert.equal(quoteName("Plain"), '"Plain"');
  throws(() => quoteName('a"b'), /cannot be placed in a command line/);
});

test("attribute names and references are restricted to command-safe characters", () => {
  assert.equal(attributeName("attribute", "ColorRGB_R"), "ColorRGB_R");
  assert.equal(attributeName("attribute", " Pan "), "Pan");
  throws(() => attributeName("attribute", "Pan Tilt"), /attribute name/);
  throws(() => attributeName("attribute", 'Pan" At 50'), /attribute name/);
  throws(() => attributeName("attribute", ""), /required/);
  assert.equal(safeRef("ref", "Sequence 1 Cue 2"), "Sequence 1 Cue 2");
  throws(() => safeRef("ref", 'Sequence "x"'), /quotes/);
  assert.equal(oneOf("mode", "merge", ["create", "merge", "overwrite"] as const), "merge");
  throws(() => oneOf("mode", "replace", ["create", "merge"] as const), /one of create, merge/);
});

test("fixture selections: ranges and groups normalise, anything else is refused", () => {
  assert.equal(fixtureSelection("fixtures", "1 Thru 10"), "Fixture 1 Thru 10");
  assert.equal(fixtureSelection("fixtures", "101"), "Fixture 101");
  assert.equal(fixtureSelection("fixtures", "fixture 1 + 3 + 5 thru 8"), "Fixture 1 + 3 + 5 thru 8");
  assert.equal(fixtureSelection("fixtures", "Group 5"), "Group 5");
  assert.equal(fixtureSelection("fixtures", "Fixture 1.1 Thru 1.4"), "Fixture 1.1 Thru 1.4");
  throws(() => fixtureSelection("fixtures", 'Group "Front"'), /unsupported token/);
  throws(() => fixtureSelection("fixtures", "Fixture 1; ClearAll"), /unsupported token/);
  throws(() => fixtureSelection("fixtures", "Sequence 1"), /unsupported token/);
  throws(() => fixtureSelection("fixtures", ""), /required/);
});

test("Validator collects several errors instead of stopping at the first", () => {
  const v = new Validator();
  v.check(() => timeSeconds("fade", -1));
  v.check(() => cueNumber("cue", "x"));
  const ok = v.check(() => objectNumber("sequence", 3));
  assert.equal(ok, 3);
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 2);
  assert.throws(() =>
    v.check(() => {
      throw new TypeError("not a validation problem");
    }),
  );
});
