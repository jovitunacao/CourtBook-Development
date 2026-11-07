-- ==============================================================================
-- CourtBook / BookSuite — Test Fixture SQL
-- File: tests/supabase/fixtures/005b1_existing_infrastructure_test.sql
-- Description: Isolated Verification Test Suite for Non-Destructive Migration 005b1
--
-- TARGET ENVIRONMENT:
--   BookSuite-Payment-Test (Executed ONLY in isolated, rollback-only transaction)
--
-- OBJECTIVES & COVERAGE:
--   1. Existing Record Preservation: Verify existing pending payments and platform fee controls.
--   2. Constraint Hardening: Verify uq_payouts_id_org, composite journal FKs, and log FK.
--   3. Cross-Tenant Constraints: Reject cross-tenant payout methods, journals, and logs.
--   4. Append-Only Protections: Payout lifecycle audit logs reject UPDATE and DELETE.
--   5. Hardened Payment & Payout Invariants:
--      - Pending payment same-status update cannot acquire captured funds.
--      - Terminal payment mutation freeze.
--      - Mandatory reserve journal on approved_reserved.
--      - Mandatory disbursement journal on paid.
--      - Mandatory release journal on reserved payout fail/cancel.
--      - Rejection of spurious release journal on unreserved payout fail/cancel.
--      - Terminal payout freeze.
--   6. RLS & Column Privileges:
--      - Owner/admin access to payouts and lifecycle logs.
--      - Non-owner/staff blocked from payouts and lifecycle logs.
--      - provider_recipient_token column-level access denied.
--      - v_masked_payout_methods projection verified.
--
-- ARCHITECTURAL NOTE ON TEST METHODOLOGY:
--   In this infrastructure test suite, financial_transactions rows are provisioned
--   directly as mock transaction header rows.
--   - Purpose: Verifies table-level foreign keys (fk_payouts_journal_reserve_org,
--     fk_payouts_journal_terminal_org) and state-machine trigger validation
--     (fn_validate_payout_status_transition).
--   - Distinct From: Full double-entry ledger postings, running balance updates,
--     and balance-reconciliation tests (which require real post_journal_entry_internal()
--     execution and are verified in 005a2_journal_hardening_test.sql and Phase 4.2.4 tests).
-- ==============================================================================

BEGIN;

DO $$
DECLARE
    -- Test tracking
    v_test_count INT := 0;
    v_expected_failed BOOLEAN := false;

    -- Existing records baseline tracking
    v_existing_payment_count INT;
    v_existing_fee_controls_count INT;

    -- Synthetic Tenant A
    v_synth_org_a UUID := gen_random_uuid();
    v_synth_fac_a UUID := gen_random_uuid();
    v_synth_court_a UUID := gen_random_uuid();
    v_synth_res_a UUID := gen_random_uuid();
    v_synth_res_c UUID := gen_random_uuid();
    v_owner_a_uid UUID := gen_random_uuid();
    v_staff_a_uid UUID := gen_random_uuid();

    -- Synthetic Tenant B
    v_synth_org_b UUID := gen_random_uuid();
    v_synth_fac_b UUID := gen_random_uuid();
    v_synth_court_b UUID := gen_random_uuid();
    v_synth_res_b UUID := gen_random_uuid();
    v_owner_b_uid UUID := gen_random_uuid();

    -- Operational test handles
    v_payout_method_id_a UUID;
    v_payout_method_id_b UUID;
    v_payout_test_id UUID;
BEGIN
    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== Migration 005b1: Existing Infrastructure Hardening Test Suite    ===';
    RAISE NOTICE '========================================================================';

    -- -------------------------------------------------------------------------
    -- TEST 1: Existing Record Preservation & Baseline Audit
    -- -------------------------------------------------------------------------
    SELECT count(*) INTO v_existing_payment_count FROM public.payments;
    IF v_existing_payment_count < 2 THEN
        RAISE EXCEPTION 'Test 1 Failed: Expected at least 2 existing payments in BookSuite-Payment-Test, found %!', v_existing_payment_count;
    END IF;

    -- Verify the existing records conform to pending manual_test invariants
    IF EXISTS (
        SELECT 1 FROM public.payments
        WHERE status = 'pending' AND (captured_amount > 0.00 OR captured_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'Test 1 Failed: Existing pending payments possess corrupted capture state!';
    END IF;

    SELECT count(*) INTO v_existing_fee_controls_count FROM public.platform_fee_policy_controls WHERE id = 1;
    IF v_existing_fee_controls_count != 1 THEN
        RAISE EXCEPTION 'Test 1 Failed: platform_fee_policy_controls(id = 1) is missing or corrupted!';
    END IF;

    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 1 PASSED: Baseline audit verified % existing payment(s) and singleton fee controls preserved.', v_existing_payment_count;

    -- -------------------------------------------------------------------------
    -- TEST 2: Schema & Constraint Hardening Verification
    -- -------------------------------------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_payouts_id_org' AND conrelid = 'public.payouts'::regclass
    ) THEN
        RAISE EXCEPTION 'Test 2 Failed: Missing composite unique constraint uq_payouts_id_org on public.payouts!';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_payouts_method_org' AND conrelid = 'public.payouts'::regclass
    ) THEN
        RAISE EXCEPTION 'Test 2 Failed: Missing composite foreign key fk_payouts_method_org on public.payouts!';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_payouts_journal_reserve_org' AND conrelid = 'public.payouts'::regclass
    ) THEN
        RAISE EXCEPTION 'Test 2 Failed: Missing composite foreign key fk_payouts_journal_reserve_org on public.payouts!';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_payouts_journal_terminal_org' AND conrelid = 'public.payouts'::regclass
    ) THEN
        RAISE EXCEPTION 'Test 2 Failed: Missing composite foreign key fk_payouts_journal_terminal_org on public.payouts!';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_payout_lifecycle_logs_payout_org' AND conrelid = 'public.payout_lifecycle_logs'::regclass
    ) THEN
        RAISE EXCEPTION 'Test 2 Failed: Missing composite foreign key fk_payout_lifecycle_logs_payout_org on public.payout_lifecycle_logs!';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_protect_payout_lifecycle_logs_immutability'
          AND tgrelid = 'public.payout_lifecycle_logs'::regclass
    ) THEN
        RAISE EXCEPTION 'Test 2 Failed: Missing trigger trg_protect_payout_lifecycle_logs_immutability on public.payout_lifecycle_logs!';
    END IF;

    v_test_count := v_test_count + 1;
    RAISE NOTICE 'Test 2 PASSED: All 005b1 constraints and immutability triggers confirmed present in system catalog.';

    -- -------------------------------------------------------------------------
    -- Setup Synthetic Entities for Operational Tests
    -- -------------------------------------------------------------------------
    INSERT INTO public.organizations (id, name, slug, billing_email)
    VALUES
        (v_synth_org_a, 'Synthetic Tennis Club 005b1-A', 'synth-tennis-005b1-a-' || substr(gen_random_uuid()::text, 1, 8), 'billing-a@example.com'),
        (v_synth_org_b, 'Synthetic Squash Club 005b1-B', 'synth-squash-005b1-b-' || substr(gen_random_uuid()::text, 1, 8), 'billing-b@example.com');

    INSERT INTO public.facilities (id, organization_id, name, slug, currency, default_hourly_rate, booking_confirmation_mode)
    VALUES
        (v_synth_fac_a, v_synth_org_a, 'Facility 005b1-A', 'synth-fac-005b1-a-' || substr(gen_random_uuid()::text, 1, 8), '₱', 350.00, 'instant'),
        (v_synth_fac_b, v_synth_org_b, 'Facility 005b1-B', 'synth-fac-005b1-b-' || substr(gen_random_uuid()::text, 1, 8), '₱', 400.00, 'instant');

    INSERT INTO public.courts (id, facility_id, name, sport_type, hourly_rate)
    VALUES
        (v_synth_court_a, v_synth_fac_a, 'Court 005b1-A1', 'tennis', 350.00),
        (v_synth_court_b, v_synth_fac_b, 'Court 005b1-B1', 'squash', 400.00);

    INSERT INTO public.reservations (
        id, facility_id, court_id, reference_code, customer_name, customer_email,
        booking_date, start_time, end_time, time_slot_label, duration_minutes, price, currency, status
    ) VALUES (
        v_synth_res_a, v_synth_fac_a, v_synth_court_a, 'SYNTH-RES-05B1-A', 'Customer A', 'customer.a@example.com',
        CURRENT_DATE, now() + interval '1 hour', now() + interval '2 hours', '09:00 - 10:00', 60, 350.00, '₱', 'confirmed'
    ), (
        v_synth_res_b, v_synth_fac_b, v_synth_court_b, 'SYNTH-RES-05B1-B', 'Customer B', 'customer.b@example.com',
        CURRENT_DATE, now() + interval '2 hours', now() + interval '3 hours', '10:00 - 11:00', 60, 400.00, '₱', 'confirmed'
    ), (
        v_synth_res_c, v_synth_fac_a, v_synth_court_a, 'SYNTH-RES-05B1-C', 'Customer C', 'customer.c@example.com',
        CURRENT_DATE, now() + interval '3 hours', now() + interval '4 hours', '11:00 - 12:00', 60, 350.00, '₱', 'confirmed'
    );

    -- Setup Organization Members (Owner A, Staff A, Owner B)
    INSERT INTO public.organization_members (organization_id, user_id, role)
    VALUES
        (v_synth_org_a, v_owner_a_uid, 'owner'),
        (v_synth_org_a, v_staff_a_uid, 'staff'),
        (v_synth_org_b, v_owner_b_uid, 'owner');

    PERFORM set_config('app.test_owner_a_uid', v_owner_a_uid::text, false);
    PERFORM set_config('app.test_staff_a_uid', v_staff_a_uid::text, false);
    PERFORM set_config('app.test_owner_b_uid', v_owner_b_uid::text, false);
    PERFORM set_config('app.test_org_a', v_synth_org_a::text, false);
    PERFORM set_config('app.test_org_b', v_synth_org_b::text, false);

    -- Setup Valid Payout Methods
    INSERT INTO public.payout_methods (
        id, organization_id, method_type, provider_name, provider_recipient_token,
        account_holder_name, masked_account_number, bank_code, bank_name, is_active, is_default, verification_status
    ) VALUES (
        gen_random_uuid(), v_synth_org_a, 'bank_transfer', 'paymongo', 'tok_recip_a_secret_05b1',
        'Owner Juan 005b1-A', '****9012', 'BDO', 'Banco de Oro', true, true, 'verified'
    ) RETURNING id INTO v_payout_method_id_a;

    INSERT INTO public.payout_methods (
        id, organization_id, method_type, provider_name, provider_recipient_token,
        account_holder_name, masked_account_number, bank_code, bank_name, is_active, is_default, verification_status
    ) VALUES (
        gen_random_uuid(), v_synth_org_b, 'bank_transfer', 'paymongo', 'tok_recip_b_secret_05b1',
        'Owner Maria 005b1-B', '****7777', 'BPI', 'Bank of the Philippine Islands', true, true, 'verified'
    ) RETURNING id INTO v_payout_method_id_b;

    -- -------------------------------------------------------------------------
    -- TEST 3: Cross-Tenant Payout Method Rejection (fk_payouts_method_org)
    -- -------------------------------------------------------------------------
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
            RAISE NOTICE 'Test 3 PASSED: Cross-tenant payout method reference rejected by fk_payouts_method_org.';
        WHEN OTHERS THEN
            IF SQLSTATE = '23503' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 3 PASSED: Cross-tenant payout method reference rejected by fk_payouts_method_org.';
            ELSE
                RAISE EXCEPTION 'Test 3 Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 3 Failed: Cross-tenant payout method was not rejected!';
    END IF;

    -- Create valid baseline payout for Org A
    v_payout_test_id := gen_random_uuid();
    INSERT INTO public.payouts (
        id, organization_id, payout_method_id, amount, status
    ) VALUES (
        v_payout_test_id, v_synth_org_a, v_payout_method_id_a, 500.00, 'pending_request'
    );

    -- -------------------------------------------------------------------------
    -- TEST 4: Cross-Tenant Payout Lifecycle Log Rejection (fk_payout_lifecycle_logs_payout_org)
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.payout_lifecycle_logs (
            payout_id, organization_id, from_status, to_status
        ) VALUES (
            v_payout_test_id, v_synth_org_b, 'pending_request', 'approved_reserved'
        );
    EXCEPTION
        WHEN foreign_key_violation THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 4 PASSED: Composite foreign key fk_payout_lifecycle_logs_payout_org rejected cross-tenant log.';
        WHEN OTHERS THEN
            IF SQLSTATE = '23503' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 4 PASSED: Composite foreign key fk_payout_lifecycle_logs_payout_org rejected cross-tenant log.';
            ELSE
                RAISE EXCEPTION 'Test 4 Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 4 Failed: Cross-organization payout log was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 5: Append-Only Immutability on Payout Lifecycle Logs
    -- -------------------------------------------------------------------------
    -- 5a: UPDATE rejection
    v_expected_failed := false;
    BEGIN
        UPDATE public.payout_lifecycle_logs
        SET to_status = 'tampered'
        WHERE payout_id = v_payout_test_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout lifecycle audit records are append-only and strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 5a PASSED: UPDATE on payout_lifecycle_logs rejected by append-only trigger.';
        ELSE
            RAISE EXCEPTION 'Test 5a Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 5a Failed: UPDATE on payout_lifecycle_logs was not rejected!';
    END IF;

    -- 5b: DELETE rejection
    v_expected_failed := false;
    BEGIN
        DELETE FROM public.payout_lifecycle_logs WHERE payout_id = v_payout_test_id;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Payout lifecycle audit records are append-only and strictly immutable%' THEN
            v_expected_failed := true;
            v_test_count := v_test_count + 1;
            RAISE NOTICE 'Test 5b PASSED: DELETE on payout_lifecycle_logs rejected by append-only trigger.';
        ELSE
            RAISE EXCEPTION 'Test 5b Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 5b Failed: DELETE on payout_lifecycle_logs was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 6: Payment Same-Status Invariant & Capture Protection
    -- -------------------------------------------------------------------------
    DECLARE
        v_pay_test UUID := gen_random_uuid();
    BEGIN
        INSERT INTO public.payments (
            id, organization_id, facility_id, reservation_id, expected_amount,
            commission_rate, commission_amount, owner_gross_share, status
        ) VALUES (
            v_pay_test, v_synth_org_a, v_synth_fac_a, v_synth_res_a,
            350.00, 0.0500, 17.50, 332.50, 'pending'
        );

        -- Attempting to acquire captured_amount without valid capture transition
        v_expected_failed := false;
        BEGIN
            UPDATE public.payments
            SET captured_amount = 350.00
            WHERE id = v_pay_test;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%cannot acquire captured funds without a valid capture transition%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 6 PASSED: Pending payment acquiring captured funds under same-status update rejected.';
            ELSE
                RAISE EXCEPTION 'Test 6 Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 6 Failed: Pending payment was able to acquire captured_amount under same-status update!';
        END IF;

        -- Legitimate capture transition
        UPDATE public.payments
        SET status = 'captured', captured_amount = 350.00, provider_name = 'paymongo', provider_payment_id = 'pay_005b1_capture_01'
        WHERE id = v_pay_test;

        -- Legitimate refund transition
        UPDATE public.payments
        SET status = 'refunded', refunded_amount = 350.00
        WHERE id = v_pay_test;

        -- ---------------------------------------------------------------------
        -- TEST 7: Terminal Payment Mutation Freeze
        -- ---------------------------------------------------------------------
        v_expected_failed := false;
        BEGIN
            UPDATE public.payments
            SET provider_payment_id = 'pay_tampered_after_terminal'
            WHERE id = v_pay_test;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%is in terminal status "refunded" and cannot be modified%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 7 PASSED: Terminal refunded payment is strictly immutable.';
            ELSE
                RAISE EXCEPTION 'Test 7 Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 7 Failed: Mutation on terminal refunded payment succeeded!';
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 8: Payout Journal Links Composite Foreign Key & Type Validation
    -- -------------------------------------------------------------------------
    -- NOTE: In this infrastructure suite, mock financial_transactions header rows
    -- are provisioned directly to test composite foreign keys and trigger validation
    -- on public.payouts without executing full ledger balance calculations.
    DECLARE
        v_ft_res_a UUID := gen_random_uuid();
        v_ft_res_b UUID := gen_random_uuid();
        v_ft_wrong_type UUID := gen_random_uuid();
        v_ft_term_a UUID := gen_random_uuid();
    BEGIN
        INSERT INTO public.financial_transactions (
            id, organization_id, facility_id, transaction_type,
            idempotency_key, reference_id, description, canonical_payload_hash
        ) VALUES (
            v_ft_res_a, v_synth_org_a, v_synth_fac_a, 'payout_reserve',
            'idem_05b1_res_a', v_payout_test_id, 'Test 005b1 Reserve Org A', md5('payload_05b1_res_a')
        ), (
            v_ft_res_b, v_synth_org_b, v_synth_fac_b, 'payout_reserve',
            'idem_05b1_res_b', gen_random_uuid(), 'Test 005b1 Reserve Org B', md5('payload_05b1_res_b')
        ), (
            v_ft_wrong_type, v_synth_org_a, v_synth_fac_a, 'booking_settlement',
            'idem_05b1_wrong', gen_random_uuid(), 'Test 005b1 Booking Settlement', md5('payload_05b1_wrong')
        ), (
            v_ft_term_a, v_synth_org_a, v_synth_fac_a, 'payout_disbursement',
            'idem_05b1_term_a', v_payout_test_id, 'Test 005b1 Disbursement Org A', md5('payload_05b1_term_a')
        );

        -- 8a: Cross-organization journal reserve reference must fail
        v_expected_failed := false;
        BEGIN
            UPDATE public.payouts
            SET status = 'approved_reserved', journal_reserve_tx_id = v_ft_res_b
            WHERE id = v_payout_test_id;
        EXCEPTION
            WHEN foreign_key_violation THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 8a PASSED: Composite foreign key fk_payouts_journal_reserve_org rejected cross-tenant journal link.';
            WHEN OTHERS THEN
                IF SQLERRM LIKE '%Invalid journal reserve transaction: Must reference an existing financial_transaction of type "payout_reserve" for organization%'
                   OR SQLSTATE = '23503' THEN
                    v_expected_failed := true;
                    v_test_count := v_test_count + 1;
                    RAISE NOTICE 'Test 8a PASSED: Cross-tenant journal reserve rejected by trigger validation or composite FK.';
                ELSE
                    RAISE EXCEPTION 'Test 8a Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
                END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 8a Failed: Cross-organization journal reserve was not rejected!';
        END IF;

        -- 8b: Transition to approved_reserved without journal_reserve_tx_id must fail
        v_expected_failed := false;
        BEGIN
            UPDATE public.payouts
            SET status = 'approved_reserved', journal_reserve_tx_id = NULL
            WHERE id = v_payout_test_id;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%cannot transition to "approved_reserved" without a valid payout_reserve journal transaction%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 8b PASSED: Transition to approved_reserved without reserve journal rejected.';
            ELSE
                RAISE EXCEPTION 'Test 8b Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 8b Failed: Payout reached approved_reserved without reserve journal!';
        END IF;

        -- Legitimate transition to approved_reserved
        UPDATE public.payouts
        SET status = 'approved_reserved', journal_reserve_tx_id = v_ft_res_a
        WHERE id = v_payout_test_id;

        -- Transition to submitted_to_provider
        UPDATE public.payouts
        SET status = 'submitted_to_provider', provider_payout_id = 'payout_prov_05b1_001'
        WHERE id = v_payout_test_id;

        -- 8c: Transition to paid without journal_terminal_tx_id must fail
        v_expected_failed := false;
        BEGIN
            UPDATE public.payouts
            SET status = 'paid', journal_terminal_tx_id = NULL
            WHERE id = v_payout_test_id;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%cannot transition to "paid" without a valid payout_disbursement journal transaction%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 8c PASSED: Transition to paid without disbursement journal rejected.';
            ELSE
                RAISE EXCEPTION 'Test 8c Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 8c Failed: Payout reached paid without disbursement journal!';
        END IF;

        -- Legitimate transition to paid
        UPDATE public.payouts
        SET status = 'paid', journal_terminal_tx_id = v_ft_term_a
        WHERE id = v_payout_test_id;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 8d PASSED: Valid payout full lifecycle transition to paid completed.';

        -- ---------------------------------------------------------------------
        -- TEST 9: Terminal Payout Mutation Freeze
        -- ---------------------------------------------------------------------
        v_expected_failed := false;
        BEGIN
            UPDATE public.payouts
            SET failure_reason = 'Attempted alteration after paid'
            WHERE id = v_payout_test_id;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%is in terminal status "paid" and cannot be modified%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 9 PASSED: Mutation on terminal paid payout strictly frozen.';
            ELSE
                RAISE EXCEPTION 'Test 9 Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 9 Failed: Mutation on terminal paid payout was not rejected!';
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 10: Reserved Payout Cancellation & Failure Journal Verification
    -- -------------------------------------------------------------------------
    -- 10a: Reserved payout transitioning to failed requires payout_failed_release journal
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
            'idem_05b1_res_term', v_payout_res_term, 'Test Reserve Hold', md5('payload_05b1_res_hold')
        ), (
            v_ft_rel_term, v_synth_org_a, v_synth_fac_a, 'payout_failed_release',
            'idem_05b1_rel_term', v_payout_res_term, 'Test Release Reserve', md5('payload_05b1_rel_hold')
        );

        UPDATE public.payouts
        SET status = 'approved_reserved', journal_reserve_tx_id = v_ft_res_term
        WHERE id = v_payout_res_term;

        v_expected_failed := false;
        BEGIN
            UPDATE public.payouts
            SET status = 'failed', journal_terminal_tx_id = NULL
            WHERE id = v_payout_res_term;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%requires a valid payout_failed_release journal transaction to release reserved funds%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 10a PASSED: Reserved payout transitioning to failed without release journal rejected.';
            ELSE
                RAISE EXCEPTION 'Test 10a Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 10a Failed: Reserved payout moved to failed without release journal!';
        END IF;

        -- Legitimate transition to failed with release journal
        UPDATE public.payouts
        SET status = 'failed', journal_terminal_tx_id = v_ft_rel_term, failure_reason = 'Provider bank rejection'
        WHERE id = v_payout_res_term;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 10a2 PASSED: Reserved payout moved to failed with valid payout_failed_release journal.';
    END;

    -- 10b: Reserved payout transitioning to cancelled requires payout_failed_release journal (Test 27h)
    DECLARE
        v_payout_res_cancel UUID := gen_random_uuid();
        v_ft_res_cancel UUID := gen_random_uuid();
        v_ft_rel_cancel UUID := gen_random_uuid();
    BEGIN
        INSERT INTO public.payouts (
            id, organization_id, payout_method_id, amount, status
        ) VALUES (
            v_payout_res_cancel, v_synth_org_a, v_payout_method_id_a, 450.00, 'pending_request'
        );

        INSERT INTO public.financial_transactions (
            id, organization_id, facility_id, transaction_type,
            idempotency_key, reference_id, description, canonical_payload_hash
        ) VALUES (
            v_ft_res_cancel, v_synth_org_a, v_synth_fac_a, 'payout_reserve',
            'idem_05b1_res_cancel', v_payout_res_cancel, 'Test Reserve Cancel Hold', md5('payload_05b1_res_cancel')
        ), (
            v_ft_rel_cancel, v_synth_org_a, v_synth_fac_a, 'payout_failed_release',
            'idem_05b1_rel_cancel', v_payout_res_cancel, 'Test Release Reserve Cancel', md5('payload_05b1_rel_cancel')
        );

        UPDATE public.payouts
        SET status = 'approved_reserved', journal_reserve_tx_id = v_ft_res_cancel
        WHERE id = v_payout_res_cancel;

        -- Attempt transition to cancelled without release journal
        v_expected_failed := false;
        BEGIN
            UPDATE public.payouts
            SET status = 'cancelled', journal_terminal_tx_id = NULL
            WHERE id = v_payout_res_cancel;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%Reserved payout % transitioning to "cancelled" requires a valid payout_failed_release journal transaction to release reserved funds%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 10b PASSED: Reserved payout transitioning to cancelled without release journal rejected.';
            ELSE
                RAISE EXCEPTION 'Test 10b Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 10b Failed: Reserved payout moved to cancelled without release journal!';
        END IF;

        -- Legitimate transition to cancelled with valid payout_failed_release journal
        UPDATE public.payouts
        SET status = 'cancelled', journal_terminal_tx_id = v_ft_rel_cancel
        WHERE id = v_payout_res_cancel;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 10b2 PASSED: Reserved payout moved to cancelled with valid payout_failed_release journal.';
    END;

    -- -------------------------------------------------------------------------
    -- TEST 11: Unreserved Payout Cancellation & Failure Journal Verification
    -- -------------------------------------------------------------------------
    -- 11a: Unreserved payout cancelling rejects spurious release journal (Test 27i)
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
            'idem_05b1_spurious', v_payout_unres, 'Spurious release', md5('payload_05b1_spurious')
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
                RAISE NOTICE 'Test 11a PASSED: Unreserved payout cancelling with spurious terminal journal rejected.';
            ELSE
                RAISE EXCEPTION 'Test 11a Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 11a Failed: Unreserved payout cancelled with spurious terminal journal!';
        END IF;

        -- Legitimate unreserved cancellation
        UPDATE public.payouts
        SET status = 'cancelled'
        WHERE id = v_payout_unres;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 11a2 PASSED: Unreserved payout safely cancelled without journal links.';
    END;

    -- 11b: Unreserved payout failing rejects spurious release journal (Test 27j)
    DECLARE
        v_payout_unres_fail UUID := gen_random_uuid();
        v_ft_spurious_fail UUID := gen_random_uuid();
    BEGIN
        INSERT INTO public.payouts (
            id, organization_id, payout_method_id, amount, status
        ) VALUES (
            v_payout_unres_fail, v_synth_org_a, v_payout_method_id_a, 250.00, 'pending_request'
        );

        INSERT INTO public.financial_transactions (
            id, organization_id, facility_id, transaction_type,
            idempotency_key, reference_id, description, canonical_payload_hash
        ) VALUES (
            v_ft_spurious_fail, v_synth_org_a, v_synth_fac_a, 'payout_failed_release',
            'idem_05b1_spurious_fail', v_payout_unres_fail, 'Spurious release fail test', md5('payload_05b1_spurious_fail')
        );

        v_expected_failed := false;
        BEGIN
            UPDATE public.payouts
            SET status = 'failed', journal_terminal_tx_id = v_ft_spurious_fail
            WHERE id = v_payout_unres_fail;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%Unreserved payout % transitioning to "failed" cannot specify a terminal release journal%' THEN
                v_expected_failed := true;
                v_test_count := v_test_count + 1;
                RAISE NOTICE 'Test 11b PASSED: Unreserved payout failing with spurious terminal journal rejected.';
            ELSE
                RAISE EXCEPTION 'Test 11b Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
            END IF;
        END;
        IF NOT v_expected_failed THEN
            RAISE EXCEPTION 'Test 11b Failed: Unreserved payout failed with spurious terminal journal!';
        END IF;

        -- Legitimate unreserved failure
        UPDATE public.payouts
        SET status = 'failed', failure_reason = 'Rejected before reserve allocation'
        WHERE id = v_payout_unres_fail;
        v_test_count := v_test_count + 1;
        RAISE NOTICE 'Test 11b2 PASSED: Unreserved payout safely moved to failed without journal links.';
    END;

    RAISE NOTICE '=== ALL % 005b1 INFRASTRUCTURE TESTS COMPLETED SUCCESSFULLY ===', v_test_count;
END $$;


-- ==============================================================================
-- 12. Row-Level Security & Privilege Verification Block
-- ==============================================================================

-- 12a: Authenticated Owner can query own payouts and lifecycle logs
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
    RAISE NOTICE 'Test 12a PASSED: Authenticated owner successfully queried payouts (% rows) and logs (% rows).', v_payout_count, v_log_count;
END $$;
RESET ROLE;

-- 12b: Authenticated Staff CANNOT query payouts (restricted to owner/admin)
SET LOCAL ROLE authenticated;
DO $$
DECLARE
    v_staff_a_uid UUID := current_setting('app.test_staff_a_uid', true)::UUID;
    v_payout_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_staff_a_uid::text, true);

    SELECT count(*) INTO v_payout_count FROM public.payouts;
    IF v_payout_count != 0 THEN
        RAISE EXCEPTION 'Security Breach: Staff member was able to view % payouts!', v_payout_count;
    END IF;
    RAISE NOTICE 'Test 12b PASSED: Staff member blocked by RLS from viewing sensitive payouts (0 rows returned).';
END $$;
RESET ROLE;

-- 12c: Authenticated Owner CANNOT select provider_recipient_token directly (column privilege denied)
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
        RAISE NOTICE 'Test 12c PASSED: Direct SELECT on provider_recipient_token column strictly denied by PostgreSQL column privileges.';
    END;
END $$;
RESET ROLE;

-- 12d: Safe projection view v_masked_payout_methods is accessible to Authenticated Owner
SET LOCAL ROLE authenticated;
DO $$
DECLARE
    v_owner_a_uid UUID := current_setting('app.test_owner_a_uid', true)::UUID;
    v_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_owner_a_uid::text, true);

    SELECT count(*) INTO v_count FROM public.v_masked_payout_methods;
    IF v_count < 1 THEN
        RAISE EXCEPTION 'Access Failure: Authenticated owner was unable to query v_masked_payout_methods!';
    END IF;
    RAISE NOTICE 'Test 12d PASSED: Authenticated owner successfully queried safe projection view (% rows).', v_count;
END $$;
RESET ROLE;

-- 12e: Cross-Tenant Owner (Owner B) cannot read Org A's payout methods
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
    RAISE NOTICE 'Test 12e PASSED: Cross-tenant owner blocked by RLS from viewing another organization payout methods (0 rows).';
END $$;
RESET ROLE;

-- ==============================================================================
-- Rollback entire synthetic test fixture: leaves persistent database pristine
-- ==============================================================================
ROLLBACK;
