import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '../..');

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

describe('project identity', () => {
  it('uses auto-biographer as the canonical project name', async () => {
    const packageJson = JSON.parse(await readProjectFile('package.json')) as {
      description: string;
      name: string;
    };

    expect(packageJson.name).toBe('auto-biographer');
    expect(packageJson.description).toContain('auto-biographer');

    await expect(readProjectFile('ops/systemd/auto-biographer-tick.service')).resolves.toContain(
      'WorkingDirectory=/home/ubuntu/auto-biographer',
    );
    await expect(readProjectFile('ops/systemd/auto-biographer-tick.timer')).resolves.toContain(
      'Unit=auto-biographer-tick.service',
    );
    await expect(readProjectFile('README.md')).resolves.toContain('# auto-biographer');
    await expect(readProjectFile('README.md')).resolves.toContain(
      'cd /Users/dylanvu/auto-biographer',
    );
    await expect(readProjectFile('src/github/repo-link.ts')).resolves.toContain(
      "'User-Agent': 'auto-biographer'",
    );
    await expect(readProjectFile('src/publisher/telegram-media.ts')).resolves.toContain(
      "'auto-biographer-media-'",
    );
  });
});
