-- PUB GURU V1
-- Remove recursive owner-wide membership SELECT policy.
-- V1 only needs users to read their own membership; owner team administration will use a dedicated secure workflow later.

drop policy if exists memberships_read_owner on public.memberships;
