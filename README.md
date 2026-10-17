# 🔗 DSH-Always-Connected (模型自由链路插件)

**DSH-Always-Connected** 是专为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 与 Cordis 架构量身打造的原生模型自由链路与高可用插件。

通过将多模型协同机制深度封装为原生的 `LlmAdapter`，插件让你可以自由编排**【双模型 AI 绘画链路】**与**【高可用容灾对话链路】**，并在设置中心自由配置前后端模型，直接在对话界面的模型下拉菜单中一键选用！

---

## 🆕 v2.2.2 更新内容（过滤模型切换系统通知）

### 🐛 关键 Bug 修复

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | 切换到绘画模型后立即发送画图，画面变成随机风景 | 切换模型时 DSH 会在消息尾部追加 `[model changed: ...]` 的通知消息；若未过滤该系统通知，提示词模型拿到无意义的技术提示词会自由发挥生成风景 | 在 `isUserPromptMessage` 与 `cleanUserPromptText` 中加入针对 `[model changed:` 标记的严格过滤与剥离 |

---

## 🆕 v2.2.1 更新内容（精准用户 Prompt 提取修复）

### 🐛 关键 Bug 修复

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | 绘画链路生成的画面与用户要求完全无关（例如生成当前时间戳相关夜景） | DSH 架构会在轮次消息流末尾追加 `time-context`（时间戳）、`runtime-context`（沙箱快照）、`<system-reminder>` 等伪 user 消息；插件原逻辑倒序简单判定 `role === 'user'`，直接命中了尾部追加的时间戳 | 严格检查 `source.kind === 'user'`，新增 `isUserPromptMessage` 与 `cleanUserPromptText` 正则净化，过滤系统时间戳、运行时上下文及插件提示，精准提取真实输入 |

---

## 🆕 v2.2.0 更新内容（本次修复）

### 🐛 关键 Bug 修复

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | 生成的图片在对话里**看不到预览** | 聊天正文图片走 `pathImages → localPathMediaUrl → fileMediaUrl`，该链路**只接受绝对路径**，相对路径直接返回 `undefined` | Markdown 图片改为 `encodeURI(绝对路径)`，窗口内即时渲染 |
| 2 | 图片被存到**错误的目录**（跑进默认工作区） | 插件未在 `inject` 中声明 `sessions`，`ctx.sessions` 抛错被吞，回退到默认工作区 | `inject` 补上 `sessions`，改用 `ctx.sessions.get(sessionId).header.cwd` 精确定位会话工作区 |
| 3 | 新配置的链路在模型下拉框里**必须重启才出现** | 保存后只写内存与文件，未广播拓扑变更 | 保存时调用 `adapterHandle.replace(['image-chain'])` + 广播 `llm/adapters-updated`，前端同时调用 `modelDirectories.catalog.refresh()`，**免重启秒级刷新** |
| 4 | 长回复**只输出第一段就断流** | 探针阶段用 `for await ... break`，会触发生成器 `return()` 关闭流 | 改为持有 `iterator` 手动 `next()`，探针后继续读取同一条流 |
| 5 | 工具调用收尾错乱 | `closeBlocks()` 先清空 `toolBuffers` 再判断 `size > 0`，`finish` 永远是 `stop`；故障转移提示还会留下未闭合的 text block | 新增 `hadToolCalls` 标志；内容块统一由状态机开块/收块，`finish` 正确产出 `tool-calls` |
| 6 | 插件更新后**设置好的链路被覆盖重置** | 同一份配置既写 `chains.json` 又回写 `cordis.patch.yml`，patch 改动触发 HMR 重载互相打架 | **单一真相源**：只写 `~/.dsh/storages/always-connected/chains.json`，patch 中仅保留 `config: {}` |
| 7 | 设置面板夜间模式**文字看不见 / 命名框消失** | 硬编码浅色；组件树顶层 `return` 数组漏传 `basics` 子块 | 全面改用 `--dsw-alias-*` 主题变量；选中项实心品牌色 + 白字；补齐漏掉的命名区块 |

### ✨ 稳定性增强

- **重试策略精准化**：仅对 `408 / 409 / 425 / 429 / 5xx` 重试，`400 / 401 / 403 / 404 / 422` 直接切下一模型，不再无谓空耗配额。
- **首字超时与取消**：首字 90 秒超时；完整透传 `AbortSignal`，用户中断即停。
- **推理块规范化**：正确产出 `block-start(reasoning) → reasoning-delta → block-end`，`text` / `tool-call` 块使用唯一索引，杜绝块冲突。
- **设置接口加固**：入参校验（`chains` 为空或缺 `id` 返回 400）、原子写入（tmp + rename）、双路由兼容（`/api/image-chain/settings` 与 `/api/always-connected/settings`）。
- **设置面板体验**：修改后 600ms 防抖自动保存、空态引导、`GET` 回显 `build` 与存储路径，便于排查。

> ⚠️ 注意：插件 **Host 侧源码改动**无法通过 bundle 启停热更（Cordis 复用 ESM 模块缓存），更新 `index.js` 后需**完整重启 DSH** 一次；重启后 `/api/image-chain/settings` 返回的 `build` 字段可用于确认加载版本。

---

## 🌟 核心特性

### 1. ⚡️ 高可用容灾对话链路 (Resilient Chat Fallback Chain)
- **告别连接失败与任务掉线**：面对单一模型或代理网络波动（例如重试 5 次依然超时或不可用时），传统机制会直接抛出错误中断任务；本插件支持添加 **最多 8 个候选模型** 组成按序故障转移链路。
- **严格串行轮询探测**：模型 1 达到重试上限且无法接通后，才串行探测模型 2、模型 3……**严禁并发无脑全查**，保护 API 配额与带宽。
- **无缝接力上下文与任务**：只要链路中某个次序的模型成功建立流，当前完整的会话上下文、历史消息与正在执行的任务将无缝移交给该模型接续执行，对话永不卡死中断。
- **智能过滤空响应与畸形调用**：自动识别 `finish_reason: malformed_function_call`、空流响应或丢失参数，主动触发下一跳容灾，并支持完整 tools 工具定义与 tool 消息透传。
- **透明容灾提示**：若发生故障降级，流式输出开头将自动附带友好的转移提示，清晰告知当前接力的模型次序。

### 2. 🎨 双模型 AI 绘画链路 (Prompt-to-Image Chain)
- **大模型提示词工程自动化**：解决绘画模型自身无法精准理解自然语言与编写细致 Prompt 的痛点。
- **两阶段流水线**：
  1. **模型 A (提示词扩写)**：根据用户简短的中文/英文自然语言描述，全自动扩写为具备艺术风格、镜头光影、主体构图的高精英文 Prompt；
  2. **模型 B (绘图引擎)**：无缝接收模型 A 产出的最终提示词，自动投喂至 `gemini-3.1-flash-image`（或其他生图模型）完成高质量画面渲染。
- **自动落盘与持久化**：生成的 Base64 图像自动解码并保存至本地工作区（默认 `images/generated/`），并在对话流中直接呈现渲染作品与下载卡片。

### 3. ⚙️ 原生设置中心与模型选择器深度融合
- **专属设置面板 (`Settings ➔ 🔗 模型自由链路设置`)**：
  - 支持多链路标签管理，随时点击 `+ 对话容灾链路` 或 `+ 绘画链路` 新建；
  - 允许自定义链路名称（如 `主力容灾·工作流`、`赛璐璐生图链`）；
  - 支持在下拉菜单中动态发现宿主配置的所有 Provider 与模型，直观设置 1~8 级次序；
  - 设置自动写入 Profile 配置文件，重启持久有效。
- **原生对话模型选择器直接选用**：
  - 链路直接注册为原生的独立对话模型；
  - 模型下拉列表中清晰呈现链路名称与模型轮询次序（例如：`⚡️ [对话] 高可用容灾对话链路 (gemini-3.8-flash-high ➔ claude-sonnet-4-6 ➔ cn:deepseek-v4.1-flash)`），自由切换。

---

## 📦 项目结构

```
dsh-always-connected/
├── index.js             # Host 核心：FreeChainAdapterImpl、流式调度与故障转移容灾引擎、Web API
├── client.js            # Client 界面：Settings 面板 Slot 注册、多链路增删改配 UI
├── package.json         # 插件清单与 DSH Bundle 导出声明
├── cordis.patch.yml     # Cordis Loader 默认插入补丁
├── icon.svg             # 插件专属矢量图标
└── locale/              # 国际化语言包 (zh.json / en.json)
```

---

## 🚀 安装与配置

### 方式一：在已配置好的 DSH Profile 中安装

```bash
dsh plugin install /path/to/dsh-always-connected
```

或者通过 DSH 的 `plugin_manager` 安装 bundle 目录。

### 方式二：手动配置在 `cordis.patch.yml`

在你的 Profile（例如 `~/.dsh/profiles/desktop/cordis.patch.yml`）中添加插入行。**注意：链路配置不再写进 patch**，patch 只负责挂载插件：

```yaml
- id: image-chain
  name: dsh-always-connected
  config: {}
```

安装后首次启动，插件会把内置的默认链路写入独立存储：

```
~/.dsh/storages/always-connected/chains.json
```

**这个 JSON 是唯一真相源** —— 之后所有增删改都只写这里，插件升级 / 重装 / 修改 patch 都不会覆盖你的配置。想恢复出厂设置，删掉该文件重启即可。

---

## 🔧 配置字段速查

```jsonc
[
  // 绘画链路
  {
    "id": "chain-default-image",
    "name": "gemini绘画",              // 显示在模型选择器里的名字
    "type": "image",
    "enabled": true,
    "imageConfig": {
      "promptModelProvider": "cpa",     // 模型 A：提示词扩写
      "promptModelId": "gemini-3.8-flash-high",
      "imageModelProvider": "cpa",      // 模型 B：绘图
      "imageModelId": "gemini-3.1-flash-image",
      "saveDirectory": "images/generated" // 相对会话工作区
    }
  },
  // 容灾对话链路（最多 8 个模型，严格按序串行探测）
  {
    "id": "chain-resilient-chat",
    "name": "高可用容灾对话链路",
    "type": "chat",
    "enabled": true,
    "chatConfig": {
      "maxRetriesPerModel": 5,
      "models": [
        { "provider": "cpa", "model": "gemini-3.8-flash-high" },
        { "provider": "cpa", "model": "claude-sonnet-4-6" },
        { "provider": "workbuddypanel", "model": "cn:deepseek-v4.1-flash" }
      ]
    }
  }
]
```

---

## 🔌 HTTP 接口（设置面板使用）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/image-chain/settings` | 返回 `currentConfig`、`availableProviders`、`build`、`storageFile` |
| `POST` | `/api/image-chain/settings` | Body `{ chains: [...] }`，校验通过后原子写入并**热广播**模型拓扑 |
| 同上 | `/api/always-connected/settings` | 兼容别名，行为完全一致 |

---

## 📄 License

MIT License. Designed with ❤️ for DeepSeek Harness.
