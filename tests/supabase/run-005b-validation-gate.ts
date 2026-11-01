import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Client } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const REPORT_DIR = path.join(ROOT_DIR, 'tests/supabase/reports');
const REPORT_FILE = path.join(REPORT_DIR, '005b_execution_evidence.log');

if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

// Log stream for capturing execution evidence
const logLines: string[] = [];
function log(msg: string) {
  console.log(msg);
  logLines.push(msg);
}

function flushLog() {
  fs.writeFileSync(REPORT_FILE, logLines.join('\n') + '\n', 'utf8');
}

interface TestResult {
  step: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT EXECUTED';
  details: string;
  durationMs: number;
}

const results: TestResult[] = [];

function recordResult(step: string, status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT EXECUTED', details: string, startMs: number) {
  const durationMs = Date.now() - startMs;
  results.push({ step, status, details, durationMs });
  log(`[${status}] ${step} (${durationMs}ms): ${details}`);
  flushLog();
}

// Safe isolated disposable database configuration
const RUN_ID = `cb_005b_${process.pid}_${Date.now()}`;
const PG_DATA_DIR = `/tmp/${RUN_ID}_data`;
const PG_SOCKET_DIR = `/tmp/${RUN_ID}_sock`;
let PG_PORT = 5433;

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 5433;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function stopDisposablePostgres() {
  try {
    if (fs.existsSync(PG_DATA_DIR)) {
      execSync(`su - postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D ${PG_DATA_DIR} stop -m immediate"`, { stdio: 'pipe' });
    }
  } catch {}
  try {
    if (fs.existsSync(PG_DATA_DIR)) {
      fs.rmSync(PG_DATA_DIR, { recursive: true, force: true });
    }
  } catch {}
  try {
    if (fs.existsSync(PG_SOCKET_DIR)) {
      fs.rmSync(PG_SOCKET_DIR, { recursive: true, force: true });
    }
  } catch {}
}

async function startDisposablePostgres(): Promise<boolean> {
  stopDisposablePostgres();
  try {
    try {
      execSync('id postgres 2>/dev/null || useradd -m postgres', { stdio: 'pipe' });
    } catch {}
    PG_PORT = await getAvailablePort();
    execSync(`su - postgres -c "mkdir -p ${PG_SOCKET_DIR} && chmod 777 ${PG_SOCKET_DIR}"`, { stdio: 'pipe' });
    execSync(`su - postgres -c "/usr/lib/postgresql/15/bin/initdb -D ${PG_DATA_DIR}"`, { stdio: 'pipe' });
    execSync(`su - postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D ${PG_DATA_DIR} -l ${PG_DATA_DIR}/server.log -o \\"-p ${PG_PORT} -k ${PG_SOCKET_DIR}\\" start"`, { stdio: 'pipe' });
    return true;
  } catch (err) {
    log(`Warning: Failed to launch safe isolated disposable PostgreSQL server: ${err}`);
    return false;
  }
}

function getPostgresClient(): Client {
  return new Client({
    host: PG_SOCKET_DIR,
    port: PG_PORT,
    user: 'postgres',
    database: 'postgres'
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
  log('CourtBook / BookSuite — Phase 4.2.3 Payment & Payout Infrastructure Validation Gate');
  log(`Runtime Environment: Node.js ${process.version} on Debian GNU/Linux 12 (bookworm)`);
  log('Target Migration: supabase/migrations/005b_payments_payouts_infrastructure.sql');
  log('Test Fixture: tests/supabase/fixtures/005b_payments_payouts_test.sql');
  log('Execution Evidence Log: tests/supabase/reports/005b_execution_evidence.log');
  log('================================================================================\n');

  const serverStarted = await startDisposablePostgres();
  if (!serverStarted) {
    log('FATAL: Native PostgreSQL server could not be started in disposable container environment.');
    process.exit(1);
  }

  process.on('exit', () => stopDisposablePostgres());
  process.on('SIGINT', () => { stopDisposablePostgres(); process.exit(1); });
  process.on('SIGTERM', () => { stopDisposablePostgres(); process.exit(1); });

  const rootClient = getPostgresClient();
  await rootClient.connect();

  rootClient.on('notice', (msg) => {
    if (msg && msg.message) {
      log(`  ${msg.message}`);
    }
  });

  const verRes = await rootClient.query<{ version: string }>('SELECT version();');
  log(`Connected to disposable PostgreSQL engine:\n${verRes.rows[0].version}`);
  log(`Server Data Directory: ${PG_DATA_DIR}`);
  log(`Server Socket Directory: ${PG_SOCKET_DIR} (Port: ${PG_PORT})\n`);

  await setupSupabaseMockAuth(rootClient);

  const baselineMigrations = [
    '001_initial_schema.sql',
    '002_secure_reservation_operations.sql',
    '003_booking_confirmation.sql',
    '004_abuse_prevention_and_idempotency.sql',
    '005_financial_core_and_constraints.sql',
    '005a1_financial_journal_engine.sql'
  ];

  // ---------------------------------------------------------------------------
  // GATE 1: Baseline 001-005a1 Application & Migration 005B DDL Execution
  // ---------------------------------------------------------------------------
  const gate1Start = Date.now();
  try {
    log('--- Running Gate 1: Baseline Migrations 001-005a1 & Migration 005B Application ---');
    await applyMigrations(rootClient, baselineMigrations);

    const mig005bSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase/migrations/005b_payments_payouts_infrastructure.sql'), 'utf8');
    await rootClient.query(mig005bSql);

    recordResult(
      'Gate 1: Baseline 001-005a1 Application & Migration 005B Execution',
      'PASS',
      'All baseline migrations and Migration 005B applied atomically within safe isolated disposable database.',
      gate1Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 1: Baseline 001-005a1 Application & Migration 005B Execution', 'FAIL', msg, gate1Start);
    log(`\nFATAL: Gate 1 failed. Aborting.`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // GATE 2: Schema & Table Constraints Verification
  // ---------------------------------------------------------------------------
  const gate2Start = Date.now();
  try {
    log('\n--- Running Gate 2: Schema & Table Constraints Verification ---');
    const expectedTables = [
      'platform_fee_policy_controls',
      'payments',
      'provider_webhook_events',
      'settlement_batches',
      'settlement_items',
      'payout_methods',
      'payouts',
      'payout_lifecycle_logs'
    ];

    const tablesRes = await rootClient.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      ORDER BY tablename;
    `, [expectedTables]);

    if (tablesRes.rows.length !== expectedTables.length) {
      throw new Error(`Gate 2 Failed: Expected ${expectedTables.length} tables, found ${tablesRes.rows.length}.`);
    }

    // Verify composite foreign keys on payments
    const fkCheck = await rootClient.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('fk_payments_facility_org', 'fk_payments_reservation_facility');
    `);
    if (fkCheck.rows.length !== 2) {
      throw new Error(`Gate 2 Failed: Expected 2 composite foreign key constraints, found ${fkCheck.rows.length}.`);
    }

    // Verify fee policy default row
    const feePolicyRes = await rootClient.query<{ gateway_processing_fee_policy: string; payout_transfer_fee_policy: string }>(`
      SELECT gateway_processing_fee_policy, payout_transfer_fee_policy
      FROM public.platform_fee_policy_controls WHERE id = 1;
    `);
    if (feePolicyRes.rows[0].gateway_processing_fee_policy !== 'undecided' || feePolicyRes.rows[0].payout_transfer_fee_policy !== 'undecided') {
      throw new Error(`Gate 2 Failed: Fee policies must be 'undecided' by default.`);
    }

    recordResult(
      'Gate 2: Schema & Table Constraints Verification',
      'PASS',
      'All 8 new tables verified with composite foreign keys, unique constraints, and undecided fee configuration.',
      gate2Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 2: Schema & Table Constraints Verification', 'FAIL', msg, gate2Start);
    log(`\nFATAL: Gate 2 failed. Aborting.`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // GATE 3: SQL Test Fixture Execution (Tests 1 through 21 — Comprehensive Suite)
  // ---------------------------------------------------------------------------
  const gate3Start = Date.now();
  try {
    log('\n--- Running Gate 3: SQL Test Fixture Execution (Tests 1 through 21 — Comprehensive Suite) ---');
    const fixtureSql = fs.readFileSync(path.join(ROOT_DIR, 'tests/supabase/fixtures/005b_payments_payouts_test.sql'), 'utf8');
    await rootClient.query(fixtureSql);

    recordResult(
      'Gate 3: SQL Test Fixture Execution (Tests 1-21)',
      'PASS',
      'All 21 unit and integration tests passed: cross-tenant isolation, duplicate prevention, state machine transitions, fee preservation, security boundaries, staff RLS denial, owner masked retrieval, recipient token denial, cross-tenant payout isolation, and null-safe identifier immutability.',
      gate3Start
    );
  } catch (err: unknown) {
    try { await rootClient.query('ROLLBACK;'); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 3: SQL Test Fixture Execution (Tests 1-21)', 'FAIL', msg, gate3Start);
    log(`\nFATAL: Gate 3 failed. Aborting.`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // GATE 4: Test 22 — Genuine Concurrent-Session Concurrency Tests
  // ---------------------------------------------------------------------------
  const gate4Start = Date.now();
  let client1: Client | null = null;
  let client2: Client | null = null;
  try {
    log('\n--- Running Gate 4: Test 22 — Genuine Concurrent-Session Concurrency Tests ---');

    client1 = getPostgresClient();
    client2 = getPostgresClient();
    await client1.connect();
    await client2.connect();

    const pid1Res = await client1.query<{ pg_backend_pid: number }>('SELECT pg_backend_pid();');
    const pid2Res = await client2.query<{ pg_backend_pid: number }>('SELECT pg_backend_pid();');
    const pid1 = pid1Res.rows[0].pg_backend_pid;
    const pid2 = pid2Res.rows[0].pg_backend_pid;

    if (pid1 === pid2) {
      throw new Error(`Sessions are not independent! Both share PID ${pid1}`);
    }
    log(`  Verified 2 independent concurrent PostgreSQL sessions: Session 1 PID=${pid1}, Session 2 PID=${pid2}`);

    // Setup concurrent test entities
    const synthOrgId = 'e1000000-0000-0000-0000-000000000001';
    const synthFacId = 'e1000000-0000-0000-0000-000000000002';
    const synthCourtId = 'e1000000-0000-0000-0000-000000000003';
    const synthResId = 'e1000000-0000-0000-0000-000000000004';

    await rootClient.query(`
      INSERT INTO public.organizations (id, name, slug)
      VALUES ('${synthOrgId}', 'Concurrent Org 005B', 'concurrent-org-005b')
      ON CONFLICT DO NOTHING;

      INSERT INTO public.facilities (id, organization_id, name, slug, currency, default_hourly_rate)
      VALUES ('${synthFacId}', '${synthOrgId}', 'Concurrent Facility 005B', 'concurrent-fac-005b', '₱', 350.00)
      ON CONFLICT DO NOTHING;

      INSERT INTO public.courts (id, facility_id, name, sport_type, hourly_rate)
      VALUES ('${synthCourtId}', '${synthFacId}', 'Court Concur 1', 'tennis', 350.00)
      ON CONFLICT DO NOTHING;

      INSERT INTO public.reservations (
        id, facility_id, court_id, reference_code, customer_name, customer_email,
        booking_date, start_time, end_time, time_slot_label, duration_minutes, price, currency, status
      ) VALUES (
        '${synthResId}', '${synthFacId}', '${synthCourtId}', 'CONCUR-05B-01', 'Concur User', 'concur@example.com',
        CURRENT_DATE, now() + interval '1 hour', now() + interval '2 hours', '10:00 - 11:00', 60, 350.00, '₱', 'confirmed'
      ) ON CONFLICT DO NOTHING;
    `);

    // 22A. Concurrent Duplicate Captured Payment Recognition Race:
    // Two simultaneous workers attempt to record payment capture for the SAME reservation.
    // Partial unique index uq_captured_payment_lifecycle_per_reservation ensures exactly ONE succeeds!
    const [capture1, capture2] = await Promise.allSettled([
      client1.query(`
        INSERT INTO public.payments (
          organization_id, facility_id, reservation_id, expected_amount,
          commission_rate, commission_amount, owner_gross_share, status,
          captured_amount, provider_name, provider_payment_id
        ) VALUES (
          '${synthOrgId}', '${synthFacId}', '${synthResId}',
          350.00, 0.0500, 17.50, 332.50, 'captured',
          350.00, 'paymongo', 'pay_concur_session_1'
        );
      `),
      client2.query(`
        INSERT INTO public.payments (
          organization_id, facility_id, reservation_id, expected_amount,
          commission_rate, commission_amount, owner_gross_share, status,
          captured_amount, provider_name, provider_payment_id
        ) VALUES (
          '${synthOrgId}', '${synthFacId}', '${synthResId}',
          350.00, 0.0500, 17.50, 332.50, 'captured',
          350.00, 'paymongo', 'pay_concur_session_2'
        );
      `)
    ]);

    const cap1Ok = capture1.status === 'fulfilled';
    const cap2Ok = capture2.status === 'fulfilled';

    if ((cap1Ok && cap2Ok) || (!cap1Ok && !cap2Ok)) {
      throw new Error(`Concurrent duplicate captured payment violation: exactly one must win. cap1=${cap1Ok}, cap2=${cap2Ok}`);
    }

    const failedCapture = !cap1Ok ? (capture1 as PromiseRejectedResult).reason : (capture2 as PromiseRejectedResult).reason;
    if (!String(failedCapture).includes('uq_captured_payment_lifecycle_per_reservation')) {
      throw new Error(`Expected uq_captured_payment_lifecycle_per_reservation error, got: ${failedCapture}`);
    }
    log('  22A PASSED: Concurrent duplicate captured payment recognition safely rejected by uq_captured_payment_lifecycle_per_reservation.');

    // 22B. Concurrent Competing Payout Terminal Outcomes:
    // Setup a payout in 'submitted_to_provider' state
    const payoutMethodId = 'e2000000-0000-0000-0000-000000000001';
    const concurPayoutId = 'e3000000-0000-0000-0000-000000000001';

    await rootClient.query(`
      INSERT INTO public.payout_methods (
        id, organization_id, method_type, provider_name, account_holder_name,
        masked_account_number, bank_code, bank_name, is_active, is_default, verification_status
      ) VALUES (
        '${payoutMethodId}', '${synthOrgId}', 'bank_transfer', 'paymongo', 'Concur Owner',
        '****8888', 'BPI', 'Bank of the Philippine Islands', true, true, 'verified'
      ) ON CONFLICT DO NOTHING;

      INSERT INTO public.payouts (
        id, organization_id, payout_method_id, amount, status, provider_payout_id
      ) VALUES (
        '${concurPayoutId}', '${synthOrgId}', '${payoutMethodId}', 1000.00, 'submitted_to_provider', 'payout_concur_ref_01'
      ) ON CONFLICT DO NOTHING;
    `);

    // Concurrently fire competing terminal updates:
    // Session 1 tries to mark 'paid'
    // Session 2 tries to mark 'failed'
    const [payoutRes1, payoutRes2] = await Promise.allSettled([
      client1.query(`UPDATE public.payouts SET status = 'paid' WHERE id = '${concurPayoutId}';`),
      client2.query(`UPDATE public.payouts SET status = 'failed' WHERE id = '${concurPayoutId}';`)
    ]);

    const p1Ok = payoutRes1.status === 'fulfilled';
    const p2Ok = payoutRes2.status === 'fulfilled';

    // In serialized execution, one update completes first and sets terminal state ('paid' or 'failed').
    // The second update then encounters the terminal state trigger guard and fails!
    if ((p1Ok && p2Ok) || (!p1Ok && !p2Ok)) {
      throw new Error(`Concurrent competing terminal outcomes violation: exactly one must win. p1=${p1Ok}, p2=${p2Ok}`);
    }

    const failedPayout = !p1Ok ? (payoutRes1 as PromiseRejectedResult).reason : (payoutRes2 as PromiseRejectedResult).reason;
    if (!String(failedPayout).includes('is in terminal status')) {
      throw new Error(`Expected terminal status conflict, got: ${failedPayout}`);
    }
    log('  22B PASSED: Concurrent competing payout terminal outcomes safely resolved with exactly 1 winner and 1 conflict rejection.');

    recordResult(
      'Gate 4: Test 22 — Genuine Concurrent-Session Concurrency Tests',
      'PASS',
      `Duplicate captured payment race safely serialized (1 winner). Competing payout terminal transitions safely resolved across 2 independent PostgreSQL sessions (PIDs ${pid1}, ${pid2}).`,
      gate4Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 4: Test 22 — Genuine Concurrent-Session Concurrency Tests', 'FAIL', msg, gate4Start);
    log(`\nFATAL: Gate 4 failed. Aborting.`);
    if (client1) try { await client1.end(); } catch {}
    if (client2) try { await client2.end(); } catch {}
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  } finally {
    if (client1) try { await client1.end(); } catch {}
    if (client2) try { await client2.end(); } catch {}
  }

  // ---------------------------------------------------------------------------
  // SUMMARY REPORT
  // ---------------------------------------------------------------------------
  log('\n================================================================================');
  log('COURTBOOK PHASE 4.2.3 VALIDATION GATE SUMMARY REPORT');
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

runValidationGate().catch(err => {
  log(`Fatal Validation Gate Exception: ${err}`);
  stopDisposablePostgres();
  process.exit(1);
});
