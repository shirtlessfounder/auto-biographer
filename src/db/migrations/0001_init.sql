create table if not exists sp_events (
  id bigserial primary key,
  source text not null,
  source_id text not null,
  occurred_at timestamptz not null,
  author text,
  url_or_locator text,
  title text,
  summary text,
  raw_text text,
  tags jsonb not null default '[]'::jsonb,
  artifact_refs jsonb not null default '[]'::jsonb,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_id)
);

create table if not exists sp_artifacts (
  id bigserial primary key,
  event_id bigint not null references sp_events(id) on delete cascade,
  artifact_type text not null,
  artifact_key text not null,
  content_text text,
  content_json jsonb,
  source_url text,
  created_at timestamptz not null default now(),
  unique (event_id, artifact_type, artifact_key)
);

create table if not exists sp_post_candidates (
  id bigserial primary key,
  trigger_type text not null,
  candidate_type text not null,
  status text not null,
  deadline_at timestamptz,
  reminder_sent_at timestamptz,
  selector_output_json jsonb,
  drafter_output_json jsonb,
  final_post_text text,
  quote_target_url text,
  media_request text,
  degraded boolean not null default false,
  error_details text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sp_candidate_sources (
  candidate_id bigint not null references sp_post_candidates(id) on delete cascade,
  event_id bigint not null references sp_events(id) on delete cascade,
  artifact_id bigint references sp_artifacts(id) on delete cascade,
  primary key (candidate_id, event_id, artifact_id)
);

create table if not exists sp_published_posts (
  id bigserial primary key,
  candidate_id bigint not null references sp_post_candidates(id) on delete restrict,
  posted_at timestamptz not null,
  x_post_id text,
  post_type text not null,
  final_text text not null,
  quote_target_url text,
  media_attached boolean not null default false,
  publisher_response jsonb,
  created_at timestamptz not null default now()
);

create table if not exists sp_telegram_actions (
  id bigserial primary key,
  candidate_id bigint not null references sp_post_candidates(id) on delete cascade,
  telegram_update_id bigint not null,
  action text not null,
  payload text,
  created_at timestamptz not null default now(),
  unique (telegram_update_id)
);

create table if not exists sp_source_usage (
  id bigserial primary key,
  event_id bigint not null references sp_events(id) on delete cascade,
  artifact_id bigint references sp_artifacts(id) on delete cascade,
  published_post_id bigint not null references sp_published_posts(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists sp_runtime_state (
  state_key text primary key,
  state_json jsonb not null,
  updated_at timestamptz not null default now()
);
