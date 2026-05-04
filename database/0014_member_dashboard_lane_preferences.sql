-- Per-user saved member dashboard lane visibility and editability (managers / supervisors).
create table if not exists member_dashboard_lane_preferences (
  user_id text not null references users (id) on delete cascade,
  household_id uuid not null references households (id) on delete cascade,
  visible_member_ids text[] not null,
  editable_member_ids text[] not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, household_id)
);

create index if not exists member_dashboard_lane_preferences_household_idx
  on member_dashboard_lane_preferences (household_id);
