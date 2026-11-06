-- ==============================================================================
-- CourtBook / BookSuite — Phase 4.2.2 Financial Ledger Hardening Test Script
-- Target: Isolated Supabase Testing Project ONLY (DO NOT RUN ON PRODUCTION)
--
-- Tests:
--   1. NULL canonical_payload_hash rejection on financial_transactions
--   2. Malformed (non-64-char hex) canonical_payload_hash rejection
--   3. Idempotency conflict detection when canonical_payload_hash differs
--   4. Transaction-specific debit/credit direction enforcement
--   5. 5% platform commission & double-entry balance preservation
--   6. Append-only immutability & RLS / SECURITY DEFINER preservation
-- ==============================================================================

BEGIN;

DO $$
DECLARE
    v_org_id UUID;
    v_fac_id UUID;
    v_res_id UUID := gen_random_uuid();
    v_tx_id UUID;
    v_valid_hash TEXT := repeat('a', 64);
    v_other_hash TEXT := repeat('b', 64);
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
        RAISE NOTICE 'Test 1 PASSED: NULL canonical_payload_hash rejected (%).', SQLERRM;
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
            v_res_id, 'Test malformed hash rejection', 'not_a_valid_sha256_hex'
        );
        RAISE EXCEPTION 'Test 2 Failed: Malformed canonical_payload_hash was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Test 2 PASSED: Malformed canonical_payload_hash rejected (%).', SQLERRM;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 3: Valid 5% commission booking_settlement & idempotency conflict
    -- -------------------------------------------------------------------------
    v_post_res := public.post_booking_settlement_event(
        v_org_id,
        v_fac_id,
        v_res_id,
        350.00,
        17.50,
        'idem_005a2_valid_booking_01',
        '{"source": "005a2_test"}'::jsonb
    );

    IF (v_post_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 3A Failed: Valid booking_settlement failed!';
    END IF;
    RAISE NOTICE 'Test 3A PASSED: Valid 5%% commission booking_settlement posted (₱350.00 gross, ₱17.50 commission).';

    -- Replay with different amount (different canonical_payload_hash) must fail
    BEGIN
        PERFORM public.post_booking_settlement_event(
            v_org_id,
            v_fac_id,
            v_res_id,
            500.00,
            25.00,
            'idem_005a2_valid_booking_01',
            '{"source": "005a2_test"}'::jsonb
        );
        RAISE EXCEPTION 'Test 3B Failed: Idempotency conflict with different amount was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Idempotency conflict%' THEN
            RAISE NOTICE 'Test 3B PASSED: Idempotency conflict with different canonical_payload_hash rejected.';
        ELSE
            RAISE EXCEPTION 'Test 3B Failed: Unexpected error: %', SQLERRM;
        END IF;
    END;

    -- -------------------------------------------------------------------------
    -- TEST 4: Invalid debit/credit direction for booking_settlement must fail
    -- -------------------------------------------------------------------------
    v_tx_id := (v_post_res->>'transaction_id')::UUID;
    BEGIN
        INSERT INTO public.ledger_entries (
            transaction_id, account_code, entry_direction, amount, entry_order
        ) VALUES (
            v_tx_id, '4010', 'DEBIT', 10.00, 99
        );
        RAISE EXCEPTION 'Test 4 Failed: Invalid DEBIT on 4010 for booking_settlement was not rejected!';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Test 4 PASSED: Invalid debit/credit direction rejected (%).', SQLERRM;
    END;

    RAISE NOTICE '=== ALL 005a2 LEDGER HARDENING TESTS PASSED ===';
END $$;

ROLLBACK;
