# CourtBook — Supabase Database Architecture & Security Guide

This document details the database design, security hardening, and deployment instructions for **CourtBook** on PostgreSQL/Supabase (part of the **BookSuite** platform).

> **Current Application Status:** Architectural definition only. The current React web application runs decoupled using client-side `localStorage`. Do not apply SQL or connect Supabase until you are ready for Phase 2.

---

## 1. Security Architecture & Policies

The migration is located at:
```
supabase/migrations/001_initial_schema.sql
```

### Key Security & Integrity Highlights

1. **Unconditional Rejection of Direct Updates to Sensitive Reservation Fields**:
   - The trigger `restrict_reservation_updates` **does not rely on `current_user` or `session_user`** (which change under `SECURITY DEFINER` and are vulnerable to privilege confusion).
   - Any direct `UPDATE` on `public.reservations` attempting to modify immutable fields (`price`, `currency`, `duration_minutes`, `booking_date`, `start_time`, `end_time`, `reference_code`, `customer_name`, `customer_phone`, `customer_email`, `court_id`, `facility_id`, `created_at`, or `is_demo`) is **unconditionally rejected at the database engine level**:
     ```
     ERROR: Direct modification of pricing, schedule, court, facility, or customer fields on reservations is not permitted. Only status and cancellation metadata may be modified directly.
     ```
   - **Column-Level Privilege Defense:** Authenticated staff roles are granted `UPDATE (status, cancellation_reason, cancelled_at, cancelled_by)` only. Direct SQL attempts to update other columns are rejected before even reaching table triggers.
   - **Narrowly Scoped Server-Side Rescheduling:** If an authorized facility owner or admin needs to reschedule a customer booking, they execute the dedicated server routine `reschedule_reservation_as_staff(...)`, which verifies facility ownership, validates operating hours against the court's timezone, verifies court availability, recalculates the price server-side, and applies the change with atomic row locking.

2. **Accurate IANA Timezone Boundaries (No 24-Hour Assumption)**:
   - `get_court_busy_slots()` calculates local day boundaries independently:
     ```sql
     v_day_start := (p_date::TEXT || ' 00:00:00')::TIMESTAMP AT TIME ZONE v_tz;
     v_day_end   := ((p_date + 1)::TEXT || ' 00:00:00')::TIMESTAMP AT TIME ZONE v_tz;
     ```
   - Accurately respects Daylight Saving Time (DST) transition days (23h and 25h days) in the facility's local IANA timezone without assuming a 24-hour interval.

3. **Explicit Court Availability Verification (Zero Ambiguity)**:
   - Nonexistent, disabled, or inactive facility courts are **never mistaken for an empty schedule**:
     - `get_court_busy_slots()` throws an explicit error if the court is disabled or nonexistent rather than returning 0 rows.
     - `check_court_booking_status(court_id)` returns an explicit status JSON object (`is_bookable: true/false`, reason, rates, operating hours) for client-side pre-checks.

4. **Public Direct Booking Creation is Disabled (`create_public_reservation`)**:
   - `EXECUTE` privileges are revoked from `PUBLIC`, `anon`, and `authenticated`.
   - Public customer bookings cannot be submitted directly from client API keys.
   - **Reasoning:** Direct database-level execution from anonymous clients cannot enforce IP rate limiting, bot protection (Cloudflare Turnstile), or protect database connections from connection-pool exhaustion.
   - **Future Endpoint:** Public bookings will be submitted through a protected server-side API or Supabase Edge Function (`/api/bookings` or `supabase/functions/create-booking`) using the `service_role` key after passing rate-limiting and bot mitigation checks.

5. **Explicit Grants for Restricted Supabase Environments**:
   - Works seamlessly even when the Supabase project setting **"Automatically expose new tables to API" is disabled**.
   - Explicit `GRANT USAGE ON SCHEMA public` and granular table grants (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) ensure PostgREST exposes only necessary tables, while private customer reservation records remain strictly protected under RLS.

6. **Membership Immutability & Last-Owner Protection**:
   - Trigger `validate_membership_modification` prevents changing `organization_id` or `user_id` on existing membership records.
   - Users cannot alter their own role (preventing self-promotion). Only existing owners can assign or revoke the `owner` role.
   - Trigger `protect_last_owner` acquires an exclusive row lock (`FOR UPDATE`) on the parent `organizations` row, eliminating race conditions where concurrent updates/deletes could remove all owners.

7. **Database-Level Overlap Prevention (`btree_gist`)**:
   - Active reservations are guarded by an exclusion constraint:
     ```sql
     EXCLUDE USING gist (
         court_id WITH =,
         tstzrange(start_time, end_time, '[)') WITH &&
     )
     WHERE (status = 'confirmed');
     ```
   - Two concurrent bookings for the same court and slot are rejected atomically at the database engine level.

---

## 2. How to Run the Migration Manually

### Option A: Via the Supabase Web Dashboard (Recommended)

1. Sign in to your [Supabase Dashboard](https://supabase.com/dashboard).
2. Select your CourtBook project.
3. In the left navigation, click on **SQL Editor**.
4. Click **New query** (the `+` icon).
5. Copy the entire contents of `supabase/migrations/001_initial_schema.sql` and paste them into the SQL editor.
6. Click **Run** (or `Cmd/Ctrl + Enter`).
7. Confirm that the query finishes with `Success. No rows returned`.

### Option B: Via the Supabase CLI

```bash
# Authenticate CLI
npx supabase login

# Link your local repository to your remote Supabase project
npx supabase link --project-ref <your-supabase-project-id>

# Apply the migration
npx supabase db push
```

---

## 3. How Staff Authentication & Organization Creation Work

### Creating an Organization and Initial Owner
When a new facility manager signs up via Supabase Auth (`supabase.auth.signUp()`), they create their organization and become its first `owner` by calling the atomic stored procedure:

```sql
-- Executed by an authenticated user:
SELECT public.create_organization_with_owner(
    p_name := 'Metro Pickleball Club',
    p_slug := 'metro-pickleball-club',
    p_billing_email := 'billing@metropickleball.ph',
    p_is_demo := false
);
```

This procedure:
1. Validates that `auth.uid()` is present.
2. Checks that the slug is unique and alphanumeric.
3. Inserts the organization.
4. Automatically inserts the caller into `organization_members` with `role = 'owner'`.
5. Returns the new `organization_id`.

---

## 4. Protected Booking Endpoint Architecture (Phase 2)

### Public Booking Flow
```
[ Browser / Customer ]
       │
       ▼ (1. Check Court Status & Availability)
RPC: check_court_booking_status(court_id) ──► Validates court is open, enabled, active
RPC: get_court_busy_slots(court_id, date) ──► Returns anonymized busy intervals (DST-safe)
       │
       ▼ (2. Submit Booking Request)
POST /api/bookings (Protected Edge Function / Backend Proxy)
       │
       ├─► Validates Turnstile / CAPTCHA (Bot Prevention)
       ├─► Checks Rate Limit (e.g. max 5 requests / 10 mins per IP via Redis)
       │
       ▼ (3. Execute with service_role key)
RPC: create_public_reservation(...) ────────► Database validates operating hours,
                                              applies server-authoritative rates,
                                              and enforces exclusion lock.
```

---

## 5. Verification & Security Testing Guide

Copy and run these SQL snippets in your Supabase SQL Editor to verify that all constraints and security policies behave as expected.

### Test 1: Direct Price Tampering is Blocked
Verify that an ordinary staff member cannot change a reservation's price:

```sql
BEGIN;
  -- Try to modify reservation price directly
  -- EXPECTED RESULT: ERROR: Direct modification of pricing, schedule, court, facility, or customer fields on reservations is not permitted.
  UPDATE public.reservations
  SET price = 1.00
  WHERE id = 'r0000000-0000-0000-0000-000000000001';
ROLLBACK;
```

### Test 2: Customer Information Tampering is Blocked
Verify that an ordinary staff member cannot change customer name, phone, or email:

```sql
BEGIN;
  -- Try to modify customer name
  -- EXPECTED RESULT: ERROR: Direct modification of pricing, schedule, court, facility, or customer fields on reservations is not permitted.
  UPDATE public.reservations
  SET customer_name = 'Hacked Name'
  WHERE id = 'r0000000-0000-0000-0000-000000000001';
ROLLBACK;
```

### Test 3: Booking Time Tampering is Blocked
Verify that an ordinary staff member cannot change the start time or booking date directly:

```sql
BEGIN;
  -- Try to modify booking time
  -- EXPECTED RESULT: ERROR: Direct modification of pricing, schedule, court, facility, or customer fields on reservations is not permitted.
  UPDATE public.reservations
  SET start_time = now() + interval '5 days'
  WHERE id = 'r0000000-0000-0000-0000-000000000001';
ROLLBACK;
```

### Test 4: Permitted Cancellation Operation Works
Verify that an ordinary staff member CAN cancel a reservation or update cancellation reason:

```sql
BEGIN;
  -- Set status to cancelled directly or via procedure
  SELECT public.cancel_reservation_as_staff(
      'r0000000-0000-0000-0000-000000000001',
      'Customer requested cancellation via telephone'
  );

  -- Or direct status update:
  UPDATE public.reservations
  SET status = 'cancelled',
      cancellation_reason = 'Direct staff cancellation test'
  WHERE id = 'r0000000-0000-0000-0000-000000000001';

  -- Verify cancelled_at was automatically set
  SELECT id, status, cancelled_at, cancellation_reason
  FROM public.reservations
  WHERE id = 'r0000000-0000-0000-0000-000000000001';
ROLLBACK;
```

### Test 5: Overlap Prevention (Exclusion Constraint)
Verify that PostgreSQL prevents double-booking the same court during the same time window:

```sql
BEGIN;
  INSERT INTO public.reservations (
      facility_id, court_id, reference_code, customer_name, booking_date,
      start_time, end_time, time_slot_label, duration_minutes, price, status
  ) VALUES (
      'f0000000-0000-0000-0000-000000000001',
      'c0000000-0000-0000-0000-000000000001',
      'TEST-REF-1', 'Alice Santos', '2026-10-15',
      '2026-10-15 10:00:00+08', '2026-10-15 11:00:00+08',
      '10:00 AM – 11:00 AM', 60, 350.00, 'confirmed'
  );

  -- Insert overlapping reservation B (10:30 AM - 11:30 AM) on the SAME court
  -- EXPECTED RESULT: ERROR: conflicting key value violates exclusion constraint "prevent_court_overlapping_active_reservations"
  INSERT INTO public.reservations (
      facility_id, court_id, reference_code, customer_name, booking_date,
      start_time, end_time, time_slot_label, duration_minutes, price, status
  ) VALUES (
      'f0000000-0000-0000-0000-000000000001',
      'c0000000-0000-0000-0000-000000000001',
      'TEST-REF-2', 'Bob Reyes', '2026-10-15',
      '2026-10-15 10:30:00+08', '2026-10-15 11:30:00+08',
      '10:30 AM – 11:30 AM', 60, 350.00, 'confirmed'
  );
ROLLBACK;
```

### Test 6: Disabled Court Detection in Availability
Verify that querying availability for a disabled court throws an informative error rather than returning 0 rows:

```sql
-- Disable court 1 temporarily
UPDATE public.courts SET is_enabled = false WHERE id = 'c0000000-0000-0000-0000-000000000001';

-- EXPECTED RESULT: ERROR: Court c0000000-0000-0000-0000-000000000001 is not available for booking (nonexistent, disabled, or inactive facility).
SELECT * FROM public.get_court_busy_slots('c0000000-0000-0000-0000-000000000001', '2026-10-15');

-- Re-enable court
UPDATE public.courts SET is_enabled = true WHERE id = 'c0000000-0000-0000-0000-000000000001';
```

### Test 7: Direct Public Booking Creation is Blocked
Verify that anonymous or client authenticated roles cannot invoke `create_public_reservation`:

```sql
SET ROLE anon;

-- EXPECTED RESULT: ERROR: permission denied for function create_public_reservation
SELECT public.create_public_reservation(
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'Test User', '0917-000-0000', 'test@example.com',
    '2026-10-15', now() + interval '1 day', 60
);

RESET ROLE;
```

---

## 6. Optional Development Demonstration Seed Script

If you want to populate your development environment with the Phase 1 *Apex Pickleball Arena* demo data, execute this query in the SQL Editor **after** running `001_initial_schema.sql`:

```sql
-- OPTIONAL DEV SEED: Run only in development/staging environments
DO $$
DECLARE
    v_demo_user_id UUID;
    v_org_id UUID;
    v_fac_id UUID;
BEGIN
    SELECT id INTO v_demo_user_id FROM auth.users LIMIT 1;

    INSERT INTO public.organizations (name, slug, billing_email, is_demo)
    VALUES ('Apex Sports Corp (Demo)', 'apex-demo', 'admin@apex.demo', true)
    ON CONFLICT (slug) DO UPDATE SET is_demo = true
    RETURNING id INTO v_org_id;

    IF v_demo_user_id IS NOT NULL THEN
        INSERT INTO public.organization_members (organization_id, user_id, role)
        VALUES (v_org_id, v_demo_user_id, 'owner')
        ON CONFLICT (organization_id, user_id) DO NOTHING;
    END IF;

    INSERT INTO public.facilities (
        organization_id, app_type, name, slug, tagline, address,
        currency, open_hour, close_hour, default_hourly_rate, is_active, is_demo
    ) VALUES (
        v_org_id, 'courtbook', 'Apex Pickleball Arena', 'apex-pickleball-arena',
        'Premier Indoor Courts & Community Hub', '128 Sports Boulevard, Metro District',
        '₱', 8, 22, 350.00, true, true
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO v_fac_id;

    IF v_fac_id IS NOT NULL THEN
        INSERT INTO public.courts (facility_id, name, sport_type, tag, surface_type, description, hourly_rate, is_enabled, display_order)
        VALUES
        (v_fac_id, 'Court 1', 'Pickleball', 'Championship Court', 'Indoor Cushioned Pro Surface', 'Tournament-grade court with professional LED broadcast lighting.', 350.00, true, 1),
        (v_fac_id, 'Court 2', 'Pickleball', 'Tournament Court', 'Indoor Non-Slip Acrylic', 'High-traction competition court with premium regulation net.', 350.00, true, 2),
        (v_fac_id, 'Court 3', 'Pickleball', 'Club Standard Court', 'Multi-Sport Cushioned Surface', 'Ideal for social games, open doubles play, drills, and practice.', 350.00, true, 3)
        ON CONFLICT (facility_id, name) DO NOTHING;
    END IF;
END $$;
```

---

## 7. Migration 004: Abuse Prevention, Durable Rate Limiting & Atomic Idempotency

### Rationale
Stateless serverless Edge Functions run across multiple distributed Deno isolates and edge locations. In-memory counters (e.g. JavaScript maps) are wiped on isolate cold-starts and cannot coordinate across edge regions.

Migration `supabase/migrations/004_abuse_prevention_and_idempotency.sql` introduces:
1. `booking_rate_limits`: PostgreSQL-backed sliding-window rate tracking table.
2. `check_and_increment_rate_limit(p_rate_key, p_max_attempts, p_window_seconds)`: Concurrency-safe atomic upsert procedure with row locking (`INSERT ... ON CONFLICT DO UPDATE`).
3. `booking_idempotency_keys`: 24-hour TTL idempotency store preventing duplicate bookings or false conflicts when clients retry after mobile connection dropouts.
4. `create_public_reservation_idempotent(...)`: Atomic database routine that registers the idempotency key, fingerprints request parameters, enforces concurrency serialization, and creates the reservation in ONE single transaction.
   - Repeated identical requests return the cached original result with `idempotent_replayed = true`.
   - Reusing an idempotency key with different booking/customer data is rejected with `Idempotency key mismatch`.
   - Concurrent identical requests serialize cleanly on row locks without creating two reservations.
5. Strict Security: Tables and RPCs are restricted exclusively to `service_role`. All direct access from `anon`, `authenticated`, and `PUBLIC` is revoked.

### How to Apply Migration 004
1. Open the [Supabase SQL Editor](https://supabase.com/dashboard/project/_/sql).
2. Copy and run `supabase/migrations/004_abuse_prevention_and_idempotency.sql`.
3. Confirm query completes with `Success. No rows returned`.

---

## 8. Secure Edge Function Deployment: `create-booking`

The Supabase Edge Function is located at:
```
supabase/functions/create-booking/index.ts
```

### Authentication Model & JWT Verification
- **Public Booking Flow:** Anonymous customers browsing the website do not have an authenticated Supabase user session (they are unauthenticated public visitors).
- **Gateway Setting (`--no-verify-jwt`):**
  When deploying the public booking function, pass the `--no-verify-jwt` flag:
  ```bash
  npx supabase functions deploy create-booking --no-verify-jwt
  ```
  **Why?** By default, Supabase functions expect a logged-in user JWT. The `--no-verify-jwt` flag allows the API gateway to accept requests signed with the public `apikey: <anon_key>` without rejecting unauthenticated customers.
- **Backend Isolation & Fail-Closed Security:**
  The Edge Function strictly protects the database. It validates payload size (< 16KB), verifies CAPTCHA challenges, executes atomic database rate limiting, and uses `SUPABASE_SERVICE_ROLE_KEY` (injected automatically into the serverless environment) to call `create_public_reservation_idempotent()`. Browsers **never** receive the service-role key.
  - If Turnstile secret is not configured in production, the function **fails closed** (HTTP 503 `BOT_PROTECTION_UNAVAILABLE`).
  - If rate-limiting RPC fails or returns an error, the function **fails closed** (HTTP 503 `RATE_LIMIT_SERVICE_UNAVAILABLE`).
  - Customer contact information and secrets are never logged to server logs.

- **Client IP Trust & Rate Limiting Strategy:**
  - Standard serverless Edge Runtimes do not guarantee the authenticity of client IP headers (such as `CF-Connecting-IP`, `X-Real-IP`, or `X-Forwarded-For`) without dedicated proxy infrastructure. Per security review, reliance on these headers for security decisions has been removed to prevent IP spoofing attacks.
  - On **EVERY** public booking request, two database-backed rate limiters are enforced sequentially:
    1. **Facility Burst Protection:** `facility:<id>:burst` (25 requests/minute across the entire facility). Prevents coordinated slot starvation attacks against any court venue.
    2. **Customer Contact Rate Limit:** `contact:<keyed_hmac>` (5 requests/minute per customer).
  - **Keyed HMAC Privacy for Rate Limiting:**
    - To prevent storing plaintext customer emails or phone numbers in the database `booking_rate_limits` table, contact identifiers are normalized (lowercased/trimmed) and hashed with a server-side keyed HMAC-SHA256 before querying or incrementing the rate limit store.
    - The HMAC secret (`CONTACT_HMAC_SECRET`) is stored strictly in the Edge Function environment and is never exposed to browsers or public callers.

- **Mandatory Idempotency:**
  - Every genuine booking request MUST include a valid 16-128 character `idempotency_key`.
  - Missing or malformed keys are rejected with HTTP 400 (`IDEMPOTENCY_KEY_REQUIRED` / `INVALID_IDEMPOTENCY_KEY`).
  - Reservation creation and idempotency registration execute in a single atomic database transaction.
  - Replaying identical requests returns the authoritative cached response with `idempotent_replayed = true`.

- **Configuration Safety:**
  - `ALLOW_INSECURE_TESTING` is strictly restricted to local development environments (`localhost` / `127.0.0.1`).
  - On any deployed public Supabase endpoint, `ALLOW_INSECURE_TESTING` is completely ignored and bot verification fails closed.

### Environment Variables & Secrets
| Variable | Provided By | Purpose |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Supabase Runtime | Automatically provided by Edge Function environment. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Runtime | Automatically provided by Edge Function environment. Never exposed to browser. |
| `TURNSTILE_SECRET_KEY` | Supabase Secrets (Required for Live) | Cloudflare Turnstile secret key for server-side bot verification. |
| `CONTACT_HMAC_SECRET` | Supabase Secrets (Mandatory) | Dedicated server-side secret (min 16 chars) used for HMAC-SHA256 hashing of customer contacts for rate limiting. Fails closed with HTTP 500 if missing or invalid. No service role key fallback. |
| `VITE_TURNSTILE_SITE_KEY` | Frontend `.env` (Required for Live) | Cloudflare Turnstile site key rendered in frontend client widget. |
| `ALLOW_INSECURE_TESTING` | Optional Server Secret (Local Only) | Permitted ONLY in local development environments (localhost/127.0.0.1) for automated test suites. Ignored on deployed endpoints. |

To configure Cloudflare Turnstile and mandatory HMAC secrets in your Supabase project:
```bash
# Set secrets via Supabase CLI
npx supabase secrets set TURNSTILE_SECRET_KEY="0x4AAAAAA..."
npx supabase secrets set CONTACT_HMAC_SECRET="super-secret-edge-hmac-key-2026"

# Or via Dashboard:
# Project Settings -> Edge Functions -> Secrets -> Add "TURNSTILE_SECRET_KEY" and "CONTACT_HMAC_SECRET"
```

### Daily Abuse & Idempotency Cleanup Job (`pg_cron`)
Migration 004 provides `cleanup_expired_abuse_records()`. To schedule automated daily maintenance in Supabase **without modifying or replacing** the existing `courtbook-expire-pending-holds` job, run this separate SQL statement in the Supabase SQL Editor:

```sql
SELECT cron.schedule(
    'courtbook-cleanup-abuse-records',
    '0 3 * * *', -- Daily at 03:00 UTC
    $$SELECT public.cleanup_expired_abuse_records();$$
);
```

To verify both scheduled jobs:
```sql
SELECT jobid, jobname, schedule, active FROM cron.job;
```

### Safe Testing with `curl` (No Exposed Secrets)
Test the endpoint using only your project's publishable/anon key:

```bash
# 1. CORS Preflight check
curl -i -X OPTIONS https://<project-ref>.supabase.co/functions/v1/create-booking

# 2. Method Restriction check (Expect HTTP 405 Method Not Allowed)
curl -i -X GET https://<project-ref>.supabase.co/functions/v1/create-booking \
  -H "apikey: <YOUR_ANON_KEY>"

# 3. Validation rejection check (Expect HTTP 400 Bad Request)
curl -i -X POST https://<project-ref>.supabase.co/functions/v1/create-booking \
  -H "Content-Type: application/json" \
  -H "apikey: <YOUR_ANON_KEY>" \
  -d '{"customer_name": "Test"}'
```

