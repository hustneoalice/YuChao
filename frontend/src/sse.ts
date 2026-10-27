/* SSE 事件流：EventSource ?token= 鉴权；seq 跳号检测 → 调用方回退 REST 重拉 */
import { getToken } from "./api";

export interface SseEvent {
  channel: string;
  seq: number;
  event: string;
  data: Record<string, unknown>;
}

type Handler = (ev: SseEvent) => void;

/** id 形如 `kline:600519:1d#42` */
function parseId(id: string): { channel: string; seq: number } {
  const i = id.lastIndexOf("#");
  if (i < 0) return { channel: id, seq: 0 };
  return { channel: id.slice(0, i), seq: Number(id.slice(i + 1)) || 0 };
}

export class SseClient {
  private es: EventSource | null = null;
  private handlers = new Set<Handler>();
  private lastSeq = new Map<string, number>();
  private wanted: string[];
  private onGap: ((channel: string) => void) | null;
  private reconnectTimer: number | null = null;

  constructor(channels: string[] = ["data:update"], onGap?: (channel: string) => void) {
    this.wanted = channels;
    this.onGap = onGap ?? null;
  }

  on(fn: Handler): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  start(): void {
    if (this.es) return;
    const params = new URLSearchParams({ channels: this.wanted.join(",") });
    const token = getToken();
    if (token) params.set("token", token);
    const es = new EventSource(`/api/v1/stream/sse?${params}`);
    this.es = es;
    es.onopen = () => { /* 建连后事件自然流入 */ };
    es.onmessage = (e) => this.dispatch(e.lastEventId, "message", e.data);
    // 后端用自定义 event 名（kline.update 等）——EventSource 只给具名事件 on<name>，
    // 这里挂通用兜底：用 addEventListener("*") 不支持，改为监听已知事件名集合由调用方补；
    // 简化：后端事件名有限，逐个透传。
    for (const name of ["data.update", "kline.update", "corepicks.daily", "license.changed", "message"]) {
      es.addEventListener(name, (e) =>
        this.dispatch((e as MessageEvent).lastEventId, name, (e as MessageEvent).data));
    }
    es.onerror = () => {
      es.close();
      this.es = null;
      if (this.reconnectTimer == null) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.start();
        }, 5000);
      }
    };
  }

  private dispatch(lastEventId: string, eventName: string, raw: string): void {
    const { channel, seq } = parseId(lastEventId || "");
    // seq 跳号检测（频道内单调）→ 回退 REST
    const prev = this.lastSeq.get(channel);
    if (prev != null && seq > prev + 1) this.onGap?.(channel);
    if (seq > (prev ?? 0)) this.lastSeq.set(channel, seq);
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(raw); } catch { /* 空 data */ }
    const ev: SseEvent = { channel, seq, event: eventName === "message" ? "message" : eventName, data };
    this.handlers.forEach((h) => h(ev));
  }

  stop(): void {
    if (this.reconnectTimer != null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.es?.close();
    this.es = null;
  }
}
