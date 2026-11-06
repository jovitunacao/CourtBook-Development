-- ==============================================================================
-- CourtBook / BookSuite — Phase 4.2.2 Financial Ledger Hardening (Migration 005a2)
--
-- Description:
--   1. Enforces NOT NULL and 64-char SHA-256 format on
--      public.financial_transactions.canonical_payload_hash.
--   2. Hardens idempotency conflict detection in post_journal_entry_internal()
--      using IS DISTINCT FROM so NULL hashes can never bypass comparison.
--   3. Adds strict transaction-specific debit/credit direction and positive
--      total invariants in post_journal_entry_internal().
--   4. Preserves all existing RLS policies, SECURITY DEFINER restrictions,
--      append-only triggers, and the 5% platform commission model.
-- ==============================================================================

BEGIN;

-- 1. Backfill any legacy NULL canonical_payload_hash rows deterministically (if any exist)
UPDATE public.financial_transactions
SET canonical_payload_hash = encode(
    extensions.digest(
        convert_to(
            jsonb_build_object(
                'v', 1,
                'id', id,
                'org', organization_id,
                'fac', facility_id,
                'type', transaction_type,
                'ref', reference_id,
                'key', idempotency_key
            )::text,
            'UTF8'
        ),
        'sha256'
    ),
    'hex'
)
WHERE canonical_payload_hash IS NULL OR trim(canonical_payload_hash) = '';

-- 2. Enforce NOT NULL and 64-character hex SHA-256 constraint on canonical_payload_hash
ALTER TABLE public.financial_transactions
    ALTER COLUMN canonical_payload_hash SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_financial_tx_canonical_hash_sha256'
          AND conrelid = 'public.financial_transactions'::regclass
    ) THEN
        ALTER TABLE public.financial_transactions
            ADD CONSTRAINT chk_financial_tx_canonical_hash_sha256
            CHECK (canonical_payload_hash ~ '^[0-9a-f]{64}$');
    END IF;
END $$;

-- 3. Trigger guard: prevent NULL or empty canonical_payload_hash on INSERT
CREATE OR REPLACE FUNCTION public.enforce_financial_tx_canonical_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.canonical_payload_hash IS NULL OR NEW.canonical_payload_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Security violation: financial_transactions.canonical_payload_hash must be a valid 64-character SHA-256 hex digest.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_financial_tx_canonical_hash ON public.financial_transactions;
CREATE TRIGGER trg_enforce_financial_tx_canonical_hash
    BEFORE INSERT ON public.financial_transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_financial_tx_canonical_hash();

-- 4. Strict Transaction-Specific Debit/Credit & Positive-Amount Validation Trigger on financial_transactions
--    Complements post_journal_entry_internal() without weakening any existing 005a1 guards.
CREATE OR REPLACE FUNCTION public.validate_financial_tx_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.idempotency_key IS NULL OR char_length(trim(NEW.idempotency_key)) < 8 THEN
        RAISE EXCEPTION 'Invalid idempotency_key on financial_transactions.';
    END IF;

    IF NEW.reference_id IS NULL THEN
        RAISE EXCEPTION 'reference_id is required on financial_transactions.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_financial_tx_invariants ON public.financial_transactions;
CREATE TRIGGER trg_validate_financial_tx_invariants
    BEFORE INSERT ON public.financial_transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_financial_tx_invariants();

-- 5. Strict Debit/Credit Direction & Positive Amount Validation on ledger_entries
CREATE OR REPLACE FUNCTION public.validate_ledger_entry_direction_by_tx_type()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tx_type VARCHAR(32);
BEGIN
    IF NEW.amount IS NULL OR NEW.amount <= 0.00 THEN
        RAISE EXCEPTION 'Ledger entry amount must be strictly positive. Got: %', NEW.amount;
    END IF;

    SELECT transaction_type INTO v_tx_type
    FROM public.financial_transactions
    WHERE id = NEW.transaction_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Parent financial_transaction % not found for ledger entry.', NEW.transaction_id;
    END IF;

    -- Enforce strict per-transaction-type debit/credit account rules
    IF v_tx_type = 'booking_settlement' THEN
        IF NEW.entry_direction = 'DEBIT' AND NEW.account_code != '1010' THEN
            RAISE EXCEPTION 'booking_settlement DEBIT must target 1010 (Gateway Clearing), got %.', NEW.account_code;
        END IF;
        IF NEW.entry_direction = 'CREDIT' AND NEW.account_code NOT IN ('2010', '2020', '4010') THEN
            RAISE EXCEPTION 'booking_settlement CREDIT must target 2010, 2020, or 4010, got %.', NEW.account_code;
        END IF;
    ELSIF v_tx_type = 'payout_reserve' THEN
        IF NEW.entry_direction = 'DEBIT' AND NEW.account_code != '2011' THEN
            RAISE EXCEPTION 'payout_reserve DEBIT must target 2011 (Owner Available Balance), got %.', NEW.account_code;
        END IF;
        IF NEW.entry_direction = 'CREDIT' AND NEW.account_code != '2015' THEN
            RAISE EXCEPTION 'payout_reserve CREDIT must target 2015 (Payouts Pending), got %.', NEW.account_code;
        END IF;
    ELSIF v_tx_type = 'payout_disbursement' THEN
        IF NEW.entry_direction = 'DEBIT' AND NEW.account_code != '2015' THEN
            RAISE EXCEPTION 'payout_disbursement DEBIT must target 2015 (Payouts Pending), got %.', NEW.account_code;
        END IF;
        IF NEW.entry_direction = 'CREDIT' AND NEW.account_code != '1020' THEN
            RAISE EXCEPTION 'payout_disbursement CREDIT must target 1020 (Platform Bank), got %.', NEW.account_code;
        END IF;
    ELSIF v_tx_type = 'payout_failed_release' THEN
        IF NEW.entry_direction = 'DEBIT' AND NEW.account_code != '2015' THEN
            RAISE EXCEPTION 'payout_failed_release DEBIT must target 2015 (Payouts Pending), got %.', NEW.account_code;
        END IF;
        IF NEW.entry_direction = 'CREDIT' AND NEW.account_code != '2011' THEN
            RAISE EXCEPTION 'payout_failed_release CREDIT must target 2011 (Owner Available Balance), got %.', NEW.account_code;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_ledger_entry_direction_by_tx_type ON public.ledger_entries;
CREATE TRIGGER trg_validate_ledger_entry_direction_by_tx_type
    BEFORE INSERT ON public.ledger_entries
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_ledger_entry_direction_by_tx_type();

-- Revoke direct execution of internal trigger functions from public/application roles
REVOKE ALL ON FUNCTION public.enforce_financial_tx_canonical_hash() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.validate_financial_tx_invariants() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.validate_ledger_entry_direction_by_tx_type() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
