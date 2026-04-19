/**
 * exe DB MCP client — wraps the Model Context Protocol SSE transport.
 *
 * The exe DB at https://db-trapezius.int.exe.xyz exposes PostgreSQL via MCP:
 *   - GET  /sse        → SSE stream, returns { endpoint: "/messages/?session_id=<uuid>" }
 *   - POST /messages/  → JSON-RPC 2.0 request
 *   - GET  /messages/?session_id=<uuid>&last_event_id=<n>  → SSE stream of responses
 *
 * The MCP tool "execute_sql" returns results as Python repr strings, not JSON.
 * We parse them with pythonReprToJson and extract the _json field from json_agg results.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { z } from 'zod';

// ── Public types ──────────────────────────────────────────────────────────────

export type Queryable = Pick<typeof Pool.prototype, 'query'>;

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

// ── MCP result schema ─────────────────────────────────────────────────────────

const ExecuteSqlResultSchema = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string(),
      annotations: z.any().nullable().optional(),
      _meta: z.any().nullable().optional(),
    }),
  ),
  isError: z.boolean().optional(),
  structuredContent: z.any().optional(),
});

// ── pythonReprToJson ─────────────────────────────────────────────────────────

/**
 * Converts a Python repr string (single-quoted, None/True/False literals,
 * trailing commas) to a JSON string.  Returns the JSON string (not parsed).
 *
 * Handles: null, booleans, integers, floats, single-quoted strings,
 * single-quoted strings with \', \\, \n, \r, \xNN, \uNNNN escapes,
 * lists, dicts (Python 3.7+ ordered), and tuple suffix ,).
 */
export function pythonReprToJson(input: string): string {
  let pos = 0;
  const len = input.length;

  function skipWs(): void {
    while (pos < len && (input[pos] === ' ' || input[pos] === '\n' || input[pos] === '\r' || input[pos] === '\t')) {
      pos++;
    }
  }

  function parseString(): string {
    // Assumes current pos is at opening quote
    pos++; // skip opening '
    let result = '"';
    while (pos < len) {
      const ch = input[pos];
      if (ch === '\\') {
        pos++;
        const next = input[pos];
        if (next === 'n') { result += '\\n'; pos++; }
        else if (next === 'r') { result += '\\r'; pos++; }
        else if (next === 't') { result += '\\t'; pos++; }
        else if (next === '\\') { result += '\\\\'; pos++; }
        else if (next === "'") { result += "'"; pos++; } // \' → literal apostrophe; JSON strings don't need to escape '
        else if (next === 'x') {
          pos++;
          const h1 = input[pos] ?? '';
          const h2 = input[pos + 1] ?? '';
          result += String.fromCharCode(parseInt(h1 + h2, 16));
          pos += 2;
        }
        else if (next === 'u') {
          pos++;
          const u1 = input.slice(pos, pos + 4);
          result += String.fromCharCode(parseInt(u1, 16));
          pos += 4;
        }
        else { result += next; pos++; }
      } else if (ch === "'") {
        pos++; // skip closing '
        break;
      } else if (ch === '"') {
        // Python single-quoted strings don't escape " — but JSON must.
        result += '\\"';
        pos++;
      } else if (ch === '\n') {
        result += '\\n';
        pos++;
      } else if (ch === '\r') {
        result += '\\r';
        pos++;
      } else if (ch === '\t') {
        result += '\\t';
        pos++;
      } else {
        result += ch;
        pos++;
      }
    }
    return result + '"';
  }

  function parseValue(): string {
    skipWs();
    if (pos >= len) return 'null';
    const ch = input[pos];

    if (ch === "'") return parseString();

    if (ch === '[') {
      pos++; // skip '['
      skipWs();
      if (pos < len && input[pos] === ']') { pos++; return '[]'; }
      let result = '[';
      let first = true;
      while (pos < len && input[pos] !== ']') {
        if (!first) {
          skipWs();
          if (input[pos] === ',') { result += ','; pos++; }
        }
        skipWs();
        const val = parseValue();
        result += val;
        first = false;
        skipWs();
        if (pos < len && input[pos] === ',') {
          result += ',';
          pos++;
        }
      }
      if (pos < len && input[pos] === ']') pos++;
      // Skip Python tuple trailing comma  ]
      skipWs();
      if (pos < len && input[pos] === ',') pos++;
      return result + ']';
    }

    if (ch === '{') {
      pos++; // skip '{'
      skipWs();
      if (pos < len && input[pos] === '}') { pos++; return '{}'; }
      let result = '{';
      let first = true;
      while (pos < len && input[pos] !== '}') {
        if (!first) {
          skipWs();
          if (input[pos] === ',') { result += ','; pos++; }
        }
        skipWs();
        if (input[pos] === "'") {
          const key = parseString();
          result += key + ':';
        } else if (input[pos] === '"') {
          // double-quoted key (some repr variants)
          pos++;
          let key = '"';
          while (pos < len && input[pos] !== '"') {
            if (input[pos] === '\\') { key += input[pos++]; }
            key += input[pos++];
          }
          pos++; // skip closing "
          result += key + '":';
        } else {
          // bare key — indexOf(':') below eats the separator for us.
          const keyEnd = input.indexOf(':', pos);
          if (keyEnd === -1) return result;
          const key = input.slice(pos, keyEnd).trim();
          pos = keyEnd + 1;
          result += '"' + key + '":';
          skipWs();
          const val = parseValue();
          result += val;
          first = false;
          skipWs();
          if (pos < len && input[pos] === ',') { result += ','; pos++; }
          continue;
        }
        // Quoted-key branches fall through here and must consume the `:` separator.
        skipWs();
        if (input[pos] === ':') pos++;
        skipWs();
        const val = parseValue();
        result += val;
        first = false;
        skipWs();
        if (pos < len && input[pos] === ',') {
          result += ',';
          pos++;
        }
      }
      if (pos < len && input[pos] === '}') pos++;
      return result + '}';
    }

    // Literals
    if (input.startsWith('None', pos)) { pos += 4; return 'null'; }
    if (input.startsWith('True', pos)) { pos += 4; return 'true'; }
    if (input.startsWith('False', pos)) { pos += 5; return 'false'; }

    // Number: collect chars until comma, space, ], or }
    let num = '';
    while (pos < len) {
      const c = input[pos];
      if (c === ',' || c === ']' || c === '}' || c === ' ' || c === '\n' || c === '\r' || c === '\t') break;
      num += c;
      pos++;
    }
    return num || 'null';
  }

  const result = parseValue();
  return result ?? 'null';
}

// ── Response parser ──────────────────────────────────────────────────────────

/**
 * Parses the MCP response for a query wrapped with `json_agg(row_to_json(_t))`.
 * MCP returns a Python repr string shaped like `[{'_json': '[{row}, ...]'}]`.
 * Any parse failure throws so bugs surface instead of looking like empty results.
 */
export function parseMcpJsonAggResponse<T>(raw: string): QueryResult<T> {
  const repr = pythonReprToJson(raw);
  const outer: unknown = JSON.parse(repr);
  const arr: unknown[] = Array.isArray(outer) ? outer : outer !== null ? [outer] : [];
  if (arr.length === 0) return { rows: [] as T[], rowCount: 0 };

  const innerStr = (arr[0] as Record<string, unknown>)._json;
  if (typeof innerStr !== 'string') return { rows: [] as T[], rowCount: 0 };

  // pythonReprToJson already decoded the Python string-literal escaping into a
  // valid JSON string, and the outer JSON.parse above turned its \\ sequences
  // back into literal backslashes. innerStr is the raw json_agg payload.
  const rows = JSON.parse(innerStr) as T[];
  return { rows, rowCount: rows.length };
}

// ── MCP Client ───────────────────────────────────────────────────────────────

export class ExeMcpClient {
  private client: Client;
  private transport: SSEClientTransport;
  private _connected = false;

  constructor(
    private readonly mcpUrl = 'https://db-trapezius.int.exe.xyz/sse',
  ) {
    this.transport = new SSEClientTransport(new URL(this.mcpUrl));
    this.client = new Client({ name: 'auto-biographer', version: '1.0.0' }, { capabilities: {} });
  }

  async connect(): Promise<void> {
    if (this._connected) return;
    await this.client.connect(this.transport);
    this._connected = true;
  }

  async close(): Promise<void> {
    if (!this._connected) return;
    await this.client.close();
    this._connected = false;
  }

  get connected(): boolean {
    return this._connected;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    if (!this._connected) {
      await this.connect();
    }

    // Check for multi-statement SQL BEFORE substitution — semicolons in parameter
    // values (e.g. JSON strings like {"reason":"No;SQL"}) must not trigger false positives.
    const trimmedSqlRaw = sql.replace(/;\s*$/, '').trim();
    if (/;\s*\S/.test(trimmedSqlRaw)) {
      throw new Error('mcp-client.query: multi-statement SQL is not supported; issue one statement per call');
    }

    // Substitute $N params
    let executedSql = sql;
    if (params && params.length > 0) {
      executedSql = sql.replace(/\$(\d+)/g, (_match, n) => {
        const idx = parseInt(n, 10) - 1;
        const val = params[idx];
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'number') return String(val);
        if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
        if (val instanceof Date) return `'${val.toISOString()}'`;
        return `'${String(val).replace(/'/g, "''")}'`;
      });
    }

    const trimmedSql = executedSql.replace(/;\s*$/, '').trim();
    const leadingKw = (trimmedSql.match(/^\s*(\w+)/)?.[1] ?? '').toLowerCase();
    const isControl = ['begin', 'start', 'commit', 'rollback', 'savepoint', 'release', 'set', 'reset', 'show'].includes(leadingKw);
    const isDdl = ['create', 'drop', 'alter', 'truncate', 'grant', 'revoke', 'comment', 'analyze', 'vacuum', 'reindex', 'refresh'].includes(leadingKw);
    const isSelect = leadingKw === 'select' || leadingKw === 'values';
    const isDml = ['insert', 'update', 'delete', 'with'].includes(leadingKw);
    const hasReturning = /\breturning\b/i.test(trimmedSql);

    // Control / DDL: no shape to json_agg over. Fire, return empty.
    if (isControl || isDdl) {
      await this.client.request(
        { method: 'tools/call', params: { name: 'execute_sql', arguments: { sql: trimmedSql } } },
        ExecuteSqlResultSchema,
      );
      return { rows: [] as T[], rowCount: 0 };
    }

    // Single wrap strategy so every DML/SELECT comes back as [{'_json': '[...]'}].
    let finalSql: string;
    if (isSelect) {
      finalSql = `SELECT COALESCE(json_agg(row_to_json(_t)), '[]'::json)::text AS _json FROM (${trimmedSql}) _t`;
    } else if (isDml) {
      const cteBody = hasReturning ? trimmedSql : `${trimmedSql} RETURNING 1`;
      finalSql = `WITH _cte AS (${cteBody}) SELECT COALESCE(json_agg(row_to_json(_cte)), '[]'::json)::text AS _json FROM _cte`;
    } else {
      // Unknown statement type — pass through, no parse.
      await this.client.request(
        { method: 'tools/call', params: { name: 'execute_sql', arguments: { sql: trimmedSql } } },
        ExecuteSqlResultSchema,
      );
      return { rows: [] as T[], rowCount: 0 };
    }

    const result = await this.client.request(
      { method: 'tools/call', params: { name: 'execute_sql', arguments: { sql: finalSql } } },
      ExecuteSqlResultSchema,
    );
    const raw: string = (result as any).content?.[0]?.text ?? '[]';

    // Single parse path: pythonReprToJson → JSON.parse → extract _json → unescape → JSON.parse.
    return parseMcpJsonAggResponse<T>(raw);
  }

  async insertReturning<T = Record<string, unknown>>(
    table: string,
    data: Record<string, unknown>,
  ): Promise<QueryResult<T>> {
    const columns = Object.keys(data).join(', ');
    const placeholders = Object.keys(data).map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING *`;
    return this.query<T>(sql, Object.values(data));
  }

  async transaction<T>(fn: (db: ExeMcpClient) => Promise<T>): Promise<T> {
    await this.query('BEGIN');
    try {
      const result = await fn(this);
      await this.query('COMMIT');
      return result;
    } catch (e) {
      await this.query('ROLLBACK');
      throw e;
    }
  }
}

// ── Pool wrapper (matches pg.Pool interface) ──────────────────────────────────

export class McpPool {
  constructor(private readonly client: ExeMcpClient) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.client.query<T>(sql, params);
  }

  async end(): Promise<void> {
    await this.client.close();
  }
}

let _pool: McpPool | null = null;

export async function getPool(): Promise<McpPool> {
  if (!_pool) {
    const client = new ExeMcpClient();
    await client.connect();
    _pool = new McpPool(client);
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// ── Stub to satisfy Pool.prototype.query type ─────────────────────────────────
// This is a no-op import that keeps the Pick<> happy at compile time.
class Pool {
  query(sql: string): Promise<unknown> {
    return Promise.resolve({ rows: [] });
  }
}
