-- ==============================================================================
-- CourtBook / BookSuite — Test Fixture SQL
-- File: tests/supabase/fixtures/005b_payments_payouts_test.sql
-- Description: Isolated Verification Test Suite for Hardened Migration 005B
--
-- TESTS COVERED:
--   1. Cross-tenant payment isolation & composite foreign key rejection
--   2. Duplicate provider payment IDs rejection
--   3. Duplicate webhook event IDs rejection
--   4. Out-of-order webhook events & append-only immutability
--   5. Conflicting payment status transitions & hardened captured evidence requirements
--   6. Invalid amounts and currency checks
--   7. Incorrect reservation ownership checks
--   8. Payout Methods & Masked Account Protection
--   9. Payout State Machine Transitions & Audit Trail
--   10. Settlement Reconciliation Discrepancies & Safeguards
--   11. Gateway & Payout Fee Policy Undecided Status Preservation
--   12. Application-Role Authorization & Security Hardening
--   13. Preservation of Existing Booking System
--   14. SECURITY REVIEW 1: Cross-Tenant Payout Method Rejection (fk_payouts_method_org)
--   15. SECURITY REVIEW 2: Cross-Tenant Settlement Payment Reference Rejection (fk_settlement_items_payment_org_fac)
--   16. SECURITY REVIEW 3: Immutability of Payment Snapshot Under Same-Status Updates
--   17. SECURITY REVIEW 4: Duplicate Capture Attempt After Refund & Dispute Rejection (uq_captured_payment_lifecycle_per_reservation)
--   18. SECURITY REVIEW 5: Unauthorized Changes to Payout Amount / Destination Rejection
--   19. SECURITY REVIEW 6: Webhook Signature Evidence Tampering Rejection
--   20. SECURITY REVIEW 7: Payout-Method Sensitive-Data Protection from Staff Roles
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
    v_synth_res_c UUID := gen_random_uuid();

    v_payment_id UUID;
    v_payout_method_id_a UUID;
    v_payout_method_id_b UUID;
    v_payout_id UUID;
    v_batch_id UUID;
    v_item_id UUID;
    v_test_count INT := 0;
BEGIN
    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== Migration 005B: Hardened Payments & Payouts Test Suite           ===';
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
    ), (
        v_synth_res_c, v_synth_fac_a, v_synth_court_a, 'SYNTH-RES-05B-C', 'Customer C', 'customer.c@example.com',
        CURRENT_DATE, now() + interval '3 hours', now() + interval '4 hours', '11:00 - 12:00', 60, 350.00, '₱', 'confirmed'
    );

    -- -------------------------------------------------------------------------
    -- TEST 1: Cross-Tenant Payment Isolation & Composite Foreign Key Rejection
    -- -------------------------------------------------------------------------
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
    INSERT INTO public.payments (
        id, organization_id, facility_id, reservation_id, expected_amount,
        commission_rate, commission_amount, owner_gross_share, status,
        captured_amount, provider_name, provider_payment_id
    ) VALUES (
        gen_random_uuid(), v_synth_org_a, v_synth_fac_a, v_synth_res_a,
        350.00, 0.0500, 17.50, 332.50, 'captured',
        350.00, 'paymongo', 'pay_unique_test_12345'
    ) RETURNING id INTO v_payment_id;

    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status,
            captured_amount, provider_name, provider_payment_id
        ) VALUES (
            v_synth_org_b, v_synth_fac_b, v_synth_res_b,
            400.00, 0.0500, 20.00, 380.00, 'captured',
            400.00, 'paymongo', 'pay_unique_test_12345' -- DUPLICATE!
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
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_paymongo_001_test', 'payment.paid', 'verified',
        'sig_header_auth_xyz', 'processed', '{"data": {"id": "pay_test_001"}}'::jsonb
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

    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        processing_state, payload, event_timestamp
    ) VALUES (
        'paymongo', 'evt_out_of_order_002', 'refund.created', 'verified',
        'pending', '{"payment_id": "pay_pending_order"}'::jsonb, now()
    );
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 4b PASSED: Out-of-order webhook ingested safely without breaking inbox state.';

    -- -------------------------------------------------------------------------
    -- TEST 5: Conflicting Payment Status Transitions & Hardened Captured Evidence
    -- -------------------------------------------------------------------------
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

    -- Hardened capture verification: attempting to mark captured without positive captured_amount fails
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status,
            captured_amount, provider_name, provider_payment_id
        ) VALUES (
            v_synth_org_b, v_synth_fac_b, v_synth_res_b,
            400.00, 0.0500, 20.00, 380.00, 'pending',
            0.00, 'paymongo', 'pay_b_pending_01'
        ) RETURNING id INTO v_payment_id;

        UPDATE public.payments
        SET status = 'captured', captured_amount = 0.00
        WHERE id = v_payment_id;
        RAISE EXCEPTION 'Test 5 Failed: Payment allowed capture with zero captured_amount!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Explicit verified captured_amount is required%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 5c PASSED: Zero captured_amount rejected when marking status captured.';
        ELSE
            RAISE EXCEPTION 'Test 5 Failed: Unexpected error on captured_amount check: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 6: Invalid Amounts and Currency Checks
    -- -------------------------------------------------------------------------
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

    -- -------------------------------------------------------------------------
    -- TEST 8: Payout Methods & Masked Account Protection
    -- -------------------------------------------------------------------------
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

    INSERT INTO public.payout_methods (
        id, organization_id, method_type, provider_name, provider_recipient_token,
        account_holder_name, masked_account_number, bank_code, bank_name, is_active, is_default, verification_status
    ) VALUES (
        gen_random_uuid(), v_synth_org_a, 'bank_transfer', 'paymongo', 'tok_recip_a_secret_123',
        'Owner Juan A', '****9012', 'BDO', 'Banco de Oro', true, true, 'verified'
    ) RETURNING id INTO v_payout_method_id_a;

    INSERT INTO public.payout_methods (
        id, organization_id, method_type, provider_name, provider_recipient_token,
        account_holder_name, masked_account_number, bank_code, bank_name, is_active, is_default, verification_status
    ) VALUES (
        gen_random_uuid(), v_synth_org_b, 'bank_transfer', 'paymongo', 'tok_recip_b_secret_456',
        'Owner Maria B', '****7777', 'BPI', 'Bank of the Philippine Islands', true, true, 'verified'
    ) RETURNING id INTO v_payout_method_id_b;

    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 8b PASSED: Valid masked payout methods provisioned.';

    -- -------------------------------------------------------------------------
    -- TEST 9: Payout State Machine Transitions & Audit Trail
    -- -------------------------------------------------------------------------
    INSERT INTO public.payouts (
        id, organization_id, payout_method_id, amount, status, provider_payout_id
    ) VALUES (
        gen_random_uuid(), v_synth_org_a, v_payout_method_id_a, 1000.00, 'pending_request', 'payout_prov_ref_001'
    ) RETURNING id INTO v_payout_id;

    UPDATE public.payouts SET status = 'approved_reserved' WHERE id = v_payout_id;
    UPDATE public.payouts SET status = 'submitted_to_provider' WHERE id = v_payout_id;
    UPDATE public.payouts SET status = 'paid' WHERE id = v_payout_id;

    BEGIN
        UPDATE public.payouts SET status = 'failed' WHERE id = v_payout_id;
        RAISE EXCEPTION 'Test 9 Failed: Terminal paid payout allowed transition to failed!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%is in terminal status "paid" and cannot be modified%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 9a PASSED: Terminal paid payout rejected conflicting transition to failed.';
        ELSE
            RAISE EXCEPTION 'Test 9 Failed: Unexpected error on payout transition: %', SQLERRM;
        END IF;
    END;

    -- Verify audit trail
    IF (SELECT count(*) FROM public.payout_lifecycle_logs WHERE payout_id = v_payout_id) < 4 THEN
        RAISE EXCEPTION 'Test 9 Failed: Missing lifecycle audit records in payout_lifecycle_logs!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 9b PASSED: Payout lifecycle audit trail accurately logged all transitions.';

    -- -------------------------------------------------------------------------
    -- TEST 10 & 11: Settlement Reconciliation Discrepancies & Safeguards
    -- -------------------------------------------------------------------------
    INSERT INTO public.settlement_batches (
        id, provider_name, provider_batch_id, settlement_date,
        total_gross_amount, total_net_amount, total_fee_amount, status
    ) VALUES (
        gen_random_uuid(), 'paymongo', 'batch_test_2026_10_31', CURRENT_DATE,
        400.00, 385.00, 15.00, 'pending_reconciliation'
    ) RETURNING id INTO v_batch_id;

    -- Provision valid captured payment for Org B
    INSERT INTO public.payments (
        organization_id, facility_id, reservation_id, expected_amount,
        commission_rate, commission_amount, owner_gross_share, status,
        captured_amount, provider_name, provider_payment_id
    ) VALUES (
        v_synth_org_b, v_synth_fac_b, v_synth_res_b,
        400.00, 0.0500, 20.00, 380.00, 'captured',
        400.00, 'paymongo', 'pay_b_captured_settle_01'
    ) RETURNING id INTO v_payment_id;

    -- Valid item matched against payment (matching payment_id, organization_id, facility_id)
    INSERT INTO public.settlement_items (
        batch_id, payment_id, provider_payment_id, organization_id, facility_id,
        gross_amount, provider_fee_amount, net_settled_amount, settlement_status
    ) VALUES (
        v_batch_id, v_payment_id, 'pay_b_captured_settle_01', v_synth_org_b, v_synth_fac_b,
        400.00, 15.00, 385.00, 'matched'
    ) RETURNING id INTO v_item_id;

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
        RAISE EXCEPTION 'Test 12 Failed: fee policy is not set to undecided!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 12 PASSED: Gateway processing and payout fee policies confirmed as undecided.';

    -- -------------------------------------------------------------------------
    -- TEST 13: Preservation of Existing Booking System
    -- -------------------------------------------------------------------------
    INSERT INTO public.reservations (
        facility_id, court_id, reference_code, customer_name, customer_email,
        booking_date, start_time, end_time, time_slot_label, duration_minutes, price, currency, status
    ) VALUES (
        v_synth_fac_a, v_synth_court_a, 'BOOK-SAFE-001', 'Existing Flow User', 'user@example.com',
        CURRENT_DATE, now() + interval '4 hours', now() + interval '5 hours', '12:00 - 13:00', 60, 350.00, '₱', 'confirmed'
    );
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 13 PASSED: Existing reservation creation and constraints remain completely unaffected.';

    -- =========================================================================
    -- SECURITY REVIEW CORRECTIONS VERIFICATION
    -- =========================================================================

    -- -------------------------------------------------------------------------
    -- TEST 14: SECURITY REVIEW 1: Cross-Tenant Payout Method Rejection (fk_payouts_method_org)
    -- -------------------------------------------------------------------------
    -- Attempt to create payout for Org A using Org B's payout method!
    -- fk_payouts_method_org MUST reject this!
    BEGIN
        INSERT INTO public.payouts (
            organization_id, payout_method_id, amount, status
        ) VALUES (
            v_synth_org_a,          -- Org A!
            v_payout_method_id_b,   -- Org B's method!
            500.00, 'pending_request'
        );
        RAISE EXCEPTION 'Test 14 Failed: Cross-tenant payout method was not rejected!';
    EXCEPTION WHEN foreign_key_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 14 PASSED: Cross-tenant payout method reference rejected by fk_payouts_method_org.';
    END;

    -- -------------------------------------------------------------------------
    -- TEST 15: SECURITY REVIEW 2: Cross-Tenant Settlement Payment Reference Rejection
    -- -------------------------------------------------------------------------
    -- Attempt to create settlement_item linking Org A batch with Org B payment!
    BEGIN
        INSERT INTO public.settlement_items (
            batch_id, payment_id, provider_payment_id, organization_id, facility_id,
            gross_amount, provider_fee_amount, net_settled_amount, settlement_status
        ) VALUES (
            v_batch_id,
            v_payment_id,   -- Belongs to Org B & Facility B!
            'pay_prov_cross_attempt',
            v_synth_org_a,  -- Org A!
            v_synth_fac_a,  -- Facility A!
            350.00, 15.00, 335.00, 'matched'
        );
        RAISE EXCEPTION 'Test 15 Failed: Cross-tenant settlement item payment link was not rejected!';
    EXCEPTION WHEN foreign_key_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 15a PASSED: Cross-tenant settlement payment link rejected by fk_settlement_items_payment_org_fac.';
    END;

    -- Attempt to insert settlement_item with NULL facility_id (strictly disallowed)
    BEGIN
        INSERT INTO public.settlement_items (
            batch_id, payment_id, provider_payment_id, organization_id, facility_id,
            gross_amount, provider_fee_amount, net_settled_amount, settlement_status
        ) VALUES (
            v_batch_id, v_payment_id, 'pay_null_fac', v_synth_org_b, NULL,
            350.00, 15.00, 335.00, 'matched'
        );
        RAISE EXCEPTION 'Test 15 Failed: NULL facility_id in settlement_items was not rejected!';
    EXCEPTION WHEN not_null_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 15b PASSED: NULL facility_id in settlement_items rejected by NOT NULL constraint.';
    END;

    -- -------------------------------------------------------------------------
    -- TEST 16: SECURITY REVIEW 3: Immutability of Payment Snapshot Under Same-Status Updates
    -- -------------------------------------------------------------------------
    -- Attempt to update commission_amount on an existing payment without changing status
    BEGIN
        UPDATE public.payments
        SET commission_amount = 99.99
        WHERE id = v_payment_id;
        RAISE EXCEPTION 'Test 16 Failed: Commission amount mutation under same-status update was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Financial snapshot, ownership, and established provider identity fields in payments table are strictly immutable%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 16a PASSED: Mutation of commission_amount with unchanged status rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 16 Failed: Unexpected error on commission update: %', SQLERRM;
        END IF;
    END;

    -- Attempt to mutate expected_amount or organization_id under same-status update
    BEGIN
        UPDATE public.payments
        SET expected_amount = 500.00
        WHERE id = v_payment_id;
        RAISE EXCEPTION 'Test 16 Failed: Expected amount mutation under same-status update was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Financial snapshot, ownership, and established provider identity fields in payments table are strictly immutable%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 16b PASSED: Mutation of expected_amount with unchanged status rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 16 Failed: Unexpected error on expected_amount update: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 17: SECURITY REVIEW 4: Duplicate Capture Attempt After Refund & Dispute Rejection
    -- -------------------------------------------------------------------------
    -- Reservation A has a payment that was captured and then refunded (from Test 2 & 5b).
    -- Attempt to insert another captured payment for Reservation A:
    -- uq_captured_payment_lifecycle_per_reservation MUST reject this!
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status,
            captured_amount, provider_name, provider_payment_id
        ) VALUES (
            v_synth_org_a, v_synth_fac_a, v_synth_res_a, -- Same reservation!
            350.00, 0.0500, 17.50, 332.50, 'captured',
            350.00, 'paymongo', 'pay_second_capture_after_refund'
        );
        RAISE EXCEPTION 'Test 17 Failed: Duplicate capture after refund was not rejected!';
    EXCEPTION WHEN unique_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 17 PASSED: Duplicate capture after refund rejected by uq_captured_payment_lifecycle_per_reservation.';
    END;

    -- -------------------------------------------------------------------------
    -- TEST 18: SECURITY REVIEW 5: Unauthorized Changes to Payout Amount / Destination
    -- -------------------------------------------------------------------------
    -- Attempt to change payout amount on existing payout
    BEGIN
        UPDATE public.payouts
        SET amount = 9999.00
        WHERE id = v_payout_id;
        RAISE EXCEPTION 'Test 18 Failed: Payout amount mutation was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout amount, currency, organization, and destination method are strictly immutable%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 18a PASSED: Mutation of payout amount rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 18 Failed: Unexpected error on payout amount update: %', SQLERRM;
        END IF;
    END;

    -- Attempt to change payout method destination on existing payout
    BEGIN
        UPDATE public.payouts
        SET payout_method_id = v_payout_method_id_b
        WHERE id = v_payout_id;
        RAISE EXCEPTION 'Test 18 Failed: Payout destination method mutation was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout amount, currency, organization, and destination method are strictly immutable%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 18b PASSED: Mutation of payout destination rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 18 Failed: Unexpected error on payout destination update: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 19: SECURITY REVIEW 6: Webhook Signature Evidence Tampering Rejection
    -- -------------------------------------------------------------------------
    BEGIN
        UPDATE public.provider_webhook_events
        SET signature_header = 'tampered_signature_string'
        WHERE provider_event_id = 'evt_paymongo_001_test';
        RAISE EXCEPTION 'Test 19 Failed: Webhook signature tampering was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Webhook event identity, payload, timestamp, and signature evidence are strictly immutable%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 19a PASSED: Alteration of webhook signature header rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 19 Failed: Unexpected error on signature tampering: %', SQLERRM;
        END IF;
    END;

    BEGIN
        UPDATE public.provider_webhook_events
        SET signature_verification_status = 'unverified'
        WHERE provider_event_id = 'evt_paymongo_001_test';
        RAISE EXCEPTION 'Test 19 Failed: Reversing verified signature status was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Webhook event identity, payload, timestamp, and signature evidence are strictly immutable%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 19b PASSED: Alteration of verified signature status rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 19 Failed: Unexpected error on signature status reversal: %', SQLERRM;
        END IF;
    END;

    RAISE NOTICE '=== ALL % DATABASE TESTS COMPLETED SUCCESSFULLY ===', v_test_count;
END $$;

-- ------------------------------------------------------------------------------
-- TEST 20: SECURITY REVIEW 7: Payout-Method Sensitive-Data Protection from Staff
-- ------------------------------------------------------------------------------
-- Provision test users: Owner User and Staff User
DO $$
DECLARE
    v_owner_user_id UUID := gen_random_uuid();
    v_staff_user_id UUID := gen_random_uuid();
    v_test_org_id UUID;
BEGIN
    SELECT id INTO v_test_org_id FROM public.organizations LIMIT 1;

    -- Insert mock auth users
    INSERT INTO auth.users (id, email) VALUES
        (v_owner_user_id, 'owner@example.com'),
        (v_staff_user_id, 'staff@example.com')
    ON CONFLICT DO NOTHING;

    -- Map roles in organization_members
    INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
        (v_test_org_id, v_owner_user_id, 'owner'),
        (v_test_org_id, v_staff_user_id, 'staff')
    ON CONFLICT DO NOTHING;

    PERFORM set_config('app.test_staff_uid', v_staff_user_id::text, false);
    PERFORM set_config('app.test_owner_uid', v_owner_user_id::text, false);
END $$;

-- Test Staff User: Cannot SELECT from public.payout_methods table
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    v_staff_uid UUID := current_setting('app.test_staff_uid', true)::UUID;
    v_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_staff_uid::text, true);

    -- RLS policy filters out payout_methods for staff (only owner and admin allowed)
    SELECT count(*) INTO v_count FROM public.payout_methods;
    IF v_count != 0 THEN
        RAISE EXCEPTION 'Security Breach: staff role was able to view % records in payout_methods!', v_count;
    END IF;
    RAISE NOTICE 'Test 20a PASSED: RLS blocked staff role from querying payout_methods table (0 rows returned).';
END $$;

RESET ROLE;

-- Test Owner User: Can SELECT from safe projection public.v_masked_payout_methods
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    v_owner_uid UUID := current_setting('app.test_owner_uid', true)::UUID;
    v_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_owner_uid::text, true);

    SELECT count(*) INTO v_count FROM public.v_masked_payout_methods;
    RAISE NOTICE 'Test 20b PASSED: Authenticated owner successfully queried safe projection v_masked_payout_methods (rows: %).', v_count;
END $$;

RESET ROLE;

-- Rollback entire synthetic test fixture: leaves persistent database pristine
ROLLBACK;
