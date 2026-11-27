import assert from "node:assert/strict";
import test from "node:test";
import { resolveTheme, THEME_COLOR } from "./theme.ts";

test("resolveTheme follows the system when nothing is stored", () => {
  assert.equal(resolveTheme(null, true), "dark");
  assert.equal(resolveTheme(null, false), "light");
  assert.equal(resolveTheme("system", true), "dark");
});

test("resolveTheme keeps an explicit choice over the system preference", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("theme colors match the page backgrounds", () => {
  assert.equal(THEME_COLOR.light, "#f4f6f8");
  assert.equal(THEME_COLOR.dark, "#10161c");
});
