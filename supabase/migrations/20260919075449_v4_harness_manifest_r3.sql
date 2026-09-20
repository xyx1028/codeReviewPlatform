-- Generated from worker/harness/code-review-acp/v4-capability-contract.json.
-- Do not edit the policy JSON by hand.
-- v4-manifest-revision: 3
-- v4-manifest-source-sha256: 87f5e063512808a6cca4f7b9785be55552baacf6ba3051509c3093a0ca5c6115
-- v4-manifest-hash: 6189bb7bdd6ddfbb33512fad6f867a3a9ceda7a30845bc62598c5a69226df868

begin;

update public.v4_harness_manifest set is_active = false where is_active;
insert into public.v4_harness_manifest (
  manifest_revision, contract_version, harness_version, manifest_hash, default_policy, is_active
) values (
  3, 4, '0.1.5-rc.1',
  '6189bb7bdd6ddfbb33512fad6f867a3a9ceda7a30845bc62598c5a69226df868',
  '{"version":4,"capabilities":{"instructions":true,"skills":true,"goal":true,"plan":true,"todo":true,"ralph":true,"subagentSpawn":true,"subagentFork":true,"subagentControl":true,"workflow":true,"jobs":true,"shell":true,"filesystem":true,"webSearch":true,"webFetch":true,"parallelTools":true,"autoCompaction":true,"sessionPersistence":true,"sessionResume":true,"artifacts":true},"sandbox":{"defaultMode":"workspace-write","dangerFullAccess":false,"commandTimeoutMs":60000,"maxProcessesPerAttempt":64,"maxWorkspaceBytes":2147483648,"maxWorkspaceFiles":100000},"agents":{"maxAgentsPerAttempt":8,"maxDelegationDepth":2,"maxConcurrentChildren":4,"allowOutOfProcessProviders":false},"workflow":{"maxConcurrentSteps":4,"maxRuntimeMs":900000},"jobs":{"maxConcurrentJobsPerOwner":4,"maxRuntimeMs":300000},"parallelTools":{"maxPerStep":8,"mutationToolsSerial":true},"modelBudget":{"maxTotalRequests":160,"maxRootRequests":80,"maxChildRequests":32,"maxRetryRequests":12,"maxCompactionRequests":8,"maxRalphRounds":12},"web":{"maxRequestsPerAttempt":20,"maxResponseBytes":2097152,"maxTotalBytes":20971520,"allowHttp":false,"allowedPorts":[443],"allowedDomains":[],"denyPrivateNetworks":true,"maxRedirects":3,"requestTimeoutMs":20000},"session":{"checkpointEveryEvents":100,"retentionDays":7,"encryptAtRest":true,"resumeOnWorkerRestart":true}}'::jsonb,
  true
);

commit;
