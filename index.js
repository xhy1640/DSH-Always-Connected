import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const name = 'image-chain';

export const inject = ['llm', 'tools', 'fs', 'webServer', 'sessions'];

/** Bump on every behavioural change so the Host log proves which generation is live. */
const BUILD = 'always-connected/2026-10-21.2';

/**
 * Declared context capacity for every chat chain model.
 *
 * The upstream window is 1M, but the harness prices requests with a fixed
 * 4-chars-per-token heuristic. Measured on the session that overflowed, the
 * upstream prompt_tokens came out 1.52x the harness estimate, so advertising
 * the true 1M let history grow past the real limit before compaction fired.
 * 600k keeps the automatic threshold (~480k estimated, ~727k true) safely
 * below the real 1M ceiling. Override with `contextWindow` in the plugin's
 * cordis.patch.yml config.
 */
const DEFAULT_CONTEXT_WINDOW = 600000;

/**
 * Communication and memory bounds.
 *
 * Every value here exists because the unbounded version of it leaked: sockets
 * held open by an abandoned stream, an error body buffered whole, reference
 * images decoded without a ceiling, or a settings POST accumulated with no cap.
 */
/** Time allowed between request dispatch and the first meaningful chunk. */
const FIRST_TOKEN_TIMEOUT_MS = 90_000;
/** Time allowed between two chunks once the stream is open. A stalled upstream
 *  otherwise holds the socket, the reader, and the partial message forever. */
const IDLE_TIMEOUT_MS = 120_000;
/** Ceiling for one image-rendering call; rendering is slow but still bounded. */
const IMAGE_TIMEOUT_MS = 300_000;
/** Longest single SSE line accepted before the stream is abandoned. */
const MAX_SSE_LINE_CHARS = 8 * 1024 * 1024;
/** Most events buffered while peeking for the first meaningful chunk. */
const MAX_PEEK_EVENTS = 2000;
/** Largest error body read from an upstream response, in characters. */
const MAX_ERROR_BODY_CHARS = 2000;
/** Successful text-only response ceiling (prompt expansion). */
const MAX_TEXT_RESPONSE_CHARS = 1024 * 1024;
/** Successful image response ceiling; a base64 data URL is ~4/3 the image size. */
const MAX_IMAGE_RESPONSE_CHARS = 48 * 1024 * 1024;
/** Settings POST body ceiling; chain definitions are a few KB at most. */
const MAX_SETTINGS_BODY_BYTES = 256 * 1024;
/** Per-reference-image download ceiling; base64 inflates this by ~4/3. */
const MAX_REF_IMAGE_BYTES = 8 * 1024 * 1024;
/** Most reference images attached to one prompt request. */
const MAX_REF_IMAGES = 4;
/** Provider directory / credential re-read interval. */
const PROVIDER_CACHE_MS = 5000;

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
  "You are an expert AI image prompt engineer. Convert the user's drawing request (and reference images if provided) into an exquisite, highly-detailed English prompt for image generation.\n" +
  "CRITICAL GUIDELINES:\n" +
  "1. VISUAL FIDELITY: If reference images are provided, thoroughly inspect the character's facial features, hairstyle, ear/tail traits, clothing (maid dress, accessories, colors), body proportions, and aesthetic style, and faithfully describe them in the prompt.\n" +
  "2. ANTHROPOMORPHISM & GIJINKA: If the user mentions '虚拟形象', '拟人', '娘', or anime character names (e.g. mascot humanization, chibi girl, maid, etc.), ALWAYS depict them as an anime/manga humanized character (Gijinka), NOT a literal animal or beast, unless explicitly requested as a non-human animal.\n" +
  "3. OUTPUT FORMAT: Output ONLY the raw descriptive English prompt. No greetings, no markdown headers, no Chinese translation, no bullet list, no code fence.";

/* ------------------------------------------------------------------ *
 * Persistent store — the single source of truth for user chains.
 * Lives outside the package so reinstalling / upgrading never touches it.
 * ------------------------------------------------------------------ */

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * Read the plugin's declared context capacity, falling back to the conservative
 * default when the configured value is absent or not a positive integer.
 */
function resolveContextWindow(config) {
  const value = Number(config?.contextWindow);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}

const STORAGE_DIR = path.join(dshHome(), 'storages', 'always-connected');
const STORAGE_FILE = path.join(STORAGE_DIR, 'chains.json');
const STATE_FILE = path.join(STORAGE_DIR, 'active_state.json');

function loadActiveStates() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
    }
  } catch {}
  return {};
}

function saveActiveState(chainId, index) {
  try {
    const states = loadActiveStates();
    states[chainId] = index;
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(states, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {}
}

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

/**
 * Provider directory and credentials cache.
 *
 * `resolveEndpoint()` used to re-read and re-parse the whole profile patch and
 * the credentials file on every call — which happens once per candidate, inside
 * the retry loop. On a cold page cache with eight candidates that was hundreds
 * of synchronous multi-megabyte reads per turn, on the request path. Results are
 * now reused for a short window; the files change only when the user edits them.
 */
let providerCache = null;
let providerCacheAt = 0;

function listProviders() {
  const now = Date.now();
  if (providerCache && now - providerCacheAt < PROVIDER_CACHE_MS) return providerCache;
  providerCache = parseProviders(readProfileText());
  providerCacheAt = now;
  return providerCache;
}

/** Drop the cache so a settings save makes the next call re-read the files. */
function invalidateProviderCache() {
  providerCache = null;
  providerCacheAt = 0;
}

function readCredential(name) {
  if (!name) return '';
  // An environment value is authoritative and costs nothing to read.
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
  // Non-text blocks become an explicit placeholder instead of vanishing. Before
  // this, a message whose only payload was an image or a file reached the
  // upstream as an empty string — the model was told nothing at all, with no
  // indication that something had been dropped.
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image') return '[图片附件：当前链路以纯文本转发，无法传递图像内容]';
      if (part.type === 'file') {
        const name = part.attachment?.name || part.attachment?.attachmentId || '文件';
        return `[文件附件：${name}]`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isUserPromptMessage(msg) {
  if (!msg || msg.role !== 'user') return false;
  const sourceKind = msg.source?.kind;
  if (sourceKind && sourceKind !== 'user') return false;
  const text = flattenContent(msg.content).trim();
  if (!text) return false;
  if (/^Time sampled while preparing turn/i.test(text)) return false;
  if (/^Current runtime context/i.test(text)) return false;
  if (/^<system-reminder>[\s\S]*<\/system-reminder>$/i.test(text) || text.startsWith('<system-reminder>')) return false;
  if (/^【meow-memory[\s\S]*提示】[\s\S]*$/i.test(text) && !text.includes('画') && !text.includes('图')) return false;
  if (/^\[model changed:/i.test(text)) return false;
  return true;
}

function cleanUserPromptText(raw) {
  if (!raw) return '';
  let text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gis, '')
    .replace(/Current runtime context[\s\S]*$/gis, '')
    .replace(/Time sampled while preparing turn[\s\S]*$/gis, '')
    .replace(/【meow-memory 首次建库提示】[\s\S]*?以上是要点。/gis, '')
    .replace(/\[model changed:[\s\S]*?\]/gis, '')
    .trim();
  return text;
}

function extractLatestUserPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isUserPromptMessage(msg)) {
      const text = cleanUserPromptText(flattenContent(msg.content));
      if (text) return text;
    }
  }
  return '';
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

/**
 * Read at most `limit` characters of a response body.
 *
 * `response.text()` buffers whatever the peer sends, so one upstream error page
 * or stray HTML redirect can pin arbitrary memory before the caller even looks
 * at the status. This reads through the stream with a hard ceiling and cancels
 * the body afterwards so the socket is released rather than left dangling.
 *
 * @returns `{ text, truncated }` — `truncated` is true only when the ceiling
 *   actually cut the body short, so a response that happens to end exactly at
 *   the limit is not mistaken for a larger one.
 */
async function readBoundedText(response, limit, signal) {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > limit) {
        truncated = true;
        break;
      }
      if (signal?.aborted) break;
    }
  } catch {
    // A truncated or aborted body still yields whatever arrived.
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  return { text: truncated ? text.slice(0, limit) : text, truncated };
}

/**
 * POST JSON and return the parsed body.
 *
 * Every call is bounded: a timeout aborts the request, the body is read with a
 * character ceiling, and the body is always released so a failed request cannot
 * strand a socket for the life of the process.
 */
async function callJson(url, apiKey, body, signal, limits = {}) {
  const timeoutMs = limits.timeoutMs ?? IDLE_TIMEOUT_MS;
  const maxBodyChars = limits.maxBodyChars ?? MAX_ERROR_BODY_CHARS;
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal || timeout);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: combined
  });
  let text = '';
  let truncated = false;
  try {
    ({ text, truncated } = await readBoundedText(response, maxBodyChars, combined));
  } catch (error) {
    throw new Error(`读取响应失败: ${error?.message || error}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`);
  if (truncated) {
    // The ceiling was hit, so the JSON is cut and would fail to parse.
    throw new Error(`响应超过 ${maxBodyChars} 字符上限，已放弃`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`);
  }
}

/**
 * Download one reference image as a data URL, refusing anything over the ceiling.
 *
 * The type is checked before the body is consumed, and the body is read with a
 * byte budget so a mislabelled or endless response cannot grow memory without
 * bound. Returns null for every refusal; reference images are a best-effort
 * enhancement and must never fail the painting request.
 */
async function fetchImageDataUrl(url, signal, allowedMime) {
  const timeout = AbortSignal.timeout(8000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(url, { signal: combined });
  } catch {
    return null;
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    return null;
  }
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const mime = /^image\/[a-z0-9.+-]+$/.test(type) ? type : allowedMime;
  if (!mime) {
    try { await response.body?.cancel(); } catch {}
    return null;
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REF_IMAGE_BYTES) {
    try { await response.body?.cancel(); } catch {}
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REF_IMAGE_BYTES) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  if (total <= 500) return null;
  return `data:${mime};base64,` + Buffer.concat(chunks, total).toString('base64');
}

async function resolvePromptImages(text, workspace, signal) {
  const images = [];
  if (!text || typeof text !== 'string') return images;

  const push = dataUrl => {
    if (dataUrl && images.length < MAX_REF_IMAGES) images.push(dataUrl);
  };

  // 1. 查找推特/X 链接并抓取其媒体图片
  const twitterMatches = text.match(/https?:\/\/(?:twitter\.com|x\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:\/[A-Za-z0-9_]+)*/g) || [];
  for (const tUrl of twitterMatches.slice(0, 2)) {
    if (images.length >= MAX_REF_IMAGES || signal?.aborted) break;
    try {
      const res = await fetch(tUrl, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
      const html = res.ok ? (await readBoundedText(res, 512 * 1024, signal)).text : '';
      const mediaUrls = [...new Set(html.match(/https:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+/g) || [])];
      for (const mUrl of mediaUrls.slice(0, 2)) {
        if (images.length >= MAX_REF_IMAGES || signal?.aborted) break;
        push(await fetchImageDataUrl(`${mUrl}?format=jpg&name=medium`, signal, 'image/jpeg'));
      }
    } catch {}
  }

  // 2. 查找直接图片 URL (jpg/jpeg/png/webp/gif)
  const directImgMatches = text.match(/https?:\/\/[^\s"'<>)]+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^\s"'<>)]*)?/gi) || [];
  for (const url of directImgMatches.slice(0, 2)) {
    if (images.length >= MAX_REF_IMAGES || signal?.aborted) break;
    push(await fetchImageDataUrl(url, signal, 'image/jpeg'));
  }

  // 3. 查找本地相对/绝对图片引用
  if (workspace) {
    const localMatches = text.match(/(?:^|\s)(@?[A-Za-z0-9_./\\-]+\.(?:jpg|jpeg|png|webp|gif))/gi) || [];
    for (const rawPath of localMatches.slice(0, 2)) {
      if (images.length >= MAX_REF_IMAGES || signal?.aborted) break;
      const cleanPath = rawPath.trim().replace(/^@/, '');
      const absPath = path.isAbsolute(cleanPath) ? cleanPath : path.join(workspace, cleanPath);
      try {
        const stat = fs.statSync(absPath);
        if (!stat.isFile() || stat.size > MAX_REF_IMAGE_BYTES) continue;
        const ext = path.extname(absPath).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        const buf = fs.readFileSync(absPath);
        if (buf.length > 500) push(`data:${mime};base64,` + buf.toString('base64'));
      } catch {}
    }
  }

  return images;
}

async function executePaintingChain(chain, userPrompt, workspace, options = {}) {
  if (!userPrompt || !userPrompt.trim()) throw new Error('绘画要求不能为空。');

  const conf = chain.imageConfig || {};
  const promptEndpoint = resolveEndpoint(conf.promptModelProvider || 'cpa');
  // Every awaited network step below carries this signal, so cancelling a turn
  // stops the reference-image downloads and both model calls instead of letting
  // them run to completion against an abandoned request.
  const signal = options.signal;

  // `getSkillPromptInstruction` used to be called here but was never defined in
  // this module, so every painting request died with a ReferenceError before the
  // first HTTP call. The declared default is the actual fallback.
  const baseInstruction = DEFAULT_PROMPT_INSTRUCTION;
  const instruction = typeof conf.promptSystemInstruction === 'string' && conf.promptSystemInstruction.trim()
    ? `${conf.promptSystemInstruction.trim()}\n\n${baseInstruction}`
    : baseInstruction;

  // 自动解析参考图（推特链接/直接图片URL/本地文件）
  const refImages = await resolvePromptImages(userPrompt, workspace, signal);

  let userContent;
  if (refImages.length > 0) {
    userContent = [
      {
        type: 'text',
        text: `${userPrompt.trim()}\n\n[Vision System Note: The user attached ${refImages.length} reference image(s). You MUST carefully inspect the character appearance, anime/chibi design, clothing, ears/tails, hairstyles, and color palette from the reference image(s) to faithfully incorporate them into the final descriptive prompt.]`
      }
    ];
    for (const imgUrl of refImages) {
      userContent.push({ type: 'image_url', image_url: { url: imgUrl } });
    }
  } else {
    userContent = userPrompt.trim();
  }

  let a = null;
  const promptCall = content => callJson(
    `${promptEndpoint.baseURL}/chat/completions`,
    promptEndpoint.apiKey,
    {
      model: conf.promptModelId || 'gemini-3.8-flash-high',
      messages: [
        {
          role: 'system',
          content: `${instruction}\n\nCRITICAL: output ONLY the raw descriptive English prompt. No greetings, no headers, no Chinese translation, no bullet list, no code fence.`
        },
        { role: 'user', content }
      ],
      temperature: 0.7
    },
    signal,
    { maxBodyChars: MAX_TEXT_RESPONSE_CHARS }
  );

  try {
    a = await promptCall(userContent);
  } catch (err) {
    // 若多模态请求被某些纯文本模型拒绝，安全降级为纯文本重试
    if (refImages.length > 0) {
      a = await promptCall(userPrompt.trim());
    } else {
      throw err;
    }
  }

  const generated = cleanGeneratedPrompt(a?.choices?.[0]?.message?.content);
  if (!generated) throw new Error('提示词模型未返回可用提示词。');

  const request = /^(generate|draw|create)\s+an?\s+image/i.test(generated)
    ? generated
    : `Generate an image: ${generated}`;

  // 绘画模型容灾候选列表
  const imageCandidates = [];
  if (conf.imageModelProvider && conf.imageModelId) {
    imageCandidates.push({ provider: conf.imageModelProvider, model: conf.imageModelId });
  }
  if (!imageCandidates.some(c => c.provider === 'cpa' && c.model === 'gemini-3.1-flash-image')) {
    imageCandidates.push({ provider: 'cpa', model: 'gemini-3.1-flash-image' });
  }

  let b = null;
  let lastImageError = null;
  let activeImageCand = null;

  for (const cand of imageCandidates) {
    if (signal?.aborted) throw new Error('请求已取消');
    try {
      const ep = resolveEndpoint(cand.provider);
      b = await callJson(
        `${ep.baseURL}/chat/completions`,
        ep.apiKey,
        { model: cand.model, messages: [{ role: 'user', content: request }] },
        signal,
        // Image rendering is legitimately slow, so give it a longer ceiling than
        // the text calls — but still a ceiling, so a hung upstream cannot hold
        // the request (and its decoded buffers) forever.
        { timeoutMs: IMAGE_TIMEOUT_MS, maxBodyChars: MAX_IMAGE_RESPONSE_CHARS }
      );
      if (b?.choices?.[0]?.message) {
        activeImageCand = cand;
        break;
      }
    } catch (err) {
      lastImageError = err;
    }
  }

  if (!b && lastImageError) {
    throw new Error(`绘画模型失败: ${lastImageError?.message || lastImageError}`);
  }

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
    modelB: activeImageCand?.model || conf.imageModelId || 'gemini-3.1-flash-image'
  };
}

/* ------------------------------------------------------------------ *
 * SSE plumbing.
 * ------------------------------------------------------------------ */

/**
 * Yield parsed `data:` payloads from an SSE byte stream.
 *
 * The reader is cancelled in `finally`, so closing this generator early — a
 * `[DONE]` return, an abort, a caller's `iterator.return()` — always releases
 * the underlying socket. Without that, an abandoned attempt keeps its connection
 * and its decoded buffer alive for the lifetime of the process. The line buffer
 * is capped as well: a peer that never sends a newline would otherwise grow it
 * without bound.
 */
async function* sseEvents(reader, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new Error('请求已取消');
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_LINE_CHARS) {
        throw new Error(`上游单行超过 ${MAX_SSE_LINE_CHARS} 字符，已中断`);
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          if (payload) {
            try {
              yield JSON.parse(payload);
            } catch {}
          }
        }
        if (signal?.aborted) throw new Error('请求已取消');
      }
    }
    // A final line without a trailing newline still carries a payload.
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          yield JSON.parse(payload);
        } catch {}
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
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

/**
 * Sleep between retries, waking early on cancellation.
 *
 * A bare `setTimeout` ignores the abort signal, so cancelling a turn during the
 * backoff still paid the full delay, and the pending timer kept the timer queue
 * (and this generator's frame) alive for up to 1.5s after the request was gone.
 */
function sleepAbortable(ms, signal, maxMs = Infinity) {
  const delay = Math.min(ms, maxMs);
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, delay);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/**
 * Canonical harness code for a request that exceeds the model's context window.
 * Kept in sync with `CONTEXT_WINDOW_EXCEEDED_CODE` from `@deepseek-ai/dsh-llm`
 * by value, because this plugin must not depend on that package.
 */
const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED';

/**
 * Recognize provider wording that means the request exceeded the model context
 * window, mirroring the four shapes the harness itself classifies.
 */
function isContextOverflowDetail(detail) {
  if (!detail) return false;
  return /context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)/i.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context(?:\s+window)?\b/i.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || /prompt_too_long/i.test(detail)
    || /\binput token count exceeds\b/i.test(detail);
}

/* ------------------------------------------------------------------ *
 * Adapter.
 * ------------------------------------------------------------------ */

class FreeChainAdapter {
  constructor(getConfig, ctx) {
    this.getConfig = getConfig;
    this.ctx = ctx;
    this.activeChatIndex = new Map(); // chainId -> index
    this.activeImageIndex = new Map(); // chainId -> index
    try {
      const states = loadActiveStates();
      for (const [k, v] of Object.entries(states)) {
        if (typeof v === 'number') {
          if (k.endsWith(':image')) this.activeImageIndex.set(k.slice(0, -6), v);
          else this.activeChatIndex.set(k, v);
        }
      }
    } catch {}
  }

  providerInfo(provider) {
    return { id: provider, name: '🔗 自由模型链路' };
  }

  providerRetryPolicy() {
    // The chain is the retry owner: it already retries each model N times and
    // falls over to the next candidate. Letting the harness apply its own default
    // (5 more whole-request retries) multiplied that into hundreds of upstream
    // requests per turn, each re-sending the full history.
    //
    // Returned in the *resolved* shape (`ResolvedNormalRetryPolicy`): the
    // backoff fields are flat, not nested under `backoff` — the harness consumes
    // this object directly instead of running it through its schema.
    return {
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 500,
      maxDelayMs: 10000,
      jitterRatio: 0.2
    };
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
      // The chat chain forwards text only (see flattenContent), so declaring the
      // modality honestly lets the harness project image blocks into a text
      // description with a normalized path, instead of the adapter silently
      // dropping them and sending the model an empty string.
      inputModalities: ['text'],
      context: { contextWindow: resolveContextWindow(this.getConfig()) },
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
    // A cancelled turn must not run the painting chain to completion: the image
    // would be written to disk and charged to a request nobody is waiting for.
    if (options.signal?.aborted) {
      yield* this.abortedFinish();
      return;
    }

    const workspace = resolveWorkspace(this.ctx, options.sessionId);
    const messages = options.messages || [];
    let prompt = extractLatestUserPrompt(messages);
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
      if (options.signal?.aborted) {
        yield* this.abortedFinish();
        return;
      }
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
    // A single request body is serialized once per candidate, not once per
    // attempt: it can be megabytes of history and every retry used to
    // re-stringify it. Only `model` varies, so it is filled in per candidate.
    const baseBody = { messages, stream: true, temperature: options.temperature ?? 0.7 };
    if (options.maxTokens) baseBody.max_tokens = options.maxTokens;
    if (tools) baseBody.tools = tools;
    // Ask OpenAI-compatible upstreams for real token counts on the final chunk.
    // Without this the adapter can only estimate with a chars/N heuristic, which
    // is what let a 1M-token request look like 600k and skipped compaction.
    baseBody.stream_options = { include_usage: true };

    const startIndex = this.activeChatIndex.get(chain.id) || 0;
    const probeOrder = [];
    for (let i = 0; i < candidates.length; i++) {
      probeOrder.push((startIndex + i) % candidates.length);
    }

    for (let pIdx = 0; pIdx < probeOrder.length; pIdx++) {
      const index = probeOrder[pIdx];
      const candidate = candidates[index];
      const endpoint = resolveEndpoint(candidate.provider);
      const label = `${candidate.provider} / ${candidate.model}`;
      // Serialized once per candidate instead of once per attempt: the body can
      // be megabytes of history and a retry storm re-stringified it every time.
      const serializedBody = JSON.stringify({ ...baseBody, model: candidate.model });
      let lastError = '';

      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (options.signal?.aborted) {
          yield* this.abortedFinish();
          return;
        }

        const controller = new AbortController();
        const onAbort = () => controller.abort();
        options.signal?.addEventListener?.('abort', onAbort, { once: true });
        let idleTimer;
        let iterator = null;
        let drained = false;

        // One deadline covers both phases: first token, then inter-chunk gap.
        // Resetting it per chunk is what turns "upstream stalled forever" into a
        // retryable timeout instead of a permanently held socket. The first wait
        // gets a shorter ceiling than a mid-stream gap, because a provider that
        // never starts answering cannot be distinguished from a dead socket.
        const armIdle = (delayMs = IDLE_TIMEOUT_MS) => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => controller.abort(), delayMs);
        };

        try {
          armIdle(FIRST_TOKEN_TIMEOUT_MS);
          const response = await fetch(`${endpoint.baseURL}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json' },
            body: serializedBody,
            signal: controller.signal
          });

          if (!response.ok) {
            const detail = (await readBoundedText(response, MAX_ERROR_BODY_CHARS, controller.signal)).text;
            // A context-window overflow is not a transient failure and cannot be
            // fixed by trying the next model in the chain: every model here
            // advertises the same window. Surface it as the harness overflow
            // code so automatic compaction can shrink history and retry.
            if (response.status === 400 && isContextOverflowDetail(detail)) {
              yield* this.overflowFinish({ detail, model: candidate.model, provider: candidate.provider });
              return;
            }
            const error = new Error(`HTTP ${response.status}: ${detail}`);
            error.retriable = retriableStatus(response.status);
            throw error;
          }
          if (!response.body) throw new Error('响应没有可读流');

          iterator = sseEvents(response.body.getReader(), controller.signal)[Symbol.asyncIterator]();
          const buffered = [];
          let meaningful = false;
          let finishReason = null;

          // Peek with an explicit iterator: breaking a `for await` would call
          // iterator.return() and close the very stream we still need to read.
          // The buffer is capped so an upstream that streams thousands of
          // reasoning-only keepalives cannot grow it without bound before the
          // first real token arrives; beyond the cap the attempt is abandoned
          // and retried like any other empty probe. The first-token deadline is
          // deliberately NOT re-armed here: keepalive traffic must not extend
          // "no answer yet" into an unbounded wait.
          while (true) {
            if (buffered.length >= MAX_PEEK_EVENTS) {
              throw new Error('上游在首字之前发送了过多事件，已放弃本次尝试');
            }
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

          if (!meaningful) {
            // `drained` stays false so the finally block closes this iterator;
            // marking it drained here would leave the socket open on the retry.
            if (finishReason === 'malformed_function_call') {
              throw new Error('上游返回 malformed_function_call（畸形工具调用）');
            }
            throw new Error(`上游返回空响应（finish_reason: ${finishReason || 'unknown'}）`);
          }

          // Committed: this model answered, stream the rest live. From here the
          // deadline becomes an inter-chunk idle deadline.
          armIdle();
          this.activeChatIndex.set(chain.id, index);
          saveActiveState(chain.id, index);
          const state = {
            textOpen: false,
            reasoningOpen: false,
            openText: '',
            text: '',
            reasoningText: '',
            // Reasoning tokens are counted from their source rather than kept as
            // a full second copy of the whole reasoning stream.
            reasoningSeen: 0,
            toolBlocks: new Map(),
            toolBuffers: new Map(),
            hadToolCalls: false,
            nextIndex: 0,
            textIndex: 0,
            reasoningIndex: 0
          };
          let upstreamUsage = null;

          if (index !== startIndex) {
            const note = `> ⚠️ 已自动切换：次序 ${index + 1} · \`${label}\`\n\n`;
            state.textIndex = state.nextIndex++;
            state.textOpen = true;
            state.openText = note;
            state.text = note;
            yield { type: 'block-start', index: state.textIndex, blockType: 'text' };
            yield { type: 'text-delta', index: state.textIndex, text: note };
          }

          const emit = event => {
            if (event?.usage) upstreamUsage = event.usage;
            return this.emitEvent(event, state);
          };
          for (const event of buffered) {
            for (const chunk of emit(event)) yield chunk;
          }
          while (true) {
            armIdle();
            const step = await iterator.next();
            // Stop the clock before handing control to the consumer: a slow
            // reader pausing on backpressure is not a stalled upstream.
            if (idleTimer) {
              clearTimeout(idleTimer);
              idleTimer = undefined;
            }
            if (step.done) break;
            const event = step.value;
            if (finishReason === null) {
              const reason = event?.choices?.[0]?.finish_reason;
              if (reason) finishReason = reason;
            }
            for (const chunk of emit(event)) yield chunk;
          }
          drained = true;

          for (const chunk of this.closeBlocks(state)) yield chunk;

          yield {
            type: 'usage',
            // The estimator fallback reuses the serialized request length
            // instead of re-stringifying a multi-megabyte history.
            usage: this.normalizeUsage(upstreamUsage, serializedBody.length, state)
          };
          // `length` means the provider truncated output at max_tokens. Mapping
          // it to `stop` hid truncation from the loop, so a cut-off tool call or
          // answer looked complete.
          yield {
            type: 'finish',
            reason: finishReason === 'length'
              ? { kind: 'max-tokens' }
              : (state.hadToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' })
          };
          return;
        } catch (error) {
          lastError = error?.name === 'AbortError' || controller.signal.aborted
            ? '连接或响应超时'
            : (error?.message || String(error));
          if (options.signal?.aborted) {
            yield* this.abortedFinish();
            return;
          }
          const retriable = error?.retriable !== false;
          if (!retriable) break;
          if (attempt < attempts) await sleepAbortable(400 * attempt, options.signal, 1500);
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
          options.signal?.removeEventListener?.('abort', onAbort);
          // Release the socket on every path out of the attempt — including a
          // consumer that stops iterating mid-stream, which reaches here through
          // the generator's return() and would otherwise leak the connection.
          if (iterator && !drained) {
            try {
              await iterator.return?.();
            } catch {}
          }
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

  /**
   * Emit the terminal harness `error` finish for a context-window overflow.
   *
   * The harness keys its overflow recovery off this exact code, so this is the
   * only shape that lets compaction shrink the history instead of the chain
   * spending every model on an identical 400. No text block is emitted: an
   * error finish discards assembled content, so the retry after compaction is
   * what the user ends up seeing.
   */
  overflowFinish(seen) {
    return [{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: `上下文超出模型窗口（${seen.provider} / ${seen.model}）：${seen.detail}`,
          code: CONTEXT_WINDOW_EXCEEDED
        }
      }
    }];
  }

  /**
   * Emit the terminal harness `aborted` finish for a cancelled chain call.
   *
   * Cancellation is its own outcome, not a `stop` with a text block: the
   * harness treats `stop` as a completed answer, which used to persist the
   * literal "_已取消_" as assistant content and to let the loop continue from a
   * turn the user had already abandoned.
   */
  abortedFinish() {
    return [{
      type: 'finish',
      reason: {
        kind: 'aborted',
        failure: { message: '请求已取消', code: 'ABORTED' }
      }
    }];
  }

  /**
   * Turn an upstream usage report into the harness `TokenUsage` shape.
   *
   * Real counts are preferred whenever the provider sends them, because the
   * local estimate is a fixed chars-per-token heuristic that under-counts
   * Chinese and JSON by more than 1.5x — the reason compaction never fired
   * before the provider rejected the request.
   */
  normalizeUsage(upstream, serializedLength, state) {
    const estimatedInput = Math.max(1, Math.round(serializedLength / 4));
    // `reasoningSeen` is a running character count, so it survives the buffers
    // being cleared as each block closes; using `reasoningText.length` here
    // would undercount to just the final segment.
    const estimatedOutput = Math.max(1, Math.round((state.text.length + state.reasoningSeen) / 3));
    if (!upstream || typeof upstream !== 'object') {
      // No provider report: fall back to the estimator, but keep it explicit.
      return { inputTokens: estimatedInput, outputTokens: estimatedOutput };
    }
    // OpenAI-compatible `prompt_tokens` already includes cached prompt tokens,
    // so it maps to `inputTokens` as a full total — not as a disjoint bucket
    // beside `cacheReadTokens`. Reporting both would make the harness's pressure
    // meter (`inputTokens + cacheReadTokens`) count the cached prefix twice and
    // trigger compaction far earlier than the real context use warrants.
    const prompt = Number(upstream.prompt_tokens);
    const completion = Number(upstream.completion_tokens);
    const inputTokens = Number.isFinite(prompt) && prompt > 0 ? prompt : 0;
    const outputTokens = Number.isFinite(completion) && completion > 0
      ? completion
      : estimatedOutput;
    if (inputTokens === 0) {
      return { inputTokens: estimatedInput, outputTokens };
    }
    const usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
    const reasoning = Number(upstream.completion_tokens_details?.reasoning_tokens);
    if (Number.isFinite(reasoning) && reasoning > 0) usage.reasoningTokens = reasoning;
    return usage;
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
      state.reasoningText += delta.reasoning_content;
      state.reasoningSeen += delta.reasoning_content.length;
      chunks.push({ type: 'reasoning-delta', index: state.reasoningIndex, text: delta.reasoning_content });
    }

    if (typeof delta.content === 'string' && delta.content) {
      if (state.reasoningOpen) {
        chunks.push({ type: 'block-end', index: state.reasoningIndex, block: { type: 'reasoning', text: state.reasoningText } });
        state.reasoningText = '';
        state.reasoningOpen = false;
      }
      if (!state.textOpen) {
        state.textIndex = state.nextIndex++;
        chunks.push({ type: 'block-start', index: state.textIndex, blockType: 'text' });
        state.textOpen = true;
      }
      // Two buffers: `openText` is the block currently being written, and
      // `text` is the running total used for the usage estimate. Closing a block
      // on a tool call used to keep appending into the same buffer, so a later
      // text block re-sent every earlier fragment inside its own block-end.
      state.openText += delta.content;
      state.text += delta.content;
      chunks.push({ type: 'text-delta', index: state.textIndex, text: delta.content });
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      if (state.textOpen) {
        chunks.push({ type: 'block-end', index: state.textIndex, block: { type: 'text', text: state.openText } });
        state.openText = '';
        state.textOpen = false;
      }
      if (state.reasoningOpen) {
        chunks.push({ type: 'block-end', index: state.reasoningIndex, block: { type: 'reasoning', text: state.reasoningText } });
        state.reasoningText = '';
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
      chunks.push({ type: 'block-end', index: state.textIndex, block: { type: 'text', text: state.openText } });
      state.openText = '';
      state.textOpen = false;
    }
    if (state.reasoningOpen) {
      chunks.push({ type: 'block-end', index: state.reasoningIndex, block: { type: 'reasoning', text: state.reasoningText } });
      state.reasoningText = '';
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
    state.toolBlocks.clear();
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

  ctx.logger.info(`[${BUILD}] chains ready: ${chains.length} item(s), store=${STORAGE_FILE}, contextWindow=${resolveContextWindow(currentConfig)}`);

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

  // The settings route is same-origin from the app shell and loopback-only, so
  // it must not advertise `*` — any page the user visits could otherwise read
  // the chain list (including provider ids) from this port.
  const settingsHandler = async (req, res) => {
    // Route registration alone does not apply the Host's trust fence, so this
    // endpoint used to be readable and writable by any local process and by any
    // page that could reach the loopback port. Mirror the fence the built-in
    // routes use; when no connection service is mounted, fall back to the
    // host/origin check the fence itself is built on.
    const rejection = (() => {
      try {
        const connection = ctx.get?.('connection');
        if (connection?.requestRejection) return connection.requestRejection(req);
      } catch {}
      try {
        const host = req.headers.host;
        if (!host) return 403;
        const hostUrl = new URL(`http://${host}`);
        const loopback = hostUrl.hostname === '127.0.0.1' || hostUrl.hostname === 'localhost' || hostUrl.hostname === '::1' || hostUrl.hostname === '[::1]';
        if (!loopback) return 403;
        if (req.headers['sec-fetch-site'] === 'cross-site') return 403;
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== hostUrl.host) return 403;
      } catch {
        return 403;
      }
      return undefined;
    })();
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: rejection === 403 ? 'Forbidden' : 'Unauthorized' }));
      return;
    }

    let replied = false;
    const json = (status, payload) => {
      if (replied || res.writableEnded) return;
      replied = true;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (req.method === 'HEAD') {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end();
        }
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

    // The body is collected with a hard ceiling. Without one, a client that
    // never ends its request (or sends an unbounded stream) grows this string
    // for the life of the connection, and the request is never answered.
    const chunks = [];
    let size = 0;
    let rejected = false;

    const finish = raw => {
      try {
        const payload = JSON.parse(raw || '{}');
        const next = sanitizeChains(payload?.chains);
        if (next === null) return json(400, { ok: false, error: 'chains 必须是非空数组，且每项都带 id' });

        currentConfig.chains = next;
        const saved = savePersistedChains(next);
        if (!saved) return json(500, { ok: false, error: `无法写入 ${STORAGE_FILE}` });
        // The user may have edited providers alongside the chains; the next
        // request should see the current profile rather than a stale snapshot.
        invalidateProviderCache();

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
    };

    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_SETTINGS_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        req.pause();
        json(413, { ok: false, error: `请求体超过 ${MAX_SETTINGS_BODY_BYTES} 字节上限` });
        // Close only once the rejection has been flushed: destroying first can
        // reset the socket so the client sees a connection error instead of 413.
        // Still bounded — the socket never outlives this response.
        res.once('finish', () => req.destroy());
        res.once('close', () => req.destroy());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      finish(Buffer.concat(chunks, size).toString('utf8'));
    });
    // A client that disconnects mid-body would otherwise leave `chunks` and this
    // closure reachable until the socket is garbage-collected by the server.
    req.on('error', () => {
      rejected = true;
      chunks.length = 0;
    });
    req.on('aborted', () => {
      rejected = true;
      chunks.length = 0;
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
      // Forward the tool call's cancellation so a stopped turn also stops the
      // reference-image downloads and the two upstream calls.
      const result = await executePaintingChain(chain, args.requirement, workspace, { signal: exec?.signal });
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
