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
