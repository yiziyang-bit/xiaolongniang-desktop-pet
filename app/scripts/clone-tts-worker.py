"""本地 F5-TTS 克隆声 worker。

桌宠主进程通过 stdin/stdout 发送 JSON 行:
  {"type":"synthesize","id":"...","text":"...","outputPath":"...",...
   "speed":1.0,"volume":90}

模型只在 worker 启动时载入一次;音频文件由主进程播放,因此主进程可以在
下一轮对话开始时停止播放而不必重新载入模型。worker 只使用本地路径。
"""

from __future__ import annotations

import contextlib
import importlib.resources as importlib_resources
import importlib.util
import io
import json
import os
import sys
import traceback
import types
from pathlib import Path


def emit(kind: str, **payload: object) -> None:
    message = {"type": kind, **payload}
    print(json.dumps(message, ensure_ascii=False, separators=(",", ":")), flush=True)


def fail(code: str, error: BaseException | str) -> None:
    message = str(error)
    emit("error", code=code, message=message[:500])


def install_f5_namespace(site_packages: Path) -> None:
    """让 F5-TTS 作为可配置路径的 namespace package 使用。

    已安装的 f5_tts.model.__init__ 会一次性导入 Trainer 等重依赖;这里只
    注入一个延迟导入的 model namespace,等 API 真正需要时再载入 CFM/DiT。
    """

    installed = site_packages / "f5_tts"
    if not installed.is_dir():
        raise FileNotFoundError(f"找不到 F5-TTS 包: {installed}")

    # Namespace package 没有物理 __init__.py 时,importlib.resources 会返回
    # CompatibilityFiles/OrphanPath,而 F5-TTS 的配置加载需要真实目录。
    original_files = importlib_resources.files

    def resource_files(anchor):
        name = anchor if isinstance(anchor, str) else getattr(anchor, "__name__", "")
        if name == "f5_tts":
            return installed
        return original_files(anchor)

    importlib_resources.files = resource_files  # type: ignore[assignment]

    package = types.ModuleType("f5_tts")
    package.__path__ = [str(installed)]
    package.__package__ = "f5_tts"
    package.__spec__ = importlib.util.spec_from_loader("f5_tts", loader=None, is_package=True)
    if package.__spec__ is not None:
        package.__spec__.submodule_search_locations = [str(installed)]
    sys.modules["f5_tts"] = package

    model_dir = installed / "model"
    model = types.ModuleType("f5_tts.model")
    model.__path__ = [str(model_dir)]
    model.__package__ = "f5_tts.model"
    model.__spec__ = importlib.util.spec_from_loader("f5_tts.model", loader=None, is_package=True)
    if model.__spec__ is not None:
        model.__spec__.submodule_search_locations = [str(model_dir)]

    def lazy_getattr(name: str):
        if name == "CFM":
            from f5_tts.model.cfm import CFM

            return CFM
        if name == "DiT":
            from f5_tts.model.backbones.dit import DiT

            return DiT
        if name == "MMDiT":
            from f5_tts.model.backbones.mmdit import MMDiT

            return MMDiT
        if name == "UNetT":
            from f5_tts.model.backbones.unett import UNetT

            return UNetT
        raise AttributeError(name)

    model.__getattr__ = lazy_getattr  # type: ignore[attr-defined]
    sys.modules["f5_tts.model"] = model


def bootstrap() -> tuple[object, Path, str, str]:
    cpu_packages = Path(os.environ["CLONE_TTS_CPU_PACKAGES"]).expanduser().resolve()
    site_packages = Path(os.environ["CLONE_TTS_SITE_PACKAGES"]).expanduser().resolve()
    model_path = Path(os.environ["CLONE_TTS_MODEL"]).expanduser().resolve()
    vocoder_path = Path(os.environ["CLONE_TTS_VOCODER"]).expanduser().resolve()
    reference_path = Path(os.environ["CLONE_TTS_REFERENCE"]).expanduser().resolve()
    reference_text = os.environ["CLONE_TTS_REFERENCE_TEXT"]
    device = os.environ.get("CLONE_TTS_DEVICE", "cpu")

    for required in (cpu_packages, site_packages, model_path, vocoder_path, reference_path):
        if not required.exists():
            raise FileNotFoundError(f"本地克隆语音资源不存在: {required}")

    sys.path.insert(0, str(cpu_packages))
    sys.path.insert(1, str(site_packages))

    # 推理路径不需要 ASR,禁掉 transformers 的大型 pipeline 导入。
    transformers_stub = types.ModuleType("transformers")
    transformers_stub.pipeline = lambda *args, **kwargs: (_ for _ in ()).throw(
        RuntimeError("ASR pipeline is disabled for desktop-pet clone TTS")
    )
    sys.modules["transformers"] = transformers_stub
    librosa_filters_stub = types.ModuleType("librosa.filters")
    librosa_filters_stub.mel = lambda *args, **kwargs: None
    sys.modules["librosa.filters"] = librosa_filters_stub

    install_f5_namespace(site_packages)

    from f5_tts.api import F5TTS

    # 只把模型载入一次。F5TTS 的初始化日志被吞掉,保证 stdout 只传 JSON。
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        tts = F5TTS(
            model="F5TTS_v1_Base",
            ckpt_file=str(model_path),
            vocoder_local_path=str(vocoder_path),
            device=device,
        )
    return tts, reference_path, reference_text, device


def main() -> int:
    try:
        tts, reference_path, reference_text, _device = bootstrap()
    except Exception as error:  # pragma: no cover - depends on local model files
        fail("CLONE_INIT_FAILED", error)
        return 1

    emit("ready")
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            request = json.loads(raw)
        except json.JSONDecodeError as error:
            fail("BAD_REQUEST", error)
            continue
        if request.get("type") == "stop":
            return 0
        if request.get("type") != "synthesize":
            fail("BAD_REQUEST", "未知请求类型")
            continue

        request_id = str(request.get("id", ""))
        text = str(request.get("text", "")).strip()
        raw_output_path = str(request.get("outputPath", "")).strip()
        if not request_id or not text or not raw_output_path:
            fail("BAD_REQUEST", "缺少 id、text 或 outputPath")
            continue
        output_path = Path(raw_output_path).expanduser()
        try:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            speed = float(request.get("speed", 1.0))
            speed = max(0.75, min(1.35, speed))
            volume = float(request.get("volume", 90)) / 100.0
            volume = max(0.0, min(1.0, volume))
            nfe_step = int(request.get("nfeStep", 16))
            nfe_step = max(8, min(32, nfe_step))

            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                wav, sample_rate, _spec = tts.infer(
                    ref_file=str(reference_path),
                    ref_text=reference_text,
                    gen_text=text,
                    nfe_step=nfe_step,
                    speed=speed,
                    remove_silence=False,
                    file_wave=None,
                    show_info=lambda *_args, **_kwargs: None,
                )
                if volume < 0.999:
                    import numpy as np

                    wav = np.clip(wav * volume, -1.0, 1.0)
                import soundfile as sf

                sf.write(str(output_path), wav, sample_rate)
            emit("audio", id=request_id, path=str(output_path))
        except Exception as error:  # pragma: no cover - depends on model/runtime
            traceback.print_exc(file=sys.stderr)
            fail("CLONE_INFER_FAILED", error)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

