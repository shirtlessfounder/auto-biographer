import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import {
  parseHermesPayload,
  type HermesDrafterResult,
  type HermesPayloadKind,
  type HermesSelectorResult,
} from './schemas';

const execFileAsync = promisify(execFile);
const MAX_HERMES_OUTPUT_BYTES = 1024 * 1024;
const HERMES_ONE_SHOT_WRAPPER = [
  'import os',
  'import sys',
  '',
  'source = sys.argv[1] if len(sys.argv) > 1 else ""',
  'if source:',
  '    os.environ["HERMES_SESSION_SOURCE"] = source',
  '',
  'from cli import main',
  '',
  'prompt = sys.stdin.read()',
  'main(query=prompt, quiet=True)',
].join('\n');

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
  const hermesQueryPrompt = getHermesQueryPrompt(args);
  const hermesSource = getHermesSource(args);
  const hermesPython = await resolveHermesPython(command);

  if (hermesQueryPrompt !== null && hermesPython !== null) {
    return runHermesViaPython({
      pythonBin: hermesPython,
      prompt: hermesQueryPrompt,
      source: hermesSource,
    });
  }

  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: MAX_HERMES_OUTPUT_BYTES,
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

function getHermesQueryPrompt(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === '-q' || args[index] === '--query') && typeof args[index + 1] === 'string') {
      return args[index + 1] ?? null;
    }
  }

  return null;
}

function getHermesSource(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--source' && typeof args[index + 1] === 'string') {
      return args[index + 1] ?? 'tool';
    }
  }

  return 'tool';
}

async function resolveCommandPath(command: string): Promise<string> {
  if (command.includes('/')) {
    return command;
  }

  const { stdout } = await execFileAsync('which', [command], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024,
  });
  const resolved = stdout.trim();

  if (resolved.length === 0) {
    throw new Error(`Unable to resolve command path for ${command}`);
  }

  return resolved;
}

async function resolveHermesPython(command: string): Promise<string | null> {
  try {
    const commandPath = await resolveCommandPath(command);
    const firstLine = (await readFile(commandPath, 'utf8')).split(/\r?\n/, 1)[0]?.trim() ?? '';

    if (!firstLine.startsWith('#!')) {
      return null;
    }

    const shebang = firstLine.slice(2).trim();
    const parts = shebang.split(/\s+/).filter((part) => part.length > 0);

    if (parts.length === 0) {
      return null;
    }

    if (parts[0] === '/usr/bin/env') {
      return parts[1] ?? null;
    }

    return parts[0] ?? null;
  } catch {
    return null;
  }
}

async function runHermesViaPython(input: {
  pythonBin: string;
  prompt: string;
  source: string;
}): Promise<HermesCommandResult> {
  return new Promise<HermesCommandResult>((resolve, reject) => {
    const child = spawn(input.pythonBin, ['-c', HERMES_ONE_SHOT_WRAPPER, input.source], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_HERMES_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        reject(new Error('Hermes stdout exceeded maxBuffer'));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_HERMES_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        reject(new Error('Hermes stderr exceeded maxBuffer'));
      }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const detail =
        stderr.trim().length > 0
          ? stderr.trim()
          : `Hermes exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}`;
      reject(new Error(detail));
    });

    child.stdin.end(input.prompt);
  });
}

function extractJsonObject(stdout: string): string {
  const match = stdout.match(/\{[\s\S]*\}/);

  if (!match) {
    throw new Error(`Hermes returned invalid JSON on stdout: ${stdout.trim()}`);
  }

  return match[0].trim();
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

  const rawStdout = extractJsonObject(commandResult.stdout);

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
