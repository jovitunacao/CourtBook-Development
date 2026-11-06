-- ==============================================================================
-- CourtBook / BookSuite — Database Schema Migration
-- Migration: 005a2_financial_ledger_hardening.sql
-- Description: Phase 4.2.2 Financial Ledger Hardening (Schema & Engine Invariants)
--
-- STATUS: REVIEW ONLY (Target: BookSuite-Payment-Test isolated test project)
--
-- PURPOSE & ARCHITECTURAL HARDENING:
--   1. Enforces NOT NULL and strict 32-character MD5 hex format (^[0-9a-f]{32}$)
--      on public.financial_transactions.canonical_payload_hash.
--      (No backfill UPDATE statement; strictly preserves append-only immutability).
--   2. Adds BEFORE INSERT triggers:
--      - trg_enforce_financial_tx_canonical_hash: rejects NULL or malformed hashes.
--      - trg_enforce_positive_ledger_entry_amount: rejects non-positive entry amounts.
--   3. Replaces and hardens public.post_journal_entry_internal():
--      - Preserves ALL original journal-posting behavior from 005a1 line by line:
--        * Deterministic account-specific running balances across all 11 accounts
--          (1010, 1020, 1030, 2010, 2011, 2012, 2015, 2020, 2030, 4010, 5010)
--          ordered by ft.transaction_number DESC, le.entry_order DESC.
--        * Exact debit/credit normal balance rules for Assets/Expenses vs Liabilities/Revenue.
--        * In-memory multi-entry running balance tracking across transaction lines.
--        * Exact column references in organization_balances:
--          unsettled_clearing_amount, pending_payout_amount, negative_recovery_balance,
--          available_withdrawable_balance, total_gross_settled, total_commission_paid,
--          total_withdrawn, last_journal_transaction_id.
--        * Exact column reference in ledger_entries: running_balance.
--      - Hardens:
--        * Idempotency comparison uses IS DISTINCT FROM (never skips NULL or partial records).
--        * Total debits & credits must be strictly positive (v_total_debits <= 0.00 rejected).
--        * Strict transaction-specific DEBIT/CREDIT direction validation across all 13 types.
--   4. Re-applies strict EXECUTE privilege revocations for PUBLIC, anon, authenticated,
--      and service_role.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. Storage-Level Constraints on Foundation Financial Tables
-- ==============================================================================

-- 1.1 Enforce NOT NULL on canonical_payload_hash (Preserves append-only immutability)
ALTER TABLE public.financial_transactions
    ALTER COLUMN canonical_payload_hash SET NOT NULL;

-- 1.2 Enforce 32-character lowercase MD5 hex format
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_financial_tx_canonical_hash_md5'
          AND conrelid = 'public.financial_transactions'::regclass
    ) THEN
        ALTER TABLE public.financial_transactions
            ADD CONSTRAINT chk_financial_tx_canonical_hash_md5
            CHECK (canonical_payload_hash ~ '^[0-9a-f]{32}$');
    END IF;
END $$;

-- ==============================================================================
-- 2. Trigger Guards for Financial Integrity
-- ==============================================================================

-- 2.1 Trigger Guard: Prevent NULL or malformed canonical_payload_hash on INSERT
CREATE OR REPLACE FUNCTION public.enforce_financial_tx_canonical_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.canonical_payload_hash IS NULL OR NEW.canonical_payload_hash !~ '^[0-9a-f]{32}$' THEN
        RAISE EXCEPTION 'Security violation: financial_transactions.canonical_payload_hash must be a valid 32-character MD5 hex digest.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_financial_tx_canonical_hash ON public.financial_transactions;
CREATE TRIGGER trg_enforce_financial_tx_canonical_hash
    BEFORE INSERT ON public.financial_transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_financial_tx_canonical_hash();

-- 2.2 Trigger Guard: Enforce strictly positive ledger_entries.amount on INSERT
CREATE OR REPLACE FUNCTION public.enforce_positive_ledger_entry_amount()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.amount IS NULL OR NEW.amount <= 0.00 THEN
        RAISE EXCEPTION 'Ledger entry amount must be strictly positive. Got: %', NEW.amount;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_positive_ledger_entry_amount ON public.ledger_entries;
CREATE TRIGGER trg_enforce_positive_ledger_entry_amount
    BEFORE INSERT ON public.ledger_entries
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_positive_ledger_entry_amount();

-- ==============================================================================
-- 3. Hardened Private Double-Entry Engine (post_journal_entry_internal)
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.post_journal_entry_internal(
    p_organization_id UUID,
    p_facility_id UUID,
    p_transaction_type VARCHAR(32),
    p_idempotency_key TEXT,
    p_reference_id UUID,
    p_description TEXT,
    p_metadata JSONB,
    p_entries JSONB -- Array of { "account_code": "...", "entry_direction": "DEBIT"|"CREDIT", "amount": 0.00 }
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_key TEXT;
    v_clean_desc TEXT;
    v_clean_type VARCHAR(32);
    v_existing_tx RECORD;
    v_new_tx_id UUID;
    v_new_tx_number BIGINT;
    v_total_debits NUMERIC(10, 2) := 0.00;
    v_total_credits NUMERIC(10, 2) := 0.00;
    v_item JSONB;
    v_order SMALLINT := 1;
    v_org_balance RECORD;

    -- Versioned canonical payload serialization & hash for full idempotency comparison
    v_normalized_entries JSONB := '[]'::jsonb;
    v_canonical_payload JSONB;
    v_canonical_hash TEXT;

    -- Explicitly typed entry variables
    v_entry_account VARCHAR(10);
    v_entry_direction VARCHAR(6);
    v_entry_amount NUMERIC(10, 2);

    -- Running account balance trackers for ALL 11 supported accounts
    v_running_1010 NUMERIC(10, 2) := NULL;
    v_running_1020 NUMERIC(10, 2) := NULL;
    v_running_1030 NUMERIC(10, 2) := NULL;
    v_running_2010 NUMERIC(10, 2) := NULL;
    v_running_2011 NUMERIC(10, 2) := NULL;
    v_running_2012 NUMERIC(10, 2) := NULL; -- Restricted Reserve
    v_running_2015 NUMERIC(10, 2) := NULL;
    v_running_2020 NUMERIC(10, 2) := NULL;
    v_running_2030 NUMERIC(10, 2) := NULL;
    v_running_4010 NUMERIC(10, 2) := NULL;
    v_running_5010 NUMERIC(10, 2) := NULL;
    v_current_entry_balance NUMERIC(10, 2);

    -- Metric deltas
    v_delta_gross_settled NUMERIC(10, 2) := 0.00;
    v_delta_commission_paid NUMERIC(10, 2) := 0.00;
    v_delta_unsettled_clearing NUMERIC(10, 2) := 0.00;
    v_delta_available_withdrawable NUMERIC(10, 2) := 0.00;
    v_delta_pending_payout NUMERIC(10, 2) := 0.00;
    v_delta_total_withdrawn NUMERIC(10, 2) := 0.00;
    v_delta_negative_recovery NUMERIC(10, 2) := 0.00;

    -- Target balances
    v_new_gross NUMERIC(10, 2);
    v_new_commission NUMERIC(10, 2);
    v_new_unsettled NUMERIC(10, 2);
    v_new_available NUMERIC(10, 2);
    v_new_pending NUMERIC(10, 2);
    v_new_withdrawn NUMERIC(10, 2);
    v_new_negative_recovery NUMERIC(10, 2);
BEGIN
    -- 1. Input Sanitization & Basic Guards
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'Organization ID is required.';
    END IF;

    v_clean_type := trim(COALESCE(p_transaction_type, ''));
    IF v_clean_type NOT IN (
        'booking_settlement',
        'funds_cleared_to_available',
        'refund_reversal',
        'chargeback_adjustment',
        'gateway_fee_assessment',
        'payout_reserve',
        'payout_disbursement',
        'payout_failed_release',
        'merchant_debt_recovery',
        'dispute_hold',
        'excess_payment_liability',
        'late_payment_liability',
        'platform_adjustment'
    ) THEN
        RAISE EXCEPTION 'Invalid transaction type: "%".', v_clean_type;
    END IF;

    v_clean_key := trim(COALESCE(p_idempotency_key, ''));
    IF char_length(v_clean_key) < 8 OR char_length(v_clean_key) > 255 THEN
        RAISE EXCEPTION 'Idempotency key must be between 8 and 255 characters.';
    END IF;

    IF p_reference_id IS NULL THEN
        RAISE EXCEPTION 'Reference ID is required.';
    END IF;

    v_clean_desc := trim(COALESCE(p_description, ''));
    IF char_length(v_clean_desc) < 5 OR char_length(v_clean_desc) > 300 THEN
        RAISE EXCEPTION 'Transaction description must be between 5 and 300 characters.';
    END IF;

    IF p_entries IS NULL OR jsonb_typeof(p_entries) != 'array' OR jsonb_array_length(p_entries) < 2 THEN
        RAISE EXCEPTION 'Journal transaction must contain a JSON array with at least two entries.';
    END IF;

    -- 2. Concurrency Serialization: Lock Organization Balance FIRST
    SELECT * INTO v_org_balance
    FROM public.organization_balances
    WHERE organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Organization balance record not found for organization: %', p_organization_id;
    END IF;

    -- 3. Calculate payload total debits, credits, and build normalized canonical payload
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        IF jsonb_typeof(v_item) != 'object' THEN
            RAISE EXCEPTION 'Malformed entry: Every item in entries array must be a JSON object.';
        END IF;

        IF NOT (v_item ? 'account_code' AND v_item ? 'entry_direction' AND v_item ? 'amount') THEN
            RAISE EXCEPTION 'Malformed entry: Missing required properties (account_code, entry_direction, amount).';
        END IF;

        v_entry_account := trim(COALESCE(v_item->>'account_code', ''));
        v_entry_direction := upper(trim(COALESCE(v_item->>'entry_direction', '')));

        IF v_entry_account NOT IN ('1010', '1020', '1030', '2010', '2011', '2012', '2015', '2020', '2030', '4010', '5010') THEN
            RAISE EXCEPTION 'Invalid account code: %. Supported: 1010, 1020, 1030, 2010, 2011, 2012, 2015, 2020, 2030, 4010, 5010.', v_entry_account;
        END IF;

        IF v_entry_direction NOT IN ('DEBIT', 'CREDIT') THEN
            RAISE EXCEPTION 'Invalid entry direction: %. Must be DEBIT or CREDIT.', v_entry_direction;
        END IF;

        BEGIN
            v_entry_amount := (v_item->>'amount')::NUMERIC(10, 2);
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'Malformed amount value in entry: %', (v_item->>'amount');
        END;

        IF v_entry_amount <= 0.00 THEN
            RAISE EXCEPTION 'Entry amount must be strictly positive. Got: %', v_entry_amount;
        END IF;

        -- Sub-centavo precision guard
        IF ((v_item->>'amount')::NUMERIC * 100.0) != round((v_item->>'amount')::NUMERIC * 100.0) THEN
            RAISE EXCEPTION 'Sub-centavo fractional precision rejected: %', (v_item->>'amount');
        END IF;

        IF v_entry_direction = 'DEBIT' THEN
            v_total_debits := v_total_debits + v_entry_amount;
        ELSE
            v_total_credits := v_total_credits + v_entry_amount;
        END IF;

        v_normalized_entries := v_normalized_entries || jsonb_build_object(
            'account_code', v_entry_account,
            'entry_direction', v_entry_direction,
            'amount', v_entry_amount
        );
    END LOOP;

    -- Construct versioned canonical payload covering every immutable financial attribute
    v_canonical_payload := jsonb_build_object(
        'version', 1,
        'organization_id', p_organization_id,
        'facility_id', p_facility_id,
        'transaction_type', v_clean_type,
        'reference_id', p_reference_id,
        'commission_rate', (p_metadata->>'commission_rate'),
        'provider_event_id', (p_metadata->>'provider_event_id'),
        'provider_payment_id', (p_metadata->>'provider_payment_id'),
        'settlement_reference', (p_metadata->>'settlement_reference'),
        'entries', v_normalized_entries
    );
    v_canonical_hash := md5(v_canonical_payload::text);

    -- 4. Full Idempotency Check & Comprehensive Conflict Detection Under Exclusive Lock
    SELECT id, organization_id, facility_id, transaction_type, reference_id, description, canonical_payload_hash
    INTO v_existing_tx
    FROM public.financial_transactions
    WHERE idempotency_key = v_clean_key;

    IF FOUND THEN
        -- Comprehensive parameter verification
        IF v_existing_tx.organization_id != p_organization_id OR
           (v_existing_tx.facility_id IS DISTINCT FROM p_facility_id) OR
           v_existing_tx.transaction_type != v_clean_type OR
           v_existing_tx.reference_id != p_reference_id THEN
            RAISE EXCEPTION 'Idempotency conflict: Key "%" was previously used with different parameters (org: %, fac: %, type: %, ref: %).',
                v_clean_key, v_existing_tx.organization_id, v_existing_tx.facility_id, v_existing_tx.transaction_type, v_existing_tx.reference_id;
        END IF;

        -- Strict IS DISTINCT FROM comparison (rejects altered terms or NULL values)
        IF v_existing_tx.canonical_payload_hash IS DISTINCT FROM v_canonical_hash THEN
            RAISE EXCEPTION 'Idempotency conflict: Key "%" was previously executed with different financial parameters, commission terms, or account allocations.',
                v_clean_key;
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'transaction_id', v_existing_tx.id,
            'idempotent_duplicate', true,
            'message', 'Transaction was previously posted with this idempotency key.'
        );
    END IF;

    -- 5. Exact Centavo Balancing Invariant & Strictly Positive Total Check
    IF v_total_debits <= 0.00 THEN
        RAISE EXCEPTION 'Transaction total debits and credits must be strictly positive. Got: ₱%', v_total_debits;
    END IF;

    IF v_total_debits != v_total_credits THEN
        RAISE EXCEPTION 'Unbalanced journal transaction: Total Debits (₱%) does not match Total Credits (₱%). Difference: ₱%',
            v_total_debits, v_total_credits, (v_total_debits - v_total_credits);
    END IF;

    -- 6. Strict Account Whitelist & Transaction-Specific Direction Validation per Transaction Type
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        v_entry_account := trim(v_item->>'account_code');
        v_entry_direction := upper(trim(v_item->>'entry_direction'));
        v_entry_amount := (v_item->>'amount')::NUMERIC(10, 2);

        IF v_clean_type = 'booking_settlement' THEN
            IF v_entry_account NOT IN ('1010', '2010', '2020', '4010') THEN
                RAISE EXCEPTION 'Account % not permitted for booking_settlement.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account != '1010' THEN
                RAISE EXCEPTION 'booking_settlement DEBIT must target 1010 (Gateway Clearing), got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account NOT IN ('2010', '2020', '4010') THEN
                RAISE EXCEPTION 'booking_settlement CREDIT must target 2010, 2020, or 4010, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '1010' THEN
                v_delta_gross_settled := v_delta_gross_settled + v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '4010' THEN
                v_delta_commission_paid := v_delta_commission_paid + v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '2010' THEN
                v_delta_unsettled_clearing := v_delta_unsettled_clearing + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'funds_cleared_to_available' THEN
            IF v_entry_account NOT IN ('1010', '1020', '1030', '2010', '2011') THEN
                RAISE EXCEPTION 'Account % not permitted for funds_cleared_to_available.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account NOT IN ('2010', '1020') THEN
                RAISE EXCEPTION 'funds_cleared_to_available DEBIT must target 2010 or 1020, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account NOT IN ('2011', '1030', '1010') THEN
                RAISE EXCEPTION 'funds_cleared_to_available CREDIT must target 2011, 1030, or 1010, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2010' THEN
                v_delta_unsettled_clearing := v_delta_unsettled_clearing - v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable + v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '1030' THEN
                -- Double-entry credit reducing merchant recovery debt
                v_delta_negative_recovery := v_delta_negative_recovery - v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'merchant_debt_recovery' THEN
            IF v_entry_account NOT IN ('1030', '2010', '2011') THEN
                RAISE EXCEPTION 'Account % not permitted for merchant_debt_recovery.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account NOT IN ('2010', '2011') THEN
                RAISE EXCEPTION 'merchant_debt_recovery DEBIT must target 2010 or 2011, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account != '1030' THEN
                RAISE EXCEPTION 'merchant_debt_recovery CREDIT must target 1030, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '2010' THEN
                v_delta_unsettled_clearing := v_delta_unsettled_clearing - v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '1030' THEN
                v_delta_negative_recovery := v_delta_negative_recovery - v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'refund_reversal' THEN
            IF v_entry_account NOT IN ('1010', '1020', '1030', '2010', '2011', '2030', '4010') THEN
                RAISE EXCEPTION 'Account % not permitted for refund_reversal.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account NOT IN ('1010', '1020', '2030') THEN
                RAISE EXCEPTION 'refund_reversal CREDIT must target 1010, 1020, or 2030, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account NOT IN ('2010', '2011', '1030', '4010') THEN
                RAISE EXCEPTION 'refund_reversal DEBIT must target 2010, 2011, 1030, or 4010, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account IN ('1010', '1020') THEN
                v_delta_gross_settled := v_delta_gross_settled - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '4010' THEN
                v_delta_commission_paid := v_delta_commission_paid - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '2010' THEN
                v_delta_unsettled_clearing := v_delta_unsettled_clearing - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '1030' THEN
                v_delta_negative_recovery := v_delta_negative_recovery + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'chargeback_adjustment' THEN
            IF v_entry_account NOT IN ('1010', '1020', '1030', '2010', '2011', '2012', '4010', '5010') THEN
                RAISE EXCEPTION 'Account % not permitted for chargeback_adjustment.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account NOT IN ('1010', '1020') THEN
                RAISE EXCEPTION 'chargeback_adjustment CREDIT must target 1010 or 1020, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account NOT IN ('2010', '2011', '1030', '2012', '4010', '5010') THEN
                RAISE EXCEPTION 'chargeback_adjustment DEBIT must target 2010, 2011, 1030, 2012, 4010, or 5010, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account IN ('1010', '1020') THEN
                v_delta_gross_settled := v_delta_gross_settled - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '4010' THEN
                v_delta_commission_paid := v_delta_commission_paid - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '2010' THEN
                v_delta_unsettled_clearing := v_delta_unsettled_clearing - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '1030' THEN
                v_delta_negative_recovery := v_delta_negative_recovery + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'payout_reserve' THEN
            IF v_entry_account NOT IN ('2011', '2015') THEN
                RAISE EXCEPTION 'Only 2011 (Available) and 2015 (Pending Payout) permitted for payout_reserve.';
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account != '2011' THEN
                RAISE EXCEPTION 'payout_reserve DEBIT must target 2011 (Available), got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account != '2015' THEN
                RAISE EXCEPTION 'payout_reserve CREDIT must target 2015 (Pending Payout), got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '2015' THEN
                v_delta_pending_payout := v_delta_pending_payout + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'payout_disbursement' THEN
            IF v_entry_account NOT IN ('1020', '2015') THEN
                RAISE EXCEPTION 'Only 2015 (Pending Payout) and 1020 (Platform Settled Cash) permitted for payout_disbursement.';
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account != '2015' THEN
                RAISE EXCEPTION 'payout_disbursement DEBIT must target 2015 (Pending Payout), got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account != '1020' THEN
                RAISE EXCEPTION 'payout_disbursement CREDIT must target 1020 (Platform Settled Cash), got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2015' THEN
                v_delta_pending_payout := v_delta_pending_payout - v_entry_amount;
                v_delta_total_withdrawn := v_delta_total_withdrawn + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'payout_failed_release' THEN
            IF v_entry_account NOT IN ('2011', '2015') THEN
                RAISE EXCEPTION 'Only 2015 (Pending Payout) and 2011 (Available) permitted for payout_failed_release.';
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account != '2015' THEN
                RAISE EXCEPTION 'payout_failed_release DEBIT must target 2015 (Pending Payout), got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account != '2011' THEN
                RAISE EXCEPTION 'payout_failed_release CREDIT must target 2011 (Available), got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2015' THEN
                v_delta_pending_payout := v_delta_pending_payout - v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'gateway_fee_assessment' THEN
            IF v_entry_account NOT IN ('1010', '1020', '2011', '2020', '5010') THEN
                RAISE EXCEPTION 'Account % not permitted for gateway_fee_assessment.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account NOT IN ('2011', '2020', '5010') THEN
                RAISE EXCEPTION 'gateway_fee_assessment DEBIT must target 2011, 2020, or 5010, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account NOT IN ('1010', '1020') THEN
                RAISE EXCEPTION 'gateway_fee_assessment CREDIT must target 1010 or 1020, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'dispute_hold' THEN
            IF v_entry_account NOT IN ('2010', '2011', '2012') THEN
                RAISE EXCEPTION 'Account % not permitted for dispute_hold.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account NOT IN ('2010', '2011') THEN
                RAISE EXCEPTION 'dispute_hold DEBIT must target 2010 or 2011, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account != '2012' THEN
                RAISE EXCEPTION 'dispute_hold CREDIT must target 2012 (Restricted Reserve), got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2010' THEN
                v_delta_unsettled_clearing := v_delta_unsettled_clearing - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            END IF;

        ELSIF v_clean_type IN ('excess_payment_liability', 'late_payment_liability') THEN
            IF v_entry_account NOT IN ('1010', '1020', '2030') THEN
                RAISE EXCEPTION 'Account % not permitted for %.', v_entry_account, v_clean_type;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account NOT IN ('1010', '1020') THEN
                RAISE EXCEPTION '% DEBIT must target 1010 or 1020, got %.', v_clean_type, v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account != '2030' THEN
                RAISE EXCEPTION '% CREDIT must target 2030 (Customer Refund Liability), got %.', v_clean_type, v_entry_account;
            END IF;

        ELSIF v_clean_type = 'platform_adjustment' THEN
            IF v_entry_account NOT IN ('1010', '1020', '1030', '2010', '2011', '4010', '5010') THEN
                RAISE EXCEPTION 'Account % not permitted for platform_adjustment.', v_entry_account;
            END IF;
            IF v_entry_account = '2011' THEN
                IF v_entry_direction = 'CREDIT' THEN
                    v_delta_available_withdrawable := v_delta_available_withdrawable + v_entry_amount;
                ELSE
                    v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
                END IF;
            ELSIF v_entry_account = '2010' THEN
                IF v_entry_direction = 'CREDIT' THEN
                    v_delta_unsettled_clearing := v_delta_unsettled_clearing + v_entry_amount;
                ELSE
                    v_delta_unsettled_clearing := v_delta_unsettled_clearing - v_entry_amount;
                END IF;
            ELSIF v_entry_account = '1030' THEN
                IF v_entry_direction = 'DEBIT' THEN
                    v_delta_negative_recovery := v_delta_negative_recovery + v_entry_amount;
                ELSE
                    v_delta_negative_recovery := v_delta_negative_recovery - v_entry_amount;
                END IF;
            END IF;

        END IF;
    END LOOP;

    -- 7. Calculate New Balances & Enforce Strict Non-Negative Check Invariants
    v_new_gross := v_org_balance.total_gross_settled + v_delta_gross_settled;
    v_new_commission := v_org_balance.total_commission_paid + v_delta_commission_paid;
    v_new_unsettled := v_org_balance.unsettled_clearing_amount + v_delta_unsettled_clearing;
    v_new_available := v_org_balance.available_withdrawable_balance + v_delta_available_withdrawable;
    v_new_pending := v_org_balance.pending_payout_amount + v_delta_pending_payout;
    v_new_withdrawn := v_org_balance.total_withdrawn + v_delta_total_withdrawn;
    v_new_negative_recovery := v_org_balance.negative_recovery_balance + v_delta_negative_recovery;

    IF v_new_gross < 0.00 THEN
        RAISE EXCEPTION 'Balance invariant violation: total_gross_settled cannot be negative (would be ₱%).', v_new_gross;
    END IF;
    IF v_new_commission < 0.00 THEN
        RAISE EXCEPTION 'Balance invariant violation: total_commission_paid cannot be negative (would be ₱%).', v_new_commission;
    END IF;
    IF v_new_unsettled < 0.00 THEN
        RAISE EXCEPTION 'Balance invariant violation: unsettled_clearing_amount cannot be negative (would be ₱%).', v_new_unsettled;
    END IF;
    IF v_new_available < 0.00 THEN
        RAISE EXCEPTION 'Insufficient withdrawable balance: Available ₱%, required deduction ₱% (would result in ₱%).',
            v_org_balance.available_withdrawable_balance, abs(v_delta_available_withdrawable), v_new_available;
    END IF;
    IF v_new_pending < 0.00 THEN
        RAISE EXCEPTION 'Balance invariant violation: pending_payout_amount cannot be negative (would be ₱%).', v_new_pending;
    END IF;
    IF v_new_withdrawn < 0.00 THEN
        RAISE EXCEPTION 'Balance invariant violation: total_withdrawn cannot be negative (would be ₱%).', v_new_withdrawn;
    END IF;
    IF v_new_negative_recovery < 0.00 THEN
        RAISE EXCEPTION 'Balance invariant violation: negative_recovery_balance cannot be negative (would be ₱%).', v_new_negative_recovery;
    END IF;

    -- 8. Create Financial Transaction Header with Versioned Canonical Payload Hash
    INSERT INTO public.financial_transactions (
        organization_id,
        facility_id,
        transaction_type,
        idempotency_key,
        reference_id,
        description,
        canonical_payload_hash,
        metadata
    ) VALUES (
        p_organization_id,
        p_facility_id,
        v_clean_type,
        v_clean_key,
        p_reference_id,
        v_clean_desc,
        v_canonical_hash,
        p_metadata || jsonb_build_object(
            'total_debits', v_total_debits,
            'total_credits', v_total_credits,
            'entry_count', jsonb_array_length(p_entries),
            'canonical_payload', v_canonical_payload
        )
    ) RETURNING id, transaction_number INTO v_new_tx_id, v_new_tx_number;

    -- 9. Insert Ledger Entries with Deterministic Transaction Sequence Ordering Across All 11 Accounts
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        v_entry_account := trim(v_item->>'account_code');
        v_entry_direction := upper(trim(v_item->>'entry_direction'));
        v_entry_amount := (v_item->>'amount')::NUMERIC(10, 2);

        -- Deterministic lookup: Sequence based on ft.transaction_number DESC, le.entry_order DESC (immune to timestamp skew)
        IF v_entry_account = '1010' AND v_running_1010 IS NULL THEN
            SELECT le.running_balance INTO v_running_1010
            FROM public.ledger_entries le
            JOIN public.financial_transactions ft ON ft.id = le.transaction_id
            WHERE le.organization_id = p_organization_id AND le.account_code = '1010'
            ORDER BY ft.transaction_number DESC, le.entry_order DESC LIMIT 1;
            v_running_1010 := COALESCE(v_running_1010, 0.00);
        ELSIF v_entry_account = '1020' AND v_running_1020 IS NULL THEN
            SELECT le.running_balance INTO v_running_1020
            FROM public.ledger_entries le
            JOIN public.financial_transactions ft ON ft.id = le.transaction_id
            WHERE le.organization_id = p_organization_id AND le.account_code = '1020'
            ORDER BY ft.transaction_number DESC, le.entry_order DESC LIMIT 1;
            v_running_1020 := COALESCE(v_running_1020, 0.00);
        ELSIF v_entry_account = '1030' AND v_running_1030 IS NULL THEN
            SELECT le.running_balance INTO v_running_1030
            FROM public.ledger_entries le
            JOIN public.financial_transactions ft ON ft.id = le.transaction_id
            WHERE le.organization_id = p_organization_id AND le.account_code = '1030'
            ORDER BY ft.transaction_number DESC, le.entry_order DESC LIMIT 1;
            v_running_1030 := COALESCE(v_running_1030, 0.00);
        ELSIF v_entry_account = '2010' AND v_running_2010 IS NULL THEN
            SELECT le.running_balance INTO v_running_2010
            FROM public.ledger_entries le
            JOIN public.financial_transactions ft ON ft.id = le.transaction_id
            WHERE le.organization_id = p_organization_id AND le.account_code = '2010'
            ORDER BY ft.transaction_number DESC, le.entry_order DESC LIMIT 1;
            v_running_2010 := COALESCE(v_running_2010, 0.00);
        ELSIF v_entry_account = '2011' AND v_running_2011 IS NULL THEN
            SELECT le.running_balance INTO v_running_2011
            FROM public.ledger_entries le
            JOIN public.financial_transactions ft ON ft.id = le.transaction_id
            WHERE le.organization_id = p_organization_id AND le.account_code = '2011'
            ORDER BY ft.transaction_number DESC, le.entry_order DESC LIMIT 1;
            v_running_2011 := COALESCE(v_running_2011, 0.00);
        ELSIF v_entry_account = '2012' AND v_running_2012 IS NULL THEN
            SELECT le.running_balance INTO v_running_2012
            FROM public.ledger_entries le
            JOIN public.financial_transactions ft ON ft.id = le.transaction_id
            WHERE le.organization_id = p_organization_id AND le.account_code = '2012'
            ORDER BY ft.transaction_number DESC, le.entry_order DESC LIMIT 1;
            v_running_2012 := COALESCE(v_running_2012, 0.00);
        ELSIF v_entry_account = '2015' AND v_running_2015 IS NULL THEN
            SELECT le.running_balance INTO v_running_2015
            FROM public.ledger_entries le
            JOIN public.financial_transactions ft ON ft.id = le.transaction_id
            WHERE le.organization_id = p_organization_id AND le.account_code = '2015'
            ORDER BY ft.transaction_number DESC, le.entry_order DESC LIMIT 1;
            v_running_2015 := COALESCE(v_running_2015, 0.00);
        ELSIF v_entry_account = '2020' AND v_running_2020 IS NULL THEN
            SELECT le.running_balance INTO v_running_2020
            FROM public.ledger_entries le
            JOIN public.financial_transactions ft ON ft.id = le.transaction_id
            WHERE le.organization_id = p_organization_id AND le.account_code = '2020'
            ORDER BY ft.transaction_number DESC, le.entry_order DESC LIMIT 1;
            v_running_2020 := COALESCE(v_running_2020, 0.00);
        ELSIF v_entry_account = '2030' AND v_running_2030 IS NULL THEN
            SELECT le.running_balance INTO v_running_2030
            FROM public.ledger_entries le
            JOIN public.financial_transactions ft ON ft.id = le.transaction_id
            WHERE le.organization_id = p_organization_id AND le.account_code = '2030'
            ORDER BY ft.transaction_number DESC, le.entry_order DESC LIMIT 1;
            v_running_2030 := COALESCE(v_running_2030, 0.00);
        ELSIF v_entry_account = '4010' AND v_running_4010 IS NULL THEN
            SELECT le.running_balance INTO v_running_4010
            FROM public.ledger_entries le
            JOIN public.financial_transactions ft ON ft.id = le.transaction_id
            WHERE le.organization_id = p_organization_id AND le.account_code = '4010'
            ORDER BY ft.transaction_number DESC, le.entry_order DESC LIMIT 1;
            v_running_4010 := COALESCE(v_running_4010, 0.00);
        ELSIF v_entry_account = '5010' AND v_running_5010 IS NULL THEN
            SELECT le.running_balance INTO v_running_5010
            FROM public.ledger_entries le
            JOIN public.financial_transactions ft ON ft.id = le.transaction_id
            WHERE le.organization_id = p_organization_id AND le.account_code = '5010'
            ORDER BY ft.transaction_number DESC, le.entry_order DESC LIMIT 1;
            v_running_5010 := COALESCE(v_running_5010, 0.00);
        END IF;

        -- Apply debit/credit normal balance rules
        -- Assets (1010, 1020, 1030) and Expenses (5010): Normal balance = DEBIT
        -- Liabilities (2010, 2011, 2012, 2015, 2020, 2030) and Revenue (4010): Normal balance = CREDIT
        IF v_entry_account IN ('1010', '1020', '1030', '5010') THEN
            IF v_entry_direction = 'DEBIT' THEN
                v_current_entry_balance := CASE v_entry_account
                    WHEN '1010' THEN v_running_1010 + v_entry_amount
                    WHEN '1020' THEN v_running_1020 + v_entry_amount
                    WHEN '1030' THEN v_running_1030 + v_entry_amount
                    WHEN '5010' THEN v_running_5010 + v_entry_amount
                END;
            ELSE
                v_current_entry_balance := CASE v_entry_account
                    WHEN '1010' THEN v_running_1010 - v_entry_amount
                    WHEN '1020' THEN v_running_1020 - v_entry_amount
                    WHEN '1030' THEN v_running_1030 - v_entry_amount
                    WHEN '5010' THEN v_running_5010 - v_entry_amount
                END;
            END IF;
        ELSE
            -- Liabilities & Revenue
            IF v_entry_direction = 'CREDIT' THEN
                v_current_entry_balance := CASE v_entry_account
                    WHEN '2010' THEN v_running_2010 + v_entry_amount
                    WHEN '2011' THEN v_running_2011 + v_entry_amount
                    WHEN '2012' THEN v_running_2012 + v_entry_amount
                    WHEN '2015' THEN v_running_2015 + v_entry_amount
                    WHEN '2020' THEN v_running_2020 + v_entry_amount
                    WHEN '2030' THEN v_running_2030 + v_entry_amount
                    WHEN '4010' THEN v_running_4010 + v_entry_amount
                END;
            ELSE
                v_current_entry_balance := CASE v_entry_account
                    WHEN '2010' THEN v_running_2010 - v_entry_amount
                    WHEN '2011' THEN v_running_2011 - v_entry_amount
                    WHEN '2012' THEN v_running_2012 - v_entry_amount
                    WHEN '2015' THEN v_running_2015 - v_entry_amount
                    WHEN '2020' THEN v_running_2020 - v_entry_amount
                    WHEN '2030' THEN v_running_2030 - v_entry_amount
                    WHEN '4010' THEN v_running_4010 - v_entry_amount
                END;
            END IF;
        END IF;

        -- Update in-memory tracker for multi-line transactions
        IF v_entry_account = '1010' THEN v_running_1010 := v_current_entry_balance;
        ELSIF v_entry_account = '1020' THEN v_running_1020 := v_current_entry_balance;
        ELSIF v_entry_account = '1030' THEN v_running_1030 := v_current_entry_balance;
        ELSIF v_entry_account = '2010' THEN v_running_2010 := v_current_entry_balance;
        ELSIF v_entry_account = '2011' THEN v_running_2011 := v_current_entry_balance;
        ELSIF v_entry_account = '2012' THEN v_running_2012 := v_current_entry_balance;
        ELSIF v_entry_account = '2015' THEN v_running_2015 := v_current_entry_balance;
        ELSIF v_entry_account = '2020' THEN v_running_2020 := v_current_entry_balance;
        ELSIF v_entry_account = '2030' THEN v_running_2030 := v_current_entry_balance;
        ELSIF v_entry_account = '4010' THEN v_running_4010 := v_current_entry_balance;
        ELSIF v_entry_account = '5010' THEN v_running_5010 := v_current_entry_balance;
        END IF;

        INSERT INTO public.ledger_entries (
            transaction_id,
            organization_id,
            account_code,
            entry_direction,
            amount,
            entry_order,
            running_balance
        ) VALUES (
            v_new_tx_id,
            p_organization_id,
            v_entry_account,
            v_entry_direction,
            v_entry_amount,
            v_order,
            v_current_entry_balance
        );

        v_order := v_order + 1;
    END LOOP;

    -- 10. Update Materialized Organization Balance
    UPDATE public.organization_balances
    SET total_gross_settled = v_new_gross,
        total_commission_paid = v_new_commission,
        unsettled_clearing_amount = v_new_unsettled,
        available_withdrawable_balance = v_new_available,
        pending_payout_amount = v_new_pending,
        total_withdrawn = v_new_withdrawn,
        negative_recovery_balance = v_new_negative_recovery,
        last_journal_transaction_id = v_new_tx_id,
        updated_at = now()
    WHERE organization_id = p_organization_id;

    RETURN jsonb_build_object(
        'success', true,
        'transaction_id', v_new_tx_id,
        'transaction_number', v_new_tx_number,
        'total_amount', v_total_debits,
        'organization_id', p_organization_id,
        'available_withdrawable_balance', v_new_available,
        'unsettled_clearing_amount', v_new_unsettled,
        'negative_recovery_balance', v_new_negative_recovery,
        'idempotent_duplicate', false
    );
END;
$$;

-- ==============================================================================
-- 4. Re-Apply Strict EXECUTE Privilege Revocations (Zero-Trust Security)
-- ==============================================================================

REVOKE ALL ON FUNCTION public.post_journal_entry_internal(UUID, UUID, VARCHAR, TEXT, UUID, TEXT, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_financial_tx_canonical_hash()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_positive_ledger_entry_amount()
    FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
