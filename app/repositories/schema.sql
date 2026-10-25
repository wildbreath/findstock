-- 沪深A股自动筛选系统 —— 数据库结构
-- 日期一律使用 ISO 文本 (yyyy-mm-dd), 便于排序与比较。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER NOT NULL,
    applied_at  TEXT    NOT NULL
);

-- 交易日历 (含非交易日, is_open 标记是否交易)
CREATE TABLE IF NOT EXISTS trading_day (
    trade_date  TEXT    PRIMARY KEY,
    is_open     INTEGER NOT NULL
);

-- 股票基础信息
CREATE TABLE IF NOT EXISTS stock (
    code            TEXT    PRIMARY KEY,           -- 例如 sh.600000
    exchange        TEXT    NOT NULL,              -- sh / sz
    symbol          TEXT    NOT NULL,              -- 600000
    name            TEXT,                          -- 最近一次已知简称
    board           TEXT    NOT NULL,
    ipo_date        TEXT,
    out_date        TEXT,
    listing_date    TEXT,                          -- 上市时间下界 (用于排除次新股)
    first_bar_date  TEXT,                          -- 本地最早一根K线
    last_sync_end   TEXT,                          -- 最近一次成功抓取到的区间终点
    is_active       INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_symbol ON stock (symbol);

-- 每个交易日对应的股票简称 (用于按历史日期展示简称与判断ST)
CREATE TABLE IF NOT EXISTS stock_name_history (
    code        TEXT NOT NULL,
    trade_date  TEXT NOT NULL,
    name        TEXT NOT NULL,
    PRIMARY KEY (code, trade_date)
);

-- 日线行情
CREATE TABLE IF NOT EXISTS daily_bar (
    code        TEXT    NOT NULL,
    trade_date  TEXT    NOT NULL,
    open        REAL,
    high        REAL,
    low         REAL,
    close       REAL,
    preclose    REAL,
    volume      INTEGER,
    amount      REAL,
    turnover    TEXT,
    pct_chg     TEXT,               -- 保留数据源原始精度, 参与精确比较
    trade_status INTEGER,           -- 1=正常交易 0=停牌
    PRIMARY KEY (code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_bar_date ON daily_bar (trade_date, code);

-- 涨停池按日存档, 独立于日线下载; 不保存上游含义不明的空返回。
CREATE TABLE IF NOT EXISTS ladder_snapshot (
    trade_date  TEXT PRIMARY KEY,
    fetched_at  TEXT NOT NULL,
    payload     TEXT NOT NULL
);

-- 悟道题材批量分页下载：原始页、股票日分类和进度均落库，浏览不访问外部接口。
CREATE TABLE IF NOT EXISTS wudao_theme_batch (
    id INTEGER PRIMARY KEY,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    next_page INTEGER NOT NULL DEFAULT 1,
    total INTEGER,
    total_pages INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    is_final INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wudao_theme_page (
    batch_id INTEGER NOT NULL REFERENCES wudao_theme_batch(id),
    page INTEGER NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (batch_id, page)
);
CREATE TABLE IF NOT EXISTS wudao_theme_row (
    batch_id INTEGER NOT NULL REFERENCES wudao_theme_batch(id),
    trade_date TEXT NOT NULL,
    code TEXT NOT NULL,
    primary_theme TEXT,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (batch_id, trade_date, code)
);
CREATE INDEX IF NOT EXISTS idx_wudao_theme_day ON wudao_theme_row(trade_date, code);

-- 股票历史简称 (由旧到新), 用于推断历史日期的 ST 状态
CREATE TABLE IF NOT EXISTS stock_name_change (
    code    TEXT    NOT NULL,
    seq     INTEGER NOT NULL,           -- 0 = 最早
    name    TEXT    NOT NULL,
    PRIMARY KEY (code, seq)
);

-- 历史简称的抓取记录 (即使返回为空也要记下来, 避免反复请求)
CREATE TABLE IF NOT EXISTS stock_name_change_fetch (
    code        TEXT PRIMARY KEY,
    fetched_at  TEXT    NOT NULL,
    entry_count INTEGER NOT NULL
);

-- 已完整下载的交易日
CREATE TABLE IF NOT EXISTS synced_day (
    trade_date      TEXT PRIMARY KEY,
    bar_count       INTEGER NOT NULL DEFAULT 0,
    completed_at    TEXT NOT NULL
);

-- 同步任务
CREATE TABLE IF NOT EXISTS sync_run (
    run_id          TEXT PRIMARY KEY,
    mode            TEXT NOT NULL,
    status          TEXT NOT NULL,
    phase           TEXT NOT NULL DEFAULT 'pending',
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    total_stocks    INTEGER NOT NULL DEFAULT 0,
    done_stocks     INTEGER NOT NULL DEFAULT 0,
    total_days      INTEGER NOT NULL DEFAULT 0,
    done_days       INTEGER NOT NULL DEFAULT 0,
    message         TEXT,
    error           TEXT,
    pid             INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sync_run_started ON sync_run (started_at DESC);

-- 通用键值元数据
CREATE TABLE IF NOT EXISTS meta (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- 自选股 (用户在筛选结果里收藏的股票)
CREATE TABLE IF NOT EXISTS watchlist (
    code        TEXT PRIMARY KEY,          -- 例如 sh.600000
    name        TEXT,                      -- 收藏时的股票简称
    board       TEXT,                      -- 收藏时的板块
    source_date TEXT,                      -- 从哪一天的筛选结果里收藏的 (D2)
    note        TEXT,
    note_highlights TEXT NOT NULL DEFAULT '[]',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    added_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watchlist_added ON watchlist (added_at DESC);

-- 自选股分类 (用户自建)
CREATE TABLE IF NOT EXISTS watchlist_category (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL
);

-- 自选股与分类的多对多关系 (同一只股票可以属于多个分类)
CREATE TABLE IF NOT EXISTS watchlist_member (
    code        TEXT    NOT NULL,
    category_id INTEGER NOT NULL,
    added_at    TEXT    NOT NULL,
    PRIMARY KEY (code, category_id),
    FOREIGN KEY (code) REFERENCES watchlist (code) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES watchlist_category (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watchlist_member_category
    ON watchlist_member (category_id);

-- 选股策略 (条件模块组合, conditions 里是 JSON)
CREATE TABLE IF NOT EXISTS screen_strategy (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    conditions  TEXT    NOT NULL,
    builtin     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
