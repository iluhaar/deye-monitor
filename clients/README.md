# Deye Monitor clients

The React web client reads the server's latest inverter snapshot. The desktop
client remains a native Rune app with live grid subscriptions and OS
notifications.

## Web client

Install Node.js 20.19 or newer, then from this directory:

```sh
cd web
npm ci
cp .env.example .env.local
```

Set `VITE_SERVER_URL`, `VITE_API_BEARER_TOKEN`, and `VITE_REFRESH_TOKEN` in
`clients/web/.env.local`. The example leaves `VITE_SERVER_URL` blank; the Vite
development proxy then defaults to `http://localhost:8787`. Set it to another
API origin to override the development proxy target. From
`clients/web`, start the page with:

```sh
npm run dev
```

The page reads `GET /api/v1/telemetry` on startup. **Refresh** sends
`POST /api/v1/refresh` with the bearer token and `X-Refresh-Token`, then reads
`GET /api/v1/telemetry` again. A server fetch from within the previous 60
seconds causes refresh to be skipped as `data_recent`. Otherwise, a separate
server-configured refresh interval of 1–3600 seconds may throttle the request.
In either case, the page reads and displays the latest stored readings.

The client shows grid state, voltage/frequency/power, battery charge and power,
house load, freshness, and measurement/fetch times. The current server telemetry
does not expose solar readings, so the page marks solar as unavailable.
Measurement freshness is based on the reading's `measuredAt`; `fetchedAt` is
shown separately as the time the server last collected the data.

Use `npm run typecheck` for TypeScript checking, `npm test` for Worker security
tests, and `npm run build` to produce the static site in `clients/web/dist`.
All browser API requests are same-origin. In development, Vite proxies them to
`VITE_SERVER_URL` (default `http://localhost:8787`).

**Development credential warning:** Vite's `VITE_*` credentials are visible in
the development browser. Use local/test credentials only. Production builds
reject non-empty `VITE_SERVER_URL`, `VITE_API_BEARER_TOKEN`, and
`VITE_REFRESH_TOKEN`. Remove these from `.env.local` and the build environment
before building for deployment; never put them in Workers Builds variables.

### Separate web Worker with Cloudflare Access

Traffic is: browser → Cloudflare Access login → `deye-monitor-web` → service
binding → API Worker. The web Worker serves the React assets and exposes only
`GET /api/v1/telemetry` and `POST /api/v1/refresh`. It validates the Access JWT
(signature, issuer, audience, expiry) **before serving any asset or API request**.
API credentials are injected by the Worker and never sent to the browser.
The API server and desktop authentication do not change.

The Access application for `monitor.illiadot.dev` is **Deye Monitor**
(`7f978ce0-89da-4ef7-ac04-39d9a65ed9ae`). It uses the existing Cloudflare-account
identity provider and the reusable **Allow Illia** policy, which allows only
`iluhaar@gmail.com`. Its team domain and audience are recorded in the Worker
config. Email one-time PIN is not enabled for this application.

Before deploying:

1. The web Worker's configured custom hostname is `monitor.illiadot.dev`.
   Ensure its zone is managed by the intended Cloudflare account.
2. In Cloudflare Zero Trust, create a **Self-hosted** Access application covering
   that entire hostname (all paths). Attach a reusable **Allow** policy for
   specific trusted email addresses or IdP groups. For this hostname, the
   application and policy are already configured; do not create duplicates.
   Use your identity provider,
   or email one-time PIN login. Do not use an Everyone allow or Bypass policy.
   Cloudflare Access login is separate from Cloudflare dashboard login.
3. In `clients/web/wrangler.jsonc`, set `ACCESS_TEAM_DOMAIN` to
   `https://<team>.cloudflareaccess.com` (no trailing slash), and `ACCESS_AUD` to
   that Access application's Audience tag. These are not secrets. Empty values
   intentionally deny all requests.
4. The top-level custom-domain route is already configured:

   ```json
   "routes": [{ "pattern": "monitor.illiadot.dev", "custom_domain": true }]
   ```

5. Verify the `API` service binding target. It defaults to
   `deye-monitor-server-production`, the name Wrangler derives from the server's
   `production` environment. The API Worker must already be deployed and configured.
6. Store the same API read and refresh tokens configured on the API Worker as
   secrets on the **web** Worker. Run from `clients/web`; Wrangler prompts for
   each value. Do not paste them into source, command arguments, or chat:

   ```sh
   npx wrangler secret put API_BEARER_TOKEN
   npx wrangler secret put REFRESH_TOKEN
   ```

   These commands may prompt to create the named Worker if it does not exist.
   Refresh still requires explicit activation and upstream configuration on the
   API Worker; see [`docs/manual-refresh.md`](../docs/manual-refresh.md).
7. With all development `VITE_*` values blank/unset, validate and deploy:

   ```sh
   npm run types
   npm test
   npm run deploy:check
   npm run deploy
   ```

`workers_dev` and version preview URLs are disabled to avoid alternate public
entrypoints. Keep `assets.run_worker_first: true`; removing it can bypass the
Worker's authentication check for static files. Never disable authentication
for local testing: use Vite for frontend development, or signed test JWTs in
Worker tests.

After deployment, test in a private browser: an authorized user can load the
page and refresh; a non-allowlisted user cannot load the page or assets. Confirm
unauthenticated API requests hit the login gate, alternate Worker URLs are
unavailable, and API responses are `no-store`. Check Access authentication logs
and that the API's per-client IP rate limits still work over the service binding.
An expired session may surface as an unreadable API response; reload to log in.

The checked-in config does not create an Access application or policy. Do not
declare the site protected until those live checks pass. To roll back, remove
the custom-domain route or roll back the web Worker version; retain the Access
application and do not weaken the API's existing bearer-token requirements.

## Desktop subscriptions

On a supported Linux or Windows desktop, from this directory:

```sh
cargo run -p deye-monitor-desktop
```

Enter the API origin and read bearer token, then select **Connect & subscribe**.
Use HTTPS for a remote server; HTTP is supported for loopback development
origins such as `http://localhost:8787`.

The desktop client:

- Reads telemetry, health, and recent events when connecting.
- Opens an authenticated WebSocket to `/api/v1/events/subscribe`, with the
  bearer token in the handshake header.
- Updates recent events as grid changes arrive and refreshes the stored
  dashboard after replay catches up. These reads are event-driven, not polling.
- Saves each processed checkpoint before acknowledging it. Resume cursors and
  the latest 256 processed event IDs are stored atomically in the OS application
  data directory, under `subscriptions/<API-origin-hash>.json`.
- Reconnects with the saved cursor after interruption, using backoff and jitter,
  respecting server rate limits, and renewing authorization before expiry.
- Automatically resynchronizes when the server's retained history no longer
  contains its cursor.
- Shows OS alerts for new transitions observed after connecting and no more than
  two minutes old. Older replay updates the event list without producing alerts.

The token stays in memory only and must be entered again after restarting.
Authorization rejection stops reconnects until you reconnect with valid
credentials. **Disconnect** cancels the subscription and pending reconnects.
To reset resume state manually, remove the API origin's JSON cursor file while
disconnected.

Keep the app open or minimized to receive updates. Closing the app ends the
subscription. OS alerts use the desktop's notification service and permissions;
Do Not Disturb and OS settings control their presentation.

The web page is a separate HTTP-only client. It does not change the desktop
subscriber or its WebSocket authentication flow.
