create table if not exists report_totals (
  id integer primary key check (id = 1),
  batch_count integer not null default 0,
  event_count integer not null default 0,
  duplicate_event_count integer not null default 0,
  sample_count integer not null default 0,
  updated_at text not null
);

insert into report_totals (
  id,
  batch_count,
  event_count,
  duplicate_event_count,
  sample_count,
  updated_at
)
values (
  1,
  (select count(*) from batches),
  (select count(*) from events),
  (select coalesce(sum(duplicate_event_count), 0) from batches),
  (select count(*) from samples),
  datetime('now')
)
on conflict(id) do update set
  batch_count = excluded.batch_count,
  event_count = excluded.event_count,
  duplicate_event_count = excluded.duplicate_event_count,
  sample_count = excluded.sample_count,
  updated_at = excluded.updated_at;

insert or ignore into schema_migrations (version, name, applied_at)
values (7, 'report_totals', datetime('now'));
