import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageData, UsageView } from '../types'
import { METRIC_NAME, chartSvg, compute, fmt, tableSvg, todayTotal } from '../shared/compute.js'

// The numbers come from scanner/usage.py (Python 3.8+, standard library only).
// All drawing and statistics live in shared/compute.js, which the HTML report uses too.

const PANE = 'cc-usage-panel'
const TITLE = 'Claude 用量'
// The pictures are made wider than any sidebar; the desktop shrinks them to fit, so they always fill
// the sidebar and grow when it is widened. CHART_BASE: the sidebar width the text size is tuned for.
const WIDE = 2400
const CHART_BASE = 300
// Text size inside the pictures at a ~300px sidebar (1 = drawn size); widening the sidebar
// enlarges everything further.
const TEXT_SCALE = 1.25

const view = atom({ plugin: 'cc-usage-panel', key: 'view' } as const,
  { range: 30, acct: 'all', metric: 'eff', group: 'acct', showTable: false, isLoading: false, isDone: false,
    isUpdating: false, error: '', notice: '', data: null } as UsageView,
  { shape: 'view-3' })

// ---------------------------------------------------------------- module state
// Plain variables, not $.state: they start fresh on every load, so a reload can never leave
// "counting..." stuck on (a lesson from the first version).
let running = false
let shown = false
let python: string[] | null = null
let version = ''

const CANDIDATES: string[][] = [['python'], ['python3'], ['py', '-3']]

async function findPython($: EngineInterface): Promise<string[] | null> {
  if (python) return python
  for (const cmd of CANDIDATES) {
    try {
      const r = await $.process.run([...cmd, '--version'], { timeoutMs: 10000 })
      const out = `${r.stdout}${r.stderr}`
      const m = /Python (\d+)\.(\d+)/.exec(out)
      if (r.exitCode === 0 && m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 8))) {
        python = cmd
        return cmd
      }
    } catch {
      // not installed under this name; try the next one
    }
  }
  return null
}

async function scanner($: EngineInterface, args: string[], timeoutMs = 180000) {
  const py = await findPython($)
  if (!py) throw new Error('需要 Python 3.8 或更新的版本（python、python3 或 py 命令），装好后点「刷新」')
  return $.process.run([...py, '-I', '-B', `${$.plugin.root}/scanner/usage.py`, ...args], { timeoutMs })
}

function lastLine(s: string): string {
  const lines = s.trim().split(String.fromCharCode(10))
  return (lines[lines.length - 1] ?? '').trim()
}

// ---------------------------------------------------------------- work (always on a timer)
// Presses, renders and commands run under a time budget; when it ends, calls still in flight
// are cancelled. Everything that runs Python is therefore started from $.clock.after.

function later($: EngineInterface, fn: () => Promise<void>) {
  $.clock.after(1, () => { void fn() })
}

async function refresh($: EngineInterface, mode: 'press' | 'open' | 'cached') {
  if (running) return
  running = true
  const cur = await read($, view)
  const showBusy = mode === 'press' || (mode === 'open' && !cur.data)
  if (showBusy) await update($, view, x => ({ ...x, isLoading: true, isDone: false, error: '' }))
  const t0 = await $.clock.now()
  try {
    const r = await scanner($, mode === 'cached' ? ['json', '--cached'] : ['json'])
    if (r.exitCode !== 0) throw new Error(lastLine(r.stderr) || `统计脚本退出码 ${r.exitCode}`)
    if (!r.stdout.trim()) return            // --cached with nothing saved yet
    const data = JSON.parse(r.stdout) as UsageData
    const spent = (await $.clock.now()) - t0
    if (mode === 'press' && spent < 800) await $.clock.sleep(800 - spent)   // long enough to be seen
    await update($, view, x => ({
      ...x, data, isLoading: false, isDone: mode === 'press', error: '',
      notice: mode !== 'cached' && spent > 5000 ? `这次统计用了 ${Math.round(spent / 1000)} 秒（第一次要扫全部记录，之后有缓存会快很多）` : x.notice,
      acct: data.accounts.includes(x.acct) ? x.acct : 'all',
    }))
    if (mode === 'press') $.clock.after(2500, () => { void update($, view, x => ({ ...x, isDone: false })) })
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 300)
    await update($, view, x => ({ ...x, isLoading: false, isDone: false, error: msg }))
  } finally {
    running = false
  }
}

async function selfUpdate($: EngineInterface) {
  await update($, view, x => ({ ...x, isUpdating: true, notice: '正在检查更新…' }))
  const t0 = await $.clock.now()
  const done = async (notice: string) => {
    const spent = (await $.clock.now()) - t0
    if (spent < 800) await $.clock.sleep(800 - spent)        // 让「检查中…」看得见
    await update($, view, x => ({ ...x, isUpdating: false, notice }))
  }
  let res: { ok?: boolean; message?: string; local?: boolean; latest?: boolean } = {}
  try {
    const r = await scanner($, ['self-update'], 300000)
    res = JSON.parse(r.stdout || '{}')
  } catch (err) {
    await done(`没能检查更新：${String((err as Error)?.message ?? err).slice(0, 200)}`)
    return
  }
  if (!res.ok) {
    await done(`没能自动更新：${res.message || '未知原因'}。可以在终端运行 claude plugin update cc-usage-panel@cc-usage-panel`)
    return
  }
  if (res.latest) {
    const m = /(\d+\.\d+\.\d+)/.exec(res.message || '')
    await done(`已是最新版本${m ? ` v${m[1]}` : ''}。`)
    return
  }
  // 下载了新版，或者是从本地文件夹装的（文件夹里的改动要重载才生效）：直接重新加载，把更新做完
  await done(res.local ? '正在加载文件夹里的最新代码…' : '已下载新版本，正在重新加载插件…')
  try {
    await $.command.run({ command: 'reload-plugins' })
  } catch {
    await update($, view, x => ({ ...x, notice: '新版本已经准备好，但这个会话没法自动重载（比如远程连接时）。新开一个会话就能用上。' }))
  }
}

// First time this session draws anything: clear flags a previous load may have left, read the
// last saved numbers (no scan) so the corner button can show today's figure.
function wake($: EngineInterface) {
  if (shown) return
  shown = true
  void update($, view, x => (x.isLoading || x.isDone || x.isUpdating ? { ...x, isLoading: false, isDone: false, isUpdating: false } : x))
  later($, () => refresh($, 'cached'))
  later($, async () => {
    try {
      version = (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }).version ?? ''
    } catch {
      version = ''
    }
  })
}

async function togglePane($: EngineInterface) {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return
  }
  await openPane($)
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE })
  later($, () => refresh($, 'open'))
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'cc-usage-panel', description: '打开 Claude 用量面板（每天的 token，按账号、项目、模型拆分）' })
    // Remember which account this session runs on (a few milliseconds of Python, nothing printed).
    later($, async () => {
      try {
        await scanner($, ['tag', '--session', await $.session.id()], 15000)
      } catch {
        // no Python yet: the panel says so when opened
      }
    })
    return started
  })

  on('command.run', { command: 'cc-usage-panel' }, async $ => {
    await openPane($)
    return { text: '用量面板打开了。' }
  })

  // Corner of the prompt footer, beside the mode labels: one press opens the panel, the next closes it.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    wake($)
    const x = await read($, view)
    const today = x.data && x.data.today === new Date().toISOString().slice(0, 10) ? todayTotal(x.data) : null
    const label = today === null ? '用量' : `用量 · 今天 ${fmt(today)}`
    const modes = e.props.modes
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        {modes.length > 0 && <Text dimColor>{modes.join(' & ')}</Text>}
        <Button key="open-usage" label={label} dimColor onPress={() => { void togglePane($) }} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Svg } = $.ui.resolve(e) as any
    wake($)
    const x = await read($, view)
    const d = x.data
    const set = (patch: Partial<UsageView>) => async () => { await update($, view, y => ({ ...y, ...patch })) }
    const accts: string[] = d ? d.accounts : []
    const multi = accts.length > 1
    const v = { ...x, acct: multi ? x.acct : 'all', group: !multi && x.group === 'acct' ? 'proj' : x.group }
    const c = d ? compute(d, v) : null
    const k = TEXT_SCALE
    const small = 'body'
    const big = 'heading'
    const tag = `${METRIC_NAME[v.metric as 'eff' | 'raw' | 'out']}${v.acct === 'all' ? '' : ` · ${v.acct}`}`

    const seg = (label: string, opts: [string | number, string][], cur: string | number, key: keyof UsageView) => (
      <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
        <Text dimColor size={small}>{label}</Text>
        {opts.map(([val, text]) => (
          <Button key={`${String(key)}-${val}`} label={text} variant={cur === val ? 'primary' : 'secondary'}
            onPress={set({ [key]: val } as Partial<UsageView>)} />
        ))}
      </Box>
    )
    const groupOpts: [string, string][] = [...(multi ? [['acct', '按账号'] as [string, string]] : []), ['proj', '按项目'], ['model', '按模型']]
    const refreshLabel = x.isLoading ? '统计中…' : x.isDone ? `已更新 ✓ ${d?.generated ?? ''}` : '刷新'

    return (
      <Box flexDirection="column" gap={1} padding={1}>
        {multi && seg('账号', [['all', '全部'], ...accts.map(a => [a, a] as [string, string])], v.acct, 'acct')}
        {c && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={1}>
            {c.tiles.map(([name, val, note]: [string, string, string]) => (
              <Box key={`t-${name}`} flexDirection="column">
                <Text dimColor size={small}>{name} · {tag}</Text>
                <Text bold tabular size={big}>{val}</Text>
                <Text dimColor size={small}>{note}</Text>
              </Box>
            ))}
          </Box>
        )}
        {seg('范围', [[7, '7 天'], [14, '14 天'], [30, '30 天'], [0, '全部']], v.range, 'range')}
        {seg('指标', [['eff', '等效'], ['raw', '原始总量'], ['out', '输出']], v.metric, 'metric')}
        {seg('分组', groupOpts, v.group, 'group')}
        {c && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {c.keys.map((g: string) => (
              <Text key={`l-${g}`} size={small}><Text color={c.color(g)}>■</Text> {g} <Text dimColor>{fmt(c.keyTotal(g))}</Text></Text>
            ))}
          </Box>
        )}
        {c && Svg && <Svg isInteractive source={chartSvg(c, WIDE, k, CHART_BASE)} alt={`每日用量柱状图（${tag}），鼠标放到柱子上看当天明细`} />}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="table" label={x.showTable ? '收起明细表' : '每日明细表'} dimColor onPress={set({ showTable: !x.showTable })} />
          <Button key="refresh" label={refreshLabel} dimColor onPress={() => { later($, () => refresh($, 'press')) }} />
          <Button key="report" label="网页版" dimColor onPress={() => { later($, async () => { await scanner($, ['report']) }) }} />
          <Button key="update" label={x.isUpdating ? '检查中…' : '检查更新'} dimColor onPress={() => { later($, () => selfUpdate($)) }} />
        </Box>
        {x.notice && <Text size={small}>{x.notice}</Text>}
        {c && d && x.showTable && Svg && (() => {
          const t = tableSvg(c, d, k, WIDE)
          return <Svg source={t.svg} alt={`每日明细表，${t.rows} 天`} />
        })()}
        {c && x.showTable && <Text dimColor size={small}>提示：明细表跟着边栏宽度缩放，把边栏往左拉宽，表和字都会放大。</Text>}
        {x.error && <Text color="red">没取到数据：{x.error}</Text>}
        {!d && !x.error && <Text dimColor>{x.isLoading ? '正在统计，第一次要扫全部记录，可能要十几秒…' : '还没有数据，点「刷新」。'}</Text>}
        {d && (
          <Text dimColor size={small}>
            统计于 {d.today.slice(5)} {d.generated}，点「刷新」重新统计。等效 token：缓存读取 ×0.1、缓存写入 ×2、输出 ×5。{multi ? '分不清是哪个号的算「未标记」（多半是装插件之前的记录）。' : ''}{version ? ` · v${version}` : ''}
          </Text>
        )}
      </Box>
    )
  })
}
