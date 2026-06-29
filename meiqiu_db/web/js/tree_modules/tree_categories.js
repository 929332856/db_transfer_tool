// ==================== 分类点击 =右侧面板 ====================
function clickTableCat(cid, db, schema) { _activeObjCat='tables'; _activeObjSchema=schema||''; clickCat(cid, db, 'tables', schema||''); }
function clickCat(cid, db, cat, schema) {
    _redisPanelCtx = null; // 切换到非 Redis 面板
    var conn = treeData.connections[cid];
    if (!conn) return;
    activeConnId = cid; activeConnData = conn; activeDatabase = db;
    var sch = schema || '';
    _activeObjCat = cat; _activeObjSchema = sch;
    loadCategoryItems(conn, db, cat, function (items) {
        // ★ 防止异步回调晚于 closeConnection 执行，导致面板被旧数据回填
        if (activeConnId !== cid) return;
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
    _activeObjCat = 'queries'; _activeObjSchema = sch;
    var fullDb = sch ? db+'/'+sch : db;
    activeConnId = cid; activeConnData = treeData.connections[cid]; activeDatabase = db;
    // ★ 从文件系统加载查询列表
    eel.tree_list_queries(cid, db)(function(queries) {
        var content = '<table class="exp-table"><thead><tr><th>名称</th></tr></thead><tbody>';
        (queries || []).forEach(function(q){content += '<tr ondblclick="openQueryInTab(\''+q.id+'\')" oncontextmenu="queryCtx2(event,\''+q.id+'\',\''+cid+'\',\''+escapeAttr(sch)+'\')"><td>'+escapeHtml(q.name)+'</td></tr>';});
        content += '</tbody></table>';
        if (!(queries || []).length) content += '<div style="padding:20px;color:#999;">（无查询）</div>';
        var home = objectTabs.find(function(t){return t.id==='obj_home';});
        if (home) home.content = content;
        else objectTabs.unshift({id:'obj_home',label:'对象',type:'home',content:content});
        activeObjTab = 'obj_home';
        renderObjectPanel();
    });
}

function queryCtx2(e, qid, cid, schema) {
    e.preventDefault(); e.stopPropagation();
    var sch = schema || '';
    showCtxMenu(e.clientX, e.clientY, [
        {label:'📄 打开查询',action:function(){openQueryInTab(qid);}},
        {label:'📝 新建查询',action:function(){addQuery(cid, activeDatabase||'', sch);}},
        '---',
        {label:'🗑 删除查询',action:function(){showConfirmDialog('确认删除','确定删除此查询？',function(){eel.tree_delete_query(qid)(function(){refreshQueriesTree(cid, activeDatabase||'', sch);});});}}
    ]);
}

// ==================== Oracle 用户/SCHEMA 列表 ====================
function expandOraUsers(cid, db, dbKey, pad) {
    var rowId = 'cat_users_' + dbKey;
    var el = document.getElementById(rowId);
    if (!el) return;
    var children = el.nextElementSibling;
    if (children && children.classList.contains('tree-children')) {
        if (children.classList.contains('open')) { children.classList.remove('open'); updateCatArrow(rowId, '▸'); return; }
        children.classList.add('open');
        updateCatArrow(rowId, '▾');
        if (!children.innerHTML.trim()) {
            var schemas = window._oraSchemas || [];
            var h = schemas.map(function(s) {
                return '<div class="my-conn-row" style="padding-left:'+pad+'px;font-size:11px;line-height:22px;padding-top:5px;padding-bottom:5px;" ondblclick="clickOraSchema(\''+cid+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(s)+'\')">' +
                    '👤 ' + escapeHtml(s) + '</div>';
            }).join('');
            children.innerHTML = h || '<div style="padding-left:'+pad+'px;color:#999;font-size:11px;">（无用户）</div>';
        }
    }
}
function clickOraSchema(cid, db, schema) {
    _redisPanelCtx = null;
    var conn = treeData.connections[cid];
    if (!conn) return;
    activeConnId = cid; activeConnData = conn; activeDatabase = schema;
    // ★ 展示该 schema 的数据库信息
    if (typeof showDbInfo === 'function') {
        showDbInfo(cid, schema);
    }
    // ★ 找到对应的 schema 文件夹并展开
    var schemaId = cid + '_ora_' + safeBtoa(schema);
    var schemaEl = document.getElementById(schemaId);
    if (schemaEl && !schemaEl.classList.contains('open') && typeof expandOraSchema === 'function') {
        expandOraSchema(cid, schema, schemaId, 20);
    }
    var content = '<table class="exp-table"><thead><tr><th>用户名 / Schema</th></tr></thead><tbody>';
    content += '<tr><td>👤 ' + escapeHtml(schema) + '</td></tr>';
    content += '</tbody></table>';
    var home = objectTabs.find(function(t){return t.id==='obj_home';});
    if (home) home.content = content;
    else objectTabs.unshift({id:'obj_home',label:'对象',type:'home',content:content,db:''});
    activeObjTab = 'obj_home';
    renderObjectPanel();
}
function clickOraUsers(cid, db) {
    _redisPanelCtx = null;
    var conn = treeData.connections[cid];
    if (!conn) return;
    activeConnId = cid; activeConnData = conn; activeDatabase = db;
    var schemas = window._oraSchemas || [];
    var content = '<table class="exp-table"><thead><tr><th>用户名 / Schema</th></tr></thead><tbody>';
    schemas.forEach(function(s) {
        content += '<tr><td>👤 ' + escapeHtml(s) + '</td></tr>';
    });
    content += '</tbody></table>';
    if (!schemas.length) content += '<div style="padding:20px;color:#999;">（无用户信息）</div>';
    var home = objectTabs.find(function(t){return t.id==='obj_home';});
    if (home) home.content = content;
    else objectTabs.unshift({id:'obj_home',label:'对象',type:'home',content:content,db:''});
    activeObjTab = 'obj_home';
    renderObjectPanel();
}
