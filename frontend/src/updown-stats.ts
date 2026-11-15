/** 涨跌线段统计（日内高低点 ZigZag）
 *  · 拐点取「日内最高 / 最低」所在的那根 K 线：上一段的终点与下一段的起点是同一根、
 *    同一个价（510880 于 2023-05-09 冲高 3.285，高点既是上一波上涨的终点，也是下跌的起点）。
 *  · 有效阈值 10%：低点 → 高点涨 >10% 才算一段有效上涨；随后回落到 10% 才确认转跌，
 *    否则原上涨段继续延伸、起点仍为原上涨起点；下跌同理。
 *  · 8%~10% 的回撤 / 反弹记为「无效线段」，图上用灰色连线标出，说明趋势为何继续。
 *  · 统计全量数据的有效上涨 / 下跌次数、平均幅度与上涨段占比。
 */

export const UD_VALID = 0.10;
export const UD_NEAR = 0.08;

export interface UdSegment {
  /** 起止 bar 下标 */
  from: number;
  to: number;
  /** 起止价（枢轴口径：上涨段终点=最高价，下跌段终点=最低价） */
  fromPrice: number;
  toPrice: number;
  /** 1 = 上涨段，-1 = 下跌段 */
  dir: 1 | -1;
  /** 段涨跌幅（%，涨为正、跌为负） */
  pct: number;
  /** |pct| 是否超过有效阈值 */
  valid: boolean;
}

export interface UdStats {
  upN: number;
  downN: number;
  /** 有效上涨段占全部有效段（上涨 + 下跌）的百分比 */
  upPct: number;
  /** 有效上涨段平均涨幅（%） */
  upAvg: number;
  /** 有效下跌段平均跌幅（%，负数） */
  downAvg: number;
  segs: UdSegment[];
}

/** 枢轴：某根 bar 上的极值价 */
interface Ext {
  i: number;
  p: number;
}

export function upDownStats(
  bars: readonly { high: number; low: number }[],
  valid = UD_VALID,
  near = UD_NEAR,
): UdStats {
  const segs: UdSegment[] = [];
  const n = bars.length;
  if (n < 3) return { upN: 0, downN: 0, upPct: 0, upAvg: 0, downAvg: 0, segs };

  const push = (from: Ext, to: Ext, dir: 1 | -1): void => {
    if (!(from.p > 0) || !(to.p > 0) || from.i === to.i) return;
    const pct = ((to.p - from.p) / from.p) * 100;
    segs.push({ from: from.i, to: to.i, fromPrice: from.p, toPrice: to.p,
                dir, pct, valid: Math.abs(pct) > valid * 100 });
  };

  const finish = (): UdStats => {
    segs.sort((a, b) => a.from - b.from || a.to - b.to);
    const ups = segs.filter((s) => s.valid && s.dir === 1);
    const downs = segs.filter((s) => s.valid && s.dir === -1);
    const total = ups.length + downs.length;
    const mean = (list: UdSegment[]): number =>
      list.length ? list.reduce((sum, s) => sum + s.pct, 0) / list.length : 0;
    return {
      upN: ups.length,
      downN: downs.length,
      upPct: total ? (ups.length / total) * 100 : 0,
      upAvg: mean(ups),
      downAvg: mean(downs),
      segs,
    };
  };

  // 首段方向：高低区间先按顺势走满 10% 的一对极值，时间在前的那个做起点
  let hi: Ext = { i: 0, p: bars[0].high };
  let lo: Ext = { i: 0, p: bars[0].low };
  let dir: 1 | -1 | 0 = 0;
  let anchor: Ext = lo;
  let ext: Ext = hi;
  let from = 1;
  for (let i = 1; i < n; i++) {
    const b = bars[i];
    if (b.high > hi.p) hi = { i, p: b.high };
    if (b.low < lo.p) lo = { i, p: b.low };
    if (hi.i === lo.i) continue;
    const span = hi.p - lo.p;
    // 低点在前：上涨须涨满 10%；高点在前：下跌须跌满 10%
    if (lo.i < hi.i && span / lo.p >= valid) {
      anchor = lo; ext = hi; dir = 1;
    } else if (hi.i < lo.i && span / hi.p >= valid) {
      anchor = hi; ext = lo; dir = -1;
    } else {
      continue;
    }
    from = Math.max(hi.i, lo.i) + 1;
    break;
  }
  if (!dir) {
    // 全序列没走出 10% 摆动：只留一条无效段（线短到画不出，卡片统计为空）
    if (hi.i !== lo.i) {
      const up = lo.i < hi.i;
      push(up ? lo : hi, up ? hi : lo, up ? 1 : -1);
    }
    return finish();
  }

  let pend: Ext | null = null;   // 趋势内 8%~10% 的回撤 / 反弹极值（灰色无效线段）
  for (let i = from; i < n; i++) {
    const b = bars[i];
    if (dir === 1) {
      if (b.high > ext.p) {
        // 新高否定回撤：8% 以上的无效下跌补一条灰线，原上涨段起点不变
        if (pend) push(ext, pend, -1);
        ext = { i, p: b.high };
        pend = null;
      } else {
        const dd = (ext.p - b.low) / ext.p;
        if (dd > valid) {
          // 反转确认：本段终点 = 下一段起点（同一个高点）
          push(anchor, ext, 1);
          anchor = ext;
          dir = -1;
          ext = { i, p: b.low };
          pend = null;
        } else if (dd > near && (!pend || b.low < pend.p)) {
          pend = { i, p: b.low };
        }
      }
    } else {
      if (b.low < ext.p) {
        if (pend) push(ext, pend, 1);
        ext = { i, p: b.low };
        pend = null;
      } else {
        const rb = (b.high - ext.p) / ext.p;
        if (rb > valid) {
          push(anchor, ext, -1);
          anchor = ext;
          dir = 1;
          ext = { i, p: b.high };
          pend = null;
        } else if (rb > near && (!pend || b.high > pend.p)) {
          pend = { i, p: b.high };
        }
      }
    }
  }

  // 收尾：把当前未反转段画到极值；仍在进行中的 8%~10% 回撤也补灰线
  push(anchor, ext, dir);
  if (pend) push(ext, pend, dir === 1 ? -1 : 1);
  return finish();
}
