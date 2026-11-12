/* =====================================================================
   06 — GUARD: the only path from an agent's fix to production
   ---------------------------------------------------------------------
   Owned by SYSADMIN (the role that owns the monitored jobs). The app calls
   these procedures through caller's-rights sessions, i.e. as the signed-in
   human. Inside an owner's-rights procedure CURRENT_USER() is the calling
   user, so the approver check cannot be satisfied by the app's service
   identity, nor by an agent (agents run as that identity).

   Threat model: anything ADE_APP_ROLE can write (OPS tables) may have been
   altered by a prompt-injected agent. So the guard trusts only:
     - its own SYSADMIN-owned tables (APPROVERS, MANAGED_DATABASES, DECISIONS);
     - a hash it recomputes itself, FIX_HASH(database, statements, rollback),
       which pins exactly what the human saw and approved;
     - its own statement screen.

     APPROVERS          users who may approve/apply/roll back
     MANAGED_DATABASES  databases fixes may change (03_scope_grants.sql adds),
                        and how fixes reach them (DELIVERY):
                          APPLY         a person approves and applies here
                          PULL_REQUEST  the code lives in Git (REPO); fixes reach
                                        production only through a reviewed pull
                                        request, so approve/apply/roll back refuse
                                        (09_git_delivery.sql)
     DECISIONS          append-only record of every human decision
     FIX_HASH()         canonical hash of a fix (also used by the app)
     SCREEN_STATEMENT() server-side statement screen
     APPROVE_FIX / REJECT_FIX / APPLY_FIX / ROLLBACK_FIX / RUN_JOB

   Run as a user holding SYSADMIN + ACCOUNTADMIN:
     snow sql -f sql/06_guard.sql -c osm_deploy
   ===================================================================== */
USE ROLE SYSADMIN;
USE WAREHOUSE ADE_WH;
USE SECONDARY ROLES NONE;

CREATE TABLE IF NOT EXISTS ADE_DB.GUARD.APPROVERS (
  USER_NAME   VARCHAR(255) NOT NULL,
  ACTIVE      BOOLEAN      NOT NULL DEFAULT TRUE,
  ADDED_BY    VARCHAR(255) NOT NULL DEFAULT CURRENT_USER(),
  ADDED_AT    TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE()
) COMMENT = 'Users allowed to approve, apply and roll back ADE fixes';

MERGE INTO ADE_DB.GUARD.APPROVERS t USING (SELECT 'JLEONG' AS U) s ON t.USER_NAME = s.U
  WHEN NOT MATCHED THEN INSERT (USER_NAME) VALUES (s.U);

CREATE TABLE IF NOT EXISTS ADE_DB.GUARD.MANAGED_DATABASES (
  DATABASE_NAME VARCHAR(255) NOT NULL,
  ACTIVE        BOOLEAN      NOT NULL DEFAULT TRUE,
  ADDED_BY      VARCHAR(255) NOT NULL DEFAULT CURRENT_USER(),
  ADDED_AT      TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE()
) COMMENT = 'Databases ADE fixes may change (maintained by sql/03_scope_grants.sql)';

ALTER TABLE ADE_DB.GUARD.MANAGED_DATABASES ADD COLUMN IF NOT EXISTS
  DELIVERY VARCHAR(20) DEFAULT 'APPLY' COMMENT 'APPLY: GUARD applies approved fixes. PULL_REQUEST: fixes reach production only through a reviewed pull request to REPO';
ALTER TABLE ADE_DB.GUARD.MANAGED_DATABASES ADD COLUMN IF NOT EXISTS
  REPO VARCHAR(200) COMMENT 'GitHub repository (owner/name) holding the code when DELIVERY = PULL_REQUEST';
UPDATE ADE_DB.GUARD.MANAGED_DATABASES SET DELIVERY = 'APPLY' WHERE DELIVERY IS NULL;

MERGE INTO ADE_DB.GUARD.MANAGED_DATABASES t
  USING (SELECT 'SNOWFLAKE_DEMO' AS D UNION ALL SELECT 'ADE_DEMO_RETAIL') s ON t.DATABASE_NAME = s.D
  WHEN NOT MATCHED THEN INSERT (DATABASE_NAME) VALUES (s.D);

CREATE TABLE IF NOT EXISTS ADE_DB.GUARD.DECISIONS (
  DECISION_ID     VARCHAR(64)   NOT NULL DEFAULT UUID_STRING(),
  FIX_ID          VARCHAR(64)   NOT NULL,
  INCIDENT_ID     VARCHAR(64)   NOT NULL,
  DECISION        VARCHAR(20)   NOT NULL,     -- APPROVED | REJECTED | APPLIED | APPLY_FAILED | ROLLED_BACK | ROLLBACK_FAILED | RUN_REQUESTED
  FIX_HASH        VARCHAR(64),
  DATABASE_NAME   VARCHAR(255),
  DECIDED_BY      VARCHAR(255)  NOT NULL,
  COMMENT         VARCHAR(4000),
  DETAIL          VARIANT,
  DECIDED_AT      TIMESTAMP_NTZ NOT NULL DEFAULT SYSDATE()
) COMMENT = 'Append-only record of human decisions on ADE fixes (written only by GUARD procedures)';

-- Canonical fix hash: database + statements + rollback statements.
CREATE OR REPLACE FUNCTION ADE_DB.GUARD.FIX_HASH(DATABASE_NAME VARCHAR, STATEMENTS ARRAY, ROLLBACK_STATEMENTS ARRAY)
RETURNS VARCHAR
COMMENT = 'Canonical SHA-256 of a fix: target database, statements and rollback statements'
AS
$$
  SHA2(UPPER(COALESCE(DATABASE_NAME, '')) || '\n' || TO_JSON(COALESCE(STATEMENTS, ARRAY_CONSTRUCT()))
       || '\n' || TO_JSON(COALESCE(ROLLBACK_STATEMENTS, ARRAY_CONSTRUCT())), 256)
$$;

-- Server-side statement screen (mirrors lib/server/agents/sql-guard.ts).
-- NULL when the parameterized statement is acceptable, else the reason.
CREATE OR REPLACE FUNCTION ADE_DB.GUARD.SCREEN_STATEMENT(STMT VARCHAR)
RETURNS VARCHAR
COMMENT = 'NULL if a parameterized fix statement is acceptable, else the reason it is not'
AS
$$
  CASE
    WHEN STMT IS NULL OR TRIM(STMT) = '' THEN 'empty statement'
    WHEN REGEXP_LIKE(STMT, '.*(--|/\\*).*', 's') THEN 'comments are not allowed'
    WHEN REGEXP_LIKE(TRIM(STMT), '.*;\\s*$', 's') THEN 'trailing semicolon'
    WHEN REGEXP_LIKE(REGEXP_REPLACE(STMT, '''([^'']|'''')*''', ''''''), '.*;\\s*\\S.*', 's') THEN 'multiple statements'
    WHEN NOT REGEXP_LIKE(TRIM(STMT),
      '^(CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?|CREATE\\s+(OR\\s+REPLACE\\s+)?(SECURE\\s+)?VIEW\\s+|CREATE\\s+(OR\\s+REPLACE\\s+)?(TRANSIENT\\s+)?DYNAMIC\\s+TABLE\\s+|CREATE\\s+(OR\\s+REPLACE\\s+)?TASK\\s+|ALTER\\s+(TABLE|VIEW|TASK|DYNAMIC\\s+TABLE)\\s+(IF\\s+EXISTS\\s+)?|INSERT\\s+INTO\\s+|UPDATE\\s+|DELETE\\s+FROM\\s+|MERGE\\s+INTO\\s+)\\{\\{DB\\}\\}\\.[A-Za-z_"][^.\\s]*\\.[A-Za-z_"].*', 'is')
      THEN 'statement type not allowed, or its target is not {{DB}}.<schema>.<object>'
    WHEN REGEXP_LIKE(TRIM(STMT), '^CREATE\\s+OR\\s+REPLACE\\s+(TRANSIENT\\s+)?TABLE\\b.*', 'is') THEN 'CREATE OR REPLACE TABLE destroys data'
    WHEN REGEXP_LIKE(REGEXP_REPLACE(STMT, '''([^'']|'''')*''', ''''''),
      '.*\\b(DROP\\s+(TABLE|SCHEMA|DATABASE|VIEW|TASK|STAGE|PIPE|STREAM|DYNAMIC)|DROP\\s+COLUMN|TRUNCATE|GRANT|REVOKE|SWAP\\s+WITH|EXECUTE\\s+(IMMEDIATE|TASK|AS)|CALL|USE\\s+(ROLE|SECONDARY|WAREHOUSE|DATABASE|SCHEMA)|ALTER\\s+(SESSION|ACCOUNT|USER|WAREHOUSE)|COPY\\s+INTO|INSERT\\s+OVERWRITE)\\b.*', 'is')
      THEN 'forbidden keyword'
    WHEN REGEXP_LIKE(STMT, '.*SYSTEM\\$.*', 'is') THEN 'system functions are not allowed'
    WHEN REGEXP_LIKE(REGEXP_REPLACE(STMT, '''([^'']|'''')*''', ''''''), '.*\\bADE_(DB|SANDBOX|SBX_[0-9_]+)\\b.*', 'is') THEN 'references an ADE database'
    WHEN REGEXP_LIKE(
           REGEXP_REPLACE(
             REGEXP_REPLACE(STMT, '''([^'']|'''')*''', ''''''),
             '\\{\\{DB\\}\\}\\s*\\.\\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\\s*\\.\\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)', ' ADE_OBJREF '),
           '.*("[^"]+"|\\b[A-Za-z_][A-Za-z0-9_$]*)\\s*\\.\\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\\s*\\.\\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*).*', 's')
      THEN 'literal three-part name (use {{DB}})'
    WHEN REGEXP_LIKE(TRIM(STMT), '^(UPDATE|DELETE)\\b.*', 'is')
     AND NOT REGEXP_LIKE(REGEXP_REPLACE(STMT, '''([^'']|'''')*''', ''''''), '.*\\bWHERE\\b.*', 'is') THEN 'UPDATE/DELETE without WHERE'
    ELSE NULL
  END
$$;

-- Rollback screen: the forward rules, plus one exception. A rollback may DROP
-- a table/view/dynamic table that the same fix CREATES (the only honest inverse
-- of "create the missing table").
CREATE OR REPLACE FUNCTION ADE_DB.GUARD.SCREEN_ROLLBACK_STATEMENT(STMT VARCHAR, FORWARD ARRAY)
RETURNS VARCHAR
COMMENT = 'NULL if a rollback statement is acceptable for this fix, else the reason'
AS
$$
  CASE
    WHEN REGEXP_LIKE(TRIM(STMT), '^DROP\\s+(TABLE|VIEW|DYNAMIC\\s+TABLE)\\s+(IF\\s+EXISTS\\s+)?\\{\\{DB\\}\\}\\.[A-Za-z_"][^.\\s]*\\.[A-Za-z_"][^\\s;]*$', 'is') THEN
      IFF(
        ARRAY_CONTAINS(
          UPPER(REGEXP_REPLACE(REGEXP_SUBSTR(TRIM(STMT), '\\{\\{DB\\}\\}\\.[^\\s;]+$', 1, 1, 'i'), '\\s', ''))::VARIANT,
          ARRAY_COMPACT(TRANSFORM(FORWARD, s VARIANT ->
            IFF(REGEXP_LIKE(TRIM(s::STRING), '^CREATE\\s+(OR\\s+REPLACE\\s+)?((TRANSIENT|SECURE|RECURSIVE)\\s+)*(DYNAMIC\\s+TABLE|TABLE|VIEW)\\s+(IF\\s+NOT\\s+EXISTS\\s+)?\\{\\{DB\\}\\}\\..*', 'is'),
                UPPER(REGEXP_SUBSTR(TRIM(s::STRING), '\\{\\{DB\\}\\}\\.[A-Za-z_"][^.\\s(]*\\.[A-Za-z_"][^\\s(]*', 1, 1, 'i'))::VARIANT,
                NULL)))),
        NULL,
        'a rollback may only drop objects that the fix creates')
    ELSE ADE_DB.GUARD.SCREEN_STATEMENT(STMT)
  END
$$;

CREATE OR REPLACE FUNCTION ADE_DB.GUARD.IS_APPROVER(U VARCHAR)
RETURNS BOOLEAN
COMMENT = 'TRUE if the user may make ADE production decisions'
AS
$$
  EXISTS (SELECT 1 FROM ADE_DB.GUARD.APPROVERS WHERE USER_NAME = UPPER(U) AND ACTIVE)
  AND NOT STARTSWITH(UPPER(U), 'MANAGED_SERVICE')
  AND NOT STARTSWITH(UPPER(U), 'SF$SERVICE$')
$$;

CREATE OR REPLACE FUNCTION ADE_DB.GUARD.IS_MANAGED_DATABASE(D VARCHAR)
RETURNS BOOLEAN
COMMENT = 'TRUE if fixes may change objects in this database'
AS
$$
  REGEXP_LIKE(D, '^[A-Z_][A-Z0-9_$]{0,254}$')
  AND EXISTS (SELECT 1 FROM ADE_DB.GUARD.MANAGED_DATABASES WHERE DATABASE_NAME = UPPER(D) AND ACTIVE)
$$;

-- Deliberately ignores ACTIVE: a database that is managed in Git is refused
-- here even if someone switches it off in MANAGED_DATABASES.
CREATE OR REPLACE FUNCTION ADE_DB.GUARD.IS_GIT_MANAGED_DATABASE(D VARCHAR)
RETURNS BOOLEAN
COMMENT = 'TRUE if this database''s code lives in Git: fixes reach it only through a reviewed pull request'
AS
$$
  EXISTS (SELECT 1 FROM ADE_DB.GUARD.MANAGED_DATABASES WHERE DATABASE_NAME = UPPER(D) AND DELIVERY = 'PULL_REQUEST')
$$;

-- ---------------------------------------------------------------------
-- APPROVE_FIX / REJECT_FIX
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE ADE_DB.GUARD.APPROVE_FIX(FIX_ID VARCHAR, EXPECTED_HASH VARCHAR, NOTE VARCHAR)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = 'Approve one exact version of a fix (caller must be an approver)'
EXECUTE AS OWNER
AS
$$
DECLARE
  who VARCHAR DEFAULT CURRENT_USER();
  inc VARCHAR;
  h VARCHAR;
  st VARCHAR;
  db VARCHAR;
  conf NUMBER(5,2);
  verdict VARCHAR;
  min_conf NUMBER(5,2);
  not_allowed EXCEPTION (-20101, 'Caller is not an ADE approver');
  bad_state EXCEPTION (-20102, 'Fix is not awaiting approval');
  hash_changed EXCEPTION (-20103, 'The fix changed since you loaded it; reload and review again');
  low_conf EXCEPTION (-20104, 'The latest review does not allow approval (verdict must be APPROVE and confidence above the minimum)');
  bad_db EXCEPTION (-20106, 'Fixes may not change this database');
  git_managed EXCEPTION (-20108, 'This database is managed in Git; review its pull request');
BEGIN
  IF (NOT ADE_DB.GUARD.IS_APPROVER(:who)) THEN RAISE not_allowed; END IF;
  SELECT f.INCIDENT_ID, f.STATUS, i.DATABASE_NAME, ADE_DB.GUARD.FIX_HASH(i.DATABASE_NAME, f.STATEMENTS, f.ROLLBACK_STATEMENTS)
    INTO :inc, :st, :db, :h
    FROM ADE_DB.OPS.FIXES f JOIN ADE_DB.OPS.INCIDENTS i ON i.INCIDENT_ID = f.INCIDENT_ID
    WHERE f.FIX_ID = :FIX_ID;
  IF (ADE_DB.GUARD.IS_GIT_MANAGED_DATABASE(:db)) THEN RAISE git_managed; END IF;
  IF (st IS DISTINCT FROM 'AWAITING_APPROVAL') THEN RAISE bad_state; END IF;
  IF (h IS DISTINCT FROM :EXPECTED_HASH) THEN RAISE hash_changed; END IF;
  IF (NOT ADE_DB.GUARD.IS_MANAGED_DATABASE(:db)) THEN RAISE bad_db; END IF;
  SELECT MAX_BY(r.CONFIDENCE, r.CREATED_AT), MAX_BY(r.VERDICT, r.CREATED_AT) INTO :conf, :verdict
    FROM ADE_DB.OPS.REVIEWS r WHERE r.FIX_ID = :FIX_ID;
  SELECT COALESCE(TRY_TO_NUMBER(MAX(SETTING_VALUE)::STRING), 80) INTO :min_conf
    FROM ADE_DB.OPS.SETTINGS WHERE SETTING_KEY = 'apply.min_confidence';
  IF (verdict IS DISTINCT FROM 'APPROVE' OR COALESCE(conf, 0) < min_conf) THEN RAISE low_conf; END IF;

  INSERT INTO ADE_DB.GUARD.DECISIONS (FIX_ID, INCIDENT_ID, DECISION, FIX_HASH, DATABASE_NAME, DECIDED_BY, COMMENT, DETAIL)
    SELECT :FIX_ID, :inc, 'APPROVED', :h, :db, :who, :NOTE, OBJECT_CONSTRUCT('confidence', :conf);
  UPDATE ADE_DB.OPS.FIXES SET STATUS = 'APPROVED', APPROVED_HASH = :h, APPROVED_BY = :who, APPROVED_AT = SYSDATE(), UPDATED_AT = SYSDATE()
    WHERE FIX_ID = :FIX_ID;
  UPDATE ADE_DB.OPS.INCIDENTS SET STATUS = 'APPROVED', STATUS_DETAIL = 'Approved by ' || :who, UPDATED_AT = SYSDATE()
    WHERE INCIDENT_ID = :inc;
  INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, FIX_ID, ACTOR, ACTION, DETAIL)
    SELECT :inc, :FIX_ID, :who, 'APPROVED', OBJECT_CONSTRUCT('fix_hash', :h, 'confidence', :conf, 'note', :NOTE);
  RETURN OBJECT_CONSTRUCT('status', 'APPROVED', 'fix_id', FIX_ID, 'approved_by', who, 'fix_hash', h);
END;
$$;

CREATE OR REPLACE PROCEDURE ADE_DB.GUARD.REJECT_FIX(FIX_ID VARCHAR, NOTE VARCHAR)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = 'Reject a proposed fix (caller must be an approver)'
EXECUTE AS OWNER
AS
$$
DECLARE
  who VARCHAR DEFAULT CURRENT_USER();
  inc VARCHAR;
  h VARCHAR;
  db VARCHAR;
  not_allowed EXCEPTION (-20101, 'Caller is not an ADE approver');
BEGIN
  IF (NOT ADE_DB.GUARD.IS_APPROVER(:who)) THEN RAISE not_allowed; END IF;
  SELECT f.INCIDENT_ID, i.DATABASE_NAME, ADE_DB.GUARD.FIX_HASH(i.DATABASE_NAME, f.STATEMENTS, f.ROLLBACK_STATEMENTS)
    INTO :inc, :db, :h
    FROM ADE_DB.OPS.FIXES f JOIN ADE_DB.OPS.INCIDENTS i ON i.INCIDENT_ID = f.INCIDENT_ID
    WHERE f.FIX_ID = :FIX_ID;
  INSERT INTO ADE_DB.GUARD.DECISIONS (FIX_ID, INCIDENT_ID, DECISION, FIX_HASH, DATABASE_NAME, DECIDED_BY, COMMENT)
    SELECT :FIX_ID, :inc, 'REJECTED', :h, :db, :who, :NOTE;
  UPDATE ADE_DB.OPS.FIXES SET STATUS = 'REJECTED', UPDATED_AT = SYSDATE() WHERE FIX_ID = :FIX_ID AND STATUS NOT IN ('APPLIED', 'VERIFIED', 'ROLLED_BACK');
  UPDATE ADE_DB.OPS.INCIDENTS SET STATUS = 'NEEDS_HUMAN', STATUS_DETAIL = 'Fix rejected by ' || :who, UPDATED_AT = SYSDATE()
    WHERE INCIDENT_ID = :inc;
  INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, FIX_ID, ACTOR, ACTION, DETAIL)
    SELECT :inc, :FIX_ID, :who, 'REJECTED', OBJECT_CONSTRUCT('note', :NOTE);
  RETURN OBJECT_CONSTRUCT('status', 'REJECTED', 'fix_id', FIX_ID, 'rejected_by', who);
END;
$$;

-- ---------------------------------------------------------------------
-- RUN_JOB: re-run an incident's job now (verification). For a task, runs
-- the root of its graph (EXECUTE TASK only accepts root/standalone tasks);
-- for a dynamic table, refreshes it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE ADE_DB.GUARD.RUN_JOB(INCIDENT_ID VARCHAR, NOTE VARCHAR)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = 'Run an incident''s job now to verify a fix (caller must be an approver)'
EXECUTE AS OWNER
AS
$$
DECLARE
  who VARCHAR DEFAULT CURRENT_USER();
  db VARCHAR;
  jtype VARCHAR;
  fqn VARCHAR;
  cur VARCHAR;
  pred VARCHAR;
  depth INTEGER DEFAULT 0;
  result VARCHAR;
  not_allowed EXCEPTION (-20101, 'Caller is not an ADE approver');
  bad_db EXCEPTION (-20106, 'This database is not managed by ADE');
  bad_name EXCEPTION (-20107, 'Job name is not a plain three-part identifier');
BEGIN
  IF (NOT ADE_DB.GUARD.IS_APPROVER(:who)) THEN RAISE not_allowed; END IF;
  SELECT i.DATABASE_NAME, i.JOB_TYPE, i.JOB_FQN INTO :db, :jtype, :fqn
    FROM ADE_DB.OPS.INCIDENTS i WHERE i.INCIDENT_ID = :INCIDENT_ID;
  IF (NOT ADE_DB.GUARD.IS_MANAGED_DATABASE(:db)) THEN RAISE bad_db; END IF;
  IF (NOT REGEXP_LIKE(fqn, '^[A-Za-z_][A-Za-z0-9_$]*\\.[A-Za-z_][A-Za-z0-9_$]*\\.[A-Za-z_][A-Za-z0-9_$]*$') OR SPLIT_PART(fqn, '.', 1) <> db) THEN
    RAISE bad_name;
  END IF;
  IF (jtype = 'DYNAMIC_TABLE') THEN
    EXECUTE IMMEDIATE 'ALTER DYNAMIC TABLE ' || :fqn || ' REFRESH';
    result := 'refreshed ' || fqn;
  ELSE
    -- Walk predecessors to the root task (inventory kept by the detector).
    cur := fqn;
    LOOP
      SELECT MAX(j.PREDECESSORS[0]::STRING) INTO :pred FROM ADE_DB.OPS.JOBS j WHERE j.FQN = :cur AND j.JOB_TYPE = 'TASK';
      IF (pred IS NULL OR depth >= 20) THEN BREAK; END IF;
      IF (NOT REGEXP_LIKE(pred, '^[A-Za-z_][A-Za-z0-9_$]*\\.[A-Za-z_][A-Za-z0-9_$]*\\.[A-Za-z_][A-Za-z0-9_$]*$') OR SPLIT_PART(pred, '.', 1) <> db) THEN
        RAISE bad_name;
      END IF;
      cur := pred;
      depth := depth + 1;
    END LOOP;
    EXECUTE IMMEDIATE 'EXECUTE TASK ' || :cur;
    result := 'started ' || cur;
  END IF;
  INSERT INTO ADE_DB.GUARD.DECISIONS (FIX_ID, INCIDENT_ID, DECISION, DATABASE_NAME, DECIDED_BY, COMMENT, DETAIL)
    SELECT '-', :INCIDENT_ID, 'RUN_REQUESTED', :db, :who, :NOTE, OBJECT_CONSTRUCT('result', :result);
  INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, ACTOR, ACTION, DETAIL)
    SELECT :INCIDENT_ID, :who, 'RUN_REQUESTED', OBJECT_CONSTRUCT('result', :result, 'note', :NOTE);
  RETURN OBJECT_CONSTRUCT('status', 'RUN_REQUESTED', 'result', result);
END;
$$;

-- ---------------------------------------------------------------------
-- APPLY_FIX: verify approval + hash, screen, snapshot, apply, audit, and
-- optionally re-run the job. Runs as SYSADMIN (owner of the monitored jobs).
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE ADE_DB.GUARD.APPLY_FIX(FIX_ID VARCHAR, EXPECTED_HASH VARCHAR, RUN_AFTER BOOLEAN)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = 'Apply an approved, hash-pinned fix to production (caller must be an approver)'
EXECUTE AS OWNER
AS
$$
DECLARE
  who VARCHAR DEFAULT CURRENT_USER();
  inc VARCHAR;
  h VARCHAR;
  st VARCHAR;
  db VARCHAR;
  stmts ARRAY;
  targets ARRAY;
  last_decision VARCHAR;
  last_hash VARCHAR;
  snapshot ARRAY DEFAULT ARRAY_CONSTRUCT();
  applied ARRAY DEFAULT ARRAY_CONSTRUCT();
  kinds ARRAY DEFAULT ARRAY_CONSTRUCT('TASK', 'TABLE', 'VIEW');
  bound VARCHAR;
  reason VARCHAR;
  ddl VARCHAR;
  kind VARCHAR;
  obj VARCHAR;
  n INTEGER;
  err VARCHAR;
  run_result VARIANT;
  not_allowed EXCEPTION (-20101, 'Caller is not an ADE approver');
  bad_state EXCEPTION (-20102, 'Fix has no standing approval');
  hash_changed EXCEPTION (-20103, 'The fix changed after approval; it must be reviewed and approved again');
  screen_failed EXCEPTION (-20105, 'A statement failed the guard screen');
  bad_db EXCEPTION (-20106, 'Fixes may not change this database');
  git_managed EXCEPTION (-20108, 'This database is managed in Git; review its pull request');
BEGIN
  IF (NOT ADE_DB.GUARD.IS_APPROVER(:who)) THEN RAISE not_allowed; END IF;
  SELECT f.INCIDENT_ID, f.STATUS, f.STATEMENTS, f.TARGET_OBJECTS, i.DATABASE_NAME,
         ADE_DB.GUARD.FIX_HASH(i.DATABASE_NAME, f.STATEMENTS, f.ROLLBACK_STATEMENTS)
    INTO :inc, :st, :stmts, :targets, :db, :h
    FROM ADE_DB.OPS.FIXES f JOIN ADE_DB.OPS.INCIDENTS i ON i.INCIDENT_ID = f.INCIDENT_ID
    WHERE f.FIX_ID = :FIX_ID;
  IF (ADE_DB.GUARD.IS_GIT_MANAGED_DATABASE(:db)) THEN RAISE git_managed; END IF;
  -- Approval comes from GUARD.DECISIONS (not writable by the app), and must be
  -- the latest decision on this fix, for exactly this hash.
  SELECT MAX_BY(DECISION, DECIDED_AT), MAX_BY(FIX_HASH, DECIDED_AT) INTO :last_decision, :last_hash
    FROM ADE_DB.GUARD.DECISIONS WHERE FIX_ID = :FIX_ID AND DECISION IN ('APPROVED', 'REJECTED', 'APPLIED', 'APPLY_FAILED', 'ROLLED_BACK');
  IF (last_decision IS DISTINCT FROM 'APPROVED') THEN RAISE bad_state; END IF;
  IF (h IS DISTINCT FROM last_hash OR h IS DISTINCT FROM :EXPECTED_HASH) THEN RAISE hash_changed; END IF;
  IF (NOT ADE_DB.GUARD.IS_MANAGED_DATABASE(:db)) THEN RAISE bad_db; END IF;

  n := ARRAY_SIZE(stmts);
  FOR k IN 0 TO n - 1 DO
    reason := ADE_DB.GUARD.SCREEN_STATEMENT(GET(:stmts, :k)::STRING);
    IF (reason IS NOT NULL) THEN
      INSERT INTO ADE_DB.GUARD.DECISIONS (FIX_ID, INCIDENT_ID, DECISION, FIX_HASH, DATABASE_NAME, DECIDED_BY, COMMENT)
        SELECT :FIX_ID, :inc, 'APPLY_FAILED', :h, :db, :who, 'Guard screen rejected statement ' || (:k + 1) || ': ' || :reason;
      RAISE screen_failed;
    END IF;
  END FOR;

  UPDATE ADE_DB.OPS.FIXES SET STATUS = 'APPLYING', UPDATED_AT = SYSDATE() WHERE FIX_ID = :FIX_ID;
  UPDATE ADE_DB.OPS.INCIDENTS SET STATUS = 'APPLYING', STATUS_DETAIL = 'Applying fix (approved by ' || :who || ')', UPDATED_AT = SYSDATE()
    WHERE INCIDENT_ID = :inc;

  -- Snapshot current definitions of the targets in the incident database.
  FOR k IN 0 TO COALESCE(ARRAY_SIZE(targets), 0) - 1 DO
    obj := GET(:targets, :k)::STRING;
    IF (STARTSWITH(obj, '{{DB}}.')) THEN
      obj := REPLACE(obj, '{{DB}}', :db);
      ddl := NULL;
      kind := NULL;
      FOR j IN 0 TO 2 DO
        IF (ddl IS NULL) THEN
          BEGIN
            ddl := (SELECT GET_DDL(GET(:kinds, :j)::STRING, :obj, TRUE));
            kind := GET(kinds, j)::STRING;
          EXCEPTION
            WHEN OTHER THEN ddl := NULL;
          END;
        END IF;
      END FOR;
      snapshot := ARRAY_APPEND(snapshot, OBJECT_CONSTRUCT('object', obj, 'type', kind, 'ddl', ddl));
    END IF;
  END FOR;

  FOR k IN 0 TO n - 1 DO
    bound := REPLACE(GET(:stmts, :k)::STRING, '{{DB}}', :db);
    BEGIN
      EXECUTE IMMEDIATE :bound;
      applied := ARRAY_APPEND(applied, OBJECT_CONSTRUCT('index', :k, 'sql', :bound, 'ok', TRUE, 'query_id', LAST_QUERY_ID()));
    EXCEPTION
      WHEN OTHER THEN
        err := SQLERRM;
        applied := ARRAY_APPEND(applied, OBJECT_CONSTRUCT('index', :k, 'sql', :bound, 'ok', FALSE, 'error', :err));
        INSERT INTO ADE_DB.GUARD.DECISIONS (FIX_ID, INCIDENT_ID, DECISION, FIX_HASH, DATABASE_NAME, DECIDED_BY, COMMENT, DETAIL)
          SELECT :FIX_ID, :inc, 'APPLY_FAILED', :h, :db, :who, LEFT(:err, 4000), OBJECT_CONSTRUCT('applied', :applied, 'snapshot', :snapshot);
        UPDATE ADE_DB.OPS.FIXES
          SET STATUS = 'APPLY_FAILED', SNAPSHOT_DDL = :snapshot, APPLIED_STATEMENTS = :applied, APPLY_ERROR = LEFT(:err, 4000),
              APPLIED_BY = :who, UPDATED_AT = SYSDATE()
          WHERE FIX_ID = :FIX_ID;
        UPDATE ADE_DB.OPS.INCIDENTS SET STATUS = 'NEEDS_HUMAN', STATUS_DETAIL = 'Apply failed at statement ' || (:k + 1) || ': ' || LEFT(:err, 300), UPDATED_AT = SYSDATE()
          WHERE INCIDENT_ID = :inc;
        INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, FIX_ID, ACTOR, ACTION, DETAIL)
          SELECT :inc, :FIX_ID, :who, 'APPLY_FAILED', OBJECT_CONSTRUCT('statement', :k + 1, 'error', :err);
        RETURN OBJECT_CONSTRUCT('status', 'APPLY_FAILED', 'failed_statement', k + 1, 'error', err, 'applied', applied);
    END;
  END FOR;

  INSERT INTO ADE_DB.GUARD.DECISIONS (FIX_ID, INCIDENT_ID, DECISION, FIX_HASH, DATABASE_NAME, DECIDED_BY, DETAIL)
    SELECT :FIX_ID, :inc, 'APPLIED', :h, :db, :who, OBJECT_CONSTRUCT('applied', :applied, 'snapshot', :snapshot);
  UPDATE ADE_DB.OPS.FIXES
    SET STATUS = 'APPLIED', SNAPSHOT_DDL = :snapshot, APPLIED_STATEMENTS = :applied, APPLIED_BY = :who, APPLIED_AT = SYSDATE(), UPDATED_AT = SYSDATE()
    WHERE FIX_ID = :FIX_ID;
  UPDATE ADE_DB.OPS.INCIDENTS SET STATUS = 'VERIFYING', STATUS_DETAIL = 'Fix applied by ' || :who || '; waiting for a successful run', UPDATED_AT = SYSDATE()
    WHERE INCIDENT_ID = :inc;
  INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, FIX_ID, ACTOR, ACTION, DETAIL)
    SELECT :inc, :FIX_ID, :who, 'APPLIED', OBJECT_CONSTRUCT('statements', ARRAY_SIZE(:applied), 'fix_hash', :h);

  IF (COALESCE(:RUN_AFTER, FALSE)) THEN
    BEGIN
      CALL ADE_DB.GUARD.RUN_JOB(:inc, 'Verification run after applying fix') INTO :run_result;
    EXCEPTION
      WHEN OTHER THEN run_result := OBJECT_CONSTRUCT('error', SQLERRM);
    END;
  END IF;
  RETURN OBJECT_CONSTRUCT('status', 'APPLIED', 'statements', ARRAY_SIZE(applied), 'applied', applied, 'run', run_result);
END;
$$;

-- ---------------------------------------------------------------------
-- ROLLBACK_FIX: run the rollback statements that were reviewed, approved
-- and applied (hash-checked against the APPLIED decision).
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE ADE_DB.GUARD.ROLLBACK_FIX(FIX_ID VARCHAR, NOTE VARCHAR)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = 'Roll back an applied fix using its reviewed rollback statements (caller must be an approver)'
EXECUTE AS OWNER
AS
$$
DECLARE
  who VARCHAR DEFAULT CURRENT_USER();
  inc VARCHAR;
  h VARCHAR;
  db VARCHAR;
  rb ARRAY;
  fwd ARRAY;
  applied_hash VARCHAR;
  done ARRAY DEFAULT ARRAY_CONSTRUCT();
  bound VARCHAR;
  reason VARCHAR;
  n INTEGER;
  err VARCHAR;
  not_allowed EXCEPTION (-20101, 'Caller is not an ADE approver');
  bad_state EXCEPTION (-20102, 'Only applied fixes can be rolled back');
  hash_changed EXCEPTION (-20103, 'The fix changed after it was applied; refusing to run its rollback');
  screen_failed EXCEPTION (-20105, 'A rollback statement failed the guard screen');
  bad_db EXCEPTION (-20106, 'Fixes may not change this database');
  git_managed EXCEPTION (-20108, 'This database is managed in Git; revert the change with a pull request');
BEGIN
  IF (NOT ADE_DB.GUARD.IS_APPROVER(:who)) THEN RAISE not_allowed; END IF;
  SELECT f.INCIDENT_ID, f.ROLLBACK_STATEMENTS, f.STATEMENTS, i.DATABASE_NAME, ADE_DB.GUARD.FIX_HASH(i.DATABASE_NAME, f.STATEMENTS, f.ROLLBACK_STATEMENTS)
    INTO :inc, :rb, :fwd, :db, :h
    FROM ADE_DB.OPS.FIXES f JOIN ADE_DB.OPS.INCIDENTS i ON i.INCIDENT_ID = f.INCIDENT_ID
    WHERE f.FIX_ID = :FIX_ID;
  IF (ADE_DB.GUARD.IS_GIT_MANAGED_DATABASE(:db)) THEN RAISE git_managed; END IF;
  SELECT MAX_BY(FIX_HASH, DECIDED_AT) INTO :applied_hash
    FROM ADE_DB.GUARD.DECISIONS WHERE FIX_ID = :FIX_ID AND DECISION IN ('APPLIED', 'APPLY_FAILED');
  IF (applied_hash IS NULL) THEN RAISE bad_state; END IF;
  IF (h IS DISTINCT FROM applied_hash) THEN RAISE hash_changed; END IF;
  IF (NOT ADE_DB.GUARD.IS_MANAGED_DATABASE(:db)) THEN RAISE bad_db; END IF;
  n := COALESCE(ARRAY_SIZE(rb), 0);
  FOR k IN 0 TO n - 1 DO
    reason := ADE_DB.GUARD.SCREEN_ROLLBACK_STATEMENT(GET(:rb, :k)::STRING, :fwd);
    IF (reason IS NOT NULL) THEN RAISE screen_failed; END IF;
  END FOR;
  FOR k IN 0 TO n - 1 DO
    bound := REPLACE(GET(:rb, :k)::STRING, '{{DB}}', :db);
    BEGIN
      EXECUTE IMMEDIATE :bound;
      done := ARRAY_APPEND(done, OBJECT_CONSTRUCT('index', :k, 'sql', :bound, 'ok', TRUE));
    EXCEPTION
      WHEN OTHER THEN
        err := SQLERRM;
        done := ARRAY_APPEND(done, OBJECT_CONSTRUCT('index', :k, 'sql', :bound, 'ok', FALSE, 'error', :err));
        INSERT INTO ADE_DB.GUARD.DECISIONS (FIX_ID, INCIDENT_ID, DECISION, FIX_HASH, DATABASE_NAME, DECIDED_BY, COMMENT, DETAIL)
          SELECT :FIX_ID, :inc, 'ROLLBACK_FAILED', :h, :db, :who, LEFT(:err, 4000), OBJECT_CONSTRUCT('done', :done);
        INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, FIX_ID, ACTOR, ACTION, DETAIL)
          SELECT :inc, :FIX_ID, :who, 'ROLLBACK_FAILED', OBJECT_CONSTRUCT('statement', :k + 1, 'error', :err);
        RETURN OBJECT_CONSTRUCT('status', 'ROLLBACK_FAILED', 'failed_statement', k + 1, 'error', err);
    END;
  END FOR;
  INSERT INTO ADE_DB.GUARD.DECISIONS (FIX_ID, INCIDENT_ID, DECISION, FIX_HASH, DATABASE_NAME, DECIDED_BY, COMMENT, DETAIL)
    SELECT :FIX_ID, :inc, 'ROLLED_BACK', :h, :db, :who, :NOTE, OBJECT_CONSTRUCT('done', :done);
  UPDATE ADE_DB.OPS.FIXES SET STATUS = 'ROLLED_BACK', ROLLED_BACK_BY = :who, ROLLED_BACK_AT = SYSDATE(), UPDATED_AT = SYSDATE()
    WHERE FIX_ID = :FIX_ID;
  UPDATE ADE_DB.OPS.INCIDENTS SET STATUS = 'NEEDS_HUMAN', STATUS_DETAIL = 'Fix rolled back by ' || :who, UPDATED_AT = SYSDATE()
    WHERE INCIDENT_ID = :inc;
  INSERT INTO ADE_DB.OPS.AUDIT_LOG (INCIDENT_ID, FIX_ID, ACTOR, ACTION, DETAIL)
    SELECT :inc, :FIX_ID, :who, 'ROLLED_BACK', OBJECT_CONSTRUCT('statements', ARRAY_SIZE(:done), 'note', :NOTE);
  RETURN OBJECT_CONSTRUCT('status', 'ROLLED_BACK', 'statements', ARRAY_SIZE(done));
END;
$$;

DROP PROCEDURE IF EXISTS ADE_DB.GUARD.WHOAMI_PROBE();

-- ---------------------------------------------------------------------
-- Grants. Humans (ADE_OPERATOR_ROLE) call the procedures through the app's
-- caller's-rights sessions. The app identity gets NO usage on them, only the
-- CALLER grants that let a signed-in operator use them; FIX_HASH and
-- SCREEN_STATEMENT are pure functions the app may also call.
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA ADE_DB.GUARD TO ROLE ADE_OPERATOR_ROLE;
GRANT USAGE ON PROCEDURE ADE_DB.GUARD.APPROVE_FIX(VARCHAR, VARCHAR, VARCHAR) TO ROLE ADE_OPERATOR_ROLE;
GRANT USAGE ON PROCEDURE ADE_DB.GUARD.REJECT_FIX(VARCHAR, VARCHAR) TO ROLE ADE_OPERATOR_ROLE;
GRANT USAGE ON PROCEDURE ADE_DB.GUARD.APPLY_FIX(VARCHAR, VARCHAR, BOOLEAN) TO ROLE ADE_OPERATOR_ROLE;
GRANT USAGE ON PROCEDURE ADE_DB.GUARD.ROLLBACK_FIX(VARCHAR, VARCHAR) TO ROLE ADE_OPERATOR_ROLE;
GRANT USAGE ON PROCEDURE ADE_DB.GUARD.RUN_JOB(VARCHAR, VARCHAR) TO ROLE ADE_OPERATOR_ROLE;
GRANT SELECT ON TABLE ADE_DB.GUARD.DECISIONS TO ROLE ADE_OPERATOR_ROLE;
GRANT SELECT ON TABLE ADE_DB.GUARD.APPROVERS TO ROLE ADE_OPERATOR_ROLE;
GRANT SELECT ON TABLE ADE_DB.GUARD.DECISIONS TO ROLE ADE_APP_ROLE;
GRANT SELECT ON TABLE ADE_DB.GUARD.APPROVERS TO ROLE ADE_APP_ROLE;
GRANT SELECT ON TABLE ADE_DB.GUARD.MANAGED_DATABASES TO ROLE ADE_APP_ROLE;
GRANT USAGE ON FUNCTION ADE_DB.GUARD.FIX_HASH(VARCHAR, ARRAY, ARRAY) TO ROLE ADE_APP_ROLE;
GRANT USAGE ON FUNCTION ADE_DB.GUARD.SCREEN_STATEMENT(VARCHAR) TO ROLE ADE_APP_ROLE;
GRANT USAGE ON FUNCTION ADE_DB.GUARD.SCREEN_ROLLBACK_STATEMENT(VARCHAR, ARRAY) TO ROLE ADE_APP_ROLE;
GRANT USAGE ON FUNCTION ADE_DB.GUARD.IS_GIT_MANAGED_DATABASE(VARCHAR) TO ROLE ADE_APP_ROLE;

USE ROLE ACCOUNTADMIN;
GRANT CALLER USAGE ON PROCEDURE ADE_DB.GUARD.APPROVE_FIX(VARCHAR, VARCHAR, VARCHAR) TO ROLE ADE_APP_ROLE;
GRANT CALLER USAGE ON PROCEDURE ADE_DB.GUARD.REJECT_FIX(VARCHAR, VARCHAR) TO ROLE ADE_APP_ROLE;
GRANT CALLER USAGE ON PROCEDURE ADE_DB.GUARD.APPLY_FIX(VARCHAR, VARCHAR, BOOLEAN) TO ROLE ADE_APP_ROLE;
GRANT CALLER USAGE ON PROCEDURE ADE_DB.GUARD.ROLLBACK_FIX(VARCHAR, VARCHAR) TO ROLE ADE_APP_ROLE;
GRANT CALLER USAGE ON PROCEDURE ADE_DB.GUARD.RUN_JOB(VARCHAR, VARCHAR) TO ROLE ADE_APP_ROLE;
GRANT CALLER SELECT ON TABLE ADE_DB.GUARD.DECISIONS TO ROLE ADE_APP_ROLE;
