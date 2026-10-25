# CourtBook / BookSuite — Automated Supabase Security & Integration Suite

Automated integration and Row-Level Security (RLS) test harness for CourtBook on Supabase (**BookSuite-Dev**).

This suite executes **real HTTP API requests and real Supabase Auth sessions** using `@supabase/supabase-js`, validating tenant isolation, permission boundaries, and state-machine integrity against live PostgreSQL policies and procedures.

---

## Existing Fictional Entities Reused

The testing harness targets the existing fixtures in your Supabase project without creating duplicates:

| Entity | Slug | Associated Court & Rate | Owner Account |
| :--- | :--- | :--- | :--- |
| **Organization A** | `courtbook-test-pickleball-a` | Facility: `courtbook-pickleball-test` (Court A @ ₱350/hr) | **User A** |
| **Organization B** | `courtbook-test-badminton-b` | Facility: `courtbook-badminton-test` (Court B @ ₱250/hr) | **User B** |

---

## Test Safety & Customer Data Protection

1. **Zero Real Customer Modification**: Tests strictly query and target designated test fixtures tagged with `TD-%` (`TD-CONF-001`, `TD-CMPL-001`). Real customer records are never read, altered, or deleted.
2. **CHECK Constraint Compliance**: All test reference codes (`TD-CONF-001`, `TD-CMPL-001`) are between 5 and 20 characters, strictly satisfying `public.reservations.reference_code` CHECK constraints.
3. **Safe Cleanup & Restoration**:
   - Tests that create disposable test courts or test maintenance blocks clean them up immediately in `finally` blocks.
   - The rescheduling test executes verified restoration back to the original time slot, explicitly checking the restoration result.
4. **Deliberate Test-Environment Confirmation**: All state-changing or mutation-attempting tests are guarded. They run **only** when `CONFIRM_TEST_ENV=true` is present in your local `.env.test`. Otherwise, they are safely reported as `BLOCKED`.
5. **Idempotent & Repeatable**: Re-running `seed-test-data.sql` non-destructively refreshes any previously cancelled disposable test fixture (`TD-CONF-001`) without altering real customer data.

---

## Classification of Test Suites: Read-Only vs. State-Changing

| Suite | Category | Type | Description |
| :--- | :--- | :--- | :--- |
| **01** | `Authentication` | **READ-ONLY** | Validates User A & User B sign-in with live passwords from `.env.test`; verifies invalid password rejection. |
| **02** | `RLS & Organizations` | **STATE-CHANGING (GUARDED)** | Verifies User A & B read authorized orgs; tests cross-tenant update and self-membership insertion rejection. |
| **03** | `Facilities & Courts` | **STATE-CHANGING (GUARDED)** | Verifies court reads and rates (₱350 vs ₱250); tests cross-facility edits rejection; tests disposable court lifecycle with cleanup. |
| **04** | `Reservation Security` | **STATE-CHANGING (GUARDED)** | Verifies direct `UPDATE` on prices, customer data, and status is revoked; verifies direct `INSERT` is rejected. |
| **05** | `Staff Cancellation` | **STATE-CHANGING (GUARDED)** | Verifies cross-tenant cancellation rejection; rejects cancelling completed bookings; tests cancellation on designated test fixture. |
| **06** | `Staff Rescheduling` | **STATE-CHANGING (GUARDED)** | Verifies rejection of cross-facility moves, operating hours bounds, and past dates; tests rescheduling with verified restoration. |
| **07** | `Maintenance Blocks` | **STATE-CHANGING (GUARDED)** | Verifies cross-tenant block rejection; verifies exclusion constraint prevents overlapping blocks; cleans up disposable blocks. |
| **08** | `Public Availability` | **READ-ONLY** | Calls `check_court_booking_status` and `get_court_busy_slots`; verifies anti-ambiguity exceptions for disabled/nonexistent courts. |
| **09** | `Booking Confirmation` | **STATE-CHANGING (GUARDED)** | Verifies instant vs manual approval modes, hold durations, and stale hold expiration cleanup boundaries. |
| **10** | `Edge & Abuse Defense` | **STATE-CHANGING (GUARDED)** | Verifies rate limiting, Turnstile token verification, and atomic database idempotency replay contracts. |
| **11** | `UUID & Facility Mapping` | **READ-ONLY** | Verifies facility and court UUID resolution, preventing cross-business court mismatch. |
| **12** | `Booking Response Envelope` | **READ-ONLY** | Verifies flat PostgreSQL RPC return parsing, field alias resolution, and timezone-accurate slot calculations. |
| **13** | `Multi-Tenant Isolation` | **READ-ONLY & GUARDED** | Comprehensive Phase 2 verification: validates User A & B read/write tenant boundaries, RPC permission barriers, settings isolation, membership security, and anonymous client privacy. |

---

## Quickstart (Mac Terminal Commands)

### 1. Set Up Local Test Configuration
In your project root, create `.env.test`:

```bash
touch .env.test
```

Add your Supabase project URL, Anon Key, and test user credentials (do not commit secrets to Git):

```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your-anon-publishable-key

# Fictional Test Account Credentials (configured in Supabase Auth)
TEST_USER_A_EMAIL=your-user-a-email@domain.com
TEST_USER_A_PASSWORD=your-secret-user-a-password
TEST_USER_B_EMAIL=your-user-b-email@domain.com
TEST_USER_B_PASSWORD=your-secret-user-b-password

# Deliberate Confirmation (enables state-changing tests on disposable fixtures)
CONFIRM_TEST_ENV=true
```

### 2. Verify Non-Destructive Database Seed (Optional)
If the disposable test booking fixtures are not yet in your database, execute `tests/supabase/seed-test-data.sql` in the **Supabase SQL Editor**.

This script is completely non-destructive: it uses `ON CONFLICT DO NOTHING`, does not alter real customer data, uses valid PostgreSQL date arithmetic, and reuses existing slugs (`courtbook-test-pickleball-a`, `courtbook-test-badminton-b`).

### 3. Run the Automated Tests

To run the complete automated test suite:

```bash
npm run test:supabase
```

The runner outputs colored badges (`[PASS]`, `[FAIL]`, `[BLOCKED]`), classification tags (`[READ-ONLY]`, `[STATE-CHANGING]`), test duration, and detailed diagnostic logs if any test requires attention.
