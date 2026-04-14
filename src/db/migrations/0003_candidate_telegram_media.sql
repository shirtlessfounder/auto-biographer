alter table sp_post_candidates
  add column telegram_message_id bigint;

alter table sp_post_candidates
  add column media_batch_json jsonb;

create unique index sp_post_candidates_telegram_message_id_unique
  on sp_post_candidates (telegram_message_id)
  where telegram_message_id is not null;
