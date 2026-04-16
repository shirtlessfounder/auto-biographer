import { beforeEach, describe, expect, it, vi } from 'vitest';

const runTickCommand = vi.fn();
const runDraftNowCommand = vi.fn();
const runControlIngestCommand = vi.fn();

vi.mock('../../src/commands/tick', () => ({
  runTickCommand,
}));

vi.mock('../../src/commands/draft-now', () => ({
  runDraftNowCommand,
}));

vi.mock('../../src/commands/control-ingest', () => ({
  runControlIngestCommand,
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

  it('delegates control-ingest to the control ingest command', async () => {
    await runCli(['control-ingest']);

    expect(runControlIngestCommand).toHaveBeenCalledWith([]);
  });
});
