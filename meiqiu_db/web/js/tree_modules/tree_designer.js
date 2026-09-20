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
                'VARCHAR', 'CHAR', 'CHARACTER VARYING', 'TEXT',
                'BOOLEAN',
                'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIMESTAMP WITH TIME ZONE',
                'TIMESTAMP WITHOUT TIME ZONE', 'TIME WITH TIME ZONE', 'TIME WITHOUT TIME ZONE', 'INTERVAL',
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
                'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'TINYBLOB', 'BINARY', 'VARBINARY',
                'JSON', 'ENUM', 'SET', 'BOOLEAN']
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
    mysql: ['TEXT','MEDIUMTEXT','LONGTEXT','TINYTEXT','BLOB','MEDIUMBLOB','LONGBLOB','TINYBLOB','ENUM','SET',
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
        var originalType = row.getAttribute('data-original-type') || '';
        var originalLen = row.getAttribute('data-original-len') || '';
        var originalBase = originalType.split('(')[0].trim().toUpperCase();
        var aliases = {'CHARACTER VARYING':'VARCHAR', 'TIMESTAMP WITHOUT TIME ZONE':'TIMESTAMP', 'TIME WITHOUT TIME ZONE':'TIME'};
        var preserveOriginalType = originalType && (aliases[originalBase] || originalBase) === dt && originalLen === len;
        // ★ 无长度类型不拼接括号（如 Oracle DATE/TIMESTAMP/CLOB 等）
        var useLen = len && _typeSupportsLen(dbType, dt);
        var hasOriginal = row.getAttribute('data-original-existing') === '1';
        var originalName = row.getAttribute('data-original-name') || '';
        var originalNullable = row.getAttribute('data-original-nullable') === '1';
        var originalDefaultPresent = row.getAttribute('data-original-default-present') === '1';
        var originalDefault = row.getAttribute('data-original-default') || '';
        var originalAutoinc = row.getAttribute('data-original-autoinc') === '1';
        var originalPosition = parseInt(row.getAttribute('data-original-position') || '', 10);
        var originalComment = row.getAttribute('data-original-comment') || '';
        var currentColType = preserveOriginalType ? originalType : (useLen ? dt + '(' + len + ')' : dt);
        var normalizeType = function(v) {
            return String(v || '').toUpperCase().replace(/\s+/g, '').replace(/,\s*/g, ',');
        };
        var normalizeDefault = function(v) {
            var value = v === null || v === undefined ? '' : String(v).trim();
            if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") value = value.slice(1, -1);
            return value;
        };
        var currentDefault = defEl ? (defEl.value.trim() || null) : null;
        var fieldChanged = !hasOriginal ||
            originalName !== colName ||
            normalizeType(originalType) !== normalizeType(currentColType) ||
            originalLen !== (useLen ? len : '') ||
            originalNullable !== (nullEl ? nullEl.checked : true) ||
            originalDefaultPresent !== (currentDefault !== null) ||
            normalizeDefault(originalDefault) !== normalizeDefault(currentDefault) ||
            originalAutoinc !== (aiEl ? aiEl.checked : false) ||
            (originalPosition && originalPosition !== i + 1) ||
            originalComment !== (cmtEl ? cmtEl.value.trim() : '');
        d.columns.push({
            name: colName,
            data_type: dt,
            col_type: currentColType,
            length: useLen ? len : '',
            nullable: nullEl ? nullEl.checked : true,
            default_val: defEl ? (defEl.value.trim() || null) : null,
            position: i + 1,
            auto_increment: aiEl ? aiEl.checked : false,
            comment: cmtEl ? cmtEl.value.trim() : '',
            _field_changed: fieldChanged
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
            return '<div class="design-sql-preview">' + formatted + '</div>';
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

/** ★ 构建查询编辑器 HTML（不绑定事件，只生成 DOM） */
function _buildQueryEditorHtml(qid, cid, db, sql, name) {
    var connLabel = '';
    var connData = (cid && treeData && treeData.connections) ? treeData.connections[cid] : null;
    if (connData) {
        var typeIcon = _dbLogoImg(connData.db_type, 14);
        var connName = connData.name || connData.host || '未知连接';
        var dbName = db || '未选择数据库';
        connLabel = '<span class="conn-label" style="margin-left:auto;font-size:11px;white-space:nowrap;">' +
            typeIcon + ' ' + escapeHtml(connName) +
            ' <span class="conn-label-sep">/</span> ' +
            '<span class="conn-label-db">' + escapeHtml(dbName) + '</span></span>';
    }
    return '<div class="query-layout" id="ql_'+qid+'">' +
        '<div class="query-toolbar" style="display:flex;align-items:center;"><button id="btn_exe_'+qid+'" class="btn btn-green" style="font-size:11px;padding:4px 14px;" onclick="execQueryTab(\''+qid+'\')">▶ 执行</button>' +
        '<button id="btn_fmt_'+qid+'" class="btn btn-sm btn-fmt" style="font-size:11px;padding:4px 10px;margin-left:4px;" onclick="_formatSqlTab(\''+qid+'\')" title="格式化 SQL (Ctrl+B)">🧹 美化</button>' +
        '<label class="sql-error-policy-label" for="sql_error_policy_'+qid+'">遇错处理：</label>' +
        '<select id="sql_error_policy_'+qid+'" class="sql-error-policy" title="多条 SQL 执行遇到错误时的处理方式">' +
            '<option value="stop">遇错停止</option>' +
            '<option value="continue">忽略错误继续</option>' +
        '</select>' +
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
        '<div class="sql-ln-gutter" id="lng_'+qid+'"><div class="sql-ln-rows" id="lnr_'+qid+'"></div></div>' +
        '<div class="sql-editor-inner" style="position:relative;flex:1;min-width:0;display:flex;">' +
            '<div class="sql-highlight" id="sql_hl_'+qid+'" aria-hidden="true" style="display:none;z-index:-1;"></div>' +
            '<textarea id="sq_'+qid+'" class="query-editor" spellcheck="false" wrap="off">'+(sql||'')+'</textarea>' +
        '</div>' +
        '</div>' +
        '<div class="query-splitter" id="qs_'+qid+'"></div>' +
        '<div class="query-results-wrap" id="qr_'+qid+'"></div>' +
        '</div>';
}

/** ★ 初始化查询编辑器事件绑定（新建/重新打开后调用） */
function _initQueryEditorEvents(qid, cid, db, name) {
    var ta = document.getElementById('sq_'+qid);
    var btnE = document.getElementById('btn_exe_'+qid);
    function updateBtnLabel() {
        if (!ta || !btnE || btnE.textContent === '⏹ 取消') return;
        var s = ta.selectionStart, e = ta.selectionEnd;
        btnE.textContent = (s !== e) ? '▶ 执行选中' : '▶ 执行';
    }
    if (ta) {
        ta.addEventListener('input', function(){
            _queryTextareaChanged(qid, ta);
            _syncLineGutter(qid, ta);
            _applySqlHighlightDebounced(qid, ta);
            // 粘贴大量 SQL 后等待布局更新，再同步一次滚动位置。
            setTimeout(function(){ _syncLineGutter(qid, ta); _syncLineGutterScroll(qid, ta); }, 0);
        });
        _initAutocomplete(ta, qid, cid, db); // ★ SQL 自动补全（必须在 keydown 之前注册以优先响应 Tab/Enter）
        ta.addEventListener('keydown',function(e){
            if(e.ctrlKey&&e.key==='Enter') execQueryTab(qid);
            if(e.ctrlKey&&(e.key==='s'||e.key==='S')) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); _handleSaveQuery(qid, cid, db); }
            if(e.ctrlKey&&(e.key==='b'||e.key==='B')) { e.preventDefault(); _formatSqlTab(qid); }
            if(e.ctrlKey&&(e.key==='f'||e.key==='F')) { e.preventDefault(); e.stopPropagation(); _openSqlFind(qid, ta); return; }
            if(e.ctrlKey&&(e.key==='d'||e.key==='D')) { e.preventDefault(); _editorDupLine(ta); }
            if(e.ctrlKey&&e.key==='/') { e.preventDefault(); _editorToggleComment(ta); }
            if(e.ctrlKey&&e.shiftKey&&(e.key==='K'||e.key==='k')) { e.preventDefault(); _editorDeleteLine(ta); }
            if(e.key==='Tab') {
                // ★ 如果自动补全可见，让补全接管（先于缩进执行）
                if (typeof _acState !== 'undefined' && _acState.visible && _acState.items && _acState.items.length > 0) {
                    // 不 preventDefault，让 _initAutocomplete 的 handler 接管
                    return;
                }
                e.preventDefault();
                if(e.shiftKey) _editorOutdent(ta);
                else _editorIndent(ta);
            }
            if(e.key==='Escape') { var bar=document.getElementById('sql_find_bar_'+qid); if(bar && bar.style.display!=='none'){ e.preventDefault(); _closeSqlFind(qid, ta); } }
        });
        ta.addEventListener('mouseup', function(){ updateBtnLabel(); _syncLineGutter(qid, ta); });
        ta.addEventListener('keyup', function(e){
            updateBtnLabel();
            _syncLineGutter(qid, ta);
            // ★ 移动光标后，自动滚动到光标位置
            var moveKeys = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Enter'];
            if (moveKeys.indexOf(e.key) !== -1) {
                requestAnimationFrame(function(){ _scrollToCursor(ta); });
            }
        });
        ta.addEventListener('scroll', function(){
            _syncLineGutterScroll(qid, ta);
            _positionHighlightOverlay(qid, ta);
        });
        _syncLineGutter(qid, ta);
    }
    initQuerySplitter('ql_'+qid, 'qs_'+qid, 'sq_'+qid, 'qr_'+qid);
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
    // ★ 清理旧的编辑状态缓存（防止残留的 _cachedSql 覆盖新加载的内容）
    if (_queryEditStates[qid]) {
        delete _queryEditStates[qid]._cachedSql;
        _queryEditStates[qid]._cachedHtml = '';
    }
    var content = _buildQueryEditorHtml(qid, cid, qdb, q.sql, q.name);
    // ★ 初始化修改追踪快照
    _querySavedSql[qid] = q.sql || '';
    _queryModified[qid] = false;
    addOrUpdateTab('query_'+qid, q.name, 'query', content, q.db, cid);
    // ★ 记录基础名称（不带 * 的原始名）
    var tab = objectTabs.find(function(t){ return t.id === 'query_' + qid; });
    if (tab) tab._baseLabel = q.name;
    setTimeout(function(){
        _initQueryEditorEvents(qid, cid, qdb, q.name);
    }, 100);
}

/** 渲染 SQL 编辑器行号侧边栏 */
function _syncLineGutter(qid, ta) {
    if (!ta) { ta = document.getElementById('sq_' + qid); }
    if (!ta) return;
    var gutter = document.getElementById('lng_' + qid);
    var rowsEl = document.getElementById('lnr_' + qid);
    if (!gutter) return;
    if (!rowsEl) {
        rowsEl = document.createElement('div');
        rowsEl.className = 'sql-ln-rows';
        rowsEl.id = 'lnr_' + qid;
        gutter.appendChild(rowsEl);
    }
    // textarea 会把换行规范化为 LF，但粘贴/恢复内容时仍兼容 CRLF/CR。
    // 用 split 计算行数，确保末尾空行也有对应的行号。
    var lines = ta.value.split(/\r\n|\r|\n/).length;
    var html = '';
    var cursorLine = _getCursorLineNo(ta);
    var lineH = parseFloat(window.getComputedStyle(ta).lineHeight) || 18;
    for (var i = 1; i <= lines; i++) {
        var cls = i === cursorLine ? ' class="ln-row ln-active"' : ' class="ln-row"';
        html += '<div' + cls + ' data-line="' + i + '" style="height:' + lineH + 'px;line-height:' + lineH + 'px;" onmousedown="_lnSelectLine(\'' + qid + '\',' + i + ',event)">' + i + '</div>';
    }
    rowsEl.innerHTML = html;
    _syncLineGutterScroll(qid, ta);
}

/** 行号内容使用 transform 跟随 textarea，避免 overflow:hidden 容器的 scrollTop 在粘贴大量文本后失效。 */
function _syncLineGutterScroll(qid, ta) {
    if (!ta) ta = document.getElementById('sq_' + qid);
    var rowsEl = document.getElementById('lnr_' + qid);
    if (!rowsEl || !ta) return;
    rowsEl.style.transform = 'translate3d(0, ' + (-ta.scrollTop) + 'px, 0)';
}

/** 获取光标所在行号（1-based） */
function _getCursorLineNo(ta) {
    if (!ta) return 1;
    var pos = ta.selectionStart;
    var text = ta.value.substring(0, pos);
    return (text.match(/\n/g) || []).length + 1;
}

/** ★ 行号拖拽选多行状态 */
var _lnDragState = null;

/** ★ 全局 mousemove：拖拽行号时扩展选区 */
document.addEventListener('mousemove', function(e) {
    if (!_lnDragState) return;
    var gutter = document.getElementById('lng_' + _lnDragState.qid);
    if (!gutter) return;
    var lineDiv = e.target.closest && e.target.closest('[data-line]');
    if (!lineDiv || !gutter.contains(lineDiv)) return;
    var lineNo = parseInt(lineDiv.getAttribute('data-line'));
    if (isNaN(lineNo) || lineNo === _lnDragState._prevLine) return;
    _lnDragState._prevLine = lineNo;
    var lines = _lnDragState.ta.value.split('\n');
    var lineEnd = 0;
    for (var i = 0; i < lineNo && i < lines.length; i++) {
        lineEnd += lines[i].length + (i < lineNo - 1 ? 1 : 0);
    }
    // 从锚点行开始，到当前行结束
    var anchor = _lnDragState.anchorStart;
    if (lineNo >= _lnDragState.anchorLine) {
        _lnDragState.ta.selectionStart = anchor;
        _lnDragState.ta.selectionEnd = lineEnd;
    } else {
        // 向上拖拽：交换方向
        var aboveStart = 0;
        for (var j = 0; j < lineNo - 1 && j < lines.length; j++) {
            aboveStart += lines[j].length + 1;
        }
        _lnDragState.ta.selectionStart = aboveStart;
        _lnDragState.ta.selectionEnd = anchor + (lines[_lnDragState.anchorLine - 1] || '').length;
    }
    _syncLineGutter(_lnDragState.qid, _lnDragState.ta);
}, {passive: true});

/** ★ 全局 mouseup：结束行号拖拽 */
document.addEventListener('mouseup', function(e) {
    if (!_lnDragState) return;
    _lnDragState = null;
});

/** 行号列 mousedown：选中整行 + 启动拖拽多选 */
function _lnSelectLine(qid, lineNo, e) {
    var ta = document.getElementById('sq_' + qid);
    if (!ta) return;
    e.preventDefault();
    var lines = ta.value.split('\n');
    var lineStart = 0;
    for (var i = 0; i < lineNo - 1 && i < lines.length; i++) {
        lineStart += lines[i].length + 1;
    }
    var lineEnd = lineStart + (lines[lineNo - 1] || '').length;
    ta.focus();
    if (e.shiftKey) {
        ta.selectionEnd = lineEnd;
    } else {
        ta.selectionStart = lineStart;
        ta.selectionEnd = lineEnd;
    }
    // ★ 启动拖拽多选状态
    _lnDragState = {
        qid: qid, ta: ta,
        anchorLine: lineNo, anchorStart: lineStart,
        _prevLine: lineNo
    };
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

/** 自动滚动 textarea 使光标在水平和垂直方向都可见 */
function _scrollToCursor(ta) {
    if (!ta) return;
    // ★ 使用 selectionEnd（拖拽选中时光标在终点；未选中时等于 selectionStart）
    var pos = ta.selectionEnd !== ta.selectionStart ? ta.selectionEnd : ta.selectionStart;
    var val = ta.value;
    var textBefore = val.substring(0, pos);
    var lines = textBefore.split('\n');
    var curLine = lines.length; // 光标所在行号（1-based）
    var colInLine = lines[lines.length - 1].length; // 光标在当前行的列号

    // ★ 垂直滚动：确保光标行可见
    var lineH = 18;
    var targetTop = (curLine - 1) * lineH;
    var viewTop = ta.scrollTop;
    var viewH = ta.clientHeight;
    var viewBottom = viewTop + viewH - lineH;
    if (targetTop < viewTop) {
        ta.scrollTop = Math.max(0, targetTop - lineH * 2);
    } else if (targetTop > viewBottom) {
        ta.scrollTop = targetTop - viewH + lineH * 3;
    }

    // ★ 水平滚动：确保光标列可见（monospace 字体，Consolas 12px ≈ 7.26px/char）
    var charW = 7.26;
    var cursorX = colInLine * charW + 12;
    var viewLeft = ta.scrollLeft;
    var viewW = ta.clientWidth;
    // 光标在行首 → 强制回到最左边
    if (colInLine === 0 && viewLeft > 0) {
        ta.scrollLeft = 0;
        return;
    }
    var viewRight = viewLeft + viewW;
    if (cursorX < viewLeft + 4) {
        ta.scrollLeft = Math.max(0, cursorX - 40);
    } else if (cursorX > viewRight - 12) {
        ta.scrollLeft = Math.max(0, cursorX - viewW + 40);
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

// ★ SQL 高亮防抖：大量粘贴时避免每次 input 都重新渲染
var _sqlHighlightTimers = {};
function _applySqlHighlightDebounced(qid, ta) {
    if (_sqlHighlightTimers[qid]) clearTimeout(_sqlHighlightTimers[qid]);
    _sqlHighlightTimers[qid] = setTimeout(function(){
        _applySqlHighlight(qid, ta);
    }, 150);
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

    // ★ 无搜索：隐藏高亮层，使用原生 textarea（避免挡光标/选中高亮）
    if (!isSearch) {
        hl.style.display = 'none';
        hl.style.zIndex = '-1';
        ta.style.color = '';
        ta.style.caretColor = '';
        ta.style.background = '';
        _sqlFindState[qid] = null;
        return;
    }

    // ★ 仅在搜索模式下显示高亮层
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


// ★ 智能保存：未命名弹命名框，已命名直接保存
function _handleSaveQuery(qid, cid, db) {
    var tab = objectTabs.find(function(t){ return t.id === 'query_' + qid; });
    var qname = tab ? (tab._baseLabel || tab.label) : '';
    var isUnnamed = (!qname || qname === '未命名');

    if (isUnnamed) {
        // ★ 未命名 → 弹出命名框，检测是否输入了名称
        function promptName() {
            showInputDialog('保存查询', '请输入查询名称：', function(n){
                if (!n || !n.trim()) {
                    showErrorDialog('提示', '请输入文件名称后再保存', function(){
                        promptName(); // 关闭错误提示后重新弹命名框
                    });
                    return;
                }
                _doSaveQuery(qid, cid, db, n.trim());
            }, '');
        }
        promptName();
    } else {
        // ★ 已命名 → 直接保存
        _doSaveQuery(qid, cid, db, qname);
    }
}

// ★ 执行保存操作
function _doSaveQuery(qid, cid, db, qname) {
    var ta = document.getElementById('sq_' + qid);
    if (!ta) return;
    var sql = ta.value;
    // ★ 如果是新建的临时查询（qid 以 new_ 开头），传空 qid 让后端生成正式 ID
    var isNew = (qid.indexOf('new_') === 0);
    var saveQid = isNew ? '' : qid;
    eel.tree_save_query(saveQid, qname, sql, cid, db)(function(r){
        if (r && r.ok) {
            var newQid = isNew ? r.id : qid;
            // ★ 如果是新建的，需要更新 tab ID（从临时 ID 改为正式 ID）
            if (isNew) {
                var tab = objectTabs.find(function(t){ return t.id === 'query_' + qid; });
                if (tab) {
                    tab.id = 'query_' + newQid;
                    tab._baseLabel = qname;
                    tab.label = qname;
                    tab.content = _buildQueryEditorHtml(newQid, cid, db, sql, qname);
                    // ★ 更新 activeObjTab 到新 ID，避免跳转到 home
                    if (activeObjTab === 'query_' + qid) activeObjTab = 'query_' + newQid;
                    // 更新追踪状态
                    delete _queryModified[qid];
                    delete _querySavedSql[qid];
                    _querySavedSql[newQid] = sql;
                    _queryModified[newQid] = false;
                    // ★ 重新绑定编辑器事件
                    setTimeout(function(){
                        _initQueryEditorEvents(newQid, cid, db, qname);
                    }, 50);
                }
            } else {
                var tab2 = objectTabs.find(function(t){ return t.id === 'query_' + qid; });
                if (tab2) {
                    tab2._baseLabel = qname;
                    tab2.label = qname;
                }
                _querySavedSql[qid] = sql;
                _setQueryModified(qid, false);
            }
            // 绿色边框闪烁提示已保存
            var ta2 = document.getElementById('sq_' + newQid);
            if (ta2) {
                ta2.style.boxShadow = 'inset 0 0 0 2px #2ecc71';
                ta2.style.transition = 'box-shadow 0.3s';
                var clearFlash = function(){ ta2.style.boxShadow = ''; };
                setTimeout(clearFlash, 1200);
                ta2.addEventListener('blur', function _onceBlur(){ ta2.removeEventListener('blur', _onceBlur); clearFlash(); });
            }
            // ★ 刷新树中查询列表 + 更新 tab 栏（新建的需要更新 tab 栏中的 ID 引用）
            if (cid && db && typeof refreshQueriesTree === 'function') {
                refreshQueriesTree(cid, db, '');
            }
            if (isNew) {
                // ★ 只更新 tab 栏 DOM，不重新渲染整个面板（避免跳转）
                _updateTabBar();
            }
        } else {
            var errMsg = (r && r.msg) ? r.msg : '未知错误';
            showErrorDialog('保存失败', errMsg);
        }
    });
}

// ★ 兼容旧调用（保留原函数名）
function saveQueryTab(qid, cid, db, qname) {
    _handleSaveQuery(qid, cid, db);
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

    // ★ 区分：有选中 → 只美化选中的 SQL；没选中 → 美化整篇
    var hasSelection = selStart !== selEnd;
    var targetText = hasSelection ? sql.substring(selStart, selEnd) : sql;
    if (!targetText || !targetText.trim()) return;

    try {
        var formatted = _formatSql(targetText);
        // ★ 用 execCommand 替换选中/全部内容，使其支持 Ctrl+Z 撤销
        ta.focus();
        if (hasSelection) {
            ta.setSelectionRange(selStart, selEnd);
        } else {
            ta.select();
        }
        document.execCommand('insertText', false, formatted);
        // 尝试恢复光标到相近位置
        var newPos;
        if (hasSelection) {
            // 选中段被替换后，新光标放在替换内容的开头
            newPos = selStart;
        } else {
            newPos = Math.min(selStart, formatted.length);
        }
        ta.selectionStart = newPos;
        ta.selectionEnd = newPos;
        ta.scrollTop = scrollTop;
        // 触发 input 事件以更新行号、高亮等
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        // 橙色闪烁提示
        ta.style.boxShadow = 'inset 0 0 0 2px #f39c12';
        ta.style.transition = 'box-shadow 0.3s';
        var clearFlash = function(){ ta.style.boxShadow = ''; };
        setTimeout(clearFlash, 1200);
        ta.addEventListener('blur', function _onceBlur(){ ta.removeEventListener('blur', _onceBlur); clearFlash(); });
    } catch(e) {
        // 格式化失败不影响使用，恢复原值
        console.warn('SQL 格式化失败:', e);
        ta.focus();
        if (hasSelection) {
            ta.setSelectionRange(selStart, selEnd);
        } else {
            ta.select();
        }
        document.execCommand('insertText', false, targetText);
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

// Replace a textarea range through the native editing command so Ctrl+Z can undo it.
// setRangeText is kept as a compatibility fallback for embedded browser versions that
// do not implement execCommand('insertText') for textarea elements.
function _editorReplaceRangeWithUndo(ta, start, end, text, nextStart, nextEnd) {
    var oldValue = ta.value;
    var expected = oldValue.substring(0, start) + text + oldValue.substring(end);
    ta.focus();
    ta.setSelectionRange(start, end);
    var inputSeen = false;
    var markInput = function() { inputSeen = true; };
    ta.addEventListener('input', markInput);
    var commandOk = false;
    try { commandOk = document.execCommand('insertText', false, text); } catch (ignore) {}
    ta.removeEventListener('input', markInput);
    if (!commandOk || ta.value !== expected) {
        if (typeof ta.setRangeText === 'function') ta.setRangeText(text, start, end, 'end');
        else ta.value = expected;
    }
    if (!inputSeen) ta.dispatchEvent(new Event('input', { bubbles: true }));
    var max = ta.value.length;
    ta.selectionStart = Math.max(0, Math.min(max, nextStart));
    ta.selectionEnd = Math.max(ta.selectionStart, Math.min(max, nextEnd));
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
    var delta = lines.length * 4;
    _editorReplaceRangeWithUndo(ta, lineStart, lineEnd, newText, start + 4, end + delta);
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
    var removed = lines.map(function(l) {
        if (l.charAt(0) === '\t') return 1;
        var m = l.match(/^ {1,4}/);
        return m ? m[0].length : 0;
    });
    var newText = lines.map(function(l) {
        if (l.charAt(0) === '\t') return l.substring(1);
        return l.replace(/^ {1,4}/, '');
    }).join('\n');
    var removedTotal = removed.reduce(function(sum, n) { return sum + n; }, 0);
    var firstRemoved = removed.length ? removed[0] : 0;
    _editorReplaceRangeWithUndo(ta, lineStart, lineEnd, newText,
        Math.max(lineStart, start - firstRemoved), Math.max(lineStart, end - removedTotal));
}

// 查询执行取消标记（按 qid）
var _execCancelFlags = {};
var _execStartTime = {};  // ★ 记录执行开始时间，防止按钮瞬间闪回
var _execRunning = {};    // ★ 可靠的"正在执行"状态标记（按 qid），用于取消判定和 tab 切换后按钮复位
var _execToken = {};      // ★ 执行令牌（按 qid），每次新执行递增，旧链检测令牌不匹配则放弃
// ★ 快捷查询编辑器缓存（用于保留 textarea DOM 元素 + 撤销历史，解决 tab 切换后 Ctrl+Z 失效）
var _textareaCache = {};
