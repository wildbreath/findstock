/** 两个条件选股子页面共用的策略列表与最近选择。 */

const STRATEGY_STORAGE_KEY = "findstock.strategy.id";

function storedStrategyId() {
  try {
    return Number(window.localStorage.getItem(STRATEGY_STORAGE_KEY)) || null;
  } catch (error) {
    return null;
  }
}

function rememberStrategy(strategyId) {
  try {
    window.localStorage.setItem(STRATEGY_STORAGE_KEY, String(strategyId));
  } catch (error) {
    /* 隐私模式下不可用, 忽略 */
  }
}

function renderStrategyLibrary() {
  const query = el.strategySearch.value.trim().toLocaleLowerCase();
  el.strategyCount.textContent = state.strategies.length;
  el.strategyList.innerHTML = state.strategies.filter((item) =>
    `${item.name} ${item.conditions.map((c) => `${conditionTitle(c.kind)} ${conditionSummary(c.kind, c.params)}`).join(" ")}`
      .toLocaleLowerCase().includes(query)
  ).map((item) => {
    const selected = state.strategy && item.id === state.strategy.id;
    return `<button type="button" class="strategy-option${selected ? " is-selected" : ""}" ` +
      `data-strategy-id="${item.id}" aria-pressed="${Boolean(selected)}" ` +
      `title="${escapeHtml(item.conditions.map((c) => conditionSummary(c.kind, c.params)).join("；") || "无条件限制")}">` +
      `<span class="strategy-option-title">${escapeHtml(item.name)}<span>${selected ? "已选 · " : ""}${item.conditions.length} 条</span></span></button>`;
  }).join("") || `<p class="strategy-help">${query ? "没有匹配的策略，试试其他关键词。" : "暂无策略，点击新建开始。"}</p>`;
}

function conditionsEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return (
      item.kind === other.kind &&
      JSON.stringify(item.params || {}) === JSON.stringify(other.params || {})
    );
  });
}

function requestedStrategyId() {
  return Number(new URLSearchParams(window.location.search).get("strategy")) || storedStrategyId();
}
