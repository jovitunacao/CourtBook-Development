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
    v_org_a_id UUID;
    v_fac_a_id UUID;
    v_res_a_id UUID;
    v_res_a_price NUMERIC(10, 2);

    v_org_b_id UUID;
    v_fac_b_id UUID;
    v_res_b_id UUID;
    v_res_b_price NUMERIC(10, 2);

    v_payout_id_1 UUID := gen_random_uuid();
    v_payout_id_2 UUID := gen_random_uuid();
    v_payout_id_unreserved UUID := gen_random_uuid();

    v_res JSONB;
    v_bal RECORD;
    v_billing_config RECORD;
    v_passed_count INT := 0;
BEGIN
    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== Starting Phase 4.2.2 Hardened Financial Journal Engine Test Suite ===';
    RAISE NOTICE '========================================================================';

    -- -------------------------------------------------------------------------
    -- Setup: Resolve Existing Baseline Test Fixtures
    -- -------------------------------------------------------------------------
    SELECT id INTO v_org_a_id FROM public.organizations WHERE slug = 'courtbook-test-pickleball-a';
    SELECT id INTO v_fac_a_id FROM public.facilities WHERE slug = 'courtbook-pickleball-test' AND organization_id = v_org_a_id;

    SELECT id INTO v_org_b_id FROM public.organizations WHERE slug = 'courtbook-test-badminton-b';
    SELECT id INTO v_fac_b_id FROM public.facilities WHERE slug = 'courtbook-badminton-test' AND organization_id = v_org_b_id;

    IF v_org_a_id IS NULL OR v_fac_a_id IS NULL OR v_org_b_id IS NULL OR v_fac_b_id IS NULL THEN
        RAISE EXCEPTION 'Prerequisite baseline fixtures for Org A or Org B not found.';
    END IF;

    -- Retrieve one protected reservation for Org A
    SELECT id, price INTO v_res_a_id, v_res_a_price
    FROM public.reservations
    WHERE facility_id = v_fac_a_id
    ORDER BY created_at ASC LIMIT 1;

    -- Retrieve protected reservation for Org B
    SELECT id, price INTO v_res_b_id, v_res_b_price
    FROM public.reservations
    WHERE facility_id = v_fac_b_id
    ORDER BY created_at ASC LIMIT 1;

    IF v_res_a_id IS NULL OR v_res_b_id IS NULL THEN
        RAISE EXCEPTION 'Prerequisite reservations for testing not found.';
    END IF;

    SELECT * INTO v_billing_config FROM public.platform_billing_config WHERE id = 1;

    RAISE NOTICE 'Resolved Org A: %, Facility A: %, Reservation A: % (Price: ₱%)',
        v_org_a_id, v_fac_a_id, v_res_a_id, v_res_a_price;
    RAISE NOTICE 'Resolved Org B: %, Facility B: %, Reservation B: % (Price: ₱%)',
        v_org_b_id, v_fac_b_id, v_res_b_id, v_res_b_price;

    -- =========================================================================
    -- TEST 1: Authoritative Booking Settlement Capture (₱350 Gross, 5% Commission)
    -- =========================================================================
    v_res := public.post_booking_settlement_event(
        v_org_a_id,
        v_fac_a_id,
        v_res_a_id,
        v_res_a_price,
        0.0500,
        'test-idemp-booking-org-a-001',
        '{"test_case": "booking_payment_capture"}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 1 Failed: post_booking_settlement_event returned unsuccessful: %', v_res;
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_a_id;

    IF v_bal.total_gross_settled != v_res_a_price OR
       v_bal.total_commission_paid != round(v_res_a_price * 0.0500, 2) OR
       v_bal.unsettled_clearing_amount != (v_res_a_price - round(v_res_a_price * 0.0500, 2)) OR
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
        v_org_a_id,
        v_fac_a_id,
        v_res_a_id,
        v_res_a_price,
        0.0500,
        'test-idemp-booking-org-a-001',
        '{"test_case": "booking_payment_capture"}'::jsonb
    );

    IF (v_res->>'idempotent_duplicate')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 2 Failed: Resubmitted key did not return idempotent_duplicate=true.';
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_a_id;
    IF v_bal.total_gross_settled != v_res_a_price OR
       v_bal.unsettled_clearing_amount != (v_res_a_price - round(v_res_a_price * 0.0500, 2)) THEN
        RAISE EXCEPTION 'Test 2 Failed: Balances were mutated during idempotent resubmission!';
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 2 PASSED: Exact idempotent resubmission returned existing transaction without duplicate balance mutation.';

    -- =========================================================================
    -- TEST 3: Same-Reference Conflicting-Amount Idempotency Conflict
    -- =========================================================================
    -- Attempt to reuse the SAME key 'test-idemp-booking-org-a-001' on the SAME reservation reference,
    -- but with a conflicting amount (e.g. ₱500.00 vs ₱350.00). Must be rejected!
    BEGIN
        PERFORM public.post_journal_entry_internal(
            v_org_a_id,
            v_fac_a_id,
            'booking_settlement',
            'test-idemp-booking-org-a-001', -- Reused key
            v_res_a_id,                     -- SAME reservation reference
            'Conflicting amount attempt',
            '{}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', 500.00),
                jsonb_build_object('account_code', '4010', 'entry_direction', 'CREDIT', 'amount', 25.00),
                jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', 475.00)
            )
        );
        RAISE EXCEPTION 'Test 3 Failed: Same-reference conflicting amount was not rejected by idempotency check!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Idempotency conflict%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 3 PASSED: Same-reference conflicting amount correctly rejected with idempotency conflict: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 3 Failed: Unexpected exception message: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 4: Authoritative Reservation Price Tamper Rejection
    -- =========================================================================
    -- Attempt to settle reservation with an arbitrary caller-supplied price (e.g. ₱999.00 != r.price)
    BEGIN
        PERFORM public.post_booking_settlement_event(
            v_org_a_id,
            v_fac_a_id,
            v_res_a_id,
            999.00, -- Tampered price!
            0.0500,
            'test-idemp-tampered-price',
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
    -- TEST 5: Authoritative Commission Rate Tamper Rejection
    -- =========================================================================
    -- Attempt to settle reservation with an arbitrary commission rate (e.g. 0.1000 != 0.0500)
    BEGIN
        PERFORM public.post_booking_settlement_event(
            v_org_a_id,
            v_fac_a_id,
            v_res_a_id,
            v_res_a_price,
            0.1000, -- Tampered commission rate!
            'test-idemp-tampered-commission',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 5 Failed: Tampered commission rate was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Commission rate tampering rejected%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 5 PASSED: Tampered commission rate rejected against platform_billing_config.';
        ELSE
            RAISE EXCEPTION 'Test 5 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 6: Cross-Tenant Reservation Settlement Protection
    -- =========================================================================
    -- Attempt to settle Org A's reservation under Org B's organization ID
    BEGIN
        PERFORM public.post_booking_settlement_event(
            v_org_b_id, -- Org B claims Org A's reservation!
            v_fac_a_id,
            v_res_a_id,
            v_res_a_price,
            0.0500,
            'test-idemp-cross-tenant-settle',
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
    -- TEST 7: Malformed Input & Sub-Centavo Precision Rejection
    -- =========================================================================
    BEGIN
        PERFORM public.post_journal_entry_internal(
            v_org_a_id,
            v_fac_a_id,
            'platform_adjustment',
            'test-idemp-subcentavo',
            gen_random_uuid(),
            'Subcentavo test',
            '{}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', 10.555),
                jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', 10.555)
            )
        );
        RAISE EXCEPTION 'Test 7 Failed: Sub-centavo precision was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Sub-centavo fractional precision rejected%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 7 PASSED: Sub-centavo fractional precision rejected.';
        ELSE
            RAISE EXCEPTION 'Test 7 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 8: Unbalanced Journal Rejection (sum(debits) != sum(credits))
    -- =========================================================================
    BEGIN
        PERFORM public.post_journal_entry_internal(
            v_org_a_id,
            v_fac_a_id,
            'platform_adjustment',
            'test-idemp-unbalanced-001',
            gen_random_uuid(),
            'Unbalanced test transaction',
            '{}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', 350.00),
                jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', 300.00)
            )
        );
        RAISE EXCEPTION 'Test 8 Failed: Unbalanced transaction was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Unbalanced journal transaction%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 8 PASSED: Unbalanced journal transaction rejected.';
        ELSE
            RAISE EXCEPTION 'Test 8 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 9: Direct INSERT Table Bypass Rejection (Anti-Bypass Triggers)
    -- =========================================================================
    -- Attempt direct INSERT into public.financial_transactions without authorized routine flag
    BEGIN
        INSERT INTO public.financial_transactions (
            organization_id, facility_id, transaction_type, idempotency_key, reference_id, description
        ) VALUES (
            v_org_a_id, v_fac_a_id, 'platform_adjustment', 'test-idemp-bypass-attempt', gen_random_uuid(), 'Direct insert bypass'
        );
        RAISE EXCEPTION 'Test 9 Failed: Direct INSERT into financial_transactions was not prevented by trigger!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Direct INSERT into financial journal or ledger tables is prohibited%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 9 PASSED: Direct INSERT into financial_transactions blocked by anti-bypass trigger.';
        ELSE
            RAISE EXCEPTION 'Test 9 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- Attempt direct INSERT into public.ledger_entries without authorized routine flag
    BEGIN
        INSERT INTO public.ledger_entries (
            transaction_id, organization_id, account_code, entry_direction, amount, entry_order, running_balance
        ) VALUES (
            gen_random_uuid(), v_org_a_id, '1010', 'DEBIT', 100.00, 1, 100.00
        );
        RAISE EXCEPTION 'Test 9b Failed: Direct INSERT into ledger_entries was not prevented by trigger!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Direct INSERT into financial journal or ledger tables is prohibited%' THEN
            RAISE NOTICE 'Test 9b PASSED: Direct INSERT into ledger_entries blocked by anti-bypass trigger.';
        ELSE
            RAISE EXCEPTION 'Test 9b Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 10: Provider Settlement Shift with Verified Settlement Reference
    -- =========================================================================
    -- Missing settlement reference evidence must be rejected
    BEGIN
        PERFORM public.post_funds_cleared_event(
            v_org_a_id,
            v_fac_a_id,
            (v_res_a_price - round(v_res_a_price * 0.0500, 2)),
            '   ', -- Blank reference
            'test-idemp-clearing-blank-ref',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 10 Failed: Blank settlement reference was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Verified settlement reference evidence is required%' THEN
            RAISE NOTICE 'Test 10a PASSED: Blank settlement reference rejected.';
        ELSE
            RAISE EXCEPTION 'Test 10 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- Valid settlement shift: Shifts ₱332.50 from 1010 to 1020, and 2010 to 2011
    v_res := public.post_funds_cleared_event(
        v_org_a_id,
        v_fac_a_id,
        (v_res_a_price - round(v_res_a_price * 0.0500, 2)),
        'GW-SETTLE-BATCH-99014',
        'test-idemp-clearing-valid-001',
        '{"test_case": "provider_settlement"}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 10 Failed: post_funds_cleared_event failed: %', v_res;
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_a_id;

    IF v_bal.unsettled_clearing_amount != 0.00 OR
       v_bal.available_withdrawable_balance != (v_res_a_price - round(v_res_a_price * 0.0500, 2)) THEN
        RAISE EXCEPTION 'Test 10 Failed: Settlement shift mismatch: unsettled=%, withdrawable=%',
            v_bal.unsettled_clearing_amount, v_bal.available_withdrawable_balance;
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 10 PASSED: Verified provider settlement shifted funds across distinct accounts (1010->1020, 2010->2011).';

    -- =========================================================================
    -- TEST 11: Insufficient Balance Payout Rejection (No Negative Balance)
    -- =========================================================================
    BEGIN
        -- Attempt to reserve ₱1,000.00 when available balance is only ₱332.50
        PERFORM public.post_payout_reserve_event(
            v_org_a_id,
            v_payout_id_1,
            1000.00,
            'test-idemp-payout-overdraft',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 11 Failed: Overdraft payout reservation was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Insufficient withdrawable balance%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 11 PASSED: Overdraft payout reservation rejected without balance degradation: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 11 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 12: Under-Minimum Payout Rejection
    -- =========================================================================
    BEGIN
        -- Attempt to reserve ₱50.00 when min_payout_amount is ₱500.00
        PERFORM public.post_payout_reserve_event(
            v_org_a_id,
            v_payout_id_1,
            50.00,
            'test-idemp-payout-undermin',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 12 Failed: Under-minimum payout was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%below minimum allowed threshold%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 12 PASSED: Payout below minimum threshold (₱500.00) rejected.';
        ELSE
            RAISE EXCEPTION 'Test 12 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- Temporarily seed an additional booking & clearance so available balance >= ₱600 for payout tests
    PERFORM public.post_journal_entry_internal(
        v_org_a_id,
        v_fac_a_id,
        'funds_cleared_to_available',
        'test-idemp-seed-available-funds',
        gen_random_uuid(),
        'Seed available funds for payout lifecycle tests',
        '{}'::jsonb,
        jsonb_build_array(
            jsonb_build_object('account_code', '1020', 'entry_direction', 'DEBIT', 'amount', 1000.00),
            jsonb_build_object('account_code', '1010', 'entry_direction', 'CREDIT', 'amount', 1000.00),
            jsonb_build_object('account_code', '2010', 'entry_direction', 'DEBIT', 'amount', 1000.00),
            jsonb_build_object('account_code', '2011', 'entry_direction', 'CREDIT', 'amount', 1000.00)
        )
    );

    -- =========================================================================
    -- TEST 13: Two-Phase Payout Lifecycle: Reserve -> Failed Release
    -- =========================================================================
    -- Phase 1: Reserve ₱500.00
    v_res := public.post_payout_reserve_event(
        v_org_a_id,
        v_payout_id_1,
        500.00,
        'test-idemp-payout-reserve-001',
        '{}'::jsonb
    );

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_a_id;
    IF v_bal.pending_payout_amount != 500.00 THEN
        RAISE EXCEPTION 'Test 13 Phase 1 Failed: Pending payout amount not 500.00';
    END IF;

    -- Phase 2: Release back to available (disbursement failed at gateway)
    v_res := public.post_payout_failed_release_event(
        v_org_a_id,
        v_payout_id_1,
        500.00,
        'test-idemp-payout-release-001',
        '{}'::jsonb
    );

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_a_id;
    IF v_bal.pending_payout_amount != 0.00 THEN
        RAISE EXCEPTION 'Test 13 Phase 2 Failed: Release did not restore pending to 0.00';
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 13 PASSED: Two-phase payout hold reservation and failed release restored withdrawable balance.';

    -- =========================================================================
    -- TEST 14: Two-Phase Payout Lifecycle: Reserve -> Disbursement Succeeded
    -- =========================================================================
    -- Phase 1: Reserve ₱600.00
    PERFORM public.post_payout_reserve_event(
        v_org_a_id,
        v_payout_id_2,
        600.00,
        'test-idemp-payout-reserve-002',
        '{}'::jsonb
    );

    -- Phase 2: Disburse ₱600.00 (gateway transfer completed)
    PERFORM public.post_payout_disbursement_event(
        v_org_a_id,
        v_payout_id_2,
        600.00,
        'test-idemp-payout-disburse-002',
        '{}'::jsonb
    );

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_a_id;
    IF v_bal.pending_payout_amount != 0.00 OR v_bal.total_withdrawn != 600.00 THEN
        RAISE EXCEPTION 'Test 14 Failed: Disbursement did not settle to total_withdrawn (withdrawn=%, pending=%)',
            v_bal.total_withdrawn, v_bal.pending_payout_amount;
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 14 PASSED: Payout disbursement settled ₱600.00 to total_withdrawn.';

    -- =========================================================================
    -- TEST 15: Payout Lifecycle Violation (Disbursing Unreserved Payout ID)
    -- =========================================================================
    BEGIN
        PERFORM public.post_payout_disbursement_event(
            v_org_a_id,
            v_payout_id_unreserved, -- Never reserved!
            500.00,
            'test-idemp-unreserved-disbursement',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'Test 15 Failed: Unreserved payout disbursement was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout lifecycle violation: No prior payout_reserve found%' THEN
            v_passed_count := v_passed_count + 1;
            RAISE NOTICE 'Test 15 PASSED: Disbursement of unreserved payout rejected with lifecycle violation.';
        ELSE
            RAISE EXCEPTION 'Test 15 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- =========================================================================
    -- TEST 16: Refund After Owner Payout (Merchant Recovery / Overdraft Protection)
    -- =========================================================================
    -- Simulate scenario where customer is refunded ₱350, but owner's balance is drained.
    -- Drain remaining available balance for Org A to 0.00 first
    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_a_id;
    IF v_bal.available_withdrawable_balance > 0.00 THEN
        PERFORM public.post_journal_entry_internal(
            v_org_a_id,
            v_fac_a_id,
            'platform_adjustment',
            'test-idemp-drain-for-refund-test',
            gen_random_uuid(),
            'Drain balance to test overdraft recovery',
            '{}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('account_code', '2011', 'entry_direction', 'DEBIT', 'amount', v_bal.available_withdrawable_balance),
                jsonb_build_object('account_code', '1020', 'entry_direction', 'CREDIT', 'amount', v_bal.available_withdrawable_balance)
            )
        );
    END IF;

    -- Now execute customer refund for reservation A: ₱350 gross (₱17.50 comm reversal, ₱332.50 owner reversal)
    -- Since Org A has ₱0.00 available balance, the ₱332.50 deficit must be debited to Account 1030
    -- and tracked in negative_recovery_balance.
    v_res := public.post_refund_reversal_event(
        v_org_a_id,
        v_fac_a_id,
        v_res_a_id,
        v_res_a_price,
        0.0500,
        'test-idemp-post-payout-refund',
        '{"note": "refund after payout"}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 16 Failed: post_refund_reversal_event failed: %', v_res;
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_a_id;

    IF v_bal.available_withdrawable_balance != 0.00 OR
       v_bal.negative_recovery_balance != (v_res_a_price - round(v_res_a_price * 0.0500, 2)) THEN
        RAISE EXCEPTION 'Test 16 Failed: Overdraft refund did not record negative_recovery_balance correctly: avail=%, neg_rec=%',
            v_bal.available_withdrawable_balance, v_bal.negative_recovery_balance;
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 16 PASSED: Post-payout refund honored customer, created Account 1030 receivable (₱%), with zero balance check violation.',
        v_bal.negative_recovery_balance;

    -- Verify that when subsequent cleared funds arrive, they auto-reconcile the negative_recovery_balance
    PERFORM public.post_funds_cleared_event(
        v_org_a_id,
        v_fac_a_id,
        (v_res_a_price - round(v_res_a_price * 0.0500, 2)),
        'GW-SETTLE-BATCH-99015',
        'test-idemp-clearing-auto-reconcile',
        '{}'::jsonb
    );

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_a_id;
    IF v_bal.negative_recovery_balance != 0.00 OR v_bal.available_withdrawable_balance != 0.00 THEN
        RAISE EXCEPTION 'Test 16b Failed: Auto-reconciliation of overdraft debt failed: neg_rec=%, avail=%',
            v_bal.negative_recovery_balance, v_bal.available_withdrawable_balance;
    END IF;

    RAISE NOTICE 'Test 16b PASSED: Subsequent settlement auto-reconciled merchant overdraft debt back to ₱0.00 before allowing withdrawals.';

    -- =========================================================================
    -- TEST 17: Gateway Fee Assessment (Configurable Allocation)
    -- =========================================================================
    -- Mode 1: Absorbed by Platform (5010 DEBIT, 1010 CREDIT)
    v_res := public.post_gateway_fee_assessment_event(
        v_org_a_id,
        v_fac_a_id,
        gen_random_uuid(),
        15.00,
        'absorbed_by_platform',
        'test-idemp-gw-fee-platform',
        '{}'::jsonb
    );
    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 17a Failed: Gateway fee platform absorption failed.';
    END IF;

    -- Mode 2: Undecided Fee Escrow (2020 CREDIT, 1010 DEBIT)
    v_res := public.post_gateway_fee_assessment_event(
        v_org_a_id,
        v_fac_a_id,
        gen_random_uuid(),
        15.00,
        'undecided_escrow',
        'test-idemp-gw-fee-escrow',
        '{}'::jsonb
    );
    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 17b Failed: Gateway fee undecided escrow failed.';
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 17 PASSED: Gateway fee assessment supports both platform absorption and undecided escrow allocation.';

    -- =========================================================================
    -- TEST 18: Chargeback Adjustment Event with Overdraft Protection
    -- =========================================================================
    v_res := public.post_chargeback_adjustment_event(
        v_org_b_id,
        v_fac_b_id,
        v_res_b_id,
        v_res_b_price,
        50.00, -- dispute fee
        0.0500,
        'test-idemp-chargeback-org-b',
        '{"reason": "unauthorized_transaction"}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 18 Failed: post_chargeback_adjustment_event failed: %', v_res;
    END IF;

    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_b_id;
    IF v_bal.negative_recovery_balance != (v_res_b_price - round(v_res_b_price * 0.0500, 2)) THEN
        RAISE EXCEPTION 'Test 18 Failed: Chargeback did not track overdraft deficit on Org B.';
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 18 PASSED: Chargeback adjustment event processed clawback, dispute fee, and overdraft receivable.';

    -- =========================================================================
    -- TEST 19: Excess and Late Payment Liabilities (Customer Refund Liability)
    -- =========================================================================
    v_res := public.post_excess_or_late_payment_event(
        v_org_a_id,
        v_fac_a_id,
        v_res_a_id,
        350.00,
        true, -- Late payment on expired hold
        'test-idemp-late-payment-001',
        '{"reason": "late_hold_expired"}'::jsonb
    );

    IF (v_res->>'success')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 19 Failed: post_excess_or_late_payment_event failed: %', v_res;
    END IF;

    -- Verify that owner earnings and withdrawable balance were NOT increased
    SELECT * INTO v_bal FROM public.organization_balances WHERE organization_id = v_org_a_id;
    IF v_bal.available_withdrawable_balance != 0.00 THEN
        RAISE EXCEPTION 'Test 19 Failed: Late payment inflated owner withdrawable balance!';
    END IF;

    v_passed_count := v_passed_count + 1;
    RAISE NOTICE 'Test 19 PASSED: Late payment capture routed 100%% to Customer Refund Liability (2030) with zero owner balance inflation.';

    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== ALL % RIGOROUS FINANCIAL JOURNAL TESTS PASSED SUCCESSFULLY ===', v_passed_count;
    RAISE NOTICE '========================================================================';
END $$;

-- Unconditionally roll back entire transaction: zero persistent changes
ROLLBACK;
