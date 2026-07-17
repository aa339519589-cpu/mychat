-- Canonical pre-migration compatibility shape.
--
-- schema.sql contains the original legacy artifacts table. The first artifact
-- migration creates the current table only when it is absent, then immediately
-- builds a project index. Existing installations therefore need this nullable
-- relationship before the sealed migration history can be replayed. Later
-- migrations still own message_id, raw, updated_at, backfill, and constraints.
alter table public.artifacts
  add column if not exists project_id uuid
  references public.projects(id) on delete set null;
