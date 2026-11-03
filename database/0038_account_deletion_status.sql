-- A client saves a random 256-bit read-only recovery key before submitting
-- deletion. Store only its hash, independently of the identity being erased.
alter table account_deletion_requests add column if not exists recovery_key_hash text
  check (recovery_key_hash is null or recovery_key_hash ~ '^[a-f0-9]{64}$');
