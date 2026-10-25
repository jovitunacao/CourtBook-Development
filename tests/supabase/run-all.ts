import { validateEnvironment, getEnvironmentConfig, isStateChangingAllowed } from './config';
import { TestReportSummary, TestResult } from './types';
import { printTestHeader, printTestResult, printSummaryReport } from './test-reporter';

import { runAuthSuite } from './suites/01_auth.test';
import { runOrganizationsSuite } from './suites/02_rls_organizations.test';
import { runFacilitiesAndCourtsSuite } from './suites/03_rls_facilities_and_courts.test';
import { runReservationSecuritySuite } from './suites/04_reservation_security.test';
import { runCancellationSecuritySuite } from './suites/05_cancellation_security.test';
import { runReschedulingSecuritySuite } from './suites/06_rescheduling_security.test';
import { runMaintenanceBlocksSuite } from './suites/07_maintenance_blocks.test';
import { runPublicAvailabilitySuite } from './suites/08_public_availability.test';
import { runBookingConfirmationSuite } from './suites/09_booking_confirmation.test';
import { runEdgeSecurityAndAbuseSuite } from './suites/10_edge_security_and_abuse.test';
import { runUuidMappingSuite } from './suites/11_facility_and_court_uuid_mapping.test';
import { runBookingResponseAndRecoverySuite } from './suites/12_booking_response_and_recovery.test';
import { runMultiTenantIsolationSuite } from './suites/13_multi_tenant_isolation.test';

async function main() {
  printTestHeader();

  const envCheck = validateEnvironment();
  const config = getEnvironmentConfig();

  if (!envCheck.isValid) {
    console.log('\x1b[33m[CONFIGURATION NOTICE] Supabase Test Environment Variables Incomplete\x1b[0m\n');
    console.log(`The automated security suite targets your Supabase project [${config.testProject}].`);
    console.log('Missing environment variable(s):');
    envCheck.missing.forEach((item) => {
      console.log(`  - \x1b[31m${item}\x1b[0m`);
    });
    console.log('\n\x1b[36mHow to configure test environment in Mac Terminal:\x1b[0m');
    console.log('  1. Create or edit .env.test:');
    console.log('       touch .env.test');
    console.log('  2. Populate with your Supabase credentials and test user accounts:');
    console.log('       SUPABASE_URL=https://your-ref.supabase.co');
    console.log('       SUPABASE_ANON_KEY=your-anon-key');
    console.log('       TEST_USER_A_EMAIL=your-user-a-email');
    console.log('       TEST_USER_A_PASSWORD=your-user-a-password');
    console.log('       TEST_USER_B_EMAIL=your-user-b-email');
    console.log('       TEST_USER_B_PASSWORD=your-user-b-password');
    console.log('       CONFIRM_TEST_ENV=true  # (optional: allows safe state changes on disposable fixtures)');
    console.log('  3. Run:');
    console.log('       npm run test:supabase\n');
    console.log('Refer to tests/supabase/README.md for full instructions.\n');
    process.exit(1);
  }

  const stateChangingAllowed = isStateChangingAllowed();
  console.log(`\x1b[32mEnvironment validated for project [${config.testProject}].\x1b[0m`);
  if (stateChangingAllowed) {
    console.log('\x1b[35m[CONFIRMED] CONFIRM_TEST_ENV=true detected. State-changing tests on disposable fixtures enabled.\x1b[0m\n');
  } else {
    console.log('\x1b[33m[SAFE MODE] CONFIRM_TEST_ENV is not set. State-changing tests will be safeguarded/BLOCKED.\x1b[0m\n');
  }

  const allResults: TestResult[] = [];
  const startTime = Date.now();

  const suites = [
    { name: '1. Supabase Authentication', runner: runAuthSuite },
    { name: '2. Multi-Tenant Organizations & Anti-Escalation RLS', runner: runOrganizationsSuite },
    { name: '3. Facilities & Courts Isolation RLS', runner: runFacilitiesAndCourtsSuite },
    { name: '4. Direct UPDATE Revocation & Reservation Protection', runner: runReservationSecuritySuite },
    { name: '5. Staff Cancellation Procedure Security', runner: runCancellationSecuritySuite },
    { name: '6. Staff Rescheduling Procedure Security', runner: runReschedulingSecuritySuite },
    { name: '7. Maintenance Blocks & Overlap Prevention', runner: runMaintenanceBlocksSuite },
    { name: '8. Public Court Availability & RPC Boundaries', runner: runPublicAvailabilitySuite },
    { name: '9. Booking Confirmation Mode, Approvals & Hold Security', runner: runBookingConfirmationSuite },
    { name: '10. Edge Security, Abuse Defense & Idempotency', runner: runEdgeSecurityAndAbuseSuite },
    { name: '11. Facility & Court UUID Mapping & Validation', runner: runUuidMappingSuite },
    { name: '12. Booking Response Envelope & Idempotency Recovery', runner: runBookingResponseAndRecoverySuite },
    { name: '13. Multi-Tenant Security & Tenant Isolation', runner: runMultiTenantIsolationSuite },
  ];

  for (const suite of suites) {
    console.log(`\n\x1b[1m\x1b[34m--- Suite: ${suite.name} ---\x1b[0m`);
    try {
      const suiteResults = await suite.runner();
      for (const res of suiteResults) {
        printTestResult(res);
        allResults.push(res);
      }
    } catch (err: any) {
      console.log(`  \x1b[31m[SUITE CRASH]\x1b[0m Exception running ${suite.name}: ${err.message}`);
      allResults.push({
        id: `suite-crash-${Date.now()}`,
        category: suite.name,
        name: `Suite Execution for ${suite.name}`,
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: 0,
        error: err.message,
      });
    }
  }

  const durationMs = Date.now() - startTime;
  const passed = allResults.filter((r) => r.status === 'PASS').length;
  const failed = allResults.filter((r) => r.status === 'FAIL').length;
  const blocked = allResults.filter((r) => r.status === 'BLOCKED').length;
  const readOnlyCount = allResults.filter((r) => r.operationType === 'READ_ONLY').length;
  const stateChangingCount = allResults.filter((r) => r.operationType === 'STATE_CHANGING').length;

  const summary: TestReportSummary = {
    total: allResults.length,
    passed,
    failed,
    blocked,
    readOnlyCount,
    stateChangingCount,
    durationMs,
    results: allResults,
  };

  printSummaryReport(summary);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('\x1b[31mUnhandled Test Runner Error:\x1b[0m', err);
  process.exit(1);
});
