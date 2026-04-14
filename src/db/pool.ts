import { readFileSync } from 'node:fs';

import { Pool, type PoolConfig } from 'pg';

export type Queryable = Pick<Pool, 'query'>;

type ReadFile = (path: string, encoding: BufferEncoding) => string;

type BuildPoolConfigInput = {
  databaseUrl: string;
  awsRdsCaCertPath?: string | undefined;
  readFile?: ReadFile | undefined;
};

const SSL_QUERY_PARAMS = ['ssl', 'sslcert', 'sslcrl', 'sslkey', 'sslmode', 'sslrootcert'] as const;

function sanitizeConnectionString(databaseUrl: string): string {
  const url = new URL(databaseUrl);

  for (const parameterName of SSL_QUERY_PARAMS) {
    url.searchParams.delete(parameterName);
  }

  return url.toString();
}

function shouldUseExplicitSsl(sslMode: string | null, awsRdsCaCertPath: string | undefined): boolean {
  if (awsRdsCaCertPath) {
    return true;
  }

  return sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full';
}

function buildSslConfig(input: {
  sslMode: string | null;
  awsRdsCaCertPath?: string | undefined;
  readFile: ReadFile;
}): NonNullable<PoolConfig['ssl']> | undefined {
  if (!shouldUseExplicitSsl(input.sslMode, input.awsRdsCaCertPath)) {
    return undefined;
  }

  if (input.awsRdsCaCertPath) {
    return {
      rejectUnauthorized: true,
      ca: input.readFile(input.awsRdsCaCertPath, 'utf8'),
    };
  }

  if (input.sslMode === 'verify-ca' || input.sslMode === 'verify-full') {
    return {
      rejectUnauthorized: true,
    };
  }

  return {
    rejectUnauthorized: false,
  };
}

export function buildPoolConfig(input: BuildPoolConfigInput): PoolConfig {
  const url = new URL(input.databaseUrl);
  const sslMode = url.searchParams.get('sslmode');
  const ssl = buildSslConfig({
    sslMode,
    awsRdsCaCertPath: input.awsRdsCaCertPath,
    readFile: input.readFile ?? readFileSync,
  });

  if (!ssl) {
    return {
      connectionString: input.databaseUrl,
    };
  }

  return {
    connectionString: sanitizeConnectionString(input.databaseUrl),
    ssl,
  };
}

export function createPool(
  connectionString: string,
  options: {
    awsRdsCaCertPath?: string | undefined;
    readFile?: ReadFile | undefined;
  } = {},
): Pool {
  const awsRdsCaCertPath = options.awsRdsCaCertPath ?? process.env.AWS_RDS_CA_CERT_PATH;

  return new Pool(
    buildPoolConfig({
      databaseUrl: connectionString,
      awsRdsCaCertPath,
      readFile: options.readFile,
    }),
  );
}
