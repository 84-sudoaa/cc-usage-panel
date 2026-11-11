// Detail rows: [date, project, model, account, input, cacheWrite, cacheRead, output, calls]
export type UsageRow = [string, string, string, string, number, number, number, number, number]

export type UsageData = {
  version: string
  generated: string
  today: string
  since: string
  weights: number[]
  accounts: string[]
  files: number
  rows: UsageRow[]
}

export type UsageView = {
  range: number        // 7 / 14 / 30, 0 = all
  acct: string         // 'all' or an account name
  metric: string       // eff / raw / out
  group: string        // acct / proj / model
  showTable: boolean
  scale: number        // text size: 1 standard, 1.25 large, 1.5 extra large (saved across sessions)
  isLoading: boolean
  isDone: boolean      // a refresh the person asked for just finished
  isUpdating: boolean
  error: string
  notice: string       // one-line message under the buttons (update result, first-scan hint)
  data: UsageData | null
}

declare module 'claude-code' {
  interface PluginState {
    'cc-usage-panel': { view: Shaped<UsageView> }
  }
}
