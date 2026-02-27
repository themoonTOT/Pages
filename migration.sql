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
-- 9.  user_profile_settings
--     One row per user. Stores writing identity + AI preferences.
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_profile_settings (
  user_id               uuid         PRIMARY KEY
                                     REFERENCES auth.users(id) ON DELETE CASCADE,
  tone                  text         NOT NULL DEFAULT 'Professional',
  languages             text[]       NOT NULL DEFAULT ARRAY['en'],
  audience              text         NOT NULL DEFAULT '',
  intent                text         NOT NULL DEFAULT 'Explain',
  style_notes           text         NOT NULL DEFAULT '',
  use_notes_as_context  boolean      NOT NULL DEFAULT false,
  updated_at            timestamptz  NOT NULL DEFAULT now()
);

ALTER TABLE public.user_profile_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_profile_settings: select own" ON public.user_profile_settings;
DROP POLICY IF EXISTS "user_profile_settings: insert own" ON public.user_profile_settings;
DROP POLICY IF EXISTS "user_profile_settings: update own" ON public.user_profile_settings;

CREATE POLICY "user_profile_settings: select own"
  ON public.user_profile_settings
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "user_profile_settings: insert own"
  ON public.user_profile_settings
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_profile_settings: update own"
  ON public.user_profile_settings
  FOR UPDATE
  USING     (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ────────────────────────────────────────────────────────────────
-- 10. user_connected_sources
--     Tracks which external sources each user has connected.
--     source_type: 'drive' | 'substack' | 'x' | 'upload'
--     status:      'connected' | 'pending'
--     metadata:    arbitrary JSON (filename, size, etc. for uploads)
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_connected_sources (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_type   text         NOT NULL,
  status        text         NOT NULL DEFAULT 'pending',
  metadata      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at  timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_connected_sources_user_id_idx
  ON public.user_connected_sources (user_id);

ALTER TABLE public.user_connected_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_connected_sources: select own" ON public.user_connected_sources;
DROP POLICY IF EXISTS "user_connected_sources: insert own" ON public.user_connected_sources;
DROP POLICY IF EXISTS "user_connected_sources: update own" ON public.user_connected_sources;
DROP POLICY IF EXISTS "user_connected_sources: delete own" ON public.user_connected_sources;

CREATE POLICY "user_connected_sources: select own"
  ON public.user_connected_sources
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "user_connected_sources: insert own"
  ON public.user_connected_sources
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_connected_sources: update own"
  ON public.user_connected_sources
  FOR UPDATE
  USING     (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_connected_sources: delete own"
  ON public.user_connected_sources
  FOR DELETE
  USING (user_id = auth.uid());


-- ────────────────────────────────────────────────────────────────
-- 11. Unique index on user_connected_sources for non-upload types
--     One Google Drive / one Substack / one X per user.
--     Uploads remain unlimited (partial index WHERE source_type != 'upload').
-- ────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS user_connected_sources_unique_type_idx
  ON public.user_connected_sources (user_id, source_type)
  WHERE source_type != 'upload';


-- ────────────────────────────────────────────────────────────────
-- 12. user_content_items
--     Pre-indexing store for all imported content.
--     Shared schema: Substack posts, Drive files, tweets, uploads.
--     The future AI indexing pipeline reads from this table.
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_content_items (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_id     uuid         REFERENCES public.user_connected_sources(id) ON DELETE CASCADE,
  source_type   text         NOT NULL,
  title         text,
  url           text,
  guid          text,
  excerpt       text,
  published_at  timestamptz,
  metadata      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_content_items_user_id_idx
  ON public.user_content_items (user_id);

CREATE INDEX IF NOT EXISTS user_content_items_source_id_idx
  ON public.user_content_items (source_id);

-- Deduplication on re-sync: same item from same source is skipped
CREATE UNIQUE INDEX IF NOT EXISTS user_content_items_dedup_idx
  ON public.user_content_items (user_id, source_type, guid)
  WHERE guid IS NOT NULL;

ALTER TABLE public.user_content_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_content_items: select own" ON public.user_content_items;
DROP POLICY IF EXISTS "user_content_items: insert own" ON public.user_content_items;
DROP POLICY IF EXISTS "user_content_items: delete own" ON public.user_content_items;

CREATE POLICY "user_content_items: select own"
  ON public.user_content_items
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "user_content_items: insert own"
  ON public.user_content_items
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_content_items: delete own"
  ON public.user_content_items
  FOR DELETE
  USING (user_id = auth.uid());


-- ────────────────────────────────────────────────────────────────
-- 13. voice_samples
--     Raw writing samples the user submits to build their DNA.
--     source: 'paste' | 'upload' | 'substack' | 'gdrive' | 'x' | 'notion'
--     content is capped at 25 000 chars application-side.
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.voice_samples (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source      text         NOT NULL DEFAULT 'paste',
  title       text         NOT NULL DEFAULT '',
  content     text         NOT NULL DEFAULT '',
  file_url    text,
  word_count  integer      NOT NULL DEFAULT 0,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_samples_user_id_idx
  ON public.voice_samples (user_id);

ALTER TABLE public.voice_samples ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "voice_samples: select own" ON public.voice_samples;
DROP POLICY IF EXISTS "voice_samples: insert own" ON public.voice_samples;
DROP POLICY IF EXISTS "voice_samples: delete own" ON public.voice_samples;

CREATE POLICY "voice_samples: select own"
  ON public.voice_samples
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "voice_samples: insert own"
  ON public.voice_samples
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "voice_samples: delete own"
  ON public.voice_samples
  FOR DELETE
  USING (user_id = auth.uid());


-- ────────────────────────────────────────────────────────────────
-- 14. voice_profile
--     One row per user. AI-generated voice fingerprint.
--     summary:      {chips:[{label,value}]}
--     sliders:      {formal:50, concise:50, opinionated:50}
--     learned_text: 2-3 sentence plain-text description.
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.voice_profile (
  user_id       uuid         PRIMARY KEY
                             REFERENCES auth.users(id) ON DELETE CASCADE,
  summary       jsonb        NOT NULL DEFAULT '{}'::jsonb,
  learned_text  text         NOT NULL DEFAULT '',
  sliders       jsonb        NOT NULL DEFAULT '{"formal":50,"concise":50,"opinionated":50}'::jsonb,
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

ALTER TABLE public.voice_profile ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "voice_profile: select own" ON public.voice_profile;
DROP POLICY IF EXISTS "voice_profile: insert own" ON public.voice_profile;
DROP POLICY IF EXISTS "voice_profile: update own" ON public.voice_profile;

CREATE POLICY "voice_profile: select own"
  ON public.voice_profile
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "voice_profile: insert own"
  ON public.voice_profile
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "voice_profile: update own"
  ON public.voice_profile
  FOR UPDATE
  USING     (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Auto-stamp updated_at on voice_profile
DROP TRIGGER IF EXISTS voice_profile_set_updated_at ON public.voice_profile;

CREATE TRIGGER voice_profile_set_updated_at
  BEFORE UPDATE ON public.voice_profile
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at();


-- ────────────────────────────────────────────────────────────────
-- 15. generation columns on notes
--     source_url        — the article URL the draft was generated from
--     destination       — linkedin | substack | x | company
--     generation_status — idle | generating | ready | error
--     generation_error  — error message if status = 'error'
-- ────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'source_url'
  ) THEN
    ALTER TABLE public.notes ADD COLUMN source_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'destination'
  ) THEN
    ALTER TABLE public.notes ADD COLUMN destination text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'generation_status'
  ) THEN
    ALTER TABLE public.notes
      ADD COLUMN generation_status text NOT NULL DEFAULT 'idle';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'generation_error'
  ) THEN
    ALTER TABLE public.notes ADD COLUMN generation_error text;
  END IF;
END;
$$;


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
