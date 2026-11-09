import type { Chart } from 'klinecharts';
import { ic } from './icons';

/** BIAS 三条乖离率线的周期与显隐设置（默认 6/12/24，与内置指标一致） */
export type BiasSettings = { periods: number[]; visible: boolean[] };
const KEY = 'yc_bias_settings';
const ROWS = 3;
/** 与内置 BIAS 默认线色对齐：色条、图上线条两处对得上 */
const COLORS = ['#FF9600', '#935EBD', '#1677FF'];
const MIN_PERIOD = 2, MAX_PERIOD = 500;
const TIP = '周期 2～500 根，按当前 K 线周期计算乖离率。';

const defaults = (): BiasSettings => ({ periods: [6, 12, 24], visible: [true, true, true] });
const pad = (n: number): number => Math.min(MAX_PERIOD, Math.max(MIN_PERIOD, Math.round(n)));
const isPeriod = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= MIN_PERIOD && (n as number) <= MAX_PERIOD;

export function readBiasSettings(): BiasSettings {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null') as unknown;
    if (Array.isArray((value as BiasSettings)?.periods)
      && (value as BiasSettings).periods.length === ROWS
      && (value as BiasSettings).periods.every(isPeriod)
      && Array.isArray((value as BiasSettings)?.visible)
      && (value as BiasSettings).visible.length === ROWS
      && (value as BiasSettings).visible.every((v) => typeof v === 'boolean')
    ) {
      const settings = value as BiasSettings;
      const visible = [...settings.visible];
      if (!visible.some(Boolean)) visible[0] = true;   // 至少保留一条，避免三条全关后图上空白
      return { periods: [...settings.periods], visible };
    }
  } catch { /* 旧设置无效时使用默认参数 */ }
  return defaults();
}

/** 当前应绘制的 BIAS 线（周期、颜色一起产出，避免设置项与图上线条错位）。 */
export function biasLines(): { period: number; color: string }[] {
  const settings = readBiasSettings();
  return settings.periods
    .map((period, i) => ({ period, color: COLORS[i] }))
    .filter((_, i) => settings.visible[i]);
}

/** 按当前设置覆盖图上的 BIAS；周期数量与配色一起下发，隐藏的线不参与计算。 */
export function applyBias(chart: Chart): void {
  const lines = biasLines();
  chart.overrideIndicator({
    name: 'BIAS',
    calcParams: lines.map((line) => line.period),
    styles: { lines: lines.map((line) => ({ color: line.color })) },
  } as never);
}

/** 齿轮随 BIAS 窗格定位；弹层只作用于当前图表的 BIAS。 */
export function mountBiasSettings(chart: Chart, el: HTMLElement) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'kl-vset kl-vpane';
  button.innerHTML = ic('gear', 13);
  button.title = 'BIAS参数';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-haspopup', 'dialog');
  el.appendChild(button);

  const pop = document.createElement('div');
  pop.className = 'vpop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'BIAS参数');
  pop.innerHTML = `<div class="vpop-head"><b>BIAS参数</b><span class="mono">BIAS</span>
      <button type="button" class="vpop-x" aria-label="关闭">${ic('x', 11)}</button></div>
    <div class="vpop-body">${COLORS.map((color, i) => `
      <div class="vpop-row">
        <span class="vpop-sw" style="--c:${color}"></span>
        <span class="vpop-lb" style="width:40px">BIAS${i + 1}</span>
        <div class="vstep">
          <button type="button" data-d="-1" aria-label="BIAS${i + 1} 周期减一">−</button>
          <input name="p${i}" type="number" min="${MIN_PERIOD}" max="${MAX_PERIOD}" step="1"
            inputmode="numeric" aria-label="BIAS${i + 1} 周期">
          <button type="button" data-d="1" aria-label="BIAS${i + 1} 周期加一">+</button>
        </div>
        <button type="button" class="switch on" data-sw="${i}" role="switch"
          aria-checked="true" aria-label="显示BIAS${i + 1}"><i></i></button>
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
  const inputs = COLORS.map((_, i) => pop.querySelector<HTMLInputElement>(`input[name=p${i}]`)!);
  const switches = COLORS.map((_, i) => pop.querySelector<HTMLButtonElement>(`[data-sw="${i}"]`)!);
  const tip = pop.querySelector<HTMLElement>('.vpop-tip')!;

  const activePeriods = (): number[] => inputs
    .map((input) => Number(input.value))
    .filter((_, i) => switches[i].classList.contains('on'));

  const updateTip = (): void => {
    const periods = activePeriods();
    const dup = periods.length !== new Set(periods).size;
    tip.classList.toggle('is-warn', dup);
    tip.textContent = dup ? '有周期重复的 BIAS，会重合成一条。' : TIP;
  };

  /** 步进按钮到边界就置灰，避免点了没反应 */
  const syncSteps = (): void => {
    steps.forEach((box, i) => {
      const n = Number(inputs[i].value) || MIN_PERIOD;
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

  const fill = (value: BiasSettings): void => {
    value.periods.forEach((period, i) => {
      inputs[i].value = String(period);
      setRow(i, value.visible[i]);
    });
    syncSteps();
  };

  /* 定位同成交量/均线浮层：右对齐齿轮、下方放不下换上方，两边都局促时限高内滚 */
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
    fill(readBiasSettings());
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
        tip.textContent = '至少保留一条 BIAS。';
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
    const settings: BiasSettings = {
      periods: inputs.map((input) => pad(Number(input.value) || MIN_PERIOD)),
      visible: switches.map((sw) => sw.classList.contains('on')),
    };
    if (!settings.visible.some(Boolean)) settings.visible[0] = true;
    localStorage.setItem(KEY, JSON.stringify(settings));
    applyBias(chart);
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
    const indicator = chart.getIndicators().find((i) => i.name === 'BIAS');
    const pane = indicator ? chart.getDom(indicator.paneId) : null;
    button.style.display = pane ? 'grid' : 'none';
    if (!pane) close();
    if (pane) {
      /* 横向跟着绘图区右缘走：Y 轴宽度 auto 会变，锚容器右边会飘进 Y 轴，
         也会和右侧 ✕（同样锚绘图区）挤在一起 */
      const elRect = el.getBoundingClientRect();
      const plot = indicator ? chart.getDom(indicator.paneId, 'main') : null;
      const plotRight = (plot ?? pane).getBoundingClientRect().right - elRect.left;
      button.style.left = `${Math.round(plotRight - 52)}px`;
      button.style.top = `${Math.round(pane.getBoundingClientRect().top - elRect.top + 4)}px`;
      if (plot) observer.observe(plot);
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
