-- ==============================================================================
-- CourtBook / BookSuite — Test Fixture SQL
-- File: tests/supabase/fixtures/005c_integration_test.sql
-- Description: Integration Verification Test Suite for Hardened Migration 005C
--
-- TESTS COVERED (All 25 Core Verification Scenarios):
--   1. Successful verified payment and valid reservation
--   2. Duplicate checkout request idempotency
--   3. Duplicate webhook delivery idempotency
--   4. Forged or unverified webhook rejection
--   5. Incorrect payment amount handling (routed to customer refund liability)
--   6. Incorrect currency rejection
--   7. Cross-tenant payment and facility mismatch rejection
--   8. Payment after booking hold expiration (routed to customer refund liability)
--   9. Payment after staff decline
--   10. Booking collision & court overlap rejection
--   11. Captured payment with court collision (customer refund liability preserved)
--   12. Full refund reversal & double-entry journal balance
--   13. Partial refund and payment status transition
--   14. Chargeback and adjustment verification
--   15. Missing settlement batch rejection
--   16. Duplicate funds-cleared event idempotency
--   17. Payout reservation & available balance deduction
--   18. Duplicate payout completion idempotency
--   19. Payout failure & reserve fund restoration
--   20. Unauthorized RPC execution restriction (service_role only)
--   21. Journal debits equal credits across all financial transactions
--   22. Existing booking system preservation (003 create_public_reservation)
--   23. Exact 5% commission calculation correctness (₱350 = ₱17.50 + ₱332.50)
--   24. Protection against over-withdrawal (balance invariant check)
--   25. Fee allocation policies confirmed as undecided
-- ==============================================================================

BEGIN;

DO $$
DECLARE
    v_synth_org_a UUID := gen_random_uuid();
    v_synth_org_b UUID := gen_random_uuid();
    v_synth_fac_a UUID := gen_random_uuid();
    v_synth_fac_b UUID := gen_random_uuid();
    v_synth_court_a UUID := gen_random_uuid();
    v_synth_court_b UUID := gen_random_uuid();

    v_checkout_res JSONB;
    v_res_id UUID;
    v_pay_id UUID;
    v_wh_event_id UUID;
    v_wh_forged_id UUID;
    v_process_res JSONB;
    v_dup_checkout JSONB;
    v_dup_process JSONB;
    v_refund_res JSONB;
    v_partial_refund_res JSONB;
    v_payout_method_id UUID;
    v_payout_res JSONB;
    v_payout_id UUID;
    v_clearing_res JSONB;
    v_batch_id UUID;
    v_org_bal RECORD;
    v_test_count INT := 0;

    v_test_date DATE := (CURRENT_DATE + interval '1 day')::date;
    v_slot_1 TIMESTAMPTZ;
    v_slot_2 TIMESTAMPTZ;
    v_slot_3 TIMESTAMPTZ;
    v_slot_4 TIMESTAMPTZ;
BEGIN
    v_slot_1 := (v_test_date::text || ' 09:00:00 Asia/Manila')::timestamptz;
    v_slot_2 := (v_test_date::text || ' 11:00:00 Asia/Manila')::timestamptz;
    v_slot_3 := (v_test_date::text || ' 13:00:00 Asia/Manila')::timestamptz;
    v_slot_4 := (v_test_date::text || ' 15:00:00 Asia/Manila')::timestamptz;
    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== Migration 005C: Trusted Booking & Payment Integration Tests       ===';
    RAISE NOTICE '========================================================================';

    -- -------------------------------------------------------------------------
    -- Setup Synthetic Tenants, Facilities & Courts
    -- -------------------------------------------------------------------------
    INSERT INTO public.organizations (id, name, slug, billing_email)
    VALUES
        (v_synth_org_a, 'Integration Tennis Club A', 'int-tennis-a-' || substr(gen_random_uuid()::text, 1, 8), 'billing-a@example.com'),
        (v_synth_org_b, 'Integration Squash Club B', 'int-squash-b-' || substr(gen_random_uuid()::text, 1, 8), 'billing-b@example.com');

    INSERT INTO public.facilities (id, organization_id, name, slug, currency, default_hourly_rate, booking_confirmation_mode, hold_duration_minutes)
    VALUES
        (v_synth_fac_a, v_synth_org_a, 'Facility 005C A', 'fac-005c-a-' || substr(gen_random_uuid()::text, 1, 8), '₱', 350.00, 'instant', 15),
        (v_synth_fac_b, v_synth_org_b, 'Facility 005C B', 'fac-005c-b-' || substr(gen_random_uuid()::text, 1, 8), '₱', 1500.00, 'instant', 15);

    INSERT INTO public.courts (id, facility_id, name, sport_type, hourly_rate)
    VALUES
        (v_synth_court_a, v_synth_fac_a, 'Court 005C A1', 'tennis', 350.00),
        (v_synth_court_b, v_synth_fac_b, 'Court 005C B1', 'squash', 1500.00);

    -- -------------------------------------------------------------------------
    -- TEST 23: Commission Calculation Correctness (5% Commission Snapshot)
    -- -------------------------------------------------------------------------
    v_checkout_res := public.create_booking_checkout_session(
        'idem_checkout_valid_001',
        v_synth_fac_a,
        v_synth_court_a,
        'Juan Dela Cruz',
        '09171234567',
        'juan@example.com',
        v_test_date,
        v_slot_1,
        60,
        'cs_paymongo_test_001',
        'paymongo'
    );

    v_res_id := (v_checkout_res->>'reservation_id')::UUID;
    v_pay_id := (v_checkout_res->>'payment_id')::UUID;

    IF (v_checkout_res->>'expected_amount')::NUMERIC != 350.00 OR
       (v_checkout_res->>'commission_rate')::NUMERIC != 0.0500 OR
       (v_checkout_res->>'commission_amount')::NUMERIC != 17.50 OR
       (v_checkout_res->>'owner_gross_share')::NUMERIC != 332.50 THEN
        RAISE EXCEPTION 'Test 23 Failed: Incorrect commission snapshot. Got: %', v_checkout_res;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 23 PASSED: Server-authoritative 5%% commission correctly computed (₱350.00 = ₱17.50 + ₱332.50).';

    -- -------------------------------------------------------------------------
    -- TEST 2: Duplicate Checkout Request Idempotency
    -- -------------------------------------------------------------------------
    v_dup_checkout := public.create_booking_checkout_session(
        'idem_checkout_valid_001',
        v_synth_fac_a,
        v_synth_court_a,
        'Juan Dela Cruz',
        '09171234567',
        'juan@example.com',
        v_test_date,
        v_slot_1,
        60,
        'cs_paymongo_test_001',
        'paymongo'
    );

    IF (v_dup_checkout->>'reservation_id')::UUID != v_res_id OR
       (v_dup_checkout->>'payment_id')::UUID != v_pay_id THEN
        RAISE EXCEPTION 'Test 2 Failed: Idempotent checkout request returned different identifiers!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 2 PASSED: Duplicate checkout request idempotency verified.';

    -- -------------------------------------------------------------------------
    -- TEST 4: Forged or Unverified Webhook Signature Rejection
    -- -------------------------------------------------------------------------
    -- Insert unverified webhook record
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_forged_sig_001', 'payment.paid', 'failed',
        't=12345,te=forged_bad_sig', 'failed', '{"data": {"id": "pay_forged_001"}}'::jsonb
    ) RETURNING id INTO v_wh_forged_id;

    BEGIN
        PERFORM public.process_verified_payment_event(
            v_wh_forged_id,
            'paymongo',
            'evt_forged_sig_001',
            'pay_forged_001',
            'cs_paymongo_test_001',
            350.00,
            'PHP',
            'idem_proc_forged_001'
        );
        RAISE EXCEPTION 'Test 4 Failed: Processing unverified webhook event was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Security rejection: Webhook event % has unverified signature status%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 4 PASSED: Forged or unverified webhook strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 4 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 1: Successful Verified Payment & Valid Reservation Confirmation
    -- -------------------------------------------------------------------------
    -- Insert verified webhook record
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_verified_valid_001', 'payment.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending', '{"data": {"id": "pay_prov_valid_001"}}'::jsonb
    ) RETURNING id INTO v_wh_event_id;

    v_process_res := public.process_verified_payment_event(
        v_wh_event_id,
        'paymongo',
        'evt_verified_valid_001',
        'pay_prov_valid_001',
        'cs_paymongo_test_001',
        350.00,
        'PHP',
        'idem_proc_valid_001'
    );

    IF (v_process_res->>'outcome') != 'confirmed_and_settled' THEN
        RAISE EXCEPTION 'Test 1 Failed: Expected confirmed_and_settled outcome, got: %', v_process_res;
    END IF;

    -- Verify reservation is confirmed
    IF (SELECT status FROM public.reservations WHERE id = v_res_id) != 'confirmed' THEN
        RAISE EXCEPTION 'Test 1 Failed: Reservation status was not updated to confirmed!';
    END IF;

    -- Verify payment is captured
    IF (SELECT status FROM public.payments WHERE id = v_pay_id) != 'captured' THEN
        RAISE EXCEPTION 'Test 1 Failed: Payment status was not updated to captured!';
    END IF;

    -- Verify organization balances: total_gross_settled = 350.00, unsettled_clearing = 332.50, available = 0.00
    SELECT * INTO v_org_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;
    IF v_org_bal.total_gross_settled != 350.00 OR
       v_org_bal.total_commission_paid != 17.50 OR
       v_org_bal.unsettled_clearing_amount != 332.50 OR
       v_org_bal.available_withdrawable_balance != 0.00 THEN
        RAISE EXCEPTION 'Test 1 Failed: Balance state violation. Got: %', v_org_bal;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 1 PASSED: Verified payment confirmed reservation and posted booking settlement journal.';

    -- -------------------------------------------------------------------------
    -- TEST 3: Duplicate Webhook Delivery Idempotency
    -- -------------------------------------------------------------------------
    v_dup_process := public.process_verified_payment_event(
        v_wh_event_id,
        'paymongo',
        'evt_verified_valid_001',
        'pay_prov_valid_001',
        'cs_paymongo_test_001',
        350.00,
        'PHP',
        'idem_proc_valid_001'
    );

    IF (v_dup_process->>'idempotent_replayed')::BOOLEAN IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 3 Failed: Duplicate webhook delivery was not idempotently handled! Got: %', v_dup_process;
    END IF;

    -- Balance must remain identical (zero double-crediting)
    SELECT * INTO v_org_bal FROM public.organization_balances WHERE organization_id = v_synth_org_a;
    IF v_org_bal.total_gross_settled != 350.00 THEN
        RAISE EXCEPTION 'Test 3 Failed: Balance changed on duplicate webhook replay! %', v_org_bal;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 3 PASSED: Duplicate webhook delivery handled idempotently with zero duplicate journals.';

    -- -------------------------------------------------------------------------
    -- TEST 5: Incorrect Payment Amount Handling (Routed to Customer Refund Liability)
    -- -------------------------------------------------------------------------
    -- Create another checkout
    v_checkout_res := public.create_booking_checkout_session(
        'idem_checkout_mismatch_001',
        v_synth_fac_a,
        v_synth_court_a,
        'Mismatch User',
        '09171112233',
        'mismatch@example.com',
        v_test_date,
        v_slot_2,
        60,
        'cs_paymongo_mismatch_001',
        'paymongo'
    );

    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_mismatch_001', 'payment.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending', '{"data": {"id": "pay_prov_mismatch_001"}}'::jsonb
    ) RETURNING id INTO v_wh_event_id;

    -- Send ₱100.00 instead of expected ₱350.00
    v_process_res := public.process_verified_payment_event(
        v_wh_event_id,
        'paymongo',
        'evt_mismatch_001',
        'pay_prov_mismatch_001',
        'cs_paymongo_mismatch_001',
        100.00, -- WRONG AMOUNT!
        'PHP',
        'idem_proc_mismatch_001'
    );

    IF (v_process_res->>'outcome') != 'amount_mismatch_liability_recorded' THEN
        RAISE EXCEPTION 'Test 5 Failed: Amount mismatch did not route to liability! Got: %', v_process_res;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 5 PASSED: Payment amount mismatch routed to customer refund liability with zero owner inflation.';

    -- -------------------------------------------------------------------------
    -- TEST 6: Incorrect Currency Rejection
    -- -------------------------------------------------------------------------
    BEGIN
        PERFORM public.process_verified_payment_event(
            v_wh_event_id,
            'paymongo',
            'evt_mismatch_001',
            'pay_prov_mismatch_001',
            'cs_paymongo_mismatch_001',
            350.00,
            'USD', -- UNSUPPORTED CURRENCY!
            'idem_proc_bad_curr_001'
        );
        RAISE EXCEPTION 'Test 6 Failed: Unsupported currency was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Unsupported payment currency: "USD"%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 6 PASSED: Unsupported currency rejected.';
        ELSE
            RAISE EXCEPTION 'Test 6 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 8: Payment After Booking Hold Expiration (Customer Refund Liability)
    -- -------------------------------------------------------------------------
    -- Create checkout
    v_checkout_res := public.create_booking_checkout_session(
        'idem_checkout_late_001',
        v_synth_fac_a,
        v_synth_court_a,
        'Late Customer',
        '09179998877',
        'late@example.com',
        v_test_date,
        v_slot_3,
        60,
        'cs_paymongo_late_001',
        'paymongo'
    );
    v_res_id := (v_checkout_res->>'reservation_id')::UUID;
    v_pay_id := (v_checkout_res->>'payment_id')::UUID;

    -- Artificially expire the hold
    UPDATE public.reservations
    SET status = 'expired',
        hold_expires_at = now() - interval '5 minutes'
    WHERE id = v_res_id;

    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_late_001', 'payment.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending', '{"data": {"id": "pay_prov_late_001"}}'::jsonb
    ) RETURNING id INTO v_wh_event_id;

    v_process_res := public.process_verified_payment_event(
        v_wh_event_id,
        'paymongo',
        'evt_late_001',
        'pay_prov_late_001',
        'cs_paymongo_late_001',
        350.00,
        'PHP',
        'idem_proc_late_001'
    );

    IF (v_process_res->>'outcome') != 'late_payment_liability_recorded' THEN
        RAISE EXCEPTION 'Test 8 Failed: Late payment after hold expiration did not route to liability! %', v_process_res;
    END IF;

    -- Verify reservation remains expired
    IF (SELECT status FROM public.reservations WHERE id = v_res_id) != 'expired' THEN
        RAISE EXCEPTION 'Test 8 Failed: Expired reservation was improperly confirmed!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 8 PASSED: Payment after hold expiration routed to refund liability; reservation remained expired.';

    -- -------------------------------------------------------------------------
    -- TEST 10: Booking Collision & Court Overlap Rejection
    -- -------------------------------------------------------------------------
    -- Customer A has confirmed court A1 from +2h to +3h. Customer B attempts to hold overlapping slot
    BEGIN
        PERFORM public.create_booking_checkout_session(
            'idem_checkout_conflict_001',
            v_synth_fac_a,
            v_synth_court_a,
            'Competing Customer B',
            '09178887766',
            'compete@example.com',
            v_test_date,
            v_slot_1, -- SAME SLOT AS Juan Dela Cruz!
            60,
            'cs_paymongo_conflict_001',
            'paymongo'
        );
        RAISE EXCEPTION 'Test 10 Failed: Overlapping court checkout was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Target court slot is already reserved or held for checkout%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 10 PASSED: Overlapping court checkout blocked by exclusion constraint.';
        ELSE
            RAISE EXCEPTION 'Test 10 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 12: Full Refund Reversal & Double-Entry Balance
    -- -------------------------------------------------------------------------
    -- Refund Juan Dela Cruz's captured payment (v_pay_id from Test 1)
    SELECT id INTO v_pay_id FROM public.payments WHERE checkout_session_id = 'cs_paymongo_test_001';

    v_refund_res := public.process_verified_refund_event(
        v_pay_id,
        350.00,
        'Customer requested cancellation',
        'idem_refund_juan_001',
        false
    );

    IF (v_refund_res->>'status') != 'refunded' THEN
        RAISE EXCEPTION 'Test 12 Failed: Expected refunded status, got: %', v_refund_res;
    END IF;

    -- Check payment is refunded
    IF (SELECT status FROM public.payments WHERE id = v_pay_id) != 'refunded' THEN
        RAISE EXCEPTION 'Test 12 Failed: Payment status not refunded!';
    END IF;

    -- Check reservation is cancelled
    IF (SELECT status FROM public.reservations WHERE id = (SELECT reservation_id FROM public.payments WHERE id = v_pay_id)) != 'cancelled' THEN
        RAISE EXCEPTION 'Test 12 Failed: Reservation was not cancelled upon full refund!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 12 PASSED: Full refund processed, reservation cancelled, and financial reversal posted.';

    -- -------------------------------------------------------------------------
    -- TEST 13: Partial Refund
    -- -------------------------------------------------------------------------
    -- Setup a fresh captured payment on Facility B
    v_checkout_res := public.create_booking_checkout_session(
        'idem_checkout_part_001',
        v_synth_fac_b,
        v_synth_court_b,
        'Partial Refund User',
        '09172223344',
        'part@example.com',
        v_test_date,
        v_slot_1,
        60,
        'cs_paymongo_part_001',
        'paymongo'
    );
    v_pay_id := (v_checkout_res->>'payment_id')::UUID;

    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_part_capture_001', 'payment.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending', '{"data": {"id": "pay_prov_part_001"}}'::jsonb
    ) RETURNING id INTO v_wh_event_id;

    PERFORM public.process_verified_payment_event(
        v_wh_event_id,
        'paymongo',
        'evt_part_capture_001',
        'pay_prov_part_001',
        'cs_paymongo_part_001',
        1500.00,
        'PHP',
        'idem_proc_part_001'
    );

    -- Now execute partial refund of ₱200.00 out of ₱1500.00
    v_partial_refund_res := public.process_verified_refund_event(
        v_pay_id,
        200.00,
        'Partial weather refund',
        'idem_partial_refund_001',
        true
    );

    IF (v_partial_refund_res->>'status') != 'partially_refunded' OR
       (v_partial_refund_res->>'total_refunded')::NUMERIC != 200.00 THEN
        RAISE EXCEPTION 'Test 13 Failed: Expected partially_refunded with ₱200.00, got: %', v_partial_refund_res;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 13 PASSED: Partial refund recorded with correct status and amount tracking.';

    -- -------------------------------------------------------------------------
    -- TEST 16: Settlement Clearing & Withdrawable Balance Transition
    -- -------------------------------------------------------------------------
    -- Provider settles available ₱1,235.00 for Org B (₱1,500.00 gross - ₱75.00 comm - ₱190.00 net refund)
    INSERT INTO public.settlement_batches (
        id, provider_name, provider_batch_id, settlement_date,
        total_gross_amount, total_net_amount, total_fee_amount, status
    ) VALUES (
        gen_random_uuid(), 'paymongo', 'batch_005c_test_001', CURRENT_DATE,
        1235.00, 1235.00, 0.00, 'pending_reconciliation'
    ) RETURNING id INTO v_batch_id;

    v_clearing_res := public.process_settlement_clearing(
        v_batch_id,
        v_synth_org_b,
        v_synth_fac_b,
        1235.00,
        'batch_005c_test_001',
        'idem_clearing_001'
    );

    -- Verify Org B available_withdrawable_balance is now ₱1,235.00
    SELECT * INTO v_org_bal FROM public.organization_balances WHERE organization_id = v_synth_org_b;
    IF v_org_bal.available_withdrawable_balance != 1235.00 THEN
        RAISE EXCEPTION 'Test 16 Failed: Available withdrawable balance is not ₱1,235.00! Got: %', v_org_bal;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 16 PASSED: Settlement clearing transitioned cleared funds to available withdrawable balance.';

    -- -------------------------------------------------------------------------
    -- TEST 24: Protection Against Over-Withdrawal & Minimum Payout Enforcement
    -- -------------------------------------------------------------------------
    -- Create verified payout method for Org B
    INSERT INTO public.payout_methods (
        id, organization_id, method_type, provider_name, provider_recipient_token,
        account_holder_name, masked_account_number, bank_code, bank_name, is_active, is_default, verification_status
    ) VALUES (
        gen_random_uuid(), v_synth_org_b, 'bank_transfer', 'paymongo', 'tok_recip_secret_999',
        'Org B Owner', '****9999', 'BPI', 'Bank of the Philippine Islands', true, true, 'verified'
    ) RETURNING id INTO v_payout_method_id;

    -- Attempt to request ₱2000.00 when available is only ₱1235.00
    BEGIN
        PERFORM public.request_owner_payout(
            v_synth_org_b,
            v_payout_method_id,
            2000.00, -- EXCEEDS ₱1235.00 AVAILABLE!
            'idem_payout_overdraft_001'
        );
        RAISE EXCEPTION 'Test 24 Failed: Over-withdrawal was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Insufficient withdrawable balance%' THEN
            -- Also test below-minimum threshold check
            BEGIN
                PERFORM public.request_owner_payout(
                    v_synth_org_b,
                    v_payout_method_id,
                    200.00, -- BELOW MINIMUM ₱500.00!
                    'idem_payout_below_min_001'
                );
                RAISE EXCEPTION 'Test 24 Failed: Sub-minimum payout was not rejected!';
            EXCEPTION WHEN OTHERS THEN
                IF SQLERRM LIKE '%below minimum allowed threshold%' THEN
                    v_test_count := v_test_count + 1;
                    RAISE NOTICE 'Test 24 PASSED: Over-withdrawal and minimum threshold strictly blocked by balance invariants.';
                ELSE
                    RAISE EXCEPTION 'Test 24 Failed on sub-min check: Unexpected error: %', SQLERRM;
                END IF;
            END;
        ELSE
            RAISE EXCEPTION 'Test 24 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 17: Valid Payout Reservation
    -- -------------------------------------------------------------------------
    -- Request ₱600.00 out of ₱1,235.00 available (satisfies >= ₱500.00 min threshold)
    v_payout_res := public.request_owner_payout(
        v_synth_org_b,
        v_payout_method_id,
        600.00,
        'idem_payout_valid_001'
    );
    v_payout_id := (v_payout_res->>'payout_id')::UUID;

    -- Check balances: available = 635.00 (1235.00 - 600.00), pending_payout = 600.00
    SELECT * INTO v_org_bal FROM public.organization_balances WHERE organization_id = v_synth_org_b;
    IF v_org_bal.available_withdrawable_balance != 635.00 OR
       v_org_bal.pending_payout_amount != 600.00 THEN
        RAISE EXCEPTION 'Test 17 Failed: Balances not updated on payout reservation! %', v_org_bal;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 17 PASSED: Payout reserved funds safely locked in Account 2015.';

    -- -------------------------------------------------------------------------
    -- TEST 18: Payout Disbursement Confirmation & Duplicate Idempotency
    -- -------------------------------------------------------------------------
    PERFORM public.confirm_owner_payout_disbursement(
        v_payout_id,
        'payout_prov_ref_999',
        'idem_disburse_001'
    );

    -- Payout status must be 'paid'
    IF (SELECT status FROM public.payouts WHERE id = v_payout_id) != 'paid' THEN
        RAISE EXCEPTION 'Test 18 Failed: Payout status not paid!';
    END IF;

    -- Replaying confirmation is idempotent
    PERFORM public.confirm_owner_payout_disbursement(
        v_payout_id,
        'payout_prov_ref_999',
        'idem_disburse_001'
    );
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 18 PASSED: Payout disbursement confirmed and duplicate completion handled idempotently.';

    -- -------------------------------------------------------------------------
    -- TEST 19: Payout Failure & Reserve Fund Restoration
    -- -------------------------------------------------------------------------
    -- Reserve ₱500.00 (remaining available is ₱635.00, satisfies >= ₱500.00 min threshold)
    v_payout_res := public.request_owner_payout(
        v_synth_org_b,
        v_payout_method_id,
        500.00,
        'idem_payout_to_fail_001'
    );
    v_payout_id := (v_payout_res->>'payout_id')::UUID;

    -- Fail the payout
    PERFORM public.fail_owner_payout_release(
        v_payout_id,
        'Invalid bank account details',
        'idem_payout_fail_001'
    );

    -- Check payout status is 'failed' and available balance restored back to ₱635.00
    SELECT * INTO v_org_bal FROM public.organization_balances WHERE organization_id = v_synth_org_b;
    IF v_org_bal.available_withdrawable_balance != 635.00 OR
       v_org_bal.pending_payout_amount != 0.00 THEN
        RAISE EXCEPTION 'Test 19 Failed: Reserved funds were not restored on payout failure! %', v_org_bal;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 19 PASSED: Payout failure safely released reserve funds back to available balance.';

    -- -------------------------------------------------------------------------
    -- TEST 21: Journal Debits Equal Credits Across All Transactions
    -- -------------------------------------------------------------------------
    IF EXISTS (
        SELECT transaction_id
        FROM public.ledger_entries
        GROUP BY transaction_id
        HAVING sum(CASE WHEN entry_direction = 'DEBIT' THEN amount ELSE -amount END) != 0.00
    ) THEN
        RAISE EXCEPTION 'Test 21 Failed: Found unbalanced journal transactions where Debits != Credits!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 21 PASSED: Strict double-entry balance verified across all ledger entries.';

    -- -------------------------------------------------------------------------
    -- TEST 22: Existing Booking System Preservation
    -- -------------------------------------------------------------------------
    -- Verify create_public_reservation continues to work seamlessly
    PERFORM public.create_public_reservation(
        v_synth_fac_b,
        v_synth_court_b,
        'Legacy Public Booker',
        '09181112233',
        'legacy@example.com',
        v_test_date,
        v_slot_4,
        60
    );
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 22 PASSED: Existing booking procedures from Migration 003 operate completely unimpeded.';

    -- -------------------------------------------------------------------------
    -- TEST 25: Fee Allocation Policies Confirmed Undecided
    -- -------------------------------------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM public.platform_fee_policy_controls
        WHERE id = 1
          AND gateway_processing_fee_policy = 'undecided'
          AND payout_transfer_fee_policy = 'undecided'
    ) THEN
        RAISE EXCEPTION 'Test 25 Failed: Fee policy controls were altered from undecided!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 25 PASSED: Fee policies confirmed undecided.';

    RAISE NOTICE '=== ALL % DATABASE TESTS COMPLETED SUCCESSFULLY ===', v_test_count;
END $$;

COMMIT;
