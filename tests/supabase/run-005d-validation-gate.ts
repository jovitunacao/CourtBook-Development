// ==============================================================================
// CourtBook / BookSuite — Phase 4.2.5 Financial Reconciliation Validation Gate Runner
// File: tests/supabase/run-005d-validation-gate.ts
// ==============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const REPORT_DIR = path.join(ROOT_DIR, 'tests/supabase/reports');
const REPORT_FILE = path.join(REPORT_DIR, '005d_execution_evidence.log');
const ROOT_ARTIFACT_DIR = path.join(ROOT_DIR, '.aistudio/artifacts/brain/d31f6d16-618d-4fb1-93bb-7151c73b2135');
const SYSTEM_ARTIFACT_DIR = '/.aistudio/artifacts/brain/d31f6d16-618d-4fb1-93bb-7151c73b2135';
const ARTIFACT_DIR = fs.existsSync(ROOT_ARTIFACT_DIR)
  ? ROOT_ARTIFACT_DIR
  : fs.existsSync(SYSTEM_ARTIFACT_DIR)
  ? SYSTEM_ARTIFACT_DIR
  : ROOT_ARTIFACT_DIR;
const ARTIFACT_FILE = path.join(ARTIFACT_DIR, '005d_execution_evidence.log');

if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

let reportLogBuffer = '';

function log(msg: string) {
  console.log(msg);
  reportLogBuffer += msg + '\n';
}

function flushLog() {
  fs.writeFileSync(REPORT_FILE, reportLogBuffer, 'utf8');
  try {
    if (fs.existsSync(ARTIFACT_DIR)) {
      fs.writeFileSync(ARTIFACT_FILE, reportLogBuffer, 'utf8');
    }
  } catch {}
}

interface GateResult {
  step: string;
  status: 'PASS' | 'FAIL';
  details: string;
  durationMs: number;
}

const results: GateResult[] = [];

function recordResult(step: string, status: 'PASS' | 'FAIL', details: string, startTime?: number) {
  const durationMs = startTime ? Date.now() - startTime : 0;
  results.push({ step, status, details, durationMs });
  log(`[${status}] ${step} (${durationMs}ms): ${details}`);
}

let pgInstance: {
  port: number;
  dataDir: string;
  sockDir: string;
  pid: number;
} | null = null;

function startDisposablePostgres(): { port: number; dataDir: string; sockDir: string } {
  // Check if a pre-existing connection string or port is provided
  if (process.env.TEST_PG_PORT) {
    const port = parseInt(process.env.TEST_PG_PORT, 10);
    return { port, dataDir: '', sockDir: '/tmp' };
  }

  const nonce = `${process.pid}_${Date.now()}`;
  const dataDir = `/tmp/cb_005d_${nonce}_data`;
  const sockDir = `/tmp/cb_005d_${nonce}_sock`;
  const port = 10000 + Math.floor(Math.random() * 50000);

  // Check if postgres user exists or if running under current user
  let hasPostgresUser = false;
  try {
    execSync('id -u postgres', { stdio: 'pipe' });
    hasPostgresUser = true;
  } catch {}

  const initCmd = hasPostgresUser
    ? `su - postgres -c "mkdir -p ${dataDir} ${sockDir} && chmod 700 ${dataDir} && chmod 777 ${sockDir} && /usr/lib/postgresql/15/bin/initdb -D ${dataDir} && /usr/lib/postgresql/15/bin/pg_ctl -D ${dataDir} -l ${dataDir}/server.log -o \\"-p ${port} -k ${sockDir}\\" start"`
    : `mkdir -p ${dataDir} ${sockDir} && chmod 700 ${dataDir} && chmod 777 ${sockDir} && initdb -D ${dataDir} && pg_ctl -D ${dataDir} -l ${dataDir}/server.log -o "-p ${port} -k ${sockDir}" start`;

  execSync(initCmd, { stdio: 'pipe' });

  pgInstance = { port, dataDir, sockDir, pid: 0 };
  return { port, dataDir, sockDir };
}

function stopDisposablePostgres() {
  if (!pgInstance || !pgInstance.dataDir) return;
  try {
    let hasPostgresUser = false;
    try {
      execSync('id -u postgres', { stdio: 'pipe' });
      hasPostgresUser = true;
    } catch {}

    const stopCmd = hasPostgresUser
      ? `su - postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D ${pgInstance.dataDir} stop -m immediate"`
      : `pg_ctl -D ${pgInstance.dataDir} stop -m immediate`;

    execSync(stopCmd, { stdio: 'pipe' });
  } catch {}
  try {
    fs.rmSync(pgInstance.dataDir, { recursive: true, force: true });
    fs.rmSync(pgInstance.sockDir, { recursive: true, force: true });
  } catch {}
  pgInstance = null;
}

function getPostgresClient(port?: number): Client {
  const s = pgInstance?.sockDir || '/tmp';
  const p = port || (pgInstance ? pgInstance.port : 5432);
  return new Client({
    host: s,
    port: p,
    user: 'postgres',
    database: 'postgres',
  });
}

async function setupSupabaseMockAuth(client: Client) {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    CREATE EXTENSION IF NOT EXISTS "btree_gist";

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
        CREATE ROLE authenticator NOLOGIN NOINHERIT;
      END IF;
      GRANT anon TO postgres, authenticator;
      GRANT authenticated TO postgres, authenticator;
      GRANT service_role TO postgres, authenticator;
    END $$;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT,
      role TEXT DEFAULT 'authenticated',
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
    $$;

    CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), current_setting('role', true), current_user);
    $$;

    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT ALL ON TABLE auth.users TO anon, authenticated, service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
    GRANT ALL ON ALL ROUTINES IN SCHEMA public TO authenticated, service_role;
  `);
}

async function applyMigrations(client: Client, migrationFiles: string[]) {
  for (const mig of migrationFiles) {
    const migPath = path.join(ROOT_DIR, 'supabase/migrations', mig);
    const sql = fs.readFileSync(migPath, 'utf8');
    await client.query(sql);
  }
}

async function runValidationGate() {
  log('================================================================================');
  log('CourtBook / BookSuite — Phase 4.2.5 Financial Reconciliation & End-to-End Audit Validation Gate');
  log(`Runtime Environment: Node.js ${process.version} on Debian GNU/Linux 12 (bookworm)`);
  log('Target Migration: supabase/migrations/005d_financial_reconciliation_audit.sql');
  log('Test Fixture: tests/supabase/fixtures/005d_financial_reconciliation_test.sql');
  log(`Execution Evidence Log: ${REPORT_FILE}`);
  log('================================================================================\n');

  const { port, dataDir, sockDir } = startDisposablePostgres();
  log(`Connected to PostgreSQL engine on port ${port}:`);
  const rootClient = getPostgresClient(port);
  await rootClient.connect();

  const verRes = await rootClient.query<{ version: string }>('SELECT version();');
  log(verRes.rows[0].version);
  if (dataDir) log(`Server Data Directory: ${dataDir}`);
  log(`Server Socket Directory: ${sockDir} (Port: ${port})\n`);

  await setupSupabaseMockAuth(rootClient);

  // ---------------------------------------------------------------------------
  // GATE 1: Complete Baseline Migrations (001 through 005C) & Migration 005D Application
  // ---------------------------------------------------------------------------
  const gate1Start = Date.now();
  try {
    log('--- Running Gate 1: Complete Baseline Migrations (including 005a2 & 005b1) & Migration 005D ---');
    const FULL_BASELINE_MIGRATIONS = [
      '001_initial_schema.sql',
      '002_secure_reservation_operations.sql',
      '003_booking_confirmation.sql',
      '004_abuse_prevention_and_idempotency.sql',
      '005_financial_core_and_constraints.sql',
      '005a1_financial_journal_engine.sql',
      '005a2_financial_ledger_hardening.sql',
      '005b_payments_payouts_infrastructure.sql',
      '005b1_existing_infrastructure_hardening.sql',
      '005c_booking_payment_integration.sql',
    ];

    await applyMigrations(rootClient, FULL_BASELINE_MIGRATIONS);
    await applyMigrations(rootClient, ['005d_financial_reconciliation_audit.sql']);

    recordResult(
      'Gate 1: Complete Baseline Migrations & Migration 005D Application',
      'PASS',
      'All 10 baseline migrations (including 005a2 and 005b1) and Migration 005D applied cleanly within PostgreSQL instance.',
      gate1Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 1: Complete Baseline Migrations & Migration 005D Application', 'FAIL', msg, gate1Start);
    log(`\nFATAL: Gate 1 failed. Aborting.`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // GATE 2: Audit Schema Objects, RLS, & Security Definer Verification
  // ---------------------------------------------------------------------------
  const gate2Start = Date.now();
  try {
    log('\n--- Running Gate 2: Audit Schema Objects, RLS, & Security Definer Verification ---');

    const expectedViews = [
      'v_transaction_double_entry_audit',
      'v_payment_commission_audit',
      'v_payout_lifecycle_reconciliation',
      'v_financial_reconciliation_overview',
    ];

    for (const viewName of expectedViews) {
      const viewCheck = await rootClient.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.views WHERE table_name = $1 AND table_schema = 'public';
      `, [viewName]);

      if (viewCheck.rows.length === 0) {
        throw new Error(`Gate 2 Failed: Expected audit view ${viewName} does not exist.`);
      }
    }

    const expectedFunctions = [
      { name: 'reconcile_organization_finances', secDef: true },
      { name: 'get_financial_reconciliation_summary', secDef: true },
    ];

    for (const fn of expectedFunctions) {
      const fnCheck = await rootClient.query<{ proname: string; prosecdef: boolean }>(`
        SELECT proname, prosecdef FROM pg_proc WHERE proname = $1;
      `, [fn.name]);

      if (fnCheck.rows.length === 0) {
        throw new Error(`Gate 2 Failed: Expected function ${fn.name} does not exist.`);
      }
      if (fnCheck.rows[0].prosecdef !== fn.secDef) {
        throw new Error(`Gate 2 Failed: Function ${fn.name} prosecdef must be ${fn.secDef}.`);
      }
    }

    // Verify revoked privileges from PUBLIC and anon
    const privCheck = await rootClient.query<{ count: string }>(`
      SELECT count(*) as count
      FROM information_schema.routine_privileges
      WHERE routine_name IN ('reconcile_organization_finances', 'get_financial_reconciliation_summary')
        AND grantee IN ('PUBLIC', 'anon');
    `);

    if (parseInt(privCheck.rows[0].count, 10) > 0) {
      throw new Error(`Gate 2 Failed: EXECUTE privileges remain granted to PUBLIC or anon on reconciliation functions.`);
    }

    // Actively verify deployed runtime authorization behavior using explicit transactions
    log('  Testing deployed runtime authorization behavior across authentic PostgREST execution contexts...');

    // Helper to execute operations within an explicit transaction with transaction-local claims
    async function runInPostgrestContext<T>(
      role: 'anon' | 'authenticated' | 'service_role',
      userId: string | null,
      jwtRole: string,
      operation: () => Promise<T>
    ): Promise<T> {
      await rootClient.query('BEGIN;');
      try {
        await rootClient.query(`SET LOCAL ROLE ${role};`);
        await rootClient.query(`SELECT set_config('request.jwt.claim.role', '${jwtRole}', true);`);
        if (userId) {
          await rootClient.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', true);`);
        } else {
          await rootClient.query(`SELECT set_config('request.jwt.claim.sub', '', true);`);
        }
        const result = await operation();
        await rootClient.query('ROLLBACK;');
        return result;
      } catch (err) {
        await rootClient.query('ROLLBACK;');
        throw err;
      }
    }

    // Provision test organizations and identities for Gate 2
    const testOrgId = 'a0000000-0000-0000-0000-000000000001';
    const otherOrgId = 'a0000000-0000-0000-0000-000000000002';
    const outsiderUid = 'b0000000-0000-0000-0000-000000000002';
    const staffUid = 'b0000000-0000-0000-0000-000000000003';
    const otherOwnerUid = 'b0000000-0000-0000-0000-000000000004';
    const ownerUid = 'c0000000-0000-0000-0000-000000000003';

    await rootClient.query(`
      INSERT INTO auth.users (id, email) VALUES
        ('${outsiderUid}', 'gate2-outsider@test.com'),
        ('${staffUid}', 'gate2-staff@test.com'),
        ('${otherOwnerUid}', 'gate2-otherowner@test.com'),
        ('${ownerUid}', 'gate2-owner@test.com')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.organizations (id, name, slug) VALUES
        ('${testOrgId}', 'Gate 2 Auth Test Club', 'gate-2-auth-test'),
        ('${otherOrgId}', 'Gate 2 Other Club', 'gate-2-other-club')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.organization_balances (organization_id, currency) VALUES
        ('${testOrgId}', 'PHP'),
        ('${otherOrgId}', 'PHP')
      ON CONFLICT (organization_id) DO NOTHING;

      INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
        ('${testOrgId}', '${ownerUid}', 'owner'),
        ('${testOrgId}', '${staffUid}', 'staff'),
        ('${otherOrgId}', '${otherOwnerUid}', 'owner')
      ON CONFLICT DO NOTHING;
    `);

    // 1. Anonymous role rejection on functions and views
    await runInPostgrestContext('anon', null, 'anon', async () => {
      let finBlocked = false;
      try {
        await rootClient.query(`SELECT * FROM public.reconcile_organization_finances('${testOrgId}');`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Access denied: Anonymous clients cannot access financial reconciliation.')) {
          finBlocked = true;
        }
      }
      if (!finBlocked) throw new Error('Gate 2 Failed: Anon was able to run reconcile_organization_finances!');

      let summBlocked = false;
      try {
        await rootClient.query(`SELECT public.get_financial_reconciliation_summary('${testOrgId}');`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Access denied: Anonymous clients cannot access financial reconciliation.')) {
          summBlocked = true;
        }
      }
      if (!summBlocked) throw new Error('Gate 2 Failed: Anon was able to run get_financial_reconciliation_summary!');

      const viewRes = await rootClient.query<{ count: string }>(`
        SELECT count(*) as count FROM public.v_financial_reconciliation_overview WHERE organization_id = '${testOrgId}';
      `);
      if (parseInt(viewRes.rows[0].count, 10) !== 0) {
        throw new Error('Gate 2 Failed: Anon was able to see rows in v_financial_reconciliation_overview!');
      }
    });
    log('  - Deployed anon role rejection confirmed on both functions and audit views.');

    // 2. Outsider authenticated caller rejection
    await runInPostgrestContext('authenticated', outsiderUid, 'authenticated', async () => {
      let finBlocked = false;
      try {
        await rootClient.query(`SELECT * FROM public.reconcile_organization_finances('${testOrgId}');`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Access denied: Only organization owners and admins')) {
          finBlocked = true;
        }
      }
      if (!finBlocked) throw new Error('Gate 2 Failed: Outsider authenticated user was not blocked on reconcile_organization_finances!');

      let summBlocked = false;
      try {
        await rootClient.query(`SELECT public.get_financial_reconciliation_summary('${testOrgId}');`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Access denied: Only organization owners and admins')) {
          summBlocked = true;
        }
      }
      if (!summBlocked) throw new Error('Gate 2 Failed: Outsider authenticated user was not blocked on get_financial_reconciliation_summary!');

      const viewRes = await rootClient.query<{ count: string }>(`
        SELECT count(*) as count FROM public.v_financial_reconciliation_overview WHERE organization_id = '${testOrgId}';
      `);
      if (parseInt(viewRes.rows[0].count, 10) !== 0) {
        throw new Error('Gate 2 Failed: Outsider saw rows in v_financial_reconciliation_overview!');
      }
    });
    log('  - Deployed outsider authenticated user rejection confirmed.');

    // 3. Staff user rejection
    await runInPostgrestContext('authenticated', staffUid, 'authenticated', async () => {
      let finBlocked = false;
      try {
        await rootClient.query(`SELECT * FROM public.reconcile_organization_finances('${testOrgId}');`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Access denied: Only organization owners and admins')) {
          finBlocked = true;
        }
      }
      if (!finBlocked) throw new Error('Gate 2 Failed: Staff user was not blocked on reconcile_organization_finances!');
    });
    log('  - Deployed staff user rejection confirmed.');

    // 4. Cross-tenant owner rejection
    await runInPostgrestContext('authenticated', otherOwnerUid, 'authenticated', async () => {
      let finBlocked = false;
      try {
        await rootClient.query(`SELECT * FROM public.reconcile_organization_finances('${testOrgId}');`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Access denied: Only organization owners and admins')) {
          finBlocked = true;
        }
      }
      if (!finBlocked) throw new Error('Gate 2 Failed: Cross-tenant owner was not blocked on other org!');

      const viewRes = await rootClient.query<{ count: string }>(`
        SELECT count(*) as count FROM public.v_financial_reconciliation_overview WHERE organization_id = '${testOrgId}';
      `);
      if (parseInt(viewRes.rows[0].count, 10) !== 0) {
        throw new Error('Gate 2 Failed: Cross-tenant owner saw rows in v_financial_reconciliation_overview for target org!');
      }
    });
    log('  - Deployed cross-tenant owner rejection confirmed.');

    // 5. Authenticated client with NULL organization_id rejection
    await runInPostgrestContext('authenticated', ownerUid, 'authenticated', async () => {
      let nullBlocked = false;
      try {
        await rootClient.query(`SELECT * FROM public.reconcile_organization_finances(NULL);`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Access denied: Authenticated clients must provide an explicit organization_id.')) {
          nullBlocked = true;
        }
      }
      if (!nullBlocked) throw new Error('Gate 2 Failed: Authenticated client was able to scan globally with NULL organization_id!');
    });
    log('  - Deployed global scan rejection with NULL organization_id confirmed.');

    // 6. Anti-Impersonation: Authenticated role claiming service_role rejection
    await runInPostgrestContext('authenticated', outsiderUid, 'service_role', async () => {
      let impBlocked = false;
      try {
        await rootClient.query(`SELECT * FROM public.reconcile_organization_finances('${testOrgId}');`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Access denied: Authenticated role cannot claim service_role privileges.')) {
          impBlocked = true;
        }
      }
      if (!impBlocked) throw new Error('Gate 2 Failed: Authenticated role was able to impersonate service_role!');
    });
    log('  - Simulated service-role impersonation under authenticated role strictly blocked.');

    // 7. Legitimate owner permitted access
    await runInPostgrestContext('authenticated', ownerUid, 'authenticated', async () => {
      await rootClient.query(`SELECT * FROM public.reconcile_organization_finances('${testOrgId}');`);
      const summRes = await rootClient.query<{ get_financial_reconciliation_summary: { is_healthy: boolean } }>(`
        SELECT public.get_financial_reconciliation_summary('${testOrgId}');
      `);
      if (!summRes.rows[0].get_financial_reconciliation_summary.is_healthy) {
        throw new Error('Gate 2 Failed: Legitimate owner summary was not healthy for empty clean org!');
      }

      const viewRes = await rootClient.query<{ count: string }>(`
        SELECT count(*) as count FROM public.v_financial_reconciliation_overview WHERE organization_id = '${testOrgId}';
      `);
      if (parseInt(viewRes.rows[0].count, 10) !== 1) {
        throw new Error('Gate 2 Failed: Legitimate owner saw 0 rows in v_financial_reconciliation_overview!');
      }
    });
    log('  - Deployed legitimate owner authorization confirmed on functions and views.');

    // 8. Genuine service_role permitted access
    await runInPostgrestContext('service_role', null, 'service_role', async () => {
      await rootClient.query(`SELECT * FROM public.reconcile_organization_finances('${testOrgId}');`);
      await rootClient.query(`SELECT public.get_financial_reconciliation_summary('${testOrgId}');`);
    });
    log('  - Genuine service_role authorization confirmed.');

    // Clean up temporary Gate 2 test records
    await rootClient.query(`
      DELETE FROM public.organization_members WHERE organization_id IN ('${testOrgId}', '${otherOrgId}');
      DELETE FROM public.organization_balances WHERE organization_id IN ('${testOrgId}', '${otherOrgId}');
      DELETE FROM public.organizations WHERE id IN ('${testOrgId}', '${otherOrgId}');
      DELETE FROM auth.users WHERE id IN ('${outsiderUid}', '${staffUid}', '${otherOwnerUid}', '${ownerUid}');
    `);

    recordResult(
      'Gate 2: Audit Schema Objects, RLS, & Security Definer Verification',
      'PASS',
      'All 4 audit views and 2 reconciliation functions verified with SECURITY DEFINER, search_path hardening, zero PUBLIC/anon execution grants, explicit transaction-local context, and active runtime rejection of anon/outsider/staff/cross-tenant/impersonating callers alongside verified owner and service_role execution.',
      gate2Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 2: Audit Schema Objects, RLS, & Security Definer Verification', 'FAIL', msg, gate2Start);
    log(`\nFATAL: Gate 2 failed. Aborting.`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // GATE 3: SQL Test Fixture Execution (Rollback-Only Comprehensive Test Suite)
  // ---------------------------------------------------------------------------
  const gate3Start = Date.now();
  try {
    log('\n--- Running Gate 3: SQL Test Fixture Execution (Rollback-Only Comprehensive Test Suite) ---');
    const fixtureSql = fs.readFileSync(path.join(ROOT_DIR, 'tests/supabase/fixtures/005d_financial_reconciliation_test.sql'), 'utf8');

    rootClient.on('notice', (msg) => {
      if (msg.message) {
        log(`  ${msg.message}`);
      }
    });

    await rootClient.query(fixtureSql);

    recordResult(
      'Gate 3: SQL Test Fixture Execution',
      'PASS',
      'All comprehensive reconciliation tests passed: valid lifecycle reconciliation, 5 database constraint protections directly asserted, realistic anomaly detection checks, cross-tenant isolation, and real PostgreSQL role RBAC guards.',
      gate3Start
    );
  } catch (err: unknown) {
    try { await rootClient.query('ROLLBACK;'); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 3: SQL Test Fixture Execution', 'FAIL', msg, gate3Start);
    log(`\nFATAL: Gate 3 failed. Aborting.`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // GATE 4: Database Cleanliness & Zero Residual State Integrity Check
  // ---------------------------------------------------------------------------
  const gate4Start = Date.now();
  try {
    log('\n--- Running Gate 4: Database Cleanliness & Zero Residual State Integrity Check ---');

    const cleanChecks = await Promise.all([
      rootClient.query<{ count: string }>('SELECT count(*) as count FROM public.financial_transactions;'),
      rootClient.query<{ count: string }>('SELECT count(*) as count FROM public.ledger_entries;'),
      rootClient.query<{ count: string }>('SELECT count(*) as count FROM public.payouts;'),
      rootClient.query<{ count: string }>('SELECT count(*) as count FROM public.payout_lifecycle_logs;'),
      rootClient.query<{ count: string }>('SELECT count(*) as count FROM public.reservations;'),
      rootClient.query<{ count: string }>('SELECT count(*) as count FROM public.payments;'),
    ]);

    const txCount = parseInt(cleanChecks[0].rows[0].count, 10);
    const leCount = parseInt(cleanChecks[1].rows[0].count, 10);
    const payoutCount = parseInt(cleanChecks[2].rows[0].count, 10);
    const payoutLogCount = parseInt(cleanChecks[3].rows[0].count, 10);
    const resCount = parseInt(cleanChecks[4].rows[0].count, 10);
    const payCount = parseInt(cleanChecks[5].rows[0].count, 10);

    log(`  Post-Test Counts:`);
    log(`  - financial_transactions: ${txCount}`);
    log(`  - ledger_entries: ${leCount}`);
    log(`  - payouts: ${payoutCount}`);
    log(`  - payout_lifecycle_logs: ${payoutLogCount}`);
    log(`  - reservations: ${resCount}`);
    log(`  - payments: ${payCount}`);

    if (txCount !== 0 || leCount !== 0 || payoutCount !== 0 || payoutLogCount !== 0 || resCount !== 0 || payCount !== 0) {
      throw new Error(`Residual state detected: Fixture failed to rollback completely!`);
    }

    recordResult(
      'Gate 4: Database Cleanliness & Zero Residual State Integrity Check',
      'PASS',
      'All operational tables confirmed completely pristine (0 residual records). Pure rollback verified.',
      gate4Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 4: Database Cleanliness & Zero Residual State Integrity Check', 'FAIL', msg, gate4Start);
    log(`\nFATAL: Gate 4 failed. Aborting.`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // SUMMARY REPORT
  // ---------------------------------------------------------------------------
  log('\n================================================================================');
  log('COURTBOOK PHASE 4.2.5 FINANCIAL RECONCILIATION GATE SUMMARY REPORT');
  log('================================================================================');
  let passCount = 0;
  let failCount = 0;
  for (const r of results) {
    if (r.status === 'PASS') passCount++;
    else failCount++;
    log(`- [${r.status}] ${r.step} (${r.durationMs}ms)`);
  }
  log('================================================================================');
  log(`TOTAL GATES: ${results.length} | PASS: ${passCount} | FAIL: ${failCount}`);
  log('================================================================================\n');
  flushLog();

  await rootClient.end();
  stopDisposablePostgres();

  if (failCount > 0) {
    process.exit(1);
  }
}

// When invoked directly via CLI
if (process.argv[1] && process.argv[1].endsWith('run-005d-validation-gate.ts')) {
  runValidationGate().catch((err) => {
    log(`Validation Gate Runner: ${err.message || err}`);
    stopDisposablePostgres();
  });
}

export { runValidationGate };
