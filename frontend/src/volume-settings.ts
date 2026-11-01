import type { Chart } from 'klinecharts';

type VolumeSettings = { periods: number[]; visible: boolean[] };
const defaults = (): VolumeSettings => ({ periods: [5, 10], visible: [true, true] });
export function readVolumeSettings(): VolumeSettings {
  try {
    const value = JSON.parse(localStorage.getItem('yc_volume_settings') || 'null');
    if (value?.periods?.length === 2 && value.periods.every((n: number) => Number.isInteger(n) && n >= 2 && n <= 500)
      && value.visible?.length === 2 && value.visible.every((v: unknown) => typeof v === 'boolean')) return value;
  } catch { /* 旧设置无效时使用默认参数 */ }
  return defaults();
}

/** 齿轮随成交量窗格定位；参数只作用于当前图表的 VOLX。 */
export function mountVolumeSettings(chart: Chart, el: HTMLElement) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '⚙';
  button.title = '调整成交量指标参数';
  button.setAttribute('aria-label', button.title);
  button.style.cssText = 'position:absolute;right:58px;z-index:9;padding:0 5px;color:var(--text-muted);background:var(--panel);border:0;border-radius:4px;cursor:pointer;font-size:18px;display:none';
  el.appendChild(button);
  const dialog = document.createElement('dialog');
  dialog.style.cssText = 'color:var(--text);background:var(--panel,#fff);border:1px solid var(--line,#ddd);border-radius:12px;padding:20px;max-width:calc(100vw - 32px);width:360px;box-sizing:border-box';
  dialog.innerHTML = `<form method="dialog"><h3 style="margin:0 0 16px">调整指标参数 · VOL</h3>
    <p style="font-size:12px;color:var(--text-muted)">均量周期 2～500 根；日K中 40 即40日均量。</p>
    ${[0, 1].map(i => `<label style="display:flex;align-items:center;gap:12px;margin:12px 0">M${i + 1}<input aria-label="M${i + 1}周期" name="m${i}" type="number" min="2" max="500" step="1" required style="width:90px"><input aria-label="显示M${i + 1}" name="v${i}" type="checkbox">显示</label>`).join('')}
    <p style="font-size:12px;color:var(--text-muted)">两项周期相同，两条均量线会重合。</p>
    <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:20px"><button type="button" data-reset>恢复默认</button><button type="button" data-cancel>取消</button><button type="submit">应用</button></div></form>`;
  document.body.appendChild(dialog);
  const form = dialog.querySelector('form')!;
  const fill = (value: VolumeSettings) => value.periods.forEach((period, i) => {
    (form.elements.namedItem(`m${i}`) as HTMLInputElement).value = String(period);
    (form.elements.namedItem(`v${i}`) as HTMLInputElement).checked = value.visible[i];
  });
  button.onclick = () => { fill(readVolumeSettings()); dialog.showModal(); };
  dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = () => dialog.close();
  dialog.querySelector<HTMLButtonElement>('[data-reset]')!.onclick = () => fill(defaults());
  form.onsubmit = event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const settings: VolumeSettings = {
      periods: [0, 1].map(i => Number((form.elements.namedItem(`m${i}`) as HTMLInputElement).value)),
      visible: [0, 1].map(i => (form.elements.namedItem(`v${i}`) as HTMLInputElement).checked),
    };
    localStorage.setItem('yc_volume_settings', JSON.stringify(settings));
    chart.overrideIndicator({ name: 'VOLX', calcParams: settings.periods, extendData: settings.visible });
    dialog.close();
  };
  const sync = () => {
    const indicator = chart.getIndicators().find(i => i.name === 'VOLX');
    const pane = indicator ? chart.getDom(indicator.paneId) : null;
    button.style.display = pane ? 'block' : 'none';
    if (pane) button.style.top = `${pane.getBoundingClientRect().top - el.getBoundingClientRect().top + 4}px`;
  };
  const observer = new ResizeObserver(sync);
  observer.observe(el);
  return { sync, destroy: () => { observer.disconnect(); button.remove(); dialog.remove(); } };
}
