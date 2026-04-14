import { beforeEach, describe, expect, it, vi } from 'vitest';

const runTickCommand = vi.fn();
const runDraftNowCommand = vi.fn();

vi.mock('../../src/commands/tick', () => ({
  runTickCommand,
}));

vi.mock('../../src/commands/draft-now', () => ({
  runDraftNowCommand,
}));

const { runCli } = await import('../../src/cli');

describe('runCli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates tick arguments to the tick command', async () => {
    await runCli(['tick', '--dry-run']);

    expect(runTickCommand).toHaveBeenCalledWith(['--dry-run']);
  });

  it('delegates draft-now to the draft command', async () => {
    await runCli(['draft-now']);

    expect(runDraftNowCommand).toHaveBeenCalledWith([]);
  });
});
