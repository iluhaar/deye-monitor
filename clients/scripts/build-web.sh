#!/usr/bin/env bash
set -euo pipefail

clients_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$clients_root"

rune_manifest=$(cargo metadata --format-version 1 | python3 -c '
import json, sys
metadata = json.load(sys.stdin)
package = next((p for p in metadata["packages"] if p["name"] == "rune"), None)
if package is None:
    sys.exit("Rune dependency was not resolved")
print(package["manifest_path"])
')
rune_root=${rune_manifest%/crates/rune/Cargo.toml}

"$rune_root/scripts/web-build.sh" deye-monitor-web --out target/web --no-html "$@"
cp web/index.html target/web/index.html
printf 'Web client output: %s/target/web\n' "$clients_root"
