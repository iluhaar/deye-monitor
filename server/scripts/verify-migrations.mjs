import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDirectory = join(serverDirectory, "migrations");
const wranglerCli = join(serverDirectory, "node_modules", "wrangler", "bin", "wrangler.js");
const wranglerConfig = join(serverDirectory, "wrangler.jsonc");
const persistenceBase = "/tmp/opencode";

const expectedSchema = {
  stations: [
    "id",
    "source",
    "upstream_station_id",
    "display_name",
    "mapping_revision",
    "created_at",
    "updated_at",
  ],
  latest_snapshots: [
    "station_id",
    "source",
    "grid_status",
    "grid_evidence_json",
    "grid_confidence",
    "grid_voltage_v",
    "grid_frequency_hz",
    "grid_power_w",
    "battery_soc_percent",
    "battery_power_w",
    "battery_mode",
    "home_power_w",
    "measured_at",
    "fetched_at",
    "freshness_status",
    "mapping_revision",
    "stored_at",
  ],
  grid_events: [
    "id",
    "station_id",
    "status",
    "observed_at",
    "previous_status",
    "previous_observed_at",
    "evidence_json",
    "source",
    "idempotency_key",
    "created_at",
    "gap_since",
  ],
  poll_runs: [
    "id",
    "station_id",
    "window_key",
    "started_at",
    "completed_at",
    "result",
    "latency_ms",
    "upstream_measured_at",
    "error_category",
    "observation_key",
    "outcome",
    "fencing_epoch",
  ],
  refresh_guards: [
    "station_id",
    "operation",
    "lease_owner",
    "fencing_epoch",
    "lease_until",
    "acquired_at",
    "updated_at",
    "next_allowed_at",
    "last_observed_at",
    "last_observation_key",
  ],
  refresh_commit_checks: ["valid"],
  grid_context: ["station_id", "status", "observed_at", "gap_since"],
};

function runWrangler(label, args) {
  const result = spawnSync(
    process.execPath,
    [wranglerCli, "--config", wranglerConfig, ...args],
    {
      cwd: serverDirectory,
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`${label} could not start Wrangler (${result.error.code ?? "unknown error"}).`);
  }

  if (result.status !== 0) {
    throw new Error(`${label} failed (exit code ${result.status ?? "unknown"}).`);
  }

  return result.stdout;
}

function parseRows(output, label) {
  let payload;

  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }

  if (
    !Array.isArray(payload) ||
    payload.length !== 1 ||
    payload[0].success !== true ||
    !Array.isArray(payload[0].results)
  ) {
    throw new Error(`${label} did not return a successful D1 result.`);
  }

  return payload[0].results;
}

function assertNoPendingMigrations(output) {
  if (!output.includes("No migrations to apply!")) {
    throw new Error("Wrangler reported pending D1 migrations after applying them.");
  }
}

function assertSameNames(actual, expected, label) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();

  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((name, index) => name !== sortedExpected[index])
  ) {
    throw new Error(`${label} does not match the repository migrations.`);
  }
}

function queryRows(persistenceDirectory, sql, label) {
  const output = runWrangler(label, [
    "d1",
    "execute",
    "DB",
    "--local",
    "--persist-to",
    persistenceDirectory,
    "--command",
    sql,
    "--json",
  ]);

  return parseRows(output, label);
}

async function main() {
  const migrationFiles = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  if (migrationFiles.length === 0) {
    throw new Error("No D1 migration files were found.");
  }

  await mkdir(persistenceBase, { recursive: true });
  const persistenceDirectory = await mkdtemp(join(persistenceBase, "deye-monitor-d1-"));

  try {
    const migrationCommand = [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--persist-to",
      persistenceDirectory,
    ];

    const listCommand = [
      "d1",
      "migrations",
      "list",
      "DB",
      "--local",
      "--persist-to",
      persistenceDirectory,
    ];

    runWrangler("Initial local D1 migration apply", migrationCommand);
    assertNoPendingMigrations(runWrangler("Local D1 migration status", listCommand));

    const appliedMigrations = queryRows(
      persistenceDirectory,
      "SELECT name FROM d1_migrations ORDER BY name",
      "Applied migration query",
    ).map((row) => row.name);

    assertSameNames(appliedMigrations, migrationFiles, "Applied migration set");

    const schemaTables = Object.keys(expectedSchema)
      .map((table) => `'${table}'`)
      .join(", ");

    const schemaQuery =
      "SELECT tables.name AS table_name, columns.name AS column_name " +
      "FROM sqlite_master AS tables " +
      "JOIN pragma_table_info(tables.name) AS columns " +
      `WHERE tables.type = 'table' AND tables.name IN (${schemaTables})`;

    const schemaRows = queryRows(persistenceDirectory, schemaQuery, "D1 schema query");

    const presentColumns = new Set(
      schemaRows.map((row) => `${row.table_name}.${row.column_name}`),
    );

    const missingColumns = Object.entries(expectedSchema).flatMap(([table, columns]) =>
      columns
        .filter((column) => !presentColumns.has(`${table}.${column}`))
        .map((column) => `${table}.${column}`),
    );

    if (missingColumns.length > 0) {
      throw new Error(`D1 schema is missing expected columns: ${missingColumns.join(", ")}.`);
    }

    runWrangler("Idempotent local D1 migration reapply", migrationCommand);
    assertNoPendingMigrations(runWrangler("Post-reapply D1 migration status", listCommand));
  } finally {
    await rm(persistenceDirectory, { recursive: true, force: true });
  }

  console.log(
    `Verified ${migrationFiles.length} D1 migrations and expected schema in isolated local persistence, including idempotent reapply.`,
  );
}

main().catch((error) => {
  console.error(`Local D1 migration verification failed: ${error.message}`);
  process.exitCode = 1;
});
