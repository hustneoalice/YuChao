/** 涨跌线段统计（收盘价 ZigZag）
 *  · 有效阈值 10%：上涨 >10% 才算一段有效上涨；随后回撤 <10% 不构成有效下跌，
 *    原上涨段继续延伸、起点仍为原上涨起点；下跌同理。
 *  · 8%~10% 的回撤 / 反弹记为「无效线段」，图上用灰色连线标出，说明趋势为何继续。
 *  · 统计全量数据的有效上涨 / 下跌次数、平均幅度与上涨段占比。
 */

export const UD_VALID = 0.10;
export const UD_NEAR = 0.08;

export interface UdSegment {
  /** 起止 bar 下标 */
  from: number;
  to: number;
  /** 起止价格（收盘价口径） */
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

export function upDownStats(
  bars: readonly { close: number }[],
  valid = UD_VALID,
  near = UD_NEAR,
): UdStats {
  const segs: UdSegment[] = [];
  const n = bars.length;
  const empty: UdStats = { upN: 0, downN: 0, upPct: 0, upAvg: 0, downAvg: 0, segs };
  if (n < 3) return empty;

  const close = bars.map((b) => b.close);
  const push = (from: number, fromPrice: number, to: number, toPrice: number, dir: 1 | -1): void => {
    if (!(fromPrice > 0) || !(toPrice > 0) || from === to) return;
    const pct = ((toPrice - fromPrice) / fromPrice) * 100;
    segs.push({ from, to, fromPrice, toPrice, dir, pct, valid: Math.abs(pct) > valid * 100 });
  };

  // 从首根开始先按上涨段跟踪：首段即使不足 10%，也会在反向 10% 出现时
  // 作为无效线段（8%~10% 灰色）落地，起点始终是这段真正的高低点
  let dir: 1 | -1 = 1;
  let anchorIdx = 0, anchorPrice = close[0];
  let extIdx = 0, extPrice = close[0];
  let pendIdx = -1, pendPrice = 0;  // 趋势内 8%~10% 的回撤 / 反弹极值

  for (let i = 1; i < n; i++) {
    const c = close[i];
    if (dir === 1) {
      if (c > extPrice) {
        // 新高否定回撤：8% 以上的无效下跌补一条灰线，原上涨段起点不变
        if (pendIdx >= 0) push(extIdx, extPrice, pendIdx, pendPrice, -1);
        extIdx = i; extPrice = c; pendIdx = -1;
      } else {
        const dd = (extPrice - c) / extPrice;
        if (dd > valid) {
          push(anchorIdx, anchorPrice, extIdx, extPrice, 1);
          anchorIdx = extIdx; anchorPrice = extPrice;
          dir = -1; extIdx = i; extPrice = c; pendIdx = -1;
        } else if (dd > near && (pendIdx < 0 || c < pendPrice)) {
          pendIdx = i; pendPrice = c;
        }
      }
    } else {
      if (c < extPrice) {
        if (pendIdx >= 0) push(extIdx, extPrice, pendIdx, pendPrice, 1);
        extIdx = i; extPrice = c; pendIdx = -1;
      } else {
        const rb = (c - extPrice) / extPrice;
        if (rb > valid) {
          push(anchorIdx, anchorPrice, extIdx, extPrice, -1);
          anchorIdx = extIdx; anchorPrice = extPrice;
          dir = 1; extIdx = i; extPrice = c; pendIdx = -1;
        } else if (rb > near && (pendIdx < 0 || c > pendPrice)) {
          pendIdx = i; pendPrice = c;
        }
      }
    }
  }

  // 收尾：把当前未反转段画到极值；仍在进行中的 8%~10% 回撤也补灰线
  push(anchorIdx, anchorPrice, extIdx, extPrice, dir);
  if (pendIdx >= 0) push(extIdx, extPrice, pendIdx, pendPrice, dir === 1 ? -1 : 1);
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
}
