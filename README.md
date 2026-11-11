# cc-usage-panel

**Daily token usage for Claude Code, right beside your chat.** The official usage page only shows percentage bars for the 5-hour and weekly limits. This plugin reads the session transcripts Claude Code already keeps on your machine and shows how many tokens you used each day, on which project, with which model, and on which account.

**每天用了多少 Claude，在对话旁边就能看到。** 官方用量页只有 5 小时、每周额度的百分比进度条。这个插件读 Claude Code 本来就存在你电脑上的会话记录，按天统计 token，能按账号、项目、模型拆开看。

## What you get / 功能

- A **"用量 · 今天 xx"** button in the prompt footer: press to open the panel, press again to close it.
- Five numbers: today, last 7 days, daily average, busiest day, all-time total.
- A stacked bar chart by **account / project / model**, 7, 14, 30 days or everything; metric switch between effective tokens, raw tokens and output tokens.
- **Hover a bar** and a card appears at the top of the chart with that day's breakdown: each group's tokens and share, output tokens, cache reads and number of calls. The chart keeps room at the top for it, so the card hardly covers any bars.
- The chart **always fills the sidebar's width**, with text at a fixed, readable size.
- A **per-day table** that scales with the sidebar: widen the sidebar and it grows.
- **网页版**: the same view as a full web page (same code, same numbers).
- **刷新** recounts only when you press it, so the panel never jumps while you scroll. The first count reads every transcript and can take 10+ seconds; after that a cache keeps it to about a second.
- **检查更新** finishes the update in one press: it fetches a new version if there is one and reloads the plugin. (If the session cannot reload plugins, for example while it is connected remotely, the panel says so: start a new session.)
- One account? The account switch is hidden and everything is counted for that account.

右下角按钮点开、再点关闭；五个数（今天、近 7 天、日均、最多的一天、全部总量）；按账号 / 项目 / 模型堆叠的柱状图，始终铺满边栏宽度，鼠标停在柱子上时顶部弹出当天明细；每日明细表随边栏拉宽放大；网页版；「刷新」只在点的时候统计；「检查更新」一键更新；只有一个账号时自动隐藏账号切换。

## Install / 安装

Requires **Python 3.8+** on your PATH (`python`, `python3` or `py`). Nothing else to install.

In a terminal session:

```
/plugin install cc-usage-panel --marketplace <owner>/cc-usage-panel
```

or from a shell:

```bash
claude plugin marketplace add <owner>/cc-usage-panel
claude plugin install cc-usage-panel@cc-usage-panel --scope user
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** (`<owner>/cc-usage-panel`) → **Add plugin**.

Start a new session (or run `/reload-plugins`): the **用量** button appears at the right of the prompt footer. `/cc-usage-panel` opens the panel too.

## Update / 更新

Press **检查更新** in the panel: it updates and reloads the plugin. Or by hand: `claude plugin marketplace update cc-usage-panel && claude plugin update cc-usage-panel@cc-usage-panel`, then `/reload-plugins` (or start a new session).

## How accounts are told apart / 怎么区分账号

Transcripts do not say which account made a call, so the plugin works it out, in this order:

1. **Sessions started after you install the plugin**: at session start the plugin records the session id and the account it runs on (account id and email from Claude Code's own settings; never tokens).
2. **Desktop app sessions**: the desktop app keeps its sessions in one folder per account; found automatically on Windows, macOS and Linux.
3. Optional config (below): other Claude config folders, a marker for when you last switched the terminal's account.
4. **Only one account ever seen**: everything is counted for it.
5. Anything else shows as **未标记** (untagged), typically terminal sessions from before you installed the plugin.

## Config (optional) / 配置（可选）

`~/.claude/cc-usage-panel/config.json`, every key optional (see `config.example.json`):

| key | what it does |
|---|---|
| `project_roots` | Folders whose first sub-folder names the project (default: the last part of the working folder). |
| `extra_projects_dirs` | More `projects` folders to read. |
| `desktop_dirs` | Desktop app data folders, if yours is not in the default place. |
| `config_dirs` | `{ "<a Claude config folder>": "<account name>" }`: sessions run with that `CLAUDE_CONFIG_DIR` count for that account. |
| `cli_switch_marker_glob` | Files whose newest change marks your last account switch in the terminal; terminal sessions after it count for the account logged in now. |
| `account_names` | `{ "<account uuid or email>": "<display name>" }`. Default: the part of the email before `@`. |
| `single_account_fallback` | `true` (default): with one account, untagged calls count for it. |

## Effective tokens / 等效 token

Cache reads ×0.1, cache writes ×2, output ×5, plain input ×1, roughly the API price ratios. It tracks real cost far better than the raw total (which is mostly cheap cache reads), but Anthropic does not publish how plan limits are counted, so treat it as a guide.

## Privacy / 隐私

- Reads only local files: transcripts under `~/.claude/projects`, the desktop app's session index, and the account id/email in Claude Code's settings. **Never reads tokens.**
- Writes only to `~/.claude/cc-usage-panel/` (cache, last result, session→account log, report). Set `CC_USAGE_PANEL_DIR` to move it.
- No network access except **检查更新**, which runs Claude Code's own `plugin update`.
- Adds nothing to the model's context: no tools, no prompt text.

## Commands / 命令行

```bash
python scanner/usage.py text --days 14     # bar chart in the terminal
python scanner/usage.py report             # open the web page
python scanner/usage.py where              # which folders it reads and writes
python scanner/test_usage.py               # tests
```

## FAQ

- **The first refresh is slow.** It reads every transcript once (gigabytes for heavy users). After that only changed files are read again.
- **Lots of 未标记.** Those calls are from before the plugin was installed, on a machine with more than one account. New sessions are tagged from now on.
- **Claude Code keeps transcripts for about 30 days** by default (`cleanupPeriodDays`), so older days are gone.

## License

MIT
