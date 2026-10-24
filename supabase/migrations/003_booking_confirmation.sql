-- ==============================================================================
-- CourtBook / BookSuite — Database Schema Migration
-- Migration: 003_booking_confirmation.sql
-- Description:
--   Phase 2: Real Reservations with facility-configurable booking confirmation.
--   1. Facility configuration: 'instant' vs 'manual_approval' with configurable hold duration.
--   2. Extended reservation statuses: 'pending', 'declined', 'expired'.
--   3. Hold expiration tracking: hold_expires_at, reviewed_at, reviewed_by, review_notes.
--   4. Non-volatile btree_gist exclusion constraint on (status IN ('confirmed', 'pending')).
--   5. Consistent row-level locking hierarchy across all functions:
--      Courts row lock (FOR UPDATE) acquired FIRST, Reservations row lock SECOND.
--   6. Hardened SECURITY DEFINER routines for staff approval and decline.
--   7. Secure, tenant-isolated expiration routines:
--      - expire_stale_reservations(): Global cleanup strictly restricted to service_role / cron.
--      - expire_facility_stale_reservations(facility_id): Staff-triggered, verified by auth.uid().
--   8. Updated availability function recognizing active holds.
--   9. Updated create_public_reservation supporting both confirmation modes.
--  10. Dedicated procedure for updating confirmation settings with RBAC check.
-- ==============================================================================

-- ==============================================================================
-- 1. Facility Configuration for Confirmation Mode
-- ==============================================================================

ALTER TABLE public.facilities
ADD COLUMN IF NOT EXISTS booking_confirmation_mode TEXT NOT NULL DEFAULT 'instant'
    CHECK (booking_confirmation_mode IN ('instant', 'manual_approval')),
ADD COLUMN IF NOT EXISTS hold_duration_minutes INT NOT NULL DEFAULT 30
    CHECK (hold_duration_minutes >= 5 AND hold_duration_minutes <= 1440);

COMMENT ON COLUMN public.facilities.booking_confirmation_mode IS 'Facility booking mode: instant confirmation or owner manual approval.';
COMMENT ON COLUMN public.facilities.hold_duration_minutes IS 'Duration in minutes a pending slot is held before auto-expiring.';

-- ==============================================================================
-- 2. Extended Reservation Statuses & Hold Tracking
-- ==============================================================================

ALTER TABLE public.reservations
ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS review_notes TEXT CHECK (review_notes IS NULL OR char_length(review_notes) <= 300);

-- Update check constraint on status to include 'pending', 'declined', 'expired'
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_status_check;
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS chk_reservation_status;

ALTER TABLE public.reservations
ADD CONSTRAINT chk_reservation_status
CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show', 'pending', 'declined', 'expired'));

-- Ensure hold_expires_at is non-null whenever status is 'pending'
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS chk_pending_hold_expires;
ALTER TABLE public.reservations
ADD CONSTRAINT chk_pending_hold_expires
CHECK (status != 'pending' OR hold_expires_at IS NOT NULL);

-- ==============================================================================
-- 3. Collision Prevention: Non-Volatile Exclusion Constraint
-- ==============================================================================
-- Strictly prevents overlapping active holds ('pending') and 'confirmed' bookings.
-- Zero volatile expressions (e.g. no now()) in the index predicate.

ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS prevent_court_overlapping_active_reservations;

ALTER TABLE public.reservations
ADD CONSTRAINT prevent_court_overlapping_active_reservations
EXCLUDE USING gist (
    court_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
)
WHERE (status IN ('confirmed', 'pending'));

CREATE INDEX IF NOT EXISTS idx_reservations_pending_holds
ON public.reservations (court_id, hold_expires_at)
WHERE (status = 'pending');

-- ==============================================================================
-- 4. Prevent Maintenance Collisions with Active Holds or Confirmed Bookings
-- ==============================================================================
-- Locks the target Court row FIRST to follow global locking hierarchy.

CREATE OR REPLACE FUNCTION public.validate_block_against_reservations()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM 1 FROM public.courts WHERE id = NEW.court_id FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM public.reservations
        WHERE court_id = NEW.court_id
          AND status IN ('confirmed', 'pending')
          AND tstzrange(start_time, end_time, '[)') && tstzrange(NEW.start_time, NEW.end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'Cannot block court: An active or pending reservation already exists during this period.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_validate_block_against_reservations ON public.court_blocked_times;
CREATE TRIGGER tr_validate_block_against_reservations
    BEFORE INSERT OR UPDATE ON public.court_blocked_times
    FOR EACH ROW EXECUTE FUNCTION public.validate_block_against_reservations();

-- ==============================================================================
-- 5. Stale Pending Hold Expiration Procedures & Strategy
-- ==============================================================================
--
-- EXPIRATION STRATEGY & DEPLOYMENT ARCHITECTURE:
--
-- 1. In-Line Opportunistic Cleanup (Active Fallback):
--    - When a customer initiates a booking, create_public_reservation() automatically
--      transitions any expired pending holds on the requested court while holding the court lock.
--    - When staff inspects or attempts to approve a request, approve_booking_request_as_staff()
--      checks hold_expires_at; if expired, it transitions the record to 'expired' and
--      returns a clean failure response without rolling back the transition.
--    This guarantees that even before any background worker executes, expired holds cannot block bookings.
--
-- 2. Proactive Recurring Cleanup (Deployment Plan):
--    To guarantee that held slots do not wait for another customer booking to be released,
--    the global procedure public.expire_stale_reservations() is provided.
--    Because pg_cron is not guaranteed to be pre-enabled in every Supabase project, deployment
--    teams must choose one of the following concrete execution strategies:
--
--    METHOD A — Scheduled Supabase Edge Function / HTTPS Scheduler (Recommended for Supabase):
--      1. Deploy an Edge Function (e.g. 'cleanup-expired-holds') that calls:
--         POST https://<PROJECT_REF>.supabase.co/rest/v1/rpc/expire_stale_reservations
--         Headers:
--           apikey: <SERVICE_ROLE_KEY>
--           Authorization: Bearer <SERVICE_ROLE_KEY>
--           Content-Type: application/json
--      2. Schedule the Edge Function using Supabase Scheduled Functions, Cloudflare Cron Triggers,
--         GitHub Actions schedule, or AWS EventBridge on a 1-to-5 minute cadence.
--      3. Security: The service_role key is kept strictly in server secrets and never exposed to clients.
--
--    METHOD B — In-Database pg_cron (When extension is enabled by administrator):
--      1. Verify or enable the extension in the Supabase Dashboard (Database -> Extensions -> pg_cron):
--         CREATE EXTENSION IF NOT EXISTS pg_cron;
--      2. Register the scheduled cron job to run every 2 minutes:
--         SELECT cron.schedule(
--           'expire-stale-holds',
--           '*/2 * * * *',
--           $$SELECT public.expire_stale_reservations();$$
--         );
--      3. To inspect or remove the job:
--         SELECT * FROM cron.job WHERE jobname = 'expire-stale-holds';
--         SELECT cron.unschedule('expire-stale-holds');
--
--    METHOD C — External Daemon / Backend Cron:
--      1. An Express/Node.js or Python backend worker running every minute invoking the RPC
--         via the supabase-js client initialized with SUPABASE_SERVICE_ROLE_KEY:
--         const { data, error } = await supabaseAdmin.rpc('expire_stale_reservations');
--
-- 3. Authorization Boundary & Security:
--    - public.expire_stale_reservations() does NOT use current_user, session_user, or any
--      caller-settable session variables.
--    - EXECUTE is unconditionally REVOKED from PUBLIC, anon, and authenticated.
--    - EXECUTE is granted ONLY to service_role (the trusted backend service).
--    - public.expire_facility_stale_reservations(facility_id) is provided separately for authenticated
--      facility staff, which verifies auth.uid() and facility staff membership via is_facility_staff().
--      It operates ONLY within the caller's authorized facility.
--
-- 4. Concurrency & Deadlock Prevention:
--    - Lock Order Rule: In all multi-table transactions, Court locks (FOR UPDATE) are ALWAYS
--      acquired FIRST (ordered deterministically by court_id if multiple), and Reservation locks
--      (FOR UPDATE) are ALWAYS acquired SECOND.
--    - Expiration functions (both global and facility-scoped) update public.reservations directly
--      and NEVER request or acquire Court locks. Since expiration transactions never hold a reservation
--      lock while waiting for a court lock, circular lock waits (deadlocks) are impossible.

DROP FUNCTION IF EXISTS public.expire_stale_reservations(UUID);

CREATE OR REPLACE FUNCTION public.expire_stale_reservations()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count INT;
BEGIN
    UPDATE public.reservations
    SET status = 'expired',
        updated_at = now()
    WHERE status = 'pending'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= now();

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Global expiration is strictly restricted to service_role / superuser.
REVOKE ALL ON FUNCTION public.expire_stale_reservations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_reservations() FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_reservations() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_reservations() TO service_role;

-- Facility-scoped expiration executable by authenticated staff for their specific facility
CREATE OR REPLACE FUNCTION public.expire_facility_stale_reservations(
    p_facility_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count INT;
BEGIN
    IF p_facility_id IS NULL THEN
        RAISE EXCEPTION 'Facility ID is required and cannot be NULL.';
    END IF;

    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    IF NOT public.is_facility_staff(p_facility_id, ARRAY['owner', 'admin', 'staff']) THEN
        RAISE EXCEPTION 'Access denied: You do not have permissions to manage reservations for this facility.';
    END IF;

    UPDATE public.reservations
    SET status = 'expired',
        updated_at = now()
    WHERE facility_id = p_facility_id
      AND status = 'pending'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= now();

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_facility_stale_reservations(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_facility_stale_reservations(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.expire_facility_stale_reservations(UUID) TO authenticated, service_role;

-- ==============================================================================
-- 6. Trigger: Restrict Reservation Modifications with Phase 2 Statuses
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.restrict_reservation_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Unconditionally reject modifications to immutable record identifiers and origin metadata
    IF NEW.id != OLD.id OR
       NEW.facility_id != OLD.facility_id OR
       NEW.reference_code != OLD.reference_code OR
       NEW.customer_name != OLD.customer_name OR
       NEW.customer_phone IS DISTINCT FROM OLD.customer_phone OR
       NEW.customer_email IS DISTINCT FROM OLD.customer_email OR
       NEW.currency != OLD.currency OR
       NEW.created_at != OLD.created_at OR
       NEW.is_demo != OLD.is_demo THEN
        RAISE EXCEPTION 'Modification of reservation identifiers, facility, customer ownership, or creation metadata is strictly prohibited.';
    END IF;

    -- Validated status transitions
    IF OLD.status = 'cancelled' AND NEW.status != 'cancelled' THEN
        RAISE EXCEPTION 'Cannot re-activate a cancelled reservation.';
    END IF;

    IF OLD.status = 'declined' AND NEW.status != 'declined' THEN
        RAISE EXCEPTION 'Cannot re-activate a declined reservation.';
    END IF;

    IF OLD.status = 'expired' AND NEW.status != 'expired' THEN
        RAISE EXCEPTION 'Cannot re-activate an expired reservation.';
    END IF;

    IF OLD.status = 'completed' AND NEW.status != 'completed' THEN
        RAISE EXCEPTION 'Cannot alter the status of a completed reservation.';
    END IF;

    IF NEW.status NOT IN ('confirmed', 'cancelled', 'completed', 'no_show', 'pending', 'declined', 'expired') THEN
        RAISE EXCEPTION 'Invalid reservation status value: %', NEW.status;
    END IF;

    -- Auto-populate cancellation metadata when transitioning to cancelled
    IF NEW.status = 'cancelled' AND OLD.status != 'cancelled' THEN
        IF NEW.cancelled_at IS NULL THEN
            NEW.cancelled_at := now();
        END IF;
        IF NEW.cancelled_by IS NULL THEN
            NEW.cancelled_by := auth.uid();
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_restrict_reservation_updates ON public.reservations;
CREATE TRIGGER tr_restrict_reservation_updates
    BEFORE UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION public.restrict_reservation_updates();

-- ==============================================================================
-- 7. Hardened Staff Booking Request Approval
-- ==============================================================================
-- Consistent Lock Order:
--   1. Reads target reservation metadata (without row lock).
--   2. Verifies staff authorization for facility.
--   3. Row-locks target Court (FOR UPDATE) FIRST.
--   4. Row-locks target Reservation (FOR UPDATE) SECOND.
--   5. Evaluates hold expiration, maintenance blocks, and atomically confirms.

CREATE OR REPLACE FUNCTION public.approve_booking_request_as_staff(
    p_reservation_id UUID,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID;
    v_court_id UUID;
    v_facility_id UUID;
    v_res RECORD;
    v_court RECORD;
BEGIN
    -- 1. Parameter Validation
    IF p_reservation_id IS NULL THEN
        RAISE EXCEPTION 'Reservation ID is required and cannot be NULL.';
    END IF;

    -- 2. Verify caller authentication
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- 3. Read reservation metadata without row lock to determine court & facility
    SELECT court_id, facility_id
    INTO v_court_id, v_facility_id
    FROM public.reservations
    WHERE id = p_reservation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reservation not found.';
    END IF;

    -- 4. Verify facility authorization (owner, admin, or staff of that facility)
    IF NOT public.is_facility_staff(v_facility_id, ARRAY['owner', 'admin', 'staff']) THEN
        RAISE EXCEPTION 'Access denied: You do not have permissions to manage reservations for this facility.';
    END IF;

    -- 5. Consistent locking hierarchy: Lock Court FIRST
    SELECT * INTO v_court
    FROM public.courts
    WHERE id = v_court_id
    FOR UPDATE;

    IF NOT FOUND OR NOT v_court.is_enabled THEN
        RAISE EXCEPTION 'Court is currently disabled or unavailable.';
    END IF;

    -- 6. Consistent locking hierarchy: Lock Reservation SECOND
    SELECT * INTO v_res
    FROM public.reservations
    WHERE id = p_reservation_id
    FOR UPDATE;

    -- 7. Status validation
    IF v_res.status != 'pending' THEN
        RAISE EXCEPTION 'Only pending requests can be approved. Current status: %', v_res.status;
    END IF;

    -- 8. Check hold expiration
    -- If the hold has expired, transition the reservation to 'expired' and return success: false
    -- rather than raising an unhandled exception which would roll back the expiration update.
    -- This guarantees the held slot is reliably released and the caller receives an informative response.
    IF v_res.hold_expires_at IS NOT NULL AND v_res.hold_expires_at <= now() THEN
        UPDATE public.reservations
        SET status = 'expired',
            updated_at = now()
        WHERE id = p_reservation_id;

        RETURN jsonb_build_object(
            'success', false,
            'reservation_id', p_reservation_id,
            'reference_code', v_res.reference_code,
            'status', 'expired',
            'error', 'Reservation hold has expired. The court slot has been released.'
        );
    END IF;

    -- 9. Verify no maintenance block was placed during the held slot
    IF EXISTS (
        SELECT 1
        FROM public.court_blocked_times
        WHERE court_id = v_res.court_id
          AND tstzrange(start_time, end_time, '[)') && tstzrange(v_res.start_time, v_res.end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'Cannot approve: Court is scheduled for maintenance during this time slot.';
    END IF;

    -- 10. Atomically approve and confirm
    UPDATE public.reservations
    SET status = 'confirmed',
        reviewed_at = now(),
        reviewed_by = v_caller_id,
        review_notes = NULLIF(trim(p_notes), ''),
        updated_at = now()
    WHERE id = p_reservation_id;

    RETURN jsonb_build_object(
        'success', true,
        'reservation_id', p_reservation_id,
        'reference_code', v_res.reference_code,
        'status', 'confirmed',
        'customer_name', v_res.customer_name,
        'court_id', v_res.court_id,
        'booking_date', v_res.booking_date,
        'time_slot_label', v_res.time_slot_label
    );
EXCEPTION
    WHEN exclusion_violation THEN
        RAISE EXCEPTION 'Cannot approve: Conflicting booking already confirmed for this court slot.';
END;
$$;

REVOKE ALL ON FUNCTION public.approve_booking_request_as_staff(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_booking_request_as_staff(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.approve_booking_request_as_staff(UUID, TEXT) TO authenticated;

-- ==============================================================================
-- 8. Hardened Staff Booking Request Decline
-- ==============================================================================
-- Consistent Lock Order:
--   1. Reads target reservation metadata (without row lock).
--   2. Verifies staff authorization for facility.
--   3. Row-locks target Court (FOR UPDATE) FIRST.
--   4. Row-locks target Reservation (FOR UPDATE) SECOND.
--   5. Transitions status to 'declined', releasing slot hold.

CREATE OR REPLACE FUNCTION public.decline_booking_request_as_staff(
    p_reservation_id UUID,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID;
    v_court_id UUID;
    v_facility_id UUID;
    v_res RECORD;
BEGIN
    -- 1. Parameter Validation
    IF p_reservation_id IS NULL THEN
        RAISE EXCEPTION 'Reservation ID is required and cannot be NULL.';
    END IF;

    -- 2. Verify caller authentication
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- 3. Read reservation metadata without row lock to obtain court & facility
    SELECT court_id, facility_id
    INTO v_court_id, v_facility_id
    FROM public.reservations
    WHERE id = p_reservation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reservation not found.';
    END IF;

    -- 4. Verify facility authorization
    IF NOT public.is_facility_staff(v_facility_id, ARRAY['owner', 'admin', 'staff']) THEN
        RAISE EXCEPTION 'Access denied: You do not have permissions to manage reservations for this facility.';
    END IF;

    -- 5. Consistent locking hierarchy: Lock Court FIRST
    PERFORM 1
    FROM public.courts
    WHERE id = v_court_id
    FOR UPDATE;

    -- 6. Consistent locking hierarchy: Lock Reservation SECOND
    SELECT * INTO v_res
    FROM public.reservations
    WHERE id = p_reservation_id
    FOR UPDATE;

    -- 7. Status validation
    IF v_res.status != 'pending' THEN
        RAISE EXCEPTION 'Only pending requests can be declined. Current status: %', v_res.status;
    END IF;

    -- 8. Atomically decline and release slot hold
    UPDATE public.reservations
    SET status = 'declined',
        reviewed_at = now(),
        reviewed_by = v_caller_id,
        review_notes = NULLIF(trim(p_reason), ''),
        updated_at = now()
    WHERE id = p_reservation_id;

    RETURN jsonb_build_object(
        'success', true,
        'reservation_id', p_reservation_id,
        'reference_code', v_res.reference_code,
        'status', 'declined'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.decline_booking_request_as_staff(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decline_booking_request_as_staff(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.decline_booking_request_as_staff(UUID, TEXT) TO authenticated;

-- ==============================================================================
-- 9. Hardened Staff Reservation Rescheduling Procedure
-- ==============================================================================
-- Replaces earlier reschedule routine to enforce identical lock hierarchy:
--   1. Validates all inputs (rejecting NULL explicitly).
--   2. Locks affected Court(s) in deterministic sorted ID order FIRST.
--   3. Locks Reservation row SECOND.

CREATE OR REPLACE FUNCTION public.reschedule_reservation_as_staff(
    p_reservation_id UUID,
    p_new_court_id UUID,
    p_new_date DATE,
    p_new_start_time TIMESTAMPTZ,
    p_new_duration_minutes INT DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID;
    v_current_court_id UUID;
    v_facility_id UUID;
    v_res_status TEXT;
    v_res RECORD;
    v_court RECORD;
    v_facility RECORD;
    v_end_time TIMESTAMPTZ;
    v_local_start TIMESTAMP;
    v_local_end TIMESTAMP;
    v_local_open TIMESTAMP;
    v_local_close TIMESTAMP;
    v_hourly_rate NUMERIC(10, 2);
    v_total_price NUMERIC(10, 2);
    v_time_slot_label TEXT;
BEGIN
    -- 1. Parameter Validation (Reject NULL explicitly)
    IF p_reservation_id IS NULL OR
       p_new_court_id IS NULL OR
       p_new_date IS NULL OR
       p_new_start_time IS NULL OR
       p_new_duration_minutes IS NULL THEN
        RAISE EXCEPTION 'All rescheduling parameters (reservation ID, court ID, date, start time, duration) are required and cannot be NULL.';
    END IF;

    -- 2. Verify caller authentication
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- 3. Validate duration bounds
    IF p_new_duration_minutes < 30 OR p_new_duration_minutes > 480 OR (p_new_duration_minutes % 30 != 0) THEN
        RAISE EXCEPTION 'Booking duration must be between 30 minutes and 8 hours in 30-minute intervals.';
    END IF;

    -- 4. Validate future start time
    IF p_new_start_time <= now() THEN
        RAISE EXCEPTION 'Cannot reschedule a reservation to a time in the past.';
    END IF;

    v_end_time := p_new_start_time + (p_new_duration_minutes || ' minutes')::INTERVAL;

    -- 5. Read reservation metadata without row lock to obtain current court and facility
    SELECT court_id, facility_id, status
    INTO v_current_court_id, v_facility_id, v_res_status
    FROM public.reservations
    WHERE id = p_reservation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reservation not found.';
    END IF;

    -- 6. Permission check: Facility owner or admin only
    IF NOT public.is_facility_staff(v_facility_id, ARRAY['owner', 'admin']) THEN
        RAISE EXCEPTION 'Access denied: Only facility owners and admins can reschedule bookings.';
    END IF;

    IF v_res_status IN ('cancelled', 'completed', 'no_show', 'declined', 'expired') THEN
        RAISE EXCEPTION 'Cannot reschedule a reservation that is %.', v_res_status;
    END IF;

    IF v_res_status != 'confirmed' THEN
        RAISE EXCEPTION 'Only active confirmed reservations can be rescheduled.';
    END IF;

    -- 7. Consistent lock order: Lock affected Courts FIRST in deterministic ID order
    PERFORM 1
    FROM public.courts
    WHERE id IN (v_current_court_id, p_new_court_id)
    ORDER BY id
    FOR UPDATE;

    -- 8. Consistent lock order: Lock Reservation SECOND
    SELECT * INTO v_res
    FROM public.reservations
    WHERE id = p_reservation_id
    FOR UPDATE;

    -- 9. Verify target court belongs to the same facility and is enabled
    SELECT * INTO v_court
    FROM public.courts
    WHERE id = p_new_court_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target court does not exist.';
    END IF;

    IF v_court.facility_id != v_res.facility_id THEN
        RAISE EXCEPTION 'Target court belongs to a different facility.';
    END IF;

    IF NOT v_court.is_enabled THEN
        RAISE EXCEPTION 'Target court is currently disabled by facility management.';
    END IF;

    -- 10. Load facility configuration
    SELECT * INTO v_facility
    FROM public.facilities
    WHERE id = v_res.facility_id AND is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Facility is not active or does not exist.';
    END IF;

    -- 11. Timezone-aware local date verification
    v_local_start := p_new_start_time AT TIME ZONE v_facility.timezone;
    v_local_end   := v_end_time AT TIME ZONE v_facility.timezone;

    IF v_local_start::date != p_new_date THEN
        RAISE EXCEPTION 'Booking date (%) does not match local facility start date (%).',
            p_new_date, v_local_start::date;
    END IF;

    -- 12. Operating hours verification
    v_local_open  := date_trunc('day', v_local_start) + (v_facility.open_hour || ' hours')::INTERVAL;
    v_local_close := date_trunc('day', v_local_start) + (v_facility.close_hour || ' hours')::INTERVAL;

    IF v_local_start < v_local_open OR v_local_end > v_local_close THEN
        RAISE EXCEPTION 'Rescheduled time falls outside facility operating hours (%:00 – %:00 %)',
            v_facility.open_hour, v_facility.close_hour, v_facility.timezone;
    END IF;

    -- 13. Court maintenance blocks verification
    IF EXISTS (
        SELECT 1
        FROM public.court_blocked_times
        WHERE court_id = p_new_court_id
          AND tstzrange(start_time, end_time, '[)') && tstzrange(p_new_start_time, v_end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'Target court is blocked for maintenance or private club event during this period.';
    END IF;

    -- 14. Server-authoritative price & label calculation
    v_hourly_rate := v_court.hourly_rate;
    v_total_price := ROUND((v_hourly_rate * (p_new_duration_minutes::NUMERIC / 60.0)), 2);
    v_time_slot_label := to_char(v_local_start, 'HH12:MI AM') || ' – ' || to_char(v_local_end, 'HH12:MI AM');

    -- 15. Apply update (Exclusion constraint prevent_court_overlapping_active_reservations
    -- automatically catches any concurrent overlapping booking on target court)
    UPDATE public.reservations
    SET court_id = p_new_court_id,
        booking_date = p_new_date,
        start_time = p_new_start_time,
        end_time = v_end_time,
        time_slot_label = v_time_slot_label,
        duration_minutes = p_new_duration_minutes,
        price = v_total_price,
        updated_at = now()
    WHERE id = p_reservation_id;

    RETURN jsonb_build_object(
        'success', true,
        'reservation_id', p_reservation_id,
        'reference_code', v_res.reference_code,
        'court_id', p_new_court_id,
        'court_name', v_court.name,
        'booking_date', p_new_date,
        'start_time', p_new_start_time,
        'end_time', v_end_time,
        'time_slot_label', v_time_slot_label,
        'duration_minutes', p_new_duration_minutes,
        'total_price', v_total_price,
        'currency', v_facility.currency,
        'status', 'confirmed'
    );
EXCEPTION
    WHEN exclusion_violation THEN
        RAISE EXCEPTION 'Target court slot is already booked for the selected time window.';
END;
$$;

REVOKE ALL ON FUNCTION public.reschedule_reservation_as_staff(UUID, UUID, DATE, TIMESTAMPTZ, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reschedule_reservation_as_staff(UUID, UUID, DATE, TIMESTAMPTZ, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.reschedule_reservation_as_staff(UUID, UUID, DATE, TIMESTAMPTZ, INT) TO authenticated;

-- ==============================================================================
-- 10. Staff Configuration Update Procedure
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.update_facility_confirmation_settings(
    p_facility_id UUID,
    p_mode TEXT,
    p_hold_minutes INT DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID;
    v_fac RECORD;
BEGIN
    IF p_facility_id IS NULL OR p_mode IS NULL OR p_hold_minutes IS NULL THEN
        RAISE EXCEPTION 'All confirmation setting parameters (facility ID, mode, hold minutes) are required and cannot be NULL.';
    END IF;

    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    IF NOT public.is_facility_staff(p_facility_id, ARRAY['owner', 'admin']) THEN
        RAISE EXCEPTION 'Access denied: Only facility owners and admins can configure booking confirmation settings.';
    END IF;

    IF p_mode NOT IN ('instant', 'manual_approval') THEN
        RAISE EXCEPTION 'Invalid confirmation mode. Must be either "instant" or "manual_approval".';
    END IF;

    IF p_hold_minutes < 5 OR p_hold_minutes > 1440 THEN
        RAISE EXCEPTION 'Hold duration must be between 5 and 1440 minutes.';
    END IF;

    UPDATE public.facilities
    SET booking_confirmation_mode = p_mode,
        hold_duration_minutes = p_hold_minutes,
        updated_at = now()
    WHERE id = p_facility_id
    RETURNING * INTO v_fac;

    RETURN jsonb_build_object(
        'success', true,
        'facility_id', p_facility_id,
        'booking_confirmation_mode', v_fac.booking_confirmation_mode,
        'hold_duration_minutes', v_fac.hold_duration_minutes
    );
END;
$$;

REVOKE ALL ON FUNCTION public.update_facility_confirmation_settings(UUID, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_facility_confirmation_settings(UUID, TEXT, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_facility_confirmation_settings(UUID, TEXT, INT) TO authenticated;

-- ==============================================================================
-- 11. Update Public Busy Slots Check to Recognize Active Holds
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.get_court_busy_slots(
    p_court_id UUID,
    p_date DATE
)
RETURNS TABLE (
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    slot_type TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tz TEXT;
    v_day_start TIMESTAMPTZ;
    v_day_end TIMESTAMPTZ;
BEGIN
    SELECT f.timezone INTO v_tz
    FROM public.courts c
    JOIN public.facilities f ON f.id = c.facility_id
    WHERE c.id = p_court_id AND c.is_enabled = true AND f.is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Court % is not available for booking (nonexistent, disabled, or inactive facility).', p_court_id;
    END IF;

    -- Compute calendar day boundaries independently in local IANA timezone
    v_day_start := (p_date::TEXT || ' 00:00:00')::TIMESTAMP AT TIME ZONE v_tz;
    v_day_end   := ((p_date + 1)::TEXT || ' 00:00:00')::TIMESTAMP AT TIME ZONE v_tz;

    RETURN QUERY
    -- Confirmed reservations & active unexpired pending holds
    SELECT
        r.start_time,
        r.end_time,
        CASE
            WHEN r.status = 'pending' THEN 'held'::TEXT
            ELSE 'reserved'::TEXT
        END AS slot_type
    FROM public.reservations r
    WHERE r.court_id = p_court_id
      AND (
          r.status = 'confirmed'
          OR (r.status = 'pending' AND (r.hold_expires_at IS NULL OR r.hold_expires_at > now()))
      )
      AND tstzrange(r.start_time, r.end_time, '[)') && tstzrange(v_day_start, v_day_end, '[)')

    UNION ALL

    -- Maintenance blocks
    SELECT
        b.start_time,
        b.end_time,
        'blocked'::TEXT AS slot_type
    FROM public.court_blocked_times b
    WHERE b.court_id = p_court_id
      AND tstzrange(b.start_time, b.end_time, '[)') && tstzrange(v_day_start, v_day_end, '[)');
END;
$$;

REVOKE ALL ON FUNCTION public.get_court_busy_slots(UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_court_busy_slots(UUID, DATE) TO anon, authenticated;

-- ==============================================================================
-- 12. Update Public Court Status Check to Include Confirmation Preference
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.check_court_booking_status(
    p_court_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_record RECORD;
BEGIN
    SELECT
        c.id AS court_id,
        c.name AS court_name,
        c.sport_type,
        c.hourly_rate,
        c.is_enabled AS court_enabled,
        f.id AS facility_id,
        f.name AS facility_name,
        f.is_active AS facility_active,
        f.timezone,
        f.currency,
        f.open_hour,
        f.close_hour,
        f.booking_confirmation_mode,
        f.hold_duration_minutes
    INTO v_record
    FROM public.courts c
    JOIN public.facilities f ON f.id = c.facility_id
    WHERE c.id = p_court_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'court_id', p_court_id,
            'is_bookable', false,
            'reason', 'Court does not exist'
        );
    END IF;

    IF NOT v_record.facility_active THEN
        RETURN jsonb_build_object(
            'court_id', p_court_id,
            'court_name', v_record.court_name,
            'is_bookable', false,
            'reason', 'Facility is currently inactive'
        );
    END IF;

    IF NOT v_record.court_enabled THEN
        RETURN jsonb_build_object(
            'court_id', p_court_id,
            'court_name', v_record.court_name,
            'is_bookable', false,
            'reason', 'Court is disabled by facility management'
        );
    END IF;

    RETURN jsonb_build_object(
        'court_id', v_record.court_id,
        'court_name', v_record.court_name,
        'sport_type', v_record.sport_type,
        'hourly_rate', v_record.hourly_rate,
        'currency', v_record.currency,
        'facility_id', v_record.facility_id,
        'facility_name', v_record.facility_name,
        'timezone', v_record.timezone,
        'open_hour', v_record.open_hour,
        'close_hour', v_record.close_hour,
        'booking_confirmation_mode', v_record.booking_confirmation_mode,
        'hold_duration_minutes', v_record.hold_duration_minutes,
        'is_bookable', true
    );
END;
$$;

REVOKE ALL ON FUNCTION public.check_court_booking_status(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_court_booking_status(UUID) TO anon, authenticated;

-- ==============================================================================
-- 13. Enhanced create_public_reservation (Backend Service Endpoint Only)
-- ==============================================================================
-- Consistent Lock Order:
--   1. Rejects NULL required booking inputs explicitly.
--   2. Sanitizes strings, validates duration and future date bounds.
--   3. Row-locks target Court (FOR UPDATE) FIRST.
--   4. Cleans up any expired pending holds on this court while holding the court lock.
--   5. Checks operating hours and maintenance blocks on locked court.
--   6. Inserts into reservations (guarded by GIST exclusion constraint).

CREATE OR REPLACE FUNCTION public.create_public_reservation(
    p_facility_id UUID,
    p_court_id UUID,
    p_customer_name TEXT,
    p_customer_phone TEXT,
    p_customer_email TEXT,
    p_booking_date DATE,
    p_start_time TIMESTAMPTZ,
    p_duration_minutes INT DEFAULT 60,
    p_is_demo BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_facility RECORD;
    v_court RECORD;
    v_end_time TIMESTAMPTZ;
    v_local_start TIMESTAMP;
    v_local_end TIMESTAMP;
    v_local_open TIMESTAMP;
    v_local_close TIMESTAMP;
    v_hourly_rate NUMERIC(10, 2);
    v_total_price NUMERIC(10, 2);
    v_reference_code TEXT;
    v_reservation_id UUID;
    v_time_slot_label TEXT;
    v_status TEXT;
    v_hold_expires_at TIMESTAMPTZ := NULL;
BEGIN
    -- 1. Explicit NULL parameter validation
    IF p_facility_id IS NULL OR
       p_court_id IS NULL OR
       p_customer_name IS NULL OR
       p_booking_date IS NULL OR
       p_start_time IS NULL OR
       p_duration_minutes IS NULL THEN
        RAISE EXCEPTION 'Required booking parameters (facility_id, court_id, customer_name, booking_date, start_time, duration_minutes) cannot be NULL.';
    END IF;

    -- 2. Input Sanitization & Length Checks
    IF char_length(trim(p_customer_name)) < 2 OR char_length(trim(p_customer_name)) > 100 THEN
        RAISE EXCEPTION 'Customer name must be between 2 and 100 characters.';
    END IF;

    IF (p_customer_phone IS NULL OR trim(p_customer_phone) = '') AND
       (p_customer_email IS NULL OR trim(p_customer_email) = '') THEN
        RAISE EXCEPTION 'At least one contact method (customer phone or customer email) is required and cannot be NULL.';
    END IF;

    IF p_customer_phone IS NOT NULL AND char_length(trim(p_customer_phone)) > 30 THEN
        RAISE EXCEPTION 'Customer phone number must not exceed 30 characters.';
    END IF;

    IF p_customer_email IS NOT NULL AND p_customer_email != '' THEN
        IF p_customer_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' OR char_length(p_customer_email) > 255 THEN
            RAISE EXCEPTION 'Invalid customer email address format.';
        END IF;
    END IF;

    -- 3. Validate Duration (30 mins to 480 mins, multiple of 30)
    IF p_duration_minutes < 30 OR p_duration_minutes > 480 OR (p_duration_minutes % 30 != 0) THEN
        RAISE EXCEPTION 'Booking duration must be between 30 minutes and 8 hours in 30-minute intervals.';
    END IF;

    -- 4. Reject Past Bookings
    IF p_start_time <= now() THEN
        RAISE EXCEPTION 'Cannot book reservations in the past.';
    END IF;

    v_end_time := p_start_time + (p_duration_minutes || ' minutes')::INTERVAL;

    -- 5. Validate Facility
    SELECT * INTO v_facility
    FROM public.facilities
    WHERE id = p_facility_id AND is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Facility is not active or does not exist.';
    END IF;

    -- 6. Consistent locking hierarchy: Lock Court FIRST (Serializes concurrent bookings)
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

    -- 7. While holding the court lock, clean up any expired pending holds on this court
    UPDATE public.reservations
    SET status = 'expired',
        updated_at = now()
    WHERE court_id = p_court_id
      AND status = 'pending'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= now();

    -- 8. Timezone-Aware Local Date & Operating Hours Validation
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

    -- 9. Check Maintenance Blocks on Locked Court
    IF EXISTS (
        SELECT 1
        FROM public.court_blocked_times
        WHERE court_id = p_court_id
          AND tstzrange(start_time, end_time, '[)') && tstzrange(p_start_time, v_end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'Court is blocked for maintenance or private club event during this time slot.';
    END IF;

    -- 10. Server-Authoritative Price Calculation
    v_hourly_rate := v_court.hourly_rate;
    v_total_price := ROUND((v_hourly_rate * (p_duration_minutes::NUMERIC / 60.0)), 2);

    -- 11. Determine Status & Hold Duration Based on Facility Setting
    IF v_facility.booking_confirmation_mode = 'manual_approval' THEN
        v_status := 'pending';
        v_hold_expires_at := now() + (COALESCE(v_facility.hold_duration_minutes, 30) || ' minutes')::INTERVAL;
    ELSE
        v_status := 'confirmed';
        v_hold_expires_at := NULL;
    END IF;

    -- 12. Generate Reference Code
    v_reference_code := public.generate_booking_ref();
    v_time_slot_label := to_char(v_local_start, 'HH12:MI AM') || ' – ' || to_char(v_local_end, 'HH12:MI AM');

    -- 13. Insert Reservation (Non-volatile exclusion constraint guarantees zero double-booking)
    INSERT INTO public.reservations (
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
        is_demo
    ) VALUES (
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
        v_status,
        v_hold_expires_at,
        p_is_demo
    )
    RETURNING id INTO v_reservation_id;

    RETURN jsonb_build_object(
        'success', true,
        'reservation_id', v_reservation_id,
        'reference_code', v_reference_code,
        'status', v_status,
        'booking_confirmation_mode', v_facility.booking_confirmation_mode,
        'hold_expires_at', v_hold_expires_at,
        'court_name', v_court.name,
        'facility_name', v_facility.name,
        'booking_date', p_booking_date,
        'time_slot_label', v_time_slot_label,
        'total_price', v_total_price,
        'currency', v_facility.currency,
        'is_demo', p_is_demo
    );
EXCEPTION
    WHEN exclusion_violation THEN
        RAISE EXCEPTION 'This court slot is already booked or held for another pending request. Please choose another slot.';
END;
$$;

-- Keep create_public_reservation restricted to service_role (backend edge function only)
REVOKE ALL ON FUNCTION public.create_public_reservation(UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_public_reservation(UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.create_public_reservation(UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_reservation(UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) TO service_role;
