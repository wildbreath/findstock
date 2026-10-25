/* 按明确的题材日期取整日股池，不受天梯视口及其他显示筛选影响。 */
function openLadderWatchlist() {
  const day = $("ladder-theme-date").value, theme = $("ladder-theme").value;
  if (!day || theme === "all" || !theme || ladderThemeLoading || ladderThemeError) {
    showAlert("info", "请先选择题材日期和一个具体题材；题材统计读取失败时请先重试。");
    return;
  }
  if ($("watch-add-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "watch-add-dialog";
  dialog.className = "watch-add-dialog ladder-watch-dialog";
  dialog.setAttribute("aria-labelledby", "watch-add-title");
  dialog.innerHTML = `<form>
    <h2 id="watch-add-title">按日期和题材加入自选</h2>
    <p class="watch-add-stock">${escapeHtml(day)} · ${escapeHtml(theme)}</p>
    <p class="picker-hint">列出该日此题材的全部涨停股票（含首板），不受天梯其他筛选影响。取消勾选即可排除。</p>
    <p class="picker-hint" data-role="coverage" role="status"></p>
    <fieldset disabled>
      <legend>选择股票</legend>
      <div class="ladder-watch-tools"><button class="btn" type="button" data-action="all">全选</button>
        <button class="btn" type="button" data-action="none">全不选</button>
        <span data-role="count" role="status">正在读取股票和自选分类…</span></div>
      <div class="pick-options ladder-watch-stocks" data-role="stocks"></div>
      <div class="ladder-watch-categories"><strong>选择分类（可多选）</strong>
        <div class="pick-options" data-role="options"></div>
        <div class="pick-create"><input data-role="new-category" type="text" maxlength="20"
          aria-label="新分类名称" placeholder="填写新分类名，加入时自动创建">
          <button class="btn" type="button" data-action="create">创建并勾选</button></div>
        <p class="picker-hint">填写名称后可直接加入自选，自动创建并勾选该分类。</p>
      </div>
      <label class="ladder-watch-mode">已自选股票的分类处理
        <select data-role="mode" aria-describedby="ladder-watch-mode-hint">
          <option value="append">追加分类，保留原分类</option>
          <option value="replace">重新设置，替换原分类</option>
        </select></label>
      <p id="ladder-watch-mode-hint" class="picker-hint" data-role="mode-hint"></p>
    </fieldset>
    <p class="picker-error" data-role="error" role="alert" hidden></p>
    <button class="btn" type="button" data-action="retry" hidden>重新读取股票和分类</button>
    <div class="pick-actions"><span>原备注保留，股票不会重复加入</span>
      <button class="btn" type="button" data-action="cancel">取消</button>
      <button class="btn btn-primary" type="submit" disabled>加入自选</button></div>
  </form>`;
  const find = (selector) => dialog.querySelector(selector);
  const fieldset = find("fieldset"), stocks = find("[data-role='stocks']"), options = find("[data-role='options']");
  const input = find("[data-role='new-category']"), mode = find("[data-role='mode']");
  const submit = find("[type='submit']"), cancel = find("[data-action='cancel']"), retry = find("[data-action='retry']");
  const feedback = find("[data-role='error']");
  let members = [], existing = new Map(), busy = false, ready = false;
  const selectedStocks = () => new Set([...stocks.querySelectorAll("input:checked")].map(node => node.value));
  const selectedCategories = () => [...options.querySelectorAll("input:checked")].map(node => Number(node.value));
  const update = () => {
    const selected = selectedStocks(), watched = [...selected].filter(code => existing.has(code)).length;
    find("[data-role='count']").textContent = `已选 ${selected.size} / ${members.length} 只 · 新增 ${selected.size - watched} 只 · 已自选 ${watched} 只`;
    find("[data-role='mode-hint']").textContent = mode.value === "replace"
      ? "所选股票的原分类将替换为本次勾选的分类；不勾选分类会归入「未分类」。"
      : "所选分类追加到原分类；不勾选分类时，已自选股票保留原分类，新股票归入「未分类」。";
    submit.disabled = busy || !ready || !selected.size;
    submit.textContent = busy ? "处理中…" : `加入自选（${selected.size} 只）`;
  };
  const setBusy = (value) => {
    busy = value;
    fieldset.disabled = value || !ready;
    cancel.disabled = value;
    retry.disabled = value;
    update();
  };
  const showError = (message) => { feedback.textContent = message; feedback.hidden = false; };
  const categoryOption = (category) => `<label class="pick-item"><input type="checkbox" value="${category.id}"><span>${escapeHtml(category.name)}</span></label>`;
  async function load() {
    ready = false;
    fieldset.disabled = submit.disabled = retry.disabled = true;
    feedback.hidden = true;
    try {
      const [snapshot, watchlist] = await Promise.all([
        api(`/api/stock-ladder?date=${encodeURIComponent(day)}`), api("/api/watchlist"),
      ]);
      if (!dialog.open) return;
      members = [...new Map(snapshot.items.filter(item => item.primary_theme === theme).map(item => [item.code, item])).values()];
      existing = new Map(watchlist.items.map(item => [item.code, item]));
      stocks.innerHTML = members.map(item => {
        const watched = existing.get(item.code);
        const status = watched ? `已自选 · ${watched.categories.map(category => category.name).join("、") || "未分类"}` : "未自选";
        return `<label class="pick-item"><input type="checkbox" value="${escapeHtml(item.code)}" checked>
          <span><strong>${escapeHtml(item.name)}</strong> <span>${escapeHtml(item.code)} · ${item.consecutive} 板</span>
          <small>${escapeHtml(status)}</small></span></label>`;
      }).join("") || '<p class="picker-hint">该日没有匹配此题材的股票，请取消后重新选择日期和题材。</p>';
      options.innerHTML = (watchlist.categories || []).map(categoryOption).join("") || '<span class="chip-empty">还没有分类，可在下方创建。</span>';
      find("[data-role='coverage']").textContent = snapshot.theme_complete === false
        ? "该日题材存档未齐，仅列出已匹配的股票；可先到「悟道题材数据」补齐。" : "";
      ready = true;
      fieldset.disabled = false;
      retry.hidden = true;
      update();
    } catch (error) {
      if (!dialog.open) return;
      showError(`读取失败：${error.message}。请重试。`);
      retry.hidden = false;
    } finally {
      retry.disabled = false;
    }
  }
  async function create() {
    if (busy || !ready) return;
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    setBusy(true);
    feedback.hidden = true;
    try {
      const category = await api("/api/watchlist/categories", {method: "POST", body: JSON.stringify({name})});
      let checkbox = options.querySelector(`input[value="${category.id}"]`);
      if (!checkbox) {
        options.querySelector(".chip-empty")?.remove();
        options.insertAdjacentHTML("beforeend", categoryOption(category));
        checkbox = options.lastElementChild.querySelector("input");
      }
      checkbox.checked = true;
      input.value = "";
      return true;
    } catch (error) {
      showError(`新建分类失败：${error.message}。`);
      return false;
    } finally {
      setBusy(false);
      input.focus();
    }
  }
  stocks.addEventListener("change", update);
  mode.addEventListener("change", update);
  for (const [action, checked] of [["all", true], ["none", false]]) {
    find(`[data-action='${action}']`).addEventListener("click", () => {
      stocks.querySelectorAll("input").forEach(node => { node.checked = checked; });
      update();
    });
  }
  find("[data-action='create']").addEventListener("click", create);
  retry.addEventListener("click", load);
  cancel.addEventListener("click", () => { if (!busy) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.target === input && event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      create();
    }
  });
  find("form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || submit.disabled) return;
    if (input.value.trim() && !await create()) return;
    const selected = selectedStocks();
    const payload = {items: members.filter(item => selected.has(item.code)).map(({code, name}) => ({code, name})),
      source_date: day, category_ids: selectedCategories(), replace_categories: mode.value === "replace"};
    setBusy(true);
    feedback.hidden = true;
    try {
      await api("/api/watchlist/batch", {method: "POST", body: JSON.stringify(payload)});
      dialog.close();
      showAlert("success", `${escapeHtml(day)} · ${escapeHtml(theme)}：已保存 ${selected.size} 只股票到自选，分类已${payload.replace_categories ? "重新设置" : "追加"}。`);
    } catch (error) {
      showError([404, 405].includes(error.status)
        ? "当前服务尚未加载批量加入功能，请关闭旧服务并重新启动系统后重试。勾选已保留。"
        : `保存失败：${error.message}。勾选已保留，请重试。`);
      retry.hidden = false;
    } finally {
      setBusy(false);
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    document.body.classList.remove("watch-add-open");
  }, {once: true});
  document.body.appendChild(dialog);
  document.body.classList.add("watch-add-open");
  dialog.showModal();
  load();
}
