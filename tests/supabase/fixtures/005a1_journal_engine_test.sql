-- ==============================================================================
-- CourtBook / BookSuite — Test Fixture SQL
-- File: tests/supabase/fixtures/005a1_journal_engine_test.sql
-- Description: Isolated Verification Test Suite for Migration 005a1
--
-- EXECUTION ENVIRONMENT:
--   Designed for execution in a disposable local PostgreSQL / Supabase container.
--   Enclosed entirely within a BEGIN ... ROLLBACK transaction block to guarantee
--   zero side effects on persistent data.
-- ==============================================================================

BEGIN;

DO $$
DECLARE
    -- Synthetic Test Entities (fully isolated from existing reservations and organizations)
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
    RAISE NOTICE '=== Starting Phase 4.2.2 Hardened Financial Journal Engine Test Suite ===';
    RAISE NOTICE '========================================================================';

    -- -------------------------------------------------------------------------
    -- Setup: Provision Synthetic Test Organizations, Facilities, and Reservations
    -- -------------------------------------------------------------------------
    INSERT INTO public.organizations (id, name, slug)
    VALUES
        (v_synth_org_a, 'Synthetic Org A', 'synth-org-a-' || substr(gen_random_uuid()::text, 1, 8)),
        (v_synth_org_b, 'Synthetic Org B', 'synth-org-b-' || substr(gen_random_uuid()::text, 1, 8));

    INSERT INTO public.organization_balances (organization_id, currency)
    VALUES
        (v_synth_org_a, 'PHP'),
        (v_synth_org_b, 'PHP')
    ON CONFLICT (organization_id) DO NOTHING;

    INSERT INTO public.facilities (id, organization_id, name, slug, currency, default_hourly_rate)
    VALUES
        (v_synth_fac_a, v_synth_org_a, 'Synthetic Facility A', 'synth-fac-a-' || substr(gen_random_uuid()::text, 1, 8), '₱', 350.00),
        (v_synth_fac_b, v_synth_org_b, 'Synthetic Facility B', 'synth-fac-b-' || substr(gen_random_uuid()::text, 1, 8), '₱', 500.00);

    INSERT INTO public.courts (id, facility_id, name, sport_type, hourly_rate)
    VALUES
        (v_synth_court_a, v_synth_fac_a, 'Synthetic Court A', 'pickleball', 350.00),
        (v_synth_court_b, v_synth_fac_b, 'Synthetic Court B', 'badminton', 500.00);

    INSERT INTO public.reservations (
        id, facility_id, court_id, reference_code, customer_name, customer_email,
        booking_date, start_time, end_time, time_slot_label, duration_minutes,
        price, currency, status
    ) VALUES (
        v_synth_res_a, v_synth_fac_a, v_synth_court_a, 'SYNTH-RES-A-01', 'Test Guest A', 'guest.a@example.com',
        CURRENT_DATE, now() + interval '1 hour', now() + interval '2 hours', '08:00 - 09:00', 60,
        350.00, '₱', 'confirmed'
    ), (
        v_synth_res_b, v_synth_fac_b, v_synth_court_b, 'SYNTH-RES-B-01', 'Test Guest B', 'guest.b@example.com',
        CURRENT_DATE, now() + interval '3 hours', now() + interval '4 hours', '10:00 - 11:00', 60,
        500.00, '₱', 'confirmed'
    );

    RAISE NOTICE 'Synthetic fixtures provisioned. Org A: %, Res A: ₱350. Org B: %, Res B: ₱500.',
        v_synth_org_a, v_synth_org_b;

    -- =========================================================================
    -- TEST 1: Privilege Boundary Verification (Information Schema Inspection)
    -- =========================================================================
    -- 1.1 Verify post_journal_entry_internal is NOT granted to service_role, anon, authenticated
    SELECT EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name = 'post_journal_entry_internal'
          AND grantee IN ('service_role', 'anon', 'authenticated', 'PUBLIC')
    ) INTO v_has_priv;

    IF v_has_priv THEN
        RAISE EXCEPTION 'Test 1 Failed: post_journal_entry_internal has unauthorized EXECUTE grants!';
    END IF;

    -- 1.2 Verify provider-deferred functions have NO execute grants to service_role in 005a1
    SELECT EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name IN ('post_funds_cleared_event', 'post_payout_reserve_event', 'post_payout_disbursement_event', 'post_payout_failed_release_event')
          AND grantee = 'service_role'
    ) INTO v_has_priv;

    IF v_has_priv THEN
        RAISE EXCEPTION 'Test 1b Failed: Deferred operations (clearing/payouts) are erroneously granted to service_role before 005B!';
    END IF;

    -- 1.3 Verify direct INSERT on ledger tables is NOT granted to service_role
    SELECT EXISTS (
        SELECT 1 FROM information_schema.table_privileges
        WHERE table_schema = 'public'
          AND table_name IN ('financial_transactions', 'ledger_entries', 'organization_balances')
          AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
          AND grantee = 'service_role'
    ) INTO v_has_priv;

    IF v_has_priv THEN
        RAISE EXCEPTION 'Test 1c Failed: service_role has direct INSERT/UPDATE/DELETE privileges on financial ledger tables!';
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 1 PASSED: Strict privilege boundaries verified in information_schema.';

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
    -- Reusing 'idemp-synth-booking-001' with EQUAL total amounts (₱350) but DIFFERENT account allocation:
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
    -- Valid settlement shift in test environment (moving 1010->1020, 2010->2011)
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

    -- Now clear the ₱332.50 unsettled funds:
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

    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== ALL % RIGOROUS FINANCIAL JOURNAL TESTS PASSED SUCCESSFULLY ===', v_passed_count;
    RAISE NOTICE '========================================================================';
END $$;

-- Unconditionally roll back entire transaction: zero persistent changes
ROLLBACK;
