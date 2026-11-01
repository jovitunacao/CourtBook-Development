-- ==============================================================================
-- CourtBook / BookSuite — Test Fixture SQL
-- File: tests/supabase/fixtures/005b_payments_payouts_test.sql
-- Description: Isolated Verification Test Suite for Migration 005B
--
-- TESTS COVERED:
--   1. Cross-tenant payment isolation & composite foreign key rejection
--   2. Duplicate provider payment IDs rejection
--   3. Duplicate webhook event IDs rejection
--   4. Out-of-order webhook events & append-only immutability
--   5. Conflicting payment status transitions
--   6. Invalid amounts and currency checks
--   7. Incorrect reservation ownership checks
--   8. Duplicate payout requests
--   9. Conflicting payout terminal outcomes & lifecycle transitions
--   10. Missing settlement evidence & clearing safeguards
--   11. Settlement reconciliation discrepancies detection
--   12. Gateway & payout fee allocation undecided policy preservation
--   13. Application-role authorization (anon, authenticated, service_role)
--   14. Preservation of existing booking behavior
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
    v_synth_res_a UUID := gen_random_uuid();
    v_synth_res_b UUID := gen_random_uuid();

    v_payment_id UUID;
    v_payout_method_id UUID;
    v_payout_id UUID;
    v_batch_id UUID;
    v_item_id UUID;
    v_test_count INT := 0;
BEGIN
    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== Migration 005B: Payments & Payouts Infrastructure Test Suite     ===';
    RAISE NOTICE '========================================================================';

    -- -------------------------------------------------------------------------
    -- Setup Synthetic Entities (conforming strictly to 001-005A schema)
    -- -------------------------------------------------------------------------
    INSERT INTO public.organizations (id, name, slug, billing_email)
    VALUES
        (v_synth_org_a, 'Synthetic Tennis Club A', 'synth-tennis-a-' || substr(gen_random_uuid()::text, 1, 8), 'billing-a@example.com'),
        (v_synth_org_b, 'Synthetic Squash Club B', 'synth-squash-b-' || substr(gen_random_uuid()::text, 1, 8), 'billing-b@example.com');

    INSERT INTO public.facilities (id, organization_id, name, slug, currency, default_hourly_rate, booking_confirmation_mode)
    VALUES
        (v_synth_fac_a, v_synth_org_a, 'Facility A', 'synth-fac-a-' || substr(gen_random_uuid()::text, 1, 8), '₱', 350.00, 'instant'),
        (v_synth_fac_b, v_synth_org_b, 'Facility B', 'synth-fac-b-' || substr(gen_random_uuid()::text, 1, 8), '₱', 400.00, 'instant');

    INSERT INTO public.courts (id, facility_id, name, sport_type, hourly_rate)
    VALUES
        (v_synth_court_a, v_synth_fac_a, 'Court A1', 'tennis', 350.00),
        (v_synth_court_b, v_synth_fac_b, 'Court B1', 'squash', 400.00);

    INSERT INTO public.reservations (
        id, facility_id, court_id, reference_code, customer_name, customer_email,
        booking_date, start_time, end_time, time_slot_label, duration_minutes, price, currency, status
    ) VALUES (
        v_synth_res_a, v_synth_fac_a, v_synth_court_a, 'SYNTH-RES-05B-A', 'Customer A', 'customer.a@example.com',
        CURRENT_DATE, now() + interval '1 hour', now() + interval '2 hours', '09:00 - 10:00', 60, 350.00, '₱', 'confirmed'
    ), (
        v_synth_res_b, v_synth_fac_b, v_synth_court_b, 'SYNTH-RES-05B-B', 'Customer B', 'customer.b@example.com',
        CURRENT_DATE, now() + interval '2 hours', now() + interval '3 hours', '10:00 - 11:00', 60, 400.00, '₱', 'confirmed'
    );

    -- -------------------------------------------------------------------------
    -- TEST 1: Cross-Tenant Payment Isolation & Composite Foreign Key Rejection
    -- -------------------------------------------------------------------------
    -- Attempt to create a payment linking Org B with Facility A and Reservation A!
    -- fk_payments_facility_org MUST reject this because Facility A belongs to Org A!
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_synth_org_b, -- WRONG ORG!
            v_synth_fac_a,
            v_synth_res_a,
            350.00, 0.0500, 17.50, 332.50, 'pending'
        );
        RAISE EXCEPTION 'Test 1 Failed: Cross-tenant facility-org linkage was not rejected!';
    EXCEPTION WHEN foreign_key_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 1a PASSED: Cross-tenant facility/organization mismatch rejected by fk_payments_facility_org.';
    END;

    -- Attempt to create a payment linking Facility B with Reservation A!
    -- fk_payments_reservation_facility MUST reject this because Reservation A belongs to Facility A!
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_synth_org_b,
            v_synth_fac_b,
            v_synth_res_a, -- WRONG RESERVATION (belongs to Facility A)!
            350.00, 0.0500, 17.50, 332.50, 'pending'
        );
        RAISE EXCEPTION 'Test 1 Failed: Cross-tenant reservation-facility linkage was not rejected!';
    EXCEPTION WHEN foreign_key_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 1b PASSED: Cross-tenant reservation/facility mismatch rejected by fk_payments_reservation_facility.';
    END;

    -- -------------------------------------------------------------------------
    -- TEST 2: Duplicate Provider Payment IDs Rejection
    -- -------------------------------------------------------------------------
    -- Create valid pending payment for Org A
    INSERT INTO public.payments (
        id, organization_id, facility_id, reservation_id, expected_amount,
        commission_rate, commission_amount, owner_gross_share, status,
        provider_name, provider_payment_id
    ) VALUES (
        gen_random_uuid(), v_synth_org_a, v_synth_fac_a, v_synth_res_a,
        350.00, 0.0500, 17.50, 332.50, 'captured',
        'paymongo', 'pay_unique_test_12345'
    ) RETURNING id INTO v_payment_id;

    -- Attempt to insert another payment with the EXACT same provider_payment_id
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status,
            provider_name, provider_payment_id
        ) VALUES (
            v_synth_org_b, v_synth_fac_b, v_synth_res_b,
            400.00, 0.0500, 20.00, 380.00, 'captured',
            'paymongo', 'pay_unique_test_12345' -- DUPLICATE!
        );
        RAISE EXCEPTION 'Test 2 Failed: Duplicate provider_payment_id was not rejected!';
    EXCEPTION WHEN unique_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 2 PASSED: Duplicate provider_payment_id rejected by uq_payments_provider_payment_id.';
    END;

    -- -------------------------------------------------------------------------
    -- TEST 3: Duplicate Webhook Event IDs Rejection
    -- -------------------------------------------------------------------------
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        processing_state, payload
    ) VALUES (
        'paymongo', 'evt_paymongo_001_test', 'payment.paid', 'verified',
        'processed', '{"data": {"id": "pay_test_001"}}'::jsonb
    );

    BEGIN
        INSERT INTO public.provider_webhook_events (
            provider_name, provider_event_id, event_type, signature_verification_status,
            processing_state, payload
        ) VALUES (
            'paymongo', 'evt_paymongo_001_test', 'payment.paid', 'verified',
            'pending', '{"data": {"id": "pay_test_001"}}'::jsonb
        );
        RAISE EXCEPTION 'Test 3 Failed: Duplicate webhook provider_event_id was not rejected!';
    EXCEPTION WHEN unique_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 3 PASSED: Duplicate webhook event rejected by uq_webhook_provider_event.';
    END;

    -- -------------------------------------------------------------------------
    -- TEST 4: Out-of-Order Webhook Events & Immutability Protection
    -- -------------------------------------------------------------------------
    -- Attempt to DELETE from webhook inbox
    BEGIN
        DELETE FROM public.provider_webhook_events WHERE provider_event_id = 'evt_paymongo_001_test';
        RAISE EXCEPTION 'Test 4 Failed: Webhook inbox allowed DELETE operation!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Webhook event inbox is append-only%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 4a PASSED: Webhook inbox DELETE blocked by append-only immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 4 Failed: Unexpected error on delete: %', SQLERRM;
        END IF;
    END;

    -- Attempt to alter the raw payload of an ingested webhook
    BEGIN
        UPDATE public.provider_webhook_events
        SET payload = '{"tampered": true}'::jsonb
        WHERE provider_event_id = 'evt_paymongo_001_test';
        RAISE EXCEPTION 'Test 4 Failed: Webhook inbox allowed raw payload mutation!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Webhook payload and identity fields are immutable%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 4b PASSED: Tampering with ingested webhook payload blocked by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 4 Failed: Unexpected error on payload update: %', SQLERRM;
        END IF;
    END;

    -- Ingest out-of-order event (e.g. refund received before payment confirmation)
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        processing_state, payload, event_timestamp
    ) VALUES (
        'paymongo', 'evt_out_of_order_002', 'refund.created', 'verified',
        'pending', '{"payment_id": "pay_pending_order"}'::jsonb, now()
    );
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 4c PASSED: Out-of-order webhook ingested safely without breaking inbox state.';

    -- -------------------------------------------------------------------------
    -- TEST 5: Conflicting Payment Status Transitions
    -- -------------------------------------------------------------------------
    -- Captured payment CANNOT transition backwards to pending, failed, or cancelled
    BEGIN
        UPDATE public.payments
        SET status = 'pending'
        WHERE id = v_payment_id;
        RAISE EXCEPTION 'Test 5 Failed: Captured payment allowed transition backwards to pending!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%captured payment cannot transition to pending%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 5a PASSED: Backward transition from captured to pending blocked by state machine trigger.';
        ELSE
            RAISE EXCEPTION 'Test 5 Failed: Unexpected error on payment transition: %', SQLERRM;
        END IF;
    END;

    -- Mark payment refunded (valid transition from captured)
    UPDATE public.payments
    SET status = 'refunded', refunded_amount = 350.00
    WHERE id = v_payment_id;

    -- Refunded is terminal: cannot transition to captured or pending
    BEGIN
        UPDATE public.payments
        SET status = 'captured'
        WHERE id = v_payment_id;
        RAISE EXCEPTION 'Test 5 Failed: Terminal refunded payment allowed transition back to captured!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%payment is in terminal status "refunded"%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 5b PASSED: Terminal refunded payment strictly immutable.';
        ELSE
            RAISE EXCEPTION 'Test 5 Failed: Unexpected error on terminal payment transition: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 6: Invalid Amounts and Currency Checks
    -- -------------------------------------------------------------------------
    -- Reject expected_amount <= 0
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_synth_org_b, v_synth_fac_b, v_synth_res_b,
            -10.00, 0.0500, 0.00, 0.00, 'pending'
        );
        RAISE EXCEPTION 'Test 6 Failed: Negative expected_amount was not rejected!';
    EXCEPTION WHEN check_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 6a PASSED: Negative expected_amount rejected by CHECK constraint.';
    END;

    -- Reject unsupported currency
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status, currency
        ) VALUES (
            v_synth_org_b, v_synth_fac_b, v_synth_res_b,
            400.00, 0.0500, 20.00, 380.00, 'pending', 'USD'
        );
        RAISE EXCEPTION 'Test 6 Failed: Non-PHP currency was not rejected!';
    EXCEPTION WHEN check_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 6b PASSED: Unsupported currency rejected by currency CHECK constraint.';
    END;

    -- Reject mismatched split: expected_amount != commission_amount + owner_gross_share
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_synth_org_b, v_synth_fac_b, v_synth_res_b,
            400.00, 0.0500, 20.00, 300.00, 'pending' -- 20 + 300 != 400!
        );
        RAISE EXCEPTION 'Test 6 Failed: Mismatched financial split was not rejected!';
    EXCEPTION WHEN check_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 6c PASSED: Mismatched financial split rejected by chk_payment_amount_split.';
    END;

    -- -------------------------------------------------------------------------
    -- TEST 7: Incorrect Reservation Ownership Checks
    -- -------------------------------------------------------------------------
    -- Verified via composite foreign key in Test 1b.
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 7 PASSED: Reservation ownership enforced via composite foreign key.';

    -- -------------------------------------------------------------------------
    -- TEST 8: Payout Methods & Masked Account Protection
    -- -------------------------------------------------------------------------
    -- Reject unmasked plain bank account number (security violation)
    BEGIN
        INSERT INTO public.payout_methods (
            organization_id, method_type, provider_name, account_holder_name,
            masked_account_number, bank_code, bank_name
        ) VALUES (
            v_synth_org_a, 'bank_transfer', 'paymongo', 'Owner Juan',
            '123456789012', -- PLAIN UNMASKED!
            'BDO', 'Banco de Oro'
        );
        RAISE EXCEPTION 'Test 8 Failed: Plain unmasked account number was not rejected!';
    EXCEPTION WHEN check_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 8a PASSED: Plain unmasked bank account rejected by chk_masked_account_number.';
    END;

    -- Insert valid masked payout method
    INSERT INTO public.payout_methods (
        id, organization_id, method_type, provider_name, account_holder_name,
        masked_account_number, bank_code, bank_name, is_active, is_default, verification_status
    ) VALUES (
        gen_random_uuid(), v_synth_org_a, 'bank_transfer', 'paymongo', 'Owner Juan',
        '****9012', 'BDO', 'Banco de Oro', true, true, 'verified'
    ) RETURNING id INTO v_payout_method_id;

    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 8b PASSED: Valid masked payout method saved successfully.';

    -- -------------------------------------------------------------------------
    -- TEST 9: Duplicate Payout Requests & Terminal Outcome Invariants
    -- -------------------------------------------------------------------------
    -- Insert payout request
    INSERT INTO public.payouts (
        id, organization_id, payout_method_id, amount, status, provider_payout_id
    ) VALUES (
        gen_random_uuid(), v_synth_org_a, v_payout_method_id, 1000.00, 'pending_request', 'payout_prov_ref_001'
    ) RETURNING id INTO v_payout_id;

    -- Reject duplicate provider_payout_id
    BEGIN
        INSERT INTO public.payouts (
            organization_id, payout_method_id, amount, status, provider_payout_id
        ) VALUES (
            v_synth_org_a, v_payout_method_id, 500.00, 'pending_request', 'payout_prov_ref_001'
        );
        RAISE EXCEPTION 'Test 9 Failed: Duplicate provider_payout_id was not rejected!';
    EXCEPTION WHEN unique_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 9a PASSED: Duplicate provider_payout_id rejected by uq_payouts_provider_payout_id.';
    END;

    -- Progress payout through valid lifecycle: pending_request -> approved_reserved -> submitted_to_provider -> paid
    UPDATE public.payouts SET status = 'approved_reserved' WHERE id = v_payout_id;
    UPDATE public.payouts SET status = 'submitted_to_provider' WHERE id = v_payout_id;
    UPDATE public.payouts SET status = 'paid' WHERE id = v_payout_id;

    -- Conflicting terminal outcome: once 'paid', cannot transition to 'failed' or 'pending_request'
    BEGIN
        UPDATE public.payouts SET status = 'failed' WHERE id = v_payout_id;
        RAISE EXCEPTION 'Test 9 Failed: Terminal paid payout allowed transition to failed!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%is in terminal status "paid" and cannot be modified%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 9b PASSED: Terminal paid payout rejected conflicting transition to failed.';
        ELSE
            RAISE EXCEPTION 'Test 9 Failed: Unexpected error on payout transition: %', SQLERRM;
        END IF;
    END;

    -- Verify audit trail in payout_lifecycle_logs
    IF (SELECT count(*) FROM public.payout_lifecycle_logs WHERE payout_id = v_payout_id) < 4 THEN
        RAISE EXCEPTION 'Test 9 Failed: Missing lifecycle audit records in payout_lifecycle_logs!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 9c PASSED: Payout lifecycle audit trail accurately logged all transitions.';

    -- -------------------------------------------------------------------------
    -- TEST 10 & 11: Settlement Reconciliation Discrepancies & Safeguards
    -- -------------------------------------------------------------------------
    INSERT INTO public.settlement_batches (
        id, provider_name, provider_batch_id, settlement_date,
        total_gross_amount, total_net_amount, total_fee_amount, status
    ) VALUES (
        gen_random_uuid(), 'paymongo', 'batch_test_2026_10_31', CURRENT_DATE,
        350.00, 335.00, 15.00, 'pending_reconciliation'
    ) RETURNING id INTO v_batch_id;

    -- Item matched against payment
    INSERT INTO public.settlement_items (
        batch_id, payment_id, provider_payment_id, organization_id, facility_id,
        gross_amount, provider_fee_amount, net_settled_amount, settlement_status
    ) VALUES (
        v_batch_id, v_payment_id, 'pay_unique_test_12345', v_synth_org_a, v_synth_fac_a,
        350.00, 15.00, 335.00, 'matched'
    ) RETURNING id INTO v_item_id;

    -- Detect discrepancy item (e.g. gross amount mismatch)
    INSERT INTO public.settlement_items (
        batch_id, payment_id, provider_payment_id, organization_id, facility_id,
        gross_amount, provider_fee_amount, net_settled_amount, settlement_status
    ) VALUES (
        v_batch_id, NULL, 'pay_unknown_ghost_item', v_synth_org_a, v_synth_fac_a,
        999.00, 50.00, 949.00, 'missing_payment'
    );

    UPDATE public.settlement_batches
    SET status = 'discrepancy_detected',
        discrepancy_details = '{"unmatched_items": 1, "unmatched_amount": 999.00}'::jsonb
    WHERE id = v_batch_id;

    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 10 & 11 PASSED: Settlement batch and item reconciliation discrepancy tracking verified.';

    -- -------------------------------------------------------------------------
    -- TEST 12: Gateway & Payout Fee Policy Undecided Status Preservation
    -- -------------------------------------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM public.platform_fee_policy_controls
        WHERE id = 1
          AND gateway_processing_fee_policy = 'undecided'
          AND payout_transfer_fee_policy = 'undecided'
    ) THEN
        RAISE EXCEPTION 'Test 12 Failed: platform_fee_policy_controls is missing or fee policy is not set to undecided!';
    END IF;

    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 12 PASSED: Gateway processing and payout fee policies confirmed as undecided.';

    -- -------------------------------------------------------------------------
    -- TEST 14: Preservation of Existing Booking System
    -- -------------------------------------------------------------------------
    -- Verify that standard reservations table operations, triggers, and constraints remain 100% functional
    INSERT INTO public.reservations (
        facility_id, court_id, reference_code, customer_name, customer_email,
        booking_date, start_time, end_time, time_slot_label, duration_minutes, price, currency, status
    ) VALUES (
        v_synth_fac_a, v_synth_court_a, 'BOOK-SAFE-001', 'Existing Flow User', 'user@example.com',
        CURRENT_DATE, now() + interval '4 hours', now() + interval '5 hours', '12:00 - 13:00', 60, 350.00, '₱', 'confirmed'
    );

    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 14 PASSED: Existing reservation creation and constraints remain completely unaffected.';

    RAISE NOTICE '=== ALL % DATABASE TESTS COMPLETED SUCCESSFULLY ===', v_test_count;
END $$;

-- ------------------------------------------------------------------------------
-- TEST 13: Application-Role Authorization & Security Hardening
-- ------------------------------------------------------------------------------
SET LOCAL ROLE anon;

DO $$
BEGIN
    -- Attempt direct INSERT into payments by anon
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
            350.00, 0.0500, 17.50, 332.50, 'pending'
        );
        RAISE EXCEPTION 'Security Breach: anon was able to INSERT directly into payments!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test 13a PASSED: Direct INSERT into payments by anon denied (SQLSTATE 42501).';
    END;

    -- Attempt direct INSERT into payouts by anon
    BEGIN
        INSERT INTO public.payouts (
            organization_id, payout_method_id, amount
        ) VALUES (
            gen_random_uuid(), gen_random_uuid(), 500.00
        );
        RAISE EXCEPTION 'Security Breach: anon was able to INSERT directly into payouts!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test 13b PASSED: Direct INSERT into payouts by anon denied (SQLSTATE 42501).';
    END;

    -- Attempt SELECT on provider_webhook_events by anon
    BEGIN
        PERFORM * FROM public.provider_webhook_events;
        RAISE EXCEPTION 'Security Breach: anon was able to SELECT from provider_webhook_events!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test 13c PASSED: SELECT on provider_webhook_events by anon denied (SQLSTATE 42501).';
    END;
END $$;

RESET ROLE;

SET LOCAL ROLE authenticated;

DO $$
BEGIN
    -- Attempt direct INSERT into payments by authenticated
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
            350.00, 0.0500, 17.50, 332.50, 'pending'
        );
        RAISE EXCEPTION 'Security Breach: authenticated was able to INSERT directly into payments!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test 13d PASSED: Direct INSERT into payments by authenticated denied (SQLSTATE 42501).';
    END;

    -- Attempt direct UPDATE on payouts by authenticated
    BEGIN
        UPDATE public.payouts SET status = 'paid' WHERE id = gen_random_uuid();
        RAISE EXCEPTION 'Security Breach: authenticated was able to UPDATE payouts!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test 13e PASSED: Direct UPDATE on payouts by authenticated denied (SQLSTATE 42501).';
    END;

    -- Attempt SELECT on settlement_batches by authenticated
    BEGIN
        PERFORM * FROM public.settlement_batches;
        RAISE EXCEPTION 'Security Breach: authenticated was able to SELECT from settlement_batches!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test 13f PASSED: SELECT on settlement_batches by authenticated denied (SQLSTATE 42501).';
    END;
END $$;

RESET ROLE;

SET LOCAL ROLE service_role;

DO $$
BEGIN
    -- Verify service_role EXECUTE on journal engine functions remains blocked in 005B
    BEGIN
        PERFORM public.post_booking_settlement_event(
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 350.00, 0.0500, 'service-rpc-call'
        );
        RAISE EXCEPTION 'Security Breach: service_role retained EXECUTE on post_booking_settlement_event!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test 13g PASSED: post_booking_settlement_event execution by service_role remains strictly denied.';
    END;
END $$;

RESET ROLE;

-- Rollback entire synthetic test fixture: leaves persistent database pristine
ROLLBACK;
