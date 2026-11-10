# ADE Mission Control

Autonomous data-engineer agents for Snowflake. When a scheduled job fails in a monitored database, three Cortex Code agents take it from detection to a reviewed, sandbox-proven fix, and a person approves the production change. Every agent step records time taken, tokens, model, task performed and details, and Mission Control (a Snowflake App Runtime app) shows it all live.

```
 detect (1 min)      Investigator          Fixer             sandbox            Reviewer           human            guard
 ─────────────▶  diagnose with   ─▶  write fix with ─▶  clone, reproduce ─▶ score 0-100,  ─▶  approve the  ─▶  apply as the
 failed task /   read-only SQL       {{DB}} params       fail, apply fix,     different model  exact hash        approver, snapshot,
 DT / alert      claude-sonnet-5     claude-opus-5       rerun -> PASSED      openai-gpt-5.4                     verify next run
                                          ▲                                        │
                                          └──────────── REVISE (max 2 loops) ──────┘
```

## How it works

| Piece | Where | What it does |
| --- | --- | --- |
| Detector | `ADE_DB.CORE.DETECTOR_TASK` (serverless, every minute) | Reads `TASK_HISTORY`, `DYNAMIC_TABLE_REFRESH_HISTORY`, `ALERT_HISTORY` for registered databases, keeps a job inventory, fingerprints failures into deduplicated incidents, links cascade symptoms to their root, backfills 14 days on first scan. Fast path ~3 s; full scan every 10 min. |
| Agents | `ADE_DB.AGENTS.ADE_INVESTIGATOR / ADE_FIXER / ADE_REVIEWER` | Saved Cortex Agent objects with the managed Cortex Code toolset (`code_toolset_all`), created and updated by the app through `@snowflake/cortex-agent-sdk`. Each ends its turn with a client-side submit tool whose payload is validated with zod. |
| Orchestrator | inside the app (`lib/server/orchestrator.ts`) | Claims incidents with leases on hybrid tables, runs Investigate → Fix → Rehearse → Review, loops Fixer↔Reviewer up to 2 times, escalates when unsure, enforces token/time budgets and a kill switch. Wakes on a sequence "doorbell" (metadata only), so the warehouse stays idle when nothing fails. |
| Rehearsal | `ADE_SBX_<incident>_<attempt>` databases | Zero-copy clones of the tables a job touches, the job recreated with its database rewritten, failure reproduced, fix applied, job re-run. PASSED / FAILED / INCONCLUSIVE / UNSUPPORTED caps the Reviewer's confidence (≤40 on FAILED, ≤70 otherwise). |
| Guard | `ADE_DB.GUARD` (owned by SYSADMIN) | `APPROVE_FIX`, `REJECT_FIX`, `APPLY_FIX`, `ROLLBACK_FIX`, `RUN_JOB`. Called with the signed-in person's caller's rights; checks the approver list, recomputes the fix hash, re-screens every statement, snapshots DDL, applies, audits. |
| Telemetry | `ADE_DB.OPS.AGENT_STEPS` (+ `TELEMETRY.STEP_PAYLOADS`) | One row per agent turn, tool call and system step: actor, phase, task, model, thinking effort, start/end/duration, input / uncached / cache-read / cache-write / output tokens, run/thread/request ids, summary, details. Credits reconciled from `CORTEX_AGENT_USAGE_HISTORY` every 20 min (telemetry tokens match billing within ~1–2%). |
| UI | `ADE_DB.APP.ADE_MISSION_CONTROL` | Command Center, Incidents, incident detail with live agent trace, fix diff, rehearsal log, review scorecard and approval gate, Fleet, Analytics, Chaos Lab, Settings. |

### Storage

- **Hybrid tables** (`ADE_DB.OPS`): incidents, leases, agent runs/steps, diagnoses, fixes, rehearsals, reviews, audit log, settings. Row-level reads/writes with enforced PK/FK, indexed for the UI.
- **Standard tables + views** (`ADE_DB.TELEMETRY`): bulky step payloads, billed usage, health checks, analytics views.
- No Postgres: the workload is small, point-oriented and lives next to the data it monitors.

### Security model

| Role | Who | Can |
| --- | --- | --- |
| `ADE_APP_ROLE` | the app's service identity **and the agents** (their sandbox SQL runs as it) | read monitored databases; `SELECT/INSERT/UPDATE` ADE state (no DDL, no DELETE, audit log insert-only, settings read-only); own the rehearsal sandboxes. Cannot see the GUARD procedures. |
| `ADE_OWNER_ROLE` | owns `ADE_DB` state and the detector | not used by the app |
| `ADE_OPERATOR_ROLE` | people (via the app, caller's rights) | change settings; call GUARD procedures (approvers listed in `ADE_DB.GUARD.APPROVERS`) |
| `SYSADMIN` | owns the monitored jobs and `ADE_DB.GUARD` | the only identity that changes production, inside `APPLY_FIX` |

Proven: the agents' production write probe is refused by RBAC; `APPLY_FIX` refuses without a standing approval in `GUARD.DECISIONS`; approval refuses a stale hash; the app role cannot even resolve the GUARD procedures. Fixes and reviews are HMAC-sealed with a container-only secret, so tampering by anything else is shown as such.

## Repository layout

```
sql/                          run in order on a new account
  00_foundation.sql           roles, warehouse, databases, schemas, account grants
  01_ops_tables.sql           hybrid state tables + default settings
  02_telemetry.sql            telemetry tables + analytics views
  03_scope_grants.sql         monitor a database:  -D "db=MY_DB"
  04_app_privileges.sql       least-privilege DML + caller grants
  05_detector.sql             detector procedure + task
  06_guard.sql                approvals / apply / rollback (SYSADMIN-owned)
  07_usage_reconcile.sql      billed credits -> agent runs
  08_cicd_service_user.sql    GitHub Actions OIDC service user
  90_demo_pipeline.sql        ADE_DEMO_RETAIL + Chaos Lab scenarios
  99_teardown.sql             remove everything
mission-control/              the App Runtime app (Next.js)
.github/workflows/            ci.yml (PR checks), deploy.yml (OIDC deploy on push to main)
```

## Set up on an account

```bash
for f in 00_foundation 01_ops_tables 02_telemetry 04_app_privileges 05_detector 06_guard 07_usage_reconcile 90_demo_pipeline; do
  snow sql -f sql/$f.sql -c <connection>
done
snow sql -f sql/03_scope_grants.sql -D "db=ADE_DEMO_RETAIL" -c <connection>   # one per monitored database
snow sql -q "CALL ADE_DB.CHAOS.RESET_DEMO()" -c <connection>
cd mission-control && snow app deploy --role ADE_APP_ROLE -c <connection>
```

`04_app_privileges.sql` also creates the random HMAC seal key `ADE_DB.SECRETS.SEAL_KEY` (READ-only for `ADE_APP_ROLE`); `app.yml` mounts it into the container.

## Operating

- **Kill switch:** Settings → "Pause all agents" (`pipeline.enabled`), or `UPDATE ADE_DB.OPS.SETTINGS ... 'pipeline.enabled'`.
- **Models:** Settings → `models.investigator|fixer|reviewer`; the app updates the saved agents.
- **Budgets:** `budget.max_tokens_per_incident`, `budget.max_minutes_per_agent`, plus server-side `orchestration.budget` on each agent.
- **Approvers / managed databases:** SYSADMIN maintains `ADE_DB.GUARD.APPROVERS` and `ADE_DB.GUARD.MANAGED_DATABASES`.
- **History backlog:** incidents found in the first scan's 14-day backfill are listed but not auto-processed; "Send to the agents" queues one.
- **Cost:** one always-on App Runtime instance (`auto_suspend_secs: 0`, so incidents are handled with nobody watching); the detector's serverless task (~3 s/min); agent turns (typically ~0.3–0.5 credits each; a full incident with one review loop ~1–2 credits).

## Development

```bash
cd mission-control
npm ci --include=dev
npm run typecheck && npm test && npm run build
SNOWFLAKE_CONNECTION_NAME=<key-pair connection> npm run dev   # UI against live data; agents stay off locally
```

Agents never run locally by default: locally they would use your default role instead of `ADE_APP_ROLE`. `ADE_ALLOW_LOCAL_AGENTS=1` / `ADE_BACKGROUND=1` override this for deliberate testing.

## CI/CD

`.github/workflows/ci.yml` runs typecheck, tests and a production build on pull requests. `.github/workflows/deploy.yml` reuses it as a gate, then deploys on push to `main` with GitHub OIDC → Snowflake workload identity (service user `GHA_ADE_APP_SVC`, role `ADE_APP_ROLE`, GitHub environment `prod`). No credentials are stored in GitHub. See `sql/08_cicd_service_user.sql`.
