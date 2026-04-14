alter table sp_candidate_sources
  add column id bigserial;

alter table sp_candidate_sources
  drop constraint sp_candidate_sources_pkey;

alter table sp_candidate_sources
  alter column artifact_id drop not null;

alter table sp_candidate_sources
  add constraint sp_candidate_sources_pkey primary key (id);

create unique index sp_candidate_sources_event_only_unique
  on sp_candidate_sources (candidate_id, event_id)
  where artifact_id is null;

create unique index sp_candidate_sources_artifact_unique
  on sp_candidate_sources (candidate_id, event_id, artifact_id)
  where artifact_id is not null;
