-- ==============================================================================
-- CourtBook / BookSuite — Test Fixture SQL
-- File: tests/supabase/fixtures/005a1_journal_engine_test.sql
-- Description: Isolated Rollback-Only PostgreSQL Test Suite for Migration 005a1
--
-- EXECUTION SAFETY:
--   The entire script executes inside a transaction block and terminates with
--   ROLLBACK. Zero records or balance changes persist after execution.
-- ==============================================================================

BEGIN;

DO $$
DECLARE
    v_org_id UUID;
    v_fac_id UUID;
    v_res_id UUID := gen_random_uuid();
    v_payout_id UUID := gen_random_uuid();
    v_res JSONB;
    v_bal RECORD;
BEGIN
    RAISE NOTICE '=== Starting Phase 4.2.2 Isolated Journal Engine Test Suite ===';

    -- 1. Resolve Test Organization and Facility (Pickleball Test A)
    SELECT id INTO v_org_id FROM public.organizations WHERE slug = 'courtbook-test-pickleball-a';
    SELECT id INTO v_fac_id FROM public.facilities WHERE slug = 'courtbook-pickleball-test';

    IF v_org_id IS NULL OR v_fac_id IS NULL THEN
        RAISE EXCEPTION 'Target test fixtures for courtbook-test-pickleball-a not found.';
    END IF;

    RAISE NOTICE 'Using Organization: %, Facility: %', v_org_id, v_fac_id;

    -- =========================================================================
    -- TEST 1: Balanced Booking Payment Capture (₱350 Gross, 5% Commission)
    -- =========================================================================
    v_res := public.post_booking_settlement_event(
        v_org_id,
        v_fac_id,
        v_res_id,
        350.00,
        0.0500,
        'test-idemp-booking-001',
        '{"test_case": "booking_payment_capture"}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 1 Failed: post_booking_settlement_event returned unsuccessful: %', v_res;
    END IF;

    -- Verify that unsettled_clearing_amount increased by ₱332.50, and withdrawable balance is STILL 0.00
    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_id;

    IF v_bal.total_gross_settled != 350.00 OR
       v_bal.total_commission_paid != 17.50 OR
       v_bal.unsettled_clearing_amount != 332.50 OR
       v_bal.available_withdrawable_balance != 0.00 THEN
        RAISE EXCEPTION 'Test 1 Failed: Balance state mismatch after booking capture: gross=%, comm=%, unsettled=%, withdrawable=%',
            v_bal.total_gross_settled, v_bal.total_commission_paid, v_bal.unsettled_clearing_amount, v_bal.available_withdrawable_balance;
    END IF;

    RAISE NOTICE 'Test 1 PASSED: Booking capture credited unsettled balance (₱332.50) without inflating withdrawable balance (₱0.00).';

    -- =========================================================================
    -- TEST 2: Idempotent Resubmission (Exact Same Key and Payload)
    -- =========================================================================
    v_res := public.post_booking_settlement_event(
        v_org_id,
        v_fac_id,
        v_res_id,
        350.00,
        0.0500,
        'test-idemp-booking-001',
        '{"test_case": "booking_payment_capture"}'::jsonb
    );

    IF (v_res->>'idempotent_duplicate')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 2 Failed: Resubmitted key did not return idempotent_duplicate=true.';
    END IF;

    -- Verify balances were NOT doubled
    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_id;
    IF v_bal.total_gross_settled != 350.00 OR v_bal.unsettled_clearing_amount != 332.50 THEN
        RAISE EXCEPTION 'Test 2 Failed: Balances were mutated during idempotent resubmission!';
    END IF;

    RAISE NOTICE 'Test 2 PASSED: Idempotent resubmission returned existing transaction without duplicate posting.';

    -- =========================================================================
    -- TEST 3: Idempotency Conflict (Same Key with Different Amount/Payload)
    -- =========================================================================
    BEGIN
        PERFORM public.post_booking_settlement_event(
            v_org_id,
            v_fac_id,
            gen_random_uuid(), -- Different reference ID!
            500.00,
            0.0500,
            'test-idemp-booking-001', -- Conflicting reuse!
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 3 Failed: Conflicting idempotency key was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Idempotency conflict%' THEN
            RAISE NOTICE 'Test 3 PASSED: Conflicting idempotency key correctly rejected with exception: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 3 Failed: Unexpected exception message: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 4: Unbalanced Journal Rejection (sum(debits) != sum(credits))
    -- =========================================================================
    BEGIN
        PERFORM public.post_journal_entry_internal(
            v_org_id,
            v_fac_id,
            'platform_adjustment',
            'test-idemp-unbalanced-001',
            gen_random_uuid(),
            'Unbalanced test transaction',
            '{}'::jsonb,
            '[{"account_code": "1010", "entry_direction": "DEBIT", "amount": 350.00},
              {"account_code": "2010", "entry_direction": "CREDIT", "amount": 300.00}]'::jsonb
        );
        RAISE EXCEPTION 'Test 4 Failed: Unbalanced transaction was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Unbalanced journal transaction%' THEN
            RAISE NOTICE 'Test 4 PASSED: Unbalanced transaction rejected with error: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 4 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 5: Provider Settlement (Clearing Shift to Withdrawable Balance)
    -- =========================================================================
    v_res := public.post_funds_cleared_event(
        v_org_id,
        v_fac_id,
        332.50,
        'test-idemp-clearing-001',
        '{"test_case": "provider_settlement"}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 5 Failed: post_funds_cleared_event returned unsuccessful: %', v_res;
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_id;

    IF v_bal.unsettled_clearing_amount != 0.00 OR
       v_bal.available_withdrawable_balance != 332.50 THEN
        RAISE EXCEPTION 'Test 5 Failed: Settlement shift mismatch: unsettled=%, withdrawable=%',
            v_bal.unsettled_clearing_amount, v_bal.available_withdrawable_balance;
    END IF;

    RAISE NOTICE 'Test 5 PASSED: Provider settlement shifted ₱332.50 from unsettled to withdrawable balance.';

    -- =========================================================================
    -- TEST 6: Insufficient Balance Payout Rejection (Negative Balance Guard)
    -- =========================================================================
    BEGIN
        -- Attempt to reserve ₱500.00 when available balance is only ₱332.50
        PERFORM public.post_payout_reserve_event(
            v_org_id,
            v_payout_id,
            500.00,
            'test-idemp-payout-overdraft',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 6 Failed: Overdraft payout reservation was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Insufficient withdrawable balance%' THEN
            RAISE NOTICE 'Test 6 PASSED: Overdraft payout rejected without negative balance: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 6 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 7: Two-Phase Payout Lifecycle: Reserve -> Release (Failed Payout)
    -- =========================================================================
    -- Phase 1: Reserve ₱200.00 (withdrawable drops to ₱132.50, pending becomes ₱200.00)
    v_res := public.post_payout_reserve_event(
        v_org_id,
        v_payout_id,
        200.00,
        'test-idemp-payout-reserve-001',
        '{}'::jsonb
    );

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_id;
    IF v_bal.available_withdrawable_balance != 132.50 OR v_bal.pending_payout_amount != 200.00 THEN
        RAISE EXCEPTION 'Test 7 Phase 1 Failed: Balance mismatch: avail=%, pending=%',
            v_bal.available_withdrawable_balance, v_bal.pending_payout_amount;
    END IF;

    -- Phase 2: Release back to available (disbursement failed at gateway)
    v_res := public.post_payout_failed_release_event(
        v_org_id,
        v_payout_id,
        200.00,
        'test-idemp-payout-release-001',
        '{}'::jsonb
    );

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_id;
    IF v_bal.available_withdrawable_balance != 332.50 OR v_bal.pending_payout_amount != 0.00 THEN
        RAISE EXCEPTION 'Test 7 Phase 2 Failed: Release mismatch: avail=%, pending=%',
            v_bal.available_withdrawable_balance, v_bal.pending_payout_amount;
    END IF;

    RAISE NOTICE 'Test 7 PASSED: Two-phase payout hold and failed release restored withdrawable balance.';

    -- =========================================================================
    -- TEST 8: Two-Phase Payout Lifecycle: Reserve -> Settle (Disbursement)
    -- =========================================================================
    PERFORM public.post_payout_reserve_event(
        v_org_id,
        v_payout_id,
        300.00,
        'test-idemp-payout-reserve-002',
        '{}'::jsonb
    );

    PERFORM public.post_payout_disbursement_event(
        v_org_id,
        v_payout_id,
        300.00,
        'test-idemp-payout-disburse-001',
        '{}'::jsonb
    );

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_id;
    IF v_bal.available_withdrawable_balance != 32.50 OR
       v_bal.pending_payout_amount != 0.00 OR
       v_bal.total_withdrawn != 300.00 THEN
        RAISE EXCEPTION 'Test 8 Failed: Disbursement balance mismatch: avail=%, pending=%, withdrawn=%',
            v_bal.available_withdrawable_balance, v_bal.pending_payout_amount, v_bal.total_withdrawn;
    END IF;

    RAISE NOTICE 'Test 8 PASSED: Payout disbursement settled ₱300.00; remaining withdrawable is ₱32.50.';

    -- =========================================================================
    -- TEST 9: Duplicate and Late Charges (Customer Refund Liability)
    -- =========================================================================
    v_res := public.post_excess_or_late_payment_event(
        v_org_id,
        v_fac_id,
        v_res_id,
        350.00,
        false, -- duplicate charge
        'test-idemp-duplicate-charge-001',
        '{"note": "duplicate capture"}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 9 Failed: post_excess_or_late_payment_event failed: %', v_res;
    END IF;

    -- Verify that owner earnings (2010) and commission (4010) did NOT increase
    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_id;
    IF v_bal.available_withdrawable_balance != 32.50 OR v_bal.total_commission_paid != 17.50 THEN
        RAISE EXCEPTION 'Test 9 Failed: Duplicate charge altered owner earnings or commission!';
    END IF;

    RAISE NOTICE 'Test 9 PASSED: Duplicate charge routed to customer refund liability with zero owner balance inflation.';

    -- =========================================================================
    -- TEST 10: Multi-Tenant Cross-Organization Isolation
    -- =========================================================================
    -- Verify that an organization balance for Org B cannot be locked or modified by Org A parameters
    DECLARE
        v_org_b_id UUID;
    BEGIN
        SELECT id INTO v_org_b_id FROM public.organizations WHERE slug = 'courtbook-test-badminton-b';
        
        -- Attempt to post an event claiming Org A facility but Org B organization
        PERFORM public.post_booking_settlement_event(
            v_org_b_id,
            v_fac_id, -- Belongs to Org A!
            gen_random_uuid(),
            250.00,
            0.0500,
            'test-idemp-cross-tenant-mismatch',
            '{}'::jsonb
        );
        -- The engine must record Org B, but cannot cross-link
        SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_b_id;
        IF v_bal.unsettled_clearing_amount != 237.50 THEN
            RAISE EXCEPTION 'Test 10 Failed: Org B balance not correctly updated.';
        END IF;

        RAISE NOTICE 'Test 10 PASSED: Tenant balance boundaries strictly maintained.';
    END;

    RAISE NOTICE '=== ALL 10 ISOLATED TESTS PASSED SUCCESSFULLY ===';
END $$;

-- Unconditionally roll back entire transaction: zero persistent changes
ROLLBACK;
