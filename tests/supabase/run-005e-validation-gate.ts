// ==============================================================================
// LockaCourt (AratReserve) — Migration 005E SQL Validation Gate (PGlite)
// File: tests/supabase/run-005e-validation-gate.ts
//
// Validates:
//   1. Full sequential execution of migrations 001 through 005e in PGlite (PG 18)
//   2. provider_name CHECK constraints allow 'hitpay' across all 4 payment tables
//   3. HitPay checkout session creation & strict provider matching on bind
//   4. HitPay ₱350.00 (5% = ₱17.50, owner = ₱332.50) AND ₱12,000.00 (>=10000
//      decimal amount regression check) capture + balanced double-entry ledger
//   5. Idempotency for secondary HitPay capture webhooks & PayMongo parity
//   6. HitPay verified refund reversal ('charge.updated') & late payment liability
//   7. 005D reconcile_organization_finances() reports ZERO discrepancies
// ==============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const MIGRATIONS = [
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
  '005d_financial_reconciliation_audit.sql',
  '005e_hitpay_sandbox_support.sql',
  '005f_hitpay_security_hardening.sql',
];

async function main() {
  console.log('================================================================================');
  console.log('LockaCourt — Migration 005E (HitPay Sandbox Support) SQL Validation Gate');
  console.log('================================================================================');

  const db = new PGlite({
    extensions: { uuid_ossp, pgcrypto, btree_gist },
  });

  try {
    // Bootstrap Supabase-equivalent roles & minimal auth schema
    await db.exec(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      CREATE EXTENSION IF NOT EXISTS "btree_gist";

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
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
    `);

    for (const file of MIGRATIONS) {
      const sql = fs.readFileSync(path.join(ROOT_DIR, 'supabase/migrations', file), 'utf8');
      await db.exec(sql);
      console.log(`  ✓ Applied ${file}`);
    }

    // Check 1: Verify provider_name CHECK constraints accept 'hitpay' on all 4 tables
    const constraintCheck = await db.query<{ conname: string; def: string }>(`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname IN (
        'chk_payments_provider_name',
        'chk_provider_webhook_events_provider_name',
        'chk_settlement_batches_provider_name',
        'chk_payout_methods_provider_name'
      );
    `);
    assert.equal(constraintCheck.rows.length, 4, 'All 4 provider_name constraints must exist');
    for (const row of constraintCheck.rows) {
      assert.ok(row.def.includes("'hitpay'"), `Constraint ${row.conname} must allow hitpay`);
    }
    console.log('✓ Check 1: All 4 provider_name CHECK constraints updated for hitpay');

    // Check 1B: Edge-only ACL verification on create_booking_checkout_session (005f)
    const aclCheck = await db.query<{
      sig: string;
      pub_exec: boolean;
      anon_exec: boolean;
      auth_exec: boolean;
      svc_exec: boolean;
    }>(`
      SELECT
        p.oid::regprocedure::text AS sig,
        has_function_privilege('public', p.oid, 'EXECUTE') AS pub_exec,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_exec
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'create_booking_checkout_session';
    `);
    assert.ok(aclCheck.rows.length >= 1, 'create_booking_checkout_session must exist');
    for (const fnRow of aclCheck.rows) {
      assert.equal(fnRow.pub_exec, false, `PUBLIC must NOT execute ${fnRow.sig}`);
      assert.equal(fnRow.anon_exec, false, `anon must NOT execute ${fnRow.sig}`);
      assert.equal(fnRow.auth_exec, false, `authenticated must NOT execute ${fnRow.sig}`);
      assert.equal(fnRow.svc_exec, true, `service_role MUST execute ${fnRow.sig}`);
    }

    for (const blockedRole of ['anon', 'authenticated']) {
      await db.exec('BEGIN;');
      let denied = false;
      try {
        await db.exec(`SET LOCAL ROLE ${blockedRole};`);
        await db.query(`
          SELECT public.create_booking_checkout_session(
            'idem_acl_blocked_001',
            gen_random_uuid(),
            gen_random_uuid(),
            'Blocked Caller',
            '09170000000',
            'blocked@example.com',
            current_date + 2,
            now() + interval '2 days',
            60,
            'hitpay'
          );
        `);
      } catch (err: any) {
        if (String(err?.message || '').toLowerCase().includes('permission denied')) {
          denied = true;
        }
      } finally {
        await db.exec('ROLLBACK;');
      }
      assert.equal(denied, true, `Role ${blockedRole} must fail with permission denied on create_booking_checkout_session`);
    }
    console.log('✓ Check 1B: create_booking_checkout_session restricted to service_role ONLY (PUBLIC/anon/authenticated denied)');

    // Setup isolated organization, facility, courts (₱350/hr and ₱12,000/hr)
    const orgRes = await db.query<{ id: string }>(`
      INSERT INTO public.organizations (name, slug, billing_email)
      VALUES ('LockaCourt Test Club', 'lockacourt-test-club', 'owner@lockacourt.com')
      RETURNING id;
    `);
    const orgId = orgRes.rows[0].id;

    const facRes = await db.query<{ id: string }>(`
      INSERT INTO public.facilities (organization_id, name, slug, currency, default_hourly_rate, booking_confirmation_mode, hold_duration_minutes)
      VALUES ($1, 'LockaCourt Premier Arena', 'lockacourt-premier-arena', '₱', 350.00, 'instant', 15)
      RETURNING id;
    `, [orgId]);
    const facId = facRes.rows[0].id;

    const c1Res = await db.query<{ id: string }>(`
      INSERT INTO public.courts (facility_id, name, sport_type, hourly_rate)
      VALUES ($1, 'Court 1 Standard', 'pickleball', 350.00)
      RETURNING id;
    `, [facId]);
    const court350Id = c1Res.rows[0].id;

    const c2Res = await db.query<{ id: string }>(`
      INSERT INTO public.courts (facility_id, name, sport_type, hourly_rate)
      VALUES ($1, 'VIP Full Day Hall', 'basketball', 12000.00)
      RETURNING id;
    `, [facId]);
    const court12kId = c2Res.rows[0].id;

    // Booking dates strictly in the future
    const tomorrow = new Date(Date.now() + 2 * 86_400_000);
    const yyyyMmDd = tomorrow.toISOString().slice(0, 10);
    const slot1Iso = `${yyyyMmDd}T02:00:00Z`; // 10:00 AM Asia/Manila
    const slot2Iso = `${yyyyMmDd}T04:00:00Z`; // 12:00 PM Asia/Manila
    const slot3Iso = `${yyyyMmDd}T06:00:00Z`; // 02:00 PM Asia/Manila
    const slot4Iso = `${yyyyMmDd}T08:00:00Z`; // 04:00 PM Asia/Manila

    // Check 2: HitPay ₱350.00 booking via service_role + strict provider mismatch rejection + valid bind + webhook capture
    await db.exec('BEGIN; SET LOCAL ROLE service_role;');
    const co350 = await db.query<{ res: any }>(`
      SELECT public.create_booking_checkout_session(
        'idem_005e_hitpay_350_001',
        $1::uuid,
        $2::uuid,
        'Juan Dela Cruz',
        '09171234567',
        'juan@example.com',
        $3::date,
        $4::timestamptz,
        60,
        'hitpay'
      ) AS res;
    `, [facId, court350Id, yyyyMmDd, slot1Iso]);
    await db.exec('COMMIT;');
    const co350Data = co350.rows[0].res;
    assert.equal(co350Data.provider_name, 'hitpay');
    assert.equal(Number(co350Data.expected_amount), 350);
    assert.equal(Number(co350Data.commission_amount), 17.5);
    assert.equal(Number(co350Data.owner_gross_share), 332.5);

    // Provider mismatch binding must fail
    await assert.rejects(() =>
      db.query(`
        SELECT public.bind_provider_checkout_session(
          $1::uuid, $2::uuid, 'paymongo', 'cs_wrong_provider_001', 'https://checkout.paymongo.com/x', 'idem_bind_wrong_001'
        );
      `, [co350Data.payment_id, co350Data.reservation_id])
    );

    // Non-sandbox HitPay checkout URL must fail
    await assert.rejects(() =>
      db.query(`
        SELECT public.bind_provider_checkout_session(
          $1::uuid, $2::uuid, 'hitpay', 'req_hp_live_bad_001', 'https://securecheckout.hit-pay.com/payment-request/bad', 'idem_bind_live_001'
        );
      `, [co350Data.payment_id, co350Data.reservation_id])
    );

    // Valid HitPay sandbox binding succeeds
    await db.query(`
      SELECT public.bind_provider_checkout_session(
        $1::uuid,
        $2::uuid,
        'hitpay',
        'req_hp_350_001',
        'https://securecheckout.sandbox.hit-pay.com/payment-request/@lockacourt/req_hp_350_001',
        'idem_bind_hp_350_001'
      );
    `, [co350Data.payment_id, co350Data.reservation_id]);

    // Reference mismatch in HitPay webhook must fail closed before settlement
    const wh350WrongRef = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'hitpay', 'hp_pr_req_hp_350_wrong_ref', 'payment_request.completed', 'verified',
        'abc_wrong', repeat('0', 64), 'pending',
        jsonb_build_object(
          'id', 'req_hp_350_001',
          'payment_request_id', 'req_hp_350_001',
          'payment_id', 'chg_hp_350_wrong',
          'status', 'completed',
          'amount', '350.00',
          'currency', 'PHP',
          'reference_number', 'CB-MISMATCHED-REF'
        )
      ) RETURNING id;
    `);
    await assert.rejects(() =>
      db.query(`
        SELECT public.process_verified_payment_event(
          $1::uuid, 'hitpay', 'hp_pr_req_hp_350_wrong_ref',
          'chg_hp_350_wrong', 'req_hp_350_001', 350.00, 'PHP', 'wh_proc_hp_350_wrong'
        );
      `, [wh350WrongRef.rows[0].id])
    );

    const wh350 = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'hitpay', 'hp_pr_req_hp_350_001_payment_request.completed', 'payment_request.completed', 'verified',
        'abc', repeat('a', 64), 'pending',
        jsonb_build_object(
          'id', 'req_hp_350_001',
          'payment_request_id', 'req_hp_350_001',
          'payment_id', 'chg_hp_350_001',
          'status', 'completed',
          'amount', '350.00',
          'currency', 'PHP',
          'reference_number', $1::text
        )
      ) RETURNING id;
    `, [co350Data.reference_code]);

    const proc350 = await db.query<{ res: any }>(`
      SELECT public.process_verified_payment_event(
        $1::uuid, 'hitpay', 'hp_pr_req_hp_350_001_payment_request.completed',
        'chg_hp_350_001', 'req_hp_350_001', 350.00, 'PHP', 'wh_proc_hp_350_001'
      ) AS res;
    `, [wh350.rows[0].id]);
    assert.equal(proc350.rows[0].res.outcome, 'confirmed_and_settled');
    console.log('✓ Check 2: HitPay ₱350.00 capture, reference verification, strict provider bind & 5% commission settlement passed');

    // Check 3: HitPay ₱12,000.00 high-amount decimal regression (>= 10000 NOT divided by 100!)
    const co12k = await db.query<{ res: any }>(`
      SELECT public.create_booking_checkout_session(
        'idem_005e_hitpay_12k_001', $1::uuid, $2::uuid, 'Maria Santos', '09172223344', 'maria@example.com',
        $3::date, $4::timestamptz, 60, 'hitpay'
      ) AS res;
    `, [facId, court12kId, yyyyMmDd, slot2Iso]);
    const co12kData = co12k.rows[0].res;
    assert.equal(Number(co12kData.expected_amount), 12000);
    assert.equal(Number(co12kData.commission_amount), 600);
    assert.equal(Number(co12kData.owner_gross_share), 11400);

    await db.query(`
      SELECT public.bind_provider_checkout_session(
        $1::uuid, $2::uuid, 'hitpay', 'req_hp_12k_001',
        'https://sandbox.hit-pay.com/pay/req_hp_12k_001', 'idem_bind_hp_12k_001'
      );
    `, [co12kData.payment_id, co12kData.reservation_id]);

    const wh12k = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'hitpay', 'hp_pr_req_hp_12k_001_payment_request.completed', 'payment_request.completed', 'verified',
        'def', repeat('b', 64), 'pending',
        jsonb_build_object(
          'id', 'req_hp_12k_001',
          'payment_request_id', 'req_hp_12k_001',
          'payment_id', 'chg_hp_12k_001',
          'status', 'completed',
          'amount', '12000.00',
          'currency', 'PHP',
          'reference_number', $1::text
        )
      ) RETURNING id;
    `, [co12kData.reference_code]);

    const proc12k = await db.query<{ res: any }>(`
      SELECT public.process_verified_payment_event(
        $1::uuid, 'hitpay', 'hp_pr_req_hp_12k_001_payment_request.completed',
        'chg_hp_12k_001', 'req_hp_12k_001', 12000.00, 'PHP', 'wh_proc_hp_12k_001'
      ) AS res;
    `, [wh12k.rows[0].id]);
    assert.equal(proc12k.rows[0].res.outcome, 'confirmed_and_settled');

    // Secondary HitPay charge.created webhook for same session is safely idempotent
    const wh12kCharge = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'hitpay', 'hp_chg_alt_12k_001_charge.created', 'charge.created', 'verified',
        'def2', repeat('c', 64), 'pending',
        jsonb_build_object(
          'id', 'alt_chg_12k_001',
          'payment_request_id', 'req_hp_12k_001',
          'status', 'succeeded',
          'amount', '12000.00',
          'currency', 'PHP'
        )
      ) RETURNING id;
    `);
    const dup12k = await db.query<{ res: any }>(`
      SELECT public.process_verified_payment_event(
        $1::uuid, 'hitpay', 'hp_chg_alt_12k_001_charge.created',
        'alt_chg_12k_001', 'req_hp_12k_001', 12000.00, 'PHP', 'wh_proc_hp_12k_dup',
        jsonb_build_object('reference_number', $2::text)
      ) AS res;
    `, [wh12kCharge.rows[0].id, co12kData.reference_code]);
    assert.equal(dup12k.rows[0].res.idempotent_replayed, true);
    console.log('✓ Check 3: HitPay ₱12,000.00 decimal parsing & secondary webhook idempotency passed');

    // Check 4: Repeated partial refunds, repeated deliveries, final refund & ambiguous refund rejection
    // 4.1 First partial refund (₱3,000.00 of ₱12,000.00)
    const whRefPart1 = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'hitpay', 'evt_hp_ref_12k_p1', 'charge.updated', 'verified',
        'ghi1', repeat('d', 64), 'pending',
        jsonb_build_object(
          'refund_id', 'ref_hp_12k_p1',
          'payment_id', 'chg_hp_12k_001',
          'payment_request_id', 'req_hp_12k_001',
          'status', 'partially_refunded',
          'amount_refunded', '3000.00',
          'currency', 'PHP'
        )
      ) RETURNING id;
    `);
    const refPart1Res = await db.query<{ res: any }>(`
      SELECT public.process_verified_refund_event(
        $1::uuid,
        3000.00,
        'Partial refund 1',
        'ref_hp_12k_p1',
        jsonb_build_object('webhook_event_id', $2::uuid, 'gateway_refund_verified', true, 'verified_refund_amount', 3000.00),
        'wh_refund_hp_12k_p1',
        true
      ) AS res;
    `, [co12kData.payment_id, whRefPart1.rows[0].id]);
    assert.equal(refPart1Res.rows[0].res.status, 'partially_refunded');
    assert.equal(Number(refPart1Res.rows[0].res.total_refunded), 3000);

    // 4.2 Repeated delivery of partial refund 1 with a new webhook row -> idempotent replay!
    const whRefPart1Dup = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'hitpay', 'evt_hp_ref_12k_p1_dup', 'charge.updated', 'verified',
        'ghi1b', repeat('1', 64), 'pending',
        jsonb_build_object(
          'refund_id', 'ref_hp_12k_p1',
          'payment_id', 'chg_hp_12k_001',
          'payment_request_id', 'req_hp_12k_001',
          'status', 'partially_refunded',
          'amount_refunded', '3000.00',
          'currency', 'PHP'
        )
      ) RETURNING id;
    `);
    const refPart1DupRes = await db.query<{ res: any }>(`
      SELECT public.process_verified_refund_event(
        $1::uuid,
        3000.00,
        'Partial refund 1 retry',
        'ref_hp_12k_p1',
        jsonb_build_object('webhook_event_id', $2::uuid, 'gateway_refund_verified', true, 'verified_refund_amount', 3000.00),
        'wh_refund_hp_12k_p1_dup',
        true
      ) AS res;
    `, [co12kData.payment_id, whRefPart1Dup.rows[0].id]);
    assert.equal(refPart1DupRes.rows[0].res.idempotent_replayed, true);
    assert.equal(Number(refPart1DupRes.rows[0].res.total_refunded), 3000);

    // 4.3 Second partial refund (₱4,000.00) on the same charge with cumulative amount_refunded ('7000.00')
    const whRefPart2 = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'hitpay', 'evt_hp_ref_12k_p2', 'charge.updated', 'verified',
        'ghi2', repeat('2', 64), 'pending',
        jsonb_build_object(
          'refund_id', 'ref_hp_12k_p2',
          'payment_id', 'chg_hp_12k_001',
          'payment_request_id', 'req_hp_12k_001',
          'status', 'partially_refunded',
          'amount_refunded', '7000.00',
          'currency', 'PHP'
        )
      ) RETURNING id;
    `);
    const refPart2Res = await db.query<{ res: any }>(`
      SELECT public.process_verified_refund_event(
        $1::uuid,
        4000.00,
        'Partial refund 2',
        'ref_hp_12k_p2',
        jsonb_build_object('webhook_event_id', $2::uuid, 'gateway_refund_verified', true, 'verified_refund_amount', 4000.00),
        'wh_refund_hp_12k_p2',
        true
      ) AS res;
    `, [co12kData.payment_id, whRefPart2.rows[0].id]);
    assert.equal(refPart2Res.rows[0].res.status, 'partially_refunded');
    assert.equal(Number(refPart2Res.rows[0].res.total_refunded), 7000);

    // 4.4 Ambiguous refund (missing distinct refund_id) & conflicting refund fields fail closed without posting ledger entries
    const ledgerCountBeforeAmbig = await db.query<{ cnt: string }>(`
      SELECT count(*)::text AS cnt FROM public.ledger_entries WHERE organization_id = $1::uuid;
    `, [orgId]);
    const whRefAmbig = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'hitpay', 'evt_hp_ref_12k_ambig', 'charge.updated', 'verified',
        'ghi_amb', repeat('3', 64), 'pending',
        jsonb_build_object(
          'id', 'chg_hp_12k_001',
          'payment_id', 'chg_hp_12k_001',
          'payment_request_id', 'req_hp_12k_001',
          'status', 'partially_refunded',
          'amount_refunded', '1000.00',
          'refunded_amount', '2000.00',
          'currency', 'PHP'
        )
      ) RETURNING id;
    `);
    await assert.rejects(() =>
      db.query(`
        SELECT public.process_verified_refund_event(
          $1::uuid, 1000.00, 'Ambiguous refund', 'chg_hp_12k_001',
          jsonb_build_object('webhook_event_id', $2::uuid),
          'wh_refund_hp_12k_ambig', true
        );
      `, [co12kData.payment_id, whRefAmbig.rows[0].id])
    );
    const ledgerCountAfterAmbig = await db.query<{ cnt: string }>(`
      SELECT count(*)::text AS cnt FROM public.ledger_entries WHERE organization_id = $1::uuid;
    `, [orgId]);
    assert.equal(ledgerCountAfterAmbig.rows[0].cnt, ledgerCountBeforeAmbig.rows[0].cnt, 'Ambiguous refund must post 0 ledger entries');

    // 4.5 Final refund (₱5,000.00) bringing total to ₱12,000.00 + repeated final delivery idempotency
    const whRefFinal = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'hitpay', 'evt_hp_ref_12k_final', 'charge.updated', 'verified',
        'ghi3', repeat('4', 64), 'pending',
        jsonb_build_object(
          'refund_id', 'ref_hp_12k_final',
          'payment_id', 'chg_hp_12k_001',
          'payment_request_id', 'req_hp_12k_001',
          'status', 'refunded',
          'amount_refunded', '12000.00',
          'currency', 'PHP'
        )
      ) RETURNING id;
    `);
    const refFinalRes = await db.query<{ res: any }>(`
      SELECT public.process_verified_refund_event(
        $1::uuid,
        5000.00,
        'Final refund completing full reversal',
        'ref_hp_12k_final',
        jsonb_build_object('webhook_event_id', $2::uuid, 'gateway_refund_verified', true, 'verified_refund_amount', 5000.00),
        'wh_refund_hp_12k_final',
        false
      ) AS res;
    `, [co12kData.payment_id, whRefFinal.rows[0].id]);
    assert.equal(refFinalRes.rows[0].res.status, 'refunded');
    assert.equal(Number(refFinalRes.rows[0].res.total_refunded), 12000);

    // Repeated delivery of final refund replays cleanly without error
    const whRefFinalDup = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'hitpay', 'evt_hp_ref_12k_final_dup', 'charge.updated', 'verified',
        'ghi3b', repeat('5', 64), 'pending',
        jsonb_build_object(
          'refund_id', 'ref_hp_12k_final',
          'payment_id', 'chg_hp_12k_001',
          'payment_request_id', 'req_hp_12k_001',
          'status', 'refunded',
          'amount_refunded', '12000.00',
          'currency', 'PHP'
        )
      ) RETURNING id;
    `);
    const refFinalDupRes = await db.query<{ res: any }>(`
      SELECT public.process_verified_refund_event(
        $1::uuid,
        5000.00,
        'Final refund retry',
        'ref_hp_12k_final',
        jsonb_build_object('webhook_event_id', $2::uuid, 'gateway_refund_verified', true, 'verified_refund_amount', 5000.00),
        'wh_refund_hp_12k_final_dup',
        false
      ) AS res;
    `, [co12kData.payment_id, whRefFinalDup.rows[0].id]);
    assert.equal(refFinalDupRes.rows[0].res.idempotent_replayed, true);
    assert.equal(refFinalDupRes.rows[0].res.status, 'refunded');
    console.log('✓ Check 4: Repeated partial refunds, repeated deliveries, final refund & ambiguous refund rejection passed');

    // Check 5: PayMongo regression parity via service_role in same ledger after 005f
    await db.exec('BEGIN; SET LOCAL ROLE service_role;');
    const coPm = await db.query<{ res: any }>(`
      SELECT public.create_booking_checkout_session(
        'idem_005e_paymongo_001', $1::uuid, $2::uuid, 'Pedro Reyes', '09173334455', 'pedro@example.com',
        $3::date, $4::timestamptz, 60, 'paymongo'
      ) AS res;
    `, [facId, court350Id, yyyyMmDd, slot3Iso]);
    await db.exec('COMMIT;');
    const coPmData = coPm.rows[0].res;
    await db.query(`
      SELECT public.bind_provider_checkout_session(
        $1::uuid, $2::uuid, 'paymongo', 'cs_test_005e_pm_001',
        'https://checkout.paymongo.com/cs_test_005e_pm_001', 'idem_bind_pm_001'
      );
    `, [coPmData.payment_id, coPmData.reservation_id]);
    const whPm = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'paymongo', 'evt_pm_005e_001', 'payment.paid', 'verified',
        't=1,te=x', repeat('e', 64), 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'pay_pm_005e_001', 'attributes', jsonb_build_object('amount', 35000, 'currency', 'PHP', 'status', 'paid', 'checkout_session_id', 'cs_test_005e_pm_001')))
      ) RETURNING id;
    `);
    const procPm = await db.query<{ res: any }>(`
      SELECT public.process_verified_payment_event(
        $1::uuid, 'paymongo', 'evt_pm_005e_001', 'pay_pm_005e_001', 'cs_test_005e_pm_001',
        350.00, 'PHP', 'wh_proc_pm_005e_001'
      ) AS res;
    `, [whPm.rows[0].id]);
    assert.equal(procPm.rows[0].res.outcome, 'confirmed_and_settled');
    console.log('✓ Check 5: PayMongo checkout & capture regression parity preserved');

    // Run 005D authoritative financial reconciliation across HitPay (confirmed + refunded) & PayMongo
    const preLateReconRows = await db.query(`
      SELECT * FROM public.reconcile_organization_finances($1::uuid);
    `, [orgId]);
    assert.equal(preLateReconRows.rows.length, 0, `005D reconcile_organization_finances reported discrepancies: ${JSON.stringify(preLateReconRows.rows)}`);

    const preLateSummary = await db.query<{ res: any }>(`
      SELECT public.get_financial_reconciliation_summary($1::uuid) AS res;
    `, [orgId]);
    const recon = preLateSummary.rows[0].res;
    assert.equal(Number(recon.total_discrepancies ?? -1), 0, `005D summary reported discrepancies: ${JSON.stringify(recon)}`);
    assert.equal(recon.is_healthy, true);
    assert.equal(recon.double_entry_balanced, true);
    assert.equal(recon.commission_policy_compliant, true);
    console.log('✓ Check 5B: 005D Financial Reconciliation Audit (HitPay + refund + PayMongo) passed with 0 discrepancies');

    // Check 6: Late payment liability routing with HitPay + global ledger balance
    const coLate = await db.query<{ res: any }>(`
      SELECT public.create_booking_checkout_session(
        'idem_005e_hitpay_late_001', $1::uuid, $2::uuid, 'Late Player', '09174445566', 'late@example.com',
        $3::date, $4::timestamptz, 60, 'hitpay'
      ) AS res;
    `, [facId, court350Id, yyyyMmDd, slot4Iso]);
    const coLateData = coLate.rows[0].res;
    await db.query(`
      SELECT public.bind_provider_checkout_session(
        $1::uuid, $2::uuid, 'hitpay', 'req_hp_late_001',
        'https://sandbox.hit-pay.com/pay/req_hp_late_001', 'idem_bind_hp_late_001'
      );
    `, [coLateData.payment_id, coLateData.reservation_id]);
    await db.query(`
      UPDATE public.reservations SET status = 'expired', hold_expires_at = now() - interval '5 minutes'
      WHERE id = $1::uuid;
    `, [coLateData.reservation_id]);
    const whLate = await db.query<{ id: string }>(`
      INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, payload_hash, processing_state, payload
      ) VALUES (
        'hitpay', 'evt_hp_late_001', 'payment_request.completed', 'verified',
        'jkl', repeat('f', 64), 'pending',
        jsonb_build_object('id', 'req_hp_late_001', 'payment_id', 'chg_hp_late_001', 'status', 'completed', 'amount', '350.00', 'currency', 'PHP', 'reference_number', $1::text)
      ) RETURNING id;
    `, [coLateData.reference_code]);
    const procLate = await db.query<{ res: any }>(`
      SELECT public.process_verified_payment_event(
        $1::uuid, 'hitpay', 'evt_hp_late_001', 'chg_hp_late_001', 'req_hp_late_001',
        350.00, 'PHP', 'wh_proc_hp_late_001'
      ) AS res;
    `, [whLate.rows[0].id]);
    assert.equal(procLate.rows[0].res.outcome, 'late_payment_liability_recorded');

    const lateTxCheck = await db.query<{ transaction_type: string }>(`
      SELECT transaction_type FROM public.financial_transactions
      WHERE id = $1::uuid;
    `, [procLate.rows[0].res.journal_transaction_id]);
    assert.equal(lateTxCheck.rows[0]?.transaction_type, 'late_payment_liability');

    // Confirm zero CRITICAL / BALANCE_SHEET / COMMISSION_POLICY / TENANT_ISOLATION discrepancies after late payment
    const postLateRecon = await db.query<{ discrepancy_code: string; entity_id: string }>(`
      SELECT discrepancy_code, entity_id::text FROM public.reconcile_organization_finances($1::uuid);
    `, [orgId]);
    assert.equal(postLateRecon.rows.length, 1);
    assert.equal(postLateRecon.rows[0].discrepancy_code, 'PAYMENT_MISSING_SETTLEMENT_JOURNAL');
    assert.equal(postLateRecon.rows[0].entity_id, coLateData.payment_id);

    // Check double-entry ledger global balance (total debits == total credits)
    const ledgerCheck = await db.query<{ debits: string; credits: string }>(`
      SELECT
        COALESCE(SUM(CASE WHEN entry_direction = 'DEBIT' THEN amount ELSE 0 END), 0)::text AS debits,
        COALESCE(SUM(CASE WHEN entry_direction = 'CREDIT' THEN amount ELSE 0 END), 0)::text AS credits
      FROM public.ledger_entries
      WHERE organization_id = $1::uuid;
    `, [orgId]);
    assert.equal(ledgerCheck.rows[0].debits, ledgerCheck.rows[0].credits);
    assert.ok(Number(ledgerCheck.rows[0].debits) > 0, 'Expected non-zero ledger activity');
    console.log(`✓ Check 6: Late payment liability + balanced ledger (debits=credits=${ledgerCheck.rows[0].debits}) passed`);

    console.log('================================================================================');
    console.log('ALL MIGRATION 005E SQL VALIDATION GATES PASSED!');
    console.log('================================================================================');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('Migration 005E validation gate failed:', err);
  process.exit(1);
});
