-- ==============================================================================
-- LockaCourt (AratReserve) — Database Migration 005G
-- File: supabase/migrations/005g_hitpay_refund_linkage_hardening.sql
-- Description: HitPay Refund Explicit PHP Currency & Captured Payment Linkage Hardening
--
-- SAFETY & NON-DESTRUCTIVE POLICY:
--   - Migrations 001 through 005F remain 100% untouched.
--   - Requires explicit PHP currency and strict original payment ID match
--     before posting or replaying any HitPay refund reversal.
--   - Rejects missing or mismatched linkage/currency without ledger mutations.
-- ==============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.process_verified_refund_event(
    p_payment_id UUID,
    p_refund_amount NUMERIC(10, 2),
    p_reason TEXT,
    p_provider_refund_id VARCHAR(255),
    p_refund_evidence JSONB,
    p_idempotency_key TEXT,
    p_is_partial BOOLEAN DEFAULT false,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_key TEXT;
    v_clean_refund_id TEXT;
    v_payment RECORD;
    v_new_refunded_total NUMERIC(10, 2);
    v_target_status VARCHAR(50);
    v_journal_res JSONB;
    v_evidence_status TEXT;
    v_webhook_event_id UUID;
    v_webhook RECORD;
    v_trusted_refund_id TEXT;
    v_trusted_amount NUMERIC(10, 2);
    v_val_refunded_amount NUMERIC(10, 2);
    v_val_amount_refunded NUMERIC(10, 2);
    v_has_explicit_refund_amount BOOLEAN := false;
    v_gateway_verified BOOLEAN := false;
    v_gateway_refund_amount NUMERIC(10, 2);
    v_gateway_refund_payment_id TEXT;
    v_gateway_refund_currency TEXT;
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for verified refund processing.';
    END IF;

    v_clean_refund_id := NULLIF(trim(COALESCE(p_provider_refund_id, '')), '');
    IF v_clean_refund_id IS NULL OR length(v_clean_refund_id) < 5 THEN
        RAISE EXCEPTION 'Authoritative provider_refund_id is required.';
    END IF;

    IF p_refund_evidence IS NULL OR p_refund_evidence = '{}'::jsonb THEN
        RAISE EXCEPTION 'Authoritative provider refund confirmation evidence is required to execute refund reversal.';
    END IF;

    BEGIN
        v_webhook_event_id := NULLIF(trim(COALESCE(p_refund_evidence->>'webhook_event_id', '')), '')::UUID;
    EXCEPTION WHEN OTHERS THEN
        v_webhook_event_id := NULL;
    END;

    IF v_webhook_event_id IS NULL THEN
        RAISE EXCEPTION 'Authoritative verified webhook_event_id is required in refund evidence. Caller-supplied status JSON is not accepted.';
    END IF;

    SELECT * INTO v_webhook
    FROM public.provider_webhook_events
    WHERE id = v_webhook_event_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Referenced refund webhook event ID % does not exist in inbox.', v_webhook_event_id;
    END IF;

    IF v_webhook.signature_verification_status != 'verified' THEN
        RAISE EXCEPTION 'Security rejection: Refund webhook event % has unverified signature status ("%").',
            v_webhook_event_id, v_webhook.signature_verification_status;
    END IF;

    IF v_webhook.event_type NOT IN ('refund.succeeded', 'payment.refunded', 'charge.refunded', 'charge.updated') THEN
        RAISE EXCEPTION 'Unsupported refund webhook event type: "%".', v_webhook.event_type;
    END IF;

    IF v_webhook.event_type = 'charge.updated' AND v_webhook.provider_name != 'hitpay' THEN
        RAISE EXCEPTION 'Unsupported refund webhook event type: "%".', v_webhook.event_type;
    END IF;

    -- HitPay requires a distinct refund_id (charge/payment IDs alone are ambiguous and prohibited)
    IF v_webhook.provider_name = 'hitpay' THEN
        v_trusted_refund_id := NULLIF(trim(COALESCE(
            v_webhook.payload->>'refund_id',
            v_webhook.payload->>'provider_refund_id',
            v_webhook.payload->'refund'->>'id',
            ''
        )), '');
    ELSE
        v_trusted_refund_id := NULLIF(trim(COALESCE(
            v_webhook.payload->'data'->>'id',
            v_webhook.payload->>'provider_refund_id',
            v_webhook.payload->>'refund_id',
            ''
        )), '');
    END IF;

    IF v_trusted_refund_id IS NULL OR v_trusted_refund_id != v_clean_refund_id THEN
        RAISE EXCEPTION 'Evidence mismatch: Webhook refund ID ("%") does not match parameter ("%").',
            COALESCE(v_trusted_refund_id, 'NULL'), v_clean_refund_id;
    END IF;

    v_evidence_status := lower(NULLIF(trim(COALESCE(
        v_webhook.payload->'data'->'attributes'->>'status',
        v_webhook.payload->>'status',
        v_webhook.payload->>'refund_status',
        ''
    )), ''));

    IF v_evidence_status IS NULL OR v_evidence_status NOT IN ('succeeded', 'completed', 'paid', 'refunded', 'partially_refunded') THEN
        RAISE EXCEPTION 'Unconfirmed refund evidence: Webhook refund status "%" is not terminal succeeded.',
            COALESCE(v_evidence_status, 'NULL');
    END IF;

    IF p_refund_amount IS NULL OR p_refund_amount <= 0.00 THEN
        RAISE EXCEPTION 'Refund amount must be strictly positive. Got: ₱%', p_refund_amount;
    END IF;

    SELECT * INTO v_payment
    FROM public.payments
    WHERE id = p_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment record % not found for refund.', p_payment_id;
    END IF;

    IF v_webhook.provider_name != v_payment.provider_name THEN
        RAISE EXCEPTION 'Evidence mismatch: Webhook provider ("%") does not match payment provider ("%").',
            v_webhook.provider_name, v_payment.provider_name;
    END IF;

    IF NULLIF(trim(COALESCE(v_payment.provider_payment_id, '')), '') IS NULL THEN
        RAISE EXCEPTION 'Cannot refund payment %: original captured payment has no provider_payment_id.',
            p_payment_id;
    END IF;

    IF v_webhook.provider_name = 'hitpay' AND v_clean_refund_id = v_payment.provider_payment_id THEN
        RAISE EXCEPTION 'Ambiguous HitPay refund identity: refund ID "%" matches original charge ID.',
            v_clean_refund_id;
    END IF;

    -- Verify strict original payment linkage, explicit PHP currency, and tenant BEFORE idempotency or mutation
    DECLARE
        v_ev_payment_id TEXT;
        v_ev_session_id TEXT;
        v_ev_currency TEXT;
        v_ev_org_id TEXT;
    BEGIN
        IF v_webhook.provider_name = 'hitpay' THEN
            -- HitPay refunds MUST specify explicit payment_id/charge_id/provider_payment_id matching captured payment.
            v_ev_payment_id := NULLIF(trim(COALESCE(
                v_webhook.payload->>'payment_id',
                v_webhook.payload->>'charge_id',
                v_webhook.payload->>'provider_payment_id',
                ''
            )), '');
            v_ev_session_id := NULLIF(trim(COALESCE(
                v_webhook.payload->>'payment_request_id',
                ''
            )), '');

            IF v_ev_payment_id IS NULL THEN
                RAISE EXCEPTION 'Missing payment linkage: HitPay refund webhook must include payment_id/charge_id matching captured payment "%".',
                    v_payment.provider_payment_id;
            END IF;

            IF v_ev_payment_id != v_payment.provider_payment_id THEN
                RAISE EXCEPTION 'Evidence mismatch: HitPay refund payment ID ("%") does not match original captured payment ("%").',
                    v_ev_payment_id, v_payment.provider_payment_id;
            END IF;

            IF v_ev_session_id IS NOT NULL AND v_payment.checkout_session_id IS NOT NULL AND v_ev_session_id != v_payment.checkout_session_id THEN
                RAISE EXCEPTION 'Evidence mismatch: HitPay payment_request_id ("%") does not match stored checkout_session_id ("%").',
                    v_ev_session_id, v_payment.checkout_session_id;
            END IF;

            IF COALESCE((p_refund_evidence->>'gateway_refund_verified')::BOOLEAN, false) THEN
                v_gateway_refund_payment_id := NULLIF(trim(COALESCE(p_refund_evidence->>'gateway_refund_payment_id', '')), '');
                IF v_gateway_refund_payment_id IS NULL OR v_gateway_refund_payment_id != v_payment.provider_payment_id THEN
                    RAISE EXCEPTION 'Evidence mismatch: Verified HitPay refund payment ID ("%") does not match original captured payment ("%").',
                        COALESCE(v_gateway_refund_payment_id, 'NULL'), v_payment.provider_payment_id;
                END IF;

                v_gateway_refund_currency := upper(NULLIF(trim(COALESCE(p_refund_evidence->>'gateway_refund_currency', '')), ''));
                IF v_gateway_refund_currency IS NULL OR v_gateway_refund_currency != 'PHP' THEN
                    RAISE EXCEPTION 'Evidence mismatch: Verified HitPay refund requires explicit PHP currency, got "%".',
                        COALESCE(v_gateway_refund_currency, 'NULL');
                END IF;
            END IF;
        ELSE
            v_ev_payment_id := NULLIF(trim(COALESCE(
                v_webhook.payload->'data'->'attributes'->>'payment_id',
                v_webhook.payload->>'payment_id',
                v_webhook.payload->>'charge_id',
                v_webhook.payload->>'provider_payment_id',
                ''
            )), '');

            IF v_ev_payment_id IS NULL OR v_ev_payment_id != v_payment.provider_payment_id THEN
                RAISE EXCEPTION 'Evidence mismatch: Missing or mismatched original payment ID ("%") for payment ("%").',
                    COALESCE(v_ev_payment_id, 'NULL'), v_payment.provider_payment_id;
            END IF;
        END IF;

        v_ev_currency := upper(NULLIF(trim(COALESCE(
            v_webhook.payload->'data'->'attributes'->>'currency',
            v_webhook.payload->>'currency',
            ''
        )), ''));
        IF v_ev_currency IS NULL OR v_ev_currency != 'PHP' OR v_ev_currency != v_payment.currency THEN
            RAISE EXCEPTION 'Evidence mismatch: Missing or non-PHP refund currency ("%") for payment currency ("%").',
                COALESCE(v_ev_currency, 'NULL'), v_payment.currency;
        END IF;

        v_ev_org_id := NULLIF(trim(COALESCE(
            v_webhook.payload->'data'->'attributes'->'metadata'->>'organization_id',
            v_webhook.payload->'metadata'->>'organization_id',
            v_webhook.payload->>'organization_id',
            ''
        )), '');
        IF v_ev_org_id IS NOT NULL AND v_ev_org_id::uuid != v_payment.organization_id THEN
            RAISE EXCEPTION 'Evidence mismatch: Webhook organization ("%") does not match payment organization ("%").',
                v_ev_org_id, v_payment.organization_id;
        END IF;
    END;

    -- Idempotent replay check MUST run BEFORE payment status guard so repeated
    -- deliveries of a final refund (status='refunded') or partial refund replay safely.
    IF v_payment.verified_capture_evidence ? ('refund_' || v_clean_refund_id) THEN
        IF COALESCE((v_payment.verified_capture_evidence->('refund_' || v_clean_refund_id)->>'amount')::NUMERIC, p_refund_amount) != p_refund_amount THEN
            RAISE EXCEPTION 'Refund amount mismatch on replay for refund ID "%": stored ₱%, requested ₱%.',
                v_clean_refund_id,
                (v_payment.verified_capture_evidence->('refund_' || v_clean_refund_id)->>'amount'),
                p_refund_amount;
        END IF;

        IF v_webhook.processing_state != 'processed' THEN
            UPDATE public.provider_webhook_events
            SET processing_state = 'ignored_duplicate',
                processed_at = COALESCE(processed_at, now()),
                last_error = NULL
            WHERE id = v_webhook_event_id;
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'payment_id', v_payment.id,
            'provider_refund_id', v_clean_refund_id,
            'refund_amount', p_refund_amount,
            'total_refunded', v_payment.refunded_amount,
            'status', v_payment.status,
            'idempotent_replayed', true
        );
    END IF;

    IF v_webhook.processing_state = 'processed' THEN
        RAISE EXCEPTION 'Security rejection: Refund webhook event % has already been processed and cannot be reused.',
            v_webhook_event_id;
    END IF;

    IF v_payment.status NOT IN ('captured', 'partially_refunded') THEN
        RAISE EXCEPTION 'Cannot refund payment %: Current status is "%". Only captured or partially refunded payments can be refunded.',
            p_payment_id, v_payment.status;
    END IF;

    -- Validate refund amount semantics cleanly without guessing on ambiguous payloads
    IF v_webhook.provider_name = 'hitpay' THEN
        IF v_webhook.payload ? 'refunded_amount' THEN
            v_val_refunded_amount := ROUND((v_webhook.payload->>'refunded_amount')::NUMERIC, 2);
        END IF;
        IF v_webhook.payload ? 'amount_refunded' THEN
            v_val_amount_refunded := ROUND((v_webhook.payload->>'amount_refunded')::NUMERIC, 2);
        END IF;

        IF v_val_refunded_amount IS NOT NULL AND v_val_amount_refunded IS NOT NULL AND v_val_refunded_amount != v_val_amount_refunded THEN
            RAISE EXCEPTION 'Ambiguous HitPay refund payload: refunded_amount (₱%) disagrees with amount_refunded (₱%).',
                v_val_refunded_amount, v_val_amount_refunded;
        END IF;

        IF v_webhook.payload ? 'refund_amount' THEN
            v_has_explicit_refund_amount := true;
            v_trusted_amount := ROUND((v_webhook.payload->>'refund_amount')::NUMERIC, 2);
        ELSIF v_val_amount_refunded IS NOT NULL THEN
            v_trusted_amount := v_val_amount_refunded;
        ELSIF v_val_refunded_amount IS NOT NULL THEN
            v_trusted_amount := v_val_refunded_amount;
        ELSIF v_webhook.payload ? 'amount' THEN
            v_trusted_amount := ROUND((v_webhook.payload->>'amount')::NUMERIC, 2);
        END IF;

        v_gateway_verified := COALESCE((p_refund_evidence->>'gateway_refund_verified')::BOOLEAN, false);
        IF v_gateway_verified AND p_refund_evidence ? 'verified_refund_amount' THEN
            v_gateway_refund_amount := ROUND((p_refund_evidence->>'verified_refund_amount')::NUMERIC, 2);
        END IF;

        IF v_trusted_amount IS NULL THEN
            RAISE EXCEPTION 'Ambiguous HitPay refund payload: missing refund amount.';
        ELSIF v_trusted_amount = p_refund_amount THEN
            -- Unambiguous incremental match
            NULL;
        ELSIF NOT v_has_explicit_refund_amount
          AND v_gateway_verified
          AND v_gateway_refund_amount = p_refund_amount
          AND v_trusted_amount = ROUND(v_payment.refunded_amount + p_refund_amount, 2) THEN
            -- Gateway-verified cumulative charge refund field matches previous refunded_amount + incremental refund
            NULL;
        ELSE
            RAISE EXCEPTION 'Evidence mismatch or ambiguous HitPay refund amount: payload ₱%, cumulative expected ₱%, requested ₱%.',
                v_trusted_amount, ROUND(v_payment.refunded_amount + p_refund_amount, 2), p_refund_amount;
        END IF;
    ELSE
        IF v_webhook.payload->'data'->'attributes' ? 'amount' THEN
            v_trusted_amount := ((v_webhook.payload->'data'->'attributes'->>'amount')::NUMERIC / 100.00);
        ELSIF v_webhook.payload ? 'amount' THEN
            IF (v_webhook.payload->>'amount')::NUMERIC >= 10000 THEN
                v_trusted_amount := ((v_webhook.payload->>'amount')::NUMERIC / 100.00);
            ELSE
                v_trusted_amount := (v_webhook.payload->>'amount')::NUMERIC;
            END IF;
        END IF;

        IF v_trusted_amount IS NULL OR v_trusted_amount != p_refund_amount THEN
            RAISE EXCEPTION 'Evidence mismatch: Webhook refund amount (₱%) does not match requested refund amount (₱%).',
                v_trusted_amount, p_refund_amount;
        END IF;
    END IF;

    v_new_refunded_total := v_payment.refunded_amount + p_refund_amount;
    IF v_new_refunded_total > v_payment.captured_amount THEN
        RAISE EXCEPTION 'Refund amount violation: New total refund ₱% exceeds captured amount ₱%.',
            v_new_refunded_total, v_payment.captured_amount;
    END IF;

    IF v_new_refunded_total = v_payment.captured_amount THEN
        v_target_status := 'refunded';
    ELSE
        v_target_status := 'partially_refunded';
    END IF;

    UPDATE public.provider_webhook_events
    SET processing_state = 'processed',
        processed_at = now(),
        last_error = NULL
    WHERE id = v_webhook_event_id;

    UPDATE public.payments
    SET status = v_target_status,
        refunded_amount = v_new_refunded_total,
        verified_capture_evidence = verified_capture_evidence || jsonb_build_object(
            ('refund_' || v_clean_refund_id), jsonb_build_object(
                'provider_refund_id', v_clean_refund_id,
                'amount', p_refund_amount,
                'reason', p_reason,
                'evidence', p_refund_evidence,
                'refunded_at', now()
            )
        )
    WHERE id = v_payment.id;

    IF v_target_status = 'refunded' THEN
        UPDATE public.reservations
        SET status = 'cancelled',
            cancelled_at = now(),
            cancellation_reason = 'Refunded: ' || COALESCE(p_reason, 'Customer refund requested'),
            updated_at = now()
        WHERE id = v_payment.reservation_id
          AND status = 'confirmed';
    END IF;

    v_journal_res := public.post_refund_reversal_event(
        v_payment.organization_id,
        v_payment.facility_id,
        v_payment.reservation_id,
        p_refund_amount,
        v_payment.commission_rate,
        v_clean_key,
        p_metadata || jsonb_build_object(
            'reason', p_reason,
            'provider_refund_id', v_clean_refund_id,
            'is_partial', (v_target_status = 'partially_refunded'),
            'payment_id', v_payment.id
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'payment_id', v_payment.id,
        'provider_refund_id', v_clean_refund_id,
        'refund_amount', p_refund_amount,
        'total_refunded', v_new_refunded_total,
        'status', v_target_status,
        'journal_transaction_id', v_journal_res->>'transaction_id'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.process_verified_refund_event FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_verified_refund_event TO service_role;

COMMIT;
