import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "./index.ts";

test("Access gates assets and API; verified requests use the private proxy", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" };
  const issuer = "https://test-team.cloudflareaccess.com";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  };
  let assets = 0;
  const forwarded = [];
  const env = {
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUD: "test-audience",
    API_BEARER_TOKEN: "server-read-secret",
    REFRESH_TOKEN: "server-refresh-secret",
    ASSETS: { fetch: async () => { assets++; return new Response("private asset"); } },
    API: { fetch: async (request) => {
      forwarded.push(request);
      return Response.json({ ok: true, data: null });
    } },
  };
  async function token(options = {}) {
    return new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(options.issuer ?? issuer)
      .setAudience(options.audience ?? env.ACCESS_AUD)
      .setSubject("user-id").setExpirationTime(options.exp ?? "5m").sign(privateKey);
  }
  async function call(path, jwt, init = {}, bindings = env) {
    const headers = new Headers(init.headers);
    if (jwt) headers.set("Cf-Access-Jwt-Assertion", jwt);
    headers.set("CF-Connecting-IP", "192.0.2.1");
    return worker.fetch(new Request(`https://monitor.example.com${path}`, {
      ...init, headers,
    }), bindings);
  }
  try {
    for (const path of ["/", "/assets/app.js", "/api/v1/telemetry"]) {
      assert.equal((await call(path)).status, 403);
      assert.equal((await call(path, "forged")).status, 403);
    }
    for (const options of [
      { audience: "wrong" }, { issuer: "https://wrong.cloudflareaccess.com" }, { exp: 1 },
    ]) {
      assert.equal((await call("/", await token(options))).status, 403);
    }
    assert.equal(assets, 0);
    assert.equal(forwarded.length, 0);
    const jwt = await token();
    assert.equal((await call("/", jwt, {}, { ...env, ACCESS_AUD: "" })).status, 403);
    const page = await call("/", jwt);
    assert.equal(await page.text(), "private asset");
    assert.equal(page.headers.get("Cache-Control"), "no-store");
    const read = await call("/api/v1/telemetry", jwt, {
      headers: { Authorization: "Bearer attacker", Cookie: "private=cookie" },
    });
    assert.equal(read.status, 200);
    assert.equal(forwarded[0].headers.get("Authorization"), "Bearer server-read-secret");
    assert.equal(forwarded[0].headers.get("Cookie"), null);
    assert.equal(forwarded[0].headers.get("Cf-Access-Jwt-Assertion"), null);
    assert.equal(forwarded[0].headers.get("X-Refresh-Token"), null);
    assert.equal(forwarded[0].headers.get("CF-Connecting-IP"), "192.0.2.1");
    assert.equal((await call("/api/v1/events", jwt)).status, 404);
    assert.equal((await call("/api/v1/telemetry?x=1", jwt)).status, 400);
    assert.equal((await call("/api/v1/refresh", jwt, { method: "POST" })).status, 403);
    assert.equal((await call("/api/v1/refresh", jwt, {
      method: "POST", headers: { Origin: "https://evil.example" },
    })).status, 403);
    assert.equal((await call("/api/v1/refresh", jwt, {
      method: "POST", headers: { Origin: "https://monitor.example.com" },
    })).status, 200);
    assert.equal(forwarded[1].headers.get("X-Refresh-Token"), "server-refresh-secret");
    assert.equal(forwarded[1].headers.get("Content-Length"), "0");
    const forwardedBeforeInvalidBodies = forwarded.length;
    for (const init of [
      { body: "{}" },
      { headers: { "Content-Length": "2" }, body: "{}" },
      { headers: { "Transfer-Encoding": "chunked" }, body: "{}" },
      { headers: { "Transfer-Encoding": "chunked", "Content-Length": "0" }, body: "" },
    ]) {
      assert.equal((await call("/api/v1/refresh", jwt, {
        ...init,
        method: "POST",
        headers: { Origin: "https://monitor.example.com", ...init.headers },
      })).status, 400);
    }
    assert.equal(forwarded.length, forwardedBeforeInvalidBodies);
    // Reproduce Workerd's non-null stream on an empty browser POST.
    const emptyPost = new Request("https://monitor.example.com/api/v1/refresh", {
      method: "POST",
      body: "",
      headers: {
        Origin: "https://monitor.example.com",
        "Content-Length": "0",
        "CF-Connecting-IP": "192.0.2.1",
        "Cf-Access-Jwt-Assertion": jwt,
      },
    });
    assert.notEqual(emptyPost.body, null);
    assert.equal((await worker.fetch(emptyPost, env)).status, 200);
    assert.equal(forwarded.length, forwardedBeforeInvalidBodies + 1);
    assert.equal(forwarded.at(-1).body, null);
    assert.equal(forwarded.at(-1).headers.get("Content-Length"), "0");
    assert.equal((await call("/api/v1/telemetry", jwt, {}, {
      ...env, API_BEARER_TOKEN: "",
    })).status, 503);
    assert.equal((await call("/api/v1/telemetry", jwt, {}, {
      ...env, API: { fetch: async () => Response.redirect("https://evil.example") },
    })).status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
