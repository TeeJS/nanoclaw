/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  modelOverride?: string,
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);

        // Optionally override the model (e.g. switch from sonnet to haiku)
        if (modelOverride) {
          try {
            const parsed = JSON.parse(body.toString());
            parsed.model = modelOverride;
            body = Buffer.from(JSON.stringify(parsed));
          } catch {
            /* not JSON, forward as-is */
          }
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

/**
 * Local model proxy: translates Anthropic Messages API ↔ OpenAI Chat Completions.
 *
 * Handles tool use: translates Anthropic tool definitions → OpenAI tools, maps
 * tool_use/tool_result message history, and converts tool_call responses back to
 * Anthropic tool_use content blocks (both streaming and non-streaming).
 */
export function startLocalProxy(
  port: number,
  upstreamUrl: string,
  modelName: string,
  host = '127.0.0.1',
  contextWindow?: number,
  allowedTools?: string[],
): Promise<Server> {
  const upstream = new URL(upstreamUrl);
  const isHttps = upstream.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  type ContentBlock = {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: unknown;
  };
  type AnthropicMsg = { role: string; content: string | ContentBlock[] };
  type AnthropicTool = {
    name: string;
    description?: string;
    input_schema: unknown;
  };
  // LMToolCall — used for outgoing messages sent TO the local model (arguments as object)
  type LMToolCall = {
    function: { name: string; arguments: Record<string, unknown> };
  };
  // AccumulatedToolCall — used when reading FROM the local model streaming (arguments as concatenated string)
  type AccumulatedToolCall = {
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  };
  type LMMsg =
    | {
        role: 'system' | 'user' | 'assistant';
        content: string | null;
        tool_calls?: LMToolCall[];
      }
    | { role: 'tool'; content: string; tool_call_id?: string };

  // Merge incoming streaming tool call fragments into an accumulator array by index.
  // Ollama may stream tool call arguments as partial JSON strings across multiple chunks.
  function mergeToolCalls(
    acc: AccumulatedToolCall[],
    incoming: unknown[] | undefined,
  ): void {
    if (!incoming) return;
    for (let i = 0; i < incoming.length; i++) {
      const src = incoming[i] as {
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string | Record<string, unknown>;
        };
      };
      const argsToStr = (
        a: string | Record<string, unknown> | undefined,
      ): string => {
        if (a === undefined) return '';
        return typeof a === 'string' ? a : JSON.stringify(a);
      };
      if (!acc[i]) {
        acc[i] = {
          id: src.id,
          type: src.type,
          function: {
            name: src.function?.name,
            arguments: argsToStr(src.function?.arguments),
          },
        };
        continue;
      }
      const dst = acc[i];
      if (src.id) dst.id = src.id;
      if (src.type) dst.type = src.type;
      if (!dst.function) dst.function = {};
      if (src.function?.name) dst.function.name = src.function.name;
      if (src.function?.arguments !== undefined) {
        dst.function.arguments =
          (dst.function.arguments ?? '') + argsToStr(src.function.arguments);
      }
    }
  }

  // Extract plain text from Anthropic content (string or array of typed blocks)
  function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return (content as ContentBlock[])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .filter(Boolean)
        .join('\n');
    }
    return (content as ContentBlock)?.text ?? '';
  }

  // Trim a string to its last `maxChars` characters
  function trimTail(s: string, maxChars: number): string {
    return s.length > maxChars ? s.slice(-maxChars) : s;
  }

  // Strip <think>...</think> blocks from model output.
  // GLM-4.7-Flash (and similar) emit reasoning inside <think> tags before the answer.
  // Uses lastIndexOf so multiple think blocks are all stripped at once.
  function stripThinking(text: string): string {
    const idx = text.lastIndexOf('</think>');
    return idx >= 0
      ? text.slice(idx + 8).trim()
      : text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }

  // Translate Anthropic tool definitions → Ollama tools array (same schema as OpenAI)
  function translateToolDefs(tools: AnthropicTool[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema,
      },
    }));
  }

  // Translate Anthropic message history → OpenAI-compatible messages
  function translateMessages(msgs: AnthropicMsg[]): LMMsg[] {
    const out: LMMsg[] = [];
    for (const msg of msgs) {
      const content = msg.content;
      if (msg.role === 'assistant') {
        if (Array.isArray(content)) {
          // thinking blocks (type === 'thinking') are excluded by the type filter —
          // they are stripped in transmission and never sent to the local model.
          const textBlocks = content.filter((b) => b.type === 'text');
          const toolUseBlocks = content.filter((b) => b.type === 'tool_use');
          const textContent =
            stripThinking(
              textBlocks
                .map((b) => b.text ?? '')
                .join('\n')
                .trim(),
            ) || null;
          const ollamaMsg: LMMsg = {
            role: 'assistant',
            content: textContent,
          };
          if (toolUseBlocks.length > 0) {
            (
              ollamaMsg as {
                role: 'assistant';
                content: string | null;
                tool_calls?: LMToolCall[];
              }
            ).tool_calls = toolUseBlocks.map((b) => ({
              type: 'function' as const,
              function: {
                name: b.name ?? '',
                arguments:
                  typeof b.input === 'string'
                    ? (JSON.parse(b.input) as Record<string, unknown>)
                    : ((b.input ?? {}) as Record<string, unknown>),
              },
            }));
          }
          out.push(ollamaMsg);
        } else {
          const text = stripThinking(extractText(content));
          if (text) out.push({ role: 'assistant', content: text });
        }
      } else {
        // user role — may contain tool_result blocks
        if (Array.isArray(content)) {
          const toolResults = content.filter((b) => b.type === 'tool_result');
          const otherBlocks = content.filter((b) => b.type !== 'tool_result');
          for (const tr of toolResults) {
            out.push({
              role: 'tool',
              content:
                typeof tr.content === 'string'
                  ? tr.content
                  : extractText(tr.content),
            });
          }
          const text = extractText(otherBlocks);
          if (text) out.push({ role: 'user', content: text });
        } else {
          const text = extractText(content);
          if (text) out.push({ role: 'user', content: text });
        }
      }
    }
    return out;
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        // Only intercept /v1/messages (Anthropic Messages API)
        if (req.method !== 'POST' || !req.url?.includes('/v1/messages')) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        let anthropic: Record<string, unknown>;
        try {
          anthropic = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400);
          res.end('Bad Request');
          return;
        }

        // Build system string — trim to fit context window.
        const maxSystemChars = contextWindow
          ? Math.floor(contextWindow * 0.75)
          : Infinity;
        let systemText = extractText(anthropic.system ?? '');
        if (isFinite(maxSystemChars))
          systemText = trimTail(systemText, maxSystemChars);

        // Build OpenAI-compatible messages from Anthropic history
        const ollamaMessages: LMMsg[] = [];
        if (systemText)
          ollamaMessages.push({ role: 'system', content: systemText });
        ollamaMessages.push(
          ...translateMessages((anthropic.messages as AnthropicMsg[]) ?? []),
        );

        // Tools are pre-filtered by the agent-runner's dynamic classifier — pass them through as-is.
        // Cap tools for local models — large tool lists cause huge prompts and format errors.
        const allTools = (anthropic.tools as AnthropicTool[] | undefined) ?? [];
        const anthropicTools =
          allowedTools && allowedTools.length > 0
            ? allTools.filter((t) => allowedTools.includes(t.name))
            : allTools.slice(0, 3);
        const ollamaTools =
          anthropicTools.length > 0
            ? translateToolDefs(anthropicTools)
            : undefined;

        // Cap at 2048 — enough for reasoning + tool calls without overrunning KV cache.
        const maxTokens = Math.min(
          (anthropic.max_tokens as number) ?? 256,
          2048,
        );

        const isStream = !!anthropic.stream;
        // Force tool use on the first tool-eligible turn only. Without this, qwen3 reasons
        // endlessly and stops with end_turn without calling anything.
        // After a tool result the model is free to answer or call more tools (auto).
        const hasToolResult = ollamaMessages.some((m) => m.role === 'tool');
        const forceToolUse = !!(ollamaTools && !hasToolResult);

        // Use Ollama /api/chat endpoint — /v1/chat/completions ignores think:false
        // and leaks thinking tokens into content, making responses empty or garbled.
        const ollamaBody = JSON.stringify({
          model: modelName,
          messages: ollamaMessages,
          stream: isStream,
          think: false,
          ...(ollamaTools ? { tools: ollamaTools } : {}),
          ...(forceToolUse ? { tool_choice: 'required' } : {}),
          options: {
            num_predict: maxTokens,
            ...(anthropic.temperature !== undefined
              ? { temperature: anthropic.temperature as number }
              : {}),
          },
        });

        logger.info(
          {
            systemChars: systemText.length,
            msgCount: ollamaMessages.length,
            toolCount: anthropicTools.length,
            maxTokens,
            stream: isStream,
          },
          'Local proxy forwarding to Ollama/llama-cpp',
        );

        const upReq = makeRequest(
          {
            hostname: upstream.hostname,
            port: upstream.port || (isHttps ? 443 : 80),
            path: '/api/chat',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(ollamaBody),
              host: upstream.host,
            },
          } as RequestOptions,
          (upRes) => {
            if (isStream) {
              // Convert Ollama native ndjson stream → Anthropic SSE stream
              // Ollama streams one JSON object per line; thinking is in message.thinking (ignored),
              // text content in message.content, tool_calls arrive complete on the final done:true chunk.
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              });
              const msgId = `msg_${Date.now()}`;
              const send = (event: string, data: unknown) =>
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

              send('message_start', {
                type: 'message_start',
                message: {
                  id: msgId,
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: modelName,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 1 },
                },
              });
              send('ping', { type: 'ping' });

              let buf = '';
              let outTokens = 0;
              let nextBlockIndex = 0;
              let streamFinished = false;
              // Accumulate tool calls with proper fragment merging — Ollama may stream
              // tool call arguments as partial JSON strings across multiple chunks.
              const accToolCalls: AccumulatedToolCall[] = [];
              // Buffer all content — model may emit <think>...</think> reasoning before the answer.
              // We suppress content when there are tool calls; strip thinking tags for final answers.
              let contentBuf = '';

              // Shared helper: emit accumulated content/tools and close the stream
              const flushAndClose = (doneReason?: string) => {
                if (streamFinished || res.writableEnded) return;
                streamFinished = true;
                logger.info(
                  {
                    doneReason,
                    hasToolCalls: accToolCalls.length > 0,
                    contentLen: contentBuf.length,
                  },
                  'Local proxy: stream done',
                );
                const cleanText =
                  accToolCalls.length > 0 ? '' : stripThinking(contentBuf);
                if (cleanText) {
                  const textIdx = nextBlockIndex++;
                  send('content_block_start', {
                    type: 'content_block_start',
                    index: textIdx,
                    content_block: { type: 'text', text: '' },
                  });
                  send('content_block_delta', {
                    type: 'content_block_delta',
                    index: textIdx,
                    delta: { type: 'text_delta', text: cleanText },
                  });
                  send('content_block_stop', {
                    type: 'content_block_stop',
                    index: textIdx,
                  });
                }
                const hasToolCalls = accToolCalls.length > 0;
                if (hasToolCalls) {
                  logger.info(
                    {
                      toolCalls: accToolCalls.map((tc) => ({
                        name: tc.function?.name,
                        args: (tc.function?.arguments ?? '').slice(0, 200),
                      })),
                    },
                    'Local proxy: tool calls from model',
                  );
                  for (const tc of accToolCalls) {
                    const blockIdx = nextBlockIndex++;
                    const toolId = tc.id ?? `toolu_${Date.now()}_${blockIdx}`;
                    const rawArgs = tc.function?.arguments ?? '';
                    send('content_block_start', {
                      type: 'content_block_start',
                      index: blockIdx,
                      content_block: {
                        type: 'tool_use',
                        id: toolId,
                        name: tc.function?.name ?? 'unknown',
                        input: {},
                      },
                    });
                    send('content_block_delta', {
                      type: 'content_block_delta',
                      index: blockIdx,
                      delta: {
                        type: 'input_json_delta',
                        partial_json: rawArgs,
                      },
                    });
                    send('content_block_stop', {
                      type: 'content_block_stop',
                      index: blockIdx,
                    });
                  }
                }
                const stopReason = hasToolCalls
                  ? 'tool_use'
                  : doneReason === 'length'
                    ? 'max_tokens'
                    : 'end_turn';
                send('message_delta', {
                  type: 'message_delta',
                  delta: { stop_reason: stopReason, stop_sequence: null },
                  usage: { output_tokens: outTokens },
                });
                send('message_stop', { type: 'message_stop' });
                res.end();
              };

              upRes.on('data', (chunk: Buffer) => {
                buf += chunk.toString();
                const lines = buf.split('\n');
                buf = lines.pop() ?? '';
                for (const line of lines) {
                  if (!line.trim()) continue;
                  try {
                    // Auto-detect format: OpenAI SSE (data: {...}) vs Ollama native NDJSON
                    if (line.startsWith('data: ')) {
                      const data = line.slice(6).trim();
                      if (data === '[DONE]') {
                        flushAndClose('stop');
                        continue;
                      }
                      const chunk = JSON.parse(data) as {
                        choices?: Array<{
                          finish_reason?: string | null;
                          delta?: {
                            content?: string | null;
                            reasoning_content?: string | null;
                            tool_calls?: unknown[];
                          };
                        }>;
                      };
                      const choice = chunk.choices?.[0];
                      if (!choice) continue;
                      const delta = choice.delta;
                      if (delta?.content) {
                        contentBuf += delta.content;
                        outTokens++;
                      }
                      // reasoning_content: skip (thinking tokens, not part of the answer)
                      if (
                        delta?.tool_calls &&
                        Array.isArray(delta.tool_calls) &&
                        delta.tool_calls.length > 0
                      ) {
                        mergeToolCalls(accToolCalls, delta.tool_calls);
                      }
                      if (choice.finish_reason != null)
                        flushAndClose(choice.finish_reason);
                    } else {
                      // Ollama native NDJSON
                      const ev = JSON.parse(line) as {
                        done?: boolean;
                        done_reason?: string;
                        message?: {
                          content?: string;
                          thinking?: string;
                          tool_calls?: unknown[];
                        };
                      };
                      const msg = ev.message;
                      if (!msg) continue;
                      if (msg.content) {
                        contentBuf += msg.content;
                        outTokens++;
                      }
                      if (
                        msg.tool_calls &&
                        Array.isArray(msg.tool_calls) &&
                        msg.tool_calls.length > 0
                      ) {
                        mergeToolCalls(accToolCalls, msg.tool_calls);
                      }
                      if (ev.done) flushAndClose(ev.done_reason);
                    }
                  } catch {
                    /* skip malformed */
                  }
                }
              });

              upRes.on('end', () => {
                flushAndClose('end_turn');
              });
            } else {
              // Convert Ollama/OpenAI JSON response → Anthropic JSON response
              const rChunks: Buffer[] = [];
              upRes.on('data', (c: Buffer) => rChunks.push(c));
              upRes.on('end', () => {
                try {
                  const raw = JSON.parse(
                    Buffer.concat(rChunks).toString(),
                  ) as Record<string, unknown>;
                  if (raw.error) {
                    res.writeHead(500, { 'content-type': 'application/json' });
                    res.end(
                      JSON.stringify({
                        error: {
                          message:
                            (raw.error as { message?: string })?.message ??
                            String(raw.error),
                        },
                      }),
                    );
                    return;
                  }
                  // Detect OpenAI format (has choices array) vs Ollama native (has message)
                  let message:
                    | {
                        content?: string;
                        thinking?: string;
                        tool_calls?: LMToolCall[];
                      }
                    | undefined;
                  let doneReason: string;
                  if (Array.isArray(raw.choices)) {
                    const choice = (
                      raw.choices as Array<{
                        message?: {
                          content?: string;
                          tool_calls?: LMToolCall[];
                        };
                        finish_reason?: string;
                      }>
                    )[0];
                    message = choice?.message;
                    doneReason = choice?.finish_reason ?? 'stop';
                  } else {
                    const ollamaRes = raw as {
                      message?: {
                        content?: string;
                        thinking?: string;
                        tool_calls?: LMToolCall[];
                      };
                      done_reason?: string;
                    };
                    message = ollamaRes.message;
                    doneReason = ollamaRes.done_reason ?? 'stop';
                  }

                  const hasNonStreamToolCalls = !!message?.tool_calls?.length;
                  const rawText = message?.content ?? '';
                  const thinkIdx = rawText.lastIndexOf('</think>');
                  const cleanNonStreamText = hasNonStreamToolCalls
                    ? ''
                    : thinkIdx >= 0
                      ? rawText.slice(thinkIdx + 8).trim()
                      : rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

                  const contentBlocks: unknown[] = [];
                  if (cleanNonStreamText) {
                    contentBlocks.push({
                      type: 'text',
                      text: cleanNonStreamText,
                    });
                  }
                  if (
                    message?.tool_calls &&
                    Array.isArray(message.tool_calls)
                  ) {
                    for (const tc of message.tool_calls) {
                      const input =
                        typeof tc.function.arguments === 'string'
                          ? (JSON.parse(tc.function.arguments) as unknown)
                          : (tc.function.arguments ?? {});
                      contentBlocks.push({
                        type: 'tool_use',
                        id: `toolu_${Date.now()}_${contentBlocks.length}`,
                        name: tc.function.name,
                        input,
                      });
                    }
                  }
                  if (contentBlocks.length === 0)
                    contentBlocks.push({ type: 'text', text: '' });

                  const stopReason =
                    doneReason === 'length'
                      ? 'max_tokens'
                      : (message?.tool_calls?.length ?? 0) > 0
                        ? 'tool_use'
                        : 'end_turn';

                  const anthropicRes = {
                    id: `msg_${Date.now()}`,
                    type: 'message',
                    role: 'assistant',
                    model: modelName,
                    content: contentBlocks,
                    stop_reason: stopReason,
                    stop_sequence: null,
                    usage: {
                      input_tokens:
                        (raw.prompt_eval_count as number | undefined) ?? 0,
                      output_tokens:
                        (raw.eval_count as number | undefined) ?? 0,
                    },
                  };
                  const out = JSON.stringify(anthropicRes);
                  res.writeHead(200, {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(out),
                  });
                  res.end(out);
                } catch (err) {
                  logger.error(
                    { err },
                    'Local proxy: failed to parse response',
                  );
                  res.writeHead(502);
                  res.end('Bad Gateway');
                }
              });
            }
          },
        );

        upReq.on('error', (err) => {
          logger.error({ err }, 'Local proxy: upstream error');
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upReq.write(ollamaBody);
        upReq.end();
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, upstream: upstreamUrl, modelName, contextWindow },
        'Local model proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}
