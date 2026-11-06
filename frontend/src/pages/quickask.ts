/* 快速问股：入口挂在个股信息条「昨收」后的小飞机，浮框按需唤起，自动带当前标的上下文。
 * LLM 已配置时按钮点亮（绿色），否则灰色（规则模式仍可用）。 */
import { aiApi } from "../api";
import { ic } from "../icons";
import { mk } from "./market";
import { mountChat } from "./ai";

const STOCK_RE = /^\d{6}$/;
const QUICK_CHIPS = ["这只股票主营业务是什么", "分析下这个股票", "现在多少钱", "最近涨跌幅", "换手率多少"];

export function initQuickAsk(): void {
  if (document.getElementById("qa-panel")) return;

  const panel = document.createElement("div");
  panel.id = "qa-panel";
  panel.className = "qa-panel";
  panel.hidden = true;
  panel.innerHTML =
    `<div class="qa-head">` +
    `<span class="qa-title">快速问股</span>` +
    `<span class="qa-ctx" id="qa-ctx"></span>` +
    `<span class="sp"></span>` +
    `<span class="qa-mode" id="qa-mode"></span>` +
    `<button class="qa-x" id="qa-x" type="button" aria-label="关闭">×</button></div>` +
    `<div class="ai-log qa-log" id="qa-log"></div>` +
    `<div class="ai-chips" id="qa-chips"></div>` +
    `<form class="ai-form qa-form" id="qa-form" autocomplete="off">` +
    `<input id="qa-q" placeholder="问：这只股票主营业务是什么？" maxlength="200">` +
    `<button class="hbtn primary" id="qa-send" type="submit">${ic("paper-plane-tilt", 13)}发送</button></form>`;
  document.body.append(panel);

  const ctxEl = document.getElementById("qa-ctx")!;
  const modeEl = document.getElementById("qa-mode")!;
  const input = document.getElementById("qa-q") as HTMLInputElement;
  const log = document.getElementById("qa-log")!;

  const updateCtx = () => {
    const cur = mk.cur;
    if (!cur) {
      ctxEl.textContent = "未选标的";
      ctxEl.title = "先在搜索框选择一只股票，再提问可自动带上标的";
      return;
    }
    ctxEl.textContent = `${cur.name} ${cur.symbol}`;
    ctxEl.title = STOCK_RE.test(cur.symbol) ? "提问会自动带上该标的" : "指数/非个股标的：请直接输入股票代码";
  };

  const markInline = (open: boolean) => {
    document.querySelectorAll<HTMLElement>(".qa-inline").forEach((b) => {
      b.setAttribute("aria-expanded", String(open));
      b.classList.toggle("active", open);
    });
  };

  const setOpen = (v: boolean) => {
    panel.hidden = !v;
    markInline(v);
    if (v) {
      updateCtx();
      input.focus();
    }
  };

  mountChat({
    log,
    chips: document.getElementById("qa-chips")!,
    form: document.getElementById("qa-form") as HTMLFormElement,
    input,
    send: document.getElementById("qa-send"),
    chipsList: QUICK_CHIPS,
    // 只把纯 6 位代码当个股上下文，指数代码（如 000001.SH）不传，避免误判
    context: () => {
      const s = mk.cur?.symbol;
      return s && STOCK_RE.test(s) ? s : undefined;
    },
    beforeAsk: () => { if (panel.hidden) setOpen(true); },
  });

  // 信息条会被行情刷新反复重建 → 用事件委托，按钮永远有效
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".qa-inline");
    if (btn) setOpen(panel.hidden);
  });
  document.getElementById("qa-x")!.onclick = () => setOpen(false);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) setOpen(false);
  });

  let healthLoaded = false;
  const loadHealth = () => {
    if (healthLoaded) return;
    healthLoaded = true;
    void aiApi.health().then((h) => {
      const label = h.llm ? (h.model || "模型已就绪") : "规则模式";
      modeEl.textContent = label;
      modeEl.title = h.llm ? "" : "未配置模型：主营与行情问答仍可用";
      // 小飞机与顶栏状态灯：已配置模型点亮（绿），否则灰
      document.body.classList.toggle("llm-on", h.llm);
      const chip = document.getElementById("llmchip");
      const chipT = document.getElementById("llmchip-t");
      if (chip) {
        chip.classList.toggle("on", h.llm);
        chip.classList.toggle("off", !h.llm);
        chip.title = h.llm ? `大模型已启用 · ${label}` : "未配置大模型：使用本地规则模式";
      }
      if (chipT) chipT.textContent = label;
    }).catch(() => { healthLoaded = false; });
  };
  loadHealth();
  // 设置页保存模型配置后重读健康状态：顶栏灯与小飞机即时点亮/熄灭
  document.addEventListener("yc:llm-changed", () => { healthLoaded = false; loadHealth(); });

  // 页面切换标的时，浮框若开着就同步上下文
  document.addEventListener("yc:open-stock", () => { if (!panel.hidden) updateCtx(); });
}
