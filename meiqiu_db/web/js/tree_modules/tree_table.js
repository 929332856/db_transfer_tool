// ==================== 表操作 ====================
function tableCtx(e, tn, db, schema, cid) {
    e.preventDefault(); e.stopPropagation();
    var sch = schema || '';
    var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
    showCtxMenu(e.clientX, e.clientY, [
        {label:'📄 打开表',action:function(){addTableDataTab(tn,db,sch,cid);}},
        {label:'📄 查看DDL',action:function(){showTableDDLDialog(tn,db,sch,cid,conn);}},
        {label:'🔧 设计表',action:function(){addTableDDLTab(tn,db,sch,cid);}},
        {label:'✏️ 重命名',action:function(){showInputDialog('重命名表','新表名：',function(newName){if(!newName||!newName.trim()||newName.trim()===tn)return;eel.table_rename(conn,db,tn,newName.trim(),sch)(function(r){if(r&&r.ok){showOkDialog('成功',r.msg);setTimeout(function(){refreshTableFolder(cid,db,sch);},500);}else showErrorDialog('失败',r?r.msg:'');});},tn);}},
        '---',
        {label:'📤 导出向导',action:function(){showExportWizard(cid,db,sch,tn);}},
        {label:'💾 备份表',action:function(){var backupName=tn+'_'+(new Date().toISOString().slice(5,7)+new Date().toISOString().slice(8,10)+'_'+new Date().getHours());showConfirmDialog('备份表','将创建备份表 <b>['+backupName+']</b>？',function(){showModal('💾','正在备份表 <b>'+escapeHtml(tn)+'</b>','<div style="text-align:center;padding:20px 0;"><div style="font-size:28px;margin-bottom:10px;">⏳</div><div style="color:#aaa;font-size:12px;">正在执行 <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px;">CREATE TABLE ... LIKE ...</code><br>和 <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px;">INSERT INTO ... SELECT ...</code></div><div style="color:#666;font-size:10px;margin-top:12px;">大表备份可能耗时较长，请耐心等待...</div></div>','#e67e22','');eel.table_backup(conn,db,tn,sch)(function(r){if(r&&r.ok){document.getElementById('modal_title').innerHTML='✅ 备份完成';document.getElementById('modal_title').style.color='#27ae60';document.getElementById('modal_msg').innerHTML='<div style="text-align:center;padding:20px 0;"><div style="font-size:28px;margin-bottom:10px;">✅</div><div style="color:#ccc;font-size:14px;">'+escapeHtml(r.msg)+'</div></div>';document.getElementById('modal_btns').innerHTML='<button class="btn btn-green btn-sm" onclick="hideModal()">完成</button>';setTimeout(function(){refreshTableFolder(cid,db,sch);},500);}else{document.getElementById('modal_title').innerHTML='❌ 备份失败';document.getElementById('modal_title').style.color='#e74c3c';document.getElementById('modal_msg').innerHTML='<div style="text-align:center;padding:20px 0;"><div style="font-size:28px;margin-bottom:10px;">❌</div><div style="color:#e74c3c;">'+(r?escapeHtml(r.msg):'未知错误')+'</div></div>';document.getElementById('modal_btns').innerHTML='<button class="btn btn-gray btn-sm" onclick="hideModal()">关闭</button>';}});});}},
        '---',
        {label:'🗑 清空表',action:function(){showConfirmDialog('确认','清空表 ['+tn+']？',function(){eel.table_clear(conn,db,tn,sch)(function(r){showOkDialog(r&&r.ok?'成功':'失败',r?r.msg:'');});});}},
        {label:'✂️ 截断表',action:function(){showConfirmDialog('确认','截断表 ['+tn+']？',function(){eel.table_truncate(conn,db,tn,sch)(function(r){showOkDialog(r&&r.ok?'成功':'失败',r?r.msg:'');});});}},
        '---',
        {label:'❌ 删除表',action:function(){showConfirmDialog('危险','删除表 ['+tn+']？不可恢复！',function(){eel.table_delete(conn,db,tn,sch)(function(r){if(r&&r.ok){showOkDialog('成功',r.msg);setTimeout(function(){refreshTableFolder(cid,db,sch);},500);}else showErrorDialog('失败',r?r.msg:'');});});}}
    ]);
}

// ★ 表头右键菜单：复制字段名 / 类型 / 注释
function colHeaderCtx(e, colName, colType, colComment) {
    e.preventDefault(); e.stopPropagation();
    var items = [
        {label:'📋 复制字段名：' + colName, action:function(){ copyToClipboard(colName); }}
    ];
    if (colType) {
        items.push({label:'📋 复制字段类型：' + colType, action:function(){ copyToClipboard(colType); }});
    }
    if (colComment) {
        items.push({label:'📋 复制字段注释：' + colComment, action:function(){ copyToClipboard(colComment); }});
    }
    showCtxMenu(e.clientX, e.clientY, items);
}

// ==================== WHERE 条件评估器 ====================
function compileWhereFn(whereExpr, cols) {
    var expr = whereExpr.trim();
    if (!expr) return function() { return true; };
    var colMap = {};
    cols.forEach(function(c, i) { colMap[c.toLowerCase()] = i; });

    // 按 AND 拆分
    var parts = String(expr).split(/\s+AND\s+/i);

    return function(row) {
        for (var p = 0; p < parts.length; p++) {
            var cond = parts[p].trim();
            if (!cond) continue;
            if (!_evalCond(cond, row, colMap)) return false;
        }
        return true;
    };
}

function _evalCond(cond, row, colMap) {
    // IS NULL / IS NOT NULL
    var nm = cond.match(/^(.+?)\s+IS\s+(NOT\s+)?NULL$/i);
    if (nm) {
        var ci = colMap[nm[1].trim().toLowerCase()];
        if (ci === undefined) return true;
        return nm[2] ? row[ci] !== null : row[ci] === null;
    }
    // LIKE / NOT LIKE
    var lm = cond.match(/^(.+?)\s+(NOT\s+)?LIKE\s+(.+)$/i);
    if (lm) {
        var ci = colMap[lm[1].trim().toLowerCase()];
        if (ci === undefined) return true;
        var val = row[ci]; val = val === null || val === undefined ? '' : String(val);
        var pat = _unquote(lm[3].trim());
        pat = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
        var re = new RegExp('^' + pat + '$', 'i');
        return lm[2] ? !re.test(val) : re.test(val);
    }
    // = != <> >= <= > <
    var om = cond.match(/^(.+?)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)$/);
    if (om) {
        var ci = colMap[om[1].trim().toLowerCase()];
        if (ci === undefined) return true;
        var op = om[2];
        var lv = row[ci];
        var rv = _unquote(om[3].trim());
        if (/^['"]/.test(om[3].trim())) {
            // 字符串比较
            lv = lv === null || lv === undefined ? '' : String(lv);
            switch (op) { case '=': return lv === rv; case '!=': case '<>': return lv !== rv; default: return true; }
        } else if (rv.toLowerCase() === 'null') {
            switch (op) { case '=': return lv === null; case '!=': case '<>': return lv !== null; default: return true; }
        } else {
            rv = Number(rv); if (isNaN(rv)) return true;
            lv = lv === null || lv === undefined ? 0 : Number(lv); if (isNaN(lv)) lv = 0;
            switch (op) { case '=': return lv === rv; case '!=': case '<>': return lv !== rv; case '>': return lv > rv; case '<': return lv < rv; case '>=': return lv >= rv; case '<=': return lv <= rv; default: return true; }
        }
    }
    return true; // 无法解析，不筛选
}

function _unquote(s) { s = s.trim(); if ((s[0]==="'"&&s[s.length-1]==="'")||(s[0]==='"'&&s[s.length-1]==='"')) return s.slice(1,-1); return s; }

// 生成 WHERE 栏 HTML
function buildWhereBar(tid) {
    return '<div class="where-bar">' +
        '<span class="where-label">WHERE</span>' +
        '<input class="where-input" id="' + tid + '_where" placeholder="例: age > 18 AND name LIKE \'%张%\'（全表筛选）" onkeydown="if(event.key===\'Enter\')applyWhere(\'' + tid + '\')">' +
        '<button class="btn btn-sm" style="font-size:10px;padding:3px 10px;" onclick="applyWhere(\'' + tid + '\')">执行</button>' +
        '<button class="btn btn-sm" style="font-size:10px;padding:3px 8px;" onclick="clearWhere(\'' + tid + '\')">✕ 清除</button>' +
        '<span class="where-count" id="' + tid + '_count"></span>' +
        '</div>';
}

// 全局 WHERE 状态存储（tid -> {cols, rows, sortCol, sortDir, onRender}）
var _whereStates = {};
// tabId -> tid 映射（用于 renderObjectPanel 中 data tab 切换后重新渲染）
var _tabIdToTid = {};

function registerWhereState(tid, cols, rows, sortRef, onRender, colTypes) {
    _whereStates[tid] = { cols: cols, rows: rows, sortRef: sortRef, onRender: onRender, colTypes: colTypes || {} };
}
function getWhereState(tid) { return _whereStates[tid]; }

function applyWhere(tid) {
    var st = _whereStates[tid]; if (!st) return;
    var inp = document.getElementById(tid + '_where');
    var whereExpr = inp ? inp.value.trim() : '';
    st.whereExpr = whereExpr;
    // ★ 写入 window 全局，供 _serverReload 读取
    window['_activeWhereSql_'+tid] = whereExpr;
    // 清除列筛选缓存
    var clearColFn = window['_clearColFilters_'+tid];
    if (clearColFn) clearColFn();
    // 重置分页
    var resetPageFn = window['_resetPage_'+tid];
    if (resetPageFn) resetPageFn();
    // ★ 服务端筛选
    st.onRender();
}

function clearWhere(tid) {
    var inp = document.getElementById(tid + '_where');
    if (inp) inp.value = '';
    var st = _whereStates[tid]; if (!st) return;
    st.whereExpr = '';
    // ★ 清除 WHERE 条件
    window['_activeWhereSql_'+tid] = '';
    // 清除列筛选缓存
    var clearColFn = window['_clearColFilters_'+tid];
    if (clearColFn) clearColFn();
    var resetPageFn = window['_resetPage_'+tid];
    if (resetPageFn) resetPageFn();
    // ★ 服务端重新加载（无筛选）
    st.onRender();
}

function getFilteredRows(tid) {
    var st = _whereStates[tid]; if (!st) return { filtered: [], indices: [], count: 0 };
    try {
        var fn = compileWhereFn(st.whereExpr || '', st.cols);
        // 收集过滤后的行和它们在原始 rows 中的索引（不再做排序，排序由 clientSort 独立处理）
        var pairs = [];
        st.rows.forEach(function(row, i) {
            if (fn(row)) pairs.push({row: row, idx: i});
        });
        var filtered = pairs.map(function(p) { return p.row; });
        var indices = pairs.map(function(p) { return p.idx; });
        return { filtered: filtered, indices: indices, count: filtered.length };
    } catch (e) {
        var allIndices = st.rows.map(function(_,i){return i;});
        return { filtered: st.rows, indices: allIndices, count: st.rows.length };
    }
}

function updateWhereCount(tid, filteredCount, totalCount) {
    var el = document.getElementById(tid + '_count');
    if (!el) return;
    var st = _whereStates[tid];
    var hasFilter = (st && st.whereExpr) || (window['_activeWhereSql_'+tid] || '') !== '';
    if (hasFilter) {
        el.textContent = '筛选后：' + filteredCount + '+ 行';
        el.style.color = '#f39c12';
    } else {
        el.textContent = '共 ' + totalCount + '+ 行';
        el.style.color = '#888';
    }
}

function addTableDataTab(tn, db, schema, cid) {
    var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
    var sch = schema || '';
    var theDb = db || activeDatabase;
    var theCid = cid || activeConnId || '';
    // ★ 防御：连接信息为空时直接报错
    if (!conn || !conn.host) {
        addOrUpdateTab('data_'+tn, tn, 'data', '<div style="padding:20px;color:#e74c3c;">❌ 未找到连接信息，请先在左侧树中选择数据库后再试</div>', theDb, theCid);
        return;
    }
    // ★ 大表优化：首次打开只取 50 行（快速预览），点"加载全部"再全量查询
    addOrUpdateTab('data_'+tn, tn, 'data', '<div style="padding:20px;color:#999;">⏳ 正在加载数据（前50行）...</div>', theDb, theCid);
    
    try {
        eel.table_preview_data_fast(conn, theDb, tn, sch, '', '')(function(r){
            if(!r||!r.ok){addOrUpdateTab('data_'+tn,tn,'data','<div style="padding:20px;color:#e74c3c;">❌ '+(r?r.msg:'')+'</div>',theDb,theCid);return;}
            _buildTableDataUI(tn, conn, sch, r, theDb, theCid);
        });
    } catch(e) {
        addOrUpdateTab('data_'+tn, tn, 'data', '<div style="padding:20px;color:#e74c3c;">❌ 调用失败: ' + escapeHtml(String(e)) + '</div>', theDb, theCid);
    }
}

// ★ 判断列类型是否为长文本（TEXT/LONGTEXT 或 varchar(>500)），用于显示"展开"图标
function _isLongTextType(colType) {
    if (!colType) return false;
    var lower = colType.toLowerCase();
    // TEXT / LONGTEXT 及其变体（排除 tinytext 因为长度很短）
    if (/\b(?:longtext|text)\b/.test(lower) && lower.indexOf('tinytext') === -1) return true;
    // VARCHAR / CHAR / CHARACTER VARYING 长度超过 500
    var m = lower.match(/(?:varchar|char|character\s+varying)\s*\(\s*(\d+)\s*\)/i);
    if (m && parseInt(m[1]) > 500) return true;
    return false;
}

// ★ 判断是否显示"展开"按钮：类型匹配 + 内容长度超过阈值
// TEXT / LONGTEXT > 200 字符，VARCHAR(>500) > 300 字符
// ★ 阈值不宜过高：input 格子宽度有限，几百字符的无空格内容已经溢出
function _shouldShowExpandBtn(colType, val) {
    if (!colType || val === null || val === undefined) return false;
    var lower = colType.toLowerCase();
    var contentLen = String(val).length;
    // LONGTEXT / TEXT（排除 tinytext）：内容 > 200 字符就显示 📄
    if (/\b(?:longtext|text)\b/.test(lower) && lower.indexOf('tinytext') === -1) {
        return contentLen > 200;
    }
    // VARCHAR / CHAR / CHARACTER VARYING(>500)：内容 > 300 字符
    var m = lower.match(/(?:varchar|char|character\s+varying)\s*\(\s*(\d+)\s*\)/i);
    if (m && parseInt(m[1]) > 500) {
        return contentLen > 300;
    }
    return false;
}

// ★ 弹出文本框显示完整长文本内容
window._textPopupData = {};
window._showTextPopup = function(uid) {
    var data = window._textPopupData[uid];
    if (!data) return;
    var text = data.text || '';
    var colName = data.col || '';

    // 移除已存在的弹窗
    var old = document.getElementById('text_popup_overlay');
    if (old) old.remove();

    var overlay = document.createElement('div');
    overlay.id = 'text_popup_overlay';
    overlay.className = 'text-popup-overlay';
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

    var popup = document.createElement('div');
    popup.className = 'text-popup-box';

    var header = document.createElement('div');
    header.className = 'text-popup-header';
    header.innerHTML = '<span>📄 ' + escapeHtml(colName || '完整文本') + '</span>' +
        '<span class="text-popup-close" onclick="document.getElementById(\'text_popup_overlay\').remove()">✕</span>';

    var content = document.createElement('div');
    content.className = 'text-popup-content';
    // ★ 将 \\n（字面的反斜杠n）和实际换行符都展开为 <br>
    var displayText = text
        .replace(/\\\\n/g, '<br>')
        .replace(/\\n/g, '<br>')
        .replace(/\n/g, '<br>');
    content.innerHTML = displayText || '<span style="color:#888;">（空文本）</span>';

    var footer = document.createElement('div');
    footer.className = 'text-popup-footer';
    footer.textContent = '字符数: ' + text.length;

    popup.appendChild(header);
    popup.appendChild(content);
    popup.appendChild(footer);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
};

// ★ 单元格溢出 tooltip：hover 显示被截断的完整内容
// 有📄查看按钮的单元格跳过；内容未溢出的也跳过
function _initCellOverflowTooltip(tid) {
    var wrap = document.getElementById(tid);
    if (!wrap) return;
    var scrollWrap = wrap.querySelector('.data-table-scroll');
    if (!scrollWrap) return;

    // 创建全局 tooltip 元素（只创建一次）
    var tip = document.getElementById('cell_content_tooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'cell_content_tooltip';
        tip.className = 'cell-tooltip';
        document.body.appendChild(tip);
    }

    // ★ 移除旧监听器（通过标记避免重复绑定）
    if (scrollWrap.getAttribute('data-tooltip-bound') === '1') return;
    scrollWrap.setAttribute('data-tooltip-bound', '1');

    scrollWrap.addEventListener('mouseover', function(e) {
        var inp = e.target.closest('.editable-cell');
        if (!inp) { tip.style.display = 'none'; return; }
        // 有 📄 按钮的单元格不显示 tooltip
        var td = inp.closest('td');
        if (td && td.classList.contains('cell-with-icon')) { tip.style.display = 'none'; return; }
        // 内容没有溢出格子不显示
        if (inp.scrollWidth <= inp.clientWidth) { tip.style.display = 'none'; return; }
        tip.textContent = inp.value;
        tip.style.display = 'block';
        tip.style.left = (e.clientX + 12) + 'px';
        tip.style.top = (e.clientY + 16) + 'px';
    });

    scrollWrap.addEventListener('mousemove', function(e) {
        if (tip.style.display === 'block') {
            tip.style.left = (e.clientX + 12) + 'px';
            tip.style.top = (e.clientY + 16) + 'px';
        }
    });

    scrollWrap.addEventListener('mouseout', function(e) {
        var inp = e.target.closest('.editable-cell');
        if (!inp) return;
        tip.style.display = 'none';
    });
}

/** 构建/更新表格数据 UI（加载全量数据，支持客户端分页） */
function _buildTableDataUI(tn, conn, sch, r, db, cid) {
        if(!r||!r.ok){addOrUpdateTab('data_'+tn,tn,'data','<div style="padding:20px;color:#e74c3c;">❌ '+(r?r.msg:'')+'</div>',db,cid);return;}
        var tid = 'tbl_data_' + tn.replace(/[^a-zA-Z0-9]/g,'_');
        var cols = r.columns || [];
        var rows = r.rows || [];
        var comments = r.comments || {};
        var colTypes = r.col_types || {};
        // ★ 构建大小写不敏感的注释/类型查找表（DB 返回的列名大小写可能与结果集不一致）
        var _cmtLower = {}, _typeLower = {};
        for (var ck in comments) { _cmtLower[String(ck).toLowerCase()] = comments[ck]; }
        for (var tk in colTypes) { _typeLower[String(tk).toLowerCase()] = colTypes[tk]; }
        function getCmt(c){ return comments[c] || _cmtLower[String(c).toLowerCase()] || ''; }
        function getCType(c){ return colTypes[c] || _typeLower[String(c).toLowerCase()] || ''; }
        var sortRef = { col: -1, dir: 1 };
        var sortColName = '';
        // 服务端排序所需参数
        var _connDb = db || '';
        var _connTn = tn;
        var _connSch = sch;

        // 列筛选器状态：{colIndex: filterText}
        var _colFilters = {};

        // ★ 长文本列显示"展开"按钮改用内容长度判断（TEXT/LONGTEXT>1000, VARCHAR(>500)>500）

        // ★ 数据库总行数标记（不用 COUNT(*)，大表 COUNT 太慢）
        //    用取 N+1 行判断 has_more，省掉 COUNT 查询
        var _hasMore = r.has_more === true;
        var _totalCount = r.total_count || rows.length;
        // ★ 是否已加载全部数据（fast 模式也尊重 has_more，否则分页按钮会被错误禁用）
        var _allLoaded = !_hasMore;
        // ★ 是否正在刷新中
        var _refreshing = false;
        // ★ 当前生效的 SQL WHERE 条件（服务端筛选，空字符串表示无筛选）
        var _activeWhereSql = '';
        // ★ 初始化 window 全局（供 applyWhere/clearWhere 等全局函数读写）
        window['_activeWhereSql_'+tid] = '';

        // ★ 服务端重新加载数据（带当前 WHERE 条件）
        // ★ 取消令牌：每次 _serverReload / _fetchPage 前自增，回调中检查令牌是否匹配，防止旧异步回调污染 UI
        var _reloadToken = 0;

        function _serverReload() {
            _pageLoading = true;
            // ★ 自增令牌，使之前的异步回调失效
            var myToken = ++_reloadToken;
            _activeWhereSql = window['_activeWhereSql_'+tid] || '';
            var whereSql = _activeWhereSql;
            if (_pageOffset !== 0 || _pageSize !== 50) { _pageOffset = 0; _pageSize = 50; }
            var sortCol = sortRef.col >= 0 ? cols[sortRef.col] : '';
            var sortDir = sortRef.dir === 1 ? 'asc' : 'desc';
            var infoEl = document.getElementById(tid+'_pager_info');
            if (infoEl) infoEl.textContent = '⏳ 查询中...';
            var wrap = document.getElementById(tid);
            // ★ 显示取消遮罩（带 kill query 按钮）
            var overlay = null;
            var _cancelled = false;
            if (wrap) {
                wrap.style.opacity = '0.6'; wrap.style.pointerEvents = 'none';
                overlay = document.createElement('div');
                overlay.id = tid + '_reload_overlay';
                overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;' +
                    'background:rgba(0,0,0,0.5);z-index:100;display:flex;' +
                    'flex-direction:column;align-items:center;justify-content:center;gap:12px;' +
                    'border-radius:6px;min-height:120px;';
                overlay.innerHTML = '<div style="font-size:28px;animation:spin 1s linear infinite;">⏳</div>' +
                    '<div style="color:#ccc;font-size:14px;">正在加载数据...</div>' +
                    '<button id="' + tid + '_cancel_reload_btn" style="padding:6px 20px;border:1px solid #e74c3c;' +
                    'border-radius:4px;background:rgba(255,255,255,0.1);color:#e74c3c;cursor:pointer;font-size:12px;">✕ 取消查询</button>';
                wrap.style.position = 'relative';
                wrap.appendChild(overlay);
                // 绑定取消按钮
                setTimeout(function(){
                    var cbtn = document.getElementById(tid + '_cancel_reload_btn');
                    if (cbtn) cbtn.onclick = function() {
                        _cancelled = true;
                        myToken = 0; // ★ 使旧令牌失效
                        _pageLoading = false;
                        // ★ 调用后端取消查询并 kill 数据库连接
                        eel.cancel_query()();
                        _hideOverlay();
                        if (infoEl) infoEl.textContent = '⏸ 查询已取消';
                    };
                }, 50);
            }
            function _hideOverlay() {
                var ov = document.getElementById(tid + '_reload_overlay');
                if (ov) ov.remove();
                if (wrap) { wrap.style.opacity = '1'; wrap.style.pointerEvents = ''; }
            }
            eel.table_preview_data_fast(conn, _connDb, _connTn, _connSch, sortCol, sortDir, whereSql)(function(r2){
                // ★ 令牌不匹配或已取消，忽略此回调
                if (myToken !== _reloadToken || _cancelled) {
                    _hideOverlay();
                    return;
                }
                _pageLoading = false;
                _hideOverlay();
                if (!r2 || !r2.ok) {
                    if (r2 && r2.cancelled) {
                        if (infoEl) infoEl.textContent = '⏸ 查询已取消';
                        return;
                    }
                    if (infoEl) infoEl.textContent = (r2 && r2.msg) || '查询失败';
                    return;
                }
                rows = r2.rows || [];
                comments = r2.comments || {};
                colTypes = r2.col_types || {};
                _totalCount = r2.total_count || rows.length;
                _hasMore = r2.has_more === true;
                _allLoaded = !_hasMore;
                _colFilteredPairs = null;
                var st = _whereStates[tid];
                if (st) { st.rows = rows; st.filteredCache = null; st.fcCount = null; }
                updateFilterIcons();
                render();
                updatePagerInfo();
            });
        }
        window['_serverReload_'+tid] = function() { _serverReload(); };

        function buildTh() {
            var h = '<tr><th class="row-sel-header" id="'+tid+'_sel_all" onclick="window[\'_toggleSelAll_'+tid+'\']()" title="全选/取消全选">#</th>';
            cols.forEach(function(c,ci){
                var cmt = getCmt(c);
                var cType = getCType(c);
                // 排序三态：未排序=⇅(灰色双向箭头), 升序=▲, 降序=▼
                var sortIcon = '⇅';
                if (sortRef.col === ci) {
                    sortIcon = sortRef.dir === 1 ? '▲' : '▼';
                }
                // 漏斗图标（有筛选时高亮）
                var hasFilter = _colFilters[ci] && _colFilters[ci].trim() !== '';
                var filterOpacity = hasFilter ? '1' : '0.4';
                // ★ 根据字段类型长度计算列最小宽度：类型越长，格子越宽
                var typeLen = cType ? cType.length : 0;
                var colMinWidth = typeLen > 25 ? (typeLen > 35 ? 220 : 180) : (typeLen > 12 ? 140 : 90);
                // ★ 三行布局：字段名 / 字段类型 / 字段注释，排序+筛选图标在右侧居中
                h+='<th class="sortable-th" data-ci="'+ci+'" data-orig="'+escapeAttr(c)+'" style="user-select:none;min-width:'+colMinWidth+'px;" oncontextmenu="colHeaderCtx(event,\''+escapeAttr(c)+'\',\''+escapeAttr(cType||'')+'\',\''+escapeAttr(cmt||'')+'\');">';
                h+='<div class="th-content">';
                h+='<div class="th-line th-line-name">'+escapeHtml(c)+'</div>';
                if (cType) h+='<div class="th-line th-line-type">'+escapeHtml(cType)+'</div>';
                else h+='<div class="th-line th-line-type"></div>';
                if (cmt) h+='<div class="th-line th-line-cmt">'+escapeHtml(cmt)+'</div>';
                else h+='<div class="th-line th-line-cmt"></div>';
                h+='</div>';
                h+='<div class="th-icons">';
                h+='<span class="col-filter-icon" data-ci="'+ci+'" title="筛选此列" style="cursor:pointer;font-size:13px;opacity:'+filterOpacity+';color:#aaa;" onclick="event.stopPropagation();window[\'_toggleColFilter_'+tid+'\']('+ci+',this)">⏳</span>';
                h+='<span class="sort-icon" data-ci="'+ci+'" title="点击排序" style="cursor:pointer;display:inline-block;width:20px;text-align:center;font-size:12px;color:#888;" onclick="event.stopPropagation();window[\'_sortClickIcon_'+tid+'\']('+ci+')">'+sortIcon+'</span>';
                h+='</div>';
                h+='</th>';
            });
            h += '</tr>';
            // 筛选浮层（绝对定位，覆盖在表格上方）——不再使用表格行
            h += '<tr id="'+tid+'_frow" style="display:none;"><td></td>';
            cols.forEach(function(c,ci){
                h += '<td id="'+tid+'_ftd_'+ci+'"></td>';
            });
            h += '</tr>';
            return h;
        }

        // 行选择状态：Set of original row indices
        var _selectedRows = {};
        // 上一次点击的原始行索引（用于 shift 范围选择）
        var _lastClickedIdx = -1;
        // ★ 暴露引用供全局点击清除
        window['_selRows_'+tid] = _selectedRows;
        window['_lastClk_'+tid] = _lastClickedIdx;

        function getSelectedOriginalIndices() {
            // 返回选中的原始行索引数组（按升序排列）
            return Object.keys(_selectedRows).map(Number).sort(function(a,b){return a-b;});
        }

        function updateDeleteBtn() {
            var btn = document.getElementById(tid + '_del_btn');
            if (btn) {
                var cnt = getSelectedOriginalIndices().length;
                btn.textContent = '🗑 删除' + (cnt ? ' (' + cnt + ')' : '');
                btn.disabled = cnt === 0;
            }
        }

        // 编辑状态跟踪
        var _changedCells = {}; // key: "originalRowIdx:colIdx" → {old,new,colName,origRow,columns}
        var _editing = false;

        function cellChanged(origRowIdx, colIdx, colName, newVal, oldVal) {
            var key = origRowIdx + ':' + colIdx;
            if (String(newVal) !== String(oldVal)) {
                var origRow = rows[origRowIdx];
                _changedCells[key] = {rowIdx: origRowIdx, colIdx: colIdx, colName: colName,
                    oldVal: oldVal, newVal: newVal, origRow: origRow, columns: cols};
            } else {
                delete _changedCells[key];
            }
            updateSaveBtn();
        }

        function updateSaveBtn() {
            var btn = document.getElementById(tid + '_save_btn');
            var cancelBtn = document.getElementById(tid + '_cancel_btn');
            var cnt = Object.keys(_changedCells).length;
            if (btn) { btn.textContent = '💾 保存' + (cnt ? ' (' + cnt + ')' : ''); btn.disabled = cnt === 0; }
            if (cancelBtn) cancelBtn.disabled = cnt === 0;
            _editing = cnt > 0;
        }

        function render() {
            var pg = getPageRows();
            var tbody = document.getElementById(tid+'_tbody');
            if (!tbody) return;
            if (_editing) return;
            var h = '';
            pg.rows.forEach(function(row, ri){
                var origIdx = pg.indices[ri]; // 原始 rows 中的索引
                var isSel = !!_selectedRows[origIdx];
                var gripCls = isSel ? 'row-sel-grip selected' : 'row-sel-grip';
                var rowCls = isSel ? ' class="row-selected"' : '';
                h += '<tr data-ri="'+ri+'" data-orig-idx="'+origIdx+'"'+rowCls+'>';
                // 行选择格：点击选中/取消，右键菜单；▲ 只有 grip 格子才能选中行
                h += '<td class="'+gripCls+'" data-orig-idx="'+origIdx+'" ' +
                    'onclick="window[\'_rowGripClick_'+tid+'\'](this,'+origIdx+')" ' +
                    'oncontextmenu="window[\'_rowCtx_'+tid+'\'](event,'+origIdx+')" ' +
                    'title="左键选择/取消选择行 | 右键菜单">'+(origIdx+1)+'</td>';
                row.forEach(function(v,ci){
                    var val = v===null ? 'NULL' : String(v);
                    var cType = getCType(cols[ci]);
                    var isLongText = _shouldShowExpandBtn(cType, v);
                    if (isLongText) {
                        var uid = tid + '_txt_' + origIdx + '_' + ci;
                        // ★ 把文本存到全局对象，避免内联 JS 的转义问题
                        window._textPopupData[uid] = { text: val, col: cols[ci] };
                        h += '<td class="cell-with-icon">' +
                            '<input class="editable-cell" data-ri="'+ri+'" data-ci="'+ci+'" data-col="'+escapeAttr(cols[ci])+'" ' +
                            'value="'+escapeAttr(val)+'" ' +
                            'onfocus="this._oldVal=this.value" ' +
                            'onchange="window[\'_cellChanged_'+tid+'\']('+origIdx+','+ci+',\''+escapeAttr(cols[ci])+'\',this.value,this._oldVal)" ' +
                            'onblur="if(this.value!==this._oldVal){window[\'_cellChanged_'+tid+'\']('+origIdx+','+ci+',\''+escapeAttr(cols[ci])+'\',this.value,this._oldVal)}" ' +
                            'spellcheck="false" autocomplete="off">' +
                            '<span class="text-expand-icon" data-uid="'+uid+'" ' +
                            'onclick="event.stopPropagation();window._showTextPopup(\''+uid+'\')" ' +
                            'title="查看完整文本">📄</span>' +
                            '</td>';
                    } else {
                        h += '<td><input class="editable-cell" data-ri="'+ri+'" data-ci="'+ci+'" data-col="'+escapeAttr(cols[ci])+'" ' +
                            'value="'+escapeAttr(val)+'" ' +
                            'onfocus="this._oldVal=this.value" ' +
                            'onchange="window[\'_cellChanged_'+tid+'\']('+origIdx+','+ci+',\''+escapeAttr(cols[ci])+'\',this.value,this._oldVal)" ' +
                            'onblur="if(this.value!==this._oldVal){window[\'_cellChanged_'+tid+'\']('+origIdx+','+ci+',\''+escapeAttr(cols[ci])+'\',this.value,this._oldVal)}" ' +
                            'spellcheck="false" autocomplete="off"></td>';
                    }
                });
                h += '</tr>';
            });
            if (pg.total === 0) h = '<tr><td colspan="'+(cols.length+1)+'" style="text-align:center;color:#666;padding:20px;">（无匹配数据）</td></tr>';
            tbody.innerHTML = h;
            updateWhereCount(tid, pg.total, rows.length);
            updatePagerInfo();
            // 更新全选按钮状态（基于当前页的行）
            updateSelAllCheckbox(pg);
        }

        function updateSelAllCheckbox(f) {
            var th = document.getElementById(tid+'_sel_all');
            if (!th) return;
            var f2 = f || getPageRows();
            if (f2.total === 0) { th.classList.remove('all-selected'); return; }
            var selectedCount = 0;
            f2.indices.forEach(function(oi){ if (_selectedRows[oi]) selectedCount++; });
            if (selectedCount === f2.indices.length) { th.classList.add('all-selected'); }
            else { th.classList.remove('all-selected'); }
        }

        // 列筛选后的中间结果（供 getPageRows 使用）
        var _colFilteredPairs = null; // null 表示无列筛选，使用 getFilteredRows

        // 列筛选：构建 SQL WHERE 发送到服务端（全表筛选）
        function applyColFilters() {
            var hasFilter = false;
            for (var ci in _colFilters) {
                if (_colFilters[ci] && _colFilters[ci].trim() !== '') { hasFilter = true; break; }
            }
            if (!hasFilter) {
                _colFilteredPairs = null;
                window['_activeWhereSql_'+tid] = '';
                _pageOffset = 0;
                _pageSize = 50;
                updateFilterIcons();
                _serverReload();
                return;
            }
            // ★ 构建 SQL WHERE 条件（LIKE 模糊匹配）
            // 根据数据库类型使用正确的引号（MySQL 用反引号，PostgreSQL/Oracle 用双引号，MSSQL 用方括号）
            var dbType = (conn && conn.db_type) || 'mysql';
            function _quoteCol(name) {
                if (dbType === 'postgresql' || dbType === 'oracle') {
                    return '"' + name + '"';
                } else if (dbType === 'mssql') {
                    return '[' + name + ']';
                } else {
                    return '`' + name + '`';
                }
            }
            var conditions = [];
            for (var ci in _colFilters) {
                var ft = _colFilters[ci];
                if (!ft || ft.trim() === '') continue;
                var colName = cols[parseInt(ci)];
                var escapedVal = ft.trim().replace(/'/g, "\\'").replace(/\\/g, "\\\\");
                conditions.push(_quoteCol(colName) + ' LIKE \'%' + escapedVal + '%\'');
            }
            var whereSql = conditions.join(' AND ');
            window['_activeWhereSql_'+tid] = whereSql;
            // 清空 WHERE 栏输入（列筛选与 WHERE 互斥）
            var whereInp = document.getElementById(tid + '_where');
            if (whereInp) whereInp.value = '';
            var st = _whereStates[tid];
            if (st) st.whereExpr = '';
            _pageOffset = 0;
            _pageSize = 50;
            _colFilteredPairs = null;
            updateFilterIcons();
            _serverReload();
        }

        function updateFilterIcons() {
            var wrap = document.getElementById(tid);
            if (!wrap) return;
            var icons = wrap.querySelectorAll('.col-filter-icon');
            icons.forEach(function(icon){
                var ci = parseInt(icon.getAttribute('data-ci'));
                var hasFilter = _colFilters[ci] && _colFilters[ci].trim() !== '';
                icon.style.opacity = hasFilter ? '1' : '0.3';
            });
        }

        // 当前激活筛选的列索引（-1表示无）
        var _activeFilterCol = -1;
        var _filterPopup = null; // 当前浮层 DOM

        // 关闭筛选浮层
        function closeFilterPopup() {
            if (_filterPopup && _filterPopup.parentNode) {
                _filterPopup.parentNode.removeChild(_filterPopup);
            }
            _filterPopup = null;
            _activeFilterCol = -1;
        }

        // 点击漏斗图标：弹出浮层筛选窗口（覆盖在表格上方，不影响布局）
        function toggleColFilter(ci, iconEl) {
            // 如果已有浮层且是同一列，关闭
            if (_filterPopup && _activeFilterCol === ci) {
                closeFilterPopup();
                _colFilters = {};
                updateFilterIcons();
                _colFilteredPairs = null;
                render();
                return;
            }

            // 关闭之前的浮层
            closeFilterPopup();

            // 创建浮层
            var popup = document.createElement('div');
            popup.className = 'col-filter-popup';
            popup.setAttribute('data-tid', tid);
            var curVal = (_colFilters[ci] || '');

            popup.innerHTML =
                '<div style="font-size:11px;color:#888;margin-bottom:2px;">筛选: <b style="color:#5dade2;">' + escapeHtml(cols[ci]) + '</b></div>' +
                '<input id="'+tid+'_popup_inp" value="' + escapeAttr(curVal) + '" placeholder="输入关键词（模糊匹配）" style="width:100%;min-width:180px;" onkeydown="if(event.key===\'Enter\')window[\'_popupApply_'+tid+'\']()">' +
                '<div class="popup-btns">' +
                    '<button onclick="window[\'_popupClear_'+tid+'\']()">清除</button>' +
                    '<button class="btn-apply" onclick="window[\'_popupApply_'+tid+'\']()">应用</button>' +
                '</div>';

            // 定位浮层：在漏斗图标下方
            var rect = iconEl.getBoundingClientRect();
            var scrollWrap = document.querySelector('.data-table-scroll');
            var scrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
            var scrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;

            // 找到 data-table-wrap 的容器
            var wrap = document.getElementById(tid);
            if (wrap) {
                var wrapRect = wrap.getBoundingClientRect();
                popup.style.position = 'absolute';
                popup.style.left = (rect.left - wrapRect.left + scrollLeft) + 'px';
                popup.style.top = (rect.bottom - wrapRect.top + scrollTop + 2) + 'px';
                wrap.appendChild(popup);
            } else {
                document.body.appendChild(popup);
                popup.style.position = 'fixed';
                popup.style.left = rect.left + 'px';
                popup.style.top = (rect.bottom + 2) + 'px';
            }

            _filterPopup = popup;
            _activeFilterCol = ci;

            // 聚焦输入框
            setTimeout(function() {
                var inp = document.getElementById(tid+'_popup_inp');
                if (inp) inp.focus();
            }, 50);

            // 点击浮层外部关闭
            setTimeout(function() {
                document.addEventListener('click', _popupOutsideClick);
            }, 0);
        }

        function _popupOutsideClick(e) {
            if (_filterPopup && !_filterPopup.contains(e.target) && !e.target.closest('.col-filter-icon')) {
                closeFilterPopup();
                document.removeEventListener('click', _popupOutsideClick);
            }
        }

        // 浮层应用筛选
        window['_popupApply_'+tid] = function() {
            var inp = document.getElementById(tid+'_popup_inp');
            if (!inp) return;
            _colFilters[_activeFilterCol] = inp.value;
            closeFilterPopup();
            document.removeEventListener('click', _popupOutsideClick);
            updateFilterIcons();
            applyColFilters();
        };

        // 浮层清除筛选
        window['_popupClear_'+tid] = function() {
            _colFilters[_activeFilterCol] = '';
            closeFilterPopup();
            document.removeEventListener('click', _popupOutsideClick);
            updateFilterIcons();
            applyColFilters();
        };

        function doSaveChanges() {
            var changes = [];
            for (var k in _changedCells) {
                if (_changedCells.hasOwnProperty(k)) {
                    var ch = _changedCells[k];
                    changes.push({col: ch.colName, newVal: String(ch.newVal),
                        origRow: (ch.origRow||[]).map(function(v){return v===null?'NULL':String(v);}),
                        columns: ch.columns || cols});
                }
            }
            if (!changes.length) return;

            eel.table_save_changes(conn, db||activeDatabase, tn, sch, changes)(function(r) {
                if (!r || !r.ok) {
                    var btn = document.getElementById(tid + '_save_btn');
                    if (btn) { btn.textContent = '❌ '+(r?r.msg:'失败'); btn.style.background = '#e74c3c'; }
                    return;
                }
                var sql = r.sql || '';
                showConfirmDialog('确认执行修改',
                    '<div style="max-height:300px;overflow:auto;background:#0d1117;padding:8px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;">' + escapeHtml(sql) + '</div>' +
                    '<div style="margin-top:6px;color:#f39c12;font-size:11px;">共 ' + r.count + ' 处修改</div>',
                    function() {
                        eel.table_exec_save(conn, db||activeDatabase, tn, sch, changes)(function(r2) {
                            if (!r2 || !r2.ok) {
                                var btn2 = document.getElementById(tid + '_save_btn');
                                if (btn2) { btn2.textContent = '❌ '+(r2?r2.msg:'失败'); btn2.style.background = '#e74c3c'; }
                                return;
                            }
                            _changedCells = {};
                            _editing = false;
                            updateSaveBtn();
                            sortColName = sortRef.col >= 0 ? cols[sortRef.col] : '';
                            var whereSql4 = window['_activeWhereSql_'+tid] || '';
                            eel.table_preview_data_fast(conn, db||activeDatabase, tn, sch, sortColName, sortRef.dir === 1 ? 'asc' : 'desc', whereSql4)(function(r3){
                                if (r3 && r3.ok) {
                                    rows = r3.rows || [];
                                    var st6 = _whereStates[tid];
                                    if (st6) st6.rows = rows;
                                    render();
                                }
                            });
                        });
                    }
                );
            });
        }

        function cancelEdit() {
            _changedCells = {};
            _editing = false;
            updateSaveBtn();
            render();
        }

        // 删除选中行
        function doDeleteRows() {
            var selIndices = getSelectedOriginalIndices();
            if (!selIndices.length) return;
            var rowsData = [];
            selIndices.forEach(function(oi) {
                var origRow = rows[oi];
                if (!origRow) return;
                rowsData.push({
                    origRow: origRow.map(function(v){return v===null?'NULL':String(v);}),
                    columns: cols
                });
            });
            if (!rowsData.length) return;

            eel.table_delete_rows(conn, db||activeDatabase, tn, sch, rowsData)(function(r) {
                if (!r || !r.ok) {
                    var btn = document.getElementById(tid + '_del_btn');
                    if (btn) { btn.textContent = '❌ '+(r?r.msg:'失败'); btn.style.background = '#e74c3c'; }
                    return;
                }
                var sql = r.sql || '';
                showConfirmDialog('确认删除行',
                    '<div style="max-height:300px;overflow:auto;background:#0d1117;padding:8px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;">' + escapeHtml(sql) + '</div>' +
                    '<div style="margin-top:6px;color:#e74c3c;font-size:11px;">⚠ 将删除 ' + r.count + ' 行数据，此操作不可撤销</div>',
                    function() {
                        eel.table_exec_delete(conn, db||activeDatabase, tn, sch, rowsData)(function(r2) {
                            if (!r2 || !r2.ok) {
                                var btn2 = document.getElementById(tid + '_del_btn');
                                if (btn2) { btn2.textContent = '❌ '+(r2?r2.msg:'失败'); btn2.style.background = '#e74c3c'; }
                                return;
                            }
                            _selectedRows = {};
                            updateDeleteBtn();
                            sortColName = sortRef.col >= 0 ? cols[sortRef.col] : '';
                            var whereSql5 = window['_activeWhereSql_'+tid] || '';
                            eel.table_preview_data_fast(conn, db||activeDatabase, tn, sch, sortColName, sortRef.dir === 1 ? 'asc' : 'desc', whereSql5)(function(r3){
                                if (r3 && r3.ok) {
                                    rows = r3.rows || [];
                                    var st7 = _whereStates[tid];
                                    if (st7) st7.rows = rows;
                                    render();
                                }
                            });
                        });
                    }
                );
            });
        }

        // 暴露到全局作用域
        window['_doSave_' + tid] = doSaveChanges;
        window['_cancelEdit_' + tid] = cancelEdit;
        window['_cellChanged_' + tid] = cellChanged;
        window['_doDelete_' + tid] = doDeleteRows;
        // 行选择格点击：单选/Shift多选 / ▲ 再点已选中行则取消全部
        window['_rowGripClick_' + tid] = function(gripEl, origIdx) {
            var evt = window.event;
            var isShift = evt && evt.shiftKey;
            var isCtrl = evt && (evt.ctrlKey || evt.metaKey);

            if (isShift && _lastClickedIdx >= 0) {
                var from = Math.min(_lastClickedIdx, origIdx);
                var to = Math.max(_lastClickedIdx, origIdx);
                _selectedRows = {};
                for (var i = from; i <= to; i++) {
                    _selectedRows[i] = true;
                }
            } else if (isCtrl) {
                if (_selectedRows[origIdx]) {
                    delete _selectedRows[origIdx];
                } else {
                    _selectedRows[origIdx] = true;
                }
                _lastClickedIdx = origIdx;
            } else if (_selectedRows[origIdx] && Object.keys(_selectedRows).length === 1) {
                // ▲ 普通点击已唯一选中的行 → 取消全部选中
                _selectedRows = {};
                _lastClickedIdx = -1;
            } else {
                // 普通点击：只选中当前行，取消其他所有行
                _selectedRows = {};
                _selectedRows[origIdx] = true;
                _lastClickedIdx = origIdx;
            }

            _updateRowHighlights(tid);
            updateDeleteBtn();
            updateSelAllCheckbox(null);
        };
        window['_toggleSelAll_' + tid] = function() {
            var pg = getPageRows();
            var allSel = pg.indices.length > 0 && pg.indices.every(function(oi){ return !!_selectedRows[oi]; });
            if (allSel) {
                // 全部取消
                pg.indices.forEach(function(oi){ delete _selectedRows[oi]; });
            } else {
                // 全选当前页
                pg.indices.forEach(function(oi){ _selectedRows[oi] = true; });
            }
            updateDeleteBtn();
            _updateRowHighlights(tid);
            updateSelAllCheckbox(null);
        };
        // 刷新当前页行高亮（用于全选/反选后同步视觉）
        function _updateRowHighlights(_tid) {
            var tbody = document.getElementById(_tid+'_tbody');
            if (!tbody) return;
            var grips = tbody.querySelectorAll('.row-sel-grip');
            for (var g = 0; g < grips.length; g++) {
                var grip = grips[g];
                var oi = parseInt(grip.getAttribute('data-orig-idx'));
                var sel = !!_selectedRows[oi];
                if (sel) grip.classList.add('selected'); else grip.classList.remove('selected');
                var tr = grip.parentNode;
                if (tr) {
                    if (sel) tr.classList.add('row-selected'); else tr.classList.remove('row-selected');
                }
            }
        }
        window['_toggleColFilter_' + tid] = toggleColFilter;

        registerWhereState(tid, cols, rows, sortRef, function(){_serverReload();}, colTypes);
        _tabIdToTid['data_'+tn] = tid;
        // ★ 暴露本地 render（仅重新绘制 DOM，不请求服务端），供 renderObjectPanel 切换 tab 时使用
        window['_renderLocal_'+tid] = render;

        // ★ 暴露清除列筛选的函数，供 applyWhere 调用
        window['_clearColFilters_'+tid] = function() {
            _colFilteredPairs = null;
            _colFilters = {};
            _activeFilterCol = -1;
            var frow = document.getElementById(tid+'_frow');
            if (frow) frow.style.display = 'none';
            updateFilterIcons();
        };
        window['_resetPage_'+tid] = function() {
            _pageOffset = 0;
        };
        // ★ 暴露 buildTh，供 cancelDataSort 等外部函数重建表头时复用（保持注释/类型/布局一致）
        window['_buildTh_'+tid] = buildTh;

        // 分页状态
        var _pageSize = 50;   // 每页行数
        var _pageOffset = 0;  // 当前偏移

        function getPageRows() {
            // ★ 服务端筛选后，rows 即为当前已加载的筛选结果
            var loadedTotal = rows.length;
            // ★ 未全加载时 +1 保证下一页按钮可用（用 N+1 法的 has_more 判断）
            var displayTotal = _allLoaded ? loadedTotal : (loadedTotal + 1);
            if (_pageSize <= 0 || _pageSize >= 99999) {
                // 全部
                var allIndices = rows.map(function(_,i){return i;});
                return { rows: rows, indices: allIndices, total: displayTotal, offset: 0, pageSize: displayTotal };
            }
            var start = _pageOffset;
            var end = Math.min(start + _pageSize, loadedTotal);
            var sliced = rows.slice(start, end);
            var slicedIndices = sliced.map(function(_,i){return start + i;});
            return {
                rows: sliced,
                indices: slicedIndices,
                total: displayTotal,
                offset: start,
                pageSize: _pageSize
            };
        }

        function updatePagerInfo() {
            var pg = getPageRows();
            var el = document.getElementById(tid+'_pager_info');
            if (!el) return;
            var total = pg.total;
            if (_allLoaded) {
                if (pg.pageSize >= total) {
                    el.textContent = '共 ' + total + ' 条';
                } else {
                    el.textContent = '显示 ' + (pg.offset+1) + '-' + Math.min(pg.offset+pg.pageSize, total) + ' / 共 ' + total + ' 条';
                }
            } else {
                // ★ 未全加载时显示 "前 X+ 条"（实际行数未知，+ 表示还有更多）
                var knownCount = total - 1;  // displayTotal = loadedCount + 1
                if (pg.pageSize >= knownCount) {
                    el.textContent = '前 ' + knownCount + '+ 条';
                } else {
                    el.textContent = '显示 ' + (pg.offset+1) + '-' + Math.min(pg.offset+pg.pageSize, knownCount) + ' / 前 ' + knownCount + '+ 条';
                }
            }
            var prevBtn = document.getElementById(tid+'_prev_btn');
            var nextBtn = document.getElementById(tid+'_next_btn');
            if (prevBtn) prevBtn.disabled = pg.offset <= 0;
            // ★ 未全加载时下一页始终可用
            if (nextBtn) nextBtn.disabled = _allLoaded ? (pg.offset + pg.pageSize >= pg.total) : false;
        }

        var _lastGoPageTs = 0; // ★ 防抖时间戳，防止重复绑定导致一次点击触发多次 goPage
        var _pageLoading = false; // ★ 防止并发翻页请求
        function goPage(dir) {
            // ★ 防抖：重复绑定会让一次 click 触发多次 goPage（offset 跳两页），120ms 内忽略后续调用
            var now = Date.now();
            if (now - _lastGoPageTs < 120) return;
            _lastGoPageTs = now;
            if (_pageLoading) return; // 正在加载中，忽略
            // ★ 先从 select 同步 pageSize，避免闭包 _pageSize 与 UI 不一致
            var psizeEl = document.getElementById(tid+'_psize');
            if (psizeEl) _pageSize = parseInt(psizeEl.value) || 50;
            var pg = getPageRows();
            var newOffset = pg.offset + dir * _pageSize;
            if (newOffset < 0) newOffset = 0;
            if (pg.total > 0 && newOffset >= pg.total) newOffset = Math.max(0, pg.total - _pageSize);

            // ★ 检查目标页数据是否已加载：如果没加载完且目标偏移超出已加载范围
            var neededEnd = newOffset + _pageSize;
            if (neededEnd > rows.length && !_allLoaded) {
                _pageOffset = newOffset;
                _fetchPageFromServer(newOffset, _pageSize);
                return;
            }

            _pageOffset = newOffset;
            render();
        }

        function _fetchPageFromServer(offset, limit) {
            _pageLoading = true;
            var myToken = ++_reloadToken;
            var _cancelled = false;
            var wrap = document.getElementById(tid);
            var overlay = null;
            if (wrap) { wrap.style.opacity = '0.6'; wrap.style.pointerEvents = 'none'; }
            var infoEl = document.getElementById(tid + '_pager_info');
            if (infoEl) infoEl.textContent = '⏳ 加载第 ' + (Math.floor(offset/Math.max(limit,1))+1) + ' 页...';
            // ★ 显示取消按钮（翻页加载也可能很慢）
            if (wrap) {
                overlay = document.createElement('div');
                overlay.id = tid + '_page_overlay';
                overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;' +
                    'background:rgba(0,0,0,0.5);z-index:100;display:flex;' +
                    'flex-direction:column;align-items:center;justify-content:center;gap:12px;' +
                    'border-radius:6px;min-height:120px;';
                overlay.innerHTML = '<div style="font-size:28px;animation:spin 1s linear infinite;">⏳</div>' +
                    '<div style="color:#ccc;font-size:14px;">正在加载分页数据...</div>' +
                    '<button id="' + tid + '_cancel_page_btn" style="padding:6px 20px;border:1px solid #e74c3c;' +
                    'border-radius:4px;background:rgba(255,255,255,0.1);color:#e74c3c;cursor:pointer;font-size:12px;">✕ 取消加载</button>';
                wrap.style.position = 'relative';
                wrap.appendChild(overlay);
                setTimeout(function(){
                    var cbtn = document.getElementById(tid + '_cancel_page_btn');
                    if (cbtn) cbtn.onclick = function() {
                        _cancelled = true;
                        myToken = 0;
                        _pageLoading = false;
                        eel.cancel_query()();
                        _hidePageOverlay();
                        if (infoEl) infoEl.textContent = '⏸ 加载已取消';
                    };
                }, 50);
            }
            function _hidePageOverlay() {
                var ov = document.getElementById(tid + '_page_overlay');
                if (ov) ov.remove();
                if (wrap) { wrap.style.opacity = '1'; wrap.style.pointerEvents = ''; }
            }
            var orderCol = sortRef.col >= 0 ? cols[sortRef.col] : '';
            var orderDir = sortRef.dir === 1 ? 'asc' : 'desc';
            var whereSql = window['_activeWhereSql_'+tid] || '';
            eel.table_load_page(conn, _connDb, _connTn, _connSch, offset, limit, orderCol, orderDir, whereSql)(function(rp){
                if (myToken !== _reloadToken || _cancelled) {
                    _hidePageOverlay();
                    return;
                }
                _pageLoading = false;
                _hidePageOverlay();
                if (!rp || !rp.ok) { if (infoEl) infoEl.textContent = '加载失败'; return; }
                var newRows = rp.rows || [];
                // ★ offset=0 时替换（切 pageSize 从0重新拉），否则追加
                if (offset === 0) {
                    rows = newRows;
                } else if (offset >= rows.length) {
                    rows = rows.concat(newRows);
                }
                // ★ 用 has_more 标志判断是否还有更多数据（不用 COUNT(*)）
                _totalCount = offset + newRows.length;
                if (rp.has_more) {
                    _hasMore = true;
                    _allLoaded = false;
                } else {
                    _hasMore = false;
                    _allLoaded = true;
                }
                var st = _whereStates[tid];
                if (st) { st.rows = rows; st.filteredCache = null; st.fcCount = null; }
                render();
                updatePagerInfo();
            });
        }

        function changePageSize() {
            var newSize = parseInt((document.getElementById(tid+'_psize')||{}).value) || 50;
            // ★ 切 pageSize 时如果新页大小超出已加载行数，从服务端拉取
            if (newSize > rows.length && !_allLoaded) {
                _pageSize = newSize;
                _pageOffset = 0;
                _fetchPageFromServer(0, newSize);
                return;
            }
            _pageSize = newSize;
            _pageOffset = 0;
            render();
        }

        window['_goPage_'+tid] = goPage;
        window['_changePageSize_'+tid] = changePageSize;

        // ★ 刷新按钮：重新从数据库加载数据（只取前50行，支持取消）
        function refreshTableData() {
            // ★ 防止重复刷新
            if (_refreshing) return;
            _refreshing = true;
            var st7 = _whereStates[tid];
            // 保存当前排序状态用于刷新后恢复
            var sortCol = sortRef.col >= 0 ? cols[sortRef.col] : '';
            var sortDir = sortRef.dir === 1 ? 'asc' : 'desc';
            // ★ 显示刷新遮罩（带取消按钮）
            var wrap = document.getElementById(tid);
            if (!wrap) { _refreshing = false; return; }
            var overlay = document.createElement('div');
            overlay.id = tid + '_refresh_overlay';
            overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;' +
                'background:rgba(0,0,0,0.5);z-index:100;display:flex;' +
                'flex-direction:column;align-items:center;justify-content:center;gap:12px;' +
                'border-radius:6px;min-height:120px;';
            overlay.innerHTML = '<div style="font-size:28px;animation:spin 1s linear infinite;">⏳</div>' +
                '<div style="color:#ccc;font-size:14px;">正在刷新数据（前50行）...</div>' +
                '<button id="' + tid + '_cancel_refresh_btn" style="padding:6px 20px;border:1px solid #e74c3c;' +
                'border-radius:4px;background:rgba(255,255,255,0.1);color:#e74c3c;cursor:pointer;font-size:12px;">✕ 取消刷新</button>';
            wrap.style.position = 'relative';
            wrap.appendChild(overlay);
            // ★ 绑定取消按钮
            setTimeout(function(){
                var btn = document.getElementById(tid + '_cancel_refresh_btn');
                if (btn) btn.onclick = function() {
                    eel.cancel_query()();
                    _refreshing = false;
                    _hideRefreshOverlay();
                    var infoEl = document.getElementById(tid + '_pager_info');
                    if (infoEl) infoEl.textContent = '⏸ 刷新已取消';
                };
            }, 50);

            function _hideRefreshOverlay() {
                var ov = document.getElementById(tid + '_refresh_overlay');
                if (ov) ov.remove();
            }

            var whereSql3 = window['_activeWhereSql_'+tid] || '';
            eel.table_preview_data_fast(conn, db||activeDatabase, tn, sch, sortCol, sortDir, whereSql3)(function(r3){
                _hideRefreshOverlay();
                // ★ 用户已取消刷新，忽略此回调结果
                if (!_refreshing) {
                    var ie2 = document.getElementById(tid + '_pager_info');
                    if (ie2) ie2.textContent = '⏸ 刷新已取消';
                    return;
                }
                _refreshing = false;
                if (!r3 || !r3.ok) {
                    if (r3 && r3.cancelled) {
                        var ie2 = document.getElementById(tid + '_pager_info');
                        if (ie2) ie2.textContent = '⏸ 刷新已取消';
                        return;
                    }
                    showErrorDialog('刷新失败', r3 ? r3.msg : '未知错误');
                    return;
                }
                rows = r3.rows || [];
                comments = r3.comments || {};
                colTypes = r3.col_types || {};
                _totalCount = r3.total_count || rows.length;
                _hasMore = r3.has_more === true;
                _allLoaded = !_hasMore;
                // 清除编辑状态和选择状态
                _selectedRows = {};
                _lastClickedIdx = -1;
                _changedCells = {};
                _editing = false;
                _colFilteredPairs = null;
                _colFilters = {};
                _activeFilterCol = -1;
                // 更新 _whereStates 中的行数据
                if (st7) st7.rows = rows;
                // ★ 强制重新计算筛选条件（如果之前有 WHERE 条件）
                if (st7) {
                    st7.filteredCache = null;
                    st7.fcCount = null;
                }
                // 更新列筛选图标
                updateFilterIcons();
                // 重置分页到第一页
                _pageOffset = 0;
                _pageSize = 50;
                // 重新渲染
                render();
                updateDeleteBtn();
                updateSaveBtn();
                updateFilterIcons();
                updatePagerInfo();
                // 刷新完成，不弹窗
            });
        }
        window['_refreshData_'+tid] = refreshTableData;

        var h = '<div class="data-table-wrap" id="'+tid+'">';
        h += buildWhereBar(tid);
        h += '<div style="display:flex;align-items:center;gap:6px;margin:6px 0;flex-wrap:wrap;">' +
            '<button class="btn btn-sm" id="'+tid+'_refresh_btn" onclick="window[\'_refreshData_'+tid+'\']()" style="background:#3498db;color:#fff;font-size:10px;" title="重新从数据库加载最新数据">🔄 刷新</button>' +
            '<button class="btn btn-sm" id="'+tid+'_save_btn" onclick="window[\'_doSave_'+tid+'\']()" disabled style="background:#2ecc71;color:#fff;font-size:10px;">💾 保存 (0)</button>' +
            '<button class="btn btn-sm" id="'+tid+'_cancel_btn" onclick="window[\'_cancelEdit_'+tid+'\']()" disabled style="background:#e74c3c;color:#fff;font-size:10px;">↩ 取消修改</button>' +
            '<span style="flex:1;"></span>' +
            '<button class="btn btn-sm" id="'+tid+'_del_btn" onclick="window[\'_doDelete_'+tid+'\']()" disabled style="background:#e74c3c;color:#fff;font-size:10px;">🗑 删除 (0)</button>' +
            '<span style="font-size:10px;color:#666;">选中行后点击删除预览SQL</span></div>';
        h += '<div class="data-table-scroll"><table class="exp-table"><thead>';
        h += buildTh();
        h += '</thead><tbody id="'+tid+'_tbody"></tbody></table></div>';
        // 分页栏（固定在底部，不随表格滚动消失）
        // ★ 使用内联 onclick / onchange，避免 DOM 重建后事件丢失
        h += '<div class="data-pager" id="'+tid+'_pager">' +
            '<button id="'+tid+'_prev_btn" onclick="window[\'_goPage_'+tid+'\'](-1)">◀ 上一页</button>' +
            '<button id="'+tid+'_next_btn" onclick="window[\'_goPage_'+tid+'\'](1)">下一页 ▶</button>' +
            '<select id="'+tid+'_psize" onchange="window[\'_changePageSize_'+tid+'\']()">' +
                '<option value="50" selected>50行/页</option>' +
                '<option value="100">100行/页</option>' +
                '<option value="200">200行/页</option>' +
            '</select>' +
            '<span style="flex:1;"></span>' +
            '<span id="'+tid+'_pager_info" style="color:#888;"></span>' +
            '</div>';
        h += '</div>';

        addOrUpdateTab('data_'+tn, tn, 'data', h, db, cid);

        // ★ 分页按钮已使用内联 onclick（不依赖动态绑定，DOM 重建后不丢失）
        // 这里仅初始化分页状态 + tooltip
        setTimeout(function(){
            var pager = document.getElementById(tid+'_pager');
            if (!pager) return;
            updatePagerInfo();
            _initCellOverflowTooltip(tid);
        }, 0);


        // ★ 服务端排序：点击排序图标 → 后端按列排序返回前50条
        // 三态切换：点击同一列 → 升序→降序→恢复原序；点击不同列 → 升序
        var _origRows = rows.slice(); // 保存原始顺序的 rows 引用
        window['_origRows_' + tid] = _origRows;
        var _origSortRef = { col: -1, dir: 1 };

        // ★ 服务端排序：始终去后端查 50 条，按 order_col/order_dir 排序
        function clientSort(ci) {
            try {
                if (sortRef.col === ci) {
                    // 同一列：升序(1) → 降序(-1) → 恢复原序(col=-1)
                    if (sortRef.dir === 1) { sortRef.dir = -1; }
                    else { sortRef.col = -1; sortRef.dir = 1; }
                } else {
                    sortRef.col = ci; sortRef.dir = 1;
                }
                // 更新表头排序箭头（立即响应）
                var wrap2 = document.getElementById(tid);
                if (wrap2) {
                    var thead = wrap2.querySelector('thead');
                    if (thead) thead.innerHTML = buildTh();
                }
                // 显示加载状态
                var infoEl = document.getElementById(tid + '_pager_info');
                if (infoEl) infoEl.textContent = '⏳ 排序中...';
                // 构建排序参数
                var orderCol = sortRef.col >= 0 ? cols[sortRef.col] : '';
                var orderDir = sortRef.dir === 1 ? 'asc' : 'desc';
                // ★ 服务端排序：快速取前50条（与刷新/保存后重载一致），只排必要行数，携带当前 WHERE 筛选
                var whereSql2 = window['_activeWhereSql_'+tid] || '';
                eel.table_preview_data_fast(conn, _connDb, _connTn, _connSch, orderCol, orderDir, whereSql2)(function(r2){
                    if (!r2 || !r2.ok || !r2.rows) {
                        if (infoEl) infoEl.textContent = '排序失败';
                        return;
                    }
                    // 更新数据（fast 模式：最多50行 + has_more 标记）
                    rows = r2.rows;
                    comments = r2.comments || {};
                    colTypes = r2.col_types || {};
                    _totalCount = r2.total_count || rows.length;
                    _hasMore = r2.has_more === true;
                    _allLoaded = !_hasMore;
                    _pageSize = 50;
                    _origRows = rows.slice();
                    window['_origRows_' + tid] = _origRows;
                    var st5 = _whereStates[tid];
                    if (st5) st5.rows = rows;
                    // 清除列筛选缓存
                    _colFilteredPairs = null;
                    _pageOffset = 0;
                    render();
                    updatePagerInfo();
                    // 更新表头
                    if (wrap2) {
                        var thead2 = wrap2.querySelector('thead');
                        if (thead2) thead2.innerHTML = buildTh();
                    }
                    // ★ 不覆盖 infoEl，updatePagerInfo() 会根据 has_more 正确显示"前 50+ 条"
                });
            } catch(e) {
                console.error('clientSort error:', e);
            }
        }


        // SQL 辅助函数（用于生成 INSERT 语句）
        function _safeIdent(name) {
            // 简单标识符引用（反引号风格，兼容 MySQL/通用）
            return '`' + String(name).replace(/`/g, '``') + '`';
        }
        function _sqlValue(v) {
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'number') return String(v);
            // 尝试识别纯数字字符串
            var s = String(v);
            if (s === '') return "''";
            // 检查是否为整数或浮点数
            if (/^-?\d+(\.\d+)?$/.test(s.trim())) return s.trim();
            // 字符串值：单引号转义
            return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
        }

        // 行右键菜单：复制行数据 / 复制为 INSERT SQL
        function _rowCtxHandler(e, origIdx) {
            e.preventDefault(); e.stopPropagation();
            var row = rows[origIdx];
            if (!row) return;
            // 生成制表符分隔的行文本
            var rowText = row.map(function(v){ return v===null?'NULL':String(v); }).join('\t');
            // 生成 INSERT SQL
            var colNames = cols.map(function(c){ return _safeIdent(c); }).join(', ');
            var values = row.map(function(v, i){
                return _sqlValue(v);
            }).join(', ');
            var sql = 'INSERT INTO ' + _safeIdent(tn) + ' (' + colNames + ') VALUES (' + values + ');';
            showCtxMenu(e.clientX, e.clientY, [
                {label:'📋 复制', action:function(){ copyToClipboard(rowText); }},
                {label:'📋 复制为 INSERT 语句', action:function(){ copyToClipboard(sql); }}
            ]);
        }

        // 排序事件处理函数：只响应点击排序图标（不再点击整列）
        function _sortClickIconHandler(ci) {
            clientSort(ci);
        }

        // 暴露给 onclick/oncontextmenu 的函数
        window['_sortClickIcon_'+tid] = _sortClickIconHandler;
        window['_rowCtx_'+tid] = _rowCtxHandler;

        setTimeout(function(){
            render();
        }, 150);
}

// 取消数据排序
function cancelDataSort(cancelKey, tid) {
    window[cancelKey] = true;
    eel.cancel_query()();
    // 错误提示显示在 WHERE 栏，不遮挡列头
    updateWhereCount(tid, 0, _whereStates[tid]?(_whereStates[tid].rows||[]).length:0);
    var cnt2 = document.getElementById(tid+'_count');
    if (cnt2) { cnt2.textContent = '⏸ 排序已取消'; cnt2.style.color = '#f39c12'; }
    // 重置排序状态
    var st = _whereStates[tid];
    if (st && st.sortRef) { st.sortRef.col = -1; st.sortRef.dir = 1; }
    setTimeout(function(){
        var wrap2 = document.getElementById(tid);
        if (wrap2) {
            var thead2 = wrap2.querySelector('thead');
            if (thead2) {
                // ★ 复用 buildTh（含注释/类型/flex 布局），避免取消排序后表头丢失注释
                var buildThFn = window['_buildTh_'+tid];
                if (buildThFn) {
                    thead2.innerHTML = buildThFn();
                } else {
                    var st2 = _whereStates[tid];
                    var cols2 = st2 ? st2.cols : [];
                    var sortRef2 = st2 ? st2.sortRef : null;
                    var types2 = st2 ? (st2.colTypes || {}) : {};
                    if (cols2.length) {
                        var h = '<tr><th class="row-sel-header" id="'+tid+'_sel_all" onclick="window[\'_toggleSelAll_'+tid+'\']()" title="全选/取消全选">#</th>';
                        cols2.forEach(function(c,ci){
                            var cType = types2[c] || '';
                            var sortIcon = '▽';
                            if (sortRef2 && sortRef2.col === ci) { sortIcon = sortRef2.dir === 1 ? '▲' : '▼'; }
                            var typeLen = cType ? cType.length : 0;
                            var colMinWidth = typeLen > 25 ? (typeLen > 35 ? 220 : 180) : (typeLen > 12 ? 140 : 90);
                            h += '<th class="sortable-th" data-ci="'+ci+'" data-orig="'+escapeAttr(c)+'" style="user-select:none;min-width:'+colMinWidth+'px;">';
                            h += '<div class="th-content">';
                            h += '<div class="th-line th-line-name">'+escapeHtml(c)+'</div>';
                            if (cType) h += '<div class="th-line th-line-type">'+escapeHtml(cType)+'</div>';
                            else h += '<div class="th-line th-line-type"></div>';
                            h += '<div class="th-line th-line-cmt"></div>';
                            h += '</div>';
                            h += '<div class="th-icons">';
                            h += '<span class="col-filter-icon" data-ci="'+ci+'" style="cursor:pointer;font-size:12px;opacity:0.25;color:#aaa;" onclick="event.stopPropagation();window[\'_toggleColFilter_'+tid+'\']('+ci+',this)">⏳</span>';
                            h += '<span class="sort-icon" data-ci="'+ci+'" title="点击排序" style="cursor:pointer;display:inline-block;width:20px;text-align:center;font-size:11px;color:#888;" onclick="event.stopPropagation();window[\'_sortClickIcon_'+tid+'\']('+ci+')">'+sortIcon+'</span>';
                            h += '</div></th>';
                        });
                        h += '</tr>';
                        thead2.innerHTML = h;
                    }
                }
            }
        }
    }, 400);
}

function addTableDDLTab(tn, db, schema, cid) {
    var conn = cid ? (treeData && treeData.connections ? treeData.connections[cid] : null) : activeConnData;
    var sch = schema || '';
    var tabId = 'ddl_' + tn;
    // ★ 关键：立即捕获 db 值（禁止在回调里再用 activeDatabase 兜底，防止全局变量竞态）
    var theDb = db || activeDatabase;
    var theCid = cid || activeConnId || '';
    // ★ 防御：连接信息为空时直接报错，避免卡在"加载中"
    if (!conn || !conn.host) {
        addOrUpdateTab(tabId, tn, 'ddl', '<div style="padding:20px;color:#e74c3c;">❌ 未找到连接信息，请先在左侧树中选择数据库后再试</div>', theDb, theCid);
        return;
    }
    addOrUpdateTab(tabId, tn, 'ddl', '<div style="padding:20px;color:#999;">⏳ 加载表设计...</div>', theDb, theCid);

    try {
        eel.table_get_design_info(conn, theDb, tn, sch)(function(r) {
            try {
                if (!r || !r.ok) {
                    addOrUpdateTab(tabId, tn, 'ddl', '<div style="padding:20px;color:#e74c3c;">❌ ' + (r ? escapeHtml(r.msg) : '加载失败，请检查连接') + '</div>', theDb, theCid);
                    return;
                }
                var design = r.design || {columns:[], indexes:[], foreign_keys:[], table_options:{}};
                // ★ 多 Tab 支持：按 tabId 存储设计数据，不再使用全局单例
                window._tableDesigns = window._tableDesigns || {};
                window._tableDesigns[tabId] = { conn: conn, db: theDb, tn: tn, schema: sch, cid: theCid, design: design, tabId: tabId };
                // 向后兼容：保留 _tableDesign 指向最后打开的（旧代码可能依赖）
                if (activeObjTab === tabId) {
                    window._tableDesign = window._tableDesigns[tabId];
                }
                buildDesignerUI(tabId, tn, design);
            } catch(e) {
                addOrUpdateTab(tabId, tn, 'ddl', '<div style="padding:20px;color:#e74c3c;">❌ 渲染失败: ' + escapeHtml(String(e)) + '</div>', theDb, theCid);
            }
        });
    } catch(e) {
        // ★ eel 调用本身抛异常（如函数未注册等）
        addOrUpdateTab(tabId, tn, 'ddl', '<div style="padding:20px;color:#e74c3c;">❌ 调用失败: ' + escapeHtml(String(e)) + '</div>', theDb, theCid);
    }
}

function buildDesignerUI(tabId, tn, design) {
    var cols = design.columns || [];
    var idxs = design.indexes || [];
    var fks = design.foreign_keys || [];
    var opts = design.table_options || {};

    // ★ 根据当前 tabId 对应的连接类型，动态选择字段类型列表
    var _ds = window._tableDesigns && window._tableDesigns[tabId];
    var _dbType = (_ds && _ds.conn && _ds.conn.db_type) || 'mysql';
    var _dtInfo = (typeof _getDataTypesForDB === 'function') ? _getDataTypesForDB(_dbType) : null;
    var dataTypes = _dtInfo ? _dtInfo.types : ['INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'FLOAT', 'DOUBLE', 'DECIMAL',
        'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYTEXT',
        'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
        'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'TINYBLOB', 'JSON', 'ENUM', 'SET', 'BOOLEAN'];

    // ---- 字段表格 ----
    var rowsHtml = '';
    for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        rowsHtml += buildFieldRow(i, c, dataTypes);
    }

    var fieldsHtml =
        '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button class="btn btn-sm" onclick="designAddField()" style="background:#27ae60;color:#fff;">+ 添加字段</button>' +
            '<button class="btn btn-sm" onclick="designInsertField(-1)" style="background:#2980b9;color:#fff;">↑ 顶部插入</button>' +
        '</div>' +
        '<div style="overflow-x:auto;flex:1;min-height:0;">' +
            '<table class="design-table" id="design_fields_table">' +
                '<thead><tr>' +
                    '<th style="width:30px;">#</th>' +
                    '<th style="min-width:120px;">字段名</th>' +
                    '<th style="min-width:110px;">类型</th>' +
                    '<th style="width:60px;">长度</th>' +
                    '<th style="width:50px;">Null</th>' +
                    '<th style="min-width:90px;">默认值</th>' +
                    '<th style="width:45px;">自增</th>' +
                    '<th style="min-width:60px;">注释</th>' +
                    '<th style="width:80px;">操作</th>' +
                '</tr></thead>' +
                '<tbody>' + rowsHtml + '</tbody>' +
            '</table>' +
        '</div>';

    // ---- 索引表格 ----
    var idxHtml = '<div style="margin-bottom:8px;"><button class="btn btn-sm" onclick="designAddIndex()" style="background:#27ae60;color:#fff;">+ 添加索引</button></div>';
    if (idxs.length) {
        idxHtml += '<table class="design-table"><thead><tr><th>索引名</th><th>类型</th><th>字段</th><th>方法</th><th style="width:60px;">操作</th></tr></thead><tbody>';
        for (var j = 0; j < idxs.length; j++) {
            var x = idxs[j];
            idxHtml += '<tr>' +
                '<td><input class="design-input idx-name" value="' + escapeAttr(x.name) + '" data-idx="' + j + '"></td>' +
                '<td><select class="design-select idx-type" data-idx="' + j + '"><option value="INDEX"' + (x.type === 'INDEX' ? ' selected' : '') + '>INDEX</option><option value="UNIQUE"' + (x.type === 'UNIQUE' ? ' selected' : '') + '>UNIQUE</option><option value="PRIMARY"' + (x.type === 'PRIMARY' ? ' selected' : '') + '>PRIMARY</option></select></td>' +
                '<td><input class="design-input idx-cols" value="' + escapeAttr((x.columns || []).join(', ')) + '" data-idx="' + j + '" placeholder="字段名,逗号分隔"></td>' +
                '<td><select class="design-select idx-method" data-idx="' + j + '"><option value="BTREE"' + (x.method === 'BTREE' ? ' selected' : '') + '>BTREE</option><option value="HASH"' + (x.method === 'HASH' ? ' selected' : '') + '>HASH</option></select></td>' +
                '<td><button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;" onclick="designRemoveIndex(' + j + ')">✕</button></td>' +
            '</tr>';
        }
        idxHtml += '</tbody></table>';
    } else {
        idxHtml += '<div style="color:#888;font-size:11px;padding:8px;">（无索引）</div>';
    }

    // ---- 外键 ----
    var fkHtml = '';
    if (fks.length) {
        fkHtml = '<table class="design-table"><thead><tr><th>外键名</th><th>本表字段</th><th>参照表</th><th>参照字段</th><th>ON DELETE</th><th>ON UPDATE</th></tr></thead><tbody>';
        for (var k = 0; k < fks.length; k++) {
            var f = fks[k];
            fkHtml += '<tr><td>' + escapeHtml(f.name) + '</td><td>' + escapeHtml(f.column) + '</td><td>' + escapeHtml(f.ref_table) + '</td><td>' + escapeHtml(f.ref_column) + '</td><td>' + escapeHtml(f.on_delete) + '</td><td>' + escapeHtml(f.on_update) + '</td></tr>';
        }
        fkHtml += '</tbody></table>';
    } else {
        fkHtml = '<div style="color:#888;font-size:11px;padding:8px;">（无外键）</div>';
    }

    // ---- 表属性 ----
    var engines = ['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV'];
    var collations = ['utf8mb4_unicode_ci', 'utf8mb4_general_ci', 'utf8_unicode_ci', 'utf8_general_ci', 'latin1_swedish_ci'];
    var engOpts = engines.map(function(e) { return '<option value="' + e + '"' + (opts.engine === e ? ' selected' : '') + '>' + e + '</option>'; }).join('');
    var colOpts = collations.map(function(c) { return '<option value="' + c + '"' + (opts.collation === c ? ' selected' : '') + '>' + c + '</option>'; }).join('');
    var propsHtml =
        '<table class="design-table" style="max-width:500px;"><tbody>' +
            '<tr><td style="width:80px;">存储引擎</td><td><select class="design-select" id="design_engine">' + engOpts + '</select></td></tr>' +
            '<tr><td>字符集</td><td><select class="design-select" id="design_collation">' + colOpts + '</select></td></tr>' +
            '<tr><td>表注释</td><td><input class="design-input" id="design_comment" value="' + escapeAttr(opts.comment || '') + '" style="width:100%;"></td></tr>' +
        '</table>';

    // ---- 组装完整 HTML ----
    var html =
        '<div class="designer-container">' +
            '<div class="designer-toolbar">' +
                '<b style="font-size:13px;">🔧 设计表：' + escapeHtml(tn) + '</b>' +
                '<div style="display:flex;gap:6px;">' +
                    '<button class="btn btn-sm btn-design-sql" style="font-size:10px;" onclick="designViewDDL()">📄 查看SQL</button>' +
                    '<button class="btn btn-sm" style="background:#2980b9;color:#fff;" onclick="designRefresh()">🔄 刷新</button>' +
                    '<button class="btn btn-sm" style="background:#27ae60;color:#fff;" onclick="designSave()">💾 保存</button>' +
                '</div>' +
            '</div>' +
            '<div class="designer-subtabs" id="design_subtabs">' +
                '<button class="designer-subtab active" onclick="designSwitchTab(\'fields\')">📋 字段</button>' +
                '<button class="designer-subtab" onclick="designSwitchTab(\'indexes\')">🔑 索引</button>' +
                '<button class="designer-subtab" onclick="designSwitchTab(\'fks\')">🔗 外键</button>' +
                '<button class="designer-subtab" onclick="designSwitchTab(\'props\')">⚙ 表属性</button>' +
            '</div>' +
            '<div class="designer-panes">' +
                '<div class="designer-pane active" id="design_pane_fields">' + fieldsHtml + '</div>' +
                '<div class="designer-pane" id="design_pane_indexes">' + idxHtml + '</div>' +
                '<div class="designer-pane" id="design_pane_fks">' + fkHtml + '</div>' +
                '<div class="designer-pane" id="design_pane_props">' + propsHtml + '</div>' +
            '</div>' +
        '</div>';

    // ★ 从 _tableDesigns 中读取 db/cid，确保关闭数据库时能正确清理 tab
    var _ds = window._tableDesigns && window._tableDesigns[tabId];
    var _ddb = _ds ? _ds.db || '' : '';
    var _dcid = _ds ? _ds.cid || '' : '';
    addOrUpdateTab(tabId, tn, 'ddl', html, _ddb, _dcid);
}

function buildFieldRow(i, c, dataTypes) {
    var typeOpts = dataTypes.map(function(t) {
        return '<option value="' + t + '"' + ((c.data_type || '').toUpperCase() === t ? ' selected' : '') + '>' + t + '</option>';
    }).join('');
    var len = c.length || '';
    if (!len && c.col_type && typeof c.col_type === 'string') {
        var m = c.col_type.match(/\((\d+)(?:,(\d+))?\)/);
        if (m) len = m[2] ? m[1] + ',' + m[2] : m[1];
    }
    var defVal = c.default_val || '';
    // 清理 default 值（去掉多余的单引号包裹层）
    if (defVal && typeof defVal === 'string' && defVal.startsWith("'") && defVal.length > 2) defVal = defVal.slice(1, -1);
    return '<tr data-row="' + i + '">' +
        '<td style="text-align:center;color:#888;">' + (i + 1) + '</td>' +
        '<td><input class="design-input field-name" value="' + escapeAttr(c.name) + '" data-row="' + i + '" data-field="name"></td>' +
        '<td><select class="design-select field-type" data-row="' + i + '" data-field="data_type">' + typeOpts + '</select></td>' +
        '<td><input class="design-input field-len" value="' + escapeAttr(len) + '" data-row="' + i + '" data-field="length" style="width:55px;"></td>' +
        '<td style="text-align:center;"><input type="checkbox" class="field-null" data-row="' + i + '" data-field="nullable"' + (c.nullable ? ' checked' : '') + '></td>' +
        '<td><input class="design-input field-default" value="' + escapeAttr(defVal) + '" data-row="' + i + '" data-field="default_val"></td>' +
        '<td style="text-align:center;"><input type="checkbox" class="field-autoinc" data-row="' + i + '" data-field="auto_increment"' + (c.auto_increment ? ' checked' : '') + '></td>' +
        '<td><input class="design-input field-comment" value="' + escapeAttr(c.comment || '') + '" data-row="' + i + '" data-field="comment"></td>' +
        '<td style="white-space:nowrap;">' +
            '<button class="btn btn-sm" style="background:#2980b9;color:#fff;font-size:10px;padding:2px 5px;" onclick="designInsertField(' + i + ')" title="上方插入">⬆</button> ' +
            '<button class="btn btn-sm" style="background:#e67e22;color:#fff;font-size:10px;padding:2px 5px;" onclick="designInsertField(' + (i + 1) + ')" title="下方插入">⬇</button> ' +
            '<button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;padding:2px 5px;" onclick="designRemoveField(' + i + ')">✕</button>' +
        '</td></tr>';
}

// ==================== 查看DDL弹窗 ====================
function showTableDDLDialog(tn, db, schema, cid, conn) {
    var sch = schema || '';
    var theDb = db;
    var theCid = cid || activeConnId || '';
    var theConn = conn || activeConnData;
    document.getElementById('modal_icon').innerHTML = '📄';
    document.getElementById('modal_title').textContent = 'DDL：' + tn;
    document.getElementById('modal_title').style.color = '#4fc3f7';
    document.getElementById('modal_msg').innerHTML = '<div style="color:#888;padding:20px;text-align:center;">⏳ 加载中...</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';
    document.getElementById('modal_overlay').classList.add('show');
    eel.table_get_ddl(theConn, theDb, tn, sch)(function(r) {
        var ddlHtml;
        if (r && r.ok && r.ddl) {
            ddlHtml = '<pre id="ddl_viewer_pre" style="background:#0d1117;border:1px solid #333;border-radius:6px;padding:12px;font-family:Consolas,monospace;font-size:11px;color:#e0e0e0;white-space:pre-wrap;word-break:break-all;max-height:450px;overflow-y:auto;margin:0 0 12px 0;text-align:left;">' + escapeHtml(r.ddl) + '</pre>';
            document.getElementById('modal_btns').innerHTML =
                '<button class="btn btn-gray" onclick="hideModal()">关闭</button>' +
                '<button class="btn btn-blue" onclick="copyDDLContent()">📋 复制DDL</button>';
        } else {
            ddlHtml = '<div style="color:#e74c3c;">❌ ' + escapeHtml(r ? r.msg : '加载失败') + '</div>';
            document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';
        }
        document.getElementById('modal_msg').innerHTML = ddlHtml;
    });
}
function copyDDLContent() {
    var pre = document.getElementById('ddl_viewer_pre');
    if (pre) { copyToClipboard(pre.textContent); showOkDialog('成功', 'DDL 已复制到剪贴板'); }
}
