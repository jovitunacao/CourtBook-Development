import {
  getEnvironmentConfig,
  createAuthenticatedClient,
  EXISTING_FIXTURES,
  isStateChangingAllowed,
} from '../config';
import { TestResult } from '../types';
import { loadUserContext, UserContext, isIntendedSecurityRejection } from '../helpers';

export async function runMaintenanceBlocksSuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'Maintenance Blocks & Overlap Prevention';

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
      id: 'blocks-setup-fail',
      category,
      name: 'Authentication and Fixture Setup for Maintenance Tests',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: 0,
      error: err.message,
      suggestedFix: 'Ensure test user credentials exist in Supabase auth and seed data is applied.',
    });
    return results;
  }

  if (!ctxA.facility || !ctxA.enabledCourt || !ctxB.facility) {
    results.push({
      id: 'blocks-fixtures-missing',
      category,
      name: 'Maintenance Block Fixtures Verification',
      status: 'BLOCKED',
      operationType: 'READ_ONLY',
      durationMs: 0,
      details: 'Facility or court fixtures not loaded for courtbook-pickleball-test.',
      suggestedFix: 'Execute tests/supabase/seed-test-data.sql.',
    });
    return results;
  }

  // Test 1: Cross-tenant block insertion prevention [STATE-CHANGING REQUEST GUARDED]
  const t1 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'block-cross-insert-rejected',
      category,
      name: "Cross-Tenant Protection: User B Cannot Place Maintenance Block on User A's Court",
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of block tests.',
    });
  } else {
    try {
      const { data, error } = await ctxB.client
        .from('court_blocked_times')
        .insert({
          facility_id: ctxA.facility.id,
          court_id: ctxA.enabledCourt.id,
          start_time: '2026-11-20T08:00:00Z',
          end_time: '2026-11-20T10:00:00Z',
          reason: 'Hostile maintenance block from User B',
        })
        .select();

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'block-cross-insert-rejected',
            category,
            name: "Cross-Tenant Protection: User B Cannot Place Maintenance Block on User A's Court",
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t1,
            details: `Cross-tenant block rejected: ${error.message}`,
          });
        } else {
          results.push({
            id: 'block-cross-insert-rejected',
            category,
            name: "Cross-Tenant Protection: User B Cannot Place Maintenance Block on User A's Court",
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t1,
            error: error.message,
          });
        }
      } else {
        if (data && data[0]?.id) {
          await ctxA.client.from('court_blocked_times').delete().eq('id', data[0].id);
        }
        results.push({
          id: 'block-cross-insert-rejected',
          category,
          name: "Cross-Tenant Protection: User B Cannot Place Maintenance Block on User A's Court",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          error: "VULNERABILITY: User B successfully inserted a blocked schedule on User A's court!",
          suggestedFix: 'Ensure policy staff_can_manage_blocked_times checks is_facility_staff(facility_id).',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'block-cross-insert-rejected',
          category,
          name: "Cross-Tenant Protection: User B Cannot Place Maintenance Block on User A's Court",
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          details: `Exception caught: ${err.message}`,
        });
      } else {
        results.push({
          id: 'block-cross-insert-rejected',
          category,
          name: "Cross-Tenant Protection: User B Cannot Place Maintenance Block on User A's Court",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t1,
          error: err.message,
        });
      }
    }
  }

  // Test 2: Cannot place maintenance block over confirmed customer reservation [STATE-CHANGING REQUEST GUARDED]
  const t2 = Date.now();
  const confirmedRes = ctxA.disposableReservation;
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'block-collision-with-res',
      category,
      name: 'Collision Guard: Cannot Place Maintenance Block Over Confirmed Reservation',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test.',
    });
  } else if (!confirmedRes) {
    results.push({
      id: 'block-collision-with-res',
      category,
      name: 'Collision Guard: Cannot Place Maintenance Block Over Confirmed Reservation',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'No confirmed test reservation (TD-CONF-001) found in Facility A to verify collision guard.',
      suggestedFix: 'seed-test-data.sql includes a sample confirmed booking for this test.',
    });
  } else {
    try {
      const { data, error } = await ctxA.client
        .from('court_blocked_times')
        .insert({
          facility_id: ctxA.facility.id,
          court_id: confirmedRes.court_id,
          start_time: confirmedRes.start_time,
          end_time: confirmedRes.end_time,
          reason: 'Attempting to block over customer reservation',
        })
        .select();

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'block-collision-with-res',
            category,
            name: 'Collision Guard: Cannot Place Maintenance Block Over Confirmed Reservation',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t2,
            details: `Collision guard trigger tr_validate_block_against_reservations rejected block: ${error.message}`,
          });
        } else {
          results.push({
            id: 'block-collision-with-res',
            category,
            name: 'Collision Guard: Cannot Place Maintenance Block Over Confirmed Reservation',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t2,
            error: error.message,
          });
        }
      } else {
        if (data && data[0]?.id) {
          await ctxA.client.from('court_blocked_times').delete().eq('id', data[0].id);
        }
        results.push({
          id: 'block-collision-with-res',
          category,
          name: 'Collision Guard: Cannot Place Maintenance Block Over Confirmed Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          error: 'INTEGRITY VIOLATION: A maintenance block was allowed on top of a confirmed reservation!',
          suggestedFix: 'Ensure trigger tr_validate_block_against_reservations validates block range against active reservations.',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'block-collision-with-res',
          category,
          name: 'Collision Guard: Cannot Place Maintenance Block Over Confirmed Reservation',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          details: `Exception caught: ${err.message}`,
        });
      } else {
        results.push({
          id: 'block-collision-with-res',
          category,
          name: 'Collision Guard: Cannot Place Maintenance Block Over Confirmed Reservation',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t2,
          error: err.message,
        });
      }
    }
  }

  // Test 3: Double-Block Exclusion Constraint with Safe Cleanup [STATE-CHANGING]
  const t3 = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'block-overlap-exclusion',
      category,
      name: 'Exclusion Constraint: Overlapping Maintenance Blocks Are Rejected (With Cleanup)',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test blocked: Set CONFIRM_TEST_ENV=true in .env.test to allow safe disposable fixture operations.',
      suggestedFix: 'Set CONFIRM_TEST_ENV=true in .env.test.',
    });
  } else {
    let createdBlockId: string | null = null;
    const blockStart = '2026-11-28T01:00:00Z';
    const blockEnd = '2026-11-28T03:00:00Z';

    try {
      const { data: b1, error: e1 } = await ctxA.client
        .from('court_blocked_times')
        .insert({
          facility_id: ctxA.facility.id,
          court_id: ctxA.enabledCourt.id,
          start_time: blockStart,
          end_time: blockEnd,
          reason: `TD-BLOCK-${Date.now().toString().slice(-6)}`,
        })
        .select();

      if (e1) {
        results.push({
          id: 'block-overlap-exclusion',
          category,
          name: 'Exclusion Constraint: Overlapping Maintenance Blocks Are Rejected (With Cleanup)',
          status: 'BLOCKED',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3,
          details: `Base block insertion could not be created: ${e1.message}`,
        });
      } else if (b1 && b1.length > 0) {
        createdBlockId = b1[0].id;

        const overlapStart = '2026-11-28T02:00:00Z';
        const overlapEnd = '2026-11-28T04:00:00Z';

        const { data: b2, error: e2 } = await ctxA.client
          .from('court_blocked_times')
          .insert({
            facility_id: ctxA.facility.id,
            court_id: ctxA.enabledCourt.id,
            start_time: overlapStart,
            end_time: overlapEnd,
            reason: 'Conflicting block overlap test',
          })
          .select();

        if (e2 && isIntendedSecurityRejection(e2)) {
          results.push({
            id: 'block-overlap-exclusion',
            category,
            name: 'Exclusion Constraint: Overlapping Maintenance Blocks Are Rejected (With Cleanup)',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3,
            details: `PostgreSQL btree_gist exclusion rejected overlapping block: ${e2.message}`,
          });
        } else if (e2) {
          results.push({
            id: 'block-overlap-exclusion',
            category,
            name: 'Exclusion Constraint: Overlapping Maintenance Blocks Are Rejected (With Cleanup)',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3,
            error: `Unrelated error: ${e2.message}`,
          });
        } else {
          if (b2 && b2[0]?.id) {
            await ctxA.client.from('court_blocked_times').delete().eq('id', b2[0].id);
          }
          results.push({
            id: 'block-overlap-exclusion',
            category,
            name: 'Exclusion Constraint: Overlapping Maintenance Blocks Are Rejected (With Cleanup)',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3,
            error: 'CONSTRAINT FAILURE: Overlapping maintenance blocks were allowed on the same court!',
            suggestedFix: 'Ensure constraint prevent_overlapping_court_blocks is applied on public.court_blocked_times.',
          });
        }
      }
    } catch (err: any) {
      results.push({
        id: 'block-overlap-exclusion',
        category,
        name: 'Exclusion Constraint: Overlapping Maintenance Blocks Are Rejected (With Cleanup)',
        status: 'FAIL',
        operationType: 'STATE_CHANGING',
        durationMs: Date.now() - t3,
        error: err.message,
      });
    } finally {
      if (createdBlockId) {
        await ctxA.client.from('court_blocked_times').delete().eq('id', createdBlockId);
      }
    }
  }

  return results;
}
