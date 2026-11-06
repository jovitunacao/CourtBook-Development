-- ==============================================================================
-- CourtBook / BookSuite — Phase 4.2.2 Financial Ledger Hardening Test Script
-- Target: Isolated Supabase Testing Project ONLY (DO NOT RUN ON PRODUCTION)
--
-- Tests:
--   1. NULL canonical_payload_hash rejection (SQLSTATE 23502 / P0001)
--   2. Malformed (non-32-char MD5 hex) canonical_payload_hash rejection (SQLSTATE 23514 / P0001)
--   3. Valid 5% (0.0500) commission booking_settlement & idempotency conflict
--   4. Invalid debit/credit direction rejection in post_journal_entry_internal()
--   5. Zero/non-positive ledger_entries.amount rejection
-- ==============================================================================

BEGIN;

DO $$
DECLARE
    v_org_id UUID;
    v_fac_id UUID;
    v_res_id UUID := gen_random_uuid();
    v_tx_id UUID;
    v_post_res JSONB;
BEGIN
    SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
    SELECT id INTO v_fac_id FROM public.facilities WHERE organization_id = v_org_id LIMIT 1;

    IF v_org_id IS NULL OR v_fac_id IS NULL THEN
        RAISE EXCEPTION 'Test setup failed: No organization/facility found in test database.';
    END IF;

    -- -------------------------------------------------------------------------
    -- TEST 1: NULL canonical_payload_hash must be rejected
    -- -------------------------------------------------------------------------
    BEGIN
        INSERT INTO public.financial_transactions (
            organization_id, facility_id, transaction_type, idempotency_key,
            reference_id, description, canonical_payload_hash
        ) VALUES (
            v_org_id, v_fac_id, 'booking_settlement', 'idem_005a2_null_hash_01',
            v_res_id, 'Test NULL hash rejection', NULL
        );
        RAISE EXCEPTION 'Test 1 Failed: NULL canonical_payload_hash was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('23502', 'P0001') AND (SQLERRM LIKE '%canonical_payload_hash%') THEN
            RAISE NOTICE 'Test 1 PASSED: NULL canonical_payload_hash rejected (SQLSTATE %).', SQLSTATE;
        ELSE
            RAISE EXCEPTION 'Test 1 Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 2: Malformed canonical_payload_hash must be rejected
    -- -------------------------------------------------------------------------
    BEGIN
        INSERT INTO public.financial_transactions (
            organization_id, facility_id, transaction_type, idempotency_key,
            reference_id, description, canonical_payload_hash
        ) VALUES (
            v_org_id, v_fac_id, 'booking_settlement', 'idem_005a2_bad_hash_01',
            v_res_id, 'Test malformed hash rejection', 'not_a_valid_md5_hex'
        );
        RAISE EXCEPTION 'Test 2 Failed: Malformed canonical_payload_hash was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('23514', 'P0001') AND (SQLERRM LIKE '%canonical_payload_hash%' OR SQLERRM LIKE '%chk_financial_tx_canonical_hash_md5%') THEN
            RAISE NOTICE 'Test 2 PASSED: Malformed canonical_payload_hash rejected (SQLSTATE %).', SQLSTATE;
        ELSE
            RAISE EXCEPTION 'Test 2 Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 3: Valid 5% (0.0500) commission booking_settlement & idempotency conflict
    -- -------------------------------------------------------------------------
    v_post_res := public.post_booking_settlement_event(
        v_org_id,
        v_fac_id,
        v_res_id,
        350.00,
        0.0500,
        'idem_005a2_valid_booking_01',
        '{"source": "005a2_test"}'::jsonb
    );

    IF (v_post_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 3A Failed: Valid booking_settlement failed!';
    END IF;
    RAISE NOTICE 'Test 3A PASSED: Valid 5%% (0.0500) commission booking_settlement posted.';

    -- Replay with different amount (different canonical_payload_hash) must fail
    BEGIN
        PERFORM public.post_booking_settlement_event(
            v_org_id,
            v_fac_id,
            v_res_id,
            500.00,
            0.0500,
            'idem_005a2_valid_booking_01',
            '{"source": "005a2_test"}'::jsonb
        );
        RAISE EXCEPTION 'Test 3B Failed: Idempotency conflict with different amount was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Idempotency conflict%' THEN
            RAISE NOTICE 'Test 3B PASSED: Idempotency conflict with different canonical_payload_hash rejected.';
        ELSE
            RAISE EXCEPTION 'Test 3B Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 4: Invalid debit/credit direction in post_journal_entry_internal()
    -- -------------------------------------------------------------------------
    BEGIN
        PERFORM public.post_journal_entry_internal(
            v_org_id,
            v_fac_id,
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
        RAISE EXCEPTION 'Test 4 Failed: Invalid DEBIT on 4010 for booking_settlement was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%booking_settlement DEBIT must target 1010%' THEN
            RAISE NOTICE 'Test 4 PASSED: Invalid debit/credit direction rejected.';
        ELSE
            RAISE EXCEPTION 'Test 4 Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 5: Non-positive ledger_entries.amount must be rejected
    -- -------------------------------------------------------------------------
    v_tx_id := (v_post_res->>'transaction_id')::UUID;
    BEGIN
        INSERT INTO public.ledger_entries (
            transaction_id, organization_id, account_code, entry_direction,
            amount, entry_order, running_account_balance
        ) VALUES (
            v_tx_id, v_org_id, '1010', 'DEBIT', 0.00, 99, 0.00
        );
        RAISE EXCEPTION 'Test 5 Failed: Zero amount ledger entry was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('23514', 'P0001') AND (SQLERRM LIKE '%strictly positive%' OR SQLERRM LIKE '%amount%') THEN
            RAISE NOTICE 'Test 5 PASSED: Non-positive ledger_entries.amount rejected (SQLSTATE %).', SQLSTATE;
        ELSE
            RAISE EXCEPTION 'Test 5 Failed with unexpected error [SQLSTATE %]: %', SQLSTATE, SQLERRM;
        END IF;
    END;

    RAISE NOTICE '=== ALL 005a2 LEDGER HARDENING TESTS PASSED ===';
END $$;

ROLLBACK;
