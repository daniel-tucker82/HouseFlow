create table if not exists terms_acceptances (
  user_id text not null references users(id) on delete cascade,
  version text not null check (version ~ '^\d{4}-\d{2}-\d{2}\.\d+$'),
  accepted_at timestamptz not null default clock_timestamp(),
  primary key (user_id,version)
);
