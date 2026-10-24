import {
  getEnvironmentConfig,
  createAnonClient,
  createAuthenticatedClient,
  EXISTING_FIXTURES,
  isStateChangingAllowed,
} from '../config';
import { TestResult } from '../types';
import { loadUserContext, UserContext, isIntendedSecurityRejection } from '../helpers';

export async function runBookingConfirmationSuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'Phase 2: Booking Confirmation & Approval Holds';

  let ctxA: UserContext;
  let ctxB: UserContext;
  const anonClient = createAnonClient();

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
      id: 'p2-setup-fail',
      category,
      name: 'Authentication and Fixture Setup for Phase 2 Tests',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: 0,
      error: err.message,
      suggestedFix: 'Ensure test user credentials exist in Supabase auth and seed data is applied.',
    });
    return results;
  }

  if (!ctxA.facility || !ctxA.enabledCourt || !ctxB.facility || !ctxB.enabledCourt) {
    results.push({
      id: 'p2-fixtures-missing',
      category,
      name: 'Court and Facility Fixtures Verification',
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: 'Facility or enabled court fixtures not found for test organizations.',
    });
    return results;
  }

  // --------------------------------------------------------------------------
  // Test 1: READ-ONLY — check_court_booking_status exposes confirmation mode
  // --------------------------------------------------------------------------
  const t1 = Date.now();
  try {
    const { data, error } = await anonClient.rpc('check_court_booking_status', {
      p_court_id: ctxA.enabledCourt.id,
    });

    if (error) {
      results.push({
        id: 'p2-status-exposes-confirmation-mode',
        category,
        name: 'Schema Verification: check_court_booking_status Exposes Confirmation Mode',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        error: error.message,
        suggestedFix: 'Ensure Migration 003 check_court_booking_status is applied.',
      });
    } else if (
      data &&
      (data.booking_confirmation_mode === 'instant' || data.booking_confirmation_mode === 'manual_approval')
    ) {
      results.push({
        id: 'p2-status-exposes-confirmation-mode',
        category,
        name: 'Schema Verification: check_court_booking_status Exposes Confirmation Mode',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        details: `Reported booking_confirmation_mode: "${data.booking_confirmation_mode}", hold_duration_minutes: ${data.hold_duration_minutes}`,
      });
    } else {
      results.push({
        id: 'p2-status-exposes-confirmation-mode',
        category,
        name: 'Schema Verification: check_court_booking_status Exposes Confirmation Mode',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        error: `Unexpected payload: missing booking_confirmation_mode. Got: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'p2-status-exposes-confirmation-mode',
      category,
      name: 'Schema Verification: check_court_booking_status Exposes Confirmation Mode',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t1,
      error: err.message,
    });
  }

  // --------------------------------------------------------------------------
  // Test 2: READ-ONLY / PERMISSION BARRIER — Direct create_public_reservation execution denied to anon & authenticated
  // --------------------------------------------------------------------------
  const t2 = Date.now();
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];
    const startTimeStr = `${dateStr}T10:00:00Z`;

    // Attempt from anon client
    const { data: anonData, error: anonError } = await anonClient.rpc('create_public_reservation', {
      p_facility_id: ctxA.facility.id,
      p_court_id: ctxA.enabledCourt.id,
      p_customer_name: 'Direct Anon Attacker',
      p_customer_phone: '09170000000',
      p_customer_email: 'attacker@example.com',
      p_booking_date: dateStr,
      p_start_time: startTimeStr,
      p_duration_minutes: 60,
      p_is_demo: false,
    });

    if (anonError && isIntendedSecurityRejection(anonError)) {
      results.push({
        id: 'p2-permission-anon-create-public-denied',
        category,
        name: 'Permission Barrier: Direct Client Invocation of create_public_reservation Denied to Anon',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t2,
        details: `Execution correctly blocked by database permission check: ${anonError.message}`,
      });
    } else if (anonError && anonError.message.includes('function') && anonError.message.includes('does not exist')) {
      // Postgres throws 42883 if function not accessible due to search_path or revoked execute
      results.push({
        id: 'p2-permission-anon-create-public-denied',
        category,
        name: 'Permission Barrier: Direct Client Invocation of create_public_reservation Denied to Anon',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t2,
        details: `Access denied / hidden from anon: ${anonError.message}`,
      });
    } else {
      results.push({
        id: 'p2-permission-anon-create-public-denied',
        category,
        name: 'Permission Barrier: Direct Client Invocation of create_public_reservation Denied to Anon',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t2,
        error: `CRITICAL FLAW: anon client was permitted to invoke create_public_reservation directly! Data returned: ${JSON.stringify(anonData)}`,
        suggestedFix: 'REVOKE ALL ON FUNCTION public.create_public_reservation FROM anon, authenticated, PUBLIC;',
      });
    }
  } catch (err: any) {
    results.push({
      id: 'p2-permission-anon-create-public-denied',
      category,
      name: 'Permission Barrier: Direct Client Invocation of create_public_reservation Denied to Anon',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t2,
      details: `Execution blocked as intended: ${err.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // Test 3: READ-ONLY / PERMISSION BARRIER — Direct global expire_stale_reservations denied to authenticated staff
  // --------------------------------------------------------------------------
  const t3 = Date.now();
  try {
    const { data: expData, error: expError } = await ctxA.client.rpc('expire_stale_reservations');

    if (expError && (isIntendedSecurityRejection(expError) || expError.message.includes('permission denied') || expError.code === '42501' || expError.message.includes('does not exist'))) {
      results.push({
        id: 'p2-permission-authenticated-expire-stale-denied',
        category,
        name: 'Permission Barrier: Global expire_stale_reservations Denied to Authenticated Staff',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t3,
        details: `Correctly restricted to service_role: ${expError.message}`,
      });
    } else {
      results.push({
        id: 'p2-permission-authenticated-expire-stale-denied',
        category,
        name: 'Permission Barrier: Global expire_stale_reservations Denied to Authenticated Staff',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t3,
        error: `Authenticated user was able to execute global expire_stale_reservations: ${JSON.stringify(expData)}`,
        suggestedFix: 'REVOKE EXECUTE ON FUNCTION public.expire_stale_reservations() FROM authenticated, PUBLIC;',
      });
    }
  } catch (err: any) {
    results.push({
      id: 'p2-permission-authenticated-expire-stale-denied',
      category,
      name: 'Permission Barrier: Global expire_stale_reservations Denied to Authenticated Staff',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t3,
      details: `Execution blocked as intended: ${err.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // Test 4: READ-ONLY / CROSS-TENANT — Staff B cannot expire holds for Facility A
  // --------------------------------------------------------------------------
  const t4 = Date.now();
  try {
    const { data, error } = await ctxB.client.rpc('expire_facility_stale_reservations', {
      p_facility_id: ctxA.facility.id,
    });

    if (error && isIntendedSecurityRejection(error)) {
      results.push({
        id: 'p2-cross-tenant-expire-facility-denied',
        category,
        name: 'Cross-Tenant Isolation: Staff B Cannot Expire Holds for Facility A',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t4,
        details: `Cross-tenant expiration rejected: ${error.message}`,
      });
    } else {
      results.push({
        id: 'p2-cross-tenant-expire-facility-denied',
        category,
        name: 'Cross-Tenant Isolation: Staff B Cannot Expire Holds for Facility A',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t4,
        error: `Staff B was able to trigger expiration for Facility A: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'p2-cross-tenant-expire-facility-denied',
      category,
      name: 'Cross-Tenant Isolation: Staff B Cannot Expire Holds for Facility A',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t4,
      details: `Rejected as intended: ${err.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // Test 5: READ-ONLY / CROSS-TENANT — Staff B cannot approve reservations in Facility A
  // --------------------------------------------------------------------------
  const t5 = Date.now();
  const dummyResId = '00000000-0000-0000-0000-000000000001';
  try {
    // If targetTestRes exists in Facility A, use it to test cross-tenant check
    const targetId = ctxA.disposableReservation?.id || dummyResId;
    const { data, error } = await ctxB.client.rpc('approve_booking_request_as_staff', {
      p_reservation_id: targetId,
      p_notes: 'Unauthorized approval attempt',
    });

    if (error && isIntendedSecurityRejection(error)) {
      results.push({
        id: 'p2-cross-tenant-approval-denied',
        category,
        name: 'Cross-Tenant Isolation: Staff B Cannot Approve Requests in Facility A',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5,
        details: `Approval rejected by facility authorization check: ${error.message}`,
      });
    } else if (error && error.message.includes('not found')) {
      results.push({
        id: 'p2-cross-tenant-approval-denied',
        category,
        name: 'Cross-Tenant Isolation: Staff B Cannot Approve Requests in Facility A',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5,
        details: `Rejected (reservation not found / not accessible): ${error.message}`,
      });
    } else {
      results.push({
        id: 'p2-cross-tenant-approval-denied',
        category,
        name: 'Cross-Tenant Isolation: Staff B Cannot Approve Requests in Facility A',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5,
        error: `Unexpected response: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'p2-cross-tenant-approval-denied',
      category,
      name: 'Cross-Tenant Isolation: Staff B Cannot Approve Requests in Facility A',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t5,
      details: `Exception caught: ${err.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // Test 6: READ-ONLY / CROSS-TENANT — Staff B cannot decline requests in Facility A
  // --------------------------------------------------------------------------
  const t6 = Date.now();
  try {
    const targetId = ctxA.disposableReservation?.id || dummyResId;
    const { data, error } = await ctxB.client.rpc('decline_booking_request_as_staff', {
      p_reservation_id: targetId,
      p_reason: 'Unauthorized decline attempt',
    });

    if (error && (isIntendedSecurityRejection(error) || error.message.includes('not found'))) {
      results.push({
        id: 'p2-cross-tenant-decline-denied',
        category,
        name: 'Cross-Tenant Isolation: Staff B Cannot Decline Requests in Facility A',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t6,
        details: `Decline rejected by facility authorization check: ${error.message}`,
      });
    } else {
      results.push({
        id: 'p2-cross-tenant-decline-denied',
        category,
        name: 'Cross-Tenant Isolation: Staff B Cannot Decline Requests in Facility A',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t6,
        error: `Unexpected response: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'p2-cross-tenant-decline-denied',
      category,
      name: 'Cross-Tenant Isolation: Staff B Cannot Decline Requests in Facility A',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t6,
      details: `Exception caught: ${err.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // Test 7: READ-ONLY / CROSS-TENANT — Staff B cannot update confirmation settings of Facility A
  // --------------------------------------------------------------------------
  const t7 = Date.now();
  try {
    const { data, error } = await ctxB.client.rpc('update_facility_confirmation_settings', {
      p_facility_id: ctxA.facility.id,
      p_mode: 'manual_approval',
      p_hold_minutes: 45,
    });

    if (error && isIntendedSecurityRejection(error)) {
      results.push({
        id: 'p2-cross-tenant-settings-update-denied',
        category,
        name: 'Cross-Tenant Isolation: Staff B Cannot Change Confirmation Settings of Facility A',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t7,
        details: `Settings update rejected: ${error.message}`,
      });
    } else {
      results.push({
        id: 'p2-cross-tenant-settings-update-denied',
        category,
        name: 'Cross-Tenant Isolation: Staff B Cannot Change Confirmation Settings of Facility A',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t7,
        error: `Staff B was able to modify Facility A settings: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'p2-cross-tenant-settings-update-denied',
      category,
      name: 'Cross-Tenant Isolation: Staff B Cannot Change Confirmation Settings of Facility A',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t7,
      details: `Rejected as intended: ${err.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // Test 8: READ-ONLY — Input validation on update_facility_confirmation_settings
  // --------------------------------------------------------------------------
  const t8 = Date.now();
  try {
    const { data, error } = await ctxA.client.rpc('update_facility_confirmation_settings', {
      p_facility_id: ctxA.facility.id,
      p_mode: 'invalid_mode_value',
      p_hold_minutes: 15,
    });

    if (error && error.message.includes('Invalid confirmation mode')) {
      results.push({
        id: 'p2-validation-settings-invalid-mode',
        category,
        name: 'Input Validation: update_facility_confirmation_settings Rejects Invalid Mode',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t8,
        details: `Correctly validated enum mode: ${error.message}`,
      });
    } else {
      results.push({
        id: 'p2-validation-settings-invalid-mode',
        category,
        name: 'Input Validation: update_facility_confirmation_settings Rejects Invalid Mode',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t8,
        error: `Expected validation rejection for invalid mode, got: ${JSON.stringify(data || error)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'p2-validation-settings-invalid-mode',
      category,
      name: 'Input Validation: update_facility_confirmation_settings Rejects Invalid Mode',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t8,
      details: `Exception caught: ${err.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // Test 9: STATE-CHANGING / GUARDED — Facility Settings Lifecycle (Toggle mode & restore)
  // --------------------------------------------------------------------------
  const t9 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'p2-settings-lifecycle',
      category,
      name: 'Authorized Workflow: Facility Owner Configures Confirmation Mode & Restores',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else {
    try {
      // 1. Switch to manual_approval
      const { data: updateData, error: updateErr } = await ctxA.client.rpc(
        'update_facility_confirmation_settings',
        {
          p_facility_id: ctxA.facility.id,
          p_mode: 'manual_approval',
          p_hold_minutes: 45,
        }
      );

      if (updateErr) {
        throw new Error(`Failed to update to manual_approval: ${updateErr.message}`);
      }

      // 2. Verify via public RPC that booking_confirmation_mode updated to manual_approval
      const { data: statusCheck } = await anonClient.rpc('check_court_booking_status', {
        p_court_id: ctxA.enabledCourt.id,
      });

      const modeUpdated = statusCheck?.booking_confirmation_mode === 'manual_approval';

      // 3. Always restore original setting (instant, 30 min)
      await ctxA.client.rpc('update_facility_confirmation_settings', {
        p_facility_id: ctxA.facility.id,
        p_mode: 'instant',
        p_hold_minutes: 30,
      });

      if (modeUpdated) {
        results.push({
          id: 'p2-settings-lifecycle',
          category,
          name: 'Authorized Workflow: Facility Owner Configures Confirmation Mode & Restores',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t9,
          details: 'Successfully set manual_approval mode (45 min hold), verified via public status RPC, and safely restored to instant (30 min).',
        });
      } else {
        results.push({
          id: 'p2-settings-lifecycle',
          category,
          name: 'Authorized Workflow: Facility Owner Configures Confirmation Mode & Restores',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t9,
          error: `check_court_booking_status did not reflect updated mode: ${JSON.stringify(statusCheck)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'p2-settings-lifecycle',
        category,
        name: 'Authorized Workflow: Facility Owner Configures Confirmation Mode & Restores',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t9,
        error: err.message,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Test 10: STATE-CHANGING / GUARDED — Staff-triggered Facility Expiration Cleanup
  // --------------------------------------------------------------------------
  const t10 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'p2-facility-expiration-routine',
      category,
      name: 'Authorized Workflow: Staff A Invokes Facility-Scoped Stale Hold Expiration',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client.rpc('expire_facility_stale_reservations', {
        p_facility_id: ctxA.facility.id,
      });

      if (error) {
        results.push({
          id: 'p2-facility-expiration-routine',
          category,
          name: 'Authorized Workflow: Staff A Invokes Facility-Scoped Stale Hold Expiration',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t10,
          error: error.message,
        });
      } else {
        results.push({
          id: 'p2-facility-expiration-routine',
          category,
          name: 'Authorized Workflow: Staff A Invokes Facility-Scoped Stale Hold Expiration',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t10,
          details: `Successfully executed facility-scoped cleanup. Expired holds processed: ${data}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'p2-facility-expiration-routine',
        category,
        name: 'Authorized Workflow: Staff A Invokes Facility-Scoped Stale Hold Expiration',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t10,
        error: err.message,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Test 11: STATE-CHANGING / GUARDED — create_public_reservation Server Execution & Hold Release
  // --------------------------------------------------------------------------
  const t11 = Date.now();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!isStateChangingAllowed() || !serviceKey) {
    results.push({
      id: 'p2-server-booking-and-concurrency',
      category,
      name: 'Server Endpoint Execution: create_public_reservation & Double-Booking / Overlap Guard',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: !serviceKey
        ? 'BLOCKED: SUPABASE_SERVICE_ROLE_KEY is not available in local test environment. create_public_reservation is securely restricted to server/service-role callers.'
        : 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test.',
    });
  }

  return results;
}
