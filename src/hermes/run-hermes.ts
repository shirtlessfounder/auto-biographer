import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import {
  parseHermesPayload,
  type HermesDrafterResult,
  type HermesPayloadKind,
  type HermesSelectorResult,
} from './schemas';

const execFileAsync = promisify(execFile);

const SOCIAL_OVERLAY_PROMPT = [
  'You are Hermes running inside the semiautonomous X posting service.',
  'Produce exactly one raw JSON object.',
  'Return raw JSON only with no Markdown, prose, or code fences.',
  'Do not add keys beyond the requested contract.',
].join('\n');

const PROMPT_FILES = {
  selector: 'selector.md',
  drafter: 'drafter.md',
} as const;

type PromptName = keyof typeof PROMPT_FILES;

type HermesCommandResult = {
  stdout: string;
  stderr: string;
};

type HermesPayloadByKind = {
  selector: HermesSelectorResult;
  drafter: HermesDrafterResult;
};

export type HermesExecutor = (
  command: string,
  args: string[],
) => Promise<HermesCommandResult>;

type RunHermesOptions<Kind extends HermesPayloadKind> = {
  input: unknown;
  hermesBin?: string | undefined;
  executor?: HermesExecutor | undefined;
  promptName: Kind;
};

const promptCache = new Map<PromptName, string>();

async function defaultExecutor(command: string, args: string[]): Promise<HermesCommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  return { stdout, stderr };
}

async function loadPrompt(promptName: PromptName): Promise<string> {
  const cached = promptCache.get(promptName);

  if (cached) {
    return cached;
  }

  const prompt = await readFile(new URL(`./prompts/${PROMPT_FILES[promptName]}`, import.meta.url), 'utf8');
  const trimmedPrompt = prompt.trim();
  promptCache.set(promptName, trimmedPrompt);
  return trimmedPrompt;
}

function buildPrompt(promptBody: string, input: unknown): string {
  return [
    SOCIAL_OVERLAY_PROMPT,
    promptBody,
    'Return raw JSON only.',
    'Input JSON:',
    JSON.stringify(input, null, 2),
  ].join('\n\n');
}

function formatHermesFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return 'Unknown Hermes execution failure';
}

export async function runHermesOneShot<Kind extends HermesPayloadKind>({
  input,
  hermesBin = 'hermes',
  executor = defaultExecutor,
  promptName,
}: RunHermesOptions<Kind>): Promise<HermesPayloadByKind[Kind]> {
  const prompt = buildPrompt(await loadPrompt(promptName), input);

  let commandResult: HermesCommandResult;

  try {
    commandResult = await executor(hermesBin, ['chat', '-q', prompt, '-Q', '--source', 'tool']);
  } catch (error) {
    throw new Error(`Hermes command failed: ${formatHermesFailure(error)}`);
  }

  const rawStdout = commandResult.stdout.trim();

  if (rawStdout.length === 0) {
    throw new Error('Hermes returned empty stdout');
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawStdout);
  } catch {
    throw new Error(`Hermes returned invalid JSON on stdout: ${rawStdout}`);
  }

  try {
    return parseHermesPayload(promptName, parsedJson);
  } catch (error) {
    throw new Error(`Hermes ${promptName} payload failed validation: ${formatHermesFailure(error)}`);
  }
}

type RunSelectorOptions = {
  input: unknown;
  hermesBin?: string | undefined;
  executor?: HermesExecutor | undefined;
  outputKind?: 'selector' | 'skip' | undefined;
};

type RunDrafterOptions = {
  input: unknown;
  hermesBin?: string | undefined;
  executor?: HermesExecutor | undefined;
  outputKind?: 'drafter' | 'skip' | undefined;
};

export function runHermesSelector({
  input,
  hermesBin,
  executor,
}: RunSelectorOptions): Promise<HermesSelectorResult> {
  return runHermesOneShot({
    input,
    hermesBin,
    executor,
    promptName: 'selector',
  });
}

export function runHermesDrafter({
  input,
  hermesBin,
  executor,
}: RunDrafterOptions): Promise<HermesDrafterResult> {
  return runHermesOneShot({
    input,
    hermesBin,
    executor,
    promptName: 'drafter',
  });
}
