import {
  getEnvironmentConfig,
  createAuthenticatedClient,
  createAdminClient,
  isStateChangingAllowed,
} from '../config';
import { TestResult } from '../types';
import { loadUserContext, UserContext, isIntendedSecurityRejection } from '../helpers';
import {
  DisposableCluster,
  generateTestRunId,
  provisionDisposableCluster,
  teardownDisposableCluster,
  assertExactRunOwnership,
} from '../fixtures/disposable-manager';

/**
 * Suite 14: Cross-Tenant WRITE Authorization & State-Mutation Verification (Phase 2 Roadmap)
 *
 * Implements full authenticated cross-tenant write authorization tests against
 * strictly isolated, disposable fixtures:
 * 1. Unauthorized approval
 * 2. Unauthorized decline
 * 3. Unauthorized cancellation
 * 4. Unauthorized rescheduling
 * 5. Unauthorized facility-setting changes
 * 6. Unauthorized direct database updates
 * 7. Unauthorized organization membership changes
 * 8. Authorized owner operations as positive controls
 * 9. Reliable dependency-order teardown with verified zero-residue check
 *
 * Safety Governance:
 * - CONFIRM_TEST_ENV=false by default (guarded/blocked).
 * - Requires trusted service-role access for provisioning & RLS-unbiased cleanup verification.
 * - Exact-run ownership checks (runId) strictly protect existing entities.
 * - Catch blocks fail on unexpected exceptions; no PASS without independent database verification.
 * - Fails safely if required RPCs are missing or unavailable.
 */

export function isCrossTenantAuthorizationRejection(error: any): boolean {
  if (!error) return false;
  if (!isIntendedSecurityRejection(error)) return false;

  const msg = String(error.message || error.details || '').toLowerCase();
  const code = String(error.code || '').toLowerCase();

  // Reject false-positive signals (missing records, missing RPCs, 404s)
  if (
    msg.includes('not found') ||
    msg.includes('does not exist') ||
    msg.includes('no rows') ||
    msg.includes('404') ||
    msg.includes('could not find the function') ||
    code === '42883'
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

export function isRpcUnavailableError(error: any): boolean {
  if (!error) return false;
  const msg = String(error.message || error.details || '').toLowerCase();
  const code = String(error.code || '').toLowerCase();
  return code === '42883' || msg.includes('could not find the function') || (msg.includes('function') && msg.includes('does not exist'));
}

export async function runCrossTenantWriteIsolationSuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'Phase 2: Cross-Tenant WRITE Authorization & State Mutation';

  // ==========================================================================
  // Section 0: Offline Fixture Validation & Safety Governance Guard
  // ==========================================================================
  const tGov = Date.now();
  try {
    const testMockRunId = 'wtest001abc';
    // Validate that assertExactRunOwnership correctly accepts valid mock cluster
    const validMockCluster: DisposableCluster = {
      runId: testMockRunId,
      orgA: { id: '00000000-0000-0000-0000-000000000001', slug: `disp-org-a-${testMockRunId}`, name: 'Mock A' },
      orgB: { id: '00000000-0000-0000-0000-000000000002', slug: `disp-org-b-${testMockRunId}`, name: 'Mock B' },
      facA: {
        id: '00000000-0000-0000-0000-000000000003',
        organization_id: '00000000-0000-0000-0000-000000000001',
        slug: `disp-fac-a-${testMockRunId}`,
        name: 'Fac A',
        default_hourly_rate: 350,
        booking_confirmation_mode: 'manual_approval',
        hold_duration_minutes: 30,
      },
      facB: {
        id: '00000000-0000-0000-0000-000000000004',
        organization_id: '00000000-0000-0000-0000-000000000002',
        slug: `disp-fac-b-${testMockRunId}`,
        name: 'Fac B',
        default_hourly_rate: 250,
        booking_confirmation_mode: 'manual_approval',
        hold_duration_minutes: 30,
      },
      courtA: {
        id: '00000000-0000-0000-0000-000000000005',
        facility_id: '00000000-0000-0000-0000-000000000003',
        name: `Court A ${testMockRunId}`,
        sport_type: 'Pickleball',
        hourly_rate: 350,
      },
      courtB: {
        id: '00000000-0000-0000-0000-000000000006',
        facility_id: '00000000-0000-0000-0000-000000000004',
        name: `Court B ${testMockRunId}`,
        sport_type: 'Badminton',
        hourly_rate: 250,
      },
      pendingResB: {
        id: '00000000-0000-0000-0000-000000000007',
        reference_code: `TD-${testMockRunId}-P`,
        facility_id: '00000000-0000-0000-0000-000000000004',
        court_id: '00000000-0000-0000-0000-000000000006',
        status: 'pending',
        price: 250,
      },
      confirmedResB: {
        id: '00000000-0000-0000-0000-000000000008',
        reference_code: `TD-${testMockRunId}-C`,
        facility_id: '00000000-0000-0000-0000-000000000004',
        court_id: '00000000-0000-0000-0000-000000000006',
        status: 'confirmed',
        price: 250,
      },
    };

    assertExactRunOwnership(validMockCluster, testMockRunId);

    // Validate that protected seed slug raises safety violation
    let protectedSlugCaught = false;
    try {
      assertExactRunOwnership(
        { ...validMockCluster, facA: { ...validMockCluster.facA, slug: 'courtbook-pickleball-test' } },
        testMockRunId
      );
    } catch {
      protectedSlugCaught = true;
    }

    // Validate that reference code length constraint is enforced
    let invalidRefCaught = false;
    try {
      assertExactRunOwnership(
        {
          ...validMockCluster,
          pendingResB: {
            ...validMockCluster.pendingResB!,
            reference_code: `TD-${testMockRunId}-P-TOOLONGTOBEVALID25`,
          },
        },
        testMockRunId
      );
    } catch {
      invalidRefCaught = true;
    }

    if (protectedSlugCaught && invalidRefCaught) {
      results.push({
        id: 'write-iso-governance-guard',
        category,
        name: 'Governance Prerequisite: Isolated Fixture Strategy & Invariant Validation',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tGov,
        details: 'Offline verification verified: Exact-run ownership, reference_code database length constraints (5-20 chars), and protected seed slug isolation invariants pass.',
      });
    } else {
      results.push({
        id: 'write-iso-governance-guard',
        category,
        name: 'Governance Prerequisite: Isolated Fixture Strategy & Invariant Validation',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tGov,
        error: 'Safety invariant assertions failed during offline validation check.',
      });
    }
  } catch (err: any) {
    results.push({
      id: 'write-iso-governance-guard',
      category,
      name: 'Governance Prerequisite: Isolated Fixture Strategy & Invariant Validation',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - tGov,
      error: `Offline fixture validation error: ${err.message}`,
    });
  }

  // Define guarded state-changing tests
  const guardedTests = [
    { id: 'write-iso-user-a-cannot-approve-user-b-disposable', name: 'Unauthorized Approval: User A Cannot Approve User B Disposable Reservation' },
    { id: 'write-iso-user-a-cannot-decline-user-b-disposable', name: 'Unauthorized Decline: User A Cannot Decline User B Disposable Reservation' },
    { id: 'write-iso-user-a-cannot-cancel-user-b-disposable', name: 'Unauthorized Cancellation: User A Cannot Cancel User B Disposable Reservation' },
    { id: 'write-iso-user-a-cannot-reschedule-user-b-disposable', name: 'Unauthorized Rescheduling: User A Cannot Reschedule User B Disposable Reservation' },
    { id: 'write-iso-user-a-cannot-update-facility-b-disposable-settings', name: 'Unauthorized Settings Change: User A Cannot Update Facility B Settings via RPC' },
    { id: 'write-iso-user-a-cannot-update-facility-b-disposable-rate', name: 'Unauthorized Direct Update: User A Cannot Direct-UPDATE Facility B Rate via RLS' },
    { id: 'write-iso-user-a-cannot-join-org-b-disposable', name: 'Unauthorized Membership Change: User A Cannot Self-Assign as Member in Org B' },
    { id: 'write-iso-user-b-authorized-positive-control', name: 'Positive Control: Owner B Successfully Operates on Own Disposable Booking' },
    { id: 'write-iso-teardown-and-verified-cleanup', name: 'Teardown & Verification: All Disposable Fixtures Completely Cleaned Up' },
  ];

  // Guard check 1: Strictly require CONFIRM_TEST_ENV=true
  if (!isStateChangingAllowed()) {
    for (const test of guardedTests) {
      results.push({
        id: test.id,
        category,
        name: test.name,
        status: 'BLOCKED',
        operationType: 'STATE_CHANGING',
        durationMs: 0,
        details: 'State-changing test guarded: Requires explicit confirmation (CONFIRM_TEST_ENV=true in .env.test) and service-role access (SUPABASE_SERVICE_ROLE_KEY) for trusted fixture lifecycle.',
      });
    }
    return results;
  }

  // Guard check 2: Require service-role access for trusted fixture provisioning and RLS-unbiased cleanup
  if (!config.serviceRoleKey) {
    for (const test of guardedTests) {
      results.push({
        id: test.id,
        category,
        name: test.name,
        status: 'BLOCKED',
        operationType: 'STATE_CHANGING',
        durationMs: 0,
        details: 'State-changing write tests require service-role access (SUPABASE_SERVICE_ROLE_KEY) for trusted fixture provisioning, RLS-unbiased post-cleanup verification, and database-level entity teardown.',
      });
    }
    return results;
  }

  // ==========================================================================
  // Controlled Execution: Setup Authenticated Clients & Admin Client
  // ==========================================================================
  let ctxA: UserContext;
  let ctxB: UserContext;
  let adminClient: any;

  try {
    const authA = await createAuthenticatedClient(config.userAEmail, config.userAPassword);
    ctxA = await loadUserContext(authA.client, authA.userId, config.userAEmail, 'courtbook-test-pickleball-a', 'courtbook-pickleball-test');

    const authB = await createAuthenticatedClient(config.userBEmail, config.userBPassword);
    ctxB = await loadUserContext(authB.client, authB.userId, config.userBEmail, 'courtbook-test-badminton-b', 'courtbook-badminton-test');

    adminClient = createAdminClient(config.serviceRoleKey);
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

  // ==========================================================================
  // Provision Isolated Disposable Cluster
  // ==========================================================================
  const runId = generateTestRunId();
  let cluster: DisposableCluster | null = null;

  try {
    cluster = await provisionDisposableCluster(runId, ctxA.client, ctxB.client, adminClient);
    assertExactRunOwnership(cluster, runId);
  } catch (err: any) {
    results.push({
      id: 'write-iso-provisioning-fail',
      category,
      name: 'Fixture Provisioning: Isolated Test Cluster Creation',
      status: 'FAIL',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      error: `Failed to provision disposable test cluster: ${err.message}`,
    });
    return results;
  }

  try {
    // ------------------------------------------------------------------------
    // Test 1: Unauthorized Approval Barrier
    // ------------------------------------------------------------------------
    const tApprove = Date.now();
    try {
      const targetId = cluster.pendingResB!.id;
      const initialStatus = cluster.pendingResB!.status;

      const { data, error } = await ctxA.client.rpc('approve_booking_request_as_staff', {
        p_reservation_id: targetId,
        p_notes: `Unauthorized approval attempt by User A [${runId}]`,
      });

      if (isRpcUnavailableError(error)) {
        results.push({
          id: 'write-iso-user-a-cannot-approve-user-b-disposable',
          category,
          name: 'Unauthorized Approval: User A Cannot Approve User B Disposable Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tApprove,
          error: `Required RPC approve_booking_request_as_staff is unavailable in database: ${error?.message || 'Unknown error'}`,
        });
      } else if (error && isCrossTenantAuthorizationRejection(error)) {
        // Independently verify database state using adminClient
        const { data: currentRes } = await adminClient
          .from('reservations')
          .select('status')
          .eq('id', targetId)
          .single();

        const isUnchanged = currentRes?.status === initialStatus;
        results.push({
          id: 'write-iso-user-a-cannot-approve-user-b-disposable',
          category,
          name: 'Unauthorized Approval: User A Cannot Approve User B Disposable Reservation',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tApprove,
          details: `Cross-tenant approval denied by database authorization: "${error.message}". Database status verified unchanged.`,
          error: isUnchanged ? undefined : 'State mutated despite rejection!',
        });
      } else {
        results.push({
          id: 'write-iso-user-a-cannot-approve-user-b-disposable',
          category,
          name: 'Unauthorized Approval: User A Cannot Approve User B Disposable Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tApprove,
          error: error ? `Invalid error response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'write-iso-user-a-cannot-approve-user-b-disposable',
        category,
        name: 'Unauthorized Approval: User A Cannot Approve User B Disposable Reservation',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tApprove,
        error: `Unexpected execution failure in catch block: ${err?.message || String(err)}`,
      });
    }

    // ------------------------------------------------------------------------
    // Test 2: Unauthorized Decline Barrier
    // ------------------------------------------------------------------------
    const tDecline = Date.now();
    try {
      const targetId = cluster.pendingResB!.id;
      const initialStatus = cluster.pendingResB!.status;

      const { data, error } = await ctxA.client.rpc('decline_booking_request_as_staff', {
        p_reservation_id: targetId,
        p_reason: `Unauthorized decline attempt by User A [${runId}]`,
      });

      if (isRpcUnavailableError(error)) {
        results.push({
          id: 'write-iso-user-a-cannot-decline-user-b-disposable',
          category,
          name: 'Unauthorized Decline: User A Cannot Decline User B Disposable Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tDecline,
          error: `Required RPC decline_booking_request_as_staff is unavailable in database: ${error?.message || 'Unknown error'}`,
        });
      } else if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentRes } = await adminClient
          .from('reservations')
          .select('status')
          .eq('id', targetId)
          .single();

        const isUnchanged = currentRes?.status === initialStatus;
        results.push({
          id: 'write-iso-user-a-cannot-decline-user-b-disposable',
          category,
          name: 'Unauthorized Decline: User A Cannot Decline User B Disposable Reservation',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tDecline,
          details: `Cross-tenant decline denied by database authorization: "${error.message}". Database status verified unchanged.`,
          error: isUnchanged ? undefined : 'State mutated despite rejection!',
        });
      } else {
        results.push({
          id: 'write-iso-user-a-cannot-decline-user-b-disposable',
          category,
          name: 'Unauthorized Decline: User A Cannot Decline User B Disposable Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tDecline,
          error: error ? `Invalid error response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'write-iso-user-a-cannot-decline-user-b-disposable',
        category,
        name: 'Unauthorized Decline: User A Cannot Decline User B Disposable Reservation',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tDecline,
        error: `Unexpected execution failure in catch block: ${err?.message || String(err)}`,
      });
    }

    // ------------------------------------------------------------------------
    // Test 3: Unauthorized Cancellation Barrier
    // ------------------------------------------------------------------------
    const tCancel = Date.now();
    try {
      const targetId = cluster.confirmedResB!.id;
      const initialStatus = cluster.confirmedResB!.status;

      const { data, error } = await ctxA.client.rpc('cancel_reservation_as_staff', {
        p_reservation_id: targetId,
        p_reason: `Unauthorized cancel attempt by User A [${runId}]`,
      });

      if (isRpcUnavailableError(error)) {
        results.push({
          id: 'write-iso-user-a-cannot-cancel-user-b-disposable',
          category,
          name: 'Unauthorized Cancellation: User A Cannot Cancel User B Disposable Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tCancel,
          error: `Required RPC cancel_reservation_as_staff is unavailable in database: ${error?.message || 'Unknown error'}`,
        });
      } else if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentRes } = await adminClient
          .from('reservations')
          .select('status')
          .eq('id', targetId)
          .single();

        const isUnchanged = currentRes?.status === initialStatus;
        results.push({
          id: 'write-iso-user-a-cannot-cancel-user-b-disposable',
          category,
          name: 'Unauthorized Cancellation: User A Cannot Cancel User B Disposable Reservation',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tCancel,
          details: `Cross-tenant cancellation denied by database authorization: "${error.message}". Database status verified unchanged.`,
          error: isUnchanged ? undefined : 'State mutated despite rejection!',
        });
      } else {
        results.push({
          id: 'write-iso-user-a-cannot-cancel-user-b-disposable',
          category,
          name: 'Unauthorized Cancellation: User A Cannot Cancel User B Disposable Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tCancel,
          error: error ? `Invalid error response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'write-iso-user-a-cannot-cancel-user-b-disposable',
        category,
        name: 'Unauthorized Cancellation: User A Cannot Cancel User B Disposable Reservation',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tCancel,
        error: `Unexpected execution failure in catch block: ${err?.message || String(err)}`,
      });
    }

    // ------------------------------------------------------------------------
    // Test 4: Unauthorized Rescheduling Barrier
    // ------------------------------------------------------------------------
    const tReschedule = Date.now();
    try {
      const targetId = cluster.confirmedResB!.id;
      const initialCourtId = cluster.confirmedResB!.court_id;

      const { data, error } = await ctxA.client.rpc('reschedule_reservation_as_staff', {
        p_reservation_id: targetId,
        p_new_court_id: cluster.courtB.id,
        p_new_date: '2028-06-16',
        p_new_start_time: '2028-06-16T10:00:00Z',
        p_new_duration_minutes: 60,
      });

      if (isRpcUnavailableError(error)) {
        results.push({
          id: 'write-iso-user-a-cannot-reschedule-user-b-disposable',
          category,
          name: 'Unauthorized Rescheduling: User A Cannot Reschedule User B Disposable Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tReschedule,
          error: `Required RPC reschedule_reservation_as_staff is unavailable in database: ${error?.message || 'Unknown error'}`,
        });
      } else if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentRes } = await adminClient
          .from('reservations')
          .select('court_id, booking_date')
          .eq('id', targetId)
          .single();

        const isUnchanged = currentRes?.court_id === initialCourtId;
        results.push({
          id: 'write-iso-user-a-cannot-reschedule-user-b-disposable',
          category,
          name: 'Unauthorized Rescheduling: User A Cannot Reschedule User B Disposable Reservation',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tReschedule,
          details: `Cross-tenant rescheduling denied by database authorization: "${error.message}". Database court assignment verified unchanged.`,
          error: isUnchanged ? undefined : 'Court assignment mutated despite rejection!',
        });
      } else {
        results.push({
          id: 'write-iso-user-a-cannot-reschedule-user-b-disposable',
          category,
          name: 'Unauthorized Rescheduling: User A Cannot Reschedule User B Disposable Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tReschedule,
          error: error ? `Invalid error response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'write-iso-user-a-cannot-reschedule-user-b-disposable',
        category,
        name: 'Unauthorized Rescheduling: User A Cannot Reschedule User B Disposable Reservation',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tReschedule,
        error: `Unexpected execution failure in catch block: ${err?.message || String(err)}`,
      });
    }

    // ------------------------------------------------------------------------
    // Test 5: Unauthorized Facility-Setting Changes via RPC
    // ------------------------------------------------------------------------
    const tSettings = Date.now();
    try {
      const initialMode = cluster.facB.booking_confirmation_mode;

      const { data, error } = await ctxA.client.rpc('update_facility_confirmation_settings', {
        p_facility_id: cluster.facB.id,
        p_mode: 'instant',
        p_hold_minutes: 45,
      });

      if (isRpcUnavailableError(error)) {
        results.push({
          id: 'write-iso-user-a-cannot-update-facility-b-disposable-settings',
          category,
          name: 'Unauthorized Settings Change: User A Cannot Update Facility B Settings via RPC',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tSettings,
          error: `Required RPC update_facility_confirmation_settings is unavailable in database: ${error?.message || 'Unknown error'}`,
        });
      } else if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentFac } = await adminClient
          .from('facilities')
          .select('booking_confirmation_mode, hold_duration_minutes')
          .eq('id', cluster.facB.id)
          .single();

        const isUnchanged = currentFac?.booking_confirmation_mode === initialMode;
        results.push({
          id: 'write-iso-user-a-cannot-update-facility-b-disposable-settings',
          category,
          name: 'Unauthorized Settings Change: User A Cannot Update Facility B Settings via RPC',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tSettings,
          details: `Cross-tenant settings update denied by database: "${error.message}". Database settings verified unchanged.`,
          error: isUnchanged ? undefined : 'Facility settings mutated despite rejection!',
        });
      } else {
        results.push({
          id: 'write-iso-user-a-cannot-update-facility-b-disposable-settings',
          category,
          name: 'Unauthorized Settings Change: User A Cannot Update Facility B Settings via RPC',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tSettings,
          error: error ? `Invalid rejection response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'write-iso-user-a-cannot-update-facility-b-disposable-settings',
        category,
        name: 'Unauthorized Settings Change: User A Cannot Update Facility B Settings via RPC',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tSettings,
        error: `Unexpected execution failure in catch block: ${err?.message || String(err)}`,
      });
    }

    // ------------------------------------------------------------------------
    // Test 6: Unauthorized Direct Database Updates (facility default_hourly_rate)
    // ------------------------------------------------------------------------
    const tDirectUpdate = Date.now();
    try {
      const initialRate = cluster.facB.default_hourly_rate;

      const { data: updateData, error: updateErr } = await ctxA.client
        .from('facilities')
        .update({ default_hourly_rate: 999.0 })
        .eq('id', cluster.facB.id)
        .select();

      const isBlocked =
        Boolean(updateErr && (isCrossTenantAuthorizationRejection(updateErr) || updateErr.code === '42501')) ||
        (Array.isArray(updateData) && updateData.length === 0);

      const { data: verifyFac } = await adminClient
        .from('facilities')
        .select('default_hourly_rate')
        .eq('id', cluster.facB.id)
        .single();

      const isRateUnchanged = verifyFac?.default_hourly_rate === initialRate;

      if (isBlocked && isRateUnchanged) {
        results.push({
          id: 'write-iso-user-a-cannot-update-facility-b-disposable-rate',
          category,
          name: 'Unauthorized Direct Update: User A Cannot Direct-UPDATE Facility B Rate via RLS',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tDirectUpdate,
          details: 'RLS policy facility_admins_can_update_facility blocked cross-tenant modification (0 rows updated). Hourly rate verified unchanged.',
        });
      } else {
        results.push({
          id: 'write-iso-user-a-cannot-update-facility-b-disposable-rate',
          category,
          name: 'Unauthorized Direct Update: User A Cannot Direct-UPDATE Facility B Rate via RLS',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tDirectUpdate,
          error: `CRITICAL: Direct facility update was not blocked! Rows modified: ${updateData?.length}, err: ${updateErr?.message}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'write-iso-user-a-cannot-update-facility-b-disposable-rate',
        category,
        name: 'Unauthorized Direct Update: User A Cannot Direct-UPDATE Facility B Rate via RLS',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tDirectUpdate,
        error: `Unexpected execution failure in catch block: ${err?.message || String(err)}`,
      });
    }

    // ------------------------------------------------------------------------
    // Test 7: Unauthorized Organization Membership Changes (Self-Assignment)
    // ------------------------------------------------------------------------
    const tMembership = Date.now();
    try {
      const { data: beforeMembers } = await adminClient
        .from('organization_members')
        .select('id')
        .eq('organization_id', cluster.orgB.id);

      const { data: insertData, error: insertErr } = await ctxA.client
        .from('organization_members')
        .insert({
          organization_id: cluster.orgB.id,
          user_id: ctxA.userId,
          role: 'owner',
        })
        .select();

      const isBlocked =
        Boolean(insertErr && (isCrossTenantAuthorizationRejection(insertErr) || insertErr.code === '42501')) ||
        (Array.isArray(insertData) && insertData.length === 0);

      const { data: afterMembers } = await adminClient
        .from('organization_members')
        .select('id')
        .eq('organization_id', cluster.orgB.id);

      const isCountUnchanged = (beforeMembers?.length || 0) === (afterMembers?.length || 0);

      if (isBlocked && isCountUnchanged) {
        results.push({
          id: 'write-iso-user-a-cannot-join-org-b-disposable',
          category,
          name: 'Unauthorized Membership Change: User A Cannot Self-Assign as Member in Org B',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tMembership,
          details: 'RLS policies owners_can_insert_teammates strictly blocked cross-tenant self-assignment. Membership roster verified intact.',
        });
      } else {
        results.push({
          id: 'write-iso-user-a-cannot-join-org-b-disposable',
          category,
          name: 'Unauthorized Membership Change: User A Cannot Self-Assign as Member in Org B',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tMembership,
          error: `CRITICAL: Self-assignment was not blocked! Result: ${JSON.stringify(insertData)}, err: ${insertErr?.message}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'write-iso-user-a-cannot-join-org-b-disposable',
        category,
        name: 'Unauthorized Membership Change: User A Cannot Self-Assign as Member in Org B',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tMembership,
        error: `Unexpected execution failure in catch block: ${err?.message || String(err)}`,
      });
    }

    // ------------------------------------------------------------------------
    // Test 8: Authorized Owner Operations as Positive Controls
    // ------------------------------------------------------------------------
    const tPositive = Date.now();
    try {
      // Positive Control: Owner B updates own disposable facility settings
      const { data: updateRes, error: updateErr } = await ctxB.client.rpc('update_facility_confirmation_settings', {
        p_facility_id: cluster.facB.id,
        p_mode: 'instant',
        p_hold_minutes: 60,
      });

      if (isRpcUnavailableError(updateErr)) {
        results.push({
          id: 'write-iso-user-b-authorized-positive-control',
          category,
          name: 'Positive Control: Owner B Successfully Operates on Own Disposable Booking',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tPositive,
          error: `Required RPC update_facility_confirmation_settings is unavailable in database: ${updateErr?.message || 'Unknown error'}`,
        });
      } else {
        const { data: verifiedFac } = await adminClient
          .from('facilities')
          .select('booking_confirmation_mode, hold_duration_minutes')
          .eq('id', cluster.facB.id)
          .single();

        const isSettingUpdated = verifiedFac?.booking_confirmation_mode === 'instant';

        if (!updateErr && isSettingUpdated) {
          results.push({
            id: 'write-iso-user-b-authorized-positive-control',
            category,
            name: 'Positive Control: Owner B Successfully Operates on Own Disposable Booking',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - tPositive,
            details: 'Positive control passed: Owner B successfully updated own facility settings and database verified updated to instant mode.',
          });
        } else {
          results.push({
            id: 'write-iso-user-b-authorized-positive-control',
            category,
            name: 'Positive Control: Owner B Successfully Operates on Own Disposable Booking',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - tPositive,
            error: `Authorized update failed: ${updateErr?.message || 'Database state did not update'}`,
          });
        }
      }
    } catch (err: any) {
      results.push({
        id: 'write-iso-user-b-authorized-positive-control',
        category,
        name: 'Positive Control: Owner B Successfully Operates on Own Disposable Booking',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tPositive,
        error: `Unexpected exception during authorized positive control: ${err?.message || String(err)}`,
      });
    }
  } finally {
    // ------------------------------------------------------------------------
    // Test 9: Complete Teardown & Verified Cleanup (Runs in finally block)
    // ------------------------------------------------------------------------
    const tTeardown = Date.now();
    if (cluster && adminClient) {
      const cleanupReport = await teardownDisposableCluster(cluster, adminClient);

      if (cleanupReport.success) {
        results.push({
          id: 'write-iso-teardown-and-verified-cleanup',
          category,
          name: 'Teardown & Verification: All Disposable Fixtures Completely Cleaned Up',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tTeardown,
          details: `Cleanup successful: deleted ${cleanupReport.deletedReservations} reservations, ${cleanupReport.deletedCourts} courts, ${cleanupReport.deletedFacilities} facilities, ${cleanupReport.deletedMembers} memberships, ${cleanupReport.deletedOrgs} organizations. Zero records remain for run [${runId}].`,
        });
      } else {
        results.push({
          id: 'write-iso-teardown-and-verified-cleanup',
          category,
          name: 'Teardown & Verification: All Disposable Fixtures Completely Cleaned Up',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tTeardown,
          error: `Cleanup incomplete! Remaining records: ${cleanupReport.remainingRecords.join(', ')}. Errors: ${cleanupReport.errors.join('; ')}`,
        });
      }
    }
  }

  return results;
}
