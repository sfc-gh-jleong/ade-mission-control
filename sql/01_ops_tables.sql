/* =====================================================================
   01 — Operational state: hybrid tables in ADE_DB.OPS
   ---------------------------------------------------------------------
   Hybrid tables hold everything the app reads and writes at row level:
   incident leases and state transitions, one row per agent step, fix
   approvals. Enforced PK/FK/UNIQUE keep the state machine honest, and
   indexed point reads keep the UI fast.

   Hybrid-table rules applied here:
   - Every table has a PRIMARY KEY; FOREIGN KEY columns are NOT NULL
     (hybrid FKs reject NULL), so optional links (root incident, agent run
     of a SYSTEM step) carry no FK.
   - Indexes use VARCHAR / NUMBER / TIMESTAMP_NTZ only (no VARIANT/ARRAY,
     no TIMESTAMP_TZ). All timestamps are UTC TIMESTAMP_NTZ (SYSDATE()).
   - No CHECK constraints on status columns: a hybrid CHECK cannot be
     added or altered later, and the status vocabulary is enforced in the
     app (lib/domain.ts).
   - Bulky payloads (tool inputs/outputs, transcripts) live in the standard
     table ADE_DB.TELEMETRY.STEP_PAYLOADS, not here.

   Run as ADE_OWNER_ROLE (then 04_app_privileges.sql):
     snow sql -f sql/01_ops_tables.sql -c osm_deploy
   Idempotent (CREATE ... IF NOT EXISTS).
   ===================================================================== */
USE ROLE ADE_OWNER_ROLE;
USE WAREHOUSE ADE_WH;
USE SCHEMA ADE_DB.OPS;

-- Monitored databases ("scopes"). Grants for each are applied by an admin
-- with 03_scope_grants.sql; the detector only scans ENABLED scopes.
CREATE HYBRID TABLE IF NOT EXISTS SCOPES (
  SCOPE_ID          VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  DATABASE_NAME     VARCHAR(255)  NOT NULL,
  SCHEMA_FILTER     VARCHAR(2000),                 -- NULL = all schemas; else comma-separated
  JOB_TYPES         VARCHAR(200)  NOT NULL DEFAULT 'TASK,DYNAMIC_TABLE,ALERT,PIPE',
  APPLY_MODE        VARCHAR(20)   NOT NULL DEFAULT 'HUMAN_APPROVED',  -- PROPOSE_ONLY | HUMAN_APPROVED | AUTO_LOW_RISK
  ENABLED           BOOLEAN       NOT NULL DEFAULT TRUE,
  WATERMARK_AT      TIMESTAMP_NTZ,                 -- detector high-water mark (UTC)
  LAST_SCAN_AT      TIMESTAMP_NTZ,
  LAST_SCAN_STATUS  VARCHAR(20),
  LAST_SCAN_MS      NUMBER(38,0),
  LAST_SCAN_ERROR   VARCHAR(4000),
  CREATED_BY        VARCHAR(255),
  CREATED_AT        TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  UPDATED_AT        TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  CONSTRAINT PK_SCOPES PRIMARY KEY (SCOPE_ID),
  CONSTRAINT UQ_SCOPES_DB UNIQUE (DATABASE_NAME)
)
COMMENT = 'Monitored databases and detector watermarks';

-- Job inventory: tasks, dynamic tables, alerts, pipes in each scope.
-- JOB_ID = SHA2(JOB_TYPE || '|' || FQN) so the detector can address a job
-- without a lookup.
CREATE HYBRID TABLE IF NOT EXISTS JOBS (
  JOB_ID            VARCHAR(64)   NOT NULL,
  SCOPE_ID          VARCHAR(64)   NOT NULL,
  JOB_TYPE          VARCHAR(20)   NOT NULL,          -- TASK | DYNAMIC_TABLE | ALERT | PIPE
  DATABASE_NAME     VARCHAR(255)  NOT NULL,
  SCHEMA_NAME       VARCHAR(255)  NOT NULL,
  JOB_NAME          VARCHAR(255)  NOT NULL,
  FQN               VARCHAR(800)  NOT NULL,
  OWNER_ROLE        VARCHAR(255),
  WAREHOUSE         VARCHAR(255),
  SCHEDULE          VARCHAR(500),                    -- task schedule / DT target lag / alert schedule
  STATE             VARCHAR(50),                     -- started | suspended | ACTIVE | SUSPENDED ...
  PREDECESSORS      ARRAY,
  ROOT_TASK         VARCHAR(800),
  DEFINITION        VARCHAR(16777216),
  DEFINITION_HASH   VARCHAR(64),
  COMMENT           VARCHAR(2000),
  LAST_RUN_AT       TIMESTAMP_NTZ,
  LAST_STATUS       VARCHAR(40),
  LAST_SUCCESS_AT   TIMESTAMP_NTZ,
  LAST_FAILURE_AT   TIMESTAMP_NTZ,
  LAST_ERROR        VARCHAR(4000),
  RUNS_24H          NUMBER(38,0)  NOT NULL DEFAULT 0,
  FAILURES_24H      NUMBER(38,0)  NOT NULL DEFAULT 0,
  IS_ACTIVE         BOOLEAN       NOT NULL DEFAULT TRUE,   -- FALSE once the object is dropped
  FIRST_SEEN_AT     TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  UPDATED_AT        TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  CONSTRAINT PK_JOBS PRIMARY KEY (JOB_ID),
  CONSTRAINT FK_JOBS_SCOPE FOREIGN KEY (SCOPE_ID) REFERENCES SCOPES (SCOPE_ID),
  INDEX IX_JOBS_SCOPE (SCOPE_ID, JOB_TYPE),
  INDEX IX_JOBS_FQN (FQN)
)
COMMENT = 'Inventory of monitored jobs (tasks, dynamic tables, alerts, pipes)';

-- Terminal job runs in scope (successes and failures), kept 14 days for the
-- fleet timeline and as incident evidence. RUN_KEY = SHA2 of the run's
-- natural key (task: job + scheduled time + attempt; DT: job + refresh id).
CREATE HYBRID TABLE IF NOT EXISTS JOB_RUNS (
  RUN_KEY             VARCHAR(64)   NOT NULL,
  JOB_ID              VARCHAR(64)   NOT NULL,
  SCOPE_ID            VARCHAR(64)   NOT NULL,
  STATE               VARCHAR(40)   NOT NULL,        -- SUCCEEDED | FAILED | CANCELLED | SKIPPED | UPSTREAM_FAILED ...
  SCHEDULED_AT        TIMESTAMP_NTZ,
  STARTED_AT          TIMESTAMP_NTZ,
  COMPLETED_AT        TIMESTAMP_NTZ,
  DURATION_MS         NUMBER(38,0),
  ERROR_CODE          VARCHAR(40),
  ERROR_MESSAGE       VARCHAR(8000),
  QUERY_ID            VARCHAR(100),
  GRAPH_RUN_GROUP_ID  VARCHAR(100),
  ATTEMPT_NUMBER      NUMBER(10,0),
  ROOT_TASK_ID        VARCHAR(100),
  DETAILS             VARIANT,
  INGESTED_AT         TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  CONSTRAINT PK_JOB_RUNS PRIMARY KEY (RUN_KEY),
  CONSTRAINT FK_RUNS_JOB FOREIGN KEY (JOB_ID) REFERENCES JOBS (JOB_ID),
  INDEX IX_RUNS_JOB_TIME (JOB_ID, SCHEDULED_AT),
  INDEX IX_RUNS_SCOPE_TIME (SCOPE_ID, SCHEDULED_AT)
)
COMMENT = 'Terminal runs of monitored jobs (14-day window)';

-- One incident per distinct failure (FINGERPRINT = job + error class +
-- normalized message). Repeats bump OCCURRENCES instead of opening new
-- incidents. Cascade symptoms (UPSTREAM_FAILED children, failures in the same
-- graph run) point at their root via ROOT_INCIDENT_ID.
CREATE HYBRID TABLE IF NOT EXISTS INCIDENTS (
  INCIDENT_ID         VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  INCIDENT_NUMBER     NUMBER(38,0)  NOT NULL,          -- human-friendly ADE-1042
  SCOPE_ID            VARCHAR(64)   NOT NULL,
  JOB_ID              VARCHAR(64)   NOT NULL,
  JOB_TYPE            VARCHAR(20)   NOT NULL,
  JOB_FQN             VARCHAR(800)  NOT NULL,
  DATABASE_NAME       VARCHAR(255)  NOT NULL,
  FINGERPRINT         VARCHAR(64)   NOT NULL,
  ROOT_INCIDENT_ID    VARCHAR(64),                     -- cascade symptom -> root (no FK: nullable)
  TITLE               VARCHAR(500)  NOT NULL,
  SUMMARY             VARCHAR(4000),                   -- one-line root cause once diagnosed
  CATEGORY            VARCHAR(40),                     -- Investigator taxonomy
  SEVERITY            VARCHAR(10)   NOT NULL DEFAULT 'MEDIUM',   -- CRITICAL | HIGH | MEDIUM | LOW
  STATUS              VARCHAR(30)   NOT NULL DEFAULT 'DETECTED',
  STATUS_DETAIL       VARCHAR(1000),
  ERROR_CODE          VARCHAR(40),
  ERROR_MESSAGE       VARCHAR(8000),
  FIRST_RUN_KEY       VARCHAR(64),
  LAST_RUN_KEY        VARCHAR(64),
  LAST_QUERY_ID       VARCHAR(100),
  GRAPH_RUN_GROUP_ID  VARCHAR(100),
  OCCURRENCES         NUMBER(38,0)  NOT NULL DEFAULT 1,
  SYMPTOM_COUNT       NUMBER(38,0)  NOT NULL DEFAULT 0,
  FIRST_SEEN_AT       TIMESTAMP_NTZ NOT NULL,
  LAST_SEEN_AT        TIMESTAMP_NTZ NOT NULL,
  CONFIDENCE          NUMBER(5,2),                     -- latest capped Reviewer confidence
  CURRENT_FIX_ID      VARCHAR(64),
  FIX_ITERATIONS      NUMBER(10,0)  NOT NULL DEFAULT 0,
  ATTEMPTS            NUMBER(10,0)  NOT NULL DEFAULT 0, -- pipeline attempts (crash/retry)
  LEASE_OWNER         VARCHAR(200),
  LEASE_EXPIRES_AT    TIMESTAMP_NTZ,
  TOTAL_TOKENS        NUMBER(38,0)  NOT NULL DEFAULT 0,
  TOTAL_AGENT_MS      NUMBER(38,0)  NOT NULL DEFAULT 0,
  TOTAL_CREDITS       NUMBER(18,6),
  IS_BACKFILL         BOOLEAN       NOT NULL DEFAULT FALSE,
  INVESTIGATOR_THREAD_ID VARCHAR(64),                  -- Cortex thread per agent (continuations keep context)
  FIXER_THREAD_ID     VARCHAR(64),
  REVIEWER_THREAD_ID  VARCHAR(64),
  QUEUED_BY           VARCHAR(255),                    -- user who queued a backfill incident for the agents
  CREATED_AT          TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  UPDATED_AT          TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  RESOLVED_AT         TIMESTAMP_NTZ,
  CONSTRAINT PK_INCIDENTS PRIMARY KEY (INCIDENT_ID),
  CONSTRAINT UQ_INCIDENTS_NUMBER UNIQUE (INCIDENT_NUMBER),
  CONSTRAINT FK_INC_JOB FOREIGN KEY (JOB_ID) REFERENCES JOBS (JOB_ID),
  INDEX IX_INC_STATUS (STATUS, UPDATED_AT),
  INDEX IX_INC_FINGERPRINT (FINGERPRINT, STATUS),
  INDEX IX_INC_JOB (JOB_ID, LAST_SEEN_AT),
  INDEX IX_INC_SEEN (LAST_SEEN_AT)
)
COMMENT = 'Deduplicated job-failure incidents and their pipeline state';

CREATE SEQUENCE IF NOT EXISTS INCIDENT_NUMBER_SEQ START = 1001 INCREMENT = 1 ORDER
  COMMENT = 'Human-friendly incident numbers (ADE-1001, ...)';

-- One row per agent invocation (one Cortex thread turn per phase).
CREATE HYBRID TABLE IF NOT EXISTS AGENT_RUNS (
  AGENT_RUN_ID        VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  INCIDENT_ID         VARCHAR(64)   NOT NULL,
  AGENT_ROLE          VARCHAR(20)   NOT NULL,          -- INVESTIGATOR | FIXER | REVIEWER
  AGENT_FQN           VARCHAR(500)  NOT NULL,
  AGENT_SPEC_HASH     VARCHAR(64),
  ITERATION           NUMBER(10,0)  NOT NULL DEFAULT 1,
  STATUS              VARCHAR(20)   NOT NULL DEFAULT 'RUNNING',  -- RUNNING | SUCCEEDED | FAILED | CANCELLED
  MODEL               VARCHAR(100),
  THINKING_EFFORT     VARCHAR(20),
  THREAD_ID           VARCHAR(64),
  CORTEX_RUN_ID       VARCHAR(100),
  REQUEST_ID          VARCHAR(100),
  STARTED_AT          TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  ENDED_AT            TIMESTAMP_NTZ,
  DURATION_MS         NUMBER(38,0),
  TOOL_CALLS          NUMBER(10,0)  NOT NULL DEFAULT 0,
  INPUT_TOKENS        NUMBER(38,0)  NOT NULL DEFAULT 0,
  UNCACHED_INPUT_TOKENS NUMBER(38,0) NOT NULL DEFAULT 0,
  CACHE_READ_TOKENS   NUMBER(38,0)  NOT NULL DEFAULT 0,
  CACHE_WRITE_TOKENS  NUMBER(38,0)  NOT NULL DEFAULT 0,
  OUTPUT_TOKENS       NUMBER(38,0)  NOT NULL DEFAULT 0,
  CREDITS             NUMBER(18,6),
  ERROR_MESSAGE       VARCHAR(4000),
  CONSTRAINT PK_AGENT_RUNS PRIMARY KEY (AGENT_RUN_ID),
  CONSTRAINT FK_AR_INC FOREIGN KEY (INCIDENT_ID) REFERENCES INCIDENTS (INCIDENT_ID),
  INDEX IX_AR_INC (INCIDENT_ID, STARTED_AT),
  INDEX IX_AR_TIME (STARTED_AT)
)
COMMENT = 'Agent invocations (one per phase turn) with rolled-up telemetry';

-- Per-step telemetry: every turn, tool call and orchestrator system step,
-- each with time taken, tokens, model, task performed and details.
CREATE HYBRID TABLE IF NOT EXISTS AGENT_STEPS (
  STEP_ID             VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  INCIDENT_ID         VARCHAR(64)   NOT NULL,
  AGENT_RUN_ID        VARCHAR(64),                     -- NULL for SYSTEM steps (no FK: nullable)
  PARENT_STEP_ID      VARCHAR(64),                     -- tool calls -> their TURN step
  SEQ                 NUMBER(10,0)  NOT NULL,          -- order within the incident
  KIND                VARCHAR(20)   NOT NULL,          -- TURN | TOOL_CALL | SYSTEM
  ACTOR               VARCHAR(20)   NOT NULL,          -- INVESTIGATOR | FIXER | REVIEWER | SYSTEM
  PHASE               VARCHAR(40),                     -- INVESTIGATE | FIX | REHEARSE | REVIEW | APPLY | VERIFY ...
  TASK                VARCHAR(1000) NOT NULL,          -- what was done, human-readable
  STATUS              VARCHAR(20)   NOT NULL DEFAULT 'RUNNING',  -- RUNNING | SUCCEEDED | FAILED | SKIPPED
  MODEL               VARCHAR(100),
  THINKING_EFFORT     VARCHAR(20),
  STARTED_AT          TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  ENDED_AT            TIMESTAMP_NTZ,
  DURATION_MS         NUMBER(38,0),
  INPUT_TOKENS        NUMBER(38,0)  NOT NULL DEFAULT 0,
  UNCACHED_INPUT_TOKENS NUMBER(38,0) NOT NULL DEFAULT 0,
  CACHE_READ_TOKENS   NUMBER(38,0)  NOT NULL DEFAULT 0,
  CACHE_WRITE_TOKENS  NUMBER(38,0)  NOT NULL DEFAULT 0,
  OUTPUT_TOKENS       NUMBER(38,0)  NOT NULL DEFAULT 0,
  CREDITS             NUMBER(18,6),
  TOOL_NAME           VARCHAR(200),
  TOOL_TYPE           VARCHAR(100),
  TOOL_USE_ID         VARCHAR(200),
  CORTEX_RUN_ID       VARCHAR(100),
  THREAD_ID           VARCHAR(64),
  REQUEST_ID          VARCHAR(100),
  LAST_EVENT_SEQ      NUMBER(38,0),                    -- SSE resume cursor
  SUMMARY             VARCHAR(4000),
  DETAIL              VARIANT,                         -- small structured detail (per-model usage, query ids)
  ERROR_MESSAGE       VARCHAR(4000),
  CONSTRAINT PK_AGENT_STEPS PRIMARY KEY (STEP_ID),
  CONSTRAINT FK_STEP_INC FOREIGN KEY (INCIDENT_ID) REFERENCES INCIDENTS (INCIDENT_ID),
  INDEX IX_STEP_INC (INCIDENT_ID, SEQ),
  INDEX IX_STEP_TIME (STARTED_AT),
  INDEX IX_STEP_RUN (AGENT_RUN_ID)
)
COMMENT = 'Per-step agent telemetry: time, tokens, model, task, details';

-- Investigator output (submit_diagnosis).
CREATE HYBRID TABLE IF NOT EXISTS DIAGNOSES (
  DIAGNOSIS_ID        VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  INCIDENT_ID         VARCHAR(64)   NOT NULL,
  AGENT_RUN_ID        VARCHAR(64)   NOT NULL,
  CATEGORY            VARCHAR(40),
  SEVERITY            VARCHAR(10),
  ROOT_CAUSE          VARCHAR(8000),
  FIXABILITY          VARCHAR(40),                     -- SQL_FIX | DATA_FIX | TRANSIENT_RETRY | EXTERNAL | NEEDS_HUMAN
  IS_TRANSIENT        BOOLEAN,
  CONFIDENCE          NUMBER(5,2),
  RECOMMENDATION      VARCHAR(8000),
  EVIDENCE            ARRAY,
  AFFECTED_OBJECTS    ARRAY,
  PAYLOAD             VARIANT,
  CREATED_AT          TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  CONSTRAINT PK_DIAGNOSES PRIMARY KEY (DIAGNOSIS_ID),
  CONSTRAINT FK_DIAG_INC FOREIGN KEY (INCIDENT_ID) REFERENCES INCIDENTS (INCIDENT_ID),
  CONSTRAINT FK_DIAG_RUN FOREIGN KEY (AGENT_RUN_ID) REFERENCES AGENT_RUNS (AGENT_RUN_ID),
  INDEX IX_DIAG_INC (INCIDENT_ID)
)
COMMENT = 'Investigator diagnoses';

-- Fixer output (submit_fix). STATEMENTS are parameterized with {{DB}} /
-- {{SCHEMA}} so the same text runs against the sandbox clone and production.
-- FIX_HASH pins exactly what was reviewed and approved; APPLY_FIX refuses to
-- run anything whose hash changed.
CREATE HYBRID TABLE IF NOT EXISTS FIXES (
  FIX_ID              VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  INCIDENT_ID         VARCHAR(64)   NOT NULL,
  VERSION             NUMBER(10,0)  NOT NULL,
  AGENT_RUN_ID        VARCHAR(64)   NOT NULL,
  STATUS              VARCHAR(30)   NOT NULL DEFAULT 'PROPOSED',
  TITLE               VARCHAR(500),
  SUMMARY             VARCHAR(4000),
  STRATEGY            VARCHAR(40),                     -- DDL_PATCH | CREATE_MISSING | TASK_GRAPH | RERUN_ONLY | DATA_REPAIR
  STATEMENTS          ARRAY         NOT NULL,
  ROLLBACK_STATEMENTS ARRAY,
  TARGET_OBJECTS      ARRAY,
  RISK_LEVEL          VARCHAR(10),                     -- LOW | MEDIUM | HIGH
  ASSUMPTIONS         ARRAY,
  VERIFICATION_PLAN   VARCHAR(4000),
  FIX_HASH            VARCHAR(64)   NOT NULL,
  REVIEWED_HASH       VARCHAR(64),
  APPROVED_HASH       VARCHAR(64),
  SNAPSHOT_DDL        VARIANT,                         -- GET_DDL of targets, captured right before apply
  APPLIED_STATEMENTS  ARRAY,                           -- statements as bound and executed in production
  APPROVED_BY         VARCHAR(255),
  APPROVED_AT         TIMESTAMP_NTZ,
  APPLIED_BY          VARCHAR(255),
  APPLIED_AT          TIMESTAMP_NTZ,
  APPLY_ERROR         VARCHAR(4000),
  ROLLED_BACK_BY      VARCHAR(255),
  ROLLED_BACK_AT      TIMESTAMP_NTZ,
  SEAL                VARCHAR(64),                     -- HMAC by the app; tampering by anything else breaks it
  CREATED_AT          TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  UPDATED_AT          TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  CONSTRAINT PK_FIXES PRIMARY KEY (FIX_ID),
  CONSTRAINT UQ_FIXES_VERSION UNIQUE (INCIDENT_ID, VERSION),
  CONSTRAINT FK_FIX_INC FOREIGN KEY (INCIDENT_ID) REFERENCES INCIDENTS (INCIDENT_ID),
  CONSTRAINT FK_FIX_RUN FOREIGN KEY (AGENT_RUN_ID) REFERENCES AGENT_RUNS (AGENT_RUN_ID),
  INDEX IX_FIX_STATUS (STATUS, UPDATED_AT)
)
COMMENT = 'Proposed fixes, their approval and apply/rollback lifecycle';

-- Sandbox rehearsal of a fix: clone -> apply -> run the job -> outcome.
CREATE HYBRID TABLE IF NOT EXISTS REHEARSALS (
  REHEARSAL_ID        VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  FIX_ID              VARCHAR(64)   NOT NULL,
  INCIDENT_ID         VARCHAR(64)   NOT NULL,
  SANDBOX_SCHEMA      VARCHAR(500),
  OUTCOME             VARCHAR(20)   NOT NULL DEFAULT 'RUNNING',  -- RUNNING | PASSED | FAILED | INCONCLUSIVE | UNSUPPORTED
  REASON              VARCHAR(4000),
  STEPS_LOG           VARIANT,
  STARTED_AT          TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  ENDED_AT            TIMESTAMP_NTZ,
  DURATION_MS         NUMBER(38,0),
  CONSTRAINT PK_REHEARSALS PRIMARY KEY (REHEARSAL_ID),
  CONSTRAINT FK_REH_FIX FOREIGN KEY (FIX_ID) REFERENCES FIXES (FIX_ID),
  INDEX IX_REH_INC (INCIDENT_ID)
)
COMMENT = 'Sandbox rehearsals of proposed fixes';

-- Reviewer output (submit_review). CONFIDENCE is RAW_CONFIDENCE after the
-- deterministic caps (rehearsal FAILED -> <=40, INCONCLUSIVE/UNSUPPORTED -> <=70).
CREATE HYBRID TABLE IF NOT EXISTS REVIEWS (
  REVIEW_ID           VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  FIX_ID              VARCHAR(64)   NOT NULL,
  INCIDENT_ID         VARCHAR(64)   NOT NULL,
  AGENT_RUN_ID        VARCHAR(64)   NOT NULL,
  VERDICT             VARCHAR(20)   NOT NULL,          -- APPROVE | REVISE | REJECT
  RAW_CONFIDENCE      NUMBER(5,2)   NOT NULL,
  CONFIDENCE          NUMBER(5,2)   NOT NULL,
  CAP_REASON          VARCHAR(500),
  RUBRIC              VARIANT,
  CONCERNS            ARRAY,
  REQUIRED_CHANGES    ARRAY,
  SUMMARY             VARCHAR(4000),
  REHEARSAL_OUTCOME   VARCHAR(20),
  SEAL                VARCHAR(64),                     -- HMAC by the app; tampering by anything else breaks it
  CREATED_AT          TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  CONSTRAINT PK_REVIEWS PRIMARY KEY (REVIEW_ID),
  CONSTRAINT FK_REV_FIX FOREIGN KEY (FIX_ID) REFERENCES FIXES (FIX_ID),
  CONSTRAINT FK_REV_RUN FOREIGN KEY (AGENT_RUN_ID) REFERENCES AGENT_RUNS (AGENT_RUN_ID),
  INDEX IX_REV_INC (INCIDENT_ID)
)
COMMENT = 'Reviewer verdicts and confidence scores';

-- Append-only audit trail of every human and system decision.
CREATE HYBRID TABLE IF NOT EXISTS AUDIT_LOG (
  AUDIT_ID            VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  INCIDENT_ID         VARCHAR(64),
  FIX_ID              VARCHAR(64),
  ACTOR               VARCHAR(255)  NOT NULL,          -- user name or SYSTEM / agent role
  ACTION              VARCHAR(60)   NOT NULL,          -- DETECTED | APPROVED | REJECTED | APPLIED | ROLLED_BACK | SETTING_CHANGED ...
  DETAIL              VARIANT,
  CREATED_AT          TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  CONSTRAINT PK_AUDIT_LOG PRIMARY KEY (AUDIT_ID),
  INDEX IX_AUDIT_TIME (CREATED_AT),
  INDEX IX_AUDIT_INC (INCIDENT_ID)
)
COMMENT = 'Audit trail of approvals, applies, rollbacks and setting changes';

-- Runtime settings (kill switch, budgets, model overrides). Read by the
-- orchestrator every cycle.
CREATE HYBRID TABLE IF NOT EXISTS SETTINGS (
  SETTING_KEY         VARCHAR(100)  NOT NULL,
  SETTING_VALUE       VARIANT,
  DESCRIPTION         VARCHAR(1000),
  UPDATED_BY          VARCHAR(255),
  UPDATED_AT          TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  CONSTRAINT PK_SETTINGS PRIMARY KEY (SETTING_KEY)
)
COMMENT = 'Runtime settings for the agent pipeline';

-- Default settings (insert only the missing keys).
INSERT INTO SETTINGS (SETTING_KEY, SETTING_VALUE, DESCRIPTION, UPDATED_BY)
SELECT s.k, PARSE_JSON(s.v), s.d, 'SETUP'
FROM (
  SELECT 'pipeline.enabled'            AS k, 'true'  AS v, 'Kill switch: when false the orchestrator claims no new incidents' AS d UNION ALL
  SELECT 'pipeline.max_in_flight',           '2',          'Incidents processed concurrently' UNION ALL
  SELECT 'pipeline.max_fix_iterations',      '2',          'Fixer <-> Reviewer revise loops before escalating to a human' UNION ALL
  SELECT 'pipeline.lease_seconds',           '900',        'Incident lease length; renewed while an agent is running' UNION ALL
  SELECT 'pipeline.auto_rerun_transient',    'false',      'Allow a plain re-run for TRANSIENT diagnoses after approval' UNION ALL
  SELECT 'budget.max_tokens_per_incident',   '2500000',    'Stop and escalate when an incident exceeds this many tokens' UNION ALL
  SELECT 'budget.max_minutes_per_agent',     '20',         'Hard timeout for one agent turn' UNION ALL
  SELECT 'apply.allowed_approvers',          '["JLEONG"]', 'Users allowed to approve fixes for production' UNION ALL
  SELECT 'apply.min_confidence',             '80',         'Minimum capped confidence to enable Apply' UNION ALL
  SELECT 'models.investigator',              '"claude-sonnet-5"', 'Investigator model' UNION ALL
  SELECT 'models.fixer',                     '"claude-opus-5"',   'Fixer model' UNION ALL
  SELECT 'models.reviewer',                  '"openai-gpt-5.4"',  'Reviewer model (different family from the Fixer)'
) s
WHERE NOT EXISTS (SELECT 1 FROM SETTINGS t WHERE t.SETTING_KEY = s.k);

SHOW HYBRID TABLES IN SCHEMA ADE_DB.OPS;
