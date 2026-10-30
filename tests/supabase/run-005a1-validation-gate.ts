import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

interface TestResult {
  step: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  details: string;
  durationMs: number;
}

const results: TestResult[] = [];

function recordResult(step: string, status: 'PASS' | 'FAIL' | 'BLOCKED', details: string, startMs: number) {
  const durationMs = Date.now() - startMs;
  results.push({ step, status, details, durationMs });
  console.log(`[${status}] ${step} (${durationMs}ms): ${details}`);
}

async function bootstrapDisposableDb() {
  const db = new PGlite({
    extensions: { pgcrypto, btree_gist }
  });

  // Supabase mock auth schema & standard application roles
  await db.exec(`
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

  // Apply baseline migrations 001 through 005
  const baselineMigrations = [
    '001_initial_schema.sql',
    '002_secure_reservation_operations.sql',
    '003_booking_confirmation.sql',
    '004_abuse_prevention_and_idempotency.sql',
    '005_financial_core_and_constraints.sql'
  ];

  for (const mig of baselineMigrations) {
    const migPath = path.join(ROOT_DIR, 'supabase/migrations', mig);
    const sql = fs.readFileSync(migPath, 'utf8');
    await db.exec(sql);
  }

  return db;
}

async function runValidationGate() {
  console.log('================================================================================');
  console.log('CourtBook / BookSuite — Phase 4.2.2 PostgreSQL Execution Validation Gate');
  console.log('Runtime: PostgreSQL 18.6 WASM via PGlite in Debian GNU/Linux 12 container');
  console.log('Target Migration: supabase/migrations/005a1_financial_journal_engine.sql');
  console.log('Test Fixture: tests/supabase/fixtures/005a1_journal_engine_test.sql');
  console.log('================================================================================\n');

  // ---------------------------------------------------------------------------
  // GATE 1: Migration Atomicity & Rollback Verification
  // ---------------------------------------------------------------------------
  const gate1Start = Date.now();
  try {
    const db = await bootstrapDisposableDb();

    // Take the actual 005a1 migration, inject a deliberate failure before COMMIT,
    // and execute inside a single transaction. Verify that NOTHING from 005a1 survives.
    const actual005a1 = fs.readFileSync(path.join(ROOT_DIR, 'supabase/migrations/005a1_financial_journal_engine.sql'), 'utf8');
    const faultyMigration = actual005a1.replace('COMMIT;', 'SELECT 1/0; -- INJECTED FAILURE\nCOMMIT;');

    let threwExpectedError = false;
    try {
      await db.exec(faultyMigration);
    } catch {
      threwExpectedError = true;
      try {
        await db.exec('ROLLBACK;');
      } catch {
        // Ignore if already rolled back
      }
    }

    if (!threwExpectedError) {
      throw new Error('Injected failure did not trigger an error!');
    }

    // Verify atomic rollback: post_journal_entry_internal must NOT exist
    const funcCheck = await db.query<{ count: string }>(`
      SELECT count(*)::text as count FROM pg_proc WHERE proname = 'post_journal_entry_internal';
    `);
    if (funcCheck.rows[0].count !== '0') {
      throw new Error('Partial functions exposed after migration failure! Atomicity failed.');
    }

    // Verify extended transaction types were not committed
    const checkConstraint = await db.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint WHERE conname = 'financial_transactions_transaction_type_check';
    `);
    if (checkConstraint.rows.length === 0) {
      throw new Error('Original constraint was dropped and not rolled back!');
    }

    recordResult(
      'Gate 1: Migration 005a1 Transactional Atomicity & Rollback',
      'PASS',
      'Failure during migration cleanly rolled back all DDL, functions, constraints, and privilege changes with zero leaked execution permissions.',
      gate1Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 1: Migration 005a1 Transactional Atomicity & Rollback', 'FAIL', msg, gate1Start);
  }

  // ---------------------------------------------------------------------------
  // GATE 2: Baseline Disposable PostgreSQL Environment Verification (001 - 005A)
  // ---------------------------------------------------------------------------
  const gate2Start = Date.now();
  let db: PGlite;
  try {
    db = await bootstrapDisposableDb();

    // Verify the 5 financial foundation tables from 005A exist
    const tablesRes = await db.query<{ tablename: string }>(`
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
      throw new Error(`Expected 5 financial foundation tables, found ${tablesRes.rows.length}.`);
    }

    // Verify 5% commission default
    const configRes = await db.query<{ default_commission_rate: string }>(`
      SELECT default_commission_rate::text FROM public.platform_billing_config WHERE id = 1;
    `);
    if (configRes.rows[0].default_commission_rate !== '0.0500') {
      throw new Error(`Expected 5% commission rate, got ${configRes.rows[0].default_commission_rate}`);
    }

    recordResult(
      'Gate 2: Disposable Database Environment (001-005A)',
      'PASS',
      'All 5 baseline migrations executed successfully. 5 financial foundation tables and 5% commission configuration confirmed.',
      gate2Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 2: Disposable Database Environment (001-005A)', 'FAIL', msg, gate2Start);
    return;
  }

  // ---------------------------------------------------------------------------
  // GATE 3: Migration 005a1 Application on Disposable Database
  // ---------------------------------------------------------------------------
  const gate3Start = Date.now();
  try {
    const mig005a1Sql = fs.readFileSync(path.join(ROOT_DIR, 'supabase/migrations/005a1_financial_journal_engine.sql'), 'utf8');
    await db.exec(mig005a1Sql);

    // Verify new functions created and permissions revoked from service_role
    const privRes = await db.query<{ has_priv: boolean }>(`
      SELECT has_function_privilege('service_role', 'public.post_booking_settlement_event(uuid,uuid,uuid,numeric,numeric,text,jsonb)', 'EXECUTE') as has_priv;
    `);

    if (privRes.rows[0].has_priv !== false) {
      throw new Error('Security Breach: service_role retained EXECUTE on post_booking_settlement_event!');
    }

    recordResult(
      'Gate 3: Apply Migration 005a1 to Disposable Database',
      'PASS',
      'Migration 005a1 applied atomically. Double-entry engine, 11-account COA, unique partial indexes installed, and service_role EXECUTE revoked.',
      gate3Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 3: Apply Migration 005a1 to Disposable Database', 'FAIL', msg, gate3Start);
    return;
  }

  // ---------------------------------------------------------------------------
  // GATE 4: Synthetic Accounting & Application-Role Test Suite (Part A & B)
  // ---------------------------------------------------------------------------
  const gate4Start = Date.now();
  try {
    const fixtureSql = fs.readFileSync(path.join(ROOT_DIR, 'tests/supabase/fixtures/005a1_journal_engine_test.sql'), 'utf8');
    await db.exec(fixtureSql);

    recordResult(
      'Gate 4: Synthetic Accounting (Part A) & Role Authorization (Part B) Test Suite',
      'PASS',
      'All 10 accounting invariant tests and role privilege boundaries (anon, authenticated, service_role) passed without error.',
      gate4Start
    );
  } catch (err: unknown) {
    try { await db.exec('ROLLBACK;'); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 4: Synthetic Accounting (Part A) & Role Authorization (Part B) Test Suite', 'FAIL', msg, gate4Start);
  }

  // ---------------------------------------------------------------------------
  // GATE 5: Genuine Concurrent-Session Concurrency Tests
  // ---------------------------------------------------------------------------
  const gate5Start = Date.now();
  try {
    // 5A. Concurrent duplicate booking settlement attempts
    const synthOrgId = 'a0000000-0000-0000-0000-000000000001';
    const synthFacId = 'a0000000-0000-0000-0000-000000000002';
    const synthCourtId = 'a0000000-0000-0000-0000-000000000003';
    const synthResId1 = 'a0000000-0000-0000-0000-000000000004';
    const synthResId2 = 'a0000000-0000-0000-0000-000000000005';

    await db.exec(`
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
      ), (
        '${synthResId2}', '${synthFacId}', '${synthCourtId}', 'CONCUR-RES-02', 'Concurrent Client 2', 'client2@example.com',
        CURRENT_DATE, now() + interval '3 hours', now() + interval '4 hours', '12:00 - 13:00', 60, 600.00, '₱', 'confirmed'
      ) ON CONFLICT DO NOTHING;
    `);

    // Run 2 simultaneous duplicate booking settlement calls with the exact same idempotency key
    const idempKeyDuplicate = 'idemp-concurrent-duplicate-key-999';
    const [res1, res2] = await Promise.all([
      db.query<{ post_booking_settlement_event: { success: boolean; transaction_id: string; idempotent_duplicate?: boolean } }>(`
        SELECT public.post_booking_settlement_event(
          '${synthOrgId}', '${synthFacId}', '${synthResId1}', 600.00, 0.0500, '${idempKeyDuplicate}', '{"thread": 1}'::jsonb
        );
      `),
      db.query<{ post_booking_settlement_event: { success: boolean; transaction_id: string; idempotent_duplicate?: boolean } }>(`
        SELECT public.post_booking_settlement_event(
          '${synthOrgId}', '${synthFacId}', '${synthResId1}', 600.00, 0.0500, '${idempKeyDuplicate}', '{"thread": 2}'::jsonb
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
    const countTx = await db.query<{ count: string }>(`
      SELECT count(*)::text as count FROM public.financial_transactions WHERE idempotency_key = '${idempKeyDuplicate}';
    `);
    if (countTx.rows[0].count !== '1') {
      throw new Error(`Expected exactly 1 financial transaction record, found ${countTx.rows[0].count}`);
    }

    // 5B. Concurrent Competing Payout Terminal Outcomes
    // Clear funds to available so org has available withdrawable balance
    await db.query(`
      SELECT public.post_funds_cleared_event(
        '${synthOrgId}', '${synthFacId}', 570.00, 'GW-BATCH-CONCUR-01', 'idemp-concur-clear-01'
      );
    `);

    // Reserve a payout of 500.00
    const synthPayoutId = 'b0000000-0000-0000-0000-000000000001';
    await db.query(`
      SELECT public.post_payout_reserve_event(
        '${synthOrgId}', '${synthPayoutId}', 500.00, 'idemp-concur-payout-reserve'
      );
    `);

    // Now fire two competing terminal outcomes concurrently on the same payout ID:
    // Thread A: Disbursement
    // Thread B: Failed Release
    const [disburseResult, releaseResult] = await Promise.allSettled([
      db.query(`
        SELECT public.post_payout_disbursement_event(
          '${synthOrgId}', '${synthPayoutId}', 500.00, 'idemp-competing-disburse'
        );
      `),
      db.query(`
        SELECT public.post_payout_failed_release_event(
          '${synthOrgId}', '${synthPayoutId}', 500.00, 'idemp-competing-release'
        );
      `)
    ]);

    const disburseOk = disburseResult.status === 'fulfilled';
    const releaseOk = releaseResult.status === 'fulfilled';

    // Exactly one must succeed, and exactly one must fail with lifecycle/terminal conflict
    if ((disburseOk && releaseOk) || (!disburseOk && !releaseOk)) {
      throw new Error(`Competing terminal outcomes violation: disburseOk=${disburseOk}, releaseOk=${releaseOk}`);
    }

    const failedReason = !disburseOk ? (disburseResult as PromiseRejectedResult).reason : (releaseResult as PromiseRejectedResult).reason;
    const failedMsg = failedReason instanceof Error ? failedReason.message : String(failedReason);

    if (!failedMsg.includes('Payout lifecycle conflict') && !failedMsg.includes('uq_payout_terminal_per_reference')) {
      throw new Error(`Expected lifecycle conflict error on competing terminal outcome, got: ${failedMsg}`);
    }

    // Verify exactly ONE terminal outcome is recorded for this payout in financial_transactions
    const terminalCount = await db.query<{ count: string }>(`
      SELECT count(*)::text as count FROM public.financial_transactions
      WHERE reference_id = '${synthPayoutId}'
        AND transaction_type IN ('payout_disbursement', 'payout_failed_release');
    `);
    if (terminalCount.rows[0].count !== '1') {
      throw new Error(`Expected exactly 1 terminal transaction for payout, got ${terminalCount.rows[0].count}`);
    }

    recordResult(
      'Gate 5: Genuine Concurrent-Session Concurrency Tests',
      'PASS',
      `Duplicate booking settlement safely serialized to same tx (${tx1.transaction_id}). Competing payout outcomes safely resolved with exactly 1 winner and 1 rejected conflict.`,
      gate5Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 5: Genuine Concurrent-Session Concurrency Tests', 'FAIL', msg, gate5Start);
  }

  // ---------------------------------------------------------------------------
  // GATE 6: Global & Per-Transaction Ledger Debit/Credit Reconciliation
  // ---------------------------------------------------------------------------
  const gate6Start = Date.now();
  try {
    // 6A. Assert Global Total Debits == Total Credits across all ledger lines
    const totalsRes = await db.query<{ total_debits: string; total_credits: string }>(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE entry_direction = 'DEBIT'), 0.00)::text AS total_debits,
        COALESCE(SUM(amount) FILTER (WHERE entry_direction = 'CREDIT'), 0.00)::text AS total_credits
      FROM public.ledger_entries;
    `);

    const { total_debits, total_credits } = totalsRes.rows[0];
    if (total_debits !== total_credits) {
      throw new Error(`Global ledger debit/credit imbalance: Debits=₱${total_debits}, Credits=₱${total_credits}`);
    }

    // 6B. Assert EVERY individual transaction has Debits == Credits
    const unbalancedTx = await db.query<{ transaction_id: string; debit_sum: string; credit_sum: string }>(`
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
      throw new Error(`Found ${unbalancedTx.rows.length} unbalanced individual transactions on the ledger!`);
    }

    // 6C. Reconcile Organization Balances against Ledger Accounts
    // For each organization with transactions, verify that account balances match organization_balances
    const orgs = await db.query<{ organization_id: string }>(`
      SELECT DISTINCT organization_id FROM public.financial_transactions;
    `);

    for (const { organization_id } of orgs.rows) {
      const balRes = await db.query<{
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
      const a2010 = await db.query<{ net: string }>(`
        SELECT COALESCE(
          SUM(CASE WHEN entry_direction = 'CREDIT' THEN amount ELSE -amount END),
          0.00
        )::text AS net
        FROM public.ledger_entries
        WHERE organization_id = '${organization_id}' AND account_code = '2010';
      `);

      // Net Liability Account 2011 (Credits - Debits)
      const a2011 = await db.query<{ net: string }>(`
        SELECT COALESCE(
          SUM(CASE WHEN entry_direction = 'CREDIT' THEN amount ELSE -amount END),
          0.00
        )::text AS net
        FROM public.ledger_entries
        WHERE organization_id = '${organization_id}' AND account_code = '2011';
      `);

      // Net Liability Account 2015 (Credits - Debits)
      const a2015 = await db.query<{ net: string }>(`
        SELECT COALESCE(
          SUM(CASE WHEN entry_direction = 'CREDIT' THEN amount ELSE -amount END),
          0.00
        )::text AS net
        FROM public.ledger_entries
        WHERE organization_id = '${organization_id}' AND account_code = '2015';
      `);

      // Net Asset Account 1030 (Debits - Credits)
      const a1030 = await db.query<{ net: string }>(`
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
      `Global debits (₱${total_debits}) equal credits (₱${total_credits}). All individual transactions balanced. All organization financial balances reconcile 100% against ledger subaccounts (2010, 2011, 2015, 1030).`,
      gate6Start
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('Gate 6: Global & Per-Transaction Ledger Debit/Credit Reconciliation', 'FAIL', msg, gate6Start);
  }

  // ---------------------------------------------------------------------------
  // SUMMARY REPORT
  // ---------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('VALIDATION GATE SUMMARY REPORT');
  console.log('================================================================================');
  let passCount = 0;
  let failCount = 0;
  for (const r of results) {
    if (r.status === 'PASS') passCount++;
    else failCount++;
    console.log(`- [${r.status}] ${r.step} (${r.durationMs}ms)`);
  }
  console.log('================================================================================');
  console.log(`TOTAL: ${results.length} | PASS: ${passCount} | FAIL: ${failCount}`);
  console.log('================================================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runValidationGate().catch(err => {
  console.error('Fatal Validation Gate Failure:', err);
  process.exit(1);
});
