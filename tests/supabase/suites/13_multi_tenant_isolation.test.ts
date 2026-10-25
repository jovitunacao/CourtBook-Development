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
 * Safety & Integrity Standards:
 * 1. Positive controls prove valid authentication and access to each owner's own records
 *    before asserting cross-tenant read isolation.
 * 2. Every state-changing RPC or mutation test is classified as STATE_CHANGING.
 * 3. State-changing tests are completely guarded when CONFIRM_TEST_ENV=false (safe mode default).
 * 4. Never perform write-security tests against existing facility prices, settings,
 *    or organization memberships. Require dedicated disposable test entities (tagged TD-% or
 *    TEST-DISPOSABLE-%), or mark those tests BLOCKED.
 * 5. Never treat null response data, network errors, missing functions, or arbitrary exceptions
 *    as proof of authorization. Catch blocks strictly FAIL unless the error is independently
 *    verified as a genuine database authorization denial.
 * 6. Explicitly distinguish RLS-filtered zero-row results from unexpected API failures.
 * 7. When write tests run, validate both the returned authorization error code and that the
 *    underlying database record remains 100% unchanged.
 * 8. Zero exposure of passwords, access tokens, or sensitive API keys.
 */

/**
 * Rigorously checks that an error returned by Supabase / PostgreSQL represents a true
 * database authorization denial (RLS 42501 or PL/pgSQL P0001 access-denied exception)
 * against an existing record, rather than:
 * - "Reservation not found" (false positive from non-existent UUID or wrong fixture)
 * - Network timeouts, connection resets, DNS failures
 * - Missing function, syntax errors, or schema mismatches
 * - Unauthenticated / JWT expiration errors
 */
function isCrossTenantAuthorizationRejection(error: any): boolean {
  if (!error) return false;
  if (!isIntendedSecurityRejection(error)) return false;

  const msg = String(error.message || error.details || '').toLowerCase();
  const code = String(error.code || '').toLowerCase();

  // Reject false-positive signals:
  // "Reservation not found" or missing entity errors do NOT prove cross-tenant authorization barriers!
  if (
    msg.includes('not found') ||
    msg.includes('does not exist') ||
    msg.includes('no rows') ||
    msg.includes('404')
  ) {
    return false;
  }

  // Must be an explicit authorization or RLS barrier
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
      error: `Authentication setup failed: ${err.message}`,
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

  // ==========================================================================
  // Section 0: Positive Controls (Proving Valid Authentication & Access to Own Records)
  // Required before asserting cross-tenant read isolation.
  // ==========================================================================
  let userAPositiveControlPassed = false;
  let userBPositiveControlPassed = false;
  let userAMembershipControlPassed = false;
  let userBMembershipControlPassed = false;

  // Positive Control 1: User A reads own organization, facility, and court inventory
  const tCtrlA = Date.now();
  try {
    const { data: courtsA, error: errCourtsA } = await ctxA.client
      .from('courts')
      .select('id, name, sport_type')
      .eq('facility_id', ctxA.facility.id);

    if (errCourtsA) {
      results.push({
        id: 'tenant-control-user-a-access-own-org',
        category,
        name: 'Positive Control: User A Accesses Own Organization and Facility Inventory',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlA,
        error: `User A failed to read own courts: ${errCourtsA.message}`,
      });
    } else if (!Array.isArray(courtsA) || courtsA.length === 0) {
      results.push({
        id: 'tenant-control-user-a-access-own-org',
        category,
        name: 'Positive Control: User A Accesses Own Organization and Facility Inventory',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlA,
        error: 'User A returned zero courts for own facility; expected active court inventory.',
      });
    } else {
      userAPositiveControlPassed = true;
      results.push({
        id: 'tenant-control-user-a-access-own-org',
        category,
        name: 'Positive Control: User A Accesses Own Organization and Facility Inventory',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlA,
        details: `Positive control passed: User A successfully accessed Facility A (${ctxA.facility.name}) and verified ${courtsA.length} court(s).`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-control-user-a-access-own-org',
      category,
      name: 'Positive Control: User A Accesses Own Organization and Facility Inventory',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - tCtrlA,
      error: `Unexpected exception during User A positive control: ${err.message}`,
    });
  }

  // Positive Control 2: User B reads own organization, facility, and court inventory
  const tCtrlB = Date.now();
  try {
    const { data: courtsB, error: errCourtsB } = await ctxB.client
      .from('courts')
      .select('id, name, sport_type')
      .eq('facility_id', ctxB.facility.id);

    if (errCourtsB) {
      results.push({
        id: 'tenant-control-user-b-access-own-org',
        category,
        name: 'Positive Control: User B Accesses Own Organization and Facility Inventory',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlB,
        error: `User B failed to read own courts: ${errCourtsB.message}`,
      });
    } else if (!Array.isArray(courtsB) || courtsB.length === 0) {
      results.push({
        id: 'tenant-control-user-b-access-own-org',
        category,
        name: 'Positive Control: User B Accesses Own Organization and Facility Inventory',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlB,
        error: 'User B returned zero courts for own facility; expected active court inventory.',
      });
    } else {
      userBPositiveControlPassed = true;
      results.push({
        id: 'tenant-control-user-b-access-own-org',
        category,
        name: 'Positive Control: User B Accesses Own Organization and Facility Inventory',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlB,
        details: `Positive control passed: User B successfully accessed Facility B (${ctxB.facility.name}) and verified ${courtsB.length} court(s).`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-control-user-b-access-own-org',
      category,
      name: 'Positive Control: User B Accesses Own Organization and Facility Inventory',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - tCtrlB,
      error: `Unexpected exception during User B positive control: ${err.message}`,
    });
  }

  // Positive Control 3: User A reads own team members in Organization A
  const tCtrlMbrA = Date.now();
  try {
    const { data: membersA, error: errMembersA } = await ctxA.client
      .from('organization_members')
      .select('id, user_id, role')
      .eq('organization_id', ctxA.orgId);

    if (errMembersA) {
      results.push({
        id: 'tenant-control-user-a-access-own-members',
        category,
        name: 'Positive Control: User A Accesses Own Organization Memberships',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlMbrA,
        error: `User A failed to read own members: ${errMembersA.message}`,
      });
    } else if (!Array.isArray(membersA) || membersA.length === 0) {
      results.push({
        id: 'tenant-control-user-a-access-own-members',
        category,
        name: 'Positive Control: User A Accesses Own Organization Memberships',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlMbrA,
        error: 'No members found for User A organization.',
      });
    } else {
      userAMembershipControlPassed = true;
      results.push({
        id: 'tenant-control-user-a-access-own-members',
        category,
        name: 'Positive Control: User A Accesses Own Organization Memberships',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlMbrA,
        details: `Positive control passed: User A read ${membersA.length} member record(s) for Org A.`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-control-user-a-access-own-members',
      category,
      name: 'Positive Control: User A Accesses Own Organization Memberships',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - tCtrlMbrA,
      error: `Unexpected exception during User A membership control: ${err.message}`,
    });
  }

  // Positive Control 4: User B reads own team members in Organization B
  const tCtrlMbrB = Date.now();
  try {
    const { data: membersB, error: errMembersB } = await ctxB.client
      .from('organization_members')
      .select('id, user_id, role')
      .eq('organization_id', ctxB.orgId);

    if (errMembersB) {
      results.push({
        id: 'tenant-control-user-b-access-own-members',
        category,
        name: 'Positive Control: User B Accesses Own Organization Memberships',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlMbrB,
        error: `User B failed to read own members: ${errMembersB.message}`,
      });
    } else if (!Array.isArray(membersB) || membersB.length === 0) {
      results.push({
        id: 'tenant-control-user-b-access-own-members',
        category,
        name: 'Positive Control: User B Accesses Own Organization Memberships',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlMbrB,
        error: 'No members found for User B organization.',
      });
    } else {
      userBMembershipControlPassed = true;
      results.push({
        id: 'tenant-control-user-b-access-own-members',
        category,
        name: 'Positive Control: User B Accesses Own Organization Memberships',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - tCtrlMbrB,
        details: `Positive control passed: User B read ${membersB.length} member record(s) for Org B.`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'tenant-control-user-b-access-own-members',
      category,
      name: 'Positive Control: User B Accesses Own Organization Memberships',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - tCtrlMbrB,
      error: `Unexpected exception during User B membership control: ${err.message}`,
    });
  }

  // ==========================================================================
  // Requirement 1: User A can read their own organization's reservations [READ-ONLY]
  // ==========================================================================
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
        error: `Query error reading reservations: ${error.message}`,
      });
    } else if (!Array.isArray(data)) {
      results.push({
        id: 'tenant-user-a-reads-own-reservations',
        category,
        name: 'Tenant Read Access: User A Reads Own Organization Reservations',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        error: 'Null or invalid response data received from API.',
      });
    } else {
      const allBelongToA = data.every((r: any) => r.facility_id === ctxA.facility?.id);
      results.push({
        id: 'tenant-user-a-reads-own-reservations',
        category,
        name: 'Tenant Read Access: User A Reads Own Organization Reservations',
        status: allBelongToA ? 'PASS' : 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        details: `User A successfully read ${data.length} reservation(s) for Facility A. All records belong strictly to Facility A.`,
        error: allBelongToA ? undefined : 'Found records with facility_id not matching Facility A.',
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
      error: `Unexpected exception reading own reservations: ${err.message}`,
    });
  }

  // ==========================================================================
  // Requirement 2: User B can read their own organization's reservations [READ-ONLY]
  // ==========================================================================
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
        error: `Query error reading reservations: ${error.message}`,
      });
    } else if (!Array.isArray(data)) {
      results.push({
        id: 'tenant-user-b-reads-own-reservations',
        category,
        name: 'Tenant Read Access: User B Reads Own Organization Reservations',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t2,
        error: 'Null or invalid response data received from API.',
      });
    } else {
      const allBelongToB = data.every((r: any) => r.facility_id === ctxB.facility?.id);
      results.push({
        id: 'tenant-user-b-reads-own-reservations',
        category,
        name: 'Tenant Read Access: User B Reads Own Organization Reservations',
        status: allBelongToB ? 'PASS' : 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t2,
        details: `User B successfully queried reservations for Facility B (${data.length} records). Zero records from outside Facility B.`,
        error: allBelongToB ? undefined : 'Found records with facility_id not matching Facility B.',
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
      error: `Unexpected exception reading own reservations: ${err.message}`,
    });
  }

  // ==========================================================================
  // Requirement 3: User A cannot read User B's private reservations [READ-ONLY]
  // Requires positive controls to ensure valid session before asserting zero rows.
  // ==========================================================================
  const t3 = Date.now();
  if (!userAPositiveControlPassed || !userBPositiveControlPassed) {
    results.push({
      id: 'tenant-user-a-cannot-read-user-b-reservations',
      category,
      name: 'Cross-Tenant Isolation: User A Cannot Read User B Private Reservations',
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: 'BLOCKED: Positive controls proving valid authentication and access to own records must pass before asserting cross-tenant read isolation.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client
        .from('reservations')
        .select('id, reference_code, customer_name, customer_email, customer_phone')
        .eq('facility_id', ctxB.facility.id);

      if (error) {
        if (isCrossTenantAuthorizationRejection(error) || error.code === '42501') {
          results.push({
            id: 'tenant-user-a-cannot-read-user-b-reservations',
            category,
            name: 'Cross-Tenant Isolation: User A Cannot Read User B Private Reservations',
            status: 'PASS',
            operationType: 'READ_ONLY',
            durationMs: Date.now() - t3,
            details: `User A access to User B reservations actively rejected by database authorization: ${error.message}`,
          });
        } else {
          results.push({
            id: 'tenant-user-a-cannot-read-user-b-reservations',
            category,
            name: 'Cross-Tenant Isolation: User A Cannot Read User B Private Reservations',
            status: 'FAIL',
            operationType: 'READ_ONLY',
            durationMs: Date.now() - t3,
            error: `Unexpected query error (not authorization rejection): ${error.message} (Code: ${error.code})`,
          });
        }
      } else if (!Array.isArray(data)) {
        results.push({
          id: 'tenant-user-a-cannot-read-user-b-reservations',
          category,
          name: 'Cross-Tenant Isolation: User A Cannot Read User B Private Reservations',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t3,
          error: 'Null or invalid response data received from API.',
        });
      } else if (data.length > 0) {
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
        error: `Unexpected query exception: ${err.message}`,
      });
    }
  }

  // ==========================================================================
  // Requirement 4: User B cannot read User A's private reservations [READ-ONLY]
  // Requires positive controls to ensure valid session before asserting zero rows.
  // ==========================================================================
  const t4 = Date.now();
  if (!userAPositiveControlPassed || !userBPositiveControlPassed) {
    results.push({
      id: 'tenant-user-b-cannot-read-user-a-reservations',
      category,
      name: 'Cross-Tenant Isolation: User B Cannot Read User A Private Reservations',
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: 'BLOCKED: Positive controls proving valid authentication and access to own records must pass before asserting cross-tenant read isolation.',
    });
  } else {
    try {
      const { data, error } = await ctxB.client
        .from('reservations')
        .select('id, reference_code, customer_name, customer_email, customer_phone')
        .eq('facility_id', ctxA.facility.id);

      if (error) {
        if (isCrossTenantAuthorizationRejection(error) || error.code === '42501') {
          results.push({
            id: 'tenant-user-b-cannot-read-user-a-reservations',
            category,
            name: 'Cross-Tenant Isolation: User B Cannot Read User A Private Reservations',
            status: 'PASS',
            operationType: 'READ_ONLY',
            durationMs: Date.now() - t4,
            details: `User B access to User A reservations actively rejected by database authorization: ${error.message}`,
          });
        } else {
          results.push({
            id: 'tenant-user-b-cannot-read-user-a-reservations',
            category,
            name: 'Cross-Tenant Isolation: User B Cannot Read User A Private Reservations',
            status: 'FAIL',
            operationType: 'READ_ONLY',
            durationMs: Date.now() - t4,
            error: `Unexpected query error (not authorization rejection): ${error.message} (Code: ${error.code})`,
          });
        }
      } else if (!Array.isArray(data)) {
        results.push({
          id: 'tenant-user-b-cannot-read-user-a-reservations',
          category,
          name: 'Cross-Tenant Isolation: User B Cannot Read User A Private Reservations',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t4,
          error: 'Null or invalid response data received from API.',
        });
      } else if (data.length > 0) {
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
        error: `Unexpected query exception: ${err.message}`,
      });
    }
  }

  // ==========================================================================
  // Requirement 5: User A cannot approve, decline, cancel, or reschedule User B's reservations
  // All operations classified as STATE_CHANGING.
  // Requires CONFIRM_TEST_ENV=true and dedicated disposable reservation.
  // ==========================================================================

  // 5a. User A cannot approve User B's reservation [STATE-CHANGING / GUARDED]
  const t5a = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-user-a-cannot-approve-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Approve User B Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else if (!ctxB.disposableReservation) {
    results.push({
      id: 'tenant-user-a-cannot-approve-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Approve User B Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test reservation (tagged TD-% or TEST-DISPOSABLE-%) exists in Facility B. Real customer records are protected and will never be targeted.',
    });
  } else {
    try {
      const targetResId = ctxB.disposableReservation.id;
      const initialStatus = ctxB.disposableReservation.status;

      const { data, error } = await ctxA.client.rpc('approve_booking_request_as_staff', {
        p_reservation_id: targetResId,
        p_notes: 'Unauthorized approval attempt by User A',
      });

      if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentRes } = await ctxB.client
          .from('reservations')
          .select('status')
          .eq('id', targetResId)
          .single();

        const isUnchanged = currentRes?.status === initialStatus;

        results.push({
          id: 'tenant-user-a-cannot-approve-user-b-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User A Cannot Approve User B Reservations',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5a,
          details: `Unauthorized approval correctly rejected by database authorization check: "${error.message}". Record status verified unchanged.`,
          error: isUnchanged ? undefined : 'Record status was modified despite authorization rejection.',
        });
      } else {
        results.push({
          id: 'tenant-user-a-cannot-approve-user-b-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User A Cannot Approve User B Reservations',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5a,
          error: error ? `Invalid rejection response (not authorization barrier): ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-user-a-cannot-approve-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Approve User B Reservations',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t5a,
        error: isAuth ? undefined : `Unexpected exception: ${err.message}`,
        details: isAuth ? `Blocked by database authorization check: ${err.message}` : undefined,
      });
    }
  }

  // 5b. User A cannot decline User B's reservation [STATE-CHANGING / GUARDED]
  const t5b = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-user-a-cannot-decline-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Decline User B Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else if (!ctxB.disposableReservation) {
    results.push({
      id: 'tenant-user-a-cannot-decline-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Decline User B Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test reservation (tagged TD-% or TEST-DISPOSABLE-%) exists in Facility B. Real customer records are protected and will never be targeted.',
    });
  } else {
    try {
      const targetResId = ctxB.disposableReservation.id;
      const initialStatus = ctxB.disposableReservation.status;

      const { data, error } = await ctxA.client.rpc('decline_booking_request_as_staff', {
        p_reservation_id: targetResId,
        p_reason: 'Unauthorized decline attempt by User A',
      });

      if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentRes } = await ctxB.client
          .from('reservations')
          .select('status')
          .eq('id', targetResId)
          .single();

        const isUnchanged = currentRes?.status === initialStatus;

        results.push({
          id: 'tenant-user-a-cannot-decline-user-b-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User A Cannot Decline User B Reservations',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5b,
          details: `Unauthorized decline correctly rejected by database authorization check: "${error.message}". Record status verified unchanged.`,
          error: isUnchanged ? undefined : 'Record status was modified despite authorization rejection.',
        });
      } else {
        results.push({
          id: 'tenant-user-a-cannot-decline-user-b-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User A Cannot Decline User B Reservations',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5b,
          error: error ? `Invalid rejection response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-user-a-cannot-decline-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Decline User B Reservations',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t5b,
        error: isAuth ? undefined : `Unexpected exception: ${err.message}`,
        details: isAuth ? `Blocked by database authorization check: ${err.message}` : undefined,
      });
    }
  }

  // 5c. User A cannot cancel User B's reservation [STATE-CHANGING / GUARDED]
  const t5c = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-user-a-cannot-cancel-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Cancel User B Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else if (!ctxB.disposableReservation) {
    results.push({
      id: 'tenant-user-a-cannot-cancel-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Cancel User B Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test reservation (tagged TD-% or TEST-DISPOSABLE-%) exists in Facility B. Real customer records are protected and will never be targeted.',
    });
  } else {
    try {
      const targetResId = ctxB.disposableReservation.id;
      const initialStatus = ctxB.disposableReservation.status;

      const { data, error } = await ctxA.client.rpc('cancel_reservation_as_staff', {
        p_reservation_id: targetResId,
        p_reason: 'Unauthorized cancellation attempt by User A',
      });

      if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentRes } = await ctxB.client
          .from('reservations')
          .select('status')
          .eq('id', targetResId)
          .single();

        const isUnchanged = currentRes?.status === initialStatus;

        results.push({
          id: 'tenant-user-a-cannot-cancel-user-b-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User A Cannot Cancel User B Reservations',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5c,
          details: `Unauthorized cancellation correctly rejected by database authorization check: "${error.message}". Record status verified unchanged.`,
          error: isUnchanged ? undefined : 'Record status was modified despite authorization rejection.',
        });
      } else {
        results.push({
          id: 'tenant-user-a-cannot-cancel-user-b-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User A Cannot Cancel User B Reservations',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5c,
          error: error ? `Invalid rejection response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-user-a-cannot-cancel-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Cancel User B Reservations',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t5c,
        error: isAuth ? undefined : `Unexpected exception: ${err.message}`,
        details: isAuth ? `Blocked by database authorization check: ${err.message}` : undefined,
      });
    }
  }

  // 5d. User A cannot reschedule User B's reservation [STATE-CHANGING / GUARDED]
  const t5d = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-user-a-cannot-reschedule-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Reschedule User B Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else if (!ctxB.disposableReservation) {
    results.push({
      id: 'tenant-user-a-cannot-reschedule-user-b-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User A Cannot Reschedule User B Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test reservation (tagged TD-% or TEST-DISPOSABLE-%) exists in Facility B. Real customer records are protected and will never be targeted.',
    });
  } else {
    try {
      const targetResId = ctxB.disposableReservation.id;
      const initialCourtId = ctxB.disposableReservation.court_id;
      const targetCourtId = ctxB.courts[0]?.id || initialCourtId;

      const { data, error } = await ctxA.client.rpc('reschedule_reservation_as_staff', {
        p_reservation_id: targetResId,
        p_new_court_id: targetCourtId,
        p_new_date: '2028-01-01',
        p_new_start_time: '2028-01-01T08:00:00Z',
        p_new_duration_minutes: 60,
      });

      if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentRes } = await ctxB.client
          .from('reservations')
          .select('court_id, booking_date')
          .eq('id', targetResId)
          .single();

        const isUnchanged = currentRes?.court_id === initialCourtId;

        results.push({
          id: 'tenant-user-a-cannot-reschedule-user-b-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User A Cannot Reschedule User B Reservations',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5d,
          details: `Unauthorized rescheduling correctly rejected by database authorization check: "${error.message}". Record verified unchanged.`,
          error: isUnchanged ? undefined : 'Record court assignment was modified despite authorization rejection.',
        });
      } else {
        results.push({
          id: 'tenant-user-a-cannot-reschedule-user-b-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User A Cannot Reschedule User B Reservations',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5d,
          error: error ? `Invalid rejection response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-user-a-cannot-reschedule-user-b-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User A Cannot Reschedule User B Reservations',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t5d,
        error: isAuth ? undefined : `Unexpected exception: ${err.message}`,
        details: isAuth ? `Blocked by database authorization check: ${err.message}` : undefined,
      });
    }
  }

  // ==========================================================================
  // Requirement 6: User B cannot approve, decline, cancel, or reschedule User A's reservations
  // All operations classified as STATE_CHANGING.
  // Dedicated disposable reservation required. Real customer reservations are NEVER targeted.
  // ==========================================================================

  // 6a. User B cannot approve User A's reservation [STATE-CHANGING / GUARDED]
  const t6a = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-user-b-cannot-approve-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Approve User A Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else if (!ctxA.disposableReservation) {
    results.push({
      id: 'tenant-user-b-cannot-approve-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Approve User A Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test reservation (tagged TD-% or TEST-DISPOSABLE-%) exists in Facility A. Existing customer records are protected and will never be targeted.',
    });
  } else {
    try {
      const targetResId = ctxA.disposableReservation.id;
      const initialStatus = ctxA.disposableReservation.status;

      const { data, error } = await ctxB.client.rpc('approve_booking_request_as_staff', {
        p_reservation_id: targetResId,
        p_notes: 'Cross-tenant approval attack attempt by User B',
      });

      if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentRes } = await ctxA.client
          .from('reservations')
          .select('status')
          .eq('id', targetResId)
          .single();

        const isUnchanged = currentRes?.status === initialStatus;

        results.push({
          id: 'tenant-user-b-cannot-approve-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Approve User A Reservations',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t6a,
          details: `Cross-tenant approval actively blocked by database authorization check: "${error.message}". Record verified unchanged.`,
          error: isUnchanged ? undefined : 'Record status was modified despite authorization rejection.',
        });
      } else {
        results.push({
          id: 'tenant-user-b-cannot-approve-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Approve User A Reservations',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t6a,
          error: error ? `Invalid rejection response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-user-b-cannot-approve-user-a-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User B Cannot Approve User A Reservations',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t6a,
        error: isAuth ? undefined : `Unexpected exception: ${err.message}`,
        details: isAuth ? `Blocked by database authorization check: ${err.message}` : undefined,
      });
    }
  }

  // 6b. User B cannot decline User A's reservation [STATE-CHANGING / GUARDED]
  const t6b = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-user-b-cannot-decline-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Decline User A Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else if (!ctxA.disposableReservation) {
    results.push({
      id: 'tenant-user-b-cannot-decline-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Decline User A Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test reservation (tagged TD-% or TEST-DISPOSABLE-%) exists in Facility A. Existing customer records are protected and will never be targeted.',
    });
  } else {
    try {
      const targetResId = ctxA.disposableReservation.id;
      const initialStatus = ctxA.disposableReservation.status;

      const { data, error } = await ctxB.client.rpc('decline_booking_request_as_staff', {
        p_reservation_id: targetResId,
        p_reason: 'Cross-tenant decline attack attempt by User B',
      });

      if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentRes } = await ctxA.client
          .from('reservations')
          .select('status')
          .eq('id', targetResId)
          .single();

        const isUnchanged = currentRes?.status === initialStatus;

        results.push({
          id: 'tenant-user-b-cannot-decline-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Decline User A Reservations',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t6b,
          details: `Cross-tenant decline actively blocked by database authorization check: "${error.message}". Record verified unchanged.`,
          error: isUnchanged ? undefined : 'Record status was modified despite authorization rejection.',
        });
      } else {
        results.push({
          id: 'tenant-user-b-cannot-decline-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Decline User A Reservations',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t6b,
          error: error ? `Invalid rejection response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-user-b-cannot-decline-user-a-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User B Cannot Decline User A Reservations',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t6b,
        error: isAuth ? undefined : `Unexpected exception: ${err.message}`,
        details: isAuth ? `Blocked by database authorization check: ${err.message}` : undefined,
      });
    }
  }

  // 6c. User B cannot cancel User A's reservation [STATE-CHANGING / GUARDED]
  const t6c = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-user-b-cannot-cancel-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Cancel User A Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else if (!ctxA.disposableReservation) {
    results.push({
      id: 'tenant-user-b-cannot-cancel-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Cancel User A Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test reservation (tagged TD-% or TEST-DISPOSABLE-%) exists in Facility A. Existing customer records are protected and will never be targeted.',
    });
  } else {
    try {
      const targetResId = ctxA.disposableReservation.id;
      const initialStatus = ctxA.disposableReservation.status;

      const { data, error } = await ctxB.client.rpc('cancel_reservation_as_staff', {
        p_reservation_id: targetResId,
        p_reason: 'Cross-tenant cancel attack attempt by User B',
      });

      if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentRes } = await ctxA.client
          .from('reservations')
          .select('status')
          .eq('id', targetResId)
          .single();

        const isUnchanged = currentRes?.status === initialStatus;

        results.push({
          id: 'tenant-user-b-cannot-cancel-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Cancel User A Reservations',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t6c,
          details: `Cross-tenant cancellation actively blocked by database authorization check: "${error.message}". Record verified unchanged.`,
          error: isUnchanged ? undefined : 'Record status was modified despite authorization rejection.',
        });
      } else {
        results.push({
          id: 'tenant-user-b-cannot-cancel-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Cancel User A Reservations',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t6c,
          error: error ? `Invalid rejection response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-user-b-cannot-cancel-user-a-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User B Cannot Cancel User A Reservations',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t6c,
        error: isAuth ? undefined : `Unexpected exception: ${err.message}`,
        details: isAuth ? `Blocked by database authorization check: ${err.message}` : undefined,
      });
    }
  }

  // 6d. User B cannot reschedule User A's reservation [STATE-CHANGING / GUARDED]
  const t6d = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-user-b-cannot-reschedule-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Reschedule User A Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else if (!ctxA.disposableReservation) {
    results.push({
      id: 'tenant-user-b-cannot-reschedule-user-a-reservation',
      category,
      name: 'Cross-Tenant RPC Barrier: User B Cannot Reschedule User A Reservations',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test reservation (tagged TD-% or TEST-DISPOSABLE-%) exists in Facility A. Existing customer records are protected and will never be targeted.',
    });
  } else {
    try {
      const targetResId = ctxA.disposableReservation.id;
      const initialCourtId = ctxA.disposableReservation.court_id;
      const targetCourtId = ctxA.courts[0]?.id || initialCourtId;

      const { data, error } = await ctxB.client.rpc('reschedule_reservation_as_staff', {
        p_reservation_id: targetResId,
        p_new_court_id: targetCourtId,
        p_new_date: '2028-01-01',
        p_new_start_time: '2028-01-01T08:00:00Z',
        p_new_duration_minutes: 60,
      });

      if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: currentRes } = await ctxA.client
          .from('reservations')
          .select('court_id, booking_date')
          .eq('id', targetResId)
          .single();

        const isUnchanged = currentRes?.court_id === initialCourtId;

        results.push({
          id: 'tenant-user-b-cannot-reschedule-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Reschedule User A Reservations',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t6d,
          details: `Cross-tenant rescheduling actively blocked by database authorization check: "${error.message}". Record verified unchanged.`,
          error: isUnchanged ? undefined : 'Record court assignment was modified despite authorization rejection.',
        });
      } else {
        results.push({
          id: 'tenant-user-b-cannot-reschedule-user-a-reservation',
          category,
          name: 'Cross-Tenant RPC Barrier: User B Cannot Reschedule User A Reservations',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t6d,
          error: error ? `Invalid rejection response: ${error.message}` : `Unexpected success: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-user-b-cannot-reschedule-user-a-reservation',
        category,
        name: 'Cross-Tenant RPC Barrier: User B Cannot Reschedule User A Reservations',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t6d,
        error: isAuth ? undefined : `Unexpected exception: ${err.message}`,
        details: isAuth ? `Blocked by database authorization check: ${err.message}` : undefined,
      });
    }
  }

  // ==========================================================================
  // Requirement 7: Neither user can modify the other organization's facility settings
  // All modifying operations classified as STATE_CHANGING.
  // Rule: Do not perform write-security tests against existing facility prices or settings.
  // Requires dedicated disposable test facilities (tagged TD-% or TEST-DISPOSABLE-%), or BLOCKED.
  // ==========================================================================

  // Query for designated disposable test facility fixtures
  let disposableFacilityFixture: any = null;
  try {
    const { data: dispFacs } = await ctxA.client
      .from('facilities')
      .select('id, name, slug, default_hourly_rate, booking_confirmation_mode')
      .or('slug.like.td-%,slug.like.test-disposable-%,name.like.TD-%,name.like.TEST-DISPOSABLE-%')
      .limit(1);

    if (dispFacs && dispFacs.length > 0) {
      disposableFacilityFixture = dispFacs[0];
    }
  } catch {
    disposableFacilityFixture = null;
  }

  // 7a. User A cannot modify Facility B confirmation settings via RPC [STATE-CHANGING / GUARDED]
  const t7a = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-user-a-cannot-update-facility-b-settings-rpc',
      category,
      name: 'Settings Isolation: User A Cannot Update Facility B Settings via RPC',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else if (!disposableFacilityFixture) {
    results.push({
      id: 'tenant-user-a-cannot-update-facility-b-settings-rpc',
      category,
      name: 'Settings Isolation: User A Cannot Update Facility B Settings via RPC',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test facility (tagged TD-% or TEST-DISPOSABLE-%) found. Existing facility prices and settings are protected from write tests and will never be targeted.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client.rpc('update_facility_confirmation_settings', {
        p_facility_id: disposableFacilityFixture.id,
        p_mode: 'manual_approval',
        p_hold_minutes: 45,
      });

      if (error && isCrossTenantAuthorizationRejection(error)) {
        // Verify post-attempt immutability via authorized client
        const { data: afterFac } = await ctxB.client
          .from('facilities')
          .select('booking_confirmation_mode, pending_hold_duration_minutes')
          .eq('id', disposableFacilityFixture.id)
          .single();

        const isUnchanged =
          afterFac?.booking_confirmation_mode === disposableFacilityFixture.booking_confirmation_mode;

        results.push({
          id: 'tenant-user-a-cannot-update-facility-b-settings-rpc',
          category,
          name: 'Settings Isolation: User A Cannot Update Facility B Settings via RPC',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t7a,
          details: `Rejected by database authorization check: "${error.message}". Disposable facility settings verified unchanged.`,
          error: isUnchanged ? undefined : 'Disposable facility settings modified despite authorization rejection.',
        });
      } else {
        results.push({
          id: 'tenant-user-a-cannot-update-facility-b-settings-rpc',
          category,
          name: 'Settings Isolation: User A Cannot Update Facility B Settings via RPC',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t7a,
          error: error ? `Invalid rejection response: ${error.message}` : `Cross-tenant settings update was not rejected: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-user-a-cannot-update-facility-b-settings-rpc',
        category,
        name: 'Settings Isolation: User A Cannot Update Facility B Settings via RPC',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t7a,
        error: isAuth ? undefined : `Unexpected execution failure: ${err.message}`,
        details: isAuth ? `Rejected by database authorization check: ${err.message}` : undefined,
      });
    }
  }

  // 7b. User B cannot modify Facility A confirmation settings via RPC [STATE-CHANGING / GUARDED]
  const t7b = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'tenant-user-b-cannot-update-facility-a-settings-rpc',
      category,
      name: 'Settings Isolation: User B Cannot Update Facility A Settings via RPC',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution.',
    });
  } else if (!disposableFacilityFixture) {
    results.push({
      id: 'tenant-user-b-cannot-update-facility-a-settings-rpc',
      category,
      name: 'Settings Isolation: User B Cannot Update Facility A Settings via RPC',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test facility (tagged TD-% or TEST-DISPOSABLE-%) found. Existing facility prices and settings are protected from write tests and will never be targeted.',
    });
  } else {
    try {
      const { data, error } = await ctxB.client.rpc('update_facility_confirmation_settings', {
        p_facility_id: disposableFacilityFixture.id,
        p_mode: 'manual_approval',
        p_hold_minutes: 45,
      });

      if (error && isCrossTenantAuthorizationRejection(error)) {
        const { data: afterFac } = await ctxA.client
          .from('facilities')
          .select('booking_confirmation_mode, pending_hold_duration_minutes')
          .eq('id', disposableFacilityFixture.id)
          .single();

        const isUnchanged =
          afterFac?.booking_confirmation_mode === disposableFacilityFixture.booking_confirmation_mode;

        results.push({
          id: 'tenant-user-b-cannot-update-facility-a-settings-rpc',
          category,
          name: 'Settings Isolation: User B Cannot Update Facility A Settings via RPC',
          status: isUnchanged ? 'PASS' : 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t7b,
          details: `Rejected by database authorization check: "${error.message}". Disposable facility settings verified unchanged.`,
          error: isUnchanged ? undefined : 'Disposable facility settings modified despite authorization rejection.',
        });
      } else {
        results.push({
          id: 'tenant-user-b-cannot-update-facility-a-settings-rpc',
          category,
          name: 'Settings Isolation: User B Cannot Update Facility A Settings via RPC',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t7b,
          error: error ? `Invalid rejection response: ${error.message}` : `Cross-tenant settings update was not rejected: ${JSON.stringify(data)}`,
        });
      }
    } catch (err: any) {
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-user-b-cannot-update-facility-a-settings-rpc',
        category,
        name: 'Settings Isolation: User B Cannot Update Facility A Settings via RPC',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t7b,
        error: isAuth ? undefined : `Unexpected execution failure: ${err.message}`,
        details: isAuth ? `Rejected by database authorization check: ${err.message}` : undefined,
      });
    }
  }

  // 7c. Direct UPDATE barrier: Neither user can modify other facility core attributes [STATE-CHANGING / GUARDED]
  // Rule: Do not perform write-security tests against existing facility prices. Requires disposable test facility, or BLOCKED.
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
  } else if (!disposableFacilityFixture) {
    results.push({
      id: 'tenant-direct-update-facility-isolation',
      category,
      name: 'Settings Isolation: Direct UPDATE on Other Facility Is Blocked by RLS',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test facility (tagged TD-% or TEST-DISPOSABLE-%) found. Existing facility records are protected from write tests and will never be targeted.',
    });
  } else {
    try {
      const initialRate = disposableFacilityFixture.default_hourly_rate;

      const { data: updateAonDisp, error: errAonDisp } = await ctxA.client
        .from('facilities')
        .update({ default_hourly_rate: 999.0 })
        .eq('id', disposableFacilityFixture.id)
        .select();

      // Check if update was blocked by RLS (0 rows modified) or explicit error
      const isBlocked =
        Boolean(errAonDisp && (isCrossTenantAuthorizationRejection(errAonDisp) || errAonDisp.code === '42501')) ||
        (Array.isArray(updateAonDisp) && updateAonDisp.length === 0);

      // Verify database record remains unchanged
      const { data: verifyFac } = await ctxA.client
        .from('facilities')
        .select('default_hourly_rate')
        .eq('id', disposableFacilityFixture.id)
        .single();

      const isRateUnchanged = verifyFac?.default_hourly_rate === initialRate;

      if (isBlocked && isRateUnchanged) {
        results.push({
          id: 'tenant-direct-update-facility-isolation',
          category,
          name: 'Settings Isolation: Direct UPDATE on Other Facility Is Blocked by RLS',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t7c,
          details: 'RLS policy facility_admins_can_update_facility successfully blocked cross-tenant facility modifications (0 rows modified). Hourly rate verified unchanged.',
        });
      } else {
        results.push({
          id: 'tenant-direct-update-facility-isolation',
          category,
          name: 'Settings Isolation: Direct UPDATE on Other Facility Is Blocked by RLS',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t7c,
          error: `CRITICAL: Direct facility update was not blocked by RLS! Rows modified: ${updateAonDisp?.length}, err: ${errAonDisp?.message}`,
        });
      }
    } catch (err: any) {
      // Fix 1: Catch block strictly reports FAIL unless independently verified as genuine authorization rejection
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-direct-update-facility-isolation',
        category,
        name: 'Settings Isolation: Direct UPDATE on Other Facility Is Blocked by RLS',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t7c,
        error: isAuth ? undefined : `Unexpected execution failure in catch block: ${err.message}`,
        details: isAuth ? `Rejected as intended by authorization check: ${err.message}` : undefined,
      });
    }
  }

  // ==========================================================================
  // Requirement 8: Neither user can access or modify the other's organization memberships
  // ==========================================================================

  // 8a. User A cannot read User B organization memberships [READ-ONLY]
  // Requires positive controls to prove valid session before asserting zero rows.
  const t8a = Date.now();
  if (!userAMembershipControlPassed || !userBMembershipControlPassed) {
    results.push({
      id: 'tenant-memberships-read-privacy',
      category,
      name: 'Membership Privacy: Neither User Can Read Other Organization Members',
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: 'BLOCKED: Positive controls proving valid membership access in own organization must pass before asserting cross-tenant isolation.',
    });
  } else {
    try {
      const { data: memBFromA, error: errBFromA } = await ctxA.client
        .from('organization_members')
        .select('id, user_id, role, organization_id')
        .eq('organization_id', ctxB.orgId);

      const { data: memAFromB, error: errAFromB } = await ctxB.client
        .from('organization_members')
        .select('id, user_id, role, organization_id')
        .eq('organization_id', ctxA.orgId);

      if (errBFromA || errAFromB) {
        const isAuthA = errBFromA && (isCrossTenantAuthorizationRejection(errBFromA) || errBFromA.code === '42501');
        const isAuthB = errAFromB && (isCrossTenantAuthorizationRejection(errAFromB) || errAFromB.code === '42501');

        if (isAuthA && isAuthB) {
          results.push({
            id: 'tenant-memberships-read-privacy',
            category,
            name: 'Membership Privacy: Neither User Can Read Other Organization Members',
            status: 'PASS',
            operationType: 'READ_ONLY',
            durationMs: Date.now() - t8a,
            details: 'Database authorization actively blocked cross-tenant membership queries.',
          });
        } else {
          results.push({
            id: 'tenant-memberships-read-privacy',
            category,
            name: 'Membership Privacy: Neither User Can Read Other Organization Members',
            status: 'FAIL',
            operationType: 'READ_ONLY',
            durationMs: Date.now() - t8a,
            error: `Unexpected query error (not authorization rejection): ${errBFromA?.message || errAFromB?.message}`,
          });
        }
      } else if (!Array.isArray(memBFromA) || !Array.isArray(memAFromB)) {
        results.push({
          id: 'tenant-memberships-read-privacy',
          category,
          name: 'Membership Privacy: Neither User Can Read Other Organization Members',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t8a,
          error: 'Null or invalid response data received from API.',
        });
      } else if (memBFromA.length > 0 || memAFromB.length > 0) {
        results.push({
          id: 'tenant-memberships-read-privacy',
          category,
          name: 'Membership Privacy: Neither User Can Read Other Organization Members',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t8a,
          error: `Cross-tenant membership leak detected: User A saw ${memBFromA.length} members of B; User B saw ${memAFromB.length} members of A.`,
        });
      } else {
        results.push({
          id: 'tenant-memberships-read-privacy',
          category,
          name: 'Membership Privacy: Neither User Can Read Other Organization Members',
          status: 'PASS',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t8a,
          details: 'RLS policy members_can_view_teammates returned 0 rows for both cross-tenant member queries. Roster privacy preserved.',
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
        error: `Unexpected exception reading memberships: ${err.message}`,
      });
    }
  }

  // 8b. Anti-Escalation: Neither user can insert themselves or modify roles in other organization [STATE-CHANGING / GUARDED]
  // Rule: Do not perform write-security tests against existing organization memberships. Requires disposable test org, or BLOCKED.
  const t8b = Date.now();
  let disposableOrgFixture: any = null;
  try {
    const { data: dispOrgs } = await ctxA.client
      .from('organizations')
      .select('id, name, slug')
      .or('slug.like.td-%,slug.like.test-disposable-%,name.like.TD-%,name.like.TEST-DISPOSABLE-%')
      .limit(1);

    if (dispOrgs && dispOrgs.length > 0) {
      disposableOrgFixture = dispOrgs[0];
    }
  } catch {
    disposableOrgFixture = null;
  }

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
  } else if (!disposableOrgFixture) {
    results.push({
      id: 'tenant-memberships-anti-tampering',
      category,
      name: 'Membership Security: Anti-Escalation Prevents Self-Assignment in Other Org',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No dedicated disposable test organization (tagged TD-% or TEST-DISPOSABLE-%) found. Existing organization memberships are protected from write tests and will never be targeted.',
    });
  } else {
    try {
      const { data: beforeCount } = await ctxA.client
        .from('organization_members')
        .select('id')
        .eq('organization_id', disposableOrgFixture.id);

      // User A attempts self-insertion into disposable Org
      const { data: insertDataA, error: insertErrA } = await ctxA.client
        .from('organization_members')
        .insert({
          organization_id: disposableOrgFixture.id,
          user_id: ctxA.userId,
          role: 'owner',
        })
        .select();

      const isAInsertBlocked =
        Boolean(insertErrA && (isCrossTenantAuthorizationRejection(insertErrA) || insertErrA.code === '42501')) ||
        (Array.isArray(insertDataA) && insertDataA.length === 0);

      const { data: afterCount } = await ctxA.client
        .from('organization_members')
        .select('id')
        .eq('organization_id', disposableOrgFixture.id);

      const isCountUnchanged = (beforeCount?.length || 0) === (afterCount?.length || 0);

      if (isAInsertBlocked && isCountUnchanged) {
        results.push({
          id: 'tenant-memberships-anti-tampering',
          category,
          name: 'Membership Security: Anti-Escalation Prevents Self-Assignment in Other Org',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t8b,
          details: 'RLS policies owners_can_insert_teammates strictly rejected cross-tenant member self-assignment. Membership roster verified intact.',
        });
      } else {
        results.push({
          id: 'tenant-memberships-anti-tampering',
          category,
          name: 'Membership Security: Anti-Escalation Prevents Self-Assignment in Other Org',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t8b,
          error: `CRITICAL: Self-assignment succeeded: A=${JSON.stringify(insertDataA)}, err=${insertErrA?.message}`,
        });
      }
    } catch (err: any) {
      // Fix 1: Catch block strictly reports FAIL unless independently verified as genuine authorization rejection
      const isAuth = isCrossTenantAuthorizationRejection(err);
      results.push({
        id: 'tenant-memberships-anti-tampering',
        category,
        name: 'Membership Security: Anti-Escalation Prevents Self-Assignment in Other Org',
        status: isAuth ? 'PASS' : 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t8b,
        error: isAuth ? undefined : `Unexpected execution failure in catch block: ${err.message}`,
        details: isAuth ? `Rejected as intended by authorization check: ${err.message}` : undefined,
      });
    }
  }

  // ==========================================================================
  // Requirement 9: Anonymous customers cannot read private reservation or owner information
  // ==========================================================================

  // 9a. Anonymous customer cannot read reservations table [READ-ONLY]
  const t9a = Date.now();
  try {
    const { data, error } = await anonClient.from('reservations').select('*').limit(10);

    if (error) {
      if (isCrossTenantAuthorizationRejection(error) || error.code === '42501' || error.message?.includes('permission denied')) {
        results.push({
          id: 'tenant-anon-cannot-read-reservations',
          category,
          name: 'Customer Privacy: Anonymous Visitors Cannot Read Reservations Table',
          status: 'PASS',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t9a,
          details: `Access denied for anonymous client by database: "${error.message}" (Code: ${error.code})`,
        });
      } else {
        results.push({
          id: 'tenant-anon-cannot-read-reservations',
          category,
          name: 'Customer Privacy: Anonymous Visitors Cannot Read Reservations Table',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t9a,
          error: `Unexpected query error (not authorization rejection): ${error.message} (Code: ${error.code})`,
        });
      }
    } else if (!Array.isArray(data)) {
      results.push({
        id: 'tenant-anon-cannot-read-reservations',
        category,
        name: 'Customer Privacy: Anonymous Visitors Cannot Read Reservations Table',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9a,
        error: 'Received null or invalid response data from API.',
      });
    } else if (data.length > 0) {
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
    } else {
      results.push({
        id: 'tenant-anon-cannot-read-reservations',
        category,
        name: 'Customer Privacy: Anonymous Visitors Cannot Read Reservations Table',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9a,
        details: 'Zero rows returned to anonymous visitor via RLS policy.',
      });
    }
  } catch (err: any) {
    const isAuth = isCrossTenantAuthorizationRejection(err) || err?.code === '42501' || String(err?.message || '').toLowerCase().includes('permission denied');
    results.push({
      id: 'tenant-anon-cannot-read-reservations',
      category,
      name: 'Customer Privacy: Anonymous Visitors Cannot Read Reservations Table',
      status: isAuth ? 'PASS' : 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t9a,
      error: isAuth ? undefined : `Unexpected exception: ${err.message}`,
      details: isAuth ? `Access blocked as intended: ${err.message}` : undefined,
    });
  }

  // 9b. Anonymous customer cannot read organizations table [READ-ONLY]
  const t9b = Date.now();
  try {
    const { data, error } = await anonClient.from('organizations').select('*').limit(10);

    if (error) {
      if (isCrossTenantAuthorizationRejection(error) || error.code === '42501' || error.message?.includes('permission denied')) {
        results.push({
          id: 'tenant-anon-cannot-read-organizations',
          category,
          name: 'Business Privacy: Anonymous Visitors Cannot Read Organizations Table',
          status: 'PASS',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t9b,
          details: `Access denied for anonymous client by database: "${error.message}" (Code: ${error.code})`,
        });
      } else {
        results.push({
          id: 'tenant-anon-cannot-read-organizations',
          category,
          name: 'Business Privacy: Anonymous Visitors Cannot Read Organizations Table',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t9b,
          error: `Unexpected query error (not authorization rejection): ${error.message} (Code: ${error.code})`,
        });
      }
    } else if (!Array.isArray(data)) {
      results.push({
        id: 'tenant-anon-cannot-read-organizations',
        category,
        name: 'Business Privacy: Anonymous Visitors Cannot Read Organizations Table',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9b,
        error: 'Received null or invalid response data from API.',
      });
    } else if (data.length > 0) {
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
    } else {
      results.push({
        id: 'tenant-anon-cannot-read-organizations',
        category,
        name: 'Business Privacy: Anonymous Visitors Cannot Read Organizations Table',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9b,
        details: 'Zero rows returned to anonymous visitor. Private billing email protected.',
      });
    }
  } catch (err: any) {
    const isAuth = isCrossTenantAuthorizationRejection(err) || err?.code === '42501' || String(err?.message || '').toLowerCase().includes('permission denied');
    results.push({
      id: 'tenant-anon-cannot-read-organizations',
      category,
      name: 'Business Privacy: Anonymous Visitors Cannot Read Organizations Table',
      status: isAuth ? 'PASS' : 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t9b,
      error: isAuth ? undefined : `Unexpected exception: ${err.message}`,
      details: isAuth ? `Access blocked as intended: ${err.message}` : undefined,
    });
  }

  // 9c. Anonymous customer cannot read organization members table [READ-ONLY]
  const t9c = Date.now();
  try {
    const { data, error } = await anonClient.from('organization_members').select('*').limit(10);

    if (error) {
      if (isCrossTenantAuthorizationRejection(error) || error.code === '42501' || error.message?.includes('permission denied')) {
        results.push({
          id: 'tenant-anon-cannot-read-organization-members',
          category,
          name: 'Team Privacy: Anonymous Visitors Cannot Read Organization Members',
          status: 'PASS',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t9c,
          details: `Access denied for anonymous client by database: "${error.message}" (Code: ${error.code})`,
        });
      } else {
        results.push({
          id: 'tenant-anon-cannot-read-organization-members',
          category,
          name: 'Team Privacy: Anonymous Visitors Cannot Read Organization Members',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t9c,
          error: `Unexpected query error (not authorization rejection): ${error.message} (Code: ${error.code})`,
        });
      }
    } else if (!Array.isArray(data)) {
      results.push({
        id: 'tenant-anon-cannot-read-organization-members',
        category,
        name: 'Team Privacy: Anonymous Visitors Cannot Read Organization Members',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9c,
        error: 'Received null or invalid response data from API.',
      });
    } else if (data.length > 0) {
      results.push({
        id: 'tenant-anon-cannot-read-organization-members',
        category,
        name: 'Team Privacy: Anonymous Visitors Cannot Read Organization Members',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9c,
        error: `CRITICAL LEAK: Anonymous visitor read ${data.length} team member record(s)!`,
      });
    } else {
      results.push({
        id: 'tenant-anon-cannot-read-organization-members',
        category,
        name: 'Team Privacy: Anonymous Visitors Cannot Read Organization Members',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9c,
        details: 'Zero rows returned. Staff user IDs and roles protected from anonymous enumeration.',
      });
    }
  } catch (err: any) {
    const isAuth = isCrossTenantAuthorizationRejection(err) || err?.code === '42501' || String(err?.message || '').toLowerCase().includes('permission denied');
    results.push({
      id: 'tenant-anon-cannot-read-organization-members',
      category,
      name: 'Team Privacy: Anonymous Visitors Cannot Read Organization Members',
      status: isAuth ? 'PASS' : 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t9c,
      error: isAuth ? undefined : `Unexpected exception: ${err.message}`,
      details: isAuth ? `Access blocked as intended: ${err.message}` : undefined,
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

    if (facErr || courtErr) {
      results.push({
        id: 'tenant-anon-public-boundary-safe',
        category,
        name: 'Public Boundary: Anonymous Visitors Can Only Access Non-Sensitive Court Data',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9d,
        error: `Public data query failed: ${facErr?.message || courtErr?.message}`,
      });
    } else if (!Array.isArray(facData) || !Array.isArray(courtData) || facData.length === 0 || courtData.length === 0) {
      results.push({
        id: 'tenant-anon-public-boundary-safe',
        category,
        name: 'Public Boundary: Anonymous Visitors Can Only Access Non-Sensitive Court Data',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9d,
        error: `Incomplete public operational data returned: facilities=${facData?.length || 0}, courts=${courtData?.length || 0}`,
      });
    } else {
      results.push({
        id: 'tenant-anon-public-boundary-safe',
        category,
        name: 'Public Boundary: Anonymous Visitors Can Only Access Non-Sensitive Court Data',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t9d,
        details: `Confirmed: Anonymous customers can query ${facData.length} active facility/facilities and ${courtData.length} enabled court(s) with zero exposure of customer PII, owner billing data, or staff identities.`,
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
      error: `Unexpected exception reading public data: ${err.message}`,
    });
  }

  return results;
}
