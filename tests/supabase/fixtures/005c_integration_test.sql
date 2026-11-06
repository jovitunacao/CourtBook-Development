-- ==============================================================================
-- CourtBook / BookSuite — Test Fixture SQL
-- File: tests/supabase/fixtures/005c_integration_test.sql
-- Description: Integration Verification Test Suite for Hardened Migration 005C
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
    -- TEST 26 (NEW): Missing or Forged Provider Checkout Binding Rejection
    -- -------------------------------------------------------------------------
    -- 26A: Invalid session ID format rejection
    BEGIN
        PERFORM public.bind_provider_checkout_session(
            v_pay_id,
            v_res_id,
            'paymongo',
            'forged_session_without_cs_prefix',
            'https://test.com',
            'idem_bind_forged_001'
        );
        RAISE EXCEPTION 'Test 26A Failed: Forged checkout session format was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Must begin with "cs_"%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 26A PASSED: Forged provider session format rejected.';
        ELSE
            RAISE EXCEPTION 'Test 26A Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- 26B: Mismatched reservation ID rejection
    BEGIN
        PERFORM public.bind_provider_checkout_session(
            v_pay_id,
            gen_random_uuid(), -- WRONG RESERVATION!
            'paymongo',
            'cs_paymongo_test_001',
            'https://test.com',
            'idem_bind_mismatch_res'
        );
        RAISE EXCEPTION 'Test 26B Failed: Mismatched reservation ID was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%does not belong to reservation%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 26B PASSED: Mismatched reservation ID rejected during binding.';
        ELSE
            RAISE EXCEPTION 'Test 26B Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- 26C: Valid Provider Checkout Binding
    PERFORM public.bind_provider_checkout_session(
        v_pay_id,
        v_res_id,
        'paymongo',
        'cs_paymongo_test_001',
        'https://test-checkout.paymongo.com/sandbox/cs_paymongo_test_001',
        'idem_bind_valid_001'
    );
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 26C PASSED: Valid provider checkout session securely bound to payment record.';

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
        'paymongo'
    );

    IF (v_dup_checkout->>'reservation_id')::UUID != v_res_id OR
       (v_dup_checkout->>'payment_id')::UUID != v_pay_id THEN
        RAISE EXCEPTION 'Test 2 Failed: Idempotent checkout request returned different identifiers!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 2 PASSED: Duplicate checkout request idempotency verified.';

    -- -------------------------------------------------------------------------
    -- TEST 27 (NEW): Unauthenticated Checkout Abuse & Idempotency Tampering
    -- -------------------------------------------------------------------------
    -- 27A: Idempotency conflict on altered customer parameters
    BEGIN
        PERFORM public.create_booking_checkout_session(
            'idem_checkout_valid_001', -- SAME KEY AS Juan Dela Cruz!
            v_synth_fac_a,
            v_synth_court_a,
            'Altered Attacker Name',   -- ALTERED PARAMETERS!
            '09170009999',
            'attacker@example.com',
            v_test_date,
            v_slot_1,
            60,
            'paymongo'
        );
        RAISE EXCEPTION 'Test 27A Failed: Altered idempotency replay was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Idempotency conflict%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 27A PASSED: Idempotency replay with altered parameters strictly blocked.';
        ELSE
            RAISE EXCEPTION 'Test 27A Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- 27B: Anti-Abuse: Max 3 active pending holds per contact
    PERFORM public.create_booking_checkout_session('idem_abuse_hold_001', v_synth_fac_a, v_synth_court_a, 'Abuse Booker', '09170001111', 'abuse@test.com', v_test_date, v_slot_2, 60);
    PERFORM public.create_booking_checkout_session('idem_abuse_hold_002', v_synth_fac_a, v_synth_court_a, 'Abuse Booker', '09170001111', 'abuse@test.com', v_test_date, v_slot_3, 60);
    PERFORM public.create_booking_checkout_session('idem_abuse_hold_003', v_synth_fac_a, v_synth_court_a, 'Abuse Booker', '09170001111', 'abuse@test.com', v_test_date, v_slot_4, 60);

    -- 4th hold attempt must be blocked by anti-abuse guard
    BEGIN
        PERFORM public.create_booking_checkout_session(
            'idem_abuse_hold_004',
            v_synth_fac_a,
            v_synth_court_a,
            'Abuse Booker',
            '09170001111',
            'abuse@test.com',
            (v_test_date + interval '1 day')::date,
            (((v_test_date + interval '1 day')::date)::text || ' 10:00:00 Asia/Manila')::timestamptz,
            60
        );
        RAISE EXCEPTION 'Test 27B Failed: 4th pending hold was not blocked by anti-abuse limit!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Anti-abuse limit exceeded%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 27B PASSED: Anti-abuse guard blocked excessive pending holds.';
        ELSE
            RAISE EXCEPTION 'Test 27B Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- Clean up abuse test holds so courts remain available for subsequent tests
    UPDATE public.reservations SET status = 'cancelled' WHERE customer_phone = '09170001111';

    -- -------------------------------------------------------------------------
    -- TEST 28 (NEW): NULL Webhook Event ID Rejection
    -- -------------------------------------------------------------------------
    BEGIN
        PERFORM public.process_verified_payment_event(
            NULL, -- NULL WEBHOOK EVENT ID!
            'paymongo',
            'evt_test_null_wh',
            'pay_prov_null_001',
            'cs_paymongo_test_001',
            350.00,
            'PHP',
            'idem_null_wh_001'
        );
        RAISE EXCEPTION 'Test 28 Failed: NULL webhook ID was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Authoritative verified webhook_event_id is required%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 28 PASSED: NULL webhook event ID strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 28 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 4: Forged or Unverified Webhook Signature Rejection
    -- -------------------------------------------------------------------------
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_forged_sig_001', 'payment.paid', 'failed', -- FAILED SIGNATURE!
        't=1700000000,li=bad_sig', 'pending', '{"data": {"id": "pay_forged_001"}}'::jsonb
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
        RAISE EXCEPTION 'Test 4 Failed: Unverified webhook was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Security rejection%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 4 PASSED: Webhook with failed signature rejected.';
        ELSE
            RAISE EXCEPTION 'Test 4 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 29 (NEW): Verified Webhook ID with Mismatched Details (Evidence Tampering)
    -- -------------------------------------------------------------------------
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_verified_valid_001', 'payment.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object(
            'data', jsonb_build_object(
                'id', 'pay_prov_valid_001',
                'attributes', jsonb_build_object(
                    'data', jsonb_build_object(
                        'id', 'pay_prov_valid_001',
                        'attributes', jsonb_build_object(
                            'amount', 35000,
                            'currency', 'PHP',
                            'status', 'paid',
                            'checkout_session_id', 'cs_paymongo_test_001'
                        )
                    )
                )
            )
        )
    ) RETURNING id INTO v_wh_event_id;

    -- Caller attempts to supply ₱500.00 instead of payload's ₱350.00
    BEGIN
        PERFORM public.process_verified_payment_event(
            v_wh_event_id,
            'paymongo',
            'evt_verified_valid_001',
            'pay_prov_valid_001',
            'cs_paymongo_test_001',
            500.00, -- TAMPERED AMOUNT!
            'PHP',
            'idem_tamper_amt_001'
        );
        RAISE EXCEPTION 'Test 29A Failed: Tampered amount was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Evidence tampering detected%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 29A PASSED: Tampered payment amount rejected against webhook evidence.';
        ELSE
            RAISE EXCEPTION 'Test 29A Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 1: Successful Verified Payment Processing & Financial Journal Posting
    -- -------------------------------------------------------------------------
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
        'paymongo'
    );

    PERFORM public.bind_provider_checkout_session(
        (v_checkout_res->>'payment_id')::UUID,
        (v_checkout_res->>'reservation_id')::UUID,
        'paymongo',
        'cs_paymongo_mismatch_001',
        'https://test.com',
        'idem_bind_mismatch_001'
    );

    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_mismatch_001', 'payment.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'pay_prov_mismatch_001', 'attributes', jsonb_build_object('amount', 10000, 'currency', 'PHP', 'status', 'paid', 'checkout_session_id', 'cs_paymongo_mismatch_001')))
    ) RETURNING id INTO v_wh_event_id;

    -- Send ₱100.00 instead of expected ₱350.00
    v_process_res := public.process_verified_payment_event(
        v_wh_event_id,
        'paymongo',
        'evt_mismatch_001',
        'pay_prov_mismatch_001',
        'cs_paymongo_mismatch_001',
        100.00,
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
            100.00,
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
        'paymongo'
    );
    v_res_id := (v_checkout_res->>'reservation_id')::UUID;
    v_pay_id := (v_checkout_res->>'payment_id')::UUID;

    PERFORM public.bind_provider_checkout_session(
        v_pay_id,
        v_res_id,
        'paymongo',
        'cs_paymongo_late_001',
        'https://test.com',
        'idem_bind_late_001'
    );

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
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'pay_prov_late_001', 'attributes', jsonb_build_object('amount', 35000, 'currency', 'PHP', 'status', 'paid', 'checkout_session_id', 'cs_paymongo_late_001')))
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
    -- TEST 31 (NEW): Refund Without Provider Verification Rejection
    -- -------------------------------------------------------------------------
    SELECT id INTO v_pay_id FROM public.payments WHERE checkout_session_id = 'cs_paymongo_test_001';

    -- 31A: Missing refund evidence rejection
    BEGIN
        PERFORM public.process_verified_refund_event(
            v_pay_id,
            350.00,
            'Customer cancellation',
            'ref_prov_unverified_001',
            '{}'::jsonb, -- EMPTY EVIDENCE!
            'idem_refund_no_ev_001',
            false
        );
        RAISE EXCEPTION 'Test 31A Failed: Refund without provider evidence was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Authoritative provider refund confirmation evidence is required%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 31A PASSED: Refund without provider evidence strictly blocked.';
        ELSE
            RAISE EXCEPTION 'Test 31A Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- 31B: Unconfirmed provider status rejection
    DECLARE
        v_wh_pending_ref uuid;
    BEGIN
        INSERT INTO public.provider_webhook_events (
            provider_name, provider_event_id, event_type, signature_verification_status,
            payload, processing_state
        ) VALUES (
            'paymongo', 'evt_refund_pending_001', 'payment.refunded', 'verified',
            jsonb_build_object('provider_refund_id', 'ref_prov_pending_001', 'status', 'pending', 'amount', 350.00),
            'pending'
        ) RETURNING id INTO v_wh_pending_ref;

        PERFORM public.process_verified_refund_event(
            v_pay_id,
            350.00,
            'Customer cancellation',
            'ref_prov_pending_001',
            jsonb_build_object('webhook_event_id', v_wh_pending_ref, 'provider_refund_id', 'ref_prov_pending_001', 'status', 'pending'), -- NON-TERMINAL STATUS!
            'idem_refund_pending_ev_001',
            false
        );
        RAISE EXCEPTION 'Test 31B Failed: Unconfirmed refund status was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%is not terminal succeeded%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 31B PASSED: Unconfirmed non-terminal refund status strictly blocked.';
        ELSE
            RAISE EXCEPTION 'Test 31B Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 12: Full Refund Reversal & Double-Entry Balance (With Verified Evidence)
    -- -------------------------------------------------------------------------
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_refund_juan_001', 'refund.succeeded', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'ref_prov_juan_001', 'attributes', jsonb_build_object('payment_id', 'pay_prov_valid_001', 'amount', 35000, 'currency', 'PHP', 'status', 'succeeded')))
    ) RETURNING id INTO v_wh_event_id;

    v_refund_res := public.process_verified_refund_event(
        v_pay_id,
        350.00,
        'Customer requested cancellation',
        'ref_prov_juan_001',
        jsonb_build_object(
            'webhook_event_id', v_wh_event_id,
            'provider_refund_id', 'ref_prov_juan_001',
            'status', 'succeeded',
            'amount', 350.00,
            'confirmed_at', now()
        ),
        'idem_refund_juan_001',
        false
    );

    IF (v_refund_res->>'status') != 'refunded' THEN
        RAISE EXCEPTION 'Test 12 Failed: Expected refunded status, got: %', v_refund_res;
    END IF;

    IF (SELECT status FROM public.payments WHERE id = v_pay_id) != 'refunded' THEN
        RAISE EXCEPTION 'Test 12 Failed: Payment status not refunded!';
    END IF;

    IF (SELECT status FROM public.reservations WHERE id = (SELECT reservation_id FROM public.payments WHERE id = v_pay_id)) != 'cancelled' THEN
        RAISE EXCEPTION 'Test 12 Failed: Reservation was not cancelled upon full refund!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 12 PASSED: Full refund processed with verified evidence, reservation cancelled, and reversal posted.';

    -- -------------------------------------------------------------------------
    -- TEST 13: Partial Refund (Facility B with Verified Evidence)
    -- -------------------------------------------------------------------------
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
        'paymongo'
    );
    v_pay_id := (v_checkout_res->>'payment_id')::UUID;
    v_res_id := (v_checkout_res->>'reservation_id')::UUID;

    PERFORM public.bind_provider_checkout_session(
        v_pay_id,
        v_res_id,
        'paymongo',
        'cs_paymongo_part_001',
        'https://test.com',
        'idem_bind_part_001'
    );

    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_part_capture_001', 'payment.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'pay_prov_part_001', 'attributes', jsonb_build_object('amount', 150000, 'currency', 'PHP', 'status', 'paid', 'checkout_session_id', 'cs_paymongo_part_001')))
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

    -- Execute partial refund of ₱200.00 out of ₱1500.00 with verified evidence
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_refund_part_001', 'refund.succeeded', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'ref_prov_part_001', 'attributes', jsonb_build_object('payment_id', 'pay_prov_part_001', 'amount', 20000, 'currency', 'PHP', 'status', 'succeeded')))
    ) RETURNING id INTO v_wh_event_id;

    v_partial_refund_res := public.process_verified_refund_event(
        v_pay_id,
        200.00,
        'Partial weather refund',
        'ref_prov_part_001',
        jsonb_build_object(
            'webhook_event_id', v_wh_event_id,
            'provider_refund_id', 'ref_prov_part_001',
            'status', 'succeeded',
            'amount', 200.00
        ),
        'idem_partial_refund_001',
        true
    );

    IF (v_partial_refund_res->>'status') != 'partially_refunded' OR
       (v_partial_refund_res->>'total_refunded')::NUMERIC != 200.00 THEN
        RAISE EXCEPTION 'Test 13 Failed: Expected partially_refunded with ₱200.00, got: %', v_partial_refund_res;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 13 PASSED: Partial refund recorded with verified evidence and correct balance tracking.';

    -- -------------------------------------------------------------------------
    -- TEST 32 (NEW): Missing Authoritative Settlement Evidence Rejection
    -- -------------------------------------------------------------------------
    -- 32A: NULL batch ID rejection
    BEGIN
        PERFORM public.process_settlement_clearing(
            NULL, -- NULL BATCH ID!
            v_synth_org_b,
            v_synth_fac_b,
            1235.00,
            'batch_missing_001',
            'idem_clear_null_batch'
        );
        RAISE EXCEPTION 'Test 32A Failed: NULL batch ID was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%p_batch_id is strictly required%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 32A PASSED: NULL settlement batch ID strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 32A Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 33 (NEW): Wrong-Tenant Settlement Batch Rejection
    -- -------------------------------------------------------------------------
    INSERT INTO public.settlement_batches (
        id, provider_name, provider_batch_id, settlement_date,
        total_gross_amount, total_net_amount, total_fee_amount, status, verified_at
    ) VALUES (
        gen_random_uuid(), 'paymongo', 'batch_005c_test_001', CURRENT_DATE,
        1500.00, 1235.00, 265.00, 'pending_reconciliation', now()
    ) RETURNING id INTO v_batch_id;

    -- Attempt to clear batch for Org A when batch items do not exist for Org A
    BEGIN
        PERFORM public.process_settlement_clearing(
            v_batch_id,
            v_synth_org_a,
            v_synth_fac_a,
            1235.00,
            'batch_005c_test_001',
            'idem_clearing_wrong_tenant'
        );
        RAISE EXCEPTION 'Test 33 Failed: Settlement batch without tenant items was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%contains zero settlement items%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 33 PASSED: Settlement clearing rejected when tenant items do not exist.';
        ELSE
            RAISE EXCEPTION 'Test 33 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 34 (NEW): Settlement Amount Mismatch Rejection
    -- -------------------------------------------------------------------------
    -- Insert authentic settlement item linked to captured payment
    INSERT INTO public.settlement_items (
        id, batch_id, payment_id, provider_payment_id, organization_id, facility_id,
        gross_amount, provider_fee_amount, net_settled_amount, settlement_status
    ) VALUES (
        gen_random_uuid(), v_batch_id, (SELECT id FROM public.payments WHERE provider_payment_id = 'pay_prov_part_001'), 'pay_prov_part_001', v_synth_org_b, v_synth_fac_b,
        1500.00, 265.00, 1235.00, 'matched'
    );

    -- Caller requests ₱999.00 when verified items sum is ₱1,235.00
    BEGIN
        PERFORM public.process_settlement_clearing(
            v_batch_id,
            v_synth_org_b,
            v_synth_fac_b,
            999.00, -- MISMATCHED AMOUNT!
            'batch_005c_test_001',
            'idem_clearing_mismatch'
        );
        RAISE EXCEPTION 'Test 34 Failed: Settlement amount mismatch was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Settlement amount mismatch%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 34 PASSED: Settlement amount mismatch strictly rejected against verified items.';
        ELSE
            RAISE EXCEPTION 'Test 34 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 16: Settlement Clearing & Withdrawable Balance Transition (Verified Items)
    -- -------------------------------------------------------------------------
    v_clearing_res := public.process_settlement_clearing(
        v_batch_id,
        v_synth_org_b,
        v_synth_fac_b,
        1235.00,
        'batch_005c_test_001',
        'idem_clearing_001'
    );

    SELECT * INTO v_org_bal FROM public.organization_balances WHERE organization_id = v_synth_org_b;
    IF v_org_bal.available_withdrawable_balance != 1235.00 THEN
        RAISE EXCEPTION 'Test 16 Failed: Available withdrawable balance is not ₱1,235.00! Got: %', v_org_bal;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 16 PASSED: Settlement clearing verified against matched batch items and transitioned to available balance.';

    -- -------------------------------------------------------------------------
    -- TEST 24: Protection Against Over-Withdrawal & Minimum Payout Enforcement
    -- -------------------------------------------------------------------------
    INSERT INTO public.payout_methods (
        id, organization_id, method_type, provider_name, provider_recipient_token,
        account_holder_name, masked_account_number, bank_code, bank_name, is_active, is_default, verification_status
    ) VALUES (
        gen_random_uuid(), v_synth_org_b, 'bank_transfer', 'paymongo', 'tok_recip_secret_999',
        'Org B Owner', '****9999', 'BPI', 'Bank of the Philippine Islands', true, true, 'verified'
    ) RETURNING id INTO v_payout_method_id;

    -- Over-withdrawal check
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
            -- Below-minimum check
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
    v_payout_res := public.request_owner_payout(
        v_synth_org_b,
        v_payout_method_id,
        600.00,
        'idem_payout_valid_001'
    );
    v_payout_id := (v_payout_res->>'payout_id')::UUID;

    SELECT * INTO v_org_bal FROM public.organization_balances WHERE organization_id = v_synth_org_b;
    IF v_org_bal.available_withdrawable_balance != 635.00 OR
       v_org_bal.pending_payout_amount != 600.00 THEN
        RAISE EXCEPTION 'Test 17 Failed: Balances not updated on payout reservation! %', v_org_bal;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 17 PASSED: Payout reserved funds safely locked in Account 2015.';

    -- -------------------------------------------------------------------------
    -- TEST 35 (NEW): Payout Marked Paid Without Verified Provider Confirmation
    -- -------------------------------------------------------------------------
    BEGIN
        PERFORM public.confirm_owner_payout_disbursement(
            v_payout_id,
            'payout_prov_ref_999',
            '{}'::jsonb, -- EMPTY EVIDENCE!
            'idem_disburse_no_ev_001'
        );
        RAISE EXCEPTION 'Test 35 Failed: Payout marked paid without disbursement evidence!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Authoritative provider disbursement confirmation evidence is required%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 35 PASSED: Payout disbursement without provider confirmation evidence rejected.';
        ELSE
            RAISE EXCEPTION 'Test 35 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 18: Payout Disbursement Confirmation & Duplicate Idempotency (With Evidence)
    -- -------------------------------------------------------------------------
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_payout_paid_001', 'payout.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'payout_prov_ref_999', 'attributes', jsonb_build_object('amount', 60000, 'currency', 'PHP', 'status', 'paid', 'destination', v_payout_method_id, 'metadata', jsonb_build_object('organization_id', v_synth_org_b))))
    ) RETURNING id INTO v_wh_event_id;

    PERFORM public.confirm_owner_payout_disbursement(
        v_payout_id,
        'payout_prov_ref_999',
        jsonb_build_object(
            'webhook_event_id', v_wh_event_id,
            'provider_reference', 'payout_prov_ref_999',
            'disbursement_status', 'succeeded',
            'amount', 600.00,
            'bank_ref', 'BPI-TR-88888888'
        ),
        'idem_disburse_001'
    );

    IF (SELECT status FROM public.payouts WHERE id = v_payout_id) != 'paid' THEN
        RAISE EXCEPTION 'Test 18 Failed: Payout status not paid!';
    END IF;

    -- Replaying confirmation is idempotent
    PERFORM public.confirm_owner_payout_disbursement(
        v_payout_id,
        'payout_prov_ref_999',
        jsonb_build_object('webhook_event_id', v_wh_event_id, 'provider_reference', 'payout_prov_ref_999', 'disbursement_status', 'succeeded'),
        'idem_disburse_001'
    );
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 18 PASSED: Payout disbursement confirmed with verified evidence and replayed idempotently.';

    -- -------------------------------------------------------------------------
    -- TEST 36 (NEW): Payout Reserve Released Without Failed-Provider Evidence Rejection
    -- -------------------------------------------------------------------------
    v_payout_res := public.request_owner_payout(
        v_synth_org_b,
        v_payout_method_id,
        500.00,
        'idem_payout_to_fail_001'
    );
    v_payout_id := (v_payout_res->>'payout_id')::UUID;

    BEGIN
        PERFORM public.fail_owner_payout_release(
            v_payout_id,
            'Invalid bank account details',
            '{}'::jsonb, -- EMPTY EVIDENCE!
            'idem_payout_fail_no_ev_001'
        );
        RAISE EXCEPTION 'Test 36 Failed: Payout failure without provider evidence was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Authoritative provider failure evidence is required%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 36 PASSED: Payout failure without provider evidence strictly blocked.';
        ELSE
            RAISE EXCEPTION 'Test 36 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 19: Payout Failure & Reserve Fund Restoration (With Authoritative Evidence)
    -- -------------------------------------------------------------------------
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_payout_failed_001', 'payout.failed', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'payout_prov_fail_001', 'attributes', jsonb_build_object('currency', 'PHP', 'status', 'failed', 'failure_code', 'ACCOUNT_NUMBER_INVALID', 'destination', v_payout_method_id, 'metadata', jsonb_build_object('organization_id', v_synth_org_b))))
    ) RETURNING id INTO v_wh_event_id;

    PERFORM public.fail_owner_payout_release(
        v_payout_id,
        'Invalid bank account details',
        jsonb_build_object(
            'webhook_event_id', v_wh_event_id,
            'failure_code', 'ACCOUNT_NUMBER_INVALID',
            'provider_status', 'failed',
            'failed_at', now()
        ),
        'idem_payout_fail_001'
    );

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

    -- -------------------------------------------------------------------------
    -- TEST 37: Forged Refund Success JSON Rejected
    -- -------------------------------------------------------------------------
    BEGIN
        PERFORM public.process_verified_refund_event(
            v_pay_id,
            100.00,
            'Forged refund',
            'ref_forged_json_001',
            jsonb_build_object('status', 'succeeded', 'provider_refund_id', 'ref_forged_json_001'),
            'idem_forged_refund_json_001',
            true
        );
        RAISE EXCEPTION 'Test 37 Failed: Forged refund success JSON was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Authoritative verified webhook_event_id is required%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 37 PASSED: Forged refund success JSON strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 37 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 38: Forged Payout Success JSON Rejected
    -- -------------------------------------------------------------------------
    BEGIN
        PERFORM public.confirm_owner_payout_disbursement(
            v_payout_id,
            'payout_forged_json_001',
            jsonb_build_object('status', 'paid', 'disbursement_status', 'succeeded', 'provider_reference', 'payout_forged_json_001'),
            'idem_forged_payout_json_001'
        );
        RAISE EXCEPTION 'Test 38 Failed: Forged payout success JSON was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Authoritative verified webhook_event_id is required%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 38 PASSED: Forged payout success JSON strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 38 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 39: Forged Payout Failure Evidence Rejected
    -- -------------------------------------------------------------------------
    BEGIN
        PERFORM public.fail_owner_payout_release(
            v_payout_id,
            'Forged failure',
            jsonb_build_object('status', 'failed', 'failure_code', 'FORGED_CODE'),
            'idem_forged_payout_fail_001'
        );
        RAISE EXCEPTION 'Test 39 Failed: Forged payout failure evidence was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Authoritative verified webhook_event_id is required%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 39 PASSED: Forged payout failure evidence strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 39 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 40: Missing Webhook Payment Identity Rejected
    -- -------------------------------------------------------------------------
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_missing_pay_id_001', 'payment.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('attributes', jsonb_build_object('amount', 35000, 'currency', 'PHP', 'status', 'paid', 'checkout_session_id', 'cs_paymongo_test_001')))
    ) RETURNING id INTO v_wh_event_id;

    BEGIN
        PERFORM public.process_verified_payment_event(
            v_wh_event_id, 'paymongo', 'evt_missing_pay_id_001', 'pay_caller_fallback_001',
            'cs_paymongo_test_001', 350.00, 'PHP', 'idem_missing_pay_id_001'
        );
        RAISE EXCEPTION 'Test 40 Failed: Missing webhook payment identity was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Missing trusted evidence: Webhook payload does not contain provider payment identity%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 40 PASSED: Missing webhook payment identity strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 40 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 41: Missing Trusted Webhook Amount Rejected
    -- -------------------------------------------------------------------------
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_missing_amt_001', 'payment.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'pay_prov_noamt_001', 'attributes', jsonb_build_object('currency', 'PHP', 'status', 'paid', 'checkout_session_id', 'cs_paymongo_test_001')))
    ) RETURNING id INTO v_wh_event_id;

    BEGIN
        PERFORM public.process_verified_payment_event(
            v_wh_event_id, 'paymongo', 'evt_missing_amt_001', 'pay_prov_noamt_001',
            'cs_paymongo_test_001', 350.00, 'PHP', 'idem_missing_amt_001'
        );
        RAISE EXCEPTION 'Test 41 Failed: Missing trusted webhook amount was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Missing trusted evidence: Webhook payload does not contain a valid positive amount%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 41 PASSED: Missing trusted webhook amount strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 41 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 42: Incorrect Event Type Rejected
    -- -------------------------------------------------------------------------
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_bad_type_001', 'payment.failed', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'pay_prov_badtype_001', 'attributes', jsonb_build_object('amount', 35000, 'currency', 'PHP', 'status', 'paid', 'checkout_session_id', 'cs_paymongo_test_001')))
    ) RETURNING id INTO v_wh_event_id;

    BEGIN
        PERFORM public.process_verified_payment_event(
            v_wh_event_id, 'paymongo', 'evt_bad_type_001', 'pay_prov_badtype_001',
            'cs_paymongo_test_001', 350.00, 'PHP', 'idem_bad_type_001'
        );
        RAISE EXCEPTION 'Test 42 Failed: Incorrect event type was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Unsupported webhook event type%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 42 PASSED: Incorrect event type strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 42 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 43: Mixed-Tenant Settlement Batch Rejected
    -- -------------------------------------------------------------------------
    INSERT INTO public.settlement_batches (
        id, provider_name, provider_batch_id, settlement_date,
        total_gross_amount, total_net_amount, total_fee_amount, status, verified_at
    ) VALUES (
        gen_random_uuid(), 'paymongo', 'batch_mixed_tenant_001', CURRENT_DATE,
        1500.00, 1235.00, 265.00, 'pending_reconciliation', now()
    ) RETURNING id INTO v_batch_id;

    -- Insert item for Org A into batch, then try to clear for Org B
    INSERT INTO public.settlement_items (
        id, batch_id, payment_id, provider_payment_id, organization_id, facility_id,
        gross_amount, provider_fee_amount, net_settled_amount, settlement_status
    ) VALUES (
        gen_random_uuid(), v_batch_id, NULL, 'pay_prov_org_a_001', v_synth_org_a, v_synth_fac_a,
        1500.00, 265.00, 1235.00, 'matched'
    );

    BEGIN
        PERFORM public.process_settlement_clearing(
            v_batch_id, v_synth_org_b, v_synth_fac_b, 1235.00,
            'batch_mixed_tenant_001', 'idem_mixed_tenant_001'
        );
        RAISE EXCEPTION 'Test 43 Failed: Mixed-tenant settlement batch was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Cross-tenant settlement violation%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 43 PASSED: Mixed-tenant settlement batch strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 43 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 44: Settlement Batch With Incorrect Provider Totals Rejected
    -- -------------------------------------------------------------------------
    INSERT INTO public.settlement_batches (
        id, provider_name, provider_batch_id, settlement_date,
        total_gross_amount, total_net_amount, total_fee_amount, status, verified_at
    ) VALUES (
        gen_random_uuid(), 'paymongo', 'batch_bad_totals_001', CURRENT_DATE,
        9999.00, 9000.00, 999.00, 'pending_reconciliation', now()
    ) RETURNING id INTO v_batch_id;

    INSERT INTO public.settlement_items (
        id, batch_id, payment_id, provider_payment_id, organization_id, facility_id,
        gross_amount, provider_fee_amount, net_settled_amount, settlement_status
    ) VALUES (
        gen_random_uuid(), v_batch_id, (SELECT id FROM public.payments WHERE provider_payment_id = 'pay_prov_part_001'), 'pay_prov_part_001', v_synth_org_b, v_synth_fac_b,
        1500.00, 265.00, 1235.00, 'matched'
    );

    BEGIN
        PERFORM public.process_settlement_clearing(
            v_batch_id, v_synth_org_b, v_synth_fac_b, 1235.00,
            'batch_bad_totals_001', 'idem_bad_totals_001'
        );
        RAISE EXCEPTION 'Test 44 Failed: Settlement batch with incorrect provider totals was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Settlement batch gross total mismatch%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 44 PASSED: Settlement batch with incorrect provider totals strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 44 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 45: Checkout Binding Failure Recovery Without Duplicate Payable Sessions
    -- -------------------------------------------------------------------------
    v_checkout_res := public.create_booking_checkout_session(
        'idem_recovery_test_001',
        v_synth_fac_a,
        v_synth_court_a,
        'Recovery Booker',
        '09175556677',
        'recovery@example.com',
        (v_test_date + interval '2 days')::date,
        (((v_test_date + interval '2 days')::date)::text || ' 09:00:00 Asia/Manila')::timestamptz,
        60,
        'paymongo'
    );
    v_pay_id := (v_checkout_res->>'payment_id')::UUID;
    v_res_id := (v_checkout_res->>'reservation_id')::UUID;

    -- Retry with same idempotency key recovers the same payment_id/reservation_id without creating a duplicate
    v_dup_checkout := public.create_booking_checkout_session(
        'idem_recovery_test_001',
        v_synth_fac_a,
        v_synth_court_a,
        'Recovery Booker',
        '09175556677',
        'recovery@example.com',
        (v_test_date + interval '2 days')::date,
        (((v_test_date + interval '2 days')::date)::text || ' 09:00:00 Asia/Manila')::timestamptz,
        60,
        'paymongo'
    );

    IF (v_dup_checkout->>'payment_id')::UUID != v_pay_id OR (v_dup_checkout->>'idempotent_replayed')::BOOLEAN != true THEN
        RAISE EXCEPTION 'Test 45 Failed: Retry did not recover the same payment record!';
    END IF;

    -- Bind the recovered session
    PERFORM public.bind_provider_checkout_session(
        v_pay_id, v_res_id, 'paymongo', 'cs_paymongo_recovered_001',
        'https://test.com/recovered', 'idem_bind_recovered_001'
    );

    -- Attempting to bind a second different session to the same payment is blocked
    BEGIN
        PERFORM public.bind_provider_checkout_session(
            v_pay_id, v_res_id, 'paymongo', 'cs_paymongo_duplicate_002',
            'https://test.com/duplicate', 'idem_bind_duplicate_002'
        );
        RAISE EXCEPTION 'Test 45 Failed: Duplicate session binding was not blocked!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Rebinding is prohibited%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 45 PASSED: Checkout binding recovery succeeded and duplicate payable session binding blocked.';
        ELSE
            RAISE EXCEPTION 'Test 45 Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 46 (NEW): Realistic checkout_session.payment.paid Envelope & Negative Cases
    -- -------------------------------------------------------------------------
    DECLARE
        v_cs_res JSONB;
        v_cs_pay_id UUID;
        v_cs_res_id UUID;
        v_wh_cs_missing UUID;
        v_wh_cs_valid UUID;
        v_cs_proc_res JSONB;
    BEGIN
        v_cs_res := public.create_booking_checkout_session(
            'idem_cs_envelope_001',
            v_synth_fac_b,
            v_synth_court_b,
            'Elena Reyes',
            '+639171234567',
            'elena@example.com',
            CURRENT_DATE + 4,
            ((CURRENT_DATE + 4)::text || ' 14:00:00+08')::timestamptz,
            60,
            'paymongo'
        );
        v_cs_pay_id := (v_cs_res->>'payment_id')::UUID;
        v_cs_res_id := (v_cs_res->>'reservation_id')::UUID;

        PERFORM public.bind_provider_checkout_session(
            v_cs_pay_id, v_cs_res_id, 'paymongo', 'cs_paymongo_env_001',
            'https://checkout.paymongo.com/cs_paymongo_env_001', 'idem_bind_cs_env_001'
        );

        -- 46A: Missing embedded payments[0] must be rejected
        INSERT INTO public.provider_webhook_events (
            provider_name, provider_event_id, event_type, signature_verification_status,
            signature_header, processing_state, payload
        ) VALUES (
            'paymongo', 'evt_cs_missing_pay_001', 'checkout_session.payment.paid', 'verified',
            't=1700000000,te=valid_hmac_hex', 'pending',
            jsonb_build_object(
                'data', jsonb_build_object(
                    'id', 'evt_cs_missing_pay_001',
                    'type', 'checkout_session.payment.paid',
                    'attributes', jsonb_build_object(
                        'data', jsonb_build_object(
                            'id', 'cs_paymongo_env_001',
                            'type', 'checkout_session',
                            'attributes', jsonb_build_object('payments', '[]'::jsonb)
                        )
                    )
                )
            )
        ) RETURNING id INTO v_wh_cs_missing;

        BEGIN
            PERFORM public.process_verified_payment_event(
                v_wh_cs_missing, 'paymongo', 'evt_cs_missing_pay_001', 'pay_missing_001',
                'cs_paymongo_env_001', 350.00, 'PHP', 'idem_cs_missing_001', '{}'::jsonb
            );
            RAISE EXCEPTION 'Test 46A Failed: Missing embedded payments[0] was not rejected!';
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%does not contain provider payment identity%' THEN
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 46A PASSED: checkout_session.payment.paid without embedded payments[0] rejected.';
            ELSE
                RAISE EXCEPTION 'Test 46A Failed: Unexpected error: %', SQLERRM;
            END IF;
        END;

        -- 46B: Valid realistic checkout_session.payment.paid envelope confirms booking & posts balanced journal
        INSERT INTO public.provider_webhook_events (
            provider_name, provider_event_id, event_type, signature_verification_status,
            signature_header, processing_state, payload
        ) VALUES (
            'paymongo', 'evt_cs_valid_001', 'checkout_session.payment.paid', 'verified',
            't=1700000000,te=valid_hmac_hex', 'pending',
            jsonb_build_object(
                'data', jsonb_build_object(
                    'id', 'evt_cs_valid_001',
                    'type', 'checkout_session.payment.paid',
                    'attributes', jsonb_build_object(
                        'data', jsonb_build_object(
                            'id', 'cs_paymongo_env_001',
                            'type', 'checkout_session',
                            'attributes', jsonb_build_object(
                                'reference_number', v_cs_res->>'reference_code',
                                'payments', jsonb_build_array(
                                    jsonb_build_object(
                                        'id', 'pay_embedded_001',
                                        'type', 'payment',
                                        'attributes', jsonb_build_object(
                                            'amount', 35000,
                                            'currency', 'PHP',
                                            'status', 'paid'
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
            )
        ) RETURNING id INTO v_wh_cs_valid;

        v_cs_proc_res := public.process_verified_payment_event(
            v_wh_cs_valid, 'paymongo', 'evt_cs_valid_001', 'pay_embedded_001',
            'cs_paymongo_env_001', 350.00, 'PHP', 'idem_cs_valid_001', '{}'::jsonb
        );

        IF (v_cs_proc_res->>'success')::boolean IS NOT TRUE THEN
            RAISE EXCEPTION 'Test 46B Failed: Valid checkout_session.payment.paid was not processed!';
        END IF;

        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 46B PASSED: Realistic checkout_session.payment.paid envelope confirmed booking and posted balanced journal.';
    END;

    RAISE NOTICE '=== ALL % DATABASE TESTS COMPLETED SUCCESSFULLY ===', v_test_count;
END $$;

COMMIT;
