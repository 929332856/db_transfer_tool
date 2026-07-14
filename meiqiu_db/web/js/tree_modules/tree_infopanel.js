// ==================== 右侧信息面板：连接/数据库详情 + 可拖拽分隔条 ====================

// ★ 连接类型中文名映射
var _DB_TYPE_LABELS = {
    'mysql': 'MySQL',
    'ob-mysql': 'OceanBase (MySQL 兼容)',
    'oracle': 'Oracle',
    'postgresql': 'PostgreSQL',
    'mssql': 'SQL Server',
    'redis': 'Redis'
};

// ★ 连接类型图标（SVG，前端直接绘制，避免依赖后端返回）
var _DB_INFO_ICONS = {
    // 🐬 MySQL: 橙色圆形 + 海豚跃起剪影
    'mysql': '<svg viewBox="0 0 24 24" width="28" height="28"><circle cx="12" cy="12" r="11" fill="#F29111"/><path d="M8 14Q8 7 12 7Q17 5 18 9Q16 11 14 9.5Q12 9 11 11Q9 13 8 16Q7 17 9 16Z" fill="#fff" opacity=".9"/></svg>',
    // 🌊 OB-MySQL: 青色圆形 + 海浪波纹
    'ob-mysql': '<svg viewBox="0 0 24 24" width="28" height="28"><circle cx="12" cy="12" r="11" fill="#00B4D8"/><path d="M6 8Q9 6 12 8Q15 10 18 8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><path d="M6 12Q9 10 12 12Q15 14 18 12" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><path d="M6 16Q9 14 12 16Q15 18 18 16" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>',
    // 🔴 Oracle: 红色圆角矩形 + 白色字母O
    'oracle': '<svg viewBox="0 0 24 24" width="28" height="28"><rect x="2" y="2" width="20" height="20" rx="5" fill="#C74634"/><ellipse cx="12" cy="12" rx="6" ry="7" fill="none" stroke="#fff" stroke-width="2.2"/></svg>',
    // 🐘 PostgreSQL: 蓝色圆形 + 大象头+长鼻
    'postgresql': '<svg viewBox="0 0 24 24" width="28" height="28"><circle cx="12" cy="12" r="11" fill="#336791"/><circle cx="10" cy="9" r="4.5" fill="#fff" opacity=".9"/><path d="M8.5 13.5Q8 16.5 7.5 17.5Q7 18 7.5 18Q8 17.5 8.3 16Q9 14.5 9.5 14" fill="#fff" opacity=".9"/><ellipse cx="14.5" cy="10" rx="3.5" ry="4" fill="#fff" opacity=".7"/></svg>',
    // 🟢 SQL Server: 红色钻石标志
    'mssql': '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M12 2L22 8v8l-10 6L2 16V8z" fill="#CC2927"/><path d="M12 5l6 3.5v5L12 17l-6-3.5v-5z" fill="#fff" opacity=".25"/><path d="M12 8l3 2v3l-3 2-3-2v-3z" fill="#fff" opacity=".4"/></svg>',
    // 📦 Redis: 三层红色立方体堆叠
    'redis': '<svg viewBox="0 0 24 24" width="28" height="28"><rect x="2" y="2" width="20" height="20" rx="3" fill="#DC382D"/><path d="M6 7h12v3.5H6z" fill="#fff" opacity=".95"/><path d="M6 11h12v3.5H6z" fill="#fff" opacity=".85"/><path d="M6 15h12v3.5H6z" fill="#fff" opacity=".75"/><path d="M18 7v11.5" stroke="#a01e15" stroke-width=".8"/><path d="M6 7v11.5" stroke="#a01e15" stroke-width=".8"/></svg>'
};

// ★ 格式化运行时间（秒 → 天/小时）
function _formatUpTime(secs) {
    if (!secs || secs <= 0) return '';
    var days = Math.floor(secs / 86400);
    var hours = Math.floor((secs % 86400) / 3600);
    var mins = Math.floor((secs % 3600) / 60);
    if (days > 0) return days + ' 天 ' + hours + ' 小时';
    if (hours > 0) return hours + ' 小时 ' + mins + ' 分钟';
    return mins + ' 分钟';
}

// ★ 格式化数字（千分位）
function _fmtNum(n) {
    if (n === null || n === undefined || n === '') return '—';
    return Number(n).toLocaleString();
}

// ★ 显示连接详情信息面板
function showConnInfo(cid) {
    var panel = document.getElementById('info_panel');
    if (!panel) return;
    panel.innerHTML = '<div class="info-loading"><div style="font-size:28px;margin-bottom:8px;">⏳</div><div>加载连接信息...</div></div>';

    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) {
        panel.innerHTML = '<div class="info-error">❌ 未找到连接数据</div>';
        return;
    }

    var dbType = conn.db_type || 'mysql';
    var typeIcon = _DB_INFO_ICONS[dbType] || _DB_INFO_ICONS['mysql'];
    var typeLabel = _DB_TYPE_LABELS[dbType] || dbType;

    // ★ 先渲染基本信息（不依赖后端）
    panel.innerHTML =
        '<div class="info-panel">' +
        '<div class="info-panel-header">' +
        '<div class="info-panel-icon">' + typeIcon + '</div>' +
        '<div><div class="info-panel-title">' + escapeHtml(conn.name) + '</div>' +
        '<div class="info-panel-subtitle">' + typeLabel + ' · ' + escapeHtml(conn.host + ':' + conn.port) + '</div></div>' +
        '</div>' +
        '<div class="info-card">' +
        '<div class="info-card-title">📋 基本信息</div>' +
        '<div class="info-row"><span class="info-label">连接名称</span><span class="info-value">' + escapeHtml(conn.name) + '</span></div>' +
        '<div class="info-row"><span class="info-label">数据库类型</span><span class="info-value">' + typeLabel + '</span></div>' +
        '<div class="info-row"><span class="info-label">主机地址</span><span class="info-value info-value-mono">' + escapeHtml(conn.host || '') + '</span></div>' +
        '<div class="info-row"><span class="info-label">端口</span><span class="info-value info-value-mono">' + escapeHtml(String(conn.port || '')) + '</span></div>' +
        '<div class="info-row"><span class="info-label">用户名</span><span class="info-value info-value-mono">' + escapeHtml(conn.user || '') + '</span></div>' +
        (conn.db ? '<div class="info-row"><span class="info-label">默认数据库</span><span class="info-value info-value-mono">' + escapeHtml(conn.db) + '</span></div>' : '') +
        '</div>' +
        '<div id="conn_server_info"><div class="info-loading">⏳ 获取服务器信息...</div></div>' +
        '</div>';

    // ★ 异步获取服务器级信息
    try {
        if (typeof eel !== 'undefined' && typeof eel.get_connection_info === 'function') {
            eel.get_connection_info(conn)(function(r) {
                var infoEl = document.getElementById('conn_server_info');
                if (!infoEl) return;
                if (!r || !r.ok) {
                    infoEl.innerHTML = '<div class="info-error">⚠️ ' + escapeHtml(r ? r.msg : '获取失败') + '</div>';
                    return;
                }
                var info = r.info || {};
                var html = '<div class="info-card"><div class="info-card-title">🖥️ 服务器信息</div>';

                if (dbType === 'redis') {
                    html += '<div class="info-row"><span class="info-label">Redis 版本</span><span class="info-value info-value-mono">' + escapeHtml(info.version || '') + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">操作系统</span><span class="info-value">' + escapeHtml(info.os || '') + ' ' + escapeHtml(info.arch || '') + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">运行时间</span><span class="info-value">' + escapeHtml(info.uptime_days || '') + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">数据库数量</span><span class="info-value">' + _fmtNum(info.db_count) + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">总键数量</span><span class="info-value">' + _fmtNum(info.keys_total) + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">使用内存</span><span class="info-value">' + escapeHtml(info.used_memory || '') + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">最大内存</span><span class="info-value">' + escapeHtml(info.max_memory || '无限制') + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">淘汰策略</span><span class="info-value info-value-mono">' + escapeHtml(info.eviction_policy || '') + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">连接客户端</span><span class="info-value">' + _fmtNum(info.connected_clients) + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">主从角色</span><span class="info-value"><span class="info-badge redis">' + escapeHtml(info.replication_role || '') + '</span></span></div>';
                } else {
                    html += '<div class="info-row"><span class="info-label">服务器版本</span><span class="info-value info-value-mono">' + escapeHtml(info.version || '') + '</span></div>';
                    if (info.charset || info.collation) {
                        html += '<div class="info-row"><span class="info-label">字符集 / 排序</span><span class="info-value info-value-mono">' +
                            escapeHtml(info.charset || '') + (info.collation ? ' / ' + escapeHtml(info.collation) : '') + '</span></div>';
                    }
                    if (info.uptime_secs) {
                        html += '<div class="info-row"><span class="info-label">运行时间</span><span class="info-value">' +
                            escapeHtml(_formatUpTime(info.uptime_secs)) + '</span></div>';
                    }
                }
                html += '</div>';
                infoEl.innerHTML = html;
            });
        } else {
            var infoEl2 = document.getElementById('conn_server_info');
            if (infoEl2) infoEl2.innerHTML = '';
        }
    } catch(e) {
        console.warn('[showConnInfo] eel 调用失败:', e);
    }
}

// ★ 显示数据库详情信息面板
function showDbInfo(cid, db) {
    var panel = document.getElementById('info_panel');
    if (!panel) return;
    panel.innerHTML = '<div class="info-loading"><div style="font-size:28px;margin-bottom:8px;">⏳</div><div>加载数据库信息...</div></div>';

    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) {
        panel.innerHTML = '<div class="info-error">❌ 未找到连接数据</div>';
        return;
    }

    var dbType = conn.db_type || 'mysql';
    var typeIcon = _DB_INFO_ICONS[dbType] || _DB_INFO_ICONS['mysql'];
    var typeLabel = _DB_TYPE_LABELS[dbType] || dbType;

    // ★ 先渲染基本信息
    panel.innerHTML =
        '<div class="info-panel">' +
        '<div class="info-panel-header">' +
        '<div class="info-panel-icon">' + typeIcon + '</div>' +
        '<div><div class="info-panel-title">' + escapeHtml(db || '—') + '</div>' +
        '<div class="info-panel-subtitle">' + typeLabel + ' · ' + escapeHtml(conn.name) + '</div></div>' +
        '</div>' +
        '<div class="info-card">' +
        '<div class="info-card-title">📋 基本信息</div>' +
        '<div class="info-row"><span class="info-label">数据库名</span><span class="info-value info-value-mono">' + escapeHtml(db || '') + '</span></div>' +
        '<div class="info-row"><span class="info-label">所属连接</span><span class="info-value">' + escapeHtml(conn.name) + '</span></div>' +
        '<div class="info-row"><span class="info-label">数据库类型</span><span class="info-value">' + typeLabel + '</span></div>' +
        '</div>' +
        '<div id="db_detail_info"><div class="info-loading">⏳ 获取数据库详情...</div></div>' +
        '</div>';

    // ★ 异步获取数据库详情（后端走 _with_db_timeout 线程池，不阻塞 Eel 主线程）
    try {
        if (typeof eel !== 'undefined' && typeof eel.get_database_info === 'function') {
            _eelAutoAsync(eel.get_database_info(conn, db), function(r) {
                var infoEl = document.getElementById('db_detail_info');
                if (!infoEl) return;
                if (!r || !r.ok) {
                    infoEl.innerHTML = '<div class="info-error">⚠️ ' + escapeHtml(r ? r.msg : '获取失败') + '</div>';
                    return;
                }
                var info = r.info || {};
                var html = '';

                if (dbType === 'redis') {
                    html += '<div class="info-card"><div class="info-card-title">📊 键空间统计</div>';
                    html += '<div class="info-stats">';
                    html += '<div class="info-stat-item"><div class="info-stat-num">' + _fmtNum(info.key_count) + '</div><div class="info-stat-label">键总数</div></div>';
                    html += '<div class="info-stat-item"><div class="info-stat-num">' + _fmtNum(info.expires) + '</div><div class="info-stat-label">有过期时间</div></div>';
                    html += '<div class="info-stat-item"><div class="info-stat-num">' + escapeHtml(String(info.avg_ttl || 0) + 'ms') + '</div><div class="info-stat-label">平均 TTL</div></div>';
                    html += '</div></div>';
                    html += '<div class="info-card"><div class="info-card-title">🔢 详情</div>';
                    html += '<div class="info-row"><span class="info-label">DB 序号</span><span class="info-value info-value-mono">' + escapeHtml(String(info.db_index || '')) + '</span></div>';
                    html += '</div>';
                } else {
                    // 统计卡片
                    html += '<div class="info-card"><div class="info-card-title">📊 对象统计</div>';
                    html += '<div class="info-stats">';
                    html += '<div class="info-stat-item"><div class="info-stat-num">' + _fmtNum(info.tables_count) + '</div><div class="info-stat-label">数据表</div></div>';
                    html += '<div class="info-stat-item"><div class="info-stat-num">' + _fmtNum(info.views_count) + '</div><div class="info-stat-label">视图</div></div>';
                    html += '<div class="info-stat-item"><div class="info-stat-num">' + _fmtNum(info.routines_count) + '</div><div class="info-stat-label">存储过程/函数</div></div>';
                    html += (info.size_str ? '<div class="info-stat-item"><div class="info-stat-num" style="font-size:15px;">' + escapeHtml(info.size_str) + '</div><div class="info-stat-label">数据大小</div></div>' : '');
                    html += '</div></div>';

                    // 详情卡片
                    html += '<div class="info-card"><div class="info-card-title">🔢 详情</div>';
                    if (info.charset) {
                        html += '<div class="info-row"><span class="info-label">字符集</span><span class="info-value info-value-mono">' + escapeHtml(info.charset) + '</span></div>';
                    }
                    if (info.collation) {
                        html += '<div class="info-row"><span class="info-label">排序规则</span><span class="info-value info-value-mono">' + escapeHtml(info.collation) + '</span></div>';
                    }
                    if (info.size_str) {
                        html += '<div class="info-row"><span class="info-label">数据大小</span><span class="info-value">' + escapeHtml(info.size_str) + '</span></div>';
                    }
                    html += '</div>';
                }
                infoEl.innerHTML = html;
            });
        } else {
            var infoEl2 = document.getElementById('db_detail_info');
            if (infoEl2) infoEl2.innerHTML = '';
        }
    } catch(e) {
        console.warn('[showDbInfo] eel 调用失败:', e);
    }
}

// ★ 初始化连接面板可拖拽分隔条（左侧分隔）
var _connSplitterInited = false;
function initConnSplitter() {
    if (_connSplitterInited) return;
    var splitter = document.getElementById('conn_splitter');
    var leftPanel = document.getElementById('split_left_panel');
    if (!splitter || !leftPanel) return;

    _connSplitterInited = true;

    var startX, startW;
    splitter.addEventListener('mousedown', function(e) {
        e.preventDefault();
        splitter.classList.add('active');
        startX = e.clientX;
        startW = leftPanel.offsetWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        function onMove(ev) {
            var dx = ev.clientX - startX;
            var newW = Math.max(180, Math.min(500, startW + dx));
            leftPanel.style.width = newW + 'px';
            leftPanel.style.flexShrink = '0';
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

    // ★ 双击分隔条恢复默认宽度 260px
    splitter.addEventListener('dblclick', function() {
        leftPanel.style.width = '260px';
    });
}

// ★ 初始化右侧信息面板可拖拽分隔条
var _infoSplitterInited = false;
function initInfoSplitter() {
    if (_infoSplitterInited) return;
    var splitter = document.getElementById('info_splitter');
    var infoPanel = document.getElementById('info_panel');
    if (!splitter || !infoPanel) return;

    _infoSplitterInited = true;

    var startX, startW;
    splitter.addEventListener('mousedown', function(e) {
        e.preventDefault();
        splitter.classList.add('active');
        startX = e.clientX;
        startW = infoPanel.offsetWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        function onMove(ev) {
            var dx = startX - ev.clientX; // ★ 向左拖动 = 增大信息面板宽度
            var newW = Math.max(200, Math.min(550, startW + dx));
            infoPanel.style.width = newW + 'px';
            infoPanel.style.flexShrink = '0';
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

    // ★ 双击分隔条恢复默认宽度 300px
    splitter.addEventListener('dblclick', function() {
        infoPanel.style.width = '300px';
    });
}
