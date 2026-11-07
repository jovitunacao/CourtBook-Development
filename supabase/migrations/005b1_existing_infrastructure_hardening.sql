-- ==============================================================================
-- CourtBook / BookSuite — Database Schema Migration
-- Migration: 005b1_existing_infrastructure_hardening.sql
-- Description: Phase 4.2.3 Existing Infrastructure Hardening (Non-Destructive Upgrade)
--
-- TARGET ENVIRONMENT:
--   BookSuite-Payment-Test (and staging/production environments with existing 005B tables)
--
-- PURPOSE & OBJECTIVES:
--   1. Non-destructive, forward-only upgrade of existing 005B infrastructure tables.
--   2. Strict preservation of existing records (including existing pending payments
--      and platform fee policy controls).
--   3. Addition of missing composite unique constraint on public.payouts:
--      uq_payouts_id_org (id, organization_id).
--   4. Addition of composite journal foreign keys on public.payouts:
--      - fk_payouts_journal_reserve_org (journal_reserve_tx_id, organization_id)
--      - fk_payouts_journal_terminal_org (journal_terminal_tx_id, organization_id)
--      - fk_payouts_method_org (payout_method_id, organization_id)
--   5. Addition of composite organization foreign key on public.payout_lifecycle_logs:
--      fk_payout_lifecycle_logs_payout_org (payout_id, organization_id).
--   6. Establishment of append-only immutability trigger on public.payout_lifecycle_logs
--      and public.provider_webhook_events.
--   7. In-place upgrade of validation trigger functions to match latest hardened 005B:
--      - fn_validate_payment_status_transition()
--      - fn_validate_payout_status_transition()
--      - fn_audit_payout_lifecycle()
--   8. Reconcile RLS policies and column privileges with owner/admin financial model.
--   9. Preflight and post-migration validation checks ensuring atomic, safe execution.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. Preflight Validation & Prerequisite Verification
-- ==============================================================================
DO $$
DECLARE
    v_missing_table TEXT;
    v_invalid_count INT;
    v_payment_count INT;
BEGIN
    RAISE NOTICE '=== 005b1 Migration: Commencing Preflight Verification ===';

    -- 1. Check prerequisite tables from 001-005A and 005B
    FOREACH v_missing_table IN ARRAY ARRAY[
        'organizations', 'facilities', 'courts', 'reservations',
        'financial_transactions', 'platform_billing_config',
        'payments', 'platform_fee_policy_controls', 'settlement_batches',
        'settlement_items', 'payout_methods', 'payouts',
        'payout_lifecycle_logs', 'provider_webhook_events'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = v_missing_table
        ) THEN
            RAISE EXCEPTION 'Preflight Failure: Required table public.% does not exist. Migration 005b1 cannot proceed.', v_missing_table;
        END IF;
    END LOOP;

    -- 2. Verify platform_billing_config singleton exists and is valid
    IF NOT EXISTS (
        SELECT 1 FROM public.platform_billing_config
        WHERE id = 1 AND default_commission_rate IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Preflight Failure: public.platform_billing_config(id = 1) is missing or unconfigured.';
    END IF;

    -- 3. Verify financial_transactions has composite uniqueness for journal foreign keys
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_financial_tx_id_org'
          AND conrelid = 'public.financial_transactions'::regclass
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE contype = 'u'
          AND conrelid = 'public.financial_transactions'::regclass
          AND conkey = ARRAY[
              (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.financial_transactions'::regclass AND attname = 'id'),
              (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.financial_transactions'::regclass AND attname = 'organization_id')
          ]
    ) THEN
        RAISE EXCEPTION 'Preflight Failure: public.financial_transactions lacks required UNIQUE (id, organization_id) constraint from Migration 005a1.';
    END IF;

    -- 4. Verify existing records in payments table
    SELECT count(*) INTO v_payment_count FROM public.payments;
    RAISE NOTICE 'Preflight Check: Found % existing payment record(s) in public.payments.', v_payment_count;

    -- Ensure no payments violate amount split
    SELECT count(*) INTO v_invalid_count FROM public.payments
    WHERE expected_amount IS DISTINCT FROM (commission_amount + owner_gross_share);
    IF v_invalid_count > 0 THEN
        RAISE EXCEPTION 'Preflight Failure: % existing payment(s) violate expected_amount = (commission_amount + owner_gross_share).', v_invalid_count;
    END IF;

    -- Ensure no payments have refunded_amount > captured_amount
    SELECT count(*) INTO v_invalid_count FROM public.payments
    WHERE refunded_amount > captured_amount;
    IF v_invalid_count > 0 THEN
        RAISE EXCEPTION 'Preflight Failure: % existing payment(s) have refunded_amount exceeding captured_amount.', v_invalid_count;
    END IF;

    -- Ensure no pending payments have positive captured funds or captured_at
    SELECT count(*) INTO v_invalid_count FROM public.payments
    WHERE status IN ('pending', 'requires_action') AND (captured_amount > 0.00 OR captured_at IS NOT NULL);
    IF v_invalid_count > 0 THEN
        RAISE EXCEPTION 'Preflight Failure: % pending payment(s) possess positive captured funds or timestamps.', v_invalid_count;
    END IF;

    -- 5. Verify existing records in payouts table (if any)
    SELECT count(*) INTO v_invalid_count FROM (
        SELECT id, organization_id FROM public.payouts GROUP BY id, organization_id HAVING count(*) > 1
    ) sub;
    IF v_invalid_count > 0 THEN
        RAISE EXCEPTION 'Preflight Failure: Duplicate (id, organization_id) found in public.payouts. Cannot create unique constraint.';
    END IF;

    -- Ensure existing payouts reference payout_methods of the same organization
    SELECT count(*) INTO v_invalid_count FROM public.payouts p
    WHERE NOT EXISTS (
        SELECT 1 FROM public.payout_methods pm
        WHERE pm.id = p.payout_method_id AND pm.organization_id = p.organization_id
    );
    IF v_invalid_count > 0 THEN
        RAISE EXCEPTION 'Preflight Failure: % payout(s) reference payout_methods belonging to a different organization.', v_invalid_count;
    END IF;

    -- Ensure existing payouts reference financial_transactions of the same organization
    SELECT count(*) INTO v_invalid_count FROM public.payouts p
    WHERE p.journal_reserve_tx_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.financial_transactions ft
        WHERE ft.id = p.journal_reserve_tx_id AND ft.organization_id = p.organization_id
    );
    IF v_invalid_count > 0 THEN
        RAISE EXCEPTION 'Preflight Failure: % payout(s) reference journal_reserve_tx_id with mismatched organization.', v_invalid_count;
    END IF;

    SELECT count(*) INTO v_invalid_count FROM public.payouts p
    WHERE p.journal_terminal_tx_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.financial_transactions ft
        WHERE ft.id = p.journal_terminal_tx_id AND ft.organization_id = p.organization_id
    );
    IF v_invalid_count > 0 THEN
        RAISE EXCEPTION 'Preflight Failure: % payout(s) reference journal_terminal_tx_id with mismatched organization.', v_invalid_count;
    END IF;

    -- 6. Verify existing records in payout_lifecycle_logs (if any)
    SELECT count(*) INTO v_invalid_count FROM public.payout_lifecycle_logs l
    WHERE NOT EXISTS (
        SELECT 1 FROM public.payouts p
        WHERE p.id = l.payout_id AND p.organization_id = l.organization_id
    );
    IF v_invalid_count > 0 THEN
        RAISE EXCEPTION 'Preflight Failure: % payout_lifecycle_log(s) reference payouts with mismatched organization.', v_invalid_count;
    END IF;

    RAISE NOTICE 'Preflight Check: All prerequisites and existing data validation passed successfully.';
END $$;


-- ==============================================================================
-- 2. Non-Destructive Constraint & Index Hardening on Payouts & Payout Methods
-- ==============================================================================

-- 2a. Payout Methods: Ensure composite uniqueness for cross-tenant payout linkage
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_payout_methods_id_org'
          AND conrelid = 'public.payout_methods'::regclass
    ) THEN
        ALTER TABLE public.payout_methods
            ADD CONSTRAINT uq_payout_methods_id_org UNIQUE (id, organization_id);
        RAISE NOTICE 'Added constraint uq_payout_methods_id_org on public.payout_methods.';
    END IF;
END $$;

-- 2b. Payouts: Add composite uniqueness (id, organization_id)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_payouts_id_org'
          AND conrelid = 'public.payouts'::regclass
    ) THEN
        ALTER TABLE public.payouts
            ADD CONSTRAINT uq_payouts_id_org UNIQUE (id, organization_id);
        RAISE NOTICE 'Added constraint uq_payouts_id_org on public.payouts.';
    END IF;
END $$;

-- 2c. Payouts: Add composite cross-tenant payout method foreign key
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_payouts_method_org'
          AND conrelid = 'public.payouts'::regclass
    ) THEN
        ALTER TABLE public.payouts
            ADD CONSTRAINT fk_payouts_method_org
            FOREIGN KEY (payout_method_id, organization_id)
            REFERENCES public.payout_methods(id, organization_id)
            ON DELETE RESTRICT;
        RAISE NOTICE 'Added constraint fk_payouts_method_org on public.payouts.';
    END IF;
END $$;

-- 2d. Payouts: Add composite journal reserve foreign key
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_payouts_journal_reserve_org'
          AND conrelid = 'public.payouts'::regclass
    ) THEN
        ALTER TABLE public.payouts
            ADD CONSTRAINT fk_payouts_journal_reserve_org
            FOREIGN KEY (journal_reserve_tx_id, organization_id)
            REFERENCES public.financial_transactions(id, organization_id)
            ON DELETE RESTRICT;
        RAISE NOTICE 'Added constraint fk_payouts_journal_reserve_org on public.payouts.';
    END IF;
END $$;

-- 2e. Payouts: Add composite journal terminal foreign key
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_payouts_journal_terminal_org'
          AND conrelid = 'public.payouts'::regclass
    ) THEN
        ALTER TABLE public.payouts
            ADD CONSTRAINT fk_payouts_journal_terminal_org
            FOREIGN KEY (journal_terminal_tx_id, organization_id)
            REFERENCES public.financial_transactions(id, organization_id)
            ON DELETE RESTRICT;
        RAISE NOTICE 'Added constraint fk_payouts_journal_terminal_org on public.payouts.';
    END IF;
END $$;

-- 2f. Payouts & Payout Methods: Ensure supporting indexes
CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_provider_payout_id
    ON public.payouts (provider_payout_id)
    WHERE provider_payout_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payouts_org_status
    ON public.payouts (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_payout_methods_org
    ON public.payout_methods (organization_id, is_active);


-- ==============================================================================
-- 3. Non-Destructive Constraint Hardening on Payout Lifecycle Logs
-- ==============================================================================

-- 3a. Add composite foreign key linking logs strictly to (payout_id, organization_id)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_payout_lifecycle_logs_payout_org'
          AND conrelid = 'public.payout_lifecycle_logs'::regclass
    ) THEN
        ALTER TABLE public.payout_lifecycle_logs
            ADD CONSTRAINT fk_payout_lifecycle_logs_payout_org
            FOREIGN KEY (payout_id, organization_id)
            REFERENCES public.payouts(id, organization_id)
            ON DELETE CASCADE;
        RAISE NOTICE 'Added constraint fk_payout_lifecycle_logs_payout_org on public.payout_lifecycle_logs.';
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payout_lifecycle_payout
    ON public.payout_lifecycle_logs (payout_id, created_at);


-- ==============================================================================
-- 4. Non-Destructive Constraint Hardening on Payments & Settlements
-- ==============================================================================

-- 4a. Payments: Composite uniqueness (id, organization_id, facility_id) for settlement linkage
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_payments_id_org_facility'
          AND conrelid = 'public.payments'::regclass
    ) THEN
        ALTER TABLE public.payments
            ADD CONSTRAINT uq_payments_id_org_facility UNIQUE (id, organization_id, facility_id);
        RAISE NOTICE 'Added constraint uq_payments_id_org_facility on public.payments.';
    END IF;
END $$;

-- 4b. Payments: Check constraint refunded_amount <= captured_amount
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_payments_refunded_le_captured'
          AND conrelid = 'public.payments'::regclass
    ) THEN
        ALTER TABLE public.payments
            ADD CONSTRAINT chk_payments_refunded_le_captured CHECK (refunded_amount <= captured_amount);
        RAISE NOTICE 'Added constraint chk_payments_refunded_le_captured on public.payments.';
    END IF;
END $$;

-- 4c. Payments: Check constraint expected_amount = commission_amount + owner_gross_share
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_payment_amount_split'
          AND conrelid = 'public.payments'::regclass
    ) THEN
        ALTER TABLE public.payments
            ADD CONSTRAINT chk_payment_amount_split CHECK (expected_amount = (commission_amount + owner_gross_share));
        RAISE NOTICE 'Added constraint chk_payment_amount_split on public.payments.';
    END IF;
END $$;

-- 4d. Payments: Unique provider payment and intent IDs
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_payment_id
    ON public.payments (provider_name, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_intent_id
    ON public.payments (provider_name, provider_payment_intent_id)
    WHERE provider_payment_intent_id IS NOT NULL;

-- 4e. Payments: Permanent lifecycle capture uniqueness per reservation
CREATE UNIQUE INDEX IF NOT EXISTS uq_captured_payment_lifecycle_per_reservation
    ON public.payments (reservation_id)
    WHERE status IN ('captured', 'partially_refunded', 'refunded', 'disputed');

CREATE INDEX IF NOT EXISTS idx_payments_org_status
    ON public.payments (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_payments_checkout_session
    ON public.payments (checkout_session_id);

-- 4f. Settlement Items: Composite cross-tenant settlement constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_settlement_items_payment_org_fac'
          AND conrelid = 'public.settlement_items'::regclass
    ) THEN
        ALTER TABLE public.settlement_items
            ADD CONSTRAINT fk_settlement_items_payment_org_fac
            FOREIGN KEY (payment_id, organization_id, facility_id)
            REFERENCES public.payments(id, organization_id, facility_id)
            ON DELETE RESTRICT;
        RAISE NOTICE 'Added constraint fk_settlement_items_payment_org_fac on public.settlement_items.';
    END IF;
END $$;


-- ==============================================================================
-- 5. Append-Only Immutability Functions & Triggers
-- ==============================================================================

-- 5a. Payout Lifecycle Logs: Unconditional Append-Only Protection
CREATE OR REPLACE FUNCTION public.fn_protect_payout_lifecycle_logs_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'Payout lifecycle audit records are append-only and strictly immutable. UPDATE and DELETE operations are prohibited.';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_payout_lifecycle_logs_immutability ON public.payout_lifecycle_logs;
CREATE TRIGGER trg_protect_payout_lifecycle_logs_immutability
    BEFORE UPDATE OR DELETE ON public.payout_lifecycle_logs
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_protect_payout_lifecycle_logs_immutability();

-- 5b. Provider Webhook Events: Append-Only Inbox & Evidence Protection
CREATE OR REPLACE FUNCTION public.fn_protect_webhook_inbox_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Webhook event inbox is append-only. DELETE operations are prohibited.';
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.provider_name IS DISTINCT FROM NEW.provider_name OR
           OLD.provider_event_id IS DISTINCT FROM NEW.provider_event_id OR
           OLD.received_at IS DISTINCT FROM NEW.received_at OR
           OLD.event_timestamp IS DISTINCT FROM NEW.event_timestamp OR
           OLD.signature_header IS DISTINCT FROM NEW.signature_header OR
           OLD.payload_hash IS DISTINCT FROM NEW.payload_hash OR
           OLD.payload IS DISTINCT FROM NEW.payload OR
           (OLD.signature_verification_status = 'verified' AND NEW.signature_verification_status IS DISTINCT FROM 'verified') THEN
            RAISE EXCEPTION 'Webhook event identity, payload, timestamp, and signature evidence are strictly immutable.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_webhook_inbox_immutability ON public.provider_webhook_events;
CREATE TRIGGER trg_protect_webhook_inbox_immutability
    BEFORE UPDATE OR DELETE ON public.provider_webhook_events
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_protect_webhook_inbox_immutability();


-- ==============================================================================
-- 6. Upgraded Payment Validation Trigger Function (Matching Hardened 005B)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.fn_validate_payment_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_config_comm_rate NUMERIC(5, 4);
    v_expected_comm NUMERIC(10, 2);
    v_expected_owner NUMERIC(10, 2);
BEGIN
    -- 1. INSERT-TIME STATUS & FINANCIAL INTEGRITY VALIDATION
    IF TG_OP = 'INSERT' THEN
        -- Payments can only be inserted in safe initial states: 'pending' or 'requires_action'
        IF NEW.status NOT IN ('pending', 'requires_action') THEN
            RAISE EXCEPTION 'Invalid initial payment status: payment records cannot be inserted directly into "%". Must be initialized as "pending".', NEW.status;
        END IF;

        -- Initial amounts must be strictly zero (capture & refund require authorized state transitions)
        IF NEW.captured_amount IS DISTINCT FROM 0.00 THEN
            RAISE EXCEPTION 'Initial payment record cannot have positive captured_amount (attempted ₱%). Capture requires an authorized state transition.', NEW.captured_amount;
        END IF;

        IF NEW.refunded_amount IS DISTINCT FROM 0.00 THEN
            RAISE EXCEPTION 'Initial payment record cannot have positive refunded_amount (attempted ₱%). Refund requires an authorized state transition.', NEW.refunded_amount;
        END IF;

        IF NEW.captured_at IS NOT NULL THEN
            RAISE EXCEPTION 'captured_at timestamp cannot be set at payment creation time.';
        END IF;

        -- Authoritative Commission Rate & Snapshot Validation against platform_billing_config
        SELECT default_commission_rate INTO v_config_comm_rate
        FROM public.platform_billing_config
        WHERE id = 1;

        IF NOT FOUND OR v_config_comm_rate IS NULL THEN
            RAISE EXCEPTION 'Authoritative platform billing configuration (id = 1) is missing or unconfigured. Cannot initialize payments.';
        END IF;

        IF NEW.commission_rate IS DISTINCT FROM v_config_comm_rate THEN
            RAISE EXCEPTION 'Commission rate tampering rejected: Supplied rate % does not match configured platform commission rate %.',
                NEW.commission_rate, v_config_comm_rate;
        END IF;

        v_expected_comm := round(NEW.expected_amount * NEW.commission_rate, 2);
        v_expected_owner := NEW.expected_amount - v_expected_comm;

        IF NEW.commission_amount IS DISTINCT FROM v_expected_comm THEN
            RAISE EXCEPTION 'Commission amount mismatch: Supplied ₱% does not match calculated commission ₱% (rate % on ₱%).',
                NEW.commission_amount, v_expected_comm, NEW.commission_rate, NEW.expected_amount;
        END IF;

        IF NEW.owner_gross_share IS DISTINCT FROM v_expected_owner THEN
            RAISE EXCEPTION 'Owner gross share mismatch: Supplied ₱% does not match calculated owner share ₱%.',
                NEW.owner_gross_share, v_expected_owner;
        END IF;

        RETURN NEW;
    END IF;

    -- 2. TERMINAL STATE MUTATION PROTECTION
    -- Terminal payments ('failed', 'cancelled', 'refunded') are 100% frozen against ANY update
    IF OLD.status IN ('failed', 'cancelled', 'refunded') THEN
        RAISE EXCEPTION 'Invalid payment mutation: payment % is in terminal status "%" and cannot be modified.',
            OLD.id, OLD.status;
    END IF;

    -- 3. UPDATE-TIME IMMUTABILITY CHECKS
    -- Financial snapshot, tenant ownership, and established provider IDs are strictly immutable on EVERY update
    IF OLD.organization_id IS DISTINCT FROM NEW.organization_id OR
       OLD.facility_id IS DISTINCT FROM NEW.facility_id OR
       OLD.reservation_id IS DISTINCT FROM NEW.reservation_id OR
       OLD.expected_amount IS DISTINCT FROM NEW.expected_amount OR
       OLD.commission_rate IS DISTINCT FROM NEW.commission_rate OR
       OLD.commission_amount IS DISTINCT FROM NEW.commission_amount OR
       OLD.owner_gross_share IS DISTINCT FROM NEW.owner_gross_share OR
       OLD.currency IS DISTINCT FROM NEW.currency OR
       OLD.provider_name IS DISTINCT FROM NEW.provider_name OR
       OLD.created_at IS DISTINCT FROM NEW.created_at OR
       (OLD.provider_payment_id IS NOT NULL AND OLD.provider_payment_id IS DISTINCT FROM NEW.provider_payment_id) OR
       (OLD.provider_payment_intent_id IS NOT NULL AND OLD.provider_payment_intent_id IS DISTINCT FROM NEW.provider_payment_intent_id) OR
       (OLD.checkout_session_id IS NOT NULL AND OLD.checkout_session_id IS DISTINCT FROM NEW.checkout_session_id) OR
       (OLD.capture_idempotency_key IS NOT NULL AND OLD.capture_idempotency_key IS DISTINCT FROM NEW.capture_idempotency_key) OR
       (OLD.captured_at IS NOT NULL AND OLD.captured_at IS DISTINCT FROM NEW.captured_at) THEN
        RAISE EXCEPTION 'Financial snapshot, ownership, and established provider identity fields in payments table are strictly immutable.';
    END IF;

    -- Verified capture evidence monotonicity: Established evidence cannot be truncated or cleared
    IF OLD.verified_capture_evidence IS NOT NULL AND OLD.verified_capture_evidence != '{}'::jsonb THEN
        IF NOT (NEW.verified_capture_evidence @> OLD.verified_capture_evidence) THEN
            RAISE EXCEPTION 'Evidence tampering rejected: verified_capture_evidence cannot have existing keys removed or altered.';
        END IF;
    END IF;

    -- Refunded amount invariants on UPDATE: Cannot decrease
    IF NEW.refunded_amount < OLD.refunded_amount THEN
        RAISE EXCEPTION 'Refunded amount cannot decrease (attempted reduction from ₱% to ₱%).', OLD.refunded_amount, NEW.refunded_amount;
    END IF;

    -- Cannot exceed captured funds
    IF NEW.refunded_amount > NEW.captured_amount THEN
        RAISE EXCEPTION 'Refunded amount (₱%) cannot exceed captured amount (₱%).', NEW.refunded_amount, NEW.captured_amount;
    END IF;

    -- 4. Same-Status Updates & Invariant Protections
    IF OLD.status = NEW.status THEN
        -- Pending, requires_action, or processing payments CANNOT acquire captured funds, captured timestamp, or refunded funds
        IF OLD.status IN ('pending', 'requires_action', 'processing') THEN
            IF NEW.captured_amount IS DISTINCT FROM 0.00 THEN
                RAISE EXCEPTION 'Payment in status "%" cannot acquire captured funds without a valid capture transition (attempted ₱%).',
                    OLD.status, NEW.captured_amount;
            END IF;
            IF NEW.captured_at IS NOT NULL THEN
                RAISE EXCEPTION 'Payment in status "%" cannot set captured_at timestamp.', OLD.status;
            END IF;
            IF NEW.refunded_amount IS DISTINCT FROM 0.00 THEN
                RAISE EXCEPTION 'Payment in status "%" cannot acquire refunded funds.', OLD.status;
            END IF;
        END IF;

        -- If captured, partially_refunded, or disputed: captured_amount is strictly immutable
        IF (OLD.status IN ('captured', 'partially_refunded', 'disputed') OR OLD.captured_amount > 0.00) THEN
            IF NEW.captured_amount IS DISTINCT FROM OLD.captured_amount THEN
                RAISE EXCEPTION 'Captured amount (₱%) is strictly immutable once captured.', OLD.captured_amount;
            END IF;
            IF NEW.captured_at IS DISTINCT FROM OLD.captured_at THEN
                RAISE EXCEPTION 'captured_at timestamp is strictly immutable once captured.';
            END IF;
        END IF;

        -- If refunded_amount changed while status remains unchanged:
        IF NEW.refunded_amount IS DISTINCT FROM OLD.refunded_amount THEN
            IF OLD.status != 'partially_refunded' THEN
                RAISE EXCEPTION 'Refunded amount can only be modified when transitioning to partially_refunded or refunded status.';
            END IF;
            IF NEW.refunded_amount >= NEW.captured_amount THEN
                RAISE EXCEPTION 'Partial refund amount (₱%) cannot reach or exceed captured amount (₱%). Full refund requires status "refunded".',
                    NEW.refunded_amount, NEW.captured_amount;
            END IF;
        END IF;

        NEW.updated_at = now();
        RETURN NEW;
    END IF;

    -- 5. Valid state transition rules
    IF OLD.status = 'pending' THEN
        IF NEW.status NOT IN ('requires_action', 'processing', 'captured', 'failed', 'cancelled') THEN
            RAISE EXCEPTION 'Invalid payment transition: cannot move from pending to %.', NEW.status;
        END IF;
    ELSIF OLD.status = 'requires_action' THEN
        IF NEW.status NOT IN ('processing', 'captured', 'failed', 'cancelled') THEN
            RAISE EXCEPTION 'Invalid payment transition: cannot move from requires_action to %.', NEW.status;
        END IF;
    ELSIF OLD.status = 'processing' THEN
        IF NEW.status NOT IN ('captured', 'failed', 'cancelled') THEN
            RAISE EXCEPTION 'Invalid payment transition: cannot move from processing to %.', NEW.status;
        END IF;
    ELSIF OLD.status = 'captured' THEN
        IF NEW.status NOT IN ('refunded', 'partially_refunded', 'disputed') THEN
            RAISE EXCEPTION 'Invalid payment transition: captured payment cannot transition to %.', NEW.status;
        END IF;
    ELSIF OLD.status = 'partially_refunded' THEN
        IF NEW.status NOT IN ('refunded', 'disputed') THEN
            RAISE EXCEPTION 'Invalid payment transition: partially_refunded payment cannot transition to %.', NEW.status;
        END IF;
    ELSIF OLD.status = 'disputed' THEN
        IF NEW.status NOT IN ('captured', 'refunded') THEN
            RAISE EXCEPTION 'Invalid payment transition: disputed payment cannot transition to %.', NEW.status;
        END IF;
    END IF;

    -- 6. Hardened Invariants on Transition
    IF NEW.status IN ('failed', 'cancelled') THEN
        IF NEW.captured_amount IS DISTINCT FROM 0.00 THEN
            RAISE EXCEPTION 'Payment transitioning to "%" cannot have captured amount (attempted ₱%).',
                NEW.status, NEW.captured_amount;
        END IF;
        IF NEW.captured_at IS NOT NULL THEN
            RAISE EXCEPTION 'Payment transitioning to "%" cannot have captured_at timestamp.', NEW.status;
        END IF;
        IF NEW.refunded_amount IS DISTINCT FROM 0.00 THEN
            RAISE EXCEPTION 'Payment transitioning to "%" cannot have refunded amount.', NEW.status;
        END IF;
    ELSIF NEW.status = 'captured' THEN
        IF NEW.captured_amount IS NULL OR NEW.captured_amount <= 0.00 THEN
            RAISE EXCEPTION 'Explicit verified captured_amount is required when marking payment captured.';
        END IF;
        IF NEW.captured_amount != NEW.expected_amount THEN
            RAISE EXCEPTION 'Captured amount (₱%) must match expected reservation amount (₱%). Partial captures are not permitted.',
                NEW.captured_amount, NEW.expected_amount;
        END IF;
        IF NEW.provider_payment_id IS NULL OR trim(NEW.provider_payment_id) = '' THEN
            RAISE EXCEPTION 'Payment cannot be marked captured without verified provider_payment_id.';
        END IF;
        IF NEW.captured_at IS NULL THEN
            NEW.captured_at := now();
        END IF;
    ELSIF NEW.status = 'refunded' THEN
        IF NEW.refunded_amount IS NULL OR NEW.refunded_amount <= 0.00 THEN
            NEW.refunded_amount := NEW.captured_amount;
        END IF;
        IF NEW.refunded_amount != NEW.captured_amount THEN
            RAISE EXCEPTION 'Full refund requires refunded_amount (₱%) to equal captured_amount (₱%).',
                NEW.refunded_amount, NEW.captured_amount;
        END IF;
    ELSIF NEW.status = 'partially_refunded' THEN
        IF NEW.refunded_amount IS NULL OR NEW.refunded_amount <= 0.00 THEN
            RAISE EXCEPTION 'Partial refund requires positive refunded_amount.';
        END IF;
        IF NEW.refunded_amount >= NEW.captured_amount THEN
            RAISE EXCEPTION 'Partial refund amount (₱%) must be strictly less than captured_amount (₱%). For full refund, status must be "refunded".',
                NEW.refunded_amount, NEW.captured_amount;
        END IF;
    ELSIF NEW.status NOT IN ('partially_refunded', 'refunded') THEN
        IF NEW.refunded_amount IS DISTINCT FROM OLD.refunded_amount THEN
            RAISE EXCEPTION 'Refunded amount can only change when transitioning to partially_refunded or refunded status.';
        END IF;
    END IF;

    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_payment_status_transition ON public.payments;
CREATE TRIGGER trg_validate_payment_status_transition
    BEFORE INSERT OR UPDATE ON public.payments
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_validate_payment_status_transition();


-- ==============================================================================
-- 7. Upgraded Payout Validation Trigger Function (Matching Hardened 005B)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.fn_validate_payout_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_journal_tx RECORD;
    v_reserve_exists BOOLEAN := false;
BEGIN
    -- 1. INSERT-TIME STATUS & LIFECYCLE INITIALIZATION
    IF TG_OP = 'INSERT' THEN
        -- Payouts must strictly begin in pending_request status
        IF NEW.status != 'pending_request' THEN
            RAISE EXCEPTION 'Invalid initial payout status: payout records must be initialized in "pending_request" status (attempted "%"). Direct creation in later lifecycle states is prohibited.', NEW.status;
        END IF;

        IF NEW.reserved_at IS NOT NULL OR NEW.submitted_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Lifecycle timestamps cannot be set at payout creation time.';
        END IF;

        IF NEW.journal_reserve_tx_id IS NOT NULL OR NEW.journal_terminal_tx_id IS NOT NULL THEN
            RAISE EXCEPTION 'Journal transaction references cannot be set at payout creation time.';
        END IF;

        RETURN NEW;
    END IF;

    -- 2. TERMINAL STATE MUTATION PROTECTION
    -- Terminal payouts ('paid', 'failed', 'cancelled') are 100% frozen against ANY update
    IF OLD.status IN ('paid', 'failed', 'cancelled') THEN
        RAISE EXCEPTION 'Payout lifecycle violation: Payout % is in terminal status "%" and cannot be modified.',
            OLD.id, OLD.status;
    END IF;

    -- 3. UPDATE-TIME IMMUTABILITY CHECKS
    -- Enforce immutability of amount, currency, organization_id, and destination method on EVERY update
    IF OLD.organization_id IS DISTINCT FROM NEW.organization_id OR
       OLD.payout_method_id IS DISTINCT FROM NEW.payout_method_id OR
       OLD.amount IS DISTINCT FROM NEW.amount OR
       OLD.currency IS DISTINCT FROM NEW.currency OR
       OLD.created_at IS DISTINCT FROM NEW.created_at OR
       (OLD.provider_payout_id IS NOT NULL AND OLD.provider_payout_id IS DISTINCT FROM NEW.provider_payout_id) OR
       (OLD.provider_reference IS NOT NULL AND OLD.provider_reference IS DISTINCT FROM NEW.provider_reference) OR
       (OLD.journal_reserve_tx_id IS NOT NULL AND OLD.journal_reserve_tx_id IS DISTINCT FROM NEW.journal_reserve_tx_id) THEN
        RAISE EXCEPTION 'Payout amount, currency, organization, destination method, and reserve journal link are strictly immutable once created.';
    END IF;

    -- 4. If status unchanged, validate same-status constraints and exit
    IF OLD.status = NEW.status THEN
        IF OLD.status = 'pending_request' THEN
            IF NEW.journal_reserve_tx_id IS NOT NULL THEN
                RAISE EXCEPTION 'Payout in "pending_request" status cannot set journal_reserve_tx_id without transition to approved_reserved.';
            END IF;
            IF NEW.journal_terminal_tx_id IS NOT NULL THEN
                RAISE EXCEPTION 'Payout in "pending_request" status cannot set journal_terminal_tx_id.';
            END IF;
        ELSIF OLD.status IN ('approved_reserved', 'submitted_to_provider') THEN
            IF NEW.journal_terminal_tx_id IS NOT NULL THEN
                RAISE EXCEPTION 'Payout in "%" status cannot set journal_terminal_tx_id without terminal transition.', OLD.status;
            END IF;
        END IF;

        NEW.updated_at = now();
        RETURN NEW;
    END IF;

    -- 5. Valid state transition rules
    IF OLD.status = 'pending_request' THEN
        IF NEW.status NOT IN ('approved_reserved', 'cancelled', 'failed') THEN
            RAISE EXCEPTION 'Invalid payout transition: cannot move from pending_request to %.', NEW.status;
        END IF;
    ELSIF OLD.status = 'approved_reserved' THEN
        IF NEW.status NOT IN ('submitted_to_provider', 'failed', 'cancelled') THEN
            RAISE EXCEPTION 'Invalid payout transition: cannot move from approved_reserved to %.', NEW.status;
        END IF;
    ELSIF OLD.status = 'submitted_to_provider' THEN
        IF NEW.status NOT IN ('paid', 'failed') THEN
            RAISE EXCEPTION 'Invalid payout transition: cannot move from submitted_to_provider to %.', NEW.status;
        END IF;
    END IF;

    -- 6. MANDATORY JOURNAL LINKAGE & LIFECYCLE STATE VALIDATION
    -- 6a. Transition to 'approved_reserved': requires a valid payout_reserve journal transaction
    IF NEW.status = 'approved_reserved' THEN
        IF NEW.journal_reserve_tx_id IS NULL THEN
            RAISE EXCEPTION 'Payout % cannot transition to "approved_reserved" without a valid payout_reserve journal transaction.',
                NEW.id;
        END IF;

        SELECT transaction_type INTO v_journal_tx
        FROM public.financial_transactions
        WHERE id = NEW.journal_reserve_tx_id AND organization_id = NEW.organization_id;

        IF NOT FOUND OR v_journal_tx.transaction_type != 'payout_reserve' THEN
            RAISE EXCEPTION 'Invalid journal reserve transaction: Must reference an existing financial_transaction of type "payout_reserve" for organization %.',
                NEW.organization_id;
        END IF;

        IF NEW.journal_terminal_tx_id IS NOT NULL THEN
            RAISE EXCEPTION 'Payout transitioning to "approved_reserved" cannot have journal_terminal_tx_id set.';
        END IF;
    END IF;

    -- 6b. Transition to 'submitted_to_provider': preserves reserve journal, terminal journal must be NULL
    IF NEW.status = 'submitted_to_provider' THEN
        IF NEW.journal_reserve_tx_id IS NULL THEN
            RAISE EXCEPTION 'Payout % in "submitted_to_provider" must have an active journal_reserve_tx_id.', NEW.id;
        END IF;
        IF NEW.journal_terminal_tx_id IS NOT NULL THEN
            RAISE EXCEPTION 'Payout in "submitted_to_provider" cannot have journal_terminal_tx_id set.';
        END IF;
    END IF;

    -- 6c. Transition to 'paid': requires valid payout_disbursement journal transaction
    IF NEW.status = 'paid' THEN
        IF NEW.journal_reserve_tx_id IS NULL THEN
            RAISE EXCEPTION 'Payout % cannot transition to "paid" without existing journal_reserve_tx_id.', NEW.id;
        END IF;

        IF NEW.journal_terminal_tx_id IS NULL THEN
            RAISE EXCEPTION 'Payout % cannot transition to "paid" without a valid payout_disbursement journal transaction.',
                NEW.id;
        END IF;

        SELECT transaction_type INTO v_journal_tx
        FROM public.financial_transactions
        WHERE id = NEW.journal_terminal_tx_id AND organization_id = NEW.organization_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Referenced terminal journal transaction % not found for organization %.',
                NEW.journal_terminal_tx_id, NEW.organization_id;
        END IF;

        IF v_journal_tx.transaction_type != 'payout_disbursement' THEN
            RAISE EXCEPTION 'Terminal journal mismatch: Successful paid payout must reference transaction type "payout_disbursement" (got "%").',
                v_journal_tx.transaction_type;
        END IF;
    END IF;

    -- 6d. Transition to 'failed' or 'cancelled': distinguish whether reserve existed
    IF NEW.status IN ('failed', 'cancelled') THEN
        v_reserve_exists := (OLD.status IN ('approved_reserved', 'submitted_to_provider') OR OLD.journal_reserve_tx_id IS NOT NULL);

        IF v_reserve_exists THEN
            -- Funds were locked in Account 2015 reserve; must have payout_failed_release journal to restore to 2011
            IF NEW.journal_terminal_tx_id IS NULL THEN
                RAISE EXCEPTION 'Reserved payout % transitioning to "%" requires a valid payout_failed_release journal transaction to release reserved funds.',
                    NEW.id, NEW.status;
            END IF;

            SELECT transaction_type INTO v_journal_tx
            FROM public.financial_transactions
            WHERE id = NEW.journal_terminal_tx_id AND organization_id = NEW.organization_id;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Referenced terminal journal transaction % not found for organization %.',
                    NEW.journal_terminal_tx_id, NEW.organization_id;
            END IF;

            IF v_journal_tx.transaction_type != 'payout_failed_release' THEN
                RAISE EXCEPTION 'Terminal journal mismatch: Failed/cancelled payout with active reserve must reference transaction type "payout_failed_release" (got "%").',
                    v_journal_tx.transaction_type;
            END IF;
        ELSE
            -- No funds were ever reserved (e.g. cancelled/failed directly from pending_request)
            IF NEW.journal_terminal_tx_id IS NOT NULL THEN
                RAISE EXCEPTION 'Unreserved payout % transitioning to "%" cannot specify a terminal release journal.',
                    NEW.id, NEW.status;
            END IF;
            IF NEW.journal_reserve_tx_id IS NOT NULL THEN
                RAISE EXCEPTION 'Unreserved payout % transitioning to "%" cannot specify a reserve journal.',
                    NEW.id, NEW.status;
            END IF;
        END IF;
    END IF;

    -- 7. Timestamp Maintenance
    IF NEW.status = 'approved_reserved' AND NEW.reserved_at IS NULL THEN
        NEW.reserved_at := now();
    ELSIF NEW.status = 'submitted_to_provider' AND NEW.submitted_at IS NULL THEN
        NEW.submitted_at := now();
    ELSIF NEW.status = 'paid' AND NEW.completed_at IS NULL THEN
        NEW.completed_at := now();
    ELSIF NEW.status IN ('failed', 'cancelled') AND NEW.failed_at IS NULL THEN
        NEW.failed_at := now();
    END IF;

    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_payout_status_transition ON public.payouts;
CREATE TRIGGER trg_validate_payout_status_transition
    BEFORE INSERT OR UPDATE ON public.payouts
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_validate_payout_status_transition();

-- 7b. Payout Lifecycle Audit Logging Trigger
CREATE OR REPLACE FUNCTION public.fn_audit_payout_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.payout_lifecycle_logs (
            payout_id, organization_id, from_status, to_status, trigger_source, metadata
        ) VALUES (
            NEW.id, NEW.organization_id, NULL, NEW.status, 'payout_create',
            jsonb_build_object('amount', NEW.amount, 'currency', NEW.currency)
        );
    ELSIF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
        INSERT INTO public.payout_lifecycle_logs (
            payout_id, organization_id, from_status, to_status, trigger_source, metadata
        ) VALUES (
            NEW.id, NEW.organization_id, OLD.status, NEW.status, 'status_transition',
            jsonb_build_object('amount', NEW.amount, 'provider_payout_id', NEW.provider_payout_id)
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_payout_lifecycle ON public.payouts;
CREATE TRIGGER trg_audit_payout_lifecycle
    AFTER INSERT OR UPDATE ON public.payouts
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_audit_payout_lifecycle();


-- ==============================================================================
-- 8. Safe Masked Payout Methods Projection View
-- ==============================================================================
CREATE OR REPLACE VIEW public.v_masked_payout_methods
WITH (security_invoker = true)
AS
SELECT
    id,
    organization_id,
    method_type,
    provider_name,
    account_holder_name,
    masked_account_number,
    bank_code,
    bank_name,
    is_active,
    is_default,
    verification_status,
    created_at,
    updated_at
FROM public.payout_methods;

COMMENT ON VIEW public.v_masked_payout_methods IS 'Safe projection of payout destinations omitting provider_recipient_token.';


-- ==============================================================================
-- 9. Row-Level Security (RLS) & Client Permission Hardening
-- ==============================================================================
ALTER TABLE public.platform_fee_policy_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_lifecycle_logs ENABLE ROW LEVEL SECURITY;

-- Revoke all direct client write access
REVOKE INSERT, UPDATE, DELETE ON public.platform_fee_policy_controls FROM anon, authenticated, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.payments FROM anon, authenticated, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.provider_webhook_events FROM anon, authenticated, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.settlement_batches FROM anon, authenticated, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.settlement_items FROM anon, authenticated, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.payout_methods FROM anon, authenticated, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.payouts FROM anon, authenticated, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.payout_lifecycle_logs FROM anon, authenticated, PUBLIC;

-- Revoke webhook inbox and settlement tables read access from anon and authenticated (backend only)
REVOKE SELECT ON public.provider_webhook_events FROM anon, authenticated, PUBLIC;
REVOKE SELECT ON public.settlement_batches FROM anon, authenticated, PUBLIC;
REVOKE SELECT ON public.settlement_items FROM anon, authenticated, PUBLIC;

-- Payout Token Confidentiality:
-- Remove unrestricted table-level SELECT on public.payout_methods
REVOKE SELECT ON public.payout_methods FROM anon, authenticated, PUBLIC;

-- Grant column-level SELECT ONLY on safe, non-sensitive columns
GRANT SELECT (
    id,
    organization_id,
    method_type,
    provider_name,
    account_holder_name,
    masked_account_number,
    bank_code,
    bank_name,
    is_active,
    is_default,
    verification_status,
    created_at,
    updated_at
) ON public.payout_methods TO authenticated;

-- Grant SELECT on safe masked projection view
GRANT SELECT ON public.v_masked_payout_methods TO authenticated;

-- Grant selective SELECT permissions on remaining client-accessible tables
GRANT SELECT ON public.platform_fee_policy_controls TO authenticated;
GRANT SELECT ON public.payments TO authenticated;
GRANT SELECT ON public.payouts TO authenticated;
GRANT SELECT ON public.payout_lifecycle_logs TO authenticated;

-- Drop and recreate RLS policies to guarantee authoritative definition
DROP POLICY IF EXISTS rls_fee_policy_select ON public.platform_fee_policy_controls;
CREATE POLICY rls_fee_policy_select ON public.platform_fee_policy_controls
    FOR SELECT TO authenticated USING (true);

-- Payments RLS: Staff, admins, and owners can view booking payments for their organization
DROP POLICY IF EXISTS rls_payments_select ON public.payments;
CREATE POLICY rls_payments_select ON public.payments
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid()
        )
    );

-- Payout Methods Security: Restrict to verified owner/admin financial roles only!
DROP POLICY IF EXISTS rls_payout_methods_select ON public.payout_methods;
CREATE POLICY rls_payout_methods_select ON public.payout_methods
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
        )
    );

-- Payouts Security: Restrict to verified owner/admin financial roles only!
DROP POLICY IF EXISTS rls_payouts_select ON public.payouts;
CREATE POLICY rls_payouts_select ON public.payouts
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
        )
    );

-- Payout Lifecycle Audit Logs: Restrict to verified owner/admin financial roles only!
DROP POLICY IF EXISTS rls_payout_lifecycle_select ON public.payout_lifecycle_logs;
CREATE POLICY rls_payout_lifecycle_select ON public.payout_lifecycle_logs
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
        )
    );

-- Default deny policies for internal backend tables
DROP POLICY IF EXISTS rls_webhooks_deny ON public.provider_webhook_events;
CREATE POLICY rls_webhooks_deny ON public.provider_webhook_events
    FOR ALL TO PUBLIC USING (false);

DROP POLICY IF EXISTS rls_settlement_batches_deny ON public.settlement_batches;
CREATE POLICY rls_settlement_batches_deny ON public.settlement_batches
    FOR ALL TO PUBLIC USING (false);

DROP POLICY IF EXISTS rls_settlement_items_deny ON public.settlement_items;
CREATE POLICY rls_settlement_items_deny ON public.settlement_items
    FOR ALL TO PUBLIC USING (false);


-- ==============================================================================
-- 10. Integration Boundaries: Preserve Revocation of Journal Procedures
-- ==============================================================================
REVOKE ALL ON FUNCTION public.post_booking_settlement_event(uuid,uuid,uuid,numeric,numeric,text,jsonb) FROM anon, authenticated, service_role, PUBLIC;
REVOKE ALL ON FUNCTION public.post_funds_cleared_event(uuid,uuid,numeric,text,text,jsonb) FROM anon, authenticated, service_role, PUBLIC;
REVOKE ALL ON FUNCTION public.post_refund_reversal_event(uuid,uuid,uuid,numeric,numeric,text,jsonb) FROM anon, authenticated, service_role, PUBLIC;
REVOKE ALL ON FUNCTION public.post_chargeback_adjustment_event(uuid,uuid,uuid,numeric,numeric,numeric,text,jsonb) FROM anon, authenticated, service_role, PUBLIC;
REVOKE ALL ON FUNCTION public.post_gateway_fee_assessment_event(uuid,uuid,uuid,numeric,text,text,jsonb) FROM anon, authenticated, service_role, PUBLIC;
REVOKE ALL ON FUNCTION public.post_payout_reserve_event(uuid,uuid,numeric,text,jsonb) FROM anon, authenticated, service_role, PUBLIC;
REVOKE ALL ON FUNCTION public.post_payout_disbursement_event(uuid,uuid,numeric,text,jsonb) FROM anon, authenticated, service_role, PUBLIC;
REVOKE ALL ON FUNCTION public.post_payout_failed_release_event(uuid,uuid,numeric,text,jsonb) FROM anon, authenticated, service_role, PUBLIC;
REVOKE ALL ON FUNCTION public.post_journal_entry_internal(uuid,uuid,varchar,text,uuid,text,jsonb,jsonb) FROM anon, authenticated, service_role, PUBLIC;


-- ==============================================================================
-- 11. Post-Migration Verification & Sanity Assertion
-- ==============================================================================
DO $$
DECLARE
    v_payment_count INT;
    v_missing_con TEXT;
BEGIN
    RAISE NOTICE '=== 005b1 Migration: Running Post-Upgrade Integrity Assertions ===';

    -- Verify the 2 existing payment records are preserved
    SELECT count(*) INTO v_payment_count FROM public.payments;
    IF v_payment_count < 2 THEN
        RAISE EXCEPTION 'Post-Migration Failure: Existing payments count dropped from >= 2 to %!', v_payment_count;
    END IF;

    -- Verify that all required constraints exist on payouts
    FOREACH v_missing_con IN ARRAY ARRAY[
        'uq_payouts_id_org', 'fk_payouts_method_org',
        'fk_payouts_journal_reserve_org', 'fk_payouts_journal_terminal_org'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = v_missing_con AND conrelid = 'public.payouts'::regclass
        ) THEN
            RAISE EXCEPTION 'Post-Migration Failure: Constraint % missing on public.payouts.', v_missing_con;
        END IF;
    END LOOP;

    -- Verify composite FK on payout_lifecycle_logs
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_payout_lifecycle_logs_payout_org'
          AND conrelid = 'public.payout_lifecycle_logs'::regclass
    ) THEN
        RAISE EXCEPTION 'Post-Migration Failure: fk_payout_lifecycle_logs_payout_org missing on public.payout_lifecycle_logs.';
    END IF;

    -- Verify triggers
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_protect_payout_lifecycle_logs_immutability'
          AND tgrelid = 'public.payout_lifecycle_logs'::regclass
    ) THEN
        RAISE EXCEPTION 'Post-Migration Failure: trg_protect_payout_lifecycle_logs_immutability missing on public.payout_lifecycle_logs.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_validate_payment_status_transition'
          AND tgrelid = 'public.payments'::regclass
    ) THEN
        RAISE EXCEPTION 'Post-Migration Failure: trg_validate_payment_status_transition missing on public.payments.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_validate_payout_status_transition'
          AND tgrelid = 'public.payouts'::regclass
    ) THEN
        RAISE EXCEPTION 'Post-Migration Failure: trg_validate_payout_status_transition missing on public.payouts.';
    END IF;

    RAISE NOTICE 'Post-Migration Verification: All constraints, triggers, and % existing payment records verified successfully.', v_payment_count;
END $$;

COMMIT;
