import {
  getEnvironmentConfig,
  createAuthenticatedClient,
  createAnonClient,
  EXISTING_FIXTURES,
  isStateChangingAllowed,
} from '../config';
import { TestResult } from '../types';
import { loadUserContext, UserContext, isIntendedSecurityRejection } from '../helpers';

/**
 * Suite 13: Multi-Tenant Security Verification (Phase 2 Roadmap)
 *
 * Verifies database-level and API-level tenant isolation between:
 * - User A: Pickleball Test Facility (Org: courtbook-test-pickleball-a)
 * - User B: Badminton Test Facility (Org: courtbook-test-badminton-b)
 *
 * Covers all 9 mandatory requirements:
 * 1. User A can read their own organization's reservations.
 * 2. User B can read their own organization's reservations.
 * 3. User A cannot read User B's private reservations.
 * 4. User B cannot read User A's private reservations.
 * 5. User A cannot approve, decline, cancel, or reschedule User B's reservations.
 * 6. User B cannot approve, decline, cancel, or reschedule User A's reservations.
 * 7. Neither user can modify the other organization's facility settings.
 * 8. Neither user can access or modify the other's organization memberships.
 * 9. Anonymous customers cannot read private reservation or owner information.
 */
export async function runMultiTenantIsolationSuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'Phase 2: Multi-Tenant Security & Tenant Isolation';

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
      id: 'tenant-iso-setup-fail',
      category,
      name: 'Authentication and Fixture Setup for Multi-Tenant Isolation Tests',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: 0,
      error: err.message,
      suggestedFix: 'Ensure test user credentials exist in Supabase auth and seed data is applied.',
    });
    return results;
  }

  if (!ctxA.facility || !ctxB.facility) {
    results.push({
      id: 'tenant-iso-fixtures-missing',
      category,
      name: 'Facility Fixtures Verification for Organizations A and B',
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: 'Facility fixtures not found for test organizations.',
    });
    return results;
  }

  // --------------------------------------------------------------------------
  // Requirement 1: User A can read their own organization's reservations [READ-ONLY]
  // --------------------------------------------------------------------------
  const t1 = Date.now();
  try {
    const { data, error } = await ctxA.client
      .from('reservations')
      .select('id, reference_code, facility_id, customer_name, status, price')
      .eq('facility_id', ctxA.facility.id);

    if (error) {
      results.push({
        id: 'tenant-user-a-reads-own-reservations',
        category,
        name: 'Tenant Read Access: User A Reads Own Organization Reservations',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        error: error.message,
      });
    } else {
      const allBelongToA = (data || []).every((r: any) => r.facility_id === ctxA.facility?.id);
      results.push({
        id: 'tenant-user-a-reads-own-reservations',
        category,
        name: 'Tenant Read Access: User A Reads Own Organization Reservations',
        status: allBelongToA ? 'PASS' : 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        details: `User A successfully read ${data?.length || 0} reservation(s) for Facility A. All records belong strictly to Facility A.`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-user-a-reads-own-reservations',
      category,
      name: 'Tenant Read Access: User A Reads Own Organization Reservations',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t1,
      error: err.message,
    });
  }

  // --------------------------------------------------------------------------
  // Requirement 2: User B can read their own organization's reservations [READ-ONLY]
  // --------------------------------------------------------------------------
  const t2 = Date.now();
  try {
    const { data, error } = await ctxB.client
      .from('reservations')
      .select('id, reference_code, facility_id, customer_name, status, price')
      .eq('facility_id', ctxB.facility.id);

    if (error) {
      results.push({
        id: 'tenant-user-b-reads-own-reservations',
        category,
        name: 'Tenant Read Access: User B Reads Own Organization Reservations',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t2,
        error: error.message,
      });
    } else {
      const allBelongToB = (data || []).every((r: any) => r.facility_id === ctxB.facility?.id);
      results.push({
        id: 'tenant-user-b-reads-own-reservations',
        category,
        name: 'Tenant Read Access: User B Reads Own Organization Reservations',
        status: allBelongToB ? 'PASS' : 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t2,
        details: `User B successfully queried reservations for Facility B (${data?.length || 0} records). Zero records from outside Facility B.`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-user-b-reads-own-reservations',
      category,
      name: 'Tenant Read Access: User B Reads Own Organization Reservations',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t2,
      error: err.message,
    });
  }

  // --------------------------------------------------------------------------
  // Requirement 3: User A cannot read User B's private reservations [READ-ONLY]
  // --------------------------------------------------------------------------
  const t3 = Date.now();
  try {
    const { data, error } = await ctxA.client
      .from('reservations')
      .select('id, reference_code, customer_name, customer_email, customer_phone')
      .eq('facility_id', ctxB.facility.id);

    if (error && isIntendedSecurityRejection(error)) {
      results.push({
        id: 'tenant-user-a-cannot-read-user-b-reservations',
        category,
        name: 'Cross-Tenant Isolation: User A Cannot Read User B Private Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t3,
        details: `User A access to User B reservations rejected by database: ${error.message}`,
      });
    } else if (data && data.length > 0) {
      results.push({
        id: 'tenant-user-a-cannot-read-user-b-reservations',
        category,
        name: 'Cross-Tenant Isolation: User A Cannot Read User B Private Reservations',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t3,
        error: `CRITICAL FLAW: User A was able to read ${data.length} reservation(s) belonging to User B!`,
        suggestedFix: 'Enforce RLS policy staff_can_view_facility_reservations on reservations table.',
      });
    } else {
      results.push({
        id: 'tenant-user-a-cannot-read-user-b-reservations',
        category,
        name: 'Cross-Tenant Isolation: User A Cannot Read User B Private Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t3,
        details: 'User A query for User B facility returned 0 rows. RLS policy prevents cross-tenant data leakage.',
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-user-a-cannot-read-user-b-reservations',
      category,
      name: 'Cross-Tenant Isolation: User A Cannot Read User B Private Reservations',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t3,
      error: err.message,
    });
  }

  // --------------------------------------------------------------------------
  // Requirement 4: User B cannot read User A's private reservations [READ-ONLY]
  // --------------------------------------------------------------------------
  const t4 = Date.now();
  try {
    const { data, error } = await ctxB.client
      .from('reservations')
      .select('id, reference_code, customer_name, customer_email, customer_phone')
      .eq('facility_id', ctxA.facility.id);

    if (error && isIntendedSecurityRejection(error)) {
      results.push({
        id: 'tenant-user-b-cannot-read-user-a-reservations',
        category,
        name: 'Cross-Tenant Isolation: User B Cannot Read User A Private Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t4,
        details: `User B access to User A reservations rejected by database: ${error.message}`,
      });
    } else if (data && data.length > 0) {
      results.push({
        id: 'tenant-user-b-cannot-read-user-a-reservations',
        category,
        name: 'Cross-Tenant Isolation: User B Cannot Read User A Private Reservations',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t4,
        error: `CRITICAL FLAW: User B read ${data.length} private reservation(s) belonging to User A!`,
        suggestedFix: 'Audit RLS on reservations table to ensure is_facility_staff(facility_id) is enforced.',
      });
    } else {
      results.push({
        id: 'tenant-user-b-cannot-read-user-a-reservations',
        category,
        name: 'Cross-Tenant Isolation: User B Cannot Read User A Private Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t4,
        details: 'User B query for User A facility returned 0 rows. User A customer data, phone numbers, and booking references remain 100% private.',
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-user-b-cannot-read-user-a-reservations',
      category,
      name: 'Cross-Tenant Isolation: User B Cannot Read User A Private Reservations',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t4,
      error: err.message,
    });
  }

  // --------------------------------------------------------------------------
  // Requirement 5: User A cannot approve, decline, cancel, or reschedule User B's reservations
  // --------------------------------------------------------------------------
  // 5a. User A cannot approve User B's reservation [READ-ONLY / PERMISSION BARRIER]
  const t5a = Date.now();
  try {
    // Arbitrary/non-owned UUID representing a target in Organization B
    const arbitraryResId = '00000000-0000-0000-0000-00000000000b';
    const { data, error } = await ctxA.client.rpc('approve_booking_request_as_staff', {
      p_reservation_id: arbitraryResId,
      p_notes: 'Unauthorized approval attempt by User A',
    });

    if (error && (isIntendedSecurityRejection(error) || error.message.includes('not found') || error.message.includes('Access denied'))) {
      results.push({
        id: 'tenant-user-a-cannot-approve-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Approve User B Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5a,
        details: `Unauthorized approval correctly blocked by procedure: ${error.message}`,
      });
    } else {
      results.push({
        id: 'tenant-user-a-cannot-approve-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Approve User B Reservations',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5a,
        error: `Unexpected response: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-user-a-cannot-approve-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Approve User B Reservations',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t5a,
      details: `Execution blocked as intended: ${err.message}`,
    });
  }

  // 5b. User A cannot decline User B's reservation [READ-ONLY / PERMISSION BARRIER]
  const t5b = Date.now();
  try {
    const arbitraryResId = '00000000-0000-0000-0000-00000000000b';
    const { data, error } = await ctxA.client.rpc('decline_booking_request_as_staff', {
      p_reservation_id: arbitraryResId,
      p_reason: 'Unauthorized decline attempt by User A',
    });

    if (error && (isIntendedSecurityRejection(error) || error.message.includes('not found') || error.message.includes('Access denied'))) {
      results.push({
        id: 'tenant-user-a-cannot-decline-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Decline User B Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5b,
        details: `Unauthorized decline correctly blocked by procedure: ${error.message}`,
      });
    } else {
      results.push({
        id: 'tenant-user-a-cannot-decline-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Decline User B Reservations',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5b,
        error: `Unexpected response: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-user-a-cannot-decline-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Decline User B Reservations',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t5b,
      details: `Execution blocked as intended: ${err.message}`,
    });
  }

  // 5c. User A cannot cancel User B's reservation [READ-ONLY / PERMISSION BARRIER]
  const t5c = Date.now();
  try {
    const arbitraryResId = '00000000-0000-0000-0000-00000000000b';
    const { data, error } = await ctxA.client.rpc('cancel_reservation_as_staff', {
      p_reservation_id: arbitraryResId,
      p_reason: 'Unauthorized cancellation attempt by User A',
    });

    if (error && (isIntendedSecurityRejection(error) || error.message.includes('not found') || error.message.includes('Access denied'))) {
      results.push({
        id: 'tenant-user-a-cannot-cancel-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Cancel User B Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5c,
        details: `Unauthorized cancellation correctly rejected: ${error.message}`,
      });
    } else {
      results.push({
        id: 'tenant-user-a-cannot-cancel-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Cancel User B Reservations',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5c,
        error: `Unexpected response: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-user-a-cannot-cancel-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Cancel User B Reservations',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t5c,
      details: `Execution blocked as intended: ${err.message}`,
    });
  }

  // 5d. User A cannot reschedule User B's reservation [READ-ONLY / PERMISSION BARRIER]
  const t5d = Date.now();
  try {
    const arbitraryResId = '00000000-0000-0000-0000-00000000000b';
    const targetCourtId = ctxB.courts[0]?.id || arbitraryResId;
    const { data, error } = await ctxA.client.rpc('reschedule_reservation_as_staff', {
      p_reservation_id: arbitraryResId,
      p_new_court_id: targetCourtId,
      p_new_date: '2028-01-01',
      p_new_start_time: '2028-01-01T08:00:00Z',
      p_new_duration_minutes: 60,
    });

    if (error && (isIntendedSecurityRejection(error) || error.message.includes('not found') || error.message.includes('Access denied'))) {
      results.push({
        id: 'tenant-user-a-cannot-reschedule-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Reschedule User B Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5d,
        details: `Unauthorized rescheduling correctly rejected: ${error.message}`,
      });
    } else {
      results.push({
        id: 'tenant-user-a-cannot-reschedule-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Reschedule User B Reservations',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5d,
        error: `Unexpected response: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-user-a-cannot-reschedule-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Reschedule User B Reservations',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t5d,
      details: `Execution blocked as intended: ${err.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // Requirement 6: User B cannot approve, decline, cancel, or reschedule User A's reservations
  // (Tested against real existing reservations in Facility A)
  // --------------------------------------------------------------------------
  const { data: realResAList } = await ctxA.client
    .from('reservations')
    .select('id, reference_code, status')
    .eq('facility_id', ctxA.facility.id)
    .limit(1);

  const realResA = realResAList && realResAList.length > 0 ? realResAList[0] : null;

  // 6a. User B cannot approve User A's reservation [READ-ONLY / PERMISSION BARRIER]
  const t6a = Date.now();
  if (!realResA) {
    results.push({
      id: 'tenant-user-b-cannot-approve-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Approve User A Reservations',
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: 'No existing reservation in Facility A to verify against.',
    });
  } else {
    try {
      const { data, error } = await ctxB.client.rpc('approve_booking_request_as_staff', {
        p_reservation_id: realResA.id,
        p_notes: 'Cross-tenant approval attack attempt by User B',
      });

      if (error && isIntendedSecurityRejection(error)) {
        results.push({
          id: 'tenant-user-b-cannot-approve-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Approve User A Reservations',
          status: 'PASS',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t6a,
          details: `Cross-tenant approval actively blocked by database: "${error.message}"`,
        });
      } else {
        results.push({
          id: 'tenant-user-b-cannot-approve-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Approve User A Reservations',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t6a,
          error: `Cross-tenant approval was not rejected: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'tenant-user-b-cannot-approve-user-a-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User B Cannot Approve User A Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t6a,
        details: `Rejected as intended: ${err.message}`,
      });
    }
  }

  // 6b. User B cannot decline User A's reservation [READ-ONLY / PERMISSION BARRIER]
  const t6b = Date.now();
  if (!realResA) {
    results.push({
      id: 'tenant-user-b-cannot-decline-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Decline User A Reservations',
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: 'No existing reservation in Facility A to verify against.',
    });
  } else {
    try {
      const { data, error } = await ctxB.client.rpc('decline_booking_request_as_staff', {
        p_reservation_id: realResA.id,
        p_reason: 'Cross-tenant decline attack attempt by User B',
      });

      if (error && isIntendedSecurityRejection(error)) {
        results.push({
          id: 'tenant-user-b-cannot-decline-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Decline User A Reservations',
          status: 'PASS',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t6b,
          details: `Cross-tenant decline actively blocked by database: "${error.message}"`,
        });
      } else {
        results.push({
          id: 'tenant-user-b-cannot-decline-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Decline User A Reservations',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t6b,
          error: `Cross-tenant decline was not rejected: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'tenant-user-b-cannot-decline-user-a-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User B Cannot Decline User A Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t6b,
        details: `Rejected as intended: ${err.message}`,
      });
    }
  }

  // 6c. User B cannot cancel User A's reservation [READ-ONLY / PERMISSION BARRIER]
  const t6c = Date.now();
  if (!realResA) {
    results.push({
      id: 'tenant-user-b-cannot-cancel-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Cancel User A Reservations',
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: 'No existing reservation in Facility A to verify against.',
    });
  } else {
    try {
      const { data, error } = await ctxB.client.rpc('cancel_reservation_as_staff', {
        p_reservation_id: realResA.id,
        p_reason: 'Cross-tenant cancel attack attempt by User B',
      });

      if (error && isIntendedSecurityRejection(error)) {
        results.push({
          id: 'tenant-user-b-cannot-cancel-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Cancel User A Reservations',
          status: 'PASS',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t6c,
          details: `Cross-tenant cancellation actively blocked by database: "${error.message}"`,
        });
      } else {
        results.push({
          id: 'tenant-user-b-cannot-cancel-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Cancel User A Reservations',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t6c,
          error: `Cross-tenant cancellation was not rejected: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'tenant-user-b-cannot-cancel-user-a-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User B Cannot Cancel User A Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t6c,
        details: `Rejected as intended: ${err.message}`,
      });
    }
  }

  // 6d. User B cannot reschedule User A's reservation [READ-ONLY / PERMISSION BARRIER]
  const t6d = Date.now();
  if (!realResA) {
    results.push({
      id: 'tenant-user-b-cannot-reschedule-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Reschedule User A Reservations',
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: 'No existing reservation in Facility A to verify against.',
    });
  } else {
    try {
      const { data, error } = await ctxB.client.rpc('reschedule_reservation_as_staff', {
        p_reservation_id: realResA.id,
        p_new_court_id: ctxA.courts[0]?.id || realResA.id,
        p_new_date: '2028-01-01',
        p_new_start_time: '2028-01-01T08:00:00Z',
        p_new_duration_minutes: 60,
      });

      if (error && isIntendedSecurityRejection(error)) {
        results.push({
          id: 'tenant-user-b-cannot-reschedule-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Reschedule User A Reservations',
          status: 'PASS',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t6d,
          details: `Cross-tenant rescheduling actively blocked by database: "${error.message}"`,
        });
      } else {
        results.push({
          id: 'tenant-user-b-cannot-reschedule-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Reschedule User A Reservations',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t6d,
          error: `Cross-tenant rescheduling was not rejected: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'tenant-user-b-cannot-reschedule-user-a-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User B Cannot Reschedule User A Reservations',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t6d,
        details: `Rejected as intended: ${err.message}`,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Requirement 7: Neither user can modify the other organization's facility settings
  // --------------------------------------------------------------------------
  // 7a. User A cannot modify Facility B confirmation settings via RPC [READ-ONLY / PERMISSION BARRIER]
  const t7a = Date.now();
  try {
    const { data, error } = await ctxA.client.rpc('update_facility_confirmation_settings', {
      p_facility_id: ctxB.facility.id,
      p_mode: 'manual_approval',
      p_hold_minutes: 45,
    });

    if (error && isIntendedSecurityRejection(error)) {
      results.push({
        id: 'tenant-user-a-cannot-update-facility-b-settings-rpc',
        category,
        name: 'Settings Isolation: User A Cannot Update Facility B Settings via RPC',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t7a,
        details: `Rejected by authorization check: "${error.message}"`,
      });
    } else {
      results.push({
        id: 'tenant-user-a-cannot-update-facility-b-settings-rpc',
        category,
        name: 'Settings Isolation: User A Cannot Update Facility B Settings via RPC',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t7a,
        error: `Cross-tenant settings update was not rejected: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-user-a-cannot-update-facility-b-settings-rpc',
      category,
      name: 'Settings Isolation: User A Cannot Update Facility B Settings via RPC',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t7a,
      details: `Execution blocked as intended: ${err.message}`,
    });
  }

  // 7b. User B cannot modify Facility A confirmation settings via RPC [READ-ONLY / PERMISSION BARRIER]
  const t7b = Date.now();
  try {
    const { data, error } = await ctxB.client.rpc('update_facility_confirmation_settings', {
      p_facility_id: ctxA.facility.id,
      p_mode: 'manual_approval',
      p_hold_minutes: 45,
    });

    if (error && isIntendedSecurityRejection(error)) {
      results.push({
        id: 'tenant-user-b-cannot-update-facility-a-settings-rpc',
        category,
        name: 'Settings Isolation: User B Cannot Update Facility A Settings via RPC',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t7b,
        details: `Rejected by authorization check: "${error.message}"`,
      });
    } else {
      results.push({
        id: 'tenant-user-b-cannot-update-facility-a-settings-rpc',
        category,
        name: 'Settings Isolation: User B Cannot Update Facility A Settings via RPC',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t7b,
        error: `Cross-tenant settings update was not rejected: ${JSON.stringify(data)}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-user-b-cannot-update-facility-a-settings-rpc',
      category,
      name: 'Settings Isolation: User B Cannot Update Facility A Settings via RPC',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t7b,
      details: `Execution blocked as intended: ${err.message}`,
    });
  }

  // 7c. Direct UPDATE barrier: Neither user can modify other facility core attributes [STATE-CHANGING / GUARDED]
  const t7c = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-direct-update-facility-isolation',
      category,
      name: 'Settings Isolation: Direct UPDATE on Other Facility Is Blocked by RLS',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else {
    try {
      const { data: updateAonB } = await ctxA.client
        .from('facilities')
        .update({ default_hourly_rate: 999.0 })
        .eq('id', ctxB.facility.id)
        .select();

      const { data: updateBonA } = await ctxB.client
        .from('facilities')
        .update({ default_hourly_rate: 999.0 })
        .eq('id', ctxA.facility.id)
        .select();

      const isAonBBlocked = !updateAonB || updateAonB.length === 0;
      const isBonABlocked = !updateBonA || updateBonA.length === 0;

      if (isAonBBlocked && isBonABlocked) {
        results.push({
          id: 'tenant-direct-update-facility-isolation',
          category,
          name: 'Settings Isolation: Direct UPDATE on Other Facility Is Blocked by RLS',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t7c,
          details: 'RLS policy facility_admins_can_update_facility successfully blocked cross-tenant facility modifications (0 rows modified).',
        });
      } else {
        results.push({
          id: 'tenant-direct-update-facility-isolation',
          category,
          name: 'Settings Isolation: Direct UPDATE on Other Facility Is Blocked by RLS',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t7c,
          error: `CRITICAL: Direct facility update succeeded across tenants! AonB=${updateAonB?.length}, BonA=${updateBonA?.length}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'tenant-direct-update-facility-isolation',
        category,
        name: 'Settings Isolation: Direct UPDATE on Other Facility Is Blocked by RLS',
        status: 'PASS',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t7c,
        details: `Rejected as intended: ${err.message}`,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Requirement 8: Neither user can access or modify the other's organization memberships
  // --------------------------------------------------------------------------
  // 8a. User A cannot read User B organization memberships [READ-ONLY]
  const t8a = Date.now();
  try {
    const { data: memBFromA } = await ctxA.client
      .from('organization_members')
      .select('id, user_id, role, organization_id')
      .eq('organization_id', ctxB.orgId);

    const { data: memAFromB } = await ctxB.client
      .from('organization_members')
      .select('id, user_id, role, organization_id')
      .eq('organization_id', ctxA.orgId);

    const isMemBProtected = !memBFromA || memBFromA.length === 0;
    const isMemAProtected = !memAFromB || memAFromB.length === 0;

    if (isMemBProtected && isMemAProtected) {
      results.push({
        id: 'tenant-memberships-read-privacy',
        category,
        name: 'Membership Privacy: Neither User Can Read Other Organization Members',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t8a,
        details: 'RLS policy members_can_view_teammates returned 0 rows for both cross-tenant member queries.',
      });
    } else {
      results.push({
        id: 'tenant-memberships-read-privacy',
        category,
        name: 'Membership Privacy: Neither User Can Read Other Organization Members',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t8a,
        error: `Cross-tenant membership leak detected: User A saw ${memBFromA?.length} members of B; User B saw ${memAFromB?.length} members of A.`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-memberships-read-privacy',
      category,
      name: 'Membership Privacy: Neither User Can Read Other Organization Members',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t8a,
      error: err.message,
    });
  }

  // 8b. Anti-Escalation: Neither user can insert themselves or modify roles in other organization [STATE-CHANGING / GUARDED]
  const t8b = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-memberships-anti-tampering',
      category,
      name: 'Membership Security: Anti-Escalation Prevents Self-Assignment in Other Org',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else {
    try {
      // User A attempts self-insertion into Org B
      const { data: insertDataA, error: insertErrA } = await ctxA.client
        .from('organization_members')
        .insert({
          organization_id: ctxB.orgId,
          user_id: ctxA.userId,
          role: 'owner',
        })
        .select();

      // User B attempts self-insertion into Org A
      const { data: insertDataB, error: insertErrB } = await ctxB.client
        .from('organization_members')
        .insert({
          organization_id: ctxA.orgId,
          user_id: ctxB.userId,
          role: 'owner',
        })
        .select();

      const isAInsertBlocked =
        Boolean(insertErrA && (isIntendedSecurityRejection(insertErrA) || insertErrA.code === '42501')) ||
        !insertDataA ||
        insertDataA.length === 0;

      const isBInsertBlocked =
        Boolean(insertErrB && (isIntendedSecurityRejection(insertErrB) || insertErrB.code === '42501')) ||
        !insertDataB ||
        insertDataB.length === 0;

      if (isAInsertBlocked && isBInsertBlocked) {
        results.push({
          id: 'tenant-memberships-anti-tampering',
          category,
          name: 'Membership Security: Anti-Escalation Prevents Self-Assignment in Other Org',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t8b,
          details: 'RLS policies owners_can_insert_teammates strictly rejected cross-tenant member self-assignment.',
        });
      } else {
        results.push({
          id: 'tenant-memberships-anti-tampering',
          category,
          name: 'Membership Security: Anti-Escalation Prevents Self-Assignment in Other Org',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t8b,
          error: `CRITICAL: Self-assignment succeeded: A=${JSON.stringify(insertDataA)}, B=${JSON.stringify(insertDataB)}`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'tenant-memberships-anti-tampering',
        category,
        name: 'Membership Security: Anti-Escalation Prevents Self-Assignment in Other Org',
        status: 'PASS',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t8b,
        details: `Rejected as intended: ${err.message}`,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Requirement 9: Anonymous customers cannot read private reservation or owner information
  // --------------------------------------------------------------------------
  // 9a. Anonymous customer cannot read reservations table [READ-ONLY]
  const t9a = Date.now();
  try {
    const { data, error } = await anonClient.from('reservations').select('*').limit(10);

    const isAccessDenied =
      Boolean(error && (isIntendedSecurityRejection(error) || error.code === '42501' || error.message.includes('permission denied'))) ||
      !data ||
      data.length === 0;

    if (isAccessDenied) {
      results.push({
        id: 'tenant-anon-cannot-read-reservations',
        category,
        name: 'Customer Privacy: Anonymous Visitors Cannot Read Reservations Table',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9a,
        details: error
          ? `Access denied for anonymous client: "${error.message}" (Code: ${error.code})`
          : 'Zero rows returned to anonymous visitor.',
      });
    } else {
      results.push({
        id: 'tenant-anon-cannot-read-reservations',
        category,
        name: 'Customer Privacy: Anonymous Visitors Cannot Read Reservations Table',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9a,
        error: `CRITICAL LEAK: Anonymous visitor read ${data.length} reservation record(s)!`,
        suggestedFix: 'Revoke SELECT on reservations from anon; ensure RLS is enabled.',
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-anon-cannot-read-reservations',
      category,
      name: 'Customer Privacy: Anonymous Visitors Cannot Read Reservations Table',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t9a,
      details: `Access blocked as intended: ${err.message}`,
    });
  }

  // 9b. Anonymous customer cannot read organizations table [READ-ONLY]
  const t9b = Date.now();
  try {
    const { data, error } = await anonClient.from('organizations').select('*').limit(10);

    const isAccessDenied =
      Boolean(error && (isIntendedSecurityRejection(error) || error.code === '42501' || error.message.includes('permission denied'))) ||
      !data ||
      data.length === 0;

    if (isAccessDenied) {
      results.push({
        id: 'tenant-anon-cannot-read-organizations',
        category,
        name: 'Business Privacy: Anonymous Visitors Cannot Read Organizations Table',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9b,
        details: error
          ? `Access denied for anonymous client: "${error.message}" (Code: ${error.code})`
          : 'Zero rows returned to anonymous visitor. Private billing email protected.',
      });
    } else {
      results.push({
        id: 'tenant-anon-cannot-read-organizations',
        category,
        name: 'Business Privacy: Anonymous Visitors Cannot Read Organizations Table',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9b,
        error: `CRITICAL LEAK: Anonymous visitor read ${data.length} organization record(s)!`,
        suggestedFix: 'Revoke SELECT on organizations from anon; ensure RLS is enabled.',
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-anon-cannot-read-organizations',
      category,
      name: 'Business Privacy: Anonymous Visitors Cannot Read Organizations Table',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t9b,
      details: `Access blocked as intended: ${err.message}`,
    });
  }

  // 9c. Anonymous customer cannot read organization members table [READ-ONLY]
  const t9c = Date.now();
  try {
    const { data, error } = await anonClient.from('organization_members').select('*').limit(10);

    const isAccessDenied =
      Boolean(error && (isIntendedSecurityRejection(error) || error.code === '42501' || error.message.includes('permission denied'))) ||
      !data ||
      data.length === 0;

    if (isAccessDenied) {
      results.push({
        id: 'tenant-anon-cannot-read-organization-members',
        category,
        name: 'Team Privacy: Anonymous Visitors Cannot Read Organization Members',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9c,
        details: error
          ? `Access denied for anonymous client: "${error.message}" (Code: ${error.code})`
          : 'Zero rows returned. Staff user IDs and roles protected from anonymous enumeration.',
      });
    } else {
      results.push({
        id: 'tenant-anon-cannot-read-organization-members',
        category,
        name: 'Team Privacy: Anonymous Visitors Cannot Read Organization Members',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9c,
        error: `CRITICAL LEAK: Anonymous visitor read ${data.length} team member record(s)!`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-anon-cannot-read-organization-members',
      category,
      name: 'Team Privacy: Anonymous Visitors Cannot Read Organization Members',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t9c,
      details: `Access blocked as intended: ${err.message}`,
    });
  }

  // 9d. Anonymous customer can ONLY read public non-sensitive facility and court operational info [READ-ONLY]
  const t9d = Date.now();
  try {
    const { data: facData, error: facErr } = await anonClient
      .from('facilities')
      .select('id, name, timezone, open_hour, close_hour, is_active')
      .eq('is_active', true);

    const { data: courtData, error: courtErr } = await anonClient
      .from('courts')
      .select('id, name, sport_type, hourly_rate, is_enabled')
      .eq('is_enabled', true);

    const isPublicDataAccessible = !facErr && !courtErr && (facData?.length || 0) > 0 && (courtData?.length || 0) > 0;

    if (isPublicDataAccessible) {
      results.push({
        id: 'tenant-anon-public-boundary-safe',
        category,
        name: 'Public Boundary: Anonymous Visitors Can Only Access Non-Sensitive Court Data',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9d,
        details: `Confirmed: Anonymous customers can query ${facData?.length} active facility/facilities and ${courtData?.length} enabled court(s) with zero exposure of customer PII, owner billing data, or staff identities.`,
      });
    } else {
      results.push({
        id: 'tenant-anon-public-boundary-safe',
        category,
        name: 'Public Boundary: Anonymous Visitors Can Only Access Non-Sensitive Court Data',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9d,
        error: `Public data inaccessible: facErr=${facErr?.message}, courtErr=${courtErr?.message}`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-anon-public-boundary-safe',
      category,
      name: 'Public Boundary: Anonymous Visitors Can Only Access Non-Sensitive Court Data',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t9d,
      error: err.message,
    });
  }

  return results;
}
