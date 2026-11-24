import { contextBridge, ipcRenderer } from 'electron';
import type { CharacterIndex } from '../shared/character.js';
import type { LocalVoice, SpeechSettings, SpeechState } from '../shared/speech.js';
import type { SpeechAsrConfig } from '../shared/asr-templates.js';
import type { DecisionLogOptions, DecisionRecord } from './companion/types.js';

export type { SpeechAsrConfig };

export interface Skill {
  id: string;
  name: string;
  systemPrompt: string;
}
export interface CharacterPersonaEntry {
  id: string;
  name: string;
  displayName: string;
  personality: string;
  speakingStyle?: string;
}
export interface CharacterPersonaSlot {
  personas: CharacterPersonaEntry[];
  activeId: string;
}
export interface AIConfig {
  baseURL: string;
  apiKey: string;
  /** 当前选中的 LLM 模型名 */
  model: string;
  /** 用户保存的多个 model 预设(下拉切换用) */
  modelPresets?: string[];
  skills: Skill[];
  activeSkillId: string;
  /** 长期记忆 — 用户习惯 / 偏好,自动拼到 system prompt */
  memory: string;
  /** 按角色分桶的 persona 配置;key = Live2DCharacter.name */
  characterPersonas?: Record<string, CharacterPersonaSlot>;
  /** 应用启动时默认打开的角色 id。为空或角色不存在时,回退到第一只 hatch-pet。 */
  defaultCharacterId?: string;
  /** 锁定模型位置 — true 时拖动桌宠不移动窗口,避免误拖 */
  lockPosition?: boolean;
  /** 编码(增强)模式 — 占位字段,UI 已暴露开关,功能待实现 */
  codingMode?: boolean;
  /** 编程陪伴读取本机 Codex 会话和 IDE 运行事件。 */
  codexCompanionEnabled?: boolean;
  /** 语音输入设置。 */
  voiceWake?: VoiceWakeConfig;
  /** MCP 工具开关 + 文件系统白名单 */
  mcp?: McpConfig;
  /** Agent Skills — 在线源、本地上传和内置 SKILL.md 知识库 */
  agentSkills?: AgentSkillsConfig;
  /** 主动互动增强(切角色互动 / 前台应用感知 / 自动读屏 等) */
  proactive?: ProactiveConfig;
  /** 多厂商配置预设(每个 profile = 一组 baseURL+apiKey+model+modelPresets) */
  providerProfiles?: ProviderProfile[];
  /** 当前激活的 profile id */
  activeProviderId?: string;
  /** 视觉辅助 — 主模型不识图时,用辅助模型先识图再喂回主模型 */
  visionAssist?: VisionAssistConfig;
  /** 通用模型辅助 — AI 干不动某项任务时,可主动调用其他 model 帮忙(经用户确认) */
  generalAssist?: GeneralAssistConfig;
  /** 语音识别引擎配置（本地离线 Vosk 模型 / OpenAI 兼容语音转文字 API） */
  speechAsr?: SpeechAsrConfig;
}

/** 视觉辅助配置(对应 electron/config-store.ts VisionAssistConfig) */
export interface VisionAssistConfig {
  enabled: boolean;
  assistantProfileId?: string;
  assistantModel?: string;
  fallbackAcrossAll: boolean;
}

/** 通用模型辅助配置(对应 electron/config-store.ts GeneralAssistConfig) */
export interface GeneralAssistConfig {
  enabled: boolean;
  assistantProfileId?: string;
  assistantModel?: string;
  fallbackAcrossAll: boolean;
  /** 跳过 confirm 弹窗 — 信任 AI 自动委托;开了之后 delegate 调用不再弹框。 */
  skipConfirm?: boolean;
}

/** 一个保存下来的厂商配置预设 */
export interface ProviderProfile {
  id: string;
  name: string;
  templateId?: string;
  baseURL: string;
  apiKey: string;
  model: string;
  modelPresets: string[];
}

/** 主动互动增强配置(对应 electron/config-store.ts ProactiveConfig) */
export interface ProactiveConfig {
  enabled: boolean;
  interactOnSwitch: boolean;
  awareApps: boolean;
  awareLongStay: boolean;
  idleStayMinutes: number;
  autoReadScreen: boolean;
  autoReadBrowser: boolean;
}

/** 一个外部 skill 仓库源 */
export interface AgentSkillSource {
  id: string;
  repo: string;
  branch: string;
  enabled: boolean;
}

export interface AgentSkillsConfig {
  enabled: boolean;
  sources: AgentSkillSource[];
  /** 被禁用的本地 skill rawId 列表 */
  localDisabled?: string[];
  /** 启用的内置 skill rawId 白名单(默认全关) */
  builtinEnabled?: string[];
}

/** 内置 skill 的展示元信息 */
export interface BuiltinSkillMeta {
  rawId: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface DownloadedSkillMeta {
  id: string;
  sourceId: string;
  rawId: string;
  name: string;
  cached?: boolean;
}
export interface RuntimeCacheUsage {
  totalBytes: number;
  items: Array<{ name: string; path: string; bytes: number }>;
}

export interface AppChangedPayload {
  reason?: string;
  [key: string]: unknown;
}

/** 一个 MCP server 的启动规格 */
export interface McpServerSpec {
  id: string;
  name: string;
  enabled: boolean;
  /** 'bundled-fs' 特殊值用打包的 server-filesystem;否则原样 spawn(npx/uvx/node 等) */
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** MCP(Model Context Protocol)设置 */
export interface McpConfig {
  enabled: boolean;
  /** 所有 MCP server(可启停 / 编辑) */
  servers: McpServerSpec[];
  /** 写操作是否需要二次确认 */
  confirmWrites: boolean;
}

/** MCP tool 描述(来自 listTools,已加 server 前缀) */
export interface McpTool {
  /** 前缀后的 name,形如 "fs__read_file" */
  name: string;
  /** 去前缀的原始 name,UI 显示用 */
  rawName: string;
  serverId: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 全局语音设置 */
export interface VoiceWakeConfig {
  /** 已废弃的旧版唤醒开关。新版写入时保持 false。 */
  enabled?: boolean;
  /** 对话框语音输入(听写)开关 */
  voiceInput?: boolean;
  /** 本地语音回复开关。 */
  voiceReply?: boolean;
  speech?: SpeechSettings;
}
/** OpenAI 多模态 content 单元(图片用 data URL) */
export type AIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  /** string = 纯文本;AIContentPart[] = 多模态(文本+图片) */
  content: string | AIContentPart[];
}

// 桥接给渲染进程的安全 API。后期 ToolDispatcher / ConfigStore 都从这里出。

/** 陪伴引擎（P0 记录模式）摘要 */
export interface CompanionSummaryLite {
  enabled: boolean;
  recordOnly: boolean;
  frequency: string;
  firstMetAt: string;
  today: { date: string; candidateCount: number; spokenCount: number; perIntent: Record<string, number> };
  lastSpokeAt: number | null;
  watchedEvents: number;
  logDir: string;
}

/** 陪伴引擎决策记录和 IDE 运行失败记录。 */
export type CompanionDecisionLite = DecisionRecord;

/** P1 用的陪伴气泡 payload */
export interface CompanionSayPayload {
  intent: string;
  line: string;
  durationMs: number;
  voice: boolean;
  ts: number;
}

const api = {
  ping: () => ipcRenderer.invoke('app:ping') as Promise<string>,
  scanCharacters: () => ipcRenderer.invoke('assets:scan') as Promise<CharacterIndex>,
  /** 运行缓存体积(Chromium cache / IndexedDB / GPU cache 等) */
  getRuntimeCacheUsage: () =>
    ipcRenderer.invoke('app:getRuntimeCacheUsage') as Promise<RuntimeCacheUsage>,
  /** 清理运行缓存。不会清 localStorage,所以不会丢对话记录 / 模型位置。 */
  clearRuntimeCache: () =>
    ipcRenderer.invoke('app:clearRuntimeCache') as Promise<RuntimeCacheUsage>,
  /** 让主进程把窗口按 (dx, dy) 像素移动。用于无边框窗 JS 拖拽。 */
  moveWindowBy: (dx: number, dy: number) =>
    ipcRenderer.invoke('window:moveBy', dx, dy) as Promise<void>,
  fitPetWindow: (rect: { x: number; y: number; width: number; height: number }, mode: 'compact' | 'expanded' | 'full') =>
    ipcRenderer.invoke('window:fitPet', rect, mode) as Promise<{
      x: number;
      y: number;
      width: number;
      height: number;
      modelX?: number;
      modelY?: number;
    } | null>,
  /** 调整窗口尺寸(随用户 scale 变化)。主进程会 clamp 到屏幕大小。 */
  setWindowSize: (w: number, h: number) =>
    ipcRenderer.invoke('window:setSize', w, h) as Promise<void>,
  /** 确保 BrowserWindow 至少能容纳给定 client 大小(只增不减),用于 popup 拉大时同步扩窗 */
  ensureWindowSize: (w: number, h: number) =>
    ipcRenderer.invoke('window:ensureSize', w, h) as Promise<void>,
  /** 报告模型腰线在窗口内的 Y(CSS 像素),给主进程做下方 clamp */
  setAnchorY: (y: number) => ipcRenderer.invoke('window:setAnchorY', y) as Promise<void>,
  /** 报告模型容器矩形,让透明窗口在模型区域优先接收鼠标 */
  setInteractiveBounds: (bounds: { left: number; top: number; width: number; height: number } | null) =>
    ipcRenderer.invoke('window:setInteractiveBounds', bounds) as Promise<void>,
  /** 设置鼠标穿透。透明区域 ignore=true 让事件穿透到下层窗口。 */
  setIgnoreMouseEvents: (ignore: boolean, forward: boolean) =>
    ipcRenderer.invoke('window:setIgnoreMouseEvents', ignore, forward) as Promise<void>,
  /**
   * 订阅全屏鼠标坐标(相对 BrowserWindow 左上角,CSS 像素)。
   * 即使鼠标在窗口外也持续推送,用于 Live2D 视线跟随。
   * 返回取消订阅函数。
   */
  onCursorScreen: (cb: (clientX: number, clientY: number) => void) => {
    const handler = (_e: unknown, x: number, y: number) => cb(x, y);
    ipcRenderer.on('cursor:screen', handler);
    return () => ipcRenderer.off('cursor:screen', handler);
  },
  /** 读取系统空闲秒数（鼠标 + 键盘），用于困倦待机判断。 */
  getSystemIdleSeconds: () => ipcRenderer.invoke('system:idle-seconds') as Promise<number>,

  // ---------------- 陪伴引擎（P0 记录模式） ----------------
  /** 陪伴引擎摘要：模式/今日候选与发言数/已监听事件数 */
  companionGetSummary: () => ipcRenderer.invoke('companion:get-summary') as Promise<CompanionSummaryLite | null>,
  /** 最近的陪伴记录。 */
  companionGetDecisions: (opts?: DecisionLogOptions) =>
    ipcRenderer.invoke('companion:get-decisions', opts) as Promise<CompanionDecisionLite[]>,
  companionClearDecisions: () => ipcRenderer.invoke('companion:clear-decisions') as Promise<number>,
  /** 用户摸头/聊天时调用：60s 内不主动说话 */
  companionMarkInteraction: () => ipcRenderer.invoke('companion:mark-interaction') as Promise<boolean>,
  /** P1 才会用到：主进程推来的陪伴气泡 */
  onCompanionSay: (cb: (payload: CompanionSayPayload) => void) => {
    const handler = (_e: unknown, payload: CompanionSayPayload) => cb(payload);
    ipcRenderer.on('companion:say', handler);
    return () => ipcRenderer.off('companion:say', handler);
  },

  // ---------------- AI ----------------
  /** 读取当前 AI 配置 */
  getConfig: () => ipcRenderer.invoke('config:get') as Promise<AIConfig>,
  /** 写入(部分覆盖)AI 配置;返回合并后的完整配置 */
  setConfig: (partial: Partial<AIConfig>) =>
    ipcRenderer.invoke('config:set', partial) as Promise<AIConfig>,
  onAppConfigChanged: (cb: (payload?: AppChangedPayload) => void) => {
    const handler = (_e: unknown, payload?: AppChangedPayload) => cb(payload);
    ipcRenderer.on('app:configChanged', handler);
    return () => ipcRenderer.off('app:configChanged', handler);
  },
  onAppSkillsChanged: (cb: (payload?: AppChangedPayload) => void) => {
    const handler = (_e: unknown, payload?: AppChangedPayload) => cb(payload);
    ipcRenderer.on('app:skillsChanged', handler);
    return () => ipcRenderer.off('app:skillsChanged', handler);
  },

  /**
   * 发起一次流式聊天。返回 cancel 函数(清理监听并中止主进程中的 AI HTTP 请求)。
   * onChunk:每段增量内容;onDone:正常结束;onError:失败信息。
   */
  sendChat: (
    messages: AIMessage[],
    onChunk: (delta: string, kind: 'answer' | 'thinking') => void,
    onDone: () => void,
    onError: (msg: string) => void,
  ) => {
    const reqId = 'r' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    type ChunkPayload = { reqId: string; delta: string; kind?: 'answer' | 'thinking' };
    type DonePayload = { reqId: string };
    type ErrPayload = { reqId: string; message: string };
    let finished = false;
    const offChunk = (_e: unknown, p: ChunkPayload) => {
      if (!finished && p.reqId === reqId) onChunk(p.delta, p.kind ?? 'answer');
    };
    const offDoneFn = (_e: unknown, p: DonePayload) => {
      if (p.reqId !== reqId) return;
      finished = true;
      cleanupListeners();
      onDone();
    };
    const offErrFn = (_e: unknown, p: ErrPayload) => {
      if (p.reqId !== reqId) return;
      finished = true;
      cleanupListeners();
      onError(p.message);
    };
    function cleanupListeners() {
      ipcRenderer.off('ai:chunk', offChunk);
      ipcRenderer.off('ai:done', offDoneFn);
      ipcRenderer.off('ai:error', offErrFn);
    }
    function cancel() {
      cleanupListeners();
      if (!finished) {
        finished = true;
        void ipcRenderer.invoke('ai:cancel', reqId).catch(() => {});
      }
    }
    ipcRenderer.on('ai:chunk', offChunk);
    ipcRenderer.on('ai:done', offDoneFn);
    ipcRenderer.on('ai:error', offErrFn);
    ipcRenderer.invoke('ai:chat', reqId, messages).catch((e: Error) => {
      finished = true;
      cleanupListeners();
      onError(e.message);
    });
    return cancel;
  },

  // ---------------- MCP ----------------
  /** 列出所有已连接 MCP server 的 tool(用于 UI 展示) */
  mcpListTools: () => ipcRenderer.invoke('mcp:listTools') as Promise<McpTool[]>,
  /** 查 MCP 运行状态 */
  mcpGetStatus: () => ipcRenderer.invoke('mcp:getStatus') as Promise<{ running: boolean }>,
  /** 手动重连(改了配置 / server 崩了 debug 用) */
  mcpRestart: () => ipcRenderer.invoke('mcp:restart') as Promise<{ running: boolean }>,
  /** 弹原生选目录框(可多选),返回绝对路径数组 */
  mcpPickDirectory: () => ipcRenderer.invoke('mcp:pickDirectory') as Promise<string[]>,
  /** 弹原生选文件框(单选),返回绝对路径或 null */
  mcpPickFile: (opts?: { filters?: Array<{ name: string; extensions: string[] }>; title?: string }) =>
    ipcRenderer.invoke('mcp:pickFile', opts) as Promise<string | null>,
  /** 一键安装 preset(npm install -g + 探测路径 + 写 config + 启动)。
   *  失败抛错;成功返回 server id 与可选的 postSetup 提示。 */
  mcpOneClickInstall: (presetId: string) =>
    ipcRenderer.invoke('mcp:oneClickInstall', presetId) as Promise<{
      serverId: string;
      postSetupUrl?: string;
      postSetupHint?: string;
    }>,
  /** 订阅一键安装过程的实时日志(stdout/stderr) */
  onMcpInstallLog: (cb: (p: { presetId: string; line: string }) => void) => {
    const h = (_e: unknown, p: { presetId: string; line: string }) => cb(p);
    ipcRenderer.on('mcp:installLog', h);
    return () => ipcRenderer.off('mcp:installLog', h);
  },

  /** 订阅"写操作确认请求"— 主进程在调用一个需要二次确认的 tool 前触发。
   *  UI 监听后弹模态框,用户选 允许/拒绝,调 mcpRespondConfirm(id, approve)。 */
  onMcpConfirmRequest: (
    cb: (payload: { id: string; toolName: string; args: unknown }) => void,
  ) => {
    const handler = (_e: unknown, p: { id: string; toolName: string; args: unknown }) => cb(p);
    ipcRenderer.on('mcp:confirm-request', handler);
    return () => ipcRenderer.off('mcp:confirm-request', handler);
  },
  /** 对 confirm-request 的回复。
   *  alwaysAllow=true + toolName 给出时,主进程会把该 tool 加入"本会话总是允许"集合,
   *  之后这个 tool 不再弹框,直到 electron 进程重启。 */
  mcpRespondConfirm: (
    id: string,
    approve: boolean,
    alwaysAllow?: boolean,
    toolName?: string,
  ) =>
    ipcRenderer.invoke('mcp:respond-confirm', id, approve, alwaysAllow, toolName) as Promise<void>,

  /** 订阅"剪贴板建议"— 用户复制 ≥ 200 字 / URL 时主进程触发,
   *  渲染端在桌宠头上弹一个 3 秒自消的小气泡。 */
  onClipboardSuggest: (
    cb: (payload: { text: string; isUrl: boolean; len: number }) => void,
  ) => {
    const handler = (
      _e: unknown,
      p: { text: string; isUrl: boolean; len: number },
    ) => cb(p);
    ipcRenderer.on('clipboard:suggest', handler);
    return () => ipcRenderer.off('clipboard:suggest', handler);
  },
  /** 渲染端在自己写剪贴板前调一下,告诉主进程"接下来这段文本不要触发建议" */
  clipboardIgnoreNext: (text: string) =>
    ipcRenderer.invoke('clipboard:ignoreNext', text) as Promise<void>,
  /** 在系统默认浏览器打开 URL(给设置面板的链接用)。 */
  openExternal: (url: string) =>
    ipcRenderer.invoke('app:openExternal', url) as Promise<void>,
  /** 打开随安装包附带的本地《使用说明与功能介绍.html》 */
  openUserGuide: () =>
    ipcRenderer.invoke('app:openUserGuide') as Promise<{ ok: boolean; path?: string; error?: string }>,
  getUserGuidePath: () =>
    ipcRenderer.invoke('app:getUserGuidePath') as Promise<string | null>,
  /** 全屏截图 — 主进程会先短暂 hide 桌宠窗再截,完了 show 回来。
   *  返回 PNG dataURL(可直接当 OpenAI image_url 用),失败 null。 */
  captureScreen: () => ipcRenderer.invoke('screen:capture') as Promise<string | null>,
  /** 全屏截图 + 鼠标位置 — 用户问「鼠标在哪 / 我指的是什么」时用。
   *  返回 dataURL + cursor 坐标(DIP,主屏相对) + 主屏尺寸,渲染端自己用 Canvas 标注。 */
  captureScreenWithCursor: () =>
    ipcRenderer.invoke('screen:capture-with-cursor') as Promise<{
      dataURL: string;
      cursor: { x: number; y: number; onPrimary: boolean };
      screenSize: { width: number; height: number };
    } | null>,
  /** 解析 PDF — 主进程用 pdf-parse 抽纯文本;失败返回 null(扫描件无文字层 / 加密 等)。
   *  传 ArrayBuffer 给主进程(structured clone),不要传 File / Blob。 */
  parsePdf: (buf: ArrayBuffer) =>
    ipcRenderer.invoke('parse:pdf', new Uint8Array(buf)) as Promise<string | null>,
  /** 读开机自启动状态。supported=false 表示当前环境不支持(dev 模式或非 win/mac) */
  getAutoLaunch: () =>
    ipcRenderer.invoke('app:getAutoLaunch') as Promise<{ enabled: boolean; supported: boolean }>,
  /** 写开机自启动开关,返回最新生效值 */
  setAutoLaunch: (enabled: boolean) =>
    ipcRenderer.invoke('app:setAutoLaunch', enabled) as Promise<{ enabled: boolean }>,

  /** 主动隐藏桌宠窗口到托盘 / 显示 / 切换 */
  windowHide: () => ipcRenderer.invoke('window:hide') as Promise<void>,
  windowShow: () => ipcRenderer.invoke('window:show') as Promise<void>,
  windowToggle: () => ipcRenderer.invoke('window:toggle') as Promise<void>,
  /** 完全退出应用(关闭主窗口、停 MCP、持久化 config) */
  appQuit: () => ipcRenderer.invoke('app:quit') as Promise<void>,
  /** 渲染端切了角色后通知主进程,刷新托盘菜单的当前激活标记 */
  trayRefresh: (opts?: { activeCharacterId?: string | null }) =>
    ipcRenderer.invoke('tray:refresh', opts) as Promise<void>,
  pickAndImportLive2D: () =>
    ipcRenderer.invoke('live2d:pick-and-import') as Promise<{ ok: true } | { ok: false; error?: string }>,
  openLive2DDirectory: () =>
    ipcRenderer.invoke('live2d:open-directory') as Promise<void>,
  /** 订阅托盘菜单的指令(切换角色 / 打开对话 / 打开设置) */
  onTraySwitchCharacter: (cb: (id: string | null) => void) => {
    const h = (_e: unknown, id: string | null) => cb(id);
    ipcRenderer.on('tray:switch-character', h);
    return () => ipcRenderer.off('tray:switch-character', h);
  },
  onTrayOpenChat: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('tray:open-chat', h);
    return () => ipcRenderer.off('tray:open-chat', h);
  },
  /** 「只打开对话」— 显示对话气泡,但隐藏模型 canvas */
  onTrayOpenChatOnly: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('tray:open-chat-only', h);
    return () => ipcRenderer.off('tray:open-chat-only', h);
  },
  onTrayOpenSettings: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('tray:open-settings', h);
    return () => ipcRenderer.off('tray:open-settings', h);
  },

  /** 主动互动:前台应用切换 / 长停留事件 — 后台 ProactiveAware 推过来 */
  onProactiveAppEvent: (
    cb: (p: { reason: 'switch' | 'long-stay'; app: string; friendly: string; title: string }) => void,
  ) => {
    const h = (
      _e: unknown,
      p: { reason: 'switch' | 'long-stay'; app: string; friendly: string; title: string },
    ) => cb(p);
    ipcRenderer.on('pet:proactive-app-event', h);
    return () => ipcRenderer.off('pet:proactive-app-event', h);
  },

  // ===== 本地 skill 管理(用户从设置面板上传 SKILL.md) =====
  /** 列出已上传的本地 skill */
  skillsListLocal: () =>
    ipcRenderer.invoke('skills:listLocal') as Promise<
      { id: string; sourceId: string; rawId: string; name: string }[]
    >,
  skillsListDownloaded: () =>
    ipcRenderer.invoke('skills:listDownloaded') as Promise<DownloadedSkillMeta[]>,
  /** 弹文件对话框选 .md 上传 — 成功返回新 entry,取消返回 null */
  skillsPickAndUploadLocal: () =>
    ipcRenderer.invoke('skills:pickAndUploadLocal') as Promise<
      { id: string; sourceId: string; rawId: string; name: string } | null
    >,
  /** 按 rawId(文件名,无扩展名)删除一条本地 skill */
  skillsRemoveLocal: (rawName: string) =>
    ipcRenderer.invoke('skills:removeLocal', rawName) as Promise<boolean>,
  /** 长期记忆 — 列出所有条目(按 createdAt 正序)*/
  memoryList: () =>
    ipcRenderer.invoke('memory:list') as Promise<
      Array<{ id: string; content: string; createdAt: number }>
    >,
  /** 长期记忆 — 新增(重复 content 会刷新 createdAt,返回同一条)*/
  memoryAdd: (content: string) =>
    ipcRenderer.invoke('memory:add', content) as Promise<{
      id: string;
      content: string;
      createdAt: number;
    }>,
  /** 长期记忆 — 按 id 编辑内容。成功返回 true,id 不存在返回 false */
  memoryUpdate: (id: string, content: string) =>
    ipcRenderer.invoke('memory:update', id, content) as Promise<boolean>,
  /** 长期记忆 — 按 id 或 content 子串删除,返回删除数量 */
  memoryRemove: (idOrMatch: string) =>
    ipcRenderer.invoke('memory:remove', idOrMatch) as Promise<number>,
  /** 长期记忆 — 清空所有 */
  memoryClear: () => ipcRenderer.invoke('memory:clear') as Promise<boolean>,
  /** 本应用本地请求/Token 估算；不代表 ChatGPT 订阅剩余额度。 */
  usageLocal: () => ipcRenderer.invoke('usage:local') as Promise<{ requests: number; inputTokens: number; outputTokens: number; lastRequestAt: number | null; note: string } | null>,
  usageClear: () => ipcRenderer.invoke('usage:clear') as Promise<{ requests: number; inputTokens: number; outputTokens: number; lastRequestAt: number | null; note: string }>,
  codexQuotaGet: () => ipcRenderer.invoke('codexQuota:get') as Promise<{ ok: boolean; queryOk: boolean; planLabel: string; observedAt: number | null; stale: boolean; windows: Array<{ id: string; label: string; minutes: number; usedPercent: number; remainingPercent: number; resetsAt: number | null }>; error?: string } | null>,
  codexQuotaRefresh: () => ipcRenderer.invoke('codexQuota:refresh') as Promise<{ ok: boolean; queryOk: boolean; planLabel: string; observedAt: number | null; stale: boolean; windows: Array<{ id: string; label: string; minutes: number; usedPercent: number; remainingPercent: number; resetsAt: number | null }>; error?: string } | null>,
  /** 使用所选本地语音引擎朗读。 */
  ttsSpeak: (text: string) => ipcRenderer.invoke('tts:speak', text) as Promise<boolean>,
  ttsStop: () => ipcRenderer.invoke('tts:stop') as Promise<boolean>,
  ttsVoices: () => ipcRenderer.invoke('tts:voices') as Promise<{ voices: LocalVoice[]; error?: string }>,
  /** 检查本地 F5-TTS 克隆声资源；模型和文本均不上传。 */
  ttsCloneStatus: () => ipcRenderer.invoke('tts:clone-status') as Promise<{ available: boolean; reason: string; root?: string }>,
  ttsChooseCloneFolder: () => ipcRenderer.invoke('tts:choose-clone-folder') as Promise<string | null>,
  /** 朗读状态：preparing/speaking/idle/error。 */
  onTtsState: (cb: (payload: SpeechState) => void) => {
    const handler = (_e: unknown, payload: SpeechState) => cb(payload);
    ipcRenderer.on('tts:state', handler);
    return () => ipcRenderer.off('tts:state', handler);
  },
  /** 从当前 OpenAI-compatible 服务读取可用模型，失败时返回错误，不保存密钥。 */
  aiListModels: (baseURL: string, apiKey: string) => ipcRenderer.invoke('ai:list-models', baseURL, apiKey) as Promise<{ ok: true; models: string[] } | { ok: false; error: string }>,

  /** 自定义 vosk 模型:查当前是否装了 */
  voskGetCustomModelInfo: () =>
    ipcRenderer.invoke('vosk:getCustomModelInfo') as Promise<
      { hasCustom: false; hasBuiltin: boolean } | { hasCustom: true; hasBuiltin: boolean; fileName: string; sizeBytes: number }
    >,
  /** 自定义 vosk 模型:弹对话框选 .zip 上传,返回 { fileName, sizeBytes } 或 null(取消)*/
  voskPickAndImportModel: () =>
    ipcRenderer.invoke('vosk:pickAndImportModel') as Promise<
      { fileName: string; sizeBytes: number } | null
    >,
  /** 移除用户导入的 Vosk 模型。 */
  voskRemoveCustomModel: () => ipcRenderer.invoke('vosk:removeCustomModel') as Promise<boolean>,

  /** 语音识别 API：把 16kHz 单声道 WAV 转成文本（走主进程 net.request，支持系统代理且无 CORS 限制） */
  asrTranscribe: (wavBuffer: ArrayBuffer, reqId?: string) =>
    ipcRenderer.invoke('asr:transcribe', new Uint8Array(wavBuffer), reqId) as Promise<{ text: string }>,
  asrCancel: (reqId?: string) =>
    ipcRenderer.invoke('asr:cancel', reqId) as Promise<boolean>,
  asrTestConnection: (override?: Partial<SpeechAsrConfig>) =>
    ipcRenderer.invoke('asr:test', override) as Promise<
      { ok: true; latencyMs: number; text: string } | { ok: false; error: string }
    >,

  /** 导入 Hatch-Pet 角色 — 弹原生选目录对话框,选含 pet.json + spritesheet.webp 的文件夹。
   *  成功返回 { ok:true, added:{ id, name, folder } };失败 { ok:false, error };取消返回 null。 */
  hatchPetImport: () =>
    ipcRenderer.invoke('hatchPet:import') as Promise<
      | { ok: true; added: { id: string; name: string; folder: string } }
      | { ok: false; error: string }
      | null
    >,
  /** 删除用户导入的 Hatch-Pet 角色(只能删 source='user' 的,builtin 不可删) */
  hatchPetRemove: (characterId: string) =>
    ipcRenderer.invoke('hatchPet:remove', characterId) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  /** 列出所有内置 skill 及其当前启用状态(给设置面板用) */
  skillsListBuiltin: () =>
    ipcRenderer.invoke('skills:listBuiltin') as Promise<BuiltinSkillMeta[]>,
  /** 写文本到剪贴板 — 走 Electron 主进程的 clipboard,不要求文档 focused。
   *  桌宠是透明 + 鼠标穿透窗口,navigator.clipboard.writeText 经常 reject,所以提供这个 fallback。
   *  内部会先 ignoreNext 一下,避免触发自家的"剪贴板建议"气泡。 */
  writeClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', text) as Promise<boolean>,

  /** 订阅"工具调用事件"— 主进程调 MCP tool 前/后触发,用于在聊天里展示调用过程。
   *  stage = 'call' | 'result' | 'error'。 */
  onMcpToolEvent: (
    cb: (payload: {
      reqId: string;
      callId: string;
      stage: 'call' | 'result' | 'error';
      toolName: string;
      args?: unknown;
      result?: unknown;
      error?: string;
    }) => void,
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (_e: unknown, p: any) => cb(p);
    ipcRenderer.on('mcp:tool-event', handler);
    return () => ipcRenderer.off('mcp:tool-event', handler);
  },
};

try {
  contextBridge.exposeInMainWorld('petAPI', api);
  // eslint-disable-next-line no-console
  console.log('[preload] petAPI exposed OK');
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[preload] expose failed:', e);
}

export type PetAPI = typeof api;

// 类型声明:让 TS 在渲染进程能看到 window.petAPI
declare global {
  interface Window {
    petAPI: PetAPI;
  }
}

