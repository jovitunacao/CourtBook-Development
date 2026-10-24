-- ==============================================================================
-- CourtBook / BookSuite — Database Schema Migration
-- Migration: 001_initial_schema.sql
-- Description: Production-grade multi-tenant court reservation schema with:
--   - PostgreSQL btree_gist exclusion constraints for overlap prevention
--   - Strict database-enforced integrity (composite foreign keys)
--   - Hardened Row Level Security (RLS) isolating tenant records
--   - Explicit grants configured for Supabase environments with
--     "Automatically expose new tables" disabled
--   - Immutable membership records and last-owner deletion protection
--   - Column-level privileges & trigger enforcement on reservation updates
--     (unconditionally blocking direct changes to prices, customer data, courts, or dates)
--   - Explicitly authorized, narrowly scoped server-side routines for sensitive changes
--   - Accurate IANA timezone date boundary evaluation (no 24-hour assumptions)
--   - Unambiguous court availability checks that reject disabled/nonexistent courts
--   - Public booking creation restricted strictly to backend service endpoints
-- ==============================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ==============================================================================
-- 2. Organizations & Multi-Tenant Tenancy (BookSuite Foundation)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
    slug TEXT NOT NULL UNIQUE CHECK (slug ~* '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 2 AND 60),
    billing_email TEXT CHECK (billing_email IS NULL OR billing_email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    is_demo BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.organizations IS 'Tenant organizations operating sports facilities across BookSuite.';

CREATE TABLE IF NOT EXISTS public.organization_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_org_member UNIQUE (organization_id, user_id)
);

COMMENT ON TABLE public.organization_members IS 'Authorized staff and owners mapped to organizations with role-based access.';

CREATE INDEX IF NOT EXISTS idx_org_members_user_org ON public.organization_members (user_id, organization_id, role);

-- Helper functions for RLS checks (SECURITY DEFINER with fixed search_path)
CREATE OR REPLACE FUNCTION public.is_org_member(p_org_id UUID, p_roles TEXT[] DEFAULT ARRAY['owner', 'admin', 'staff'])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_members
        WHERE organization_id = p_org_id
          AND user_id = auth.uid()
          AND role = ANY(p_roles)
    );
$$;

REVOKE ALL ON FUNCTION public.is_org_member(UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_org_member(UUID, TEXT[]) TO authenticated;

-- Prevent membership immutability breach and self-role escalation
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

    -- Prevent self-role modification (cannot promote/demote oneself)
    IF auth.uid() = OLD.user_id AND NEW.role != OLD.role THEN
        RAISE EXCEPTION 'Users cannot alter their own membership role.';
    END IF;

    -- Only existing owners can assign or revoke the owner role
    IF (NEW.role = 'owner' OR OLD.role = 'owner') AND NOT public.is_org_member(OLD.organization_id, ARRAY['owner']) THEN
        RAISE EXCEPTION 'Only an organization owner can grant or revoke owner status.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_validate_membership_modification ON public.organization_members;
CREATE TRIGGER tr_validate_membership_modification
    BEFORE UPDATE ON public.organization_members
    FOR EACH ROW EXECUTE FUNCTION public.validate_membership_modification();

-- Concurrency-safe last-owner protection (row-locks organization to serialize checks)
CREATE OR REPLACE FUNCTION public.protect_last_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner_count INT;
BEGIN
    IF (TG_OP = 'DELETE' AND OLD.role = 'owner') OR
       (TG_OP = 'UPDATE' AND OLD.role = 'owner' AND NEW.role != 'owner') THEN
        
        -- Row-lock organization to serialize concurrent membership modifications
        PERFORM 1 FROM public.organizations WHERE id = OLD.organization_id FOR UPDATE;

        SELECT COUNT(*) INTO v_owner_count
        FROM public.organization_members
        WHERE organization_id = OLD.organization_id
          AND role = 'owner'
          AND id != OLD.id;

        IF v_owner_count = 0 THEN
            RAISE EXCEPTION 'Cannot remove or demote the last owner of an organization.';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

DROP TRIGGER IF EXISTS tr_protect_last_owner ON public.organization_members;
CREATE TRIGGER tr_protect_last_owner
    BEFORE UPDATE OR DELETE ON public.organization_members
    FOR EACH ROW EXECUTE FUNCTION public.protect_last_owner();

-- Secure function for creating a new organization and assigning initial owner
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
    p_name TEXT,
    p_slug TEXT,
    p_billing_email TEXT DEFAULT NULL,
    p_is_demo BOOLEAN DEFAULT false
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID;
    v_new_org_id UUID;
    v_clean_slug TEXT;
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required: User must be signed in to create an organization.';
    END IF;

    IF char_length(trim(p_name)) < 2 OR char_length(trim(p_name)) > 120 THEN
        RAISE EXCEPTION 'Organization name must be between 2 and 120 characters.';
    END IF;

    v_clean_slug := lower(trim(p_slug));
    IF v_clean_slug !~* '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(v_clean_slug) < 2 OR char_length(v_clean_slug) > 60 THEN
        RAISE EXCEPTION 'Slug must contain only lowercase letters, numbers, and hyphens (2-60 characters).';
    END IF;

    IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = v_clean_slug) THEN
        RAISE EXCEPTION 'An organization with slug "%" already exists. Please choose a different slug.', v_clean_slug;
    END IF;

    INSERT INTO public.organizations (name, slug, billing_email, is_demo)
    VALUES (trim(p_name), v_clean_slug, NULLIF(trim(p_billing_email), ''), p_is_demo)
    RETURNING id INTO v_new_org_id;

    INSERT INTO public.organization_members (organization_id, user_id, role)
    VALUES (v_new_org_id, v_caller_id, 'owner');

    RETURN v_new_org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_organization_with_owner(TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_organization_with_owner(TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;

-- ==============================================================================
-- 3. Facilities (Sports Clubs & Athletic Venues)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.facilities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    app_type TEXT NOT NULL DEFAULT 'courtbook' CHECK (app_type IN ('courtbook', 'fitbook', 'salonbook', 'clinicqueue')),
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
    slug TEXT NOT NULL UNIQUE CHECK (slug ~* '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 2 AND 60),
    tagline TEXT CHECK (tagline IS NULL OR char_length(tagline) <= 250),
    address TEXT CHECK (address IS NULL OR char_length(address) <= 300),
    timezone TEXT NOT NULL DEFAULT 'Asia/Manila',
    currency TEXT NOT NULL DEFAULT '₱' CHECK (char_length(currency) BETWEEN 1 AND 5),
    open_hour INT NOT NULL DEFAULT 8 CHECK (open_hour >= 0 AND open_hour <= 23),
    close_hour INT NOT NULL DEFAULT 22 CHECK (close_hour >= 1 AND close_hour <= 24 AND close_hour > open_hour),
    default_hourly_rate NUMERIC(10, 2) NOT NULL DEFAULT 350.00 CHECK (default_hourly_rate > 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.facilities IS 'Sports facilities with configurable operating hours and default rates.';

CREATE INDEX IF NOT EXISTS idx_facilities_org_id ON public.facilities (organization_id);

CREATE OR REPLACE FUNCTION public.is_facility_staff(p_facility_id UUID, p_roles TEXT[] DEFAULT ARRAY['owner', 'admin', 'staff'])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.facilities f
        JOIN public.organization_members om ON om.organization_id = f.organization_id
        WHERE f.id = p_facility_id
          AND om.user_id = auth.uid()
          AND om.role = ANY(p_roles)
    );
$$;

REVOKE ALL ON FUNCTION public.is_facility_staff(UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_facility_staff(UUID, TEXT[]) TO authenticated;

-- Prevent changing an existing facility's organization_id (no cross-tenant transfer)
CREATE OR REPLACE FUNCTION public.prevent_facility_org_transfer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.organization_id != OLD.organization_id THEN
        RAISE EXCEPTION 'Transferring a facility to a different organization is not permitted.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_prevent_facility_org_transfer ON public.facilities;
CREATE TRIGGER tr_prevent_facility_org_transfer
    BEFORE UPDATE ON public.facilities
    FOR EACH ROW EXECUTE FUNCTION public.prevent_facility_org_transfer();

-- ==============================================================================
-- 4. Courts & Pricing
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.courts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
    sport_type TEXT NOT NULL DEFAULT 'Pickleball' CHECK (char_length(trim(sport_type)) BETWEEN 2 AND 50),
    tag TEXT CHECK (tag IS NULL OR char_length(tag) <= 50),
    surface_type TEXT CHECK (surface_type IS NULL OR char_length(surface_type) <= 100),
    description TEXT CHECK (description IS NULL OR char_length(description) <= 600),
    hourly_rate NUMERIC(10, 2) NOT NULL DEFAULT 350.00 CHECK (hourly_rate > 0),
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_court_name_per_facility UNIQUE (facility_id, name),
    CONSTRAINT uq_court_id_facility_id UNIQUE (id, facility_id)
);

COMMENT ON TABLE public.courts IS 'Sports courts configured per facility with custom sport types and hourly rates.';

CREATE INDEX IF NOT EXISTS idx_courts_facility_enabled ON public.courts (facility_id, is_enabled);

-- Prevent changing court's facility_id via UPDATE (no cross-facility transfer)
CREATE OR REPLACE FUNCTION public.prevent_court_facility_transfer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.facility_id != OLD.facility_id THEN
        RAISE EXCEPTION 'Moving a court to a different facility is not permitted.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_prevent_court_facility_transfer ON public.courts;
CREATE TRIGGER tr_prevent_court_facility_transfer
    BEFORE UPDATE ON public.courts
    FOR EACH ROW EXECUTE FUNCTION public.prevent_court_facility_transfer();

-- ==============================================================================
-- 5. Blocked Schedules & Maintenance
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.court_blocked_times (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL,
    court_id UUID NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 2 AND 200),
    blocked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_blocked_time_order CHECK (end_time > start_time),
    CONSTRAINT fk_blocked_court_facility FOREIGN KEY (court_id, facility_id)
        REFERENCES public.courts(id, facility_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.court_blocked_times IS 'Periods when a court is blocked for maintenance, tournaments, or coach training.';

ALTER TABLE public.court_blocked_times
ADD CONSTRAINT prevent_overlapping_court_blocks
EXCLUDE USING gist (
    court_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
);

CREATE INDEX IF NOT EXISTS idx_court_blocks_range ON public.court_blocked_times (court_id, start_time, end_time);

-- Prevent changing blocked period's court or facility via UPDATE
CREATE OR REPLACE FUNCTION public.prevent_blocked_court_transfer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.facility_id != OLD.facility_id OR NEW.court_id != OLD.court_id THEN
        RAISE EXCEPTION 'Transferring a blocked schedule between courts or facilities is not permitted.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_prevent_blocked_court_transfer ON public.court_blocked_times;
CREATE TRIGGER tr_prevent_blocked_court_transfer
    BEFORE UPDATE ON public.court_blocked_times
    FOR EACH ROW EXECUTE FUNCTION public.prevent_blocked_court_transfer();

-- Prevent maintenance blocks from colliding with existing confirmed reservations
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
          AND status = 'confirmed'
          AND tstzrange(start_time, end_time, '[)') && tstzrange(NEW.start_time, NEW.end_time, '[)')
    ) THEN
        RAISE EXCEPTION 'Cannot block court: A confirmed customer reservation already exists during this period.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_validate_block_against_reservations ON public.court_blocked_times;
CREATE TRIGGER tr_validate_block_against_reservations
    BEFORE INSERT OR UPDATE ON public.court_blocked_times
    FOR EACH ROW EXECUTE FUNCTION public.validate_block_against_reservations();

-- ==============================================================================
-- 6. Customer Reservations
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL,
    court_id UUID NOT NULL,
    reference_code TEXT NOT NULL UNIQUE CHECK (char_length(reference_code) BETWEEN 5 AND 20),
    customer_name TEXT NOT NULL CHECK (char_length(trim(customer_name)) BETWEEN 2 AND 100),
    customer_phone TEXT CHECK (customer_phone IS NULL OR char_length(trim(customer_phone)) <= 30),
    customer_email TEXT CHECK (customer_email IS NULL OR customer_email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    booking_date DATE NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    time_slot_label TEXT NOT NULL CHECK (char_length(time_slot_label) <= 80),
    duration_minutes INT NOT NULL DEFAULT 60 CHECK (duration_minutes >= 30 AND duration_minutes <= 480),
    price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    currency TEXT NOT NULL DEFAULT '₱' CHECK (char_length(currency) BETWEEN 1 AND 5),
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
    is_demo BOOLEAN NOT NULL DEFAULT false,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) <= 300),
    cancelled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_reservation_time_order CHECK (end_time > start_time),
    CONSTRAINT fk_reservation_court_facility FOREIGN KEY (court_id, facility_id)
        REFERENCES public.courts(id, facility_id) ON DELETE RESTRICT
);

COMMENT ON TABLE public.reservations IS 'Customer court bookings with status tracking and collision prevention.';

-- Prevent overlapping ACTIVE reservations on the same court
ALTER TABLE public.reservations
ADD CONSTRAINT prevent_court_overlapping_active_reservations
EXCLUDE USING gist (
    court_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
)
WHERE (status = 'confirmed');

CREATE INDEX IF NOT EXISTS idx_reservations_facility_date ON public.reservations (facility_id, booking_date);
CREATE INDEX IF NOT EXISTS idx_reservations_court_times ON public.reservations (court_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_reservations_reference_code ON public.reservations (reference_code);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON public.reservations (status);
CREATE INDEX IF NOT EXISTS idx_reservations_is_demo ON public.reservations (is_demo);

-- Strict update restrictions on reservations:
-- Removes unsafe current_user / session_user role checks.
-- Unconditionally prevents direct updates to immutable fields (price, customer, court, schedule, facility).
-- Allows ordinary staff to update status / cancellation metadata directly, or use dedicated server routines.
CREATE OR REPLACE FUNCTION public.restrict_reservation_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_is_authorized_admin_override BOOLEAN;
BEGIN
    -- Check if an explicitly authorized backend procedure enabled the local session override
    v_is_authorized_admin_override := (current_setting('courtbook.authorized_admin_override', true) = 'true');

    IF NOT v_is_authorized_admin_override THEN
        -- Immutable fields cannot be modified via direct client updates:
        IF NEW.facility_id != OLD.facility_id OR
           NEW.court_id != OLD.court_id OR
           NEW.price != OLD.price OR
           NEW.currency != OLD.currency OR
           NEW.duration_minutes != OLD.duration_minutes OR
           NEW.booking_date != OLD.booking_date OR
           NEW.start_time != OLD.start_time OR
           NEW.end_time != OLD.end_time OR
           NEW.reference_code != OLD.reference_code OR
           NEW.customer_name != OLD.customer_name OR
           NEW.customer_phone IS DISTINCT FROM OLD.customer_phone OR
           NEW.customer_email IS DISTINCT FROM OLD.customer_email OR
           NEW.created_at != OLD.created_at OR
           NEW.is_demo != OLD.is_demo THEN

            RAISE EXCEPTION 'Direct modification of pricing, schedule, court, facility, or customer fields on reservations is not permitted. Only status and cancellation metadata may be modified directly.';
        END IF;

        -- Validated status transitions:
        IF OLD.status = 'cancelled' AND NEW.status != 'cancelled' THEN
            RAISE EXCEPTION 'Cannot re-activate a cancelled reservation directly.';
        END IF;

        IF NEW.status NOT IN ('confirmed', 'cancelled', 'completed', 'no_show') THEN
            RAISE EXCEPTION 'Invalid reservation status transition.';
        END IF;
    END IF;

    -- Automatically stamp cancelled_at and cancelled_by when transitioning to cancelled
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

-- Validated staff reservation cancellation procedure
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
    v_res RECORD;
BEGIN
    SELECT * INTO v_res
    FROM public.reservations
    WHERE id = p_reservation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reservation not found.';
    END IF;

    IF NOT public.is_facility_staff(v_res.facility_id, ARRAY['owner', 'admin', 'staff']) THEN
        RAISE EXCEPTION 'Access denied: You do not have staff permissions for this facility.';
    END IF;

    IF v_res.status = 'cancelled' THEN
        RAISE EXCEPTION 'This reservation is already cancelled.';
    END IF;

    UPDATE public.reservations
    SET status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = auth.uid(),
        cancellation_reason = NULLIF(trim(p_reason), '')
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
GRANT EXECUTE ON FUNCTION public.cancel_reservation_as_staff(UUID, TEXT) TO authenticated;

-- Validated server-side routine for sensitive booking rescheduling (authorized owners/admins only)
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
    SELECT * INTO v_res FROM public.reservations WHERE id = p_reservation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reservation not found.';
    END IF;

    -- Verify caller is an authorized owner or admin of the facility
    IF NOT public.is_facility_staff(v_res.facility_id, ARRAY['owner', 'admin']) THEN
        RAISE EXCEPTION 'Access denied: Only facility owners and admins can reschedule bookings.';
    END IF;

    IF v_res.status = 'cancelled' THEN
        RAISE EXCEPTION 'Cannot reschedule a cancelled reservation.';
    END IF;

    -- Validate target court belongs to the same facility
    SELECT * INTO v_court FROM public.courts WHERE id = p_new_court_id AND facility_id = v_res.facility_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target court does not belong to this facility.';
    END IF;

    IF NOT v_court.is_enabled THEN
        RAISE EXCEPTION 'Target court is disabled.';
    END IF;

    SELECT * INTO v_facility FROM public.facilities WHERE id = v_res.facility_id;

    -- Validate new times against operating hours in facility timezone
    v_end_time := p_new_start_time + (p_new_duration_minutes || ' minutes')::INTERVAL;
    v_local_start := p_new_start_time AT TIME ZONE v_facility.timezone;
    v_local_end := v_end_time AT TIME ZONE v_facility.timezone;

    IF v_local_start::date != p_new_date THEN
        RAISE EXCEPTION 'Booking date (%) does not match local start date (%).', p_new_date, v_local_start::date;
    END IF;

    v_local_open := date_trunc('day', v_local_start) + (v_facility.open_hour || ' hours')::INTERVAL;
    v_local_close := date_trunc('day', v_local_start) + (v_facility.close_hour || ' hours')::INTERVAL;

    IF v_local_start < v_local_open OR v_local_end > v_local_close THEN
        RAISE EXCEPTION 'Rescheduled time falls outside facility operating hours.';
    END IF;

    -- Row lock target court
    PERFORM 1 FROM public.courts WHERE id = p_new_court_id FOR UPDATE;

    -- Recalculate price server-side
    v_hourly_rate := v_court.hourly_rate;
    v_total_price := ROUND((v_hourly_rate * (p_new_duration_minutes::NUMERIC / 60.0)), 2);
    v_time_slot_label := to_char(v_local_start, 'HH12:MI AM') || ' – ' || to_char(v_local_end, 'HH12:MI AM');

    -- Enable local administrative override for this transaction only
    PERFORM set_config('courtbook.authorized_admin_override', 'true', true);

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
        'court_name', v_court.name,
        'booking_date', p_new_date,
        'time_slot_label', v_time_slot_label,
        'total_price', v_total_price
    );
EXCEPTION
    WHEN exclusion_violation THEN
        RAISE EXCEPTION 'The selected court slot is already booked for that time.';
END;
$$;

REVOKE ALL ON FUNCTION public.reschedule_reservation_as_staff(UUID, UUID, DATE, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reschedule_reservation_as_staff(UUID, UUID, DATE, TIMESTAMPTZ, INT) TO authenticated;

-- ==============================================================================
-- 7. Automated Timestamps Trigger
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_organizations_updated_at ON public.organizations;
CREATE TRIGGER tr_organizations_updated_at
    BEFORE UPDATE ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS tr_facilities_updated_at ON public.facilities;
CREATE TRIGGER tr_facilities_updated_at
    BEFORE UPDATE ON public.facilities
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS tr_courts_updated_at ON public.courts;
CREATE TRIGGER tr_courts_updated_at
    BEFORE UPDATE ON public.courts
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS tr_court_blocked_times_updated_at ON public.court_blocked_times;
CREATE TRIGGER tr_court_blocked_times_updated_at
    BEFORE UPDATE ON public.court_blocked_times
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS tr_reservations_updated_at ON public.reservations;
CREATE TRIGGER tr_reservations_updated_at
    BEFORE UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ==============================================================================
-- 8. Row Level Security (RLS) Policies
-- ==============================================================================

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.court_blocked_times ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

-- 8.1 Organizations RLS
CREATE POLICY "org_members_can_view_organization"
    ON public.organizations
    FOR SELECT
    TO authenticated
    USING (public.is_org_member(id));

CREATE POLICY "org_owners_can_update_organization"
    ON public.organizations
    FOR UPDATE
    TO authenticated
    USING (public.is_org_member(id, ARRAY['owner']))
    WITH CHECK (public.is_org_member(id, ARRAY['owner']));

-- 8.2 Organization Members RLS
CREATE POLICY "members_can_view_teammates"
    ON public.organization_members
    FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id));

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
    USING (public.is_org_member(organization_id, ARRAY['owner']))
    WITH CHECK (public.is_org_member(organization_id, ARRAY['owner']));

CREATE POLICY "owners_can_delete_teammates"
    ON public.organization_members
    FOR DELETE
    TO authenticated
    USING (public.is_org_member(organization_id, ARRAY['owner']));

-- 8.3 Facilities RLS
CREATE POLICY "public_can_view_active_facilities"
    ON public.facilities
    FOR SELECT
    TO anon, authenticated
    USING (is_active = true);

CREATE POLICY "staff_can_view_their_facilities"
    ON public.facilities
    FOR SELECT
    TO authenticated
    USING (public.is_facility_staff(id));

CREATE POLICY "facility_admins_can_update_facility"
    ON public.facilities
    FOR UPDATE
    TO authenticated
    USING (public.is_facility_staff(id, ARRAY['owner', 'admin']))
    WITH CHECK (public.is_facility_staff(id, ARRAY['owner', 'admin']));

CREATE POLICY "owners_can_insert_facilities"
    ON public.facilities
    FOR INSERT
    TO authenticated
    WITH CHECK (public.is_org_member(organization_id, ARRAY['owner']));

CREATE POLICY "owners_can_delete_facilities"
    ON public.facilities
    FOR DELETE
    TO authenticated
    USING (public.is_org_member(organization_id, ARRAY['owner']));

-- 8.4 Courts RLS
CREATE POLICY "public_can_view_enabled_courts"
    ON public.courts
    FOR SELECT
    TO anon, authenticated
    USING (
        is_enabled = true AND EXISTS (
            SELECT 1 FROM public.facilities f
            WHERE f.id = courts.facility_id AND f.is_active = true
        )
    );

CREATE POLICY "staff_can_view_all_facility_courts"
    ON public.courts
    FOR SELECT
    TO authenticated
    USING (public.is_facility_staff(facility_id));

CREATE POLICY "staff_can_manage_facility_courts"
    ON public.courts
    FOR ALL
    TO authenticated
    USING (public.is_facility_staff(facility_id, ARRAY['owner', 'admin']))
    WITH CHECK (public.is_facility_staff(facility_id, ARRAY['owner', 'admin']));

-- 8.5 Court Blocked Times RLS
CREATE POLICY "staff_can_view_blocked_times"
    ON public.court_blocked_times
    FOR SELECT
    TO authenticated
    USING (public.is_facility_staff(facility_id));

CREATE POLICY "staff_can_manage_blocked_times"
    ON public.court_blocked_times
    FOR ALL
    TO authenticated
    USING (public.is_facility_staff(facility_id, ARRAY['owner', 'admin', 'staff']))
    WITH CHECK (public.is_facility_staff(facility_id, ARRAY['owner', 'admin', 'staff']));

-- 8.6 Reservations RLS
CREATE POLICY "staff_can_view_facility_reservations"
    ON public.reservations
    FOR SELECT
    TO authenticated
    USING (public.is_facility_staff(facility_id));

CREATE POLICY "staff_can_update_facility_reservations"
    ON public.reservations
    FOR UPDATE
    TO authenticated
    USING (public.is_facility_staff(facility_id, ARRAY['owner', 'admin', 'staff']))
    WITH CHECK (public.is_facility_staff(facility_id, ARRAY['owner', 'admin', 'staff']));

-- Direct public INSERT is NOT permitted on reservations.

-- ==============================================================================
-- 9. Explicit Schema & Table Grants for Supabase Environments
-- (Works with "Automatically expose new tables" disabled in project settings)
-- ==============================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Public read grants on safe tables
GRANT SELECT ON public.facilities TO anon, authenticated;
GRANT SELECT ON public.courts TO anon, authenticated;

-- Authenticated staff grants
GRANT SELECT, UPDATE ON public.organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_members TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.facilities TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.courts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.court_blocked_times TO authenticated;

-- Column-level update restriction: staff can only update status & cancellation fields directly
GRANT SELECT ON public.reservations TO authenticated;
GRANT UPDATE (status, cancellation_reason, cancelled_at, cancelled_by) ON public.reservations TO authenticated;

-- Full service_role backend access
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;

-- ==============================================================================
-- 10. Internal Helper: Reference Code Generation
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.generate_booking_ref()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ref TEXT;
    v_attempts INT := 0;
BEGIN
    LOOP
        v_attempts := v_attempts + 1;
        v_ref := 'CB-' || lpad((floor(random() * 90000) + 10000)::int::text, 5, '0');

        IF NOT EXISTS (SELECT 1 FROM public.reservations WHERE reference_code = v_ref) THEN
            RETURN v_ref;
        END IF;

        IF v_attempts > 10 THEN
            RETURN 'CB-' || to_char(clock_timestamp(), 'MMDD-') || lpad((floor(random() * 9000) + 1000)::int::text, 4, '0');
        END IF;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_booking_ref() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_booking_ref() FROM anon;
REVOKE ALL ON FUNCTION public.generate_booking_ref() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_booking_ref() TO service_role;

-- ==============================================================================
-- 11. Protected Reservation Creation (Backend Service Endpoint Only)
-- ==============================================================================

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
BEGIN
    -- 1. Input Sanitization & Length Checks
    IF char_length(trim(p_customer_name)) < 2 OR char_length(trim(p_customer_name)) > 100 THEN
        RAISE EXCEPTION 'Customer name must be between 2 and 100 characters.';
    END IF;

    IF p_customer_phone IS NOT NULL AND char_length(trim(p_customer_phone)) > 30 THEN
        RAISE EXCEPTION 'Customer phone number must not exceed 30 characters.';
    END IF;

    IF p_customer_email IS NOT NULL AND p_customer_email != '' THEN
        IF p_customer_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' OR char_length(p_customer_email) > 255 THEN
            RAISE EXCEPTION 'Invalid customer email address format.';
        END IF;
    END IF;

    -- 2. Validate Duration (30 mins to 480 mins, multiple of 30)
    IF p_duration_minutes < 30 OR p_duration_minutes > 480 OR (p_duration_minutes % 30 != 0) THEN
        RAISE EXCEPTION 'Booking duration must be between 30 minutes and 8 hours in 30-minute intervals.';
    END IF;

    -- 3. Reject Past Bookings
    IF p_start_time <= now() THEN
        RAISE EXCEPTION 'Cannot book reservations in the past.';
    END IF;

    v_end_time := p_start_time + (p_duration_minutes || ' minutes')::INTERVAL;

    -- 4. Validate Facility
    SELECT * INTO v_facility
    FROM public.facilities
    WHERE id = p_facility_id AND is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Facility is not active or does not exist.';
    END IF;

    -- 5. Row-Lock Court (Serializes concurrent booking & maintenance scheduling)
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

    -- 6. Timezone-Aware Local Date & Operating Hours Validation
    v_local_start := p_start_time AT TIME ZONE v_facility.timezone;
    v_local_end   := v_end_time AT TIME ZONE v_facility.timezone;

    -- Reject Date Mismatch: booking_date must match the facility's local calendar day
    IF v_local_start::date != p_booking_date THEN
        RAISE EXCEPTION 'Booking date (%) does not match the facility local start date (%).',
            p_booking_date, v_local_start::date;
    END IF;

    -- Calculate opening and closing boundaries in facility local time
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

    -- 8. Server-Authoritative Price Calculation (Anti-Tampering)
    v_hourly_rate := v_court.hourly_rate;
    v_total_price := ROUND((v_hourly_rate * (p_duration_minutes::NUMERIC / 60.0)), 2);

    -- 9. Reference Code Generation
    v_reference_code := public.generate_booking_ref();

    -- Human-friendly slot label
    v_time_slot_label := to_char(v_local_start, 'HH12:MI AM') || ' – ' || to_char(v_local_end, 'HH12:MI AM');

    -- 10. Insert Reservation (Database exclusion constraint ensures zero double-booking)
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
        'confirmed',
        p_is_demo
    )
    RETURNING id INTO v_reservation_id;

    RETURN jsonb_build_object(
        'success', true,
        'reservation_id', v_reservation_id,
        'reference_code', v_reference_code,
        'court_name', v_court.name,
        'facility_name', v_facility.name,
        'booking_date', p_booking_date,
        'time_slot_label', v_time_slot_label,
        'total_price', v_total_price,
        'currency', v_facility.currency,
        'status', 'confirmed',
        'is_demo', p_is_demo
    );
EXCEPTION
    WHEN exclusion_violation THEN
        RAISE EXCEPTION 'This court slot is already booked for the selected time. Please choose another slot.';
END;
$$;

-- Must be invoked only via backend service / edge functions using service_role key
REVOKE ALL ON FUNCTION public.create_public_reservation(UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_public_reservation(UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.create_public_reservation(UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_reservation(UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) TO service_role;

-- ==============================================================================
-- 12. Public Court Availability & Explicit Status Verification
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
        f.close_hour
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
        'is_bookable', true
    );
END;
$$;

REVOKE ALL ON FUNCTION public.check_court_booking_status(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_court_booking_status(UUID) TO anon, authenticated;

-- Returns busy intervals for public slot selection using the facility's local IANA timezone.
-- Explicitly calculates day boundaries independently (no 24h assumptions for DST transitions).
-- Rejects nonexistent, disabled, or inactive courts with an informative exception to prevent misinterpreting 0 rows as an open day.
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
    SELECT
        r.start_time,
        r.end_time,
        'reserved'::TEXT AS slot_type
    FROM public.reservations r
    WHERE r.court_id = p_court_id
      AND r.status = 'confirmed'
      AND tstzrange(r.start_time, r.end_time, '[)') && tstzrange(v_day_start, v_day_end, '[)')

    UNION ALL

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
