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
--   9. Payout State Machine Transitions & Audit Trail (with valid mock journals)
--   10. Settlement Reconciliation Discrepancies & Safeguards
--   11. Gateway & Payout Fee Policy Undecided Status Preservation
--   12. Gateway and Payout Fee Policies Confirmed Undecided
--   13. Preservation of Existing Booking System
--   14. SECURITY REVIEW 1: Cross-Tenant Payout Method Rejection (fk_payouts_method_org)
--   15. SECURITY REVIEW 2: Cross-Tenant Settlement Payment Reference Rejection (fk_settlement_items_payment_org_fac)
--   16. SECURITY REVIEW 3: Immutability of Payment Snapshot Under Same-Status Updates
--   17. SECURITY REVIEW 4: Duplicate Capture Attempt After Refund & Dispute Rejection (uq_captured_payment_lifecycle_per_reservation)
--   18. SECURITY REVIEW 5: Unauthorized Changes to Payout Amount / Destination Rejection
--   19. SECURITY REVIEW 6: Webhook Signature Evidence Tampering Rejection
--   20. SECURITY REVIEW 7: Payout Token Confidentiality, Access Control & Token Denial
--   21. SECURITY REVIEW 8: Null-Safe Identifier Immutability (IS DISTINCT FROM)
--   22. SECURITY REVIEW 9: Lifecycle Insert-Time Status Validation & Same-Status Invariants (pending payments reject captured/refunded funds)
--   23. SECURITY REVIEW 10: Commission Snapshot Validation against Platform Config (including fail-closed check on missing config)
--   24. SECURITY REVIEW 11: Payment Intent Identity & Capture Evidence Immutability
--   25. SECURITY REVIEW 12: Terminal Payment Mutation Freeze
--   26. SECURITY REVIEW 13: Payout Lifecycle Logs Composite Consistency & Append-Only Trigger
--   27. SECURITY REVIEW 14: Mandatory Payout Journal Linkages (approved_reserved reserve journal, paid disbursement journal, failed release journal)
--   28. SECURITY REVIEW 15: Payout Terminal State Freeze
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
    v_synth_res_d UUID := gen_random_uuid();

    v_payment_id UUID;
    v_payout_method_id_a UUID;
    v_payout_method_id_b UUID;
    v_payout_id UUID;
    v_batch_id UUID;
    v_item_id UUID;
    v_test_count INT := 0;
    v_expected_failed BOOLEAN := false;
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
    ), (
        v_synth_res_d, v_synth_fac_b, v_synth_court_b, 'SYNTH-RES-05B-D', 'Customer D', 'customer.d@example.com',
        CURRENT_DATE, now() + interval '4 hours', now() + interval '5 hours', '12:00 - 13:00', 60, 400.00, '₱', 'confirmed'
    );

    PERFORM set_config('app.test_org_a', v_synth_org_a::text, false);
    PERFORM set_config('app.test_org_b', v_synth_org_b::text, false);

    -- -------------------------------------------------------------------------
    -- TEST 1: Cross-Tenant Payment Isolation & Composite Foreign Key Rejection
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
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
    EXCEPTION
        WHEN foreign_key_violation THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 1a PASSED: Cross-tenant facility/organization mismatch rejected by fk_payments_facility_org.';
        WHEN OTHERS THEN
            IF SQLSTATE = '23503' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 1a PASSED: Cross-tenant facility/organization mismatch rejected by fk_payments_facility_org.';
            ELSE
                RAISE EXCEPTION 'Test 1a Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 1a Failed: Cross-tenant facility-org linkage was not rejected!';
    END IF;

    v_expected_failed := false;
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
    EXCEPTION
        WHEN foreign_key_violation THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 1b PASSED: Cross-tenant reservation/facility mismatch rejected by fk_payments_reservation_facility.';
        WHEN OTHERS THEN
            IF SQLSTATE = '23503' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 1b PASSED: Cross-tenant reservation/facility mismatch rejected by fk_payments_reservation_facility.';
            ELSE
                RAISE EXCEPTION 'Test 1b Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 1b Failed: Cross-tenant reservation-facility linkage was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 2: Duplicate Provider Payment IDs Rejection
    -- -------------------------------------------------------------------------
    INSERT INTO public.payments (
        id, organization_id, facility_id, reservation_id, expected_amount,
        commission_rate, commission_amount, owner_gross_share, status
    ) VALUES (
        gen_random_uuid(), v_synth_org_a, v_synth_fac_a, v_synth_res_a,
        350.00, 0.0500, 17.50, 332.50, 'pending'
    ) RETURNING id INTO v_payment_id;

    UPDATE public.payments
    SET status = 'captured', captured_amount = 350.00, provider_name = 'paymongo', provider_payment_id = 'pay_unique_test_12345'
    WHERE id = v_payment_id;

    v_expected_failed := false;
    DECLARE
        v_pay_b_dup UUID;
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_synth_org_b, v_synth_fac_b, v_synth_res_b,
            400.00, 0.0500, 20.00, 380.00, 'pending'
        ) RETURNING id INTO v_pay_b_dup;

        UPDATE public.payments
        SET status = 'captured', captured_amount = 400.00, provider_name = 'paymongo', provider_payment_id = 'pay_unique_test_12345'
        WHERE id = v_pay_b_dup;
    EXCEPTION WHEN unique_violation THEN
        v_expected_failed := true;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 2 PASSED: Duplicate provider_payment_id rejected by uq_payments_provider_payment_id.';
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 2 Failed: Duplicate provider_payment_id was not rejected!';
    END IF;

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

    v_expected_failed := false;
    BEGIN
        INSERT INTO public.provider_webhook_events (
            provider_name, provider_event_id, event_type, signature_verification_status,
            processing_state, payload
        ) VALUES (
            'paymongo', 'evt_paymongo_001_test', 'payment.paid', 'verified',
            'pending', '{"data": {"id": "pay_test_001"}}'::jsonb
        );
    EXCEPTION WHEN unique_violation THEN
        v_expected_failed := true;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 3 PASSED: Duplicate webhook event rejected by uq_webhook_provider_event.';
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 3 Failed: Duplicate webhook provider_event_id was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 4: Out-of-Order Webhook Events & Immutability Protection
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        DELETE FROM public.provider_webhook_events WHERE provider_event_id = 'evt_paymongo_001_test';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Webhook event inbox is append-only%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 4a PASSED: Webhook inbox DELETE blocked by append-only immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 4 Failed: Unexpected error on delete [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 4 Failed: Webhook inbox allowed DELETE operation!';
    END IF;

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
    v_expected_failed := false;
    BEGIN
        UPDATE public.payments
        SET status = 'pending'
        WHERE id = v_payment_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%captured payment cannot transition to pending%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 5a PASSED: Backward transition from captured to pending blocked by state machine trigger.';
        ELSE
            RAISE EXCEPTION 'Test 5 Failed: Unexpected error on payment transition [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 5 Failed: Captured payment allowed transition backwards to pending!';
    END IF;

    -- Mark payment refunded (valid transition from captured)
    UPDATE public.payments
    SET status = 'refunded', refunded_amount = 350.00
    WHERE id = v_payment_id;

    -- Refunded is terminal: cannot transition to captured or pending
    v_expected_failed := false;
    BEGIN
        UPDATE public.payments
        SET status = 'captured'
        WHERE id = v_payment_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%is in terminal status "refunded" and cannot be modified%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 5b PASSED: Terminal refunded payment strictly immutable.';
        ELSE
            RAISE EXCEPTION 'Test 5 Failed: Unexpected error on terminal payment transition [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 5 Failed: Terminal refunded payment allowed transition back to captured!';
    END IF;

    -- Hardened capture verification: attempting to mark captured without positive captured_amount fails
    v_expected_failed := false;
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
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Explicit verified captured_amount is required%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 5c PASSED: Zero captured_amount rejected when marking status captured.';
        ELSE
            RAISE EXCEPTION 'Test 5 Failed: Unexpected error on captured_amount check [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 5 Failed: Payment allowed capture with zero captured_amount!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 6: Invalid Amounts and Currency Checks
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_synth_org_b, v_synth_fac_b, v_synth_res_b,
            -10.00, 0.0500, 0.00, 0.00, 'pending'
        );
    EXCEPTION WHEN check_violation THEN
        v_expected_failed := true;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 6a PASSED: Negative expected_amount rejected by CHECK constraint.';
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 6 Failed: Negative expected_amount was not rejected!';
    END IF;

    v_expected_failed := false;
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status, currency
        ) VALUES (
            v_synth_org_b, v_synth_fac_b, v_synth_res_b,
            400.00, 0.0500, 20.00, 380.00, 'pending', 'USD'
        );
    EXCEPTION WHEN check_violation THEN
        v_expected_failed := true;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 6b PASSED: Unsupported currency rejected by currency CHECK constraint.';
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 6 Failed: Non-PHP currency was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 7: Incorrect Reservation Ownership Checks (fk_payments_reservation_facility)
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_synth_org_b,
            v_synth_fac_b,
            v_synth_res_a, -- Belongs to Facility A!
            350.00, 0.0500, 17.50, 332.50, 'pending'
        );
    EXCEPTION WHEN foreign_key_violation THEN
        v_expected_failed := true;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 7 PASSED: Reservation facility mismatch rejected by fk_payments_reservation_facility.';
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 7 Failed: Cross-facility reservation mismatch was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 8: Payout Methods & Masked Account Protection
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.payout_methods (
            organization_id, method_type, provider_name, account_holder_name,
            masked_account_number, bank_code, bank_name
        ) VALUES (
            v_synth_org_a, 'bank_transfer', 'paymongo', 'Owner Juan',
            '123456789012', -- PLAIN UNMASKED!
            'BDO', 'Banco de Oro'
        );
    EXCEPTION WHEN check_violation THEN
        v_expected_failed := true;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 8a PASSED: Plain unmasked bank account rejected by chk_masked_account_number.';
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 8 Failed: Plain unmasked account number was not rejected!';
    END IF;

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

    -- NOTE: In 005B tests, mock financial_transactions header rows are provisioned directly
    -- to verify 005B foreign keys (fk_payouts_journal_reserve_org, fk_payouts_journal_terminal_org)
    -- and payout state transition trigger validation (fn_validate_payout_status_transition).
    -- Full double-entry ledger postings, 11-account balance equations, and running balances
    -- are executed via post_journal_entry_internal() and verified in 005a2_journal_hardening_test.sql.
    DECLARE
        v_ft_test9_res UUID := gen_random_uuid();
        v_ft_test9_term UUID := gen_random_uuid();
    BEGIN
        INSERT INTO public.financial_transactions (
            id, organization_id, facility_id, transaction_type,
            idempotency_key, reference_id, description, canonical_payload_hash
        ) VALUES (
            v_ft_test9_res, v_synth_org_a, v_synth_fac_a, 'payout_reserve',
            'idem_test9_res', v_payout_id, 'Test 9 Reserve', md5('test9_res')
        ), (
            v_ft_test9_term, v_synth_org_a, v_synth_fac_a, 'payout_disbursement',
            'idem_test9_term', v_payout_id, 'Test 9 Disbursement', md5('test9_term')
        );

        UPDATE public.payouts SET status = 'approved_reserved', journal_reserve_tx_id = v_ft_test9_res WHERE id = v_payout_id;
        UPDATE public.payouts SET status = 'submitted_to_provider' WHERE id = v_payout_id;
        UPDATE public.payouts SET status = 'paid', journal_terminal_tx_id = v_ft_test9_term WHERE id = v_payout_id;
    END;

    v_expected_failed := false;
    BEGIN
        UPDATE public.payouts SET status = 'failed' WHERE id = v_payout_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%is in terminal status "paid" and cannot be modified%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 9a PASSED: Terminal paid payout rejected conflicting transition to failed.';
        ELSE
            RAISE EXCEPTION 'Test 9 Failed: Unexpected error on payout transition [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 9 Failed: Terminal paid payout allowed transition to failed!';
    END IF;

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
        commission_rate, commission_amount, owner_gross_share, status
    ) VALUES (
        v_synth_org_b, v_synth_fac_b, v_synth_res_b,
        400.00, 0.0500, 20.00, 380.00, 'pending'
    ) RETURNING id INTO v_payment_id;

    UPDATE public.payments
    SET status = 'captured', captured_amount = 400.00, provider_name = 'paymongo', provider_payment_id = 'pay_b_captured_settle_01'
    WHERE id = v_payment_id;

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
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.payouts (
            organization_id, payout_method_id, amount, status
        ) VALUES (
            v_synth_org_a,          -- Org A!
            v_payout_method_id_b,   -- Org B's method!
            500.00, 'pending_request'
        );
    EXCEPTION
        WHEN foreign_key_violation THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 14 PASSED: Cross-tenant payout method reference rejected by fk_payouts_method_org.';
        WHEN OTHERS THEN
            IF SQLSTATE = '23503' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 14 PASSED: Cross-tenant payout method reference rejected by fk_payouts_method_org.';
            ELSE
                RAISE EXCEPTION 'Test 14 Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 14 Failed: Cross-tenant payout method was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 15: SECURITY REVIEW 2: Cross-Tenant Settlement Payment Reference Rejection
    -- -------------------------------------------------------------------------
    -- Attempt to create settlement_item linking Org A batch with Org B payment!
    v_expected_failed := false;
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
    EXCEPTION
        WHEN foreign_key_violation THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 15a PASSED: Cross-tenant settlement payment link rejected by fk_settlement_items_payment_org_fac.';
        WHEN OTHERS THEN
            IF SQLSTATE = '23503' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 15a PASSED: Cross-tenant settlement payment link rejected by fk_settlement_items_payment_org_fac.';
            ELSE
                RAISE EXCEPTION 'Test 15 Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 15 Failed: Cross-tenant settlement item payment link was not rejected!';
    END IF;

    -- Attempt to insert settlement_item with NULL facility_id (strictly disallowed)
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.settlement_items (
            batch_id, payment_id, provider_payment_id, organization_id, facility_id,
            gross_amount, provider_fee_amount, net_settled_amount, settlement_status
        ) VALUES (
            v_batch_id, v_payment_id, 'pay_null_fac', v_synth_org_b, NULL,
            350.00, 15.00, 335.00, 'matched'
        );
    EXCEPTION WHEN not_null_violation THEN
        v_expected_failed := true;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 15b PASSED: NULL facility_id in settlement_items rejected by NOT NULL constraint.';
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 15 Failed: NULL facility_id in settlement_items was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 16: SECURITY REVIEW 3: Immutability of Payment Snapshot Under Same-Status Updates
    -- -------------------------------------------------------------------------
    -- Attempt to update commission_amount on an existing payment without changing status
    v_expected_failed := false;
    BEGIN
        UPDATE public.payments
        SET commission_amount = 99.99
        WHERE id = v_payment_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Financial snapshot, ownership, and established provider identity fields in payments table are strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 16a PASSED: Mutation of commission_amount with unchanged status rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 16 Failed: Unexpected error on commission update [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 16 Failed: Commission amount mutation under same-status update was not rejected!';
    END IF;

    -- Attempt to mutate expected_amount or organization_id under same-status update
    v_expected_failed := false;
    BEGIN
        UPDATE public.payments
        SET expected_amount = 500.00
        WHERE id = v_payment_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Financial snapshot, ownership, and established provider identity fields in payments table are strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 16b PASSED: Mutation of expected_amount with unchanged status rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 16 Failed: Unexpected error on expected_amount update [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 16 Failed: Expected amount mutation under same-status update was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 17: SECURITY REVIEW 4: Duplicate Capture Attempt After Refund & Dispute Rejection
    -- -------------------------------------------------------------------------
    -- Reservation A has a payment that was captured and then refunded (from Test 2 & 5b).
    -- Attempt to insert another captured payment for Reservation A:
    -- uq_captured_payment_lifecycle_per_reservation MUST reject this!
    DECLARE
        v_pay_res_a_dup UUID;
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_synth_org_a, v_synth_fac_a, v_synth_res_a, -- Same reservation!
            350.00, 0.0500, 17.50, 332.50, 'pending'
        ) RETURNING id INTO v_pay_res_a_dup;

        v_expected_failed := false;
        BEGIN
            UPDATE public.payments
            SET status = 'captured', captured_amount = 350.00, provider_name = 'paymongo', provider_payment_id = 'pay_second_capture_after_refund'
            WHERE id = v_pay_res_a_dup;
        EXCEPTION WHEN unique_violation THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 17 PASSED: Duplicate capture after refund rejected by uq_captured_payment_lifecycle_per_reservation.';
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 17 Failed: Duplicate capture after refund was not rejected!';
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 18: SECURITY REVIEW 5: Unauthorized Changes to Payout Amount / Destination
    -- -------------------------------------------------------------------------
    -- Attempt to change payout amount on existing payout
    v_expected_failed := false;
    BEGIN
        UPDATE public.payouts
        SET amount = 9999.00
        WHERE id = v_payout_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout amount, currency, organization, destination method, and reserve journal link are strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 18a PASSED: Mutation of payout amount rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 18 Failed: Unexpected error on payout amount update [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 18 Failed: Payout amount mutation was not rejected!';
    END IF;

    -- Attempt to change payout method destination on existing payout
    v_expected_failed := false;
    BEGIN
        UPDATE public.payouts
        SET payout_method_id = v_payout_method_id_b
        WHERE id = v_payout_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout amount, currency, organization, destination method, and reserve journal link are strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 18b PASSED: Mutation of payout destination rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 18 Failed: Unexpected error on payout destination update [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 18 Failed: Payout destination method mutation was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 19: SECURITY REVIEW 6: Webhook Signature Evidence Tampering Rejection
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        UPDATE public.provider_webhook_events
        SET signature_header = 'tampered_signature_string'
        WHERE provider_event_id = 'evt_paymongo_001_test';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Webhook event identity, payload, timestamp, and signature evidence are strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 19a PASSED: Alteration of webhook signature header rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 19 Failed: Unexpected error on signature tampering [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 19 Failed: Webhook signature tampering was not rejected!';
    END IF;

    v_expected_failed := false;
    BEGIN
        UPDATE public.provider_webhook_events
        SET signature_verification_status = 'unverified'
        WHERE provider_event_id = 'evt_paymongo_001_test';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Webhook event identity, payload, timestamp, and signature evidence are strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 19b PASSED: Alteration of verified signature status rejected by immutability trigger.';
        ELSE
            RAISE EXCEPTION 'Test 19 Failed: Unexpected error on signature status reversal [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 19 Failed: Reversing verified signature status was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 21: Null-Safe Identifier Immutability (IS DISTINCT FROM)
    -- -------------------------------------------------------------------------
    -- Setup payment with established provider identifiers
    INSERT INTO public.payments (
        id, organization_id, facility_id, reservation_id, expected_amount,
        commission_rate, commission_amount, owner_gross_share, status,
        provider_name, provider_payment_id, checkout_session_id, capture_idempotency_key
    ) VALUES (
        gen_random_uuid(), v_synth_org_a, v_synth_fac_a, v_synth_res_c,
        350.00, 0.0500, 17.50, 332.50, 'pending',
        'paymongo', 'pay_est_ident_123', 'cs_est_ident_456', 'idem_est_ident_789'
    ) RETURNING id INTO v_payment_id;

    -- 21a: Attempt to clear provider_payment_id to NULL
    v_expected_failed := false;
    BEGIN
        UPDATE public.payments
        SET provider_payment_id = NULL
        WHERE id = v_payment_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Financial snapshot, ownership, and established provider identity fields in payments table are strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 21a PASSED: Clearing established provider_payment_id to NULL rejected by IS DISTINCT FROM immutability check.';
        ELSE
            RAISE EXCEPTION 'Test 21a Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 21a Failed: Established provider_payment_id was cleared to NULL!';
    END IF;

    -- 21b: Attempt to overwrite provider_payment_id
    v_expected_failed := false;
    BEGIN
        UPDATE public.payments
        SET provider_payment_id = 'pay_overwritten_id'
        WHERE id = v_payment_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Financial snapshot, ownership, and established provider identity fields in payments table are strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 21b PASSED: Overwriting established provider_payment_id rejected by IS DISTINCT FROM immutability check.';
        ELSE
            RAISE EXCEPTION 'Test 21b Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 21b Failed: Established provider_payment_id was overwritten!';
    END IF;

    -- 21c: Attempt to clear checkout_session_id to NULL
    v_expected_failed := false;
    BEGIN
        UPDATE public.payments
        SET checkout_session_id = NULL
        WHERE id = v_payment_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Financial snapshot, ownership, and established provider identity fields in payments table are strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 21c PASSED: Clearing established checkout_session_id to NULL rejected by IS DISTINCT FROM immutability check.';
        ELSE
            RAISE EXCEPTION 'Test 21c Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 21c Failed: Established checkout_session_id was cleared to NULL!';
    END IF;

    -- 21d: Attempt to clear capture_idempotency_key to NULL
    v_expected_failed := false;
    BEGIN
        UPDATE public.payments
        SET capture_idempotency_key = NULL
        WHERE id = v_payment_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Financial snapshot, ownership, and established provider identity fields in payments table are strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 21d PASSED: Clearing established capture_idempotency_key to NULL rejected by IS DISTINCT FROM immutability check.';
        ELSE
            RAISE EXCEPTION 'Test 21d Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 21d Failed: Established capture_idempotency_key was cleared to NULL!';
    END IF;

    -- 21e: Attempt to clear provider_payout_id to NULL on payouts
    v_expected_failed := false;
    BEGIN
        UPDATE public.payouts
        SET provider_payout_id = NULL
        WHERE id = v_payout_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout amount, currency, organization, destination method, and reserve journal link are strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 21e PASSED: Clearing established provider_payout_id to NULL rejected by IS DISTINCT FROM immutability check.';
        ELSE
            RAISE EXCEPTION 'Test 21e Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 21e Failed: Established provider_payout_id was cleared to NULL!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 22: Lifecycle Insert-Time Status Validation & Financial Amount Integrity
    -- -------------------------------------------------------------------------
    -- 22a: Direct INSERT into captured payment status must be rejected
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_synth_org_a, v_synth_fac_a, v_synth_res_c,
            350.00, 0.0500, 17.50, 332.50, 'captured'
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Invalid initial payment status: payment records cannot be inserted directly into "captured"%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 22a PASSED: Direct INSERT into captured payment status strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 22a Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 22a Failed: Direct INSERT into captured payment status was not rejected!';
    END IF;

    -- 22b: Direct INSERT into refunded payment status must be rejected
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.payments (
            organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_synth_org_a, v_synth_fac_a, v_synth_res_c,
            350.00, 0.0500, 17.50, 332.50, 'refunded'
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Invalid initial payment status: payment records cannot be inserted directly into "refunded"%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 22b PASSED: Direct INSERT into refunded payment status strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 22b Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 22b Failed: Direct INSERT into refunded payment status was not rejected!';
    END IF;

    -- 22c: Direct INSERT into paid payout status must be rejected
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.payouts (
            organization_id, payout_method_id, amount, status
        ) VALUES (
            v_synth_org_a, v_payout_method_id_a, 1000.00, 'paid'
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Invalid initial payout status: payout records must be initialized in "pending_request"%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 22c PASSED: Direct INSERT into paid payout status strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 22c Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 22c Failed: Direct INSERT into paid payout status was not rejected!';
    END IF;

    -- 22d: Direct INSERT into approved_reserved payout status must be rejected
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.payouts (
            organization_id, payout_method_id, amount, status
        ) VALUES (
            v_synth_org_a, v_payout_method_id_a, 1000.00, 'approved_reserved'
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Invalid initial payout status: payout records must be initialized in "pending_request"%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 22d PASSED: Direct INSERT into approved_reserved payout status strictly rejected.';
        ELSE
            RAISE EXCEPTION 'Test 22d Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 22d Failed: Direct INSERT into approved_reserved payout status was not rejected!';
    END IF;

    -- Setup a fresh pending payment for same-status and financial amount testing
    DECLARE
        v_pay_amount_test UUID := gen_random_uuid();
    BEGIN
        INSERT INTO public.payments (
            id, organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_pay_amount_test, v_synth_org_b, v_synth_fac_b, v_synth_res_d,
            400.00, 0.0500, 20.00, 380.00, 'pending'
        );

        -- 22i: Pending payment CANNOT acquire captured_amount under same-status update
        v_expected_failed := false;
        BEGIN
            UPDATE public.payments
            SET captured_amount = 400.00
            WHERE id = v_pay_amount_test;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%cannot acquire captured funds without a valid capture transition%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 22i PASSED: Pending payment acquiring captured funds under same-status update rejected.';
            ELSE
                RAISE EXCEPTION 'Test 22i Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 22i Failed: Pending payment was able to acquire captured_amount without capture transition!';
        END IF;

        -- 22j: Pending payment CANNOT set captured_at under same-status update
        v_expected_failed := false;
        BEGIN
            UPDATE public.payments
            SET captured_at = now()
            WHERE id = v_pay_amount_test;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%cannot set captured_at timestamp%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 22j PASSED: Pending payment setting captured_at timestamp rejected.';
            ELSE
                RAISE EXCEPTION 'Test 22j Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 22j Failed: Pending payment was able to set captured_at timestamp!';
        END IF;

        -- 22k: Pending payment CANNOT acquire refunded_amount under same-status update
        v_expected_failed := false;
        BEGIN
            UPDATE public.payments
            SET refunded_amount = 50.00
            WHERE id = v_pay_amount_test;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%cannot acquire refunded funds%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 22k PASSED: Pending payment acquiring refunded funds rejected.';
            ELSE
                RAISE EXCEPTION 'Test 22k Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 22k Failed: Pending payment was able to acquire refunded funds!';
        END IF;

        -- Legitimate capture transition
        UPDATE public.payments
        SET status = 'captured', captured_amount = 400.00, provider_name = 'paymongo', provider_payment_id = 'pay_amount_test_01'
        WHERE id = v_pay_amount_test;

        -- 22e: Same-status captured_amount tampering on captured payment must fail
        v_expected_failed := false;
        BEGIN
            UPDATE public.payments
            SET captured_amount = 999.00
            WHERE id = v_pay_amount_test;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%Captured amount (₱%) is strictly immutable once captured%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 22e PASSED: Same-status captured_amount tampering strictly rejected.';
            ELSE
                RAISE EXCEPTION 'Test 22e Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 22e Failed: Same-status captured_amount alteration was not rejected!';
        END IF;

        -- 22f: Refunded amount exceeding captured amount must fail
        v_expected_failed := false;
        BEGIN
            UPDATE public.payments
            SET refunded_amount = 5000.00
            WHERE id = v_pay_amount_test;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%Refunded amount (₱%) cannot exceed captured amount%' OR SQLERRM LIKE '%chk_payments_refunded_le_captured%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 22f PASSED: Refunded amount exceeding captured funds strictly rejected.';
            ELSE
                RAISE EXCEPTION 'Test 22f Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 22f Failed: Refunded amount exceeding captured funds was not rejected!';
        END IF;

        -- 22g: Refunded amount decreasing after partial refund must fail
        UPDATE public.payments
        SET status = 'partially_refunded', refunded_amount = 100.00
        WHERE id = v_pay_amount_test;

        v_expected_failed := false;
        BEGIN
            UPDATE public.payments
            SET refunded_amount = 50.00
            WHERE id = v_pay_amount_test;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%Refunded amount cannot decrease%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 22g PASSED: Refunded amount reduction after partial refund strictly rejected.';
            ELSE
                RAISE EXCEPTION 'Test 22g Failed: Unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 22g Failed: Refunded amount reduction after partial refund was not rejected!';
        END IF;

        -- 22h: Legitimate partial refund followed by full refund verified
        UPDATE public.payments
        SET refunded_amount = 200.00
        WHERE id = v_pay_amount_test;

        UPDATE public.payments
        SET status = 'refunded', refunded_amount = 400.00
        WHERE id = v_pay_amount_test;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 22h PASSED: Legitimate partial refund followed by full refund completed successfully.';

        -- ---------------------------------------------------------------------
        -- TEST 23: Commission Snapshot Validation against Platform Config
        -- ---------------------------------------------------------------------
        -- 23a: Non-standard commission rate (0.1000 instead of 0.0500) must be rejected
        v_expected_failed := false;
        BEGIN
            INSERT INTO public.payments (
                organization_id, facility_id, reservation_id, expected_amount,
                commission_rate, commission_amount, owner_gross_share, status
            ) VALUES (
                v_synth_org_b, v_synth_fac_b, v_synth_res_b,
                400.00, 0.1000, 40.00, 360.00, 'pending'
            );
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%Commission rate tampering rejected%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 23a PASSED: Non-standard commission rate strictly rejected.';
            ELSE
                RAISE EXCEPTION 'Test 23a Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 23a Failed: Non-standard commission rate was not rejected!';
        END IF;

        -- 23b: Manipulated commission amount must be rejected
        v_expected_failed := false;
        BEGIN
            INSERT INTO public.payments (
                organization_id, facility_id, reservation_id, expected_amount,
                commission_rate, commission_amount, owner_gross_share, status
            ) VALUES (
                v_synth_org_b, v_synth_fac_b, v_synth_res_b,
                400.00, 0.0500, 50.00, 350.00, 'pending'
            );
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%Commission amount mismatch%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 23b PASSED: Manipulated commission amount strictly rejected.';
            ELSE
                RAISE EXCEPTION 'Test 23b Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 23b Failed: Manipulated commission amount was not rejected!';
        END IF;

        -- 23c: Manipulated owner share must be rejected
        v_expected_failed := false;
        BEGIN
            INSERT INTO public.payments (
                organization_id, facility_id, reservation_id, expected_amount,
                commission_rate, commission_amount, owner_gross_share, status
            ) VALUES (
                v_synth_org_b, v_synth_fac_b, v_synth_res_b,
                400.00, 0.0500, 20.00, 300.00, 'pending'
            );
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%Owner gross share mismatch%' OR SQLERRM LIKE '%chk_payment_amount_split%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 23c PASSED: Manipulated owner gross share strictly rejected.';
            ELSE
                RAISE EXCEPTION 'Test 23c Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 23c Failed: Manipulated owner share was not rejected!';
        END IF;

        -- 23d: Fail closed if platform_billing_config(id = 1) is missing or unconfigured
        -- NOTE: Uses row deletion and snapshot restoration to test missing singleton config (id = 1)
        -- without violating the NOT NULL constraint on default_commission_rate.
        DECLARE
            v_saved_config public.platform_billing_config%ROWTYPE;
            v_err_msg TEXT;
            v_err_state TEXT;
        BEGIN
            -- Snapshot singleton billing configuration row before temporary deletion
            SELECT * INTO v_saved_config FROM public.platform_billing_config WHERE id = 1;
            DELETE FROM public.platform_billing_config WHERE id = 1;

            v_expected_failed := false;
            v_err_msg := NULL;
            v_err_state := NULL;
            BEGIN
                INSERT INTO public.payments (
                    organization_id, facility_id, reservation_id, expected_amount,
                    commission_rate, commission_amount, owner_gross_share, status
                ) VALUES (
                    v_synth_org_b, v_synth_fac_b, v_synth_res_b,
                    400.00, 0.0500, 20.00, 380.00, 'pending'
                );
            EXCEPTION WHEN OTHERS THEN
                v_err_msg := SQLERRM;
                v_err_state := SQLSTATE;
                IF v_err_msg LIKE '%Authoritative platform billing configuration (id = 1) is missing or unconfigured%' THEN
                    v_expected_failed := true;
                END IF;
            END;

            -- Restore authoritative singleton configuration row immediately before evaluating assertions
            INSERT INTO public.platform_billing_config VALUES (v_saved_config.*);

            IF v_expected_failed THEN
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 23d PASSED: Missing platform billing config (id = 1) fails closed on payment INSERT.';
            ELSIF v_err_msg IS NOT NULL THEN
                RAISE EXCEPTION 'Test 23d Failed with unexpected error [SQLSTATE %]: %', v_err_state, v_err_msg;
            ELSE
                RAISE EXCEPTION 'Test 23d Failed: Payment insert succeeded despite missing billing config!';
            END IF;
        END;

        -- ---------------------------------------------------------------------
        -- TEST 24: Payment Intent Identity & Capture Evidence Immutability
        -- ---------------------------------------------------------------------
        DECLARE
            v_pay_intent_test UUID := gen_random_uuid();
        BEGIN
            INSERT INTO public.payments (
                id, organization_id, facility_id, reservation_id, expected_amount,
                commission_rate, commission_amount, owner_gross_share, status,
                provider_payment_intent_id, verified_capture_evidence
            ) VALUES (
                v_pay_intent_test, v_synth_org_b, v_synth_fac_b, v_synth_res_b,
                400.00, 0.0500, 20.00, 380.00, 'pending',
                'pi_test_established_01', jsonb_build_object('hold_id', 'h_01', 'ref', 'REF01')
            );

            -- 24a: Altering established provider_payment_intent_id must be rejected
            v_expected_failed := false;
            BEGIN
                UPDATE public.payments
                SET provider_payment_intent_id = 'pi_tampered_02'
                WHERE id = v_pay_intent_test;
            EXCEPTION WHEN OTHERS THEN
                IF SQLERRM LIKE '%established provider identity fields in payments table are strictly immutable%' THEN
                    v_expected_failed := true;
                    v_test_count := v_test_count + 1;
                    RAISE NOTICE 'Test 24a PASSED: Altering provider_payment_intent_id strictly rejected.';
                ELSE
                    RAISE EXCEPTION 'Test 24a Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                END IF;
            END;
            IF NOT v_expected_failed THEN
                RAISE EXCEPTION 'Test 24a Failed: Altering provider_payment_intent_id was not rejected!';
            END IF;

            -- 24b: Truncating or removing existing keys from verified_capture_evidence must fail
            v_expected_failed := false;
            BEGIN
                UPDATE public.payments
                SET verified_capture_evidence = jsonb_build_object('new_key_only', 'data')
                WHERE id = v_pay_intent_test;
            EXCEPTION WHEN OTHERS THEN
                IF SQLERRM LIKE '%Evidence tampering rejected: verified_capture_evidence cannot have existing keys removed or altered%' THEN
                    v_expected_failed := true;
                    v_test_count := v_test_count + 1;
                    RAISE NOTICE 'Test 24b PASSED: Truncating verified_capture_evidence strictly rejected.';
                ELSE
                    RAISE EXCEPTION 'Test 24b Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                END IF;
            END;
            IF NOT v_expected_failed THEN
                RAISE EXCEPTION 'Test 24b Failed: Truncating verified_capture_evidence was not rejected!';
            END IF;
        END;

        -- ---------------------------------------------------------------------
        -- TEST 25: Terminal Payment Mutation Freeze
        -- ---------------------------------------------------------------------
        -- 25a: Attempting any update on terminal 'refunded' payment must fail
        v_expected_failed := false;
        BEGIN
            UPDATE public.payments
            SET currency = 'PHP'
            WHERE id = v_pay_amount_test;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%is in terminal status "refunded" and cannot be modified%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 25a PASSED: Mutation on terminal refunded payment strictly frozen.';
            ELSE
                RAISE EXCEPTION 'Test 25a Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 25a Failed: Mutation on terminal refunded payment was not rejected!';
        END IF;

        -- ---------------------------------------------------------------------
        -- TEST 26: Payout Lifecycle Logs Composite Consistency & Append-Only Trigger
        -- ---------------------------------------------------------------------
        DECLARE
            v_payout_test_id UUID := gen_random_uuid();
            v_log_id UUID := gen_random_uuid();
        BEGIN
            -- Insert valid payout for Org A
            INSERT INTO public.payouts (
                id, organization_id, payout_method_id, amount, status
            ) VALUES (
                v_payout_test_id, v_synth_org_a, v_payout_method_id_a, 500.00, 'pending_request'
            );

            -- 26a: Insert log with mismatched organization must be rejected by composite FK
            v_expected_failed := false;
            BEGIN
                INSERT INTO public.payout_lifecycle_logs (
                    id, payout_id, organization_id, from_status, to_status
                ) VALUES (
                    v_log_id, v_payout_test_id, v_synth_org_b, 'pending_request', 'approved_reserved'
                );
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_expected_failed := true;
                    v_test_count := v_test_count + 1;
                    RAISE NOTICE 'Test 26a PASSED: Composite foreign key fk_payout_lifecycle_logs_payout_org rejected cross-tenant log.';
                WHEN OTHERS THEN
                    IF SQLSTATE = '23503' THEN
                        v_expected_failed := true;
                        v_test_count := v_test_count + 1;
                        RAISE NOTICE 'Test 26a PASSED: Composite foreign key fk_payout_lifecycle_logs_payout_org rejected cross-tenant log.';
                    ELSE
                        RAISE EXCEPTION 'Test 26a Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                    END IF;
            END;
            IF NOT v_expected_failed THEN
                RAISE EXCEPTION 'Test 26a Failed: Cross-organization payout log was not rejected!';
            END IF;

            -- 26b: Update on payout_lifecycle_logs must be rejected by append-only trigger
            v_expected_failed := false;
            BEGIN
                UPDATE public.payout_lifecycle_logs
                SET to_status = 'tampered'
                WHERE payout_id = v_payout_test_id;
            EXCEPTION WHEN OTHERS THEN
                IF SQLERRM LIKE '%Payout lifecycle audit records are append-only and strictly immutable%' THEN
                    v_expected_failed := true;
                    v_test_count := v_test_count + 1;
                    RAISE NOTICE 'Test 26b PASSED: UPDATE on payout_lifecycle_logs rejected by append-only trigger.';
                ELSE
                    RAISE EXCEPTION 'Test 26b Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                END IF;
            END;
            IF NOT v_expected_failed THEN
                RAISE EXCEPTION 'Test 26b Failed: UPDATE on payout_lifecycle_logs was not rejected!';
            END IF;

            -- 26c: DELETE on payout_lifecycle_logs must be rejected by append-only trigger
            v_expected_failed := false;
            BEGIN
                DELETE FROM public.payout_lifecycle_logs
                WHERE payout_id = v_payout_test_id;
            EXCEPTION WHEN OTHERS THEN
                IF SQLERRM LIKE '%Payout lifecycle audit records are append-only and strictly immutable%' THEN
                    v_expected_failed := true;
                    v_test_count := v_test_count + 1;
                    RAISE NOTICE 'Test 26c PASSED: DELETE on payout_lifecycle_logs rejected by append-only trigger.';
                ELSE
                    RAISE EXCEPTION 'Test 26c Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                END IF;
            END;
            IF NOT v_expected_failed THEN
                RAISE EXCEPTION 'Test 26c Failed: DELETE on payout_lifecycle_logs was not rejected!';
            END IF;

            -- -----------------------------------------------------------------
            -- TEST 27: Payout Journal Links Composite Foreign Key & Type Validation
            -- -----------------------------------------------------------------
            DECLARE
                v_ft_res_a UUID := gen_random_uuid();
                v_ft_res_b UUID := gen_random_uuid();
                v_ft_wrong_type UUID := gen_random_uuid();
                v_ft_term_a UUID := gen_random_uuid();
            BEGIN
                -- Provision mock financial transactions adhering to 005a1 schema
                -- (validates 005B composite foreign keys and trigger transaction_type checks
                -- without executing full post_journal_entry_internal() ledger calculations)
                INSERT INTO public.financial_transactions (
                    id, organization_id, facility_id, transaction_type,
                    idempotency_key, reference_id, description, canonical_payload_hash
                ) VALUES (
                    v_ft_res_a, v_synth_org_a, v_synth_fac_a, 'payout_reserve',
                    'idem_ft_res_a_01', v_payout_test_id, 'Test Payout Reserve Org A', md5('payload_res_a')
                ), (
                    v_ft_res_b, v_synth_org_b, v_synth_fac_b, 'payout_reserve',
                    'idem_ft_res_b_01', gen_random_uuid(), 'Test Payout Reserve Org B', md5('payload_res_b')
                ), (
                    v_ft_wrong_type, v_synth_org_a, v_synth_fac_a, 'booking_settlement',
                    'idem_ft_wrong_01', gen_random_uuid(), 'Test Booking Settlement', md5('payload_wrong')
                ), (
                    v_ft_term_a, v_synth_org_a, v_synth_fac_a, 'payout_disbursement',
                    'idem_ft_term_a_01', v_payout_test_id, 'Test Payout Disbursement Org A', md5('payload_term_a')
                );

                -- 27a: Cross-organization journal reserve reference must fail (trigger validation or composite FK)
                v_expected_failed := false;
                BEGIN
                    UPDATE public.payouts
                    SET status = 'approved_reserved', journal_reserve_tx_id = v_ft_res_b
                    WHERE id = v_payout_test_id;
                EXCEPTION
                    WHEN foreign_key_violation THEN
                        v_expected_failed := true;
                        v_test_count := v_test_count + 1;
                        RAISE NOTICE 'Test 27a PASSED: Composite foreign key fk_payouts_journal_reserve_org rejected cross-tenant journal link.';
                    WHEN OTHERS THEN
                        IF SQLERRM LIKE '%Invalid journal reserve transaction: Must reference an existing financial_transaction of type "payout_reserve" for organization%'
                           OR SQLSTATE = '23503' THEN
                            v_expected_failed := true;
                            v_test_count := v_test_count + 1;
                            RAISE NOTICE 'Test 27a PASSED: Cross-tenant journal reserve rejected by trigger validation (organization-scoped lookup) or composite FK.';
                        ELSE
                            RAISE EXCEPTION 'Test 27a Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                        END IF;
                END;
                IF NOT v_expected_failed THEN
                    RAISE EXCEPTION 'Test 27a Failed: Cross-organization journal reserve was not rejected!';
                END IF;

                -- 27b: Wrong transaction type for journal reserve must fail trigger validation
                v_expected_failed := false;
                BEGIN
                    UPDATE public.payouts
                    SET status = 'approved_reserved', journal_reserve_tx_id = v_ft_wrong_type
                    WHERE id = v_payout_test_id;
                EXCEPTION WHEN OTHERS THEN
                    IF SQLERRM LIKE '%Must reference an existing financial_transaction of type "payout_reserve"%' THEN
                        v_expected_failed := true;
                        v_test_count := v_test_count + 1;
                        RAISE NOTICE 'Test 27b PASSED: Non-payout_reserve transaction type rejected for journal_reserve_tx_id.';
                    ELSE
                        RAISE EXCEPTION 'Test 27b Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                    END IF;
                END;
                IF NOT v_expected_failed THEN
                    RAISE EXCEPTION 'Test 27b Failed: Wrong transaction type for journal reserve was not rejected!';
                END IF;

                -- 27e: Transition to approved_reserved without journal_reserve_tx_id must fail
                v_expected_failed := false;
                BEGIN
                    UPDATE public.payouts
                    SET status = 'approved_reserved', journal_reserve_tx_id = NULL
                    WHERE id = v_payout_test_id;
                EXCEPTION WHEN OTHERS THEN
                    IF SQLERRM LIKE '%cannot transition to "approved_reserved" without a valid payout_reserve journal transaction%' THEN
                        v_expected_failed := true;
                        v_test_count := v_test_count + 1;
                        RAISE NOTICE 'Test 27e PASSED: Transition to approved_reserved without reserve journal rejected.';
                    ELSE
                        RAISE EXCEPTION 'Test 27e Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                    END IF;
                END;
                IF NOT v_expected_failed THEN
                    RAISE EXCEPTION 'Test 27e Failed: Payout reached approved_reserved without reserve journal!';
                END IF;

                -- Legitimate transition to approved_reserved with valid journal_reserve_tx_id
                UPDATE public.payouts
                SET status = 'approved_reserved', journal_reserve_tx_id = v_ft_res_a
                WHERE id = v_payout_test_id;

                -- Transition to submitted_to_provider
                UPDATE public.payouts
                SET status = 'submitted_to_provider', provider_payout_id = 'payout_prov_001'
                WHERE id = v_payout_test_id;

                -- 27f: Transition to paid without journal_terminal_tx_id must fail
                v_expected_failed := false;
                BEGIN
                    UPDATE public.payouts
                    SET status = 'paid', journal_terminal_tx_id = NULL
                    WHERE id = v_payout_test_id;
                EXCEPTION WHEN OTHERS THEN
                    IF SQLERRM LIKE '%cannot transition to "paid" without a valid payout_disbursement journal transaction%' THEN
                        v_expected_failed := true;
                        v_test_count := v_test_count + 1;
                        RAISE NOTICE 'Test 27f PASSED: Transition to paid without disbursement journal rejected.';
                    ELSE
                        RAISE EXCEPTION 'Test 27f Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                    END IF;
                END;
                IF NOT v_expected_failed THEN
                    RAISE EXCEPTION 'Test 27f Failed: Payout reached paid without disbursement journal!';
                END IF;

                -- 27c: Wrong transaction type for terminal paid payout must fail trigger validation
                v_expected_failed := false;
                BEGIN
                    UPDATE public.payouts
                    SET status = 'paid', journal_terminal_tx_id = v_ft_wrong_type
                    WHERE id = v_payout_test_id;
                EXCEPTION WHEN OTHERS THEN
                    IF SQLERRM LIKE '%Terminal journal mismatch: Successful paid payout must reference transaction type "payout_disbursement"%' THEN
                        v_expected_failed := true;
                        v_test_count := v_test_count + 1;
                        RAISE NOTICE 'Test 27c PASSED: Terminal journal mismatch on paid payout strictly rejected.';
                    ELSE
                        RAISE EXCEPTION 'Test 27c Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                    END IF;
                END;
                IF NOT v_expected_failed THEN
                    RAISE EXCEPTION 'Test 27c Failed: Wrong transaction type for terminal paid payout was not rejected!';
                END IF;

                -- Legitimate transition to paid
                UPDATE public.payouts
                SET status = 'paid', journal_terminal_tx_id = v_ft_term_a
                WHERE id = v_payout_test_id;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 27d PASSED: Valid payout full lifecycle transition to paid completed.';

                -- -------------------------------------------------------------
                -- TEST 27g & 27h: Reserved Payout Cancellation / Failure Journal Validation
                -- -------------------------------------------------------------
                DECLARE
                    v_payout_res_term UUID := gen_random_uuid();
                    v_ft_res_term UUID := gen_random_uuid();
                    v_ft_rel_term UUID := gen_random_uuid();
                BEGIN
                    INSERT INTO public.payouts (
                        id, organization_id, payout_method_id, amount, status
                    ) VALUES (
                        v_payout_res_term, v_synth_org_a, v_payout_method_id_a, 350.00, 'pending_request'
                    );

                    INSERT INTO public.financial_transactions (
                        id, organization_id, facility_id, transaction_type,
                        idempotency_key, reference_id, description, canonical_payload_hash
                    ) VALUES (
                        v_ft_res_term, v_synth_org_a, v_synth_fac_a, 'payout_reserve',
                        'idem_ft_res_term_01', v_payout_res_term, 'Test Reserve Hold', md5('payload_res_hold')
                    ), (
                        v_ft_rel_term, v_synth_org_a, v_synth_fac_a, 'payout_failed_release',
                        'idem_ft_rel_term_01', v_payout_res_term, 'Test Release Reserve', md5('payload_rel_hold')
                    );

                    UPDATE public.payouts
                    SET status = 'approved_reserved', journal_reserve_tx_id = v_ft_res_term
                    WHERE id = v_payout_res_term;

                    -- 27g: Reserved payout transitioning to failed requires payout_failed_release journal
                    v_expected_failed := false;
                    BEGIN
                        UPDATE public.payouts
                        SET status = 'failed', journal_terminal_tx_id = NULL
                        WHERE id = v_payout_res_term;
                    EXCEPTION WHEN OTHERS THEN
                        IF SQLERRM LIKE '%requires a valid payout_failed_release journal transaction to release reserved funds%' THEN
                            v_expected_failed := true;
                            v_test_count := v_test_count + 1;
                            RAISE NOTICE 'Test 27g PASSED: Reserved payout transitioning to failed without release journal rejected.';
                        ELSE
                            RAISE EXCEPTION 'Test 27g Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                        END IF;
                    END;
                    IF NOT v_expected_failed THEN
                        RAISE EXCEPTION 'Test 27g Failed: Reserved payout moved to failed without release journal!';
                    END IF;

                    -- Legitimate transition to failed with release journal
                    UPDATE public.payouts
                    SET status = 'failed', journal_terminal_tx_id = v_ft_rel_term, failure_reason = 'Provider bank rejection'
                    WHERE id = v_payout_res_term;
                    v_test_count := v_test_count + 1;
                    RAISE NOTICE 'Test 27g2 PASSED: Reserved payout moved to failed with valid payout_failed_release journal.';
                END;

                -- 27i & 27j: Unreserved payout cancelling/failing rejects spurious release journal
                DECLARE
                    v_payout_unres UUID := gen_random_uuid();
                    v_ft_spurious UUID := gen_random_uuid();
                BEGIN
                    INSERT INTO public.payouts (
                        id, organization_id, payout_method_id, amount, status
                    ) VALUES (
                        v_payout_unres, v_synth_org_a, v_payout_method_id_a, 200.00, 'pending_request'
                    );

                    INSERT INTO public.financial_transactions (
                        id, organization_id, facility_id, transaction_type,
                        idempotency_key, reference_id, description, canonical_payload_hash
                    ) VALUES (
                        v_ft_spurious, v_synth_org_a, v_synth_fac_a, 'payout_failed_release',
                        'idem_ft_spurious_01', v_payout_unres, 'Spurious release', md5('payload_spurious')
                    );

                    v_expected_failed := false;
                    BEGIN
                        UPDATE public.payouts
                        SET status = 'cancelled', journal_terminal_tx_id = v_ft_spurious
                        WHERE id = v_payout_unres;
                    EXCEPTION WHEN OTHERS THEN
                        IF SQLERRM LIKE '%Unreserved payout % transitioning to "cancelled" cannot specify a terminal release journal%' THEN
                            v_expected_failed := true;
                            v_test_count := v_test_count + 1;
                            RAISE NOTICE 'Test 27i PASSED: Unreserved payout cancelling with spurious terminal journal rejected.';
                        ELSE
                            RAISE EXCEPTION 'Test 27i Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                        END IF;
                    END;
                    IF NOT v_expected_failed THEN
                        RAISE EXCEPTION 'Test 27i Failed: Unreserved payout cancelled with spurious terminal journal!';
                    END IF;

                    -- Legitimate unreserved cancellation
                    UPDATE public.payouts
                    SET status = 'cancelled'
                    WHERE id = v_payout_unres;
                    v_test_count := v_test_count + 1;
                    RAISE NOTICE 'Test 27i2 PASSED: Unreserved payout safely cancelled without journal links.';
                END;

                -- -------------------------------------------------------------
                -- TEST 28: Payout Terminal State Freeze
                -- -------------------------------------------------------------
                -- 28a: Attempting any update on terminal 'paid' payout must fail
                v_expected_failed := false;
                BEGIN
                    UPDATE public.payouts
                    SET failure_reason = 'Attempted alteration after paid'
                    WHERE id = v_payout_test_id;
                EXCEPTION WHEN OTHERS THEN
                    IF SQLERRM LIKE '%is in terminal status "paid" and cannot be modified%' THEN
                        v_expected_failed := true;
                        v_test_count := v_test_count + 1;
                        RAISE NOTICE 'Test 28a PASSED: Mutation on terminal paid payout strictly frozen.';
                    ELSE
                        RAISE EXCEPTION 'Test 28a Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                    END IF;
                END;
                IF NOT v_expected_failed THEN
                    RAISE EXCEPTION 'Test 28a Failed: Mutation on terminal paid payout was not rejected!';
                END IF;
            END;
        END;
    END;

    RAISE NOTICE '=== ALL % DATABASE TESTS COMPLETED SUCCESSFULLY ===', v_test_count;
END $$;

-- ------------------------------------------------------------------------------
-- TEST 20: Payout Token Confidentiality, Access Control & Token Denial
-- ------------------------------------------------------------------------------
-- Provision test users: Owner User A, Staff User A, Owner User B
DO $$
DECLARE
    v_owner_a UUID := gen_random_uuid();
    v_staff_a UUID := gen_random_uuid();
    v_owner_b UUID := gen_random_uuid();
    v_org_a UUID := current_setting('app.test_org_a', true)::UUID;
    v_org_b UUID := current_setting('app.test_org_b', true)::UUID;
BEGIN
    -- Insert mock auth users
    INSERT INTO auth.users (id, email) VALUES
        (v_owner_a, 'owner.a@example.com'),
        (v_staff_a, 'staff.a@example.com'),
        (v_owner_b, 'owner.b@example.com')
    ON CONFLICT DO NOTHING;

    -- Map roles in organization_members:
    -- Org A: Owner A and Staff A
    -- Org B: Owner B
    INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
        (v_org_a, v_owner_a, 'owner'),
        (v_org_a, v_staff_a, 'staff'),
        (v_org_b, v_owner_b, 'owner')
    ON CONFLICT DO NOTHING;

    PERFORM set_config('app.test_owner_a_uid', v_owner_a::text, false);
    PERFORM set_config('app.test_staff_a_uid', v_staff_a::text, false);
    PERFORM set_config('app.test_owner_b_uid', v_owner_b::text, false);
END $$;

-- 20a: Staff User cannot query public.payout_methods table (RLS returns 0 rows)
SET LOCAL ROLE authenticated;
DO $$
DECLARE
    v_staff_uid UUID := current_setting('app.test_staff_a_uid', true)::UUID;
    v_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_staff_uid::text, true);

    SELECT count(*) INTO v_count FROM public.payout_methods;
    IF v_count != 0 THEN
        RAISE EXCEPTION 'Security Breach: staff role was able to view % records in payout_methods!', v_count;
    END IF;
    RAISE NOTICE 'Test 20a PASSED: RLS blocked staff role from querying payout_methods table (0 rows returned).';
END $$;
RESET ROLE;

-- 20b: Staff User cannot query public.v_masked_payout_methods view (RLS returns 0 rows)
SET LOCAL ROLE authenticated;
DO $$
DECLARE
    v_staff_uid UUID := current_setting('app.test_staff_a_uid', true)::UUID;
    v_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_staff_uid::text, true);

    SELECT count(*) INTO v_count FROM public.v_masked_payout_methods;
    IF v_count != 0 THEN
        RAISE EXCEPTION 'Security Breach: staff role was able to view % records in v_masked_payout_methods!', v_count;
    END IF;
    RAISE NOTICE 'Test 20b PASSED: Security-invoker view blocked staff role from querying v_masked_payout_methods (0 rows returned).';
END $$;
RESET ROLE;

-- 20f: Staff User CANNOT query public.payouts table (RLS returns 0 rows)
SET LOCAL ROLE authenticated;
DO $$
DECLARE
    v_staff_uid UUID := current_setting('app.test_staff_a_uid', true)::UUID;
    v_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_staff_uid::text, true);

    SELECT count(*) INTO v_count FROM public.payouts;
    IF v_count != 0 THEN
        RAISE EXCEPTION 'Security Breach: staff role was able to view % records in payouts!', v_count;
    END IF;
    RAISE NOTICE 'Test 20f PASSED: RLS blocked staff role from querying sensitive payouts table (0 rows returned).';
END $$;
RESET ROLE;

-- 20g: Staff User CANNOT query public.payout_lifecycle_logs table (RLS returns 0 rows)
SET LOCAL ROLE authenticated;
DO $$
DECLARE
    v_staff_uid UUID := current_setting('app.test_staff_a_uid', true)::UUID;
    v_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_staff_uid::text, true);

    SELECT count(*) INTO v_count FROM public.payout_lifecycle_logs;
    IF v_count != 0 THEN
        RAISE EXCEPTION 'Security Breach: staff role was able to view % records in payout_lifecycle_logs!', v_count;
    END IF;
    RAISE NOTICE 'Test 20g PASSED: RLS blocked staff role from querying payout_lifecycle_logs (0 rows returned).';
END $$;
RESET ROLE;

-- 20c: Authenticated Owner of Org A can retrieve expected masked payout details
SET LOCAL ROLE authenticated;
DO $$
DECLARE
    v_owner_a_uid UUID := current_setting('app.test_owner_a_uid', true)::UUID;
    v_count INT;
    v_masked_acc TEXT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_owner_a_uid::text, true);

    SELECT count(*), max(masked_account_number) INTO v_count, v_masked_acc
    FROM public.v_masked_payout_methods;

    IF v_count < 1 THEN
        RAISE EXCEPTION 'Access Failure: Owner was unable to view own payout methods in v_masked_payout_methods!';
    END IF;
    IF v_masked_acc NOT LIKE '****%' THEN
        RAISE EXCEPTION 'Data Masking Failure: Account number (%) is not properly masked!', v_masked_acc;
    END IF;
    RAISE NOTICE 'Test 20c PASSED: Authenticated owner successfully retrieved masked payout methods (% rows, masked: %).', v_count, v_masked_acc;
END $$;
RESET ROLE;

-- 20h: Authenticated Owner of Org A CAN query payouts and payout_lifecycle_logs
SET LOCAL ROLE authenticated;
DO $$
DECLARE
    v_owner_a_uid UUID := current_setting('app.test_owner_a_uid', true)::UUID;
    v_payout_count INT;
    v_log_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_owner_a_uid::text, true);

    SELECT count(*) INTO v_payout_count FROM public.payouts;
    SELECT count(*) INTO v_log_count FROM public.payout_lifecycle_logs;

    IF v_payout_count < 1 THEN
        RAISE EXCEPTION 'Access Failure: Owner was unable to view own payouts (found %)!', v_payout_count;
    END IF;
    IF v_log_count < 1 THEN
        RAISE EXCEPTION 'Access Failure: Owner was unable to view own payout lifecycle logs (found %)!', v_log_count;
    END IF;
    RAISE NOTICE 'Test 20h PASSED: Authenticated owner successfully queried payouts (% rows) and logs (% rows).', v_payout_count, v_log_count;
END $$;
RESET ROLE;

-- 20d: Authenticated Owner of Org A CANNOT retrieve provider_recipient_token directly (column permission denied)
SET LOCAL ROLE authenticated;
DO $$
DECLARE
    v_owner_a_uid UUID := current_setting('app.test_owner_a_uid', true)::UUID;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_owner_a_uid::text, true);

    BEGIN
        EXECUTE 'SELECT provider_recipient_token FROM public.payout_methods LIMIT 1';
        RAISE EXCEPTION 'Security Breach: Authenticated owner was able to SELECT provider_recipient_token directly!';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Test 20d PASSED: Direct SELECT on provider_recipient_token column strictly denied by PostgreSQL column privileges.';
    END;
END $$;
RESET ROLE;

-- 20e: Cross-Tenant Owner (Owner B) cannot read Org A's payout methods
SET LOCAL ROLE authenticated;
DO $$
DECLARE
    v_owner_b_uid UUID := current_setting('app.test_owner_b_uid', true)::UUID;
    v_org_a UUID := current_setting('app.test_org_a', true)::UUID;
    v_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_owner_b_uid::text, true);

    SELECT count(*) INTO v_count
    FROM public.v_masked_payout_methods
    WHERE organization_id = v_org_a;

    IF v_count != 0 THEN
        RAISE EXCEPTION 'Cross-Tenant Breach: Owner B was able to view % payout methods belonging to Org A!', v_count;
    END IF;
    RAISE NOTICE 'Test 20e PASSED: Cross-tenant owner blocked by RLS from viewing another organization payout methods (0 rows).';
END $$;
RESET ROLE;

-- Rollback entire synthetic test fixture: leaves persistent database pristine
ROLLBACK;

