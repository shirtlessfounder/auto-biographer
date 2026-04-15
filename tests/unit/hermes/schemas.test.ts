import { describe, expect, it, vi } from 'vitest';

import { runHermesDrafter, runHermesSelector } from '../../../src/hermes/run-hermes';
import {
  HermesDrafterResultSchema,
  HermesSelectorResultSchema,
  parseHermesPayload,
} from '../../../src/hermes/schemas';

const selectorPayload = {
  decision: 'select',
  candidate_type: 'quote_post',
  angle: 'Tie the release note to a concrete user win',
  why_interesting: 'It is fresh, specific, and anchored in a public artifact.',
  source_event_ids: [101, 102],
  artifact_ids: [7001],
  primary_anchor: 'Hermes now returns strict JSON for the posting flow.',
  supporting_points: ['The output is machine-validated.', 'The CLI runs in one shot.'],
  quote_target: null,
  suggested_media_kind: 'image',
  suggested_media_request: 'Use the release screenshot with the JSON contract visible.',
} as const;

const drafterPayload = {
  decision: 'success',
  delivery_kind: 'single_post',
  draft_text: 'Hermes now speaks strict JSON for the semiautonomous X flow.',
  candidate_type: 'quote_post',
  quote_target_url: 'https://x.com/openai/status/1234567890',
  why_chosen: 'The quote post keeps the update grounded in a public source.',
  receipts: ['Release note artifact #7001', 'Supporting event #101'],
  media_request: 'Attach the launch screenshot.',
  allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
} as const;

const skipPayload = {
  decision: 'skip',
  reason: 'No sufficiently fresh source packet was available.',
} as const;

describe('Hermes schemas', () => {
  it('accepts selector result unions for select and skip', () => {
    expect(HermesSelectorResultSchema.parse(selectorPayload)).toEqual(selectorPayload);
    expect(HermesSelectorResultSchema.parse(skipPayload)).toEqual(skipPayload);
    expect(() =>
      HermesSelectorResultSchema.parse({
        ...selectorPayload,
        unexpected: true,
      }),
    ).toThrowError();
    expect(() =>
      HermesSelectorResultSchema.parse({
        ...skipPayload,
        unexpected: true,
      }),
    ).toThrowError();
  });

  it('accepts drafter result unions for single-post success and skip', () => {
    expect(HermesDrafterResultSchema.parse(drafterPayload)).toEqual(drafterPayload);
    expect(HermesDrafterResultSchema.parse(skipPayload)).toEqual(skipPayload);
    expect(() =>
      HermesDrafterResultSchema.parse({
        ...drafterPayload,
        unexpected: true,
      }),
    ).toThrowError();
    expect(() =>
      HermesDrafterResultSchema.parse({
        ...skipPayload,
        unexpected: true,
      }),
    ).toThrowError();
  });
});

describe('runHermes', () => {
  it('accepts selector select results without a caller-provided output kind', async () => {
    const executor = vi.fn().mockResolvedValue({
      stdout: `\n${JSON.stringify(selectorPayload)}\n`,
      stderr: '',
    });

    await expect(
      runHermesSelector({
        input: {
          recent_posts: [{ id: 55, text: 'Earlier launch post' }],
          pendingApprovalCandidates: [
            {
              id: 91,
              status: 'pending_approval',
              candidateType: 'ship_update',
              createdAt: '2026-04-15T11:58:00.000Z',
              finalPostText: 'Shipping work should beat another quote tweet.',
              quoteTargetUrl: null,
              mediaRequest: null,
            },
          ],
        },
        hermesBin: '/opt/hermes',
        executor,
      }),
    ).resolves.toEqual(selectorPayload);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith('/opt/hermes', [
      'chat',
      '-q',
      expect.any(String),
      '-Q',
      '--source',
      'tool',
    ]);

    const prompt = executor.mock.calls[0]?.[1]?.[2];
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('semiautonomous X posting service');
    expect(prompt).toContain('Return raw JSON only');
    expect(prompt).toContain('"pendingApprovalCandidates"');
    expect(prompt).toContain('Do not choose quote tweets for now');
    expect(prompt).toContain('repo_created');
    expect(prompt).toContain('top-tier');
    expect(prompt).toContain('quote_target');
  });

  it('accepts selector skip results without a caller-provided output kind', async () => {
    const executor = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(skipPayload),
      stderr: '',
    });

    await expect(
      runHermesSelector({
        input: {
          recent_posts: [],
        },
        executor,
      }),
    ).resolves.toEqual(skipPayload);
  });

  it('accepts drafter skip results without a caller-provided output kind', async () => {
    const executor = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(skipPayload),
      stderr: '',
    });

    await expect(
      runHermesDrafter({
        input: {
          candidate_id: 99,
        },
        executor,
      }),
    ).resolves.toEqual(skipPayload);
  });

  it('accepts drafter single-post success results without a caller-provided output kind', async () => {
    const executor = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(drafterPayload),
      stderr: '',
    });

    await expect(
      runHermesDrafter({
        input: {
          candidate_id: 99,
          repoLinkUrl: 'https://github.com/dylanvu/auto-biographer',
          selection: {
            suggestedMediaRequest: 'terminal screenshot of the shipped workflow',
          },
        },
        executor,
      }),
    ).resolves.toEqual(drafterPayload);

    const prompt = executor.mock.calls[0]?.[1]?.[2];
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('280');
    expect(prompt).toContain('repoLinkUrl');
    expect(prompt).toContain('2-post thread');
    expect(prompt).toContain('media_request');
  });

  it('rejects invalid json on stdout', async () => {
    const executor = vi.fn().mockResolvedValue({
      stdout: 'not-json',
      stderr: '',
    });

    await expect(
      runHermesSelector({
        input: {
          candidate_id: 1,
        },
        executor,
      }),
    ).rejects.toThrowError(/json/i);
  });

  it('parses the json body when Hermes appends a session footer', async () => {
    const executor = vi.fn().mockResolvedValue({
      stdout: `${JSON.stringify(selectorPayload)}\n\nsession_id: 20260414_171417_7508f9\n`,
      stderr: '',
    });

    await expect(
      runHermesSelector({
        input: {
          candidate_id: 1,
        },
        executor,
      }),
    ).resolves.toEqual(selectorPayload);
  });

  it('parses selector and drafter result unions directly', () => {
    expect(parseHermesPayload('selector', selectorPayload)).toEqual(selectorPayload);
    expect(parseHermesPayload('selector', skipPayload)).toEqual(skipPayload);
    expect(parseHermesPayload('drafter', drafterPayload)).toEqual(drafterPayload);
    expect(parseHermesPayload('drafter', skipPayload)).toEqual(skipPayload);
  });
});
