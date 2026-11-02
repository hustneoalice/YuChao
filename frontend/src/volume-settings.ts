import type { Chart } from 'klinecharts';
import { ic } from './icons';

type VolumeSettings = { periods: number[]; visible: boolean[] };
const defaults = (): VolumeSettings => ({ periods: [5, 10], visible: [true, true] });
/** 与 VOLX 里 ma1/ma2 的线色写死同值：设置项前的色条、图上的均量线、图例三处对得上 */
const MA_COLORS = ['#FF9F43', '#4DD0E1'];
const MIN_PERIOD = 2, MAX_PERIOD = 500;
const pad = (n: number): number => Math.min(MAX_PERIOD, Math.max(MIN_PERIOD, Math.round(n)));

export function readVolumeSettings(): VolumeSettings {
  try {
    const value = JSON.parse(localStorage.getItem('yc_volume_settings') || 'null');
    if (value?.periods?.length === 2 && value.periods.every((n: number) => Number.isInteger(n) && n >= 2 && n <= 500)
      && value.visible?.length === 2 && value.visible.every((v: unknown) => typeof v === 'boolean')) return value;
  } catch { /* 旧设置无效时使用默认参数 */ }
  return defaults();
}

/** 齿轮随成交量窗格定位；点开的参数浮层锚在齿轮上，只作用于当前图表的 VOLX。 */
export function mountVolumeSettings(chart: Chart, el: HTMLElement) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'kl-vset';
  button.innerHTML = ic('gear', 13);
  button.title = '成交量参数';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-haspopup', 'dialog');
  el.appendChild(button);

  const pop = document.createElement('div');
  pop.className = 'vpop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '成交量参数');
  pop.innerHTML = `<div class="vpop-head"><b>成交量参数</b><span class="mono">VOL</span>
      <button type="button" class="vpop-x" aria-label="关闭">${ic('x', 11)}</button></div>
    <div class="vpop-body">${[0, 1].map((i) => `
      <div class="vpop-row">
        <span class="vpop-sw" style="--c:${MA_COLORS[i]}"></span>
        <span class="vpop-lb">MA${i + 1}</span>
        <div class="vstep">
          <button type="button" data-d="-1" aria-label="MA${i + 1} 周期减一">−</button>
          <input name="p${i}" type="number" min="${MIN_PERIOD}" max="${MAX_PERIOD}" step="1"
            inputmode="numeric" aria-label="MA${i + 1} 周期">
          <button type="button" data-d="1" aria-label="MA${i + 1} 周期加一">+</button>
        </div>
        <button type="button" class="switch on" data-sw="${i}" role="switch"
          aria-checked="true" aria-label="显示 MA${i + 1}"><i></i></button>
      </div>`).join('')}</div>
    <p class="vpop-tip">周期 2～500 根，日 K 中 40 即 40 日均量。</p>
    <div class="vpop-foot">
      <button type="button" class="vpop-reset">恢复默认</button>
      <span class="sp"></span>
      <button type="button" class="hbtn" data-cancel>取消</button>
      <button type="button" class="hbtn primary" data-apply>应用</button>
    </div>`;
  document.body.appendChild(pop);

  const rows = [...pop.querySelectorAll<HTMLElement>('.vpop-row')];
  const steps = rows.map((row) => row.querySelector<HTMLElement>('.vstep')!);
  const inputs = [0, 1].map((i) => pop.querySelector<HTMLInputElement>(`input[name=p${i}]`)!);
  const switches = [0, 1].map((i) => pop.querySelector<HTMLButtonElement>(`[data-sw="${i}"]`)!);
  const tip = pop.querySelector<HTMLElement>('.vpop-tip')!;

  /* 提示行兼当校验：两条线周期撞了就换成提醒（旧弹窗的文案保留，但不占额外高度） */
  const TIP = '周期 2～500 根，日 K 中 40 即 40 日均量。';
  const updateTip = (): void => {
    const dup = inputs[0].value === inputs[1].value
      && switches[0].classList.contains('on') && switches[1].classList.contains('on');
    tip.classList.toggle('is-warn', dup);
    tip.textContent = dup ? '两条均量线周期相同，会重合成一条。' : TIP;
  };
  /** 步进按钮到边界就置灰，避免点了没反应 */
  const syncSteps = (): void => {
    steps.forEach((box, i) => {
      const n = Number(inputs[i].value);
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
  const fill = (value: VolumeSettings): void => {
    value.periods.forEach((period, i) => { inputs[i].value = String(period); setRow(i, value.visible[i]); });
    syncSteps();
  };

  /* ── 定位：右对齐齿轮、下沿 6px；下方放不下换到上方；两边都局促时留在
     空间更大的一侧并限制高度（内部滚动），绝不盖住按钮本身 ──
     不画小箭头：齿轮贴着浮层右上角、打开时还高亮成强调色，指向关系已经够清楚；
     箭头反而会压在 12px 圆角上，缺口残缺。 */
  const place = (): void => {
    if (pop.hidden) return;
    const b = button.getBoundingClientRect();
    pop.style.maxHeight = "";                       // 先量自然高度，再按可用空间收紧
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

  // 图表自身重排（窗格高度/窗口缩放）比这里的事件晚一拍，隔一帧再校一次位置
  const reflow = (): void => { place(); requestAnimationFrame(place); };

  const open = (): void => {
    fill(readVolumeSettings());
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
    row.querySelectorAll<HTMLButtonElement>('.vstep button').forEach((b) => {
      b.onclick = () => {
        inputs[i].value = String(pad((Number(inputs[i].value) || MIN_PERIOD) + Number(b.dataset.d)));
        syncSteps();
      };
    });
    inputs[i].oninput = syncSteps;
    // 失焦即归位到合法区间（清空 / 越界 / 小数都收敛掉）
    inputs[i].onblur = () => { inputs[i].value = String(pad(Number(inputs[i].value) || MIN_PERIOD)); syncSteps(); };
  });

  pop.querySelector<HTMLElement>('[data-apply]')!.onclick = () => {
    const settings: VolumeSettings = {
      periods: inputs.map((input) => pad(Number(input.value) || MIN_PERIOD)),
      visible: switches.map((sw) => sw.classList.contains('on')),
    };
    localStorage.setItem('yc_volume_settings', JSON.stringify(settings));
    chart.overrideIndicator({ name: 'VOLX', calcParams: settings.periods, extendData: settings.visible });
    close();
    button.focus();
  };

  /* 点空白 / Esc 关闭；ESC 捕获阶段拦下，别顺带清掉图上的选中与框选 */
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
    const indicator = chart.getIndicators().find((i) => i.name === 'VOLX');
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
