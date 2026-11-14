# Rune monitor clients

The web and desktop clients share Rune views and data models. Both start with
an explicitly labeled demo fixture. The desktop client subscribes to live grid
changes and displays OS notifications. No secrets are embedded or persisted.

## Build and run the web client

Install Rust 1.99.1 (the workspace pins it), the `wasm32-unknown-unknown`
target, Python 3.11 or newer, and `wasm-bindgen-cli` 0.2.129:

```sh
rustup toolchain install 1.99.1 --profile minimal
rustup target add wasm32-unknown-unknown --toolchain 1.99.1
cargo +1.99.1 install wasm-bindgen-cli --version 0.2.129 --locked
```

Then, from this directory:

```sh
./scripts/build-web.sh --dev
python3 -m http.server 8000 -d target/web
```

Open <http://localhost:8000>. The development WASM output is
`clients/target/web`; omit `--dev` for an optimized release build. Both `rune`
and `rune-kit` are pinned to upstream commit
`6345dbaa673ad52e719100d50f5b57f91cb83290`, which fixes browser timing in Rune's
launch marks and renderer warm-up. `std::time::Instant::now()` panics on
`wasm32-unknown-unknown`; Rune's `--dev` profile does not cause this, because
launch marks are active in both profiles. The fix uses Rune's platform clock
(`performance.now()` in browsers, `std::time::Instant` natively), without
disabling instrumentation. The script uses Rune's upstream
`scripts/web-build.sh` and leaves that checkout in Cargo's cache rather than
vendoring it here.

To read a server, enter its API origin and a read bearer token in the dashboard
and select **Read latest**. The token is held only in app memory. Requests
use `GET` for `/api/v1/status`, `/telemetry`, `/battery`, `/health`, and
`/events?limit=6`; the client does not call the refresh endpoint. The page
requires a browser with WebGPU or WebGL support and must be served from
localhost or HTTPS.

The current Worker API does not set browser CORS headers. For a different API
origin, serve the client and API through the same origin or configure a trusted
reverse proxy to allow the page origin, `GET`, and the `Authorization` header.
This client does not change server auth or CORS policy.

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

The browser dashboard continues to use **Read latest**. Browser WebSockets
cannot set custom `Authorization` headers, so its HTTP read flow remains
separate from the desktop subscription.
