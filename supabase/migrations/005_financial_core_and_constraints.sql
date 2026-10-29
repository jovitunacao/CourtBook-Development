-- ==============================================================================
-- CourtBook / BookSuite — Database Schema Migration
-- Migration: 005_financial_core_and_constraints.sql
-- Description: Phase 4.2.1 Schema Foundation Only (Simplified & Hardened)
--
-- SCOPE (Schema Foundation Only):
--   1. Tenant-consistent relational composite constraints on facilities & reservations
--   2. Platform billing configuration table with initial 5% commission & provisional limits
--   3. Platform checkout circuit-breaker configuration table
--   4. Immutable double-entry financial transaction headers & ledger entry tables
--   5. Organization financial balances table with accounting invariant definitions
--   6. Automated balance record initialization for existing and newly created organizations
--   7. Immutability triggers preventing direct UPDATE or DELETE on financial ledger tables
--   8. Strict Row Level Security (RLS) & privilege hardening (SELECT only for authenticated,
--      zero direct INSERT/UPDATE/DELETE privileges for clients)
--
-- EXCLUSIONS (Deferred to Separate Tested Migrations):
--   - NO post_journal_transaction_atomic() function (journal engine deferred to tested migration)
--   - NO payments table (deferred to Migration 005B)
--   - NO payouts or payout_methods tables (deferred to Migration 005B)
--   - NO changes to existing booking confirmation RPCs or reservation policies
-- ==============================================================================

-- ==============================================================================
-- 1. Tenant-Consistent Relational Constraints
-- ==============================================================================
-- Establish composite uniqueness on parent entities so future payment and payout
-- tables (Migration 005B) can enforce composite foreign keys, physically
-- preventing cross-tenant record linkage at the database engine level.

DO $$
BEGIN
    -- Composite uniqueness for facilities: (id, organization_id)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'uq_facility_org'
          AND table_schema = 'public'
          AND table_name = 'facilities'
    ) THEN
        ALTER TABLE public.facilities
            ADD CONSTRAINT uq_facility_org UNIQUE (id, organization_id);
    END IF;

    -- Composite uniqueness for reservations: (id, facility_id)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'uq_reservation_facility'
          AND table_schema = 'public'
          AND table_name = 'reservations'
    ) THEN
        ALTER TABLE public.reservations
            ADD CONSTRAINT uq_reservation_facility UNIQUE (id, facility_id);
    END IF;
END $$;

-- ==============================================================================
-- 2. Platform Billing Configuration (Provisional & Configurable Parameters)
-- ==============================================================================
-- Stores platform monetization rates and withdrawal safety thresholds.
-- Initial confirmed rate: 5% (0.0500) commission deducted from owner rental revenue.
-- Payout limits, cooldowns, and fee reserve buffers are clearly designated as
-- provisional values, dynamically tunable without requiring schema migrations.

CREATE TABLE IF NOT EXISTS public.platform_billing_config (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- Strict singleton table
    default_commission_rate NUMERIC(5, 4) NOT NULL DEFAULT 0.0500
        CHECK (default_commission_rate >= 0.0000 AND default_commission_rate <= 1.0000),
    min_payout_amount NUMERIC(10, 2) NOT NULL DEFAULT 500.00
        CHECK (min_payout_amount > 0.00), -- Provisional threshold
    max_payout_amount NUMERIC(10, 2) NOT NULL DEFAULT 250000.00
        CHECK (max_payout_amount >= min_payout_amount),
    payout_cooldown_hours INT NOT NULL DEFAULT 24
        CHECK (payout_cooldown_hours >= 0 AND payout_cooldown_hours <= 168), -- Provisional 24h
    provisional_gateway_reserve_rate NUMERIC(5, 4) NOT NULL DEFAULT 0.0350
        CHECK (provisional_gateway_reserve_rate >= 0.0000 AND provisional_gateway_reserve_rate <= 0.2000),
    provisional_gateway_reserve_fixed NUMERIC(10, 2) NOT NULL DEFAULT 15.00
        CHECK (provisional_gateway_reserve_fixed >= 0.00),
    provisional_payout_fee_reserve NUMERIC(10, 2) NOT NULL DEFAULT 25.00
        CHECK (provisional_payout_fee_reserve >= 0.00),
    is_provisional BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.platform_billing_config IS 'Platform billing rates, commission settings, and provisional payout thresholds.';

-- Seed default configuration if not present
INSERT INTO public.platform_billing_config (
    id,
    default_commission_rate,
    min_payout_amount,
    max_payout_amount,
    payout_cooldown_hours,
    provisional_gateway_reserve_rate,
    provisional_gateway_reserve_fixed,
    provisional_payout_fee_reserve,
    is_provisional
) VALUES (
    1,
    0.0500,
    500.00,
    250000.00,
    24,
    0.0350,
    15.00,
    25.00,
    true
) ON CONFLICT (id) DO NOTHING;

-- ==============================================================================
-- 3. Platform Checkout Circuit Breaker Controls
-- ==============================================================================
-- Granular operational circuit breaker that can pause new online checkout attempts
-- without breaking existing paid bookings, ledger history, in-flight checkouts,
-- or webhook settlements.

CREATE TABLE IF NOT EXISTS public.platform_checkout_controls (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- Strict singleton table
    new_checkouts_enabled BOOLEAN NOT NULL DEFAULT true,
    in_flight_completion_enabled BOOLEAN NOT NULL DEFAULT true,
    webhook_settlement_enabled BOOLEAN NOT NULL DEFAULT true,
    payout_requests_enabled BOOLEAN NOT NULL DEFAULT true,
    maintenance_notice TEXT DEFAULT NULL,
    circuit_breaker_reason TEXT DEFAULT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.platform_checkout_controls IS 'Granular operational controls to pause checkouts or payouts safely.';

-- Seed default circuit breaker state (all active, normal operations)
INSERT INTO public.platform_checkout_controls (
    id,
    new_checkouts_enabled,
    in_flight_completion_enabled,
    webhook_settlement_enabled,
    payout_requests_enabled
) VALUES (
    1,
    true,
    true,
    true,
    true
) ON CONFLICT (id) DO NOTHING;

-- ==============================================================================
-- 4. Double-Entry Financial Journal & Immutable Ledger Tables
-- ==============================================================================
-- Every financial event produces one parent transaction and two or more balanced
-- ledger entries adhering strictly to sum(debits) = sum(credits).
--
-- Chart of Accounts:
--   1010: Gateway Clearing Cash Asset (DEBIT increases asset, CREDIT decreases asset)
--   2010: Owner Payable Liability     (CREDIT increases liability, DEBIT decreases liability)
--   2020: Undecided Fee Escrow        (CREDIT holds estimated MDR pending policy resolution)
--   2030: Customer Refund Liability   (CREDIT holds excess/late charges awaiting refund)
--   4010: Platform Commission Revenue (CREDIT increases platform income, DEBIT decreases on refund)
--   5010: Platform Processing Expense (DEBIT records gateway fees absorbed by platform)

CREATE TABLE IF NOT EXISTS public.financial_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_number BIGSERIAL UNIQUE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    facility_id UUID REFERENCES public.facilities(id) ON DELETE RESTRICT,
    transaction_type VARCHAR(32) NOT NULL CHECK (transaction_type IN (
        'booking_settlement',
        'funds_cleared_to_available',
        'refund_reversal',
        'chargeback_adjustment',
        'payout_disbursement',
        'dispute_hold',
        'excess_payment_liability',
        'late_payment_liability',
        'platform_adjustment'
    )),
    idempotency_key TEXT NOT NULL UNIQUE,
    reference_id UUID NOT NULL, -- Logical entity: reservation_id, payout_id, or adjustment_id
    description TEXT NOT NULL CHECK (char_length(trim(description)) >= 5),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.financial_transactions IS 'Header records for all double-entry financial events.';

CREATE INDEX IF NOT EXISTS idx_financial_transactions_org_created
    ON public.financial_transactions (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_financial_transactions_ref_id
    ON public.financial_transactions (reference_id);
CREATE INDEX IF NOT EXISTS idx_financial_transactions_idempotency
    ON public.financial_transactions (idempotency_key);

CREATE TABLE IF NOT EXISTS public.ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES public.financial_transactions(id) ON DELETE RESTRICT,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    account_code VARCHAR(10) NOT NULL CHECK (account_code IN ('1010', '2010', '2020', '2030', '4010', '5010')),
    entry_direction VARCHAR(6) NOT NULL CHECK (entry_direction IN ('DEBIT', 'CREDIT')),
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0.00),
    entry_order SMALLINT NOT NULL CHECK (entry_order >= 1),
    running_balance NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_ledger_entry_order UNIQUE (transaction_id, entry_order)
);

COMMENT ON TABLE public.ledger_entries IS 'Balanced, append-only double-entry ledger lines.';

CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_sequence
    ON public.ledger_entries (organization_id, account_code, created_at DESC, entry_order DESC);

-- Unconditional Immutability Protection Trigger
CREATE OR REPLACE FUNCTION public.prevent_financial_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'Financial journal and ledger records are append-only and strictly immutable. Direct UPDATE and DELETE operations are prohibited.';
END;
$$;

DROP TRIGGER IF EXISTS tr_prevent_financial_transactions_mutation ON public.financial_transactions;
CREATE TRIGGER tr_prevent_financial_transactions_mutation
    BEFORE UPDATE OR DELETE ON public.financial_transactions
    FOR EACH ROW EXECUTE FUNCTION public.prevent_financial_ledger_mutation();

DROP TRIGGER IF EXISTS tr_prevent_ledger_entries_mutation ON public.ledger_entries;
CREATE TRIGGER tr_prevent_ledger_entries_mutation
    BEFORE UPDATE OR DELETE ON public.ledger_entries
    FOR EACH ROW EXECUTE FUNCTION public.prevent_financial_ledger_mutation();

-- ==============================================================================
-- 5. Organization Financial Balances (Materialized State Guard)
-- ==============================================================================
-- Provides concurrency serialization and fast balance queries without expensive
-- full-table ledger scans on every user request.
--
-- ACCOUNTING INVARIANTS:
--   1. Total Gross Settled = Cumulative gross booking payments minus refunds.
--   2. Total Commission Paid = Cumulative 5% platform earnings minus refunds.
--   3. Owner Gross Revenue Entitlement = total_gross_settled - total_commission_paid.
--   4. Owner Gross Revenue Decomposition:
--        Owner Gross Revenue = unsettled_clearing_amount
--                            + available_withdrawable_balance
--                            + pending_payout_amount
--                            + total_withdrawn
--      Every centavo of owner revenue resides in exactly ONE of these four states.
--   5. Available withdrawable balance represents ONLY funds cleared from gateway
--      holding, past session completion, and with fee/refund reserves satisfied.

CREATE TABLE IF NOT EXISTS public.organization_balances (
    organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE RESTRICT,
    currency VARCHAR(3) NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
    total_gross_settled NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (total_gross_settled >= 0.00),
    total_commission_paid NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (total_commission_paid >= 0.00),
    total_withdrawn NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (total_withdrawn >= 0.00),
    pending_payout_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (pending_payout_amount >= 0.00),
    unsettled_clearing_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (unsettled_clearing_amount >= 0.00),
    restricted_reserve_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (restricted_reserve_amount >= 0.00),
    available_withdrawable_balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (available_withdrawable_balance >= 0.00),
    last_journal_transaction_id UUID REFERENCES public.financial_transactions(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.organization_balances IS 'Materialized financial balance metrics locked during transactions.';

-- Automatically provision an organization_balances record for every existing organization
INSERT INTO public.organization_balances (
    organization_id,
    currency,
    total_gross_settled,
    total_commission_paid,
    total_withdrawn,
    pending_payout_amount,
    unsettled_clearing_amount,
    restricted_reserve_amount,
    available_withdrawable_balance
)
SELECT
    id,
    'PHP',
    0.00,
    0.00,
    0.00,
    0.00,
    0.00,
    0.00,
    0.00
FROM public.organizations
ON CONFLICT (organization_id) DO NOTHING;

-- Automated trigger to seed organization_balances whenever a new organization is created
CREATE OR REPLACE FUNCTION public.seed_organization_balance_on_create()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.organization_balances (
        organization_id,
        currency,
        total_gross_settled,
        total_commission_paid,
        total_withdrawn,
        pending_payout_amount,
        unsettled_clearing_amount,
        restricted_reserve_amount,
        available_withdrawable_balance
    ) VALUES (
        NEW.id,
        'PHP',
        0.00,
        0.00,
        0.00,
        0.00,
        0.00,
        0.00,
        0.00
    ) ON CONFLICT (organization_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_seed_organization_balance_on_create ON public.organizations;
CREATE TRIGGER tr_seed_organization_balance_on_create
    AFTER INSERT ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION public.seed_organization_balance_on_create();

-- ==============================================================================
-- 6. Row Level Security (RLS) & Access Permissions
-- ==============================================================================
-- Strict read-only posture for client roles. Direct INSERT, UPDATE, and DELETE
-- are completely revoked from PUBLIC, anon, and authenticated.

-- 1. platform_billing_config
ALTER TABLE public.platform_billing_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.platform_billing_config FROM PUBLIC, anon;
GRANT SELECT ON public.platform_billing_config TO authenticated, service_role;

DROP POLICY IF EXISTS "Allow authenticated read on billing config" ON public.platform_billing_config;
CREATE POLICY "Allow authenticated read on billing config"
    ON public.platform_billing_config FOR SELECT
    TO authenticated
    USING (true);

-- 2. platform_checkout_controls
ALTER TABLE public.platform_checkout_controls ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.platform_checkout_controls FROM PUBLIC, anon;
GRANT SELECT ON public.platform_checkout_controls TO authenticated, service_role;

DROP POLICY IF EXISTS "Allow authenticated read on checkout controls" ON public.platform_checkout_controls;
CREATE POLICY "Allow authenticated read on checkout controls"
    ON public.platform_checkout_controls FOR SELECT
    TO authenticated
    USING (true);

-- 3. financial_transactions
ALTER TABLE public.financial_transactions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.financial_transactions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.financial_transactions TO authenticated, service_role;

DROP POLICY IF EXISTS "Allow organization members read financial transactions" ON public.financial_transactions;
CREATE POLICY "Allow organization members read financial transactions"
    ON public.financial_transactions FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id, ARRAY['owner', 'admin']));

-- 4. ledger_entries
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ledger_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ledger_entries TO authenticated, service_role;

DROP POLICY IF EXISTS "Allow organization members read ledger entries" ON public.ledger_entries;
CREATE POLICY "Allow organization members read ledger entries"
    ON public.ledger_entries FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id, ARRAY['owner', 'admin']));

-- 5. organization_balances
ALTER TABLE public.organization_balances ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.organization_balances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.organization_balances TO authenticated, service_role;

DROP POLICY IF EXISTS "Allow organization members read organization balances" ON public.organization_balances;
CREATE POLICY "Allow organization members read organization balances"
    ON public.organization_balances FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id, ARRAY['owner', 'admin']));
