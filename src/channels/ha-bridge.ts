/**
 * Home Assistant Voice Bridge — NanoClaw channel
 *
 * Exposes an HTTP server that accepts voice queries from Home Assistant,
 * injects them into NanoClaw's normal agent pipeline, and returns the
 * agent's response as JSON.
 *
 * To configure in Home Assistant:
 *   - "Extended OpenAI Conversation" (HACS): base URL = http://<this-host>:8765
 *   - Plain REST: POST http://<this-host>:8765/conversation  { "text": "..." }
 *
 * Port is controlled by the HA_BRIDGE_PORT env var (default: 8765).
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';

import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { setRegisteredGroup, storeChatMetadata } from '../db.js';
import { logger } from '../logger.js';
import { Channel, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// ── Constants ────────────────────────────────────────────────────────────────

const HA_JID = 'ha:home-assistant';
const HA_GROUP_FOLDER = 'ha_bridge';
const HA_GROUP_NAME = 'Home Assistant Voice Bridge';

/** Milliseconds of silence after the last agent chunk before we resolve. */
const DEBOUNCE_MS = 800;

/** Absolute maximum wait time for a single query (60 s). */
const MAX_WAIT_MS = 60_000;

const PORT = parseInt(process.env.HA_BRIDGE_PORT || '8765', 10);

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingResponse {
  chunks: string[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout>;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

// ── Channel implementation ───────────────────────────────────────────────────

export class HaBridgeChannel implements Channel {
  name = 'ha-bridge';

  private server: http.Server | null = null;
  private opts: ChannelOpts;
  private groupContext: string | null = null;

  /**
   * At most one HA query is in-flight through the agent at a time.
   * New HTTP requests wait in a promise chain until the previous one resolves.
   */
  private requestChain: Promise<void> = Promise.resolve();

  /**
   * The agent's response is streamed back via sendMessage(). We accumulate
   * chunks here and resolve once the stream goes quiet (debounce).
   */
  private pendingResponse: PendingResponse | null = null;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  // ── Channel interface ──────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.ensureGroupFolder();
    this.ensureGroupRegistered();
    this.loadGroupContext();

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    return new Promise<void>((resolve) => {
      this.server!.listen(PORT, '0.0.0.0', () => {
        logger.info({ port: PORT }, 'HA Bridge: HTTP server listening');
        console.log(`\n  HA Bridge listening on http://0.0.0.0:${PORT}`);
        console.log(`  Endpoints:`);
        console.log(`    GET  /health`);
        console.log(`    POST /conversation          { "text": "..." }`);
        console.log(`    POST /v1/chat/completions   (OpenAI format)\n`);
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    logger.info(
      { jid, bytes: text.length },
      'HA Bridge: received agent response chunk',
    );
    logger.debug({ preview: text.slice(0, 120) }, 'HA Bridge: chunk content');

    if (!this.pendingResponse) {
      logger.warn(
        { jid },
        'HA Bridge: sendMessage called with no pending request (ignoring)',
      );
      return;
    }

    this.pendingResponse.chunks.push(text);

    // Reset debounce — wait for the agent to finish streaming
    if (this.pendingResponse.debounceTimer) {
      clearTimeout(this.pendingResponse.debounceTimer);
    }
    this.pendingResponse.debounceTimer = setTimeout(() => {
      if (this.pendingResponse) {
        const full = this.pendingResponse.chunks.join('\n\n');
        logger.info(
          {
            chunks: this.pendingResponse.chunks.length,
            totalBytes: full.length,
          },
          'HA Bridge: debounce fired — resolving response',
        );
        this.pendingResponse.resolve(full);
      }
    }, DEBOUNCE_MS);
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('ha:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
      logger.info('HA Bridge: HTTP server stopped');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // No typing indicator for an HTTP bridge
  }

  // ── Setup helpers ──────────────────────────────────────────────────────────

  private ensureGroupFolder(): void {
    const groupDir = path.join(GROUPS_DIR, HA_GROUP_FOLDER);
    const logsDir = path.join(groupDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    logger.info({ dir: groupDir }, 'HA Bridge: group folder ensured');

    // Write a default CLAUDE.md if none exists
    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMd)) {
      fs.writeFileSync(
        claudeMd,
        `# Home Assistant Voice Bridge\n\n` +
          `You are ${ASSISTANT_NAME}, a smart home assistant integrated with Home Assistant.\n\n` +
          `## Response style\n\n` +
          `- Answers will be read aloud via a voice assistant — keep them short and conversational.\n` +
          `- Avoid markdown, bullet points, code blocks, or any formatting that doesn't read naturally.\n` +
          `- Prefer full sentences over lists.\n` +
          `- Be direct. No preamble like "Certainly!" or "Of course!".\n`,
      );
      logger.info({ claudeMd }, 'HA Bridge: created default CLAUDE.md');
    }
  }

  private ensureGroupRegistered(): void {
    // opts.registeredGroups() returns the live in-memory map from index.ts.
    // Mutating it here is intentional — it's the same reference.
    const groups = this.opts.registeredGroups();

    // Find the main Discord group's folder so HA shares the same workspace.
    // Falls back to ha_bridge if no main group is registered yet.
    const mainGroup = Object.values(groups).find((g) => g.isMain);
    const workspaceFolder = mainGroup?.folder ?? HA_GROUP_FOLDER;

    const group: RegisteredGroup = {
      name: HA_GROUP_NAME,
      folder: HA_GROUP_FOLDER,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: groups[HA_JID]?.added_at ?? new Date().toISOString(),
      requiresTrigger: false, // HA queries never carry a trigger prefix
      isMain: false,
      containerConfig: {
        // Share the main group's workspace so HA has the same CLAUDE.md and NAS access
        workspaceFolder,
        // Mirror the main group's additional mounts (e.g. NAS)
        additionalMounts: mainGroup?.containerConfig?.additionalMounts ?? [],
        keepWarm: true,
        timeout: 6 * 60 * 60 * 1000, // 6 hours
      },
    };

    // Persist to DB so it survives restarts
    setRegisteredGroup(HA_JID, group);

    // Inject into live in-memory map so this restart's message loop can route it
    groups[HA_JID] = group;

    // Register chat metadata (enables discovery / logging)
    storeChatMetadata(
      HA_JID,
      new Date().toISOString(),
      HA_GROUP_NAME,
      'ha-bridge',
      false,
    );

    logger.info(
      { jid: HA_JID, folder: HA_GROUP_FOLDER },
      'HA Bridge: group registered',
    );
  }

  private loadGroupContext(): void {
    const claudeMd = path.join(GROUPS_DIR, HA_GROUP_FOLDER, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      this.groupContext = fs.readFileSync(claudeMd, 'utf-8');
      logger.info({ claudeMd }, 'HA Bridge: loaded group context');
    }
  }

  // ── HTTP request handling ──────────────────────────────────────────────────

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = req.url?.split('?')[0] || '/';
    const method = (req.method || 'GET').toUpperCase();

    logger.info(
      { method, url, ip: req.socket.remoteAddress },
      'HA Bridge: request',
    );

    // Health check
    if (method === 'GET' && (url === '/health' || url === '/')) {
      this.sendJson(res, 200, {
        status: 'ok',
        service: 'nanoclaw-ha-bridge',
        jid: HA_JID,
        group: HA_GROUP_FOLDER,
      });
      return;
    }

    // OpenAI models list — Extended OpenAI Conversation integration fetches this on startup
    if (method === 'GET' && url === '/v1/models') {
      this.sendJson(res, 200, {
        object: 'list',
        data: [
          { id: 'nanoclaw', object: 'model', created: 0, owned_by: 'nanoclaw' },
        ],
      });
      return;
    }

    // Only accept POST for conversation endpoints
    const isConversation =
      url === '/conversation' ||
      url === '/chat/completions' ||
      url === '/v1/chat/completions' ||
      url === '/api/conversation/process';

    if (method === 'POST' && isConversation) {
      this.readBody(req, (err, body) => {
        if (err || !body) {
          logger.warn({ err }, 'HA Bridge: failed to read/parse request body');
          this.sendJson(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        logger.debug({ body }, 'HA Bridge: parsed body');
        this.dispatchQuery(req, res, url, body);
      });
      return;
    }

    this.sendJson(res, 404, { error: 'Not found', hint: 'POST /conversation' });
  }

  private readBody(
    req: http.IncomingMessage,
    cb: (err: Error | null, body: Record<string, unknown> | null) => void,
  ): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        cb(null, JSON.parse(raw));
      } catch (e) {
        cb(e as Error, null);
      }
    });
    req.on('error', (e) => cb(e, null));
  }

  private dispatchQuery(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    body: Record<string, unknown>,
  ): void {
    const text = this.extractText(body);
    if (!text) {
      logger.warn({ body }, 'HA Bridge: could not extract text from body');
      this.sendJson(res, 400, {
        error: 'No text found in request',
        hint: 'Provide { "text": "..." } or OpenAI messages array',
      });
      return;
    }

    logger.info({ text }, 'HA Bridge: query extracted — queuing');

    // Serialise requests: each new request waits for the previous to finish
    this.requestChain = this.requestChain.then(async () => {
      try {
        logger.info({ text }, 'HA Bridge: processing query');
        const response = await this.processQuery(text);
        logger.info(
          { responseBytes: response.length, preview: response.slice(0, 100) },
          'HA Bridge: query resolved — sending response',
        );
        const payload = this.buildResponse(url, body, response);
        this.sendJson(res, 200, payload);
      } catch (err) {
        logger.error({ err }, 'HA Bridge: unhandled error processing query');
        this.sendJson(res, 500, { error: 'Internal server error' });
      }
    });
  }

  // ── Text extraction — supports multiple HA / OpenAI request shapes ─────────

  private extractText(body: Record<string, unknown>): string | null {
    // Simple: { text: "..." }
    if (typeof body.text === 'string' && body.text.trim()) {
      return body.text.trim();
    }

    // HA voice pipeline: { input: { text: "..." } }
    const input = body.input as Record<string, unknown> | undefined;
    if (input && typeof input.text === 'string' && input.text.trim()) {
      return input.text.trim();
    }

    // OpenAI chat completions: { messages: [{ role, content }] }
    if (Array.isArray(body.messages)) {
      const msgs = body.messages as Array<{ role: string; content: unknown }>;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.trim()
        ) {
          return m.content.trim();
        }
      }
    }

    return null;
  }

  // ── Response building — matches the calling format ────────────────────────

  private buildResponse(
    url: string,
    requestBody: Record<string, unknown>,
    responseText: string,
  ): Record<string, unknown> {
    // OpenAI chat completions format
    if (
      url === '/v1/chat/completions' ||
      url === '/chat/completions' ||
      Array.isArray(requestBody.messages)
    ) {
      return {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'nanoclaw',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: responseText },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }

    // HA conversation response format
    const conversationId =
      typeof requestBody.conversation_id === 'string'
        ? requestBody.conversation_id
        : randomUUID();

    return {
      response: {
        response_type: 'action_done',
        speech: {
          plain: {
            speech: responseText,
            extra_data: null,
          },
        },
        language: requestBody.language ?? 'en',
        data: null,
      },
      conversation_id: conversationId,
    };
  }

  // ── Core: inject into NanoClaw pipeline and wait for agent response ────────

  private processQuery(text: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Safety: clear any leftover pending response from a previous timed-out request
      if (this.pendingResponse) {
        logger.warn(
          'HA Bridge: clearing stale pendingResponse before new query',
        );
        clearTimeout(this.pendingResponse.maxTimer);
        if (this.pendingResponse.debounceTimer) {
          clearTimeout(this.pendingResponse.debounceTimer);
        }
        this.pendingResponse = null;
      }

      // Max wait — fire even if debounce never settles
      const maxTimer = setTimeout(() => {
        if (this.pendingResponse) {
          const accumulated = this.pendingResponse.chunks.join('\n\n');
          logger.warn(
            { accumulated: accumulated.slice(0, 100) },
            'HA Bridge: max wait timeout — resolving with whatever we have',
          );
          this.pendingResponse.resolve(accumulated || '(no response received)');
        }
      }, MAX_WAIT_MS);

      this.pendingResponse = {
        chunks: [],
        debounceTimer: null,
        maxTimer,
        resolve: (t) => {
          clearTimeout(maxTimer);
          this.pendingResponse = null;
          resolve(t);
        },
        reject: (e) => {
          clearTimeout(maxTimer);
          this.pendingResponse = null;
          reject(e);
        },
      };

      // Inject message into NanoClaw as if sent from HA
      const msgId = randomUUID();
      const timestamp = new Date().toISOString();

      logger.info(
        { msgId, jid: HA_JID, text },
        'HA Bridge: injecting message into NanoClaw pipeline',
      );

      // Prepend group-specific CLAUDE.md so voice behavior instructions reach the
      // agent. The container mounts discord_main as /workspace/group (to share
      // HA config, NAS, etc.), so groups/ha_bridge/CLAUDE.md is never auto-loaded.
      const content = this.groupContext
        ? `${this.groupContext}\n\n---\n\n${text}`
        : text;

      this.opts.onMessage(HA_JID, {
        id: msgId,
        chat_jid: HA_JID,
        sender: 'home-assistant',
        sender_name: 'Home Assistant',
        content, // requiresTrigger=false, so no @Doof prefix needed
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
    });
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  private sendJson(
    res: http.ServerResponse,
    status: number,
    payload: Record<string, unknown>,
  ): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(payload));
  }
}

// ── Self-registration (runs on import) ───────────────────────────────────────

registerChannel('ha-bridge', (opts: ChannelOpts) => {
  return new HaBridgeChannel(opts);
});
