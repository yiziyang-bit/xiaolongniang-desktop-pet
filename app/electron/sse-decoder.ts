import { StringDecoder } from 'node:string_decoder';

/** 单轮流式解析产物 */
export interface TurnChunk {
  kind: 'answer' | 'thinking';
  text: string;
}

/** 流式累积的 tool_call 增量(按 index 聚合) */
export interface ToolCallAccum {
  id: string;
  name: string;
  argsBuffer: string;
}

/**
 * SSE 解析。支持字段:
 *   - delta.content           普通回答
 *   - delta.reasoning_content 推理模型思考过程
 *   - delta.tool_calls[]      工具调用增量(按 index 聚合到 outer accum)
 *   - choices[0].finish_reason 可能是 'stop' / 'tool_calls' / 'length' 等
 */
export function parseSseChunk(
  text: string,
  toolAccums: Map<number, ToolCallAccum>,
): {
  chunks: TurnChunk[];
  done: boolean;
  finishReason: string | null;
  rest: string;
} {
  const chunks: TurnChunk[] = [];
  let done = false;
  let finishReason: string | null = null;
  const lines = text.split(/\r?\n/);
  const completeLines = lines.slice(0, -1);
  const rest = lines[lines.length - 1] ?? '';
  for (const line of completeLines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    try {
      const obj = JSON.parse(payload);
      const choice = obj?.choices?.[0];
      const delta = choice?.delta;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (delta) {
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          chunks.push({ kind: 'answer', text: delta.content });
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          chunks.push({ kind: 'thinking', text: delta.reasoning_content });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (Array.isArray(delta.tool_calls)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const tc of delta.tool_calls as any[]) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            let cur = toolAccums.get(idx);
            if (!cur) {
              cur = { id: '', name: '', argsBuffer: '' };
              toolAccums.set(idx, cur);
            }
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') {
              cur.argsBuffer += tc.function.arguments;
            }
          }
        }
      }
    } catch {
      // ignore malformed
    }
  }
  return { chunks, done, finishReason, rest };
}

/**
 * 增量解码 UTF-8 Buffer 流并解析 SSE 行，避免中文/Emoji 在分片边界被截断成乱码，
 * 并在结束时刷新未带末尾换行符的最后一行数据。
 */
export function createSseStreamDecoder(toolAccums: Map<number, ToolCallAccum>) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return {
    push(chunk: Buffer): { chunks: TurnChunk[]; done: boolean; finishReason: string | null } {
      buffer += decoder.write(chunk);
      const parsed = parseSseChunk(buffer, toolAccums);
      buffer = parsed.rest;
      return { chunks: parsed.chunks, done: parsed.done, finishReason: parsed.finishReason };
    },
    flush(): { chunks: TurnChunk[]; done: boolean; finishReason: string | null } {
      buffer += decoder.end();
      if (!buffer.trim()) {
        buffer = '';
        return { chunks: [], done: false, finishReason: null };
      }
      const parsed = parseSseChunk(buffer + '\n', toolAccums);
      buffer = '';
      return { chunks: parsed.chunks, done: parsed.done, finishReason: parsed.finishReason };
    },
  };
}
