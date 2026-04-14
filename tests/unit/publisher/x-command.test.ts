import { describe, expect, it, vi } from 'vitest';

import { publishToXViaScript } from '../../../src/publisher/x-command';

describe('publishToXViaScript', () => {
  it('builds an original-post command without quote or media flags', async () => {
    const execFile = vi.fn(async () => ({
      stdout: `${JSON.stringify({ ok: true, tweetId: '1900', url: 'https://x.com/me/status/1900' })}\n`,
      stderr: '',
    }));

    const result = await publishToXViaScript({
      clawdTweetScript: '/srv/clawd/scripts/tweet.js',
      postProfile: 'bicep_pump',
      text: 'hello world',
      execFile,
    });

    expect(execFile).toHaveBeenCalledWith(
      'node',
      [
        '/srv/clawd/scripts/tweet.js',
        '--profile',
        'bicep_pump',
        '--json',
        'hello world',
      ],
    );
    expect(result).toEqual({
      tweetId: '1900',
      url: 'https://x.com/me/status/1900',
      raw: { ok: true, tweetId: '1900', url: 'https://x.com/me/status/1900' },
    });
  });

  it('builds a quote-tweet command with repeated media flags in order', async () => {
    const execFile = vi.fn(async () => ({
      stdout: `${JSON.stringify({ ok: true, tweetId: '1901', url: 'https://x.com/me/status/1901' })}\n`,
      stderr: '',
    }));

    await publishToXViaScript({
      clawdTweetScript: '/srv/clawd/scripts/tweet.js',
      postProfile: 'bicep_pump',
      text: 'draft text',
      quoteTargetUrl: 'https://x.com/navaai/status/2044068240524251460',
      mediaPaths: ['/tmp/1.jpg', '/tmp/2.jpg'],
      execFile,
    });

    expect(execFile).toHaveBeenCalledWith(
      'node',
      [
        '/srv/clawd/scripts/tweet.js',
        '--profile',
        'bicep_pump',
        '--json',
        '--quote',
        '2044068240524251460',
        '--media',
        '/tmp/1.jpg',
        '--media',
        '/tmp/2.jpg',
        'draft text',
      ],
    );
  });

  it('throws on json failure payloads from the script', async () => {
    const execFile = vi.fn(async () => ({
      stdout: `${JSON.stringify({ ok: false, error: 'rate limited', code: 429 })}\n`,
      stderr: '',
    }));

    await expect(
      publishToXViaScript({
        clawdTweetScript: '/srv/clawd/scripts/tweet.js',
        postProfile: 'bicep_pump',
        text: 'draft text',
        execFile,
      }),
    ).rejects.toThrow('rate limited');
  });
});
