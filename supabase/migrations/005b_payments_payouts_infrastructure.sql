-- ==============================================================================
-- CourtBook / BookSuite — Database Schema Migration
-- Migration: 005b_payments_payouts_infrastructure.sql
-- Description: Phase 4.2.3 Payment & Payout Infrastructure (Hardened Security Edition)
--
-- FOUNDATION:
--   Built upon Migrations 001 through 005A, 005a1, and 005a2.
--   Preserves the 5% platform commission rate and 11-account double-entry journal foundation.
--
-- OBJECTIVES & SECURITY REVIEW CORRECTIONS (PHASE 4.2.3):
--   1. Payment Evidence Immutability & Provider Identity:
--      - Protects provider_payment_id, provider_payment_intent_id, checkout_session_id,
--        and capture_idempotency_key once bound.
--      - Enforces that verified_capture_evidence cannot have established keys removed/altered.
--      - Preserves initial checkout binding workflow executed by 005C.
--   2. Authoritative Commission Snapshot Validation:
--      - Validates commission_rate, commission_amount, and owner_gross_share at payment creation
--        against platform_billing_config (5% standard rate).
--   3. Composite Cross-Tenant Payout & Audit Integrity:
--      - payouts.payout_method_id must belong to payouts.organization_id.
--      - payout_lifecycle_logs composite FK enforces organization consistency with payouts.
--      - payouts journal reserve/terminal links enforce organization consistency with financial_transactions.
--   4. Terminal Record & Transition Finality:
--      - Unconditional freeze on terminal payments ('failed', 'cancelled', 'refunded') and
--        terminal payouts ('paid', 'failed', 'cancelled') against ANY update.
--      - Same-status updates on terminal records strictly prohibited.
--   5. Append-Only Payout Audit Trail:
--      - payout_lifecycle_logs is made strictly append-only with unconditional BEFORE UPDATE OR DELETE trigger.
--   6. Hardened Financial SELECT Policies:
--      - Payout methods, payouts, and payout lifecycle logs restricted strictly to verified
--        'owner' and 'admin' roles. Ordinary staff cannot access sensitive financial disbursement data.
--   7. Webhook Evidence Immutability:
--      - Raw payload, payload_hash, signature_header, and timestamps strictly protected.
--   8. Zero-Trust Procedure Access:
--      - Direct execution of financial journal procedures remains REVOKED from client/application roles.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. Platform Fee Policy Controls (Preserving Undecided Policy Decisions)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.platform_fee_policy_controls (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- Strict singleton table
    gateway_processing_fee_policy VARCHAR(50) NOT NULL DEFAULT 'undecided'
        CHECK (gateway_processing_fee_policy IN ('undecided', 'absorbed_by_platform', 'deducted_from_owner')),
    payout_transfer_fee_policy VARCHAR(50) NOT NULL DEFAULT 'undecided'
        CHECK (payout_transfer_fee_policy IN ('undecided', 'absorbed_by_platform', 'deducted_from_owner')),
    provisional_gateway_rate NUMERIC(5, 4) NOT NULL DEFAULT 0.0350
        CHECK (provisional_gateway_rate >= 0.0000 AND provisional_gateway_rate <= 0.2000),
    provisional_gateway_fixed NUMERIC(10, 2) NOT NULL DEFAULT 15.00
        CHECK (provisional_gateway_fixed >= 0.00),
    provisional_payout_fee NUMERIC(10, 2) NOT NULL DEFAULT 25.00
        CHECK (provisional_payout_fee >= 0.00),
    policy_notes TEXT NOT NULL DEFAULT 'Decisions regarding gateway processing fees and payout transfer fees remain unresolved. Fees are tracked per payment and payout but are not billed to guests or silently deducted from owners until an authoritative policy is configured.',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.platform_fee_policy_controls IS 'Tracks fee allocation policies while preserving undecided gateway and payout fee bearer rules.';

INSERT INTO public.platform_fee_policy_controls (
    id,
    gateway_processing_fee_policy,
    payout_transfer_fee_policy,
    provisional_gateway_rate,
    provisional_gateway_fixed,
    provisional_payout_fee
) VALUES (
    1,
    'undecided',
    'undecided',
    0.0350,
    15.00,
    25.00
) ON CONFLICT (id) DO NOTHING;


-- ==============================================================================
-- 2. Authoritative Payments Table
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE RESTRICT,
    reservation_id UUID NOT NULL REFERENCES public.reservations(id) ON DELETE RESTRICT,
    checkout_session_id VARCHAR(255),
    provider_name VARCHAR(50) NOT NULL DEFAULT 'paymongo'
        CHECK (provider_name IN ('paymongo', 'xendit', 'manual_test')),
    provider_payment_id VARCHAR(255),
    provider_payment_intent_id VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending',
            'requires_action',
            'processing',
            'captured',
            'failed',
            'cancelled',
            'refunded',
            'partially_refunded',
            'disputed'
        )),
    currency VARCHAR(10) NOT NULL DEFAULT 'PHP'
        CHECK (currency IN ('PHP', '₱')),
    expected_amount NUMERIC(10, 2) NOT NULL
        CHECK (expected_amount > 0.00),
    captured_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00
        CHECK (captured_amount >= 0.00),
    refunded_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00
        CHECK (refunded_amount >= 0.00),
    CONSTRAINT chk_payments_refunded_le_captured
        CHECK (refunded_amount <= captured_amount),
    
    -- Immutable Financial Snapshot
    commission_rate NUMERIC(5, 4) NOT NULL DEFAULT 0.0500
        CHECK (commission_rate >= 0.0000 AND commission_rate <= 1.0000),
    commission_amount NUMERIC(10, 2) NOT NULL
        CHECK (commission_amount >= 0.00),
    owner_gross_share NUMERIC(10, 2) NOT NULL
        CHECK (owner_gross_share >= 0.00),

    -- Gateway Processing Fee Tracking (Allocation Unresolved)
    provider_fee_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00
        CHECK (provider_fee_amount >= 0.00),
    fee_allocation_status VARCHAR(50) NOT NULL DEFAULT 'undecided'
        CHECK (fee_allocation_status IN ('undecided', 'absorbed_by_platform', 'deducted_from_owner')),

    -- Evidence & Idempotency
    verified_capture_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    capture_idempotency_key VARCHAR(255),

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    captured_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,

    -- Composite Tenant Integrity Constraints (leveraging composite keys established in 005A)
    CONSTRAINT fk_payments_facility_org
        FOREIGN KEY (facility_id, organization_id)
        REFERENCES public.facilities(id, organization_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_payments_reservation_facility
        FOREIGN KEY (reservation_id, facility_id)
        REFERENCES public.reservations(id, facility_id)
        ON DELETE RESTRICT,

    -- Exact Centavo Allocation Invariant
    CONSTRAINT chk_payment_amount_split
        CHECK (expected_amount = (commission_amount + owner_gross_share)),

    -- Composite uniqueness for settlement item linkage
    CONSTRAINT uq_payments_id_org_facility
        UNIQUE (id, organization_id, facility_id)
);

COMMENT ON TABLE public.payments IS 'Authoritative online payment records for court reservations with composite tenant protection.';

-- Unique provider payment ID constraint when provider_payment_id is present
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_payment_id
    ON public.payments (provider_name, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;

-- Unique provider payment intent ID constraint when provider_payment_intent_id is present
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_intent_id
    ON public.payments (provider_name, provider_payment_intent_id)
    WHERE provider_payment_intent_id IS NOT NULL;

-- Permanent capture uniqueness constraint across full lifecycle:
-- Prevents duplicate captured payments per reservation across captured, refunded, partially_refunded, and disputed states.
CREATE UNIQUE INDEX IF NOT EXISTS uq_captured_payment_lifecycle_per_reservation
    ON public.payments (reservation_id)
    WHERE status IN ('captured', 'partially_refunded', 'refunded', 'disputed');

CREATE INDEX IF NOT EXISTS idx_payments_org_status ON public.payments (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_checkout_session ON public.payments (checkout_session_id);


-- Hardened Payment Validation & Immutability Trigger (Runs BEFORE INSERT OR UPDATE)
CREATE OR REPLACE FUNCTION public.fn_validate_payment_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
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

        IF v_config_comm_rate IS NOT NULL AND NEW.commission_rate IS DISTINCT FROM v_config_comm_rate THEN
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

    -- Captured amount is strictly immutable once captured (including same-status updates)
    IF (OLD.status IN ('captured', 'partially_refunded', 'disputed') OR OLD.captured_amount > 0.00) THEN
        IF NEW.captured_amount IS DISTINCT FROM OLD.captured_amount THEN
            RAISE EXCEPTION 'Captured amount (₱%) is strictly immutable once captured.', OLD.captured_amount;
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

    -- 4. If status unchanged, validate same-status constraints and exit
    IF OLD.status = NEW.status THEN
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

    -- 6. Hardened Captured Evidence Invariants (do NOT silently default captured_amount)
    IF NEW.status = 'captured' THEN
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
    END IF;

    -- 7. Hardened Refund Transition Invariants
    IF NEW.status = 'refunded' THEN
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
-- 3. Append-Only Provider Webhook Event Inbox
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.provider_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_name VARCHAR(50) NOT NULL
        CHECK (provider_name IN ('paymongo', 'xendit', 'manual_test')),
    provider_event_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    signature_verification_status VARCHAR(50) NOT NULL DEFAULT 'unverified'
        CHECK (signature_verification_status IN ('unverified', 'verified', 'failed')),
    signature_header TEXT,
    payload_hash CHAR(64),
    processing_state VARCHAR(50) NOT NULL DEFAULT 'pending'
        CHECK (processing_state IN ('pending', 'processing', 'processed', 'failed', 'ignored_duplicate')),
    retry_count INT NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    last_error TEXT,
    processed_at TIMESTAMPTZ,
    event_timestamp TIMESTAMPTZ,
    
    -- Minimized Raw Payload
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT uq_webhook_provider_event UNIQUE (provider_name, provider_event_id)
);

COMMENT ON TABLE public.provider_webhook_events IS 'Append-only inbox for payment provider webhooks with server-side signature tracking.';

CREATE INDEX IF NOT EXISTS idx_webhook_state ON public.provider_webhook_events (processing_state, received_at);

-- Webhook Evidence Immutability Trigger:
-- Strictly protects identity, received_at, event_timestamp, signature evidence, payload, and payload_hash.
-- Allows trusted mutability only for processing_state, retry_count, last_error, and processed_at.
CREATE OR REPLACE FUNCTION public.fn_protect_webhook_inbox_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
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
-- 4. Settlement Reconciliation Infrastructure
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.settlement_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_name VARCHAR(50) NOT NULL
        CHECK (provider_name IN ('paymongo', 'xendit', 'manual_test')),
    provider_batch_id VARCHAR(255) NOT NULL,
    settlement_date DATE NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'PHP'
        CHECK (currency IN ('PHP', '₱')),
    total_gross_amount NUMERIC(10, 2) NOT NULL CHECK (total_gross_amount >= 0.00),
    total_net_amount NUMERIC(10, 2) NOT NULL CHECK (total_net_amount >= 0.00),
    total_fee_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (total_fee_amount >= 0.00),
    status VARCHAR(50) NOT NULL DEFAULT 'pending_reconciliation'
        CHECK (status IN ('pending_reconciliation', 'reconciled', 'discrepancy_detected')),
    discrepancy_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    verified_at TIMESTAMPTZ,
    reconciled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_settlement_batch_provider UNIQUE (provider_name, provider_batch_id)
);

COMMENT ON TABLE public.settlement_batches IS 'Provider payout/settlement batches for bank clearing verification.';

CREATE TABLE IF NOT EXISTS public.settlement_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES public.settlement_batches(id) ON DELETE CASCADE,
    payment_id UUID REFERENCES public.payments(id) ON DELETE RESTRICT,
    provider_payment_id VARCHAR(255) NOT NULL,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE RESTRICT,
    gross_amount NUMERIC(10, 2) NOT NULL CHECK (gross_amount > 0.00),
    provider_fee_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (provider_fee_amount >= 0.00),
    net_settled_amount NUMERIC(10, 2) NOT NULL CHECK (net_settled_amount >= 0.00),
    settlement_status VARCHAR(50) NOT NULL DEFAULT 'matched'
        CHECK (settlement_status IN ('matched', 'mismatched_amount', 'missing_payment', 'duplicate')),
    journal_transaction_id UUID REFERENCES public.financial_transactions(id) ON DELETE RESTRICT,
    reconciled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Composite tenant constraint for facility ownership
    CONSTRAINT fk_settlement_items_facility_org
        FOREIGN KEY (facility_id, organization_id)
        REFERENCES public.facilities(id, organization_id)
        ON DELETE RESTRICT,

    -- Composite cross-tenant settlement constraint:
    -- When payment_id is linked, it MUST match the exact organization and facility of the payment!
    CONSTRAINT fk_settlement_items_payment_org_fac
        FOREIGN KEY (payment_id, organization_id, facility_id)
        REFERENCES public.payments(id, organization_id, facility_id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE public.settlement_items IS 'Line items in provider settlements matched against captured payments.';

CREATE INDEX IF NOT EXISTS idx_settlement_items_batch ON public.settlement_items (batch_id);
CREATE INDEX IF NOT EXISTS idx_settlement_items_payment ON public.settlement_items (payment_id);
CREATE INDEX IF NOT EXISTS idx_settlement_items_provider_payment ON public.settlement_items (provider_payment_id);


-- ==============================================================================
-- 5. Owner Payout Infrastructure
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.payout_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    method_type VARCHAR(50) NOT NULL DEFAULT 'bank_transfer'
        CHECK (method_type IN ('bank_transfer', 'e_wallet', 'custom')),
    provider_name VARCHAR(50) NOT NULL DEFAULT 'paymongo'
        CHECK (provider_name IN ('paymongo', 'xendit', 'manual_test')),
    provider_recipient_token VARCHAR(255),
    account_holder_name VARCHAR(255) NOT NULL,
    masked_account_number VARCHAR(50) NOT NULL,
    bank_code VARCHAR(50) NOT NULL,
    bank_name VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_default BOOLEAN NOT NULL DEFAULT false,
    verification_status VARCHAR(50) NOT NULL DEFAULT 'pending'
        CHECK (verification_status IN ('pending', 'verified', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Sensitive Data Protection Constraint: Never store unmasked plain bank accounts
    CONSTRAINT chk_masked_account_number
        CHECK (masked_account_number ~ '^(\*{4,}|[X]{4,})[0-9A-Za-z]{3,6}$'),

    -- Composite uniqueness for cross-tenant payout constraint
    CONSTRAINT uq_payout_methods_id_org
        UNIQUE (id, organization_id)
);

COMMENT ON TABLE public.payout_methods IS 'Tokenized owner bank and payout destination methods with masked account numbers.';

CREATE INDEX IF NOT EXISTS idx_payout_methods_org ON public.payout_methods (organization_id, is_active);


CREATE TABLE IF NOT EXISTS public.payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    payout_method_id UUID NOT NULL,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0.00),
    currency VARCHAR(10) NOT NULL DEFAULT 'PHP'
        CHECK (currency IN ('PHP', '₱')),
    status VARCHAR(50) NOT NULL DEFAULT 'pending_request'
        CHECK (status IN (
            'pending_request',
            'approved_reserved',
            'submitted_to_provider',
            'paid',
            'failed',
            'cancelled'
        )),
    provider_payout_id VARCHAR(255),
    provider_reference VARCHAR(255),
    failure_reason TEXT,
    failure_code VARCHAR(100),
    
    -- Payout Transfer Fee Tracking (Allocation Unresolved)
    provider_transfer_fee NUMERIC(10, 2) NOT NULL DEFAULT 0.00
        CHECK (provider_transfer_fee >= 0.00),
    fee_allocation_status VARCHAR(50) NOT NULL DEFAULT 'undecided'
        CHECK (fee_allocation_status IN ('undecided', 'absorbed_by_platform', 'deducted_from_owner')),

    -- Journal Links with Composite Tenant Integrity (matches uq_financial_tx_id_org from 005a1)
    journal_reserve_tx_id UUID,
    journal_terminal_tx_id UUID,

    -- Timestamps
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reserved_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Composite Cross-Tenant Payout Method Foreign Key
    CONSTRAINT fk_payouts_method_org
        FOREIGN KEY (payout_method_id, organization_id)
        REFERENCES public.payout_methods(id, organization_id)
        ON DELETE RESTRICT,

    -- Composite Cross-Tenant Journal Foreign Keys
    CONSTRAINT fk_payouts_journal_reserve_org
        FOREIGN KEY (journal_reserve_tx_id, organization_id)
        REFERENCES public.financial_transactions(id, organization_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_payouts_journal_terminal_org
        FOREIGN KEY (journal_terminal_tx_id, organization_id)
        REFERENCES public.financial_transactions(id, organization_id)
        ON DELETE RESTRICT,

    -- Composite Uniqueness for Payout Lifecycle Logs
    CONSTRAINT uq_payouts_id_org
        UNIQUE (id, organization_id)
);

COMMENT ON TABLE public.payouts IS 'Owner disbursement records enforcing composite tenant destination and terminal finality.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_provider_payout_id
    ON public.payouts (provider_payout_id)
    WHERE provider_payout_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payouts_org_status ON public.payouts (organization_id, status);


-- Payout Lifecycle Audit Log (Composite Organization Consistency)
CREATE TABLE IF NOT EXISTS public.payout_lifecycle_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payout_id UUID NOT NULL,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    trigger_source VARCHAR(100) NOT NULL DEFAULT 'system',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Composite Foreign Key strictly enforcing organization consistency with referenced payout
    CONSTRAINT fk_payout_lifecycle_logs_payout_org
        FOREIGN KEY (payout_id, organization_id)
        REFERENCES public.payouts(id, organization_id)
        ON DELETE CASCADE
);

COMMENT ON TABLE public.payout_lifecycle_logs IS 'Immutable audit log of all payout status transitions with composite organization consistency.';

CREATE INDEX IF NOT EXISTS idx_payout_lifecycle_payout ON public.payout_lifecycle_logs (payout_id, created_at);


-- Unconditional Append-Only Protection for Payout Lifecycle Logs
CREATE OR REPLACE FUNCTION public.fn_protect_payout_lifecycle_logs_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
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


-- Payout State Machine & Immutability Trigger (Runs BEFORE INSERT OR UPDATE)
CREATE OR REPLACE FUNCTION public.fn_validate_payout_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_journal_tx RECORD;
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

    -- 4. Journal Reference Transaction Type Validation
    IF NEW.journal_reserve_tx_id IS NOT NULL AND (OLD.journal_reserve_tx_id IS NULL OR OLD.journal_reserve_tx_id != NEW.journal_reserve_tx_id) THEN
        SELECT transaction_type INTO v_journal_tx
        FROM public.financial_transactions
        WHERE id = NEW.journal_reserve_tx_id AND organization_id = NEW.organization_id;

        IF NOT FOUND OR v_journal_tx.transaction_type != 'payout_reserve' THEN
            RAISE EXCEPTION 'Invalid journal reserve transaction: Must reference an existing financial_transaction of type "payout_reserve" for organization %.',
                NEW.organization_id;
        END IF;
    END IF;

    IF NEW.journal_terminal_tx_id IS NOT NULL AND (OLD.journal_terminal_tx_id IS NULL OR OLD.journal_terminal_tx_id != NEW.journal_terminal_tx_id) THEN
        SELECT transaction_type INTO v_journal_tx
        FROM public.financial_transactions
        WHERE id = NEW.journal_terminal_tx_id AND organization_id = NEW.organization_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Referenced terminal journal transaction % not found for organization %.',
                NEW.journal_terminal_tx_id, NEW.organization_id;
        END IF;

        IF NEW.status = 'paid' AND v_journal_tx.transaction_type != 'payout_disbursement' THEN
            RAISE EXCEPTION 'Terminal journal mismatch: Successful paid payout must reference transaction type "payout_disbursement" (got "%").',
                v_journal_tx.transaction_type;
        ELSIF NEW.status IN ('failed', 'cancelled') AND v_journal_tx.transaction_type != 'payout_failed_release' THEN
            RAISE EXCEPTION 'Terminal journal mismatch: Failed/cancelled payout must reference transaction type "payout_failed_release" (got "%").',
                v_journal_tx.transaction_type;
        END IF;
    END IF;

    -- If status unchanged, update timestamp and exit
    IF OLD.status = NEW.status THEN
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

    -- Set transition timestamps
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


-- Payout Lifecycle Audit Logging Trigger (Runs AFTER INSERT OR UPDATE)
CREATE OR REPLACE FUNCTION public.fn_audit_payout_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
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
-- 6. Safe Masked Payout Methods Projection View
-- ==============================================================================
-- Masks provider_recipient_token and sensitive provider credentials from table-level SELECT.
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
-- 7. Row-Level Security (RLS) & Client Permission Hardening
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

-- RLS Policies
CREATE POLICY rls_fee_policy_select ON public.platform_fee_policy_controls
    FOR SELECT TO authenticated USING (true);

-- Payments RLS: Staff, admins, and owners can view booking payments for their organization
CREATE POLICY rls_payments_select ON public.payments
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid()
        )
    );

-- Payout Methods Security: Restrict to verified owner/admin financial roles only!
-- Ordinary staff members cannot SELECT payout methods.
CREATE POLICY rls_payout_methods_select ON public.payout_methods
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
        )
    );

-- Payouts Security: Restrict to verified owner/admin financial roles only!
-- Ordinary staff members cannot SELECT sensitive disbursement payouts.
CREATE POLICY rls_payouts_select ON public.payouts
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
        )
    );

-- Payout Lifecycle Audit Logs: Restrict to verified owner/admin financial roles only!
CREATE POLICY rls_payout_lifecycle_select ON public.payout_lifecycle_logs
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
        )
    );

-- Default deny policies for internal backend tables
CREATE POLICY rls_webhooks_deny ON public.provider_webhook_events
    FOR ALL TO PUBLIC USING (false);

CREATE POLICY rls_settlement_batches_deny ON public.settlement_batches
    FOR ALL TO PUBLIC USING (false);

CREATE POLICY rls_settlement_items_deny ON public.settlement_items
    FOR ALL TO PUBLIC USING (false);


-- ==============================================================================
-- 8. Integration Boundaries: Preserve Revocation of Journal Procedures
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

COMMIT;
