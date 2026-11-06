-- Private support inbox. It has no household-member read endpoint. A household
-- deletion must not silently erase an unresolved concern. Account deletion does
-- remove reports authored by that account; other household data is not copied.
create table if not exists safety_reports (
  id uuid primary key,
  reporter_id text not null references users(id) on delete cascade,
  household_id uuid not null,
  kind text not null check (kind in ('content','member','other')),
  subject text check (char_length(subject) between 2 and 200),
  message text check (char_length(message) between 10 and 2000),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  state text not null default 'received' check (state in ('received','reviewing','resolved')),
  received_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  resolved_at timestamptz,
  redacted_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  resolution_note text check (char_length(resolution_note) <= 2000),
  check ((subject is not null and message is not null and redacted_at is null)
    or (subject is null and message is null and redacted_at is not null and state='resolved'))
);
create index if not exists safety_reports_inbox on safety_reports(state,received_at,id);
create index if not exists safety_reports_reporter on safety_reports(reporter_id,received_at);

-- A private operational audit, never returned to household members. No copy of
-- report text in the audit: text redaction must also remove resolution details.
create table if not exists safety_report_reviews (
  report_id uuid not null references safety_reports(id) on delete cascade,
  revision integer not null,
  reviewer text not null check (char_length(reviewer) between 2 and 200),
  action text not null check (action in ('reviewing','resolved','redacted')),
  changed_at timestamptz not null default clock_timestamp(),
  primary key (report_id,revision)
);
