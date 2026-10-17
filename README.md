# 🔗 DSH-Always-Connected (模型自由链路插件)

**DSH-Always-Connected** 是专为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 与 Cordis 架构量身打造的原生模型自由链路与高可用插件。

通过将多模型协同机制深度封装为原生的 `LlmAdapter`，插件让你可以自由编排**【双模型 AI 绘画链路】**与**【高可用容灾对话链路】**，并在设置中心自由配置前后端模型，直接在对话界面的模型下拉菜单中一键选用！

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

在你的 Profile（例如 `~/.dsh/profiles/desktop/cordis.patch.yml`）中添加插入行：

```yaml
- insert:
    - id: image-chain
      name: dsh-always-connected
      config:
        chains:
          - id: chain-resilient-chat
            name: "高可用容灾对话链路"
            type: "chat"
            enabled: true
            chatConfig:
              maxRetriesPerModel: 5
              models:
                - provider: "cpa"
                  model: "gemini-3.8-flash-high"
                - provider: "cpa"
                  model: "claude-sonnet-4-6"
                - provider: "workbuddypanel"
                  model: "cn:deepseek-v4.1-flash"
          - id: chain-default-image
            name: "默认绘画链路"
            type: "image"
            enabled: true
            imageConfig:
              promptModelProvider: "cpa"
              promptModelId: "gemini-3.8-flash-high"
              imageModelProvider: "cpa"
              imageModelId: "gemini-3.1-flash-image"
              saveDirectory: "images/generated"
```

---

## 📄 License

MIT License. Designed with ❤️ for DeepSeek Harness.
