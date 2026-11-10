/* =====================================================================
   05 — Failure detector: inventory, run ingestion, incidents, cascades
   ---------------------------------------------------------------------
   ADE_DB.CORE.DETECT_FAILURES() runs every minute as a serverless task owned
   by ADE_OWNER_ROLE. For every enabled scope (monitored database) it:

   1. Syncs the job inventory (SHOW TASKS / DYNAMIC TABLES / ALERTS) into
      OPS.JOBS, updating only rows that changed.
   2. Stages terminal runs since the oldest watermark (minus 15 min overlap)
      from INFORMATION_SCHEMA.TASK_HISTORY, DYNAMIC_TABLE_REFRESH_HISTORY and
      ALERT_HISTORY. These functions return account-wide rows, so one call per
      job type covers all scopes; rows are then filtered to registered scopes.
      A scope scanned for the first time is backfilled 14 days from
      ACCOUNT_USAGE (INFORMATION_SCHEMA's RESULT_LIMIT is applied before the
      database filter, so long windows would truncate).
   3. Inserts new runs into OPS.JOB_RUNS (all task runs; DT/alert failures).
   4. Fingerprints new failures (job + error code + normalized message) and
      either bumps the open incident with that fingerprint or opens a new one.
      UPSTREAM_FAILED dynamic-table refreshes become SYMPTOM incidents linked
      to the closest failing root in the same database.
   5. Advances watermarks and, when live (non-backfill) incidents were opened,
      bumps OPS.DOORBELL_SEQ. The app polls SHOW SEQUENCES (cloud services
      only), so ADE_WH stays suspended while nothing is failing.

   Security: the procedure runs with ADE_OWNER_ROLE's rights. Scope database
   names are validated against a strict identifier pattern before being used
   in dynamic SHOW statements. The app can trigger a scan only through
   CORE.REQUEST_SCAN(), which executes the task and nothing else.

   Run as ACCOUNTADMIN-capable user:
     snow sql -f sql/05_detector.sql -c osm_deploy
   ===================================================================== */
USE ROLE ADE_OWNER_ROLE;
USE WAREHOUSE ADE_WH;

CREATE SEQUENCE IF NOT EXISTS ADE_DB.OPS.DOORBELL_SEQ START = 1 INCREMENT = 1
  COMMENT = 'Bumped by the detector when new incidents open. The app polls SHOW SEQUENCES (no warehouse) instead of the tables.';

CREATE TRANSIENT TABLE IF NOT EXISTS ADE_DB.CORE.HISTORY_STAGE (
  SCAN_ID             VARCHAR(64)   NOT NULL,
  SOURCE              VARCHAR(20)   NOT NULL,     -- INFO_SCHEMA | ACCOUNT_USAGE
  JOB_TYPE            VARCHAR(20)   NOT NULL,
  JOB_ID              VARCHAR(64)   NOT NULL,
  SCOPE_ID            VARCHAR(64)   NOT NULL,
  DATABASE_NAME       VARCHAR(255)  NOT NULL,
  SCHEMA_NAME         VARCHAR(255)  NOT NULL,
  JOB_NAME            VARCHAR(255)  NOT NULL,
  STATE               VARCHAR(40)   NOT NULL,
  IS_FAILURE          BOOLEAN       NOT NULL,
  SCHEDULED_AT        TIMESTAMP_NTZ,
  STARTED_AT          TIMESTAMP_NTZ,
  COMPLETED_AT        TIMESTAMP_NTZ,
  ERROR_CODE          VARCHAR(40),
  ERROR_MESSAGE       VARCHAR(8000),
  QUERY_ID            VARCHAR(100),
  GRAPH_RUN_GROUP_ID  VARCHAR(100),
  ATTEMPT_NUMBER      NUMBER(10,0),
  ROOT_TASK_ID        VARCHAR(100),
  RUN_KEY             VARCHAR(64)   NOT NULL,
  DETAILS             VARIANT
)
DATA_RETENTION_TIME_IN_DAYS = 0
COMMENT = 'Per-scan staging of job history (rows are deleted at the end of each scan)';

-- Fingerprint: job + error code + message with ids, quoted literals and
-- numbers normalized, so repeats of one failure collapse into one incident.
CREATE OR REPLACE FUNCTION ADE_DB.CORE.ERROR_FINGERPRINT(JOB_ID VARCHAR, ERROR_CODE VARCHAR, MSG VARCHAR)
RETURNS VARCHAR
COMMENT = 'Stable fingerprint of a job failure for incident deduplication'
AS
$$
  SHA2(
    JOB_ID || '|' || COALESCE(ERROR_CODE, '') || '|' ||
    LEFT(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          REGEXP_REPLACE(LOWER(COALESCE(MSG, '')),
            '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>'),
          '''[^'']*''', '''?'''),
        '[0-9]+', '#'),
      300),
    256)
$$;

-- Short human-readable incident title.
CREATE OR REPLACE FUNCTION ADE_DB.CORE.INCIDENT_TITLE(JOB_NAME VARCHAR, MSG VARCHAR)
RETURNS VARCHAR
COMMENT = 'Human-readable incident title from a job failure'
AS
$$
  LEFT(
    JOB_NAME || ' failed: ' ||
    COALESCE(
      NULLIF(TRIM(REGEXP_REPLACE(
        REGEXP_REPLACE(COALESCE(MSG, ''), '[[:space:]]+', ' '),
        '^(SQL compilation error:)? ?(error line [0-9]+ at position [0-9]+)? ?', '')), ''),
      'no error message'),
    200)
$$;

-- First-pass category from the Snowflake error code (the Investigator confirms or corrects it).
CREATE OR REPLACE FUNCTION ADE_DB.CORE.ERROR_CATEGORY(ERROR_CODE VARCHAR, STATE VARCHAR)
RETURNS VARCHAR
COMMENT = 'Heuristic failure category from the Snowflake error code'
AS
$$
  CASE
    WHEN STATE = 'UPSTREAM_FAILED'                                      THEN 'DEPENDENCY'
    WHEN ERROR_CODE IN ('002003', '002043')                             THEN 'MISSING_OBJECT'
    WHEN ERROR_CODE IN ('000904', '002262', '000938')                   THEN 'SCHEMA_DRIFT'
    WHEN ERROR_CODE IN ('100038', '100040', '100051', '100071', '100090', '100035', '100078') THEN 'DATA_QUALITY'
    WHEN ERROR_CODE IN ('003001', '003005', '091000')                   THEN 'PERMISSIONS'
    WHEN ERROR_CODE IN ('000630', '000625', '100132')                   THEN 'RESOURCE'
    WHEN ERROR_CODE IN ('091426', '091424')                             THEN 'DEPENDENCY'
    WHEN ERROR_CODE IN ('001003', '000002', '002141')                   THEN 'LOGIC_BUG'
    ELSE 'UNKNOWN'
  END
$$;

-- Earlier zero-argument version (would make CALL ... () ambiguous).
DROP PROCEDURE IF EXISTS ADE_DB.CORE.DETECT_FAILURES();

CREATE OR REPLACE PROCEDURE ADE_DB.CORE.DETECT_FAILURES(FORCE_FULL BOOLEAN DEFAULT FALSE)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = 'ADE detector: sync job inventory, ingest runs, open/dedupe incidents (see sql/05_detector.sql)'
EXECUTE AS OWNER
AS
$$
DECLARE
  run_started    TIMESTAMP_NTZ DEFAULT SYSDATE();
  scan_id        VARCHAR DEFAULT UUID_STRING();
  win_start      TIMESTAMP_NTZ;
  win_start_ltz  TIMESTAMP_LTZ;
  err            VARCHAR;
  full_scan      BOOLEAN;
  errors_only    BOOLEAN;
  needs_backfill BOOLEAN;
  qid            VARCHAR;
  db             VARCHAR;
  sid            VARCHAR;
  types          VARCHAR;
  scopes_scanned INTEGER DEFAULT 0;
  staged         INTEGER DEFAULT 0;
  new_runs       INTEGER DEFAULT 0;
  bumped         INTEGER DEFAULT 0;
  opened         INTEGER DEFAULT 0;
  opened_live    INTEGER DEFAULT 0;
  inventory_changes INTEGER DEFAULT 0;
  ring           INTEGER;
  c_scopes CURSOR FOR
    SELECT SCOPE_ID, DATABASE_NAME, JOB_TYPES FROM ADE_DB.OPS.SCOPES WHERE ENABLED ORDER BY DATABASE_NAME;
BEGIN
  SELECT GREATEST(DATEADD(minute, -15, COALESCE(MIN(WATERMARK_AT), DATEADD(hour, -1, :run_started))),
                  DATEADD(day, -1, :run_started)),
         COUNT_IF(WATERMARK_AT IS NULL) > 0
    INTO :win_start, :needs_backfill
    FROM ADE_DB.OPS.SCOPES
    WHERE ENABLED;
  -- Same instant as LTZ (history functions take LTZ): now - (utc_now - win_start).
  win_start_ltz := DATEADD(millisecond, -DATEDIFF(millisecond, :win_start, SYSDATE()), CURRENT_TIMESTAMP());
  -- Fast path every minute: failures only. Full path every 10 minutes (and on
  -- first scan of a scope): inventory, successful runs, alerts, backfill.
  full_scan := COALESCE(:FORCE_FULL, FALSE) OR needs_backfill OR (MOD(DATE_PART(minute, :run_started), 10) = 0);
  errors_only := NOT full_scan;

  -- ------------------------------------------------------------------
  -- 1. Inventory (full scans only)
  -- ------------------------------------------------------------------
  FOR scope_rec IN c_scopes DO
    db := scope_rec.DATABASE_NAME;
    sid := scope_rec.SCOPE_ID;
    types := scope_rec.JOB_TYPES;
    IF (NOT REGEXP_LIKE(db, '^[A-Z_][A-Z0-9_$]{0,254}$')) THEN
      UPDATE ADE_DB.OPS.SCOPES SET LAST_SCAN_STATUS = 'SKIPPED', LAST_SCAN_ERROR = 'Database name is not a plain identifier', UPDATED_AT = SYSDATE()
        WHERE SCOPE_ID = :sid;
      CONTINUE;
    END IF;
    scopes_scanned := scopes_scanned + 1;
    IF (NOT full_scan) THEN
      CONTINUE;
    END IF;

    IF (CONTAINS(types, 'TASK')) THEN
      EXECUTE IMMEDIATE 'SHOW TASKS IN DATABASE "' || db || '"';
      qid := LAST_QUERY_ID();
      UPDATE ADE_DB.OPS.JOBS j
        SET OWNER_ROLE = src.OWNER_ROLE, WAREHOUSE = src.WAREHOUSE, SCHEDULE = src.SCHEDULE, STATE = src.STATE,
            PREDECESSORS = src.PREDECESSORS, DEFINITION = src.DEFINITION, DEFINITION_HASH = src.DEFINITION_HASH,
            COMMENT = src.COMMENT, IS_ACTIVE = TRUE, UPDATED_AT = SYSDATE()
        FROM (
          SELECT SHA2('TASK|' || "database_name" || '.' || "schema_name" || '.' || "name", 256) AS JOB_ID,
                 "owner" AS OWNER_ROLE, "warehouse" AS WAREHOUSE, "schedule" AS SCHEDULE, "state" AS STATE,
                 "predecessors" AS PREDECESSORS,
                 IFF("condition" IS NULL OR "condition" = '', '', 'WHEN ' || "condition" || ' ') || 'AS ' || "definition" AS DEFINITION,
                 SHA2(COALESCE("definition", '') || '|' || COALESCE("condition", '') || '|' || COALESCE(TO_JSON("predecessors"), ''), 256) AS DEFINITION_HASH,
                 "comment" AS COMMENT
          FROM TABLE(RESULT_SCAN(:qid))
        ) src
        WHERE j.JOB_ID = src.JOB_ID
          AND (j.DEFINITION_HASH IS DISTINCT FROM src.DEFINITION_HASH OR j.STATE IS DISTINCT FROM src.STATE
               OR j.SCHEDULE IS DISTINCT FROM src.SCHEDULE OR j.OWNER_ROLE IS DISTINCT FROM src.OWNER_ROLE
               OR j.WAREHOUSE IS DISTINCT FROM src.WAREHOUSE OR NOT j.IS_ACTIVE);
      inventory_changes := inventory_changes + SQLROWCOUNT;
      INSERT INTO ADE_DB.OPS.JOBS (JOB_ID, SCOPE_ID, JOB_TYPE, DATABASE_NAME, SCHEMA_NAME, JOB_NAME, FQN, OWNER_ROLE,
                                   WAREHOUSE, SCHEDULE, STATE, PREDECESSORS, DEFINITION, DEFINITION_HASH, COMMENT)
        SELECT src.JOB_ID, :sid, 'TASK', src.DB, src.SCH, src.NM, src.DB || '.' || src.SCH || '.' || src.NM,
               src.OWNER_ROLE, src.WAREHOUSE, src.SCHEDULE, src.STATE, src.PREDECESSORS, src.DEFINITION, src.DEFINITION_HASH, src.COMMENT
        FROM (
          SELECT SHA2('TASK|' || "database_name" || '.' || "schema_name" || '.' || "name", 256) AS JOB_ID,
                 "database_name" AS DB, "schema_name" AS SCH, "name" AS NM,
                 "owner" AS OWNER_ROLE, "warehouse" AS WAREHOUSE, "schedule" AS SCHEDULE, "state" AS STATE,
                 "predecessors" AS PREDECESSORS,
                 IFF("condition" IS NULL OR "condition" = '', '', 'WHEN ' || "condition" || ' ') || 'AS ' || "definition" AS DEFINITION,
                 SHA2(COALESCE("definition", '') || '|' || COALESCE("condition", '') || '|' || COALESCE(TO_JSON("predecessors"), ''), 256) AS DEFINITION_HASH,
                 "comment" AS COMMENT
          FROM TABLE(RESULT_SCAN(:qid))
        ) src
        WHERE NOT EXISTS (SELECT 1 FROM ADE_DB.OPS.JOBS j WHERE j.JOB_ID = src.JOB_ID);
      inventory_changes := inventory_changes + SQLROWCOUNT;
      UPDATE ADE_DB.OPS.JOBS SET IS_ACTIVE = FALSE, UPDATED_AT = SYSDATE()
        WHERE SCOPE_ID = :sid AND JOB_TYPE = 'TASK' AND IS_ACTIVE
          AND JOB_ID NOT IN (SELECT SHA2('TASK|' || "database_name" || '.' || "schema_name" || '.' || "name", 256)
                             FROM TABLE(RESULT_SCAN(:qid)));
      inventory_changes := inventory_changes + SQLROWCOUNT;
    END IF;

    IF (CONTAINS(types, 'DYNAMIC_TABLE')) THEN
      EXECUTE IMMEDIATE 'SHOW DYNAMIC TABLES IN DATABASE "' || db || '"';
      qid := LAST_QUERY_ID();
      UPDATE ADE_DB.OPS.JOBS j
        SET OWNER_ROLE = src.OWNER_ROLE, WAREHOUSE = src.WAREHOUSE, SCHEDULE = src.SCHEDULE, STATE = src.STATE,
            DEFINITION = src.DEFINITION, DEFINITION_HASH = src.DEFINITION_HASH, COMMENT = src.COMMENT,
            IS_ACTIVE = TRUE, UPDATED_AT = SYSDATE()
        FROM (
          SELECT SHA2('DYNAMIC_TABLE|' || "database_name" || '.' || "schema_name" || '.' || "name", 256) AS JOB_ID,
                 "owner" AS OWNER_ROLE, "warehouse" AS WAREHOUSE, 'TARGET_LAG = ' || "target_lag" AS SCHEDULE,
                 "scheduling_state"::VARCHAR AS STATE, "text" AS DEFINITION,
                 SHA2(COALESCE("text", '') || '|' || COALESCE("target_lag", ''), 256) AS DEFINITION_HASH,
                 "comment" AS COMMENT
          FROM TABLE(RESULT_SCAN(:qid))
        ) src
        WHERE j.JOB_ID = src.JOB_ID
          AND (j.DEFINITION_HASH IS DISTINCT FROM src.DEFINITION_HASH OR j.STATE IS DISTINCT FROM src.STATE
               OR j.OWNER_ROLE IS DISTINCT FROM src.OWNER_ROLE OR j.WAREHOUSE IS DISTINCT FROM src.WAREHOUSE OR NOT j.IS_ACTIVE);
      inventory_changes := inventory_changes + SQLROWCOUNT;
      INSERT INTO ADE_DB.OPS.JOBS (JOB_ID, SCOPE_ID, JOB_TYPE, DATABASE_NAME, SCHEMA_NAME, JOB_NAME, FQN, OWNER_ROLE,
                                   WAREHOUSE, SCHEDULE, STATE, DEFINITION, DEFINITION_HASH, COMMENT)
        SELECT src.JOB_ID, :sid, 'DYNAMIC_TABLE', src.DB, src.SCH, src.NM, src.DB || '.' || src.SCH || '.' || src.NM,
               src.OWNER_ROLE, src.WAREHOUSE, src.SCHEDULE, src.STATE, src.DEFINITION, src.DEFINITION_HASH, src.COMMENT
        FROM (
          SELECT SHA2('DYNAMIC_TABLE|' || "database_name" || '.' || "schema_name" || '.' || "name", 256) AS JOB_ID,
                 "database_name" AS DB, "schema_name" AS SCH, "name" AS NM,
                 "owner" AS OWNER_ROLE, "warehouse" AS WAREHOUSE, 'TARGET_LAG = ' || "target_lag" AS SCHEDULE,
                 "scheduling_state"::VARCHAR AS STATE, "text" AS DEFINITION,
                 SHA2(COALESCE("text", '') || '|' || COALESCE("target_lag", ''), 256) AS DEFINITION_HASH,
                 "comment" AS COMMENT
          FROM TABLE(RESULT_SCAN(:qid))
        ) src
        WHERE NOT EXISTS (SELECT 1 FROM ADE_DB.OPS.JOBS j WHERE j.JOB_ID = src.JOB_ID);
      inventory_changes := inventory_changes + SQLROWCOUNT;
      UPDATE ADE_DB.OPS.JOBS SET IS_ACTIVE = FALSE, UPDATED_AT = SYSDATE()
        WHERE SCOPE_ID = :sid AND JOB_TYPE = 'DYNAMIC_TABLE' AND IS_ACTIVE
          AND JOB_ID NOT IN (SELECT SHA2('DYNAMIC_TABLE|' || "database_name" || '.' || "schema_name" || '.' || "name", 256)
                             FROM TABLE(RESULT_SCAN(:qid)));
      inventory_changes := inventory_changes + SQLROWCOUNT;
    END IF;

    IF (CONTAINS(types, 'ALERT')) THEN
      EXECUTE IMMEDIATE 'SHOW ALERTS IN DATABASE "' || db || '"';
      qid := LAST_QUERY_ID();
      UPDATE ADE_DB.OPS.JOBS j
        SET OWNER_ROLE = src.OWNER_ROLE, WAREHOUSE = src.WAREHOUSE, SCHEDULE = src.SCHEDULE, STATE = src.STATE,
            DEFINITION = src.DEFINITION, DEFINITION_HASH = src.DEFINITION_HASH, COMMENT = src.COMMENT,
            IS_ACTIVE = TRUE, UPDATED_AT = SYSDATE()
        FROM (
          SELECT SHA2('ALERT|' || "database_name" || '.' || "schema_name" || '.' || "name", 256) AS JOB_ID,
                 "owner" AS OWNER_ROLE, "warehouse" AS WAREHOUSE, "schedule" AS SCHEDULE, "state" AS STATE,
                 'IF (EXISTS (' || "condition" || ')) THEN ' || "action" AS DEFINITION,
                 SHA2(COALESCE("condition", '') || '|' || COALESCE("action", ''), 256) AS DEFINITION_HASH,
                 "comment" AS COMMENT
          FROM TABLE(RESULT_SCAN(:qid))
        ) src
        WHERE j.JOB_ID = src.JOB_ID
          AND (j.DEFINITION_HASH IS DISTINCT FROM src.DEFINITION_HASH OR j.STATE IS DISTINCT FROM src.STATE
               OR j.SCHEDULE IS DISTINCT FROM src.SCHEDULE OR NOT j.IS_ACTIVE);
      inventory_changes := inventory_changes + SQLROWCOUNT;
      INSERT INTO ADE_DB.OPS.JOBS (JOB_ID, SCOPE_ID, JOB_TYPE, DATABASE_NAME, SCHEMA_NAME, JOB_NAME, FQN, OWNER_ROLE,
                                   WAREHOUSE, SCHEDULE, STATE, DEFINITION, DEFINITION_HASH, COMMENT)
        SELECT src.JOB_ID, :sid, 'ALERT', src.DB, src.SCH, src.NM, src.DB || '.' || src.SCH || '.' || src.NM,
               src.OWNER_ROLE, src.WAREHOUSE, src.SCHEDULE, src.STATE, src.DEFINITION, src.DEFINITION_HASH, src.COMMENT
        FROM (
          SELECT SHA2('ALERT|' || "database_name" || '.' || "schema_name" || '.' || "name", 256) AS JOB_ID,
                 "database_name" AS DB, "schema_name" AS SCH, "name" AS NM,
                 "owner" AS OWNER_ROLE, "warehouse" AS WAREHOUSE, "schedule" AS SCHEDULE, "state" AS STATE,
                 'IF (EXISTS (' || "condition" || ')) THEN ' || "action" AS DEFINITION,
                 SHA2(COALESCE("condition", '') || '|' || COALESCE("action", ''), 256) AS DEFINITION_HASH,
                 "comment" AS COMMENT
          FROM TABLE(RESULT_SCAN(:qid))
        ) src
        WHERE NOT EXISTS (SELECT 1 FROM ADE_DB.OPS.JOBS j WHERE j.JOB_ID = src.JOB_ID);
      inventory_changes := inventory_changes + SQLROWCOUNT;
    END IF;
  END FOR;

  -- ------------------------------------------------------------------
  -- 2. Stage history (incremental window, all scopes at once)
  -- ------------------------------------------------------------------
  INSERT INTO ADE_DB.CORE.HISTORY_STAGE (SCAN_ID, SOURCE, JOB_TYPE, JOB_ID, SCOPE_ID, DATABASE_NAME, SCHEMA_NAME, JOB_NAME,
         STATE, IS_FAILURE, SCHEDULED_AT, STARTED_AT, COMPLETED_AT, ERROR_CODE, ERROR_MESSAGE, QUERY_ID, GRAPH_RUN_GROUP_ID,
         ATTEMPT_NUMBER, ROOT_TASK_ID, RUN_KEY, DETAILS)
  SELECT :scan_id, 'INFO_SCHEMA', 'TASK', h.JOB_ID, sc.SCOPE_ID, h.DATABASE_NAME, h.SCHEMA_NAME, h.NAME,
         h.STATE, h.STATE IN ('FAILED', 'FAILED_AND_AUTO_SUSPENDED') OR (h.STATE = 'CANCELLED' AND h.ERROR_CODE IS NOT NULL),
         h.SCHED, h.STARTED, h.COMPLETED, h.ERROR_CODE, LEFT(h.ERROR_MESSAGE, 8000), h.QUERY_ID, h.GRAPH_RUN_GROUP_ID,
         h.ATTEMPT_NUMBER, h.ROOT_TASK_ID,
         SHA2(h.JOB_ID || '|' || TO_VARCHAR(h.SCHED, 'YYYY-MM-DD HH24:MI:SS.FF3') || '|' || COALESCE(TO_VARCHAR(h.ATTEMPT_NUMBER), '1') || '|' || COALESCE(h.QUERY_ID, ''), 256),
         OBJECT_CONSTRUCT('source', 'INFO_SCHEMA', 'scheduled_from', h.SCHEDULED_FROM, 'query_text', LEFT(h.QUERY_TEXT, 4000),
                          'condition', h.CONDITION_TEXT, 'graph_version', h.GRAPH_VERSION, 'return_value', h.RETURN_VALUE)
  FROM (
    SELECT th.*,
           SHA2('TASK|' || th.DATABASE_NAME || '.' || th.SCHEMA_NAME || '.' || th.NAME, 256) AS JOB_ID,
           CONVERT_TIMEZONE('UTC', th.SCHEDULED_TIME)::TIMESTAMP_NTZ    AS SCHED,
           CONVERT_TIMEZONE('UTC', th.QUERY_START_TIME)::TIMESTAMP_NTZ  AS STARTED,
           CONVERT_TIMEZONE('UTC', th.COMPLETED_TIME)::TIMESTAMP_NTZ    AS COMPLETED
    FROM TABLE(ADE_DB.INFORMATION_SCHEMA.TASK_HISTORY(
           SCHEDULED_TIME_RANGE_START => :win_start_ltz,
           RESULT_LIMIT => 10000,
           ERROR_ONLY => :errors_only)) th
    WHERE th.STATE NOT IN ('SCHEDULED', 'EXECUTING')
  ) h
  JOIN ADE_DB.OPS.SCOPES sc
    ON sc.DATABASE_NAME = h.DATABASE_NAME AND sc.ENABLED AND CONTAINS(sc.JOB_TYPES, 'TASK')
   AND (sc.SCHEMA_FILTER IS NULL OR ARRAY_CONTAINS(h.SCHEMA_NAME::VARIANT, SPLIT(UPPER(REPLACE(sc.SCHEMA_FILTER, ' ', '')), ',')));
  staged := staged + SQLROWCOUNT;

  INSERT INTO ADE_DB.CORE.HISTORY_STAGE (SCAN_ID, SOURCE, JOB_TYPE, JOB_ID, SCOPE_ID, DATABASE_NAME, SCHEMA_NAME, JOB_NAME,
         STATE, IS_FAILURE, SCHEDULED_AT, STARTED_AT, COMPLETED_AT, ERROR_CODE, ERROR_MESSAGE, QUERY_ID, RUN_KEY, DETAILS)
  SELECT :scan_id, 'INFO_SCHEMA', 'DYNAMIC_TABLE', h.JOB_ID, sc.SCOPE_ID, h.DATABASE_NAME, h.SCHEMA_NAME, h.NAME,
         h.STATE, h.STATE IN ('FAILED', 'UPSTREAM_FAILED', 'CANCELLED'),
         h.DATA_TS, h.STARTED, h.ENDED, h.STATE_CODE, LEFT(h.STATE_MESSAGE, 8000), h.QUERY_ID,
         SHA2(h.JOB_ID || '|' || TO_VARCHAR(h.DATA_TS, 'YYYY-MM-DD HH24:MI:SS.FF3') || '|' || COALESCE(h.QUERY_ID, '') || '|' || h.STATE, 256),
         OBJECT_CONSTRUCT('source', 'INFO_SCHEMA', 'refresh_trigger', h.REFRESH_TRIGGER, 'refresh_action', h.REFRESH_ACTION,
                          'target_lag_sec', h.TARGET_LAG_SEC, 'warehouse', h.WAREHOUSE)
  FROM (
    SELECT dt.*,
           SHA2('DYNAMIC_TABLE|' || dt.DATABASE_NAME || '.' || dt.SCHEMA_NAME || '.' || dt.NAME, 256) AS JOB_ID,
           CONVERT_TIMEZONE('UTC', dt.DATA_TIMESTAMP)::TIMESTAMP_NTZ      AS DATA_TS,
           CONVERT_TIMEZONE('UTC', dt.REFRESH_START_TIME)::TIMESTAMP_NTZ  AS STARTED,
           CONVERT_TIMEZONE('UTC', dt.REFRESH_END_TIME)::TIMESTAMP_NTZ    AS ENDED
    FROM TABLE(ADE_DB.INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(
           DATA_TIMESTAMP_START => :win_start_ltz,
           RESULT_LIMIT => 10000,
           ERROR_ONLY => :errors_only)) dt
    WHERE dt.STATE NOT IN ('SCHEDULED', 'EXECUTING')
  ) h
  JOIN ADE_DB.OPS.SCOPES sc
    ON sc.DATABASE_NAME = h.DATABASE_NAME AND sc.ENABLED AND CONTAINS(sc.JOB_TYPES, 'DYNAMIC_TABLE')
   AND (sc.SCHEMA_FILTER IS NULL OR ARRAY_CONTAINS(h.SCHEMA_NAME::VARIANT, SPLIT(UPPER(REPLACE(sc.SCHEMA_FILTER, ' ', '')), ',')));
  staged := staged + SQLROWCOUNT;

  IF (full_scan) THEN
  INSERT INTO ADE_DB.CORE.HISTORY_STAGE (SCAN_ID, SOURCE, JOB_TYPE, JOB_ID, SCOPE_ID, DATABASE_NAME, SCHEMA_NAME, JOB_NAME,
         STATE, IS_FAILURE, SCHEDULED_AT, COMPLETED_AT, ERROR_CODE, ERROR_MESSAGE, QUERY_ID, RUN_KEY, DETAILS)
  SELECT :scan_id, 'INFO_SCHEMA', 'ALERT', h.JOB_ID, sc.SCOPE_ID, h.DATABASE_NAME, h.SCHEMA_NAME, h.NAME,
         h.STATE, h.STATE IN ('CONDITION_FAILED', 'ACTION_FAILED'),
         h.SCHED, h.COMPLETED, h.SQL_ERROR_CODE::VARCHAR, LEFT(h.SQL_ERROR_MESSAGE, 8000),
         COALESCE(h.ACTION_QUERY_ID, h.CONDITION_QUERY_ID),
         SHA2(h.JOB_ID || '|' || TO_VARCHAR(h.SCHED, 'YYYY-MM-DD HH24:MI:SS.FF3') || '|' || h.STATE, 256),
         OBJECT_CONSTRUCT('source', 'INFO_SCHEMA', 'condition_query_id', h.CONDITION_QUERY_ID, 'action_query_id', h.ACTION_QUERY_ID)
  FROM (
    SELECT ah.*,
           SHA2('ALERT|' || ah.DATABASE_NAME || '.' || ah.SCHEMA_NAME || '.' || ah.NAME, 256) AS JOB_ID,
           CONVERT_TIMEZONE('UTC', ah.SCHEDULED_TIME)::TIMESTAMP_NTZ  AS SCHED,
           CONVERT_TIMEZONE('UTC', ah.COMPLETED_TIME)::TIMESTAMP_NTZ  AS COMPLETED
    FROM TABLE(ADE_DB.INFORMATION_SCHEMA.ALERT_HISTORY(
           SCHEDULED_TIME_RANGE_START => :win_start_ltz,
           RESULT_LIMIT => 10000)) ah
    WHERE ah.STATE NOT IN ('SCHEDULED', 'EXECUTING')
  ) h
  JOIN ADE_DB.OPS.SCOPES sc
    ON sc.DATABASE_NAME = h.DATABASE_NAME AND sc.ENABLED AND CONTAINS(sc.JOB_TYPES, 'ALERT')
   AND (sc.SCHEMA_FILTER IS NULL OR ARRAY_CONTAINS(h.SCHEMA_NAME::VARIANT, SPLIT(UPPER(REPLACE(sc.SCHEMA_FILTER, ' ', '')), ',')));
  staged := staged + SQLROWCOUNT;
  END IF;

  -- Backfill for scopes scanned for the first time (14 days, failures + task runs).
  IF (needs_backfill) THEN
  INSERT INTO ADE_DB.CORE.HISTORY_STAGE (SCAN_ID, SOURCE, JOB_TYPE, JOB_ID, SCOPE_ID, DATABASE_NAME, SCHEMA_NAME, JOB_NAME,
         STATE, IS_FAILURE, SCHEDULED_AT, STARTED_AT, COMPLETED_AT, ERROR_CODE, ERROR_MESSAGE, QUERY_ID, GRAPH_RUN_GROUP_ID,
         ATTEMPT_NUMBER, ROOT_TASK_ID, RUN_KEY, DETAILS)
  SELECT :scan_id, 'ACCOUNT_USAGE', 'TASK', h.JOB_ID, sc.SCOPE_ID, h.DATABASE_NAME, h.SCHEMA_NAME, h.NAME,
         h.STATE, h.STATE IN ('FAILED', 'FAILED_AND_AUTO_SUSPENDED') OR (h.STATE = 'CANCELLED' AND h.ERROR_CODE IS NOT NULL),
         h.SCHED, h.STARTED, h.COMPLETED, h.ERROR_CODE, LEFT(h.ERROR_MESSAGE, 8000), h.QUERY_ID, h.GRAPH_RUN_GROUP_ID,
         h.ATTEMPT_NUMBER, h.ROOT_TASK_ID,
         SHA2(h.JOB_ID || '|' || TO_VARCHAR(h.SCHED, 'YYYY-MM-DD HH24:MI:SS.FF3') || '|' || COALESCE(TO_VARCHAR(h.ATTEMPT_NUMBER), '1') || '|' || COALESCE(h.QUERY_ID, ''), 256),
         OBJECT_CONSTRUCT('source', 'ACCOUNT_USAGE', 'scheduled_from', h.SCHEDULED_FROM, 'query_text', LEFT(h.QUERY_TEXT, 4000),
                          'condition', h.CONDITION_TEXT)
  FROM (
    SELECT th.*,
           SHA2('TASK|' || th.DATABASE_NAME || '.' || th.SCHEMA_NAME || '.' || th.NAME, 256) AS JOB_ID,
           CONVERT_TIMEZONE('UTC', th.SCHEDULED_TIME)::TIMESTAMP_NTZ    AS SCHED,
           CONVERT_TIMEZONE('UTC', th.QUERY_START_TIME)::TIMESTAMP_NTZ  AS STARTED,
           CONVERT_TIMEZONE('UTC', th.COMPLETED_TIME)::TIMESTAMP_NTZ    AS COMPLETED
    FROM SNOWFLAKE.ACCOUNT_USAGE.TASK_HISTORY th
    WHERE th.SCHEDULED_TIME >= DATEADD(day, -14, CURRENT_TIMESTAMP())
      AND th.STATE NOT IN ('SCHEDULED', 'EXECUTING')
  ) h
  JOIN ADE_DB.OPS.SCOPES sc
    ON sc.DATABASE_NAME = h.DATABASE_NAME AND sc.ENABLED AND sc.WATERMARK_AT IS NULL AND CONTAINS(sc.JOB_TYPES, 'TASK')
   AND (sc.SCHEMA_FILTER IS NULL OR ARRAY_CONTAINS(h.SCHEMA_NAME::VARIANT, SPLIT(UPPER(REPLACE(sc.SCHEMA_FILTER, ' ', '')), ',')));
  staged := staged + SQLROWCOUNT;

  INSERT INTO ADE_DB.CORE.HISTORY_STAGE (SCAN_ID, SOURCE, JOB_TYPE, JOB_ID, SCOPE_ID, DATABASE_NAME, SCHEMA_NAME, JOB_NAME,
         STATE, IS_FAILURE, SCHEDULED_AT, STARTED_AT, COMPLETED_AT, ERROR_CODE, ERROR_MESSAGE, QUERY_ID, RUN_KEY, DETAILS)
  SELECT :scan_id, 'ACCOUNT_USAGE', 'DYNAMIC_TABLE', h.JOB_ID, sc.SCOPE_ID, h.DATABASE_NAME, h.SCHEMA_NAME, h.NAME,
         h.STATE, TRUE, h.DATA_TS, h.STARTED, h.ENDED, h.STATE_CODE, LEFT(h.STATE_MESSAGE, 8000), h.QUERY_ID,
         SHA2(h.JOB_ID || '|' || TO_VARCHAR(h.DATA_TS, 'YYYY-MM-DD HH24:MI:SS.FF3') || '|' || COALESCE(h.QUERY_ID, '') || '|' || h.STATE, 256),
         OBJECT_CONSTRUCT('source', 'ACCOUNT_USAGE', 'refresh_trigger', h.REFRESH_TRIGGER, 'refresh_action', h.REFRESH_ACTION)
  FROM (
    SELECT dt.*,
           SHA2('DYNAMIC_TABLE|' || dt.DATABASE_NAME || '.' || dt.SCHEMA_NAME || '.' || dt.NAME, 256) AS JOB_ID,
           CONVERT_TIMEZONE('UTC', dt.DATA_TIMESTAMP)::TIMESTAMP_NTZ      AS DATA_TS,
           CONVERT_TIMEZONE('UTC', dt.REFRESH_START_TIME)::TIMESTAMP_NTZ  AS STARTED,
           CONVERT_TIMEZONE('UTC', dt.REFRESH_END_TIME)::TIMESTAMP_NTZ    AS ENDED
    FROM SNOWFLAKE.ACCOUNT_USAGE.DYNAMIC_TABLE_REFRESH_HISTORY dt
    WHERE dt.DATA_TIMESTAMP >= DATEADD(day, -14, CURRENT_TIMESTAMP())
      AND dt.STATE IN ('FAILED', 'UPSTREAM_FAILED', 'CANCELLED')
  ) h
  JOIN ADE_DB.OPS.SCOPES sc
    ON sc.DATABASE_NAME = h.DATABASE_NAME AND sc.ENABLED AND sc.WATERMARK_AT IS NULL AND CONTAINS(sc.JOB_TYPES, 'DYNAMIC_TABLE')
   AND (sc.SCHEMA_FILTER IS NULL OR ARRAY_CONTAINS(h.SCHEMA_NAME::VARIANT, SPLIT(UPPER(REPLACE(sc.SCHEMA_FILTER, ' ', '')), ',')));
  staged := staged + SQLROWCOUNT;
  END IF;

  -- Nothing staged (the common case on the fast path): skip all DML except
  -- the watermark.
  IF (staged = 0) THEN
    UPDATE ADE_DB.OPS.SCOPES
      SET WATERMARK_AT = :run_started, LAST_SCAN_AT = :run_started, LAST_SCAN_STATUS = 'OK',
          LAST_SCAN_MS = DATEDIFF(millisecond, :run_started, SYSDATE()), LAST_SCAN_ERROR = NULL, UPDATED_AT = SYSDATE()
      WHERE ENABLED AND REGEXP_LIKE(DATABASE_NAME, '^[A-Z_][A-Z0-9_$]{0,254}$');
    RETURN OBJECT_CONSTRUCT('scan_id', scan_id, 'full', full_scan, 'window_start', win_start, 'scopes', scopes_scanned,
                            'inventory_changes', inventory_changes, 'staged', 0, 'ms', DATEDIFF(millisecond, run_started, SYSDATE()));
  END IF;

  -- ------------------------------------------------------------------
  -- 3. New runs -> JOB_RUNS
  -- ------------------------------------------------------------------
  -- One row per run (windows and sources overlap); flag runs not yet stored.
  CREATE OR REPLACE TEMPORARY TABLE ADE_DB.CORE.SCAN_RUNS AS
  SELECT s.*, (r.RUN_KEY IS NULL AND (s.JOB_TYPE = 'TASK' OR s.IS_FAILURE)) AS IS_NEW_RUN
  FROM ADE_DB.CORE.HISTORY_STAGE s
  LEFT JOIN ADE_DB.OPS.JOB_RUNS r ON r.RUN_KEY = s.RUN_KEY
  WHERE s.SCAN_ID = :scan_id
  QUALIFY ROW_NUMBER() OVER (PARTITION BY s.RUN_KEY ORDER BY IFF(s.SOURCE = 'INFO_SCHEMA', 0, 1)) = 1;

  -- Jobs seen in history but not in the inventory (dropped since, or new).
  INSERT INTO ADE_DB.OPS.JOBS (JOB_ID, SCOPE_ID, JOB_TYPE, DATABASE_NAME, SCHEMA_NAME, JOB_NAME, FQN, IS_ACTIVE)
  SELECT JOB_ID, ANY_VALUE(SCOPE_ID), ANY_VALUE(JOB_TYPE), ANY_VALUE(DATABASE_NAME), ANY_VALUE(SCHEMA_NAME), ANY_VALUE(JOB_NAME),
         ANY_VALUE(DATABASE_NAME) || '.' || ANY_VALUE(SCHEMA_NAME) || '.' || ANY_VALUE(JOB_NAME), FALSE
  FROM ADE_DB.CORE.SCAN_RUNS s
  WHERE s.IS_NEW_RUN
    AND NOT EXISTS (SELECT 1 FROM ADE_DB.OPS.JOBS j WHERE j.JOB_ID = s.JOB_ID)
  GROUP BY JOB_ID;

  INSERT INTO ADE_DB.OPS.JOB_RUNS (RUN_KEY, JOB_ID, SCOPE_ID, STATE, SCHEDULED_AT, STARTED_AT, COMPLETED_AT, DURATION_MS,
         ERROR_CODE, ERROR_MESSAGE, QUERY_ID, GRAPH_RUN_GROUP_ID, ATTEMPT_NUMBER, ROOT_TASK_ID, DETAILS)
  SELECT RUN_KEY, JOB_ID, SCOPE_ID, STATE, SCHEDULED_AT, STARTED_AT, COMPLETED_AT, DATEDIFF(millisecond, STARTED_AT, COMPLETED_AT),
         ERROR_CODE, ERROR_MESSAGE, QUERY_ID, GRAPH_RUN_GROUP_ID, ATTEMPT_NUMBER, ROOT_TASK_ID, DETAILS
  FROM ADE_DB.CORE.SCAN_RUNS
  WHERE IS_NEW_RUN;
  new_runs := SQLROWCOUNT;

  -- Latest run per job -> JOBS (successes of DTs and alerts included).
  UPDATE ADE_DB.OPS.JOBS j
    SET LAST_RUN_AT = l.LAST_AT, LAST_STATUS = l.LAST_STATE,
        LAST_ERROR = IFF(l.LAST_FAILED, LEFT(l.LAST_ERROR, 4000), j.LAST_ERROR),
        LAST_SUCCESS_AT = COALESCE(GREATEST(l.LAST_SUCCESS_AT, j.LAST_SUCCESS_AT), l.LAST_SUCCESS_AT, j.LAST_SUCCESS_AT),
        LAST_FAILURE_AT = COALESCE(GREATEST(l.LAST_FAILURE_AT, j.LAST_FAILURE_AT), l.LAST_FAILURE_AT, j.LAST_FAILURE_AT),
        UPDATED_AT = SYSDATE()
    FROM (
      SELECT JOB_ID,
             MAX(COALESCE(COMPLETED_AT, SCHEDULED_AT)) AS LAST_AT,
             MAX_BY(STATE, COALESCE(COMPLETED_AT, SCHEDULED_AT)) AS LAST_STATE,
             MAX_BY(IS_FAILURE, COALESCE(COMPLETED_AT, SCHEDULED_AT)) AS LAST_FAILED,
             MAX_BY(ERROR_MESSAGE, COALESCE(COMPLETED_AT, SCHEDULED_AT)) AS LAST_ERROR,
             MAX(IFF(STATE IN ('SUCCEEDED', 'TRIGGERED', 'CONDITION_FALSE'), COALESCE(COMPLETED_AT, SCHEDULED_AT), NULL)) AS LAST_SUCCESS_AT,
             MAX(IFF(IS_FAILURE, COALESCE(COMPLETED_AT, SCHEDULED_AT), NULL)) AS LAST_FAILURE_AT
      FROM ADE_DB.CORE.SCAN_RUNS
      GROUP BY JOB_ID
    ) l
    WHERE j.JOB_ID = l.JOB_ID AND (j.LAST_RUN_AT IS NULL OR l.LAST_AT >= j.LAST_RUN_AT);

  -- 24h counters for jobs touched in this scan (full scans only).
  IF (full_scan) THEN
  UPDATE ADE_DB.OPS.JOBS j
    SET RUNS_24H = c.RUNS, FAILURES_24H = c.FAILS
    FROM (
      SELECT r.JOB_ID, COUNT(*) AS RUNS,
             COUNT_IF(r.STATE IN ('FAILED', 'FAILED_AND_AUTO_SUSPENDED', 'UPSTREAM_FAILED', 'CONDITION_FAILED', 'ACTION_FAILED')
                      OR (r.STATE = 'CANCELLED' AND r.ERROR_CODE IS NOT NULL)) AS FAILS
      FROM ADE_DB.OPS.JOB_RUNS r
      WHERE r.SCHEDULED_AT >= DATEADD(hour, -24, :run_started)
        AND r.JOB_ID IN (SELECT DISTINCT JOB_ID FROM ADE_DB.CORE.SCAN_RUNS)
      GROUP BY r.JOB_ID
    ) c
    WHERE j.JOB_ID = c.JOB_ID AND (j.RUNS_24H <> c.RUNS OR j.FAILURES_24H <> c.FAILS);
  END IF;

  -- ------------------------------------------------------------------
  -- 4. Incidents from new failures
  -- ------------------------------------------------------------------
  CREATE OR REPLACE TEMPORARY TABLE ADE_DB.CORE.NEW_FAILURES AS
  SELECT s.JOB_ID,
         ADE_DB.CORE.ERROR_FINGERPRINT(s.JOB_ID, s.ERROR_CODE, s.ERROR_MESSAGE)                AS FINGERPRINT,
         ANY_VALUE(s.SCOPE_ID)                                                              AS SCOPE_ID,
         ANY_VALUE(s.JOB_TYPE)                                                              AS JOB_TYPE,
         ANY_VALUE(s.DATABASE_NAME)                                                         AS DATABASE_NAME,
         ANY_VALUE(s.DATABASE_NAME || '.' || s.SCHEMA_NAME || '.' || s.JOB_NAME)            AS JOB_FQN,
         ANY_VALUE(s.JOB_NAME)                                                              AS JOB_NAME,
         COUNT(*)                                                                           AS CNT,
         MIN(COALESCE(s.COMPLETED_AT, s.SCHEDULED_AT))                                      AS FIRST_SEEN,
         MAX(COALESCE(s.COMPLETED_AT, s.SCHEDULED_AT))                                      AS LAST_SEEN,
         MIN_BY(s.RUN_KEY, COALESCE(s.COMPLETED_AT, s.SCHEDULED_AT))                         AS FIRST_RUN_KEY,
         MAX_BY(s.RUN_KEY, COALESCE(s.COMPLETED_AT, s.SCHEDULED_AT))                         AS LAST_RUN_KEY,
         MAX_BY(s.ERROR_CODE, COALESCE(s.COMPLETED_AT, s.SCHEDULED_AT))                      AS ERROR_CODE,
         MAX_BY(s.ERROR_MESSAGE, COALESCE(s.COMPLETED_AT, s.SCHEDULED_AT))                   AS ERROR_MESSAGE,
         MAX_BY(s.QUERY_ID, COALESCE(s.COMPLETED_AT, s.SCHEDULED_AT))                        AS LAST_QUERY_ID,
         MAX_BY(s.GRAPH_RUN_GROUP_ID, COALESCE(s.COMPLETED_AT, s.SCHEDULED_AT))              AS GRAPH_RUN_GROUP_ID,
         MAX_BY(s.STATE, COALESCE(s.COMPLETED_AT, s.SCHEDULED_AT))                           AS STATE,
         BOOLOR_AGG(s.STATE = 'FAILED_AND_AUTO_SUSPENDED')                                  AS ANY_SUSPENDED,
         -- First scan of a scope (no watermark yet) = history backfill: listed,
         -- not auto-processed by the agents.
         BOOLAND_AGG(s.SOURCE = 'ACCOUNT_USAGE' OR sc.WATERMARK_AT IS NULL)                 AS IS_BACKFILL
  FROM ADE_DB.CORE.SCAN_RUNS s
  JOIN ADE_DB.OPS.SCOPES sc ON sc.SCOPE_ID = s.SCOPE_ID
  WHERE s.IS_NEW_RUN AND s.IS_FAILURE
  GROUP BY 1, 2;

  UPDATE ADE_DB.OPS.INCIDENTS i
    SET OCCURRENCES = i.OCCURRENCES + f.CNT,
        LAST_SEEN_AT = GREATEST(i.LAST_SEEN_AT, f.LAST_SEEN),
        LAST_RUN_KEY = f.LAST_RUN_KEY,
        ERROR_CODE = f.ERROR_CODE,
        ERROR_MESSAGE = f.ERROR_MESSAGE,
        LAST_QUERY_ID = f.LAST_QUERY_ID,
        GRAPH_RUN_GROUP_ID = COALESCE(f.GRAPH_RUN_GROUP_ID, i.GRAPH_RUN_GROUP_ID),
        IS_BACKFILL = i.IS_BACKFILL AND f.IS_BACKFILL,
        UPDATED_AT = SYSDATE()
    FROM ADE_DB.CORE.NEW_FAILURES f
    WHERE i.FINGERPRINT = f.FINGERPRINT AND i.STATUS NOT IN ('RESOLVED', 'NO_FIX');
  bumped := SQLROWCOUNT;

  INSERT INTO ADE_DB.OPS.INCIDENTS (INCIDENT_NUMBER, SCOPE_ID, JOB_ID, JOB_TYPE, JOB_FQN, DATABASE_NAME, FINGERPRINT, TITLE,
         CATEGORY, SEVERITY, STATUS, STATUS_DETAIL, ERROR_CODE, ERROR_MESSAGE, FIRST_RUN_KEY, LAST_RUN_KEY, LAST_QUERY_ID,
         GRAPH_RUN_GROUP_ID, OCCURRENCES, FIRST_SEEN_AT, LAST_SEEN_AT, IS_BACKFILL)
  SELECT ADE_DB.OPS.INCIDENT_NUMBER_SEQ.NEXTVAL,
         f.SCOPE_ID, f.JOB_ID, f.JOB_TYPE, f.JOB_FQN, f.DATABASE_NAME, f.FINGERPRINT,
         IFF(prev.FINGERPRINT IS NOT NULL, 'Recurred: ', '') || ADE_DB.CORE.INCIDENT_TITLE(f.JOB_NAME, f.ERROR_MESSAGE),
         ADE_DB.CORE.ERROR_CATEGORY(f.ERROR_CODE, f.STATE),
         CASE
           WHEN f.STATE = 'UPSTREAM_FAILED' THEN 'LOW'
           WHEN f.ANY_SUSPENDED THEN 'CRITICAL'
           WHEN f.JOB_TYPE = 'DYNAMIC_TABLE' THEN 'HIGH'
           WHEN f.JOB_TYPE = 'TASK' AND COALESCE(ARRAY_SIZE(j.PREDECESSORS), 0) = 0 THEN 'HIGH'
           ELSE 'MEDIUM'
         END,
         IFF(f.STATE = 'UPSTREAM_FAILED', 'SYMPTOM', 'DETECTED'),
         IFF(f.STATE = 'UPSTREAM_FAILED', 'Upstream dynamic table failed', IFF(f.IS_BACKFILL, 'Found in history backfill', 'New failure')),
         f.ERROR_CODE, f.ERROR_MESSAGE, f.FIRST_RUN_KEY, f.LAST_RUN_KEY, f.LAST_QUERY_ID, f.GRAPH_RUN_GROUP_ID,
         f.CNT, f.FIRST_SEEN, f.LAST_SEEN, f.IS_BACKFILL
  FROM ADE_DB.CORE.NEW_FAILURES f
  LEFT JOIN ADE_DB.OPS.JOBS j ON j.JOB_ID = f.JOB_ID
  LEFT JOIN (SELECT DISTINCT FINGERPRINT FROM ADE_DB.OPS.INCIDENTS WHERE STATUS = 'RESOLVED') prev
    ON prev.FINGERPRINT = f.FINGERPRINT
  WHERE NOT EXISTS (SELECT 1 FROM ADE_DB.OPS.INCIDENTS i WHERE i.FINGERPRINT = f.FINGERPRINT AND i.STATUS NOT IN ('RESOLVED', 'NO_FIX'));
  opened := SQLROWCOUNT;

  -- Live work for the agents: new non-backfill incidents, plus backfill
  -- incidents that just recurred live (the bump above cleared IS_BACKFILL).
  SELECT COUNT(*) INTO :opened_live
    FROM ADE_DB.OPS.INCIDENTS
    WHERE UPDATED_AT >= :run_started AND NOT IS_BACKFILL AND STATUS = 'DETECTED'
      AND FINGERPRINT IN (SELECT FINGERPRINT FROM ADE_DB.CORE.NEW_FAILURES WHERE NOT IS_BACKFILL);

  INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, ACTOR, ACTION, DETAIL)
  SELECT INCIDENT_ID, 'DETECTOR', 'DETECTED',
         OBJECT_CONSTRUCT('job', JOB_FQN, 'error_code', ERROR_CODE, 'occurrences', OCCURRENCES, 'backfill', IS_BACKFILL, 'scan_id', :scan_id)
  FROM ADE_DB.OPS.INCIDENTS
  WHERE CREATED_AT >= :run_started AND FIRST_RUN_KEY IN (SELECT FIRST_RUN_KEY FROM ADE_DB.CORE.NEW_FAILURES);

  -- Cascade: link SYMPTOM incidents to the closest failing root DT in the same database.
  UPDATE ADE_DB.OPS.INCIDENTS s
    SET ROOT_INCIDENT_ID = r.ROOT_ID, UPDATED_AT = SYSDATE()
    FROM (
      SELECT s2.INCIDENT_ID AS SYM_ID, r2.INCIDENT_ID AS ROOT_ID
      FROM ADE_DB.OPS.INCIDENTS s2
      JOIN ADE_DB.OPS.INCIDENTS r2
        ON r2.DATABASE_NAME = s2.DATABASE_NAME AND r2.JOB_TYPE = 'DYNAMIC_TABLE'
       AND r2.STATUS NOT IN ('SYMPTOM', 'RESOLVED', 'NO_FIX')
       AND ABS(DATEDIFF(minute, r2.LAST_SEEN_AT, s2.LAST_SEEN_AT)) <= 30
      WHERE s2.STATUS = 'SYMPTOM' AND s2.ROOT_INCIDENT_ID IS NULL
      QUALIFY ROW_NUMBER() OVER (PARTITION BY s2.INCIDENT_ID ORDER BY ABS(DATEDIFF(second, r2.LAST_SEEN_AT, s2.LAST_SEEN_AT))) = 1
    ) r
    WHERE s.INCIDENT_ID = r.SYM_ID;

  UPDATE ADE_DB.OPS.INCIDENTS root
    SET SYMPTOM_COUNT = x.N, UPDATED_AT = SYSDATE()
    FROM (SELECT ROOT_INCIDENT_ID, COUNT(*) AS N FROM ADE_DB.OPS.INCIDENTS WHERE ROOT_INCIDENT_ID IS NOT NULL GROUP BY 1) x
    WHERE root.INCIDENT_ID = x.ROOT_INCIDENT_ID AND root.SYMPTOM_COUNT <> x.N;

  -- ------------------------------------------------------------------
  -- 5. Watermarks, doorbell, cleanup
  -- ------------------------------------------------------------------
  UPDATE ADE_DB.OPS.SCOPES
    SET WATERMARK_AT = :run_started, LAST_SCAN_AT = :run_started, LAST_SCAN_STATUS = 'OK',
        LAST_SCAN_MS = DATEDIFF(millisecond, :run_started, SYSDATE()), LAST_SCAN_ERROR = NULL, UPDATED_AT = SYSDATE()
    WHERE ENABLED AND REGEXP_LIKE(DATABASE_NAME, '^[A-Z_][A-Z0-9_$]{0,254}$');

  IF (opened_live > 0) THEN
    SELECT ADE_DB.OPS.DOORBELL_SEQ.NEXTVAL INTO :ring;
  END IF;

  DELETE FROM ADE_DB.CORE.HISTORY_STAGE WHERE SCAN_ID = :scan_id;
  IF (DATE_PART(minute, :run_started) = 0) THEN
    DELETE FROM ADE_DB.CORE.HISTORY_STAGE WHERE SCAN_ID <> :scan_id;
    DELETE FROM ADE_DB.OPS.JOB_RUNS r
      WHERE r.SCHEDULED_AT < DATEADD(day, -14, :run_started)
        AND NOT EXISTS (SELECT 1 FROM ADE_DB.OPS.INCIDENTS i WHERE i.FIRST_RUN_KEY = r.RUN_KEY OR i.LAST_RUN_KEY = r.RUN_KEY);
  END IF;

  RETURN OBJECT_CONSTRUCT(
    'scan_id', scan_id, 'full', full_scan, 'window_start', win_start, 'scopes', scopes_scanned, 'inventory_changes', inventory_changes,
    'staged', staged, 'new_runs', new_runs, 'incidents_opened', opened, 'incidents_live', opened_live,
    'incidents_bumped', bumped, 'ms', DATEDIFF(millisecond, run_started, SYSDATE()));
EXCEPTION
  WHEN OTHER THEN
    err := SQLERRM;
    UPDATE ADE_DB.OPS.SCOPES
      SET LAST_SCAN_AT = :run_started, LAST_SCAN_STATUS = 'ERROR', LAST_SCAN_ERROR = LEFT(:err, 4000), UPDATED_AT = SYSDATE()
      WHERE ENABLED;
    DELETE FROM ADE_DB.CORE.HISTORY_STAGE WHERE SCAN_ID = :scan_id;
    RAISE;
END;
$$;

-- On-demand scan for the app ("Scan now"): runs the task as its owner and can
-- do nothing else (no SUSPEND/ALTER rights on the task for the app).
CREATE OR REPLACE PROCEDURE ADE_DB.CORE.REQUEST_SCAN()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = 'Trigger one detector run now (used by the app)'
EXECUTE AS OWNER
AS
$$
BEGIN
  EXECUTE TASK ADE_DB.CORE.DETECTOR_TASK;
  RETURN 'scan requested';
END;
$$;

CREATE TASK IF NOT EXISTS ADE_DB.CORE.DETECTOR_TASK
  SCHEDULE = '1 MINUTE'
  USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE = 'XSMALL'
  SUSPEND_TASK_AFTER_NUM_FAILURES = 10
  USER_TASK_TIMEOUT_MS = 240000
  COMMENT = 'ADE detector: scans monitored databases for failed jobs every minute'
AS
  CALL ADE_DB.CORE.DETECT_FAILURES();

ALTER TASK ADE_DB.CORE.DETECTOR_TASK RESUME;

-- The app reads the doorbell and can request scans; nothing more.
GRANT USAGE ON SEQUENCE ADE_DB.OPS.DOORBELL_SEQ TO ROLE ADE_APP_ROLE;
GRANT USAGE ON PROCEDURE ADE_DB.CORE.REQUEST_SCAN() TO ROLE ADE_APP_ROLE;
GRANT MONITOR ON TASK ADE_DB.CORE.DETECTOR_TASK TO ROLE ADE_APP_ROLE;
GRANT SELECT ON TABLE ADE_DB.CORE.HISTORY_STAGE TO ROLE ADE_APP_ROLE;
