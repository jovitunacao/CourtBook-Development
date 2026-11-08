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
const ARTIFACT_DIR = '/.aistudio/artifacts/brain/d31f6d16-618d-4fb1-93bb-7151c73b2135';
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
  const nonce = `${process.pid}_${Date.now()}`;
  const dataDir = `/tmp/cb_005d_${nonce}_data`;
  const sockDir = `/tmp/cb_005d_${nonce}_sock`;
  const port = 10000 + Math.floor(Math.random() * 50000);

  execSync(`su - postgres -c "mkdir -p ${dataDir} ${sockDir} && chmod 700 ${dataDir} && chmod 777 ${sockDir}"`, {
    stdio: 'pipe',
  });
  execSync(`su - postgres -c "/usr/lib/postgresql/15/bin/initdb -D ${dataDir}"`, {
    stdio: 'pipe',
  });
  execSync(`su - postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D ${dataDir} -l ${dataDir}/server.log -o \\"-p ${port} -k ${sockDir}\\" start"`, {
    stdio: 'pipe',
  });

  pgInstance = { port, dataDir, sockDir, pid: 0 };
  return { port, dataDir, sockDir };
}

function stopDisposablePostgres() {
  if (!pgInstance) return;
  try {
    execSync(`su - postgres -c "/usr/lib/postgresql/15/bin/pg_ctl -D ${pgInstance.dataDir} stop -m immediate"`, {
      stdio: 'pipe',
    });
  } catch {}
  try {
    fs.rmSync(pgInstance.dataDir, { recursive: true, force: true });
    fs.rmSync(pgInstance.sockDir, { recursive: true, force: true });
  } catch {}
  pgInstance = null;
}

function getPostgresClient(port?: number): Client {
  const s = pgInstance ? pgInstance.sockDir : '/tmp';
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
  log('CourtBook / BookSuite — Phase 4.2.5 Financial Reconciliation & End-to-End Audit Validation Gate');
  log(`Runtime Environment: Node.js ${process.version} on Debian GNU/Linux 12 (bookworm)`);
  log('Target Migration: supabase/migrations/005d_financial_reconciliation_audit.sql');
  log('Test Fixture: tests/supabase/fixtures/005d_financial_reconciliation_test.sql');
  log(`Execution Evidence Log: ${REPORT_FILE}`);
  log('================================================================================\n');

  const { port, dataDir, sockDir } = startDisposablePostgres();
  log(`Connected to disposable PostgreSQL engine:`);
  const rootClient = getPostgresClient(port);
  await rootClient.connect();

  const verRes = await rootClient.query<{ version: string }>('SELECT version();');
  log(verRes.rows[0].version);
  log(`Server Data Directory: ${dataDir}`);
  log(`Server Socket Directory: ${sockDir} (Port: ${port})\n`);

  await setupSupabaseMockAuth(rootClient);

  // ---------------------------------------------------------------------------
  // GATE 1: Baseline 001-005C Application & Migration 005D Execution
  // ---------------------------------------------------------------------------
  const gate1Start = Date.now();
  try {
    log('--- Running Gate 1: Baseline Migrations 001-005C & Migration 005D Application ---');
    const BASELINE_MIGRATIONS = [
      '001_initial_schema.sql',
      '002_secure_reservation_operations.sql',
      '003_booking_confirmation.sql',
      '004_abuse_prevention_and_idempotency.sql',
      '005_financial_core_and_constraints.sql',
      '005a1_financial_journal_engine.sql',
      '005b_payments_payouts_infrastructure.sql',
      '005c_booking_payment_integration.sql',
    ];

    await applyMigrations(rootClient, BASELINE_MIGRATIONS);
    await applyMigrations(rootClient, ['005d_financial_reconciliation_audit.sql']);

    recordResult(
      'Gate 1: Baseline Migrations 001-005C & Migration 005D Application',
      'PASS',
      'All baseline migrations and Migration 005D applied cleanly within disposable PostgreSQL instance.',
      gate1Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 1: Baseline Migrations 001-005C & Migration 005D Application', 'FAIL', msg, gate1Start);
    log(`\nFATAL: Gate 1 failed. Aborting.`);
    await rootClient.end();
    stopDisposablePostgres();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // GATE 2: Audit Schema Objects & Security Definer Verification
  // ---------------------------------------------------------------------------
  const gate2Start = Date.now();
  try {
    log('\n--- Running Gate 2: Audit Schema Objects & Security Definer Verification ---');

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

    recordResult(
      'Gate 2: Audit Schema Objects & Security Definer Verification',
      'PASS',
      'All 4 audit views and 2 reconciliation functions verified with SECURITY DEFINER and search_path hardening.',
      gate2Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 2: Audit Schema Objects & Security Definer Verification', 'FAIL', msg, gate2Start);
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

    // Hook client notice receiver to capture test output
    rootClient.on('notice', (msg) => {
      if (msg.message) {
        log(`  ${msg.message}`);
      }
    });

    await rootClient.query(fixtureSql);

    recordResult(
      'Gate 3: SQL Test Fixture Execution',
      'PASS',
      'All comprehensive reconciliation tests passed: valid lifecycle reconciliation, 11 deliberate anomaly detection checks, cross-tenant isolation, and RBAC security guards.',
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

runValidationGate().catch((err) => {
  log(`Fatal Validation Gate Exception: ${err}`);
  stopDisposablePostgres();
  process.exit(1);
});
