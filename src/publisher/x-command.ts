import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseXPostUrl } from '../enrichment/x/url';

const execFileAsync = promisify(nodeExecFile);

type ScriptSuccessPayload = {
  ok: true;
  tweetId: string;
  url: string;
};

type ScriptFailurePayload = {
  ok: false;
  error: string;
  code?: number | string | undefined;
};

type ScriptPayload = ScriptSuccessPayload | ScriptFailurePayload;

type ExecFileResult = {
  stdout: string;
  stderr: string;
};

type ExecFileLike = (
  file: string,
  args: readonly string[],
) => Promise<ExecFileResult>;

function parseScriptPayload(stdout: string): ScriptPayload {
  const line = stdout
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  if (!line) {
    throw new Error('tweet.js returned empty stdout');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('tweet.js returned invalid JSON');
  }

  if (
    typeof parsed !== 'object'
    || parsed === null
    || !('ok' in parsed)
    || typeof parsed.ok !== 'boolean'
  ) {
    throw new Error('tweet.js returned an unexpected payload');
  }

  return parsed as ScriptPayload;
}

export async function publishToXViaScript(input: {
  clawdTweetScript: string;
  postProfile: string;
  text: string;
  quoteTargetUrl?: string | null | undefined;
  replyToTweetId?: string | null | undefined;
  mediaPaths?: readonly string[] | undefined;
  execFile?: ExecFileLike | undefined;
}): Promise<{ tweetId: string; url: string; raw: unknown }> {
  const args = [
    input.clawdTweetScript,
    '--profile',
    input.postProfile,
    '--json',
  ];

  if (input.replyToTweetId && input.quoteTargetUrl) {
    throw new Error('Cannot publish a reply and a quote tweet in the same command');
  }

  if (input.replyToTweetId) {
    args.push('--reply-to', input.replyToTweetId);
  }

  if (input.quoteTargetUrl) {
    const parsedQuoteTarget = parseXPostUrl(input.quoteTargetUrl);

    if (!parsedQuoteTarget) {
      throw new Error(`Invalid X quote target URL: ${input.quoteTargetUrl}`);
    }

    args.push('--quote', parsedQuoteTarget.tweetId);
  }

  for (const mediaPath of input.mediaPaths ?? []) {
    args.push('--media', mediaPath);
  }

  args.push(input.text);

  const execFile = input.execFile ?? execFileAsync;
  const { stdout } = await execFile('node', args);
  const payload = parseScriptPayload(stdout);

  if (!payload.ok) {
    throw new Error(payload.error);
  }

  return {
    tweetId: payload.tweetId,
    url: payload.url,
    raw: payload,
  };
}
