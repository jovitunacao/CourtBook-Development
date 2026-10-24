import { getEnvironmentConfig, createAuthenticatedClient, createAnonClient } from '../config';
import { TestResult } from '../types';

export async function runAuthSuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const config = getEnvironmentConfig();
  const category = 'Authentication';

  // Test 1: User A Sign-in (Read-Only)
  const t1Start = Date.now();
  try {
    const { userId } = await createAuthenticatedClient(
      config.userAEmail,
      config.userAPassword
    );

    results.push({
      id: 'auth-user-a',
      category,
      name: 'User A (Pickleball Center Owner) Authenticates Successfully',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t1Start,
      details: `Active session established. User ID: ${userId.substring(0, 8)}...`,
    });
  } catch (err: any) {
    results.push({
      id: 'auth-user-a',
      category,
      name: 'User A (Pickleball Center Owner) Authenticates Successfully',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t1Start,
      error: err.message,
      suggestedFix:
        'Verify TEST_USER_A_EMAIL and TEST_USER_A_PASSWORD environment variables match your Supabase auth user.',
    });
  }

  // Test 2: User B Sign-in (Read-Only)
  const t2Start = Date.now();
  try {
    const { userId } = await createAuthenticatedClient(
      config.userBEmail,
      config.userBPassword
    );

    results.push({
      id: 'auth-user-b',
      category,
      name: 'User B (Badminton Center Owner) Authenticates Successfully',
      status: 'PASS',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t2Start,
      details: `Active session established. User ID: ${userId.substring(0, 8)}...`,
    });
  } catch (err: any) {
    results.push({
      id: 'auth-user-b',
      category,
      name: 'User B (Badminton Center Owner) Authenticates Successfully',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t2Start,
      error: err.message,
      suggestedFix:
        'Verify TEST_USER_B_EMAIL and TEST_USER_B_PASSWORD environment variables match your Supabase auth user.',
    });
  }

  // Test 3: Negative Test - Bad password verification (Read-Only)
  const t3Start = Date.now();
  try {
    const anon = createAnonClient();
    const { data, error } = await anon.auth.signInWithPassword({
      email: config.userAEmail,
      password: '__INVALID_BAD_PASSWORD_VERIFY_REJECTION__',
    });

    if (error) {
      const msg = error.message.toLowerCase();
      // Requirement 7: Only report PASS when intended authentication rejection occurs.
      // Report network, URL, or unrelated errors as FAIL.
      if (
        msg.includes('invalid login credentials') ||
        msg.includes('invalid_grant') ||
        msg.includes('email not confirmed') ||
        (error.status && error.status === 400 && !msg.includes('invalid path'))
      ) {
        results.push({
          id: 'auth-negative-bad-password',
          category,
          name: 'Authentication Guard: Incorrect Password Is Validated and Rejected',
          status: 'PASS',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t3Start,
          details: `Rejected invalid credentials as expected: ${error.message}`,
        });
      } else {
        results.push({
          id: 'auth-negative-bad-password',
          category,
          name: 'Authentication Guard: Incorrect Password Is Validated and Rejected',
          status: 'FAIL',
          operationType: 'READ_ONLY',
          durationMs: Date.now() - t3Start,
          error: `Expected authentication credential rejection, but got network/path error: ${error.message}`,
          suggestedFix: 'Ensure SUPABASE_URL points to a valid Supabase project endpoint.',
        });
      }
    } else {
      results.push({
        id: 'auth-negative-bad-password',
        category,
        name: 'Authentication Guard: Incorrect Password Is Validated and Rejected',
        status: 'FAIL',
        operationType: 'READ_ONLY',
        durationMs: Date.now() - t3Start,
        error: 'CRITICAL: Authentication accepted an invalid password!',
        suggestedFix: 'Check Supabase Auth configuration.',
      });
    }
  } catch (err: any) {
    results.push({
      id: 'auth-negative-bad-password',
      category,
      name: 'Authentication Guard: Incorrect Password Is Validated and Rejected',
      status: 'FAIL',
      operationType: 'READ_ONLY',
      durationMs: Date.now() - t3Start,
      error: `Network/connection error prevented auth test: ${err.message}`,
    });
  }

  return results;
}
