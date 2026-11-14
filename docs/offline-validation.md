# Local verification

Run from `server/`:

```sh
npm ci
npm run verify
```

The verification gate runs these commands in sequence:

| Command | Purpose |
| --- | --- |
| `npm run lint` | Check source code with Oxlint; warnings fail the command |
| `npm run typecheck` | Check TypeScript types |
| `npm run build` | Bundle the Worker with Wrangler's deployment dry-run |

Each command can also be run individually. The gate does not deploy the Worker
or access remote D1.

## Local database and development

```sh
npm run db:migrate:local
npm run dev
```

Local configuration and authentication are documented in the
[manual refresh guide](manual-refresh.md) and [security runbook](security.md).
Keep credentials in local secret files or the approved secret store, not in
source code or command arguments.

The [operator evidence](validation-evidence.md) document records the separately
supplied live-refresh baseline.
