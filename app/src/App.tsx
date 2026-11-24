import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import type { CharacterIndex, Live2DCharacter, HatchPetCharacter } from '../shared/character';
import type { CharacterHostHandle } from './render/character-host';
import { HatchPetHost } from './render/hatch-pet-host';
import { PetMenu } from './ui/pet-menu';
import { ChatBubble } from './ui/chat-bubble';
import { ClipboardSuggestionLayer } from './ui/clipboard-suggestion';
import { UsageBubble } from './ui/usage-bubble';
import type { VoskState } from './render/vosk-shared';
import { LowPolyDragon } from './render/lowpoly-dragon';
import { DepthParallaxDragon } from './render/depth-parallax-dragon';
import { loadCubismCore } from './render/cubism-core';
import { useProactiveGreetings } from './render/use-proactive-greetings';
import dragonColorArt from './assets/dragon/video-dragon-lady-tail-pose.png';
import dragonDepthMap from './assets/dragon/depth_flat.png';
import dragonClosedEyesArt from './assets/dragon/dragon-blink-source.png';

/** 当前外层支持的角色类型(sprite 还没启用)。 */
type ActiveCharacter = Live2DCharacter | HatchPetCharacter;
type PetClickEmotion = 'idle' | 'shy' | 'angry';

/**
 * 主应用:
 * - 全窗 PIXI 透明画布渲染当前 Live2D 角色
 * - 右键画布弹出卡通菜单:切换角色 / 调整大小
 */
export default function App() {
  const [index, setIndex] = useState<CharacterIndex | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [Live2DHost, setLive2DHost] = useState<typeof import('./render/character-host').CharacterHost | null>(null);
  const selectionVersion = useRef(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPanelOpen, setMenuPanelOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [fallbackScale, setFallbackScale] = useState(() => {
    try {
      const saved = Number.parseFloat(localStorage.getItem('desktopPet:fallbackDragonScale') ?? '1');
      return Number.isFinite(saved) ? Math.max(0.3, Math.min(3, saved)) : 1;
    } catch {
      return 1;
    }
  });
  const commitFallbackScale = (value: number) => {
    const next = Math.max(0.3, Math.min(3, value));
    setFallbackScale(next);
    try { localStorage.setItem('desktopPet:fallbackDragonScale', String(next)); } catch { /* storage unavailable */ }
  };
  /** 模型腰线 Y(CSS 像素),用于定位聊天气泡 */
  const [anchorY, setAnchorY] = useState<number | null>(null);
  /** 对话面板是否可见(默认收起,由菜单 💬 按钮打开) */
  const [chatOpen, setChatOpen] = useState(false);
  /** 「只打开对话」模式 — 隐藏模型 canvas,只留聊天气泡。
   *  从托盘"只打开对话"进入,关闭聊天 / 切换角色 / 选"显示桌宠"会复位。 */
  const [modelHidden, setModelHidden] = useState(false);
  /** 桌宠点击三步循环:娇羞并隐藏气泡 → 气泡回来 → 轻微生气。 */
  const [petClickEmotion, setPetClickEmotion] = useState<PetClickEmotion>('idle');
  const [petBubbleVisible, setPetBubbleVisible] = useState(true);
  const petClickStepRef = useRef(0);
  const petEmotionTimerRef = useRef<number | null>(null);
  /** 系统空闲 ≥5 分钟 → 困倦待机（低头/半闭眼/浮动变慢 + 💤）。 */
  const [sleepy, setSleepy] = useState(false);
  /** 「编码(增强)模式」— 改变聊天气泡为底部居中紧凑条,
   *  让模型完整露出。从设置面板开关,实时同步。 */
  const [codingMode, setCodingMode] = useState(false);
  const [codexCompanionEnabled, setCodexCompanionEnabled] = useState(false);
  const [lockPosition, setLockPosition] = useState(false);
  const [companionSpeech, setCompanionSpeech] = useState('');
  const hostRef = useRef<CharacterHostHandle>(null);

  const handlePetClick = useCallback(() => {
    const nextStep = (petClickStepRef.current % 3) + 1;
    petClickStepRef.current = nextStep === 3 ? 0 : nextStep;
    const emotion: PetClickEmotion = nextStep === 3 ? 'angry' : 'shy';
    setPetClickEmotion(emotion);
    setPetBubbleVisible(nextStep !== 1);
    setSleepy(false); // 用户主动摸头 = 有互动，直接醒来
    void window.petAPI?.companionMarkInteraction?.();
    // 复用现有角色的情绪总线:没有专用“娇羞”资源时,用惊讶/开心动作兜底。
    window.dispatchEvent(
      new CustomEvent('pet:emotion', {
        detail: { emotion: nextStep === 3 ? 'angry' : 'surprised' },
      }),
    );
    if (petEmotionTimerRef.current != null) {
      window.clearTimeout(petEmotionTimerRef.current);
    }
    petEmotionTimerRef.current = window.setTimeout(() => {
      petEmotionTimerRef.current = null;
      setPetClickEmotion('idle');
      setPetBubbleVisible(true);
      petClickStepRef.current = 0;
    }, 30_000); // 情绪保持 ≥30s 再回中性（S3）
  }, []);

  useEffect(() => () => {
    if (petEmotionTimerRef.current != null) window.clearTimeout(petEmotionTimerRef.current);
  }, []);

  // 系统空闲 ≥5 分钟进入困倦待机（低头/半闭眼/浮动变慢）；用户回来（空闲回落）自动醒。
  useEffect(() => {
    let cancelled = false;
    const check = (): void => {
      window.petAPI
        ?.getSystemIdleSeconds?.()
        .then((seconds) => {
          if (cancelled) return;
          setSleepy(seconds >= 300);
        })
        .catch(() => {
          /* 取不到系统空闲就保持当前状态 */
        });
    };
    check();
    const timer = window.setInterval(check, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const selectCharacter = useCallback(async (character?: ActiveCharacter) => {
    const request = ++selectionVersion.current;
    setScanError(null);
    setModelHidden(false);
    if (character?.type === 'live2d') {
      try {
        await loadCubismCore();
        const { CharacterHost } = await import('./render/character-host');
        if (request === selectionVersion.current) setLive2DHost(() => CharacterHost);
      } catch (err) {
        if (request === selectionVersion.current) {
          setScanError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }
    if (request === selectionVersion.current) {
      setAnchorY(null);
      setActiveId(character?.id ?? null);
    }
  }, []);

  useEffect(() => {
    const offConfig = window.petAPI?.onAppConfigChanged?.((payload) => {
      window.dispatchEvent(new CustomEvent('petAI:configChanged', { detail: payload }));
    });
    const offSkills = window.petAPI?.onAppSkillsChanged?.((payload) => {
      window.dispatchEvent(new CustomEvent('petAI:skillsChanged', { detail: payload }));
    });
    return () => {
      offConfig?.();
      offSkills?.();
    };
  }, []);

  // 复用主进程每 33ms 广播的全屏鼠标坐标。目标角度先限幅，再用阻尼追赶，
  // 让头部、身体和裙摆保持同一方向，避免鼠标快速移动时模型抖动。
  useEffect(() => {
    let raf = 0;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let lastTime = performance.now();
    let lastSide = 0;
    let turnTimer = 0;
    const getHost = (): HTMLElement | null => document.querySelector('.fallback-dragon');
    const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
    const updateTarget = (clientX: number, clientY: number): void => {
      const host = getHost();
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const centerX = rect.left + rect.width * 0.5;
      const centerY = rect.top + rect.height * 0.34;
      targetX = clamp((clientX - centerX) / Math.max(120, rect.width * 1.35), -1, 1);
      targetY = clamp((clientY - centerY) / Math.max(180, rect.height * 1.2), -1, 1);
    };
    const offCursor = window.petAPI?.onCursorScreen?.(updateTarget);
    const tick = (now: number): void => {
      const host = getHost();
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;
      const smoothing = 1 - Math.exp(-dt * 9);
      currentX += (targetX - currentX) * smoothing;
      currentY += (targetY - currentY) * smoothing;
      if (host) {
        const lookX = currentX * 3;
        const lookY = currentY * -2;
        const turn = currentX * 3;
        const turnWave = Math.sin(now * 0.00042) * 0.9 + Math.sin(now * 0.00019) * 0.5;
        host.style.setProperty('--pet-look-x', `${lookX.toFixed(2)}deg`);
        host.style.setProperty('--pet-look-y', `${lookY.toFixed(2)}deg`);
        host.style.setProperty('--pet-turn', `${turn.toFixed(2)}deg`);
        host.style.setProperty('--pet-turn-wave', `${turnWave.toFixed(2)}deg`);
        host.style.setProperty('--pet-follow-strength', `${(0.94 + Math.abs(currentX) * 0.06).toFixed(3)}`);
        const side = currentX > 0.38 ? 1 : currentX < -0.38 ? -1 : 0;
        if (side !== 0 && side !== lastSide) {
          host.classList.remove('fallback-dragon--turning');
          void host.offsetWidth;
          host.classList.add('fallback-dragon--turning');
          window.clearTimeout(turnTimer);
          turnTimer = window.setTimeout(() => host.classList.remove('fallback-dragon--turning'), 720);
        }
        lastSide = side;
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      if (typeof offCursor === 'function') offCursor();
      window.clearTimeout(turnTimer);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const onAiRequest = () => {
      setModelHidden(false);
      setMenuOpen(true);
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('pet:open-ai-settings')), 60);
    };
    window.addEventListener('pet:request-ai-settings', onAiRequest);
    return () => window.removeEventListener('pet:request-ai-settings', onAiRequest);
  }, []);

  // 监听 cfg.codingMode / codexCompanionEnabled / lockPosition — 初次 + 设置变更后都同步
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      window.petAPI?.getConfig?.().then((cfg) => {
        if (cancelled) return;
        setCodingMode(!!cfg.codingMode);
        setCodexCompanionEnabled(cfg.codexCompanionEnabled === true);
        setLockPosition(!!cfg.lockPosition);
      });
    };
    refresh();
    const onCfg = () => refresh();
    window.addEventListener('petAI:configChanged', onCfg);
    return () => {
      cancelled = true;
      window.removeEventListener('petAI:configChanged', onCfg);
    };
  }, []);

  // 陪伴引擎与主动问候气泡（非 Live2D 角色：内置小龙娘 / HatchPet）共用定时器与气泡通道
  const speechClearTimerRef = useRef<number | null>(null);
  const showHintSpeech = useCallback((rawLine: string, durationMs = 6000) => {
    const line = typeof rawLine === 'string' ? rawLine.trim() : '';
    if (!line) return;
    setCompanionSpeech(line);
    if (speechClearTimerRef.current != null) window.clearTimeout(speechClearTimerRef.current);
    const duration = typeof durationMs === 'number' && durationMs > 0 ? Math.max(3000, durationMs) : 6000;
    speechClearTimerRef.current = window.setTimeout(() => {
      speechClearTimerRef.current = null;
      setCompanionSpeech('');
    }, duration);
  }, []);

  useEffect(() => {
    const off = window.petAPI?.onCompanionSay?.((payload) => {
      if (document.hidden) return;
      showHintSpeech(payload?.line ?? '', typeof payload?.durationMs === 'number' && payload.durationMs > 0 ? Math.max(4000, payload.durationMs) : 6000);
    });
    return () => {
      if (speechClearTimerRef.current != null) window.clearTimeout(speechClearTimerRef.current);
      off?.();
    };
  }, [showHintSpeech]);

  useEffect(() => {
    if (!window.petAPI) {
      setScanError('preload 未加载');
      return;
    }
    let cancelled = false;
    const doScan = (initial: boolean) => {
      const version = selectionVersion.current;
      window.petAPI
        ?.scanCharacters()
        .then(async (idx) => {
          if (cancelled) return;
          setIndex(idx);
          if (initial) {
            const cfg = await window.petAPI?.getConfig?.();
            const preferred = [...idx.live2d, ...idx.hatchPet].find((c) => c.id === cfg?.defaultCharacterId);
            if (!cancelled && preferred && version === selectionVersion.current) {
              await selectCharacter(preferred);
            }
          }
        })
        .catch((e) => {
          if (!cancelled) setScanError(String(e));
        });
    };
    doScan(true);
    // hatch-pet 导入 / 删除后会派发该事件,我们重新扫一次刷新菜单
    const onCharsChanged = () => doScan(false);
    window.addEventListener('pet:characters-changed', onCharsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('pet:characters-changed', onCharsChanged);
    };
  }, [selectCharacter]);

  // 合并 Live2D + Hatch-Pet 作为可选角色列表;sprite 仍未启用所以不并入
  const characters: ActiveCharacter[] = [
    ...(index?.live2d ?? []),
    ...(index?.hatchPet ?? []),
  ];
  const active = activeId ? characters.find((c) => c.id === activeId) : undefined;

  // 首次启动 5 秒轻引导气泡（仅在新用户首次打开时弹出一次，打开菜单或对话后立即收起）
  useEffect(() => {
    if (!index) return;
    let shownBefore = false;
    try {
      shownBefore = localStorage.getItem('desktopPet:onboardingHintShown') === '1';
    } catch {
      shownBefore = true;
    }
    if (shownBefore) return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem('desktopPet:onboardingHintShown', '1');
      } catch {
        // ignore storage error
      }
      showHintSpeech('嗨～右键点我可以打开对话和设置哦！', 5000);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [index, showHintSpeech]);

  // Live2D 由 CharacterHost 内部挂载 useProactiveGreetings；内置小龙娘与 HatchPet 在外层挂载
  useProactiveGreetings({
    characterId: active?.id ?? 'builtin-dragon',
    characterName: active?.name ?? '小龙娘',
    showHint: showHintSpeech,
    enabled: active?.type !== 'live2d',
  });

  const manualSwitchRef = useRef(false);
  const pickCharacterId = useCallback((id: string | null) => {
    if (id === activeId) {
      selectionVersion.current++;
      setScanError(null);
      setModelHidden(false);
      return;
    }
    if (id === null) {
      manualSwitchRef.current = true;
      void selectCharacter();
      return;
    }
    const character = index?.live2d.find((c) => c.id === id) ?? index?.hatchPet.find((c) => c.id === id);
    if (character) {
      manualSwitchRef.current = true;
      void selectCharacter(character);
    }
  }, [activeId, index, selectCharacter]);

  const onCharacterError = useCallback((error: Error) => {
    setActiveId(null);
    setAnchorY(null);
    setScanError(error.message);
  }, []);

  const handleContextMenu = useCallback(() => {
    if (speechClearTimerRef.current != null) {
      window.clearTimeout(speechClearTimerRef.current);
      speechClearTimerRef.current = null;
    }
    setCompanionSpeech('');
    setMenuOpen(true);
  }, []);

  // 默认禁掉整窗右键菜单(包括非 canvas 区,例如错误 overlay)
  useEffect(() => {
    const onCtx = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('contextmenu', onCtx);
    return () => window.removeEventListener('contextmenu', onCtx);
  }, []);

  // 剪贴板建议点"总结/打开"时,自动打开对话气泡 — chat-bubble 自己会接收 prompt 并发送
  useEffect(() => {
    const onOpen = () => setChatOpen(true);
    window.addEventListener('pet:open-chat-with', onOpen);
    return () => window.removeEventListener('pet:open-chat-with', onOpen);
  }, []);

  // 对话气泡中的齿轮按钮请求打开设置。
  useEffect(() => {
    const onSettingsRequest = () => {
      setModelHidden(false);
      setMenuOpen(true);
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('pet:open-settings')), 60);
    };
    window.addEventListener('pet:request-settings', onSettingsRequest);
    return () => window.removeEventListener('pet:request-settings', onSettingsRequest);
  }, []);

  // ===== 托盘菜单事件订阅 =====
  // 切角色 / 打开对话 / 打开设置 都从托盘的右键菜单触发
  useEffect(() => {
    const off1 = window.petAPI?.onTraySwitchCharacter?.(pickCharacterId);
    const off2 = window.petAPI?.onTrayOpenChat?.(() => {
      // 「打开对话和模型」:模型 + 聊天都要可见
      setModelHidden(false);
      setChatOpen(true);
    });
    const off2b = window.petAPI?.onTrayOpenChatOnly?.(() => {
      // 「只打开对话」:只弹聊天气泡,模型隐藏
      setModelHidden(true);
      setChatOpen(true);
    });
    const off3 = window.petAPI?.onTrayOpenSettings?.(() => {
      // 设置面板需要看到模型(用户可能要调大小、切角色等)
      setModelHidden(false);
      // 先打开菜单 → 等下一个 tick PetMenu listener 已挂载 → 派发事件让它跳到 settings 面板
      setMenuOpen(true);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('pet:open-settings'));
      }, 60);
    });
    return () => {
      off1?.();
      off2?.();
      off2b?.();
      off3?.();
    };
  }, [pickCharacterId]);

  // 角色切换时,通知主进程刷新托盘菜单的 ● 标记
  useEffect(() => {
    void window.petAPI?.trayRefresh?.({ activeCharacterId: active?.id ?? null });
  }, [active?.id]);

  // 用户手动切换角色后派发事件 → use-proactive-greetings 监听后让 AI 主动打招呼（包含切回内置小龙娘）
  useEffect(() => {
    if (!manualSwitchRef.current) return;
    manualSwitchRef.current = false;
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('pet:character-switched'));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [activeId]);

  return (
    <div
      className={
        'app-root' +
        (chatOpen ? '' : ' app--no-chat') +
        (modelHidden ? ' app--model-hidden' : '') +
        (codingMode ? ' app--coding' : '') +
        (petClickEmotion === 'shy'
          ? ' app--pet-shy'
          : petClickEmotion === 'angry'
            ? ' app--pet-angry'
            : '') +
        (!petBubbleVisible ? ' app--pet-bubble-hidden' : '')
      }
    >
      {active && index && active.type === 'live2d' && Live2DHost && (
        <Live2DHost
          ref={hostRef}
          key={active.id}
          character={active}
          roots={index.roots}
          onError={onCharacterError}
          onContextMenu={handleContextMenu}
          onScaleChange={setScale}
          onAnchorY={setAnchorY}
          onPetClick={handlePetClick}
          visible={!modelHidden}
        />
      )}
      {active && index && active.type === 'hatch-pet' && (
        <HatchPetHost
          ref={hostRef}
          key={active.id}
          character={active}
          roots={index.roots}
          onError={onCharacterError}
          onContextMenu={handleContextMenu}
          onScaleChange={setScale}
          onAnchorY={setAnchorY}
          onPetClick={handlePetClick}
          visible={!modelHidden}
          lockPosition={lockPosition}
        />
      )}

      {!active && (
        <FallbackDragon
          visible={!modelHidden}
          scale={fallbackScale}
          expanded={menuPanelOpen || chatOpen}
          onContextMenu={handleContextMenu}
          emotion={petClickEmotion}
          onPetClick={handlePetClick}
          sleepy={sleepy}
          lockPosition={lockPosition}
        />
      )}

      {/* 扫描错误 / 加载提示:轻量浮层,后期可移到菜单内 */}
      {scanError && <div className="scan-error" role="status">{scanError}</div>}
      {!index && !scanError && <div className="scan-hint">扫描资源中…</div>}

      <ChatBubble
        visible={chatOpen}
        onClose={() => setChatOpen(false)}
        anchorY={anchorY}
        characterName={active?.name ?? null}
        codingMode={codingMode}
      />

      <PetMenu
        open={menuOpen}
        placeByDragon={!active && !modelHidden && !chatOpen}
        onPanelOpenChange={setMenuPanelOpen}
        onClose={() => setMenuOpen(false)}
        characters={characters}
        activeId={active?.id}
        activeCharacterName={active?.name ?? null}
        onPick={pickCharacterId}
        scale={active ? scale : fallbackScale}
        onScale={(s) => active ? hostRef.current?.setUserScale(s) : commitFallbackScale(s)}
        onPreviewScale={(s) => active ? hostRef.current?.previewUserScale(s) : setFallbackScale(s)}
        onResetScale={() => active ? hostRef.current?.resetUserScale() : commitFallbackScale(1)}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((v) => !v)}
      />

      {/* 剪贴板建议气泡 — 全局监听,不依赖 chatOpen。
          位置贴模型腰线(anchorY),跟"思考中"气泡同区域,显眼又自然。
          点"总结/打开看看"会 dispatch 'pet:open-chat-with',这里同时打开对话气泡 */}
      <ClipboardSuggestionLayer anchorY={anchorY} />
      <UsageBubble
        anchorY={anchorY ?? 460}
        visible={!!(active || index) && !modelHidden && petBubbleVisible}
        showUsage={codexCompanionEnabled}
        speech={
          !active
            ? (petClickEmotion === 'angry'
                ? '哼……再点我就要生气了！'
                : petClickEmotion === 'shy'
                  ? '呀……主人别盯着我看啦。'
                  : companionSpeech)
            : active.type !== 'live2d'
              ? companionSpeech
              : ''
        }
      />

      {/* 全局 vosk 模型加载状态浮层 — 任何地方触发的加载(启动预热 / 设置面板手动)
          完成后都会通过 'pet:vosk-state' 通知到这里,关闭设置面板也能收到 */}
      <VoskToast />
    </div>
  );
}

function FallbackDragon({
  visible,
  scale,
  expanded,
  onContextMenu,
  emotion,
  onPetClick,
  sleepy,
  lockPosition,
}: {
  visible: boolean;
  scale: number;
  expanded: boolean;
  onContextMenu: () => void;
  emotion: PetClickEmotion;
  onPetClick: () => void;
  sleepy: boolean;
  lockPosition: boolean;
}): JSX.Element | null {
  const FALLBACK_W = 330;
  const FALLBACK_H = 490;
  const FALLBACK_TOP_TRANSFORM = 0.42;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const lockPositionRef = useRef(lockPosition);
  lockPositionRef.current = lockPosition;
  const clampFallbackOffset = (offset: { x: number; y: number }): { x: number; y: number } => {
    // Keep at least a small visible strip on-screen so a drag cannot move the
    // transparent pet completely outside the desktop and become unrecoverable.
    const margin = 12;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const width = FALLBACK_W * scaleRef.current;
    const height = FALLBACK_H * scaleRef.current;
    const left = viewportW / 2 + offset.x - width / 2;
    const top = viewportH / 2 + offset.y - height * FALLBACK_TOP_TRANSFORM;
    const minLeft = width + margin * 2 <= viewportW ? margin : margin - width;
    const maxLeft = width + margin * 2 <= viewportW ? viewportW - margin - width : viewportW - margin;
    const minTop = height + margin * 2 <= viewportH ? margin : margin - height;
    const maxTop = height + margin * 2 <= viewportH ? viewportH - margin - height : viewportH - margin;
    const clampedLeft = Math.max(minLeft, Math.min(maxLeft, left));
    const clampedTop = Math.max(minTop, Math.min(maxTop, top));
    return {
      x: clampedLeft - viewportW / 2 + width / 2,
      y: clampedTop - viewportH / 2 + height * FALLBACK_TOP_TRANSFORM,
    };
  };
  const [patting, setPatting] = useState(false);
  const [highDetailArtReady, setHighDetailArtReady] = useState(true);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>(() => {
    try {
      const screenPosition = JSON.parse(localStorage.getItem('desktopPet:fallbackDragonScreenPosition') ?? 'null');
      if (screenPosition && Number.isFinite(screenPosition.x) && Number.isFinite(screenPosition.y)) {
        return {
          x: screenPosition.x - window.screenX + FALLBACK_W * scale / 2 - window.innerWidth / 2,
          y: screenPosition.y - window.screenY + FALLBACK_H * scale * FALLBACK_TOP_TRANSFORM - window.innerHeight / 2,
        };
      }
      const raw = localStorage.getItem('desktopPet:fallbackDragonPosition');
      if (raw) {
        const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          return clampFallbackOffset({ x: parsed.x, y: parsed.y });
        }
      }
    } catch {
      // ignore malformed or unavailable local storage
    }
    return { x: 0, y: 0 };
  });
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, moved: false, pointerId: -1, startX: 0, startY: 0, originX: 0, originY: 0, lastScreenX: 0, lastScreenY: 0 });
  const compactRef = useRef(false);
  const fittingRef = useRef(false);
  const fitDeferredRef = useRef(false);
  const initialScaleRef = useRef(true);
  const [fitVersion, setFitVersion] = useState(0);
  const lastMoveRef = useRef<Promise<void>>(Promise.resolve());
  const fitQueueRef = useRef(Promise.resolve());
  const lastScreenRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fitQueueRef.current = fitQueueRef.current.then(async () => {
      if (cancelled || !window.petAPI?.fitPetWindow) return;
      if (dragRef.current.active) { fitDeferredRef.current = true; return; }
      fitDeferredRef.current = false;
      await lastMoveRef.current;
      if (cancelled) return;
      const host = hostRef.current;
      const rect = host?.getBoundingClientRect();
      const screenRect = rect ? { x: window.screenX + rect.left, y: window.screenY + rect.top, width: rect.width, height: rect.height } : lastScreenRectRef.current;
      if (!screenRect) return;
      lastScreenRectRef.current = screenRect;
      const shouldExpand = expanded || !visible;
      // 在原生窗口移动和 Chromium 视口重排期间，把模型钉在原屏幕坐标（若离屏则钉到钳制后的目标坐标）。
      // IPC 回包可能比 resize 更早，不能直接用新窗口大小更新相对偏移。
      let pinScreenX = screenRect.x + screenRect.width / 2;
      let pinScreenY = screenRect.y + screenRect.height * FALLBACK_TOP_TRANSFORM;
      const pin = () => {
        host?.style.setProperty('--pet-fit-x', `${pinScreenX - window.screenX}px`);
        host?.style.setProperty('--pet-fit-y', `${pinScreenY - window.screenY}px`);
      };
      let frame = 0;
      const tick = () => { pin(); frame = window.requestAnimationFrame(tick); };
      fittingRef.current = true;
      if (host) {
        tick();
        window.addEventListener('resize', pin);
      }
      try {
        const bounds = await window.petAPI.fitPetWindow(screenRect, shouldExpand ? 'expanded' : 'compact');
        if (!bounds) {
          if (!cancelled) {
            setDragOffset((offset) => {
              const next = clampFallbackOffset(offset);
              return next.x === offset.x && next.y === offset.y ? offset : next;
            });
          }
          return;
        }
        const targetModelX = typeof bounds.modelX === 'number' && Number.isFinite(bounds.modelX) ? bounds.modelX : screenRect.x;
        const targetModelY = typeof bounds.modelY === 'number' && Number.isFinite(bounds.modelY) ? bounds.modelY : screenRect.y;
        pinScreenX = targetModelX + screenRect.width / 2;
        pinScreenY = targetModelY + screenRect.height * FALLBACK_TOP_TRANSFORM;
        pin();
        compactRef.current = !shouldExpand;
        if (host) {
          for (let i = 0; i < 10; i += 1) {
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
            if (Math.abs(window.screenX - bounds.x) <= 1 && Math.abs(window.screenY - bounds.y) <= 1 &&
                Math.abs(window.innerWidth - bounds.width) <= 1 && Math.abs(window.innerHeight - bounds.height) <= 1) break;
          }
          if (hostRef.current === host) {
            const rawOffset = {
              x: pinScreenX - window.screenX - window.innerWidth / 2,
              y: pinScreenY - window.screenY - window.innerHeight / 2,
            };
            const modelLeftInWin = window.innerWidth / 2 + rawOffset.x - screenRect.width / 2;
            const modelTopInWin = window.innerHeight / 2 + rawOffset.y - screenRect.height * FALLBACK_TOP_TRANSFORM;
            const outsideWin =
              modelLeftInWin + screenRect.width <= 0 ||
              modelLeftInWin >= window.innerWidth ||
              modelTopInWin + screenRect.height <= 0 ||
              modelTopInWin >= window.innerHeight;
            const nextOffset = outsideWin ? clampFallbackOffset(rawOffset) : rawOffset;
            flushSync(() => setDragOffset((offset) => offset.x === nextOffset.x && offset.y === nextOffset.y ? offset : nextOffset));
            window.dispatchEvent(new CustomEvent('pet:fallback-position'));
            const pinned = host.getBoundingClientRect();
            const persistedX = window.screenX + pinned.left;
            const persistedY = window.screenY + pinned.top;
            lastScreenRectRef.current = { x: persistedX, y: persistedY, width: pinned.width, height: pinned.height };
            void window.petAPI.setInteractiveBounds?.({ left: pinned.left, top: pinned.top, width: pinned.width, height: pinned.height });
            try { localStorage.setItem('desktopPet:fallbackDragonScreenPosition', JSON.stringify({ x: persistedX, y: persistedY })); } catch { /* storage unavailable */ }
          }
        } else if (!cancelled) {
          setDragOffset({ x: pinScreenX - bounds.x - bounds.width / 2, y: pinScreenY - bounds.y - bounds.height / 2 });
          lastScreenRectRef.current = { x: targetModelX, y: targetModelY, width: screenRect.width, height: screenRect.height };
          try { localStorage.setItem('desktopPet:fallbackDragonScreenPosition', JSON.stringify({ x: targetModelX, y: targetModelY })); } catch { /* storage unavailable */ }
        }
      } finally {
        fittingRef.current = false;
        window.cancelAnimationFrame(frame);
        window.removeEventListener('resize', pin);
        host?.style.removeProperty('--pet-fit-x');
        host?.style.removeProperty('--pet-fit-y');
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [expanded, scale, visible, fitVersion]);

  useEffect(() => () => {
    if (lastScreenRectRef.current) {
      void window.petAPI?.fitPetWindow(lastScreenRectRef.current, 'full');
    }
  }, []);

  useEffect(() => {
    if (initialScaleRef.current) { initialScaleRef.current = false; return; }
    if (compactRef.current) return;
    setDragOffset((offset) => {
      const next = clampFallbackOffset(offset);
      return next.x === offset.x && next.y === offset.y ? offset : next;
    });
  }, [scale]);

  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent('pet:fallback-position', { detail: dragOffset }));
    const frame = window.requestAnimationFrame(() => {
      const host = document.querySelector('.fallback-dragon') as HTMLElement | null;
      const rect = host?.getBoundingClientRect();
      void window.petAPI?.setInteractiveBounds?.(rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dragOffset, scale, visible]);

  useEffect(() => {
    const onGlobalPointerMove = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag.active || event.pointerId !== drag.pointerId) return;
      if (compactRef.current) {
        const dx = event.screenX - drag.lastScreenX;
        const dy = event.screenY - drag.lastScreenY;
        if (Math.abs(event.screenX - drag.startX) > 3 || Math.abs(event.screenY - drag.startY) > 3) drag.moved = true;
        if (!drag.moved) return;
        drag.lastScreenX = event.screenX;
        drag.lastScreenY = event.screenY;
        if (dx || dy) lastMoveRef.current = window.petAPI.moveWindowBy(dx, dy).catch(() => {});
        event.preventDefault();
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      setDragOffset(clampFallbackOffset({ x: drag.originX + dx, y: drag.originY + dy }));
      event.preventDefault();
    };
    const onGlobalPointerUp = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag.active || event.pointerId !== drag.pointerId) return;
      drag.active = false;
      const host = hostRef.current;
      host?.style.setProperty('--pet-tilt-y', '0deg');
      host?.style.setProperty('--pet-tilt-x', '0deg');
      if (drag.moved || fitDeferredRef.current) {
        void lastMoveRef.current.then(() => {
          window.requestAnimationFrame(() => setFitVersion((v) => v + 1));
        });
      }
      if (drag.moved) {
        window.setTimeout(() => {
          if (!dragRef.current.active) dragRef.current.moved = false;
        }, 0);
      }
    };
    window.addEventListener('pointermove', onGlobalPointerMove, { passive: false });
    window.addEventListener('pointerup', onGlobalPointerUp);
    window.addEventListener('pointercancel', onGlobalPointerUp);
    window.addEventListener('lostpointercapture', onGlobalPointerUp);
    return () => {
      window.removeEventListener('pointermove', onGlobalPointerMove);
      window.removeEventListener('pointerup', onGlobalPointerUp);
      window.removeEventListener('pointercancel', onGlobalPointerUp);
      window.removeEventListener('lostpointercapture', onGlobalPointerUp);
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || fittingRef.current || lockPositionRef.current) return;
    dragRef.current = {
      active: true,
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: dragOffset.x,
      originY: dragOffset.y,
      lastScreenX: event.screenX,
      lastScreenY: event.screenY,
    };
    if (compactRef.current) { dragRef.current.startX = event.screenX; dragRef.current.startY = event.screenY; }
    event.currentTarget.setPointerCapture(event.pointerId);
    // 拖动期间必须关闭窗口穿透,否则鼠标移出模型边缘后事件会落到桌面,
    // 造成拖动中断。
    window.petAPI?.setIgnoreMouseEvents(false, false);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current.active || fittingRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const nx = (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
    const ny = (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
    event.currentTarget.style.setProperty('--pet-tilt-y', `${Math.max(-2.5, Math.min(2.5, nx * 5))}deg`);
    event.currentTarget.style.setProperty('--pet-tilt-x', `${Math.max(-2, Math.min(2, -ny * 4))}deg`);
  };

  // Fallback 图片没有 CharacterHost 的 WebGL alpha hit-test,因此单独维护
  // 鼠标穿透:桌面空白区域穿透,小龙娘和对话/UI 区域保留交互。
  useEffect(() => {
    let insideInteractive = false;
    const interactiveSelector =
      '.fallback-dragon, .pet-menu, .pet-menu-panel, .qa-popup, .dialog-frame, .usage-bubble, .clipboard-suggest, .scan-error, .scan-hint, .vosk-toast';
    const updatePassthrough = (event: MouseEvent) => {
      if (dragRef.current.active) { insideInteractive = true; return; }
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const next = !!target?.closest(interactiveSelector);
      if (next === insideInteractive) return;
      insideInteractive = next;
      window.petAPI?.setIgnoreMouseEvents(!next, true);
    };
    window.petAPI?.setIgnoreMouseEvents(true, true);
    window.addEventListener('mousemove', updatePassthrough);
    window.addEventListener('pointerup', updatePassthrough);
    window.addEventListener('pointercancel', updatePassthrough);
    return () => {
      window.removeEventListener('mousemove', updatePassthrough);
      window.removeEventListener('pointerup', updatePassthrough);
      window.removeEventListener('pointercancel', updatePassthrough);
      void window.petAPI?.setInteractiveBounds?.(null);
      window.petAPI?.setIgnoreMouseEvents(true, true);
    };
  }, []);

  const pat = () => {
    setPatting(true);
    onPetClick();
    // 摸头时让深度视差层眨一下眼（组件监听该事件）
    window.dispatchEvent(new CustomEvent('pet:depth-blink'));
    window.setTimeout(() => setPatting(false), 520);
  };
  if (!visible) return null;
  return (
    <div
      ref={hostRef}
      className={
        'character-host fallback-dragon fallback-dragon-3d fallback-dragon--' +
        emotion +
        (patting ? ' fallback-dragon--patting' : '') +
        (sleepy ? ' fallback-dragon--sleepy' : '')
      }
      aria-label="内置小龙娘"
      style={{ left: `var(--pet-fit-x, calc(50% + ${dragOffset.x}px))`, top: `var(--pet-fit-y, calc(50% + ${dragOffset.y}px))`, transform: `translate(-50%, -42%) scale(${scale})`, transformOrigin: '50% 42%', cursor: lockPosition ? 'default' : dragRef.current.active ? 'grabbing' : 'grab', '--pet-look-x': '0deg', '--pet-look-y': '0deg', '--pet-turn': '0deg', '--pet-turn-wave': '0deg' } as React.CSSProperties}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(); }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={(event) => {
        if (!dragRef.current.active) {
          event.currentTarget.style.setProperty('--pet-tilt-y', '0deg');
          event.currentTarget.style.setProperty('--pet-tilt-x', '0deg');
        }
      }}
    >
      <div className="fallback-dragon-3d__model">
        <div className="fallback-dragon-3d__depth" aria-hidden="true" />
        {highDetailArtReady ? (
          <>
            <img
              className="fallback-dragon-3d__reference-art"
              src={dragonColorArt}
              alt=""
              draggable={false}
              onError={() => setHighDetailArtReady(false)}
            />
            {/*
             * 深度图成功渲染后显示 canvas，静态立绘只用于加载或失败时兜底。
             */}
            <div className="fallback-dragon-3d__depth-wrap" aria-hidden="true">
              <DepthParallaxDragon
                className="fallback-dragon-3d__depth-canvas"
                colorSrc={dragonColorArt}
                depthSrc={dragonDepthMap}
                closedEyesSrc={dragonClosedEyesArt}
                width={FALLBACK_W}
                height={FALLBACK_H}
                sleepy={sleepy}
              />
            </div>
          </>
        ) : (
          <div className="fallback-dragon-3d__lowpoly">
            <LowPolyDragon emotion={emotion} />
          </div>
        )}
        <span className="fallback-dragon-3d__blush fallback-dragon-3d__blush--left" aria-hidden="true" />
        <span className="fallback-dragon-3d__blush fallback-dragon-3d__blush--right" aria-hidden="true" />
        <span className="fallback-dragon-3d__anger-mark" aria-hidden="true">〆</span>
      </div>
      {sleepy && <div className="fallback-dragon-sleep-mark" aria-hidden="true">💤</div>}
      <button
        className="fallback-dragon-head-hit"
        type="button"
        onPointerDown={(event) => {
          event.stopPropagation();
          dragRef.current.moved = false;
        }}
        onClick={() => {
          if (dragRef.current.moved) {
            dragRef.current.moved = false;
            return;
          }
          pat();
        }}
        aria-label="摸摸头"
      />
    </div>
  );
}

/** Vosk 模型加载完成 / 失败时的全局通知浮层 — 桌宠可见时短暂显示。
 *  Loading 时不显示(loading 进度由设置面板内部呈现);ready/error 才弹通知。
 *  与 .scan-hint 同位(底部左侧),叠在桌面上不抢视线。 */
function VoskToast(): JSX.Element | null {
  const [msg, setMsg] = useState<{ kind: 'ready' | 'error'; text: string } | null>(null);
  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent).detail as VoskState | undefined;
      if (!detail) return;
      if (detail.kind === 'ready') {
        setMsg({ kind: 'ready', text: '✓ 语音识别模型已就绪' });
        // 4 秒后自动收起
        window.setTimeout(() => {
          setMsg((cur) => (cur && cur.kind === 'ready' ? null : cur));
        }, 4000);
      } else if (detail.kind === 'error') {
        setMsg({ kind: 'error', text: '语音模型加载失败:' + detail.message });
        // error 让用户多看一会再消失(8 秒)
        window.setTimeout(() => {
          setMsg((cur) => (cur && cur.kind === 'error' ? null : cur));
        }, 8000);
      } else if (detail.kind === 'idle') {
        setMsg(null);
      }
    };
    window.addEventListener('pet:vosk-state', onState as EventListener);
    return () => window.removeEventListener('pet:vosk-state', onState as EventListener);
  }, []);
  if (!msg) return null;
  return (
    <div className={'vosk-toast vosk-toast--' + msg.kind} onClick={() => setMsg(null)}>
      {msg.text}
    </div>
  );
}
