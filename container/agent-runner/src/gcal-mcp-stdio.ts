/**
 * Stdio MCP Server for Google Calendar integration.
 * Uses raw HTTP (no googleapis package) — Node 22 fetch is sufficient.
 *
 * Token file: /workspace/extra/nas/config/google-auth/token.json
 * Run setup/google-auth.py once on the host to generate it.
 *
 * Scope: calendar.readonly — to enable write access, re-run google-auth.py
 * with SCOPES set to 'https://www.googleapis.com/auth/calendar' and rebuild.
 */

import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TOKEN_PATH = '/workspace/extra/nas/config/google-auth/token.json';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// ── Token management ──────────────────────────────────────────────────────────

interface TokenData {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number; // ms since epoch
  client_id: string;
  client_secret: string;
}

function readToken(): TokenData {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      `Google Calendar token not found at ${TOKEN_PATH}. Run setup/google-auth.py on the host first.`
    );
  }
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8')) as TokenData;
}

function writeToken(token: TokenData): void {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

async function refreshAccessToken(token: TokenData): Promise<TokenData> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: token.client_id,
      client_secret: token.client_secret,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  const updated: TokenData = {
    ...token,
    access_token: data.access_token,
    expiry_date: Date.now() + data.expires_in * 1000,
  };
  writeToken(updated);
  return updated;
}

async function getAccessToken(): Promise<string> {
  let token = readToken();
  if (Date.now() > token.expiry_date - 5 * 60 * 1000) {
    token = await refreshAccessToken(token);
  }
  return token.access_token;
}

// ── API helper ────────────────────────────────────────────────────────────────

async function calGet(path: string, params?: Record<string, string>): Promise<unknown> {
  const accessToken = await getAccessToken();
  const url = new URL(`${CALENDAR_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Calendar API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(e: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'gcal', version: '1.0.0' });

server.tool(
  'gcal_list_calendars',
  'List all Google Calendars the user has access to. Returns calendar IDs, names, and descriptions.',
  {},
  async () => {
    try { return ok(await calGet('/users/me/calendarList')); } catch (e) { return err(e); }
  },
);

server.tool(
  'gcal_list_events',
  'List events from a Google Calendar. Use gcal_list_calendars first to get valid calendar IDs. Defaults to the primary calendar.',
  {
    calendar_id: z.string().default('primary').describe(
      'Calendar ID ("primary" for main calendar, or an ID from gcal_list_calendars)'
    ),
    time_min: z.string().optional().describe('Start of time range (ISO 8601, e.g. "2026-03-24T00:00:00Z")'),
    time_max: z.string().optional().describe('End of time range (ISO 8601)'),
    query: z.string().optional().describe('Free-text search within event titles and descriptions'),
    max_results: z.number().int().min(1).max(250).default(50).describe('Max events to return (default 50)'),
  },
  async (args) => {
    try {
      const params: Record<string, string> = {
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(args.max_results),
      };
      if (args.time_min) params.timeMin = args.time_min;
      if (args.time_max) params.timeMax = args.time_max;
      if (args.query) params.q = args.query;
      return ok(await calGet(`/calendars/${encodeURIComponent(args.calendar_id)}/events`, params));
    } catch (e) { return err(e); }
  },
);

server.tool(
  'gcal_get_event',
  'Get a single calendar event by ID.',
  {
    calendar_id: z.string().describe('Calendar ID the event belongs to'),
    event_id: z.string().describe('Event ID (from gcal_list_events)'),
  },
  async (args) => {
    try {
      return ok(await calGet(
        `/calendars/${encodeURIComponent(args.calendar_id)}/events/${encodeURIComponent(args.event_id)}`
      ));
    } catch (e) { return err(e); }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
