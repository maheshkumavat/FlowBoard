-- ==============================================================================
-- FLOWBOARD MIGRATION 002: IDEMPOTENT SCHEMA FIXES & COLUMN ADDITIONS
-- Run this in the Supabase SQL Editor for your project
-- ==============================================================================

-- 1. Profiles Table: Add missing columns used by /api/auth/me and account status
alter table public.profiles add column if not exists status text default 'active';
alter table public.profiles add column if not exists notification_preferences jsonb default '{"taskAssigned": true, "joinRequests": true, "comments": true}'::jsonb;

-- 2. Tasks Table: Add start_date for timeline / gantt views
alter table public.tasks add column if not exists start_date timestamptz;

-- 3. Notifications Table: Add title & message columns and ensure text column is flexible
alter table public.notifications add column if not exists title text;
alter table public.notifications add column if not exists message text;
alter table public.notifications alter column text drop not null;
alter table public.notifications alter column text set default '';

-- 4. Supabase Realtime Publication: Ensure publication exists and tables are added idempotently
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare
  tbl text;
  realtime_tables text[] := array['tasks', 'comments', 'activity_log', 'project_messages', 'notifications', 'join_requests'];
begin
  foreach tbl in array realtime_tables loop
    if not exists (
      select 1
      from pg_publication_rel pr
      join pg_class c on pr.prrelid = c.oid
      join pg_publication p on pr.prpubid = p.oid
      join pg_namespace n on c.relnamespace = n.oid
      where p.pubname = 'supabase_realtime'
        and c.relname = tbl
        and n.nspname = 'public'
    ) then
      execute format('alter publication supabase_realtime add table public.%I', tbl);
    end if;
  end loop;
end $$;
