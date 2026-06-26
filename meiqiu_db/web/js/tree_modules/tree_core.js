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
var activeCatId = null;   // 当前高亮的分类行 ID  （如 'cat_tables_' + dbKey）
var _activeObjCat = null;   // 当前对象面板显示的类别（tables/views/procedures/functions/queries 等）
var _activeObjSchema = '';  // 当前对象面板显示的 schema
var _redisKeysCache = {};  // Redis keys 缓存 {dbId: {keys, total, cid, dbIdx}}
var _redisPanelCtx = null; // 当前右侧面板是否在展示 Redis keys {cid, dbIdx, dbId}

// 数据库类型图标（与查询窗口工具栏保持一致，使用 emoji）
var DB_ICONS = {
    'mysql':      '🐬',
    'ob-mysql':   '🌊',
    'oracle':     '🔴',
    'postgresql': '🐘',
    'mssql':      '🟢',
    'redis':      '📦'
};
var DB_DEFAULTS = {
    'mysql':      {port:'3306'},
    'ob-mysql':   {port:'2881'},
    'oracle':     {port:'1521'},
    'postgresql': {port:'5432'},
    'mssql':      {port:'1433'},
    'redis':      {port:'6379'}
};

// 数据库图标（圆柱体形状，使用 currentColor 可通过 CSS 切换颜色）
var DB_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16"><ellipse cx="12" cy="4.5" rx="9" ry="3" fill="currentColor" opacity="0.9"/><path d="M3 4.5v15c0 1.66 4.03 3 9 3s9-1.34 9-3v-15" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.75"/><ellipse cx="12" cy="12" rx="9" ry="3" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.4"/><ellipse cx="12" cy="19.5" rx="9" ry="3" fill="currentColor" opacity="0.9"/></svg>';

function getConnIcon(dbType) {
    return DB_ICONS[dbType] || '🗄️';
}

// ★ 初始化代码已移至 tree_init.js，请勿在此处添加初始化逻辑
// ★ 如需修改初始化行为，请编辑 js/tree_init.js
