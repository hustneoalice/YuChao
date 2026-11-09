import type { Chart } from 'klinecharts';
import { ic } from './icons';
import { gearHost } from './chart-gears';

/** 主力成本四条线的显隐设置（顺序：超短期 / 短期 / 中期 / 长期） */
const KEY = 'yc_maincost_settings';
const LABELS = ['超短期', '短期', '中期', '长期'];
/** 与 ZY_MAIN_COST 注册时 figures 的线色写死同值：设置项色条、图上线条两处对得上 */
const COLORS = ['#FF9800', '#C084FC', '#2DD4BF', '#0A84FF'];
const defaults = (): boolean[] => [true, true, true, true];

export function readMainCostSettings(): boolean[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null') as unknown;
    if (Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === 'boolean')) {
      return value as boolean[];
    }
  } catch { /* 旧设置无效时使用默认值 */ }
  return defaults();
}

/** 齿轮收在图表右上角（gearHost 统一排布）；弹层只作用于当前图表的 ZY_MAIN_COST。 */
export function mountMainCostSettings(chart: Chart, el: HTMLElement) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'kl-vset';
  button.innerHTML = ic('gear', 13);
  button.title = '主力成本参数';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-haspopup', 'dialog');
  gearHost(el).appendChild(button);

  const pop = document.createElement('div');
  pop.className = 'vpop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '主力成本参数');
  pop.innerHTML = `<div class="vpop-head"><b>主力成本参数</b><span class="mono">ZJ·DMA</span>
      <button type="button" class="vpop-x" aria-label="关闭">${ic('x', 11)}</button></div>
    <div class="vpop-body">${LABELS.map((label, i) => `
      <div class="vpop-row">
        <span class="vpop-sw" style="--c:${COLORS[i]}"></span>
        <span class="vpop-lb" style="width:38px">${label}</span>
        <span class="sp" style="flex:1"></span>
        <button type="button" class="switch on" data-sw="${i}" role="switch"
          aria-checked="true" aria-label="显示${label}成本线"><i></i></button>
      </div>`).join('')}</div>
    <p class="vpop-tip">四条线是同一条 DMA 的不同平滑权重（YZ/0.125、YZ/0.25、YZ/0.5、YZ），
      越靠上反应越快；关掉的线不绘制。</p>
    <div class="vpop-foot">
      <button type="button" class="vpop-reset">恢复默认</button>
      <span class="sp"></span>
      <button type="button" class="hbtn" data-cancel>取消</button>
      <button type="button" class="hbtn primary" data-apply>应用</button>
    </div>`;
  document.body.appendChild(pop);

  const rows = [...pop.querySelectorAll<HTMLElement>('.vpop-row')];
  const switches = rows.map((row) => row.querySelector<HTMLButtonElement>('.switch')!);

  const setRow = (i: number, on: boolean): void => {
    switches[i].classList.toggle('on', on);
    switches[i].setAttribute('aria-checked', String(on));
    rows[i].classList.toggle('off', !on);
  };
  const fill = (visible: boolean[]): void => {
    visible.forEach((on, i) => setRow(i, on));
  };

  /* 定位同成交量参数浮层：右对齐齿轮、下方放不下换上方，两边都局促时限高内滚 */
  const place = (): void => {
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
  };
  const reflow = (): void => { place(); requestAnimationFrame(place); };

  const open = (): void => {
    fill(readMainCostSettings());
    pop.hidden = false;
    button.classList.add('on');
    button.setAttribute('aria-expanded', 'true');
    reflow();
  };
  const close = (): void => {
    if (pop.hidden) return;
    pop.hidden = true;
    button.classList.remove('on');
    button.setAttribute('aria-expanded', 'false');
  };

  button.onclick = (event) => {
    event.stopPropagation();
    if (pop.hidden) open(); else close();
  };
  pop.querySelector<HTMLElement>('.vpop-x')!.onclick = () => { close(); button.focus(); };
  pop.querySelector<HTMLElement>('[data-cancel]')!.onclick = () => { close(); button.focus(); };
  pop.querySelector<HTMLElement>('.vpop-reset')!.onclick = () => fill(defaults());

  rows.forEach((row, i) => {
    row.querySelector<HTMLElement>('.switch')!.onclick = () => {
      setRow(i, !switches[i].classList.contains('on'));
    };
  });

  pop.querySelector<HTMLElement>('[data-apply]')!.onclick = () => {
    const visible = switches.map((sw) => sw.classList.contains('on'));
    localStorage.setItem(KEY, JSON.stringify(visible));
    chart.overrideIndicator({ name: 'ZY_MAIN_COST', extendData: visible });
    close();
    button.focus();
  };

  const onDocDown = (event: PointerEvent): void => {
    if (pop.hidden) return;
    const t = event.target as Node;
    if (!pop.contains(t) && !button.contains(t)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || pop.hidden) return;
    event.stopPropagation();
    close();
    button.focus();
  };
  const onViewport = (): void => reflow();
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onViewport);
  window.addEventListener('scroll', onViewport, true);

  /** 指标被移除（切主图）后重新挂载时补一次已存设置，避免又显示四条线 */
  let applied = false;
  const sync = (): void => {
    const indicator = chart.getIndicators().find((i) => i.name === 'ZY_MAIN_COST');
    const pane = indicator ? chart.getDom(indicator.paneId) : null;
    button.style.display = pane ? 'grid' : 'none';
    if (!pane) { close(); applied = false; }
    if (pane && !applied) {
      applied = true;
      chart.overrideIndicator({ name: 'ZY_MAIN_COST', extendData: readMainCostSettings() });
    }
    reflow();
  };
  const observer = new ResizeObserver(sync);
  observer.observe(el);
  return {
    sync,
    destroy: () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
      button.remove();
      pop.remove();
    },
  };
}
