# Rune monitor clients

The web client is the first read-only dashboard; the native client is a demo
scaffold that uses the same Rune views and data models. Both start with an
explicitly labeled demo fixture. No secrets are embedded or persisted.

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

## Native demo scaffold

On a supported Linux or Windows desktop, from this directory:

```sh
cargo run -p deye-monitor-desktop
```

The native scaffold currently shows the demo fixture only. The web client is
the only client with browser HTTP transport in this initial build.
