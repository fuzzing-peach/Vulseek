import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from research_mutations import (
    ENTITY_SPECS,
    build_insert_statement,
    build_update_statement,
    validate_patch,
)


class ResearchMutationContractTests(unittest.TestCase):
    def test_all_entities_have_explicit_table_and_revision(self):
        self.assertEqual(set(ENTITY_SPECS), {"track", "finding", "primitive", "chain"})
        for spec in ENTITY_SPECS.values():
            self.assertTrue(spec.table)
            self.assertIn("revision", spec.columns)
            self.assertTrue(spec.mutable)

    def test_update_values_are_parameters_not_sql_text(self):
        statement, params = build_update_statement(
            ENTITY_SPECS["track"],
            scan_job_id="job-a",
            entity_id="track-a",
            expected_revision=3,
            patch={"status": "active", "nextStep": "inspect callback"},
        )

        self.assertIn('"revision" = "revision" + 1', statement)
        self.assertIn("%s", statement)
        self.assertNotIn("active", statement)
        self.assertNotIn("inspect callback", statement)
        self.assertIn("active", params)
        self.assertIn("inspect callback", params)

    def test_insert_statement_uses_allowlisted_columns(self):
        statement, params = build_insert_statement(
            ENTITY_SPECS["finding"],
            {"scanJobId": "job-a", "findingId": "finding-a", "status": "discovered"},
        )

        self.assertIn('"research_findings"', statement)
        self.assertIn('"scanJobId"', statement)
        self.assertNotIn("finding-a", statement)
        self.assertEqual(params, ["finding-a", "job-a", "discovered"])

    def test_unknown_patch_field_is_rejected(self):
        with self.assertRaises(ValueError):
            validate_patch(ENTITY_SPECS["track"], {"doesNotExist": "value"})

    def test_json_fields_are_serializable_without_interpolating_sql(self):
        statement, params = build_insert_statement(
            ENTITY_SPECS["chain"],
            {
                "scanJobId": "job-a",
                "chainId": "chain-a",
                "chainKey": "chain-key",
                "steps": [{"primitiveId": "p1"}],
            },
        )

        self.assertNotIn(json.dumps([{"primitiveId": "p1"}]), statement)
        self.assertEqual(params[-1], [{"primitiveId": "p1"}])


if __name__ == "__main__":
    unittest.main()
