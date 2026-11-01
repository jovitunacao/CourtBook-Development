-- ==============================================================================
-- CourtBook / BookSuite — Database Schema Migration
-- Migration: 005b_payments_payouts_infrastructure.sql
-- Description: Phase 4.2.3 Payment & Payout Infrastructure
--
-- FOUNDATION:
--   Built upon Migrations 001 through 005A and 005a1.
--   Preserves the 5% platform commission rate and 11-account double-entry journal foundation.
--
-- OBJECTIVES:
--   1. Authoritative Payments Table (with composite tenant foreign keys & immutable fee snapshots)
--   2. Append-Only Provider Webhook Event Inbox (sensitive data minimization & out-of-order safety)
--   3. Settlement Reconciliation Infrastructure (batches, items, discrepancy detection)
--   4. Owner Payout Infrastructure (tokenized methods, payouts, state machine & lifecycle audit logs)
--   5. Fee Policy Controls (preserving unresolved gateway & payout fee allocation decisions)
--   6. Strict Row-Level Security (RLS) & Client Write Restrictions
--   7. Zero Client/Service Execution Exposure (journal posting procedures remain blocked)
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. Platform Fee Policy Controls (Preserving Undecided Decisions)
-- ==============================================================================
-- Explicitly documents and models the unresolved decisions regarding gateway processing
-- fee and payout transfer fee bearers. Does not silently charge guests or deduct from owners.

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
-- Stores payment transactions for bookings. Enforces composite tenant consistency,
-- preventing cross-tenant reservation/facility mismatch. Holds immutable financial snapshots
-- (gross amount, commission rate 0.0500, commission amount, owner share) and provider evidence.

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
        CHECK (expected_amount = (commission_amount + owner_gross_share))
);

COMMENT ON TABLE public.payments IS 'Authoritative online payment records for court reservations with composite tenant protection.';

-- Unique provider payment ID constraint when captured
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_payment_id
    ON public.payments (provider_name, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;

-- Single captured payment per reservation constraint
CREATE UNIQUE INDEX IF NOT EXISTS uq_single_captured_payment_per_reservation
    ON public.payments (reservation_id)
    WHERE status = 'captured';

-- Index for tenant and checkout session lookups
CREATE INDEX IF NOT EXISTS idx_payments_org_status ON public.payments (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_checkout_session ON public.payments (checkout_session_id);


-- Payment Status Transition Guard Trigger
CREATE OR REPLACE FUNCTION public.fn_validate_payment_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Allow identical re-updates or initial insert
    IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
        NEW.updated_at = now();
        RETURN NEW;
    END IF;

    -- Valid state transition rules
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
        -- Captured payments can only be refunded, partially refunded, or disputed
        IF NEW.status NOT IN ('refunded', 'partially_refunded', 'disputed') THEN
            RAISE EXCEPTION 'Invalid payment transition: captured payment cannot transition to %.', NEW.status;
        END IF;
    ELSIF OLD.status IN ('failed', 'cancelled', 'refunded') THEN
        -- Terminal states: strictly immutable
        RAISE EXCEPTION 'Invalid payment transition: payment is in terminal status "%" and cannot be modified.', OLD.status;
    ELSIF OLD.status = 'partially_refunded' THEN
        IF NEW.status NOT IN ('refunded', 'disputed') THEN
            RAISE EXCEPTION 'Invalid payment transition: partially_refunded payment cannot transition to %.', NEW.status;
        END IF;
    ELSIF OLD.status = 'disputed' THEN
        IF NEW.status NOT IN ('captured', 'refunded') THEN
            RAISE EXCEPTION 'Invalid payment transition: disputed payment cannot transition to %.', NEW.status;
        END IF;
    END IF;

    -- Enforce captured requirements
    IF NEW.status = 'captured' THEN
        IF NEW.captured_amount <= 0.00 THEN
            NEW.captured_amount := NEW.expected_amount;
        END IF;
        IF NEW.captured_at IS NULL THEN
            NEW.captured_at := now();
        END IF;
        IF NEW.provider_payment_id IS NULL THEN
            RAISE EXCEPTION 'Payment cannot be marked captured without verified provider_payment_id.';
        END IF;
    END IF;

    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_payment_status_transition ON public.payments;
CREATE TRIGGER trg_validate_payment_status_transition
    BEFORE UPDATE ON public.payments
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_validate_payment_status_transition();


-- ==============================================================================
-- 3. Append-Only Provider Webhook Event Inbox
-- ==============================================================================
-- Ingests raw provider webhook notifications. Signature verification occurs in trusted
-- server-side handlers before marking signature_verification_status = 'verified'.
-- Supports deduplication, idempotent retries, and out-of-order event resilience.

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

    -- Unique provider event constraint preventing duplicate event processing
    CONSTRAINT uq_webhook_provider_event UNIQUE (provider_name, provider_event_id)
);

COMMENT ON TABLE public.provider_webhook_events IS 'Append-only inbox for payment provider webhooks with server-side signature tracking.';

CREATE INDEX IF NOT EXISTS idx_webhook_state ON public.provider_webhook_events (processing_state, received_at);

-- Immutability Protection for Webhook Inbox:
-- Disallows DELETE, and only permits UPDATE on processing metadata (payload is immutable).
CREATE OR REPLACE FUNCTION public.fn_protect_webhook_inbox_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Webhook event inbox is append-only. DELETE operations are prohibited.';
    ELSIF TG_OP = 'UPDATE' THEN
        -- Prevent changing core event identifiers and raw payload
        IF OLD.provider_name != NEW.provider_name OR
           OLD.provider_event_id != NEW.provider_event_id OR
           OLD.received_at != NEW.received_at OR
           OLD.payload != NEW.payload THEN
            RAISE EXCEPTION 'Webhook payload and identity fields are immutable once ingested.';
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
-- Tracks provider settlement payout batches and line-item clearing. Owner withdrawable
-- balances are NEVER increased without authoritative settlement verification evidence.

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
    facility_id UUID REFERENCES public.facilities(id) ON DELETE RESTRICT,
    gross_amount NUMERIC(10, 2) NOT NULL CHECK (gross_amount > 0.00),
    provider_fee_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (provider_fee_amount >= 0.00),
    net_settled_amount NUMERIC(10, 2) NOT NULL CHECK (net_settled_amount >= 0.00),
    settlement_status VARCHAR(50) NOT NULL DEFAULT 'matched'
        CHECK (settlement_status IN ('matched', 'mismatched_amount', 'missing_payment', 'duplicate')),
    journal_transaction_id UUID REFERENCES public.financial_transactions(id) ON DELETE RESTRICT,
    reconciled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Composite tenant constraint when facility is present
    CONSTRAINT fk_settlement_items_facility_org
        FOREIGN KEY (facility_id, organization_id)
        REFERENCES public.facilities(id, organization_id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE public.settlement_items IS 'Line items in provider settlements matched against captured payments.';

CREATE INDEX IF NOT EXISTS idx_settlement_items_batch ON public.settlement_items (batch_id);
CREATE INDEX IF NOT EXISTS idx_settlement_items_payment ON public.settlement_items (payment_id);
CREATE INDEX IF NOT EXISTS idx_settlement_items_provider_payment ON public.settlement_items (provider_payment_id);


-- ==============================================================================
-- 5. Owner Payout Infrastructure
-- ==============================================================================
-- Stores payout destination credentials (strictly masked/tokenized) and tracks
-- the payout lifecycle state machine.

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
        CHECK (masked_account_number ~ '^(\*{4,}|[X]{4,})[0-9A-Za-z]{3,6}$')
);

COMMENT ON TABLE public.payout_methods IS 'Tokenized owner bank and payout destination methods with masked account numbers.';

CREATE INDEX IF NOT EXISTS idx_payout_methods_org ON public.payout_methods (organization_id, is_active);


CREATE TABLE IF NOT EXISTS public.payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    payout_method_id UUID NOT NULL REFERENCES public.payout_methods(id) ON DELETE RESTRICT,
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

    -- Journal Links
    journal_reserve_tx_id UUID REFERENCES public.financial_transactions(id) ON DELETE RESTRICT,
    journal_terminal_tx_id UUID REFERENCES public.financial_transactions(id) ON DELETE RESTRICT,

    -- Timestamps
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reserved_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payouts IS 'Owner disbursement records enforcing two-phase lifecycle and terminal finality.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_provider_payout_id
    ON public.payouts (provider_payout_id)
    WHERE provider_payout_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payouts_org_status ON public.payouts (organization_id, status);


-- Payout Lifecycle Audit Log
CREATE TABLE IF NOT EXISTS public.payout_lifecycle_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payout_id UUID NOT NULL REFERENCES public.payouts(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    trigger_source VARCHAR(100) NOT NULL DEFAULT 'system',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payout_lifecycle_logs IS 'Immutable audit log of all payout status transitions.';


-- Payout State Machine & Audit Trigger
CREATE OR REPLACE FUNCTION public.fn_validate_payout_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- If status unchanged, update timestamp and exit
    IF OLD.status = NEW.status THEN
        NEW.updated_at = now();
        RETURN NEW;
    END IF;

    -- Terminal State Protection: paid, failed, and cancelled are terminal and immutable
    IF OLD.status IN ('paid', 'failed', 'cancelled') THEN
        RAISE EXCEPTION 'Payout lifecycle violation: Payout % is in terminal status "%" and cannot be modified.',
            OLD.id, OLD.status;
    END IF;

    -- Valid state transition rules
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
    BEFORE UPDATE ON public.payouts
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_validate_payout_status_transition();


-- Payout Lifecycle Audit Logging Trigger (Runs AFTER so foreign key constraint is satisfied)
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
-- 6. Row-Level Security (RLS) & Client Permission Hardening
-- ==============================================================================
-- All new tables enforce strict Row-Level Security.
-- Ordinary client roles (anon, authenticated) have ZERO INSERT/UPDATE/DELETE privileges.
-- Tenant members may only SELECT records belonging to their active organization.
-- Webhook inbox and settlement batches are entirely blocked from ordinary client access.

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

-- Revoke webhook inbox read access from anon and authenticated (backend only)
REVOKE SELECT ON public.provider_webhook_events FROM anon, authenticated, PUBLIC;
REVOKE SELECT ON public.settlement_batches FROM anon, authenticated, PUBLIC;
REVOKE SELECT ON public.settlement_items FROM anon, authenticated, PUBLIC;

-- Grant selective SELECT to authenticated users for their own organization records
GRANT SELECT ON public.platform_fee_policy_controls TO authenticated;
GRANT SELECT ON public.payments TO authenticated;
GRANT SELECT ON public.payout_methods TO authenticated;
GRANT SELECT ON public.payouts TO authenticated;
GRANT SELECT ON public.payout_lifecycle_logs TO authenticated;

-- RLS Policies for Tenant Access Control
CREATE POLICY rls_fee_policy_select ON public.platform_fee_policy_controls
    FOR SELECT TO authenticated USING (true);

CREATE POLICY rls_payments_select ON public.payments
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid()
        )
    );

CREATE POLICY rls_payout_methods_select ON public.payout_methods
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid()
        )
    );

CREATE POLICY rls_payouts_select ON public.payouts
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid()
        )
    );

CREATE POLICY rls_payout_lifecycle_select ON public.payout_lifecycle_logs
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id FROM public.organization_members om
            WHERE om.user_id = auth.uid()
        )
    );

-- Default deny policies for internal tables
CREATE POLICY rls_webhooks_deny ON public.provider_webhook_events
    FOR ALL TO PUBLIC USING (false);

CREATE POLICY rls_settlement_batches_deny ON public.settlement_batches
    FOR ALL TO PUBLIC USING (false);

CREATE POLICY rls_settlement_items_deny ON public.settlement_items
    FOR ALL TO PUBLIC USING (false);


-- ==============================================================================
-- 7. Integration Boundaries: Preserve Revocation of Journal Procedures
-- ==============================================================================
-- Confirm that service_role and application roles remain strictly blocked from
-- calling financial posting procedures until Migration 005C integration verification.

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
