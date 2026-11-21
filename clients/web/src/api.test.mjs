import assert from "node:assert/strict";
import test from "node:test";
import { refreshTelemetry } from "./api.ts";

for (const refresh of [{ outcome: "skipped", reason: "data_recent" }, { outcome: "accepted" }]) {
  test(`refresh displays the server response without another read (${refresh.outcome})`, async (t) => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      calls.push({ url, method: init.method });
      return Response.json({ ok: true, data: { refresh, telemetry: null } });
    });

    assert.deepEqual(await refreshTelemetry(), { telemetry: null, warning: null });
    assert.deepEqual(calls, [{ url: "/api/v1/refresh", method: "POST" }]);
  });
}

for (const code of ["REFRESH_THROTTLED", "REFRESH_IN_PROGRESS"]) {
  test(`refresh falls back to stored readings only when ${code}`, async (t) => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url) => {
      calls.push(url);
      return url.endsWith("/refresh")
        ? Response.json({ ok: false, error: { code, message: "Try again later" } }, { status: 429 })
        : Response.json({ ok: true, data: null });
    });

    assert.deepEqual(await refreshTelemetry(), {
      telemetry: null,
      warning: "Try again later. Showing the latest stored readings.",
    });
    assert.deepEqual(calls, ["/api/v1/refresh", "/api/v1/telemetry"]);
  });
}

test("refresh reports upstream failures rather than silently returning cached data", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Upstream refresh failed" } },
      { status: 502 },
    ),
  );
  await assert.rejects(refreshTelemetry(), /Upstream refresh failed/);
});
