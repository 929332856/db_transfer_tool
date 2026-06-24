// ==================== 查询编辑器分割线拖动 ====================
// ★ 格式化服务器执行时间：毫秒→友好显示
function _fmtExecTime(ms) {
    if (ms < 1) return ms.toFixed(2) + 'ms';
    if (ms < 1000) return ms.toFixed(1) + 'ms';
    return (ms / 1000).toFixed(2) + 's';
}
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
    // ★ 同步验证 + 恢复连接数据（放在最前面，避免异步回调中状态丢失导致闪回）
    var curTabSync = objectTabs.find(function(t){return t.id==='query_'+qid;});
    if (curTabSync && curTabSync.cid && treeData && treeData.connections && treeData.connections[curTabSync.cid]) {
        activeConnId = curTabSync.cid;
        activeConnData = treeData.connections[curTabSync.cid];
    }
    // ★ 生成新的执行令牌，旧 chain 检测令牌不匹配即放弃
    _execToken[qid] = (_execToken[qid] || 0) + 1;
    var myToken = _execToken[qid];

    if (!activeConnData) {
        var resultsDivPreCheck = document.getElementById('qr_'+qid);
        if (resultsDivPreCheck) resultsDivPreCheck.innerHTML = '<div style="padding:20px;color:#e74c3c;">❌ 连接已断开，请先在左侧树中展开对应连接</div>';
        return;
    }

    // ★ 直接从 textarea 取 SQL（跳过 tree_get_query 后端调用，避免阻塞和延迟）
    var ta = document.getElementById('sq_'+qid);
    var resultsDiv = document.getElementById('qr_'+qid);
    var btnExe = document.getElementById('btn_exe_'+qid);

    if (!ta) {
        // textarea 不存在 → 可能是 tab 刚打开 DOM 还没渲染，走异步查询
        _resetExeBtnLate(qid, btnExe);
        eel.tree_get_query(qid)(function(q){
            if (_execToken[qid] !== myToken) return; // 令牌过期
            if(!q) {
                if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:20px;color:#e74c3c;">❌ 查询未找到（id='+escapeHtml(String(qid))+'），请重新打开</div>';
                return;
            }
            _execQueryWithSql(qid, q.sql || '', myToken, curTabSync, ta, resultsDiv, btnExe);
        });
        return;
    }

    var fullSql = ta.value;
    _execQueryWithSql(qid, fullSql, myToken, curTabSync, ta, resultsDiv, btnExe);
}

/** ★ 核心执行逻辑（textarea 存在时直接调用，免去 tree_get_query 的延迟） */
function _execQueryWithSql(qid, fullSql, myToken, curTabSync, ta, resultsDiv, btnExe) {
    // 检查选中文本
    var sel = '';
    if (ta) {
        var st2 = ta.selectionStart, en2 = ta.selectionEnd;
        if (st2 !== en2) sel = ta.value.substring(st2, en2).trim();
    }
    var sqlToExec = sel || fullSql;
    var stmts = sqlToExec.split(';').filter(function(s){return s.trim();});

    if (!stmts.length) { _resetExeBtnLate(qid, btnExe); return; }

    // ★ 取消/超时检测：如果上一次执行仍在进行
    if (_execRunning[qid]) {
        var elapsedSinceStart = Date.now() - (_execStartTime[qid] || 0);
        if (elapsedSinceStart > 120000) {
            console.warn('[execQueryTab] _execRunning 卡死 ' + Math.round(elapsedSinceStart/1000) + 's，强制清除');
            _execRunning[qid] = false;
            _execCancelFlags[qid] = false;
        } else {
            cancelExecQuery(qid);
            return;
        }
    }

    // ★ 再次确认 activeConnData 仍然有效
    if (!activeConnData) {
        if (curTabSync && curTabSync.cid && treeData && treeData.connections && treeData.connections[curTabSync.cid]) {
            activeConnId = curTabSync.cid;
            activeConnData = treeData.connections[curTabSync.cid];
        } else {
            if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:20px;color:#e74c3c;">❌ 连接已断开，请先在左侧树中展开对应连接</div>';
            return;
        }
    }

    _execCancelFlags[qid] = false;
    _execRunning[qid] = true;
    _execStartTime[qid] = Date.now();

    if (btnExe) { btnExe.textContent = '⏹ 取消'; btnExe.style.background = '#e74c3c'; }
    if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:10px;color:#999;display:flex;align-items:center;gap:10px;"><span>⏳ 执行中...</span><button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;padding:3px 10px;" onclick="cancelExecQuery(\''+qid+'\')">⏹ 取消</button></div>';
    var layout = resultsDiv ? resultsDiv.parentElement : null;
    if (layout) layout.classList.add('split');

    // ★ Redis 连接：逐行执行 Redis 命令
    if (activeConnData.db_type === 'redis') {
        execRedisQueryTab(qid, btnExe, resultsDiv, sqlToExec);
        return;
    }

    var allResults = [];
    var qDb = curTabSync ? curTabSync.db : '';
    var sqlDb = detectDbFromSql(fullSql);
    var isOra = (activeConnData.db_type || '') === 'oracle';
    var execDb = isOra ? (activeConnData.db || '') : (sqlDb || qDb || activeConnData.db || '');

    var execIdx = 0;
    var hasDDL = false;

    function execNext() {
        // ★ 令牌检测：新执行已启动，旧 chain 立即放弃
        if (_execToken[qid] !== myToken) return;

        if (_execCancelFlags[qid]) {
            _execCancelFlags[qid] = false;
            _execRunning[qid] = false;
            if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
            if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:10px;color:#f39c12;">⏸ 查询已取消</div>';
            return;
        }
        if (execIdx >= stmts.length) {
            _execRunning[qid] = false;
            _execCancelFlags[qid] = false;
            var elapsed = Date.now() - (_execStartTime[qid] || 0);
            var minDelay = Math.max(0, 300 - elapsed);
            setTimeout(function() {
                if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
                if (resultsDiv) renderQueryResults(resultsDiv, allResults, stmts.length, stmts);
                if (hasDDL) { autoRefreshTreeTables(activeConnId, activeConnData, execDb, qDb); }
            }, minDelay);
            return;
        }
        var i = execIdx;
        var clean = stmts[i].trim();
        if (!clean) {
            allResults[i] = null;
            execIdx++;
            execNext();
            return;
        }
        if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:10px;color:#999;display:flex;align-items:center;gap:10px;"><span>⏳ 执行中 ('+(i+1)+'/'+stmts.length+')...</span><button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;padding:3px 10px;" onclick="cancelExecQuery(\''+qid+'\')">⏹ 取消</button></div>';
        var data = {src_host:activeConnData.host, src_port:activeConnData.port, src_user:activeConnData.user, src_pwd:activeConnData.pwd, src_db:execDb, db_type:activeConnData.db_type||'mysql', ora_mode:activeConnData.ora_mode||'service_name'};
        eel.execute_sql_query(clean, data)(function(result){
            // ★ 令牌检测：异步回调返回时，确认仍是当前执行
            if (_execToken[qid] !== myToken) return;
            allResults[i] = result;
            if (result && result.ok && !result.cancelled && (!result.columns || !result.columns.length) && result.total === undefined) {
                hasDDL = true;
            }
            execIdx++;
            execNext();
        });
    }
    execNext();
}

/** 延迟复位按钮（用于执行取消/错误时的统一入口） */
function _resetExeBtnLate(qid, btnExe) {
    if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
}

function cancelExecQuery(qid) {
    _execCancelFlags[qid] = true;
    _execRunning[qid] = false; // ★ 已取消，不再运行
    eel.cancel_query()();
    var btnExe = document.getElementById('btn_exe_'+qid);
    if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
    var resultsDiv = document.getElementById('qr_'+qid);
    if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:10px;color:#f39c12;">⏸ 查询已取消</div>';
}

/** 关闭查询结果区域（收起分栏、清空结果、重置编辑状态） */
function closeQueryResults(qid) {
    var layout = document.getElementById('ql_' + qid);
    if (layout) {
        layout.classList.remove('split');
    }
    var resultsDiv = document.getElementById('qr_' + qid);
    if (resultsDiv) {
        resultsDiv.innerHTML = '';
    }
    // 重置编辑状态
    var es = _qState(qid);
    es.columns = [];
    es.rows = [];
    es.changedCells = {};
    es.selectedRows = {};
    es._lastClickedIdx = -1;
    es.editing = false;
    es._multiCols = [];
    es._multiRows = [];
    es._multiChanged = [];
    es._multiSelected = [];
    es._multiStmts = [];
}

// 查询结果编辑状态（按 qid）
var _queryEditStates = {};

/** 获取查询结果编辑状态 */
function _qState(qid) {
    if (!_queryEditStates[qid]) {
        _queryEditStates[qid] = { columns: [], rows: [], changedCells: {}, selectedRows: {}, editing: false, connData: null, execDb: '', _colComments: {}, _colTypes: {}, _lastClickedIdx: -1, server_ms: undefined };
    }
    return _queryEditStates[qid];
}

/** 同步查询 tab 内容到 objectTabs（解决切换 tab 数据丢失问题） */
function _syncQueryContent(qid) {
    var layout = document.getElementById('ql_' + qid);
    if (!layout) return;
    var tab = objectTabs.find(function(t){ return t.id === 'query_' + qid; });
    if (!tab) return;
    // 获取 layout 的完整 HTML，同时把 textarea 的 value 写入（innerHTML 不反映 textarea 实时值）
    var html = layout.outerHTML;
    var ta = document.getElementById('sq_' + qid);
    // ★ 额外缓存 textarea value 和结果区域到 _queryEditStates（双重保险，防止 HTML 反转义问题）
    var es = _qState(qid);
    if (ta) {
        es._cachedSql = ta.value;
        tab._cachedSql = ta.value;
        var escapedQid = qid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var taRe = new RegExp('(<textarea[^>]*id="sq_' + escapedQid + '"[^>]*>)([\\s\\S]*?)(</textarea>)', 'i');
        html = html.replace(taRe, '$1' + escapeHtml(ta.value) + '$3');
    }
    // ★ 额外缓存结果区域 HTML（以防 _qRenderTable 的动态内容未被 innerHTML 捕获）
    var resultsDiv = document.getElementById('qr_' + qid);
    if (resultsDiv) {
        es._cachedHtml = resultsDiv.innerHTML;
    }
    tab.content = html;
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

/** 行选择格点击（查询窗口）：普通点击单选+清空其他，Shift范围选择，Ctrl多选切换 */
function _qGripClick(qid, gripEl, rowIdx) {
    var es = _qState(qid);
    var evt = window.event;
    var isShift = evt && evt.shiftKey;
    var isCtrl = evt && (evt.ctrlKey || evt.metaKey);

    if (isShift && es._lastClickedIdx >= 0) {
        // Shift+点击：范围选择（从上次点击位置到当前位置）
        var from = Math.min(es._lastClickedIdx, rowIdx);
        var to = Math.max(es._lastClickedIdx, rowIdx);
        es.selectedRows = {};
        for (var i = from; i <= to; i++) {
            es.selectedRows[i] = true;
        }
    } else if (isCtrl) {
        // Ctrl+点击：切换单行（不影响其他行）
        if (es.selectedRows[rowIdx]) {
            delete es.selectedRows[rowIdx];
        } else {
            es.selectedRows[rowIdx] = true;
        }
        es._lastClickedIdx = rowIdx;
    } else if (es.selectedRows[rowIdx] && Object.keys(es.selectedRows).length === 1) {
        // ▲ 普通点击已唯一选中的行 → 取消全部选中
        es.selectedRows = {};
        es._lastClickedIdx = -1;
    } else {
        // 普通点击：只选中当前行，取消其他所有行
        es.selectedRows = {};
        es.selectedRows[rowIdx] = true;
        es._lastClickedIdx = rowIdx;
    }

    // 刷新当前页所有行的高亮状态
    var wrap = document.getElementById('qr_' + qid);
    if (wrap) {
        wrap.querySelectorAll('.row-sel-grip').forEach(function(grip){
            var ri = parseInt(grip.getAttribute('data-ri'));
            var sel = !!es.selectedRows[ri];
            if (sel) grip.classList.add('selected'); else grip.classList.remove('selected');
            var tr2 = grip.parentNode;
            if (tr2) { if (sel) tr2.classList.add('row-selected'); else tr2.classList.remove('row-selected'); }
        });
    }
    _qUpdateBtns(qid);
}

/** 全选/取消全选（查询窗口） */
function _qToggleSelAll(qid) {
    var es = _qState(qid);
    var allSel = es.rows.length > 0 && Object.keys(es.selectedRows).length >= es.rows.length;
    if (allSel) {
        es.selectedRows = {};
    } else {
        for (var i = 0; i < es.rows.length; i++) {
            es.selectedRows[i] = true;
        }
    }
    _qUpdateBtns(qid);
    // 更新视觉
    var wrap = document.getElementById('qr_' + qid);
    if (wrap) {
        var hdr = document.getElementById(qid + '_qsel_all');
        if (hdr) {
            if (!allSel && es.rows.length > 0) hdr.classList.add('all-selected');
            else hdr.classList.remove('all-selected');
        }
        wrap.querySelectorAll('.row-sel-grip').forEach(function(grip){
            var ri = parseInt(grip.getAttribute('data-ri'));
            var sel = !!es.selectedRows[ri];
            if (sel) grip.classList.add('selected'); else grip.classList.remove('selected');
            var tr2 = grip.parentNode;
            if (tr2) { if (sel) tr2.classList.add('row-selected'); else tr2.classList.remove('row-selected'); }
        });
    }
}

/** 查询结果行右键菜单 */
function _qRowCtx(qid, e, rowIdx) {
    e.preventDefault(); e.stopPropagation();
    var es = _qState(qid);
    var row = es.rows[rowIdx];
    if (!row) return;
    var displayName = es._tableName || 'table_name';
    // 生成 INSERT SQL
    var fnSafe = function(n){ return '`'+String(n).replace(/`/g,'``')+'`'; };
    var fnVal = function(v){
        if (v===null||v===undefined) return 'NULL';
        var s=String(v); if(s==='') return "''";
        if(/^-?\d+(\.\d+)?$/.test(s.trim())) return s.trim();
        return "'"+s.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'";
    };
    var colNames = es.columns.map(function(c){ return fnSafe(c); }).join(', ');
    var values = row.map(function(v){ return fnVal(v); }).join(', ');
    var sql = 'INSERT INTO '+fnSafe(displayName)+' ('+colNames+') VALUES ('+values+');';
    var rowText = row.map(function(v){ return v===null?'NULL':String(v); }).join('\t');
    showCtxMenu(e.clientX, e.clientY, [
        {label:'📋 复制', action:function(){ copyToClipboard(rowText); }},
        {label:'📋 复制为 INSERT 语句', action:function(){ copyToClipboard(sql); }}
    ]);
}

// ==================== 查询结果导出（向导模式：格式→路径→执行） ====================
/** 统一导出入口（支持单结果和多结果 Tab） */
function _qExportResult(qid, tabIdx) {
    var es = _qState(qid);
    var cols, rows, tableName;
    if (tabIdx !== undefined && tabIdx !== null) {
        // 多结果 Tab
        cols = (es._multiCols || [])[tabIdx] || [];
        rows = (es._multiRows || [])[tabIdx] || [];
        tableName = (es._multiTableNames || [])[tabIdx] || 'exported_table';
    } else {
        // 单结果
        cols = es.columns || [];
        rows = es.rows || [];
        tableName = es._tableName || 'exported_table';
    }
    if (!cols.length) { showWarnDialog('提示', '没有可导出的结果'); return; }

    // ★ 借用 main.js 的导出向导状态
    if (typeof _qsExportState === 'undefined') {
        showWarnDialog('提示', '导出向导未就绪，请刷新页面'); return;
    }
    _qsExportState = {
        step: 1, fmt: 'csv', tableName: tableName, path: '',
        rowCount: rows.length, totalBytes: 0,
        results: { columns: cols, rows: rows },
        written: 0, pct: 0, done: false, error: null, resultInfo: null
    };
    if (typeof _qsExportLogs !== 'undefined') _qsExportLogs = [];
    if (typeof _showExportStep1 === 'function') _showExportStep1();
    else showWarnDialog('提示', '导出向导函数未就绪，请刷新页面');
}

/** 导出单结果 CSV */
function _qExportCSV(qid) {
    var es = _qState(qid);
    if (!es.columns || !es.columns.length) { showWarnDialog('提示', '没有可导出的结果'); return; }
    var csv = '\uFEFF';
    csv += es.columns.map(function(c) { return _csvEscape(String(c)); }).join(',') + '\r\n';
    for (var i = 0; i < es.rows.length; i++) {
        csv += es.rows[i].map(function(v) { return _csvEscape(v); }).join(',') + '\r\n';
    }
    _qsExportToFile(csv, 'csv');
}

/** 导出单结果 SQL INSERT */
function _qExportSQL(qid) {
    var es = _qState(qid);
    if (!es.columns || !es.columns.length) { showWarnDialog('提示', '没有可导出的结果'); return; }
    var tableName = prompt('请输入导出目标表名:', es._tableName || 'exported_table');
    if (!tableName || !tableName.trim()) return;
    tableName = tableName.trim();
    var colList = '`' + es.columns.join('`, `') + '`';
    var sql = '-- 导出时间: ' + new Date().toISOString() + '\n';
    sql += '-- 目标表:   `' + tableName + '`\n';
    sql += '-- 行数:     ' + es.rows.length + '\n\n';
    for (var i = 0; i < es.rows.length; i++) {
        var vals = es.rows[i].map(function(v) {
            if (v === null || v === undefined) return 'NULL';
            var s = String(v);
            return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
        }).join(', ');
        sql += 'INSERT INTO `' + tableName + '` (' + colList + ') VALUES (' + vals + ');\n';
    }
    _qsExportToFile(sql, 'sql');
}

/** 导出多结果 CSV */
function _qExportCSVMulti(qid, tabIdx) {
    var es = _qState(qid);
    var cols = (es._multiCols || [])[tabIdx] || [];
    var rows = (es._multiRows || [])[tabIdx] || [];
    if (!cols.length) { showWarnDialog('提示', '没有可导出的结果'); return; }
    var csv = '\uFEFF';
    csv += cols.map(function(c) { return _csvEscape(String(c)); }).join(',') + '\r\n';
    for (var i = 0; i < rows.length; i++) {
        csv += rows[i].map(function(v) { return _csvEscape(v); }).join(',') + '\r\n';
    }
    _qsExportToFile(csv, 'csv');
}

/** 导出多结果 SQL INSERT */
function _qExportSQLMulti(qid, tabIdx) {
    var es = _qState(qid);
    var cols = (es._multiCols || [])[tabIdx] || [];
    var rows = (es._multiRows || [])[tabIdx] || [];
    if (!cols.length) { showWarnDialog('提示', '没有可导出的结果'); return; }
    var tname = (es._multiTableNames || [])[tabIdx] || 'exported_table';
    var tableName = prompt('请输入导出目标表名:', tname);
    if (!tableName || !tableName.trim()) return;
    tableName = tableName.trim();
    var colList = '`' + cols.join('`, `') + '`';
    var sql = '-- 导出时间: ' + new Date().toISOString() + '\n';
    sql += '-- 目标表:   `' + tableName + '`\n';
    sql += '-- 行数:     ' + rows.length + '\n\n';
    for (var i = 0; i < rows.length; i++) {
        var vals = rows[i].map(function(v) {
            if (v === null || v === undefined) return 'NULL';
            var s = String(v);
            return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
        }).join(', ');
        sql += 'INSERT INTO `' + tableName + '` (' + colList + ') VALUES (' + vals + ');\n';
    }
    _qsExportToFile(sql, 'sql');
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
    // 更新全选头样式
    var hdr = document.getElementById(qid + '_qsel_all');
    if (hdr) {
        if (selCnt > 0 && selCnt >= es.rows.length) hdr.classList.add('all-selected');
        else hdr.classList.remove('all-selected');
    }
}

/** 保存修改 */
function _qDoSave(qid) {
    var es = _qState(qid);
    // ★ 拦截：查询未包含表的所有字段时，不允许修改数据
    if (es._allColumnsPresent === false) {
        showWarnDialog('修改被拦截', '当前查询未包含表的所有字段，不允许修改数据。\n\n修改操作需要所有字段值来构建精确的 WHERE 条件\n以确保只更新目标行。\n\n请使用 SELECT * 或包含所有字段的查询后重试。');
        return;
    }
    var changes = [];
    for (var key in es.changedCells) {
        var ch = es.changedCells[key];
        changes.push({
            col: ch.colName,
            newVal: String(ch.newVal),
            origRow: (ch.origRow || []).map(function(v){ return v===null?'NULL':String(v); }),
            columns: ch.columns || es.columns
        });
    }
    if (!changes.length) return;
    if (!es.connData) { showWarnDialog('提示', '连接信息丢失，请重新执行查询'); return; }

    var btn = document.getElementById(qid + '_qsave_btn');
    if (btn) { btn.textContent = '⏳ 生成SQL...'; btn.disabled = true; }

    // 第一步：生成 SQL 预览
    eel.table_save_changes(es.connData, es.execDb, es._tableName || '', '', changes)(function(r){
        if (!r || !r.ok) {
            showWarnDialog('保存失败', r ? r.msg : '无响应');
            if (btn) { btn.textContent = '💾 保存'; btn.disabled = false; }
            return;
        }
        var sql = r.sql || '';
        // 第二步：弹窗确认 SQL 后再执行
        showConfirmDialog('确认执行修改',
            '<div style="max-height:300px;overflow:auto;background:#0d1117;padding:8px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;">' + escapeHtml(sql) + '</div>' +
            '<div style="margin-top:6px;color:#f39c12;font-size:11px;">共 ' + r.count + ' 处修改</div>',
            function() {
                if (btn) { btn.textContent = '⏳ 执行中...'; btn.disabled = true; }
                // 第三步：确认后执行
                eel.table_exec_save(es.connData, es.execDb, es._tableName || '', '', changes)(function(r2){
                    if (!r2 || !r2.ok) {
                        showWarnDialog('保存失败', r2 ? r2.msg : '无响应');
                        if (btn) { btn.textContent = '💾 保存'; btn.disabled = false; }
                        return;
                    }
                    showOkDialog('保存成功', r2.msg);
                    es.changedCells = {};
                    es.editing = false;
                    _qUpdateBtns(qid);
                    // 刷新数据（重新执行当前查询）
                    _qRefreshData(qid);
                });
            },
            function() {
                // 取消：恢复按钮状态
                if (btn) { btn.textContent = '💾 保存'; btn.disabled = false; }
            });
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
    // ★ 拦截：查询未包含表的所有字段时，不允许删除数据
    if (es._allColumnsPresent === false) {
        showWarnDialog('删除被拦截', '当前查询未包含表的所有字段，不允许删除数据。\n\n删除操作需要所有字段值来构建精确的 WHERE 条件\n以确保只删除目标行。\n\n请使用 SELECT * 或包含所有字段的查询后重试。');
        return;
    }
    var selIndices = Object.keys(es.selectedRows).map(Number).sort(function(a,b){return a-b;});
    if (!selIndices.length) return;
    if (!es.connData) { showWarnDialog('提示', '连接信息丢失'); return; }

    var rowsData = [];
    selIndices.forEach(function(oi) {
        var origRow = es.rows[oi];
        if (!origRow) return;
        rowsData.push({ origRow: origRow.map(function(v){ return v===null?'NULL':String(v); }), columns: es.columns });
    });

    eel.table_delete_rows(es.connData, es.execDb, es._tableName || '', '', rowsData)(function(r){
        if (!r || !r.ok) { showWarnDialog('删除失败', r?r.msg:'无响应'); return; }
        showConfirmDialog('确认删除',
            '<div style="max-height:300px;overflow:auto;background:#0d1117;padding:8px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;">' + escapeHtml(r.sql||'') + '</div>' +
            '<div style="margin-top:6px;color:#e74c3c;font-size:11px;">⚠ 将删除 ' + r.count + ' 行数据</div>',
            function(){
                eel.table_exec_delete(es.connData, es.execDb, es._tableName || '', '', rowsData)(function(r2){
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

/** 刷新数据：重新执行查询（★ tabIdx 可指定只刷新某个多语句结果的 tab，避免全部重跑） */
function _qRefreshData(qid, tabIdx) {
    var es = _qState(qid);
    var resultsDiv = document.getElementById('qr_'+qid);
    if (!resultsDiv) return;

    // ★ 多语句结果：只刷新指定 tab 的那条 SQL
    if (tabIdx !== undefined && tabIdx !== null && es._multiStmts && es._multiStmts.length) {
        var stmt = (es._multiStmts[tabIdx] || '').trim();
        if (!stmt) return;
        // 显示局部刷新标识（在对应 tab 上）
        var pane = resultsDiv.querySelector('.result-tab-pane[data-ri="'+tabIdx+'"]');
        if (pane) pane.innerHTML = '<div style="padding:10px;color:#999;">🔄 正在刷新...</div>';
        var data = {src_host:es.connData.host, src_port:es.connData.port, src_user:es.connData.user,
            src_pwd:es.connData.pwd, src_db:es.execDb, db_type:es.connData.db_type||'mysql', ora_mode:es.connData.ora_mode||'service_name'};
        eel.execute_sql_query(stmt, data)(function(result){
            // 重建该 tab 的结果，保持其他 tab 不变
            if (!result || !result.ok) {
                if (pane) pane.innerHTML = '<div style="padding:10px;color:#e74c3c;">❌ '+(result?result.msg:'无响应')+'</div>';
                return;
            }
            es._multiCols[tabIdx] = result.columns || [];
            es._multiRows[tabIdx] = result.rows || [];
            _qRebuildSingleTab(qid, tabIdx);
        });
        return;
    }

    // 单语句结果或无 tabIdx：全量刷新
    var sqlEl = document.getElementById('sq_'+qid);
    if (!sqlEl) return;
    var fullSql = sqlEl.value;
    var sel = '';
    if (sqlEl) {
        var st = sqlEl.selectionStart, en = sqlEl.selectionEnd;
        if (st !== en) sel = sqlEl.value.substring(st, en).trim();
    }
    var sqlToExec = sel || fullSql;
    var stmts = sqlToExec.split(';').filter(function(s){return s.trim();});

    if (!stmts.length) return;
    resultsDiv.innerHTML = '<div style="padding:10px;color:#999;">🔄 正在刷新...</div>';
    var allResults = [];
    var refIdx = 0;
    function execNextRefresh() {
        if (refIdx >= stmts.length) {
            renderQueryResults(resultsDiv, allResults, stmts.length, stmts);
            return;
        }
        var i = refIdx;
        var clean = stmts[i].trim();
        if (!clean) { allResults[i] = null; refIdx++; execNextRefresh(); return; }
        resultsDiv.innerHTML = '<div style="padding:10px;color:#999;">🔄 正在刷新 ('+(i+1)+'/'+stmts.length+')...</div>';
        var data = {src_host:es.connData.host, src_port:es.connData.port, src_user:es.connData.user,
            src_pwd:es.connData.pwd, src_db:es.execDb, db_type:es.connData.db_type||'mysql', ora_mode:es.connData.ora_mode||'service_name'};
        eel.execute_sql_query(clean, data)(function(result){
            allResults[i] = result;
            refIdx++;
            execNextRefresh();
        });
    }
    execNextRefresh();
}

/** ★ 仅重建多结果中单个 tab 的 DOM（不重跑 SQL，SQL 已由 _qRefreshData 重新执行） */
function _qRebuildSingleTab(qid, tabIdx) {
    var es = _qState(qid);
    var cols = es._multiCols[tabIdx] || [];
    var rows = es._multiRows[tabIdx] || [];
    var pane = document.getElementById('qr_'+qid);
    if (!pane) return;
    pane = pane.querySelector('.result-tab-pane[data-ri="'+tabIdx+'"]');
    if (!pane) return;

    var tabBody = '';
    if (cols.length > 0) {
        tabBody += '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:#111;border-bottom:1px solid #333;flex-wrap:wrap;">' +
            '<button class="btn btn-sm" id="'+qid+'_mqsave_'+tabIdx+'" onclick="_qDoSaveMulti(\''+qid+'\','+tabIdx+')" disabled style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存 (0)</button>' +
            '<button class="btn btn-sm" id="'+qid+'_mqcancel_'+tabIdx+'" onclick="_qCancelEditMulti(\''+qid+'\','+tabIdx+')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">↩ 取消修改</button>' +
            '<span style="flex:1;"></span>' +
            '<button class="btn btn-sm" id="'+qid+'_mqdel_'+tabIdx+'" onclick="_qDoDeleteMulti(\''+qid+'\','+tabIdx+')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">🗑 删除 (0)</button>' +
            '<button class="btn btn-sm" onclick="_qExportResult(\''+qid+'\','+tabIdx+')" style="background:#27ae60;color:#fff;font-size:10px;">📥 导出</button>' +
            '<span style="font-size:10px;color:#666;">双击单元格编辑 | 选中行可删除</span></div>';
        tabBody += '<div style="padding:6px 12px;font-size:11px;color:#888;border-bottom:1px solid #333;">📊 查询结果 — '+rows.length+' 行'+(es._multiServerMs[tabIdx]!==undefined?' <span style="color:#5dade2;">⏱ '+_fmtExecTime(es._multiServerMs[tabIdx])+'</span>':'')+'</div>';
        tabBody += '<div style="overflow:auto;"><table class="exp-table"><thead><tr>';
        tabBody += '<th class="row-sel-header" id="'+qid+'_mqsel_all_'+tabIdx+'" onclick="_qToggleSelAllMulti(\''+qid+'\','+tabIdx+')" title="全选/取消全选">#</th>';
        cols.forEach(function(c){ tabBody += '<th>'+escapeHtml(c)+'</th>'; });
        tabBody += '</tr></thead><tbody>';
        var mMax = Math.min(rows.length, 200);
        for (var mi = 0; mi < mMax; mi++) {
            var mr = rows[mi];
            var isSel = !!es._multiSelected[tabIdx][mi];
            var gripCls = isSel ? 'row-sel-grip selected' : 'row-sel-grip';
            var rowCls = isSel ? ' class="row-selected"' : '';
            tabBody += '<tr data-row-idx="'+mi+'"'+rowCls+'>';
            tabBody += '<td class="'+gripCls+'" data-ri="'+mi+'" ' +
                'onclick="_qGripClickMulti(\''+qid+'\','+tabIdx+',this,'+mi+')" ' +
                'oncontextmenu="_qMultiRowCtx(\''+qid+'\','+tabIdx+',event,'+mi+')" ' +
                'title="左键选择行 | Shift多选 | 右键菜单">'+(mi+1)+'</td>';
            mr.forEach(function(mv,mci){
                var mval = mv===null?'NULL':String(mv);
                tabBody += '<td><input class="editable-cell" data-ri="'+mi+'" data-ci="'+mci+'" data-col="'+escapeAttr(cols[mci])+'" value="'+escapeAttr(mval)+'" onfocus="this._oldVal=this.value" onblur="_qCellBlurMulti(\''+qid+'\','+tabIdx+','+mi+','+mci+',this)" spellcheck="false" autocomplete="off" style="min-width:60px;"></td>';
            });
            tabBody += '</tr>';
        }
        tabBody += '</tbody></table></div>';
        if (rows.length > mMax) tabBody += '<div style="padding:5px;color:#777;font-size:10px;">... 共 '+rows.length+' 行，显示前 '+mMax+' 行</div>';
    } else {
        tabBody = '<div style="padding:12px;color:#888;">查询成功，无结果集</div>';
    }
    pane.innerHTML = tabBody;
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
        '<button class="btn btn-sm" onclick="_qExportResult(\''+qid+'\')" style="background:#27ae60;color:#fff;font-size:10px;">📥 导出</button>' +
        '<span style="font-size:10px;color:#666;">双击单元格编辑 | 选中行可删除</span></div>';
    html += '<div style="padding:6px 12px;font-size:11px;color:#888;border-bottom:1px solid #333;">📊 查询结果 — ' + rc + ' 行'+(es.server_ms!==undefined?' <span style="color:#5dade2;">⏱ '+_fmtExecTime(es.server_ms)+'</span>':'')+'</div>';

    html += '<div style="overflow:auto;"><table class="exp-table"><thead><tr>';
    html += '<th class="row-sel-header" id="'+qid+'_qsel_all" onclick="_qToggleSelAll(\x27'+qid+'\x27)" title="全选/取消全选">#</th>';
    es.columns.forEach(function(c){
        var cType = (es._colTypes && es._colTypes[c]) ? es._colTypes[c] : '';
        var cCmt = (es._colComments && es._colComments[c]) ? es._colComments[c] : '';
        var cmtTitle = cCmt ? ' title="'+escapeAttr(cCmt)+'"' : '';
        var cmtData = cCmt ? ' data-cmt="'+escapeAttr(cCmt)+'"' : '';
        var ctypeData = cType ? ' data-ctype="'+escapeAttr(cType)+'"' : '';
        html += '<th'+cmtTitle+cmtData+ctypeData+'><div class="col-name"'+cmtTitle+'>'+escapeHtml(c)+'</div>';
        if (cType) html += '<div class="col-type">'+escapeHtml(cType)+'</div>';
        html += '</th>';
    });
    html += '</tr></thead><tbody>';

    var maxShow = Math.min(es.rows.length, 200);
    for (var i = 0; i < maxShow; i++) {
        var row = es.rows[i];
        var isSel = !!es.selectedRows[i];
        var gripCls = isSel ? 'row-sel-grip selected' : 'row-sel-grip';
        var rowCls = isSel ? ' class="row-selected"' : '';
        html += '<tr data-row-idx="'+i+'"'+rowCls+'>';
        html += '<td class="'+gripCls+'" data-ri="'+i+'" ' +
            'onclick="_qGripClick(\''+qid+'\',this,'+i+')" ' +
            'oncontextmenu="_qRowCtx(\''+qid+'\',event,'+i+')" ' +
            'title="左键选择行 | Shift多选 | 右键菜单">'+(i+1)+'</td>';
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
    var isOraRefresh = (es.connData && es.connData.db_type === 'oracle');
    es.execDb = isOraRefresh ? (es.connData.db || '') : (detectDb || qdb || (activeConnData ? activeConnData.db : '') || '');
    es._tableName = detectTableFromSql(sqlText);

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
            es._colTypes = r0.col_types || {};
            es._colComments = r0.comments || {};
            es.server_ms = r0.server_ms;
            var rc = r0.total || 0;
            var hc = es.columns.length > 0;
            // 重置编辑状态
            es.changedCells = {};
            es.selectedRows = {};
            es._lastClickedIdx = -1;
            es.editing = false;

            if (hc) {
                // 尝试加载列类型和注释
                if (es._tableName && es.connData) {
                    eel.table_get_col_types(es.connData, es.execDb, es._tableName, '')(function(r){
                        if (r && r.ok) {
                            es._colTypes = Object.assign({}, es._colTypes || {}, r.col_types || {});
                            es._colComments = Object.assign({}, es._colComments || {}, r.comments || {});
                            // ★ 检查是否查询了表的所有列（用于拦截不完整列时的修改/删除操作）
                            var tableCols = Object.keys(r.col_types || {});
                            var queryCols = es.columns || [];
                            es._allColumnsPresent = tableCols.length === 0 || tableCols.every(function(tc) { return queryCols.indexOf(tc) !== -1; });
                        } else {
                            es._allColumnsPresent = false;
                        }
                        // 渲染表格
                        if (es.columns.length > 0) _qRenderTable(qid);
                    });
                } else if (!es._tableName) {
                    es._allColumnsPresent = false;
                }
                html += '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:#111;border-bottom:1px solid #333;flex-wrap:wrap;">' +
                    '<button class="btn btn-sm" id="'+qid+'_qsave_btn" onclick="_qDoSave(\''+qid+'\')" disabled style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存 (0)</button>' +
                    '<button class="btn btn-sm" id="'+qid+'_qcancel_btn" onclick="_qCancelEdit(\''+qid+'\')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">↩ 取消修改</button>' +
                    '<span style="flex:1;"></span>' +
                    '<button class="btn btn-sm" id="'+qid+'_qdel_btn" onclick="_qDoDelete(\''+qid+'\')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">🗑 删除 (0)</button>' +
                    '<button class="btn btn-sm" onclick="_qExportResult(\''+qid+'\')" style="background:#27ae60;color:#fff;font-size:10px;">📥 导出</button>' +
                    '<span style="font-size:10px;color:#666;">双击单元格编辑 | 选中行可删除</span></div>';
                html += '<div style="padding:6px 12px;font-size:11px;color:#888;border-bottom:1px solid #333;">📊 查询结果 — '+rc+' 行'+(r0.server_ms!==undefined?' <span style="color:#5dade2;">⏱ '+_fmtExecTime(r0.server_ms)+'</span>':'')+'</div>';
                html += '<div style="overflow:auto;"><table class="exp-table"><thead><tr>';
                html += '<th class="row-sel-header" id="'+qid+'_qsel_all" onclick="_qToggleSelAll(\x27'+qid+'\x27)" title="全选/取消全选">#</th>';
                es.columns.forEach(function(c){
                    var cType = (es._colTypes && es._colTypes[c]) ? es._colTypes[c] : '';
                    var cCmt = (es._colComments && es._colComments[c]) ? es._colComments[c] : '';
                    var cmtTitle = cCmt ? ' title="'+escapeAttr(cCmt)+'"' : '';
                    // ★ 添加 data-cmt 属性，供自定义 field-comment-tooltip 使用（鼠标悬停展示字段注释）
                    var cmtData = cCmt ? ' data-cmt="'+escapeAttr(cCmt)+'"' : '';
                    var ctypeData = cType ? ' data-ctype="'+escapeAttr(cType)+'"' : '';
                    html += '<th'+cmtTitle+cmtData+ctypeData+'><div class="col-name"'+cmtTitle+'>'+escapeHtml(c)+'</div>';
                    if (cType) html += '<div class="col-type">'+escapeHtml(cType)+'</div>';
                    html += '</th>';
                });
                html += '</tr></thead><tbody>';

                var maxShow = Math.min(es.rows.length, 200);
                for (var i = 0; i < maxShow; i++) {
                    var row = es.rows[i];
                    var isSel = !!es.selectedRows[i];
                    var gripCls = isSel ? 'row-sel-grip selected' : 'row-sel-grip';
                    var rowCls = isSel ? ' class="row-selected"' : '';
                    html += '<tr data-row-idx="'+i+'"'+rowCls+'>';
                    html += '<td class="'+gripCls+'" data-ri="'+i+'" ' +
                        'onclick="_qGripClick(\''+qid+'\',this,'+i+')" ' +
                        'oncontextmenu="_qRowCtx(\''+qid+'\',event,'+i+')" ' +
                        'title="左键选择行 | Shift多选 | 右键菜单">'+(i+1)+'</td>';
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
                // ★ INSERT/UPDATE/DELETE 等无结果集操作：显示影响行数
                var affRows = rc || 0;
                if (affRows > 0) {
                    var opType = '操作';
                    var sqlLower = (stmtsArr && stmtsArr[0]) ? stmtsArr[0].trim().toUpperCase() : '';
                    if (sqlLower.indexOf('INSERT') === 0) opType = '插入';
                    else if (sqlLower.indexOf('UPDATE') === 0) opType = '更新';
                    else if (sqlLower.indexOf('DELETE') === 0) opType = '删除';
                    else if (sqlLower.indexOf('REPLACE') === 0) opType = '替换';
                    else if (sqlLower.indexOf('TRUNCATE') === 0) opType = '截断';
                    html += '<div style="padding:12px;color:#2ecc71;font-size:12px;">✅ '+opType+'成功，影响 <b>'+affRows+'</b> 行'+(r0.server_ms!==undefined?' <span style="color:#5dade2;">⏱ '+_fmtExecTime(r0.server_ms)+'</span>':'')+'</div>';
                } else {
                    var msg = (r0 && r0.msg) ? r0.msg : '执行成功，无返回结果集';
                    html += '<div style="padding:12px;color:#2ecc71;font-size:12px;">✅ '+escapeHtml(msg)+(r0.server_ms!==undefined?' <span style="color:#5dade2;">⏱ '+_fmtExecTime(r0.server_ms)+'</span>':'')+'</div>';
                }
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
            var hasRows = (rr.columns && rr.columns.length > 0);
            if (hasRows) {
                count = ' ('+(rr.total||0)+'行)';
            } else if ((rr.total||0) > 0) {
                count = ' (影响'+(rr.total||0)+'行)';
            } else {
                count = ' ✅';
            }
            // ★ 多结果 tab 标签也显示服务器执行时间
            if (rr.server_ms !== undefined) count += ' ⏱'+_fmtExecTime(rr.server_ms);
            var s = (stmtsArr||[])[i] || '';
            var shortSql = s.replace(/\s+/g,' ').trim().substring(0, 30);
            if (shortSql) label = shortSql;
        } else if (!rr || !rr.ok) {
            count = ' ❌';
        }
        html += '<button class="result-tab-btn'+(i===0?' active':'')+'" onclick="switchResultTab(\''+tid+'\','+i+')"><span class="tab-label">'+escapeHtml(label)+count+'</span><span class="tab-close" onclick="event.stopPropagation();closeSingleResultTab(event,\''+qid+'\','+i+',\''+tid+'\')" title="关闭此结果">✕</span></button>';
    }
    html += '</div>';
    // ★ 初始化多结果状态数组
    es._multiCols = new Array(results.length);
    es._multiRows = new Array(results.length);
    es._multiChanged = new Array(results.length);
    es._multiSelected = new Array(results.length);
    es._multiLastClicked = new Array(results.length);
    es._multiTableNames = new Array(results.length);
    es._multiStmts = stmtsArr || [];  // ★ 保存每条 SQL，供单 tab 刷新使用
    es._multiServerMs = new Array(results.length);  // ★ 保存每条 SQL 的服务器执行时间
    for (var im = 0; im < results.length; im++) {
        es._multiChanged[im] = {};
        es._multiSelected[im] = {};
        es._multiLastClicked[im] = -1;
        es._multiTableNames[im] = detectTableFromSql((stmtsArr||[])[im]||'');
        es._multiServerMs[im] = (results[im] && results[im].server_ms !== undefined) ? results[im].server_ms : undefined;
    }

    html += '<div class="result-tab-content">';
    for (var i2 = 0; i2 < results.length; i2++) {
        var r2 = results[i2];
        var tabBody = '';
        if (!r2 || !r2.ok) {
            tabBody = '<div style="padding:12px;color:#e74c3c;">❌ '+escapeHtml(r2?r2.msg:'无响应')+'</div>';
        } else {
            var rc2 = r2.total || 0;
            if ((r2.columns||[]).length > 0) {
                // ★ 多结果也使用完整编辑模式（与单SQL一致：选行+编辑+右键复制+删除）
                var cols2 = r2.columns||[];
                var rows2 = r2.rows||[];
                es._multiCols[i2] = cols2;
                es._multiRows[i2] = rows2;
                tabBody = '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:#111;border-bottom:1px solid #333;flex-wrap:wrap;">' +
                    '<button class="btn btn-sm" id="'+qid+'_mqsave_'+i2+'" onclick="_qDoSaveMulti(\''+qid+'\','+i2+')" disabled style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存 (0)</button>' +
                    '<button class="btn btn-sm" id="'+qid+'_mqcancel_'+i2+'" onclick="_qCancelEditMulti(\''+qid+'\','+i2+')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">↩ 取消修改</button>' +
                    '<span style="flex:1;"></span>' +
                    '<button class="btn btn-sm" id="'+qid+'_mqdel_'+i2+'" onclick="_qDoDeleteMulti(\''+qid+'\','+i2+')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">🗑 删除 (0)</button>' +
                    '<button class="btn btn-sm" onclick="_qExportResult(\''+qid+'\','+i2+')" style="background:#27ae60;color:#fff;font-size:10px;">📥 导出</button>' +
                    '<span style="font-size:10px;color:#666;">双击单元格编辑 | 选中行可删除</span></div>';
                tabBody += '<div style="padding:6px 12px;font-size:11px;color:#888;border-bottom:1px solid #333;">📊 查询结果 — '+rows2.length+' 行'+(r2.server_ms!==undefined?' <span style="color:#5dade2;">⏱ '+_fmtExecTime(r2.server_ms)+'</span>':'')+'</div>';
                tabBody += '<div style="overflow:auto;"><table class="exp-table"><thead><tr>';
                tabBody += '<th class="row-sel-header" id="'+qid+'_mqsel_all_'+i2+'" onclick="_qToggleSelAllMulti(\''+qid+'\','+i2+')" title="全选/取消全选">#</th>';
                cols2.forEach(function(c){ tabBody += '<th>'+escapeHtml(c)+'</th>'; });
                tabBody += '</tr></thead><tbody>';
                var mMax = Math.min(rows2.length, 200);
                for (var mi = 0; mi < mMax; mi++) {
                    var mr = rows2[mi];
                    var isSel = !!es._multiSelected[i2][mi];
                    var gripCls = isSel ? 'row-sel-grip selected' : 'row-sel-grip';
                    var rowCls = isSel ? ' class="row-selected"' : '';
                    tabBody += '<tr data-row-idx="'+mi+'"'+rowCls+'>';
                    tabBody += '<td class="'+gripCls+'" data-ri="'+mi+'" ' +
                        'onclick="_qGripClickMulti(\''+qid+'\','+i2+',this,'+mi+')" ' +
                        'oncontextmenu="_qMultiRowCtx(\''+qid+'\','+i2+',event,'+mi+')" ' +
                        'title="左键选择行 | Shift多选 | 右键菜单">'+(mi+1)+'</td>';
                    mr.forEach(function(mv,mci){
                        var mval = mv===null?'NULL':String(mv);
                        tabBody += '<td><input class="editable-cell" data-ri="'+mi+'" data-ci="'+mci+'" data-col="'+escapeAttr(cols2[mci])+'" value="'+escapeAttr(mval)+'" onfocus="this._oldVal=this.value" onblur="_qCellBlurMulti(\''+qid+'\','+i2+','+mi+','+mci+',this)" spellcheck="false" autocomplete="off" style="min-width:60px;"></td>';
                    });
                    tabBody += '</tr>';
                }
                tabBody += '</tbody></table></div>';
                if (rows2.length > mMax) tabBody += '<div style="padding:5px;color:#777;font-size:10px;">... 共 '+rows2.length+' 行，显示前 '+mMax+' 行</div>';
            } else {
                // ★ INSERT/UPDATE/DELETE 无结果集操作：显示影响行数
                if (rc2 > 0) {
                    var opType2 = '操作';
                    var s2 = (stmtsArr||[])[i2] || '';
                    var s2u = s2.trim().toUpperCase();
                    if (s2u.indexOf('INSERT') === 0) opType2 = '插入';
                    else if (s2u.indexOf('UPDATE') === 0) opType2 = '更新';
                    else if (s2u.indexOf('DELETE') === 0) opType2 = '删除';
                    else if (s2u.indexOf('REPLACE') === 0) opType2 = '替换';
                    tabBody = '<div style="padding:12px;color:#2ecc71;">✅ '+opType2+'成功，影响 <b>'+rc2+'</b> 行'+(r2.server_ms!==undefined?' <span style="color:#5dade2;">⏱ '+_fmtExecTime(r2.server_ms)+'</span>':'')+'</div>';
                } else {
                    tabBody = '<div style="padding:12px;color:#2ecc71;">✅ '+escapeHtml(r2.msg||'执行成功')+(r2.server_ms!==undefined?' <span style="color:#5dade2;">⏱ '+_fmtExecTime(r2.server_ms)+'</span>':'')+'</div>';
                }
            }
        }
        html += '<div class="result-tab-pane'+(i2===0?' active':'')+'" data-ri="'+i2+'">'+tabBody+'</div>';
    }
    html += '</div></div>';
    div.innerHTML = html;
    // 多结果也同步
    setTimeout(function(){ _syncQueryContent(qid); }, 50);

    // ★ 加载各 tab 的列类型，检测是否包含所有列（用于拦截不完整列时的修改/删除）
    es._multiAllColsPresent = new Array(results.length);
    for (var im3 = 0; im3 < results.length; im3++) {
        (function(idx) {
            var tname = es._multiTableNames[idx];
            var cols = es._multiCols[idx];
            if (tname && cols && cols.length > 0 && es.connData) {
                eel.table_get_col_types(es.connData, es.execDb, tname, '')(function(r){
                    if (r && r.ok) {
                        var tableCols = Object.keys(r.col_types || {});
                        es._multiAllColsPresent[idx] = tableCols.length === 0 || tableCols.every(function(tc) { return cols.indexOf(tc) !== -1; });
                    } else {
                        es._multiAllColsPresent[idx] = false;
                    }
                });
            } else {
                es._multiAllColsPresent[idx] = false;
            }
        })(im3);
    }
}

// ===== 多结果辅助函数 =====

/** 多结果单元格编辑失焦 */
function _qCellBlurMulti(qid, tabIdx, rowIdx, colIdx, inputEl) {
    if (!inputEl || inputEl.value === inputEl._oldVal) return;
    var es = _qState(qid);
    if (!es._multiChanged[tabIdx]) es._multiChanged[tabIdx] = {};
    var key = rowIdx + ':' + colIdx;
    es._multiChanged[tabIdx][key] = { rowIdx: rowIdx, colIdx: colIdx,
        oldVal: inputEl._oldVal, newVal: inputEl.value };
    _qUpdateMultiBtns(qid, tabIdx);
}

/** 多结果行选择 */
function _qGripClickMulti(qid, tabIdx, gripEl, rowIdx) {
    var es = _qState(qid);
    if (!es._multiSelected[tabIdx]) es._multiSelected[tabIdx] = {};
    if (!es._multiLastClicked) es._multiLastClicked = [];
    if (es._multiLastClicked[tabIdx] === undefined) es._multiLastClicked[tabIdx] = -1;
    var sel = es._multiSelected[tabIdx];
    var evt = window.event;
    var isShift = evt && evt.shiftKey;
    var isCtrl = evt && (evt.ctrlKey || evt.metaKey);
    if (isShift && es._multiLastClicked[tabIdx] >= 0) {
        var from = Math.min(es._multiLastClicked[tabIdx], rowIdx);
        var to = Math.max(es._multiLastClicked[tabIdx], rowIdx);
        sel = {}; es._multiSelected[tabIdx] = sel;
        for (var i = from; i <= to; i++) { sel[i] = true; }
    } else if (isCtrl) {
        if (sel[rowIdx]) delete sel[rowIdx]; else sel[rowIdx] = true;
        es._multiLastClicked[tabIdx] = rowIdx;
    } else if (sel[rowIdx] && Object.keys(sel).length === 1) {
        sel = {}; es._multiSelected[tabIdx] = sel; es._multiLastClicked[tabIdx] = -1;
    } else {
        sel = {}; sel[rowIdx] = true; es._multiSelected[tabIdx] = sel; es._multiLastClicked[tabIdx] = rowIdx;
    }
    _qRefreshMultiGrip(qid, tabIdx);
    _qUpdateMultiBtns(qid, tabIdx);
}

function _qRefreshMultiGrip(qid, tabIdx) {
    var sel = (_qState(qid)._multiSelected||[])[tabIdx] || {};
    var wrap = document.getElementById('qr_' + qid);
    if (!wrap) return;
    wrap.querySelectorAll('.result-tab-pane[data-ri="'+tabIdx+'"] .row-sel-grip').forEach(function(grip){
        var ri = parseInt(grip.getAttribute('data-ri'));
        var s = !!sel[ri];
        if (s) grip.classList.add('selected'); else grip.classList.remove('selected');
        var tr = grip.parentNode;
        if (tr) { if (s) tr.classList.add('row-selected'); else tr.classList.remove('row-selected'); }
    });
}

/** 多结果全选/取消全选 */
function _qToggleSelAllMulti(qid, tabIdx) {
    var es = _qState(qid);
    if (!es._multiSelected[tabIdx]) es._multiSelected[tabIdx] = {};
    if (!es._multiRows[tabIdx]) return;
    var rows = es._multiRows[tabIdx];
    var allSel = rows.length > 0 && Object.keys(es._multiSelected[tabIdx]).length >= rows.length;
    if (allSel) {
        es._multiSelected[tabIdx] = {};
    } else {
        es._multiSelected[tabIdx] = {};
        for (var i = 0; i < rows.length; i++) { es._multiSelected[tabIdx][i] = true; }
    }
    _qRefreshMultiGrip(qid, tabIdx);
    _qUpdateMultiBtns(qid, tabIdx);
    var hdr = document.getElementById(qid + '_mqsel_all_' + tabIdx);
    if (hdr) {
        if (!allSel && rows.length > 0) hdr.classList.add('all-selected');
        else hdr.classList.remove('all-selected');
    }
}

/** 多结果行右键菜单（复制 / 复制为 INSERT） */
function _qMultiRowCtx(qid, tabIdx, e, rowIdx) {
    e.preventDefault(); e.stopPropagation();
    var es = _qState(qid);
    var rows = (es._multiRows||[])[tabIdx];
    var cols = (es._multiCols||[])[tabIdx];
    if (!rows || !cols) return;
    var row = rows[rowIdx];
    if (!row) return;
    var fnSafe = function(n){ return '`'+String(n).replace(/`/g,'``')+'`'; };
    var fnVal = function(v){
        if (v===null||v===undefined) return 'NULL';
        var s=String(v); if(s==='') return "''";
        if(/^-?\d+(\.\d+)?$/.test(s.trim())) return s.trim();
        return "'"+s.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'";
    };
    var colNames = cols.map(function(c){ return fnSafe(c); }).join(', ');
    var values = row.map(function(v){ return fnVal(v); }).join(', ');
    var displayName = (es._multiTableNames||[])[tabIdx] || 'table_name';
    var sql = 'INSERT INTO '+fnSafe(displayName)+' ('+colNames+') VALUES ('+values+');';
    var rowText = row.map(function(v){ return v===null?'NULL':String(v); }).join('\t');
    showCtxMenu(e.clientX, e.clientY, [
        {label:'📋 复制', action:function(){ copyToClipboard(rowText); }},
        {label:'📋 复制为 INSERT 语句', action:function(){ copyToClipboard(sql); }}
    ]);
}

/** 更新多结果按钮状态 */
function _qUpdateMultiBtns(qid, tabIdx) {
    var es = _qState(qid);
    var changed = (es._multiChanged||[])[tabIdx] || {};
    var changedCnt = Object.keys(changed).length;
    var selected = (es._multiSelected||[])[tabIdx] || {};
    var selCnt = Object.keys(selected).length;

    var saveBtn = document.getElementById(qid + '_mqsave_' + tabIdx);
    var cancelBtn = document.getElementById(qid + '_mqcancel_' + tabIdx);
    var delBtn = document.getElementById(qid + '_mqdel_' + tabIdx);
    if (saveBtn) { saveBtn.disabled = changedCnt === 0; saveBtn.textContent = '💾 保存 (' + changedCnt + ')'; }
    if (cancelBtn) cancelBtn.disabled = changedCnt === 0;
    if (delBtn) { delBtn.disabled = selCnt === 0; delBtn.textContent = '🗑 删除 (' + selCnt + ')'; }
}

/** 多语句结果的保存（收集当前 tab 的编辑值） */
function _qDoSaveMulti(qid, tabIdx) {
    var es = _qState(qid);
    // ★ 拦截：查询未包含表的所有字段时，不允许修改数据
    if (es._multiAllColsPresent && es._multiAllColsPresent[tabIdx] === false) {
        showWarnDialog('修改被拦截', '当前查询未包含表的所有字段，不允许修改数据。\n\n修改操作需要所有字段值来构建精确的 WHERE 条件\n以确保只更新目标行。\n\n请使用 SELECT * 或包含所有字段的查询后重试。');
        return;
    }
    if (!es.connData) { showWarnDialog('提示', '连接信息丢失'); return; }
    var changed = (es._multiChanged||[])[tabIdx] || {};
    if (!Object.keys(changed).length) { showWarnDialog('提示', '没有检测到修改'); return; }

    var cols = es._multiCols[tabIdx] || [];
    var rows = es._multiRows[tabIdx] || [];
    var changes = [];
    for (var key in changed) {
        if (!changed.hasOwnProperty(key)) continue;
        var ch = changed[key];
        var colName = cols[ch.colIdx] || '';
        var origRow = (rows[ch.rowIdx] || []).map(function(v){ return v===null?'NULL':String(v); });
        changes.push({ col: colName, newVal: String(ch.newVal), origRow: origRow, columns: cols });
    }

    var btn = document.getElementById(qid + '_mqsave_' + tabIdx);
    if (btn) { btn.textContent = '⏳ 生成SQL...'; btn.disabled = true; }

    var tableName = es._multiTableNames[tabIdx] || '';
    eel.table_save_changes(es.connData, es.execDb, tableName, '', changes)(function(r){
        if (!r || !r.ok) {
            showWarnDialog('保存失败', r ? r.msg : '无响应');
            if (btn) { btn.textContent = '💾 保存 (' + changes.length + ')'; btn.disabled = false; }
            return;
        }
        showConfirmDialog('确认执行修改',
            '<div style="max-height:300px;overflow:auto;background:#0d1117;padding:8px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;">' + escapeHtml(r.sql||'') + '</div>' +
            '<div style="margin-top:6px;color:#f39c12;font-size:11px;">共 ' + r.count + ' 处修改</div>',
            function() {
                if (btn) { btn.textContent = '⏳ 执行中...'; btn.disabled = true; }
                eel.table_exec_save(es.connData, es.execDb, tableName, '', changes)(function(r2){
                    if (!r2 || !r2.ok) {
                        showWarnDialog('保存失败', r2 ? r2.msg : '无响应');
                        if (btn) { btn.textContent = '💾 保存 (' + changes.length + ')'; btn.disabled = false; }
                        return;
                    }
                    showOkDialog('保存成功', r2.msg);
                    es._multiChanged[tabIdx] = {};
                    _qUpdateMultiBtns(qid, tabIdx);
                    _qRefreshData(qid, tabIdx);
                });
            },
            function() {
                if (btn) { btn.textContent = '💾 保存 (' + changes.length + ')'; btn.disabled = false; }
            });
    });
}

/** 多语句编辑取消 */
function _qCancelEditMulti(qid, tabIdx) {
    var es = _qState(qid);
    es._multiChanged[tabIdx] = {};
    // 刷新当前 tab 的 input 值还原
    var wrap = document.getElementById('qr_' + qid);
    if (wrap) {
        wrap.querySelectorAll('.result-tab-pane[data-ri="'+tabIdx+'"] .editable-cell').forEach(function(inp){
            inp.value = inp._oldVal || inp.value;
            inp.classList.remove('changed');
        });
    }
    _qUpdateMultiBtns(qid, tabIdx);
}

/** 多语句删除选中行 */
function _qDoDeleteMulti(qid, tabIdx) {
    var es = _qState(qid);
    // ★ 拦截：查询未包含表的所有字段时，不允许删除数据
    if (es._multiAllColsPresent && es._multiAllColsPresent[tabIdx] === false) {
        showWarnDialog('删除被拦截', '当前查询未包含表的所有字段，不允许删除数据。\n\n删除操作需要所有字段值来构建精确的 WHERE 条件\n以确保只删除目标行。\n\n请使用 SELECT * 或包含所有字段的查询后重试。');
        return;
    }
    var selected = (es._multiSelected||[])[tabIdx] || {};
    var selKeys = Object.keys(selected);
    if (!selKeys.length) { showWarnDialog('提示', '请先选择要删除的行'); return; }
    if (!es.connData) { showWarnDialog('提示', '连接信息丢失'); return; }

    var cols = es._multiCols[tabIdx] || [];
    var rows = es._multiRows[tabIdx] || [];
    var rowsData = [];
    selKeys.forEach(function(oi) {
        var origRow = rows[parseInt(oi)];
        if (!origRow) return;
        rowsData.push({ origRow: origRow.map(function(v){ return v===null?'NULL':String(v); }), columns: cols });
    });
    if (!rowsData.length) { showWarnDialog('提示', '无法获取选中行的数据'); return; }

    var tableName = es._multiTableNames[tabIdx] || '';
    var delBtn = document.getElementById(qid + '_mqdel_' + tabIdx);
    eel.table_delete_rows(es.connData, es.execDb, tableName, '', rowsData)(function(r){
        if (!r || !r.ok) { showWarnDialog('删除失败', r?r.msg:'无响应'); return; }
        showConfirmDialog('确认删除',
            '<div style="max-height:300px;overflow:auto;background:#0d1117;padding:8px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;">' + escapeHtml(r.sql||'') + '</div>' +
            '<div style="margin-top:6px;color:#e74c3c;font-size:11px;">⚠ 将删除 ' + r.count + ' 行数据</div>',
            function(){
                eel.table_exec_delete(es.connData, es.execDb, tableName, '', rowsData)(function(r2){
                    if (!r2 || !r2.ok) { showWarnDialog('执行失败', r2?r2.msg:'无响应'); return; }
                    showOkDialog('删除成功', r2.msg);
                    es._multiSelected[tabIdx] = {};
                    es._multiChanged[tabIdx] = {};
                    _qUpdateMultiBtns(qid, tabIdx);
                    _qRefreshData(qid, tabIdx);
                });
            }
        );
    });
}

// 切换结果 Tab
function switchResultTab(containerId, index) {
    var ct = document.getElementById(containerId);
    if (!ct) return;
    ct.querySelectorAll('.result-tab-btn').forEach(function(b,i){ b.classList.toggle('active', i===index); });
    ct.querySelectorAll('.result-tab-pane').forEach(function(p,i){ p.classList.toggle('active', i===index); });
}

/** 关闭单个结果 Tab（仅用于多SQL场景） */
function closeSingleResultTab(evt, qid, tabIdx, tid) {
    var ct = document.getElementById(tid);
    if (!ct) return;
    var tabBar = ct.querySelector('.result-tab-bar');
    var tabContent = ct.querySelector('.result-tab-content');
    if (!tabBar || !tabContent) return;

    var btns = tabBar.querySelectorAll('.result-tab-btn');
    var panes = tabContent.querySelectorAll('.result-tab-pane');
    if (tabIdx >= btns.length) return;

    // 只剩1个tab：直接关闭整个结果区域
    if (btns.length <= 1) {
        closeQueryResults(qid);
        return;
    }

    var wasActive = btns[tabIdx].classList.contains('active');

    // 移除DOM元素
    btns[tabIdx].remove();
    panes[tabIdx].remove();

    // 更新剩余按钮的 onclick 和 close 索引
    var newBtns = tabBar.querySelectorAll('.result-tab-btn');
    newBtns.forEach(function(b, i) {
        b.setAttribute('onclick', "switchResultTab('" + tid + "'," + i + ")");
        var closeSpan = b.querySelector('.tab-close');
        if (closeSpan) {
            closeSpan.setAttribute('onclick', "event.stopPropagation();closeSingleResultTab(event,'" + qid + "'," + i + ",'" + tid + "')");
        }
    });

    // 更新剩余pane的data-ri
    var newPanes = tabContent.querySelectorAll('.result-tab-pane');
    newPanes.forEach(function(p, i) { p.setAttribute('data-ri', i); });

    // 更新多结果状态数组
    var es = _qState(qid);
    ['_multiCols','_multiRows','_multiChanged','_multiSelected','_multiStmts','_multiLastClicked','_multiTableNames','_multiAllColsPresent'].forEach(function(k) {
        if (es[k]) es[k].splice(tabIdx, 1);
    });

    // 如果关闭的是当前激活tab，切换到相邻tab
    if (wasActive) {
        var newIdx = Math.min(tabIdx, newBtns.length - 1);
        switchResultTab(tid, newIdx);
    }
}

// ==================== 工具函数 ====================
function loadCategoryItems(conn, db, cat, callback, schema) {
    var sch = schema || '';
    if (cat === 'tables') eel.db_explore_get_tables(conn,db,sch)(function(r){callback(r&&r.ok?(r.tables||[]):[]);});
    else if (cat === 'views') eel.db_explore_get_views(conn,db,sch)(function(r){callback(r&&r.ok?(r.views||[]).map(function(v){return{name:v};}):[]);});
    else if (cat === 'procedures') eel.db_explore_get_procedures(conn,db,sch)(function(r){callback(r&&r.ok?(r.procedures||[]).filter(function(p){return p.type==='PROCEDURE';}):[]);});
    else if (cat === 'functions') eel.db_explore_get_procedures(conn,db,sch)(function(r){callback(r&&r.ok?(r.procedures||[]).filter(function(p){return p.type==='FUNCTION';}):[]);});
    else if (cat === 'triggers') eel.db_explore_get_triggers(conn,db)(function(r){callback(r&&r.ok?(r.triggers||[]):[]);});
    else if (cat === 'indexes'||cat==='sequences'||cat==='synonyms'||cat==='packages'||cat==='mviews') eel.db_explore_get_objlist(conn,db,cat)(function(r){callback(r&&r.ok?(r.items||[]):[]);});
    else if (cat === 'queries') loadQueries(cid_from_conn(conn), db, callback);
    else callback([]);
}

function cid_from_conn(conn) {
    for (var k in (treeData.connections||{})) {
        if (treeData.connections[k] === conn) return k;
    }
    return '';
}

function loadQueries(cid, db, callback) {
    var queries = (treeData.saved_queries||[]).filter(function(q){return q.conn_id===cid && q.db===db;});
    callback(queries.map(function(q){return{name:q.name,id:q.id};}));
}

function toggleDbChildren(dbId, arrowId) {
    var el = document.getElementById(dbId);
    var ar = document.getElementById(arrowId);
    if (!el) return;
    if (el.classList.contains('open')) {
        el.classList.remove('open');
        if (ar) { ar.textContent = '▸'; }
    } else {
        el.classList.add('open');
        if (ar) { ar.textContent = '▾'; ar.style.visibility = 'visible'; }
    }
}

function toggleConnChildren(cid) {
    var children = document.getElementById('mc_c_' + cid);
    var arrow = document.getElementById('ma_c_' + cid);
    if (!children) return;
    if (children.classList.contains('open')) {
        children.classList.remove('open');
        if (arrow) { arrow.textContent = '▸'; }
    } else {
        children.classList.add('open');
        if (arrow) { arrow.textContent = '▾'; arrow.style.visibility = 'visible'; }
    }
}

function toggleChildren(childrenId, arrowId) {
    var el = document.getElementById(childrenId);
    var ar = document.getElementById(arrowId);
    if (!el) return;
    if (el.classList.contains('open')) { el.classList.remove('open'); if(ar)ar.textContent='▸'; }
    else { el.classList.add('open'); if(ar)ar.textContent='▾'; }
}

// ★ DDL 执行后自动刷新左侧树的表列表
function autoRefreshTreeTables(cid, connData, execDb, qDb) {
    if (!treeData || !treeData.connections || !cid) return;
    var conn = treeData.connections[cid];
    if (!conn) return;
    var dbType = connData.db_type || '';
    // ★ Oracle 的 execDb 是 service_name/SID，查表必须用 schema 名；activeDatabase 是连接展开时设置的当前 schema
    var refreshDb = (dbType === 'oracle') ? (qDb || activeDatabase || '') : (execDb || qDb || '');
    // 收集所有可能的 dbKey
    var candidates = [];
    if (dbType === 'oracle') {
        // Oracle: 用 schema 名生成 dbKey，同时也加入 username（可能大小写不同）
        if (refreshDb) candidates.push(safeBtoa(refreshDb));
        if (connData.user && safeBtoa(connData.user.toUpperCase()) !== safeBtoa(refreshDb)) candidates.push(safeBtoa(connData.user.toUpperCase()));
    } else {
        if (execDb) candidates.push(safeBtoa(execDb));
        if (qDb && qDb !== execDb) candidates.push(safeBtoa(qDb));
    }
    candidates.forEach(function(dbKey) {
        var rowId = 'cat_tables_' + dbKey;
        var el = document.getElementById(rowId);
        if (!el) return;
        var children = el.nextElementSibling;
        if (!children || !children.classList.contains('tree-children')) return;
        if (children.classList.contains('open') && children.innerHTML.trim()) {
            // 已展开：立即刷新
            children.innerHTML = '<div style="font-size:11px;color:#999;padding:4px 0;padding-left:36px;">🔄 刷新中...</div>';
            loadCategoryItems(conn, refreshDb, 'tables', function(items) {
                var itemPad = 36;
                var h = items.map(function(it) {
                    var n = it.name || it;
                    return '<div class="my-conn-row" style="padding-left:'+itemPad+'px;font-size:11px;line-height:22px;" ondblclick="addTableDataTab(\x27'+escapeAttr(n)+'\x27,\x27'+escapeAttr(refreshDb)+'\x27,\x27\x27,\x27'+cid+'\x27)"><span class="my-conn-icon">📊</span>'+escapeHtml(n)+'</div>';
                }).join('');
                children.innerHTML = h || '<div style="padding-left:'+itemPad+'px;color:#999;font-size:11px;">（无数据）</div>';
            }, '');
        } else {
            // 未展开：清空缓存，下次点击自动重新加载
            children.innerHTML = '';
        }
    });
}

// Redis DB 节点：仅折叠/展开（不加载数据）
