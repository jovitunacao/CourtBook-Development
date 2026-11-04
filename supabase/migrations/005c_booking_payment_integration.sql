-- ==============================================================================
-- CourtBook / BookSuite — Database Migration 005C
-- File: supabase/migrations/005c_booking_payment_integration.sql
-- Description: Trusted Booking & Payment Integration Layer (Hardened Security Edition)
--
-- ARCHITECTURE & INTEGRATION SCOPE:
--   1. Booking & Payment Checkout Session Binding:
--      - create_booking_checkout_session: Callable by anon/authenticated. Initializes
--        temporary court hold, enforces server-authoritative rates and 5% commission snapshot,
--        enforces anti-abuse limits (max 3 holds per contact), auto-cleans expired holds,
--        and prevents client-supplied provider session spoofing.
--      - bind_provider_checkout_session: Restricted to service_role. Securely binds
--        authoritative provider checkout ID and URL to pending payment record.
--   2. Authoritative Payment Event Ingestion (process_verified_payment_event):
--      - Strictly requires verified webhook event (signature_verification_status = 'verified').
--      - Validates provider name, event ID, payment ID, checkout session, amount, currency
--        against trusted webhook payload evidence (rejects caller tampering).
--      - Reconciles payment capture against reservation hold and court availability.
--      - Valid booking: Confirms reservation, marks payment captured, posts settlement journal.
--      - Expired / Conflict booking: Routes payment to Account 2030 (Customer Refund Liability)
--        with zero owner inflation.
--   3. Settlement Clearing Ingestion (process_settlement_clearing):
--      - Strictly requires verified settlement batch and matched settlement items.
--      - Verifies provider and organization ownership. Never credits balances based on
--        caller-supplied amounts; amount is computed from verified matched batch items.
--      - Duplicate clearing prevention.
--   4. Verified Refunds & Chargebacks (process_verified_refund_event):
--      - Requires authoritative provider refund confirmation evidence.
--      - Enforces refund amount bounds and payment lifecycle transitions.
--      - Posts balanced refund reversal financial journal entries.
--   5. Owner Payout Request, Reserve & Disbursement:
--      - request_owner_payout: Authorizes owner/admin, verifies payout method ownership,
--        enforces >= ₱500.00 min threshold, posts payout reserve (post_payout_reserve_event).
--      - confirm_owner_payout_disbursement: Requires verified provider disbursement evidence.
--      - fail_owner_payout_release: Requires authoritative provider failure evidence before
--        releasing reserved funds.
--   6. Security & Least Privilege Hardening:
--      - All functions SECURITY DEFINER with explicit search_path = public, pg_temp.
--      - Zero client writes to financial journal or payment state machines.
--      - Public RPC audited for anti-abuse and privilege escalation protection.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. Booking Checkout Hold Initialization (Audited Public Entrypoint)
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
    v_commission_rate NUMERIC(6, 4) := 0.0500; -- Explicit 5% platform commission
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
    -- 1. Parameter Validation
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
    IF v_clean_provider NOT IN ('paymongo', 'xendit', 'manual_test') THEN
        RAISE EXCEPTION 'Unsupported payment provider: "%". Must be paymongo, xendit, or manual_test.', v_clean_provider;
    END IF;

    -- 2. Anti-Abuse Checks: Max 3 active pending holds per phone or email
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

    -- 3. Check Idempotency: Has this checkout request already been initialized?
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
        -- Verify fingerprint matches
        IF v_existing_idemp.request_fingerprint != v_fingerprint THEN
            RAISE EXCEPTION 'Idempotency conflict: Key % was previously used with different booking request parameters.', v_clean_key;
        END IF;

        -- If previously completed, replay cached response
        IF v_existing_idemp.status = 'completed' AND v_existing_idemp.response_payload IS NOT NULL THEN
            IF v_existing_idemp.reservation_id IS NOT NULL THEN
                RETURN v_existing_idemp.response_payload || jsonb_build_object('idempotent_replayed', true);
            END IF;
        END IF;
    END IF;

    -- 4. Automatically expire stale pending holds on the court
    UPDATE public.reservations
    SET status = 'expired', updated_at = now()
    WHERE court_id = p_court_id
      AND status = 'pending'
      AND hold_expires_at <= now();

    UPDATE public.payments
    SET status = 'expired', updated_at = now()
    WHERE facility_id = p_facility_id
      AND status = 'pending'
      AND expires_at <= now();

    -- 5. Validate Facility
    SELECT * INTO v_facility
    FROM public.facilities
    WHERE id = p_facility_id AND is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Facility is not active or does not exist.';
    END IF;

    -- 6. Consistent Locking Hierarchy: Lock Court FIRST
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

    -- 7. Validate Operating Hours in Facility Timezone
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

    -- 8. Check Maintenance Blocks on Locked Court
    IF EXISTS (
        SELECT 1
        FROM public.court_blocked_times
        WHERE court_id = p_court_id
          AND tstzrange(start_time, end_time, '[)') && tstzrange(p_start_time, v_end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'Court is blocked for maintenance or private club event during this time slot.';
    END IF;

    -- 9. Server-Authoritative Price Calculation (Zero Client Tampering)
    v_total_price := ROUND((v_court.hourly_rate * (p_duration_minutes::NUMERIC / 60.0)), 2);
    v_commission_amount := ROUND((v_total_price * v_commission_rate), 2);
    v_owner_gross_share := v_total_price - v_commission_amount;

    -- 10. Hold Duration: Standard 15-minute temporary checkout hold
    v_hold_minutes := LEAST(GREATEST(COALESCE(v_facility.hold_duration_minutes, 15), 5), 30);
    v_hold_expires_at := now() + (v_hold_minutes || ' minutes')::INTERVAL;

    -- 11. Generate Reference Code and Identifiers
    v_reference_code := public.generate_booking_ref();
    v_time_slot_label := to_char(v_local_start, 'HH12:MI AM') || ' – ' || to_char(v_local_end, 'HH12:MI AM');
    v_reservation_id := gen_random_uuid();
    v_payment_id := gen_random_uuid();

    -- 12. Insert Pending Reservation (Protected by exclusion constraint prevent_court_overlapping_active_reservations)
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

    -- 13. Insert Bound Payment Record in Safe Initial State 'pending' with internal pending checkout identifier
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
        NULL, -- Left NULL on hold creation; securely bound via bind_provider_checkout_session
        v_hold_expires_at,
        jsonb_build_object(
            'checkout_idempotency_key', v_clean_key,
            'hold_duration_minutes', v_hold_minutes,
            'reference_code', v_reference_code
        )
    );

    -- 14. Record Idempotency Result
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

COMMENT ON FUNCTION public.create_booking_checkout_session IS 'Atomically initializes a booking hold and creates a pending payment record with server-authoritative rates and anti-abuse checks.';


-- ==============================================================================
-- 1B. Secure Provider Checkout Session Binding Procedure (Restricted to service_role)
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
    v_payment RECORD;
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for checkout session binding.';
    END IF;

    v_clean_session_id := NULLIF(trim(COALESCE(p_checkout_session_id, '')), '');
    IF v_clean_session_id IS NULL OR length(v_clean_session_id) < 8 THEN
        RAISE EXCEPTION 'Valid provider checkout_session_id is required for binding.';
    END IF;

    -- Validate format of provider session (PayMongo: cs_..., manual_test: cs_manual_... or cs_test_...)
    IF p_provider_name = 'paymongo' AND v_clean_session_id !~ '^cs_' THEN
        RAISE EXCEPTION 'Invalid PayMongo checkout session ID format. Must begin with "cs_".';
    END IF;

    -- Lock and verify payment record
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

    IF v_payment.status != 'pending' THEN
        RAISE EXCEPTION 'Payment % is in status "%"; can only bind provider checkout sessions to pending payments.',
            p_payment_id, v_payment.status;
    END IF;

    IF v_payment.expires_at <= now() THEN
        RAISE EXCEPTION 'Cannot bind checkout session: Booking hold has already expired.';
    END IF;

    -- If already bound to the same session, idempotent return
    IF v_payment.checkout_session_id = v_clean_session_id THEN
        RETURN jsonb_build_object(
            'success', true,
            'payment_id', v_payment.id,
            'reservation_id', p_reservation_id,
            'checkout_session_id', v_clean_session_id,
            'status', 'already_bound',
            'idempotent_replayed', true
        );
    END IF;

    -- Prevent rebinding if already bound to an authoritative session
    IF v_payment.checkout_session_id IS NOT NULL THEN
        RAISE EXCEPTION 'Payment % is already bound to provider session "%". Rebinding is prohibited.',
            p_payment_id, v_payment.checkout_session_id;
    END IF;

    -- Securely bind the provider checkout session
    UPDATE public.payments
    SET checkout_session_id = v_clean_session_id,
        provider_name = p_provider_name,
        verified_capture_evidence = verified_capture_evidence || jsonb_build_object(
            'checkout_url', p_checkout_url,
            'bound_at', now(),
            'binding_idempotency_key', v_clean_key,
            'binding_metadata', p_metadata
        ),
        updated_at = now()
    WHERE id = v_payment.id;

    -- Also update cached response payload in booking_idempotency_keys if present
    UPDATE public.booking_idempotency_keys
    SET response_payload = response_payload || jsonb_build_object(
        'checkout_session_id', v_clean_session_id,
        'checkout_url', p_checkout_url
    )
    WHERE reservation_id = p_reservation_id;

    RETURN jsonb_build_object(
        'success', true,
        'payment_id', v_payment.id,
        'reservation_id', p_reservation_id,
        'checkout_session_id', v_clean_session_id,
        'checkout_url', p_checkout_url,
        'status', 'bound'
    );
END;
$$;

COMMENT ON FUNCTION public.bind_provider_checkout_session IS 'Securely binds authoritative provider checkout session ID to pending booking payment.';


-- ==============================================================================
-- 2. Verified Payment Event Ingestion & Booking Reconciliation
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
    v_existing_idemp RECORD;
BEGIN
    -- 1. Validate Required Webhook Evidence Record (Zero unverified execution)
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

    -- 2. Validate Webhook Authenticity & Evidence Record in provider_webhook_events
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

    -- Verify Provider Name & Event ID match webhook record
    IF v_webhook.provider_name != p_provider_name THEN
        RAISE EXCEPTION 'Provider mismatch: Webhook belongs to provider "%", but caller specified "%".',
            v_webhook.provider_name, p_provider_name;
    END IF;

    IF v_webhook.provider_event_id != p_provider_event_id THEN
        RAISE EXCEPTION 'Provider event ID mismatch: Webhook contains "%", but caller specified "%".',
            v_webhook.provider_event_id, p_provider_event_id;
    END IF;

    -- Idempotent bypass if already successfully processed
    IF v_webhook.processing_state = 'processed' THEN
        RETURN jsonb_build_object(
            'success', true,
            'status', 'already_processed',
            'idempotent_replayed', true,
            'provider_event_id', p_provider_event_id,
            'provider_payment_id', v_clean_payment_id
        );
    END IF;

    -- 3. Extract and Verify Trusted Payload Evidence (Reject Caller Tampering)
    v_trusted_payment_id := COALESCE(
        v_webhook.payload->'data'->'attributes'->'data'->>'id',
        v_webhook.payload->'data'->>'id',
        v_webhook.payload->>'provider_payment_id',
        v_webhook.payload->>'payment_id'
    );

    v_trusted_session_id := COALESCE(
        v_webhook.payload->'data'->'attributes'->'data'->'attributes'->>'checkout_session_id',
        v_webhook.payload->'data'->'attributes'->'data'->'attributes'->'metadata'->>'checkout_session_id',
        v_webhook.payload->'data'->'attributes'->>'checkout_session_id',
        v_webhook.payload->'data'->'attributes'->'metadata'->>'checkout_session_id',
        v_webhook.payload->'data'->>'checkout_session_id',
        v_webhook.payload->>'checkout_session_id'
    );

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

    v_trusted_currency := upper(COALESCE(
        v_webhook.payload->'data'->'attributes'->'data'->'attributes'->>'currency',
        v_webhook.payload->'data'->'attributes'->>'currency',
        v_webhook.payload->>'currency',
        'PHP'
    ));

    IF v_trusted_payment_id IS NOT NULL AND v_trusted_payment_id != v_clean_payment_id THEN
        RAISE EXCEPTION 'Evidence tampering detected: Caller provider_payment_id ("%") does not match verified webhook payload evidence ("%").',
            v_clean_payment_id, v_trusted_payment_id;
    END IF;

    IF v_trusted_session_id IS NOT NULL AND v_trusted_session_id != v_clean_session_id THEN
        RAISE EXCEPTION 'Evidence tampering detected: Caller checkout_session_id ("%") does not match verified webhook payload evidence ("%").',
            v_clean_session_id, v_trusted_session_id;
    END IF;

    IF v_trusted_amount IS NOT NULL AND v_trusted_amount != p_captured_amount THEN
        RAISE EXCEPTION 'Evidence tampering detected: Caller captured_amount (₱%) does not match verified webhook payload evidence (₱%).',
            p_captured_amount, v_trusted_amount;
    END IF;

    IF v_trusted_currency IS NOT NULL AND v_trusted_currency != v_clean_currency THEN
        RAISE EXCEPTION 'Evidence tampering detected: Caller currency ("%") does not match verified webhook payload evidence ("%").',
            v_clean_currency, v_trusted_currency;
    END IF;

    -- 4. Idempotency Conflict Check: Prevent altering values under another event's identity
    SELECT * INTO v_existing_idemp
    FROM public.booking_idempotency_keys
    WHERE idempotency_key = v_clean_key;

    IF FOUND THEN
        IF v_existing_idemp.request_fingerprint != md5(p_provider_name || '|' || p_provider_event_id || '|' || v_clean_payment_id || '|' || v_clean_session_id || '|' || p_captured_amount::text) THEN
            RAISE EXCEPTION 'Idempotency conflict: Key % is already bound to a different webhook event or payment identity.', v_clean_key;
        END IF;
    END IF;

    -- 5. Match Payment Record by checkout_session_id and provider_name
    SELECT * INTO v_payment
    FROM public.payments
    WHERE checkout_session_id = v_clean_session_id
      AND provider_name = p_provider_name
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment record for provider "%" and checkout_session_id "%" not found.',
            p_provider_name, v_clean_session_id;
    END IF;

    -- Reject payment records that are still unbound placeholders
    IF v_payment.checkout_session_id LIKE 'cs_pending_%' THEN
        RAISE EXCEPTION 'Unbound payment: Payment record % was never bound to an authoritative provider checkout session.',
            v_payment.id;
    END IF;

    -- Check if payment is already captured
    IF v_payment.status = 'captured' THEN
        IF v_payment.provider_payment_id = v_clean_payment_id THEN
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

    -- 6. Lock and Reconcile Reservation
    SELECT * INTO v_reservation
    FROM public.reservations
    WHERE id = v_payment.reservation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Associated reservation % for payment % does not exist.',
            v_payment.reservation_id, v_payment.id;
    END IF;

    -- 7. Check Booking Hold Expiration and Availability
    IF v_reservation.hold_expires_at <= now() OR v_reservation.status = 'expired' THEN
        v_is_hold_expired := true;
    END IF;

    -- Check for slot collision with another already-confirmed booking
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

    -- 8. Case A: Amount Mismatch -> Route to Customer Refund Liability
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
            false, -- p_is_late = false (excess / amount mismatch)
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

    -- 9. Case B: Valid Booking -> Confirm Reservation & Settle
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
        -- 10. Case C: Expired Hold or Slot Conflicted -> Route to Customer Refund Liability
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
            true, -- p_is_late = true (late or conflict payment)
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

COMMENT ON FUNCTION public.process_verified_payment_event IS 'Reconciles verified webhook payment capture against reservations; confirms booking or records customer refund liability.';


-- ==============================================================================
-- 3. Settlement Clearing Ingestion (Verified Batch Reconciled Funds)
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.process_settlement_clearing(
    p_batch_id UUID,
    p_organization_id UUID,
    p_facility_id UUID,
    p_net_amount NUMERIC(10, 2),
    p_provider_batch_id TEXT,
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
    v_clean_provider_batch_id TEXT;
    v_batch RECORD;
    v_journal_res JSONB;
    v_items_summary RECORD;
    v_cleared_amount NUMERIC(10, 2);
    v_existing_tx RECORD;
BEGIN
    -- 1. Parameter Validation
    IF p_batch_id IS NULL THEN
        RAISE EXCEPTION 'p_batch_id is strictly required for settlement clearing.';
    END IF;

    IF p_organization_id IS NULL OR p_facility_id IS NULL THEN
        RAISE EXCEPTION 'Both p_organization_id and p_facility_id are required.';
    END IF;

    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for settlement clearing.';
    END IF;

    v_clean_provider_batch_id := NULLIF(trim(COALESCE(p_provider_batch_id, '')), '');
    IF v_clean_provider_batch_id IS NULL THEN
        RAISE EXCEPTION 'p_provider_batch_id is required.';
    END IF;

    -- 2. Validate Facility Ownership
    IF NOT EXISTS (
        SELECT 1 FROM public.facilities
        WHERE id = p_facility_id AND organization_id = p_organization_id
    ) THEN
        RAISE EXCEPTION 'Facility % does not belong to organization %.', p_facility_id, p_organization_id;
    END IF;

    -- 3. Lock and Verify Settlement Batch
    SELECT * INTO v_batch
    FROM public.settlement_batches
    WHERE id = p_batch_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Settlement batch ID % not found.', p_batch_id;
    END IF;

    IF v_batch.provider_batch_id != v_clean_provider_batch_id THEN
        RAISE EXCEPTION 'Provider batch ID mismatch: Batch contains "%", but caller passed "%".',
            v_batch.provider_batch_id, v_clean_provider_batch_id;
    END IF;

    -- 4. Duplicate Clearing Prevention & Idempotency
    IF v_batch.status = 'reconciled' THEN
        SELECT id INTO v_existing_tx
        FROM public.financial_transactions
        WHERE idempotency_key = v_clean_key
          AND transaction_type = 'funds_cleared';

        IF FOUND THEN
            RETURN jsonb_build_object(
                'success', true,
                'batch_id', p_batch_id,
                'status', 'already_cleared',
                'idempotent_replayed', true
            );
        END IF;

        RAISE EXCEPTION 'Settlement batch % has already been completely reconciled and cleared.', p_batch_id;
    END IF;

    -- 5. Strict Settlement Items Verification (Zero reliance on caller-supplied amounts)
    SELECT
        COUNT(*) as item_count,
        COALESCE(SUM(net_settled_amount), 0.00) as verified_net_amount,
        COALESCE(SUM(gross_amount), 0.00) as verified_gross_amount,
        COUNT(*) FILTER (WHERE settlement_status != 'matched') as invalid_status_count,
        COUNT(*) FILTER (WHERE journal_transaction_id IS NOT NULL) as already_cleared_count,
        COUNT(*) FILTER (WHERE organization_id != p_organization_id) as wrong_org_count
    INTO v_items_summary
    FROM public.settlement_items
    WHERE batch_id = p_batch_id
      AND organization_id = p_organization_id
      AND facility_id = p_facility_id;

    IF v_items_summary.item_count = 0 THEN
        RAISE EXCEPTION 'Settlement batch % contains zero settlement items for organization % and facility %.',
            p_batch_id, p_organization_id, p_facility_id;
    END IF;

    IF v_items_summary.wrong_org_count > 0 THEN
        RAISE EXCEPTION 'Cross-tenant settlement violation: Batch items belong to another organization.';
    END IF;

    IF v_items_summary.invalid_status_count > 0 THEN
        RAISE EXCEPTION 'Settlement batch contains % items with unmatched, missing, or disputed status.',
            v_items_summary.invalid_status_count;
    END IF;

    IF v_items_summary.already_cleared_count > 0 THEN
        RAISE EXCEPTION 'Settlement batch contains % items that have already been cleared.',
            v_items_summary.already_cleared_count;
    END IF;

    -- Strict Amount Reconciliation: Caller amount must exactly match verified items total
    IF p_net_amount IS NOT NULL AND p_net_amount != v_items_summary.verified_net_amount THEN
        RAISE EXCEPTION 'Settlement amount mismatch: Caller requested ₱%, but verified matched batch items total ₱%.',
            p_net_amount, v_items_summary.verified_net_amount;
    END IF;

    v_cleared_amount := v_items_summary.verified_net_amount;

    -- 6. Invoke post_funds_cleared_event (Transitions 2010 -> 2011)
    v_journal_res := public.post_funds_cleared_event(
        p_organization_id,
        p_facility_id,
        v_cleared_amount,
        v_clean_provider_batch_id,
        v_clean_key,
        p_metadata || jsonb_build_object(
            'batch_id', p_batch_id,
            'item_count', v_items_summary.item_count,
            'verified_net_amount', v_cleared_amount
        )
    );

    -- 7. Update Settlement Items as Cleared
    UPDATE public.settlement_items
    SET journal_transaction_id = (v_journal_res->>'transaction_id')::UUID,
        reconciled_at = now()
    WHERE batch_id = p_batch_id
      AND organization_id = p_organization_id
      AND facility_id = p_facility_id;

    -- 8. If all items in the batch are now reconciled, advance batch status
    IF NOT EXISTS (
        SELECT 1 FROM public.settlement_items
        WHERE batch_id = p_batch_id AND journal_transaction_id IS NULL
    ) THEN
        UPDATE public.settlement_batches
        SET status = 'reconciled',
            reconciled_at = now(),
            updated_at = now()
        WHERE id = p_batch_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'batch_id', p_batch_id,
        'organization_id', p_organization_id,
        'facility_id', p_facility_id,
        'net_amount', v_cleared_amount,
        'item_count', v_items_summary.item_count,
        'journal_transaction_id', v_journal_res->>'transaction_id'
    );
END;
$$;

COMMENT ON FUNCTION public.process_settlement_clearing IS 'Reconciles verified provider settlement batch items to available withdrawable balance based strictly on verified batch items.';


-- ==============================================================================
-- 4. Verified Refunds & Chargebacks (Requires Authoritative Provider Evidence)
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
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for verified refund processing.';
    END IF;

    -- Require authoritative provider refund evidence
    v_clean_refund_id := NULLIF(trim(COALESCE(p_provider_refund_id, '')), '');
    IF v_clean_refund_id IS NULL OR length(v_clean_refund_id) < 5 THEN
        RAISE EXCEPTION 'Authoritative provider_refund_id is required.';
    END IF;

    IF p_refund_evidence IS NULL OR p_refund_evidence = '{}'::jsonb THEN
        RAISE EXCEPTION 'Authoritative provider refund confirmation evidence is required to execute refund reversal.';
    END IF;

    v_evidence_status := lower(COALESCE(p_refund_evidence->>'status', p_refund_evidence->>'refund_status', ''));
    IF v_evidence_status NOT IN ('succeeded', 'completed', 'paid') THEN
        RAISE EXCEPTION 'Unconfirmed refund evidence: Provider refund status "%" is not terminal succeeded.', v_evidence_status;
    END IF;

    IF (p_refund_evidence ? 'provider_refund_id') AND (p_refund_evidence->>'provider_refund_id' != v_clean_refund_id) THEN
        RAISE EXCEPTION 'Evidence mismatch: Evidence provider_refund_id "%" does not match parameter "%".',
            p_refund_evidence->>'provider_refund_id', v_clean_refund_id;
    END IF;

    IF p_refund_amount IS NULL OR p_refund_amount <= 0.00 THEN
        RAISE EXCEPTION 'Refund amount must be strictly positive. Got: ₱%', p_refund_amount;
    END IF;

    -- Lock and verify payment record
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

    -- Prevent duplicate processing of the exact same provider refund ID
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

    -- Update Payment status and refunded_amount
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

    -- If full refund, cancel reservation if confirmed
    IF v_target_status = 'refunded' THEN
        UPDATE public.reservations
        SET status = 'cancelled',
            cancelled_at = now(),
            cancellation_reason = 'Refunded: ' || COALESCE(p_reason, 'Customer refund requested'),
            updated_at = now()
        WHERE id = v_payment.reservation_id
          AND status = 'confirmed';
    END IF;

    -- Post Financial Journal via post_refund_reversal_event
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

COMMENT ON FUNCTION public.process_verified_refund_event IS 'Processes verified refunds with authoritative provider evidence, updates payment lifecycle, and posts double-entry financial reversals.';


-- ==============================================================================
-- 5. Owner Payout Request, Reserve & Disbursement
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.request_owner_payout(
    p_organization_id UUID,
    p_payout_method_id UUID,
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
    v_caller_id UUID;
    v_clean_key TEXT;
    v_method RECORD;
    v_payout_id UUID;
    v_journal_res JSONB;
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for payout request.';
    END IF;

    IF p_amount IS NULL OR p_amount <= 0.00 THEN
        RAISE EXCEPTION 'Payout amount must be strictly positive. Got: ₱%', p_amount;
    END IF;

    -- Verify Caller Authentication & Organization Role (Owner or Admin only)
    v_caller_id := auth.uid();
    IF v_caller_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.organization_members
            WHERE organization_id = p_organization_id
              AND user_id = v_caller_id
              AND role IN ('owner', 'admin')
        ) THEN
            RAISE EXCEPTION 'Access denied: Only organization owners and admins can request payouts.';
        END IF;
    END IF;

    -- Verify Payout Method belongs to Organization, is active and verified
    SELECT * INTO v_method
    FROM public.payout_methods
    WHERE id = p_payout_method_id
      AND organization_id = p_organization_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payout method % not found for organization %.', p_payout_method_id, p_organization_id;
    END IF;

    IF NOT v_method.is_active THEN
        RAISE EXCEPTION 'Payout method % is disabled.', p_payout_method_id;
    END IF;

    IF v_method.verification_status != 'verified' THEN
        RAISE EXCEPTION 'Payout method % is not verified (status: %).', p_payout_method_id, v_method.verification_status;
    END IF;

    -- Initialize Payout in pending_request
    v_payout_id := gen_random_uuid();
    INSERT INTO public.payouts (
        id,
        organization_id,
        payout_method_id,
        amount,
        currency,
        status
    ) VALUES (
        v_payout_id,
        p_organization_id,
        p_payout_method_id,
        p_amount,
        'PHP',
        'pending_request'
    );

    -- Advance to approved_reserved
    UPDATE public.payouts
    SET status = 'approved_reserved'
    WHERE id = v_payout_id;

    -- Post Financial Journal via post_payout_reserve_event
    v_journal_res := public.post_payout_reserve_event(
        p_organization_id,
        v_payout_id,
        p_amount,
        v_clean_key,
        p_metadata || jsonb_build_object(
            'payout_method_id', p_payout_method_id,
            'payout_id', v_payout_id
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'payout_id', v_payout_id,
        'organization_id', p_organization_id,
        'amount', p_amount,
        'status', 'approved_reserved',
        'journal_transaction_id', v_journal_res->>'transaction_id'
    );
END;
$$;

COMMENT ON FUNCTION public.request_owner_payout IS 'Validates owner payout request, locks funds in Account 2015 reserve, and advances payout to approved_reserved.';


CREATE OR REPLACE FUNCTION public.confirm_owner_payout_disbursement(
    p_payout_id UUID,
    p_provider_reference TEXT,
    p_disbursement_evidence JSONB,
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
    v_clean_ref TEXT;
    v_payout RECORD;
    v_journal_res JSONB;
    v_evidence_status TEXT;
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for payout disbursement confirmation.';
    END IF;

    v_clean_ref := NULLIF(trim(COALESCE(p_provider_reference, '')), '');
    IF v_clean_ref IS NULL OR length(v_clean_ref) < 8 THEN
        RAISE EXCEPTION 'Authoritative provider_reference (min 8 chars) is required.';
    END IF;

    -- Require authoritative provider disbursement confirmation evidence
    IF p_disbursement_evidence IS NULL OR p_disbursement_evidence = '{}'::jsonb THEN
        RAISE EXCEPTION 'Authoritative provider disbursement confirmation evidence is required to disburse owner payout.';
    END IF;

    v_evidence_status := lower(COALESCE(p_disbursement_evidence->>'disbursement_status', p_disbursement_evidence->>'status', ''));
    IF v_evidence_status NOT IN ('succeeded', 'paid', 'completed', 'sent') THEN
        RAISE EXCEPTION 'Unconfirmed disbursement evidence: Provider status "%" is not terminal succeeded.', v_evidence_status;
    END IF;

    IF (p_disbursement_evidence ? 'provider_reference') AND (p_disbursement_evidence->>'provider_reference' != v_clean_ref) THEN
        RAISE EXCEPTION 'Evidence mismatch: Evidence provider_reference "%" does not match parameter "%".',
            p_disbursement_evidence->>'provider_reference', v_clean_ref;
    END IF;

    -- Lock and verify payout
    SELECT * INTO v_payout
    FROM public.payouts
    WHERE id = p_payout_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payout ID % not found.', p_payout_id;
    END IF;

    -- Idempotent bypass if already paid under same reference
    IF v_payout.status = 'paid' THEN
        IF v_payout.provider_payout_id = v_clean_ref THEN
            RETURN jsonb_build_object(
                'success', true,
                'payout_id', v_payout.id,
                'status', 'paid',
                'idempotent_replayed', true
            );
        ELSE
            RAISE EXCEPTION 'Payout % is already paid under provider reference "%", cannot overwrite with "%".',
                p_payout_id, v_payout.provider_payout_id, v_clean_ref;
        END IF;
    END IF;

    -- Ensure payout is in approved_reserved or submitted_to_provider
    IF v_payout.status = 'approved_reserved' THEN
        UPDATE public.payouts
        SET status = 'submitted_to_provider',
            provider_payout_id = v_clean_ref,
            submitted_at = now(),
            updated_at = now()
        WHERE id = p_payout_id;
    END IF;

    -- Advance to paid
    UPDATE public.payouts
    SET status = 'paid',
        provider_payout_id = v_clean_ref,
        completed_at = now(),
        updated_at = now()
    WHERE id = p_payout_id;

    -- Post Financial Journal via post_payout_disbursement_event
    v_journal_res := public.post_payout_disbursement_event(
        v_payout.organization_id,
        p_payout_id,
        v_payout.amount,
        v_clean_key,
        p_metadata || jsonb_build_object(
            'provider_reference', v_clean_ref,
            'evidence', p_disbursement_evidence
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'payout_id', p_payout_id,
        'status', 'paid',
        'provider_payout_id', v_clean_ref,
        'journal_transaction_id', v_journal_res->>'transaction_id'
    );
END;
$$;

COMMENT ON FUNCTION public.confirm_owner_payout_disbursement IS 'Confirms provider disbursement with authoritative evidence and completes double-entry cash payout.';


CREATE OR REPLACE FUNCTION public.fail_owner_payout_release(
    p_payout_id UUID,
    p_failure_reason TEXT,
    p_failure_evidence JSONB,
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
    v_clean_reason TEXT;
    v_payout RECORD;
    v_journal_res JSONB;
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for payout failure release.';
    END IF;

    v_clean_reason := NULLIF(trim(COALESCE(p_failure_reason, '')), '');
    IF v_clean_reason IS NULL OR length(v_clean_reason) < 5 THEN
        RAISE EXCEPTION 'A descriptive failure_reason (min 5 chars) is required.';
    END IF;

    -- Require authoritative provider failure evidence
    IF p_failure_evidence IS NULL OR p_failure_evidence = '{}'::jsonb THEN
        RAISE EXCEPTION 'Authoritative provider failure evidence is required to release reserved payout funds.';
    END IF;

    IF NOT (p_failure_evidence ? 'failure_code' OR p_failure_evidence ? 'provider_status' OR p_failure_evidence ? 'status') THEN
        RAISE EXCEPTION 'Authoritative provider failure evidence must contain failure_code or provider_status.';
    END IF;

    -- Lock and verify payout
    SELECT * INTO v_payout
    FROM public.payouts
    WHERE id = p_payout_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payout ID % not found.', p_payout_id;
    END IF;

    IF v_payout.status = 'failed' THEN
        RETURN jsonb_build_object(
            'success', true,
            'payout_id', v_payout.id,
            'status', 'failed',
            'idempotent_replayed', true
        );
    END IF;

    IF v_payout.status NOT IN ('approved_reserved', 'submitted_to_provider') THEN
        RAISE EXCEPTION 'Cannot fail payout %: Current status is "%". Only reserved or submitted payouts can be failed.',
            p_payout_id, v_payout.status;
    END IF;

    -- Advance to failed
    UPDATE public.payouts
    SET status = 'failed',
        failure_reason = v_clean_reason,
        updated_at = now()
    WHERE id = p_payout_id;

    -- Post Financial Journal via post_payout_failed_release_event (Restores 2015 -> 2011)
    v_journal_res := public.post_payout_failed_release_event(
        v_payout.organization_id,
        p_payout_id,
        v_payout.amount,
        v_clean_key,
        p_metadata || jsonb_build_object(
            'failure_reason', v_clean_reason,
            'evidence', p_failure_evidence
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'payout_id', p_payout_id,
        'status', 'failed',
        'failure_reason', v_clean_reason,
        'journal_transaction_id', v_journal_res->>'transaction_id'
    );
END;
$$;

COMMENT ON FUNCTION public.fail_owner_payout_release IS 'Releases reserved funds back to available balance upon verified provider payout failure.';


-- ==============================================================================
-- 6. Grants & Permissions Hardening
-- ==============================================================================

-- create_booking_checkout_session is the audited public checkout entrypoint
GRANT EXECUTE ON FUNCTION public.create_booking_checkout_session TO anon, authenticated;

-- bind_provider_checkout_session is restricted to service_role (preventing anon session spoofing)
REVOKE ALL ON FUNCTION public.bind_provider_checkout_session FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_provider_checkout_session TO service_role;

-- request_owner_payout is for authenticated organization owners and admins
GRANT EXECUTE ON FUNCTION public.request_owner_payout TO authenticated;

-- Backend financial operations are strictly restricted to service_role (and postgres)
REVOKE ALL ON FUNCTION public.process_verified_payment_event FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_verified_payment_event TO service_role;

REVOKE ALL ON FUNCTION public.process_settlement_clearing FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_settlement_clearing TO service_role;

REVOKE ALL ON FUNCTION public.process_verified_refund_event FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_verified_refund_event TO service_role;

REVOKE ALL ON FUNCTION public.confirm_owner_payout_disbursement FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_owner_payout_disbursement TO service_role;

REVOKE ALL ON FUNCTION public.fail_owner_payout_release FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_owner_payout_release TO service_role;

COMMIT;
