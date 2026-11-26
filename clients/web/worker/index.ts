import { createRemoteJWKSet, jwtVerify } from "jose";

type Env = WorkerBindings;

// YASNO publishes the DTEK Kyiv Electrical Networks schedule. The browser cannot
// call it: the response has no CORS headers.
const YASNO_PLANNED_OUTAGES_URL =
  "https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages";
const MAX_SCHEDULE_BYTES = 1_000_000;

// Cache signing keys, never request identity or credentials.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function failure(status: number, code: string, message: string): Response {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function requestHasBody(request: Request): boolean {
  if (request.headers.has("Transfer-Encoding")) {
    return true;
  }
  const contentLength = request.headers.get("Content-Length");
  // Workerd can expose a non-null, empty POST stream for Content-Length: 0.
  // Use HTTP framing, matching the API server's no-body validation.
  return contentLength !== null ? contentLength !== "0" : request.body !== null;
}

function isJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function proxyPlannedOutages(): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(YASNO_PLANNED_OUTAGES_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
  } catch {
    return failure(502, "UPSTREAM_ERROR", "Outage schedule unavailable");
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return failure(502, "UPSTREAM_ERROR", "Unexpected schedule redirect");
  }
  if (!upstream.ok) {
    return failure(502, "UPSTREAM_ERROR", "Outage schedule unavailable");
  }

  const body = await upstream.text();
  if (body.length > MAX_SCHEDULE_BYTES) {
    return failure(502, "UPSTREAM_ERROR", "Outage schedule unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return failure(502, "UPSTREAM_ERROR", "Outage schedule unavailable");
  }
  if (!isJsonObject(parsed)) {
    return failure(502, "UPSTREAM_ERROR", "Outage schedule unavailable");
  }
  return Response.json(parsed, {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (
    !token ||
    !env.ACCESS_AUD ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN)
  ) {
    return false;
  }
  try {
    let keys = keySets.get(env.ACCESS_TEAM_DOMAIN);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
      keySets.set(env.ACCESS_TEAM_DOMAIN, keys);
    }
    await jwtVerify(token, keys, {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub"],
    });
    return true;
  } catch {
    return false;
  }
}

export async function handleAuthenticated(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/v1/outage-schedule") {
      if (request.method !== "GET") {
        return failure(404, "NOT_FOUND", "Not found");
      }
      if (url.search) {
        return failure(
          400,
          "INVALID_REQUEST",
          "Query parameters and request bodies are not supported",
        );
      }
      return proxyPlannedOutages();
    }
    const telemetry = url.pathname === "/api/v1/telemetry" && request.method === "GET";
    const refresh = url.pathname === "/api/v1/refresh" && request.method === "POST";
    if (!telemetry && !refresh) {
      return failure(404, "NOT_FOUND", "Not found");
    }
    if (url.search || (refresh && requestHasBody(request))) {
      return failure(
        400,
        "INVALID_REQUEST",
        "Query parameters and request bodies are not supported",
      );
    }
    // Cookie-authenticated writes must originate from this app, not another site.
    if (refresh && request.headers.get("Origin") !== url.origin) {
      return failure(403, "FORBIDDEN", "Same-origin request required");
    }
    if (!env.API_BEARER_TOKEN || (refresh && !env.REFRESH_TOKEN)) {
      return failure(503, "UNAVAILABLE", "API credentials are not configured");
    }
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip) {
      return failure(503, "UNAVAILABLE", "Client identity unavailable");
    }
    // Build a fresh header set: never forward browser cookies or supplied credentials.
    const headers = new Headers({
      Authorization: `Bearer ${env.API_BEARER_TOKEN}`,
      "CF-Connecting-IP": ip,
    });
    if (refresh) {
      headers.set("X-Refresh-Token", env.REFRESH_TOKEN);
      headers.set("Content-Length", "0");
    }
    try {
      const upstream = await env.API.fetch(
        new Request(`https://api.internal${url.pathname}`, {
          method: request.method,
          headers,
          redirect: "manual",
        }),
      );
      if (upstream.status >= 300 && upstream.status < 400) {
        return failure(502, "UPSTREAM_ERROR", "Unexpected API redirect");
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return failure(502, "UPSTREAM_ERROR", "API unavailable");
    }
  }
  const asset = await env.ASSETS.fetch(request);
  const response = new Response(asset.body, asset);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  return response;
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!(await authorized(request, env))) {
      return failure(403, "ACCESS_REQUIRED", "Cloudflare Access login required");
    }
    return handleAuthenticated(request, env);
  },
} satisfies ExportedHandler<Env>;
