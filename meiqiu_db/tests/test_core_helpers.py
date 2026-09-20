import unittest
from unittest.mock import patch

import db_transfer_eel as db


class CoreHelperTests(unittest.TestCase):
    def test_sql_splitter_handles_dialects(self):
        statements = db._split_sql_statements(
            """DELIMITER $$
            CREATE PROCEDURE p() BEGIN SELECT 1; END$$
            DELIMITER ;
            SELECT $$a;b$$;
            GO
            SELECT 2;
            """
        )
        self.assertEqual(len(statements), 3)
        self.assertIn("SELECT 1;", statements[0])
        self.assertIn("SELECT $$a;b$$", statements[1])
        self.assertEqual(statements[2], "SELECT 2")

    def test_identifier_quoting(self):
        self.assertEqual(db._safe_ident("a]b", "mssql"), "[a]]b]")
        self.assertEqual(db._safe_ident("a`b", "mysql"), "`a``b`")

    def test_design_validation_and_safe_rename_inference(self):
        db._validate_design_payload({
            "columns": [{"name": "new_id", "col_type": "INT"}],
            "indexes": [],
        })
        self.assertEqual(
            db._infer_column_renames(["id", "name"], [
                {"name": "new_id"}, {"name": "name"}
            ]),
            {"new_id": "id"},
        )
        with self.assertRaises(ValueError):
            db._validate_design_payload({"columns": [], "indexes": []})

    def test_dml_string_escaping_uses_database_dialect(self):
        self.assertEqual(db._escape_str_val("O'Brien", "mysql"), "'O\\'Brien'")
        self.assertEqual(db._escape_str_val("O'Brien", "postgresql"), "'O''Brien'")

    def test_insert_sql_omits_defaults_and_validates_required_columns(self):
        columns = ["id", "name", "note"]
        metadata = [
            {"name": "id", "col_type": "INT", "nullable": False, "default_val": None, "auto_increment": True},
            {"name": "name", "col_type": "VARCHAR(20)", "nullable": False, "default_val": None, "auto_increment": False},
            {"name": "note", "col_type": "TEXT", "nullable": True, "default_val": None, "auto_increment": False},
        ]
        sql = db._build_insert_sql("`demo`.`users`", "mysql", columns, ["", "Alice", ""], metadata)
        self.assertEqual(sql, "INSERT INTO `demo`.`users` (`name`) VALUES ('Alice')")
        with self.assertRaisesRegex(ValueError, "name.*不能为空"):
            db._build_insert_sql("`demo`.`users`", "mysql", columns, ["", "", ""], metadata)

    def test_insert_sql_uses_default_values_for_non_mysql(self):
        metadata = [{"name": "id", "col_type": "INTEGER", "nullable": False,
                     "default_val": "nextval", "auto_increment": False}]
        self.assertEqual(
            db._build_insert_sql('"public"."t"', "postgresql", ["id"], [""], metadata),
            'INSERT INTO "public"."t" DEFAULT VALUES',
        )

    def test_default_formatting_preserves_empty_string(self):
        self.assertEqual(db._format_migrated_default("", "VARCHAR(20)"), "''")
        self.assertEqual(db._format_migrated_default("CURRENT_TIMESTAMP", "DATETIME"), "CURRENT_TIMESTAMP")

    def test_mssql_ddl_contains_identity_and_idempotent_comments(self):
        ddl = db._generate_create_table(
            "mssql",
            "[dbo].[orders]",
            [{
                "name": "id",
                "type": "int",
                "nullable": False,
                "default": None,
                "auto_increment": True,
                "comment": "编号",
            }],
            {"primary_key": ["id"], "unique": [], "indexes": []},
            {"table_name": "orders", "schema": "dbo", "comment": "订单"},
        )
        self.assertIn("IDENTITY(1,1)", ddl)
        self.assertIn("sp_updateextendedproperty", ddl)
        self.assertIn("sp_addextendedproperty", ddl)
        self.assertNotIn("/*", ddl)
        comment_batches = [part for part in db._split_sql_statements(ddl) if "IF EXISTS" in part]
        self.assertEqual(len(comment_batches), 2)
        self.assertTrue(all("ELSE" in part for part in comment_batches))

    def test_progress_guard_releases_after_call(self):
        calls = []

        @db._progress_guard("test")
        def guarded():
            calls.append(True)
            return {"ok": True}

        self.assertEqual(guarded(), {"ok": True})
        self.assertEqual(guarded(), {"ok": True})
        self.assertEqual(len(calls), 2)

    def test_progress_queue_drops_oldest_when_ui_is_not_polling(self):
        progress = db._DroppingProgressQueue(maxsize=2)
        progress.put("first")
        progress.put("second")
        progress.put("latest")
        self.assertEqual(progress.qsize(), 2)
        self.assertEqual(progress.get_nowait(), "second")
        self.assertEqual(progress.get_nowait(), "latest")

    def test_long_running_sql_uses_ddl_timeout_classification(self):
        self.assertTrue(db._is_long_running_sql(
            "/* add index */ ALTER TABLE day_k_line "
            "ADD INDEX idx_stock_market_day (securitycode, marketcode, day)"
        ))
        self.assertTrue(db._is_long_running_sql("CREATE INDEX idx_a ON t (a)"))
        self.assertFalse(db._is_long_running_sql("SELECT * FROM day_k_line"))

    def test_mysql_read_timeout_is_replaced_not_duplicated(self):
        url = "mysql+mysqldb://u:p@127.0.0.1/db?charset=utf8mb4&read_timeout=120"
        updated = db._set_mysql_read_timeout(url, db._MYSQL_DDL_READ_TIMEOUT)
        self.assertEqual(updated.count("read_timeout="), 1)
        self.assertIn("read_timeout=86400", updated)

    def test_mysql_user_sql_escapes_percent_for_mysqldb(self):
        class FakeConnection:
            def exec_driver_sql(self, sql, params=None):
                self.sql = sql
                self.params = params
                return sql

        conn = FakeConnection()
        db._mysql_user_exec(conn, "SHOW GRANTS FOR 'hquser'@'%'")
        self.assertEqual(conn.sql, "SHOW GRANTS FOR 'hquser'@'%%'")
        self.assertEqual(conn.sql % conn.params, "SHOW GRANTS FOR 'hquser'@'%'")
        self.assertEqual(conn.params, ())

    def test_mysql_user_privilege_reset_uses_valid_revoke_statements(self):
        class FakeResult:
            returns_rows = False
            rowcount = 0

        class FakeConnection:
            def __init__(self):
                self.calls = []

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def exec_driver_sql(self, sql, params=None):
                self.calls.append((sql, params))
                return FakeResult()

        class FakeEngine:
            def __init__(self, connection):
                self.connection = connection

            def begin(self):
                return self.connection

            def dispose(self):
                pass

        conn = FakeConnection()
        engine = FakeEngine(conn)
        with patch.object(db, '_mysql_user_engine', return_value=engine):
            result = db.mysql_user_apply_privileges(
                {'db_type': 'mysql', 'host': '127.0.0.1', 'user': 'root'},
                'zx', '%', '*', '*', ['SELECT'], False,
            )
        self.assertTrue(result['ok'])
        self.assertEqual(conn.calls[0], ("REVOKE ALL PRIVILEGES ON *.* FROM 'zx'@'%%'", ()))
        self.assertEqual(conn.calls[1], ("REVOKE GRANT OPTION ON *.* FROM 'zx'@'%%'", ()))
        self.assertEqual(conn.calls[2], ("GRANT SELECT ON *.* TO 'zx'@'%%'", ()))

    def test_mysql_user_privilege_reset_ignores_missing_scope_grants(self):
        class FakeResult:
            returns_rows = False
            rowcount = 0

        class FakeConnection:
            def __init__(self):
                self.calls = []

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def exec_driver_sql(self, sql, params=None):
                self.calls.append((sql, params))
                if len(self.calls) <= 2:
                    raise Exception(1141, 'There is no such grant defined')
                return FakeResult()

        class FakeEngine:
            def __init__(self, connection):
                self.connection = connection

            def begin(self):
                return self.connection

            def dispose(self):
                pass

        conn = FakeConnection()
        with patch.object(db, '_mysql_user_engine', return_value=FakeEngine(conn)):
            result = db.mysql_user_apply_privileges(
                {'db_type': 'mysql', 'host': '127.0.0.1', 'user': 'root'},
                'zx', '%', 'wst_info', '*', ['SELECT'], False,
            )
        self.assertTrue(result['ok'])
        self.assertEqual(len(conn.calls), 3)
        self.assertIn('GRANT SELECT ON `wst_info`.*', conn.calls[2][0])

    def test_connection_key_supports_src_fields(self):
        key = db._make_conn_key({
            "src_host": "127.0.0.1", "src_port": 3306,
            "src_user": "root", "src_db": "market", "db_type": "mysql",
        })
        self.assertEqual(key, "mysql:127.0.0.1:3306:root:market")


if __name__ == "__main__":
    unittest.main()
