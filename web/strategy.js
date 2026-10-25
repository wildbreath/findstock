/** 策略设计：编辑并保存筛选条件组合。 */

const state = {strategies: [], strategy: null, conditions: [], mapIndex: 0};
const ELEMENT_IDS = ['alert-area', 'strategy-list', 'strategy-search', 'strategy-count', 'strategy-save-as', 'strategy-new', 'strategy-name', 'strategy-save', 'strategy-delete', 'strategy-dirty', 'strategy-fields', 'condition-count', 'condition-picker', 'condition-palette', 'condition-list', 'criteria-error', 'criteria-reset', 'use-strategy', 'strategy-guide', 'strategy-guide-list', 'strategy-map', 'strategy-map-detail'];

async function loadStrategies(preferredId = null) {
  const list = (await api("/api/strategies")) || [];
  state.strategies = list;
  if (!list.length) {
    state.strategy = null;
    state.conditions = [];
  } else {
    const wanted = preferredId || requestedStrategyId();
    state.strategy = list.find((item) => item.id === wanted) || list[0];
    state.conditions = state.strategy.conditions.map((item) => ({
      kind: item.kind,
      params: Object.assign({}, item.params),
    }));
    rememberStrategy(state.strategy.id);
  }
  el.strategyName.value = state.strategy ? state.strategy.name : "";
  el.strategySearch.value = "";
  renderStrategyLibrary();
  renderConditions();
  updateCriteriaUI();
}

function selectStrategy(strategyId) {
  if (el.strategyFields.disabled || state.strategy?.id === strategyId) return;
  const strategy = state.strategies.find((item) => item.id === strategyId);
  if (!strategy || !confirmStrategySwitch()) return;
  state.strategy = strategy;
  rememberStrategy(strategy.id);
  resetToStrategy();
}

function newStrategyName(base) {
  let name = base.slice(0, 30);
  let suffix = 2;
  while (state.strategies.some((item) => item.name === name)) {
    const tail = ` ${suffix++}`;
    name = base.slice(0, 30 - tail.length) + tail;
  }
  return name;
}

function addCondition(kind) {
  if (el.strategyFields.disabled || !conditionEntry(kind)) return;
  state.conditions.push({kind, params: defaultConditionParams(kind)});
  renderConditions();
  updateCriteriaUI();
  el.conditionList.lastElementChild.querySelector("input, select")?.focus();
}

function renderConditions() {
  if (!state.conditions.length) el.conditionPicker.open = true;
  el.conditionList.innerHTML = state.conditions.map((condition, index) => conditionEditorHtml(condition, index,
    `<div class="condition-card-actions">` +
    `<button type="button" class="btn btn-mini" data-action="up" aria-label="上移条件 ${index + 1}" ${index === 0 ? "disabled" : ""}>↑</button>` +
    `<button type="button" class="btn btn-mini" data-action="down" aria-label="下移条件 ${index + 1}" ${index === state.conditions.length - 1 ? "disabled" : ""}>↓</button>` +
    `<button type="button" class="btn btn-mini" data-action="copy" aria-label="复制条件 ${index + 1}">复制</button>` +
    `<button type="button" class="btn btn-mini btn-danger" data-action="remove" aria-label="删除条件 ${index + 1}">删除</button></div>`
  )).join("") || `<p class="condition-empty">添加条件开始。无条件时返回全部候选股票。</p>`;
}

function onConditionsChanged(event) {
  const block = event.target.closest(".condition-block");
  if (!block) return;
  const index = Number(block.dataset.index);
  const action = event.target.closest("[data-action]");
  if (action) {
    if (event.type !== "click") return;
    let target = index;
    if (action.dataset.action === "remove") state.conditions.splice(index, 1);
    else if (action.dataset.action === "copy") {
      const item = state.conditions[index];
      target = index + 1;
      state.conditions.splice(target, 0, {kind: item.kind, params: {...item.params}});
    } else {
      target = index + (action.dataset.action === "up" ? -1 : 1);
      if (target < 0 || target >= state.conditions.length) return;
      const [item] = state.conditions.splice(index, 1);
      state.conditions.splice(target, 0, item);
    }
    renderConditions();
    updateCriteriaUI();
    el.conditionList.querySelectorAll(".condition-block")[Math.min(target, state.conditions.length - 1)]?.querySelector("input, select")?.focus();
    return;
  }
  if (updateConditionParams(event, state.conditions)) updateCriteriaUI();
}

function firstConditionError() {
  for (const condition of state.conditions) {
    const error = validateConditionParams(condition.kind, condition.params);
    if (error) return error;
  }
  return null;
}

function updateCriteriaUI() {
  const error = firstConditionError();
  const dirty = strategyIsDirty();
  el.criteriaError.hidden = !error;
  el.criteriaError.textContent = error || "";
  el.strategyDirty.textContent = dirty ? "未保存" : "已保存";
  el.strategySave.textContent = state.strategy ? "保存修改" : "保存新策略";
  el.strategySave.disabled = Boolean(error) || !el.strategyName.value.trim() || !dirty;
  el.strategyDelete.disabled = !state.strategy;
  el.criteriaReset.disabled = !dirty;
  el.conditionCount.textContent = `${state.conditions.length} 条`;
  el.useStrategy.href = state.strategy ? `/screen/stocks?strategy=${state.strategy.id}` : "/screen/stocks";
  renderStrategyMap(state.conditions, state.mapIndex);
}

function strategyIsDirty() {
  return state.strategy ? el.strategyName.value.trim() !== state.strategy.name ||
    !conditionsEqual(state.strategy.conditions, state.conditions) :
    Boolean(el.strategyName.value.trim() || state.conditions.length);
}

function confirmStrategySwitch() {
  return !strategyIsDirty() || window.confirm("当前策略有未保存的修改，仍要切换吗？");
}

function resetToStrategy() {
  el.strategyName.value = state.strategy ? state.strategy.name : "";
  state.conditions = (state.strategy ? state.strategy.conditions : []).map((item) => ({
    kind: item.kind,
    params: Object.assign({}, item.params),
  }));
  renderStrategyLibrary();
  renderConditions();
  updateCriteriaUI();
}

function saveAsStrategy() {
  if (el.strategyFields.disabled) return;
  const name = newStrategyName(`${(el.strategyName.value.trim() || "我的策略").slice(0, 25)} 副本`);
  state.strategy = null;
  el.strategyName.value = name;
  renderStrategyLibrary();
  updateCriteriaUI();
  el.strategyName.focus();
  el.strategyName.select();
}

async function saveCurrentStrategy() {
  if (el.strategyFields.disabled) return;
  clearAlerts();
  const invalid = firstConditionError();
  const name = el.strategyName.value.trim();
  if (invalid || !name || name.length > 30) {
    showAlert("warn", escapeHtml(invalid || "策略名称需为 1 至 30 个字符。"));
    return;
  }
  if (state.strategies.some((item) => item.name === name && item.id !== state.strategy?.id)) {
    showAlert("warn", "已有同名策略，请换个名称后保存。");
    el.strategyName.focus();
    return;
  }
  el.strategySave.disabled = true;
  el.strategySave.textContent = "保存中…";
  el.strategyFields.disabled = true;
  try {
    const saved = await api(state.strategy ? `/api/strategies/${state.strategy.id}` : "/api/strategies", {
      method: state.strategy ? "PUT" : "POST",
      body: JSON.stringify({name, conditions: state.conditions}),
    });
    await loadStrategies(saved.id);
  } catch (error) {
    showAlert("error", `保存策略失败: ${escapeHtml(error.message)}`);
  } finally {
    el.strategyFields.disabled = false;
    updateCriteriaUI();
  }
}

async function deleteCurrentStrategy() {
  if (el.strategyFields.disabled) return;
  if (!state.strategy || !window.confirm(`删除策略「${state.strategy.name}」？未保存的修改也将丢弃。`)) return;
  clearAlerts();
  el.strategyFields.disabled = true;
  try {
    await api(`/api/strategies/${state.strategy.id}`, {method: "DELETE"});
    await loadStrategies();
  } catch (error) {
    showAlert("error", `删除策略失败: ${escapeHtml(error.message)}`);
  } finally { el.strategyFields.disabled = false; }
}

function bindEvents() {
  function selectMapCondition(event) {
    if (event.type === "click" && event.target.closest("[data-preview-retry]")) {
      strategyMapPreview.key = null;
      renderStrategyMap(state.conditions, state.mapIndex);
      return;
    }
    const edit = event.target.closest("[data-map-edit]");
    if (event.type === "click" && edit) {
      el.conditionList.querySelector(`.condition-block[data-index="${edit.dataset.mapEdit}"]`)?.querySelector("input, select")?.focus();
      return;
    }
    const row = event.target.closest("[data-map-index]");
    if (!row || (event.type === "keydown" && !["Enter", " "].includes(event.key))) return;
    event.preventDefault();
    state.mapIndex = Number(row.dataset.mapIndex);
    renderStrategyMap(state.conditions, state.mapIndex);
    el.strategyMap.querySelector(`[data-map-index="${state.mapIndex}"]`)?.focus({preventScroll: true});
  }
  el.strategyMap.addEventListener("click", selectMapCondition);
  el.strategyMap.addEventListener("keydown", selectMapCondition);
  el.conditionList.addEventListener("focusin", (event) => {
    const block = event.target.closest(".condition-block");
    if (!block) return;
    state.mapIndex = Number(block.dataset.index);
    renderStrategyMap(state.conditions, state.mapIndex);
  });
  el.strategySearch.addEventListener("input", renderStrategyLibrary);
  el.strategyList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-strategy-id]");
    if (button) selectStrategy(Number(button.dataset.strategyId));
  });
  el.strategySaveAs.addEventListener("click", saveAsStrategy);
  el.strategyName.addEventListener("input", updateCriteriaUI);
  el.strategySave.addEventListener("click", saveCurrentStrategy);
  el.strategyDelete.addEventListener("click", deleteCurrentStrategy);
  el.strategyNew.addEventListener("click", () => {
    if (!confirmStrategySwitch()) return;
    state.strategy = null;
    resetToStrategy();
    el.strategyName.value = newStrategyName("我的策略");
    updateCriteriaUI();
    el.strategyName.focus();
    el.strategyName.select();
  });
  el.conditionPalette.addEventListener("click", (event) => {
    const button = event.target.closest("[data-kind]");
    if (button) addCondition(button.dataset.kind);
  });
  window.addEventListener("beforeunload", (event) => {
    if (!strategyIsDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  el.conditionList.addEventListener("input", onConditionsChanged);
  el.conditionList.addEventListener("change", onConditionsChanged);
  el.conditionList.addEventListener("click", onConditionsChanged);
  el.criteriaReset.addEventListener("click", () => {
    if (!confirmStrategySwitch()) return;
    clearAlerts();
    resetToStrategy();
  });
}

async function initStrategy() {
  const missing = bindElements(ELEMENT_IDS, ELEMENT_IDS);
  if (missing.length) {
    reportFatal("页面与脚本版本不一致，请按 Ctrl+F5 刷新。");
    return;
  }
  bindEvents();
  await loadConditionCatalog();
  renderStrategyGuide();
  el.conditionPalette.innerHTML = conditionCatalogEntries().map((entry) =>
    `<button class="condition-type" type="button" data-kind="${escapeHtml(entry.kind)}" title="${escapeHtml(entry.hint)}">` +
    `<strong>＋ ${escapeHtml(entry.title)}</strong></button>`).join("");
  await loadStrategies();
  el.strategyFields.disabled = false;
}

boot(initStrategy);
