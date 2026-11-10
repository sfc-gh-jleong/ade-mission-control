/* =====================================================================
   99 — Teardown: remove everything ADE Mission Control created
   ---------------------------------------------------------------------
   Destructive. Drops the app, the agents, all ADE state and the demo
   pipeline. Review before running:
     snow sql -f sql/99_teardown.sql -c osm_deploy
   Monitored databases (e.g. SNOWFLAKE_DEMO) are not touched beyond
   revoking ADE_APP_ROLE's read-only grants (dropping the role does that).
   ===================================================================== */
USE ROLE ACCOUNTADMIN;

-- Stop background work first.
ALTER TASK IF EXISTS ADE_DB.CORE.DETECTOR_TASK SUSPEND;
ALTER TASK IF EXISTS ADE_DB.CORE.RECONCILE_USAGE_TASK SUSPEND;
DROP APPLICATION SERVICE IF EXISTS ADE_DB.APP.ADE_MISSION_CONTROL;

-- Leftover rehearsal sandboxes (ADE_SBX_<incident>_<attempt>) are dropped by
-- the app after each rehearsal; drop any stragglers by name if listed here:
SHOW DATABASES LIKE 'ADE\\_SBX\\_%';

DROP DATABASE IF EXISTS ADE_DEMO_RETAIL;
DROP DATABASE IF EXISTS ADE_SANDBOX;
DROP DATABASE IF EXISTS ADE_DB;
DROP WAREHOUSE IF EXISTS ADE_WH;

DROP USER IF EXISTS GHA_ADE_APP_SVC;
DROP ROLE IF EXISTS ADE_OPERATOR_ROLE;
DROP ROLE IF EXISTS ADE_OWNER_ROLE;
DROP ROLE IF EXISTS ADE_APP_ROLE;
