-- ==============================================================================
-- CourtBook / BookSuite — Phase 4.2.2 Financial Ledger Hardening Test Script
-- File: tests/supabase/fixtures/005a2_ledger_hardening_test.sql
-- Description: Isolated Comprehensive Verification Test Suite for Migration 005a2
-- Target: Isolated Supabase Testing Project ONLY (DO NOT RUN ON PRODUCTION)
--
-- EXECUTION ENVIRONMENT:
--   Runs entirely within a BEGIN ... ROLLBACK transaction block to guarantee
--   zero side effects on database state.
--
-- VERIFICATION GATES:
--   1. Schema & Trigger Invariants: NULL and malformed canonical_payload_hash rejection
--   2. Non-positive ledger_entries.amount rejection (CHECK and trigger guards)
--   3. Authoritative ₱350 Settlement: Exact centavo verification (₱17.50 comm, ₱332.50 unsettled)
--   4. Identical Idempotent Replay: Idempotent duplicate returns true with zero duplicate lines
--   5. Idempotency Conflict Detection: Replay with altered terms is strictly rejected
--   6. Tenant Isolation / Cross-Organization Reference rejection
--   7. Transaction-Specific Direction Invariants in post_journal_entry_internal()
--   8. Centavo Balancing Invariant: Unbalanced entries strictly rejected
--   9. Transaction Rollback & Atomicity Guard: Failed transactions leave zero partial records
-- ==============================================================================

BEGIN;

DO $$
DECLARE
    -- Synthetic Test Entities: Organization A
    v_synth_org_a UUID := gen_random_uuid();
    v_synth_fac_a UUID := gen_random_uuid();
    v_synth_court_a UUID := gen_random_uuid();
    v_synth_res_a UUID := gen_random_uuid();

    -- Synthetic Test Entities: Organization B (for Cross-Tenant Isolation Tests)
    v_synth_org_b UUID := gen_random_uuid();
    v_synth_fac_b UUID := gen_random_uuid();
    v_synth_court_b UUID := gen_random_uuid();

    -- Return objects & validation records
    v_post_res JSONB;
    v_replay_res JSONB;
    v_tx_id UUID;
    v_tx_count INT;
    v_entry_count INT;
    v_org_bal RECORD;
    v_entry_rec RECORD;
    v_expected_failed BOOLEAN;
BEGIN
    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== Phase 4.2.2 Migration 005a2 Comprehensive Test Suite             ===';
    RAISE NOTICE '========================================================================';

    -- -------------------------------------------------------------------------
    -- 0. Provision Synthetic Test Entities (Satisfies 001-005a1 schema & triggers)
    -- -------------------------------------------------------------------------
    -- Organization A
    INSERT INTO public.organizations (id, name, slug, billing_email)
    VALUES (
        v_synth_org_a,
        '005a2 Test Org A',
        'synth-org-a-' || substr(gen_random_uuid()::text, 1, 8),
        'org-a@example.com'
    );

    -- Ensure organization_balances row exists (seeded automatically by trigger or upserted)
    INSERT INTO public.organization_balances (
        organization_id, currency, total_gross_settled, total_commission_paid,
        total_withdrawn, pending_payout_amount, unsettled_clearing_amount,
        restricted_reserve_amount, available_withdrawable_balance, negative_recovery_balance
    ) VALUES (
        v_synth_org_a, 'PHP', 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00
    ) ON CONFLICT (organization_id) DO NOTHING;

    INSERT INTO public.facilities (
        id, organization_id, name, slug, currency, default_hourly_rate, booking_confirmation_mode
    ) VALUES (
        v_synth_fac_a,
        v_synth_org_a,
        '005a2 Test Facility A',
        'synth-fac-a-' || substr(gen_random_uuid()::text, 1, 8),
        '₱',
        350.00,
        'instant'
    );

    INSERT INTO public.courts (id, facility_id, name, sport_type, hourly_rate)
    VALUES (v_synth_court_a, v_synth_fac_a, 'Court 1 Pickleball', 'pickleball', 350.00);

    INSERT INTO public.reservations (
        id, facility_id, court_id, reference_code, customer_name, customer_email,
        booking_date, start_time, end_time, time_slot_label, duration_minutes,
        price, currency, status
    ) VALUES (
        v_synth_res_a,
        v_synth_fac_a,
        v_synth_court_a,
        'RES-A-' || substr(gen_random_uuid()::text, 1, 8),
        'Customer Alpha',
        'alpha@example.com',
        CURRENT_DATE,
        now() + interval '1 hour',
        now() + interval '2 hours',
        '10:00 - 11:00',
        60,
        350.00,
        '₱',
        'confirmed'
    );

    -- Organization B (Tenant Isolation Fixtures)
    INSERT INTO public.organizations (id, name, slug, billing_email)
    VALUES (
        v_synth_org_b,
        '005a2 Test Org B',
        'synth-org-b-' || substr(gen_random_uuid()::text, 1, 8),
        'org-b@example.com'
    );

    INSERT INTO public.organization_balances (
        organization_id, currency, total_gross_settled, total_commission_paid,
        total_withdrawn, pending_payout_amount, unsettled_clearing_amount,
        restricted_reserve_amount, available_withdrawable_balance, negative_recovery_balance
    ) VALUES (
        v_synth_org_b, 'PHP', 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00
    ) ON CONFLICT (organization_id) DO NOTHING;

    INSERT INTO public.facilities (
        id, organization_id, name, slug, currency, default_hourly_rate, booking_confirmation_mode
    ) VALUES (
        v_synth_fac_b,
        v_synth_org_b,
        '005a2 Test Facility B',
        'synth-fac-b-' || substr(gen_random_uuid()::text, 1, 8),
        '₱',
        500.00,
        'instant'
    );

    INSERT INTO public.courts (id, facility_id, name, sport_type, hourly_rate)
    VALUES (v_synth_court_b, v_synth_fac_b, 'Court 1 Tennis', 'tennis', 500.00);

    RAISE NOTICE 'Setup: Synthetic test entities for Org A and Org B provisioned successfully.';

    -- -------------------------------------------------------------------------
    -- TEST 1: NULL canonical_payload_hash must be rejected
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.financial_transactions (
            organization_id, facility_id, transaction_type, idempotency_key,
            reference_id, description, canonical_payload_hash
        ) VALUES (
            v_synth_org_a, v_synth_fac_a, 'booking_settlement', 'idem_005a2_null_hash_01',
            v_synth_res_a, 'Test NULL hash rejection', NULL
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('23502', 'P0001') AND (SQLERRM LIKE '%canonical_payload_hash%') THEN
            v_expected_failed := true;
            RAISE NOTICE 'Test 1 PASSED: NULL canonical_payload_hash rejected (SQLSTATE: %, MSG: %)', SQLSTATE, SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 1 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 1 FAILED: NULL canonical_payload_hash was accepted without error!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 2: Malformed canonical_payload_hash must be rejected (non-32-char hex)
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.financial_transactions (
            organization_id, facility_id, transaction_type, idempotency_key,
            reference_id, description, canonical_payload_hash
        ) VALUES (
            v_synth_org_a, v_synth_fac_a, 'booking_settlement', 'idem_005a2_bad_hash_01',
            v_synth_res_a, 'Test malformed hash rejection', 'not_a_valid_32_char_md5_hash'
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('23514', 'P0001') AND (
            SQLERRM LIKE '%canonical_payload_hash%' OR
            SQLERRM LIKE '%chk_financial_tx_canonical_hash_md5%'
        ) THEN
            v_expected_failed := true;
            RAISE NOTICE 'Test 2 PASSED: Malformed canonical_payload_hash rejected (SQLSTATE: %, MSG: %)', SQLSTATE, SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 2 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 2 FAILED: Malformed canonical_payload_hash was accepted without error!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 3: Authoritative ₱350 Settlement & Exact Centavo Accounting Assertions
    -- -------------------------------------------------------------------------
    v_post_res := public.post_booking_settlement_event(
        v_synth_org_a,
        v_synth_fac_a,
        v_synth_res_a,
        350.00,
        0.0500,
        'idem_005a2_valid_booking_01',
        '{"source": "005a2_test"}'::jsonb
    );

    -- 3A: Return object structure
    IF (v_post_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 3 FAILED: Settlement procedure returned failure: %', v_post_res;
    END IF;

    IF (v_post_res->>'total_amount')::numeric != 350.00 THEN
        RAISE EXCEPTION 'Test 3 FAILED: Expected total_amount 350.00, got %', (v_post_res->>'total_amount');
    END IF;

    IF (v_post_res->>'unsettled_clearing_amount')::numeric != 332.50 THEN
        RAISE EXCEPTION 'Test 3 FAILED: Expected unsettled_clearing_amount 332.50, got %', (v_post_res->>'unsettled_clearing_amount');
    END IF;

    v_tx_id := (v_post_res->>'transaction_id')::UUID;

    -- 3B: Materialized organization_balances exact centavo verification
    SELECT * INTO v_org_bal
    FROM public.organization_balances
    WHERE organization_id = v_synth_org_a;

    IF v_org_bal.total_gross_settled != 350.00 THEN
        RAISE EXCEPTION 'Test 3 FAILED: total_gross_settled expected 350.00, got %', v_org_bal.total_gross_settled;
    END IF;

    IF v_org_bal.total_commission_paid != 17.50 THEN
        RAISE EXCEPTION 'Test 3 FAILED: total_commission_paid expected 17.50 (5%% of ₱350), got %', v_org_bal.total_commission_paid;
    END IF;

    IF v_org_bal.unsettled_clearing_amount != 332.50 THEN
        RAISE EXCEPTION 'Test 3 FAILED: unsettled_clearing_amount expected 332.50, got %', v_org_bal.unsettled_clearing_amount;
    END IF;

    IF v_org_bal.available_withdrawable_balance != 0.00 THEN
        RAISE EXCEPTION 'Test 3 FAILED: available_withdrawable_balance expected 0.00, got %', v_org_bal.available_withdrawable_balance;
    END IF;

    IF v_org_bal.negative_recovery_balance != 0.00 THEN
        RAISE EXCEPTION 'Test 3 FAILED: negative_recovery_balance expected 0.00, got %', v_org_bal.negative_recovery_balance;
    END IF;

    IF v_org_bal.last_journal_transaction_id != v_tx_id THEN
        RAISE EXCEPTION 'Test 3 FAILED: last_journal_transaction_id expected %, got %', v_tx_id, v_org_bal.last_journal_transaction_id;
    END IF;

    -- 3C: Double-entry ledger entries verification
    SELECT COUNT(*) INTO v_entry_count
    FROM public.ledger_entries
    WHERE transaction_id = v_tx_id;

    IF v_entry_count != 3 THEN
        RAISE EXCEPTION 'Test 3 FAILED: Expected exactly 3 ledger lines, found %', v_entry_count;
    END IF;

    -- Line 1: Gateway In-Transit Clearing Funds (1010) DEBIT ₱350.00
    SELECT * INTO v_entry_rec
    FROM public.ledger_entries
    WHERE transaction_id = v_tx_id AND entry_order = 1;

    IF v_entry_rec.account_code != '1010' OR v_entry_rec.entry_direction != 'DEBIT' OR
       v_entry_rec.amount != 350.00 OR v_entry_rec.running_balance != 350.00 THEN
        RAISE EXCEPTION 'Test 3 FAILED on line 1 (1010 DEBIT): code=%, dir=%, amt=%, bal=%',
            v_entry_rec.account_code, v_entry_rec.entry_direction, v_entry_rec.amount, v_entry_rec.running_balance;
    END IF;

    -- Line 2: Platform Commission Revenue (4010) CREDIT ₱17.50
    SELECT * INTO v_entry_rec
    FROM public.ledger_entries
    WHERE transaction_id = v_tx_id AND entry_order = 2;

    IF v_entry_rec.account_code != '4010' OR v_entry_rec.entry_direction != 'CREDIT' OR
       v_entry_rec.amount != 17.50 OR v_entry_rec.running_balance != 17.50 THEN
        RAISE EXCEPTION 'Test 3 FAILED on line 2 (4010 CREDIT): code=%, dir=%, amt=%, bal=%',
            v_entry_rec.account_code, v_entry_rec.entry_direction, v_entry_rec.amount, v_entry_rec.running_balance;
    END IF;

    -- Line 3: Owner Payable - Unsettled Clearing (2010) CREDIT ₱332.50
    SELECT * INTO v_entry_rec
    FROM public.ledger_entries
    WHERE transaction_id = v_tx_id AND entry_order = 3;

    IF v_entry_rec.account_code != '2010' OR v_entry_rec.entry_direction != 'CREDIT' OR
       v_entry_rec.amount != 332.50 OR v_entry_rec.running_balance != 332.50 THEN
        RAISE EXCEPTION 'Test 3 FAILED on line 3 (2010 CREDIT): code=%, dir=%, amt=%, bal=%',
            v_entry_rec.account_code, v_entry_rec.entry_direction, v_entry_rec.amount, v_entry_rec.running_balance;
    END IF;

    RAISE NOTICE 'Test 3 PASSED: ₱350.00 settlement posted correctly (₱17.50 comm, ₱332.50 unsettled).';

    -- -------------------------------------------------------------------------
    -- TEST 4: Identical Idempotent Replay (Zero duplicate records or double credits)
    -- -------------------------------------------------------------------------
    v_replay_res := public.post_booking_settlement_event(
        v_synth_org_a,
        v_synth_fac_a,
        v_synth_res_a,
        350.00,
        0.0500,
        'idem_005a2_valid_booking_01',
        '{"source": "005a2_test"}'::jsonb
    );

    IF (v_replay_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 4 FAILED: Replay call failed: %', v_replay_res;
    END IF;

    IF (v_replay_res->>'idempotent_duplicate')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 4 FAILED: Replay did not return idempotent_duplicate=true: %', v_replay_res;
    END IF;

    IF (v_replay_res->>'transaction_id')::UUID != v_tx_id THEN
        RAISE EXCEPTION 'Test 4 FAILED: Replay returned different transaction_id: % vs %',
            (v_replay_res->>'transaction_id'), v_tx_id;
    END IF;

    -- Verify total financial_transactions with this key remains exactly 1
    SELECT COUNT(*) INTO v_tx_count
    FROM public.financial_transactions
    WHERE idempotency_key = 'idem_005a2_valid_booking_01';

    IF v_tx_count != 1 THEN
        RAISE EXCEPTION 'Test 4 FAILED: Expected exactly 1 header transaction, found %', v_tx_count;
    END IF;

    -- Verify total ledger lines remain exactly 3
    SELECT COUNT(*) INTO v_entry_count
    FROM public.ledger_entries
    WHERE transaction_id = v_tx_id;

    IF v_entry_count != 3 THEN
        RAISE EXCEPTION 'Test 4 FAILED: Duplicate ledger entries created! Found % lines.', v_entry_count;
    END IF;

    -- Verify balances were not doubled
    SELECT * INTO v_org_bal
    FROM public.organization_balances
    WHERE organization_id = v_synth_org_a;

    IF v_org_bal.unsettled_clearing_amount != 332.50 OR v_org_bal.total_gross_settled != 350.00 THEN
        RAISE EXCEPTION 'Test 4 FAILED: Balances mutated on idempotent replay! unsettled=%, gross=%',
            v_org_bal.unsettled_clearing_amount, v_org_bal.total_gross_settled;
    END IF;

    RAISE NOTICE 'Test 4 PASSED: Identical idempotent replay verified (idempotent_duplicate=true, 0 duplicated lines).';

    -- -------------------------------------------------------------------------
    -- TEST 5: Idempotency Conflict Detection on Altered Terms (Tampering Guard)
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        -- Replay with same idempotency key but altered allocations/metadata
        PERFORM public.post_journal_entry_internal(
            v_synth_org_a,
            v_synth_fac_a,
            'booking_settlement',
            'idem_005a2_valid_booking_01',
            v_synth_res_a,
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
            RAISE NOTICE 'Test 5 PASSED: Idempotency conflict detected and rejected (MSG: %)', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 5 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 5 FAILED: Idempotency replay with altered financial parameters was not rejected!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 6: Tenant Isolation Guard: Cross-Organization Reference Rejection
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        -- Caller Org B attempts to post settlement against reservation owned by Org A
        PERFORM public.post_booking_settlement_event(
            v_synth_org_b,
            v_synth_fac_b,
            v_synth_res_a, -- Belongs to Org A!
            350.00,
            0.0500,
            'idem_005a2_cross_org_01',
            '{}'::jsonb
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = 'P0001' AND SQLERRM LIKE '%Tenant mismatch%' THEN
            v_expected_failed := true;
            RAISE NOTICE 'Test 6 PASSED: Cross-organization settlement rejected (MSG: %)', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 6 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 6 FAILED: Cross-organization reference was accepted!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 7: Invalid Debit Direction Rejection in post_journal_entry_internal()
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        PERFORM public.post_journal_entry_internal(
            v_synth_org_a,
            v_synth_fac_a,
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
            RAISE NOTICE 'Test 7 PASSED: Invalid debit direction on booking_settlement rejected (MSG: %)', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 7 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 7 FAILED: Invalid DEBIT account direction was accepted without error!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 8: Non-positive (0.00) ledger_entries.amount Rejection
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        INSERT INTO public.ledger_entries (
            transaction_id, organization_id, account_code, entry_direction,
            amount, entry_order, running_balance
        ) VALUES (
            v_tx_id, v_synth_org_a, '1010', 'DEBIT', 0.00, 99, 0.00
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('23514', 'P0001') AND (
            SQLERRM LIKE '%strictly positive%' OR
            SQLERRM LIKE '%amount%' OR
            SQLERRM LIKE '%ledger_entries_amount_check%'
        ) THEN
            v_expected_failed := true;
            RAISE NOTICE 'Test 8 PASSED: Non-positive ledger_entries.amount rejected (SQLSTATE: %, MSG: %)', SQLSTATE, SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 8 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 8 FAILED: Zero amount ledger entry was accepted without error!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 9: Centavo Balancing Invariant: Unbalanced Entries Rejected
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        PERFORM public.post_journal_entry_internal(
            v_synth_org_a,
            v_synth_fac_a,
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
            RAISE NOTICE 'Test 9 PASSED: Unbalanced journal transaction rejected (MSG: %)', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 9 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 9 FAILED: Unbalanced journal transaction was accepted without error!';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 10: Transaction Rollback & Atomicity Guard (Zero partial or orphaned rows)
    -- -------------------------------------------------------------------------
    v_expected_failed := false;
    BEGIN
        -- Execute a failing call inside a protected sub-block
        PERFORM public.post_journal_entry_internal(
            v_synth_org_a,
            v_synth_fac_a,
            'booking_settlement',
            'idem_005a2_atomic_fail_01',
            gen_random_uuid(),
            'Test atomicity failure',
            '{}'::jsonb,
            jsonb_build_array(
                jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', 200.00),
                jsonb_build_object('account_code', '9999', 'entry_direction', 'CREDIT', 'amount', 200.00) -- Invalid account!
            )
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = 'P0001' AND SQLERRM LIKE '%Invalid account code%' THEN
            v_expected_failed := true;
            RAISE NOTICE 'Test 10 PASSED: Bad account rejected: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'Test 10 FAILED with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    IF NOT v_expected_failed THEN
        RAISE EXCEPTION 'Test 10 FAILED: Invalid account was accepted!';
    END IF;

    -- Verify no orphaned transaction header exists for 'idem_005a2_atomic_fail_01'
    SELECT COUNT(*) INTO v_tx_count
    FROM public.financial_transactions
    WHERE idempotency_key = 'idem_005a2_atomic_fail_01';

    IF v_tx_count != 0 THEN
        RAISE EXCEPTION 'Test 10 FAILED: Orphaned transaction header persisted after failure!';
    END IF;

    -- Verify Org A balances remain strictly unchanged from Test 3
    SELECT * INTO v_org_bal
    FROM public.organization_balances
    WHERE organization_id = v_synth_org_a;

    IF v_org_bal.total_gross_settled != 350.00 OR
       v_org_bal.total_commission_paid != 17.50 OR
       v_org_bal.unsettled_clearing_amount != 332.50 THEN
        RAISE EXCEPTION 'Test 10 FAILED: Balances contaminated after failed transaction!';
    END IF;

    RAISE NOTICE '========================================================================';
    RAISE NOTICE '=== ALL 10 VERIFICATION GATES PASSED SUCCESSFULLY                     ===';
    RAISE NOTICE '========================================================================';
END $$;

ROLLBACK;
