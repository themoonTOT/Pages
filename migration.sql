-- ================================================================
-- Pages App — Supabase RLS Migration
-- Run this once in the Supabase SQL Editor (Project → SQL Editor).
-- It is fully idempotent: safe to run on a fresh project OR on an
-- existing project that already has a "notes" table.
-- ================================================================


-- ────────────────────────────────────────────────────────────────
-- 1.  TABLES
-- ────────────────────────────────────────────────────────────────

-- 1a. profiles  (one row per auth user, auto-created by trigger)
CREATE TABLE IF NOT EXISTS public.profiles (
  id          uuid         PRIMARY KEY
                           REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

-- 1b. notes  (may already exist — the CREATE is skipped if so)
CREATE TABLE IF NOT EXISTS public.notes (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid         REFERENCES auth.users(id) ON DELETE CASCADE,
  title       text,
  content     text,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

-- 1c. Add user_id column to notes if the table pre-existed without it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
    AND    table_name   = 'notes'
    AND    column_name  = 'user_id'
  ) THEN
    ALTER TABLE public.notes
      ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END;
$$;

-- 1d. Make user_id NOT NULL now that the column exists
--     (only safe if all existing rows already have a value;
--      if you still have legacy rows with NULL user_id, skip this
--      or backfill them first — see the README.)
-- ALTER TABLE public.notes ALTER COLUMN user_id SET NOT NULL;
-- ^ Uncomment ONLY after backfilling or after wiping legacy rows.


-- ────────────────────────────────────────────────────────────────
-- 2.  INDEXES
-- ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS notes_user_id_idx
  ON public.notes (user_id);

CREATE INDEX IF NOT EXISTS notes_updated_at_idx
  ON public.notes (updated_at DESC);


-- ────────────────────────────────────────────────────────────────
-- 3.  ENABLE ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes    ENABLE ROW LEVEL SECURITY;


-- ────────────────────────────────────────────────────────────────
-- 4.  POLICIES — profiles
--     Least-privilege: own row only. No public reads, no deletes.
-- ────────────────────────────────────────────────────────────────

-- Drop first so this file stays idempotent
DROP POLICY IF EXISTS "profiles: select own"  ON public.profiles;
DROP POLICY IF EXISTS "profiles: insert own"  ON public.profiles;
DROP POLICY IF EXISTS "profiles: update own"  ON public.profiles;

CREATE POLICY "profiles: select own"
  ON public.profiles
  FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "profiles: insert own"
  ON public.profiles
  FOR INSERT
  WITH CHECK (id = auth.uid());
  -- Note: the handle_new_user trigger runs SECURITY DEFINER and
  -- therefore bypasses RLS, so signup always succeeds regardless.

CREATE POLICY "profiles: update own"
  ON public.profiles
  FOR UPDATE
  USING     (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- No DELETE policy = no client can delete a profile row via the API.


-- ────────────────────────────────────────────────────────────────
-- 5.  POLICIES — notes
--     Four explicit policies, one per operation. user_id gating on
--     every path (no wildcard "authenticated can do all").
-- ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "notes: select own"  ON public.notes;
DROP POLICY IF EXISTS "notes: insert own"  ON public.notes;
DROP POLICY IF EXISTS "notes: update own"  ON public.notes;
DROP POLICY IF EXISTS "notes: delete own"  ON public.notes;

CREATE POLICY "notes: select own"
  ON public.notes
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "notes: insert own"
  ON public.notes
  FOR INSERT
  WITH CHECK (user_id = auth.uid());
  -- The app must send user_id in the INSERT body.
  -- RLS rejects rows where user_id ≠ caller's uid.

CREATE POLICY "notes: update own"
  ON public.notes
  FOR UPDATE
  USING     (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "notes: delete own"
  ON public.notes
  FOR DELETE
  USING (user_id = auth.uid());


-- ────────────────────────────────────────────────────────────────
-- 6.  FUNCTION + TRIGGER: auto-create profile on signup
-- ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER          -- runs as function owner, not the new user
  SET search_path = public  -- prevents search_path injection
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    new.id,
    new.email,
    COALESCE(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;   -- idempotent: no error on duplicate
  RETURN new;
END;
$$;

-- Re-create the trigger so repeated runs don't duplicate it
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user();


-- ────────────────────────────────────────────────────────────────
-- 7.  FUNCTION + TRIGGER: auto-stamp updated_at on notes
-- ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_set_updated_at ON public.notes;

CREATE TRIGGER notes_set_updated_at
  BEFORE UPDATE ON public.notes
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at();


-- ────────────────────────────────────────────────────────────────
-- 8.  BACKFILL: create profiles for users who signed up before
--     this migration (trigger only fires for new inserts).
-- ────────────────────────────────────────────────────────────────

INSERT INTO public.profiles (id, email, full_name, avatar_url)
SELECT
  id,
  email,
  COALESCE(
    raw_user_meta_data ->> 'full_name',
    raw_user_meta_data ->> 'name'
  ),
  raw_user_meta_data ->> 'avatar_url'
FROM auth.users
ON CONFLICT (id) DO NOTHING;


-- ────────────────────────────────────────────────────────────────
-- DONE.
-- Verify with:
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public';
--
--   SELECT schemaname, tablename, policyname, cmd, qual
--   FROM pg_policies
--   WHERE schemaname = 'public'
--   ORDER BY tablename, cmd;
-- ────────────────────────────────────────────────────────────────
