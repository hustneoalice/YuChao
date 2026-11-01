/* 数字 / 文案格式化与 CSS 变量读取 */
export function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtChg(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return (v > 0 ? "+" : "") + v.toFixed(2);
}
/** 金额（元）→ 亿 / 万亿字符串（≥1 万亿自动进位，避免出现 298,030.32亿 这种读数） */
export function fmtYi(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (Math.abs(v) >= 1e12) return fmt(v / 1e12, digits) + "万亿";
  return fmt(v / 1e8, digits) + "亿";
}
/** 金额（元）→ 带方向符号的亿/万亿：流入显式 "+"，流出"-"，0 不带号。
    资金流卡专用 —— 散户读资金先看方向再看量级，符号必须显式。
    小于半个最小显示单位（默认 0.005 亿 = 50 万）不做符号，避免出现 "-0.00亿" 这种负零。 */
export function fmtYiS(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (Math.abs(v) < 0.5 * Math.pow(10, 8 - digits)) return fmt(0, digits) + "亿";
  return (v > 0 ? "+" : "") + fmtYi(v, digits);
}
export function fmtVol(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (v >= 1e8) return fmt(v / 1e8, 2) + "亿";
  if (v >= 1e4) return fmt(v / 1e4, 1) + "万";
  return String(Math.round(v));
}
export function cssv(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
/** 日期 2026-10-27 → 10/27 */
export function dlab(d: string): string {
  const s = d.replace(/-/g, "/");
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(i + 1) : s;
}
export function dtlab(d: string): string {
  return d ? d.replaceAll("-", "/").slice(2) : "";
}
export function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
