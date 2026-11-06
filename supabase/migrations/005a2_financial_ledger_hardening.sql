-- ==============================================================================
-- CourtBook / BookSuite — Phase 4.2.2 Financial Ledger Hardening (Migration 005a2)
--
-- Description:
--   1. Enforces NOT NULL and 32-char MD5 hex format (^[0-9a-f]{32}$) on
--      public.financial_transactions.canonical_payload_hash without mutating
--      historical rows (preserving append-only immutability).
--   2. Replaces and hardens public.post_journal_entry_internal() to:
--      - Enforce IS DISTINCT FROM on canonical_payload_hash (no NULL bypass).
--      - Reject zero/non-positive journal totals.
--      - Enforce strict transaction-specific DEBIT/CREDIT account rules across
--        all 13 supported financial transaction types.
--   3. Adds BEFORE INSERT triggers on financial_transactions and ledger_entries
--      to enforce canonical hash format and positive entry amounts.
--   4. Preserves all existing RLS policies, SECURITY DEFINER restrictions,
--      append-only triggers, and the 5% platform commission model.
-- ==============================================================================

BEGIN;

-- 1. Enforce NOT NULL and 32-character MD5 hex constraint on canonical_payload_hash
--    (No UPDATE on financial_transactions; preserves append-only immutability)
ALTER TABLE public.financial_transactions
    ALTER COLUMN canonical_payload_hash SET NOT NULL;

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

-- 2. Trigger guard: prevent NULL or malformed canonical_payload_hash on INSERT
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

-- 3. Trigger guard: enforce strictly positive ledger_entries.amount on INSERT
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

-- 4. Replace and harden public.post_journal_entry_internal()
CREATE OR REPLACE FUNCTION public.post_journal_entry_internal(
    p_organization_id UUID,
    p_facility_id UUID,
    p_transaction_type VARCHAR(32),
    p_idempotency_key TEXT,
    p_reference_id UUID,
    p_description TEXT,
    p_metadata JSONB,
    p_entries JSONB
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

    v_normalized_entries JSONB := '[]'::jsonb;
    v_canonical_payload JSONB;
    v_canonical_hash TEXT;

    v_entry_account VARCHAR(10);
    v_entry_direction VARCHAR(6);
    v_entry_amount NUMERIC(10, 2);

    v_running_1010 NUMERIC(10, 2) := NULL;
    v_running_1020 NUMERIC(10, 2) := NULL;
    v_running_1030 NUMERIC(10, 2) := NULL;
    v_running_2010 NUMERIC(10, 2) := NULL;
    v_running_2011 NUMERIC(10, 2) := NULL;
    v_running_2012 NUMERIC(10, 2) := NULL;
    v_running_2015 NUMERIC(10, 2) := NULL;
    v_running_2020 NUMERIC(10, 2) := NULL;
    v_running_2030 NUMERIC(10, 2) := NULL;
    v_running_4010 NUMERIC(10, 2) := NULL;
    v_running_5010 NUMERIC(10, 2) := NULL;
    v_current_entry_balance NUMERIC(10, 2);

    v_delta_gross_settled NUMERIC(10, 2) := 0.00;
    v_delta_commission_paid NUMERIC(10, 2) := 0.00;
    v_delta_unsettled_clearing NUMERIC(10, 2) := 0.00;
    v_delta_available_withdrawable NUMERIC(10, 2) := 0.00;
    v_delta_pending_payout NUMERIC(10, 2) := 0.00;
    v_delta_total_withdrawn NUMERIC(10, 2) := 0.00;
    v_delta_negative_recovery NUMERIC(10, 2) := 0.00;

    v_new_gross NUMERIC(10, 2);
    v_new_commission NUMERIC(10, 2);
    v_new_unsettled NUMERIC(10, 2);
    v_new_available NUMERIC(10, 2);
    v_new_pending NUMERIC(10, 2);
    v_new_withdrawn NUMERIC(10, 2);
    v_new_negative_recovery NUMERIC(10, 2);
BEGIN
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

    SELECT * INTO v_org_balance
    FROM public.organization_balances
    WHERE organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Organization balance record not found for organization: %', p_organization_id;
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        IF jsonb_typeof(v_item) != 'object' THEN
            RAISE EXCEPTION 'Malformed entry: Every item in entries array must be a JSON object.';
        END IF;

        v_entry_account := trim(COALESCE(v_item->>'account_code', ''));
        v_entry_direction := upper(trim(COALESCE(v_item->>'entry_direction', '')));

        IF v_entry_direction NOT IN ('DEBIT', 'CREDIT') THEN
            RAISE EXCEPTION 'Invalid entry_direction "%". Must be DEBIT or CREDIT.', v_entry_direction;
        END IF;

        IF NOT (v_item ? 'amount') OR (v_item->>'amount') IS NULL THEN
            RAISE EXCEPTION 'Entry amount is required.';
        END IF;

        v_entry_amount := (v_item->>'amount')::NUMERIC(10, 2);
        IF v_entry_amount <= 0.00 THEN
            RAISE EXCEPTION 'Entry amount must be strictly positive. Got: ₱%', v_entry_amount;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.chart_of_accounts
            WHERE account_code = v_entry_account AND is_active = true
        ) THEN
            RAISE EXCEPTION 'Account code "%" does not exist or is inactive.', v_entry_account;
        END IF;

        IF v_entry_direction = 'DEBIT' THEN
            v_total_debits := v_total_debits + v_entry_amount;
        ELSE
            v_total_credits := v_total_credits + v_entry_amount;
        END IF;

        v_normalized_entries := v_normalized_entries || jsonb_build_array(
            jsonb_build_object(
                'account_code', v_entry_account,
                'entry_direction', v_entry_direction,
                'amount', v_entry_amount::text
            )
        );
    END LOOP;

    IF v_total_debits <= 0.00 THEN
        RAISE EXCEPTION 'Journal transaction total must be strictly positive.';
    END IF;

    v_canonical_payload := jsonb_build_object(
        'v', 1,
        'organization_id', p_organization_id,
        'facility_id', p_facility_id,
        'transaction_type', v_clean_type,
        'reference_id', p_reference_id,
        'description', v_clean_desc,
        'provider_event_id', (p_metadata->>'provider_event_id'),
        'provider_payment_id', (p_metadata->>'provider_payment_id'),
        'settlement_reference', (p_metadata->>'settlement_reference'),
        'entries', v_normalized_entries
    );
    v_canonical_hash := md5(v_canonical_payload::text);

    SELECT id, organization_id, facility_id, transaction_type, reference_id, description, canonical_payload_hash
    INTO v_existing_tx
    FROM public.financial_transactions
    WHERE idempotency_key = v_clean_key;

    IF FOUND THEN
        IF v_existing_tx.organization_id != p_organization_id OR
           (v_existing_tx.facility_id IS DISTINCT FROM p_facility_id) OR
           v_existing_tx.transaction_type != v_clean_type OR
           v_existing_tx.reference_id != p_reference_id THEN
            RAISE EXCEPTION 'Idempotency conflict: Key "%" was previously used with different parameters.', v_clean_key;
        END IF;

        -- Strict IS DISTINCT FROM comparison (never skips NULL)
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

    IF v_total_debits != v_total_credits THEN
        RAISE EXCEPTION 'Unbalanced journal transaction: Total Debits (₱%) does not match Total Credits (₱%).',
            v_total_debits, v_total_credits;
    END IF;

    -- Strict per-transaction-type DEBIT/CREDIT account rules across all 13 types
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
                RAISE EXCEPTION 'booking_settlement DEBIT must target 1010, got %.', v_entry_account;
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
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2010' THEN
                v_delta_unsettled_clearing := v_delta_unsettled_clearing - v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'refund_reversal' THEN
            IF v_entry_account NOT IN ('1010', '1020', '1030', '2010', '2011', '2030', '4010') THEN
                RAISE EXCEPTION 'Account % not permitted for refund_reversal.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2010' THEN
                v_delta_unsettled_clearing := v_delta_unsettled_clearing - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '4010' THEN
                v_delta_commission_paid := v_delta_commission_paid - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '1030' THEN
                v_delta_negative_recovery := v_delta_negative_recovery + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'chargeback_adjustment' THEN
            IF v_entry_account NOT IN ('1010', '1020', '1030', '2010', '2011', '2012', '4010', '5010') THEN
                RAISE EXCEPTION 'Account % not permitted for chargeback_adjustment.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2010' THEN
                v_delta_unsettled_clearing := v_delta_unsettled_clearing - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '1030' THEN
                v_delta_negative_recovery := v_delta_negative_recovery + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'gateway_fee_assessment' THEN
            IF v_entry_account NOT IN ('1010', '2010', '2011', '5010') THEN
                RAISE EXCEPTION 'Account % not permitted for gateway_fee_assessment.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2010' THEN
                v_delta_unsettled_clearing := v_delta_unsettled_clearing - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'payout_reserve' THEN
            IF v_entry_account NOT IN ('2011', '2015') THEN
                RAISE EXCEPTION 'Account % not permitted for payout_reserve.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account != '2011' THEN
                RAISE EXCEPTION 'payout_reserve DEBIT must target 2011, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account != '2015' THEN
                RAISE EXCEPTION 'payout_reserve CREDIT must target 2015, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '2015' THEN
                v_delta_pending_payout := v_delta_pending_payout + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'payout_disbursement' THEN
            IF v_entry_account NOT IN ('1020', '2015') THEN
                RAISE EXCEPTION 'Account % not permitted for payout_disbursement.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account != '2015' THEN
                RAISE EXCEPTION 'payout_disbursement DEBIT must target 2015, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account != '1020' THEN
                RAISE EXCEPTION 'payout_disbursement CREDIT must target 1020, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2015' THEN
                v_delta_pending_payout := v_delta_pending_payout - v_entry_amount;
                v_delta_total_withdrawn := v_delta_total_withdrawn + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'payout_failed_release' THEN
            IF v_entry_account NOT IN ('2011', '2015') THEN
                RAISE EXCEPTION 'Account % not permitted for payout_failed_release.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account != '2015' THEN
                RAISE EXCEPTION 'payout_failed_release DEBIT must target 2015, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account != '2011' THEN
                RAISE EXCEPTION 'payout_failed_release CREDIT must target 2011, got %.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2015' THEN
                v_delta_pending_payout := v_delta_pending_payout - v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'merchant_debt_recovery' THEN
            IF v_entry_account NOT IN ('1030', '2010', '2011') THEN
                RAISE EXCEPTION 'Account % not permitted for merchant_debt_recovery.', v_entry_account;
            END IF;
            IF v_entry_direction = 'CREDIT' AND v_entry_account = '1030' THEN
                v_delta_negative_recovery := v_delta_negative_recovery - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '2010' THEN
                v_delta_unsettled_clearing := v_delta_unsettled_clearing - v_entry_amount;
            ELSIF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'dispute_hold' THEN
            IF v_entry_account NOT IN ('2010', '2011', '2012') THEN
                RAISE EXCEPTION 'Account % not permitted for dispute_hold.', v_entry_account;
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
                RAISE EXCEPTION '% CREDIT must target 2030, got %.', v_clean_type, v_entry_account;
            END IF;
        END IF;
    END LOOP;

    v_new_gross := v_org_balance.total_gross_settled + v_delta_gross_settled;
    v_new_commission := v_org_balance.total_commission_paid + v_delta_commission_paid;
    v_new_unsettled := v_org_balance.unsettled_clearing_balance + v_delta_unsettled_clearing;
    v_new_available := v_org_balance.available_withdrawable_balance + v_delta_available_withdrawable;
    v_new_pending := v_org_balance.pending_payout_balance + v_delta_pending_payout;
    v_new_withdrawn := v_org_balance.total_withdrawn + v_delta_total_withdrawn;
    v_new_negative_recovery := v_org_balance.negative_balance_recovery + v_delta_negative_recovery;

    IF v_new_unsettled < 0.00 THEN
        RAISE EXCEPTION 'Insufficient unsettled clearing balance (₱%).', v_org_balance.unsettled_clearing_balance;
    END IF;
    IF v_new_available < 0.00 THEN
        RAISE EXCEPTION 'Insufficient available withdrawable balance (₱%).', v_org_balance.available_withdrawable_balance;
    END IF;
    IF v_new_pending < 0.00 THEN
        RAISE EXCEPTION 'Insufficient pending payout balance (₱%).', v_org_balance.pending_payout_balance;
    END IF;

    INSERT INTO public.financial_transactions (
        organization_id, facility_id, transaction_type, idempotency_key,
        reference_id, description, metadata, canonical_payload_hash
    ) VALUES (
        p_organization_id, p_facility_id, v_clean_type, v_clean_key,
        p_reference_id, v_clean_desc, COALESCE(p_metadata, '{}'::jsonb), v_canonical_hash
    )
    RETURNING id, transaction_number INTO v_new_tx_id, v_new_tx_number;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        v_entry_account := trim(v_item->>'account_code');
        v_entry_direction := upper(trim(v_item->>'entry_direction'));
        v_entry_amount := (v_item->>'amount')::NUMERIC(10, 2);

        SELECT COALESCE(
            (SELECT le.running_account_balance
             FROM public.ledger_entries le
             WHERE le.organization_id = p_organization_id
               AND le.account_code = v_entry_account
             ORDER BY le.created_at DESC, le.entry_order DESC
             LIMIT 1),
            0.00
        ) INTO v_current_entry_balance;

        IF v_entry_direction = 'DEBIT' THEN
            v_current_entry_balance := v_current_entry_balance + v_entry_amount;
        ELSE
            v_current_entry_balance := v_current_entry_balance - v_entry_amount;
        END IF;

        INSERT INTO public.ledger_entries (
            transaction_id, organization_id, account_code, entry_direction,
            amount, entry_order, running_account_balance
        ) VALUES (
            v_new_tx_id, p_organization_id, v_entry_account, v_entry_direction,
            v_entry_amount, v_order, v_current_entry_balance
        );

        v_order := v_order + 1;
    END LOOP;

    UPDATE public.organization_balances
    SET total_gross_settled = v_new_gross,
        total_commission_paid = v_new_commission,
        unsettled_clearing_balance = v_new_unsettled,
        available_withdrawable_balance = v_new_available,
        pending_payout_balance = v_new_pending,
        total_withdrawn = v_new_withdrawn,
        negative_balance_recovery = v_new_negative_recovery,
        updated_at = now()
    WHERE organization_id = p_organization_id;

    RETURN jsonb_build_object(
        'success', true,
        'transaction_id', v_new_tx_id,
        'transaction_number', v_new_tx_number,
        'idempotent_duplicate', false
    );
END;
$$;

-- Re-apply strict EXECUTE revocations
REVOKE ALL ON FUNCTION public.post_journal_entry_internal(UUID, UUID, VARCHAR, TEXT, UUID, TEXT, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_financial_tx_canonical_hash()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_positive_ledger_entry_amount()
    FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
