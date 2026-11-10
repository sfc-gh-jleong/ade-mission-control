/* =====================================================================
   03 — Monitor a database: read-only grants + scope registration
   ---------------------------------------------------------------------
   Gives ADE_APP_ROLE exactly what the Investigator needs to observe jobs
   in one database, and nothing that can change it:
     USAGE (db, schemas), SELECT (tables, views, dynamic tables),
     MONITOR (tasks, dynamic tables, pipes, alerts).
   Deliberately NOT granted:
     - any write/OPERATE/OWNERSHIP privilege;
     - USAGE on procedures/functions. A sandboxed task that CALLs an
       owner's-rights production procedure would run as the procedure's
       owner and could write to production. Jobs that call procedures are
       rehearsed as UNSUPPORTED instead.

   Usage (re-run after new pipes/alerts are created; bulk grants are not
   supported for those object types):
     snow sql -f sql/03_scope_grants.sql -D "db=SNOWFLAKE_DEMO" -c osm_deploy
   Idempotent.
   ===================================================================== */
USE ROLE ACCOUNTADMIN;

GRANT USAGE ON DATABASE <% db %> TO ROLE ADE_APP_ROLE;
GRANT USAGE ON ALL SCHEMAS IN DATABASE <% db %> TO ROLE ADE_APP_ROLE;
GRANT USAGE ON FUTURE SCHEMAS IN DATABASE <% db %> TO ROLE ADE_APP_ROLE;

GRANT SELECT ON ALL TABLES IN DATABASE <% db %> TO ROLE ADE_APP_ROLE;
GRANT SELECT ON FUTURE TABLES IN DATABASE <% db %> TO ROLE ADE_APP_ROLE;
GRANT SELECT ON ALL VIEWS IN DATABASE <% db %> TO ROLE ADE_APP_ROLE;
GRANT SELECT ON FUTURE VIEWS IN DATABASE <% db %> TO ROLE ADE_APP_ROLE;

GRANT SELECT, MONITOR ON ALL DYNAMIC TABLES IN DATABASE <% db %> TO ROLE ADE_APP_ROLE;
GRANT SELECT, MONITOR ON FUTURE DYNAMIC TABLES IN DATABASE <% db %> TO ROLE ADE_APP_ROLE;

GRANT MONITOR ON ALL TASKS IN DATABASE <% db %> TO ROLE ADE_APP_ROLE;
GRANT MONITOR ON FUTURE TASKS IN DATABASE <% db %> TO ROLE ADE_APP_ROLE;

-- Pipes and alerts: one grant per object.
EXECUTE IMMEDIATE $$
DECLARE
  granted INTEGER DEFAULT 0;
  pipes RESULTSET;
  alerts RESULTSET;
BEGIN
  SHOW PIPES IN DATABASE <% db %>;
  pipes := (SELECT "database_name" AS d, "schema_name" AS s, "name" AS n
            FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
            WHERE COALESCE("is_snowflake_managed"::VARCHAR, 'false') = 'false');
  FOR p IN pipes DO
    EXECUTE IMMEDIATE 'GRANT MONITOR ON PIPE "' || p.d || '"."' || p.s || '"."' || p.n || '" TO ROLE ADE_APP_ROLE';
    granted := granted + 1;
  END FOR;

  SHOW ALERTS IN DATABASE <% db %>;
  alerts := (SELECT "database_name" AS d, "schema_name" AS s, "name" AS n
             FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
  FOR a IN alerts DO
    EXECUTE IMMEDIATE 'GRANT MONITOR ON ALERT "' || a.d || '"."' || a.s || '"."' || a.n || '" TO ROLE ADE_APP_ROLE';
    granted := granted + 1;
  END FOR;

  RETURN 'MONITOR granted on ' || granted || ' pipes/alerts';
END;
$$;

-- Register the scope (no-op if already registered).
USE ROLE ADE_OWNER_ROLE;
USE WAREHOUSE ADE_WH;
INSERT INTO ADE_DB.OPS.SCOPES (DATABASE_NAME, CREATED_BY)
SELECT UPPER('<% db %>'), 'SETUP'
WHERE NOT EXISTS (SELECT 1 FROM ADE_DB.OPS.SCOPES WHERE DATABASE_NAME = UPPER('<% db %>'));

-- Allow approved fixes to change this database (GUARD checks this list).
-- Leave it out, or set ACTIVE = FALSE, to keep a database monitor-only.
USE ROLE SYSADMIN;
MERGE INTO ADE_DB.GUARD.MANAGED_DATABASES t USING (SELECT UPPER('<% db %>') AS D) s ON t.DATABASE_NAME = s.D
  WHEN NOT MATCHED THEN INSERT (DATABASE_NAME) VALUES (s.D);

-- Verify: privileges ADE_APP_ROLE holds inside the database (expect only
-- USAGE / SELECT / MONITOR).
SHOW GRANTS TO ROLE ADE_APP_ROLE
  ->> SELECT "privilege", "granted_on", COUNT(*) AS objects
      FROM $1
      WHERE "name" ILIKE UPPER('<% db %>') || '%'
      GROUP BY 1, 2
      ORDER BY 2, 1;
