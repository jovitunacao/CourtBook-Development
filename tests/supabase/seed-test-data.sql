-- ==============================================================================
-- CourtBook / BookSuite — Non-Destructive Automated Testing Fixtures Seed Script
-- File: tests/supabase/seed-test-data.sql
--
-- PURPOSE:
--   Non-destructively ensures required fictional test organizations, facilities,
--   courts, and uniquely tagged disposable test reservations exist for BookSuite-Dev.
--
-- GUARANTEES:
--   1. Non-destructive: Never alters, resets, or deletes real customer reservations,
--      membership roles, facilities, or production data.
--   2. Reuses existing slugs:
--      - Organization A: courtbook-test-pickleball-a
--      - Organization B: courtbook-test-badminton-b
--      - Facility A:     courtbook-pickleball-test (Court A at ₱350/hr)
--      - Facility B:     courtbook-badminton-test  (Court B at ₱250/hr)
--   3. Reference code compliance: All reservation reference codes are between
--      5 and 20 characters, strictly satisfying the database CHECK constraint.
--   4. Valid PostgreSQL expressions: Clean date/time arithmetic with no invalid
--      concatenations or type conversions.
--   5. Idempotent & repeatable: Cleans up only previously cancelled disposable
--      test fixtures (TD-CONF-001) to allow repeated test runs.
-- ==============================================================================

DO $$
DECLARE
    v_org_a_id UUID;
    v_org_b_id UUID;
    v_fac_a_id UUID;
    v_fac_b_id UUID;
    v_court_a1_id UUID;
    v_court_b1_id UUID;
    v_future_date DATE;
    v_future_start TIMESTAMPTZ;
    v_future_end TIMESTAMPTZ;
    v_past_date DATE;
    v_past_start TIMESTAMPTZ;
    v_past_end TIMESTAMPTZ;
BEGIN
    -- 1. Ensure Organization A exists (Reuses existing slug)
    INSERT INTO public.organizations (name, slug, is_demo)
    VALUES ('Demo Pickleball Center', 'courtbook-test-pickleball-a', true)
    ON CONFLICT (slug) DO NOTHING;

    SELECT id INTO v_org_a_id
    FROM public.organizations
    WHERE slug = 'courtbook-test-pickleball-a';

    -- 2. Ensure Organization B exists (Reuses existing slug)
    INSERT INTO public.organizations (name, slug, is_demo)
    VALUES ('Demo Badminton Center', 'courtbook-test-badminton-b', true)
    ON CONFLICT (slug) DO NOTHING;

    SELECT id INTO v_org_b_id
    FROM public.organizations
    WHERE slug = 'courtbook-test-badminton-b';

    -- 3. Ensure Facility A exists (courtbook-pickleball-test, ₱350/hr)
    INSERT INTO public.facilities (
        organization_id,
        app_type,
        name,
        slug,
        tagline,
        address,
        timezone,
        currency,
        open_hour,
        close_hour,
        default_hourly_rate,
        is_active,
        is_demo
    ) VALUES (
        v_org_a_id,
        'courtbook',
        'Apex Pickleball Arena',
        'courtbook-pickleball-test',
        'Fictional Test Arena A',
        '100 Test Court Way, Metro Manila',
        'Asia/Manila',
        '₱',
        8,
        22,
        350.00,
        true,
        true
    )
    ON CONFLICT (slug) DO NOTHING;

    SELECT id INTO v_fac_a_id
    FROM public.facilities
    WHERE slug = 'courtbook-pickleball-test';

    -- 4. Ensure Facility B exists (courtbook-badminton-test, ₱250/hr)
    INSERT INTO public.facilities (
        organization_id,
        app_type,
        name,
        slug,
        tagline,
        address,
        timezone,
        currency,
        open_hour,
        close_hour,
        default_hourly_rate,
        is_active,
        is_demo
    ) VALUES (
        v_org_b_id,
        'courtbook',
        'Metro Badminton Club',
        'courtbook-badminton-test',
        'Fictional Test Club B',
        '200 Test Shuttlecock Lane, Quezon City',
        'Asia/Manila',
        '₱',
        7,
        23,
        250.00,
        true,
        true
    )
    ON CONFLICT (slug) DO NOTHING;

    SELECT id INTO v_fac_b_id
    FROM public.facilities
    WHERE slug = 'courtbook-badminton-test';

    -- 5. Ensure Court A exists in Facility A (₱350/hr)
    INSERT INTO public.courts (
        facility_id,
        name,
        sport_type,
        tag,
        hourly_rate,
        is_enabled,
        display_order
    ) VALUES (
        v_fac_a_id,
        'Court A',
        'Pickleball',
        'Indoor Center Court',
        350.00,
        true,
        1
    )
    ON CONFLICT (facility_id, name) DO NOTHING;

    SELECT id INTO v_court_a1_id
    FROM public.courts
    WHERE facility_id = v_fac_a_id AND name = 'Court A';

    -- Ensure a disabled court exists in Facility A for negative testing
    INSERT INTO public.courts (
        facility_id,
        name,
        sport_type,
        tag,
        hourly_rate,
        is_enabled,
        display_order
    ) VALUES (
        v_fac_a_id,
        'Court A - Disabled Maintenance',
        'Pickleball',
        'Under Maintenance',
        350.00,
        false,
        9
    )
    ON CONFLICT (facility_id, name) DO NOTHING;

    -- 6. Ensure Court B exists in Facility B (₱250/hr)
    INSERT INTO public.courts (
        facility_id,
        name,
        sport_type,
        tag,
        hourly_rate,
        is_enabled,
        display_order
    ) VALUES (
        v_fac_b_id,
        'Court B',
        'Badminton',
        'Wood Court',
        250.00,
        true,
        1
    )
    ON CONFLICT (facility_id, name) DO NOTHING;

    SELECT id INTO v_court_b1_id
    FROM public.courts
    WHERE facility_id = v_fac_b_id AND name = 'Court B';

    -- 7. Ensure Valid, Uniquely Tagged Disposable Test Reservations Exist
    -- All reference codes strictly meet the 5-20 characters CHECK constraint:
    -- 'TD-CONF-001' (11 chars)
    -- 'TD-CMPL-001' (11 chars)
    v_future_date  := CURRENT_DATE + 14;
    v_future_start := (v_future_date + TIME '10:00:00') AT TIME ZONE 'Asia/Manila';
    v_future_end   := v_future_start + INTERVAL '60 minutes';

    v_past_date  := CURRENT_DATE - 3;
    v_past_start := (v_past_date + TIME '14:00:00') AT TIME ZONE 'Asia/Manila';
    v_past_end   := v_past_start + INTERVAL '60 minutes';

    IF v_court_a1_id IS NOT NULL THEN
        -- Allow repeated test runs by clearing previously cancelled disposable test fixture
        DELETE FROM public.reservations
        WHERE reference_code = 'TD-CONF-001' AND status = 'cancelled';

        -- Disposable Confirmed Reservation (11 characters)
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
            v_fac_a_id,
            v_court_a1_id,
            'TD-CONF-001',
            'Automated Test Customer (Disposable)',
            '09170000000',
            'disposable-test@booksuite.demo',
            v_future_date,
            v_future_start,
            v_future_end,
            '10:00 AM – 11:00 AM',
            60,
            350.00,
            '₱',
            'confirmed',
            true
        )
        ON CONFLICT (reference_code) DO NOTHING;

        -- Disposable Completed Reservation (11 characters)
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
            v_fac_a_id,
            v_court_a1_id,
            'TD-CMPL-001',
            'Automated Test Customer (Completed)',
            '09170000001',
            'disposable-completed@booksuite.demo',
            v_past_date,
            v_past_start,
            v_past_end,
            '02:00 PM – 03:00 PM',
            60,
            350.00,
            '₱',
            'completed',
            true
        )
        ON CONFLICT (reference_code) DO NOTHING;
    END IF;

    RAISE NOTICE 'Non-destructive test fixtures verified for courtbook-test-pickleball-a and courtbook-test-badminton-b.';
END;
$$;
