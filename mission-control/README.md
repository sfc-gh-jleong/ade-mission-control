# mission-control

The ADE Mission Control app: a Next.js 16 app on Snowflake App Runtime (`ADE_DB.APP.ADE_MISSION_CONTROL`). See the repository README for the architecture.

## What runs where

| Path | Role |
| --- | --- |
| `instrumentation.ts` → `lib/server/boot.ts` | On server start (deployed only): self-tests, agent registry sync, orchestrator loop |
| `lib/server/agents/` | Agent definitions (instructions, submit tools), registry (SDK create/update), turn runner (streaming telemetry), zod schemas, SQL guard, prompts |
| `lib/server/orchestrator.ts` | Incident state machine, leases, Fixer↔Reviewer loop, verification |
| `lib/server/rehearsal/` | Sandbox clone / reproduce / apply / verify engine |
| `lib/server/telemetry.ts` | Per-step rows in `ADE_DB.OPS.AGENT_STEPS` and payloads in `ADE_DB.TELEMETRY.STEP_PAYLOADS` |
| `lib/server/actions.ts` | Human actions through `ADE_DB.GUARD`, run with the signed-in user's caller's rights |
| `lib/server/seal.ts` | HMAC seals on fixes and reviews (key mounted from `ADE_DB.SECRETS.SEAL_KEY`) |
| `app/api/stream` | Server-Sent Events: live agent activity |
| `app/` pages | Command Center, Incidents, incident detail, Fleet, Analytics, Chaos Lab, Settings |
| `lib/sar-sdk/`, `lib/snowflake.ts` | Template Snowflake connectivity (owner's and caller's rights) |

## Run, test, deploy

```bash
npm ci --include=dev
npm run typecheck
npm test                       # SQL guard, rehearsal rewriting, confidence caps, formatters
npm run build

# Local UI against live data (agents and orchestrator stay off locally):
SNOWFLAKE_CONNECTION_NAME=<key-pair connection> npm run dev

# Deploy (the deploying role becomes the service's execution role; always ADE_APP_ROLE):
snow app deploy --verbose --role ADE_APP_ROLE -c <connection>
```

Pushes to `main` deploy through GitHub Actions (`../.github/workflows/deploy.yml`).

## Pitfalls

- Never run `node .next/standalone/server.js` for local preview; use `npm run dev` or `npm run start`.
- Do not remove the `turbopack.root` / `outputFileTracingRoot` pin in `next.config.mjs`.
- `app.yml` is a v2 manifest applied declaratively: settings changed with `ALTER APPLICATION SERVICE` are reverted on the next deploy.
- The service stays at one instance (`min_instances = max_instances = 1`): the in-process event bus and leases assume a single orchestrator.
- The readiness probe has no caller token; keep `/` free of caller's-rights SQL.
