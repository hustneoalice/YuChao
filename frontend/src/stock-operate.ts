/** 众赢 4.1.14 sys_index1.xml「个股操盘」公式移植，尚未与原软件逐点核对。
 * Z:=MA(C,120)；VAR3:=(MA(C,5)-Z)/Z；
 * VAR4:=MA((C-LLV(L,10))/(HHV(H,10)-LLV(L,10))*100,3)；
 * 波段/反弹/超跌进场：成立画 80、不成立画 50；
 * 红柱= C>=MA(C,10)，绿柱= C<MA(C,10)，由 VAR4 连到 REF(VAR4,1)。
 * 高低区间为 0 时按 0 处理；不足 120 根时 Z 与 VAR3 留空，仅红绿柱仍按 MA10 画。
 */
export type StockOperatePoint = {
  var4: number | null;
  band: number | null;
  rebound: number | null;
  oversold: number | null;
  red: boolean | null;
};

export function stockOperateSeries(
  bars: readonly { high: number; low: number; close: number }[],
): StockOperatePoint[] {
  const raw: number[] = [];
  let s5 = 0, s10 = 0, s120 = 0;
  return bars.map((bar, i) => {
    s5 += bar.close; if (i >= 5) s5 -= bars[i - 5].close;
    s10 += bar.close; if (i >= 10) s10 -= bars[i - 10].close;
    s120 += bar.close; if (i >= 120) s120 -= bars[i - 120].close;
    const ma5 = i >= 4 ? s5 / 5 : null;
    const ma10 = i >= 9 ? s10 / 10 : null;
    const ma120 = i >= 119 ? s120 / 120 : null;
    let low = Infinity, high = -Infinity;
    for (let j = Math.max(0, i - 9); j <= i; j++) {
      low = Math.min(low, bars[j].low);
      high = Math.max(high, bars[j].high);
    }
    const span = high - low;
    raw.push(span === 0 ? 0 : (bar.close - low) / span * 100);
    const var4 = i >= 2 ? (raw[i] + raw[i - 1] + raw[i - 2]) / 3 : null;
    const prev1 = i >= 1 ? var4At(raw, i - 1) : null;
    const prev2 = i >= 2 ? var4At(raw, i - 2) : null;
    const var3 = ma120 != null && ma5 != null && ma120 !== 0 ? (ma5 - ma120) / ma120 : null;
    let band: number | null = null, rebound: number | null = null, oversold: number | null = null;
    if (var4 != null && prev1 != null && prev2 != null) {
      band = ma120 != null && bar.close > ma120 && prev1 < 30 && var4 > prev1 && prev1 < prev2 ? 80 : 50;
      rebound = prev1 < 5 && var4 > prev1 && prev1 < prev2 && var3 != null && var3 < -0.3 ? 80 : 50;
      oversold = var4 > 5 && prev1 <= 5 && var3 != null && var3 < -0.4 ? 80 : 50;
    }
    return { var4, band, rebound, oversold, red: ma10 == null ? null : bar.close >= ma10 };
  });
}

/** VAR4 的前值：raw 的 3 日均值（i>=2 才有） */
function var4At(raw: readonly number[], i: number): number | null {
  return i >= 2 ? (raw[i] + raw[i - 1] + raw[i - 2]) / 3 : null;
}
