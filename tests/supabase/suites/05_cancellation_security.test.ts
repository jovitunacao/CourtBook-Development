import {
  getEnvironmentConfig,
  createAuthenticatedClient,
  createAnonClient,
  EXISTING_FIXTURES,
  isStateChangingAllowed,
} from '../config';
import { TestResult } from '../types';
import { loadUserContext, UserContext, isIntendedSecurityRejection } from '../helpers';

export async function runCancellationSecuritySuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'Cancellation Security (cancel_reservation_as_staff)';

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
      id: 'cancel-setup-fail',
      category,
      name: 'Authentication and Fixture Setup for Cancellation Tests',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: 0,
      error: err.message,
      suggestedFix: 'Ensure test user credentials exist in Supabase auth and seed data is applied.',
    });
    return results;
  }

  // Safety safeguard: strictly use designated disposable test fixtures (TD-CONF-001 / TD-CMPL-001)
  const disposableRes = ctxA.disposableReservation;
  const completedRes = ctxA.disposableCompletedReservation;

  // Test 1: Cross-tenant cancellation prevention [STATE-CHANGING REQUEST GUARDED]
  const t1 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'cancel-cross-tenant-blocked',
      category,
      name: "Cross-Tenant Protection: User B Cannot Cancel User A's Reservation",
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of cancellation tests.',
    });
  } else if (!disposableRes) {
    results.push({
      id: 'cancel-cross-tenant-blocked',
      category,
      name: "Cross-Tenant Protection: User B Cannot Cancel User A's Reservation",
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No designated disposable reservation (TD-%) in Facility A. Real customer records are guarded.',
      suggestedFix: 'Execute tests/supabase/seed-test-data.sql.',
    });
  } else {
    try {
      const { data, error } = await ctxB.client.rpc('cancel_reservation_as_staff', {
        p_reservation_id: disposableRes.id,
        p_reason: 'Malicious cancellation by User B',
      });

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'cancel-cross-tenant-blocked',
            category,
            name: "Cross-Tenant Protection: User B Cannot Cancel User A's Reservation",
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t1,
            details: `Cross-tenant cancellation rejected as expected: ${error.message}`,
          });
        } else {
          results.push({
            id: 'cancel-cross-tenant-blocked',
            category,
            name: "Cross-Tenant Protection: User B Cannot Cancel User A's Reservation",
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t1,
            error: error.message,
          });
        }
      } else {
        results.push({
          id: 'cancel-cross-tenant-blocked',
          category,
          name: "Cross-Tenant Protection: User B Cannot Cancel User A's Reservation",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          error: "CRITICAL VULNERABILITY: User B was able to cancel User A's facility reservation!",
          suggestedFix: 'Ensure cancel_reservation_as_staff checks is_facility_staff(v_res.facility_id).',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'cancel-cross-tenant-blocked',
          category,
          name: "Cross-Tenant Protection: User B Cannot Cancel User A's Reservation",
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          details: `Exception caught: ${err.message}`,
        });
      } else {
        results.push({
          id: 'cancel-cross-tenant-blocked',
          category,
          name: "Cross-Tenant Protection: User B Cannot Cancel User A's Reservation",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          error: err.message,
        });
      }
    }
  }

  // Test 2: Unauthenticated / Anon client cannot invoke cancel_reservation_as_staff [STATE-CHANGING REQUEST GUARDED]
  const t2 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'cancel-anon-rejected',
      category,
      name: 'Authorization Barrier: Anonymous Invocation of cancel_reservation_as_staff Is Denied',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of cancellation tests.',
    });
  } else {
    try {
      const anonClient = createAnonClient();
      const { data, error } = await anonClient.rpc('cancel_reservation_as_staff', {
        p_reservation_id: disposableRes?.id || '00000000-0000-0000-0000-000000000001',
        p_reason: 'Anonymous cancel attempt',
      });

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'cancel-anon-rejected',
            category,
            name: 'Authorization Barrier: Anonymous Invocation of cancel_reservation_as_staff Is Denied',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t2,
            details: `Anonymous execution blocked: ${error.message}`,
          });
        } else {
          results.push({
            id: 'cancel-anon-rejected',
            category,
            name: 'Authorization Barrier: Anonymous Invocation of cancel_reservation_as_staff Is Denied',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t2,
            error: error.message,
          });
        }
      } else {
        results.push({
          id: 'cancel-anon-rejected',
          category,
          name: 'Authorization Barrier: Anonymous Invocation of cancel_reservation_as_staff Is Denied',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          error: 'CRITICAL: Anonymous client successfully invoked cancel_reservation_as_staff!',
          suggestedFix: 'Ensure REVOKE ALL ON FUNCTION cancel_reservation_as_staff FROM anon, PUBLIC.',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'cancel-anon-rejected',
          category,
          name: 'Authorization Barrier: Anonymous Invocation of cancel_reservation_as_staff Is Denied',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          details: `Execution denied: ${err.message}`,
        });
      } else {
        results.push({
          id: 'cancel-anon-rejected',
          category,
          name: 'Authorization Barrier: Anonymous Invocation of cancel_reservation_as_staff Is Denied',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          error: err.message,
        });
      }
    }
  }

  // Test 3: Reject NULL parameters in cancel_reservation_as_staff [STATE-CHANGING REQUEST GUARDED]
  const t3 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'cancel-null-id-rejected',
      category,
      name: 'Input Validation: cancel_reservation_as_staff Rejects NULL Reservation ID',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of validation tests.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client.rpc('cancel_reservation_as_staff', {
        p_reservation_id: null,
        p_reason: 'Testing NULL ID validation',
      });

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'cancel-null-id-rejected',
            category,
            name: 'Input Validation: cancel_reservation_as_staff Rejects NULL Reservation ID',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3,
            details: `NULL ID correctly rejected: ${error.message}`,
          });
        } else {
          results.push({
            id: 'cancel-null-id-rejected',
            category,
            name: 'Input Validation: cancel_reservation_as_staff Rejects NULL Reservation ID',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3,
            error: error.message,
          });
        }
      } else {
        results.push({
          id: 'cancel-null-id-rejected',
          category,
          name: 'Input Validation: cancel_reservation_as_staff Rejects NULL Reservation ID',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          error: 'cancel_reservation_as_staff did not reject NULL reservation ID.',
          suggestedFix: 'Add IF p_reservation_id IS NULL THEN RAISE EXCEPTION validation check.',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'cancel-null-id-rejected',
          category,
          name: 'Input Validation: cancel_reservation_as_staff Rejects NULL Reservation ID',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          details: `Exception caught: ${err.message}`,
        });
      } else {
        results.push({
          id: 'cancel-null-id-rejected',
          category,
          name: 'Input Validation: cancel_reservation_as_staff Rejects NULL Reservation ID',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          error: err.message,
        });
      }
    }
  }

  // Test 4: Cannot cancel a completed reservation [STATE-CHANGING REQUEST GUARDED]
  const t4 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'cancel-completed-rejected',
      category,
      name: 'State Machine: Cannot Cancel Completed Reservation',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test.',
    });
  } else if (!completedRes) {
    results.push({
      id: 'cancel-completed-rejected',
      category,
      name: 'State Machine: Cannot Cancel Completed Reservation',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No designated completed reservation fixture found in Facility A.',
      suggestedFix: 'seed-test-data.sql includes a sample completed booking.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client.rpc('cancel_reservation_as_staff', {
        p_reservation_id: completedRes.id,
        p_reason: 'Trying to cancel completed match',
      });

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'cancel-completed-rejected',
            category,
            name: 'State Machine: Cannot Cancel Completed Reservation',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t4,
            details: `Cancellation of completed booking rejected: ${error.message}`,
          });
        } else {
          results.push({
            id: 'cancel-completed-rejected',
            category,
            name: 'State Machine: Cannot Cancel Completed Reservation',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t4,
            error: error.message,
          });
        }
      } else {
        results.push({
          id: 'cancel-completed-rejected',
          category,
          name: 'State Machine: Cannot Cancel Completed Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4,
          error: 'VULNERABILITY: Completed reservation was allowed to be cancelled!',
          suggestedFix: "Ensure cancel_reservation_as_staff checks v_res.status != 'completed'.",
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'cancel-completed-rejected',
          category,
          name: 'State Machine: Cannot Cancel Completed Reservation',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4,
          details: `Exception caught: ${err.message}`,
        });
      } else {
        results.push({
          id: 'cancel-completed-rejected',
          category,
          name: 'State Machine: Cannot Cancel Completed Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4,
          error: err.message,
        });
      }
    }
  }

  // Test 5: Authorized staff cancellation on designated disposable fixture [STATE-CHANGING]
  const t5 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'cancel-authorized-success',
      category,
      name: 'Authorized Workflow: Staff A Cancels Designated Disposable Test Reservation',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test blocked: Set CONFIRM_TEST_ENV=true in .env.test to allow safe state changes on designated test fixtures.',
      suggestedFix: 'Set CONFIRM_TEST_ENV=true in .env.test.',
    });
  } else if (!disposableRes) {
    results.push({
      id: 'cancel-authorized-success',
      category,
      name: 'Authorized Workflow: Staff A Cancels Designated Disposable Test Reservation',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'Designated disposable reservation (TD-CONF-001) is missing or was already cancelled on a previous run. The cancellation lifecycle is irreversible per the database state machine. Re-run tests/supabase/seed-test-data.sql to re-seed fresh disposable test fixtures.',
      suggestedFix: 'Re-run tests/supabase/seed-test-data.sql in the Supabase SQL editor.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client.rpc('cancel_reservation_as_staff', {
        p_reservation_id: disposableRes.id,
        p_reason: 'Legitimate customer cancellation test on designated fixture',
      });

      if (error) {
        results.push({
          id: 'cancel-authorized-success',
          category,
          name: 'Authorized Workflow: Staff A Cancels Designated Disposable Test Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5,
          error: error.message,
          suggestedFix: 'Verify staff permissions and search path in cancel_reservation_as_staff.',
        });
      } else {
        results.push({
          id: 'cancel-authorized-success',
          category,
          name: 'Authorized Workflow: Staff A Cancels Designated Disposable Test Reservation',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5,
          details: `Successfully cancelled test reservation [${disposableRes.reference_code}].`,
        });

        // Test 6: Terminal State Guard - Cannot re-cancel an already cancelled reservation
        const t6 = Date.now();
        const { error: reCancelError } = await ctxA.client.rpc('cancel_reservation_as_staff', {
          p_reservation_id: disposableRes.id,
          p_reason: 'Second cancellation attempt',
        });

        if (reCancelError && isIntendedSecurityRejection(reCancelError)) {
          results.push({
            id: 'cancel-already-cancelled',
            category,
            name: 'Terminal State: Cannot Re-Cancel an Already Cancelled Reservation',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t6,
            details: `Re-cancellation rejected: ${reCancelError.message}`,
          });
        } else {
          results.push({
            id: 'cancel-already-cancelled',
            category,
            name: 'Terminal State: Cannot Re-Cancel an Already Cancelled Reservation',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t6,
            error: 'VULNERABILITY: Allowed cancelling an already cancelled reservation.',
            suggestedFix: "Ensure IF v_res.status = 'cancelled' THEN RAISE EXCEPTION is checked.",
          });
        }
      }
    } catch (err: any) {
      results.push({
        id: 'cancel-authorized-success',
        category,
        name: 'Authorized Workflow: Staff A Cancels Designated Disposable Test Reservation',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t5,
        error: err.message,
      });
    }
  }

  return results;
}
