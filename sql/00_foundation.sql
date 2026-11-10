/* =====================================================================
   00 — Foundation: roles, warehouse, databases, schemas
   ---------------------------------------------------------------------
   ADE (Autonomous Data Engineer) Mission Control.

   Roles (SYSADMIN > ADE_OWNER_ROLE > ADE_APP_ROLE):
   - ADE_APP_ROLE   the App Runtime service identity. The three Cortex Code
                    agents run as it inside Snowflake's managed sandbox, whose
                    SQL tool executes whatever the role allows. So it gets:
                      read-only on monitored databases (03_scope_grants.sql),
                      SELECT/INSERT/UPDATE on ADE state (no DDL, no DELETE,
                      INSERT-only audit log), ownership of ADE_SANDBOX (where
                      rehearsals run) and of the APP/AGENTS schemas.
                    The role that deploys an APPLICATION SERVICE becomes its
                    execution role and cannot be changed afterwards.
   - ADE_OWNER_ROLE owns ADE_DB and the OPS/TELEMETRY/CORE objects and runs the
                    detector task. Inherits ADE_APP_ROLE's read grants. Never
                    used by the app or the agents.
   - SYSADMIN       owns the monitored jobs, so it owns ADE_DB.GUARD (the only
                    production change path: APPLY_FIX / ROLLBACK_FIX, called
                    with the approving human's caller's rights) and
                    ADE_DB.CHAOS (demo failure scenarios).

   Run as a user holding ACCOUNTADMIN:
     snow sql -f sql/00_foundation.sql -c osm_deploy
   Idempotent; also migrates an install where ADE_APP_ROLE owned ADE_DB.
   ===================================================================== */

-- ---------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------
USE ROLE SECURITYADMIN;
CREATE ROLE IF NOT EXISTS ADE_APP_ROLE
  COMMENT = 'ADE Mission Control service identity (app + agents). Read-only on monitored databases; DML-only on ADE state.';
CREATE ROLE IF NOT EXISTS ADE_OWNER_ROLE
  COMMENT = 'ADE Mission Control: owns ADE_DB state and the detector. Not used by the app or the agents.';
GRANT ROLE ADE_APP_ROLE TO ROLE ADE_OWNER_ROLE;
GRANT ROLE ADE_OWNER_ROLE TO ROLE SYSADMIN;
GRANT ROLE ADE_APP_ROLE TO USER JLEONG;
GRANT ROLE ADE_OWNER_ROLE TO USER JLEONG;

-- ---------------------------------------------------------------------
-- Warehouse + databases
-- ---------------------------------------------------------------------
USE ROLE SYSADMIN;
CREATE WAREHOUSE IF NOT EXISTS ADE_WH
  WAREHOUSE_SIZE = XSMALL
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = 'ADE Mission Control: app queries and sandbox rehearsals';
GRANT USAGE, MONITOR ON WAREHOUSE ADE_WH TO ROLE ADE_APP_ROLE;

CREATE DATABASE IF NOT EXISTS ADE_DB
  COMMENT = 'ADE Mission Control: operational state (hybrid tables), telemetry, agents, app';
-- Rehearsal sandbox: one database of zero-copy clones per incident run is
-- created here as schemas. Disposable, so no Time Travel.
CREATE DATABASE IF NOT EXISTS ADE_SANDBOX
  DATA_RETENTION_TIME_IN_DAYS = 0
  COMMENT = 'ADE Mission Control: per-incident rehearsal schemas (zero-copy clones). Safe to empty.';

USE ROLE SECURITYADMIN;
GRANT OWNERSHIP ON DATABASE ADE_DB TO ROLE ADE_OWNER_ROLE COPY CURRENT GRANTS;
GRANT OWNERSHIP ON DATABASE ADE_SANDBOX TO ROLE ADE_APP_ROLE COPY CURRENT GRANTS;
GRANT USAGE ON DATABASE ADE_DB TO ROLE ADE_APP_ROLE;

-- ---------------------------------------------------------------------
-- Account-level privileges (to ADE_APP_ROLE; ADE_OWNER_ROLE inherits them)
-- ---------------------------------------------------------------------
USE ROLE ACCOUNTADMIN;
-- Task / alert / DT history for jobs the role does not own
GRANT MONITOR EXECUTION ON ACCOUNT TO ROLE ADE_APP_ROLE;
-- Detector + reconciliation are serverless tasks; rehearsals run sandbox tasks
GRANT EXECUTE TASK ON ACCOUNT TO ROLE ADE_APP_ROLE;
GRANT EXECUTE MANAGED TASK ON ACCOUNT TO ROLE ADE_APP_ROLE;
-- ACCOUNT_USAGE: TASK_HISTORY backfill, DT refresh + copy history and
-- CORTEX_AGENT_USAGE_HISTORY (USAGE_VIEWER); object dependencies (OBJECT_VIEWER)
GRANT DATABASE ROLE SNOWFLAKE.USAGE_VIEWER  TO ROLE ADE_APP_ROLE;
GRANT DATABASE ROLE SNOWFLAKE.OBJECT_VIEWER TO ROLE ADE_APP_ROLE;
-- Cortex Agents API (managed coding agent). Explicit so the app keeps working
-- if an admin revokes CORTEX_USER from PUBLIC.
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_AGENT_USER TO ROLE ADE_APP_ROLE;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER       TO ROLE ADE_APP_ROLE;
-- Build-time npm egress (npm ci runs inside Snowflake during the image build)
GRANT USAGE ON INTEGRATION GHA_APP_NPM_EAI TO ROLE ADE_APP_ROLE;
-- Rehearsals create one disposable database per attempt (ADE_SBX_<incident>_<n>),
-- owned by ADE_APP_ROLE, and drop it afterwards. Databases rather than schemas
-- because job SQL hard-codes the database name, which rehearsal rewrites to
-- the sandbox name.
GRANT CREATE DATABASE ON ACCOUNT TO ROLE ADE_APP_ROLE;

-- ---------------------------------------------------------------------
-- State schemas: owned by ADE_OWNER_ROLE
-- ---------------------------------------------------------------------
USE ROLE ADE_OWNER_ROLE;
USE WAREHOUSE ADE_WH;
CREATE SCHEMA IF NOT EXISTS ADE_DB.OPS
  COMMENT = 'Hybrid tables: live incident state, agent runs and per-step telemetry';
CREATE SCHEMA IF NOT EXISTS ADE_DB.TELEMETRY
  COMMENT = 'Standard tables + views: bulky step payloads and analytics';
CREATE SCHEMA IF NOT EXISTS ADE_DB.CORE
  COMMENT = 'Detector and usage-reconciliation procedures and tasks';
-- Created by the owner, handed to the app below.
CREATE SCHEMA IF NOT EXISTS ADE_DB.AGENTS
  COMMENT = 'Cortex Agent objects: ADE_INVESTIGATOR, ADE_FIXER, ADE_REVIEWER (managed by the app via the Cortex Agent SDK)';
CREATE SCHEMA IF NOT EXISTS ADE_DB.APP
  COMMENT = 'App Runtime application service, artifact repository and code stage';

USE ROLE SECURITYADMIN;
-- Migrate state schemas (and everything in them) to the owner role.
GRANT OWNERSHIP ON SCHEMA ADE_DB.OPS       TO ROLE ADE_OWNER_ROLE COPY CURRENT GRANTS;
GRANT OWNERSHIP ON SCHEMA ADE_DB.TELEMETRY TO ROLE ADE_OWNER_ROLE COPY CURRENT GRANTS;
GRANT OWNERSHIP ON SCHEMA ADE_DB.CORE      TO ROLE ADE_OWNER_ROLE COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ALL TABLES    IN SCHEMA ADE_DB.OPS       TO ROLE ADE_OWNER_ROLE COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ALL SEQUENCES IN SCHEMA ADE_DB.OPS       TO ROLE ADE_OWNER_ROLE COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ALL TABLES    IN SCHEMA ADE_DB.TELEMETRY TO ROLE ADE_OWNER_ROLE COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ALL VIEWS     IN SCHEMA ADE_DB.TELEMETRY TO ROLE ADE_OWNER_ROLE COPY CURRENT GRANTS;
-- The app deploys the service into APP and manages the agent objects in AGENTS.
GRANT OWNERSHIP ON SCHEMA ADE_DB.APP    TO ROLE ADE_APP_ROLE COPY CURRENT GRANTS;
GRANT OWNERSHIP ON SCHEMA ADE_DB.AGENTS TO ROLE ADE_APP_ROLE COPY CURRENT GRANTS;

USE ROLE ADE_OWNER_ROLE;
GRANT USAGE ON SCHEMA ADE_DB.OPS       TO ROLE ADE_APP_ROLE;
GRANT USAGE ON SCHEMA ADE_DB.TELEMETRY TO ROLE ADE_APP_ROLE;
GRANT USAGE ON SCHEMA ADE_DB.CORE      TO ROLE ADE_APP_ROLE;

-- ---------------------------------------------------------------------
-- GUARD schema: owned by the job-owner role (SYSADMIN), not by the app.
-- ADE_APP_ROLE gets USAGE on the schema and, in 05_guard.sql, USAGE on the
-- guarded procedures only. It cannot create or replace anything here.
-- ---------------------------------------------------------------------
USE ROLE SYSADMIN;
CREATE SCHEMA IF NOT EXISTS ADE_DB.GUARD
  COMMENT = 'Guarded production change path: approvals, APPLY_FIX / ROLLBACK_FIX (owned by the job-owner role)';
GRANT USAGE ON SCHEMA ADE_DB.GUARD TO ROLE ADE_APP_ROLE;

-- ---------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------
SHOW SCHEMAS IN DATABASE ADE_DB ->> SELECT "name", "owner" FROM $1 ORDER BY 1;
