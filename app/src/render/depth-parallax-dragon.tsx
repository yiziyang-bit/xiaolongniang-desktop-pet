/**
 * 深度图视差渲染层（S2 / 2.5D）+ 眨眼与困倦（S3）
 *
 * 原理：用 Depth Anything V2 为单张立绘生成深度图（见 app/src/assets/dragon/），
 * 在 pixi shader 里做「逆向位移视差」——每个像素按 (深度 − 焦平面) 反向查找源坐标，
 * 鼠标移动时头发在脸后、腿在裙前产生局部错动，单图也能有体积感。
 *
 * S3 追加：
 * - 眨眼：shader 在眼睛区域羽化混合闭眼素材，眼部跟随同一深度位移；
 *   随机 2–6s 眨眼一次；摸头时派发 pet:depth-blink 也会眨一下。
 * - 困倦：由上层传入 sleepy，视差强度降到 45%、眼睛常驻半闭、眨眼变慢。
 *
 * 参数沿用 2026-10-30 评审结论：主层弹簧 stiffness 120 / damping 18，视差强度 ~0.03。
 * 呼吸 / 浮动由外层 CSS 动画负责；尾部摆动以低频唤醒渲染，
 * 页面隐藏时停止，减少不必要的消耗。
 */
import { useEffect, useRef } from 'react';
import * as PIXI from 'pixi.js';

const VERTEX = `
precision highp float;
attribute vec2 aVertexPosition;
attribute vec2 aUvs;
uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;
varying vec2 vUv;
void main() {
  vUv = aUvs;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}`;

// 逆向查找：迭代求「哪个源像素被推到了当前像素」，比直接偏移少很多拉丝。
// 光影随动：用深度梯度当法线，光从视角反方向打过来。
// 眨眼：独立闭眼纹理只在两只眼睛区域混合。
const FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform sampler2D uClosedEyes;
uniform vec2 uOffset;
uniform float uFocus;
uniform vec2 uLight;
uniform float uBlink;
uniform float uTailSway;
uniform vec4 uEyeL;
uniform vec4 uEyeR;
float eyeMask(vec2 uv, vec4 e) {
  vec2 d = (uv - e.xy) / e.zw;
  return 1.0 - smoothstep(0.45, 1.0, dot(d, d));
}
void main() {
  vec2 uv = vUv;
  for (int i = 0; i < 8; i++) {
    float d = texture2D(uDepth, uv).r;
    uv = vUv - uOffset * (d - uFocus);
  }
  // 在同一张立绘上轻推右下尾梢，不叠加第二张图，避免重影。
  float tailWeight = smoothstep(0.70, 0.86, uv.x) * smoothstep(0.50, 0.62, uv.y)
    * (1.0 - smoothstep(0.82, 0.91, uv.y));
  uv.x -= uTailSway * tailWeight;
  // 眼部遮罩与深度位移后的源坐标处于同一空间，转身时不会从脸上滑开。
  float eL = eyeMask(uv, uEyeL);
  float eR = eyeMask(uv, uEyeR);
  float eyeW = clamp(eL + eR, 0.0, 1.0);
  vec4 c = texture2D(uColor, uv);
  vec4 closed = texture2D(uClosedEyes, uv);
  c.rgb = mix(c.rgb, closed.rgb, uBlink * eyeW);
  float dx = texture2D(uDepth, uv + vec2(0.004, 0.0)).r - texture2D(uDepth, uv - vec2(0.004, 0.0)).r;
  float dy = texture2D(uDepth, uv + vec2(0.0, 0.003)).r - texture2D(uDepth, uv - vec2(0.0, 0.003)).r;
  float shade = clamp(1.0 + dot(vec2(dx, dy), uLight) * 6.0, 0.88, 1.12);
  gl_FragColor = vec4(c.rgb * shade, c.a);
}`;

const SPRING_STIFFNESS = 120;
const SPRING_DAMPING = 18;
const STILL_EPSILON = 0.0015;
const BLINK_DURATION_MS = 400;
/** 眼睛在立绘 uv 空间的位置：中心 x/y + 半径 x/y（原图 1024×1536，实测于头部网格图） */
const EYE_LEFT = [0.452, 0.122, 0.024, 0.012];
const EYE_RIGHT = [0.499, 0.114, 0.025, 0.012];
const SLEEPY_BLINK_HOLD = 0.42;
const SLEEPY_STRENGTH_SCALE = 0.45;

function resolveAssetUrl(src: string): string {
  try {
    return new URL(src, window.location.href).href;
  } catch {
    return src;
  }
}

export type DepthParallaxDragonProps = {
  className?: string;
  colorSrc: string;
  depthSrc: string;
  closedEyesSrc?: string;
  width?: number;
  height?: number;
  /** 视差强度（0–0.06，推荐 0.028–0.032） */
  strength?: number;
  /** 困倦待机：视差减弱、眼睛常驻半闭、眨眼变慢 */
  sleepy?: boolean;
};

export function DepthParallaxDragon({
  className,
  colorSrc,
  depthSrc,
  closedEyesSrc,
  width = 330,
  height = 490,
  strength = 0.03,
  sleepy = false,
}: DepthParallaxDragonProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const strengthRef = useRef(strength);
  const sleepyRef = useRef(sleepy);
  /** 主 effect 里注册的「抢一帧」入口，状态变化时用它刷新画面（困倦半闭眼 / 强度变化） */
  const wakeRef = useRef<() => void>(() => {});

  useEffect(() => {
    strengthRef.current = strength;
    sleepyRef.current = sleepy;
    wakeRef.current();
  }, [strength, sleepy]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let renderer: PIXI.Renderer | null = null;
    let mesh: PIXI.Mesh | null = null;
    let raf = 0;
    let running = false;
    let last = performance.now();
    let currentBlink = 0;
    let blinkTimer = 0;
    let blinkCount = 0;
    let contextLost = false;
    const blink = { active: false, startedAt: 0 };
    const stage = new PIXI.Container();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const spring = { x: 0, y: 0, vx: 0, vy: 0 };
    const target = { x: 0, y: 0 };
    const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

    // ---- renderer（透明背景，配合 Electron 透明窗） ----
    try {
      renderer = new PIXI.Renderer({
        width,
        height,
        backgroundAlpha: 0,
        antialias: true,
        resolution: Math.min(2, window.devicePixelRatio || 1),
      });
    } catch {
      return; // WebGL 不可用时直接放弃，画面留给底层 <img> 兜底
    }
    const canvas = renderer.view as HTMLCanvasElement;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.display = 'block';
    canvas.style.pointerEvents = 'none';
    host.appendChild(canvas);

    const renderFrame = (): void => {
      if (!renderer || !mesh || disposed || contextLost) return;
      const uniforms = (mesh as unknown as { shader: { uniforms: Record<string, unknown> } }).shader.uniforms;
      const sleepyNow = sleepyRef.current;
      const baseStrength = strengthRef.current;
      const effStrength = sleepyNow ? baseStrength * SLEEPY_STRENGTH_SCALE : baseStrength;
      uniforms.uOffset = [spring.x * effStrength, spring.y * effStrength * 0.6];
      uniforms.uLight = [-spring.x, -spring.y];
      uniforms.uBlink = sleepyNow ? Math.max(currentBlink, SLEEPY_BLINK_HOLD) : currentBlink;
      uniforms.uTailSway = reducedMotion.matches
        ? 0 : Math.sin(performance.now() * (2 * Math.PI / 5200)) * 0.009;
      renderer.render(stage);
      // 诊断标记：便于启动自检 / 后续设置页排查「深度视差是否真的在跑」
      if (!host.dataset.depthRendered) host.dataset.depthRendered = '1';
    };

    const stopLoop = (): void => {
      running = false;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    };

    const loop = (now: number): void => {
      raf = 0;
      if (disposed || contextLost) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      spring.vx += (SPRING_STIFFNESS * (target.x - spring.x) - SPRING_DAMPING * spring.vx) * dt;
      spring.vy += (SPRING_STIFFNESS * (target.y - spring.y) - SPRING_DAMPING * spring.vy) * dt;
      spring.x += spring.vx * dt;
      spring.y += spring.vy * dt;

      // 快速闭眼、短暂停留，再自然睁开；短暂停留使桌面小尺寸下也能看清。
      let blinkValue = 0;
      if (blink.active) {
        const p = (now - blink.startedAt) / BLINK_DURATION_MS;
        if (p >= 1) {
          blink.active = false;
          blinkCount += 1;
          host.dataset.blinkCount = String(blinkCount);
        } else {
          blinkValue = p < 0.25 ? p / 0.25 : p < 0.55 ? 1 : (1 - p) / 0.45;
        }
      }
      currentBlink = blinkValue;
      renderFrame();

      const still =
        Math.abs(spring.vx) + Math.abs(spring.vy) + Math.abs(target.x - spring.x) + Math.abs(target.y - spring.y) <
        STILL_EPSILON;
      if (still && !blink.active) {
        stopLoop(); // 收敛后停 rAF，等下一次光标/眨眼再唤醒
      } else {
        raf = window.requestAnimationFrame(loop);
      }
    };

    const ensureLoop = (): void => {
      if (disposed || running || !mesh || document.hidden || contextLost) return;
      running = true;
      last = performance.now();
      raf = window.requestAnimationFrame(loop);
    };
    wakeRef.current = ensureLoop;
    const onMotionPreferenceChange = (): void => ensureLoop();
    reducedMotion.addEventListener('change', onMotionPreferenceChange);
    // 静止时约 15fps 更新尾巴，其余动画仍按需使用 rAF。
    const tailTimer = window.setInterval(() => {
      if (!reducedMotion.matches) ensureLoop();
    }, 67);

    // 上下文丢失时恢复静态立绘；拦截 Pixi 7 默认在 handleContextLost 中立即
    // setTimeout(restoreContext, 0) 的行为，避免丢失瞬间又被强行恢复，同时保留
    // preventDefault() 以便系统真实恢复 GPU 时仍能触发 webglcontextrestored。
    const onContextLost = (event: Event): void => {
      if (event.target !== canvas) return;
      event.preventDefault();
      event.stopPropagation();
      contextLost = true;
      delete host.dataset.depthRendered;
      stopLoop();
    };
    const onContextRestored = (): void => { contextLost = false; ensureLoop(); };
    host.addEventListener('webglcontextlost', onContextLost, true);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    const startBlink = (): void => {
      blink.active = true;
      blink.startedAt = performance.now();
      ensureLoop();
    };

    const scheduleBlink = (): void => {
      const delay = sleepyRef.current ? 4200 + Math.random() * 3600 : 1800 + Math.random() * 4200;
      blinkTimer = window.setTimeout(() => {
        if (!document.hidden && mesh) startBlink();
        scheduleBlink();
      }, delay);
    };
    scheduleBlink();

    // 与 App 内全屏追视同一套归一化（中心取窗口宽中部、高 34% 处）
    const updateTarget = (clientX: number, clientY: number): void => {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const centerX = rect.left + rect.width * 0.5;
      const centerY = rect.top + rect.height * 0.34;
      target.x = clamp((clientX - centerX) / Math.max(120, rect.width * 1.35), -1, 1);
      target.y = clamp((clientY - centerY) / Math.max(180, rect.height * 1.2), -1, 1);
      ensureLoop();
    };

    const offCursor = window.petAPI?.onCursorScreen?.(updateTarget);
    // 摸头（或其他 UI）可以派发 pet:depth-blink 让它眨一下眼
    const onBlinkRequest = (): void => startBlink();
    window.addEventListener('pet:depth-blink', onBlinkRequest);
    const onVisibility = (): void => {
      if (document.hidden) {
        stopLoop();
      } else {
        ensureLoop();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // ---- 纹理由 PIXI.Assets 缓存；底图加载失败时保留底层 <img> 兜底 ----
    void Promise.all([
      PIXI.Assets.load<PIXI.Texture>(resolveAssetUrl(colorSrc)),
      PIXI.Assets.load<PIXI.Texture>(resolveAssetUrl(depthSrc)),
      closedEyesSrc
        ? PIXI.Assets.load<PIXI.Texture>(resolveAssetUrl(closedEyesSrc)).catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([color, depth, closedEyes]) => {
        if (disposed || !renderer) return;
        const w = color.width;
        const h = color.height;
        const geometry = new PIXI.Geometry()
          .addAttribute('aVertexPosition', [0, 0, w, 0, w, h, 0, h], 2)
          .addAttribute('aUvs', [0, 0, 1, 0, 1, 1, 0, 1], 2)
          .addIndex([0, 1, 2, 0, 2, 3]);
        const shader = PIXI.Shader.from(VERTEX, FRAGMENT, {
          uColor: color,
          uDepth: depth,
          uClosedEyes: closedEyes ?? color,
          uOffset: [0, 0],
          uFocus: 0.5,
          uLight: [0, 0],
          uBlink: 0,
          uTailSway: 0,
          uEyeL: EYE_LEFT,
          uEyeR: EYE_RIGHT,
        });
        // pixi 7 的类型把 Mesh 材质限定为 MeshMaterial，但运行时接受自定义 Shader；
        // demo 同款写法的类型逃逸只在这一处。
        const m = new PIXI.Mesh(geometry, shader as unknown as PIXI.MeshMaterial);
        // 立绘 1024×1536 等比缩到 330 宽（高 ≈495），底部裁 5px，与 CSS
        // object-fit: cover; object-position: center top 的显示范围一致。
        const scale = width / w;
        m.scale.set(scale, scale);
        m.position.set(0, 0);
        stage.addChild(m);
        mesh = m;
        host.dataset.depthReady = '1';
        renderFrame();
        ensureLoop();
      })
      .catch(() => {
        // 深度图/立绘加载失败：不渲染，底层 <img> 仍然可用
      });

    return () => {
      disposed = true;
      wakeRef.current = () => {};
      delete host.dataset.depthRendered;
      delete host.dataset.depthReady;
      document.removeEventListener('visibilitychange', onVisibility);
      reducedMotion.removeEventListener('change', onMotionPreferenceChange);
      host.removeEventListener('webglcontextlost', onContextLost, true);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      window.removeEventListener('pet:depth-blink', onBlinkRequest);
      if (typeof offCursor === 'function') offCursor();
      stopLoop();
      if (blinkTimer) window.clearTimeout(blinkTimer);
      window.clearInterval(tailTimer);
      if (mesh) mesh = null;
      // 纹理留在 PIXI.Assets 缓存里（避免重建时黑屏），只销毁自有 stage / renderer
      try {
        stage.destroy({ children: true });
      } catch {
        /* ignore */
      }
      if (renderer) {
        try {
          renderer.destroy(true);
        } catch {
          /* ignore */
        }
      }
      if (canvas.parentNode === host) host.removeChild(canvas);
    };
  }, [colorSrc, depthSrc, closedEyesSrc, width, height]);

  return <div ref={hostRef} className={className} aria-hidden="true" />;
}
