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


if __name__ == "__main__":
    unittest.main()
