"use strict";

// ========== DOM 引用 ==========
const $ = id => document.getElementById(id);
const logBox = $('log_box');
const progressFill = $('progress_fill');
const progressText = $('progress_text');

// ========== 日志（数据库同步专用） ==========
function appendLog(msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logBox.innerHTML += `<div>[${time}] ${msg}</div>`;
    logBox.scrollTop = logBox.scrollHeight;
}

// ========== 弹窗 ==========
function showModal(icon, title, msg, iconColor, btns) {
    $('modal_icon').textContent = icon;
    $('modal_title').textContent = title;
    $('modal_title').style.color = iconColor;
    $('modal_msg').innerHTML = msg;
    $('modal_btns').innerHTML = btns;
    $('modal_overlay').classList.add('show');
}
function hideModal() { $('modal_overlay').classList.remove('show'); }

function showOkDialog(title, msg, icon, iconColor) {
    icon = icon || '✅';
    iconColor = iconColor || '#2ecc71';
    showModal(icon, title, msg, iconColor,
        '<button class="btn btn-gray" onclick="hideModal()">确定</button>');
}
function showErrorDialog(title, msg) {
    showOkDialog(title, msg, '❌', '#e74c3c');
}
function showWarnDialog(title, msg) {
    showOkDialog(title, msg, '💡', '#f39c12');
}

// ========== 表单收集（按 prefix 隔离：sync_ / query_） ==========
function collectForm(prefix) {
    if (!prefix) prefix = 'sync_';
    return {
        src_host: $(prefix+'src_host').value.trim(),
        src_port: $(prefix+'src_port').value.trim() || '3306',
        src_user: $(prefix+'src_user').value.trim(),
        src_pwd:  $(prefix+'src_pwd').value.trim(),
        src_db:   $(prefix+'src_db').value.trim(),
        dst_host: $(prefix+'dst_host').value.trim(),
        dst_port: $(prefix+'dst_port').value.trim() || '3306',
        dst_user: $(prefix+'dst_user').value.trim(),
        dst_pwd:  $(prefix+'dst_pwd').value.trim(),
        dst_db:   $(prefix+'dst_db').value.trim(),
        table_name: $('table_name').value.trim()
    };
}

function fillForm(p, prefix) {
    if (!p) return;
    if (!prefix) prefix = 'sync_';
    $(prefix+'src_host').value = p.src_host || '';
    $(prefix+'src_port').value = p.src_port || '3306';
    $(prefix+'src_user').value = p.src_user || '';
    $(prefix+'src_pwd').value  = p.src_pwd  || '';
    $(prefix+'src_db').value   = p.src_db   || '';
    $(prefix+'dst_host').value = p.dst_host || '';
    $(prefix+'dst_port').value = p.dst_port || '3306';
    $(prefix+'dst_user').value = p.dst_user || '';
    $(prefix+'dst_pwd').value  = p.dst_pwd  || '';
    $(prefix+'dst_db').value   = p.dst_db   || '';
}

function clearSide(side, prefix) {
    const fields = ['host', 'port', 'user', 'pwd', 'db'];
    fields.forEach(f => {
        const el = $(prefix + side + '_' + f);
        if (el) { el.value = f === 'port' ? '3306' : ''; }
    });
    appendLog('🧹 ' + (side === 'src' ? '源库' : '目标库') + '配置已清空');
}

// ========== 配置管理（每个 Tab 独立） ==========
function loadProfiles(prefix) {
    if (!prefix) prefix = 'sync_';
    eel.get_profiles()(function (profiles) {
        eel.get_last_used()(function (lastUsed) {
            const menu = $(prefix+'dropdown_menu');
            if (!menu) return;
            menu.innerHTML = '';
            if (!profiles || !profiles.length) {
                $(prefix+'profile_btn_text').textContent = '选择配置';
                return;
            }
            if (lastUsed) {
                const p = profiles.find(x => x.name === lastUsed);
                if (p) { fillForm(p, prefix); $(prefix+'profile_btn_text').textContent = lastUsed; }
                else { $(prefix+'profile_btn_text').textContent = profiles[0].name; }
            } else {
                $(prefix+'profile_btn_text').textContent = profiles[0].name;
            }

            profiles.forEach(p => {
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                item.innerHTML = '<span>' + escapeHtml(p.name) + '</span><span><span class="edit-btn">✎</span><span class="del-btn">✕</span></span>';
                item.querySelector('span').onclick = function () { selectProfile(p.name, prefix); };
                item.querySelector('.del-btn').onclick = function (e) {
                    e.stopPropagation();
                    showConfirmDialog('确认删除', '确定要删除配置 [' + p.name + '] 吗？', function () {
                        eel.delete_profile(p.name)(function () {
                            appendLog('🗑 配置 [' + p.name + '] 已删除');
                            loadAllProfiles();
                        });
                    });
                };
                item.querySelector('.edit-btn').onclick = function (e) {
                    e.stopPropagation();
                    showInputDialog('✎ 重命名', '请输入新名称：', function (newName) {
                        if (!newName || !newName.trim() || newName.trim() === p.name) return;
                        eel.find_profile(p.name)(function (profile) {
                            if (!profile) return;
                            eel.delete_profile(p.name)(function () {
                                eel.save_profile(profile, newName.trim())(function () {
                                    appendLog('✎ 配置 [' + p.name + '] → [' + newName.trim() + ']');
                                    loadAllProfiles();
                                });
                            });
                        });
                    }, p.name);
                };
                menu.appendChild(item);
            });
        });
    });
}

function loadAllProfiles() {
    loadProfiles('sync_');
    loadProfiles('query_');
}

function selectProfile(name, prefix) {
    eel.find_profile(name)(function (p) {
        if (p) {
            fillForm(p, prefix);
            $(prefix+'profile_btn_text').textContent = name;
            appendLog('✅ 已加载配置 [' + name + ']');
        }
        $(prefix+'dropdown_menu').classList.remove('show');
    });
}

function saveProfile(prefix) {
    const data = collectForm(prefix);
    if (!data.src_host || !data.src_user || !data.src_db ||
        !data.dst_host || !data.dst_user || !data.dst_db) {
        showWarnDialog('提示', '请先填写完整的源库和目标库信息再保存');
        return;
    }
    showInputDialog('💾 保存配置', '请输入配置名称（例如：生产→测试）：', function (name) {
        if (!name || !name.trim()) return;
        eel.save_profile(data, name.trim())(function () {
            appendLog('💾 配置 [' + name.trim() + '] 已保存');
            loadAllProfiles();
        });
    });
}

function showInputDialog(title, msg, callback, defaultValue) {
    var defVal = defaultValue || '';
    showModal('💾', title, msg, '#2980b9',
        '<input id="input_dlg_val" style="width:100%;height:36px;margin-bottom:12px;background:#1a1a1a;border:1px solid #3a3a3a;border-radius:6px;color:#e0e0e0;padding:0 10px;font-size:13px;" placeholder="配置名称" value="' + escapeHtml(defVal) + '">' +
        '<div style="display:flex;gap:8px;">' +
        '<button class="btn btn-gray" style="flex:1;height:32px;font-size:11px;" onclick="hideModal()">取消</button>' +
        '<button class="btn btn-green" id="input_dlg_btn" style="flex:1;height:32px;font-size:11px;">保存</button>' +
        '</div>');
    setTimeout(function () {
        var inp = $('input_dlg_val');
        if (inp) { inp.focus(); inp.select(); }
        var btn = $('input_dlg_btn');
        if (btn) btn.onclick = function () {
            var val = inp ? inp.value : '';
            hideModal();
            callback(val);
        };
        if (inp) inp.onkeydown = function (e) {
            if (e.key === 'Enter') { hideModal(); callback(inp.value); }
        };
    }, 10);
}

function toggleDropdown(prefix) {
    $(prefix+'dropdown_menu').classList.toggle('show');
}

// 点击其他地方关闭所有下拉
document.addEventListener('click', function (e) {
    if (!e.target.closest('.dropdown')) {
        var menus = document.querySelectorAll('.dropdown-menu');
        menus.forEach(function (m) { m.classList.remove('show'); });
    }
});

// ========== 确认弹窗 ==========
function showConfirmDialog(title, msg, onConfirm) {
    showModal('⚠️', title, msg, '#e67e22',
        '<button class="btn btn-gray" onclick="hideModal()">取消</button>' +
        '<button class="btn btn-red" id="modal_confirm_btn">确定</button>');
    setTimeout(function () {
        const btn = $('modal_confirm_btn');
        if (btn) btn.onclick = function () { hideModal(); onConfirm(); };
    }, 10);
}

// ========== 测试连接（数据库同步 / 查询同步） ==========
function testConnection(side, prefix) {
    const data = collectForm(prefix);
    const label = side === 'src' ? '源库' : '目标库';
    const statusEl = $(prefix + 'test_' + side + '_status');

    if (side === 'src' && (!data.src_host || !data.src_user || !data.src_db)) {
        setTestStatus(statusEl, '⚠️ 请填写 IP、用户名、数据库名', '#f39c12');
        return;
    }
    if (side === 'dst' && (!data.dst_host || !data.dst_user)) {
        setTestStatus(statusEl, '⚠️ 请填写 IP、用户名', '#f39c12');
        return;
    }
    setTestStatus(statusEl, '⏳ 测试中...', '#f39c12');

    eel.test_connection(data, side)(function (result) {
        if (!result) {
            setTestStatus(statusEl, '❌ 无响应', '#e74c3c');
            return;
        }
        if (result.ok) {
            setTestStatus(statusEl, '✅ ' + result.msg, '#2ecc71');
        } else {
            setTestStatus(statusEl, '❌ ' + result.msg, '#e74c3c');
        }
    });
}

function setTestStatus(el, fullText, color) {
    el.style.color = color;
    if (fullText.length > 10) {
        el.textContent = fullText.substring(0, 10) + '...';
        el.title = '点击查看完整内容';
        el.setAttribute('data-full-msg', fullText);
        el.onclick = function () {
            showCellFull('连接结果', fullText);
        };
    } else {
        el.textContent = fullText;
        el.style.cursor = '';
        el.title = '';
        el.removeAttribute('data-full-msg');
        el.onclick = null;
    }
}

// ========== 传输控制（数据库同步 Tab） ==========
let pollingTimer = null;

function startTransfer() {
    const data = collectForm('sync_');
    if (!data.src_host || !data.src_user || !data.src_db ||
        !data.dst_host || !data.dst_user || !data.dst_db) {
        showWarnDialog('提示', '请填写所有必填项（IP、用户、数据库名）');
        return;
    }
    if (!data.table_name) {
        showConfirmDialog('确认全量同步',
            '是否全量同步数据库 [' + data.src_db + '] 到目标库 [' + data.dst_db + ']？',
            function () { doStartTransfer(data); });
        return;
    }
    doStartTransfer(data);
}

function doStartTransfer(data) {
    $('btn_start').disabled = true;
    $('btn_stop').disabled = false;
    progressFill.style.width = '0%';
    progressText.textContent = '就绪';
    logBox.innerHTML = '';

    eel.start_transfer(data)(function () {
        pollingTimer = setInterval(pollProgress, 100);
    });
}

function stopTransfer() {
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
    resetTransferBtns();
    appendLog('⏸ 用户手动停止传输');
    eel.stop_transfer()();
}

function resetTransferBtns() {
    $('btn_start').disabled = false;
    $('btn_stop').disabled = true;
}

function pollProgress() {
    eel.poll_queue()(function (msgs) {
        if (!msgs || !msgs.length) return;
        for (let i = 0; i < msgs.length; i++) {
            const type = msgs[i][0];
            const data = msgs[i][1];
            switch (type) {
                case 'log':
                    appendLog(data);
                    break;
                case 'table_progress':
                    progressText.textContent = '[' + data.table + '] ' + (data.count || 0).toLocaleString() + ' 行';
                    break;
                case 'total':
                    progressFill.style.width = '100%';
                    break;
                case 'done':
                    progressFill.style.width = '100%';
                    clearInterval(pollingTimer);
                    pollingTimer = null;
                    resetTransferBtns();
                    appendLog(data);
                    setTimeout(function () { showOkDialog('传输完成', data); }, 100);
                    break;
                case 'error':
                    clearInterval(pollingTimer);
                    pollingTimer = null;
                    resetTransferBtns();
                    appendLog(data);
                    setTimeout(function () { showErrorDialog('传输失败', data); }, 100);
                    break;
            }
        }
    });
}

// ========== SQL 查询（查询同步 Tab，使用 query_ 表单） ==========
let isQueryRunning = false;
let queryDiscard = false;

function executeQuery() {
    const ta = $('sql_input');
    if (isQueryRunning) {
        queryDiscard = true;
        eel.cancel_query()();
        isQueryRunning = false;
        const btn = $('btn_run_sql');
        btn.textContent = '▶ 执行源库查询';
        btn.style.background = '';
        appendLog('⏸ 查询已取消');
        return;
    }

    // 检查选中文本
    let sql = '';
    if (ta) {
        var ss = ta.selectionStart, se = ta.selectionEnd;
        if (ss !== se) {
            sql = ta.value.substring(ss, se).trim();
        }
    }
    if (!sql) sql = ta ? ta.value.trim() : '';
    if (!sql) { showWarnDialog('提示', '请输入 SQL 查询语句'); return; }
    sql = sql.split('\n').filter(function (l) { return !l.trim().startsWith('--'); }).join('\n').trim();
    if (!sql) { showWarnDialog('提示', '请输入有效的 SQL 查询语句'); return; }

    const data = collectForm('query_');
    if (!data.src_host || !data.src_user || !data.src_db) {
        showWarnDialog('提示', '请先填写完整的源库信息'); return;
    }

    isQueryRunning = true;
    queryDiscard = false;
    const btn = $('btn_run_sql');
    btn.textContent = '⏹ 取消查询';
    btn.style.background = '#e74c3c';

    eel.execute_sql_query(sql, data)(function (result) {
        if (queryDiscard) { return; }

        isQueryRunning = false;
        btn.textContent = '▶ 执行源库查询';
        btn.style.background = '';

        if (!result) {
            $('query_info').textContent = '查询结果: 出错';
            $('table_scroll').innerHTML = '<div style="padding:20px;color:#ff4444;">❌ 无响应</div>';
            return;
        }
        if (result.cancelled) { appendLog('⏸ 查询已取消'); return; }
        if (!result.ok) {
            $('query_info').textContent = '查询结果: 出错';
            $('table_scroll').innerHTML = '<div style="padding:20px;color:#ff4444;">❌ ' + (result.msg || '未知错误') + '</div>';
            return;
        }
        buildResultTable(result.columns, result.rows, result.total || 0);
    });
}

function buildResultTable(columns, rows, total) {
    const MAX_CHARS = 40;
    total = total || 0;
    $('query_info').textContent = '查询结果: ' + total + ' 行';
    const wrapper = $('table_scroll');
    if (!columns || !columns.length) {
        wrapper.innerHTML = '<div style="padding:20px;">（无返回结果集）</div>';
        return;
    }

    let html = '<table id="result_table"><thead><tr>';
    for (let i = 0; i < columns.length; i++) {
        html += '<th>' + escapeHtml(String(columns[i])) + '</th>';
    }
    html += '</tr></thead><tbody>';

    const maxShow = Math.min(rows.length, 500);
    for (let i = 0; i < maxShow; i++) {
        const row = rows[i];
        html += '<tr>';
        for (let j = 0; j < row.length; j++) {
            let val = row[j];
            let fullText = (val === null || val === undefined) ? 'NULL' : String(val);
            let firstLine = fullText.split('\n')[0] || '';
            let isMultiline = fullText.indexOf('\n') !== -1;
            let displayText, isTruncated;

            if (firstLine.length > MAX_CHARS) {
                displayText = firstLine.substring(0, MAX_CHARS - 3) + '...';
                isTruncated = true;
            } else if (isMultiline) {
                displayText = firstLine + '...';
                isTruncated = true;
            } else {
                displayText = firstLine;
                isTruncated = (fullText.length > MAX_CHARS);
            }

            if (isTruncated) {
                var colEnc = escapeAttr(String(columns[j]));
                var txtEnc = escapeAttr(fullText);
                html += '<td class="truncated" title="💡 双击查看完整内容" data-col="' + colEnc + '" data-full="' + txtEnc + '">' + escapeHtml(displayText) + '</td>';
            } else {
                html += '<td>' + escapeHtml(displayText) + '</td>';
            }
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    if (rows.length > maxShow) {
        html += '<div style="padding:5px;color:#777;font-size:10px;">... 共 ' + rows.length + ' 行，显示前 ' + maxShow + ' 行</div>';
    }
    wrapper.innerHTML = html;

    var tbl = wrapper.querySelector('#result_table');
    if (tbl) {
        tbl.addEventListener('dblclick', function (e) {
            var td = e.target.closest('td.truncated');
            if (!td) return;
            var colName = td.getAttribute('data-col') || '';
            var fullText = td.getAttribute('data-full') || '';
            showCellFull(colName, fullText);
        });
    }

    ensureTooltip();
}

// ==================== Tooltip ====================
let tooltipEl = null;

function ensureTooltip() {
    if (tooltipEl) return;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'cell-tooltip';
    tooltipEl.textContent = '💡 双击查看完整内容';
    document.body.appendChild(tooltipEl);

    document.addEventListener('mousemove', function (e) {
        var td = e.target.closest('td.truncated');
        if (!td) {
            tooltipEl.style.display = 'none';
            return;
        }
        tooltipEl.style.display = 'block';
        tooltipEl.style.left = (e.clientX + 12) + 'px';
        tooltipEl.style.top = (e.clientY + 16) + 'px';
    });
}

function showCellFull(colName, fullText) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:2000;display:flex;justify-content:center;align-items:center;';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement('div');
    box.className = 'cell-full-box';
    box.innerHTML =
        '<div style="font-size:14px;font-weight:bold;margin-bottom:8px;color:#e0e0e0;">📄 字段 [' + escapeHtml(colName || '') + '] 完整内容 (' + ((fullText || '').length) + ' 字符)</div>' +
        '<textarea readonly style="flex:1;min-height:300px;background:#0d1117;border:1px solid #444;border-radius:6px;color:#e0e0e0;padding:10px;font-family:Consolas,monospace;font-size:12px;resize:none;">' + escapeHtml(fullText || '') + '</textarea>' +
        '<button style="margin-top:12px;align-self:flex-end;background:#555;color:#fff;border:none;border-radius:6px;padding:8px 24px;font-size:13px;" onclick="this.parentElement.parentElement.remove()">关闭</button>';
    box.style.cssText = 'background:#16213e;border:1px solid #2a3a5c;border-radius:10px;padding:20px;width:700px;max-height:500px;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.5);';

    overlay.appendChild(box);
    document.body.appendChild(overlay);
}

// ========== 导入查询结果（查询同步 Tab，使用 query_ 表单） ==========
function importResults() {
    const tableName = $('import_table').value.trim();
    if (!tableName) { showWarnDialog('提示', '请输入导入的目标表名'); return; }

    const data = collectForm('query_');
    if (!data.dst_host || !data.dst_user || !data.dst_db) {
        showWarnDialog('提示', '请先填写完整的目标库信息'); return;
    }

    $('btn_import').disabled = true;
    $('btn_import').textContent = '⏳ 导入中...';

    eel.import_query_results(tableName, data)(function (result) {
        $('btn_import').disabled = false;
        $('btn_import').textContent = '📥 导入到目标库';
        if (!result) {
            showErrorDialog('导入失败', '无响应');
            return;
        }
        if (result.ok) {
            showOkDialog('导入完成', '查询结果已导入目标库 [' + (result.table || tableName) + ']，共 ' + (result.count || 0) + ' 行');
            appendLog('📥 ' + (result.msg || '导入完成'));
        } else {
            showErrorDialog('导入失败', result.msg || '未知错误');
            appendLog('❌ 导入失败: ' + (result.msg || ''));
        }
    });
}

// ========== 导入 SQL 文件（查询同步 Tab，使用 query_ 表单） ==========
function importSqlFile() {
    $('sql_file_input').click();
}

function handleSqlFile(input) {
    var file = input.files[0];
    if (!file) return;
    var ext = file.name.split('.').pop().toLowerCase();
    var reader = new FileReader();
    reader.onload = function (e) {
        var content = e.target.result;
        if (ext === 'csv') {
            var tableName = file.name.replace(/\.csv$/i, '');
            content = csvToSql(content, tableName);
        }
        var typeLabel = ext === 'csv' ? 'CSV' : 'SQL';
        showConfirmDialog('导入' + typeLabel + '文件',
            '已读取文件 [' + file.name + ']（' + (content.length).toLocaleString() + ' 字符）\n是否立即在目标库中执行？',
            function () { executeSqlFile(content); });
    };
    reader.readAsText(file);
    input.value = '';
}

function csvToSql(csv, tableName) {
    function parseRow(line) {
        var fields = [], buf = '', inQuote = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line[i];
            if (ch === '"') {
                if (inQuote && i + 1 < line.length && line[i + 1] === '"') { buf += '"'; i++; }
                else { inQuote = !inQuote; }
            } else if (ch === ',' && !inQuote) { fields.push(buf.trim()); buf = ''; }
            else { buf += ch; }
        }
        fields.push(buf.trim());
        return fields;
    }
    function cleanVal(v) {
        v = v.replace(/^"|"$/g, '');
        if (v === '' || v.toUpperCase() === 'NULL') return 'NULL';
        if (/^-?\d+(\.\d+)?$/.test(v)) return v;
        return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    }

    var lines = csv.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 1) return '';

    var firstVals = parseRow(lines[0]).map(function (v) { return v.replace(/^"|"$/g, ''); });
    var dataCount = 0;
    for (var k = 0; k < firstVals.length; k++) {
        if (/^-?\d+(\.\d+)?$/.test(firstVals[k]) || /\d{4}-\d{2}-\d{2}/.test(firstVals[k])) dataCount++;
    }
    var hasHeader = dataCount < firstVals.length * 0.3;

    var headers, startRow;
    if (hasHeader) {
        headers = firstVals;
        startRow = 1;
    } else {
        headers = [];
        for (var h = 0; h < firstVals.length; h++) headers.push('col_' + h);
        startRow = 0;
    }

    var hasColNames = hasHeader;
    var statements = [];
    for (var i = startRow; i < lines.length; i++) {
        var rawVals = parseRow(lines[i]);
        if (rawVals.length !== headers.length) continue;
        var vals = rawVals.map(cleanVal);
        if (hasColNames) {
            statements.push('INSERT INTO ' + tableName + ' (' + headers.join(', ') + ') VALUES (' + vals.join(', ') + ');');
        } else {
            statements.push('INSERT INTO ' + tableName + ' VALUES (' + vals.join(', ') + ');');
        }
    }
    return statements.join('\n');
}

let sqlFileRunning = false;

function executeSqlFile(sql) {
    var data = collectForm('query_');
    if (!data.dst_host || !data.dst_user || !data.dst_db) {
        showWarnDialog('提示', '请先填写完整的目标库信息');
        return;
    }
    if (sqlFileRunning) return;
    sqlFileRunning = true;

    showSqlProgress();

    eel.execute_sql_file(sql, data)(function () {
        var lastDone = 0;
        var poll = setInterval(function () {
            eel.poll_queue()(function (msgs) {
                if (!msgs || !msgs.length) return;
                for (var i = 0; i < msgs.length; i++) {
                    var type = msgs[i][0];
                    var d = msgs[i][1];
                    if (type === 'sql_file_start') {
                        updateSqlProgress(0, d.total);
                    } else if (type === 'sql_file_progress') {
                        if (d.done !== lastDone) {
                            updateSqlProgress(d.done, d.total);
                            lastDone = d.done;
                        }
                    } else if (type === 'sql_file_done') {
                        clearInterval(poll);
                        sqlFileRunning = false;
                        hideSqlProgress();
                        if (d.ok) {
                            var errInfo = d.errors ? '\n跳过 ' + d.errors + ' 条' : '';
                            var detail = '';
                            if (d.error_samples && d.error_samples.length) {
                                detail = '\n\n错误详情（前5条）:\n' + d.error_samples.join('\n');
                            }
                            showOkDialog('执行完成', '成功 ' + d.count + ' 条' + errInfo + detail);
                        } else {
                            showErrorDialog('执行失败', d.msg || '未知错误');
                        }
                    }
                }
            });
        }, 300);
    });
}

function showSqlProgress() {
    var overlay = document.createElement('div');
    overlay.id = 'sql_progress_overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2000;display:flex;justify-content:center;align-items:center;';
    overlay.innerHTML =
        '<div style="background:#242424;border:1px solid #3a3a3a;border-radius:10px;padding:28px 36px;text-align:center;min-width:360px;box-shadow:0 8px 32px rgba(0,0,0,.5);">' +
        '<div style="font-size:28px;margin-bottom:6px;">📂</div>' +
        '<div style="font-size:15px;font-weight:bold;color:#e0e0e0;margin-bottom:4px;">正在执行 SQL 文件</div>' +
        '<div style="font-size:12px;color:#999;margin-bottom:14px;">请稍候...</div>' +
        '<div style="height:24px;background:#2a2a3a;border-radius:12px;overflow:hidden;margin-bottom:8px;">' +
        '<div id="sql_progress_fill" style="height:100%;width:0%;background:linear-gradient(90deg,#8e44ad,#3498db);border-radius:12px;transition:width .3s;"></div></div>' +
        '<div id="sql_progress_text" style="font-size:12px;color:#b0b0b0;">0 / ?</div></div>';
    document.body.appendChild(overlay);
}

function updateSqlProgress(done, total) {
    var fill = document.getElementById('sql_progress_fill');
    var text = document.getElementById('sql_progress_text');
    if (fill && total > 0) fill.style.width = Math.round(done / total * 100) + '%';
    if (text) text.textContent = done + ' / ' + total + ' 条 (' + (total > 0 ? Math.round(done / total * 100) : 0) + '%)';
}

function hideSqlProgress() {
    var el = document.getElementById('sql_progress_overlay');
    if (el) el.remove();
}

// ========== 工具函数 ==========
var _escapeHtmlMap = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function(c) { return _escapeHtmlMap[c]; });
}
function escapeAttr(str) {
    if (str == null) return '';
    str = String(str);
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ========== 初始化 ==========
window.addEventListener('load', function () {
    loadAllProfiles();
    appendLog('✅ 工具已就绪');
    // 查询同步 Tab：选中文本时更新按钮
    var sqlTa = $('sql_input');
    var sqlBtn = $('btn_run_sql');
    if (sqlTa && sqlBtn) {
        function updSqlBtn() {
            if (sqlBtn.textContent.indexOf('⏹') === 0) return;
            var s = sqlTa.selectionStart, e = sqlTa.selectionEnd;
            sqlBtn.textContent = (s !== e) ? '▶ 执行选中SQL' : '▶ 执行源库查询';
        }
        sqlTa.addEventListener('mouseup', updSqlBtn);
        sqlTa.addEventListener('keyup', updSqlBtn);
    }
});
