drop index if exists idx_d1_events_up_name_captured_at;

insert or ignore into schema_migrations (version, name, applied_at)
values (6, 'drop_events_up_name_index', datetime('now'));
