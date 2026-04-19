/**
 * DB layer entrypoint.
 *
 * Imports `Queryable` from `./pool` for the shared type interface.
 * Runtime pool is the exe MCP client from `./mcp-client`.
 */

export type { Queryable } from './pool.js';
export { getPool, closePool } from './mcp-client.js';
