import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  formatCandidatePackageMessage,
  type CandidatePackageMessageInput,
} from './command-parser';
import {
  createTelegramClient,
  type SendTelegramMessageInput,
  type TelegramClient,
  type TelegramMessage,
} from './client';

const DEFAULT_HERMES_AGENT_DIR = '/home/ubuntu/.hermes/hermes-agent';
const SEND_SCRIPT_PATH = 'scripts/send_auto_biographer_control_message.py';

type CreateHermesBackedTelegramClientInput = {
  botToken: string;
  chatId: string;
  hermesAgentDir?: string | undefined;
  target?: string | undefined;
};

function parseMessageId(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Hermes send returned an invalid message_id: ${String(value)}`);
  }

  return parsed;
}

async function runHermesSend(input: {
  hermesAgentDir: string;
  botToken: string;
  target: string;
  text: string;
}): Promise<{ messageId: number }> {
  const pythonPath = path.join(input.hermesAgentDir, 'venv/bin/python');
  const scriptPath = path.join(input.hermesAgentDir, SEND_SCRIPT_PATH);

  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HERMES_HOME: process.env.HERMES_HOME ?? '/home/ubuntu/.hermes',
        TELEGRAM_BOT_TOKEN: input.botToken,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Hermes send exited with code ${String(code)}`));
        return;
      }

      const resultLine = stdout.trim().split('\n').filter((line) => line.trim().length > 0).at(-1);

      if (!resultLine) {
        reject(new Error('Hermes send returned no output'));
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(resultLine);
      } catch (error) {
        reject(
          new Error(
            `Hermes send returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }

      if (
        typeof parsed !== 'object'
        || parsed === null
        || !('message_id' in parsed)
      ) {
        reject(new Error('Hermes send did not include a message_id'));
        return;
      }

      resolve({
        messageId: parseMessageId(parsed.message_id),
      });
    });

    child.stdin.end(
      JSON.stringify({
        target: input.target,
        message: input.text,
      }),
    );
  });
}

async function sendViaHermes(input: {
  hermesAgentDir: string;
  botToken: string;
  target: string;
  chatId: string;
  message: SendTelegramMessageInput;
}): Promise<TelegramMessage> {
  const { messageId } = await runHermesSend({
    hermesAgentDir: input.hermesAgentDir,
    botToken: input.botToken,
    target: input.target,
    text: input.message.text,
  });

  return {
    message_id: messageId,
    chat: {
      id: Number.parseInt(input.chatId, 10),
      type: 'private',
    },
    text: input.message.text,
  };
}

export function createHermesBackedTelegramClient(
  input: CreateHermesBackedTelegramClientInput,
): TelegramClient {
  const directClient = createTelegramClient({
    botToken: input.botToken,
    chatId: input.chatId,
  });
  const hermesAgentDir = input.hermesAgentDir?.trim() || DEFAULT_HERMES_AGENT_DIR;
  const target = input.target?.trim() || `telegram:${input.chatId}`;

  return {
    getUpdates: directClient.getUpdates,
    getFile: directClient.getFile,
    async sendMessage(message) {
      return sendViaHermes({
        hermesAgentDir,
        botToken: input.botToken,
        target,
        chatId: input.chatId,
        message,
      });
    },
    async sendCandidatePackage(candidatePackage: CandidatePackageMessageInput) {
      return sendViaHermes({
        hermesAgentDir,
        botToken: input.botToken,
        target,
        chatId: input.chatId,
        message: {
          text: formatCandidatePackageMessage(candidatePackage),
          disableWebPagePreview: true,
        },
      });
    },
  };
}
