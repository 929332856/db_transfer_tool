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
    // ★ 初始化可拖拽分隔条
    if (typeof initConnSplitter === 'function') initConnSplitter();
    if (typeof initInfoSplitter === 'function') initInfoSplitter();
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
    return '<div class="tree-node" data-cid="'+cid+'"><div class="my-conn-row conn-row drag-conn-item" draggable="true" style="padding-left:'+pad+'px" onclick="showConnInfo(\''+cid+'\')" ondblclick="expandConn(\''+cid+'\','+pad+')" oncontextmenu="connCtx(event,\''+cid+'\')" ondragstart="onConnDragStart(event,\''+cid+'\')" ondragend="onConnDragEnd(event,\''+cid+'\')">' +
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
    var isOra = conn.db_type === 'oracle';
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
        }
        return;
    }
    eel.db_explore_get_databases(conn)(function (r) {
        console.log('[expandConn] db_explore_get_databases callback:', JSON.stringify(r).substring(0, 200));
        if (!r || !r.ok) { children.innerHTML = '<div style="padding-left:'+(pad+20)+'px;color:#e74c3c;font-size:11px;">❌ '+(r?r.msg:'无响应')+'</div>'; return; }
        var html = '';
        var dbs = r.databases || [];
        // Oracle：直接平铺分类，省去 DB/SCHEMA 文件夹层级
        if (isOra) {
            window._oraSchemas = dbs;
            if (dbs.length > 0) {
                activeDatabase = dbs[0];
                html += renderOraCats(cid, dbs[0], pad+20);
                // ★ Oracle 展开连接时自动展示首个 Schema 的数据库信息
                if (typeof showDbInfo === 'function') {
                    showDbInfo(cid, dbs[0]);
                }
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
                        '<span class="arrow" id="ar_'+dbId+'" onclick="event.stopPropagation();toggleDbChildren(\''+dbId+'\',\'ar_'+dbId+'\')" style="visibility:hidden">▸</span><span class="my-conn-icon db-icon closed">'+DB_ICON_SVG+'</span><span class="my-conn-name">'+escapeHtml(db)+'</span></div>' +
                        '<div class="tree-children" id="'+dbId+'">' + renderDbCats(cid, db, pad+40) + '</div></div>';
                }
            });
        }
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

function renderOraCats(cid, db, pad) {
    var dbKey = safeBtoa(db);
    var p = pad + 16;
    return catRow('tables',    '📊',cid,db,dbKey,p,'clickTableCat','tableCatCtx','') +
           catRow('views',     '👁',cid,db,dbKey,p,'clickCat','','') +
           catRow('mviews',    '📋',cid,db,dbKey,p,'clickCat','','') +
           catRow('indexes',   '🔍',cid,db,dbKey,p,'clickCat','','') +
           catRow('sequences', '🔢',cid,db,dbKey,p,'clickCat','','') +
           catRow('synonyms',  '🔗',cid,db,dbKey,p,'clickCat','','') +
           catRow('functions', '𝑓',cid,db,dbKey,p,'clickCat','','') +
           catRow('procedures','⚙',cid,db,dbKey,p,'clickCat','','') +
           catRow('packages',  '📦',cid,db,dbKey,p,'clickCat','','') +
           catRow('triggers',  '⚡',cid,db,dbKey,p,'clickCat','','') +
           catRow('queries',   '📝',cid,db,dbKey,p,'clickQueries','qLabelCtx','') +
           oraUsersRow(cid, db, dbKey, p);
}
function oraUsersRow(cid, db, dbKey, pad) {
    var rowId = 'cat_users_' + dbKey;
    return '<div class="my-conn-row tree-subcat cat-row" id="'+rowId+'" style="padding-left:'+pad+'px" onclick="clickOraUsers(\''+cid+'\',\''+escapeAttr(db)+'\');highlightCat(\''+rowId+'\')">' +
        '<span class="arrow" id="ar_'+rowId+'" onclick="event.stopPropagation();expandOraUsers(\''+cid+'\',\''+escapeAttr(db)+'\',\''+dbKey+'\','+(pad+16)+')">▸</span>' +
        '👤 用户</div><div class="tree-children" id="'+rowId+'"></div>';
}

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
    return '<div class="my-conn-row tree-subcat cat-row" id="'+rowId+'" style="padding-left:'+pad+'px" onclick="'+clickFn+'('+clickArgs+');highlightCat(\''+rowId+'\')"'+ctx+dropAttrs+'>' +
        '<span class="arrow" id="ar_'+rowId+'" onclick="event.stopPropagation();'+expandFn+'('+expandArgs+')">▸</span>' +
        icon+' ' + catLabel + refreshBtn +
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
