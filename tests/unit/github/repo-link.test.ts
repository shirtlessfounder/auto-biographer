import { describe, expect, it, vi } from 'vitest';

import { resolvePublicGitHubRepoUrl } from '../../../src/github/repo-link';

describe('resolvePublicGitHubRepoUrl', () => {
  it('returns the repo URL when the GitHub API reports a public repository', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ private: false }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }));

    await expect(
      resolvePublicGitHubRepoUrl({
        repoUrl: 'https://github.com/dylanvu/auto-biographer',
        fetchFn,
      }),
    ).resolves.toBe('https://github.com/dylanvu/auto-biographer');

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/repos/dylanvu/auto-biographer',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          'User-Agent': 'auto-biographer',
        }),
      }),
    );
  });

  it('returns null when the GitHub API reports a private repository', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ private: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }));

    await expect(
      resolvePublicGitHubRepoUrl({
        repoUrl: 'https://github.com/dylanvu/auto-biographer',
        fetchFn,
      }),
    ).resolves.toBeNull();
  });

  it('returns null when the repository cannot be confirmed as public', async () => {
    const fetchFn = vi.fn(async () => new Response('not found', { status: 404 }));

    await expect(
      resolvePublicGitHubRepoUrl({
        repoUrl: 'https://github.com/dylanvu/auto-biographer',
        fetchFn,
      }),
    ).resolves.toBeNull();
  });

  it('returns null when the GitHub API request fails', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    });

    await expect(
      resolvePublicGitHubRepoUrl({
        repoUrl: 'https://github.com/dylanvu/auto-biographer',
        fetchFn,
      }),
    ).resolves.toBeNull();
  });
});
