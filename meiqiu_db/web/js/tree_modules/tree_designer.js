// ==================== 设计器交互函数 ====================
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
    var ds = window._tableDesign;
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
    var ds = window._tableDesign;
    if (!ds) return;
    ds.design.columns.push({name:'new_field', data_type:'VARCHAR', col_type:'VARCHAR(255)', length:'255', nullable:true, default_val:null, auto_increment:false, comment:''});
    rebuildFieldsTable();
}

function designInsertField(pos) {
    collectFieldsToDesign();
    var ds = window._tableDesign;
    if (!ds) return;
    ds.design.columns.splice(pos < 0 ? 0 : pos, 0, {name:'new_field', data_type:'VARCHAR', col_type:'VARCHAR(255)', length:'255', nullable:true, default_val:null, auto_increment:false, comment:''});
    rebuildFieldsTable();
}

function designRemoveField(row) {
    collectFieldsToDesign();
    var ds = window._tableDesign;
    if (!ds) return;
    if (ds.design.columns.length <= 1) { showWarnDialog('提示', '至少保留一个字段'); return; }
    ds.design.columns.splice(row, 1);
    rebuildFieldsTable();
}

function rebuildFieldsTable() {
    var ds = window._tableDesign;
    if (!ds) return;
    var dataTypes = ['INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'FLOAT', 'DOUBLE', 'DECIMAL',
        'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYTEXT',
        'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
        'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'TINYBLOB', 'JSON', 'ENUM', 'SET', 'BOOLEAN'];
    var rowsHtml = '';
    for (var i = 0; i < ds.design.columns.length; i++) {
        rowsHtml += buildFieldRow(i, ds.design.columns[i], dataTypes);
    }
    var tbody = document.querySelector('#design_fields_table tbody');
    if (tbody) tbody.innerHTML = rowsHtml;
}

// 把当前索引表单数据保存回 ds.design.indexes
function collectIndexesToDesign() {
    var ds = window._tableDesign;
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
    var ds = window._tableDesign;
    if (!ds) return;
    var idxName = 'idx_' + ds.design.columns[0].name;
    ds.design.indexes.push({name: idxName, type: 'INDEX', columns: [ds.design.columns[0].name], method: 'BTREE'});
    buildDesignerUI(ds.tabId, ds.tn, ds.design);
    designSwitchTab('indexes');
}

function designRemoveIndex(j) {
    collectFieldsToDesign();
    collectIndexesToDesign();
    var ds = window._tableDesign;
    if (!ds) return;
    ds.design.indexes.splice(j, 1);
    buildDesignerUI(ds.tabId, ds.tn, ds.design);
    designSwitchTab('indexes');
}

// 收集表单数据到 design 对象
function designCollect() {
    var ds = window._tableDesign;
    if (!ds) return null;
    var d = JSON.parse(JSON.stringify(ds.design));

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
        d.columns.push({
            name: colName,
            data_type: dt,
            col_type: len ? dt + '(' + len + ')' : dt,
            length: len,
            nullable: nullEl ? nullEl.checked : true,
            default_val: defEl ? (defEl.value.trim() || null) : null,
            auto_increment: aiEl ? aiEl.checked : false,
            comment: cmtEl ? cmtEl.value.trim() : ''
        });
    }

    // 收集索引数据
    var idxNames = document.querySelectorAll('.idx-name');
    var idxTypes = document.querySelectorAll('.idx-type');
    var idxCols = document.querySelectorAll('.idx-cols');
    var idxMethods = document.querySelectorAll('.idx-method');
    for (var j = 0; j < idxNames.length && j < d.indexes.length; j++) {
        d.indexes[j].name = idxNames[j].value.trim();
        d.indexes[j].type = idxTypes[j].value;
        d.indexes[j].columns = idxCols[j].value.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
        d.indexes[j].method = idxMethods[j].value;
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

function designSave() {
    collectFieldsToDesign();
    collectIndexesToDesign();
    var ds = window._tableDesign;
    if (!ds) return;
    var design = designCollect();
    if (!design) return;

    // 先预览 SQL
    document.getElementById('modal_icon').innerHTML = '🔍';
    document.getElementById('modal_title').textContent = '预览变更 SQL';
    document.getElementById('modal_title').style.color = '#2980b9';
    document.getElementById('modal_msg').innerHTML = '<div style="color:#888;padding:20px;text-align:center;">⏳ 正在生成 SQL...</div>';
    document.getElementById('modal_btns').innerHTML = '<button class="btn btn-gray" onclick="hideModal()">取消</button>';
    document.getElementById('modal_overlay').classList.add('show');

    eel.table_apply_design(ds.conn, ds.db, ds.tn, design, ds.schema, false)(function(r) {
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
            '<button class="btn btn-gray" onclick="hideModal()">取消</button>' +
            '<button class="btn btn-red" id="modal_exec_btn">执行</button>';
        document.getElementById('modal_exec_btn').onclick = function() {
            hideModal();
            // 显示执行进度
            document.getElementById('modal_icon').innerHTML = '⏳';
            document.getElementById('modal_title').textContent = '执行中...';
            document.getElementById('modal_title').style.color = '#f39c12';
            document.getElementById('modal_msg').innerHTML = '<div style="text-align:center;padding:20px;color:#888;">正在应用表设计修改...</div>';
            document.getElementById('modal_btns').innerHTML = '';
            document.getElementById('modal_overlay').classList.add('show');

            eel.table_apply_design(ds.conn, ds.db, ds.tn, design, ds.schema, true)(function(r2) {
                document.getElementById('modal_overlay').classList.remove('show');
                if (r2 && r2.ok) {
                    showOkDialog('成功', r2.msg);
                    setTimeout(function() { designRefresh(); }, 300);
                } else {
                    showErrorDialog('失败', r2 ? r2.msg : '未知错误');
                }
            });
        };
    });
}

function designRefresh() {
    var ds = window._tableDesign;
    if (!ds) return;
    addTableDDLTab(ds.tn, ds.db, ds.schema, ds.cid);
}

function designViewDDL() {
    var ds = window._tableDesign;
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
    eel.tree_get_query(qid)(function(q){
        if(!q)return;
        var cid = q.conn_id || '';
        var qdb = q.db || '';
        // 确保 activeConnData 来自查询所属连接，不依赖外部状态
        if (cid && treeData && treeData.connections && treeData.connections[cid]) {
            activeConnId = cid;
            activeConnData = treeData.connections[cid];
        }
        var content =
            '<div class="query-layout" id="ql_'+qid+'">' +
            '<div class="query-toolbar"><button id="btn_exe_'+qid+'" class="btn btn-green" style="font-size:11px;padding:4px 14px;" onclick="execQueryTab(\''+qid+'\')">▶ 执行</button>' +
            '<span style="font-size:11px;color:#888;">Ctrl+Enter 执行 | Ctrl+S 保存</span></div>' +
            '<div class="query-editor-wrap"><textarea id="sq_'+qid+'" class="query-editor">'+escapeHtml(q.sql||'')+'</textarea></div>' +
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
                ta.addEventListener('input', function(){ _queryTextareaChanged(qid, ta); });
                ta.addEventListener('keydown',function(e){
                    if(e.ctrlKey&&e.key==='Enter') execQueryTab(qid);
                    if(e.ctrlKey&&(e.key==='s'||e.key==='S')) { e.preventDefault(); saveQueryTab(qid, cid, qdb, q.name); }
                });
                ta.addEventListener('mouseup', updateBtnLabel);
                ta.addEventListener('keyup', updateBtnLabel);
            }
            // 初始化可拖动分割线
            initQuerySplitter('ql_'+qid, 'qs_'+qid, 'sq_'+qid, 'qr_'+qid);
        },100);
    });
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
            setTimeout(function(){ ta.style.boxShadow = ''; }, 1200);
        }
    });
}

// 从 SQL 中检测 db.table 前缀引用，自动提取数据库名
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

// 查询执行取消标记（按 qid）
var _execCancelFlags = {};
var _execStartTime = {};  // ★ 记录执行开始时间，防止按钮瞬间闪回
var _execRunning = {};    // ★ 可靠的"正在执行"状态标记（按 qid），用于取消判定和 tab 切换后按钮复位
