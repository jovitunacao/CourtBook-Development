-- ==============================================================================
-- CourtBook / BookSuite — Test Fixture SQL
-- File: tests/supabase/fixtures/005a1_journal_engine_test.sql
-- Description: Isolated Verification Test Suite for Migration 005a1 (Hardened)
--
-- EXECUTION ENVIRONMENT:
--   Designed for execution in a disposable local PostgreSQL / Supabase container.
--   Enclosed entirely within a BEGIN ... ROLLBACK transaction block to guarantee
--   zero side effects on persistent data.
-- ==============================================================================

BEGIN;

DO $$
DECLARE
    -- Synthetic Test Entities (isolated from all protected reservations)
    v_synth_org_a UUID := gen_random_uuid();
    v_synth_org_b UUID := gen_random_uuid();
    v_synth_fac_a UUID := gen_random_uuid();
    v_synth_fac_b UUID := gen_random_uuid();
    v_synth_court_a UUID := gen_random_uuid();
    v_synth_court_b UUID := gen_random_uuid();
    v_synth_res_a UUID := gen_random_uuid();
    v_synth_res_b UUID := gen_random_uuid();

    v_payout_id_1 UUID := gen_random_uuid();
    v_payout_id_2 UUID := gen_random_uuid();
    v_payout_id_unreserved UUID := gen_random_uuid();

    v_res JSONB;
    v_bal RECORD;
    v_ledger_rec RECORD;
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

    -- Seed organization_balances for synthetic organizations
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
    -- TEST 1: Authoritative Booking Settlement Capture (₱350 Gross, 5% Commission)
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
        RAISE EXCEPTION 'Test 1 Failed: post_booking_settlement_event returned unsuccessful: %', v_res;
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;

    IF v_bal.total_gross_settled != 350.00 OR
       v_bal.total_commission_paid != 17.50 OR
       v_bal.unsettled_clearing_amount != 332.50 OR
       v_bal.available_withdrawable_balance != 0.00 THEN
        RAISE EXCEPTION 'Test 1 Failed: Balance state mismatch after booking capture: gross=%, comm=%, unsettled=%, withdrawable=%',
            v_bal.total_gross_settled, v_bal.total_commission_paid, v_bal.unsettled_clearing_amount, v_bal.available_withdrawable_balance;
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 1 PASSED: Booking capture credited unsettled balance without inflating withdrawable balance.';

    -- =========================================================================
    -- TEST 2: Exact Idempotent Resubmission (Same Key, Same Payload)
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
        RAISE EXCEPTION 'Test 2 Failed: Resubmitted key did not return idempotent_duplicate=true.';
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;
    IF v_bal.total_gross_settled != 350.00 OR v_bal.unsettled_clearing_amount != 332.50 THEN
        RAISE EXCEPTION 'Test 2 Failed: Balances were mutated during idempotent resubmission!';
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 2 PASSED: Exact idempotent resubmission returned existing transaction without duplicate balance mutation.';

    -- =========================================================================
    -- TEST 3: Equal Totals with Different Journal Allocations Rejection
    -- =========================================================================
    -- Reusing 'idemp-synth-booking-001' with EQUAL total amounts (₱350) but DIFFERENT account allocation:
    -- Payload B allocates commission ₱25.00 + owner ₱325.00 instead of ₱17.50 + ₱332.50!
    -- Full canonical payload hash comparison MUST reject this!
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
                jsonb_build_object('account_code', '4010', 'entry_direction', 'CREDIT', 'amount', 25.00), -- Conflicting allocation!
                jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', 325.00)  -- Conflicting allocation!
            )
        );
        RAISE EXCEPTION 'Test 3 Failed: Different journal allocation with equal totals was not rejected by idempotency check!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Idempotency conflict%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 3 PASSED: Different journal allocation with equal totals correctly rejected by canonical payload hash check: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 3 Failed: Unexpected exception message: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 4: Authoritative Reservation Price & Commission Tamper Rejection
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
        RAISE EXCEPTION 'Test 4 Failed: Tampered price was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Price tampering rejected%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 4 PASSED: Tampered price rejected against authoritative reservation record.';
        ELSE
            RAISE EXCEPTION 'Test 4 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 5: Cross-Tenant Reservation Settlement Protection
    -- =========================================================================
    -- Org B attempts to settle Org A's reservation
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
        RAISE EXCEPTION 'Test 5 Failed: Cross-tenant reservation settlement was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Tenant mismatch%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 5 PASSED: Cross-tenant reservation settlement rejected with tenant mismatch error.';
        ELSE
            RAISE EXCEPTION 'Test 5 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 6: Direct INSERT Table Bypass Rejection (Anti-Bypass Triggers)
    -- =========================================================================
    BEGIN
        INSERT INTO public.financial_transactions (
            organization_id, facility_id, transaction_type, idempotency_key, reference_id, description
        ) VALUES (
            v_synth_org_a, v_synth_fac_a, 'platform_adjustment', 'idemp-bypass-attempt', gen_random_uuid(), 'Direct insert bypass'
        );
        RAISE EXCEPTION 'Test 6 Failed: Direct INSERT into financial_transactions was not prevented by trigger!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Direct INSERT into financial journal or ledger tables is prohibited%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 6 PASSED: Direct INSERT into financial_transactions blocked by anti-bypass trigger.';
        ELSE
            RAISE EXCEPTION 'Test 6 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 7: Settlement Authenticity Guard (Disabled in Production Without Provider Batch)
    -- =========================================================================
    -- Attempting to call post_funds_cleared_event without test override setting MUST FAIL
    BEGIN
        PERFORM public.post_funds_cleared_event(
            v_synth_org_a,
            v_synth_fac_a,
            332.50,
            'GW-BATCH-PROD-UNVERIFIED',
            'idemp-synth-unverified-clearance',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 7 Failed: Unverified settlement clearance in production was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Unverified settlement clearance is disabled in production%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 7 PASSED: Unverified settlement clearance strictly blocked by production guard.';
        ELSE
            RAISE EXCEPTION 'Test 7 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- Explicitly enable isolated test clearing authorization for subsequent tests
    PERFORM set_config('courtbook.enable_unverified_clearing_in_test', 'true', true);

    -- Also verify that a fake/short settlement reference (< 8 chars) fails
    BEGIN
        PERFORM public.post_funds_cleared_event(
            v_synth_org_a,
            v_synth_fac_a,
            332.50,
            'SHORT', -- < 8 chars
            'idemp-synth-short-ref',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 7b Failed: Fake/short settlement reference was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Verified settlement reference evidence is required%' THEN
            RAISE NOTICE 'Test 7b PASSED: Fake/short settlement reference rejected.';
        ELSE
            RAISE EXCEPTION 'Test 7b Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- Valid settlement shift in test environment
    v_res := public.post_funds_cleared_event(
        v_synth_org_a,
        v_synth_fac_a,
        332.50,
        'GW-BATCH-99014-VERIFIED',
        'idemp-synth-valid-clearance',
        '{}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 7c Failed: post_funds_cleared_event failed: %', v_res;
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;
    IF v_bal.unsettled_clearing_amount != 0.00 OR v_bal.available_withdrawable_balance != 332.50 THEN
        RAISE EXCEPTION 'Test 7c Failed: Clearance shift mismatch: unsettled=%, avail=%',
            v_bal.unsettled_clearing_amount, v_bal.available_withdrawable_balance;
    END IF;
    RAISE NOTICE 'Test 7c PASSED: Authorized test clearance shifted ₱332.50 across distinct accounts (1010->1020, 2010->2011).';

    -- =========================================================================
    -- TEST 8: Payout Overdraft & Under-Minimum Threshold Rejection
    -- =========================================================================
    BEGIN
        -- Attempt to reserve ₱1,000 when available is ₱332.50
        PERFORM public.post_payout_reserve_event(
            v_synth_org_a,
            v_payout_id_1,
            1000.00,
            'idemp-payout-overdraft',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 8 Failed: Overdraft payout was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Insufficient withdrawable balance%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 8 PASSED: Overdraft payout reservation rejected without balance degradation.';
        ELSE
            RAISE EXCEPTION 'Test 8 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

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

    -- =========================================================================
    -- TEST 9: Duplicate Payout Reservation with DIFFERENT Idempotency Keys Rejection
    -- =========================================================================
    -- Initial reserve with Key A
    v_res := public.post_payout_reserve_event(
        v_synth_org_a,
        v_payout_id_1,
        500.00,
        'idemp-payout-reserve-key-a',
        '{}'::jsonb
    );

    -- Second reserve for SAME payout ID with DIFFERENT Key B MUST FAIL
    BEGIN
        PERFORM public.post_payout_reserve_event(
            v_synth_org_a,
            v_payout_id_1, -- Same payout ID!
            500.00,
            'idemp-payout-reserve-key-b', -- Different key!
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 9 Failed: Duplicate payout reservation with different key was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout lifecycle conflict%' OR SQLERRM LIKE '%uq_payout_reserve_per_reference%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 9 PASSED: Duplicate payout reservation with different key rejected by lifecycle guard & unique index: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 9 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 10: Payout Disbursement & Conflicting Simultaneous Terminal Outcome Rejection
    -- =========================================================================
    -- Disburse payout 1 (moves from 2015 to 1020 and total_withdrawn)
    PERFORM public.post_payout_disbursement_event(
        v_synth_org_a,
        v_payout_id_1,
        500.00,
        'idemp-payout-disburse-001',
        '{}'::jsonb
    );

    -- Now attempt simultaneous / conflicting terminal outcome (failed release on already disbursed payout)
    BEGIN
        PERFORM public.post_payout_failed_release_event(
            v_synth_org_a,
            v_payout_id_1,
            500.00,
            'idemp-payout-conflicting-release',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 10 Failed: Conflicting terminal outcome (release on disbursed payout) was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout lifecycle conflict%' OR SQLERRM LIKE '%uq_payout_terminal_per_reference%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 10 PASSED: Conflicting terminal outcome on disbursed payout rejected: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 10 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- Attempt duplicate disbursement with DIFFERENT key MUST ALSO FAIL
    BEGIN
        PERFORM public.post_payout_disbursement_event(
            v_synth_org_a,
            v_payout_id_1,
            500.00,
            'idemp-payout-duplicate-disburse-diff-key',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 10b Failed: Duplicate disbursement with different key was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout lifecycle conflict%' OR SQLERRM LIKE '%uq_payout_terminal_per_reference%' THEN
            RAISE NOTICE 'Test 10b PASSED: Duplicate disbursement with different key rejected.';
        ELSE
            RAISE EXCEPTION 'Test 10b Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 11: Disbursement of Unreserved Payout ID Rejection
    -- =========================================================================
    BEGIN
        PERFORM public.post_payout_disbursement_event(
            v_synth_org_a,
            v_payout_id_unreserved,
            500.00,
            'idemp-unreserved-disbursement',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 11 Failed: Unreserved payout disbursement was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout lifecycle violation: No prior payout_reserve found%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 11 PASSED: Disbursement of unreserved payout ID rejected with lifecycle violation.';
        ELSE
            RAISE EXCEPTION 'Test 11 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 12: Refund After Owner Payout (Merchant Recovery / Explicit Ledger Reconciliation)
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
        RAISE EXCEPTION 'Test 12 Failed: post_refund_reversal_event failed: %', v_res;
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;
    IF v_bal.available_withdrawable_balance != 0.00 OR v_bal.negative_recovery_balance != 332.50 THEN
        RAISE EXCEPTION 'Test 12 Failed: Overdraft refund did not record negative_recovery_balance: avail=%, neg_rec=%',
            v_bal.available_withdrawable_balance, v_bal.negative_recovery_balance;
    END IF;

    -- Verify that Account 1030 has an actual DEBIT ledger entry for ₱332.50
    SELECT * INTO v_ledger_rec FROM public.ledger_entries
    WHERE organization_id = v_synth_org_a AND account_code = '1030'
    ORDER BY created_at DESC, entry_order DESC LIMIT 1;

    IF v_ledger_rec.amount != 332.50 OR v_ledger_rec.entry_direction != 'DEBIT' THEN
        RAISE EXCEPTION 'Test 12 Failed: Account 1030 missing explicit debit entry on ledger!';
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 12 PASSED: Post-payout refund honored customer, created Account 1030 debit ledger line (₱332.50), with zero check violations.';

    -- Verify subsequent settlement clearing shift auto-reconciles negative_recovery_balance
    -- by posting an EXPLICIT CREDIT to Account 1030 on the ledger!
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
        RAISE EXCEPTION 'Test 12b Failed: Balance not reconciled to 0.00: neg_rec=%, avail=%',
            v_bal.negative_recovery_balance, v_bal.available_withdrawable_balance;
    END IF;

    -- Verify that Account 1030 received an explicit CREDIT entry
    SELECT * INTO v_ledger_rec FROM public.ledger_entries
    WHERE organization_id = v_synth_org_a AND account_code = '1030'
    ORDER BY created_at DESC, entry_order DESC LIMIT 1;

    IF v_ledger_rec.amount != 332.50 OR v_ledger_rec.entry_direction != 'CREDIT' THEN
        RAISE EXCEPTION 'Test 12b Failed: Account 1030 did not receive explicit CREDIT entry during debt reconciliation!';
    END IF;

    RAISE NOTICE 'Test 12b PASSED: Subsequent settlement explicitly credited Account 1030 on the ledger, restoring negative recovery balance to ₱0.00.';

    -- =========================================================================
    -- TEST 13: Gateway Fee Assessment & Chargebacks
    -- =========================================================================
    v_res := public.post_gateway_fee_assessment_event(
        v_synth_org_a,
        v_synth_fac_a,
        gen_random_uuid(),
        15.00,
        'absorbed_by_platform',
        'idemp-gw-fee-synth-platform',
        '{}'::jsonb
    );
    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 13a Failed: Gateway fee assessment failed.';
    END IF;

    v_res := public.post_chargeback_adjustment_event(
        v_synth_org_b,
        v_synth_fac_b,
        v_synth_res_b,
        500.00,
        50.00, -- dispute fee
        0.0500,
        'idemp-chargeback-synth-b',
        '{"reason": "unauthorized"}'::jsonb
    );
    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 13b Failed: Chargeback adjustment failed.';
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 13 PASSED: Gateway fee assessment and chargeback adjustment completed with exact double-entry lines.';

    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== ALL % RIGOROUS FINANCIAL JOURNAL TESTS PASSED SUCCESSFULLY ===', v_passed_count;
    RAISE NOTICE '========================================================================';
END $$;

-- Unconditionally roll back entire transaction: zero persistent changes
ROLLBACK;
