/* 可复用图表面板 —— 行情页（单/多面板）与全景右下角共用同一个控件。
 * 结构：头部信息条（密度可配）+ 指标控制条（主图/副图开关）+ K 线本体。
 * 行情页多面板共享一条信息条 → 面板用 head:"none"；全景用 title + 指标开关的紧凑配置。 */
import type { Bar } from "./api";
import { esc, fmt, fmtP } from "./fmt";
import { ic } from "./icons";
import { IND_BY_KEY, mountKline, type KlineChartHandle, type MainKey, type SubKey } from "./pages/kline";

export type ChartPeriod = "t" | "60" | "120" | "d" | "w" | "m" | "q";

/** 头部信息（行情页全量 / 全景紧凑只用 name/code/price/pct） */
export interface ChartInfo {
  name?: string | null;
  code?: string | null;
  industry?: string | null;
  price?: number | null;
  pct?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prevClose?: number | null;
}

export type ChartHeadMode = "none" | "compact" | "full";

/** 指标控制条：传哪些键就渲染哪些开关（空数组 = 不渲染该组） */
export interface ChartToolbar {
  main?: MainKey[];
  sub?: SubKey[];
}

export interface ChartPanelOptions {
  /** 头部信息条：none 不渲染 / compact 名称代码+现价涨跌 / full 再加行业与开高低昨收 */
  head?: ChartHeadMode;
  /** 控制条左侧标题（如「日K」）；不传则只渲染指标开关 */
  title?: string;
  toolbar?: ChartToolbar;
  initial?: { period?: ChartPeriod; main?: MainKey[]; sub?: SubKey[] };
  /** 空态文案；不传则不显示空态浮层 */
  emptyText?: string;
  onIndicators?: (state: { main: MainKey[]; sub: SubKey[] }) => void;
}

export interface ChartPanelHandle {
  chart: KlineChartHandle;
  setInfo: (info: ChartInfo | null) => void;
  setPeriod: (p: ChartPeriod) => void;
  setMain: (inds: MainKey[]) => void;
  setSub: (inds: SubKey[]) => void;
  setData: (bars: Bar[], keepView?: boolean, floatShares?: number | null, focusDate?: string, symbol?: string) => void;
  drawLegend: (inds?: MainKey[]) => void;
  resize: () => void;
  applyHeights: () => void;
  destroy: () => void;
  period: () => ChartPeriod;
  main: () => MainKey[];
  sub: () => SubKey[];
}

/** 控制条短标签（IND_DEFS 的 label 太长，小面板放不下） */
const SHORT_LABEL: Record<string, string> = {
  ma: "MA", boll: "BOLL", mid: "中线", short: "短线",
  vol: "VOL", trendhistogram: "趋势柱线", macd: "MACD", kdj: "KDJ",
};

const labelOf = (k: string): string => SHORT_LABEL[k] ?? IND_BY_KEY[k]?.label ?? k;

const num = (v?: number | null, symbol?: string | null): string =>
  (v == null || !isFinite(v) ? "—" : fmtP(v, symbol));

/** 信息条 HTML：行情页共享条与面板头部共用同一套渲染，密度只由 mode 决定。
 *  quickAsk=true 时在「昨收」后挂一个快速问股机器人入口（行情页头部用）。 */
export function quoteHeadHtml(info: ChartInfo | null, mode: Exclude<ChartHeadMode, "none"> = "full",
                               quickAsk = false): string {
  if (!info) return "";
  const pct = info.pct;
  const cls = (pct ?? 0) >= 0 ? "up" : "down";
  const code = (info.code ?? "").replace(/\./g, "·");
  const parts: string[] = [
    `<b class="ksy-name">${esc(info.name || info.code || "—")}</b>`,
    `<span class="ksy-code num">${esc(code)}</span>`,
  ];
  if (mode === "full" && info.industry) parts.push(`<span class="ksy-ind">${esc(info.industry)}</span>`);
  let q = "";
  if (info.price != null) {
    q += `<b class="${cls}">${num(info.price, info.code)}</b>`;
    if (pct != null) q += `<span class="${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>`;
  }
  if (mode === "full") {
    const pc = info.prevClose;
    q += `<span class="dim">开 <b class="${(info.open ?? 0) >= (pc ?? 0) ? "up" : "down"}">${num(info.open, info.code)}</b></span>` +
      `<span class="dim">高 <b class="up">${num(info.high, info.code)}</b></span>` +
      `<span class="dim">低 <b class="down">${num(info.low, info.code)}</b></span>` +
      (pc == null ? "" : `<span class="dim">昨收 <b class="num">${num(pc, info.code)}</b></span>`);
  }
  parts.push(`<span class="ksy-q">${q}</span>`);
  if (quickAsk) {
    parts.push(`<button class="qa-inline" type="button" title="AI 问股" aria-label="AI 问股" aria-expanded="false">${ic("ai-sparkle", 14)}</button>`);
  }
  return parts.join("");
}

/**
 * 在 host 内创建一块图表面板（head / toolbar 都可由 options 关掉）。
 * host 须为可拉伸容器（flex:1 或固定高）；K 线本体只能有一个实例。
 */
export function createChartPanel(host: HTMLElement, opts: ChartPanelOptions = {}): ChartPanelHandle {
  host.classList.add("cp-root");
  const headMode = opts.head ?? "none";

  /* ── 头部信息条 ── */
  let headEl: HTMLElement | null = null;
  if (headMode !== "none") {
    headEl = document.createElement("div");
    headEl.className = "kl-symbar cp-head";
    headEl.hidden = true;
    host.appendChild(headEl);
  }

  /* ── 控制条：标题 + 主图/副图指标开关 ── */
  const mainOpts = opts.toolbar?.main ?? [];
  const subOpts = opts.toolbar?.sub ?? [];
  const hasBar = !!opts.title || mainOpts.length > 0 || subOpts.length > 0;
  const barEl = document.createElement("div");
  barEl.className = "cp-bar";
  if (!hasBar) barEl.hidden = true;
  if (opts.title) {
    const t = document.createElement("b");
    t.className = "cp-title";
    t.textContent = opts.title;
    barEl.appendChild(t);
  }
  const mainSet = new Set<MainKey>(opts.initial?.main ?? []);
  const subSet = new Set<SubKey>(opts.initial?.sub ?? []);

  const group = (label: string, kind: "main" | "sub", keys: (MainKey | SubKey)[]): HTMLElement => {
    const wrap = document.createElement("span");
    wrap.className = "cp-grp";
    const k = document.createElement("span");
    k.className = "cp-k";
    k.textContent = label;
    wrap.appendChild(k);
    const seg = document.createElement("span");
    seg.className = "seg cp-seg";
    for (const key of keys) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset[kind] = key;
      b.textContent = labelOf(key);
      seg.appendChild(b);
    }
    wrap.appendChild(seg);
    return wrap;
  };
  if (mainOpts.length) barEl.appendChild(group("主图", "main", mainOpts));
  if (mainOpts.length && subOpts.length) {
    // 主图 / 副图 之间的竖分割线（小面板一行放不下时才换行滚动）
    const d = document.createElement("span");
    d.className = "cp-div";
    barEl.appendChild(d);
  }
  if (subOpts.length) barEl.appendChild(group("副图", "sub", subOpts));
  host.appendChild(barEl);

  /* ── K 线本体 ── */
  const body = document.createElement("div");
  body.className = "klp-main cp-body";
  host.appendChild(body);
  const chart = mountKline(body);

  let emptyEl: HTMLElement | null = null;
  if (opts.emptyText) {
    emptyEl = document.createElement("div");
    emptyEl.className = "cp-empty";
    emptyEl.textContent = opts.emptyText;
    body.appendChild(emptyEl);
  }

  let period: ChartPeriod = opts.initial?.period ?? "d";

  const syncChips = (): void => {
    barEl.querySelectorAll<HTMLElement>("button[data-main]").forEach((b) =>
      b.classList.toggle("on", mainSet.has(b.dataset.main!)));
    barEl.querySelectorAll<HTMLElement>("button[data-sub]").forEach((b) =>
      b.classList.toggle("on", subSet.has(b.dataset.sub!)));
  };

  const applyMain = (inds: MainKey[]): void => {
    mainSet.clear();
    inds.forEach((k) => mainSet.add(k));
    chart.setMain(inds);
    chart.drawLegend(inds);
    syncChips();
  };
  const applySub = (inds: SubKey[]): void => {
    subSet.clear();
    inds.forEach((k) => subSet.add(k));
    chart.setSub(inds);
    syncChips();
  };

  barEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-main],button[data-sub]");
    if (!b) return;
    if (b.dataset.main) {
      const k = b.dataset.main;
      mainSet.has(k) ? mainSet.delete(k) : mainSet.add(k);
      applyMain([...mainSet]);
      opts.onIndicators?.({ main: [...mainSet], sub: [...subSet] });
    } else if (b.dataset.sub) {
      const k = b.dataset.sub;
      subSet.has(k) ? subSet.delete(k) : subSet.add(k);
      applySub([...subSet]);
      opts.onIndicators?.({ main: [...mainSet], sub: [...subSet] });
    }
  });

  chart.setPeriod(period);
  if (mainSet.size) chart.setMain([...mainSet]);
  chart.drawLegend([...mainSet]);
  if (subSet.size) chart.setSub([...subSet]);
  syncChips();

  const toggleEmpty = (empty: boolean): void => {
    if (emptyEl) emptyEl.hidden = !empty;
  };
  toggleEmpty(true);

  const handle: ChartPanelHandle = {
    chart,
    setInfo(info) {
      if (!headEl) return;
      headEl.hidden = !info;
      headEl.innerHTML = info ? quoteHeadHtml(info, headMode as Exclude<ChartHeadMode, "none">) : "";
    },
    setPeriod(p) {
      period = p;
      chart.setPeriod(p);
    },
    setMain(inds) { applyMain(inds); },
    setSub(inds) { applySub(inds); },
    setData(bars, keepView = false, floatShares = null, focusDate, symbol) {
      toggleEmpty(bars.length === 0);
      chart.setData(bars, keepView, floatShares, focusDate, symbol);
    },
    drawLegend(inds) { chart.drawLegend(inds ?? [...mainSet]); },
    resize() { chart.resize(); },
    applyHeights() { chart.applyHeights(); },
    destroy() {
      chart.destroy();
      host.innerHTML = "";
      host.classList.remove("cp-root");
    },
    period: () => period,
    main: () => [...mainSet],
    sub: () => [...subSet],
  };
  return handle;
}
