// ==================== 数据库右键菜单 ====================
function dbCtx(e, cid, db, dbId) {
    e.preventDefault(); e.stopPropagation();
    var el = document.getElementById(dbId);
    var domOpen = el && el.classList.contains('open');
    // 数据库名可能在多个连接中重复，必须同时判断连接 ID，避免误把其他连接
    // 下的同名数据库当成当前数据库。
    var isActive = (activeConnId === cid && activeDatabase === db);
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
            document.getElementById('modal_msg').innerHTML = '<div style="color:#e74c3c;">❌ ' + escapeHtml(r?r.msg:'加载失败') + '</div>';
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
    if (input) { input.accept = '.sql,.csv'; input.click(); }
}

function onImportFileSelected(e) {
    var file = e.target.files[0];
    if (!file) { e.target.value = ''; return; }

    var target = window._sqlFileTarget || 'import';
    window._sqlFileTarget = '';

    if (target === 'run') {
        // 运行 SQL 文件（支持 .sql 与 .csv，CSV 走数据导入）
        window._sqlFileType = (file.name || '').toLowerCase().endsWith('.csv') ? 'csv' : 'sql';
        window._sqlFileName = file.name || 'import.sql';
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
    var sqlRunOpId = 'sql_file_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    document.getElementById('btn_run_sql_file').disabled = true;
    if (!window._sqlFileContent) {
        document.getElementById('sql_file_label').textContent = '⚠️ 请先选择文件';
        document.getElementById('sql_file_label').style.color = '#f39c12';
        document.getElementById('btn_run_sql_file').disabled = false;
        return;
    }
    var isCsv = (window._sqlFileType === 'csv');
    if (isCsv) {
        var tblName = (window._sqlFileName || 'import.csv').replace(/\.csv$/i, '');
        var okC = confirm('即将把 CSV 数据导入到数据库 [' + db + '] 的表 [' + tblName + ']。\n\n若该表已存在，会被先删除再重建（DROP TABLE IF EXISTS），表中的原数据将丢失！\n\n确认继续吗？');
        if (!okC) {
            document.getElementById('btn_run_sql_file').disabled = false;
            return;
        }
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
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-red btn-sm" onclick="eel.cancel_query()();this.disabled=true;this.textContent=\'正在终止...\'">⏹ 取消执行</button><button class="btn btn-gray" onclick="hideModal()">关闭</button>';

    var tid = setInterval(function() {
        if (!document.getElementById('modal_overlay').classList.contains('show')) { clearInterval(tid); return; }
        eel.poll_queue()(function(msgs) {
            if (!msgs) return;
            for (var i = 0; i < msgs.length; i++) {
                var m = msgs[i];
                if (!m) continue;
                if (isCsv) {
                    // ===== CSV 导入的消息类型（import_*）=====
                    if (m[0] === 'import_log') {
                        var logCsv = document.getElementById('sql_run_log_area');
                        if (logCsv) {
                            var tsC = new Date().toTimeString().slice(0, 8);
                            logCsv.innerHTML += '<div style="color:#e74c3c;"><span style="color:#666;">[' + tsC + ']</span> ' + escapeHtml(m[1]) + '</div>';
                            logCsv.scrollTop = logCsv.scrollHeight;
                        }
                    } else if (m[0] === 'import_progress') {
                        var dC = m[1] || {};
                        var barC = document.getElementById('sql_run_bar');
                        var pctC = dC.total ? Math.floor((dC.processed / dC.total) * 100) : 0;
                        if (barC) barC.style.width = pctC + '%';
                        var stC = document.getElementById('sql_run_status');
                        if (stC) stC.textContent = '已导入 ' + (dC.processed||0) + ' / ' + (dC.total||0) + ' 行数据';
                    } else if (m[0] === 'import_done') {
                        clearInterval(tid);
                        document.getElementById('modal_title').textContent = '运行 SQL 文件';
                        document.getElementById('sql_run_bar').style.width = '100%';
                        var logCsv2 = document.getElementById('sql_run_log_area');
                        if (logCsv2) { logCsv2.innerHTML += '<div style="color:#2ecc71;">✅ CSV 导入完成，共导入 ' + (m[1] && m[1].processed||0) + ' 行数据</div>'; logCsv2.scrollTop = logCsv2.scrollHeight; }
                        document.getElementById('modal_btns').innerHTML = '<button class="btn btn-green" onclick="hideModal()">完成</button>';
                    } else if (m[0] === 'import_error') {
                        clearInterval(tid);
                        document.getElementById('modal_title').textContent = '运行 SQL 文件';
                        var logCsv3 = document.getElementById('sql_run_log_area');
                        if (logCsv3) { logCsv3.innerHTML += '<div style="color:#e74c3c;">❌ CSV 导入失败: ' + escapeHtml(m[1] && m[1].msg || m[1]) + '</div>'; logCsv3.scrollTop = logCsv3.scrollHeight; }
                        document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';
                    }
                } else {
                    if (m[0] === 'sql_run_log') {
                        var logArea = document.getElementById('sql_run_log_area');
                        if (logArea) {
                            var ts = new Date().toTimeString().slice(0, 8);
                            logArea.innerHTML += '<div style="color:#e74c3c;"><span style="color:#666;">[' + ts + ']</span> ' + escapeHtml(m[1]) + '</div>';
                            logArea.scrollTop = logArea.scrollHeight;
                        }
                    } else if (m[0] === 'sql_run_progress') {
                        var d = m[1];
                        var bar = document.getElementById('sql_run_bar');
                        var pct = d.total ? Math.floor((d.processed / d.total) * 100) : 0;
                        if (bar) bar.style.width = pct + '%';
                        var st = document.getElementById('sql_run_status');
                        if (st) st.textContent = '已执行 ' + (d.processed||0) + ' / ' + (d.total||0) + ' 条语句';
                    } else if (m[0] === 'sql_run_done') {
                        clearInterval(tid);
                        document.getElementById('modal_title').textContent = '运行 SQL 文件';
                        document.getElementById('sql_run_bar').style.width = '100%';
                        var logArea2 = document.getElementById('sql_run_log_area');
                        if (logArea2) { logArea2.innerHTML += '<div style="color:#2ecc71;">✅ 执行完成，成功执行 ' + (m[1].processed||0) + ' 条语句</div>'; logArea2.scrollTop = logArea2.scrollHeight; }
                        document.getElementById('modal_btns').innerHTML = '<button class="btn btn-green" onclick="hideModal()">完成</button>';
                    } else if (m[0] === 'sql_run_error') {
                        clearInterval(tid);
                        document.getElementById('modal_title').textContent = '运行 SQL 文件';
                        var logArea3 = document.getElementById('sql_run_log_area');
                        var cancelledSql = !!(m[1] && m[1].cancelled);
                        if (cancelledSql) document.getElementById('modal_title').textContent = 'SQL 文件已取消';
                        if (logArea3) { logArea3.innerHTML += '<div style="color:' + (cancelledSql ? '#f39c12' : '#e74c3c') + ';">' + (cancelledSql ? '⏸ ' : '❌ 执行失败: ') + escapeHtml(m[1].msg) + '</div>'; logArea3.scrollTop = logArea3.scrollHeight; }
                        document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';
                    }
                }
            }
        });
    }, 300);

    if (isCsv) {
        // CSV：先保存内容到临时文件（后端用文件名做表名），再走导入向导
        eel.save_import_file(window._sqlFileContent, window._sqlFileName)(function(path) {
            if (!path) {
                document.getElementById('modal_title').textContent = '运行 SQL 文件';
                var logCsvE = document.getElementById('sql_run_log_area');
                if (logCsvE) logCsvE.innerHTML += '<div style="color:#e74c3c;">❌ CSV 保存失败</div>';
                document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';
                return;
            }
            eel.import_wizard_run(conn, db, path, 'csv', '', window._sqlFileContent, '', false, sqlRunOpId)();
        });
    } else {
        eel.db_run_sql_file(conn, db, '', window._sqlFileContent, sqlRunOpId)();
    }
}

function closeDatabase(cid, db, dbId) {
    // 折叠数据库节点，图标变灰，保留箭头以便再次展开
    if (typeof clearInfoPanelForConnection === 'function') {
        clearInfoPanelForConnection(cid, db);
    }
    var el = document.getElementById(dbId);
    if (el) {
        el.classList.remove('open');
        var ar = document.getElementById('ar_' + dbId);
        // 关闭数据库只是收起内容，仍要保留箭头，用户可以再次点击展开。
        if (ar) { ar.textContent = '▸'; ar.style.visibility = 'visible'; }
        var iconEl = el.previousElementSibling ? el.previousElementSibling.querySelector('.db-icon') : null;
        if (iconEl) { iconEl.classList.remove('active'); iconEl.classList.add('closed'); }
    }
    // ★ 清理该连接+数据库下的状态
    var wasActiveDb = (activeConnId === cid && activeDatabase === db);
    if (wasActiveDb) {
        _redisPanelCtx = null;
        activeDatabase = '';
    }
    // ★ 先清理被移除的 query tab 的修改追踪状态
    objectTabs.forEach(function(t) {
        if (t.id !== 'obj_home' && t.cid === cid && t.db === db) {
            var qm = t.id.match(/^query_(.+)$/);
            if (qm) { delete _queryModified[qm[1]]; delete _querySavedSql[qm[1]]; }
        }
    });
    // ★ 始终移除该连接+数据库下所有相关 tab（data_/ddl_/query_/redis_ 等），不区分当前活跃数据库
    var removedDbTabIds = [];
    objectTabs = objectTabs.filter(function(t) {
        if (t.id === 'obj_home') return true;
        var remove = (t.cid === cid && t.db === db);
        if (remove) removedDbTabIds.push(t.id);
        return !remove;
    });
    removedDbTabIds.forEach(function(tabId) {
        if (typeof _tableScrollStates !== 'undefined') delete _tableScrollStates[tabId];
        if (window._tableDesigns) delete window._tableDesigns[tabId];
    });
    // 只有关闭当前正在查看的数据库时才切回 home。关闭其他数据库时，
    // 仍然保留用户当前正在查看的表 tab，避免 tab 变成空白默认页。
    var stillHasCurrentTab = objectTabs.some(function(t) { return t.id === activeObjTab; });
    if (wasActiveDb || !stillHasCurrentTab) {
        var homeContent2 = '<div style="padding:40px;text-align:center;color:#666;"><div style="font-size:36px;margin-bottom:10px;">📄</div><div>点击表、视图等分类查看对象</div></div>';
        var homeTab2 = objectTabs.find(function(t){return t.id==='obj_home';});
        if (!homeTab2) { objectTabs.push({id:'obj_home',label:'对象',type:'home',content:homeContent2,db:''}); }
        else { homeTab2.content = homeContent2; }
        activeObjTab = 'obj_home';
        activeCatId = null;
    }
    renderObjectPanel();
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
    _eelAutoAsync(eel.db_explore_get_databases(conn), function(r) {
        if (!r || !r.ok) { children.innerHTML = '<div style="padding-left:36px;color:#e74c3c;font-size:11px;">❌</div>'; children.classList.remove('open'); return; }
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
                    '<span class="arrow" id="ar_'+dbId2+'" onclick="event.stopPropagation();toggleDbChildren(\''+dbId2+'\',\'ar_'+dbId2+'\')">▸</span><span class="my-conn-icon db-icon closed">'+DB_ICON_SVG+'</span><span class="my-conn-name">'+escapeHtml(db2)+'</span></div>' +
                    '<div class="tree-children" id="'+dbId2+'">' + renderDbCats(cid, db2, prevPad+40) + '</div></div>';
            }
        });
        html += renderConnUsersNode(cid, prevPad, conn);
        children.innerHTML = html || '<div style="padding-left:'+(prevPad+20)+'px;color:#999;font-size:11px;">（无数据库）</div>';
    });
}

function tableCatCtx(e, cid, db, schema) {
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, [
        {label:'📝 新建表',action:function(){showCreateTableDialog(cid,db,schema);}},
        {label:'📤 导出向导',action:function(){showExportWizard(cid,db,schema,'');}},
        {label:'📥 导入向导',action:function(){showImportWizard(cid,db,schema);}}
    ]);
}

function qLabelCtx(e, cid, db, schema) {
    e.preventDefault(); e.stopPropagation();
    var sch = schema || '';
    showCtxMenu(e.clientX, e.clientY, [
        {label:'📝 新建查询',action:function(){addQuery(cid, db, sch);}}
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
                var catIcons = {tables:(window.MQ_ICON&&window.MQ_ICON.table)||'📊',views:'👁',mviews:'📋',indexes:'🔍',sequences:'🔢',synonyms:'🔗',functions:'𝑓',procedures:'⚙',packages:'📦',triggers:'⚡'};
                var catIcon = catIcons[cat] || '📝';
                var h = items.map(function (it) {
                    var n = it.name || it;
                    var qual = sch || db;  // PG 用 schema，其他用 db
                    if (cat === 'tables') {
                        return _renderTableNode(n, itemPad, catIcon, db, sch, cid, qual);
                    }
                    var dataAttrs = (cat==='tables') ? ' data-tname="'+escapeAttr(n)+'" data-db="'+escapeAttr(db)+'" data-sch="'+escapeAttr(sch)+'" data-cid="'+cid+'"' : '';
                    var onClick = (cat==='tables') ? ' onclick="treeTableClick(event,this)"' : '';
                    var ctx = (cat==='tables') ? ' oncontextmenu="tableCtx(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"' : (cat==='procedures' ? ' oncontextmenu="procCtx(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"' : (cat==='functions'||cat==='triggers'||cat==='packages'||cat==='sequences'||cat==='views'||cat==='mviews' ? ' oncontextmenu="objectCtx(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\''+cat+'\')"' : ''));
                    var dragAttr = (cat==='tables') ? ' draggable="true" class="my-conn-row drag-table-item tree-table-item" ondragstart="onTableDragStart(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')" ondragend="onTableDragEnd(event)"' : ' class="my-conn-row"';
                    // ★ 非表对象：双击查看源码（存储过程/函数/触发器/序列/包/物化视图）
                    var dblClick = 'addTableDataTab(\''+escapeAttr(n)+'\',\''+escapeAttr(qual)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')';
                    if (cat === 'procedures') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'PROCEDURE\')';
                    else if (cat === 'functions') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'FUNCTION\')';
                    else if (cat === 'triggers') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'TRIGGER\')';
                    else if (cat === 'sequences') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'SEQUENCE\')';
                    else if (cat === 'packages') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'PACKAGE\')';
                    else if (cat === 'mviews') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'MVIEW\')';
                    return '<div'+dragAttr+dataAttrs+' style="padding-left:'+itemPad+'px;font-size:11px;line-height:22px;'+(cat!=='tables'?'padding-top:5px;padding-bottom:5px;':'')+'" ondblclick="'+dblClick+'"'+onClick+ctx+'><span class="my-conn-icon">'+catIcon+'</span><span class="tree-table-name">'+escapeHtml(n)+'</span></div>';
                }).join('');
                children.innerHTML = h || '<div style="padding-left:'+itemPad+'px;color:#999;font-size:11px;">（无数据）</div>';
            }, sch);
        }
    }
}

// 通用刷新：刷新指定分类（表/视图/存储过程/函数/查询）

// ★ 从 category 行 DOM 上读取真实的 padding-left（替代写死 0）
function _getCatRowPad(rowId) {
    var el = document.getElementById(rowId);
    if (!el) return 56;  // 兜底
    var s = el.getAttribute('style') || el.style.cssText || '';
    var m = s.match(/padding-left:\s*(\d+)\s*px/i);
    return m ? parseInt(m[1]) : 56;
}
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
    if (typeof _myConnTableCache !== 'undefined') delete _myConnTableCache[cid + '\0' + db + '\0' + sch];
    loadCategoryItems(conn, db, cat, function(items) {
        var itemPad = (pad||0) + 20;
        var catIcons = {tables:(window.MQ_ICON&&window.MQ_ICON.table)||'📊',views:'👁',mviews:'📋',indexes:'🔍',sequences:'🔢',synonyms:'🔗',functions:'𝑓',procedures:'⚙',packages:'📦',triggers:'⚡'};
        var catIcon = catIcons[cat] || '📝';
        var h = items.map(function(it) {
            var n = it.name || it;
            var qual = sch || db;
            if (cat === 'tables') {
                return _renderTableNode(n, itemPad, catIcon, db, sch, cid, qual);
            }
            var dataAttrs = (cat==='tables') ? ' data-tname="'+escapeAttr(n)+'" data-db="'+escapeAttr(db)+'" data-sch="'+escapeAttr(sch)+'" data-cid="'+cid+'"' : '';
            var onClick = (cat==='tables') ? ' onclick="treeTableClick(event,this)"' : '';
            var ctx = (cat==='tables') ? ' oncontextmenu="tableCtx(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"' : (cat==='procedures' ? ' oncontextmenu="procCtx(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')"' : (cat==='functions'||cat==='triggers'||cat==='packages'||cat==='sequences'||cat==='views'||cat==='mviews' ? ' oncontextmenu="objectCtx(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\''+cat+'\')"' : ''));
            var dragAttr = (cat==='tables') ? ' draggable="true" class="my-conn-row drag-table-item tree-table-item" ondragstart="onTableDragStart(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')" ondragend="onTableDragEnd(event)"' : ' class="my-conn-row"';
            // ★ 非表对象：双击查看源码
            var dblClick = 'addTableDataTab(\''+escapeAttr(n)+'\',\''+escapeAttr(qual)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')';
            if (cat === 'procedures') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'PROCEDURE\')';
            else if (cat === 'functions') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'FUNCTION\')';
            else if (cat === 'triggers') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'TRIGGER\')';
            else if (cat === 'sequences') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'SEQUENCE\')';
            else if (cat === 'packages') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'PACKAGE\')';
            else if (cat === 'mviews') dblClick = 'viewObjectSource(\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'MVIEW\')';
            return '<div'+dragAttr+dataAttrs+' style="padding-left:'+itemPad+'px;font-size:11px;line-height:22px;'+(cat!=='tables'?'padding-top:5px;padding-bottom:5px;':'')+'" ondblclick="'+dblClick+'"'+onClick+ctx+'><span class="my-conn-icon">'+catIcon+'</span><span class="tree-table-name">'+escapeHtml(n)+'</span></div>';
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
    // ★ 保留当前折叠/展开状态：只在已展开时局部刷新内容，不强制展开
    var children = el.nextElementSibling;
    var wasOpen = children && children.classList.contains('tree-children') && children.classList.contains('open');
    var pad = _getCatRowPad(rowId);
    if (wasOpen) {
        // 已展开：直接走 refreshCatItem（局部替换而不闪）
        refreshTableCat(cid, db, schema||'', dbKey, pad);
    } else {
        // 未展开：清空缓存内容，下次用户点击展开时会重新加载
        if (children && children.classList.contains('tree-children')) {
            children.innerHTML = '';
        }
    }
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
            // ★ 从文件系统加载查询列表
            eel.tree_list_queries(cid, db)(function(queries) {
                var itemPad = (pad||0) + 20;
                children.innerHTML = (queries || []).map(function (q) {
                    return '<div class="my-conn-row" style="padding-left:'+itemPad+'px;font-size:11px;" ondblclick="openQueryInTab(\''+q.id+'\')" oncontextmenu="queryCtx2(event,\''+q.id+'\',\''+cid+'\',\''+escapeAttr(schema||'')+'\')"><span class="my-conn-icon">📄</span><span class="my-conn-name">'+escapeHtml(q.name)+'</span></div>';
                }).join('') || '<div style="padding-left:'+itemPad+'px;color:#999;font-size:11px;">（无查询）</div>';
            });
        }
    }
}

// 局部刷新查询目录（不改动整个连接树，无感刷新不闪）
function refreshQueriesTree(cid, db, schema) {
    var fullDb = schema ? db+'/'+schema : db;
    if (!cid || !fullDb) return;
    var dbKey = safeBtoa(fullDb);
    var rowId = 'cat_queries_' + dbKey;
    var el = document.getElementById(rowId);
    if (!el) return;
    var children = el.nextElementSibling;
    if (!children || !children.classList.contains('tree-children')) return;
    // ★ 已展开：直接加载替换（不清空旧内容，避免闪）
    if (children.classList.contains('open')) {
        var pad = parseInt(children.getAttribute('data-pad')) || 40;
        var itemPad = pad + 20;
        eel.tree_list_queries(cid, db)(function(queries) {
            children.innerHTML = (queries || []).map(function (q) {
                return '<div class="my-conn-row" style="padding-left:'+itemPad+'px;font-size:11px;" ondblclick="openQueryInTab(\''+q.id+'\')" oncontextmenu="queryCtx2(event,\''+q.id+'\',\''+cid+'\',\''+escapeAttr(schema||'')+'\')"><span class="my-conn-icon">📄</span><span class="my-conn-name">'+escapeHtml(q.name)+'</span></div>';
            }).join('') || '<div style="padding-left:'+itemPad+'px;color:#999;font-size:11px;">（无查询）</div>';
        });
    } else {
        // 未展开：清空缓存，下次点击自动重新加载
        children.innerHTML = '';
    }
    var homeTab = objectTabs.find(function(t){return t.id==='obj_home';});
    // ★ 只有当前真的在 home tab 上才刷新（否则会跳转到 home）
    if (homeTab && activeObjTab === 'obj_home' && activeCatId === rowId) {
        clickQueries(cid, db, schema);
    }
}

// ==================== 左侧树表名内联重命名 ====================
var _treeRenameState = null;      // { div, oldName, db, schema, cid, nameSpan }
var _treeLastSelect = null;
var _treeRangeAnchor = null;      // Shift 范围选择的起点

// 表节点会在同步/删除后通过 innerHTML 重建，使用事件委托保证重建后箭头和高亮仍然可用。
(function() {
    document.addEventListener('click', function(e) {
        var target = e.target;
        if (!target || !target.closest) return;

        var arrow = target.closest('.tree-table-struct-arrow');
        if (arrow) {
            var row = arrow.closest('.tree-table-item');
            if (!row) return;
            e.preventDefault();
            e.stopPropagation();
            toggleTableStruct(
                row.getAttribute('data-tname') || '',
                row.getAttribute('data-db') || '',
                row.getAttribute('data-sch') || '',
                row.getAttribute('data-cid') || '',
                parseInt(row.style.paddingLeft, 10) || 0
            );
            return;
        }

        var tableRow = target.closest('.tree-table-item');
        if (tableRow) treeTableClick(e, tableRow);
    });
})();

function _treeTableRowsInList(div) {
    var container = div && div.closest ? div.closest('.tree-children') : null;
    if (!container) return [div];
    var rows = [];
    Array.prototype.forEach.call(container.children, function(child) {
        if (child.classList && child.classList.contains('tree-table-item')) {
            rows.push(child);
            return;
        }
        var row = child.querySelector ? child.querySelector('.tree-table-item') : null;
        if (row) rows.push(row);
    });
    return rows.length ? rows : [div];
}

// 左侧树表项点击：选择 / 再次点击进入重命名
function treeTableClick(e, div) {
    if (_treeRenameState) return;
    if (e.detail > 1) return; // 双击忽略
    var multi = !!(e.ctrlKey || e.metaKey);
    var range = !!e.shiftKey;
    var rows = _treeTableRowsInList(div);
    var anchorIndex = rows.indexOf(_treeRangeAnchor);
    var targetIndex = rows.indexOf(div);
    var hasRange = range && anchorIndex >= 0 && targetIndex >= 0;
    // Shift 点击选择同一表列表中的连续范围；Ctrl/Command 仍用于追加/取消单项。
    if (hasRange) {
        document.querySelectorAll('.tree-table-item').forEach(function(d) { d.classList.remove('tree-table-selected'); });
        document.querySelectorAll('#obj_content .exp-table tbody tr.drag-table-item').forEach(function(r) { r.classList.remove('table-row-selected'); });
        var from = Math.min(anchorIndex, targetIndex), to = Math.max(anchorIndex, targetIndex);
        rows.slice(from, to + 1).forEach(function(row) { row.classList.add('tree-table-selected'); });
    } else if (!multi) {
        document.querySelectorAll('.tree-table-item').forEach(function(d) {
            d.classList.remove('tree-table-selected');
        });
        document.querySelectorAll('#obj_content .exp-table tbody tr.drag-table-item').forEach(function(r) {
            r.classList.remove('table-row-selected');
        });
        div.classList.add('tree-table-selected');
    } else {
        div.classList.toggle('tree-table-selected');
    }
    // ★ 同时取消左侧分类行的高亮（点击表项时分类行不再高亮）
    document.querySelectorAll('.tree-highlight').forEach(function(r) { r.classList.remove('tree-highlight'); });
    activeCatId = null;

    if (!range) _treeRangeAnchor = div;
    // 多选/范围选择时不触发重命名；普通点击同一项两次仍保留原来的重命名行为。
    if (!multi && !range && _treeLastSelect === div) {
        // 同一项再次点击 → 进入重命名模式
        _startTreeRename(div);
        _treeLastSelect = null;
    } else {
        _treeLastSelect = (multi || range) ? null : div;
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
    input.className = 'tree-rename-input';
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

// ==================== 新建表设计器 Tab ====================
var _newTableStore = {};

// MySQL 数据类型
var _NT_MYSQL_TYPES = ['INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'FLOAT', 'DOUBLE', 'DECIMAL',
    'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYTEXT',
    'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
    'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'TINYBLOB', 'JSON', 'ENUM', 'SET', 'BOOLEAN'];

// ==================== 查看对象源码（存储过程/函数/触发器/序列/包/物化视图）====================
/** 双击存储过程/触发器/序列等对象 → 新建 Tab 显示源码 */
function viewObjectSource(objName, db, schema, cid, objType) {
    var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
    if (!conn || !conn.host) { showWarnDialog('提示', '未找到连接信息'); return; }
    var sch = schema || '';
    var tabId = 'src_' + objType + '_' + objName;
    var typeLabel = {PROCEDURE:'存储过程',FUNCTION:'函数',TRIGGER:'触发器',SEQUENCE:'序列',PACKAGE:'包',MVIEW:'物化视图'}[objType] || '对象';
    addOrUpdateTab(tabId, objName, 'ddl', '<div style="padding:20px;color:#999;">⏳ 加载'+typeLabel+'源码...</div>', db, cid);

    try {
        eel.db_explore_get_proc_source(conn, db, objName, objType, sch)(function(r) {
            if (!r || !r.ok) {
                addOrUpdateTab(tabId, objName, 'ddl', '<div class="qr-error-msg">❌ ' + escapeHtml(r ? r.msg : '加载失败') + '</div>', db, cid);
                return;
            }
            var source = r.source || '';
            var html =
                '<div style="display:flex;flex-direction:column;height:100%;">' +
                '<div class="ddl-toolbar" style="padding:6px 10px;border-bottom:1px solid var(--border-color,#333);display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
                    '<span style="color:#5dade2;font-size:13px;">📄 ' + escapeHtml(typeLabel) + '：' + escapeHtml(objName) + '</span>' +
                    '<button class="btn btn-sm btn-blue" style="margin-left:auto;" onclick="copyObjectSource(\''+escapeAttr(tabId)+'\')">📋 复制</button>' +
                '</div>' +
                '<div style="flex:1;overflow:auto;padding:0;">' +
                    '<pre id="src_pre_'+escapeAttr(tabId)+'" class="ddl-source">' + escapeHtml(source) + '</pre>' +
                '</div>' +
                '</div>';
            addOrUpdateTab(tabId, objName, 'ddl', html, db, cid);
        });
    } catch(e) {
        addOrUpdateTab(tabId, objName, 'ddl', '<div class="qr-error-msg">❌ 调用失败: ' + escapeHtml(String(e)) + '</div>', db, cid);
    }
}

function copyObjectSource(tabId) {
    var pre = document.getElementById('src_pre_' + tabId);
    if (pre) { copyToClipboard(pre.textContent); showOkDialog('成功', '源码已复制到剪贴板'); }
}

// ★ 存储过程右键菜单（查看/编辑/测试/删除）
function procCtx(e, procName, db, schema, cid) {
    e.preventDefault(); e.stopPropagation();
    var sch = schema || '';
    showCtxMenu(e.clientX, e.clientY, [
        {label:'👁 查看源码', action:function(){ viewObjectSource(procName, db, sch, cid, 'PROCEDURE'); }},
        {label:'✏ 编辑源码', action:function(){
            var conn = treeData && treeData.connections ? treeData.connections[cid] : activeConnData;
            if (!conn) return;
            eel.db_explore_get_proc_source(conn, db, procName, 'PROCEDURE', sch)(function(r){
                if (!r || !r.ok) { showErrorDialog('加载失败', r ? r.msg : '未知错误'); return; }
                // 在查询编辑器中打开
                var tmpQid = 'new_' + Date.now();
                _openNewQueryTab(tmpQid, cid, db);
                setTimeout(function(){
                    var ta = document.getElementById('sq_' + tmpQid);
                    if (ta) {
                        ta.value = r.source;
                        ta.dispatchEvent(new Event('input', {bubbles:true}));
                    }
                }, 200);
            });
        }},
        {label:'🧪 测试', action:function(){ openProcTestTab(procName, db, sch, cid); }},
        {label:'♻ 重新编译', action:function(){
            var conn = treeData && treeData.connections ? treeData.connections[cid] : activeConnData;
            if (!conn) return;
            eel.db_explore_compile_object(conn, db, procName, 'PROCEDURE', sch)(function(r){
                if (r && r.ok) {
                    showOkDialog('编译成功', r.msg || '已重新编译：' + procName);
                    var safeKey = safeBtoa(db + (sch ? '/' + sch : ''));
                    refreshCatItem('procedures', cid, db, sch, safeKey, _getCatRowPad('cat_procedures_' + safeKey));
                } else {
                    showErrorDialog('编译失败', r ? r.msg : '未知错误');
                }
            });
        }},
        {type:'separator'},
        {label:'🗑 删除', action:function(){
            showConfirmDialog('删除存储过程', '确认删除存储过程 <b>['+escapeHtml(procName)+']</b> ？删除后不可恢复！',
                function(){
                    var conn = treeData && treeData.connections ? treeData.connections[cid] : activeConnData;
                    if (!conn) return;
                    eel.db_explore_drop_object(conn, db, procName, 'PROCEDURE', sch)(function(r){
                        if (r && r.ok) {
                            showOkDialog('成功', '已删除：' + procName);
                            refreshTableFolder(cid, db, sch);
                        } else {
                            showErrorDialog('删除失败', r ? r.msg : '未知错误');
                        }
                    });
                }, function(){}, '确定', '取消');
        }}
    ]);
}

// ★ 通用对象右键菜单（函数/触发器/包/序列/视图/物化视图）
function objectCtx(e, objName, db, schema, cid, objType) {
    e.preventDefault(); e.stopPropagation();
    var sch = schema || '';
    var typeLabel = {procedures:'存储过程',functions:'函数',triggers:'触发器',packages:'包',sequences:'序列',views:'视图',mviews:'物化视图'}[objType] || '对象';
    var ot = objType==='functions'?'FUNCTION':objType==='triggers'?'TRIGGER':objType==='packages'?'PACKAGE':objType==='sequences'?'SEQUENCE':objType==='views'?'VIEW':objType==='mviews'?'MVIEW':'PROCEDURE';
    showCtxMenu(e.clientX, e.clientY, [
        {label:'👁 查看源码', action:function(){ viewObjectSource(objName, db, sch, cid, ot); }},
        {label:'♻ 重新编译', action:function(){
            var conn = treeData && treeData.connections ? treeData.connections[cid] : activeConnData;
            if (!conn) return;
            eel.db_explore_compile_object(conn, db, objName, ot, sch)(function(r){
                if (r && r.ok) {
                    showOkDialog('编译成功', r.msg || '已重新编译：' + objName);
                    var catMap = {FUNCTION:'functions', TRIGGER:'triggers', VIEW:'views', MVIEW:'mviews', SEQUENCE:'sequences', PACKAGE:'packages'};
                    var catKey = catMap[ot] || 'procedures';
                    var safeKey = safeBtoa(db + (sch ? '/' + sch : ''));
                    refreshCatItem(catKey, cid, db, sch, safeKey, _getCatRowPad('cat_' + catKey + '_' + safeKey));
                } else showErrorDialog('编译失败', r ? r.msg : '未知错误');
            });
        }},
        {label:'🗑 删除', action:function(){
            showConfirmDialog('删除'+typeLabel, '确认删除'+typeLabel+' <b>['+escapeHtml(objName)+']</b> ？',
                function(){
                    var conn = treeData && treeData.connections ? treeData.connections[cid] : activeConnData;
                    if (!conn) return;
                    eel.db_explore_drop_object(conn, db, objName, ot, sch)(function(r){
                        if (r && r.ok) { showOkDialog('成功', '已删除：'+objName); refreshTableFolder(cid, db, sch); }
                        else showErrorDialog('删除失败', r ? r.msg : '未知错误');
                    });
                }, function(){}, '确定', '取消');
        }}
    ]);
}

// ★ 一键编译并打开测试窗口
function compileProcTest(tabId, procName, db, schema, cid) {
    var sch = schema || '';
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) return;
    addOrUpdateTab(tabId, '测试：'+procName, 'ddl', '<div style="padding:20px;color:#999;">⏳ 编译中...</div>', db, cid);
    eel.db_explore_compile_object(conn, db, procName, 'PROCEDURE', sch)(function(r2){
        if (!r2 || !r2.ok) {
            var errMsg = r2 ? r2.msg : '未知错误';
            var parts = (errMsg || '').split('\n\n');
            var header = parts[0] || '编译失败';
            var detail = parts.slice(1).join('\n\n');
            var html = '<div style="padding:20px;">' +
                '<div style="color:#e74c3c;font-size:14px;font-weight:bold;margin-bottom:10px;">❌ ' + escapeHtml(header) + '</div>' +
                (detail ? '<pre style="background:#1a1f2a;color:#f39c12;padding:12px;border-radius:4px;margin:8px 0;max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.5;">' + escapeHtml(detail) + '</pre>' : '') +
                '<div style="margin-top:14px;display:flex;gap:8px;justify-content:center;">' +
                    '<button class="btn btn-sm" onclick="viewObjectSource(\''+escapeAttr(procName)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+escapeAttr(cid)+'\',\'PROCEDURE\')">📄 查看源码定位</button>' +
                    '<button class="btn btn-sm btn-blue" onclick="retryCompileProcTest(\''+escapeAttr(tabId)+'\',\''+escapeAttr(procName)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+escapeAttr(cid)+'\')">♻ 重试编译</button>' +
                '</div>' +
                '</div>';
            addOrUpdateTab(tabId, '测试：'+procName, 'ddl', html, db, cid);
            return;
        }
        // 编译成功，重新打开测试窗口
        openProcTestTab(procName, db, schema, cid);
    });
}

function retryCompileProcTest(tabId, procName, db, schema, cid) {
    compileProcTest(tabId, procName, db, schema, cid);
}

// ★ 存储过程测试窗口：上半 PL/SQL 调用块（只读参考） + 下半参数表（带勾选/类型下拉/值）
function openProcTestTab(procName, db, schema, cid) {
    var sch = schema || '';
    var tabId = 'proctest_' + procName;
    var loadingHtml = '<div style="padding:20px;color:#999;">⏳ 加载参数信息...</div>';
    addOrUpdateTab(tabId, '测试：' + procName, 'ddl', loadingHtml, db, cid);
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) { addOrUpdateTab(tabId, '测试：'+procName, 'ddl', '<div class="qr-error-msg">未找到连接信息</div>', db, cid); return; }
    eel.db_explore_get_proc_params(conn, db, procName, sch)(function(r){
        if (!r || !r.ok) {
            var errMsg = escapeHtml(r ? r.msg : '加载失败');
            // ★ 如果是 INVALID 状态，直接提供「立即编译」按钮
            if (r && r.msg && r.msg.indexOf('INVALID') >= 0) {
                addOrUpdateTab(tabId, '测试：'+procName, 'ddl',
                    '<div style="padding:20px;text-align:center;color:#e67e22;">⚡ 存储过程当前为 INVALID 状态，可能因依赖表变更导致。<br/><br/>' +
                    '<button class="btn btn-sm btn-blue" onclick="compileProcTest(\''+escapeAttr(tabId)+'\',\''+escapeAttr(procName)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+escapeAttr(cid)+'\')">♻ 立即编译并继续</button></div>', db, cid);
            } else {
                addOrUpdateTab(tabId, '测试：'+procName, 'ddl', '<div class="qr-error-msg">❌ ' + errMsg + '</div>', db, cid);
            }
            return;
        }
        var params = r.params || [];
        // ★ 上方表格只展示需要输入的参数（IN / IN/OUT），纯 OUT 在下方展示
        var inputParams = params.filter(function(p){ return p.io === 'IN' || p.io === 'IN/OUT' || p.io === 'INOUT'; });
        var rowsHtml = inputParams.map(function(p, i){
            var definedType = p.type || '未定义';
            var tip = (p.io === 'IN/OUT' || p.io === 'INOUT') ? ' title="IN/OUT 参数，输出值也会在下方展示"' : '';
            return '<tr data-name="'+escapeAttr(p.name)+'" data-io="'+escapeAttr(p.io||'IN')+'">' +
                '<td class="proc-test-enabled"><input type="checkbox" checked class="proc-test-check"></td>' +
                '<td class="proc-test-param-name">' + escapeHtml(p.name) + '</td>' +
                '<td class="proc-test-type-cell"><span class="proc-test-type-readonly" title="存储过程定义类型">' + escapeHtml(definedType) + '</span></td>' +
                '<td class="proc-test-value-cell"><input class="proc-test-input" data-orig-type="'+escapeAttr(definedType)+'"' + tip + '></td>' +
                '</tr>';
        }).join('');
        var plsqlBlock = _buildProcCallBlock(procName, params);
        var html =
            '<div class="proc-test-view">' +
                '<div class="proc-test-toolbar">' +
                    '<div class="proc-test-title-wrap">' +
                        '<span class="proc-test-icon">🧪</span>' +
                        '<span class="proc-test-title">存储过程测试</span>' +
                        '<span class="proc-test-name">' + escapeHtml(procName) + '</span>' +
                    '</div>' +
                    '<button class="btn btn-sm btn-blue proc-test-run-btn" onclick="runProcTest(\''+escapeAttr(tabId)+'\',\''+escapeAttr(procName)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')">▶ 执行</button>' +
                '</div>' +
                '<div class="proc-test-body">' +
                    '<section class="proc-test-card proc-test-code-card">' +
                        '<div class="proc-section-heading">' +
                            '<div><span class="proc-section-title">PL/SQL 调用</span><span class="proc-section-subtitle">参考代码</span></div>' +
                            '<span class="proc-reference-badge">只读</span>' +
                        '</div>' +
                        '<textarea readonly class="proc-plsql-block">' + escapeHtml(plsqlBlock) + '</textarea>' +
                    '</section>' +
                    '<div class="proc-test-splitter" onmousedown="startProcTestResize(event,this)" ondblclick="resetProcTestResize(this)" title="上下拖动调整区域高度，双击恢复默认比例"></div>' +
                    '<section class="proc-test-card proc-test-params-card">' +
                        '<div class="proc-section-heading">' +
                            '<div><span class="proc-section-title">输入参数</span><span class="proc-section-subtitle">IN / INOUT</span></div>' +
                            '<span class="proc-param-hint">勾选后参与执行</span>' +
                        '</div>' +
                        '<div class="proc-test-params-scroll">' +
                        '<div class="proc-test-tip">' +
                        '<svg viewBox="0 0 16 16" width="10" height="10" style="vertical-align:middle;opacity:0.7;"><path d="M8 1l8 14H0z" fill="currentColor"/></svg> ' +
                        '下方表格仅展示输入参数（IN / IN/OUT）。纯 OUT 参数和函数返回值会自动在「出参/返回值」中显示。' +
                        '</div>' +
                    '<div class="proc-test-table-wrap"><table class="proc-test-table">' +
                        '<thead><tr><th>启用</th><th>变量</th><th>类型</th><th>值</th></tr></thead>' +
                        '<tbody>' + (rowsHtml || '<tr><td colspan="4" class="proc-test-empty">（无入参）</td></tr>') + '</tbody>' +
                    '</table></div>' +
                    '<div class="proc-output-heading">出参 / 返回值</div>' +
                        '<div id="'+escapeAttr(tabId)+'_results" class="proc-test-results"><div class="proc-test-result proc-test-result-empty">（点击执行后查看结果）</div></div>' +
                        '</div>' +
                    '</section>' +
                '</div>' +
            '</div>';
        addOrUpdateTab(tabId, '测试：' + procName, 'ddl', html, db, cid);
    });
}

// ★ 存储过程测试页：拖动参考代码与参数区之间的分割线调整上下高度
var _procTestResizeState = null;
function startProcTestResize(e, divider) {
    if (!e || e.button !== 0 || !divider) return;
    e.preventDefault();
    e.stopPropagation();
    var body = divider.parentElement;
    var codeCard = divider.previousElementSibling;
    var paramsCard = divider.nextElementSibling;
    if (!body || !codeCard || !paramsCard) return;

    if (_procTestResizeState) finishProcTestResize();
    _procTestResizeState = {
        body: body,
        codeCard: codeCard,
        paramsCard: paramsCard,
        startY: e.clientY,
        startHeight: codeCard.getBoundingClientRect().height,
        oldCursor: document.body.style.cursor,
        oldUserSelect: document.body.style.userSelect
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onProcTestResizeMove);
    document.addEventListener('mouseup', finishProcTestResize);
}

function onProcTestResizeMove(e) {
    var state = _procTestResizeState;
    if (!state) return;
    var minCodeHeight = 150;
    var minParamsHeight = 230;
    var bodyHeight = state.body.clientHeight;
    var splitterHeight = state.body.querySelector('.proc-test-splitter').offsetHeight;
    var gapsAndPadding = 40; // 上下 padding + 三个子项之间的 gap
    var maxCodeHeight = Math.max(minCodeHeight, bodyHeight - splitterHeight - gapsAndPadding - minParamsHeight);
    var nextHeight = state.startHeight + (e.clientY - state.startY);
    nextHeight = Math.max(minCodeHeight, Math.min(maxCodeHeight, nextHeight));
    state.codeCard.style.flex = '0 0 ' + nextHeight + 'px';
    state.codeCard.style.height = nextHeight + 'px';
    state.paramsCard.style.flex = '1 1 auto';
    state.paramsCard.style.height = 'auto';
}

function finishProcTestResize() {
    var state = _procTestResizeState;
    if (!state) return;
    document.removeEventListener('mousemove', onProcTestResizeMove);
    document.removeEventListener('mouseup', finishProcTestResize);
    document.body.style.cursor = state.oldCursor || '';
    document.body.style.userSelect = state.oldUserSelect || '';
    _procTestResizeState = null;
}

function resetProcTestResize(divider) {
    if (!divider) return;
    if (_procTestResizeState) finishProcTestResize();
    var codeCard = divider.previousElementSibling;
    var paramsCard = divider.nextElementSibling;
    if (codeCard) {
        codeCard.style.removeProperty('flex');
        codeCard.style.removeProperty('height');
    }
    if (paramsCard) {
        paramsCard.style.removeProperty('flex');
        paramsCard.style.removeProperty('height');
    }
}

// ★ 构造 PL/SQL 调用块（参考展示）
function _buildProcCallBlock(procName, params) {
    if (!params || params.length === 0) {
        return 'begin\n  --call the procedure\n  ' + procName + ';\nend;';
    }
    var firstIndent = '  ' + procName + '(';
    var contIndent = ' '.repeat(firstIndent.length);
    var lines = ['begin', '  --call the procedure'];
    params.forEach(function(p, i) {
        var isLast = (i === params.length - 1);
        var prefix = i === 0 ? firstIndent : contIndent;
        var sep = isLast ? ');' : ',';
        lines.push(prefix + p.name + ' => :' + p.name + sep);
    });
    lines.push('end;');
    return lines.join('\n');
}

// ★ 执行存储过程测试
function runProcTest(tabId, procName, db, schema, cid) {
    var sch = schema || '';
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) return;
    var inputs = [];
    var rows = document.querySelectorAll('#'+tabId+' tbody tr[data-name]');
    rows.forEach(function(row){
        var name = row.getAttribute('data-name');
        var io = row.getAttribute('data-io');
        var checked = row.querySelector('.proc-test-check');
        var typeLabel = row.querySelector('.proc-test-type-readonly');
        var input = row.querySelector('.proc-test-input');
        inputs.push({
            name: name,
            io: io,
            value: input ? input.value : '',
            data_type: typeLabel ? typeLabel.textContent : '',
            enabled: checked ? checked.checked : true
        });
    });
    var resultDiv = document.getElementById(tabId + '_results');
    if (resultDiv) resultDiv.innerHTML = '<div class="proc-test-result proc-test-result-loading">⏳ 执行中...</div>';
    eel.db_explore_test_proc(conn, db, procName, inputs, sch)(function(r){
        if (!resultDiv) return;
        if (!r || !r.ok) {
            resultDiv.innerHTML = '<div class="qr-error-msg">❌ ' + escapeHtml(r ? r.msg : '执行失败') + '</div>';
            return;
        }
        var outRows = (r.outputs || []).map(function(o){
            return '<tr><td class="proc-output-name">' + escapeHtml(o.name) + '</td>' +
                '<td class="proc-test-result">' + escapeHtml(o.value === null ? 'NULL' : String(o.value)) + '</td></tr>';
        }).join('');
        var html = '<table class="proc-test-table" style="margin-top:4px;"><thead><tr><th>参数</th><th>值</th></tr></thead><tbody>' +
            (outRows || '<tr><td colspan="2" class="proc-test-result proc-test-result-empty">（无返回）</td></tr>') + '</tbody></table>';
        if (r.msg) html += '<div class="proc-test-result proc-test-result-success">✅ ' + escapeHtml(r.msg) + '</div>';
        resultDiv.innerHTML = html;
    });
}

// PostgreSQL 数据类型
var _NT_PG_TYPES = ['INTEGER', 'SERIAL', 'BIGINT', 'BIGSERIAL', 'SMALLINT', 'DECIMAL', 'NUMERIC',
    'FLOAT4', 'FLOAT8', 'REAL', 'BOOLEAN',
    'VARCHAR', 'CHAR', 'TEXT', 'BYTEA',
    'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL',
    'JSON', 'JSONB', 'UUID', 'INET', 'CIDR'];

// Oracle 数据类型
var _NT_ORA_TYPES = ['NUMBER', 'INTEGER', 'FLOAT', 'BINARY_FLOAT', 'BINARY_DOUBLE',
    'VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'CLOB', 'NCLOB',
    'DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMP WITH LOCAL TIME ZONE',
    'BLOB', 'RAW', 'LONG', 'LONG RAW', 'ROWID', 'UROWID', 'XMLTYPE'];

var _NT_ENGINES = ['InnoDB', 'MyISAM', 'MEMORY'];

function _ntIsOracle(tabId) {
    var st = _newTableStore[tabId];
    return st && st._dbType === 'oracle';
}

function _ntIsPG(tabId) {
    var st = _newTableStore[tabId];
    return st && st._dbType === 'postgresql';
}

function _ntGetTypes(tabId) {
    if (_ntIsOracle(tabId)) return _NT_ORA_TYPES;
    if (_ntIsPG(tabId)) return _NT_PG_TYPES;
    return _NT_MYSQL_TYPES;
}

function _ntDefaultField(tabId) {
    if (_ntIsOracle(tabId)) {
        return {name:'', data_type:'VARCHAR2', length:'255', nullable:true, primary_key:false,
            default_val:'', comment:'', auto_increment:false, auto_update:false};
    }
    if (_ntIsPG(tabId)) {
        return {name:'', data_type:'VARCHAR', length:'255', nullable:true, primary_key:false,
            default_val:'', comment:'', auto_increment:false, auto_update:false};
    }
    return {name:'', data_type:'VARCHAR', length:'255', nullable:true, primary_key:false,
        default_val:'', comment:'', auto_increment:false, auto_update:false};
}

function _ntCollectFields(tabId) {
    var st = _newTableStore[tabId];
    if (!st) return;
    var rows = document.querySelectorAll('#nt_fields_table_' + tabId + ' tbody tr');
    st.fields = [];
    for (var ri = 0; ri < rows.length; ri++) {
        var row = rows[ri];
        var nameEl = row.querySelector('.nt-fname');
        var typeEl = row.querySelector('.nt-ftype');
        var lenEl = row.querySelector('.nt-flen');
        var nullEl = row.querySelector('.nt-fnull');
        var pkEl = row.querySelector('.nt-fpk');
        var defEl = row.querySelector('.nt-fdef');
        var cmtEl = row.querySelector('.nt-fcmt');
        var aiEl = row.querySelector('.nt-fai');
        var auEl = row.querySelector('.nt-fau');
        st.fields.push({
            name: (nameEl ? nameEl.value : '').trim(),
            data_type: typeEl ? typeEl.value.toUpperCase() : 'VARCHAR',
            length: lenEl ? lenEl.value.trim() : '',
            nullable: nullEl ? nullEl.checked : true,
            primary_key: pkEl ? pkEl.checked : false,
            default_val: defEl ? defEl.value.trim() : '',
            comment: cmtEl ? cmtEl.value.trim() : '',
            auto_increment: aiEl ? aiEl.checked : false,
            auto_update: auEl ? auEl.checked : false
        });
    }
}

function _ntBuildFieldRow(tabId, i, field) {
    var f = field || _ntDefaultField(tabId);
    var allTypes = _ntGetTypes(tabId);
    var typeOpts = allTypes.map(function(t) {
        return '<option value="' + t + '"' + ((f.data_type||'').toUpperCase() === t ? ' selected' : '') + '>' + t + '</option>';
    }).join('');
    var extHtml = '';
    if (_ntIsOracle(tabId)) {
        // Oracle: 自动生成（IDENTITY）代替自增，无自动更新
        extHtml = '<input type="checkbox" class="nt-fai" data-row="' + i + '"' + (f.auto_increment ? ' checked' : '') + ' title="自动生成(GENERATED AS IDENTITY)">&nbsp;IDENTITY';
    } else if (_ntIsPG(tabId)) {
        // PostgreSQL: SERIAL / IDENTITY
        extHtml = '<input type="checkbox" class="nt-fai" data-row="' + i + '"' + (f.auto_increment ? ' checked' : '') + ' title="自增(SERIAL/GENERATED AS IDENTITY)">&nbsp;自增';
    } else {
        extHtml = '<input type="checkbox" class="nt-fai" data-row="' + i + '"' + (f.auto_increment ? ' checked' : '') + ' title="自增">&nbsp;自增' +
            '<br><input type="checkbox" class="nt-fau" data-row="' + i + '"' + (f.auto_update ? ' checked' : '') + ' title="自动更新时间">&nbsp;自动更新';
    }
    return '<tr data-row="' + i + '">' +
        '<td style="text-align:center;color:#888;width:30px;">' + (i + 1) + '</td>' +
        '<td><input class="design-input nt-fname" value="' + escapeAttr(f.name) + '" placeholder="字段名" data-row="' + i + '"></td>' +
        '<td><select class="design-select nt-ftype" data-row="' + i + '">' + typeOpts + '</select></td>' +
        '<td style="width:70px;"><input class="design-input nt-flen" value="' + escapeAttr(f.length || '') + '" placeholder="长度" data-row="' + i + '" style="width:65px;"></td>' +
        '<td style="text-align:center;width:45px;"><input type="checkbox" class="nt-fnull" data-row="' + i + '"' + (f.nullable ? ' checked' : '') + ' title="可为空"></td>' +
        '<td style="text-align:center;width:40px;"><input type="checkbox" class="nt-fpk" data-row="' + i + '"' + (f.primary_key ? ' checked' : '') + ' title="主键"></td>' +
        '<td><input class="design-input nt-fdef" value="' + escapeAttr((f.default_val === null || f.default_val === undefined) ? '' : String(f.default_val)) + '" placeholder="默认值" data-row="' + i + '"></td>' +
        '<td><input class="design-input nt-fcmt" value="' + escapeAttr(f.comment || '') + '" placeholder="注释" data-row="' + i + '"></td>' +
        '<td style="text-align:center;white-space:nowrap;width:80px;">' + extHtml + '</td>' +
        '<td style="white-space:nowrap;width:80px;">' +
            '<button class="btn btn-sm" style="background:#2980b9;color:#fff;font-size:10px;padding:2px 5px;" onclick="_ntMoveField(\'' + tabId + '\',' + i + ',-1)" title="上移" ' + (i===0?'disabled':'') + '>↑</button>&nbsp;' +
            '<button class="btn btn-sm" style="background:#3380b9;color:#fff;font-size:10px;padding:2px 5px;" onclick="_ntMoveField(\'' + tabId + '\',' + i + ',1)" title="下移">↓</button>&nbsp;' +
            '<button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;padding:2px 5px;" onclick="_ntRemoveField(\'' + tabId + '\',' + i + ')" title="移除">✕</button>' +
        '</td></tr>';
}

function _ntRebuildTable(tabId) {
    // ★ 不再调用 _ntCollectFields，因为调用者（_ntAddField/_ntRemoveField/_ntMoveField）
    //    已经先调用了 _ntCollectFields 并修改了 st.fields，这里再读 DOM 会覆盖掉修改
    var st = _newTableStore[tabId];
    if (!st) return;
    var rowsHtml = '';
    for (var i = 0; i < st.fields.length; i++) {
        rowsHtml += _ntBuildFieldRow(tabId, i, st.fields[i]);
    }
    var tbody = document.getElementById('nt_fields_tbody_' + tabId);
    if (tbody) tbody.innerHTML = rowsHtml;
}

function _ntAddField(tabId) {
    _ntCollectFields(tabId);
    var st = _newTableStore[tabId];
    if (!st) return;
    st.fields.push(_ntDefaultField(tabId));
    _ntRebuildTable(tabId);
}

function _ntRemoveField(tabId, row) {
    _ntCollectFields(tabId);
    var st = _newTableStore[tabId];
    if (!st) return;
    if (st.fields.length <= 1) return;
    st.fields.splice(row, 1);
    _ntRebuildTable(tabId);
}

function _ntMoveField(tabId, row, dir) {
    _ntCollectFields(tabId);
    var st = _newTableStore[tabId];
    if (!st) return;
    var newPos = row + dir;
    if (newPos < 0 || newPos >= st.fields.length) return;
    var tmp = st.fields[row];
    st.fields[row] = st.fields[newPos];
    st.fields[newPos] = tmp;
    _ntRebuildTable(tabId);
}

function _ntGenerateSQL(tabId) {
    _ntCollectFields(tabId);
    var st = _newTableStore[tabId];
    if (!st) return '';
    var tblName = st.tblName.trim();
    if (!tblName) return '';
    var isOracle = _ntIsOracle(tabId);
    var isPG = _ntIsPG(tabId);
    var isMySQL = !isOracle && !isPG;
    // 引用符：MySQL 用反引号，Oracle/PG 用双引号
    var q = isMySQL ? '`' : '"';
    // Oracle 数值类型匹配（用于 DEFAULT 值不加引号判断）
    var oraNumTypes = /^(NUMBER|INTEGER|FLOAT|BINARY_FLOAT|BINARY_DOUBLE)$/i;
    var mysqlNumTypes = /^(INT|BIGINT|TINYINT|SMALLINT|MEDIUMINT|FLOAT|DOUBLE|DECIMAL)$/i;
    var pgNumTypes = /^(INTEGER|SERIAL|BIGINT|BIGSERIAL|SMALLINT|DECIMAL|NUMERIC|FLOAT4|FLOAT8|REAL)$/i;

    var lines = [];
    var pkCols = [];
    for (var i = 0; i < st.fields.length; i++) {
        var f = st.fields[i];
        if (!f.name) continue;
        var dtUpper = f.data_type.toUpperCase();
        var line = '  ' + q + f.name + q + ' ' + f.data_type;
        // 长度：SERIAL/BIGSERIAL 类型不需要长度
        if (f.length && f.length !== '0') {
            if (isPG && (dtUpper === 'SERIAL' || dtUpper === 'BIGSERIAL')) {
                // SERIAL 不需要长度
            } else {
                line += '(' + f.length + ')';
            }
        }
        if (!f.nullable) line += ' NOT NULL';
        // 自增：不同数据库不同语法
        if (f.auto_increment) {
            if (isOracle) {
                line += ' GENERATED BY DEFAULT AS IDENTITY';
            } else if (isPG) {
                // PG: 如果类型是 SERIAL/BIGSERIAL 则自带自增，否则加 GENERATED AS IDENTITY
                if (dtUpper !== 'SERIAL' && dtUpper !== 'BIGSERIAL') {
                    line += ' GENERATED BY DEFAULT AS IDENTITY';
                }
            } else {
                line += ' AUTO_INCREMENT';
            }
        }
        // 默认值
        if (f.default_val !== '' && f.default_val !== undefined && f.default_val !== null) {
            var dv = f.default_val;
            var isNum;
            if (isOracle) {
                isNum = oraNumTypes.test(f.data_type);
            } else if (isPG) {
                isNum = pgNumTypes.test(f.data_type);
            } else {
                isNum = mysqlNumTypes.test(f.data_type);
            }
            if (isNum || dv === 'CURRENT_TIMESTAMP' || dv === 'SYSDATE' || dv === 'NOW()' || /^\d+(\.\d+)?$/.test(dv)) {
                line += ' DEFAULT ' + dv;
            } else {
                line += " DEFAULT '" + dv.replace(/'/g,"\\'") + "'";
            }
        }
        // 注释：MySQL/Oracle 支持 COMMENT，PG 不支持行内 COMMENT
        if (f.comment && (isMySQL || isOracle)) {
            line += " COMMENT '" + f.comment.replace(/'/g,"\\'") + "'";
        }
        lines.push(line);
        if (f.primary_key) pkCols.push(q + f.name + q);
    }
    if (pkCols.length > 0) {
        lines.push('  PRIMARY KEY (' + pkCols.join(', ') + ')');
    }
    // MySQL 特有：ON UPDATE CURRENT_TIMESTAMP
    if (isMySQL) {
        for (var j = 0; j < lines.length; j++) {
            var f2 = st.fields[j];
            if (f2 && f2.auto_update && f2.name && (f2.data_type.toUpperCase() === 'TIMESTAMP' || f2.data_type.toUpperCase() === 'DATETIME')) {
                lines[j] += ' ON UPDATE CURRENT_TIMESTAMP';
            }
        }
    }
    var sql = 'CREATE TABLE ' + q + tblName + q + ' (\n' + lines.join(',\n') + '\n)';
    // MySQL 特有：ENGINE 和 CHARSET
    if (isMySQL && st.engine) sql += ' ENGINE=' + st.engine;
    if (isMySQL && st.charset) sql += ' DEFAULT CHARSET=' + st.charset;
    // 表注释：MySQL 支持，Oracle/PG 用单独 COMMENT ON 语句
    if (st.tblComment) {
        if (isMySQL) {
            sql += " COMMENT='" + st.tblComment.replace(/'/g,"\\'") + "'";
        }
    }
    // Oracle 不以分号结尾（Oracle 驱动可能报错），PG/MySQL 加
    if (!isOracle) sql += ';';
    // PG/Oracle 表注释用单独的 COMMENT ON 语句
    if (st.tblComment && (isOracle || isPG)) {
        sql += '\nCOMMENT ON TABLE ' + q + tblName + q + " IS '" + st.tblComment.replace(/'/g,"''") + "'";
        if (isOracle) sql += ''; else sql += ';';
    }
    return sql;
}

function _ntExecCreate(tabId) {
    _ntCollectFields(tabId);
    var st = _newTableStore[tabId];
    if (!st) return;
    var tblName = st.tblName.trim();
    if (!tblName) { showErrorDialog('错误', '请输入表名'); return; }
    var validFields = st.fields.filter(function(f){ return f.name.trim() !== ''; });
    if (validFields.length === 0) { showErrorDialog('错误', '请至少添加一个字段'); return; }
    var sql = _ntGenerateSQL(tabId);
    if (!sql) { showErrorDialog('错误', '无法生成 SQL'); return; }
    // 确认弹窗
    document.getElementById('modal_icon').innerHTML = '🔍';
    document.getElementById('modal_title').textContent = '确认创建表';
    document.getElementById('modal_title').style.color = '#27ae60';
    document.getElementById('modal_msg').innerHTML =
        '<div style="margin-bottom:8px;font-size:11px;color:#888;">即将执行以下 SQL：</div>' +
        '<textarea readonly style="width:100%;height:180px;background:#0d1117;border:1px solid #333;border-radius:6px;color:#e0e0e0;padding:8px;font-family:Consolas,monospace;font-size:11px;">' + escapeHtml(sql) + '</textarea>';
    document.getElementById('modal_btns').innerHTML =
        '<button class="btn btn-gray" onclick="hideModal()">取消</button>' +
        '<button class="btn btn-green" onclick="hideModal();_ntDoCreate(\'' + tabId + '\')">✅ 确认创建</button>';
    document.getElementById('modal_overlay').classList.add('show');
}

function _ntDoCreate(tabId) {
    var st = _newTableStore[tabId];
    if (!st) return;
    var sql = _ntGenerateSQL(tabId);
    if (!sql) return;
    var conn = st.cid ? (treeData && treeData.connections ? treeData.connections[st.cid] : null) : activeConnData;
    if (!conn) { showErrorDialog('错误', '未找到连接信息'); return; }
    var opId = 'create_table_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    showModal('⏹', '正在创建表',
        '<div style="text-align:center;padding:16px;color:#aaa;">正在执行建表 SQL...</div>',
        '#e67e22',
        '<button class="btn btn-red btn-sm" onclick="eel.cancel_query()();this.disabled=true;this.textContent=\'正在终止...\'">⏹ 取消执行</button>');
    eel.table_execute_sql(conn, st.db, sql, st.schema, opId)(function(r) {
        hideModal();
        if (r && r.cancelled) {
            showWarnDialog('已取消', '建表操作已被取消');
            return;
        }
        if (r && r.ok) {
            showOkDialog('成功', r.msg);
            // 刷新表列表
            setTimeout(function() { refreshTableFolder(st.cid, st.db, st.schema); }, 500);
            // 清理 store 并关闭新建表 tab
            delete _newTableStore[tabId];
            closeTab(tabId);
        } else {
            showErrorDialog('失败', r ? r.msg : '未知错误');
        }
    });
}

function _ntBuildFullUI(tabId) {
    var st = _newTableStore[tabId];
    if (!st) return '';
    var isMySQL = !_ntIsOracle(tabId) && !_ntIsPG(tabId);
    var engOpts = _NT_ENGINES.map(function(e) {
        return '<option value="' + e + '"' + (st.engine === e ? ' selected' : '') + '>' + e + '</option>';
    }).join('');

    var rowsHtml = '';
    for (var i = 0; i < st.fields.length; i++) {
        rowsHtml += _ntBuildFieldRow(tabId, i, st.fields[i]);
    }

    // 引擎/字符集（仅 MySQL 需要）
    var dbExtHtml = '';
    if (isMySQL) {
        dbExtHtml = '<span style="font-size:11px;color:#888;">引擎:</span>' +
            '<select class="design-select" id="nt_tbl_engine_' + tabId + '" style="width:110px;" onchange="(_newTableStore[\'' + tabId + '\']||{}).engine=this.value">' + engOpts + '</select>' +
            '<span style="font-size:11px;color:#888;">字符集:</span>' +
            '<select class="design-select" id="nt_tbl_charset_' + tabId + '" style="width:110px;" onchange="(_newTableStore[\'' + tabId + '\']||{}).charset=this.value">' +
                '<option value="utf8mb4"' + (st.charset === 'utf8mb4' ? ' selected' : '') + '>utf8mb4</option>' +
                '<option value="utf8"' + (st.charset === 'utf8' ? ' selected' : '') + '>utf8</option>' +
                '<option value="latin1"' + (st.charset === 'latin1' ? ' selected' : '') + '>latin1</option>' +
            '</select>';
    } else {
        // Oracle/PG 显示数据库类型标识
        var dbLabel = _ntIsOracle(tabId) ? 'Oracle' : 'PostgreSQL';
        dbExtHtml = '<span style="font-size:10px;color:#f39c12;margin-left:4px;">[' + dbLabel + ']</span>';
    }

    return '<div class="designer-container">' +
        '<div class="designer-toolbar">' +
            '<b style="font-size:13px;color:#27ae60;">📝 新建表</b>' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
                '<span style="font-size:11px;color:#888;">表名:</span>' +
                '<input class="design-input" id="nt_tbl_name_' + tabId + '" value="' + escapeAttr(st.tblName) + '" placeholder="请输入表名" style="width:160px;" oninput="(_newTableStore[\'' + tabId + '\']||{}).tblName=this.value">' +
                '<span style="font-size:11px;color:#888;">注释:</span>' +
                '<input class="design-input" id="nt_tbl_cmt_' + tabId + '" value="' + escapeAttr(st.tblComment) + '" placeholder="可选" style="width:160px;" oninput="(_newTableStore[\'' + tabId + '\']||{}).tblComment=this.value">' +
                dbExtHtml +
            '</div>' +
            '<div style="display:flex;gap:6px;">' +
                '<button class="btn btn-sm" style="background:#f39c12;color:#fff;" onclick="_ntPreviewSQL(\'' + tabId + '\')">📄 预览SQL</button>' +
                '<button class="btn btn-sm" id="nt_btn_create_' + tabId + '" style="background:#27ae60;color:#fff;" onclick="_ntExecCreate(\'' + tabId + '\')">✅ 创建表</button>' +
            '</div>' +
        '</div>' +
        '<div style="padding:6px 12px;display:flex;align-items:center;gap:6px;border-bottom:1px solid #333;flex-shrink:0;">' +
            '<button class="btn btn-sm" onclick="_ntAddField(\'' + tabId + '\')" style="background:#27ae60;color:#fff;">+ 新增字段</button>' +
            '<span style="font-size:10px;color:#666;">共 <b id="nt_fcount_' + tabId + '">' + st.fields.length + '</b> 个字段</span>' +
        '</div>' +
        '<div style="overflow:auto;flex:1;min-height:0;">' +
            '<table class="design-table" id="nt_fields_table_' + tabId + '">' +
                '<thead><tr>' +
                    '<th style="width:30px;">#</th>' +
                    '<th style="min-width:100px;">字段名</th>' +
                    '<th style="min-width:100px;">类型</th>' +
                    '<th style="width:70px;">长度</th>' +
                    '<th style="width:45px;" title="可为空">Null</th>' +
                    '<th style="width:40px;" title="主键">PK</th>' +
                    '<th style="min-width:80px;">默认值</th>' +
                    '<th style="min-width:80px;">注释</th>' +
                    '<th style="width:80px;">扩展属性</th>' +
                    '<th style="width:80px;">操作</th>' +
                '</tr></thead>' +
                '<tbody id="nt_fields_tbody_' + tabId + '">' + rowsHtml + '</tbody>' +
            '</table>' +
        '</div>' +
    '</div>';
}

function _ntPreviewSQL(tabId) {
    _ntCollectFields(tabId);
    var sql = _ntGenerateSQL(tabId);
    if (!sql) { showErrorDialog('提示', '请先输入表名和至少一个字段'); return; }
    document.getElementById('modal_icon').innerHTML = '📄';
    document.getElementById('modal_title').textContent = 'CREATE TABLE 预览';
    document.getElementById('modal_title').style.color = '#4fc3f7';
    document.getElementById('modal_msg').innerHTML =
        '<textarea readonly style="width:100%;height:200px;background:#0d1117;border:1px solid #333;border-radius:6px;color:#e0e0e0;padding:8px;font-family:Consolas,monospace;font-size:11px;">' + escapeHtml(sql) + '</textarea>';
    document.getElementById('modal_btns').innerHTML =
        '<button class="btn btn-gray" onclick="hideModal()">关闭</button>' +
        '<button class="btn btn-blue" onclick="var ta=document.querySelector(\'#modal_msg textarea\');if(ta)copyToClipboard(ta.value);hideModal();showOkDialog(\'成功\',\'SQL 已复制到剪贴板\')">📋 复制SQL</button>';
    document.getElementById('modal_overlay').classList.add('show');
}

function showCreateTableDialog(cid, db, schema) {
    var sch = schema || '';
    var tabId = 'newtbl_' + Date.now().toString(36);
    // ★ 从连接信息中获取数据库类型
    var conn = (treeData && treeData.connections) ? treeData.connections[cid] : null;
    var dbType = (conn && conn.db_type) ? conn.db_type : 'mysql';
    var isMySQL = dbType === 'mysql' || dbType === 'ob-mysql';
    var isOracle = dbType === 'oracle';
    var isPG = dbType === 'postgresql';
    // 默认字段（根据数据库类型）
    var defaultFields;
    if (isOracle) {
        defaultFields = [
            {name:'id', data_type:'NUMBER', length:'11', nullable:false, primary_key:true,
                default_val:'', comment:'主键', auto_increment:true, auto_update:false},
            {name:'name', data_type:'VARCHAR2', length:'255', nullable:true, primary_key:false,
                default_val:'', comment:'', auto_increment:false, auto_update:false}
        ];
    } else if (isPG) {
        defaultFields = [
            {name:'id', data_type:'SERIAL', length:'', nullable:false, primary_key:true,
                default_val:'', comment:'主键', auto_increment:true, auto_update:false},
            {name:'name', data_type:'VARCHAR', length:'255', nullable:true, primary_key:false,
                default_val:'', comment:'', auto_increment:false, auto_update:false}
        ];
    } else {
        defaultFields = [
            {name:'id', data_type:'INT', length:'11', nullable:false, primary_key:true,
                default_val:'', comment:'主键', auto_increment:true, auto_update:false},
            {name:'name', data_type:'VARCHAR', length:'255', nullable:true, primary_key:false,
                default_val:'', comment:'', auto_increment:false, auto_update:false}
        ];
    }
    var st = {
        tabId: tabId, cid: cid, db: db, schema: sch,
        _dbType: dbType,
        tblName: 'new_table', tblComment: '',
        engine: isMySQL ? 'InnoDB' : '',
        charset: isMySQL ? 'utf8mb4' : '',
        fields: defaultFields
    };
    _newTableStore[tabId] = st;
    var html = _ntBuildFullUI(tabId);
    addOrUpdateTab(tabId, '📝 新建表', 'ddl', html, db, cid);
    setTimeout(function() {
        var nameEl = document.getElementById('nt_tbl_name_' + tabId);
        if (nameEl) nameEl.focus();
    }, 150);
}

// ==================== 表结构展开（字段/索引/外键） ====================
function _renderTableNode(n, itemPad, catIcon, db, sch, cid, qual) {
    var tsId = 'ts_' + safeBtoa(cid + '_' + db + '_' + (sch || '') + '_' + n);
    return '<div class="tree-node" data-tname="'+escapeAttr(n)+'" data-db="'+escapeAttr(db)+'" data-sch="'+escapeAttr(sch)+'" data-cid="'+cid+'">' +
        '<div draggable="true" class="my-conn-row drag-table-item tree-table-item" data-tname="'+escapeAttr(n)+'" data-db="'+escapeAttr(db)+'" data-sch="'+escapeAttr(sch)+'" data-cid="'+cid+'" style="padding-left:'+itemPad+'px;font-size:11px;line-height:22px;" ' +
        'ondblclick="addTableDataTab(\''+escapeAttr(n)+'\',\''+escapeAttr(qual)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')" ' +
        'oncontextmenu="tableCtx(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')" ' +
        'ondragstart="onTableDragStart(event,\''+escapeAttr(n)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\')" ' +
        'ondragend="onTableDragEnd(event)">' +
        '<span class="arrow tree-table-struct-arrow" id="arr_'+tsId+'">▸</span>' +
        '<span class="my-conn-icon">'+catIcon+'</span><span class="tree-table-name">'+escapeHtml(n)+'</span></div>' +
        '<div class="tree-children" id="'+tsId+'"></div></div>';
}

function toggleTableStruct(tn, db, schema, cid, pad) {
    var tsId = 'ts_' + safeBtoa(cid + '_' + db + '_' + (schema || '') + '_' + tn);
    var children = document.getElementById(tsId);
    var arrow = document.getElementById('arr_' + tsId);
    if (!children) return;
    if (children.classList.contains('open')) {
        children.classList.remove('open');
        if (arrow) arrow.textContent = '▸';
        return;
    }
    children.classList.add('open');
    if (arrow) arrow.textContent = '▾';
    if (children.innerHTML.trim()) return;
    var subPad = pad + 20;
    children.innerHTML = '<div style="padding-left:'+subPad+'px;color:#999;font-size:11px;">⏳ 加载表结构...</div>';
    var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
    if (!conn) { children.innerHTML = '<div style="padding-left:'+subPad+'px;color:#e74c3c;font-size:11px;">❌ 未找到连接</div>'; return; }
    eel.table_get_design_info(conn, db, tn, schema)(function(r) {
        if (!r || !r.ok) {
            children.innerHTML = '<div style="padding-left:'+subPad+'px;color:#e74c3c;font-size:11px;">❌ '+escapeHtml(r?r.msg:'加载失败')+'</div>';
            return;
        }
        var design = r.design || {};
        var cols = design.columns || [];
        var idxs = design.indexes || [];
        var fks = design.foreign_keys || [];
        _renderTableSubCats(children, tn, db, schema, cid, subPad, cols, idxs, fks);
    });
}

function _renderTableSubCats(container, tn, db, schema, cid, subPad, cols, idxs, fks) {
    var sch = schema || '';
    var bk = safeBtoa(cid+'_'+db+'_'+(sch || '')+'_'+tn);
    var colsId = 'cols_'+bk;
    var idxsId = 'idxs_'+bk;
    var fksId = 'fks_'+bk;
    var itemPad = subPad + 6;
    var cntPad = itemPad + 20;
    var html = '';
    // 字段文件夹
    html += '<div class="my-conn-row tree-subcat" style="padding-left:'+subPad+'px;font-size:11px;line-height:22px;" oncontextmenu="subcatCtx(event,\'columns\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\','+subPad+')">' +
        '<span class="arrow" id="arr_'+colsId+'" onclick="event.stopPropagation();toggleTableSubCat(\''+colsId+'\','+cntPad+',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'columns\')">▸</span>' +
        '🔹 字段 ('+cols.length+') ' +
        '<span class="cat-refresh" onclick="event.stopPropagation();refreshTableSubCat(\'columns\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\','+subPad+')" title="刷新字段">🔄</span>' +
        '</div><div class="tree-children" id="'+colsId+'"></div>';
    // 索引文件夹
    html += '<div class="my-conn-row tree-subcat" style="padding-left:'+subPad+'px;font-size:11px;line-height:22px;" oncontextmenu="subcatCtx(event,\'indexes\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\','+subPad+')">' +
        '<span class="arrow" id="arr_'+idxsId+'" onclick="event.stopPropagation();toggleTableSubCat(\''+idxsId+'\','+cntPad+',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'indexes\')">▸</span>' +
        '🔍 索引 ('+idxs.length+') ' +
        '<span class="cat-refresh" onclick="event.stopPropagation();refreshTableSubCat(\'indexes\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\','+subPad+')" title="刷新索引">🔄</span>' +
        '</div><div class="tree-children" id="'+idxsId+'"></div>';
    // 外键文件夹
    html += '<div class="my-conn-row tree-subcat" style="padding-left:'+subPad+'px;font-size:11px;line-height:22px;" oncontextmenu="subcatCtx(event,\'foreign_keys\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\','+subPad+')">' +
        '<span class="arrow" id="arr_'+fksId+'" onclick="event.stopPropagation();toggleTableSubCat(\''+fksId+'\','+cntPad+',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\',\'foreign_keys\')">▸</span>' +
        '🔗 外键 ('+fks.length+') ' +
        '<span class="cat-refresh" onclick="event.stopPropagation();refreshTableSubCat(\'foreign_keys\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+cid+'\','+subPad+')" title="刷新外键">🔄</span>' +
        '</div><div class="tree-children" id="'+fksId+'"></div>';
    // 存储已加载的数据以便展开子分类时直接使用
    container._tableInfo = {cols:cols, idxs:idxs, fks:fks, tn:tn, db:db, sch:sch, cid:cid, pad:subPad, cntPad:cntPad};
    container.innerHTML = html;
}

function toggleTableSubCat(catId, cntPad, tn, db, schema, cid, catType) {
    var children = document.getElementById(catId);
    var arrow = document.getElementById('arr_' + catId);
    if (!children) return;
    if (children.classList.contains('open')) {
        children.classList.remove('open');
        if (arrow) arrow.textContent = '▸';
        return;
    }
    children.classList.add('open');
    if (arrow) arrow.textContent = '▾';
    if (children.innerHTML.trim()) return;
    // 从上层容器获取缓存数据
    var tsId = 'ts_' + safeBtoa(cid + '_' + db + '_' + (schema || '') + '_' + tn);
    var tsContainer = document.getElementById(tsId);
    var info = tsContainer ? tsContainer._tableInfo : null;
    if (!info) { children.innerHTML = '<div style="padding-left:'+cntPad+'px;color:#e74c3c;font-size:11px;">❌ 数据丢失，请重新展开</div>'; return; }
    var items;
    var icon;
    if (catType === 'columns') { items = info.cols; icon = '🔹'; }
    else if (catType === 'indexes') { items = info.idxs; icon = '🔍'; }
    else if (catType === 'foreign_keys') { items = info.fks; icon = '🔗'; }
    else { children.innerHTML = '<div style="padding-left:'+cntPad+'px;color:#999;font-size:11px;">（无数据）</div>'; return; }
    if (!items || items.length === 0) {
        children.innerHTML = '<div style="padding-left:'+cntPad+'px;color:#999;font-size:11px;">（无数据）</div>';
        return;
    }
    var h = items.map(function(it, idx) {
        var label, fkType, ctxFn, ctxArgs, itemId;
        if (catType === 'columns') {
            label = it.name + ' <span style="color:#8ab4f8;">' + escapeHtml(it.col_type || it.data_type || '') + '</span>';
            if (it.comment) label += ' <span style="color:#666;">-- '+escapeHtml(it.comment)+'</span>';
            ctxFn = 'fieldCtx';
            ctxArgs = '\''+escapeAttr(it.name)+'\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(schema)+'\',\''+cid+'\'';
            itemId = 'fld_'+safeBtoa(cid+'_'+db+'_'+tn+'_'+it.name);
        } else if (catType === 'indexes') {
            var idxCols = (it.columns||[]).join(', ');
            label = it.name + ' <span style="color:#8ab4f8;">('+escapeHtml(idxCols)+')</span>';
            fkType = (it.type||'').toLowerCase() === 'unique' ? 'UNIQUE' : (it.type||'INDEX');
            label += ' <span style="color:#f0c040;font-size:10px;">'+fkType+'</span>';
            ctxFn = 'indexCtx';
            ctxArgs = '\''+escapeAttr(it.name)+'\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(schema)+'\',\''+cid+'\'';
            itemId = 'idx_'+safeBtoa(cid+'_'+db+'_'+tn+'_'+it.name);
        } else if (catType === 'foreign_keys') {
            label = it.name + ' <span style="color:#8ab4f8;">'+escapeHtml(it.column||'')+'</span> → <span style="color:#4fc3f7;">'+escapeHtml(it.ref_table||'')+'.'+escapeHtml(it.ref_column||'')+'</span>';
            ctxFn = 'fkCtx';
            ctxArgs = '\''+escapeAttr(it.name)+'\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(schema)+'\',\''+cid+'\'';
            itemId = 'fk_'+safeBtoa(cid+'_'+db+'_'+tn+'_'+it.name);
        }
        return '<div class="my-conn-row" style="padding-left:'+cntPad+'px;font-size:10px;line-height:20px;padding-top:4px;padding-bottom:4px;" ' +
            'oncontextmenu="'+ctxFn+'(event,'+ctxArgs+')" id="'+itemId+'">' +
            '<span class="my-conn-icon">'+icon+'</span>'+label+'</div>';
    }).join('');
    children.innerHTML = h;
}

function refreshTableSubCat(catType, tn, db, schema, cid, pad) {
    var bk = safeBtoa(cid+'_'+db+'_'+(schema || '')+'_'+tn);
    var catId = (catType==='columns'?'cols_':catType==='indexes'?'idxs_':'fks_')+bk;
    var children = document.getElementById(catId);
    if (!children) return;
    children.classList.add('open');
    var arrow = document.getElementById('arr_'+catId);
    if (arrow) arrow.textContent = '▾';
    var tsId = 'ts_' + safeBtoa(cid + '_' + db + '_' + (schema || '') + '_' + tn);
    var tsContainer = document.getElementById(tsId);
    var cntPad = tsContainer && tsContainer._tableInfo ? tsContainer._tableInfo.cntPad : pad + 26;
    children.innerHTML = '<div style="padding-left:'+cntPad+'px;color:#999;font-size:11px;">🔄 刷新中...</div>';
    var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
    if (!conn) return;
    eel.table_get_design_info(conn, db, tn, schema)(function(r) {
        if (!r || !r.ok) { children.innerHTML = '<div style="padding-left:'+cntPad+'px;color:#e74c3c;font-size:11px;">❌ 刷新失败</div>'; return; }
        var design = r.design || {};
        // 更新缓存
        if (tsContainer) {
            tsContainer._tableInfo = {cols:design.columns||[], idxs:design.indexes||[], fks:design.foreign_keys||[], tn:tn, db:db, sch:schema||'', cid:cid, pad:pad, cntPad:cntPad};
        }
        // 重新渲染子分类列表
        var subPad = pad;
        var items, icon;
        if (catType === 'columns') { items = design.columns || []; icon = '🔹'; }
        else if (catType === 'indexes') { items = design.indexes || []; icon = '🔍'; }
        else { items = design.foreign_keys || []; icon = '🔗'; }
        if (!items || items.length === 0) { children.innerHTML = '<div style="padding-left:'+cntPad+'px;color:#999;font-size:11px;">（无数据）</div>'; return; }
        var h = items.map(function(it) {
            var label, ctxFn, ctxArgs;
            if (catType === 'columns') {
                label = it.name + ' <span style="color:#8ab4f8;">' + escapeHtml(it.col_type||it.data_type||'') + '</span>';
                if (it.comment) label += ' <span style="color:#666;">-- '+escapeHtml(it.comment)+'</span>';
                ctxFn='fieldCtx'; ctxArgs='\''+escapeAttr(it.name)+'\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(schema)+'\',\''+cid+'\'';
            } else if (catType === 'indexes') {
                var idxCols = (it.columns||[]).join(', ');
                label = it.name + ' <span style="color:#8ab4f8;">('+escapeHtml(idxCols)+')</span>';
                var fkType = (it.type||'').toLowerCase()==='unique'?'UNIQUE':(it.type||'INDEX');
                label += ' <span style="color:#f0c040;font-size:10px;">'+fkType+'</span>';
                ctxFn='indexCtx'; ctxArgs='\''+escapeAttr(it.name)+'\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(schema)+'\',\''+cid+'\'';
            } else {
                label = it.name + ' <span style="color:#8ab4f8;">'+escapeHtml(it.column||'')+'</span> → <span style="color:#4fc3f7;">'+escapeHtml(it.ref_table||'')+'.'+escapeHtml(it.ref_column||'')+'</span>';
                ctxFn='fkCtx'; ctxArgs='\''+escapeAttr(it.name)+'\',\''+escapeAttr(tn)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(schema)+'\',\''+cid+'\'';
            }
            return '<div class="my-conn-row" style="padding-left:'+cntPad+'px;font-size:10px;line-height:20px;padding-top:4px;padding-bottom:4px;" oncontextmenu="'+ctxFn+'(event,'+ctxArgs+')"><span class="my-conn-icon">'+icon+'</span>'+label+'</div>';
        }).join('');
        children.innerHTML = h;
    });
}

// ==================== 子分类右键菜单（字段/索引/外键文件夹） ====================
function subcatCtx(e, catType, tn, db, schema, cid, pad) {
    e.preventDefault(); e.stopPropagation();
    var labels = {columns:'字段', indexes:'索引', foreign_keys:'外键'};
    showCtxMenu(e.clientX, e.clientY, [
        {label:'🔄 刷新'+labels[catType],action:function(){refreshTableSubCat(catType,tn,db,schema,cid,pad);}}
    ]);
}

// ==================== 字段/索引/外键右键删除 ====================
function fieldCtx(e, colName, tn, db, schema, cid) {
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, [
        {label:'❌ 删除字段 ['+colName+']',action:function(){
            showConfirmDialog('确认删除','确定删除字段 ['+colName+']？此操作不可恢复！',function(){
                var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
                eel.table_drop_column(conn,db,tn,colName,schema)(function(r){
                    if(r&&r.ok){showOkDialog('成功',r.msg);setTimeout(function(){refreshTableSubCat('columns',tn,db,schema,cid,0);refreshTableFolder(cid,db,schema);},500);}
                    else showErrorDialog('失败',r?r.msg:'');
                });
            });
        }}
    ]);
}

function indexCtx(e, idxName, tn, db, schema, cid) {
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, [
        {label:'❌ 删除索引 ['+idxName+']',action:function(){
            showConfirmDialog('确认删除','确定删除索引 ['+idxName+']？此操作不可恢复！',function(){
                var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
                eel.table_drop_index(conn,db,tn,idxName,schema)(function(r){
                    if(r&&r.ok){showOkDialog('成功',r.msg);setTimeout(function(){refreshTableSubCat('indexes',tn,db,schema,cid,0);},500);}
                    else showErrorDialog('失败',r?r.msg:'');
                });
            });
        }}
    ]);
}

function fkCtx(e, fkName, tn, db, schema, cid) {
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, [
        {label:'❌ 删除外键 ['+fkName+']',action:function(){
            showConfirmDialog('确认删除','确定删除外键 ['+fkName+']？此操作不可恢复！',function(){
                var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
                eel.table_drop_foreign_key(conn,db,tn,fkName,schema)(function(r){
                    if(r&&r.ok){showOkDialog('成功',r.msg);setTimeout(function(){refreshTableSubCat('foreign_keys',tn,db,schema,cid,0);},500);}
                    else showErrorDialog('失败',r?r.msg:'');
                });
            });
        }}
    ]);
}
