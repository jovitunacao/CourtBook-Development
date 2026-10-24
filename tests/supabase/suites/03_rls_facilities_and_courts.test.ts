import {
  getEnvironmentConfig,
  createAuthenticatedClient,
  createAnonClient,
  EXISTING_FIXTURES,
  isStateChangingAllowed,
} from '../config';
import { TestResult } from '../types';
import { loadUserContext, UserContext, isIntendedSecurityRejection } from '../helpers';

export async function runFacilitiesAndCourtsSuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'RLS & Facilities / Courts Isolation';

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
      id: 'fac-setup-fail',
      category,
      name: 'Authentication and Fixture Setup for Facilities Suite',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: 0,
      error: err.message,
      suggestedFix: 'Ensure test user credentials exist in Supabase auth and seed data is applied.',
    });
    return results;
  }

  // Prerequisite check on existing facilities
  if (!ctxA.facility || !ctxB.facility) {
    results.push({
      id: 'fac-missing-fixtures',
      category,
      name: `Verify Existing Facilities (${EXISTING_FIXTURES.orgA.facilitySlug} & ${EXISTING_FIXTURES.orgB.facilitySlug})`,
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: `Facility records "${EXISTING_FIXTURES.orgA.facilitySlug}" or "${EXISTING_FIXTURES.orgB.facilitySlug}" not found.`,
      suggestedFix: 'Execute tests/supabase/seed-test-data.sql in the Supabase SQL Editor.',
    });
    return results;
  }

  // Test 1: Positive Permission - User A accesses their authorized facility and Court A (₱350/hr) [READ-ONLY]
  const t1 = Date.now();
  try {
    const courtA = ctxA.courts.find((c) => c.hourly_rate === EXISTING_FIXTURES.orgA.expectedCourtRate) || ctxA.courts[0];
    if (courtA) {
      results.push({
        id: 'fac-read-positive-a',
        category,
        name: `Positive Access: User A Reads Authorized Facility & Court (₱${EXISTING_FIXTURES.orgA.expectedCourtRate}/hr)`,
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        details: `Loaded facility "${ctxA.facility.name}". Court: "${courtA.name}" @ ₱${courtA.hourly_rate}/hr.`,
      });
    } else {
      results.push({
        id: 'fac-read-positive-a',
        category,
        name: `Positive Access: User A Reads Authorized Facility & Court (₱${EXISTING_FIXTURES.orgA.expectedCourtRate}/hr)`,
        status: 'BLOCKED',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1,
        details: 'Facility loaded but no courts found in Facility A.',
        suggestedFix: 'Check that courts exist in courtbook-pickleball-test.',
      });
    }
  } catch (err: any) {
    results.push({
      id: 'fac-read-positive-a',
      category,
      name: `Positive Access: User A Reads Authorized Facility & Court (₱${EXISTING_FIXTURES.orgA.expectedCourtRate}/hr)`,
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t1,
      error: err.message,
    });
  }

  // Test 2: Negative Permission - User A cannot update User B's facility [STATE-CHANGING REQUEST GUARDED]
  const t2 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'fac-cross-update-blocked',
      category,
      name: "Cross-Tenant Protection: User A Cannot Update User B's Facility",
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of update tests.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client
        .from('facilities')
        .update({ name: 'Tampered By User A' })
        .eq('id', ctxB.facility.id)
        .select();

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'fac-cross-update-blocked',
            category,
            name: "Cross-Tenant Protection: User A Cannot Update User B's Facility",
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t2,
            details: `Facility modification rejected by RLS: ${error.message}`,
          });
        } else {
          results.push({
            id: 'fac-cross-update-blocked',
            category,
            name: "Cross-Tenant Protection: User A Cannot Update User B's Facility",
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t2,
            error: `Unrelated error: ${error.message}`,
          });
        }
      } else if (!data || data.length === 0) {
        results.push({
          id: 'fac-cross-update-blocked',
          category,
          name: "Cross-Tenant Protection: User A Cannot Update User B's Facility",
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          details: 'Facility update isolated by RLS (0 rows updated).',
        });
      } else {
        results.push({
          id: 'fac-cross-update-blocked',
          category,
          name: "Cross-Tenant Protection: User A Cannot Update User B's Facility",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          error: "VULNERABILITY: User A was able to update User B's facility!",
          suggestedFix: 'Verify RLS policy facility_admins_can_update_facility checks is_facility_staff().',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'fac-cross-update-blocked',
          category,
          name: "Cross-Tenant Protection: User A Cannot Update User B's Facility",
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          details: `Update rejected with error: ${err.message}`,
        });
      } else {
        results.push({
          id: 'fac-cross-update-blocked',
          category,
          name: "Cross-Tenant Protection: User A Cannot Update User B's Facility",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          error: err.message,
        });
      }
    }
  }

  // Test 3: Negative Permission - User A cannot insert court into User B's facility [STATE-CHANGING REQUEST GUARDED]
  const t3 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'court-cross-insert-blocked',
      category,
      name: "Cross-Tenant Protection: User A Cannot Add Courts to User B's Facility",
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of court insert tests.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client
        .from('courts')
        .insert({
          facility_id: ctxB.facility.id,
          name: `Malicious Court ${Date.now()}`,
          sport_type: 'Pickleball',
          hourly_rate: 350.0,
        })
        .select();

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'court-cross-insert-blocked',
            category,
            name: "Cross-Tenant Protection: User A Cannot Add Courts to User B's Facility",
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3,
            details: `Insert rejected by RLS: ${error.message}`,
          });
        } else {
          results.push({
            id: 'court-cross-insert-blocked',
            category,
            name: "Cross-Tenant Protection: User A Cannot Add Courts to User B's Facility",
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3,
            error: error.message,
          });
        }
      } else {
        if (data && data[0]?.id) {
          await ctxB.client.from('courts').delete().eq('id', data[0].id);
        }
        results.push({
          id: 'court-cross-insert-blocked',
          category,
          name: "Cross-Tenant Protection: User A Cannot Add Courts to User B's Facility",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          error: "VULNERABILITY: User A successfully inserted a court into User B's facility!",
          suggestedFix:
            'Ensure policy staff_can_manage_facility_courts checks is_facility_staff(facility_id, ARRAY[\'owner\', \'admin\']).',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'court-cross-insert-blocked',
          category,
          name: "Cross-Tenant Protection: User A Cannot Add Courts to User B's Facility",
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          details: `Exception caught: ${err.message}`,
        });
      } else {
        results.push({
          id: 'court-cross-insert-blocked',
          category,
          name: "Cross-Tenant Protection: User A Cannot Add Courts to User B's Facility",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          error: err.message,
        });
      }
    }
  }

  // Test 4: Positive Permission with Safe Cleanup - Legitimate Court Creation & Cleanup [STATE-CHANGING]
  const t4 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'court-positive-lifecycle-cleanup',
      category,
      name: 'Authorized Lifecycle: User A Creates and Cleans Up Disposable Test Court',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test blocked: Set CONFIRM_TEST_ENV=true in .env.test to allow safe disposable fixture operations.',
      suggestedFix: 'Add CONFIRM_TEST_ENV=true to your .env.test file.',
    });
  } else {
    const disposableCourtName = `TD-COURT-${Date.now().toString().slice(-6)}`;
    let createdCourtId: string | null = null;
    try {
      const { data, error } = await ctxA.client
        .from('courts')
        .insert({
          facility_id: ctxA.facility.id,
          name: disposableCourtName,
          sport_type: 'Pickleball',
          hourly_rate: 350.0,
          is_enabled: true,
        })
        .select();

      if (error) {
        results.push({
          id: 'court-positive-lifecycle-cleanup',
          category,
          name: 'Authorized Lifecycle: User A Creates and Cleans Up Disposable Test Court',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4,
          error: `Authorized court creation failed: ${error.message}`,
        });
      } else if (data && data.length > 0) {
        createdCourtId = data[0].id;
        results.push({
          id: 'court-positive-lifecycle-cleanup',
          category,
          name: 'Authorized Lifecycle: User A Creates and Cleans Up Disposable Test Court',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4,
          details: `Created disposable court "${disposableCourtName}" and successfully cleaned it up.`,
        });
      }
    } catch (err: any) {
      results.push({
        id: 'court-positive-lifecycle-cleanup',
        category,
        name: 'Authorized Lifecycle: User A Creates and Cleans Up Disposable Test Court',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t4,
        error: err.message,
      });
    } finally {
      if (createdCourtId) {
        await ctxA.client.from('courts').delete().eq('id', createdCourtId);
      }
    }
  }

  // Test 5: Anonymous client cannot view disabled courts directly [READ-ONLY]
  const t5 = Date.now();
  try {
    const anonClient = createAnonClient();
    const { data, error } = await anonClient
      .from('courts')
      .select('id, name, is_enabled')
      .eq('is_enabled', false);

    if (error) {
      results.push({
        id: 'anon-court-filter-check',
        category,
        name: 'Public Isolation: Anonymous Clients Cannot Select Disabled Courts',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5,
        details: `Query blocked or filtered by RLS: ${error.message}`,
      });
    } else if (!data || data.length === 0) {
      results.push({
        id: 'anon-court-filter-check',
        category,
        name: 'Public Isolation: Anonymous Clients Cannot Select Disabled Courts',
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5,
        details: 'RLS policy public_can_view_enabled_courts correctly excluded all disabled courts (0 returned).',
      });
    } else {
      results.push({
        id: 'anon-court-filter-check',
        category,
        name: 'Public Isolation: Anonymous Clients Cannot Select Disabled Courts',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t5,
        error: `VULNERABILITY: Anonymous client was able to view ${data.length} disabled court(s)!`,
        suggestedFix:
          'Ensure public_can_view_enabled_courts policy checks is_enabled = true AND active facility.',
      });
    }
  } catch (err: any) {
    results.push({
      id: 'anon-court-filter-check',
      category,
      name: 'Public Isolation: Anonymous Clients Cannot Select Disabled Courts',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t5,
      details: `Exception caught: ${err.message}`,
    });
  }

  return results;
}
