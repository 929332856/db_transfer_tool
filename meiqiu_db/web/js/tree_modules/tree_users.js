// ==================== MySQL 用户与权限 ====================
// 连接级功能：用户不属于某一个数据库，因此入口放在连接节点下。

var _mysqlUsersState = {};
var _mysqlUsersLayout = {};
var _MYSQL_USER_PRIVILEGES_UI = [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER',
    'INDEX', 'REFERENCES', 'EXECUTE', 'SHOW VIEW', 'TRIGGER', 'EVENT',
    'CREATE TEMPORARY TABLES'
];

function _usersDomKey(cid) {
    return 'users_' + safeBtoa(String(cid || ''));
}

function _usersLayoutState(cid) {
    if (!_mysqlUsersLayout[cid]) _mysqlUsersLayout[cid] = {left: 340, right: 360};
    return _mysqlUsersLayout[cid];
}

function _usersStartResize(event, cid, side) {
    event.preventDefault();
    event.stopPropagation();
    var root = document.getElementById(_usersDomKey(cid));
    if (!root) return;
    var layout = _usersLayoutState(cid);
    var startX = event.clientX;
    var startLeft = layout.left;
    var startRight = layout.right;
    var minLeft = 220;
    var minRight = 280;
    var minCenter = 320;

    function apply() {
        root.style.setProperty('--users-left-width', layout.left + 'px');
        root.style.setProperty('--users-right-width', layout.right + 'px');
    }
    function move(e) {
        var delta = e.clientX - startX;
        var available = Math.max(0, root.clientWidth - 12 - minCenter);
        if (side === 'left') {
            var maxLeft = Math.max(minLeft, available - startRight);
            layout.left = Math.round(Math.max(minLeft, Math.min(maxLeft, startLeft + delta)));
        } else {
            var maxRight = Math.max(minRight, available - startLeft);
            layout.right = Math.round(Math.max(minRight, Math.min(maxRight, startRight - delta)));
        }
        apply();
    }
    function stop() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', stop);
        document.documentElement.classList.remove('users-resizing');
    }
    document.documentElement.classList.add('users-resizing');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
}

function _usersState(cid) {
    if (!_mysqlUsersState[cid]) {
        _mysqlUsersState[cid] = {
            users: [], databases: [], tables: [], tablesDatabase: '', query: '', selectedIndex: -1,
            databasesLoading: false, tablesLoading: false, databaseError: '', tablesError: '', selectionToken: 0,
            grants: [], permission: {database: '*', table: '*', privileges: [], grantOption: false}
        };
    }
    return _mysqlUsersState[cid];
}

function _usersEscJs(value) {
    return escapeAttr(String(value == null ? '' : value));
}

function clickUsersPrivileges(cid) {
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) { showErrorDialog('打开失败', '未找到连接信息'); return; }
    if (conn.db_type !== 'mysql' && conn.db_type !== 'ob-mysql') {
        showErrorDialog('暂不支持', '用户与权限目前仅支持 MySQL / OceanBase');
        return;
    }
    activeConnId = cid;
    activeConnData = conn;
    activeDatabase = '';
    _redisPanelCtx = null;
    var key = _usersDomKey(cid);
    var sid = _usersEscJs(cid);
    var content = _usersBuildShell(cid, conn);
    addOrUpdateTab('users_' + cid, '用户与权限', 'users', content, '', cid);
    _usersLoad(cid);
}

function _usersBuildShell(cid, conn) {
    var key = _usersDomKey(cid);
    var sid = _usersEscJs(cid);
    var layout = _usersLayoutState(cid);
    return '<div class="mysql-users-layout" id="'+key+'" style="--users-left-width:'+layout.left+'px;--users-right-width:'+layout.right+'px;">' +
        '<div class="mysql-users-toolbar">' +
            '<div class="mysql-users-title">♙ 用户与权限 <span class="users-conn-badge">'+escapeHtml(conn.name || conn.host || '')+'</span></div>' +
            '<button class="btn btn-sm" onclick="_usersLoad(\''+sid+'\')">⟳ 刷新</button>' +
            '<button class="btn btn-sm btn-green" onclick="_usersCreateDialog(\''+sid+'\')">＋ 新建用户</button>' +
        '</div>' +
        '<div class="mysql-users-main">' +
            '<aside class="mysql-users-list-panel">' +
                '<div class="mysql-users-search"><span>⌕</span><input id="'+key+'_search" placeholder="搜索用户或 Host" oninput="_usersSearch(\''+sid+'\',this.value)"></div>' +
                '<div class="mysql-users-list" id="'+key+'_list"><div class="users-empty">⏳ 正在加载用户...</div></div>' +
            '</aside>' +
            '<div class="users-resizer" role="separator" aria-label="调整用户列表宽度" onmousedown="_usersStartResize(event,\''+sid+'\',\'left\')"></div>' +
            '<section class="mysql-users-center">' +
                '<div id="'+key+'_detail" class="mysql-users-detail"><div class="users-empty">选择一个用户查看授权</div></div>' +
            '</section>' +
            '<div class="users-resizer" role="separator" aria-label="调整权限编辑宽度" onmousedown="_usersStartResize(event,\''+sid+'\',\'right\')"></div>' +
            '<aside class="mysql-users-permission" id="'+key+'_permission"><div class="users-empty">选择一个用户编辑权限</div></aside>' +
        '</div>' +
    '</div>';
}

function _usersLoad(cid) {
    // 兼容按钮内传入的转义字符串。
    cid = String(cid || '');
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    var root = document.getElementById(_usersDomKey(cid));
    if (!conn || !root) return;
    var state = _usersState(cid);
    var selected = state.selectedIndex >= 0 ? state.users[state.selectedIndex] : null;
    var list = document.getElementById(_usersDomKey(cid) + '_list');
    if (list) list.innerHTML = '<div class="users-empty">⏳ 正在加载用户...</div>';
    eel.mysql_user_list(conn)(function(r) {
        if (!r || !r.ok) {
            if (list) list.innerHTML = '<div class="users-error">❌ '+escapeHtml(r && r.msg ? r.msg : '加载用户失败')+'</div>';
            return;
        }
        state.users = r.users || [];
        if (selected) {
            state.selectedIndex = state.users.findIndex(function(u) { return u.user === selected.user && u.host === selected.host; });
        }
        if (state.selectedIndex < 0 && state.users.length) state.selectedIndex = 0;
        _usersRenderList(cid);
        if (state.selectedIndex >= 0) _usersSelect(cid, state.selectedIndex);
        else _usersRenderDetail(cid);
    });
    _usersLoadDatabases(cid);
}

function _usersLoadDatabases(cid) {
    var state = _usersState(cid);
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    if (!conn) return;
    state.databasesLoading = true;
    state.databaseError = '';
    if (state.selectedIndex >= 0) _usersRenderPermission(cid);
    eel.mysql_user_databases(conn)(function(r) {
        state.databasesLoading = false;
        if (r && r.ok) {
            state.databases = Array.isArray(r.databases) ? r.databases : [];
        } else {
            state.databases = [];
            state.databaseError = r && r.msg ? String(r.msg) : '数据库列表加载失败';
        }
        if (state.selectedIndex >= 0) _usersRenderPermission(cid);
    });
}

function _usersLoadTables(cid, database) {
    var state = _usersState(cid);
    var conn = treeData && treeData.connections ? treeData.connections[cid] : null;
    database = String(database || '*').trim() || '*';
    if (!conn) return;
    if (database === '*') {
        state.tables = [];
        state.tablesDatabase = '*';
        state.tablesLoading = false;
        state.tablesError = '';
        _usersRenderPermission(cid);
        return;
    }
    if (state.tablesDatabase === database && !state.tablesLoading) {
        _usersRenderPermission(cid);
        return;
    }
    state.tables = [];
    state.tablesDatabase = database;
    state.tablesLoading = true;
    state.tablesError = '';
    var selectionToken = state.selectionToken || 0;
    _usersRenderPermission(cid);
    eel.mysql_user_tables(conn, database)(function(r) {
        if (state.tablesDatabase !== database || selectionToken !== (state.selectionToken || 0)) return;
        state.tablesLoading = false;
        if (r && r.ok) {
            state.tables = Array.isArray(r.tables) ? r.tables : [];
        } else {
            state.tables = [];
            state.tablesError = r && r.msg ? String(r.msg) : '表列表加载失败';
        }
        _usersRenderPermission(cid);
    });
}

function _usersSearch(cid, value) {
    _usersState(cid).query = String(value || '').toLowerCase().trim();
    _usersRenderList(cid);
}

function _usersRenderList(cid) {
    var state = _usersState(cid);
    var el = document.getElementById(_usersDomKey(cid) + '_list');
    if (!el) return;
    var q = state.query || '';
    var html = '';
    state.users.forEach(function(u, i) {
        var text = (u.user + '@' + u.host).toLowerCase();
        if (q && text.indexOf(q) < 0) return;
        var active = i === state.selectedIndex ? ' active' : '';
        var status = u.locked ? '<span class="users-state locked">已锁定</span>' : '';
        html += '<div class="mysql-user-item'+active+'" onclick="_usersSelect(\''+_usersEscJs(cid)+'\','+i+')">' +
            '<span class="users-user-icon">♙</span><span class="users-user-main"><b>'+escapeHtml(u.user)+'@'+escapeHtml(u.host)+'</b>' +
            '<span class="users-plugin">'+escapeHtml(u.plugin || '默认认证插件')+status+'</span></span></div>';
    });
    el.innerHTML = html || '<div class="users-empty">（无匹配用户）</div>';
}

function _usersSelect(cid, index) {
    var state = _usersState(cid);
    index = Number(index);
    if (!state.users[index]) return;
    state.selectedIndex = index;
    state.selectionToken = (state.selectionToken || 0) + 1;
    var selectionToken = state.selectionToken;
    state.grants = [];
    state.permission = {database: '*', table: '*', privileges: [], grantOption: false};
    state.tables = [];
    state.tablesDatabase = '*';
    state.tablesLoading = false;
    state.tablesError = '';
    _usersRenderList(cid);
    _usersRenderDetail(cid, true);
    // 先绘制编辑器，授权接口返回后再刷新权限勾选状态。
    _usersRenderPermission(cid);
    var user = state.users[index];
    var conn = treeData.connections[cid];
    if (!state.databases.length && !state.databasesLoading) _usersLoadDatabases(cid);
    eel.mysql_user_grants(conn, user.user, user.host)(function(r) {
        if (selectionToken !== state.selectionToken) return;
        if (!r || !r.ok) {
            _usersRenderDetail(cid, false, r && r.msg ? r.msg : '读取授权失败');
            _usersRenderPermission(cid);
            return;
        }
        state.grants = r.grants || [];
        state.permission = _usersPermissionFromGrants(cid);
        if (state.permission.database !== '*') _usersLoadTables(cid, state.permission.database);
        _usersRenderDetail(cid, false);
        _usersRenderPermission(cid);
    });
}

function _usersRenderDetail(cid, loading, error) {
    var state = _usersState(cid);
    var el = document.getElementById(_usersDomKey(cid) + '_detail');
    if (!el) return;
    var user = state.users[state.selectedIndex];
    if (!user) { el.innerHTML = '<div class="users-empty">选择一个用户查看授权</div>'; return; }
    var sid = _usersEscJs(cid);
    var lockText = user.locked ? '解锁' : '锁定';
    var html = '<div class="users-detail-toolbar"><div class="users-detail-name"><span class="users-big-icon">♙</span><b>'+escapeHtml(user.user)+'@'+escapeHtml(user.host)+'</b><span class="users-plugin-badge">'+escapeHtml(user.plugin || '默认认证插件')+'</span></div>' +
        '<div class="users-detail-actions"><button class="btn btn-sm" onclick="_usersPasswordDialog(\''+sid+'\')">⌘ 修改密码</button>' +
        '<button class="btn btn-sm" onclick="_usersToggleLock(\''+sid+'\')">'+(user.locked ? '🔓 解锁' : '🔒 锁定')+'</button>' +
        '<button class="btn btn-sm btn-danger" onclick="_usersDelete(\''+sid+'\')">♜ 删除用户</button></div></div>';
    html += '<div class="users-grant-title">♢ 授权</div>';
    if (loading) html += '<div class="users-loading">⏳ 正在读取授权...</div>';
    else if (error) html += '<div class="users-error">❌ '+escapeHtml(error)+'</div>';
    else if (!state.grants.length) html += '<div class="users-empty">（没有读取到授权）</div>';
    else {
        html += '<div class="users-grants-list">';
        state.grants.forEach(function(grant) { html += '<div class="users-grant-line">'+escapeHtml(grant)+'</div>'; });
        html += '</div>';
    }
    el.innerHTML = html;
    if (!loading && !error) _usersRenderPermission(cid);
}

function _usersNormalizeScope(scope) {
    return String(scope || '').replace(/`/g, '').replace(/\s/g, '').toLowerCase();
}

function _usersGrantForScope(cid, database, table) {
    var scope = _usersNormalizeScope((database || '*') + '.' + (table || '*'));
    var state = _usersState(cid);
    var found = {privileges: [], grantOption: false};
    state.grants.forEach(function(grant) {
        var m = String(grant || '').match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i);
        if (!m || _usersNormalizeScope(m[2]) !== scope) return;
        var names = m[1].toUpperCase().split(',').map(function(x){ return x.trim(); });
        if (names.indexOf('ALL PRIVILEGES') >= 0) found.privileges = _MYSQL_USER_PRIVILEGES_UI.slice();
        else names.forEach(function(name){ if (_MYSQL_USER_PRIVILEGES_UI.indexOf(name) >= 0 && found.privileges.indexOf(name) < 0) found.privileges.push(name); });
        found.grantOption = /WITH\s+GRANT\s+OPTION/i.test(grant);
    });
    return found;
}

function _usersPermissionFromGrants(cid) {
    var state = _usersState(cid);
    var candidates = [];
    var seen = {};
    state.grants.forEach(function(grant) {
        var m = String(grant || '').match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i);
        if (!m || /^(PROCEDURE|FUNCTION)\s+/i.test(m[2])) return;
        var rawScope = String(m[2]).trim().replace(/`/g, '');
        var dot = rawScope.indexOf('.');
        if (dot < 0) return;
        var database = rawScope.slice(0, dot).trim() || '*';
        var table = rawScope.slice(dot + 1).trim() || '*';
        var key = _usersNormalizeScope(database + '.' + table);
        if (seen[key]) return;
        var found = _usersGrantForScope(cid, database, table);
        if (!found.privileges.length && !found.grantOption) return;
        seen[key] = true;
        candidates.push({database: database, table: table, privileges: found.privileges, grantOption: found.grantOption});
    });
    candidates.sort(function(a, b) {
        var ag = a.database === '*' && a.table === '*' ? 0 : 1;
        var bg = b.database === '*' && b.table === '*' ? 0 : 1;
        return ag - bg;
    });
    return candidates[0] || {database: '*', table: '*', privileges: [], grantOption: false};
}

function _usersRenderPermission(cid) {
    var state = _usersState(cid);
    var el = document.getElementById(_usersDomKey(cid) + '_permission');
    var user = state.users[state.selectedIndex];
    if (!el || !user) return;
    var p = state.permission || {};
    var sid = _usersEscJs(cid);
    var dbValues = (state.databases || []).slice();
    if (p.database && p.database !== '*' && dbValues.indexOf(p.database) < 0) dbValues.unshift(p.database);
    var dbOptions = '<option value="*">全部数据库 (*)</option>';
    dbValues.forEach(function(db){ dbOptions += '<option value="'+escapeAttr(db)+'">'+escapeHtml(db)+'</option>'; });
    if (state.databasesLoading) dbOptions += '<option disabled>正在加载数据库...</option>';
    if (state.databaseError && !dbValues.length) dbOptions += '<option disabled>'+escapeHtml(state.databaseError)+'</option>';
    var tableValues = (state.tables || []).slice();
    if (p.table && p.table !== '*' && tableValues.indexOf(p.table) < 0) tableValues.unshift(p.table);
    var tableOptions = '<option value="*">全部表 (*)</option>';
    tableValues.forEach(function(table){ tableOptions += '<option value="'+escapeAttr(table)+'">'+escapeHtml(table)+'</option>'; });
    if (state.tablesLoading) tableOptions += '<option disabled>正在加载表...</option>';
    if (state.tablesError && !tableValues.length) tableOptions += '<option disabled>'+escapeHtml(state.tablesError)+'</option>';
    var html = '<div class="users-perm-title">权限编辑</div><div class="users-perm-help">选择权限、数据库和表，保存后只重设当前范围的授权。<br><b>*</b> 表示全部。</div>' +
        '<label>数据库</label><select id="'+_usersDomKey(cid)+'_db" onchange="_usersDatabaseChanged(\''+sid+'\',this.value)">'+dbOptions+'</select>' +
        '<label>表</label><select id="'+_usersDomKey(cid)+'_table" onchange="_usersTableChanged(\''+sid+'\',this.value)">'+tableOptions+'</select>' +
        '<div class="users-perm-label">权限</div><div class="users-priv-grid">';
    _MYSQL_USER_PRIVILEGES_UI.forEach(function(priv) {
        var checked = (p.privileges || []).indexOf(priv) >= 0 ? ' checked' : '';
        html += '<label class="users-priv-item"><input type="checkbox" value="'+escapeAttr(priv)+'"'+checked+' onchange="_usersTogglePrivilege(\''+sid+'\',this)"><span>'+escapeHtml(priv)+'</span></label>';
    });
    html += '</div><label class="users-grant-option"><input type="checkbox" id="'+_usersDomKey(cid)+'_grant"'+(p.grantOption ? ' checked' : '')+'> 允许继续授权（WITH GRANT OPTION）</label>' +
        '<button class="btn btn-sm btn-green users-save-perm" onclick="_usersSavePrivileges(\''+sid+'\')">保存权限</button>';
    el.innerHTML = html;
    var dbEl = document.getElementById(_usersDomKey(cid) + '_db');
    var tableEl = document.getElementById(_usersDomKey(cid) + '_table');
    if (dbEl) dbEl.value = p.database || '*';
    if (tableEl) tableEl.value = p.table || '*';
}

function _usersDatabaseChanged(cid, database) {
    var state = _usersState(cid);
    database = String(database || '*').trim() || '*';
    state.permission = {database: database, table: '*', privileges: [], grantOption: false};
    state.tables = [];
    state.tablesDatabase = '';
    state.tablesError = '';
    _usersRenderPermission(cid);
    _usersLoadTables(cid, database);
    _usersLoadPermission(cid);
}

function _usersTableChanged(cid, table) {
    _usersLoadPermission(cid, table);
}

function _usersLoadPermission(cid) {
    var state = _usersState(cid);
    var dbEl = document.getElementById(_usersDomKey(cid) + '_db');
    var tableEl = document.getElementById(_usersDomKey(cid) + '_table');
    if (!dbEl || !tableEl) return;
    var database = dbEl.value.trim() || '*';
    var table = tableEl.value.trim() || '*';
    var grant = _usersGrantForScope(cid, database, table);
    state.permission = {database: database, table: table, privileges: grant.privileges, grantOption: grant.grantOption};
    _usersRenderPermission(cid);
}

function _usersTogglePrivilege(cid, input) {
    var state = _usersState(cid);
    state.permission = state.permission || {database: '*', table: '*', privileges: [], grantOption: false};
    var list = state.permission.privileges || [];
    var value = input.value;
    if (input.checked && list.indexOf(value) < 0) list.push(value);
    if (!input.checked) state.permission.privileges = list.filter(function(x){ return x !== value; });
}

function _usersSavePrivileges(cid) {
    var state = _usersState(cid);
    var user = state.users[state.selectedIndex];
    var key = _usersDomKey(cid);
    if (!user) return;
    var dbEl = document.getElementById(key+'_db'), tableEl = document.getElementById(key+'_table');
    var grantEl = document.getElementById(key+'_grant');
    var privileges = Array.prototype.slice.call(document.querySelectorAll('#'+key+'_permission input[type="checkbox"][value]:checked')).map(function(x){return x.value;});
    var database = dbEl && dbEl.value.trim() ? dbEl.value.trim() : '*';
    var table = tableEl && tableEl.value.trim() ? tableEl.value.trim() : '*';
    var conn = treeData.connections[cid];
    eel.mysql_user_apply_privileges(conn, user.user, user.host, database, table, privileges, !!(grantEl && grantEl.checked))(function(r) {
        if (r && r.ok) { showOkDialog('成功', r.msg || '权限已更新'); _usersSelect(cid, state.selectedIndex); }
        else showErrorDialog('保存权限失败', r && r.msg ? r.msg : '无响应');
    });
}

function _usersCreateDialog(cid) {
    var key = _usersDomKey(cid);
    var html = '<div class="users-modal-form"><label>用户名</label><input id="'+key+'_new_user" placeholder="例如 report_user">' +
        '<label>Host</label><input id="'+key+'_new_host" value="%" placeholder="%">' +
        '<label>密码</label><input id="'+key+'_new_pwd" type="password" placeholder="请输入密码"></div>';
    showModal('♙', '新建用户', html, '#5dade2', '<button class="btn btn-gray" id="modal_cancel_btn">取消</button><button class="btn btn-blue" id="users_create_ok">创建</button>');
    setTimeout(function(){
        var ok = document.getElementById('users_create_ok');
        if (ok) ok.onclick = function(){
            var user = document.getElementById(key+'_new_user').value.trim();
            var host = document.getElementById(key+'_new_host').value.trim() || '%';
            var pwd = document.getElementById(key+'_new_pwd').value;
            if (!user) { showErrorDialog('创建失败', '请输入用户名'); return; }
            hideModal();
            eel.mysql_user_create(treeData.connections[cid], user, host, pwd)(function(r){
                if (r && r.ok) { showOkDialog('成功', r.msg || '用户创建成功'); _usersLoad(cid); }
                else showErrorDialog('创建失败', r && r.msg ? r.msg : '无响应');
            });
        };
    }, 10);
}

function _usersPasswordDialog(cid) {
    var state = _usersState(cid), user = state.users[state.selectedIndex];
    if (!user) return;
    var key = _usersDomKey(cid);
    var html = '<div class="users-modal-form"><div style="margin-bottom:10px;color:#999;">'+escapeHtml(user.user)+'@'+escapeHtml(user.host)+'</div><label>新密码</label><input id="'+key+'_pwd" type="password" placeholder="请输入新密码"></div>';
    showModal('🔑', '修改密码', html, '#5dade2', '<button class="btn btn-gray" id="modal_cancel_btn">取消</button><button class="btn btn-blue" id="users_pwd_ok">保存</button>');
    setTimeout(function(){ var ok = document.getElementById('users_pwd_ok'); if (ok) ok.onclick = function(){
        var pwd = document.getElementById(key+'_pwd').value;
        if (!pwd) { showErrorDialog('修改失败', '请输入新密码'); return; }
        hideModal();
        eel.mysql_user_update_password(treeData.connections[cid], user.user, user.host, pwd)(function(r){
            if (r && r.ok) showOkDialog('成功', r.msg || '密码修改成功'); else showErrorDialog('修改失败', r && r.msg ? r.msg : '无响应');
        });
    }; }, 10);
}

function _usersToggleLock(cid) {
    var state = _usersState(cid), user = state.users[state.selectedIndex];
    if (!user) return;
    var action = user.locked ? '解锁' : '锁定';
    showConfirmDialog('确认操作', '确定'+action+'用户 '+user.user+'@'+user.host+'？', function(){
        eel.mysql_user_set_lock(treeData.connections[cid], user.user, user.host, !user.locked)(function(r){
            if (r && r.ok) { showOkDialog('成功', r.msg || '操作成功'); _usersLoad(cid); }
            else showErrorDialog('操作失败', r && r.msg ? r.msg : '无响应');
        });
    });
}

function _usersDelete(cid) {
    var state = _usersState(cid), user = state.users[state.selectedIndex];
    if (!user) return;
    showConfirmDialog('危险操作', '确定删除用户 <b>'+escapeHtml(user.user)+'@'+escapeHtml(user.host)+'</b>？该用户的所有授权也会被删除。', function(){
        eel.mysql_user_delete(treeData.connections[cid], user.user, user.host)(function(r){
            if (r && r.ok) { showOkDialog('成功', r.msg || '用户已删除'); state.selectedIndex = -1; _usersLoad(cid); }
            else showErrorDialog('删除失败', r && r.msg ? r.msg : '无响应');
        });
    });
}
