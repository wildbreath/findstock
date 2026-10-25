/* 自选股卡片复用天梯的20根本地日K，仅加载可见卡片。 */
const watchChartCache = new Map();
const watchChartQueue = [];
const watchChartObserved = new Set();
const watchChartVisible = new Set();
let watchChartActive = 0;
let watchChartObserver;

function paintWatchCharts(code, day) {
  const selector = code == null ? ".watch-mini-chart"
    : `.watch-mini-chart[data-code=${JSON.stringify(code)}][data-date=${JSON.stringify(day)}]`;
  $("watchlist-list").querySelectorAll(selector).forEach((node) => {
    const state = watchChartCache.get(`${node.dataset.date}:${node.dataset.code}`);
    const markup = !node.dataset.date ? "本地暂无日K"
      : state?.markup || (state?.error ? "日K未就绪" : "日K加载中");
    if (node.watchChartMarkup !== markup) {
      node.innerHTML = markup;
      node.watchChartMarkup = markup;
    }
    node.title = state?.error || (node.dataset.date
      ? "最近20根本地日K；点击查看完整K线"
      : "本地暂无日K，请下载行情后刷新");
    if (!node.dataset.date || state?.markup || state?.error) {
      watchChartObserver?.unobserve(node);
      watchChartObserved.delete(node);
      watchChartVisible.delete(node);
    }
  });
}

function queueWatchChart(code, day) {
  const key = `${day}:${code}`;
  if (!day || watchChartCache.has(key)) return;
  const state = {};
  watchChartCache.set(key, state);
  watchChartQueue.push({code, day, state});
  drainWatchCharts();
}

function drainWatchCharts() {
  while (watchChartActive < 3 && watchChartQueue.length) {
    const {code, day, state} = watchChartQueue.shift();
    const key = `${day}:${code}`;
    if (watchChartCache.get(key) !== state) continue;
    if (watchChartObserver && !Array.from(watchChartVisible).some((node) =>
      node.isConnected && node.dataset.code === code && node.dataset.date === day)) {
      watchChartCache.delete(key);
      continue;
    }
    watchChartActive++;
    api(`/api/stocks/${encodeURIComponent(code)}/chart?limit=20&end=${encodeURIComponent(day)}`)
      .then((payload) => { state.markup = renderMiniChart(payload.bars, day); })
      .catch((error) => { state.error = error.message; })
      .finally(() => {
        watchChartActive--;
        try {
          if (watchChartCache.get(key) === state) paintWatchCharts(code, day);
        } finally {
          drainWatchCharts();
        }
      });
  }
}

function observeWatchCharts() {
  paintWatchCharts();
  if (!watchChartObserver && typeof IntersectionObserver !== "undefined") {
    watchChartObserver = new IntersectionObserver((entries) => {
      entries.forEach(({target, isIntersecting}) => {
        if (!isIntersecting || !target.isConnected) {
          watchChartVisible.delete(target);
          return;
        }
        const state = watchChartCache.get(`${target.dataset.date}:${target.dataset.code}`);
        if (state?.markup || state?.error) return;
        watchChartVisible.add(target);
        queueWatchChart(target.dataset.code, target.dataset.date);
      });
      drainWatchCharts();
    });
  }
  watchChartObserved.forEach((node) => {
    if (node.isConnected) return;
    watchChartObserver?.unobserve(node);
    watchChartObserved.delete(node);
    watchChartVisible.delete(node);
  });
  $("watchlist-list").querySelectorAll(".watch-mini-chart").forEach((node) => {
    const state = watchChartCache.get(`${node.dataset.date}:${node.dataset.code}`);
    if (!node.dataset.date || state?.markup || state?.error) return;
    if (!watchChartObserver) {
      queueWatchChart(node.dataset.code, node.dataset.date);
      return;
    }
    if (!watchChartObserved.has(node)) {
      watchChartObserved.add(node);
      watchChartObserver.observe(node);
    }
    if (watchChartVisible.has(node)) queueWatchChart(node.dataset.code, node.dataset.date);
  });
  drainWatchCharts();
}

function clearWatchCharts() {
  watchChartCache.clear();
  watchChartQueue.length = 0;
}
