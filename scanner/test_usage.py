"""Tests for usage.py with fake transcripts. Run: python -I -B scanner/test_usage.py"""
import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage as U  # noqa: E402

A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"


def iso(day_offset=0, hour=12):
    t = dt.datetime.now().astimezone().replace(hour=hour, minute=0, second=0, microsecond=0) - dt.timedelta(days=day_offset)
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"), t.timestamp()


def line(mid, sid, ts, cwd, model="claude-opus-5-5", i=10, cw=100, cr=1000, o=50, ep="cli", req=None):
    return json.dumps({
        "type": "assistant", "sessionId": sid, "timestamp": ts, "cwd": cwd, "entrypoint": ep,
        "requestId": req or ("req_" + mid),
        "message": {"id": mid, "model": model, "role": "assistant",
                    "usage": {"input_tokens": i, "cache_creation_input_tokens": cw,
                              "cache_read_input_tokens": cr, "output_tokens": o}},
    })


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.home = os.path.join(self.tmp, "home")
        self.claude = os.path.join(self.home, ".claude")
        self.proj = os.path.join(self.claude, "projects", "p1")
        self.data = os.path.join(self.claude, "cc-usage-panel")
        os.makedirs(self.proj)
        env = {k: v for k, v in os.environ.items()
               if k not in ("APPDATA", "LOCALAPPDATA", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_USER_EMAIL")}
        self.env = mock.patch.dict(os.environ, env, clear=True)
        self.env.start()
        self.patches = [mock.patch.object(U, "HOME", self.home), mock.patch.object(U, "DATA_DIR", self.data)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, lines):
        with open(os.path.join(self.proj, name), "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

    def login(self, uuid, email):
        with open(os.path.join(self.home, ".claude.json"), "w", encoding="utf-8") as fh:
            json.dump({"oauthAccount": {"accountUuid": uuid, "emailAddress": email}}, fh)

    def cfg(self, **kw):
        c = dict(U.DEFAULT_CONFIG)
        c.update(kw)
        return c

    def by_account(self, rows):
        out = {}
        for r in rows:
            out[r[3]] = out.get(r[3], 0) + r[8]
        return out


class TestScan(Base):
    def test_dedupe_within_and_across_files(self):
        ts, _ = iso()
        same = line("m1", "s1", ts, "/w/app")
        self.write("a.jsonl", [same, same, line("m2", "s1", ts, "/w/app")])
        self.write("b.jsonl", [same])  # 续接的会话抄进新文件
        rows, info = U.collect(self.cfg(), self.data)
        self.assertEqual(sum(r[8] for r in rows), 2)

    def test_project_roots_and_scratch(self):
        ts, _ = iso()
        self.write("a.jsonl", [line("m1", "s1", ts, "/w/app/src"), line("m2", "s1", ts, "/x/scratch-workspaces/" + A + "/o/s")])
        rows, _ = U.collect(self.cfg(project_roots=["/w"]), self.data)
        self.assertEqual(sorted({r[1] for r in rows}), sorted(["app", U.SCRATCH]))

    def test_cache_reused_and_invalidated(self):
        ts, _ = iso()
        self.write("a.jsonl", [line("m1", "s1", ts, "/w/app")])
        _, info1 = U.collect(self.cfg(), self.data)
        _, info2 = U.collect(self.cfg(), self.data)
        self.assertEqual(info1["rescanned"], 1)
        self.assertEqual(info2["rescanned"], 0)
        self.write("a.jsonl", [line("m1", "s1", ts, "/w/app"), line("m2", "s1", ts, "/w/app")])
        rows, info3 = U.collect(self.cfg(), self.data)
        self.assertEqual(info3["rescanned"], 1)
        self.assertEqual(sum(r[8] for r in rows), 2)

    def test_synthetic_skipped(self):
        ts, _ = iso()
        self.write("a.jsonl", [line("m1", "s1", ts, "/w", model="<synthetic>")])
        rows, _ = U.collect(self.cfg(), self.data)
        self.assertEqual(rows, [])


class TestAccounts(Base):
    def test_single_account_gets_everything(self):
        self.login(A, "solo@example.com")
        ts, _ = iso()
        self.write("a.jsonl", [line("m1", "s1", ts, "/w"), line("m2", "s2", ts, "/w")])
        rows, info = U.collect(self.cfg(), self.data)
        self.assertEqual(info["accounts"], ["solo"])

    def test_single_account_fallback_off(self):
        self.login(A, "solo@example.com")
        ts, _ = iso()
        self.write("a.jsonl", [line("m1", "s1", ts, "/w")])
        rows, info = U.collect(self.cfg(single_account_fallback=False), self.data)
        self.assertEqual(info["accounts"], [U.UNTAGGED])

    def test_tags_and_mid_session_switch(self):
        self.login(B, "b@example.com")
        ts1, t1 = iso(hour=9)
        ts2, t2 = iso(hour=15)
        os.makedirs(self.data)
        with open(U.tag_log_path(self.data), "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"sid": "s1", "t": t1 - 60, "uuid": A, "email": "a@example.com"}) + "\n")
            fh.write(json.dumps({"sid": "s1", "t": t2 - 60, "uuid": B, "email": "b@example.com"}) + "\n")
        self.write("a.jsonl", [line("m1", "s1", ts1, "/w"), line("m2", "s1", ts2, "/w"), line("m3", "s9", ts2, "/w")])
        rows, info = U.collect(self.cfg(), self.data)
        acc = self.by_account(rows)
        self.assertEqual(acc, {"a": 1, "b": 1, U.UNTAGGED: 1})

    def test_desktop_dirs_and_names(self):
        ts, _ = iso()
        desk = os.path.join(self.tmp, "Claude")
        for acct, sid in ((A, "s1"), (B, "s2")):
            d = os.path.join(desk, "claude-code-sessions", acct, "org")
            os.makedirs(d)
            with open(os.path.join(d, "local_%s.json" % sid), "w", encoding="utf-8") as fh:
                json.dump({"cliSessionId": sid}, fh)
        self.write("a.jsonl", [line("m1", "s1", ts, "/w", ep="claude-desktop"), line("m2", "s2", ts, "/w", ep="claude-desktop")])
        rows, _ = U.collect(self.cfg(desktop_dirs=[desk], account_names={A: "work", B: "home"}), self.data)
        self.assertEqual(self.by_account(rows), {"work": 1, "home": 1})

    def test_config_dir_session_env(self):
        ts, _ = iso()
        other = os.path.join(self.tmp, "other-home")
        os.makedirs(os.path.join(other, "session-env", "s7"))
        self.login(B, "b@example.com")
        self.write("a.jsonl", [line("m1", "s7", ts, "/w"), line("m2", "s8", ts, "/w")])
        rows, _ = U.collect(self.cfg(config_dirs={other: "pinned"}, single_account_fallback=False), self.data)
        self.assertEqual(self.by_account(rows), {"pinned": 1, U.UNTAGGED: 1})

    def test_cli_switch_marker(self):
        self.login(B, "b@example.com")
        marker = os.path.join(self.tmp, "switched.json")
        with open(marker, "w") as fh:
            fh.write("{}")
        old_ts, old_t = iso(day_offset=3)
        new_ts, _ = iso(day_offset=0)
        os.utime(marker, (old_t + 3600, old_t + 3600))
        desk = os.path.join(self.tmp, "Claude")
        d = os.path.join(desk, "claude-code-sessions", A, "org")
        os.makedirs(d)
        with open(os.path.join(d, "local_x.json"), "w", encoding="utf-8") as fh:
            json.dump({"cliSessionId": "sd"}, fh)
        self.write("a.jsonl", [line("m1", "s1", old_ts, "/w"), line("m2", "s2", new_ts, "/w"),
                               line("m3", "s3", new_ts, "/w", ep="claude-desktop")])
        rows, _ = U.collect(self.cfg(desktop_dirs=[desk], cli_switch_marker_glob=marker), self.data)
        self.assertEqual(self.by_account(rows), {U.UNTAGGED: 2, "b": 1})

    def test_tag_command_records_cli_account(self):
        self.login(A, "a@example.com")
        U.main(["tag", "--session", "s5"])
        with open(U.tag_log_path(self.data), encoding="utf-8") as fh:
            rec = json.loads(fh.readline())
        self.assertEqual((rec["sid"], rec["uuid"], rec["src"]), ("s5", A, "cli"))

    def test_tag_command_desktop_env(self):
        with mock.patch.dict(os.environ, {"CLAUDE_CODE_ACCOUNT_UUID": B, "CLAUDE_CODE_USER_EMAIL": "b@example.com"}):
            U.main(["tag", "--session", "s6"])
        with open(U.tag_log_path(self.data), encoding="utf-8") as fh:
            rec = json.loads(fh.readline())
        self.assertEqual((rec["uuid"], rec["src"]), (B, "desktop"))

    def test_tag_never_raises(self):
        U.main(["tag"])  # 没有会话 id：什么都不做
        self.assertFalse(os.path.exists(U.tag_log_path(self.data)))


class TestOutputs(Base):
    def test_json_payload_and_last(self):
        self.login(A, "a@example.com")
        ts, _ = iso()
        self.write("a.jsonl", [line("m1", "s1", ts, "/w")])
        U.main(["json"])
        with open(os.path.join(self.data, "last.json"), encoding="utf-8") as fh:
            data = json.load(fh)
        self.assertEqual(data["today"], dt.date.today().isoformat())
        self.assertEqual(len(data["rows"][0]), 9)
        self.assertEqual(data["weights"], U.WEIGHTS)

    def test_report_inlines_compute(self):
        ts, _ = iso()
        self.write("a.jsonl", [line("m1", "s1", ts, "/w")])
        U.main(["report", "--no-open"])
        with open(os.path.join(self.data, "report.html"), encoding="utf-8") as fh:
            html = fh.read()
        self.assertNotIn("/*__COMPUTE__*/", html)
        self.assertNotIn("/*__DATA__*/", html)
        self.assertIn("function compute(", html)
        self.assertNotIn("export function", html)


if __name__ == "__main__":
    unittest.main(verbosity=1)
