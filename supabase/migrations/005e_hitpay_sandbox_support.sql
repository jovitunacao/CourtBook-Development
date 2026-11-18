-- ==============================================================================
-- LockaCourt (AratReserve) — Database Migration 005E
-- File: supabase/migrations/005e_hitpay_sandbox_support.sql
-- Description: Additive HitPay Sandbox Payment Support (Stage 2)
--
-- SAFETY & NON-DESTRUCTIVE POLICY:
--   - Migrations 001 through 005D remain 100% untouched.
--   - Additive schema and RPC updates only; preserves balanced double-entry
--     ledger invariants, 5% commission snapshots, and PayMongo compatibility.
--   - Automatic owner payouts remain strictly disabled.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. Extend provider_name CHECK Constraints to Include 'hitpay'
-- ==============================================================================
DO $$
DECLARE
    v_table TEXT;
    v_con_name TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'payments',
        'provider_webhook_events',
        'settlement_batches',
        'payout_methods'
    ] LOOP
        FOR v_con_name IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public'
              AND t.relname = v_table
              AND c.contype = 'c'
              AND pg_get_constraintdef(c.oid) ~ 'provider_name'
        LOOP
            EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', v_table, v_con_name);
        END LOOP;

        EXECUTE format(
            'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (provider_name IN (''paymongo'', ''hitpay'', ''xendit'', ''manual_test''))',
            v_table,
            'chk_' || v_table || '_provider_name'
        );
    END LOOP;
END $$;


-- ==============================================================================
-- 2. Extend create_booking_checkout_session to Support 'hitpay'
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.create_booking_checkout_session(
    p_idempotency_key TEXT,
    p_facility_id UUID,
    p_court_id UUID,
    p_customer_name TEXT,
    p_customer_phone TEXT,
    p_customer_email TEXT,
    p_booking_date DATE,
    p_start_time TIMESTAMPTZ,
    p_duration_minutes INT DEFAULT 60,
    p_provider_name TEXT DEFAULT 'paymongo'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_key TEXT;
    v_facility RECORD;
    v_court RECORD;
    v_end_time TIMESTAMPTZ;
    v_local_start TIMESTAMP;
    v_local_end TIMESTAMP;
    v_local_open TIMESTAMP;
    v_local_close TIMESTAMP;
    v_total_price NUMERIC(10, 2);
    v_commission_rate NUMERIC(6, 4) := 0.0500;
    v_commission_amount NUMERIC(10, 2);
    v_owner_gross_share NUMERIC(10, 2);
    v_reference_code TEXT;
    v_reservation_id UUID;
    v_payment_id UUID;
    v_time_slot_label TEXT;
    v_hold_minutes INT;
    v_hold_expires_at TIMESTAMPTZ;
    v_existing_idemp RECORD;
    v_clean_provider VARCHAR(50);
    v_fingerprint TEXT;
    v_active_holds INT;
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'p_idempotency_key is required and cannot be NULL or empty.';
    END IF;

    IF length(v_clean_key) < 16 OR length(v_clean_key) > 128 THEN
        RAISE EXCEPTION 'Invalid idempotency_key length. Must be between 16 and 128 characters.';
    END IF;

    IF p_facility_id IS NULL OR
       p_court_id IS NULL OR
       p_customer_name IS NULL OR
       p_booking_date IS NULL OR
       p_start_time IS NULL OR
       p_duration_minutes IS NULL THEN
        RAISE EXCEPTION 'Required booking parameters (facility_id, court_id, customer_name, booking_date, start_time, duration_minutes) cannot be NULL.';
    END IF;

    IF char_length(trim(p_customer_name)) < 2 OR char_length(trim(p_customer_name)) > 100 THEN
        RAISE EXCEPTION 'Customer name must be between 2 and 100 characters.';
    END IF;

    IF trim(p_customer_name) ~* '[\r\n\t<>]' THEN
        RAISE EXCEPTION 'Customer name contains invalid characters.';
    END IF;

    IF (p_customer_phone IS NULL OR trim(p_customer_phone) = '') AND
       (p_customer_email IS NULL OR trim(p_customer_email) = '') THEN
        RAISE EXCEPTION 'At least one contact method (phone or email) is required.';
    END IF;

    IF p_customer_email IS NOT NULL AND trim(p_customer_email) != '' THEN
        IF p_customer_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' OR char_length(p_customer_email) > 255 THEN
            RAISE EXCEPTION 'Invalid customer email address format.';
        END IF;
    END IF;

    IF p_duration_minutes < 30 OR p_duration_minutes > 480 OR (p_duration_minutes % 30 != 0) THEN
        RAISE EXCEPTION 'Booking duration must be between 30 minutes and 8 hours in 30-minute intervals.';
    END IF;

    IF p_start_time <= now() THEN
        RAISE EXCEPTION 'Cannot book reservations in the past.';
    END IF;

    v_clean_provider := lower(trim(COALESCE(p_provider_name, 'paymongo')));
    IF v_clean_provider NOT IN ('paymongo', 'hitpay', 'xendit', 'manual_test') THEN
        RAISE EXCEPTION 'Unsupported payment provider: "%". Must be paymongo, hitpay, xendit, or manual_test.', v_clean_provider;
    END IF;

    SELECT COUNT(*) INTO v_active_holds
    FROM public.reservations
    WHERE status = 'pending'
      AND hold_expires_at > now()
      AND (
          (p_customer_phone IS NOT NULL AND customer_phone = trim(p_customer_phone)) OR
          (p_customer_email IS NOT NULL AND lower(customer_email) = lower(trim(p_customer_email)))
      );

    IF v_active_holds >= 3 THEN
        RAISE EXCEPTION 'Anti-abuse limit exceeded: Too many active pending checkout holds for this contact. Please complete or wait for existing holds to expire.';
    END IF;

    v_fingerprint := md5(
        p_facility_id::text || '|' ||
        p_court_id::text || '|' ||
        p_booking_date::text || '|' ||
        p_start_time::text || '|' ||
        p_duration_minutes::text || '|' ||
        lower(trim(p_customer_name)) || '|' ||
        COALESCE(trim(p_customer_phone), '') || '|' ||
        COALESCE(lower(trim(p_customer_email)), '')
    );

    SELECT * INTO v_existing_idemp
    FROM public.booking_idempotency_keys
    WHERE idempotency_key = v_clean_key;

    IF FOUND THEN
        IF v_existing_idemp.request_fingerprint != v_fingerprint THEN
            RAISE EXCEPTION 'Idempotency conflict: Key % was previously used with different booking request parameters.', v_clean_key;
        END IF;

        IF v_existing_idemp.status = 'completed' AND v_existing_idemp.response_payload IS NOT NULL THEN
            IF v_existing_idemp.reservation_id IS NOT NULL THEN
                RETURN v_existing_idemp.response_payload || jsonb_build_object('idempotent_replayed', true);
            END IF;
        END IF;
    END IF;

    UPDATE public.reservations
    SET status = 'expired', updated_at = now()
    WHERE court_id = p_court_id
      AND status = 'pending'
      AND hold_expires_at <= now();

    UPDATE public.payments
    SET status = 'cancelled', updated_at = now()
    WHERE facility_id = p_facility_id
      AND status = 'pending'
      AND expires_at <= now();

    SELECT default_commission_rate INTO v_commission_rate
    FROM public.platform_billing_config
    WHERE id = 1;

    IF NOT FOUND OR v_commission_rate IS NULL THEN
        v_commission_rate := 0.0500;
    END IF;

    SELECT * INTO v_facility
    FROM public.facilities
    WHERE id = p_facility_id AND is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Facility is not active or does not exist.';
    END IF;

    SELECT * INTO v_court
    FROM public.courts
    WHERE id = p_court_id AND facility_id = p_facility_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Court % not found in facility %.', p_court_id, p_facility_id;
    END IF;

    IF NOT v_court.is_enabled THEN
        RAISE EXCEPTION 'Court % is not currently active for bookings.', v_court.name;
    END IF;

    v_end_time := p_start_time + (p_duration_minutes || ' minutes')::INTERVAL;
    v_local_start := p_start_time AT TIME ZONE v_facility.timezone;
    v_local_end   := v_end_time AT TIME ZONE v_facility.timezone;

    IF v_local_start::date != p_booking_date THEN
        RAISE EXCEPTION 'Booking date (%) does not match the facility local start date (%).',
            p_booking_date, v_local_start::date;
    END IF;

    v_local_open  := date_trunc('day', v_local_start) + (v_facility.open_hour || ' hours')::INTERVAL;
    v_local_close := date_trunc('day', v_local_start) + (v_facility.close_hour || ' hours')::INTERVAL;

    IF v_local_start < v_local_open OR v_local_end > v_local_close THEN
        RAISE EXCEPTION 'Selected booking time falls outside facility operating hours (%:00 – %:00 %)',
            v_facility.open_hour, v_facility.close_hour, v_facility.timezone;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.court_blocked_times
        WHERE court_id = p_court_id
          AND tstzrange(start_time, end_time, '[)') && tstzrange(p_start_time, v_end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'Court is blocked for maintenance or private club event during this time slot.';
    END IF;

    v_total_price := ROUND((v_court.hourly_rate * (p_duration_minutes::NUMERIC / 60.0)), 2);
    v_commission_amount := ROUND((v_total_price * v_commission_rate), 2);
    v_owner_gross_share := v_total_price - v_commission_amount;

    v_hold_minutes := LEAST(GREATEST(COALESCE(v_facility.hold_duration_minutes, 15), 5), 30);
    v_hold_expires_at := now() + (v_hold_minutes || ' minutes')::INTERVAL;

    v_reference_code := public.generate_booking_ref();
    v_time_slot_label := to_char(v_local_start, 'HH12:MI AM') || ' – ' || to_char(v_local_end, 'HH12:MI AM');
    v_reservation_id := gen_random_uuid();
    v_payment_id := gen_random_uuid();

    INSERT INTO public.reservations (
        id,
        facility_id,
        court_id,
        reference_code,
        customer_name,
        customer_phone,
        customer_email,
        booking_date,
        start_time,
        end_time,
        time_slot_label,
        duration_minutes,
        price,
        currency,
        status,
        hold_expires_at,
        created_at,
        updated_at
    ) VALUES (
        v_reservation_id,
        p_facility_id,
        p_court_id,
        v_reference_code,
        trim(p_customer_name),
        NULLIF(trim(p_customer_phone), ''),
        NULLIF(trim(p_customer_email), ''),
        p_booking_date,
        p_start_time,
        v_end_time,
        v_time_slot_label,
        p_duration_minutes,
        v_total_price,
        v_facility.currency,
        'pending',
        v_hold_expires_at,
        now(),
        now()
    );

    INSERT INTO public.payments (
        id,
        organization_id,
        facility_id,
        reservation_id,
        expected_amount,
        currency,
        commission_rate,
        commission_amount,
        owner_gross_share,
        status,
        provider_name,
        checkout_session_id,
        expires_at,
        verified_capture_evidence
    ) VALUES (
        v_payment_id,
        v_facility.organization_id,
        p_facility_id,
        v_reservation_id,
        v_total_price,
        'PHP',
        v_commission_rate,
        v_commission_amount,
        v_owner_gross_share,
        'pending',
        v_clean_provider,
        NULL,
        v_hold_expires_at,
        jsonb_build_object(
            'checkout_idempotency_key', v_clean_key,
            'hold_duration_minutes', v_hold_minutes,
            'reference_code', v_reference_code,
            'provider_name', v_clean_provider
        )
    );

    INSERT INTO public.booking_idempotency_keys (
        idempotency_key,
        request_fingerprint,
        status,
        facility_id,
        court_id,
        booking_date,
        start_time,
        reservation_id,
        response_payload,
        created_at,
        expires_at
    ) VALUES (
        v_clean_key,
        v_fingerprint,
        'completed',
        p_facility_id,
        p_court_id,
        p_booking_date,
        p_start_time,
        v_reservation_id,
        jsonb_build_object(
            'success', true,
            'reservation_id', v_reservation_id,
            'payment_id', v_payment_id,
            'reference_code', v_reference_code,
            'provider_name', v_clean_provider,
            'checkout_session_id', 'cs_pending_' || replace(v_payment_id::text, '-', ''),
            'expected_amount', v_total_price,
            'currency', 'PHP',
            'commission_rate', v_commission_rate,
            'commission_amount', v_commission_amount,
            'owner_gross_share', v_owner_gross_share,
            'hold_expires_at', v_hold_expires_at,
            'time_slot_label', v_time_slot_label,
            'court_name', v_court.name
        ),
        now(),
        now() + INTERVAL '24 hours'
    )
    ON CONFLICT (idempotency_key) DO UPDATE
    SET response_payload = EXCLUDED.response_payload,
        reservation_id = EXCLUDED.reservation_id,
        status = 'completed';

    RETURN jsonb_build_object(
        'success', true,
        'reservation_id', v_reservation_id,
        'payment_id', v_payment_id,
        'reference_code', v_reference_code,
        'provider_name', v_clean_provider,
        'checkout_session_id', 'cs_pending_' || replace(v_payment_id::text, '-', ''),
        'expected_amount', v_total_price,
        'currency', 'PHP',
        'commission_rate', v_commission_rate,
        'commission_amount', v_commission_amount,
        'owner_gross_share', v_owner_gross_share,
        'hold_expires_at', v_hold_expires_at,
        'time_slot_label', v_time_slot_label,
        'court_name', v_court.name
    );
EXCEPTION
    WHEN exclusion_violation THEN
        RAISE EXCEPTION 'Target court slot is already reserved or held for checkout by another customer.';
END;
$$;


-- ==============================================================================
-- 3. Extend bind_provider_checkout_session for HitPay + Strict Provider Match
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.bind_provider_checkout_session(
    p_payment_id UUID,
    p_reservation_id UUID,
    p_provider_name VARCHAR(50),
    p_checkout_session_id VARCHAR(255),
    p_checkout_url TEXT,
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
    v_clean_session_id TEXT;
    v_clean_provider VARCHAR(50);
    v_payment RECORD;
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for checkout session binding.';
    END IF;

    v_clean_provider := lower(trim(COALESCE(p_provider_name, '')));
    IF v_clean_provider NOT IN ('paymongo', 'hitpay', 'xendit', 'manual_test') THEN
        RAISE EXCEPTION 'Unsupported payment provider "%" for checkout binding.', p_provider_name;
    END IF;

    v_clean_session_id := NULLIF(trim(COALESCE(p_checkout_session_id, '')), '');
    IF v_clean_session_id IS NULL OR length(v_clean_session_id) < 8 THEN
        RAISE EXCEPTION 'Valid provider checkout_session_id is required for binding.';
    END IF;

    IF v_clean_session_id ~ '^cs_pending_' THEN
        RAISE EXCEPTION 'Pending placeholder checkout_session_id cannot be bound as an authoritative provider session.';
    END IF;

    IF v_clean_provider = 'paymongo' AND v_clean_session_id !~ '^cs_' THEN
        RAISE EXCEPTION 'Invalid PayMongo checkout session ID format. Must begin with "cs_".';
    END IF;

    IF v_clean_provider = 'hitpay' THEN
        IF v_clean_session_id ~ '^cs_(manual|sandbox|demo)_' OR v_clean_session_id ~ '\s' THEN
            RAISE EXCEPTION 'Invalid HitPay payment request ID format "%".', v_clean_session_id;
        END IF;
        IF p_checkout_url IS NOT NULL AND p_checkout_url !~* '^https://([a-z0-9-]+\.)*sandbox\.hit-pay\.com/' THEN
            RAISE EXCEPTION 'HitPay Stage 2 checkout URL must belong to sandbox.hit-pay.com.';
        END IF;
    END IF;

    SELECT * INTO v_payment
    FROM public.payments
    WHERE id = p_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment record % not found for checkout binding.', p_payment_id;
    END IF;

    IF v_payment.reservation_id != p_reservation_id THEN
        RAISE EXCEPTION 'Mismatched reservation: Payment % does not belong to reservation %.', p_payment_id, p_reservation_id;
    END IF;

    IF v_payment.provider_name IS DISTINCT FROM v_clean_provider THEN
        RAISE EXCEPTION 'Provider mismatch: Payment % is initialized for provider "%", cannot bind provider "%".',
            p_payment_id, v_payment.provider_name, v_clean_provider;
    END IF;

    IF v_payment.status != 'pending' THEN
        RAISE EXCEPTION 'Payment % is in status "%"; can only bind provider checkout sessions to pending payments.',
            p_payment_id, v_payment.status;
    END IF;

    IF v_payment.expires_at <= now() THEN
        RAISE EXCEPTION 'Cannot bind checkout session: Booking hold has already expired.';
    END IF;

    IF v_payment.checkout_session_id = v_clean_session_id THEN
        RETURN jsonb_build_object(
            'success', true,
            'payment_id', v_payment.id,
            'reservation_id', p_reservation_id,
            'provider_name', v_clean_provider,
            'checkout_session_id', v_clean_session_id,
            'status', 'already_bound',
            'idempotent_replayed', true
        );
    END IF;

    IF v_payment.checkout_session_id IS NOT NULL THEN
        RAISE EXCEPTION 'Payment % is already bound to provider session "%". Rebinding is prohibited.',
            p_payment_id, v_payment.checkout_session_id;
    END IF;

    UPDATE public.payments
    SET checkout_session_id = v_clean_session_id,
        verified_capture_evidence = verified_capture_evidence || jsonb_build_object(
            'checkout_url', p_checkout_url,
            'bound_at', now(),
            'binding_idempotency_key', v_clean_key,
            'binding_metadata', p_metadata
        ),
        updated_at = now()
    WHERE id = v_payment.id;

    UPDATE public.booking_idempotency_keys
    SET response_payload = response_payload || jsonb_build_object(
        'provider_name', v_clean_provider,
        'checkout_session_id', v_clean_session_id,
        'checkout_url', p_checkout_url
    )
    WHERE reservation_id = p_reservation_id;

    RETURN jsonb_build_object(
        'success', true,
        'payment_id', v_payment.id,
        'reservation_id', p_reservation_id,
        'provider_name', v_clean_provider,
        'checkout_session_id', v_clean_session_id,
        'checkout_url', p_checkout_url,
        'status', 'bound'
    );
END;
$$;


-- ==============================================================================
-- 4. Extend process_verified_payment_event for HitPay Decimal Amounts & Events
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

    -- Extract and Verify Trusted Payload Evidence per Provider
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

        -- HitPay amounts are strictly decimal PHP values (e.g. "350.00", "12500.00"). Never divide by 100.
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
            -- HitPay can emit both charge.created and payment_request.completed for the same
            -- payment_request_id. Preserve existing immutable provider_payment_id and zero double-posting.
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

    SELECT * INTO v_reservation
    FROM public.reservations
    WHERE id = v_payment.reservation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Associated reservation % for payment % does not exist.',
            v_payment.reservation_id, v_payment.id;
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
                'checkout_session_id', v_clean_session_id
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


-- ==============================================================================
-- 5. Extend process_verified_refund_event for HitPay Refund Webhooks
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

    IF v_webhook.processing_state = 'processed' THEN
        RAISE EXCEPTION 'Security rejection: Refund webhook event % has already been processed and cannot be reused.',
            v_webhook_event_id;
    END IF;

    IF v_webhook.event_type NOT IN ('refund.succeeded', 'payment.refunded', 'charge.refunded', 'charge.updated') THEN
        RAISE EXCEPTION 'Unsupported refund webhook event type: "%".', v_webhook.event_type;
    END IF;

    IF v_webhook.event_type = 'charge.updated' AND v_webhook.provider_name != 'hitpay' THEN
        RAISE EXCEPTION 'Unsupported refund webhook event type: "%".', v_webhook.event_type;
    END IF;

    IF v_webhook.provider_name = 'hitpay' THEN
        v_trusted_refund_id := NULLIF(trim(COALESCE(
            v_webhook.payload->>'refund_id',
            v_webhook.payload->>'provider_refund_id',
            v_webhook.payload->>'id',
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

    IF v_webhook.provider_name = 'hitpay' THEN
        IF v_webhook.payload ? 'refunded_amount' THEN
            v_trusted_amount := ROUND((v_webhook.payload->>'refunded_amount')::NUMERIC, 2);
        ELSIF v_webhook.payload ? 'amount_refunded' THEN
            v_trusted_amount := ROUND((v_webhook.payload->>'amount_refunded')::NUMERIC, 2);
        ELSIF v_webhook.payload ? 'amount' THEN
            v_trusted_amount := ROUND((v_webhook.payload->>'amount')::NUMERIC, 2);
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
    END IF;

    IF v_trusted_amount IS NULL OR v_trusted_amount != p_refund_amount THEN
        RAISE EXCEPTION 'Evidence mismatch: Webhook refund amount (₱%) does not match requested refund amount (₱%).',
            v_trusted_amount, p_refund_amount;
    END IF;

    SELECT * INTO v_payment
    FROM public.payments
    WHERE id = p_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment record % not found for refund.', p_payment_id;
    END IF;

    IF v_payment.status NOT IN ('captured', 'partially_refunded') THEN
        RAISE EXCEPTION 'Cannot refund payment %: Current status is "%". Only captured payments can be refunded.',
            p_payment_id, v_payment.status;
    END IF;

    IF v_webhook.provider_name != v_payment.provider_name THEN
        RAISE EXCEPTION 'Evidence mismatch: Webhook provider ("%") does not match payment provider ("%").',
            v_webhook.provider_name, v_payment.provider_name;
    END IF;

    DECLARE
        v_ev_payment_id TEXT;
        v_ev_session_id TEXT;
        v_ev_currency TEXT;
        v_ev_org_id TEXT;
    BEGIN
        v_ev_payment_id := NULLIF(trim(COALESCE(
            v_webhook.payload->'data'->'attributes'->>'payment_id',
            v_webhook.payload->>'payment_id',
            v_webhook.payload->>'provider_payment_id',
            CASE WHEN v_webhook.provider_name = 'hitpay' THEN v_webhook.payload->>'id' ELSE NULL END,
            ''
        )), '');
        v_ev_session_id := NULLIF(trim(COALESCE(
            v_webhook.payload->>'payment_request_id',
            ''
        )), '');

        IF v_webhook.provider_name = 'hitpay' AND v_ev_session_id IS NOT NULL AND v_ev_session_id = v_payment.checkout_session_id THEN
            NULL; -- Matched via HitPay payment_request_id
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

    UPDATE public.provider_webhook_events
    SET processing_state = 'processed',
        processed_at = now()
    WHERE id = v_webhook_event_id;

    IF v_payment.verified_capture_evidence ? ('refund_' || v_clean_refund_id) THEN
        RETURN jsonb_build_object(
            'success', true,
            'payment_id', v_payment.id,
            'provider_refund_id', v_clean_refund_id,
            'status', v_payment.status,
            'idempotent_replayed', true
        );
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

    UPDATE public.payments
    SET status = v_target_status,
        refunded_amount = v_new_refunded_total,
        verified_capture_evidence = verified_capture_evidence || jsonb_build_object(
            'last_refund_reason', p_reason,
            'last_refund_at', now(),
            ('refund_' || v_clean_refund_id), jsonb_build_object(
                'provider_refund_id', v_clean_refund_id,
                'amount', p_refund_amount,
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
            'is_partial', p_is_partial,
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

COMMIT;
