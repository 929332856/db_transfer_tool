// ==================== 查询编辑器分割线拖动 ====================
// ★ 格式化服务器执行时间：毫秒→友好显示
function _fmtExecTime(ms) {
    if (ms < 1) return ms.toFixed(2) + 'ms';
    if (ms < 1000) return ms.toFixed(1) + 'ms';
    return (ms / 1000).toFixed(2) + 's';
}
// ★ 格式化详细计时分解（exec_ms=提交+元数据, fetch_ms=取数+处理, serial_ms=JSON序列化）
function _fmtExecTimeDetail(r) {
    if (!r) return '';
    var parts = [];
    if (r.server_ms !== undefined) parts.push('⏱ <b>总 ' + _fmtExecTime(r.server_ms) + '</b>');
    // 有分解数据时显示详细（server_ms ≈ exec_ms + fetch_ms）
    if (r.exec_ms !== undefined && r.fetch_ms !== undefined) {
        parts.push('提交 ' + _fmtExecTime(r.exec_ms));
        parts.push('取数 ' + _fmtExecTime(r.fetch_ms));
        if (r.serial_ms !== undefined && r.serial_ms > 1) parts.push('序列化 ' + _fmtExecTime(r.serial_ms));
        return parts.join(' · ');
    }
    return parts[0] || '';
}
// ★ 生成含详细计时和 has_more 提示的 HTML
function _fmtExecTimeHtml(r) {
    if (!r || r.server_ms === undefined) return '';
    var detail = _fmtExecTimeDetail(r);
    var html = ' <span style="color:#5dade2;">' + detail + '</span>';
    if (r.has_more) html += ' <span style="color:#f39c12;font-size:10px;">⚠ 已达取数上限，请加 LIMIT</span>';
    return html;
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

/** ★ 智能 SQL 分句：处理引号内分号、中文引号等特殊情况 */
function _smartSplitSQL(text) {
    var stmts = [];
    var buf = '';
    var inSingle = false;
    var inDouble = false;
    for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        if (ch === '\\' && inSingle) {
            buf += ch;
            if (i + 1 < text.length) { buf += text[i + 1]; i++; }
        } else if ((ch === "'" || ch === '\u2018' || ch === '\u2019') && !inDouble) {
            inSingle = !inSingle; buf += ch;
        } else if ((ch === '"' || ch === '\u201c' || ch === '\u201d') && !inSingle) {
            inDouble = !inDouble; buf += ch;
        } else if (ch === ';' && !inSingle && !inDouble) {
            var s = buf.trim();
            if (s && s.substring(0,2) !== '--' && s.charAt(0) !== '#') stmts.push(s);
            buf = '';
        } else {
            buf += ch;
        }
    }
    var s = buf.trim();
    if (s && s.substring(0,2) !== '--' && s.charAt(0) !== '#') stmts.push(s);
    return stmts;
}

/** ★ 核心执行逻辑（textarea 存在时直接调用，免去 tree_get_query 的延迟） */
function _execQueryWithSql(qid, fullSql, myToken, curTabSync, ta, resultsDiv, btnExe) {
    // 检查选中文本（过滤注释）
    var sel = '';
    if (ta) {
        var st2 = ta.selectionStart, en2 = ta.selectionEnd;
        if (st2 !== en2) sel = _stripSqlComments(ta.value.substring(st2, en2).trim());
    }
    var sqlToExec = sel || _stripSqlComments(fullSql);
    var stmts = _smartSplitSQL(sqlToExec);

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

    // ★ 释放上次查询的服务端结果缓存
    _releaseQueryStore(qid);
    // ★ 清除旧的查询结果数据，防止 tab 切换时闪现旧数据
    var esClear = _qState(qid);
    esClear.columns = [];
    esClear.rows = [];
    esClear.changedCells = {};
    esClear.selectedRows = {};
    esClear._lastClickedIdx = -1;
    esClear.editing = false;
    esClear._execJustStarted = true; // 标记刚清空，防止 _afterContentUpdate 恢复旧数据
    esClear._jobId = null;
    esClear._showRowCount = 200;
    esClear._totalRows = 0;
    esClear._loadingAll = false;
    esClear._cancelLoadAll = false;

    if (btnExe) { btnExe.textContent = '⏹ 取消'; btnExe.style.background = '#e74c3c'; }
    if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:10px;color:#999;display:flex;align-items:center;gap:10px;"><span>⏳ 执行中...</span><button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;padding:3px 10px;" onclick="cancelExecQuery(\''+qid+'\')">⏹ 取消</button></div>';
    var layout = resultsDiv ? resultsDiv.parentElement : null;
    if (layout) {
        layout.classList.add('split');
        // ★ 首次进入 split 模式时，设置编辑器默认高度（约占 30%），避免编辑器过小或占据过多空间
        var editorWrap = layout.querySelector('.query-editor-wrap');
        if (editorWrap && !editorWrap.style.height) {
            var totalH = layout.clientHeight;
            var defaultH = Math.max(60, Math.floor(totalH * 0.3));
            editorWrap.style.height = defaultH + 'px';
            editorWrap.style.flex = 'none';
        }
    }

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
        eel.execute_sql_query(clean, data)(function(resp){
            // ★ 令牌检测：异步回调返回时，确认仍是当前执行
            if (_execToken[qid] !== myToken) return;

            // ★ 结果处理函数（同步/异步共用）
            function handleResult(result) {
                allResults[i] = result;
                if (result && result.ok && !result.cancelled && (!result.columns || !result.columns.length) && result.total === undefined) {
                    hasDDL = true;
                }
                execIdx++;
                execNext();
            }

            if (resp && resp._async && resp._job_id) {
                // ★ 异步模式：poll 轮询获取结果（不阻塞 Eel 主线程）
                var pollStart = Date.now();
                (function pollLoop() {
                    if (_execToken[qid] !== myToken) return;
                    if (_execCancelFlags[qid]) {
                        _execCancelFlags[qid] = false;
                        _execRunning[qid] = false;
                        if (btnExe) { btnExe.textContent = '▶ 执行'; btnExe.style.background = '#2ecc71'; }
                        if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:10px;color:#f39c12;">⏸ 查询已取消</div>';
                        return;
                    }
                    // ★ 显示执行耗时（每秒更新）
                    var elapsed = Math.round((Date.now() - pollStart) / 1000);
                    var dots = '.'.repeat((elapsed % 3) + 1);
                    if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:10px;color:#999;display:flex;align-items:center;gap:10px;"><span>⏳ 执行中' + dots + ' (' + elapsed + 's)</span><button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;padding:3px 10px;" onclick="cancelExecQuery(\''+qid+'\')">⏹ 取消</button></div>';
                    eel.poll_query_result(resp._job_id)(function(pollResult) {
                        if (pollResult && pollResult._pending) {
                            setTimeout(pollLoop, 200);
                        } else {
                            handleResult(pollResult || {"ok": false, "msg": "无响应"});
                        }
                    });
                })();
                return;
            }
            handleResult(resp);
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
    // ★ 释放服务端查询结果缓存
    _releaseQueryStore(qid);
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
    es._jobId = null;
    es._showRowCount = 200;
    es._loadingAll = false;
    es._cancelLoadAll = false;
    es._totalRows = 0;
}

// ==================== 查询结果显示行数控制（行数选择器 / 显示全部 / 取消加载） ====================

// ★ 命名分页入口函数（供 onclick 直接调用，避免内联函数字面量）
function _changeRowCount(qid) {
    var sel = document.getElementById(qid + '_rowcount_sel');
    if (!sel) return;
    var val = sel.value;
    var es = _qState(qid);
    if (!es) return;

    if (val === 'all') {
        _showAllRows(qid);
        return;
    }

    var count = parseInt(val) || 200;
    es._showRowCount = count;
    es._loadingAll = false;
    es._cancelLoadAll = false;

    var loaded = es.rows.length;
    var total = es._totalRows || 0;
    var need = Math.min(count, total);

    if (loaded < need && es._jobId) {
        var pagBar = document.getElementById(qid + '_pagbar');
        if (pagBar) pagBar.innerHTML = '<span style="color:#f39c12;">正在加载更多行...</span>';
        _loadQueryPage(qid, loaded, need - loaded, function(r) {
            _qRenderTable(qid);
        });
    } else {
        _qRenderTable(qid);
    }
}

// 显示全部按钮：启动分批加载
function _showAllRows(qid) {
    var es = _qState(qid);
    if (!es) return;
    var jid = es._jobId;
    if (!jid) return;

    var total = es._totalRows || 0;
    var loaded = es.rows.length;

    if (loaded >= total) {
        es._showRowCount = total;
        es._loadingAll = false;
        _qRenderTable(qid);
        return;
    }

    es._loadingAll = true;
    es._cancelLoadAll = false;
    es._showRowCount = total;
    _showAllBatches(qid, loaded);
}

// 取消显示全部加载
function _cancelShowAll(qid) {
    var es = _qState(qid);
    if (!es) return;
    es._cancelLoadAll = true;
    es._loadingAll = false;
    es._showRowCount = es.rows.length;
    _qRenderTable(qid);
}

// 分批加载全部行（异步递归，支持取消，防卡死）
function _showAllBatches(qid, offset) {
    var es = _qState(qid);
    var jid = es._jobId;
    if (!jid) return;
    if (es._cancelLoadAll) return;

    var total = es._totalRows || 0;
    var BATCH = 500; // 与后端 get_query_page 单次上限一致，小批次防卡死

    var pagBar = document.getElementById(qid + '_pagbar');
    if (pagBar) {
        pagBar.innerHTML = '<span style="color:#f39c12;">正在加载全部 ' + offset + '/' + total + ' 行...</span>' +
            '<button class="btn btn-sm" onclick="_cancelShowAll(\x27' + qid + '\x27)" style="background:#e74c3c;color:#fff;font-size:10px;cursor:pointer;">取消加载</button>';
    }

    eel.get_query_page(jid, offset, BATCH)(function(r) {
        if (es._cancelLoadAll) {
            _qRenderTable(qid);
            return;
        }
        if (r && r.ok) {
            for (var i = 0; i < r.rows.length; i++) {
                if (offset + i >= es.rows.length) {
                    es.rows[offset + i] = r.rows[i];
                }
            }

            if (r.page_end >= total) {
                es._loadingAll = false;
                _qRenderTable(qid);
            } else {
                setTimeout(function() { _showAllBatches(qid, r.page_end); }, 30);
            }
        } else {
            if (pagBar) pagBar.innerHTML = '<span style="color:#e74c3c;">加载失败: ' + (r ? r.msg : '无响应') + '</span>';
            es._loadingAll = false;
        }
    });
}

/** 从服务端加载指定偏移量和行数的数据 */
function _loadQueryPage(qid, offset, limit, callback) {
    var es = _qState(qid);
    var jid = es._jobId;
    if (!jid) {
        var pagBar = document.getElementById(qid + '_pagbar');
        if (pagBar) pagBar.innerHTML = '<span style="color:#e74c3c;">查询结果已过期，请重新执行 SQL</span>';
        if (callback) callback(null);
        return;
    }
    eel.get_query_page(jid, offset, limit)(function(r) {
        if (r && r.ok) {
            for (var i = 0; i < r.rows.length; i++) {
                if (offset + i >= es.rows.length) {
                    es.rows[offset + i] = r.rows[i];
                }
            }
        } else {
            var pagBar2 = document.getElementById(qid + '_pagbar');
            if (pagBar2) pagBar2.innerHTML = '<span style="color:#e74c3c;">加载失败: ' + (r ? r.msg : '无响应') + '</span>';
        }
        if (callback) callback(r);
    });
}

/** 渲染行数控制栏（行数选择器 + 显示全部按钮） */
function _renderRowControls(qid) {
    var es = _qState(qid);
    var total = es._totalRows || es.rows.length;
    var loaded = es.rows.length;
    var showCount = es._showRowCount || 200;
    var isLoadingAll = es._loadingAll;

    if (isLoadingAll) {
        var html2 = '<div id="' + qid + '_pagbar" class="qr-pagbar" style="display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:11px;flex-wrap:wrap;">';
        html2 += '<span class="qr-pagbar-warn">正在加载全部 ' + loaded + '/' + total + ' 行...</span>';
        html2 += '<button class="btn btn-sm" onclick="_cancelShowAll(\x27' + qid + '\x27)" style="background:#e74c3c;color:#fff;font-size:10px;cursor:pointer;">取消加载</button>';
        html2 += '</div>';
        return html2;
    }

    var shownAll = (loaded >= total && showCount >= total);
    var displayed = Math.min(showCount, loaded, total);

    var html = '<div id="' + qid + '_pagbar" class="qr-pagbar" style="display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:11px;flex-wrap:wrap;">';
    html += '<span>显示 <b>1</b>-<b>' + displayed + '</b> 行，共 <b>' + total + '</b> 行</span>';

    html += '<span>展示:</span>';
    html += '<select class="qr-pagbar-sel" id="' + qid + '_rowcount_sel" onchange="_changeRowCount(\x27' + qid + '\x27)">';
    var rowOptions = [200, 500, 1000, 2000, 5000];
    var selVal = showCount;
    for (var rj = 0; rj < rowOptions.length; rj++) {
        var optVal = rowOptions[rj];
        var sel = (optVal === selVal) ? ' selected' : '';
        html += '<option value="' + optVal + '"' + sel + '>' + optVal + ' 行</option>';
    }
    html += '<option value="all"' + (shownAll ? ' selected' : '') + '>全部</option>';
    html += '</select>';

    if (!shownAll && loaded < total) {
        html += '<button class="btn btn-sm" onclick="_showAllRows(\x27' + qid + '\x27)" style="background:#27ae60;color:#fff;font-size:10px;cursor:pointer;">显示全部(' + total + '行)</button>';
    }

    if (shownAll) {
        html += '<span class="qr-pagbar-ok">已显示全部 ' + total + ' 行</span>';
    } else if (loaded < Math.min(showCount, total)) {
        html += '<span class="qr-pagbar-warn">(当前仅显示前 ' + loaded + ' 行，需切换行数后加载更多)</span>';
    }

    html += '</div>';
    return html;
}

// ==================== 虚拟滚动（>500行只渲染可见行，防止DOM卡死） ====================
var _VT_ROW_H = 28;        // 估算每行像素高度
var _VT_THRESHOLD = 500;   // 超过此行数启用虚拟滚动

/** 生成单行 HTML（复用于虚拟滚动和普通渲染） */
function _vtRowHtml(qid, es, i) {
    var row = es.rows[i];
    var isSel = !!es.selectedRows[i];
    var gripCls = isSel ? 'row-sel-grip selected' : 'row-sel-grip';
    var rowCls = isSel ? ' class="row-selected"' : '';
    var html = '<tr data-row-idx="'+i+'"'+rowCls+'>';
    html += '<td class="'+gripCls+'" data-ri="'+i+'" ' +
        'onclick="_qGripClick(\x27'+qid+'\x27,this,'+i+')" ' +
        'oncontextmenu="_qRowCtx(\x27'+qid+'\x27,event,'+i+')" ' +
        'title="">'+(i+1)+'</td>';
    row.forEach(function(v, ci) {
        var changedCell = es.changedCells[i + ':' + ci];
        var val = changedCell ? String(changedCell.newVal) : (v===null ? 'NULL' : String(v));
        html += '<td><input class="editable-cell" data-ri="'+i+'" data-ci="'+ci+'" data-col="'+escapeAttr(es.columns[ci])+'" value="'+escapeAttr(val)+'" onfocus="this._oldVal=this.value" onblur="_qCellBlur(\x27'+qid+'\x27,'+i+','+ci+',\x27'+escapeAttr(es.columns[ci])+'\x27,this)" spellcheck="false" autocomplete="off"></td>';
    });
    html += '</tr>';
    return html;
}

/** 虚拟滚动：重新计算可见范围并渲染 tbody */
function _vtRenderBody(qid) {
    var es = _qState(qid);
    var tbody = document.getElementById(qid + '_vtbody');
    if (!tbody) return;
    var maxShow = Math.min(es.rows.length, es._showRowCount || 200, es._totalRows || 999999);
    if (maxShow === 0) return;
    var wrapper = document.getElementById(qid + '_vtwrap');
    var scrollTop = wrapper ? wrapper.scrollTop : 0;
    var viewH = wrapper ? (wrapper.clientHeight || 600) : 600;
    var first = Math.floor(scrollTop / _VT_ROW_H);
    var count = Math.ceil(viewH / _VT_ROW_H) + 5; // +5 缓冲行
    var last = Math.min(first + count, maxShow);
    if (first >= maxShow) first = Math.max(0, maxShow - count);
    if (first < 0) first = 0;

    // 总列数 = 行号列(1) + 数据列
    var totalCols = 1 + (es.columns ? es.columns.length : 0);

    var html = '';
    if (first > 0) {
        html += '<tr style="height:'+(first*_VT_ROW_H)+'px;line-height:1px;pointer-events:none;"><td colspan="'+totalCols+'" style="padding:0;border:none;"></td></tr>';
    }
    for (var i = first; i < last; i++) {
        if (es.rows[i]) html += _vtRowHtml(qid, es, i);
    }
    if (last < maxShow) {
        html += '<tr style="height:'+((maxShow-last)*_VT_ROW_H)+'px;line-height:1px;pointer-events:none;"><td colspan="'+totalCols+'" style="padding:0;border:none;"></td></tr>';
    }
    tbody.innerHTML = html;
}

/** 虚拟滚动 onscroll 处理（requestAnimationFrame 节流） */
function _vtOnScroll(qid) {
    var es = _qState(qid);
    if (es._vtRafId) cancelAnimationFrame(es._vtRafId);
    es._vtRafId = requestAnimationFrame(function() {
        _vtRenderBody(qid);
    });
}

// ==================== 多结果虚拟滚动 ====================

/** 生成多结果单行 HTML */
function _vtRowHtmlM(qid, tabIdx, cols, rows, selObj, i) {
    var mr = rows[i];
    var isSel = !!selObj[i];
    var gripCls = isSel ? 'row-sel-grip selected' : 'row-sel-grip';
    var rowCls = isSel ? ' class="row-selected"' : '';
    var html = '<tr data-row-idx="'+i+'"'+rowCls+'>';
    html += '<td class="'+gripCls+'" data-ri="'+i+'" ' +
        'onclick="_qGripClickMulti(\x27'+qid+'\x27,'+tabIdx+',this,'+i+')" ' +
        'oncontextmenu="_qMultiRowCtx(\x27'+qid+'\x27,'+tabIdx+',event,'+i+')" ' +
        'title="">'+(i+1)+'</td>';
    mr.forEach(function(mv, mci){
        var mval = mv===null?'NULL':String(mv);
        html += '<td><input class="editable-cell" data-ri="'+i+'" data-ci="'+mci+'" data-col="'+escapeAttr(cols[mci])+'" value="'+escapeAttr(mval)+'" onfocus="this._oldVal=this.value" onblur="_qCellBlurMulti(\x27'+qid+'\x27,'+tabIdx+','+i+','+mci+',this)" spellcheck="false" autocomplete="off" style="min-width:60px;"></td>';
    });
    html += '</tr>';
    return html;
}

/** 多结果虚拟滚动：渲染可见行 */
function _vtRenderBodyM(qid, tabIdx) {
    var es = _qState(qid);
    var tbody = document.getElementById(qid + '_mvtbody' + tabIdx);
    if (!tbody) return;
    var cols = es._multiCols[tabIdx] || [];
    var rows = es._multiRows[tabIdx] || [];
    var selObj = es._multiSelected[tabIdx] || {};
    var maxShow = rows.length;
    if (maxShow === 0) return;
    var wrapper = document.getElementById(qid + '_mvt' + tabIdx);
    var scrollTop = wrapper ? wrapper.scrollTop : 0;
    var viewH = wrapper ? (wrapper.clientHeight || 600) : 600;
    var first = Math.floor(scrollTop / _VT_ROW_H);
    var count = Math.ceil(viewH / _VT_ROW_H) + 5;
    var last = Math.min(first + count, maxShow);
    if (first >= maxShow) first = Math.max(0, maxShow - count);
    if (first < 0) first = 0;

    var totalCols = 1 + cols.length;

    var html = '';
    if (first > 0) {
        html += '<tr style="height:'+(first*_VT_ROW_H)+'px;line-height:1px;pointer-events:none;"><td colspan="'+totalCols+'" style="padding:0;border:none;"></td></tr>';
    }
    for (var i = first; i < last; i++) {
        if (rows[i]) html += _vtRowHtmlM(qid, tabIdx, cols, rows, selObj, i);
    }
    if (last < maxShow) {
        html += '<tr style="height:'+((maxShow-last)*_VT_ROW_H)+'px;line-height:1px;pointer-events:none;"><td colspan="'+totalCols+'" style="padding:0;border:none;"></td></tr>';
    }
    tbody.innerHTML = html;
}

/** 多结果虚拟滚动 onscroll 节流 */
function _vtOnScrollM(qid, tabIdx) {
    var es = _qState(qid);
    var key = '_vtRafIdM' + tabIdx;
    if (es[key]) cancelAnimationFrame(es[key]);
    es[key] = requestAnimationFrame(function() {
        _vtRenderBodyM(qid, tabIdx);
    });
}

/** 释放查询结果缓存（切换 tab 或关闭结果时调用） */
function _releaseQueryStore(qid) {
    var es = _qState(qid);
    var jid = es._jobId;
    if (jid) {
        eel.release_query_result(jid)();
        es._jobId = null;
    }
}

// 查询结果编辑状态（按 qid）
var _queryEditStates = {};

/** 获取查询结果编辑状态 */
function _qState(qid) {
    if (!_queryEditStates[qid]) {
        _queryEditStates[qid] = { columns: [], rows: [], changedCells: {}, selectedRows: {}, editing: false, connData: null, execDb: '', _colComments: {}, _colTypes: {}, _lastClickedIdx: -1, server_ms: undefined, _lastResult: null, _multiResults: [], _jobId: null, _showRowCount: 200, _totalRows: 0, _loadingAll: false, _cancelLoadAll: false };
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
            if (btn) { _qSaveBtnReset(btn, qid); }
            return;
        }
        var sql = r.sql || '';
        // 第二步：弹窗确认 SQL 后再执行
        showConfirmDialog('确认执行修改',
            '<div class="confirm-sql-preview">' + escapeHtml(sql) + '</div>' +
            '<div class="confirm-sql-count">共 ' + r.count + ' 处修改</div>',
            function() {
                // ★ 执行中：按钮 hover 显示"取消执行"，点击可 Kill 数据库会话
                _qSaveBtnRunning(btn, qid);
                // 第三步：确认后执行
                eel.table_exec_save(es.connData, es.execDb, es._tableName || '', '', changes)(function(r2){
                    _qSaveBtnReset(btn, qid);
                    if (r2 && r2.cancelled) {
                        showWarnDialog('已取消', '操作已被取消');
                        return;
                    }
                    if (!r2 || !r2.ok) {
                        showWarnDialog('保存失败', r2 ? r2.msg : '无响应');
                        return;
                    }
                    // ★ 保存成功不弹窗，直接刷新数据（避免"确认弹窗→成功弹窗"闪烁）
                    es.changedCells = {};
                    es.editing = false;
                    _qUpdateBtns(qid);
                    // 刷新数据（重新执行当前查询）
                    _qRefreshData(qid);
                });
            },
            function() {
                // 取消：恢复按钮状态
                _qSaveBtnReset(btn, qid);
            });
    });
}

// ★ 保存按钮：进入"执行中"状态，hover 变为"取消执行"
function _qSaveBtnRunning(btn, qid) {
    if (!btn) return;
    btn.textContent = '⏳ 执行中...';
    btn.style.background = '#f39c12';
    btn.style.color = '#fff';
    btn.disabled = false;
    btn._qSaveQid = qid;
    btn.onmouseenter = function() {
        btn.textContent = '⏹ 取消执行';
        btn.style.background = '#e74c3c';
    };
    btn.onmouseleave = function() {
        btn.textContent = '⏳ 执行中...';
        btn.style.background = '#f39c12';
    };
    btn.onclick = function() {
        btn.onmouseenter = null;
        btn.onmouseleave = null;
        btn.textContent = '⏸ 取消中...';
        btn.style.background = '#e74c3c';
        btn.disabled = true;
        eel.cancel_query()();
    };
}

// ★ 保存按钮：恢复为正常状态
function _qSaveBtnReset(btn, qid) {
    if (!btn) return;
    btn.onmouseenter = null;
    btn.onmouseleave = null;
    btn.onclick = function() { _qDoSave(qid); };
    btn.textContent = '💾 保存';
    btn.style.background = '#2ecc71';
    btn.style.color = '#fff';
    btn.disabled = false;
    _qUpdateBtns(qid);
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
            '<div class="confirm-sql-preview">' + escapeHtml(r.sql||'') + '</div>' +
            '<div class="confirm-sql-warn">⚠ 将删除 ' + r.count + ' 行数据</div>',
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
        // ★ execute_sql_query 是异步的，需要轮询获取结果
        eel.execute_sql_query(stmt, data)(function(resp){
            function handleRefreshSingle(result) {
                if (!result || !result.ok) {
                    if (pane) pane.innerHTML = '<div style="padding:10px;color:#e74c3c;">❌ '+(result?result.msg:'无响应')+'</div>';
                    return;
                }
                es._multiCols[tabIdx] = result.columns || [];
                es._multiRows[tabIdx] = result.rows || [];
                es._multiResults[tabIdx] = result;  // ★ 保存完整结果用于显示详细计时
                _qRebuildSingleTab(qid, tabIdx);
            }
            if (resp && resp._async && resp._job_id) {
                (function pollLoop() {
                    eel.poll_query_result(resp._job_id)(function(pollResult) {
                        if (pollResult && pollResult._pending) {
                            setTimeout(pollLoop, 200);
                        } else {
                            handleRefreshSingle(pollResult || {"ok": false, "msg": "\u65e0\u54cd\u5e94"});
                        }
                    });
                })();
            } else {
                handleRefreshSingle(resp);
            }
        });
        return;
    }

    // 单语句结果或无 tabIdx：全量刷新
    // ★ 优先使用保存的原始执行 SQL 语句（避免编辑器内容变化/选区导致刷新不一致）
    var stmts = es._executedStmts || [];
    if (!stmts.length) {
        // 兜底：从编辑器读取（兼容旧会话未保存 _executedStmts 的情况）
        var sqlEl = document.getElementById('sq_'+qid);
        if (!sqlEl) return;
        var fullSql = sqlEl.value;
        var sel = '';
        var st = sqlEl.selectionStart, en = sqlEl.selectionEnd;
        if (st !== en) sel = sqlEl.value.substring(st, en).trim();
        var sqlToExec = sel || fullSql;
        stmts = sqlToExec.split(';').filter(function(s){return s.trim();});
    }

    if (!stmts.length) return;
    resultsDiv.innerHTML = '<div style="padding:10px;color:#999;">🔄 正在刷新...</div>';
    var allResults = [];
    var refIdx = 0;

    // ★ 辅助：处理单条刷新结果
    function handleRefreshResult(result, stmtIdx) {
        allResults[stmtIdx] = result;
        refIdx++;
        execNextRefresh();
    }

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
        // ★ execute_sql_query 现在是异步的，需要轮询获取结果
        eel.execute_sql_query(clean, data)(function(resp){
            if (resp && resp._async && resp._job_id) {
                (function pollLoop() {
                    eel.poll_query_result(resp._job_id)(function(pollResult) {
                        if (pollResult && pollResult._pending) {
                            setTimeout(pollLoop, 200);
                        } else {
                            handleRefreshResult(pollResult || {"ok": false, "msg": "无响应"}, i);
                        }
                    });
                })();
            } else {
                handleRefreshResult(resp, i);
            }
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
        tabBody += '<div class="qr-action-bar" style="display:flex;align-items:center;gap:6px;padding:6px 8px;flex-wrap:wrap;">' +
            '<button class="btn btn-sm" id="'+qid+'_mqsave_'+tabIdx+'" onclick="_qDoSaveMulti(\''+qid+'\','+tabIdx+')" disabled style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存 (0)</button>' +
            '<button class="btn btn-sm" id="'+qid+'_mqcancel_'+tabIdx+'" onclick="_qCancelEditMulti(\''+qid+'\','+tabIdx+')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">↩ 取消修改</button>' +
            '<span style="flex:1;"></span>' +
            '<button class="btn btn-sm" id="'+qid+'_mqdel_'+tabIdx+'" onclick="_qDoDeleteMulti(\''+qid+'\','+tabIdx+')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">🗑 删除 (0)</button>' +
            '<button class="btn btn-sm" onclick="_qExportResult(\''+qid+'\','+tabIdx+')" style="background:#27ae60;color:#fff;font-size:10px;">📥 导出</button>' +
            '<span class="qr-tip" style="font-size:10px;">双击单元格编辑 | 选中行可删除</span></div>';
        var multiTotal = es._multiTotalRows[tabIdx] || rows.length;
        tabBody += '<div class="qr-stats-bar" style="padding:6px 12px;font-size:11px;">📊 查询结果 — '+multiTotal+' 行'+_fmtExecTimeHtml(es._multiResults && es._multiResults[tabIdx])+'</div>';
        // ★ 超过500行启用虚拟滚动
        var mMax = rows.length;
        var needVTM = (mMax > _VT_THRESHOLD);
        if (needVTM) {
            tabBody += '<div id="'+qid+'_mvt'+tabIdx+'" style="overflow-y:auto;flex:1;min-height:0;" onscroll="_vtOnScrollM(\x27'+qid+'\x27,'+tabIdx+')">';
            tabBody += '<table class="exp-table" style="width:100%;">';
            tabBody += '<thead style="position:sticky;top:0;z-index:2;background:#1a1a2e;"><tr>';
            tabBody += '<th class="row-sel-header" id="'+qid+'_mqsel_all_'+tabIdx+'" onclick="_qToggleSelAllMulti(\x27'+qid+'\x27,'+tabIdx+')" title="全选/取消全选">#</th>';
            cols.forEach(function(c){ tabBody += '<th>'+escapeHtml(c)+'</th>'; });
            tabBody += '</tr></thead>';
            tabBody += '<tbody id="'+qid+'_mvtbody'+tabIdx+'"></tbody>';
            tabBody += '</table></div>';
        } else {
            tabBody += '<div style="overflow:auto;flex:1;min-height:0;"><table class="exp-table"><thead><tr>';
            tabBody += '<th class="row-sel-header" id="'+qid+'_mqsel_all_'+tabIdx+'" onclick="_qToggleSelAllMulti(\x27'+qid+'\x27,'+tabIdx+')" title="全选/取消全选">#</th>';
            cols.forEach(function(c){ tabBody += '<th>'+escapeHtml(c)+'</th>'; });
            tabBody += '</tr></thead><tbody>';
            for (var mi = 0; mi < mMax; mi++) {
                var mr = rows[mi];
                if (!mr) continue;
                var isSel = !!es._multiSelected[tabIdx][mi];
                var gripCls = isSel ? 'row-sel-grip selected' : 'row-sel-grip';
                var rowCls = isSel ? ' class="row-selected"' : '';
                tabBody += '<tr data-row-idx="'+mi+'"'+rowCls+'>';
                tabBody += '<td class="'+gripCls+'" data-ri="'+mi+'" ' +
                    'onclick="_qGripClickMulti(\x27'+qid+'\x27,'+tabIdx+',this,'+mi+')" ' +
                    'oncontextmenu="_qMultiRowCtx(\x27'+qid+'\x27,'+tabIdx+',event,'+mi+')" ' +
                    'title="左键选择行 | Shift多选 | 右键菜单">'+(mi+1)+'</td>';
                mr.forEach(function(mv,mci){
                    var mval = mv===null?'NULL':String(mv);
                    tabBody += '<td><input class="editable-cell" data-ri="'+mi+'" data-ci="'+mci+'" data-col="'+escapeAttr(cols[mci])+'" value="'+escapeAttr(mval)+'" onfocus="this._oldVal=this.value" onblur="_qCellBlurMulti(\x27'+qid+'\x27,'+tabIdx+','+mi+','+mci+',this)" spellcheck="false" autocomplete="off" style="min-width:60px;"></td>';
                });
                tabBody += '</tr>';
            }
            tabBody += '</tbody></table></div>';
        }
        // ★ 多结果分页：总数超过已加载行数时显示分页按钮
        var multiJid = es._multiJobIds[tabIdx];
        if (multiTotal > rows.length && multiJid) {
            tabBody += '<div id="' + qid + '_mpb_' + tabIdx + '" class="qr-pagbar" style="display:flex;align-items:center;gap:8px;padding:6px 8px;font-size:10px;">';
            tabBody += '<span>显示 <b>1</b>-<b>' + rows.length + '</b> 行，共 <b>' + multiTotal + '</b> 行</span>';
            tabBody += '<button class="btn btn-sm" onclick="_loadMultiAll(\''+qid+'\',' + tabIdx + ',' + multiTotal + ')" style="background:#27ae60;color:#fff;font-size:9px;">显示全部(' + multiTotal + '行)</button>';
            tabBody += '</div>';
        }
    } else {
        tabBody = '<div style="padding:12px;color:#888;">查询成功，无结果集</div>';
    }
    pane.innerHTML = tabBody;
    if (needVTM) { _vtRenderBodyM(qid, tabIdx); }
}

/** 渲染可编辑表格（从已有状态） */
function _qRenderTable(qid) {
    var es = _qState(qid);
    var div = document.getElementById('qr_' + qid);
    if (!div || !es.columns.length) return;
    var rc = es._totalRows || es.rows.length;
    var html = '';
    html += '<div class="qr-action-bar" style="display:flex;align-items:center;gap:6px;padding:6px 8px;flex-wrap:wrap;">' +
        '<button class="btn btn-sm" id="'+qid+'_qsave_btn" onclick="_qDoSave(\''+qid+'\')" disabled style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存 (0)</button>' +
        '<button class="btn btn-sm" id="'+qid+'_qcancel_btn" onclick="_qCancelEdit(\''+qid+'\')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">↩ 取消修改</button>' +
        '<span style="flex:1;"></span>' +
        '<button class="btn btn-sm" id="'+qid+'_qdel_btn" onclick="_qDoDelete(\''+qid+'\')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">🗑 删除 (0)</button>' +
        '<button class="btn btn-sm" onclick="_qExportResult(\''+qid+'\')" style="background:#27ae60;color:#fff;font-size:10px;">📥 导出</button>' +
        '<span class="qr-tip" style="font-size:10px;">双击单元格编辑 | 选中行可删除</span></div>';
    html += '<div class="qr-stats-bar" style="padding:6px 12px;font-size:11px;">📊 查询结果 — ' + rc + ' 行'+_fmtExecTimeHtml(es._lastResult)+'</div>';

    // ★ 超过500行启用虚拟滚动：只渲染屏幕上可见的30-50行DOM，滚动流畅不卡死
    var maxShow = Math.min(es.rows.length, es._showRowCount || 200);
    var needVT = (maxShow > _VT_THRESHOLD);
    var ROW_H = _VT_ROW_H;

    if (needVT) {
        // ----- 虚拟滚动模式 -----
        html += '<div id="'+qid+'_vtwrap" style="overflow-y:auto;flex:1;min-height:0;" onscroll="_vtOnScroll(\x27'+qid+'\x27)">';
        html += '<table id="'+qid+'_vttable" class="exp-table" style="width:100%;">';
        html += '<thead style="position:sticky;top:0;z-index:2;background:#1a1a2e;"><tr>';
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
        html += '</tr></thead>';
        html += '<tbody id="'+qid+'_vtbody"></tbody>';
        html += '</table></div>';
    } else {
        // ----- 普通渲染模式（≤500行）-----
        html += '<div style="overflow:auto;flex:1;min-height:0;"><table class="exp-table"><thead><tr>';
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
        for (var i = 0; i < maxShow; i++) {
            var row = es.rows[i];
            if (!row) continue;
            var isSel = !!es.selectedRows[i];
            var gripCls = isSel ? 'row-sel-grip selected' : 'row-sel-grip';
            var rowCls = isSel ? ' class="row-selected"' : '';
            html += '<tr data-row-idx="'+i+'"'+rowCls+'>';
            html += '<td class="'+gripCls+'" data-ri="'+i+'" ' +
                'onclick="_qGripClick(\x27'+qid+'\x27,this,'+i+')" ' +
                'oncontextmenu="_qRowCtx(\x27'+qid+'\x27,event,'+i+')" ' +
                'title="左键选择行 | Shift多选 | 右键菜单">'+(i+1)+'</td>';
            row.forEach(function(v, ci){
                var changedCell = es.changedCells[i + ':' + ci];
                var val = changedCell ? String(changedCell.newVal) : (v===null ? 'NULL' : String(v));
                html += '<td><input class="editable-cell" data-ri="'+i+'" data-ci="'+ci+'" data-col="'+escapeAttr(es.columns[ci])+'" value="'+escapeAttr(val)+'" onfocus="this._oldVal=this.value" onblur="_qCellBlur(\x27'+qid+'\x27,'+i+','+ci+',\x27'+escapeAttr(es.columns[ci])+'\x27,this)" spellcheck="false" autocomplete="off"></td>';
            });
            html += '</tr>';
        }
        html += '</tbody></table></div>';
    }

    // 行数控制栏
    if ((es._totalRows > 0 || es.rows.length > 0) && es.columns.length > 0) {
        html += _renderRowControls(qid);
    }
    div.innerHTML = html;
    // ★ 虚拟滚动模式下，用 JS 渲染初始可见行
    if (needVT) { _vtRenderBody(qid); }
    _qUpdateBtns(qid);
    _syncQueryContent(qid);
    // ★ 初始化列宽拖动
    setTimeout(function(){ _initResultColResize(div, qid); }, 50);
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

    // ★ 保存本次实际执行的 SQL 语句数组，供 _qRefreshData 刷新时复用
    es._executedStmts = stmtsArr || [];
    // ★ 清除"刚执行"标记（结果已到达，允许渲染）
    es._execJustStarted = false;

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
            es._lastResult = r0;
            // 行数元数据（后端返回首屏200行，其余按需加载）
            es._jobId = r0._job_id || null;
            es._totalRows = r0.total || 0;
            es._showRowCount = Math.min(r0.page_size || 200, r0.total || 0);
            es._loadingAll = false;
            es._cancelLoadAll = false;
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
                html += '<div class="qr-action-bar" style="display:flex;align-items:center;gap:6px;padding:6px 8px;flex-wrap:wrap;">' +
                    '<button class="btn btn-sm" id="'+qid+'_qsave_btn" onclick="_qDoSave(\''+qid+'\')" disabled style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存 (0)</button>' +
                    '<button class="btn btn-sm" id="'+qid+'_qcancel_btn" onclick="_qCancelEdit(\''+qid+'\')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">↩ 取消修改</button>' +
                    '<span style="flex:1;"></span>' +
                    '<button class="btn btn-sm" id="'+qid+'_qdel_btn" onclick="_qDoDelete(\''+qid+'\')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">🗑 删除 (0)</button>' +
                    '<button class="btn btn-sm" onclick="_qExportResult(\''+qid+'\')" style="background:#27ae60;color:#fff;font-size:10px;">📥 导出</button>' +
                    '<span class="qr-tip" style="font-size:10px;">双击单元格编辑 | 选中行可删除</span></div>';
                html += '<div class="qr-stats-bar" style="padding:6px 12px;font-size:11px;">📊 查询结果 — '+rc+' 行'+_fmtExecTimeHtml(r0)+'</div>';
                html += '<div style="overflow:auto;flex:1;min-height:0;"><table class="exp-table"><thead><tr>';
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
                // 行数控制栏
                if ((es._totalRows > 0 || es.rows.length > 0) && es.columns.length > 0) {
                    html += _renderRowControls(qid);
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
                    html += '<div style="padding:12px;color:#2ecc71;font-size:12px;">✅ '+opType+'成功，影响 <b>'+affRows+'</b> 行'+_fmtExecTimeHtml(r0)+'</div>';
                } else {
                    var msg = (r0 && r0.msg) ? r0.msg : '执行成功，无返回结果集';
                    html += '<div style="padding:12px;color:#2ecc71;font-size:12px;">✅ '+escapeHtml(msg)+_fmtExecTimeHtml(r0)+'</div>';
                }
            }
        }
        div.innerHTML = html || '<div style="padding:20px;color:#666;text-align:center;">无结果</div>';
        _qUpdateBtns(qid);
        // ★ Issue 4: 同步内容到 objectTabs，切换 tab 后保留
        setTimeout(function(){ _syncQueryContent(qid); }, 50);
        // ★ 初始化列宽拖动
        if (es.columns && es.columns.length > 0) {
            setTimeout(function(){ _initResultColResize(div, qid); }, 80);
        }
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
            // ★ 多结果 tab 标签也显示执行计时（详细分解）
            count += _fmtExecTimeHtml(rr).replace(' <span style="color:#5dade2;">', ' ').replace('</span>', '');
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
    es._multiResults = new Array(results.length);  // ★ 保存每条 SQL 的完整结果（含详细计时、has_more）
    es._multiJobIds = new Array(results.length);   // ★ 每条 SQL 的 _job_id（供分页）
    es._multiTotalRows = new Array(results.length); // ★ 每条 SQL 的总行数
    for (var im = 0; im < results.length; im++) {
        es._multiChanged[im] = {};
        es._multiSelected[im] = {};
        es._multiLastClicked[im] = -1;
        es._multiTableNames[im] = detectTableFromSql((stmtsArr||[])[im]||'');
        es._multiResults[im] = results[im] || null;  // ★ 保存完整结果对象
        es._multiJobIds[im] = (results[im] && results[im]._job_id) || null;
        es._multiTotalRows[im] = (results[im] && results[im].total) || 0;
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
                tabBody = '<div class="qr-action-bar" style="display:flex;align-items:center;gap:6px;padding:6px 8px;flex-wrap:wrap;">' +
                    '<button class="btn btn-sm" id="'+qid+'_mqsave_'+i2+'" onclick="_qDoSaveMulti(\''+qid+'\','+i2+')" disabled style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存 (0)</button>' +
                    '<button class="btn btn-sm" id="'+qid+'_mqcancel_'+i2+'" onclick="_qCancelEditMulti(\''+qid+'\','+i2+')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">↩ 取消修改</button>' +
                    '<span style="flex:1;"></span>' +
                    '<button class="btn btn-sm" id="'+qid+'_mqdel_'+i2+'" onclick="_qDoDeleteMulti(\''+qid+'\','+i2+')" disabled style="background:#e74c3c;color:#fff;font-size:10px;">🗑 删除 (0)</button>' +
                    '<button class="btn btn-sm" onclick="_qExportResult(\''+qid+'\','+i2+')" style="background:#27ae60;color:#fff;font-size:10px;">📥 导出</button>' +
                    '<span class="qr-tip" style="font-size:10px;">双击单元格编辑 | 选中行可删除</span></div>';
                tabBody += '<div class="qr-stats-bar" style="padding:6px 12px;font-size:11px;">📊 查询结果 — '+rows2.length+' 行'+_fmtExecTimeHtml(r2)+'</div>';
                tabBody += '<div style="overflow:auto;flex:1;min-height:0;"><table class="exp-table"><thead><tr>';
                tabBody += '<th class="row-sel-header" id="'+qid+'_mqsel_all_'+i2+'" onclick="_qToggleSelAllMulti(\''+qid+'\','+i2+')" title="全选/取消全选">#</th>';
                cols2.forEach(function(c){ tabBody += '<th>'+escapeHtml(c)+'</th>'; });
                tabBody += '</tr></thead><tbody>';
                var mMax = Math.min(rows2.length, es._showRowCount || 200);
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
                        var mChangedCell = (es._multiChanged[i2] || {})[mi + ':' + mci];
                        var mval = mChangedCell ? String(mChangedCell.newVal) : (mv===null?'NULL':String(mv));
                        tabBody += '<td><input class="editable-cell" data-ri="'+mi+'" data-ci="'+mci+'" data-col="'+escapeAttr(cols2[mci])+'" value="'+escapeAttr(mval)+'" onfocus="this._oldVal=this.value" onblur="_qCellBlurMulti(\''+qid+'\','+i2+','+mi+','+mci+',this)" spellcheck="false" autocomplete="off" style="min-width:60px;"></td>';
                    });
                    tabBody += '</tr>';
                }
                tabBody += '</tbody></table></div>';
                // ★ 多结果分页：总数超过已显示行数时显示分页按钮
                var multiTotal = es._multiTotalRows[i2] || rows2.length;
                var multiJid = es._multiJobIds[i2];
                if (multiTotal > rows2.length && multiJid) {
                    tabBody += '<div class="qr-pagbar" style="display:flex;align-items:center;gap:8px;padding:6px 8px;font-size:10px;">';
                    tabBody += '<span>显示 <b>1</b>-<b>' + rows2.length + '</b> 行，共 <b>' + multiTotal + '</b> 行</span>';
                    tabBody += '<button class="btn btn-sm" onclick="_loadMultiAll(\''+qid+'\',' + i2 + ',' + multiTotal + ')" style="background:#27ae60;color:#fff;font-size:9px;">显示全部(' + multiTotal + '行)</button>';
                    tabBody += '</div>';
                }
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
                    tabBody = '<div style="padding:12px;color:#2ecc71;">✅ '+opType2+'成功，影响 <b>'+rc2+'</b> 行'+_fmtExecTimeHtml(r2)+'</div>';
                } else {
                    tabBody = '<div style="padding:12px;color:#2ecc71;">✅ '+escapeHtml(r2.msg||'执行成功')+_fmtExecTimeHtml(r2)+'</div>';
                }
            }
        }
        html += '<div class="result-tab-pane'+(i2===0?' active':'')+'" data-ri="'+i2+'">'+tabBody+'</div>';
    }
    html += '</div></div>';
    div.innerHTML = html;
    // 多结果也同步
    setTimeout(function(){ _syncQueryContent(qid); }, 50);
    // ★ 为每个结果 tab 初始化列宽拖动
    setTimeout(function() {
        var panes = div.querySelectorAll('.result-tab-pane');
        panes.forEach(function(pane, pidx) {
            _initResultColResize(pane, qid, pidx);
        });
    }, 80);

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

/** 多结果分页：加载下一页 */
function _loadMultiPage(qid, tabIdx, offset, limit) {
    var es = _qState(qid);
    var jid = es._multiJobIds[tabIdx];
    if (!jid) return;
    var loaded = es._multiRows[tabIdx].length;
    eel.get_query_page(jid, loaded, limit)(function(r) {
        if (r && r.ok) {
            var existing = es._multiRows[tabIdx];
            for (var i = 0; i < r.rows.length; i++) {
                if (loaded + i >= existing.length) {
                    existing[loaded + i] = r.rows[i];
                }
            }
            _qRebuildSingleTab(qid, tabIdx);
        }
    });
}

/** 多结果分批拉取（用于显示全部，支持取消，防卡死） */
function _multiFetchBatch(qid, tabIdx, offset) {
    var es = _qState(qid);
    var jid = es._multiJobIds[tabIdx];
    if (!jid) return;
    if (es._cancelLoadAll) { _qRebuildSingleTab(qid, tabIdx); return; }
    var total = es._multiTotalRows[tabIdx] || 0;
    var BATCH = 500;
    var pagBar = document.getElementById(qid + '_mpb_' + tabIdx);
    if (pagBar) {
        pagBar.innerHTML = '<span style="color:#f39c12;">正在加载全部 ' + offset + '/' + total + ' 行...</span>' +
            '<button class="btn btn-sm" onclick="_cancelShowAll(\x27' + qid + '\x27)" style="background:#e74c3c;color:#fff;font-size:9px;cursor:pointer;">取消</button>';
    }

    eel.get_query_page(jid, offset, BATCH)(function(r) {
        if (es._cancelLoadAll) { _qRebuildSingleTab(qid, tabIdx); return; }
        if (r && r.ok) {
            var existing = es._multiRows[tabIdx];
            for (var i = 0; i < r.rows.length; i++) {
                if (offset + i >= existing.length) {
                    existing[offset + i] = r.rows[i];
                }
            }
            if (r.page_end >= total || offset + BATCH >= total) {
                es._loadingAll = false;
                _qRebuildSingleTab(qid, tabIdx);
            } else {
                setTimeout(function() { _multiFetchBatch(qid, tabIdx, offset + BATCH); }, 30);
            }
        } else {
            if (pagBar) pagBar.innerHTML = '<span style="color:#e74c3c;">加载失败: ' + (r ? r.msg : '无响应') + '</span>';
            es._loadingAll = false;
        }
    });
}

/** 多结果显示全部（分批加载，支持取消） */
function _loadMultiAll(qid, tabIdx, total) {
    var es = _qState(qid);
    var jid = es._multiJobIds[tabIdx];
    if (!jid) return;
    es._loadingAll = true;
    es._cancelLoadAll = false;
    var loaded = es._multiRows[tabIdx].length;
    _multiFetchBatch(qid, tabIdx, loaded);
}

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
            '<div class="confirm-sql-preview">' + escapeHtml(r.sql||'') + '</div>' +
            '<div class="confirm-sql-count">共 ' + r.count + ' 处修改</div>',
            function() {
                // ★ 执行中：hover 变为取消执行，点击 Kill 数据库会话
                _qSaveBtnRunning(btn, qid);
                eel.table_exec_save(es.connData, es.execDb, tableName, '', changes)(function(r2){
                    _qSaveBtnReset(btn, qid);
                    if (r2 && r2.cancelled) {
                        showWarnDialog('已取消', '操作已被取消');
                        return;
                    }
                    if (!r2 || !r2.ok) {
                        showWarnDialog('保存失败', r2 ? r2.msg : '无响应');
                        return;
                    }
                    // ★ 保存成功不弹窗，直接刷新数据
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
            '<div class="confirm-sql-preview">' + escapeHtml(r.sql||'') + '</div>' +
            '<div class="confirm-sql-warn">⚠ 将删除 ' + r.count + ' 行数据</div>',
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
    if (cat === 'tables') _eelAutoAsync(eel.db_explore_get_tables(conn,db,sch), function(r){callback(r&&r.ok?(r.tables||[]):[]);});
    else if (cat === 'views') eel.db_explore_get_views(conn,db,sch)(function(r){callback(r&&r.ok?(r.views||[]).map(function(v){return{name:v};}):[]);});
    else if (cat === 'procedures') eel.db_explore_get_procedures(conn,db,sch)(function(r){callback(r&&r.ok?(r.procedures||[]).filter(function(p){return p.type==='PROCEDURE';}):[]);});
    else if (cat === 'functions') eel.db_explore_get_procedures(conn,db,sch)(function(r){callback(r&&r.ok?(r.procedures||[]).filter(function(p){return p.type==='FUNCTION';}):[]);});
    else if (cat === 'triggers') eel.db_explore_get_triggers(conn,db,sch)(function(r){callback(r&&r.ok?(r.triggers||[]):[]);});
    else if (cat === 'indexes'||cat==='sequences'||cat==='synonyms'||cat==='packages'||cat==='mviews') eel.db_explore_get_objlist(conn,db,cat,sch)(function(r){callback(r&&r.ok?(r.items||[]):[]);});
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
    eel.tree_list_queries(cid, db)(function(queries) {
        callback((queries || []).map(function(q){return{name:q.name,id:q.id};}));
    });
}

function toggleDbChildren(dbId, arrowId) {
    var el = document.getElementById(dbId);
    var ar = document.getElementById(arrowId);
    if (!el) return;
    if (el.classList.contains('open')) {
        el.classList.remove('open');
        if (ar) { ar.textContent = '▸'; }
        // ★ 折叠时清除数据库行高亮，恢复图标为关闭状态
        var dbRow = el.previousElementSibling;
        if (dbRow) { dbRow.classList.remove('tree-highlight'); }
        var iconEl = dbRow ? dbRow.querySelector('.db-icon') : null;
        if (iconEl) { iconEl.classList.remove('active'); iconEl.classList.add('closed'); }
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
        // ★ 折叠时清除连接行高亮，恢复图标为关闭状态
        var connRow = arrow ? arrow.parentElement : null;
        if (connRow) { connRow.classList.remove('tree-highlight'); }
        var iconEl = connRow ? connRow.querySelector('.db-icon') : null;
        if (iconEl) { iconEl.classList.remove('active'); iconEl.classList.add('closed'); }
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

// ==================== 查询结果搜索 (Ctrl+F) ====================
var _qSearchStates = {}; // qid → { matches:[], currentIdx:int, query:string, tabIdx:int|null }

// 全局 Ctrl+F / Escape 键盘处理
(function() {
    document.addEventListener('keydown', function(e) {
        // Ctrl+F 打开搜索
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            var el = document.activeElement;
            // 判断焦点是否在查询结果区域内或其子元素中
            var qid = _qSearchFindQid(el);
            if (qid) {
                e.preventDefault();
                _qSearchToggle(qid);
            }
        }
        // Escape 关闭搜索栏
        if (e.key === 'Escape') {
            var activeBar = document.querySelector('.query-search-bar.active');
            if (activeBar) {
                var qrWrap = activeBar.closest('.query-results-wrap');
                if (qrWrap && qrWrap.id) {
                    _qSearchClose(qrWrap.id.replace(/^qr_/, ''));
                }
            }
        }
    });
})();

/** 从元素向上查找所属的查询结果 qid */
function _qSearchFindQid(el) {
    while (el) {
        if (el.classList && el.classList.contains('query-results-wrap') && el.id && el.id.indexOf('qr_') === 0) {
            return el.id.replace(/^qr_/, '');
        }
        if (el.classList && el.classList.contains('result-tab-pane') && el.classList.contains('active')) {
            var wrap = el.closest('.query-results-wrap');
            if (wrap && wrap.id && wrap.id.indexOf('qr_') === 0) return wrap.id.replace(/^qr_/, '');
        }
        el = el.parentElement;
    }
    return null;
}

/** 打开/切换搜索栏 */
function _qSearchToggle(qid) {
    var qrWrap = document.getElementById('qr_' + qid);
    if (!qrWrap) return;

    // 如果已有搜索栏，只是切换显示/聚焦
    var existingBar = qrWrap.querySelector('.query-search-bar');
    if (existingBar) {
        if (existingBar.classList.contains('active')) {
            // 已显示：全选搜索词
            var input = existingBar.querySelector('input');
            if (input) { input.focus(); input.select(); }
            return;
        } else {
            existingBar.classList.add('active');
            var input2 = existingBar.querySelector('input');
            if (input2) { input2.focus(); input2.select(); }
            return;
        }
    }

    // 新建搜索栏
    _qSearchBuild(qid, qrWrap);
}

/** 构建并插入搜索栏 */
function _qSearchBuild(qid, qrWrap) {
    var bar = document.createElement('div');
    bar.className = 'query-search-bar active';
    bar.innerHTML =
        '<span style="color:#5dade2;font-size:11px;flex-shrink:0;">🔍</span>' +
        '<input type="text" class="query-search-input" placeholder="模糊搜索所有字段 (Enter/Shift+Enter导航)" ' +
        'oninput="_qSearchDo(\'' + qid + '\',this.value)" ' +
        'onkeydown="_qSearchKey(\'' + qid + '\',event)">' +
        '<span class="query-search-count" id="' + qid + '_scount"></span>' +
        '<button class="query-search-btn" onclick="_qSearchNav(\'' + qid + '\',-1)" title="上一个 (Shift+Enter)">▲</button>' +
        '<button class="query-search-btn" onclick="_qSearchNav(\'' + qid + '\',1)" title="下一个 (Enter)">▼</button>' +
        '<button class="query-search-btn" onclick="_qSearchClose(\'' + qid + '\')" title="关闭 (Esc)">✕</button>';

    // 插入到结果容器最前面
    var firstChild = qrWrap.firstChild;
    if (firstChild) {
        qrWrap.insertBefore(bar, firstChild);
    } else {
        qrWrap.appendChild(bar);
    }

    _qSearchStates[qid] = { matches: [], currentIdx: -1, query: '', tabIdx: null };
    setTimeout(function() {
        var inp = bar.querySelector('input');
        if (inp) inp.focus();
    }, 50);
}

/** 执行搜索 */
function _qSearchDo(qid, query) {
    var state = _qSearchStates[qid];
    if (!state) { state = { matches: [], currentIdx: -1, query: '', tabIdx: null }; _qSearchStates[qid] = state; }

    // 清除之前的高亮和结果
    _qClearHighlights(qid);
    state.matches = [];
    state.currentIdx = -1;
    state.query = query;

    var countEl = document.getElementById(qid + '_scount');

    if (!query || !query.trim()) {
        if (countEl) countEl.textContent = '';
        return;
    }

    var q = query.toLowerCase().trim();
    var es = _qState(qid);
    if (!es) { if (countEl) countEl.textContent = '无结果'; return; }

    // 判断场景：单结果 or 多Tab结果
    var hasMultiTabs = !!(es._multiRows && es._multiRows.length > 0);

    if (hasMultiTabs) {
        // 多tab：搜索当前激活的 tab
        var qrWrap = document.getElementById('qr_' + qid);
        if (!qrWrap) { if (countEl) countEl.textContent = '无结果'; return; }
        var activePane = qrWrap.querySelector('.result-tab-pane.active') ||
                         qrWrap.querySelector('.result-tab-pane');
        var tabIdx = activePane ? parseInt(activePane.getAttribute('data-ri')) : 0;
        if (isNaN(tabIdx)) tabIdx = 0;
        state.tabIdx = tabIdx;
        var rows = (es._multiRows || [])[tabIdx];
        if (rows && rows.length > 0) {
            for (var i = 0; i < rows.length; i++) {
                var cols = _qRowMatchesCols(rows[i], q);
                if (cols.length > 0) {
                    state.matches.push({ row: i, tab: tabIdx, cols: cols });
                }
            }
        }
    } else if (es.rows && es.rows.length > 0) {
        // 单结果
        state.tabIdx = undefined;
        for (var j = 0; j < es.rows.length; j++) {
            var cols = _qRowMatchesCols(es.rows[j], q);
            if (cols.length > 0) {
                state.matches.push({ row: j, cols: cols });
            }
        }
    }

    if (countEl) {
        if (state.matches.length > 0) {
            state.currentIdx = 0;
            countEl.textContent = '1/' + state.matches.length;
            _qScrollToMatch(qid, 0);
        } else {
            countEl.textContent = '无结果';
        }
    }
}

/** 检查一行数据中哪些字段包含搜索词，返回匹配的列索引数组 */
function _qRowMatchesCols(row, queryLower) {
    if (!row) return [];
    var cols = [];
    for (var k = 0; k < row.length; k++) {
        var val = row[k];
        if (val === null || val === undefined) {
            if ('null'.indexOf(queryLower) !== -1) cols.push(k);
            continue;
        }
        if (String(val).toLowerCase().indexOf(queryLower) !== -1) cols.push(k);
    }
    return cols;
}

/** 搜索框键盘事件 */
function _qSearchKey(qid, e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        _qSearchNav(qid, e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        _qSearchClose(qid);
    }
}

/** 上下导航匹配结果 */
function _qSearchNav(qid, direction) {
    var state = _qSearchStates[qid];
    if (!state || state.matches.length === 0) return;
    var count = state.matches.length;
    state.currentIdx = ((state.currentIdx + direction) % count + count) % count;
    var countEl = document.getElementById(qid + '_scount');
    if (countEl) countEl.textContent = (state.currentIdx + 1) + '/' + count;
    _qScrollToMatch(qid, state.currentIdx);
}

/** 滚动到匹配行并高亮匹配的单元格 */
function _qScrollToMatch(qid, matchIdx) {
    var state = _qSearchStates[qid];
    if (!state || matchIdx < 0 || matchIdx >= state.matches.length) return;
    var match = state.matches[matchIdx];

    _qClearHighlights(qid);

    var qrWrap = document.getElementById('qr_' + qid);
    if (!qrWrap) return;

    var es = _qState(qid);
    if (!es) return;

    var rowIdx = match.row;
    var tabIdx = match.tab;
    var cols = match.cols || [];

    // 多结果：确保正确的 tab 处于激活状态
    if (tabIdx !== undefined) {
        var tabsCt = qrWrap.querySelector('.result-tabs');
        if (tabsCt && tabsCt.id && typeof switchResultTab === 'function') {
            var tabPane = qrWrap.querySelector('.result-tab-pane[data-ri="' + tabIdx + '"]');
            if (tabPane && !tabPane.classList.contains('active')) {
                switchResultTab(tabsCt.id, tabIdx);
            }
        }
    }

    _qFindAndScroll(qid, rowIdx, tabIdx, cols);

    // 延迟高亮（等待虚拟滚动渲染完成）
    setTimeout(function() { _qHighlightCells(qid, rowIdx, cols); }, 150);
    setTimeout(function() { _qHighlightCells(qid, rowIdx, cols); }, 350);
}

/** 滚动到指定行（并水平定位到匹配的列） */
function _qFindAndScroll(qid, rowIdx, tabIdx, colIndices) {
    var qrWrap = document.getElementById('qr_' + qid);
    if (!qrWrap) return;

    // ★ 优先用 ID 查找滚动容器（虚拟滚动模式有明确 ID）
    var scrollContainer = null;
    var isVT = false;

    if (tabIdx !== undefined) {
        // 多 tab：先找虚拟滚动容器 {qid}_mvt{tabIdx}
        var vtId = qid + '_mvt' + tabIdx;
        var vtEl = document.getElementById(vtId);
        if (vtEl) {
            scrollContainer = vtEl;
            isVT = true;
        } else {
            // 多 tab 普通模式：在对应 pane 内找 .exp-table 的父级 div
            var pane = qrWrap.querySelector('.result-tab-pane[data-ri="' + tabIdx + '"]');
            if (pane) {
                var tbl = pane.querySelector('table.exp-table');
                if (tbl && tbl.parentElement) scrollContainer = tbl.parentElement;
            }
        }
    } else {
        // 单结果：先找虚拟滚动容器 {qid}_vtwrap
        var vtWrap = document.getElementById(qid + '_vtwrap');
        if (vtWrap) {
            scrollContainer = vtWrap;
            isVT = true;
        } else {
            // 单结果普通模式：找 .exp-table 的父级 div
            var tbl2 = qrWrap.querySelector('table.exp-table');
            if (tbl2 && tbl2.parentElement) scrollContainer = tbl2.parentElement;
        }
    }

    if (!scrollContainer) return;

    if (isVT) {
        // 虚拟滚动：直接设置 scrollTop，让目标行出现在可视区域中部
        var targetScroll = rowIdx * _VT_ROW_H - Math.floor(scrollContainer.clientHeight / 3);
        if (targetScroll < 0) targetScroll = 0;
        scrollContainer.scrollTop = targetScroll;

        // 触发虚拟滚动重渲染
        setTimeout(function() {
            if (tabIdx !== undefined) {
                if (typeof _vtRenderBodyM === 'function') _vtRenderBodyM(qid, tabIdx);
            } else {
                if (typeof _vtRenderBody === 'function') _vtRenderBody(qid);
            }
            // ★ 渲染完成后水平定位到匹配列
            _qScrollToCellHorizontally(scrollContainer, rowIdx, colIndices);
        }, 60);
    } else {
        // 普通模式：手动计算 scrollTop，避免 scrollIntoView 影响外层布局
        var table = scrollContainer.querySelector('table.exp-table');
        if (!table) return;
        var tr = table.querySelector('tr[data-row-idx="' + rowIdx + '"]');
        if (!tr) return;
        // ★ 计算行相对于滚动容器的偏移
        var rowTop = tr.offsetTop;
        // offsetTop 是相对于 offsetParent，需要累加到 table 顶部
        var tableTop = table.offsetTop;
        var targetTop = tableTop + rowTop;
        var viewTop = scrollContainer.scrollTop;
        var viewH = scrollContainer.clientHeight;
        var viewBottom = viewTop + viewH;
        var rowH = tr.offsetHeight || 28;

        if (targetTop < viewTop) {
            // 行在可视区域上方 → 滚到该行顶部（留一点边距）
            scrollContainer.scrollTop = Math.max(0, targetTop - 10);
        } else if (targetTop + rowH > viewBottom) {
            // 行在可视区域下方 → 滚到该行底部可见
            scrollContainer.scrollTop = targetTop + rowH - viewH + 10;
        }
        // 行已在可视区域内则不滚动
        // ★ 水平定位到匹配列
        _qScrollToCellHorizontally(scrollContainer, rowIdx, colIndices);
    }
}

/** 水平滚动使匹配的单元格可见 */
function _qScrollToCellHorizontally(scrollContainer, rowIdx, colIndices) {
    if (!scrollContainer || !colIndices || !colIndices.length) return;
    var table = scrollContainer.querySelector('table.exp-table');
    if (!table) return;
    var tr = table.querySelector('tr[data-row-idx="' + rowIdx + '"]');
    if (!tr) return;
    var tds = tr.querySelectorAll('td');
    if (!tds.length) return;

    // 找第一个匹配列的实际 td（tds[0] 是行号列，数据列 +1）
    var firstColIdx = colIndices[0];
    var td = tds[firstColIdx + 1];
    if (!td) {
        // 列索引可能越界，尝试用最小的有效索引
        for (var k = 0; k < colIndices.length; k++) {
            if (tds[colIndices[k] + 1]) { td = tds[colIndices[k] + 1]; break; }
        }
    }
    if (!td) return;

    var cellLeft = td.offsetLeft;
    var cellRight = cellLeft + td.offsetWidth;
    var viewLeft = scrollContainer.scrollLeft;
    var viewW = scrollContainer.clientWidth;
    var viewRight = viewLeft + viewW;

    if (cellLeft < viewLeft) {
        // 单元格在可视区域左侧 → 滚到该单元格左侧可见（留 20px 边距）
        scrollContainer.scrollLeft = Math.max(0, cellLeft - 20);
    } else if (cellRight > viewRight) {
        // 单元格在可视区域右侧 → 滚到该单元格右侧可见（留 20px 边距）
        scrollContainer.scrollLeft = cellRight - viewW + 20;
    }
    // 单元格已在可视区域内则不滚动
}

/** 高亮指定行中匹配的单元格（不是整行） */
function _qHighlightCells(qid, rowIdx, colIndices) {
    var qrWrap = document.getElementById('qr_' + qid);
    if (!qrWrap) return;
    var rows = qrWrap.querySelectorAll('tr[data-row-idx="' + rowIdx + '"]');
    rows.forEach(function(r) {
        var tds = r.querySelectorAll('td');
        // ★ DOM 中 tds[0] 是行号列，数据列从 tds[1] 开始，所以 +1
        colIndices.forEach(function(ci) {
            if (tds[ci + 1]) tds[ci + 1].classList.add('search-highlight');
        });
    });
}

/** 清除所有高亮（行 + 单元格） */
function _qClearHighlights(qid) {
    var qrWrap = document.getElementById('qr_' + qid);
    if (!qrWrap) return;
    qrWrap.querySelectorAll('.search-highlight').forEach(function(r) {
        r.classList.remove('search-highlight');
    });
}

/** 关闭搜索栏 */
function _qSearchClose(qid) {
    var bar = document.querySelector('#qr_' + qid + ' > .query-search-bar');
    if (bar) {
        bar.classList.remove('active');
        // 也可移除 DOM
        setTimeout(function() { if (bar.parentNode) bar.remove(); }, 100);
    }
    _qClearHighlights(qid);
    delete _qSearchStates[qid];
}

// ==================== 列宽拖动调整 ====================
var _colResizeState = null;  // { th, startX, startW, table, nextTh, ... }
var _colResizeRAF = null;    // requestAnimationFrame ID，用于节流
var _colResizeDx = 0;        // 最新鼠标偏移量（mousemove 高速更新，RAF 消费）

/** 为结果表格初始化列宽拖动手柄 */
function _initResultColResize(containerEl, qid, tabIdx) {
    if (!containerEl) return;
    var table = containerEl.querySelector('table.exp-table');
    if (!table) return;
    var thead = table.querySelector('thead');
    if (!thead) return;

    // 避免重复初始化
    if (thead.getAttribute('data-colresize') === '1') return;
    thead.setAttribute('data-colresize', '1');

    var ths = thead.querySelectorAll('tr:first-child th');
    ths.forEach(function(th, ci) {
        th.classList.add('col-resizable');
        // 创建拖动手柄
        var handle = document.createElement('div');
        handle.className = 'col-resize-handle';
        handle.setAttribute('data-ci', ci);
        handle.addEventListener('mousedown', function(e) {
            _colResizeStart(e, th, ci, qid, tabIdx, ths, table, thead);
        });
        th.appendChild(handle);
    });
}

function _colResizeStart(e, th, ci, qid, tabIdx, allThs, table, thead) {
    e.preventDefault();
    e.stopPropagation();

    var startX = e.clientX;

    var handleEl = e.target;
    handleEl.classList.add('dragging');
    th.classList.add('col-resize-active');

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    // ★ 关键：先保存 auto 布局下各列的真实宽度（在 fixed 之前获取，避免被 100% 缩放）
    var origWidths = [];
    allThs.forEach(function(t) {
        origWidths.push(t.getBoundingClientRect().width);
    });
    var startW = origWidths[ci];
    var nextTh = allThs[ci + 1] || null;
    var nextStartW = nextTh ? origWidths[ci + 1] : 0;

    // ★ 锁定 table 布局：设为 fixed 后，width: 100% 会强制缩放列宽，所以先设为 auto
    var origTableLayout = table.style.tableLayout;
    var origTableWidth = table.style.width;
    var origTableMinWidth = table.style.minWidth;
    table.style.tableLayout = 'fixed';
    table.style.width = 'auto';        // 覆盖 CSS 的 width: 100% / max-content
    table.style.minWidth = '0px';    // 覆盖 CSS 的 min-width: 100%，防止强制拉伸

    // 给所有列固定为原始 auto 布局下的真实宽度
    allThs.forEach(function(t, i) {
        t.style.width = origWidths[i] + 'px';
        t.style.minWidth = origWidths[i] + 'px';
    });

    _colResizeState = {
        th: th, ci: ci, startX: startX, startW: startW,
        nextTh: nextTh, nextStartW: nextStartW,
        allThs: allThs, table: table, qid: qid,
        tabIdx: tabIdx, handleEl: handleEl,
        minW: 40,
        origTableLayout: origTableLayout,
        origTableWidth: origTableWidth
    };
    _colResizeDx = 0;
}

// 全局 mousemove：只存最新偏移量，由 RAF 统一渲染（避免高频重排）
document.addEventListener('mousemove', function(_e) {
    if (!_colResizeState) return;
    _colResizeDx = _e.clientX - _colResizeState.startX;
    if (!_colResizeRAF) {
        _colResizeRAF = requestAnimationFrame(_doColResize);
    }
});

function _doColResize() {
    _colResizeRAF = null;
    var st = _colResizeState;
    if (!st) return;
    var dx = _colResizeDx;
    if (st.nextTh) {
        // 两列总宽恒定，各自不低于 minW
        var totalW = st.startW + st.nextStartW;
        var newW = Math.max(st.minW, Math.min(totalW - st.minW, st.startW + dx));
        st.th.style.width = newW + 'px';
        st.th.style.minWidth = newW + 'px';
        st.nextTh.style.width = (totalW - newW) + 'px';
        st.nextTh.style.minWidth = (totalW - newW) + 'px';
    } else {
        var newW2 = Math.max(st.minW, st.startW + dx);
        st.th.style.width = newW2 + 'px';
        st.th.style.minWidth = newW2 + 'px';
    }
}

document.addEventListener('mouseup', function(e) {
    var st = _colResizeState;
    if (!st) return;

    // 取消未处理的 RAF
    if (_colResizeRAF) { cancelAnimationFrame(_colResizeRAF); _colResizeRAF = null; }
    // 应用最后一次宽度
    _doColResize();

    // ★ 保持 table-layout: fixed，防止恢复 auto 后浏览器重新计算列宽导致后面的字段错位
    // （保留 origTableLayout 字段以备后续需要恢复时使用）

    // 虚拟滚动刷新
    if (st.qid) {
        setTimeout(function() {
            if (st.tabIdx !== undefined) {
                if (typeof _vtRenderBodyM === 'function') _vtRenderBodyM(st.qid, st.tabIdx);
            } else {
                if (typeof _vtRenderBody === 'function') _vtRenderBody(st.qid);
            }
        }, 30);
    }

    // 清理
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (st.handleEl) st.handleEl.classList.remove('dragging');
    if (st.th) st.th.classList.remove('col-resize-active');
    _colResizeState = null;
});

// ★ 移除 SQL 注释（-- 行注释 和 /* */ 块注释），保留字符串字面量
function _stripSqlComments(sql) {
    if (!sql) return '';
    var result = '', i = 0;
    while (i < sql.length) {
        var ch = sql[i];
        if (ch === "'") { result += ch; i++; while (i < sql.length) { result += sql[i]; if (sql[i] === "'") { if (i+1<sql.length && sql[i+1]==="'") { i+=2; result += "'"; continue; } i++; break; } i++; } continue; }
        if (ch === '"') { result += ch; i++; while (i<sql.length && sql[i]!=='"') { result += sql[i]; i++; } if (i<sql.length) { result += '"'; i++; } continue; }
        if (ch === '`') { result += ch; i++; while (i<sql.length && sql[i]!=='`') { result += sql[i]; i++; } if (i<sql.length) { result += '`'; i++; } continue; }
        if (ch === '[') { result += ch; i++; while (i<sql.length && sql[i]!==']') { result += sql[i]; i++; } if (i<sql.length) { result += ']'; i++; } continue; }
        if (ch === '-' && i+1<sql.length && sql[i+1]==='-') { i += 2; while (i<sql.length && sql[i]!=='\n') i++; if (i<sql.length) { result += '\n'; i++; } continue; }
        if (ch === '/' && i+1<sql.length && sql[i+1]==='*') { i += 2; while (i<sql.length && !(sql[i]==='*' && i+1<sql.length && sql[i+1]==='/')) i++; if (i<sql.length) i += 2; continue; }
        result += ch; i++;
    }
    return result.replace(/\n{3,}/g, '\n\n').trim();
}




