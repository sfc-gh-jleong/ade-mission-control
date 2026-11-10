/* =====================================================================
   02 — Telemetry: standard tables + analytics views in ADE_DB.TELEMETRY
   ---------------------------------------------------------------------
   STEP_PAYLOADS holds the bulky, append-only side of each agent step
   (tool inputs/outputs, reasoning text, structured outputs). It is joined
   to ADE_DB.OPS.AGENT_STEPS on STEP_ID only when a user opens a step.

   AGENT_USAGE holds billed credits per Cortex request, copied from
   SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY (up to ~1 h latency)
   by ADE_DB.CORE.RECONCILE_USAGE (06_usage_reconcile.sql).

   Views feed the Analytics page. Run as ADE_OWNER_ROLE (then 04_app_privileges.sql). Idempotent.
   ===================================================================== */
USE ROLE ADE_OWNER_ROLE;
USE WAREHOUSE ADE_WH;
USE SCHEMA ADE_DB.TELEMETRY;

CREATE TABLE IF NOT EXISTS STEP_PAYLOADS (
  PAYLOAD_ID    VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  STEP_ID       VARCHAR(64)   NOT NULL,
  INCIDENT_ID   VARCHAR(64)   NOT NULL,
  PAYLOAD_KIND  VARCHAR(40)   NOT NULL,   -- PROMPT | TOOL_INPUT | TOOL_OUTPUT | THINKING | TEXT | STRUCTURED_OUTPUT | STATUS_TIMELINE | ERROR | SQL_LOG
  PAYLOAD       VARIANT,
  BYTES         NUMBER(38,0),
  CREATED_AT    TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE()
)
COMMENT = 'Bulky per-step payloads (tool I/O, reasoning, structured outputs)';

CREATE TABLE IF NOT EXISTS AGENT_USAGE (
  REQUEST_ID        VARCHAR       NOT NULL,
  THREAD_ID         VARCHAR,
  AGENT_NAME        VARCHAR,
  START_TIME        TIMESTAMP_NTZ,
  END_TIME          TIMESTAMP_NTZ,
  TOKENS            NUMBER(38,0),
  TOKEN_CREDITS     NUMBER(38,9),
  TOKENS_GRANULAR   ARRAY,
  CREDITS_GRANULAR  ARRAY,
  AGENT_RUN_ID      VARCHAR(64),             -- matched ADE_DB.OPS.AGENT_RUNS row
  LOADED_AT         TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE()
)
COMMENT = 'Billed credits per Cortex Agent request (from ACCOUNT_USAGE), matched to agent runs';

-- App self-tests (agent sandbox under the service identity, agent object sync,
-- warehouse, scope access). Written by the app at boot and on demand.
CREATE TABLE IF NOT EXISTS HEALTH_CHECKS (
  CHECK_ID      VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  CHECK_NAME    VARCHAR(100)  NOT NULL,
  STATUS        VARCHAR(10)   NOT NULL,     -- PASS | WARN | FAIL
  DURATION_MS   NUMBER(38,0),
  SUMMARY       VARCHAR(4000),
  DETAIL        VARIANT,
  INSTANCE      VARCHAR(200),
  CHECKED_AT    TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE()
)
COMMENT = 'Mission Control self-test results';

-- ---------------------------------------------------------------------
-- Analytics views
-- ---------------------------------------------------------------------

-- Daily token / time / credit usage per agent and model.
CREATE OR REPLACE VIEW V_DAILY_USAGE
  COMMENT = 'Daily agent usage by actor and model'
AS
SELECT
  TO_DATE(s.STARTED_AT)                                   AS USAGE_DATE,
  s.ACTOR,
  COALESCE(s.MODEL, r.MODEL)                              AS MODEL,
  COUNT_IF(s.KIND = 'TURN')                               AS TURNS,
  COUNT_IF(s.KIND = 'TOOL_CALL')                          AS TOOL_CALLS,
  SUM(IFF(s.KIND = 'TURN', s.INPUT_TOKENS, 0))            AS INPUT_TOKENS,
  SUM(IFF(s.KIND = 'TURN', s.UNCACHED_INPUT_TOKENS, 0))   AS UNCACHED_INPUT_TOKENS,
  SUM(IFF(s.KIND = 'TURN', s.CACHE_READ_TOKENS, 0))       AS CACHE_READ_TOKENS,
  SUM(IFF(s.KIND = 'TURN', s.CACHE_WRITE_TOKENS, 0))      AS CACHE_WRITE_TOKENS,
  SUM(IFF(s.KIND = 'TURN', s.OUTPUT_TOKENS, 0))           AS OUTPUT_TOKENS,
  SUM(IFF(s.KIND = 'TURN', s.DURATION_MS, 0))             AS AGENT_MS,
  SUM(IFF(s.KIND = 'TURN', s.CREDITS, 0))                 AS CREDITS
FROM ADE_DB.OPS.AGENT_STEPS s
LEFT JOIN ADE_DB.OPS.AGENT_RUNS r ON r.AGENT_RUN_ID = s.AGENT_RUN_ID
WHERE s.ACTOR <> 'SYSTEM'
GROUP BY 1, 2, 3;

-- Per-agent performance: latency percentiles, token and tool-call profile.
CREATE OR REPLACE VIEW V_AGENT_PERFORMANCE
  COMMENT = 'Per-agent latency, tokens, tool calls, success rate'
AS
SELECT
  r.AGENT_ROLE,
  r.MODEL,
  COUNT(*)                                                AS RUNS,
  COUNT_IF(r.STATUS = 'SUCCEEDED')                        AS SUCCEEDED,
  ROUND(100 * COUNT_IF(r.STATUS = 'SUCCEEDED') / NULLIF(COUNT(*), 0), 1) AS SUCCESS_PCT,
  ROUND(AVG(r.DURATION_MS))                               AS AVG_MS,
  ROUND(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY r.DURATION_MS)) AS P50_MS,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.DURATION_MS)) AS P95_MS,
  ROUND(AVG(r.INPUT_TOKENS + r.OUTPUT_TOKENS))            AS AVG_TOKENS,
  ROUND(AVG(r.OUTPUT_TOKENS))                             AS AVG_OUTPUT_TOKENS,
  ROUND(100 * SUM(r.CACHE_READ_TOKENS) / NULLIF(SUM(r.INPUT_TOKENS), 0), 1) AS CACHE_HIT_PCT,
  ROUND(AVG(r.TOOL_CALLS), 1)                             AS AVG_TOOL_CALLS,
  ROUND(AVG(r.CREDITS), 6)                                AS AVG_CREDITS,
  SUM(r.CREDITS)                                          AS TOTAL_CREDITS,
  MAX(r.STARTED_AT)                                       AS LAST_RUN_AT
FROM ADE_DB.OPS.AGENT_RUNS r
WHERE r.STATUS <> 'RUNNING'
GROUP BY 1, 2;

-- Pipeline funnel: how far incidents get.
CREATE OR REPLACE VIEW V_INCIDENT_FUNNEL
  COMMENT = 'Incident counts per pipeline milestone'
AS
WITH diag AS (
  SELECT DISTINCT INCIDENT_ID FROM ADE_DB.OPS.DIAGNOSES
), fix AS (
  SELECT INCIDENT_ID,
         MAX(IFF(APPROVED_AT IS NOT NULL, 1, 0)) AS APPROVED,
         MAX(IFF(APPLIED_AT  IS NOT NULL, 1, 0)) AS APPLIED
  FROM ADE_DB.OPS.FIXES GROUP BY INCIDENT_ID
), rev AS (
  SELECT DISTINCT INCIDENT_ID FROM ADE_DB.OPS.REVIEWS
)
SELECT
  COUNT(*)                          AS DETECTED,
  COUNT(diag.INCIDENT_ID)           AS DIAGNOSED,
  COUNT(fix.INCIDENT_ID)            AS FIX_PROPOSED,
  COUNT(rev.INCIDENT_ID)            AS REVIEWED,
  SUM(COALESCE(fix.APPROVED, 0))    AS APPROVED,
  SUM(COALESCE(fix.APPLIED, 0))     AS APPLIED,
  COUNT_IF(i.STATUS = 'RESOLVED')   AS RESOLVED
FROM ADE_DB.OPS.INCIDENTS i
LEFT JOIN diag ON diag.INCIDENT_ID = i.INCIDENT_ID
LEFT JOIN fix  ON fix.INCIDENT_ID  = i.INCIDENT_ID
LEFT JOIN rev  ON rev.INCIDENT_ID  = i.INCIDENT_ID
WHERE i.ROOT_INCIDENT_ID IS NULL;

-- Confidence calibration: does a high score predict a verified fix?
CREATE OR REPLACE VIEW V_CONFIDENCE_CALIBRATION
  COMMENT = 'Reviewer confidence buckets vs. verified outcome of applied fixes'
AS
WITH last_review AS (
  SELECT v.*, ROW_NUMBER() OVER (PARTITION BY v.FIX_ID ORDER BY v.CREATED_AT DESC) AS rn
  FROM ADE_DB.OPS.REVIEWS v
)
SELECT
  FLOOR(lr.CONFIDENCE / 10) * 10                          AS CONFIDENCE_BUCKET,
  COUNT(*)                                                AS REVIEWS,
  COUNT_IF(f.APPLIED_AT IS NOT NULL)                      AS APPLIED,
  COUNT_IF(f.STATUS = 'VERIFIED')                         AS VERIFIED,
  COUNT_IF(f.STATUS IN ('VERIFY_FAILED', 'ROLLED_BACK'))  AS FAILED_AFTER_APPLY,
  ROUND(100 * COUNT_IF(f.STATUS = 'VERIFIED') / NULLIF(COUNT_IF(f.APPLIED_AT IS NOT NULL), 0), 1) AS VERIFIED_PCT
FROM last_review lr
JOIN ADE_DB.OPS.FIXES f ON f.FIX_ID = lr.FIX_ID
WHERE lr.rn = 1
GROUP BY 1;

-- Cost and time per incident.
CREATE OR REPLACE VIEW V_INCIDENT_COST
  COMMENT = 'Per-incident agent time, tokens, credits and time-to-fix'
AS
SELECT
  i.INCIDENT_ID,
  i.INCIDENT_NUMBER,
  i.JOB_FQN,
  i.CATEGORY,
  i.STATUS,
  i.CONFIDENCE,
  i.FIRST_SEEN_AT,
  i.RESOLVED_AT,
  COUNT(DISTINCT r.AGENT_RUN_ID)                          AS AGENT_RUNS,
  SUM(r.TOOL_CALLS)                                       AS TOOL_CALLS,
  SUM(r.INPUT_TOKENS + r.OUTPUT_TOKENS)                   AS TOKENS,
  SUM(r.DURATION_MS)                                      AS AGENT_MS,
  SUM(r.CREDITS)                                          AS CREDITS,
  MIN(IFF(r.AGENT_ROLE = 'REVIEWER', r.ENDED_AT, NULL))   AS FIRST_REVIEW_AT,
  DATEDIFF('second', i.FIRST_SEEN_AT, MIN(IFF(r.AGENT_ROLE = 'REVIEWER', r.ENDED_AT, NULL))) AS SECONDS_TO_REVIEWED_FIX,
  DATEDIFF('second', i.FIRST_SEEN_AT, i.RESOLVED_AT)      AS SECONDS_TO_RESOLVE
FROM ADE_DB.OPS.INCIDENTS i
LEFT JOIN ADE_DB.OPS.AGENT_RUNS r ON r.INCIDENT_ID = i.INCIDENT_ID
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8;

SHOW TABLES IN SCHEMA ADE_DB.TELEMETRY;
SHOW VIEWS IN SCHEMA ADE_DB.TELEMETRY;
