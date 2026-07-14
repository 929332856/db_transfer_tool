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
// ★ 修复：右键菜单打开后，单击页面其他位置自动关闭（mousedown 比 click 更早触发）
document.addEventListener('mousedown', function (e) {
    if (ctxMenu && !ctxMenu.contains(e.target)) { hideCtxMenu(); }
});

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
    var domOpen = children && children.classList.contains('open');
    // ★ 修复：箭头折叠只是收起子节点，连接仍处于激活状态；应同时检查 DOM 展开状态和 activeConnId
    var isActive = (activeConnId === cid);
    var isOpen = domOpen || isActive;
    var node = document.querySelector('.tree-node[data-cid="' + cid + '"]');
    var row = node ? node.querySelector('.conn-row') : null;
    var pad = row ? (parseInt(row.style.paddingLeft || '0') || 20) : 20;
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    var isRedis = conn && conn.db_type === 'redis';
    var isOracle = conn && conn.db_type === 'oracle';

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
            menu = [];
            if (!isOracle) { menu.push({label:'🆕 创建数据库',action:function(){showCreateDatabase(cid);}}); }
            menu.push('---');
            menu.push({label:'✏️ 编辑',action:function(){showConnDialog(null,cid);}});
            menu.push({label:'⏹ 关闭连接',action:function(){closeConnection(cid);}});
            menu.push('---');
            menu.push({label:'🗑 删除',action:function(){deleteConnection(cid);}});
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
    // ★ 不再全局取消查询 — 关闭连接只是折叠树节点 UI，SQL 查询继续正常运行
    //    如需取消特定连接的查询，可调用 eel.cancel_query(cid)() 单独操作
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
    // 移除该连接下所有相关 tab（data_/ddl_/query_/redis_/redis_cmd 等），保留 obj_home 和其他连接的 tab
    // ★ 同时清理 cid 为空字符串或 undefined 的孤立 tab（这些 tab 所属连接已不可用，点击无反应）
    objectTabs = objectTabs.filter(function(t) {
        if (t.id === 'obj_home') return true;
        // 如果 tab 的 cid 匹配正在关闭的连接，移除
        if (t.cid === cid) return false;
        // ★ 如果 tab 没有 cid 或 cid 为空，且当前关闭的连接就是上次激活的，也移除
        //    因为这类 tab 通常是 activeConnId 被清空后残留的
        if (!t.cid && wasActive) return false;
        return true;
    });
    if (wasActive) {
        activeConnId = '';
        activeConnData = null;
        activeDatabase = '';
    }
    // ★ 关闭当前激活的连接时，强制清空对象面板（即使 obj_home tab 还在，内容也是旧的）
    if (wasActive) {
        var emptyContent = '<div style="padding:40px;text-align:center;color:#666;"><div>请选择一个连接</div></div>';
        var homeTabX = objectTabs.find(function(t){return t.id==='obj_home';});
        if (!homeTabX) { objectTabs.unshift({id:'obj_home',label:'对象',type:'home',content:emptyContent,db:''}); }
        else { homeTabX.content = emptyContent; }
        activeObjTab = 'obj_home';
        activeCatId = null;
        _activeObjCat = null;
        _activeObjSchema = '';
        renderObjectPanel();
    } else {
        // 非激活连接关闭：仅当当前 tab 被移除时才刷新面板
        var stillHasCurrentTab = objectTabs.some(function(t) { return t.id === activeObjTab; });
        if (!stillHasCurrentTab) {
            var homeContent3 = '<div style="padding:40px;text-align:center;color:#666;"><div>请选择一个连接</div></div>';
            var homeTab3 = objectTabs.find(function(t){return t.id==='obj_home';});
            if (!homeTab3) { objectTabs.unshift({id:'obj_home',label:'对象',type:'home',content:homeContent3,db:''}); }
            else { homeTab3.content = homeContent3; }
            activeObjTab = 'obj_home';
            activeCatId = null;
            _activeObjCat = null;
            _activeObjSchema = '';
            renderObjectPanel();
        }
    }
}

function addFolder(pid) { showInputDialog('新建文件夹','名称：',function(n){if(!n||!n.trim())return;eel.tree_add_folder(pid||'',n.trim())(function(r){if(r&&r.ok){treeData.folders=treeData.folders||[];var f={id:r.id,name:n.trim(),parent:pid||''};treeData.folders.push(f);addFolderToTree(f);}});}); }
function renameFolder(fid) { var f=(treeData.folders||[]).find(function(x){return x.id===fid;}); showInputDialog('重命名','新名称：',function(n){if(!n||!n.trim())return;eel.tree_rename_folder(fid,n.trim())(function(){if(f)f.name=n.trim();updateFolderNode(fid,n.trim());});},f?f.name:''); }
function deleteFolder(fid) { showConfirmDialog('确认','删除文件夹及其中连接？',function(){eel.tree_delete_folder(fid)(function(){function collectKids(pid){var r=[pid];(treeData.folders||[]).forEach(function(f){if(f.parent===pid)r=r.concat(collectKids(f.id));});return r;}var kids=collectKids(fid);var conns=[];for(var k in treeData.connections){if(kids.indexOf(treeData.connections[k].parent)!==-1)conns.push(k);}treeData.folders=(treeData.folders||[]).filter(function(f){return kids.indexOf(f.id)===-1;});conns.forEach(function(k){delete treeData.connections[k];});removeFolderNode(fid);});}); }
function deleteConnection(cid) { showConfirmDialog('确认','删除此连接？',function(){eel.tree_delete_connection(cid)(function(){delete treeData.connections[cid];closeConnection(cid);removeConnNode(cid);});}); }

function addQuery(cid, db, schema) {
    var sch = schema || '';
    var useCid = cid || activeConnId || '';
    var useDb = db || '';
    showInputDialog('新建查询','名称：',function(n){
        if (!n || !n.trim()) return;
        eel.tree_save_query('', n.trim(), '', useCid, useDb)(
            function(r) {
                if (r && r.ok) {
                    // ★ 直接从文件系统刷新查询列表
                    refreshQueriesTree(useCid, useDb, sch);
                } else {
                    var errMsg = (r && r.msg) ? r.msg : '未知错误，请查看控制台日志';
                    showErrorDialog('创建失败', errMsg);
                }
            }
        );
    });
}

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
    // 显示/隐藏 Oracle 连接方式选择
    var oraRow = document.getElementById('cf_ora_row');
    if (oraRow) { oraRow.style.display = (dbType === 'oracle') ? '' : 'none'; }
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
    // ★ 环境颜色标识（6个预设 + 无色 + 自定义吸管）
    var curColor = cd.color || '';
    var presetColors = [
        {key:'green',  val:'#22c55e', label:'生产'},
        {key:'yellow', val:'#eab308', label:'预发'},
        {key:'orange', val:'#f97316', label:'测试'},
        {key:'red',    val:'#ef4444', label:'紧急'},
        {key:'blue',   val:'#3b82f6', label:'本地'},
        {key:'purple', val:'#a855f7', label:'其他'}
    ];
    h += '<div class="form-row"><label>颜色</label><div class="color-selector" id="cf_color_picker">';
    // 无色（虚线圆圈）
    h += '<span class="color-dot color-none'+(curColor===''?' selected':'')+'" data-val="" title="无色" onclick="selectConnColor(this,\'\')"></span>';
    // 6个预设
    presetColors.forEach(function(c){
        var sel = (curColor && curColor.toLowerCase() === c.val.toLowerCase()) ? ' selected' : '';
        h += '<span class="color-dot color-'+c.key+sel+'" data-val="'+c.val+'" title="'+c.label+'" onclick="selectConnColor(this,\''+c.val+'\')"></span>';
    });
    // 自定义吸管
    h += '<span class="color-dot color-picker'+(curColor && !presetColors.some(function(p){return p.val.toLowerCase()===curColor.toLowerCase();})?' selected':'')+'" title="自定义颜色" onclick="document.getElementById(\'cf_color_custom\').click()">';
    h += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 22l4-1 11-11-3-3L3 18v4z"/><path d="M14 5l3 3"/></svg></span>';
    h += '<input type="color" id="cf_color_custom" value="'+escapeHtml(curColor||'#22c55e')+'" style="display:none" onchange="selectConnColor(null, this.value); var dot=document.querySelector(\'.color-picker\'); if(dot){dot.classList.add(\'selected\');}">';
    h += '</div></div>';
    h += '<input type="hidden" id="cf_color" value="'+escapeHtml(curColor)+'">';
    var savedOraMode = cd.ora_mode || 'service_name';
    h += '<div class="form-row ora-mode-row" id="cf_ora_row" style="'+(curType==='oracle'?'':'display:none;')+'"><label>连接方式</label><div style="display:flex;gap:16px;align-items:center;"><label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;font-size:12px;"><input type="radio" name="ora_mode_radio" value="sid" '+(savedOraMode==='sid'?'checked':'')+' onchange="document.getElementById(\'cf_ora_mode\').value=this.value" style="width:14px;height:14px;"> SID</label><label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;font-size:12px;"><input type="radio" name="ora_mode_radio" value="service_name" '+(savedOraMode==='service_name'?'checked':'')+' onchange="document.getElementById(\'cf_ora_mode\').value=this.value" style="width:14px;height:14px;"> 服务名</label></div></div>';
    h += '<input type="hidden" id="cf_ora_mode" value="'+savedOraMode+'">';
    h += '<div class="form-row"><button class="btn btn-green" style="margin-right:8px;" onclick="connTest()">🔍 测试连接</button><span id="cf_test" style="font-size:11px;flex:1;"></span></div>';
    h += '<div style="text-align:center;margin-top:12px;"><button class="btn btn-gray" style="margin-right:8px;" onclick="hideConnDlg()">取消</button><button class="btn btn-green" onclick="connSave(\''+(pid||'')+'\',\''+(editCid||'')+'\')">保存</button></div></div>';
    document.getElementById('conn_modal_box').innerHTML = h;
    document.getElementById('conn_modal_overlay').classList.add('show');
}

/** 颜色选择器交互 */
function selectConnColor(el, val) {
    var dots = document.querySelectorAll('#cf_color_picker .color-dot');
    for (var i = 0; i < dots.length; i++) { dots[i].classList.remove('selected'); }
    if (el) el.classList.add('selected');
    var colorInput = document.getElementById('cf_color');
    if (colorInput) colorInput.value = val || '';
}
function hideConnDlg() { document.getElementById('conn_modal_overlay').classList.remove('show'); }
var _connTesting = false;
function connTest() {
    var c = readConnForm(); var st = document.getElementById('cf_test');
    if (!c.host||!c.user) { st.textContent='⚠️ 填主机和用户名'; st.style.color='#f39c12'; return; }
    if (_connTesting) { st.textContent='⏳ 正在测试...'; st.style.color='#f39c12'; return; }
    _connTesting = true;
    st.textContent='⏳'; st.style.color='#f39c12';
    _eelAutoAsync(eel.tree_test_conn(c), function(r){
        _connTesting = false;
        if(r&&r.ok){st.textContent='✅ '+r.msg;st.style.color='#2ecc71';}
        else{st.textContent='❌ '+(r?r.msg:'失败');st.style.color='#e74c3c';}
    }, 20000, function() {
        _connTesting = false;
        st.textContent='⏱ 连接超时（20秒）'; st.style.color='#e74c3c';
    });
}
function connSave(pid, editCid) {
    try {
    var c = readConnForm();
    console.log('[connSave] pid='+pid+', editCid='+editCid+', color='+c.color);
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
    } catch(e) { console.error('[connSave] 异常:', e); }
}
function readConnForm() {
    var cfColor = document.getElementById('cf_color');
    return {name:(document.getElementById('cf_name')||{}).value||'',db_type:(document.getElementById('cf_type')||{}).value||'mysql',host:(document.getElementById('cf_host')||{}).value||'',port:(document.getElementById('cf_port')||{}).value||'3306',user:(document.getElementById('cf_user')||{}).value||'',pwd:(document.getElementById('cf_pwd')||{}).value||'',db:(document.getElementById('cf_db')||{}).value||'',ora_mode:(document.getElementById('cf_ora_mode')||{}).value||'service_name',color:cfColor?cfColor.value:''};
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
                treeData = data || { folders: [], connections: {} };
                var connCount = treeData && treeData.connections ? Object.keys(treeData.connections).length : 0;
                console.log('[tree.js] 树加载完成，连接数:', connCount);
                renderMyConnectionsList();
            } catch (err) {
                console.error('[tree.js] tree_load 回调异常:', err.message || err);
                treeData = { folders: [], connections: {} };
                renderMyConnectionsList();
            }
        });
    } catch (err) {
        console.error('[tree.js] loadTree 调用 eel.tree_load 失败:', err.message || err);
    }
}
function refreshAll() {
    eel.tree_load()(function (data) {
        treeData = data || { folders: [], connections: {} };
        var el = document.getElementById('my_conn_list');
        if (el && treeData) renderMyConnectionsList();
    });
}
