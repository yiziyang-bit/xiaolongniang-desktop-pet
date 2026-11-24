import { app, BrowserWindow, screen, ipcMain, globalShortcut, protocol, net, session, dialog, clipboard, shell, Tray, Menu, nativeImage, desktopCapturer, powerMonitor } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { LocalSpeech, listLocalVoices } from './local-speech.js';
import { CloneSpeech } from './clone-speech.js';
import { scanAll, resolveAssetRoots } from './asset-scanner.js';
import { loadConfig, saveConfig, type AppConfig, type SpeechAsrConfig } from './config-store.js';
import { streamChat, cancelChat, cancelAllChats, type ChatMessage } from './ai-client.js';
import { transcribeAudio, testAsrConnection, cancelAsr, cancelAllAsr } from './asr-client.js';
import { getLocalUsage, clearLocalUsage, recordLocalUsage } from './usage-tracker.js';
import { getCodexQuota, refreshCodexQuota, cancelCodexQuotaRefresh } from './codex-usage.js';
import { mcpManager, type McpToolDesc } from './mcp-client.js';
import { proactiveAware } from './proactive-aware.js';
import { CompanionEngine } from './companion/engine';
import { CompanionSpeechQueue } from './companion/speech-queue';
import { CompanionStore } from './companion/store';
import { appEvents } from './app-events.js';
import { getPetWindowBounds, clampModelToDisplay, type PetWindowMode } from './pet-window-layout.js';
// 开发态的透明桌宠需要关闭 webSecurity 以加载 pet:// 纹理；隐藏 Electron 的重复警告，
// 不改变生产环境行为，也不放宽应用自己的 IPC/导航白名单。
if (!app.isPackaged) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
import {
  loadCachedSkillsIndex,
  syncSkillsIndex,
  addLocalSkill,
  removeLocalSkill,
  listLocalSkills,
  listDownloadedSkills,
  listBuiltinSkills,
} from './skill-registry.js';
import {
  listMemories,
  addMemory,
  updateMemory,
  removeMemory,
  clearMemories,
} from './memory-store.js';
// 必须在 app.whenReady 之前注册自定义协议特权,否则 fetch / CORS / CSP 无法通过。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pet',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
      corsEnabled: true,
    },
  },
]);

// __dirname shim for ESM build (vite-plugin-electron 会编译为 CJS,但保险写一份)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 开发态 Vite dev server URL,生产态加载本地 index.html
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const DIST = path.join(__dirname, '..', 'dist');
const APP_ENTRY = VITE_DEV_SERVER_URL ?? 'pet://app/index.html';
const CUBISM_CORE = 'live2dcubismcore.min.js';

app.setName('XiaolongniangDesktopPet');

function isAppPage(url: string): boolean {
  try {
    const candidate = new URL(url);
    candidate.hash = '';
    return candidate.href === new URL(APP_ENTRY).href;
  } catch {
    return false;
  }
}

function live2dUserDirectory(): string {
  return path.join(app.getPath('userData'), 'live2d');
}
/**
 * 默认启动始终是无边框透明桌宠模式。
 * 只有显式传入 --preview-window 才打开带边框的验收窗口；
 * 这样用户即使沿用旧的 --preview 命令，也不会被限制在一个框架里。
 */
const PREVIEW_MODE = process.argv.includes('--preview-window');
// 我们强制 preload 输出 .cjs;留兜底以防配置改回。
function resolvePreload(): string {
  for (const name of ['preload.cjs', 'preload.js', 'preload.mjs']) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, 'preload.cjs');
}
const PRELOAD = resolvePreload();
console.log('[main] PRELOAD =', PRELOAD, 'exists =', fs.existsSync(PRELOAD));

let mainWindow: BrowserWindow | null = null;

// 桌宠只允许一个实例。开机启动项、ChatGPT 监视器和手动脚本可能同时触发，
// 后续启动只唤醒已有窗口，避免桌面出现两只小龙娘或重复拦截鼠标。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 仅开发态重刷页面以免打断打包版进行中的 AI 对话
      if (!app.isPackaged) {
        mainWindow.webContents.reloadIgnoringCache();
      }
      showWindow();
      mainWindow.focus();
    }
  });
}

function notifyRenderer(channel: string, payload?: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}
appEvents.on('configChanged', (payload) => notifyRenderer('app:configChanged', payload));
appEvents.on('skillsChanged', (payload) => notifyRenderer('app:skillsChanged', payload));
let tray: Tray | null = null;
/** 跟踪窗口可见状态 — 隐藏时 mainWindow 仍存在,只是 hide()。Tray click 用它判断要 show 还是 hide */
let windowVisible = true;
/** 当前激活角色 id — 渲染端切了之后通过 IPC 推过来,托盘菜单据此显示 ● 标记 */
let activeCharacterId: string | null | undefined;
// 窗口尺寸 = workArea × WINDOW_FRAC(撑满屏幕大部分,鼠标穿透不影响桌面)
// 模型由 character-host 组件用 inline width/height 自己定大小并绝对居中,
// 不再依赖 PAD/main 进程算尺寸。setWindowSize IPC 保留为兼容(noop 化)。
// 注意:Electron 的 screen 模块只能在 app.ready 后调用,所以默认尺寸只占位,
// createWindow 内会真正算出 workArea × FRAC 并赋值。
// 1.0 = 占满整个工作区(任务栏外的可用区域),让对话框/模型能拖到屏幕任何角落。
// 因为鼠标在 character-host 和 popup 之外是穿透的,所以即使窗口铺满屏幕,
// 也完全不影响用户操作桌面图标/其他应用。
const WINDOW_FRAC = 1.0;
let currentW = 1280;
let currentH = 800;
let fittingPetWindow = false;
/** 模型腰线在窗口内的 Y(CSS 像素);用于 clamp 下方时不让腰线沉到屏幕底以下 */
let currentAnchorY = 360; // 默认 0.6 * 600
let interactiveBounds: { left: number; top: number; width: number; height: number } | null = null;

function resolveRuntimeIconPath(kind: 'window' | 'tray'): string | null {
  const appRoot = path.resolve(__dirname, '..');
  const roots = [path.join(appRoot, 'build'), path.join(process.resourcesPath, 'build')];
  const names = kind === 'tray' ? ['icon.png', 'icon.ico'] : ['icon.ico', 'icon.png'];
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function createWindow(): void {
  // 此时 app 已 ready,可以安全调 screen 模块
  const { bounds } = screen.getPrimaryDisplay();
  // 基于完整屏幕 bounds 算窗口尺寸,允许缩小后的模型贴近任务栏区域。
  currentW = PREVIEW_MODE ? 420 : Math.floor(bounds.width * WINDOW_FRAC);
  currentH = PREVIEW_MODE ? 720 : Math.floor(bounds.height * WINDOW_FRAC);
  const winW = currentW;
  const winH = currentH;
  // 初始位置:主屏中央
  const x = bounds.x + Math.floor((bounds.width - winW) / 2);
  const y = bounds.y + Math.floor((bounds.height - winH) / 2);

  // 应用图标:优先用 app/build/icon.ico(打包/dev 都通用),回落到 build/icon.png
  // dev 态:dist-electron/main.js 在 app/dist-electron 下,build 在 app/build
  // prod 态:electron-builder 把 build/* 当 buildResources,自动嵌入到 exe;运行期窗口 icon 仍用此 PNG
  const iconPath = resolveRuntimeIconPath('window');
  if (!iconPath) {
    console.warn('[main] icon not found');
  }

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    icon: iconPath ?? undefined,
    // §4.1 窗口形态
    transparent: !PREVIEW_MODE,
    backgroundColor: PREVIEW_MODE ? '#f8f6fb' : '#00000000',
    frame: PREVIEW_MODE,
    resizable: PREVIEW_MODE,
    skipTaskbar: !PREVIEW_MODE, // 桌宠常驻托盘,不占任务栏。预览窗口显示在任务栏
    alwaysOnTop: !PREVIEW_MODE,
    hasShadow: PREVIEW_MODE,
    show: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  if (!PREVIEW_MODE) {
    // alwaysOnTop 级别:'screen-saver' 能压过全屏应用(后期可在设置里降为普通)
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    // 全屏透明窗口先默认点击穿透,避免遮挡桌面图标和其它应用。
    // 角色 / 对话组件在鼠标进入可交互区域时会临时关闭穿透。
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    // 预览窗口需要压在当前聊天窗口上方,方便直接目视验收。
    mainWindow.setAlwaysOnTop(true, 'floating');
  }

  // 把渲染进程的 console.* 全部转发到主进程终端,便于不开 DevTools 也能看错误
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['[V]', '[I]', '[W]', '[E]'][level] ?? '[?]';
    console.log(`${tag}[renderer] ${message}  (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[main] did-fail-load', { code, desc, url });
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] render-process-gone', details);
  });

  // 任何 target="_blank" / window.open / 渲染端 a 标签默认动作 → 走系统浏览器,
  // 不在桌宠窗口里弹新窗。设置面板的 GitHub 仓库链接靠这个兜底,
  // 即使 openExternal IPC 失败也能用 a 的 href 打开。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    // 阻止渲染端导航到外部 URL(那会替换桌宠 React app)
    if (isAppPage(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  });

  void mainWindow.loadURL(APP_ENTRY);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (PREVIEW_MODE) mainWindow?.focus();
  });

  mainWindow.on('closed', () => {
    cancelAllChats();
    cancelAllAsr();
    mainWindow = null;
  });

  // 全屏鼠标位置广播:让 Live2D 模型在窗口外也能跟随视线
  // 33ms ≈ 30Hz,让 Live2D 视线跟随更贴近鼠标,仍比逐帧 IPC 轻。
  // 失焦 / 最小化时不发送,进一步省 CPU
  let lastCursorX = Number.NaN;
  let lastCursorY = Number.NaN;
  let cursorTimer: NodeJS.Timeout | null = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    if (!mainWindow.isVisible()) return;
    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = mainWindow.getPosition();
    const relX = cursor.x - wx;
    const relY = cursor.y - wy;
    // 鼠标进入模型矩形时先关闭穿透,保证透明 WebGL 画布可以开始拖动;
    // 离开后的穿透仍由渲染端 hit-test 恢复。
    if (
      interactiveBounds &&
      relX >= interactiveBounds.left &&
      relX <= interactiveBounds.left + interactiveBounds.width &&
      relY >= interactiveBounds.top &&
      relY <= interactiveBounds.top + interactiveBounds.height
    ) {
      mainWindow.setIgnoreMouseEvents(false, { forward: true });
    }
    if (relX === lastCursorX && relY === lastCursorY) return;
    lastCursorX = relX;
    lastCursorY = relY;
    mainWindow.webContents.send('cursor:screen', relX, relY);
  }, 33);
  mainWindow.on('closed', () => {
    if (cursorTimer) {
      clearInterval(cursorTimer);
      cursorTimer = null;
    }
  });

  // 锁尺寸:OS 引起的 resize 压回 currentW/H。
  // 调 setWindowSize() 会更新 currentW/H,后续 resize 会跟随新值。
  mainWindow.on('resize', () => {
    if (!mainWindow || fittingPetWindow) return;
    const b = mainWindow.getBounds();
    if (b.width !== currentW || b.height !== currentH) {
      mainWindow.setBounds({ x: b.x, y: b.y, width: currentW, height: currentH });
    }
  });
}

/** 显示 / 隐藏桌宠主窗口 — 托盘菜单 + IPC 都用这套 */
function showWindow(): void {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  windowVisible = true;
  rebuildTrayMenu();
}
function hideWindow(): void {
  if (!mainWindow) return;
  mainWindow.hide();
  windowVisible = false;
  rebuildTrayMenu();
}
function toggleWindow(): void {
  if (windowVisible) hideWindow();
  else showWindow();
}

// ===== 全屏应用检测（S4）=====
// 全屏游戏 / 全屏视频时把桌宠自动收起来：避免置顶挡住画面，同时窗口隐藏后
// 渲染层会通过 visibilitychange 停掉 rAF/动画，主动发言的 emit 也会检查 document.hidden。
// 用户手动从托盘显示后本次全屏不再自动隐藏；退出全屏只在"自动隐藏过"时恢复。
//
// 注意：项目依赖的 get-windows 在本机 Electron 主进程里 activeWindow()/activeWindowSync()
// 都返回 undefined（native 不可用），所以这里用常驻 PowerShell helper 轮询前台窗口：
// scripts/foreground-window.ps1 → stdout 每 1.5s 一行 “name\tpid\tx\ty\tw\th”。
const FULLSCREEN_POLL_MS = 2500;
let fullscreenWatchTimer: ReturnType<typeof setInterval> | null = null;
let fullscreenActive = false;
let autoHiddenByFullscreen = false;
let lastFullscreenDebug = '';

interface ForegroundInfo {
  name: string;
  pid: number;
  bounds: { x: number; y: number; width: number; height: number };
  title?: string;
}
let foreground: ForegroundInfo | null = null;
let foregroundHelper: ChildProcess | null = null;
let foregroundBuffer = '';
/** 编程陪伴开启时才创建引擎和会话监听器。 */
let companionEngine: CompanionEngine | null = null;

function refreshCompanionEngine(enabled: boolean): void {
  if (!enabled) {
    companionEngine?.stop();
    companionEngine = null;
    companionSpeechQueue.clear();
    cancelCodexQuotaRefresh();
    return;
  }
  if (companionEngine) return;

  try {
    companionEngine = new CompanionEngine({
      userDataDir: app.getPath('userData'),
      getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      getForeground: () => foreground,
      isFullscreen: () => fullscreenActive,
      isWindowVisible: () => windowVisible,
      onSay: (payload) => {
        notifyRenderer('companion:say', payload);
        if (payload.voice) companionSpeechQueue.enqueue(payload.line);
      },
    });
    companionEngine.start();
  } catch (error) {
    companionEngine?.stop();
    companionEngine = null;
    console.warn('[companion] engine init failed:', (error as Error).message);
  }
}

function startForegroundWatch(): void {
  if (process.platform !== 'win32') return;
  try {
    // 未打包运行时 app.getAppPath() 可能是 dist-electron/（入口是 dist-electron/main.js），
    // 所以按 工作目录 → appPath → appPath/.. 依次找 helper 脚本。
    const candidates = [
      path.join(process.resourcesPath, 'scripts', 'foreground-window.ps1'),
      path.join(process.cwd(), 'scripts', 'foreground-window.ps1'),
      path.join(app.getAppPath(), 'scripts', 'foreground-window.ps1'),
      path.join(app.getAppPath(), '..', 'scripts', 'foreground-window.ps1'),
    ];
    const scriptPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!scriptPath) {
      console.log('[immersion] foreground helper script missing; tried:', candidates.join(' | '));
      return;
    }
    foregroundHelper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
    });
    const foregroundDecoder = new StringDecoder('utf8');
    foregroundHelper.stdout?.on('data', (chunk: Buffer) => {
      foregroundBuffer += foregroundDecoder.write(chunk);
      let idx = -1;
      while ((idx = foregroundBuffer.indexOf('\n')) >= 0) {
        const line = foregroundBuffer.slice(0, idx).trim();
        foregroundBuffer = foregroundBuffer.slice(idx + 1);
        if (!line) continue;
        const parts = line.split('\t');
        if (parts.length < 6) continue;
        const [name, pidRaw, xRaw, yRaw, wRaw, hRaw, ...titleParts] = parts;
        foreground = {
          name: name.trim().toLowerCase(),
          pid: Number(pidRaw) || 0,
          bounds: {
            x: Number(xRaw) || 0,
            y: Number(yRaw) || 0,
            width: Number(wRaw) || 0,
            height: Number(hRaw) || 0,
          },
          title: titleParts.join('\t').trim(),
        };
      }
    });
    foregroundHelper.on('error', (e) => {
      console.log('[immersion] foreground helper error:', (e as Error).message);
      foregroundHelper = null;
    });
    foregroundHelper.on('exit', (code) => {
      console.log('[immersion] foreground helper exited:', code);
      foregroundHelper = null;
    });
    app.on('will-quit', () => {
      try {
        foregroundHelper?.kill();
      } catch {
        /* ignore */
      }
    });
    console.log('[immersion] foreground helper started:', scriptPath);
  } catch (e) {
    console.log('[immersion] foreground helper failed:', (e as Error).message);
  }
}

function isFullscreenAppActive(): boolean {
  const fg = foreground;
  if (!fg) return false;
  // 自己 / 桌面 Shell 不算全屏应用
  if (fg.pid === process.pid) return false;
  if (fg.name.includes('electron') || fg.name.includes('xiaolongniang')) return false;
  if (fg.name.includes('explorer')) return false;
  const display = screen.getDisplayMatching(fg.bounds).bounds;
  const covered =
    fg.bounds.width >= display.width * 0.98 &&
    fg.bounds.height >= display.height * 0.98 &&
    Math.abs(fg.bounds.x - display.x) <= 2 &&
    Math.abs(fg.bounds.y - display.y) <= 2;
  // 只在检测结果变化时打日志，避免 2.5s 轮询刷屏；排查全屏误判时很有用
  const info =
    `${fg.name}|w=${fg.bounds.width}x${fg.bounds.height}+${fg.bounds.x},${fg.bounds.y}|` +
    `d=${display.width}x${display.height}+${display.x},${display.y}|covered=${covered}`;
  if (info !== lastFullscreenDebug) {
    lastFullscreenDebug = info;
    console.log('[immersion-debug]', info);
  }
  return covered;
}

async function checkFullscreenTick(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const active = isFullscreenAppActive();
  if (active) {
    if (!fullscreenActive) {
      fullscreenActive = true;
      if (windowVisible) {
        autoHiddenByFullscreen = true;
        hideWindow();
        console.log('[immersion] fullscreen app detected; pet hidden');
      }
    }
    return;
  }
  if (fullscreenActive) {
    fullscreenActive = false;
    if (autoHiddenByFullscreen) {
      autoHiddenByFullscreen = false;
      showWindow();
      console.log('[immersion] fullscreen exited; pet restored');
    }
  }
}

function startFullscreenWatch(): void {
  if (fullscreenWatchTimer) return;
  fullscreenWatchTimer = setInterval(() => void checkFullscreenTick(), FULLSCREEN_POLL_MS);
}

/** 拉当前可用角色清单(扫描资源 + 当前 active id),给托盘菜单"切换角色"子菜单用 */
async function getCharactersForMenu(): Promise<{
  list: Array<{ id: string; name: string; displayName: string }>;
  activeId: string | null;
}> {
  const scan = await scanAll();
  const cfg = loadConfig();
  // 合并 Hatch-Pet + Live2D,托盘菜单一齐展示;sprite 仍未启用。
  const list = [
    ...scan.hatchPet.map((c) => ({ id: c.id, name: c.name, displayName: c.name })),
    ...scan.live2d.map((c) => ({ id: c.id, name: c.name, displayName: c.name })),
  ];
  const configured =
    cfg.defaultCharacterId && list.some((c) => c.id === cfg.defaultCharacterId)
      ? cfg.defaultCharacterId
      : null;
  return { list, activeId: activeCharacterId === undefined ? configured : activeCharacterId };
}

/** 构造并设置 Tray 的右键菜单。windowVisible 变化或角色切换后调用以同步显示 */
async function rebuildTrayMenu(): Promise<void> {
  if (!tray) return;
  const { list, activeId } = await getCharactersForMenu();
  const characterItems: Electron.MenuItemConstructorOptions[] = list.map((c) => ({
    label: (c.id === activeId ? '● ' : '  ') + c.displayName,
    type: 'normal',
    click: () => {
      // 通知渲染端切换角色;character-host 监听该事件
      mainWindow?.webContents.send('tray:switch-character', c.id);
      // 切换后窗口要可见
      showWindow();
    },
  }));

  characterItems.unshift({
    label: (activeId === null ? '● ' : '  ') + '内置小龙娘',
    click: () => {
      mainWindow?.webContents.send('tray:switch-character', null);
      showWindow();
    },
  });
  const menu = Menu.buildFromTemplate([
    {
      label: windowVisible ? '隐藏桌宠' : '显示桌宠',
      click: () => toggleWindow(),
    },
    {
      label: '打开对话和模型',
      click: () => {
        showWindow();
        // 普通"打开对话":显示模型 + 弹聊天气泡
        mainWindow?.webContents.send('tray:open-chat');
      },
    },
    {
      label: '只打开对话',
      click: () => {
        showWindow();
        // "只对话":显示窗口 + 弹聊天气泡,但隐藏模型 canvas(节省眼前空间)
        mainWindow?.webContents.send('tray:open-chat-only');
      },
    },
    { type: 'separator' },
    {
      label: '切换角色',
      submenu: characterItems.length > 0 ? characterItems : [{ label: '(无可用角色)', enabled: false }],
    },
    {
      label: '设置',
      click: () => {
        showWindow();
        mainWindow?.webContents.send('tray:open-settings');
      },
    },
    {
      label: '使用说明与功能介绍',
      click: () => {
        void openUserGuideFile();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 用 app.quit() 触发正常关闭流程(stop MCP / 持久化 config 等)
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

/** 创建系统托盘图标 + 点击 / 右键行为 */
function createTray(): void {
  const iconPath = resolveRuntimeIconPath('tray');
  let img = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (img.isEmpty()) {
    console.warn('[main] tray icon is empty:', iconPath ?? '(missing)');
  } else if (process.platform === 'win32') {
    img = img.resize({ width: 16, height: 16 });
  }
  tray = new Tray(img);
  tray.setToolTip('小龙娘桌宠');
  // 左键 = 显示/隐藏窗口(Windows 习惯)。macOS 单击会同时弹菜单,这里也保持一致
  tray.on('click', () => toggleWindow());
  // 双击保险 — 确保即使单击被系统消耗,双击也能切换
  tray.on('double-click', () => toggleWindow());
  void rebuildTrayMenu();
}

// IPC: 测试通道(后续会扩成完整 ToolDispatcher)
ipcMain.handle('app:ping', () => 'pong');

// IPC: 系统空闲秒数（鼠标 + 键盘）。渲染层用它判断「无操作 ≥5 分钟」进入困倦待机，
// 以及用户回来后自动醒来。powerMonitor 需要在 app ready 之后才可用，renderer 调用时早已 ready。
ipcMain.handle('system:idle-seconds', () => powerMonitor.getSystemIdleTime());

// 已经保存的陪伴记录在关闭监听后仍可查看和清除。
ipcMain.handle('companion:get-summary', () => companionEngine?.getSummary() ?? null);
ipcMain.handle(
  'companion:get-decisions',
  (_e, opts?: Parameters<CompanionEngine['getDecisions']>[0]) =>
    new CompanionStore(app.getPath('userData')).listDecisions(opts ?? {}),
);
ipcMain.handle('companion:clear-decisions', () =>
  new CompanionStore(app.getPath('userData')).clearDecisions(),
);
ipcMain.handle('companion:mark-interaction', () => {
  companionEngine?.markUserInteraction();
  return true;
});

// IPC: 渲染端切了角色后通知主进程刷新托盘菜单(并把当前 active 角色 id 推过来,菜单据此显示 ●)
ipcMain.handle('tray:refresh', (_e, opts?: { activeCharacterId?: string | null }) => {
  if (opts && (typeof opts.activeCharacterId === 'string' || opts.activeCharacterId === null)) {
    activeCharacterId = opts.activeCharacterId;
  }
  void rebuildTrayMenu();
});
// IPC: 渲染端主动隐藏到托盘(右键菜单"最小化到托盘"等用)
ipcMain.handle('window:hide', () => hideWindow());
ipcMain.handle('window:show', () => showWindow());
ipcMain.handle('window:toggle', () => toggleWindow());
ipcMain.handle('app:quit', () => app.quit());

// IPC: 全屏截图 — 渲染端在 chat-bubble 里点截屏按钮调用。
//   关键:不再 hide / show 主窗(那会闪烁),改用 setContentProtection(true)。
//   底层是 Windows 的 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE):
//   窗口对用户仍正常显示,但 DWM 在屏幕捕获时把窗口位置渲染为黑/透明 — AI
//   拿到的截图就看不到桌宠/对话框,而用户视觉上桌宠完全不动。
//   截完立即关闭保护,避免影响用户用其他截图工具时也截不到桌宠。
//   返回 PNG dataURL(base64),用作 OpenAI 多模态 image_url。
ipcMain.handle('screen:capture', async (): Promise<string | null> => {
  const win = mainWindow;
  let protectionApplied = false;
  try {
    if (win && !win.isDestroyed()) {
      win.setContentProtection(true);
      protectionApplied = true;
      // DWM 应用窗口属性大概要 1~2 帧;等 30ms 保险(用户感知不到这点延迟)
      await new Promise((r) => setTimeout(r, 30));
    }

    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.size;
    // thumbnailSize 直接给屏幕物理像素,desktopCapturer 内部已 dpi-aware
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });
    const src =
      sources.find((s) => `${s.display_id}` === `${primary.id}`) ?? sources[0];
    if (!src) return null;
    const png = src.thumbnail.toPNG();
    const dataURL = 'data:image/png;base64,' + png.toString('base64');
    return dataURL;
  } catch (e) {
    console.warn('[screen:capture] failed:', (e as Error).message);
    return null;
  } finally {
    // 无论成功失败都恢复,否则用户用其他截图软件也截不到桌宠
    if (protectionApplied && win && !win.isDestroyed()) {
      win.setContentProtection(false);
    }
  }
});

// IPC: 全屏截图 + 鼠标位置 — 用户问「我鼠标在哪 / 我指的是什么」时调用。
//   返回除 dataURL 外还附带 cursor 坐标(主屏内,DIP)和主屏尺寸,
//   渲染端用 Canvas 在 cursor 位置画红圈+十字,然后送给识图模型 set-of-mark。
//   cursor 不在主屏(用户在副屏)时 onPrimary=false,渲染端可降级成普通截图。
ipcMain.handle('screen:capture-with-cursor', async () => {
  const win = mainWindow;
  let protectionApplied = false;
  try {
    if (win && !win.isDestroyed()) {
      win.setContentProtection(true);
      protectionApplied = true;
      await new Promise((r) => setTimeout(r, 30));
    }
    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.size;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });
    const src =
      sources.find((s) => `${s.display_id}` === `${primary.id}`) ?? sources[0];
    if (!src) return null;
    const dataURL =
      'data:image/png;base64,' + src.thumbnail.toPNG().toString('base64');
    // cursor 是全局多屏坐标,减主屏 bounds.x/y 拿主屏内相对坐标
    const c = screen.getCursorScreenPoint();
    const b = primary.bounds;
    const onPrimary =
      c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
    return {
      dataURL,
      cursor: { x: c.x - b.x, y: c.y - b.y, onPrimary },
      screenSize: { width, height },
    };
  } catch (e) {
    console.warn('[screen:capture-with-cursor] failed:', (e as Error).message);
    return null;
  } finally {
    if (protectionApplied && win && !win.isDestroyed()) {
      win.setContentProtection(false);
    }
  }
});

// IPC: PDF 解析 — 渲染端 chat-bubble 上传 PDF 时调用。
//   pdf-parse 跑 Node 环境最稳;放主进程避开 pdfjs worker 在 Vite 里的复杂配置。
//   入参是 ArrayBuffer(经由 IPC 序列化为 Uint8Array),出参是抽出的纯文本(失败 null)。
ipcMain.handle('parse:pdf', async (_e, buf: ArrayBuffer | Uint8Array): Promise<string | null> => {
  try {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    // pdf-parse v2 导出 PDFParse 类（非默认函数），兼容 v1 函数式回退并在用完后 destroy worker
    const mod = (await import('pdf-parse')) as unknown as {
      PDFParse?: new (opts: { data: Uint8Array }) => {
        getText: () => Promise<{ text?: string }>;
        destroy?: () => Promise<void> | void;
      };
      default?: (b: Buffer) => Promise<{ text?: string }>;
    };
    if (typeof mod.PDFParse === 'function') {
      const parser = new mod.PDFParse({ data: bytes });
      try {
        const result = await parser.getText();
        return result?.text ?? '';
      } finally {
        await parser.destroy?.();
      }
    }
    const legacy = mod.default ?? (mod as unknown as (b: Buffer) => Promise<{ text?: string }>);
    const result = await legacy(Buffer.from(bytes));
    return result?.text ?? '';
  } catch (e) {
    console.warn('[parse:pdf] failed:', (e as Error).message);
    return null;
  }
});

function resolveUserGuidePath(): string | null {
  const fileName = '使用说明与功能介绍.html';
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), fileName),
    path.join(process.resourcesPath, fileName),
    path.resolve(app.getAppPath(), '..', fileName),
    path.resolve(process.cwd(), '..', fileName),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function openUserGuideFile(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const guidePath = resolveUserGuidePath();
  if (!guidePath) {
    return { ok: false, error: '未找到使用说明文件（使用说明与功能介绍.html）' };
  }
  const err = await shell.openPath(guidePath);
  if (err) {
    return { ok: false, path: guidePath, error: err };
  }
  return { ok: true, path: guidePath };
}

// IPC: 在系统默认浏览器打开外部 URL — 设置面板的"查看仓库"链接等用它。
//   只允许 http(s),拒绝 file:// 等危险协议。
ipcMain.handle('app:openExternal', (_e, url: string) => {
  if (typeof url !== 'string') return;
  if (!/^https?:\/\//i.test(url)) return;
  void shell.openExternal(url);
});

ipcMain.handle('app:getUserGuidePath', () => resolveUserGuidePath());
ipcMain.handle('app:openUserGuide', async () => openUserGuideFile());

ipcMain.handle('live2d:open-directory', async () => {
  const dir = live2dUserDirectory();
  await fs.promises.mkdir(dir, { recursive: true });
  await shell.openPath(dir);
});

ipcMain.handle('live2d:pick-and-import', async () => {
  const picked = await dialog.showOpenDialog({
    title: '选择包含 .model3.json 的模型目录',
    properties: ['openDirectory'],
  });
  const source = picked.filePaths[0];
  if (picked.canceled || !source) return { ok: false };

  try {
    const files = await fs.promises.readdir(source, { withFileTypes: true });
    if (!files.some((item) => item.isFile() && item.name.toLowerCase().endsWith('.model3.json'))) {
      return { ok: false, error: '请选择直接包含 .model3.json 的目录。' };
    }
    const root = live2dUserDirectory();
    await fs.promises.mkdir(root, { recursive: true });
    const destination = path.join(root, path.basename(source));
    if (fs.existsSync(destination)) return { ok: false, error: '已存在同名目录，请先更名。' };
    const staging = await fs.promises.mkdtemp(path.join(path.dirname(root), 'live2d-import-'));
    try {
      await fs.promises.cp(source, staging, {
        recursive: true,
        filter: async (entry) => !(await fs.promises.lstat(entry)).isSymbolicLink(),
      });
      await fs.promises.rename(staging, destination);
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
    return { ok: true };
  } catch {
    return { ok: false, error: '无法导入这个模型目录，请确认它可读。' };
  }
});

// IPC: 开机自启动开关（默认关闭，仅打包发布版支持，登录系统时直接启动独立桌宠）。
ipcMain.handle('app:getAutoLaunch', (): { enabled: boolean; supported: boolean } => {
  const supported = (process.platform === 'win32' || process.platform === 'darwin') && app.isPackaged;
  if (!supported) return { enabled: false, supported: false };
  try {
    const direct = app.getLoginItemSettings({ path: process.execPath, args: [] });
    return { enabled: direct.openAtLogin, supported: true };
  } catch (error) {
    console.warn('[autostart] read failed:', error);
    return { enabled: false, supported: true };
  }
});
ipcMain.handle('app:setAutoLaunch', (_e, enabled: boolean): { enabled: boolean } => {
  const supported = (process.platform === 'win32' || process.platform === 'darwin') && app.isPackaged;
  if (!supported) return { enabled: false };
  try {
    // 先清理可能遗留的无参数启动项（例如旧版 PowerShell watcher），再按当前主程序写入/移除
    if (!enabled) {
      try {
        app.setLoginItemSettings({ openAtLogin: false });
      } catch {
        // ignore
      }
    }
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      openAsHidden: false,
      path: process.execPath,
      args: [],
    });
    return { enabled: app.getLoginItemSettings({ path: process.execPath, args: [] }).openAtLogin };
  } catch (error) {
    console.warn('[autostart] write failed:', error);
    return { enabled: false };
  }
});

// ===== 本地 skill 管理 — 用户从设置面板上传 .md 文件作为自定义 skill =====
ipcMain.handle('skills:listLocal', () => listLocalSkills());

/** 弹文件选择对话框,挑一个 .md 文件,内容拷贝到 userData/skills/local/。
 *  返回新建的 SkillEntry,或 null(用户取消)。 */
ipcMain.handle('skills:pickAndUploadLocal', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 SKILL.md',
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // 用文件名(无扩展名)作为 skill name
    const baseName = path.basename(filePath).replace(/\.(md|markdown|txt)$/i, '');
    const entry = addLocalSkill(baseName || 'untitled', content);
    notifyRenderer('app:skillsChanged', { reason: 'local-skill-added' });
    return entry;
  } catch (e) {
    console.warn('[skills] pickAndUploadLocal failed:', (e as Error).message);
    return null;
  }
});

ipcMain.handle('skills:removeLocal', (_e, rawName: string) => {
  if (typeof rawName !== 'string') return false;
  const ok = removeLocalSkill(rawName);
  if (ok) notifyRenderer('app:skillsChanged', { reason: 'local-skill-removed' });
  return ok;
});

/** 列出 AI / 用户已经从在线源下载缓存到本机的 skill */
ipcMain.handle('skills:listDownloaded', () => listDownloadedSkills());

/** 列出内置 skill(打包进 asar 的那批)及当前启用状态 — 给设置面板用 */
ipcMain.handle('skills:listBuiltin', () => listBuiltinSkills());

// ===== 运行缓存 / 浏览器缓存 =====
interface RuntimeCacheUsageItem {
  name: string;
  path: string;
  bytes: number;
}

interface RuntimeCacheUsage {
  totalBytes: number;
  items: RuntimeCacheUsageItem[];
}

const RUNTIME_CACHE_DIRS = [
  'IndexedDB',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'Service Worker',
  'blob_storage',
];

function dirSizeSafe(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile()) {
          total += fs.statSync(full).size;
        }
      } catch {
        // ignore files being mutated by Chromium
      }
    }
  }
  return total;
}

function getRuntimeCacheUsage(): RuntimeCacheUsage {
  const userData = app.getPath('userData');
  const items = RUNTIME_CACHE_DIRS.map((name) => {
    const p = path.join(userData, name);
    return { name, path: p, bytes: fs.existsSync(p) ? dirSizeSafe(p) : 0 };
  }).filter((x) => x.bytes > 0);
  return {
    totalBytes: items.reduce((n, x) => n + x.bytes, 0),
    items,
  };
}

ipcMain.handle('app:getRuntimeCacheUsage', () => getRuntimeCacheUsage());

ipcMain.handle('app:clearRuntimeCache', async () => {
  const ses = session.defaultSession;
  await Promise.allSettled([
    ses.clearCache(),
    ses.clearCodeCaches({ urls: [] }),
    ses.clearStorageData({
      storages: ['indexdb', 'shadercache', 'serviceworkers', 'cachestorage'],
    }),
    ses.clearData({ dataTypes: ['cache', 'indexedDB', 'serviceWorkers'] }),
  ]);
  try {
    ses.flushStorageData();
  } catch {
    // ignore
  }
  return getRuntimeCacheUsage();
});

// ===== 自定义 vosk 语音识别模型与 API 语音转文字 =====
ipcMain.handle(
  'asr:transcribe',
  async (_e, buf: ArrayBuffer | Uint8Array, reqId?: string): Promise<{ text: string }> => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return transcribeAudio(bytes, { reqId });
  },
);

ipcMain.handle('asr:cancel', (_e, reqId?: string): boolean => {
  return cancelAsr(reqId);
});

ipcMain.handle('asr:test', async (_e, override?: Partial<SpeechAsrConfig>) => {
  return testAsrConnection(override);
});
// 用户从 Vosk 模型列表下载兼容的小模型 ZIP，通过设置面板导入。
// 渲染端 vosk-shared.ts 读 cfg.voskCustomModelFile,有则用 pet://vosk-user/<file>。
function voskUserDir(): string {
  const d = path.join(app.getPath('userData'), 'vosk');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 当前是否装了自定义模型 — 给设置面板渲染状态用 */
ipcMain.handle('vosk:getCustomModelInfo', () => {
  const cfg = loadConfig();
  const fileName = cfg.voskCustomModelFile;
  const hasBuiltin = fs.existsSync(path.join(resolveAssetRoots().voskBuiltin, 'vosk-model-small-cn-0.22.zip'));
  if (!fileName || path.basename(fileName) !== fileName) return { hasCustom: false, hasBuiltin } as const;
  const full = path.join(voskUserDir(), fileName);
  if (!fs.existsSync(full)) {
    // 文件被外部删了 — 清掉 cfg 引用,避免 vosk-shared 加载失败
    saveConfig({ voskCustomModelFile: undefined });
    return { hasCustom: false, hasBuiltin } as const;
  }
  const stat = fs.statSync(full);
  return { hasCustom: true as const, fileName, sizeBytes: stat.size, hasBuiltin };
});

ipcMain.handle('vosk:pickAndImportModel', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Vosk 小模型 ZIP',
    properties: ['openFile'],
    filters: [{ name: 'vosk model zip', extensions: ['zip'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const src = result.filePaths[0];
  const stat = fs.statSync(src);
  if (!stat.isFile() || path.extname(src).toLowerCase() !== '.zip' || stat.size > 128 * 1024 * 1024) {
    throw new Error('请选择小于 128 MB 的 Vosk 小模型 ZIP 文件。');
  }
  const header = Buffer.alloc(4);
  const fd = fs.openSync(src, 'r');
  try {
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || header.readUInt32LE() !== 0x04034b50) {
      throw new Error('所选文件无法识别为 ZIP 压缩包。');
    }
  } finally {
    fs.closeSync(fd);
  }
  const dir = voskUserDir();
  const baseName = path.basename(src);
  const previous = loadConfig().voskCustomModelFile;
  const staging = fs.mkdtempSync(path.join(dir, 'import-'));
  const stagedZip = path.join(staging, 'model.zip');
  try {
    fs.copyFileSync(src, stagedZip);
    fs.renameSync(stagedZip, path.join(dir, baseName));
    saveConfig({ voskCustomModelFile: baseName });
  } finally {
    fs.rmSync(stagedZip, { force: true });
    fs.rmdirSync(staging);
  }
  if (previous && previous !== baseName && path.basename(previous) === previous) {
    try { fs.rmSync(path.join(dir, previous), { force: true }); } catch { /* 模型尚在使用时保留旧文件 */ }
  }
  return { fileName: baseName, sizeBytes: stat.size };
});

// ===== Hatch-Pet 角色导入 / 删除 =====
// 用户在设置面板「角色管理」点 「+ 导入 Hatch-Pet」
//   → 弹原生选目录对话框,选一个含 pet.json + spritesheet.webp 的文件夹
//   → 主进程递归复制到 userData/hatch-pet/<basename>/(若已存在,加 -2 -3 后缀避免覆盖)
//   → 通知渲染端刷新角色列表
// 删除:仅允许删 source='user' 的角色;builtin 不可删。
function userHatchPetDir(): string {
  const d = path.join(app.getPath('userData'), 'hatch-pet');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDirRecursive(s, d);
    else if (e.isFile()) await fs.promises.copyFile(s, d);
  }
}

ipcMain.handle('hatchPet:import', async (): Promise<{
  ok: boolean;
  added?: { id: string; name: string; folder: string };
  error?: string;
} | null> => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Hatch-Pet 角色文件夹(含 pet.json + spritesheet.webp)',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const src = result.filePaths[0];
  try {
    // 校验:必须有 pet.json + spritesheet.webp(后者按 manifest.spritesheetPath,默认名兜底)
    const manifestPath = path.join(src, 'pet.json');
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, error: '所选文件夹没有 pet.json' };
    }
    let manifest: { displayName?: string; spritesheetPath?: string };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {
      return { ok: false, error: 'pet.json 解析失败:' + (e as Error).message };
    }
    const sheetRel = manifest.spritesheetPath ?? 'spritesheet.webp';
    const sheetAbs = path.resolve(src, sheetRel);
    const relFromSrc = path.relative(src, sheetAbs);
    if (!relFromSrc || relFromSrc === '..' || relFromSrc.startsWith('..' + path.sep) || path.isAbsolute(relFromSrc)) {
      return { ok: false, error: 'spritesheetPath 不能指向角色目录之外' };
    }
    if (!fs.existsSync(sheetAbs)) {
      return { ok: false, error: `缺 spritesheet:${sheetRel}` };
    }
    const [realSrc, realSheet] = await Promise.all([
      fs.promises.realpath(src),
      fs.promises.realpath(sheetAbs),
    ]);
    const realRel = path.relative(realSrc, realSheet);
    if (!realRel || realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) {
      return { ok: false, error: 'spritesheetPath 不能指向角色目录之外' };
    }

    // 选择目标文件夹名(用源文件夹 basename;如果撞了,追加 -2/-3...)
    const root = userHatchPetDir();
    const baseName = path.basename(src);
    let target = path.join(root, baseName);
    let suffix = 2;
    while (fs.existsSync(target)) {
      target = path.join(root, `${baseName}-${suffix}`);
      suffix += 1;
    }
    await copyDirRecursive(src, target);

    const folder = path.basename(target);
    return {
      ok: true,
      added: {
        id: `hatch-u-${folder}`,
        name: manifest.displayName?.trim() || folder,
        folder,
      },
    };
  } catch (e) {
    console.warn('[hatchPet] import failed:', (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
});

ipcMain.handle('hatchPet:remove', async (_e, characterId: string) => {
  if (typeof characterId !== 'string' || !characterId.startsWith('hatch-u-')) {
    return { ok: false, error: '只能删除用户导入的 Hatch-Pet 角色' };
  }
  const folder = characterId.slice('hatch-u-'.length);
  const dir = path.join(userHatchPetDir(), folder);
  if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在' };
  // 防止越界:必须落在 userHatchPetDir 内
  const root = path.resolve(userHatchPetDir());
  if (!path.resolve(dir).startsWith(root + path.sep)) {
    return { ok: false, error: '路径越界' };
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

// ===== 长期记忆管理(给「设置 → 编辑记忆」UI 用)=====
// memory 存在 userData/memory.json,跨模型跨会话,每次 streamChat 会注入 system prompt。
ipcMain.handle('memory:list', () => listMemories());
ipcMain.handle('memory:add', (_e, content: string) => {
  if (typeof content !== 'string') throw new Error('content must be string');
  return addMemory(content);
});
ipcMain.handle('memory:update', (_e, id: string, content: string) => {
  if (typeof id !== 'string' || typeof content !== 'string') return false;
  return updateMemory(id, content);
});
ipcMain.handle('memory:remove', (_e, idOrMatch: string) => {
  if (typeof idOrMatch !== 'string') return 0;
  return removeMemory(idOrMatch);
});
ipcMain.handle('memory:clear', () => {
  clearMemories();
  return true;
});
ipcMain.handle('usage:local', () =>
  loadConfig().codexCompanionEnabled === true ? getLocalUsage() : null,
);
ipcMain.handle('usage:clear', () => { clearLocalUsage(); return getLocalUsage(); });
ipcMain.handle('codexQuota:get', () =>
  loadConfig().codexCompanionEnabled === true ? getCodexQuota() : null,
);
ipcMain.handle('codexQuota:refresh', () =>
  loadConfig().codexCompanionEnabled === true ? refreshCodexQuota() : null,
);

// 默认使用 Windows 语音。启用本地克隆语音后，资源缺失时回退到系统语音。
const localSpeech = new LocalSpeech((state) => {
  companionSpeechQueue.setState('local', state.state);
  notifyRenderer('tts:state', state);
});
const cloneSpeech = new CloneSpeech(
  (state) => {
    companionSpeechQueue.setState('clone', state.state);
    if (state.state === 'error') console.warn('[clone-tts]', state.error ?? '语音播放失败');
    notifyRenderer('tts:state', state);
  },
  (text, settings) => { localSpeech.speak(text, settings); },
);
const companionSpeechQueue = new CompanionSpeechQueue(
  speakWithConfiguredVoice,
  () => {
    const error = '本机语音未能启动，陪伴消息已显示为文字。';
    console.warn('[companion]', error);
    notifyRenderer('tts:state', { state: 'error', remaining: 0, error });
  },
);
ipcMain.handle('tts:voices', () => listLocalVoices());
ipcMain.handle('tts:clone-status', () => cloneSpeech.status(loadConfig().voiceWake?.speech));
ipcMain.handle('tts:choose-clone-folder', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 F5-TTS 资源文件夹',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
function speakWithConfiguredVoice(rawText: string): boolean {
  const speech = loadConfig().voiceWake?.speech;
  if (speech?.engine === 'clone' && cloneSpeech.speak(rawText, speech)) return true;
  cloneSpeech.stop();
  return localSpeech.speak(rawText, speech);
}
ipcMain.handle('tts:speak', (_e, rawText: string) => speakWithConfiguredVoice(rawText));
ipcMain.handle('tts:stop', () => { companionSpeechQueue.clear(); cloneSpeech.stop(); localSpeech.stop(); return true; });
/** 删除当前自定义模型 — 把 userData/vosk/<file> 删掉,清 cfg.voskCustomModelFile */
ipcMain.handle('vosk:removeCustomModel', () => {
  const cfg = loadConfig();
  const fileName = cfg.voskCustomModelFile;
  if (fileName && path.basename(fileName) === fileName) {
    const full = path.join(voskUserDir(), fileName);
    try {
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch (e) {
      console.warn('[vosk] removeCustomModel unlink failed:', (e as Error).message);
    }
  }
  saveConfig({ voskCustomModelFile: undefined });
  return true;
});

// IPC: 扫描全部角色(Live2D + PNG)
ipcMain.handle('assets:scan', async () => {
  return scanAll();
});

// IPC: 窗口位置增量移动(渲染端 mousemove 时调用)
// 立绘模式平时只包围角色，打开面板时适度扩展；其他角色恢复完整工作区。
ipcMain.handle('window:fitPet', (_e, rect: { x: number; y: number; width: number; height: number }, mode: PetWindowMode) => {
  if (!mainWindow || PREVIEW_MODE || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  if (rect.width <= 0 || rect.height <= 0 || rect.width > 10000 || rect.height > 10000) return null;
  if (!['compact', 'expanded', 'full'].includes(mode)) return null;
  let display: Electron.Display;
  try {
    display = screen.getDisplayMatching({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.ceil(rect.width)),
      height: Math.max(1, Math.ceil(rect.height)),
    });
  } catch {
    display = screen.getPrimaryDisplay();
  }
  const clampedModel = mode === 'full' ? rect : clampModelToDisplay(rect, display.bounds);
  const bounds = getPetWindowBounds(clampedModel, display.bounds, mode);
  const previous = mainWindow.getBounds();
  if (bounds.x === previous.x && bounds.y === previous.y &&
      bounds.width === previous.width && bounds.height === previous.height) {
    return { ...previous, modelX: clampedModel.x, modelY: clampedModel.y };
  }

  fittingPetWindow = true;
  try {
    mainWindow.setBounds(bounds);
    const actual = mainWindow.getBounds();
    currentW = actual.width;
    currentH = actual.height;
    return { ...actual, modelX: clampedModel.x, modelY: clampedModel.y };
  } finally {
    fittingPetWindow = false;
  }
});

//   dx,dy 是相对当前位置的整数像素偏移。
//   用 setBounds 显式保留 width/height,避免 transparent+frameless 窗在 Windows 上
//   每次 setPosition 后 client size 漂移 ±2px(已知 Electron issue),进而触发渲染端
//   ResizeObserver 反馈循环 → 模型越来越大。
ipcMain.handle('window:moveBy', (_e, dx: number, dy: number) => {
  if (!mainWindow) return;
  if (typeof dx !== 'number' || typeof dy !== 'number') return;
  const b = mainWindow.getBounds();
  // 不再 clamp,模型 / 对话框可以拖到屏幕外任意位置
  const nx = Math.round(b.x + dx);
  const ny = Math.round(b.y + dy);
  mainWindow.setBounds({ x: nx, y: ny, width: currentW, height: currentH });
});

// IPC: 调整模型区域尺寸(用户调 scale 时调用)。
// 参数 (modelW, modelH) 是模型区,实际 BrowserWindow = modelW + DIALOG_W × modelH
// 现场 clamp 到屏幕 workArea 的 90%
// IPC: 渲染端报告"模型腰线在窗口内的 Y"(CSS 像素),用于下方拖动 clamp
ipcMain.handle('window:setAnchorY', (_e, y: number) => {
  if (typeof y === 'number' && isFinite(y) && y > 0) {
    currentAnchorY = Math.round(y);
  }
});

// 渲染端报告模型容器矩形,用于透明窗口进入模型前的原生命中兜底。
ipcMain.handle('window:setInteractiveBounds', (_e, bounds: unknown) => {
  if (!bounds || typeof bounds !== 'object') {
    interactiveBounds = null;
    return;
  }
  const b = bounds as Record<string, unknown>;
  if ([b.left, b.top, b.width, b.height].every((v) => typeof v === 'number' && isFinite(v as number))) {
    interactiveBounds = {
      left: Number(b.left),
      top: Number(b.top),
      width: Math.max(0, Number(b.width)),
      height: Math.max(0, Number(b.height)),
    };
  }
});

// IPC: 渲染端要求 BrowserWindow 至少能容纳给定 client 大小(用于 popup 拖大时同步扩窗)
//   只增不减;clamp 到屏幕 workArea 90%
ipcMain.handle('window:ensureSize', (_e, clientW: number, clientH: number) => {
  if (!mainWindow) return;
  if (typeof clientW !== 'number' || typeof clientH !== 'number') return;
  const { bounds } = screen.getPrimaryDisplay();
  const maxW = Math.floor(bounds.width);
  const maxH = Math.floor(bounds.height);
  const wantW = Math.min(maxW, Math.max(currentW, Math.round(clientW)));
  const wantH = Math.min(maxH, Math.max(currentH, Math.round(clientH)));
  if (wantW === currentW && wantH === currentH) return;
  currentW = wantW;
  currentH = wantH;
  const b = mainWindow.getBounds();
  mainWindow.setBounds({ x: b.x, y: b.y, width: currentW, height: currentH });
});

// IPC 兼容保留:character-host 旧版会调用,现在窗口固定 = workArea×95%,
// 不再随模型 scale 变,设大时 character-host 自己用 inline width/height 控制容器大小。
// 收到 setSize 直接 noop。
ipcMain.handle('window:setSize', () => {
  // intentionally empty
});

// IPC: 设置鼠标穿透。ignore=true 时窗口对鼠标透明,事件穿透到下层。
//   forward=true 时即使忽略,渲染进程仍能收到 mousemove,用于 hit-test 切换。
ipcMain.handle('window:setIgnoreMouseEvents', (_e, ignore: boolean, forward: boolean) => {
  if (!mainWindow) return;
  mainWindow.setIgnoreMouseEvents(!!ignore, { forward: !!forward });
});

// IPC: 配置读写
ipcMain.handle('config:get', (): AppConfig => loadConfig());
ipcMain.handle('config:set', (_e, partial: Partial<AppConfig>): AppConfig => {
  const previousSkills = partial.agentSkills?.enabled === true ? loadConfig().agentSkills : undefined;
  const merged = saveConfig(partial);
  if ('codexCompanionEnabled' in partial) {
    refreshCompanionEngine(merged.codexCompanionEnabled === true);
  }
  if ('voiceWake' in partial && merged.voiceWake?.voiceReply === false) { cloneSpeech.stop(); localSpeech.stop(); }
  // config.mcp 变了 → 异步重启 servers(applyConfig 内部是幂等的,可重复调)
  if ('mcp' in partial) {
    void mcpManager.applyConfig(merged.mcp).catch((e) => {
      console.error('[mcp] applyConfig failed:', (e as Error).message);
    });
  }
  // config.proactive 变了 → 让 ProactiveAware 重新评估是否启动 / 停止轮询
  if ('proactive' in partial) {
    proactiveAware.refresh();
  }
  if (partial.agentSkills?.enabled === true && (!previousSkills?.enabled ||
    JSON.stringify(previousSkills.sources) !== JSON.stringify(merged.agentSkills?.sources))) {
    void syncSkillsIndex();
  }
  notifyRenderer('app:configChanged', { reason: 'config-set' });
  return merged;
});

ipcMain.handle('ai:list-models', async (_e, rawBaseURL: string, rawApiKey: string) => {
  if (typeof rawBaseURL !== 'string' || typeof rawApiKey !== 'string') return { ok: false, error: 'baseURL 或 API Key 为空' };
  const baseURL = rawBaseURL.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseURL)) return { ok: false, error: 'baseURL 必须以 http:// 或 https:// 开头' };
  try {
    const resp = await net.fetch(baseURL + '/models', { headers: { Authorization: `Bearer ${rawApiKey}` } });
    const text = await resp.text();
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 180)}` };
    const json = JSON.parse(text) as { data?: Array<{ id?: string }> };
    const models = (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').sort();
    return models.length ? { ok: true, models } : { ok: false, error: '服务返回的模型列表为空' };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
});

// IPC: MCP 状态 / tool 列表 / 手动重连(debug 用)
ipcMain.handle('mcp:listTools', async (): Promise<McpToolDesc[]> => {
  return mcpManager.listAllTools();
});
ipcMain.handle('mcp:getStatus', () => {
  return { running: mcpManager.hasAnyServer() };
});
// IPC: 让渲染端弹原生"选文件"对话框(用于选 SQLite .db / Chrome MCP stdio.js 等)
ipcMain.handle(
  'mcp:pickFile',
  async (
    _e,
    opts?: { filters?: Array<{ name: string; extensions: string[] }>; title?: string },
  ): Promise<string | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: opts?.title ?? '选择文件',
      filters: opts?.filters,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  },
);

// IPC: 让渲染端弹原生"选目录"对话框,返回用户选中的绝对路径数组
ipcMain.handle('mcp:pickDirectory', async (): Promise<string[]> => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'multiSelections'],
    title: '选择允许 AI 访问的目录',
  });
  if (result.canceled) return [];
  return result.filePaths;
});

/** 一键安装 preset 的 npm-global 包 + 探测 stdio 路径 + 写回 config。
 *  通过 'mcp:installLog' 流式推送 stdout/stderr 给渲染端。返回最终的 server id。 */
ipcMain.handle(
  'mcp:oneClickInstall',
  async (_e, presetId: string): Promise<{ serverId: string; postSetupUrl?: string; postSetupHint?: string }> => {
    const { MCP_PRESETS } = await import('../shared/mcp-presets.js');
    const preset = MCP_PRESETS.find((p) => p.id === presetId);
    if (!preset) throw new Error(`unknown preset_id: ${presetId}`);
    const oc = preset.oneClickInstall;
    if (!oc) throw new Error(`preset "${presetId}" has no oneClickInstall config`);

    const log = (line: string): void => {
      mainWindow?.webContents.send('mcp:installLog', { presetId, line });
    };
    const runCmd = (cmd: string, args: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        // npm 在 Windows 是 .cmd,需要 shell:true
        const child = spawn(cmd, args, { shell: true, env: process.env });
        let out = '';
        child.stdout.on('data', (b: Buffer) => {
          const s = b.toString();
          out += s;
          s.split(/\r?\n/).forEach((l) => l && log(l));
        });
        child.stderr.on('data', (b: Buffer) => {
          const s = b.toString();
          s.split(/\r?\n/).forEach((l) => l && log(`[stderr] ${l}`));
        });
        child.on('error', reject);
        child.on('close', (code: number | null) => {
          if (code === 0) resolve(out.trim());
          else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
        });
      });

    /** 通用:把 spec 加进 config + 启动 server,返回 newId */
    const addSpecAndStart = async (
      specArgs: string[],
    ): Promise<string> => {
      const cfg = loadConfig();
      const existing = cfg.mcp?.servers ?? [];
      const used = new Set(existing.map((s) => s.id));
      let newId = preset.id;
      let i = 2;
      while (used.has(newId)) newId = `${preset.id}${i++}`;
      const newSpec = {
        id: newId,
        name: preset.template.name,
        enabled: true,
        command: preset.template.command,
        args: specArgs,
        env: preset.template.env,
      };
      const nextMcp = {
        enabled: cfg.mcp?.enabled !== false,
        servers: [...existing, newSpec],
        confirmWrites: cfg.mcp?.confirmWrites !== false,
      };
      saveConfig({ mcp: nextMcp });
      await mcpManager.applyConfig(nextMcp);
      notifyRenderer('app:configChanged', { reason: 'mcp-installed' });
      return newId;
    };

    let serverId: string;
    if (oc.kind === 'npm-global') {
      log(`▶ npm install -g ${oc.package} (这一步可能要 1~2 分钟,耐心等)`);
      await runCmd('npm', ['install', '-g', oc.package]);
      log(`✓ npm 全局安装完成`);
      log(`▶ npm root -g (探测全局 node_modules 根)`);
      const npmRoot = (await runCmd('npm', ['root', '-g'])).trim();
      log(`  → ${npmRoot}`);
      const stdioPath = path.join(npmRoot, oc.package, oc.stdioRelPath);
      if (!fs.existsSync(stdioPath)) {
        throw new Error(`未找到 stdio 入口文件:${stdioPath}\n请检查包是否正确安装,或包结构有变化。`);
      }
      log(`✓ 找到 stdio 入口:${stdioPath}`);
      const args = preset.template.args.map((a) => (/^<.+>$/.test(a) ? stdioPath : a));
      serverId = await addSpecAndStart(args);
      log(`✓ 已写入 config 并启动 server: ${serverId}`);
    } else if (oc.kind === 'npx') {
      // 验证 npx 可用(避免用户没装 Node 时安静失败)
      log(`▶ 检查 Node / npx 可用性`);
      try {
        const v = await runCmd('npx', ['--version']);
        log(`✓ npx 版本: ${v}`);
      } catch (e) {
        throw new Error(
          'npx 不可用,请先装 Node.js(nodejs.org,选 LTS 版)。装好后重启桌宠再试。',
        );
      }
      // 直接用 template.args(已经是完整 npx 命令)
      serverId = await addSpecAndStart([...preset.template.args]);
      log(`✓ 已添加 server 并启动: ${serverId}`);
      log(`  首次调用工具时 npx 会下载包,稍等几秒就能用`);
    } else {
      // 兜底:防止以后加了新 kind 忘了处理
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw new Error(`unsupported install kind: ${(oc as any).kind}`);
    }
    return {
      serverId,
      postSetupUrl: oc.postSetupUrl,
      postSetupHint: oc.postSetupHint,
    };
  },
);

ipcMain.handle('mcp:restart', async () => {
  const cfg = loadConfig();
  await mcpManager.stopAll();
  // 清 signature,强制重连
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mcpManager as any).lastSignature = '';
  await mcpManager.applyConfig(cfg.mcp);
  return { running: mcpManager.hasAnyServer() };
});

// IPC: 发起一次 AI 流式聊天。返回 reqId;增量通过 'ai:chunk' / 'ai:done' / 'ai:error' 推回渲染端。
ipcMain.handle(
  'ai:chat',
  async (_e, reqId: string, messages: ChatMessage[]) => {
    if (!mainWindow) return;
    const inputChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
    recordLocalUsage(Math.ceil(inputChars / 2), 0);
    void streamChat(mainWindow, reqId, messages);
  },
);

ipcMain.handle('ai:cancel', (_e, reqId: unknown): boolean => {
  if (typeof reqId !== 'string' || !reqId) return false;
  return cancelChat(reqId);
});

// pet:// → 文件系统映射
//   pet://live2d/<rel>     → resolveAssetRoots().live2d/<rel>
//   pet://sprite/<rel>     → resolveAssetRoots().sprite/<rel>
function registerPetProtocol(): void {
  protocol.handle('pet', async (req) => {
    try {
      const url = new URL(req.url);
      const host = url.hostname;
      const relPath = decodeURIComponent(url.pathname).replace(/^\//, '');
      const roots = resolveAssetRoots();
      let baseDir: string;
      let fullPath: string;
      if (host === 'app') {
        baseDir = DIST;
        fullPath = path.join(baseDir, relPath);
      } else if (host === 'cubism-core' && relPath === CUBISM_CORE) {
        baseDir = live2dUserDirectory();
        fullPath = path.join(baseDir, CUBISM_CORE);
      } else if (host === 'live2d') {
        baseDir = roots.live2d;
        fullPath = path.join(baseDir, relPath);
      } else if (host === 'sprite') {
        baseDir = roots.sprite;
        fullPath = path.join(baseDir, relPath);
      } else if (host === 'hatch-pet') {
        // pet://hatch-pet/<dir>/spritesheet.webp  → 内置 hatch-pet 根
        baseDir = roots.hatchPet;
        fullPath = path.join(baseDir, relPath);
      } else if (host === 'hatch-pet-user') {
        // pet://hatch-pet-user/<dir>/spritesheet.webp  → userData/hatch-pet,导入后落到这里
        baseDir = roots.hatchPetUser;
        fullPath = path.join(baseDir, relPath);
      } else if (host === 'vosk-builtin') {
        // pet://vosk-builtin/<filename>.zip  → 内置 vosk 小模型目录
        // dev:app/VOSK/;prod:resourcesPath/VOSK/(extraResources 打包)
        baseDir = roots.voskBuiltin;
        fullPath = path.join(baseDir, relPath);
      } else if (host === 'vosk-user') {
        // pet://vosk-user/<filename>.zip  → 用户上传的自定义 vosk 模型目录
        // 总在 userData/vosk/(可写),配合 vosk:pickAndImportModel 写入
        baseDir = path.join(app.getPath('userData'), 'vosk');
        fullPath = path.join(baseDir, relPath);
      } else {
        return new Response(`unknown host: ${host}`, { status: 404 });
      }

      const relative = path.relative(baseDir, fullPath);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        return new Response('forbidden', { status: 403 });
      }
      const found = fs.existsSync(fullPath);
      if (found && host !== 'app') {
        const realBase = await fs.promises.realpath(baseDir);
        const realFile = await fs.promises.realpath(fullPath);
        const realRelative = path.relative(realBase, realFile);
        if (!realRelative || realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
          return new Response('forbidden', { status: 403 });
        }
        fullPath = realFile;
      }
      if (!found) {
        return new Response(`not found: ${fullPath}`, { status: 404 });
      }
      const fileResp = await net.fetch(pathToFileURL(fullPath).toString());
      // WebGL 加载 cross-origin texture 时,服务端必须返回 CORS 头,否则 texture 被涂黑。
      // 这里克隆响应,补充必要的 header。
      const headers = new Headers(fileResp.headers);
      if (host === 'cubism-core') headers.set('Content-Type', 'application/javascript');
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Cache-Control', 'no-cache');
      return new Response(fileResp.body, {
        status: fileResp.status,
        statusText: fileResp.statusText,
        headers,
      });
    } catch (e) {
      return new Response(`pet protocol error: ${(e as Error).message}`, { status: 500 });
    }
  });
}

// Windows 任务栏分组 ID — 让桌宠的窗口在任务栏单独成组,不并入"electron"里。
// 必须和 electron-builder.yml 的 appId 完全一致,这样开发和打包都用同一个 ID。
if (process.platform === 'win32') {
  app.setAppUserModelId('io.github.xiaolongniang.desktop-pet');
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(wc === mainWindow?.webContents && permission === 'media'
      && isAppPage(details.requestingUrl) && details.isMainFrame
      && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
  });
  // setPermissionCheckHandler 是 sync 检查(getUserMedia 内部会先调它再 request),
  // 同样必须返回 true,否则浏览器层就直接拒绝不会触发 RequestHandler。
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => {
    return wc === mainWindow?.webContents && permission === 'media'
      && isAppPage(wc.getURL()) && details.isMainFrame && details.mediaType === 'audio';
  });

  registerPetProtocol();
  createWindow();
  createTray();
  // 全屏游戏 / 视频时自动收起桌宠（S4）：前台窗口 helper + 2.5s 轮询
  startForegroundWatch();
  startFullscreenWatch();
  // 主动互动后台监听 — 共享常驻前台窗口采样，仅当 config.proactive.enabled=true 时实际跑;否则 noop
  if (mainWindow) proactiveAware.attach(mainWindow);
  proactiveAware.setForegroundProvider(() => foreground);
  proactiveAware.start();

  refreshCompanionEngine(loadConfig().codexCompanionEnabled === true);

  // skill-registry:先从本地缓存恢复,再后台异步刷新最新列表(失败用旧的)
  loadCachedSkillsIndex();
  void syncSkillsIndex();

  // 启动 MCP servers(根据 config.mcp)。异步 — 失败不阻塞 UI 加载。
  const cfg = loadConfig();
  void mcpManager.applyConfig(cfg.mcp).catch((e) => {
    console.error('[mcp] initial start failed:', (e as Error).message);
  });
  // 剪贴板监听 — 用户复制 ≥ 200 字 / URL 时给桌宠头上弹一个轻量建议气泡
  startClipboardWatcher();

  // F12 / Ctrl+Shift+I 切换 DevTools(仅在当前窗口聚焦时才响应——用 webContents.before-input-event 而非 globalShortcut)
  app.on('browser-window-focus', () => {
    globalShortcut.register('F12', () => {
      mainWindow?.webContents.toggleDevTools();
    });
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      mainWindow?.webContents.toggleDevTools();
    });
  });
  app.on('browser-window-blur', () => {
    globalShortcut.unregister('F12');
    globalShortcut.unregister('CommandOrControl+Shift+I');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let clipboardWatchTimer: ReturnType<typeof setInterval> | null = null;

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cancelAllChats();
  cancelAllAsr();
  proactiveAware.stop();
  if (fullscreenWatchTimer) {
    clearInterval(fullscreenWatchTimer);
    fullscreenWatchTimer = null;
  }
  if (clipboardWatchTimer) {
    clearInterval(clipboardWatchTimer);
    clipboardWatchTimer = null;
  }
  refreshCompanionEngine(false);
  companionSpeechQueue.dispose();
  cloneSpeech.dispose();
  localSpeech.stop();
  // 停掉所有 MCP 子进程,避免遗留
  void mcpManager.stopAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------- 剪贴板监听 ----------------
/**
 * 每 2s poll 一次 clipboard.readText()。隐藏到托盘时暂停。
 * 触发"建议气泡"的条件:
 *   1) 文本和上次不同(避免重复)
 *   2) 不是桌宠自己刚写进去的(set_clipboard tool / 用户复制 AI 回答)— 用 ignoreNextText 标记
 *   3) 长度 ≥ MIN_LEN_LONG_TEXT,或者整段是 URL
 *
 * 渲染端订阅 'clipboard:suggest',显示一个 3 秒自消的小气泡。
 */
const MIN_LEN_LONG_TEXT = 200;
const URL_RE = /^https?:\/\/[^\s]+$/i;
/** 同一段文本在这个时间窗内不重复提示;之后再复制同样的内容也会再提示一次 */
const REPEAT_SUPPRESS_MS = 60_000;
const CLIPBOARD_POLL_MS = 2_000;
/** 上次推送过的 (text → 时间戳)。短期去重,不做绝对去重。 */
const recentSuggested = new Map<string, number>();
let ignoreNextText: string | null = null;

function startClipboardWatcher(): void {
  // 初始化:把当前剪贴板内容当作"刚提示过",避免应用启动那一瞬间就触发(除非用户主动重新复制)
  // 60 秒后这个抑制自动失效 — 这样如果用户启动桌宠前就复制好了 URL,过 1 分钟再切回也能提示
  try {
    const init = clipboard.readText();
    if (init) recentSuggested.set(init, Date.now());
  } catch {
    // ignore
  }
  clipboardWatchTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !windowVisible) return;
    let cur = '';
    try {
      cur = clipboard.readText();
    } catch {
      return;
    }
    if (!cur) return;
    // 跳过桌宠自己刚写入的(set_clipboard / 用户从对话气泡复制 AI 回答 等)
    if (ignoreNextText && cur === ignoreNextText) {
      ignoreNextText = null;
      recentSuggested.set(cur, Date.now());
      return;
    }
    // 短期去重:同一段文本 60 秒内只提示一次
    const lastTs = recentSuggested.get(cur);
    if (lastTs && Date.now() - lastTs < REPEAT_SUPPRESS_MS) return;
    const trimmed = cur.trim();
    const isUrl = URL_RE.test(trimmed);
    const isLong = cur.length >= MIN_LEN_LONG_TEXT;
    if (!isUrl && !isLong) return;
    // 标记已提示 + 清理过老的条目(防止 map 无限长大)
    recentSuggested.set(cur, Date.now());
    if (recentSuggested.size > 100) {
      const cutoff = Date.now() - REPEAT_SUPPRESS_MS;
      for (const [k, ts] of recentSuggested) {
        if (ts < cutoff) recentSuggested.delete(k);
      }
    }
    // 推给渲染端
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log(
        `[clipboard] suggest: isUrl=${isUrl} len=${cur.length} preview="${cur.slice(0, 60)}"`,
      );
      mainWindow.webContents.send('clipboard:suggest', {
        text: cur,
        isUrl,
        len: cur.length,
      });
    }
  }, CLIPBOARD_POLL_MS);
}

/** 渲染端可调:告诉主进程"接下来 N 秒里看到这段文本不要触发建议"
 *  — 用于 set_clipboard / 用户从对话气泡复制 AI 回答 这类我们自己写的内容。 */
ipcMain.handle('clipboard:ignoreNext', (_e, text: string) => {
  ignoreNextText = text;
});

ipcMain.handle('clipboard:write', (_e, text: unknown): boolean => {
  if (typeof text !== 'string') return false;
  try {
    ignoreNextText = text;
    clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
});
