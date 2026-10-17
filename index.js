import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const name = 'image-chain';

export const inject = ['llm', 'tools', 'fs', 'webServer'];

/**
 * 简单解析 yaml 键值对或使用基础读取器
 */
function parseSimpleYamlProfiles(content) {
  const providers = [];
  try {
    const lines = content.split('\n');
    let inPiAi = false;
    let inProviders = false;
    let currentProvider = null;
    let inModels = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('id: llm-pi-ai')) {
        inPiAi = true;
        continue;
      }
      if (inPiAi && line.match(/^[a-zA-Z0-9_-]/)) {
        inPiAi = false;
        inProviders = false;
      }
      if (!inPiAi) continue;

      if (line.includes('providers:')) {
        inProviders = true;
        continue;
      }

      const provMatch = line.match(/^ {6}([a-zA-Z0-9_-]+):/);
      if (inProviders && provMatch) {
        currentProvider = {
          id: provMatch[1],
          displayName: provMatch[1],
          baseURL: '',
          apiKeyEnv: '',
          models: []
        };
        providers.push(currentProvider);
        inModels = false;
        continue;
      }

      if (currentProvider) {
        const displayMatch = line.match(/^ {8}displayName:\s*(.+)$/);
        if (displayMatch) currentProvider.displayName = displayMatch[1].trim();

        const baseMatch = line.match(/^ {8}baseURL:\s*(.+)$/);
        if (baseMatch) currentProvider.baseURL = baseMatch[1].trim();

        const keyEnvMatch = line.match(/^ {8}apiKeyEnv:\s*(.+)$/);
        if (keyEnvMatch) currentProvider.apiKeyEnv = keyEnvMatch[1].trim();

        if (line.match(/^ {8}models:/)) {
          inModels = true;
          continue;
        }

        if (inModels) {
          const modelIdMatch = line.match(/^ {10,12}-\s*id:\s*(.+)$/);
          if (modelIdMatch) {
            const mId = modelIdMatch[1].trim().replace(/^['"]|['"]$/g, '');
            currentProvider.models.push({ id: mId, name: mId });
            continue;
          }
          const modelNameMatch = line.match(/^ {12,14}name:\s*(.+)$/);
          if (modelNameMatch && currentProvider.models.length > 0) {
            const mName = modelNameMatch[1].trim().replace(/^['"]|['"]$/g, '');
            currentProvider.models[currentProvider.models.length - 1].name = mName;
          }
        }
      }
    }
  } catch (err) {}
  return providers;
}

/**
 * 清洗模型A生成的提示词，移除多余前缀与引号
 */
function cleanGeneratedPrompt(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^(image\s+)?prompt:\s*/i, '');
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith('\'') && cleaned.endsWith('\'')) ||
      (cleaned.startsWith('`') && cleaned.endsWith('`'))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  cleaned = cleaned.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return cleaned;
}

/**
 * 从当前 profile 中动态解析所有可用的 provider 与模型列表
 */
function getAvailableProvidersAndModels() {
  const profilePatchPath = path.join(
    process.env.DSH_PROFILE_DIR || path.join(process.env.HOME || '', '.dsh/profiles/desktop'),
    'cordis.patch.yml'
  );

  if (!fs.existsSync(profilePatchPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(profilePatchPath, 'utf8');
    return parseSimpleYamlProfiles(content);
  } catch (err) {
    return [];
  }
}

/**
 * 解析特定 Provider 的 BaseURL 与 API Key
 */
function resolveProviderEndpoint(providerKey) {
  const providers = getAvailableProvidersAndModels();
  const found = providers.find(p => p.id === providerKey);
  if (!found) {
    return {
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: process.env.CPA_API_KEY || 'sk-cpa-local'
    };
  }

  let apiKey = '';
  if (found.apiKeyEnv && process.env[found.apiKeyEnv]) {
    apiKey = process.env[found.apiKeyEnv];
  } else {
    const credPath = path.join(process.env.HOME || '', '.dsh/.credentials.yaml');
    if (fs.existsSync(credPath)) {
      try {
        const credText = fs.readFileSync(credPath, 'utf8');
        const match = credText.match(new RegExp(`${found.apiKeyEnv || providerKey}:\\s*([^\\n\\r]+)`));
        if (match) apiKey = match[1].trim().replace(/^['"]|['"]$/g, '');
      } catch {}
    }
  }

  if (!apiKey) {
    if (providerKey === 'cpa') apiKey = 'sk-cpa-local';
    else if (providerKey === 'workbuddypanel') apiKey = 'dummy';
  }

  return {
    baseURL: found.baseURL || 'http://127.0.0.1:8317/v1',
    apiKey
  };
}

/**
 * 解析当前有效工作区根目录
 */
function resolveCurrentWorkspace(cwdOverride) {
  if (cwdOverride && cwdOverride !== '/' && cwdOverride !== process.env.HOME) {
    return cwdOverride;
  }
  return '/Volumes/ssd/Library/deepseek/pro';
}

/**
 * 将 DSH messages 转换为 OpenAI 兼容格式，完整支持 system, developer, user, assistant, tool 消息
 */
function convertMessagesToOpenAI(messages, system) {
  const result = [];
  if (system && typeof system === 'string' && system.trim()) {
    result.push({ role: 'system', content: system.trim() });
  }

  for (const msg of messages || []) {
    let content = '';
    const toolCalls = [];

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const parts = [];
      for (const part of msg.content) {
        if (part.type === 'text') parts.push(part.text);
        else if (part.type === 'tool-call') {
          toolCalls.push({
            id: String(part.id || ''),
            type: 'function',
            function: {
              name: part.name || '',
              arguments: typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments || {})
            }
          });
        }
      }
      content = parts.join('\n');
    }

    if (msg.role === 'developer' || msg.role === 'system') {
      result.push({ role: 'system', content });
    } else if (msg.role === 'user') {
      result.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      const assistantMsg = { role: 'assistant', content: content || '' };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    } else if (msg.role === 'tool') {
      // 提取 tool call id
      const callId = msg.toolCallId || msg.source?.callId || '';
      result.push({
        role: 'tool',
        tool_call_id: String(callId),
        content: content || ''
      });
    }
  }

  return result;
}

/**
 * 转换 DSH options.tools 到 OpenAI 兼容工具定义
 */
function convertToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} }
    }
  }));
}

/**
 * 执行绘画链路的核心逻辑
 */
async function executePaintingChain(chainConfig, userPrompt, workspaceCwd) {
  if (!userPrompt || !userPrompt.trim()) {
    throw new Error('绘画要求不能为空！');
  }

  const imageConf = chainConfig.imageConfig || {};
  const effectiveWorkspace = resolveCurrentWorkspace(workspaceCwd);
  const promptEndpoint = resolveProviderEndpoint(imageConf.promptModelProvider || 'cpa');
  const imageEndpoint = resolveProviderEndpoint(imageConf.imageModelProvider || 'cpa');

  // 1. 调用模型 A 生成精美英文生图提示词
  const promptAUrl = `${promptEndpoint.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const responseA = await fetch(promptAUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${promptEndpoint.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: imageConf.promptModelId || 'gemini-3.8-flash-high',
      messages: [
        { role: 'system', content: imageConf.promptSystemInstruction || 'You are an expert AI image prompt engineer. Convert the user\'s drawing request into an exquisite, highly-detailed English prompt for image generation.' },
        { role: 'user', content: userPrompt.trim() }
      ],
      temperature: 0.7
    })
  });

  if (!responseA.ok) {
    const errorText = await responseA.text();
    throw new Error(`[提示词模型A(${imageConf.promptModelId}) 生成失败 HTTP ${responseA.status}]: ${errorText}`);
  }

  const dataA = await responseA.json();
  const rawGeneratedPrompt = dataA.choices?.[0]?.message?.content;
  const finalPrompt = cleanGeneratedPrompt(rawGeneratedPrompt);

  if (!finalPrompt) {
    throw new Error(`模型A未能返回有效的提示词内容。响应: ${JSON.stringify(dataA).slice(0, 300)}`);
  }

  // 2. 将模型 A 产出的最终提示词喂给模型 B
  const imageBUrl = `${imageEndpoint.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const responseB = await fetch(imageBUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${imageEndpoint.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: imageConf.imageModelId || 'gemini-3.1-flash-image',
      messages: [
        { role: 'user', content: finalPrompt }
      ]
    })
  });

  if (!responseB.ok) {
    const errorText = await responseB.text();
    throw new Error(`[绘画模型B(${imageConf.imageModelId}) 绘图失败 HTTP ${responseB.status}]: ${errorText}`);
  }

  const dataB = await responseB.json();
  const messageB = dataB.choices?.[0]?.message;

  // 3. 从模型 B 的响应中解析图片 Base64
  let imageBase64Data = null;
  let ext = 'jpg';

  if (messageB && Array.isArray(messageB.images) && messageB.images.length > 0) {
    const firstImg = messageB.images[0];
    const rawUrl = typeof firstImg === 'string' ? firstImg : (firstImg.image_url?.url || firstImg.url || '');
    if (rawUrl.startsWith('data:image/')) {
      const match = rawUrl.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
      if (match) {
        ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        imageBase64Data = match[2];
      }
    } else if (rawUrl.length > 100) {
      imageBase64Data = rawUrl;
    }
  } else if (messageB && typeof messageB.content === 'string') {
    const match = messageB.content.match(/data:image\/([a-zA-Z0-9]+);base64,([A-Za-z0-9+/=]+)/);
    if (match) {
      ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      imageBase64Data = match[2];
    }
  }

  if (!imageBase64Data) {
    throw new Error(`模型B已响应，但未能解析出图像数据。返回响应结构: ${JSON.stringify(dataB).slice(0, 300)}`);
  }

  // 4. 保存图片到本地工作区
  const saveDirName = imageConf.saveDirectory || 'images/generated';
  const targetDir = path.isAbsolute(saveDirName)
    ? saveDirName
    : path.join(effectiveWorkspace, saveDirName);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const randomSuffix = crypto.randomBytes(3).toString('hex');
  const fileName = `img_${timestamp}_${randomSuffix}.${ext}`;
  const absoluteFilePath = path.join(targetDir, fileName);

  const imageBuffer = Buffer.from(imageBase64Data, 'base64');
  fs.writeFileSync(absoluteFilePath, imageBuffer);

  const relativePath = path.relative(effectiveWorkspace, absoluteFilePath);
  const dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${imageBase64Data}`;

  return {
    success: true,
    userPrompt,
    generatedPrompt: finalPrompt,
    absoluteFilePath,
    relativePath,
    dataUrl,
    sizeBytes: imageBuffer.length,
    modelA: imageConf.promptModelId || 'gemini-3.8-flash-high',
    modelB: imageConf.imageModelId || 'gemini-3.1-flash-image'
  };
}

/**
 * 结构对齐的纯 JS 适配器类，完全不依赖提前 require('@deepseek-ai/dsh-llm')，避免冷启动竞赛
 */
class FreeChainAdapterImpl {
  constructor(configGetter) {
    this.getConfig = configGetter;
  }

  providerInfo(provider) {
    return {
      id: provider,
      name: '自由模型链路 (Chain)'
    };
  }

  providerRetryPolicy(_provider) {
    return undefined;
  }

  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  listModels(provider) {
    const config = this.getConfig();
    const chains = (config.chains || []).filter(c => c.enabled !== false);

    return Promise.resolve(chains.map(chain => {
      let displayName = '';
      let desc = '';

      if (chain.type === 'image') {
        const ic = chain.imageConfig || {};
        displayName = `🎨 [绘图] ${chain.name} (${ic.promptModelId || 'prompt'} ➔ ${ic.imageModelId || 'image'})`;
        desc = `双模型绘画链路：模型A自动扩写提示词，模型B(${ic.imageModelId})渲染出图`;
      } else {
        const cc = chain.chatConfig || {};
        const modelNames = (cc.models || []).map(m => m.model).join(' ➔ ');
        displayName = `⚡️ [对话] ${chain.name} (${modelNames || '无模型'})`;
        desc = `高可用容灾对话链路：重试${cc.maxRetriesPerModel || 5}次自动按序轮转候选模型，保障对话不中断`;
      }

      return {
        provider,
        id: chain.id,
        name: displayName,
        description: desc
      };
    }));
  }

  resolveModel(provider, model) {
    const config = this.getConfig();
    const chain = (config.chains || []).find(c => c.id === model);

    let name = `自由链路 (${model})`;
    if (chain) {
      if (chain.type === 'image') {
        const ic = chain.imageConfig || {};
        name = `🎨 [绘图] ${chain.name} (${ic.promptModelId} ➔ ${ic.imageModelId})`;
      } else {
        const cc = chain.chatConfig || {};
        const modelNames = (cc.models || []).map(m => m.model).join(' ➔ ');
        name = `⚡️ [对话] ${chain.name} (${modelNames})`;
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
      stream: (options) => this.stream(options)
    };
  }

  async *stream(options) {
    const config = this.getConfig();
    const chainId = options.model;
    const chain = (config.chains || []).find(c => c.id === chainId);

    if (!chain) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: `❌ 未找到 ID 为 "${chainId}" 的链路配置，请检查设置。` };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `未找到链路配置` } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    if (chain.type === 'image') {
      yield* this.streamImageChain(chain, options);
    } else {
      yield* this.streamResilientChatChain(chain, options);
    }
  }

  async *streamImageChain(chain, options) {
    const cwd = process.cwd();
    const messages = options.messages || [];
    let userPrompt = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') userPrompt = msg.content;
        else if (Array.isArray(msg.content)) {
          userPrompt = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        }
        break;
      }
    }
    if (!userPrompt.trim()) userPrompt = '画一只可爱的蓝白小鲸鱼';

    yield { type: 'block-start', index: 0, blockType: 'text' };

    const ic = chain.imageConfig || {};
    const prefix = `🎨 **绘画链路 [${chain.name}] 已启动！**\n\n` +
      `* **模型 A（提示词扩写）**：\`${ic.promptModelProvider} / ${ic.promptModelId}\`\n` +
      `* **模型 B（后端绘画）**：\`${ic.imageModelProvider} / ${ic.imageModelId}\`\n\n` +
      `⏳ 正在分析需求并生成精美提示词...\n`;

    yield { type: 'text-delta', index: 0, text: prefix };

    let result;
    try {
      result = await executePaintingChain(chain, userPrompt, cwd);
    } catch (err) {
      const errText = `\n❌ **绘画链路执行失败**：\n> ${err.message}\n`;
      yield { type: 'text-delta', index: 0, text: errText };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: prefix + errText } };
      yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 100 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    const resultDelta = `\n✨ **模型 A 扩写的高精生图提示词**：\n` +
      `> ${result.generatedPrompt}\n\n` +
      `🖼️ **模型 B (${result.modelB}) 绘制结果**：\n\n` +
      `![生成的绘画作品](<${result.absoluteFilePath}>)\n\n` +
      `📁 **文件已保存到工作区**：\`${result.relativePath}\` (${Math.round(result.sizeBytes / 1024)} KB)\n`;

    yield { type: 'text-delta', index: 0, text: resultDelta };
    const fullText = prefix + resultDelta;

    yield { type: 'block-end', index: 0, block: { type: 'text', text: fullText } };
    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.round(userPrompt.length / 2),
        outputTokens: Math.round(fullText.length / 2)
      }
    };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  async *streamResilientChatChain(chain, options) {
    const cc = chain.chatConfig || {};
    const candidateModels = (cc.models || []).slice(0, 8);
    const maxRetries = Math.max(1, cc.maxRetriesPerModel || 5);

    if (candidateModels.length === 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: `⚠️ 对话链路 [${chain.name}] 未配置任何候选模型节点！` };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `未配置候选模型` } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    const openAiMessages = convertMessagesToOpenAI(options.messages, options.system);
    const openAiTools = convertToolsToOpenAI(options.tools);

    let activeStreamChunks = null;
    let successfulModel = null;
    const failuresLog = [];

    // 串行轮询每个候选模型
    for (let modelIndex = 0; modelIndex < candidateModels.length; modelIndex++) {
      const candidate = candidateModels[modelIndex];
      const modelDisplayName = `${candidate.provider} / ${candidate.model}`;
      const endpoint = resolveProviderEndpoint(candidate.provider);

      let modelSucceeded = false;
      let lastModelError = '';

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const streamUrl = `${endpoint.baseURL.replace(/\/+$/, '')}/chat/completions`;
          const reqBody = {
            model: candidate.model,
            messages: openAiMessages,
            temperature: options.temperature ?? 0.7,
            stream: true
          };
          if (openAiTools && openAiTools.length > 0) {
            reqBody.tools = openAiTools;
          }

          const response = await fetch(streamUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${endpoint.apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(reqBody)
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText.slice(0, 150)}`);
          }

          if (!response.body) {
            throw new Error('Response body stream is empty');
          }

          // 读取该流全部事件并验证是否为有效流（非空、非 malformed_function_call）
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let streamBuffer = '';
          const collectedEvents = [];
          let finishReason = null;
          let hasMeaningfulContent = false;
          let isDone = false;

          while (!isDone) {
            const { value, done } = await reader.read();
            if (done) break;

            streamBuffer += decoder.decode(value, { stream: true });
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;
              if (trimmed === 'data: [DONE]') {
                isDone = true;
                break;
              }

              try {
                const json = JSON.parse(trimmed.slice(5).trim());
                collectedEvents.push(json);

                const choice = json.choices?.[0];
                if (choice) {
                  if (choice.finish_reason) finishReason = choice.finish_reason;
                  const delta = choice.delta;
                  if (delta) {
                    if (typeof delta.content === 'string' && delta.content.length > 0) {
                      hasMeaningfulContent = true;
                    }
                    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                      hasMeaningfulContent = true;
                    }
                  }
                }
              } catch {}
            }
          }

          // 核心容灾拦截：如果上游返回了 malformed_function_call、或者内容为空字符串、或者没有产出任何文本与tool_calls，判定为该模型不可用，切换下一跳！
          if (finishReason === 'malformed_function_call') {
            throw new Error('上游模型返回 malformed_function_call (畸形工具调用)');
          }
          if (!hasMeaningfulContent) {
            throw new Error(`模型响应为空流 (finish_reason: ${finishReason || 'unknown'})`);
          }

          // 该模型成功产生有效流！
          activeStreamChunks = collectedEvents;
          successfulModel = candidate;
          modelSucceeded = true;
          break; // 退出当前模型的重试
        } catch (err) {
          lastModelError = err.message || '连接失败';
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 600));
          }
        }
      }

      if (modelSucceeded && activeStreamChunks) {
        break; // 成功找到首个有效可用模型，停止向后探查
      } else {
        failuresLog.push({
          model: modelDisplayName,
          order: modelIndex + 1,
          retries: maxRetries,
          error: lastModelError
        });
      }
    }

    if (!activeStreamChunks || !successfulModel) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      let failReport = `❌ **对话链路 [${chain.name}] 所有模型连接均已失败！**\n\n`;
      failReport += `故障转移排查记录（每个模型已尝试 ${maxRetries} 次重试）：\n`;
      for (const f of failuresLog) {
        failReport += `* **[次序 ${f.order}]** \`${f.model}\`：重试${f.retries}次后失败（${f.error}）\n`;
      }
      failReport += `\n请检查网络、代理端口或各 Provider 的 API 状态。`;

      yield { type: 'text-delta', index: 0, text: failReport };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: failReport } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    // 成功连接到某次序的模型，流式输出事件块
    let blockIndex = 0;
    let inTextBlock = false;
    let fullOutputText = '';

    // 如果发生了容灾切换，输出故障转移提示
    if (failuresLog.length > 0) {
      const switchNotice = `> ⚠️ **链路故障转移生效**：前置模型连接失败，上下文已无缝转移至 **次序 ${failuresLog.length + 1}：\`${successfulModel.provider} / ${successfulModel.model}\`**。\n\n`;
      yield { type: 'block-start', index: blockIndex, blockType: 'text' };
      yield { type: 'text-delta', index: blockIndex, text: switchNotice };
      fullOutputText += switchNotice;
      inTextBlock = true;
    }

    const toolCallBuffers = new Map(); // index -> { id, name, args }

    for (const json of activeStreamChunks) {
      const choice = json.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (!delta) continue;

      // 1. 处理思考内容 reasoning
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        yield { type: 'reasoning-delta', index: blockIndex, text: delta.reasoning_content };
      }

      // 2. 处理正文文本 content
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!inTextBlock) {
          yield { type: 'block-start', index: blockIndex, blockType: 'text' };
          inTextBlock = true;
        }
        fullOutputText += delta.content;
        yield { type: 'text-delta', index: blockIndex, text: delta.content };
      }

      // 3. 处理工具调用 tool_calls
      if (Array.isArray(delta.tool_calls)) {
        if (inTextBlock) {
          yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: fullOutputText } };
          inTextBlock = false;
          blockIndex++;
        }

        for (const tc of delta.tool_calls) {
          const tcIndex = tc.index ?? 0;
          if (!toolCallBuffers.has(tcIndex)) {
            const newTc = {
              id: tc.id || `call_${Date.now()}_${tcIndex}`,
              name: tc.function?.name || '',
              arguments: ''
            };
            toolCallBuffers.set(tcIndex, newTc);
            yield {
              type: 'block-start',
              index: blockIndex + tcIndex,
              blockType: 'tool-call'
            };
          }

          const existing = toolCallBuffers.get(tcIndex);
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          const argDelta = tc.function?.arguments || '';
          if (argDelta) {
            existing.arguments += argDelta;
            yield {
              type: 'tool-call-delta',
              index: blockIndex + tcIndex,
              id: existing.id,
              name: existing.name,
              argumentsDelta: argDelta
            };
          }
        }
      }
    }

    // 收尾关闭 text block
    if (inTextBlock) {
      yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: fullOutputText } };
      blockIndex++;
    }

    // 收尾关闭 tool-call blocks
    for (const [tcIndex, tc] of toolCallBuffers.entries()) {
      yield {
        type: 'block-end',
        index: blockIndex + tcIndex,
        block: {
          type: 'tool-call',
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        }
      };
    }

    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.round(JSON.stringify(openAiMessages).length / 3),
        outputTokens: Math.max(1, Math.round(fullOutputText.length / 2))
      }
    };

    const finalFinishReason = toolCallBuffers.size > 0 ? { kind: 'tool-calls' } : { kind: 'stop' };
    yield { type: 'finish', reason: finalFinishReason };
  }
}

/**
 * 插件的主激活函数
 */
export function apply(ctx, config) {
  ctx.logger?.info('dsh-plugin-image-chain: 模型自由链路系统已加载');

  let currentConfig = {
    chains: [
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
    ],
    ...config
  };

  // 1. 向 LLM 注册适配器与 Provider，使得所有配置的链路作为原生可选模型出现在模型选择器中！
  try {
    const disposeConfigurable = ctx.llm.registerConfigurableProviders([{
      provider: 'image-chain',
      displayName: '🔗 自由模型链路',
      settingsNs: 'image-chain',
      settingsPath: []
    }]);
    if (typeof disposeConfigurable === 'function') {
      ctx.effect(() => disposeConfigurable);
    }
  } catch (err) {}

  const adapter = new FreeChainAdapterImpl(() => currentConfig);
  try {
    const registration = ctx.llm.registerAdapter(['image-chain'], adapter);
    if (typeof registration === 'function') {
      ctx.effect(() => registration);
    }
  } catch (err) {}

  // 2. 注册 Web HTTP 接口供前端设置面板自由管理所有链路
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: '/api/image-chain/settings',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const availableProviders = getAvailableProvidersAndModels();
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({
            ok: true,
            currentConfig,
            availableProviders
          }));
          return;
        }

        if (req.method === 'POST') {
          let bodyText = '';
          req.on('data', c => bodyText += c);
          req.on('end', () => {
            try {
              const payload = JSON.parse(bodyText || '{}');
              if (Array.isArray(payload.chains)) {
                currentConfig.chains = payload.chains;
              }

              res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
              });
              res.end(JSON.stringify({ ok: true, currentConfig }));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        res.writeHead(405);
        res.end();
      }
    });

    if (typeof disposeRoute === 'function') {
      ctx.effect(() => disposeRoute);
    }
  }

  // 3. 注册保底 Agent Tool: chain_generate_image
  const disposeTool = ctx.tools.register({
    name: 'chain_generate_image',
    description: '【AI绘画链路工具】模型A自动扩写生图提示词，随后无缝投喂给后端绘画模型生成高清图像并保存到本地。',
    parameters: {
      type: 'object',
      required: ['requirement'],
      properties: {
        requirement: { type: 'string', description: '绘画设想与画面描述' }
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, val) => [{
        type: 'text',
        text: `🎨 **绘画链路完成**：\n\n> 提示词：${val.generatedPrompt}\n\n![Image](<${val.absoluteFilePath}>)\n\n路径：\`${val.relativePath}\``
      }]
    },
    async execute(args) {
      const defaultImgChain = (currentConfig.chains || []).find(c => c.type === 'image') || {
        imageConfig: {
          promptModelProvider: 'cpa',
          promptModelId: 'gemini-3.8-flash-high',
          imageModelProvider: 'cpa',
          imageModelId: 'gemini-3.1-flash-image',
          saveDirectory: 'images/generated'
        }
      };
      return await executePaintingChain(defaultImgChain, args.requirement, process.cwd());
    }
  });
  if (typeof disposeTool === 'function') {
    ctx.effect(() => disposeTool);
  }
}
