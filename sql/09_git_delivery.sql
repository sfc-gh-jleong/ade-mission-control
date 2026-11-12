/* =====================================================================
   09 — Git delivery: fixes reach ADE_DEMO_RETAIL as GitHub pull requests
   ---------------------------------------------------------------------
   For a database whose code lives in Git (GUARD.MANAGED_DATABASES.DELIVERY
   = 'PULL_REQUEST'), Mission Control does not apply fixes. After the
   Reviewer approves a rehearsed fix, it opens a pull request that changes
   the job's file; a person approves and merges on GitHub; GitHub Actions
   deploys and writes DEPLOY.CHANGE_HISTORY; Mission Control tracks the PR
   read-only and resolves the incident after the next successful run.

     GUARD.REPO_OBJECTS   which repo file defines each object, and whether ADE
                          may propose changes to it (SYSADMIN-owned: the agents
                          share the app's role and must not be able to point a
                          job at a different file)
     OPS.SOURCE_CHANGES   the file change for each fix version (sealed)
     OPS.PULL_REQUESTS    each pull request and deploy Mission Control tracks
     OPS.SETTINGS         delivery.github.* (off until the GitHub App is set up)
     GitHub egress        ADE_DB.SECRETS.GITHUB_APP_KEY (placeholder until the
                          App's private key is stored), network rule for
                          api.github.com:443, ADE_GITHUB_EAI

   ADE_GITHUB_EAI allows no secrets: the app container reads the key from its
   secret mount, which needs no integration, while a function or procedure
   created by the agents' role cannot bind the key through it (tested: binding
   fails with "Integrations do not allow secret"). The role also gets READ, not
   USAGE, on the secret, like SEAL_KEY (04_app_privileges.sql).

   The deploy user for the repo is created by 10_demo_repo_deploy_user.sql.

   Run after 06_guard.sql and 90_demo_pipeline.sql:
     snow sql -f sql/09_git_delivery.sql -c osm_deploy
   Store the App's key once it exists (the key never appears in a terminal):
     GITHUB_APP_KEY="<cortex secret key>" snow sql -c osm_deploy -i <<EOSQL
     USE ROLE ADE_OWNER_ROLE;
     ALTER SECRET ADE_DB.SECRETS.GITHUB_APP_KEY SET SECRET_STRING = '$GITHUB_APP_KEY';
     EOSQL
   Idempotent.
   ===================================================================== */

-- ---------------------------------------------------------------------
-- Repo object map (GUARD, SYSADMIN)
-- ---------------------------------------------------------------------
USE ROLE SYSADMIN;
USE WAREHOUSE ADE_WH;
USE SECONDARY ROLES NONE;

CREATE TABLE IF NOT EXISTS ADE_DB.GUARD.REPO_OBJECTS (
  DATABASE_NAME  VARCHAR(255)  NOT NULL,
  SCHEMA_NAME    VARCHAR(255)  NOT NULL,
  OBJECT_NAME    VARCHAR(255)  NOT NULL,
  OBJECT_TYPE    VARCHAR(20)   NOT NULL,     -- TABLE | DYNAMIC_TABLE | TASK
  REPO_PATH      VARCHAR(500)  NOT NULL,
  ADE_MAY_EDIT   BOOLEAN       NOT NULL DEFAULT FALSE,
  ADDED_BY       VARCHAR(255)  NOT NULL DEFAULT CURRENT_USER(),
  ADDED_AT       TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  CONSTRAINT PK_REPO_OBJECTS PRIMARY KEY (DATABASE_NAME, SCHEMA_NAME, OBJECT_NAME)
) COMMENT = 'Repo file that defines each object of a Git-managed database, and whether ADE may propose changes to it';

-- Tasks and the dynamic table: ADE may change their body. Tables: defined in
-- the repo (a missing one comes back with a deploy), never edited by ADE.
MERGE INTO ADE_DB.GUARD.REPO_OBJECTS t
USING (
  SELECT * FROM VALUES
    ('ADE_DEMO_RETAIL', 'ORCHESTRATION', 'CLEAN_ORDERS',        'TASK',          'objects/orchestration/clean_orders.sql',        TRUE),
    ('ADE_DEMO_RETAIL', 'ORCHESTRATION', 'BUILD_DAILY_REVENUE', 'TASK',          'objects/orchestration/build_daily_revenue.sql', TRUE),
    ('ADE_DEMO_RETAIL', 'ORCHESTRATION', 'PUBLISH_SNAPSHOT',    'TASK',          'objects/orchestration/publish_snapshot.sql',    TRUE),
    ('ADE_DEMO_RETAIL', 'MART',          'CUSTOMER_LTV',        'DYNAMIC_TABLE', 'objects/mart/customer_ltv.sql',                 TRUE),
    ('ADE_DEMO_RETAIL', 'STAGING',       'ORDERS_CLEAN',        'TABLE',         'objects/staging/orders_clean.sql',              FALSE),
    ('ADE_DEMO_RETAIL', 'MART',          'DAILY_REVENUE',       'TABLE',         'objects/mart/daily_revenue.sql',                FALSE),
    ('ADE_DEMO_RETAIL', 'MART',          'REVENUE_SNAPSHOTS',   'TABLE',         'objects/mart/revenue_snapshots.sql',            FALSE),
    ('ADE_DEMO_RETAIL', 'DEPLOY',        'CHANGE_HISTORY',      'TABLE',         'objects/deploy/change_history.sql',             FALSE)
    AS v (DATABASE_NAME, SCHEMA_NAME, OBJECT_NAME, OBJECT_TYPE, REPO_PATH, ADE_MAY_EDIT)
) s
ON t.DATABASE_NAME = s.DATABASE_NAME AND t.SCHEMA_NAME = s.SCHEMA_NAME AND t.OBJECT_NAME = s.OBJECT_NAME
WHEN MATCHED AND (t.OBJECT_TYPE <> s.OBJECT_TYPE OR t.REPO_PATH <> s.REPO_PATH OR t.ADE_MAY_EDIT <> s.ADE_MAY_EDIT) THEN
  UPDATE SET OBJECT_TYPE = s.OBJECT_TYPE, REPO_PATH = s.REPO_PATH, ADE_MAY_EDIT = s.ADE_MAY_EDIT
WHEN NOT MATCHED THEN
  INSERT (DATABASE_NAME, SCHEMA_NAME, OBJECT_NAME, OBJECT_TYPE, REPO_PATH, ADE_MAY_EDIT)
  VALUES (s.DATABASE_NAME, s.SCHEMA_NAME, s.OBJECT_NAME, s.OBJECT_TYPE, s.REPO_PATH, s.ADE_MAY_EDIT);

GRANT SELECT ON TABLE ADE_DB.GUARD.REPO_OBJECTS TO ROLE ADE_APP_ROLE;
GRANT SELECT ON TABLE ADE_DB.GUARD.REPO_OBJECTS TO ROLE ADE_OPERATOR_ROLE;

-- ---------------------------------------------------------------------
-- Pull request state (OPS, ADE_OWNER_ROLE)
-- ---------------------------------------------------------------------
USE ROLE ADE_OWNER_ROLE;
USE WAREHOUSE ADE_WH;
USE SCHEMA ADE_DB.OPS;

-- The file change for one fix version. Written by the app after the fix is
-- stored and before the Reviewer runs; the Reviewer reviews DIFF. SEAL covers
-- the fields that pin what is pushed (lib/server/seal.ts sourceSealParts).
CREATE HYBRID TABLE IF NOT EXISTS SOURCE_CHANGES (
  FIX_ID            VARCHAR(64)   NOT NULL,
  INCIDENT_ID       VARCHAR(64)   NOT NULL,
  REPO              VARCHAR(200)  NOT NULL,          -- owner/name
  BASE_BRANCH       VARCHAR(255)  NOT NULL,
  BASE_COMMIT_SHA   VARCHAR(40)   NOT NULL,          -- head of the base branch when the fix was written
  PATH              VARCHAR(500)  NOT NULL,
  OBJECT_TYPE       VARCHAR(20)   NOT NULL,          -- TASK | DYNAMIC_TABLE
  BASE_BLOB_SHA     VARCHAR(40)   NOT NULL,          -- git blob SHA of the file at BASE_COMMIT_SHA
  NEW_BLOB_SHA      VARCHAR(40)   NOT NULL,          -- git blob SHA of the file after the change
  BASE_CONTENT      VARCHAR(16777216) NOT NULL,
  NEW_CONTENT       VARCHAR(16777216) NOT NULL,
  DIFF              VARCHAR(16777216),
  PATCH_HASH        VARCHAR(64)   NOT NULL,          -- SHA-256 of path + base blob + new blob
  SEAL              VARCHAR(64),
  CREATED_AT        TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  CONSTRAINT PK_SOURCE_CHANGES PRIMARY KEY (FIX_ID),
  CONSTRAINT FK_SRC_FIX FOREIGN KEY (FIX_ID) REFERENCES FIXES (FIX_ID),
  CONSTRAINT FK_SRC_INC FOREIGN KEY (INCIDENT_ID) REFERENCES INCIDENTS (INCIDENT_ID),
  INDEX IX_SRC_INC (INCIDENT_ID)
)
COMMENT = 'File change in the Git repo for each fix version of a Git-managed database';

-- One row per pull request (or, for a fix that only needs main to be
-- deployed, per deploy request). Mission Control writes the PR it opens and
-- mirrors what it reads from GitHub and DEPLOY.CHANGE_HISTORY; decisions are
-- always re-read from those sources, never from this cache.
--   STATE: PENDING (not opened yet) | OPEN | MERGED | DEPLOYED | CLOSED
--          | DEPLOY_NEEDED (no PR: main already defines the fix; waiting for a deploy)
--          | CANCELLED (a newer fix version replaced it before it opened)
CREATE HYBRID TABLE IF NOT EXISTS PULL_REQUESTS (
  PR_ID             VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  FIX_ID            VARCHAR(64)   NOT NULL,
  INCIDENT_ID       VARCHAR(64)   NOT NULL,
  REPO              VARCHAR(200)  NOT NULL,
  BASE_BRANCH       VARCHAR(255)  NOT NULL,
  BRANCH            VARCHAR(255),                    -- ade/ADE-1004-v1 (NULL for DEPLOY_NEEDED)
  PATH              VARCHAR(500),
  STATE             VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
  PR_NUMBER         NUMBER(38,0),
  PR_URL            VARCHAR(500),
  HEAD_SHA          VARCHAR(40),                     -- the commit Mission Control pushed
  CURRENT_HEAD_SHA  VARCHAR(40),                     -- latest head seen on GitHub
  APPROVALS         NUMBER(10,0)  NOT NULL DEFAULT 0,
  APPROVED_BY       ARRAY,
  CHANGES_REQUESTED BOOLEAN       NOT NULL DEFAULT FALSE,
  MERGED_BY         VARCHAR(100),
  MERGED_AT         TIMESTAMP_NTZ,
  MERGE_COMMIT_SHA  VARCHAR(40),
  CLOSED_AT         TIMESTAMP_NTZ,
  DEPLOY_ID         VARCHAR(36),
  DEPLOY_COMMIT_SHA VARCHAR(40),
  DEPLOYED_AT       TIMESTAMP_NTZ,
  DEPLOY_RUN_URL    VARCHAR(500),
  PIPELINE_STATUS   VARCHAR(20),
  REVIEW_DRIFT      VARCHAR(30),                     -- NULL | CHANGED_AFTER_REVIEW | PRODUCTION_DIFFERS
  LAST_ERROR        VARCHAR(4000),
  LAST_SYNCED_AT    TIMESTAMP_NTZ,
  CREATED_AT        TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  UPDATED_AT        TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE(),
  CONSTRAINT PK_PULL_REQUESTS PRIMARY KEY (PR_ID),
  CONSTRAINT UQ_PR_FIX UNIQUE (FIX_ID),
  CONSTRAINT FK_PR_FIX FOREIGN KEY (FIX_ID) REFERENCES FIXES (FIX_ID),
  CONSTRAINT FK_PR_INC FOREIGN KEY (INCIDENT_ID) REFERENCES INCIDENTS (INCIDENT_ID),
  INDEX IX_PR_STATE (STATE, UPDATED_AT),
  INDEX IX_PR_INC (INCIDENT_ID)
)
COMMENT = 'Pull requests and deploys that carry fixes to Git-managed databases';

GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.SOURCE_CHANGES TO ROLE ADE_APP_ROLE;
GRANT SELECT, INSERT, UPDATE ON TABLE ADE_DB.OPS.PULL_REQUESTS  TO ROLE ADE_APP_ROLE;

INSERT INTO SETTINGS (SETTING_KEY, SETTING_VALUE, DESCRIPTION, UPDATED_BY)
SELECT s.k, PARSE_JSON(s.v), s.d, 'SETUP'
FROM (
  SELECT 'delivery.github.enabled'                AS k, 'false' AS v, 'Kill switch: when false Mission Control opens no pull requests (it still tracks open ones)' AS d UNION ALL
  SELECT 'delivery.github.app_id',                       'null',       'GitHub App ID that opens the pull requests' UNION ALL
  SELECT 'delivery.github.installation_id',              'null',       'Installation ID of the GitHub App on the repository' UNION ALL
  SELECT 'delivery.github.base_branch',                  '"main"',     'Branch the pull requests target' UNION ALL
  SELECT 'delivery.github.poll_seconds',                 '60',         'How often open pull requests and deploys are checked' UNION ALL
  SELECT 'delivery.github.deploy_timeout_minutes',       '30',         'Minutes after a merge before a missing deploy needs a person'
) s
WHERE NOT EXISTS (SELECT 1 FROM SETTINGS t WHERE t.SETTING_KEY = s.k);

-- ---------------------------------------------------------------------
-- GitHub egress
-- ---------------------------------------------------------------------
CREATE NETWORK RULE IF NOT EXISTS ADE_DB.CORE.GITHUB_API_EGRESS
  MODE = EGRESS
  TYPE = HOST_PORT
  VALUE_LIST = ('api.github.com:443')
  COMMENT = 'GitHub REST API, for opening and tracking pull requests';

-- Placeholder until the GitHub App's private key is stored (see header).
CREATE SECRET IF NOT EXISTS ADE_DB.SECRETS.GITHUB_APP_KEY
  TYPE = GENERIC_STRING
  SECRET_STRING = 'not-configured'
  COMMENT = 'GitHub App private key (PEM) that opens pull requests (app container only)';
GRANT READ ON SECRET ADE_DB.SECRETS.GITHUB_APP_KEY TO ROLE ADE_APP_ROLE;

USE ROLE ACCOUNTADMIN;
CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS ADE_GITHUB_EAI
  ALLOWED_NETWORK_RULES = (ADE_DB.CORE.GITHUB_API_EGRESS)
  ALLOWED_AUTHENTICATION_SECRETS = NONE
  ENABLED = TRUE
  COMMENT = 'ADE Mission Control -> api.github.com (pull requests). Allows no secrets; the app reads its key from a secret mount';
GRANT USAGE ON INTEGRATION ADE_GITHUB_EAI TO ROLE ADE_APP_ROLE;

-- ---------------------------------------------------------------------
-- Switch ADE_DEMO_RETAIL to pull-request delivery
-- ---------------------------------------------------------------------
USE ROLE SYSADMIN;
UPDATE ADE_DB.GUARD.MANAGED_DATABASES
   SET DELIVERY = 'PULL_REQUEST', REPO = 'sfc-gh-jleong/ade-demo-retail'
 WHERE DATABASE_NAME = 'ADE_DEMO_RETAIL';

-- Fixes still waiting for approval or apply through GUARD can no longer be
-- applied (GUARD refuses them), so they are retired and their incidents go to
-- a person, who can queue them again to get a pull request.
USE ROLE ADE_OWNER_ROLE;
INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, FIX_ID, ACTOR, ACTION, DETAIL)
SELECT f.INCIDENT_ID, f.FIX_ID, 'SETUP', 'SUPERSEDED',
       OBJECT_CONSTRUCT('reason', 'database moved to pull-request delivery', 'previous_status', f.STATUS)
FROM ADE_DB.OPS.FIXES f JOIN ADE_DB.OPS.INCIDENTS i ON i.INCIDENT_ID = f.INCIDENT_ID
WHERE i.DATABASE_NAME = 'ADE_DEMO_RETAIL' AND f.STATUS IN ('AWAITING_APPROVAL', 'APPROVED');

UPDATE ADE_DB.OPS.INCIDENTS
   SET STATUS = 'NEEDS_HUMAN',
       STATUS_DETAIL = 'This database is now managed in Git, so the pending fix was retired. Queue the incident again to get a pull request.',
       UPDATED_AT = SYSDATE()
 WHERE DATABASE_NAME = 'ADE_DEMO_RETAIL' AND STATUS IN ('AWAITING_APPROVAL', 'APPROVED');

UPDATE ADE_DB.OPS.FIXES
   SET STATUS = 'SUPERSEDED', UPDATED_AT = SYSDATE()
 WHERE STATUS IN ('AWAITING_APPROVAL', 'APPROVED')
   AND INCIDENT_ID IN (SELECT INCIDENT_ID FROM ADE_DB.OPS.INCIDENTS WHERE DATABASE_NAME = 'ADE_DEMO_RETAIL');

-- Verify
USE ROLE SYSADMIN;
SELECT DATABASE_NAME, ACTIVE, DELIVERY, REPO FROM ADE_DB.GUARD.MANAGED_DATABASES ORDER BY 1;
SELECT SCHEMA_NAME || '.' || OBJECT_NAME AS OBJ, OBJECT_TYPE, REPO_PATH, ADE_MAY_EDIT FROM ADE_DB.GUARD.REPO_OBJECTS ORDER BY 1;
