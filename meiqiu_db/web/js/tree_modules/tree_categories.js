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
