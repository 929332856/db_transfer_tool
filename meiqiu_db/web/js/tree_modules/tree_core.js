"use strict";
console.log('tree.js loaded');

// 内置工具函数（避免依赖 main.js 加载顺序）
var _escapeHtmlMap = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function(c) { return _escapeHtmlMap[c]; });
}
function escapeAttr(str) {
    if (str == null) return '';
    str = String(str);
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/'/g, "\\'");
}
// 复制文本到剪贴板
function copyToClipboard(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch(e) {}
    document.body.removeChild(ta);
}
// 安全的 base64 编码，处理非 ASCII 字符
function safeBtoa(str) {
    if (str == null) return '';
    try {
        return btoa(str).replace(/[=+/]/g,'');
    } catch(e) {
        // 回退：替换非字母数字字符
        return str.replace(/[^a-zA-Z0-9]/g,'_');
    }
}

var treeData = null;
var activeConnId = null;
var activeConnData = null;
var activeDatabase = null;
var objectTabs = [];
var activeObjTab = null;
// 每个数据表 tab 独立保存滚动位置，切换 tab 时不丢失视图状态。
var _tableScrollStates = {};
var activeCatId = null;   // 当前高亮的分类行 ID  （如 'cat_tables_' + dbKey）
var _activeObjCat = null;   // 当前对象面板显示的类别（tables/views/procedures/functions/queries 等）
var _activeObjSchema = '';  // 当前对象面板显示的 schema
var _redisKeysCache = {};  // Redis keys 缓存 {dbId: {keys, total, cid, dbIdx}}
var _redisPanelCtx = null; // 当前右侧面板是否在展示 Redis keys {cid, dbIdx, dbId}

// ★ 数据库品牌 logo <img> 标签生成器（使用 database/ 目录下的 .svg 文件）
var _DB_LOGO_MAP = {
    'mysql': 'mysql.svg',
    'ob-mysql': 'oceanbase.svg',
    'oceanbase': 'oceanbase.svg',
    'oracle': 'oracle.svg',
    'postgresql': 'postgres.svg',
    'mssql': 'sqlserver.svg',
    'redis': 'redis.svg',
    'mariadb': 'mariadb.svg',
    'mongodb': 'mongodb.svg',
    'tidb': 'tidb.svg',
    'dm': 'dm.svg',
    'sqlite': 'sqlite.svg',
    'elasticsearch': 'elasticsearch.svg',
    'clickhouse': 'clickhouse.svg',
    'duckdb': 'duckdb.svg',
    'kafka': 'kafka.svg',
    'hbase': 'hbase.svg',
    'hive': 'hive.svg',
    'cassandra': 'cassandra.svg',
    'neo4j': 'neo4j.svg',
    'cockroach': 'cockroach.svg',
    'couchbase': 'couchbase.svg',
    'firebird': 'firebird.svg',
    'informix': 'informix.svg',
    'hsqldb': 'hsqldb.svg',
    'snowflake': 'snowflake.svg',
    'singlestore': 'singlestore.svg',
    'vertica': 'vertica.svg',
    'yugabyte': 'yugabyte.svg',
    'rocksdb': 'rocksdb.svg',
    'questdb': 'questdb.svg',
    'timescaledb': 'timescaledb.svg',
    'teradata': 'teradata.svg',
    'kdb': 'kdb.svg',
    'meilisearch': 'meilisearch.svg',
    'opensearch': 'opensearch.svg',
    'qdrant': 'qdrant.svg',
    'typesense': 'typesense.svg',
    'risingwave': 'risingwave.svg',
    'rabbitmq': 'rabbitmq.svg',
    's3': 's3.svg'
};
function _dbLogoImg(type, size) {
    size = size || 16;
    var file = _DB_LOGO_MAP[type];
    if (file) {
        return '<img src="database/' + file + '" width="' + size + '" height="' + size + '" style="vertical-align:middle;display:inline-block;flex-shrink:0" alt="">';
    }
    // 未知类型回退到通用数据库内联 SVG，避免引用不存在的 unknown.svg
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" style="vertical-align:middle;display:inline-block;flex-shrink:0"><ellipse cx="12" cy="4.5" rx="9" ry="3" fill="currentColor" opacity="0.9"/><path d="M3 4.5v15c0 1.66 4.03 3 9 3s9-1.34 9-3v-15" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.75"/><ellipse cx="12" cy="12" rx="9" ry="3" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.4"/><ellipse cx="12" cy="19.5" rx="9" ry="3" fill="currentColor" opacity="0.9"/></svg>';
}

// 数据库类型图标（emoji 保留用于 select/option 标签，option 不支持 html img）
var DB_ICONS = {
    'mysql':      '🐬',
    'ob-mysql':   '🌊',
    'oracle':     '🔴',
    'postgresql': '🐘',
    'mssql':      '🟢',
    'redis':      '🗃'
};
var DB_DEFAULTS = {
    'mysql':      {port:'3306', user:'root'},
    'ob-mysql':   {port:'2881', user:'root'},
    'oracle':     {port:'1521', user:'system'},
    'postgresql': {port:'5432', user:'postgres'},
    'mssql':      {port:'1433', user:'sa'},
    'redis':      {port:'6379'}
};

// 数据库图标（通用圆柱体，使用 currentColor 可通过 CSS 切换颜色，用于数据库节点分组图标）
var DB_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align:middle;display:inline-block;flex-shrink:0"><ellipse cx="12" cy="4.5" rx="9" ry="3" fill="currentColor" opacity="0.9"/><path d="M3 4.5v15c0 1.66 4.03 3 9 3s9-1.34 9-3v-15" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.75"/><ellipse cx="12" cy="12" rx="9" ry="3" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.4"/><ellipse cx="12" cy="19.5" rx="9" ry="3" fill="currentColor" opacity="0.9"/></svg>';

function getConnIcon(dbType) {
    return _dbLogoImg(dbType, 16);
}

// ★ 初始化代码已移至 tree_init.js，请勿在此处添加初始化逻辑
// ★ 如需修改初始化行为，请编辑 js/tree_init.js
