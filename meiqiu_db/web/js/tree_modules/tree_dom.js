// ==================== 局部 DOM 操作（不重新渲染整个树） ====================
function addConnToTree(c) {
    var pid = c.parent || '';
    var indent = pid ? getFolderDepth(pid) * 16 + 16 : 0;
    var html = renderConn(c, indent);
    if (pid) {
        var container = document.getElementById('mc_' + pid);
        if (container) {
            // 如果文件夹未展开则先展开
            if (!container.classList.contains('open')) {
                container.classList.add('open');
                var arr = document.getElementById('ma_' + pid);
                if (arr) { arr.textContent = '▾'; arr.style.visibility = 'visible'; }
            } else {
                var arr = document.getElementById('ma_' + pid);
                if (arr) arr.style.visibility = 'visible';
            }
            container.insertAdjacentHTML('beforeend', html);
        } else {
            document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', renderConn(c, 0));
        }
    } else {
        document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', html);
    }
}

function updateConnNode(cid, c) {
    var node = document.querySelector('.tree-node[data-cid="' + cid + '"]');
    if (!node) return;
    var nameEl = node.querySelector('.my-conn-name');
    var hostEl = node.querySelector('.my-conn-host');
    var iconEl = node.querySelector('.my-conn-icon.db-icon');
    var rowEl = node.querySelector('.my-conn-row');
    if (nameEl) {
        nameEl.innerHTML = escapeHtml(c.name || '') +
            (c.color ? '<span class="conn-color-dot" style="background:'+escapeHtml(c.color)+'"></span>' : '');
    }
    if (hostEl) hostEl.textContent = (c.host || '') + ':' + (c.port || '3306');
    if (iconEl) {
        iconEl.innerHTML = getConnIcon(c.db_type || 'mysql');
        // 保持图标颜色状态
        var children2 = document.getElementById('mc_c_' + cid);
        if (children2 && children2.classList.contains('open')) {
            iconEl.classList.remove('closed'); iconEl.classList.add('active');
        } else {
            iconEl.classList.remove('active'); iconEl.classList.add('closed');
        }
    }
    // ★ 刷新连接行背景色
    if (rowEl) {
        rowEl.style.background = (c.color && /^#[0-9a-fA-F]{6}$/.test(c.color)) ?
            'rgba('+parseInt(c.color.slice(1,3),16)+','+parseInt(c.color.slice(3,5),16)+','+parseInt(c.color.slice(5,7),16)+',0.18)' : '';
    }
}

function removeConnNode(cid) {
    var node = document.querySelector('.tree-node[data-cid="' + cid + '"]');
    if (node) node.remove();
}
function removeFolderNode(fid) {
    var node = document.querySelector('.tree-node[data-fid="' + fid + '"]');
    if (node) node.remove();
}

function addFolderToTree(f) {
    // 计算文件夹的缩进深度（从父级推算）
    function getFolderDepth(fid) {
        var depth = 0;
        var cur = fid;
        while (cur) {
            var p = (treeData.folders || []).find(function(x){return x.id===cur;});
            if (p && p.parent) { depth++; cur = p.parent; }
            else break;
        }
        return depth;
    }
    var depth = f.parent ? getFolderDepth(f.parent) + 1 : 0;
    var indent = depth * 16;

    if (f.parent) {
        // 子文件夹：插入到父文件夹的 tree-children 容器中
        var parentChildren = document.getElementById('mc_' + f.parent);
        if (parentChildren) {
            parentChildren.insertAdjacentHTML('beforeend', renderFolder(f, indent));
            // 展开父文件夹
            parentChildren.classList.add('open');
            var parentArrow = document.getElementById('ma_' + f.parent);
            if (parentArrow) { parentArrow.textContent = '▾'; }
        } else {
            // 如果父容器的子容器还没渲染，回退到列表末尾
            document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', renderFolder(f, indent));
        }
    } else {
        // 根级文件夹：直接插入列表
        document.getElementById('my_conn_list').insertAdjacentHTML('beforeend', renderFolder(f, indent));
    }
}

function updateFolderNode(fid, name) {
    var node = document.querySelector('.tree-node[data-fid="' + fid + '"]');
    if (!node) return;
    var nameEl = node.querySelector('.my-conn-name');
    if (nameEl) nameEl.textContent = name;
}
