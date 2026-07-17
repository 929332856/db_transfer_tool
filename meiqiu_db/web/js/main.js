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
    var msgEl = $('modal_msg');
    msgEl.textContent = '';
    // ★ 富 HTML 模式：msg 以 '<' 开头表示是 HTML，直接用 innerHTML 渲染（用于导出向导等需要交互控件的弹窗）
    //    否则按纯文本处理（多行用 <br> 拆分，保证文本可完整选中复制）
    var msgStr = String(msg);
    if (/^\s*</.test(msgStr)) {
        msgEl.innerHTML = msgStr;
    } else {
        var lines = msgStr.split('\n');
        lines.forEach(function(line, idx) {
            if (idx > 0) msgEl.appendChild(document.createElement('br'));
            msgEl.appendChild(document.createTextNode(line));
        });
    }
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

// ========== 表单收集 ==========
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
        table_name: $('table_name').value.trim(),
        batch_size: parseInt($('sync_batch_size').value) || 0
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
function showConfirmDialog(title, msg, onConfirm, onCancel) {
    // ★ 确认弹窗支持 HTML（如 <b>加粗</b>），用 innerHTML 渲染
    var msgStr = String(msg);
    if (/^\s*</.test(msgStr)) {
        // HTML 内容：直接用 innerHTML
        showModal('⚠️', title, '<div style="text-align:center;padding:8px 0;">' + msgStr + '</div>', '#e67e22',
            '<button class="btn btn-gray" id="modal_cancel_btn">取消</button>' +
            '<button class="btn btn-red" id="modal_confirm_btn">确定</button>');
    } else {
        // 纯文本：检查是否含 HTML 标签
        if (/<[a-zA-Z][^>]*>/.test(msgStr)) {
            // 含 HTML 标签但以文字开头（如 "将创建备份表 <b>[xxx]</b>？"），强制包一层 div 让 showModal 识别
            showModal('⚠️', title, '<div style="text-align:center;padding:8px 0;">' + msgStr + '</div>', '#e67e22',
                '<button class="btn btn-gray" id="modal_cancel_btn">取消</button>' +
                '<button class="btn btn-red" id="modal_confirm_btn">确定</button>');
        } else {
            showModal('⚠️', title, msgStr, '#e67e22',
                '<button class="btn btn-gray" id="modal_cancel_btn">取消</button>' +
                '<button class="btn btn-red" id="modal_confirm_btn">确定</button>');
        }
    }
    setTimeout(function () {
        var cfm = $('modal_confirm_btn');
        if (cfm) cfm.onclick = function () { hideModal(); onConfirm(); };
        var can = $('modal_cancel_btn');
        if (can && onCancel) {
            can.onclick = function () { hideModal(); onCancel(); };
        } else if (can) {
            can.onclick = function () { hideModal(); };
        }
    }, 10);
}

// ========== 测试连接 ==========
function testConnection(side, prefix) {
    const data = collectForm(prefix);
    const label = side === 'src' ? '源库' : '目标库';
    const statusEl = $(prefix + 'test_' + side + '_status');

    if (side === 'src' && (!data.src_host || !data.src_user || !data.src_db)) {
        if (!data.src_host) setTestStatus(statusEl, '⚠️ 请填写源库 IP/主机', '#f39c12');
        else if (!data.src_user) setTestStatus(statusEl, '⚠️ 请填写源库用户名', '#f39c12');
        else setTestStatus(statusEl, '⚠️ 请填写源库数据库名', '#f39c12');
        return;
    }
    if (side === 'dst' && (!data.dst_host || !data.dst_user)) {
        if (!data.dst_host) setTestStatus(statusEl, '⚠️ 请填写目标库 IP/主机', '#f39c12');
        else setTestStatus(statusEl, '⚠️ 请填写目标库用户名', '#f39c12');
        return;
    }
    setTestStatus(statusEl, '⏳ 测试中...', '#f39c12');

    // ★ 改用异步模式，不阻塞 Eel 主线程，互不影响
    _eelAutoAsync(eel.test_connection(data, side), function (result) {
        if (!result) {
            setTestStatus(statusEl, '❌ 无响应', '#e74c3c');
            return;
        }
        if (result.ok) {
            setTestStatus(statusEl, '✅ ' + result.msg, '#2ecc71');
        } else {
            setTestStatus(statusEl, '❌ ' + result.msg, '#e74c3c');
        }
    }, 20000, function() {
        setTestStatus(statusEl, '⏱ 连接超时（20秒）', '#e74c3c');
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
let _transferAnimId = null;
let _transferTargetPct = 0;
let _transferCurrentPct = 0;

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
    _transferTargetPct = 0;
    _transferCurrentPct = 0;
    progressFill.style.width = '0%';
    progressText.textContent = '就绪';
    logBox.innerHTML = '';
    // ★ 启动进度条平滑动画（每 100ms 追一步）
    _startTransferAnim();
    eel.start_transfer(data)(function () {
        pollingTimer = setInterval(pollProgress, 100);
    });
}

function stopTransfer() {
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
    _stopTransferAnim();
    resetTransferBtns();
    appendLog('⏸ 用户手动停止传输');
    eel.stop_transfer()();
}

function resetTransferBtns() {
    $('btn_start').disabled = false;
    $('btn_stop').disabled = true;
}

// ★ 进度条平滑动画：每帧追目标值，避免一跳到底
function _startTransferAnim() {
    _stopTransferAnim();
    function step() {
        if (_transferCurrentPct < _transferTargetPct) {
            _transferCurrentPct += Math.max(0.3, (_transferTargetPct - _transferCurrentPct) * 0.15);
            if (_transferCurrentPct > _transferTargetPct) _transferCurrentPct = _transferTargetPct;
            progressFill.style.width = Math.min(_transferCurrentPct, 99.5).toFixed(1) + '%';
        }
        _transferAnimId = requestAnimationFrame(step);
    }
    _transferAnimId = requestAnimationFrame(step);
}
function _stopTransferAnim() {
    if (_transferAnimId) { cancelAnimationFrame(_transferAnimId); _transferAnimId = null; }
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
                    appendLog('📊 [' + data.table + '] 已传输 ' + (data.count || 0).toLocaleString() + ' 行');
                    // ★ 每张表完成后，逐步推进目标进度（最多到 90%，留 10% 给 total/done）
                    _transferTargetPct = Math.min(90, _transferTargetPct + 15);
                    break;
                case 'total':
                    _transferTargetPct = 98;
                    break;
                case 'done':
                    _transferTargetPct = 100;
                    clearInterval(pollingTimer);
                    pollingTimer = null;
                    _stopTransferAnim();
                    progressFill.style.width = '100%';
                    resetTransferBtns();
                    appendLog(data);
                    // ★ 如果是错误导致的 done（如"同步已取消"），不弹成功弹窗
                    if (data && (String(data).indexOf('取消') >= 0 || String(data).indexOf('已取消') >= 0)) {
                        // 不弹窗
                    } else {
                        setTimeout(function () { showOkDialog('传输完成', data); }, 100);
                    }
                    break;
                case 'error':
                    clearInterval(pollingTimer);
                    pollingTimer = null;
                    _stopTransferAnim();
                    progressFill.style.width = _transferCurrentPct.toFixed(1) + '%';
                    progressFill.style.background = '#e74c3c';
                    resetTransferBtns();
                    appendLog(data);
                    setTimeout(function () { showErrorDialog('传输失败', data); }, 100);
                    break;
            }
        }
    });
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
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/'/g, "\\'");
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


/** 导出状态管理 */
var _qsExportState = null;   // { step, fmt, tableName, path, rowCount, totalBytes, results, written, pct, done, error, resultInfo }
var _qsExportTimer = null;
var _qsExportLogs = [];

/** 格式化字节 */
function _qsFmtBytes(b) {
    if (!b && b !== 0) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
}

/** CSV 值转义 */
function _csvEscape(val) {
    if (val === null || val === undefined) return 'NULL';
    var s = String(val);
    if (/[,"\n\r]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

/** 构建 CSV 内容 */
function _buildCsvContent(qr) {
    var cols = qr.columns;
    var rows = qr.rows;
    var csv = '\uFEFF';
    csv += cols.map(function (c) { return _csvEscape(String(c)); }).join(',') + '\r\n';
    for (var i = 0; i < rows.length; i++) {
        csv += rows[i].map(function (v) { return _csvEscape(v); }).join(',') + '\r\n';
    }
    return csv;
}

/** 构建 SQL INSERT 内容 */
function _buildSqlContent(qr, tableName) {
    var cols = qr.columns;
    var rows = qr.rows;
    var colList = '`' + cols.join('`, `') + '`';
    var sql = '-- ====================================\n';
    sql += '-- 导出时间: ' + new Date().toISOString() + '\n';
    sql += '-- 目标表:   `' + tableName + '`\n';
    sql += '-- 行数:     ' + rows.length + '\n';
    sql += '-- ====================================\n\n';
    for (var i = 0; i < rows.length; i++) {
        var vals = rows[i].map(function (v) {
            if (v === null || v === undefined) return 'NULL';
            var s = String(v);
            return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
        }).join(', ');
        sql += 'INSERT INTO `' + tableName + '` (' + colList + ') VALUES (' + vals + ');\n';
    }
    return sql;
}

// ========== 第1步：选择格式 ==========
function _showExportStep1() {
    var s = _qsExportState;
    var csvActive = s.fmt === 'csv', sqlActive = s.fmt === 'sql';
    var html =
        '<div style="padding:5px 0;text-align:left;">' +
            '<h4 class="export-step-title" style="margin:0 0 12px;font-size:13px;">📥 第1步：选择导出格式</h4>' +
            '<div class="export-sub" style="font-size:11px;margin-bottom:10px;">查询结果共 <b class="export-num">' + s.rowCount + '</b> 条记录</div>' +
            '<div style="display:flex;gap:14px;margin-bottom:10px;">' +
                '<label class="export-fmt-opt' + (csvActive ? ' active' : '') + '" id="qs_fmt_csv">' +
                    '<input type="radio" name="export_fmt" value="csv" ' + (csvActive ? 'checked' : '') + ' onchange="_qsFmtChange(this)"> 📄 CSV' +
                '</label>' +
                '<label class="export-fmt-opt' + (sqlActive ? ' active' : '') + '" id="qs_fmt_sql">' +
                    '<input type="radio" name="export_fmt" value="sql" ' + (sqlActive ? 'checked' : '') + ' onchange="_qsFmtChange(this)"> 📜 SQL' +
                '</label>' +
            '</div>' +
            '<div id="qs_export_tablename_row" style="display:' + (s.fmt === 'sql' ? 'flex' : 'none') + ';align-items:center;gap:8px;margin-bottom:6px;">' +
                '<span style="font-size:11px;white-space:nowrap;">目标表名:</span>' +
                '<input type="text" id="qs_export_table" value="' + escapeAttr(s.tableName) + '" style="flex:1;height:28px;font-size:12px;" placeholder="输入 SQL INSERT 的目标表名">' +
            '</div>' +
        '</div>';
    showModal('📥', '导出查询结果', html, '#4fc3f7',
        '<button class="btn btn-gray btn-sm" onclick="hideModal()">取消</button>' +
        '<button class="btn btn-blue btn-sm" onclick="_qsExportNext()">下一步 →</button>');
}

function _qsFmtChange(el) {
    _qsExportState.fmt = el.value;
    var row = document.getElementById('qs_export_tablename_row');
    if (row) row.style.display = el.value === 'sql' ? 'flex' : 'none';
    // 更新 class 高亮
    var csvL = document.getElementById('qs_fmt_csv');
    var sqlL = document.getElementById('qs_fmt_sql');
    if (csvL) csvL.className = 'export-fmt-opt' + (el.value === 'csv' ? ' active' : '');
    if (sqlL) sqlL.className = 'export-fmt-opt' + (el.value === 'sql' ? ' active' : '');
}

// ========== 第2步：选择路径 ==========
function _qsExportNext() {
    if (_qsExportState.fmt === 'sql') {
        var tb = document.getElementById('qs_export_table');
        _qsExportState.tableName = (tb && tb.value.trim()) ? tb.value.trim() : 'exported_table';
    }
    _qsExportState.step = 2;
    _showExportStep2();
}

function _showExportStep2() {
    var s = _qsExportState;
    var fmtLabel = s.fmt === 'csv' ? 'CSV' : 'SQL';
    var html =
        '<div style="padding:5px 0;text-align:left;">' +
            '<h4 class="export-step-title" style="margin:0 0 8px;font-size:13px;">📥 第2步：选择保存路径</h4>' +
            '<div class="export-info-bar" style="font-size:11px;margin-bottom:10px;padding:6px 10px;border-radius:4px;">' +
                '格式: <b class="export-num">' + fmtLabel + '</b> | 行数: <b class="export-num">' + s.rowCount + '</b>' +
                (s.fmt === 'sql' ? ' | 表名: <b>' + escapeHtml(s.tableName) + '</b>' : '') +
            '</div>' +
            '<div style="margin-bottom:8px;">' +
                '<button class="btn btn-sm" style="background:#5dade2;" onclick="_qsPickPath()">📁 选择保存路径</button>' +
            '</div>' +
            '<div id="qs_export_path_display" class="export-path-info' + (s.path ? ' ok' : '') + '" style="font-size:11px;word-break:break-all;margin-bottom:6px;min-height:18px;">' +
                (s.path ? '✅ ' + escapeHtml(s.path) : '⚠ 请选择保存路径') +
            '</div>' +
        '</div>';
    showModal('📥', '导出查询结果', html, '#4fc3f7',
        '<button class="btn btn-gray btn-sm" onclick="_qsExportBack()">← 上一步</button>' +
        '<button class="btn btn-green btn-sm" id="qs_export_exec_btn" onclick="_qsExportExec()" ' + (s.path ? '' : 'disabled') + '>▶ 执行</button>');
}

function _qsPickPath() {
    eel.export_pick_file(_qsExportState.fmt)(function(path) {
        if (!path) return;
        _qsExportState.path = path;
        var disp = document.getElementById('qs_export_path_display');
        if (disp) { disp.textContent = '✅ ' + path; disp.className = 'export-path-info ok'; }
        var btn = document.getElementById('qs_export_exec_btn');
        if (btn) btn.disabled = false;
    });
}

function _qsExportBack() {
    _qsExportState.step = 1;
    _showExportStep1();
}

// ========== 第3步：执行导出 + 进度/结果 ==========
function _qsExportExec() {
    var s = _qsExportState;
    if (!s.path) {
        showWarnDialog('提示', '请先选择保存路径');
        return;
    }

    // 构建导出内容
    var content;
    try {
        if (s.fmt === 'csv') {
            content = _buildCsvContent(s.results);
        } else {
            content = _buildSqlContent(s.results, s.tableName);
        }
    } catch (e) {
        _qsExportLogs.push('[ERROR] 构建内容失败: ' + (e.message || e));
        showWarnDialog('导出失败', '构建导出内容时出错: ' + (e.message || e));
        return;
    }
    s.totalBytes = content.length;

    // 第3步弹窗
    _showExportStep3();

    // 启动轮询
    _qsExportTimer = setInterval(function() {
        if (!document.getElementById('modal_overlay').classList.contains('show')) {
            clearInterval(_qsExportTimer); _qsExportTimer = null; return;
        }
        eel.poll_queue()(function(msgs) {
            if (!msgs) return;
            for (var i = 0; i < msgs.length; i++) {
                var m = msgs[i];
                if (m && m[0] === 'query_export_progress') {
                    var d = m[1];
                    _qsExportState.written = d.written;
                    _qsExportState.pct = d.pct;
                    _updateExportProgress();
                } else if (m && m[0] === 'export_done') {
                    clearInterval(_qsExportTimer); _qsExportTimer = null;
                    _qsExportState.done = true;
                    _qsExportState.resultInfo = m[1];
                    _updateExportProgress();
                    document.getElementById('modal_btns').innerHTML =
                        '<button class="btn btn-green btn-sm" onclick="hideModal()">完成</button>';
                    // 记录日志
                    var rowInfo = (m[1] && m[1].rows) ? m[1].rows : _qsExportState.rowCount;
                    appendLog('✅ 导出完成 — ' + (_qsExportState.fmt === 'csv' ? 'CSV' : 'SQL') + ' | ' + rowInfo + ' 行 | ' + _qsFmtBytes(_qsExportState.totalBytes) + ' → ' + _qsExportState.path);
                } else if (m && m[0] === 'export_error') {
                    clearInterval(_qsExportTimer); _qsExportTimer = null;
                    _qsExportState.error = m[1];
                    _updateExportProgress();
                    document.getElementById('modal_btns').innerHTML =
                        '<button class="btn btn-gray btn-sm" onclick="hideModal()">关闭</button>';
                    appendLog('❌ 导出失败: ' + ((m[1] && m[1].msg) ? m[1].msg : '未知错误'));
                }
            }
        });
    }, 200);

    // 发起后台写入
    eel.export_query_save(s.path, content, s.rowCount)(function(r) {
        if (r && !r.ok) {
            clearInterval(_qsExportTimer); _qsExportTimer = null;
            _qsExportState.error = { msg: r.msg || '未知错误' };
            _updateExportProgress();
            document.getElementById('modal_btns').innerHTML =
                '<button class="btn btn-gray btn-sm" onclick="hideModal()">关闭</button>';
            appendLog('❌ 导出失败: ' + (r.msg || '未知错误'));
        }
    });
}

function _showExportStep3() {
    var s = _qsExportState;
    var html =
        '<div style="padding:5px 0;">' +
            '<h4 class="export-step-title" style="margin:0 0 6px;font-size:13px;">📥 正在导出...</h4>' +
            '<div class="export-sub" style="font-size:11px;margin-bottom:4px;word-break:break-all;">' + escapeHtml(s.path) + '</div>' +
            '<div class="export-sub" style="font-size:11px;margin-bottom:8px;">格式: ' + (s.fmt === 'csv' ? 'CSV' : 'SQL') + ' | 共 <b class="export-num">' + s.rowCount + '</b> 行</div>' +
            '<div class="progress-bar" style="height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden;margin-bottom:6px;">' +
                '<div id="qsexport_progress_bar" class="progress-fill" style="width:0%;height:100%;background:#27ae60;border-radius:4px;transition:width .3s;"></div>' +
            '</div>' +
            '<div id="qsexport_progress_info" class="export-sub" style="font-size:11px;text-align:center;">准备写入文件...</div>' +
            '<div id="qsexport_result_detail" style="margin-top:8px;font-size:11px;display:none;"></div>' +
        '</div>';
    showModal('📥', '导出查询结果', html, '#4fc3f7',
        '<button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;" onclick="_qsCancelExport()">⏹ 中断</button>' +
        '<button class="btn btn-gray btn-sm" onclick="hideModal()">关闭</button>');
}

function _updateExportProgress() {
    var s = _qsExportState;
    var bar = document.getElementById('qsexport_progress_bar');
    var info = document.getElementById('qsexport_progress_info');
    var detail = document.getElementById('qsexport_result_detail');

    if (s.error) {
        if (bar) { bar.style.width = (s.pct || 0) + '%'; bar.style.background = '#e74c3c'; }
        if (info) { info.textContent = '❌ 导出失败'; info.style.color = '#e74c3c'; }
        if (detail) {
            detail.style.display = 'block';
            detail.innerHTML = '<div class="export-result-box error">' +
                '<div style="font-weight:bold;margin-bottom:4px;">错误信息:</div>' +
                '<div>' + escapeHtml(s.error.msg || '未知错误') + '</div></div>';
        }
    } else if (s.done) {
        if (bar) { bar.style.width = '100%'; bar.style.background = '#2ecc71'; }
        var rowCount = (s.resultInfo && s.resultInfo.rows) ? s.resultInfo.rows : s.rowCount;
        if (info) {
            info.textContent = '✅ 导出成功 — ' + _qsFmtBytes(s.totalBytes) + ' | ' + rowCount + ' 行';
            info.style.color = '#2ecc71';
        }
        if (detail) {
            detail.style.display = 'block';
            detail.innerHTML = '<div class="export-result-box success">' +
                '<div class="export-result-title">✅ 导出成功</div>' +
                '<div class="export-result-item">文件: ' + escapeHtml(s.path) + '</div>' +
                '<div class="export-result-item">大小: ' + _qsFmtBytes(s.totalBytes) + ' | 行数: ' + rowCount + ' | 格式: ' + (s.fmt === 'csv' ? 'CSV' : 'SQL') + '</div></div>';
        }
    } else if (s.pct !== undefined) {
        if (bar) bar.style.width = s.pct + '%';
        if (info) info.textContent = '已写入 ' + _qsFmtBytes(s.written || 0) + ' / ' + _qsFmtBytes(s.totalBytes) + ' (' + s.pct + '%)';
    }
}

function _qsCancelExport() {
    if (_qsExportTimer) { clearInterval(_qsExportTimer); _qsExportTimer = null; }
    hideModal();
    appendLog('⏹ 导出已中断');
}

/** 快速导出到文件（tree_query.js 使用）：弹出保存对话框 + 进度条 */
function _qsExportToFile(content, fmt) {
    eel.export_pick_file(fmt)(function(path) {
        if (!path) return;
        var title = fmt === 'csv' ? '📥 导出 CSV' : '📥 导出 SQL';
        var html =
            '<div style="padding:10px 0;">' +
                '<h4 class="export-step-title" style="margin:0 0 8px;">' + title + '</h4>' +
                '<div class="export-sub" style="font-size:11px;margin-bottom:8px;word-break:break-all;">' + escapeHtml(path) + '</div>' +
                '<div class="progress-bar" style="height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden;margin-bottom:6px;">' +
                    '<div id="qsexport_progress_bar" class="progress-fill" style="width:0%;height:100%;background:#27ae60;border-radius:4px;transition:width .3s;"></div>' +
                '</div>' +
                '<div id="qsexport_progress_info" class="export-sub" style="font-size:11px;text-align:center;">准备写入...</div>' +
            '</div>';
        showModal('📥', title, html, '#4fc3f7',
            '<button class="btn btn-sm" style="background:#e74c3c;color:#fff;font-size:10px;" onclick="_qsCancelExport()">⏹ 中断</button>' +
            '<button class="btn btn-gray btn-sm" onclick="hideModal()">关闭</button>');

        var totalBytes = content.length;
        _qsExportTimer = setInterval(function() {
            if (!document.getElementById('modal_overlay').classList.contains('show')) {
                clearInterval(_qsExportTimer); _qsExportTimer = null; return;
            }
            eel.poll_queue()(function(msgs) {
                if (!msgs) return;
                for (var i = 0; i < msgs.length; i++) {
                    var m = msgs[i];
                    if (m && m[0] === 'query_export_progress') {
                        var d = m[1];
                        var bar = document.getElementById('qsexport_progress_bar');
                        if (bar) bar.style.width = d.pct + '%';
                        var info = document.getElementById('qsexport_progress_info');
                        if (info) info.textContent = '已写入 ' + _qsFmtBytes(d.written) + ' / ' + _qsFmtBytes(d.total) + ' (' + d.pct + '%)';
                    } else if (m && m[0] === 'export_done') {
                        clearInterval(_qsExportTimer); _qsExportTimer = null;
                        var bar = document.getElementById('qsexport_progress_bar');
                        if (bar) bar.style.width = '100%';
                        var info = document.getElementById('qsexport_progress_info');
                        if (info) { info.textContent = '✅ 导出完成 — ' + _qsFmtBytes(m[1].written || totalBytes); info.style.color = '#2ecc71'; }
                        document.getElementById('modal_btns').innerHTML =
                            '<button class="btn btn-green btn-sm" onclick="hideModal()">完成</button>';
                    } else if (m && m[0] === 'export_error') {
                        clearInterval(_qsExportTimer); _qsExportTimer = null;
                        var errMsg = m[1] && m[1].msg ? m[1].msg : '未知错误';
                        var bar2 = document.getElementById('qsexport_progress_bar');
                        if (bar2) bar2.style.background = '#e74c3c';
                        var info2 = document.getElementById('qsexport_progress_info');
                        if (info2) { info2.textContent = '❌ 导出失败: ' + errMsg; info2.style.color = '#e74c3c'; }
                        document.getElementById('modal_btns').innerHTML =
                            '<button class="btn btn-gray btn-sm" onclick="hideModal()">关闭</button>';
                    }
                }
            });
        }, 200);

        eel.export_query_save(path, content)(function(r) {
            if (r && !r.ok) {
                clearInterval(_qsExportTimer); _qsExportTimer = null;
                showWarnDialog('导出失败', r.msg || '未知错误');
            }
        });
    });
}

// ========== 通用异步 Eel 调用（自动检测 _async 并轮询） ==========
/** 包装 Eel 调用，支持异步非阻塞模式。
 * 当 Python 端返回 {_async:true, _job_id:"xxx"} 时，
 * 自动轮询 poll_query_result 直到结果就绪，完全不影响 Eel 主线程。
 * 
 * @param {function} eelCall  Eel 调用表达式，如 eel.tree_test_conn(c)
 * @param {function} callback 结果回调 function(result)
 * @param {number}   timeoutMs 超时毫秒数，默认 15000
 * @param {function} onTimeout 超时回调，默认用 callback({ok:false, msg:"超时"})
 */
function _eelAutoAsync(eelCall, callback, timeoutMs, onTimeout) {
    timeoutMs = timeoutMs || 15000;
    eelCall(function(resp) {
        if (resp && resp._async && resp._job_id) {
            var startTime = Date.now();
            (function poll() {
                if (Date.now() - startTime > timeoutMs) {
                    if (onTimeout) onTimeout();
                    else callback({"ok": false, "msg": "\u64cd\u4f5c\u8d85\u65f6\uff08" + Math.round(timeoutMs/1000) + "\u79d2\uff09"});
                    return;
                }
                eel.poll_query_result(resp._job_id)(function(result) {
                    if (result && result._pending) {
                        setTimeout(poll, 200);
                    } else {
                        callback(result || {"ok": false, "msg": "\u65e0\u54cd\u5e94"});
                    }
                });
            })();
        } else {
            callback(resp);
        }
    });
}

// ========== 初始化 ==========
window.addEventListener('load', function () {
    loadAllProfiles();
    appendLog('✅ 工具已就绪');
});

// ========== 全局 F2 重命名（对象面板 + 左侧树） ==========
document.addEventListener('keydown', function(e) {
    if (e.key === 'F2') {
        e.preventDefault();
        // 优先检查对象面板是否有选中行
        if (typeof objPanelRenameByF2 === 'function') objPanelRenameByF2();
        // 左侧树表名重命名
        if (typeof treeTableRenameByF2 === 'function') treeTableRenameByF2();
    }
});



// ========== 慢 SQL 查询分析 ==========

// 当前激活的慢SQL连接（来自 treeData 的连接对象）
var _sqConnData = null;    // 连接参数 {host, port, user, pwd, db_type}
var _sqConnName = '';      // 连接名称
var _sqConnected = false;  // 是否已连接
var _sqConnToken = 0;      // ★ 每次连接递增，旧连接的回调自动失效
var _sqSource = 'ps';      // 数据来源：'ps'=performance_schema聚合 / 'log'=slow_log原始日志
var _sqSortKey = null;     // 当前排序列名
var _sqSortDir = 'desc';   // 当前排序方向：'asc' | 'desc'

/** 填充慢SQL面板的连接下拉列表（从 treeData.connections 读取） */
function refreshSqConnSelector() {
    var sel = $('sq_conn_sel');
    if (!sel) return;
    var html = '<option value="">-- 选择已保存的连接 --</option>';
    if (typeof treeData !== 'undefined' && treeData && treeData.connections) {
        var conns = [];
        for (var k in treeData.connections) {
            var c = treeData.connections[k];
            // 只显示关系型数据库（MySQL / OceanBase），排除 Redis 等
            if (c.db_type === 'mysql' || c.db_type === 'ob-mysql') {
                conns.push(c);
            }
        }
        conns.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
        conns.forEach(function(c) {
            var icon = (typeof DB_ICONS !== 'undefined' && DB_ICONS[c.db_type]) ? DB_ICONS[c.db_type] : ({mysql:'🐬','ob-mysql':'🌊','postgresql':'🐘','oracle':'🔴','mssql':'🟢','redis':'📦'}[c.db_type] || '🗄');
            var label = escapeHtml(c.name) + ' (' + escapeHtml(c.host) + ':' + escapeHtml(c.port) + ')';
            html += '<option value="' + c.id + '">' + icon + ' ' + label + '</option>';
        });
    }
    sel.innerHTML = html;

    // 如果之前已选中某个连接，恢复选中
    if (_sqConnData && _sqConnData._cid) {
        sel.value = _sqConnData._cid;
    }
}

/** 根据连接ID获取连接参数（转换为后端需要的格式） */
function sqGetConnDataById(cid) {
    if (!cid || typeof treeData === 'undefined' || !treeData || !treeData.connections) return null;
    var c = treeData.connections[cid];
    if (!c) return null;
    return {
        src_host: c.host || '',
        src_port: c.port || '3306',
        src_user: c.user || '',
        src_pwd:  c.pwd || '',
        db_type: c.db_type || 'mysql',
        _cid: cid,
        _name: c.name || ''
    };
}

/** 连接下拉框切换 */
function onSqConnChange() {
    var cid = $('sq_conn_sel').value;
    if (!cid) {
        _sqConnData = null;
        _sqConnected = false;
        $('sq_conn_status').textContent = '未连接';
        $('sq_conn_status').style.color = '#888';
        $('sq_status_badge').textContent = '--';
        $('sq_status_badge').className = 'sq-status-badge disabled';
        $('sq_tbody').innerHTML = '<tr><td colspan="9" class="sq-empty">请在顶部选择已保存的连接</td></tr>';
        return;
    }
    // 切换连接 → 自动连接
    slowQueryConnect();
}

/** 连接按钮（从下拉选择器读取连接并测试） */
function slowQueryConnect() {
    var cid = $('sq_conn_sel').value;
    if (!cid) {
        $('sq_test_status').style.color = '#f39c12';
        $('sq_test_status').textContent = '请先选择连接';
        return;
    }
    var data = sqGetConnDataById(cid);
    if (!data) return;

    // ★ 连接前校验必填参数
    if (!data.src_host) {
        $('sq_test_status').style.color = '#e74c3c';
        $('sq_test_status').textContent = '❌ 连接参数不完整：缺少主机地址';
        $('sq_conn_status').textContent = '连接失败：缺少主机地址';
        $('sq_conn_status').style.color = '#e74c3c';
        return;
    }
    if (!data.src_user) {
        $('sq_test_status').style.color = '#e74c3c';
        $('sq_test_status').textContent = '❌ 连接参数不完整：缺少用户名';
        $('sq_conn_status').textContent = '连接失败：缺少用户名';
        $('sq_conn_status').style.color = '#e74c3c';
        return;
    }

    _sqConnData = data;
    _sqConnName = data._name || '';
    _sqConnected = false;

    // ★ 每次连接递增 token，旧连接的回调自动失效
    _sqConnToken++;
    var myToken = _sqConnToken;
    var myCid = cid;

    var statusEl = $('sq_test_status');
    statusEl.style.color = '#f39c12';
    statusEl.textContent = '连接中...';
    $('sq_conn_status').textContent = '连接中...';
    $('sq_conn_status').style.color = '#f39c12';

    // ★ 直接用 Eel 原生异步调用（_with_db_timeout 返回 _async 后由看门狗线程兜底）
    eel.tree_test_conn(data)(function(resp) {
        // 如果是异步模式，轮询 job_id
        if (resp && resp._async && resp._job_id) {
            var jobId = resp._job_id;
            var startTime = Date.now();
            function poll() {
                if (myToken !== _sqConnToken || myCid !== $('sq_conn_sel').value) return; // 已切换
                if (Date.now() - startTime > 20000) {
                    _onConnResult(myToken, myCid, statusEl, data, {"ok": false, "msg": "操作超时（20秒）"});
                    return;
                }
                eel.poll_query_result(jobId)(function(result) {
                    if (myToken !== _sqConnToken || myCid !== $('sq_conn_sel').value) return;
                    if (result && result._pending) {
                        setTimeout(poll, 200);
                    } else {
                        _onConnResult(myToken, myCid, statusEl, data, result);
                    }
                });
            }
            poll();
        } else {
            _onConnResult(myToken, myCid, statusEl, data, resp);
        }
    });
}

/** 处理连接测试结果（独立函数，避免闭包嵌套过深） */
function _onConnResult(myToken, myCid, statusEl, data, res) {
    if (myToken !== _sqConnToken) return;
    if (myCid !== $('sq_conn_sel').value) return;
    if (res && res.ok) {
        _sqConnected = true;
        statusEl.style.color = '#2ecc71';
        statusEl.textContent = '✅ ' + res.msg;
        $('sq_conn_status').textContent = '✅ 已连接 (' + _sqConnName + ')';
        $('sq_conn_status').style.color = '#2ecc71';
        $('sq_btn_conn').textContent = '已连接';

        eel.slow_query_check_enabled(data)(function(s) {
            if (myToken !== _sqConnToken) return;
            updateSqStatusBadge(s);
        });
        _sqSortKey = null; _sqSortDir = 'desc';
        document.querySelectorAll('.sq-sort-arrow').forEach(function(el) { el.textContent = ''; });
        slowQueryRefresh();
        if (typeof _dashSubtab !== 'undefined' && _dashSubtab === 'dash') {
            _dashPrev = null; _dashPrevTime = 0;
            for (var k in _dashHistory) _dashHistory[k] = [];
            dashboardRefresh();
            changeDashInterval();
        }
    } else {
        _sqConnected = false;
        statusEl.style.color = '#e74c3c';
        statusEl.textContent = '❌ ' + (res ? res.msg : '连接失败');
        $('sq_conn_status').textContent = '连接失败';
        $('sq_conn_status').style.color = '#e74c3c';
    }
}

/** 测试连接按钮 */
function slowQueryTestConn() {
    var cid = $('sq_conn_sel').value;
    if (!cid) {
        $('sq_test_status').style.color = '#f39c12';
        $('sq_test_status').textContent = '请先选择连接';
        return;
    }
    var data = sqGetConnDataById(cid);
    if (!data) return;

    // ★ 测试前校验必填参数
    if (!data.src_host) {
        $('sq_test_status').style.color = '#e74c3c';
        $('sq_test_status').textContent = '❌ 连接参数不完整：缺少主机地址';
        return;
    }
    if (!data.src_user) {
        $('sq_test_status').style.color = '#e74c3c';
        $('sq_test_status').textContent = '❌ 连接参数不完整：缺少用户名';
        return;
    }

    var statusEl = $('sq_test_status');
    statusEl.style.color = '#f39c12';
    statusEl.textContent = '测试中...';
    // ★ 改用 tree_test_conn（支持多数据库类型 + 异步）
    _eelAutoAsync(eel.tree_test_conn(data), function(res) {
        // ★ 检查 dropdown 是否还是当前连接（防止旧测试覆盖新测试结果）
        if (cid !== $('sq_conn_sel').value) return;
        if (res && res.ok) {
            statusEl.style.color = '#2ecc71';
            statusEl.textContent = '✅ ' + res.msg;
        } else {
            statusEl.style.color = '#e74c3c';
            statusEl.textContent = '❌ ' + (res ? res.msg : '失败');
        }
    }, 20000, function() {
        if (cid !== $('sq_conn_sel').value) return;
        statusEl.style.color = '#e74c3c';
        statusEl.textContent = '⏱ 连接超时（20秒）';
    });
}

/** 从"我的连接"跳转过来（外部调用） */
function slowQueryJumpFromConn(cid) {
    // 切换到慢SQL面板
    showPanel('slowquery');
    // 刷新连接列表并选中
    refreshSqConnSelector();
    $('sq_conn_sel').value = cid;
    // 自动连接
    slowQueryConnect();
}

/** 更新状态徽标 */
function updateSqStatusBadge(status) {
    var badge = $('sq_status_badge');
    if (!status || !status.ok) {
        badge.textContent = '未知';
        badge.className = 'sq-status-badge disabled';
        return;
    }
    badge.className = 'sq-status-badge ' + (status.enabled ? 'enabled' : 'disabled');
    badge.textContent = status.enabled
        ? '✓ 已开启 (' + status.threshold + 's)'
        : '✕ 未开启 (' + status.threshold + 's)';
}

/** 开启/配置慢查询记录 */
function slowQueryEnable() {
    if (!_sqConnData) {
        showErrorDialog('提示', '请先选择并连接');
        return;
    }
    var data = _sqConnData;
    var threshold = parseFloat($('sq_threshold').value) || 2.0;
    showConfirmDialog('开启慢查询',
        '确定要设置慢查询阈值为 ' + threshold + ' 秒吗？\n（需要 SUPER 权限）', function() {
        eel.slow_query_enable(data, threshold)(function(res) {
            if (res && res.ok) {
                showOkDialog('成功', res.msg);
                eel.slow_query_check_enabled(data)(function(s) { updateSqStatusBadge(s); });
                setTimeout(slowQueryRefresh, 1000);
            } else {
                showErrorDialog('操作失败', res ? res.msg : '未知错误');
            }
        });
    });
}

/** 切换数据来源 */
function onSqSourceChange() {
    _sqSource = $('sq_source_sel') ? $('sq_source_sel').value : 'ps';
    // 重置排序状态
    _sqSortKey = null;
    _sqSortDir = 'desc';
    document.querySelectorAll('.sq-sort-arrow').forEach(function(el) { el.textContent = ''; });
    // 切换表头
    var psHead = $('sq_thead_ps');
    var logHead = $('sq_thead_log');
    if (_sqSource === 'log') {
        if (psHead) psHead.style.display = 'none';
        if (logHead) logHead.style.display = '';
    } else {
        if (psHead) psHead.style.display = '';
        if (logHead) logHead.style.display = 'none';
    }
    // 切换来源时自动刷新
    if (_sqConnected) slowQueryRefresh();
}

/** 刷新慢查询列表（全局查询所有数据库） */
function slowQueryRefresh() {
    if (!_sqConnData || !_sqConnected) {
        $('sq_tbody').innerHTML =
            '<tr><td colspan="9" class="sq-empty">请先选择并连接</td></tr>';
        return;
    }
    var data = _sqConnData;
    var isLog = _sqSource === 'log';
    var colspan = isLog ? '9' : '9';

    // 显示加载中
    $('sq_tbody').innerHTML =
        '<tr><td colspan="' + colspan + '" class="sq-empty">⏳ 正在查询全库慢SQL数据...</td></tr>';

    // 根据来源选择不同接口
    if (_sqSource === 'log') {
        // 慢日志模式：从 mysql.slow_log 读取历史原始日志
        eel.slow_query_get_log(data, '', '', 200)(function(res) {
            renderSlowQueryLogTable(res);
        });
    } else {
        // 聚合统计模式：从 performance_schema 读取
        eel.slow_query_get_list(data, '', '', 200)(function(res) {
            renderSlowQueryTable(res);
        });
    }

    // 更新时间
    var now = new Date();
    $('sq_last_update').textContent = now.toLocaleTimeString('zh-CN', {hour12: false});
}

/** 排序：PS聚合统计模式 */
function sqSort(key) {
    if (_sqSortKey === key) {
        _sqSortDir = _sqSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        _sqSortKey = key;
        _sqSortDir = 'desc'; // 默认降序
    }
    // 更新箭头
    document.querySelectorAll('.sq-sort-arrow').forEach(function(el) { el.textContent = ''; });
    var arrow = $('sq_sort_' + key);
    if (arrow) arrow.textContent = _sqSortDir === 'asc' ? ' ▲' : ' ▼';
    // 重新渲染（内存中已有数据）
    if (window._sqRows) renderSlowQueryTable({ok: true, rows: window._sqRows});
}

/** 排序：慢日志模式 */
function sqSortLog(key) {
    if (_sqSortKey === key) {
        _sqSortDir = _sqSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        _sqSortKey = key;
        _sqSortDir = 'desc';
    }
    document.querySelectorAll('.sq-sort-arrow').forEach(function(el) { el.textContent = ''; });
    var arrow = $('sq_sort_' + key);
    if (arrow) arrow.textContent = _sqSortDir === 'asc' ? ' ▲' : ' ▼';
    if (window._sqRows) renderSlowQueryLogTable({ok: true, rows: window._sqRows});
}

/** 渲染慢查询排行表格（全局，不按数据库过滤） */
function renderSlowQueryTable(res) {
    var tbody = $('sq_tbody');
    if (!res || !res.ok) {
        tbody.innerHTML = '<tr><td colspan="9" class="sq-empty">' +
            escapeHtml((res && res.msg) || '查询失败') + '</td></tr>';
        $('sq_total_count').textContent = '0';
        $('sq_db_count').textContent = '0';
        return;
    }

    var rows = (res.rows || []).slice();  // 复制一份用于排序

    // 前端排序
    if (_sqSortKey) {
        rows.sort(function(a, b) {
            var va = parseFloat(a[_sqSortKey]) || 0;
            var vb = parseFloat(b[_sqSortKey]) || 0;
            return _sqSortDir === 'asc' ? va - vb : vb - va;
        });
    }

    $('sq_total_count').textContent = rows.length.toString();

    // 统计涉及几个数据库
    var dbSet = {};
    rows.forEach(function(r) {
        var sn = r.schema_name || r.SCHEMA_NAME || '';
        if (sn) dbSet[sn] = true;
    });
    var dbCount = Object.keys(dbSet).length;
    $('sq_db_count').textContent = dbCount.toString();

    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="sq-empty">🎉 当前服务器暂无慢查询记录</td></tr>';
        return;
    }

    var html = '';
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var idx = i + 1;
        var schema = escapeHtml(r.schema_name || r.SCHEMA_NAME || '');
        var sqlText = escapeHtml(r.digest_text || r.DIGEST_TEXT || '').replace(/\n/g, ' ');
        var count = parseInt(r.count_star || r.COUNT_STAR || 0);
        var totalTime = parseFloat(r.total_time_sec || 0).toFixed(2);
        var avgTime = parseFloat(r.avg_time_sec || 0).toFixed(2);
        var maxTime = parseFloat(r.max_time_sec || 0).toFixed(2);
        var rowsExamined = (r.rows_examined || r.ROWS_EXAMINED || 0);
        var lastSeen = r.last_seen || r.LAST_SEEN || '';

        // 格式化时间显示
        if (typeof lastSeen === 'string' && lastSeen.indexOf('-') > 0) {
            lastSeen = lastSeen.replace(/T/, ' ').substring(5, 19);
        }

        // 根据耗时着色
        var avgCls = parseFloat(avgTime) >= 3 ? 'time-slow' : 'time-val';
        var maxCls = parseFloat(maxTime) >= 5 ? 'time-slow' : 'time-val';

        html += '<tr>' +
            '<td style="text-align:center;color:#666;">' + idx + '</td>' +
            '<td title="' + schema + '" style="color:#5dade2;font-weight:bold;">' + schema + '</td>' +
            '<td class="sql-text" title="双击查看完整SQL" ondblclick="showSqlFullDialog(\'' + escapeAttr(sqlText) + '\',\'' + escapeAttr(schema) + '\')">' + truncateSql(sqlText, 180) + '</td>' +
            '<td class="count-num" style="text-align:center;">' + count + '</td>' +
            '<td class="time-val" style="text-align:right;">' + totalTime + '</td>' +
            '<td class="' + avgCls + '" style="text-align:right;">' + avgTime + '</td>' +
            '<td class="' + maxCls + '" style="text-align:right;">' + maxTime + '</td>' +
            '<td style="text-align:right;" title="' + formatNum(rowsExamined) + '">' + formatShortNum(rowsExamined) + '</td>' +
            '<td style="color:#888;font-size:10px;">' + lastSeen + '</td>' +
            '</tr>';
    }
    tbody.innerHTML = html;

    // 存储原始行数据（未排序）供详情弹窗和排序使用
    // rows 变量此时是 sorted copy，需要从 res.rows 重新获取原始数据
    window._sqRows = res.rows || [];
}

/** 双击展示完整 SQL 语句 */
function showSqlFullDialog(sqlText, dbName) {
    var hdr = dbName ? escapeHtml(dbName) : '慢SQL';
    showModal('📝', '完整SQL — ' + hdr,
        '<pre class="sql-full-view" style="max-height:400px;overflow:auto;padding:12px;border-radius:6px;font-family:Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;text-align:left;margin:0;">' + escapeHtml(sqlText) + '</pre>',
        '#5dade2',
        '<button class="btn btn-gray btn-sm" onclick="hideModal()">关闭</button>' +
        '<button class="btn btn-sm" onclick="_copySqlFull(this)" style="background:#555;color:#fff;font-size:10px;">📋 复制</button>');
    // 存储完整 SQL 到按钮 data 属性
    setTimeout(function() {
        var btns = document.querySelectorAll('#modal_btns .btn');
        btns.forEach(function(b) {
            if (b.textContent.indexOf('复制') >= 0) b.setAttribute('data-sql', sqlText);
        });
    }, 10);
}
function _copySqlFull(btn) {
    var sql = btn.getAttribute('data-sql') || '';
    if (!sql) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(sql).then(function() {
            btn.textContent = '✅ 已复制'; btn.style.background = '#27ae60';
            setTimeout(function() { btn.textContent = '📋 复制'; btn.style.background = '#555'; }, 1500);
        });
    } else {
        // 降级方案
        var ta = document.createElement('textarea');
        ta.value = sql; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        btn.textContent = '✅ 已复制'; btn.style.background = '#27ae60';
        setTimeout(function() { btn.textContent = '📋 复制'; btn.style.background = '#555'; }, 1500);
    }
}

/** 渲染慢查询日志表格（从 mysql.slow_log 读取的原始日志） */
function renderSlowQueryLogTable(res) {
    var tbody = $('sq_tbody');
    if (!res || !res.ok) {
        tbody.innerHTML = '<tr><td colspan="9" class="sq-empty">' +
            escapeHtml((res && res.msg) || '查询失败') + '</td></tr>';
        $('sq_total_count').textContent = '0';
        $('sq_db_count').textContent = '0';
        return;
    }

    var rows = (res.rows || []).slice();

    // 前端排序
    if (_sqSortKey) {
        rows.sort(function(a, b) {
            var va = parseFloat(a[_sqSortKey]) || 0;
            var vb = parseFloat(b[_sqSortKey]) || 0;
            return _sqSortDir === 'asc' ? va - vb : vb - va;
        });
    }

    $('sq_total_count').textContent = rows.length.toString();

    // 统计涉及几个数据库
    var dbSet = {};
    rows.forEach(function(r) {
        var db = r.db || '';
        if (db) dbSet[db] = true;
    });
    var dbCount = Object.keys(dbSet).length;
    $('sq_db_count').textContent = dbCount.toString();

    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="sq-empty">📜 慢日志为空（开启记录后执行慢查询才会有记录）</td></tr>';
        return;
    }

    var html = '';
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var idx = i + 1;
        var db = escapeHtml(r.db || '');
        var sqlText = escapeHtml(r.sql_text || '').replace(/\n/g, ' ');
        var queryTime = parseFloat(r.query_time || 0);
        var queryTimeStr = queryTime.toFixed(2);
        var lockTime = parseFloat(r.lock_time || 0).toFixed(3);
        var rowsExamined = r.rows_examined || 0;
        var rowsSent = r.rows_sent || 0;
        var startTime = r.start_time || '';
        var userHost = escapeHtml(r.user_host || '');

        // 格式化时间
        if (typeof startTime === 'string' && startTime.indexOf('-') > 0) {
            startTime = startTime.replace(/T/, ' ').substring(5, 19);
        }

        var timeCls = queryTime >= 3 ? 'time-slow' : 'time-val';

        html += '<tr>' +
            '<td style="text-align:center;color:#666;">' + idx + '</td>' +
            '<td title="' + db + '" style="color:#5dade2;font-weight:bold;">' + (db || '-') + '</td>' +
            '<td class="sql-text" title="双击查看完整SQL" ondblclick="showSqlFullDialog(\'' + escapeAttr(sqlText) + '\',\'' + escapeAttr(db) + '\')">' + truncateSql(sqlText, 180) + '</td>' +
            '<td style="text-align:right;" title="' + userHost + '">' + userHost.substring(0, 15) + '</td>' +
            '<td class="' + timeCls + '" style="text-align:right;">' + queryTimeStr + '</td>' +
            '<td style="text-align:right;">' + lockTime + '</td>' +
            '<td style="text-align:right;" title="' + formatNum(rowsExamined) + '">' + formatShortNum(rowsExamined) + '</td>' +
            '<td style="text-align:right;">' + formatShortNum(rowsSent) + '</td>' +
            '<td style="color:#888;font-size:10px;">' + startTime + '</td>' +
            '</tr>';
    }
    tbody.innerHTML = html;
    window._sqRows = res.rows || [];
}



function truncateSql(s, maxLen) {
    if (!s) return '';
    return s.length <= maxLen ? s : s.substring(0, maxLen) + '...';
}
function formatNum(n) {
    n = Number(n) || 0;
    return n.toLocaleString();
}
function formatShortNum(n) {
    n = Number(n) || 0;
    if (n < 10000) return n.toLocaleString();
    if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
    return (n / 1e6).toFixed(2) + 'M';
}

/** 查看慢SQL详情 */
function slowQueryShowDetail(idx, schemaName) {
    var rows = window._sqRows || [];
    var row = rows[idx - 1];
    if (!row) return;

    var digestText = row.digest_text || row.DIGEST_TEXT || '';
    if (!_sqConnData) return;

    showModal('🔍', '慢SQL详情 — 第 ' + idx + ' 条', '', '#5dade2',
        '<div id="sq_detail_loading" style="padding:20px;text-align:center;color:#999;">正在加载详情...</div>' +
        '<div id="sq_detail_body" style="display:none;text-align:left;"></div>' +
        '<button class="btn btn-gray" onclick="hideModal()">关闭</button>');

    eel.slow_query_get_detail(_sqConnData, schemaName, digestText)(function(res) {
        var body = $('sq_detail_body');
        var loading = $('sq_detail_loading');
        if (loading) loading.style.display = 'none';

        if (!res || !res.ok) {
            body.style.display = 'block';
            body.innerHTML = '<p style="color:#e74c3c;padding:10px;">' +
                ((res && res.msg) || '获取详情失败') + '</p>';
            return;
        }
        body.style.display = 'block';

        var d = res.detail || {};

        body.innerHTML =
            '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:12px;">' +
            '<tr><td style="color:#888;width:120px;padding:4px;background:#111;">数据库</td>' +
            '<td style="padding:4px;">' + escapeHtml(d.schema_name || '') + '</td></tr>' +
            '<tr><td style="color:#888;padding:4px;background:#111;">出现次数</td>' +
            '<td style="padding:4px;"><strong style="color:#e74c3c;">' + formatNum(d.count_star) + '</strong> 次</td></tr>' +
            '<tr><td style="color:#888;padding:4px;background:#111;">总耗时</td>' +
            '<td style="padding:4px;"><span class="time-slow">' + (d.total_time || '') + 's</span></td></tr>' +
            '<tr><td style="color:#888;padding:4px;background:#111;">平均耗时</td>' +
            '<td style="padding:4px;"><span class="time-val">' + (d.avg_time || '') + 's</span></td></tr>' +
            '<tr><td style="color:#888;padding:4px;background:#111;">最大耗时</td>' +
            '<td style="padding:4px;"><span class="time-slow">' + (d.max_time || '') + 's</span></td></tr>' +
            '<tr><td style="color:#888;padding:4px;background:#111;">最小耗时</td>' +
            '<td style="padding:4px;"><span class="time-val">' + (d.min_time || '') + 's</span></td></tr>' +
            '<tr><td style="color:#888;padding:4px;background:#111;">扫描行数</td>' +
            '<td style="padding:4px;">' + formatNum(d.rows_examined || 0) + '</td></tr>' +
            '<tr><td style="color:#888;padding:4px;background:#111;">返回行数</td>' +
            '<td style="padding:4px;">' + formatNum(d.rows_sent || 0) + '</td></tr>' +
            '<tr><td style="color:#888;padding:4px;background:#111;">临时表(磁盘)</td>' +
            '<td style="padding:4px;">' + (d.sum_created_tmp_disk_tables || 0) + '</td></tr>' +
            '<tr><td style="color:#888;padding:4px;background:#111;">错误次数</td>' +
            '<td style="padding:4px;color:' + ((d.sum_errors||0)>0?'#e74c3c':'#999') + ';">' + (d.sum_errors || 0) + '</td></tr>' +
            '<tr><td style="color:#888;padding:4px;background:#111;">首次执行</td>' +
            '<td style="padding:4px;color:#888;">' + (d.first_seen || '') + '</td></tr>' +
            '<tr><td style="color:#888;padding:4px;background:#111;">最近执行</td>' +
            '<td style="padding:4px;color:#888;">' + (d.last_seen || '') + '</td></tr>' +
            '</table>' +

            '<div style="margin-bottom:8px;"><strong style="color:#f39c12;font-size:12px;">📝 完整 SQL 语句：</strong></div>' +
            '<pre style="background:#0d1117;border:1px solid #333;border-radius:6px;' +
            'padding:10px;overflow:auto;max-height:250px;font-size:11px;' +
            'font-family:Consolas,monospace;color:#e0e0e0;white-space:pre-wrap;' +
            'word-break:break-all;line-height:1.5;">' +
            escapeHtml(digestText) + '</pre>';

        // 最近执行的样本SQL
        var recent = res.recent_sqls || [];
        if (recent.length > 0) {
            body.innerHTML +=
                '<div style="margin-top:14px;margin-bottom:8px;">' +
                '<strong style="color:#5dade2;font-size:12px;">🔄 最近执行样本 (最近 ' + recent.length + ' 次):</strong></div>';
            recent.forEach(function(h, ri) {
                body.innerHTML +=
                    '<details style="background:#111;border:1px solid #333;border-radius:4px;margin-bottom:4px;">' +
                    '<summary style="padding:6px 10px;font-size:11px;cursor:pointer;color:#bbb;">' +
                    '#' + (ri+1) + ' | 耗时: ' + (h.TIMER_END||h.timer_end||'?') +
                    ' | 扫描: ' + formatNum(h.ROWS_EXAMINED||h.rows_examined||0) +
                    ' | 返回: ' + formatNum(h.ROWS_SENT||h.rows_sent||0) +
                    (h.ERRORS || h.errors ? ' | ⚠️ 错误' : '') +
                    '</summary>' +
                    '<pre style="padding:8px 10px;font-size:10px;font-family:Consolas,' +
                    'monospace;color:#ccc;white-space:pre-wrap;word-break:break-all;' +
                    'background:#0d0d0d;border-top:1px solid #333;">' +
                    escapeHtml(h.SQL_TEXT || h.sql_text || '') + '</pre>' +
                    '</details>';
            });
        }
    });
}

/** 加载当前运行进程列表 */
function slowQueryLoadRunning() {
    if (!_sqConnData || !_sqConnected) {
        showErrorDialog('提示', '请先选择并连接');
        return;
    }
    eel.slow_query_get_running(_sqConnData)(function(res) {
        if (!res || !res.ok) {
            showErrorDialog('查询失败', res ? res.msg : '未知错误');
            return;
        }
        var rows = res.rows || [];
        if (rows.length === 0) {
            showOkDialog('运行进程', '当前没有长时间运行的进程 ✅', '✅', '#2ecc71');
            return;
        }
        var html = '<div style="max-height:400px;overflow-y:auto;">' +
            '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
            '<thead><tr style="background:#222;">' +
            '<th style="padding:4px;text-align:left;">ID</th>' +
            '<th style="padding:4px;text-align:left;">用户</th>' +
            '<th style="padding:4px;text-align:left;">数据库</th>' +
            '<th style="padding:4px;text-align:left;">状态</th>' +
            '<th style="padding:4px;text-align:right;">耗时(s)</th>' +
            '<th style="padding:4px;text-align:left;">SQL</th>' +
            '<th style="padding:4px;text-align:center;">操作</th>' +
            '</tr></thead><tbody>';
        rows.forEach(function(r) {
            var timeVal = parseInt(r.time_ || 0);
            html += '<tr style="border-top:1px solid #333;">' +
                '<td style="padding:4px;color:#888;">' + (r.id || '') + '</td>' +
                '<td style="padding:4px;">' + escapeHtml(r.user_ || '') + '</td>' +
                '<td style="padding:4px;">' + escapeHtml(r.db || '') + '</td>' +
                '<td style="padding:4px;color:#f39c12;">' + escapeHtml(r.state || '') + '</td>' +
                '<td style="padding:4px;text-align:right;color:' +
                    (timeVal >= 10 ? '#e74c3c' : '#f39c12') + '">' + timeVal + '</td>' +
                '<td style="padding:4px;max-width:350px;overflow:hidden;text-overflow:ellipsis;' +
                    'font-family:Consolas,monospace;font-size:10px;color:#ccc;"' +
                ' title="' + escapeAttr(r.info || '') + '">' +
                escapeHtml((r.info || '').substring(0, 100)) + '</td>' +
                '<td style="padding:4px;text-align:center;"><span class="sq-btn-kill"' +
                ' onclick="slowQueryKill(' + (r.id || '') + ')">终止</span></td>' +
                '</tr>';
        });
        html += '</tbody></table></div>';
        showModal('🏃 运行进程', '', '', '#5dade2', html +
            '<button class="btn btn-gray" onclick="hideModal()">关闭</button>');
    });
}

/** 终止指定进程 */
function slowQueryKill(pid) {
    if (!_sqConnData) return;
    pid = parseInt(pid);
    if (!pid) return;
    showConfirmDialog('确认终止', '确定要终止进程 [' + pid + '] 吗？', function() {
        eel.slow_query_kill_processlist(_sqConnData, pid)(function(res) {
            if (res && res.ok) {
                hideModal();
                showOkDialog('成功', res.msg);
                // 自动刷新
                setTimeout(slowQueryLoadRunning, 500);
            } else {
                showErrorDialog('终止失败', res ? res.msg : '未知错误');
            }
        });
    });
}


// ==================== 服务器仪表盘 ====================

var _dashSubtab = 'sq';              // 当前子tab: 'sq'=慢SQL / 'dash'=仪表盘
var _dashTimer = null;               // 自动刷新定时器
var _dashPrev = null;                // 上一次累计值（用于计算每秒速率）
var _dashPrevTime = 0;               // 上一次采集时间戳
var _dashHistory = {                 // 历史数据（最多 60 个点，约 5 分钟@5s）
    qps: [], new_conn: [], net_in: [], net_out: [],
    cmd_select: [], cmd_insert: [], cmd_update: [], cmd_delete: []
};
var _dashStatusVars = [];            // 状态变量全量
var _dashStatusFilter = '';          // 搜索过滤词
var DASH_MAX_POINTS = 60;
var DASH_CHART_COLORS = {
    qps: '#5dade2', new_conn: '#2ecc71',
    net_in: '#5dade2', net_out: '#a855f7',
    cmd_select: '#5dade2', cmd_insert: '#2ecc71',
    cmd_update: '#f39c12', cmd_delete: '#e74c3c'
};

/** 切换慢SQL子tab */
function switchSqSubtab(name) {
    _dashSubtab = name;
    var sqTab = $('sq_subtab_sq'), dashTab = $('sq_subtab_dash'), replTab = $('sq_subtab_repl');
    var sqBody = document.querySelector('.slow-table-wrap');
    if (sqTab) sqTab.classList.toggle('active', name === 'sq');
    if (dashTab) dashTab.classList.toggle('active', name === 'dash');
    if (replTab) replTab.classList.toggle('active', name === 'repl');
    var sqOnlyEls = ['sq_btn_enable', 'sq_source_sel', 'sq_threshold_wrap', 'sq_btn_running'];
    sqOnlyEls.forEach(function(id){
        var el = $(id); if (el) el.style.display = (name === 'sq' ? '' : 'none');
    });
    $('sq_btn_refresh').style.display = (name === 'repl' ? 'none' : '');
    // ★ 连接选择器整行：主从监控隐藏（独立连接），sq/dash 显示
    var topBar = document.querySelector('.slow-top-bar');
    if (topBar) topBar.style.display = (name === 'repl' ? 'none' : '');
    if (name === 'dash') {
        sqBody.style.display = 'none';
        var statsBar = document.querySelector('.slow-stats-bar');
        if (statsBar) statsBar.style.display = 'none';
        $('dash_view').style.display = '';
        $('repl_view').style.display = 'none';
        requestAnimationFrame(function() { _redrawDashCharts(); });
        if (_sqConnected) { dashboardRefresh(); changeDashInterval(); }
        else { $('dash_kpi_grid').innerHTML = '<div class="dash-status-empty" style="grid-column:1/5">请先在上方选择并连接数据库</div>'; }
        if (_dashTimer) { clearInterval(_dashTimer); _dashTimer = null; }
    } else if (name === 'repl') {
        sqBody.style.display = 'none';
        var statsBar3 = document.querySelector('.slow-stats-bar');
        if (statsBar3) statsBar3.style.display = 'none';
        $('dash_view').style.display = 'none';
        $('repl_view').style.display = '';
        if (_dashTimer) { clearInterval(_dashTimer); _dashTimer = null; }
        replRenderConnList();
    } else {
        sqBody.style.display = '';
        var statsBar2 = document.querySelector('.slow-stats-bar');
        if (statsBar2) statsBar2.style.display = '';
        $('dash_view').style.display = 'none';
        $('repl_view').style.display = 'none';
        if (_dashTimer) { clearInterval(_dashTimer); _dashTimer = null; }
        if (_replTimer) { clearInterval(_replTimer); _replTimer = null; }
    }
}

/** 仅重绘 4 个图表（不重新拉取数据），用于 tab 切回时恢复 canvas 尺寸 */

// ==================== 主从复制监控 ====================
var _replTimer = null;
var _replConns = [];        // [{id, name, host, port, user, password}]
var _replActiveId = '';     // 当前选中连接 id
var _replActiveConn = null;

function replRenderConnList() {
    var list = $('repl_conn_list'); if (!list) return;
    if (_replConns.length === 0) {
        list.innerHTML = '<div class="repl-empty" style="padding:20px;">暂无连接，请点击"＋ 添加"录入</div>';
        return;
    }
    var h = '';
    _replConns.forEach(function(c){
        var active = c.id === _replActiveId;
        h += '<div class="repl-conn-row'+(active?' active':'')+'" data-id="'+c.id+'" onclick="replSelectConn(\''+c.id+'\')" oncontextmenu="replConnCtx(event,\''+c.id+'\')">' +
            '<span class="repl-conn-icon">🖥</span><span class="repl-conn-name">'+escapeHtml(c.name)+'</span>' +
            '<span class="repl-conn-host">'+escapeHtml(c.host)+':'+c.port+'</span>' +
            '<span class="repl-conn-del" onclick="event.stopPropagation();replDelConn(\''+c.id+'\')" title="删除">✕</span></div>';
    });
    list.innerHTML = h;
}
function replAddConn() {
    var html = '<div style="text-align:left;">' +
        '<div style="margin-bottom:10px;">' +
            '<button class="btn btn-sm" style="background:#5dade2;color:#fff;" onclick="replImportFromTree()">📥 从我的连接导入</button>' +
            '<span style="font-size:10px;color:#888;margin-left:6px;">或手动填写</span>' +
        '</div>' +
        '<div style="margin-bottom:8px;"><label style="font-size:11px;">名称:</label><input id="repl_new_name" style="width:100%;height:28px;" placeholder="如: 生产从库"></div>' +
        '<div style="margin-bottom:8px;"><label style="font-size:11px;">主机:</label><input id="repl_new_host" style="width:100%;height:28px;" placeholder="127.0.0.1"></div>' +
        '<div style="margin-bottom:8px;"><label style="font-size:11px;">端口:</label><input id="repl_new_port" style="width:100%;height:28px;" value="3306"></div>' +
        '<div style="margin-bottom:8px;"><label style="font-size:11px;">用户名:</label><input id="repl_new_user" style="width:100%;height:28px;" value="root"></div>' +
        '<div style="margin-bottom:8px;"><label style="font-size:11px;">密码:</label><input type="password" id="repl_new_pwd" style="width:100%;height:28px;"></div></div>';
    showModal('➕', '添加 MySQL 连接', html, '#5dade2',
        '<button class="btn btn-gray btn-sm" onclick="hideModal()">取消</button><button class="btn btn-green btn-sm" onclick="replSaveConn()">保存</button>');
}
function replImportFromTree() {
    if (typeof treeData === 'undefined' || !treeData || !treeData.connections) { showWarnDialog('提示', '暂无已保存的连接'); return; }
    var conns = [];
    for (var cid in treeData.connections) {
        var c = treeData.connections[cid];
        if (c.db_type === 'mysql' || c.db_type === 'ob-mysql') conns.push({cid:cid, name:c.name||c.host||'', host:c.host||'', port:c.port||'3306', user:c.user||'', pwd:c.pwd||''});
    }
    if (conns.length === 0) { showWarnDialog('提示', '没有 MySQL 类型的连接'); return; }
    var h = '<div style="max-height:300px;overflow-y:auto;">';
    conns.forEach(function(c){
        h += '<div class="repl-import-item" onclick="replImportFromTreeSelect(\''+c.cid+'\')">' +
            '<div><div style="font-size:12px;">🖥 '+escapeHtml(c.name)+'</div><div style="font-size:10px;color:#888;">'+escapeHtml(c.host)+':'+c.port+'</div></div>' +
            '<span style="font-size:10px;color:#5dade2;">选择 →</span></div>';
    });
    h += '</div>';
    hideModal();
    showModal('📥', '从我的连接导入', h, '#5dade2',
        '<button class="btn btn-gray btn-sm" onclick="hideModal();replAddConn()">返回</button>');
    window._replImportList = conns;
}
function replImportFromTreeSelect(cid) {
    var item = (window._replImportList||[]).find(function(c){return c.cid===cid;});
    if (!item) return;
    var exists = _replConns.find(function(c){return c.host===item.host && c.port===item.port;});
    if (exists) { showWarnDialog('提示', '该连接已存在'); return; }
    _replConns.push({id:'repl_'+Date.now(),name:item.name,host:item.host,port:item.port,user:item.user,password:item.pwd});
    replPersistConns(); replRenderConnList(); hideModal();
}
function replSaveConn() {
    var name=($('repl_new_name')||{}).value||'', host=($('repl_new_host')||{}).value||'';
    var port=($('repl_new_port')||{}).value||'3306', user=($('repl_new_user')||{}).value||'';
    var pwd=($('repl_new_pwd')||{}).value||'';
    if (!name||!host) { showWarnDialog('提示','名称和主机不能为空'); return; }
    _replConns.push({id:'repl_'+Date.now(),name:name,host:host,port:port,user:user,password:pwd});
    replPersistConns(); replRenderConnList(); hideModal();
}
function replSelectConn(id) {
    _replActiveId = id; _replActiveConn = _replConns.find(function(c){return c.id===id;})||null;
    replRenderConnList();
    if (_replActiveConn) {
        $('repl_right_empty').style.display='none'; $('repl_right_content').style.display='';
        $('repl_server_info').textContent = _replActiveConn.name + ' (' + _replActiveConn.host + ')';
        replicationRefresh(); changeReplInterval();
    }
}
function replDelConn(id) {
    showConfirmDialog('确认删除','确定删除此连接？',function(){
        _replConns = _replConns.filter(function(c){return c.id!==id;});
        if (_replActiveId===id) { _replActiveId=''; _replActiveConn=null;
            $('repl_right_empty').style.display=''; $('repl_right_content').style.display='none'; }
        replPersistConns(); replRenderConnList();
    });
}
function replConnCtx(e,id) { e.preventDefault(); showCtxMenu(e.clientX,e.clientY,[{label:'🗑 删除',action:function(){replDelConn(id);}}]); }
function replPersistConns() { try{localStorage.setItem('mqdb_repl_conns',JSON.stringify(_replConns));}catch(e){} }
function replLoadConns() { try{var raw=localStorage.getItem('mqdb_repl_conns');if(raw)_replConns=JSON.parse(raw);}catch(e){_replConns=[];} }
replLoadConns();

function replicationRefresh() {
    if (!_replActiveConn) return;
    var c = _replActiveConn;
    eel.replication_get_status({host:c.host,port:parseInt(c.port)||3306,user:c.user,password:c.password,db_type:'mysql'})(function(r){
        _renderReplResult(r);
    });
}

function _renderReplResult(r) {
    if (!r || !r.ok) {
        $('repl_kpi_grid').innerHTML = '<div class="repl-empty" style="grid-column:1/4;color:#e74c3c;">❌ ' + escapeHtml((r&&r.msg)||'查询失败') + '</div>';
        $('repl_detail_body').innerHTML = '';
        return;
    }
    if (!r.is_slave && !r.is_master) {
        $('repl_kpi_grid').innerHTML = '<div class="repl-empty" style="grid-column:1/4">' + escapeHtml(r.msg||'当前实例未配置主从复制') + '</div>';
        $('repl_detail_body').innerHTML = '';
        return;
    }

    var master = r.master || {};
    var hasMaster = r.is_master && Object.keys(master).length > 0;
    var ch = (r.channels && r.channels.length > 0) ? r.channels[0] : {};
    var ioRunning = (ch.Slave_IO_Running || '').toLowerCase() === 'yes';
    var sqlRunning = (ch.Slave_SQL_Running || '').toLowerCase() === 'yes';
    var delaySec = ch.Seconds_Behind_Master;
    var delayStr = (delaySec !== null && delaySec !== undefined) ? (delaySec >= 60 ? Math.floor(delaySec/60)+'m'+delaySec%60+'s' : delaySec+'s') : '--';
    var delayCls = (delaySec !== null && delaySec > 5) ? 'repl-bad' : 'repl-ok';

    // ★ KPI 卡片：主库 + 从库信息
    var cards = [];
    if (hasMaster) {
        cards.push(
            {label:'角色', val:'主库 (Master)', cls:'repl-ok'},
            {label:'Binlog 文件', val: master.File || '--', cls:''},
            {label:'Binlog 位置', val: String(master.Position || '--'), cls:''},
            {label:'Binlog_Do_DB', val: master.Binlog_Do_DB || '--', cls:''},
        );
    }
    if (r.is_slave) {
        var healthy = ioRunning && sqlRunning;
        cards.push(
            {label:'IO 线程', val: ioRunning?'运行中':'已停止', cls: ioRunning?'repl-ok':'repl-bad'},
            {label:'SQL 线程', val: sqlRunning?'运行中':'已停止', cls: sqlRunning?'repl-ok':'repl-bad'},
            {label:'主从延迟', val: delayStr, cls: delayCls},
            {label:'整体状态', val: healthy?'✅ 正常':'❌ 异常', cls: healthy?'repl-ok':'repl-bad'},
        );
    }
    var kpiHtml = '';
    cards.forEach(function(c){
        kpiHtml += '<div class="repl-kpi"><div class="repl-kpi-label">'+c.label+'</div><div class="repl-kpi-value '+(c.cls||'')+'">'+c.val+'</div></div>';
    });
    $('repl_kpi_grid').innerHTML = kpiHtml;

    // ★ 详情表格
    var sections = [];
    if (hasMaster) {
        sections.push({
            title: '📤 主库信息 (SHOW MASTER STATUS)',
            source: master,
            rows: [
                ['File', 'Binlog 文件'], ['Position', 'Binlog 位置'],
                ['Binlog_Do_DB', '同步数据库'], ['Binlog_Ignore_DB', '忽略数据库'],
            ]
        });
    }
    if (r.is_slave) {
        sections.push({
            title: '📥 从库信息 (SHOW SLAVE STATUS)',
            source: ch,
            rows: [
                ['Master_Host', '主库主机'], ['Master_Port', '主库端口'], ['Master_User', '复制用户'],
                ['Master_Log_File', '主库 Binlog 文件'], ['Read_Master_Log_Pos', '读取主库 Binlog 位置'],
                ['Relay_Master_Log_File', '中继主库 Binlog'], ['Exec_Master_Log_Pos', '执行主库 Binlog 位置'],
                ['Relay_Log_File', 'Relay Log 文件'], ['Relay_Log_Pos', 'Relay Log 位置'],
                ['Slave_IO_Running', 'IO 线程状态'], ['Slave_SQL_Running', 'SQL 线程状态'],
                ['Last_IO_Errno', '最后 IO 错误号'], ['Last_IO_Error', '最后 IO 错误'],
                ['Last_SQL_Errno', '最后 SQL 错误号'], ['Last_SQL_Error', '最后 SQL 错误'],
                ['Seconds_Behind_Master', '主从延迟(秒)'],
                ['Slave_SQL_Running_State', 'SQL 线程状态描述'],
            ]
        });
    }
    var detailHtml = '';
    sections.forEach(function(sec){
        detailHtml += '<div class="repl-detail-title">'+sec.title+'</div><table class="repl-table"><tbody>';
        sec.rows.forEach(function(pair){
            var key = pair[0], label = pair[1];
            var val = sec.source[key];
            if (val === null || val === undefined || val === '') val = '--';
            var tdCls = '';
            if (key === 'Seconds_Behind_Master' && parseInt(val) > 5) tdCls = ' class="repl-bad"';
            if (key === 'Last_IO_Error' && String(val) !== '--') tdCls = ' class="repl-bad"';
            if (key === 'Last_SQL_Error' && String(val) !== '--') tdCls = ' class="repl-bad"';
            detailHtml += '<tr><td class="repl-key">'+label+'</td><td'+tdCls+'>'+escapeHtml(String(val))+'</td></tr>';
        });
        detailHtml += '</tbody></table>';
    });
    $('repl_detail_body').innerHTML = detailHtml;
}

function changeReplInterval() {
    if (_replTimer) { clearInterval(_replTimer); _replTimer = null; }
    var sec = parseInt(($('repl_interval')||{}).value) || 0;
    if (sec > 0 && _sqConnected) {
        _replTimer = setInterval(replicationRefresh, sec * 1000);
    }
}
function _redrawDashCharts() {
    if (!_dashHistory) return;
    _drawLineChart('dash_chart_qps', [_dashHistory.qps], ['QPS'], ['#5dade2'], 'num');
    _drawLineChart('dash_chart_conn', [_dashHistory.new_conn], ['新建连接'], ['#2ecc71'], 'num');
    _drawLineChart('dash_chart_net', [_dashHistory.net_in, _dashHistory.net_out], ['入','出'], ['#5dade2','#a855f7'], 'kb');
    _drawLineChart('dash_chart_cmd', [_dashHistory.cmd_select, _dashHistory.cmd_insert, _dashHistory.cmd_update, _dashHistory.cmd_delete],
        ['SELECT','INSERT','UPDATE','DELETE'], ['#5dade2','#2ecc71','#f39c12','#e74c3c'], 'num');
}

/** 仪表盘自动刷新间隔 */
function changeDashInterval() {
    if (_dashTimer) { clearInterval(_dashTimer); _dashTimer = null; }
    var sec = parseInt(($('dash_interval')||{}).value || '0');
    if (sec > 0 && _dashSubtab === 'dash' && _sqConnected) {
        _dashTimer = setInterval(dashboardRefresh, sec * 1000);
    }
}

/** 手动刷新仪表盘 */
function dashboardRefresh() {
    if (!_sqConnData) return;
    if (!_sqConnected) {
        $('dash_kpi_grid').innerHTML = '<div class="dash-status-empty" style="grid-column:1/5">⏳ 请先连接数据库</div>';
        return;
    }
    // ★ 额外校验连接参数完整性（防止已保存的连接密码丢失）
    if (!_sqConnData.src_host || !_sqConnData.src_user) {
        $('dash_kpi_grid').innerHTML = '<div class="dash-status-empty" style="grid-column:1/5;color:#e74c3c">❌ 连接参数不完整，请重新选择连接</div>';
        return;
    }
    _eelAutoAsync(eel.dashboard_get_metrics(_sqConnData), function(r) {
        if (!r || !r.ok) {
            $('dash_kpi_grid').innerHTML = '<div class="dash-status-empty" style="grid-column:1/5;color:#e74c3c">❌ '+(r?r.msg:'无响应')+'</div>';
            return;
        }
        renderDashKpis(r.kpis, r.server);
        updateDashSeries(r.series);
        // 状态变量只在第一次加载或总数变化时更新
        if (r.status_vars && r.status_vars.length !== _dashStatusVars.length) {
            _dashStatusVars = r.status_vars;
            renderDashStatus();
        } else if (r.status_vars && _dashStatusVars.length === 0) {
            _dashStatusVars = r.status_vars;
            renderDashStatus();
        }
    });
}

/** 渲染关键指标卡片 */
function renderDashKpis(kpis, server) {
    // 更新服务器信息
    if (server) {
        var info = (server.version || '') + ' · 运行时长 ' + _fmtUptime(server.uptime_sec || 0);
        $('dash_server_info').textContent = info;
    }
    var html = '';
    (kpis || []).forEach(function(k) {
        var lvl = k.level || '';
        html += '<div class="dash-kpi">' +
            '<div class="dash-kpi-label">' + escapeHtml(k.label) + '</div>' +
            '<div class="dash-kpi-value kpi-' + lvl + '">' + _fmtKpiVal(k.value) +
                '<span class="dash-kpi-unit">' + escapeHtml(k.unit || '') + '</span></div>' +
            (k.sub ? '<div class="dash-kpi-sub">' + escapeHtml(k.sub) + '</div>' : '') +
            '</div>';
    });
    $('dash_kpi_grid').innerHTML = html;
}

function _fmtKpiVal(v) {
    if (typeof v === 'number') {
        if (v >= 1000000) return (v/1000000).toFixed(1) + 'M';
        if (v >= 10000) return String(v.toLocaleString());
        // 浮点数保留 2 位小数
        if (v % 1 !== 0) return String(v.toFixed(2));
        return String(v);
    }
    return String(v != null ? v : '');
}

function _fmtUptime(sec) {
    if (!sec) return '0秒';
    var d = Math.floor(sec/86400), h = Math.floor((sec%86400)/3600), m = Math.floor((sec%3600)/60), s = sec%60;
    if (d > 0) return d + '天' + h + '小时';
    if (h > 0) return h + '小时' + m + '分';
    if (m > 0) return m + '分' + s + '秒';
    return s + '秒';
}

/** 更新时间序列历史 + 重绘图表 */
function updateDashSeries(series) {
    if (!series) return;
    var now = Date.now();
    var dt = _dashPrevTime > 0 ? (now - _dashPrevTime) / 1000 : 0;
    if (_dashPrev && dt > 0) {
        // 计算每秒速率
        function rate(key) {
            var cur = series[key] ? parseFloat(series[key].cum || 0) : 0;
            var prev = _dashPrev[key] ? parseFloat(_dashPrev[key].cum || 0) : 0;
            // 累计值可能因重启/计数器溢出变小，过滤异常
            if (cur < prev) return 0;
            return (cur - prev) / dt;
        }
        // QPS: questions 是累计"已发送查询数"
        _pushPoint('qps', rate('qps'));
        _pushPoint('new_conn', rate('new_conn'));
        // 网络流量用 KB/s（避免大数）
        _pushPoint('net_in', rate('net_in') / 1024);
        _pushPoint('net_out', rate('net_out') / 1024);
        _pushPoint('cmd_select', rate('cmd_select'));
        _pushPoint('cmd_insert', rate('cmd_insert'));
        _pushPoint('cmd_update', rate('cmd_update'));
        _pushPoint('cmd_delete', rate('cmd_delete'));
    }
    _dashPrev = series;
    _dashPrevTime = now;
    // 重绘 4 个图表
    _drawLineChart('dash_chart_qps', [_dashHistory.qps], ['QPS'], ['#5dade2'], 'num');
    _drawLineChart('dash_chart_conn', [_dashHistory.new_conn], ['新建连接'], ['#2ecc71'], 'num');
    _drawLineChart('dash_chart_net', [_dashHistory.net_in, _dashHistory.net_out], ['入','出'], ['#5dade2','#a855f7'], 'kb');
    _drawLineChart('dash_chart_cmd', [_dashHistory.cmd_select, _dashHistory.cmd_insert, _dashHistory.cmd_update, _dashHistory.cmd_delete],
        ['SELECT','INSERT','UPDATE','DELETE'], ['#5dade2','#2ecc71','#f39c12','#e74c3c'], 'num');
}

function _pushPoint(key, val) {
    if (!_dashHistory[key]) _dashHistory[key] = [];
    _dashHistory[key].push(val);
    if (_dashHistory[key].length > DASH_MAX_POINTS) {
        _dashHistory[key].shift();
    }
}

/** 折线图绘制（Canvas，纯手绘） */
function _drawLineChart(canvasId, series, labels, colors, unit) {
    var canvas = $(canvasId);
    if (!canvas) return;
    // 适配设备像素比，避免模糊
    var dpr = window.devicePixelRatio || 1;
    // ★ 防御：如果容器还没布局好（clientWidth=0），不绘制避免拉伸
    if (canvas.parentElement.clientWidth < 50) return;
    var cssW = canvas.parentElement.clientWidth - 28;  // 减去 padding
    var cssH = 200;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = cssW, h = cssH;
    ctx.clearRect(0, 0, w, h);
    // 边距
    var ml = 45, mr = 12, mt = 10, mb = 22;
    var plotW = w - ml - mr, plotH = h - mt - mb;

    // 找全局最大值（多系列取 max），但只取最近窗口（避免极老尖峰压扁 Y 轴）
    // 取每个系列最后 20 个点的最大值（≈最近 100s 范围，5s 间隔）
    var maxV = 0.1, allEmpty = true;
    for (var s = 0; s < series.length; s++) {
        var data = series[s];
        var win = Math.min(data.length, 20);
        for (var i = data.length - win; i < data.length; i++) {
            if (i < 0) continue;
            if (data[i] > 0) allEmpty = false;
            if (data[i] > maxV) maxV = data[i];
        }
    }
    if (allEmpty) maxV = 1;
    // 留 15% 顶部空间
    maxV = maxV * 1.15;
    if (maxV < 1) maxV = 1;

    // 网格 + Y 轴
    ctx.strokeStyle = '#2a2f38';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#888';
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var ySteps = 4;
    for (var i = 0; i <= ySteps; i++) {
        var yv = (maxV * (ySteps - i) / ySteps);
        var py = mt + plotH * i / ySteps;
        ctx.beginPath();
        ctx.moveTo(ml, py);
        ctx.lineTo(w - mr, py);
        ctx.stroke();
        var ytxt = _fmtChartVal(yv, unit);
        ctx.fillText(ytxt, ml - 4, py);
    }
    // X 轴：4 个时间刻度
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var n = series[0] ? series[0].length : 0;
    for (var i = 0; i <= 3; i++) {
        var ratio = i / 3;
        var px = ml + plotW * ratio;
        ctx.beginPath(); ctx.moveTo(px, mt); ctx.lineTo(px, mt + plotH); ctx.stroke();
        var ago = Math.round((1 - ratio) * (n - 1) * 5);  // 假设每点 5s
        ctx.fillText(ago + 's', px, mt + plotH + 4);
    }

    // 绘制每条曲线
    for (var s = 0; s < series.length; s++) {
        var data = series[s];
        if (data.length < 2) continue;
        var color = colors[s];
        // 计算每个数据点的 x,y 坐标（避免在循环里重复算）
        var pts = [];
        for (var i = 0; i < data.length; i++) {
            var x = ml + plotW * (i / (DASH_MAX_POINTS - 1));
            // 钳制 y 在画布范围内（避免 maxV 估算过小导致 y 越界）
            var ratio = data[i] / maxV;
            if (ratio > 1) ratio = 1;
            if (ratio < 0) ratio = 0;
            var y = mt + plotH * (1 - ratio);
            pts.push({x: x, y: y, v: data[i]});
        }
        // 填充区（仅在有非零值时填充，否则只画折线）
        var hasNonZero = false;
        for (var k = 0; k < data.length; k++) { if (data[k] > 0) { hasNonZero = true; break; } }
        if (hasNonZero) {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, mt + plotH);
            for (var i = 0; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.lineTo(pts[pts.length - 1].x, mt + plotH);
            ctx.closePath();
            ctx.fillStyle = color + '22';  // ~13% 透明
            ctx.fill();
        }
        // 折线
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
    }
    // 图例（在画布上方）
    if (labels && labels.length > 1) {
        var lx = ml + 4, ly = mt + 4;
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        for (var s = 0; s < labels.length; s++) {
            ctx.fillStyle = colors[s];
            ctx.beginPath(); ctx.arc(lx + 4, ly + 4, 3, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#ccc';
            ctx.fillText(labels[s], lx + 12, ly + 4);
            lx += ctx.measureText(labels[s]).width + 28;
        }
    }
}

function _fmtChartVal(v, unit) {
    if (unit === 'kb') {
        if (v >= 1024) return (v/1024).toFixed(1) + 'M';
        return v.toFixed(0) + 'K';
    }
    if (v >= 1000000) return (v/1000000).toFixed(1) + 'M';
    if (v >= 1000) return (v/1000).toFixed(1) + 'K';
    return v.toFixed(0);
}

/** 渲染状态变量表格（默认只显示有说明的重要变量，可切换显示全部） */
var _dashStatusShowAll = false;
function renderDashStatus() {
    var total = _dashStatusVars.length;
    var important = _dashStatusVars.filter(function(v){return !!v.desc;});
    $('dash_status_count').textContent = _dashStatusShowAll ? total : important.length;
    if (_dashStatusVars.length === 0) {
        $('dash_status_body').innerHTML = '<div class="dash-status-empty">暂无状态变量数据</div>';
        return;
    }
    var toggleHtml = '<div style="padding:4px 10px;font-size:10px;color:#888;display:flex;justify-content:space-between;align-items:center;">' +
        '当前显示 ' + (_dashStatusShowAll ? '全部 ' + total + ' 项' : '重要 ' + important.length + ' 项 / 共 ' + total + ' 项') +
        '<button class="btn btn-sm" style="font-size:9px;padding:2px 8px;" onclick="toggleDashStatusAll()">' + (_dashStatusShowAll ? '只看重要' : '显示全部') + '</button></div>';
    var html = toggleHtml + '<table class="dash-status-table"><thead><tr><th style="width:35%">变量名</th><th style="width:40%">说明</th><th style="text-align:right">当前值</th></tr></thead><tbody id="dash_status_tbody"></tbody></table>';
    $('dash_status_body').innerHTML = html;
    _renderDashStatusRows();
}
function toggleDashStatusAll() {
    _dashStatusShowAll = !_dashStatusShowAll;
    renderDashStatus();
}

function _renderDashStatusRows() {
    var tbody = $('dash_status_tbody');
    if (!tbody) return;
    var filter = (_dashStatusFilter || '').toLowerCase();
    var rows = '';
    var matched = 0;
    for (var i = 0; i < _dashStatusVars.length; i++) {
        var v = _dashStatusVars[i];
        if (!_dashStatusShowAll && !v.desc) continue; // ★ 只看重要：跳过无说明的
        if (filter && v.name.toLowerCase().indexOf(filter) < 0) continue;
        if (matched >= 500) continue;
        var valStr = v.value;
        if (valStr.length > 80) valStr = valStr.substring(0, 80) + '...';
        rows += '<tr><td>' + escapeHtml(v.name) + '</td><td class="val-desc">' + escapeHtml(v.desc || '') + '</td><td class="val-num">' + escapeHtml(valStr) + '</td></tr>';
        matched++;
    }
    if (matched === 0) {
        rows = '<tr><td colspan="3" class="dash-status-empty">没有匹配的状态变量</td></tr>';
    }
    tbody.innerHTML = rows;
}

function filterDashStatus() {
    _dashStatusFilter = ($('dash_status_search')||{}).value || '';
    _renderDashStatusRows();
}

function toggleDashStatus() {
    var sec = document.querySelector('.dash-status-section');
    if (sec) sec.classList.toggle('collapsed');
}

// 窗口大小变化时重绘图表（保持 canvas 适配）
var _dashResizeTimer = null;
window.addEventListener('resize', function() {
    if (_dashSubtab !== 'dash') return;
    if (_dashResizeTimer) clearTimeout(_dashResizeTimer);
    _dashResizeTimer = setTimeout(function() {
        if (!_dashPrev) return;
        _drawLineChart('dash_chart_qps', [_dashHistory.qps], ['QPS'], ['#5dade2'], 'num');
        _drawLineChart('dash_chart_conn', [_dashHistory.new_conn], ['新建连接'], ['#2ecc71'], 'num');
        _drawLineChart('dash_chart_net', [_dashHistory.net_in, _dashHistory.net_out], ['入','出'], ['#5dade2','#a855f7'], 'kb');
        _drawLineChart('dash_chart_cmd', [_dashHistory.cmd_select, _dashHistory.cmd_insert, _dashHistory.cmd_update, _dashHistory.cmd_delete],
            ['SELECT','INSERT','UPDATE','DELETE'], ['#5dade2','#2ecc71','#f39c12','#e74c3c'], 'num');
    }, 200);
});


// ==================== DataGrip 连接导入 ====================
var _dgXmlContent = null;
var _dgLocalContent = null;
var _dgParsedResult = null;

/** 生成唯一 ID */
function _dgGenId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 8);
}

/** 切换导入下拉菜单 */
function toggleImportDropdown(e) {
    e.stopPropagation();
    var dd = document.getElementById('import_dropdown');
    dd.classList.toggle('show');
}

/** 关闭导入下拉菜单 */
function hideImportDropdown() {
    document.getElementById('import_dropdown').classList.remove('show');
}

/** 点击其他区域关闭下拉 */
document.addEventListener('click', function(e) {
    var wrap = document.querySelector('.top-import-wrap');
    if (wrap && !wrap.contains(e.target)) {
        hideImportDropdown();
    }
});

/** 打开 DataGrip 导入弹窗 */
function showDgImportDialog() {
    _dgXmlContent = null;
    _dgLocalContent = null;
    _dgParsedResult = null;
    _renderDgStep1();
    document.getElementById('dg_import_overlay').classList.add('show');
}

/** 关闭 DataGrip 导入弹窗 */
function hideDgImport() {
    document.getElementById('dg_import_overlay').classList.remove('show');
}

/** 步骤1：上传两个 XML 文件 */
function _renderDgStep1() {
    var html =
        '<div class="dg-step-title">📂 第1步：选择 DataGrip 配置文件</div>' +
        '<div style="font-size:11px;color:#888;margin-bottom:12px;">请分别选择 dataSources.xml 和 dataSources.local.xml（位于 .idea 目录下），支持拖拽或点击上传</div>' +

        // dataSources.xml 上传区
        '<div class="dg-file-upload-area' + (_dgXmlContent ? ' has-file' : '') + '" id="dg_drop_xml"' +
            ' onclick="document.getElementById(\'dg_xml_file\').click()"' +
            ' ondragover="event.preventDefault();this.classList.add(\'drag-over\')"' +
            ' ondragleave="this.classList.remove(\'drag-over\')"' +
            ' ondrop="event.preventDefault();this.classList.remove(\'drag-over\');_dgHandleDrop(event,\'xml\')">' +
            '<div class="dg-file-icon">📄</div>' +
            '<div class="dg-file-label">拖拽或点击上传 <b>dataSources.xml</b></div>' +
            (_dgXmlContent ? '<div class="dg-file-name">✅ 已选择</div>' : '') +
        '</div>' +

        // dataSources.local.xml 上传区
        '<div class="dg-file-upload-area' + (_dgLocalContent ? ' has-file' : '') + '" id="dg_drop_local"' +
            ' onclick="document.getElementById(\'dg_local_file\').click()"' +
            ' ondragover="event.preventDefault();this.classList.add(\'drag-over\')"' +
            ' ondragleave="this.classList.remove(\'drag-over\')"' +
            ' ondrop="event.preventDefault();this.classList.remove(\'drag-over\');_dgHandleDrop(event,\'local\')">' +
            '<div class="dg-file-icon">📄</div>' +
            '<div class="dg-file-label">拖拽或点击上传 <b>dataSources.local.xml</b></div>' +
            (_dgLocalContent ? '<div class="dg-file-name">✅ 已选择</div>' : '') +
        '</div>' +

        '<div style="font-size:11px;color:#888;margin-bottom:8px;">💡 提示：密码无法导入，需后续手动填写</div>';

    document.getElementById('dg_import_content').innerHTML = html;

    var canNext = _dgXmlContent && _dgLocalContent;
    document.getElementById('dg_import_btns').innerHTML =
        '<button class="btn btn-gray btn-sm" onclick="hideDgImport()">取消</button>' +
        '<button class="btn btn-green btn-sm" id="dg_next_btn" onclick="_dgGoParse()" ' + (canNext ? '' : 'disabled') + '>下一步 →</button>';
}

/** 步骤2：解析并预览 */
function _dgGoParse() {
    if (!_dgXmlContent || !_dgLocalContent) {
        showWarnDialog('提示', '请先选择两个文件');
        return;
    }

    // 显示加载
    document.getElementById('dg_import_content').innerHTML =
        '<div style="text-align:center;padding:30px;color:#888;">' +
            '<div style="font-size:28px;margin-bottom:10px;">⏳</div>' +
            '<div>正在解析 DataGrip 配置...</div>' +
        '</div>';

    eel.datagrip_parse_import(_dgXmlContent, _dgLocalContent)(function(r) {
        if (!r || !r.ok) {
            document.getElementById('dg_import_content').innerHTML =
                '<div style="text-align:center;padding:20px;color:#e74c3c;">' +
                    '<div style="font-size:28px;margin-bottom:10px;">❌</div>' +
                    '<div>解析失败：' + escapeHtml((r && r.msg) || '未知错误') + '</div>' +
                '</div>';
            document.getElementById('dg_import_btns').innerHTML =
                '<button class="btn btn-gray btn-sm" onclick="hideDgImport()">关闭</button>' +
                '<button class="btn btn-sm" onclick="_renderDgStep1()">← 返回</button>';
            return;
        }

        _dgParsedResult = r;
        _renderDgStep2(r);
    });
}

/** 渲染步骤2：预览解析结果 */
function _renderDgStep2(r) {
    var conns = r.connections || [];
    var groups = r.groups || [];
    var count = r.count || 0;

    // 构建预览表格
    var rowsHtml = '';
    var maxPreview = 20;
    var previewConns = conns.slice(0, maxPreview);

    previewConns.forEach(function(c) {
        var groupTag = c.group ? '<span class="dg-group-tag">📁 ' + escapeHtml(c.group) + '</span>' : '<span style="color:#666;">—</span>';
        var typeTag = '<span class="dg-type-tag">' + escapeHtml(c.db_type || 'mysql') + '</span>';
        rowsHtml += '<tr>' +
            '<td>' + escapeHtml(c.name) + '</td>' +
            '<td>' + groupTag + '</td>' +
            '<td>' + typeTag + '</td>' +
            '<td>' + escapeHtml(c.host + ':' + c.port) + '</td>' +
            '<td>' + escapeHtml(c.user || '(空)') + '</td>' +
            '</tr>';
    });

    if (conns.length > maxPreview) {
        rowsHtml += '<tr><td colspan="5" style="text-align:center;color:#888;padding:8px;">... 还有 ' + (conns.length - maxPreview) + ' 个连接未显示</td></tr>';
    }

    var html =
        '<div class="dg-step-title">📋 第2步：确认导入的连接</div>' +
        '<div class="dg-info-row">' +
            '<span>📊 解析到 <span class="dg-info-num">' + count + '</span> 个连接</span>' +
            '<span>📁 <span class="dg-info-num">' + groups.length + '</span> 个分组</span>' +
            '<span>🔗 将替换「我的连接」中所有现有连接</span>' +
        '</div>' +
        '<div style="max-height:340px;overflow-y:auto;border:1px solid #333;border-radius:4px;">' +
            '<table class="dg-preview-table">' +
                '<thead><tr>' +
                    '<th>连接名</th><th>分组</th><th>类型</th><th>主机:端口</th><th>用户名</th>' +
                '</tr></thead>' +
                '<tbody>' + rowsHtml + '</tbody>' +
            '</table>' +
        '</div>' +
        '<div style="font-size:11px;color:#e67e22;margin-top:10px;padding:8px;background:#2a2010;border-radius:4px;">' +
            '⚠️ 注意：导入将<b>清空</b>现有连接和文件夹，并替换为上述 ' + count + ' 个连接。密码需后续手动补充。' +
        '</div>';

    document.getElementById('dg_import_content').innerHTML = html;
    document.getElementById('dg_import_btns').innerHTML =
        '<button class="btn btn-gray btn-sm" onclick="_renderDgStep1()">← 返回</button>' +
        '<button class="btn btn-green btn-sm" onclick="_dgConfirmImport()">✅ 确认导入</button>';
}

/** 确认导入：替换 treeData 并保存 */
function _dgConfirmImport() {
    if (!_dgParsedResult || !_dgParsedResult.ok) return;

    var r = _dgParsedResult;
    var conns = r.connections || [];
    var groups = r.groups || [];

    // 确保 treeData 存在
    if (typeof treeData === 'undefined' || !treeData) {
        showErrorDialog('错误', '树数据未初始化，请刷新页面');
        return;
    }

    // 清空现有数据
    treeData.folders = [];
    treeData.connections = {};

    // 创建文件夹映射 (group name -> folder id)
    var groupFolderIds = {};
    groups.forEach(function(gName) {
        var fid = _dgGenId('f');
        treeData.folders.push({
            id: fid,
            name: gName,
            parent: ''
        });
        groupFolderIds[gName] = fid;
    });

    // 创建连接
    conns.forEach(function(c) {
        var cid = _dgGenId('c');
        var parentId = c.group ? (groupFolderIds[c.group] || '') : '';
        treeData.connections[cid] = {
            id: cid,
            name: c.name,
            host: c.host,
            port: c.port,
            user: c.user,
            pwd: c.pwd || '',
            db_type: c.db_type || 'mysql',
            parent: parentId
        };
    });

    // 保存到文件
    try {
        eel.tree_save(treeData)(function(saveResult) {
            hideDgImport();

            if (saveResult && saveResult.ok) {
                // 刷新「我的连接」列表
                if (typeof renderMyConnectionsList === 'function') {
                    renderMyConnectionsList();
                }
                // 切换到我的连接面板
                showPanel('my_connections');
                showOkDialog('导入成功',
                    '已导入 <b>' + conns.length + '</b> 个连接、<b>' + groups.length + '</b> 个分组。<br>' +
                    '<span style="color:#e67e22;">⚠️ 密码为空，请手动补充</span>');
            } else {
                showErrorDialog('保存失败', (saveResult && saveResult.msg) || '无法保存树数据');
            }
        });
    } catch (err) {
        hideDgImport();
        showErrorDialog('错误', '保存时发生异常：' + (err.message || err));
    }
}

/** 文件选择回调：dataSources.xml */
function onDgXmlFileSelected(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
        _dgXmlContent = ev.target.result;
        _renderDgStep1();
    };
    reader.readAsText(file, 'UTF-8');
    e.target.value = ''; // 允许重复选择同一文件
}

/** 拖拽文件处理 */
function _dgHandleDrop(e, slot) {
    var files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    var file = files[0];
    var reader = new FileReader();
    reader.onload = function(ev) {
        if (slot === 'xml') {
            _dgXmlContent = ev.target.result;
        } else {
            _dgLocalContent = ev.target.result;
        }
        _renderDgStep1();
    };
    reader.readAsText(file, 'UTF-8');
}

/** 文件选择回调：dataSources.local.xml */
function onDgLocalFileSelected(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
        _dgLocalContent = ev.target.result;
        _renderDgStep1();
    };
    reader.readAsText(file, 'UTF-8');
    e.target.value = '';
}

// ========== 选项 / 设置弹窗 ==========
var _settingsData = { theme: 'dark' };

/** 打开设置弹窗 */
function openSettings() {
    // 先从后端获取当前设置
    if (typeof eel !== 'undefined' && eel.settings_get) {
        eel.settings_get()(function(data) {
            if (data) _settingsData = data;
            _renderSettings();
            $('settings_overlay').classList.add('show');
        });
    } else {
        _renderSettings();
        $('settings_overlay').classList.add('show');
    }
}

/** 关闭设置弹窗 */
function closeSettings() {
    $('settings_overlay').classList.remove('show');
}

/** 切换左侧设置菜单 */
function switchSettingsTab(tab, el) {
    document.querySelectorAll('.settings-nav-item').forEach(function(item) {
        item.classList.remove('active');
    });
    if (el) el.classList.add('active');
    _renderSettingsContent(tab);
}

/** 渲染设置弹窗 */
function _renderSettings() {
    _renderSettingsContent('general');
    // 高亮常规
    document.querySelectorAll('.settings-nav-item').forEach(function(item) {
        item.classList.remove('active');
    });
    var first = document.querySelector('.settings-nav-item');
    if (first) first.classList.add('active');
}

/** 渲染右侧设置内容 */
function _renderSettingsContent(tab) {
    var html = '';
    if (tab === 'general') {
        html = _renderGeneralTab();
    } else if (tab === 'shortcuts') {
        html = _renderShortcutsTab();
    } else if (tab === 'files') {
        html = _renderFilesTab();
    }
    $('settings_content').innerHTML = html;

    if (tab === 'files') _loadFilePaths();
}

/** 常规设置页 */
function _renderGeneralTab() {
    var isDark = _settingsData.theme === 'dark';
    var html = '<div class="settings-section">';
    html += '<h4>📋 常规</h4>';

    // 主题选择
    html += '<label class="settings-label">发布主题</label>';
    html += '<div class="theme-options">';
    html += '<div class="theme-option' + (isDark ? ' selected' : '') + '" onclick="_selectTheme(\'dark\')">';
    html += '<div class="theme-preview theme-preview-dark"></div>';
    html += '<div class="theme-name">🌙 深色</div>';
    html += '</div>';
    html += '<div class="theme-option' + (!isDark ? ' selected' : '') + '" onclick="_selectTheme(\'light\')">';
    html += '<div class="theme-preview theme-preview-light"></div>';
    html += '<div class="theme-name">☀️ 浅色</div>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    // 底部按钮
    html += '<div class="settings-btn-row">';
    html += '<button class="btn btn-gray btn-sm" onclick="closeSettings()">取消</button>';
    html += '<button class="btn btn-green btn-sm" onclick="_saveSettings()">确定</button>';
    html += '</div>';

    return html;
}

/** 快捷键参考页 */
function _renderShortcutsTab() {
    var groups = [
        {
            title: 'SQL 编辑器',
            items: [
                {key:'Ctrl + Enter',  desc:'执行 SQL 查询'},
                {key:'Ctrl + S',      desc:'保存查询文件'},
                {key:'Ctrl + B',      desc:'格式化/美化 SQL 代码'},
                {key:'Ctrl + D',      desc:'复制当前行（或选中多行）到下一行'},
                {key:'Ctrl + /',      desc:'切换行注释（-- 注释/取消注释）'},
                {key:'Ctrl + Shift + K', desc:'删除当前行（或选中多行）'},
                {key:'Tab',           desc:'缩进选中行（插入 4 个空格）'},
                {key:'Shift + Tab',   desc:'减少缩进（移除最多 4 个前导空格）'},
                {key:'Ctrl + F',      desc:'在编辑器中打开查找栏'},
                {key:'Escape',        desc:'关闭编辑器内查找栏'},
                {key:'Ctrl + Z',      desc:'撤销（支持 Ctrl+D 等操作的撤回）'},
                {key:'Ctrl + Y',      desc:'重做'},
            ]
        },
        {
            title: '查询结果',
            items: [
                {key:'Ctrl + F',      desc:'搜索查询结果内容（焦点在结果区时）'},
                {key:'Escape',        desc:'关闭查询结果搜索栏'},
                {key:'Enter',         desc:'搜索下一个匹配项'},
            ]
        },
        {
            title: '连接树 / 全局',
            items: [
                {key:'F2',            desc:'重命名当前选中的表/连接/文件夹'},
                {key:'双击连接',       desc:'展开/选中数据库连接'},
                {key:'双击数据库',       desc:'展开数据库分类（表/视图/存储过程/函数/查询）'},
                {key:'右键菜单',        desc:'更多操作（编辑/删除/刷新/新建查询等）'},
                {key:'拖拽表名',        desc:'将表拖到查询编辑器生成 SELECT 语句'},
            ]
        },
        {
            title: '数据浏览',
            items: [
                {key:'双击单元格',       desc:'复制单元格内容到剪贴板'},
                {key:'右键单元格',       desc:'查看完整内容（长文本截断时）'},
                {key:'Ctrl + 点击行',    desc:'多选行（切换选中状态）'},
            ]
        },
        {
            title: '慢SQL分析 / 仪表盘',
            items: [
                {key:'5s 自动刷新',     desc:'仪表盘自动刷新间隔（可调 2s/5s/10s/30s）'},
            ]
        },
    ];

    var html = '<div class="settings-section shortcuts-tab" style="max-height:460px;overflow-y:auto;">';
    html += '<h4>⌨️ 快捷键参考</h4>';

    for (var g = 0; g < groups.length; g++) {
        var group = groups[g];
        html += '<div class="shortcut-group">';
        html += '<div class="shortcut-group-title">' + escapeHtml(group.title) + '</div>';
        html += '<table class="shortcut-table">';
        for (var i = 0; i < group.items.length; i++) {
            var item = group.items[i];
            html += '<tr><td class="shortcut-key">' + escapeHtml(item.key) + '</td>' +
                    '<td class="shortcut-desc">' + escapeHtml(item.desc) + '</td></tr>';
        }
        html += '</table></div>';
    }

    html += '</div>';

    // 底部按钮
    html += '<div class="settings-btn-row">';
    html += '<button class="btn btn-gray btn-sm" onclick="closeSettings()">关闭</button>';
    html += '</div>';

    return html;
}

/** 选择主题（即时生效 + 同步 localStorage） */
function _selectTheme(theme) {
    _settingsData.theme = theme;
    _applyTheme();
    $('settings_content').innerHTML = _renderGeneralTab();
}

/** 保存设置 */
function _saveSettings() {
    if (typeof eel !== 'undefined' && eel.settings_save) {
        eel.settings_save(_settingsData)(function(result) {
            if (result && result.ok) {
                closeSettings();
                showOkDialog('设置已保存', '设置已保存。');
            } else {
                showErrorDialog('保存失败', result ? result.msg : '未知错误');
            }
        });
    } else {
        closeSettings();
        showOkDialog('设置已应用', '设置已应用。');
    }
}

/** 应用当前主题（即时切换 + 同步 localStorage 防闪烁） */
function _applyTheme() {
    var htmlEl = document.documentElement;
    if (_settingsData.theme === 'light') {
        htmlEl.classList.add('light-theme');
        localStorage.setItem('mqdb_theme', 'light');
    } else {
        htmlEl.classList.remove('light-theme');
        localStorage.setItem('mqdb_theme', 'dark');
    }
}

/** 文件位置设置页 */
function _renderFilesTab() {
    var html = '<div class="settings-section">';
    html += '<h4>📁 文件位置</h4>';
    html += '<label class="settings-label">以下为 MQDB 配置文件的存储路径：</label>';

    // 文件列表（初始占位）
    var files = [
        { id: 'tree_file', name: 'navicat_tree.json', desc: '连接树数据（文件夹、连接、保存的查询）', loading: true },
        { id: 'profiles_file', name: 'db_profiles.json', desc: '数据库同步的配置方案', loading: true },
        { id: 'log_file', name: 'db_operation.log', desc: '数据库操作日志', loading: true },
        { id: 'settings_file', name: 'settings.json', desc: 'MQDB 用户设置（主题等）', loading: true }
    ];

    files.forEach(function(f) {
        html += '<div class="settings-file-item">';
        html += '<div class="file-info">';
        html += '<div class="file-name">📄 ' + f.name + '</div>';
        html += '<div class="file-desc">' + f.desc + '</div>';
        html += '</div>';
        html += '<div class="file-path" id="fp_' + f.id + '" style="font-size:10px;color:#666;word-break:break-all;max-width:220px;text-align:right;">加载中...</div>';
        html += '</div>';
    });

    html += '</div>';

    // 底部说明
    html += '<div class="settings-footer-note">💡 配置文件位置由 MQDB 安装路径决定，如需迁移请复制上述文件到新目录</div>';
    html += '</div>';
    html += '<div class="settings-btn-row">';
    html += '<button class="btn btn-gray btn-sm" onclick="closeSettings()">关闭</button>';
    html += '</div>';

    return html;
}

/** 加载文件路径 */
function _loadFilePaths() {
    if (typeof eel !== 'undefined' && eel.settings_get_paths) {
        eel.settings_get_paths()(function(paths) {
            if (paths) {
                Object.keys(paths).forEach(function(key) {
                    var el = document.getElementById('fp_' + key);
                    if (el) el.textContent = paths[key] || '(未设置)';
                });
            }
        });
    }
}

// ========== 数据库同步：从已有连接选择下拉框 ==========

/** 刷新同步面板的源库/目标库连接下拉框 */
function refreshSyncConnSelectors() {
    var selSrc = $('sync_src_conn_sel');
    var selDst = $('sync_dst_conn_sel');
    if (!selSrc || !selDst) return;

    // 收集所有连接
    var conns = [];
    if (treeData && treeData.connections) {
        for (var k in treeData.connections) {
            if (treeData.connections.hasOwnProperty(k)) {
                conns.push(treeData.connections[k]);
            }
        }
    }
    // 过滤掉 Redis（不支持数据同步）
    conns = conns.filter(function(c) { return c.db_type !== 'redis'; });
    conns.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });

    // 构建 option 列表
    var defaultOpt = '<option value="">— 从已有连接中选择 —</option>';
    var html = '';
    var dbTypeIcons = { 'mysql': '🐬', 'ob-mysql': '🌊', 'postgresql': '🐘', 'oracle': '🔴', 'mssql': '🟢', 'redis': '📦' };
    conns.forEach(function(c) {
        var icon = dbTypeIcons[c.db_type] || '🗄';
        var label = c.name + ' (' + c.host + ':' + (c.port || '3306') + ')';
        html += '<option value="' + c.id + '">' + icon + ' ' + escapeHtml(label) + '</option>';
    });

    // 保存当前选中值
    var curSrc = selSrc.value;
    var curDst = selDst.value;

    selSrc.innerHTML = defaultOpt + html;
    selDst.innerHTML = defaultOpt + html;

    // 恢复之前选中的值
    if (curSrc) selSrc.value = curSrc;
    if (curDst) selDst.value = curDst;
}

/** 下拉框选择变化 → 回填表单 */
function onSyncConnSelect(side) {
    var sel = $('sync_' + side + '_conn_sel');
    if (!sel) return;
    var cid = sel.value;
    if (!cid) return;  // 选了"— 从已有连接中选择 —"
    if (!treeData || !treeData.connections || !treeData.connections[cid]) return;
    var c = treeData.connections[cid];

    // 默认端口
    var defaults = DB_DEFAULTS[c.db_type] || {port:'3306'};

    $('sync_' + side + '_host').value = c.host || '';
    $('sync_' + side + '_port').value = c.port || defaults.port || '3306';
    $('sync_' + side + '_user').value = c.user || '';
    $('sync_' + side + '_pwd').value  = c.pwd  || '';
    $('sync_' + side + '_db').value   = c.db   || '';

    appendLog('📌 ' + (side === 'src' ? '源库' : '目标库') + '已从连接"' + c.name + '"载入配置');
}
