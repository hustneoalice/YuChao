/** 众赢4.1.14 sys_index1.xml「趋势柱线」公式移植，尚未与原软件逐点核对。
 * 动态EMA逐根使用当前周期；EMA首值取CHL；不足滚动窗口用已有样本。
 * 中期MA15要求15个有效值；波幅为零时留空。
 */
export function trendHistogramSeries(bars: readonly {high: number; low: number; close: number}[]): {short: number | null; base: number | null}[] {
  const periods = [5, 8, 13, 21, 34, 55, 89];
  const ema = periods.map(() => 0);
  const tr: number[] = [], rangeMean: number[] = [], short: (number | null)[] = [];
  const mean = (values: readonly number[], i: number, n: number) => {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += values[j];
    return sum / n;
  };
  return bars.map((bar, i) => {
    const count = i + 1;
    const chl = (bar.high + bar.low + 3 * bar.close) / 5;
    const m = periods.map(n => Math.min(count, n));
    const ma = m.map((n, j) => {
      ema[j] = i === 0 ? chl : (2 * chl + (n - 1) * ema[j]) / (n + 1);
      return (chl + n * ema[j]) / (n + 1);
    });
    const prev = bars[i - 1]?.close ?? bar.close;
    tr.push(Math.max(bar.high - bar.low, bar.high - prev, prev - bar.low));
    rangeMean.push(mean(tr, i, m[5]));
    const volatility = mean(rangeMean, i, m[4]);
    const value = volatility === 0 ? null : ((ma[0]-ma[1])+(ma[1]-ma[2])+(ma[2]-ma[3])+(ma[3]-ma[4])+(ma[4]-ma[5])*m[2]/m[3]+(ma[5]-ma[6])*m[2]/m[4])*100/(volatility*4);
    short.push(value);
    const window = short.slice(Math.max(0, i - 14), i + 1);
    const base = window.length === 15 && window.every(v => v !== null)
      ? (window as number[]).reduce((sum, v) => sum + v, 0) / 15 : null;
    return {short: value, base};
  });
}
