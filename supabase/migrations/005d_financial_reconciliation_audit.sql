-- ==============================================================================
-- CourtBook / BookSuite — Database Schema Migration
-- Migration: 005d_financial_reconciliation_audit.sql
-- Description: Phase 4.2.5 Financial Reconciliation & End-to-End Audit Engine
--
-- TARGET ENVIRONMENT:
--   BookSuite-Payment-Test (and staging/production environments)
--
-- ARCHITECTURAL PRINCIPLES & GOALS:
--   1. Strict Read-Only Audit: Purely analytical; NEVER alters financial records,
--      balances, ledger lines, or payment states.
--   2. Trustworthy, Fail-Closed Authorization:
--      * Both reconciliation functions are SECURITY DEFINER with search_path pinned to 'public, pg_temp'.
--      * Does NOT rely on current_user (which resolves to the function owner in SECURITY DEFINER).
--      * Uses reliable caller context: session_user, request.jwt.claim.role, and auth.uid().
--      * Anonymous clients and unauthenticated roles are unconditionally blocked.
--      * Direct EXECUTE revoked from PUBLIC and anon on all reconciliation routines.
--      * Authenticated clients must provide an explicit organization_id and possess
--        verified owner or admin role within that organization.
--      * Privileged service/backend operations (direct superuser session_user 'postgres'/'supabase_admin',
--        or validated 'service_role' claim with trusted authenticator session) are authorized for operational audits.
--      * All audit views enforce security_invoker = true and tenant RLS isolation without cross-tenant leaks.
--   3. Double-Entry Reconciliation: Verifies sum(debits) = sum(credits) for every
--      posted transaction and checks account running balances against the general ledger.
--   4. Revenue Split Integrity: Verifies 5% platform commission and 95% owner gross
--      share with exact centavo precision (ROUND(..., 2)), with zero tolerance for drift.
--   5. Materialized Balance Verification: Reconciles public.organization_balances
--      directly against underlying ledger accounts (11-account COA):
--        * Account 2010 (Liability normal) -> unsettled_clearing_amount
--        * Account 2011 (Liability normal) -> available_withdrawable_balance
--        * Account 2012 (Liability normal) -> restricted_reserve_amount
--        * Account 2015 (Liability normal) -> pending_payout_amount
--        * Account 4010 (Revenue normal)   -> total_commission_paid
--        * Account 1030 (Asset normal)     -> negative_recovery_balance
--        * Account 1020/2015 disbursements -> total_withdrawn
--   6. Complete Revenue Decomposition Invariant (Authoritative 005a2 Math):
--        Owner Revenue Entitlement (total_gross_settled - total_commission_paid) =
--          unsettled_clearing_amount + available_withdrawable_balance +
--          pending_payout_amount + total_withdrawn +
--          restricted_reserve_amount - negative_recovery_balance
--   7. Operational Payout & Settlement Verification:
--        * Sum of active reserved payouts (approved_reserved / submitted_to_provider) = pending_payout_amount
--        * Sum of completed payouts (paid) = total_withdrawn
--        * Mandatory journal linkage strictly verified by lifecycle status.
--   8. Anomaly & Replay Detection: Duplicate provider payment IDs and orphaned journals.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. Read-Only Transaction Double-Entry Audit View
-- ==============================================================================
CREATE OR REPLACE VIEW public.v_transaction_double_entry_audit
WITH (security_invoker = true)
AS
SELECT
    ft.id AS transaction_id,
    ft.transaction_number,
    ft.organization_id,
    ft.facility_id,
    ft.transaction_type,
    ft.reference_id,
    ft.idempotency_key,
    ft.created_at,
    COALESCE(count(le.id), 0)::INT AS entry_count,
    COALESCE(round(sum(CASE WHEN le.entry_direction = 'DEBIT' THEN le.amount ELSE 0.00 END), 2), 0.00) AS total_debits,
    COALESCE(round(sum(CASE WHEN le.entry_direction = 'CREDIT' THEN le.amount ELSE 0.00 END), 2), 0.00) AS total_credits,
    COALESCE(round(sum(CASE WHEN le.entry_direction = 'DEBIT' THEN le.amount ELSE -le.amount END), 2), 0.00) AS net_imbalance,
    CASE
        WHEN count(le.id) = 0 THEN false
        WHEN round(sum(CASE WHEN le.entry_direction = 'DEBIT' THEN le.amount ELSE 0.00 END), 2) <= 0.00 THEN false
        WHEN round(sum(CASE WHEN le.entry_direction = 'DEBIT' THEN le.amount ELSE -le.amount END), 2) = 0.00 THEN true
        ELSE false
    END AS is_balanced
FROM public.financial_transactions ft
LEFT JOIN public.ledger_entries le ON le.transaction_id = ft.id
WHERE (
    -- Direct superuser session (postgres / supabase_admin) ONLY when NOT operating under an unprivileged role or JWT
    (
        session_user IN ('postgres', 'supabase_admin') AND
        COALESCE(NULLIF(current_setting('role', true), 'none'), '') = '' AND
        COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '') = '' AND
        auth.uid() IS NULL
    ) OR
    -- Genuine service_role: MUST have database role service_role AND claim service_role
    (
        current_setting('role', true) = 'service_role' AND
        current_setting('request.jwt.claim.role', true) = 'service_role' AND
        session_user IN ('authenticator', 'postgres', 'supabase_admin')
    ) OR
    -- Verified owner or admin of the organization (fails closed for anon, outsider, staff, cross-tenant)
    (
        auth.uid() IS NOT NULL AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.organization_id = ft.organization_id
              AND om.user_id = auth.uid()
              AND om.role IN ('owner', 'admin')
        )
    )
)
GROUP BY ft.id, ft.transaction_number, ft.organization_id, ft.facility_id,
         ft.transaction_type, ft.reference_id, ft.idempotency_key, ft.created_at;

COMMENT ON VIEW public.v_transaction_double_entry_audit IS 'Audit view calculating debit and credit totals and balance status for each financial transaction.';


-- ==============================================================================
-- 2. Read-Only Payment Commission & Split Verification View
-- ==============================================================================
CREATE OR REPLACE VIEW public.v_payment_commission_audit
WITH (security_invoker = true)
AS
SELECT
    p.id AS payment_id,
    p.organization_id,
    p.facility_id,
    p.reservation_id,
    p.status AS payment_status,
    p.provider_name,
    p.provider_payment_id,
    p.expected_amount,
    p.commission_rate,
    p.commission_amount,
    p.owner_gross_share,
    p.captured_amount,
    p.refunded_amount,
    round(p.expected_amount * p.commission_rate, 2) AS calculated_commission_amount,
    p.expected_amount - round(p.expected_amount * p.commission_rate, 2) AS calculated_owner_share,
    (p.commission_rate = 0.0500) AS is_standard_rate,
    (p.expected_amount = round(p.commission_amount + p.owner_gross_share, 2)) AS is_split_conserved,
    (p.commission_amount = round(p.expected_amount * p.commission_rate, 2)) AS is_commission_accurate,
    (p.owner_gross_share = round(p.expected_amount - (p.expected_amount * p.commission_rate), 2)) AS is_owner_share_accurate,
    (p.refunded_amount <= p.captured_amount) AS is_refund_within_bounds,
    p.created_at,
    p.captured_at
FROM public.payments p
WHERE (
    -- Direct superuser session (postgres / supabase_admin) ONLY when NOT operating under an unprivileged role or JWT
    (
        session_user IN ('postgres', 'supabase_admin') AND
        COALESCE(NULLIF(current_setting('role', true), 'none'), '') = '' AND
        COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '') = '' AND
        auth.uid() IS NULL
    ) OR
    -- Genuine service_role: MUST have database role service_role AND claim service_role
    (
        current_setting('role', true) = 'service_role' AND
        current_setting('request.jwt.claim.role', true) = 'service_role' AND
        session_user IN ('authenticator', 'postgres', 'supabase_admin')
    ) OR
    -- Verified owner or admin of the organization (fails closed for anon, outsider, staff, cross-tenant)
    (
        auth.uid() IS NOT NULL AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.organization_id = p.organization_id
              AND om.user_id = auth.uid()
              AND om.role IN ('owner', 'admin')
        )
    )
);

COMMENT ON VIEW public.v_payment_commission_audit IS 'Audit view checking 5% commission calculation, owner share conservation, and refund bounds on payment records for authorized owners and admins.';


-- ==============================================================================
-- 3. Read-Only Payout Lifecycle & Journal Linkage Reconciliation View
-- ==============================================================================
CREATE OR REPLACE VIEW public.v_payout_lifecycle_reconciliation
WITH (security_invoker = true)
AS
SELECT
    p.id AS payout_id,
    p.organization_id,
    p.payout_method_id,
    p.amount AS payout_amount,
    p.currency,
    p.status AS payout_status,
    p.provider_payout_id,
    p.journal_reserve_tx_id,
    res_ft.transaction_type AS reserve_tx_type,
    res_ft.organization_id AS reserve_tx_org_id,
    p.journal_terminal_tx_id,
    term_ft.transaction_type AS terminal_tx_type,
    term_ft.organization_id AS terminal_tx_org_id,
    CASE
        WHEN p.status = 'pending_request' THEN (p.journal_reserve_tx_id IS NULL AND p.journal_terminal_tx_id IS NULL)
        WHEN p.status IN ('approved_reserved', 'submitted_to_provider') THEN
            (p.journal_reserve_tx_id IS NOT NULL AND res_ft.transaction_type = 'payout_reserve' AND res_ft.organization_id = p.organization_id AND p.journal_terminal_tx_id IS NULL)
        WHEN p.status = 'paid' THEN
            (p.journal_reserve_tx_id IS NOT NULL AND res_ft.transaction_type = 'payout_reserve' AND res_ft.organization_id = p.organization_id
             AND p.journal_terminal_tx_id IS NOT NULL AND term_ft.transaction_type = 'payout_disbursement' AND term_ft.organization_id = p.organization_id)
        WHEN p.status IN ('failed', 'cancelled') THEN
            CASE
                WHEN p.journal_reserve_tx_id IS NOT NULL THEN
                    (res_ft.transaction_type = 'payout_reserve' AND res_ft.organization_id = p.organization_id
                     AND p.journal_terminal_tx_id IS NOT NULL AND term_ft.transaction_type = 'payout_failed_release' AND term_ft.organization_id = p.organization_id)
                ELSE
                    (p.journal_reserve_tx_id IS NULL AND p.journal_terminal_tx_id IS NULL)
            END
        ELSE false
    END AS is_journal_linkage_valid,
    p.created_at,
    p.reserved_at,
    p.completed_at,
    p.failed_at
FROM public.payouts p
LEFT JOIN public.financial_transactions res_ft ON res_ft.id = p.journal_reserve_tx_id
LEFT JOIN public.financial_transactions term_ft ON term_ft.id = p.journal_terminal_tx_id
WHERE (
    -- Direct superuser session (postgres / supabase_admin) ONLY when NOT operating under an unprivileged role or JWT
    (
        session_user IN ('postgres', 'supabase_admin') AND
        COALESCE(NULLIF(current_setting('role', true), 'none'), '') = '' AND
        COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '') = '' AND
        auth.uid() IS NULL
    ) OR
    -- Genuine service_role: MUST have database role service_role AND claim service_role
    (
        current_setting('role', true) = 'service_role' AND
        current_setting('request.jwt.claim.role', true) = 'service_role' AND
        session_user IN ('authenticator', 'postgres', 'supabase_admin')
    ) OR
    -- Verified owner or admin of the organization (fails closed for anon, outsider, staff, cross-tenant)
    (
        auth.uid() IS NOT NULL AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.organization_id = p.organization_id
              AND om.user_id = auth.uid()
              AND om.role IN ('owner', 'admin')
        )
    )
);

COMMENT ON VIEW public.v_payout_lifecycle_reconciliation IS 'Audit view verifying mandatory journal linkage and lifecycle status invariants for owner payouts.';


-- ==============================================================================
-- 4. Read-Only Organization Balances vs General Ledger Overview View
-- ==============================================================================
CREATE OR REPLACE VIEW public.v_financial_reconciliation_overview
WITH (security_invoker = true)
AS
WITH ledger_summary AS (
    SELECT
        le.organization_id,
        -- Account 2010: Owner Payable - Unsettled Clearing (Liability normal: Credits - Debits)
        COALESCE(round(sum(CASE
            WHEN le.account_code = '2010' AND le.entry_direction = 'CREDIT' THEN le.amount
            WHEN le.account_code = '2010' AND le.entry_direction = 'DEBIT' THEN -le.amount
            ELSE 0.00
        END), 2), 0.00) AS gl_unsettled_clearing,

        -- Account 2011: Owner Payable - Available for Payout (Liability normal: Credits - Debits)
        COALESCE(round(sum(CASE
            WHEN le.account_code = '2011' AND le.entry_direction = 'CREDIT' THEN le.amount
            WHEN le.account_code = '2011' AND le.entry_direction = 'DEBIT' THEN -le.amount
            ELSE 0.00
        END), 2), 0.00) AS gl_available_balance,

        -- Account 2012: Owner Payable - Restricted Reserve (Liability normal: Credits - Debits)
        COALESCE(round(sum(CASE
            WHEN le.account_code = '2012' AND le.entry_direction = 'CREDIT' THEN le.amount
            WHEN le.account_code = '2012' AND le.entry_direction = 'DEBIT' THEN -le.amount
            ELSE 0.00
        END), 2), 0.00) AS gl_restricted_reserve,

        -- Account 2015: Owner Payable - Pending Payout (Liability normal: Credits - Debits)
        COALESCE(round(sum(CASE
            WHEN le.account_code = '2015' AND le.entry_direction = 'CREDIT' THEN le.amount
            WHEN le.account_code = '2015' AND le.entry_direction = 'DEBIT' THEN -le.amount
            ELSE 0.00
        END), 2), 0.00) AS gl_pending_payout,

        -- Account 4010: Platform Commission Revenue (Revenue normal: Credits - Debits)
        COALESCE(round(sum(CASE
            WHEN le.account_code = '4010' AND le.entry_direction = 'CREDIT' THEN le.amount
            WHEN le.account_code = '4010' AND le.entry_direction = 'DEBIT' THEN -le.amount
            ELSE 0.00
        END), 2), 0.00) AS gl_commission_revenue,

        -- Account 1030: Platform Merchant Recovery Receivable (Asset normal: Debits - Credits)
        COALESCE(round(sum(CASE
            WHEN le.account_code = '1030' AND le.entry_direction = 'DEBIT' THEN le.amount
            WHEN le.account_code = '1030' AND le.entry_direction = 'CREDIT' THEN -le.amount
            ELSE 0.00
        END), 2), 0.00) AS gl_negative_recovery,

        -- Account 2030: Customer Refund Liability (Liability normal: Credits - Debits)
        COALESCE(round(sum(CASE
            WHEN le.account_code = '2030' AND le.entry_direction = 'CREDIT' THEN le.amount
            WHEN le.account_code = '2030' AND le.entry_direction = 'DEBIT' THEN -le.amount
            ELSE 0.00
        END), 2), 0.00) AS gl_customer_refund_liability,

        -- Total Cash Disbursed to Owner via Payouts (Account 2015 Debits on payout_disbursement)
        COALESCE(round(sum(CASE
            WHEN ft.transaction_type = 'payout_disbursement' AND le.account_code = '2015' AND le.entry_direction = 'DEBIT'
            THEN le.amount
            ELSE 0.00
        END), 2), 0.00) AS gl_total_withdrawn
    FROM public.ledger_entries le
    JOIN public.financial_transactions ft ON ft.id = le.transaction_id
    GROUP BY le.organization_id
),
payout_summary AS (
    SELECT
        p.organization_id,
        COALESCE(round(sum(CASE WHEN p.status IN ('approved_reserved', 'submitted_to_provider') THEN p.amount ELSE 0.00 END), 2), 0.00) AS active_reserved_payouts_sum,
        COALESCE(round(sum(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0.00 END), 2), 0.00) AS paid_payouts_sum
    FROM public.payouts p
    GROUP BY p.organization_id
)
SELECT
    o.id AS organization_id,
    o.name AS organization_name,
    ob.currency,

    -- 1. Unsettled Clearing Reconciliation (Account 2010)
    ob.unsettled_clearing_amount AS stored_unsettled_clearing,
    COALESCE(ls.gl_unsettled_clearing, 0.00) AS calculated_unsettled_clearing,
    round(ob.unsettled_clearing_amount - COALESCE(ls.gl_unsettled_clearing, 0.00), 2) AS unsettled_clearing_diff,

    -- 2. Available Balance Reconciliation (Account 2011)
    ob.available_withdrawable_balance AS stored_available_balance,
    COALESCE(ls.gl_available_balance, 0.00) AS calculated_available_balance,
    round(ob.available_withdrawable_balance - COALESCE(ls.gl_available_balance, 0.00), 2) AS available_balance_diff,

    -- 3. Pending Payout Reconciliation (Organization Balances vs GL Account 2015 vs Active Reserved Payouts)
    ob.pending_payout_amount AS stored_pending_payout,
    COALESCE(ls.gl_pending_payout, 0.00) AS calculated_pending_payout,
    COALESCE(ps.active_reserved_payouts_sum, 0.00) AS active_payout_records_sum,
    round(ob.pending_payout_amount - COALESCE(ls.gl_pending_payout, 0.00), 2) AS pending_payout_diff,

    -- 4. Total Commission Paid Reconciliation (Account 4010)
    ob.total_commission_paid AS stored_total_commission,
    COALESCE(ls.gl_commission_revenue, 0.00) AS calculated_total_commission,
    round(ob.total_commission_paid - COALESCE(ls.gl_commission_revenue, 0.00), 2) AS commission_diff,

    -- 5. Total Withdrawn Reconciliation (Account 1020/2015 Disbursements vs Paid Payouts)
    ob.total_withdrawn AS stored_total_withdrawn,
    COALESCE(ls.gl_total_withdrawn, 0.00) AS calculated_total_withdrawn,
    COALESCE(ps.paid_payouts_sum, 0.00) AS paid_payout_records_sum,
    round(ob.total_withdrawn - COALESCE(ls.gl_total_withdrawn, 0.00), 2) AS withdrawn_diff,

    -- 6. Restricted Reserve Reconciliation (Account 2012)
    ob.restricted_reserve_amount AS stored_restricted_reserve,
    COALESCE(ls.gl_restricted_reserve, 0.00) AS calculated_restricted_reserve,
    round(ob.restricted_reserve_amount - COALESCE(ls.gl_restricted_reserve, 0.00), 2) AS restricted_reserve_diff,

    -- 7. Negative Recovery Balance Reconciliation (Account 1030)
    ob.negative_recovery_balance AS stored_negative_recovery,
    COALESCE(ls.gl_negative_recovery, 0.00) AS calculated_negative_recovery,
    round(ob.negative_recovery_balance - COALESCE(ls.gl_negative_recovery, 0.00), 2) AS negative_recovery_diff,

    -- 8. Complete Revenue Decomposition Invariant (Authoritative 005a2 Math):
    -- Owner Entitlement = total_gross_settled - total_commission_paid
    -- Decomposed Sum = unsettled + available + pending_payout + total_withdrawn + restricted_reserve - negative_recovery
    round(ob.total_gross_settled - ob.total_commission_paid, 2) AS owner_gross_revenue_entitlement,
    round(ob.unsettled_clearing_amount + ob.available_withdrawable_balance + ob.pending_payout_amount + ob.total_withdrawn + ob.restricted_reserve_amount - ob.negative_recovery_balance, 2) AS owner_decomposed_revenue_sum,
    round((ob.total_gross_settled - ob.total_commission_paid) - (ob.unsettled_clearing_amount + ob.available_withdrawable_balance + ob.pending_payout_amount + ob.total_withdrawn + ob.restricted_reserve_amount - ob.negative_recovery_balance), 2) AS decomposition_drift,

    -- Overall Integrity Flag
    (
        ob.unsettled_clearing_amount = COALESCE(ls.gl_unsettled_clearing, 0.00) AND
        ob.available_withdrawable_balance = COALESCE(ls.gl_available_balance, 0.00) AND
        ob.pending_payout_amount = COALESCE(ls.gl_pending_payout, 0.00) AND
        ob.pending_payout_amount = COALESCE(ps.active_reserved_payouts_sum, 0.00) AND
        ob.total_commission_paid = COALESCE(ls.gl_commission_revenue, 0.00) AND
        ob.total_withdrawn = COALESCE(ls.gl_total_withdrawn, 0.00) AND
        ob.total_withdrawn = COALESCE(ps.paid_payouts_sum, 0.00) AND
        ob.restricted_reserve_amount = COALESCE(ls.gl_restricted_reserve, 0.00) AND
        ob.negative_recovery_balance = COALESCE(ls.gl_negative_recovery, 0.00) AND
        round(ob.total_gross_settled - ob.total_commission_paid, 2) =
            round(ob.unsettled_clearing_amount + ob.available_withdrawable_balance + ob.pending_payout_amount + ob.total_withdrawn + ob.restricted_reserve_amount - ob.negative_recovery_balance, 2)
    ) AS is_reconciled
FROM public.organizations o
JOIN public.organization_balances ob ON ob.organization_id = o.id
LEFT JOIN ledger_summary ls ON ls.organization_id = o.id
LEFT JOIN payout_summary ps ON ps.organization_id = o.id
WHERE (
    -- Direct superuser session (postgres / supabase_admin) ONLY when NOT operating under an unprivileged role or JWT
    (
        session_user IN ('postgres', 'supabase_admin') AND
        COALESCE(NULLIF(current_setting('role', true), 'none'), '') = '' AND
        COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '') = '' AND
        auth.uid() IS NULL
    ) OR
    -- Genuine service_role: MUST have database role service_role AND claim service_role
    (
        current_setting('role', true) = 'service_role' AND
        current_setting('request.jwt.claim.role', true) = 'service_role' AND
        session_user IN ('authenticator', 'postgres', 'supabase_admin')
    ) OR
    -- Verified owner or admin of the organization (fails closed for anon, outsider, staff, cross-tenant)
    (
        auth.uid() IS NOT NULL AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.organization_id = o.id
              AND om.user_id = auth.uid()
              AND om.role IN ('owner', 'admin')
        )
    )
);

COMMENT ON VIEW public.v_financial_reconciliation_overview IS 'Comprehensive view matching materialized balance metrics against general ledger accounts and operational payout sums for authorized owners and admins.';


-- ==============================================================================
-- 5. Read-Only Core Reconciliation Diagnostic Function
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.reconcile_organization_finances(
    p_organization_id UUID DEFAULT NULL
)
RETURNS TABLE (
    organization_id UUID,
    category TEXT,
    severity TEXT,
    discrepancy_code TEXT,
    entity_type TEXT,
    entity_id UUID,
    expected_value NUMERIC(12, 2),
    actual_value NUMERIC(12, 2),
    discrepancy_amount NUMERIC(12, 2),
    description TEXT,
    details JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_session_user TEXT;
    v_active_role TEXT;
    v_jwt_role TEXT;
    v_caller_uid UUID;
    v_is_trusted_service BOOLEAN := false;
BEGIN
    -- Reliable caller identification (immune to SECURITY DEFINER function owner substitution)
    v_session_user := session_user;
    v_active_role := NULLIF(current_setting('role', true), 'none');
    v_jwt_role := NULLIF(current_setting('request.jwt.claim.role', true), '');
    v_caller_uid := auth.uid();

    -- 1. Anti-impersonation: An authenticated database role cannot claim service_role
    IF v_active_role = 'authenticated' AND v_jwt_role = 'service_role' THEN
        RAISE EXCEPTION 'Access denied: Authenticated role cannot claim service_role privileges.';
    END IF;

    -- 2. Unconditional rejection of anonymous clients
    IF v_active_role = 'anon' OR
       v_jwt_role = 'anon' OR
       v_session_user = 'anon' OR
       (v_active_role IS NULL AND v_jwt_role IS NULL AND v_caller_uid IS NULL AND v_session_user NOT IN ('postgres', 'supabase_admin')) THEN
        RAISE EXCEPTION 'Access denied: Anonymous clients cannot access financial reconciliation.';
    END IF;

    -- 3. Reliable identification of privileged service / superuser operations
    -- Avoid broad trust in session_user when the session switches to a less-privileged effective role.
    -- Trusted service is ONLY recognized when:
    --   a) Direct superuser session (postgres / supabase_admin) WITHOUT an active unprivileged role, claim, or client identity
    --   b) Genuine service_role dispatched via PostgREST (active role = 'service_role' AND jwt role = 'service_role')
    IF (v_session_user IN ('postgres', 'supabase_admin') AND
        v_active_role IS NULL AND
        v_jwt_role IS NULL AND
        v_caller_uid IS NULL) OR
       (v_active_role = 'service_role' AND
        v_jwt_role = 'service_role' AND
        v_session_user IN ('authenticator', 'postgres', 'supabase_admin')) THEN
        v_is_trusted_service := true;
    END IF;

    -- 3. If NOT a verified service caller, strictly enforce authenticated owner/admin customer checks
    IF NOT v_is_trusted_service THEN
        v_caller_uid := auth.uid();
        IF v_caller_uid IS NULL THEN
            RAISE EXCEPTION 'Access denied: Unauthenticated clients cannot access financial reconciliation.';
        END IF;

        IF p_organization_id IS NULL THEN
            RAISE EXCEPTION 'Access denied: Authenticated clients must provide an explicit organization_id.';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.organization_id = p_organization_id
              AND om.user_id = v_caller_uid
              AND om.role IN ('owner', 'admin')
        ) THEN
            RAISE EXCEPTION 'Access denied: Only organization owners and admins can run financial reconciliation.';
        END IF;
    END IF;

    -- =========================================================================
    -- CHECK 1: Double-Entry Debit/Credit Balance on Financial Transactions
    -- =========================================================================
    RETURN QUERY
    SELECT
        ft.organization_id,
        'DOUBLE_ENTRY'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'LEDGER_UNBALANCED_TRANSACTION'::TEXT AS discrepancy_code,
        'transaction'::TEXT AS entity_type,
        ft.id AS entity_id,
        round(sum(CASE WHEN le.entry_direction = 'DEBIT' THEN le.amount ELSE 0.00 END), 2) AS expected_value,
        round(sum(CASE WHEN le.entry_direction = 'CREDIT' THEN le.amount ELSE 0.00 END), 2) AS actual_value,
        abs(round(sum(CASE WHEN le.entry_direction = 'DEBIT' THEN le.amount ELSE -le.amount END), 2)) AS discrepancy_amount,
        format('Financial transaction %s (#%s, %s) is unbalanced: Total Debits (₱%s) != Total Credits (₱%s).',
            ft.id, ft.transaction_number, ft.transaction_type,
            round(sum(CASE WHEN le.entry_direction = 'DEBIT' THEN le.amount ELSE 0.00 END), 2),
            round(sum(CASE WHEN le.entry_direction = 'CREDIT' THEN le.amount ELSE 0.00 END), 2)) AS description,
        jsonb_build_object(
            'transaction_number', ft.transaction_number,
            'transaction_type', ft.transaction_type,
            'idempotency_key', ft.idempotency_key,
            'debits', round(sum(CASE WHEN le.entry_direction = 'DEBIT' THEN le.amount ELSE 0.00 END), 2),
            'credits', round(sum(CASE WHEN le.entry_direction = 'CREDIT' THEN le.amount ELSE 0.00 END), 2)
        ) AS details
    FROM public.financial_transactions ft
    JOIN public.ledger_entries le ON le.transaction_id = ft.id
    WHERE (p_organization_id IS NULL OR ft.organization_id = p_organization_id)
    GROUP BY ft.id, ft.organization_id, ft.transaction_number, ft.transaction_type, ft.idempotency_key
    HAVING round(sum(CASE WHEN le.entry_direction = 'DEBIT' THEN le.amount ELSE -le.amount END), 2) != 0.00;

    -- =========================================================================
    -- CHECK 1B: Transactions with Missing Ledger Entries
    -- =========================================================================
    RETURN QUERY
    SELECT
        ft.organization_id,
        'DOUBLE_ENTRY'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'LEDGER_MISSING_ENTRIES'::TEXT AS discrepancy_code,
        'transaction'::TEXT AS entity_type,
        ft.id AS entity_id,
        2.00::NUMERIC(12, 2) AS expected_value,
        0.00::NUMERIC(12, 2) AS actual_value,
        0.00::NUMERIC(12, 2) AS discrepancy_amount,
        format('Financial transaction %s (#%s, %s) has 0 ledger entries recorded.',
            ft.id, ft.transaction_number, ft.transaction_type) AS description,
        jsonb_build_object(
            'transaction_number', ft.transaction_number,
            'transaction_type', ft.transaction_type,
            'idempotency_key', ft.idempotency_key
        ) AS details
    FROM public.financial_transactions ft
    LEFT JOIN public.ledger_entries le ON le.transaction_id = ft.id
    WHERE (p_organization_id IS NULL OR ft.organization_id = p_organization_id)
      AND le.id IS NULL;

    -- =========================================================================
    -- CHECK 2: Cross-Tenant Ledger Entry Leakage
    -- =========================================================================
    RETURN QUERY
    SELECT
        le.organization_id,
        'TENANT_ISOLATION'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'CROSS_TENANT_LEDGER_LEAKAGE'::TEXT AS discrepancy_code,
        'ledger_entry'::TEXT AS entity_type,
        le.id AS entity_id,
        NULL::NUMERIC(12, 2) AS expected_value,
        NULL::NUMERIC(12, 2) AS actual_value,
        le.amount AS discrepancy_amount,
        format('Ledger entry %s belongs to organization %s but references transaction %s belonging to organization %s.',
            le.id, le.organization_id, ft.id, ft.organization_id) AS description,
        jsonb_build_object(
            'entry_id', le.id,
            'entry_org_id', le.organization_id,
            'transaction_id', ft.id,
            'transaction_org_id', ft.organization_id
        ) AS details
    FROM public.ledger_entries le
    JOIN public.financial_transactions ft ON ft.id = le.transaction_id
    WHERE (p_organization_id IS NULL OR le.organization_id = p_organization_id OR ft.organization_id = p_organization_id)
      AND le.organization_id != ft.organization_id;

    -- =========================================================================
    -- CHECK 3: 5% Commission Policy and Payment Split Integrity
    -- =========================================================================
    RETURN QUERY
    SELECT
        p.organization_id,
        'COMMISSION_POLICY'::TEXT AS category,
        'ERROR'::TEXT AS severity,
        'COMMISSION_RATE_MISMATCH'::TEXT AS discrepancy_code,
        'payment'::TEXT AS entity_type,
        p.id AS entity_id,
        0.0500::NUMERIC(12, 2) AS expected_value,
        p.commission_rate::NUMERIC(12, 2) AS actual_value,
        abs(p.commission_rate - 0.0500) AS discrepancy_amount,
        format('Payment %s has non-standard commission rate %s (expected 0.0500).',
            p.id, p.commission_rate) AS description,
        jsonb_build_object('payment_id', p.id, 'commission_rate', p.commission_rate, 'expected_amount', p.expected_amount) AS details
    FROM public.payments p
    WHERE (p_organization_id IS NULL OR p.organization_id = p_organization_id)
      AND p.commission_rate != 0.0500;

    RETURN QUERY
    SELECT
        p.organization_id,
        'COMMISSION_POLICY'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'COMMISSION_SPLIT_MISMATCH'::TEXT AS discrepancy_code,
        'payment'::TEXT AS entity_type,
        p.id AS entity_id,
        p.expected_amount AS expected_value,
        round(p.commission_amount + p.owner_gross_share, 2) AS actual_value,
        abs(p.expected_amount - round(p.commission_amount + p.owner_gross_share, 2)) AS discrepancy_amount,
        format('Payment %s split mismatch: expected_amount (₱%s) != commission_amount (₱%s) + owner_gross_share (₱%s).',
            p.id, p.expected_amount, p.commission_amount, p.owner_gross_share) AS description,
        jsonb_build_object(
            'payment_id', p.id,
            'expected_amount', p.expected_amount,
            'commission_amount', p.commission_amount,
            'owner_gross_share', p.owner_gross_share
        ) AS details
    FROM public.payments p
    WHERE (p_organization_id IS NULL OR p.organization_id = p_organization_id)
      AND p.expected_amount != round(p.commission_amount + p.owner_gross_share, 2);

    RETURN QUERY
    SELECT
        p.organization_id,
        'COMMISSION_POLICY'::TEXT AS category,
        'ERROR'::TEXT AS severity,
        'COMMISSION_CALCULATION_DRIFT'::TEXT AS discrepancy_code,
        'payment'::TEXT AS entity_type,
        p.id AS entity_id,
        round(p.expected_amount * p.commission_rate, 2) AS expected_value,
        p.commission_amount AS actual_value,
        abs(round(p.expected_amount * p.commission_rate, 2) - p.commission_amount) AS discrepancy_amount,
        format('Payment %s commission calculation drift: expected ₱%s, got ₱%s.',
            p.id, round(p.expected_amount * p.commission_rate, 2), p.commission_amount) AS description,
        jsonb_build_object(
            'payment_id', p.id,
            'expected_commission', round(p.expected_amount * p.commission_rate, 2),
            'actual_commission', p.commission_amount
        ) AS details
    FROM public.payments p
    WHERE (p_organization_id IS NULL OR p.organization_id = p_organization_id)
      AND p.commission_amount != round(p.expected_amount * p.commission_rate, 2);

    -- =========================================================================
    -- CHECK 4: Payment Capture & Refund Invariants
    -- =========================================================================
    RETURN QUERY
    SELECT
        p.organization_id,
        'PAYMENT_LIFECYCLE'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'PAYMENT_REFUND_OVERFLOW'::TEXT AS discrepancy_code,
        'payment'::TEXT AS entity_type,
        p.id AS entity_id,
        p.captured_amount AS expected_value,
        p.refunded_amount AS actual_value,
        round(p.refunded_amount - p.captured_amount, 2) AS discrepancy_amount,
        format('Payment %s refunded_amount (₱%s) exceeds captured_amount (₱%s).',
            p.id, p.refunded_amount, p.captured_amount) AS description,
        jsonb_build_object('payment_id', p.id, 'captured_amount', p.captured_amount, 'refunded_amount', p.refunded_amount) AS details
    FROM public.payments p
    WHERE (p_organization_id IS NULL OR p.organization_id = p_organization_id)
      AND p.refunded_amount > p.captured_amount;

    RETURN QUERY
    SELECT
        p.organization_id,
        'PAYMENT_LIFECYCLE'::TEXT AS category,
        'ERROR'::TEXT AS severity,
        'PAYMENT_MISSING_SETTLEMENT_JOURNAL'::TEXT AS discrepancy_code,
        'payment'::TEXT AS entity_type,
        p.id AS entity_id,
        p.captured_amount AS expected_value,
        0.00::NUMERIC(12, 2) AS actual_value,
        p.captured_amount AS discrepancy_amount,
        format('Captured payment %s has no corresponding booking_settlement financial transaction.',
            p.id) AS description,
        jsonb_build_object('payment_id', p.id, 'reservation_id', p.reservation_id, 'captured_amount', p.captured_amount) AS details
    FROM public.payments p
    WHERE (p_organization_id IS NULL OR p.organization_id = p_organization_id)
      AND p.status = 'captured'
      AND NOT EXISTS (
          SELECT 1 FROM public.financial_transactions ft
          WHERE ft.reference_id = p.reservation_id
            AND ft.transaction_type = 'booking_settlement'
            AND ft.organization_id = p.organization_id
      );

    -- =========================================================================
    -- CHECK 5: Organization Balances vs General Ledger Reconciliation
    -- =========================================================================
    RETURN QUERY
    SELECT
        v.organization_id,
        'BALANCE_SHEET'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'BALANCE_UNSETTLED_CLEARING_MISMATCH'::TEXT AS discrepancy_code,
        'organization_balance'::TEXT AS entity_type,
        v.organization_id AS entity_id,
        v.calculated_unsettled_clearing AS expected_value,
        v.stored_unsettled_clearing AS actual_value,
        abs(v.unsettled_clearing_diff) AS discrepancy_amount,
        format('Organization %s unsettled_clearing_amount mismatch: Materialized balance (₱%s) != General Ledger Account 2010 (₱%s).',
            v.organization_name, v.stored_unsettled_clearing, v.calculated_unsettled_clearing) AS description,
        jsonb_build_object(
            'stored', v.stored_unsettled_clearing,
            'calculated_gl_2010', v.calculated_unsettled_clearing,
            'diff', v.unsettled_clearing_diff
        ) AS details
    FROM public.v_financial_reconciliation_overview v
    WHERE (p_organization_id IS NULL OR v.organization_id = p_organization_id)
      AND v.unsettled_clearing_diff != 0.00;

    RETURN QUERY
    SELECT
        v.organization_id,
        'BALANCE_SHEET'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'BALANCE_AVAILABLE_WITHDRAWABLE_MISMATCH'::TEXT AS discrepancy_code,
        'organization_balance'::TEXT AS entity_type,
        v.organization_id AS entity_id,
        v.calculated_available_balance AS expected_value,
        v.stored_available_balance AS actual_value,
        abs(v.available_balance_diff) AS discrepancy_amount,
        format('Organization %s available_withdrawable_balance mismatch: Materialized balance (₱%s) != General Ledger Account 2011 (₱%s).',
            v.organization_name, v.stored_available_balance, v.calculated_available_balance) AS description,
        jsonb_build_object(
            'stored', v.stored_available_balance,
            'calculated_gl_2011', v.calculated_available_balance,
            'diff', v.available_balance_diff
        ) AS details
    FROM public.v_financial_reconciliation_overview v
    WHERE (p_organization_id IS NULL OR v.organization_id = p_organization_id)
      AND v.available_balance_diff != 0.00;

    RETURN QUERY
    SELECT
        v.organization_id,
        'BALANCE_SHEET'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'BALANCE_PENDING_PAYOUT_MISMATCH'::TEXT AS discrepancy_code,
        'organization_balance'::TEXT AS entity_type,
        v.organization_id AS entity_id,
        v.calculated_pending_payout AS expected_value,
        v.stored_pending_payout AS actual_value,
        abs(v.pending_payout_diff) AS discrepancy_amount,
        format('Organization %s pending_payout_amount mismatch: Materialized balance (₱%s) != General Ledger Account 2015 (₱%s).',
            v.organization_name, v.stored_pending_payout, v.calculated_pending_payout) AS description,
        jsonb_build_object(
            'stored', v.stored_pending_payout,
            'calculated_gl_2015', v.calculated_pending_payout,
            'active_payouts_sum', v.active_payout_records_sum,
            'diff', v.pending_payout_diff
        ) AS details
    FROM public.v_financial_reconciliation_overview v
    WHERE (p_organization_id IS NULL OR v.organization_id = p_organization_id)
      AND v.pending_payout_diff != 0.00;

    RETURN QUERY
    SELECT
        v.organization_id,
        'BALANCE_SHEET'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'BALANCE_TOTAL_COMMISSION_MISMATCH'::TEXT AS discrepancy_code,
        'organization_balance'::TEXT AS entity_type,
        v.organization_id AS entity_id,
        v.calculated_total_commission AS expected_value,
        v.stored_total_commission AS actual_value,
        abs(v.commission_diff) AS discrepancy_amount,
        format('Organization %s total_commission_paid mismatch: Materialized metric (₱%s) != General Ledger Account 4010 (₱%s).',
            v.organization_name, v.stored_total_commission, v.calculated_total_commission) AS description,
        jsonb_build_object(
            'stored', v.stored_total_commission,
            'calculated_gl_4010', v.calculated_total_commission,
            'diff', v.commission_diff
        ) AS details
    FROM public.v_financial_reconciliation_overview v
    WHERE (p_organization_id IS NULL OR v.organization_id = p_organization_id)
      AND v.commission_diff != 0.00;

    RETURN QUERY
    SELECT
        v.organization_id,
        'BALANCE_SHEET'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'BALANCE_TOTAL_WITHDRAWN_MISMATCH'::TEXT AS discrepancy_code,
        'organization_balance'::TEXT AS entity_type,
        v.organization_id AS entity_id,
        v.calculated_total_withdrawn AS expected_value,
        v.stored_total_withdrawn AS actual_value,
        abs(v.withdrawn_diff) AS discrepancy_amount,
        format('Organization %s total_withdrawn mismatch: Materialized metric (₱%s) != Ledger Disbursements (₱%s).',
            v.organization_name, v.stored_total_withdrawn, v.calculated_total_withdrawn) AS description,
        jsonb_build_object(
            'stored', v.stored_total_withdrawn,
            'calculated_disbursements', v.calculated_total_withdrawn,
            'paid_payouts_sum', v.paid_payout_records_sum,
            'diff', v.withdrawn_diff
        ) AS details
    FROM public.v_financial_reconciliation_overview v
    WHERE (p_organization_id IS NULL OR v.organization_id = p_organization_id)
      AND v.withdrawn_diff != 0.00;

    RETURN QUERY
    SELECT
        v.organization_id,
        'BALANCE_SHEET'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'BALANCE_RESTRICTED_RESERVE_MISMATCH'::TEXT AS discrepancy_code,
        'organization_balance'::TEXT AS entity_type,
        v.organization_id AS entity_id,
        v.calculated_restricted_reserve AS expected_value,
        v.stored_restricted_reserve AS actual_value,
        abs(v.restricted_reserve_diff) AS discrepancy_amount,
        format('Organization %s restricted_reserve_amount mismatch: Materialized metric (₱%s) != General Ledger Account 2012 (₱%s).',
            v.organization_name, v.stored_restricted_reserve, v.calculated_restricted_reserve) AS description,
        jsonb_build_object(
            'stored', v.stored_restricted_reserve,
            'calculated_gl_2012', v.calculated_restricted_reserve,
            'diff', v.restricted_reserve_diff
        ) AS details
    FROM public.v_financial_reconciliation_overview v
    WHERE (p_organization_id IS NULL OR v.organization_id = p_organization_id)
      AND v.restricted_reserve_diff != 0.00;

    RETURN QUERY
    SELECT
        v.organization_id,
        'BALANCE_SHEET'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'BALANCE_NEGATIVE_RECOVERY_MISMATCH'::TEXT AS discrepancy_code,
        'organization_balance'::TEXT AS entity_type,
        v.organization_id AS entity_id,
        v.calculated_negative_recovery AS expected_value,
        v.stored_negative_recovery AS actual_value,
        abs(v.negative_recovery_diff) AS discrepancy_amount,
        format('Organization %s negative_recovery_balance mismatch: Materialized metric (₱%s) != General Ledger Account 1030 (₱%s).',
            v.organization_name, v.stored_negative_recovery, v.calculated_negative_recovery) AS description,
        jsonb_build_object(
            'stored', v.stored_negative_recovery,
            'calculated_gl_1030', v.calculated_negative_recovery,
            'diff', v.negative_recovery_diff
        ) AS details
    FROM public.v_financial_reconciliation_overview v
    WHERE (p_organization_id IS NULL OR v.organization_id = p_organization_id)
      AND v.negative_recovery_diff != 0.00;

    RETURN QUERY
    SELECT
        v.organization_id,
        'BALANCE_SHEET'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'BALANCE_DECOMPOSITION_INVARIANT_VIOLATION'::TEXT AS discrepancy_code,
        'organization_balance'::TEXT AS entity_type,
        v.organization_id AS entity_id,
        v.owner_gross_revenue_entitlement AS expected_value,
        v.owner_decomposed_revenue_sum AS actual_value,
        abs(v.decomposition_drift) AS discrepancy_amount,
        format('Organization %s revenue decomposition invariant breached: Entitlement (₱%s) != Decomposed sum (₱%s). Drift: ₱%s.',
            v.organization_name, v.owner_gross_revenue_entitlement, v.owner_decomposed_revenue_sum, v.decomposition_drift) AS description,
        jsonb_build_object(
            'owner_entitlement', v.owner_gross_revenue_entitlement,
            'decomposed_sum', v.owner_decomposed_revenue_sum,
            'unsettled', v.stored_unsettled_clearing,
            'available', v.stored_available_balance,
            'pending_payout', v.stored_pending_payout,
            'withdrawn', v.stored_total_withdrawn,
            'restricted_reserve', v.stored_restricted_reserve,
            'negative_recovery', v.stored_negative_recovery,
            'drift', v.decomposition_drift
        ) AS details
    FROM public.v_financial_reconciliation_overview v
    WHERE (p_organization_id IS NULL OR v.organization_id = p_organization_id)
      AND v.decomposition_drift != 0.00;

    -- =========================================================================
    -- CHECK 6: Payout Lifecycle vs Ledger Account 2015 Consistency
    -- =========================================================================
    RETURN QUERY
    SELECT
        v.organization_id,
        'PAYOUT_LIFECYCLE'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'PAYOUT_RESERVE_RECORD_MISMATCH'::TEXT AS discrepancy_code,
        'organization_balance'::TEXT AS entity_type,
        v.organization_id AS entity_id,
        v.stored_pending_payout AS expected_value,
        v.active_payout_records_sum AS actual_value,
        abs(round(v.stored_pending_payout - v.active_payout_records_sum, 2)) AS discrepancy_amount,
        format('Organization %s pending payout metric (₱%s) does not match sum of active reserved payout records (₱%s).',
            v.organization_name, v.stored_pending_payout, v.active_payout_records_sum) AS description,
        jsonb_build_object(
            'stored_pending_payout', v.stored_pending_payout,
            'active_payout_records_sum', v.active_payout_records_sum
        ) AS details
    FROM public.v_financial_reconciliation_overview v
    WHERE (p_organization_id IS NULL OR v.organization_id = p_organization_id)
      AND v.stored_pending_payout != v.active_payout_records_sum;

    RETURN QUERY
    SELECT
        v.organization_id,
        'PAYOUT_LIFECYCLE'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'PAYOUT_PAID_RECORD_MISMATCH'::TEXT AS discrepancy_code,
        'organization_balance'::TEXT AS entity_type,
        v.organization_id AS entity_id,
        v.stored_total_withdrawn AS expected_value,
        v.paid_payout_records_sum AS actual_value,
        abs(round(v.stored_total_withdrawn - v.paid_payout_records_sum, 2)) AS discrepancy_amount,
        format('Organization %s total_withdrawn metric (₱%s) does not match sum of completed paid payout records (₱%s).',
            v.organization_name, v.stored_total_withdrawn, v.paid_payout_records_sum) AS description,
        jsonb_build_object(
            'stored_total_withdrawn', v.stored_total_withdrawn,
            'paid_payout_records_sum', v.paid_payout_records_sum
        ) AS details
    FROM public.v_financial_reconciliation_overview v
    WHERE (p_organization_id IS NULL OR v.organization_id = p_organization_id)
      AND v.stored_total_withdrawn != v.paid_payout_records_sum;

    RETURN QUERY
    SELECT
        vp.organization_id,
        'PAYOUT_LIFECYCLE'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'PAYOUT_INVALID_JOURNAL_LINKAGE'::TEXT AS discrepancy_code,
        'payout'::TEXT AS entity_type,
        vp.payout_id AS entity_id,
        NULL::NUMERIC(12, 2) AS expected_value,
        NULL::NUMERIC(12, 2) AS actual_value,
        vp.payout_amount AS discrepancy_amount,
        format('Payout %s (status "%s") has invalid journal linkage: reserve_tx: %s (%s, org: %s), terminal_tx: %s (%s, org: %s).',
            vp.payout_id, vp.payout_status,
            COALESCE(vp.journal_reserve_tx_id::TEXT, 'NULL'), COALESCE(vp.reserve_tx_type, 'NULL'), COALESCE(vp.reserve_tx_org_id::TEXT, 'NULL'),
            COALESCE(vp.journal_terminal_tx_id::TEXT, 'NULL'), COALESCE(vp.terminal_tx_type, 'NULL'), COALESCE(vp.terminal_tx_org_id::TEXT, 'NULL')) AS description,
        jsonb_build_object(
            'payout_id', vp.payout_id,
            'status', vp.payout_status,
            'amount', vp.payout_amount,
            'journal_reserve_tx_id', vp.journal_reserve_tx_id,
            'reserve_tx_type', vp.reserve_tx_type,
            'journal_terminal_tx_id', vp.journal_terminal_tx_id,
            'terminal_tx_type', vp.terminal_tx_type
        ) AS details
    FROM public.v_payout_lifecycle_reconciliation vp
    WHERE (p_organization_id IS NULL OR vp.organization_id = p_organization_id)
      AND NOT vp.is_journal_linkage_valid;

    -- =========================================================================
    -- CHECK 7: Cross-Tenant Journal References in Payouts
    -- =========================================================================
    RETURN QUERY
    SELECT
        p.organization_id,
        'TENANT_ISOLATION'::TEXT AS category,
        'CRITICAL'::TEXT AS severity,
        'CROSS_TENANT_PAYOUT_JOURNAL'::TEXT AS discrepancy_code,
        'payout'::TEXT AS entity_type,
        p.id AS entity_id,
        NULL::NUMERIC(12, 2) AS expected_value,
        NULL::NUMERIC(12, 2) AS actual_value,
        p.amount AS discrepancy_amount,
        format('Payout %s belongs to organization %s but references journal transaction belonging to organization %s.',
            p.id, p.organization_id, COALESCE(res_ft.organization_id, term_ft.organization_id)) AS description,
        jsonb_build_object(
            'payout_id', p.id,
            'payout_org', p.organization_id,
            'reserve_tx_org', res_ft.organization_id,
            'terminal_tx_org', term_ft.organization_id
        ) AS details
    FROM public.payouts p
    LEFT JOIN public.financial_transactions res_ft ON res_ft.id = p.journal_reserve_tx_id
    LEFT JOIN public.financial_transactions term_ft ON term_ft.id = p.journal_terminal_tx_id
    WHERE (p_organization_id IS NULL OR p.organization_id = p_organization_id)
      AND (
          (res_ft.id IS NOT NULL AND res_ft.organization_id != p.organization_id) OR
          (term_ft.id IS NOT NULL AND term_ft.organization_id != p.organization_id)
      );

    -- =========================================================================
    -- CHECK 8: Duplicate Provider Identifiers Anomaly Detection
    -- =========================================================================
    RETURN QUERY
    SELECT
        p.organization_id,
        'ANOMALY_DETECTION'::TEXT AS category,
        'ERROR'::TEXT AS severity,
        'DUPLICATE_PROVIDER_PAYMENT_ID'::TEXT AS discrepancy_code,
        'payment'::TEXT AS entity_type,
        p.id AS entity_id,
        NULL::NUMERIC(12, 2) AS expected_value,
        NULL::NUMERIC(12, 2) AS actual_value,
        p.captured_amount AS discrepancy_amount,
        format('Provider payment ID "%s" is duplicated across multiple payment records.',
            p.provider_payment_id) AS description,
        jsonb_build_object('provider_payment_id', p.provider_payment_id, 'payment_id', p.id) AS details
    FROM public.payments p
    WHERE p.provider_payment_id IS NOT NULL
      AND (p_organization_id IS NULL OR p.organization_id = p_organization_id)
      AND p.provider_payment_id IN (
          SELECT sub.provider_payment_id FROM public.payments sub
          WHERE sub.provider_payment_id IS NOT NULL
          GROUP BY sub.provider_payment_id
          HAVING count(*) > 1
      );

    RETURN;
END;
$$;

COMMENT ON FUNCTION public.reconcile_organization_finances IS 'Read-only financial audit function performing exhaustive double-entry, commission split, balance invariant, and tenant consistency checks.';


-- ==============================================================================
-- 6. Read-Only Summary Report Function
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.get_financial_reconciliation_summary(
    p_organization_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_session_user TEXT;
    v_active_role TEXT;
    v_jwt_role TEXT;
    v_caller_uid UUID;
    v_is_trusted_service BOOLEAN := false;
    v_total_discrepancies INT := 0;
    v_critical_count INT := 0;
    v_error_count INT := 0;
    v_warning_count INT := 0;
    v_audited_orgs INT := 0;
    v_audited_tx INT := 0;
    v_audited_entries INT := 0;
    v_audited_payments INT := 0;
    v_audited_payouts INT := 0;
    v_discrepancies JSONB := '[]'::jsonb;
    v_disc RECORD;
BEGIN
    -- Reliable caller identification (immune to SECURITY DEFINER function owner substitution)
    v_session_user := session_user;
    v_active_role := NULLIF(current_setting('role', true), 'none');
    v_jwt_role := NULLIF(current_setting('request.jwt.claim.role', true), '');
    v_caller_uid := auth.uid();

    -- 1. Anti-impersonation: An authenticated database role cannot claim service_role
    IF v_active_role = 'authenticated' AND v_jwt_role = 'service_role' THEN
        RAISE EXCEPTION 'Access denied: Authenticated role cannot claim service_role privileges.';
    END IF;

    -- 2. Unconditional rejection of anonymous clients
    IF v_active_role = 'anon' OR
       v_jwt_role = 'anon' OR
       v_session_user = 'anon' OR
       (v_active_role IS NULL AND v_jwt_role IS NULL AND v_caller_uid IS NULL AND v_session_user NOT IN ('postgres', 'supabase_admin')) THEN
        RAISE EXCEPTION 'Access denied: Anonymous clients cannot access financial reconciliation.';
    END IF;

    -- 3. Reliable identification of privileged service / superuser operations
    -- Avoid broad trust in session_user when the session switches to a less-privileged effective role.
    -- Trusted service is ONLY recognized when:
    --   a) Direct superuser session (postgres / supabase_admin) WITHOUT an active unprivileged role, claim, or client identity
    --   b) Genuine service_role dispatched via PostgREST (active role = 'service_role' AND jwt role = 'service_role')
    IF (v_session_user IN ('postgres', 'supabase_admin') AND
        v_active_role IS NULL AND
        v_jwt_role IS NULL AND
        v_caller_uid IS NULL) OR
       (v_active_role = 'service_role' AND
        v_jwt_role = 'service_role' AND
        v_session_user IN ('authenticator', 'postgres', 'supabase_admin')) THEN
        v_is_trusted_service := true;
    END IF;

    -- 3. If NOT a verified service caller, strictly enforce authenticated owner/admin customer checks
    IF NOT v_is_trusted_service THEN
        v_caller_uid := auth.uid();
        IF v_caller_uid IS NULL THEN
            RAISE EXCEPTION 'Access denied: Unauthenticated clients cannot access financial reconciliation.';
        END IF;

        IF p_organization_id IS NULL THEN
            RAISE EXCEPTION 'Access denied: Authenticated clients must provide an explicit organization_id.';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.organization_id = p_organization_id
              AND om.user_id = v_caller_uid
              AND om.role IN ('owner', 'admin')
        ) THEN
            RAISE EXCEPTION 'Access denied: Only organization owners and admins can run financial reconciliation.';
        END IF;
    END IF;

    -- Audit Scope Metrics (Scoped to authorized organization)
    SELECT count(DISTINCT id) INTO v_audited_orgs
    FROM public.organizations
    WHERE (p_organization_id IS NULL OR id = p_organization_id);

    SELECT count(*) INTO v_audited_tx
    FROM public.financial_transactions
    WHERE (p_organization_id IS NULL OR organization_id = p_organization_id);

    SELECT count(*) INTO v_audited_entries
    FROM public.ledger_entries
    WHERE (p_organization_id IS NULL OR organization_id = p_organization_id);

    SELECT count(*) INTO v_audited_payments
    FROM public.payments
    WHERE (p_organization_id IS NULL OR organization_id = p_organization_id);

    SELECT count(*) INTO v_audited_payouts
    FROM public.payouts
    WHERE (p_organization_id IS NULL OR organization_id = p_organization_id);

    -- Collect Discrepancies
    FOR v_disc IN (
        SELECT * FROM public.reconcile_organization_finances(p_organization_id)
        ORDER BY
            CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'ERROR' THEN 2 WHEN 'WARNING' THEN 3 ELSE 4 END,
            organization_id, discrepancy_code
    ) LOOP
        v_total_discrepancies := v_total_discrepancies + 1;
        IF v_disc.severity = 'CRITICAL' THEN
            v_critical_count := v_critical_count + 1;
        ELSIF v_disc.severity = 'ERROR' THEN
            v_error_count := v_error_count + 1;
        ELSIF v_disc.severity = 'WARNING' THEN
            v_warning_count := v_warning_count + 1;
        END IF;

        v_discrepancies := v_discrepancies || jsonb_build_object(
            'organization_id', v_disc.organization_id,
            'category', v_disc.category,
            'severity', v_disc.severity,
            'discrepancy_code', v_disc.discrepancy_code,
            'entity_type', v_disc.entity_type,
            'entity_id', v_disc.entity_id,
            'expected_value', v_disc.expected_value,
            'actual_value', v_disc.actual_value,
            'discrepancy_amount', v_disc.discrepancy_amount,
            'description', v_disc.description,
            'details', v_disc.details
        );
    END LOOP;

    RETURN jsonb_build_object(
        'is_healthy', (v_critical_count = 0 AND v_error_count = 0),
        'total_discrepancies', v_total_discrepancies,
        'critical_count', v_critical_count,
        'error_count', v_error_count,
        'warning_count', v_warning_count,
        'audited_scope', jsonb_build_object(
            'organizations_count', v_audited_orgs,
            'financial_transactions_count', v_audited_tx,
            'ledger_entries_count', v_audited_entries,
            'payments_count', v_audited_payments,
            'payouts_count', v_audited_payouts
        ),
        'double_entry_balanced', (v_critical_count = 0),
        'commission_policy_compliant', NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_discrepancies) d
            WHERE d->>'category' = 'COMMISSION_POLICY'
        ),
        'discrepancies', v_discrepancies,
        'audited_at', now()
    );
END;
$$;

COMMENT ON FUNCTION public.get_financial_reconciliation_summary IS 'High-level structured JSON audit summary assessing ledger double-entry balance, commission integrity, and balance sheet invariants.';


-- ==============================================================================
-- 7. Privileges & Access Hardening (Zero-Trust Model)
-- ==============================================================================

-- Explicitly revoke all privileges from PUBLIC and anon
REVOKE ALL ON public.v_transaction_double_entry_audit FROM PUBLIC, anon;
REVOKE ALL ON public.v_payment_commission_audit FROM PUBLIC, anon;
REVOKE ALL ON public.v_payout_lifecycle_reconciliation FROM PUBLIC, anon;
REVOKE ALL ON public.v_financial_reconciliation_overview FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.reconcile_organization_finances(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_financial_reconciliation_summary(UUID) FROM PUBLIC, anon;

-- Grant safe, authenticated access
GRANT SELECT ON public.v_transaction_double_entry_audit TO authenticated, service_role;
GRANT SELECT ON public.v_payment_commission_audit TO authenticated, service_role;
GRANT SELECT ON public.v_payout_lifecycle_reconciliation TO authenticated, service_role;
GRANT SELECT ON public.v_financial_reconciliation_overview TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.reconcile_organization_finances(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_financial_reconciliation_summary(UUID) TO authenticated, service_role;

COMMIT;
