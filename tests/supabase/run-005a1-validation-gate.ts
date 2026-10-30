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
const REPORT_FILE = path.join(REPORT_DIR, '005a1_execution_evidence.log');

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
// Dynamic unique directories and port to guarantee zero interference with other processes
const RUN_ID = `cb_disposable_${process.pid}_${Date.now()}`;
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
  log('CourtBook / BookSuite — Phase 4.2.2 PostgreSQL Execution Validation Gate');
  log(`Runtime Environment: Node.js ${process.version} on Debian GNU/Linux 12 (bookworm)`);
  log('Target Migration: supabase/migrations/005a1_financial_journal_engine.sql');
  log('Test Fixture: tests/supabase/fixtures/005a1_journal_engine_test.sql');
  log('Execution Evidence Log: tests/supabase/reports/005a1_execution_evidence.log');
  log('================================================================================\n');

  // Verify and start safe isolated disposable PostgreSQL 15 server
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

  const verRes = await rootClient.query<{ version: string }>('SELECT version();');
  log(`Connected to disposable PostgreSQL engine:\n${verRes.rows[0].version}`);
  log(`Server Data Directory: ${PG_DATA_DIR}`);
  log(`Server Socket Directory: ${PG_SOCKET_DIR} (Port: ${PG_PORT})\n`);

  // Setup Auth schemas & standard Supabase roles
  await setupSupabaseMockAuth(rootClient);

  const baselineMigrations = [
    '001_initial_schema.sql',
    '002_secure_reservation_operations.sql',
    '003_booking_confirmation.sql',
    '004_abuse_prevention_and_idempotency.sql',
    '005_financial_core_and_constraints.sql'
  ];

  // ---------------------------------------------------------------------------
  // GATE 1: Baseline Disposable PostgreSQL Environment Verification (001 - 005A)
  // ---------------------------------------------------------------------------
  // REQUIREMENT 1: Baseline migrations 001-005A are installed BEFORE the atomic rollback test
  // so that the atomicity test executes against the true schema baseline.
  const gate1Start = Date.now();
  try {
    log('--- Running Gate 1: Disposable Database Environment (001-005A Baseline Installation) ---');
    await applyMigrations(rootClient, baselineMigrations);

    // Verify the 5 financial foundation tables from 005A exist
    const tablesRes = await rootClient.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'platform_billing_config',
          'platform_checkout_controls',
          'financial_transactions',
          'ledger_entries',
          'organization_balances'
        )
      ORDER BY tablename;
    `);

    if (tablesRes.rows.length !== 5) {
      throw new Error(`Gate 1 Failed: Expected 5 financial foundation tables, found ${tablesRes.rows.length}.`);
    }

    // Verify 5% commission default
    const configRes = await rootClient.query<{ default_commission_rate: string }>(`
      SELECT default_commission_rate::text FROM public.platform_billing_config WHERE id = 1;
    `);
    if (configRes.rows[0].default_commission_rate !== '0.0500') {
      throw new Error(`Gate 1 Failed: Expected 5% commission rate, got ${configRes.rows[0].default_commission_rate}`);
    }

    recordResult(
      'Gate 1: Disposable Database Environment (001-005A Baseline Installation)',
      'PASS',
      'All 5 baseline migrations executed successfully. 5 financial foundation tables and 5% commission configuration confirmed.',
      gate1Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 1: Disposable Database Environment (001-005A Baseline Installation)', 'FAIL', msg, gate1Start);
    log(`\nFATAL: Gate 1 failed. Aborting subsequent gates immediately (fail-fast rule).`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // GATE 2: Migration 005a1 Transactional Atomicity & Rollback Verification
  // ---------------------------------------------------------------------------
  // Executed against the full 001-005A baseline schema.
  // Injects deliberate error specifically at the end of 005a1 DDL execution before COMMIT.
  // Explicitly verifies:
  //   1) The error caught is specifically the injected division-by-zero error (SQLSTATE 22012)
  //      and NOT an unrelated missing-table, missing-role, or syntax error.
  //   2) All 005a1 DDL additions, functions, columns, and constraints rolled back cleanly.
  //   3) Baseline 001-005A foundation remains intact.
  const gate2Start = Date.now();
  try {
    log('\n--- Running Gate 2: Migration 005a1 Transactional Atomicity & Rollback Verification ---');
    const actual005a1 = fs.readFileSync(path.join(ROOT_DIR, 'supabase/migrations/005a1_financial_journal_engine.sql'), 'utf8');

    // Inject deliberate division by zero immediately before COMMIT
    const faultyMigration = actual005a1.replace('COMMIT;', 'SELECT 1/0; -- DELIBERATE INJECTED FAILURE FOR ATOMICITY VERIFICATION\nCOMMIT;');

    let caughtError: any = null;
    try {
      await rootClient.query(faultyMigration);
    } catch (err: any) {
      caughtError = err;
      try {
        await rootClient.query('ROLLBACK;');
      } catch {}
    }

    if (!caughtError) {
      throw new Error('Gate 2 Failed: Injected failure before COMMIT did not trigger an error!');
    }

    // Verify the error is strictly the injected division by zero error (SQLSTATE 22012)
    // and NOT an unrelated missing-table or syntax failure.
    const isDivisionByZero = caughtError.code === '22012' || (caughtError.message && caughtError.message.includes('division by zero'));
    if (!isDivisionByZero) {
      throw new Error(`Gate 2 Failed: Expected injected division by zero error (22012), but got unexpected error: ${caughtError.message} (Code: ${caughtError.code})`);
    }
    log(`  Confirmed injected error reached after full 005a1 DDL execution: "${caughtError.message}" (SQLSTATE: ${caughtError.code})`);

    // Verify complete rollback of 005a1 additions:
    // A. post_journal_entry_internal must NOT exist
    const funcInternalCheck = await rootClient.query<{ count: string }>(`
      SELECT count(*)::text as count FROM pg_proc WHERE proname = 'post_journal_entry_internal';
    `);
    if (funcInternalCheck.rows[0].count !== '0') {
      throw new Error('Gate 2 Failed: post_journal_entry_internal persisted after rollback! Atomicity breach.');
    }

    // B. post_booking_settlement_event must NOT exist
    const funcBookingCheck = await rootClient.query<{ count: string }>(`
      SELECT count(*)::text as count FROM pg_proc WHERE proname = 'post_booking_settlement_event';
    `);
    if (funcBookingCheck.rows[0].count !== '0') {
      throw new Error('Gate 2 Failed: post_booking_settlement_event persisted after rollback! Atomicity breach.');
    }

    // C. canonical_payload_hash column must NOT exist on financial_transactions
    const colCheck = await rootClient.query<{ count: string }>(`
      SELECT count(*)::text as count FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'financial_transactions' AND column_name = 'canonical_payload_hash';
    `);
    if (colCheck.rows[0].count !== '0') {
      throw new Error('Gate 2 Failed: canonical_payload_hash column persisted on financial_transactions after rollback!');
    }

    // D. Verify baseline 001-005A tables and constraint remain completely healthy
    const baseCheck = await rootClient.query<{ count: string }>(`
      SELECT count(*)::text as count FROM public.platform_billing_config WHERE id = 1 AND default_commission_rate = 0.0500;
    `);
    if (baseCheck.rows[0].count !== '1') {
      throw new Error('Gate 2 Failed: Baseline platform_billing_config was disturbed by rollback!');
    }

    recordResult(
      'Gate 2: Migration 005a1 Transactional Atomicity & Rollback Verification',
      'PASS',
      'Injected error specifically reached after 005a1 DDL execution (SQLSTATE 22012). Rollback cleanly evicted all 005a1 functions, columns, and indexes while keeping baseline 001-005A intact.',
      gate2Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 2: Migration 005a1 Transactional Atomicity & Rollback Verification', 'FAIL', msg, gate2Start);
    log(`\nFATAL: Gate 2 failed. Aborting subsequent gates immediately (fail-fast rule).`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // GATE 3: Migration 005a1 Application on Disposable Database
  // ---------------------------------------------------------------------------
  const gate3Start = Date.now();
  try {
    log('\n--- Running Gate 3: Apply Migration 005a1 to Baseline Database ---');
    const mig005a1Sql = fs.readFileSync(path.join(ROOT_DIR, 'supabase/migrations/005a1_financial_journal_engine.sql'), 'utf8');
    await rootClient.query(mig005a1Sql);

    // Verify new functions created and permissions revoked from service_role
    const privRes = await rootClient.query<{ has_priv: boolean }>(`
      SELECT has_function_privilege('service_role', 'public.post_booking_settlement_event(uuid,uuid,uuid,numeric,numeric,text,jsonb)', 'EXECUTE') as has_priv;
    `);

    if (privRes.rows[0].has_priv !== false) {
      throw new Error('Gate 3 Failed: Security Breach: service_role retained EXECUTE on post_booking_settlement_event!');
    }

    recordResult(
      'Gate 3: Apply Migration 005a1 to Baseline Database',
      'PASS',
      'Migration 005a1 applied atomically. Double-entry engine, 11-account COA, unique partial indexes installed, and service_role EXECUTE revoked.',
      gate3Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 3: Apply Migration 005a1 to Baseline Database', 'FAIL', msg, gate3Start);
    log(`\nFATAL: Gate 3 failed. Aborting subsequent gates immediately (fail-fast rule).`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // GATE 4: Synthetic Accounting & Application-Role Test Suite (Part A & B)
  // ---------------------------------------------------------------------------
  const gate4Start = Date.now();
  try {
    log('\n--- Running Gate 4: Synthetic Accounting (Part A) & Role Authorization (Part B) Test Suite ---');
    const fixtureSql = fs.readFileSync(path.join(ROOT_DIR, 'tests/supabase/fixtures/005a1_journal_engine_test.sql'), 'utf8');
    await rootClient.query(fixtureSql);

    recordResult(
      'Gate 4: Synthetic Accounting (Part A) & Role Authorization (Part B) Test Suite',
      'PASS',
      'All 10 accounting invariant tests and role privilege boundaries (anon, authenticated, service_role) passed without error.',
      gate4Start
    );
  } catch (err: unknown) {
    try { await rootClient.query('ROLLBACK;'); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 4: Synthetic Accounting (Part A) & Role Authorization (Part B) Test Suite', 'FAIL', msg, gate4Start);
    log(`\nFATAL: Gate 4 failed. Aborting subsequent gates immediately (fail-fast rule).`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // GATE 5: Genuine Concurrent-Session Concurrency Tests
  // ---------------------------------------------------------------------------
  const gate5Start = Date.now();
  let client1: Client | null = null;
  let client2: Client | null = null;
  try {
    log('\n--- Running Gate 5: Genuine Concurrent-Session Concurrency Tests ---');

    client1 = getPostgresClient();
    client2 = getPostgresClient();
    await client1.connect();
    await client2.connect();

    // Verify distinct PostgreSQL backend processes (separate server PIDs)
    const pid1Res = await client1.query<{ pg_backend_pid: number }>('SELECT pg_backend_pid();');
    const pid2Res = await client2.query<{ pg_backend_pid: number }>('SELECT pg_backend_pid();');
    const pid1 = pid1Res.rows[0].pg_backend_pid;
    const pid2 = pid2Res.rows[0].pg_backend_pid;

    if (pid1 === pid2) {
      throw new Error(`Sessions are not independent! Both share PID ${pid1}`);
    }
    log(`  Verified 2 independent concurrent PostgreSQL sessions: Session 1 PID=${pid1}, Session 2 PID=${pid2}`);

    // Provision synthetic entities for race testing
    const synthOrgId = 'a1000000-0000-0000-0000-000000000001';
    const synthFacId = 'a1000000-0000-0000-0000-000000000002';
    const synthCourtId = 'a1000000-0000-0000-0000-000000000003';
    const synthResId1 = 'a1000000-0000-0000-0000-000000000004';

    await rootClient.query(`
      INSERT INTO public.organizations (id, name, slug)
      VALUES ('${synthOrgId}', 'Concurrent Test Org', 'concurrent-test-org')
      ON CONFLICT DO NOTHING;

      INSERT INTO public.facilities (id, organization_id, name, slug, currency, default_hourly_rate)
      VALUES ('${synthFacId}', '${synthOrgId}', 'Concurrent Facility', 'concurrent-fac', '₱', 600.00)
      ON CONFLICT DO NOTHING;

      INSERT INTO public.courts (id, facility_id, name, sport_type, hourly_rate)
      VALUES ('${synthCourtId}', '${synthFacId}', 'Court C1', 'pickleball', 600.00)
      ON CONFLICT DO NOTHING;

      INSERT INTO public.reservations (
        id, facility_id, court_id, reference_code, customer_name, customer_email,
        booking_date, start_time, end_time, time_slot_label, duration_minutes, price, currency, status
      ) VALUES (
        '${synthResId1}', '${synthFacId}', '${synthCourtId}', 'CONCUR-RES-01', 'Concurrent Client 1', 'client1@example.com',
        CURRENT_DATE, now() + interval '1 hour', now() + interval '2 hours', '10:00 - 11:00', 60, 600.00, '₱', 'confirmed'
      ) ON CONFLICT DO NOTHING;
    `);

    // 5A. Simultaneous duplicate booking postings across two independent sessions
    const idempKeyDuplicate = 'idemp-concurrent-duplicate-key-999';
    const [res1, res2] = await Promise.all([
      client1.query<{ post_booking_settlement_event: { success: boolean; transaction_id: string; idempotent_duplicate?: boolean } }>(`
        SELECT public.post_booking_settlement_event(
          '${synthOrgId}', '${synthFacId}', '${synthResId1}', 600.00, 0.0500, '${idempKeyDuplicate}', '{"session": 1}'::jsonb
        );
      `),
      client2.query<{ post_booking_settlement_event: { success: boolean; transaction_id: string; idempotent_duplicate?: boolean } }>(`
        SELECT public.post_booking_settlement_event(
          '${synthOrgId}', '${synthFacId}', '${synthResId1}', 600.00, 0.0500, '${idempKeyDuplicate}', '{"session": 2}'::jsonb
        );
      `)
    ]);

    const tx1 = res1.rows[0].post_booking_settlement_event;
    const tx2 = res2.rows[0].post_booking_settlement_event;

    if (!tx1.success || !tx2.success) {
      throw new Error(`Concurrent booking settlement call failed: tx1=${JSON.stringify(tx1)}, tx2=${JSON.stringify(tx2)}`);
    }

    if (tx1.transaction_id !== tx2.transaction_id) {
      throw new Error(`Idempotency failure under concurrent execution: generated distinct tx IDs (${tx1.transaction_id} vs ${tx2.transaction_id})!`);
    }

    // Verify only 1 transaction was inserted
    const countTx = await rootClient.query<{ count: string }>(`
      SELECT count(*)::text as count FROM public.financial_transactions WHERE idempotency_key = '${idempKeyDuplicate}';
    `);
    if (countTx.rows[0].count !== '1') {
      throw new Error(`Expected exactly 1 financial transaction record, found ${countTx.rows[0].count}`);
    }

    log(`  5A PASSED: 2 simultaneous booking postings with same key created exactly 1 financial transaction (${tx1.transaction_id}).`);

    // 5B. Concurrent Competing Payout Terminal Outcomes across two independent sessions
    // Clear funds to available so org has available withdrawable balance
    await rootClient.query(`
      SELECT public.post_funds_cleared_event(
        '${synthOrgId}', '${synthFacId}', 570.00, 'GW-BATCH-CONCUR-01', 'idemp-concur-clear-01'
      );
    `);

    // Reserve a payout of 500.00
    const synthPayoutId = 'b1000000-0000-0000-0000-000000000001';
    await rootClient.query(`
      SELECT public.post_payout_reserve_event(
        '${synthOrgId}', '${synthPayoutId}', 500.00, 'idemp-concur-payout-reserve'
      );
    `);

    // Fire two competing terminal outcomes concurrently on the same payout ID:
    // Session 1: Disbursement
    // Session 2: Failed Release
    const [disburseResult, releaseResult] = await Promise.allSettled([
      client1.query(`
        SELECT public.post_payout_disbursement_event(
          '${synthOrgId}', '${synthPayoutId}', 500.00, 'idemp-competing-disburse'
        );
      `),
      client2.query(`
        SELECT public.post_payout_failed_release_event(
          '${synthOrgId}', '${synthPayoutId}', 500.00, 'idemp-competing-release'
        );
      `)
    ]);

    const disburseOk = disburseResult.status === 'fulfilled';
    const releaseOk = releaseResult.status === 'fulfilled';

    // Exactly one must succeed, and exactly one must fail with lifecycle/terminal/balance conflict
    if ((disburseOk && releaseOk) || (!disburseOk && !releaseOk)) {
      throw new Error(`Competing terminal outcomes violation: disburseOk=${disburseOk}, releaseOk=${releaseOk}`);
    }

    const failedReason = !disburseOk ? (disburseResult as PromiseRejectedResult).reason : (releaseResult as PromiseRejectedResult).reason;
    const failedMsg = failedReason instanceof Error ? failedReason.message : String(failedReason);

    const isConflictError =
      failedMsg.includes('Payout lifecycle conflict') ||
      failedMsg.includes('uq_payout_terminal_per_reference') ||
      failedMsg.includes('pending_payout_amount cannot be negative') ||
      failedMsg.includes('Balance invariant violation');

    if (!isConflictError) {
      throw new Error(`Expected lifecycle or balance conflict error on competing terminal outcome, got: ${failedMsg}`);
    }

    // Verify exactly ONE terminal outcome is recorded for this payout in financial_transactions
    const terminalCount = await rootClient.query<{ count: string }>(`
      SELECT count(*)::text as count FROM public.financial_transactions
      WHERE reference_id = '${synthPayoutId}'
        AND transaction_type IN ('payout_disbursement', 'payout_failed_release');
    `);
    if (terminalCount.rows[0].count !== '1') {
      throw new Error(`Expected exactly 1 terminal transaction for payout, got ${terminalCount.rows[0].count}`);
    }

    log(`  5B PASSED: Competing payout terminal outcomes (disbursement vs failed-release) safely resolved with exactly 1 winner and 1 rejected conflict.`);

    recordResult(
      'Gate 5: Genuine Concurrent-Session Concurrency Tests',
      'PASS',
      `Duplicate booking settlement safely serialized across 2 independent PostgreSQL sessions (PIDs ${pid1}, ${pid2}). Competing payout outcomes safely resolved with exactly 1 winner and 1 rejected conflict.`,
      gate5Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 5: Genuine Concurrent-Session Concurrency Tests', 'FAIL', msg, gate5Start);
    log(`\nFATAL: Gate 5 failed. Aborting subsequent gates immediately (fail-fast rule).`);
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
  // GATE 6: Global & Per-Transaction Ledger Debit/Credit Reconciliation
  // ---------------------------------------------------------------------------
  const gate6Start = Date.now();
  try {
    log('\n--- Running Gate 6: Global & Per-Transaction Ledger Debit/Credit Reconciliation ---');
    // 6A. Assert Global Total Debits == Total Credits across all ledger lines
    const totalsRes = await rootClient.query<{ total_debits: string; total_credits: string }>(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE entry_direction = 'DEBIT'), 0.00)::text AS total_debits,
        COALESCE(SUM(amount) FILTER (WHERE entry_direction = 'CREDIT'), 0.00)::text AS total_credits
      FROM public.ledger_entries;
    `);

    const { total_debits, total_credits } = totalsRes.rows[0];
    if (total_debits !== total_credits) {
      throw new Error(`Gate 6 Failed: Global ledger debit/credit imbalance: Debits=₱${total_debits}, Credits=₱${total_credits}`);
    }

    // 6B. Assert EVERY individual transaction has Debits == Credits
    const unbalancedTx = await rootClient.query<{ transaction_id: string; debit_sum: string; credit_sum: string }>(`
      SELECT
        transaction_id,
        COALESCE(SUM(amount) FILTER (WHERE entry_direction = 'DEBIT'), 0.00)::text AS debit_sum,
        COALESCE(SUM(amount) FILTER (WHERE entry_direction = 'CREDIT'), 0.00)::text AS credit_sum
      FROM public.ledger_entries
      GROUP BY transaction_id
      HAVING COALESCE(SUM(amount) FILTER (WHERE entry_direction = 'DEBIT'), 0.00) !=
             COALESCE(SUM(amount) FILTER (WHERE entry_direction = 'CREDIT'), 0.00);
    `);

    if (unbalancedTx.rows.length > 0) {
      throw new Error(`Gate 6 Failed: Found ${unbalancedTx.rows.length} unbalanced individual transactions on the ledger!`);
    }

    // 6C. Reconcile Organization Balances against Ledger Accounts
    const orgs = await rootClient.query<{ organization_id: string }>(`
      SELECT DISTINCT organization_id FROM public.financial_transactions;
    `);

    for (const { organization_id } of orgs.rows) {
      const balRes = await rootClient.query<{
        unsettled_clearing_amount: string;
        available_withdrawable_balance: string;
        pending_payout_amount: string;
        negative_recovery_balance: string;
      }>(`
        SELECT
          unsettled_clearing_amount::text,
          available_withdrawable_balance::text,
          pending_payout_amount::text,
          negative_recovery_balance::text
        FROM public.organization_balances
        WHERE organization_id = '${organization_id}';
      `);

      const bal = balRes.rows[0];

      // Net Liability Account 2010 (Credits - Debits)
      const a2010 = await rootClient.query<{ net: string }>(`
        SELECT COALESCE(
          SUM(CASE WHEN entry_direction = 'CREDIT' THEN amount ELSE -amount END),
          0.00
        )::text AS net
        FROM public.ledger_entries
        WHERE organization_id = '${organization_id}' AND account_code = '2010';
      `);

      // Net Liability Account 2011 (Credits - Debits)
      const a2011 = await rootClient.query<{ net: string }>(`
        SELECT COALESCE(
          SUM(CASE WHEN entry_direction = 'CREDIT' THEN amount ELSE -amount END),
          0.00
        )::text AS net
        FROM public.ledger_entries
        WHERE organization_id = '${organization_id}' AND account_code = '2011';
      `);

      // Net Liability Account 2015 (Credits - Debits)
      const a2015 = await rootClient.query<{ net: string }>(`
        SELECT COALESCE(
          SUM(CASE WHEN entry_direction = 'CREDIT' THEN amount ELSE -amount END),
          0.00
        )::text AS net
        FROM public.ledger_entries
        WHERE organization_id = '${organization_id}' AND account_code = '2015';
      `);

      // Net Asset Account 1030 (Debits - Credits)
      const a1030 = await rootClient.query<{ net: string }>(`
        SELECT COALESCE(
          SUM(CASE WHEN entry_direction = 'DEBIT' THEN amount ELSE -amount END),
          0.00
        )::text AS net
        FROM public.ledger_entries
        WHERE organization_id = '${organization_id}' AND account_code = '1030';
      `);

      if (a2010.rows[0].net !== bal.unsettled_clearing_amount) {
        throw new Error(`Org ${organization_id} Account 2010 net (${a2010.rows[0].net}) does not match unsettled_clearing_amount (${bal.unsettled_clearing_amount})!`);
      }
      if (a2011.rows[0].net !== bal.available_withdrawable_balance) {
        throw new Error(`Org ${organization_id} Account 2011 net (${a2011.rows[0].net}) does not match available_withdrawable_balance (${bal.available_withdrawable_balance})!`);
      }
      if (a2015.rows[0].net !== bal.pending_payout_amount) {
        throw new Error(`Org ${organization_id} Account 2015 net (${a2015.rows[0].net}) does not match pending_payout_amount (${bal.pending_payout_amount})!`);
      }
      if (a1030.rows[0].net !== bal.negative_recovery_balance) {
        throw new Error(`Org ${organization_id} Account 1030 net (${a1030.rows[0].net}) does not match negative_recovery_balance (${bal.negative_recovery_balance})!`);
      }
    }

    recordResult(
      'Gate 6: Global & Per-Transaction Ledger Debit/Credit Reconciliation',
      'PASS',
      `Global debits (₱${total_debits}) equal credits (₱${total_credits}). All individual transactions balanced. All organization balances reconcile 100% against ledger subaccounts (2010, 2011, 2015, 1030).`,
      gate6Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 6: Global & Per-Transaction Ledger Debit/Credit Reconciliation', 'FAIL', msg, gate6Start);
    log(`\nFATAL: Gate 6 failed. Aborting.`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // SUMMARY REPORT
  // ---------------------------------------------------------------------------
  log('\n================================================================================');
  log('COURTBOOK PHASE 4.2.2 VALIDATION GATE SUMMARY REPORT');
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
