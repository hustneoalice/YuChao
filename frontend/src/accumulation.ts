/** 众赢 4.1.14 sys_index1.xml「主力吸筹」公式移植，尚未与原软件逐点核对。
 * REF 首日取当前值；SMA/EMA 首个有效值初始化；零分母输出空值。
 * 指标根据价格推导，并非机构账户的实际买入资金。
 */
export function accumulationSeries(bars: readonly { low: number; close: number }[]): (number | null)[] {
  let absSma = 0, upSma = 0;
  let var4: number | null = null, var8: number | null = null;
  const smoothed: (number | null)[] = [];
  return bars.map((bar, i) => {
    const diff = bar.low - (bars[i - 1]?.low ?? bar.low);
    absSma = (2 * absSma + Math.abs(diff)) / 3;
    upSma = (2 * upSma + Math.max(diff, 0)) / 3;
    if (upSma === 0) { smoothed.push(null); return null; }
    const var3 = absSma / upSma * 100;
    // 原式 IF(CLOSE*1.2,...) 是数值条件，不是涨幅判断。
    const input = bar.close * 1.2 !== 0 ? var3 * 10 : var3 / 10;
    var4 = var4 === null ? input : (input + var4) / 2;
    smoothed.push(var4);
    let low38 = Infinity, low90 = Infinity, high38 = -Infinity;
    for (let j = Math.max(0, i - 89); j <= i; j++) {
      low90 = Math.min(low90, bars[j].low);
      if (j >= i - 37) {
        low38 = Math.min(low38, bars[j].low);
        if (smoothed[j] !== null) high38 = Math.max(high38, smoothed[j]!);
      }
    }
    const target = bar.low <= low38 ? (var4 + high38 * 2) / 2 : 0;
    var8 = var8 === null ? target : (target + var8) / 2;
    return var8 / 618 * (low90 !== 0 ? 1 : 0);
  });
}
