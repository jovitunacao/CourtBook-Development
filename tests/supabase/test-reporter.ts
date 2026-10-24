import { TestReportSummary, TestResult } from './types';

export function printTestHeader(): void {
  console.log('\n================================================================================');
  console.log('   CourtBook / BookSuite — Automated Supabase Security & Integration Suite');
  console.log('================================================================================\n');
}

export function printTestResult(result: TestResult): void {
  const statusBadges = {
    PASS: '\x1b[32m[PASS]\x1b[0m',
    FAIL: '\x1b[31m[FAIL]\x1b[0m',
    BLOCKED: '\x1b[33m[BLOCKED]\x1b[0m',
  };

  const typeBadge =
    result.operationType === 'STATE_CHANGING'
      ? '\x1b[35m[STATE-CHANGING]\x1b[0m'
      : '\x1b[36m[READ-ONLY]\x1b[0m';

  const badge = statusBadges[result.status] || `[${result.status}]`;
  const timeStr = `${result.durationMs}ms`;

  console.log(`  ${badge} ${typeBadge} ${result.name} \x1b[90m(${timeStr})\x1b[0m`);

  if (result.details) {
    console.log(`         \x1b[36mDetails:\x1b[0m ${result.details}`);
  }

  if (result.error) {
    console.log(`         \x1b[31mError:\x1b[0m ${result.error}`);
  }

  if (result.suggestedFix) {
    console.log(`         \x1b[35mSuggested Fix / Note:\x1b[0m ${result.suggestedFix}`);
  }
}

export function printSummaryReport(summary: TestReportSummary): void {
  console.log('\n--------------------------------------------------------------------------------');
  console.log('                            TEST SUITE EXECUTION SUMMARY');
  console.log('--------------------------------------------------------------------------------');
  console.log(`  Total Tests Run:          ${summary.total}`);
  console.log(`  \x1b[32mPassed:\x1b[0m                   ${summary.passed}`);
  console.log(`  \x1b[31mFailed:\x1b[0m                   ${summary.failed}`);
  console.log(`  \x1b[33mBlocked (Safeguarded):\x1b[0m    ${summary.blocked}`);
  console.log(`  - Read-Only Tests:        ${summary.readOnlyCount}`);
  console.log(`  - State-Changing Tests:   ${summary.stateChangingCount}`);
  console.log(`  Total Duration:           ${summary.durationMs}ms`);
  console.log('--------------------------------------------------------------------------------\n');

  if (summary.failed > 0) {
    console.log('\x1b[31mFAILED TESTS SUMMARY:\x1b[0m');
    summary.results
      .filter((r) => r.status === 'FAIL')
      .forEach((r, idx) => {
        console.log(`  ${idx + 1}. [${r.category}] ${r.name}`);
        if (r.error) console.log(`     Error: ${r.error}`);
        if (r.suggestedFix) console.log(`     Fix:   ${r.suggestedFix}`);
      });
    console.log('');
  }

  if (summary.blocked > 0) {
    console.log('\x1b[33mBLOCKED / SAFEGUARDED TESTS:\x1b[0m');
    summary.results
      .filter((r) => r.status === 'BLOCKED')
      .forEach((r, idx) => {
        console.log(`  ${idx + 1}. [${r.category}] ${r.name}`);
        if (r.details) console.log(`     Reason: ${r.details}`);
        if (r.suggestedFix) console.log(`     Note:   ${r.suggestedFix}`);
      });
    console.log('');
  }
}
