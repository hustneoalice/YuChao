/* 指标样式设置：主力吸筹形态 + 阶段拐点标记
 *  · 吸筹样式挂在「主力吸筹」自己的副图右上角（与成交量/BIAS 齿轮同款位置）
 *  · 拐点标记属于主图叠加，留在主图右上角齿轮里
 *  · 两处都是点开浮层即时切换，记住到本地
 *  · 绘制侧每帧读缓存，切换后只需让图表重绘一次 */
import type { Chart } from "klinecharts";
import { ic } from "./icons";
import type { QyjjStyle } from "./qyjj";
import { gearHost } from "./chart-gears";

export type AccStyle = "water" | "bar";

export const ACC_STYLES: { key: AccStyle; label: string; hint: string }[] = [
  { key: "water", label: "水位面积", hint: "零轴填充 + 峰值点" },
  { key: "bar", label: "空心柱", hint: "跟随主题色描边，不再是品红" },
];

export const QYJJ_STYLES: { key: QyjjStyle; label: string; hint: string }[] = [
  { key: "badge", label: "胶囊箭头", hint: "识别度最高" },
  { key: "tri", label: "三角", hint: "贴价，不遮 K 线" },
  { key: "dot", label: "圆点", hint: "最轻，信号密集时清爽" },
  { key: "hook", label: "钩形", hint: "兜底 / 盖顶，呼应「拐头」" },
  { key: "flag", label: "小旗", hint: "插旗标记，方向最直观" },
];

const ACC_KEY = "yc_acc_style";
const QYJJ_KEY = "yc_qyjj_style";

let accCache: AccStyle | null = null;
let qyjjCache: QyjjStyle | null = null;

export function readAccumulationStyle(): AccStyle {
  if (accCache == null) {
    accCache = localStorage.getItem(ACC_KEY) === "bar" ? "bar" : "water";
  }
  return accCache;
}

export function readQyjjStyle(): QyjjStyle {
  if (qyjjCache == null) {
    const saved = localStorage.getItem(QYJJ_KEY);
    qyjjCache = QYJJ_STYLES.some((s) => s.key === saved) ? (saved as QyjjStyle) : "badge";
  }
  return qyjjCache;
}

function writeStyle(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 忽略 */ }
}

const optsOf = (group: string, items: { key: string; label: string; hint: string }[]) =>
  `<div class="spop-opts" data-group="${group}">` + items.map((s) =>
    `<button type="button" class="spop-opt" data-k="${s.key}" title="${s.hint}">${s.label}</button>`).join("") + `</div>`;

/* 定位：右对齐按钮、下方优先，放不下翻到上方，左右贴边夹取 */
function placeNear(button: HTMLElement, pop: HTMLElement): void {
  if (pop.hidden) return;
  const b = button.getBoundingClientRect();
  pop.style.maxHeight = "";
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const edge = 8, gap = 6;
  const below = window.innerHeight - b.bottom - gap - edge;
  const above = b.top - gap - edge;
  const up = h > below && above > below;
  const room = up ? above : below;
  const left = Math.max(edge, Math.min(b.right - w, window.innerWidth - w - edge));
  const top = up ? Math.max(edge, b.top - gap - Math.min(h, room)) : b.bottom + gap;
  if (h > room) pop.style.maxHeight = `${Math.max(96, room)}px`;
  pop.classList.toggle("up", up);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

/** 副图齿轮的通用定位：锚绘图区右缘，让出最右侧 ✕ 的 20px 位置。
 *  Y 轴宽度 auto 会随刻度变，锚容器右边会飘进轴里，所以横向按绘图区右缘算。 */
function placeInPane(
  chart: Chart, el: HTMLElement, paneId: string,
  button: HTMLElement, observer: ResizeObserver,
): void {
  const pane = chart.getDom(paneId);
  if (!pane) return;
  const elRect = el.getBoundingClientRect();
  const plot = chart.getDom(paneId, "main");
  const plotRight = (plot ?? pane).getBoundingClientRect().right - elRect.left;
  button.style.left = `${Math.round(plotRight - 52)}px`;
  button.style.top = `${Math.round(pane.getBoundingClientRect().top - elRect.top + 4)}px`;
  if (plot) observer.observe(plot);
}

/** 主图齿轮「指标样式」：阶段拐点标记的样式（吸筹样式在它自己的副图齿轮里） */
export function mountIndicatorStyles(chart: Chart, el: HTMLElement, onChange: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kl-sstyle";
  button.innerHTML = ic("gear", 13);
  button.title = "阶段拐点标记样式";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-haspopup", "dialog");
  gearHost(el).appendChild(button);

  const pop = document.createElement("div");
  pop.className = "vpop spop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "阶段拐点标记样式");
  pop.innerHTML = `<div class="vpop-head"><b>阶段拐点标记</b><span class="mono">MARK</span>
      <button type="button" class="vpop-x" aria-label="关闭">${ic("x", 11)}</button></div>
    <div class="vpop-body">
      <div class="spop-group">${optsOf("qyjj", QYJJ_STYLES)}</div>
    </div>
    <p class="vpop-tip">点选立即生效；样式只影响绘制，不改指标数值。</p>
    <div class="vpop-foot">
      <button type="button" class="vpop-reset">恢复默认</button>
    </div>`;
  document.body.appendChild(pop);

  const qyjjButtons = [...pop.querySelectorAll<HTMLButtonElement>('[data-group="qyjj"] .spop-opt')];

  const paint = (): void => {
    qyjjButtons.forEach((b) => b.classList.toggle("on", b.dataset.k === readQyjjStyle()));
  };

  const place = (): void => placeNear(button, pop);
  const reflow = (): void => { place(); requestAnimationFrame(place); };

  const open = (): void => {
    paint();
    pop.hidden = false;
    button.classList.add("on");
    button.setAttribute("aria-expanded", "true");
    reflow();
  };
  const close = (): void => {
    if (pop.hidden) return;
    pop.hidden = true;
    button.classList.remove("on");
    button.setAttribute("aria-expanded", "false");
  };

  button.onclick = (event) => {
    event.stopPropagation();
    if (pop.hidden) open(); else close();
  };
  pop.querySelector<HTMLElement>(".vpop-x")!.onclick = () => { close(); button.focus(); };

  /* 点选即时写入并重绘；不设「应用」，避免样式与图上效果不同步 */
  qyjjButtons.forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.k as QyjjStyle;
      writeStyle(QYJJ_KEY, v);
      qyjjCache = v;
      paint();
      onChange();
    };
  });

  pop.querySelector<HTMLElement>(".vpop-reset")!.onclick = () => {
    writeStyle(QYJJ_KEY, "badge");
    qyjjCache = "badge";
    paint();
    onChange();
  };

  /* 点空白 / Esc 关闭；Esc 捕获阶段拦下，别顺带清掉图上的选中与框选 */
  const onDocDown = (event: PointerEvent): void => {
    if (pop.hidden) return;
    const t = event.target as Node;
    if (!pop.contains(t) && !button.contains(t)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || pop.hidden) return;
    event.stopPropagation();
    close();
    button.focus();
  };
  const onViewport = (): void => reflow();
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, true);

  const observer = new ResizeObserver(() => reflow());
  observer.observe(el);
  return {
    sync: reflow,
    destroy: () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", onDocDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
      button.remove();
      pop.remove();
    },
  };
}

/** 主力吸筹副图自己的齿轮：只管形态（水位面积 / 空心柱），位置与成交量齿轮一致 */
export function mountAccumulationStyle(chart: Chart, el: HTMLElement, onChange: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kl-vset kl-vpane";
  button.innerHTML = ic("gear", 13);
  button.title = "主力吸筹样式";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-haspopup", "dialog");
  el.appendChild(button);

  const pop = document.createElement("div");
  pop.className = "vpop spop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "主力吸筹样式");
  pop.innerHTML = `<div class="vpop-head"><b>主力吸筹样式</b><span class="mono">ACC</span>
      <button type="button" class="vpop-x" aria-label="关闭">${ic("x", 11)}</button></div>
    <div class="vpop-body">
      <div class="spop-group"><div class="spop-title">形态</div>${optsOf("acc", ACC_STYLES)}</div>
    </div>
    <p class="vpop-tip">点选立即生效；样式只影响绘制，不改指标数值。</p>
    <div class="vpop-foot">
      <button type="button" class="vpop-reset">恢复默认</button>
    </div>`;
  document.body.appendChild(pop);

  const accButtons = [...pop.querySelectorAll<HTMLButtonElement>('[data-group="acc"] .spop-opt')];

  const paint = (): void => {
    accButtons.forEach((b) => b.classList.toggle("on", b.dataset.k === readAccumulationStyle()));
  };

  const place = (): void => placeNear(button, pop);
  const reflow = (): void => { place(); requestAnimationFrame(place); };

  const open = (): void => {
    paint();
    pop.hidden = false;
    button.classList.add("on");
    button.setAttribute("aria-expanded", "true");
    reflow();
  };
  const close = (): void => {
    if (pop.hidden) return;
    pop.hidden = true;
    button.classList.remove("on");
    button.setAttribute("aria-expanded", "false");
  };

  button.onclick = (event) => {
    event.stopPropagation();
    if (pop.hidden) open(); else close();
  };
  pop.querySelector<HTMLElement>(".vpop-x")!.onclick = () => { close(); button.focus(); };

  accButtons.forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.k as AccStyle;
      writeStyle(ACC_KEY, v);
      accCache = v;
      paint();
      onChange();
    };
  });

  pop.querySelector<HTMLElement>(".vpop-reset")!.onclick = () => {
    writeStyle(ACC_KEY, "water");
    accCache = "water";
    paint();
    onChange();
  };

  const onDocDown = (event: PointerEvent): void => {
    if (pop.hidden) return;
    const t = event.target as Node;
    if (!pop.contains(t) && !button.contains(t)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || pop.hidden) return;
    event.stopPropagation();
    close();
    button.focus();
  };
  const onViewport = (): void => reflow();
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, true);

  const sync = (): void => {
    const indicator = chart.getIndicators().find((i) => i.name === "ZY_ACCUMULATION");
    button.style.display = indicator ? "grid" : "none";
    if (!indicator) close();
    else placeInPane(chart, el, indicator.paneId, button, observer);
    reflow();
  };
  const observer = new ResizeObserver(sync);
  observer.observe(el);
  return {
    sync,
    destroy: () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", onDocDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
      button.remove();
      pop.remove();
    },
  };
}
