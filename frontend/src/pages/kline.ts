/* K线图表 —— klinecharts 10，配置 1:1 对齐策影 1.0（strategy-lens）
 *  · candle_up_stroke 阳线空心 · 涨 #EF5350 / 跌 #519C2C · 无网格 · 最新价水平线关
 *  · 自研操盘趋势：短线 MA7/MA10、中线 MA35/MA45，逐柱填充（强橙/弱蓝）
 *  · registerYAxis('normal') 全局轴模板：成交量轴万/亿（策影 config.ts 同款）
 *  · 滚轮缩放 / 拖拽平移为 klinecharts 原生能力
 *  · 十字光标浮动信息卡：OHLC/涨跌/振幅/区间位置/量额，周期（日/周/月）区分标题
 */
import { init, dispose, registerIndicator, registerYAxis, type Chart } from "klinecharts";
import type { Bar } from "../api";
import { cssv, fmt, fmtYi, fmtVol } from "../fmt";
import { sixSegmentSeries } from "../indicators";
import { accumulationSeries } from "../accumulation";

/* ── 策影配色（tradingColors） ── */
const UP = "#EF5350";
const DOWN = "#519C2C";
const NEUTRAL = "#757575";
/* 趋势通道配色 · 四方案用户可选（本地 yc_trendpal，云同步键 trend_palette）：
   与 K 线红绿、MA 琥珀/蓝、BOLL 灰区隔，避免与主流机构撞色 */
export const TRENDS: Record<string, { label: string; fast: string; slow: string; fr: number[]; sr: number[] }> = {
  A: { label: "A · 琥珀橙 × 皇家蓝", fast: "#FF9800", slow: "#0A84FF", fr: [255, 152, 0], sr: [10, 132, 255] },
  B: { label: "B · 紫罗兰 × 青绿", fast: "#C084FC", slow: "#2DD4BF", fr: [192, 132, 252], sr: [45, 212, 191] },
  C: { label: "C · 玫红 × 天蓝", fast: "#FB7185", slow: "#38BDF8", fr: [251, 113, 133], sr: [56, 189, 248] },
  D: { label: "D · 金黄 × 石墨", fast: "#EAB308", slow: "#94A3B8", fr: [234, 179, 8], sr: [148, 163, 184] },
};
let _pal = localStorage.getItem("yc_trendpal") || "B";
if (!TRENDS[_pal]) _pal = "B";

export function setTrendPalette(p: string): void {
  if (TRENDS[p]) {
    _pal = p;
    localStorage.setItem("yc_trendpal", p);
  }
}
export function trendPalette(): { label: string; fast: string; slow: string; fr: number[]; sr: number[] } {
  return TRENDS[_pal] ?? TRENDS.B;
}
export function trendPaletteKey(): string {
  return TRENDS[_pal] ? _pal : "B";
}
const channelFill = (strong: boolean, alpha: number) => {
  const p = trendPalette();
  const c = strong ? p.fr : p.sr;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
};

export function chartUp(): string {
  return document.documentElement.dataset.dir === "intl" ? DOWN : UP;
}
export function chartDown(): string {
  return document.documentElement.dataset.dir === "intl" ? UP : DOWN;
}

/* ── 自研操盘趋势（策影 indicatorRegistry 逐字移植） ──
 * 短线：MA7 快 + MA10 慢（α .82）｜中线：MA35 快 + MA45 慢（α .86）
 * 收盘 > 慢线 → 多头（橙）否则空头（蓝）
 */
function registerTrendChannel(
  name: string, shortName: string,
  fastPeriod: number, slowPeriod: number, alpha: number,
): void {
  registerIndicator({
    name,
    shortName,
    calcParams: [
      { key: "fastPeriod", value: fastPeriod },
      { key: "slowPeriod", value: slowPeriod },
    ],
    calc: (kLineDataList, indicator) => {
      const params = { fastPeriod, slowPeriod };
      indicator?.calcParams?.forEach((p: { key?: string; value?: number }) => {
        if (p.key !== undefined) (params as Record<string, number>)[p.key] = p.value!;
      });
      const fp = params.fastPeriod, sp = params.slowPeriod;
      const sma = (period: number): (number | null)[] => {
        const result: (number | null)[] = [];
        let sum = 0;
        for (let i = 0; i < kLineDataList.length; i++) {
          sum += kLineDataList[i].close;
          if (i >= period) sum -= kLineDataList[i - period].close;
          result.push(i >= period - 1 ? sum / period : null);
        }
        return result;
      };
      const fastMA = sma(fp), slowMA = sma(sp);
      return kLineDataList.map((k, i) => {
        const fast = fastMA[i], slow = slowMA[i];
        if (fast == null || slow == null) {
          return { fast: null, slow: null, upper: null, lower: null, strong: null };
        }
        return {
          fast, slow,
          upper: Math.max(fast, slow),
          lower: Math.min(fast, slow),
          strong: k.close > slow,
        };
      });
    },
    figures: [
      { key: "fast", title: "快线", type: "line", styles: () => ({ color: trendPalette().fast }) },
      { key: "slow", title: "慢线", type: "line", styles: () => ({ color: trendPalette().slow }) },
    ],
    draw: (params: { ctx?: CanvasRenderingContext2D; chart?: Chart; indicator?: { result?: unknown[] } }) => {
      const { ctx, chart, indicator } = params;
      const data = (indicator?.result || []) as ({ upper: number | null; lower: number | null; strong: boolean | null } | null)[];
      if (!ctx || !chart || data.length === 0) return false;
      const barSpace = chart.getBarSpace?.() || { bar: 8 };
      const barWidth = Math.max(2, (barSpace.bar || 8) - 1);
      data.forEach((item, i) => {
        if (!item || item.upper == null || item.lower == null) return;
        const px = (v: number) => chart.convertToPixel({ dataIndex: i, value: v }) as { x?: number; y?: number };
        const upperPixel = px(item.upper), lowerPixel = px(item.lower), xPixel = px(0);
        if (upperPixel.y == null || lowerPixel.y == null || xPixel.x == null) return;
        const x = xPixel.x - barWidth / 2;
        const y = Math.min(upperPixel.y, lowerPixel.y);
        const h = Math.abs(upperPixel.y - lowerPixel.y);
        if (h < 0.5) return;
        ctx.fillStyle = channelFill(item.strong === true, alpha);
        ctx.fillRect(x, y, barWidth, h);
      });
      return true;
    },
  });
}
let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registered = true;
  // BOLL 自研（策影同款）：注册为 BOLLX 避开 v10 内置同名不可靠覆盖；显示名仍为 BOLL
  registerIndicator({
    name: "BOLLX",
    shortName: "BOLL",
    precision: 2,
    calcParams: [
      { key: "timePeriod", value: 20 },
      { key: "stdDev", value: 2 },
    ],
    calc: (kLineDataList, indicator) => {
      const params = { timePeriod: 20, stdDev: 2 };
      indicator?.calcParams?.forEach((p: { key?: string; value?: number }) => {
        if (p.key !== undefined) (params as Record<string, number>)[p.key] = p.value!;
      });
      const n = Math.max(2, Math.round(params.timePeriod)), k = params.stdDev;
      let sum = 0, sq = 0;
      return kLineDataList.map((bar, i) => {
        sum += bar.close; sq += bar.close * bar.close;
        if (i >= n) { sum -= kLineDataList[i - n].close; sq -= kLineDataList[i - n].close ** 2; }
        if (i < n - 1) return { up: null, mid: null, dn: null };
        const mean = sum / n;
        const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
        return { up: mean + k * sd, mid: mean, dn: mean - k * sd };
      });
    },
    figures: [
      { key: "up", title: "UP", type: "line", styles: () => ({ color: "#8E8E93", style: "dashed", lineWidth: 1 }) },
      { key: "mid", title: "MID", type: "line", styles: () => ({ color: "#FF9F43", style: "dashed", lineWidth: 1 }) },
      { key: "dn", title: "DN", type: "line", styles: () => ({ color: "#8E8E93", style: "dashed", lineWidth: 1 }) },
    ],
    draw: (params: { ctx?: CanvasRenderingContext2D; chart?: Chart; indicator?: { result?: unknown[] } }) => {
      const { ctx, chart, indicator } = params;
      const data = (indicator?.result || []) as ({ up: number | null; dn: number | null } | null)[];
      if (!ctx || !chart || data.length === 0) return false;
      const barSpace = chart.getBarSpace?.() || { bar: 8 };
      const barWidth = Math.max(2, (barSpace.bar || 8) - 1);
      ctx.fillStyle = "rgba(142,142,147,.07)";   // 上下轨间中性淡填充，不抢 K 线
      data.forEach((item, i) => {
        if (!item || item.up == null || item.dn == null) return;
        const xPixel = chart.convertToPixel({ dataIndex: i, value: 0 }) as { x?: number };
        const upPixel = chart.convertToPixel({ dataIndex: i, value: item.up }) as { y?: number };
        const dnPixel = chart.convertToPixel({ dataIndex: i, value: item.dn }) as { y?: number };
        if (xPixel.x == null || upPixel.y == null || dnPixel.y == null) return;
        const h = Math.abs(upPixel.y - dnPixel.y);
        if (h < 0.5) return;
        ctx.fillRect(xPixel.x - barWidth / 2, Math.min(upPixel.y, dnPixel.y), barWidth, h);
      });
      return false;   // 继续默认绘制 figures（三条虚线轨道）
    },
  });
  registerTrendChannel("SHORT_TREND_CHANNEL", "短线趋势", 7, 10, 0.82);
  registerTrendChannel("MID_TREND_CHANNEL", "中线趋势", 35, 45, 0.86);
  // 分时均价线（VWAP）：后端 /market/minute 已算好，直接透传画线
  try {
    registerIndicator({
      name: "TIME_AVG",
      shortName: "均价",
      calc: (kLineDataList) =>
        (kLineDataList as unknown as { avg?: number }[]).map((b) => ({ avg: b.avg ?? null })),
      figures: [{ key: "avg", title: "均价", type: "line", styles: () => ({ color: "#26C6DA" }) }],
    });
  } catch { /* 重复注册忽略 */ }
  // 全局 Y 轴模板：覆盖内置 'normal'，成交量轴自动万/亿（策影 config.ts 同款）
  try {
    registerYAxis({
      name: "normal",
      displayValueToText: (value: number, _precision: number) => {
        if (Math.abs(value) >= 1e8) return (value / 1e8).toFixed(2) + "亿";
        if (Math.abs(value) >= 1e4) return (value / 1e4).toFixed(0) + "万";
        return value.toFixed(0);   // 刻度整数化：不带小数点（万/亿缩写除外）
      },
    });
  } catch { /* 重复注册会报错，忽略 */ }
  // 六分段副图（K线下方叠加趋势图）：60 窗口分位 → 1..6 段台阶线
  try {
    registerIndicator({
      name: "SIXSEG",
      shortName: "六段",
      precision: 0,
      calc: (kLineDataList) =>
        sixSegmentSeries(kLineDataList as unknown as { close: number }[]).map((v) => ({ seg: v })),
      figures: [{ key: "seg", title: "段位", type: "line", styles: () => ({ color: "#26C6DA" }) }],
    });
  } catch { /* 重复注册忽略 */ }
  registerIndicator({
    name: "ZY_ACCUMULATION",
    shortName: "主力吸筹·公式版",
    precision: 2,
    minValue: 0,
    calc: (list) => accumulationSeries(list).map(value => ({ accumulation: value })),
    figures: [{
      key: "accumulation", title: "吸筹", type: "bar", baseValue: 0,
      styles: () => ({ color: "#F000FF", borderColor: "#F000FF", borderSize: 1, style: "stroke" }),
    }],
  });
  // ATR 自研（klinecharts v10 未内置）：14 日真实波幅均值
  try {
    registerIndicator({
      name: "ATR",
      shortName: "ATR",
      precision: 2,
      calc: (kLineDataList) => {
        const list = kLineDataList as unknown as { high: number; low: number; close: number }[];
        const n = 14;
        const tr = list.map((b, i) =>
          i ? Math.max(b.high - b.low, Math.abs(b.high - list[i - 1].close), Math.abs(b.low - list[i - 1].close)) : b.high - b.low);
        let sum = 0;
        return list.map((_, i) => {
          sum += tr[i];
          if (i >= n) sum -= tr[i - n];
          return { atr: i >= n - 1 ? sum / n : NaN };
        });
      },
      figures: [{ key: "atr", title: "ATR", type: "line", styles: () => ({ color: "#F2C94C" }) }],
    });
  } catch { /* 重复注册忽略 */ }
  // VOLX 自研成交量（v10 内置 VOL 只认 MA5/MA10，第三参数 40 会被忽略——BOLLX 同款避坑）：
  // 量柱涨红跌绿 + MA5/MA10/MA40 三条均量线
  try {
    registerIndicator({
      name: "VOLX",
      shortName: "VOL",
      precision: 0,
      shouldFormatBigNumber: true,
      calc: (kLineDataList) => {
        const list = kLineDataList as unknown as { volume?: number; open?: number; close?: number }[];
        const out: { volume: number | null; ma5: number | null; ma10: number | null; ma40: number | null; open?: number; close?: number }[] = [];
        let s5 = 0, s10 = 0, s40 = 0;
        for (let i = 0; i < list.length; i++) {
          const v = list[i].volume ?? 0;
          s5 += v; s10 += v; s40 += v;
          if (i >= 5) s5 -= list[i - 5].volume ?? 0;
          if (i >= 10) s10 -= list[i - 10].volume ?? 0;
          if (i >= 40) s40 -= list[i - 40].volume ?? 0;
          out.push({
            volume: v,
            ma5: i >= 4 ? s5 / 5 : null,
            ma10: i >= 9 ? s10 / 10 : null,
            ma40: i >= 39 ? s40 / 40 : null,
            // 复制 open/close 到结果项供柱色回调判断涨跌（策影内置 VOL 同款）
            open: list[i].open, close: list[i].close,
          });
        }
        return out as never;
      },
      figures: [
        {
          key: "volume", title: "VOL", type: "bar",
          // v10 回调第一参即 {data:{prev,current,next}}，current 为 calc 结果项
          styles: (raw: unknown) => {
            const c = (raw as { data?: { current?: { close?: number; open?: number } } })?.data?.current;
            const up = cssv("--up") || "#E64545", dn = cssv("--down") || "#2FBF71";
            if (c?.close == null || c.open == null) return { color: NEUTRAL };
            if (c.close > c.open) return { color: up };
            if (c.close < c.open) return { color: dn };
            return { color: NEUTRAL };
          },
        },
        { key: "ma5", title: "MA5", type: "line", styles: () => ({ color: "#FF9F43", lineWidth: 1 }) },
        { key: "ma10", title: "MA10", type: "line", styles: () => ({ color: "#4DD0E1", lineWidth: 1 }) },
        { key: "ma40", title: "MA40", type: "line", styles: () => ({ color: "#AB47BC", lineWidth: 1.5 }) },
      ],
    });
  } catch { /* 重复注册忽略 */ }
  // 超买超卖三件套（v10 内置无 80/20、70/30 阈值参考线，自研补齐）：
  // KDJX(9,3,3) 80/20 · RSIX(6/12/24) 70/30 · WRX(10,6) 80/20 —— 阈值线作为固定值 figures 灰虚线
  try {
    const smaCn = (src: (number | null)[], n: number, m: number): (number | null)[] => {
      const out: (number | null)[] = [];
      let prev = NaN;
      for (let i = 0; i < src.length; i++) {
        const x = src[i];
        if (x == null) { out.push(null); continue; }
        prev = isNaN(prev) ? x : (m * x + (n - m) * prev) / n;
        out.push(prev);
      }
      return out;
    };
    const dash = (key: string, title: string) => ({
      key, title, type: "line" as const,
      styles: () => ({ color: "rgba(142,142,147,.55)", style: "dashed" as const, lineWidth: 1 }),
    });
    registerIndicator({
      name: "KDJX",
      shortName: "KDJ",
      precision: 2,
      calcParams: [
        { key: "n", value: 9 }, { key: "m1", value: 3 }, { key: "m2", value: 3 },
      ],
      calc: (kLineDataList, indicator) => {
        const p: Record<string, number> = { n: 9, m1: 3, m2: 3 };
        indicator?.calcParams?.forEach((x: { key?: string; value?: number }) => {
          if (x.key !== undefined) p[x.key] = x.value!;
        });
        const list = kLineDataList as unknown as { high: number; low: number; close: number }[];
        const n = Math.max(1, Math.round(p.n));
        const rsv: (number | null)[] = list.map((_, i) => {
          if (i < n - 1) return null;
          let h = -Infinity, l = Infinity;
          for (let j = i - n + 1; j <= i; j++) { h = Math.max(h, list[j].high); l = Math.min(l, list[j].low); }
          return h === l ? 50 : ((list[i].close - l) / (h - l)) * 100;
        });
        const k = smaCn(rsv, p.m1, 1), d = smaCn(k, p.m2, 1);
        return list.map((_, i) => ({
          k: k[i], d: d[i], j: k[i] != null && d[i] != null ? 3 * k[i]! - 2 * d[i]! : null,
          ob: 80, os: 20,
        }));
      },
      figures: [
        { key: "k", title: "K", type: "line", styles: () => ({ color: "#FF9F43" }) },
        { key: "d", title: "D", type: "line", styles: () => ({ color: "#4DD0E1" }) },
        { key: "j", title: "J", type: "line", styles: () => ({ color: "#AB47BC" }) },
        dash("ob", "超买80"), dash("os", "超卖20"),
      ],
    });
    // OBOS 超买超卖（策影 CAOPAN 同款）：操盘值 = 加权价(2C+H+L+O)/5 在 14 周期
    // LLV~HHV 区间的位置百分位；超买 95 橙 / 中轴 50 灰 / 超卖 5 青参考线
    registerIndicator({
      name: "OBOSX",
      shortName: "操盘",
      precision: 0,
      calcParams: [{ key: "n", value: 14 }],
      calc: (kLineDataList, indicator) => {
        const p: Record<string, number> = { n: 14 };
        indicator?.calcParams?.forEach((x: { key?: string; value?: number }) => {
          if (x.key !== undefined) p[x.key] = x.value!;
        });
        const list = kLineDataList as unknown as { open: number; high: number; low: number; close: number }[];
        const n = Math.max(1, Math.round(p.n));
        const base = list.map((k) => (2 * k.close + k.high + k.low + k.open) / 5);
        return list.map((_, i) => {
          if (i < n - 1) return { cp: null, ob: 95, mid: 50, os: 5 };
          let h = -Infinity, l = Infinity;
          for (let j = i - n + 1; j <= i; j++) { h = Math.max(h, base[j]); l = Math.min(l, base[j]); }
          return { cp: h === l ? 50 : ((base[i] - l) / (h - l)) * 100, ob: 95, mid: 50, os: 5 };
        });
      },
      figures: [
        { key: "cp", title: "操盘", type: "line", styles: () => ({ color: "#4FC3F7", lineWidth: 1.4 }) },
        dash("ob", "超买95"), dash("mid", "中轴50"), dash("os", "超卖5"),
      ],
    });
    registerIndicator({
      name: "RSIX",
      shortName: "RSI",
      precision: 2,
      calcParams: [
        { key: "n1", value: 6 }, { key: "n2", value: 12 }, { key: "n3", value: 24 },
      ],
      calc: (kLineDataList, indicator) => {
        const p: Record<string, number> = { n1: 6, n2: 12, n3: 24 };
        indicator?.calcParams?.forEach((x: { key?: string; value?: number }) => {
          if (x.key !== undefined) p[x.key] = x.value!;
        });
        const list = kLineDataList as unknown as { close: number }[];
        const rsiOf = (n: number): (number | null)[] => {
          const up: (number | null)[] = [], dn: (number | null)[] = [];
          for (let i = 0; i < list.length; i++) {
            if (!i) { up.push(null); dn.push(null); continue; }
            const ch = list[i].close - list[i - 1].close;
            up.push(Math.max(ch, 0)); dn.push(Math.abs(ch));
          }
          const su = smaCn(up, n, 1), sd = smaCn(dn, n, 1);
          return list.map((_, i) =>
            su[i] == null || sd[i] == null ? null : sd[i] === 0 ? 100 : (su[i]! / sd[i]!) * 100);
        };
        const r1 = rsiOf(p.n1), r2 = rsiOf(p.n2), r3 = rsiOf(p.n3);
        return list.map((_, i) => ({ r1: r1[i], r2: r2[i], r3: r3[i], ob: 70, os: 30 }));
      },
      figures: [
        { key: "r1", title: "RSI6", type: "line", styles: () => ({ color: "#FF9F43" }) },
        { key: "r2", title: "RSI12", type: "line", styles: () => ({ color: "#4DD0E1" }) },
        { key: "r3", title: "RSI24", type: "line", styles: () => ({ color: "#AB47BC" }) },
        dash("ob", "超买70"), dash("os", "超卖30"),
      ],
    });
    registerIndicator({
      name: "WRX",
      shortName: "WR",
      precision: 2,
      calcParams: [
        { key: "n1", value: 10 }, { key: "n2", value: 6 },
      ],
      calc: (kLineDataList, indicator) => {
        const p: Record<string, number> = { n1: 10, n2: 6 };
        indicator?.calcParams?.forEach((x: { key?: string; value?: number }) => {
          if (x.key !== undefined) p[x.key] = x.value!;
        });
        const list = kLineDataList as unknown as { high: number; low: number; close: number }[];
        const wrOf = (n: number): (number | null)[] =>
          list.map((_, i) => {
            if (i < n - 1) return null;
            let h = -Infinity, l = Infinity;
            for (let j = i - n + 1; j <= i; j++) { h = Math.max(h, list[j].high); l = Math.min(l, list[j].low); }
            return h === l ? 50 : ((h - list[i].close) / (h - l)) * 100;
          });
        const w1 = wrOf(Math.max(1, Math.round(p.n1))), w2 = wrOf(Math.max(1, Math.round(p.n2)));
        return list.map((_, i) => ({ w1: w1[i], w2: w2[i], ob: 80, os: 20 }));
      },
      figures: [
        { key: "w1", title: "WR10", type: "line", styles: () => ({ color: "#FF9F43" }) },
        { key: "w2", title: "WR6", type: "line", styles: () => ({ color: "#4DD0E1" }) },
        dash("ob", "超买80"), dash("os", "超卖20"),
      ],
    });
  } catch { /* 重复注册忽略 */ }
}

/* ── 时间转换（策影 format.ts 逐字 + 分钟级 datetime 支持） ── */
function toTs(time: string): number {
  if (!time) return Date.now();
  if (time.includes("T")) return new Date(time).getTime();
  if (time.includes(" ")) return new Date(time.replace(" ", "T") + ":00").getTime();
  return new Date(time + "T00:00:00").getTime();
}

/* ── 指标注册表：klinecharts 内置名直通 + 自研（SHORT/MID/SIXSEG/TIME_AVG）──
 * 分类对齐主流软件（同花顺/东财/TradingView）：主图叠加 / 趋势 / 动量 / 量能 / 摆动人气 / 波动分位 */
export type IndCat = "main" | "trend" | "mom" | "vol" | "swing" | "volat";
export type IndDef = { key: string; kc: string; label: string; cat: IndCat; where: "main" | "sub"; desc: string };
export const IND_CATS: { cat: IndCat; label: string }[] = [
  { cat: "main", label: "主图叠加" }, { cat: "trend", label: "趋势" }, { cat: "mom", label: "动量" },
  { cat: "vol", label: "量能" }, { cat: "swing", label: "摆动人气" }, { cat: "volat", label: "波动分位" },
];
export const IND_DEFS: IndDef[] = [
  // 主图叠加
  { key: "ma", kc: "MA", label: "MA", cat: "main", where: "main", desc: "移动平均线 5/10/20" },
  { key: "ema", kc: "EMA", label: "EMA", cat: "main", where: "main", desc: "指数移动平均线" },
  { key: "boll", kc: "BOLLX", label: "BOLL", cat: "main", where: "main", desc: "布林带（虚线三轨+淡填充）" },
  { key: "sar", kc: "SAR", label: "SAR", cat: "main", where: "main", desc: "抛物线转向（停损点）" },
  { key: "short", kc: "SHORT_TREND_CHANNEL", label: "短线趋势", cat: "main", where: "main", desc: "策影同款短线操盘趋势通道（收盘对 MA10）" },
  { key: "mid", kc: "MID_TREND_CHANNEL", label: "中线趋势", cat: "main", where: "main", desc: "策影同款中线操盘趋势通道（收盘对 MA45）" },
  { key: "avg", kc: "TIME_AVG", label: "均价线", cat: "main", where: "main", desc: "分时均价线（日内）" },
  { key: "bbi", kc: "BBI", label: "BBI", cat: "main", where: "main", desc: "多空指数（四均线加权）" },
  { key: "bbiboll", kc: "BBIBOLL", label: "BBIBOLL", cat: "main", where: "main", desc: "BBI 布林变异带（多均线布林）" },
  // 趋势类
  { key: "macd", kc: "MACD", label: "MACD", cat: "trend", where: "sub", desc: "指数平滑异同移动平均" },
  { key: "dmi", kc: "DMI", label: "DMI", cat: "trend", where: "sub", desc: "趋向指标（ADX 强弱方向）" },
  { key: "trix", kc: "TRIX", label: "TRIX", cat: "trend", where: "sub", desc: "三重指数平滑平均线" },
  { key: "emv", kc: "EMV", label: "EMV", cat: "trend", where: "sub", desc: "简易波动指标（量价趋势）" },
  { key: "dma", kc: "DMA", label: "DMA", cat: "trend", where: "sub", desc: "平均线差（快慢均线差值）" },
  // 动量类
  { key: "kdj", kc: "KDJX", label: "KDJ", cat: "mom", where: "sub", desc: "随机指标（超买80/超卖20参考线）" },
  { key: "rsi", kc: "RSIX", label: "RSI", cat: "mom", where: "sub", desc: "相对强弱指标（超买70/超卖30参考线）" },
  { key: "cci", kc: "CCI", label: "CCI", cat: "mom", where: "sub", desc: "顺势指标（脱离常态范围）" },
  { key: "roc", kc: "ROC", label: "ROC", cat: "mom", where: "sub", desc: "变动率指标" },
  { key: "mtm", kc: "MTM", label: "MTM", cat: "mom", where: "sub", desc: "动量指标" },
  { key: "wr", kc: "WRX", label: "WR", cat: "mom", where: "sub", desc: "威廉指标（超买80/超卖20参考线）" },
  { key: "obos", kc: "OBOSX", label: "超买超卖", cat: "mom", where: "sub", desc: "操盘线：加权价 14 周期位置百分位（超买95/中轴50/超卖5）" },
  { key: "psy", kc: "PSY", label: "PSY", cat: "mom", where: "sub", desc: "心理线（上涨天数占比）" },
  { key: "lwr", kc: "LWR", label: "LWR", cat: "mom", where: "sub", desc: "威廉随机指标（快慢随机线）" },
  { key: "osc", kc: "OSC", label: "OSC", cat: "mom", where: "sub", desc: "变动率柱（震荡量指标）" },
  { key: "udl", kc: "UDL", label: "UDL", cat: "mom", where: "sub", desc: "引力线（多周期动量合成）" },
  // 量能类
  { key: "accumulation", kc: "ZY_ACCUMULATION", label: "主力吸筹", cat: "vol", where: "sub", desc: "众赢安装包公式移植，尚未与原软件逐点核对；紫色柱为价格推导指标，非实际主力资金" },
  { key: "vol", kc: "VOLX", label: "VOL", cat: "vol", where: "sub", desc: "成交量（5/10/40 日均量线）" },
  { key: "obv", kc: "OBV", label: "OBV", cat: "vol", where: "sub", desc: "能量潮（量能累积方向）" },
  { key: "vr", kc: "VR", label: "VR", cat: "vol", where: "sub", desc: "成交量比率" },
  { key: "wvad", kc: "WVAD", label: "WVAD", cat: "vol", where: "sub", desc: "威廉变异离散量（量价加权）" },
  // 摆动人气类
  { key: "brar", kc: "BRAR", label: "BRAR", cat: "swing", where: "sub", desc: "情绪指标（人气/意愿）" },
  { key: "cr", kc: "CR", label: "CR", cat: "swing", where: "sub", desc: "能量指标（中间意愿）" },
  { key: "bias", kc: "BIAS", label: "BIAS", cat: "swing", where: "sub", desc: "乖离率（偏离均线程度）" },
  // 波动分位类
  { key: "atr", kc: "ATR", label: "ATR", cat: "volat", where: "sub", desc: "真实波幅（波动强度）" },
  { key: "sixseg", kc: "SIXSEG", label: "六段", cat: "volat", where: "sub", desc: "自研 60 日分位 1-6 段" },
];
export const IND_BY_KEY: Record<string, IndDef> = Object.fromEntries(IND_DEFS.map((d) => [d.key, d]));

/** 合法键集合由注册表决定（放宽为 string，持久化值经 KMAIN_OK/KSUB_OK 校验） */
export type MainKey = string;
export type SubKey = string;

/** 框选区间统计（图表侧算完抛给行情页：价格/量额口径全在这，资金由接口补） */
export interface RangeStats {
  startDate: string; endDate: string; days: number;
  changePct: number; amp: number;
  high: number; low: number; close: number;
  amount: number; avgAmount: number; volume: number;
  upN: number; downN: number;
  /* 选区像素位置（卡片定位用，跨模块无用） */
  x0: number; x1: number;
}

/** 单根 K 线选中（点击蜡烛）：行情页据此把右列资金卡切到「该交易日」口径 */
export interface PickBar {
  date: string;
  index: number;
  open: number; high: number; low: number; close: number;
  prevClose: number | null;
  changePct: number;
  amp: number;
  amount: number;
  volume: number;
}

/** 区间资金（/market/fundflow 的回填口径；指数 available=false，只报原因） */
export interface RangeFund {
  available: boolean;
  covered: number;
  net_main: number | null;
  net_super: number | null;
  net_large: number | null;
  net_medium: number | null;
  net_small: number | null;
}

export interface KlineChartHandle {
  chart: Chart;
  setData: (bars: Bar[], keepView?: boolean) => void;
  /** 主图多选叠加：增量增删，不动已叠加的同名指标 */
  setMain: (inds: MainKey[]) => void;
  /** 图内右上角指标图例（MA/BOLL/操盘趋势，色块+名称；多面板时每实例一份） */
  drawLegend: (inds: MainKey[]) => void;
  /** 副图多选：每个指标一个窗格，高度均分（策影 autoLayout 同款） */
  setSub: (inds: SubKey[]) => void;
  /** 当前周期（d/w/m）：决定十字光标卡片的标题形态 */
  setPeriod: (p: "t" | "60" | "d" | "w" | "m") => void;
  /** 智能高度：按容器高重分主/副图（3.6:1，策影同款；开关关时副图固定 100px） */
  applyHeights: () => void;
  /** 缩放：factor>1 放大（K 线变宽），等价策影工具条 ±（barSpace ×1.25 / ×0.8） */
  zoom: (factor: number) => void;
  /** 观察档位：一键显示最近 n 根（纯视图缩放，不重载数据，策影同款） */
  viewBars: (n: number) => void;
  /** 重置视图：默认档位（宽度/16）并回到最新 */
  resetView: () => void;
  /** 数据/主题变化后重画底部导航条缩略图 */
  navRefresh: () => void;
  /** 框选模式开关：开=左键直接拖拽框选（禁用平移），关=恢复平移并清空选区 */
  setRangeMode: (on: boolean) => void;
  /** 框选模式是否开启（工具栏按钮态与图表实例对账用） */
  isRangeMode: () => boolean;
  /** 区间资金回填（行情页拉到 /market/fundflow 后写回卡片） */
  setRangeFund: (f: RangeFund | null) => void;
  /** 清空选区（切标的 / 切周期 / 关闭模式时调用，notify=true 会同步清右列） */
  clearRange: (notify?: boolean) => void;
  /** 清空单根选中（notify=true 同步通知行情页把资金卡退回当日口径） */
  clearPick: (notify?: boolean) => void;
  retheme: () => void;
  resize: () => void;
  destroy: () => void;
}

/* ── 智能高度（策影 computeAutoPaneHeights 同款） ──
 * 主图:单个副图 = 3.6:1（1 副图 → 主图 78%，2 → 64%，3 → 55%）；
 * 副图夹在 44~132px；主图硬约束 ≥ 3×副图且 ≥160px，空间不足时副图退让。 */
const X_AXIS_H = 24, MAIN_SUB_RATIO = 3.6,
  SUB_MIN = 44, SUB_MAX = 132, MAIN_MIN = 160, MAIN_MIN_RATIO = 3;

function smartHeights(total: number, n: number): { main: number; sub: number } {
  const avail = Math.max(160, Math.round(total - X_AXIS_H));
  if (n <= 0) return { main: avail, sub: 0 };
  let sub = Math.min(SUB_MAX, Math.round(avail / (MAIN_SUB_RATIO + n)));
  const ratioCap = Math.floor(avail / (MAIN_MIN_RATIO + n));
  if (sub > ratioCap) sub = ratioCap;
  sub = Math.max(SUB_MIN, sub);
  let main = avail - sub * n;
  if (main < MAIN_MIN) {
    sub = Math.max(SUB_MIN, Math.floor((avail - MAIN_MIN) / n));
    main = avail - sub * n;
  }
  return { main, sub };
}

function styles() {
  const border = cssv("--border") || "#2B2B2F";
  const axis = cssv("--axis") || border;
  const text = cssv("--faint") || "#717176";
  const up = chartUp(), dn = chartDown();
  return {
    grid: { show: false },
    separator: { size: 1, color: border, fill: false, activeBackgroundColor: border },
    candle: {
      type: "candle_up_stroke" as const,
      tooltip: { showRule: "none" as const },
      bar: {
        upColor: "rgba(0,0,0,0)", downColor: dn, noChangeColor: NEUTRAL,
        upBorderColor: up, downBorderColor: dn, noChangeBorderColor: NEUTRAL,
        upWickColor: up, downWickColor: dn, noChangeWickColor: NEUTRAL,
      },
      priceMark: { show: true, last: { show: false }, high: { show: true }, low: { show: true } },
    },
    indicator: {
      tooltip: { showRule: "none" as const, title: { showName: false, showParams: false } },
      ohlc: { upColor: up, downColor: dn, noChangeColor: NEUTRAL },
    },
    crosshair: {
      show: true,
      horizontal: {
        show: true, line: { show: true, size: 1, color: text, dashedValue: [4, 4] },
        text: { show: false },
      },
      vertical: {
        show: true, line: { show: true, size: 1, color: text, dashedValue: [4, 4] },
        text: { show: true, color: cssv("--text") || "#F5F5F7", size: 12, backgroundColor: cssv("--panel-3") || "#2D2D31", borderSize: 1, borderColor: text, borderRadius: 4 },
      },
    },
    xAxis: {
      show: true, size: "auto" as const,
      axisLine: { color: axis, size: 1 }, tickLine: { color: axis, size: 1, length: 3 },
      tickText: { show: true, color: text, size: 11 },
    },
    yAxis: {
      show: true, size: "auto" as const,
      axisLine: { color: axis, size: 1 }, tickLine: { color: axis, size: 1, length: 3 },
      tickText: { show: true, color: text, size: 11 },
    },
  };
}

/* ── 十字光标浮动信息卡（周期区分标题） ── */
type TipPeriod = "t" | "60" | "d" | "w" | "m";

/** 量/额：万以下原值，万 → 亿（策影 formatVolumeValue 口径 + 手单位） */
function fmtWanYi(v: number, unit = ""): string {
  if (!isFinite(v)) return "—";
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + "亿" + unit;
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + "万" + unit;
  return v.toFixed(0) + unit;
}

function tipTitle(date: string, p: TipPeriod): string {
  if (p === "t") return `${date} · 分时`;
  if (p === "60") return `${date} · 60分钟`;
  if (p === "m") return `${date.slice(0, 7)} · 月线`;
  if (p === "w") return `${date} 当周 · 周线`;
  return `${date} · 北京时间`;
}

/** 区间位置：当前收盘在近 window 根（含当根）高低区间内的分位（%） */
function rangePosition(list: { high: number; low: number; close: number }[], i: number, window = 250): number | null {
  const s = Math.max(0, i - window + 1);
  const seg = list.slice(s, i + 1);
  const hi = Math.max(...seg.map((x) => x.high));
  const lo = Math.min(...seg.map((x) => x.low));
  if (!isFinite(hi) || !isFinite(lo) || hi === lo) return null;
  return ((list[i].close - lo) / (hi - lo)) * 100;
}

const sgn = (v: number, digits = 2): string => (v > 0 ? "+" : "") + v.toFixed(digits);

export function mountKline(el: HTMLElement): KlineChartHandle {
  ensureRegistered();
  const chart = init(el, {
    styles: styles(),
    layout: {
      barSpaceLimit: {
        min: 1,
        max: Math.max(50, Math.ceil((el.clientWidth || 1440) / 16)),
      },
    },
  }) as Chart;
  // 最新 K 线右侧留 12px 小空隙：0 时紧贴 Y 轴边界被轴线/刻度盖住，
  // 太大则最新一根离轴太远（12px ≈ 一根半柱宽，贴轴但完整可见）
  try { chart.setOffsetRightDistance(12); } catch { /* 忽略 */ }
  // v10 门控：symbol/period 无效时 getBars 永远不触发（canvas 空白无报错），
  // 数据虽由外部回填，仍需设置合法 symbol/period 才能打开加载开关
  chart.setSymbol({ ticker: "YUCHAO", pricePrecision: 2, volumePrecision: 0 });
  chart.setPeriod({ type: "day", span: 1 });

  /* 框选状态（声明提前：onCross 里要判断"是否已有区间卡"，避免与十字光标卡同屏叠两张） */
  let rangeMode = false;
  let lastSel: RangeStats | null = null;

  /* ── 浮动信息卡：跟随十字光标，边缘翻转避让 ── */
  const tip = document.createElement("div");
  tip.className = "kl-tip";
  tip.style.display = "none";
  el.appendChild(tip);
  let period: TipPeriod = "d";

  /* ── 图内右上角指标图例：色块 + 名称；操盘趋势按本面板数据判多空 ── */
  const legend = document.createElement("div");
  legend.className = "legend";
  el.appendChild(legend);
  const drawLegend = (inds: MainKey[]) => {
    const accC = cssv("--accent") || "#FF9F43", p1C = "#0A84FF", vipC = cssv("--vip") || "#FFD60A";
    const dimC = cssv("--dim") || "#A1A1A6";
    const parts: string[] = [];
    if (inds.includes("ma"))
      parts.push(`<span><i style="background:${accC}"></i>MA5</span><span><i style="background:${p1C}"></i>MA10</span><span><i style="background:${vipC}"></i>MA20</span>`);
    if (inds.includes("boll"))
      parts.push(`<span><i style="background:${dimC}"></i>BOLL(20,2)</span>`);
    if (inds.includes("avg"))
      parts.push(`<span><i style="background:#26C6DA"></i>均价线</span>`);
    const list = chart.getDataList() as { close: number }[];
    for (const k of inds) {
      if (k !== "short" && k !== "mid") continue;
      const n = k === "short" ? 10 : 45;
      const closes = list.map((b) => b.close);
      const last = closes[closes.length - 1];
      const ma = closes.length >= n ? closes.slice(-n).reduce((s, v) => s + v, 0) / n : null;
      const strong = ma != null && last > ma;
      const p = trendPalette();
      const fill = strong ? `rgba(${p.fr.join(",")},.82)` : `rgba(${p.sr.join(",")},.86)`;
      // 每趋势一项：双色调语义（主色=强 / 次色=弱），当前状态全亮、另一态半透明
      const cF = `rgb(${p.fr.join(",")})`, cS = `rgb(${p.sr.join(",")})`;
      parts.push(`<span title="通道颜色：主色=趋势强，次色=趋势弱">` +
        `${k === "short" ? "短线" : "中线"}趋势` +
        `<i style="background:${cF}"></i><b style="${strong ? "" : "opacity:.4"}">强</b>` +
        `<i style="background:${cS}"></i><b style="${!strong ? "" : "opacity:.4"}">弱</b></span>`);
    }
    legend.innerHTML = parts.join("");
    legend.style.display = parts.length ? "flex" : "none";
  };

  const onCross = (...args: unknown[]) => {
    // 框选模式下已有区间卡：不再叠一张十字光标卡（两张同风格浮卡会互相打架）
    if (rangeMode && lastSel) { tip.style.display = "none"; return; }
    const ch = args[0] as { x?: number; y?: number } | null;
    if (!ch || ch.x == null || ch.y == null) { tip.style.display = "none"; return; }
    const list = chart.getDataList() as { timestamp: number; open: number; high: number; low: number; close: number; volume?: number; amount?: number; date?: string }[];
    // v10 crosshair 事件只带坐标，经 convertFromPixel 反查数据索引（策影同款）
    const hit = chart.convertFromPixel([{ x: ch.x }]) as unknown;
    const di = (Array.isArray(hit) ? hit[0] : hit)?.dataIndex as number | undefined;
    const bar = di != null ? list[di] : undefined;
    if (!bar) { tip.style.display = "none"; return; }
    const prev = di! > 0 ? list[di! - 1] : undefined;
    const base = prev?.close || bar.open;                 // 涨跌/振幅基准（首根 vs 开盘）
    const chg = bar.close - base;
    const pct = base ? (chg / base) * 100 : 0;
    const amp = base ? ((bar.high - bar.low) / base) * 100 : 0;
    const pos = rangePosition(list, di!);
    const posTxt = pos == null ? "—" : pos.toFixed(1) + "%";
    const cls = chg > 0 ? "up" : chg < 0 ? "down" : "";
    // 紧凑分组：OHLC 一行 · 涨跌/振幅/位置 一行 · 量/额 一行（减少遮挡）
    const kv = (k: string, v: string, c = "") => `<span>${k}<b class="num ${c}">${v}</b></span>`;
    tip.innerHTML =
      `<div class="t num">${tipTitle(bar.date ?? "", period)}</div>` +
      `<div class="grp">${kv("开", bar.open.toFixed(2))}${kv("高", bar.high.toFixed(2))}${kv("低", bar.low.toFixed(2))}${kv("收", bar.close.toFixed(2), cls)}</div>` +
      `<div class="grp">${kv("涨跌", `${sgn(chg)} (${sgn(pct)}%)`, cls)}${kv("振幅", amp.toFixed(2) + "%")}${kv("位置", posTxt)}</div>` +
      `<div class="grp">${kv("量", fmtWanYi(bar.volume ?? 0, "手"))}${kv("额", fmtWanYi(bar.amount ?? 0))}</div>`;
    tip.style.display = "block";
    // 定位 + 翻转（卡片实际尺寸就绪后再算，避免首帧抖动）
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const flipX = ch.x + 16 + w > el.clientWidth;
    const flipY = ch.y + 16 + h > el.clientHeight;
    tip.style.left = (flipX ? ch.x - w - 16 : ch.x + 16) + "px";
    tip.style.top = (flipY ? ch.y - h - 16 : ch.y + 16) + "px";
  };
  try { chart.subscribeAction("onCrosshairChange", onCross as never); } catch { /* 忽略 */ }

  /* ── 框选区间统计（策影鼠标框选移植）：拖拽一段 → 涨跌幅 / 振幅 / 量额 / 资金 ──
   *  · 框选模式（工具栏「框选」）：左键直接拖，无需修饰键；期间禁用图表平移
   *  · 非框选模式：保留 Shift + 拖拽的快捷手势（老路子，不破坏习惯）
   *  · 卡片刻意与十字光标卡（.kl-tip）同语言：紧凑分组行 + 半透明毛玻璃，少遮挡
   *  · 结果通过 yc:kl-range 事件抛给行情页 → 右列资金卡同步（kline.ts 不认标的）
   */
  const sel = document.createElement("div");
  sel.className = "kl-selbox";
  sel.style.display = "none";
  el.appendChild(sel);
  const selTip = document.createElement("div");
  selTip.className = "kl-seltip";
  selTip.style.display = "none";
  el.appendChild(selTip);
  let selX0: number | null = null;
  let downX = 0;                        // 按下点（判定「点击」还是「拖拽」，用于点空白撤选中）
  let selFund: RangeFund | null = null;
  const ymd = (t: number): string => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  /** 像素 x → 数据索引（越界返回 undefined） */
  const diOfX = (x: number): number | undefined => {
    const hit = chart.convertFromPixel([{ x }]) as unknown;
    return (Array.isArray(hit) ? hit[0] : hit)?.dataIndex as number | undefined;
  };
  const kv = (k: string, v: string, c = "") => `<span>${k}<b class="num ${c}">${v}</b></span>`;

  /** 资金行（右列接口回填后追加；指数无个股资金流 → 只报覆盖天数与原因） */
  const fundHtml = (): string => {
    if (!lastSel) return "";
    if (!selFund) return `<div class="st-g fund"><span>资金<b class="num">统计中…</b></span></div>`;
    if (!selFund.available)
      return `<div class="st-g fund"><span>主力净流入<b class="num" style="color:var(--faint)">—</b></span>` +
        `<span style="color:var(--faint);font-size:10px">指数无资金流</span></div>`;
    const yi = (v: number | null | undefined) => v == null ? "—" : fmtYi(v, 2);
    const m = selFund.net_main, cls = (m ?? 0) >= 0 ? "up" : "down";
    return `<div class="st-g fund"><span>主力净流入<b class="num ${cls}">${m == null ? "—" : (m > 0 ? "+" : "") + yi(m)}</b></span>` +
      `<span>覆盖<b class="num">${selFund.covered}天</b></span></div>` +
      `<div class="st-g fund"><span>超大<b class="num">${yi(selFund.net_super)}</b></span>` +
      `<span>大单<b class="num">${yi(selFund.net_large)}</b></span></div>` +
      `<div class="st-g fund"><span>中单<b class="num">${yi(selFund.net_medium)}</b></span>` +
      `<span>小单<b class="num">${yi(selFund.net_small)}</b></span></div>`;
  };

  const drawSelTip = (): void => {
    const s = lastSel;
    if (!s) { selTip.style.display = "none"; return; }
    const cls = s.changePct >= 0 ? "up" : "down";
    selTip.innerHTML =
      `<div class="t">区间 ${s.days} 根 · ${s.startDate} → ${s.endDate}</div>` +
      `<div class="grp">${kv("涨跌", `${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(2)}%`, cls)}` +
      `${kv("振幅", s.amp.toFixed(2) + "%")}${kv("阳/阴", `${s.upN}/${s.downN}`)}</div>` +
      `<div class="grp">${kv("高", fmt(s.high))}${kv("低", fmt(s.low))}${kv("收盘", fmt(s.close), cls)}</div>` +
      `<div class="grp">${kv("成交额", fmtYi(s.amount, 2))}${kv("日均", fmtYi(s.avgAmount, 2))}${kv("量", fmtVol(s.volume / 100) + "手")}</div>` +
      `<div class="st-sep"></div>` + fundHtml() +
      `<div class="st-f">${rangeMode ? "继续拖拽调整区间 · 点击空白关闭" : "Shift + 拖拽框选 · 点击空白关闭"}</div>`;
    selTip.style.display = "block";
    tip.style.display = "none";          // 区间卡优先：收起停留在图表上的十字光标卡
    placeSelTip();
  };

  /** 卡片定位：贴选区右缘（越界翻左），纵向钉在图表上部，避让顶部图例 */
  const placeSelTip = (): void => {
    if (!lastSel || selTip.style.display === "none") return;
    const r = el.getBoundingClientRect();
    const x1 = Math.max(lastSel.x0, lastSel.x1), x0 = Math.min(lastSel.x0, lastSel.x1);
    const tw = selTip.offsetWidth, th = selTip.offsetHeight;
    const flip = x1 + tw + 12 > r.width;
    selTip.style.left = `${Math.max(4, flip ? x0 - tw - 12 : x1 + 12)}px`;
    selTip.style.top = `${Math.max(8, Math.min(r.height - th - 8, 46))}px`;
  };

  const clearSel = (notify: boolean): void => {
    lastSel = null; selFund = null;
    selTip.style.display = "none";
    sel.style.display = "none";
    if (notify) document.dispatchEvent(new CustomEvent("yc:kl-range", { detail: null }));
  };

  const onSelDown = (e: MouseEvent) => {
    // 只认左键；框选模式或 Shift 手势才进入拖拽，否则视为"点空白关卡片"
    if (e.button !== 0) return;
    downX = e.clientX;
    if (!rangeMode && !e.shiftKey) { if (lastSel) clearSel(true); return; }
    e.preventDefault(); e.stopPropagation();                     // 拦截 v10 平移，进入框选
    const r = el.getBoundingClientRect();
    selX0 = e.clientX;
    sel.style.left = `${e.clientX - r.left}px`; sel.style.top = "0px";
    sel.style.width = "0px"; sel.style.height = `${r.height}px`;
    sel.style.display = "block";
  };
  const onSelMove = (e: MouseEvent) => {
    if (selX0 == null) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect();
    const a = Math.min(selX0, e.clientX) - r.left, b = Math.max(selX0, e.clientX) - r.left;
    sel.style.left = `${a}px`; sel.style.width = `${b - a}px`;
  };
  const onSelUp = (e: MouseEvent) => {
    if (selX0 == null) {
      // 点击（非拖拽）→ 按 x 列命中单根：点在这根 K 线所在的列上就算选中，
      // 不像原生 onCandleBarClick 那样要求精确落在实体矩形里（间隙/空白高度点不中）
      // 落在未来空白区（无对应 bar）则撤掉选中
      if (e.button === 0 && Math.abs(e.clientX - downX) < 5) {
        const r = el.getBoundingClientRect();
        pickAtIndex(diOfX(e.clientX - r.left));
      }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect();
    const x0 = Math.min(selX0, e.clientX) - r.left, x1 = Math.max(selX0, e.clientX) - r.left;
    selX0 = null; sel.style.display = "none";
    // 框选模式下 mousedown 被拦截（stopPropagation），原生点击事件收不到：
    // 位移过小视为「点了一根 K 线」，手动补一次单根选中，两种模式手感一致
    if (x1 - x0 < 6) { pickAtIndex(diOfX(x1)); return; }
    const diOf = diOfX;
    const i0 = diOf(x0), i1 = diOf(x1);
    const list = chart.getDataList() as { timestamp: number; open: number; high: number; low: number; close: number; volume?: number; amount?: number }[];
    if (i0 == null || i1 == null || !list.length) return;
    const a = Math.max(0, Math.min(i0, i1)), b = Math.min(list.length - 1, Math.max(i0, i1));
    const seg = list.slice(a, b + 1);
    if (seg.length < 2) return;
    const s = seg[0], t = seg[seg.length - 1];
    // 区间涨跌基准 = 首根前一日收盘（与资金流区间同口径，策影同款），首根无前行时退回开盘
    const base = a > 0 ? list[a - 1].close : s.open;
    const hi = Math.max(...seg.map((x) => x.high)), lo = Math.min(...seg.map((x) => x.low));
    const amt = seg.reduce((q, x) => q + (x.amount ?? 0), 0);
    const vol = seg.reduce((q, x) => q + (x.volume ?? 0), 0);
    const upN = seg.filter((x) => x.close >= x.open).length;
    lastSel = {
      startDate: ymd(s.timestamp), endDate: ymd(t.timestamp), days: seg.length,
      changePct: base ? (t.close - base) / base * 100 : 0,
      amp: base ? (hi - lo) / base * 100 : 0,
      high: hi, low: lo, close: t.close,
      amount: amt, avgAmount: amt / seg.length, volume: vol,
      upN, downN: seg.length - upN, x0, x1,
    };
    selFund = null;
    drawSelTip();
    clearPickFn(true);            // 框出一段 → 单根选中让位（右卡只表达一个口径）
    document.dispatchEvent(new CustomEvent("yc:kl-range", { detail: { ...lastSel } }));
  };
  el.addEventListener("mousedown", onSelDown, true);
  el.addEventListener("mousemove", onSelMove, true);
  el.addEventListener("mouseup", onSelUp, true);

  /* ── 底部导航条（策影同款：缩略图 + 可见窗口日期范围文字 + 拖拽窗口平移 + 回到最新） ── */
  const nav = document.createElement("div");
  nav.className = "kl-nav";
  nav.innerHTML =
    `<div class="kl-nav-btns"><button data-j="first" title="跳到最早">⇤</button>` +
    `<button data-j="prev" title="向前一页">‹</button></div>` +
    `<canvas class="kl-nav-cv"></canvas>` +
    `<div class="kl-nav-win" title="拖动调整可见范围"><i></i><b></b></div>` +
    `<span class="kl-nav-time"></span>` +
    `<div class="kl-nav-btns r"><button data-j="next" title="向后一页">›</button>` +
    `<button data-j="last" title="回到最新">⇥</button></div>` +
    `<button class="kl-nav-latest" title="回到最新">最新 ›</button>`;
  el.appendChild(nav);
  const navCv = nav.querySelector("canvas")!;
  const navWin = nav.querySelector(".kl-nav-win") as HTMLElement;
  const navTime = nav.querySelector(".kl-nav-time") as HTMLElement;
  // 快速跳转（策影 navJump 同款：first / ±0.8 页 / last）
  nav.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-j]");
    if (!b) return;
    const list = chart.getDataList();
    const r = chart.getVisibleRange?.() as { from: number; to: number } | undefined;
    if (!list.length || !r) return;
    const vis = r.to - r.from;
    try {
      if (b.dataset.j === "first") chart.scrollToDataIndex(0, 0);
      else if (b.dataset.j === "last") chart.scrollToRealTime(0);
      else if (b.dataset.j === "prev") chart.scrollToDataIndex(Math.max(0, Math.round(r.from - vis * 0.8)), 0);
      else if (b.dataset.j === "next") chart.scrollToDataIndex(Math.min(Math.max(0, list.length - vis), Math.round(r.from + vis * 0.8)), 0);
    } catch { /* 忽略 */ }
  });

  /** 画全量 close 缩略线（涨跌分段染色），并按可见区间刷新窗口位置 */
  const navDraw = () => {
    const list = chart.getDataList() as { close: number }[];
    const w = navCv.clientWidth || 1, h = navCv.clientHeight || 1;
    const dpr = window.devicePixelRatio || 1;
    navCv.width = Math.round(w * dpr); navCv.height = Math.round(h * dpr);
    const ctx = navCv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    navCv.style.display = list.length > 1 ? "block" : "none";
    if (list.length > 1) {
      let mn = Infinity, mx = -Infinity;
      for (const x of list) { if (x.close < mn) mn = x.close; if (x.close > mx) mx = x.close; }
      const X = (i: number) => (i / (list.length - 1)) * w;
      const Y = (v: number) => h - 5 - ((v - mn) / (mx - mn || 1)) * (h - 10);
      ctx.lineWidth = 1;
      const up = chartUp(), dn = chartDown();
      for (let i = 1; i < list.length; i++) {
        ctx.strokeStyle = list[i].close >= list[i - 1].close ? up : dn;
        ctx.beginPath(); ctx.moveTo(X(i - 1), Y(list[i - 1].close)); ctx.lineTo(X(i), Y(list[i].close)); ctx.stroke();
      }
    }
    navUpdateWin();
  };
  const navUpdateWin = () => {
    const list = chart.getDataList() as { close: number; date?: string }[];
    const r = chart.getVisibleRange?.() as { from: number; to: number } | undefined;
    if (!list.length || !r) return;
    const L = list.length;
    const from = Math.max(0, Math.floor(r.from)), to = Math.min(L, Math.ceil(r.to));
    // 窗口定位相对缩略图画布区（两侧有跳转按钮占位）
    const cvL = navCv.offsetLeft, cvW = navCv.clientWidth;
    navWin.style.left = cvL + (from / L) * cvW + "px";
    navWin.style.width = Math.max(2, ((to - from) / L) * cvW) + "px";
    // 中心日期范围文字（策影同款）：跨度 ≥3 年用 YY/MM 紧凑格式，否则 YYYY-MM-DD；
    // 全量数据范围挂 nav 条 title（悬停可见「2022-03-01 ~ 2026-10-30 · 共 4 年 8 月」）
    const d = (i: number) => list[Math.max(0, Math.min(L - 1, i))]?.date || "";
    const s0 = d(from), s1 = d(to - 1);
    if (s0 && s1) {
      const spanYears = (new Date(s1).getTime() - new Date(s0).getTime()) / 31536e6;
      navTime.textContent = spanYears >= 3 ? `${s0.slice(2, 7)} ~ ${s1.slice(2, 7)}`
        : s0.includes(" ") ? `${s0.slice(11, 16)} ~ ${s1.slice(11, 16)}` : `${s0} ~ ${s1}`;
      const years = Math.floor(spanYears), months = Math.round((spanYears - years) * 12);
      nav.title = `全量 ${list[0]?.date ?? s0} ~ ${list[L - 1]?.date ?? s1}` +
        (years > 0 ? ` · 共 ${years} 年 ${months} 月` : "");
    } else navTime.textContent = "";
  };
  const onVisChange = () => { requestAnimationFrame(navUpdateWin); };
  try { chart.subscribeAction("onVisibleRangeChange", onVisChange as never); } catch { /* 忽略 */ }

  // 窗口拖拽：只平移不缩放（策影同款），pointer capture 跟手
  const navDrag = { x: 0, from: 0, count: 0 };
  navWin.addEventListener("pointerdown", (e) => {
    const r = chart.getVisibleRange?.() as { from: number; to: number } | undefined;
    if (!r) return;
    navDrag.x = e.clientX; navDrag.from = r.from; navDrag.count = r.to - r.from;
    navWin.setPointerCapture(e.pointerId);
    navWin.style.cursor = "grabbing";
  });
  navWin.addEventListener("pointermove", (e) => {
    if (!navWin.hasPointerCapture?.(e.pointerId)) return;
    const L = chart.getDataList().length;
    if (!L || !navCv.clientWidth) return;
    const nf = Math.max(0, Math.min(L - navDrag.count,
      navDrag.from + ((e.clientX - navDrag.x) / navCv.clientWidth) * L));
    try { chart.scrollToDataIndex(Math.round(nf), 0); } catch { /* 忽略 */ }
    navUpdateWin();
  });
  const navDragEnd = (e: PointerEvent) => {
    if (navWin.hasPointerCapture?.(e.pointerId)) navWin.releasePointerCapture(e.pointerId);
    navWin.style.cursor = "";
  };
  navWin.addEventListener("pointerup", navDragEnd);
  navWin.addEventListener("pointercancel", navDragEnd);
  nav.querySelector(".kl-nav-latest")!.addEventListener("click", () => {
    try { chart.scrollToRealTime(0); } catch { /* 忽略 */ }
  });

  /* ── 单根选中（点击蜡烛）：图上高亮该根，行情页把右列资金卡切到该交易日 ──
   *  · 用 v10 原生 onCandleBarClick（内部已区分「点击」与「拖拽平移」，不用自己判位移）
   *  · 唯一真相是「日期」而不是索引：盘中每 12s 重灌数据，索引会漂，日期不会
   *  · 与框选互斥：选中单根即撤区间、框出一段即撤单根（右卡同时只表达一个口径） */
  const pick = document.createElement("div");
  pick.className = "kl-pick";
  pick.style.display = "none";
  pick.innerHTML = "<b></b>";
  el.appendChild(pick);
  let pickDate: string | null = null;

  const drawPick = (): void => {
    if (!pickDate) { pick.style.display = "none"; return; }
    const list = chart.getDataList() as { date?: string }[];
    const i = list.findIndex((b) => (b.date ?? "") === pickDate);
    if (i < 0) { pick.style.display = "none"; return; }
    const px = chart.convertToPixel({ dataIndex: i }) as unknown;
    const x = (Array.isArray(px) ? px[0] : px)?.x as number | undefined;
    if (x == null) { pick.style.display = "none"; return; }
    const bs = chart.getBarSpace?.() as { bar: number } | undefined;
    const w = Math.max(2, Math.round(bs?.bar ?? 6));
    pick.style.display = "block";
    pick.style.left = `${Math.round(x - w / 2)}px`;
    pick.style.width = `${w}px`;
    // 高度到导航条上沿：选中带不压住缩略图
    pick.style.height = `${Math.max(40, el.clientHeight - nav.offsetHeight)}px`;
    pick.querySelector("b")!.textContent = pickDate;
  };

  /** 撤掉单根选中（notify=true 同步通知行情页退回当日口径） */
  const clearPickFn = (notify: boolean): void => {
    const had = pickDate != null;
    pickDate = null;
    pick.style.display = "none";
    pick.querySelector("b")!.textContent = "";    // 别留下上次的日期标签
    if (notify && had) document.dispatchEvent(new CustomEvent("yc:kl-pick", { detail: null }));
  };

  /** 选中第 di 根（越界=撤选中）；同一根重复点不重发，免得白拉一次资金接口 */
  const pickAtIndex = (di: number | undefined): void => {
    const list = chart.getDataList() as {
      timestamp: number; open: number; high: number; low: number; close: number;
      volume?: number; amount?: number; date?: string;
    }[];
    if (di == null || di < 0 || di >= list.length) { clearPickFn(true); return; }
    const bar = list[di];
    const date = bar.date ?? ymd(bar.timestamp);
    if (date === pickDate) return;
    const prev = di > 0 ? list[di - 1] : null;
    const base = prev?.close ?? bar.open;
    pickDate = date;
    drawPick();
    clearSel(false);                               // 单根与区间互斥（右卡的区间口径由行情页撤）
    document.dispatchEvent(new CustomEvent("yc:kl-pick", {
      detail: {
        date, index: di,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        prevClose: prev?.close ?? null,
        changePct: base ? (bar.close - base) / base * 100 : 0,
        amp: base ? (bar.high - bar.low) / base * 100 : 0,
        amount: bar.amount ?? 0, volume: bar.volume ?? 0,
      } as PickBar,
    }));
  };

  const onBarClick = (...args: unknown[]) => {
    pickAtIndex((args[0] as { dataIndex?: number } | null | undefined)?.dataIndex);
  };
  // 原生精确点击（点在蜡烛实体上）与上面的按列判定互为补充：重复点同一根会被去重
  try { chart.subscribeAction("onCandleBarClick", onBarClick as never); } catch { /* 忽略 */ }
  // 选中带跟着视窗走：缩放/滚动/可见范围变化都重算像素位置
  const onPickView = () => requestAnimationFrame(drawPick);
  try { chart.subscribeAction("onVisibleRangeChange", onPickView as never); } catch { /* 忽略 */ }
  try { chart.subscribeAction("onZoom", onPickView as never); } catch { /* 忽略 */ }
  try { chart.subscribeAction("onScroll", onPickView as never); } catch { /* 忽略 */ }

  // 智能高度（闭包函数：setSub 与 resize 内部也复用）
  const applyHeights = () => {
    const auto = localStorage.getItem("yc_autoh") !== "0";
    const panes = (chart.getPaneOptions() as { id: string }[])
      .filter((p) => p.id !== "candle_pane" && p.id !== "x_axis_pane");
    const { main, sub } = smartHeights(el.clientHeight, panes.length);
    try {
      chart.setPaneOptions({ id: "candle_pane", height: auto ? main : Math.max(200, el.clientHeight - panes.length * 100 - X_AXIS_H) });
      panes.forEach((p) => chart.setPaneOptions({ id: p.id, height: auto ? sub : 100 }));
    } catch { /* 忽略 */ }
  };

  let dataLen = 0;                     // 上一次灌入的 bar 数（判断「增量刷新」还是「换数据源」）

  const handle: KlineChartHandle = {
    chart,
    setData: (bars: Bar[], keepView = false) => {
      const list = bars.map((b) => ({
        timestamp: toTs(b.date), open: b.open, high: b.high, low: b.low,
        close: b.close, volume: b.volume ?? 0, amount: b.amount ?? 0,
        date: b.date,
      }));
      // 盘中的增量重灌（同标的同周期）不该把视图弹回最右：用户在翻历史时
      // 每 12s 被拽回最新，选中的那根也就跑出屏幕了 —— 记下窗口，重灌后原样恢复
      // 只在「同一份数据的增量刷新」里恢复：切到分时/60 分这类数量级差很大的数据源时
      // 旧范围（例如日线第 1900 根）在新列表里根本不存在，照着恢复会把图拽到空白区
      const vis = keepView && list.length > 0
        ? chart.getVisibleRange?.() as { from: number; to: number } | undefined
        : undefined;
      // 新旧列表得是同一量级（增量刷新差几十根以内）才谈得上恢复；
      // 空 → 分时 267 根、日线 2000 → 60 分 480 这种切换一律回到最新
      const sameScale = dataLen > 0 && Math.abs(list.length - dataLen) <= Math.max(5, dataLen * 0.15);
      const recoverable = sameScale && !!vis && vis.from >= 0 && vis.to <= list.length;
      // v10 的 scrollToDataIndex 把目标索引对到视口**右端**（nav 翻页也这么用），
      // 所以恢复视图要传右边缘那根，而不是 from
      const keepIdx = recoverable ? Math.max(0, Math.round(vis!.to) - 1) : null;
      dataLen = list.length;
      tip.style.display = "none";                          // 数据重载时收起旧卡片
      // v10 无 applyNewData，经 DataLoader 一次性回填（策影同款）
      chart.setDataLoader({ getBars: (params) => { params.callback(list, false); } });
      // 重灌数据后索引会变，选中带按日期重新定位（盘中轮询 12s 一次，必须跟着走）
      requestAnimationFrame(() => {
        navDraw();
        try {
          if (keepIdx != null) chart.scrollToDataIndex(keepIdx, 0);
          else chart.scrollToRealTime(0);
        } catch { /* 忽略 */ }
        drawPick();
      });
      // setDataLoader 的首次回填是异步的：等数据真正就绪后再校一次视图，
      // 否则恢复动作会被后续的加载回调覆盖（视图又跳回默认位置）
      if (keepIdx != null) window.setTimeout(() => {
        try { chart.scrollToDataIndex(keepIdx, 0); } catch { /* 忽略 */ }
        drawPick();
      }, 160);
    },
    setMain(inds: MainKey[]) {
      // 主图多选叠加（策影同款）：先按实例移除不再选中的，再增量补建缺失的（注册表驱动）
      const defs = inds.map((k) => IND_BY_KEY[k]).filter((d): d is IndDef => !!d && d.where === "main");
      const want = new Set(defs.map((d) => d.kc));
      const mainKcs = IND_DEFS.filter((d) => d.where === "main").map((d) => d.kc);
      chart.getIndicators({ paneId: "candle_pane" }).forEach((i) => {
        if (mainKcs.includes(i.name) && !want.has(i.name))
          chart.removeIndicator({ id: i.id });
      });
      const have = new Set(chart.getIndicators({ paneId: "candle_pane" }).map((i) => i.name));
      for (const d of defs) {
        if (have.has(d.kc)) continue;
        if (d.key === "ma") {
          // MA 配色与页面图例一致：MA5 琥珀 / MA10 蓝 / MA20 VIP 金
          chart.createIndicator({
            name: "MA", paneId: "candle_pane", calcParams: [5, 10, 20], isStack: true,
            styles: { lines: [{ color: cssv("--accent") || "#FF9F43" }, { color: "#0A84FF" }, { color: cssv("--vip") || "#FFD60A" }] },
          } as never, true);
        } else if (d.key === "boll") {
          const dim = cssv("--dim") || "#A1A1A6";
          chart.createIndicator({
            name: "BOLL", paneId: "candle_pane", isStack: true,
            styles: { lines: [{ color: dim }, { color: dim }, { color: dim }] },
          } as never, true);
        } else if (d.key === "avg") {
          chart.createIndicator({ name: "TIME_AVG", paneId: "candle_pane", isStack: true } as never, true);
        } else {
          chart.createIndicator({ name: d.kc, paneId: "candle_pane", isStack: true } as never, true);
        }
      }
    },
    setSub(inds: SubKey[]) {
      // 副图多选：全清后按固定顺序重建，每指标一个窗格（注册表驱动）
      chart.getIndicators()
        .filter((i) => i.paneId !== "candle_pane")
        .forEach((i) => chart.removeIndicator({ id: i.id }));
      const up = chartUp(), dn = chartDown();
      for (const k of inds) {
        const d = IND_BY_KEY[k];
        if (!d || d.where !== "sub") continue;
        if (d.key === "vol") {
          // 自研 VOLX：MA5/MA10/MA40 三条均量线（v10 内置 VOL 忽略第三参数）；
          // 禁用大数格式化，轴/图例文本走万/亿；量柱红绿走注册内的 figure styles
          chart.createIndicator({
            name: "VOLX", shouldFormatBigNumber: false,
            styles: { bars: [{ upColor: up, downColor: dn, noChangeColor: NEUTRAL }] },
          } as never, false);
        } else if (d.key === "macd") {
          chart.createIndicator({
            name: "MACD",
            styles: { bars: [{ upColor: up, downColor: dn, noChangeColor: NEUTRAL }] },
          } as never, false);
        } else if (d.key === "sixseg") {
          // 六分段趋势（K线下方叠加）：60 窗口分位 1..6 段台阶线
          chart.createIndicator({ name: "SIXSEG", precision: 0 } as never, false);
        } else {
          chart.createIndicator({ name: d.kc } as never, false);
        }
      }
      // 窗格高度交给智能高度统一分配（含 candle_pane）
      applyHeights();
    },
    setPeriod(p: TipPeriod) {
      period = p;
    },
    applyHeights,
    zoom(factor: number) {
      const bs = chart.getBarSpace?.() as { bar: number } | undefined;
      if (!bs?.bar) return;
      try { chart.setBarSpace(Math.min(50, Math.max(1, bs.bar * factor))); } catch { /* 忽略 */ }
    },
    viewBars(n: number) {
      const w = el.clientWidth;
      if (!w) return;
      try {
        chart.setBarSpace(Math.min(50, Math.max(1, w / n)));
        chart.scrollToRealTime(0);
      } catch { /* 忽略 */ }
    },
    resetView() {
      try {
        chart.setBarSpace(Math.min(50, Math.max(1, el.clientWidth / 16)));
        chart.scrollToRealTime(0);
      } catch { /* 忽略 */ }
    },
    navRefresh() { requestAnimationFrame(navDraw); },
    setRangeMode(on: boolean) {
      rangeMode = on;
      sel.style.cursor = on ? "crosshair" : "";
      el.style.cursor = on ? "crosshair" : "";
      try { chart.setScrollEnabled(!on); } catch { /* 老版本无此 API 时退化为仅 Shift 手势 */ }
      if (!on) clearSel(true);
    },
    isRangeMode() { return rangeMode; },
    setRangeFund(f: RangeFund | null) {
      selFund = f;
      drawSelTip();
    },
    clearRange(notify = true) { clearSel(notify); },
    clearPick(notify = true) { clearPickFn(notify); },
    drawLegend,
    retheme() { chart.setStyles(styles()); requestAnimationFrame(navDraw); },
    resize() {
      chart.resize();
      requestAnimationFrame(() => { applyHeights(); navDraw(); drawPick(); });
    },
    destroy() {
      try { chart.unsubscribeAction("onCrosshairChange", onCross as never); } catch { /* 忽略 */ }
      try { chart.unsubscribeAction("onCandleBarClick", onBarClick as never); } catch { /* 忽略 */ }
      try { chart.unsubscribeAction("onVisibleRangeChange", onPickView as never); } catch { /* 忽略 */ }
      try { chart.unsubscribeAction("onZoom", onPickView as never); } catch { /* 忽略 */ }
      try { chart.unsubscribeAction("onScroll", onPickView as never); } catch { /* 忽略 */ }
      el.removeEventListener("mousedown", onSelDown, true);
      el.removeEventListener("mousemove", onSelMove, true);
      el.removeEventListener("mouseup", onSelUp, true);
      sel.remove();
      selTip.remove();
      tip.remove();
      legend.remove();
      pick.remove();
      nav.remove();
      dispose(el);
    },
  };
  return handle;
}
