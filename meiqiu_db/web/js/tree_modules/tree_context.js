// ==================== 数据库右键菜单 ====================
function dbCtx(e, cid, db, dbId) {
    e.preventDefault(); e.stopPropagation();
    var el = document.getElementById(dbId);
    var domOpen = el && el.classList.contains('open');
    var isActive = (activeDatabase === db);
    var isOpen = domOpen || isActive;
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
    // ★ 清理该连接+数据库下的状态
    var wasActiveDb = (activeConnId === cid && activeDatabase === db);
    if (wasActiveDb) {
        _redisPanelCtx = null;
        activeDatabase = '';
    }
    // ★ 始终移除该连接+数据库下所有相关 tab（data_/ddl_/query_/redis_ 等），不区分当前活跃数据库
    objectTabs = objectTabs.filter(function(t) {
        if (t.id === 'obj_home') return true;
        return !(t.cid === cid && t.db === db);
    });
    // ★ 如果当前激活的 tab 已被移除，切回 home
    var stillHasCurrentTab = objectTabs.some(function(t) { return t.id === activeObjTab; });
    if (!stillHasCurrentTab) {
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
                html += '<div class="tree-node db-node" data-cid="'+cid+'" data-db="'+escapeAttr(db2)+'"><div class="my-conn-row" style="padding-left:'+(prevPad+20)+'px"'+dropAttrs2+ctxAttr2+' onclick="showDbInfo(\''+cid+'\',\''+escapeAttr(db2)+'\')" ondblclick="selectDatabase(\''+cid+'\',\''+escapeAttr(db2)+'\',\''+dbId2+'\',\'ar_'+dbId2+'\')">' +
                    '<span class="arrow" id="ar_'+dbId2+'" onclick="event.stopPropagation();toggleDbChildren(\''+dbId2+'\',\'ar_'+dbId2+'\')" style="visibility:hidden">▸</span><span class="my-conn-icon db-icon closed">'+DB_ICON_SVG+'</span><span class="my-conn-name">'+escapeHtml(db2)+'</span></div>' +
                    '<div class="tree-children" id="'+dbId2+'"></div></div>';
            } else {
                html += '<div class="tree-node db-node" data-cid="'+cid+'" data-db="'+escapeAttr(db2)+'"><div class="my-conn-row" style="padding-left:'+(prevPad+20)+'px"'+dropAttrs2+ctxAttr2+' onclick="showDbInfo(\''+cid+'\',\''+escapeAttr(db2)+'\')" ondblclick="selectDatabase(\''+cid+'\',\''+escapeAttr(db2)+'\',\''+dbId2+'\',\'ar_'+dbId2+'\')">' +
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
    var rowId = 'cat_'+cat+'_'+dbKey;
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
                var catIcons = {tables:'📊',views:'👁',mviews:'📋',indexes:'🔍',sequences:'🔢',synonyms:'🔗',functions:'𝑓',procedures:'⚙',packages:'📦',triggers:'⚡'};
                var catIcon = catIcons[cat] || '📝';
                var h = items.map(function (it) {
                    var n = it.name || it;
                    var qual = sch || db;  // PG 用 schema，其他用 db
                    var dataAttrs = (cat==='tables') ? ' data-tname="'+escapeAttr(n)+'" data-db="'+escapeAttr(db)+'" data-sch="'+escapeAttr(sch)+'" data-cid="'+cid+'"' : '';
                    var onClick = (cat==='tables') ? ' onclick="treeTableClick(event,this)"' : '';
                    var ctx = (cat==='tables') ? ' oncontextmenu="tableCtx(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"' : '';
                    var dragAttr = (cat==='tables') ? ' draggable="true" class="my-conn-row drag-table-item tree-table-item" ondragstart="onTableDragStart(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')" ondragend="onTableDragEnd(event)"' : ' class="my-conn-row"';
                    return '<div'+dragAttr+dataAttrs+' style="padding-left:'+itemPad+'px;font-size:11px;line-height:22px;'+(cat!=='tables'?'padding-top:5px;padding-bottom:5px;':'')+'" ondblclick="addTableDataTab(\''+escapeAttr(n)+'\',\''+escapeAttr(qual)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"'+onClick+ctx+'><span class="my-conn-icon">'+catIcon+'</span><span class="tree-table-name">'+escapeHtml(n)+'</span></div>';
                }).join('');
                children.innerHTML = h || '<div style="padding-left:'+itemPad+'px;color:#999;font-size:11px;">（无数据）</div>';
            }, sch);
        }
    }
}

// 通用刷新：刷新指定分类（表/视图/存储过程/函数/查询）
function refreshCatItem(cat, cid, db, schema, dbKey, pad) {
    var rowId = 'cat_'+cat+'_'+dbKey;
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
        var catIcons = {tables:'📊',views:'👁',mviews:'📋',indexes:'🔍',sequences:'🔢',synonyms:'🔗',functions:'𝑓',procedures:'⚙',packages:'📦',triggers:'⚡'};
        var catIcon = catIcons[cat] || '📝';
        var h = items.map(function(it) {
            var n = it.name || it;
            var qual = sch || db;
            var dataAttrs = (cat==='tables') ? ' data-tname="'+escapeAttr(n)+'" data-db="'+escapeAttr(db)+'" data-sch="'+escapeAttr(sch)+'" data-cid="'+cid+'"' : '';
            var onClick = (cat==='tables') ? ' onclick="treeTableClick(event,this)"' : '';
            var ctx = (cat==='tables') ? ' oncontextmenu="tableCtx(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"' : '';
            var dragAttr = (cat==='tables') ? ' draggable="true" class="my-conn-row drag-table-item tree-table-item" ondragstart="onTableDragStart(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')" ondragend="onTableDragEnd(event)"' : ' class="my-conn-row"';
            return '<div'+dragAttr+dataAttrs+' style="padding-left:'+itemPad+'px;font-size:11px;line-height:22px;'+(cat!=='tables'?'padding-top:5px;padding-bottom:5px;':'')+'" ondblclick="addTableDataTab(\''+escapeAttr(n)+'\',\''+escapeAttr(qual)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"'+onClick+ctx+'><span class="my-conn-icon">'+catIcon+'</span><span class="tree-table-name">'+escapeHtml(n)+'</span></div>';
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
    var rowId = 'cat_tables_' + dbKey;
    var el = document.getElementById(rowId);
    if (!el) {
        // 回退：不用 schema 再试
        dbKey = safeBtoa(db);
        rowId = 'cat_tables_' + dbKey;
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
    var rowId = 'cat_queries_'+dbKey;
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
    var rowId = 'cat_queries_' + dbKey;
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

// ==================== 左侧树表名内联重命名 ====================
var _treeRenameState = null;      // { div, oldName, db, schema, cid, nameSpan }
var _treeLastSelect = null;

// 左侧树表项点击：选择 / 再次点击进入重命名
function treeTableClick(e, div) {
    if (_treeRenameState) return;
    if (e.detail > 1) return; // 双击忽略
    // 清除所有高亮
    document.querySelectorAll('.tree-table-item').forEach(function(d) {
        d.classList.remove('tree-table-selected');
    });
    div.classList.add('tree-table-selected');

    if (_treeLastSelect === div) {
        // 同一项再次点击 → 进入重命名模式
        _startTreeRename(div);
        _treeLastSelect = null;
    } else {
        _treeLastSelect = div;
    }
}

// F2 触发左侧树表名重命名
function treeTableRenameByF2() {
    if (_treeRenameState) return;
    var sel = document.querySelector('.tree-table-item.tree-table-selected');
    if (!sel) return;
    _startTreeRename(sel);
}

function _startTreeRename(div) {
    var tn = div.getAttribute('data-tname');
    var db = div.getAttribute('data-db');
    var sch = div.getAttribute('data-sch');
    var cid = div.getAttribute('data-cid');
    if (!tn || !db) return;

    var nameSpan = div.querySelector('.tree-table-name');
    if (!nameSpan) return;

    var oldName = nameSpan.textContent.trim();
    // 保存原始 HTML 结构以备恢复
    var iconEl = div.querySelector('.my-conn-icon');

    var input = document.createElement('input');
    input.type = 'text';
    input.value = oldName;
    input.style.cssText = 'background:#1a1a1a;border:1px solid #4a90d9;border-radius:3px;color:#e0e0e0;padding:1px 4px;font-size:11px;outline:none;width:120px;margin-left:4px;vertical-align:middle;';
    nameSpan.style.display = 'none';
    div.insertBefore(input, nameSpan.nextSibling);
    input.focus();
    input.select();

    _treeRenameState = {
        div: div, oldName: oldName, db: db, schema: sch, cid: cid,
        nameSpan: nameSpan, input: input
    };

    input.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); _commitTreeRename(); }
        if (ev.key === 'Escape') { ev.preventDefault(); _cancelTreeRename(); }
    });
    input.addEventListener('blur', function() {
        setTimeout(function() {
            if (_treeRenameState) _commitTreeRename();
        }, 100);
    });
}

function _commitTreeRename() {
    var s = _treeRenameState;
    if (!s) return;
    var newName = s.input.value.trim();
    _treeRenameState = null;
    // 恢复原始显示
    if (s.nameSpan) s.nameSpan.style.display = '';
    if (s.input && s.input.parentNode) s.input.parentNode.removeChild(s.input);
    s.div.classList.remove('tree-table-selected');

    if (!newName || newName === s.oldName) return;

    var cid = s.cid || activeConnId || '';
    var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
    if (!conn) { showErrorDialog('重命名失败', '未找到连接信息'); return; }

    eel.table_rename(conn, s.db, s.oldName, newName, s.schema)(function(r) {
        if (r && r.ok) {
            showOkDialog('成功', r.msg);
            // 更新 DOM 中的表名
            if (s.nameSpan) s.nameSpan.textContent = newName;
            // 刷新左侧树和对象面板
            refreshTableFolder(cid, s.db, s.schema);
            setTimeout(function() {
                if (activeConnId === cid && activeDatabase === s.db) {
                    loadCategoryItems(conn, s.db, 'tables', function(items) {
                        var home = objectTabs.find(function(t){ return t.id === 'obj_home'; });
                        if (home) {
                            home.content = buildObjHomeContent(items, 'tables', s.db, s.schema, cid);
                            renderObjectPanel();
                        }
                    }, s.schema);
                }
            }, 300);
        } else {
            showErrorDialog('重命名失败', (r && r.msg) ? r.msg : '未知错误');
        }
    });
}

function _cancelTreeRename() {
    var s = _treeRenameState;
    if (!s) return;
    if (s.nameSpan) s.nameSpan.style.display = '';
    if (s.input && s.input.parentNode) s.input.parentNode.removeChild(s.input);
    _treeRenameState = null;
}
