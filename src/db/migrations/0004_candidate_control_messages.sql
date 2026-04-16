create table if not exists sp_candidate_control_messages (
  id bigserial primary key,
  candidate_id bigint not null references sp_post_candidates(id) on delete cascade,
  telegram_message_id bigint not null,
  message_kind text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (telegram_message_id),
  constraint sp_candidate_control_messages_message_kind_check
    check (message_kind in ('draft', 'reminder', 'status', 'publish_failure'))
);

create index if not exists sp_candidate_control_messages_candidate_active_idx
  on sp_candidate_control_messages (candidate_id, is_active);