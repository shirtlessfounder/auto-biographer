import { describe, expect, it, vi } from 'vitest';

import type { UpsertedNormalizedEvent } from '../../../src/normalization/upsert-events';
import { createGitHubSource } from '../../../src/sources/github-source';

describe('createGitHubSource', () => {
  it('reads authenticated activity through gh api and maps supported events into github records', async () => {
    const db = {} as never;
    const persisted: UpsertedNormalizedEvent[] = [];
    const executor = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'github.com\n  Logged in to github.com account shirtlessfounder\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 'evt_push',
            type: 'PushEvent',
            actor: {
              login: 'shirtlessfounder',
              display_login: 'shirtlessfounder',
            },
            repo: {
              name: 'dylanvu/auto-biographer',
            },
            created_at: '2026-04-14T14:00:00.000Z',
            payload: {
              ref: 'refs/heads/main',
              before: '1111111111111111111111111111111111111111',
              head: '2222222222222222222222222222222222222222',
              commits: [
                {
                  sha: '2222222222222222222222222222222222222222',
                  message: 'Add GitHub source adapter',
                },
                {
                  sha: '3333333333333333333333333333333333333333',
                  message: 'Cover gh auth failures',
                },
              ],
            },
          },
          {
            id: 'evt_pr_opened',
            type: 'PullRequestEvent',
            actor: {
              login: 'shirtlessfounder',
            },
            repo: {
              name: 'dylanvu/auto-biographer',
            },
            created_at: '2026-04-14T15:00:00.000Z',
            payload: {
              action: 'opened',
              pull_request: {
                number: 42,
                title: 'Add GitHub source adapter',
                html_url: 'https://github.com/dylanvu/auto-biographer/pull/42',
                merged: false,
              },
            },
          },
          {
            id: 'evt_pr_merged',
            type: 'PullRequestEvent',
            actor: {
              login: 'shirtlessfounder',
            },
            repo: {
              name: 'dylanvu/auto-biographer',
            },
            created_at: '2026-04-14T16:00:00.000Z',
            payload: {
              action: 'closed',
              pull_request: {
                number: 42,
                title: 'Add GitHub source adapter',
                html_url: 'https://github.com/dylanvu/auto-biographer/pull/42',
                merged: true,
              },
            },
          },
          {
            id: 'evt_pr_updated',
            type: 'PullRequestEvent',
            actor: {
              login: 'shirtlessfounder',
            },
            repo: {
              name: 'dylanvu/auto-biographer',
            },
            created_at: '2026-04-14T17:00:00.000Z',
            payload: {
              action: 'synchronize',
              pull_request: {
                number: 42,
                title: 'Add GitHub source adapter',
                html_url: 'https://github.com/dylanvu/auto-biographer/pull/42',
                merged: false,
              },
            },
          },
          {
            id: 'evt_star',
            type: 'WatchEvent',
            actor: {
              login: 'shirtlessfounder',
            },
            repo: {
              name: 'openai/openai-node',
            },
            created_at: '2026-04-14T18:00:00.000Z',
            payload: {
              action: 'started',
            },
          },
          {
            id: 'evt_repo_created',
            type: 'CreateEvent',
            actor: {
              login: 'shirtlessfounder',
            },
            repo: {
              name: 'handsdiff/activeclaw',
            },
            created_at: '2026-04-14T18:30:00.000Z',
            payload: {
              ref_type: 'repository',
              ref: null,
            },
          },
          {
            id: 'evt_branch_created',
            type: 'CreateEvent',
            actor: {
              login: 'shirtlessfounder',
            },
            repo: {
              name: 'handsdiff/activeclaw',
            },
            created_at: '2026-04-14T18:45:00.000Z',
            payload: {
              ref_type: 'branch',
              ref: 'feat/agent-twitter-selector',
            },
          },
          {
            id: 'evt_ignored',
            type: 'IssuesEvent',
            actor: {
              login: 'shirtlessfounder',
            },
            repo: {
              name: 'dylanvu/auto-biographer',
            },
            created_at: '2026-04-14T19:00:00.000Z',
            payload: {
              action: 'opened',
            },
          },
        ]),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            full_name: 'handsdiff/activeclaw',
            html_url: 'https://github.com/handsdiff/activeclaw',
            created_at: '2026-04-14T18:30:00.000Z',
            description: 'Agent-native coding environment',
            private: false,
          },
        ]),
        stderr: '',
      });
    const upsert = vi.fn().mockResolvedValue(persisted);

    const source = createGitHubSource(db, {
      githubUsername: 'shirtlessfounder',
      executor,
      upsertEvents: upsert,
    });

    await expect(source.sync()).resolves.toBe(persisted);

    expect(executor).toHaveBeenCalledTimes(3);
    expect(executor).toHaveBeenNthCalledWith(1, 'gh', ['auth', 'status']);
    expect(executor).toHaveBeenNthCalledWith(2, 'gh', [
      'api',
      '/users/shirtlessfounder/events?per_page=100',
      '--header',
      'Accept: application/vnd.github+json',
    ]);
    expect(executor).toHaveBeenNthCalledWith(3, 'gh', [
      'api',
      '/user/repos?visibility=all&affiliation=owner&sort=created&per_page=100',
      '--header',
      'Accept: application/vnd.github+json',
    ]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(db, [
      {
        source: 'github',
        sourceId: 'evt_push',
        occurredAt: new Date('2026-04-14T14:00:00.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/dylanvu/auto-biographer/commit/2222222222222222222222222222222222222222',
        title: 'dylanvu/auto-biographer push',
        summary: 'Pushed 2 commits to main in dylanvu/auto-biographer: Add GitHub source adapter; Cover gh auth failures',
        rawText: 'Add GitHub source adapter\nCover gh auth failures',
        tags: ['repo:dylanvu/auto-biographer', 'action:push', 'branch:main'],
        rawPayload: expect.objectContaining({
          repo: 'dylanvu/auto-biographer',
          action: 'push',
          url: 'https://github.com/dylanvu/auto-biographer/commit/2222222222222222222222222222222222222222',
          summary: 'Pushed 2 commits to main in dylanvu/auto-biographer: Add GitHub source adapter; Cover gh auth failures',
        }),
      },
      {
        source: 'github',
        sourceId: 'evt_pr_opened',
        occurredAt: new Date('2026-04-14T15:00:00.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/dylanvu/auto-biographer/pull/42',
        title: 'Add GitHub source adapter',
        summary: 'Opened PR #42 in dylanvu/auto-biographer: Add GitHub source adapter',
        rawText: 'Add GitHub source adapter',
        tags: ['repo:dylanvu/auto-biographer', 'action:pr_opened'],
        rawPayload: expect.objectContaining({
          repo: 'dylanvu/auto-biographer',
          action: 'pr_opened',
          url: 'https://github.com/dylanvu/auto-biographer/pull/42',
        }),
      },
      {
        source: 'github',
        sourceId: 'evt_pr_merged',
        occurredAt: new Date('2026-04-14T16:00:00.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/dylanvu/auto-biographer/pull/42',
        title: 'Add GitHub source adapter',
        summary: 'Merged PR #42 in dylanvu/auto-biographer: Add GitHub source adapter',
        rawText: 'Add GitHub source adapter',
        tags: ['repo:dylanvu/auto-biographer', 'action:pr_merged'],
        rawPayload: expect.objectContaining({
          repo: 'dylanvu/auto-biographer',
          action: 'pr_merged',
          url: 'https://github.com/dylanvu/auto-biographer/pull/42',
        }),
      },
      {
        source: 'github',
        sourceId: 'evt_pr_updated',
        occurredAt: new Date('2026-04-14T17:00:00.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/dylanvu/auto-biographer/pull/42',
        title: 'Add GitHub source adapter',
        summary: 'Updated PR #42 in dylanvu/auto-biographer: Add GitHub source adapter',
        rawText: 'Add GitHub source adapter',
        tags: ['repo:dylanvu/auto-biographer', 'action:pr_updated'],
        rawPayload: expect.objectContaining({
          repo: 'dylanvu/auto-biographer',
          action: 'pr_updated',
          url: 'https://github.com/dylanvu/auto-biographer/pull/42',
        }),
      },
      {
        source: 'github',
        sourceId: 'evt_star',
        occurredAt: new Date('2026-04-14T18:00:00.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/openai/openai-node',
        title: 'openai/openai-node star',
        summary: 'Starred openai/openai-node',
        rawText: 'Starred openai/openai-node',
        tags: ['repo:openai/openai-node', 'action:starred'],
        rawPayload: expect.objectContaining({
          repo: 'openai/openai-node',
          action: 'starred',
          url: 'https://github.com/openai/openai-node',
        }),
      },
      {
        source: 'github',
        sourceId: 'evt_repo_created',
        occurredAt: new Date('2026-04-14T18:30:00.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/handsdiff/activeclaw',
        title: 'handsdiff/activeclaw repo created',
        summary: 'Created repository handsdiff/activeclaw',
        rawText: 'Created repository handsdiff/activeclaw',
        tags: ['repo:handsdiff/activeclaw', 'action:repo_created'],
        rawPayload: expect.objectContaining({
          repo: 'handsdiff/activeclaw',
          action: 'repo_created',
          url: 'https://github.com/handsdiff/activeclaw',
          summary: 'Created repository handsdiff/activeclaw',
        }),
      },
      {
        source: 'github',
        sourceId: 'evt_branch_created',
        occurredAt: new Date('2026-04-14T18:45:00.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/handsdiff/activeclaw/tree/feat%2Fagent-twitter-selector',
        title: 'handsdiff/activeclaw branch created',
        summary: 'Created branch feat/agent-twitter-selector in handsdiff/activeclaw',
        rawText: 'Created branch feat/agent-twitter-selector in handsdiff/activeclaw',
        tags: ['repo:handsdiff/activeclaw', 'action:branch_created', 'branch:feat/agent-twitter-selector'],
        rawPayload: expect.objectContaining({
          repo: 'handsdiff/activeclaw',
          action: 'branch_created',
          branch: 'feat/agent-twitter-selector',
          url: 'https://github.com/handsdiff/activeclaw/tree/feat%2Fagent-twitter-selector',
          summary: 'Created branch feat/agent-twitter-selector in handsdiff/activeclaw',
        }),
      },
    ]);
  });

  it('returns an empty batch when gh auth status fails', async () => {
    const db = {} as never;
    const executor = vi.fn().mockRejectedValueOnce(new Error('gh auth status failed'));
    const upsert = vi.fn();

    const source = createGitHubSource(db, {
      githubUsername: 'shirtlessfounder',
      executor,
      upsertEvents: upsert,
    });

    await expect(source.sync()).resolves.toEqual([]);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith('gh', ['auth', 'status']);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('synthesizes repo_created records from the repo list when the activity feed only shows branch creation', async () => {
    const db = {} as never;
    const persisted: UpsertedNormalizedEvent[] = [];
    const executor = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'github.com\n  Logged in to github.com account shirtlessfounder\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 'evt_branch_created',
            type: 'CreateEvent',
            actor: {
              login: 'shirtlessfounder',
            },
            repo: {
              name: 'shirtlessfounder/x-team-capture',
            },
            created_at: '2026-04-14T20:08:48.000Z',
            payload: {
              ref_type: 'branch',
              ref: 'main',
            },
          },
        ]),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            full_name: 'shirtlessfounder/x-team-capture',
            html_url: 'https://github.com/shirtlessfounder/x-team-capture',
            created_at: '2026-04-14T20:08:47.000Z',
            description: 'Team capture experiments',
            private: true,
          },
          {
            full_name: 'shirtlessfounder/old-repo',
            html_url: 'https://github.com/shirtlessfounder/old-repo',
            created_at: '2026-04-10T10:00:00.000Z',
            description: 'Too old for the fresh context window',
            private: true,
          },
        ]),
        stderr: '',
      });
    const upsert = vi.fn().mockResolvedValue(persisted);

    const source = createGitHubSource(db, {
      githubUsername: 'shirtlessfounder',
      executor,
      upsertEvents: upsert,
      lookbackHours: 12,
      now: () => new Date('2026-04-14T23:00:00.000Z'),
    });

    await expect(source.sync()).resolves.toBe(persisted);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(db, [
      {
        source: 'github',
        sourceId: 'evt_branch_created',
        occurredAt: new Date('2026-04-14T20:08:48.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/shirtlessfounder/x-team-capture/tree/main',
        title: 'shirtlessfounder/x-team-capture branch created',
        summary: 'Created branch main in shirtlessfounder/x-team-capture',
        rawText: 'Created branch main in shirtlessfounder/x-team-capture',
        tags: ['repo:shirtlessfounder/x-team-capture', 'action:branch_created', 'branch:main'],
        rawPayload: expect.objectContaining({
          repo: 'shirtlessfounder/x-team-capture',
          action: 'branch_created',
          branch: 'main',
        }),
      },
      {
        source: 'github',
        sourceId: 'repo_created:shirtlessfounder/x-team-capture',
        occurredAt: new Date('2026-04-14T20:08:47.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/shirtlessfounder/x-team-capture',
        title: 'shirtlessfounder/x-team-capture repo created',
        summary: 'Created repository shirtlessfounder/x-team-capture: Team capture experiments',
        rawText: 'Created repository shirtlessfounder/x-team-capture: Team capture experiments',
        tags: ['repo:shirtlessfounder/x-team-capture', 'action:repo_created'],
        rawPayload: expect.objectContaining({
          repo: 'shirtlessfounder/x-team-capture',
          action: 'repo_created',
          url: 'https://github.com/shirtlessfounder/x-team-capture',
          summary: 'Created repository shirtlessfounder/x-team-capture: Team capture experiments',
          synthesized: true,
          private: true,
        }),
      },
    ]);
  });

  it('keeps synthesized repo_created records within the configured lookback horizon', async () => {
    const db = {} as never;
    const persisted: UpsertedNormalizedEvent[] = [];
    const executor = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'github.com\n  Logged in to github.com account shirtlessfounder\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([]),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            full_name: 'shirtlessfounder/inside-window',
            html_url: 'https://github.com/shirtlessfounder/inside-window',
            created_at: '2026-04-14T08:30:00.000Z',
            description: 'Inside the 16 hour window',
            private: true,
          },
          {
            full_name: 'shirtlessfounder/outside-window',
            html_url: 'https://github.com/shirtlessfounder/outside-window',
            created_at: '2026-04-14T07:59:00.000Z',
            description: 'Outside the 16 hour window',
            private: true,
          },
        ]),
        stderr: '',
      });
    const upsert = vi.fn().mockResolvedValue(persisted);

    const source = createGitHubSource(db, {
      githubUsername: 'shirtlessfounder',
      executor,
      upsertEvents: upsert,
      lookbackHours: 16,
      now: () => new Date('2026-04-15T00:00:00.000Z'),
    });

    await expect(source.sync()).resolves.toBe(persisted);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(db, [
      expect.objectContaining({
        source: 'github',
        sourceId: 'repo_created:shirtlessfounder/inside-window',
        summary: 'Created repository shirtlessfounder/inside-window: Inside the 16 hour window',
      }),
    ]);
  });
});
