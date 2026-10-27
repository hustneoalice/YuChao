/* 数字 / 文案格式化与 CSS 变量读取 */
export function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtChg(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return (v > 0 ? "+" : "") + v.toFixed(2);
}
/** 金额（元）→ 亿元字符串 */
export function fmtYi(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return fmt(v / 1e8, digits) + "亿";
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
