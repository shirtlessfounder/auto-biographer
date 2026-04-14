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
              name: 'dylanvu/social-posting',
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
              name: 'dylanvu/social-posting',
            },
            created_at: '2026-04-14T15:00:00.000Z',
            payload: {
              action: 'opened',
              pull_request: {
                number: 42,
                title: 'Add GitHub source adapter',
                html_url: 'https://github.com/dylanvu/social-posting/pull/42',
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
              name: 'dylanvu/social-posting',
            },
            created_at: '2026-04-14T16:00:00.000Z',
            payload: {
              action: 'closed',
              pull_request: {
                number: 42,
                title: 'Add GitHub source adapter',
                html_url: 'https://github.com/dylanvu/social-posting/pull/42',
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
              name: 'dylanvu/social-posting',
            },
            created_at: '2026-04-14T17:00:00.000Z',
            payload: {
              action: 'synchronize',
              pull_request: {
                number: 42,
                title: 'Add GitHub source adapter',
                html_url: 'https://github.com/dylanvu/social-posting/pull/42',
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
            id: 'evt_ignored',
            type: 'IssuesEvent',
            actor: {
              login: 'shirtlessfounder',
            },
            repo: {
              name: 'dylanvu/social-posting',
            },
            created_at: '2026-04-14T19:00:00.000Z',
            payload: {
              action: 'opened',
            },
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

    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor).toHaveBeenNthCalledWith(1, 'gh', ['auth', 'status']);
    expect(executor).toHaveBeenNthCalledWith(2, 'gh', [
      'api',
      '/users/shirtlessfounder/events?per_page=100',
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
        urlOrLocator: 'https://github.com/dylanvu/social-posting/commit/2222222222222222222222222222222222222222',
        title: 'dylanvu/social-posting push',
        summary: 'Pushed 2 commits to main in dylanvu/social-posting: Add GitHub source adapter; Cover gh auth failures',
        rawText: 'Add GitHub source adapter\nCover gh auth failures',
        tags: ['repo:dylanvu/social-posting', 'action:push', 'branch:main'],
        rawPayload: expect.objectContaining({
          repo: 'dylanvu/social-posting',
          action: 'push',
          url: 'https://github.com/dylanvu/social-posting/commit/2222222222222222222222222222222222222222',
          summary: 'Pushed 2 commits to main in dylanvu/social-posting: Add GitHub source adapter; Cover gh auth failures',
        }),
      },
      {
        source: 'github',
        sourceId: 'evt_pr_opened',
        occurredAt: new Date('2026-04-14T15:00:00.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/dylanvu/social-posting/pull/42',
        title: 'Add GitHub source adapter',
        summary: 'Opened PR #42 in dylanvu/social-posting: Add GitHub source adapter',
        rawText: 'Add GitHub source adapter',
        tags: ['repo:dylanvu/social-posting', 'action:pr_opened'],
        rawPayload: expect.objectContaining({
          repo: 'dylanvu/social-posting',
          action: 'pr_opened',
          url: 'https://github.com/dylanvu/social-posting/pull/42',
        }),
      },
      {
        source: 'github',
        sourceId: 'evt_pr_merged',
        occurredAt: new Date('2026-04-14T16:00:00.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/dylanvu/social-posting/pull/42',
        title: 'Add GitHub source adapter',
        summary: 'Merged PR #42 in dylanvu/social-posting: Add GitHub source adapter',
        rawText: 'Add GitHub source adapter',
        tags: ['repo:dylanvu/social-posting', 'action:pr_merged'],
        rawPayload: expect.objectContaining({
          repo: 'dylanvu/social-posting',
          action: 'pr_merged',
          url: 'https://github.com/dylanvu/social-posting/pull/42',
        }),
      },
      {
        source: 'github',
        sourceId: 'evt_pr_updated',
        occurredAt: new Date('2026-04-14T17:00:00.000Z'),
        author: 'shirtlessfounder',
        urlOrLocator: 'https://github.com/dylanvu/social-posting/pull/42',
        title: 'Add GitHub source adapter',
        summary: 'Updated PR #42 in dylanvu/social-posting: Add GitHub source adapter',
        rawText: 'Add GitHub source adapter',
        tags: ['repo:dylanvu/social-posting', 'action:pr_updated'],
        rawPayload: expect.objectContaining({
          repo: 'dylanvu/social-posting',
          action: 'pr_updated',
          url: 'https://github.com/dylanvu/social-posting/pull/42',
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
});
