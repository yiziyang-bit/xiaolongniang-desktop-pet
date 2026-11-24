export interface SpeechSettings {
  /** 首选语音引擎。默认使用 Windows 语音。 */
  engine?: 'clone' | 'windows';
  /** F5-TTS 设备。CUDA 需要自备兼容环境。 */
  cloneDevice?: 'cpu' | 'cuda' | 'auto';
  cloneRoot?: string;
  cloneReferenceText?: string;
  voiceName?: string;
  rate?: number;
  volume?: number;
  expressive?: boolean;
}
export interface LocalVoice { name: string; language: string; gender: string; }
export interface SpeechState { state: 'preparing' | 'speaking' | 'idle' | 'error'; remaining: number; voiceName?: string; error?: string; }
export interface SpeechSegment { text: string; rate: number; volume: number; pauseMs: number; }
export function normalizeSpeechSettings(value?: SpeechSettings | null): Required<SpeechSettings> {
  const rate = Number(value?.rate);
  const volume = Number(value?.volume);
  const engine = value?.engine === 'clone' ? 'clone' : 'windows';
  const cloneDevice = value?.cloneDevice === 'cuda' || value?.cloneDevice === 'auto' ? value.cloneDevice : 'cpu';
  return {
    engine,
    cloneDevice,
    cloneRoot: typeof value?.cloneRoot === 'string' ? value.cloneRoot.trim() : '',
    cloneReferenceText: typeof value?.cloneReferenceText === 'string' ? value.cloneReferenceText.trim().slice(0, 1000) : '',
    voiceName: typeof value?.voiceName === 'string' ? value.voiceName.slice(0, 200) : '',
    rate: Number.isFinite(rate) ? Math.max(-4, Math.min(4, Math.round(rate))) : -1,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, Math.round(volume))) : 90,
    expressive: value?.expressive !== false,
  };
}
export function cleanSpeechText(raw:string):string { return String(raw??'').slice(0,30000).replace(/```[\s\S]*?(?:```|$)/g,'\n代码请看聊天窗口。\n').replace(/~~~[\s\S]*?(?:~~~|$)/g,'\n代码请看聊天窗口。\n').replace(/`[^`]*`/g,'').replace(/~[^~]*~/g,'').replace(/\[emotion:\s*[\w\u4e00-\u9fa5-]+\]/gi,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/https?:\/\/\S+/gi,'').replace(/<[^>]+>/g,'').replace(/^\s*\|.*\|\s*$/gm,'').replace(/^\s*[-*_](?:\s*[-*_]){2,}\s*$/gm,'').replace(/^\s{0,3}(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/gm,'').replace(/^\s*>\s?/gm,'').replace(/^\s*(?:轻声|微笑|害羞|开心|摸头)[：:]?[^\n]{0,20}\s*/gim,'').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu,'').replace(/[\`*_~]/g,'').replace(/[ \t]{2,}/g,' ').replace(/\n{2,}/g,'\n').trim(); }
function splitLongSentence(sentence:string):string[]{const chars=Array.from(sentence);if(chars.length<=110)return[sentence];const result:string[]=[];let start=0;while(start<chars.length){const end=Math.min(start+110,chars.length);let cut=end;if(end<chars.length)for(let i=end-1;i>=start+35;i-=1)if('，、,；;：: '.includes(chars[i])){cut=i+1;break;}const part=chars.slice(start,cut).join('').trim();if(part)result.push(part);start=cut;}return result;}
export function prepareSpeech(raw:string,settings?:SpeechSettings):SpeechSegment[]{const cfg=normalizeSpeechSettings(settings);const cleaned=cleanSpeechText(raw);if(!cleaned)return[];const limited=cleaned.length>2600?`${cleaned.slice(0,2500)}。后面的内容请看聊天窗口。`:cleaned;const sentences=limited.split(/(?<=[。！？!?；;])\s*|(?<=[.!?])(?=\s|$)|\n+/u).flatMap(s=>splitLongSentence(s.trim())).filter(s=>/[\p{L}\p{N}\u3400-\u9fff]/u.test(s));const soft=/\[emotion:\s*(?:sad|soft)\]|别担心|慢慢来|辛苦|休息|陪着/iu.test(raw);const bright=/\[emotion:\s*(?:happy|surprised)\]|太好|开心|好耶|太棒/iu.test(raw);return sentences.map(text=>({text,rate:Math.max(-4,Math.min(4,cfg.rate+(cfg.expressive?(soft?-1:bright?1:0):0))),volume:Math.max(0,Math.min(100,cfg.volume+(cfg.expressive&&soft?-6:0))),pauseMs:soft?260:150}));}


