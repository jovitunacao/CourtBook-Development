import {
  getEnvironmentConfig,
  createAuthenticatedClient,
  createAnonClient,
  EXISTING_FIXTURES,
  isStateChangingAllowed,
} from '../config';
import { TestResult } from '../types';
import { loadUserContext, UserContext, isIntendedSecurityRejection } from '../helpers';

export async function runReschedulingSecuritySuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'Rescheduling Security (reschedule_reservation_as_staff)';

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
      id: 'reschedule-setup-fail',
      category,
      name: 'Authentication and Fixture Setup for Rescheduling Tests',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: 0,
      error: err.message,
      suggestedFix: 'Ensure test user credentials exist in Supabase auth and seed data is applied.',
    });
    return results;
  }

  // Safety safeguard: strictly use designated disposable test fixtures (TD-CONF-001)
  const disposableRes = ctxA.disposableReservation;

  // Test 1: Cross-tenant rescheduling blocked [STATE-CHANGING REQUEST GUARDED]
  const t1 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'reschedule-cross-tenant-blocked',
      category,
      name: "Cross-Tenant Protection: User B Cannot Reschedule User A's Reservation",
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test.',
    });
  } else if (!disposableRes || !ctxA.enabledCourt) {
    results.push({
      id: 'reschedule-cross-tenant-blocked',
      category,
      name: "Cross-Tenant Protection: User B Cannot Reschedule User A's Reservation",
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'Designated disposable reservation (TD-CONF-001) or court fixture missing in Facility A.',
      suggestedFix: 'Execute tests/supabase/seed-test-data.sql.',
    });
  } else {
    try {
      const { data, error } = await ctxB.client.rpc('reschedule_reservation_as_staff', {
        p_reservation_id: disposableRes.id,
        p_new_court_id: ctxA.enabledCourt.id,
        p_new_date: '2026-12-01',
        p_new_start_time: '2026-12-01T02:00:00Z',
        p_new_duration_minutes: 60,
      });

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'reschedule-cross-tenant-blocked',
            category,
            name: "Cross-Tenant Protection: User B Cannot Reschedule User A's Reservation",
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t1,
            details: `Cross-tenant reschedule rejected: ${error.message}`,
          });
        } else {
          results.push({
            id: 'reschedule-cross-tenant-blocked',
            category,
            name: "Cross-Tenant Protection: User B Cannot Reschedule User A's Reservation",
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t1,
            error: error.message,
          });
        }
      } else {
        results.push({
          id: 'reschedule-cross-tenant-blocked',
          category,
          name: "Cross-Tenant Protection: User B Cannot Reschedule User A's Reservation",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          error: "CRITICAL SECURITY VULNERABILITY: User B was able to reschedule User A's reservation!",
          suggestedFix: 'Ensure reschedule_reservation_as_staff validates is_facility_staff(v_res.facility_id).',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'reschedule-cross-tenant-blocked',
          category,
          name: "Cross-Tenant Protection: User B Cannot Reschedule User A's Reservation",
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          details: `Exception caught: ${err.message}`,
        });
      } else {
        results.push({
          id: 'reschedule-cross-tenant-blocked',
          category,
          name: "Cross-Tenant Protection: User B Cannot Reschedule User A's Reservation",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          error: err.message,
        });
      }
    }
  }

  // Test 2: Cannot reschedule to a court belonging to another facility [STATE-CHANGING REQUEST GUARDED]
  const t2 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'reschedule-cross-court-blocked',
      category,
      name: 'Boundary Check: Cannot Reschedule Reservation to Another Facility Court',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test.',
    });
  } else if (!disposableRes || ctxB.courts.length === 0) {
    results.push({
      id: 'reschedule-cross-court-blocked',
      category,
      name: 'Boundary Check: Cannot Reschedule Reservation to Another Facility Court',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'User B court fixture missing in courtbook-badminton-test.',
    });
  } else {
    try {
      const foreignCourt = ctxB.courts[0];
      const { data, error } = await ctxA.client.rpc('reschedule_reservation_as_staff', {
        p_reservation_id: disposableRes.id,
        p_new_court_id: foreignCourt.id,
        p_new_date: '2026-12-01',
        p_new_start_time: '2026-12-01T02:00:00Z',
        p_new_duration_minutes: 60,
      });

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'reschedule-cross-court-blocked',
            category,
            name: 'Boundary Check: Cannot Reschedule Reservation to Another Facility Court',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t2,
            details: `Cross-facility court reschedule rejected: ${error.message}`,
          });
        } else {
          results.push({
            id: 'reschedule-cross-court-blocked',
            category,
            name: 'Boundary Check: Cannot Reschedule Reservation to Another Facility Court',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t2,
            error: error.message,
          });
        }
      } else {
        results.push({
          id: 'reschedule-cross-court-blocked',
          category,
          name: 'Boundary Check: Cannot Reschedule Reservation to Another Facility Court',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          error: 'VULNERABILITY: Reservation was moved to a court in a completely different facility!',
          suggestedFix: 'Ensure reschedule_reservation_as_staff checks v_court.facility_id != v_res.facility_id.',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'reschedule-cross-court-blocked',
          category,
          name: 'Boundary Check: Cannot Reschedule Reservation to Another Facility Court',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          details: `Exception caught: ${err.message}`,
        });
      } else {
        results.push({
          id: 'reschedule-cross-court-blocked',
          category,
          name: 'Boundary Check: Cannot Reschedule Reservation to Another Facility Court',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          error: err.message,
        });
      }
    }
  }

  // Test 3: Cannot reschedule outside facility operating hours [STATE-CHANGING REQUEST GUARDED]
  const t3 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'reschedule-operating-hours-rejected',
      category,
      name: 'Business Rules: Cannot Reschedule Outside Facility Operating Hours',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test.',
    });
  } else if (!disposableRes || !ctxA.enabledCourt) {
    results.push({
      id: 'reschedule-operating-hours-rejected',
      category,
      name: 'Business Rules: Cannot Reschedule Outside Facility Operating Hours',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'Disposable reservation fixture missing.',
    });
  } else {
    try {
      const outOfBoundsDate = '2026-12-03';
      const outOfBoundsStart = '2026-12-02T19:00:00Z'; // 03:00 AM Manila local time

      const { data, error } = await ctxA.client.rpc('reschedule_reservation_as_staff', {
        p_reservation_id: disposableRes.id,
        p_new_court_id: ctxA.enabledCourt.id,
        p_new_date: outOfBoundsDate,
        p_new_start_time: outOfBoundsStart,
        p_new_duration_minutes: 60,
      });

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'reschedule-operating-hours-rejected',
            category,
            name: 'Business Rules: Cannot Reschedule Outside Facility Operating Hours',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3,
            details: `Out-of-bounds schedule rejected: ${error.message}`,
          });
        } else {
          results.push({
            id: 'reschedule-operating-hours-rejected',
            category,
            name: 'Business Rules: Cannot Reschedule Outside Facility Operating Hours',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3,
            error: error.message,
          });
        }
      } else {
        results.push({
          id: 'reschedule-operating-hours-rejected',
          category,
          name: 'Business Rules: Cannot Reschedule Outside Facility Operating Hours',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          error: 'VULNERABILITY: Booking was rescheduled to 3:00 AM outside operating hours!',
          suggestedFix: 'Ensure reschedule_reservation_as_staff validates operating hours in facility local time.',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'reschedule-operating-hours-rejected',
          category,
          name: 'Business Rules: Cannot Reschedule Outside Facility Operating Hours',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          details: `Exception caught: ${err.message}`,
        });
      } else {
        results.push({
          id: 'reschedule-operating-hours-rejected',
          category,
          name: 'Business Rules: Cannot Reschedule Outside Facility Operating Hours',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          error: err.message,
        });
      }
    }
  }

  // Test 4: Cannot reschedule to a past timestamp [STATE-CHANGING REQUEST GUARDED]
  const t4 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'reschedule-past-rejected',
      category,
      name: 'Temporal Integrity: Cannot Reschedule to a Past Timestamp',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test.',
    });
  } else if (!disposableRes || !ctxA.enabledCourt) {
    results.push({
      id: 'reschedule-past-rejected',
      category,
      name: 'Temporal Integrity: Cannot Reschedule to a Past Timestamp',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'Disposable reservation fixture missing.',
    });
  } else {
    try {
      const pastDate = '2020-01-01';
      const pastStart = '2020-01-01T02:00:00Z';

      const { data, error } = await ctxA.client.rpc('reschedule_reservation_as_staff', {
        p_reservation_id: disposableRes.id,
        p_new_court_id: ctxA.enabledCourt.id,
        p_new_date: pastDate,
        p_new_start_time: pastStart,
        p_new_duration_minutes: 60,
      });

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'reschedule-past-rejected',
            category,
            name: 'Temporal Integrity: Cannot Reschedule to a Past Timestamp',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t4,
            details: `Past booking rejected: ${error.message}`,
          });
        } else {
          results.push({
            id: 'reschedule-past-rejected',
            category,
            name: 'Temporal Integrity: Cannot Reschedule to a Past Timestamp',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t4,
            error: error.message,
          });
        }
      } else {
        results.push({
          id: 'reschedule-past-rejected',
          category,
          name: 'Temporal Integrity: Cannot Reschedule to a Past Timestamp',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4,
          error: 'VULNERABILITY: Booking was rescheduled to past year 2020!',
          suggestedFix: 'Ensure reschedule_reservation_as_staff validates IF p_new_start_time <= now().',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'reschedule-past-rejected',
          category,
          name: 'Temporal Integrity: Cannot Reschedule to a Past Timestamp',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4,
          details: `Exception caught: ${err.message}`,
        });
      } else {
        results.push({
          id: 'reschedule-past-rejected',
          category,
          name: 'Temporal Integrity: Cannot Reschedule to a Past Timestamp',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4,
          error: err.message,
        });
      }
    }
  }

  // Test 5: Positive Rescheduling on Designated Fixture with Checked Restoration [STATE-CHANGING]
  const t5 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'reschedule-positive-lifecycle-rollback',
      category,
      name: 'Authorized Workflow: Staff A Reschedules and Restores Disposable Test Booking',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test blocked: Set CONFIRM_TEST_ENV=true in .env.test to allow safe state changes on designated test fixtures.',
      suggestedFix: 'Set CONFIRM_TEST_ENV=true in .env.test.',
    });
  } else if (!disposableRes || !ctxA.enabledCourt) {
    results.push({
      id: 'reschedule-positive-lifecycle-rollback',
      category,
      name: 'Authorized Workflow: Staff A Reschedules and Restores Disposable Test Booking',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'Confirmed disposable reservation fixture (TD-CONF-001) missing in Facility A.',
      suggestedFix: 'Re-run tests/supabase/seed-test-data.sql.',
    });
  } else {
    const originalDate = disposableRes.booking_date;
    const originalStart = disposableRes.start_time;
    const originalCourtId = disposableRes.court_id;

    // Target a slot 21 days in the future at 10:00 AM Manila (02:00 UTC)
    const targetDate = '2026-12-21';
    const targetStart = '2026-12-21T02:00:00Z';

    try {
      const { data, error } = await ctxA.client.rpc('reschedule_reservation_as_staff', {
        p_reservation_id: disposableRes.id,
        p_new_court_id: ctxA.enabledCourt.id,
        p_new_date: targetDate,
        p_new_start_time: targetStart,
        p_new_duration_minutes: 60,
      });

      if (error) {
        results.push({
          id: 'reschedule-positive-lifecycle-rollback',
          category,
          name: 'Authorized Workflow: Staff A Reschedules and Restores Disposable Test Booking',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5,
          error: `Authorized rescheduling failed: ${error.message}`,
        });
      } else {
        // Issue 3: Must not assume restoration succeeds. Check restoration result explicitly!
        const { error: restoreErr } = await ctxA.client.rpc('reschedule_reservation_as_staff', {
          p_reservation_id: disposableRes.id,
          p_new_court_id: originalCourtId,
          p_new_date: originalDate,
          p_new_start_time: originalStart,
          p_new_duration_minutes: 60,
        });

        if (restoreErr) {
          results.push({
            id: 'reschedule-positive-lifecycle-rollback',
            category,
            name: 'Authorized Workflow: Staff A Reschedules and Restores Disposable Test Booking',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t5,
            error: `Rescheduling succeeded, but restoration cleanup failed: ${restoreErr.message}`,
            suggestedFix: 'Check facility hours or lock contention during slot restoration.',
          });
        } else {
          results.push({
            id: 'reschedule-positive-lifecycle-rollback',
            category,
            name: 'Authorized Workflow: Staff A Reschedules and Restores Disposable Test Booking',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t5,
            details: `Successfully rescheduled test booking [${disposableRes.reference_code}] to ${targetDate} and confirmed successful restoration back to original slot.`,
          });
        }
      }
    } catch (err: any) {
      results.push({
        id: 'reschedule-positive-lifecycle-rollback',
        category,
        name: 'Authorized Workflow: Staff A Reschedules and Restores Disposable Test Booking',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t5,
        error: err.message,
      });
    }
  }

  return results;
}
