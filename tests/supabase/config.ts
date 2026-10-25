import dotenv from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Load environment variables from .env files if present (.env.test has highest priority)
dotenv.config({ path: '.env.test' });
dotenv.config({ path: '.env.local' });
dotenv.config();

export interface TestEnvironmentConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  serviceRoleKey: string;
  userAEmail: string;
  userAPassword: string;
  userBEmail: string;
  userBPassword: string;
  testProject: string;
  confirmTestEnv: boolean;
}

// Well-known existing test slugs provided by BookSuite-Dev
export const EXISTING_FIXTURES = {
  orgA: {
    slug: 'courtbook-test-pickleball-a',
    facilitySlug: 'courtbook-pickleball-test',
    expectedCourtRate: 350.0,
  },
  orgB: {
    slug: 'courtbook-test-badminton-b',
    facilitySlug: 'courtbook-badminton-test',
    expectedCourtRate: 250.0,
  },
};

export function getEnvironmentConfig(): TestEnvironmentConfig {
  let rawUrl =
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    '';

  // Normalize: Supabase client expects https://<project>.supabase.co, without /rest/v1 or trailing slash
  if (rawUrl) {
    rawUrl = rawUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  }

  return {
    supabaseUrl: rawUrl,
    supabaseAnonKey:
      process.env.SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    userAEmail: process.env.TEST_USER_A_EMAIL || '',
    userAPassword: process.env.TEST_USER_A_PASSWORD || '',
    userBEmail: process.env.TEST_USER_B_EMAIL || '',
    userBPassword: process.env.TEST_USER_B_PASSWORD || '',
    testProject: process.env.SUPABASE_TEST_PROJECT || 'BookSuite-Dev',
    confirmTestEnv: process.env.CONFIRM_TEST_ENV === 'true',
  };
}

export function validateEnvironment(): { isValid: boolean; missing: string[] } {
  const config = getEnvironmentConfig();
  const missing: string[] = [];

  if (!config.supabaseUrl) missing.push('SUPABASE_URL (or VITE_SUPABASE_URL)');
  if (!config.supabaseAnonKey) missing.push('SUPABASE_ANON_KEY (or VITE_SUPABASE_ANON_KEY)');
  if (!config.userAEmail) missing.push('TEST_USER_A_EMAIL');
  if (!config.userAPassword) missing.push('TEST_USER_A_PASSWORD');
  if (!config.userBEmail) missing.push('TEST_USER_B_EMAIL');
  if (!config.userBPassword) missing.push('TEST_USER_B_PASSWORD');

  return {
    isValid: missing.length === 0,
    missing,
  };
}

/**
 * Ensures state-changing or fixture-modifying tests only run when the user has
 * explicitly confirmed the test environment (CONFIRM_TEST_ENV=true).
 */
export function isStateChangingAllowed(): boolean {
  const config = getEnvironmentConfig();
  return config.confirmTestEnv;
}

// Create an unauthenticated anon client
export function createAnonClient(): SupabaseClient {
  const { supabaseUrl, supabaseAnonKey } = getEnvironmentConfig();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase URL and Anon Key must be configured in environment.');
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

// Create an authenticated client for a designated test user
export async function createAuthenticatedClient(
  email: string,
  password: string
): Promise<{ client: SupabaseClient; userId: string }> {
  const client = createAnonClient();

  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    throw new Error(
      `Failed to authenticate test user [${email}]: ${error?.message || 'No user session returned'}`
    );
  }

  return {
    client,
    userId: data.user.id,
  };
}

// Create an administrative service-role client for trusted fixture provisioning & cleanup
export function createAdminClient(customServiceKey?: string): SupabaseClient {
  const { supabaseUrl, serviceRoleKey } = getEnvironmentConfig();
  const key = customServiceKey || serviceRoleKey;

  if (!supabaseUrl) {
    throw new Error('Supabase URL must be configured in environment.');
  }
  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is required to create a trusted administrator client for fixture lifecycle.'
    );
  }

  return createClient(supabaseUrl, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
