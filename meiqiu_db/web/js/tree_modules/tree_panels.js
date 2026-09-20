// ==================== 面板切换 ====================
function showPanel(name) {
    document.querySelectorAll('.content-panel').forEach(function (p) { p.classList.remove('active'); });
    var panel = document.getElementById('panel_' + name);
    if (panel) panel.classList.add('active');
    document.querySelectorAll('.top-tab-btn').forEach(function (b) { b.classList.remove('active'); });
    var tabMap = { my_connections: 0, sync: 1, slowquery: 2 };
    var idx = tabMap[name];
    if (idx !== undefined) {
        var btns = document.querySelectorAll('.top-tab-btn');
        if (btns[idx]) btns[idx].classList.add('active');
    }
    // 切换到慢SQL面板时，刷新连接选择器
    if (name === 'slowquery' && typeof refreshSqConnSelector === 'function') {
        setTimeout(refreshSqConnSelector, 50);
    }
    // 切换到数据库同步面板时，刷新已有连接下拉框
    if (name === 'sync' && typeof refreshSyncConnSelectors === 'function') {
        setTimeout(refreshSyncConnSelectors, 50);
    }
}

// ==================== 我的连接列表 ====================
var _myConnSearchKw = '';
var _myConnSearchTimer = null;
var _myConnSearchSeq = 0;
var _myConnTableCache = {};

function toggleConnSidebar() {
    var panel = document.getElementById('split_left_panel');
    var button = document.getElementById('conn_sidebar_toggle');
    if (!panel) return;
    var collapsed = panel.classList.toggle('conn-sidebar-collapsed');
    if (button) {
        button.title = collapsed ? '展开侧边栏' : '折叠侧边栏';
        button.setAttribute('aria-label', button.title);
        var icon = button.querySelector('span');
        if (icon) icon.textContent = collapsed ? '»' : '«';
    }
    try { localStorage.setItem('conn_sidebar_collapsed', collapsed ? '1' : '0'); } catch (ignore) {}
}

function _myConnDirectChildren(node) {
    var children = node ? node.children : [];
    for (var i = 0; i < children.length; i++) {
        if (children[i].classList && children[i].classList.contains('tree-children')) return children[i];
    }
    return null;
}

function _myConnNodeIsUnderOpenConnection(node) {
    var parent = node && node.parentElement;
    while (parent && parent.id !== 'my_conn_list') {
        if (parent.classList && parent.classList.contains('tree-children')) return parent.classList.contains('open');
        parent = parent.parentElement;
    }
    return false;
}

function _getOpenTableSearchTargets() {
    var targets = [], seen = {};
    function add(node, cid, db, schema, label, requireOpenChildren) {
        if (!node || !cid || !db || !_myConnNodeIsUnderOpenConnection(node)) return;
        var children = _myConnDirectChildren(node);
        if (requireOpenChildren !== false && (!children || !children.classList.contains('open'))) return;
        var key = cid + '\0' + db + '\0' + (schema || '');
        if (seen[key]) return;
        seen[key] = true;
        targets.push({
            cid: cid,
            db: db,
            schema: schema || '',
            connName: (treeData.connections[cid] && treeData.connections[cid].name) || cid,
            dbName: db,
            label: label || db
        });
    }
    document.querySelectorAll('#my_conn_list .db-node[data-cid][data-db]').forEach(function(node) {
        var cid = node.getAttribute('data-cid');
        var db = node.getAttribute('data-db');
        var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
        if (conn && conn.db_type !== 'redis' &&
            (conn.db_type !== 'postgresql' || !node.querySelector('.pg-schema-node'))) {
            add(node, cid, db, '', (conn.name || cid) + ' / ' + db);
        }
    });
    document.querySelectorAll('#my_conn_list .ora-schema-node[data-cid][data-schema]').forEach(function(node) {
        var cid = node.getAttribute('data-cid');
        var schema = node.getAttribute('data-schema');
        var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
        if (conn) add(node, cid, schema, '', (conn.name || cid) + ' / ' + schema);
    });
    document.querySelectorAll('#my_conn_list .pg-schema-node[data-cid][data-db][data-schema]').forEach(function(node) {
        var cid = node.getAttribute('data-cid');
        var db = node.getAttribute('data-db');
        var schema = node.getAttribute('data-schema');
        var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
        if (conn) add(node, cid, db, schema, (conn.name || cid) + ' / ' + db + ' / ' + schema, false);
    });
    return targets;
}

function _loadTableSearchTarget(target, callback) {
    var key = target.cid + '\0' + target.db + '\0' + target.schema;
    if (Object.prototype.hasOwnProperty.call(_myConnTableCache, key)) {
        callback(_myConnTableCache[key]);
        return;
    }
    var conn = treeData && treeData.connections ? treeData.connections[target.cid] : null;
    if (!conn || typeof loadCategoryItems !== 'function') { callback([]); return; }
    loadCategoryItems(conn, target.db, 'tables', function(items) {
        _myConnTableCache[key] = items || [];
        callback(_myConnTableCache[key]);
    }, target.schema);
}

function _renderMyConnTableSearchResults(keyword, results, targetCount) {
    var box = document.getElementById('my_conn_search_results');
    if (!box) return;
    if (!results.length) {
        box.innerHTML = '<div class="my-conn-search-status">未找到匹配的表（已搜索 '+targetCount+' 个打开的数据库）</div>';
        return;
    }
    // 异步查询返回顺序不固定，先排序，保证多个连接/数据库的结果稳定、完整地展示。
    results.sort(function(a, b) {
        return (a.connName || '').localeCompare(b.connName || '') ||
            (a.db || '').localeCompare(b.db || '') ||
            (a.schema || '').localeCompare(b.schema || '') ||
            a.name.localeCompare(b.name);
    });
    var groups = {};
    results.forEach(function(item) {
        var key = item.cid + '\0' + item.db + '\0' + item.schema;
        if (!groups[key]) groups[key] = {
            label: item.label,
            connName: item.connName,
            db: item.db,
            schema: item.schema,
            cid: item.cid,
            tables: []
        };
        groups[key].tables.push(item.name);
    });
    var html = '<div class="my-conn-search-status">找到 '+results.length+' 张表</div>';
    Object.keys(groups).forEach(function(key) {
        var group = groups[key];
        var location = '连接：' + group.connName + '  /  数据库：' + group.db;
        if (group.schema) location += '  /  Schema：' + group.schema;
        html += '<div class="my-conn-search-group"><div class="my-conn-search-group-title">'+escapeHtml(location)+'</div>';
        group.tables.forEach(function(name) {
            if (typeof _renderTableNode === 'function') {
                html += _renderTableNode(name, 18, (window.MQ_ICON && window.MQ_ICON.table) || '📊', group.db, group.schema, group.cid, group.schema || group.db);
            }
        });
        html += '</div>';
    });
    box.innerHTML = html;
}

function _searchOpenDatabaseTables(keyword, seq) {
    var box = document.getElementById('my_conn_search_results');
    if (!box) return;
    var targets = _getOpenTableSearchTargets();
    if (!targets.length) {
        box.innerHTML = '<div class="my-conn-search-status">请先展开连接并打开数据库，再搜索表名</div>';
        return;
    }
    box.innerHTML = '<div class="my-conn-search-status">正在搜索 '+targets.length+' 个打开的数据库...</div>';
    var results = [], pending = targets.length;
    targets.forEach(function(target) {
        _loadTableSearchTarget(target, function(items) {
            if (seq !== _myConnSearchSeq) return;
            (items || []).forEach(function(item) {
                var name = item && item.name ? item.name : item;
                if (name && String(name).toLowerCase().indexOf(keyword) !== -1) {
                    results.push({
                        name: String(name),
                        cid: target.cid,
                        db: target.db,
                        schema: target.schema,
                        label: target.label,
                        connName: target.connName,
                        dbName: target.dbName
                    });
                }
            });
            pending--;
            if (!pending) _renderMyConnTableSearchResults(keyword, results, targets.length);
        });
    });
}

function filterMyConnections(value) {
    _myConnSearchKw = String(value || '').trim().toLowerCase();
    var list = document.getElementById('my_conn_list');
    var results = document.getElementById('my_conn_search_results');
    if (!list || !results) return;
    if (_myConnSearchTimer) clearTimeout(_myConnSearchTimer);
    var seq = ++_myConnSearchSeq;
    if (!_myConnSearchKw) {
        list.style.display = '';
        results.style.display = 'none';
        results.innerHTML = '';
        return;
    }
    list.style.display = 'none';
    results.style.display = 'block';
    results.innerHTML = '<div class="my-conn-search-status">准备搜索已打开数据库...</div>';
    _myConnSearchTimer = setTimeout(function() { _searchOpenDatabaseTables(_myConnSearchKw, seq); }, 180);
}

function clearMyConnectionsSearch() {
    var input = document.getElementById('my_conn_search');
    if (input) input.value = '';
    filterMyConnections('');
    if (input) input.focus();
}

// 刷新连接列表前保存左侧树状态。连接列表会整体重建，单纯保存 open
// 标记不够，还需要保留已经加载的数据库/分类/表节点 HTML。
function _captureMyConnectionsTreeState() {
    var list = document.getElementById('my_conn_list');
    var state = { folders: {}, connections: {} };
    if (!list) return state;

    list.querySelectorAll('.tree-node[data-fid]').forEach(function(node) {
        var fid = node.getAttribute('data-fid');
        var children = _myConnDirectChildren(node);
        var row = null;
        for (var i = 0; i < node.children.length; i++) {
            if (node.children[i].classList && node.children[i].classList.contains('folder-row')) {
                row = node.children[i];
                break;
            }
        }
        var arrow = row ? row.querySelector('.arrow') : null;
        if (fid) state.folders[fid] = {
            open: !!(children && children.classList.contains('open')),
            arrowText: arrow ? arrow.textContent : '',
            arrowVisibility: arrow ? arrow.style.visibility : '',
            highlighted: !!(row && row.classList.contains('tree-highlight'))
        };
    });

    list.querySelectorAll('.tree-node > .conn-row').forEach(function(row) {
        var node = row.parentElement;
        var cid = node && node.getAttribute('data-cid');
        var children = _myConnDirectChildren(node);
        var arrow = row.querySelector('.arrow');
        var icon = row.querySelector('.db-icon');
        if (!cid) return;
        state.connections[cid] = {
            open: !!(children && children.classList.contains('open')),
            childrenClassName: children ? children.className : 'tree-children',
            childrenHtml: children ? children.innerHTML : '',
            arrowText: arrow ? arrow.textContent : '',
            arrowVisibility: arrow ? arrow.style.visibility : '',
            iconClassName: icon ? icon.className : '',
            highlighted: row.classList.contains('tree-highlight')
        };
    });
    return state;
}

function _restoreMyConnectionsTreeState(state) {
    if (!state) return;
    Object.keys(state.folders || {}).forEach(function(fid) {
        var saved = state.folders[fid];
        var node = document.querySelector('#my_conn_list .tree-node[data-fid="' + fid + '"]');
        if (!node) return;
        var children = document.getElementById('mc_' + fid);
        var row = node.querySelector('.folder-row');
        var arrow = document.getElementById('ma_' + fid);
        if (children) children.classList.toggle('open', saved.open);
        if (arrow) {
            if (saved.arrowText) arrow.textContent = saved.arrowText;
            arrow.style.visibility = saved.arrowVisibility || '';
        }
        if (row) row.classList.toggle('tree-highlight', saved.highlighted);
    });

    Object.keys(state.connections || {}).forEach(function(cid) {
        var saved = state.connections[cid];
        var node = document.querySelector('#my_conn_list .tree-node[data-cid="' + cid + '"]');
        if (!node) return;
        var row = node.querySelector(':scope > .conn-row');
        var children = document.getElementById('mc_c_' + cid);
        var arrow = document.getElementById('ma_c_' + cid);
        var icon = row ? row.querySelector('.db-icon') : null;
        if (children) {
            children.className = saved.childrenClassName || 'tree-children';
            children.innerHTML = saved.childrenHtml || '';
        }
        if (arrow) {
            if (saved.arrowText) arrow.textContent = saved.arrowText;
            arrow.style.visibility = saved.arrowVisibility || '';
        }
        if (icon && saved.iconClassName) icon.className = saved.iconClassName;
        if (row) row.classList.toggle('tree-highlight', saved.highlighted);
    });
}

function renderMyConnectionsList(treeState) {
    if (!treeData) { console.warn('[tree.js] renderMyConnectionsList: treeData 为空，跳过渲染'); return; }
    var list = document.getElementById('my_conn_list');
    if (!list) { console.warn('[tree.js] renderMyConnectionsList: #my_conn_list 不存在'); return; }
    var sidebar = document.getElementById('split_left_panel');
    try {
        var shouldCollapse = localStorage.getItem('conn_sidebar_collapsed') === '1';
        if (sidebar && sidebar.classList.contains('conn-sidebar-collapsed') !== shouldCollapse) toggleConnSidebar();
    } catch (ignore) {}
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
    _restoreMyConnectionsTreeState(treeState);
    // 根区域作为 drop 目标（拖连接移出文件夹）
    if (_myConnSearchKw) filterMyConnections(_myConnSearchKw);
    list.ondragover = onConnRootDragOver;
    list.ondragleave = onConnRootDragLeave;
    list.ondrop = onConnRootDrop;
    // ★ 初始化可拖拽分隔条
    if (typeof initConnSplitter === 'function') initConnSplitter();
    if (typeof initInfoSplitter === 'function') initInfoSplitter();
    // ★ 绑定连接行悬浮 Tooltip（事件委托）
    list.onmouseover = function(e) {
        var row = e.target && e.target.closest('.conn-row');
        if (!row) return;
        var node = row.closest('.tree-node[data-cid]');
        if (!node) return;
        var cid = node.getAttribute('data-cid');
        if (cid) _showConnTooltip(row, cid);
    };
    list.onmouseout = function(e) {
        var row = e.target && e.target.closest('.conn-row');
        if (!row) return;
        var rel = e.relatedTarget;
        if (rel && row.contains(rel)) return; // 仍在当前行内部移动
        _hideConnTooltip();
    };
    list.onmouseleave = function() { _hideConnTooltip(); };
}

function getConnectionsByFolder(pid) {
    var r = [];
    for (var k in treeData.connections) {
        if ((treeData.connections[k].parent || '') === pid) r.push(treeData.connections[k]);
    }
    // 启动加载及每次重绘都按连接名称排序，避免对象键顺序影响左侧树的显示顺序。
    r.sort(function (a, b) {
        var nameA = String((a && a.name) || '').trim();
        var nameB = String((b && b.name) || '').trim();
        var result = nameA.localeCompare(nameB, 'zh-CN', {
            numeric: true,
            sensitivity: 'base'
        });
        // 同名时使用 ID 保证顺序稳定。
        return result || String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
    });
    return r;
}

function renderFolder(f, indent) {
    var fid = f.id;
    var subs = (treeData.folders || []).filter(function (x) { return x.parent === f.id; });
    var conns = getConnectionsByFolder(fid);
    var hasKids = subs.length > 0 || conns.length > 0;
    return '<div class="tree-node" data-fid="'+fid+'"><div class="my-conn-row folder-row drop-folder" style="padding-left:'+(indent+12)+'px" onclick="event.stopPropagation();highlightRow(this);toggleChildren(\'mc_'+fid+'\',\'ma_'+fid+'\')" ondblclick="event.stopPropagation()" oncontextmenu="folderCtx(event,\''+fid+'\')" ondragover="onConnFolderDragOver(event,this,\''+fid+'\')" ondragleave="onConnFolderDragLeave(event,this)" ondrop="onConnFolderDrop(event,\''+fid+'\')">' +
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
    // ★ 环境颜色：行背景 + 名称后色点
    var colorStyle = _connColorStyle(c.color);
    var colorDot = c.color ? '<span class="conn-color-dot" style="background:'+escapeHtml(c.color)+'"></span>' : '';
    return '<div class="tree-node" data-cid="'+cid+'"><div class="my-conn-row conn-row drag-conn-item conn-color-tint" draggable="true" style="padding-left:'+pad+'px;'+colorStyle+'" onclick="showConnInfo(\''+cid+'\')" ondblclick="expandConn(\''+cid+'\','+pad+')" oncontextmenu="connCtx(event,\''+cid+'\')" ondragstart="onConnDragStart(event,\''+cid+'\')" ondragend="onConnDragEnd(event,\''+cid+'\')">' +
        '<span class="arrow" id="ma_c_'+cid+'" onclick="event.stopPropagation();toggleConnChildren(\''+cid+'\')" style="visibility:hidden">▸</span>' +
        '<span class="my-conn-icon db-icon closed">'+icon+'</span><span class="my-conn-name">'+escapeHtml(c.name)+colorDot+'</span>' +
        '</div>' +
        '<div class="tree-children" id="mc_c_'+cid+'"></div></div>';
}

// MySQL 连接级功能：用户与权限不属于某一个具体数据库，放在数据库列表之后。
function renderConnUsersNode(cid, pad, conn) {
    conn = conn || (treeData && treeData.connections ? treeData.connections[cid] : null);
    if (!conn || (conn.db_type !== 'mysql' && conn.db_type !== 'ob-mysql')) return '';
    return '<div class="my-conn-row conn-users-node" style="padding-left:'+(pad+20)+'px" ' +
        'onclick="clickUsersPrivileges(\''+escapeAttr(cid)+'\');highlightRow(this)" ' +
        'title="查看用户、授权、密码和账户状态">' +
        '<span class="my-conn-icon">♙</span><span class="my-conn-name">用户与权限</span></div>';
}

/** 把 hex 颜色转成"行背景 + 文本不透明"的样式（深色主题 18% 透明，浅色主题 12%） */
function _connColorStyle(hex) {
    if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return '';
    var r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
    // 用 CSS color-mix 混合让透明度随主题自适应
    return 'background:rgba('+r+','+g+','+b+',0.18);';
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
    // 切换连接时确保 home tab 存在，不强制切换（保留用户当前 tab）
    var homeContent = '<div style="padding:40px;text-align:center;color:#666;"><div style="font-size:36px;margin-bottom:10px;">📄</div><div>点击表、视图等分类查看对象</div></div>';
    var homeTab = objectTabs.find(function(t){return t.id==='obj_home';});
    if (!homeTab) { objectTabs.push({id:'obj_home',label:'对象',type:'home',content:homeContent,db:''}); }
    else { homeTab.content = homeContent; }
    activeCatId = null;
    renderObjectPanel();

    var isPg = conn.db_type === 'postgresql';
    var isRedis = conn.db_type === 'redis';
    var isOra = conn.db_type === 'oracle';
    if (isRedis) {
        // Redis 连接展开 → 显示数据库列表（db0, db1, ...）
        children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#999;font-size:11px;">⏳ 加载数据库列表...</div>';
        var redisTimeoutId = setTimeout(function() {
            children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌ 加载超时（15秒），请检查 Redis 连接是否正常</div>';
            // ★ 超时时移除 open class，允许用户重试双击展开
            children.classList.remove('open');
        }, 15000);
        console.log('调用redis_get_databases', conn.host);
        if (typeof eel === 'undefined') {
            console.error('eel 对象未定义！确保 main.js 已加载且 Eel 已初始化');
            children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌ JS错误: eel未定义</div>';
            children.classList.remove('open');
            return;
        }
        try {
            eel.redis_get_databases(conn)(function(r) {
                console.log('Redis DB列表回调触发', r);
                clearTimeout(redisTimeoutId);
                if (!r) { console.error('Redis DB列表返回null'); children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌ 返回null</div>'; children.classList.remove('open'); return; }
                if (!r.ok) { console.error('Redis DB列表返回ok=false:', r.msg); children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌ '+escapeHtml(r?r.msg:'')+'</div>'; children.classList.remove('open'); return; }
                console.log('Redis DB列表成功:', (r.databases||[]).length, '个DB');
                var html = '';
                // 顶部信息栏
                var totalKeys = 0;
                (r.databases||[]).forEach(function(d){ totalKeys += d.keys; });
                html += '<div style="padding-left:'+(pad+20)+'px;color:#888;font-size:10px;padding-top:4px;padding-bottom:6px;">共 '+(r.databases||[]).length+' 个DB，'+totalKeys+' 个 key</div>';
                (r.databases||[]).forEach(function(dbInfo) {
                    var dbIdx = dbInfo.db;
                    var dbId = cid + '_rdb_' + dbIdx;
                    html += '<div class="tree-node"><div class="my-conn-row" style="padding-left:'+(pad+20)+'px" onclick="showDbInfo(\''+cid+'\',\''+dbIdx+'\')" ondblclick="expandRedisDb(\''+cid+'\','+dbIdx+',\''+dbId+'\','+(pad+20)+')">' +
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
            children.classList.remove('open');
        }
        return;
    }
    // 非 Redis 连接：异步非阻塞加载数据库列表
    _eelAutoAsync(eel.db_explore_get_databases(conn), function (r) {
        console.log('[expandConn] db_explore_get_databases callback:', JSON.stringify(r).substring(0, 200));
        if (!r || !r.ok) {
            children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌ '+escapeHtml(r?r.msg:'无响应')+'</div>';
            // ★ 失败时移除 open class，允许用户重试双击展开
            children.classList.remove('open');
            return;
        }
        var html = '';
        var dbs = r.databases || [];
        // Oracle: 每个 Schema 作为独立文件夹展示（类似 Navicat / PL/SQL Developer）
        if (isOra) {
            window._oraSchemas = dbs;
            if (dbs.length > 0) {
                activeDatabase = dbs[0];
                dbs.forEach(function(schema) {
                    var schemaId = cid + '_ora_' + safeBtoa(schema);
                    html += '<div class="tree-node ora-schema-node" data-cid="'+cid+'" data-schema="'+escapeAttr(schema)+'">' +
                        '<div class="my-conn-row" style="padding-left:'+(pad+20)+'px" onclick="showOraSchemaInfo(\''+cid+'\',\''+escapeAttr(schema)+'\');highlightRow(this)" ondblclick="expandOraSchema(\''+cid+'\',\''+escapeAttr(schema)+'\',\''+schemaId+'\','+(pad+20)+')">' +
                        '<span class="arrow" id="ar_'+schemaId+'" onclick="event.stopPropagation();toggleOraSchema(\''+cid+'\',\''+escapeAttr(schema)+'\',\''+schemaId+'\','+(pad+20)+')">▸</span>' +
                        '<span class="my-conn-icon db-icon closed">'+DB_ICON_SVG+'</span>' +
                        '<span class="my-conn-name">'+escapeHtml(schema)+'</span></div>' +
                        '<div class="tree-children" id="'+schemaId+'"></div></div>';
                });
            }
        } else {
            dbs.forEach(function (db) {
                var dbId = cid + '_db_' + safeBtoa(db);
                var dropAttrs = ' ondragover="onDbDragOver(event,this)" ondragleave="onDbDragLeave(event,this)" ondrop="onDbDrop(event,this,\''+cid+'\',\''+escapeAttr(db)+'\')"';
                var ctxAttr = ' oncontextmenu="dbCtx(event,\''+cid+'\',\''+escapeAttr(db)+'\',\''+dbId+'\')"';
                if (isPg) {
                    html += '<div class="tree-node db-node" data-cid="'+cid+'" data-db="'+escapeAttr(db)+'"><div class="my-conn-row" style="padding-left:'+(pad+20)+'px"'+dropAttrs+ctxAttr+' onclick="showDbInfo(\''+cid+'\',\''+escapeAttr(db)+'\')" ondblclick="selectDatabase(\''+cid+'\',\''+escapeAttr(db)+'\',\''+dbId+'\',\'ar_'+dbId+'\')">' +
                        '<span class="arrow" id="ar_'+dbId+'" onclick="event.stopPropagation();toggleDbChildren(\''+dbId+'\',\'ar_'+dbId+'\')" style="visibility:hidden">▸</span><span class="my-conn-icon db-icon closed">'+DB_ICON_SVG+'</span><span class="my-conn-name">'+escapeHtml(db)+'</span></div>' +
                        '<div class="tree-children" id="'+dbId+'"></div></div>';
                } else {
                    html += '<div class="tree-node db-node" data-cid="'+cid+'" data-db="'+escapeAttr(db)+'"><div class="my-conn-row" style="padding-left:'+(pad+20)+'px"'+dropAttrs+ctxAttr+' onclick="showDbInfo(\''+cid+'\',\''+escapeAttr(db)+'\')" ondblclick="selectDatabase(\''+cid+'\',\''+escapeAttr(db)+'\',\''+dbId+'\',\'ar_'+dbId+'\')">' +
                        '<span class="arrow" id="ar_'+dbId+'" onclick="event.stopPropagation();toggleDbChildren(\''+dbId+'\',\'ar_'+dbId+'\')">▸</span><span class="my-conn-icon db-icon closed">'+DB_ICON_SVG+'</span><span class="my-conn-name">'+escapeHtml(db)+'</span></div>' +
                        '<div class="tree-children" id="'+dbId+'">' + renderDbCats(cid, db, pad+40) + '</div></div>';
                }
            });
            html += renderConnUsersNode(cid, pad, conn);
        }
        children.innerHTML = html || '<div style="padding-left:'+(pad+20)+'px;color:#999;font-size:11px;">（无数据库）</div>';
    });
}

function renderDbCats(cid, db, pad, schema) {
    var key = schema ? db+'/'+schema : db;
    var dbKey = safeBtoa(key);
    var p = pad + 16;
    var sch = schema || '';
    return catRow('tables',(window.MQ_ICON&&window.MQ_ICON.table)||'📋',cid,db,dbKey,p,'clickTableCat','tableCatCtx',sch) +
           catRow('views','👁',cid,db,dbKey,p,'clickCat','',sch) +
           catRow('procedures','⚙',cid,db,dbKey,p,'clickCat','',sch) +
           catRow('functions','𝑓',cid,db,dbKey,p,'clickCat','',sch) +
           catRow('queries','📝',cid,db,dbKey,p,'clickQueries','qLabelCtx',sch);
}

function renderOraCats(cid, db, pad) {
    var dbKey = safeBtoa(db);
    var p = pad + 16;
    return catRow('tables',    (window.MQ_ICON&&window.MQ_ICON.table)||'📊',cid,db,dbKey,p,'clickTableCat','tableCatCtx','') +
           catRow('views',     '👁',cid,db,dbKey,p,'clickCat','','') +
           catRow('mviews',    '📋',cid,db,dbKey,p,'clickCat','','') +
           catRow('indexes',   '🔍',cid,db,dbKey,p,'clickCat','','') +
           catRow('sequences', '🔢',cid,db,dbKey,p,'clickCat','','') +
           catRow('synonyms',  '🔗',cid,db,dbKey,p,'clickCat','','') +
           catRow('functions', '𝑓',cid,db,dbKey,p,'clickCat','','') +
           catRow('procedures','⚙',cid,db,dbKey,p,'clickCat','','') +
           catRow('packages',  '📦',cid,db,dbKey,p,'clickCat','','') +
           catRow('triggers',  '⚡',cid,db,dbKey,p,'clickCat','','') +
           catRow('queries',   '📝',cid,db,dbKey,p,'clickQueries','qLabelCtx','');
}
// ★ Oracle Schema 文件夹交互（点击 / 展开 / 折叠）
function showOraSchemaInfo(cid, schema) {
    var conn = treeData.connections[cid];
    if (!conn) return;
    activeConnId = cid; activeConnData = conn; activeDatabase = schema;
    activeCatId = null;
    if (typeof showDbInfo === 'function') { showDbInfo(cid, schema); }
}
window.showOraSchemaInfo = showOraSchemaInfo;

function toggleOraSchema(cid, schema, schemaId, pad) {
    var el = document.getElementById(schemaId);
    if (!el) return;
    if (el.classList.contains('open')) {
        el.classList.remove('open');
        var ar = document.getElementById('ar_' + schemaId); if (ar) ar.textContent = '▸';
    } else {
        el.classList.add('open');
        var ar = document.getElementById('ar_' + schemaId); if (ar) ar.textContent = '▾';
        if (!el.innerHTML.trim()) { el.innerHTML = renderOraCats(cid, schema, pad); }
    }
    var conn = treeData.connections[cid];
    if (conn) { activeConnId = cid; activeConnData = conn; activeDatabase = schema; }
}
window.toggleOraSchema = toggleOraSchema;

function expandOraSchema(cid, schema, schemaId, pad) {
    var el = document.getElementById(schemaId);
    if (!el) return;
    var ar = document.getElementById('ar_' + schemaId);
    el.classList.add('open');
    if (ar) ar.textContent = '▾';
    if (!el.innerHTML.trim()) { el.innerHTML = renderOraCats(cid, schema, pad); }
    if (el.previousElementSibling) highlightRow(el.previousElementSibling);
    var iconEl = el.previousElementSibling ? el.previousElementSibling.querySelector('.db-icon') : null;
    if (iconEl) { iconEl.classList.remove('closed'); iconEl.classList.add('active'); }
    showOraSchemaInfo(cid, schema);
}
window.expandOraSchema = expandOraSchema;

function catRow(cat, icon, cid, db, dbKey, pad, clickFn, ctxFn, schema) {
    var sch = schema || '';
    var rowId = 'cat_'+cat+'_'+dbKey;
    var clickArgs = (cat==='tables') ? '\''+cid+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\''
        : (cat==='queries') ? '\''+cid+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\''
        : '\''+cid+'\',\''+escapeAttr(db)+'\',\''+cat+'\',\''+escapeAttr(sch)+'\'';
    var expandFn = (cat==='queries') ? 'expandQueries' : 'expandCat';
    var expandArgs = (cat==='queries') ? '\''+cid+'\',\''+dbKey+'\','+pad+',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\''
        : '\''+cat+'\',\''+cid+'\',\''+escapeAttr(db)+'\',\''+dbKey+'\','+pad+',\''+escapeAttr(sch)+'\'';
    var ctx = ctxFn ? ' oncontextmenu="'+ctxFn+'(event,\''+cid+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\')"' : '';
    var extraAttrs = (cat==='queries') ? ' data-cid="'+cid+'" data-db="'+escapeAttr(db)+'" data-pad="'+pad+'"' : '';
    // 所有分类加刷新按钮，仅表分类加拖放目标
    var catNames = {tables:'表',views:'视图',mviews:'物化视图',indexes:'索引',sequences:'序列',synonyms:'同义词',functions:'函数',procedures:'存储过程',packages:'包',triggers:'触发器',queries:'查询'};
    var catLabel = catNames[cat] || '查询';
    var refreshArgs = '\''+cat+'\',\''+cid+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+dbKey+'\','+pad;
    var refreshBtn = '<span class="cat-refresh" onclick="event.stopPropagation();refreshCatItem('+refreshArgs+')" title="刷新'+catLabel+'列表">🔄</span>';
    var dropAttrs = '';
    if (cat === 'tables') {
        dropAttrs = ' ondragover="onDbDragOver(event,this)" ondragleave="onDbDragLeave(event,this)" ondrop="onTableFolderDrop(event,this,\''+cid+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\')"';
    }
    return '<div class="my-conn-row tree-subcat cat-row" id="'+rowId+'" style="padding-left:'+pad+'px" onclick="'+clickFn+'('+clickArgs+');highlightCat(\''+rowId+'\')" ondblclick="'+expandFn+'('+expandArgs+');event.stopPropagation();"'+ctx+dropAttrs+'>' +
        '<span class="arrow" id="ar_'+rowId+'" onclick="event.stopPropagation();'+expandFn+'('+expandArgs+')">▸</span>' +
        icon+' ' + catLabel + refreshBtn +
        '</div><div class="tree-children" id="ch_'+rowId+'"'+extraAttrs+'></div>';
}

// 通用行高亮：清除所有高亮，给指定元素加上高亮
function highlightRow(el) {
    document.querySelectorAll('.tree-highlight').forEach(function(r){r.classList.remove('tree-highlight');});
    // ★ 同时清除表项的高亮（点击分类行时不再保留表项高亮）
    document.querySelectorAll('.tree-table-item.tree-table-selected').forEach(function(d){d.classList.remove('tree-table-selected');});
    _treeLastSelect = null;
    if (el) {
        el.classList.add('tree-highlight');
        activeCatId = el.id || '';
    }
}
function highlightCat(rowId) { highlightRow(document.getElementById(rowId)); }

// ==================== 连接信息悬浮 Tooltip ====================
var _connTooltipEl = null;
var _connTooltipTimer = null;

function _ensureConnTooltip() {
    if (_connTooltipEl) return;
    _connTooltipEl = document.createElement('div');
    _connTooltipEl.className = 'conn-tooltip';
    document.body.appendChild(_connTooltipEl);
}

function _buildConnTypeLabel(conn) {
    var type = (conn.db_type || 'mysql').toLowerCase();
    var map = {
        'mysql': 'MySQL', 'ob-mysql': 'OB-MySQL', 'mariadb': 'MariaDB',
        'postgresql': 'PostgreSQL', 'oracle': 'Oracle', 'mssql': 'SQL Server', 'redis': 'Redis'
    };
    return map[type] || (conn.db_type || 'MySQL');
}

function _showConnTooltip(el, cid) {
    clearTimeout(_connTooltipTimer);
    _ensureConnTooltip();
    var conn = treeData && treeData.connections && treeData.connections[cid];
    if (!conn) return;
    var typeLabel = _buildConnTypeLabel(conn);
    _connTooltipEl.innerHTML =
        '<div class="conn-tt-row"><span class="conn-tt-label">名称</span><span class="conn-tt-value">' + escapeHtml(conn.name || '') + '</span></div>' +
        '<div class="conn-tt-row"><span class="conn-tt-label">主机</span><span class="conn-tt-value">' + escapeHtml(conn.host || '') + '</span></div>' +
        '<div class="conn-tt-row"><span class="conn-tt-label">Port</span><span class="conn-tt-value">' + escapeHtml(conn.port || '') + '</span></div>' +
        '<div class="conn-tt-row"><span class="conn-tt-label">用户名</span><span class="conn-tt-value">' + escapeHtml(conn.user || '') + '</span></div>' +
        '<div class="conn-tt-row"><span class="conn-tt-label">类型</span><span class="conn-tt-value">' + escapeHtml(typeLabel) + '</span></div>';
    _connTooltipEl.style.display = 'block';
    _positionConnTooltip(el);
}

function _positionConnTooltip(el) {
    if (!_connTooltipEl) return;
    var ttW = _connTooltipEl.offsetWidth || 260;
    var ttH = _connTooltipEl.offsetHeight || 120;
    var rect = el.getBoundingClientRect();
    // ★ 显示在连接行的右侧，垂直方向与该行居中
    var left = rect.right + 10;
    var top = rect.top + (rect.height - ttH) / 2;
    // 右侧放不下时翻到左侧
    if (left + ttW > window.innerWidth - 6) {
        left = Math.max(4, rect.left - ttW - 10);
    }
    // 垂直越界时贴边
    if (top < 4) top = 4;
    if (top + ttH > window.innerHeight - 6) {
        top = Math.max(4, window.innerHeight - ttH - 6);
    }
    _connTooltipEl.style.left = left + 'px';
    _connTooltipEl.style.top = top + 'px';
}

function _hideConnTooltip() {
    clearTimeout(_connTooltipTimer);
    if (_connTooltipEl) {
        _connTooltipTimer = setTimeout(function() {
            if (_connTooltipEl) _connTooltipEl.style.display = 'none';
        }, 120);
    }
}


