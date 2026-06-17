// ==================== 对象面板 ====================
function buildObjHomeContent(items, cat, db, schema, cid) {
    var sch = schema || '';
    var h = '';
    if (cat === 'tables') {
        h += '<table class="exp-table"><thead><tr><th style="width:28%">名称</th><th style="width:10%;text-align:right;">行</th><th style="width:12%;text-align:right;">数据长度</th><th style="width:22%">修改日期</th><th style="width:28%">注释</th></tr></thead><tbody>';
        items.forEach(function(t){h+='<tr draggable="true" class="drag-table-item" ondragstart="onTableDragStart(event,\''+escapeAttr(t.name)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+(cid||'')+'\')" ondragend="onTableDragEnd(event)" ondblclick="addTableDataTab(\''+escapeAttr(t.name)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+(cid||'')+'\')" oncontextmenu="tableCtx(event,\''+escapeAttr(t.name)+'\',\''+escapeAttr(db)+'\',\''+escapeAttr(sch)+'\',\''+(cid||'')+'\')"><td>'+escapeHtml(t.name)+'</td><td style="text-align:right;">'+escapeHtml(String(t.rows||''))+'</td><td style="text-align:right;">'+escapeHtml(t.data_size||'')+'</td><td>'+escapeHtml(t.update_time||'')+'</td><td>'+escapeHtml(t.comment||'')+'</td></tr>';});
        h += '</tbody></table>';
    } else if (cat === 'views') {
        h += '<table class="exp-table"><thead><tr><th style="width:60%">名称</th><th style="width:40%">数据库</th></tr></thead><tbody>';
        items.forEach(function(v){h+='<tr><td>'+escapeHtml(v.name)+'</td><td>'+escapeHtml(db)+'</td></tr>';});
        h += '</tbody></table>';
    } else {
        h += '<table class="exp-table"><thead><tr><th style="width:50%">名称</th><th style="width:30%">类型</th><th style="width:20%">数据库</th></tr></thead><tbody>';
        items.forEach(function(p){h+='<tr><td>'+escapeHtml(p.name)+'</td><td>'+escapeHtml(p.type||cat)+'</td><td>'+escapeHtml(db)+'</td></tr>';});
        h += '</tbody></table>';
    }
    if (!items.length) h += '<div style="padding:20px;color:#999;">（无数据）</div>';
    else {
        var catLabel = cat==='tables'?'张表':cat==='views'?'个视图':cat==='procedures'?'个存储过程':cat==='functions'?'个函数':'项';
        h += '<div style="text-align:right;padding:4px 10px;color:#666;font-size:11px;">共 '+items.length+' '+catLabel+'</div>';
    }
    return h;
}

// 对象面板接受拖拽 drop（拖表到对象窗口 = 同步到当前显示的数据库）
function setupObjectPanelDrop() {
    var panel = document.getElementById('object_panel');
    if (!panel || panel._dropReady) return;
    panel._dropReady = true;
    panel.addEventListener('dragover', function(e) {
        if (!_dragInfo || !activeConnId || !activeDatabase) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        // 拖拽源来自对象面板内部时不显示高亮
        if (!panel.contains(e.target) || _dragInfo.src_cid !== activeConnId) {
            panel.classList.add('drop-target');
        }
    });
    panel.addEventListener('dragleave', function(e) {
        // 对象面板内部元素较多，直接用 relatedTarget 判断是否真正离开面板
        if (!panel.contains(e.relatedTarget)) {
            panel.classList.remove('drop-target');
        }
    });
    panel.addEventListener('drop', function(e) {
        e.preventDefault();
        panel.classList.remove('drop-target');
        if (!_dragInfo || !activeConnId || !activeDatabase) return;
        var src = _dragInfo;
        var srcConn = treeData && treeData.connections ? treeData.connections[src.src_cid] : null;
        var dstConn = treeData && treeData.connections ? treeData.connections[activeConnId] : null;
        if (!srcConn || !dstConn) return;
        showDragCopyDialog(src.table_name, src.src_db, src.schema, srcConn, activeConnId, activeDatabase, dstConn);
        _dragInfo = null;
    });
}

function renderObjectPanel() {
    var panel = document.getElementById('object_panel');
    // ★ 在销毁 DOM 之前，保存当前活跃 tab 中所有 textarea 的内容到 objectTabs
    if (panel) {
        // ★ 对于 query 类型 tab，使用 _syncQueryContent 保存完整内容
        var layouts = panel.querySelectorAll('[id^="ql_"]');
        for (var li = 0; li < layouts.length; li++) {
            var layoutId = layouts[li].id;
            if (layoutId.indexOf('ql_') === 0) {
                var qidSync = layoutId.substring(3);
                _syncQueryContent(qidSync);
            }
        }
        var textareas = panel.querySelectorAll('textarea');
        for (var ti = 0; ti < textareas.length; ti++) {
            var ta = textareas[ti];
            if (!ta.id) continue;
            // 跳过已被 _syncQueryContent 处理的 query textarea
            if (ta.id.indexOf('sq_') === 0) continue;
            for (var j = 0; j < objectTabs.length; j++) {
                var t = objectTabs[j];
                if (t.content.indexOf('id="' + ta.id + '"') !== -1) {
                    t.content = t.content.replace(
                        new RegExp('(<textarea[^>]*id="' + ta.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>)([\\s\\S]*?)(</textarea>)', 'i'),
                        '$1' + escapeHtml(ta.value) + '$3'
                    );
                    break;
                }
            }
        }
        // ★ 保存 query tab 的结果区域（qr_xxx）到独立缓存，作为双重保险
        var qrDivs = panel.querySelectorAll('[id^="qr_"]');
        for (var qi = 0; qi < qrDivs.length; qi++) {
            var qrd = qrDivs[qi];
            var qid2 = qrd.id.replace(/^qr_/, '');
            if (_queryEditStates[qid2]) {
                _queryEditStates[qid2]._cachedHtml = qrd.innerHTML;
            }
        }
    }

    // 增量更新 tab 栏和内容区域，避免全量 innerHTML 重建
    var tabBar = document.getElementById('obj_tabs_bar');
    var h = '';
    objectTabs.forEach(function(t){
        var cls = t.id===activeObjTab?'obj-tab active':'obj-tab';
        var icon = t.type==='ddl'?'🔧 ':t.type==='data'?'📊 ':t.type==='query'?'📝 ':'📋 ';
        h += '<span class="'+cls+'" data-tabid="'+t.id+'" onclick="switchObjTab(\''+t.id+'\')">'+icon+escapeHtml(t.label);
        if(t.id!=='obj_home') h += '<span class="tab-close" onclick="event.stopPropagation();closeTab(\''+t.id+'\')">✕</span>';
        h += '</span>';
    });
    if (activeObjTab === 'obj_home') h += '<div class="obj-search-wrap"><input class="obj-search-input" id="obj_search" placeholder="🔍 搜索表名..." oninput="filterObjectTable()"></div>';

    if (tabBar) {
        // 增量更新 tab 栏（避免 innerHTML 销毁重建事件）
        tabBar.innerHTML = h;
    } else {
        // 首次渲染：创建完整结构
        var at = objectTabs.find(function(t){return t.id===activeObjTab;});
        panel.innerHTML = '<div class="obj-tabs" id="obj_tabs_bar">' + h + '</div><div class="obj-content" id="obj_content">' + (at ? at.content : '') + '</div>';
        setTimeout(function() {
            collapseOverflowTabs();
            highlightTableRow();
            setupObjectPanelDrop();
        }, 50);
        return;
    }

    // 增量更新内容区域
    var contentDiv = document.getElementById('obj_content');
    var at2 = objectTabs.find(function(t){return t.id===activeObjTab;});
    if (contentDiv && at2) {
        contentDiv.innerHTML = at2.content;
        // ★ data/redis 类型 tab 切换后，重新调用 render 填充 tbody
        if (at2.type === 'data' || at2.type === 'redis') {
            var tid2 = _tabIdToTid[activeObjTab];
            if (tid2) {
                var st2 = _whereStates[tid2];
                if (st2 && st2.onRender) {
                    setTimeout(function(){ st2.onRender(); }, 0);
                }
                // ★ 重新绑定排序事件（DOM 重建后旧监听器已丢失）
                var bindSortFn = window['_bindSort_'+tid2];
                if (bindSortFn) {
                    setTimeout(function(){ bindSortFn(); }, 50);
                }
                // ★ 重新绑定分页按钮（DOM 重建后旧监听器已丢失）
                setTimeout(function(){
                    var prevBtn2 = document.getElementById(tid2+'_prev_btn');
                    var nextBtn2 = document.getElementById(tid2+'_next_btn');
                    var showAllBtn2 = document.getElementById(tid2+'_showall_btn');
                    var psizeSel2 = document.getElementById(tid2+'_psize');
                    if (prevBtn2) prevBtn2.onclick = function(){ window['_goPage_'+tid2](-1); };
                    if (nextBtn2) nextBtn2.onclick = function(){ window['_goPage_'+tid2](1); };
                    if (showAllBtn2) showAllBtn2.onclick = function(){ window['_showAllRows_'+tid2](); };
                    if (psizeSel2) psizeSel2.onchange = function(){ window['_changePageSize_'+tid2](); };
                }, 50);
            }
        }
        // ★ query 类型 tab 切换后，重新绑定事件 + 恢复结果（保留数据不丢失）
        if (at2.type === 'query') {
            var qm = activeObjTab.match(/^query_(.+)$/);
            if (qm) {
                var qid3 = qm[1];
                // ★ 切换到 query tab 时，强制清理可能卡死的 _execRunning 标志（防止切换后永远无法执行）
                if (_execRunning[qid3]) {
                    _execRunning[qid3] = false;
                }
                if (_execCancelFlags[qid3]) {
                    _execCancelFlags[qid3] = false;
                }
                // ★ 重新绑定 textarea 事件（使用 setTimeout 确保 DOM 完全构建）
                (function(qidX) {
                    setTimeout(function() {
                        var esX = _queryEditStates[qidX];
                        var sqlTa = document.getElementById('sq_' + qidX);
                        var sqlBtn = document.getElementById('btn_exe_' + qidX);
                        if (!sqlTa || !sqlBtn) return;
                        // ★ 强制复位按钮状态为"执行"（无论之前是什么状态）
                        sqlBtn.textContent = '▶ 执行';
                        sqlBtn.style.background = '#2ecc71';
                        // ★ 先恢复 textarea value
                        if (esX && Object.prototype.hasOwnProperty.call(esX, '_cachedSql')) {
                            sqlTa.value = esX._cachedSql;
                        } else {
                            var cachedTab = objectTabs.find(function(t){ return t.id === 'query_' + qidX; });
                            if (cachedTab && Object.prototype.hasOwnProperty.call(cachedTab, '_cachedSql')) {
                                sqlTa.value = cachedTab._cachedSql;
                            }
                        }
                        // 更新按钮标签 + 绑定所有必要事件
                        var updateBtnLabel = function() {
                            if (!sqlBtn || sqlBtn.textContent.indexOf('⏹') === 0) return;
                            if (!sqlTa) return;
                            var s = sqlTa.selectionStart, e = sqlTa.selectionEnd;
                            sqlBtn.textContent = (s !== e) ? '▶ 执行选中' : '▶ 执行';
                        };
                        sqlTa.addEventListener('mouseup', updateBtnLabel);
                        sqlTa.addEventListener('keyup', updateBtnLabel);
                        sqlTa.addEventListener('input', function(){ _queryTextareaChanged(qidX, sqlTa); });
                        // ★ 重新绑定 Ctrl+Enter 执行和 Ctrl+S 保存
                        var curTab = objectTabs.find(function(t){ return t.id === 'query_' + qidX; });
                        var cid2 = curTab ? curTab.cid : '';
                        var qdb2 = curTab ? curTab.db : '';
                        var qname2 = curTab ? curTab.label : '';
                        sqlTa.addEventListener('keydown', function(e){
                            if(e.ctrlKey && e.key === 'Enter') { e.preventDefault(); execQueryTab(qidX); }
                            if(e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveQueryTab(qidX, cid2, qdb2, qname2); }
                        });
                        updateBtnLabel();
                    }, 0);
                })(qid3);
                // ★ 恢复查询结果：优先从结构化数据重新渲染（最可靠），其次从缓存 HTML 恢复
                var es = _queryEditStates[qid3];
                (function(qidR, esR) {
                    function doRestore() {
                        var rdiv = document.getElementById('qr_' + qidR);
                        if (!rdiv) return;
                        if (esR && esR.columns && esR.columns.length > 0) {
                            _qRenderTable(qidR);
                            return;
                        }
                        var hasResults = rdiv.querySelector('.exp-table') || rdiv.querySelector('table');
                        var textOnly = rdiv.textContent.trim();
                        var hasUsefulText = textOnly && textOnly !== '' && !/^\s*$/.test(textOnly);
                        if (!hasResults && !hasUsefulText && esR && esR._cachedHtml) {
                            rdiv.innerHTML = esR._cachedHtml;
                        }
                    }
                    setTimeout(doRestore, 20);
                    // ★ 二次确认，防止时序导致结果被清空
                    setTimeout(function() {
                        var rdiv2 = document.getElementById('qr_' + qidR);
                        if (!rdiv2) return;
                        var hasTable2 = rdiv2.querySelector('.exp-table') || rdiv2.querySelector('table');
                        var txt2 = rdiv2.textContent.trim();
                        var empty2 = !hasTable2 && (!txt2 || /^\s*$/.test(txt2));
                        if (empty2 && esR && esR.columns && esR.columns.length > 0) {
                            _qRenderTable(qidR);
                        } else if (empty2 && esR && esR._cachedHtml) {
                            rdiv2.innerHTML = esR._cachedHtml;
                        }
                    }, 80);
                })(qid3, es);
            }
        }
    }

    // 延迟执行次要任务：恢复 splitter 绑定、溢出 tab 处理等
    requestAnimationFrame(function() {
        collapseOverflowTabs();
        highlightTableRow();
        setupObjectPanelDrop();
        // 为所有 query layout 重新绑定分隔线拖动
        var layouts = contentDiv ? contentDiv.querySelectorAll('.query-layout') : [];
        for (var li = 0; li < layouts.length; li++) {
            var layoutEl = layouts[li];
            if (!layoutEl.id || layoutEl.id.indexOf('ql_') !== 0) continue;
            var qid2 = layoutEl.id.substring(3);
            // ★ 先清除标记，因为 innerHTML 已重建 DOM，旧事件监听器已失效
            delete _querySplitterInited['qs_' + qid2];
            initQuerySplitter('ql_' + qid2, 'qs_' + qid2, 'sq_' + qid2, 'qr_' + qid2);
        }
    });
}

function _queryTextareaChanged(qid, ta) {
    if (!qid || !ta) return;
    var es = _qState(qid);
    es._cachedSql = ta.value;
    var tab = objectTabs.find(function(t){ return t.id === 'query_' + qid; });
    if (tab) tab._cachedSql = ta.value;
}

function filterObjectTable() {
    var kw = (document.getElementById('obj_search')||{}).value||'';

    // ★ Redis 面板：服务端搜索，遍历所有 key
    if (_redisPanelCtx && activeObjTab === 'obj_home') {
        clearTimeout(_redisSearchTimer);
        _redisSearchTimer = setTimeout(function() {
            _redisDoServerSearch(_redisPanelCtx.cid, _redisPanelCtx.dbIdx, _redisPanelCtx.dbId, kw);
        }, 300);
        return;
    }

    var content = document.getElementById('obj_content');
    if (!content) return;
    var rows = content.querySelectorAll('.exp-table tbody tr');
    var cnt = 0;
    rows.forEach(function(tr){
        // 找到第一个 td（通常是名称列）
        var td = tr.querySelector('td');
        if (!td) return;
        var text = (td.textContent || '').toLowerCase();
        var match = !kw || text.indexOf(kw.toLowerCase()) !== -1;
        tr.style.display = match ? '' : 'none';
        if (match) cnt++;
    });
    // 更新计数
    var infoEl = content.querySelector('.obj-search-info');
    if (!kw) {
        if (infoEl) infoEl.textContent = '';
    } else {
        if (!infoEl) {
            infoEl = document.createElement('div');
            infoEl.className = 'obj-search-info';
            infoEl.style.cssText = 'padding:2px 10px;color:#888;font-size:11px;text-align:right;';
            var tbl = content.querySelector('.exp-table');
            if (tbl && tbl.parentElement) tbl.parentElement.insertBefore(infoEl, tbl);
        }
        infoEl.textContent = '搜索：' + cnt + ' 个匹配';
    }
}

var _redisSearchTimer = null;
// 服务端搜索：用 SCAN + match pattern 遍历全部 key
function _redisDoServerSearch(cid, dbIdx, dbId, kw) {
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) return;

    var pattern = kw ? '*' + kw + '*' : '*';
    // 搜索时限制放宽到 500 条，用 SCAN 遍历全部
    eel.redis_get_keys(conn, pattern, 500, dbIdx)(function(r) {
        if (!r || !r.ok) return;
        var keys = [];
        (r.groups || []).forEach(function(g) { keys = keys.concat(g.keys); });
        var total = r.total;

        var displayKeys = keys.slice(0, 500);
        var content = '<div style="padding:2px 10px;color:#888;font-size:11px;">搜索 "' + escapeHtml(kw) + '"：共 ' + total + ' 个 key'
            + (keys.length > 500 ? '（显示前 500 个）' : '') + '</div>';
        content += '<table class="exp-table"><thead><tr><th style="width:60%">Key</th><th style="width:40%;text-align:right;">类型</th></tr></thead><tbody>';
        displayKeys.forEach(function(k) {
            content += '<tr class="redis-key-row" style="" ondblclick="redisShowKey(\'' + cid + '\',\'' + escapeAttr(k) + '\',' + dbIdx + ')">'
                + '<td>' + escapeHtml(k) + '</td>'
                + '<td style="text-align:right;color:#888;font-size:10px;">🔑</td>'
                + '</tr>';
        });
        content += '</tbody></table>';

        var home = objectTabs.find(function(t) { return t.id === 'obj_home'; });
        if (home) home.content = content;
        else objectTabs.unshift({ id: 'obj_home', label: '对象', type: 'home', content: content });
        renderObjectPanel();
    });
}

function closeTab(tabId) {
    // 清理该 tab 对应的 splitter 绑定标记
    var qidMatch = tabId.match(/^query_(.+)$/);
    if (qidMatch) delete _querySplitterInited['qs_' + qidMatch[1]];
    // ★ 清理 data tab 的 _tabIdToTid 和 _whereStates
    var tid2 = _tabIdToTid[tabId];
    if (tid2) { delete _whereStates[tid2]; delete _tabIdToTid[tabId]; }
    // ★ 清理 redis tab 的编辑状态
    for (var i = 0; i < objectTabs.length; i++) {
        if (objectTabs[i].id === tabId && objectTabs[i].type === 'redis' && objectTabs[i].tid) {
            delete _redisEditState[objectTabs[i].tid];
            break;
        }
    }
    objectTabs = objectTabs.filter(function(t){return t.id!==tabId;});
    activeObjTab = objectTabs.length ? objectTabs[objectTabs.length-1].id : 'obj_home';
    renderObjectPanel();
}

function switchObjTab(tabId) { activeObjTab = tabId; renderObjectPanel(); }
