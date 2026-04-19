alter table sp_post_candidates
  add column publish_at timestamptz;

create index sp_post_candidates_publish_at_idx
  on sp_post_candidates (publish_at)
  where publish_at is not null
    and status in ('pending_approval', 'reminded', 'held', 'post_requested');
