-- ==============================================================================
-- Migration 004: Abuse Prevention, Durable Rate Limiting & Atomic Idempotency
-- CourtBook / BookSuite
--
-- RATIONALE & ARCHITECTURE:
--   1. Stateless Serverless Edge Functions: Supabase Edge Functions run globally
--      across distributed Deno isolates and regional edges. In-memory counters
--      (e.g. JavaScript Map or variables) are ephemeral, reset on cold starts,
--      and cannot share state across instances. A durable database-backed rate
--      limiting mechanism is required to withstand coordinated bot attacks,
--      crawlers, and rapid-fire booking floods.
--   2. Atomic Sliding-Window Rate Limiting: The check_and_increment_rate_limit()
--      function uses an atomic INSERT ... ON CONFLICT (rate_key) DO UPDATE
--      upsert transaction in PostgreSQL, eliminating race conditions across
--      concurrent Edge Function instances without table locks or duplicate key errors.
--   3. Atomic Idempotency & Request Fingerprinting:
--      Previous two-step flows (create booking, then record idempotency) were
--      vulnerable to race conditions and duplicate creation under concurrent retries.
--      create_public_reservation_idempotent() executes BOTH idempotency registration
--      and reservation creation atomically inside a single database transaction:
--      - An atomic INSERT ... ON CONFLICT DO NOTHING establishes the processing
--        claim for the idempotency key.
--      - Concurrent identical requests serialize on row-level locking (FOR UPDATE)
--        and return the authoritative original booking result with idempotent_replayed = true.
--      - Reusing an idempotency key with altered customer or booking data is strictly
--        rejected with an explicit error ("Idempotency key mismatch").
--      - Double-booking is physically prevented by the exclusionary reservation range lock.
--   4. Strict Security & Privileged Isolation:
--      Both tables have Row Level Security (RLS) enabled with NO policies for anon
--      or authenticated users. Direct table access is completely revoked from
--      PUBLIC, anon, and authenticated callers. Only service_role (used strictly
--      by the server-side create-booking Edge Function) can access or execute these.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Durable Rate Limiting Table
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.booking_rate_limits (
    rate_key TEXT PRIMARY KEY,
    attempts INT NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_attempt TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS and lock down permissions
ALTER TABLE public.booking_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.booking_rate_limits FROM PUBLIC;
REVOKE ALL ON TABLE public.booking_rate_limits FROM anon;
REVOKE ALL ON TABLE public.booking_rate_limits FROM authenticated;
GRANT ALL ON TABLE public.booking_rate_limits TO service_role;

-- ------------------------------------------------------------------------------
-- 2. Concurrency-Safe Atomic Rate Limiting Evaluation Function
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_and_increment_rate_limit(
    p_rate_key TEXT,
    p_max_attempts INT,
    p_window_seconds INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_record RECORD;
    v_now TIMESTAMPTZ := now();
    v_window_interval INTERVAL;
    v_retry_after INT := 0;
BEGIN
    IF p_rate_key IS NULL OR p_max_attempts IS NULL OR p_window_seconds IS NULL THEN
        RAISE EXCEPTION 'check_and_increment_rate_limit requires non-null p_rate_key, p_max_attempts, and p_window_seconds.';
    END IF;

    v_window_interval := (p_window_seconds || ' seconds')::INTERVAL;

    -- Concurrency-safe atomic upsert: eliminates race condition on first insert
    INSERT INTO public.booking_rate_limits (rate_key, attempts, window_start, last_attempt)
    VALUES (p_rate_key, 1, v_now, v_now)
    ON CONFLICT (rate_key) DO UPDATE
    SET attempts = CASE
            WHEN public.booking_rate_limits.window_start + v_window_interval <= v_now THEN 1
            ELSE public.booking_rate_limits.attempts + 1
        END,
        window_start = CASE
            WHEN public.booking_rate_limits.window_start + v_window_interval <= v_now THEN v_now
            ELSE public.booking_rate_limits.window_start
        END,
        last_attempt = v_now
    RETURNING * INTO v_record;

    IF v_record.attempts > p_max_attempts THEN
        v_retry_after := CEIL(EXTRACT(EPOCH FROM (v_record.window_start + v_window_interval - v_now)));
        IF v_retry_after < 1 THEN
            v_retry_after := 1;
        END IF;

        RETURN jsonb_build_object(
            'allowed', false,
            'current_attempts', v_record.attempts,
            'max_attempts', p_max_attempts,
            'retry_after_seconds', v_retry_after
        );
    ELSE
        RETURN jsonb_build_object(
            'allowed', true,
            'current_attempts', v_record.attempts,
            'max_attempts', p_max_attempts,
            'retry_after_seconds', 0
        );
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_increment_rate_limit(TEXT, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_and_increment_rate_limit(TEXT, INT, INT) FROM anon;
REVOKE ALL ON FUNCTION public.check_and_increment_rate_limit(TEXT, INT, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_increment_rate_limit(TEXT, INT, INT) TO service_role;

-- ------------------------------------------------------------------------------
-- 3. Idempotency Key Storage Table with Request Fingerprinting
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.booking_idempotency_keys (
    idempotency_key TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing', -- 'processing' | 'completed'
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    court_id UUID NOT NULL REFERENCES public.courts(id) ON DELETE CASCADE,
    booking_date DATE NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    reservation_id UUID REFERENCES public.reservations(id) ON DELETE SET NULL,
    response_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_booking_idempotency_expires_at
    ON public.booking_idempotency_keys(expires_at);

ALTER TABLE public.booking_idempotency_keys ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.booking_idempotency_keys FROM PUBLIC;
REVOKE ALL ON TABLE public.booking_idempotency_keys FROM anon;
REVOKE ALL ON TABLE public.booking_idempotency_keys FROM authenticated;
GRANT ALL ON TABLE public.booking_idempotency_keys TO service_role;

-- ------------------------------------------------------------------------------
-- 4. Atomic Idempotent Public Reservation RPC
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_public_reservation_idempotent(
    p_idempotency_key TEXT,
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
    v_clean_key TEXT;
    v_fingerprint TEXT;
    v_idemp RECORD;
    v_res JSONB;
    v_inserted BOOLEAN := false;
BEGIN
    -- 1. Validate required inputs
    IF p_facility_id IS NULL OR
       p_court_id IS NULL OR
       p_customer_name IS NULL OR
       p_booking_date IS NULL OR
       p_start_time IS NULL OR
       p_duration_minutes IS NULL THEN
        RAISE EXCEPTION 'Required booking parameters (facility_id, court_id, customer_name, booking_date, start_time, duration_minutes) cannot be NULL.';
    END IF;

    -- Compute deterministic SHA256/MD5 request fingerprint across all business parameters
    v_fingerprint := md5(
        p_facility_id::TEXT || '|' ||
        p_court_id::TEXT || '|' ||
        p_booking_date::TEXT || '|' ||
        p_start_time::TEXT || '|' ||
        COALESCE(p_duration_minutes, 60)::TEXT || '|' ||
        lower(trim(p_customer_name)) || '|' ||
        COALESCE(trim(p_customer_phone), '') || '|' ||
        lower(COALESCE(trim(p_customer_email), ''))
    );

    v_clean_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');

    IF v_clean_key IS NULL THEN
        RAISE EXCEPTION 'p_idempotency_key is required and cannot be NULL or empty.';
    END IF;

    IF length(v_clean_key) < 16 OR length(v_clean_key) > 128 THEN
        RAISE EXCEPTION 'Invalid idempotency_key length. Must be between 16 and 128 characters.';
    END IF;

    -- 2. Evaluate existing idempotency record or register processing placeholder atomically
    -- Attempt to insert the 'processing' placeholder atomically
        INSERT INTO public.booking_idempotency_keys (
            idempotency_key,
            request_fingerprint,
            status,
            facility_id,
            court_id,
            booking_date,
            start_time,
            created_at,
            expires_at
        ) VALUES (
            v_clean_key,
            v_fingerprint,
            'processing',
            p_facility_id,
            p_court_id,
            p_booking_date,
            p_start_time,
            now(),
            now() + INTERVAL '24 hours'
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING true INTO v_inserted;

        -- If key was already inserted (concurrent transaction or replay):
        IF v_inserted IS NOT TRUE THEN
            -- Lock and inspect the existing row
            SELECT * INTO v_idemp
            FROM public.booking_idempotency_keys
            WHERE idempotency_key = v_clean_key
            FOR UPDATE;

            IF FOUND THEN
                -- Reusing same key with altered customer or booking data MUST fail
                IF v_idemp.request_fingerprint <> v_fingerprint THEN
                    RAISE EXCEPTION 'Idempotency key mismatch: this idempotency key was previously submitted with different booking parameters.';
                END IF;

                -- Repeated identical request returns authoritative cached response
                IF v_idemp.status = 'completed' AND v_idemp.response_payload IS NOT NULL THEN
                    RETURN v_idemp.response_payload || jsonb_build_object('idempotent_replayed', true);
                END IF;

                -- Concurrent identical request in progress
                IF v_idemp.status = 'processing' THEN
                    RAISE EXCEPTION 'A concurrent booking request with this idempotency key is already in progress. Please retry shortly.';
                END IF;
            END IF;
        END IF;

    -- 3. Execute reservation creation (never trust p_is_demo from caller)
    v_res := public.create_public_reservation(
        p_facility_id,
        p_court_id,
        p_customer_name,
        p_customer_phone,
        p_customer_email,
        p_booking_date,
        p_start_time,
        p_duration_minutes,
        false -- Never allow client to create demo records in public database
    );

    -- 4. Mark idempotency key completed and store payload
    UPDATE public.booking_idempotency_keys
    SET status = 'completed',
        reservation_id = (v_res->>'reservation_id')::UUID,
        response_payload = v_res
    WHERE idempotency_key = v_clean_key;

    RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.create_public_reservation_idempotent(TEXT, UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_public_reservation_idempotent(TEXT, UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.create_public_reservation_idempotent(TEXT, UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_reservation_idempotent(TEXT, UUID, UUID, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ, INT, BOOLEAN) TO service_role;

-- ------------------------------------------------------------------------------
-- 5. Periodic Maintenance Cleanup RPC
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_expired_abuse_records()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_deleted_rate_limits INT := 0;
    v_deleted_idempotency INT := 0;
BEGIN
    -- Safely delete rate limits where the last attempt is older than 24 hours
    DELETE FROM public.booking_rate_limits
    WHERE last_attempt < (now() - INTERVAL '24 hours');
    GET DIAGNOSTICS v_deleted_rate_limits = ROW_COUNT;

    -- Safely delete expired idempotency keys (retention window passed)
    DELETE FROM public.booking_idempotency_keys
    WHERE expires_at <= now();
    GET DIAGNOSTICS v_deleted_idempotency = ROW_COUNT;

    RETURN jsonb_build_object(
        'deleted_rate_limits', v_deleted_rate_limits,
        'deleted_idempotency_keys', v_deleted_idempotency,
        'cleaned_at', now()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_abuse_records() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_expired_abuse_records() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_expired_abuse_records() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_abuse_records() TO service_role;

-- ------------------------------------------------------------------------------
-- 6. Separate SQL Statement: pg_cron Maintenance Job (Execute in SQL Editor)
-- ------------------------------------------------------------------------------
-- NOTE:
--   1. Migration 004 defines the schema and functions above.
--   2. To schedule daily maintenance without modifying or replacing the existing
--      'courtbook-expire-pending-holds' job, execute the separate statement below
--      in the Supabase SQL Editor once Migration 004 is applied.
--
-- SCHEDULE STATEMENT:
--   SELECT cron.schedule(
--       'courtbook-cleanup-abuse-records',
--       '0 3 * * *', -- Daily at 03:00 UTC
--       $$SELECT public.cleanup_expired_abuse_records();$$
--   );
--
-- INSPECTION / UNSCHEDULE STATEMENTS:
--   -- Verify both cron jobs are active:
--   SELECT jobid, jobname, schedule, active FROM cron.job;
--
--   -- To unschedule if needed:
--   -- SELECT cron.unschedule('courtbook-cleanup-abuse-records');
