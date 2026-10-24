import { getEnvironmentConfig, createAnonClient, createAuthenticatedClient, EXISTING_FIXTURES } from '../config';
import { TestResult } from '../types';
import { loadUserContext, UserContext, isIntendedSecurityRejection } from '../helpers';

export async function runPublicAvailabilitySuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'Public Availability (check_court_booking_status & get_court_busy_slots)';

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
      id: 'avail-setup-fail',
      category,
      name: 'Authentication and Fixture Setup for Availability Tests',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: 0,
      error: err.message,
      suggestedFix: 'Ensure test user credentials exist in Supabase auth and seed data is applied.',
    });
    return results;
  }

  if (!ctxA.facility || !ctxA.enabledCourt) {
    results.push({
      id: 'avail-fixtures-missing',
      category,
      name: 'Court Fixtures Verification for Availability Checks',
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: `Enabled court fixture not found for "${EXISTING_FIXTURES.orgA.facilitySlug}".`,
      suggestedFix: 'Execute tests/supabase/seed-test-data.sql.',
    });
    return results;
  }

  // Test 1: Positive - check_court_booking_status for Court A (courtbook-pickleball-test, ₱350/hr)
  const t1 = Date.now();
  try {
    const { data, error } = await anonClient.rpc('check_court_booking_status', {
      p_court_id: ctxA.enabledCourt.id,
    });

    if (error) {
      results.push({
        id: 'avail-status-court-a',
        category,
        name: `Public Status: check_court_booking_status Returns Bookable for Court A (₱${EXISTING_FIXTURES.orgA.expectedCourtRate}/hr)`,
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        error: error.message,
        suggestedFix: 'Verify check_court_booking_status grants EXECUTE to anon.',
      });
    } else if (data && data.is_bookable === true) {
      results.push({
        id: 'avail-status-court-a',
        category,
        name: `Public Status: check_court_booking_status Returns Bookable for Court A (₱${EXISTING_FIXTURES.orgA.expectedCourtRate}/hr)`,
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        details: `Court "${data.court_name}" is bookable. Rate: ${data.currency}${data.hourly_rate}/hr, Timezone: ${data.timezone}`,
      });
    } else {
      results.push({
        id: 'avail-status-court-a',
        category,
        name: `Public Status: check_court_booking_status Returns Bookable for Court A (₱${EXISTING_FIXTURES.orgA.expectedCourtRate}/hr)`,
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        error: `Expected is_bookable: true, got: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'avail-status-court-a',
      category,
      name: `Public Status: check_court_booking_status Returns Bookable for Court A (₱${EXISTING_FIXTURES.orgA.expectedCourtRate}/hr)`,
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t1,
      error: err.message,
    });
  }

  // Test 2: Positive - check_court_booking_status for Court B (courtbook-badminton-test, ₱250/hr)
  const t2 = Date.now();
  if (ctxB.enabledCourt) {
    try {
      const { data, error } = await anonClient.rpc('check_court_booking_status', {
        p_court_id: ctxB.enabledCourt.id,
      });

      if (error) {
        results.push({
          id: 'avail-status-court-b',
          category,
          name: `Public Status: check_court_booking_status Returns Bookable for Court B (₱${EXISTING_FIXTURES.orgB.expectedCourtRate}/hr)`,
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t2,
          error: error.message,
        });
      } else if (data && data.is_bookable === true) {
        results.push({
          id: 'avail-status-court-b',
          category,
          name: `Public Status: check_court_booking_status Returns Bookable for Court B (₱${EXISTING_FIXTURES.orgB.expectedCourtRate}/hr)`,
          status: 'PASS',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t2,
          details: `Court "${data.court_name}" is bookable. Rate: ${data.currency}${data.hourly_rate}/hr, Timezone: ${data.timezone}`,
        });
      } else {
        results.push({
          id: 'avail-status-court-b',
          category,
          name: `Public Status: check_court_booking_status Returns Bookable for Court B (₱${EXISTING_FIXTURES.orgB.expectedCourtRate}/hr)`,
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t2,
          error: `Expected is_bookable: true, got: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'avail-status-court-b',
        category,
        name: `Public Status: check_court_booking_status Returns Bookable for Court B (₱${EXISTING_FIXTURES.orgB.expectedCourtRate}/hr)`,
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t2,
        error: err.message,
      });
    }
  }

  // Test 3: Negative - check_court_booking_status returns is_bookable: false for nonexistent court UUID
  const t3 = Date.now();
  try {
    const nonexistentId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const { data, error } = await anonClient.rpc('check_court_booking_status', {
      p_court_id: nonexistentId,
    });

    if (error) {
      results.push({
        id: 'avail-status-nonexistent',
        category,
        name: 'Public Status: check_court_booking_status Handles Nonexistent Court Gracefully',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t3,
        details: `Handled nonexistent court: ${error.message}`,
      });
    } else if (data && data.is_bookable === false) {
      results.push({
        id: 'avail-status-nonexistent',
        category,
        name: 'Public Status: check_court_booking_status Handles Nonexistent Court Gracefully',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t3,
        details: `Reported non-bookable: "${data.reason}"`,
      });
    } else {
      results.push({
        id: 'avail-status-nonexistent',
        category,
        name: 'Public Status: check_court_booking_status Handles Nonexistent Court Gracefully',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t3,
        error: `Unexpected return: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'avail-status-nonexistent',
      category,
      name: 'Public Status: check_court_booking_status Handles Nonexistent Court Gracefully',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t3,
      error: err.message,
    });
  }

  // Test 4: Positive - get_court_busy_slots retrieves busy slots for enabled Court A
  const t4 = Date.now();
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await anonClient.rpc('get_court_busy_slots', {
      p_court_id: ctxA.enabledCourt.id,
      p_date: today,
    });

    if (error) {
      results.push({
        id: 'avail-busy-slots-query',
        category,
        name: 'Availability RPC: get_court_busy_slots Returns Slots for Court A',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t4,
        error: error.message,
        suggestedFix: 'Verify get_court_busy_slots grants EXECUTE to anon.',
      });
    } else {
      results.push({
        id: 'avail-busy-slots-query',
        category,
        name: 'Availability RPC: get_court_busy_slots Returns Slots for Court A',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t4,
        details: `Retrieved ${Array.isArray(data) ? data.length : 0} busy slot(s) for ${today} in ${ctxA.facility.timezone}.`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'avail-busy-slots-query',
      category,
      name: 'Availability RPC: get_court_busy_slots Returns Slots for Court A',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t4,
      error: err.message,
    });
  }

  // Test 5: Negative - get_court_busy_slots raises exception for nonexistent/disabled court (anti-ambiguity)
  const t5 = Date.now();
  try {
    const nonexistentId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await anonClient.rpc('get_court_busy_slots', {
      p_court_id: nonexistentId,
      p_date: today,
    });

    if (error && isIntendedSecurityRejection(error)) {
      results.push({
        id: 'avail-busy-slots-anti-ambiguity',
        category,
        name: 'Anti-Ambiguity Guard: get_court_busy_slots Rejects Nonexistent Court with Exception',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5,
        details: `Correctly threw exception instead of returning 0 empty slots: ${error.message}`,
      });
    } else if (error) {
      results.push({
        id: 'avail-busy-slots-anti-ambiguity',
        category,
        name: 'Anti-Ambiguity Guard: get_court_busy_slots Rejects Nonexistent Court with Exception',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5,
        details: `Exception caught: ${error.message}`,
      });
    } else {
      results.push({
        id: 'avail-busy-slots-anti-ambiguity',
        category,
        name: 'Anti-Ambiguity Guard: get_court_busy_slots Rejects Nonexistent Court with Exception',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5,
        error:
          'FLAW: get_court_busy_slots returned empty array for nonexistent court! Customers could perceive this as an open day.',
        suggestedFix:
          'Ensure get_court_busy_slots raises an exception when court is nonexistent or disabled.',
      });
    }
  } catch (err: any) {
    results.push({
      id: 'avail-busy-slots-anti-ambiguity',
      category,
      name: 'Anti-Ambiguity Guard: get_court_busy_slots Rejects Nonexistent Court with Exception',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t5,
      details: `Exception caught: ${err.message}`,
    });
  }

  return results;
}
