-- ==============================================================================
-- CourtBook / BookSuite — Database Migration 005C
-- File: supabase/migrations/005c_booking_payment_integration.sql
-- Description: Trusted Booking & Payment Integration Layer
--
-- ARCHITECTURE & INTEGRATION SCOPE:
--   1. Booking & Payment Checkout Session Binding (create_booking_checkout_session):
--      - Creates temporary booking hold on reservations table.
--      - Enforces server-authoritative court hourly rates (no client price tampering).
--      - Computes immutable 5% platform commission snapshot.
--      - Atomically binds payment checkout session in pending status.
--      - Enforces consistent lock hierarchy (Court FOR UPDATE first).
--      - Respects exclusion constraint prevent_court_overlapping_active_reservations.
--   2. Authoritative Payment Event Ingestion (process_verified_payment_event):
--      - Requires cryptographically verified webhook record from 005B provider_webhook_events.
--      - Reconciles payment capture against reservation hold expiration and availability.
--      - Valid booking: Confirms reservation, marks payment captured, posts booking settlement
--        financial journal entry (post_booking_settlement_event).
--      - Expired / Cancelled / Conflict booking: Prevents invalid slot confirmation, marks payment
--        captured, posts excess/late payment liability journal entry (post_excess_or_late_payment_event)
--        to Account 2030 (Customer Refund Liability) with zero owner balance inflation.
--   3. Settlement Clearing Ingestion (process_settlement_clearing):
--      - Reconciles provider funds clearing into platform account.
--      - Invokes post_funds_cleared_event to transition funds from Account 2010 (Unsettled Clearing)
--        to Account 2011 (Available Withdrawable).
--   4. Verified Refunds & Chargebacks (process_verified_refund_event):
--      - Enforces refund amount bounds and payment lifecycle transitions.
--      - Cancels reservation if full refund.
--      - Posts balanced refund reversal financial journal entries (post_refund_reversal_event).
--   5. Owner Payout Request, Reserve & Disbursement:
--      - request_owner_payout: Authorizes owner/admin, verifies payout method ownership,
--        advances payout through pending_request -> approved_reserved, posts payout reserve (post_payout_reserve_event).
--      - confirm_owner_payout_disbursement: Advances to paid, posts disbursement (post_payout_disbursement_event).
--      - fail_owner_payout_release: Releases reserved funds back to available (post_payout_failed_release_event).
--   6. Security & Least Privilege Hardening:
--      - All functions SECURITY DEFINER with explicit search_path = public, pg_temp.
--      - Zero client writes to financial journal or payment state machines.
--      - Internal posting RPCs restricted to trusted service_role.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. Booking Checkout & Payment Session Binding
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
    p_checkout_session_id TEXT DEFAULT NULL,
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
    v_session_ref TEXT;
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

    -- 2. Check Idempotency: Has this checkout request already been initialized?
    SELECT * INTO v_existing_idemp
    FROM public.booking_idempotency_keys
    WHERE idempotency_key = v_clean_key;

    IF FOUND AND v_existing_idemp.status = 'completed' AND v_existing_idemp.response_payload IS NOT NULL THEN
        -- Check if reservation still exists and is active
        IF v_existing_idemp.reservation_id IS NOT NULL THEN
            RETURN v_existing_idemp.response_payload || jsonb_build_object('idempotent_replayed', true);
        END IF;
    END IF;

    -- 3. Validate Facility
    SELECT * INTO v_facility
    FROM public.facilities
    WHERE id = p_facility_id AND is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Facility is not active or does not exist.';
    END IF;

    -- 4. Consistent Locking Hierarchy: Lock Court FIRST
    SELECT * INTO v_court
    FROM public.courts
    WHERE id = p_court_id AND facility_id = p_facility_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Court does not exist in this facility.';
    END IF;

    IF NOT v_court.is_enabled THEN
        RAISE EXCEPTION 'Court is currently disabled by facility management.';
    END IF;

    -- 5. While holding court lock, clean up expired pending holds on this court
    UPDATE public.reservations
    SET status = 'expired',
        updated_at = now()
    WHERE court_id = p_court_id
      AND status = 'pending'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= now();

    -- 6. Timezone-Aware Local Date & Operating Hours Validation
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

    -- 7. Check Maintenance Blocks on Locked Court
    IF EXISTS (
        SELECT 1
        FROM public.court_blocked_times
        WHERE court_id = p_court_id
          AND tstzrange(start_time, end_time, '[)') && tstzrange(p_start_time, v_end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'Court is blocked for maintenance or private club event during this time slot.';
    END IF;

    -- 8. Server-Authoritative Price Calculation (Zero Client Tampering)
    v_total_price := ROUND((v_court.hourly_rate * (p_duration_minutes::NUMERIC / 60.0)), 2);
    v_commission_amount := ROUND((v_total_price * v_commission_rate), 2);
    v_owner_gross_share := v_total_price - v_commission_amount;

    -- 9. Hold Duration: Standard 15-minute temporary checkout hold
    v_hold_minutes := LEAST(GREATEST(COALESCE(v_facility.hold_duration_minutes, 15), 5), 30);
    v_hold_expires_at := now() + (v_hold_minutes || ' minutes')::INTERVAL;

    -- 10. Generate Reference Code and Identifiers
    v_reference_code := public.generate_booking_ref();
    v_time_slot_label := to_char(v_local_start, 'HH12:MI AM') || ' – ' || to_char(v_local_end, 'HH12:MI AM');
    v_reservation_id := gen_random_uuid();
    v_payment_id := gen_random_uuid();
    v_session_ref := COALESCE(NULLIF(trim(p_checkout_session_id), ''), 'cs_' || replace(v_reservation_id::text, '-', ''));

    -- 11. Insert Pending Reservation (Protected by exclusion constraint prevent_court_overlapping_active_reservations)
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

    -- 12. Insert Bound Payment Record in Safe Initial State 'pending'
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
        v_session_ref,
        v_hold_expires_at,
        jsonb_build_object(
            'checkout_idempotency_key', v_clean_key,
            'hold_duration_minutes', v_hold_minutes,
            'reference_code', v_reference_code
        )
    );

    -- 13. Record Idempotency Result
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
        md5(p_facility_id::text || '|' || p_court_id::text || '|' || p_booking_date::text || '|' || p_start_time::text || '|' || v_total_price::text),
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
            'checkout_session_id', v_session_ref,
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
        'checkout_session_id', v_session_ref,
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

COMMENT ON FUNCTION public.create_booking_checkout_session IS 'Atomically initializes a booking hold and binds a pending payment record with server-authoritative rates and 5% commission.';


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
BEGIN
    -- 1. Validate Idempotency & Provider Identifiers
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for verified payment processing.';
    END IF;

    v_clean_payment_id := NULLIF(trim(COALESCE(p_provider_payment_id, '')), '');
    v_clean_session_id := NULLIF(trim(COALESCE(p_checkout_session_id, '')), '');

    IF v_clean_payment_id IS NULL THEN
        RAISE EXCEPTION 'Authoritative provider_payment_id is required.';
    END IF;

    v_clean_currency := upper(trim(COALESCE(p_currency, 'PHP')));
    IF v_clean_currency NOT IN ('PHP', '₱') THEN
        RAISE EXCEPTION 'Unsupported payment currency: "%". Expected PHP.', p_currency;
    END IF;

    IF p_captured_amount IS NULL OR p_captured_amount <= 0.00 THEN
        RAISE EXCEPTION 'Captured payment amount must be strictly positive. Got: ₱%', p_captured_amount;
    END IF;

    -- 2. Validate Webhook Authenticity Record in provider_webhook_events
    IF p_webhook_event_id IS NOT NULL THEN
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
    END IF;

    -- 3. Locate Target Payment Record (by checkout_session_id OR matching payment ID)
    SELECT * INTO v_payment
    FROM public.payments
    WHERE (v_clean_session_id IS NOT NULL AND checkout_session_id = v_clean_session_id)
       OR (provider_payment_id = v_clean_payment_id)
    FOR UPDATE;

    -- If no payment record exists matching checkout session:
    IF NOT FOUND THEN
        -- Route to unassigned customer refund liability (Account 2030) with ZERO owner balance inflation
        v_journal_res := public.post_excess_or_late_payment_event(
            '00000000-0000-0000-0000-000000000001'::UUID, -- Platform default tenant
            NULL,
            COALESCE(p_webhook_event_id, gen_random_uuid()),
            p_captured_amount,
            false,
            v_clean_key,
            jsonb_build_object(
                'reason', 'Unmatched provider payment capture; routed to customer refund liability',
                'provider_payment_id', v_clean_payment_id,
                'checkout_session_id', v_clean_session_id
            )
        );

        IF p_webhook_event_id IS NOT NULL THEN
            UPDATE public.provider_webhook_events
            SET processing_state = 'failed',
                last_error = 'Unmatched payment record: routed to customer refund liability',
                processed_at = now()
            WHERE id = p_webhook_event_id;
        END IF;

        RETURN jsonb_build_object(
            'success', false,
            'outcome', 'unmatched_liability_recorded',
            'provider_payment_id', v_clean_payment_id,
            'journal_result', v_journal_res
        );
    END IF;

    -- Check if payment was ALREADY captured (Idempotent Webhook Replay)
    IF v_payment.status = 'captured' AND v_payment.provider_payment_id = v_clean_payment_id THEN
        IF p_webhook_event_id IS NOT NULL THEN
            UPDATE public.provider_webhook_events
            SET processing_state = 'processed',
                processed_at = now()
            WHERE id = p_webhook_event_id;
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'captured',
            'idempotent_replayed', true,
            'payment_id', v_payment.id,
            'reservation_id', v_payment.reservation_id
        );
    END IF;

    -- Recheck amount integrity: Captured amount MUST match expected booking price
    IF p_captured_amount != v_payment.expected_amount THEN
        -- Severe amount mismatch: Log as liability, do NOT confirm reservation
        v_journal_res := public.post_excess_or_late_payment_event(
            v_payment.organization_id,
            v_payment.facility_id,
            v_payment.id,
            p_captured_amount,
            false,
            v_clean_key,
            jsonb_build_object(
                'reason', format('Captured amount (₱%s) does not match expected amount (₱%s)', p_captured_amount, v_payment.expected_amount),
                'payment_id', v_payment.id,
                'provider_payment_id', v_clean_payment_id
            )
        );

        IF p_webhook_event_id IS NOT NULL THEN
            UPDATE public.provider_webhook_events
            SET processing_state = 'failed',
                last_error = 'Amount mismatch between provider capture and expected reservation price',
                processed_at = now()
            WHERE id = p_webhook_event_id;
        END IF;

        RETURN jsonb_build_object(
            'success', false,
            'outcome', 'amount_mismatch_liability_recorded',
            'expected_amount', v_payment.expected_amount,
            'captured_amount', p_captured_amount
        );
    END IF;

    -- 4. Lock Reservation & Evaluate Hold Expiration / Collision
    SELECT * INTO v_reservation
    FROM public.reservations
    WHERE id = v_payment.reservation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Associated reservation % not found for payment %.', v_payment.reservation_id, v_payment.id;
    END IF;

    -- Check if hold has expired
    IF v_reservation.status = 'expired' OR (v_reservation.status = 'pending' AND v_reservation.hold_expires_at IS NOT NULL AND v_reservation.hold_expires_at <= now()) THEN
        v_is_hold_expired := true;
    END IF;

    -- Check if reservation was cancelled or declined
    IF v_reservation.status IN ('cancelled', 'declined') THEN
        v_is_hold_expired := true;
    END IF;

    -- Check if another reservation has confirmed the court slot during this window
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

    -- 5. RECONCILIATION BRANCHING

    -- BRANCH A: Reservation is valid and court slot is available -> CONFIRM BOOKING & POST SETTLEMENT
    IF NOT v_is_hold_expired AND NOT v_is_slot_conflicted AND v_reservation.status = 'pending' THEN
        -- 5A.1 Update Payment to Captured
        UPDATE public.payments
        SET status = 'captured',
            captured_amount = p_captured_amount,
            provider_payment_id = v_clean_payment_id,
            captured_at = now(),
            verified_capture_evidence = verified_capture_evidence || jsonb_build_object('webhook_event_id', p_webhook_event_id, 'reconciled_at', now())
        WHERE id = v_payment.id;

        -- 5A.2 Confirm Reservation
        UPDATE public.reservations
        SET status = 'confirmed',
            hold_expires_at = NULL,
            updated_at = now()
        WHERE id = v_reservation.id;

        -- 5A.3 Post Financial Journal Entry via post_booking_settlement_event:
        --   Debit:  1010 (Gateway Receivable)        ₱350.00
        --   Credit: 4010 (Platform Commission)       ₱17.50
        --   Credit: 2010 (Owner Unsettled Clearing)  ₱332.50
        v_journal_res := public.post_booking_settlement_event(
            v_payment.organization_id,
            v_payment.facility_id,
            v_reservation.id,
            p_captured_amount,
            v_payment.commission_rate,
            v_clean_key,
            p_metadata || jsonb_build_object(
                'payment_id', v_payment.id,
                'reservation_id', v_reservation.id,
                'reference_code', v_reservation.reference_code,
                'provider_payment_id', v_clean_payment_id
            )
        );

        IF p_webhook_event_id IS NOT NULL THEN
            UPDATE public.provider_webhook_events
            SET processing_state = 'processed',
                processed_at = now()
            WHERE id = p_webhook_event_id;
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'outcome', 'confirmed_and_settled',
            'reservation_id', v_reservation.id,
            'reference_code', v_reservation.reference_code,
            'payment_id', v_payment.id,
            'status', 'confirmed',
            'journal_transaction_id', v_journal_res->>'transaction_id'
        );

    -- BRANCH B: Late Payment Capture After Hold Expiration or Conflict -> PRESERVE FUNDS AS LIABILITY
    ELSE
        -- 5B.1 Update Payment to Captured (provider genuinely captured money)
        UPDATE public.payments
        SET status = 'captured',
            captured_amount = p_captured_amount,
            provider_payment_id = v_clean_payment_id,
            captured_at = now(),
            verified_capture_evidence = verified_capture_evidence || jsonb_build_object(
                'requires_refund', true,
                'refund_reason', CASE WHEN v_is_slot_conflicted THEN 'court_slot_collision' ELSE 'payment_after_hold_expiration' END,
                'webhook_event_id', p_webhook_event_id
            )
        WHERE id = v_payment.id;

        -- 5B.2 Mark Reservation Expired if it was pending
        IF v_reservation.status = 'pending' THEN
            UPDATE public.reservations
            SET status = 'expired',
                updated_at = now()
            WHERE id = v_reservation.id;
        END IF;

        -- 5B.3 Post Excess / Late Payment Liability Financial Journal:
        --   Debit:  1010 (Gateway Receivable)         ₱350.00
        --   Credit: 2030 (Customer Refund Liability)  ₱350.00
        -- ZERO Owner Balance Inflation (Platform does NOT credit owner for unfulfilled booking)
        v_journal_res := public.post_excess_or_late_payment_event(
            v_payment.organization_id,
            v_payment.facility_id,
            v_payment.id,
            p_captured_amount,
            true, -- is_late = true
            v_clean_key,
            p_metadata || jsonb_build_object(
                'reservation_id', v_reservation.id,
                'conflict_reason', CASE WHEN v_is_slot_conflicted THEN 'slot_collision' ELSE 'expired_hold' END,
                'provider_payment_id', v_clean_payment_id
            )
        );

        IF p_webhook_event_id IS NOT NULL THEN
            UPDATE public.provider_webhook_events
            SET processing_state = 'processed',
                last_error = 'Late capture: booking could not be confirmed; customer refund liability created',
                processed_at = now()
            WHERE id = p_webhook_event_id;
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'outcome', 'late_payment_liability_recorded',
            'reservation_id', v_reservation.id,
            'reservation_status', 'expired',
            'payment_id', v_payment.id,
            'requires_refund', true,
            'journal_transaction_id', v_journal_res->>'transaction_id'
        );
    END IF;
END;
$$;

COMMENT ON FUNCTION public.process_verified_payment_event IS 'Reconciles verified payment capture against reservations; confirms booking or records customer refund liability.';


-- ==============================================================================
-- 3. Settlement Clearing Ingestion (Funds Cleared to Bank)
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
    v_journal_res JSONB;
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for settlement clearing.';
    END IF;

    IF p_net_amount IS NULL OR p_net_amount <= 0.00 THEN
        RAISE EXCEPTION 'Settlement clearing net amount must be strictly positive. Got: ₱%', p_net_amount;
    END IF;

    -- Verify settlement batch existence if provided
    IF p_batch_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.settlement_batches WHERE id = p_batch_id) THEN
            RAISE EXCEPTION 'Settlement batch ID % not found.', p_batch_id;
        END IF;
    END IF;

    -- Invoke post_funds_cleared_event:
    --   Debit:  1020 (Platform Settled Cash)         ₱332.50
    --   Debit:  2010 (Owner Unsettled Clearing)      ₱332.50
    --   Credit: 1010 (Gateway Receivable)            ₱332.50
    --   Credit: 2011 (Owner Available Withdrawable)  ₱332.50
    -- Updates organization_balances: unsettled_clearing_amount -= net_amount, available_withdrawable_balance += net_amount.
    v_journal_res := public.post_funds_cleared_event(
        p_organization_id,
        p_facility_id,
        p_net_amount,
        p_provider_batch_id,
        v_clean_key,
        p_metadata || jsonb_build_object('batch_id', p_batch_id)
    );

    IF p_batch_id IS NOT NULL THEN
        UPDATE public.settlement_batches
        SET status = 'reconciled',
            reconciled_at = now(),
            updated_at = now()
        WHERE id = p_batch_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'batch_id', p_batch_id,
        'net_amount', p_net_amount,
        'journal_transaction_id', v_journal_res->>'transaction_id'
    );
END;
$$;

COMMENT ON FUNCTION public.process_settlement_clearing IS 'Transitions cleared provider settlement funds into owner withdrawable balance.';


-- ==============================================================================
-- 4. Verified Refunds & Chargebacks Processing
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.process_verified_refund_event(
    p_payment_id UUID,
    p_refund_amount NUMERIC(10, 2),
    p_reason TEXT,
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
    v_payment RECORD;
    v_new_refunded_total NUMERIC(10, 2);
    v_target_status VARCHAR(50);
    v_commission_reversal NUMERIC(10, 2);
    v_journal_res JSONB;
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for refund processing.';
    END IF;

    IF p_refund_amount IS NULL OR p_refund_amount <= 0.00 THEN
        RAISE EXCEPTION 'Refund amount must be strictly positive. Got: ₱%', p_refund_amount;
    END IF;

    SELECT * INTO v_payment
    FROM public.payments
    WHERE id = p_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment ID % not found.', p_payment_id;
    END IF;

    IF v_payment.status NOT IN ('captured', 'partially_refunded') THEN
        RAISE EXCEPTION 'Payment % cannot be refunded: current status is "%".', v_payment.id, v_payment.status;
    END IF;

    v_new_refunded_total := v_payment.refunded_amount + p_refund_amount;

    IF v_new_refunded_total > v_payment.captured_amount THEN
        RAISE EXCEPTION 'Refund violation: Total refunded (₱%) cannot exceed captured funds (₱%).',
            v_new_refunded_total, v_payment.captured_amount;
    END IF;

    IF v_new_refunded_total = v_payment.captured_amount THEN
        v_target_status := 'refunded';
    ELSE
        v_target_status := 'partially_refunded';
    END IF;

    -- Proportional commission reversal
    v_commission_reversal := ROUND((p_refund_amount * v_payment.commission_rate), 2);

    -- Update Payment status and refunded_amount
    UPDATE public.payments
    SET status = v_target_status,
        refunded_amount = v_new_refunded_total,
        verified_capture_evidence = verified_capture_evidence || jsonb_build_object('last_refund_reason', p_reason, 'last_refund_at', now())
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

    -- Post Financial Journal via post_refund_reversal_event:
    -- Double-entry reversal of platform commission and owner share
    v_journal_res := public.post_refund_reversal_event(
        v_payment.organization_id,
        v_payment.facility_id,
        v_payment.reservation_id,
        p_refund_amount,
        v_payment.commission_rate,
        v_clean_key,
        p_metadata || jsonb_build_object('reason', p_reason, 'is_partial', p_is_partial, 'payment_id', v_payment.id)
    );

    RETURN jsonb_build_object(
        'success', true,
        'payment_id', v_payment.id,
        'refund_amount', p_refund_amount,
        'total_refunded', v_new_refunded_total,
        'status', v_target_status,
        'journal_transaction_id', v_journal_res->>'transaction_id'
    );
END;
$$;

COMMENT ON FUNCTION public.process_verified_refund_event IS 'Processes verified refunds, updates payment lifecycle, and posts double-entry financial reversals.';


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

    -- Invoke post_payout_reserve_event:
    --   Debit:  2011 (Owner Available Withdrawable)  ₱1000.00
    --   Credit: 2015 (Owner Pending Payout Reserve)  ₱1000.00
    -- If available balance < p_amount, 005a1 raises Insufficient withdrawable balance and rolls back!
    v_journal_res := public.post_payout_reserve_event(
        p_organization_id,
        v_payout_id,
        p_amount,
        v_clean_key,
        p_metadata || jsonb_build_object('payout_id', v_payout_id)
    );

    RETURN jsonb_build_object(
        'success', true,
        'payout_id', v_payout_id,
        'amount', p_amount,
        'status', 'approved_reserved',
        'journal_transaction_id', v_journal_res->>'transaction_id'
    );
END;
$$;

COMMENT ON FUNCTION public.request_owner_payout IS 'Authorizes owner payout request, advances through state machine, and locks reserve funds in Account 2015.';


CREATE OR REPLACE FUNCTION public.confirm_owner_payout_disbursement(
    p_payout_id UUID,
    p_provider_payout_id TEXT,
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
    v_clean_prov_id TEXT;
    v_payout RECORD;
    v_journal_res JSONB;
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for payout confirmation.';
    END IF;

    v_clean_prov_id := NULLIF(trim(COALESCE(p_provider_payout_id, '')), '');
    IF v_clean_prov_id IS NULL THEN
        RAISE EXCEPTION 'Authoritative provider_payout_id is required.';
    END IF;

    SELECT * INTO v_payout
    FROM public.payouts
    WHERE id = p_payout_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payout ID % not found.', p_payout_id;
    END IF;

    IF v_payout.status = 'paid' THEN
        RETURN jsonb_build_object('success', true, 'status', 'paid', 'idempotent_replayed', true);
    END IF;

    -- Advance state machine: approved_reserved -> submitted_to_provider -> paid
    IF v_payout.status = 'approved_reserved' THEN
        UPDATE public.payouts
        SET status = 'submitted_to_provider',
            provider_payout_id = v_clean_prov_id
        WHERE id = v_payout.id;
    END IF;

    UPDATE public.payouts
    SET status = 'paid',
        provider_payout_id = v_clean_prov_id,
        completed_at = now()
    WHERE id = v_payout.id;

    -- Invoke post_payout_disbursement_event:
    --   Debit:  2015 (Owner Pending Payout Reserve)  ₱1000.00
    --   Credit: 1020 (Platform Settled Cash)         ₱1000.00
    v_journal_res := public.post_payout_disbursement_event(
        v_payout.organization_id,
        v_payout.id,
        v_payout.amount,
        v_clean_key,
        p_metadata || jsonb_build_object('provider_payout_id', v_clean_prov_id)
    );

    RETURN jsonb_build_object(
        'success', true,
        'payout_id', v_payout.id,
        'amount', v_payout.amount,
        'status', 'paid',
        'journal_transaction_id', v_journal_res->>'transaction_id'
    );
END;
$$;

COMMENT ON FUNCTION public.confirm_owner_payout_disbursement IS 'Confirms provider payout transfer, sets status paid, and settles pending reserve.';


CREATE OR REPLACE FUNCTION public.fail_owner_payout_release(
    p_payout_id UUID,
    p_reason TEXT,
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
    v_payout RECORD;
    v_journal_res JSONB;
BEGIN
    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is required for payout failure release.';
    END IF;

    SELECT * INTO v_payout
    FROM public.payouts
    WHERE id = p_payout_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payout ID % not found.', p_payout_id;
    END IF;

    IF v_payout.status IN ('paid', 'failed', 'cancelled') THEN
        IF v_payout.status = 'failed' THEN
            RETURN jsonb_build_object('success', true, 'status', 'failed', 'idempotent_replayed', true);
        END IF;
        RAISE EXCEPTION 'Payout % is in terminal status "%" and cannot be failed.', v_payout.id, v_payout.status;
    END IF;

    -- Advance to failed status
    UPDATE public.payouts
    SET status = 'failed',
        failure_reason = p_reason,
        failed_at = now()
    WHERE id = v_payout.id;

    -- Invoke post_payout_failed_release_event:
    --   Debit:  2015 (Owner Pending Payout Reserve)  ₱1000.00
    --   Credit: 2011 (Owner Available Withdrawable)  ₱1000.00
    v_journal_res := public.post_payout_failed_release_event(
        v_payout.organization_id,
        v_payout.id,
        v_payout.amount,
        v_clean_key,
        p_metadata || jsonb_build_object('fail_reason', p_reason)
    );

    RETURN jsonb_build_object(
        'success', true,
        'payout_id', v_payout.id,
        'amount', v_payout.amount,
        'status', 'failed',
        'journal_transaction_id', v_journal_res->>'transaction_id'
    );
END;
$$;

COMMENT ON FUNCTION public.fail_owner_payout_release IS 'Transitions failed provider payout to failed status and safely restores reserve funds back to available balance.';


-- ==============================================================================
-- 6. Least Privilege & Authorization Boundary
-- ==============================================================================
-- Revoke all by default from PUBLIC, anon
REVOKE ALL ON FUNCTION public.create_booking_checkout_session(TEXT, UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_verified_payment_event(UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, NUMERIC, VARCHAR, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_settlement_clearing(UUID, UUID, UUID, NUMERIC, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_verified_refund_event(UUID, NUMERIC, TEXT, TEXT, BOOLEAN, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_owner_payout(UUID, UUID, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_owner_payout_disbursement(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_owner_payout_release(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- Customers: checkout initialization accessible to public (anon & authenticated)
GRANT EXECUTE ON FUNCTION public.create_booking_checkout_session(TEXT, UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, TEXT, TEXT) TO anon, authenticated, service_role;

-- Facility owners / admins: payout request accessible to authenticated & service_role
GRANT EXECUTE ON FUNCTION public.request_owner_payout(UUID, UUID, NUMERIC, TEXT, JSONB) TO authenticated, service_role;

-- Trusted Backend Service Role: verified processing functions strictly restricted to service_role
GRANT EXECUTE ON FUNCTION public.process_verified_payment_event(UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, NUMERIC, VARCHAR, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_settlement_clearing(UUID, UUID, UUID, NUMERIC, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_verified_refund_event(UUID, NUMERIC, TEXT, TEXT, BOOLEAN, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_owner_payout_disbursement(UUID, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_owner_payout_release(UUID, TEXT, TEXT, JSONB) TO service_role;

COMMIT;
