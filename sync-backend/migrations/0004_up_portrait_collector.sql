create table if not exists up_targets (
  mid text primary key,
  name text not null default '',
  seed_source text not null default '',
  seed_bvid text not null default '',
  note text not null default '',
  status text not null default 'pending',
  priority integer not null default 0,
  created_at text not null,
  updated_at text not null,
  last_collected_at text not null default '',
  next_collect_after text not null default '',
  last_error_type text not null default '',
  last_error_message text not null default '',
  failure_count integer not null default 0
);

create table if not exists up_profile_snapshots (
  id integer primary key autoincrement,
  mid text not null,
  name text not null default '',
  face text not null default '',
  sign text not null default '',
  level integer not null default 0,
  official_type integer not null default 0,
  official_title text not null default '',
  vip_type integer not null default 0,
  vip_status integer not null default 0,
  follower_count integer not null default 0,
  following_count integer not null default 0,
  archive_count integer not null default 0,
  article_count integer not null default 0,
  album_count integer not null default 0,
  favorite_count integer not null default 0,
  like_count integer not null default 0,
  card_json text not null default '{}',
  relation_json text not null default '{}',
  nav_json text not null default '{}',
  captured_at text not null
);

create table if not exists up_videos (
  bvid text primary key,
  aid text not null default '',
  mid text not null,
  title text not null default '',
  description text not null default '',
  cover_url text not null default '',
  tname text not null default '',
  tid integer not null default 0,
  duration integer not null default 0,
  pubdate integer not null default 0,
  published_at text not null default '',
  owner_name text not null default '',
  copyright integer not null default 0,
  videos integer not null default 0,
  view_count integer not null default 0,
  danmaku_count integer not null default 0,
  reply_count integer not null default 0,
  favorite_count integer not null default 0,
  coin_count integer not null default 0,
  share_count integer not null default 0,
  like_count integer not null default 0,
  tags_json text not null default '[]',
  pages_json text not null default '[]',
  raw_json text not null default '{}',
  first_seen_at text not null,
  last_seen_at text not null
);

create table if not exists video_metric_snapshots (
  id integer primary key autoincrement,
  bvid text not null,
  mid text not null,
  captured_at text not null,
  view_count integer not null default 0,
  danmaku_count integer not null default 0,
  reply_count integer not null default 0,
  favorite_count integer not null default 0,
  coin_count integer not null default 0,
  share_count integer not null default 0,
  like_count integer not null default 0
);

create table if not exists collector_runs (
  run_id text primary key,
  kind text not null default '',
  mid text not null default '',
  status text not null default 'pending',
  started_at text not null,
  finished_at text not null default '',
  target_count integer not null default 0,
  collected_count integer not null default 0,
  video_count integer not null default 0,
  error_type text not null default '',
  error_message text not null default '',
  options_json text not null default '{}'
);

create table if not exists up_portraits (
  mid text primary key,
  rule_json text not null default '{}',
  llm_json text not null default '{}',
  summary text not null default '',
  content_positioning text not null default '',
  audience_hypothesis text not null default '',
  content_style text not null default '',
  commercial_fit text not null default '',
  risks_json text not null default '[]',
  evidence_json text not null default '[]',
  provider text not null default '',
  model text not null default '',
  prompt_version text not null default '',
  generated_at text not null default '',
  llm_error_type text not null default '',
  llm_error_message text not null default '',
  updated_at text not null
);

create index if not exists idx_up_targets_status_next on up_targets(status, next_collect_after);
create index if not exists idx_up_targets_updated on up_targets(updated_at desc);
create index if not exists idx_up_profile_mid_captured on up_profile_snapshots(mid, captured_at desc);
create index if not exists idx_up_videos_mid_pubdate on up_videos(mid, pubdate desc);
create index if not exists idx_up_videos_title on up_videos(title);
create index if not exists idx_video_metric_bvid_captured on video_metric_snapshots(bvid, captured_at desc);
create index if not exists idx_collector_runs_started on collector_runs(started_at desc);
create index if not exists idx_up_portraits_updated on up_portraits(updated_at desc);

insert or ignore into schema_migrations (version, name, applied_at)
values (8, 'up_portrait_collector', datetime('now'));
