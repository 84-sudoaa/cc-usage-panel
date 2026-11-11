# cc-usage-panel

中文 | [English](README.en.md)

**每天用了多少 Claude，在对话旁边就能看到。** 官方用量页只有 5 小时和每周额度的百分比进度条。这个插件读 Claude Code 本来就存在你电脑上的会话记录，按天统计 token，能看出每天用在哪个项目、哪个模型、哪个账号上。

## 功能

- 输入框底栏有一个 **「用量 · 今天 xx」** 按钮：点一下打开面板，再点一下关闭。
- 五个数：今天、近 7 天、日均、最多的一天、全部总量。
- 按 **账号 / 项目 / 模型** 堆叠的柱状图，可看 7 天、14 天、30 天或全部；指标可在等效 token、原始 token、输出 token 之间切换。
- **鼠标停在柱子上**，图顶部会弹出当天明细卡片：每组的 token 和占比、输出 token、缓存读取、调用次数。图顶部给卡片留了位置，卡片几乎不挡柱子。
- 柱状图 **始终铺满边栏宽度**，文字保持固定的易读字号。
- **每日明细表** 随边栏缩放：边栏拉宽，表就跟着变大。
- **网页版**：同样的内容开成完整网页（同一份代码，数字一致）。
- **刷新** 只在点的时候重新统计，翻看时面板不会乱跳。第一次统计要读全部会话记录，可能要 10 秒以上；之后有缓存，大约一秒。
- **检查更新** 一键完成更新：有新版就下载，并重新加载插件。（如果当前会话没法重载插件，比如远程连接时，面板会提示你新开一个会话。）
- 只有一个账号？账号切换会隐藏，全部算在这个账号上。

## 安装

需要 PATH 里有 **Python 3.8 或更高版本**（`python`、`python3` 或 `py`），别的都不用装。

在终端会话里：

```
/plugin install cc-usage-panel --marketplace 84-sudoaa/cc-usage-panel
```

或者在 shell 里：

```bash
claude plugin marketplace add 84-sudoaa/cc-usage-panel
claude plugin install cc-usage-panel@cc-usage-panel --scope user
```

桌面版：点输入框旁边的 **+** → **Plugins** → **Add marketplace**（填 `84-sudoaa/cc-usage-panel`）→ **Add plugin**。

新开一个会话（或运行 `/reload-plugins`），输入框底栏右侧就会出现 **用量** 按钮。用 `/cc-usage-panel` 也能打开面板。

## 更新

在面板里点 **检查更新**：会自动更新并重新加载插件。也可以手动：`claude plugin marketplace update cc-usage-panel && claude plugin update cc-usage-panel@cc-usage-panel`，然后 `/reload-plugins`（或新开一个会话）。

## 怎么区分账号

会话记录里不写每次调用用的是哪个账号，所以插件按下面的顺序推断：

1. **装好插件之后开的会话**：会话启动时，插件记下会话 id 和它用的账号（账号 id 和邮箱取自 Claude Code 自己的设置；从不读令牌）。
2. **桌面版的会话**：桌面版按账号把会话分文件夹存放；在 Windows、macOS、Linux 上都能自动找到。
3. 可选配置（见下）：其他 Claude 配置文件夹、终端上一次切换账号的时间标记。
4. **只见过一个账号**：全部算在这个账号上。
5. 其余的显示为 **未标记**，一般是装插件之前在终端里开的会话。

## 配置（可选）

`~/.claude/cc-usage-panel/config.json`，每一项都可省略（参考 `config.example.json`）：

| 键 | 作用 |
|---|---|
| `project_roots` | 这些文件夹下的第一层子文件夹名作为项目名（默认：工作文件夹路径的最后一段）。 |
| `extra_projects_dirs` | 额外要读的 `projects` 文件夹。 |
| `desktop_dirs` | 桌面版数据文件夹，不在默认位置时填。 |
| `config_dirs` | `{ "<某个 Claude 配置文件夹>": "<账号名>" }`：用这个 `CLAUDE_CONFIG_DIR` 运行的会话算在该账号上。 |
| `cli_switch_marker_glob` | 这些文件最近一次修改的时间，标记你上一次在终端切换账号；之后的终端会话算在当前登录的账号上。 |
| `account_names` | `{ "<账号 uuid 或邮箱>": "<显示名>" }`。默认用邮箱 `@` 前面的部分。 |
| `single_account_fallback` | `true`（默认）：只有一个账号时，未标记的调用算在它上面。 |

## 等效 token

缓存读取 ×0.1，缓存写入 ×2，输出 ×5，普通输入 ×1，大致是 API 的价格比例。它比原始总量（大部分是便宜的缓存读取）更贴近真实花费，但 Anthropic 没有公开套餐额度怎么计算，所以只作参考。

## 隐私

- 只读本机文件：`~/.claude/projects` 下的会话记录、桌面版的会话索引、Claude Code 设置里的账号 id 和邮箱。**从不读令牌。**
- 只往 `~/.claude/cc-usage-panel/` 里写（缓存、上次结果、会话与账号的对应记录、网页报告）。设置 `CC_USAGE_PANEL_DIR` 可以换位置。
- 除了 **检查更新**（它运行 Claude Code 自带的 `plugin update`），不联网。
- 不往模型的上下文里加任何东西：没有工具，没有提示词。

## 命令行

```bash
python scanner/usage.py text --days 14     # 在终端里画柱状图
python scanner/usage.py report             # 打开网页版
python scanner/usage.py where              # 看它读写哪些文件夹
python scanner/test_usage.py               # 测试
```

## 常见问题

- **第一次刷新很慢。** 它要把全部会话记录读一遍（重度用户能有好几 GB）。之后只重读有变化的文件。
- **未标记很多。** 这些调用来自装插件之前、而且这台电脑上有不止一个账号。从现在起新会话都会标上账号。
- **Claude Code 默认只保留约 30 天的会话记录**（`cleanupPeriodDays`），更早的日子已经没了。

## 许可证

MIT
