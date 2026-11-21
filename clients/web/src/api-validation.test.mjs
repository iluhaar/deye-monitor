import assert from "node:assert/strict";
import test from "node:test";
import { isRecord, isRefreshResult, isTelemetry } from "./api-validation.ts";

const telemetry = {
  source: "inverter",
  grid: {
    status: "online",
    evidence: ["voltage"],
    confidence: "confirmed",
    voltageV: 230,
    frequencyHz: 50,
    powerW: null,
  },
  battery: { socPercent: 80, powerW: 100, mode: "charging" },
  home: { powerW: 200 },
  measuredAt: null,
  fetchedAt: "2026-11-22T00:00:00Z",
  freshness: { status: "fresh", ageSeconds: 0 },
};

test("JSON record guard rejects non-object responses", () => {
  assert.equal(isRecord({}), true);
  for (const value of [undefined, null, [], "data", 1]) {
    assert.equal(isRecord(value), false);
  }
});

test("telemetry guard accepts readings and an explicit empty reading", () => {
  assert.equal(isTelemetry(telemetry), true);
  assert.equal(isTelemetry(null), true);
});

test("telemetry guard rejects missing data and malformed nested fields", () => {
  for (const value of [
    undefined,
    {},
    [],
    { ...telemetry, fetchedAt: undefined },
    { ...telemetry, grid: null },
    { ...telemetry, grid: { ...telemetry.grid, evidence: [1] } },
    { ...telemetry, grid: { ...telemetry.grid, status: "invalid" } },
    { ...telemetry, battery: { ...telemetry.battery, mode: "invalid" } },
    { ...telemetry, battery: { ...telemetry.battery, socPercent: "80" } },
    { ...telemetry, home: { powerW: Number.NaN } },
    { ...telemetry, freshness: { status: "fresh", ageSeconds: "0" } },
  ]) {
    assert.equal(isTelemetry(value), false);
  }
});

test("refresh guard accepts optional metadata and rejects malformed responses", () => {
  for (const value of [
    { telemetry: null },
    { telemetry, refresh: {} },
    {
      telemetry,
      refresh: { outcome: "skipped", reason: "data_recent" },
    },
  ]) {
    assert.equal(isRefreshResult(value), true);
  }
  for (const value of [
    undefined,
    null,
    [],
    {},
    { telemetry: {} },
    { telemetry: null, refresh: null },
    {
      telemetry,
      refresh: { outcome: 1 },
    },
    { telemetry, refresh: { reason: false } },
  ]) {
    assert.equal(isRefreshResult(value), false);
  }
});
