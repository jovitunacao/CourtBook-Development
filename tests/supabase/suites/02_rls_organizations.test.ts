import {
  getEnvironmentConfig,
  createAuthenticatedClient,
  EXISTING_FIXTURES,
  isStateChangingAllowed,
} from '../config';
import { TestResult } from '../types';
import { isIntendedSecurityRejection } from '../helpers';

export async function runOrganizationsSuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'RLS & Organization Isolation';

  let clientA: any;
  let userIdA: string;
  let clientB: any;
  let userIdB: string;

  try {
    const authA = await createAuthenticatedClient(config.userAEmail, config.userAPassword);
    clientA = authA.client;
    userIdA = authA.userId;

    const authB = await createAuthenticatedClient(config.userBEmail, config.userBPassword);
    clientB = authB.client;
    userIdB = authB.userId;
  } catch (setupErr: any) {
    results.push({
      id: 'org-setup-fail',
      category,
      name: 'Authentication Setup for Organization Tests',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: 0,
      error: setupErr.message,
      suggestedFix: 'Ensure test user credentials exist and match Supabase auth.',
    });
    return results;
  }

  let orgAId: string | null = null;
  let orgBId: string | null = null;

  // Test 1: User A accesses their authorized organization (courtbook-test-pickleball-a) [READ-ONLY]
  const t1Start = Date.now();
  try {
    const { data, error } = await clientA
      .from('organizations')
      .select('id, name, slug')
      .eq('slug', EXISTING_FIXTURES.orgA.slug)
      .limit(1);

    if (error) {
      results.push({
        id: 'org-read-user-a',
        category,
        name: `User A Accesses Authorized Organization (${EXISTING_FIXTURES.orgA.slug})`,
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1Start,
        error: error.message,
      });
    } else if (!data || data.length === 0) {
      results.push({
        id: 'org-read-user-a',
        category,
        name: `User A Accesses Authorized Organization (${EXISTING_FIXTURES.orgA.slug})`,
        status: 'BLOCKED',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1Start,
        details: `Organization with slug "${EXISTING_FIXTURES.orgA.slug}" not found or User A is not a member.`,
        suggestedFix:
          'Ensure tests/supabase/seed-test-data.sql has been executed to link User A to the organization.',
      });
    } else {
      orgAId = data[0].id;
      results.push({
        id: 'org-read-user-a',
        category,
        name: `User A Accesses Authorized Organization (${EXISTING_FIXTURES.orgA.slug})`,
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t1Start,
        details: `Authorized read successful. Org ID: ${orgAId}, Name: "${data[0].name}"`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'org-read-user-a',
      category,
      name: `User A Accesses Authorized Organization (${EXISTING_FIXTURES.orgA.slug})`,
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t1Start,
      error: err.message,
    });
  }

  // Test 2: User B accesses their authorized organization (courtbook-test-badminton-b) [READ-ONLY]
  const t2Start = Date.now();
  try {
    const { data, error } = await clientB
      .from('organizations')
      .select('id, name, slug')
      .eq('slug', EXISTING_FIXTURES.orgB.slug)
      .limit(1);

    if (error) {
      results.push({
        id: 'org-read-user-b',
        category,
        name: `User B Accesses Authorized Organization (${EXISTING_FIXTURES.orgB.slug})`,
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t2Start,
        error: error.message,
      });
    } else if (!data || data.length === 0) {
      results.push({
        id: 'org-read-user-b',
        category,
        name: `User B Accesses Authorized Organization (${EXISTING_FIXTURES.orgB.slug})`,
        status: 'BLOCKED',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t2Start,
        details: `Organization with slug "${EXISTING_FIXTURES.orgB.slug}" not found or User B is not a member.`,
        suggestedFix:
          'Ensure tests/supabase/seed-test-data.sql has been executed to link User B to the organization.',
      });
    } else {
      orgBId = data[0].id;
      results.push({
        id: 'org-read-user-b',
        category,
        name: `User B Accesses Authorized Organization (${EXISTING_FIXTURES.orgB.slug})`,
        status: 'PASS',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t2Start,
        details: `Authorized read successful. Org ID: ${orgBId}, Name: "${data[0].name}"`,
      });
    }
  } catch (err: any) {
    results.push({
      id: 'org-read-user-b',
      category,
      name: `User B Accesses Authorized Organization (${EXISTING_FIXTURES.orgB.slug})`,
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t2Start,
      error: err.message,
    });
  }

  // Test 3: User A cannot modify User B's organization [STATE-CHANGING REQUEST GUARDED]
  const t3Start = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'org-cross-update-a-to-b',
      category,
      name: "Cross-Tenant Protection: User A Cannot Modify User B's Organization",
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of update tests.',
    });
  } else if (!orgBId) {
    results.push({
      id: 'org-cross-update-a-to-b',
      category,
      name: "Cross-Tenant Protection: User A Cannot Modify User B's Organization",
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'User B organization ID was not retrieved, skipping cross-tenant update test.',
    });
  } else {
    try {
      const { data, error } = await clientA
        .from('organizations')
        .update({ name: 'Tampered By User A' })
        .eq('id', orgBId)
        .select();

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'org-cross-update-a-to-b',
            category,
            name: "Cross-Tenant Protection: User A Cannot Modify User B's Organization",
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3Start,
            details: `Modification rejected by database RLS: ${error.message}`,
          });
        } else {
          results.push({
            id: 'org-cross-update-a-to-b',
            category,
            name: "Cross-Tenant Protection: User A Cannot Modify User B's Organization",
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t3Start,
            error: `Unrelated error encountered instead of RLS rejection: ${error.message}`,
          });
        }
      } else if (!data || data.length === 0) {
        results.push({
          id: 'org-cross-update-a-to-b',
          category,
          name: "Cross-Tenant Protection: User A Cannot Modify User B's Organization",
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3Start,
          details: 'RLS isolated the row: 0 records modified by unauthorized user.',
        });
      } else {
        results.push({
          id: 'org-cross-update-a-to-b',
          category,
          name: "Cross-Tenant Protection: User A Cannot Modify User B's Organization",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3Start,
          error: "VULNERABILITY: User A was able to modify User B's organization record!",
          suggestedFix:
            'Ensure RLS policy "org_owners_can_update_organization" requires is_org_member(id, ARRAY[\'owner\']).',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'org-cross-update-a-to-b',
          category,
          name: "Cross-Tenant Protection: User A Cannot Modify User B's Organization",
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3Start,
          details: `Rejected with security exception: ${err.message}`,
        });
      } else {
        results.push({
          id: 'org-cross-update-a-to-b',
          category,
          name: "Cross-Tenant Protection: User A Cannot Modify User B's Organization",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t3Start,
          error: `Unexpected failure: ${err.message}`,
        });
      }
    }
  }

  // Test 4: Privilege Escalation Prevention - User A cannot self-grant membership [STATE-CHANGING REQUEST GUARDED]
  const t4Start = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'org-escalate-a-to-b',
      category,
      name: "Anti-Escalation: User A Cannot Self-Assign Membership in User B's Organization",
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of membership tests.',
    });
  } else if (!orgBId) {
    results.push({
      id: 'org-escalate-a-to-b',
      category,
      name: "Anti-Escalation: User A Cannot Self-Assign Membership in User B's Organization",
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'User B organization ID missing, skipping test.',
    });
  } else {
    try {
      const { data, error } = await clientA
        .from('organization_members')
        .insert({
          organization_id: orgBId,
          user_id: userIdA,
          role: 'owner',
        })
        .select();

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'org-escalate-a-to-b',
            category,
            name: "Anti-Escalation: User A Cannot Self-Assign Membership in User B's Organization",
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t4Start,
            details: `Self-assignment rejected by RLS: ${error.message}`,
          });
        } else {
          results.push({
            id: 'org-escalate-a-to-b',
            category,
            name: "Anti-Escalation: User A Cannot Self-Assign Membership in User B's Organization",
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t4Start,
            error: `Unrelated error encountered: ${error.message}`,
          });
        }
      } else {
        results.push({
          id: 'org-escalate-a-to-b',
          category,
          name: "Anti-Escalation: User A Cannot Self-Assign Membership in User B's Organization",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4Start,
          error:
            "CRITICAL VULNERABILITY: User A successfully inserted a membership record into User B's organization!",
          suggestedFix:
            'Verify RLS policy "owners_can_insert_teammates" requires is_org_member(organization_id, ARRAY[\'owner\']).',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'org-escalate-a-to-b',
          category,
          name: "Anti-Escalation: User A Cannot Self-Assign Membership in User B's Organization",
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4Start,
          details: `Rejected with security exception: ${err.message}`,
        });
      } else {
        results.push({
          id: 'org-escalate-a-to-b',
          category,
          name: "Anti-Escalation: User A Cannot Self-Assign Membership in User B's Organization",
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t4Start,
          error: `Unexpected error: ${err.message}`,
        });
      }
    }
  }

  // Test 5: Anti-Self-Promotion - Users cannot alter their own membership role [STATE-CHANGING REQUEST GUARDED]
  const t5Start = Date.now();
  if (!isStateChangingAllowed()) {
    results.push({
      id: 'org-anti-self-promotion',
      category,
      name: 'Anti-Self-Promotion: Users Cannot Alter Their Own Membership Record',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'State-changing test guarded: Set CONFIRM_TEST_ENV=true in .env.test to allow execution of role tests.',
    });
  } else if (!orgAId) {
    results.push({
      id: 'org-anti-self-promotion',
      category,
      name: 'Anti-Self-Promotion: Users Cannot Alter Their Own Membership Record',
      status: 'BLOCKED',
      operationType: 'STATE_CHANGING',
      durationMs: 0,
      details: 'User A organization ID missing.',
    });
  } else {
    try {
      const { data, error } = await clientA
        .from('organization_members')
        .update({ role: 'admin' })
        .eq('organization_id', orgAId)
        .eq('user_id', userIdA)
        .select();

      if (error) {
        if (isIntendedSecurityRejection(error)) {
          results.push({
            id: 'org-anti-self-promotion',
            category,
            name: 'Anti-Self-Promotion: Users Cannot Alter Their Own Membership Record',
            status: 'PASS',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t5Start,
            details: `Self-role modification blocked as required: ${error.message}`,
          });
        } else {
          results.push({
            id: 'org-anti-self-promotion',
            category,
            name: 'Anti-Self-Promotion: Users Cannot Alter Their Own Membership Record',
            status: 'FAIL',
            operationType: 'STATE_CHANGING',
            durationMs: Date.now() - t5Start,
            error: error.message,
          });
        }
      } else if (!data || data.length === 0) {
        results.push({
          id: 'org-anti-self-promotion',
          category,
          name: 'Anti-Self-Promotion: Users Cannot Alter Their Own Membership Record',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5Start,
          details: 'RLS policy user_id != auth.uid() prevented self-role modification (0 rows updated).',
        });
      } else {
        results.push({
          id: 'org-anti-self-promotion',
          category,
          name: 'Anti-Self-Promotion: Users Cannot Alter Their Own Membership Record',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5Start,
          error: 'VULNERABILITY: User was able to update their own membership role directly!',
          suggestedFix:
            'Ensure trigger tr_validate_membership_modification and policy owners_can_update_teammates enforce user_id != auth.uid().',
        });
      }
    } catch (err: any) {
      if (isIntendedSecurityRejection(err)) {
        results.push({
          id: 'org-anti-self-promotion',
          category,
          name: 'Anti-Self-Promotion: Users Cannot Alter Their Own Membership Record',
          status: 'PASS',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5Start,
          details: `Self-role alteration exception caught: ${err.message}`,
        });
      } else {
        results.push({
          id: 'org-anti-self-promotion',
          category,
          name: 'Anti-Self-Promotion: Users Cannot Alter Their Own Membership Record',
          status: 'FAIL',
          operationType: 'STATE_CHANGING',
          durationMs: Date.now() - t5Start,
          error: err.message,
        });
      }
    }
  }

  return results;
}
