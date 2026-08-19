import unittest

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

    def test_connection_key_supports_src_fields(self):
        key = db._make_conn_key({
            "src_host": "127.0.0.1", "src_port": 3306,
            "src_user": "root", "src_db": "market", "db_type": "mysql",
        })
        self.assertEqual(key, "mysql:127.0.0.1:3306:root:market")


if __name__ == "__main__":
    unittest.main()
