/** 图表右上角齿轮组：主图与各副图的指标设置按钮统一排成一行 */
export function gearHost(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>(":scope > .kl-gears");
  if (found) return found;
  const host = document.createElement("div");
  host.className = "kl-gears";
  el.appendChild(host);
  return host;
}
