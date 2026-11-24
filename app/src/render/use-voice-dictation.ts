import { useEffect, useRef } from 'react';
import { type KaldiRecognizer } from 'vosk-browser';
import {
  createRecognizer,
  pickPhysicalMicDeviceId,
  buildMicConstraints,
  createSpeechAudioContext,
  scheduleVoskModelRelease,
  voiceDebugLog,
} from './vosk-shared';
import { computeRms, encodeMonoWav16 } from '../../shared/asr-templates';

/**
 * 语音听写 hook —— 支持两种识别后端：
 *   1. 本地离线模式（默认 `local`）：使用 vosk 模型实时流式转文字
 *   2. API 接口模式（`speechAsr.mode === 'api'`）：采集 16kHz 单声道音频，检测到说话并停顿后编码 WAV 调用 OpenAI 兼容 `/audio/transcriptions` 接口
 */

interface Args {
  enabled: boolean;
  /** 实时(流式)识别结果或状态提示。空字符串表示重置。 */
  onPartial?: (text: string) => void;
  /** 一段语音结束并识别完成时的最终文本。 */
  onFinal?: (text: string) => void;
  /** mic 拒绝 / 模型加载失败 / API 调用报错 */
  onError?: (msg: string) => void;
}

export function useVoiceDictation({ enabled, onPartial, onFinal, onError }: Args): void {
  const onPartialRef = useRef(onPartial);
  const onFinalRef = useRef(onFinal);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onPartialRef.current = onPartial;
    onFinalRef.current = onFinal;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let useApiMode = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let processorNode: ScriptProcessorNode | null = null;
    let recognizer: KaldiRecognizer | null = null;
    let inFlightAsrReqId: string | null = null;

    const log = (...args: unknown[]) => {
      voiceDebugLog('[voice-dictation]', ...args);
    };

    const cleanupAudioGraph = () => {
      try {
        processorNode?.disconnect();
        if (processorNode) processorNode.onaudioprocess = null;
      } catch {
        // ignore
      }
      try {
        sourceNode?.disconnect();
      } catch {
        // ignore
      }
      try {
        void audioCtx?.close();
      } catch {
        // ignore
      }
      stream?.getTracks().forEach((t) => t.stop());
      processorNode = null;
      sourceNode = null;
      audioCtx = null;
      stream = null;
    };

    (async () => {
      const cfg = await window.petAPI?.getConfig?.();
      if (cancelled) return;
      useApiMode = cfg?.speechAsr?.mode === 'api';

      if (useApiMode) {
        const effBase = (cfg?.speechAsr?.baseURL || cfg?.baseURL || '').trim();
        const effModel = (cfg?.speechAsr?.model || '').trim();
        if (!effBase) {
          onErrorRef.current?.('请先在「设置 → 语音输入 → 语音识别模型」中填写 API 地址并保存。');
          return;
        }
        if (!effModel) {
          onErrorRef.current?.('请先在「设置 → 语音输入 → 语音识别模型」中填写语音识别模型名称并保存。');
          return;
        }
      }

      const deviceId = await pickPhysicalMicDeviceId();
      try {
        stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(deviceId));
      } catch (e) {
        log('mic denied:', e);
        onErrorRef.current?.(`麦克风获取失败: ${(e as Error)?.message ?? e}`);
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
        return;
      }

      audioCtx = createSpeechAudioContext();
      sourceNode = audioCtx.createMediaStreamSource(stream);

      if (useApiMode) {
        const sampleRate = audioCtx.sampleRate || 16000;
        let noiseFloor = 0.006;
        let speaking = false;
        let preRoll: Float32Array[] = [];
        let speechChunks: Float32Array[] = [];
        let speechMs = 0;
        let silenceMs = 0;
        let transcribing = false;

        processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
        processorNode.onaudioprocess = (event) => {
          if (cancelled || transcribing) return;
          const raw = event.inputBuffer.getChannelData(0);
          const frame = new Float32Array(raw.length);
          frame.set(raw);
          const rms = computeRms(frame);
          const frameMs = (frame.length / sampleRate) * 1000;

          if (!speaking) {
            noiseFloor = Math.max(0.002, Math.min(0.035, noiseFloor * 0.92 + rms * 0.08));
            preRoll.push(frame);
            if (preRoll.length > 2) preRoll.shift();

            const startThreshold = Math.max(0.013, noiseFloor * 2.5);
            if (rms >= startThreshold) {
              speaking = true;
              speechChunks = [...preRoll, frame];
              preRoll = [];
              speechMs = frameMs;
              silenceMs = 0;
              onPartialRef.current?.('（正在聆听…）');
            }
            return;
          }

          speechChunks.push(frame);
          speechMs += frameMs;
          const stopThreshold = Math.max(0.009, noiseFloor * 1.8);
          if (rms < stopThreshold) {
            silenceMs += frameMs;
          } else {
            silenceMs = 0;
          }

          const shouldFlush = (speechMs >= 300 && silenceMs >= 950) || speechMs >= 28_000;
          if (!shouldFlush) return;

          const captured = speechChunks;
          const voicedMs = speechMs - silenceMs;
          speaking = false;
          speechChunks = [];
          speechMs = 0;
          silenceMs = 0;

          if (voicedMs < 180) {
            onPartialRef.current?.('');
            return;
          }

          transcribing = true;
          const reqId = `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          inFlightAsrReqId = reqId;
          onPartialRef.current?.('（正在识别语音…）');

          const wav = encodeMonoWav16(captured, sampleRate, 16000);
          const wavAb = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;

          void window.petAPI
            ?.asrTranscribe?.(wavAb, reqId)
            .then((res) => {
              if (cancelled) return;
              if (inFlightAsrReqId === reqId) inFlightAsrReqId = null;
              transcribing = false;
              onPartialRef.current?.('');
              const cleaned = (res?.text ?? '').trim();
              if (cleaned) {
                log('api final:', cleaned);
                onFinalRef.current?.(cleaned);
              }
            })
            .catch((err) => {
              if (cancelled) return;
              if (inFlightAsrReqId === reqId) inFlightAsrReqId = null;
              transcribing = false;
              onPartialRef.current?.('');
              const msg = (err as Error)?.message ?? String(err);
              if (/取消|AbortError/i.test(msg)) return;
              onErrorRef.current?.(msg);
            });
        };

        sourceNode.connect(processorNode);
        const mute = audioCtx.createGain();
        mute.gain.value = 0;
        processorNode.connect(mute);
        mute.connect(audioCtx.destination);
        log('started (api mode)');
        return;
      }

      // ===== 本地 Vosk 模式 =====
      try {
        const r = await createRecognizer(audioCtx.sampleRate);
        recognizer = r.recognizer;
      } catch (e) {
        log('createRecognizer failed:', e);
        onErrorRef.current?.(`模型加载失败: ${(e as Error)?.message ?? e}`);
        cleanupAudioGraph();
        return;
      }
      if (cancelled) {
        try {
          recognizer.remove?.();
        } catch {
          // ignore
        }
        recognizer = null;
        return;
      }
      recognizer.setWords?.(false);

      recognizer.on('result', (msg) => {
        const r = (msg as { result?: { text?: string } }).result;
        const text = (r?.text ?? '').replace(/\s+/g, '');
        if (text) {
          log('final:', text);
          onFinalRef.current?.(text);
        }
      });
      recognizer.on('partialresult', (msg) => {
        const r = (msg as { result?: { partial?: string } }).result;
        const text = (r?.partial ?? '').replace(/\s+/g, '');
        onPartialRef.current?.(text);
      });

      processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
      processorNode.onaudioprocess = (event) => {
        if (!recognizer) return;
        try {
          recognizer.acceptWaveform(event.inputBuffer);
        } catch (err) {
          log('acceptWaveform err:', err);
        }
      };
      sourceNode.connect(processorNode);
      const mute = audioCtx.createGain();
      mute.gain.value = 0;
      processorNode.connect(mute);
      mute.connect(audioCtx.destination);

      log('started (vosk mode)');
    })();

    return () => {
      cancelled = true;
      cleanupAudioGraph();
      if (inFlightAsrReqId) {
        void window.petAPI?.asrCancel?.(inFlightAsrReqId).catch(() => {});
        inFlightAsrReqId = null;
      }
      if (recognizer) {
        try {
          recognizer.remove?.();
        } catch {
          // ignore
        }
        recognizer = null;
      }
      if (!useApiMode) {
        scheduleVoskModelRelease();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
