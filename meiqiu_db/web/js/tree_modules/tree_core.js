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
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
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
var activeCatId = null;   // 当前高亮的分类行 ID  （如 'cat_t_' + dbKey）
var _redisKeysCache = {};  // Redis keys 缓存 {dbId: {keys, total, cid, dbIdx}}
var _redisPanelCtx = null; // 当前右侧面板是否在展示 Redis keys {cid, dbIdx, dbId}

// 数据库类型图标（SVG 徽章，纯色避免重复实例时渐变 ID 冲突）
var DB_ICONS = {
    'mysql':      '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="11" fill="#F29111"/><text x="12" y="15.5" text-anchor="middle" fill="#fff" font-size="8" font-weight="bold" font-family="Arial">MY</text></svg>',
    'ob-mysql':   '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="11" fill="#00B4D8"/><text x="12" y="15.5" text-anchor="middle" fill="#fff" font-size="7.5" font-weight="bold" font-family="Arial">OB</text></svg>',
    'oracle':     '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="2" y="2" width="20" height="20" rx="3.5" fill="#C74634"/><text x="12" y="15.5" text-anchor="middle" fill="#fff" font-size="7.5" font-weight="bold" font-family="Arial">OR</text></svg>',
    'postgresql': '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="11" fill="#336791"/><text x="12" y="15.5" text-anchor="middle" fill="#fff" font-size="7.5" font-weight="bold" font-family="Arial">PG</text></svg>',
    'mssql':      '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="2" y="2" width="20" height="20" rx="3.5" fill="#CC2927"/><text x="12" y="15.5" text-anchor="middle" fill="#fff" font-size="7.5" font-weight="bold" font-family="Arial">MS</text></svg>',
    'redis':      '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="1" y="1" width="22" height="22" rx="4" fill="#DC382D"/><path d="M18.5 6.5c0 1.5-3 3-6.5 3s-6.5-1.5-6.5-3 3-3 6.5-3 6.5 1.5 6.5 3z" fill="#fff" opacity="0.9"/><path d="M18.5 10.5c0 1.5-3 3-6.5 3s-6.5-1.5-6.5-3" fill="none" stroke="#fff" stroke-width="1.2" opacity="0.7"/><path d="M18.5 15c0 1.5-3 3-6.5 3s-6.5-1.5-6.5-3" fill="none" stroke="#fff" stroke-width="1.2" opacity="0.5"/><rect x="5.5" y="17" width="13" height="1" rx="0.5" fill="#fff" opacity="0.6"/></svg>'
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
    return DB_ICONS[dbType] || DB_ICONS['mysql'];
}

// ★ 初始化代码已移至 tree_init.js，请勿在此处添加初始化逻辑
// ★ 如需修改初始化行为，请编辑 js/tree_init.js
