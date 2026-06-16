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

// ==================== 初始化（提前执行，避免后续代码错误影响树加载） ====================
(function _initTreeLoader() {
    var attempts = 0;
    var maxAttempts = 60; // 最多等 60 次（60*500ms = 30秒）
    function _diag(m,c) { try { if (typeof _diag_add === 'function') _diag_add(m,c); } catch(e){} }
    function tryLoad() {
        try {
            if (typeof eel === 'undefined') {
                if (++attempts < maxAttempts) { setTimeout(tryLoad, 500); }
                else { _diag('[tree] eel 30s not ready', 'err'); }
                return;
            }
            _diag('[tree] eel found (attempt='+attempts+')', attempts>5?'warn':'ok');
            // PyInstaller 回退修复：如果 /eel.js 加载失败回退到静态 js/eel.js，
            // _py_functions 为空，需要手动导入 tree_load
            if (typeof eel.tree_load !== 'function' && typeof eel._import_py_function === 'function') {
                _diag('[tree] tree_load missing, manual import...', 'warn');
                // 手动导入关键函数（其余函数按需在主流程中也会触发导入）
                var criticalFns = ['tree_load', 'tree_diag', 'tree_save', 'tree_backup_now', 'tree_add_folder',
                    'tree_rename_folder', 'tree_delete_folder', 'tree_add_connection',
                    'tree_update_connection', 'tree_delete_connection', 'tree_move_connection',
                    'tree_save_query', 'tree_get_query', 'tree_delete_query', 'tree_test_conn',
                    'tree_get_backups', 'tree_force_recover', 'tree_check_integrity',
                    'db_explore_get_databases', 'db_explore_get_schemas', 'db_explore_get_tables',
                    'db_explore_get_views', 'db_explore_get_procedures', 'db_explore_get_triggers',
                    'db_explore_get_table_ddl', 'db_get_info', 'db_get_collations', 'db_delete',
                    'table_preview_data', 'table_preview_data_fast', 'table_save_changes', 'table_exec_save',
                    'table_delete_rows', 'table_exec_delete',
                    'table_get_ddl', 'table_get_design_info', 'table_apply_design',
                    'table_truncate', 'table_delete', 'table_clear',
                    'redis_get_databases', 'redis_get_keys', 'redis_get_key_info',
                    'redis_get_keys_meta', 'redis_execute', 'redis_delete_key',
                    'redis_set_string', 'redis_set_hash', 'redis_set_list',
                    'redis_set_set', 'redis_set_zset', 'redis_append_list',
                    'redis_append_set', 'redis_append_zset',
                    'execute_sql_query', 'cancel_query', 'clear_cancel', 'poll_queue',
                    'drag_copy_table', 'db_run_sql_file',
                    'get_profiles', 'get_last_used', 'save_profile', 'delete_profile',
                    'find_profile', 'test_connection', 'start_transfer', 'stop_transfer',
                    'import_query_results', 'execute_sql_file',
                    'ping', 'debug_python_info'];
                var imported = 0;
                for (var i = 0; i < criticalFns.length; i++) {
                    if (typeof eel[criticalFns[i]] !== 'function') {
                        try { eel._import_py_function(criticalFns[i]); imported++; } catch(e) {}
                    }
                }
                _diag('[tree] manual import done, imported='+imported, 'ok');
            }
            if (typeof eel.tree_load === 'function') {
                _diag('[tree] tree_load available, calling ping+loadTree', 'ok');
                // 先 ping 验证通信，再加载树
                if (typeof eel.ping === 'function') {
                    try { eel.ping()(function(r) { _diag('[tree] ping response: '+(r||'null'), 'ok'); }); } catch(e) {}
                }
                loadTree();
                // 加载后自动运行诊断（控制台可见，打包 exe 按 F12 查看）
                if (typeof eel.tree_diag === 'function') {
                    try {
                        eel.tree_diag()(function(d) {
                            if (d) {
                                console.log('[tree] 诊断: frozen='+d.frozen+', TREE_FILE='+d.tree_file+', exists='+d.tree_file_exists+', size='+d.tree_file_size+', conns='+(d.connections_count||'?')+', valid='+d.valid+', hasContent='+d.has_content);
                                if (d.parse_error) console.error('[tree] 解析错误: '+d.parse_error);
                            }
                        });
                    } catch(e) { console.warn('[tree] tree_diag 调用失败', e); }
                }
            } else {
                _diag('[tree] tree_load still missing, retry...', 'warn');
                if (++attempts < maxAttempts) { setTimeout(tryLoad, 500); }
                else { _diag('[tree] GAVE UP after 30s', 'err'); }
            }
        } catch (err) {
            _diag('[tree] exception: '+(err.message||err), 'err');
            if (++attempts < maxAttempts) { setTimeout(tryLoad, 1000); }
        }
    }
    // 立即尝试，如果 eel 还没就绪则轮询等待
    tryLoad();
})();

// ==================== 面板切换 ====================
function showPanel(name) {
    document.querySelectorAll('.content-panel').forEach(function (p) { p.classList.remove('active'); });
    var panel = document.getElementById('panel_' + name);
    if (panel) panel.classList.add('active');
    document.querySelectorAll('.top-tab-btn').forEach(function (b) { b.classList.remove('active'); });
    var tabMap = { my_connections: 0, sync: 1, query: 2, slowquery: 3 };
    var idx = tabMap[name];
    if (idx !== undefined) {
        var btns = document.querySelectorAll('.top-tab-btn');
        if (btns[idx]) btns[idx].classList.add('active');
    }
    // 切换到慢SQL面板时，刷新连接选择器
    if (name === 'slowquery' && typeof refreshSqConnSelector === 'function') {
        setTimeout(refreshSqConnSelector, 50);
    }
}

// ==================== 我的连接列表 ====================
function renderMyConnectionsList() {
    if (!treeData) { console.warn('[tree.js] renderMyConnectionsList: treeData 为空，跳过渲染'); return; }
    var list = document.getElementById('my_conn_list');
    if (!list) { console.warn('[tree.js] renderMyConnectionsList: #my_conn_list 不存在'); return; }
    var html = '';
    try {
        var rootFolders = (treeData.folders || []).filter(function (f) { return !f.parent; });
        rootFolders.forEach(function (f) {
            html += renderFolder(f, 0);
        });
        getConnectionsByFolder('').forEach(function (c) { html += renderConn(c, 0); });
        list.innerHTML = html || '<div style="padding:20px;color:#999;">点击上方按钮新建文件夹或连接</div>';
    } catch (err) {
        console.error('[tree.js] 渲染连接列表异常:', err.message || err);
        list.innerHTML = '<div style="padding:20px;color:#e74c3c;">❌ 渲染连接列表时出错，请刷新页面重试</div>';
    }
    // 根区域作为 drop 目标（拖连接移出文件夹）
    list.ondragover = onConnRootDragOver;
    list.ondragleave = onConnRootDragLeave;
    list.ondrop = onConnRootDrop;
}

function getConnectionsByFolder(pid) {
    var r = [];
    for (var k in treeData.connections) {
        if ((treeData.connections[k].parent || '') === pid) r.push(treeData.connections[k]);
    }
    return r;
}

function renderFolder(f, indent) {
    var fid = f.id;
    var subs = (treeData.folders || []).filter(function (x) { return x.parent === f.id; });
    var conns = getConnectionsByFolder(fid);
    var hasKids = subs.length > 0 || conns.length > 0;
    return '<div class="tree-node" data-fid="'+fid+'"><div class="my-conn-row folder-row drop-folder" style="padding-left:'+(indent+12)+'px" onclick="event.stopPropagation();highlightRow(this)" oncontextmenu="folderCtx(event,\''+fid+'\')" ondragover="onConnFolderDragOver(event,this,\''+fid+'\')" ondragleave="onConnFolderDragLeave(event,this)" ondrop="onConnFolderDrop(event,\''+fid+'\')">' +
        (hasKids ? '<span class="arrow" id="ma_'+fid+'" onclick="event.stopPropagation();toggleChildren(\'mc_'+fid+'\',\'ma_'+fid+'\')">▸</span>' : '<span class="arrow" id="ma_'+fid+'" style="visibility:hidden">▸</span>') +
        '<span class="my-conn-icon">📁</span><span class="my-conn-name">' + escapeHtml(f.name) + '</span></div>' +
        '<div class="tree-children" id="mc_'+fid+'">' +
        subs.map(function(s){return renderFolder(s,indent+16);}).join('') +
        conns.map(function(c){return renderConn(c,indent+16);}).join('') +
        '</div></div>';
}

function renderConn(c, indent) {
    var cid = c.id;
    var pad = indent + 12;
    var icon = getConnIcon(c.db_type||'mysql');
    return '<div class="tree-node" data-cid="'+cid+'"><div class="my-conn-row conn-row drag-conn-item" draggable="true" style="padding-left:'+pad+'px" ondblclick="expandConn(\''+cid+'\','+pad+')" oncontextmenu="connCtx(event,\''+cid+'\')" ondragstart="onConnDragStart(event,\''+cid+'\')" ondragend="onConnDragEnd(event,\''+cid+'\')">' +
        '<span class="arrow" id="ma_c_'+cid+'" onclick="event.stopPropagation();toggleConnChildren(\''+cid+'\')" style="visibility:hidden">▸</span>' +
        '<span class="my-conn-icon db-icon closed">'+icon+'</span><span class="my-conn-name">'+escapeHtml(c.name)+'</span>' +
        '<span class="my-conn-host">'+escapeHtml(c.host+':'+c.port)+'</span></div>' +
        '<div class="tree-children" id="mc_c_'+cid+'"></div></div>';
}

function expandConn(cid, pad) {
    var children = document.getElementById('mc_c_'+cid);
    var arrow = document.getElementById('ma_c_'+cid);
    if (!children) return;
    var connIcon = arrow ? arrow.parentElement.querySelector('.db-icon') : null;
    // ★ 双击只展开（不折叠），折叠由箭头单独处理
    if (children.classList.contains('open')) {
        // 已展开，只高亮+选中，不折叠
        if (arrow) highlightRow(arrow.parentElement);
        return;
    }
    children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#999;font-size:11px;">⏳ 加载数据库...</div>';
    children.classList.add('open');
    if (arrow) { arrow.textContent = '▾'; arrow.style.visibility = 'visible'; }
    if (connIcon) { connIcon.classList.remove('closed'); connIcon.classList.add('active'); }
    var conn = treeData.connections[cid];
    if (!conn) return;
    activeConnId = cid; activeConnData = conn;
    // 切换连接时清除 Redis 面板上下文
    _redisPanelCtx = null;
    // 高亮连接行
    if (arrow) highlightRow(arrow.parentElement);
    // 切换连接时切换到 home tab，不清空已有 tab
    var homeContent = '<div style="padding:40px;text-align:center;color:#666;"><div style="font-size:36px;margin-bottom:10px;">📄</div><div>点击表、视图等分类查看对象</div></div>';
    var homeTab = objectTabs.find(function(t){return t.id==='obj_home';});
    if (!homeTab) { objectTabs.push({id:'obj_home',label:'对象',type:'home',content:homeContent,db:''}); }
    else { homeTab.content = homeContent; }
    activeObjTab = 'obj_home';
    activeCatId = null;
    renderObjectPanel();

    var isPg = conn.db_type === 'postgresql';
    var isRedis = conn.db_type === 'redis';
    if (isRedis) {
        // Redis 连接展开 → 显示数据库列表（db0, db1, ...）
        children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#999;font-size:11px;">⏳ 加载数据库列表...</div>';
        var redisTimeoutId = setTimeout(function() {
            children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌ 加载超时（15秒），请检查 Redis 连接是否正常</div>';
        }, 15000);
        console.log('调用redis_get_databases', conn.host);
        if (typeof eel === 'undefined') {
            console.error('eel 对象未定义！确保 main.js 已加载且 Eel 已初始化');
            children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌ JS错误: eel未定义</div>';
            return;
        }
        try {
            eel.redis_get_databases(conn)(function(r) {
                console.log('Redis DB列表回调触发', r);
                clearTimeout(redisTimeoutId);
                if (!r) { console.error('Redis DB列表返回null'); children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌ 返回null</div>'; return; }
                if (!r.ok) { console.error('Redis DB列表返回ok=false:', r.msg); children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌ '+(r?r.msg:'')+'</div>'; return; }
                console.log('Redis DB列表成功:', (r.databases||[]).length, '个DB');
                var html = '';
                // 顶部信息栏
                var totalKeys = 0;
                (r.databases||[]).forEach(function(d){ totalKeys += d.keys; });
                html += '<div style="padding-left:'+(pad+20)+'px;color:#888;font-size:10px;padding-top:4px;padding-bottom:6px;">共 '+(r.databases||[]).length+' 个DB，'+totalKeys+' 个 key</div>';
                (r.databases||[]).forEach(function(dbInfo) {
                    var dbIdx = dbInfo.db;
                    var dbId = cid + '_rdb_' + dbIdx;
                    html += '<div class="tree-node"><div class="my-conn-row" style="padding-left:'+(pad+20)+'px" ondblclick="expandRedisDb(\''+cid+'\','+dbIdx+',\''+dbId+'\','+(pad+20)+')">' +
                        '<span class="arrow" id="ar_'+dbId+'" onclick="event.stopPropagation();toggleRedisDb(\''+cid+'\','+dbIdx+',\''+dbId+'\','+(pad+20)+')">▸</span>' +
                        '<span class="my-conn-icon db-icon closed">'+DB_ICON_SVG+'</span>' +
                        '<span class="my-conn-name">DB' + dbIdx + '</span>' +
                        '<span style="margin-left:auto;color:#888;font-size:10px;">'+dbInfo.keys+' keys</span></div>' +
                        '<div class="tree-children" id="'+dbId+'"></div></div>';
                });
                children.innerHTML = html || '<div style="padding-left:'+(pad+20)+'px;color:#999;font-size:11px;">（无 DB）</div>';
            });
        } catch (err) {
            console.error('调用 eel.redis_get_databases 时捕获异常:', err);
            children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌ JS异常: ' + escapeHtml(err.message) + '</div>';
        }
        return;
    }
    eel.db_explore_get_databases(conn)(function (r) {
        if (!r || !r.ok) { children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌</div>'; return; }
        var html = '';
        r.databases.forEach(function (db) {
            var dbId = cid + '_db_' + safeBtoa(db);
            var dropAttrs = ' ondragover="onDbDragOver(event,this)" ondragleave="onDbDragLeave(event,this)" ondrop="onDbDrop(event,this,\''+cid+'\',\''+escapeAttr(db)+'\')"';
            var ctxAttr = ' oncontextmenu="dbCtx(event,\''+cid+'\',\''+escapeAttr(db)+'\',\''+dbId+'\')"';
            if (isPg) {
                html += '<div class="tree-node db-node" data-cid="'+cid+'" data-db="'+escapeAttr(db)+'"><div class="my-conn-row" style="padding-left:'+(pad+20)+'px"'+dropAttrs+ctxAttr+' ondblclick="selectDatabase(\''+cid+'\',\''+escapeAttr(db)+'\',\''+dbId+'\',\'ar_'+dbId+'\')">' +
                    '<span class="arrow" id="ar_'+dbId+'" onclick="event.stopPropagation();toggleDbChildren(\''+dbId+'\',\'ar_'+dbId+'\')" style="visibility:hidden">▸</span><span class="my-conn-icon db-icon closed">'+DB_ICON_SVG+'</span><span class="my-conn-name">'+escapeHtml(db)+'</span></div>' +
                    '<div class="tree-children" id="'+dbId+'"></div></div>';
            } else {
                html += '<div class="tree-node db-node" data-cid="'+cid+'" data-db="'+escapeAttr(db)+'"><div class="my-conn-row" style="padding-left:'+(pad+20)+'px"'+dropAttrs+ctxAttr+' ondblclick="selectDatabase(\''+cid+'\',\''+escapeAttr(db)+'\',\''+dbId+'\',\'ar_'+dbId+'\')">' +
                    '<span class="arrow" id="ar_'+dbId+'" onclick="event.stopPropagation();toggleDbChildren(\''+dbId+'\',\'ar_'+dbId+'\')" style="visibility:hidden">▸</span><span class="my-conn-icon db-icon closed">'+DB_ICON_SVG+'</span><span class="my-conn-name">'+escapeHtml(db)+'</span></div>' +
                    '<div class="tree-children" id="'+dbId+'">' + renderDbCats(cid, db, pad+40) + '</div></div>';
            }
        });
        children.innerHTML = html || '<div style="padding-left:'+(pad+20)+'px;color:#999;font-size:11px;">（无数据库）</div>';
    });
}

function renderDbCats(cid, db, pad, schema) {
    var key = schema ? db+'/'+schema : db;
    var dbKey = safeBtoa(key);
    var p = pad + 16;
    var sch = schema || '';
    return catRow('tables','📋',cid,db,dbKey,p,'clickTableCat','tableCatCtx',sch) +
           catRow('views','👁',cid,db,dbKey,p,'clickCat','',sch) +
           catRow('procedures','⚙',cid,db,dbKey,p,'clickCat','',sch) +
           catRow('functions','𝑓',cid,db,dbKey,p,'clickCat','',sch) +
           catRow('queries','📝',cid,db,dbKey,p,'clickQueries','qLabelCtx',sch);
}

function catRow(cat, icon, cid, db, dbKey, pad, clickFn, ctxFn, schema) {
    var sch = schema || '';
    var rowId = 'cat_'+cat.charAt(0)+'_'+dbKey;
    var clickArgs = (cat==='tables') ? '\''+cid+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\''
        : (cat==='queries') ? '\''+cid+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\''
        : '\''+cid+'\',\''+escapeAttr(db)+'\',\''+cat+'\',\''+escapeAttr(sch)+'\'';
    var expandFn = (cat==='queries') ? 'expandQueries' : 'expandCat';
    var expandArgs = (cat==='queries') ? '\''+cid+'\',\''+dbKey+'\','+pad+',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\''
        : '\''+cat+'\',\''+cid+'\',\''+escapeAttr(db)+'\',\''+dbKey+'\','+pad+',\''+escapeAttr(sch)+'\'';
    var ctx = ctxFn ? ' oncontextmenu="'+ctxFn+'(event,\''+cid+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\')"' : '';
    var extraAttrs = (cat==='queries') ? ' data-cid="'+cid+'" data-db="'+escapeAttr(db)+'" data-pad="'+pad+'"' : '';
    // 所有分类加刷新按钮，仅表分类加拖放目标
    var catLabel = cat==='tables'?'表':cat==='views'?'视图':cat==='procedures'?'存储过程':cat==='functions'?'函数':'查询';
    var refreshArgs = '\''+cat+'\',\''+cid+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+dbKey+'\','+pad;
    var refreshBtn = '<span class="cat-refresh" onclick="event.stopPropagation();refreshCatItem('+refreshArgs+')" title="刷新'+catLabel+'列表">🔄</span>';
    var dropAttrs = '';
    if (cat === 'tables') {
        dropAttrs = ' ondragover="onDbDragOver(event,this)" ondragleave="onDbDragLeave(event,this)" ondrop="onTableFolderDrop(event,this,\''+cid+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\')"';
    }
    return '<div class="my-conn-row tree-subcat cat-row" id="'+rowId+'" style="padding-left:'+pad+'px" onclick="'+clickFn+'('+clickArgs+');highlightCat(\''+rowId+'\')"'+ctx+dropAttrs+'>' +
        '<span class="arrow" id="ar_'+rowId+'" onclick="event.stopPropagation();'+expandFn+'('+expandArgs+')">▸</span>' +
        icon+' ' + (cat==='tables'?'表':cat==='views'?'视图':cat==='procedures'?'存储过程':cat==='functions'?'函数':'查询') + refreshBtn +
        '</div><div class="tree-children" id="'+rowId+'"'+extraAttrs+'></div>';
}

// 通用行高亮：清除所有高亮，给指定元素加上高亮
function highlightRow(el) {
    document.querySelectorAll('.tree-highlight').forEach(function(r){r.classList.remove('tree-highlight');});
    if (el) {
        el.classList.add('tree-highlight');
        activeCatId = el.id || '';
    }
}
function highlightCat(rowId) { highlightRow(document.getElementById(rowId)); }

// ==================== 数据库右键菜单 ====================
function dbCtx(e, cid, db, dbId) {
    e.preventDefault(); e.stopPropagation();
    var el = document.getElementById(dbId);
    var isOpen = el && el.classList.contains('open');
    var menu;
    if (isOpen) {
        menu = [
            {label:'📂 运行SQL文件',action:function(){showRunSqlFile(cid, db);}},
            '---',
            {label:'✏️ 编辑数据库',action:function(){showEditDatabase(cid, db);}},
            {label:'🔄 关闭数据库',action:function(){closeDatabase(cid, db, dbId);}},
            '---',
            {label:'❌ 删除数据库',action:function(){showConfirmDialog('⚠️ 危险操作','确定删除数据库 ['+db+']？所有数据将丢失！',function(){eel.db_delete(activeConnData,db)(function(r){if(r&&r.ok){showOkDialog('成功',r.msg);refreshDatabaseList(cid);}else{showErrorDialog('失败',r?r.msg:'');}});});}}
        ];
    } else {
        menu = [
            {label:'📂 打开数据库',action:function(){selectDatabase(cid, db, dbId, 'ar_'+dbId);}},
            {label:'✏️ 编辑数据库',action:function(){showEditDatabase(cid, db);}},
            '---',
            {label:'❌ 删除数据库',action:function(){showConfirmDialog('⚠️ 危险操作','确定删除数据库 ['+db+']？所有数据将丢失！',function(){eel.db_delete(activeConnData,db)(function(r){if(r&&r.ok){showOkDialog('成功',r.msg);refreshDatabaseList(cid);}else{showErrorDialog('失败',r?r.msg:'');}});});}}
        ];
    }
    showCtxMenu(e.clientX, e.clientY, menu);
}

function showEditDatabase(cid, db) {
    var conn = treeData && treeData.connections ? treeData.connections[cid] : activeConnData;
    document.getElementById('modal_icon').innerHTML = '✏️';
    document.getElementById('modal_title').textContent = '编辑数据库：' + db;
    document.getElementById('modal_title').style.color = '#4fc3f7';
    document.getElementById('modal_msg').innerHTML = '<div style="color:#888;padding:20px;">⏳ 加载中...</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">取消</button>';
    document.getElementById('modal_overlay').classList.add('show');

    eel.db_get_info(conn, db)(function(r) {
        if (!r || !r.ok) {
            document.getElementById('modal_msg').innerHTML = '<div style="color:#e74c3c;">❌ ' + (r?r.msg:'加载失败') + '</div>';
            return;
        }
        var html =
            '<table class="design-table"><tbody>' +
                '<tr><td style="width:80px;">数据库名</td><td><input class="design-input" value="' + escapeAttr(db) + '" disabled style="background:#1a2230;"></td></tr>' +
                '<tr><td>字符集</td><td><input class="design-input" id="edit_db_charset" value="' + escapeAttr(r.charset||'') + '" disabled style="background:#1a2230;"></td></tr>' +
                '<tr><td>排序规则</td><td><select class="design-select" id="edit_db_collation"><option value="' + escapeAttr(r.collation||'') + '" selected>' + escapeHtml(r.collation||'') + '</option></select></td></tr>' +
            '</tbody></table>';
        document.getElementById('modal_msg').innerHTML = html;

        // 加载可用排序规则
        eel.db_get_collations(conn, db)(function(r2) {
            if (r2 && r2.ok && r2.collations) {
                var sel = document.getElementById('edit_db_collation');
                if (sel) {
                    sel.innerHTML = r2.collations.map(function(c) {
                        return '<option value="' + escapeAttr(c) + '"' + (c === r.collation ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
                    }).join('');
                }
            }
        });

        document.getElementById('modal_btns').innerHTML =
            '<button class="btn btn-gray" onclick="hideModal()">取消</button>' +
            '<button class="btn btn-blue" onclick="saveEditDatabase(\''+cid+'\',\''+escapeAttr(db)+'\')">💾 保存</button>';
    });
}

function saveEditDatabase(cid, db) {
    // MySQL 不支持直接修改 collation，此处仅展示信息
    showOkDialog('提示', '排序规则修改需执行 ALTER DATABASE 语句，暂未实现');
    hideModal();
}

function showRunSqlFile(cid, db) {
    var conn = treeData && treeData.connections ? treeData.connections[cid] : activeConnData;
    var html =
        '<div style="padding:10px 0;">' +
            '<table class="design-table"><tbody>' +
                '<tr><td style="width:70px;">服务器</td><td>' + escapeHtml((conn.host||'') + ':' + (conn.port||'3306')) + '</td></tr>' +
                '<tr><td>数据库</td><td>' + escapeHtml(db) + '</td></tr>' +
                '<tr><td>文件</td><td><span id="sql_file_label" style="color:#888;">未选择</span> <button class="btn btn-sm" onclick="pickAndShowSqlFile()">📁 选择</button></td></tr>' +
            '</tbody></table>' +
        '</div>';

    document.getElementById('modal_icon').innerHTML = '📂';
    document.getElementById('modal_title').textContent = '运行 SQL 文件';
    document.getElementById('modal_title').style.color = '#27ae60';
    document.getElementById('modal_msg').innerHTML = html;
    document.getElementById('modal_btns').innerHTML =
        '<button class="btn btn-gray" onclick="hideModal()">取消</button>' +
        '<button class="btn btn-green" id="btn_run_sql_file" onclick="startRunSqlFile(\''+cid+'\',\''+escapeAttr(db)+'\')" disabled>▶ 运行</button>';
    document.getElementById('modal_overlay').classList.add('show');
}

function pickAndShowSqlFile() {
    window._sqlFileTarget = 'run';
    var input = document.getElementById('hidden_import_file');
    if (input) { input.accept = '.sql'; input.click(); }
}

function onImportFileSelected(e) {
    var file = e.target.files[0];
    if (!file) { e.target.value = ''; return; }

    var target = window._sqlFileTarget || 'import';
    window._sqlFileTarget = '';

    if (target === 'run') {
        // 运行 SQL 文件
        var label = document.getElementById('sql_file_label');
        if (label) { label.textContent = file.name + ' ⏳ 读取中...'; label.style.color = '#f39c12'; }
        var runBtn = document.getElementById('btn_run_sql_file');
        if (runBtn) runBtn.disabled = true;
        var r = new FileReader();
        r.onload = function(ev) {
            window._sqlFileContent = ev.target.result;
            if (label) { label.textContent = file.name + ' ✅'; label.style.color = '#2ecc71'; }
            if (runBtn) runBtn.disabled = false;
        };
        r.onerror = function() {
            if (label) { label.textContent = '❌ 读取失败'; label.style.color = '#e74c3c'; }
            if (runBtn) runBtn.disabled = false;
        };
        r.readAsText(file);
        e.target.value = '';
        return;
    }

    // 导入向导
    document.getElementById('btn_start_import').disabled = true;
    var label = document.getElementById('import_file_label');
    if (label) { label.textContent = file.name + ' ⏳ 读取中...'; label.style.color = '#f39c12'; }

    var r2 = new FileReader();
    r2.onload = function(ev) {
        window._importFileContent = ev.target.result;
        window._importFileName = file.name;
        document.getElementById('btn_start_import').disabled = false;
        if (label) { label.textContent = file.name + ' ✅'; label.style.color = '#2ecc71'; }
    };
    r2.onerror = function() {
        window._importFileContent = '';
        if (label) { label.textContent = '❌ 读取失败'; label.style.color = '#e74c3c'; }
    };
    r2.readAsText(file);
    e.target.value = '';
}

function startRunSqlFile(cid, db) {
    document.getElementById('btn_run_sql_file').disabled = true;
    if (!window._sqlFileContent) {
        document.getElementById('sql_file_label').textContent = '⚠️ 请先选择文件';
        document.getElementById('sql_file_label').style.color = '#f39c12';
        document.getElementById('btn_run_sql_file').disabled = false;
        return;
    }
    var conn = treeData && treeData.connections ? treeData.connections[cid] : activeConnData;

    document.getElementById('modal_title').textContent = '⏳ 运行中...';
    document.getElementById('modal_msg').innerHTML =
        '<div style="padding:10px 0;">' +
            '<div class="progress-bar" style="height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden;margin-bottom:12px;">' +
                '<div id="sql_run_bar" class="progress-fill" style="width:0%;height:100%;background:#27ae60;border-radius:4px;transition:width .3s;"></div>' +
            '</div>' +
            '<div id="sql_run_status" style="font-size:11px;color:#888;">执行中...</div>' +
            '<div style="margin-top:10px;border:1px solid #333;border-radius:4px;overflow:hidden;">' +
                '<div style="background:#2a2a2a;padding:4px 10px;font-size:11px;color:#aaa;border-bottom:1px solid #333;">📋 运行日志</div>' +
                '<div id="sql_run_log_area" style="height:140px;overflow-y:auto;padding:6px 10px;background:#0d1117;font-family:Consolas,monospace;font-size:11px;line-height:1.6;"></div>' +
            '</div>' +
        '</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';

    var tid = setInterval(function() {
        if (!document.getElementById('modal_overlay').classList.contains('show')) { clearInterval(tid); return; }
        eel.poll_queue()(function(msgs) {
            if (!msgs) return;
            for (var i = 0; i < msgs.length; i++) {
                var m = msgs[i];
                if (m && m[0] === 'sql_run_log') {
                    var logArea = document.getElementById('sql_run_log_area');
                    if (logArea) {
                        var ts = new Date().toTimeString().slice(0, 8);
                        logArea.innerHTML += '<div style="color:#e74c3c;"><span style="color:#666;">[' + ts + ']</span> ' + escapeHtml(m[1]) + '</div>';
                        logArea.scrollTop = logArea.scrollHeight;
                    }
                } else if (m && m[0] === 'sql_run_progress') {
                    var d = m[1];
                    var bar = document.getElementById('sql_run_bar');
                    var pct = d.total ? Math.floor((d.processed / d.total) * 100) : 0;
                    if (bar) bar.style.width = pct + '%';
                    var st = document.getElementById('sql_run_status');
                    if (st) st.textContent = '已执行 ' + (d.processed||0) + ' / ' + (d.total||0) + ' 条语句';
                } else if (m && m[0] === 'sql_run_done') {
                    clearInterval(tid);
                    document.getElementById('modal_title').textContent = '运行 SQL 文件';
                    document.getElementById('sql_run_bar').style.width = '100%';
                    var logArea2 = document.getElementById('sql_run_log_area');
                    if (logArea2) { logArea2.innerHTML += '<div style="color:#2ecc71;">✅ 执行完成，成功执行 ' + (m[1].processed||0) + ' 条语句</div>'; logArea2.scrollTop = logArea2.scrollHeight; }
                    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-green" onclick="hideModal()">完成</button>';
                } else if (m && m[0] === 'sql_run_error') {
                    clearInterval(tid);
                    document.getElementById('modal_title').textContent = '运行 SQL 文件';
                    var logArea3 = document.getElementById('sql_run_log_area');
                    if (logArea3) { logArea3.innerHTML += '<div style="color:#e74c3c;">❌ 执行失败: ' + escapeHtml(m[1].msg) + '</div>'; logArea3.scrollTop = logArea3.scrollHeight; }
                    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';
                }
            }
        });
    }, 300);

    eel.db_run_sql_file(conn, db, '', window._sqlFileContent)();
}

function closeDatabase(cid, db, dbId) {
    // 折叠数据库节点，图标变灰，箭头隐藏
    var el = document.getElementById(dbId);
    if (el) {
        el.classList.remove('open');
        var ar = document.getElementById('ar_' + dbId);
        if (ar) { ar.textContent = '▸'; ar.style.visibility = 'hidden'; }
        var iconEl = el.previousElementSibling ? el.previousElementSibling.querySelector('.db-icon') : null;
        if (iconEl) { iconEl.classList.remove('active'); iconEl.classList.add('closed'); }
    }
    if (activeDatabase === db) {
        _redisPanelCtx = null;
        activeDatabase = '';
        // 移除该连接+数据库下所有相关 tab（data_/ddl_/query_/redis_ 等）
        objectTabs = objectTabs.filter(function(t) {
            if (t.id === 'obj_home') return true;
            return !(t.cid === cid && t.db === db);
        });
        var homeContent2 = '<div style="padding:40px;text-align:center;color:#666;"><div style="font-size:36px;margin-bottom:10px;">📄</div><div>点击表、视图等分类查看对象</div></div>';
        var homeTab2 = objectTabs.find(function(t){return t.id==='obj_home';});
        if (!homeTab2) { objectTabs.push({id:'obj_home',label:'对象',type:'home',content:homeContent2,db:''}); }
        else { homeTab2.content = homeContent2; }
        activeObjTab = 'obj_home';
        activeCatId = null;
        renderObjectPanel();
    }
}

function refreshDatabaseList(cid) {
    // 重新加载连接下的数据库列表
    var children = document.getElementById('mc_c_' + cid);
    if (!children) return;
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) return;
    children.innerHTML = '<div style="padding-left:36px;color:#999;font-size:11px;">⏳ 刷新中...</div>';
    var prevPad = children.previousElementSibling ? parseInt(children.previousElementSibling.style.paddingLeft || '0') : 20;
    var isPg = conn.db_type === 'postgresql';
    eel.db_explore_get_databases(conn)(function(r) {
        if (!r || !r.ok) { children.innerHTML = '<div style="padding-left:36px;color:#e74c3c;font-size:11px;">❌</div>'; return; }
        var html = '';
        r.databases.forEach(function(db2) {
            var dbId2 = cid + '_db_' + safeBtoa(db2);
            var dropAttrs2 = ' ondragover="onDbDragOver(event,this)" ondragleave="onDbDragLeave(event,this)" ondrop="onDbDrop(event,this,\''+cid+'\',\''+escapeAttr(db2)+'\')"';
            var ctxAttr2 = ' oncontextmenu="dbCtx(event,\''+cid+'\',\''+escapeAttr(db2)+'\',\''+dbId2+'\')"';
            if (isPg) {
                html += '<div class="tree-node db-node" data-cid="'+cid+'" data-db="'+escapeAttr(db2)+'"><div class="my-conn-row" style="padding-left:'+(prevPad+20)+'px"'+dropAttrs2+ctxAttr2+' ondblclick="selectDatabase(\''+cid+'\',\''+escapeAttr(db2)+'\',\''+dbId2+'\',\'ar_'+dbId2+'\')">' +
                    '<span class="arrow" id="ar_'+dbId2+'" onclick="event.stopPropagation();toggleDbChildren(\''+dbId2+'\',\'ar_'+dbId2+'\')" style="visibility:hidden">▸</span><span class="my-conn-icon db-icon closed">'+DB_ICON_SVG+'</span><span class="my-conn-name">'+escapeHtml(db2)+'</span></div>' +
                    '<div class="tree-children" id="'+dbId2+'"></div></div>';
            } else {
                html += '<div class="tree-node db-node" data-cid="'+cid+'" data-db="'+escapeAttr(db2)+'"><div class="my-conn-row" style="padding-left:'+(prevPad+20)+'px"'+dropAttrs2+ctxAttr2+' ondblclick="selectDatabase(\''+cid+'\',\''+escapeAttr(db2)+'\',\''+dbId2+'\',\'ar_'+dbId2+'\')">' +
                    '<span class="arrow" id="ar_'+dbId2+'" onclick="event.stopPropagation();toggleDbChildren(\''+dbId2+'\',\'ar_'+dbId2+'\')" style="visibility:hidden">▸</span><span class="my-conn-icon db-icon closed">'+DB_ICON_SVG+'</span><span class="my-conn-name">'+escapeHtml(db2)+'</span></div>' +
                    '<div class="tree-children" id="'+dbId2+'">' + renderDbCats(cid, db2, prevPad+40) + '</div></div>';
            }
        });
        children.innerHTML = html || '<div style="padding-left:'+(prevPad+20)+'px;color:#999;font-size:11px;">（无数据库）</div>';
    });
}

function tableCatCtx(e, cid, db, schema) {
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, [
        {label:'📤 导出向导',action:function(){showExportWizard(cid,db,schema,'');}},
        {label:'📥 导入向导',action:function(){showImportWizard(cid,db,schema);}}
    ]);
}

function qLabelCtx(e, cid, db, schema) {
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, [
        {label:'📝 新建查询',action:function(){addQuery(cid, db, schema);}}
    ]);
}

function expandCat(cat, cid, db, dbKey, pad, schema) {
    var sch = schema || '';
    var rowId = 'cat_'+cat.charAt(0)+'_'+dbKey;
    var el = document.getElementById(rowId);
    if (!el) return;
    // 检查已展开的 children
    var children = el.nextElementSibling;
    if (children && children.classList.contains('tree-children')) {
        if (children.classList.contains('open')) { children.classList.remove('open'); updateCatArrow(rowId,'▸'); return; }
        children.classList.add('open');
        updateCatArrow(rowId,'▾');
        if (!children.innerHTML.trim()) {
            var itemPad = (pad||0) + 20;
            children.innerHTML = '<div style="padding-left:'+itemPad+'px;color:#999;font-size:11px;">⏳</div>';
            var conn = treeData.connections[cid];
            if (!conn) return;
            loadCategoryItems(conn, db, cat, function (items) {
                var catIcon = cat==='tables'?'📊':cat==='views'?'👁':cat==='procedures'?'⚙':cat==='functions'?'𝑓':'📝';
                var h = items.map(function (it) {
                    var n = it.name || it;
                    var qual = sch || db;  // PG 用 schema，其他用 db
                    var ctx = (cat==='tables') ? ' oncontextmenu="tableCtx(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"' : '';
                    var dragAttr = (cat==='tables') ? ' draggable="true" class="my-conn-row drag-table-item" ondragstart="onTableDragStart(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')" ondragend="onTableDragEnd(event)"' : ' class="my-conn-row"';
                    return '<div'+dragAttr+' style="padding-left:'+itemPad+'px;font-size:11px;line-height:22px;'+(cat!=='tables'?'padding-top:5px;padding-bottom:5px;':'')+'" ondblclick="addTableDataTab(\''+escapeAttr(n)+'\',\''+escapeAttr(qual)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"'+ctx+'><span class="my-conn-icon">'+catIcon+'</span>'+escapeHtml(n)+'</div>';
                }).join('');
                children.innerHTML = h || '<div style="padding-left:'+itemPad+'px;color:#999;font-size:11px;">（无数据）</div>';
            }, sch);
        }
    }
}

// 通用刷新：刷新指定分类（表/视图/存储过程/函数/查询）
function refreshCatItem(cat, cid, db, schema, dbKey, pad) {
    var rowId = 'cat_'+cat.charAt(0)+'_'+dbKey;
    var el = document.getElementById(rowId);
    if (!el) return;
    var children = el.nextElementSibling;
    if (!children || !children.classList.contains('tree-children')) return;
    // 未展开则强制展开
    if (!children.classList.contains('open')) {
        children.classList.add('open');
        updateCatArrow(rowId, '▾');
    }
    children.innerHTML = '<div style="padding-left:'+((pad||0)+20)+'px;color:#999;font-size:11px;">🔄 刷新中...</div>';
    var conn = treeData.connections[cid];
    if (!conn) return;
    var sch = schema || '';
    loadCategoryItems(conn, db, cat, function(items) {
        var itemPad = (pad||0) + 20;
        var catIcon = cat==='tables'?'📊':cat==='views'?'👁':cat==='procedures'?'⚙':cat==='functions'?'𝑓':'📝';
        var h = items.map(function(it) {
            var n = it.name || it;
            var qual = sch || db;
            var ctx = (cat==='tables') ? ' oncontextmenu="tableCtx(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"' : '';
            var dragAttr = (cat==='tables') ? ' draggable="true" class="my-conn-row drag-table-item" ondragstart="onTableDragStart(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')" ondragend="onTableDragEnd(event)"' : ' class="my-conn-row"';
            return '<div'+dragAttr+' style="padding-left:'+itemPad+'px;font-size:11px;line-height:22px;'+(cat!=='tables'?'padding-top:5px;padding-bottom:5px;':'')+'" ondblclick="addTableDataTab(\''+escapeAttr(n)+'\',\''+escapeAttr(qual)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"'+ctx+'><span class="my-conn-icon">'+catIcon+'</span>'+escapeHtml(n)+'</div>';
        }).join('');
        children.innerHTML = h || '<div style="padding-left:'+itemPad+'px;color:#999;font-size:11px;">（无数据）</div>';
        // 同步刷新右侧对象面板（仅表分类）
        if (cat === 'tables') {
            var home = objectTabs.find(function(t){return t.id==='obj_home';});
            if (home && activeCatId === rowId) { clickTableCat(cid, db, sch); }
        }
    }, sch);
}

// 刷新表列表（从服务器重新加载）— 委托到 refreshCatItem
function refreshTableCat(cid, db, schema, dbKey, pad) {
    refreshCatItem('tables', cid, db, schema, dbKey, pad);
}

function updateCatArrow(rowId, icon) {
    var ar = document.getElementById('ar_'+rowId);
    if (ar) ar.textContent = icon;
}

// 根据 cid/db/schema 定位表文件夹并刷新（用于删除/同步后自动刷新）
function refreshTableFolder(cid, db, schema) {
    var key = (schema||'') ? db + '/' + (schema||'') : db;
    var dbKey = safeBtoa(key);
    var rowId = 'cat_t_' + dbKey;
    var el = document.getElementById(rowId);
    if (!el) {
        // 回退：不用 schema 再试
        dbKey = safeBtoa(db);
        rowId = 'cat_t_' + dbKey;
        el = document.getElementById(rowId);
    }
    if (!el) return;
    // 确保文件夹已展开
    var children = el.nextElementSibling;
    if (children && children.classList.contains('tree-children')) {
        children.classList.add('open');
        updateCatArrow(rowId, '▾');
    }
    var pad = parseInt(el.style.paddingLeft) || 0;
    refreshTableCat(cid, db, schema||'', dbKey, pad);
}

function expandQueries(cid, dbKey, pad, db, schema) {
    var rowId = 'cat_q_'+dbKey;
    var el = document.getElementById(rowId);
    if (!el) return;
    var children = el.nextElementSibling;
    if (children && children.classList.contains('tree-children')) {
        if (children.classList.contains('open')) { children.classList.remove('open'); updateCatArrow(rowId,'▸'); return; }
        children.classList.add('open');
        updateCatArrow(rowId,'▾');
        if (!children.innerHTML.trim()) {
            var fullDik = schema ? db+'/'+schema : db;
            var itemPad = (pad||0) + 20;
            var queries = (treeData.saved_queries || []).filter(function (q) { return q.conn_id === cid && q.db === db; });
            children.innerHTML = queries.map(function (q) {
                return '<div class="my-conn-row" style="padding-left:'+itemPad+'px;font-size:11px;" ondblclick="openQueryInTab(\''+q.id+'\')" oncontextmenu="queryCtx2(event,\''+q.id+'\',\''+cid+'\',\''+escapeAttr(schema||'')+'\')"><span class="my-conn-icon">📄</span><span class="my-conn-name">'+escapeHtml(q.name)+'</span></div>';
            }).join('') || '<div style="padding-left:'+itemPad+'px;color:#999;font-size:11px;">（无查询）</div>';
        }
    }
}

// 局部刷新查询目录（不改动整个连接树）
function refreshQueriesTree(cid, db, schema) {
    var fullDb = schema ? db+'/'+schema : db;
    if (!cid || !fullDb) return;
    var dbKey = safeBtoa(fullDb);
    var rowId = 'cat_q_' + dbKey;
    var el = document.getElementById(rowId);
    if (!el) return;
    var children = el.nextElementSibling;
    if (!children || !children.classList.contains('tree-children')) return;
    children.innerHTML = '';
    if (children.classList.contains('open')) {
        var pad = parseInt(children.getAttribute('data-pad')) || 40;
        var itemPad = pad + 20;
        var queries = (treeData.saved_queries || []).filter(function (q) { return q.conn_id === cid && q.db === db; });
        children.innerHTML = queries.map(function (q) {
            return '<div class="my-conn-row" style="padding-left:'+itemPad+'px;font-size:11px;" ondblclick="openQueryInTab(\''+q.id+'\')" oncontextmenu="queryCtx2(event,\''+q.id+'\',\''+cid+'\',\''+escapeAttr(schema||'')+'\')"><span class="my-conn-icon">📄</span><span class="my-conn-name">'+escapeHtml(q.name)+'</span></div>';
        }).join('') || '<div style="padding-left:'+itemPad+'px;color:#999;font-size:11px;">（无查询）</div>';
    }
    var homeTab = objectTabs.find(function(t){return t.id==='obj_home';});
    if (homeTab && activeCatId === rowId) {
        clickQueries(cid, db, schema);
    }
}

// ==================== 分类点击 =右侧面板 ====================
function clickTableCat(cid, db, schema) { clickCat(cid, db, 'tables', schema||''); }
function clickCat(cid, db, cat, schema) {
    _redisPanelCtx = null; // 切换到非 Redis 面板
    var conn = treeData.connections[cid];
    if (!conn) return;
    activeConnId = cid; activeConnData = conn; activeDatabase = db;
    var sch = schema || '';
    loadCategoryItems(conn, db, cat, function (items) {
        var content = buildObjHomeContent(items, cat, db, sch, cid);
        var home = objectTabs.find(function(t){return t.id==='obj_home';});
        if (home) home.content = content;
        else objectTabs.unshift({id:'obj_home',label:'对象',type:'home',content:content});
        activeObjTab = 'obj_home';
        renderObjectPanel();
    }, sch);
}

function clickQueries(cid, db, schema) {
    _redisPanelCtx = null;
    var sch = schema || '';
    var fullDb = sch ? db+'/'+sch : db;
    var queries = (treeData.saved_queries || []).filter(function(q){return q.conn_id===cid && q.db===db;});
    activeConnId = cid; activeConnData = treeData.connections[cid]; activeDatabase = db;
    var content = '<table class="exp-table"><thead><tr><th>名称</th></tr></thead><tbody>';
    queries.forEach(function(q){content += '<tr ondblclick="openQueryInTab(\''+q.id+'\')" oncontextmenu="queryCtx2(event,\''+q.id+'\',\''+cid+'\',\''+escapeAttr(sch)+'\')"><td>'+escapeHtml(q.name)+'</td></tr>';});
    content += '</tbody></table>';
    if (!queries.length) content += '<div style="padding:20px;color:#999;">（无查询）</div>';
    var home = objectTabs.find(function(t){return t.id==='obj_home';});
    if (home) home.content = content;
    else objectTabs.unshift({id:'obj_home',label:'对象',type:'home',content:content});
    activeObjTab = 'obj_home';
    renderObjectPanel();
}

function queryCtx2(e, qid, cid, schema) {
    e.preventDefault(); e.stopPropagation();
    var sch = schema || '';
    showCtxMenu(e.clientX, e.clientY, [
        {label:'📄 打开查询',action:function(){openQueryInTab(qid);}},
        {label:'📝 新建查询',action:function(){addQuery(cid, activeDatabase||'', sch);}},
        '---',
        {label:'🗑 删除查询',action:function(){showConfirmDialog('确认删除','确定删除此查询？',function(){eel.tree_delete_query(qid)(function(){var qb=(treeData.saved_queries||[]).find(function(x){return x.id===qid;});if(qb){treeData.saved_queries=(treeData.saved_queries||[]).filter(function(x){return x.id!==qid;});refreshQueriesTree(qb.conn_id,qb.db,sch);}});});}}
    ]);
}

// ==================== 对象面板 ====================
function buildObjHomeContent(items, cat, db, schema, cid) {
    var sch = schema || '';
    var h = '';
    if (cat === 'tables') {
        h += '<table class="exp-table"><thead><tr><th style="width:28%">名称</th><th style="width:10%;text-align:right;">行</th><th style="width:12%;text-align:right;">数据长度</th><th style="width:22%">修改日期</th><th style="width:28%">注释</th></tr></thead><tbody>';
        items.forEach(function(t){h+='<tr draggable="true" class="drag-table-item" ondragstart="onTableDragStart(event,\''+escapeAttr(t.name)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+(cid||'')+'\')" ondragend="onTableDragEnd(event)" ondblclick="addTableDataTab(\''+escapeAttr(t.name)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+(cid||'')+'\')" oncontextmenu="tableCtx(event,\''+escapeAttr(t.name)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+(cid||'')+'\')"><td>'+escapeHtml(t.name)+'</td><td style="text-align:right;">'+escapeHtml(String(t.rows||''))+'</td><td style="text-align:right;">'+escapeHtml(t.data_size||'')+'</td><td>'+escapeHtml(t.update_time||'')+'</td><td>'+escapeHtml(t.comment||'')+'</td></tr>';});
        h += '</tbody></table>';
    } else if (cat === 'views') {
        h += '<table class="exp-table"><thead><tr><th style="width:60%">名称</th><th style="width:40%">数据库</th></tr></thead><tbody>';
        items.forEach(function(v){h+='<tr><td>'+escapeHtml(v.name)+'</td><td>'+escapeHtml(db)+'</td></tr>';});
        h += '</tbody></table>';
    } else {
        h += '<table class="exp-table"><thead><tr><th style="width:50%">名称</th><th style="width:30%">类型</th><th style="width:20%">数据库</th></tr></thead><tbody>';
        items.forEach(function(p){h+='<tr><td>'+escapeHtml(p.name)+'</td><td>'+escapeHtml(p.type||cat)+'</td><td>'+escapeHtml(db)+'</td></tr>';});
        h += '</tbody></table>';
    }
    if (!items.length) h += '<div style="padding:20px;color:#999;">（无数据）</div>';
    else {
        var catLabel = cat==='tables'?'张表':cat==='views'?'个视图':cat==='procedures'?'个存储过程':cat==='functions'?'个函数':'项';
        h += '<div style="text-align:right;padding:4px 10px;color:#666;font-size:11px;">共 '+items.length+' '+catLabel+'</div>';
    }
    return h;
}

// 对象面板接受拖拽 drop（拖表到对象窗口 = 同步到当前显示的数据库）
function setupObjectPanelDrop() {
    var panel = document.getElementById('object_panel');
    if (!panel || panel._dropReady) return;
    panel._dropReady = true;
    panel.addEventListener('dragover', function(e) {
        if (!_dragInfo || !activeConnId || !activeDatabase) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        // 拖拽源来自对象面板内部时不显示高亮
        if (!panel.contains(e.target) || _dragInfo.src_cid !== activeConnId) {
            panel.classList.add('drop-target');
        }
    });
    panel.addEventListener('dragleave', function(e) {
        // 对象面板内部元素较多，直接用 relatedTarget 判断是否真正离开面板
        if (!panel.contains(e.relatedTarget)) {
            panel.classList.remove('drop-target');
        }
    });
    panel.addEventListener('drop', function(e) {
        e.preventDefault();
        panel.classList.remove('drop-target');
        if (!_dragInfo || !activeConnId || !activeDatabase) return;
        var src = _dragInfo;
        var srcConn = treeData && treeData.connections ? treeData.connections[src.src_cid] : null;
        var dstConn = treeData && treeData.connections ? treeData.connections[activeConnId] : null;
        if (!srcConn || !dstConn) return;
        showDragCopyDialog(src.table_name, src.src_db, src.schema, srcConn, activeConnId, activeDatabase, dstConn);
        _dragInfo = null;
    });
}

function renderObjectPanel() {
    var panel = document.getElementById('object_panel');
    // ★ 在销毁 DOM 之前，保存当前活跃 tab 中所有 textarea 的内容到 objectTabs
    if (panel) {
        var textareas = panel.querySelectorAll('textarea');
        for (var ti = 0; ti < textareas.length; ti++) {
            var ta = textareas[ti];
            if (!ta.id) continue;
            for (var j = 0; j < objectTabs.length; j++) {
                var t = objectTabs[j];
                if (t.content.indexOf('id="' + ta.id + '"') !== -1) {
                    t.content = t.content.replace(
                        new RegExp('(<textarea[^>]*id="' + ta.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>)([\\s\\S]*?)(</textarea>)', 'i'),
                        '$1' + escapeHtml(ta.value) + '$3'
                    );
                    break;
                }
            }
        }
    }

    // 增量更新 tab 栏和内容区域，避免全量 innerHTML 重建
    var tabBar = document.getElementById('obj_tabs_bar');
    var h = '';
    objectTabs.forEach(function(t){
        var cls = t.id===activeObjTab?'obj-tab active':'obj-tab';
        var icon = t.type==='ddl'?'🔧 ':t.type==='data'?'📊 ':t.type==='query'?'📝 ':'📋 ';
        h += '<span class="'+cls+'" data-tabid="'+t.id+'" onclick="switchObjTab(\''+t.id+'\')">'+icon+escapeHtml(t.label);
        if(t.id!=='obj_home') h += '<span class="tab-close" onclick="event.stopPropagation();closeTab(\''+t.id+'\')">✕</span>';
        h += '</span>';
    });
    if (activeObjTab === 'obj_home') h += '<div class="obj-search-wrap"><input class="obj-search-input" id="obj_search" placeholder="🔍 搜索表名..." oninput="filterObjectTable()"></div>';

    if (tabBar) {
        // 增量更新 tab 栏（避免 innerHTML 销毁重建事件）
        tabBar.innerHTML = h;
    } else {
        // 首次渲染：创建完整结构
        var at = objectTabs.find(function(t){return t.id===activeObjTab;});
        panel.innerHTML = '<div class="obj-tabs" id="obj_tabs_bar">' + h + '</div><div class="obj-content" id="obj_content">' + (at ? at.content : '') + '</div>';
        setTimeout(function() {
            collapseOverflowTabs();
            highlightTableRow();
            setupObjectPanelDrop();
        }, 50);
        return;
    }

    // 增量更新内容区域
    var contentDiv = document.getElementById('obj_content');
    var at2 = objectTabs.find(function(t){return t.id===activeObjTab;});
    if (contentDiv && at2) {
        contentDiv.innerHTML = at2.content;
        // ★ 修复 Bug2：data/redis 类型 tab 切换后，重新调用 render 填充 tbody
        if (at2.type === 'data' || at2.type === 'redis') {
            var tid2 = _tabIdToTid[activeObjTab];
            if (tid2) {
                var st2 = _whereStates[tid2];
                if (st2 && st2.onRender) {
                    setTimeout(function(){ st2.onRender(); }, 0);
                }
                // ★ 重新绑定排序事件（DOM 重建后旧监听器已丢失）
                var bindSortFn = window['_bindSort_'+tid2];
                if (bindSortFn) {
                    setTimeout(function(){ bindSortFn(); }, 50);
                }
            }
        }
    }

    // 延迟执行次要任务：恢复 splitter 绑定、溢出 tab 处理等
    requestAnimationFrame(function() {
        collapseOverflowTabs();
        highlightTableRow();
        setupObjectPanelDrop();
        // 为所有 query layout 重新绑定分隔线拖动
        var layouts = contentDiv ? contentDiv.querySelectorAll('.query-layout') : [];
        for (var li = 0; li < layouts.length; li++) {
            var layoutEl = layouts[li];
            if (!layoutEl.id || layoutEl.id.indexOf('ql_') !== 0) continue;
            var qid2 = layoutEl.id.substring(3);
            // ★ 先清除标记，因为 innerHTML 已重建 DOM，旧事件监听器已失效
            delete _querySplitterInited['qs_' + qid2];
            initQuerySplitter('ql_' + qid2, 'qs_' + qid2, 'sq_' + qid2, 'qr_' + qid2);
        }
    });
}

function filterObjectTable() {
    var kw = (document.getElementById('obj_search')||{}).value||'';

    // ★ Redis 面板：服务端搜索，遍历所有 key
    if (_redisPanelCtx && activeObjTab === 'obj_home') {
        clearTimeout(_redisSearchTimer);
        _redisSearchTimer = setTimeout(function() {
            _redisDoServerSearch(_redisPanelCtx.cid, _redisPanelCtx.dbIdx, _redisPanelCtx.dbId, kw);
        }, 300);
        return;
    }

    var content = document.getElementById('obj_content');
    if (!content) return;
    var rows = content.querySelectorAll('.exp-table tbody tr');
    var cnt = 0;
    rows.forEach(function(tr){
        // 找到第一个 td（通常是名称列）
        var td = tr.querySelector('td');
        if (!td) return;
        var text = (td.textContent || '').toLowerCase();
        var match = !kw || text.indexOf(kw.toLowerCase()) !== -1;
        tr.style.display = match ? '' : 'none';
        if (match) cnt++;
    });
    // 更新计数
    var infoEl = content.querySelector('.obj-search-info');
    if (!kw) {
        if (infoEl) infoEl.textContent = '';
    } else {
        if (!infoEl) {
            infoEl = document.createElement('div');
            infoEl.className = 'obj-search-info';
            infoEl.style.cssText = 'padding:2px 10px;color:#888;font-size:11px;text-align:right;';
            var tbl = content.querySelector('.exp-table');
            if (tbl && tbl.parentElement) tbl.parentElement.insertBefore(infoEl, tbl);
        }
        infoEl.textContent = '搜索：' + cnt + ' 个匹配';
    }
}

var _redisSearchTimer = null;
// 服务端搜索：用 SCAN + match pattern 遍历全部 key
function _redisDoServerSearch(cid, dbIdx, dbId, kw) {
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) return;

    var pattern = kw ? '*' + kw + '*' : '*';
    // 搜索时限制放宽到 500 条，用 SCAN 遍历全部
    eel.redis_get_keys(conn, pattern, 500, dbIdx)(function(r) {
        if (!r || !r.ok) return;
        var keys = [];
        (r.groups || []).forEach(function(g) { keys = keys.concat(g.keys); });
        var total = r.total;

        var displayKeys = keys.slice(0, 500);
        var content = '<div style="padding:2px 10px;color:#888;font-size:11px;">搜索 "' + escapeHtml(kw) + '"：共 ' + total + ' 个 key'
            + (keys.length > 500 ? '（显示前 500 个）' : '') + '</div>';
        content += '<table class="exp-table"><thead><tr><th style="width:60%">Key</th><th style="width:40%;text-align:right;">类型</th></tr></thead><tbody>';
        displayKeys.forEach(function(k) {
            content += '<tr class="redis-key-row" style="" ondblclick="redisShowKey(\'' + cid + '\',\'' + escapeAttr(k) + '\',' + dbIdx + ')">'
                + '<td>' + escapeHtml(k) + '</td>'
                + '<td style="text-align:right;color:#888;font-size:10px;">🔑</td>'
                + '</tr>';
        });
        content += '</tbody></table>';

        var home = objectTabs.find(function(t) { return t.id === 'obj_home'; });
        if (home) home.content = content;
        else objectTabs.unshift({ id: 'obj_home', label: '对象', type: 'home', content: content });
        renderObjectPanel();
    });
}

function closeTab(tabId) {
    // 清理该 tab 对应的 splitter 绑定标记
    var qidMatch = tabId.match(/^query_(.+)$/);
    if (qidMatch) delete _querySplitterInited['qs_' + qidMatch[1]];
    // ★ 清理 data tab 的 _tabIdToTid 和 _whereStates
    var tid2 = _tabIdToTid[tabId];
    if (tid2) { delete _whereStates[tid2]; delete _tabIdToTid[tabId]; }
    // ★ 清理 redis tab 的编辑状态
    for (var i = 0; i < objectTabs.length; i++) {
        if (objectTabs[i].id === tabId && objectTabs[i].type === 'redis' && objectTabs[i].tid) {
            delete _redisEditState[objectTabs[i].tid];
            break;
        }
    }
    objectTabs = objectTabs.filter(function(t){return t.id!==tabId;});
    activeObjTab = objectTabs.length ? objectTabs[objectTabs.length-1].id : 'obj_home';
    renderObjectPanel();
}

function switchObjTab(tabId) { activeObjTab = tabId; renderObjectPanel(); }

// ==================== Tab 溢出折叠 ====================
function collapseOverflowTabs() {
    var bar = document.getElementById('obj_tabs_bar');
    if (!bar) return;

    // 移除旧的更多按钮和下拉
    var oldMore = bar.querySelector('.obj-tabs-more-btn');
    if (oldMore) oldMore.remove();

    // 恢复所有 tab 显示
    var allTabs = Array.from(bar.querySelectorAll('.obj-tab'));
    allTabs.forEach(function(t) { t.style.display = ''; });

    if (allTabs.length <= 1) return;

    var maxW = bar.clientWidth;
    // 搜索框宽度
    var searchWrap = bar.querySelector('.obj-search-wrap');
    var reserved = (searchWrap ? searchWrap.offsetWidth + 8 : 0) + 52; // 搜索框 + "⋯" 按钮 + 内边距
    if (reserved > maxW * 0.4) reserved = Math.floor(maxW * 0.4); // 防止搜索框占太多

    // 找到 home tab 和 active tab
    var homeTab = bar.querySelector('[data-tabid="obj_home"]');
    var activeTab = bar.querySelector('.obj-tab.active');

    // 从右往左填充可见 tab，home 和 active 强制可见
    var available = maxW - reserved;
    var visibleTabs = [];
    var hideTabs = [];

    for (var i = allTabs.length - 1; i >= 0; i--) {
        var t = allTabs[i];
        var w = t.offsetWidth;
        if (t === homeTab || t === activeTab) {
            visibleTabs.unshift(t);
            available -= w; // 必显的 tab 直接从可用空间扣除
            continue;
        }
        if (available >= w) {
            visibleTabs.unshift(t);
            available -= w;
        } else {
            hideTabs.push(t);
        }
    }

    if (hideTabs.length === 0) return;

    // 隐藏溢出的 tab
    hideTabs.forEach(function(t) { t.style.display = 'none'; });

    // 收集隐藏 tab 的 id
    window._hiddenTabIds = hideTabs.map(function(t) { return t.getAttribute('data-tabid'); });

    // 在 home tab 后面插入 "⋯" 按钮
    var moreBtn = document.createElement('span');
    moreBtn.className = 'obj-tab obj-tabs-more-btn';
    moreBtn.setAttribute('data-tabid', '__more__');
    moreBtn.textContent = '⋯';
    moreBtn.title = '展开隐藏的标签页';
    moreBtn.onclick = function(e) { e.stopPropagation(); showCollapsedTabs(e); };
    if (homeTab && homeTab.nextSibling) {
        bar.insertBefore(moreBtn, homeTab.nextSibling);
    } else {
        bar.appendChild(moreBtn);
    }
}

function showCollapsedTabs(e) {
    var hidden = window._hiddenTabIds || [];
    if (!hidden.length) return;

    // 关闭已存在的下拉
    var old = document.getElementById('tabs_collapse_dropdown');
    if (old) { old.remove(); return; }

    var dd = document.createElement('div');
    dd.id = 'tabs_collapse_dropdown';
    dd.style.cssText = 'position:fixed;background:#2a2a2a;border:1px solid #555;border-radius:6px;padding:6px 0;z-index:99999;min-width:200px;max-height:360px;overflow-y:auto;box-shadow:0 6px 24px rgba(0,0,0,.5);';

    var rect = e.target.getBoundingClientRect();
    dd.style.top = (rect.bottom + 4) + 'px';
    dd.style.left = rect.left + 'px';

    hidden.forEach(function(tabId) {
        var tab = objectTabs.find(function(t) { return t.id === tabId; });
        if (!tab) return;
        var icon = tab.type === 'ddl' ? '🔧 ' : tab.type === 'data' ? '📊 ' : tab.type === 'query' ? '📝 ' : '📋 ';
        var item = document.createElement('div');
        item.style.cssText = 'padding:7px 16px;font-size:12px;color:#ccc;white-space:nowrap;display:flex;align-items:center;';
        item.innerHTML = '<span style="flex:1;">' + icon + escapeHtml(tab.label) + '</span>' +
            '<span style="font-size:10px;color:#888;margin-left:12px;" onclick="event.stopPropagation();closeTab(\'' + tabId + '\');var d=document.getElementById(\'tabs_collapse_dropdown\');if(d)d.remove();">✕</span>';
        item.onmouseover = function() { this.style.background = '#3a3a3a'; };
        item.onmouseout = function() { this.style.background = ''; };
        item.onclick = function() {
            switchObjTab(tabId);
            dd.remove();
        };
        dd.appendChild(item);
    });

    document.body.appendChild(dd);

    // 点击外部关闭
    setTimeout(function() {
        function outsideClick(ev) {
            if (!dd.contains(ev.target) && ev.target !== e.target) {
                dd.remove();
                document.removeEventListener('click', outsideClick);
            }
        }
        document.addEventListener('click', outsideClick);
    }, 10);
}

// 监听面板尺寸变化，重新计算溢出
var _collapseOverflowTimer = 0;
(function initTabCollapseObserver() {
    setTimeout(function() {
        var panel = document.getElementById('object_panel');
        if (!panel) return;
        function debouncedCollapse() {
            if (_collapseOverflowTimer) return;
            _collapseOverflowTimer = setTimeout(function() {
                _collapseOverflowTimer = 0;
                collapseOverflowTabs();
            }, 50);
        }
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(debouncedCollapse).observe(panel);
        } else {
            window.addEventListener('resize', debouncedCollapse);
        }
    }, 200);
})();

function highlightTableRow() {
    if (!activeObjTab || activeObjTab==='obj_home') return;
    var tn = activeObjTab.replace(/^(data_|ddl_|query_)/,'');
    document.querySelectorAll('#obj_content .exp-table tbody tr').forEach(function(r){
        var td = r.querySelector('td');
        if (td && td.textContent.trim()===tn) { r.style.background='#3a5a8a'; r.scrollIntoView({block:'center'}); }
    });
}

function addOrUpdateTab(id, label, type, content, db, cid) {
    var ex = objectTabs.find(function(t){return t.id===id;});
    if (ex) { ex.content = content; if(db!==undefined)ex.db=db; if(cid!==undefined)ex.cid=cid; }
    else objectTabs.push({id:id,label:label,type:type,content:content,db:db||'',cid:cid||activeConnId||''});
    activeObjTab = id;
    renderObjectPanel();
}

// ==================== 表操作 ====================
function tableCtx(e, tn, db, schema, cid) {
    e.preventDefault(); e.stopPropagation();
    var sch = schema || '';
    var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
    showCtxMenu(e.clientX, e.clientY, [
        {label:'📄 打开表',action:function(){addTableDataTab(tn,db,sch,cid);}},
        {label:'🔧 设计表',action:function(){addTableDDLTab(tn,db,sch,cid);}},
        '---',
        {label:'📤 导出向导',action:function(){showExportWizard(cid,db,sch,tn);}},
        '---',
        {label:'🗑 清空表',action:function(){showConfirmDialog('确认','清空表 ['+tn+']？',function(){eel.table_clear(conn,db,tn,sch)(function(r){showOkDialog(r&&r.ok?'成功':'失败',r?r.msg:'');});});}},
        {label:'✂️ 截断表',action:function(){showConfirmDialog('确认','截断表 ['+tn+']？',function(){eel.table_truncate(conn,db,tn,sch)(function(r){showOkDialog(r&&r.ok?'成功':'失败',r?r.msg:'');});});}},
        '---',
        {label:'❌ 删除表',action:function(){showConfirmDialog('危险','删除表 ['+tn+']？不可恢复！',function(){eel.table_delete(conn,db,tn,sch)(function(r){if(r&&r.ok){showOkDialog('成功',r.msg);setTimeout(function(){refreshTableFolder(cid,db,sch);},500);}else showErrorDialog('失败',r?r.msg:'');});});}}
    ]);
}

// ==================== WHERE 条件评估器 ====================
function compileWhereFn(whereExpr, cols) {
    var expr = whereExpr.trim();
    if (!expr) return function() { return true; };
    var colMap = {};
    cols.forEach(function(c, i) { colMap[c.toLowerCase()] = i; });

    // 按 AND 拆分
    var parts = String(expr).split(/\s+AND\s+/i);

    return function(row) {
        for (var p = 0; p < parts.length; p++) {
            var cond = parts[p].trim();
            if (!cond) continue;
            if (!_evalCond(cond, row, colMap)) return false;
        }
        return true;
    };
}

function _evalCond(cond, row, colMap) {
    // IS NULL / IS NOT NULL
    var nm = cond.match(/^(.+?)\s+IS\s+(NOT\s+)?NULL$/i);
    if (nm) {
        var ci = colMap[nm[1].trim().toLowerCase()];
        if (ci === undefined) return true;
        return nm[2] ? row[ci] !== null : row[ci] === null;
    }
    // LIKE / NOT LIKE
    var lm = cond.match(/^(.+?)\s+(NOT\s+)?LIKE\s+(.+)$/i);
    if (lm) {
        var ci = colMap[lm[1].trim().toLowerCase()];
        if (ci === undefined) return true;
        var val = row[ci]; val = val === null || val === undefined ? '' : String(val);
        var pat = _unquote(lm[3].trim());
        pat = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
        var re = new RegExp('^' + pat + '$', 'i');
        return lm[2] ? !re.test(val) : re.test(val);
    }
    // = != <> >= <= > <
    var om = cond.match(/^(.+?)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)$/);
    if (om) {
        var ci = colMap[om[1].trim().toLowerCase()];
        if (ci === undefined) return true;
        var op = om[2];
        var lv = row[ci];
        var rv = _unquote(om[3].trim());
        if (/^['"]/.test(om[3].trim())) {
            // 字符串比较
            lv = lv === null || lv === undefined ? '' : String(lv);
            switch (op) { case '=': return lv === rv; case '!=': case '<>': return lv !== rv; default: return true; }
        } else if (rv.toLowerCase() === 'null') {
            switch (op) { case '=': return lv === null; case '!=': case '<>': return lv !== null; default: return true; }
        } else {
            rv = Number(rv); if (isNaN(rv)) return true;
            lv = lv === null || lv === undefined ? 0 : Number(lv); if (isNaN(lv)) lv = 0;
            switch (op) { case '=': return lv === rv; case '!=': case '<>': return lv !== rv; case '>': return lv > rv; case '<': return lv < rv; case '>=': return lv >= rv; case '<=': return lv <= rv; default: return true; }
        }
    }
    return true; // 无法解析，不筛选
}

function _unquote(s) { s = s.trim(); if ((s[0]==="'"&&s[s.length-1]==="'")||(s[0]==='"'&&s[s.length-1]==='"')) return s.slice(1,-1); return s; }

// 生成 WHERE 栏 HTML
function buildWhereBar(tid) {
    return '<div class="where-bar">' +
        '<span class="where-label">WHERE</span>' +
        '<input class="where-input" id="' + tid + '_where" placeholder="例: age > 18 AND name LIKE \'%张%\'" onkeydown="if(event.key===\'Enter\')applyWhere(\'' + tid + '\')">' +
        '<button class="btn btn-sm" style="font-size:10px;padding:3px 10px;background:#2a2a2a;" onclick="applyWhere(\'' + tid + '\')">执行</button>' +
        '<button class="btn btn-sm" style="font-size:10px;padding:3px 8px;background:#2a2a2a;" onclick="clearWhere(\'' + tid + '\')">✕ 清除</button>' +
        '<span class="where-count" id="' + tid + '_count"></span>' +
        '</div>';
}

// 全局 WHERE 状态存储（tid -> {cols, rows, sortCol, sortDir, onRender}）
var _whereStates = {};
// tabId -> tid 映射（用于 renderObjectPanel 中 data tab 切换后重新渲染）
var _tabIdToTid = {};

function registerWhereState(tid, cols, rows, sortRef, onRender) {
    _whereStates[tid] = { cols: cols, rows: rows, sortRef: sortRef, onRender: onRender };
}
function getWhereState(tid) { return _whereStates[tid]; }

function applyWhere(tid) {
    var st = _whereStates[tid]; if (!st) return;
    var inp = document.getElementById(tid + '_where');
    var whereExpr = inp ? inp.value : '';
    st.whereExpr = whereExpr;
    // 清除列筛选缓存，让 getPageRows 走 WHERE 路径
    var clearColFn = window['_clearColFilters_'+tid];
    if (clearColFn) clearColFn();
    // 重置分页
    var resetPageFn = window['_resetPage_'+tid];
    if (resetPageFn) resetPageFn();
    st.onRender();
}

function clearWhere(tid) {
    var inp = document.getElementById(tid + '_where');
    if (inp) inp.value = '';
    var st = _whereStates[tid]; if (!st) return;
    st.whereExpr = '';
    // 清除列筛选缓存
    var clearColFn = window['_clearColFilters_'+tid];
    if (clearColFn) clearColFn();
    var resetPageFn = window['_resetPage_'+tid];
    if (resetPageFn) resetPageFn();
    st.onRender();
}

function getFilteredRows(tid) {
    var st = _whereStates[tid]; if (!st) return { filtered: [], indices: [], count: 0 };
    try {
        var fn = compileWhereFn(st.whereExpr || '', st.cols);
        // 收集过滤后的行和它们在原始 rows 中的索引（不再做排序，排序由 clientSort 独立处理）
        var pairs = [];
        st.rows.forEach(function(row, i) {
            if (fn(row)) pairs.push({row: row, idx: i});
        });
        var filtered = pairs.map(function(p) { return p.row; });
        var indices = pairs.map(function(p) { return p.idx; });
        return { filtered: filtered, indices: indices, count: filtered.length };
    } catch (e) {
        var allIndices = st.rows.map(function(_,i){return i;});
        return { filtered: st.rows, indices: allIndices, count: st.rows.length };
    }
}

function updateWhereCount(tid, filteredCount, totalCount) {
    var el = document.getElementById(tid + '_count');
    if (!el) return;
    var st = _whereStates[tid];
    if (st && st.whereExpr) {
        el.textContent = '筛选后：' + filteredCount + ' / ' + totalCount + ' 行';
        el.style.color = '#f39c12';
    } else {
        el.textContent = '共 ' + totalCount + ' 行';
        el.style.color = '#888';
    }
}

function addTableDataTab(tn, db, schema, cid) {
    var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
    var sch = schema || '';
    // ★ 始终只加载 50 行，排序/筛选时再去后端按需查询
    addOrUpdateTab('data_'+tn, tn, 'data', '<div style="padding:20px;color:#999;">⏳ 正在加载数据...</div>');
    
    eel.table_preview_data_fast(conn, db||activeDatabase, tn, sch, '', '')(function(r){
        if(!r||!r.ok){addOrUpdateTab('data_'+tn,tn,'data','<div style="padding:20px;color:#e74c3c;">❌ '+(r?r.msg:'')+'</div>');return;}
        _buildTableDataUI(tn, conn, sch, r, db||activeDatabase);
    });
}

/** 构建/更新表格数据 UI（每次打开表/排序时调用，始终只展示 50 条） */
function _buildTableDataUI(tn, conn, sch, r, db) {
        if(!r||!r.ok){addOrUpdateTab('data_'+tn,tn,'data','<div style="padding:20px;color:#e74c3c;">❌ '+(r?r.msg:'')+'</div>');return;}
        var tid = 'tbl_data_' + tn.replace(/[^a-zA-Z0-9]/g,'_');
        var cols = r.columns || [];
        var rows = r.rows || [];
        var comments = r.comments || {};
        var sortRef = { col: -1, dir: 1 };
        var sortColName = '';
        // 服务端排序所需参数
        var _connDb = db || '';
        var _connTn = tn;
        var _connSch = sch;

        // 列筛选器状态：{colIndex: filterText}
        var _colFilters = {};

        function buildTh() {
            var h = '<tr><th style="width:28px;text-align:center;"><input type="checkbox" id="'+tid+'_sel_all" onchange="window[\'_toggleSelAll_'+tid+'\'](this.checked)" title="全选/取消全选"></th>';
            cols.forEach(function(c,ci){
                var cmt = comments[c] || '';
                var cmtTitle = cmt ? ' title="'+escapeAttr(cmt)+'"' : '';
                // 排序三态：未排序=⇅(灰色双向箭头), 升序=▲, 降序=▼
                var sortIcon = '⇅';
                if (sortRef.col === ci) {
                    sortIcon = sortRef.dir === 1 ? '▲' : '▼';
                }
                // 漏斗图标（有筛选时高亮）
                var hasFilter = _colFilters[ci] && _colFilters[ci].trim() !== '';
                var filterOpacity = hasFilter ? '1' : '0.25';
                h+='<th class="sortable-th" data-ci="'+ci+'" data-orig="'+escapeAttr(c)+'" style="user-select:none;"'+cmtTitle+'>';
                h+='<span class="col-name">'+escapeHtml(c)+'</span>';
                // float:right 反向排列 → 先写排序再写漏斗 → 排序最右，漏斗在左
                h+='<span class="sort-icon" data-ci="'+ci+'" title="点击排序" style="cursor:pointer;float:right;display:inline-block;width:20px;text-align:center;font-size:11px;color:#888;" onclick="event.stopPropagation();window[\'_sortClickIcon_'+tid+'\']('+ci+')">'+sortIcon+'</span>';
                h+='<span class="col-filter-icon" data-ci="'+ci+'" title="筛选此列" style="cursor:pointer;float:right;font-size:12px;opacity:'+filterOpacity+';color:#aaa;margin-right:14px;" onclick="event.stopPropagation();window[\'_toggleColFilter_'+tid+'\']('+ci+',this)">⏳</span>';
                h+='</th>';
            });
            h += '</tr>';
            // 筛选浮层（绝对定位，覆盖在表格上方）——不再使用表格行
            h += '<tr id="'+tid+'_frow" style="display:none;"><td></td>';
            cols.forEach(function(c,ci){
                h += '<td id="'+tid+'_ftd_'+ci+'"></td>';
            });
            h += '</tr>';
            return h;
        }

        // 行选择状态：Set of original row indices
        var _selectedRows = {};

        function getSelectedOriginalIndices() {
            // 返回选中的原始行索引数组（按升序排列）
            return Object.keys(_selectedRows).map(Number).sort(function(a,b){return a-b;});
        }

        function updateDeleteBtn() {
            var btn = document.getElementById(tid + '_del_btn');
            if (btn) {
                var cnt = getSelectedOriginalIndices().length;
                btn.textContent = '🗑 删除' + (cnt ? ' (' + cnt + ')' : '');
                btn.disabled = cnt === 0;
            }
        }

        // 编辑状态跟踪
        var _changedCells = {}; // key: "originalRowIdx:colIdx" → {old,new,colName,origRow,columns}
        var _editing = false;

        function cellChanged(origRowIdx, colIdx, colName, newVal, oldVal) {
            var key = origRowIdx + ':' + colIdx;
            if (String(newVal) !== String(oldVal)) {
                var origRow = rows[origRowIdx];
                _changedCells[key] = {rowIdx: origRowIdx, colIdx: colIdx, colName: colName,
                    oldVal: oldVal, newVal: newVal, origRow: origRow, columns: cols};
            } else {
                delete _changedCells[key];
            }
            updateSaveBtn();
        }

        function updateSaveBtn() {
            var btn = document.getElementById(tid + '_save_btn');
            var cancelBtn = document.getElementById(tid + '_cancel_btn');
            var cnt = Object.keys(_changedCells).length;
            if (btn) { btn.textContent = '💾 保存' + (cnt ? ' (' + cnt + ')' : ''); btn.disabled = cnt === 0; }
            if (cancelBtn) cancelBtn.disabled = cnt === 0;
            _editing = cnt > 0;
        }

        function render() {
            var pg = getPageRows();
            var tbody = document.getElementById(tid+'_tbody');
            if (!tbody) return;
            if (_editing) return;
            var h = '';
            pg.rows.forEach(function(row, ri){
                var origIdx = pg.indices[ri]; // 原始 rows 中的索引
                var checked = _selectedRows[origIdx] ? ' checked' : '';
                h += '<tr data-ri="'+ri+'" data-orig-idx="'+origIdx+'" oncontextmenu="window[\'_rowCtx_'+tid+'\'](event,'+origIdx+')">';
                // 复选框列
                h += '<td style="text-align:center;padding:2px;"><input type="checkbox" class="row-sel-cb" data-orig-idx="'+origIdx+'" '+checked+' onchange="window[\'_rowSelChanged_'+tid+'\']('+origIdx+',this.checked)"></td>';
                row.forEach(function(v,ci){
                    var val = v===null ? 'NULL' : String(v);
                    h += '<td><input class="editable-cell" data-ri="'+ri+'" data-ci="'+ci+'" data-col="'+escapeAttr(cols[ci])+'" ' +
                        'value="'+escapeAttr(val)+'" ' +
                        'onfocus="this._oldVal=this.value" ' +
                        'onchange="window[\'_cellChanged_'+tid+'\']('+origIdx+','+ci+',\''+escapeAttr(cols[ci])+'\',this.value,this._oldVal)" ' +
                        'onblur="if(this.value!==this._oldVal){window[\'_cellChanged_'+tid+'\']('+origIdx+','+ci+',\''+escapeAttr(cols[ci])+'\',this.value,this._oldVal)}" ' +
                        'spellcheck="false" autocomplete="off"></td>';
                });
                h += '</tr>';
            });
            if (pg.total === 0) h = '<tr><td colspan="'+(cols.length+1)+'" style="text-align:center;color:#666;padding:20px;">（无匹配数据）</td></tr>';
            tbody.innerHTML = h;
            updateWhereCount(tid, pg.total, rows.length);
            updatePagerInfo();
            // 更新全选框状态（基于当前页的行）
            updateSelAllCheckbox(pg);
        }

        function updateSelAllCheckbox(f) {
            var cb = document.getElementById(tid+'_sel_all');
            if (!cb) return;
            var f2 = f || getPageRows();
            if (f2.total === 0) { cb.checked = false; cb.indeterminate = false; return; }
            var selectedCount = 0;
            f2.indices.forEach(function(oi){ if (_selectedRows[oi]) selectedCount++; });
            if (selectedCount === 0) { cb.checked = false; cb.indeterminate = false; }
            else if (selectedCount === f2.indices.length) { cb.checked = true; cb.indeterminate = false; }
            else { cb.checked = false; cb.indeterminate = true; }
        }

        // 列筛选后的中间结果（供 getPageRows 使用）
        var _colFilteredPairs = null; // null 表示无列筛选，使用 getFilteredRows

        // 列筛选：根据每列的输入值过滤行（与WHERE独立，纯客户端筛选）
        function applyColFilters() {
            var hasFilter = false;
            for (var ci in _colFilters) {
                if (_colFilters[ci] && _colFilters[ci].trim() !== '') { hasFilter = true; break; }
            }
            if (!hasFilter) {
                _colFilteredPairs = null;
                _pageOffset = 0;
                render();
                return;
            }
            // 列筛选：基于当前 rows（可能已被排序），不依赖 WHERE
            var pairs = [];
            rows.forEach(function(row, i) {
                var match = true;
                for (var ci in _colFilters) {
                    var ft = _colFilters[ci];
                    if (!ft || ft.trim() === '') continue;
                    var ciNum = parseInt(ci);
                    var cellVal = row[ciNum];
                    cellVal = cellVal === null || cellVal === undefined ? '' : String(cellVal).toLowerCase();
                    if (cellVal.indexOf(ft.trim().toLowerCase()) === -1) { match = false; break; }
                }
                if (match) pairs.push({row: row, idx: i});
            });
            _colFilteredPairs = pairs;
            _pageOffset = 0;
            updateFilterIcons();
            render();
        }

        function updateFilterIcons() {
            var wrap = document.getElementById(tid);
            if (!wrap) return;
            var icons = wrap.querySelectorAll('.col-filter-icon');
            icons.forEach(function(icon){
                var ci = parseInt(icon.getAttribute('data-ci'));
                var hasFilter = _colFilters[ci] && _colFilters[ci].trim() !== '';
                icon.style.opacity = hasFilter ? '1' : '0.3';
            });
        }

        // 当前激活筛选的列索引（-1表示无）
        var _activeFilterCol = -1;
        var _filterPopup = null; // 当前浮层 DOM

        // 关闭筛选浮层
        function closeFilterPopup() {
            if (_filterPopup && _filterPopup.parentNode) {
                _filterPopup.parentNode.removeChild(_filterPopup);
            }
            _filterPopup = null;
            _activeFilterCol = -1;
        }

        // 点击漏斗图标：弹出浮层筛选窗口（覆盖在表格上方，不影响布局）
        function toggleColFilter(ci, iconEl) {
            // 如果已有浮层且是同一列，关闭
            if (_filterPopup && _activeFilterCol === ci) {
                closeFilterPopup();
                _colFilters = {};
                updateFilterIcons();
                _colFilteredPairs = null;
                render();
                return;
            }

            // 关闭之前的浮层
            closeFilterPopup();

            // 创建浮层
            var popup = document.createElement('div');
            popup.className = 'col-filter-popup';
            popup.setAttribute('data-tid', tid);
            var curVal = (_colFilters[ci] || '');

            popup.innerHTML =
                '<div style="font-size:11px;color:#888;margin-bottom:2px;">筛选: <b style="color:#5dade2;">' + escapeHtml(cols[ci]) + '</b></div>' +
                '<input id="'+tid+'_popup_inp" value="' + escapeAttr(curVal) + '" placeholder="输入筛选关键词..." onkeydown="if(event.key===\'Enter\')window[\'_popupApply_'+tid+'\']()">' +
                '<div class="popup-btns">' +
                    '<button onclick="window[\'_popupClear_'+tid+'\']()">清除</button>' +
                    '<button class="btn-apply" onclick="window[\'_popupApply_'+tid+'\']()">应用</button>' +
                '</div>';

            // 定位浮层：在漏斗图标下方
            var rect = iconEl.getBoundingClientRect();
            var scrollWrap = document.querySelector('.data-table-scroll');
            var scrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
            var scrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;

            // 找到 data-table-wrap 的容器
            var wrap = document.getElementById(tid);
            if (wrap) {
                var wrapRect = wrap.getBoundingClientRect();
                popup.style.position = 'absolute';
                popup.style.left = (rect.left - wrapRect.left + scrollLeft) + 'px';
                popup.style.top = (rect.bottom - wrapRect.top + scrollTop + 2) + 'px';
                wrap.appendChild(popup);
            } else {
                document.body.appendChild(popup);
                popup.style.position = 'fixed';
                popup.style.left = rect.left + 'px';
                popup.style.top = (rect.bottom + 2) + 'px';
            }

            _filterPopup = popup;
            _activeFilterCol = ci;

            // 聚焦输入框
            setTimeout(function() {
                var inp = document.getElementById(tid+'_popup_inp');
                if (inp) inp.focus();
            }, 50);

            // 点击浮层外部关闭
            setTimeout(function() {
                document.addEventListener('click', _popupOutsideClick);
            }, 0);
        }

        function _popupOutsideClick(e) {
            if (_filterPopup && !_filterPopup.contains(e.target) && !e.target.closest('.col-filter-icon')) {
                closeFilterPopup();
                document.removeEventListener('click', _popupOutsideClick);
            }
        }

        // 浮层应用筛选
        window['_popupApply_'+tid] = function() {
            var inp = document.getElementById(tid+'_popup_inp');
            if (!inp) return;
            _colFilters[_activeFilterCol] = inp.value;
            closeFilterPopup();
            document.removeEventListener('click', _popupOutsideClick);
            updateFilterIcons();
            applyColFilters();
        };

        // 浮层清除筛选
        window['_popupClear_'+tid] = function() {
            _colFilters[_activeFilterCol] = '';
            closeFilterPopup();
            document.removeEventListener('click', _popupOutsideClick);
            updateFilterIcons();
            applyColFilters();
        };

        function doSaveChanges() {
            var changes = [];
            for (var k in _changedCells) {
                if (_changedCells.hasOwnProperty(k)) {
                    var ch = _changedCells[k];
                    changes.push({col: ch.colName, newVal: String(ch.newVal),
                        origRow: (ch.origRow||[]).map(function(v){return v===null?'NULL':String(v);}),
                        columns: ch.columns || cols});
                }
            }
            if (!changes.length) return;

            eel.table_save_changes(conn, db||activeDatabase, tn, sch, changes)(function(r) {
                if (!r || !r.ok) {
                    var btn = document.getElementById(tid + '_save_btn');
                    if (btn) { btn.textContent = '❌ '+(r?r.msg:'失败'); btn.style.background = '#e74c3c'; }
                    return;
                }
                var sql = r.sql || '';
                showConfirmDialog('确认执行修改',
                    '<div style="max-height:300px;overflow:auto;background:#0d1117;padding:8px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;">' + escapeHtml(sql) + '</div>' +
                    '<div style="margin-top:6px;color:#f39c12;font-size:11px;">共 ' + r.count + ' 处修改</div>',
                    function() {
                        eel.table_exec_save(conn, db||activeDatabase, tn, sch, changes)(function(r2) {
                            if (!r2 || !r2.ok) {
                                var btn2 = document.getElementById(tid + '_save_btn');
                                if (btn2) { btn2.textContent = '❌ '+(r2?r2.msg:'失败'); btn2.style.background = '#e74c3c'; }
                                return;
                            }
                            _changedCells = {};
                            _editing = false;
                            updateSaveBtn();
                            sortColName = sortRef.col >= 0 ? cols[sortRef.col] : '';
                            eel.table_preview_data_fast(conn, db||activeDatabase, tn, sch, sortColName, sortRef.dir === 1 ? 'asc' : 'desc')(function(r3){
                                if (r3 && r3.ok) {
                                    rows = r3.rows || [];
                                    var st6 = _whereStates[tid];
                                    if (st6) st6.rows = rows;
                                    render();
                                }
                            });
                        });
                    }
                );
            });
        }

        function cancelEdit() {
            _changedCells = {};
            _editing = false;
            updateSaveBtn();
            render();
        }

        // 删除选中行
        function doDeleteRows() {
            var selIndices = getSelectedOriginalIndices();
            if (!selIndices.length) return;
            var rowsData = [];
            selIndices.forEach(function(oi) {
                var origRow = rows[oi];
                if (!origRow) return;
                rowsData.push({
                    origRow: origRow.map(function(v){return v===null?'NULL':String(v);}),
                    columns: cols
                });
            });
            if (!rowsData.length) return;

            eel.table_delete_rows(conn, db||activeDatabase, tn, sch, rowsData)(function(r) {
                if (!r || !r.ok) {
                    var btn = document.getElementById(tid + '_del_btn');
                    if (btn) { btn.textContent = '❌ '+(r?r.msg:'失败'); btn.style.background = '#e74c3c'; }
                    return;
                }
                var sql = r.sql || '';
                showConfirmDialog('确认删除行',
                    '<div style="max-height:300px;overflow:auto;background:#0d1117;padding:8px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;">' + escapeHtml(sql) + '</div>' +
                    '<div style="margin-top:6px;color:#e74c3c;font-size:11px;">⚠ 将删除 ' + r.count + ' 行数据，此操作不可撤销</div>',
                    function() {
                        eel.table_exec_delete(conn, db||activeDatabase, tn, sch, rowsData)(function(r2) {
                            if (!r2 || !r2.ok) {
                                var btn2 = document.getElementById(tid + '_del_btn');
                                if (btn2) { btn2.textContent = '❌ '+(r2?r2.msg:'失败'); btn2.style.background = '#e74c3c'; }
                                return;
                            }
                            _selectedRows = {};
                            updateDeleteBtn();
                            sortColName = sortRef.col >= 0 ? cols[sortRef.col] : '';
                            eel.table_preview_data_fast(conn, db||activeDatabase, tn, sch, sortColName, sortRef.dir === 1 ? 'asc' : 'desc')(function(r3){
                                if (r3 && r3.ok) {
                                    rows = r3.rows || [];
                                    var st7 = _whereStates[tid];
                                    if (st7) st7.rows = rows;
                                    render();
                                }
                            });
                        });
                    }
                );
            });
        }

        // 暴露到全局作用域
        window['_doSave_' + tid] = doSaveChanges;
        window['_cancelEdit_' + tid] = cancelEdit;
        window['_cellChanged_' + tid] = cellChanged;
        window['_doDelete_' + tid] = doDeleteRows;
        window['_rowSelChanged_' + tid] = function(origIdx, checked) {
            if (checked) _selectedRows[origIdx] = true;
            else delete _selectedRows[origIdx];
            updateDeleteBtn();
            updateSelAllCheckbox(null);
        };
        window['_toggleSelAll_' + tid] = function(checked) {
            var pg = getPageRows();
            pg.indices.forEach(function(oi){
                if (checked) _selectedRows[oi] = true;
                else delete _selectedRows[oi];
            });
            updateDeleteBtn();
            // 更新所有行复选框
            var tbody = document.getElementById(tid+'_tbody');
            if (tbody) {
                var cbs = tbody.querySelectorAll('.row-sel-cb');
                cbs.forEach(function(cb){ cb.checked = checked; });
            }
            updateSelAllCheckbox(null);
        };
        window['_toggleColFilter_' + tid] = toggleColFilter;

        registerWhereState(tid, cols, rows, sortRef, render);
        _tabIdToTid['data_'+tn] = tid;

        // ★ 暴露清除列筛选的函数，供 applyWhere 调用
        window['_clearColFilters_'+tid] = function() {
            _colFilteredPairs = null;
            _colFilters = {};
            _activeFilterCol = -1;
            var frow = document.getElementById(tid+'_frow');
            if (frow) frow.style.display = 'none';
            updateFilterIcons();
        };
        window['_resetPage_'+tid] = function() {
            _pageOffset = 0;
        };

        // 分页状态
        var _pageSize = 50;   // 每页行数
        var _pageOffset = 0;  // 当前偏移

        function getPageRows() {
            // 如果有列筛选，使用列筛选结果；否则使用 WHERE 筛选结果
            var allFiltered, allIndices;
            if (_colFilteredPairs) {
                allFiltered = _colFilteredPairs.map(function(p){return p.row;});
                allIndices = _colFilteredPairs.map(function(p){return p.idx;});
            } else {
                var f = getFilteredRows(tid);
                allFiltered = f.filtered;
                allIndices = f.indices;
            }
            var total = allFiltered.length;
            if (_pageSize <= 0) {
                // 全部
                return { rows: allFiltered, indices: allIndices, total: total, offset: 0, pageSize: total };
            }
            var start = _pageOffset;
            var end = Math.min(start + _pageSize, total);
            return {
                rows: allFiltered.slice(start, end),
                indices: allIndices.slice(start, end),
                total: total,
                offset: start,
                pageSize: _pageSize
            };
        }

        function updatePagerInfo() {
            var pg = getPageRows();
            var el = document.getElementById(tid+'_pager_info');
            if (!el) return;
            var total = pg.total;
            if (pg.pageSize >= total) {
                el.textContent = '前 ' + total + ' 条';
            } else {
                el.textContent = '显示 ' + (pg.offset+1) + '-' + Math.min(pg.offset+pg.pageSize, total) + ' / 前 ' + total + ' 条';
            }
            var prevBtn = document.getElementById(tid+'_prev_btn');
            var nextBtn = document.getElementById(tid+'_next_btn');
            if (prevBtn) prevBtn.disabled = pg.offset <= 0;
            if (nextBtn) nextBtn.disabled = pg.offset + pg.pageSize >= pg.total;
        }

        function goPage(dir) {
            var pg = getPageRows();
            var newOffset = pg.offset + dir * _pageSize;
            if (newOffset < 0) newOffset = 0;
            if (newOffset >= pg.total) newOffset = Math.max(0, pg.total - _pageSize);
            _pageOffset = newOffset;
            _pageSize = parseInt((document.getElementById(tid+'_psize')||{}).value) || 50;
            render();
        }

        function changePageSize() {
            _pageSize = parseInt((document.getElementById(tid+'_psize')||{}).value) || 50;
            _pageOffset = 0;
            render();
        }

        function showAllRows() {
            _pageSize = 0; // 0 表示全部
            _pageOffset = 0;
            render();
        }

        window['_goPage_'+tid] = goPage;
        window['_changePageSize_'+tid] = changePageSize;
        window['_showAllRows_'+tid] = showAllRows;

        var h = '<div class="data-table-wrap" id="'+tid+'">';
        h += buildWhereBar(tid);
        h += '<div style="display:flex;align-items:center;gap:6px;margin:6px 0;flex-wrap:wrap;">' +
            '<button class="btn btn-sm" id="'+tid+'_save_btn" onclick="window[\'_doSave_'+tid+'\']()" disabled style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存 (0)</button>' +
            '<button class="btn btn-sm" id="'+tid+'_cancel_btn" onclick="window[\'_cancelEdit_'+tid+'\']()" disabled style="background:#e74c3c;color:#fff;font-size:10px;">↩ 取消修改</button>' +
            '<span style="flex:1;"></span>' +
            '<button class="btn btn-sm" id="'+tid+'_del_btn" onclick="window[\'_doDelete_'+tid+'\']()" disabled style="background:#e74c3c;color:#fff;font-size:10px;">🗑 删除 (0)</button>' +
            '<span style="font-size:10px;color:#666;">选中行后点击删除预览SQL</span></div>';
        h += '<div class="data-table-scroll"><table class="exp-table"><thead>';
        h += buildTh();
        h += '</thead><tbody id="'+tid+'_tbody"></tbody></table></div>';
        // 分页栏（固定在底部，不随表格滚动消失）
        h += '<div class="data-pager" id="'+tid+'_pager">' +
            '<button id="'+tid+'_prev_btn">◀ 上一页</button>' +
            '<button id="'+tid+'_next_btn">下一页 ▶</button>' +
            '<select id="'+tid+'_psize">' +
                '<option value="50" selected>50行/页</option>' +
                '<option value="100">100行/页</option>' +
                '<option value="200">200行/页</option>' +
            '</select>' +
            '<button id="'+tid+'_showall_btn">📋 显示全部</button>' +
            '<span style="flex:1;"></span>' +
            '<span id="'+tid+'_pager_info" style="color:#888;"></span>' +
            '</div>';
        h += '</div>';

        addOrUpdateTab('data_'+tn, tn, 'data', h);

        // ★ 分页按钮事件绑定（在 DOM 插入后立即绑定）
        setTimeout(function(){
            var pager = document.getElementById(tid+'_pager');
            if (!pager) return;
            var prevBtn = document.getElementById(tid+'_prev_btn');
            var nextBtn = document.getElementById(tid+'_next_btn');
            var showAllBtn = document.getElementById(tid+'_showall_btn');
            var psizeSel = document.getElementById(tid+'_psize');
            if (prevBtn) prevBtn.addEventListener('click', function(){ goPage(-1); });
            if (nextBtn) nextBtn.addEventListener('click', function(){ goPage(1); });
            if (showAllBtn) showAllBtn.addEventListener('click', function(){ showAllRows(); });
            if (psizeSel) psizeSel.addEventListener('change', function(){ changePageSize(); });
            // 初始状态
            updatePagerInfo();
        }, 0);


        // ★ 服务端排序：点击排序图标 → 后端按列排序返回前50条
        // 三态切换：点击同一列 → 升序→降序→恢复原序；点击不同列 → 升序
        var _origRows = rows.slice(); // 保存原始顺序的 rows 引用
        window['_origRows_' + tid] = _origRows;
        var _origSortRef = { col: -1, dir: 1 };

        // ★ 服务端排序：始终去后端查 50 条，按 order_col/order_dir 排序
        function clientSort(ci) {
            try {
                if (sortRef.col === ci) {
                    // 同一列：升序(1) → 降序(-1) → 恢复原序(col=-1)
                    if (sortRef.dir === 1) { sortRef.dir = -1; }
                    else { sortRef.col = -1; sortRef.dir = 1; }
                } else {
                    sortRef.col = ci; sortRef.dir = 1;
                }
                // 更新表头排序箭头（立即响应）
                var wrap2 = document.getElementById(tid);
                if (wrap2) {
                    var thead = wrap2.querySelector('thead');
                    if (thead) thead.innerHTML = buildTh();
                }
                // 显示加载状态
                var infoEl = document.getElementById(tid + '_pager_info');
                if (infoEl) infoEl.textContent = '⏳ 排序中...';
                // 构建排序参数
                var orderCol = sortRef.col >= 0 ? cols[sortRef.col] : '';
                var orderDir = sortRef.dir === 1 ? 'asc' : 'desc';
                // 服务端查询 50 条
                eel.table_preview_data_fast(conn, _connDb, _connTn, _connSch, orderCol, orderDir)(function(r2){
                    if (!r2 || !r2.ok || !r2.rows) {
                        if (infoEl) infoEl.textContent = '排序失败';
                        return;
                    }
                    // 更新数据
                    rows = r2.rows;
                    _origRows = rows.slice();
                    window['_origRows_' + tid] = _origRows;
                    var st5 = _whereStates[tid];
                    if (st5) st5.rows = rows;
                    // 清除列筛选缓存
                    _colFilteredPairs = null;
                    _pageOffset = 0;
                    render();
                    // 更新表头
                    if (wrap2) {
                        var thead2 = wrap2.querySelector('thead');
                        if (thead2) thead2.innerHTML = buildTh();
                    }
                    if (infoEl) infoEl.textContent = '共 ' + rows.length + ' 行（前50）';
                });
            } catch(e) {
                console.error('clientSort error:', e);
            }
        }


        // SQL 辅助函数（用于生成 INSERT 语句）
        function _safeIdent(name) {
            // 简单标识符引用（反引号风格，兼容 MySQL/通用）
            return '`' + String(name).replace(/`/g, '``') + '`';
        }
        function _sqlValue(v) {
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'number') return String(v);
            // 尝试识别纯数字字符串
            var s = String(v);
            if (s === '') return "''";
            // 检查是否为整数或浮点数
            if (/^-?\d+(\.\d+)?$/.test(s.trim())) return s.trim();
            // 字符串值：单引号转义
            return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
        }

        // 行右键菜单：复制为 INSERT SQL
        function _rowCtxHandler(e, origIdx) {
            e.preventDefault(); e.stopPropagation();
            var row = rows[origIdx];
            if (!row) return;
            // 生成 INSERT SQL
            var colNames = cols.map(function(c){ return _safeIdent(c); }).join(', ');
            var values = row.map(function(v, i){
                return _sqlValue(v);
            }).join(', ');
            var sql = 'INSERT INTO ' + _safeIdent(tn) + ' (' + colNames + ') VALUES (' + values + ');';
            showCtxMenu(e.clientX, e.clientY, [
                {label:'📋 复制为 INSERT SQL', action:function(){
                    copyToClipboard(sql);
                }}
            ]);
        }

        // 排序事件处理函数：只响应点击排序图标（不再点击整列）
        function _sortClickIconHandler(ci) {
            clientSort(ci);
        }

        // 暴露给 onclick/oncontextmenu 的函数
        window['_sortClickIcon_'+tid] = _sortClickIconHandler;
        window['_rowCtx_'+tid] = _rowCtxHandler;

        setTimeout(function(){
            render();
        }, 150);
}

// 取消数据排序
function cancelDataSort(cancelKey, tid) {
    window[cancelKey] = true;
    eel.cancel_query()();
    // 错误提示显示在 WHERE 栏，不遮挡列头
    updateWhereCount(tid, 0, _whereStates[tid]?(_whereStates[tid].rows||[]).length:0);
    var cnt2 = document.getElementById(tid+'_count');
    if (cnt2) { cnt2.textContent = '⏸ 排序已取消'; cnt2.style.color = '#f39c12'; }
    // 重置排序状态
    var st = _whereStates[tid];
    if (st && st.sortRef) { st.sortRef.col = -1; st.sortRef.dir = 1; }
    setTimeout(function(){
        var wrap2 = document.getElementById(tid);
        if (wrap2) {
            var thead2 = wrap2.querySelector('thead');
            if (thead2) {
                var cols2 = _whereStates[tid] ? _whereStates[tid].cols : [];
                var sortRef2 = _whereStates[tid] ? _whereStates[tid].sortRef : null;
                if (cols2.length) {
                    var h = '<tr><th style="width:28px;text-align:center;"><input type="checkbox" id="'+tid+'_sel_all" onchange="window[\'_toggleSelAll_'+tid+'\'](this.checked)" title="全选/取消全选"></th>';
                    cols2.forEach(function(c,ci){
                        var sortIcon = '▽';
                        if (sortRef2 && sortRef2.col === ci) { sortIcon = sortRef2.dir === 1 ? '▲' : '▼'; }
                        h += '<th class="sortable-th" data-ci="'+ci+'" data-orig="'+escapeAttr(c)+'" style="user-select:none;">'+escapeHtml(c)+'<span class="sort-icon" data-ci="'+ci+'" title="点击排序" style="cursor:pointer;float:right;display:inline-block;width:20px;text-align:center;font-size:11px;color:#888;" onclick="event.stopPropagation();window[\'_sortClickIcon_'+tid+'\']('+ci+')">'+sortIcon+'</span><span class="col-filter-icon" data-ci="'+ci+'" style="cursor:pointer;float:right;font-size:12px;opacity:0.25;color:#aaa;margin-right:14px;" onclick="event.stopPropagation();window[\'_toggleColFilter_'+tid+'\']('+ci+',this)">⏳</span></th>';
                    });
                    h += '</tr>';
                    thead2.innerHTML = h;
                }
            }
        }
    }, 400);
}

function addTableDDLTab(tn, db, schema, cid) {
    var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
    var sch = schema || '';
    var tabId = 'ddl_' + tn;
    addOrUpdateTab(tabId, tn, 'ddl', '<div style="padding:20px;color:#999;">⏳ 加载表设计...</div>');

    eel.table_get_design_info(conn, db || activeDatabase, tn, sch)(function(r) {
        try {
            if (!r || !r.ok) {
                addOrUpdateTab(tabId, tn, 'ddl', '<div style="padding:20px;color:#e74c3c;">❌ ' + (r ? escapeHtml(r.msg) : '加载失败，请检查连接') + '</div>');
                return;
            }
            var design = r.design || {columns:[], indexes:[], foreign_keys:[], table_options:{}};
            window._tableDesign = { conn: conn, db: db || activeDatabase, tn: tn, schema: sch, cid: cid, design: design, tabId: tabId };
            buildDesignerUI(tabId, tn, design);
        } catch(e) {
            addOrUpdateTab(tabId, tn, 'ddl', '<div style="padding:20px;color:#e74c3c;">❌ 渲染失败: ' + escapeHtml(String(e)) + '</div>');
        }
    });
}

function buildDesignerUI(tabId, tn, design) {
    var cols = design.columns || [];
    var idxs = design.indexes || [];
    var fks = design.foreign_keys || [];
    var opts = design.table_options || {};

    var dataTypes = ['INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'FLOAT', 'DOUBLE', 'DECIMAL',
        'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYTEXT',
        'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
        'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'TINYBLOB', 'JSON', 'ENUM', 'SET', 'BOOLEAN'];

    // ---- 字段表格 ----
    var rowsHtml = '';
    for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        rowsHtml += buildFieldRow(i, c, dataTypes);
    }

    var fieldsHtml =
        '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button class="btn btn-sm" onclick="designAddField()" style="background:#27ae60;color:#fff;">+ 添加字段</button>' +
            '<button class="btn btn-sm" onclick="designInsertField(-1)" style="background:#2980b9;color:#fff;">↑ 顶部插入</button>' +
        '</div>' +
        '<div style="overflow-x:auto;flex:1;min-height:0;">' +
            '<table class="design-table" id="design_fields_table">' +
                '<thead><tr>' +
                    '<th style="width:30px;">#</th>' +
                    '<th style="min-width:120px;">字段名</th>' +
                    '<th style="min-width:110px;">类型</th>' +
                    '<th style="width:60px;">长度</th>' +
                    '<th style="width:50px;">Null</th>' +
                    '<th style="min-width:90px;">默认值</th>' +
                    '<th style="width:45px;">自增</th>' +
                    '<th style="min-width:60px;">注释</th>' +
                    '<th style="width:80px;">操作</th>' +
                '</tr></thead>' +
                '<tbody>' + rowsHtml + '</tbody>' +
            '</table>' +
        '</div>';

    // ---- 索引表格 ----
    var idxHtml = '<div style="margin-bottom:8px;"><button class="btn btn-sm" onclick="designAddIndex()" style="background:#27ae60;color:#fff;">+ 添加索引</button></div>';
    if (idxs.length) {
        idxHtml += '<table class="design-table"><thead><tr><th>索引名</th><th>类型</th><th>字段</th><th>方法</th><th style="width:60px;">操作</th></tr></thead><tbody>';
        for (var j = 0; j < idxs.length; j++) {
            var x = idxs[j];
            idxHtml += '<tr>' +
                '<td><input class="design-input idx-name" value="' + escapeAttr(x.name) + '" data-idx="' + j + '"></td>' +
                '<td><select class="design-select idx-type" data-idx="' + j + '"><option value="INDEX"' + (x.type === 'INDEX' ? ' selected' : '') + '>INDEX</option><option value="UNIQUE"' + (x.type === 'UNIQUE' ? ' selected' : '') + '>UNIQUE</option><option value="PRIMARY"' + (x.type === 'PRIMARY' ? ' selected' : '') + '>PRIMARY</option></select></td>' +
                '<td><input class="design-input idx-cols" value="' + escapeAttr((x.columns || []).join(', ')) + '" data-idx="' + j + '" placeholder="字段名,逗号分隔"></td>' +
                '<td><select class="design-select idx-method" data-idx="' + j + '"><option value="BTREE"' + (x.method === 'BTREE' ? ' selected' : '') + '>BTREE</option><option value="HASH"' + (x.method === 'HASH' ? ' selected' : '') + '>HASH</option></select></td>' +
                '<td><button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;" onclick="designRemoveIndex(' + j + ')">✕</button></td>' +
            '</tr>';
        }
        idxHtml += '</tbody></table>';
    } else {
        idxHtml += '<div style="color:#888;font-size:11px;padding:8px;">（无索引）</div>';
    }

    // ---- 外键 ----
    var fkHtml = '';
    if (fks.length) {
        fkHtml = '<table class="design-table"><thead><tr><th>外键名</th><th>本表字段</th><th>参照表</th><th>参照字段</th><th>ON DELETE</th><th>ON UPDATE</th></tr></thead><tbody>';
        for (var k = 0; k < fks.length; k++) {
            var f = fks[k];
            fkHtml += '<tr><td>' + escapeHtml(f.name) + '</td><td>' + escapeHtml(f.column) + '</td><td>' + escapeHtml(f.ref_table) + '</td><td>' + escapeHtml(f.ref_column) + '</td><td>' + escapeHtml(f.on_delete) + '</td><td>' + escapeHtml(f.on_update) + '</td></tr>';
        }
        fkHtml += '</tbody></table>';
    } else {
        fkHtml = '<div style="color:#888;font-size:11px;padding:8px;">（无外键）</div>';
    }

    // ---- 表属性 ----
    var engines = ['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV'];
    var collations = ['utf8mb4_unicode_ci', 'utf8mb4_general_ci', 'utf8_unicode_ci', 'utf8_general_ci', 'latin1_swedish_ci'];
    var engOpts = engines.map(function(e) { return '<option value="' + e + '"' + (opts.engine === e ? ' selected' : '') + '>' + e + '</option>'; }).join('');
    var colOpts = collations.map(function(c) { return '<option value="' + c + '"' + (opts.collation === c ? ' selected' : '') + '>' + c + '</option>'; }).join('');
    var propsHtml =
        '<table class="design-table" style="max-width:500px;"><tbody>' +
            '<tr><td style="width:80px;">存储引擎</td><td><select class="design-select" id="design_engine">' + engOpts + '</select></td></tr>' +
            '<tr><td>字符集</td><td><select class="design-select" id="design_collation">' + colOpts + '</select></td></tr>' +
            '<tr><td>表注释</td><td><input class="design-input" id="design_comment" value="' + escapeAttr(opts.comment || '') + '" style="width:100%;"></td></tr>' +
        '</table>';

    // ---- 组装完整 HTML ----
    var html =
        '<div class="designer-container">' +
            '<div class="designer-toolbar">' +
                '<b style="font-size:13px;">🔧 设计表：' + escapeHtml(tn) + '</b>' +
                '<div style="display:flex;gap:6px;">' +
                    '<button class="btn btn-sm" style="background:#555;color:#ccc;" onclick="designViewDDL()">📄 查看SQL</button>' +
                    '<button class="btn btn-sm" style="background:#2980b9;color:#fff;" onclick="designRefresh()">🔄 刷新</button>' +
                    '<button class="btn btn-sm" style="background:#27ae60;color:#fff;" onclick="designSave()">💾 保存</button>' +
                '</div>' +
            '</div>' +
            '<div class="designer-subtabs" id="design_subtabs">' +
                '<button class="designer-subtab active" onclick="designSwitchTab(\'fields\')">📋 字段</button>' +
                '<button class="designer-subtab" onclick="designSwitchTab(\'indexes\')">🔑 索引</button>' +
                '<button class="designer-subtab" onclick="designSwitchTab(\'fks\')">🔗 外键</button>' +
                '<button class="designer-subtab" onclick="designSwitchTab(\'props\')">⚙ 表属性</button>' +
            '</div>' +
            '<div class="designer-panes">' +
                '<div class="designer-pane active" id="design_pane_fields">' + fieldsHtml + '</div>' +
                '<div class="designer-pane" id="design_pane_indexes">' + idxHtml + '</div>' +
                '<div class="designer-pane" id="design_pane_fks">' + fkHtml + '</div>' +
                '<div class="designer-pane" id="design_pane_props">' + propsHtml + '</div>' +
            '</div>' +
        '</div>';

    addOrUpdateTab(tabId, tn, 'ddl', html);
}

function buildFieldRow(i, c, dataTypes) {
    var typeOpts = dataTypes.map(function(t) {
        return '<option value="' + t + '"' + ((c.data_type || '').toUpperCase() === t ? ' selected' : '') + '>' + t + '</option>';
    }).join('');
    var len = c.length || '';
    if (!len && c.col_type && typeof c.col_type === 'string') {
        var m = c.col_type.match(/\((\d+)(?:,(\d+))?\)/);
        if (m) len = m[2] ? m[1] + ',' + m[2] : m[1];
    }
    var defVal = c.default_val || '';
    // 清理 default 值（去掉多余的单引号包裹层）
    if (defVal && typeof defVal === 'string' && defVal.startsWith("'") && defVal.length > 2) defVal = defVal.slice(1, -1);
    return '<tr data-row="' + i + '">' +
        '<td style="text-align:center;color:#888;">' + (i + 1) + '</td>' +
        '<td><input class="design-input field-name" value="' + escapeAttr(c.name) + '" data-row="' + i + '" data-field="name"></td>' +
        '<td><select class="design-select field-type" data-row="' + i + '" data-field="data_type">' + typeOpts + '</select></td>' +
        '<td><input class="design-input field-len" value="' + escapeAttr(len) + '" data-row="' + i + '" data-field="length" style="width:55px;"></td>' +
        '<td style="text-align:center;"><input type="checkbox" class="field-null" data-row="' + i + '" data-field="nullable"' + (c.nullable ? ' checked' : '') + '></td>' +
        '<td><input class="design-input field-default" value="' + escapeAttr(defVal) + '" data-row="' + i + '" data-field="default_val"></td>' +
        '<td style="text-align:center;"><input type="checkbox" class="field-autoinc" data-row="' + i + '" data-field="auto_increment"' + (c.auto_increment ? ' checked' : '') + '></td>' +
        '<td><input class="design-input field-comment" value="' + escapeAttr(c.comment || '') + '" data-row="' + i + '" data-field="comment"></td>' +
        '<td style="white-space:nowrap;">' +
            '<button class="btn btn-sm" style="background:#2980b9;color:#fff;font-size:10px;padding:2px 5px;" onclick="designInsertField(' + i + ')" title="上方插入">⬆</button> ' +
            '<button class="btn btn-sm" style="background:#e67e22;color:#fff;font-size:10px;padding:2px 5px;" onclick="designInsertField(' + (i + 1) + ')" title="下方插入">⬇</button> ' +
            '<button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;padding:2px 5px;" onclick="designRemoveField(' + i + ')">✕</button>' +
        '</td></tr>';
}

// ==================== 设计器交互函数 ====================
function designSwitchTab(tab) {
    document.querySelectorAll('.designer-subtab').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.designer-pane').forEach(function(p) { p.classList.remove('active'); });
    var btns = document.querySelectorAll('.designer-subtab');
    for (var i = 0; i < btns.length; i++) {
        if (btns[i].textContent.indexOf({fields:'字段',indexes:'索引',fks:'外键',props:'表属性'}[tab]) >= 0) btns[i].classList.add('active');
    }
    var pane = document.getElementById('design_pane_' + tab);
    if (pane) pane.classList.add('active');
}

// 把当前表单里的字段数据保存回 ds.design.columns（防新增时清空已填内容）
function collectFieldsToDesign() {
    var ds = window._tableDesign;
    if (!ds) return;
    var rows = document.querySelectorAll('#design_fields_table tbody tr');
    for (var i = 0; i < rows.length && i < ds.design.columns.length; i++) {
        var row = rows[i];
        var nameEl = row.querySelector('.field-name');
        var typeEl = row.querySelector('.field-type');
        var lenEl = row.querySelector('.field-len');
        var nullEl = row.querySelector('.field-null');
        var defEl = row.querySelector('.field-default');
        var aiEl = row.querySelector('.field-autoinc');
        var cmtEl = row.querySelector('.field-comment');
        if (nameEl) ds.design.columns[i].name = nameEl.value.trim() || ds.design.columns[i].name;
        if (typeEl) {
            ds.design.columns[i].data_type = typeEl.value;
            ds.design.columns[i].col_type = typeEl.value;
            if (lenEl && lenEl.value.trim()) ds.design.columns[i].col_type = typeEl.value + '(' + lenEl.value.trim() + ')';
        }
        if (nullEl) ds.design.columns[i].nullable = nullEl.checked;
        if (defEl) ds.design.columns[i].default_val = defEl.value.trim() || null;
        if (aiEl) ds.design.columns[i].auto_increment = aiEl.checked;
        if (cmtEl) ds.design.columns[i].comment = cmtEl.value.trim();
    }
}

function designAddField() {
    collectFieldsToDesign();
    var ds = window._tableDesign;
    if (!ds) return;
    ds.design.columns.push({name:'new_field', data_type:'VARCHAR', col_type:'VARCHAR(255)', length:'255', nullable:true, default_val:null, auto_increment:false, comment:''});
    rebuildFieldsTable();
}

function designInsertField(pos) {
    collectFieldsToDesign();
    var ds = window._tableDesign;
    if (!ds) return;
    ds.design.columns.splice(pos < 0 ? 0 : pos, 0, {name:'new_field', data_type:'VARCHAR', col_type:'VARCHAR(255)', length:'255', nullable:true, default_val:null, auto_increment:false, comment:''});
    rebuildFieldsTable();
}

function designRemoveField(row) {
    collectFieldsToDesign();
    var ds = window._tableDesign;
    if (!ds) return;
    if (ds.design.columns.length <= 1) { showWarnDialog('提示', '至少保留一个字段'); return; }
    ds.design.columns.splice(row, 1);
    rebuildFieldsTable();
}

function rebuildFieldsTable() {
    var ds = window._tableDesign;
    if (!ds) return;
    var dataTypes = ['INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'FLOAT', 'DOUBLE', 'DECIMAL',
        'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYTEXT',
        'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
        'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'TINYBLOB', 'JSON', 'ENUM', 'SET', 'BOOLEAN'];
    var rowsHtml = '';
    for (var i = 0; i < ds.design.columns.length; i++) {
        rowsHtml += buildFieldRow(i, ds.design.columns[i], dataTypes);
    }
    var tbody = document.querySelector('#design_fields_table tbody');
    if (tbody) tbody.innerHTML = rowsHtml;
}

// 把当前索引表单数据保存回 ds.design.indexes
function collectIndexesToDesign() {
    var ds = window._tableDesign;
    if (!ds) return;
    var idxNames = document.querySelectorAll('.idx-name');
    var idxTypes = document.querySelectorAll('.idx-type');
    var idxCols = document.querySelectorAll('.idx-cols');
    var idxMethods = document.querySelectorAll('.idx-method');
    for (var j = 0; j < idxNames.length && j < ds.design.indexes.length; j++) {
        ds.design.indexes[j].name = idxNames[j].value.trim() || ds.design.indexes[j].name;
        ds.design.indexes[j].type = idxTypes[j].value;
        ds.design.indexes[j].columns = idxCols[j].value.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
        ds.design.indexes[j].method = idxMethods[j].value;
    }
}

function designAddIndex() {
    collectFieldsToDesign();
    collectIndexesToDesign();
    var ds = window._tableDesign;
    if (!ds) return;
    var idxName = 'idx_' + ds.design.columns[0].name;
    ds.design.indexes.push({name: idxName, type: 'INDEX', columns: [ds.design.columns[0].name], method: 'BTREE'});
    buildDesignerUI(ds.tabId, ds.tn, ds.design);
    designSwitchTab('indexes');
}

function designRemoveIndex(j) {
    collectFieldsToDesign();
    collectIndexesToDesign();
    var ds = window._tableDesign;
    if (!ds) return;
    ds.design.indexes.splice(j, 1);
    buildDesignerUI(ds.tabId, ds.tn, ds.design);
    designSwitchTab('indexes');
}

// 收集表单数据到 design 对象
function designCollect() {
    var ds = window._tableDesign;
    if (!ds) return null;
    var d = JSON.parse(JSON.stringify(ds.design));

    // 字段数据：直接从表单重建，不依赖 ds.design.columns 的旧值
    var rows = document.querySelectorAll('#design_fields_table tbody tr');
    d.columns = [];
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var nameEl = row.querySelector('.field-name');
        var typeEl = row.querySelector('.field-type');
        var lenEl = row.querySelector('.field-len');
        var nullEl = row.querySelector('.field-null');
        var defEl = row.querySelector('.field-default');
        var aiEl = row.querySelector('.field-autoinc');
        var cmtEl = row.querySelector('.field-comment');
        var colName = nameEl ? nameEl.value.trim() : ('col_' + i);
        var dt = typeEl ? typeEl.value : 'VARCHAR';
        var len = lenEl ? lenEl.value.trim() : '';
        d.columns.push({
            name: colName,
            data_type: dt,
            col_type: len ? dt + '(' + len + ')' : dt,
            length: len,
            nullable: nullEl ? nullEl.checked : true,
            default_val: defEl ? (defEl.value.trim() || null) : null,
            auto_increment: aiEl ? aiEl.checked : false,
            comment: cmtEl ? cmtEl.value.trim() : ''
        });
    }

    // 收集索引数据
    var idxNames = document.querySelectorAll('.idx-name');
    var idxTypes = document.querySelectorAll('.idx-type');
    var idxCols = document.querySelectorAll('.idx-cols');
    var idxMethods = document.querySelectorAll('.idx-method');
    for (var j = 0; j < idxNames.length && j < d.indexes.length; j++) {
        d.indexes[j].name = idxNames[j].value.trim();
        d.indexes[j].type = idxTypes[j].value;
        d.indexes[j].columns = idxCols[j].value.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
        d.indexes[j].method = idxMethods[j].value;
    }

    // 收集表属性
    var engEl = document.getElementById('design_engine');
    var colEl = document.getElementById('design_collation');
    var cmtEl2 = document.getElementById('design_comment');
    if (engEl) d.table_options.engine = engEl.value;
    if (colEl) d.table_options.collation = colEl.value;
    if (cmtEl2) d.table_options.comment = cmtEl2.value.trim();

    return d;
}

function designSave() {
    collectFieldsToDesign();
    collectIndexesToDesign();
    var ds = window._tableDesign;
    if (!ds) return;
    var design = designCollect();
    if (!design) return;

    // 先预览 SQL
    document.getElementById('modal_icon').innerHTML = '🔍';
    document.getElementById('modal_title').textContent = '预览变更 SQL';
    document.getElementById('modal_title').style.color = '#2980b9';
    document.getElementById('modal_msg').innerHTML = '<div style="color:#888;padding:20px;text-align:center;">⏳ 正在生成 SQL...</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">取消</button>';
    document.getElementById('modal_overlay').classList.add('show');

    eel.table_apply_design(ds.conn, ds.db, ds.tn, design, ds.schema, false)(function(r) {
        if (!r || !r.ok) {
            document.getElementById('modal_overlay').classList.remove('show');
            showErrorDialog('生成失败', r ? r.msg : '未知错误');
            return;
        }
        var sqls = r.sqls || [];
        if (!sqls.length) {
            document.getElementById('modal_overlay').classList.remove('show');
            showOkDialog('提示', '表结构无变更');
            return;
        }
        var sqlHtml = sqls.map(function(s) {
            // 格式化：每个 SQL 子句换行缩进，方便阅读
            var formatted = s.replace(/^ALTER TABLE (\S+)\s+/, 'ALTER TABLE <b>$1</b>\n&nbsp;&nbsp;')
                .replace(/, (DROP|ADD|MODIFY|ENGINE|COLLATE|COMMENT=)(\S?)/g, ',\n&nbsp;&nbsp;$1$3');
            return '<div style="background:#0d1117;border:1px solid #333;border-radius:4px;padding:10px 12px;margin-bottom:8px;font-family:Consolas,monospace;font-size:11px;color:#e0e0e0;line-height:1.65;white-space:pre-wrap;word-break:break-all;">' + formatted + '</div>';
        }).join('');
        document.getElementById('modal_icon').innerHTML = '⚠️';
        document.getElementById('modal_title').textContent = '确认执行变更';
        document.getElementById('modal_title').style.color = '#e67e22';
        document.getElementById('modal_msg').innerHTML =
            '<div style="max-height:300px;overflow-y:auto;margin-bottom:8px;">' + sqlHtml + '</div>' +
            '<div style="font-size:11px;color:#e74c3c;">共 ' + sqls.length + ' 条 SQL，确认后将直接修改表结构</div>';
        document.getElementById('modal_btns').innerHTML =
            '<button class="btn btn-gray" onclick="hideModal()">取消</button>' +
            '<button class="btn btn-red" id="modal_exec_btn">执行</button>';
        document.getElementById('modal_exec_btn').onclick = function() {
            hideModal();
            // 显示执行进度
            document.getElementById('modal_icon').innerHTML = '⏳';
            document.getElementById('modal_title').textContent = '执行中...';
            document.getElementById('modal_title').style.color = '#f39c12';
            document.getElementById('modal_msg').innerHTML = '<div style="text-align:center;padding:20px;color:#888;">正在应用表设计修改...</div>';
            document.getElementById('modal_btns').innerHTML = '';
            document.getElementById('modal_overlay').classList.add('show');

            eel.table_apply_design(ds.conn, ds.db, ds.tn, design, ds.schema, true)(function(r2) {
                document.getElementById('modal_overlay').classList.remove('show');
                if (r2 && r2.ok) {
                    showOkDialog('成功', r2.msg);
                    setTimeout(function() { designRefresh(); }, 300);
                } else {
                    showErrorDialog('失败', r2 ? r2.msg : '未知错误');
                }
            });
        };
    });
}

function designRefresh() {
    var ds = window._tableDesign;
    if (!ds) return;
    addTableDDLTab(ds.tn, ds.db, ds.schema, ds.cid);
}

function designViewDDL() {
    var ds = window._tableDesign;
    if (!ds) return;
    document.getElementById('modal_icon').innerHTML = '📄';
    document.getElementById('modal_title').textContent = '建表 SQL：' + ds.tn;
    document.getElementById('modal_title').style.color = '#4fc3f7';
    document.getElementById('modal_msg').innerHTML = '<div style="color:#888;padding:20px;text-align:center;">⏳ 加载中...</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';
    document.getElementById('modal_overlay').classList.add('show');

    eel.table_get_ddl(ds.conn, ds.db, ds.tn, ds.schema)(function(r) {
        var ddl = '<div style="color:#e74c3c;">❌ ' + escapeHtml(r ? r.msg : '加载失败') + '</div>';
        if (r && r.ok && r.ddl) {
            ddl = '<pre style="background:#0d1117;border:1px solid #333;border-radius:6px;padding:12px;font-family:Consolas,monospace;font-size:11px;color:#e0e0e0;white-space:pre-wrap;word-break:break-all;max-height:450px;overflow-y:auto;margin:0;">' + escapeHtml(r.ddl) + '</pre>';
        }
        document.getElementById('modal_msg').innerHTML = ddl;
    });
}

function openQueryInTab(qid) {
    eel.tree_get_query(qid)(function(q){
        if(!q)return;
        var cid = q.conn_id || '';
        var qdb = q.db || '';
        // 确保 activeConnData 来自查询所属连接，不依赖外部状态
        if (cid && treeData && treeData.connections && treeData.connections[cid]) {
            activeConnId = cid;
            activeConnData = treeData.connections[cid];
        }
        var content =
            '<div class="query-layout" id="ql_'+qid+'">' +
            '<div class="query-toolbar"><button id="btn_exe_'+qid+'" class="btn btn-green" style="font-size:11px;padding:4px 14px;" onclick="execQueryTab(\''+qid+'\')">▶ 执行</button>' +
            '<span style="font-size:11px;color:#888;">Ctrl+Enter 执行 | Ctrl+S 保存</span></div>' +
            '<div class="query-editor-wrap"><textarea id="sq_'+qid+'" class="query-editor">'+escapeHtml(q.sql||'')+'</textarea></div>' +
            '<div class="query-splitter" id="qs_'+qid+'"></div>' +
            '<div class="query-results-wrap" id="qr_'+qid+'"></div>' +
            '</div>';
        addOrUpdateTab('query_'+qid, q.name, 'query', content, q.db);
        setTimeout(function(){
            var ta = document.getElementById('sq_'+qid);
            var btnE = document.getElementById('btn_exe_'+qid);
            function updateBtnLabel() {
                if (!ta || !btnE || btnE.textContent === '⏹ 取消') return;
                var s = ta.selectionStart, e = ta.selectionEnd;
                btnE.textContent = (s !== e) ? '▶ 执行选中' : '▶ 执行';
            }
            if(ta) {
                ta.addEventListener('keydown',function(e){
                    if(e.ctrlKey&&e.key==='Enter') execQueryTab(qid);
                    if(e.ctrlKey&&(e.key==='s'||e.key==='S')) { e.preventDefault(); saveQueryTab(qid, cid, qdb, q.name); }
                });
                ta.addEventListener('mouseup', updateBtnLabel);
                ta.addEventListener('keyup', updateBtnLabel);
            }
            // 初始化可拖动分割线
            initQuerySplitter('ql_'+qid, 'qs_'+qid, 'sq_'+qid, 'qr_'+qid);
        },100);
    });
}

function saveQueryTab(qid, cid, db, qname) {
    var ta = document.getElementById('sq_' + qid);
    if (!ta) return;
    var sql = ta.value;
    eel.tree_save_query(qid, qname || '', sql, cid, db)(function(r){
        // 绿色边框闪烁提示已保存
        if (ta) {
            ta.style.boxShadow = 'inset 0 0 0 2px #2ecc71';
            ta.style.transition = 'box-shadow 0.3s';
            setTimeout(function(){ ta.style.boxShadow = ''; }, 1200);
        }
    });
}

// 从 SQL 中检测 db.table 前缀引用，自动提取数据库名
function detectDbFromSql(sql) {
    var m = sql.match(/(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+`?(\w+)`?\./i);
    return m && m[1] ? m[1] : '';
}

// 查询执行取消标记（按 qid）
var _execCancelFlags = {};

// ==================== 查询编辑器分割线拖动 ====================
var _querySplitterInited = {};
function initQuerySplitter(layoutId, splitterId, editorId, resultsId) {
    if (_querySplitterInited[splitterId]) return; // 防止重复绑定
    var splitter = document.getElementById(splitterId);
    if (!splitter) return;
    var layout = document.getElementById(layoutId);
    var editorWrap = splitter.previousElementSibling;
    var resultsWrap = splitter.nextElementSibling;
    if (!editorWrap || !resultsWrap) return;

    _querySplitterInited[splitterId] = true;

    var startY, startH;
    splitter.addEventListener('mousedown', function(e) {
        if (!layout.classList.contains('split')) return;
        splitter.classList.add('active');
        startY = e.clientY;
        var totalH = layout.clientHeight - splitter.offsetHeight;
        startH = editorWrap.offsetHeight;
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';

        function onMove(ev) {
            var dy = ev.clientY - startY;
            var newH = Math.max(60, Math.min(totalH - 80, startH + dy));
            editorWrap.style.height = newH + 'px';
            editorWrap.style.flex = 'none';
            resultsWrap.style.flex = '1';
        }
        function onUp() {
            splitter.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function execQueryTab(qid) {
    // 检查是否有选中文本
    var ta = document.getElementById('sq_'+qid);
    var selection = '';
    if (ta) {
        var start = ta.selectionStart, end = ta.selectionEnd;
        if (start !== end) {
            selection = ta.value.substring(start, end).trim();
        }
    }
    eel.tree_get_query(qid)(function(q){
        if(!q)return;
        var sqlEl = document.getElementById('sq_'+qid);
        var fullSql = sqlEl ? sqlEl.value : (q.sql||'');

        // 检查当前选中
        var sel = '';
        if (sqlEl) {
            var st2 = sqlEl.selectionStart, en2 = sqlEl.selectionEnd;
            if (st2 !== en2) sel = sqlEl.value.substring(st2, en2).trim();
        }
        var sqlToExec = sel || fullSql;
        var stmts = sqlToExec.split(';').filter(function(s){return s.trim();});
        if(!stmts.length) return;
        var resultsDiv = document.getElementById('qr_'+qid);
        var btnExe = document.getElementById('btn_exe_'+qid);

        // 如果正在执行中，取消
        if (_execCancelFlags[qid]) {
            cancelExecQuery(qid);
            return;
        }

        _execCancelFlags[qid] = false;
        // 切换按钮为取消状态
        if (btnExe) { btnExe.textContent = '⏹ 取消'; btnExe.style.background = '#e74c3c'; }
        resultsDiv.innerHTML = '<div style="padding:10px;color:#999;display:flex;align-items:center;gap:10px;"><span>⏳ 执行中...</span><button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;padding:3px 10px;" onclick="cancelExecQuery(\''+qid+'\')">⏹ 取消</button></div>';
        // 切换分栏
        var layout = resultsDiv.parentElement;
        if(layout) layout.classList.add('split');

        // 连接信息必须来自树内，绝不回退到 db-shared 表单（那是其他 Tab 的配置）
        if (!activeConnData) {
            resultsDiv.innerHTML = '<div style="padding:20px;color:#e74c3c;">❌ 未找到活动连接，请先在左侧树中展开连接再执行查询</div>';
            _execCancelFlags[qid] = false;
            return;
        }

        // ★ Redis 连接：逐行执行 Redis 命令
        if (activeConnData.db_type === 'redis') {
            execRedisQueryTab(qid, btnExe, resultsDiv, sqlToExec);
            return;
        }

        var allResults = [];
        var pending = 0;
        // 确定执行数据库优先级：SQL 显式前缀 > 查询自身 db > 连接默认 db（不含 activeDatabase 等外部状态）
        var curTab = objectTabs.find(function(t){return t.id==='query_'+qid;});
        var qDb = curTab ? curTab.db : '';
        var sqlDb = detectDbFromSql(fullSql);
        var execDb = sqlDb || qDb || activeConnData.db || '';
        stmts.forEach(function(stmt,i){
            var clean = stmt.trim();
            if(!clean) {allResults[i]=null; return;}
            pending++;
            var data = {src_host:activeConnData.host, src_port:activeConnData.port, src_user:activeConnData.user, src_pwd:activeConnData.pwd, src_db:execDb, db_type:activeConnData.db_type||'mysql'};
            eel.execute_sql_query(clean, data)(function(result){
                if (_execCancelFlags[qid]) {
                    _execCancelFlags[qid] = false;
                    foreachPending();
                    return;
                }
                allResults[i] = result;
                pending--;
                foreachPending();
            });
        });

        function foreachPending() {
            if (pending > 0) return;
            if (_execCancelFlags[qid]) {
                _execCancelFlags[qid] = false;
                if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
                resultsDiv.innerHTML = '<div style="padding:10px;color:#f39c12;">⏸ 查询已取消</div>';
                return;
            }
            _execCancelFlags[qid] = false;
            if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
            renderQueryResults(resultsDiv, allResults, stmts.length, stmts);
        }
    });
}

function cancelExecQuery(qid) {
    _execCancelFlags[qid] = true;
    eel.cancel_query()();
    var btnExe = document.getElementById('btn_exe_'+qid);
    if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
    var resultsDiv = document.getElementById('qr_'+qid);
    if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:10px;color:#f39c12;">⏸ 查询已取消</div>';
}

// 查询结果编辑状态（按 qid）
var _queryEditStates = {};

/** 获取查询结果编辑状态 */
function _qState(qid) {
    if (!_queryEditStates[qid]) {
        _queryEditStates[qid] = { columns: [], rows: [], changedCells: {}, selectedRows: {}, editing: false, connData: null, execDb: '' };
    }
    return _queryEditStates[qid];
}

/** 同步查询 tab 内容到 objectTabs（解决切换 tab 数据丢失问题） */
function _syncQueryContent(qid) {
    var layout = document.getElementById('ql_' + qid);
    if (!layout) return;
    var tab = objectTabs.find(function(t){ return t.id === 'query_' + qid; });
    if (tab) {
        // 先保存 textarea 当前值（避免 innerHTML 取不到新值）
        var ta = document.getElementById('sq_' + qid);
        if (ta) {
            var oldContent = tab.content || '';
            // 替换 textarea 值
            var taRe = new RegExp('(<textarea[^>]*id="sq_' + qid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>)([\\s\\S]*?)(</textarea>)', 'i');
            if (taRe.test(oldContent)) {
                tab.content = oldContent.replace(taRe, '$1' + escapeHtml(ta.value) + '$3');
            }
        }
        // 再把整个 layout（含结果区域）的 HTML 同步进去
        // 注意：layout 外层不需要同步（它由 content 决定），只需确保 qr_{qid} 区域被保留
        var resultsDiv = document.getElementById('qr_' + qid);
        if (resultsDiv && tab.content) {
            // 把 resultsDiv 的 HTML 更新到 content 中对应的 id 部分
            var qrRe = new RegExp('(\\<div[^>]*id=["\']qr_' + qid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*\\>)[\\s\\S]*(?=\\</div\\>)', 'i');
            if (qrRe.test(tab.content)) {
                tab.content = tab.content.replace(qrRe, '$1' + resultsDiv.innerHTML + '</div>');
            }
        }
    }
}

/** 单元格失焦/回车时调用 */
function _qCellBlur(qid, rowIdx, colIdx, colName, inputEl) {
    if (!inputEl || inputEl.value === inputEl._oldVal) return;
    var es = _qState(qid);
    var key = rowIdx + ':' + colIdx;
    es.changedCells[key] = { rowIdx: rowIdx, colIdx: colIdx, colName: colName,
        oldVal: inputEl._oldVal, newVal: inputEl.value,
        origRow: es.rows[rowIdx], columns: es.columns };
    _qUpdateBtns(qid);
    es.editing = Object.keys(es.changedCells).length > 0;
}

/** 行选择变化 */
function _qRowSel(qid, rowIdx, checked) {
    var es = _qState(qid);
    if (checked) es.selectedRows[rowIdx] = true;
    else delete es.selectedRows[rowIdx];
    _qUpdateBtns(qid);
}

/** 全选/取消全选 */
function _qToggleSelAll(qid, checked) {
    var es = _qState(qid);
    for (var i = 0; i < es.rows.length; i++) {
        if (checked) es.selectedRows[i] = true;
        else delete es.selectedRows[i];
    }
    _qUpdateBtns(qid);
    // 更新所有行复选框
    var wrap = document.getElementById('qr_' + qid);
    if (wrap) {
        wrap.querySelectorAll('.row-sel-cb').forEach(function(cb){ cb.checked = checked; });
    }
}

/** 更新按钮状态 */
function _qUpdateBtns(qid) {
    var es = _qState(qid);
    var saveBtn = document.getElementById(qid + '_qsave_btn');
    var cancelBtn = document.getElementById(qid + '_qcancel_btn');
    var delBtn = document.getElementById(qid + '_qdel_btn');
    var cnt = Object.keys(es.changedCells).length;
    var selCnt = Object.keys(es.selectedRows).length;
    if (saveBtn) { saveBtn.textContent = '💾 保存' + (cnt ? ' ('+cnt+')' : ''); saveBtn.disabled = cnt === 0; }
    if (cancelBtn) cancelBtn.disabled = cnt === 0;
    if (delBtn) { delBtn.textContent = '🗑 删除' + (selCnt ? ' ('+selCnt+')' : ''); delBtn.disabled = selCnt === 0; }
    es.editing = cnt > 0;
}

/** 保存修改 */
function _qDoSave(qid) {
    var es = _qState(qid);
    var changes = [];
    for (var key in es.changedCells) {
        changes.push(es.changedCells[key]);
    }
    if (!changes.length) return;
    if (!es.connData) { showWarnDialog('提示', '连接信息丢失，请重新执行查询'); return; }

    var btn = document.getElementById(qid + '_qsave_btn');
    if (btn) { btn.textContent = '⏳ 保存中...'; btn.disabled = true; }

    eel.table_exec_save(es.connData, es.execDb, '', '', changes)(function(r){
        if (!r || !r.ok) {
            showWarnDialog('保存失败', r ? r.msg : '无响应');
            if (btn) { btn.textContent = '💾 保存'; btn.disabled = false; }
            return;
        }
        showOkDialog('保存成功', r.msg);
        es.changedCells = {};
        es.editing = false;
        _qUpdateBtns(qid);
        // 刷新数据（重新执行当前查询）
        _qRefreshData(qid);
    });
}

/** 取消修改 */
function _qCancelEdit(qid) {
    var es = _qState(qid);
    es.changedCells = {};
    es.editing = false;
    _qUpdateBtns(qid);
    // 重新渲染表格恢复原值
    _qRenderTable(qid);
}

/** 删除选中行 */
function _qDoDelete(qid) {
    var es = _qState(qid);
    var selIndices = Object.keys(es.selectedRows).map(Number).sort(function(a,b){return a-b;});
    if (!selIndices.length) return;
    if (!es.connData) { showWarnDialog('提示', '连接信息丢失'); return; }

    var rowsData = [];
    selIndices.forEach(function(oi) {
        var origRow = es.rows[oi];
        if (!origRow) return;
        rowsData.push({ origRow: origRow.map(function(v){ return v===null?'NULL':String(v); }), columns: es.columns });
    });

    eel.table_delete_rows(es.connData, es.execDb, '', '', rowsData)(function(r){
        if (!r || !r.ok) { showWarnDialog('删除失败', r?r.msg:'无响应'); return; }
        showConfirmDialog('确认删除',
            '<div style="max-height:300px;overflow:auto;background:#0d1117;padding:8px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;">' + escapeHtml(r.sql||'') + '</div>' +
            '<div style="margin-top:6px;color:#e74c3c;font-size:11px;">⚠ 将删除 ' + r.count + ' 行数据</div>',
            function(){
                eel.table_exec_delete(es.connData, es.execDb, '', '', rowsData)(function(r2){
                    if (!r2 || !r2.ok) { showWarnDialog('执行失败', r2?r2.msg:'无响应'); return; }
                    showOkDialog('删除成功', r2.msg);
                    es.selectedRows = {};
                    _qUpdateBtns(qid);
                    _qRefreshData(qid);
                });
            }
        );
    });
}

/** 刷新数据：重新执行查询 */
function _qRefreshData(qid) {
    var es = _qState(qid);
    var sqlEl = document.getElementById('sq_'+qid);
    if (!sqlEl) return;
    var fullSql = sqlEl.value;
    var sel = '';
    if (sqlEl) {
        var st = sqlEl.selectionStart, en = sqlEl.selectionEnd;
        if (st !== en) sel = sqlEl.value.substring(st, en).trim();
    }
    var sqlToExec = sel || fullSql;
    var resultsDiv = document.getElementById('qr_'+qid);
    if (!resultsDiv) return;

    resultsDiv.innerHTML = '<div style="padding:10px;color:#999;">🔄 正在刷新...</div>';
    var data = {src_host:es.connData.host, src_port:es.connData.port, src_user:es.connData.user,
        src_pwd:es.connData.pwd, src_db:es.execDb, db_type:es.connData.db_type||'mysql'};
    eel.execute_sql_query(sqlToExec, data)(function(result){
        if (!result || !result.ok) {
            resultsDiv.innerHTML = '<div style="padding:10px;color:#e74c3c;">❌ '+(result?result.msg:'无响应')+'</div>';
            return;
        }
        var stmts = sqlToExec.split(';').filter(function(s){return s.trim();});
        renderQueryResults(resultsDiv, [result], 1, stmts);
    });
}

/** 渲染可编辑表格（从已有状态） */
function _qRenderTable(qid) {
    var es = _qState(qid);
    var div = document.getElementById('qr_' + qid);
    if (!div || !es.columns.length) return;
    var rc = es.rows.length;
    var html = '';
    html += '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:#111;border-bottom:1px solid #333;flex-wrap:wrap;">' +
        '<button class="btn btn-sm" id="'+qid+'_qsave_btn" onclick="_qDoSave(\''+qid+'\')" disabled style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存 (0)</button>' +
        '<button class="btn btn-sm" id="'+qid+'_qcancel_btn" onclick="_qCancelEdit(\''+qid+'\')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">↩ 取消修改</button>' +
        '<span style="flex:1;"></span>' +
        '<button class="btn btn-sm" id="'+qid+'_qdel_btn" onclick="_qDoDelete(\''+qid+'\')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">🗑 删除 (0)</button>' +
        '<span style="font-size:10px;color:#666;">双击单元格编辑 | 选中行可删除</span></div>';
    html += '<div style="padding:6px 12px;font-size:11px;color:#888;border-bottom:1px solid #333;">📊 查询结果 — ' + rc + ' 行</div>';

    html += '<div style="overflow:auto;"><table class="exp-table"><thead><tr>';
    html += '<th style="width:28px;text-align:center;"><input type="checkbox" id="'+qid+'_qsel_all" onchange="_qToggleSelAll(\x27'+qid+'\x27,this.checked)" title="全选/取消全选"></th>';
    es.columns.forEach(function(c){ html += '<th>'+escapeHtml(c)+'</th>'; });
    html += '</tr></thead><tbody>';

    var maxShow = Math.min(es.rows.length, 200);
    for (var i = 0; i < maxShow; i++) {
        var row = es.rows[i];
        var sc = es.selectedRows[i] ? ' checked' : '';
        html += '<tr data-row-idx="'+i+'">';
        html += '<td style="text-align:center;"><input type="checkbox" class="row-sel-cb" '+sc+' onchange="_qRowSel(\''+qid+'\','+i+',this.checked)"></td>';
                    row.forEach(function(v, ci){
            var val = v===null ? 'NULL' : String(v);
            html += '<td><input class="editable-cell" data-ri="'+i+'" data-ci="'+ci+'" data-col="'+escapeAttr(es.columns[ci])+'" value="'+escapeAttr(val)+'" onfocus="this._oldVal=this.value" onblur="_qCellBlur(\''+qid+'\','+i+','+ci+',\''+escapeAttr(es.columns[ci])+'\',this)" spellcheck="false" autocomplete="off"></td>';
        });
        html += '</tr>';
    }
    html += '</tbody></table></div>';
    if (es.rows.length > maxShow) {
        html += '<div style="padding:5px;color:#777;font-size:10px;">... 共 ' + es.rows.length + ' 行，显示前 ' + maxShow + ' 行</div>';
    }
    div.innerHTML = html;
    _qUpdateBtns(qid);
    _syncQueryContent(qid);
}

function renderQueryResults(div, results, total, stmtsArr) {
    var qid = div.id.replace(/^qr_/, '');
    var es = _qState(qid);
    es.connData = activeConnData ? JSON.parse(JSON.stringify(activeConnData)) : null;
    // 确定执行的数据库
    var curTab = objectTabs.find(function(t){return t.id==='query_'+qid;});
    var qdb = curTab ? curTab.db : '';
    var sqlText = (stmtsArr && stmtsArr.length) ? stmtsArr[0] : '';
    var detectDb = detectDbFromSql(sqlText);
    es.execDb = detectDb || qdb || (activeConnData ? activeConnData.db : '') || '';

    // 只有一个结果时直接展示（支持编辑）
    if (total <= 1) {
        var html = '';
        var r0 = results[0];
        if (!r0 || !r0.ok) {
            html += '<div style="padding:10px 12px;color:#e74c3c;font-size:12px;background:#2a1a1a;">❌ '+escapeHtml(r0?r0.msg:'无响应')+'</div>';
            es.columns = []; es.rows = [];
        } else {
            es.columns = r0.columns || [];
            es.rows = r0.rows || [];
            var rc = r0.total || 0;
            var hc = es.columns.length > 0;
            // 重置编辑状态
            es.changedCells = {};
            es.selectedRows = {};
            es.editing = false;

            if (hc) {
                html += '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:#111;border-bottom:1px solid #333;flex-wrap:wrap;">' +
                    '<button class="btn btn-sm" id="'+qid+'_qsave_btn" onclick="_qDoSave(\''+qid+'\')" disabled style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存 (0)</button>' +
                    '<button class="btn btn-sm" id="'+qid+'_qcancel_btn" onclick="_qCancelEdit(\''+qid+'\')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">↩ 取消修改</button>' +
                    '<span style="flex:1;"></span>' +
                    '<button class="btn btn-sm" id="'+qid+'_qdel_btn" onclick="_qDoDelete(\''+qid+'\')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">🗑 删除 (0)</button>' +
                    '<span style="font-size:10px;color:#666;">双击单元格编辑 | 选中行可删除</span></div>';
                html += '<div style="padding:6px 12px;font-size:11px;color:#888;border-bottom:1px solid #333;">📊 查询结果 — '+rc+' 行</div>';
                html += '<div style="overflow:auto;"><table class="exp-table"><thead><tr>';
                html += '<th style="width:28px;text-align:center;"><input type="checkbox" id="'+qid+'_qsel_all" onchange="_qToggleSelAll(\x27'+qid+'\x27,this.checked)" title="全选/取消全选"></th>';
                es.columns.forEach(function(c){ html += '<th>'+escapeHtml(c)+'</th>'; });
                html += '</tr></thead><tbody>';

                var maxShow = Math.min(es.rows.length, 200);
                for (var i = 0; i < maxShow; i++) {
                    var row = es.rows[i];
                    html += '<tr data-row-idx="'+i+'">';
                    html += '<td style="text-align:center;"><input type="checkbox" class="row-sel-cb" onchange="_qRowSel(\''+qid+'\','+i+',this.checked)"></td>';
                    row.forEach(function(v, ci){
                        var val = v===null ? 'NULL' : String(v);
                        html += '<td><input class="editable-cell" data-ri="'+i+'" data-ci="'+ci+'" data-col="'+escapeAttr(es.columns[ci])+'" value="'+escapeAttr(val)+'" onfocus="this._oldVal=this.value" onblur="_qCellBlur(\''+qid+'\','+i+','+ci+',\''+escapeAttr(es.columns[ci])+'\',this)" spellcheck="false" autocomplete="off"></td>';
                    });
                    html += '</tr>';
                }
                html += '</tbody></table></div>';
                if (es.rows.length > maxShow) {
                    html += '<div style="padding:5px;color:#777;font-size:10px;">... 共 ' + es.rows.length + ' 行，显示前 ' + maxShow + ' 行</div>';
                }
            } else {
                html += '<div style="padding:12px;color:#2ecc71;font-size:12px;">✅ 执行成功，无返回结果集</div>';
            }
        }
        div.innerHTML = html || '<div style="padding:20px;color:#666;text-align:center;">无结果</div>';
        _qUpdateBtns(qid);
        // ★ Issue 4: 同步内容到 objectTabs，切换 tab 后保留
        setTimeout(function(){ _syncQueryContent(qid); }, 50);
        return;
    }

    // 多条 SQL：Tab 切换展示（每页也支持编辑）
    var tid = 'qrtabs_' + Math.random().toString(36).slice(2,8);
    var html = '<div class="result-tabs" id="'+tid+'">';
    html += '<div class="result-tab-bar">';
    for (var i = 0; i < results.length; i++) {
        var rr = results[i];
        var label = '语句' + (i+1);
        var count = '';
        if (rr && rr.ok) {
            count = ' ('+(rr.total||0)+'行)';
            var s = (stmtsArr||[])[i] || '';
            var shortSql = s.replace(/\s+/g,' ').trim().substring(0, 30);
            if (shortSql) label = shortSql;
        } else if (!rr || !rr.ok) {
            count = ' ❌';
        }
        html += '<button class="result-tab-btn'+(i===0?' active':'')+'" onclick="switchResultTab(\''+tid+'\','+i+')">'+escapeHtml(label)+count+'</button>';
    }
    html += '</div>';
    html += '<div class="result-tab-content">';
    for (var i2 = 0; i2 < results.length; i2++) {
        var r2 = results[i2];
        var tabBody = '';
        if (!r2 || !r2.ok) {
            tabBody = '<div style="padding:12px;color:#e74c3c;">❌ '+escapeHtml(r2?r2.msg:'无响应')+'</div>';
        } else {
            var rc2 = r2.total || 0;
            if ((r2.columns||[]).length > 0) {
                // 多结果也用可编辑模式
                var cols2 = r2.columns||[];
                var rows2 = r2.rows||[];
                tabBody = '<div style="display:flex;align-items:center;gap:6px;padding:4px 6px;background:#111;border-bottom:1px solid #333;flex-wrap:wrap;">' +
                    '<button class="btn btn-sm" onclick="_qDoSaveMulti(\''+qid+'\','+i2+')" style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存修改</button>' +
                    '<span style="font-size:10px;color:#666;">编辑后点击保存</span></div>' +
                    '<div style="overflow:auto;"><table class="exp-table"><thead><tr>';
                cols2.forEach(function(c){ tabBody += '<th>'+escapeHtml(c)+'</th>'; });
                tabBody += '</tr></thead><tbody>';
                var mMax = Math.min(rows2.length, 200);
                for (var mi = 0; mi < mMax; mi++) {
                    var mr = rows2[mi];
                    tabBody += '<tr>'; mr.forEach(function(mv,mci){
                        var mval = mv===null?'NULL':String(mv);
                        tabBody += '<td><input class="editable-cell" value="'+escapeAttr(mval)+'" spellcheck="false" autocomplete="off" style="min-width:60px;"></td>';
                    }); tabBody += '</tr>';
                }
                tabBody += '</tbody></table></div>';
                if (rows2.length > mMax) tabBody += '<div style="padding:5px;color:#777;font-size:10px;">... 共 '+rows2.length+' 行</div>';
            } else {
                tabBody = '<div style="padding:12px;color:#2ecc71;">✅ 执行成功，无返回结果集</div>';
            }
        }
        html += '<div class="result-tab-pane'+(i2===0?' active':'')+'" data-ri="'+i2+'">'+tabBody+'</div>';
    }
    html += '</div></div>';
    div.innerHTML = html;
    // 多结果也同步
    setTimeout(function(){ _syncQueryContent(qid); }, 50);
}

/** 多语句结果的保存（收集当前 tab 的编辑值） */
function _qDoSaveMulti(qid, resultIdx) {
    var es = _qState(qid);
    if (!es.connData) { showWarnDialog('提示', '连接信息丢失'); return; }
    // 从对应 tab-pane 收集所有 input 值
    var pane = document.querySelector('#qr_' + qid + ' .result-tab-pane[data-ri="'+resultIdx+'"]');
    if (!pane) return;
    var inputs = pane.querySelectorAll('.editable-cell.changed');
    if (!inputs.length) {
        showWarnDialog('提示', '没有检测到修改'); return;
    }
    showWarnDialog('提示', '多语句结果集暂不支持直接保存，建议对单表执行 SELECT 后再编辑保存');
}

// 切换结果 Tab
function switchResultTab(containerId, index) {
    var ct = document.getElementById(containerId);
    if (!ct) return;
    ct.querySelectorAll('.result-tab-btn').forEach(function(b,i){ b.classList.toggle('active', i===index); });
    ct.querySelectorAll('.result-tab-pane').forEach(function(p,i){ p.classList.toggle('active', i===index); });
}

// ==================== 工具函数 ====================
function loadCategoryItems(conn, db, cat, callback, schema) {
    var sch = schema || '';
    if (cat === 'tables') eel.db_explore_get_tables(conn,db,sch)(function(r){callback(r&&r.ok?(r.tables||[]):[]);});
    else if (cat === 'views') eel.db_explore_get_views(conn,db,sch)(function(r){callback(r&&r.ok?(r.views||[]).map(function(v){return{name:v};}):[]);});
    else if (cat === 'procedures') eel.db_explore_get_procedures(conn,db,sch)(function(r){callback(r&&r.ok?(r.procedures||[]).filter(function(p){return p.type==='PROCEDURE';}):[]);});
    else if (cat === 'functions') eel.db_explore_get_procedures(conn,db,sch)(function(r){callback(r&&r.ok?(r.procedures||[]).filter(function(p){return p.type==='FUNCTION';}):[]);});
    else callback([]);
}

function toggleDbChildren(dbId, arrowId) {
    var el = document.getElementById(dbId);
    var ar = document.getElementById(arrowId);
    if (!el) return;
    var iconEl = el.previousElementSibling ? el.previousElementSibling.querySelector('.db-icon') : null;
    if (el.classList.contains('open')) {
        el.classList.remove('open');
        if (ar) { ar.textContent = '▸'; ar.style.visibility = 'hidden'; }
        if (iconEl) { iconEl.classList.remove('active'); iconEl.classList.add('closed'); }
    } else {
        el.classList.add('open');
        if (ar) { ar.textContent = '▾'; ar.style.visibility = 'visible'; }
        if (iconEl) { iconEl.classList.remove('closed'); iconEl.classList.add('active'); }
    }
}

function toggleConnChildren(cid) {
    var children = document.getElementById('mc_c_' + cid);
    var arrow = document.getElementById('ma_c_' + cid);
    if (!children) return;
    var connIcon = arrow ? arrow.parentElement.querySelector('.db-icon') : null;
    if (children.classList.contains('open')) {
        children.classList.remove('open');
        if (arrow) { arrow.textContent = '▸'; arrow.style.visibility = 'hidden'; }
        if (connIcon) { connIcon.classList.remove('active'); connIcon.classList.add('closed'); }
    } else {
        children.classList.add('open');
        if (arrow) { arrow.textContent = '▾'; arrow.style.visibility = 'visible'; }
        if (connIcon) { connIcon.classList.remove('closed'); connIcon.classList.add('active'); }
    }
}

function toggleChildren(childrenId, arrowId) {
    var el = document.getElementById(childrenId);
    var ar = document.getElementById(arrowId);
    if (!el) return;
    if (el.classList.contains('open')) { el.classList.remove('open'); if(ar)ar.textContent='▸'; }
    else { el.classList.add('open'); if(ar)ar.textContent='▾'; }
}

// Redis DB 节点：仅折叠/展开（不加载数据）
// ==================== Redis 键分组 → 右侧面板 ====================
function clickRedisKeysGroup(cid, dbIdx, dbId) {
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) return;
    var cache = _redisKeysCache[dbId];
    if (!cache || !cache.keys) return;

    activeConnId = cid;
    activeConnData = conn;
    activeDatabase = 'DB' + dbIdx;
    activeCatId = null;

    var keys = cache.keys;
    var total = cache.total;
    var displayKeys = keys.slice(0, 100);
    // 记录刷新时间
    if (!cache.refreshTime) cache.refreshTime = new Date();

    // 构建工具栏 + 表格
    var content = buildRedisKeyListContent(cid, dbIdx, dbId, displayKeys, total, keys.length < total, cache);
    var home = objectTabs.find(function(t) { return t.id === 'obj_home'; });
    if (home) home.content = content;
    else objectTabs.unshift({ id: 'obj_home', label: '对象', type: 'home', content: content });
    activeObjTab = 'obj_home';

    // 记录 Redis 面板上下文（供搜索用）
    _redisPanelCtx = { cid: cid, dbIdx: dbIdx, dbId: dbId };

    renderObjectPanel();

    // 异步加载 key 元数据（类型/TTL/大小/值预览）
    redisLoadKeysMeta(cid, dbIdx, dbId, displayKeys);
}

// 异步批量加载键元数据并更新表格
function redisLoadKeysMeta(cid, dbIdx, dbId, keys) {
    if (!keys || !keys.length) return;
    eel.redis_get_keys_meta(activeConnData, keys, dbIdx)(function(r) {
        if (!r || !r.ok) return;
        var cache = _redisKeysCache[dbId];
        if (cache) cache._meta = r.meta;
        var panelId = 'rkl_' + dbId;
        var rows = document.querySelectorAll('#'+panelId+'_tbl tbody tr');
        rows.forEach(function(row){
            var k = row.getAttribute('data-key');
            var m = r.meta[k];
            if (!m) return;
            row.setAttribute('data-type', m.type || '');
            // 更新各单元格
            var cells = row.querySelectorAll('td');
            if (cells[1]) {  // 类型列
                var tl = (m.type||'').toUpperCase();
                var tc = tl==='STRING'?'#2ecc71':tl==='HASH'?'#f39c12':tl==='LIST'?'#3498db':tl==='SET'?'#e74c3c':tl==='ZSET'?'#9b59b6':'#888';
                cells[1].innerHTML = '<span style="color:'+tc+';font-weight:bold;font-size:11px;">'+(tl||'-')+'</span>';
            }
            if (cells[2]) {  // 值预览列（保持空白，等后续优化）
                cells[2].innerHTML = '<span style="color:#aaa;font-size:11px;">-</span>';
            }
            if (cells[3]) cells[3].textContent = m.size_str || '-';
            if (cells[4]) cells[4].textContent = m.ttl_str || '-';
        });
    });
}

// 构建 Redis 键列表的 HTML 内容
function buildRedisKeyListContent(cid, dbIdx, dbId, keys, total, hasMore, cache) {
    var panelId = 'rkl_' + dbId;

    // 工具栏
    var toolbar = '<div class="redis-kl-toolbar" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #333;flex-shrink:0;flex-wrap:wrap;">' +
        '<select id="'+panelId+'_typeFilter" onchange="redisKLFilter(\''+cid+'\','+dbIdx+',\''+dbId+'\')" style="height:26px;background:#1a1a1a;border:1px solid #444;color:#e0e0e0;border-radius:3px;font-size:11px;outline:none;padding:0 4px;">' +
        '<option value="">所有类型</option>' +
        '<option value="string">String</option>' +
        '<option value="hash">Hash</option>' +
        '<option value="list">List</option>' +
        '<option value="set">Set</option>' +
        '<option value="zset">ZSet</option></select>' +
        '<input type="text" id="'+panelId+'_kw" placeholder="🔍 键包含..." value="" ' +
            'style="height:26px;background:#1a1a1a;border:1px solid #444;color:#e0e0e0;border-radius:3px;font-size:11px;outline:none;padding:0 8px;min-width:140px;flex:1;" ' +
            'onkeydown="if(event.key===\'Enter\')redisKLFilter(\''+cid+'\','+dbIdx+',\''+dbId+'\')">' +
        '<button class="btn btn-sm" onclick="redisKLFilter(\''+cid+'\','+dbIdx+',\''+dbId+'\')" style="height:26px;padding:2px 10px;">筛选</button>';

    // 右侧操作按钮区
    var elapsed = cache.refreshTime ? formatElapsed(cache.refreshTime) : '';
    toolbar += '<div style="margin-left:auto;display:flex;align-items:center;gap:8px;color:#888;font-size:11px;">' +
        '<span id="'+panelId+'_elapsed">上次刷新时间: '+elapsed+'</span> ' +
        '<button class="btn btn-sm" onclick="redisKLRefresh(\''+cid+'\','+dbIdx+',\''+dbId+'\')" style="height:24px;padding:2px 8px;" title="刷新列表">⟳ 刷新</button> ' +
        (hasMore ? '<button class="btn btn-sm" onclick="redisKLLoadMore(\''+cid+'\','+dbIdx+',\''+dbId+'\')" style="height:24px;padding:2px 8px;" title="获取更多">⬇ 获取更多</button> ' : '') +
        '</div>';
    toolbar += '</div>';

    // 表格
    var table = '<div style="overflow:auto;flex:1;"><table class="exp-table redis-key-list-table" id="'+panelId+'_tbl">' +
        '<thead><tr><th style="width:30%;">键 ▾</th><th style="width:12%;">类型</th><th style="width:35%;">值</th><th style="width:9%;text-align:right;">大小</th><th style="width:14%;text-align:center;">TTL</th></tr></thead><tbody>';

    // 先用缓存中的元数据渲染，异步更新
    var metaCache = cache._meta || {};
    keys.forEach(function(k, i) {
        var m = metaCache[k] || {};
        var typeLabel = (m.type || '').toUpperCase();
        var typeColor = typeLabel === 'STRING' ? '#2ecc71' : typeLabel === 'HASH' ? '#f39c12' : typeLabel === 'LIST' ? '#3498db' : typeLabel === 'SET' ? '#e74c3c' : typeLabel === 'ZSET' ? '#9b59b6' : '#888';
        var valPreview = m.valPreview || '';
        table += '<tr class="redis-key-row" data-key="'+escapeAttr(k)+'" data-type="'+escapeAttr(m.type||'')+'"' +
            ' ondblclick="redisShowKey(\''+cid+'\',\''+escapeAttr(k)+'\','+dbIdx+')"' +
            ' oncontextmenu="event.stopPropagation();redisKeyCtx(event,\''+cid+'\',\''+escapeAttr(k)+'\','+dbIdx+')">' +
            '<td title="'+escapeAttr(k)+'"><span style="font-family:Consolas,monospace;font-size:11px;">'+escapeHtml(truncateStr(k,40))+'</span></td>' +
            '<td><span style="color:'+typeColor+';font-weight:bold;font-size:11px;">'+(typeLabel || '-')+'</span></td>' +
            '<td><span style="color:#aaa;font-size:11px;font-family:Consolas,monospace;" title="'+escapeHtml(valPreview)+'">'+escapeHtml(truncateStr(valPreview,50))+'</span></td>' +
            '<td style="text-align:right;color:#888;font-size:11px;">'+(m.size_str || '-')+'</td>' +
            '<td style="text-align:center;color:#888;font-size:11px;">'+(m.ttl_str || '-')+'</td></tr>';
    });
    table += '</tbody></table></div>';

    return toolbar + table;
}

// 格式化经过时间
function formatElapsed(date) {
    if (!date) return '';
    var diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 60) return diff + 's';
    if (diff < 3600) return Math.floor(diff/60) + 'm';
    return Math.floor(diff/3600) + 'h';
}

// 截断字符串
function truncateStr(s, max) {
    if (!s) return '';
    return s.length > max ? s.substring(0, max) + '…' : s;
}

// Redis 键列表筛选
function redisKLFilter(cid, dbIdx, dbId) {
    var panelId = 'rkl_' + dbId;
    var typeFilt = document.getElementById(panelId+'_typeFilter');
    var kwInput = document.getElementById(panelId+'_kw');
    var typeVal = typeFilt ? typeFilt.value : '';
    var kw = kwInput ? (kwInput.value || '').toLowerCase() : '';

    var rows = document.querySelectorAll('#'+panelId+'_tbl tbody tr');
    var visibleCount = 0;
    rows.forEach(function(row){
        var key = row.getAttribute('data-key') || '';
        var ktype = row.getAttribute('data-type') || '';
        var showType = !typeVal || ktype === typeVal;
        var showKw = !kw || key.toLowerCase().indexOf(kw) !== -1;
        var visible = showType && showKw;
        row.style.display = visible ? '' : 'none';
        if (visible) visibleCount++;
    });
}

// Redis 键列表刷新
function redisKLRefresh(cid, dbIdx, dbId) {
    var cache = _redisKeysCache[dbId];
    if (cache) cache.refreshTime = new Date();
    // 重新加载 key 列表（通过重新展开 DB 节点触发）
    var el = document.getElementById(dbId);
    if (el) { el.innerHTML = ''; el.classList.remove('open'); }
    expandRedisDb(cid, dbIdx, dbId, 16);
    clickRedisKeysGroup(cid, dbIdx, dbId);
}

// Redis 键列表加载更多
function redisKLLoadMore(cid, dbIdx, dbId) {
    // TODO: 增加已加载的 limit 并重新 scan
    alert('加载更多功能待实现');
}

function clickRedisQueries(cid, dbIdx) {
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) return;
    var dbName = 'DB' + dbIdx;
    activeConnId = cid; activeConnData = conn; activeDatabase = dbName;
    activeCatId = null;
    _redisPanelCtx = null;
    var queries = (treeData.saved_queries || []).filter(function(q) {
        return q.conn_id === cid && q.db === dbName;
    });
    var content = '<table class="exp-table"><thead><tr><th>名称</th></tr></thead><tbody>';
    queries.forEach(function(q) {
        content += '<tr ondblclick="openQueryInTab(\'' + q.id + '\')" oncontextmenu="queryCtx2(event,\'' + q.id + '\',\'' + cid + '\',\'\')">' +
            '<td>' + escapeHtml(q.name) + '</td></tr>';
    });
    content += '</tbody></table>';
    if (!queries.length) content += '<div style="padding:20px;color:#999;text-align:center;">（无查询）<br><button class="btn btn-sm" style="margin-top:8px;" onclick="addRedisQuery(\'' + cid + '\',' + dbIdx + ',\'' + dbName + '_queries\',16)">＋ 新建查询</button></div>';
    var home = objectTabs.find(function(t) { return t.id === 'obj_home'; });
    if (home) home.content = content;
    else objectTabs.unshift({id:'obj_home',label:'对象',type:'home',content:content});
    activeObjTab = 'obj_home';
    renderObjectPanel();
}

function toggleRedisDb(cid, dbIdx, dbId, pad) {
    var el = document.getElementById(dbId);
    var ar = document.getElementById('ar_'+dbId);
    if (!el) return;
    if (el.classList.contains('open')) {
        el.classList.remove('open');
        if (ar) ar.textContent = '▸';
        // 数据库图标回到关闭状态
        var connIcon = ar ? ar.parentElement.querySelector('.db-icon') : null;
        if (connIcon) { connIcon.classList.remove('active'); connIcon.classList.add('closed'); }
    } else {
        expandRedisDb(cid, dbIdx, dbId, pad);
    }
}

// ==================== Redis 查询文件夹 ====================
function toggleRedisQueries(cid, dbIdx, qId, pad) {
    var el = document.getElementById(qId);
    var ar = document.getElementById('ar_' + qId);
    if (!el) return;
    if (el.classList.contains('open')) {
        el.classList.remove('open');
        if (ar) ar.textContent = '▸';
        return;
    }
    el.classList.add('open');
    if (ar) ar.textContent = '▾';
    _renderRedisQueriesContent(el, cid, dbIdx, pad);
}

function addRedisQuery(cid, dbIdx, qId, pad) {
    showInputDialog('新建 Redis 查询', '名称：', function(n) {
        if (!n || !n.trim()) return;
        var dbName = 'DB' + dbIdx;
        eel.tree_save_query('', n.trim(), '', cid, dbName)(function(r) {
            if (r && r.ok) {
                var qc = treeData.saved_queries || [];
                qc.push({id: r.id, name: n.trim(), sql: '', conn_id: cid, db: dbName});
                // 如果查询文件夹已展开，刷新内容
                var el = document.getElementById(qId);
                if (el && el.classList.contains('open')) {
                    _renderRedisQueriesContent(el, cid, dbIdx, pad);
                }
                // 同时刷新右侧面板（如果正在展示查询列表）
                var home = objectTabs.find(function(t) { return t.id === 'obj_home'; });
                if (home) clickRedisQueries(cid, dbIdx);
            }
        });
    });
}

function _renderRedisQueriesContent(el, cid, dbIdx, pad) {
    var dbName = 'DB' + dbIdx;
    var queries = (treeData.saved_queries || []).filter(function(q) {
        return q.conn_id === cid && q.db === dbName;
    });
    var itemPad = pad + 20;
    var qId = el.id;
    el.innerHTML = queries.map(function(q) {
        return '<div class="my-conn-row" style="padding-left:' + itemPad + 'px;font-size:11px;" ' +
            'ondblclick="openQueryInTab(\'' + q.id + '\')" ' +
            'oncontextmenu="queryCtx2(event,\'' + q.id + '\',\'' + cid + '\',\'\')">' +
            '<span class="my-conn-icon">📄</span><span class="my-conn-name">' + escapeHtml(q.name) + '</span></div>';
    }).join('') + '<div class="my-conn-row" style="padding-left:' + itemPad + 'px;font-size:11px;color:#4fc3f7;" ' +
        'onclick="addRedisQuery(\'' + cid + '\',' + dbIdx + ',\'' + qId + '\',' + pad + ')">' +
        '<span class="my-conn-icon">➕</span><span class="my-conn-name">新建查询</span></div>';
}

// Redis DB 双击/展开 → 加载该 DB 下的 keys（按前缀分组 → 键 → 值）
function expandRedisDb(cid, dbIdx, dbId, pad) {
    var children = document.getElementById(dbId);
    var arrow = document.getElementById('ar_'+dbId);
    if (!children) return;
    // ★ 双击只展开（不折叠），折叠由箭头单独处理
    if (children.classList.contains('open')) {
        // 已展开，只高亮
        highlightRow(arrow ? arrow.parentElement : null);
        return;
    }
    children.innerHTML = '<div style="padding-left:'+(pad+16)+'px;color:#999;font-size:11px;">⏳ 加载 keys...</div>';
    children.classList.add('open');
    if (arrow) { arrow.textContent = '▾'; arrow.style.visibility = 'visible'; }
    var connIcon = arrow ? arrow.parentElement.querySelector('.db-icon') : null;
    if (connIcon) { connIcon.classList.remove('closed'); connIcon.classList.add('active'); }
    highlightRow(arrow ? arrow.parentElement : null);

    var conn = treeData.connections[cid];
    if (!conn) return;

    var timeoutId = setTimeout(function() {
        children.innerHTML = '<div style="padding-left:'+(pad+16)+'px;color:#e74c3c;font-size:11px;">❌ 加载超时（10秒）</div>';
    }, 10000);

    try {
        eel.redis_get_keys(conn, '*', 100, dbIdx)(function(r) {
            console.log('Redis keys回调 [DB'+dbIdx+']', r);
            clearTimeout(timeoutId);
            if (!r) { children.innerHTML = '<div style="padding-left:'+(pad+16)+'px;color:#e74c3c;font-size:11px;">❌ 返回null</div>'; return; }
            if (!r.ok) { children.innerHTML = '<div style="padding-left:'+(pad+16)+'px;color:#e74c3c;font-size:11px;">❌ '+escapeHtml(r.msg||'')+'</div>'; return; }
            // 缓存 keys 数据（供右侧面板和搜索使用）
            var allKeys = [];
            (r.groups||[]).forEach(function(g) { allKeys = allKeys.concat(g.keys); });
            _redisKeysCache[dbId] = { keys: allKeys, total: r.total, cid: cid, dbIdx: dbIdx };

            var html = '';
            html += '<div style="padding-left:'+(pad+16)+'px;color:#888;font-size:10px;padding-top:4px;padding-bottom:6px;">共 '+r.total+' 个 key</div>';
            (r.groups||[]).forEach(function(g) {
                var gId = dbId + '_rsg_' + safeBtoa(g.group);
                html += '<div class="tree-node"><div class="my-conn-row" style="padding-left:'+(pad+16)+'px" onclick="highlightRow(this);clickRedisKeysGroup(\''+cid+'\','+dbIdx+',\''+dbId+'\')">' +
                    '<span class="arrow" id="ar_'+gId+'" onclick="event.stopPropagation();toggleChildren(\''+gId+'\',\'ar_'+gId+'\')">▸</span><span class="my-conn-icon">📁</span><span class="my-conn-name">'+escapeHtml(g.group)+'</span>' +
                    '<span style="margin-left:auto;color:#888;font-size:10px;">'+g.keys.length+'</span></div>' +
                    '<div class="tree-children" id="'+gId+'">' +
                        g.keys.map(function(k){
                            return '<div class="my-conn-row drag-table-item" style="padding-left:'+(pad+32)+'px" ondblclick="redisShowKey(\''+cid+'\',\''+escapeAttr(k)+'\','+dbIdx+')">' +
                                '<span class="my-conn-icon">🔑</span><span class="my-conn-name" style="font-size:11px;">'+escapeHtml(k)+'</span></div>';
                        }).join('') +
                    '</div></div>';
            });
            // ★ 查询文件夹
            var qId = dbId + '_queries';
            html += '<div class="tree-node"><div class="my-conn-row" style="padding-left:'+(pad+16)+'px" ' +
                'onclick="highlightRow(this);clickRedisQueries(\''+cid+'\','+dbIdx+')"' +
                'oncontextmenu="event.stopPropagation();addRedisQuery(\''+cid+'\','+dbIdx+',\''+qId+'\','+(pad+16)+')">' +
                '<span class="arrow" id="ar_'+qId+'" onclick="event.stopPropagation();toggleRedisQueries(\''+cid+'\','+dbIdx+',\''+qId+'\','+(pad+16)+')">▸</span><span class="my-conn-icon">📋</span>' +
                '<span class="my-conn-name">查询</span></div>' +
                '<div class="tree-children" id="'+qId+'"></div></div>';
            children.innerHTML = html || '<div style="padding-left:'+(pad+16)+'px;color:#999;font-size:11px;">（无 key）</div>';
        });
    } catch (err) {
        console.error('expandRedisDb异常:', err);
        children.innerHTML = '<div style="padding-left:'+(pad+16)+'px;color:#e74c3c;font-size:11px;">❌ JS异常: '+escapeHtml(err.message)+'</div>';
    }
}

// 点击数据库名：设置连接上下文 + 清空对象面板 + 展开/折叠分类
function selectDatabase(cid, db, dbId, arrowId) {
    _redisPanelCtx = null;
    if (treeData && treeData.connections && treeData.connections[cid]) {
        activeConnId = cid;
        activeConnData = treeData.connections[cid];
    }
    activeDatabase = db;
    activeCatId = null;
    // ★ 切换到 home tab，不清空已有 tab
    var homeContent = '<div style="padding:40px;text-align:center;color:#666;"><div style="font-size:36px;margin-bottom:10px;">📄</div><div>点击表、视图等分类查看对象</div></div>';
    var homeTab = objectTabs.find(function(t){return t.id==='obj_home';});
    if (!homeTab) { objectTabs.push({id:'obj_home',label:'对象',type:'home',content:homeContent,db:''}); }
    else { homeTab.content = homeContent; }
    activeObjTab = 'obj_home';
    renderObjectPanel();

    var el = document.getElementById(dbId);
    var ar = document.getElementById(arrowId);
    if (!el) return;

    // 高亮数据库行
    highlightRow(el.previousElementSibling);

    // 切换图标颜色：展开变绿，折叠变灰（双击只展开不折叠，折叠由箭头处理）
    var iconEl = el.previousElementSibling ? el.previousElementSibling.querySelector('.db-icon') : null;
    if (el.classList.contains('open')) {
        // 已展开：双击不高亮也不折叠
        return;
    }
    el.classList.add('open');
    if (ar) { ar.textContent = '▾'; ar.style.visibility = 'visible'; }
    if (iconEl) { iconEl.classList.remove('closed'); iconEl.classList.add('active'); }

    // PostgreSQL：展开数据库时加载架构列表
    var isPg = activeConnData && activeConnData.db_type === 'postgresql';
    if (isPg && !el.innerHTML.trim()) {
        var dbPad = parseInt(el.previousElementSibling ? (el.previousElementSibling.style.paddingLeft || '0') : '0') || 40;
        el.innerHTML = '<div style="padding-left:'+(dbPad+20)+'px;color:#999;font-size:11px;">⏳ 加载架构...</div>';
        eel.db_explore_get_schemas(activeConnData, db)(function (r) {
            if (!r || !r.ok) { el.innerHTML = '<div style="padding-left:'+(dbPad+20)+'px;color:#e74c3c;font-size:11px;">❌</div>'; return; }
            var pad = dbPad;
            var html = '';
            r.schemas.forEach(function (sch) {
                var sk = safeBtoa(db+'/'+sch);
                var schId = cid + '_sch_' + sk;
                html += '<div class="tree-node"><div class="my-conn-row" style="padding-left:'+(pad+20)+'px" onclick="highlightRow(this)">' +
                    '<span class="arrow" id="ar_'+schId+'" onclick="event.stopPropagation();toggleChildren(\''+schId+'\',\'ar_'+schId+'\')">▸</span><span class="my-conn-icon">📂</span><span class="my-conn-name">'+escapeHtml(sch)+'</span></div>' +
                    '<div class="tree-children" id="'+schId+'">' + renderDbCats(cid, db, pad+40, sch) + '</div></div>';
            });
            el.innerHTML = html || '<div style="padding-left:'+(pad+20)+'px;color:#999;font-size:11px;">（无架构）</div>';
        });
    }
}

// ==================== 局部 DOM 操作（不重新渲染整个树） ====================
function addConnToTree(c) {
    var pid = c.parent || '';
    var indent = pid ? getFolderDepth(pid) * 16 + 16 : 0;
    var html = renderConn(c, indent);
    if (pid) {
        var container = document.getElementById('mc_' + pid);
        if (container) {
            // 如果文件夹未展开则先展开
            if (!container.classList.contains('open')) {
                container.classList.add('open');
                var arr = document.getElementById('ma_' + pid);
                if (arr) { arr.textContent = '▾'; arr.style.visibility = 'visible'; }
            } else {
                var arr = document.getElementById('ma_' + pid);
                if (arr) arr.style.visibility = 'visible';
            }
            container.insertAdjacentHTML('beforeend', html);
        } else {
            document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', renderConn(c, 0));
        }
    } else {
        document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', html);
    }
}

function updateConnNode(cid, c) {
    var node = document.querySelector('.tree-node[data-cid="' + cid + '"]');
    if (!node) return;
    var nameEl = node.querySelector('.my-conn-name');
    var hostEl = node.querySelector('.my-conn-host');
    var iconEl = node.querySelector('.my-conn-icon.db-icon');
    if (nameEl) nameEl.textContent = c.name || '';
    if (hostEl) hostEl.textContent = (c.host || '') + ':' + (c.port || '3306');
    if (iconEl) {
        iconEl.innerHTML = getConnIcon(c.db_type || 'mysql');
        // 保持图标颜色状态
        var children2 = document.getElementById('mc_c_' + cid);
        if (children2 && children2.classList.contains('open')) {
            iconEl.classList.remove('closed'); iconEl.classList.add('active');
        } else {
            iconEl.classList.remove('active'); iconEl.classList.add('closed');
        }
    }
}

function removeConnNode(cid) {
    var node = document.querySelector('.tree-node[data-cid="' + cid + '"]');
    if (node) node.remove();
}
function removeFolderNode(fid) {
    var node = document.querySelector('.tree-node[data-fid="' + fid + '"]');
    if (node) node.remove();
}

function addFolderToTree(f) {
    // 计算文件夹的缩进深度（从父级推算）
    function getFolderDepth(fid) {
        var depth = 0;
        var cur = fid;
        while (cur) {
            var p = (treeData.folders || []).find(function(x){return x.id===cur;});
            if (p && p.parent) { depth++; cur = p.parent; }
            else break;
        }
        return depth;
    }
    var depth = f.parent ? getFolderDepth(f.parent) + 1 : 0;
    var indent = depth * 16;

    if (f.parent) {
        // 子文件夹：插入到父文件夹的 tree-children 容器中
        var parentChildren = document.getElementById('mc_' + f.parent);
        if (parentChildren) {
            parentChildren.insertAdjacentHTML('beforeend', renderFolder(f, indent));
            // 展开父文件夹
            parentChildren.classList.add('open');
            var parentArrow = document.getElementById('ma_' + f.parent);
            if (parentArrow) { parentArrow.textContent = '▾'; }
        } else {
            // 如果父容器的子容器还没渲染，回退到列表末尾
            document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', renderFolder(f, indent));
        }
    } else {
        // 根级文件夹：直接插入列表
        document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', renderFolder(f, indent));
    }
}

function updateFolderNode(fid, name) {
    var node = document.querySelector('.tree-node[data-fid="' + fid + '"]');
    if (!node) return;
    var nameEl = node.querySelector('.my-conn-name');
    if (nameEl) nameEl.textContent = name;
}

// ==================== 拖拽复制表 ====================
var _dragInfo = null; // {table_name, src_db, schema, src_cid}
// ==================== 拖拽移动连接 ====================
var _connDragInfo = null; // {cid, fromParent} — 当前正在拖拽的连接

// 全局清理：确保拖拽结束不残留状态
document.addEventListener('dragend', function(e) {
    var el = e.target;
    if (el.classList && el.classList.contains('drag-table-item')) {
        el.classList.remove('dragging');
    }
    // 清理对象窗口残留的高亮
    var panel = document.getElementById('object_panel');
    if (panel) panel.classList.remove('drop-target');
    _dragInfo = null;
});

function onTableDragStart(e, tn, db, schema, cid) {
    _dragInfo = { table_name: tn, src_db: db, schema: schema || '', src_cid: cid };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', tn);
}

function onTableDragEnd(e) {
    var el = e.target;
    if (el) el.classList.remove('dragging');
    _dragInfo = null;
}

function onDbDragOver(e, el, cid, db) {
    if (!_dragInfo) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-target');
}

function onDbDragLeave(e, el) {
    el.classList.remove('drop-target');
}

function onDbDrop(e, el, targetCid, targetDb) {
    e.preventDefault();
    el.classList.remove('drop-target');
    if (!_dragInfo) return;

    var src = _dragInfo;
    var srcCid = src.src_cid;
    var srcConn = treeData && treeData.connections ? treeData.connections[srcCid] : null;
    var dstConn = treeData && treeData.connections ? treeData.connections[targetCid] : null;

    if (!srcConn || !dstConn) { showWarnDialog('提示', '无法获取连接信息'); _dragInfo = null; return; }

    // 弹出选择框：仅结构 或 结构+数据
    showDragCopyDialog(src.table_name, src.src_db, src.schema, srcConn, targetCid, targetDb, dstConn);
    _dragInfo = null;
}

// 拖拽表到表文件夹节点（与 onDbDrop 类似，但走文件夹参数）
function onTableFolderDrop(e, el, targetCid, targetDb, targetSchema) {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-target');
    if (!_dragInfo) return;

    var src = _dragInfo;
    // 禁止同步到自身所在库
    if (src.src_cid === targetCid && src.src_db === targetDb) {
        showWarnDialog('提示', '不能将表同步到自身所在库');
        _dragInfo = null; return;
    }
    var srcConn = treeData && treeData.connections ? treeData.connections[src.src_cid] : null;
    var dstConn = treeData && treeData.connections ? treeData.connections[targetCid] : null;

    if (!srcConn || !dstConn) { showWarnDialog('提示', '无法获取连接信息'); _dragInfo = null; return; }

    showDragCopyDialog(src.table_name, src.src_db, src.schema, srcConn, targetCid, targetDb, dstConn);
    _dragInfo = null;
}

function showDragCopyDialog(tn, srcDb, schema, srcConn, targetCid, targetDb, dstConn) {
    document.getElementById('modal_icon').innerHTML = '📋';
    document.getElementById('modal_title').textContent = '复制表：' + tn;
    document.getElementById('modal_msg').innerHTML = '<div>从：<b>' + escapeHtml(srcConn.name||srcConn.host) + '</b> / ' + escapeHtml(srcDb) + '</div><div style="margin-top:4px;">到：<b>' + escapeHtml(dstConn.name||dstConn.host) + '</b> / ' + escapeHtml(targetDb) + '</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-blue" style="font-size:12px;" onclick="startDragCopy2(false)">📐 仅表结构</button><button class="btn btn-green" style="font-size:12px;" onclick="startDragCopy2(true)">📊 结构 + 数据</button>';
    document.getElementById('modal_overlay').classList.add('show');

    window.startDragCopy2 = function(copyData) {
        document.getElementById('modal_icon').innerHTML = '⏳';
        document.getElementById('modal_title').textContent = '复制中...';
        document.getElementById('modal_msg').innerHTML = '<div class="progress-bar" style="margin:8px 0;height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden;"><div id="drag_copy_bar" class="progress-fill" style="width:0%;height:100%;background:#4CAF50;border-radius:4px;transition:width 0.3s;"></div></div><div id="drag_copy_status" style="font-size:11px;color:#888;">正在连接...</div><button class="btn btn-sm" style="margin-top:8px;background:#e74c3c;color:#fff;font-size:10px;" onclick="cancelDragCopy()">⏹ 取消</button>';
        document.getElementById('modal_btns').innerHTML = '';

        var done = false;
        window._dragCopyDone = function() { done = true; };
        window.cancelDragCopy = function() {
            if (done) return;
            done = true;
            eel.cancel_query()();
            document.getElementById('modal_overlay').classList.remove('show');
        };

        // 轮询进度（每 200ms）
        var lastProgress = -1;
        var lastProgressTime = Date.now();
        var pollTimer = setInterval(function() {
            if (done) { clearInterval(pollTimer); return; }
            eel.poll_queue()(function(msgs) {
                if (done || !msgs) return;
                for (var i = 0; i < msgs.length; i++) {
                    var m = msgs[i];
                    if (m && m[0] === 'drag_progress') {
                        var d = m[1];
                        var bar = document.getElementById('drag_copy_bar');
                        var st = document.getElementById('drag_copy_status');
                        if (bar && d.percent !== undefined) {
                            bar.style.width = d.percent + '%';
                            if (d.percent !== lastProgress) {
                                lastProgress = d.percent;
                                lastProgressTime = Date.now();
                            }
                        }
                        if (st && d.status) st.textContent = d.status;
                    }
                }
            });
            // 卡住检测：进度超过 30 秒没变化则超时
            if (!done && lastProgress >= 0 && (Date.now() - lastProgressTime) > 30000) {
                done = true;
                clearInterval(pollTimer);
                document.getElementById('modal_overlay').classList.remove('show');
                showErrorDialog('复制超时', '进度超过30秒未更新，可能连接已断开');
            }
        }, 200);

        eel.drag_copy_table(srcConn, srcDb, tn, dstConn, targetDb, copyData)(function(r) {
            if (done) return;
            done = true;
            clearInterval(pollTimer);
            // 确保进度条到 100%
            var bar = document.getElementById('drag_copy_bar');
            var st = document.getElementById('drag_copy_status');
            if (bar) bar.style.width = '100%';
            if (st) st.textContent = r && r.ok ? '✅ 完成' : '❌ 失败';
            setTimeout(function() {
                document.getElementById('modal_overlay').classList.remove('show');
                if (r && r.ok) {
                    showOkDialog('复制成功', r.msg);
                    setTimeout(function(){ refreshTableFolder(targetCid, targetDb, ''); }, 500);
                } else {
                    showErrorDialog('复制失败', r ? r.msg : '无响应');
                }
            }, 400);
        });
    };
}

function execDragCopy(tn, srcDb, schema, srcConn, targetCid, targetDb, dstConn, copyData) {
    // 兼容旧调用，实际由 startDragCopy2 处理
    showDragCopyDialog(tn, srcDb, schema, srcConn, targetCid, targetDb, dstConn);
}

// ==================== 拖拽移动连接到文件夹 ====================
function onConnDragStart(e, cid) {
    var c = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!c) return;
    _connDragInfo = { cid: cid, fromParent: c.parent || '' };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cid);
    // 视觉反馈
    var el = e.target;
    setTimeout(function(){ if(el) el.style.opacity = '0.5'; }, 0);
}

function onConnDragEnd(e, cid) {
    var el = e.target;
    if (el) el.style.opacity = '';
    // 清理所有文件夹高亮
    var allFolders = document.querySelectorAll('.drop-folder.drop-target');
    for (var i = 0; i < allFolders.length; i++) { allFolders[i].classList.remove('drop-target'); }
    var root = document.getElementById('my_conn_list');
    if (root) root.classList.remove('drop-target');
    _connDragInfo = null;
}

function onConnFolderDragOver(e, el, fid) {
    if (!_connDragInfo) return;
    e.preventDefault();
    e.stopPropagation();
    // 不能拖到自己当前所在文件夹
    if (_connDragInfo.fromParent === fid) {
        e.dataTransfer.dropEffect = 'none';
        return;
    }
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
}

function onConnFolderDragLeave(e, el) {
    el.classList.remove('drop-target');
}

function onConnFolderDrop(e, fid) {
    e.preventDefault();
    e.stopPropagation();
    if (!_connDragInfo) return;
    var cid = _connDragInfo.cid;
    // 清理高亮
    var allFolders = document.querySelectorAll('.drop-folder.drop-target');
    for (var i = 0; i < allFolders.length; i++) { allFolders[i].classList.remove('drop-target'); }

    // 不能拖到自己当前所在文件夹
    if (_connDragInfo.fromParent === fid) {
        _connDragInfo = null;
        return;
    }

    eel.tree_move_connection(cid, fid)(function(r){
        if (r && r.ok) {
            // 更新内存数据
            treeData.connections[cid].parent = fid;
            // DOM 移动
            moveConnNode(cid, fid);
        } else {
            showErrorDialog('移动失败', r ? r.msg : '操作失败');
        }
    });
    _connDragInfo = null;
}

// 拖到根区域（移出所有文件夹）
function onConnRootDragOver(e) {
    if (!_connDragInfo) return;
    e.preventDefault();
    // 不能从根拖到根
    if (!_connDragInfo.fromParent) {
        e.dataTransfer.dropEffect = 'none';
        return;
    }
    e.dataTransfer.dropEffect = 'move';
    document.getElementById('my_conn_list').classList.add('drop-target');
}

function onConnRootDragLeave(e) {
    document.getElementById('my_conn_list').classList.remove('drop-target');
}

function onConnRootDrop(e) {
    e.preventDefault();
    if (!_connDragInfo) return;
    var cid = _connDragInfo.cid;
    document.getElementById('my_conn_list').classList.remove('drop-target');

    if (!_connDragInfo.fromParent) {
        _connDragInfo = null;
        return;
    }

    eel.tree_move_connection(cid, '')(function(r){
        if (r && r.ok) {
            treeData.connections[cid].parent = '';
            moveConnNode(cid, '');
        } else {
            showErrorDialog('移动失败', r ? r.msg : '操作失败');
        }
    });
    _connDragInfo = null;
}

// 计算文件夹在树中的嵌套深度
function getFolderDepth(fid) {
    var depth = 0;
    var current = fid;
    while (current) {
        var parent = '';
        for (var i = 0; i < (treeData.folders || []).length; i++) {
            if (treeData.folders[i].id === current) {
                parent = treeData.folders[i].parent || '';
                break;
            }
        }
        if (parent) { depth++; current = parent; }
        else break;
    }
    return depth;
}

// 从 DOM 中移动连接节点到新位置
function moveConnNode(cid, toFid) {
    var c = treeData.connections[cid];
    if (!c) return;

    // 移除原节点
    var oldNode = document.querySelector('.tree-node[data-cid="' + cid + '"]');
    if (oldNode) oldNode.remove();

    // 重新渲染（带正确缩进）
    var indent = toFid ? getFolderDepth(toFid) * 16 + 16 : 0;
    var html = renderConn(c, indent);

    // 插入目标容器
    if (toFid) {
        var container = document.getElementById('mc_' + toFid);
        if (container) {
            // 如果文件夹未展开则先展开
            if (!container.classList.contains('open')) {
                container.classList.add('open');
                var arrow = document.getElementById('ma_' + toFid);
                if (arrow) { arrow.textContent = '▾'; arrow.style.visibility = 'visible'; }
            } else {
                var arrow = document.getElementById('ma_' + toFid);
                if (arrow) arrow.style.visibility = 'visible';
            }
            container.insertAdjacentHTML('beforeend', html);
        } else {
            // 容器不存在（极端情况），放到根
            document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', renderConn(c, 0));
        }
    } else {
        document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', html);
    }
}

// ==================== 右键菜单 ====================
var ctxMenu = null;
function showCtxMenu(x, y, items) {
    hideCtxMenu();
    ctxMenu = document.createElement('div');
    ctxMenu.className = 'tree-ctx-menu show';
    ctxMenu.style.left = x + 'px'; ctxMenu.style.top = y + 'px';
    items.forEach(function (it) {
        if (it === '---') { var s = document.createElement('div'); s.className = 'ctx-sep'; ctxMenu.appendChild(s); }
        else { var el = document.createElement('div'); el.className = 'ctx-item'; el.textContent = it.label;
            el.onclick = function () { hideCtxMenu(); if (it.action) it.action(); }; ctxMenu.appendChild(el); }
    });
    document.body.appendChild(ctxMenu);
}
function hideCtxMenu() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }
document.addEventListener('click', function () { hideCtxMenu(); });

// ==================== 文件夹/连接管理 ====================
function folderCtx(e, fid) {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
        {label:'📂 新建子文件夹',action:function(){addFolder(fid);}},
        {label:'🔗 新建连接',action:function(){showConnDialog(fid);}},
        '---',{label:'✏️ 重命名',action:function(){renameFolder(fid);}},{label:'🗑 删除',action:function(){deleteFolder(fid);}}
    ]);
}

function connCtx(e, cid) {
    e.preventDefault(); e.stopPropagation();
    var children = document.getElementById('mc_c_' + cid);
    var isOpen = children && children.classList.contains('open');
    var node = document.querySelector('.tree-node[data-cid="' + cid + '"]');
    var row = node ? node.querySelector('.conn-row') : null;
    var pad = row ? (parseInt(row.style.paddingLeft || '0') || 20) : 20;
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    var isRedis = conn && conn.db_type === 'redis';

    // 慢SQL跳转项（MySQL/OceanBase 才显示）
    var slowItem = (conn && (!conn.db_type || conn.db_type === 'mysql' || conn.db_type === 'ob-mysql'))
        ? {label:'📊 慢SQL分析',action:function(){if(typeof slowQueryJumpFromConn==='function') slowQueryJumpFromConn(cid);}}
        : null;

    var menu;
    if (isOpen) {
        if (isRedis) {
            menu = [
                {label:'💻 Redis 命令',action:function(){showRedisCmdPanel(cid);}},
                '---',
                {label:'✏️ 编辑',action:function(){showConnDialog(null,cid);}},
                {label:'🔄 刷新 Keys',action:function(){closeConnection(cid);expandConn(cid, pad);}},
                '---',
                {label:'⏹ 关闭连接',action:function(){closeConnection(cid);}},
                {label:'🗑 删除',action:function(){deleteConnection(cid);}}
            ];
        } else {
            menu = [
                {label:'🆕 创建数据库',action:function(){showCreateDatabase(cid);}},
                '---',
                {label:'✏️ 编辑',action:function(){showConnDialog(null,cid);}},
                {label:'⏹ 关闭连接',action:function(){closeConnection(cid);}},
                '---',
                {label:'🗑 删除',action:function(){deleteConnection(cid);}}
            ];
            if (slowItem) menu.splice(1, 0, slowItem);
        }
    } else {
        menu = [
            {label:'🔗 打开连接',action:function(){expandConn(cid, pad);}},
            {label:'✏️ 编辑',action:function(){showConnDialog(null,cid);}},
            '---',
            {label:'🗑 删除',action:function(){deleteConnection(cid);}}
        ];
        if (slowItem) menu.splice(1, 0, slowItem);
    }
    showCtxMenu(e.clientX, e.clientY, menu);
}

function closeConnection(cid) {
    var children = document.getElementById('mc_c_' + cid);
    var arrow = document.getElementById('ma_c_' + cid);
    if (children) {
        children.classList.remove('open');
        children.innerHTML = '';
    }
    if (arrow) { arrow.textContent = '▸'; arrow.style.visibility = 'hidden'; }
    var connIcon = arrow ? arrow.parentElement.querySelector('.db-icon') : null;
    if (connIcon) { connIcon.classList.remove('active'); connIcon.classList.add('closed'); }
    // 清空该连接在对象窗口中的相关 tab
    var wasActive = activeConnId === cid;
    _redisPanelCtx = null;
    // 清理编辑状态缓存
    for (var st in _redisEditState) {
        if (_redisEditState.hasOwnProperty(st) && _redisEditState[st].cid === cid) {
            delete _redisEditState[st];
        }
    }
    // 清理 keys 缓存
    for (var kc in _redisKeysCache) {
        if (_redisKeysCache.hasOwnProperty(kc) && _redisKeysCache[kc].cid === cid) {
            delete _redisKeysCache[kc];
        }
    }
    if (wasActive) {
        // 当前激活的连接被关闭：清空所有对象 tab，只保留 obj_home
        activeConnId = '';
        activeConnData = null;
        activeDatabase = '';
        objectTabs = []; // 清空全部 tab（包括 data_/ddl_/query_/redis_ 等）
    } else {
        // 非激活连接关闭：移除该连接下所有相关 tab（data_/ddl_/query_/redis_/redis_cmd 等）
        objectTabs = objectTabs.filter(function(t) { return t.cid !== cid; });
    }
    // 确保 obj_home 存在并展示占位内容
    var homeContent3 = '<div style="padding:40px;text-align:center;color:#666;"><div>请选择一个连接</div></div>';
    var homeTab3 = objectTabs.find(function(t){return t.id==='obj_home';});
    if (!homeTab3) { objectTabs.unshift({id:'obj_home',label:'对象',type:'home',content:homeContent3,db:''}); }
    else { homeTab3.content = homeContent3; }
    activeObjTab = 'obj_home';
    activeCatId = null;
    renderObjectPanel();
}

function addFolder(pid) { showInputDialog('新建文件夹','名称：',function(n){if(!n||!n.trim())return;eel.tree_add_folder(pid||'',n.trim())(function(r){if(r&&r.ok){treeData.folders=treeData.folders||[];var f={id:r.id,name:n.trim(),parent:pid||''};treeData.folders.push(f);addFolderToTree(f);}});}); }
function renameFolder(fid) { var f=(treeData.folders||[]).find(function(x){return x.id===fid;}); showInputDialog('重命名','新名称：',function(n){if(!n||!n.trim())return;eel.tree_rename_folder(fid,n.trim())(function(){if(f)f.name=n.trim();updateFolderNode(fid,n.trim());});},f?f.name:''); }
function deleteFolder(fid) { showConfirmDialog('确认','删除文件夹及其中连接？',function(){eel.tree_delete_folder(fid)(function(){function collectKids(pid){var r=[pid];(treeData.folders||[]).forEach(function(f){if(f.parent===pid)r=r.concat(collectKids(f.id));});return r;}var kids=collectKids(fid);var conns=[];for(var k in treeData.connections){if(kids.indexOf(treeData.connections[k].parent)!==-1)conns.push(k);}treeData.folders=(treeData.folders||[]).filter(function(f){return kids.indexOf(f.id)===-1;});conns.forEach(function(k){delete treeData.connections[k];});removeFolderNode(fid);});}); }
function deleteConnection(cid) { showConfirmDialog('确认','删除此连接？',function(){eel.tree_delete_connection(cid)(function(){delete treeData.connections[cid];removeConnNode(cid);});}); }

function addQuery(cid, db, schema) { var sch = schema || ''; showInputDialog('新建查询','名称：',function(n){if(!n||!n.trim())return;eel.tree_save_query('',n.trim(),'',cid||activeConnId||'',db||'')(function(r){if(r&&r.ok){var qc=treeData.saved_queries||[];qc.push({id:r.id,name:n.trim(),sql:'',conn_id:cid||activeConnId||'',db:db||''});refreshQueriesTree(cid||activeConnId||'',db||'',sch);}});}); }

function showCreateDatabase(cid) {
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    var dbType = conn ? conn.db_type || 'mysql' : 'mysql';
    var isMySQL = dbType === 'mysql' || dbType === 'ob-mysql';
    var html =
        '<div style="padding:10px 0;">' +
            '<h4 style="margin:0 0 12px;color:#4fc3f7;">🆕 创建数据库</h4>' +
            '<table class="design-table" style="width:100%;"><tbody>' +
                '<tr><td style="width:70px;">数据库名</td><td><input class="design-input" id="create_db_name" placeholder="请输入数据库名" style="width:100%;"></td></tr>' +
                (isMySQL ?
                    '<tr><td>字符集</td><td><input class="design-input" id="create_db_charset" value="utf8mb4" style="width:100%;"></td></tr>' +
                    '<tr><td>排序规则</td><td><input class="design-input" id="create_db_collation" value="utf8mb4_unicode_ci" style="width:100%;"></td></tr>'
                : '') +
            '</tbody></table>' +
            '<div id="create_db_result" style="margin-top:8px;font-size:12px;"></div>' +
        '</div>';
    renderExportModal('创建数据库', html,
        '<button class="btn btn-gray" onclick="hideModal()">取消</button>' +
        '<button class="btn btn-blue" onclick="doCreateDatabase(\''+cid+'\',\''+escapeAttr(dbType)+'\')">创建</button>');
}

function doCreateDatabase(cid, dbType) {
    var nameEl = document.getElementById('create_db_name');
    var dbName = nameEl ? nameEl.value.trim() : '';
    if (!dbName) {
        var resultEl = document.getElementById('create_db_result');
        if (resultEl) resultEl.innerHTML = '<span style="color:#e74c3c;">⚠️ 请输入数据库名</span>';
        return;
    }
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    var isMySQL = dbType === 'mysql' || dbType === 'ob-mysql';
    var charset = isMySQL ? document.getElementById('create_db_charset').value : 'utf8mb4';
    var collation = isMySQL ? document.getElementById('create_db_collation').value : 'utf8mb4_unicode_ci';
    var btnEl = document.querySelector('#modal_btns');
    if (btnEl) btnEl.innerHTML = '<span style="color:#888;font-size:12px;">⏳ 创建中...</span>';
    eel.db_create(conn, dbName, charset, collation)(function(r) {
        var resultEl = document.getElementById('create_db_result');
        if (r && r.ok) {
            if (resultEl) resultEl.innerHTML = '<span style="color:#2ecc71;">✅ ' + r.msg + '</span>';
            if (btnEl) btnEl.innerHTML = '<button class="btn btn-green btn-sm" onclick="hideModal()">完成</button>';
            // 如果连接已展开，刷新数据库列表
            var children = document.getElementById('mc_c_' + cid);
            if (children && children.classList.contains('open')) {
                refreshDatabaseList(cid);
            }
        } else {
            if (resultEl) resultEl.innerHTML = '<span style="color:#e74c3c;">❌ ' + (r ? r.msg : '创建失败') + '</span>';
            if (btnEl) btnEl.innerHTML =
                '<button class="btn btn-gray" onclick="hideModal()">取消</button>' +
                '<button class="btn btn-blue" onclick="doCreateDatabase(\''+cid+'\',\''+escapeAttr(dbType)+'\')">重试</button>';
        }
    });
}

function selectType(el) {
    var container = el.parentElement;
    container.querySelectorAll('.type-opt').forEach(function(x){x.classList.remove('selected');});
    el.classList.add('selected');
    var dbType = el.getAttribute('data-val');
    document.getElementById('cf_type').value = dbType;
    // 自动设置默认端口
    var defs = DB_DEFAULTS[dbType] || {port:'3306'};
    document.getElementById('cf_port').value = defs.port;
}

function showConnDialog(pid, editCid) {
    var isEdit = !!editCid;
    var cd = isEdit && treeData.connections[editCid] ? treeData.connections[editCid] : {};
    var curType = cd.db_type || 'mysql';
    var h = '<div class="conn-form"><h4 style="margin-bottom:12px;color:#e0e0e0;font-size:14px;">'+(isEdit?'✏️ 编辑':'➕ 新建')+'连接</h4>';
    // 类型选择卡片
    var dbTypes = [
        {value:'mysql', label:'MySQL'},
        {value:'ob-mysql', label:'OB-MySQL'},
        {value:'oracle', label:'Oracle'},
        {value:'postgresql', label:'PostgreSQL'},
        {value:'mssql', label:'SQL Server'},
        {value:'redis', label:'Redis'}
    ];
    h += '<div class="form-row"><label>类型</label><div class="type-selector">';
    dbTypes.forEach(function(t){
        var sel = t.value===curType ? ' selected' : '';
        h += '<div class="type-opt'+sel+'" data-val="'+t.value+'" onclick="selectType(this)">'+DB_ICONS[t.value]+' '+t.label+'</div>';
    });
    h += '</div></div>';
    h += '<input type="hidden" id="cf_type" value="'+curType+'">';
    var defs = DB_DEFAULTS[curType] || {port:'3306'};
    h += '<div class="form-row"><label>名称</label><input id="cf_name" value="'+escapeHtml(cd.name||'')+'"></div>';
    h += '<div class="form-row"><label>主机</label><input id="cf_host" value="'+escapeHtml(cd.host||'')+'"></div>';
    h += '<div class="form-row"><label>端口</label><input id="cf_port" value="'+escapeHtml(cd.port||defs.port)+'"></div>';
    h += '<div class="form-row"><label>用户名</label><input id="cf_user" value="'+escapeHtml(cd.user||'')+'"></div>';
    h += '<div class="form-row"><label>密码</label><input type="password" id="cf_pwd" value="'+escapeHtml(cd.pwd||'')+'"></div>';
    h += '<div class="form-row"><label>数据库</label><input id="cf_db" value="'+escapeHtml(cd.db||'')+'"></div>';
    h += '<div class="form-row"><button class="btn btn-green" style="margin-right:8px;" onclick="connTest()">🔍 测试连接</button><span id="cf_test" style="font-size:11px;flex:1;"></span></div>';
    h += '<div style="text-align:center;margin-top:12px;"><button class="btn btn-gray" style="margin-right:8px;" onclick="hideConnDlg()">取消</button><button class="btn btn-green" onclick="connSave(\''+(pid||'')+'\',\''+(editCid||'')+'\')">保存</button></div></div>';
    document.getElementById('conn_modal_box').innerHTML = h;
    document.getElementById('conn_modal_overlay').classList.add('show');
}
function hideConnDlg() { document.getElementById('conn_modal_overlay').classList.remove('show'); }
function connTest() {
    var c = readConnForm(); var st = document.getElementById('cf_test');
    if (!c.host||!c.user) { st.textContent='⚠️ 填主机和用户名'; st.style.color='#f39c12'; return; }
    st.textContent='⏳'; st.style.color='#f39c12';
    eel.tree_test_conn(c)(function(r){if(r&&r.ok){st.textContent='✅ '+r.msg;st.style.color='#2ecc71';}else{st.textContent='❌ '+(r?r.msg:'失败');st.style.color='#e74c3c';}});
}
function connSave(pid, editCid) {
    var c = readConnForm();
    if (!c.name||!c.host||!c.user) { showWarnDialog('提示','请填写名称、主机、用户名'); return; }
    if (editCid) {
        eel.tree_update_connection(editCid,c)(function(r){
            if(r && r.ok !== false) {
                hideConnDlg();
                c.id = editCid; c.parent = treeData.connections[editCid] ? treeData.connections[editCid].parent : '';
                treeData.connections[editCid] = c;
                updateConnNode(editCid, c);
            } else {
                showErrorDialog('失败', r ? r.msg : '更新连接失败');
            }
        });
    } else {
        eel.tree_add_connection(pid,c)(function(r){
            hideConnDlg();
            if(r && r.ok) {
                c.id = r.id; c.parent = pid || '';
                treeData.connections[r.id] = c;
                addConnToTree(c);
            }
        });
    }
}
function readConnForm() {
    return {name:(document.getElementById('cf_name')||{}).value||'',db_type:(document.getElementById('cf_type')||{}).value||'mysql',host:(document.getElementById('cf_host')||{}).value||'',port:(document.getElementById('cf_port')||{}).value||'3306',user:(document.getElementById('cf_user')||{}).value||'',pwd:(document.getElementById('cf_pwd')||{}).value||'',db:(document.getElementById('cf_db')||{}).value||''};
}

// ==================== 导出向导 ====================
var _exportState = null;
var _exportTimer = null;

function showExportWizard(cid, db, schema, preSelectedTable) {
    _exportState = { cid: cid, db: db, schema: schema || '', preSelected: preSelectedTable || '', step: 1, format: 'sql', scope: 'full', columnSel: {}, csvHeader: true };
    exportWizStep1();
}

function exportWizStep1() {
    var es = _exportState;
    var html =
        '<div style="padding:10px 0;">' +
            '<h4 style="margin:0 0 12px;color:#4fc3f7;">📤 导出向导 - 第 1 步：选择格式</h4>' +
            '<div style="display:flex;flex-direction:column;gap:10px;">' +
                '<label style="display:flex;align-items:center;gap:8px;padding:0;font-size:13px;"><input type="radio" name="exp_fmt" value="sql" '+(es.format==='sql'?'checked':'')+' onchange="_exportState.format=this.value;exportFmtChanged()" style="flex-shrink:0;width:16px;height:16px;"><span>SQL 脚本 (.sql)</span></label>' +
                '<label style="display:flex;align-items:center;gap:8px;padding:0;font-size:13px;"><input type="radio" name="exp_fmt" value="csv" '+(es.format==='csv'?'checked':'')+' onchange="_exportState.format=this.value;exportFmtChanged()" style="flex-shrink:0;width:16px;height:16px;"><span>CSV 文件 (.csv)</span></label>' +
                '<div id="export_csv_opts" style="display:'+(es.format==='csv'?'block':'none')+';margin-left:24px;">' +
                    '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#aaa;"><input type="checkbox" id="exp_csv_header" '+(es.csvHeader?'checked':'')+' onchange="_exportState.csvHeader=this.checked" style="flex-shrink:0;width:14px;height:14px;"><span>包含标题行（首行为列名）</span></label>' +
                '</div>' +
            '</div>' +
        '</div>';
    renderExportModal('导出向导 - 第1步', html,
        '<button class="btn btn-gray" onclick="hideModal()">取消</button>' +
        '<button class="btn btn-blue" onclick="exportWizStep2()">下一步 ▶</button>');
}

function exportFmtChanged() {
    var es = _exportState;
    // 保存 CSV header checkbox 状态
    var cb = document.getElementById('exp_csv_header');
    if (cb) es.csvHeader = cb.checked;
    // 显示/隐藏 CSV 选项
    var opts = document.getElementById('export_csv_opts');
    if (opts) opts.style.display = es.format === 'csv' ? 'block' : 'none';
}

function exportWizStep2() {
    var es = _exportState;
    var html =
        '<div style="padding:10px 0;">' +
            '<h4 style="margin:0 0 12px;color:#4fc3f7;">📤 导出向导 - 第 2 步：选择范围</h4>' +
            '<div style="display:flex;flex-direction:column;gap:10px;">' +
                '<label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input type="radio" name="exp_scope" value="structure" '+(es.scope==='structure'?'checked':'')+' onchange="_exportState.scope=this.value" style="flex-shrink:0;width:16px;height:16px;"><span>仅表结构（DROP TABLE + CREATE TABLE）</span></label>' +
                '<label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input type="radio" name="exp_scope" value="data" '+(es.scope==='data'?'checked':'')+' onchange="_exportState.scope=this.value" style="flex-shrink:0;width:16px;height:16px;"><span>仅数据（INSERT 语句）</span></label>' +
                '<label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input type="radio" name="exp_scope" value="full" '+(es.scope==='full'?'checked':'')+' onchange="_exportState.scope=this.value" style="flex-shrink:0;width:16px;height:16px;"><span>结构 + 数据（完整）</span></label>' +
            '</div>' +
        '</div>';
    renderExportModal('导出向导 - 第2步', html,
        '<button class="btn btn-gray" onclick="exportWizStep1()">◀ 上一步</button>' +
        '<button class="btn btn-blue" onclick="exportWizStep3()">下一步 ▶</button>');
}

function exportWizStep3() {
    var es = _exportState;
    document.getElementById('modal_msg').innerHTML = '<div style="text-align:center;padding:30px;color:#888;">⏳ 加载表列表...</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="exportWizStep2()">◀ 上一步</button>';

    var conn = treeData && treeData.connections ? treeData.connections[es.cid] : null;
    eel.export_wizard_get_tables(conn, es.db, es.schema)(function(r) {
        if (!r || !r.ok) {
            document.getElementById('modal_msg').innerHTML = '<div style="padding:20px;color:#e74c3c;">❌ ' + (r ? r.msg : '加载失败') + '</div>';
            document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';
            return;
        }
        var tables = r.tables || [];
        var rows = tables.map(function(t) {
            var checked = (es.preSelected && t === es.preSelected) ? ' checked' : '';
            return '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;">' +
                '<input type="checkbox" class="exp_tbl_cb" value="' + escapeAttr(t) + '"' + checked + ' style="flex-shrink:0;width:15px;height:15px;">' +
                '<span style="font-size:12px;">📊 ' + escapeHtml(t) + '</span></div>';
        }).join('');

        var html =
            '<div style="padding:10px 0;">' +
                '<h4 style="margin:0 0 10px;color:#4fc3f7;">📤 导出向导 - 第 3 步：选择表</h4>' +
                '<div style="margin-bottom:6px;">' +
                    '<label style="font-size:12px;color:#4fc3f7;" onclick="exportToggleAll(this)"><input type="checkbox" style="vertical-align:middle;margin-right:4px;width:14px;height:14px;"> 全选 / 取消全选</label>' +
                '</div>' +
                '<div style="max-height:260px;overflow-y:auto;border:1px solid #333;border-radius:4px;padding:6px 10px;background:#0d1117;">' +
                    (rows || '<div style="color:#888;">（无表）</div>') +
                '</div>' +
            '</div>';
        document.getElementById('modal_msg').innerHTML = html;
        document.getElementById('modal_btns').innerHTML =
            '<button class="btn btn-gray" onclick="exportWizStep2()">◀ 上一步</button>' +
            '<button class="btn btn-blue" onclick="exportWizGoStep4()">下一步 ▶</button>';
    });
}

function exportToggleAll(el) {
    var checked = el.querySelector('input').checked;
    document.querySelectorAll('.exp_tbl_cb').forEach(function(cb) { cb.checked = checked; });
}

function exportWizGoStep4() {
    var es = _exportState;
    var cbs = document.querySelectorAll('.exp_tbl_cb:checked');
    es.tables = [];
    cbs.forEach(function(cb) { es.tables.push(cb.value); });
    if (!es.tables.length) {
        // 不关闭向导，直接在当前窗口提示后回到选表步骤
        var saveBtns = document.getElementById('modal_btns').innerHTML;
        document.getElementById('modal_msg').innerHTML = '<div style="text-align:center;padding:20px;color:#e74c3c;">⚠️ 请至少选择一张表</div>';
        document.getElementById('modal_btns').innerHTML = '<button class="btn btn-blue" onclick="exportWizStep3()">返回选择</button>';
        return;
    }
    document.getElementById('modal_msg').innerHTML = '<div style="text-align:center;padding:30px;color:#888;">⏳ 加载字段信息...</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="exportWizStep3()">◀ 上一步</button>';

    var conn = treeData && treeData.connections ? treeData.connections[es.cid] : null;
    var loaded = 0;
    es.columnSel = {};
    es.tables.forEach(function(tn) {
        eel.export_wizard_get_columns(conn, es.db, tn, es.schema)(function(r) {
            loaded++;
            if (r && r.ok) { es.columnSel[tn] = { all: (r.columns||[]), selected: (r.columns||[]).slice() }; }
            if (loaded >= es.tables.length) { exportWizRenderStep4(); }
        });
    });
}

function exportWizRenderStep4() {
    var es = _exportState;
    var panels = es.tables.map(function(tn) {
        var sel = es.columnSel[tn];
        var cols = sel ? sel.all : [];
        var rows = cols.map(function(c) {
            return '<div style="display:flex;align-items:center;gap:6px;padding:2px 0;">' +
                '<input type="checkbox" class="exp_col_cb" data-tbl="' + escapeAttr(tn) + '" value="' + escapeAttr(c) + '" checked style="flex-shrink:0;width:14px;height:14px;">' +
                '<span style="font-size:12px;">' + escapeHtml(c) + '</span></div>';
        }).join('');
        return '<div style="margin-bottom:10px;background:#0d1117;border:1px solid #333;border-radius:4px;padding:8px 10px;">' +
            '<div style="margin-bottom:4px;"><b style="color:#4fc3f7;">📊 ' + escapeHtml(tn) + '</b> ' +
            '<a href="#" onclick="event.preventDefault();exportToggleCols(\'' + escapeAttr(tn) + '\',true)" style="font-size:11px;color:#4fc3f7;">全选</a> | ' +
            '<a href="#" onclick="event.preventDefault();exportToggleCols(\'' + escapeAttr(tn) + '\',false)" style="font-size:11px;color:#e74c3c;">取消全选</a></div>' +
            '<div style="max-height:150px;overflow-y:auto;padding:4px 0;">' + rows + '</div></div>';
    }).join('');

    var html =
        '<div style="padding:10px 0;">' +
            '<h4 style="margin:0 0 10px;color:#4fc3f7;">📤 导出向导 - 第 4 步：选择字段</h4>' +
            '<div style="max-height:300px;overflow-y:auto;">' + panels + '</div>' +
        '</div>';
    document.getElementById('modal_msg').innerHTML = html;
    document.getElementById('modal_btns').innerHTML =
        '<button class="btn btn-gray" onclick="exportWizStep3()">◀ 上一步</button>' +
        '<button class="btn btn-green" onclick="exportWizStart()">▶ 开始导出</button>';
}

function exportToggleCols(tn, check) {
    document.querySelectorAll('.exp_col_cb[data-tbl="' + tn + '"]').forEach(function(cb) { cb.checked = check; });
}

function renderExportModal(title, html, btns) {
    document.getElementById('modal_icon').innerHTML = '📤';
    document.getElementById('modal_title').innerHTML = title;
    document.getElementById('modal_title').style.color = '#4fc3f7';
    document.getElementById('modal_msg').innerHTML = html;
    document.getElementById('modal_btns').innerHTML = btns;
    document.getElementById('modal_overlay').classList.add('show');
}

function _exportWizAppendLog(msg, level) {
    var area = document.getElementById('export_log_area');
    if (!area) return;
    var ts = new Date().toTimeString().slice(0, 8);
    var cls = '';
    if (level === 'ok') cls = 'style="color:#2ecc71;"';
    else if (level === 'error') cls = 'style="color:#e74c3c;"';
    else if (level === 'warn') cls = 'style="color:#f39c12;"';
    area.innerHTML += '<div ' + cls + '><span style="color:#666;">[' + ts + ']</span> ' + escapeHtml(msg) + '</div>';
    area.scrollTop = area.scrollHeight;
}

function exportWizStart() {
    var es = _exportState;
    if (!es) return;

    var colSel = {};
    es.tables.forEach(function(tn) {
        var sel = [];
        document.querySelectorAll('.exp_col_cb[data-tbl="' + escapeAttr(tn) + '"]:checked').forEach(function(cb) { sel.push(cb.value); });
        colSel[tn] = sel;
    });

    // 直接开始导出（文件自动保存到工具目录）
    var conn = treeData && treeData.connections ? treeData.connections[es.cid] : null;
    var settings = { format: es.format, scope: es.scope, columns: colSel, csv_header: es.csvHeader };

    var html =
            '<div style="padding:10px 0;">' +
                '<h4 style="margin:0 0 8px;color:#4fc3f7;">📤 导出进度</h4>' +
                '<div class="progress-bar" style="height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden;margin-bottom:12px;">' +
                    '<div id="export_progress_bar" class="progress-fill" style="width:0%;height:100%;background:#27ae60;border-radius:4px;transition:width .3s;"></div>' +
                '</div>' +
                '<table class="design-table" style="font-size:11px;">' +
                    '<thead><tr><th>源表</th><th>总计</th><th>已处理</th><th>时间</th></tr></thead>' +
                    '<tbody id="export_progress_tbody"><tr><td colspan="4" style="color:#888;">正在导出...</td></tr></tbody>' +
                '</table>' +
                '<div style="margin-top:12px;border:1px solid #333;border-radius:4px;overflow:hidden;">' +
                    '<div style="background:#2a2a2a;padding:4px 10px;font-size:11px;color:#aaa;border-bottom:1px solid #333;">📋 导出日志</div>' +
                    '<div id="export_log_area" style="height:120px;overflow-y:auto;padding:6px 10px;background:#0d1117;font-family:Consolas,monospace;font-size:11px;line-height:1.6;"></div>' +
                '</div>' +
            '</div>';
        document.getElementById('modal_msg').innerHTML = html;
        document.getElementById('modal_btns').innerHTML =
            '<button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;" onclick="cancelExport()">⏹ 中断</button>' +
            '<button class="btn btn-gray btn-sm" onclick="hideModal()">关闭</button>';

        _exportTimer = setInterval(function() {
            if (!document.getElementById('modal_overlay').classList.contains('show')) { clearInterval(_exportTimer); _exportTimer = null; return; }
            eel.poll_queue()(function(msgs) {
                if (!msgs) return;
                for (var i = 0; i < msgs.length; i++) {
                    var m = msgs[i];
                    if (m && m[0] === 'export_log') {
                        _exportWizAppendLog(m[1].msg, m[1].level || '');
                    } else if (m && m[0] === 'export_progress') {
                        var d = m[1];
                        var bar = document.getElementById('export_progress_bar');
                        if (bar && d.total_tables) bar.style.width = Math.floor((d.table_index / d.total_tables) * 100) + '%';
                        var tbody = document.getElementById('export_progress_tbody');
                        if (tbody && d.table_done) {
                            if (tbody.querySelector('td[colspan]')) tbody.innerHTML = '';
                            tbody.innerHTML += '<tr><td>' + escapeHtml(d.table) + '</td><td>' + (d.total||0) + '</td><td>' + (d.processed||0) + '</td><td>' + escapeHtml(d.time||'') + '</td></tr>';
                        }
                    } else if (m && m[0] === 'export_done') {
                        clearInterval(_exportTimer); _exportTimer = null;
                        document.getElementById('export_progress_bar').style.width = '100%';
                        var pathInfo = m[1] && m[1].path ? m[1].path : '';
                        _exportWizAppendLog('导出成功！', 'ok');
                        if (pathInfo) _exportWizAppendLog('文件路径：' + pathInfo, 'ok');
                        document.getElementById('modal_btns').innerHTML = '<button class="btn btn-green btn-sm" onclick="hideModal()">完成</button>';
                    } else if (m && m[0] === 'export_error') {
                        clearInterval(_exportTimer); _exportTimer = null;
                        var errMsg = m[1] && m[1].msg ? m[1].msg : '未知错误';
                        _exportWizAppendLog('导出失败: ' + errMsg, 'error');
                        document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray btn-sm" onclick="hideModal()">关闭</button>';
                    }
                }
            });
        }, 300);

        eel.export_wizard_start(conn, es.db, es.tables, settings, es.schema)(function(r) {
            if (r && !r.ok) { clearInterval(_exportTimer); _exportTimer = null; _exportWizAppendLog('导出失败: ' + (r.msg||'未知错误'), 'error'); }
        });
}

function cancelExport() {
    if (_exportTimer) { clearInterval(_exportTimer); _exportTimer = null; }
    eel.cancel_query()();
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray btn-sm" onclick="hideModal()">关闭</button>';
}

// ==================== 导入向导 ====================
function showImportWizard(cid, db, schema) {
    var ds = { cid: cid, db: db, schema: schema || '' };

    var html =
        '<div style="padding:10px 0;">' +
            '<h4 style="margin:0 0 12px;color:#27ae60;">📥 导入向导</h4>' +
            '<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px;">' +
                '<label style="display:flex;align-items:center;gap:8px;padding:0;font-size:13px;"><input type="radio" name="imp_type" value="sql" checked style="flex-shrink:0;width:16px;height:16px;"><span>SQL 脚本 (.sql)</span></label>' +
                '<label style="display:flex;align-items:center;gap:8px;padding:0;font-size:13px;"><input type="radio" name="imp_type" value="csv" style="flex-shrink:0;width:16px;height:16px;"><span>CSV 文件 (.csv)</span></label>' +
            '</div>' +
            '<div style="margin:8px 0 4px;display:flex;align-items:center;gap:10px;">' +
                '<button class="btn btn-blue btn-sm" id="btn_pick_import" onclick="pickImportFile()">📁 选择文件</button>' +
                '<span id="import_file_label" style="font-size:11px;color:#888;">未选择</span>' +
            '</div>' +
        '</div>';

    document.getElementById('modal_icon').innerHTML = '📥';
    document.getElementById('modal_title').textContent = '导入向导';
    document.getElementById('modal_title').style.color = '#27ae60';
    document.getElementById('modal_msg').innerHTML = html;
    document.getElementById('modal_btns').innerHTML =
        '<button class="btn btn-gray" onclick="hideModal()">取消</button>' +
        '<button class="btn btn-green" id="btn_start_import" onclick="importWizardStart()" disabled>▶ 开始导入</button>';
    document.getElementById('modal_overlay').classList.add('show');

    window._importState = ds;
    window._importFilePath = '';
}

function pickImportFile() {
    window._sqlFileTarget = 'import';
    var input = document.getElementById('hidden_import_file');
    if (input) { input.accept = '.sql,.csv'; input.click(); }
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function importWizardStart() {
    var ds = window._importState;
    if (!ds || !window._importFileContent) return;
    var checkedEl = document.querySelector('input[name="imp_type"]:checked');
    if (!checkedEl) { showErrorDialog('错误', '请选择导入类型'); return; }
    var fileType = checkedEl.value;
    var conn = treeData && treeData.connections ? treeData.connections[ds.cid] : null;
    var fileName = window._importFileName || 'import.sql';
    var content = window._importFileContent;

    var html =
        '<div style="padding:10px 0;">' +
            '<h4 style="margin:0 0 8px;color:#27ae60;">📥 导入进度</h4>' +
            '<div class="progress-bar" style="height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden;margin-bottom:12px;">' +
                '<div id="import_progress_bar" class="progress-fill" style="width:0%;height:100%;background:#27ae60;border-radius:4px;transition:width .3s;"></div>' +
            '</div>' +
            '<div id="import_status" style="font-size:11px;color:#888;"></div>' +
            '<div style="margin-top:10px;border:1px solid #333;border-radius:4px;overflow:hidden;">' +
                '<div style="background:#2a2a2a;padding:4px 10px;font-size:11px;color:#aaa;border-bottom:1px solid #333;">📋 导入日志</div>' +
                '<div id="import_log_area" style="height:100px;overflow-y:auto;padding:6px 10px;background:#0d1117;font-family:Consolas,monospace;font-size:11px;line-height:1.6;"></div>' +
            '</div>' +
        '</div>';
    document.getElementById('modal_msg').innerHTML = html;
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';

    var tid = setInterval(function() {
        if (!document.getElementById('modal_overlay').classList.contains('show')) { clearInterval(tid); return; }
        eel.poll_queue()(function(msgs) {
            if (!msgs) return;
            for (var i = 0; i < msgs.length; i++) {
                var m = msgs[i];
                if (m && m[0] === 'import_log') {
                    var area = document.getElementById('import_log_area');
                    if (area) {
                        var ts = new Date().toTimeString().slice(0, 8);
                        area.innerHTML += '<div style="color:#e74c3c;"><span style="color:#666;">[' + ts + ']</span> ' + escapeHtml(m[1]) + '</div>';
                        area.scrollTop = area.scrollHeight;
                    }
                } else if (m && m[0] === 'import_progress') {
                    var d = m[1];
                    var bar = document.getElementById('import_progress_bar');
                    var pct = d.total ? Math.floor((d.processed / d.total) * 100) : 0;
                    if (bar) bar.style.width = pct + '%';
                    var st = document.getElementById('import_status');
                    if (st) st.textContent = '已处理 ' + (d.processed||0) + ' / ' + (d.total||0);
                } else if (m && m[0] === 'import_done') {
                    clearInterval(tid);
                    document.getElementById('import_progress_bar').style.width = '100%';
                    var logArea = document.getElementById('import_log_area');
                    if (logArea) { logArea.innerHTML += '<div style="color:#2ecc71;">✅ 导入完成，成功执行 ' + (m[1].processed||0) + ' 条语句</div>'; logArea.scrollTop = logArea.scrollHeight; }
                    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-green" onclick="hideModal()">完成</button>';
                } else if (m && m[0] === 'import_error') {
                    clearInterval(tid);
                    var area2 = document.getElementById('import_log_area');
                    if (area2) { area2.innerHTML += '<div style="color:#e74c3c;">❌ ' + escapeHtml(m[1].msg) + '</div>'; area2.scrollTop = area2.scrollHeight; }
                    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';
                }
            }
        });
    }, 300);

    eel.import_wizard_run(conn, ds.db, '', fileType, ds.schema, content || '')();
}

// ==================== 数据加载 ====================
function loadTree() {
    try {
        console.log('[tree.js] 开始加载树数据...');
        eel.tree_load()(function (data) {
            try {
                treeData = data || { folders: [], connections: {}, saved_queries: [] };
                var connCount = treeData && treeData.connections ? Object.keys(treeData.connections).length : 0;
                console.log('[tree.js] 树加载完成，连接数:', connCount);
                renderMyConnectionsList();
            } catch (err) {
                console.error('[tree.js] tree_load 回调异常:', err.message || err);
                treeData = { folders: [], connections: {}, saved_queries: [] };
                renderMyConnectionsList();
            }
        });
    } catch (err) {
        console.error('[tree.js] loadTree 调用 eel.tree_load 失败:', err.message || err);
    }
}
function refreshAll() {
    eel.tree_load()(function (data) {
        treeData = data || { folders: [], connections: {}, saved_queries: [] };
        var el = document.getElementById('my_conn_list');
        if (el && treeData) renderMyConnectionsList();
    });
}

// ==================== Redis 操作 ====================
// ==================== Redis 值查看/编辑 ====================

// 存储 Redis 编辑状态 {tabId: {info, changed, original}}
var _redisEditState = {};

function redisShowKey(cid, key, dbIdx) {
    activeConnId = cid;
    activeConnData = treeData && treeData.connections ? treeData.connections[cid] : null;
    activeDatabase = key;
    activeCatId = null;
    var db = (dbIdx !== undefined ? dbIdx : 0);
    // ★ 先查找是否已有同连接+同数据库+同key的tab，有则直接跳转
    var existingTab = objectTabs.find(function(t) {
        return t.type === 'redis' && t.cid === cid && t.db === db && t.key === key;
    });
    if (existingTab) {
        activeObjTab = existingTab.id;
        renderObjectPanel();
        return;
    }
    var labelKey = key.length > 6 ? key.substring(0, 6) + '…' : key;
    var label = (dbIdx !== undefined ? '[DB'+dbIdx+'] ' : '') + '🔑 '+labelKey;
    // 用时间戳保证每次打开都是独立tab
    var ts = Date.now();
    var tabId = 'redis_' + ts;
    var tid = 'redis_' + key.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_') + '_' + (dbIdx||0) + '_' + ts;
    // 初始化编辑状态
    _redisEditState[tid] = {info: null, changed: {}, original: null, cid: cid, key: key, dbIdx: dbIdx};
    var html = '<div style="padding:8px 12px;overflow:auto;height:100%;">' +
        '<div style="color:#888;font-size:11px;">⏳ 加载中...</div></div>';
    // ★ 改为新增 tab 而非替换全部
    addOrUpdateTab(tabId, label, 'redis', html, '');
    var newTab = objectTabs.find(function(t){return t.id===tabId;});
    if (newTab) { newTab.key = key; newTab.cid = cid; newTab.db = dbIdx; newTab.tid = tid; }
    eel.redis_get_key_info(activeConnData, key, dbIdx)(function(r) {
        if (!r || !r.ok) {
            var content = '<div style="padding:8px 12px;color:#e74c3c;">❌ '+(r?r.msg:'加载失败')+'</div>';
            updateRedisTab(tid, content);
            return;
        }
        _redisEditState[tid].info = r.info;
        _redisEditState[tid].original = JSON.parse(JSON.stringify(r.info));
        _redisEditState[tid].changed = {};
        renderRedisData(tid, r.info);
    });
}

function updateRedisTab(tid, content) {
    var tab = objectTabs.find(function(t){return (t.tid||'')===tid;});
    if (!tab) { /* 兼容旧逻辑 */ tab = objectTabs.find(function(t){return t.id==='obj_redis'}); }
    if (tab) { tab.content = content; activeObjTab = tab.id; renderObjectPanel(); }
}

function renderRedisData(tid, info) {
    var st = _redisEditState[tid];
    if (!st) return;
    var cid = st.cid, key = st.key, dbIdx = st.dbIdx;
    var typeLabel = info.type.toUpperCase();
    var ttlVal = info.ttl;

    // ===== 整体容器：表单式布局 =====
    var html = '<div class="redis-detail-panel" style="display:flex;flex-direction:column;height:100%;overflow:auto;padding:10px 14px;gap:8px;">';

    // ---- 行1: 键名称 ----
    html += '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
        '<label style="font-size:12px;color:#4fc3f7;width:56px;flex-shrink:0;">键名称:</label>' +
        '<input type="text" id="'+tid+'_keyname" value="'+escapeAttr(info.key)+'" readonly ' +
            'style="flex:1;background:#111;border:1px solid #444;color:#e0e0e0;font-family:Consolas,monospace;font-size:12px;padding:4px 8px;border-radius:3px;" ' +
            'title="'+escapeAttr(key)+'">' +
        '</div>';

    // ---- 行2: 键类型 ----
    html += '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
        '<label style="font-size:12px;color:#4fc3f7;width:56px;flex-shrink:0;">键类型:</label>' +
        '<select id="'+tid+'_typesel" onchange="" disabled style="background:#111;border:1px solid #444;color:#e0e0e0;font-size:12px;padding:3px 6px;border-radius:3px;min-width:120px;">' +
        '<option value="string"'+(info.type==='string'?' selected':'')+'>string</option>' +
        '<option value="hash"'+(info.type==='hash'?' selected':'')+'>hash</option>' +
        '<option value="list"'+(info.type==='list'?' selected':'')+'>list</option>' +
        '<option value="set"'+(info.type==='set'?' selected':'')+'>set</option>' +
        '<option value="zset"'+(info.type==='zset'?' selected':'')+'>zset</option></select>' +
        '</div>';

    // ---- 行3: 值区域（带表格） ----
    html += '<div style="display:flex;flex-direction:column;flex:1;min-height:0;">';
    html += '<label style="font-size:12px;color:#4fc3f7;margin-bottom:2px;">值:</label>';
    html += '<div id="'+tid+'_value" style="flex:1;overflow:auto;border:1px solid #333;border-radius:4px;display:flex;flex-direction:column;">';

    if (info.type === 'string') {
        html += renderRedisString(tid, info);
    } else if (info.type === 'hash') {
        html += renderRedisHashTable(tid, info);
    } else if (info.type === 'list') {
        html += renderRedisListTable(tid, info);
    } else if (info.type === 'set') {
        html += renderRedisSetTable(tid, info);
    } else if (info.type === 'zset') {
        html += renderRedisZSetTable(tid, info);
    } else {
        html += '<pre style="font-family:Consolas,monospace;font-size:12px;color:#e0e0e0;white-space:pre-wrap;word-break:break-all;margin:8px;">' + escapeHtml(JSON.stringify(info.value, null, 2)) + '</pre>';
    }

    html += '</div>'; // value end

    // 值区域下方工具栏：+ - 筛选 | 计数信息
    if (info.type !== 'string') {
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;flex-shrink:0;border-top:1px solid #333;margin-top:2px;">' +
            '<div style="display:flex;align-items:center;gap:4px;">' +
                '<button class="btn btn-sm" onclick="redisDetailAddRow(\''+tid+'\')" title="新增行" style="height:24px;font-size:13px;padding:2px 8px;">＋</button> ' +
                '<button class="btn btn-sm" onclick="redisDetailDelRow(\''+tid+'\')" title="删除选中" style="height:24px;font-size:13px;padding:2px 8px;">－</button> ' +
                '<button class="btn btn-sm" onclick="document.getElementById(\''+tid+'_filter\').focus()" title="筛选" style="height:24px;font-size:12px;padding:2px 8px;">🔍</button> ' +
            '</div>' +
            '<span id="'+tid+'_countInfo" style="color:#888;font-size:11px;"></span>' +
            '</div>';
    }
    html += '</div>'; // 值区域容器 end

    // ---- 行4: TTL + 操作按钮 ----
    html += '<div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0;padding-top:4px;border-top:1px solid #333;">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
            '<label style="font-size:12px;color:#4fc3f7;">TTL:</label>' +
            '<select id="'+tid+'_ttlsel" style="background:#111;border:1px solid #444;color:#e0e0e0;font-size:12px;padding:3px 6px;border-radius:3px;min-width:120px;">' +
                '<option value="-1"' + (ttlVal === -1 ? ' selected' : '') + '>无 TTL</option>' +
                '<option value="300">5 分钟</option>' +
                '<option value="1800">30 分钟</option>' +
                '<option value="3600">1 小时</option>' +
                '<option value="86400">1 天</option>' +
                '<option value="604800">7 天</option>' +
                '<option value="2592000">30 天</option>' +
            '</select>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
            '<button class="btn btn-sm btn-green" id="'+tid+'_save_btn" onclick="redisSaveChanges(\''+tid+'\')" disabled style="padding:5px 18px;">应用</button> ' +
            '<button class="btn btn-sm" id="'+tid+'_cancel_btn" onclick="redisCancelChanges(\''+tid+'\')" disabled style="padding:5px 18px;">放弃</button> ' +
            '<button class="btn btn-sm" onclick="redisRefreshKey(\''+escapeAttr(cid)+'\',\''+escapeAttr(key)+'\','+dbIdx+')" style="padding:5px 10px;">🔄 刷新</button>' +
        '</div>' +
        '</div>';

    html += '</div>'; // panel end

    updateRedisTab(tid, html);

    // 更新计数信息
    redisUpdateCountInfo(tid, info);
}

// ---- string 类型 ----
function renderRedisString(tid, info) {
    var v = info.value !== null && info.value !== undefined ? String(info.value) : '';
    return '<textarea id="'+tid+'_str" class="editable-cell" spellcheck="false" ' +
        'style="width:100%;height:100%;min-height:200px;resize:none;background:#111;color:#e0e0e0;font-family:Consolas,monospace;font-size:12px;border:none;outline:none;padding:8px;white-space:pre-wrap;word-break:break-all;" ' +
        'oninput="_redisMarkChanged(\''+tid+'\')">' + escapeHtml(v) + '</textarea>';
}

// ---- hash 类型（字段/值 表格） ----
function renderRedisHashTable(tid, info) {
    var v = info.value || {};
    var keys = Object.keys(v);
    if (!keys.length) return '<div style="color:#888;padding:20px;text-align:center;">（空 Hash）</div>';
    // 隐藏的筛选输入
    var h = '<input type="text" id="'+tid+'_filter" placeholder="🔍 筛选..." ' +
        'style="width:100%;height:28px;background:#111;border-bottom:1px solid #333;color:#e0e0e0;padding:2px 8px;font-size:12px;border:none;outline:none;" ' +
        'oninput="redisFilterData(\''+tid+'\')">';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="border-bottom:1px solid #333;">' +
        '<th style="padding:5px 10px;text-align:left;width:40%;">字段</th>' +
        '<th style="padding:5px 10px;text-align:left;">值</th></tr></thead><tbody id="'+tid+'_tbody">';
    keys.forEach(function(f, i){
        h += '<tr data-field="'+escapeAttr(f)+'" id="'+tid+'_row_'+i+'">' +
            '<td style="padding:3px 10px;"><input class="editable-cell" placeholder="字段" data-field="'+escapeAttr(f)+'" data-orig-field="'+escapeAttr(f)+'"' +
                ' value="'+escapeAttr(f)+'" oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off" ' +
                'style="background:#111;border:1px solid #2a2a2a;color:#4fc3f7;"></td>' +
            '<td style="padding:3px 10px;"><input class="editable-cell" data-field="'+escapeAttr(f)+'" data-orig="'+escapeAttr(String(v[f]))+'" value="'+escapeAttr(String(v[f]))+'" ' +
                'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
            '</tr>';
    });
    h += '</tbody></table>';
    return h;
}

// ---- list 类型 ----
function renderRedisListTable(tid, info) {
    var arr = Array.isArray(info.value) ? info.value : Object.values(info.value||{});
    var total = info.length || arr.length;
    if (!arr.length) return '<div style="color:#888;padding:20px;text-align:center;">（空 List）</div>';
    var h = '<input type="text" id="'+tid+'_filter" placeholder="🔍 筛选..." ' +
        'style="width:100%;height:28px;background:#111;border-bottom:1px solid #333;color:#e0e0e0;padding:2px 8px;font-size:12px;border:none;outline:none;" ' +
        'oninput="redisFilterData(\''+tid+'\')">';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="border-bottom:1px solid #333;">' +
        '<th style="padding:5px 10px;text-align:left;width:8%;">#</th>' +
        '<th style="padding:5px 10px;text-align:left;">值</th></tr></thead><tbody id="'+tid+'_tbody">';
    arr.forEach(function(item, i){
        h += '<tr id="'+tid+'_row_'+i+'">' +
            '<td style="padding:3px 10px;color:#555;">'+(i+1)+'</td>' +
            '<td style="padding:3px 10px;"><input class="editable-cell" data-idx="'+i+'" data-orig="'+escapeAttr(String(item))+'" value="'+escapeAttr(String(item))+'" ' +
                'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
            '</tr>';
    });
    if (total > arr.length) {
        h += '<tr><td colspan="2" style="padding:4px 8px;color:#888;text-align:center;">... 共 '+total+' 项，仅显示前 '+arr.length+' 项</td></tr>';
    }
    h += '</tbody></table>';
    return h;
}

// ---- set 类型 ----
function renderRedisSetTable(tid, info) {
    var members = Array.isArray(info.value) ? info.value : Object.values(info.value||{});
    var total = info.length || members.length;
    if (!members.length) return '<div style="color:#888;padding:20px;text-align:center;">（空 Set）</div>';
    var h = '<input type="text" id="'+tid+'_filter" placeholder="🔍 筛选..." ' +
        'style="width:100%;height:28px;background:#111;border-bottom:1px solid #333;color:#e0e0e0;padding:2px 8px;font-size:12px;border:none;outline:none;" ' +
        'oninput="redisFilterData(\''+tid+'\')">';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="border-bottom:1px solid #333;">' +
        '<th style="padding:5px 10px;text-align:left;width:8%;">#</th>' +
        '<th style="padding:5px 10px;text-align:left;">值</th></tr></thead><tbody id="'+tid+'_tbody">';
    members.forEach(function(m, i){
        h += '<tr id="'+tid+'_row_'+i+'">' +
            '<td style="padding:3px 10px;color:#555;">'+(i+1)+'</td>' +
            '<td style="padding:3px 10px;"><input class="editable-cell" data-idx="'+i+'" data-orig="'+escapeAttr(String(m))+'" value="'+escapeAttr(String(m))+'" ' +
                'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
            '</tr>';
    });
    if (total > members.length) {
        h += '<tr><td colspan="2" style="padding:4px 8px;color:#888;text-align:center;">... 共 '+total+' 项，仅显示前 '+members.length+' 项</td></tr>';
    }
    h += '</tbody></table>';
    return h;
}

// ---- zset 类型 ----
function renderRedisZSetTable(tid, info) {
    var items = Array.isArray(info.value) ? info.value : [];
    var total = info.length || items.length;
    if (!items.length) return '<div style="color:#888;padding:20px;text-align:center;">（空 ZSet）</div>';
    var h = '<input type="text" id="'+tid+'_filter" placeholder="🔍 筛选..." ' +
        'style="width:100%;height:28px;background:#111;border-bottom:1px solid #333;color:#e0e0e0;padding:2px 8px;font-size:12px;border:none;outline:none;" ' +
        'oninput="redisFilterData(\''+tid+'\')">';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="border-bottom:1px solid #333;">' +
        '<th style="padding:5px 10px;text-align:left;width:40%;">Member</th>' +
        '<th style="padding:5px 10px;text-align:left;width:25%;">Score</th></tr></thead><tbody id="'+tid+'_tbody">';
    items.forEach(function(it, i){
        var member = it[0], score = it[1];
        h += '<tr id="'+tid+'_row_'+i+'">' +
            '<td style="padding:3px 10px;"><input class="editable-cell" data-type="member" data-idx="'+i+'" data-orig="'+escapeAttr(String(member))+'" value="'+escapeAttr(String(member))+'" ' +
                'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
            '<td style="padding:3px 10px;"><input class="editable-cell" data-type="score" data-idx="'+i+'" data-orig="'+escapeAttr(String(score))+'" value="'+escapeAttr(String(score))+'" ' +
                'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
            '</tr>';
    });
    if (total > items.length) {
        h += '<tr><td colspan="2" style="padding:4px 8px;color:#888;text-align:center;">... 共 '+total+' 项，仅显示前 '+items.length+' 项</td></tr>';
    }
    h += '</tbody></table>';
    return h;
}

// ---- 详情面板辅助函数 ----
function redisUpdateCountInfo(tid, info) {
    var el = document.getElementById(tid+'_countInfo');
    if (!el) return;
    var st = _redisEditState[tid];
    if (!st || !st.info) { el.textContent = ''; return; }
    var type = st.info.type;
    var visible = 0, total = 0;
    var tbody = document.getElementById(tid+'_tbody');
    if (tbody && type !== 'string') {
        var rows = tbody.querySelectorAll('tr');
        total = rows.length;
        rows.forEach(function(r){ if (r.style.display !== 'none') visible++; });
    }
    var label = type === 'hash' ? '个字段' : '个成员';
    var len = info.length || total;
    if (type === 'string') { el.textContent = ''; }
    else if (len > visible) { el.textContent = visible + ' ' + label + '（共 ' + len + ' 个）'; }
    else { el.textContent = total + ' ' + label; }
}

function redisDetailAddRow(tid) {
    var st = _redisEditState[tid];
    if (!st) return;
    var type = st.info.type;
    if (type === 'hash') _redisAddHashRow(tid);
    else if (type === 'list') _redisAddListRow(tid);
    else if (type === 'set') _redisAddSetRow(tid);
    else if (type === 'zset') _redisAddZSetRow(tid);
}

function redisDetailDelRow(tid) {
    // 删除表格中选中的行（当前选中行高亮的）
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) return;
    // 找到有背景色的行（选中态）
    var selected = null;
    var rows = tbody.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].style.background === 'rgb(42, 58, 74)' || rows[i].style.backgroundColor === '#2a3a4a' ||
            getComputedStyle(rows[i]).backgroundColor === 'rgb(42, 58, 74)' || rows[i].matches(':focus-within')) {
            selected = rows[i]; break;
        }
    }
    // 如果没有显式选中，删除最后一行
    if (!selected && rows.length > 0) selected = rows[rows.length - 1];
    if (selected) {
        var field = selected.getAttribute('data-field') || selected.getAttribute('data-idx');
        var st2 = _redisEditState[tid];
        var t = st2.info.type;
        if (t === 'hash' && field) _redisDelHashRow(tid, field);
        else if (t === 'list' && field) _redisDelListRow(tid, field);
        else if (t === 'set' && field) _redisDelSetRow(tid, field);
        else if (t === 'zset' && field) _redisDelZSetRow(tid, field);
        else selected.remove();
        _redisMarkChanged(tid);
    }
}

// Redis key 右键菜单
function redisKeyCtx(event, cid, key, dbIdx) {
    event.preventDefault();
    var k = key;
    showCtxMenu(event.clientX, event.clientY, [
        {label: '🔍 打开详情', action: function(){ redisShowKey(cid, k, dbIdx); }},
        {label: '📋 复制 Key 名', action: function(){ navigator.clipboard.writeText(k).then(function(){ /* 静默复制 */ }); }},
        '---',
        {label: '🗑️ 删除此 Key', action: function(){
            if (confirm('确定删除 ' + JSON.stringify(k) + ' ?')) {
                eel.redis_delete_key(treeData.connections[cid], k, dbIdx)(function() {
                    redisKLRefresh(cid, dbIdx, _redisPanelCtx.dbId);
                });
            }
        }}
    ]);
}
function redisFilterData(tid) {
    var filter = (document.getElementById(tid+'_filter')||{}).value || '';
    filter = filter.toLowerCase();
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) {
        // string 类型不支持筛选表格
        var ta = document.getElementById(tid+'_str');
        if (!ta) return;
        var st2 = _redisEditState[tid];
        if (!st2 || !st2.original) return;
        var origVal = st2.original.value || '';
        if (filter) {
            var lines = String(origVal).split('\n');
            var filtered = lines.filter(function(l){return l.toLowerCase().indexOf(filter)!==-1;});
            ta.value = filtered.join('\n');
        } else {
            ta.value = String(origVal);
        }
        return;
    }
    var rows = tbody.querySelectorAll('tr');
    rows.forEach(function(row){
        // textContent 不含 <input> 的 value，需手动拼接
        var inputs = row.querySelectorAll('input');
        var inputVals = '';
        inputs.forEach(function(inp) { inputVals += (inp.value || '') + ' '; });
        var text = (row.textContent + ' ' + inputVals).toLowerCase();
        row.style.display = (filter && text.indexOf(filter)===-1) ? 'none' : '';
    });
}

// ---- 标记修改 ----
function _redisMarkChanged(tid) {
    var st = _redisEditState[tid];
    if (!st) return;
    st.changed[tid] = true;
    var saveBtn = document.getElementById(tid+'_save_btn');
    var cancelBtn = document.getElementById(tid+'_cancel_btn');
    if (saveBtn) saveBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
}

// ---- 删除行标记 ----
var _redisDeleteMarks = {};
function _redisMarkDeletedRow(tid, type, key) {
    if (!_redisDeleteMarks[tid]) _redisDeleteMarks[tid] = {};
    if (!_redisDeleteMarks[tid][type]) _redisDeleteMarks[tid][type] = [];
    _redisDeleteMarks[tid][type].push(key);
    _redisMarkChanged(tid);
}

// ---- 新增/删除行操作 ----
function _redisAddHashRow(tid) {
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) return;
    var idx = tbody.querySelectorAll('tr').length;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td style="padding:4px 8px;color:#555;">new</td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="新增 field" data-newfield="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="新增 value" data-newval="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;text-align:center;"><span style="color:#e74c3c;" onclick="this.closest(\'tr\').remove();_redisMarkChanged(\''+tid+'\')" title="删除">✕</span></td>';
    tbody.appendChild(tr);
    _redisMarkChanged(tid);
}

function _redisDelHashRow(tid, field) {
    var row = document.querySelector('#'+tid+'_row_'+field.replace(/[^a-zA-Z0-9]/g,'_'));
    // 更好的查找方式
    var tbody = document.getElementById(tid+'_tbody');
    var rows = tbody ? tbody.querySelectorAll('tr') : [];
    rows.forEach(function(r){
        var inp = r.querySelector('input[data-field="'+escapeAttr(field)+'"]');
        if (inp) { r.remove(); }
    });
    _redisMarkDeletedRow(tid, 'deleted_fields', field);
    _redisMarkChanged(tid);
}

function _redisAddListRow(tid) {
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) return;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td style="padding:4px 8px;color:#555;">new</td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="新增值" data-newitem="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;text-align:center;"><span style="color:#e74c3c;" onclick="this.closest(\'tr\').remove();_redisMarkChanged(\''+tid+'\')" title="删除">✕</span></td>';
    tbody.appendChild(tr);
    _redisMarkChanged(tid);
}

function _redisDelListRow(tid, idx) {
    var row = document.getElementById(tid+'_row_'+idx);
    if (row) row.remove();
    _redisMarkDeletedRow(tid, 'deleted_idxs', parseInt(idx));
    _redisMarkChanged(tid);
}

function _redisAddSetRow(tid) {
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) return;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td style="padding:4px 8px;color:#555;">new</td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="新增成员" data-newitem="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;text-align:center;"><span style="color:#e74c3c;" onclick="this.closest(\'tr\').remove();_redisMarkChanged(\''+tid+'\')" title="删除">✕</span></td>';
    tbody.appendChild(tr);
    _redisMarkChanged(tid);
}

function _redisDelSetRow(tid, idx) {
    var row = document.getElementById(tid+'_row_'+idx);
    if (row) row.remove();
    _redisMarkDeletedRow(tid, 'deleted_idxs', parseInt(idx));
    _redisMarkChanged(tid);
}

function _redisAddZSetRow(tid) {
    var tbody = document.getElementById(tid+'_tbody');
    if (!tbody) return;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td style="padding:4px 8px;color:#555;">new</td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="新增 member" data-newmember="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;"><input class="editable-cell" placeholder="score" data-newscore="1" ' +
            'oninput="_redisMarkChanged(\''+tid+'\')" spellcheck="false" autocomplete="off"></td>' +
        '<td style="padding:4px 8px;text-align:center;"><span style="color:#e74c3c;" onclick="this.closest(\'tr\').remove();_redisMarkChanged(\''+tid+'\')" title="删除">✕</span></td>';
    tbody.appendChild(tr);
    _redisMarkChanged(tid);
}

function _redisDelZSetRow(tid, idx) {
    var row = document.getElementById(tid+'_row_'+idx);
    if (row) row.remove();
    _redisMarkDeletedRow(tid, 'deleted_idxs', parseInt(idx));
    _redisMarkChanged(tid);
}

// ---- 收集编辑后的数据 ----
function _redisCollectChanges(tid) {
    var st = _redisEditState[tid];
    if (!st || !st.info) return null;
    var info = st.info;
    var result = {type: info.type};

    if (info.type === 'string') {
        var ta = document.getElementById(tid+'_str');
        result.value = ta ? ta.value : '';
    } else if (info.type === 'hash') {
        result.fields = {};
        result.deletes = (_redisDeleteMarks[tid] && _redisDeleteMarks[tid].deleted_fields) || [];
        var tbody = document.getElementById(tid+'_tbody');
        if (tbody) {
            var rows = tbody.querySelectorAll('tr');
            rows.forEach(function(r){
                var fieldInp = r.querySelector('input[data-field]');
                if (fieldInp) {
                    var f = fieldInp.getAttribute('data-field');
                    var newVal = fieldInp.value;
                    if (result.deletes.indexOf(f) === -1) {
                        result.fields[f] = newVal;
                    }
                }
                // 新增行
                var newField = r.querySelector('input[data-newfield]');
                var newVal2 = r.querySelector('input[data-newval]');
                if (newField && newVal2 && newField.value) {
                    result.fields[newField.value] = newVal2.value;
                }
            });
        }
    } else if (info.type === 'list') {
        var orig = Array.isArray(info.value) ? info.value : [];
        var dels = (_redisDeleteMarks[tid] && _redisDeleteMarks[tid].deleted_idxs) || [];
        var items = [];
        orig.forEach(function(v, i){
            if (dels.indexOf(i) === -1) items.push(v);
        });
        // 更新修改的值
        var tbody2 = document.getElementById(tid+'_tbody');
        if (tbody2) {
            var rows2 = tbody2.querySelectorAll('tr');
            rows2.forEach(function(r){
                var inp = r.querySelector('input[data-idx]');
                if (inp) {
                    var idx = parseInt(inp.getAttribute('data-idx'));
                    if (idx < items.length) items[idx] = inp.value;
                }
                // 新增
                var newInp = r.querySelector('input[data-newitem]');
                if (newInp && newInp.value) items.push(newInp.value);
            });
        }
        result.items = items;
    } else if (info.type === 'set') {
        var origS = Array.isArray(info.value) ? info.value : [];
        var delsS = (_redisDeleteMarks[tid] && _redisDeleteMarks[tid].deleted_idxs) || [];
        var members = [];
        origS.forEach(function(v, i){
            if (delsS.indexOf(i) === -1) members.push(v);
        });
        var tbodyS = document.getElementById(tid+'_tbody');
        if (tbodyS) {
            var rowsS = tbodyS.querySelectorAll('tr');
            rowsS.forEach(function(r){
                var inp = r.querySelector('input[data-idx]');
                if (inp) {
                    var idx = parseInt(inp.getAttribute('data-idx'));
                    if (idx < members.length) members[idx] = inp.value;
                }
                var newInp = r.querySelector('input[data-newitem]');
                if (newInp && newInp.value) members.push(newInp.value);
            });
        }
        result.members = members;
    } else if (info.type === 'zset') {
        var origZ = Array.isArray(info.value) ? info.value : [];
        var delsZ = (_redisDeleteMarks[tid] && _redisDeleteMarks[tid].deleted_idxs) || [];
        var itemsZ = [];
        origZ.forEach(function(it, i){
            if (delsZ.indexOf(i) === -1) itemsZ.push([it[0], parseFloat(it[1])||0]);
        });
        var tbodyZ = document.getElementById(tid+'_tbody');
        if (tbodyZ) {
            var rowsZ = tbodyZ.querySelectorAll('tr');
            rowsZ.forEach(function(r){
                var memInp = r.querySelector('input[data-type="member"]');
                var scrInp = r.querySelector('input[data-type="score"]');
                if (memInp && scrInp) {
                    var idx = parseInt(memInp.getAttribute('data-idx'));
                    if (idx < itemsZ.length) {
                        itemsZ[idx] = [memInp.value, parseFloat(scrInp.value)||0];
                    }
                }
                var nm = r.querySelector('input[data-newmember]');
                var ns = r.querySelector('input[data-newscore]');
                if (nm && ns && nm.value) {
                    itemsZ.push([nm.value, parseFloat(ns.value)||0]);
                }
            });
        }
        result.items = itemsZ;
    }
    return result;
}

// ---- 保存 ----
function redisSaveChanges(tid) {
    var st = _redisEditState[tid];
    if (!st) return;
    var changes = _redisCollectChanges(tid);
    if (!changes) return;
    var conn = treeData && treeData.connections ? treeData.connections[st.cid] : null;
    if (!conn) { showErrorDialog('错误', '连接信息丢失'); return; }

    var saveBtn = document.getElementById(tid+'_save_btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ 保存中...'; }

    var callback = function(r){
        if (saveBtn) { saveBtn.textContent = '💾 保存'; saveBtn.disabled = true; }
        if (r && r.ok) {
            // 刷新显示
            redisRefreshKey(st.cid, st.key, st.dbIdx);
            showOkDialog('成功', r.msg || '保存成功');
        } else {
            showErrorDialog('失败', r ? r.msg : '保存失败');
        }
    };

    if (changes.type === 'string') {
        eel.redis_set_string(conn, st.key, changes.value, st.dbIdx)(callback);
    } else if (changes.type === 'hash') {
        eel.redis_set_hash(conn, st.key, changes.fields, changes.deletes, st.dbIdx)(callback);
    } else if (changes.type === 'list') {
        eel.redis_set_list(conn, st.key, changes.items, st.dbIdx)(callback);
    } else if (changes.type === 'set') {
        eel.redis_set_set(conn, st.key, changes.members, st.dbIdx)(callback);
    } else if (changes.type === 'zset') {
        eel.redis_set_zset(conn, st.key, changes.items, st.dbIdx)(callback);
    }
}

// ---- 取消 ----
function redisCancelChanges(tid) {
    var st = _redisEditState[tid];
    if (!st || !st.original) return;
    _redisDeleteMarks[tid] = {};
    _redisEditState[tid].changed = {};
    renderRedisData(tid, st.original);
}

// ---- 刷新 ----
function redisRefreshKey(cid, key, dbIdx) {
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) return;
    var tid = 'redis_' + key.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_') + '_' + (dbIdx||0);
    var labelKey = key.length > 6 ? key.substring(0, 6) + '…' : key;
    var label = (dbIdx !== undefined ? '[DB'+dbIdx+'] ' : '') + '🔑 '+labelKey;
    _redisDeleteMarks[tid] = {};
    // 更新 tab 状态
    var tab = objectTabs.find(function(t){return t.id==='obj_redis';});
    if (!tab) {
        objectTabs = [{id:'obj_redis',label:label,type:'redis',content:'<div style="padding:8px 12px;color:#888;">⏳ 刷新中...</div>',key:key,cid:cid,db:dbIdx,tid:tid}];
    } else {
        tab.content = '<div style="padding:8px 12px;color:#888;">⏳ 刷新中...</div>';
        tab.key = key; tab.cid = cid; tab.db = dbIdx; tab.tid = tid;
    }
    activeObjTab = 'obj_redis';
    activeCatId = null;
    _redisEditState[tid] = {info: null, changed: {}, original: null, cid: cid, key: key, dbIdx: dbIdx};
    renderObjectPanel();
    eel.redis_get_key_info(conn, key, dbIdx)(function(r) {
        if (!r || !r.ok) {
            updateRedisTab(tid, '<div style="padding:8px 12px;color:#e74c3c;">❌ '+(r?r.msg:'刷新失败')+'</div>');
            return;
        }
        _redisEditState[tid].info = r.info;
        _redisEditState[tid].original = JSON.parse(JSON.stringify(r.info));
        _redisEditState[tid].changed = {};
        renderRedisData(tid, r.info);
    });
}

// ---- 删除（保留用于右键菜单等） ----
function redisDeleteKey(cid, key, dbIdx) {
    showConfirmDialog('确认删除', '确定删除 key ['+key+']？此操作不可恢复！', function(){
        eel.redis_delete_key(activeConnData, key, dbIdx)(function(r) {
            if (r && r.ok) {
                showOkDialog('成功', r.msg);
                objectTabs = [{id:'obj_home',label:'对象',type:'home',content:'<div style="padding:40px;text-align:center;color:#666;"><div style="font-size:36px;margin-bottom:10px;">📄</div><div>已删除</div></div>'}];
                activeObjTab = 'obj_home';
                renderObjectPanel();
            } else {
                showErrorDialog('失败', r ? r.msg : '删除失败');
            }
        });
    });
}

// Redis 命令执行面板
function showRedisCmdPanel(cid) {
    activeConnId = cid;
    activeConnData = treeData && treeData.connections ? treeData.connections[cid] : null;
    var html = '<div style="display:flex;flex-direction:column;height:100%;">' +
        '<div style="display:flex;gap:6px;padding:6px 0;flex-shrink:0;">' +
            '<input type="text" id="redis_cmd_input" placeholder="输入 Redis 命令，如 GET key / KEYS * / TYPE key" ' +
                'style="flex:1;height:30px;background:#0d1117;border:1px solid #333;color:#e0e0e0;padding:4px 8px;font-family:Consolas,monospace;font-size:12px;border-radius:4px;" ' +
                'onkeydown="if(event.key===\'Enter\')redisExecCmd(\''+cid+'\')">' +
            '<button class="btn btn-blue btn-sm" onclick="redisExecCmd(\''+cid+'\')" style="height:30px;">▶ 执行</button>' +
        '</div>' +
        '<div id="redis_cmd_result" style="flex:1;overflow:auto;background:#0d1117;border:1px solid #333;border-radius:4px;padding:8px 12px;font-family:Consolas,monospace;font-size:12px;color:#e0e0e0;min-height:200px;white-space:pre-wrap;">' +
            '<div style="color:#888;">输入命令后按回车或点击执行...</div>' +
        '</div></div>';
    objectTabs = [{id:'obj_redis_cmd',label:'💻 Redis 命令',type:'redis_cmd',content:html,cid:cid}];
    activeObjTab = 'obj_redis_cmd';
    activeCatId = null;
    renderObjectPanel();
}

// Redis 查询 Tab 执行：逐行执行 Redis 命令
function execRedisQueryTab(qid, btnExe, resultsDiv, cmdText) {
    // 按换行拆分，过滤空行和注释行
    var lines = cmdText.split('\n').map(function(l) { return l.trim(); })
        .filter(function(l) { return l && !l.startsWith('--'); });
    if (!lines.length) {
        resultsDiv.innerHTML = '<div style="padding:10px;color:#f39c12;">⚠ 无可执行的命令</div>';
        _execCancelFlags[qid] = false;
        if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
        return;
    }
    var allResults = [];
    var pending = 0;

    lines.forEach(function(cmd, i) {
        pending++;
        eel.redis_execute(activeConnData, cmd)(function(r) {
            var resultHtml = '';
            if (!r || !r.ok) {
                resultHtml = '<span style="color:#e74c3c;">❌ ' + escapeHtml(r ? r.msg : '执行失败') + '</span>';
            } else {
                var res = r.result;
                var display;
                if (res === null || res === undefined) {
                    display = '(nil)';
                } else if (typeof res === 'object') {
                    if (Array.isArray(res)) {
                        display = res.map(function(item, idx) {
                            if (Array.isArray(item)) return (idx + 1) + ') ' + item[0] + ' [' + item[1] + ']';
                            return (idx + 1) + ') ' + escapeHtml(String(item));
                        }).join('\n');
                    } else {
                        display = JSON.stringify(res, null, 2);
                    }
                } else {
                    display = String(res);
                }
                resultHtml = '<span style="white-space:pre-wrap;">' + escapeHtml(display) + '</span>'
                    + (r.info && r.info.elapsed ? ' <span style="color:#555;font-size:10px;">(' + r.info.elapsed + ')</span>' : '');
            }
            allResults[i] = resultHtml;
            pending--;
            if (pending === 0) {
                if (_execCancelFlags[qid]) {
                    _execCancelFlags[qid] = false;
                    if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
                    resultsDiv.innerHTML = '<div style="padding:10px;color:#f39c12;">⏸ 执行已取消</div>';
                    return;
                }
                _execCancelFlags[qid] = false;
                if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
                // 渲染所有结果
                var html = '';
                lines.forEach(function(cmd2, j) {
                    html += '<div style="margin-bottom:12px;">'
                        + '<div style="color:#2ecc71;font-family:Consolas,monospace;font-size:12px;margin-bottom:4px;">&gt; ' + escapeHtml(cmd2) + '</div>'
                        + '<div style="color:#e0e0e0;font-family:Consolas,monospace;font-size:12px;padding-left:8px;">' + (allResults[j] || '') + '</div>'
                        + '</div>';
                });
                resultsDiv.innerHTML = html;
            }
        });
    });
}

function redisExecCmd(cid) {
    var input = document.getElementById('redis_cmd_input');
    var cmd = input ? input.value.trim() : '';
    if (!cmd) return;
    var resultDiv = document.getElementById('redis_cmd_result');
    if (resultDiv) resultDiv.innerHTML = '<div style="color:#888;">⏳ 执行中...</div>';
    eel.redis_execute(activeConnData, cmd)(function(r) {
        if (!resultDiv) return;
        if (!r || !r.ok) {
            resultDiv.innerHTML = '<div style="color:#e74c3c;">❌ '+(r?r.msg:'执行失败')+'</div>';
            return;
        }
        var res = r.result;
        var display;
        if (res === null || res === undefined) {
            display = '(nil)';
        } else if (typeof res === 'object') {
            if (Array.isArray(res)) {
                display = res.map(function(item,i){
                    if (Array.isArray(item)) return (i+1)+') '+item[0]+' ['+item[1]+']';
                    return (i+1)+') '+escapeHtml(String(item));
                }).join('\n');
            } else {
                display = JSON.stringify(res, null, 2);
            }
        } else {
            display = String(res);
        }
        resultDiv.innerHTML = '<div style="color:#2ecc71;">> '+escapeHtml(cmd)+'</div><div style="margin-top:4px;">'+escapeHtml(display)+'</div>';
    });
}

// ==================== 初始化（已移至文件顶部 ====================
