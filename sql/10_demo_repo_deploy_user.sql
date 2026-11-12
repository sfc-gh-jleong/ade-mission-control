/* =====================================================================
   10 — GitHub Actions service user for the demo repo (OIDC)
   ---------------------------------------------------------------------
   .github/workflows/deploy.yml in sfc-gh-jleong/ade-demo-retail deploys
   objects/ to ADE_DEMO_RETAIL from the GitHub environment `demo`, which only
   main can deploy to. The repo uses GitHub's immutable subject format, so the
   OIDC subject claim is exactly:
     repo:sfc-gh-jleong@204736462/ade-demo-retail@1454587771:environment:demo
   (gh api repos/sfc-gh-jleong/ade-demo-retail/actions/oidc/customization/sub)
   Pull-request and fork workflows have a different subject and cannot sign in.
   No password, key or token is stored anywhere.

   The user's role is ADE_DEMO_OWNER, which owns the demo database
   (90_demo_pipeline.sql): every task in a graph must have the same owner, and
   the repo's tasks hang off LOAD_ORDERS.

   As for GHA_ADE_APP_SVC (08_cicd_service_user.sql):
     - GITHUB_ACTIONS_POLICY lets GitHub-hosted runners past the account
       network policy (Snowflake-managed rule for GitHub's runner IP ranges);
     - GITHUB_OIDC_AUTH_POLICY allows workload identity sign-in, which the
       account's SERVICE-user authentication policy does not.

   Run once:
     snow sql -f sql/10_demo_repo_deploy_user.sql -c osm_deploy
   ===================================================================== */
USE ROLE ACCOUNTADMIN;

CREATE USER IF NOT EXISTS GHA_ADE_DEMO_SVC
  TYPE = SERVICE
  DEFAULT_ROLE = ADE_DEMO_OWNER
  DEFAULT_WAREHOUSE = COMPUTE_WH
  COMMENT = 'GitHub Actions deploys of sfc-gh-jleong/ade-demo-retail (environment demo) to ADE_DEMO_RETAIL via OIDC'
  WORKLOAD_IDENTITY = (
    TYPE = OIDC
    ISSUER = 'https://token.actions.githubusercontent.com'
    SUBJECT = 'repo:sfc-gh-jleong@204736462/ade-demo-retail@1454587771:environment:demo'
  );

-- Re-apply the subject if the user already existed (CREATE ... IF NOT EXISTS skips it).
ALTER USER GHA_ADE_DEMO_SVC SET WORKLOAD_IDENTITY = (
  TYPE = OIDC
  ISSUER = 'https://token.actions.githubusercontent.com'
  SUBJECT = 'repo:sfc-gh-jleong@204736462/ade-demo-retail@1454587771:environment:demo'
);

GRANT ROLE ADE_DEMO_OWNER TO USER GHA_ADE_DEMO_SVC;
ALTER USER GHA_ADE_DEMO_SVC SET NETWORK_POLICY = GITHUB_ACTIONS_POLICY;
-- Fails if a policy is already attached; UNSET it first when re-running.
ALTER USER GHA_ADE_DEMO_SVC SET AUTHENTICATION POLICY SNOWFLAKE_DEMO.PUBLIC.GITHUB_OIDC_AUTH_POLICY;

-- Verify
SHOW USER WORKLOAD IDENTITY AUTHENTICATION METHODS FOR USER GHA_ADE_DEMO_SVC;
SHOW PARAMETERS LIKE 'NETWORK_POLICY' FOR USER GHA_ADE_DEMO_SVC;
SHOW GRANTS TO USER GHA_ADE_DEMO_SVC;
