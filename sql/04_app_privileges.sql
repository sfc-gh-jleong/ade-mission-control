/* =====================================================================
   04 — ADE state privileges for the app identity and human operators
   ---------------------------------------------------------------------
   ADE_APP_ROLE is both the app's service identity and the identity the three
   Cortex Code agents run as, and the managed sandbox's SQL tool executes any
   statement the role allows. So the app gets DML on pipeline state only:

     OPS pipeline tables   SELECT, INSERT, UPDATE  (no DELETE / TRUNCATE / DDL)
     OPS.AUDIT_LOG         SELECT, INSERT          (append-only)
     OPS.SETTINGS          SELECT                  (humans change settings)
     TELEMETRY tables      SELECT, INSERT, UPDATE
     TELEMETRY views       SELECT

   Humans act through the app with caller's rights (their own identity):
     ADE_OPERATOR_ROLE     UPDATE on OPS.SETTINGS; USAGE on the GUARD
                           procedures (granted in 05_guard.sql).
   For a caller's-rights session to use those privileges, the app's execution
   role also needs the matching CALLER grants (ACCOUNTADMIN, below).

   Run after 01_ops_tables.sql and 02_telemetry.sql:
     snow sql -f sql/04_app_privileges.sql -c osm_deploy
   Idempotent.
   ===================================================================== */
USE ROLE SECURITYADMIN;
CREATE ROLE IF NOT EXISTS ADE_OPERATOR_ROLE
  COMMENT = 'ADE Mission Control operators: change settings, approve, apply and roll back fixes (through the app, with caller''s rights)';
GRANT ROLE ADE_OPERATOR_ROLE TO ROLE SYSADMIN;
GRANT ROLE ADE_OPERATOR_ROLE TO USER JLEONG;

USE ROLE ADE_OWNER_ROLE;

-- Pipeline state
GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.SCOPES      TO ROLE ADE_APP_ROLE;
GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.JOBS        TO ROLE ADE_APP_ROLE;
GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.JOB_RUNS    TO ROLE ADE_APP_ROLE;
GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.INCIDENTS   TO ROLE ADE_APP_ROLE;
GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.AGENT_RUNS  TO ROLE ADE_APP_ROLE;
GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.AGENT_STEPS TO ROLE ADE_APP_ROLE;
GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.DIAGNOSES   TO ROLE ADE_APP_ROLE;
GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.FIXES       TO ROLE ADE_APP_ROLE;
GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.REHEARSALS  TO ROLE ADE_APP_ROLE;
GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.REVIEWS     TO ROLE ADE_APP_ROLE;
GRANT SELECT, INSERT         ON TABLE ADE_DB.OPS.AUDIT_LOG   TO ROLE ADE_APP_ROLE;
GRANT SELECT                 ON TABLE ADE_DB.OPS.SETTINGS    TO ROLE ADE_APP_ROLE;
GRANT USAGE ON SEQUENCE ADE_DB.OPS.INCIDENT_NUMBER_SEQ       TO ROLE ADE_APP_ROLE;

-- Settings are changed by people, not by the app identity the agents share.
GRANT USAGE ON DATABASE ADE_DB TO ROLE ADE_OPERATOR_ROLE;
GRANT USAGE ON SCHEMA ADE_DB.OPS TO ROLE ADE_OPERATOR_ROLE;
GRANT SELECT, UPDATE ON TABLE ADE_DB.OPS.SETTINGS TO ROLE ADE_OPERATOR_ROLE;
GRANT SELECT, INSERT ON TABLE ADE_DB.OPS.AUDIT_LOG TO ROLE ADE_OPERATOR_ROLE;

-- Telemetry
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ADE_DB.TELEMETRY TO ROLE ADE_APP_ROLE;
GRANT SELECT ON ALL VIEWS IN SCHEMA ADE_DB.TELEMETRY TO ROLE ADE_APP_ROLE;

-- HMAC key that seals fixes and reviews (lib/server/seal.ts). Random, generated
-- in Snowflake, mounted into the app container through app.yml `secrets:`.
-- READ (not USAGE) lets App Runtime mount it without letting the role build a
-- UDF that reveals it.
USE WAREHOUSE ADE_WH;
CREATE SCHEMA IF NOT EXISTS ADE_DB.SECRETS COMMENT = 'Secrets mounted into the Mission Control container only';
EXECUTE IMMEDIATE $$
DECLARE
  k VARCHAR DEFAULT (SELECT SHA2(UUID_STRING() || UUID_STRING() || RANDSTR(64, RANDOM()) || TO_VARCHAR(SYSDATE()), 256));
BEGIN
  EXECUTE IMMEDIATE 'CREATE SECRET IF NOT EXISTS ADE_DB.SECRETS.SEAL_KEY TYPE = GENERIC_STRING SECRET_STRING = ''' || k || ''' COMMENT = ''HMAC key that seals fixes and reviews (app container only)''';
  RETURN 'ok';
END;
$$;
GRANT USAGE ON SCHEMA ADE_DB.SECRETS TO ROLE ADE_APP_ROLE;
GRANT READ ON SECRET ADE_DB.SECRETS.SEAL_KEY TO ROLE ADE_APP_ROLE;

-- Caller grants: what the app's caller's-rights sessions may do on the signed-in
-- user's behalf (the user must also hold the privilege themselves).
USE ROLE ACCOUNTADMIN;
GRANT CALLER USAGE ON DATABASE ADE_DB TO ROLE ADE_APP_ROLE;
GRANT CALLER USAGE ON SCHEMA ADE_DB.OPS TO ROLE ADE_APP_ROLE;
GRANT CALLER USAGE ON SCHEMA ADE_DB.GUARD TO ROLE ADE_APP_ROLE;
GRANT CALLER SELECT, UPDATE ON TABLE ADE_DB.OPS.SETTINGS TO ROLE ADE_APP_ROLE;
GRANT CALLER SELECT, INSERT ON TABLE ADE_DB.OPS.AUDIT_LOG TO ROLE ADE_APP_ROLE;
GRANT CALLER USAGE ON WAREHOUSE ADE_WH TO ROLE ADE_APP_ROLE;
GRANT USAGE ON WAREHOUSE ADE_WH TO ROLE ADE_OPERATOR_ROLE;

-- Verify
SHOW GRANTS TO ROLE ADE_APP_ROLE
  ->> SELECT "privilege", "granted_on", "name" FROM $1
      WHERE "name" LIKE 'ADE_DB.%' ORDER BY "name", "privilege";
SHOW CALLER GRANTS TO ROLE ADE_APP_ROLE;
