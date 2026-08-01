import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import uuid


ROOT = pathlib.Path(__file__).resolve().parents[1]
CLI = ROOT / "research_db.py"
INTEGRATION_ENABLED = (
    os.environ.get("VULSEEK_RESEARCH_DB_INTEGRATION") == "1"
    and bool(os.environ.get("VULSEEK_RESEARCH_DATABASE_URL"))
    and bool(os.environ.get("VULSEEK_RESEARCH_DB_TEST_JOB_ID"))
    and bool(os.environ.get("VULSEEK_RESEARCH_DB_TEST_PRODUCER_TASK_ID"))
)


@unittest.skipUnless(
    INTEGRATION_ENABLED,
    "set integration=1, a dev database URL, Job ID, and producer task ID",
)
class ResearchDbIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.suffix = uuid.uuid4().hex[:12]
        self.track_id = "db-test-track-{}".format(self.suffix)
        self.track_key = "db-test-track-key-{}".format(self.suffix)
        self.finding_id = "{}:root-cause".format(self.track_key)
        self.primitive_id = "db-test-primitive-{}".format(self.suffix)
        self.chain_id = "db-test-chain-{}".format(self.suffix)
        self.env = dict(os.environ)
        self.env["VULSEEK_SCAN_JOB_ID"] = os.environ["VULSEEK_RESEARCH_DB_TEST_JOB_ID"]
        self.env["VULSEEK_TASK_ID"] = "db-test-task-{}".format(self.suffix)
        self.producer_task_id = os.environ["VULSEEK_RESEARCH_DB_TEST_PRODUCER_TASK_ID"]

    def run_cli(self, *args, expected=None, env=None):
        result = subprocess.run(
            [sys.executable, str(CLI), *args],
            env=env or self.env,
            text=True,
            capture_output=True,
            check=False,
        )
        if expected is not None:
            self.assertEqual(result.returncode, expected, result.stderr)
        payload = None
        if result.stdout.strip():
            payload = json.loads(result.stdout)
        return result, payload

    def tearDown(self):
        for entity, entity_id in [
            ("chain", self.chain_id),
            ("primitive", self.primitive_id),
            ("finding", self.finding_id),
            ("track", self.track_id),
        ]:
            current = self.run_cli("get-{}".format(entity), "--{}-id".format(entity), entity_id)[1]
            if current and current.get("entity"):
                self.run_cli(
                    "delete-{}".format(entity),
                    "--{}-id".format(entity),
                    entity_id,
                    "--expected-revision",
                    str(current["entity"]["revision"]),
                )

    def test_all_entities_and_revision_conflict_contract(self):
        with tempfile.TemporaryDirectory(prefix="research-db-integration-") as directory:
            content_path = pathlib.Path(directory) / "finding.json"
            content_path.write_text(
                json.dumps(
                    {
                        "findingId": self.finding_id,
                        "trackKey": self.track_key,
                        "title": "Integration finding",
                        "rootCauseKey": "root-cause",
                    }
                ),
                encoding="utf-8",
            )
            self.run_cli(
                "create-track",
                "--track-id",
                self.track_id,
                "--track-key",
                self.track_key,
                "--approach-family",
                "input-parsing",
                "--research-idea",
                "integration fixture",
                expected=0,
            )
            duplicate = self.run_cli(
                "create-track",
                "--track-id",
                self.track_id,
                "--track-key",
                self.track_key,
                "--approach-family",
                "input-parsing",
                "--research-idea",
                "integration fixture",
                expected=0,
            )[1]
            self.assertEqual(duplicate["status"], "alreadyExists")

            self.run_cli(
                "create-finding",
                "--finding-id",
                self.finding_id,
                "--track-id",
                self.track_id,
                "--content-file",
                str(content_path),
                "--producer-task-id",
                self.producer_task_id,
                expected=0,
            )
            self.run_cli(
                "create-primitive",
                "--primitive-id",
                self.primitive_id,
                "--finding-id",
                self.finding_id,
                "--name",
                "controlled input",
                "--capability",
                "route selection",
                "--trust-level",
                "untrusted",
                expected=0,
            )
            self.run_cli(
                "create-chain",
                "--chain-id",
                self.chain_id,
                "--chain-key",
                "chain-{}".format(self.suffix),
                expected=0,
            )

            updated = self.run_cli(
                "update-track",
                "--track-id",
                self.track_id,
                "--expected-revision",
                "0",
                "--status",
                "active",
                expected=0,
            )[1]
            self.assertEqual(updated["revision"], 1)
            already = self.run_cli(
                "update-track",
                "--track-id",
                self.track_id,
                "--expected-revision",
                "1",
                "--status",
                "active",
                expected=0,
            )[1]
            self.assertEqual(already["status"], "alreadyApplied")

            _, conflict = self.run_cli(
                "update-track",
                "--track-id",
                self.track_id,
                "--expected-revision",
                "0",
                "--status",
                "blocked",
                expected=3,
            )
            self.assertEqual(conflict["status"], "conflict")
            self.assertEqual(conflict["currentRevision"], 1)

    def test_same_revision_updates_are_cas_serialized(self):
        self.run_cli(
            "create-track",
            "--track-id",
            self.track_id,
            "--track-key",
            self.track_key,
            "--approach-family",
            "concurrency",
            "--research-idea",
            "CAS fixture",
            expected=0,
        )
        children = []
        for index in range(4):
            child_env = dict(self.env)
            child_env["VULSEEK_TASK_ID"] = "db-test-concurrent-{}-{}".format(self.suffix, index)
            children.append(
                subprocess.Popen(
                    [
                        sys.executable,
                        str(CLI),
                        "update-track",
                        "--track-id",
                        self.track_id,
                        "--expected-revision",
                        "0",
                        "--next-step",
                        "worker-{}".format(index),
                    ],
                    env=child_env,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            )
        results = []
        for child in children:
            stdout, stderr = child.communicate(timeout=20)
            results.append((child.returncode, stdout, stderr))
        for index, (returncode, stdout, stderr) in enumerate(results):
            self.assertTrue(
                stdout.strip(),
                "worker {} returned {} without JSON: {}".format(index, returncode, stderr),
            )
        statuses = [json.loads(stdout)["status"] for _, stdout, _ in results]
        self.assertEqual(statuses.count("updated"), 1)
        self.assertEqual(statuses.count("conflict"), 3)


if __name__ == "__main__":
    unittest.main()
