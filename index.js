import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const name = 'image-chain';

export const inject = ['llm', 'tools', 'fs', 'webServer', 'sessions'];

/** Bump on every behavioural change so the Host log proves which generation is live. */
const BUILD = 'always-connected/2026-10-17.4';

const DEFAULT_CHAINS = [
  {
    id: 'chain-default-image',
    name: '默认绘画链路',
    type: 'image',
    enabled: true,
    imageConfig: {
      promptModelProvider: 'cpa',
      promptModelId: 'gemini-3.8-flash-high',
      imageModelProvider: 'cpa',
      imageModelId: 'gemini-3.1-flash-image',
      saveDirectory: 'images/generated'
    }
  },
  {
    id: 'chain-resilient-chat',
    name: '高可用容灾对话链路',
    type: 'chat',
    enabled: true,
    chatConfig: {
      maxRetriesPerModel: 5,
      models: [
        { provider: 'cpa', model: 'gemini-3.8-flash-high' },
        { provider: 'cpa', model: 'claude-sonnet-4-6' },
        { provider: 'workbuddypanel', model: 'cn:deepseek-v4.1-flash' }
      ]
    }
  }
];

const DEFAULT_PROMPT_INSTRUCTION =
  "You are an expert AI image prompt engineer. Convert the user's drawing request into an exquisite, highly-detailed English prompt for image generation.";

/* ------------------------------------------------------------------ *
 * Persistent store — the single source of truth for user chains.
 * Lives outside the package so reinstalling / upgrading never touches it.
 * ------------------------------------------------------------------ */

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

const STORAGE_DIR = path.join(dshHome(), 'storages', 'always-connected');
const STORAGE_FILE = path.join(STORAGE_DIR, 'chains.json');

function sanitizeChains(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue;
    if (typeof raw.id !== 'string' || raw.id.trim() === '') continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    out.push({
      ...raw,
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : raw.id,
      type: raw.type === 'image' ? 'image' : 'chat',
      enabled: raw.enabled !== false
    });
  }
  return out.length > 0 ? out : null;
}

function loadPersistedChains() {
  try {
    if (!fs.existsSync(STORAGE_FILE)) return null;
    return sanitizeChains(JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8')));
  } catch {
    return null;
  }
}

function savePersistedChains(chains) {
  const clean = sanitizeChains(chains);
  if (clean === null) return false;
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    const tmp = `${STORAGE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
    fs.renameSync(tmp, STORAGE_FILE);
    return true;
  } catch (error) {
    console.error(`[${BUILD}] cannot persist chains:`, error);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Provider directory: read straight from the live profile patch.
 * ------------------------------------------------------------------ */

function readProfileText() {
  const candidates = [
    process.env.DSH_PROFILE_DIR ? path.join(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml') : undefined,
    path.join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml')
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    } catch {}
  }
  return '';
}

function parseProviders(text) {
  const providers = [];
  if (!text) return providers;
  const lines = text.split('\n');
  let inPiAi = false;
  let inProviders = false;
  let current = null;
  let inModels = false;

  for (const line of lines) {
    if (/^\s*-?\s*id:\s*llm-pi-ai\s*$/.test(line)) {
      inPiAi = true;
      continue;
    }
    if (inPiAi && /^[^\s#]/.test(line) && !/^\s*-/.test(line)) {
      inPiAi = false;
      inProviders = false;
      current = null;
    }
    if (!inPiAi) continue;

    if (/^\s*providers:\s*$/.test(line)) {
      inProviders = true;
      continue;
    }
    if (!inProviders) continue;

    const prov = line.match(/^ {6}([A-Za-z0-9_.-]+):\s*$/);
    if (prov) {
      current = { id: prov[1], displayName: prov[1], baseURL: '', apiKeyEnv: '', models: [] };
      providers.push(current);
      inModels = false;
      continue;
    }
    if (!current) continue;

    const display = line.match(/^ {8}displayName:\s*(.+)$/);
    if (display) { current.displayName = display[1].trim().replace(/^["']|["']$/g, ''); continue; }
    const base = line.match(/^ {8}baseURL:\s*(.+)$/);
    if (base) { current.baseURL = base[1].trim().replace(/^["']|["']$/g, ''); continue; }
    const keyEnv = line.match(/^ {8}apiKeyEnv:\s*(.+)$/);
    if (keyEnv) { current.apiKeyEnv = keyEnv[1].trim().replace(/^["']|["']$/g, ''); continue; }
    if (/^ {8}models:\s*$/.test(line)) { inModels = true; continue; }

    if (inModels) {
      const idMatch = line.match(/^ {10,14}-\s*id:\s*(.+)$/);
      if (idMatch) {
        const id = idMatch[1].trim().replace(/^["']|["']$/g, '');
        current.models.push({ id, name: id });
        continue;
      }
      const nameMatch = line.match(/^ {12,16}name:\s*(.+)$/);
      if (nameMatch && current.models.length > 0) {
        current.models[current.models.length - 1].name =
          nameMatch[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  return providers;
}

function listProviders() {
  return parseProviders(readProfileText());
}

function readCredential(name) {
  if (!name) return '';
  if (process.env[name]) return process.env[name];
  try {
    const text = fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8');
    const match = text.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'));
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
  return '';
}

function resolveEndpoint(providerId) {
  const provider = listProviders().find(p => p.id === providerId);
  if (!provider) {
    return { baseURL: 'http://127.0.0.1:8317/v1', apiKey: readCredential('CPA_API_KEY') || 'sk-cpa-local' };
  }
  let apiKey = readCredential(provider.apiKeyEnv);
  if (!apiKey && provider.id === 'cpa') apiKey = 'sk-cpa-local';
  return {
    baseURL: (provider.baseURL || 'http://127.0.0.1:8317/v1').replace(/\/+$/, ''),
    apiKey
  };
}

/* ------------------------------------------------------------------ *
 * Workspace resolution — never guess through process.cwd().
 * ------------------------------------------------------------------ */

function sessionCwd(ctx, sessionId) {
  try {
    if (!sessionId) return undefined;
    const session = ctx?.sessions?.get?.(sessionId);
    const cwd = session?.header?.cwd;
    if (typeof cwd === 'string' && cwd) return cwd;
  } catch {}
  return undefined;
}

function defaultWorkspace() {
  try {
    const file = path.join(dshHome(), 'storages', 'workspace.json');
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const id = data?.global?.defaultWorkspaceId;
      const dir = data?.tables?.workspaces?.[id]?.path;
      if (typeof dir === 'string' && dir) return dir;
    }
  } catch {}
  return process.cwd();
}

function resolveWorkspace(ctx, sessionId) {
  return sessionCwd(ctx, sessionId) || defaultWorkspace();
}

/* ------------------------------------------------------------------ *
 * Message / tool conversion.
 * ------------------------------------------------------------------ */

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && part.type === 'text')
    .map(part => part.text || '')
    .join('\n');
}

function convertMessages(messages, system) {
  const out = [];
  if (typeof system === 'string' && system.trim()) out.push({ role: 'system', content: system.trim() });

  for (const message of messages || []) {
    const text = flattenContent(message?.content);
    const toolCalls = Array.isArray(message?.content)
      ? message.content.filter(p => p && p.type === 'tool-call').map(p => ({
          id: String(p.id || ''),
          type: 'function',
          function: {
            name: p.name || '',
            arguments: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {})
          }
        }))
      : [];

    switch (message?.role) {
      case 'developer':
      case 'system':
        out.push({ role: 'system', content: text });
        break;
      case 'user':
        out.push({ role: 'user', content: text });
        break;
      case 'assistant': {
        const entry = { role: 'assistant', content: text || '' };
        const calls = toolCalls.length > 0 ? toolCalls : (Array.isArray(message.toolCalls) ? message.toolCalls : []);
        if (calls.length > 0) entry.tool_calls = calls;
        out.push(entry);
        break;
      }
      case 'tool':
        out.push({
          role: 'tool',
          tool_call_id: String(message.toolCallId || message.source?.callId || ''),
          content: text || ''
        });
        break;
      default:
        break;
    }
  }
  return out;
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} }
    }
  }));
}

/* ------------------------------------------------------------------ *
 * Prompt cleanup.
 * ------------------------------------------------------------------ */

function cleanGeneratedPrompt(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim();

  const quoted = text.match(/^\s*>\s*([\s\S]+)$/m);
  const quoteLines = text.match(/^>\s*(.+)$/gm);
  if (quoteLines && quoteLines.length > 0) {
    const merged = quoteLines.map(line => line.replace(/^>\s*/, '').trim()).join(' ');
    if (merged.length > 30) text = merged;
  } else if (quoted && quoted[1] && quoted[1].trim().length > 30) {
    text = quoted[1].trim();
  } else {
    const afterHeader = text.match(/(?:core\s+)?(?:image\s+)?prompt[：:]\s*\n+([\s\S]+?)(?:\n+---|\n+###|\n+中文|$)/i);
    if (afterHeader && afterHeader[1].trim().length > 20) text = afterHeader[1].trim();
  }

  text = text.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  text = text.replace(/^\*\*([\s\S]+)\*\*$/m, '$1').trim();
  text = text.replace(/^(image\s+)?prompt:\s*/i, '').trim();
  text = text.replace(/^\*\*|\*\*$/g, '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('`') && text.endsWith('`'))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Painting chain.
 * ------------------------------------------------------------------ */

/** Chat markdown only resolves IMAGE destinations that are absolute paths (fileMediaUrl). */
function markdownPath(workspace, file) {
  return encodeURI(file);
}

async function callJson(url, apiKey, body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON: ${text.slice(0, 200)}`);
  }
}

async function executePaintingChain(chain, userPrompt, workspace, options = {}) {
  if (!userPrompt || !userPrompt.trim()) throw new Error('绘画要求不能为空。');

  const conf = chain.imageConfig || {};
  const promptEndpoint = resolveEndpoint(conf.promptModelProvider || 'cpa');
  const imageEndpoint = resolveEndpoint(conf.imageModelProvider || 'cpa');
  const signal = options.signal;

  const instruction = typeof conf.promptSystemInstruction === 'string' && conf.promptSystemInstruction.trim()
    ? conf.promptSystemInstruction.trim()
    : DEFAULT_PROMPT_INSTRUCTION;

  const a = await callJson(
    `${promptEndpoint.baseURL}/chat/completions`,
    promptEndpoint.apiKey,
    {
      model: conf.promptModelId || 'gemini-3.8-flash-high',
      messages: [
        {
          role: 'system',
          content: `${instruction}\n\nCRITICAL: output ONLY the raw descriptive English prompt. No greetings, no headers, no Chinese translation, no bullet list, no code fence.`
        },
        { role: 'user', content: userPrompt.trim() }
      ],
      temperature: 0.7
    },
    signal
  );

  const generated = cleanGeneratedPrompt(a?.choices?.[0]?.message?.content);
  if (!generated) throw new Error('提示词模型未返回可用提示词。');

  const request = /^(generate|draw|create)\s+an?\s+image/i.test(generated)
    ? generated
    : `Generate an image: ${generated}`;

  const b = await callJson(
    `${imageEndpoint.baseURL}/chat/completions`,
    imageEndpoint.apiKey,
    { model: conf.imageModelId || 'gemini-3.1-flash-image', messages: [{ role: 'user', content: request }] },
    signal
  );

  const message = b?.choices?.[0]?.message;
  let base64 = null;
  let ext = 'jpg';

  const candidates = [];
  if (Array.isArray(message?.images)) {
    for (const image of message.images) {
      candidates.push(typeof image === 'string' ? image : (image?.image_url?.url || image?.url || ''));
    }
  }
  if (typeof message?.content === 'string') candidates.push(message.content);

  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.length < 64) continue;
    const dataUrl = raw.match(/data:image\/([A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/);
    if (dataUrl) {
      ext = dataUrl[1].toLowerCase() === 'jpeg' ? 'jpg' : dataUrl[1].toLowerCase();
      base64 = dataUrl[2].replace(/\s+/g, '');
      break;
    }
    if (/^[A-Za-z0-9+/=]{512,}$/.test(raw.trim())) {
      base64 = raw.trim();
      break;
    }
  }

  if (!base64) {
    const hint = typeof message?.content === 'string' ? message.content.slice(0, 200) : '';
    throw new Error(`绘画模型未返回图像数据${hint ? `（它说：${hint}）` : ''}。`);
  }

  const dir = conf.saveDirectory || 'images/generated';
  const target = path.isAbsolute(dir) ? dir : path.join(workspace, dir);
  fs.mkdirSync(target, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const file = path.join(target, `img_${stamp}_${crypto.randomBytes(3).toString('hex')}.${ext}`);
  const buffer = Buffer.from(base64, 'base64');
  fs.writeFileSync(file, buffer);

  return {
    generatedPrompt: generated,
    absoluteFilePath: file,
    relativePath: path.relative(workspace, file),
    markdownPath: markdownPath(workspace, file),
    sizeBytes: buffer.length,
    modelA: conf.promptModelId || 'gemini-3.8-flash-high',
    modelB: conf.imageModelId || 'gemini-3.1-flash-image'
  };
}

/* ------------------------------------------------------------------ *
 * SSE plumbing.
 * ------------------------------------------------------------------ */

async function* sseEvents(reader, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    if (signal?.aborted) throw new Error('请求已取消');
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      if (!payload) continue;
      try {
        yield JSON.parse(payload);
      } catch {}
    }
  }
}

function deltaHasContent(delta) {
  if (!delta) return false;
  if (typeof delta.content === 'string' && delta.content.length > 0) return true;
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return true;
  return Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
}

function retriableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/* ------------------------------------------------------------------ *
 * Adapter.
 * ------------------------------------------------------------------ */

class FreeChainAdapter {
  constructor(getConfig, ctx) {
    this.getConfig = getConfig;
    this.ctx = ctx;
  }

  providerInfo(provider) {
    return { id: provider, name: '🔗 自由模型链路' };
  }

  providerRetryPolicy() {
    return undefined;
  }

  imageRequestPricing() {
    return undefined;
  }

  listModels(provider) {
    const chains = (this.getConfig().chains || []).filter(chain => chain.enabled !== false);
    return Promise.resolve(chains.map(chain => {
      if (chain.type === 'image') {
        const conf = chain.imageConfig || {};
        return {
          provider,
          id: chain.id,
          name: `🎨 [绘图] ${chain.name} (${conf.promptModelId || '提示词'} ➔ ${conf.imageModelId || '绘图'})`,
          description: '双模型绘画链路：模型 A 扩写提示词，模型 B 渲染出图'
        };
      }
      const conf = chain.chatConfig || {};
      const order = (conf.models || []).map(m => m.model).join(' ➔ ');
      return {
        provider,
        id: chain.id,
        name: `⚡️ [对话] ${chain.name} (${order || '未配置模型'})`,
        description: `容灾对话链路：单模型重试 ${conf.maxRetriesPerModel || 5} 次，失败后按序切换下一模型`
      };
    }));
  }

  resolveModel(provider, model) {
    const chain = (this.getConfig().chains || []).find(item => item.id === model);
    let name = `自由链路 (${model})`;
    if (chain) {
      if (chain.type === 'image') {
        const conf = chain.imageConfig || {};
        name = `🎨 [绘图] ${chain.name} (${conf.promptModelId} ➔ ${conf.imageModelId})`;
      } else {
        const conf = chain.chatConfig || {};
        name = `⚡️ [对话] ${chain.name} (${(conf.models || []).map(m => m.model).join(' ➔ ')})`;
      }
    }
    return Promise.resolve({
      provider,
      id: model,
      name,
      context: { contextWindow: 1048576 },
      defaultMaxTokens: 8192
    });
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options)
    };
  }

  async *stream(options) {
    const chain = (this.getConfig().chains || []).find(item => item.id === options.model);
    if (!chain) {
      const text = `❌ 未找到 id 为 \`${options.model}\` 的链路，请到「设置 → 🔗 模型自由链路设置」检查。`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (chain.type === 'image') {
      yield* this.streamImageChain(chain, options);
    } else {
      yield* this.streamChatChain(chain, options);
    }
  }

  async *streamImageChain(chain, options) {
    const workspace = resolveWorkspace(this.ctx, options.sessionId);
    const messages = options.messages || [];
    let prompt = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        prompt = flattenContent(messages[i].content);
        break;
      }
    }
    if (!prompt.trim()) prompt = '一只可爱的蓝白小鲸鱼';

    const conf = chain.imageConfig || {};
    const header = `🎨 **绘画链路「${chain.name}」**\n\n` +
      `* 模型 A（提示词）：\`${conf.promptModelProvider || 'cpa'} / ${conf.promptModelId || '—'}\`\n` +
      `* 模型 B（绘图）：\`${conf.imageModelProvider || 'cpa'} / ${conf.imageModelId || '—'}\`\n\n`;

    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: `${header}⏳ 正在生成提示词并绘制...\n` };

    let text = `${header}⏳ 正在生成提示词并绘制...\n`;
    try {
      const result = await executePaintingChain(chain, prompt, workspace, { signal: options.signal });
      const tail =
        `\n✅ **完成**\n\n` +
        `**扩写后的提示词**\n\n> ${result.generatedPrompt.replace(/\n/g, '\n> ')}\n\n` +
        `![生成的绘画作品](${result.markdownPath})\n\n` +
        `📁 \`${result.relativePath}\` (${Math.round(result.sizeBytes / 1024)} KB)\n`;
      text += tail;
      yield { type: 'text-delta', index: 0, text: tail };
    } catch (error) {
      const message = typeof error?.message === 'string' ? error.message : String(error);
      const tail = `\n❌ **绘画失败**：${message}\n`;
      text += tail;
      yield { type: 'text-delta', index: 0, text: tail };
    }

    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: Math.max(1, Math.round(prompt.length / 3)), outputTokens: Math.max(1, Math.round(text.length / 3)) } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  async *streamChatChain(chain, options) {
    const conf = chain.chatConfig || {};
    const candidates = (Array.isArray(conf.models) ? conf.models : [])
      .filter(item => item && item.provider && item.model)
      .slice(0, 8);
    const attempts = Math.min(10, Math.max(1, Number(conf.maxRetriesPerModel) || 5));

    if (candidates.length === 0) {
      const text = `⚠️ 链路「${chain.name}」还没有配置任何模型，请到设置里添加。`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    const messages = convertMessages(options.messages, options.system);
    const tools = convertTools(options.tools);
    const failures = [];

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const endpoint = resolveEndpoint(candidate.provider);
      const label = `${candidate.provider} / ${candidate.model}`;
      let lastError = '';

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        options.signal?.addEventListener?.('abort', onAbort, { once: true });
        let timer;

        try {
          const body = {
            model: candidate.model,
            messages,
            stream: true,
            temperature: options.temperature ?? 0.7
          };
          if (options.maxTokens) body.max_tokens = options.maxTokens;
          if (tools) body.tools = tools;

          timer = setTimeout(() => controller.abort(), 90_000);
          const response = await fetch(`${endpoint.baseURL}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
          });

          if (!response.ok) {
            const detail = (await response.text()).slice(0, 200);
            const error = new Error(`HTTP ${response.status}: ${detail}`);
            error.retriable = retriableStatus(response.status);
            throw error;
          }
          if (!response.body) throw new Error('响应没有可读流');

          const events = sseEvents(response.body.getReader(), controller.signal);
          const iterator = events[Symbol.asyncIterator]();
          const buffered = [];
          let meaningful = false;
          let finishReason = null;

          // Peek with an explicit iterator: breaking a `for await` would call
          // iterator.return() and close the very stream we still need to read.
          while (true) {
            const step = await iterator.next();
            if (step.done) break;
            const event = step.value;
            buffered.push(event);
            const choice = event?.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (deltaHasContent(choice?.delta)) {
              meaningful = true;
              break;
            }
          }
          clearTimeout(timer);
          timer = undefined;

          if (!meaningful) {
            await iterator.return?.();
            if (finishReason === 'malformed_function_call') {
              throw new Error('上游返回 malformed_function_call（畸形工具调用）');
            }
            throw new Error(`上游返回空响应（finish_reason: ${finishReason || 'unknown'}）`);
          }

          // Committed: this model answered, stream the rest live.
          const state = {
            textOpen: false,
            reasoningOpen: false,
            text: '',
            toolBlocks: new Map(),
            toolBuffers: new Map(),
            hadToolCalls: false,
            nextIndex: 0,
            textIndex: 0,
            reasoningIndex: 0
          };

          if (failures.length > 0) {
            const note = `> ⚠️ 已自动切换：次序 ${index + 1} · \`${label}\`\n\n`;
            state.textIndex = state.nextIndex++;
            state.textOpen = true;
            state.text += note;
            yield { type: 'block-start', index: state.textIndex, blockType: 'text' };
            yield { type: 'text-delta', index: state.textIndex, text: note };
          }

          const emit = event => this.emitEvent(event, state);
          for (const event of buffered) {
            for (const chunk of emit(event)) yield chunk;
          }
          while (true) {
            const step = await iterator.next();
            if (step.done) break;
            const event = step.value;
            if (finishReason === null) {
              const reason = event?.choices?.[0]?.finish_reason;
              if (reason) finishReason = reason;
            }
            for (const chunk of emit(event)) yield chunk;
          }

          for (const chunk of this.closeBlocks(state)) yield chunk;

          yield {
            type: 'usage',
            usage: {
              inputTokens: Math.max(1, Math.round(JSON.stringify(messages).length / 4)),
              outputTokens: Math.max(1, Math.round(state.text.length / 3))
            }
          };
          yield { type: 'finish', reason: state.hadToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' } };
          return;
        } catch (error) {
          clearTimeout(timer);
          lastError = error?.name === 'AbortError' ? '连接或首字超时' : (error?.message || String(error));
          const retriable = error?.retriable !== false;
          if (options.signal?.aborted) {
            const text = `\n\n_已取消_\n`;
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text };
            yield { type: 'block-end', index: 0, block: { type: 'text', text } };
            yield { type: 'finish', reason: { kind: 'stop' } };
            return;
          }
          if (!retriable) break;
          if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, Math.min(400 * attempt, 1500)));
        } finally {
          options.signal?.removeEventListener?.('abort', onAbort);
        }
      }

      failures.push({ order: index + 1, label, error: lastError });
    }

    const lines = [
      `❌ **链路「${chain.name}」全部模型不可用**`,
      '',
      `每个模型最多尝试 ${attempts} 次：`,
      ...failures.map(item => `* 次序 ${item.order} · \`${item.label}\` — ${item.error}`),
      '',
      '请检查网络、代理端口或各 Provider 的凭据。'
    ];
    const text = lines.join('\n');
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  emitEvent(event, state) {
    const chunks = [];
    const choice = event?.choices?.[0];
    const delta = choice?.delta;
    if (!delta) return chunks;

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      if (!state.reasoningOpen) {
        state.reasoningIndex = state.nextIndex++;
        chunks.push({ type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' });
        state.reasoningOpen = true;
      }
      chunks.push({ type: 'reasoning-delta', index: state.reasoningIndex, text: delta.reasoning_content });
    }

    if (typeof delta.content === 'string' && delta.content) {
      if (state.reasoningOpen) {
        chunks.push({ type: 'block-end', index: state.reasoningIndex, block: { type: 'reasoning', text: '' } });
        state.reasoningOpen = false;
      }
      if (!state.textOpen) {
        state.textIndex = state.nextIndex++;
        chunks.push({ type: 'block-start', index: state.textIndex, blockType: 'text' });
        state.textOpen = true;
      }
      state.text += delta.content;
      chunks.push({ type: 'text-delta', index: state.textIndex, text: delta.content });
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      if (state.textOpen) {
        chunks.push({ type: 'block-end', index: state.textIndex, block: { type: 'text', text: state.text } });
        state.textOpen = false;
      }
      if (state.reasoningOpen) {
        chunks.push({ type: 'block-end', index: state.reasoningIndex, block: { type: 'reasoning', text: '' } });
        state.reasoningOpen = false;
      }

      for (const call of delta.tool_calls) {
        const key = call.index ?? 0;
        if (!state.toolBuffers.has(key)) {
          const buffer = {
            id: call.id || `call_${Date.now().toString(36)}_${key}`,
            name: call.function?.name || '',
            arguments: ''
          };
          state.toolBuffers.set(key, buffer);
          state.hadToolCalls = true;
          const blockIndex = state.nextIndex++;
          state.toolBlocks.set(key, blockIndex);
          chunks.push({ type: 'block-start', index: blockIndex, blockType: 'tool-call' });
        }
        const buffer = state.toolBuffers.get(key);
        if (call.id) buffer.id = call.id;
        if (call.function?.name) buffer.name = call.function.name;
        const piece = call.function?.arguments || '';
        if (piece) {
          buffer.arguments += piece;
          chunks.push({
            type: 'tool-call-delta',
            index: state.toolBlocks.get(key),
            id: buffer.id,
            name: buffer.name,
            argumentsDelta: piece
          });
        }
      }
    }

    return chunks;
  }

  closeBlocks(state) {
    const chunks = [];
    if (state.textOpen) {
      chunks.push({ type: 'block-end', index: state.textIndex, block: { type: 'text', text: state.text } });
      state.textOpen = false;
    }
    if (state.reasoningOpen) {
      chunks.push({ type: 'block-end', index: state.reasoningIndex, block: { type: 'reasoning', text: '' } });
      state.reasoningOpen = false;
    }
    for (const [key, buffer] of state.toolBuffers) {
      chunks.push({
        type: 'block-end',
        index: state.toolBlocks.get(key),
        block: { type: 'tool-call', id: buffer.id, name: buffer.name, arguments: buffer.arguments }
      });
    }
    state.toolBuffers.clear();
    return chunks;
  }
}

/* ------------------------------------------------------------------ *
 * Plugin entry.
 * ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const fromPatch = sanitizeChains(config?.chains);
  const stored = loadPersistedChains();
  const chains = stored || fromPatch || DEFAULT_CHAINS;

  const currentConfig = { ...(config || {}), chains };

  // First run (or a brand-new install): seed the store so later upgrades read it back.
  if (!stored) savePersistedChains(chains);

  ctx.logger.info(`[${BUILD}] chains ready: ${chains.length} item(s), store=${STORAGE_FILE}`);

  try {
    const handle = ctx.llm.registerConfigurableProviders([{
      provider: 'image-chain',
      displayName: '🔗 自由模型链路',
      settingsNs: 'image-chain',
      settingsPath: []
    }]);
    if (typeof handle === 'function') ctx.effect(() => handle);
  } catch (error) {
    ctx.logger.warn(`[${BUILD}] registerConfigurableProviders failed: ${error?.message}`);
  }

  let adapterHandle = null;
  const adapter = new FreeChainAdapter(() => currentConfig, ctx);
  try {
    adapterHandle = ctx.llm.registerAdapter(['image-chain'], adapter);
    if (typeof adapterHandle === 'function') ctx.effect(() => adapterHandle);
  } catch (error) {
    ctx.logger.warn(`[${BUILD}] registerAdapter failed: ${error?.message}`);
  }

  const settingsHandler = async (req, res) => {
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end();
        return;
      }
      return json(200, {
        ok: true,
        build: BUILD,
        storageFile: STORAGE_FILE,
        currentConfig,
        availableProviders: listProviders()
      });
    }

    if (req.method !== 'POST') return json(405, { ok: false, error: 'Method Not Allowed' });

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const next = sanitizeChains(payload?.chains);
        if (next === null) return json(400, { ok: false, error: 'chains 必须是非空数组，且每项都带 id' });

        currentConfig.chains = next;
        const saved = savePersistedChains(next);
        if (!saved) return json(500, { ok: false, error: `无法写入 ${STORAGE_FILE}` });

        // 热更新：通知 LLM 适配器与前端模型选择器即刻刷新可用模型列表！
        try {
          if (typeof adapterHandle?.replace === 'function') {
            adapterHandle.replace(['image-chain']);
          }
        } catch (e) {
          ctx.logger.warn(`[${BUILD}] adapter replace failed: ${e?.message}`);
        }

        try {
          ctx.emit('llm/adapters-updated');
        } catch (e) {
          ctx.logger.warn(`[${BUILD}] emit adapters-updated failed: ${e?.message}`);
        }

        return json(200, { ok: true, build: BUILD, storageFile: STORAGE_FILE, currentConfig });
      } catch (error) {
        return json(500, { ok: false, error: error?.message || String(error) });
      }
    });
  };

  for (const routePath of ['/api/image-chain/settings', '/api/always-connected/settings']) {
    try {
      const dispose = ctx.webServer.register({ kind: 'exact', path: routePath, handler: settingsHandler });
      if (typeof dispose === 'function') ctx.effect(() => dispose);
    } catch (error) {
      ctx.logger.warn(`[${BUILD}] route ${routePath} failed: ${error?.message}`);
    }
  }

  const disposeTool = ctx.tools.register({
    name: 'chain_generate_image',
    description: '用当前配置的绘画链路生成图像：先由提示词模型扩写，再交给绘图模型渲染，结果保存在当前工作区。',
    parameters: {
      type: 'object',
      required: ['requirement'],
      properties: {
        requirement: { type: 'string', description: '画面描述（自然语言即可）' }
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{
        type: 'text',
        text: `🎨 已生成\n\n> ${String(value?.generatedPrompt || '').slice(0, 500)}\n\n![Image](${value?.markdownPath || ''})\n\n\`${value?.relativePath || ''}\``
      }]
    },
    async execute(args, exec) {
      const chain = (currentConfig.chains || []).find(item => item.type === 'image')
        || { name: '默认绘画链路', imageConfig: { saveDirectory: 'images/generated' } };
      const workspace = exec?.agent?.session?.header?.cwd || defaultWorkspace();
      const result = await executePaintingChain(chain, args.requirement, workspace);
      return {
        generatedPrompt: result.generatedPrompt,
        markdownPath: result.markdownPath,
        relativePath: result.relativePath,
        sizeBytes: result.sizeBytes
      };
    }
  });
  if (typeof disposeTool === 'function') ctx.effect(() => disposeTool);
}
