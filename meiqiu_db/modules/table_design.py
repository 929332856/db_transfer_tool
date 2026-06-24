"""
表设计器：设计信息获取、设计变更应用、表截断/删除/清空/重命名/备份
"""
import eel
from datetime import datetime as dt
from sqlalchemy import text, create_engine, inspect
from modules import _query_cancel
from modules.conn_utils import _connect_args, _conn_url, _safe_ident, _build_table_ref, _friendly_error
from modules.config_state import _log_db_delete, _db_op_logger

@eel.expose
def table_get_design_info(conn_data, database, table_name, schema=''):
    """获取表完整设计信息（字段、索引、外键、表属性）"""
    cdata = {}
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type not in ('postgresql', 'oracle'):
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))

        result = {"columns": [], "indexes": [], "foreign_keys": [], "table_options": {}}

        with engine.connect() as conn:
            if db_type in ('mysql', 'ob-mysql'):
                # 列信息
                cols = conn.execute(text(
                    "SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, "
                    "NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION "
                    "FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl "
                    "ORDER BY ORDINAL_POSITION"
                ), {"db": database, "tbl": table_name}).fetchall()
                for r in cols:
                    result["columns"].append({
                        "name": r[0], "col_type": r[1], "data_type": r[2],
                        "length": r[3], "precision": r[4], "scale": r[5],
                        "nullable": r[6] == "YES",
                        "default_val": str(r[7]) if r[7] is not None else None,
                        "auto_increment": "auto_increment" in (r[8] or ""),
                        "comment": r[9] or "", "position": r[10]
                    })

                # 索引信息（用 INFORMATION_SCHEMA.STATISTICS 替代 SHOW INDEX FROM）
                idxs = conn.execute(text(
                    "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE "
                    "FROM INFORMATION_SCHEMA.STATISTICS "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl "
                    "ORDER BY INDEX_NAME, SEQ_IN_INDEX"
                ), {"db": database, "tbl": table_name}).fetchall()
                idx_map = {}
                for r in idxs:
                    key_name = r[0]
                    if key_name not in idx_map:
                        idx_map[key_name] = {
                            "name": key_name,
                            "type": "PRIMARY" if key_name == "PRIMARY" else ("UNIQUE" if r[1] == 0 else "INDEX"),
                            "columns": [], "method": r[3] or "BTREE"
                        }
                    idx_map[key_name]["columns"].append(r[2])
                result["indexes"] = list(idx_map.values())

                # 外键
                fks = conn.execute(text(
                    "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, "
                    "r.UPDATE_RULE, r.DELETE_RULE "
                    "FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k "
                    "JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r "
                    "ON k.CONSTRAINT_NAME=r.CONSTRAINT_NAME AND k.CONSTRAINT_SCHEMA=r.CONSTRAINT_SCHEMA "
                    "WHERE k.TABLE_SCHEMA=:db AND k.TABLE_NAME=:tbl AND k.REFERENCED_TABLE_NAME IS NOT NULL"
                ), {"db": database, "tbl": table_name}).fetchall()
                for r in fks:
                    result["foreign_keys"].append({
                        "name": r[0], "column": r[1], "ref_table": r[2],
                        "ref_column": r[3], "on_update": r[4] or "RESTRICT", "on_delete": r[5] or "RESTRICT"
                    })

                # 表属性
                opts = conn.execute(text(
                    "SELECT ENGINE, TABLE_COLLATION, TABLE_COMMENT FROM INFORMATION_SCHEMA.TABLES "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl"
                ), {"db": database, "tbl": table_name}).fetchone()
                if opts:
                    result["table_options"] = {
                        "engine": opts[0] or "InnoDB",
                        "collation": opts[1] or "",
                        "comment": opts[2] or ""
                    }

            elif db_type == 'postgresql':
                sch = schema if schema else database
                cols = conn.execute(text(
                    "SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, "
                    "is_nullable, column_default, ordinal_position "
                    "FROM information_schema.columns WHERE table_schema=:sch AND table_name=:tbl ORDER BY ordinal_position"
                ), {"sch": sch, "tbl": table_name}).fetchall()
                for r in cols:
                    result["columns"].append({
                        "name": r[0], "col_type": r[1], "data_type": r[1],
                        "length": r[2], "precision": r[3], "scale": r[4],
                        "nullable": r[5] == "YES",
                        "default_val": str(r[6]) if r[6] is not None else None,
                        "auto_increment": False,
                        "comment": "", "position": r[7]
                    })
                result["table_options"] = {"engine": "", "collation": "", "comment": ""}

            else:
                # Oracle / MSSQL 等暂返回基础列信息
                result["table_options"] = {"engine": "", "collation": "", "comment": ""}

        engine.dispose()
        return {"ok": True, "design": result}
    except Exception as e:
        db_t = cdata.get('db_type', 'mysql') if cdata else 'mysql'
        return {"ok": False, "msg": _friendly_error(e, db_t)}


@eel.expose
def table_apply_design(conn_data, database, table_name, design, schema='', execute=True):
    """应用表设计修改（生成并执行 ALTER TABLE），execute=False 时仅返回 SQL"""
    cdata = {}
    db_type = 'mysql'
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type not in ('postgresql', 'oracle'):
            cdata["db"] = database
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        tbl = _build_table_ref(cdata, database, table_name)

        sqls = []
        if db_type in ('mysql', 'ob-mysql'):
            columns = design.get("columns", [])
            indexes = design.get("indexes", [])
            foreign_keys = design.get("foreign_keys", [])
            table_options = design.get("table_options", {})

            # ★ 检查取消标记（在可能耗时的 INFORMATION_SCHEMA 查询前）
            if _query_cancel.is_set():
                engine.dispose()
                return {"ok": False, "msg": "操作已取消", "cancelled": True}

            # 获取数据库中现有列名 + 索引详情 + 表属性（用于 diff）
            with engine.connect() as curconn:
                existing_rows = curconn.execute(text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl"
                ), {"db": database, "tbl": table_name}).fetchall()
                # 现有列详情
                existing_detail_rows = curconn.execute(text(
                    "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT "
                    "FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl ORDER BY ORDINAL_POSITION"
                ), {"db": database, "tbl": table_name}).fetchall()
                # 现有索引详情（名称+类型+列+方法）
                existing_idx_rows = curconn.execute(text(
                    "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE "
                    "FROM INFORMATION_SCHEMA.STATISTICS "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl "
                    "ORDER BY INDEX_NAME, SEQ_IN_INDEX"
                ), {"db": database, "tbl": table_name}).fetchall()
                # 现有表属性
                existing_opt = curconn.execute(text(
                    "SELECT ENGINE, TABLE_COLLATION, TABLE_COMMENT "
                    "FROM INFORMATION_SCHEMA.TABLES "
                    "WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:tbl"
                ), {"db": database, "tbl": table_name}).fetchone()
            existing_cols = set(r[0] for r in existing_rows)
            # 构建现有列详情
            existing_detail = {}
            for r in existing_detail_rows:
                existing_detail[r[0]] = {
                    "col_type": r[1] or "",
                    "nullable": r[2] == "YES",
                    "default_val": str(r[3]) if r[3] is not None else None,
                    "auto_increment": "auto_increment" in (r[4] or ""),
                    "comment": r[5] or ""
                }
            # 构建现有索引详情 {name: {type, columns, method}}
            existing_detail_idx = {}
            for r in existing_idx_rows:
                if r[0] not in existing_detail_idx:
                    existing_detail_idx[r[0]] = {
                        "type": "PRIMARY" if r[0] == "PRIMARY" else ("UNIQUE" if r[1] == 0 else "INDEX"),
                        "columns": [], "method": r[3] or "BTREE"
                    }
                existing_detail_idx[r[0]]["columns"].append(r[2])
            # 现有表属性
            existing_opts = {}
            if existing_opt:
                existing_opts = {
                    "engine": (existing_opt[0] or "InnoDB").lower(),
                    "collation": (existing_opt[1] or "").lower(),
                    "comment": existing_opt[2] or ""
                }

            # ===== 三阶段 ALTER TABLE：先删索引 → 再改列 → 最后加索引 =====
            new_col_names = set(col.get("name", "") for col in columns)
            dropped_col_names = set(n for n in existing_detail if n not in new_col_names)

            # ★ 安全校验：如果所有列都不匹配（设计数据显然来自另一张表），拒绝执行
            common_cols = new_col_names & set(existing_detail.keys())
            if not common_cols and dropped_col_names and new_col_names:
                engine.dispose()
                wrong_tn_hint = f"设计数据中的列 [{', '.join(sorted(list(new_col_names))[:5])}{'...' if len(new_col_names) > 5 else ''}] 与表 [{table_name}] 的实际列 [{', '.join(sorted(list(existing_detail.keys()))[:5])}{'...' if len(existing_detail) > 5 else ''}] 完全不匹配。可能原因：打开了多个设计Tab导致数据串扰，请关闭并重新打开该表的设计Tab后再试。"
                return {"ok": False, "msg": wrong_tn_hint}

            pre_parts = []   # 阶段1：删除索引
            mid_parts = []   # 阶段2：列操作 + 主键
            post_parts = []  # 阶段3：新建索引 + 表属性

            # -- 阶段1：删除所有受影响的索引（先删索引才能安全删列）--
            # 1a. 删除引用被删列的已有索引
            for old_idx_name, old_idx_info in existing_detail_idx.items():
                if old_idx_name == "PRIMARY":
                    continue
                idx_cols = set(old_idx_info.get("columns", []))
                if idx_cols & dropped_col_names:
                    old_itype = "UNIQUE" if old_idx_info["type"] == "UNIQUE" else "INDEX"
                    pre_parts.append(f"DROP {old_itype} {_safe_ident(old_idx_name, db_type)}")

            # 1b. 删除被修改的已有索引（先DROP再在阶段3 ADD）
            for idx in indexes:
                if idx.get("type") == "PRIMARY":
                    continue
                idx_name = idx["name"]
                if idx_name in existing_detail_idx and idx_name not in dropped_col_names:
                    old_idx = existing_detail_idx[idx_name]
                    new_cols = sorted(idx.get("columns", []))
                    old_cols = sorted(old_idx.get("columns", [])) if old_idx else []
                    idx_type = "UNIQUE" if idx.get("type") == "UNIQUE" else "INDEX"
                    old_idx_type = old_idx.get("type", "")
                    if new_cols != old_cols or idx_type != old_idx_type:
                        pre_parts.append(f"DROP {idx_type} {_safe_ident(idx_name, db_type)}")

            # 1c. 删除完全移除的索引
            new_idx_names = set(idx.get("name", "") for idx in indexes)
            for old_idx_name in existing_detail_idx:
                if old_idx_name == "PRIMARY":
                    continue
                if old_idx_name not in new_idx_names and old_idx_name not in dropped_col_names:
                    old_it = existing_detail_idx[old_idx_name]
                    old_itype = "UNIQUE" if old_it["type"] == "UNIQUE" else "INDEX"
                    pre_parts.append(f"DROP {old_itype} {_safe_ident(old_idx_name, db_type)}")

            # -- 阶段2：列操作 --
            for i, col in enumerate(columns):
                col_name = col.get("name", "")
                name = _safe_ident(col_name, db_type)
                col_type = col.get("col_type", col.get("data_type", "VARCHAR(255)"))
                nullable = " NULL" if col.get("nullable", True) else " NOT NULL"
                default = f" DEFAULT {col['default_val']}" if col.get("default_val") else ""
                auto_inc = " AUTO_INCREMENT" if col.get("auto_increment") else ""
                cmt_raw = col.get('comment', '')
                if cmt_raw:
                    cmt_esc = cmt_raw.replace("'", "\\'")
                    comment = f" COMMENT '{cmt_esc}'"
                else:
                    comment = ""
                after_clause = ""
                if i == 0:
                    after_clause = " FIRST"
                elif i > 0:
                    after_clause = f" AFTER {_safe_ident(columns[i-1]['name'], db_type)}"
                col_def = f"{name} {col_type}{nullable}{default}{auto_inc}{comment}"

                if col_name and col_name in existing_detail:
                    old = existing_detail[col_name]
                    new_type = (col.get("col_type") or col.get("data_type", "")).lower()
                    old_type = (old["col_type"] or "").lower()
                    changed = (
                        new_type != old_type
                        or col.get("nullable", True) != old["nullable"]
                        or col.get("default_val") != old["default_val"]
                        or col.get("auto_increment", False) != old["auto_increment"]
                        or col.get("comment", "") != old["comment"]
                    )
                    if changed:
                        mid_parts.append(f"MODIFY COLUMN {col_def}{after_clause}")
                else:
                    mid_parts.append(f"ADD COLUMN {col_def}{after_clause}")

            # 删除列
            for old_name in dropped_col_names:
                mid_parts.append(f"DROP COLUMN {_safe_ident(old_name, db_type)}")

            # 主键
            pk_idx = None
            for idx in indexes:
                if idx.get("type") == "PRIMARY":
                    pk_idx = idx
                    break
            old_pk = existing_detail_idx.get("PRIMARY", {})
            old_pk_cols = set(old_pk.get("columns", []))
            new_pk_cols = set(pk_idx.get("columns", [])) if pk_idx else set()
            if pk_idx and new_pk_cols and (not old_pk_cols or new_pk_cols != old_pk_cols):
                pk_cols = ", ".join(_safe_ident(c, db_type) for c in pk_idx.get("columns", []))
                mid_parts.append(f"DROP PRIMARY KEY, ADD PRIMARY KEY ({pk_cols})")

            # -- 阶段3：新建/重建索引 --
            for idx in indexes:
                if idx.get("type") == "PRIMARY":
                    continue
                idx_name = idx["name"]
                idx_type = "UNIQUE" if idx.get("type") == "UNIQUE" else "INDEX"
                idx_col_names = idx.get("columns", [])
                # 跳过引用被删列的索引
                if set(idx_col_names) & dropped_col_names:
                    continue
                # 跳过旧索引没变化的
                new_cols = sorted(idx_col_names)
                old_idx = existing_detail_idx.get(idx_name, {})
                old_cols = sorted(old_idx.get("columns", [])) if old_idx else []
                if idx_name in existing_detail_idx and new_cols == old_cols and idx_type == old_idx.get("type", ""):
                    continue
                post_parts.append(f"ADD {idx_type} {_safe_ident(idx_name, db_type)} ({', '.join(_safe_ident(c, db_type) for c in idx_col_names)})")

            # 表属性
            opts = table_options
            if opts.get("engine") and (opts["engine"].lower() != existing_opts.get("engine", "")):
                post_parts.append(f"ENGINE={opts['engine']}")
            if opts.get("collation") and (opts["collation"].lower() != existing_opts.get("collation", "")):
                post_parts.append(f"COLLATE={opts['collation']}")
            if opts.get("comment") is not None and opts.get("comment", "") != existing_opts.get("comment", ""):
                cmt = opts['comment'].replace("'", "\\'")
                post_parts.append(f"COMMENT='{cmt}'")

            alter_parts = pre_parts + mid_parts + post_parts

            if alter_parts:
                sqls.append(f"ALTER TABLE {tbl} {', '.join(alter_parts)}")

        elif db_type == 'postgresql':
            columns = design.get("columns", [])
            for col in columns:
                name = _safe_ident(col["name"], db_type)
                col_type = col.get("col_type", col.get("data_type", "VARCHAR(255)"))
                nullable = " DROP NOT NULL" if col.get("nullable", True) else " SET NOT NULL"
                default = f" SET DEFAULT {col['default_val']}" if col.get("default_val") else " DROP DEFAULT"
                sqls.append(f"ALTER TABLE {tbl} ALTER COLUMN {name} TYPE {col_type}, ALTER COLUMN {name}{nullable}, ALTER COLUMN {name}{default}")

        else:
            engine.dispose()
            return {"ok": False, "msg": f"数据库类型 [{db_type}] 暂不支持表设计器"}

        if not sqls:
            engine.dispose()
            return {"ok": True, "msg": "无变更", "sqls": []}

        if execute:
            with engine.begin() as conn:
                for sql in sqls:
                    # ★ 每条 SQL 执行前检查取消标记
                    if _query_cancel.is_set():
                        engine.dispose()
                        return {"ok": False, "msg": "操作已取消，部分 SQL 可能已执行", "cancelled": True}
                    conn.execute(text(sql))
            engine.dispose()
            return {"ok": True, "msg": f"表 [{table_name}] 设计已更新"}
        else:
            engine.dispose()
            return {"ok": True, "msg": f"共 {len(sqls)} 条变更", "sqls": sqls, "preview": True}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, db_type or 'mysql')}


@eel.expose
def table_truncate(conn_data, database, table_name, schema=''):
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') not in ('postgresql', 'oracle'): cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        sql = f"TRUNCATE TABLE {tbl}"
        with engine.begin() as conn: conn.execute(text(sql))
        engine.dispose()
        _log_db_delete(sql)
        return {"ok": True, "msg": f"表 [{table_name}] 已截断"}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type','mysql'))}

@eel.expose
def table_delete(conn_data, database, table_name, schema=''):
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') not in ('postgresql', 'oracle'): cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        sql = f"DROP TABLE {tbl}"
        with engine.begin() as conn: conn.execute(text(sql))
        engine.dispose()
        _log_db_delete(sql)
        return {"ok": True, "msg": f"表 [{table_name}] 已删除"}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type','mysql'))}

@eel.expose
def table_clear(conn_data, database, table_name, schema=''):
    try:
        cdata = dict(conn_data)
        if cdata.get('db_type') not in ('postgresql', 'oracle'): cdata["db"] = database
        tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(cdata.get("db_type","mysql"), timeout=10))
        sql = f"DELETE FROM {tbl}"
        with engine.begin() as conn: conn.execute(text(sql))
        engine.dispose()
        _log_db_delete(sql)
        return {"ok": True, "msg": f"表 [{table_name}] 已清空"}
    except Exception as e: return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type','mysql'))}


@eel.expose
def table_rename(conn_data, database, old_name, new_name, schema=''):
    """重命名表"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type not in ('postgresql', 'oracle'):
            cdata["db"] = database
        old_tbl = _build_table_ref(cdata, database, old_name, schema)
        new_tbl = _build_table_ref(cdata, database, new_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=10))
        if db_type == 'mssql':
            sql = f"EXEC sp_rename '{old_tbl}', '{new_name}'"
        elif db_type in ('mysql', 'ob-mysql'):
            sql = f"RENAME TABLE `{database}`.`{old_name}` TO `{database}`.`{new_name}`"
        elif db_type == 'postgresql':
            q = schema if schema else database
            sql = f'ALTER TABLE "{q}"."{old_name}" RENAME TO "{new_name}"'
        elif db_type == 'oracle':
            sql = f'ALTER TABLE "{database}"."{old_name}" RENAME TO "{new_name}"'
        else:
            sql = f"RENAME TABLE `{database}`.`{old_name}` TO `{database}`.`{new_name}`"
        with engine.begin() as conn:
            conn.execute(text(sql))
        engine.dispose()
        _db_op_logger.info(f"[RENAME] {old_tbl} → {new_tbl}")
        return {"ok": True, "msg": f"表 [{old_name}] 已重命名为 [{new_name}]"}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}


@eel.expose
def table_backup(conn_data, database, table_name, schema=''):
    """备份表：创建结构+数据相同的副本，表名=当前日期(MMDD_HH)，重名追加_1"""
    try:
        cdata = dict(conn_data)
        db_type = cdata.get('db_type', 'mysql')
        if db_type not in ('postgresql', 'oracle'):
            cdata["db"] = database
        src_tbl = _build_table_ref(cdata, database, table_name, schema)
        engine = create_engine(_conn_url(cdata), connect_args=_connect_args(db_type, timeout=30))

        # 生成备份表名: MMDD_HH
        base_name = dt.now().strftime("%m%d_%H")
        backup_name = base_name
        # 检测重名，追加 _1, _2 ...
        existing = set()
        try:
            insp = inspect(engine)
            schema_name = schema if db_type == 'postgresql' else (database if db_type == 'oracle' else None)
            args = [schema_name] if schema_name else []
            existing = set(insp.get_table_names(*args))
        except Exception:
            pass
        suffix = 0
        orig_backup = backup_name
        while backup_name in existing:
            suffix += 1
            backup_name = f"{orig_backup}_{suffix}"
        dst_tbl = _build_table_ref(cdata, database, backup_name, schema)

        with engine.begin() as conn:
            if db_type in ('mysql', 'ob-mysql'):
                conn.execute(text(f"CREATE TABLE `{database}`.`{backup_name}` LIKE `{database}`.`{table_name}`"))
                conn.execute(text(f"INSERT INTO `{database}`.`{backup_name}` SELECT * FROM `{database}`.`{table_name}`"))
            elif db_type == 'postgresql':
                q = schema if schema else database
                conn.execute(text(f'CREATE TABLE "{q}"."{backup_name}" (LIKE "{q}"."{table_name}" INCLUDING ALL)'))
                conn.execute(text(f'INSERT INTO "{q}"."{backup_name}" SELECT * FROM "{q}"."{table_name}"'))
            elif db_type == 'oracle':
                conn.execute(text(f'CREATE TABLE "{database}"."{backup_name}" AS SELECT * FROM "{database}"."{table_name}"'))
            elif db_type == 'mssql':
                conn.execute(text(f"SELECT * INTO [{database}].[{backup_name}] FROM [{database}].[{table_name}]"))
            else:
                conn.execute(text(f"CREATE TABLE `{database}`.`{backup_name}` LIKE `{database}`.`{table_name}`"))
                conn.execute(text(f"INSERT INTO `{database}`.`{backup_name}` SELECT * FROM `{database}`.`{table_name}`"))
        engine.dispose()
        _db_op_logger.info(f"[BACKUP] {src_tbl} → {dst_tbl}")
        return {"ok": True, "msg": f"表 [{table_name}] 已备份为 [{backup_name}]"}
    except Exception as e:
        return {"ok": False, "msg": _friendly_error(e, conn_data.get('db_type', 'mysql'))}
