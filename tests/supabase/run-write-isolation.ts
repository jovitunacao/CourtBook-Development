import { validateEnvironment, getEnvironmentConfig, isStateChangingAllowed } from './config';
import { printTestHeader, printTestResult, printSummaryReport } from './test-reporter';
import { runCrossTenantWriteIsolationSuite } from './suites/14_cross_tenant_write_isolation.test';

async function main() {
  printTestHeader();

  const envCheck = validateEnvironment();
  const config = getEnvironmentConfig();

  if (!envCheck.isValid) {
    console.log('\x1b[33m[CONFIGURATION NOTICE] Supabase Test Environment Variables Incomplete\x1b[0m\n');
    console.log(`The automated isolation suite targets your Supabase project [${config.testProject}].`);
    console.log('Missing environment variable(s):');
    envCheck.missing.forEach((item) => {
      console.log(`  - \x1b[31m${item}\x1b[0m`);
    });
    console.log('\nConfigure your credentials in .env.test before running.\n');
    process.exit(1);
  }

  const stateChangingAllowed = isStateChangingAllowed();
  console.log(`\x1b[32mEnvironment validated for project [${config.testProject}].\x1b[0m`);
  if (stateChangingAllowed) {
    console.log('\x1b[35m[CONFIRMED] CONFIRM_TEST_ENV=true detected. State-changing write tests on disposable fixtures enabled.\x1b[0m\n');
  } else {
    console.log('\x1b[33m[SAFE MODE] CONFIRM_TEST_ENV is not set. State-changing write tests will be safeguarded/BLOCKED.\x1b[0m\n');
  }

  console.log('\x1b[1m\x1b[34m--- Suite 14: Phase 2 — Cross-Tenant WRITE Authorization & State Mutation ---\x1b[0m\n');
  const startTime = Date.now();
  const suiteResults = await runCrossTenantWriteIsolationSuite();

  for (const res of suiteResults) {
    printTestResult(res);
  }

  const durationMs = Date.now() - startTime;
  const passed = suiteResults.filter((r) => r.status === 'PASS').length;
  const failed = suiteResults.filter((r) => r.status === 'FAIL').length;
  const blocked = suiteResults.filter((r) => r.status === 'BLOCKED').length;
  const readOnlyCount = suiteResults.filter((r) => r.operationType === 'READ_ONLY').length;
  const stateChangingCount = suiteResults.filter((r) => r.operationType === 'STATE_CHANGING').length;

  printSummaryReport({
    total: suiteResults.length,
    passed,
    failed,
    blocked,
    readOnlyCount,
    stateChangingCount,
    durationMs,
    results: suiteResults,
  });

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\x1b[31m[RUNNER CRASH]\x1b[0m', err);
  process.exit(1);
});
