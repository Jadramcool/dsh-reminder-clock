/**
 * Regenerate `src/holidays.mjs` — the built-in snapshot of the national
 * statutory holiday calendar (放假日 + 调休补班日).
 *
 *   node scripts/fetch-holidays.mjs            # this year and the next one
 *   node scripts/fetch-holidays.mjs 2026 2027  # explicit years
 *
 * The State Council publishes the next year's arrangement in the autumn, so run
 * this once a year (the runtime `立即同步` button in the settings page refreshes
 * the host's on-disk cache without a rebuild; this script refreshes the snapshot
 * that ships inside the plugin).
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PROVIDER = 'https://timor.tech/api/holiday/year/'
const thisYear = new Date().getFullYear()
const years = process.argv.slice(2).map(Number).filter((year) => Number.isInteger(year) && year > 1970)
const wanted = years.length > 0 ? years : [thisYear, thisYear + 1]

/** `[{ '01-01': { holiday: true, name: '元旦' } }]` -> `{ '01-01': [1, '元旦'] }` */
function compact(payload) {
  const days = {}
  const map = payload && typeof payload === 'object' ? payload.holiday : null
  if (map === null || typeof map !== 'object') return days
  for (const [key, entry] of Object.entries(map)) {
    if (entry === null || typeof entry !== 'object') continue
    const mmdd = typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
      ? entry.date.slice(5)
      : key
    if (!/^\d{2}-\d{2}$/.test(mmdd)) continue
    days[mmdd] = [entry.holiday === true ? 1 : 0, String(entry.name || '').trim()]
  }
  return days
}

const data = {}
const skipped = []
for (const year of wanted) {
  let payload = null
  try {
    const res = await fetch(PROVIDER + year, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    payload = await res.json()
  } catch (err) {
    skipped.push(year + ' (' + err.message + ')')
    continue
  }
  if (!payload || payload.code !== 0) {
    skipped.push(year + ' (provider code ' + (payload && payload.code) + ')')
    continue
  }
  const days = compact(payload)
  const count = Object.keys(days).length
  if (count === 0) {
    skipped.push(year + ' (not published yet)')
    continue
  }
  data[year] = days
  const rest = Object.values(days).filter((entry) => entry[0] === 1).length
  console.log('  ' + year + ': ' + rest + ' rest days, ' + (count - rest) + ' make-up workdays')
}

if (Object.keys(data).length === 0) {
  console.error('nothing fetched; src/holidays.mjs left untouched')
  process.exit(1)
}

const body = JSON.stringify(
  Object.fromEntries(Object.entries(data).map(([year, days]) => [year, days])),
  null,
  2,
).replace(/"(\d{2}-\d{2})": \[/g, "'$1': [").replace(/\]\n/g, '],\n')

const out = `/**
 * 国家法定节假日 + 调休补班日的内置快照，由 scripts/fetch-holidays.mjs 生成，请勿手改。
 *
 * 结构：\`{ 年份: { 'MM-DD': [1, '名称'] } }\`，\`1\` = 放假休息，\`0\` = 调休补班（那天要上班）。
 * 只列特殊日期：没有出现的日子按星期 + 大小周排班判断；插件里手动调整的日期优先级最高。
 *
 * 来源：${PROVIDER}<年份>（timor.tech 聚合的国务院办公厅节假日安排）
 * 生成时间：${new Date().toISOString()}
 * 覆盖年份：${Object.keys(data).join(', ')}
 *
 * 更新方式：\`node scripts/fetch-holidays.mjs\`（host 侧运行时「立即同步」会刷新磁盘缓存，无需重建）。
 */
export const BUNDLED_HOLIDAYS_PROVIDER = ${JSON.stringify(PROVIDER)}

export const BUNDLED_HOLIDAYS = {
${Object.entries(data).map(([year, days]) => '  ' + year + ': {\n' + Object.entries(days).map(([mmdd, entry]) => "    '" + mmdd + "': [" + entry[0] + ", " + JSON.stringify(entry[1]) + '],').join('\n') + '\n  },').join('\n')}
}
`

writeFileSync(fileURLToPath(new URL('../src/holidays.mjs', import.meta.url)), out)
console.log('wrote src/holidays.mjs (' + Object.keys(data).length + ' years)')
if (skipped.length > 0) console.log('skipped: ' + skipped.join(', '))
