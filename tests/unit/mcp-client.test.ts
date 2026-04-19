import { describe, expect, it } from 'vitest';
import { parseMcpJsonAggResponse, pythonReprToJson } from '../../src/db/mcp-client';

describe('pythonReprToJson', () => {
  it('parses a dict with a single-quoted key', () => {
    expect(pythonReprToJson(`{'a': 1}`)).toBe(`{"a":1}`);
  });

  it('escapes embedded double quotes in single-quoted strings', () => {
    expect(pythonReprToJson(`'[{"n":1}]'`)).toBe(`"[{\\"n\\":1}]"`);
  });

  it('handles None / True / False / null-ish', () => {
    expect(pythonReprToJson(`{'a': None, 'b': True, 'c': False}`)).toBe(
      `{"a":null,"b":true,"c":false}`,
    );
  });

  it('parses the real MCP json_agg wrapper shape', () => {
    const raw = `[{'_json': '[{"n":2591}]'}]`;
    const json = pythonReprToJson(raw);
    const outer = JSON.parse(json) as Array<{ _json: string }>;
    expect(outer).toHaveLength(1);
    expect(JSON.parse(outer[0]._json)).toEqual([{ n: 2591 }]);
  });
});

describe('parseMcpJsonAggResponse', () => {
  it('returns empty when the outer array is empty', () => {
    expect(parseMcpJsonAggResponse(`[]`)).toEqual({ rows: [], rowCount: 0 });
  });

  it('returns rows from the real SELECT shape', () => {
    const raw = `[{'_json': '[{"n":2591}]'}]`;
    expect(parseMcpJsonAggResponse(raw)).toEqual({
      rows: [{ n: 2591 }],
      rowCount: 1,
    });
  });

  it('returns the row from a DML with RETURNING', () => {
    const raw = `[{'_json': '[{"id":13422,"source":"smoke","source_id":"smoke-1776621383093"}]'}]`;
    expect(parseMcpJsonAggResponse(raw)).toEqual({
      rows: [{ id: 13422, source: 'smoke', source_id: 'smoke-1776621383093' }],
      rowCount: 1,
    });
  });

  it('returns rowCount=1 for a bare DML wrapped with RETURNING 1', () => {
    const raw = `[{'_json': '[{"?column?":1}]'}]`;
    const result = parseMcpJsonAggResponse(raw);
    expect(result.rowCount).toBe(1);
  });

  it('throws on malformed input instead of silently returning empty', () => {
    expect(() => parseMcpJsonAggResponse(`not a repr`)).toThrow();
  });
});
