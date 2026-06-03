create table if not exists config_store (
  id integer primary key check (id = 1),
  json text not null
);

create table if not exists schema_migrations (
  version integer primary key,
  name text not null,
  applied_at text not null
);

create table if not exists batches (
  batch_id text primary key,
  client_id text not null,
  captured_at text not null,
  received_at text not null,
  event_count integer not null,
  duplicate_event_count integer not null default 0,
  raw_json text not null
);

create table if not exists events (
  event_id text primary key,
  batch_id text not null,
  client_id text not null,
  sample_id text,
  captured_at text not null,
  received_at text not null,
  event_kind text not null default 'impression',
  mode text not null default '',
  source text not null default '',
  category text not null default '',
  feedback text not null default '',
  position integer not null default 0,
  bvid text not null default '',
  up_name text not null default '',
  up_mid text not null default '',
  raw_json text not null
);

create table if not exists samples (
  sample_id text primary key,
  bvid text not null default '',
  title text not null default '',
  up_name text not null default '',
  up_mid text not null default '',
  category text not null default '',
  first_seen_at text not null default '',
  last_seen_at text not null,
  seen_count integer not null,
  click_count integer not null default 0,
  feedback text not null default 'unset',
  last_clicked_at text not null default '',
  feedback_updated_at text not null default '',
  json text not null
);

create table if not exists daily_metrics (
  date text not null,
  client_id text not null default '',
  mode text not null default '',
  source text not null default '',
  category text not null default '',
  impressions integer not null default 0,
  clicks integer not null default 0,
  feedbacks integer not null default 0,
  negative_feedbacks integer not null default 0,
  primary key (date, client_id, mode, source, category)
);

create index if not exists idx_d1_batches_received_at on batches(received_at desc);
create index if not exists idx_d1_events_captured_at on events(captured_at);
create index if not exists idx_d1_events_kind_captured_at on events(event_kind, captured_at);
create index if not exists idx_d1_events_mode_captured_at on events(mode, captured_at);
create index if not exists idx_d1_events_source_captured_at on events(source, captured_at);
create index if not exists idx_d1_events_category_captured_at on events(category, captured_at);
create index if not exists idx_d1_events_client_captured_at on events(client_id, captured_at);
create index if not exists idx_d1_events_feedback_captured_at on events(feedback, captured_at);
create index if not exists idx_d1_events_sample_captured_at on events(sample_id, captured_at);
create index if not exists idx_d1_events_sample_kind_captured_at on events(sample_id, event_kind, captured_at);
create index if not exists idx_d1_events_up_mid_captured_at on events(up_mid, captured_at);
create index if not exists idx_d1_events_up_name_captured_at on events(up_name, captured_at);
create index if not exists idx_d1_samples_last_seen_at on samples(last_seen_at desc);
create index if not exists idx_d1_samples_first_seen_at on samples(first_seen_at);
create index if not exists idx_d1_samples_up_mid on samples(up_mid);
create index if not exists idx_d1_samples_category on samples(category);
create index if not exists idx_d1_samples_seen_count on samples(seen_count desc);
create index if not exists idx_d1_samples_click_count on samples(click_count desc);
create index if not exists idx_d1_samples_feedback on samples(feedback);
create index if not exists idx_d1_daily_metrics_date on daily_metrics(date desc);

insert or ignore into schema_migrations (version, name, applied_at) values
  (1, 'base_tables', datetime('now')),
  (2, 'structured_event_columns', datetime('now')),
  (3, 'sample_timestamps', datetime('now')),
  (4, 'daily_metrics', datetime('now')),
  (5, 'analytics_indexes', datetime('now'));
