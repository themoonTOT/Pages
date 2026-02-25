# Pages — Supabase RLS Setup

## What the migration does

| Step | Object | Detail |
|------|--------|--------|
| Create | `public.profiles` | One row per auth user; auto-populated on signup |
| Alter  | `public.notes`    | Adds `user_id uuid` column (idempotent) |
| Index  | `notes.user_id`, `notes.updated_at` | Query performance |
| Enable RLS | Both tables | Denies all access by default |
| Policies | `profiles` (3), `notes` (4) | Strict per-user access only |
| Trigger | `on_auth_user_created` | Inserts profile row on every signup |
| Trigger | `notes_set_updated_at` | Stamps `updated_at = now()` on every update |
| Backfill | `public.profiles` | Populates profiles for users who already exist |

---

## How to apply

1. Open your Supabase project → **SQL Editor** (left sidebar).
2. Click **New query**.
3. Paste the full contents of `migration.sql`.
4. Click **Run** (or `Ctrl/Cmd + Enter`).
5. You should see `Success. No rows returned` at the bottom.

### Verify it worked

Run this in the SQL Editor to confirm RLS is enabled and all 7 policies exist:

```sql
-- Tables with RLS enabled
SELECT tablename, rowsecurity
FROM   pg_tables
WHERE  schemaname = 'public'
ORDER  BY tablename;

-- All policies
SELECT tablename, policyname, cmd, qual, with_check
FROM   pg_policies
WHERE  schemaname = 'public'
ORDER  BY tablename, cmd;
```

Expected: `profiles` and `notes` both show `rowsecurity = true`.
Expected policies:

| table    | name                  | cmd    |
|----------|-----------------------|--------|
| notes    | notes: delete own     | DELETE |
| notes    | notes: insert own     | INSERT |
| notes    | notes: select own     | SELECT |
| notes    | notes: update own     | UPDATE |
| profiles | profiles: insert own  | INSERT |
| profiles | profiles: select own  | SELECT |
| profiles | profiles: update own  | UPDATE |

---

## Handling legacy notes (pre-RLS rows)

If your `notes` table already had rows **before** `user_id` was added, those
rows have `user_id = NULL`. With RLS enabled, `NULL ≠ auth.uid()`, so those
rows become invisible to all users via the API — which is the safe default.

**Option A — Wipe and start fresh (recommended for dev):**
```sql
TRUNCATE public.notes;
```

**Option B — Assign orphaned rows to a specific user:**
```sql
UPDATE public.notes
SET    user_id = '<paste-user-uuid-here>'
WHERE  user_id IS NULL;
```
Find a user's UUID in Supabase: **Authentication → Users → copy ID**.

**Option C — Make user_id truly NOT NULL** (after Option A or B):
```sql
ALTER TABLE public.notes ALTER COLUMN user_id SET NOT NULL;
```
This line is commented out in `migration.sql`; uncomment and re-run after
all rows have a `user_id`.

---

## Testing multi-user isolation

### Automated check (SQL Editor, run as postgres)

```sql
-- Confirm no policy leaks: set a fake uid and try to select another user's notes
SET LOCAL role = authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';

SELECT count(*) AS should_be_zero
FROM   public.notes
WHERE  user_id != '00000000-0000-0000-0000-000000000001';
-- Must return 0
```

### Manual browser test (two private windows)

1. **Window A** — Sign up / sign in as `user_a@example.com`.
   Create 3 notes. Note their content.

2. **Window B** — Open an incognito window. Sign up / sign in as `user_b@example.com`.
   Verify: the sidebar shows 0 notes from Window A.
   Create 2 notes. Verify they appear only in Window B.

3. Back in **Window A** — Verify User A's notes are still there and User B's notes don't appear.

4. **Attempt cross-user API call** (DevTools console in Window B):
   ```js
   // Try to fetch a note ID you know belongs to User A
   fetch('https://kihxztxxpfwmhltangih.supabase.co/rest/v1/notes?id=eq.<USER_A_NOTE_ID>&select=*', {
     headers: {
       apikey: 'sb_publishable_fPkLRpscUpvTP7h-ogA9yA_uOnD4xVH',
       Authorization: 'Bearer ' + (await (await supabase.auth.getSession()).data.session.access_token)
     }
   }).then(r => r.json()).then(console.log);
   // Expected: [] (empty array — RLS blocks the read)
   ```

5. **Logout test** — Sign out in Window A. Verify the app redirects to `login.html`
   and that `index.html` is inaccessible without a valid session.

---

## Security notes

| Concern | How it's addressed |
|---------|-------------------|
| Service-role key exposure | Never used client-side; app uses only anon key |
| JWT used for DB auth | `SB_HEADERS.Authorization` is set to `Bearer <user_jwt>` after login |
| Anon key still sent as `apikey` | Required by PostgREST; harmless — RLS enforces access |
| User can't fake `user_id` | `WITH CHECK (user_id = auth.uid())` prevents inserting with another user's id |
| User can't read/edit other users' notes | `USING (user_id = auth.uid())` on SELECT/UPDATE/DELETE |
| No service-role bypass | All client requests go through RLS; no anon-key SELECT bypass |
