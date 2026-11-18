-- ==============================================================================
-- LockaCourt (AratReserve) — Database Migration 005F
-- File: supabase/migrations/005f_hitpay_security_hardening.sql
-- Description: Edge-Only Checkout ACLs, HitPay Reference Verification & Safe Repeated Refunds
--
-- SAFETY & NON-DESTRUCTIVE POLICY:
--   - Migrations 001 through 005E remain 100% untouched.
--   - Enforces server-side-only execution on create_booking_checkout_session.
--   - Enforces HitPay booking reference matching during verified settlement.
--   - Hardens repeated/partial/final refund idempotency & ambiguity rejection.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. Restrict create_booking_checkout_session to service_role ONLY (Edge-only)
-- ==============================================================================
DO $$
DECLARE
    v_fn_sig TEXT;
BEGIN
    FOR v_fn_sig IN
        SELECT p.oid::regprocedure::text
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'create_booking_checkout_session'
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn_sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn_sig);
    END LOOP;
END $$;


-- ==============================================================================
-- 2. Harden process_verified_payment_event: Enforce Booking Reference Match for HitPay
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.process_verified_payment_event(
    p_webhook_event_id UUID,
    p_provider_name VARCHAR(50),
    p_provider_event_id VARCHAR(255),
    p_provider_payment_id VARCHAR(255),
    p_checkout_session_id VARCHAR(255),
    p_captured_amount NUMERIC(10, 2),
    p_currency VARCHAR(10),
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_key TEXT;
    v_clean_currency VARCHAR(10);
    v_clean_payment_id TEXT;
    v_clean_session_id TEXT;
    v_webhook RECORD;
    v_payment RECORD;
    v_reservation RECORD;
    v_is_hold_expired BOOLEAN := false;
    v_is_slot_conflicted BOOLEAN := false;
    v_journal_res JSONB;
    v_trusted_payment_id TEXT;
    v_trusted_session_id TEXT;
    v_trusted_amount NUMERIC(10, 2);
    v_trusted_currency VARCHAR(10);
    v_trusted_status TEXT;
    v_trusted_ref_code TEXT;
    v_existing_idemp RECORD;
BEGIN
    IF p_webhook_event_id IS NULL THEN
        RAISE EXCEPTION 'Authoritative verified webhook_event_id is required. Unsigned or unauthenticated execution is blocked.';
    END IF;

    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for verified payment processing.';
    END IF;

    v_clean_payment_id := NULLIF(trim(COALESCE(p_provider_payment_id, '')), '');
    v_clean_session_id := NULLIF(trim(COALESCE(p_checkout_session_id, '')), '');

    IF v_clean_payment_id IS NULL THEN
        RAISE EXCEPTION 'Authoritative provider_payment_id is required.';
    END IF;

    IF v_clean_session_id IS NULL THEN
        RAISE EXCEPTION 'Authoritative checkout_session_id is required.';
    END IF;

    v_clean_currency := upper(trim(COALESCE(p_currency, 'PHP')));
    IF v_clean_currency NOT IN ('PHP', '₱') THEN
        RAISE EXCEPTION 'Unsupported payment currency: "%". Expected PHP.', p_currency;
    END IF;

    IF p_captured_amount IS NULL OR p_captured_amount <= 0.00 THEN
        RAISE EXCEPTION 'Captured payment amount must be strictly positive. Got: ₱%', p_captured_amount;
    END IF;

    SELECT * INTO v_webhook
    FROM public.provider_webhook_events
    WHERE id = p_webhook_event_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Referenced webhook event ID % does not exist in inbox.', p_webhook_event_id;
    END IF;

    IF v_webhook.signature_verification_status != 'verified' THEN
        RAISE EXCEPTION 'Security rejection: Webhook event % has unverified signature status ("%"). Only verified webhooks can be processed.',
            p_webhook_event_id, v_webhook.signature_verification_status;
    END IF;

    IF v_webhook.provider_name != p_provider_name THEN
        RAISE EXCEPTION 'Provider mismatch: Webhook belongs to provider "%", but caller specified "%".',
            v_webhook.provider_name, p_provider_name;
    END IF;

    IF v_webhook.provider_event_id != p_provider_event_id THEN
        RAISE EXCEPTION 'Provider event ID mismatch: Webhook contains "%", but caller specified "%".',
            v_webhook.provider_event_id, p_provider_event_id;
    END IF;

    IF v_webhook.event_type NOT IN (
        'payment.paid',
        'checkout_session.payment.paid',
        'payment.captured',
        'payment_request.completed',
        'charge.created'
    ) THEN
        RAISE EXCEPTION 'Unsupported webhook event type: "%". Only payment capture events are permitted.',
            v_webhook.event_type;
    END IF;

    IF v_webhook.provider_name = 'hitpay' THEN
        IF v_webhook.event_type NOT IN ('payment_request.completed', 'charge.created') THEN
            RAISE EXCEPTION 'Unsupported HitPay capture event type: "%".', v_webhook.event_type;
        END IF;

        v_trusted_session_id := NULLIF(trim(COALESCE(
            v_webhook.payload->>'payment_request_id',
            v_webhook.payload->'payment_request'->>'id',
            CASE WHEN v_webhook.event_type = 'payment_request.completed' THEN v_webhook.payload->>'id' ELSE NULL END,
            v_webhook.payload->>'checkout_session_id',
            ''
        )), '');

        v_trusted_payment_id := NULLIF(trim(COALESCE(
            v_webhook.payload->>'payment_id',
            v_webhook.payload->>'provider_payment_id',
            v_webhook.payload->'payments'->0->>'id',
            v_webhook.payload->>'id',
            ''
        )), '');

        IF v_webhook.payload ? 'captured_amount' THEN
            v_trusted_amount := ROUND((v_webhook.payload->>'captured_amount')::NUMERIC, 2);
        ELSIF v_webhook.payload ? 'amount' THEN
            v_trusted_amount := ROUND((v_webhook.payload->>'amount')::NUMERIC, 2);
        END IF;

        v_trusted_currency := upper(NULLIF(trim(COALESCE(
            v_webhook.payload->>'currency',
            ''
        )), ''));

        v_trusted_status := lower(NULLIF(trim(COALESCE(
            v_webhook.payload->>'status',
            ''
        )), ''));

        v_trusted_ref_code := NULLIF(trim(COALESCE(
            p_metadata->>'reference_number',
            v_webhook.payload->>'reference_number',
            v_webhook.payload->'payment_request'->>'reference_number',
            ''
        )), '');
    ELSIF v_webhook.event_type = 'checkout_session.payment.paid' THEN
        DECLARE
            v_cs_resource JSONB;
            v_embedded_payment JSONB;
            v_embedded_pay_attrs JSONB;
        BEGIN
            v_cs_resource := COALESCE(
                v_webhook.payload->'data'->'attributes'->'data',
                v_webhook.payload->'data'->'data'
            );

            v_trusted_session_id := NULLIF(trim(COALESCE(
                v_cs_resource->>'id',
                v_webhook.payload->>'checkout_session_id',
                ''
            )), '');

            v_embedded_payment := COALESCE(
                v_cs_resource->'attributes'->'payments'->0,
                v_webhook.payload->'payments'->0
            );
            v_embedded_pay_attrs := COALESCE(
                v_embedded_payment->'attributes',
                v_embedded_payment
            );

            v_trusted_payment_id := NULLIF(trim(COALESCE(
                v_embedded_payment->>'id',
                ''
            )), '');

            IF v_embedded_pay_attrs ? 'amount' THEN
                v_trusted_amount := ((v_embedded_pay_attrs->>'amount')::NUMERIC / 100.00);
            END IF;

            v_trusted_currency := upper(NULLIF(trim(COALESCE(
                v_embedded_pay_attrs->>'currency',
                ''
            )), ''));

            v_trusted_status := lower(NULLIF(trim(COALESCE(
                v_embedded_pay_attrs->>'status',
                ''
            )), ''));
        END;
    ELSE
        v_trusted_payment_id := NULLIF(trim(COALESCE(
            v_webhook.payload->'data'->'attributes'->'data'->>'id',
            v_webhook.payload->'data'->>'id',
            v_webhook.payload->>'provider_payment_id',
            v_webhook.payload->>'payment_id',
            ''
        )), '');

        v_trusted_session_id := NULLIF(trim(COALESCE(
            v_webhook.payload->'data'->'attributes'->'data'->'attributes'->>'checkout_session_id',
            v_webhook.payload->'data'->'attributes'->'data'->'attributes'->'metadata'->>'checkout_session_id',
            v_webhook.payload->'data'->'attributes'->>'checkout_session_id',
            v_webhook.payload->'data'->'attributes'->'metadata'->>'checkout_session_id',
            v_webhook.payload->'data'->>'checkout_session_id',
            v_webhook.payload->>'checkout_session_id',
            ''
        )), '');

        IF v_webhook.payload->'data'->'attributes'->'data'->'attributes' ? 'amount' THEN
            v_trusted_amount := ((v_webhook.payload->'data'->'attributes'->'data'->'attributes'->>'amount')::NUMERIC / 100.00);
        ELSIF v_webhook.payload->'data'->'attributes' ? 'amount' THEN
            v_trusted_amount := ((v_webhook.payload->'data'->'attributes'->>'amount')::NUMERIC / 100.00);
        ELSIF v_webhook.payload ? 'captured_amount' THEN
            v_trusted_amount := (v_webhook.payload->>'captured_amount')::NUMERIC;
        ELSIF v_webhook.payload ? 'amount' THEN
            IF (v_webhook.payload->>'amount')::NUMERIC >= 10000 THEN
                v_trusted_amount := ((v_webhook.payload->>'amount')::NUMERIC / 100.00);
            ELSE
                v_trusted_amount := (v_webhook.payload->>'amount')::NUMERIC;
            END IF;
        END IF;

        v_trusted_currency := upper(NULLIF(trim(COALESCE(
            v_webhook.payload->'data'->'attributes'->'data'->'attributes'->>'currency',
            v_webhook.payload->'data'->'attributes'->>'currency',
            v_webhook.payload->>'currency',
            ''
        )), ''));

        v_trusted_status := lower(NULLIF(trim(COALESCE(
            v_webhook.payload->'data'->'attributes'->'data'->'attributes'->>'status',
            v_webhook.payload->'data'->'attributes'->>'status',
            v_webhook.payload->>'status',
            ''
        )), ''));
    END IF;

    IF v_trusted_payment_id IS NULL THEN
        RAISE EXCEPTION 'Missing trusted evidence: Webhook payload does not contain provider payment identity.';
    END IF;

    IF v_trusted_session_id IS NULL THEN
        RAISE EXCEPTION 'Missing trusted evidence: Webhook payload does not contain checkout session identity.';
    END IF;

    IF v_trusted_amount IS NULL OR v_trusted_amount <= 0.00 THEN
        RAISE EXCEPTION 'Missing trusted evidence: Webhook payload does not contain a valid positive amount.';
    END IF;

    IF v_trusted_currency IS NULL THEN
        RAISE EXCEPTION 'Missing trusted evidence: Webhook payload does not contain currency.';
    END IF;

    IF v_trusted_status IS NULL OR v_trusted_status NOT IN ('paid', 'succeeded', 'captured', 'completed') THEN
        RAISE EXCEPTION 'Invalid provider payment status: Webhook payload status "%" is not terminal paid/captured.',
            COALESCE(v_trusted_status, 'NULL');
    END IF;

    IF v_trusted_payment_id != v_clean_payment_id THEN
        RAISE EXCEPTION 'Evidence tampering detected: Caller provider_payment_id ("%") does not match verified webhook payload evidence ("%").',
            v_clean_payment_id, v_trusted_payment_id;
    END IF;

    IF v_trusted_session_id != v_clean_session_id THEN
        RAISE EXCEPTION 'Evidence tampering detected: Caller checkout_session_id ("%") does not match verified webhook payload evidence ("%").',
            v_clean_session_id, v_trusted_session_id;
    END IF;

    IF v_trusted_amount != p_captured_amount THEN
        RAISE EXCEPTION 'Evidence tampering detected: Caller captured_amount (₱%) does not match verified webhook payload evidence (₱%).',
            p_captured_amount, v_trusted_amount;
    END IF;

    IF v_trusted_currency != v_clean_currency THEN
        RAISE EXCEPTION 'Evidence tampering detected: Caller currency ("%") does not match verified webhook payload evidence ("%").',
            v_clean_currency, v_trusted_currency;
    END IF;

    IF v_webhook.processing_state = 'processed' THEN
        RETURN jsonb_build_object(
            'success', true,
            'status', 'already_processed',
            'idempotent_replayed', true,
            'provider_event_id', p_provider_event_id,
            'provider_payment_id', v_clean_payment_id
        );
    END IF;

    SELECT * INTO v_existing_idemp
    FROM public.booking_idempotency_keys
    WHERE idempotency_key = v_clean_key;

    IF FOUND THEN
        IF v_existing_idemp.request_fingerprint != md5(p_provider_name || '|' || p_provider_event_id || '|' || v_clean_payment_id || '|' || v_clean_session_id || '|' || p_captured_amount::text) THEN
            RAISE EXCEPTION 'Idempotency conflict: Key % is already bound to a different webhook event or payment identity.', v_clean_key;
        END IF;
    END IF;

    SELECT * INTO v_payment
    FROM public.payments
    WHERE checkout_session_id = v_clean_session_id
      AND provider_name = p_provider_name
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment record for provider "%" and checkout_session_id "%" not found.',
            p_provider_name, v_clean_session_id;
    END IF;

    IF v_payment.checkout_session_id LIKE 'cs_pending_%' THEN
        RAISE EXCEPTION 'Unbound payment: Payment record % was never bound to an authoritative provider checkout session.',
            v_payment.id;
    END IF;

    SELECT * INTO v_reservation
    FROM public.reservations
    WHERE id = v_payment.reservation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Associated reservation % for payment % does not exist.',
            v_payment.reservation_id, v_payment.id;
    END IF;

    -- For HitPay captures, require authoritative booking reference_number match
    IF p_provider_name = 'hitpay' THEN
        IF v_trusted_ref_code IS NULL THEN
            RAISE EXCEPTION 'Missing trusted evidence: HitPay capture is missing authoritative booking reference_number.';
        END IF;
        IF v_trusted_ref_code != v_reservation.reference_code THEN
            RAISE EXCEPTION 'Evidence mismatch: HitPay reference_number ("%") does not match stored reservation reference_code ("%").',
                v_trusted_ref_code, v_reservation.reference_code;
        END IF;
    END IF;

    IF v_payment.status = 'captured' THEN
        IF v_payment.provider_payment_id = v_clean_payment_id THEN
            UPDATE public.provider_webhook_events
            SET processing_state = 'ignored_duplicate',
                processed_at = COALESCE(processed_at, now()),
                last_error = NULL
            WHERE id = p_webhook_event_id;

            RETURN jsonb_build_object(
                'success', true,
                'status', 'already_captured',
                'idempotent_replayed', true,
                'payment_id', v_payment.id,
                'reservation_id', v_payment.reservation_id
            );
        ELSIF v_payment.provider_name = 'hitpay' AND v_payment.captured_amount = p_captured_amount THEN
            UPDATE public.provider_webhook_events
            SET processing_state = 'ignored_duplicate',
                processed_at = COALESCE(processed_at, now()),
                last_error = NULL
            WHERE id = p_webhook_event_id;

            RETURN jsonb_build_object(
                'success', true,
                'status', 'already_captured',
                'idempotent_replayed', true,
                'payment_id', v_payment.id,
                'reservation_id', v_payment.reservation_id
            );
        ELSE
            RAISE EXCEPTION 'Payment % is already captured under provider payment ID "%", cannot overwrite with "%".',
                v_payment.id, v_payment.provider_payment_id, v_clean_payment_id;
        END IF;
    END IF;

    IF v_reservation.hold_expires_at <= now() OR v_reservation.status = 'expired' THEN
        v_is_hold_expired := true;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.reservations
        WHERE court_id = v_reservation.court_id
          AND id != v_reservation.id
          AND status = 'confirmed'
          AND tstzrange(start_time, end_time, '[)') && tstzrange(v_reservation.start_time, v_reservation.end_time, '[)')
    ) THEN
        v_is_slot_conflicted := true;
    END IF;

    IF p_captured_amount != v_payment.expected_amount THEN
        UPDATE public.payments
        SET status = 'cancelled',
            provider_payment_id = v_clean_payment_id,
            verified_capture_evidence = verified_capture_evidence || jsonb_build_object(
                'webhook_event_id', p_webhook_event_id,
                'provider_event_id', p_provider_event_id,
                'amount_mismatch', true,
                'received_amount', p_captured_amount,
                'expected_amount', v_payment.expected_amount,
                'cancelled_at', now()
            ),
            updated_at = now()
        WHERE id = v_payment.id;

        UPDATE public.reservations
        SET status = 'cancelled',
            cancellation_reason = 'Payment amount mismatch: Expected ₱' || v_payment.expected_amount || ', received ₱' || p_captured_amount,
            cancelled_at = now(),
            updated_at = now()
        WHERE id = v_reservation.id;

        v_journal_res := public.post_excess_or_late_payment_event(
            v_payment.organization_id,
            v_payment.facility_id,
            v_reservation.id,
            p_captured_amount,
            false,
            v_clean_key,
            p_metadata || jsonb_build_object(
                'reason', 'amount_mismatch',
                'expected_amount', v_payment.expected_amount,
                'captured_amount', p_captured_amount,
                'provider_payment_id', v_clean_payment_id
            )
        );

        UPDATE public.provider_webhook_events
        SET processing_state = 'processed',
            processed_at = now(),
            last_error = NULL
        WHERE id = p_webhook_event_id;

        RETURN jsonb_build_object(
            'success', true,
            'outcome', 'amount_mismatch_liability_recorded',
            'reservation_id', v_reservation.id,
            'reservation_status', 'cancelled',
            'payment_id', v_payment.id,
            'requires_refund', true,
            'journal_transaction_id', v_journal_res->>'transaction_id'
        );
    END IF;

    IF NOT v_is_hold_expired AND NOT v_is_slot_conflicted AND v_reservation.status = 'pending' THEN
        UPDATE public.reservations
        SET status = 'confirmed',
            updated_at = now()
        WHERE id = v_reservation.id;

        UPDATE public.payments
        SET status = 'captured',
            captured_amount = p_captured_amount,
            provider_payment_id = v_clean_payment_id,
            verified_capture_evidence = verified_capture_evidence || jsonb_build_object(
                'webhook_event_id', p_webhook_event_id,
                'provider_event_id', p_provider_event_id,
                'reference_number', v_reservation.reference_code,
                'captured_at', now()
            ),
            updated_at = now()
        WHERE id = v_payment.id;

        v_journal_res := public.post_booking_settlement_event(
            v_payment.organization_id,
            v_payment.facility_id,
            v_reservation.id,
            p_captured_amount,
            v_payment.commission_rate,
            v_clean_key,
            p_metadata || jsonb_build_object(
                'webhook_event_id', p_webhook_event_id,
                'provider_payment_id', v_clean_payment_id,
                'checkout_session_id', v_clean_session_id,
                'reference_number', v_reservation.reference_code
            )
        );

        UPDATE public.provider_webhook_events
        SET processing_state = 'processed',
            processed_at = now(),
            last_error = NULL
        WHERE id = p_webhook_event_id;

        RETURN jsonb_build_object(
            'success', true,
            'outcome', 'confirmed_and_settled',
            'reservation_id', v_reservation.id,
            'reservation_status', 'confirmed',
            'payment_id', v_payment.id,
            'payment_status', 'captured',
            'journal_transaction_id', v_journal_res->>'transaction_id'
        );
    ELSE
        UPDATE public.reservations
        SET status = CASE WHEN v_reservation.status = 'confirmed' THEN 'confirmed' ELSE 'expired' END,
            cancellation_reason = 'Payment arrived after hold expired or slot collision occurred.',
            updated_at = now()
        WHERE id = v_reservation.id;

        UPDATE public.payments
        SET status = 'captured',
            captured_amount = p_captured_amount,
            provider_payment_id = v_clean_payment_id,
            verified_capture_evidence = verified_capture_evidence || jsonb_build_object(
                'webhook_event_id', p_webhook_event_id,
                'provider_event_id', p_provider_event_id,
                'late_payment', true,
                'is_hold_expired', v_is_hold_expired,
                'is_slot_conflicted', v_is_slot_conflicted,
                'captured_at', now()
            ),
            updated_at = now()
        WHERE id = v_payment.id;

        v_journal_res := public.post_excess_or_late_payment_event(
            v_payment.organization_id,
            v_payment.facility_id,
            v_reservation.id,
            p_captured_amount,
            true,
            v_clean_key,
            p_metadata || jsonb_build_object(
                'reason', 'hold_expired_or_slot_conflict',
                'captured_amount', p_captured_amount,
                'provider_payment_id', v_clean_payment_id
            )
        );

        UPDATE public.provider_webhook_events
        SET processing_state = 'processed',
            processed_at = now(),
            last_error = NULL
        WHERE id = p_webhook_event_id;

        RETURN jsonb_build_object(
            'success', true,
            'outcome', 'late_payment_liability_recorded',
            'reservation_id', v_reservation.id,
            'reservation_status', v_reservation.status,
            'payment_id', v_payment.id,
            'requires_refund', true,
            'journal_transaction_id', v_journal_res->>'transaction_id'
        );
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.process_verified_payment_event FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_verified_payment_event TO service_role;


-- ==============================================================================
-- 3. Harden process_verified_refund_event: Repeated Partial/Final Refunds & Ambiguity Rejection
-- ==============================================================================
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

    IF v_webhook.provider_name = 'hitpay' AND v_clean_refund_id = v_payment.provider_payment_id THEN
        RAISE EXCEPTION 'Ambiguous HitPay refund identity: refund ID "%" matches original charge ID.',
            v_clean_refund_id;
    END IF;

    -- Verify original payment linkage, currency, and tenant BEFORE idempotency or mutation
    DECLARE
        v_ev_payment_id TEXT;
        v_ev_session_id TEXT;
        v_ev_currency TEXT;
        v_ev_org_id TEXT;
    BEGIN
        v_ev_payment_id := NULLIF(trim(COALESCE(
            v_webhook.payload->'data'->'attributes'->>'payment_id',
            v_webhook.payload->>'payment_id',
            v_webhook.payload->>'charge_id',
            v_webhook.payload->>'provider_payment_id',
            CASE WHEN v_webhook.provider_name = 'hitpay' THEN v_webhook.payload->>'id' ELSE NULL END,
            ''
        )), '');
        v_ev_session_id := NULLIF(trim(COALESCE(
            v_webhook.payload->>'payment_request_id',
            ''
        )), '');

        IF v_webhook.provider_name = 'hitpay' AND v_ev_session_id IS NOT NULL AND v_ev_session_id = v_payment.checkout_session_id THEN
            IF v_ev_payment_id IS NOT NULL AND v_payment.provider_payment_id IS NOT NULL AND v_ev_payment_id != v_payment.provider_payment_id THEN
                RAISE EXCEPTION 'Evidence mismatch: Webhook payment_id ("%") does not match stored payment ("%")',
                    v_ev_payment_id, v_payment.provider_payment_id;
            END IF;
        ELSIF v_ev_payment_id IS NULL OR v_ev_payment_id != v_payment.provider_payment_id THEN
            RAISE EXCEPTION 'Evidence mismatch: Missing or mismatched original payment ID ("%") for payment ("%").',
                COALESCE(v_ev_payment_id, 'NULL'), v_payment.provider_payment_id;
        END IF;

        v_ev_currency := upper(NULLIF(trim(COALESCE(
            v_webhook.payload->'data'->'attributes'->>'currency',
            v_webhook.payload->>'currency',
            ''
        )), ''));
        IF v_ev_currency IS NULL OR v_ev_currency != v_payment.currency THEN
            RAISE EXCEPTION 'Evidence mismatch: Missing or mismatched currency ("%") for payment currency ("%").',
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
