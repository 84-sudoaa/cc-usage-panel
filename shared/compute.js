// cc-usage-panel: the one copy of the statistics and drawing code.
// The panel (hooks/register.tsx) imports it; the HTML report (scanner/report.html) gets it inlined.
// Keep it plain JavaScript with no imports, so both places can use it as is.
//
// data = { today, since, weights: [in, cacheWrite, cacheRead, out], accounts: [...], rows: [[date, project, model, account, in, cw, cr, out, calls], ...] }
// view = { range: 7|14|30|0, acct: 'all'|name, metric: 'eff'|'raw'|'out', group: 'acct'|'proj'|'model' }

export const UNTAGGED = '未标记'
export const PALETTE = ['#d9774e', '#4a8fc0', '#6a9a4a', '#c99a3a', '#8a63b0', '#3a9a8e', '#c2577e']
export const GREY = '#9a948d'
export const INK = '#8f877e'
export const METRIC_NAME = { eff: '等效', raw: '原始总量', out: '输出' }
const WEEK = '日一二三四五六'
const CARD_LH = 28   // 悬停卡片的行高

export function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(Math.round(n))
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

export function metricOf(metric, w, r) {
  if (metric === 'raw') return r[4] + r[5] + r[6] + r[7]
  if (metric === 'out') return r[7]
  return r[4] * w[0] + r[5] * w[1] + r[6] * w[2] + r[7] * w[3]
}

export function allDates(data) {
  const out = []
  const d = new Date(data.since + 'T00:00:00')
  const end = new Date(data.today + 'T00:00:00')
  for (; d <= end; d.setDate(d.getDate() + 1)) {
    out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'))
  }
  return out
}

// Accounts in a stable order (named ones first, 未标记 last); colours follow this order everywhere.
export function accountsOf(data) {
  const seen = data.accounts && data.accounts.length ? data.accounts : [...new Set(data.rows.map(r => r[3]))]
  return [...seen].sort((a, b) => Number(a === UNTAGGED) - Number(b === UNTAGGED) || a.localeCompare(b))
}

export function compute(data, v) {
  const w = data.weights
  const f = r => metricOf(v.metric, w, r)
  const dates0 = allDates(data)
  const dates = v.range ? dates0.slice(-v.range) : dates0
  const inRange = new Set(dates)
  const src = v.acct === 'all' ? data.rows : data.rows.filter(r => r[3] === v.acct)
  const rows = src.filter(r => inRange.has(r[0]))
  const gi = v.group === 'proj' ? 1 : v.group === 'model' ? 2 : 3
  const accts = accountsOf(data)

  const tot = {}
  for (const r of rows) tot[r[gi]] = (tot[r[gi]] || 0) + f(r)
  const groups = Object.keys(tot).sort((a, b) => tot[b] - tot[a])
  const top = groups.slice(0, 7)
  const keys = groups.length > 7 ? [...top, '其他'] : top
  const keyOf = g => (top.includes(g) ? g : '其他')
  const color = k => {
    if (k === '其他' || k === UNTAGGED) return GREY
    if (v.group === 'acct') return PALETTE[Math.max(0, accts.indexOf(k)) % PALETTE.length]
    return PALETTE[top.indexOf(k) % PALETTE.length]
  }
  const keyTotal = k => (k === '其他' ? groups.slice(7).reduce((s, g) => s + tot[g], 0) : tot[k])

  const byDay = {}
  for (const d of dates) byDay[d] = { d, total: 0, parts: {}, raw: [0, 0, 0, 0, 0], rows: [] }
  for (const r of rows) {
    const b = byDay[r[0]], val = f(r), k = keyOf(r[gi])
    b.parts[k] = (b.parts[k] || 0) + val
    b.total += val
    b.rows.push(r)
    for (let i = 0; i < 5; i++) b.raw[i] += r[4 + i]
  }

  const all = {}
  for (const r of src) all[r[0]] = (all[r[0]] || 0) + f(r)
  const todayKey = dates0[dates0.length - 1]
  const val = d => (byDay[d] ? byDay[d].total : 0)
  const rangeTotal = dates.reduce((s, d) => s + val(d), 0)
  const activeDays = dates.filter(d => val(d) > 0).length || 1
  const peak = dates.reduce((a, d) => (val(d) > val(a) ? d : a), dates[0])
  const tiles = [
    ['今天', fmt(all[todayKey] || 0), todayKey ? todayKey.slice(5) : '-'],
    ['近 7 天', fmt(dates0.slice(-7).reduce((s, d) => s + (all[d] || 0), 0)), '合计'],
    ['日均', fmt(rangeTotal / activeDays), '所选范围 ' + activeDays + ' 天'],
    ['最多的一天', fmt(val(peak)), peak ? peak.slice(5) : '-'],
    ['全部总量', fmt(Object.values(all).reduce((a, b) => a + b, 0)), data.since.slice(5) + ' 起'],
  ]
  return { dates, byDay, keys, color, keyTotal, tiles, todayKey, accounts: accts }
}

export function todayTotal(data) {
  if (!data) return null
  return data.rows.filter(r => r[0] === data.today).reduce((s, r) => s + metricOf('eff', data.weights, r), 0)
}

// Bar chart with hover cards. Fixed pixel size (width/height attributes): a surface draws it 1:1
// instead of guessing, so text keeps its size. Hover is CSS only (no script): each day has a hit
// area followed by its card, shown with the sibling selector.
// k = text size (1 standard, 1.25 large, 1.5 extra large): the chart is drawn W / k wide and scaled up to W.
export function chartSvg(c, Wout, k = 1) {
  const { dates, byDay, keys, color, todayKey } = c
  const W = Math.round(Wout / k)
  // 高度至少放得下最长的悬停卡片（按项目分组时最多 8 行）
  const H = Math.max(280, 44 + keys.length * CARD_LH + 58 + 20)
  const max = Math.max(1, ...dates.map(d => byDay[d].total))
  const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(x => x >= raw) || raw
  const ymax = step * Math.ceil(max / step)
  // 纵轴留够最长刻度字的宽度（「100.0M」这种不会被截掉）
  const pl = Math.max(34, Math.ceil(fmt(ymax).length * 7.4) + 10), pr = 4, pt = 8, pb = 24
  const iw = W - pl - pr, ih = H - pt - pb
  const y = v => pt + ih - (v / ymax) * ih
  const bw = iw / Math.max(1, dates.length), gap = Math.min(5, bw * 0.25)

  let css = '.h{fill:transparent}.h:hover{fill:' + INK + ';fill-opacity:.12}.t{visibility:hidden;pointer-events:none}'
  dates.forEach((_, i) => { css += '.h' + i + ':hover~.t' + i + '{visibility:visible}' })
  let s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + Wout + '" height="' + Math.round(H * k) + '" viewBox="0 0 ' + W + ' ' + H + '" font-family="Microsoft YaHei UI, PingFang SC, Segoe UI, sans-serif"><style>' + css + '</style>'
  for (let v = 0; v <= ymax + 1e-9; v += step) {
    s += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="' + INK + '" stroke-opacity="0.25"/>'
    s += '<text x="' + (pl - 5) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="12.5" fill="' + INK + '">' + fmt(v) + '</text>'
  }
  const every = Math.ceil(dates.length / Math.max(3, Math.floor(W / 52)))
  dates.forEach((d, i) => {
    const x = pl + i * bw + gap / 2, w = bw - gap
    let acc = 0
    for (const k of keys) {
      const v = byDay[d].parts[k] || 0
      if (!v) continue
      const y0 = y(acc), y1 = y(acc + v)
      s += '<rect x="' + x + '" y="' + y1 + '" width="' + w + '" height="' + Math.max(0.5, y0 - y1) + '" fill="' + color(k) + '"/>'
      acc += v
    }
    const last = dates.length - 1
    // 规律的标签离最后一个太近就不画，免得挤在一起
    if (i === last || (i % every === 0 && last - i >= Math.max(2, Math.ceil(every * 0.75)))) {
      const atEnd = i === last
      s += '<text x="' + (atEnd ? W - pr : x + w / 2) + '" y="' + (H - 8) + '" text-anchor="' + (atEnd ? 'end' : 'middle') + '" font-size="12" fill="' + (d === todayKey ? '#d9774e' : INK) + '">' + esc(d.slice(5)) + '</text>'
    }
  })
  dates.forEach((d, i) => {
    s += '<rect class="h h' + i + '" x="' + (pl + i * bw) + '" y="' + pt + '" width="' + bw + '" height="' + ih + '"/>'
  })
  dates.forEach((d, i) => {
    const b = byDay[d]
    const parts = keys.filter(k => b.parts[k]).sort((a, z) => b.parts[z] - b.parts[a])
    // 卡片铺满整张图的宽度，字比坐标轴大一大截；pointer-events:none，鼠标照样能在柱子间移动
    const tw = W - 8, lh = CARD_LH, head = 44
    const showPct = tw >= 260                       // 窄的时候不放占比，把位置让给名字
    const valX = showPct ? tw - 60 : tw - 12
    const maxName = Math.max(5, Math.floor((valX - 34 - 64) / 17))
    const th = head + Math.max(1, parts.length) * lh + 58
    const tx = 4
    const ty = pt + 2
    const wd = WEEK[new Date(d + 'T00:00:00').getDay()]
    s += '<g class="t t' + i + '"><rect x="' + tx + '" y="' + ty + '" width="' + tw + '" height="' + th + '" rx="10" fill="#26231f" fill-opacity="0.97" stroke="' + INK + '" stroke-opacity="0.55"/>'
    s += '<text x="' + (tx + 12) + '" y="' + (ty + 30) + '" font-size="20" font-weight="700" fill="#f4efe8">' + esc(d.slice(5)) + ' 周' + wd + (d === todayKey ? ' 今天' : '') + '</text>'
    s += '<text x="' + (tx + tw - 12) + '" y="' + (ty + 30) + '" font-size="20" font-weight="700" text-anchor="end" fill="#f4efe8">' + fmt(b.total) + '</text>'
    if (!parts.length) s += '<text x="' + (tx + 12) + '" y="' + (ty + head + 20) + '" font-size="18" fill="#cfc8bf">没有记录</text>'
    parts.forEach((k, j) => {
      const ly = ty + head + 20 + j * lh
      const pct = b.total ? Math.round((b.parts[k] / b.total) * 100) : 0
      s += '<rect x="' + (tx + 12) + '" y="' + (ly - 13) + '" width="14" height="14" rx="3" fill="' + color(k) + '"/>'
      s += '<text x="' + (tx + 34) + '" y="' + ly + '" font-size="18" fill="#ebe5dd">' + esc(k.length > maxName ? k.slice(0, maxName - 1) + '…' : k) + '</text>'
      s += '<text x="' + (tx + valX) + '" y="' + ly + '" font-size="18" text-anchor="end" fill="#ebe5dd">' + fmt(b.parts[k]) + '</text>'
      if (showPct) s += '<text x="' + (tx + tw - 12) + '" y="' + ly + '" font-size="16" text-anchor="end" fill="#b5ada3">' + pct + '%</text>'
    })
    s += '<text x="' + (tx + 12) + '" y="' + (ty + th - 32) + '" font-size="16" fill="#b5ada3">输出 ' + fmt(b.raw[3]) + '  调用 ' + b.raw[4] + '</text>'
    s += '<text x="' + (tx + 12) + '" y="' + (ty + th - 11) + '" font-size="16" fill="#b5ada3">缓存读 ' + fmt(b.raw[2]) + '</text></g>'
  })
  return s + '</svg>'
}

// Per-day table as one picture: it scales with the panel, so widening the sidebar enlarges it.
export function tableSvg(c, data, k = 1) {
  const w = data.weights
  const cols = [
    ['日期', 86, 'start'], ['等效', 76, 'end'], ['输入', 58, 'end'], ['缓存写入', 84, 'end'],
    ['缓存读取', 86, 'end'], ['输出', 70, 'end'], ['调用', 58, 'end'], ['账号', 230, 'start'], ['最多的项目', 150, 'start'],
  ]
  const W = cols.reduce((s, x) => s + x[1], 0) + 16
  const rowsData = []
  for (const d of [...c.dates].reverse()) {
    const b = c.byDay[d]
    if (!b.rows.length) continue
    const pp = {}, pa = {}
    for (const r of b.rows) {
      const e = metricOf('eff', w, r)
      pp[r[1]] = (pp[r[1]] || 0) + e
      pa[r[3]] = (pa[r[3]] || 0) + e
    }
    const topP = Object.keys(pp).sort((a, z) => pp[z] - pp[a])[0] || ''
    const acc = Object.keys(pa).sort((a, z) => pa[z] - pa[a]).map(k => k + ' ' + fmt(pa[k])).join(' · ')
    const s = b.raw
    rowsData.push([d.slice(5) + (d === c.todayKey ? ' 今天' : ''), fmt(s[0] * w[0] + s[1] * w[1] + s[2] * w[2] + s[3] * w[3]),
      fmt(s[0]), fmt(s[1]), fmt(s[2]), fmt(s[3]), String(s[4]), acc, topP.length > 14 ? topP.slice(0, 13) + '…' : topP])
  }
  const rh = 32, hh = 36
  const H = hh + rowsData.length * rh + 4
  const xs = []
  let x = 8
  for (const col of cols) { xs.push(x); x += col[1] }
  const tx = i => (cols[i][2] === 'end' ? xs[i] + cols[i][1] - 8 : xs[i] + 4)
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(W * k) + '" height="' + Math.round(H * k) + '" viewBox="0 0 ' + W + ' ' + H + '" font-family="Microsoft YaHei UI, PingFang SC, Segoe UI, sans-serif">'
  svg += '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="8" fill="#26231f"/>'
  svg += '<rect x="0" y="0" width="' + W + '" height="' + hh + '" rx="8" fill="#3a3632"/>'
  cols.forEach((col, i) => {
    svg += '<text x="' + tx(i) + '" y="' + (hh - 12) + '" font-size="14" font-weight="700" text-anchor="' + col[2] + '" fill="#d8d1c8">' + col[0] + '</text>'
  })
  rowsData.forEach((row, ri) => {
    const y0 = hh + ri * rh
    if (ri % 2 === 1) svg += '<rect x="0" y="' + y0 + '" width="' + W + '" height="' + rh + '" fill="#ffffff" fill-opacity="0.04"/>'
    row.forEach((cell, i) => {
      const today = i === 0 && cell.includes('今天')
      svg += '<text x="' + tx(i) + '" y="' + (y0 + rh - 10) + '" font-size="14.5" text-anchor="' + cols[i][2] + '" fill="' + (today ? '#e8875c' : '#e6e0d8') + '"' + (i === 1 ? ' font-weight="700"' : '') + '>' + esc(cell) + '</text>'
    })
  })
  return { svg: svg + '</svg>', rows: rowsData.length }
}
