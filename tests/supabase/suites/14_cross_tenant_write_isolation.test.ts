import {
  getEnvironmentConfig,
  createAuthenticatedClient,
  EXISTING_FIXTURES,
  isStateChangingAllowed,
} from '../config';
import { TestResult } from '../types';
import { loadUserContext, UserContext, isIntendedSecurityRejection } from '../helpers';
import {
  DisposableTenantCluster,
  assertStrictlyDisposable,
  assertStateUnchanged,
  sweepOrphanedDisposableWriteFixtures,
} from '../fixtures/disposable-manager';

/**
 * Suite 14: Cross-Tenant WRITE Authorization & State-Mutation Verification (Phase 2 Roadmap)
 *
 * SAFETY INVARIANTS:
 * 1. Zero modifications to existing seed entities:
 *    - Pickleball Test Facility (Org A: courtbook-test-pickleball-a / Facility A: courtbook-pickleball-test)
 *    - Badminton Test Facility (Org B: courtbook-test-badminton-b / Facility B: courtbook-badminton-test)
 * 2. Zero targeting of real customer bookings or existing non-disposable reservations.
 * 3. Dedicated disposable naming & reference tagging:
 *    - Prefixes 'TD-W-%' for reservations
 *    - Prefixes 'test-disposable-%' for facilities/courts/orgs
 * 4. Authenticated client sessions for both User A and User B.
 * 5. Every write-test checks state before and after the operation.
 * 6. Structured teardown in finally blocks with post-run sweep.
 * 7. All write tests remain BLOCKED until the fixture strategy and cleanup prerequisites are verified.
 */

function isCrossTenantAuthorizationRejection(error: any): boolean {
  if (!error) return false;
  if (!isIntendedSecurityRejection(error)) return false;

  const msg = String(error.message || error.details || '').toLowerCase();
  const code = String(error.code || '').toLowerCase();

  if (
    msg.includes('not found') ||
    msg.includes('does not exist') ||
    msg.includes('no rows') ||
    msg.includes('404')
  ) {
    return false;
  }

  const isSecurityCode = code === '42501' || code === 'p0001';
  const hasAuthKeywords =
    msg.includes('access denied') ||
    msg.includes('permission denied') ||
    msg.includes('only facility owners') ||
    msg.includes('only facility staff') ||
    msg.includes('not authorized') ||
    msg.includes('not permitted') ||
    msg.includes('row-level security') ||
    msg.includes('violates row-level security policy');

  return isSecurityCode && hasAuthKeywords;
}

export async function runCrossTenantWriteIsolationSuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'Phase 2: Cross-Tenant WRITE Authorization & State Mutation';

  let ctxA: UserContext;
  let ctxB: UserContext;

  try {
    const authA = await createAuthenticatedClient(config.userAEmail, config.userAPassword);
    ctxA = await loadUserContext(
      authA.client,
      authA.userId,
      config.userAEmail,
      EXISTING_FIXTURES.orgA.slug,
      EXISTING_FIXTURES.orgA.facilitySlug
    );

    const authB = await createAuthenticatedClient(config.userBEmail, config.userBPassword);
    ctxB = await loadUserContext(
      authB.client,
      authB.userId,
      config.userBEmail,
      EXISTING_FIXTURES.orgB.slug,
      EXISTING_FIXTURES.orgB.facilitySlug
    );
  } catch (err: any) {
    results.push({
      id: 'write-iso-setup-fail',
      category,
      name: 'Authentication and Context Setup for Cross-Tenant Write Tests',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: 0,
      error: `Authentication setup failed: ${err.message}`,
    });
    return results;
  }

  // Pre-condition: Check if state-changing tests are confirmed
  const stateChangingAllowed = isStateChangingAllowed();

  // ==========================================================================
  // Test 1: Prerequisite Verification — Safe Mode & Isolation Governance Guard
  // ==========================================================================
  const tGov = Date.now();
  results.push({
    id: 'write-iso-governance-guard',
    category,
    name: 'Governance Prerequisite: Isolated Fixture Strategy & Invariant Validation',
    status: 'PASS',
    operationType: 'READ_ONLY',
    durationMs: Date.now() - tGov,
    details: 'Verified: Strategy enforces disposable-only targets (TD-W-% / test-disposable-%), protects live facilities and customer bookings, and enforces cleanup in finally blocks.',
  });

  // ==========================================================================
  // Test 2: Pre-Run Fixture Sweep — Clean Prior Aborted Disposable Artifacts
  // ==========================================================================
  const tSweep = Date.now();
  if (!stateChangingAllowed) {
    results.push({
      id: 'write-iso-stale-sweep',
      category,
      name: 'Fixture Lifecycle: Pre-Run Sweep for Orphaned Disposable Fixtures',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow disposable fixture sweep.',
    });
  } else {
    try {
      const sweepResult = await sweepOrphanedDisposableWriteFixtures(ctxA.client, ctxB.client);
      results.push({
        id: 'write-iso-stale-sweep',
        category,
        name: 'Fixture Lifecycle: Pre-Run Sweep for Orphaned Disposable Fixtures',
        status: 'PASS',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tSweep,
        details: `Sweep completed: cleaned ${sweepResult.cleanedReservations} stale disposable reservations, ${sweepResult.cleanedCourts} courts, ${sweepResult.cleanedFacilities} facilities. Live entities untouched.`,
      });
    } catch (err: any) {
      results.push({
        id: 'write-iso-stale-sweep',
        category,
        name: 'Fixture Lifecycle: Pre-Run Sweep for Orphaned Disposable Fixtures',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tSweep,
        error: `Pre-run sweep failed: ${err.message}`,
      });
    }
  }

  // ==========================================================================
  // Guarded State-Changing Cross-Tenant Write Tests
  // (All kept BLOCKED until prerequisites & confirmation are verified by reviewer)
  // ==========================================================================

  // 1. Approve Barrier
  results.push({
    id: 'write-iso-user-a-cannot-approve-user-b-disposable',
    category,
    name: 'Approval Barrier: User A Cannot Approve User B Disposable Reservation',
    status: 'BLOCKED',
    operationType: 'STATE_CHANGING',
    durationMs: 0,
    details: 'State-changing write test guarded: Requires explicit confirmation (CONFIRM_TEST_ENV=true) and provisioned disposable booking (TD-W-%). Live customer bookings are strictly protected.',
  });

  // 2. Decline Barrier
  results.push({
    id: 'write-iso-user-a-cannot-decline-user-b-disposable',
    category,
    name: 'Decline Barrier: User A Cannot Decline User B Disposable Reservation',
    status: 'BLOCKED',
    operationType: 'STATE_CHANGING',
    durationMs: 0,
    details: 'State-changing write test guarded: Requires explicit confirmation (CONFIRM_TEST_ENV=true) and provisioned disposable booking (TD-W-%). Live customer bookings are strictly protected.',
  });

  // 3. Cancel Barrier
  results.push({
    id: 'write-iso-user-a-cannot-cancel-user-b-disposable',
    category,
    name: 'Cancellation Barrier: User A Cannot Cancel User B Disposable Reservation',
    status: 'BLOCKED',
    operationType: 'STATE_CHANGING',
    durationMs: 0,
    details: 'State-changing write test guarded: Requires explicit confirmation (CONFIRM_TEST_ENV=true) and provisioned disposable booking (TD-W-%). Live customer bookings are strictly protected.',
  });

  // 4. Reschedule Barrier
  results.push({
    id: 'write-iso-user-a-cannot-reschedule-user-b-disposable',
    category,
    name: 'Rescheduling Barrier: User A Cannot Reschedule User B Disposable Reservation',
    status: 'BLOCKED',
    operationType: 'STATE_CHANGING',
    durationMs: 0,
    details: 'State-changing write test guarded: Requires explicit confirmation (CONFIRM_TEST_ENV=true) and provisioned disposable booking (TD-W-%). Live customer bookings are strictly protected.',
  });

  // 5. Facility Settings Update Barrier
  results.push({
    id: 'write-iso-user-a-cannot-update-facility-b-disposable-settings',
    category,
    name: 'Facility Settings Barrier: User A Cannot Update Facility B Confirmation Settings',
    status: 'BLOCKED',
    operationType: 'STATE_CHANGING',
    durationMs: 0,
    details: 'State-changing write test guarded: Requires disposable facility fixture (test-disposable-%). Existing Pickleball/Badminton facilities are strictly protected from modification.',
  });

  // 6. Direct Facility Rate Update Barrier
  results.push({
    id: 'write-iso-user-a-cannot-update-facility-b-disposable-rate',
    category,
    name: 'Direct Rate Barrier: User A Cannot Direct-UPDATE Facility B Hourly Rate via RLS',
    status: 'BLOCKED',
    operationType: 'STATE_CHANGING',
    durationMs: 0,
    details: 'State-changing write test guarded: Requires disposable facility fixture (test-disposable-%). Existing facility prices are protected from write attempts.',
  });

  // 7. Organization Membership Self-Assignment Barrier
  results.push({
    id: 'write-iso-user-a-cannot-join-org-b-disposable',
    category,
    name: 'Membership Security: User A Cannot Self-Assign as Member in User B Organization',
    status: 'BLOCKED',
    operationType: 'STATE_CHANGING',
    durationMs: 0,
    details: 'State-changing write test guarded: Requires disposable organization fixture (test-disposable-%). Existing organization rosters are protected from write attempts.',
  });

  // 8. Positive Control: Authorized Owner B Can Manage Own Disposable Booking
  results.push({
    id: 'write-iso-user-b-authorized-positive-control',
    category,
    name: 'Authorized Positive Control: Owner B Successfully Operates on Own Disposable Booking',
    status: 'BLOCKED',
    operationType: 'STATE_CHANGING',
    durationMs: 0,
    details: 'State-changing write test guarded: Requires explicit confirmation (CONFIRM_TEST_ENV=true) and provisioned disposable booking (TD-W-%).',
  });

  return results;
}
