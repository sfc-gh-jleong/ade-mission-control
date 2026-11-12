/* =====================================================================
   90 — Demo pipeline: ADE_DEMO_RETAIL + failure scenarios
   ---------------------------------------------------------------------
   A small, realistic retail pipeline plus SECURE owner's-rights procedures
   in ADE_DB.CHAOS that break it in six repeatable ways:

     drop_target_table       MART.DAILY_REVENUE dropped        -> BUILD_DAILY_REVENUE fails (002003)
     upstream_column_rename  RAW.ORDERS.CHANNEL renamed        -> CLEAN_ORDERS fails (000904)
     bad_numeric_values      'N/A' / '1,299.00' amounts land   -> CLEAN_ORDERS fails (100038)
     duplicate_source_rows   corrected re-sends of orders      -> CLEAN_ORDERS MERGE fails (100090)
     zero_revenue_division   zero-value PROMO orders           -> BUILD_DAILY_REVENUE fails (100051)
     dt_column_rename        RAW.CUSTOMERS.REGION renamed      -> MART.CUSTOMER_LTV refresh fails

   Task graph (root suspended: runs only via EXECUTE TASK, so no idle cost):
     LOAD_ORDERS -> CLEAN_ORDERS -> BUILD_DAILY_REVENUE -> PUBLISH_SNAPSHOT
   Dynamic table: MART.CUSTOMER_LTV (RAW.CUSTOMERS + STAGING.ORDERS_CLEAN)

   Two owners of the code, one owner role:
     - The pipeline code (schemas STAGING, MART, ORCHESTRATION, DEPLOY; the
       tasks after LOAD_ORDERS; CUSTOMER_LTV; the target tables) lives in
       GitHub, sfc-gh-jleong/ade-demo-retail, and is deployed by GitHub
       Actions as GHA_ADE_DEMO_SVC (sql/10_demo_repo_deploy_user.sql).
     - This file plays the source system: RAW and REF, their data, and the
       root task LOAD_ORDERS (the e-commerce platform's loader). Scenarios
       change these on purpose; a deploy from the repo never touches them.
   Every task in a graph must have the same owner, so ADE_DEMO_OWNER owns
   the database, the objects in it and the CHAOS procedures, and is the
   deploy user's role. It is granted to SYSADMIN.

   The procedures are SECURE, so ADE_APP_ROLE (used by the agents and the
   app's Chaos Lab) can call them but cannot read how a scenario works.

   Setup order:
     snow sql -f sql/90_demo_pipeline.sql -c osm_deploy
     snow sql -f sql/03_scope_grants.sql -D "db=ADE_DEMO_RETAIL" -c osm_deploy
     snow sql -q "CALL ADE_DB.CHAOS.RESET_DEMO(FALSE)" -c osm_deploy
     then run the Deploy workflow in sfc-gh-jleong/ade-demo-retail, which
     creates the repo's objects and runs the pipeline once.
   Re-runnable: it re-applies ownership and grants and replaces the procedures.
   ===================================================================== */
USE ROLE SECURITYADMIN;
CREATE ROLE IF NOT EXISTS ADE_DEMO_OWNER
  COMMENT = 'Owns ADE_DEMO_RETAIL and the ADE_DB.CHAOS procedures; role of the demo repo''s deploy user';
GRANT ROLE ADE_DEMO_OWNER TO ROLE SYSADMIN;

USE ROLE ACCOUNTADMIN;
GRANT EXECUTE TASK ON ACCOUNT TO ROLE ADE_DEMO_OWNER;
GRANT USAGE ON WAREHOUSE COMPUTE_WH TO ROLE ADE_DEMO_OWNER;
-- The CHAOS procedures live in ADE_DB (owned by ADE_OWNER_ROLE).
GRANT USAGE ON DATABASE ADE_DB TO ROLE ADE_DEMO_OWNER;

USE ROLE SYSADMIN;
USE WAREHOUSE COMPUTE_WH;
USE SECONDARY ROLES NONE;

CREATE DATABASE IF NOT EXISTS ADE_DEMO_RETAIL
  COMMENT = 'Retail demo pipeline (orders -> revenue mart) monitored by ADE Mission Control';

-- Hand the database and everything in it to ADE_DEMO_OWNER. A task's owner
-- can only change while it is suspended, and Snowflake suspends the tasks it
-- transfers, so the children are resumed afterwards. The root stays suspended.
ALTER TASK IF EXISTS ADE_DEMO_RETAIL.ORCHESTRATION.PUBLISH_SNAPSHOT SUSPEND;
ALTER TASK IF EXISTS ADE_DEMO_RETAIL.ORCHESTRATION.BUILD_DAILY_REVENUE SUSPEND;
ALTER TASK IF EXISTS ADE_DEMO_RETAIL.ORCHESTRATION.CLEAN_ORDERS SUSPEND;
GRANT OWNERSHIP ON DATABASE ADE_DEMO_RETAIL TO ROLE ADE_DEMO_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ALL SCHEMAS IN DATABASE ADE_DEMO_RETAIL TO ROLE ADE_DEMO_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ALL TABLES IN DATABASE ADE_DEMO_RETAIL TO ROLE ADE_DEMO_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ALL DYNAMIC TABLES IN DATABASE ADE_DEMO_RETAIL TO ROLE ADE_DEMO_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ALL TASKS IN DATABASE ADE_DEMO_RETAIL TO ROLE ADE_DEMO_OWNER COPY CURRENT GRANTS;
ALTER TASK IF EXISTS ADE_DEMO_RETAIL.ORCHESTRATION.PUBLISH_SNAPSHOT RESUME;
ALTER TASK IF EXISTS ADE_DEMO_RETAIL.ORCHESTRATION.BUILD_DAILY_REVENUE RESUME;
ALTER TASK IF EXISTS ADE_DEMO_RETAIL.ORCHESTRATION.CLEAN_ORDERS RESUME;

CREATE SCHEMA IF NOT EXISTS ADE_DB.CHAOS
  COMMENT = 'Failure scenarios for the ADE_DEMO_RETAIL demo pipeline';
GRANT USAGE ON SCHEMA ADE_DB.CHAOS TO ROLE ADE_DEMO_OWNER;
-- The procedures are owned by ADE_DEMO_OWNER, so the objects they create
-- (RAW and REF tables, LOAD_ORDERS) have the same owner as the repo's tasks.
-- CREATE PROCEDURE is granted only while this script runs.
GRANT CREATE PROCEDURE ON SCHEMA ADE_DB.CHAOS TO ROLE ADE_DEMO_OWNER;
DROP PROCEDURE IF EXISTS ADE_DB.CHAOS.RESET_DEMO();
DROP PROCEDURE IF EXISTS ADE_DB.CHAOS.RESET_DEMO(BOOLEAN);
DROP PROCEDURE IF EXISTS ADE_DB.CHAOS.BREAK_DEMO(VARCHAR, BOOLEAN);
DROP PROCEDURE IF EXISTS ADE_DB.CHAOS.RUN_DEMO();

USE ROLE ADE_DEMO_OWNER;
USE WAREHOUSE COMPUTE_WH;

-- ---------------------------------------------------------------------
-- RESET_DEMO: reset the source side to a healthy state with 14 days of
-- orders, empty the repo-managed tables, and (by default) run the pipeline
-- once. Repo-managed definitions are never changed here: a missing object
-- returns status 'deploy_needed' (run the repo's Deploy workflow).
-- RUN_PIPELINE = FALSE resets data only (used by scripts/reset-to-baseline.sh
-- in the repo, before it restores and deploys the baseline code).
-- ---------------------------------------------------------------------
CREATE PROCEDURE ADE_DB.CHAOS.RESET_DEMO(RUN_PIPELINE BOOLEAN DEFAULT TRUE)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = 'Reset the source side of ADE_DEMO_RETAIL to a healthy state and optionally run the pipeline once'
EXECUTE AS OWNER
AS
$$
DECLARE
  missing ARRAY;
  graph_status VARCHAR DEFAULT 'NOT_RUN';
  graph_error VARCHAR;
  dt_error VARCHAR;
BEGIN
  -- Source system: rebuilt with fresh data.
  CREATE OR REPLACE SCHEMA ADE_DEMO_RETAIL.RAW COMMENT = 'Data as landed from source systems';
  CREATE OR REPLACE SCHEMA ADE_DEMO_RETAIL.REF COMMENT = 'Reference data';

  CREATE TABLE ADE_DEMO_RETAIL.RAW.ORDERS (
    ORDER_ID     NUMBER(38,0)  NOT NULL,
    CUSTOMER_ID  NUMBER(38,0)  NOT NULL,
    AMOUNT       VARCHAR(32)   COMMENT 'Gross amount in order currency, as text from the source',
    DISCOUNT     VARCHAR(32)   COMMENT 'Discount in order currency, as text from the source',
    CURRENCY     VARCHAR(3)    NOT NULL,
    CHANNEL      VARCHAR(20)   NOT NULL,
    ORDER_TS     TIMESTAMP_NTZ NOT NULL,
    _LOADED_AT   TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE()
  ) COMMENT = 'Orders landed from the e-commerce platform; amounts arrive as text';

  CREATE TABLE ADE_DEMO_RETAIL.RAW.CUSTOMERS (
    CUSTOMER_ID  NUMBER(38,0)  NOT NULL,
    FULL_NAME    VARCHAR(200)  NOT NULL,
    REGION       VARCHAR(20)   NOT NULL,
    SIGNUP_DATE  DATE          NOT NULL
  ) COMMENT = 'Customer master from the CRM';

  CREATE TABLE ADE_DEMO_RETAIL.REF.FX_RATES (
    CURRENCY     VARCHAR(3)    NOT NULL,
    RATE_TO_USD  NUMBER(12,6)  NOT NULL
  ) COMMENT = 'FX rates to USD';

  INSERT INTO ADE_DEMO_RETAIL.REF.FX_RATES VALUES
    ('USD', 1.000000), ('EUR', 1.081200), ('GBP', 1.268400), ('CAD', 0.731500);

  INSERT INTO ADE_DEMO_RETAIL.RAW.CUSTOMERS
  SELECT SEQ4() + 1,
         'Customer ' || LPAD(TO_VARCHAR(SEQ4() + 1), 4, '0'),
         DECODE(MOD(SEQ4(), 4), 0, 'NA', 1, 'EMEA', 2, 'APAC', 'LATAM'),
         DATEADD(day, -UNIFORM(30, 900, RANDOM()), CURRENT_DATE())
  FROM TABLE(GENERATOR(ROWCOUNT => 200));

  INSERT INTO ADE_DEMO_RETAIL.RAW.ORDERS (ORDER_ID, CUSTOMER_ID, AMOUNT, DISCOUNT, CURRENCY, CHANNEL, ORDER_TS)
  SELECT 100000 + SEQ4() + 1,
         UNIFORM(1, 200, RANDOM()),
         TO_VARCHAR(UNIFORM(500, 25000, RANDOM()) / 100, 'FM999990.00'),
         TO_VARCHAR(UNIFORM(0, 400, RANDOM()) / 100, 'FM9990.00'),
         DECODE(UNIFORM(1, 4, RANDOM()), 1, 'USD', 2, 'EUR', 3, 'GBP', 'CAD'),
         DECODE(UNIFORM(1, 3, RANDOM()), 1, 'WEB', 2, 'MOBILE', 'STORE'),
         DATEADD(minute, -UNIFORM(0, 20160, RANDOM()), SYSDATE())
  FROM TABLE(GENERATOR(ROWCOUNT => 1500));

  -- The root task is the platform's loader. CREATE OR ALTER keeps the repo's
  -- tasks linked to it (CREATE OR REPLACE would detach them).
  CREATE SCHEMA IF NOT EXISTS ADE_DEMO_RETAIL.ORCHESTRATION COMMENT = 'Pipeline tasks';
  CREATE OR ALTER TASK ADE_DEMO_RETAIL.ORCHESTRATION.LOAD_ORDERS
    WAREHOUSE = COMPUTE_WH
    SCHEDULE = 'USING CRON 0 * * * * UTC'
    COMMENT = 'Lands the latest batch of orders from the e-commerce platform'
  AS
    INSERT INTO ADE_DEMO_RETAIL.RAW.ORDERS (ORDER_ID, CUSTOMER_ID, AMOUNT, DISCOUNT, CURRENCY, CHANNEL, ORDER_TS)
    SELECT m.MAX_ID + ROW_NUMBER() OVER (ORDER BY SEQ4()),
           UNIFORM(1, 200, RANDOM()),
           TO_VARCHAR(UNIFORM(500, 25000, RANDOM()) / 100, 'FM999990.00'),
           TO_VARCHAR(UNIFORM(0, 400, RANDOM()) / 100, 'FM9990.00'),
           DECODE(UNIFORM(1, 4, RANDOM()), 1, 'USD', 2, 'EUR', 3, 'GBP', 'CAD'),
           DECODE(UNIFORM(1, 3, RANDOM()), 1, 'WEB', 2, 'MOBILE', 'STORE'),
           DATEADD(minute, -UNIFORM(0, 60, RANDOM()), SYSDATE())
    FROM TABLE(GENERATOR(ROWCOUNT => 40)),
         (SELECT COALESCE(MAX(ORDER_ID), 100000) AS MAX_ID FROM ADE_DEMO_RETAIL.RAW.ORDERS) m;

  -- Repo-managed objects that are missing, or tasks no longer linked to the
  -- graph, can only come back through a deploy of the repo.
  SELECT COALESCE(ARRAY_AGG(o.N) WITHIN GROUP (ORDER BY o.N), ARRAY_CONSTRUCT()) INTO :missing
  FROM (VALUES ('STAGING.ORDERS_CLEAN', 'TABLE'), ('MART.DAILY_REVENUE', 'TABLE'), ('MART.REVENUE_SNAPSHOTS', 'TABLE'),
               ('MART.CUSTOMER_LTV', 'TABLE'), ('DEPLOY.CHANGE_HISTORY', 'TABLE'),
               ('ORCHESTRATION.CLEAN_ORDERS', 'TASK'), ('ORCHESTRATION.BUILD_DAILY_REVENUE', 'TASK'),
               ('ORCHESTRATION.PUBLISH_SNAPSHOT', 'TASK')) AS o (N, K)
  WHERE (o.K = 'TABLE' AND NOT EXISTS (
           SELECT 1 FROM ADE_DEMO_RETAIL.INFORMATION_SCHEMA.TABLES t WHERE t.TABLE_SCHEMA || '.' || t.TABLE_NAME = o.N))
     OR (o.K = 'TASK' AND NOT EXISTS (
           SELECT 1 FROM TABLE(ADE_DEMO_RETAIL.INFORMATION_SCHEMA.TASK_DEPENDENTS(
                    TASK_NAME => 'ADE_DEMO_RETAIL.ORCHESTRATION.LOAD_ORDERS', RECURSIVE => TRUE)) d
           WHERE d.SCHEMA_NAME || '.' || d.NAME = o.N));

  -- Repo-managed objects that exist: empty their data and resume them
  -- (Snowflake suspends tasks after repeated failures). Definitions are left
  -- alone. Each statement runs only if its object exists (IF EXISTS does not
  -- cover a missing schema).
  IF (NOT ARRAY_CONTAINS('STAGING.ORDERS_CLEAN'::VARIANT, :missing)) THEN
    TRUNCATE TABLE ADE_DEMO_RETAIL.STAGING.ORDERS_CLEAN;
  END IF;
  IF (NOT ARRAY_CONTAINS('MART.DAILY_REVENUE'::VARIANT, :missing)) THEN
    TRUNCATE TABLE ADE_DEMO_RETAIL.MART.DAILY_REVENUE;
  END IF;
  IF (NOT ARRAY_CONTAINS('MART.REVENUE_SNAPSHOTS'::VARIANT, :missing)) THEN
    TRUNCATE TABLE ADE_DEMO_RETAIL.MART.REVENUE_SNAPSHOTS;
  END IF;
  IF (NOT ARRAY_CONTAINS('ORCHESTRATION.PUBLISH_SNAPSHOT'::VARIANT, :missing)) THEN
    ALTER TASK ADE_DEMO_RETAIL.ORCHESTRATION.PUBLISH_SNAPSHOT RESUME;
  END IF;
  IF (NOT ARRAY_CONTAINS('ORCHESTRATION.BUILD_DAILY_REVENUE'::VARIANT, :missing)) THEN
    ALTER TASK ADE_DEMO_RETAIL.ORCHESTRATION.BUILD_DAILY_REVENUE RESUME;
  END IF;
  IF (NOT ARRAY_CONTAINS('ORCHESTRATION.CLEAN_ORDERS'::VARIANT, :missing)) THEN
    ALTER TASK ADE_DEMO_RETAIL.ORCHESTRATION.CLEAN_ORDERS RESUME;
  END IF;
  IF (NOT ARRAY_CONTAINS('MART.CUSTOMER_LTV'::VARIANT, :missing)) THEN
    ALTER DYNAMIC TABLE ADE_DEMO_RETAIL.MART.CUSTOMER_LTV RESUME;
  END IF;

  IF (ARRAY_SIZE(:missing) > 0) THEN
    RETURN OBJECT_CONSTRUCT(
      'status', 'deploy_needed',
      'missing', :missing,
      'message', 'Run the Deploy workflow in sfc-gh-jleong/ade-demo-retail to recreate these objects.',
      'reset_at', SYSDATE());
  END IF;

  IF (:RUN_PIPELINE) THEN
    BEGIN
      EXECUTE TASK ADE_DEMO_RETAIL.ORCHESTRATION.LOAD_ORDERS AWAIT;
      graph_status := 'SUCCEEDED';
    EXCEPTION
      WHEN OTHER THEN
        graph_status := 'FAILED';
        graph_error := SQLERRM;
    END;
    BEGIN
      ALTER DYNAMIC TABLE ADE_DEMO_RETAIL.MART.CUSTOMER_LTV REFRESH;
    EXCEPTION
      WHEN OTHER THEN dt_error := SQLERRM;
    END;
  END IF;

  RETURN OBJECT_CONSTRUCT(
    'status', IFF(:graph_status = 'FAILED' OR :dt_error IS NOT NULL, 'unhealthy', 'healthy'),
    'graph_run', :graph_status,
    'graph_error', :graph_error,
    'dt_refresh_error', :dt_error,
    'hint', IFF(:graph_status = 'FAILED' OR :dt_error IS NOT NULL,
                'The pipeline failed on fresh source data. If a fix was merged in sfc-gh-jleong/ade-demo-retail, run scripts/reset-to-baseline.sh there.',
                NULL),
    'reset_at', SYSDATE());
END;
$$;

-- ---------------------------------------------------------------------
-- BREAK_DEMO: inject one failure scenario and trigger the affected job so
-- the failure is recorded within about a minute. RESET first so scenarios
-- never stack; nothing is injected unless the reset left the pipeline healthy.
-- ---------------------------------------------------------------------
CREATE PROCEDURE ADE_DB.CHAOS.BREAK_DEMO(SCENARIO VARCHAR, RESET_FIRST BOOLEAN DEFAULT TRUE)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = 'Inject a failure scenario into ADE_DEMO_RETAIL and trigger the affected job'
EXECUTE AS OWNER
AS
$$
DECLARE
  s VARCHAR;
  failing_job VARCHAR;
  trigger_error VARCHAR;
  reset_result VARIANT;
  unknown_scenario EXCEPTION (-20001, 'Unknown scenario');
BEGIN
  s := LOWER(TRIM(:SCENARIO));
  IF (s NOT IN ('drop_target_table', 'upstream_column_rename', 'bad_numeric_values',
                'duplicate_source_rows', 'zero_revenue_division', 'dt_column_rename')) THEN
    RAISE unknown_scenario;
  END IF;

  IF (:RESET_FIRST) THEN
    CALL ADE_DB.CHAOS.RESET_DEMO(TRUE) INTO :reset_result;
    IF (GET(:reset_result, 'status')::VARCHAR <> 'healthy') THEN
      RETURN OBJECT_CONSTRUCT(
        'scenario', s,
        'status', 'not_injected',
        'reason', 'The reset did not leave the pipeline healthy, so the scenario was not injected.',
        'reset', :reset_result);
    END IF;
  END IF;

  IF (s = 'drop_target_table') THEN
    DROP TABLE ADE_DEMO_RETAIL.MART.DAILY_REVENUE;
    failing_job := 'ADE_DEMO_RETAIL.ORCHESTRATION.BUILD_DAILY_REVENUE';

  ELSEIF (s = 'upstream_column_rename') THEN
    -- The source team renames a column and updates their loader.
    ALTER TABLE ADE_DEMO_RETAIL.RAW.ORDERS RENAME COLUMN CHANNEL TO SALES_CHANNEL;
    ALTER TASK ADE_DEMO_RETAIL.ORCHESTRATION.LOAD_ORDERS MODIFY AS
      INSERT INTO ADE_DEMO_RETAIL.RAW.ORDERS (ORDER_ID, CUSTOMER_ID, AMOUNT, DISCOUNT, CURRENCY, SALES_CHANNEL, ORDER_TS)
      SELECT m.MAX_ID + ROW_NUMBER() OVER (ORDER BY SEQ4()),
             UNIFORM(1, 200, RANDOM()),
             TO_VARCHAR(UNIFORM(500, 25000, RANDOM()) / 100, 'FM999990.00'),
             TO_VARCHAR(UNIFORM(0, 400, RANDOM()) / 100, 'FM9990.00'),
             DECODE(UNIFORM(1, 4, RANDOM()), 1, 'USD', 2, 'EUR', 3, 'GBP', 'CAD'),
             DECODE(UNIFORM(1, 3, RANDOM()), 1, 'WEB', 2, 'MOBILE', 'STORE'),
             DATEADD(minute, -UNIFORM(0, 60, RANDOM()), SYSDATE())
      FROM TABLE(GENERATOR(ROWCOUNT => 40)),
           (SELECT COALESCE(MAX(ORDER_ID), 100000) AS MAX_ID FROM ADE_DEMO_RETAIL.RAW.ORDERS) m;
    failing_job := 'ADE_DEMO_RETAIL.ORCHESTRATION.CLEAN_ORDERS';

  ELSEIF (s = 'bad_numeric_values') THEN
    INSERT INTO ADE_DEMO_RETAIL.RAW.ORDERS (ORDER_ID, CUSTOMER_ID, AMOUNT, DISCOUNT, CURRENCY, CHANNEL, ORDER_TS)
    SELECT m.MAX_ID + v.N, v.CUSTOMER_ID, v.AMOUNT, '0.00', v.CURRENCY, 'WEB', SYSDATE()
    FROM (SELECT COALESCE(MAX(ORDER_ID), 100000) AS MAX_ID FROM ADE_DEMO_RETAIL.RAW.ORDERS) m,
         (SELECT 1 AS N, 17 AS CUSTOMER_ID, 'N/A' AS AMOUNT, 'USD' AS CURRENCY
          UNION ALL SELECT 2, 42, '1,299.00', 'USD'
          UNION ALL SELECT 3, 99, '87.50', 'EUR') v;
    failing_job := 'ADE_DEMO_RETAIL.ORCHESTRATION.CLEAN_ORDERS';

  ELSEIF (s = 'duplicate_source_rows') THEN
    -- The platform re-sends corrected copies of recent orders.
    INSERT INTO ADE_DEMO_RETAIL.RAW.ORDERS (ORDER_ID, CUSTOMER_ID, AMOUNT, DISCOUNT, CURRENCY, CHANNEL, ORDER_TS)
    SELECT ORDER_ID, CUSTOMER_ID, TO_VARCHAR(AMOUNT::NUMBER(12,2) + 5, 'FM999990.00'), DISCOUNT, CURRENCY, CHANNEL, ORDER_TS
    FROM ADE_DEMO_RETAIL.RAW.ORDERS
    ORDER BY ORDER_ID DESC
    LIMIT 5;
    failing_job := 'ADE_DEMO_RETAIL.ORCHESTRATION.CLEAN_ORDERS';

  ELSEIF (s = 'zero_revenue_division') THEN
    -- Marketing launches free promotional orders.
    INSERT INTO ADE_DEMO_RETAIL.RAW.ORDERS (ORDER_ID, CUSTOMER_ID, AMOUNT, DISCOUNT, CURRENCY, CHANNEL, ORDER_TS)
    SELECT m.MAX_ID + ROW_NUMBER() OVER (ORDER BY SEQ4()), UNIFORM(1, 200, RANDOM()), '0.00', '0.00', 'USD', 'PROMO', SYSDATE()
    FROM TABLE(GENERATOR(ROWCOUNT => 6)),
         (SELECT COALESCE(MAX(ORDER_ID), 100000) AS MAX_ID FROM ADE_DEMO_RETAIL.RAW.ORDERS) m;
    failing_job := 'ADE_DEMO_RETAIL.ORCHESTRATION.BUILD_DAILY_REVENUE';

  ELSE
    ALTER TABLE ADE_DEMO_RETAIL.RAW.CUSTOMERS RENAME COLUMN REGION TO SALES_REGION;
    failing_job := 'ADE_DEMO_RETAIL.MART.CUSTOMER_LTV';
  END IF;

  -- Trigger the affected job now instead of waiting for its schedule.
  IF (s = 'dt_column_rename') THEN
    BEGIN
      ALTER DYNAMIC TABLE ADE_DEMO_RETAIL.MART.CUSTOMER_LTV REFRESH;
    EXCEPTION
      WHEN OTHER THEN trigger_error := SQLERRM;
    END;
  ELSE
    EXECUTE TASK ADE_DEMO_RETAIL.ORCHESTRATION.LOAD_ORDERS;
  END IF;

  RETURN OBJECT_CONSTRUCT(
    'scenario', s,
    'status', 'injected',
    'expected_failing_job', failing_job,
    'trigger_error', trigger_error,
    'triggered_at', SYSDATE());
END;
$$;

-- RUN_DEMO: trigger a normal run of the pipeline (graph + DT refresh).
CREATE PROCEDURE ADE_DB.CHAOS.RUN_DEMO()
RETURNS VARIANT
LANGUAGE SQL
COMMENT = 'Trigger a run of the ADE_DEMO_RETAIL task graph and dynamic table'
EXECUTE AS OWNER
AS
$$
DECLARE
  dt_error VARCHAR;
BEGIN
  EXECUTE TASK ADE_DEMO_RETAIL.ORCHESTRATION.LOAD_ORDERS;
  BEGIN
    ALTER DYNAMIC TABLE ADE_DEMO_RETAIL.MART.CUSTOMER_LTV REFRESH;
  EXCEPTION
    WHEN OTHER THEN dt_error := SQLERRM;
  END;
  RETURN OBJECT_CONSTRUCT('triggered_at', SYSDATE(), 'dt_refresh_error', dt_error);
END;
$$;

-- The app's Chaos Lab calls these as ADE_APP_ROLE. SECURE hides the bodies.
GRANT USAGE ON PROCEDURE ADE_DB.CHAOS.RESET_DEMO(BOOLEAN) TO ROLE ADE_APP_ROLE;
GRANT USAGE ON PROCEDURE ADE_DB.CHAOS.BREAK_DEMO(VARCHAR, BOOLEAN) TO ROLE ADE_APP_ROLE;
GRANT USAGE ON PROCEDURE ADE_DB.CHAOS.RUN_DEMO() TO ROLE ADE_APP_ROLE;

USE ROLE SYSADMIN;
GRANT USAGE ON SCHEMA ADE_DB.CHAOS TO ROLE ADE_APP_ROLE;
REVOKE CREATE PROCEDURE ON SCHEMA ADE_DB.CHAOS FROM ROLE ADE_DEMO_OWNER;

-- Verify: owners in the demo database (expect ADE_DEMO_OWNER only) and the procedures.
SHOW OBJECTS IN DATABASE ADE_DEMO_RETAIL
  ->> SELECT "owner", "kind", COUNT(*) AS objects FROM $1 WHERE "schema_name" <> 'INFORMATION_SCHEMA' GROUP BY 1, 2 ORDER BY 1, 2;
SHOW TASKS IN DATABASE ADE_DEMO_RETAIL
  ->> SELECT "name", "owner", "state" FROM $1 ORDER BY 1;
SHOW PROCEDURES IN SCHEMA ADE_DB.CHAOS
  ->> SELECT "name", "arguments" FROM $1 WHERE "is_builtin" = 'N';
