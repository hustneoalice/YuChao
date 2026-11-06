import type { Chart } from 'klinecharts';
import { ic } from './icons';
import { cssv } from './fmt';

/* 主图均线设置：7 条线固定“色位”，周期可改、可逐条显隐。
   色位对齐主流软件：白/黄/紫/绿/蓝/青/橙；60=季线、120=半年线、250=年线。 */
export type MASettings = { periods: number[]; visible: boolean[] };
export type MARow = { cssVar: string; fallback: string; defaultPeriod: number };

export const MA_ROWS: readonly MARow[] = [
  { cssVar: '--ma5', fallback: '#FFFFFF', defaultPeriod: 5 },
  { cssVar: '--ma10', fallback: '#FFD60A', defaultPeriod: 10 },
  { cssVar: '--ma20', fallback: '#BF5AF2', defaultPeriod: 20 },
  { cssVar: '--ma30', fallback: '#5BE37E', defaultPeriod: 30 },
  { cssVar: '--ma60', fallback: '#0A84FF', defaultPeriod: 60 },
  { cssVar: '--ma120', fallback: '#64D2FF', defaultPeriod: 120 },
  { cssVar: '--ma250', fallback: '#FF9F43', defaultPeriod: 250 },
] as const;

const KEY = 'yc_ma_settings';
const MIN_PERIOD = 2, MAX_PERIOD = 500;
const ROLE: Record<number, string> = { 60: '·季', 120: '·半年', 250: '·年' };
const TIP = '周期 2～500 根；日 K 中 60=季线、120=半年线、250=年线。';

const defaults = (): MASettings => ({
  periods: MA_ROWS.map((row) => row.defaultPeriod),
  visible: MA_ROWS.map(() => true),
});

const pad = (n: number): number => Math.min(MAX_PERIOD, Math.max(MIN_PERIOD, Math.round(n)));

export function maLabel(period: number): string {
  return `MA${period}${ROLE[period] ?? ''}`;
}

export function readMASettings(): MASettings {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null') as unknown;
    if (
      Array.isArray((value as MASettings)?.periods)
      && (value as MASettings).periods.length === MA_ROWS.length
      && (value as MASettings).periods.every((n) => Number.isInteger(n) && n >= MIN_PERIOD && n <= MAX_PERIOD)
      && Array.isArray((value as MASettings)?.visible)
      && (value as MASettings).visible.length === MA_ROWS.length
      && (value as MASettings).visible.every((v) => typeof v === 'boolean')
    ) {
      const settings = value as MASettings;
      const visible = [...settings.visible];
      if (!visible.some(Boolean)) visible[0] = true;   // 至少保留一条，避免主图被“全部关闭”后无法再打开
      return { periods: [...settings.periods], visible };
    }
  } catch { /* 旧设置无效时使用默认参数 */ }
  return defaults();
}

/** 当前应绘制的均线（周期、颜色、图例文字一起产出，避免三处错位）。 */
export function visibleMARows(): { period: number; color: string; label: string }[] {
  const settings = readMASettings();
  return MA_ROWS.map((row, i) => ({
    period: settings.periods[i],
    color: cssv(row.cssVar) || row.fallback,
    label: maLabel(settings.periods[i]),
  })).filter((_, i) => settings.visible[i]);
}

const NO_TIP = () => ({ name: '', calcParamsText: '', legends: [], features: [] });

/** 按当前设置重建 MA 指标；显隐/周期变化都走这里，图例由 onChange 重绘。 */
export function applyMA(chart: Chart, onChange?: () => void): void {
  const lines = visibleMARows();
  chart.getIndicators({ paneId: 'candle_pane' })
    .filter((indicator) => indicator.name === 'MA')
    .forEach((indicator) => chart.removeIndicator({ id: indicator.id }));
  if (lines.length) {
    chart.createIndicator({
      name: 'MA', paneId: 'candle_pane',
      calcParams: lines.map((line) => line.period), isStack: true,
      createTooltipDataSource: NO_TIP,
      styles: { lines: lines.map((line) => ({ color: line.color })) },
    } as never, true);
  }
  onChange?.();
}

/** 齿轮随主图窗格定位；与主力成本齿轮并排（right:58 / 34），不压图例。 */
export function mountMASettings(chart: Chart, el: HTMLElement, onChange: () => void) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'kl-vset';
  button.innerHTML = ic('gear', 13);
  button.title = '均线参数';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-haspopup', 'dialog');
  el.appendChild(button);

  const pop = document.createElement('div');
  pop.className = 'vpop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '均线参数');
  pop.innerHTML = `<div class="vpop-head"><b>均线参数</b><span class="mono">MA</span>
      <button type="button" class="vpop-x" aria-label="关闭">${ic('x', 11)}</button></div>
    <div class="vpop-body">${MA_ROWS.map((row, i) => `
      <div class="vpop-row">
        <span class="vpop-sw" style="--c:${cssv(row.cssVar) || row.fallback}"></span>
        <span class="vpop-lb" data-lb="${i}" style="width:40px">${maLabel(row.defaultPeriod)}</span>
        <div class="vstep">
          <button type="button" data-d="-1" aria-label="第${i + 1}条均线周期减一">−</button>
          <input name="p${i}" type="number" min="${MIN_PERIOD}" max="${MAX_PERIOD}" step="1"
            inputmode="numeric" aria-label="第${i + 1}条均线周期">
          <button type="button" data-d="1" aria-label="第${i + 1}条均线周期加一">+</button>
        </div>
        <button type="button" class="switch on" data-sw="${i}" role="switch"
          aria-checked="true" aria-label="显示第${i + 1}条均线"><i></i></button>
      </div>`).join('')}</div>
    <p class="vpop-tip">${TIP}</p>
    <div class="vpop-foot">
      <button type="button" class="vpop-reset">恢复默认</button>
      <span class="sp"></span>
      <button type="button" class="hbtn" data-cancel>取消</button>
      <button type="button" class="hbtn primary" data-apply>应用</button>
    </div>`;
  document.body.appendChild(pop);

  const rows = [...pop.querySelectorAll<HTMLElement>('.vpop-row')];
  const steps = rows.map((row) => row.querySelector<HTMLElement>('.vstep')!);
  const labels = MA_ROWS.map((_, i) => pop.querySelector<HTMLElement>(`[data-lb="${i}"]`)!);
  const inputs = MA_ROWS.map((_, i) => pop.querySelector<HTMLInputElement>(`input[name=p${i}]`)!);
  const switches = MA_ROWS.map((_, i) => pop.querySelector<HTMLButtonElement>(`[data-sw="${i}"]`)!);
  const tip = pop.querySelector<HTMLElement>('.vpop-tip')!;

  const activePeriods = (): number[] => inputs
    .map((input, i) => Number(input.value))
    .filter((_, i) => switches[i].classList.contains('on'));

  const updateTip = (): void => {
    const periods = activePeriods();
    const dup = periods.length !== new Set(periods).size;
    tip.classList.toggle('is-warn', dup);
    tip.textContent = dup ? '有周期重复的均线，会重合成一条。' : TIP;
  };

  /** 步进按钮到边界就置灰；同时刷新行内标签与重复提示 */
  const syncSteps = (): void => {
    steps.forEach((box, i) => {
      const n = Number(inputs[i].value) ? pad(Number(inputs[i].value)) : MIN_PERIOD;
      labels[i].textContent = maLabel(n);
      box.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        const dir = Number(b.dataset.d);
        b.disabled = dir < 0 ? n <= MIN_PERIOD : n >= MAX_PERIOD;
      });
    });
    updateTip();
  };

  const setRow = (i: number, on: boolean): void => {
    switches[i].classList.toggle('on', on);
    switches[i].setAttribute('aria-checked', String(on));
    rows[i].classList.toggle('off', !on);
    updateTip();
  };

  const fill = (value: MASettings): void => {
    value.periods.forEach((period, i) => {
      inputs[i].value = String(period);
      setRow(i, value.visible[i]);
    });
    syncSteps();
  };

  /* 定位同成交量/主力成本浮层：右对齐齿轮、下方放不下换上方，两边都局促时限高内滚 */
  const place = (): void => {
    if (pop.hidden) return;
    const b = button.getBoundingClientRect();
    pop.style.maxHeight = '';
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const edge = 8, gap = 6;
    const below = window.innerHeight - b.bottom - gap - edge;
    const above = b.top - gap - edge;
    const up = h > below && above > below;
    const room = up ? above : below;
    const left = Math.max(edge, Math.min(b.right - w, window.innerWidth - w - edge));
    const top = up ? Math.max(edge, b.top - gap - Math.min(h, room)) : b.bottom + gap;
    if (h > room) pop.style.maxHeight = `${Math.max(96, room)}px`;
    pop.classList.toggle('up', up);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  };
  const reflow = (): void => { place(); requestAnimationFrame(place); };

  const open = (): void => {
    fill(readMASettings());
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
      const on = switches[i].classList.contains('on');
      if (on && switches.filter((sw) => sw.classList.contains('on')).length <= 1) {
        tip.textContent = '至少保留一条均线。';
        tip.classList.add('is-warn');
        return;
      }
      setRow(i, !on);
    };
    row.querySelectorAll<HTMLButtonElement>('.vstep button').forEach((b) => {
      b.onclick = () => {
        inputs[i].value = String(pad((Number(inputs[i].value) || MIN_PERIOD) + Number(b.dataset.d)));
        syncSteps();
      };
    });
    inputs[i].oninput = syncSteps;
    inputs[i].onblur = () => {
      inputs[i].value = String(pad(Number(inputs[i].value) || MIN_PERIOD));
      syncSteps();
    };
  });

  pop.querySelector<HTMLElement>('[data-apply]')!.onclick = () => {
    const settings: MASettings = {
      periods: inputs.map((input) => pad(Number(input.value) || MIN_PERIOD)),
      visible: switches.map((sw) => sw.classList.contains('on')),
    };
    if (!settings.visible.some(Boolean)) settings.visible[0] = true;
    localStorage.setItem(KEY, JSON.stringify(settings));
    applyMA(chart, onChange);
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

  const sync = (): void => {
    const indicator = chart.getIndicators({ paneId: 'candle_pane' })
      .find((item) => item.name === 'MA');
    const pane = indicator ? chart.getDom(indicator.paneId) : null;
    button.style.display = pane ? 'grid' : 'none';
    if (!pane) close();
    if (pane) button.style.top = `${pane.getBoundingClientRect().top - el.getBoundingClientRect().top + 4}px`;
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
