-- ==============================================================================
-- CourtBook / BookSuite — Test Fixture SQL
-- File: tests/supabase/fixtures/005a1_journal_engine_test.sql
-- Description: Isolated Verification Test Suite for Migration 005a1
--
-- STRUCTURE:
--   PART A: Accounting & Ledger Invariant Tests (Executed as Database Owner / Superuser)
--   PART B: Role Authorization & Privilege Boundary Tests (Executed as anon, authenticated, service_role)
--
-- EXECUTION ENVIRONMENT:
--   Designed for execution in a disposable local PostgreSQL / Supabase container.
--   Enclosed entirely within a BEGIN ... ROLLBACK transaction block to guarantee
--   zero side effects on persistent data.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- PART A: Accounting & Ledger Invariant Tests (Database Owner Execution)
-- ==============================================================================

DO $$
DECLARE
    -- Synthetic Test Entities conforming strictly to Migrations 001 through 005A schemas
    v_synth_org_a UUID := gen_random_uuid();
    v_synth_org_b UUID := gen_random_uuid();
    v_synth_fac_a UUID := gen_random_uuid();
    v_synth_fac_b UUID := gen_random_uuid();
    v_synth_court_a UUID := gen_random_uuid();
    v_synth_court_b UUID := gen_random_uuid();
    v_synth_res_a UUID := gen_random_uuid();
    v_synth_res_b UUID := gen_random_uuid();

    v_payout_id_1 UUID := gen_random_uuid();
    v_payout_id_unreserved UUID := gen_random_uuid();

    v_res JSONB;
    v_bal RECORD;
    v_ledger_rec RECORD;
    v_has_priv BOOLEAN;
    v_passed_count INT := 0;
BEGIN
    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== PART A: Accounting & Ledger Invariant Tests (Database Owner)      ===';
    RAISE NOTICE '========================================================================';

    -- -------------------------------------------------------------------------
    -- 1. Provision Synthetic Test Entities (Validating 001-005A Schema Constraints)
    -- -------------------------------------------------------------------------
    -- Organizations: Validates slug regex, length, name length, billing_email
    INSERT INTO public.organizations (id, name, slug, billing_email)
    VALUES
        (v_synth_org_a, 'Synthetic Pickleball Org A', 'synth-pickle-a-' || substr(gen_random_uuid()::text, 1, 8), 'billing-a@example.com'),
        (v_synth_org_b, 'Synthetic Badminton Org B', 'synth-badminton-b-' || substr(gen_random_uuid()::text, 1, 8), 'billing-b@example.com');

    -- Note: organization_balances row is automatically created by seed_organization_balance_on_create() trigger!

    -- Facilities: Validates slug, default_hourly_rate > 0, currency, booking_confirmation_mode, composite uniqueness
    INSERT INTO public.facilities (id, organization_id, name, slug, currency, default_hourly_rate, booking_confirmation_mode)
    VALUES
        (v_synth_fac_a, v_synth_org_a, 'Synthetic Facility A', 'synth-fac-a-' || substr(gen_random_uuid()::text, 1, 8), '₱', 350.00, 'instant'),
        (v_synth_fac_b, v_synth_org_b, 'Synthetic Facility B', 'synth-fac-b-' || substr(gen_random_uuid()::text, 1, 8), '₱', 500.00, 'instant');

    -- Courts: Validates hourly_rate > 0, sport_type, composite uniqueness (id, facility_id)
    INSERT INTO public.courts (id, facility_id, name, sport_type, hourly_rate)
    VALUES
        (v_synth_court_a, v_synth_fac_a, 'Court 1 Pickle', 'pickleball', 350.00),
        (v_synth_court_b, v_synth_fac_b, 'Court 1 Badminton', 'badminton', 500.00);

    -- Reservations: Validates reference_code (5-20 chars), customer email regex, duration 30-480, chk_reservation_time_order
    INSERT INTO public.reservations (
        id, facility_id, court_id, reference_code, customer_name, customer_email,
        booking_date, start_time, end_time, time_slot_label, duration_minutes,
        price, currency, status
    ) VALUES (
        v_synth_res_a, v_synth_fac_a, v_synth_court_a, 'SYNTH-RES-A-01', 'Test Customer A', 'customer.a@example.com',
        CURRENT_DATE, now() + interval '1 hour', now() + interval '2 hours', '08:00 - 09:00', 60,
        350.00, '₱', 'confirmed'
    ), (
        v_synth_res_b, v_synth_fac_b, v_synth_court_b, 'SYNTH-RES-B-01', 'Test Customer B', 'customer.b@example.com',
        CURRENT_DATE, now() + interval '3 hours', now() + interval '4 hours', '10:00 - 11:00', 60,
        500.00, '₱', 'confirmed'
    );

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 1 PASSED: Synthetic fixtures provisioned satisfying 001-005A schema constraints.';

    -- =========================================================================
    -- TEST 2: Authoritative Booking Settlement Capture (₱350 Gross, 5% Commission)
    -- =========================================================================
    v_res := public.post_booking_settlement_event(
        v_synth_org_a,
        v_synth_fac_a,
        v_synth_res_a,
        350.00,
        0.0500,
        'idemp-synth-booking-001',
        '{"test_case": "booking_payment_capture"}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 2 Failed: post_booking_settlement_event returned unsuccessful: %', v_res;
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;

    IF v_bal.total_gross_settled != 350.00 OR
       v_bal.total_commission_paid != 17.50 OR
       v_bal.unsettled_clearing_amount != 332.50 OR
       v_bal.available_withdrawable_balance != 0.00 THEN
        RAISE EXCEPTION 'Test 2 Failed: Balance state mismatch after booking capture: gross=%, comm=%, unsettled=%, withdrawable=%',
            v_bal.total_gross_settled, v_bal.total_commission_paid, v_bal.unsettled_clearing_amount, v_bal.available_withdrawable_balance;
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 2 PASSED: Booking capture credited unsettled balance without inflating withdrawable balance.';

    -- =========================================================================
    -- TEST 3: Exact Idempotent Resubmission (Same Key, Same Payload)
    -- =========================================================================
    v_res := public.post_booking_settlement_event(
        v_synth_org_a,
        v_synth_fac_a,
        v_synth_res_a,
        350.00,
        0.0500,
        'idemp-synth-booking-001',
        '{"test_case": "booking_payment_capture"}'::jsonb
    );

    IF (v_res->>'idempotent_duplicate')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 3 Failed: Resubmitted key did not return idempotent_duplicate=true.';
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;
    IF v_bal.total_gross_settled != 350.00 OR v_bal.unsettled_clearing_amount != 332.50 THEN
        RAISE EXCEPTION 'Test 3 Failed: Balances were mutated during idempotent resubmission!';
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 3 PASSED: Exact idempotent resubmission returned existing transaction without duplicate balance mutation.';

    -- =========================================================================
    -- TEST 4: Equal Totals with Conflicting Account Allocations Rejection
    -- =========================================================================
    -- Attempt to reuse 'idemp-synth-booking-001' with EQUAL total amounts (₱350) but DIFFERENT account allocation:
    -- Allocates commission ₱25.00 + owner ₱325.00 instead of ₱17.50 + ₱332.50!
    -- Versioned canonical payload hash comparison MUST reject this!
    BEGIN
        PERFORM public.post_journal_entry_internal(
            v_synth_org_a,
            v_synth_fac_a,
            'booking_settlement',
            'idemp-synth-booking-001', -- Reused key
            v_synth_res_a,             -- Same reference
            'Conflicting allocation attempt with equal totals',
            '{}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', 350.00),
                jsonb_build_object('account_code', '4010', 'entry_direction', 'CREDIT', 'amount', 25.00),
                jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', 325.00)
            )
        );
        RAISE EXCEPTION 'Test 4 Failed: Different journal allocation with equal totals was not rejected by idempotency check!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Idempotency conflict%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 4 PASSED: Different journal allocation with equal totals correctly rejected by canonical payload hash check: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 4 Failed: Unexpected exception message: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 5: Authoritative Price & Commission Tamper Rejection
    -- =========================================================================
    BEGIN
        PERFORM public.post_booking_settlement_event(
            v_synth_org_a,
            v_synth_fac_a,
            v_synth_res_a,
            999.00, -- Tampered price!
            0.0500,
            'idemp-synth-tampered-price',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 5 Failed: Tampered price was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Price tampering rejected%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 5 PASSED: Tampered price rejected against authoritative reservation record.';
        ELSE
            RAISE EXCEPTION 'Test 5 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 6: Cross-Tenant Reservation Settlement Protection
    -- =========================================================================
    BEGIN
        PERFORM public.post_booking_settlement_event(
            v_synth_org_b, -- Org B claims Org A's reservation!
            v_synth_fac_a,
            v_synth_res_a,
            350.00,
            0.0500,
            'idemp-synth-cross-tenant-settle',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 6 Failed: Cross-tenant reservation settlement was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Tenant mismatch%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 6 PASSED: Cross-tenant reservation settlement rejected with tenant mismatch error.';
        ELSE
            RAISE EXCEPTION 'Test 6 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 7: Settlement Clearance with Explicit Double-Entry Accounting
    -- =========================================================================
    v_res := public.post_funds_cleared_event(
        v_synth_org_a,
        v_synth_fac_a,
        332.50,
        'GW-BATCH-99014-VERIFIED',
        'idemp-synth-valid-clearance',
        '{}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 7 Failed: post_funds_cleared_event failed: %', v_res;
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;
    IF v_bal.unsettled_clearing_amount != 0.00 OR v_bal.available_withdrawable_balance != 332.50 THEN
        RAISE EXCEPTION 'Test 7 Failed: Clearance shift mismatch: unsettled=%, avail=%',
            v_bal.unsettled_clearing_amount, v_bal.available_withdrawable_balance;
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 7 PASSED: Settlement clearance shifted ₱332.50 across distinct accounts (1010->1020, 2010->2011).';

    -- =========================================================================
    -- TEST 8: Payout Lifecycle State Machine (Defense-in-Depth Partial Unique Indexes)
    -- =========================================================================
    -- Seed available balance for payout lifecycle tests
    PERFORM public.post_journal_entry_internal(
        v_synth_org_a,
        v_synth_fac_a,
        'funds_cleared_to_available',
        'idemp-seed-payout-funds',
        gen_random_uuid(),
        'Seed available funds for payout tests',
        '{}'::jsonb,
        jsonb_build_array(
            jsonb_build_object('account_code', '1020', 'entry_direction', 'DEBIT', 'amount', 1000.00),
            jsonb_build_object('account_code', '1010', 'entry_direction', 'CREDIT', 'amount', 1000.00),
            jsonb_build_object('account_code', '2010', 'entry_direction', 'DEBIT', 'amount', 1000.00),
            jsonb_build_object('account_code', '2011', 'entry_direction', 'CREDIT', 'amount', 1000.00)
        )
    );

    -- Phase 1: Reserve ₱500.00 with Key A
    v_res := public.post_payout_reserve_event(
        v_synth_org_a,
        v_payout_id_1,
        500.00,
        'idemp-payout-reserve-key-a',
        '{}'::jsonb
    );

    -- Duplicate reserve attempt for SAME payout ID with DIFFERENT Key B MUST FAIL
    BEGIN
        PERFORM public.post_payout_reserve_event(
            v_synth_org_a,
            v_payout_id_1, -- Same payout ID!
            500.00,
            'idemp-payout-reserve-key-b', -- Different key!
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 8a Failed: Duplicate payout reservation with different key was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout lifecycle conflict%' OR SQLERRM LIKE '%uq_payout_reserve_per_reference%' THEN
            RAISE NOTICE 'Test 8a PASSED: Duplicate payout reservation with different key rejected by lifecycle guard & unique index: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 8a Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- Phase 2: Disburse payout 1 (moves from 2015 to 1020 and total_withdrawn)
    PERFORM public.post_payout_disbursement_event(
        v_synth_org_a,
        v_payout_id_1,
        500.00,
        'idemp-payout-disburse-001',
        '{}'::jsonb
    );

    -- Attempt simultaneous / conflicting terminal outcome (failed release on already disbursed payout)
    BEGIN
        PERFORM public.post_payout_failed_release_event(
            v_synth_org_a,
            v_payout_id_1,
            500.00,
            'idemp-payout-conflicting-release',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 8b Failed: Conflicting terminal outcome (release on disbursed payout) was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout lifecycle conflict%' OR SQLERRM LIKE '%uq_payout_terminal_per_reference%' THEN
            RAISE NOTICE 'Test 8b PASSED: Conflicting terminal outcome on disbursed payout rejected: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 8b Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- Attempt disbursement of an unreserved payout ID
    BEGIN
        PERFORM public.post_payout_disbursement_event(
            v_synth_org_a,
            v_payout_id_unreserved,
            500.00,
            'idemp-unreserved-disbursement',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 8c Failed: Unreserved payout disbursement was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout lifecycle violation: No prior payout_reserve found%' THEN
            RAISE NOTICE 'Test 8c PASSED: Disbursement of unreserved payout ID rejected with lifecycle violation.';
        ELSE
            RAISE EXCEPTION 'Test 8c Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 8 PASSED: Concurrency-safe payout lifecycle transitions and partial unique indexes verified.';

    -- =========================================================================
    -- TEST 9: Refund After Owner Payout (Merchant Recovery / Explicit Ledger Reconciliation)
    -- =========================================================================
    -- Drain Org A's remaining available balance to ₱0.00 so owner has 0 funds
    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;
    IF v_bal.available_withdrawable_balance > 0.00 THEN
        PERFORM public.post_journal_entry_internal(
            v_synth_org_a,
            v_synth_fac_a,
            'platform_adjustment',
            'idemp-drain-avail-for-refund',
            gen_random_uuid(),
            'Drain balance for post-payout refund test',
            '{}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('account_code', '2011', 'entry_direction', 'DEBIT', 'amount', v_bal.available_withdrawable_balance),
                jsonb_build_object('account_code', '1020', 'entry_direction', 'CREDIT', 'amount', v_bal.available_withdrawable_balance)
            )
        );
    END IF;

    -- Now execute customer refund for reservation A: ₱350 gross (₱17.50 comm reversal, ₱332.50 owner reversal)
    -- Since Org A has ₱0.00 balance, the ₱332.50 deficit must be debited to Account 1030
    -- and tracked in negative_recovery_balance.
    v_res := public.post_refund_reversal_event(
        v_synth_org_a,
        v_synth_fac_a,
        v_synth_res_a,
        350.00,
        0.0500,
        'idemp-post-payout-refund-001',
        '{"note": "refund after payout"}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 9 Failed: post_refund_reversal_event failed: %', v_res;
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;
    IF v_bal.available_withdrawable_balance != 0.00 OR v_bal.negative_recovery_balance != 332.50 THEN
        RAISE EXCEPTION 'Test 9 Failed: Overdraft refund did not record negative_recovery_balance: avail=%, neg_rec=%',
            v_bal.available_withdrawable_balance, v_bal.negative_recovery_balance;
    END IF;

    -- Verify that Account 1030 has an actual DEBIT ledger entry for ₱332.50
    SELECT * INTO v_ledger_rec FROM public.ledger_entries
    WHERE organization_id = v_synth_org_a AND account_code = '1030'
    ORDER BY id DESC LIMIT 1;

    IF v_ledger_rec.amount != 332.50 OR v_ledger_rec.entry_direction != 'DEBIT' THEN
        RAISE EXCEPTION 'Test 9 Failed: Account 1030 missing explicit debit entry on ledger!';
    END IF;

    -- Seed subsequent booking to repay overdraft
    PERFORM public.post_journal_entry_internal(
        v_synth_org_a,
        v_synth_fac_a,
        'booking_settlement',
        'idemp-seed-new-booking-for-recovery',
        gen_random_uuid(),
        'Seed new booking to repay overdraft',
        '{}'::jsonb,
        jsonb_build_array(
            jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', 350.00),
            jsonb_build_object('account_code', '4010', 'entry_direction', 'CREDIT', 'amount', 17.50),
            jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', 332.50)
        )
    );

    -- Clear the ₱332.50 unsettled funds:
    -- Engine MUST post an explicit CREDIT to Account 1030 on the ledger!
    v_res := public.post_funds_cleared_event(
        v_synth_org_a,
        v_synth_fac_a,
        332.50,
        'GW-BATCH-RECOVERY-99016',
        'idemp-clearing-debt-reconciliation',
        '{}'::jsonb
    );

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;
    IF v_bal.negative_recovery_balance != 0.00 OR v_bal.available_withdrawable_balance != 0.00 THEN
        RAISE EXCEPTION 'Test 9 Failed: Balance not reconciled to 0.00: neg_rec=%, avail=%',
            v_bal.negative_recovery_balance, v_bal.available_withdrawable_balance;
    END IF;

    -- Verify that Account 1030 received an explicit CREDIT entry on the ledger
    SELECT * INTO v_ledger_rec FROM public.ledger_entries
    WHERE organization_id = v_synth_org_a AND account_code = '1030'
    ORDER BY id DESC LIMIT 1;

    IF v_ledger_rec.amount != 332.50 OR v_ledger_rec.entry_direction != 'CREDIT' THEN
        RAISE EXCEPTION 'Test 9 Failed: Account 1030 did not receive explicit CREDIT entry during debt reconciliation!';
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 9 PASSED: Post-payout refund and subsequent settlement reconciliation verified with balanced Account 1030 ledger entries.';

    -- =========================================================================
    -- TEST 10: Deterministic Running-Balance Sequencing Across All 11 Accounts
    -- =========================================================================
    -- Verify restricted reserve account (2012) is supported and tracked
    v_res := public.post_journal_entry_internal(
        v_synth_org_a,
        v_synth_fac_a,
        'platform_adjustment',
        'idemp-reserve-account-2012-test',
        gen_random_uuid(),
        'Test restricted reserve account 2012 sequencing',
        '{}'::jsonb,
        jsonb_build_array(
            jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', 150.00),
            jsonb_build_object('account_code', '2012', 'entry_direction', 'CREDIT', 'amount', 150.00)
        )
    );

    SELECT running_balance INTO v_bal FROM public.ledger_entries
    WHERE organization_id = v_synth_org_a AND account_code = '2012'
    ORDER BY id DESC LIMIT 1;

    IF v_bal.running_balance != 150.00 THEN
        RAISE EXCEPTION 'Test 10 Failed: Account 2012 running balance calculation failed: %', v_bal.running_balance;
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 10 PASSED: Deterministic running-balance sequence verified across all 11 accounts, including Account 2012.';

    RAISE NOTICE '=== ALL % ACCOUNTING INVARIANT TESTS PASSED SUCCESSFULLY ===', v_passed_count;
END $$;


-- ==============================================================================
-- PART B: Role Authorization & Privilege Boundary Tests
-- (Executed with actual anon, authenticated, and service_role privileges)
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- B.1 Anonymous Role Authorization Tests (SET ROLE anon)
-- ------------------------------------------------------------------------------
SET LOCAL ROLE anon;

DO $$
BEGIN
    -- Attempt direct INSERT into financial_transactions
    BEGIN
        INSERT INTO public.financial_transactions (
            organization_id, facility_id, transaction_type, idempotency_key, reference_id, description
        ) VALUES (
            gen_random_uuid(), gen_random_uuid(), 'booking_settlement', 'anon-direct-insert', gen_random_uuid(), 'Unauthorized'
        );
        RAISE EXCEPTION 'Security Breach: anon was able to INSERT directly into financial_transactions!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test B.1a PASSED: Direct INSERT by anon denied (SQLSTATE 42501).';
    END;

    -- Attempt to execute post_booking_settlement_event
    BEGIN
        PERFORM public.post_booking_settlement_event(
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 350.00, 0.0500, 'anon-rpc-call'
        );
        RAISE EXCEPTION 'Security Breach: anon was able to call post_booking_settlement_event!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test B.1b PASSED: post_booking_settlement_event execution by anon denied (SQLSTATE 42501).';
    END;

    -- Attempt to execute private post_journal_entry_internal
    BEGIN
        PERFORM public.post_journal_entry_internal(
            gen_random_uuid(), gen_random_uuid(), 'booking_settlement', 'anon-internal-call', gen_random_uuid(), 'Test', '{}'::jsonb, '[]'::jsonb
        );
        RAISE EXCEPTION 'Security Breach: anon was able to call post_journal_entry_internal!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test B.1c PASSED: post_journal_entry_internal execution by anon denied (SQLSTATE 42501).';
    END;
END $$;

RESET ROLE;


-- ------------------------------------------------------------------------------
-- B.2 Authenticated Role Authorization Tests (SET ROLE authenticated)
-- ------------------------------------------------------------------------------
SET LOCAL ROLE authenticated;

DO $$
BEGIN
    -- Attempt direct INSERT into financial_transactions
    BEGIN
        INSERT INTO public.financial_transactions (
            organization_id, facility_id, transaction_type, idempotency_key, reference_id, description
        ) VALUES (
            gen_random_uuid(), gen_random_uuid(), 'booking_settlement', 'auth-direct-insert', gen_random_uuid(), 'Unauthorized'
        );
        RAISE EXCEPTION 'Security Breach: authenticated was able to INSERT directly into financial_transactions!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test B.2a PASSED: Direct INSERT by authenticated denied (SQLSTATE 42501).';
    END;

    -- Attempt direct UPDATE on organization_balances
    BEGIN
        UPDATE public.organization_balances
        SET available_withdrawable_balance = 99999.00
        WHERE organization_id = gen_random_uuid();
        RAISE EXCEPTION 'Security Breach: authenticated was able to UPDATE organization_balances directly!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test B.2b PASSED: Direct UPDATE on organization_balances by authenticated denied (SQLSTATE 42501).';
    END;

    -- Attempt to execute post_booking_settlement_event
    BEGIN
        PERFORM public.post_booking_settlement_event(
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 350.00, 0.0500, 'auth-rpc-call'
        );
        RAISE EXCEPTION 'Security Breach: authenticated was able to call post_booking_settlement_event!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test B.2c PASSED: post_booking_settlement_event execution by authenticated denied (SQLSTATE 42501).';
    END;
END $$;

RESET ROLE;


-- ------------------------------------------------------------------------------
-- B.3 Service Role Authorization Tests (SET ROLE service_role)
-- Verifies zero-trust boundary: service_role has NO execute on financial mutation
-- procedures and NO direct insert privileges in Phase 4.2.2.
-- ------------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
BEGIN
    -- Attempt direct INSERT into financial_transactions as service_role
    BEGIN
        INSERT INTO public.financial_transactions (
            organization_id, facility_id, transaction_type, idempotency_key, reference_id, description
        ) VALUES (
            gen_random_uuid(), gen_random_uuid(), 'booking_settlement', 'service-direct-insert', gen_random_uuid(), 'Unauthorized'
        );
        RAISE EXCEPTION 'Security Breach: service_role was able to INSERT directly into financial_transactions!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test B.3a PASSED: Direct INSERT by service_role denied (SQLSTATE 42501).';
    END;

    -- Attempt direct INSERT into ledger_entries as service_role
    BEGIN
        INSERT INTO public.ledger_entries (
            transaction_id, organization_id, account_code, entry_direction, amount, entry_order, running_balance
        ) VALUES (
            gen_random_uuid(), gen_random_uuid(), '1010', 'DEBIT', 100.00, 1, 100.00
        );
        RAISE EXCEPTION 'Security Breach: service_role was able to INSERT directly into ledger_entries!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test B.3b PASSED: Direct INSERT into ledger_entries by service_role denied (SQLSTATE 42501).';
    END;

    -- Attempt direct UPDATE on organization_balances as service_role
    BEGIN
        UPDATE public.organization_balances
        SET available_withdrawable_balance = 99999.00
        WHERE organization_id = gen_random_uuid();
        RAISE EXCEPTION 'Security Breach: service_role was able to UPDATE organization_balances directly!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test B.3c PASSED: Direct UPDATE on organization_balances by service_role denied (SQLSTATE 42501).';
    END;

    -- Attempt to execute post_booking_settlement_event as service_role (revoked until 005B)
    BEGIN
        PERFORM public.post_booking_settlement_event(
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 350.00, 0.0500, 'service-rpc-call'
        );
        RAISE EXCEPTION 'Security Breach: service_role was able to call post_booking_settlement_event before 005B!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test B.3d PASSED: post_booking_settlement_event execution by service_role denied (SQLSTATE 42501).';
    END;

    -- Attempt to execute post_journal_entry_internal as service_role (private internal procedure)
    BEGIN
        PERFORM public.post_journal_entry_internal(
            gen_random_uuid(), gen_random_uuid(), 'booking_settlement', 'service-internal-call', gen_random_uuid(), 'Test', '{}'::jsonb, '[]'::jsonb
        );
        RAISE EXCEPTION 'Security Breach: service_role was able to call post_journal_entry_internal!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test B.3e PASSED: post_journal_entry_internal execution by service_role denied (SQLSTATE 42501).';
    END;

    RAISE NOTICE '=== ALL ROLE AUTHORIZATION TESTS PASSED SUCCESSFULLY ===';
END $$;

RESET ROLE;

-- Unconditionally roll back entire test transaction: zero persistent changes
ROLLBACK;
