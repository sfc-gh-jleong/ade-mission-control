/* =====================================================================
   90 — Demo pipeline: ADE_DEMO_RETAIL + failure scenarios
   ---------------------------------------------------------------------
   A small, realistic retail pipeline owned by SYSADMIN (like any
   production database), plus SECURE owner's-rights procedures in
   ADE_DB.CHAOS that break it in six repeatable ways:

     drop_target_table       MART.DAILY_REVENUE dropped        -> BUILD_DAILY_REVENUE fails (002003)
     upstream_column_rename  RAW.ORDERS.CHANNEL renamed        -> CLEAN_ORDERS fails (000904)
     bad_numeric_values      'N/A' / '1,299.00' amounts land   -> CLEAN_ORDERS fails (100038)
     duplicate_source_rows   corrected re-sends of orders      -> CLEAN_ORDERS MERGE fails (100090)
     zero_revenue_division   zero-value PROMO orders           -> BUILD_DAILY_REVENUE fails (100051)
     dt_column_rename        RAW.CUSTOMERS.REGION renamed      -> MART.CUSTOMER_LTV refresh fails

   Task graph (root suspended: runs only via EXECUTE TASK, so no idle cost):
     LOAD_ORDERS -> CLEAN_ORDERS -> BUILD_DAILY_REVENUE -> PUBLISH_SNAPSHOT
   Dynamic table: MART.CUSTOMER_LTV (RAW.CUSTOMERS + STAGING.ORDERS_CLEAN)

   The procedures are SECURE, so ADE_APP_ROLE (used by the agents and the
   app's Chaos Lab) can call them but cannot read how a scenario works.

   Setup order:
     snow sql -f sql/90_demo_pipeline.sql -c osm_deploy
     snow sql -f sql/03_scope_grants.sql -D "db=ADE_DEMO_RETAIL" -c osm_deploy
     snow sql -q "CALL ADE_DB.CHAOS.RESET_DEMO()" -c osm_deploy
   ===================================================================== */
USE ROLE SYSADMIN;
USE WAREHOUSE COMPUTE_WH;

CREATE DATABASE IF NOT EXISTS ADE_DEMO_RETAIL
  COMMENT = 'Retail demo pipeline (orders -> revenue mart) monitored by ADE Mission Control';

CREATE SCHEMA IF NOT EXISTS ADE_DB.CHAOS
  COMMENT = 'Failure scenarios for the ADE_DEMO_RETAIL demo pipeline (owned by SYSADMIN)';

-- ---------------------------------------------------------------------
-- RESET_DEMO: rebuild ADE_DEMO_RETAIL in a healthy state with 14 days of
-- orders, run the graph once, and initialise the dynamic table.
-- ---------------------------------------------------------------------
CREATE OR REPLACE SECURE PROCEDURE ADE_DB.CHAOS.RESET_DEMO()
RETURNS VARIANT
LANGUAGE SQL
COMMENT = 'Rebuild ADE_DEMO_RETAIL in a healthy state'
EXECUTE AS OWNER
AS
$$
DECLARE
  graph_status VARCHAR;
BEGIN
  CREATE OR REPLACE SCHEMA ADE_DEMO_RETAIL.RAW           COMMENT = 'Data as landed from source systems';
  CREATE OR REPLACE SCHEMA ADE_DEMO_RETAIL.REF           COMMENT = 'Reference data';
  CREATE OR REPLACE SCHEMA ADE_DEMO_RETAIL.STAGING       COMMENT = 'Cleaned and conformed data';
  CREATE OR REPLACE SCHEMA ADE_DEMO_RETAIL.MART          COMMENT = 'Reporting tables';
  CREATE OR REPLACE SCHEMA ADE_DEMO_RETAIL.ORCHESTRATION COMMENT = 'Pipeline tasks';

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

  CREATE TABLE ADE_DEMO_RETAIL.STAGING.ORDERS_CLEAN (
    ORDER_ID      NUMBER(38,0)  NOT NULL,
    CUSTOMER_ID   NUMBER(38,0)  NOT NULL,
    AMOUNT_USD    NUMBER(12,2),
    DISCOUNT_USD  NUMBER(12,2),
    ORDER_DATE    DATE          NOT NULL,
    CHANNEL       VARCHAR(20)   NOT NULL,
    UPDATED_AT    TIMESTAMP_NTZ NOT NULL
  ) COMMENT = 'Orders conformed to USD, one row per order';

  CREATE TABLE ADE_DEMO_RETAIL.MART.DAILY_REVENUE (
    ORDER_DATE     DATE          NOT NULL,
    CHANNEL        VARCHAR(20)   NOT NULL,
    ORDERS         NUMBER(38,0)  NOT NULL,
    REVENUE_USD    NUMBER(14,2),
    AVG_ORDER_USD  NUMBER(12,2),
    DISCOUNT_PCT   NUMBER(6,2),
    BUILT_AT       TIMESTAMP_NTZ NOT NULL
  ) COMMENT = 'Daily revenue by sales channel, rebuilt by the pipeline';

  CREATE TABLE ADE_DEMO_RETAIL.MART.REVENUE_SNAPSHOTS (
    SNAPSHOT_AT  TIMESTAMP_NTZ NOT NULL,
    DAYS         NUMBER(38,0),
    ORDERS       NUMBER(38,0),
    REVENUE_USD  NUMBER(16,2)
  ) COMMENT = 'Point-in-time revenue totals published after each build';

  -- Seed data
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

  -- Task graph
  CREATE TASK ADE_DEMO_RETAIL.ORCHESTRATION.LOAD_ORDERS
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

  CREATE TASK ADE_DEMO_RETAIL.ORCHESTRATION.CLEAN_ORDERS
    WAREHOUSE = COMPUTE_WH
    COMMENT = 'Converts recent orders to USD and upserts them into STAGING.ORDERS_CLEAN'
    AFTER ADE_DEMO_RETAIL.ORCHESTRATION.LOAD_ORDERS
  AS
    MERGE INTO ADE_DEMO_RETAIL.STAGING.ORDERS_CLEAN t
    USING (
      SELECT o.ORDER_ID,
             o.CUSTOMER_ID,
             ROUND(o.AMOUNT::NUMBER(12,2)   * fx.RATE_TO_USD, 2) AS AMOUNT_USD,
             ROUND(o.DISCOUNT::NUMBER(12,2) * fx.RATE_TO_USD, 2) AS DISCOUNT_USD,
             o.ORDER_TS::DATE AS ORDER_DATE,
             o.CHANNEL
      FROM ADE_DEMO_RETAIL.RAW.ORDERS o
      JOIN ADE_DEMO_RETAIL.REF.FX_RATES fx ON fx.CURRENCY = o.CURRENCY
      WHERE o._LOADED_AT >= DATEADD(day, -2, SYSDATE())
    ) s
    ON t.ORDER_ID = s.ORDER_ID
    WHEN MATCHED THEN UPDATE SET
      t.CUSTOMER_ID = s.CUSTOMER_ID, t.AMOUNT_USD = s.AMOUNT_USD, t.DISCOUNT_USD = s.DISCOUNT_USD,
      t.ORDER_DATE = s.ORDER_DATE, t.CHANNEL = s.CHANNEL, t.UPDATED_AT = SYSDATE()
    WHEN NOT MATCHED THEN INSERT (ORDER_ID, CUSTOMER_ID, AMOUNT_USD, DISCOUNT_USD, ORDER_DATE, CHANNEL, UPDATED_AT)
      VALUES (s.ORDER_ID, s.CUSTOMER_ID, s.AMOUNT_USD, s.DISCOUNT_USD, s.ORDER_DATE, s.CHANNEL, SYSDATE());

  CREATE TASK ADE_DEMO_RETAIL.ORCHESTRATION.BUILD_DAILY_REVENUE
    WAREHOUSE = COMPUTE_WH
    COMMENT = 'Rebuilds MART.DAILY_REVENUE from STAGING.ORDERS_CLEAN'
    AFTER ADE_DEMO_RETAIL.ORCHESTRATION.CLEAN_ORDERS
  AS
    INSERT OVERWRITE INTO ADE_DEMO_RETAIL.MART.DAILY_REVENUE
      (ORDER_DATE, CHANNEL, ORDERS, REVENUE_USD, AVG_ORDER_USD, DISCOUNT_PCT, BUILT_AT)
    SELECT ORDER_DATE,
           CHANNEL,
           COUNT(*),
           SUM(AMOUNT_USD),
           ROUND(SUM(AMOUNT_USD) / COUNT(*), 2),
           ROUND(100 * SUM(DISCOUNT_USD) / SUM(AMOUNT_USD), 2),
           SYSDATE()
    FROM ADE_DEMO_RETAIL.STAGING.ORDERS_CLEAN
    GROUP BY ORDER_DATE, CHANNEL;

  CREATE TASK ADE_DEMO_RETAIL.ORCHESTRATION.PUBLISH_SNAPSHOT
    WAREHOUSE = COMPUTE_WH
    COMMENT = 'Publishes a revenue snapshot for the finance dashboard'
    AFTER ADE_DEMO_RETAIL.ORCHESTRATION.BUILD_DAILY_REVENUE
  AS
    INSERT INTO ADE_DEMO_RETAIL.MART.REVENUE_SNAPSHOTS (SNAPSHOT_AT, DAYS, ORDERS, REVENUE_USD)
    SELECT SYSDATE(), COUNT(DISTINCT ORDER_DATE), SUM(ORDERS), SUM(REVENUE_USD)
    FROM ADE_DEMO_RETAIL.MART.DAILY_REVENUE;

  -- Children resumed, root left suspended (runs via EXECUTE TASK only).
  ALTER TASK ADE_DEMO_RETAIL.ORCHESTRATION.PUBLISH_SNAPSHOT RESUME;
  ALTER TASK ADE_DEMO_RETAIL.ORCHESTRATION.BUILD_DAILY_REVENUE RESUME;
  ALTER TASK ADE_DEMO_RETAIL.ORCHESTRATION.CLEAN_ORDERS RESUME;

  EXECUTE TASK ADE_DEMO_RETAIL.ORCHESTRATION.LOAD_ORDERS AWAIT;
  graph_status := 'SUCCEEDED';

  CREATE DYNAMIC TABLE ADE_DEMO_RETAIL.MART.CUSTOMER_LTV
    TARGET_LAG = '1 day'
    WAREHOUSE = COMPUTE_WH
    COMMENT = 'Customer lifetime value by region'
  AS
    SELECT c.CUSTOMER_ID,
           c.FULL_NAME,
           c.REGION,
           COUNT(o.ORDER_ID)  AS ORDERS,
           SUM(o.AMOUNT_USD)  AS LIFETIME_USD,
           MAX(o.ORDER_DATE)  AS LAST_ORDER_DATE
    FROM ADE_DEMO_RETAIL.RAW.CUSTOMERS c
    LEFT JOIN ADE_DEMO_RETAIL.STAGING.ORDERS_CLEAN o ON o.CUSTOMER_ID = c.CUSTOMER_ID
    GROUP BY c.CUSTOMER_ID, c.FULL_NAME, c.REGION;

  RETURN OBJECT_CONSTRUCT('status', 'healthy', 'graph_run', graph_status, 'reset_at', SYSDATE());
END;
$$;

-- ---------------------------------------------------------------------
-- BREAK_DEMO: inject one failure scenario and trigger the affected job so
-- the failure is recorded within about a minute. RESET first so scenarios
-- never stack.
-- ---------------------------------------------------------------------
CREATE OR REPLACE SECURE PROCEDURE ADE_DB.CHAOS.BREAK_DEMO(SCENARIO VARCHAR, RESET_FIRST BOOLEAN DEFAULT TRUE)
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
  unknown_scenario EXCEPTION (-20001, 'Unknown scenario');
BEGIN
  s := LOWER(TRIM(:SCENARIO));
  IF (s NOT IN ('drop_target_table', 'upstream_column_rename', 'bad_numeric_values',
                'duplicate_source_rows', 'zero_revenue_division', 'dt_column_rename')) THEN
    RAISE unknown_scenario;
  END IF;

  IF (:RESET_FIRST) THEN
    CALL ADE_DB.CHAOS.RESET_DEMO();
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
    'expected_failing_job', failing_job,
    'trigger_error', trigger_error,
    'triggered_at', SYSDATE());
END;
$$;

-- RUN_DEMO: trigger a normal run of the pipeline (graph + DT refresh).
CREATE OR REPLACE SECURE PROCEDURE ADE_DB.CHAOS.RUN_DEMO()
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
GRANT USAGE ON SCHEMA ADE_DB.CHAOS TO ROLE ADE_APP_ROLE;
GRANT USAGE ON PROCEDURE ADE_DB.CHAOS.RESET_DEMO() TO ROLE ADE_APP_ROLE;
GRANT USAGE ON PROCEDURE ADE_DB.CHAOS.BREAK_DEMO(VARCHAR, BOOLEAN) TO ROLE ADE_APP_ROLE;
GRANT USAGE ON PROCEDURE ADE_DB.CHAOS.RUN_DEMO() TO ROLE ADE_APP_ROLE;
