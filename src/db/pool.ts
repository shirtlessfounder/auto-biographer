/**
 * Database pool abstraction.
 *
 * For the exe DB (MCP/SSE transport), use `from './mcp-client'`.
 * For raw pg, use `from 'pg'` directly (kept for backwards compat during migration).
 *
 * All repositories should import `Queryable` from here — the concrete
 * implementation is swapped in by the entry point.
 */

import { getPool } from './mcp-client';
import type { McpPool } from './mcp-client';

export type { Queryable } from './mcp-client';
export type { McpPool };
export { getPool as _getPool } from './mcp-client';

/**
 * Pool factory for tests — accepts a connection string for API compat (ignored for
 * MCP; use _getPool() directly if you need async init). The returned McpPool
 * connects lazily on first query.
 *
 * Tests use this to get an McpPool without importing from mcp-client.
 * The real app uses _getPool() / getPool().
 */
export async function createPool(_connectionString?: string): Promise<McpPool> {
  return getPool();
}
