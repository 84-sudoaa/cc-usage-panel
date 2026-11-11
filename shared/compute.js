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
const CARD_LH = 24   // 悬停卡片的行高

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

// Bar chart that always fills the width it is given, with text at its real pixel size.
// Horizontal positions are percentages, so the bars stretch to any width without anyone knowing that
// width (the desktop never tells a plugin how wide the sidebar is). Vertical positions and font sizes
// are pixels, and the height is fixed and returned, so the panel can ask for exactly that height.
// A details card appears at the top while a bar is hovered (CSS only: the desktop draws the SVG in a
// script-less frame); the plot leaves head room there so the card mostly covers empty space.
// Returns { svg, height }.
export function chartSvg(c, opts = {}) {
  const { dates, byDay, keys, color, todayKey } = c
  const n = Math.max(1, dates.length)
  const lh = 22, head = 32, foot = 24
  const cardH = head + Math.max(1, keys.length) * lh + foot
  const top = Math.min(cardH + 6, 100)                 // 顶上留白给悬停卡片（行多的时候会盖住一点高柱子）
  const plotH = opts.plotH || 170
  const bottom = 22
  const H = top + plotH + bottom
  const L = 13, R = 99                                  // 左边 13% 放刻度字，右边留 1%
  const max = Math.max(1, ...dates.map(d => byDay[d].total))
  const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(x => x >= raw) || raw
  const ymax = step * Math.ceil(max / step)
  const yPx = v => top + plotH - (v / ymax) * plotH
  const bw = (R - L) / n, gap = Math.min(bw * 0.25, 0.7)
  const xs = i => L + bw * i
  const pct = v => v.toFixed(3) + '%'
  const axis = v => fmt(v).replace('.0', '')

  let css = '.h{fill:transparent}.h:hover{fill:' + INK + ';fill-opacity:.14}.t{visibility:hidden;pointer-events:none}'
  dates.forEach((_, i) => { css += '.h' + i + ':hover~.t' + i + '{visibility:visible}' })
  let s = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="' + H + '" font-family="Microsoft YaHei UI, PingFang SC, Segoe UI, sans-serif"><style>' + css + '</style>'
  for (let v = 0; v <= ymax + 1e-9; v += step) {
    s += '<line x1="' + pct(L) + '" x2="' + pct(R) + '" y1="' + yPx(v) + '" y2="' + yPx(v) + '" stroke="' + INK + '" stroke-opacity="0.25"/>'
    s += '<text x="' + pct(L - 1) + '" y="' + (yPx(v) + 4) + '" text-anchor="end" font-size="11.5" fill="' + INK + '">' + axis(v) + '</text>'
  }
  const every = Math.ceil(n / 6), last = n - 1
  dates.forEach((d, i) => {
    let acc = 0
    for (const g of keys) {
      const v = byDay[d].parts[g] || 0
      if (!v) continue
      const y0 = yPx(acc), y1 = yPx(acc + v)
      s += '<rect x="' + pct(xs(i) + gap / 2) + '" y="' + y1 + '" width="' + pct(bw - gap) + '" height="' + Math.max(0.5, y0 - y1) + '" fill="' + color(g) + '"/>'
      acc += v
    }
    // 规律的标签离最后一个太近就不画；最后一个靠右对齐，不被边缘截掉
    if (i === last || (i % every === 0 && last - i >= every)) {
      const atEnd = i === last
      s += '<text x="' + (atEnd ? pct(R) : pct(xs(i) + bw / 2)) + '" y="' + (H - 6) + '" text-anchor="' + (atEnd ? 'end' : 'middle') + '" font-size="12" fill="' + (d === todayKey ? '#d9774e' : INK) + '">' + esc(d.slice(5)) + '</text>'
    }
  })
  dates.forEach((d, i) => {
    s += '<rect class="h h' + i + '" x="' + pct(xs(i)) + '" y="' + top + '" width="' + pct(bw) + '" height="' + plotH + '"/>'
  })
  dates.forEach((d, i) => {
    const b = byDay[d]
    const parts = keys.filter(g => b.parts[g]).sort((a, z) => b.parts[z] - b.parts[a])
    const ch = head + Math.max(1, parts.length) * lh + foot
    const wd = WEEK[new Date(d + 'T00:00:00').getDay()]
    const isToday = d === todayKey
    s += '<g class="t t' + i + '"><rect x="1%" y="3" width="98%" height="' + ch + '" rx="8" fill="#26231f" fill-opacity="0.97" stroke="' + INK + '" stroke-opacity="0.55"/>'
    s += '<text x="3%" y="25" font-size="15" font-weight="700" fill="' + (isToday ? '#e8875c' : '#f4efe8') + '">' + esc(d.slice(5)) + ' 周' + wd + (isToday ? ' 今天' : '') + '</text>'
    s += '<text x="97%" y="25" font-size="15" font-weight="700" text-anchor="end" fill="#f4efe8">' + fmt(b.total) + '</text>'
    if (!parts.length) s += '<text x="3%" y="' + (head + 17) + '" font-size="14" fill="#cfc8bf">没有记录</text>'
    parts.forEach((g, j) => {
      const ly = head + 17 + j * lh
      const share = b.total ? Math.round((b.parts[g] / b.total) * 100) : 0
      s += '<rect x="3%" y="' + (ly - 11) + '" width="12" height="12" rx="2.5" fill="' + color(g) + '"/>'
      s += '<text x="3%" dx="18" y="' + ly + '" font-size="14" fill="#ebe5dd">' + esc(g.length > 12 ? g.slice(0, 11) + '…' : g) + ' <tspan fill="#b5ada3" font-size="12.5">' + share + '%</tspan></text>'
      s += '<text x="97%" y="' + ly + '" font-size="14" text-anchor="end" fill="#ebe5dd">' + fmt(b.parts[g]) + '</text>'
    })
    s += '<text x="3%" y="' + (ch - 4) + '" font-size="12.5" fill="#b5ada3">输出 ' + fmt(b.raw[3]) + ' · 调用 ' + b.raw[4] + ' · 缓存读 ' + fmt(b.raw[2]) + '</text></g>'
  })
  return { svg: s + '</svg>', height: H }
}

// Per-day table as one picture: it scales with the panel, so widening the sidebar enlarges it.
// out: the picture's own width (default: drawn size × k). The panel passes a very wide one so the table
// always fills the sidebar and grows with it.
export function tableSvg(c, data, k = 1, out = 0) {
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
  const Wo = out || Math.round(W * k)
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + Wo + '" height="' + Math.round(H * Wo / W) + '" viewBox="0 0 ' + W + ' ' + H + '" font-family="Microsoft YaHei UI, PingFang SC, Segoe UI, sans-serif">'
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
