// ==================== 设计器交互函数 ====================

// ★ 多 Tab 支持：设计数据按 tabId 存储，不再使用全局单例 _tableDesign
window._tableDesigns = window._tableDesigns || {};
function _getDesignDS() {
    return window._tableDesigns[activeObjTab] || window._tableDesign || null;
}

// ★ 根据数据库类型获取对应的字段类型列表和默认类型
function _getDataTypesForDB(dbType) {
    dbType = (dbType || '').toLowerCase();
    if (dbType === 'oracle') {
        return {
            defaultType: 'VARCHAR2',
            defaultLen: '255',
            types: ['VARCHAR2', 'CHAR', 'NCHAR', 'NVARCHAR2', 'CLOB', 'NCLOB', 'LONG',
                'NUMBER', 'BINARY_FLOAT', 'BINARY_DOUBLE',
                'DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMP WITH LOCAL TIME ZONE',
                'INTERVAL YEAR TO MONTH', 'INTERVAL DAY TO SECOND',
                'BLOB', 'RAW', 'LONG RAW', 'ROWID']
        };
    } else if (dbType === 'postgresql') {
        return {
            defaultType: 'VARCHAR',
            defaultLen: '255',
            types: ['INTEGER', 'BIGINT', 'SMALLINT', 'SERIAL', 'BIGSERIAL',
                'NUMERIC', 'DECIMAL', 'REAL', 'DOUBLE PRECISION', 'MONEY',
                'VARCHAR', 'CHAR', 'TEXT',
                'BOOLEAN',
                'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIME WITH TIME ZONE', 'INTERVAL',
                'BYTEA', 'JSON', 'JSONB', 'XML', 'UUID']
        };
    } else if (dbType === 'mssql') {
        return {
            defaultType: 'NVARCHAR',
            defaultLen: '255',
            types: ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'BIT',
                'DECIMAL', 'NUMERIC', 'FLOAT', 'REAL', 'MONEY', 'SMALLMONEY',
                'VARCHAR', 'CHAR', 'TEXT', 'NVARCHAR', 'NCHAR', 'NTEXT',
                'DATE', 'TIME', 'DATETIME', 'DATETIME2', 'DATETIMEOFFSET', 'SMALLDATETIME',
                'BINARY', 'VARBINARY', 'IMAGE', 'UNIQUEIDENTIFIER', 'XML', 'JSON']
        };
    } else {
        // MySQL / OB-MySQL 默认
        return {
            defaultType: 'VARCHAR',
            defaultLen: '255',
            types: ['INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'FLOAT', 'DOUBLE', 'DECIMAL',
                'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYTEXT',
                'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
                'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'TINYBLOB', 'JSON', 'ENUM', 'SET', 'BOOLEAN']
        };
    }
}

function designSwitchTab(tab) {
    document.querySelectorAll('.designer-subtab').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.designer-pane').forEach(function(p) { p.classList.remove('active'); });
    var btns = document.querySelectorAll('.designer-subtab');
    for (var i = 0; i < btns.length; i++) {
        if (btns[i].textContent.indexOf({fields:'字段',indexes:'索引',fks:'外键',props:'表属性'}[tab]) >= 0) btns[i].classList.add('active');
    }
    var pane = document.getElementById('design_pane_' + tab);
    if (pane) pane.classList.add('active');
}

// 把当前表单里的字段数据保存回 ds.design.columns（防新增时清空已填内容）
function collectFieldsToDesign() {
    var ds = _getDesignDS();
    if (!ds) return;
    var rows = document.querySelectorAll('#design_fields_table tbody tr');
    for (var i = 0; i < rows.length && i < ds.design.columns.length; i++) {
        var row = rows[i];
        var nameEl = row.querySelector('.field-name');
        var typeEl = row.querySelector('.field-type');
        var lenEl = row.querySelector('.field-len');
        var nullEl = row.querySelector('.field-null');
        var defEl = row.querySelector('.field-default');
        var aiEl = row.querySelector('.field-autoinc');
        var cmtEl = row.querySelector('.field-comment');
        if (nameEl) ds.design.columns[i].name = nameEl.value.trim() || ds.design.columns[i].name;
        if (typeEl) {
            ds.design.columns[i].data_type = typeEl.value;
            ds.design.columns[i].col_type = typeEl.value;
            if (lenEl && lenEl.value.trim()) ds.design.columns[i].col_type = typeEl.value + '(' + lenEl.value.trim() + ')';
        }
        if (nullEl) ds.design.columns[i].nullable = nullEl.checked;
        if (defEl) ds.design.columns[i].default_val = defEl.value.trim() || null;
        if (aiEl) ds.design.columns[i].auto_increment = aiEl.checked;
        if (cmtEl) ds.design.columns[i].comment = cmtEl.value.trim();
    }
}

function designAddField() {
    collectFieldsToDesign();
    var ds = _getDesignDS();
    if (!ds) return;
    var dbType = ds.conn && ds.conn.db_type || 'mysql';
    var dtInfo = _getDataTypesForDB(dbType);
    ds.design.columns.push({
        name: 'new_field',
        data_type: dtInfo.defaultType,
        col_type: dtInfo.defaultType + '(' + dtInfo.defaultLen + ')',
        length: dtInfo.defaultLen,
        nullable: true,
        default_val: null,
        auto_increment: false,
        comment: ''
    });
    rebuildFieldsTable();
}

function designInsertField(pos) {
    collectFieldsToDesign();
    var ds = _getDesignDS();
    if (!ds) return;
    var dbType = ds.conn && ds.conn.db_type || 'mysql';
    var dtInfo = _getDataTypesForDB(dbType);
    ds.design.columns.splice(pos < 0 ? 0 : pos, 0, {
        name: 'new_field',
        data_type: dtInfo.defaultType,
        col_type: dtInfo.defaultType + '(' + dtInfo.defaultLen + ')',
        length: dtInfo.defaultLen,
        nullable: true,
        default_val: null,
        auto_increment: false,
        comment: ''
    });
    rebuildFieldsTable();
}

function designRemoveField(row) {
    collectFieldsToDesign();
    var ds = _getDesignDS();
    if (!ds) return;
    if (ds.design.columns.length <= 1) { showWarnDialog('提示', '至少保留一个字段'); return; }
    ds.design.columns.splice(row, 1);
    rebuildFieldsTable();
}

function rebuildFieldsTable() {
    var ds = _getDesignDS();
    if (!ds) return;
    // ★ 根据数据库类型选择对应的类型列表
    var dbType = ds.conn && ds.conn.db_type || 'mysql';
    var dtInfo = _getDataTypesForDB(dbType);
    var rowsHtml = '';
    for (var i = 0; i < ds.design.columns.length; i++) {
        rowsHtml += buildFieldRow(i, ds.design.columns[i], dtInfo.types);
    }
    var tbody = document.querySelector('#design_fields_table tbody');
    if (tbody) tbody.innerHTML = rowsHtml;
}

// 把当前索引表单数据保存回 ds.design.indexes
function collectIndexesToDesign() {
    var ds = _getDesignDS();
    if (!ds) return;
    var idxNames = document.querySelectorAll('.idx-name');
    var idxTypes = document.querySelectorAll('.idx-type');
    var idxCols = document.querySelectorAll('.idx-cols');
    var idxMethods = document.querySelectorAll('.idx-method');
    for (var j = 0; j < idxNames.length && j < ds.design.indexes.length; j++) {
        ds.design.indexes[j].name = idxNames[j].value.trim() || ds.design.indexes[j].name;
        ds.design.indexes[j].type = idxTypes[j].value;
        ds.design.indexes[j].columns = idxCols[j].value.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
        ds.design.indexes[j].method = idxMethods[j].value;
    }
}

function designAddIndex() {
    collectFieldsToDesign();
    collectIndexesToDesign();
    var ds = _getDesignDS();
    if (!ds) return;
    var idxName = 'idx_' + ds.design.columns[0].name;
    ds.design.indexes.push({name: idxName, type: 'INDEX', columns: [ds.design.columns[0].name], method: 'BTREE'});
    buildDesignerUI(ds.tabId, ds.tn, ds.design);
    designSwitchTab('indexes');
}

function designRemoveIndex(j) {
    collectFieldsToDesign();
    collectIndexesToDesign();
    var ds = _getDesignDS();
    if (!ds) return;
    ds.design.indexes.splice(j, 1);
    buildDesignerUI(ds.tabId, ds.tn, ds.design);
    designSwitchTab('indexes');
}

// ★ 各数据库不支持长度的类型（这些类型不拼接 (length)）
var _NO_LEN_TYPES = {
    oracle: ['DATE','CLOB','NCLOB','LONG','BLOB','LONG RAW','BINARY_FLOAT','BINARY_DOUBLE','ROWID'],
    mysql: ['TEXT','MEDIUMTEXT','LONGTEXT','TINYTEXT','BLOB','MEDIUMBLOB','LONGBLOB','TINYBLOB',
            'DATE','TIME','DATETIME','TIMESTAMP','YEAR','JSON','BOOLEAN'],
    postgresql: ['TEXT','DATE','TIME','TIMESTAMP','TIMESTAMPTZ','TIME WITH TIME ZONE',
                 'INTERVAL','BYTEA','JSON','JSONB','XML','UUID','BOOLEAN'],
    mssql: ['TEXT','NTEXT','IMAGE','DATE','TIME','DATETIME','DATETIME2','DATETIMEOFFSET',
            'SMALLDATETIME','UNIQUEIDENTIFIER','XML','JSON']
};
/** 判断指定数据库类型下，某字段类型是否支持长度参数 */
function _typeSupportsLen(dbType, dataType) {
    var list = _NO_LEN_TYPES[(dbType||'').toLowerCase()] || _NO_LEN_TYPES.mysql;
    return list.indexOf((dataType||'').toUpperCase()) === -1;
}

// 收集表单数据到 design 对象
function designCollect() {
    var ds = _getDesignDS();
    if (!ds) return null;
    var d = JSON.parse(JSON.stringify(ds.design));
    var dbType = (ds.conn && ds.conn.db_type) || 'mysql';

    // 字段数据：直接从表单重建，不依赖 ds.design.columns 的旧值
    var rows = document.querySelectorAll('#design_fields_table tbody tr');
    d.columns = [];
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var nameEl = row.querySelector('.field-name');
        var typeEl = row.querySelector('.field-type');
        var lenEl = row.querySelector('.field-len');
        var nullEl = row.querySelector('.field-null');
        var defEl = row.querySelector('.field-default');
        var aiEl = row.querySelector('.field-autoinc');
        var cmtEl = row.querySelector('.field-comment');
        var colName = nameEl ? nameEl.value.trim() : ('col_' + i);
        var dt = typeEl ? typeEl.value : 'VARCHAR';
        var len = lenEl ? lenEl.value.trim() : '';
        // ★ 无长度类型不拼接括号（如 Oracle DATE/TIMESTAMP/CLOB 等）
        var useLen = len && _typeSupportsLen(dbType, dt);
        d.columns.push({
            name: colName,
            data_type: dt,
            col_type: useLen ? dt + '(' + len + ')' : dt,
            length: useLen ? len : '',
            nullable: nullEl ? nullEl.checked : true,
            default_val: defEl ? (defEl.value.trim() || null) : null,
            auto_increment: aiEl ? aiEl.checked : false,
            comment: cmtEl ? cmtEl.value.trim() : ''
        });
    }

    // ★ 收集索引数据：完全从表单重建，不依赖 ds.design.indexes（防止多 Tab 串数据）
    var idxNames = document.querySelectorAll('.idx-name');
    var idxTypes = document.querySelectorAll('.idx-type');
    var idxCols = document.querySelectorAll('.idx-cols');
    var idxMethods = document.querySelectorAll('.idx-method');
    d.indexes = [];
    for (var j = 0; j < idxNames.length; j++) {
        var idxType = idxTypes[j] ? idxTypes[j].value : 'INDEX';
        var colsStr = idxCols[j] ? idxCols[j].value : '';
        d.indexes.push({
            name: idxNames[j].value.trim(),
            type: idxType,
            columns: colsStr.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; }),
            method: (idxMethods[j] ? idxMethods[j].value : 'BTREE')
        });
    }

    // 收集表属性
    var engEl = document.getElementById('design_engine');
    var colEl = document.getElementById('design_collation');
    var cmtEl2 = document.getElementById('design_comment');
    if (engEl) d.table_options.engine = engEl.value;
    if (colEl) d.table_options.collation = colEl.value;
    if (cmtEl2) d.table_options.comment = cmtEl2.value.trim();

    return d;
}

// ★ 设计保存取消标记（防止取消后回调仍弹窗）
var _designSaveCancel = false;

function designSave() {
    collectFieldsToDesign();
    collectIndexesToDesign();
    var ds = _getDesignDS();
    if (!ds) {
        showWarnDialog('提示', '未找到表设计数据，请重新打开设计 Tab');
        return;
    }
    // ★ 安全校验：当前激活的 Tab 必须是该设计的 Tab，防止多 Tab 时点错
    if (activeObjTab !== ds.tabId) {
        showWarnDialog('提示', '设计数据与当前Tab不匹配，请切换到正确的设计Tab或重新打开');
        return;
    }
    var design = designCollect();
    if (!design) return;

    // ★ 捕获当前 tabId，防止异步回调期间用户切换 Tab 导致串数据
    var _capturedTabId = ds.tabId;

    // ★ 重置取消标记
    _designSaveCancel = false;

    // 先预览 SQL
    document.getElementById('modal_icon').innerHTML = '🔍';
    document.getElementById('modal_title').textContent = '预览变更 SQL';
    document.getElementById('modal_title').style.color = '#2980b9';
    document.getElementById('modal_msg').innerHTML = '<div style="color:#888;padding:20px;text-align:center;">⏳ 正在生成 SQL...</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="_designSaveCancel=true;eel.cancel_query()();hideModal()">取消</button>';
    document.getElementById('modal_overlay').classList.add('show');

    eel.table_apply_design(ds.conn, ds.db, ds.tn, design, ds.schema, false)(function(r) {
        // ★ 用户已取消，不再继续
        if (_designSaveCancel) { hideModal(); return; }
        if (!r || !r.ok) {
            document.getElementById('modal_overlay').classList.remove('show');
            showErrorDialog('生成失败', r ? r.msg : '未知错误');
            return;
        }
        var sqls = r.sqls || [];
        if (!sqls.length) {
            document.getElementById('modal_overlay').classList.remove('show');
            showOkDialog('提示', '表结构无变更');
            return;
        }
        var sqlHtml = sqls.map(function(s) {
            // 格式化：每个 SQL 子句换行缩进，方便阅读
            var formatted = s.replace(/^ALTER TABLE (\S+)\s+/, 'ALTER TABLE <b>$1</b>\n&nbsp;&nbsp;')
                .replace(/, (DROP|ADD|MODIFY|ENGINE|COLLATE|COMMENT=)(\S?)/g, ',\n&nbsp;&nbsp;$1$3');
            return '<div style="background:#0d1117;border:1px solid #333;border-radius:4px;padding:10px 12px;margin-bottom:8px;font-family:Consolas,monospace;font-size:11px;color:#e0e0e0;line-height:1.65;white-space:pre-wrap;word-break:break-all;">' + formatted + '</div>';
        }).join('');
        document.getElementById('modal_icon').innerHTML = '⚠️';
        document.getElementById('modal_title').textContent = '确认执行变更';
        document.getElementById('modal_title').style.color = '#e67e22';
        document.getElementById('modal_msg').innerHTML =
            '<div style="max-height:300px;overflow-y:auto;margin-bottom:8px;">' + sqlHtml + '</div>' +
            '<div style="font-size:11px;color:#e74c3c;">共 ' + sqls.length + ' 条 SQL，确认后将直接修改表结构</div>';
        document.getElementById('modal_btns').innerHTML =
            '<button class="btn btn-gray" onclick="_designSaveCancel=true;hideModal()">取消</button>' +
            '<button class="btn btn-red" id="modal_exec_btn">执行</button>';
        document.getElementById('modal_exec_btn').onclick = function() {
            hideModal();
            // ★ 重置取消标记（执行阶段新操作）
            _designSaveCancel = false;
            // 显示执行进度
            document.getElementById('modal_icon').innerHTML = '⏳';
            document.getElementById('modal_title').textContent = '执行中...';
            document.getElementById('modal_title').style.color = '#f39c12';
            document.getElementById('modal_msg').innerHTML = '<div style="text-align:center;padding:20px;color:#888;">正在应用表设计修改...</div>';
            document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" style="margin-top:8px;font-size:10px;" onclick="_designSaveCancel=true;eel.cancel_query()();hideModal()">⏹ 取消执行</button>';
            document.getElementById('modal_overlay').classList.add('show');

            eel.table_apply_design(ds.conn, ds.db, ds.tn, design, ds.schema, true)(function(r2) {
                // ★ 用户已取消执行，不再弹窗
                if (_designSaveCancel) { hideModal(); return; }
                document.getElementById('modal_overlay').classList.remove('show');
                if (r2 && r2.ok) {
                    showOkDialog('成功', r2.msg);
                    // ★ 用捕获的 tabId 刷新正确的设计 Tab
                    setTimeout(function() {
                        var ds2 = window._tableDesigns[_capturedTabId];
                        if (ds2) {
                            addTableDDLTab(ds2.tn, ds2.db, ds2.schema, ds2.cid);
                        }
                    }, 300);
                } else {
                    showErrorDialog('失败', r2 ? r2.msg : '未知错误');
                }
            });
        };
    });
}

function designRefresh() {
    var ds = _getDesignDS();
    if (!ds) return;
    addTableDDLTab(ds.tn, ds.db, ds.schema, ds.cid);
}

function designViewDDL() {
    var ds = _getDesignDS();
    if (!ds) return;
    document.getElementById('modal_icon').innerHTML = '📄';
    document.getElementById('modal_title').textContent = '建表 SQL：' + ds.tn;
    document.getElementById('modal_title').style.color = '#4fc3f7';
    document.getElementById('modal_msg').innerHTML = '<div style="color:#888;padding:20px;text-align:center;">⏳ 加载中...</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">关闭</button>';
    document.getElementById('modal_overlay').classList.add('show');

    eel.table_get_ddl(ds.conn, ds.db, ds.tn, ds.schema)(function(r) {
        var ddl = '<div style="color:#e74c3c;">❌ ' + escapeHtml(r ? r.msg : '加载失败') + '</div>';
        if (r && r.ok && r.ddl) {
            ddl = '<pre style="background:#0d1117;border:1px solid #333;border-radius:6px;padding:12px;font-family:Consolas,monospace;font-size:11px;color:#e0e0e0;white-space:pre-wrap;word-break:break-all;max-height:450px;overflow-y:auto;margin:0;">' + escapeHtml(r.ddl) + '</pre>';
        }
        document.getElementById('modal_msg').innerHTML = ddl;
    });
}

function openQueryInTab(qid) {
    console.log('[openQueryInTab] 尝试打开查询, qid=', qid);
    eel.tree_get_query(qid)(function(q){
        if(!q) {
            console.error('[openQueryInTab] 查询未找到, qid=', qid);
            showErrorDialog('打开失败', '查询未找到（ID: '+escapeHtml(String(qid))+'），可能已被删除或配置文件损坏。');
            return;
        }
        _openQueryInTabImpl(q);
    });
}

function _openQueryInTabImpl(q) {
    var qid = q.id;
    var cid = q.conn_id || '';
    var qdb = q.db || '';
    // 确保 activeConnData 来自查询所属连接，不依赖外部状态
    if (cid && treeData && treeData.connections && treeData.connections[cid]) {
        activeConnId = cid;
        activeConnData = treeData.connections[cid];
    }
    // ★ 构建连接+数据库标签（toolbar 右侧展示）
    var connLabel = '';
    var connData = (cid && treeData && treeData.connections) ? treeData.connections[cid] : null;
    if (connData) {
        var typeIcons = {'mysql':'🐬','ob-mysql':'🌊','postgresql':'🐘','oracle':'🔴','mssql':'🟢','redis':'📦'};
        var typeIcon = typeIcons[connData.db_type] || '🗄️';
        var connName = connData.name || connData.host || '未知连接';
        var dbName = qdb || '未选择数据库';
        connLabel = '<span style="margin-left:auto;font-size:11px;color:#aaa;white-space:nowrap;">' +
            typeIcon + ' ' + escapeHtml(connName) +
            ' <span style="color:#666;">/</span> ' +
            '<span style="color:#4fc3f7;">' + escapeHtml(dbName) + '</span></span>';
    }
    var content =
        '<div class="query-layout" id="ql_'+qid+'">' +
        '<div class="query-toolbar" style="display:flex;align-items:center;"><button id="btn_exe_'+qid+'" class="btn btn-green" style="font-size:11px;padding:4px 14px;" onclick="execQueryTab(\''+qid+'\')">▶ 执行</button>' +
        '<button id="btn_fmt_'+qid+'" class="btn btn-sm btn-fmt" style="font-size:11px;padding:4px 10px;margin-left:4px;" onclick="_formatSqlTab(\''+qid+'\')" title="格式化 SQL (Ctrl+B)">🧹 美化</button>' +

        connLabel +
        '<div class="sql-find-bar" id="sql_find_bar_'+qid+'" style="display:none;">' +
            '<input type="text" id="sql_find_input_'+qid+'" placeholder="查找..." oninput="_applySqlHighlight(\''+qid+'\',null)" onkeydown="if(event.key===\'Enter\'){event.preventDefault();_sqlFindNext(\''+qid+'\');}if(event.key===\'Escape\'){event.preventDefault();_closeSqlFind(\''+qid+'\',null);}">' +
            '<span id="sql_find_count_'+qid+'" class="sql-find-count">0/0</span>' +
            '<button class="btn btn-sm" onclick="_sqlFindPrev(\''+qid+'\')" title="上一个">▲</button>' +
            '<button class="btn btn-sm" onclick="_sqlFindNext(\''+qid+'\')" title="下一个">▼</button>' +
            '<button class="btn btn-sm" onclick="_closeSqlFind(\''+qid+'\',null)" title="关闭">✕</button>' +
        '</div>' +
        '</div>' +
        '<div class="query-editor-wrap" id="qew_'+qid+'" style="display:flex;position:relative;">' +
        '<div class="sql-ln-gutter" id="lng_'+qid+'" onscroll="document.getElementById(\'sq_'+qid+'\').scrollTop=this.scrollTop"></div>' +
        '<div class="sql-editor-inner" style="position:relative;flex:1;min-width:0;display:flex;">' +
            '<div class="sql-highlight" id="sql_hl_'+qid+'" aria-hidden="true" style="display:none;z-index:-1;"></div>' +
            '<textarea id="sq_'+qid+'" class="query-editor" spellcheck="false" wrap="off">'+escapeHtml(q.sql||'')+'</textarea>' +
        '</div>' +
        '</div>' +
        '<div class="query-splitter" id="qs_'+qid+'"></div>' +
        '<div class="query-results-wrap" id="qr_'+qid+'"></div>' +
        '</div>';
    addOrUpdateTab('query_'+qid, q.name, 'query', content, q.db, cid);
    setTimeout(function(){
        var ta = document.getElementById('sq_'+qid);
        var btnE = document.getElementById('btn_exe_'+qid);
        function updateBtnLabel() {
            if (!ta || !btnE || btnE.textContent === '⏹ 取消') return;
            var s = ta.selectionStart, e = ta.selectionEnd;
            btnE.textContent = (s !== e) ? '▶ 执行选中' : '▶ 执行';
        }
        if(ta) {
            ta.addEventListener('input', function(){ _queryTextareaChanged(qid, ta); _syncLineGutter(qid, ta); _applySqlHighlight(qid, ta); });
            ta.addEventListener('keydown',function(e){
                if(e.ctrlKey&&e.key==='Enter') execQueryTab(qid);
                if(e.ctrlKey&&(e.key==='s'||e.key==='S')) { e.preventDefault(); saveQueryTab(qid, cid, qdb, q.name); }
                if(e.ctrlKey&&(e.key==='b'||e.key==='B')) { e.preventDefault(); _formatSqlTab(qid); }
                if(e.ctrlKey&&(e.key==='f'||e.key==='F')) { e.preventDefault(); e.stopPropagation(); _openSqlFind(qid, ta); return; }
                if(e.ctrlKey&&(e.key==='d'||e.key==='D')) { e.preventDefault(); _editorDupLine(ta); }
                if(e.ctrlKey&&e.key==='/') { e.preventDefault(); _editorToggleComment(ta); }
                if(e.ctrlKey&&e.shiftKey&&(e.key==='K'||e.key==='k')) { e.preventDefault(); _editorDeleteLine(ta); }
                if(e.key==='Tab') { e.preventDefault(); if(e.shiftKey) _editorOutdent(ta); else _editorIndent(ta); }
                if(e.key==='Escape') { var bar=document.getElementById('sql_find_bar_'+qid); if(bar && bar.style.display!=='none'){ e.preventDefault(); _closeSqlFind(qid, ta); } }
            });
            ta.addEventListener('mouseup', function(){ updateBtnLabel(); _syncLineGutter(qid, ta); _scrollToLine(ta, _getCursorLineNo(ta)); });
            ta.addEventListener('keyup', function(){ updateBtnLabel(); _syncLineGutter(qid, ta); });
            ta.addEventListener('scroll', function(){
                var gutter = document.getElementById('lng_'+qid);
                if (gutter) gutter.scrollTop = ta.scrollTop;
                _positionHighlightOverlay(qid, ta);
            });
            _syncLineGutter(qid, ta);
        }
        // 初始化可拖动分割线
        initQuerySplitter('ql_'+qid, 'qs_'+qid, 'sq_'+qid, 'qr_'+qid);
    },100);
}

/** 渲染 SQL 编辑器行号侧边栏 */
function _syncLineGutter(qid, ta) {
    if (!ta) { ta = document.getElementById('sq_' + qid); }
    if (!ta) return;
    var gutter = document.getElementById('lng_' + qid);
    if (!gutter) return;
    var lines = (ta.value.match(/\n/g) || []).length + 1;
    var html = '';
    var cursorLine = _getCursorLineNo(ta);
    var lineH = 18; // 约等于 font-size 12 + line-height 18
    for (var i = 1; i <= lines; i++) {
        var cls = i === cursorLine ? ' class="ln-row ln-active"' : ' class="ln-row"';
        html += '<div' + cls + ' data-line="' + i + '" onclick="_lnGutterClick(\'' + qid + '\',' + i + ')">' + i + '</div>';
    }
    gutter.innerHTML = html;
    // gutter 滚动位置跟随 textarea
    gutter.scrollTop = ta.scrollTop;
}

/** 获取光标所在行号（1-based） */
function _getCursorLineNo(ta) {
    if (!ta) return 1;
    var pos = ta.selectionStart;
    var text = ta.value.substring(0, pos);
    return (text.match(/\n/g) || []).length + 1;
}

/** 行号列点击：跳转光标到该行，并滚动到该行可见 */
function _lnGutterClick(qid, lineNo) {
    var ta = document.getElementById('sq_' + qid);
    if (!ta) return;
    var lines = ta.value.split('\n');
    var pos = 0;
    for (var i = 0; i < lineNo - 1 && i < lines.length; i++) {
        pos += lines[i].length + 1; // +1 for newline
    }
    ta.focus();
    ta.selectionStart = pos;
    ta.selectionEnd = pos;
    _scrollToLine(ta, lineNo);
    _syncLineGutter(qid, ta);
}

/** 滚动 textarea 使指定行可见（行高 18px） */
function _scrollToLine(ta, lineNo) {
    if (!ta || !lineNo) return;
    var lineH = 18;
    var targetTop = (lineNo - 1) * lineH;
    var viewTop = ta.scrollTop;
    var viewH = ta.clientHeight;
    var viewBottom = viewTop + viewH;
    if (targetTop < viewTop) {
        // 行在可视区域上方 → 滚到该行顶部
        ta.scrollTop = targetTop;
    } else if (targetTop + lineH > viewBottom) {
        // 行在可视区域下方 → 滚到该行底部可见
        ta.scrollTop = targetTop + lineH - viewH + 4;
    }
}

/* ================== SQL 编辑器：搜索/高亮 ================== */
var _sqlFindState = {};

function _openSqlFind(qid, ta) {
    if (!ta) ta = document.getElementById('sq_' + qid);
    var bar = document.getElementById('sql_find_bar_' + qid);
    var input = document.getElementById('sql_find_input_' + qid);
    var hl = document.getElementById('sql_hl_' + qid);
    if (!bar || !input) return;
    if (ta && ta.selectionStart !== ta.selectionEnd) {
        var s = ta.value.substring(ta.selectionStart, ta.selectionEnd);
        if (s && s.length < 200) input.value = s;
    }
    bar.style.display = 'flex';
    // ★ 搜索模式：高亮层显示，textarea 文字透明（高亮层防在底下显示文字）
    if (hl) { hl.style.display = ''; hl.style.zIndex = '1'; }
    ta.style.color = 'transparent';
    ta.style.caretColor = '#e0e0e0';
    _applySqlHighlight(qid, ta);
    input.focus();
    input.select();
}

function _closeSqlFind(qid, ta) {
    if (!ta) ta = document.getElementById('sq_' + qid);
    var bar = document.getElementById('sql_find_bar_' + qid);
    var hl = document.getElementById('sql_hl_' + qid);
    if (bar) bar.style.display = 'none';
    // ★ 关闭搜索但不隐藏高亮层：保持注释淡色显示
    _sqlFindState[qid] = null;
    // 重新渲染高亮层（仅注释着色，无搜索高亮）
    _applySqlHighlight(qid, ta);
    if (ta) { ta.focus(); }
}

function _applySqlHighlight(qid, ta) {
    if (!ta) ta = document.getElementById('sq_' + qid);
    var hl = document.getElementById('sql_hl_' + qid);
    var bar = document.getElementById('sql_find_bar_' + qid);
    var input = document.getElementById('sql_find_input_' + qid);
    var countEl = document.getElementById('sql_find_count_' + qid);
    if (!ta || !hl) return;

    var text = ta.value;
    var kw = (input && bar && bar.style.display !== 'none') ? input.value : '';
    var isSearch = bar && bar.style.display !== 'none' && kw;

    // ★ 解析注释区间
    var commentRanges = _findSqlCommentRanges(text);
    var hasComments = commentRanges.length > 0;

    // ★ 仅在有注释或搜索时启用高亮层；否则使用原生 textarea（保留选中高亮）
    if (!isSearch && !hasComments) {
        hl.style.display = 'none';
        hl.style.zIndex = '-1';
        ta.style.color = '';
        ta.style.caretColor = '';
        _sqlFindState[qid] = null;
        return;
    }

    hl.style.display = '';
    hl.style.zIndex = '1';
    ta.style.color = 'transparent';
    ta.style.caretColor = '#e0e0e0';

    // 搜索匹配
    var matches = [];
    if (isSearch) {
        try {
            var re = new RegExp(_escapeRegex(kw), 'gi');
            var m;
            while ((m = re.exec(text)) !== null) {
                matches.push({start: m.index, end: m.index + m[0].length});
                if (m[0].length === 0) re.lastIndex++;
            }
        } catch (e) {}
        _sqlFindState[qid] = {kw: kw, matches: matches, idx: matches.length ? 0 : -1};
    } else {
        _sqlFindState[qid] = null;
    }

    // ★ 构建带注释+搜索高亮的 HTML
    // 把所有特殊区间按位置排序
    var segments = [];
    for (var ci = 0; ci < commentRanges.length; ci++) {
        segments.push({start: commentRanges[ci].start, end: commentRanges[ci].end, type: 'comment'});
    }
    // 搜索匹配仅添加到非注释区域
    if (isSearch) {
        for (var mi = 0; mi < matches.length; mi++) {
            var ms = matches[mi];
            var inComment = false;
            for (var cj = 0; cj < commentRanges.length; cj++) {
                if (ms.start >= commentRanges[cj].start && ms.end <= commentRanges[cj].end) {
                    inComment = true; break;
                }
            }
            if (!inComment) segments.push({start: ms.start, end: ms.end, type: 'search', idx: mi});
        }
    }
    segments.sort(function(a, b) { return a.start - b.start || (a.type === 'comment' ? -1 : 1); });

    // 合并重叠（comment 优先）
    var merged = [];
    for (var ai = 0; ai < segments.length; ai++) {
        var sg = segments[ai];
        if (merged.length === 0 || sg.start >= merged[merged.length - 1].end) {
            merged.push(sg);
        } else {
            var last = merged[merged.length - 1];
            if (sg.type === 'comment') last.type = 'comment';
            if (last.end < sg.end) last.end = sg.end;
            if (sg.type === 'search' && last.type === 'search') last.idx = sg.idx;
        }
    }

    // 生成 HTML
    var html = '';
    var pos = 0;
    var cur = _sqlFindState[qid] ? _sqlFindState[qid].idx : -1;
    for (var si = 0; si < merged.length; si++) {
        var seg = merged[si];
        if (seg.start > pos) html += _escapeHtml(text.substring(pos, seg.start));
        if (seg.type === 'comment') {
            html += '<span class="sql-comment">' + _escapeHtml(text.substring(seg.start, seg.end)) + '</span>';
        } else {
            var cls2 = (seg.idx === cur) ? 'sql-hl sql-hl-cur' : 'sql-hl';
            html += '<mark class="' + cls2 + '">' + _escapeHtml(text.substring(seg.start, seg.end)) + '</mark>';
        }
        pos = seg.end;
    }
    if (pos < text.length) html += _escapeHtml(text.substring(pos));
    if (text.length === 0 || text.charAt(text.length - 1) !== '\n') html += '\n';

    hl.innerHTML = html;

    if (countEl) {
        if (isSearch) {
            var cidx = _sqlFindState[qid] ? _sqlFindState[qid].idx : -1;
            countEl.textContent = (cidx >= 0 ? (cidx + 1) : 0) + '/' + matches.length;
        } else {
            countEl.textContent = '0/0';
        }
    }

    _positionHighlightOverlay(qid, ta);

    if (isSearch && matches.length && _sqlFindState[qid] && _sqlFindState[qid].idx >= 0) {
        var m0 = matches[_sqlFindState[qid].idx];
        try { ta.selectionStart = m0.start; ta.selectionEnd = m0.end; } catch (e) {}
    }
}

/** 扫描 SQL 中的注释区间（跳过字符串字面量） */
function _findSqlCommentRanges(text) {
    var ranges = [];
    var i = 0;
    while (i < text.length) {
        var ch = text[i];
        // 单引号字符串
        if (ch === "'") {
            i++;
            while (i < text.length) {
                if (text[i] === "'") {
                    if (i + 1 < text.length && text[i + 1] === "'") { i += 2; continue; }
                    i++; break;
                }
                i++;
            }
            continue;
        }
        // 双引号标识符
        if (ch === '"') {
            i++;
            while (i < text.length && text[i] !== '"') i++;
            if (i < text.length) i++;
            continue;
        }
        // 反引号标识符
        if (ch === '`') {
            i++;
            while (i < text.length && text[i] !== '`') i++;
            if (i < text.length) i++;
            continue;
        }
        // 方括号标识符（MSSQL）
        if (ch === '[') {
            i++;
            while (i < text.length && text[i] !== ']') i++;
            if (i < text.length) i++;
            continue;
        }
        // 行注释 --
        if (ch === '-' && i + 1 < text.length && text[i + 1] === '-') {
            var cs = i;
            i += 2;
            while (i < text.length && text[i] !== '\n') i++;
            ranges.push({start: cs, end: i});
            continue;
        }
        // 块注释 /* */
        if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
            var cs2 = i;
            i += 2;
            while (i < text.length && !(text[i] === '*' && i + 1 < text.length && text[i + 1] === '/')) i++;
            if (i < text.length) i += 2;
            ranges.push({start: cs2, end: i});
            continue;
        }
        i++;
    }
    return ranges;
}

function _sqlFindNext(qid) {
    var st = _sqlFindState[qid];
    if (!st || !st.matches.length) return;
    st.idx = (st.idx + 1) % st.matches.length;
    _applySqlHighlight(qid, null);
    _scrollToMatch(qid);
}

function _sqlFindPrev(qid) {
    var st = _sqlFindState[qid];
    if (!st || !st.matches.length) return;
    st.idx = (st.idx - 1 + st.matches.length) % st.matches.length;
    _applySqlHighlight(qid, null);
    _scrollToMatch(qid);
}

function _scrollToMatch(qid) {
    var ta = document.getElementById('sq_' + qid);
    if (!ta) return;
    var st = _sqlFindState[qid];
    if (!st || st.idx < 0) return;
    var m = st.matches[st.idx];
    if (!m) return;
    var lineH = 18;
    var beforeText = ta.value.substring(0, m.start);
    var lineIdx = (beforeText.match(/\n/g) || []).length;
    var targetY = (lineIdx * lineH) - (ta.clientHeight / 2);
    ta.scrollTop = Math.max(0, targetY);
    var gutter = document.getElementById('lng_' + qid);
    if (gutter) gutter.scrollTop = ta.scrollTop;
}

function _positionHighlightOverlay(qid, ta) {
    if (!ta) ta = document.getElementById('sq_' + qid);
    var hl = document.getElementById('sql_hl_' + qid);
    if (!ta || !hl) return;
    hl.style.top = '0px';
    hl.style.left = '0px';
    hl.style.width = ta.clientWidth + 'px';
    hl.style.height = ta.clientHeight + 'px';
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
}

function _escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function saveQueryTab(qid, cid, db, qname) {
    var ta = document.getElementById('sq_' + qid);
    if (!ta) return;
    var sql = ta.value;
    eel.tree_save_query(qid, qname || '', sql, cid, db)(function(r){
        // 绿色边框闪烁提示已保存
        if (ta) {
            ta.style.boxShadow = 'inset 0 0 0 2px #2ecc71';
            ta.style.transition = 'box-shadow 0.3s';
            var clearFlash = function(){ ta.style.boxShadow = ''; };
            setTimeout(clearFlash, 1200);
            // ★ 点击其他地方（blur）时立即清除高亮，不再等 1200ms
            ta.addEventListener('blur', function _onceBlur(){ ta.removeEventListener('blur', _onceBlur); clearFlash(); });
        }
        // ★ 刷新树中查询列表
        if (r && r.ok) {
            if (cid && db && typeof refreshQueriesTree === 'function') {
                refreshQueriesTree(cid, db, '');
            }
        }
    });
}

// ==================== SQL 美化格式化 ====================
// 参考 Navicat 等工具的格式化风格：
// 1. 关键字大写  2. 主要子句换行  3. 嵌套缩进  4. 逗号后换行对齐
function _formatSqlTab(qid) {
    var ta = document.getElementById('sq_' + qid);
    if (!ta) return;
    var sql = ta.value;
    if (!sql || !sql.trim()) return;

    // 保存光标位置
    var selStart = ta.selectionStart;
    var selEnd = ta.selectionEnd;
    var scrollTop = ta.scrollTop;

    try {
        var formatted = _formatSql(sql);
        ta.value = formatted;
        // 尝试恢复光标到相近位置
        var newPos = Math.min(selStart, formatted.length);
        ta.selectionStart = newPos;
        ta.selectionEnd = newPos;
        ta.scrollTop = scrollTop;
        // 触发 input 事件以更新行号、高亮等
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        // 绿色闪烁提示
        ta.style.boxShadow = 'inset 0 0 0 2px #f39c12';
        ta.style.transition = 'box-shadow 0.3s';
        var clearFlash = function(){ ta.style.boxShadow = ''; };
        setTimeout(clearFlash, 1200);
        ta.addEventListener('blur', function _onceBlur(){ ta.removeEventListener('blur', _onceBlur); clearFlash(); });
    } catch(e) {
        // 格式化失败不影响使用，恢复原值
        console.warn('SQL 格式化失败:', e);
        ta.value = sql;
        ta.selectionStart = selStart;
        ta.selectionEnd = selEnd;
    }
}

// SQL 格式化核心逻辑
function _formatSql(sql) {
    // 移除多余的空白，保留字符串内容
    var tokens = _tokenizeSql(sql);

    // 主要子句关键字（前面换行）
    var MAJOR_CLAUSES = new Set([
        'SELECT', 'FROM', 'WHERE', 'AND', 'OR',
        'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET',
        'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
        'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
        'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL',
        'JOIN', 'ON', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT',
        'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
        'BEGIN', 'COMMIT', 'ROLLBACK',
        'WITH', 'AS', 'ASC', 'DESC', 'NULLS', 'DISTINCT',
    ]);

    // 关键字大写列表
    var KEYWORDS = new Set([
        'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL',
        'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC',
        'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'TRUNCATE',
        'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW', 'DATABASE',
        'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'JOIN', 'ON',
        'UNION', 'ALL', 'EXCEPT', 'INTERSECT',
        'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
        'DISTINCT', 'AS', 'LIKE', 'BETWEEN', 'EXISTS',
        'COUNT', 'SUM', 'AVG', 'MAX', 'MIN',
        'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT',
        'DEFAULT', 'CHECK', 'UNIQUE', 'CASCADE', 'RESTRICT',
        'NULLS', 'FIRST', 'LAST',
        'IF', 'ELSE', 'THEN', 'BEGIN', 'END', 'COMMIT', 'ROLLBACK',
        'WITH', 'RECURSIVE', 'RETURNING',
        'TRUE', 'FALSE',
        'ANY', 'SOME',
    ]);

    // 分词：区分 关键字 / 标识符 / 字符串 / 数字 / 运算符 / 括号 / 逗号 / 分号
    function _tokenizeSql(s) {
        var tokens = [];
        var i = 0;
        while (i < s.length) {
            var ch = s[i];
            // 空白
            if (/\s/.test(ch)) { i++; continue; }
            // 单引号字符串
            if (ch === "'") {
                var start = i;
                i++;
                while (i < s.length) {
                    if (s[i] === "'") {
                        if (i + 1 < s.length && s[i + 1] === "'") { i += 2; continue; }
                        i++; break;
                    }
                    i++;
                }
                tokens.push({ type: 'string', value: s.substring(start, i) });
                continue;
            }
            // 双引号标识符（PostgreSQL/Oracle）
            if (ch === '"') {
                var start = i;
                i++;
                while (i < s.length) {
                    if (s[i] === '"') { i++; break; }
                    i++;
                }
                tokens.push({ type: 'ident', value: s.substring(start, i) });
                continue;
            }
            // 反引号标识符（MySQL）
            if (ch === '`') {
                var start = i;
                i++;
                while (i < s.length) {
                    if (s[i] === '`') { i++; break; }
                    i++;
                }
                tokens.push({ type: 'ident', value: s.substring(start, i) });
                continue;
            }
            // 方括号标识符（MSSQL）
            if (ch === '[') {
                var start = i;
                i++;
                while (i < s.length) {
                    if (s[i] === ']') { i++; break; }
                    i++;
                }
                tokens.push({ type: 'ident', value: s.substring(start, i) });
                continue;
            }
            // 行注释 --
            if (ch === '-' && i + 1 < s.length && s[i + 1] === '-') {
                var start = i;
                i += 2;
                while (i < s.length && s[i] !== '\n') i++;
                tokens.push({ type: 'comment', value: s.substring(start, i) });
                continue;
            }
            // 块注释 /* */
            if (ch === '/' && i + 1 < s.length && s[i + 1] === '*') {
                var start = i;
                i += 2;
                while (i < s.length && !(s[i] === '*' && i + 1 < s.length && s[i + 1] === '/')) i++;
                i += 2;
                tokens.push({ type: 'comment', value: s.substring(start, i) });
                continue;
            }
            // 数字
            if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < s.length && /[0-9]/.test(s[i + 1]))) {
                var start = i;
                i++;
                while (i < s.length && /[0-9.eE]/.test(s[i])) i++;
                tokens.push({ type: 'number', value: s.substring(start, i) });
                continue;
            }
            // 多字符运算符
            if (['<>', '!=', '<=', '>=', '||', '::'].indexOf(s.substring(i, i + 2)) >= 0) {
                tokens.push({ type: 'op', value: s.substring(i, i + 2) });
                i += 2; continue;
            }
            // 单字符运算符/分隔符
            if ('(),;=<>+-*/%'.indexOf(ch) >= 0) {
                tokens.push({ type: ch === ',' ? 'comma' : ch === '(' ? 'lparen' : ch === ')' ? 'rparen' : ch === ';' ? 'semi' : 'op', value: ch });
                i++; continue;
            }
            // 标识符/关键字（含 . 连接的限定名）
            var start = i;
            while (i < s.length && !/\s/.test(s[i]) && '(),;=<>+-*/%\''.indexOf(s[i]) < 0 && s[i] !== '"' && s[i] !== '`' && s[i] !== '[') i++;
            tokens.push({ type: 'word', value: s.substring(start, i) });
        }
        return tokens;
    }

    // 格式化：tokens → 带缩进的字符串
    var result = [];
    var indentLevel = 0;
    var indentStr = '  '; // 2空格缩进
    var needNewline = false;
    var prevType = null;
    var prevValue = '';

    function isMajorClause(v) {
        return MAJOR_CLAUSES.has(v.toUpperCase());
    }

    function indent() { return indentStr.repeat(Math.max(indentLevel, 0)); }

    // 获取 token 的大写值
    function upper(t) {
        if (t.type === 'word' && KEYWORDS.has(t.value.toUpperCase())) {
            return t.value.toUpperCase();
        }
        return t.value;
    }

    for (var ti = 0; ti < tokens.length; ti++) {
        var t = tokens[ti];
        var v = t.value;
        var upperV = v.toUpperCase();

        // 合并 UNION ALL
        if (t.type === 'word' && upperV === 'UNION' && ti + 1 < tokens.length && tokens[ti + 1].type === 'word' && tokens[ti + 1].value.toUpperCase() === 'ALL') {
            result.push('\n' + indent() + 'UNION ALL\n');
            ti++; // 跳过 ALL
            prevType = 'keyword';
            prevValue = 'UNION ALL';
            needNewline = false;
            continue;
        }
        // 合并 GROUP BY / ORDER BY
        if (t.type === 'word' && (upperV === 'GROUP' || upperV === 'ORDER') && ti + 1 < tokens.length && tokens[ti + 1].type === 'word' && tokens[ti + 1].value.toUpperCase() === 'BY') {
            result.push('\n' + indent() + upperV + ' BY');
            ti++;
            prevType = 'keyword';
            prevValue = upperV + ' BY';
            needNewline = true;
            continue;
        }
        // 合并 LEFT/RIGHT/INNER/FULL/CROSS JOIN / OUTER JOIN
        if (t.type === 'word' && ['LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL'].indexOf(upperV) >= 0) {
            var joinWord = upperV;
            var nextTi = ti + 1;
            if (nextTi < tokens.length && tokens[nextTi].type === 'word' && tokens[nextTi].value.toUpperCase() === 'OUTER' && upperV !== 'OUTER') {
                joinWord += ' OUTER';
                nextTi++;
            }
            if (nextTi < tokens.length && tokens[nextTi].type === 'word' && tokens[nextTi].value.toUpperCase() === 'JOIN') {
                result.push('\n' + indent() + joinWord + ' JOIN');
                ti = nextTi;
                prevType = 'keyword';
                prevValue = joinWord + ' JOIN';
                needNewline = true;
                continue;
            }
        }

        // === 换行逻辑 ===
        // 主要子句前换行
        if (t.type === 'word' && isMajorClause(upperV)) {
            if (['AND', 'OR'].indexOf(upperV) >= 0) {
                result.push('\n' + indent() + '  ' + upperV);
            } else if (upperV === 'ON') {
                result.push('\n' + indent() + '    ' + upperV);
            } else if (upperV === 'WHEN' || upperV === 'ELSE') {
                result.push('\n' + indent() + '  ' + upperV);
            } else if (upperV === 'THEN') {
                result.push(' ' + upperV);
            } else if (upperV === 'END') {
                result.push('\n' + indent() + upperV);
            } else if (['JOIN', 'UNION', 'EXCEPT', 'INTERSECT'].indexOf(upperV) >= 0) {
                result.push('\n' + indent() + upperV);
            } else {
                result.push('\n' + indent() + upperV);
            }
            prevType = 'keyword';
            prevValue = upperV;
            needNewline = true;
            continue;
        }

        // 语句结束分号
        if (t.type === 'semi') {
            result.push(';');
            indentLevel = 0;
            result.push('\n');
            prevType = 'semi';
            prevValue = ';';
            needNewline = false;
            continue;
        }

        // 左括号：前面加空格，后面缩进
        if (t.type === 'lparen') {
            if (prevType === 'word' && prevValue.toUpperCase() === 'IN') {
                result.push(' (');
            } else if (prevType === 'word' || prevType === 'rparen' || prevType === 'ident' || prevType === 'number') {
                result.push('(');
            } else {
                result.push('(');
            }
            indentLevel++;
            prevType = 'lparen';
            prevValue = '(';
            continue;
        }

        // 右括号
        if (t.type === 'rparen') {
            indentLevel = Math.max(indentLevel - 1, 0);
            result.push(')');
            prevType = 'rparen';
            prevValue = ')';
            continue;
        }

        // 逗号
        if (t.type === 'comma') {
            result.push(',');
            // SELECT 子句中的逗号换行
            if (indentLevel > 0) {
                result.push('\n' + indent());
            } else {
                result.push('\n' + indentStr);
            }
            needNewline = false;
            prevType = 'comma';
            prevValue = ',';
            continue;
        }

        // 运算符
        if (t.type === 'op') {
            result.push(' ' + v + ' ');
            prevType = 'op';
            prevValue = v;
            needNewline = false;
            continue;
        }

        // 字符串、数字
        if (t.type === 'string' || t.type === 'number') {
            result.push(v);
            prevType = t.type;
            prevValue = v;
            continue;
        }

        // 注释保持原样
        if (t.type === 'comment') {
            result.push('\n' + indent() + v);
            prevType = 'comment';
            prevValue = v;
            continue;
        }

        // 标识符
        if (t.type === 'ident') {
            result.push(v);
            prevType = 'ident';
            prevValue = v;
            continue;
        }

        // 普通单词（关键字大写，其余保持原样）
        if (t.type === 'word') {
            if (needNewline) {
                result.push(' ' + upper(t));
                needNewline = false;
            } else {
                result.push(upper(t));
            }
            prevType = 'word';
            prevValue = v;
            continue;
        }
    }

    // 去除首尾空白
    var formatted = result.join('').replace(/^\s+/, '').replace(/\s+$/, '\n');
    // 压缩连续空行
    formatted = formatted.replace(/\n{3,}/g, '\n\n');
    return formatted;
}

function detectDbFromSql(sql) {
    var m = sql.match(/(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+`?(\w+)`?\./i);
    return m && m[1] ? m[1] : '';
}

// 从 SQL 中提取主表名（用于 DELETE/UPDATE 的 WHERE 条件优化）
function detectTableFromSql(sql) {
    if (!sql) return '';
    var s = sql.replace(/\s+/g, ' ').trim();
    // 1) UPDATE table SET ... 或 DELETE FROM table ...
    var m1 = s.match(/^(?:UPDATE|DELETE\s+FROM)\s+(?:`\w+`\.|"\w+"\.|\[\w+\]\.)?[`"'\[]?(\w+)[`"'\]]?(?:\s|$)/i);
    if (m1) return m1[1];
    // 2) FROM db.table alias, FROM table JOIN ..., FROM (sub) alias
    //    跳过子查询：FROM (select ...) alias
    var m2 = s.match(/FROM\s+\((?:[^()]|\([^()]*\))*\)\s+[`"'\[]?(\w+)/i);
    if (m2) return m2[1];
    // 3) FROM [db.]table [alias] ... 常见格式
    var m3 = s.match(/FROM\s+(?:`\w+`\.|"\w+"\.|\[\w+\]\.)?[`"'\[]?(\w+)[`"'\]]?(?:\s+(?:AS\s+)?\w+|\s+JOIN|\s+WHERE|\s+ORDER|\s+GROUP|\s+LIMIT|\s*[;,]|\s*$)/i);
    if (m3) return m3[1];
    return '';
}

// ==================== 编辑器快捷键辅助函数 ====================

/** Ctrl+D: 复制当前行到下一行（保持原有缩进） */
function _editorDupLine(ta) {
    var val = ta.value;
    var start = ta.selectionStart, end = ta.selectionEnd;
    // 确定操作行范围（支持多行选区复制所有选中行）
    var lineStart = val.lastIndexOf('\n', start - 1) + 1;
    var lineEnd = val.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = val.length;
    var linesText = val.substring(lineStart, lineEnd);
    // 在选区末尾后插入换行 + 复制内容
    var insert = '\n' + linesText;
    // ★ 用 execCommand('insertText') 替代 setRangeText，产生原生撤销记录，Ctrl+Z 可撤回
    ta.focus();
    ta.setSelectionRange(lineEnd, lineEnd);
    document.execCommand('insertText', false, insert);
}

/** Ctrl+/ (Slash): 切换行注释 -- */
function _editorToggleComment(ta) {
    var start = ta.selectionStart, end = ta.selectionEnd;
    var val = ta.value;
    // 确定选区的完整行范围
    var lineStart = val.lastIndexOf('\n', start - 1) + 1;
    var lineEnd = val.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = val.length;
    var selText = val.substring(lineStart, lineEnd);
    var lines = selText.split('\n');
    // 判断所有行是否都已注释
    var allCommented = lines.length > 0 && lines.every(function(l) { return /^\s*--/.test(l); });
    var newText;
    if (allCommented) {
        // 取消注释：移除每行第一个 --
        newText = lines.map(function(l) { return l.replace(/^(\s*)--\s?/, '$1'); }).join('\n');
    } else {
        // 添加注释：在每行最前面加 --
        newText = lines.map(function(l) { return '--' + l; }).join('\n');
    }
    // ★ 用 execCommand('insertText') 替代 setRangeText，产生原生撤销记录
    ta.focus();
    ta.setSelectionRange(lineStart, lineEnd);
    document.execCommand('insertText', false, newText);
}

/** Ctrl+Shift+K: 删除当前行（或多行选区对应的行） */
function _editorDeleteLine(ta) {
    var val = ta.value;
    var start = ta.selectionStart, end = ta.selectionEnd;
    var lineStart = val.lastIndexOf('\n', start - 1) + 1;
    var lineEnd = val.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = val.length;
    // 删除整行含换行符
    var delStart = lineStart > 0 ? lineStart - 1 : 0;     // 吞掉前一行的 \n
    var delEnd = lineEnd < val.length ? lineEnd + 1 : lineEnd; // 吞掉本行末尾的 \n
    // ★ 用 execCommand('insertText') 替代 setRangeText，产生原生撤销记录
    ta.focus();
    ta.setSelectionRange(delStart, delEnd);
    document.execCommand('insertText', false, '');
}

/** Tab: 缩进选中行（插入4个空格） */
function _editorIndent(ta) {
    var start = ta.selectionStart, end = ta.selectionEnd;
    var val = ta.value;
    var lineStart = val.lastIndexOf('\n', start - 1) + 1;
    var lineEnd = val.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = val.length;
    var selText = val.substring(lineStart, lineEnd);
    var lines = selText.split('\n');
    var newText = lines.map(function(l) { return '    ' + l; }).join('\n');
    // ★ 用 execCommand('insertText') 替代 setRangeText，产生原生撤销记录
    ta.focus();
    ta.setSelectionRange(lineStart, lineEnd);
    document.execCommand('insertText', false, newText);
}

/** Shift+Tab: 减少缩进（移除最多4个前导空格） */
function _editorOutdent(ta) {
    var start = ta.selectionStart, end = ta.selectionEnd;
    var val = ta.value;
    var lineStart = val.lastIndexOf('\n', start - 1) + 1;
    var lineEnd = val.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = val.length;
    var selText = val.substring(lineStart, lineEnd);
    var lines = selText.split('\n');
    var newText = lines.map(function(l) { return l.replace(/^ {1,4}/, ''); }).join('\n');
    // ★ 用 execCommand('insertText') 替代 setRangeText，产生原生撤销记录
    ta.focus();
    ta.setSelectionRange(lineStart, lineEnd);
    document.execCommand('insertText', false, newText);
}

// 查询执行取消标记（按 qid）
var _execCancelFlags = {};
var _execStartTime = {};  // ★ 记录执行开始时间，防止按钮瞬间闪回
var _execRunning = {};    // ★ 可靠的"正在执行"状态标记（按 qid），用于取消判定和 tab 切换后按钮复位
var _execToken = {};      // ★ 执行令牌（按 qid），每次新执行递增，旧链检测令牌不匹配则放弃
// ★ 快捷查询编辑器缓存（用于保留 textarea DOM 元素 + 撤销历史，解决 tab 切换后 Ctrl+Z 失效）
var _textareaCache = {};
