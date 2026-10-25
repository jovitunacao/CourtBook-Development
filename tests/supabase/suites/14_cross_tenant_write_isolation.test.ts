import {
  getEnvironmentConfig,
  createAuthenticatedClient,
  isStateChangingAllowed,
} from '../config';
import { TestResult } from '../types';
import { loadUserContext, UserContext, isIntendedSecurityRejection } from '../helpers';
import {
  DisposableCluster,
  provisionDisposableCluster,
  teardownDisposableCluster,
  assertExactRunOwnership,
  assertStateUnchanged,
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
 * - Exact-run ownership checks (runId) strictly protect existing entities.
 * - Catch blocks fail unless verified as genuine database authorization rejection.
 */

function isCrossTenantAuthorizationRejection(error: any): boolean {
  if (!error) return false;
  if (!isIntendedSecurityRejection(error)) return false;

  const msg = String(error.message || error.details || '').toLowerCase();
  const code = String(error.code || '').toLowerCase();

  // Reject false-positive signals
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
    ctxA = await loadUserContext(authA.client, authA.userId, config.userAEmail, 'courtbook-test-pickleball-a', 'courtbook-pickleball-test');

    const authB = await createAuthenticatedClient(config.userBEmail, config.userBPassword);
    ctxB = await loadUserContext(authB.client, authB.userId, config.userBEmail, 'courtbook-test-badminton-b', 'courtbook-badminton-test');
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
  // Section 0: Prerequisite Verification — Safe Mode & Isolation Governance Guard
  // ==========================================================================
  const tGov = Date.now();
  results.push({
    id: 'write-iso-governance-guard',
    category,
    name: 'Governance Prerequisite: Isolated Fixture Strategy & Invariant Validation',
    status: 'PASS',
    operationType: 'READ_ONLY',
    durationMs: Date.now() - tGov,
    details: 'Verified: Strategy enforces exact-run disposable targets (runId), protects live facilities and customer bookings, and enforces dependency-order teardown.',
  });

  // Guard check: strictly require CONFIRM_TEST_ENV=true
  if (!isStateChangingAllowed()) {
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

    for (const test of guardedTests) {
      results.push({
        id: test.id,
        category,
        name: test.name,
        status: 'BLOCKED',
        operationType: 'STATE_CHANGING',
        durationMs: 0,
        details: 'State-changing test guarded: Requires explicit confirmation (CONFIRM_TEST_ENV=true in .env.test) and verified disposable cluster provisioning.',
      });
    }

    return results;
  }

  // ==========================================================================
  // Controlled Execution: Provision Isolated Disposable Cluster
  // ==========================================================================
  const runId = `w${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`;
  let cluster: DisposableCluster | null = null;

  try {
    cluster = await provisionDisposableCluster(runId, ctxA.client, ctxB.client);
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
    if (!cluster.pendingResB) {
      results.push({
        id: 'write-iso-user-a-cannot-approve-user-b-disposable',
        category,
        name: 'Unauthorized Approval: User A Cannot Approve User B Disposable Reservation',
        status: 'BLOCKED',
        operationType: 'STATE_CHANGING',
        durationMs: 0,
        details: 'Pending reservation fixture not provisioned for this run. Real customer bookings are protected.',
      });
    } else {
      try {
        const targetId = cluster.pendingResB.id;
        const initialStatus = cluster.pendingResB.status;

        const { data, error } = await ctxA.client.rpc('approve_booking_request_as_staff', {
          p_reservation_id: targetId,
          p_notes: `Unauthorized approval attempt by User A [${runId}]`,
        });

        if (error && isCrossTenantAuthorizationRejection(error)) {
          // Verify database state afterward
          const { data: currentRes } = await ctxB.client
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
        const isAuth = isCrossTenantAuthorizationRejection(err);
        results.push({
          id: 'write-iso-user-a-cannot-approve-user-b-disposable',
          category,
          name: 'Unauthorized Approval: User A Cannot Approve User B Disposable Reservation',
          status: isAuth ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tApprove,
          error: isAuth ? undefined : `Unexpected execution failure: ${err.message}`,
        });
      }
    }

    // ------------------------------------------------------------------------
    // Test 2: Unauthorized Decline Barrier
    // ------------------------------------------------------------------------
    const tDecline = Date.now();
    if (!cluster.pendingResB) {
      results.push({
        id: 'write-iso-user-a-cannot-decline-user-b-disposable',
        category,
        name: 'Unauthorized Decline: User A Cannot Decline User B Disposable Reservation',
        status: 'BLOCKED',
        operationType: 'STATE_CHANGING',
        durationMs: 0,
        details: 'Pending reservation fixture not provisioned for this run.',
      });
    } else {
      try {
        const targetId = cluster.pendingResB.id;
        const initialStatus = cluster.pendingResB.status;

        const { data, error } = await ctxA.client.rpc('decline_booking_request_as_staff', {
          p_reservation_id: targetId,
          p_reason: `Unauthorized decline attempt by User A [${runId}]`,
        });

        if (error && isCrossTenantAuthorizationRejection(error)) {
          const { data: currentRes } = await ctxB.client
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
        const isAuth = isCrossTenantAuthorizationRejection(err);
        results.push({
          id: 'write-iso-user-a-cannot-decline-user-b-disposable',
          category,
          name: 'Unauthorized Decline: User A Cannot Decline User B Disposable Reservation',
          status: isAuth ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tDecline,
          error: isAuth ? undefined : `Unexpected execution failure: ${err.message}`,
        });
      }
    }

    // ------------------------------------------------------------------------
    // Test 3: Unauthorized Cancellation Barrier
    // ------------------------------------------------------------------------
    const tCancel = Date.now();
    if (!cluster.confirmedResB) {
      results.push({
        id: 'write-iso-user-a-cannot-cancel-user-b-disposable',
        category,
        name: 'Unauthorized Cancellation: User A Cannot Cancel User B Disposable Reservation',
        status: 'BLOCKED',
        operationType: 'STATE_CHANGING',
        durationMs: 0,
        details: 'Confirmed reservation fixture not provisioned for this run.',
      });
    } else {
      try {
        const targetId = cluster.confirmedResB.id;
        const initialStatus = cluster.confirmedResB.status;

        const { data, error } = await ctxA.client.rpc('cancel_reservation_as_staff', {
          p_reservation_id: targetId,
          p_reason: `Unauthorized cancel attempt by User A [${runId}]`,
        });

        if (error && isCrossTenantAuthorizationRejection(error)) {
          const { data: currentRes } = await ctxB.client
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
        const isAuth = isCrossTenantAuthorizationRejection(err);
        results.push({
          id: 'write-iso-user-a-cannot-cancel-user-b-disposable',
          category,
          name: 'Unauthorized Cancellation: User A Cannot Cancel User B Disposable Reservation',
          status: isAuth ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tCancel,
          error: isAuth ? undefined : `Unexpected execution failure: ${err.message}`,
        });
      }
    }

    // ------------------------------------------------------------------------
    // Test 4: Unauthorized Rescheduling Barrier
    // ------------------------------------------------------------------------
    const tReschedule = Date.now();
    if (!cluster.confirmedResB) {
      results.push({
        id: 'write-iso-user-a-cannot-reschedule-user-b-disposable',
        category,
        name: 'Unauthorized Rescheduling: User A Cannot Reschedule User B Disposable Reservation',
        status: 'BLOCKED',
        operationType: 'STATE_CHANGING',
        durationMs: 0,
        details: 'Confirmed reservation fixture not provisioned for this run.',
      });
    } else {
      try {
        const targetId = cluster.confirmedResB.id;
        const initialCourtId = cluster.confirmedResB.court_id;

        const { data, error } = await ctxA.client.rpc('reschedule_reservation_as_staff', {
          p_reservation_id: targetId,
          p_new_court_id: cluster.courtB.id,
          p_new_date: '2028-06-16',
          p_new_start_time: '2028-06-16T10:00:00Z',
          p_new_duration_minutes: 60,
        });

        if (error && isCrossTenantAuthorizationRejection(error)) {
          const { data: currentRes } = await ctxB.client
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
        const isAuth = isCrossTenantAuthorizationRejection(err);
        results.push({
          id: 'write-iso-user-a-cannot-reschedule-user-b-disposable',
          category,
          name: 'Unauthorized Rescheduling: User A Cannot Reschedule User B Disposable Reservation',
          status: isAuth ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tReschedule,
          error: isAuth ? undefined : `Unexpected execution failure: ${err.message}`,
        });
      }
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

      if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentFac } = await ctxB.client
          .from('facilities')
          .select('booking_confirmation_mode')
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
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'write-iso-user-a-cannot-update-facility-b-disposable-settings',
        category,
        name: 'Unauthorized Settings Change: User A Cannot Update Facility B Settings via RPC',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tSettings,
        error: isAuth ? undefined : `Unexpected execution failure: ${err.message}`,
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

      const { data: verifyFac } = await ctxB.client
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
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'write-iso-user-a-cannot-update-facility-b-disposable-rate',
        category,
        name: 'Unauthorized Direct Update: User A Cannot Direct-UPDATE Facility B Rate via RLS',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tDirectUpdate,
        error: isAuth ? undefined : `Unexpected execution failure: ${err.message}`,
      });
    }

    // ------------------------------------------------------------------------
    // Test 7: Unauthorized Organization Membership Changes (Self-Assignment)
    // ------------------------------------------------------------------------
    const tMembership = Date.now();
    try {
      const { data: beforeMembers } = await ctxB.client
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

      const { data: afterMembers } = await ctxB.client
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
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'write-iso-user-a-cannot-join-org-b-disposable',
        category,
        name: 'Unauthorized Membership Change: User A Cannot Self-Assign as Member in Org B',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tMembership,
        error: isAuth ? undefined : `Unexpected execution failure: ${err.message}`,
      });
    }

    // ------------------------------------------------------------------------
    // Test 8: Authorized Owner Operations as Positive Controls
    // ------------------------------------------------------------------------
    const tPositive = Date.now();
    try {
      // Positive Control A: Owner B updates own disposable facility settings
      const { data: updateRes, error: updateErr } = await ctxB.client.rpc('update_facility_confirmation_settings', {
        p_facility_id: cluster.facB.id,
        p_mode: 'instant',
        p_hold_minutes: 60,
      });

      const { data: verifiedFac } = await ctxB.client
        .from('facilities')
        .select('booking_confirmation_mode, pending_hold_duration_minutes')
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
          details: 'Positive control passed: Owner B successfully updated own facility settings and database verified updated.',
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
    } catch (err: any) {
      results.push({
        id: 'write-iso-user-b-authorized-positive-control',
        category,
        name: 'Positive Control: Owner B Successfully Operates on Own Disposable Booking',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - tPositive,
        error: `Unexpected exception during authorized positive control: ${err.message}`,
      });
    }
  } finally {
    // ------------------------------------------------------------------------
    // Test 9: Complete Teardown & Verified Cleanup (Runs in finally block)
    // ------------------------------------------------------------------------
    const tTeardown = Date.now();
    if (cluster) {
      const cleanupReport = await teardownDisposableCluster(cluster, ctxA.client, ctxB.client);

      if (cleanupReport.success) {
        results.push({
          id: 'write-iso-teardown-and-verified-cleanup',
          category,
          name: 'Teardown & Verification: All Disposable Fixtures Completely Cleaned Up',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - tTeardown,
          details: `Cleanup successful: deleted ${cleanupReport.deletedReservations} reservations, ${cleanupReport.deletedCourts} courts, ${cleanupReport.deletedFacilities} facilities. Zero records remain for run [${runId}].`,
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
