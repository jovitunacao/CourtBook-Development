-- ==============================================================================
-- CourtBook / BookSuite — Phase 4.2.2 Financial Ledger Hardening Test Script
-- File: tests/supabase/fixtures/005a2_ledger_hardening_test.sql
-- Description: Isolated Verification Test Suite for Migration 005a2
-- Target: Isolated Supabase Testing Project ONLY (DO NOT RUN ON PRODUCTION)
--
-- EXECUTION ENVIRONMENT:
--   Runs entirely within a BEGIN ... ROLLBACK transaction block to guarantee
--   zero side effects on database state.
--
-- TESTS:
--   1. NULL canonical_payload_hash rejection (NOT NULL constraint or trigger)
--   2. Malformed canonical_payload_hash rejection (32-char lowercase MD5 hex)
--   3. Valid 5% (0.0500) commission booking_settlement & idempotency conflict detection
--   4. Invalid debit/credit direction rejection in post_journal_entry_internal()
--   5. Non-positive (0.00) ledger_entries.amount rejection (CHECK or trigger)
--   6. Unbalanced journal transaction rejection in post_journal_entry_internal()
-- ==============================================================================

BEGIN;

DO $$
DECLARE
    -- Synthetic Test Fixture IDs
    v_synth_org_id UUID := gen_random_uuid();
    v_synth_fac_id UUID := gen_random_uuid();
    v_synth_court_id UUID := gen_random_uuid();
    v_synth_res_id UUID := gen_random_uuid();

    v_post_res JSONB;
    v_tx_id UUID;
    v_expected_failed BOOLEAN;
BEGIN
    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== Phase 4.2.2 Migration 005a2 Ledger Hardening Test Suite          ===';
    RAISE NOTICE '========================================================================';

    -- -------------------------------------------------------------------------
    -- 0. Provision Synthetic Test Entities
    -- -------------------------------------------------------------------------
    INSERT INTO public.organizations (id, name, slug, billing_email)
    VALUES (
        v_synth_org_id,
        '005a2 Hardening Test Org',
        'synth-org-005a2-' || substr(gen_random_uuid()::text, 1, 8),
        'hardening-test@example.com'
    );

    -- Ensure organization_balances row exists (seeded automatically or upserted)
    INSERT INTO public.organization_balances (
        organization_id, currency, total_gross_settled, total_commission_paid,
        total_withdrawn, pending_payout_amount, unsettled_clearing_amount,
        restricted_reserve_amount, available_withdrawable_balance, negative_recovery_balance
    ) VALUES (
        v_synth_org_id, 'PHP', 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00
    ) ON CONFLICT (organization_id) DO NOTHING;

    INSERT INTO public.facilities (
        id, organization_id, name, slug, currency, default_hourly_rate, booking_confirmation_mode
    ) VALUES (
        v_synth_fac_id,
        v_synth_org_id,
        '005a2 Hardening Test Facility',
        'synth-fac-005a2-' || substr(gen_random_uuid()::text, 1, 8),
        '₱',
        350.00,
        'instant'
    );

    INSERT INTO public.courts (id, facility_id, name, sport_type, hourly_rate)
    VALUES (v_synth_court_id, v_synth_fac_id, 'Court A', 'pickleball', 350.00);

    INSERT INTO public.reservations (
        id, facility_id, court_id, reference_code, customer_name, customer_email,
        booking_date, start_time, end_time, time_slot_label, duration_minutes,
        price, currency, status
    ) VALUES (
        v_synth_res_id,
        v_synth_fac_id,
        v_synth_court_id,
        'RES-005A2-' || substr(gen_random_uuid()::text, 1, 6),
        'Test Player',
        'player@example.com',
        CURRENT_DATE,
        now() + interval '1 hour',
        now() + interval '2 hours',
        '10:00 - 11:00',
        60,
        350.00,
        '₱',
        'confirmed'
    );

    RAISE NOTICE 'Setup: Synthetic test entities provisioned successfully.';

    -- -------------------------------------------------------------------------
    -- TEST 1: NULL canonical_payload_hash must be rejected
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.financial_transactions (
            organization_id, facility_id, transaction_type, idempotency_key,
            reference_id, description, canonical_payload_hash
        ) VALUES (
            v_synth_org_id, v_synth_fac_id, 'booking_settlement', 'idem_005a2_null_hash_01',
            v_synth_res_id, 'Test NULL hash rejection', NULL
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('23502', 'P0001') AND (SQLERRM LIKE '%canonical_payload_hash%') THEN
            v_expected_failed := true;
            RAISE NOTICE 'Test 1 PASSED: NULL canonical_payload_hash rejected as expected (SQLSTATE: %, MSG: %)', SQLSTATE, SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 1 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 1 FAILED: NULL canonical_payload_hash was accepted without error!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 2: Malformed canonical_payload_hash must be rejected
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.financial_transactions (
            organization_id, facility_id, transaction_type, idempotency_key,
            reference_id, description, canonical_payload_hash
        ) VALUES (
            v_synth_org_id, v_synth_fac_id, 'booking_settlement', 'idem_005a2_bad_hash_01',
            v_synth_res_id, 'Test malformed hash rejection', 'not_a_valid_32_char_md5_hash'
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('23514', 'P0001') AND (
            SQLERRM LIKE '%canonical_payload_hash%' OR
            SQLERRM LIKE '%chk_financial_tx_canonical_hash_md5%'
        ) THEN
            v_expected_failed := true;
            RAISE NOTICE 'Test 2 PASSED: Malformed canonical_payload_hash rejected as expected (SQLSTATE: %, MSG: %)', SQLSTATE, SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 2 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 2 FAILED: Malformed canonical_payload_hash was accepted without error!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 3A: Valid 5% (0.0500) commission booking_settlement must post
    -- -------------------------------------------------------------------------
    v_post_res := public.post_booking_settlement_event(
        v_synth_org_id,
        v_synth_fac_id,
        v_synth_res_id,
        350.00,
        0.0500,
        'idem_005a2_valid_booking_01',
        '{"source": "005a2_test"}'::jsonb
    );

    IF (v_post_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 3A FAILED: Valid booking_settlement failed to post. Result: %', v_post_res;
    END IF;
    v_tx_id := (v_post_res->>'transaction_id')::UUID;
    RAISE NOTICE 'Test 3A PASSED: Valid 5%% (0.0500) commission booking_settlement posted (Tx ID: %).', v_tx_id;

    -- -------------------------------------------------------------------------
    -- TEST 3B: Idempotency conflict detection on altered terms
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        -- Replay with same idempotency key but different financial allocation/metadata
        PERFORM public.post_journal_entry_internal(
            v_synth_org_id,
            v_synth_fac_id,
            'booking_settlement',
            'idem_005a2_valid_booking_01',
            v_synth_res_id,
            'Tampered replay attempt',
            '{"provider_event_id": "tampered_evt"}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', 350.00),
                jsonb_build_object('account_code', '4010', 'entry_direction', 'CREDIT', 'amount', 25.00),
                jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', 325.00)
            )
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = 'P0001' AND SQLERRM LIKE '%Idempotency conflict%' THEN
            v_expected_failed := true;
            RAISE NOTICE 'Test 3B PASSED: Idempotency conflict detected and rejected (MSG: %)', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 3B FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 3B FAILED: Idempotency replay with altered financial parameters was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 4: Invalid debit/credit direction in post_journal_entry_internal()
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        PERFORM public.post_journal_entry_internal(
            v_synth_org_id,
            v_synth_fac_id,
            'booking_settlement',
            'idem_005a2_bad_dir_01',
            gen_random_uuid(),
            'Test invalid debit account',
            '{}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('account_code', '4010', 'entry_direction', 'DEBIT', 'amount', 100.00),
                jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', 100.00)
            )
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = 'P0001' AND SQLERRM LIKE '%booking_settlement DEBIT must target 1010%' THEN
            v_expected_failed := true;
            RAISE NOTICE 'Test 4 PASSED: Invalid debit direction on booking_settlement rejected (MSG: %)', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 4 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 4 FAILED: Invalid DEBIT account direction was accepted without error!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 5: Non-positive ledger_entries.amount must be rejected
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.ledger_entries (
            transaction_id, organization_id, account_code, entry_direction,
            amount, entry_order, running_balance
        ) VALUES (
            v_tx_id, v_synth_org_id, '1010', 'DEBIT', 0.00, 99, 0.00
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('23514', 'P0001') AND (
            SQLERRM LIKE '%strictly positive%' OR
            SQLERRM LIKE '%amount%' OR
            SQLERRM LIKE '%ledger_entries_amount_check%'
        ) THEN
            v_expected_failed := true;
            RAISE NOTICE 'Test 5 PASSED: Non-positive ledger_entries.amount rejected (SQLSTATE: %, MSG: %)', SQLSTATE, SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 5 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 5 FAILED: Zero amount ledger entry was accepted without error!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 6: Unbalanced journal transaction must be rejected
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        PERFORM public.post_journal_entry_internal(
            v_synth_org_id,
            v_synth_fac_id,
            'booking_settlement',
            'idem_005a2_unbalanced_01',
            gen_random_uuid(),
            'Test unbalanced entry',
            '{}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', 100.00),
                jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', 90.00)
            )
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = 'P0001' AND SQLERRM LIKE '%Unbalanced journal transaction%' THEN
            v_expected_failed := true;
            RAISE NOTICE 'Test 6 PASSED: Unbalanced journal transaction rejected as expected (MSG: %)', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 6 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 6 FAILED: Unbalanced journal transaction was accepted without error!';
    END IF;

    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== ALL 005a2 LEDGER HARDENING TESTS PASSED SUCCESSFULLY             ===';
    RAISE NOTICE '========================================================================';
END $$;

ROLLBACK;
