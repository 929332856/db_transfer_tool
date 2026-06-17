"""
树形栏目持久化（含自动备份恢复）
"""
import eel
import os
import sys
import json
import time
from datetime import datetime
from modules import BASE_DIR

# ==================== 树形栏目持久化（含自动备份恢复） ====================
if getattr(sys, 'frozen', False):
    # 打包exe环境：exe在dist/目录，直接读取同目录下的文件
    TREE_FILE = os.path.join(BASE_DIR, "navicat_tree.json")
else:
    # 源码运行环境：从dist/目录读取
    TREE_FILE = os.path.join(BASE_DIR, "dist", "navicat_tree.json")
TREE_BACKUP_DIR = os.path.join(BASE_DIR, ".tree_backups")
MAX_BACKUPS = 5  # 最多保留 5 份备份


# 确保目录存在
try:
    os.makedirs(TREE_BACKUP_DIR, exist_ok=True)
except Exception:
    pass

def _validate_tree(data):
    """校验树数据结构完整性（仅检查结构，不检查内容）"""
    if not isinstance(data, dict):
        return False
    # 必须包含三个关键字段
    for key in ("folders", "connections", "saved_queries"):
        if key not in data:
            data[key] = [] if key != "connections" else {}
    if not isinstance(data.get("folders"), list):
        return False
    if not isinstance(data.get("connections"), dict):
        return False
    if not isinstance(data.get("saved_queries"), list):
        return False
    return True

def _tree_has_content(data):
    """检查树数据是否有实际内容（不只是空壳）"""
    if not isinstance(data, dict):
        return False
    has_conns = bool(data.get("connections") and len(data.get("connections", {})) > 0)
    has_folders = bool(data.get("folders") and len(data.get("folders", [])) > 0)
    has_queries = bool(data.get("saved_queries") and len(data.get("saved_queries", [])) > 0)
    return has_conns or has_folders or has_queries

def _is_empty_shell(data):
    """检查是否是结构合法但内容为空的'空壳'数据"""
    return _validate_tree(data) and not _tree_has_content(data)

def _backup_tree():
    """备份当前的 navicat_tree.json（如果文件有有效数据）"""
    try:
        if not os.path.exists(TREE_FILE) or os.path.getsize(TREE_FILE) == 0:
            return
        with open(TREE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not _validate_tree(data):
            return
        # 检查是否有实际内容值得备份
        if not _tree_has_content(data):
            return
        # 生成备份文件名
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = os.path.join(TREE_BACKUP_DIR, f"navicat_tree_{timestamp}.json")
        with open(backup_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        # 清理旧备份：只保留最新的 MAX_BACKUPS 份
        backups = sorted(
            [b for b in os.listdir(TREE_BACKUP_DIR) if b.startswith("navicat_tree_") and b.endswith(".json")],
            reverse=True
        )
        for old_bak in backups[MAX_BACKUPS:]:
            try:
                os.remove(os.path.join(TREE_BACKUP_DIR, old_bak))
            except Exception:
                pass
    except Exception:
        pass  # 备份失败不影响主流程

_LAST_AUTO_BACKUP = 0  # 上次自动备份的时间戳

def _maybe_auto_backup():
    """每隔一定时间自动备份（仅在 _load_tree 时调用）"""
    global _LAST_AUTO_BACKUP
    now = time.time()
    if now - _LAST_AUTO_BACKUP < 3600:  # 1小时
        return
    try:
        _backup_tree()
        _LAST_AUTO_BACKUP = now
    except Exception:
        pass

def _recover_from_backup():
    """尝试从 .tree_backups/ 备份恢复数据"""
    try:
        if os.path.exists(TREE_BACKUP_DIR):
            backups = sorted(
                [b for b in os.listdir(TREE_BACKUP_DIR) if b.startswith("navicat_tree_") and b.endswith(".json")],
                reverse=True
            )
            for bak_file in backups:
                bak_path = os.path.join(TREE_BACKUP_DIR, bak_file)
                try:
                    with open(bak_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    if _validate_tree(data) and _tree_has_content(data):
                        # 恢复成功：用备份覆盖主文件
                        with open(TREE_FILE, "w", encoding="utf-8") as f:
                            json.dump(data, f, ensure_ascii=False, indent=2)
                        print("[tree] 已从备份恢复数据:", bak_file)
                        return data
                except Exception:
                    continue
    except Exception:
        pass
    return None

# 初始化：文件不存在就创建；存在但为空/损坏则尝试恢复
try:
    print(f"[tree] 初始化: frozen={getattr(sys, 'frozen', False)}, TREE_FILE={TREE_FILE}")
    if not os.path.exists(TREE_FILE):
        print("[tree] 初始化: TREE_FILE 不存在，尝试从备份恢复")
        recovered = _recover_from_backup()
        if not recovered:
            print("[tree] 初始化: 无可用备份，创建空文件")
            with open(TREE_FILE, "w", encoding="utf-8") as f:
                json.dump({"folders": [], "connections": {}, "saved_queries": []}, f, ensure_ascii=False, indent=2)
        else:
            print("[tree] 初始化: 从备份恢复成功")
    else:
        file_size = os.path.getsize(TREE_FILE)
        print(f"[tree] 初始化: 文件已存在，size={file_size} bytes")
        # 文件存在但内容为空或只有空壳数据 → 尝试恢复
        try:
            if file_size < 200:
                print("[tree] 初始化: 文件<200字节，检查是否空壳")
                with open(TREE_FILE, "r", encoding="utf-8") as f:
                    init_data = json.load(f)
                if _is_empty_shell(init_data):
                    print("[tree] 初始化: 空壳数据，尝试从备份恢复")
                    recovered = _recover_from_backup()
        except Exception as e:
            print(f"[tree] 初始化: 检查文件时异常 {e}")
except Exception as e:
    print(f"[tree] 初始化: 异常 {e}")

def _load_tree():
    try:
        print(f"[tree] _load_tree: reading TREE_FILE={TREE_FILE}")
        print(f"[tree] _load_tree: file exists={os.path.exists(TREE_FILE)}")
        with open(TREE_FILE, "r", encoding="utf-8") as f:
            content = f.read()
        print(f"[tree] _load_tree: file size={len(content)} bytes")
        if not content.strip():
            print("[tree] _load_tree: 文件为空，尝试恢复")
            recovered = _recover_from_backup()
            if recovered:
                return recovered
            return {"folders": [], "connections": {}, "saved_queries": []}
        data = json.loads(content)
        conn_count = len(data.get("connections", {}))
        print(f"[tree] _load_tree: 解析成功，connections={conn_count}, folders={len(data.get('folders',[]))}, queries={len(data.get('saved_queries',[]))}")
        if not _validate_tree(data):
            print("[tree] _load_tree: 数据格式不正确，尝试恢复")
            recovered = _recover_from_backup()
            if recovered:
                return recovered
            return {"folders": [], "connections": {}, "saved_queries": []}
        # 【关键】结构合法但内容为空（空壳），尝试恢复
        if _is_empty_shell(data):
            print("[tree] _load_tree: 空壳数据，尝试恢复")
            recovered = _recover_from_backup()
            if recovered:
                return recovered
        # 正常加载，顺便做一次备份（如果距上次备份超过1小时）
        _maybe_auto_backup()
        return data
    except json.JSONDecodeError as e:
        print(f"[tree] _load_tree JSON解析失败: {e}")
        recovered = _recover_from_backup()
        if recovered:
            return recovered
        return {"folders": [], "connections": {}, "saved_queries": []}
    except FileNotFoundError:
        print(f"[tree] _load_tree: 文件不存在 TREE_FILE={TREE_FILE}")
        recovered = _recover_from_backup()
        if recovered:
            return recovered
        return {"folders": [], "connections": {}, "saved_queries": []}
    except Exception as e:
        print(f"[tree] _load_tree 异常: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return {"folders": [], "connections": {}, "saved_queries": []}

def _save_tree(data):
    try:
        # 数据校验
        if not _validate_tree(data):
            print("[tree] _save_tree: 数据校验失败，拒绝保存")
            return
        # 【防覆盖】如果新数据是空壳，但当前文件有实际内容 → 拒绝（防止误覆盖）
        if _is_empty_shell(data) and os.path.exists(TREE_FILE):
            try:
                with open(TREE_FILE, "r", encoding="utf-8") as f:
                    current = json.load(f)
                if _tree_has_content(current):
                    print("[tree] _save_tree: 拒绝用空壳数据覆盖现有 %d 个连接" 
                          % len(current.get("connections", {})))
                    return
            except Exception:
                pass  # 当前文件读不了就算了，让写入继续
        # 保存前先备份
        _backup_tree()
        # 原子写入：先写临时文件，再替换（防止写入中途崩溃损坏数据）
        tmp_file = TREE_FILE + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        # Windows 需要先删除目标文件再重命名
        if os.path.exists(TREE_FILE):
            os.replace(tmp_file, TREE_FILE)
        else:
            os.rename(tmp_file, TREE_FILE)
    except Exception as e:
        print(f"[tree] _save_tree 异常: {e}")
        # 清理临时文件
        try:
            if os.path.exists(TREE_FILE + ".tmp"):
                os.remove(TREE_FILE + ".tmp")
        except Exception:
            pass


@eel.expose
def ping():
    """诊断用：确认 Eel WebSocket 通信正常"""
    return "pong"

@eel.expose
def tree_diag():
    """返回树文件诊断信息（打包 exe 无控制台时调试用）"""
    info = {
        "frozen": getattr(sys, 'frozen', False),
        "tree_file": TREE_FILE,
        "tree_file_exists": os.path.exists(TREE_FILE),
        "tree_file_size": os.path.getsize(TREE_FILE) if os.path.exists(TREE_FILE) else -1,
        "backup_dir": TREE_BACKUP_DIR,
        "backup_dir_exists": os.path.exists(TREE_BACKUP_DIR),
    }
    if info["tree_file_exists"] and info["tree_file_size"] > 0:
        try:
            with open(TREE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            info["connections_count"] = len(data.get("connections", {}))
            info["folders_count"] = len(data.get("folders", []))
            info["queries_count"] = len(data.get("saved_queries", []))
            info["valid"] = _validate_tree(data)
            info["has_content"] = _tree_has_content(data)
        except Exception as e:
            info["parse_error"] = f"{type(e).__name__}: {e}"
    info["backups"] = []
    try:
        if os.path.exists(TREE_BACKUP_DIR):
            backups = sorted([b for b in os.listdir(TREE_BACKUP_DIR) if b.startswith("navicat_tree_")], reverse=True)[:5]
            info["backups"] = backups
    except Exception:
        pass
    return info

@eel.expose
def tree_load():
    data = _load_tree()
    return data
@eel.expose
def tree_save(data): _save_tree(data); return True
@eel.expose
def tree_backup_now():
    """手动触发备份"""
    try:
        _backup_tree()
        return {"ok": True, "msg": "备份完成"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}
@eel.expose
def tree_get_backups():
    """获取备份文件列表"""
    try:
        if not os.path.exists(TREE_BACKUP_DIR):
            return {"ok": True, "backups": []}
        backups = sorted(
            [b for b in os.listdir(TREE_BACKUP_DIR) if b.startswith("navicat_tree_") and b.endswith(".json")],
            reverse=True
        )
        result = []
        for b in backups:
            path = os.path.join(TREE_BACKUP_DIR, b)
            try:
                size = os.path.getsize(path)
                ts_str = b.replace("navicat_tree_", "").replace(".json", "")
                result.append({"name": b, "size": size, "ts": ts_str})
            except Exception:
                pass
        return {"ok": True, "backups": result}
    except Exception as e:
        return {"ok": False, "msg": str(e)}
@eel.expose
def tree_force_recover():
    """强制从备份或 dist/ 恢复数据，返回恢复结果"""
    try:
        recovered = _recover_from_backup()
        if recovered:
            conn_count = len(recovered.get("connections", {}))
            return {"ok": True, "msg": f"已恢复 {conn_count} 个连接", "connections": conn_count}
        return {"ok": False, "msg": "未找到可恢复的备份文件", "connections": 0}
    except Exception as e:
        return {"ok": False, "msg": str(e)}
@eel.expose
def tree_check_integrity():
    """检查 navicat_tree.json 完整性，返回诊断信息"""
    result = {"file_exists": os.path.exists(TREE_FILE), "issues": []}
    try:
        if result["file_exists"]:
            result["file_size"] = os.path.getsize(TREE_FILE)
            data = _load_tree()
            result["connections"] = len(data.get("connections", {}))
            result["folders"] = len(data.get("folders", []))
            result["queries"] = len(data.get("saved_queries", []))
            if _is_empty_shell(data) and result["file_size"] > 0:
                result["issues"].append("空壳数据：文件存在但无连接/文件夹/查询")
            if not _validate_tree(data):
                result["issues"].append("数据结构校验失败")
            # 检查是否有备份可用
            has_backup = False
            if os.path.exists(TREE_BACKUP_DIR):
                backups = [b for b in os.listdir(TREE_BACKUP_DIR) if b.startswith("navicat_tree_") and b.endswith(".json")]
                has_backup = len(backups) > 0
            result["has_backup"] = has_backup
        else:
            result["file_size"] = 0
            result["issues"].append("navicat_tree.json 不存在")
        result["ok"] = len(result["issues"]) == 0
    except Exception as e:
        result["issues"].append(str(e))
        result["ok"] = False
    return result

@eel.expose
def tree_add_folder(parent_id, name):
    tree = _load_tree()
    fid = f"f_{int(time.time() * 1000)}"
    tree.setdefault("folders", []).append({"id": fid, "name": name, "parent": parent_id or ""})
    _save_tree(tree)
    return {"ok": True, "id": fid}

@eel.expose
def tree_delete_folder(fid):
    tree = _load_tree()
    kids = [f["id"] for f in tree.get("folders", []) if f.get("parent") == fid]
    for k in kids: tree_delete_folder(k)
    tree["folders"] = [f for f in tree.get("folders", []) if f["id"] != fid]
    to_del = [k for k, v in tree.get("connections", {}).items() if v.get("parent") == fid]
    for k in to_del: del tree["connections"][k]
    _save_tree(tree)
    return True

@eel.expose
def tree_rename_folder(fid, name):
    tree = _load_tree()
    for f in tree.get("folders", []):
        if f["id"] == fid: f["name"] = name
    _save_tree(tree)
    return True

@eel.expose
def tree_add_connection(parent_id, conn_data):
    tree = _load_tree()
    cid = f"c_{int(time.time() * 1000)}"
    conn_data["id"] = cid; conn_data["parent"] = parent_id or ""
    tree.setdefault("connections", {})[cid] = conn_data
    _save_tree(tree)
    return {"ok": True, "id": cid}

@eel.expose
def tree_update_connection(cid, conn_data):
    tree = _load_tree()
    if cid in tree.get("connections", {}):
        conn_data["id"] = cid
        conn_data["parent"] = tree["connections"][cid].get("parent", "")
        tree["connections"][cid] = conn_data
        _save_tree(tree)
    return True

@eel.expose
def tree_delete_connection(cid):
    tree = _load_tree()
    tree.get("connections", {}).pop(cid, None)
    _save_tree(tree)
    return True

@eel.expose
def tree_move_connection(cid, new_parent_id):
    """将连接移动到指定文件夹下（new_parent_id 为空则移到根）"""
    tree = _load_tree()
    if cid not in tree.get("connections", {}):
        return {"ok": False, "msg": "连接不存在"}
    tree["connections"][cid]["parent"] = new_parent_id or ""
    _save_tree(tree)
    return {"ok": True}
