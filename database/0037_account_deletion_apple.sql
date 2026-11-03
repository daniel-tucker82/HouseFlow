-- Keep a non-identifying completion instruction after provider work and
-- encrypted temporary revocation credentials have been erased.
alter table account_deletion_requests add column if not exists apple_revocation_required boolean not null default false;
