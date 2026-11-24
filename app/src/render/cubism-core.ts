const CORE_URL = 'pet://cubism-core/live2dcubismcore.min.js';
const CORE_HELP = '需要 Live2D Cubism Core。请在角色菜单打开资源目录，放入官方 SDK 的 live2dcubismcore.min.js 后重新选择角色。';

let pending: Promise<void> | undefined;

function coreIsLoaded(): boolean {
  return Boolean((window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore);
}

export function loadCubismCore(): Promise<void> {
  if (coreIsLoaded()) return Promise.resolve();

  pending ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => {
      script.remove();
      reject(new Error(CORE_HELP));
    };
    script.src = CORE_URL;
    script.onload = () => {
      if (coreIsLoaded()) resolve();
      else fail();
    };
    script.onerror = fail;
    document.head.append(script);
  }).finally(() => {
    pending = undefined;
  });

  return pending;
}
