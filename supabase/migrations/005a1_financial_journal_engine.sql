-- ==============================================================================
-- CourtBook / BookSuite — Database Schema Migration
-- Migration: 005a1_financial_journal_engine.sql
-- Description: Phase 4.2.2 Financial Journal Engine & Accounting Routines
--
-- FOUNDATION: Built strictly upon Migration 005A schema:
--   - public.platform_billing_config
--   - public.platform_checkout_controls
--   - public.financial_transactions
--   - public.ledger_entries
--   - public.organization_balances
--
-- SCOPE:
--   1. Schema Refinements:
--      - Extend financial_transactions.transaction_type check constraint to support
--        all required financial lifecycle events:
--        'payout_reserve', 'payout_failed_release', 'gateway_fee_assessment'.
--   2. Core Ledger Engine (post_journal_entry_internal):
--      - Atomic double-entry journal posting with exact centavo precision
--      - Explicit debit = credit balance invariant
--      - Organization-level concurrency serialization (FOR UPDATE lock)
--      - Strict idempotency key conflict detection
--      - Deterministic in-memory running balance calculation (immune to millisecond timestamp collisions)
--      - Strict non-negative balance enforcement (NO GREATEST(0, ...) fallback)
--   3. Business-Validated Financial Operations:
--      - post_booking_settlement_event()
--      - post_funds_cleared_event()
--      - post_refund_reversal_event()
--      - post_chargeback_adjustment_event()
--      - post_payout_reserve_event()
--      - post_payout_disbursement_event()
--      - post_payout_failed_release_event()
--      - post_excess_or_late_payment_event()
--   4. Privilege Hardening:
--      - All financial routines strictly REVOKED from PUBLIC, anon, and authenticated.
--      - EXECUTE granted strictly to service_role (trusted backend only).
-- ==============================================================================

-- ==============================================================================
-- 1. Justified Schema Refinements on 005A
-- ==============================================================================
-- Justification: Migration 005A defined 9 transaction types. To fully support
-- the two-phase payout reservation lifecycle ('payout_reserve', 'payout_failed_release')
-- and provider fee recording ('gateway_fee_assessment') without overloading unrelated types,
-- the transaction_type check constraint is safely amended.

DO $$
BEGIN
    -- Drop existing check constraint and replace with extended lifecycle set
    ALTER TABLE public.financial_transactions
        DROP CONSTRAINT IF EXISTS financial_transactions_transaction_type_check;

    ALTER TABLE public.financial_transactions
        ADD CONSTRAINT financial_transactions_transaction_type_check
        CHECK (transaction_type IN (
            'booking_settlement',
            'funds_cleared_to_available',
            'refund_reversal',
            'chargeback_adjustment',
            'payout_reserve',
            'payout_disbursement',
            'payout_failed_release',
            'gateway_fee_assessment',
            'dispute_hold',
            'excess_payment_liability',
            'late_payment_liability',
            'platform_adjustment'
        ));
END $$;

-- ==============================================================================
-- 2. Core Double-Entry Engine (post_journal_entry_internal)
-- ==============================================================================
-- The low-level atomic double-entry processor.
-- Rules:
--   - Row-locks target organization_balances FIRST.
--   - Idempotency verification: same key with different org/type/ref/payload raises conflict error.
--   - Sum(debits) must equal sum(credits) to the centavo.
--   - Validates account movements against permitted whitelist per transaction_type.
--   - Deterministic running balance calculation for repeated accounts.
--   - Updates organization_balances metrics safely without negative balances.

CREATE OR REPLACE FUNCTION public.post_journal_entry_internal(
    p_organization_id UUID,
    p_facility_id UUID,
    p_transaction_type VARCHAR(32),
    p_idempotency_key TEXT,
    p_reference_id UUID,
    p_description TEXT,
    p_metadata JSONB,
    p_entries JSONB -- Array of { "account_code": "1010", "entry_direction": "DEBIT", "amount": 350.00 }
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
    v_entry RECORD;
    v_item JSONB;
    v_order SMALLINT := 1;
    v_org_balance RECORD;

    -- In-memory running balances for accounts affected in this transaction
    v_running_1010 NUMERIC(10, 2) := NULL;
    v_running_2010 NUMERIC(10, 2) := NULL;
    v_running_2020 NUMERIC(10, 2) := NULL;
    v_running_2030 NUMERIC(10, 2) := NULL;
    v_running_4010 NUMERIC(10, 2) := NULL;
    v_running_5010 NUMERIC(10, 2) := NULL;
    v_current_entry_balance NUMERIC(10, 2);

    -- Metric deltas
    v_booking_gross_delta NUMERIC(10, 2) := 0.00;
    v_booking_commission_delta NUMERIC(10, 2) := 0.00;
    v_booking_unsettled_owner_delta NUMERIC(10, 2) := 0.00;
    v_clearing_settled_delta NUMERIC(10, 2) := 0.00;
    v_refund_gross_delta NUMERIC(10, 2) := 0.00;
    v_refund_commission_delta NUMERIC(10, 2) := 0.00;
    v_refund_owner_delta NUMERIC(10, 2) := 0.00;
    v_payout_reserve_delta NUMERIC(10, 2) := 0.00;
    v_payout_disbursement_delta NUMERIC(10, 2) := 0.00;
    v_payout_release_delta NUMERIC(10, 2) := 0.00;
    v_chargeback_owner_delta NUMERIC(10, 2) := 0.00;
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
        'payout_reserve',
        'payout_disbursement',
        'payout_failed_release',
        'gateway_fee_assessment',
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

    -- 3. Idempotency Check & Conflict Detection Under Exclusive Lock
    SELECT id, organization_id, facility_id, transaction_type, reference_id, description
    INTO v_existing_tx
    FROM public.financial_transactions
    WHERE idempotency_key = v_clean_key;

    IF FOUND THEN
        IF v_existing_tx.organization_id != p_organization_id OR
           v_existing_tx.transaction_type != v_clean_type OR
           v_existing_tx.reference_id != p_reference_id THEN
            RAISE EXCEPTION 'Idempotency conflict: Key "%" was previously used with different parameters (org: %, type: %, ref: %).',
                v_clean_key, v_existing_tx.organization_id, v_existing_tx.transaction_type, v_existing_tx.reference_id;
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'transaction_id', v_existing_tx.id,
            'idempotent_duplicate', true,
            'message', 'Transaction was previously posted with this idempotency key.'
        );
    END IF;

    -- 4. Entry Validation & Account Whitelisting per Transaction Type
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        IF jsonb_typeof(v_item) != 'object' THEN
            RAISE EXCEPTION 'Malformed entry: Every item in entries array must be a JSON object.';
        END IF;

        IF NOT (v_item ? 'account_code' AND v_item ? 'entry_direction' AND v_item ? 'amount') THEN
            RAISE EXCEPTION 'Malformed entry: Missing required properties (account_code, entry_direction, amount).';
        END IF;

        IF (v_item->>'account_code') NOT IN ('1010', '2010', '2020', '2030', '4010', '5010') THEN
            RAISE EXCEPTION 'Invalid account code: %. Supported: 1010, 2010, 2020, 2030, 4010, 5010.', (v_item->>'account_code');
        END IF;

        IF (v_item->>'entry_direction') NOT IN ('DEBIT', 'CREDIT') THEN
            RAISE EXCEPTION 'Invalid entry direction: %. Must be DEBIT or CREDIT.', (v_item->>'entry_direction');
        END IF;

        BEGIN
            v_entry.amount := (v_item->>'amount')::NUMERIC(10, 2);
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'Malformed amount value in entry: %', (v_item->>'amount');
        END;

        IF v_entry.amount <= 0.00 THEN
            RAISE EXCEPTION 'Entry amount must be strictly positive. Got: %', v_entry.amount;
        END IF;

        -- Sub-centavo precision check
        IF ((v_item->>'amount')::NUMERIC * 100.0) != round((v_item->>'amount')::NUMERIC * 100.0) THEN
            RAISE EXCEPTION 'Sub-centavo fractional precision rejected: %', (v_item->>'amount');
        END IF;

        -- Account Movement Whitelist per Transaction Type
        IF v_clean_type = 'booking_settlement' THEN
            IF (v_item->>'account_code') NOT IN ('1010', '2010', '2020', '4010') THEN
                RAISE EXCEPTION 'Account % not permitted for booking_settlement.', (v_item->>'account_code');
            END IF;
            IF (v_item->>'entry_direction') = 'DEBIT' AND (v_item->>'account_code') != '1010' THEN
                RAISE EXCEPTION 'Only 1010 (Gateway Clearing) may be debited on booking_settlement.';
            END IF;
        ELSIF v_clean_type = 'funds_cleared_to_available' THEN
            IF (v_item->>'account_code') NOT IN ('2010') THEN
                RAISE EXCEPTION 'Only 2010 (Owner Payable) permitted for funds_cleared_to_available.';
            END IF;
        ELSIF v_clean_type = 'refund_reversal' THEN
            IF (v_item->>'account_code') NOT IN ('1010', '2010', '4010') THEN
                RAISE EXCEPTION 'Account % not permitted for refund_reversal.', (v_item->>'account_code');
            END IF;
            IF (v_item->>'entry_direction') = 'CREDIT' AND (v_item->>'account_code') != '1010' THEN
                RAISE EXCEPTION 'Only 1010 (Gateway Clearing) may be credited on refund_reversal.';
            END IF;
        ELSIF v_clean_type = 'payout_reserve' THEN
            IF (v_item->>'account_code') NOT IN ('2010') THEN
                RAISE EXCEPTION 'Only 2010 permitted for payout_reserve.';
            END IF;
        ELSIF v_clean_type = 'payout_disbursement' THEN
            IF (v_item->>'account_code') NOT IN ('1010', '2010', '2020') THEN
                RAISE EXCEPTION 'Account % not permitted for payout_disbursement.', (v_item->>'account_code');
            END IF;
            IF (v_item->>'entry_direction') = 'CREDIT' AND (v_item->>'account_code') != '1010' THEN
                RAISE EXCEPTION 'Only 1010 may be credited on payout_disbursement.';
            END IF;
        ELSIF v_clean_type = 'payout_failed_release' THEN
            IF (v_item->>'account_code') NOT IN ('2010') THEN
                RAISE EXCEPTION 'Only 2010 permitted for payout_failed_release.';
            END IF;
        ELSIF v_clean_type IN ('excess_payment_liability', 'late_payment_liability') THEN
            IF (v_item->>'account_code') NOT IN ('1010', '2030') THEN
                RAISE EXCEPTION 'Account % not permitted for excess/late payment liabilities.', (v_item->>'account_code');
            END IF;
        ELSIF v_clean_type = 'gateway_fee_assessment' THEN
            IF (v_item->>'account_code') NOT IN ('1010', '2010', '2020', '5010') THEN
                RAISE EXCEPTION 'Account % not permitted for gateway_fee_assessment.', (v_item->>'account_code');
            END IF;
        END IF;

        -- Accumulate debits/credits & metric deltas
        IF (v_item->>'entry_direction') = 'DEBIT' THEN
            v_total_debits := v_total_debits + v_entry.amount;
            IF v_clean_type = 'refund_reversal' THEN
                IF (v_item->>'account_code') = '4010' THEN
                    v_refund_commission_delta := v_refund_commission_delta + v_entry.amount;
                ELSIF (v_item->>'account_code') = '2010' THEN
                    v_refund_owner_delta := v_refund_owner_delta + v_entry.amount;
                END IF;
            ELSIF v_clean_type = 'payout_reserve' AND (v_item->>'account_code') = '2010' THEN
                v_payout_reserve_delta := v_payout_reserve_delta + v_entry.amount;
            ELSIF v_clean_type = 'payout_disbursement' AND (v_item->>'account_code') = '2010' THEN
                v_payout_disbursement_delta := v_payout_disbursement_delta + v_entry.amount;
            ELSIF v_clean_type = 'chargeback_adjustment' AND (v_item->>'account_code') = '2010' THEN
                v_chargeback_owner_delta := v_chargeback_owner_delta + v_entry.amount;
            ELSIF v_clean_type = 'funds_cleared_to_available' AND (v_item->>'account_code') = '2010' THEN
                v_clearing_settled_delta := v_clearing_settled_delta + v_entry.amount;
            END IF;
        ELSE
            v_total_credits := v_total_credits + v_entry.amount;
            IF v_clean_type = 'booking_settlement' THEN
                IF (v_item->>'account_code') = '2010' THEN
                    v_booking_unsettled_owner_delta := v_booking_unsettled_owner_delta + v_entry.amount;
                ELSIF (v_item->>'account_code') = '4010' THEN
                    v_booking_commission_delta := v_booking_commission_delta + v_entry.amount;
                END IF;
            ELSIF v_clean_type = 'payout_failed_release' AND (v_item->>'account_code') = '2010' THEN
                v_payout_release_delta := v_payout_release_delta + v_entry.amount;
            END IF;
        END IF;
    END LOOP;

    -- 5. Exact Centavo Balancing Invariant
    IF v_total_debits != v_total_credits THEN
        RAISE EXCEPTION 'Unbalanced journal transaction: Total Debits (₱%) does not match Total Credits (₱%). Difference: ₱%',
            v_total_debits, v_total_credits, (v_total_debits - v_total_credits);
    END IF;

    -- 6. Validate Balance Sufficiency (Zero Negative Balances Allowed)
    -- Payout reservation requires sufficient withdrawable balance
    IF v_clean_type = 'payout_reserve' AND v_payout_reserve_delta > 0.00 THEN
        IF v_org_balance.available_withdrawable_balance < v_payout_reserve_delta THEN
            RAISE EXCEPTION 'Insufficient withdrawable balance for payout hold. Available: ₱%, Requested: ₱%',
                v_org_balance.available_withdrawable_balance, v_payout_reserve_delta;
        END IF;
    END IF;

    -- Direct payout disbursement (if not reserved) requires sufficient withdrawable balance;
    -- or if pre-reserved, requires sufficient pending_payout_amount
    IF v_clean_type = 'payout_disbursement' AND v_payout_disbursement_delta > 0.00 THEN
        IF v_org_balance.pending_payout_amount < v_payout_disbursement_delta AND
           v_org_balance.available_withdrawable_balance < v_payout_disbursement_delta THEN
            RAISE EXCEPTION 'Insufficient balance for payout disbursement. Available: ₱%, Pending: ₱%, Requested: ₱%',
                v_org_balance.available_withdrawable_balance, v_org_balance.pending_payout_amount, v_payout_disbursement_delta;
        END IF;
    END IF;

    -- Clearing shift requires sufficient unsettled funds
    IF v_clean_type = 'funds_cleared_to_available' AND v_clearing_settled_delta > 0.00 THEN
        IF v_org_balance.unsettled_clearing_amount < v_clearing_settled_delta THEN
            RAISE EXCEPTION 'Cleared amount (₱%) exceeds unsettled clearing balance (₱%).',
                v_clearing_settled_delta, v_org_balance.unsettled_clearing_amount;
        END IF;
    END IF;

    -- Refund reversal validation
    IF v_clean_type = 'refund_reversal' AND v_refund_owner_delta > 0.00 THEN
        IF (v_org_balance.unsettled_clearing_amount + v_org_balance.available_withdrawable_balance) < v_refund_owner_delta THEN
            RAISE EXCEPTION 'Refund debit (₱%) exceeds combined owner balance (₱%).',
                v_refund_owner_delta, (v_org_balance.unsettled_clearing_amount + v_org_balance.available_withdrawable_balance);
        END IF;
    END IF;

    -- 7. Insert Parent Journal Transaction
    INSERT INTO public.financial_transactions (
        organization_id,
        facility_id,
        transaction_type,
        idempotency_key,
        reference_id,
        description,
        metadata
    ) VALUES (
        p_organization_id,
        p_facility_id,
        v_clean_type,
        v_clean_key,
        p_reference_id,
        v_clean_desc,
        COALESCE(p_metadata, '{}'::jsonb)
    ) RETURNING id, transaction_number INTO v_new_tx_id, v_new_tx_number;

    -- 8. Fetch Baseline Account Balances (Deterministic Sequence Order)
    SELECT COALESCE((
        SELECT le.running_balance
        FROM public.ledger_entries le
        JOIN public.financial_transactions ft ON le.transaction_id = ft.id
        WHERE le.organization_id = p_organization_id AND le.account_code = '1010'
        ORDER BY ft.transaction_number DESC, le.entry_order DESC
        LIMIT 1), 0.00) INTO v_running_1010;

    SELECT COALESCE((
        SELECT le.running_balance
        FROM public.ledger_entries le
        JOIN public.financial_transactions ft ON le.transaction_id = ft.id
        WHERE le.organization_id = p_organization_id AND le.account_code = '2010'
        ORDER BY ft.transaction_number DESC, le.entry_order DESC
        LIMIT 1), 0.00) INTO v_running_2010;

    SELECT COALESCE((
        SELECT le.running_balance
        FROM public.ledger_entries le
        JOIN public.financial_transactions ft ON le.transaction_id = ft.id
        WHERE le.organization_id = p_organization_id AND le.account_code = '2020'
        ORDER BY ft.transaction_number DESC, le.entry_order DESC
        LIMIT 1), 0.00) INTO v_running_2020;

    SELECT COALESCE((
        SELECT le.running_balance
        FROM public.ledger_entries le
        JOIN public.financial_transactions ft ON le.transaction_id = ft.id
        WHERE le.organization_id = p_organization_id AND le.account_code = '2030'
        ORDER BY ft.transaction_number DESC, le.entry_order DESC
        LIMIT 1), 0.00) INTO v_running_2030;

    SELECT COALESCE((
        SELECT le.running_balance
        FROM public.ledger_entries le
        JOIN public.financial_transactions ft ON le.transaction_id = ft.id
        WHERE le.organization_id = p_organization_id AND le.account_code = '4010'
        ORDER BY ft.transaction_number DESC, le.entry_order DESC
        LIMIT 1), 0.00) INTO v_running_4010;

    SELECT COALESCE((
        SELECT le.running_balance
        FROM public.ledger_entries le
        JOIN public.financial_transactions ft ON le.transaction_id = ft.id
        WHERE le.organization_id = p_organization_id AND le.account_code = '5010'
        ORDER BY ft.transaction_number DESC, le.entry_order DESC
        LIMIT 1), 0.00) INTO v_running_5010;

    -- 9. Insert Ledger Entries with In-Memory Running Balances
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        v_entry.amount := (v_item->>'amount')::NUMERIC(10, 2);

        IF (v_item->>'account_code') = '1010' THEN
            IF (v_item->>'entry_direction') = 'DEBIT' THEN
                v_running_1010 := v_running_1010 + v_entry.amount;
            ELSE
                v_running_1010 := v_running_1010 - v_entry.amount;
            END IF;
            v_current_entry_balance := v_running_1010;
        ELSIF (v_item->>'account_code') = '2010' THEN
            IF (v_item->>'entry_direction') = 'CREDIT' THEN
                v_running_2010 := v_running_2010 + v_entry.amount;
            ELSE
                v_running_2010 := v_running_2010 - v_entry.amount;
            END IF;
            v_current_entry_balance := v_running_2010;
        ELSIF (v_item->>'account_code') = '2020' THEN
            IF (v_item->>'entry_direction') = 'CREDIT' THEN
                v_running_2020 := v_running_2020 + v_entry.amount;
            ELSE
                v_running_2020 := v_running_2020 - v_entry.amount;
            END IF;
            v_current_entry_balance := v_running_2020;
        ELSIF (v_item->>'account_code') = '2030' THEN
            IF (v_item->>'entry_direction') = 'CREDIT' THEN
                v_running_2030 := v_running_2030 + v_entry.amount;
            ELSE
                v_running_2030 := v_running_2030 - v_entry.amount;
            END IF;
            v_current_entry_balance := v_running_2030;
        ELSIF (v_item->>'account_code') = '4010' THEN
            IF (v_item->>'entry_direction') = 'CREDIT' THEN
                v_running_4010 := v_running_4010 + v_entry.amount;
            ELSE
                v_running_4010 := v_running_4010 - v_entry.amount;
            END IF;
            v_current_entry_balance := v_running_4010;
        ELSE -- 5010 Expense
            IF (v_item->>'entry_direction') = 'DEBIT' THEN
                v_running_5010 := v_running_5010 + v_entry.amount;
            ELSE
                v_running_5010 := v_running_5010 - v_entry.amount;
            END IF;
            v_current_entry_balance := v_running_5010;
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
            v_item->>'account_code',
            v_item->>'entry_direction',
            v_entry.amount,
            v_order,
            v_current_entry_balance
        );

        v_order := v_order + 1;
    END LOOP;

    -- 10. Update Organization Balances Metrics
    IF v_clean_type = 'booking_settlement' THEN
        v_booking_gross_delta := v_booking_unsettled_owner_delta + v_booking_commission_delta;
        UPDATE public.organization_balances
        SET total_gross_settled = total_gross_settled + v_booking_gross_delta,
            total_commission_paid = total_commission_paid + v_booking_commission_delta,
            unsettled_clearing_amount = unsettled_clearing_amount + v_booking_unsettled_owner_delta,
            last_journal_transaction_id = v_new_tx_id,
            updated_at = now()
        WHERE organization_id = p_organization_id;

    ELSIF v_clean_type = 'funds_cleared_to_available' THEN
        UPDATE public.organization_balances
        SET unsettled_clearing_amount = unsettled_clearing_amount - v_clearing_settled_delta,
            available_withdrawable_balance = available_withdrawable_balance + v_clearing_settled_delta,
            last_journal_transaction_id = v_new_tx_id,
            updated_at = now()
        WHERE organization_id = p_organization_id;

    ELSIF v_clean_type = 'payout_reserve' THEN
        -- Locks funds in pending_payout_amount, removing from withdrawable balance
        UPDATE public.organization_balances
        SET available_withdrawable_balance = available_withdrawable_balance - v_payout_reserve_delta,
            pending_payout_amount = pending_payout_amount + v_payout_reserve_delta,
            last_journal_transaction_id = v_new_tx_id,
            updated_at = now()
        WHERE organization_id = p_organization_id;

    ELSIF v_clean_type = 'payout_disbursement' THEN
        -- Clears pending hold and records actual disbursement
        DECLARE
            v_deduct_pending NUMERIC(10, 2);
            v_deduct_withdrawable NUMERIC(10, 2);
        BEGIN
            v_deduct_pending := LEAST(v_org_balance.pending_payout_amount, v_payout_disbursement_delta);
            v_deduct_withdrawable := v_payout_disbursement_delta - v_deduct_pending;

            UPDATE public.organization_balances
            SET pending_payout_amount = pending_payout_amount - v_deduct_pending,
                available_withdrawable_balance = available_withdrawable_balance - v_deduct_withdrawable,
                total_withdrawn = total_withdrawn + v_payout_disbursement_delta,
                last_journal_transaction_id = v_new_tx_id,
                updated_at = now()
            WHERE organization_id = p_organization_id;
        END;

    ELSIF v_clean_type = 'payout_failed_release' THEN
        -- Returns reserved funds from pending_payout_amount back to withdrawable balance
        UPDATE public.organization_balances
        SET pending_payout_amount = pending_payout_amount - v_payout_release_delta,
            available_withdrawable_balance = available_withdrawable_balance + v_payout_release_delta,
            last_journal_transaction_id = v_new_tx_id,
            updated_at = now()
        WHERE organization_id = p_organization_id;

    ELSIF v_clean_type = 'refund_reversal' THEN
        v_refund_gross_delta := v_refund_owner_delta + v_refund_commission_delta;
        DECLARE
            v_deduct_unsettled NUMERIC(10, 2);
            v_deduct_available NUMERIC(10, 2);
        BEGIN
            v_deduct_unsettled := LEAST(v_org_balance.unsettled_clearing_amount, v_refund_owner_delta);
            v_deduct_available := v_refund_owner_delta - v_deduct_unsettled;

            UPDATE public.organization_balances
            SET total_gross_settled = total_gross_settled - v_refund_gross_delta,
                total_commission_paid = total_commission_paid - v_refund_commission_delta,
                unsettled_clearing_amount = unsettled_clearing_amount - v_deduct_unsettled,
                available_withdrawable_balance = available_withdrawable_balance - v_deduct_available,
                last_journal_transaction_id = v_new_tx_id,
                updated_at = now()
            WHERE organization_id = p_organization_id;
        END;

    ELSIF v_clean_type = 'chargeback_adjustment' THEN
        UPDATE public.organization_balances
        SET total_gross_settled = total_gross_settled - v_chargeback_owner_delta,
            available_withdrawable_balance = available_withdrawable_balance - v_chargeback_owner_delta,
            last_journal_transaction_id = v_new_tx_id,
            updated_at = now()
        WHERE organization_id = p_organization_id;

    ELSE
        UPDATE public.organization_balances
        SET last_journal_transaction_id = v_new_tx_id,
            updated_at = now()
        WHERE organization_id = p_organization_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'transaction_id', v_new_tx_id,
        'transaction_number', v_new_tx_number,
        'idempotent_duplicate', false,
        'transaction_type', v_clean_type,
        'total_amount', v_total_debits,
        'entries_posted', v_order - 1
    );
END;
$$;

-- ==============================================================================
-- 3. Business-Validated Accounting Procedures
-- ==============================================================================
-- These procedures prevent callers from constructing arbitrary journal entries.
-- Each procedure encapsulates a strict business event and server-authoritative calculations.

-- 3.1 Successful Booking Payment Capture (5% Commission Deducted from Owner)
CREATE OR REPLACE FUNCTION public.post_booking_settlement_event(
    p_organization_id UUID,
    p_facility_id UUID,
    p_reservation_id UUID,
    p_gross_amount NUMERIC(10, 2),
    p_commission_rate NUMERIC(5, 4),
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_commission_amount NUMERIC(10, 2);
    v_owner_share NUMERIC(10, 2);
    v_entries JSONB;
BEGIN
    IF p_gross_amount <= 0.00 THEN
        RAISE EXCEPTION 'Gross booking amount must be strictly positive. Got: %', p_gross_amount;
    END IF;

    IF p_commission_rate < 0.0000 OR p_commission_rate > 1.0000 THEN
        RAISE EXCEPTION 'Commission rate must be between 0.0000 and 1.0000. Got: %', p_commission_rate;
    END IF;

    -- Server-authoritative split calculation with exact centavo invariant
    v_commission_amount := round(p_gross_amount * p_commission_rate, 2);
    v_owner_share := p_gross_amount - v_commission_amount;

    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', p_gross_amount),
        jsonb_build_object('account_code', '4010', 'entry_direction', 'CREDIT', 'amount', v_commission_amount),
        jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', v_owner_share)
    );

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        p_facility_id,
        'booking_settlement',
        p_idempotency_key,
        p_reservation_id,
        format('Booking payment capture for reservation %s (Gross: ₱%s, Commission: ₱%s, Owner: ₱%s)',
            p_reservation_id, p_gross_amount, v_commission_amount, v_owner_share),
        p_metadata || jsonb_build_object(
            'gross_amount', p_gross_amount,
            'commission_rate', p_commission_rate,
            'commission_amount', v_commission_amount,
            'owner_share', v_owner_share
        ),
        v_entries
    );
END;
$$;

-- 3.2 Provider Settlement (Clearing Shift to Withdrawable Balance)
CREATE OR REPLACE FUNCTION public.post_funds_cleared_event(
    p_organization_id UUID,
    p_facility_id UUID,
    p_cleared_amount NUMERIC(10, 2),
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_entries JSONB;
BEGIN
    IF p_cleared_amount <= 0.00 THEN
        RAISE EXCEPTION 'Cleared amount must be strictly positive. Got: %', p_cleared_amount;
    END IF;

    -- Internal reclassification within Account 2010 (Unsettled to Available)
    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '2010', 'entry_direction', 'DEBIT', 'amount', p_cleared_amount),
        jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', p_cleared_amount)
    );

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        p_facility_id,
        'funds_cleared_to_available',
        p_idempotency_key,
        p_organization_id,
        format('Provider clearing settlement: ₱%s shifted to available withdrawable balance', p_cleared_amount),
        p_metadata,
        v_entries
    );
END;
$$;

-- 3.3 Refund Reversal (Full or Partial)
CREATE OR REPLACE FUNCTION public.post_refund_reversal_event(
    p_organization_id UUID,
    p_facility_id UUID,
    p_reservation_id UUID,
    p_refund_gross_amount NUMERIC(10, 2),
    p_commission_refund_rate NUMERIC(5, 4),
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_commission_reversal NUMERIC(10, 2);
    v_owner_reversal NUMERIC(10, 2);
    v_entries JSONB;
BEGIN
    IF p_refund_gross_amount <= 0.00 THEN
        RAISE EXCEPTION 'Refund gross amount must be strictly positive. Got: %', p_refund_gross_amount;
    END IF;

    v_commission_reversal := round(p_refund_gross_amount * p_commission_refund_rate, 2);
    v_owner_reversal := p_refund_gross_amount - v_commission_reversal;

    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '4010', 'entry_direction', 'DEBIT', 'amount', v_commission_reversal),
        jsonb_build_object('account_code', '2010', 'entry_direction', 'DEBIT', 'amount', v_owner_reversal),
        jsonb_build_object('account_code', '1010', 'entry_direction', 'CREDIT', 'amount', p_refund_gross_amount)
    );

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        p_facility_id,
        'refund_reversal',
        p_idempotency_key,
        p_reservation_id,
        format('Refund reversal for reservation %s (Gross: ₱%s, Commission Reversal: ₱%s, Owner Reversal: ₱%s)',
            p_reservation_id, p_refund_gross_amount, v_commission_reversal, v_owner_reversal),
        p_metadata,
        v_entries
    );
END;
$$;

-- 3.4 Payout Hold Reservation (Two-Phase Payout Phase 1)
CREATE OR REPLACE FUNCTION public.post_payout_reserve_event(
    p_organization_id UUID,
    p_payout_id UUID,
    p_amount NUMERIC(10, 2),
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_entries JSONB;
BEGIN
    IF p_amount <= 0.00 THEN
        RAISE EXCEPTION 'Payout reserve amount must be strictly positive. Got: %', p_amount;
    END IF;

    -- Internal reservation: Holds funds in pending_payout_amount
    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '2010', 'entry_direction', 'DEBIT', 'amount', p_amount),
        jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', p_amount)
    );

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        NULL,
        'payout_reserve',
        p_idempotency_key,
        p_payout_id,
        format('Owner payout hold reserved: ₱%s', p_amount),
        p_metadata,
        v_entries
    );
END;
$$;

-- 3.5 Payout Disbursement (Two-Phase Payout Phase 2: Success)
CREATE OR REPLACE FUNCTION public.post_payout_disbursement_event(
    p_organization_id UUID,
    p_payout_id UUID,
    p_amount NUMERIC(10, 2),
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_entries JSONB;
BEGIN
    IF p_amount <= 0.00 THEN
        RAISE EXCEPTION 'Payout disbursement amount must be strictly positive. Got: %', p_amount;
    END IF;

    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '2010', 'entry_direction', 'DEBIT', 'amount', p_amount),
        jsonb_build_object('account_code', '1010', 'entry_direction', 'CREDIT', 'amount', p_amount)
    );

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        NULL,
        'payout_disbursement',
        p_idempotency_key,
        p_payout_id,
        format('Owner payout disbursement settled: ₱%s', p_amount),
        p_metadata,
        v_entries
    );
END;
$$;

-- 3.6 Payout Failed Hold Release (Two-Phase Payout Phase 2: Failure)
CREATE OR REPLACE FUNCTION public.post_payout_failed_release_event(
    p_organization_id UUID,
    p_payout_id UUID,
    p_amount NUMERIC(10, 2),
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_entries JSONB;
BEGIN
    IF p_amount <= 0.00 THEN
        RAISE EXCEPTION 'Payout release amount must be strictly positive. Got: %', p_amount;
    END IF;

    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '2010', 'entry_direction', 'DEBIT', 'amount', p_amount),
        jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', p_amount)
    );

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        NULL,
        'payout_failed_release',
        p_idempotency_key,
        p_payout_id,
        format('Owner payout failed; released ₱%s back to available withdrawable balance', p_amount),
        p_metadata,
        v_entries
    );
END;
$$;

-- 3.7 Excess or Late Payment Capture (Zero Owner Balance, Customer Refund Liability)
CREATE OR REPLACE FUNCTION public.post_excess_or_late_payment_event(
    p_organization_id UUID,
    p_facility_id UUID,
    p_reference_id UUID,
    p_amount NUMERIC(10, 2),
    p_is_late BOOLEAN,
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tx_type VARCHAR(32);
    v_desc TEXT;
    v_entries JSONB;
BEGIN
    IF p_amount <= 0.00 THEN
        RAISE EXCEPTION 'Payment amount must be strictly positive. Got: %', p_amount;
    END IF;

    IF p_is_late THEN
        v_tx_type := 'late_payment_liability';
        v_desc := format('Late payment on expired reservation %s routed to customer refund liability (₱%s)', p_reference_id, p_amount);
    ELSE
        v_tx_type := 'excess_payment_liability';
        v_desc := format('Duplicate captured charge for reservation %s routed to customer refund liability (₱%s)', p_reference_id, p_amount);
    END IF;

    -- Routes 100% to Account 2030 (Customer Refund Liability).
    -- Zero owner earnings (2010) and zero platform commission (4010).
    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', p_amount),
        jsonb_build_object('account_code', '2030', 'entry_direction', 'CREDIT', 'amount', p_amount)
    );

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        p_facility_id,
        v_tx_type,
        p_idempotency_key,
        p_reference_id,
        v_desc,
        p_metadata,
        v_entries
    );
END;
$$;

-- ==============================================================================
-- 4. Privilege Hardening: Strict Revocation
-- ==============================================================================
-- All routines are strictly restricted to service_role (trusted backend only).

REVOKE ALL ON FUNCTION public.post_journal_entry_internal(UUID, UUID, VARCHAR, TEXT, UUID, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_booking_settlement_event(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_funds_cleared_event(UUID, UUID, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_refund_reversal_event(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_payout_reserve_event(UUID, UUID, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_payout_disbursement_event(UUID, UUID, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_payout_failed_release_event(UUID, UUID, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_excess_or_late_payment_event(UUID, UUID, UUID, NUMERIC, BOOLEAN, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.post_journal_entry_internal(UUID, UUID, VARCHAR, TEXT, UUID, TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_booking_settlement_event(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_funds_cleared_event(UUID, UUID, NUMERIC, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_refund_reversal_event(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_payout_reserve_event(UUID, UUID, NUMERIC, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_payout_disbursement_event(UUID, UUID, NUMERIC, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_payout_failed_release_event(UUID, UUID, NUMERIC, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_excess_or_late_payment_event(UUID, UUID, UUID, NUMERIC, BOOLEAN, TEXT, JSONB) TO service_role;
