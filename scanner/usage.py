#!/usr/bin/env python3
"""cc-usage-panel scanner: reads Claude Code session transcripts and counts tokens per day.

Subcommands
  json [--cached]        detail rows for the panel (and writes last.json)
  report [--no-open]     HTML report (same algorithm as the panel: shared/compute.js)
  text [--days N]        bar chart in the terminal
  tag --session ID       remember which account a session runs on (the plugin calls this at session start)
  self-update            update the plugin through the Claude Code CLI
  where                  print the folders it reads and writes

Only the standard library; Python 3.8+. Reads local files only; never reads tokens.
Data folder: ~/.claude/cc-usage-panel (override with CC_USAGE_PANEL_DIR).
"""
import argparse
import bisect
import collections
import datetime as dt
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

VERSION = "1.0.0"
HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_DIR = os.environ.get("CC_USAGE_PANEL_DIR") or os.path.join(HOME, ".claude", "cc-usage-panel")
CACHE_VER = 1
UNTAGGED = "未标记"
SCRATCH = "临时会话"
UUID_RE = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
UUID_IN_SCRATCH = re.compile(r"scratch-workspaces[\\/](" + UUID_RE + ")", re.I)
DESKTOP_EP = "claude-desktop"

# 等效 token：缓存读 ×0.1、缓存写 ×2、输出 ×5、普通输入 ×1（按 API 价目近似）
WEIGHTS = [1.0, 2.0, 0.1, 5.0]

DEFAULT_CONFIG = {
    "project_roots": [],            # 项目名取这些根目录下的第一层，否则取 cwd 最后一段
    "extra_projects_dirs": [],      # 额外的记录目录（...\projects）
    "desktop_dirs": [],             # 额外的桌面版数据目录（里面有 claude-code-sessions）
    "config_dirs": {},              # 其它 Claude 配置目录 -> 账号名，按它的 session-env 认会话
    "cli_switch_marker_glob": "",   # 这些文件最晚修改之后，终端会话都算现在登录的号
    "account_names": {},            # 账号 uuid 或邮箱 -> 显示名
    "single_account_fallback": True,  # 只见过一个号时，分不出的都算它
}


def expand(p):
    return os.path.normpath(os.path.expandvars(os.path.expanduser(p))) if p else p


def norm(p):
    return os.path.normcase(os.path.normpath(p)) if p else ""


def load_config(data_dir=None):
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(os.path.join(data_dir or DATA_DIR, "config.json"), encoding="utf-8-sig") as fh:
            user = json.load(fh)
        for k in DEFAULT_CONFIG:
            if k in user:
                cfg[k] = user[k]
    except (OSError, ValueError):
        pass
    return cfg


# ---------------------------------------------------------------- places

def config_homes():
    """Claude 配置目录：~/.claude，加上 CLAUDE_CONFIG_DIR（去重，按真实路径）。"""
    out, seen = [], set()
    for p in (os.environ.get("CLAUDE_CONFIG_DIR"), os.path.join(HOME, ".claude")):
        if p and os.path.isdir(p):
            r = norm(os.path.realpath(p))
            if r not in seen:
                seen.add(r)
                out.append(p)
    return out


def projects_dirs(cfg):
    out, seen = [], set()
    for p in [os.path.join(h, "projects") for h in config_homes()] + [expand(x) for x in cfg["extra_projects_dirs"]]:
        if p and os.path.isdir(p):
            r = norm(os.path.realpath(p))
            if r not in seen:
                seen.add(r)
                out.append(p)
    return out


def desktop_dirs(cfg):
    """桌面版的数据目录（里面有 claude-code-sessions）：各系统的默认位置 + 配置里加的。"""
    cands = [expand(x) for x in cfg["desktop_dirs"]]
    appdata, local = os.environ.get("APPDATA"), os.environ.get("LOCALAPPDATA")
    if appdata:
        cands.append(os.path.join(appdata, "Claude"))
    if local:
        cands += glob.glob(os.path.join(local, "Packages", "Claude_*", "LocalCache", "Roaming", "Claude"))
    cands.append(os.path.join(HOME, "Library", "Application Support", "Claude"))
    cands.append(os.path.join(HOME, ".config", "Claude"))
    out, seen = [], set()
    for p in cands:
        s = os.path.join(p, "claude-code-sessions")
        if os.path.isdir(s):
            r = norm(os.path.realpath(s))
            if r not in seen:
                seen.add(r)
                out.append(s)
    return out


# ---------------------------------------------------------------- naming

def project_name(cwd, roots):
    if not cwd:
        return "未知"
    p = cwd.replace("\\", "/").rstrip("/")
    if "scratch-workspaces" in p.lower():
        return SCRATCH
    low = p.lower()
    for root in roots:
        r = expand(root).replace("\\", "/").rstrip("/").lower()
        if r and low == r:
            return os.path.basename(p) or p
        if r and low.startswith(r + "/"):
            return p[len(r) + 1:].split("/")[0]
    return p.split("/")[-1] or p


def model_name(m):
    m = (m or "").lower()
    for k, v in (("opus", "Opus"), ("fable", "Fable"), ("sonnet", "Sonnet"), ("haiku", "Haiku")):
        if k in m:
            return v
    return "其他"


# ---------------------------------------------------------------- accounts

def read_oauth_account(path):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            a = json.load(fh).get("oauthAccount") or {}
        return a.get("accountUuid") or "", a.get("emailAddress") or ""
    except (OSError, ValueError, AttributeError):
        return "", ""


def current_cli_account():
    for h in config_homes():
        for f in (os.path.join(h, ".claude.json"), os.path.join(os.path.dirname(h), ".claude.json")):
            u, e = read_oauth_account(f)
            if u:
                return u, e
    return read_oauth_account(os.path.join(HOME, ".claude.json"))


def tag_log_path(data_dir=None):
    return os.path.join(data_dir or DATA_DIR, "session-accounts.jsonl")


def read_tags(data_dir=None):
    """{sid: ([t...], [who...])}，who 是 uuid 或 name:<名字>；另返回 uuid -> 邮箱。"""
    tags, emails = collections.defaultdict(list), {}
    try:
        with open(tag_log_path(data_dir), encoding="utf-8") as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                who = ("name:" + d["name"]) if d.get("name") else d.get("uuid")
                if d.get("sid") and who:
                    tags[d["sid"]].append((float(d.get("t") or 0), who))
                if d.get("uuid") and d.get("email"):
                    emails[d["uuid"]] = d["email"]
    except OSError:
        pass
    out = {}
    for sid, lst in tags.items():
        lst.sort()
        out[sid] = ([t for t, _ in lst], [w for _, w in lst])
    return out, emails


class Accounts:
    """认每一次调用属于哪个账号，按 README 里写的顺序。"""

    def __init__(self, cfg, data_dir=None):
        self.cfg = cfg
        self.tags, self.emails = read_tags(data_dir)
        self.cli_uuid, cli_email = current_cli_account()
        if self.cli_uuid and cli_email:
            self.emails.setdefault(self.cli_uuid, cli_email)
        self.desktop = {}
        for base in desktop_dirs(cfg):
            for f in glob.glob(os.path.join(base, "*", "*", "local_*.json")):
                acct = os.path.basename(os.path.dirname(os.path.dirname(f)))
                if not re.fullmatch(UUID_RE, acct, re.I):
                    continue
                try:
                    with open(f, encoding="utf-8-sig") as fh:
                        sid = json.load(fh).get("cliSessionId")
                except (OSError, ValueError, AttributeError):
                    continue
                if sid:
                    self.desktop[sid] = acct
        self.config_dir_sessions = {}
        for d, name in (cfg["config_dirs"] or {}).items():
            for s in glob.glob(os.path.join(expand(d), "session-env", "*")):
                self.config_dir_sessions[os.path.basename(s)] = "name:" + name
        self.cli_from = float("inf")
        if cfg["cli_switch_marker_glob"] and self.cli_uuid:
            times = []
            for f in glob.glob(expand(cfg["cli_switch_marker_glob"])):
                try:
                    times.append(os.stat(f).st_mtime)
                except OSError:
                    pass
            if times:
                self.cli_from = max(times)
        # 见过哪些号：只见过一个时，分不出的都算它
        known = set(self.desktop.values()) | {w for _, ws in self.tags.values() for w in ws}
        known |= set(self.config_dir_sessions.values())
        if self.cli_uuid:
            known.add(self.cli_uuid)
        self.known = {self.label(w) for w in known}
        self.only = next(iter(self.known)) if len(self.known) == 1 and cfg["single_account_fallback"] else None

    def label(self, who):
        if not who:
            return UNTAGGED
        if who.startswith("name:"):
            return who[5:]
        names = self.cfg["account_names"] or {}
        email = self.emails.get(who, "")
        for key in (who, email, email.lower()):
            if key and key in names:
                return names[key]
        if email:
            return email.split("@")[0]
        return "账号-" + who[:4]

    def __call__(self, sid, ts, scratch_uuid, ep):
        tg = self.tags.get(sid)
        if tg:
            i = bisect.bisect_right(tg[0], ts) - 1
            return self.label(tg[1][max(i, 0)])
        if sid in self.config_dir_sessions:
            return self.label(self.config_dir_sessions[sid])
        if sid in self.desktop:
            return self.label(self.desktop[sid])
        if scratch_uuid:
            return self.label(scratch_uuid)
        if ep != DESKTOP_EP and ts >= self.cli_from:
            return self.label(self.cli_uuid)
        return self.only or UNTAGGED


# ---------------------------------------------------------------- scanning

def scan_file(path, roots):
    """一份记录 -> [[key, date, project, model, sid, ts, scratch_uuid, entrypoint, in, cw, cr, out], ...]，文件内去重。"""
    recs, seen = [], set()
    try:
        fh = open(path, encoding="utf-8", errors="ignore")
    except OSError:
        return recs
    with fh:
        for line in fh:
            if '"usage"' not in line or '"assistant"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            m = d.get("message")
            if not isinstance(m, dict) or not isinstance(m.get("usage"), dict) or m.get("model") == "<synthetic>":
                continue
            # 同一次调用按内容块拆成多行，usage 重复：按消息 id + 请求 id 去重
            key = "%s|%s" % (m.get("id"), d.get("requestId"))
            if key in seen:
                continue
            seen.add(key)
            try:
                t = dt.datetime.fromisoformat(str(d.get("timestamp")).replace("Z", "+00:00")).astimezone()
            except ValueError:
                continue
            cwd = d.get("cwd") or ""
            su = UUID_IN_SCRATCH.search(cwd)
            u = m["usage"]
            recs.append([key, t.date().isoformat(), project_name(cwd, roots), model_name(m.get("model")),
                         d.get("sessionId") or "", round(t.timestamp(), 3), su.group(1).lower() if su else "",
                         d.get("entrypoint") or "",
                         u.get("input_tokens") or 0, u.get("cache_creation_input_tokens") or 0,
                         u.get("cache_read_input_tokens") or 0, u.get("output_tokens") or 0])
    return recs


def collect(cfg, data_dir=None):
    """返回 (rows, info)。rows: [[date, project, model, account, in, cw, cr, out, calls], ...]"""
    data_dir = data_dir or DATA_DIR
    cache_path = os.path.join(data_dir, "cache.json")
    sig_cfg = json.dumps(cfg["project_roots"], sort_keys=True)
    old = {}
    try:
        with open(cache_path, encoding="utf-8") as fh:
            c = json.load(fh)
        if c.get("ver") == CACHE_VER and c.get("roots") == sig_cfg:
            old = c["files"]
    except (OSError, ValueError, KeyError):
        pass
    new, files, rescanned = {}, [], 0
    for base in projects_dirs(cfg):
        files += glob.glob(os.path.join(base, "**", "*.jsonl"), recursive=True)
    for f in files:
        try:
            st = os.stat(f)
        except OSError:
            continue
        sig = [st.st_size, st.st_mtime_ns]
        hit = old.get(f)
        if hit and hit["sig"] == sig:
            new[f] = hit
        else:
            new[f] = {"sig": sig, "recs": scan_file(f, cfg["project_roots"])}
            rescanned += 1
    os.makedirs(data_dir, exist_ok=True)
    tmp = cache_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"ver": CACHE_VER, "roots": sig_cfg, "files": new}, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, cache_path)

    acct = Accounts(cfg, data_dir)
    seen = set()
    agg = collections.defaultdict(lambda: [0, 0, 0, 0, 0])
    for entry in new.values():
        for key, day, proj, model, sid, ts, su, ep, i, cw, cr, o in entry["recs"]:
            if key in seen:   # 续接的会话会把旧消息抄进新文件，跨文件再去重
                continue
            seen.add(key)
            r = agg[(day, proj, model, acct(sid, ts, su, ep))]
            r[0] += i; r[1] += cw; r[2] += cr; r[3] += o; r[4] += 1
    rows = [[d, p, mo, a] + r for (d, p, mo, a), r in sorted(agg.items())]
    info = {"files": len(files), "rescanned": rescanned, "first_scan": not old,
            "accounts": sorted({r[3] for r in rows}, key=lambda a: (a == UNTAGGED, a))}
    return rows, info


def payload(rows, info):
    today = dt.date.today().isoformat()
    return {
        "version": VERSION,
        "generated": dt.datetime.now().strftime("%H:%M"),
        "today": today,
        "since": rows[0][0] if rows else today,
        "weights": WEIGHTS,
        "accounts": info["accounts"],
        "files": info["files"],
        "rows": rows,
    }


# ---------------------------------------------------------------- outputs

def effective(r):
    return r[4] * WEIGHTS[0] + r[5] * WEIGHTS[1] + r[6] * WEIGHTS[2] + r[7] * WEIGHTS[3]


def fmt(n):
    if n >= 1e9:
        return "%.2fB" % (n / 1e9)
    if n >= 1e6:
        return "%.1fM" % (n / 1e6)
    if n >= 1e3:
        return "%dk" % round(n / 1e3)
    return str(int(n))


def write_last(data, data_dir=None):
    path = os.path.join(data_dir or DATA_DIR, "last.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def cmd_json(args):
    if args.cached:
        try:
            with open(os.path.join(DATA_DIR, "last.json"), encoding="utf-8") as fh:
                sys.stdout.write(fh.read())
            return 0
        except OSError:
            pass
    cfg = load_config()
    rows, info = collect(cfg)
    data = payload(rows, info)
    write_last(data)
    sys.stdout.write(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    return 0


def cmd_text(args):
    rows, info = collect(load_config())
    days = [(dt.date.today() - dt.timedelta(days=i)).isoformat() for i in range(args.days - 1, -1, -1)]
    per = {d: collections.defaultdict(float) for d in days}
    for r in rows:
        if r[0] in per:
            per[r[0]][r[3]] += effective(r)
    tot = {d: sum(per[d].values()) for d in days}
    mx = max(tot.values()) or 1
    print("Claude Code daily usage (effective tokens, last %d days)" % args.days)
    for d in days:
        parts = "  ".join("%s %s" % (a, fmt(v)) for a, v in sorted(per[d].items(), key=lambda x: -x[1]))
        bar = "#" * max(1, round(30 * tot[d] / mx)) if tot[d] else ""
        print("%s  %7s  %-30s  %s" % (d[5:], fmt(tot[d]), bar, parts))
    return 0


def cmd_report(args):
    cfg = load_config()
    rows, info = collect(cfg)
    data = payload(rows, info)
    write_last(data)
    with open(os.path.join(HERE, "report.html"), encoding="utf-8") as fh:
        html = fh.read()
    with open(os.path.join(ROOT, "shared", "compute.js"), encoding="utf-8") as fh:
        compute = re.sub(r"^export\s+", "", fh.read(), flags=re.M)
    blob = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    html = html.replace("/*__COMPUTE__*/", compute.replace("</", "<\\/")).replace("/*__DATA__*/null", blob)
    out = os.path.join(DATA_DIR, "report.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    print(out)
    if not args.no_open:
        open_file(out)
    return 0


def open_file(path):
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except OSError:
        pass


def cmd_tag(args):
    """会话启动时记账号。只读账号 uuid 和邮箱，不碰令牌；不打印，出错静默。"""
    try:
        sid = args.session or os.environ.get("CLAUDE_CODE_SESSION_ID") or ""
        if not sid:
            return 0
        rec = {"sid": sid, "t": round(time.time(), 3), "uuid": "", "email": "", "name": "",
               "src": "", "ep": os.environ.get("CLAUDE_CODE_ENTRYPOINT", "")}
        cfg = load_config()
        cfg_dir = norm(os.environ.get("CLAUDE_CONFIG_DIR") or "")
        named = {norm(expand(k)): v for k, v in (cfg["config_dirs"] or {}).items()}
        if os.environ.get("CLAUDE_CODE_ACCOUNT_UUID"):
            rec.update(uuid=os.environ["CLAUDE_CODE_ACCOUNT_UUID"], email=os.environ.get("CLAUDE_CODE_USER_EMAIL", ""), src="desktop")
        elif cfg_dir and cfg_dir in named:
            rec.update(name=named[cfg_dir], src="config_dir")
        else:
            u, e = current_cli_account()
            rec.update(uuid=u, email=e, src="cli")
        if not (rec["uuid"] or rec["name"]):
            return 0
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(tag_log_path(), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001 - never break a session start
        pass
    return 0


def find_claude_cli():
    cands = [os.environ.get("CLAUDE_CODE_EXECPATH"), shutil.which("claude")]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        cands.append(os.path.join(local, "Microsoft", "WinGet", "Links", "claude.exe"))
    cands += [os.path.join(HOME, ".local", "bin", "claude"), os.path.join(HOME, ".claude", "local", "claude")]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return ""


def cmd_self_update(args):
    exe = find_claude_cli()
    if not exe:
        print(json.dumps({"ok": False, "message": "找不到 claude 命令行，没法自动更新"}, ensure_ascii=False))
        return 0
    logs = []
    for argv in ([exe, "plugin", "marketplace", "update", "cc-usage-panel"],
                 [exe, "plugin", "update", "cc-usage-panel@cc-usage-panel"]):
        try:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
            logs.append((p.returncode, (p.stdout + p.stderr).strip()))
        except (OSError, subprocess.TimeoutExpired) as e:
            logs.append((1, str(e)))
    ok = logs[-1][0] == 0
    text = logs[-1][1].splitlines()[-1] if logs[-1][1] else ""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(os.path.join(DATA_DIR, "update.log"), "a", encoding="utf-8") as fh:
            fh.write("%s exe=%s%s" % (dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), exe, os.linesep))
            for code, out in logs:
                fh.write("  [%d] %s%s" % (code, " | ".join(out.splitlines())[:500], os.linesep))
    except OSError:
        pass
    print(json.dumps({"ok": ok, "message": text[:200]}, ensure_ascii=False))
    return 0


def cmd_where(args):
    cfg = load_config()
    print(json.dumps({
        "version": VERSION, "data_dir": DATA_DIR, "projects_dirs": projects_dirs(cfg),
        "desktop_dirs": desktop_dirs(cfg), "python": sys.version.split()[0],
    }, ensure_ascii=False, indent=2))
    return 0


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(prog="usage.py", description="cc-usage-panel scanner")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("json"); p.add_argument("--cached", action="store_true"); p.set_defaults(fn=cmd_json)
    p = sub.add_parser("report"); p.add_argument("--no-open", action="store_true"); p.set_defaults(fn=cmd_report)
    p = sub.add_parser("text"); p.add_argument("--days", type=int, default=14); p.set_defaults(fn=cmd_text)
    p = sub.add_parser("tag"); p.add_argument("--session", default=""); p.set_defaults(fn=cmd_tag)
    p = sub.add_parser("self-update"); p.set_defaults(fn=cmd_self_update)
    p = sub.add_parser("where"); p.set_defaults(fn=cmd_where)
    args = ap.parse_args(argv)
    if not getattr(args, "fn", None):
        ap.print_help()
        return 2
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
