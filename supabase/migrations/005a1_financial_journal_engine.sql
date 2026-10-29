-- ==============================================================================
-- CourtBook / BookSuite — Database Schema Migration
-- Migration: 005a1_financial_journal_engine.sql
-- Description: Phase 4.2.2 Financial Journal Engine & Accounting Infrastructure
--
-- STATUS: REVIEW ONLY (Do NOT execute on live BookSuite-Dev until approved)
--
-- FOUNDATION: Built strictly upon Migration 005A schema:
--   - public.platform_billing_config
--   - public.platform_checkout_controls
--   - public.financial_transactions
--   - public.ledger_entries
--   - public.organization_balances
--
-- DEPLOYABLE ACCOUNTING INFRASTRUCTURE IN 005a1:
--   1. Comprehensive Chart of Accounts & lifecycle transaction types.
--   2. Storage-level uniqueness guards on payout states (defense-in-depth indexes).
--   3. Private, atomic double-entry engine (post_journal_entry_internal) with
--      deterministic transaction-number sequence ordering across all 11 accounts.
--   4. Versioned canonical payload serialization and hashing for full idempotency.
--   5. Native PostgreSQL table privilege hardening (REVOKE direct INSERT from service_role).
--   6. Authoritative booking capture (post_booking_settlement_event).
--   7. Full refund reversal & merchant overdraft accounting (Account 1030).
--   8. Dispute/chargeback adjustments and undecided gateway fee assessment.
--   9. Excess and late payment liabilities (Account 2030).
--
-- EXPLICIT DEFERRED DEPENDENCIES (Deferred to Migration 005B):
--   - public.payments table (provider transaction IDs, checkout sessions, webhook reconciliation)
--   - public.payouts table (payout request state machine, disbursement batch IDs)
--   - public.organization_payout_methods table (bank accounts, e-wallets, verified KYC state)
--   - Authoritative gateway settlement batch reconciliation records
--
-- EXPLICITLY DISABLED OPERATIONS IN 005a1 (EXECUTE Revoked from service_role):
--   - post_funds_cleared_event (settlement clearance to withdrawable): DISABLED in production
--     until 005B deploys authoritative provider settlement reconciliation records.
--   - post_payout_reserve_event, post_payout_disbursement_event, post_payout_failed_release_event:
--     DISABLED in production until 005B deploys the authoritative payouts table.
--   - post_journal_entry_internal: PRIVATE internal procedure; uncallable via external RPC.
-- ==============================================================================

-- ==============================================================================
-- 1. Schema Refinements & Storage Constraints on Foundation Tables
-- ==============================================================================

DO $$
BEGIN
    -- 1.1 Extended Transaction Types for Complete Financial Lifecycle
    ALTER TABLE public.financial_transactions
        DROP CONSTRAINT IF EXISTS financial_transactions_transaction_type_check;

    ALTER TABLE public.financial_transactions
        ADD CONSTRAINT financial_transactions_transaction_type_check
        CHECK (transaction_type IN (
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
        ));

    -- 1.2 Refined Chart of Accounts in ledger_entries (All 11 Accounts Supported)
    -- Chart of Accounts:
    --   1010: Gateway In-Transit Clearing Funds     (Asset - held by gateway provider)
    --   1020: Platform Settled Cash                 (Asset - settled in platform operating/payout account)
    --   1030: Platform Merchant Recovery Receivable  (Asset - platform claim for post-payout refund overdrafts)
    --   2010: Owner Payable - Unsettled Clearing    (Liability - booking funds captured, awaiting clearance)
    --   2011: Owner Payable - Available for Payout  (Liability - fully cleared owner funds eligible for withdrawal)
    --   2012: Owner Payable - Restricted Reserve    (Liability - held for provisional fee reserve or dispute cooldown)
    --   2015: Owner Payable - Pending Payout        (Liability - reserved during active payout disbursement)
    --   2020: Undecided Gateway Fee Escrow          (Liability - provisional MDR held pending merchant agreement)
    --   2030: Customer Refund Liability             (Liability - excess, duplicate or late charges owed to guest)
    --   4010: Platform Commission Revenue           (5% CourtBook commission earned)
    --   5010: Platform Processing Expense           (Platform-absorbed gateway MDR or payout disbursement fees)
    ALTER TABLE public.ledger_entries
        DROP CONSTRAINT IF EXISTS ledger_entries_account_code_check;

    ALTER TABLE public.ledger_entries
        ADD CONSTRAINT ledger_entries_account_code_check
        CHECK (account_code IN (
            '1010', '1020', '1030',
            '2010', '2011', '2012', '2015', '2020', '2030',
            '4010',
            '5010'
        ));

    -- 1.3 Versioned Canonical Financial Payload Hash Column
    -- Stores SHA-256/MD5 cryptographic digest of canonical financial payload.
    -- Enforces that reused keys with different account allocations or terms FAIL.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'financial_transactions'
          AND column_name = 'canonical_payload_hash'
    ) THEN
        ALTER TABLE public.financial_transactions
            ADD COLUMN canonical_payload_hash TEXT;
    END IF;

    -- 1.4 Add Negative Recovery Balance Column to organization_balances
    -- Tracks explicit platform merchant recovery receivables when refunds or chargebacks occur
    -- after an owner has already withdrawn funds. Eliminates GREATEST(0, ...) hacks and guarantees
    -- zero hidden debt and strict non-negative balance enforcement.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'organization_balances'
          AND column_name = 'negative_recovery_balance'
    ) THEN
        ALTER TABLE public.organization_balances
            ADD COLUMN negative_recovery_balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00
            CHECK (negative_recovery_balance >= 0.00);
    END IF;

    -- 1.5 Composite Constraint on financial_transactions for Cross-Tenant Ledger Integrity
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'uq_financial_tx_id_org'
          AND table_schema = 'public'
          AND table_name = 'financial_transactions'
    ) THEN
        ALTER TABLE public.financial_transactions
            ADD CONSTRAINT uq_financial_tx_id_org UNIQUE (id, organization_id);
    END IF;

    -- 1.6 Composite Foreign Key on ledger_entries Enforcing Strict Organization Match
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_ledger_entry_tx_org'
          AND table_schema = 'public'
          AND table_name = 'ledger_entries'
    ) THEN
        ALTER TABLE public.ledger_entries
            ADD CONSTRAINT fk_ledger_entry_tx_org
            FOREIGN KEY (transaction_id, organization_id)
            REFERENCES public.financial_transactions (id, organization_id)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- 1.7 Concurrency-Safe Payout Lifecycle Defense-in-Depth Partial Unique Indexes
-- Enforces at the database storage engine level:
--   - Exactly ONE payout_reserve per payout reference ID.
--   - Exactly ONE terminal outcome (payout_disbursement OR payout_failed_release) per payout reference ID.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_reserve_per_reference
    ON public.financial_transactions (reference_id)
    WHERE (transaction_type = 'payout_reserve');

CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_terminal_per_reference
    ON public.financial_transactions (reference_id)
    WHERE (transaction_type IN ('payout_disbursement', 'payout_failed_release'));

-- 1.8 Strict Table Privilege Separation (Defense Against Direct Ledger Bypass)
-- Direct INSERT, UPDATE, and DELETE on financial ledger tables are strictly REVOKED from
-- all client and application roles, including service_role. Only postgres-owned SECURITY DEFINER
-- functions can insert into financial tables.
REVOKE INSERT, UPDATE, DELETE ON public.financial_transactions FROM PUBLIC, anon, authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON public.ledger_entries FROM PUBLIC, anon, authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON public.organization_balances FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON public.financial_transactions TO authenticated, service_role;
GRANT SELECT ON public.ledger_entries TO authenticated, service_role;
GRANT SELECT ON public.organization_balances TO authenticated, service_role;


-- ==============================================================================
-- 2. Core Double-Entry Engine (post_journal_entry_internal)
-- ==============================================================================
-- The low-level atomic double-entry processor.
-- Rules:
--   - Private internal engine: EXECUTE strictly revoked from service_role, anon, authenticated.
--   - Row-locks target organization_balances FIRST (FOR UPDATE).
--   - Full Idempotency Verification: Verifies versioned canonical payload hash
--     (accounts, directions, amounts, commission terms, provider event IDs, facility, reference).
--     Different account allocations with equal totals FAIL.
--   - Sum(debits) must equal sum(credits) to the exact centavo.
--   - Validates account movements against permitted whitelist per transaction_type.
--   - Uses typed variables only (zero uninstantiated RECORD field assignments).
--   - Strict non-negative balance enforcement (NO GREATEST(0, ...) fallback).
--   - Deterministic running balance calculation using transaction_number sequence across all 11 accounts.
--   - Updates organization_balances materialized state atomically.

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
        v_entry_direction := trim(COALESCE(v_item->>'entry_direction', ''));

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

        -- Versioned Canonical Payload Hash Comparison: Rejects different accounts/allocations even if totals match!
        IF v_existing_tx.canonical_payload_hash IS NOT NULL AND v_existing_tx.canonical_payload_hash != v_canonical_hash THEN
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

    -- 5. Exact Centavo Balancing Invariant
    IF v_total_debits != v_total_credits THEN
        RAISE EXCEPTION 'Unbalanced journal transaction: Total Debits (₱%) does not match Total Credits (₱%). Difference: ₱%',
            v_total_debits, v_total_credits, (v_total_debits - v_total_credits);
    END IF;

    -- 6. Account Whitelist per Transaction Type & Metric Delta Accumulation
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_entries)
    LOOP
        v_entry_account := trim(v_item->>'account_code');
        v_entry_direction := trim(v_item->>'entry_direction');
        v_entry_amount := (v_item->>'amount')::NUMERIC(10, 2);

        IF v_clean_type = 'booking_settlement' THEN
            IF v_entry_account NOT IN ('1010', '2010', '2020', '4010') THEN
                RAISE EXCEPTION 'Account % not permitted for booking_settlement.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account != '1010' THEN
                RAISE EXCEPTION 'Only 1010 (Gateway Clearing) may be debited on booking_settlement.';
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
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '1030' THEN
                -- Explicit double-entry credit reducing merchant recovery debt
                v_delta_negative_recovery := v_delta_negative_recovery - v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'merchant_debt_recovery' THEN
            IF v_entry_account NOT IN ('1030', '2011') THEN
                RAISE EXCEPTION 'Account % not permitted for merchant_debt_recovery.', v_entry_account;
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '1030' THEN
                v_delta_negative_recovery := v_delta_negative_recovery - v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'refund_reversal' THEN
            IF v_entry_account NOT IN ('1010', '1020', '1030', '2010', '2011', '4010') THEN
                RAISE EXCEPTION 'Account % not permitted for refund_reversal.', v_entry_account;
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
            IF v_entry_account NOT IN ('1010', '1020', '1030', '2010', '2011', '4010', '5010') THEN
                RAISE EXCEPTION 'Account % not permitted for chargeback_adjustment.', v_entry_account;
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
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            ELSIF v_entry_direction = 'CREDIT' AND v_entry_account = '2015' THEN
                v_delta_pending_payout := v_delta_pending_payout + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'payout_disbursement' THEN
            IF v_entry_account NOT IN ('1020', '2015') THEN
                RAISE EXCEPTION 'Only 2015 (Pending Payout) and 1020 (Platform Settled Cash) permitted for payout_disbursement.';
            END IF;
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2015' THEN
                v_delta_pending_payout := v_delta_pending_payout - v_entry_amount;
                v_delta_total_withdrawn := v_delta_total_withdrawn + v_entry_amount;
            END IF;

        ELSIF v_clean_type = 'payout_failed_release' THEN
            IF v_entry_account NOT IN ('2011', '2015') THEN
                RAISE EXCEPTION 'Only 2015 (Pending Payout) and 2011 (Available) permitted for payout_failed_release.';
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
            IF v_entry_direction = 'DEBIT' AND v_entry_account = '2011' THEN
                v_delta_available_withdrawable := v_delta_available_withdrawable - v_entry_amount;
            END IF;

        ELSIF v_clean_type IN ('excess_payment_liability', 'late_payment_liability') THEN
            IF v_entry_account NOT IN ('1010', '2030') THEN
                RAISE EXCEPTION 'Account % not permitted for excess/late payment liabilities.', v_entry_account;
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
        v_entry_direction := trim(v_item->>'entry_direction');
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

        -- Update in-memory tracker
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
-- 3. Business-Validated Financial Operations
-- ==============================================================================

-- 3.1 Booking Payment Settlement Capture (Authoritative Source Validated)
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
    v_res_record RECORD;
    v_config_comm_rate NUMERIC(5, 4);
    v_commission NUMERIC(10, 2);
    v_owner_share NUMERIC(10, 2);
    v_entries JSONB;
BEGIN
    -- 1. Authoritative Reservation Validation
    SELECT r.id, r.facility_id, r.price, r.status, f.organization_id
    INTO v_res_record
    FROM public.reservations r
    JOIN public.facilities f ON f.id = r.facility_id
    WHERE r.id = p_reservation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reservation % does not exist.', p_reservation_id;
    END IF;

    IF v_res_record.organization_id != p_organization_id THEN
        RAISE EXCEPTION 'Tenant mismatch: Reservation % belongs to organization %, not caller organization %.',
            p_reservation_id, v_res_record.organization_id, p_organization_id;
    END IF;

    IF v_res_record.facility_id != p_facility_id THEN
        RAISE EXCEPTION 'Facility mismatch: Reservation % belongs to facility %, not caller facility %.',
            p_reservation_id, v_res_record.facility_id, p_facility_id;
    END IF;

    -- Authoritative Price Match Guard
    IF p_gross_amount != v_res_record.price THEN
        RAISE EXCEPTION 'Price tampering rejected: Supplied gross amount ₱% does not match authoritative reservation price ₱%.',
            p_gross_amount, v_res_record.price;
    END IF;

    -- 2. Authoritative Platform Commission Rate Guard
    SELECT default_commission_rate INTO v_config_comm_rate
    FROM public.platform_billing_config
    WHERE id = 1;

    IF p_commission_rate != v_config_comm_rate THEN
        RAISE EXCEPTION 'Commission rate tampering rejected: Supplied rate % does not match configured platform commission rate %.',
            p_commission_rate, v_config_comm_rate;
    END IF;

    -- 3. Exact Centavo Split
    v_commission := round(p_gross_amount * p_commission_rate, 2);
    v_owner_share := p_gross_amount - v_commission;

    -- Double-Entry Ledger Lines:
    --   DEBIT  1010 (Gateway In-Transit Clearing Funds): ₱Gross
    --   CREDIT 4010 (Platform Commission Revenue):       ₱Commission
    --   CREDIT 2010 (Owner Payable - Unsettled):         ₱OwnerShare
    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', p_gross_amount),
        jsonb_build_object('account_code', '4010', 'entry_direction', 'CREDIT', 'amount', v_commission),
        jsonb_build_object('account_code', '2010', 'entry_direction', 'CREDIT', 'amount', v_owner_share)
    );

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        p_facility_id,
        'booking_settlement',
        p_idempotency_key,
        p_reservation_id,
        format('Booking payment capture for reservation %s (Gross: ₱%s, Commission: ₱%s, Owner: ₱%s)',
            p_reservation_id, p_gross_amount, v_commission, v_owner_share),
        p_metadata || jsonb_build_object(
            'reservation_id', p_reservation_id,
            'gross_amount', p_gross_amount,
            'commission_rate', p_commission_rate,
            'commission_amount', v_commission,
            'owner_share', v_owner_share
        ),
        v_entries
    );
END;
$$;


-- 3.2 Gateway Clearance & Settlement Shift
-- Moves funds from Gateway Clearing (1010) to Platform Settled Cash (1020),
-- and Owner Unsettled (2010) to Owner Available (2011) or Merchant Debt Recovery (1030).
-- NOTE: In 005a1, EXECUTE is strictly REVOKED from service_role. Production execution
-- remains disabled until Migration 005B provider settlement batch reconciliation.
CREATE OR REPLACE FUNCTION public.post_funds_cleared_event(
    p_organization_id UUID,
    p_facility_id UUID,
    p_cleared_amount NUMERIC(10, 2),
    p_settlement_reference TEXT,
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_settle_ref TEXT;
    v_org_bal RECORD;
    v_entries JSONB;
    v_reconciled NUMERIC(10, 2) := 0.00;
    v_net_to_available NUMERIC(10, 2) := 0.00;
BEGIN
    IF p_cleared_amount <= 0.00 THEN
        RAISE EXCEPTION 'Cleared amount must be strictly positive. Got: %', p_cleared_amount;
    END IF;

    v_clean_settle_ref := trim(COALESCE(p_settlement_reference, ''));
    IF char_length(v_clean_settle_ref) < 8 THEN
        RAISE EXCEPTION 'Verified settlement reference evidence is required (e.g. gateway payout/batch ID, min 8 chars). Got: "%".', p_settlement_reference;
    END IF;

    -- Inspect current balance under lock to check for negative recovery debt
    SELECT * INTO v_org_bal
    FROM public.organization_balances
    WHERE organization_id = p_organization_id
    FOR UPDATE;

    IF p_cleared_amount > v_org_bal.unsettled_clearing_amount THEN
        RAISE EXCEPTION 'Settlement clearance exceeds unsettled funds: Requested ₱%, available unsettled ₱%.',
            p_cleared_amount, v_org_bal.unsettled_clearing_amount;
    END IF;

    -- Determine if any cleared funds must pay down merchant recovery debt (Account 1030)
    IF v_org_bal.negative_recovery_balance > 0.00 THEN
        v_reconciled := LEAST(v_org_bal.negative_recovery_balance, p_cleared_amount);
    END IF;
    v_net_to_available := p_cleared_amount - v_reconciled;

    -- Double-Entry Ledger Lines:
    --   DEBIT  1020 (Platform Settled Cash):             ₱ClearedAmount
    --   CREDIT 1010 (Gateway In-Transit Clearing Funds): ₱ClearedAmount
    --   DEBIT  2010 (Owner Payable - Unsettled):         ₱ClearedAmount
    --   CREDIT 1030 (Platform Merchant Recovery):        ₱Reconciled (explicit auditable debt reduction!)
    --   CREDIT 2011 (Owner Payable - Available):         ₱NetToAvailable
    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '1020', 'entry_direction', 'DEBIT', 'amount', p_cleared_amount),
        jsonb_build_object('account_code', '1010', 'entry_direction', 'CREDIT', 'amount', p_cleared_amount),
        jsonb_build_object('account_code', '2010', 'entry_direction', 'DEBIT', 'amount', p_cleared_amount)
    );

    IF v_reconciled > 0.00 THEN
        v_entries := v_entries || jsonb_build_array(
            jsonb_build_object('account_code', '1030', 'entry_direction', 'CREDIT', 'amount', v_reconciled)
        );
    END IF;

    IF v_net_to_available > 0.00 THEN
        v_entries := v_entries || jsonb_build_array(
            jsonb_build_object('account_code', '2011', 'entry_direction', 'CREDIT', 'amount', v_net_to_available)
        );
    END IF;

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        p_facility_id,
        'funds_cleared_to_available',
        p_idempotency_key,
        p_organization_id,
        format('Gateway settlement cleared to available withdrawable funds (Ref: %s, Amount: ₱%s, Debt Recovered: ₱%s)',
            v_clean_settle_ref, p_cleared_amount, v_reconciled),
        p_metadata || jsonb_build_object(
            'settlement_reference', v_clean_settle_ref,
            'cleared_amount', p_cleared_amount,
            'debt_recovered', v_reconciled,
            'net_to_available', v_net_to_available
        ),
        v_entries
    );
END;
$$;


-- 3.3 Refund Reversal & Post-Payout Overdraft Protection
CREATE OR REPLACE FUNCTION public.post_refund_reversal_event(
    p_organization_id UUID,
    p_facility_id UUID,
    p_reservation_id UUID,
    p_refund_gross_amount NUMERIC(10, 2),
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
    v_res_record RECORD;
    v_commission_reversal NUMERIC(10, 2);
    v_owner_reversal NUMERIC(10, 2);
    v_org_bal RECORD;
    v_available NUMERIC(10, 2);
    v_unsettled NUMERIC(10, 2);
    v_from_available NUMERIC(10, 2) := 0.00;
    v_from_unsettled NUMERIC(10, 2) := 0.00;
    v_overdraft_deficit NUMERIC(10, 2) := 0.00;
    v_entries JSONB;
BEGIN
    SELECT r.id, r.facility_id, r.price, f.organization_id
    INTO v_res_record
    FROM public.reservations r
    JOIN public.facilities f ON f.id = r.facility_id
    WHERE r.id = p_reservation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reservation % does not exist.', p_reservation_id;
    END IF;

    IF v_res_record.organization_id != p_organization_id THEN
        RAISE EXCEPTION 'Tenant mismatch: Reservation % does not belong to organization %.',
            p_reservation_id, p_organization_id;
    END IF;

    IF p_refund_gross_amount <= 0.00 OR p_refund_gross_amount > v_res_record.price THEN
        RAISE EXCEPTION 'Invalid refund gross amount: ₱%. Must be > 0 and <= reservation price (₱%).',
            p_refund_gross_amount, v_res_record.price;
    END IF;

    v_commission_reversal := round(p_refund_gross_amount * p_commission_rate, 2);
    v_owner_reversal := p_refund_gross_amount - v_commission_reversal;

    SELECT * INTO v_org_bal
    FROM public.organization_balances
    WHERE organization_id = p_organization_id
    FOR UPDATE;

    v_available := v_org_bal.available_withdrawable_balance;
    v_unsettled := v_org_bal.unsettled_clearing_amount;

    IF v_available >= v_owner_reversal THEN
        v_from_available := v_owner_reversal;
    ELSE
        v_from_available := v_available;
        IF (v_unsettled >= (v_owner_reversal - v_from_available)) THEN
            v_from_unsettled := v_owner_reversal - v_from_available;
        ELSE
            v_from_unsettled := v_unsettled;
            v_overdraft_deficit := v_owner_reversal - v_from_available - v_from_unsettled;
        END IF;
    END IF;

    -- Customer Cash Outflow: CREDIT 1020
    -- Commission Reversal:   DEBIT 4010
    -- Owner Deductions:      DEBIT 2011, DEBIT 2010, DEBIT 1030 (overdraft receivable)
    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '1020', 'entry_direction', 'CREDIT', 'amount', p_refund_gross_amount),
        jsonb_build_object('account_code', '4010', 'entry_direction', 'DEBIT', 'amount', v_commission_reversal)
    );

    IF v_from_available > 0.00 THEN
        v_entries := v_entries || jsonb_build_array(
            jsonb_build_object('account_code', '2011', 'entry_direction', 'DEBIT', 'amount', v_from_available)
        );
    END IF;

    IF v_from_unsettled > 0.00 THEN
        v_entries := v_entries || jsonb_build_array(
            jsonb_build_object('account_code', '2010', 'entry_direction', 'DEBIT', 'amount', v_from_unsettled)
        );
    END IF;

    IF v_overdraft_deficit > 0.00 THEN
        v_entries := v_entries || jsonb_build_array(
            jsonb_build_object('account_code', '1030', 'entry_direction', 'DEBIT', 'amount', v_overdraft_deficit)
        );
    END IF;

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        p_facility_id,
        'refund_reversal',
        p_idempotency_key,
        p_reservation_id,
        format('Refund reversal for reservation %s (Gross: ₱%s, Comm: ₱%s, Owner: ₱%s, Overdraft: ₱%s)',
            p_reservation_id, p_refund_gross_amount, v_commission_reversal, v_owner_reversal, v_overdraft_deficit),
        p_metadata || jsonb_build_object(
            'refund_gross_amount', p_refund_gross_amount,
            'commission_reversal', v_commission_reversal,
            'owner_reversal', v_owner_reversal,
            'overdraft_deficit', v_overdraft_deficit
        ),
        v_entries
    );
END;
$$;


-- 3.4 Chargeback & Dispute Adjustment Event
CREATE OR REPLACE FUNCTION public.post_chargeback_adjustment_event(
    p_organization_id UUID,
    p_facility_id UUID,
    p_reservation_id UUID,
    p_dispute_gross_amount NUMERIC(10, 2),
    p_dispute_fee NUMERIC(10, 2),
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
    v_res_record RECORD;
    v_commission_reversal NUMERIC(10, 2);
    v_owner_reversal NUMERIC(10, 2);
    v_org_bal RECORD;
    v_available NUMERIC(10, 2);
    v_unsettled NUMERIC(10, 2);
    v_from_available NUMERIC(10, 2) := 0.00;
    v_from_unsettled NUMERIC(10, 2) := 0.00;
    v_overdraft_deficit NUMERIC(10, 2) := 0.00;
    v_entries JSONB;
BEGIN
    SELECT r.id, r.facility_id, r.price, f.organization_id
    INTO v_res_record
    FROM public.reservations r
    JOIN public.facilities f ON f.id = r.facility_id
    WHERE r.id = p_reservation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reservation % does not exist.', p_reservation_id;
    END IF;

    IF v_res_record.organization_id != p_organization_id THEN
        RAISE EXCEPTION 'Tenant mismatch: Reservation % does not belong to organization %.',
            p_reservation_id, p_organization_id;
    END IF;

    IF p_dispute_gross_amount <= 0.00 OR p_dispute_gross_amount > v_res_record.price THEN
        RAISE EXCEPTION 'Invalid dispute amount: ₱%.', p_dispute_gross_amount;
    END IF;

    IF p_dispute_fee < 0.00 THEN
        RAISE EXCEPTION 'Dispute fee cannot be negative. Got: ₱%.', p_dispute_fee;
    END IF;

    v_commission_reversal := round(p_dispute_gross_amount * p_commission_rate, 2);
    v_owner_reversal := p_dispute_gross_amount - v_commission_reversal;

    SELECT * INTO v_org_bal
    FROM public.organization_balances
    WHERE organization_id = p_organization_id
    FOR UPDATE;

    v_available := v_org_bal.available_withdrawable_balance;
    v_unsettled := v_org_bal.unsettled_clearing_amount;

    IF v_available >= v_owner_reversal THEN
        v_from_available := v_owner_reversal;
    ELSE
        v_from_available := v_available;
        IF (v_unsettled >= (v_owner_reversal - v_from_available)) THEN
            v_from_unsettled := v_owner_reversal - v_from_available;
        ELSE
            v_from_unsettled := v_unsettled;
            v_overdraft_deficit := v_owner_reversal - v_from_available - v_from_unsettled;
        END IF;
    END IF;

    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '1020', 'entry_direction', 'CREDIT', 'amount', (p_dispute_gross_amount + p_dispute_fee)),
        jsonb_build_object('account_code', '4010', 'entry_direction', 'DEBIT', 'amount', v_commission_reversal)
    );

    IF p_dispute_fee > 0.00 THEN
        v_entries := v_entries || jsonb_build_array(
            jsonb_build_object('account_code', '5010', 'entry_direction', 'DEBIT', 'amount', p_dispute_fee)
        );
    END IF;

    IF v_from_available > 0.00 THEN
        v_entries := v_entries || jsonb_build_array(
            jsonb_build_object('account_code', '2011', 'entry_direction', 'DEBIT', 'amount', v_from_available)
        );
    END IF;

    IF v_from_unsettled > 0.00 THEN
        v_entries := v_entries || jsonb_build_array(
            jsonb_build_object('account_code', '2010', 'entry_direction', 'DEBIT', 'amount', v_from_unsettled)
        );
    END IF;

    IF v_overdraft_deficit > 0.00 THEN
        v_entries := v_entries || jsonb_build_array(
            jsonb_build_object('account_code', '1030', 'entry_direction', 'DEBIT', 'amount', v_overdraft_deficit)
        );
    END IF;

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        p_facility_id,
        'chargeback_adjustment',
        p_idempotency_key,
        p_reservation_id,
        format('Chargeback clawback for reservation %s (Gross: ₱%s, Fee: ₱%s)',
            p_reservation_id, p_dispute_gross_amount, p_dispute_fee),
        p_metadata || jsonb_build_object(
            'dispute_gross_amount', p_dispute_gross_amount,
            'dispute_fee', p_dispute_fee,
            'overdraft_deficit', v_overdraft_deficit
        ),
        v_entries
    );
END;
$$;


-- 3.5 Gateway Fee Assessment Routine
CREATE OR REPLACE FUNCTION public.post_gateway_fee_assessment_event(
    p_organization_id UUID,
    p_facility_id UUID,
    p_reference_id UUID,
    p_fee_amount NUMERIC(10, 2),
    p_allocation_mode TEXT, -- 'undecided_escrow', 'absorbed_by_platform', 'deducted_from_owner'
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_mode TEXT;
    v_entries JSONB;
BEGIN
    IF p_fee_amount <= 0.00 THEN
        RAISE EXCEPTION 'Gateway fee amount must be strictly positive. Got: ₱%.', p_fee_amount;
    END IF;

    v_clean_mode := trim(COALESCE(p_allocation_mode, 'undecided_escrow'));
    IF v_clean_mode NOT IN ('undecided_escrow', 'absorbed_by_platform', 'deducted_from_owner') THEN
        RAISE EXCEPTION 'Invalid fee allocation mode: "%". Must be undecided_escrow, absorbed_by_platform, or deducted_from_owner.', v_clean_mode;
    END IF;

    IF v_clean_mode = 'absorbed_by_platform' THEN
        v_entries := jsonb_build_array(
            jsonb_build_object('account_code', '5010', 'entry_direction', 'DEBIT', 'amount', p_fee_amount),
            jsonb_build_object('account_code', '1010', 'entry_direction', 'CREDIT', 'amount', p_fee_amount)
        );
    ELSIF v_clean_mode = 'undecided_escrow' THEN
        v_entries := jsonb_build_array(
            jsonb_build_object('account_code', '2020', 'entry_direction', 'CREDIT', 'amount', p_fee_amount),
            jsonb_build_object('account_code', '1010', 'entry_direction', 'DEBIT', 'amount', p_fee_amount)
        );
    ELSE
        -- deducted_from_owner
        v_entries := jsonb_build_array(
            jsonb_build_object('account_code', '2011', 'entry_direction', 'DEBIT', 'amount', p_fee_amount),
            jsonb_build_object('account_code', '1010', 'entry_direction', 'CREDIT', 'amount', p_fee_amount)
        );
    END IF;

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        p_facility_id,
        'gateway_fee_assessment',
        p_idempotency_key,
        p_reference_id,
        format('Gateway fee assessment (₱%s, mode: %s)', p_fee_amount, v_clean_mode),
        p_metadata || jsonb_build_object('fee_amount', p_fee_amount, 'allocation_mode', v_clean_mode),
        v_entries
    );
END;
$$;


-- 3.6 Payout Hold Reservation (Two-Phase Payout Phase 1)
-- NOTE: In 005a1, EXECUTE is strictly REVOKED from service_role. Production execution
-- remains disabled until Migration 005B deploys the authoritative payouts table.
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
    v_billing_config RECORD;
    v_existing_reserve RECORD;
    v_existing_terminal RECORD;
    v_entries JSONB;
BEGIN
    IF p_amount <= 0.00 THEN
        RAISE EXCEPTION 'Payout reserve amount must be strictly positive. Got: ₱%', p_amount;
    END IF;

    SELECT min_payout_amount, max_payout_amount INTO v_billing_config
    FROM public.platform_billing_config
    WHERE id = 1;

    IF p_amount < v_billing_config.min_payout_amount THEN
        RAISE EXCEPTION 'Payout amount ₱% is below minimum allowed threshold ₱%.',
            p_amount, v_billing_config.min_payout_amount;
    END IF;

    IF p_amount > v_billing_config.max_payout_amount THEN
        RAISE EXCEPTION 'Payout amount ₱% exceeds maximum allowed threshold ₱%.',
            p_amount, v_billing_config.max_payout_amount;
    END IF;

    -- Concurrency-Safe Lifecycle Guard: Check existing reserve
    SELECT id, idempotency_key INTO v_existing_reserve
    FROM public.financial_transactions
    WHERE reference_id = p_payout_id AND transaction_type = 'payout_reserve';

    IF FOUND THEN
        IF v_existing_reserve.idempotency_key != trim(p_idempotency_key) THEN
            RAISE EXCEPTION 'Payout lifecycle conflict: Payout ID % already has an active reservation under a different idempotency key.',
                p_payout_id;
        END IF;
    END IF;

    -- Check if payout is already terminal
    SELECT id, transaction_type INTO v_existing_terminal
    FROM public.financial_transactions
    WHERE reference_id = p_payout_id
      AND transaction_type IN ('payout_disbursement', 'payout_failed_release');

    IF FOUND THEN
        RAISE EXCEPTION 'Payout lifecycle conflict: Payout ID % has already reached terminal status "%". Cannot reserve.',
            p_payout_id, v_existing_terminal.transaction_type;
    END IF;

    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '2011', 'entry_direction', 'DEBIT', 'amount', p_amount),
        jsonb_build_object('account_code', '2015', 'entry_direction', 'CREDIT', 'amount', p_amount)
    );

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        NULL,
        'payout_reserve',
        p_idempotency_key,
        p_payout_id,
        format('Owner payout hold reserved: ₱%s', p_amount),
        p_metadata || jsonb_build_object('payout_id', p_payout_id, 'amount', p_amount),
        v_entries
    );
END;
$$;


-- 3.7 Payout Disbursement (Two-Phase Payout Phase 2: Success)
-- NOTE: In 005a1, EXECUTE is strictly REVOKED from service_role. Production execution
-- remains disabled until Migration 005B deploys the authoritative payouts table.
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
    v_reserve_record RECORD;
    v_terminal_tx RECORD;
    v_entries JSONB;
BEGIN
    IF p_amount <= 0.00 THEN
        RAISE EXCEPTION 'Payout disbursement amount must be strictly positive. Got: ₱%', p_amount;
    END IF;

    -- Lifecycle Enforcement: Verify preceding payout_reserve exists
    SELECT id, organization_id, metadata INTO v_reserve_record
    FROM public.financial_transactions
    WHERE reference_id = p_payout_id AND transaction_type = 'payout_reserve';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payout lifecycle violation: No prior payout_reserve found for payout ID %.', p_payout_id;
    END IF;

    IF v_reserve_record.organization_id != p_organization_id THEN
        RAISE EXCEPTION 'Tenant mismatch: Payout reserve % belongs to organization %, not caller %.',
            p_payout_id, v_reserve_record.organization_id, p_organization_id;
    END IF;

    IF (v_reserve_record.metadata->>'amount')::NUMERIC(10, 2) != p_amount THEN
        RAISE EXCEPTION 'Amount mismatch: Reserved amount ₱% does not match disbursement request ₱%.',
            (v_reserve_record.metadata->>'amount'), p_amount;
    END IF;

    -- Concurrency-Safe Lifecycle Guard: Check terminal status
    SELECT id, transaction_type, idempotency_key INTO v_terminal_tx
    FROM public.financial_transactions
    WHERE reference_id = p_payout_id
      AND transaction_type IN ('payout_disbursement', 'payout_failed_release');

    IF FOUND THEN
        IF v_terminal_tx.idempotency_key != trim(p_idempotency_key) OR v_terminal_tx.transaction_type != 'payout_disbursement' THEN
            RAISE EXCEPTION 'Payout lifecycle conflict: Payout ID % has already reached terminal status "%". Duplicate or conflicting terminal outcome rejected.',
                p_payout_id, v_terminal_tx.transaction_type;
        END IF;
    END IF;

    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '2015', 'entry_direction', 'DEBIT', 'amount', p_amount),
        jsonb_build_object('account_code', '1020', 'entry_direction', 'CREDIT', 'amount', p_amount)
    );

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        NULL,
        'payout_disbursement',
        p_idempotency_key,
        p_payout_id,
        format('Owner payout disbursement settled: ₱%s', p_amount),
        p_metadata || jsonb_build_object('payout_id', p_payout_id, 'amount', p_amount),
        v_entries
    );
END;
$$;


-- 3.8 Payout Failed Release (Two-Phase Payout Phase 2: Failure)
-- NOTE: In 005a1, EXECUTE is strictly REVOKED from service_role. Production execution
-- remains disabled until Migration 005B deploys the authoritative payouts table.
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
    v_reserve_record RECORD;
    v_terminal_tx RECORD;
    v_entries JSONB;
BEGIN
    IF p_amount <= 0.00 THEN
        RAISE EXCEPTION 'Payout release amount must be strictly positive. Got: ₱%', p_amount;
    END IF;

    -- Lifecycle Enforcement: Verify preceding payout_reserve exists
    SELECT id, organization_id, metadata INTO v_reserve_record
    FROM public.financial_transactions
    WHERE reference_id = p_payout_id AND transaction_type = 'payout_reserve';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payout lifecycle violation: No prior payout_reserve found for payout ID %.', p_payout_id;
    END IF;

    IF v_reserve_record.organization_id != p_organization_id THEN
        RAISE EXCEPTION 'Tenant mismatch: Payout reserve % belongs to organization %, not caller %.',
            p_payout_id, v_reserve_record.organization_id, p_organization_id;
    END IF;

    IF (v_reserve_record.metadata->>'amount')::NUMERIC(10, 2) != p_amount THEN
        RAISE EXCEPTION 'Amount mismatch: Reserved amount ₱% does not match release request ₱%.',
            (v_reserve_record.metadata->>'amount'), p_amount;
    END IF;

    -- Concurrency-Safe Lifecycle Guard: Check terminal status
    SELECT id, transaction_type, idempotency_key INTO v_terminal_tx
    FROM public.financial_transactions
    WHERE reference_id = p_payout_id
      AND transaction_type IN ('payout_disbursement', 'payout_failed_release');

    IF FOUND THEN
        IF v_terminal_tx.idempotency_key != trim(p_idempotency_key) OR v_terminal_tx.transaction_type != 'payout_failed_release' THEN
            RAISE EXCEPTION 'Payout lifecycle conflict: Payout ID % has already reached terminal status "%". Duplicate or conflicting terminal outcome rejected.',
                p_payout_id, v_terminal_tx.transaction_type;
        END IF;
    END IF;

    v_entries := jsonb_build_array(
        jsonb_build_object('account_code', '2015', 'entry_direction', 'DEBIT', 'amount', p_amount),
        jsonb_build_object('account_code', '2011', 'entry_direction', 'CREDIT', 'amount', p_amount)
    );

    RETURN public.post_journal_entry_internal(
        p_organization_id,
        NULL,
        'payout_failed_release',
        p_idempotency_key,
        p_payout_id,
        format('Owner payout failed; released ₱%s back to available withdrawable balance', p_amount),
        p_metadata || jsonb_build_object('payout_id', p_payout_id, 'amount', p_amount),
        v_entries
    );
END;
$$;


-- 3.9 Excess or Late Payment Capture (Zero Owner Balance Inflation)
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
        RAISE EXCEPTION 'Excess or late payment amount must be strictly positive. Got: ₱%', p_amount;
    END IF;

    IF p_is_late THEN
        v_tx_type := 'late_payment_liability';
        v_desc := format('Late payment capture after hold expiration: ₱%s routed to customer refund liability', p_amount);
    ELSE
        v_tx_type := 'excess_payment_liability';
        v_desc := format('Excess or duplicate payment capture: ₱%s routed to customer refund liability', p_amount);
    END IF;

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
        p_metadata || jsonb_build_object('amount', p_amount, 'is_late', p_is_late),
        v_entries
    );
END;
$$;


-- ==============================================================================
-- 4. Privilege Hardening & Production Boundary Separation
-- ==============================================================================

-- 4.1 Private Internal Engine: REVOKED from ALL roles including service_role.
-- Uncallable as an external RPC by any client.
REVOKE ALL ON FUNCTION public.post_journal_entry_internal(UUID, UUID, VARCHAR, TEXT, UUID, TEXT, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

-- 4.2 Production-Disabled Provider Operations: REVOKED from service_role.
-- Kept disabled in production until Migration 005B provider settlement batch
-- and payouts tables exist.
REVOKE ALL ON FUNCTION public.post_funds_cleared_event(UUID, UUID, NUMERIC, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.post_payout_reserve_event(UUID, UUID, NUMERIC, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.post_payout_disbursement_event(UUID, UUID, NUMERIC, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.post_payout_failed_release_event(UUID, UUID, NUMERIC, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

-- 4.3 Active Production Accounting Routines: REVOKED from PUBLIC, anon, authenticated.
REVOKE ALL ON FUNCTION public.post_booking_settlement_event(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_refund_reversal_event(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_chargeback_adjustment_event(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_gateway_fee_assessment_event(UUID, UUID, UUID, NUMERIC, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_excess_or_late_payment_event(UUID, UUID, UUID, NUMERIC, BOOLEAN, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;

-- 4.4 Active Production Accounting Routines: GRANTED strictly to service_role for backend workers.
GRANT EXECUTE ON FUNCTION public.post_booking_settlement_event(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.post_refund_reversal_event(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.post_chargeback_adjustment_event(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.post_gateway_fee_assessment_event(UUID, UUID, UUID, NUMERIC, TEXT, TEXT, JSONB)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.post_excess_or_late_payment_event(UUID, UUID, UUID, NUMERIC, BOOLEAN, TEXT, JSONB)
    TO service_role;
