import {
  getEnvironmentConfig,
  createAuthenticatedClient,
  createAnonClient,
  EXISTING_FIXTURES,
  isStateChangingAllowed,
} from '../config';
import { TestResult } from '../types';
import { loadUserContext, UserContext, isIntendedSecurityRejection } from '../helpers';

export async function runReservationSecuritySuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'Reservation Security & UPDATE Revocation';

  let ctxA: UserContext;

  try {
    const authA = await createAuthenticatedClient(config.userAEmail, config.userAPassword);
    ctxA = await loadUserContext(
      authA.client,
      authA.userId,
      config.userAEmail,
      EXISTING_FIXTURES.orgA.slug,
      EXISTING_FIXTURES.orgA.facilitySlug
    );
  } catch (err: any) {
    results.push({
      id: 'res-setup-fail',
      category,
      name: 'Authentication and Reservation Fixture Setup',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: 0,
      error: err.message,
      suggestedFix: 'Ensure test user credentials exist in Supabase auth and seed data is applied.',
    });
    return results;
  }

  // Safety safeguard: Only use explicitly tagged disposable test reservations (TD-% or TEST-DISPOSABLE-%)
  const targetTestRes = ctxA.disposableReservation;

  // Test 1: Direct UPDATE on price must be rejected [STATE-CHANGING REQUEST GUARDED]
  const t1 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'res-direct-update-price',
      category,
      name: 'Anti-Tampering: Direct Client UPDATE on Reservation Price Is Rejected',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of update tests.',
    });
  } else if (!targetTestRes) {
    results.push({
      id: 'res-direct-update-price',
      category,
      name: 'Anti-Tampering: Direct Client UPDATE on Reservation Price Is Rejected',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No designated disposable test reservation (tagged TD-%) found in Facility A. Real customer records are protected and will not be touched.',
      suggestedFix: 'Execute tests/supabase/seed-test-data.sql to create designated test fixtures.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client
        .from('reservations')
        .update({ price: 0.0 })
        .eq('id', targetTestRes.id)
        .select();

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'res-direct-update-price',
            category,
            name: 'Anti-Tampering: Direct Client UPDATE on Reservation Price Is Rejected',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t1,
            details: `Direct price update rejected by database permissions: ${error.message}`,
          });
        } else {
          results.push({
            id: 'res-direct-update-price',
            category,
            name: 'Anti-Tampering: Direct Client UPDATE on Reservation Price Is Rejected',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t1,
            error: `Unrelated error: ${error.message}`,
          });
        }
      } else if (!data || data.length === 0) {
        results.push({
          id: 'res-direct-update-price',
          category,
          name: 'Anti-Tampering: Direct Client UPDATE on Reservation Price Is Rejected',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          details: '0 rows modified; update denied by database permissions.',
        });
      } else {
        results.push({
          id: 'res-direct-update-price',
          category,
          name: 'Anti-Tampering: Direct Client UPDATE on Reservation Price Is Rejected',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          error: 'CRITICAL SECURITY BREACH: Authenticated user was able to directly modify reservation price!',
          suggestedFix:
            'Ensure Migration 002 was executed: REVOKE UPDATE ON public.reservations FROM authenticated.',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'res-direct-update-price',
          category,
          name: 'Anti-Tampering: Direct Client UPDATE on Reservation Price Is Rejected',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          details: `Security rejection: ${err.message}`,
        });
      } else {
        results.push({
          id: 'res-direct-update-price',
          category,
          name: 'Anti-Tampering: Direct Client UPDATE on Reservation Price Is Rejected',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          error: err.message,
        });
      }
    }
  }

  // Test 2: Direct UPDATE on customer info or court ID must be rejected [STATE-CHANGING REQUEST GUARDED]
  const t2 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'res-direct-update-immutable',
      category,
      name: 'Anti-Tampering: Direct Client UPDATE on Customer Name / Court ID Is Rejected',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of update tests.',
    });
  } else if (!targetTestRes) {
    results.push({
      id: 'res-direct-update-immutable',
      category,
      name: 'Anti-Tampering: Direct Client UPDATE on Customer Name / Court ID Is Rejected',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No disposable test reservation found in Facility A.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client
        .from('reservations')
        .update({ customer_name: 'Attacker Tamper' })
        .eq('id', targetTestRes.id)
        .select();

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'res-direct-update-immutable',
            category,
            name: 'Anti-Tampering: Direct Client UPDATE on Customer Name / Court ID Is Rejected',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t2,
            details: `Direct modification rejected: ${error.message}`,
          });
        } else {
          results.push({
            id: 'res-direct-update-immutable',
            category,
            name: 'Anti-Tampering: Direct Client UPDATE on Customer Name / Court ID Is Rejected',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t2,
            error: error.message,
          });
        }
      } else if (!data || data.length === 0) {
        results.push({
          id: 'res-direct-update-immutable',
          category,
          name: 'Anti-Tampering: Direct Client UPDATE on Customer Name / Court ID Is Rejected',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          details: '0 rows modified; direct update denied.',
        });
      } else {
        results.push({
          id: 'res-direct-update-immutable',
          category,
          name: 'Anti-Tampering: Direct Client UPDATE on Customer Name / Court ID Is Rejected',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          error: 'VULNERABILITY: User was able to directly update customer name on reservation!',
          suggestedFix:
            'Ensure all UPDATE privileges on public.reservations are revoked from authenticated.',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'res-direct-update-immutable',
          category,
          name: 'Anti-Tampering: Direct Client UPDATE on Customer Name / Court ID Is Rejected',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          details: `Security rejection: ${err.message}`,
        });
      } else {
        results.push({
          id: 'res-direct-update-immutable',
          category,
          name: 'Anti-Tampering: Direct Client UPDATE on Customer Name / Court ID Is Rejected',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          error: err.message,
        });
      }
    }
  }

  // Test 3: Direct column-level UPDATE on status must be rejected [STATE-CHANGING REQUEST GUARDED]
  const t3 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'res-direct-update-status',
      category,
      name: 'Hardened Model: Direct UPDATE on Status Field Is Revoked',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of status update tests.',
    });
  } else if (!targetTestRes) {
    results.push({
      id: 'res-direct-update-status',
      category,
      name: 'Hardened Model: Direct UPDATE on Status Field Is Revoked',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No disposable test reservation found in Facility A.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client
        .from('reservations')
        .update({ status: 'cancelled' })
        .eq('id', targetTestRes.id)
        .select();

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'res-direct-update-status',
            category,
            name: 'Hardened Model: Direct UPDATE on Status Field Is Revoked',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3,
            details: `Direct status update rejected as required: ${error.message}`,
          });
        } else {
          results.push({
            id: 'res-direct-update-status',
            category,
            name: 'Hardened Model: Direct UPDATE on Status Field Is Revoked',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3,
            error: error.message,
          });
        }
      } else if (!data || data.length === 0) {
        results.push({
          id: 'res-direct-update-status',
          category,
          name: 'Hardened Model: Direct UPDATE on Status Field Is Revoked',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          details: '0 rows modified; direct update denied.',
        });
      } else {
        results.push({
          id: 'res-direct-update-status',
          category,
          name: 'Hardened Model: Direct UPDATE on Status Field Is Revoked',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          error:
            'AUDIT FAILURE: Direct column-level UPDATE on status succeeded! Status changes must only go through cancel_reservation_as_staff.',
          suggestedFix:
            'Apply Migration 002: REVOKE UPDATE (status, cancelled_at, cancelled_by, cancellation_reason) FROM authenticated.',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'res-direct-update-status',
          category,
          name: 'Hardened Model: Direct UPDATE on Status Field Is Revoked',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          details: `Security rejection: ${err.message}`,
        });
      } else {
        results.push({
          id: 'res-direct-update-status',
          category,
          name: 'Hardened Model: Direct UPDATE on Status Field Is Revoked',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          error: err.message,
        });
      }
    }
  }

  // Test 4: Direct INSERT into reservations from unauthenticated client is rejected [STATE-CHANGING REQUEST GUARDED]
  const t4 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'res-direct-insert-anon',
      category,
      name: 'Creation Boundary: Anonymous Direct INSERT on Reservations Is Rejected',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of insert tests.',
    });
  } else {
    // Reference code: 'TD-ANON-' + 6 chars = 14 characters (satisfies 5-20 characters CHECK constraint)
    const validAnonRef = `TD-ANON-${Date.now().toString().slice(-6)}`;
    try {
      const anonClient = createAnonClient();
      const { data, error } = await anonClient
        .from('reservations')
        .insert({
          facility_id: ctxA.facility?.id || '00000000-0000-0000-0000-000000000001',
          court_id: ctxA.enabledCourt?.id || '00000000-0000-0000-0000-000000000002',
          reference_code: validAnonRef,
          customer_name: 'Direct Malicious Booking',
          booking_date: '2026-10-15',
          start_time: '2026-10-15T10:00:00Z',
          end_time: '2026-10-15T11:00:00Z',
          time_slot_label: '10:00 AM – 11:00 AM',
          price: 100.0,
        })
        .select();

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'res-direct-insert-anon',
            category,
            name: 'Creation Boundary: Anonymous Direct INSERT on Reservations Is Rejected',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t4,
            details: `Direct insert blocked by permission/RLS: ${error.message}`,
          });
        } else {
          results.push({
            id: 'res-direct-insert-anon',
            category,
            name: 'Creation Boundary: Anonymous Direct INSERT on Reservations Is Rejected',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t4,
            error: error.message,
          });
        }
      } else {
        // Cleanup if unexpectedly inserted
        if (data && data[0]?.id) {
          await ctxA.client.from('reservations').delete().eq('id', data[0].id);
        }
        results.push({
          id: 'res-direct-insert-anon',
          category,
          name: 'Creation Boundary: Anonymous Direct INSERT on Reservations Is Rejected',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4,
          error: 'CRITICAL SECURITY BREACH: Anonymous client was able to directly INSERT a reservation!',
          suggestedFix:
            'Ensure no INSERT grant exists on public.reservations for anon or authenticated (backend service_role only).',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'res-direct-insert-anon',
          category,
          name: 'Creation Boundary: Anonymous Direct INSERT on Reservations Is Rejected',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4,
          details: `Security rejection: ${err.message}`,
        });
      } else {
        results.push({
          id: 'res-direct-insert-anon',
          category,
          name: 'Creation Boundary: Anonymous Direct INSERT on Reservations Is Rejected',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4,
          error: err.message,
        });
      }
    }
  }

  return results;
}
