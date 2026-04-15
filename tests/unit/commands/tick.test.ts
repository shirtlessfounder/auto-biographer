import { describe, expect, it, vi } from 'vitest';

const createGitHubSource = vi.fn();
const createInniesSource = vi.fn();
const createSlackLinksSource = vi.fn();
const createSlackMessagesSource = vi.fn();

vi.mock('../../../src/sources/github-source', () => ({
  createGitHubSource,
}));

vi.mock('../../../src/sources/innies-source', () => ({
  createInniesSource,
}));

vi.mock('../../../src/sources/slack-links-source', () => ({
  createSlackLinksSource,
}));

vi.mock('../../../src/sources/slack-messages-source', () => ({
  createSlackMessagesSource,
}));

describe('buildSyncSources', () => {
  it('uses a 16 hour sync horizon for every source, including github', async () => {
    createSlackMessagesSource.mockReturnValue({ sync: vi.fn().mockResolvedValue([]) });
    createSlackLinksSource.mockReturnValue({ sync: vi.fn().mockResolvedValue([]) });
    createInniesSource.mockReturnValue({ sync: vi.fn().mockResolvedValue([]) });
    createGitHubSource.mockReturnValue({ sync: vi.fn().mockResolvedValue([]) });

    const { buildSyncSources } = await import('../../../src/commands/tick');
    const db = {} as never;
    const env = {
      slackAuthorNames: ['dylan vu'],
      slackAuthorUserIds: ['U0876KEGPGF'],
      inniesBuyerKeyName: 'shirtless',
      githubUsername: 'shirtlessfounder',
    } as never;

    const sources = buildSyncSources({ db, env });

    for (const source of sources) {
      await source.sync();
    }

    expect(createSlackMessagesSource).toHaveBeenCalledWith(db, expect.objectContaining({
      lookbackHours: 16,
    }));
    expect(createSlackLinksSource).toHaveBeenCalledWith(db, expect.objectContaining({
      lookbackHours: 16,
    }));
    expect(createInniesSource).toHaveBeenCalledWith(db, expect.objectContaining({
      lookbackHours: 16,
    }));
    expect(createGitHubSource).toHaveBeenCalledWith(db, expect.objectContaining({
      githubUsername: 'shirtlessfounder',
      lookbackHours: 16,
    }));
  });
});
