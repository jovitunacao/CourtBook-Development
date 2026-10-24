-- ==============================================================================
-- CourtBook / BookSuite — Database Security Migration
-- Migration: 002_secure_reservation_operations.sql
-- Description:
--   1. Explicitly revokes both table-level AND column-level UPDATE privileges
--      on public.reservations from PUBLIC, anon, and authenticated.
--   2. Completely eliminates session settings (no courtbook.authorized_admin_override).
--   3. Enforces consistent row-lock ordering (Reservation -> Court) to avoid deadlocks.
--   4. Provides hardened, narrowly scoped SECURITY DEFINER routines for staff:
--      - cancel_reservation_as_staff(reservation_id, reason):
--        * Rejects NULL parameters
--        * Rejects cancellation of completed or non-confirmed bookings
--      - reschedule_reservation_as_staff(reservation_id, court_id, date, start_time, duration):
--        * Rejects NULL parameters, invalid durations, and past timestamps
--        * Rejects rescheduling of cancelled, completed, or no-show bookings
--        * Preserves facility timezone, operating hours, and maintenance block checks
--        * Preserves exclusion constraint collision prevention
--   5. Hardens membership policies against self-promotion and unauthorized owner grants.
-- ==============================================================================

-- ==============================================================================
-- 1. Explicitly Revoke Table & Column-Level UPDATE Privileges
-- ==============================================================================

-- Drop existing RLS UPDATE policy on reservations
DROP POLICY IF EXISTS "staff_can_update_facility_reservations" ON public.reservations;

-- Revoke table-level direct UPDATE privileges from client roles
REVOKE UPDATE ON public.reservations FROM PUBLIC;
REVOKE UPDATE ON public.reservations FROM anon;
REVOKE UPDATE ON public.reservations FROM authenticated;

-- Explicitly revoke column-level UPDATE privileges previously granted
REVOKE UPDATE (status, cancelled_at, cancelled_by, cancellation_reason) ON public.reservations FROM PUBLIC;
REVOKE UPDATE (status, cancelled_at, cancelled_by, cancellation_reason) ON public.reservations FROM anon;
REVOKE UPDATE (status, cancelled_at, cancelled_by, cancellation_reason) ON public.reservations FROM authenticated;

-- Ensure authenticated staff can only SELECT reservations for their facility under RLS
GRANT SELECT ON public.reservations TO authenticated;

-- ==============================================================================
-- 2. Hardened Membership Immutability & Anti-Escalation
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.validate_membership_modification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Prevent modifying organization_id or user_id
    IF NEW.organization_id != OLD.organization_id OR NEW.user_id != OLD.user_id THEN
        RAISE EXCEPTION 'Cannot modify organization_id or user_id of an existing membership record.';
    END IF;

    -- Prevent self-role modification (users cannot alter or escalate their own role)
    IF auth.uid() = OLD.user_id AND NEW.role != OLD.role THEN
        RAISE EXCEPTION 'Users cannot alter their own membership role.';
    END IF;

    -- Only existing owners can assign, modify, or revoke roles in the organization
    IF NOT public.is_org_member(OLD.organization_id, ARRAY['owner']) THEN
        RAISE EXCEPTION 'Access denied: Only organization owners can modify team membership roles.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_validate_membership_modification ON public.organization_members;
CREATE TRIGGER tr_validate_membership_modification
    BEFORE UPDATE ON public.organization_members
    FOR EACH ROW EXECUTE FUNCTION public.validate_membership_modification();

-- Drop and recreate organization_members policies with anti-self-modification guards
DROP POLICY IF EXISTS "owners_can_insert_teammates" ON public.organization_members;
DROP POLICY IF EXISTS "owners_can_update_teammates" ON public.organization_members;
DROP POLICY IF EXISTS "owners_can_delete_teammates" ON public.organization_members;

CREATE POLICY "owners_can_insert_teammates"
    ON public.organization_members
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.is_org_member(organization_id, ARRAY['owner'])
        AND user_id != auth.uid()
    );

CREATE POLICY "owners_can_update_teammates"
    ON public.organization_members
    FOR UPDATE
    TO authenticated
    USING (
        public.is_org_member(organization_id, ARRAY['owner'])
        AND user_id != auth.uid()
    )
    WITH CHECK (
        public.is_org_member(organization_id, ARRAY['owner'])
        AND user_id != auth.uid()
    );

CREATE POLICY "owners_can_delete_teammates"
    ON public.organization_members
    FOR DELETE
    TO authenticated
    USING (
        public.is_org_member(organization_id, ARRAY['owner'])
        AND user_id != auth.uid()
    );

-- ==============================================================================
-- 3. Trigger: Restrict Reservation Modifications (No Session Settings)
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

    IF OLD.status = 'completed' AND NEW.status != 'completed' THEN
        RAISE EXCEPTION 'Cannot alter the status of a completed reservation.';
    END IF;

    IF NEW.status NOT IN ('confirmed', 'cancelled', 'completed', 'no_show') THEN
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
-- 4. Hardened Staff Reservation Cancellation Procedure
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.cancel_reservation_as_staff(
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

    -- 3. Consistent row lock order: Lock Reservation record first
    SELECT * INTO v_res
    FROM public.reservations
    WHERE id = p_reservation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reservation not found.';
    END IF;

    -- 4. Verify facility membership (owner, admin, or staff)
    IF NOT public.is_facility_staff(v_res.facility_id, ARRAY['owner', 'admin', 'staff']) THEN
        RAISE EXCEPTION 'Access denied: You do not have staff permissions for this facility.';
    END IF;

    -- 5. Terminal state validations
    IF v_res.status = 'cancelled' THEN
        RAISE EXCEPTION 'This reservation is already cancelled.';
    END IF;

    IF v_res.status = 'completed' THEN
        RAISE EXCEPTION 'Completed reservations cannot be cancelled.';
    END IF;

    IF v_res.status != 'confirmed' THEN
        RAISE EXCEPTION 'Cannot cancel reservation with status: %.', v_res.status;
    END IF;

    -- 6. Perform validated cancellation update
    UPDATE public.reservations
    SET status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = v_caller_id,
        cancellation_reason = NULLIF(trim(p_reason), ''),
        updated_at = now()
    WHERE id = p_reservation_id;

    RETURN jsonb_build_object(
        'success', true,
        'reservation_id', p_reservation_id,
        'reference_code', v_res.reference_code,
        'status', 'cancelled'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_reservation_as_staff(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_reservation_as_staff(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_reservation_as_staff(UUID, TEXT) TO authenticated;

-- ==============================================================================
-- 5. Hardened Staff Reservation Rescheduling Procedure
-- ==============================================================================

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
    -- 1. Parameter Validation (Reject NULL and invalid values)
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

    -- 5. Consistent row-lock order: Step 1 - Lock Reservation record
    SELECT * INTO v_res
    FROM public.reservations
    WHERE id = p_reservation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reservation not found.';
    END IF;

    -- 6. Permission check: Facility owner or admin only
    IF NOT public.is_facility_staff(v_res.facility_id, ARRAY['owner', 'admin']) THEN
        RAISE EXCEPTION 'Access denied: Only facility owners and admins can reschedule bookings.';
    END IF;

    -- 7. Reject rescheduling of cancelled, completed, or no-show bookings
    IF v_res.status IN ('cancelled', 'completed', 'no_show') THEN
        RAISE EXCEPTION 'Cannot reschedule a reservation that is %.', v_res.status;
    END IF;

    IF v_res.status != 'confirmed' THEN
        RAISE EXCEPTION 'Only active confirmed reservations can be rescheduled.';
    END IF;

    -- 8. Consistent row-lock order: Step 2 - Lock target Court record
    SELECT * INTO v_court
    FROM public.courts
    WHERE id = p_new_court_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target court does not exist.';
    END IF;

    -- 9. Verify target court belongs to the same facility
    IF v_court.facility_id != v_res.facility_id THEN
        RAISE EXCEPTION 'Target court belongs to a different facility.';
    END IF;

    -- 10. Verify target court is enabled
    IF NOT v_court.is_enabled THEN
        RAISE EXCEPTION 'Target court is currently disabled by facility management.';
    END IF;

    -- 11. Load facility configuration
    SELECT * INTO v_facility
    FROM public.facilities
    WHERE id = v_res.facility_id AND is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Facility is not active or does not exist.';
    END IF;

    -- 12. Timezone-aware local date verification
    v_local_start := p_new_start_time AT TIME ZONE v_facility.timezone;
    v_local_end   := v_end_time AT TIME ZONE v_facility.timezone;

    IF v_local_start::date != p_new_date THEN
        RAISE EXCEPTION 'Booking date (%) does not match local facility start date (%).',
            p_new_date, v_local_start::date;
    END IF;

    -- 13. Operating hours verification
    v_local_open  := date_trunc('day', v_local_start) + (v_facility.open_hour || ' hours')::INTERVAL;
    v_local_close := date_trunc('day', v_local_start) + (v_facility.close_hour || ' hours')::INTERVAL;

    IF v_local_start < v_local_open OR v_local_end > v_local_close THEN
        RAISE EXCEPTION 'Rescheduled time falls outside facility operating hours (%:00 – %:00 %)',
            v_facility.open_hour, v_facility.close_hour, v_facility.timezone;
    END IF;

    -- 14. Court maintenance blocks verification
    IF EXISTS (
        SELECT 1
        FROM public.court_blocked_times
        WHERE court_id = p_new_court_id
          AND tstzrange(start_time, end_time, '[)') && tstzrange(p_new_start_time, v_end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'Target court is blocked for maintenance or private club event during this period.';
    END IF;

    -- 15. Server-authoritative price & label calculation
    v_hourly_rate := v_court.hourly_rate;
    v_total_price := ROUND((v_hourly_rate * (p_new_duration_minutes::NUMERIC / 60.0)), 2);
    v_time_slot_label := to_char(v_local_start, 'HH12:MI AM') || ' – ' || to_char(v_local_end, 'HH12:MI AM');

    -- 16. Apply update (Exclusion constraint prevent_court_overlapping_active_reservations
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
