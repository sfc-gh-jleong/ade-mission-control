/* =====================================================================
   08 — GitHub Actions service user (OIDC / workload identity federation)
   ---------------------------------------------------------------------
   .github/workflows/deploy.yml runs its deploy job in the GitHub
   environment `prod`. The repo uses GitHub's immutable subject format
   (owner/repo IDs embedded), so the OIDC subject claim is exactly:
     repo:sfc-gh-jleong@204736462/ade-mission-control@1453213786:environment:prod
   Get the prefix with:
     gh api repos/sfc-gh-jleong/ade-mission-control/actions/oidc/customization/sub
   No password, key or token is stored anywhere.

   The account network policy (ACCOUNT_VPN_POLICY_SE) blocks GitHub-hosted
   runners. A user-level policy overrides it for this user only:
   GITHUB_ACTIONS_POLICY allows SNOWFLAKE.NETWORK_SECURITY.GITHUBACTIONS_GLOBAL
   (Snowflake-managed, tracks GitHub runner IP ranges).

   Run (substituting the repo id):
     snow sql -f sql/08_cicd_service_user.sql -D "repo_id=<REPO_ID>" -c osm_deploy
   ===================================================================== */
USE ROLE ACCOUNTADMIN;

CREATE USER IF NOT EXISTS GHA_ADE_APP_SVC
  TYPE = SERVICE
  DEFAULT_ROLE = ADE_APP_ROLE
  DEFAULT_WAREHOUSE = ADE_WH
  COMMENT = 'GitHub Actions deploys of ADE Mission Control (sfc-gh-jleong/ade-mission-control, environment prod) via OIDC'
  WORKLOAD_IDENTITY = (
    TYPE = OIDC
    ISSUER = 'https://token.actions.githubusercontent.com'
    SUBJECT = 'repo:sfc-gh-jleong@204736462/ade-mission-control@<% repo_id %>:environment:prod'
  );

-- Re-apply the subject if the user already existed (CREATE ... IF NOT EXISTS skips it).
ALTER USER GHA_ADE_APP_SVC SET WORKLOAD_IDENTITY = (
  TYPE = OIDC
  ISSUER = 'https://token.actions.githubusercontent.com'
  SUBJECT = 'repo:sfc-gh-jleong@204736462/ade-mission-control@<% repo_id %>:environment:prod'
);

-- Deploys must run as the service's execution role (it owns the application service).
GRANT ROLE ADE_APP_ROLE TO USER GHA_ADE_APP_SVC;
ALTER USER GHA_ADE_APP_SVC SET NETWORK_POLICY = GITHUB_ACTIONS_POLICY;

-- The account authentication policy targets SERVICE users and allows only
-- KEYPAIR / PAT, which rejects OIDC logins. A user-level policy overrides it
-- for this user only.
ALTER USER GHA_ADE_APP_SVC SET AUTHENTICATION POLICY SNOWFLAKE_DEMO.PUBLIC.GITHUB_OIDC_AUTH_POLICY;

-- Verify
SHOW USER WORKLOAD IDENTITY AUTHENTICATION METHODS FOR USER GHA_ADE_APP_SVC;
SHOW PARAMETERS LIKE 'NETWORK_POLICY' FOR USER GHA_ADE_APP_SVC;
