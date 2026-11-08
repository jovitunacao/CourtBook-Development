-- ==============================================================================
-- CourtBook / BookSuite — Test Fixture SQL
-- File: tests/supabase/fixtures/005d_financial_reconciliation_test.sql
-- Description: Financial Reconciliation & End-to-End Audit Verification Test Suite
--
-- TARGET ENVIRONMENT:
--   BookSuite-Payment-Test (and isolated test harness)
--
-- PRINCIPLES & SAFEGUARDS:
--   1. Strict Rollback: Enclosed entirely within a transaction that always ends in ROLLBACK.
--   2. Centavo Accuracy: All financial calculations verified to exact centavo precision (ROUND(..., 2)).
--   3. 5% Commission Standard: 5% platform commission and 95% owner gross share strictly validated.
--   4. Four-State / Complete Revenue Decomposition: Verified against authoritative 005a2 accounting:
--      Owner Revenue Entitlement = total_gross_settled - total_commission_paid
--        = unsettled + available + pending_payout + total_withdrawn + restricted_reserve - negative_recovery.
--   5. Real Database Constraints Tested Directly: Where database constraints (CHECK, UNIQUE, FK)
--      prevent invalid states, their rejections are tested directly via SQLSTATE assertions.
--   6. Realistic Operational Discrepancies Tested in Reconciliation Engine: Balance sheet drift,
--      commission policy mismatches, calculation drift, missing settlement journals, and unlinked payouts.
--   7. Real PostgreSQL RBAC Roles: Actual 'anon' and 'authenticated' roles tested.
-- ==============================================================================

BEGIN;

DO $$
DECLARE
    -- Synthetic Organizations
    v_synth_org_valid UUID := gen_random_uuid();
    v_synth_org_injected UUID := gen_random_uuid();
    v_synth_org_isolated UUID := gen_random_uuid();

    -- Facilities & Courts
    v_fac_valid UUID := gen_random_uuid();
    v_fac_injected UUID := gen_random_uuid();
    v_fac_isolated UUID := gen_random_uuid();
    v_court_valid UUID := gen_random_uuid();
    v_court_injected UUID := gen_random_uuid();
    v_court_isolated UUID := gen_random_uuid();

    -- Synthetic Users
    v_owner_valid UUID := gen_random_uuid();
    v_staff_valid UUID := gen_random_uuid();
    v_owner_injected UUID := gen_random_uuid();
    v_owner_isolated UUID := gen_random_uuid();
    v_outsider_user UUID := gen_random_uuid();

    -- Test Variables for Valid Flow
    v_test_date DATE := (CURRENT_DATE + interval '3 days')::date;
    v_slot_1 TIMESTAMPTZ;
    v_slot_2 TIMESTAMPTZ;
    v_slot_3 TIMESTAMPTZ;
    v_slot_4 TIMESTAMPTZ;

    v_checkout_res JSONB;
    v_res_1 UUID;
    v_pay_1 UUID;
    v_wh_event_id UUID;
    v_process_res JSONB;
    v_batch_id UUID;
    v_clearing_res JSONB;
    v_payout_method_id UUID;
    v_payout_res JSONB;
    v_payout_1 UUID;
    v_payout_2 UUID;
    v_refund_res JSONB;

    -- Audit & Invariant Variables
    v_summary JSONB;
    v_org_bal RECORD;
    v_reconcile_row RECORD;
    v_disc_count INT;
    v_found_disc RECORD;
    v_test_count INT := 0;

    -- Helper variables for injected discrepancy testing
    v_fake_res_id UUID;
    v_fake_tx_id UUID;
    v_fake_pay_id1 UUID;
    v_fake_pay_id2 UUID;
    v_fake_payout_id UUID;
BEGIN
    v_slot_1 := (v_test_date::text || ' 08:00:00 Asia/Manila')::timestamptz;
    v_slot_2 := (v_test_date::text || ' 10:00:00 Asia/Manila')::timestamptz;
    v_slot_3 := (v_test_date::text || ' 13:00:00 Asia/Manila')::timestamptz;
    v_slot_4 := (v_test_date::text || ' 15:00:00 Asia/Manila')::timestamptz;

    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== Phase 4.2.5: Financial Reconciliation & End-to-End Audit Tests   ===';
    RAISE NOTICE '========================================================================';

    -- -------------------------------------------------------------------------
    -- Setup Synthetic Tenants, Facilities, Courts & Users
    -- -------------------------------------------------------------------------
    INSERT INTO public.organizations (id, name, slug, billing_email)
    VALUES
        (v_synth_org_valid, 'Reconciliation Tennis Club (Valid)', 'rec-tennis-valid-' || substr(gen_random_uuid()::text, 1, 8), 'rec-valid@example.com'),
        (v_synth_org_injected, 'Reconciliation Club (Injected Anomalies)', 'rec-anomalies-' || substr(gen_random_uuid()::text, 1, 8), 'rec-anomalies@example.com'),
        (v_synth_org_isolated, 'Reconciliation Club (Isolated Control)', 'rec-isolated-' || substr(gen_random_uuid()::text, 1, 8), 'rec-isolated@example.com');

    INSERT INTO public.facilities (id, organization_id, name, slug, currency, default_hourly_rate, booking_confirmation_mode, hold_duration_minutes)
    VALUES
        (v_fac_valid, v_synth_org_valid, 'Valid Facility', 'fac-valid-' || substr(gen_random_uuid()::text, 1, 8), '₱', 1000.00, 'instant', 15),
        (v_fac_injected, v_synth_org_injected, 'Anomalies Facility', 'fac-injected-' || substr(gen_random_uuid()::text, 1, 8), '₱', 1000.00, 'instant', 15),
        (v_fac_isolated, v_synth_org_isolated, 'Isolated Facility', 'fac-isolated-' || substr(gen_random_uuid()::text, 1, 8), '₱', 1000.00, 'instant', 15);

    INSERT INTO public.courts (id, facility_id, name, sport_type, hourly_rate)
    VALUES
        (v_court_valid, v_fac_valid, 'Valid Court 1', 'tennis', 1000.00),
        (v_court_injected, v_fac_injected, 'Anomalies Court 1', 'tennis', 1000.00),
        (v_court_isolated, v_fac_isolated, 'Isolated Court 1', 'tennis', 1000.00);

    -- Provision Synthetic auth users and organization members
    INSERT INTO auth.users (id, email)
    VALUES
        (v_owner_valid, 'rec-owner-valid-' || substr(v_owner_valid::text, 1, 8) || '@example.com'),
        (v_staff_valid, 'rec-staff-valid-' || substr(v_staff_valid::text, 1, 8) || '@example.com'),
        (v_owner_injected, 'rec-owner-injected-' || substr(v_owner_injected::text, 1, 8) || '@example.com'),
        (v_owner_isolated, 'rec-owner-isolated-' || substr(v_owner_isolated::text, 1, 8) || '@example.com'),
        (v_outsider_user, 'rec-outsider-' || substr(v_outsider_user::text, 1, 8) || '@example.com')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.organization_members (organization_id, user_id, role)
    VALUES
        (v_synth_org_valid, v_owner_valid, 'owner'),
        (v_synth_org_valid, v_staff_valid, 'staff'),
        (v_synth_org_injected, v_owner_injected, 'owner'),
        (v_synth_org_isolated, v_owner_isolated, 'owner')
    ON CONFLICT DO NOTHING;

    -- =========================================================================
    -- PART 1: Authoritative Configuration Baseline Verification
    -- =========================================================================
    IF NOT EXISTS (
        SELECT 1 FROM public.platform_billing_config
        WHERE id = 1 AND default_commission_rate = 0.0500
    ) THEN
        RAISE EXCEPTION 'Test Setup Failed: platform_billing_config(id=1) must exist with default_commission_rate = 0.0500!';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.platform_fee_policy_controls
        WHERE id = 1 AND gateway_processing_fee_policy = 'undecided' AND payout_transfer_fee_policy = 'undecided'
    ) THEN
        RAISE EXCEPTION 'Test Setup Failed: platform_fee_policy_controls must exist with undecided fee policies!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Authoritative 5%% commission configuration and undecided fee policy controls verified.', v_test_count;


    -- =========================================================================
    -- PART 2: Valid End-to-End Financial Lifecycle Execution (Valid Tenant)
    -- =========================================================================

    -- -------------------------------------------------------------------------
    -- Scenario 2.1: Booking 1 Checkout Session & Server-Authoritative 5% Split
    -- -------------------------------------------------------------------------
    v_checkout_res := public.create_booking_checkout_session(
        'idem_rec_chk_001',
        v_fac_valid,
        v_court_valid,
        'Maria Clara',
        '09171112222',
        'maria@example.com',
        v_test_date,
        v_slot_1,
        60,
        'paymongo'
    );
    v_res_1 := (v_checkout_res->>'reservation_id')::UUID;
    v_pay_1 := (v_checkout_res->>'payment_id')::UUID;

    -- Assert 5% commission snapshot on ₱1,000.00
    IF (v_checkout_res->>'expected_amount')::NUMERIC != 1000.00 OR
       (v_checkout_res->>'commission_rate')::NUMERIC != 0.0500 OR
       (v_checkout_res->>'commission_amount')::NUMERIC != 50.00 OR
       (v_checkout_res->>'owner_gross_share')::NUMERIC != 950.00 THEN
        RAISE EXCEPTION 'Scenario 2.1 Failed: Incorrect 5%% commission snapshot! Got: %', v_checkout_res;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Scenario 2.1 - 5%% commission snapshot verified (₱1,000.00 = ₱50.00 + ₱950.00).', v_test_count;

    -- Bind Provider Checkout Session
    PERFORM public.bind_provider_checkout_session(
        v_pay_1,
        v_res_1,
        'paymongo',
        'cs_paymongo_rec_001',
        'https://checkout.paymongo.com/cs_paymongo_rec_001',
        'idem_rec_bind_001'
    );

    -- -------------------------------------------------------------------------
    -- Scenario 2.2: Payment 1 Capture & Booking Settlement Journal
    -- -------------------------------------------------------------------------
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_rec_capture_001', 'payment.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'pay_rec_prov_001', 'attributes', jsonb_build_object('amount', 100000, 'currency', 'PHP', 'status', 'paid', 'checkout_session_id', 'cs_paymongo_rec_001')))
    ) RETURNING id INTO v_wh_event_id;

    v_process_res := public.process_verified_payment_event(
        v_wh_event_id,
        'paymongo',
        'evt_rec_capture_001',
        'pay_rec_prov_001',
        'cs_paymongo_rec_001',
        1000.00,
        'PHP',
        'idem_rec_proc_001'
    );

    IF (v_process_res->>'outcome') != 'confirmed_and_settled' THEN
        RAISE EXCEPTION 'Scenario 2.2 Failed: Payment capture was not confirmed! Got: %', v_process_res;
    END IF;

    -- Verify double entry audit view on Booking Settlement Transaction
    IF NOT EXISTS (
        SELECT 1 FROM public.v_transaction_double_entry_audit
        WHERE reference_id = v_res_1
          AND transaction_type = 'booking_settlement'
          AND is_balanced = true
          AND total_debits = 1000.00
          AND total_credits = 1000.00
          AND net_imbalance = 0.00
          AND entry_count = 3
    ) THEN
        RAISE EXCEPTION 'Scenario 2.2 Failed: Booking settlement double-entry check failed in v_transaction_double_entry_audit!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Scenario 2.2 - Booking settlement journal verified perfectly balanced (Debits ₱1,000 = Credits ₱1,000, 3 entries).', v_test_count;

    -- -------------------------------------------------------------------------
    -- Scenario 2.3: Settlement Batch Clearing (Clearing to Available Withdrawable)
    -- -------------------------------------------------------------------------
    INSERT INTO public.settlement_batches (
        id, provider_name, provider_batch_id, settlement_date,
        total_gross_amount, total_net_amount, total_fee_amount, status, verified_at
    ) VALUES (
        gen_random_uuid(), 'paymongo', 'batch_rec_valid_001', CURRENT_DATE,
        1000.00, 950.00, 50.00, 'pending_reconciliation', now()
    ) RETURNING id INTO v_batch_id;

    INSERT INTO public.settlement_items (
        id, batch_id, payment_id, provider_payment_id, organization_id, facility_id,
        gross_amount, provider_fee_amount, net_settled_amount, settlement_status
    ) VALUES (
        gen_random_uuid(), v_batch_id, v_pay_1, 'pay_rec_prov_001', v_synth_org_valid, v_fac_valid,
        1000.00, 50.00, 950.00, 'matched'
    );

    v_clearing_res := public.process_settlement_clearing(
        v_batch_id,
        v_synth_org_valid,
        v_fac_valid,
        950.00,
        'batch_rec_valid_001',
        'idem_rec_clearing_001'
    );

    -- Verify double entry audit view on Clearing Transaction
    IF NOT EXISTS (
        SELECT 1 FROM public.v_transaction_double_entry_audit
        WHERE organization_id = v_synth_org_valid
          AND transaction_type = 'funds_cleared'
          AND is_balanced = true
          AND total_debits = 1900.00
          AND total_credits = 1900.00
          AND net_imbalance = 0.00
    ) THEN
        RAISE EXCEPTION 'Scenario 2.3 Failed: Settlement clearing double-entry check failed in v_transaction_double_entry_audit!';
    END IF;

    -- Verify organization balances: unsettled = 0, available = 950.00
    SELECT * INTO v_org_bal FROM public.organization_balances WHERE organization_id = v_synth_org_valid;
    IF v_org_bal.unsettled_clearing_amount != 0.00 OR
       v_org_bal.available_withdrawable_balance != 950.00 OR
       v_org_bal.pending_payout_amount != 0.00 OR
       v_org_bal.total_commission_paid != 50.00 THEN
        RAISE EXCEPTION 'Scenario 2.3 Failed: Balance state violation after clearing. Got: %', v_org_bal;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Scenario 2.3 - Clearing settlement verified (₱950.00 transitioned to available balance).', v_test_count;

    -- -------------------------------------------------------------------------
    -- Scenario 2.4: Owner Payout Request & Reserve
    -- -------------------------------------------------------------------------
    INSERT INTO public.payout_methods (
        id, organization_id, method_type, provider_name, provider_recipient_token,
        account_holder_name, masked_account_number, bank_code, bank_name, is_active, is_default, verification_status
    ) VALUES (
        gen_random_uuid(), v_synth_org_valid, 'bank_transfer', 'paymongo', 'tok_rec_valid_bank',
        'Valid Club Owner', '****8888', 'BPI', 'Bank of the Philippine Islands', true, true, 'verified'
    ) RETURNING id INTO v_payout_method_id;

    v_payout_res := public.request_owner_payout(
        v_synth_org_valid,
        v_payout_method_id,
        600.00,
        'idem_rec_payout_001'
    );
    v_payout_1 := (v_payout_res->>'payout_id')::UUID;

    -- Verify payout status and reserve journal linkage via audit view
    IF NOT EXISTS (
        SELECT 1 FROM public.v_payout_lifecycle_reconciliation
        WHERE payout_id = v_payout_1
          AND payout_status = 'approved_reserved'
          AND reserve_tx_type = 'payout_reserve'
          AND is_journal_linkage_valid = true
    ) THEN
        RAISE EXCEPTION 'Scenario 2.4 Failed: Payout reservation failed in v_payout_lifecycle_reconciliation!';
    END IF;

    -- Verify balances: available = 350.00, pending_payout = 600.00
    SELECT * INTO v_org_bal FROM public.organization_balances WHERE organization_id = v_synth_org_valid;
    IF v_org_bal.available_withdrawable_balance != 350.00 OR
       v_org_bal.pending_payout_amount != 600.00 THEN
        RAISE EXCEPTION 'Scenario 2.4 Failed: Balance state violation after payout reserve. Got: %', v_org_bal;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Scenario 2.4 - Payout reservation of ₱600.00 verified with Account 2015 reserve journal.', v_test_count;

    -- -------------------------------------------------------------------------
    -- Scenario 2.5: Owner Payout Disbursement Confirmation
    -- -------------------------------------------------------------------------
    INSERT INTO public.provider_webhook_events (
        provider_name, provider_event_id, event_type, signature_verification_status,
        signature_header, processing_state, payload
    ) VALUES (
        'paymongo', 'evt_rec_payout_paid_001', 'payout.paid', 'verified',
        't=1700000000,li=valid_hmac_hex', 'pending',
        jsonb_build_object('data', jsonb_build_object('id', 'payout_rec_ref_001', 'attributes', jsonb_build_object('amount', 60000, 'currency', 'PHP', 'status', 'paid', 'destination', v_payout_method_id, 'metadata', jsonb_build_object('organization_id', v_synth_org_valid))))
    ) RETURNING id INTO v_wh_event_id;

    PERFORM public.confirm_owner_payout_disbursement(
        v_payout_1,
        'payout_rec_ref_001',
        jsonb_build_object(
            'webhook_event_id', v_wh_event_id,
            'provider_reference', 'payout_rec_ref_001',
            'disbursement_status', 'succeeded',
            'amount', 600.00
        ),
        'idem_rec_disburse_001'
    );

    -- Verify payout status and terminal disbursement journal linkage via audit view
    IF NOT EXISTS (
        SELECT 1 FROM public.v_payout_lifecycle_reconciliation
        WHERE payout_id = v_payout_1
          AND payout_status = 'paid'
          AND reserve_tx_type = 'payout_reserve'
          AND terminal_tx_type = 'payout_disbursement'
          AND is_journal_linkage_valid = true
    ) THEN
        RAISE EXCEPTION 'Scenario 2.5 Failed: Payout disbursement failed in v_payout_lifecycle_reconciliation!';
    END IF;

    -- Verify balances: pending_payout = 0, total_withdrawn = 600.00
    SELECT * INTO v_org_bal FROM public.organization_balances WHERE organization_id = v_synth_org_valid;
    IF v_org_bal.pending_payout_amount != 0.00 OR
       v_org_bal.total_withdrawn != 600.00 OR
       v_org_bal.available_withdrawable_balance != 350.00 THEN
        RAISE EXCEPTION 'Scenario 2.5 Failed: Balance state violation after payout disbursement. Got: %', v_org_bal;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Scenario 2.5 - Payout disbursement verified (total_withdrawn = ₱600.00, terminal journal linked).', v_test_count;

    -- -------------------------------------------------------------------------
    -- Scenario 2.6: Booking 2 & Partial Refund Lifecycle
    -- -------------------------------------------------------------------------
    DECLARE
        v_res_2 UUID;
        v_pay_2 UUID;
    BEGIN
        v_checkout_res := public.create_booking_checkout_session(
            'idem_rec_chk_002',
            v_fac_valid,
            v_court_valid,
            'Jose Rizal',
            '09172223333',
            'jose@example.com',
            v_test_date,
            v_slot_2,
            60,
            'paymongo'
        );
        v_res_2 := (v_checkout_res->>'reservation_id')::UUID;
        v_pay_2 := (v_checkout_res->>'payment_id')::UUID;

        PERFORM public.bind_provider_checkout_session(
            v_pay_2,
            v_res_2,
            'paymongo',
            'cs_paymongo_rec_002',
            'https://checkout.paymongo.com/cs_paymongo_rec_002',
            'idem_rec_bind_002'
        );

        INSERT INTO public.provider_webhook_events (
            provider_name, provider_event_id, event_type, signature_verification_status,
            signature_header, processing_state, payload
        ) VALUES (
            'paymongo', 'evt_rec_capture_002', 'payment.paid', 'verified',
            't=1700000000,li=valid_hmac_hex', 'pending',
            jsonb_build_object('data', jsonb_build_object('id', 'pay_rec_prov_002', 'attributes', jsonb_build_object('amount', 50000, 'currency', 'PHP', 'status', 'paid', 'checkout_session_id', 'cs_paymongo_rec_002')))
        ) RETURNING id INTO v_wh_event_id;

        PERFORM public.process_verified_payment_event(
            v_wh_event_id, 'paymongo', 'evt_rec_capture_002', 'pay_rec_prov_002',
            'cs_paymongo_rec_002', 500.00, 'PHP', 'idem_rec_proc_002'
        );

        -- Clear Booking 2 to available balance
        INSERT INTO public.settlement_batches (
            id, provider_name, provider_batch_id, settlement_date,
            total_gross_amount, total_net_amount, total_fee_amount, status, verified_at
        ) VALUES (
            gen_random_uuid(), 'paymongo', 'batch_rec_valid_002', CURRENT_DATE,
            500.00, 475.00, 25.00, 'pending_reconciliation', now()
        ) RETURNING id INTO v_batch_id;

        INSERT INTO public.settlement_items (
            id, batch_id, payment_id, provider_payment_id, organization_id, facility_id,
            gross_amount, provider_fee_amount, net_settled_amount, settlement_status
        ) VALUES (
            gen_random_uuid(), v_batch_id, v_pay_2, 'pay_rec_prov_002', v_synth_org_valid, v_fac_valid,
            500.00, 25.00, 475.00, 'matched'
        );

        PERFORM public.process_settlement_clearing(
            v_batch_id, v_synth_org_valid, v_fac_valid, 475.00,
            'batch_rec_valid_002', 'idem_rec_clearing_002'
        );

        -- Process Partial Refund of ₱200.00 (Owner share ₱190.00, Commission share ₱10.00)
        INSERT INTO public.provider_webhook_events (
            provider_name, provider_event_id, event_type, signature_verification_status,
            signature_header, processing_state, payload
        ) VALUES (
            'paymongo', 'evt_rec_refund_002', 'refund.succeeded', 'verified',
            't=1700000000,li=valid_hmac_hex', 'pending',
            jsonb_build_object('data', jsonb_build_object('id', 'ref_rec_prov_002', 'attributes', jsonb_build_object('payment_id', 'pay_rec_prov_002', 'amount', 20000, 'currency', 'PHP', 'status', 'succeeded')))
        ) RETURNING id INTO v_wh_event_id;

        v_refund_res := public.process_verified_refund_event(
            v_pay_2,
            200.00,
            'Partial rain delay refund',
            'ref_rec_prov_002',
            jsonb_build_object(
                'webhook_event_id', v_wh_event_id,
                'provider_refund_id', 'ref_rec_prov_002',
                'status', 'succeeded',
                'amount', 200.00
            ),
            'idem_rec_refund_002',
            true
        );

        IF (v_refund_res->>'status') != 'partially_refunded' OR
           (v_refund_res->>'total_refunded')::NUMERIC != 200.00 THEN
            RAISE EXCEPTION 'Scenario 2.6 Failed: Partial refund state mismatch! Got: %', v_refund_res;
        END IF;

        -- Verify double entry audit view on refund reversal
        IF NOT EXISTS (
            SELECT 1 FROM public.v_transaction_double_entry_audit
            WHERE reference_id = v_pay_2
              AND transaction_type = 'refund_reversal'
              AND is_balanced = true
              AND total_debits = 200.00
              AND total_credits = 200.00
              AND net_imbalance = 0.00
        ) THEN
            RAISE EXCEPTION 'Scenario 2.6 Failed: Refund reversal double-entry check failed in v_transaction_double_entry_audit!';
        END IF;
    END;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Scenario 2.6 - Partial refund of ₱200.00 processed and double-entry balanced.', v_test_count;

    -- -------------------------------------------------------------------------
    -- Scenario 2.7: Booking 3 & Failed Payout Release Lifecycle
    -- -------------------------------------------------------------------------
    DECLARE
        v_res_3 UUID;
        v_pay_3 UUID;
    BEGIN
        v_checkout_res := public.create_booking_checkout_session(
            'idem_rec_chk_003',
            v_fac_valid,
            v_court_valid,
            'Andres Bonifacio',
            '09173334444',
            'andres@example.com',
            v_test_date,
            v_slot_3,
            60,
            'paymongo'
        );
        v_res_3 := (v_checkout_res->>'reservation_id')::UUID;
        v_pay_3 := (v_checkout_res->>'payment_id')::UUID;

        PERFORM public.bind_provider_checkout_session(
            v_pay_3,
            v_res_3,
            'paymongo',
            'cs_paymongo_rec_003',
            'https://checkout.paymongo.com/cs_paymongo_rec_003',
            'idem_rec_bind_003'
        );

        INSERT INTO public.provider_webhook_events (
            provider_name, provider_event_id, event_type, signature_verification_status,
            signature_header, processing_state, payload
        ) VALUES (
            'paymongo', 'evt_rec_capture_003', 'payment.paid', 'verified',
            't=1700000000,li=valid_hmac_hex', 'pending',
            jsonb_build_object('data', jsonb_build_object('id', 'pay_rec_prov_003', 'attributes', jsonb_build_object('amount', 40000, 'currency', 'PHP', 'status', 'paid', 'checkout_session_id', 'cs_paymongo_rec_003')))
        ) RETURNING id INTO v_wh_event_id;

        PERFORM public.process_verified_payment_event(
            v_wh_event_id, 'paymongo', 'evt_rec_capture_003', 'pay_rec_prov_003',
            'cs_paymongo_rec_003', 400.00, 'PHP', 'idem_rec_proc_003'
        );

        -- Clear Booking 3
        INSERT INTO public.settlement_batches (
            id, provider_name, provider_batch_id, settlement_date,
            total_gross_amount, total_net_amount, total_fee_amount, status, verified_at
        ) VALUES (
            gen_random_uuid(), 'paymongo', 'batch_rec_valid_003', CURRENT_DATE,
            400.00, 380.00, 20.00, 'pending_reconciliation', now()
        ) RETURNING id INTO v_batch_id;

        INSERT INTO public.settlement_items (
            id, batch_id, payment_id, provider_payment_id, organization_id, facility_id,
            gross_amount, provider_fee_amount, net_settled_amount, settlement_status
        ) VALUES (
            gen_random_uuid(), v_batch_id, v_pay_3, 'pay_rec_prov_003', v_synth_org_valid, v_fac_valid,
            400.00, 20.00, 380.00, 'matched'
        );

        PERFORM public.process_settlement_clearing(
            v_batch_id, v_synth_org_valid, v_fac_valid, 380.00,
            'batch_rec_valid_003', 'idem_rec_clearing_003'
        );

        -- Request Payout of ₱300.00
        v_payout_res := public.request_owner_payout(
            v_synth_org_valid,
            v_payout_method_id,
            300.00,
            'idem_rec_payout_fail_001'
        );
        v_payout_2 := (v_payout_res->>'payout_id')::UUID;

        -- Simulate provider payout failure webhook and release reserve back to available balance
        INSERT INTO public.provider_webhook_events (
            provider_name, provider_event_id, event_type, signature_verification_status,
            signature_header, processing_state, payload
        ) VALUES (
            'paymongo', 'evt_rec_payout_failed_001', 'payout.failed', 'verified',
            't=1700000000,li=valid_hmac_hex', 'pending',
            jsonb_build_object('data', jsonb_build_object('id', 'payout_prov_fail_002', 'attributes', jsonb_build_object('currency', 'PHP', 'status', 'failed', 'failure_code', 'ACCOUNT_CLOSED', 'destination', v_payout_method_id, 'metadata', jsonb_build_object('organization_id', v_synth_org_valid))))
        ) RETURNING id INTO v_wh_event_id;

        PERFORM public.fail_owner_payout_release(
            v_payout_2,
            'Bank account closed by owner',
            jsonb_build_object(
                'webhook_event_id', v_wh_event_id,
                'failure_code', 'ACCOUNT_CLOSED',
                'provider_status', 'failed'
            ),
            'idem_rec_payout_release_001'
        );

        -- Verify payout status and failed release terminal journal linkage
        IF NOT EXISTS (
            SELECT 1 FROM public.v_payout_lifecycle_reconciliation
            WHERE payout_id = v_payout_2
              AND payout_status = 'failed'
              AND reserve_tx_type = 'payout_reserve'
              AND terminal_tx_type = 'payout_failed_release'
              AND is_journal_linkage_valid = true
        ) THEN
            RAISE EXCEPTION 'Scenario 2.7 Failed: Payout failure release failed in v_payout_lifecycle_reconciliation!';
        END IF;
    END;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Scenario 2.7 - Payout failure and reserve restoration verified with terminal journal.', v_test_count;

    -- -------------------------------------------------------------------------
    -- Scenario 2.8: Comprehensive Audit Verification of Valid Tenant
    -- -------------------------------------------------------------------------
    -- 1. Double-Entry Audit View: All transactions must be 100% balanced
    IF EXISTS (
        SELECT 1 FROM public.v_transaction_double_entry_audit
        WHERE organization_id = v_synth_org_valid
          AND is_balanced = false
    ) THEN
        RAISE EXCEPTION 'Scenario 2.8 Failed: Unbalanced transaction found for valid tenant in v_transaction_double_entry_audit!';
    END IF;

    -- 2. Payment Commission Audit View: All payments must be 100% compliant with 5% policy
    IF EXISTS (
        SELECT 1 FROM public.v_payment_commission_audit
        WHERE organization_id = v_synth_org_valid
          AND (is_standard_rate = false OR is_split_conserved = false OR is_commission_accurate = false OR is_owner_share_accurate = false OR is_refund_within_bounds = false)
    ) THEN
        RAISE EXCEPTION 'Scenario 2.8 Failed: Payment commission or refund discrepancy in v_payment_commission_audit!';
    END IF;

    -- 3. Payout Lifecycle Reconciliation View: All payouts must have valid journal links
    IF EXISTS (
        SELECT 1 FROM public.v_payout_lifecycle_reconciliation
        WHERE organization_id = v_synth_org_valid
          AND is_journal_linkage_valid = false
    ) THEN
        RAISE EXCEPTION 'Scenario 2.8 Failed: Invalid payout journal linkage in v_payout_lifecycle_reconciliation!';
    END IF;

    -- 4. Financial Reconciliation Overview: Materialized balances must match General Ledger
    SELECT * INTO v_reconcile_row
    FROM public.v_financial_reconciliation_overview
    WHERE organization_id = v_synth_org_valid;

    IF v_reconcile_row.is_reconciled IS NOT TRUE THEN
        RAISE EXCEPTION 'Scenario 2.8 Failed: Valid tenant failed overview reconciliation! Details: unsettled_diff=%, avail_diff=%, pending_diff=%, comm_diff=%, withdr_diff=%, decomp_drift=%',
            v_reconcile_row.unsettled_clearing_diff,
            v_reconcile_row.available_balance_diff,
            v_reconcile_row.pending_payout_diff,
            v_reconcile_row.commission_diff,
            v_reconcile_row.withdrawn_diff,
            v_reconcile_row.decomposition_drift;
    END IF;

    -- 5. Four-State Revenue Decomposition Invariant
    IF v_reconcile_row.decomposition_drift != 0.00 THEN
        RAISE EXCEPTION 'Scenario 2.8 Failed: Four-state revenue decomposition drift detected: ₱%', v_reconcile_row.decomposition_drift;
    END IF;

    -- 6. reconcile_organization_finances() must report EXACTLY ZERO discrepancies
    SELECT count(*) INTO v_disc_count
    FROM public.reconcile_organization_finances(v_synth_org_valid);

    IF v_disc_count != 0 THEN
        RAISE EXCEPTION 'Scenario 2.8 Failed: Expected 0 discrepancies for valid tenant, got %!', v_disc_count;
    END IF;

    -- 7. get_financial_reconciliation_summary() must report is_healthy = true
    v_summary := public.get_financial_reconciliation_summary(v_synth_org_valid);

    IF (v_summary->>'is_healthy')::BOOLEAN IS NOT TRUE OR
       (v_summary->>'total_discrepancies')::INT != 0 OR
       (v_summary->>'double_entry_balanced')::BOOLEAN IS NOT TRUE OR
       (v_summary->>'commission_policy_compliant')::BOOLEAN IS NOT TRUE THEN
        RAISE EXCEPTION 'Scenario 2.8 Failed: Reconciliation summary unhealthy for valid tenant! Got: %', v_summary;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Scenario 2.8 - Valid tenant 100%% reconciled across General Ledger, payouts, commission splits, and Four-State Invariant.', v_test_count;


    -- =========================================================================
    -- PART 3: Database Constraint Protections Verified Directly
    -- =========================================================================
    -- Where database constraints (CHECK, UNIQUE, FK) physically prevent invalid states,
    -- test those database protections directly instead of attempting impossible commits.

    -- Provision a synthetic reservation for constraint testing
    v_fake_res_id := gen_random_uuid();
    INSERT INTO public.reservations (
        id, facility_id, court_id, reference_code, customer_name, customer_email, customer_phone,
        booking_date, start_time, end_time, duration_minutes, time_slot_label, status, price, currency
    ) VALUES (
        v_fake_res_id, v_fac_injected, v_court_injected, 'TD-ANOMALY-1', 'Anomaly Booker', 'anomaly@test.com', '09170008888',
        v_test_date, v_slot_4, v_slot_4 + interval '1 hour', 60, '03:00 PM - 04:00 PM', 'pending', 1000.00, '₱'
    );

    -- -------------------------------------------------------------------------
    -- Protection 3.1: Payment Split Conservation Constraint (chk_payment_amount_split)
    -- -------------------------------------------------------------------------
    BEGIN
        INSERT INTO public.payments (
            id, organization_id, facility_id, reservation_id, provider_name, provider_payment_id,
            status, currency, expected_amount, commission_rate, commission_amount, owner_gross_share,
            captured_amount, refunded_amount, checkout_session_id
        ) VALUES (
            gen_random_uuid(), v_synth_org_injected, v_fac_injected, v_fake_res_id, 'paymongo', 'pay_chk_split_fail',
            'pending', 'PHP', 1000.00, 0.0500, 50.00, 850.00, -- ₱100 LEAK! 50 + 850 != 1000
            0.00, 0.00, 'cs_chk_split_fail'
        );
        RAISE EXCEPTION 'Protection 3.1 Failed: Invalid payment split was not rejected by database constraint!';
    EXCEPTION WHEN check_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test % PASSED: Protection 3.1 - Database constraint chk_payment_amount_split strictly blocked invalid split.', v_test_count;
    END;

    -- -------------------------------------------------------------------------
    -- Protection 3.2: Refund Bounds Constraint (chk_payments_refunded_le_captured)
    -- -------------------------------------------------------------------------
    BEGIN
        INSERT INTO public.payments (
            id, organization_id, facility_id, reservation_id, provider_name, provider_payment_id,
            status, currency, expected_amount, commission_rate, commission_amount, owner_gross_share,
            captured_amount, refunded_amount, checkout_session_id
        ) VALUES (
            gen_random_uuid(), v_synth_org_injected, v_fac_injected, v_fake_res_id, 'paymongo', 'pay_chk_refund_fail',
            'pending', 'PHP', 500.00, 0.0500, 25.00, 475.00,
            0.00, 100.00, -- Refunded 100 > Captured 0!
            'cs_chk_refund_fail'
        );
        RAISE EXCEPTION 'Protection 3.2 Failed: Refund overflow was not rejected by database constraint!';
    EXCEPTION WHEN check_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test % PASSED: Protection 3.2 - Database constraint chk_payments_refunded_le_captured strictly blocked refund overflow.', v_test_count;
    END;

    -- -------------------------------------------------------------------------
    -- Protection 3.3: Duplicate Provider Payment ID Constraint (uq_payments_provider_payment_id)
    -- -------------------------------------------------------------------------
    BEGIN
        -- Attempt to insert payment reusing existing valid provider payment ID 'pay_rec_prov_001'
        INSERT INTO public.payments (
            id, organization_id, facility_id, reservation_id, provider_name, provider_payment_id,
            status, currency, expected_amount, commission_rate, commission_amount, owner_gross_share,
            captured_amount, refunded_amount, checkout_session_id
        ) VALUES (
            gen_random_uuid(), v_synth_org_injected, v_fac_injected, v_fake_res_id, 'paymongo', 'pay_rec_prov_001', -- DUPLICATE!
            'pending', 'PHP', 1000.00, 0.0500, 50.00, 950.00,
            0.00, 0.00, 'cs_chk_dup_fail'
        );
        RAISE EXCEPTION 'Protection 3.3 Failed: Duplicate provider payment ID was not rejected by database constraint!';
    EXCEPTION WHEN unique_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test % PASSED: Protection 3.3 - Unique index uq_payments_provider_payment_id strictly blocked duplicate provider payment ID.', v_test_count;
    END;

    -- -------------------------------------------------------------------------
    -- Protection 3.4: Cross-Tenant Ledger Entry Foreign Key (fk_ledger_entries_tx_org)
    -- -------------------------------------------------------------------------
    BEGIN
        -- Attempt to insert ledger entry for Tenant B referencing Tenant A's transaction
        DECLARE
            v_org_a_tx UUID;
        BEGIN
            SELECT id INTO v_org_a_tx FROM public.financial_transactions WHERE organization_id = v_synth_org_valid LIMIT 1;
            INSERT INTO public.ledger_entries (
                id, transaction_id, organization_id, account_code, entry_direction, amount, entry_order, running_balance
            ) VALUES (
                gen_random_uuid(), v_org_a_tx, v_synth_org_injected, '1020', 'DEBIT', 100.00, 99, 100.00
            );
            RAISE EXCEPTION 'Protection 3.4 Failed: Cross-tenant ledger entry was not rejected by composite foreign key!';
        END;
    EXCEPTION WHEN foreign_key_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test % PASSED: Protection 3.4 - Composite foreign key strictly blocked cross-tenant ledger entry.', v_test_count;
    END;

    -- -------------------------------------------------------------------------
    -- Protection 3.5: Cross-Tenant Payout Journal Foreign Key (fk_payouts_journal_reserve_org)
    -- -------------------------------------------------------------------------
    BEGIN
        -- Attempt to insert payout for Tenant B referencing Tenant A's reserve transaction
        DECLARE
            v_org_a_reserve_tx UUID;
        BEGIN
            SELECT id INTO v_org_a_reserve_tx
            FROM public.financial_transactions
            WHERE organization_id = v_synth_org_valid AND transaction_type = 'payout_reserve' LIMIT 1;

            INSERT INTO public.payouts (
                id, organization_id, payout_method_id, amount, currency, status,
                journal_reserve_tx_id, journal_terminal_tx_id
            ) VALUES (
                gen_random_uuid(), v_synth_org_injected, v_payout_method_id, 500.00, 'PHP', 'approved_reserved',
                v_org_a_reserve_tx, NULL
            );
            RAISE EXCEPTION 'Protection 3.5 Failed: Cross-tenant payout journal reference was not rejected by database constraint!';
        END;
    EXCEPTION WHEN foreign_key_violation THEN
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test % PASSED: Protection 3.5 - Composite foreign key fk_payouts_journal_reserve_org strictly blocked cross-tenant payout journal.', v_test_count;
    END;


    -- =========================================================================
    -- PART 4: Controlled Anomaly Injections & Reconciliation Diagnostic Detection
    -- =========================================================================
    -- Here we inject realistic operational discrepancies into v_synth_org_injected
    -- that can occur during ledger drift, unlinked jobs, or rate misconfigurations,
    -- while strictly satisfying all database CHECK and Foreign Key constraints!

    -- Provision initial balance record for v_synth_org_injected
    INSERT INTO public.organization_balances (
        organization_id, currency, total_gross_settled, total_commission_paid,
        unsettled_clearing_amount, available_withdrawable_balance, pending_payout_amount, total_withdrawn
    ) VALUES (
        v_synth_org_injected, 'PHP', 1000.00, 50.00, 0.00, 950.00, 0.00, 0.00
    ) ON CONFLICT (organization_id) DO UPDATE
        SET available_withdrawable_balance = 950.00;

    -- -------------------------------------------------------------------------
    -- Anomaly 4.1: Non-Standard Commission Rate Detection
    -- -------------------------------------------------------------------------
    -- Temporarily disable payment validation trigger within this test transaction
    ALTER TABLE public.payments DISABLE TRIGGER trg_validate_payment_status_transition;

    -- Insert payment with non-standard 10% commission rate (0.1000) satisfying all foreign keys and chk_payment_amount_split (1000 = 100 + 900)
    v_fake_pay_id1 := gen_random_uuid();
    INSERT INTO public.payments (
        id, organization_id, facility_id, reservation_id, provider_name, provider_payment_id,
        status, currency, expected_amount, commission_rate, commission_amount, owner_gross_share,
        captured_amount, refunded_amount, checkout_session_id
    ) VALUES (
        v_fake_pay_id1, v_synth_org_injected, v_fac_injected, v_fake_res_id, 'paymongo', 'pay_anom_rate_001',
        'captured', 'PHP', 1000.00, 0.1000, 100.00, 900.00,
        1000.00, 0.00, 'cs_anom_rate_001'
    );

    SELECT * INTO v_found_disc
    FROM public.reconcile_organization_finances(v_synth_org_injected)
    WHERE discrepancy_code = 'COMMISSION_RATE_MISMATCH';

    IF v_found_disc.entity_id != v_fake_pay_id1 OR v_found_disc.severity != 'ERROR' THEN
        RAISE EXCEPTION 'Anomaly 4.1 Failed: COMMISSION_RATE_MISMATCH not detected properly!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Anomaly 4.1 - COMMISSION_RATE_MISMATCH correctly detected and isolated.', v_test_count;

    -- -------------------------------------------------------------------------
    -- Anomaly 4.2: Commission Calculation Drift Detection
    -- -------------------------------------------------------------------------
    -- Payment with calculation drift: expected ₱1,000 at 0.0500 should be ₱50 commission,
    -- but is recorded as ₱45 commission and ₱955 owner share.
    -- Satisfies chk_payment_amount_split (1000 = 45 + 955) and FKs!
    DECLARE
        v_fake_drift_pay_id UUID := gen_random_uuid();
        v_drift_res_id UUID := gen_random_uuid();
    BEGIN
        INSERT INTO public.reservations (
            id, facility_id, court_id, reference_code, customer_name, customer_email, customer_phone,
            booking_date, start_time, end_time, duration_minutes, time_slot_label, status, price, currency
        ) VALUES (
            v_drift_res_id, v_fac_injected, v_court_injected, 'TD-ANOMALY-2', 'Drift Customer', 'drift@test.com', '09170009999',
            v_test_date, v_slot_1, v_slot_1 + interval '1 hour', 60, '08:00 AM - 09:00 AM', 'confirmed', 1000.00, '₱'
        );

        INSERT INTO public.payments (
            id, organization_id, facility_id, reservation_id, provider_name, provider_payment_id,
            status, currency, expected_amount, commission_rate, commission_amount, owner_gross_share,
            captured_amount, refunded_amount, checkout_session_id
        ) VALUES (
            v_fake_drift_pay_id, v_synth_org_injected, v_fac_injected, v_drift_res_id, 'paymongo', 'pay_anom_drift_001',
            'captured', 'PHP', 1000.00, 0.0500, 45.00, 955.00,
            1000.00, 0.00, 'cs_anom_drift_001'
        );

        SELECT * INTO v_found_disc
        FROM public.reconcile_organization_finances(v_synth_org_injected)
        WHERE discrepancy_code = 'COMMISSION_CALCULATION_DRIFT';

        IF v_found_disc.entity_id != v_fake_drift_pay_id OR v_found_disc.severity != 'ERROR' THEN
            RAISE EXCEPTION 'Anomaly 4.2 Failed: COMMISSION_CALCULATION_DRIFT not detected properly!';
        END IF;
    END;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Anomaly 4.2 - COMMISSION_CALCULATION_DRIFT correctly detected.', v_test_count;

    -- Re-enable payment validation trigger
    ALTER TABLE public.payments ENABLE TRIGGER trg_validate_payment_status_transition;

    -- -------------------------------------------------------------------------
    -- Anomaly 4.3: Captured Payment Missing Settlement Journal Detection
    -- -------------------------------------------------------------------------
    SELECT * INTO v_found_disc
    FROM public.reconcile_organization_finances(v_synth_org_injected)
    WHERE discrepancy_code = 'PAYMENT_MISSING_SETTLEMENT_JOURNAL';

    IF v_found_disc.entity_id != v_fake_pay_id1 OR v_found_disc.severity != 'ERROR' THEN
        RAISE EXCEPTION 'Anomaly 4.3 Failed: PAYMENT_MISSING_SETTLEMENT_JOURNAL not detected properly!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Anomaly 4.3 - PAYMENT_MISSING_SETTLEMENT_JOURNAL correctly detected for unjournaled captured payment.', v_test_count;

    -- -------------------------------------------------------------------------
    -- Anomaly 4.4: Transaction with Missing Entries Detection
    -- -------------------------------------------------------------------------
    ALTER TABLE public.financial_transactions DISABLE TRIGGER trg_enforce_financial_tx_canonical_hash;

    DECLARE
        v_fake_empty_tx UUID := gen_random_uuid();
    BEGIN
        INSERT INTO public.financial_transactions (
            id, organization_id, facility_id, transaction_type, idempotency_key, reference_id,
            description, canonical_payload_hash, metadata
        ) VALUES (
            v_fake_empty_tx, v_synth_org_injected, v_fac_injected, 'platform_adjustment', 'idem_empty_001', gen_random_uuid(),
            'Empty transaction without ledger entries', 'd41d8cd98f00b204e9800998ecf8427e', '{}'::jsonb
        );

        SELECT * INTO v_found_disc
        FROM public.reconcile_organization_finances(v_synth_org_injected)
        WHERE discrepancy_code = 'LEDGER_MISSING_ENTRIES';

        IF v_found_disc.entity_id != v_fake_empty_tx OR v_found_disc.severity != 'CRITICAL' THEN
            RAISE EXCEPTION 'Anomaly 4.4 Failed: LEDGER_MISSING_ENTRIES not detected properly!';
        END IF;
    END;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Anomaly 4.4 - LEDGER_MISSING_ENTRIES correctly detected as CRITICAL.', v_test_count;

    -- -------------------------------------------------------------------------
    -- Anomaly 4.5: Unbalanced Ledger Transaction Detection
    -- -------------------------------------------------------------------------
    -- Insert transaction and ledger entries satisfying composite FK (organization_id matches)
    -- but with Debits (₱500.00) != Credits (₱400.00)
    v_fake_tx_id := gen_random_uuid();
    INSERT INTO public.financial_transactions (
        id, organization_id, facility_id, transaction_type, idempotency_key, reference_id,
        description, canonical_payload_hash, metadata
    ) VALUES (
        v_fake_tx_id, v_synth_org_injected, v_fac_injected, 'platform_adjustment', 'idem_unbal_001', gen_random_uuid(),
        'Unbalanced synthetic test transaction', 'd41d8cd98f00b204e9800998ecf8427e', '{}'::jsonb
    );

    INSERT INTO public.ledger_entries (
        id, transaction_id, organization_id, account_code, entry_direction, amount, entry_order, running_balance
    ) VALUES
        (gen_random_uuid(), v_fake_tx_id, v_synth_org_injected, '1020', 'DEBIT', 500.00, 1, 500.00),
        (gen_random_uuid(), v_fake_tx_id, v_synth_org_injected, '2011', 'CREDIT', 400.00, 2, 400.00);

    SELECT * INTO v_found_disc
    FROM public.reconcile_organization_finances(v_synth_org_injected)
    WHERE discrepancy_code = 'LEDGER_UNBALANCED_TRANSACTION';

    IF v_found_disc.entity_id != v_fake_tx_id OR v_found_disc.severity != 'CRITICAL' THEN
        RAISE EXCEPTION 'Anomaly 4.5 Failed: LEDGER_UNBALANCED_TRANSACTION not detected properly!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Anomaly 4.5 - LEDGER_UNBALANCED_TRANSACTION correctly detected as CRITICAL.', v_test_count;

    ALTER TABLE public.financial_transactions ENABLE TRIGGER trg_enforce_financial_tx_canonical_hash;

    -- -------------------------------------------------------------------------
    -- Anomaly 4.6: Payout Invalid Journal Linkage Detection
    -- -------------------------------------------------------------------------
    -- Payout in approved_reserved status with NULL journal_reserve_tx_id
    ALTER TABLE public.payouts DISABLE TRIGGER trg_validate_payout_status_transition;

    DECLARE
        v_fake_payout UUID := gen_random_uuid();
    BEGIN
        INSERT INTO public.payouts (
            id, organization_id, payout_method_id, amount, currency, status,
            journal_reserve_tx_id, journal_terminal_tx_id
        ) VALUES (
            v_fake_payout, v_synth_org_injected, v_payout_method_id, 500.00, 'PHP', 'approved_reserved',
            NULL, NULL
        );

        SELECT * INTO v_found_disc
        FROM public.reconcile_organization_finances(v_synth_org_injected)
        WHERE discrepancy_code = 'PAYOUT_INVALID_JOURNAL_LINKAGE';

        IF v_found_disc.entity_id != v_fake_payout OR v_found_disc.severity != 'CRITICAL' THEN
            RAISE EXCEPTION 'Anomaly 4.6 Failed: PAYOUT_INVALID_JOURNAL_LINKAGE not detected properly!';
        END IF;
    END;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Anomaly 4.6 - PAYOUT_INVALID_JOURNAL_LINKAGE correctly detected as CRITICAL.', v_test_count;

    ALTER TABLE public.payouts ENABLE TRIGGER trg_validate_payout_status_transition;

    -- -------------------------------------------------------------------------
    -- Anomaly 4.7: Materialized Balance Sheet Drift & Decomposition Invariant Breach
    -- -------------------------------------------------------------------------
    -- Update organization_balances to induce ₱150 drift against General Ledger
    UPDATE public.organization_balances
    SET available_withdrawable_balance = available_withdrawable_balance + 150.00
    WHERE organization_id = v_synth_org_injected;

    SELECT * INTO v_found_disc
    FROM public.reconcile_organization_finances(v_synth_org_injected)
    WHERE discrepancy_code = 'BALANCE_AVAILABLE_WITHDRAWABLE_MISMATCH';

    IF v_found_disc.entity_id != v_synth_org_injected OR v_found_disc.severity != 'CRITICAL' THEN
        RAISE EXCEPTION 'Anomaly 4.7 Failed: BALANCE_AVAILABLE_WITHDRAWABLE_MISMATCH not detected properly!';
    END IF;

    SELECT * INTO v_found_disc
    FROM public.reconcile_organization_finances(v_synth_org_injected)
    WHERE discrepancy_code = 'BALANCE_DECOMPOSITION_INVARIANT_VIOLATION';

    IF v_found_disc.entity_id != v_synth_org_injected OR v_found_disc.severity != 'CRITICAL' THEN
        RAISE EXCEPTION 'Anomaly 4.7 Failed: BALANCE_DECOMPOSITION_INVARIANT_VIOLATION not detected properly!';
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Anomaly 4.7 - Materialized balance drift and Decomposition Invariant breach detected as CRITICAL.', v_test_count;

    -- -------------------------------------------------------------------------
    -- Anomaly 4.8: Summary Report Health Flagging for Anomalous Tenant
    -- -------------------------------------------------------------------------
    v_summary := public.get_financial_reconciliation_summary(v_synth_org_injected);

    IF (v_summary->>'is_healthy')::BOOLEAN IS NOT FALSE OR
       (v_summary->>'critical_count')::INT <= 0 OR
       (v_summary->>'error_count')::INT <= 0 OR
       (v_summary->>'double_entry_balanced')::BOOLEAN IS NOT FALSE OR
       (v_summary->>'commission_policy_compliant')::BOOLEAN IS NOT FALSE THEN
        RAISE EXCEPTION 'Anomaly 4.8 Failed: get_financial_reconciliation_summary did not correctly flag unhealthy state! Got: %', v_summary;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Anomaly 4.8 - Reconciliation summary accurately flags is_healthy = false, critical_count = %, error_count = %.',
        v_test_count, (v_summary->>'critical_count'), (v_summary->>'error_count');


    -- =========================================================================
    -- PART 5: Cross-Tenant Isolation Verification (Control Tenant C)
    -- =========================================================================
    INSERT INTO public.organization_balances (
        organization_id, currency, total_gross_settled, total_commission_paid,
        unsettled_clearing_amount, available_withdrawable_balance, pending_payout_amount, total_withdrawn
    ) VALUES (
        v_synth_org_isolated, 'PHP', 0.00, 0.00, 0.00, 0.00, 0.00, 0.00
    );

    SELECT count(*) INTO v_disc_count
    FROM public.reconcile_organization_finances(v_synth_org_isolated);

    IF v_disc_count != 0 THEN
        RAISE EXCEPTION 'Part 5 Failed: Isolated tenant reported % discrepancies! Cross-tenant isolation failure.', v_disc_count;
    END IF;

    v_summary := public.get_financial_reconciliation_summary(v_synth_org_isolated);
    IF (v_summary->>'is_healthy')::BOOLEAN IS NOT TRUE OR
       (v_summary->>'total_discrepancies')::INT != 0 THEN
        RAISE EXCEPTION 'Part 5 Failed: Isolated tenant summary is unhealthy! Got: %', v_summary;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Part 5 - Cross-tenant isolation verified: Tenant C is completely pristine and unaffected by Tenant B anomalies.', v_test_count;


    -- =========================================================================
    -- PART 6: Role-Based Access Control Using Real PostgreSQL Roles
    -- =========================================================================

    -- -------------------------------------------------------------------------
    -- Test 6.1: Real PostgreSQL 'anon' Role Rejected on Both Functions & Views
    -- -------------------------------------------------------------------------
    SET ROLE anon;
    BEGIN
        PERFORM * FROM public.reconcile_organization_finances(v_synth_org_valid);
        RAISE EXCEPTION 'Test 6.1a Failed: Actual anon PostgreSQL role was able to run reconcile_organization_finances!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Access denied%' OR SQLERRM LIKE '%permission denied%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test % PASSED: Test 6.1a - Actual anon PostgreSQL role strictly blocked from reconcile_organization_finances.', v_test_count;
        ELSE
            RAISE EXCEPTION 'Test 6.1a Failed with unexpected error: %', SQLERRM;
        END IF;
    END;

    BEGIN
        PERFORM public.get_financial_reconciliation_summary(v_synth_org_valid);
        RAISE EXCEPTION 'Test 6.1b Failed: Actual anon PostgreSQL role was able to run get_financial_reconciliation_summary!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Access denied%' OR SQLERRM LIKE '%permission denied%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test % PASSED: Test 6.1b - Actual anon PostgreSQL role strictly blocked from get_financial_reconciliation_summary.', v_test_count;
        ELSE
            RAISE EXCEPTION 'Test 6.1b Failed with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- Test 6.2: Real PostgreSQL 'authenticated' Role - Outsider User Rejected
    -- -------------------------------------------------------------------------
    SET ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_outsider_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    BEGIN
        PERFORM * FROM public.reconcile_organization_finances(v_synth_org_valid);
        RAISE EXCEPTION 'Test 6.2a Failed: Outsider authenticated user was able to run reconcile_organization_finances!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Access denied: Only organization owners and admins%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test % PASSED: Test 6.2a - Outsider authenticated user strictly blocked from reconcile_organization_finances.', v_test_count;
        ELSE
            RAISE EXCEPTION 'Test 6.2a Failed with unexpected error: %', SQLERRM;
        END IF;
    END;

    BEGIN
        PERFORM public.get_financial_reconciliation_summary(v_synth_org_valid);
        RAISE EXCEPTION 'Test 6.2b Failed: Outsider authenticated user was able to run get_financial_reconciliation_summary!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Access denied: Only organization owners and admins%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test % PASSED: Test 6.2b - Outsider authenticated user strictly blocked from get_financial_reconciliation_summary.', v_test_count;
        ELSE
            RAISE EXCEPTION 'Test 6.2b Failed with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- Audit view isolation for outsider
    DECLARE
        v_view_row_count INT;
    BEGIN
        SELECT count(*) INTO v_view_row_count
        FROM public.v_financial_reconciliation_overview
        WHERE organization_id = v_synth_org_valid;

        IF v_view_row_count != 0 THEN
            RAISE EXCEPTION 'Test 6.2c Failed: Outsider was able to view organization overview via v_financial_reconciliation_overview!';
        END IF;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test % PASSED: Test 6.2c - Outsider sees 0 rows in v_financial_reconciliation_overview.', v_test_count;
    END;

    -- -------------------------------------------------------------------------
    -- Test 6.3: Real PostgreSQL 'authenticated' Role - Staff User Rejected
    -- -------------------------------------------------------------------------
    SET ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_staff_valid::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    BEGIN
        PERFORM * FROM public.reconcile_organization_finances(v_synth_org_valid);
        RAISE EXCEPTION 'Test 6.3a Failed: Staff user was able to run reconcile_organization_finances!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Access denied: Only organization owners and admins%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test % PASSED: Test 6.3a - Staff user strictly blocked from reconcile_organization_finances.', v_test_count;
        ELSE
            RAISE EXCEPTION 'Test 6.3a Failed with unexpected error: %', SQLERRM;
        END IF;
    END;

    BEGIN
        PERFORM public.get_financial_reconciliation_summary(v_synth_org_valid);
        RAISE EXCEPTION 'Test 6.3b Failed: Staff user was able to run get_financial_reconciliation_summary!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Access denied: Only organization owners and admins%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test % PASSED: Test 6.3b - Staff user strictly blocked from get_financial_reconciliation_summary.', v_test_count;
        ELSE
            RAISE EXCEPTION 'Test 6.3b Failed with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- Test 6.4: Real PostgreSQL 'authenticated' Role - Cross-Tenant Owner Rejected
    -- -------------------------------------------------------------------------
    SET ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_owner_injected::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    BEGIN
        PERFORM * FROM public.reconcile_organization_finances(v_synth_org_valid);
        RAISE EXCEPTION 'Test 6.4a Failed: Cross-tenant owner was able to run reconcile_organization_finances on another organization!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Access denied: Only organization owners and admins%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test % PASSED: Test 6.4a - Cross-tenant owner strictly blocked from reconcile_organization_finances.', v_test_count;
        ELSE
            RAISE EXCEPTION 'Test 6.4a Failed with unexpected error: %', SQLERRM;
        END IF;
    END;

    BEGIN
        PERFORM public.get_financial_reconciliation_summary(v_synth_org_valid);
        RAISE EXCEPTION 'Test 6.4b Failed: Cross-tenant owner was able to run get_financial_reconciliation_summary on another organization!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Access denied: Only organization owners and admins%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test % PASSED: Test 6.4b - Cross-tenant owner strictly blocked from get_financial_reconciliation_summary.', v_test_count;
        ELSE
            RAISE EXCEPTION 'Test 6.4b Failed with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- Test 6.5: Authenticated Client Calling Without explicit organization_id Rejected
    -- -------------------------------------------------------------------------
    SET ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_owner_valid::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    BEGIN
        PERFORM * FROM public.reconcile_organization_finances(NULL);
        RAISE EXCEPTION 'Test 6.5a Failed: Authenticated client was able to run global reconcile_organization_finances without organization_id!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Access denied: Authenticated clients must provide an explicit organization_id%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test % PASSED: Test 6.5a - Global scan blocked for authenticated clients on reconcile_organization_finances.', v_test_count;
        ELSE
            RAISE EXCEPTION 'Test 6.5a Failed with unexpected error: %', SQLERRM;
        END IF;
    END;

    BEGIN
        PERFORM public.get_financial_reconciliation_summary(NULL);
        RAISE EXCEPTION 'Test 6.5b Failed: Authenticated client was able to run global get_financial_reconciliation_summary without organization_id!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Access denied: Authenticated clients must provide an explicit organization_id%' THEN
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test % PASSED: Test 6.5b - Global scan blocked for authenticated clients on get_financial_reconciliation_summary.', v_test_count;
        ELSE
            RAISE EXCEPTION 'Test 6.5b Failed with unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- Test 6.6: Legitimate Owner Permitted Access to Both Functions & Views
    -- -------------------------------------------------------------------------
    SET ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_owner_valid::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    SELECT count(*) INTO v_disc_count
    FROM public.reconcile_organization_finances(v_synth_org_valid);

    IF v_disc_count != 0 THEN
        RAISE EXCEPTION 'Test 6.6a Failed: Legitimate owner returned % discrepancies!', v_disc_count;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Test 6.6a - Legitimate organization owner permitted to execute reconcile_organization_finances.', v_test_count;

    v_summary := public.get_financial_reconciliation_summary(v_synth_org_valid);
    IF (v_summary->>'is_healthy')::BOOLEAN IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 6.6b Failed: Legitimate owner get_financial_reconciliation_summary not healthy! Got: %', v_summary;
    END IF;
    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test % PASSED: Test 6.6b - Legitimate organization owner permitted to execute get_financial_reconciliation_summary.', v_test_count;

    -- Audit view visibility for legitimate owner
    DECLARE
        v_view_row_count INT;
    BEGIN
        SELECT count(*) INTO v_view_row_count
        FROM public.v_financial_reconciliation_overview
        WHERE organization_id = v_synth_org_valid;

        IF v_view_row_count != 1 THEN
            RAISE EXCEPTION 'Test 6.6c Failed: Legitimate owner could not view organization overview via v_financial_reconciliation_overview! Count: %', v_view_row_count;
        END IF;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test % PASSED: Test 6.6c - Legitimate owner successfully views organization row in v_financial_reconciliation_overview.', v_test_count;
    END;

    -- Reset role to privileged backend session
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== ALL % RECONCILIATION TESTS COMPLETED SUCCESSFULLY               ===', v_test_count;
    RAISE NOTICE '========================================================================';
END $$;

-- Strictly rollback all synthetic operations to leave database completely pristine
ROLLBACK;
