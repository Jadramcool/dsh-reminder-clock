// dsh-reminder-clock — browser half (source of truth).
//
// A plain ES module. `scripts/build.mjs` bundles it with esbuild and wraps the
// result in the ModuleLoader handoff contract
// (`window.__ModuleLoader__.load({ id, factory })`), so neither `require` nor
// `__ModuleLoader__` appears here. Only `react` / `react/jsx-runtime` stay
// external (they are platform seed modules the loader hands to the factory);
// the holiday snapshot is bundled in from ../holidays.mjs.
import React from 'react'
import { BUNDLED_HOLIDAYS, BUNDLED_HOLIDAYS_PROVIDER } from '../holidays.mjs'
// 配置契约与 host 共用一份（esbuild 会把它内联进这个 bundle）。
import { clampInt, defaultConfig, normalizeCalendar, normalizeConfig } from '../shared/config.mjs'

/** Loosely typed JSON: Host responses, provider payloads, localStorage mirrors. */
type Json = Record<string, any>
const { useEffect, useRef, useState } = React
const useStore =
  React.useSyncExternalStore ||
  function useStoreShim(subscribeFn, getSnapshot) {
    const [, force] = useState(0)
    useEffect(() => subscribeFn(() => force((n) => n + 1)), [subscribeFn])
    return getSnapshot()
  }
const API = '/api/reminder-clock/config'
const API_HOLIDAYS = '/api/reminder-clock/holidays'
/** The provider the Host route uses; this page may also reach it directly. */
const HOLIDAY_PROVIDER_URL = 'https://timor.tech/api/holiday/year/'
/** Runtime holiday data older than this is re-synced automatically (30 days). */
const HOLIDAY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Retry a missing year at most once a day, so an unpublished year is cheap. */
const HOLIDAY_RETRY_MS = 24 * 60 * 60 * 1000
/** No sync layer may hang the page: hard timeouts per request. */
const HOLIDAY_HOST_TIMEOUT_MS = 8000
const HOLIDAY_DIRECT_TIMEOUT_MS = 8000
/** The provider link is measurably flaky: one immediate second try. */
const HOLIDAY_DIRECT_ATTEMPTS = 2
const CONFIG_KEY = 'dsh.reminderClock.v1'
const FIRED_KEY = 'dsh.reminderClock.fired.v1'
const MUTED_KEY = 'dsh.reminderClock.muted.v1'
const HOLIDAY_KEY = 'dsh.reminderClock.holidays.v1'
/**
 * 两个预设的锚点偏移：**CSS 与拖拽吸附共用这一张表**，改偏移只改这里。
 * 右下用 `column-reverse`，所以面板向上弹出、胶囊原地不动。
 */
const POSITION_ANCHORS = {
  'bottom-right': { right: 16, bottom: 10 },
  'top-right': { right: 16, top: 80 },
}
const POSITIONS = [
  { id: 'bottom-right', label: '右下角（默认；面板向上弹）' },
  { id: 'top-right', label: '右上角（面板向下弹）' },
]
/** 每个提醒项的适用日（id 必须与共享模块的 `DAY_POLICY_IDS` 一致）。 */
const DAY_POLICIES = [
  { id: 'every', label: '每天' },
  { id: 'workday', label: '仅工作日' },
  { id: 'restday', label: '仅休息日' },
]
/** 周一 … 周日的短名，下标 = 星期数 - 1。 */
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
/** 内置快照 + Host/本地缓存合并后的日历表：`{ '2026': { 'MM-DD': [rest, name] } }`。 */
let mergedHolidays = mergeHolidayMaps(BUNDLED_HOLIDAYS, {})
const CSS = `
.drc-root{position:fixed;z-index:60;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:"Segoe UI Variable Text","Segoe UI",-apple-system,"PingFang SC","Microsoft YaHei UI",sans-serif;color:var(--dsw-alias-label-primary,#1b1e26)}
.drc-root.pos-top-right{top:${POSITION_ANCHORS['top-right'].top}px;right:${POSITION_ANCHORS['top-right'].right}px;align-items:flex-end}
.drc-root.pos-bottom-right{bottom:${POSITION_ANCHORS['bottom-right'].bottom}px;right:${POSITION_ANCHORS['bottom-right'].right}px;align-items:flex-end;flex-direction:column-reverse}
.drc-root.drc-free{align-items:flex-start}
.drc-root.drc-free.drc-free-right{align-items:flex-end}
.drc-root.drc-free.drc-free-up{flex-direction:column-reverse}
.drc-root.drc-dragging{cursor:grabbing;user-select:none}
.drc-root.drc-dragging .drc-pill{cursor:grabbing}
.drc-card,.drc-pill,.drc-panel{pointer-events:auto;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(20,24,35,.10));border-radius:14px;box-shadow:0 10px 30px rgba(15,20,35,.16),0 1px 2px rgba(15,20,35,.10)}
.drc-pill{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border:none;border-radius:999px;font:inherit;font-size:12.5px;cursor:grab;touch-action:none;transition:transform .12s ease,box-shadow .12s ease}
.drc-pill:hover{transform:translateY(-1px);box-shadow:0 12px 26px rgba(15,20,35,.2)}
.drc-pill-emoji{font-size:14px;line-height:1}
.drc-pill-label{font-weight:600;color:var(--dsw-alias-label-primary,#1b1e26)}
.drc-pill-time{font-variant-numeric:tabular-nums;font-weight:700;color:var(--dsw-alias-brand-primary,#3b82f6)}
.drc-pill-hint{color:var(--dsw-alias-label-secondary,#5b6472);font-weight:500}
.drc-card{width:288px;padding:14px;display:flex;flex-direction:column;gap:10px;border-color:var(--dsw-alias-brand-primary,#3b82f6);animation:drc-in .22s ease both}
@keyframes drc-in{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:none}}
.drc-card-head{display:flex;align-items:center;gap:9px}
.drc-card-emoji{font-size:24px;line-height:1}
.drc-card-title{font-size:14px;font-weight:700}
.drc-card-at{font-size:11.5px;color:var(--dsw-alias-label-secondary,#5b6472);font-variant-numeric:tabular-nums}
.drc-card-msg{margin:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5b6472);word-break:break-word}
.drc-card-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.drc-btn{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;padding:5px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(20,24,35,.12));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);cursor:pointer;font:inherit;font-size:12px;transition:background .12s ease,color .12s ease}
.drc-btn:hover{background:rgba(127,140,165,.12);color:var(--dsw-alias-label-primary,#1b1e26)}
.drc-btn-primary{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;font-weight:600}
.drc-btn-primary:hover{background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;filter:brightness(1.06)}
.drc-btn:disabled{opacity:.5;cursor:default}
.drc-panel{width:280px;padding:12px;display:flex;flex-direction:column;gap:8px}
.drc-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.drc-panel-title{font-size:13px;font-weight:700;flex:none}
.drc-row,.drc-holiday{display:grid;grid-template-columns:20px minmax(0,1fr) 40px 58px 62px;gap:6px;align-items:center;padding:5px 6px;border-radius:9px;font-size:12.5px}
.drc-row:hover{background:rgba(127,140,165,.10)}
.drc-row-emoji{text-align:center}
.drc-row-label,.drc-holiday-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drc-row-time,.drc-holiday-date{font-variant-numeric:tabular-nums;text-align:right;color:var(--dsw-alias-label-secondary,#5b6472)}
.drc-row-in,.drc-holiday-in{font-variant-numeric:tabular-nums;font-weight:700;text-align:right;color:var(--dsw-alias-brand-primary,#3b82f6)}
.drc-row-off{color:var(--dsw-alias-label-secondary,#5b6472);font-size:11.5px}
.drc-row-next{background:rgba(59,130,246,.10)}
.drc-hint{margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5b6472)}
.drc-panel-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(20,24,35,.08));padding-top:8px}
.drc-holiday{background:var(--dsw-alias-bg-base,rgba(20,24,35,.04))}
.drc-holiday-on{background:var(--dsw-alias-bg-overlay,#fff);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-warn-primary,#b45309)}
.drc-holiday-name{font-weight:700}
.drc-holiday-days{justify-self:center;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5b6472);white-space:nowrap}
.drc-holiday-on .drc-holiday-in{color:var(--dsw-alias-state-warn-primary,#b45309)}
.drc-settings{max-width:760px;display:flex;flex-direction:column;gap:18px;font-size:13px;color:var(--dsw-alias-label-primary,#1b1e26)}
.drc-sec-head h2{margin:0 0 4px;font-size:15px;font-weight:700}
.drc-sec-head p{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5b6472)}
.drc-group{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1,rgba(20,24,35,.10));border-radius:12px;padding:12px}
.drc-group-title{font-size:12.5px;font-weight:700;display:flex;align-items:center;justify-content:space-between;gap:8px}
.drc-item{display:grid;grid-template-columns:24px 56px minmax(80px,1fr) 104px 92px 64px 68px;gap:8px;align-items:center;padding:2px 0}
.drc-item-head{display:grid;grid-template-columns:24px 56px minmax(80px,1fr) 104px 92px 64px 68px;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#5b6472);padding:0 2px}
.drc-item-head span{white-space:nowrap}
.drc-more{grid-column:1;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);cursor:pointer;font:inherit;font-size:11px;line-height:1}
.drc-more:hover{background:rgba(127,140,165,.14)}
.drc-more-set{color:var(--dsw-alias-brand-primary,#3b82f6)}
.drc-item-more{grid-column:1 / -1;display:flex;align-items:center;gap:8px;padding:2px 2px 6px}
.drc-item-more .drc-input{flex:1;min-width:0}
.drc-item-more .drc-sub{flex:none}
.drc-input{box-sizing:border-box;width:100%;height:30px;border:1px solid var(--dsw-alias-border-l2,rgba(20,24,35,.2));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1b1e26);padding:0 8px;font:inherit;font-size:12.5px}
.drc-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b82f6);box-shadow:0 0 0 2px rgba(59,130,246,.16)}
.drc-input-emoji{text-align:center;padding:0}
.drc-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#5b6472);white-space:nowrap;cursor:pointer}
.drc-options{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}
.drc-num{width:72px}
.drc-select{height:30px;border:1px solid var(--dsw-alias-border-l2,rgba(20,24,35,.2));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1b1e26);padding:0 6px;font:inherit;font-size:12.5px}
.drc-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.drc-status{font-size:12px;color:var(--dsw-alias-label-secondary,#5b6472)}
.drc-status-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}
.drc-status-err{color:var(--dsw-alias-state-error-primary,#dc2626)}
.drc-warn{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-warn-primary,#b45309)}
.drc-empty{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#5b6472)}
.drc-day-chip{display:inline-flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#5b6472)}
.drc-day-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#16a34a);flex:none}
.drc-day-rest .drc-day-dot{background:var(--dsw-alias-state-warn-primary,#b45309)}
.drc-tag{justify-self:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;font-size:10.5px;padding:1px 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(20,24,35,.12));color:var(--dsw-alias-label-secondary,#5b6472);white-space:nowrap}
.drc-tag-skip{color:var(--dsw-alias-state-warn-primary,#b45309);border-color:currentColor}
.drc-weekdays{display:flex;gap:4px;flex-wrap:wrap}
.drc-weekday{width:26px;height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(20,24,35,.2));border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#5b6472);font:inherit;font-size:12px;cursor:pointer}
.drc-weekday-on{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;font-weight:700}
.drc-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary,#5b6472);margin:0}
.drc-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.drc-date{width:138px}
.drc-override-list{display:flex;flex-wrap:wrap;gap:6px}
.drc-override{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1,rgba(20,24,35,.12));border-radius:8px}
.drc-override-x{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);cursor:pointer;font:inherit;padding:0 2px}
.drc-daytag{font-size:11.5px;color:var(--dsw-alias-label-secondary,#5b6472)}
@media(prefers-reduced-motion:reduce){.drc-card{animation:none}.drc-pill{transition:none}}
`
// ---- helpers ----------------------------------------------------------
/** `HH:MM` -> seconds since midnight (0 when malformed). */
function timeToSeconds(time) {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(String(time || ''))
  if (match === null) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60
}
/** Local midnight of the day containing `ms`. */
function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
/** Local `YYYY-MM-DD` key. */
function dayKey(ms) {
  const d = new Date(ms)
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
// ---- calendar (大小周 + 法定节假日) ------------------------------------
/** `YYYY-MM-DD` -> local midnight ms (NaN when malformed). */
function dateAtMidnight(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (match === null) return NaN
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
/** Monday-based weekday number: 1 = Monday … 7 = Sunday. */
function weekdayNumber(ms) {
  return ((new Date(ms).getDay() + 6) % 7) + 1
}
/** Local midnight of the Monday of the week containing `ms`. */
function mondayOf(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}
/** Built-in snapshot merged with runtime data, per year (runtime wins). */
function mergeHolidayMaps(bundled, runtime) {
  const merged = {}
  for (const [year, days] of Object.entries(bundled !== null && typeof bundled === 'object' ? bundled : {})) {
    merged[year] = days
  }
  for (const [year, days] of Object.entries(runtime !== null && typeof runtime === 'object' ? runtime : {})) {
    if (days !== null && typeof days === 'object' && Object.keys(days).length > 0) merged[year] = days
  }
  return merged
}
/** `[1|0, name]` for a `YYYY-MM-DD` key, or undefined when that day is ordinary. */
function holidayEntry(key) {
  const year = mergedHolidays[key.slice(0, 4)]
  if (year === undefined || year === null) return undefined
  const entry = year[key.slice(5)]
  return Array.isArray(entry) ? entry : undefined
}
/** `'big' | 'small' | null` for the week containing `ms`. */
function cycleKind(ms, calendar) {
  const cycle = calendar !== null && typeof calendar === 'object' ? calendar.cycle : null
  if (cycle === null || cycle === undefined) return null
  const anchor = dateAtMidnight(cycle.anchor)
  if (!Number.isFinite(anchor)) return null
  const weeks = Math.round((mondayOf(ms) - mondayOf(anchor)) / (7 * 86400000))
  const index = ((weeks % 2) + 2) % 2
  const first = cycle.anchorKind === 'small' ? 'small' : 'big'
  if (index === 0) return first
  return first === 'big' ? 'small' : 'big'
}
/**
 * Workday/restday verdict for the day containing `ms`, plus why.
 * Precedence: manual override > statutory holiday / make-up workday > 大小周
 * > plain weekend (Mon–Fri by default).
 */
function dayInfo(ms, config) {
  const calendar =
    config !== null && config !== undefined && config.calendar !== undefined && config.calendar !== null
      ? config.calendar
      : normalizeCalendar(undefined)
  const key = dayKey(ms)
  const week = cycleKind(ms, calendar)
  const override = calendar.overrides[key]
  if (override === 1) return { kind: 'restday', reason: 'override', name: '手动放假', week }
  if (override === 0) return { kind: 'workday', reason: 'override', name: '手动补班', week }
  const entry = holidayEntry(key)
  if (entry !== undefined) {
    return entry[0] === 1
      ? { kind: 'restday', reason: 'holiday', name: holidayFamily(entry[1] || '法定节假日'), week }
      : { kind: 'workday', reason: 'makeup', name: entry[1] || '调休补班', week }
  }
  const weekday = weekdayNumber(ms)
  if (week !== null) {
    const workdays = week === 'big' ? calendar.bigWorkdays : calendar.smallWorkdays
    return {
      kind: workdays.indexOf(weekday) >= 0 ? 'workday' : 'restday',
      reason: week === 'big' ? 'bigweek' : 'smallweek',
      name: week === 'big' ? '大周' : '小周',
      week,
    }
  }
  return weekday <= 5
    ? { kind: 'workday', reason: 'weekday', name: '', week: null }
    : { kind: 'restday', reason: 'weekend', name: '', week: null }
}
/** Whether an item is due on that kind of day. */
function itemApplies(item, info) {
  if (item.days === 'workday') return info.kind === 'workday'
  if (item.days === 'restday') return info.kind === 'restday'
  return true
}
/** `'' | '明天' | '后天' | '周三'` for a forward day offset. */
function dayOffsetLabel(offset, atMs) {
  if (offset <= 0) return ''
  if (offset === 1) return '明天'
  if (offset === 2) return '后天'
  return '周' + WEEKDAY_LABELS[weekdayNumber(atMs) - 1]
}
/** One-line day summary: `工作日 · 大周`, `休息日 · 国庆节`, … */
function dayInfoLabel(info) {
  const base = info.kind === 'workday' ? '工作日' : '休息日'
  if (info.reason === 'override' || info.reason === 'holiday' || info.reason === 'makeup') {
    return base + ' · ' + info.name
  }
  if (info.week !== null) return base + ' · ' + info.name
  return info.kind === 'restday' ? base + ' · 周末' : base
}
/** 日期键的短文案：`09-30 周三`。 */
function dayChipLabel(ms) {
  const key = dayKey(ms)
  return key.slice(5) + ' 周' + WEEKDAY_LABELS[weekdayNumber(ms) - 1]
}
/** 适用日的短名。 */
function dayPolicyLabel(days) {
  const found = DAY_POLICIES.find((policy) => policy.id === days)
  return found === undefined ? '每天' : found.label
}

/** 一个连续假期：名称、首日、末日、段内出现过的其他节日名。 */
type HolidayRun = { name: string; startMs: number; endMs: number; also: string[] }

/** 整日差（跨 DST 也正确）。 */
function daysBetween(fromMs, toMs) {
  return Math.round((startOfDay(toMs) - startOfDay(fromMs)) / 86400000)
}

/** 春节是按天记名的（除夕 / 初一到初七 / 春节），统一成一个名字。 */
function holidayFamily(name) {
  return /^(除夕|初[一二三四五六七八九十]|春节)$/.test(name) ? '春节' : name
}

/**
 * 把「放假日」按**连续**合并成假期段。
 *
 * 一次连休在数据里可能是逐日命名的（2025 春节 = 除夕 + 初一到初七），也可能
 * 混着两个节日（2025-10-01~08 = 国庆 + 中秋 + 国庆），所以合并条件只看「日期
 * 是否连在一起」，段名取首日的节名，其余节名放进 `also`（悬浮提示里会带上）。
 *
 * 数据源 = 内置快照 ⊕ Host/本地运行时的合并表（`mergedHolidays`），外加设置里
 * 手动标的「放假」；同一天手动标了就用手动那条（手动优先）。
 */
function holidayRuns(config): HolidayRun[] {
  const byDay = new Map<number, string>()
  for (const year of Object.keys(mergedHolidays)) {
    const days = mergedHolidays[year]
    if (days === null || typeof days !== 'object') continue
    for (const [monthDay, entry] of Object.entries(days as Json)) {
      if (!Array.isArray(entry) || entry[0] !== 1) continue
      const ms = dateAtMidnight(year + '-' + monthDay)
      if (!Number.isFinite(ms)) continue
      const name = typeof entry[1] === 'string' && entry[1].length > 0 ? entry[1] : '法定节假日'
      byDay.set(ms, holidayFamily(name))
    }
  }
  for (const [key, value] of Object.entries(config.calendar.overrides)) {
    if (value !== 1) continue
    const ms = dateAtMidnight(key)
    if (Number.isFinite(ms)) byDay.set(ms, '手动放假')
  }
  const ordered = Array.from(byDay.entries()).sort((a, b) => a[0] - b[0])
  const runs: HolidayRun[] = []
  for (const [ms, name] of ordered) {
    const last = runs[runs.length - 1]
    if (last !== undefined && addDays(last.endMs, 1) === ms) {
      last.endMs = ms
      if (last.name !== name && last.also.indexOf(name) < 0) last.also.push(name)
      continue
    }
    runs.push({ name, startMs: ms, endMs: ms, also: [] })
  }
  return runs
}

/** 最近的假期：今天在假期中就给今天这一段，否则给下一段。 */
function nearestHoliday(nowMs, config) {
  const today = startOfDay(nowMs)
  const run = holidayRuns(config).find((candidate) => candidate.endMs >= today)
  if (run === undefined) return null
  const days = daysBetween(run.startMs, run.endMs) + 1
  const label = (ms) => dayKey(ms).slice(5) + ' 周' + WEEKDAY_LABELS[weekdayNumber(ms) - 1]
  const title =
    label(run.startMs) +
    ' – ' +
    label(run.endMs) +
    '，共 ' +
    days +
    ' 天' +
    (run.also.length > 0 ? '（含 ' + run.also.join('、') + '）' : '')
  if (run.startMs <= today) {
    const index = daysBetween(run.startMs, today) + 1
    const left = days - index
    return {
      name: run.name,
      days,
      startMs: run.startMs,
      ongoing: true,
      text: left <= 0 ? '最后一天' : '还剩 ' + left + ' 天',
      title,
    }
  }
  const away = daysBetween(today, run.startMs)
  return {
    name: run.name,
    days,
    startMs: run.startMs,
    ongoing: false,
    text: away <= 1 ? '明天开始' : '还有 ' + away + ' 天',
    title,
  }
}
/** `HH:MM:SS` (or `MM:SS` under an hour) for a millisecond span. */
function formatSpan(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0 ? hours + ':' + pad(minutes) + ':' + pad(seconds) : pad(minutes) + ':' + pad(seconds)
}
/** `HH:MM` from a `HH:MM` string (identity when already normalized). */
function formatClock(seconds) {
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return pad(Math.floor(seconds / 3600)) + ':' + pad(Math.floor((seconds % 3600) / 60))
}
/** Error to one short line. */
function messageOf(err) {
  if (err && typeof err.message === 'string' && err.message.length > 0) return err.message
  return String(err)
}
/** localStorage read (never throws). */
function readLocal(key) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}
/** localStorage write (never throws). */
function writeLocal(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // A full or blocked storage must not break a reminder.
  }
}
/** 拖拽后的自由位置；`null` = 用角落预设。 */
type FreePos = { anchor: 'left' | 'right'; x: number; vAnchor: 'top' | 'bottom'; y: number } | null

/** Deep copy of a config (draft editing never mutates the live one). */
function cloneConfig(config) {
  const calendar = normalizeCalendar(config.calendar)
  return {
    version: 1,
    enabled: config.enabled !== false,
    items: config.items.map((item) => ({
      id: item.id,
      label: item.label,
      emoji: item.emoji,
      time: item.time,
      enabled: item.enabled !== false,
      days: item.days,
      message: item.message,
    })),
    options: {
      showCountdown: config.options.showCountdown !== false,
      snoozeMinutes: config.options.snoozeMinutes,
      graceMinutes: config.options.graceMinutes,
      position: config.options.position,
      freePos:
        config.options.freePos === null || config.options.freePos === undefined
          ? null
          : Object.assign({}, config.options.freePos),
    },
    calendar: {
      cycle: calendar.cycle === null ? null : { anchor: calendar.cycle.anchor, anchorKind: calendar.cycle.anchorKind },
      bigWorkdays: calendar.bigWorkdays.slice(),
      smallWorkdays: calendar.smallWorkdays.slice(),
      overrides: Object.assign({}, calendar.overrides),
      sync: calendar.sync !== false,
    },
  }
}
// ---- store ------------------------------------------------------------
const listeners = new Set<() => void>()
let state = {
  status: 'loading',
  config: defaultConfig(),
  configRev: 0,
  error: null,
  nowMs: Date.now(),
  alert: null,
  snoozes: [],
  saveState: 'idle',
  saveError: null,
  holidays: {
    years: {},
    fetchedAt: null,
    attemptedAt: null,
    provider: BUNDLED_HOLIDAYS_PROVIDER,
    source: 'bundled',
    channel: null,
    syncEnabled: true,
    note: null,
  },
  holidaySync: 'idle',
  holidaySyncVia: null,
  holidaySyncError: null,
}
/** Current store snapshot (stable identity between mutations). */
function getState() {
  return state
}
/** Subscribe one listener; returns the unsubscribe function. */
function subscribe(fn) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
/** Patch the store and notify. */
function setState(patch) {
  state = Object.assign({}, state, patch)
  for (const listener of Array.from(listeners)) {
    try {
      listener()
    } catch (err) {
      console.error('reminder-clock: listener failed', err)
    }
  }
}
/** Install a config as the live one (bumps `configRev`). */
function setConfig(raw) {
  setState({ config: normalizeConfig(raw), configRev: state.configRev + 1 })
}
/**
 * 设置页订阅的 store 切片。
 *
 * `configRev` 只覆盖配置本身，而保存 / 同步这些异步状态（`saveState`、
 * `holidaySync`…）不会 bump 它；只订阅 `configRev` 的话「保存中…」「保存失败」
 * 「同步失败」永远画不出来，保存按钮还会一直置灰。这里把要显示的字段拼成一个
 * 字符串，交给 `Object.is` 比较：值没变就照旧 bail out，一秒一次的心跳不会
 * 牵动设置页。
 */
function settingsSnapshot() {
  return (
    state.configRev +
    '|' +
    state.status +
    '|' +
    state.saveState +
    '|' +
    String(state.saveError) +
    '|' +
    state.holidaySync +
    '|' +
    String(state.holidaySyncVia) +
    '|' +
    String(state.holidaySyncError) +
    '|' +
    String(state.error)
  )
}
// ---- fired / muted bookkeeping ---------------------------------------
/**
 * `{ 'YYYY-MM-DD': [itemId] }` 的解析缓存。
 *
 * 引擎每秒会调 `nextReminder()`（最坏要扫 21 天，也就是 21 次读取），而
 * `localStorage.getItem + JSON.parse` 是同步 API：不缓存的话每秒要解好几次。
 * 缓存 1 秒（与 tick 同频），本页写入时立刻同步进缓存；另一个标签页的写入
 * 最多晚 1 秒被看到，和引擎节奏一致。
 */
const FIRED_CACHE_MS = 1000
let firedCache = null
/** `{ 'YYYY-MM-DD': [itemId] }` for the last few days. */
function firedMap() {
  const nowMs = Date.now()
  if (firedCache !== null && nowMs < firedCache.expiresAt) return firedCache.map
  const raw = readLocal(FIRED_KEY)
  const map = typeof raw === 'object' && raw !== null ? raw : {}
  firedCache = { map, expiresAt: nowMs + FIRED_CACHE_MS }
  return map
}
/** Item ids already fired on `day`. */
function firedIds(day) {
  const list = firedMap()[day]
  return new Set(Array.isArray(list) ? list : [])
}
/** Record one fire, keeping only the newest three days. */
function markFired(day, id) {
  const map = firedMap()
  const set = new Set(Array.isArray(map[day]) ? map[day] : [])
  set.add(id)
  map[day] = Array.from(set)
  const kept = Object.keys(map).sort().slice(-3)
  const next = {}
  for (const key of kept) next[key] = map[key]
  writeLocal(FIRED_KEY, next)
  // 缓存换成刚写下去的那一份，并且顺手续期，免得同一秒里又读一次 localStorage。
  firedCache = { map: next, expiresAt: Date.now() + FIRED_CACHE_MS }
}
/** The muted day key, if any. */
function mutedDay() {
  const value = readLocal(MUTED_KEY)
  return typeof value === 'string' ? value : null
}
/** Silence the rest of today. */
function muteToday() {
  writeLocal(MUTED_KEY, dayKey(Date.now()))
  setState({ alert: null, snoozes: [] })
}
/** Un-silence today. */
function unmuteToday() {
  try {
    window.localStorage.removeItem(MUTED_KEY)
  } catch {
    // ignore
  }
  setState({ configRev: state.configRev + 1 })
}
// ---- holiday calendar (data layer) -------------------------------------
/**
 * Three sources, best-effort, never fatal:
 *
 *   1. the Host route (GET/POST /api/reminder-clock/holidays) — a shared
 *      disk cache, but only present once the Host half has been reloaded;
 *   2. the provider straight from this page — the provider sends
 *      `Access-Control-Allow-Origin: *`, so no Host code is needed at all;
 *   3. the snapshot inlined into this bundle (+ the localStorage mirror).
 *
 * An automatic load never escalates a failure to the UI: an unreachable
 * source just means the snapshot answers. Only the explicit 立即同步 button
 * reports which of (1)/(2) worked, or why both failed.
 */
/** Install runtime holiday data, refresh the merged map, and notify. */
function setHolidays(years, meta) {
  const runtime = Object.assign({}, state.holidays.years, years)
  const next = Object.assign({}, state.holidays, meta, { years: runtime })
  mergedHolidays = mergeHolidayMaps(BUNDLED_HOLIDAYS, runtime)
  writeLocal(HOLIDAY_KEY, {
    years: runtime,
    fetchedAt: next.fetchedAt,
    attemptedAt: next.attemptedAt,
  })
  setState({ holidays: next, configRev: state.configRev + 1 })
}
/** Restore the last holiday data this browser saw (offline first paint). */
function loadLocalHolidays() {
  const raw = readLocal(HOLIDAY_KEY)
  if (raw === null || raw === undefined || typeof raw !== 'object') return
  const years = typeof raw.years === 'object' && raw.years !== null ? raw.years : {}
  if (Object.keys(years).length === 0) return
  mergedHolidays = mergeHolidayMaps(BUNDLED_HOLIDAYS, years)
  setState({
    holidays: Object.assign({}, state.holidays, {
      years,
      source: 'local',
      channel: 'browser',
      fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null,
      attemptedAt: typeof raw.attemptedAt === 'string' ? raw.attemptedAt : null,
    }),
  })
}
/** Years the countdown search may need. */
function holidaysWantedYears(nowMs) {
  const year = new Date(nowMs).getFullYear()
  return [year, year + 1]
}
/** True when any wanted year has no data at all (e.g. next year's schedule). */
function holidayYearsIncomplete(years) {
  return years.some((year) => {
    const days = mergedHolidays[year]
    return days === undefined || days === null || Object.keys(days).length === 0
  })
}
/**
 * Whether an automatic sync is worth attempting: `calendar.sync` is on, and
 * either a wanted year is missing or the runtime data is over a month old —
 * and the last attempt was more than a day ago (so an unpublished next year
 * costs at most one request a day instead of one per page load).
 */
function shouldAttemptSync(nowMs) {
  if (!state.config.calendar.sync) return false
  const years = holidaysWantedYears(nowMs)
  const fetchedMs = state.holidays.fetchedAt === null ? NaN : Date.parse(state.holidays.fetchedAt)
  const fresh = Number.isFinite(fetchedMs) && nowMs - fetchedMs <= HOLIDAY_MAX_AGE_MS
  if (fresh && !holidayYearsIncomplete(years)) return false
  const attemptedMs = state.holidays.attemptedAt === null ? NaN : Date.parse(state.holidays.attemptedAt)
  if (Number.isFinite(attemptedMs) && nowMs - attemptedMs <= HOLIDAY_RETRY_MS) return false
  return true
}
/** `{ 'MM-DD': [1|0, name] }` from the provider payload (mirrors the Host half). */
function parseProviderPayload(payload: Json | null) {
  const source = payload !== null && typeof payload === 'object' ? ((payload as Json).holiday as Json | null) : null
  if (source === null || typeof source !== 'object') return {}
  const days: Json = {}
  for (const entry of Object.values(source) as Json[]) {
    if (entry === null || typeof entry !== 'object') continue
    const date = typeof entry.date === 'string' ? entry.date : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const name = typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : '节假日'
    days[date.slice(5)] = [entry.holiday === true ? 1 : 0, name.slice(0, 24)]
  }
  return days
}
/** One fetch under a hard timeout, so a slow layer can never stall the page. */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, controller === null ? init : Object.assign({}, init, { signal: controller.signal }))
  } finally {
    if (timer !== null) window.clearTimeout(timer)
  }
}
/** Provider answers that are verdicts (do not retry them), not hiccups. */
function isHolidayVerdict(message) {
  return message.includes('empty-payload') || message.includes('HTTP 4')
}
/** Ask the Host route. Throws when the half is stale (404/401) or unreachable. */
async function fetchHolidaysFromHost(method, years) {
  const res = await fetchWithTimeout(
    API_HOLIDAYS + '?year=' + years.join(','),
    {
      method,
      headers: { accept: 'application/json' },
    },
    HOLIDAY_HOST_TIMEOUT_MS,
  )
  const data = await res.json().catch(() => null)
  if (data === null || typeof data !== 'object' || typeof data.years !== 'object' || data.years === null) {
    throw new Error('HTTP ' + res.status)
  }
  if (method === 'POST' && res.ok !== true) {
    throw new Error(typeof data.syncError === 'string' ? data.syncError : 'HTTP ' + res.status)
  }
  const incoming = {}
  let source = 'bundled'
  for (const [year, entry] of Object.entries((data as Json).years as Json) as [string, Json][]) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.days !== null && typeof entry.days === 'object' && Object.keys(entry.days).length > 0)
      incoming[year] = entry.days
    if (entry.source === 'network' || entry.source === 'cache') source = entry.source
  }
  return {
    years: incoming,
    meta: {
      fetchedAt: typeof data.fetchedAt === 'string' ? data.fetchedAt : null,
      provider: typeof data.provider === 'string' ? data.provider : BUNDLED_HOLIDAYS_PROVIDER,
      source,
      channel: 'host',
      syncEnabled: data.syncEnabled !== false,
    },
  }
}
/** Ask the provider directly from this page. Throws when every year failed. */
async function fetchHolidaysDirect(years) {
  const settled = await Promise.allSettled(
    years.map(async (year) => {
      let lastError = null
      for (let attempt = 0; attempt < HOLIDAY_DIRECT_ATTEMPTS; attempt += 1) {
        try {
          // A plain GET with a simple header: no preflight, and the provider
          // answers `Access-Control-Allow-Origin: *`.
          const res = await fetchWithTimeout(
            HOLIDAY_PROVIDER_URL + year,
            { headers: { accept: 'application/json' } },
            HOLIDAY_DIRECT_TIMEOUT_MS,
          )
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const days = parseProviderPayload(await res.json())
          if (Object.keys(days).length === 0) throw new Error('empty-payload')
          return { year, days }
        } catch (err) {
          lastError = err
          if (isHolidayVerdict(messageOf(err))) break
        }
      }
      throw lastError === null ? new Error('unreachable') : lastError
    }),
  )
  const incoming = {}
  const failures = []
  for (const item of settled) {
    if (item.status === 'fulfilled') incoming[item.value.year] = item.value.days
    else failures.push(messageOf(item.reason))
  }
  if (Object.keys(incoming).length === 0) {
    throw new Error(failures[0] === undefined ? 'unreachable' : failures[0])
  }
  return {
    years: incoming,
    meta: {
      fetchedAt: new Date().toISOString(),
      provider: BUNDLED_HOLIDAYS_PROVIDER,
      source: 'network',
      channel: 'browser',
      syncEnabled: state.config.calendar.sync,
    },
  }
}
/** Load on startup: local mirror -> Host route -> provider -> bundled snapshot. */
async function loadHolidays() {
  loadLocalHolidays()
  const nowMs = Date.now()
  const years = holidaysWantedYears(nowMs)
  let note = null
  try {
    const host = await fetchHolidaysFromHost('GET', years)
    setHolidays(host.years, Object.assign({ attemptedAt: state.holidays.attemptedAt }, host.meta))
    return
  } catch (err) {
    // A Host half without the route (or offline) is expected, not an error.
    note = messageOf(err)
  }
  if (shouldAttemptSync(nowMs)) {
    setState({ holidays: Object.assign({}, state.holidays, { attemptedAt: new Date().toISOString() }) })
    try {
      const direct = await fetchHolidaysDirect(years)
      setHolidays(direct.years, Object.assign({ attemptedAt: new Date().toISOString() }, direct.meta))
      return
    } catch (err) {
      note = messageOf(err)
    }
  }
  setHolidays({}, { source: 'bundled', channel: null, note })
}
/** Force a re-sync now (the settings page button): Host route, then direct. */
async function syncHolidays() {
  setState({ holidaySync: 'syncing', holidaySyncVia: null, holidaySyncError: null })
  const years = holidaysWantedYears(Date.now())
  const failures = []
  try {
    const host = await fetchHolidaysFromHost('POST', years)
    setHolidays(host.years, Object.assign({ attemptedAt: new Date().toISOString(), note: null }, host.meta))
    setState({ holidaySync: 'done', holidaySyncVia: 'host' })
  } catch (err) {
    failures.push('Host: ' + messageOf(err))
    try {
      const direct = await fetchHolidaysDirect(years)
      setHolidays(direct.years, Object.assign({ attemptedAt: new Date().toISOString(), note: null }, direct.meta))
      setState({ holidaySync: 'done', holidaySyncVia: 'browser' })
    } catch (err2) {
      failures.push('浏览器: ' + messageOf(err2))
      setState({
        holidaySync: 'error',
        holidaySyncError: failures.join('；'),
        holidays: Object.assign({}, state.holidays, { note: failures.join('；') }),
      })
    }
  }
  window.setTimeout(() => {
    if (state.holidaySync === 'done') setState({ holidaySync: 'idle' })
  }, 2600)
}
// ---- engine -----------------------------------------------------------
/** Seconds elapsed since `time` today (negative before it). */
function secondsSince(time, nowMs) {
  const now = new Date(nowMs)
  const elapsed = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
  return elapsed - timeToSeconds(time)
}
/** How many days ahead the countdown looks for an applicable reminder. */
const NEXT_DAY_SCAN = 21
/** Local midnight of `base` plus `offset` calendar days (DST-safe). */
function addDays(base, offset) {
  const d = new Date(base)
  d.setDate(d.getDate() + offset)
  return d.getTime()
}
/**
 * The upcoming reminder: a live snooze wins, else the earliest applicable
 * item scanning forward from today (a workday-only item skips the weekend,
 * a 大小周 rest day, and a statutory holiday).
 */
function nextReminder(config, nowMs, snoozes) {
  const pending = snoozes.filter((entry) => entry.atMs > nowMs).sort((a, b) => a.atMs - b.atMs)[0]
  const base = startOfDay(nowMs)
  let best = null
  for (let offset = 0; offset < NEXT_DAY_SCAN && best === null; offset += 1) {
    const dayStart = addDays(base, offset)
    const info = dayInfo(dayStart, config)
    const fired = firedIds(dayKey(dayStart))
    for (const item of config.items) {
      if (!item.enabled) continue
      if (offset === 0 && fired.has(item.id)) continue
      if (!itemApplies(item, info)) continue
      const atMs = dayStart + timeToSeconds(item.time) * 1000
      if (atMs <= nowMs) continue
      if (best === null || atMs < best.atMs) {
        best = { item, atMs, tomorrow: offset > 0, dayOffset: offset, info, snooze: false }
      }
    }
  }
  if (pending !== undefined && (best === null || pending.atMs < best.atMs)) {
    return { item: pending.item, atMs: pending.atMs, tomorrow: false, dayOffset: 0, snooze: true }
  }
  return best
}
/** Raise the alert card for one item. */
function fire(item) {
  setState({ alert: { item, atMs: Date.now() }, nowMs: Date.now() })
}
/** One engine step: fire whatever is due, then refresh the clock. */
function tick() {
  const nowMs = Date.now()
  const config = state.config
  const quiet = !config.enabled || mutedDay() === dayKey(nowMs)
  if (state.alert === null && !quiet) {
    const due = state.snoozes.filter((entry) => entry.atMs <= nowMs).sort((a, b) => a.atMs - b.atMs)[0]
    if (due !== undefined) {
      setState({ snoozes: state.snoozes.filter((entry) => entry !== due) })
      fire(due.item)
      return
    }
    const day = dayKey(nowMs)
    const fired = firedIds(day)
    const grace = config.options.graceMinutes * 60
    const info = dayInfo(nowMs, config)
    for (const item of config.items) {
      if (!item.enabled || fired.has(item.id)) continue
      if (!itemApplies(item, info)) continue
      const since = secondsSince(item.time, nowMs)
      if (since >= 0 && since <= grace) {
        markFired(day, item.id)
        fire(item)
        return
      }
    }
  }
  setState({ nowMs })
}
let tickHandle = null
/** Start the 1s engine (idempotent). */
function startEngine() {
  if (tickHandle !== null) return
  tickHandle = window.setInterval(() => {
    try {
      tick()
    } catch (err) {
      console.error('reminder-clock: tick failed', err)
    }
  }, 1000)
  tick()
}
/** Stop the 1s engine (idempotent). */
function stopEngine() {
  if (tickHandle === null) return
  window.clearInterval(tickHandle)
  tickHandle = null
}
// ---- persistence ------------------------------------------------------
let loaded = false
/** 「保存中…」的兜底上限：超过就当作失败，别把按钮永远置灰。 */
const SAVE_TIMEOUT_MS = 12000
/** Options the browser owns when an older host half drops them on save. */
const CLIENT_OPTION_FALLBACKS = {
  freePos: (value) => value === null || typeof value === 'object',
}
/** Top-level config keys owned by the browser for the same reason. */
const CLIENT_CONFIG_FALLBACKS = ['calendar']
/**
 * A host half that predates a field strips it from the stored config, so a
 * host response that OMITS the key must not revert the mirrored value — that
 * is the window between updating the plugin and the restart that reloads the
 * host module. Once the host does return the key, its value wins unchanged.
 */
function carryClientFields(target, rawHostConfig, mirror) {
  const raw = rawHostConfig !== null && typeof rawHostConfig === 'object' ? rawHostConfig : {}
  const rawOptions = raw.options !== null && typeof raw.options === 'object' ? raw.options : {}
  const mirrorOptions =
    mirror !== null && mirror !== undefined && typeof mirror.options === 'object' && mirror.options !== null
      ? mirror.options
      : {}
  for (const [key, valid] of Object.entries(CLIENT_OPTION_FALLBACKS) as [string, (value: unknown) => boolean][]) {
    if (Object.prototype.hasOwnProperty.call(rawOptions, key)) continue
    if (valid(mirrorOptions[key])) target.options[key] = mirrorOptions[key]
  }
  for (const key of CLIENT_CONFIG_FALLBACKS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) continue
    if (mirror !== null && mirror !== undefined && mirror[key] !== undefined) target[key] = mirror[key]
  }
  // Per-item fields, matched by id (both halves slug ids identically).
  const rawItems = Array.isArray(raw.items) ? raw.items : []
  const mirrorItems = mirror !== null && mirror !== undefined && Array.isArray(mirror.items) ? mirror.items : []
  if (rawItems.length === 0 || mirrorItems.length === 0) return
  const mirrorById = new Map()
  for (const entry of mirrorItems) {
    if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') mirrorById.set(entry.id, entry)
  }
  for (const item of target.items) {
    const rawItem = rawItems.find(
      (candidate) => candidate !== null && typeof candidate === 'object' && candidate.id === item.id,
    )
    if (rawItem !== undefined && Object.prototype.hasOwnProperty.call(rawItem, 'days')) continue
    const mirrorItem = mirrorById.get(item.id)
    if (mirrorItem !== undefined && typeof mirrorItem.days === 'string') item.days = mirrorItem.days
  }
}
/** Read the local mirror first so the pill is right on the first paint. */
function loadLocalConfig() {
  const raw = readLocal(CONFIG_KEY)
  if (raw !== undefined && raw !== null && typeof raw === 'object') setConfig(raw)
}
/** Hydrate from the Host route, keeping the local mirror authoritative on failure. */
async function loadConfig() {
  if (loaded) return
  loaded = true
  loadLocalConfig()
  const mirror = readLocal(CONFIG_KEY)
  try {
    const res = await fetch(API, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    if (data !== null && typeof data === 'object' && data.ok === true && data.config !== undefined) {
      const hostConfig = normalizeConfig(data.config)
      carryClientFields(hostConfig, data.config, mirror)
      setConfig(hostConfig)
      writeLocal(CONFIG_KEY, hostConfig)
      setState({ status: 'ready', error: null })
      return
    }
    setState({ status: 'ready' })
  } catch (err) {
    setState({ status: 'ready', error: messageOf(err) })
  }
}
/** Persist a draft to the Host (and to the local mirror immediately). */
async function saveConfig(draft) {
  const config = normalizeConfig(draft)
  setConfig(config)
  writeLocal(CONFIG_KEY, config)
  setState({ saveState: 'saving', saveError: null })
  // 兜底：fetch 卡住（Host 半挂了但连接没断）时也必须让按钮回到可用状态。
  const guard = window.setTimeout(() => {
    if (state.saveState === 'saving') {
      setState({ saveState: 'error', saveError: '保存超时（Host 未响应）' })
    }
  }, SAVE_TIMEOUT_MS)
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    if (data !== null && typeof data === 'object' && data.ok === true && data.config !== undefined) {
      // The echo is normalized by whatever host half is loaded; keep a
      // client-owned field the host did not echo back (see
      // `carryClientFields`) instead of flipping the toggle back.
      const echoed = normalizeConfig(data.config)
      carryClientFields(echoed, data.config, config)
      setConfig(echoed)
      writeLocal(CONFIG_KEY, echoed)
    }
    setState({ saveState: 'saved', saveError: null })
    window.setTimeout(() => {
      if (state.saveState === 'saved') setState({ saveState: 'idle' })
    }, 2400)
  } catch (err) {
    setState({ saveState: 'error', saveError: messageOf(err) })
  } finally {
    window.clearTimeout(guard)
  }
}
// ---- components -------------------------------------------------------
/** Render-failure fence: a broken card must never take the shell down. */
class Boundary extends React.Component<{ children?: React.ReactNode }, { failed: boolean }> {
  constructor(props: { children?: React.ReactNode }) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error('reminder-clock: render failed', error)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}
/** The fired-reminder card. */
function AlertCard(props) {
  const { alert, snoozeMinutes, onDismiss, onSnooze, onMute } = props
  const item = alert.item
  const clock = formatClock(timeToSeconds(item.time))
  return (
    <div className="drc-card" role="alert" aria-live="assertive">
      <div className="drc-card-head">
        <span className="drc-card-emoji" aria-hidden="true">
          {item.emoji}
        </span>
        <div>
          <div className="drc-card-title">{item.label}</div>
          <div className="drc-card-at">{clock + ' 到点了'}</div>
        </div>
      </div>
      {item.message.length > 0 ? <p className="drc-card-msg">{item.message}</p> : null}
      <div className="drc-card-actions">
        <button type="button" className="drc-btn" onClick={onMute}>
          今天不再提醒
        </button>
        <button type="button" className="drc-btn" onClick={onSnooze}>
          {snoozeMinutes + ' 分钟后再说'}
        </button>
        <button type="button" className="drc-btn drc-btn-primary" onClick={onDismiss}>
          知道了
        </button>
      </div>
    </div>
  )
}
/** The always-on countdown pill (hover or click to open the schedule, drag to move). */
function CountdownPill(props) {
  const { config, nowMs, open, onToggle, onHoverStart, onHoverEnd, onDragStart, onDragMove, onDragEnd, onDragCancel } =
    props
  const dragProps = {
    onPointerDown: onDragStart,
    onPointerMove: onDragMove,
    onPointerUp: onDragEnd,
    onPointerCancel: onDragCancel,
  }
  const next = nextReminder(config, nowMs, state.snoozes)
  if (next === null) {
    const anyEnabled = config.items.some((item) => item.enabled)
    return (
      <button
        type="button"
        className="drc-pill"
        onClick={onToggle}
        onMouseEnter={onHoverStart}
        onMouseLeave={onHoverEnd}
        aria-expanded={open}
        aria-label={
          anyEnabled
            ? '近期没有会提醒的项，悬停或点开查看，可拖动换位置'
            : '没有启用的提醒项，悬停或点开查看，可拖动换位置'
        }
        {...dragProps}
      >
        <span className="drc-pill-hint">{anyEnabled ? '近期无提醒' : '未设置提醒'}</span>
      </button>
    )
  }
  const span = next.atMs - nowMs
  const prefix = next.snooze ? '稍后' : dayOffsetLabel(next.dayOffset || 0, next.atMs)
  return (
    <button
      type="button"
      className="drc-pill"
      onClick={onToggle}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      aria-expanded={open}
      aria-label={
        prefix.length > 0
          ? '下一条：' + prefix + ' ' + next.item.time + '「' + next.item.label + '」，可拖动换位置'
          : '距离「' + next.item.label + '」还有 ' + formatSpan(span) + '，悬停或点开查看今日安排，可拖动换位置'
      }
      {...dragProps}
    >
      <span className="drc-pill-emoji" aria-hidden="true">
        {next.item.emoji}
      </span>
      <span className="drc-pill-label">{next.item.label}</span>
      <span className="drc-pill-time">{formatSpan(span)}</span>
      {prefix.length > 0 ? <span className="drc-pill-hint">{prefix}</span> : null}
    </button>
  )
}
/** Today's schedule, opened by hovering or clicking the pill. */
function SchedulePanel(props) {
  const { config, nowMs, muted, onMute, onUnmute, onHoverStart, onHoverEnd } = props
  const dayStart = startOfDay(nowMs)
  const fired = firedIds(dayKey(nowMs))
  const info = dayInfo(nowMs, config)
  const holiday = nearestHoliday(nowMs, config)
  const next = nextReminder(config, nowMs, state.snoozes)
  const ordered = config.items.slice().sort((a, b) => timeToSeconds(a.time) - timeToSeconds(b.time))
  return (
    <div
      className="drc-panel"
      // 这是悬停展开的非模态浮层，没有焦点管理，所以不用 `role="dialog"`；
      // 带标签的 `region` 才是它真实语义。
      role="region"
      aria-label="今日提醒"
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
    >
      <div className="drc-panel-head">
        <span className="drc-panel-title">今日提醒</span>
        <span className={'drc-day-chip' + (info.kind === 'restday' ? ' drc-day-rest' : '')}>
          <span className="drc-day-dot" aria-hidden="true"></span>
          {dayChipLabel(nowMs) + ' · ' + dayInfoLabel(info)}
        </span>
      </div>
      {ordered.length === 0 ? (
        <p className="drc-empty">还没有提醒项，去 设置 → 作息提醒 添加。</p>
      ) : (
        ordered.map((item) => {
          const atMs = dayStart + timeToSeconds(item.time) * 1000
          const applies = itemApplies(item, info)
          const isNext = next !== null && next.item.id === item.id && (next.dayOffset || 0) === 0
          const delta = atMs - nowMs
          // 只有真的弹过的才叫「已提醒」；过了时间但超出宽限窗口没弹成的，是「已错过」
          // （引擎不会在宽限之外补弹，标成「已提醒」是在骗自己）。
          const firedAlready = fired.has(item.id)
          const state_ = !item.enabled || !applies ? 'off' : firedAlready ? 'past' : delta < 0 ? 'missed' : 'ahead'
          return (
            <div key={item.id} className={'drc-row' + (isNext ? ' drc-row-next' : '')}>
              <span className="drc-row-emoji" aria-hidden="true">
                {item.emoji}
              </span>
              <span className="drc-row-label">{item.label}</span>
              <span className="drc-row-time">{item.time}</span>
              <span className={'drc-tag' + (applies ? '' : ' drc-tag-skip')}>{dayPolicyLabel(item.days)}</span>
              {state_ === 'off' ? (
                <span className="drc-row-in drc-row-off">{applies ? '已关闭' : '今日不提醒'}</span>
              ) : state_ === 'past' ? (
                <span className="drc-row-in drc-row-off">已提醒</span>
              ) : state_ === 'missed' ? (
                <span className="drc-row-in drc-row-off" aria-label="已错过，今天不会再补提醒">
                  已错过
                </span>
              ) : (
                <span className="drc-row-in">{formatSpan(delta)}</span>
              )}
            </div>
          )
        })
      )}
      {holiday !== null ? (
        <div
          className={'drc-holiday' + (holiday.ongoing ? ' drc-holiday-on' : '')}
          aria-label={holiday.name + '：' + holiday.title}
        >
          <span className="drc-row-emoji" aria-hidden="true">
            🎉
          </span>
          <span className="drc-holiday-name">{holiday.name}</span>
          <span className="drc-holiday-date">{dayKey(holiday.startMs).slice(5)}</span>
          <span className="drc-holiday-days">{holiday.days + ' 天假'}</span>
          <span className="drc-holiday-in">{holiday.text}</span>
        </div>
      ) : null}
      <p className="drc-hint">设置 → 作息提醒 可改时间与节假日</p>
      <div className="drc-panel-foot">
        <span className="drc-hint">{muted ? '今天已静音' : '今天正常提醒'}</span>
        {muted ? (
          <button type="button" className="drc-btn" onClick={onUnmute}>
            恢复提醒
          </button>
        ) : (
          <button type="button" className="drc-btn" onClick={onMute}>
            今天不再提醒
          </button>
        )}
      </div>
    </div>
  )
}
/** Hover intent for the schedule panel: open on enter, close shortly after leave. */
const HOVER_OPEN_MS = 130
const HOVER_CLOSE_MS = 240

/** 拖拽：超过这个位移才算拖动（否则仍是一次点击）。 */
const DRAG_THRESHOLD_PX = 4
/** 松手位置离预设锚点多近就吸附。 */
const CORNER_SNAP_PX = 72
/**
 * 拖拽结束后「那次 click 可能跟过来」的时间窗。
 *
 * 鼠标拖完浏览器会补一个 click；触摸拖动一旦超过浏览器的 click slop（约 8–10px，
 * 比本插件的 4px 阈值大），那次 click 就根本不会来。所以只吞时间窗内的点击：
 * 迟到的点击照常开合面板，标记也不会永远挂着把下一次点击吃掉。
 */
const CLICK_SWALLOW_MS = 350

/** 浮层根节点的定位：优先用拖拽出来的自由位置，否则用右侧两个预设。 */
function overlayPlacement(config) {
  const free = config.options.freePos
  if (free === null || free === undefined) {
    return { className: 'pos-' + config.options.position, style: undefined }
  }
  // 窗口变小后别把胶囊留在屏幕外：偏移量按当前视口收一下（只影响渲染，不改配置）。
  const maxX = Math.max(8, (window.innerWidth || 1280) - 48)
  const maxY = Math.max(8, (window.innerHeight || 800) - 44)
  const x = Math.min(free.x, maxX)
  const y = Math.min(free.y, maxY)
  const style: Record<string, string> = {}
  if (free.anchor === 'right') style.right = x + 'px'
  else style.left = x + 'px'
  if (free.vAnchor === 'bottom') style.bottom = y + 'px'
  else style.top = y + 'px'
  return {
    className:
      'drc-free' +
      (free.anchor === 'right' ? ' drc-free-right' : '') +
      (free.vAnchor === 'bottom' ? ' drc-free-up' : ''),
    style,
  }
}

/** 松手位置贴近哪个预设？返回预设 id，否则 null（贴着屏幕极边但离预设远也算自由位置）。 */
function snapCorner(rect, vw, vh) {
  const right = vw - (rect.left + rect.width)
  const top = rect.top
  const bottom = vh - (rect.top + rect.height)
  for (const position of POSITIONS) {
    const anchor = POSITION_ANCHORS[position.id]
    const dy = Math.abs(
      (anchor.top === undefined ? bottom : top) - (anchor.top === undefined ? anchor.bottom : anchor.top),
    )
    if (Math.abs(right - anchor.right) <= CORNER_SNAP_PX && dy <= CORNER_SNAP_PX) return position.id
  }
  return null
}

/**
 * 把松手后的胶囊位置换算成可持久化的自由位置。
 *
 * 用「离哪条边近就锚哪条边」而不是绝对坐标：这样窗口缩放、分辨率变化后仍然
 * 贴着同一边，和四个角落预设的行为一致。水平锚边同时决定弹窗朝哪边长（靠右则
 * 向左展开），垂直锚边决定向下还是向上展开。
 */
function freePosFrom(rect, vw, vh): Exclude<FreePos, null> {
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const anchor = centerX > vw / 2 ? 'right' : 'left'
  const vAnchor = centerY > vh / 2 ? 'bottom' : 'top'
  const maxX = Math.max(8, vw - rect.width - 8)
  const maxY = Math.max(8, vh - rect.height - 8)
  const edgeX = anchor === 'right' ? vw - (rect.left + rect.width) : rect.left
  const edgeY = vAnchor === 'bottom' ? vh - (rect.top + rect.height) : rect.top
  return {
    anchor,
    x: clampInt(edgeX, 8, maxX, 16),
    vAnchor,
    y: clampInt(edgeY, 8, maxY, 52),
  }
}
/** The `shell.overlay` occupant: alert card, countdown pill, schedule panel. */
function OverlayEntry() {
  const snapshot = useStore(subscribe, getState, getState)
  const [open, setOpen] = useState(false)
  const openTimer = useRef(null)
  const closeTimer = useRef(null)
  // 拖拽状态：`dragRef` 是当前手势，`dragging` 只用于加样式（transform 直接写 DOM）。
  const rootRef = useRef(null)
  const dragRef = useRef(null)
  /** 上一次「拖拽结束」的时刻，用于吞掉紧随其后的那次 click（见 CLICK_SWALLOW_MS）。 */
  const swallowClickAt = useRef(0)
  const [dragging, setDragging] = useState(false)
  const cancelTimers = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  useEffect(
    () => () => {
      cancelTimers()
    },
    [],
  )
  // Open immediately on click; open on hover after a short intent delay so a
  // pointer merely crossing the pill does not pop the panel. The delayed
  // close is what lets the pointer travel from the pill into the panel (and
  // over the gap between them) without the panel vanishing. Hover-to-open is
  // fixed behaviour — there is no setting for it.
  const openNow = () => {
    cancelTimers()
    setOpen(true)
  }
  const hoverOpen = () => {
    if (dragRef.current !== null) return
    cancelTimers()
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      setOpen(true)
    }, HOVER_OPEN_MS)
  }
  const hoverClose = () => {
    if (dragRef.current !== null) return
    cancelTimers()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, HOVER_CLOSE_MS)
  }

  // ---- drag to reposition -------------------------------------------------
  // 只把胶囊当把手：它是唯一常驻元素，且拖动时整个浮层（含展开的面板）一起走。
  // 手势用 pointer capture 绑在胶囊上，所以不需要 window 级监听；位移直接写
  // transform（不触发每秒重渲染），松手时才换算成可持久化的锚点位置。
  const dragStart = (event) => {
    if (event.button !== undefined && event.button !== 0) return
    const node = event.currentTarget
    const rect =
      node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function'
        ? node.getBoundingClientRect()
        : { left: event.clientX, top: event.clientY, width: 0, height: 0 }
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect, moved: false }
    if (
      node !== null &&
      node !== undefined &&
      typeof node.setPointerCapture === 'function' &&
      event.pointerId !== undefined
    ) {
      node.setPointerCapture(event.pointerId)
    }
  }
  const dragMove = (event) => {
    const drag = dragRef.current
    if (drag === null) return
    if (drag.pointerId !== undefined && event.pointerId !== undefined && drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return
    drag.moved = true
    if (!dragging) setDragging(true)
    cancelTimers()
    const node = rootRef.current
    if (node !== null && node !== undefined && node.style !== undefined)
      node.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'
  }
  const dragEnd = (event) => {
    const drag = dragRef.current
    if (drag === null) return
    dragRef.current = null
    const node = rootRef.current
    if (node !== null && node !== undefined && node.style !== undefined) node.style.transform = ''
    if (!drag.moved) return
    setDragging(false)
    swallowClickAt.current = Date.now()
    const rect = {
      left: drag.rect.left + (event.clientX - drag.startX),
      top: drag.rect.top + (event.clientY - drag.startY),
      width: drag.rect.width || 0,
      height: drag.rect.height || 0,
    }
    const vw = window.innerWidth || 1280
    const vh = window.innerHeight || 800
    const corner = snapCorner(rect, vw, vh)
    const next = cloneConfig(snapshot.config)
    next.options = Object.assign(
      {},
      next.options,
      corner === null ? { freePos: freePosFrom(rect, vw, vh) } : { freePos: null, position: corner },
    )
    saveConfig(next).catch((err) => {
      console.error('reminder-clock: saving the dragged position failed', err)
    })
  }
  const dragCancel = () => {
    const drag = dragRef.current
    if (drag === null) return
    dragRef.current = null
    setDragging(false)
    const node = rootRef.current
    if (node !== null && node !== undefined && node.style !== undefined) node.style.transform = ''
  }
  const config = snapshot.config
  if (!config.enabled && snapshot.alert === null) return null
  if (snapshot.alert === null && !config.options.showCountdown) return null
  const placement = overlayPlacement(config)
  const children = []
  if (snapshot.alert !== null) {
    children.push(
      <AlertCard
        key="alert"
        alert={snapshot.alert}
        snoozeMinutes={config.options.snoozeMinutes}
        onDismiss={() => setState({ alert: null })}
        onSnooze={() => {
          const alert = state.alert
          if (alert === null) return
          setState({
            alert: null,
            snoozes: state.snoozes.concat([
              {
                item: alert.item,
                atMs: Date.now() + config.options.snoozeMinutes * 60000,
              },
            ]),
          })
        }}
        onMute={muteToday}
      ></AlertCard>,
    )
  } else {
    children.push(
      <CountdownPill
        key="pill"
        config={config}
        nowMs={snapshot.nowMs}
        open={open}
        onToggle={() => {
          // 拖动结束后浏览器通常会补一个 click，别让它把面板开开合合（触碰拖动
          // 超过 click slop 时那次 click 不会来，所以只吞时间窗内的那一次）。
          const swallow = swallowClickAt.current !== 0 && Date.now() - swallowClickAt.current < CLICK_SWALLOW_MS
          swallowClickAt.current = 0
          if (swallow) return
          if (open) setOpen(false)
          else openNow()
        }}
        onHoverStart={hoverOpen}
        onHoverEnd={hoverClose}
        onDragStart={dragStart}
        onDragMove={dragMove}
        onDragEnd={dragEnd}
        onDragCancel={dragCancel}
      ></CountdownPill>,
    )
    if (open) {
      children.push(
        <SchedulePanel
          key="panel"
          config={config}
          nowMs={snapshot.nowMs}
          muted={mutedDay() === dayKey(snapshot.nowMs)}
          onMute={muteToday}
          onUnmute={unmuteToday}
          onHoverStart={openNow}
          onHoverEnd={hoverClose}
        ></SchedulePanel>,
      )
    }
  }
  return (
    <div
      className={'drc-root ' + placement.className + (dragging ? ' drc-dragging' : '')}
      style={placement.style}
      ref={rootRef}
    >
      {children}
    </div>
  )
}
/** One editable schedule row. */
function ItemRow(props) {
  const { item, index, onChange, onRemove } = props
  // 二级配置：提醒文案默认收起来，点箭头才展开（它不进主表格，窄面板也不会被挤扁）。
  const [more, setMore] = useState(false)
  const patch = (fields) => onChange(index, Object.assign({}, item, fields))
  return (
    <div className="drc-item">
      <button
        type="button"
        className={'drc-more' + (more ? ' drc-more-open' : '') + (item.message.length > 0 ? ' drc-more-set' : '')}
        aria-expanded={more}
        aria-label={(more ? '收起' : '展开') + '「' + item.label + '」的提醒文案设置'}
        onClick={() => setMore(!more)}
      >
        {more ? '▾' : '▸'}
      </button>
      <input
        className="drc-input drc-input-emoji"
        value={item.emoji}
        maxLength={4}
        aria-label="图标"
        onChange={(event) => patch({ emoji: event.target.value })}
      ></input>
      <input
        className="drc-input"
        value={item.label}
        maxLength={24}
        placeholder="名称"
        aria-label="名称"
        onChange={(event) => patch({ label: event.target.value })}
      ></input>
      <input
        className="drc-input"
        type="time"
        value={item.time}
        aria-label="时间"
        onChange={(event) => patch({ time: event.target.value })}
      ></input>
      <select
        className="drc-select"
        value={item.days}
        aria-label="适用日"
        onChange={(event) => patch({ days: event.target.value })}
      >
        {DAY_POLICIES.map((policy) => (
          <option key={policy.id} value={policy.id}>
            {policy.label}
          </option>
        ))}
      </select>
      <label className="drc-check">
        <input
          type="checkbox"
          checked={item.enabled}
          onChange={(event) => patch({ enabled: event.target.checked })}
        ></input>
        启用
      </label>
      <button type="button" className="drc-btn" onClick={() => onRemove(index)} aria-label="删除这一项">
        删除
      </button>
      {more ? (
        <div className="drc-item-more">
          <span className="drc-sub">提醒文案</span>
          <input
            className="drc-input"
            value={item.message}
            maxLength={120}
            placeholder="到点时卡片上的正文，可留空（留空则用「到点了」）"
            aria-label="提醒文案"
            onChange={(event) => patch({ message: event.target.value })}
          ></input>
          <span className="drc-sub">{item.message.length + '/120'}</span>
        </div>
      ) : null}
    </div>
  )
}
/** 「节假日：内置快照 · 覆盖 2025、2026 · 同步于 …」一行文案。 */
function holidaysSummary(holidays, years) {
  const source =
    holidays.channel === 'browser'
      ? '浏览器直连'
      : holidays.channel === 'host'
        ? holidays.source === 'network'
          ? 'Host 联网同步'
          : holidays.source === 'cache'
            ? 'Host 磁盘缓存'
            : 'Host 内置快照'
        : holidays.source === 'local'
          ? '本地缓存'
          : '内置快照'
  const parts = ['节假日：' + source]
  if (years.length > 0) parts.push('覆盖 ' + years.join('、'))
  if (typeof holidays.fetchedAt === 'string' && holidays.fetchedAt.length > 0) {
    parts.push('同步于 ' + holidays.fetchedAt.slice(0, 16).replace('T', ' '))
  }
  return parts.join(' · ')
}
/** 工作日 / 大小周 / 法定节假日 设置块。 */
function CalendarPanel(props) {
  const { draft, update } = props
  const calendar = draft.calendar
  const [overrideDate, setOverrideDate] = useState('')
  const [overrideRest, setOverrideRest] = useState('1')
  const today = Date.now()
  const weekStart = mondayOf(today)
  const cycle = calendar.cycle
  const holidays = state.holidays
  const years = Object.keys(mergedHolidays).sort()
  const toggleWorkday = (which, day) =>
    update((next) => {
      const list = next.calendar[which]
      const at = list.indexOf(day)
      if (at >= 0) list.splice(at, 1)
      else list.push(day)
      list.sort((a, b) => a - b)
    })
  const setCycle = (kind) =>
    update((next) => {
      next.calendar.cycle = kind === 'off' ? null : { anchor: dayKey(weekStart), anchorKind: kind }
    })
  const weekdayButtons = (which) => (
    <div className="drc-weekdays">
      {WEEKDAY_LABELS.map((label, index) => {
        const day = index + 1
        const on = calendar[which].indexOf(day) >= 0
        return (
          <button
            key={which + '-' + day}
            type="button"
            className={'drc-weekday' + (on ? ' drc-weekday-on' : '')}
            aria-pressed={on}
            aria-label={'周' + label}
            onClick={() => toggleWorkday(which, day)}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
  const overrides = Object.entries(calendar.overrides).sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return (
    <div className="drc-group">
      <div className="drc-group-title">
        <span>工作日 · 大小周 · 节假日</span>
        <span className="drc-daytag">{dayChipLabel(today) + ' ' + dayInfoLabel(dayInfo(today, draft))}</span>
      </div>
      <label className="drc-check">
        <input
          type="checkbox"
          checked={cycle !== null}
          aria-label="启用大小周排班"
          onChange={() => setCycle(cycle === null ? 'big' : 'off')}
        ></input>
        启用大小周排班
      </label>
      {cycle === null ? (
        <p className="drc-sub">未启用：周一~周五上班，周六周日休息。</p>
      ) : (
        <div className="drc-inline">
          <span className="drc-sub">{'本周（' + dayKey(weekStart).slice(5) + ' 起）是'}</span>
          <select
            className="drc-select"
            value={cycle.anchorKind}
            aria-label="本周是大周还是小周"
            onChange={(event) => setCycle(event.target.value)}
          >
            <option value="big">大周</option>
            <option value="small">小周</option>
          </select>
          <span className="drc-sub">之后大小周交替</span>
        </div>
      )}
      {cycle === null ? null : (
        <div className="drc-inline">
          <span className="drc-sub">大周工作日</span>
          {weekdayButtons('bigWorkdays')}
        </div>
      )}
      {cycle === null ? null : (
        <div className="drc-inline">
          <span className="drc-sub">小周工作日</span>
          {weekdayButtons('smallWorkdays')}
        </div>
      )}
      <label className="drc-check">
        <input
          type="checkbox"
          checked={calendar.sync}
          aria-label="自动同步国家法定节假日"
          onChange={(event) =>
            update((next) => {
              next.calendar.sync = event.target.checked
            })
          }
        ></input>
        自动同步国家法定节假日
      </label>
      <div className="drc-inline">
        <span className="drc-sub">{holidaysSummary(holidays, years)}</span>
        <button
          type="button"
          className="drc-btn"
          disabled={state.holidaySync === 'syncing'}
          onClick={() => {
            syncHolidays().catch(() => {})
          }}
        >
          {state.holidaySync === 'syncing' ? '同步中…' : '立即同步'}
        </button>
        {state.holidaySync === 'done' ? (
          <span className="drc-status drc-status-ok">
            {state.holidaySyncVia === 'browser' ? '已同步（浏览器直连）' : '已同步（Host）'}
          </span>
        ) : null}
        {state.holidaySync === 'error' ? <span className="drc-status drc-status-err">同步失败</span> : null}
      </div>
      {state.holidaySync === 'error' && state.holidaySyncError !== null ? (
        <p className="drc-warn">
          {'同步失败：' + state.holidaySyncError + '（继续用已有的快照 / 本地缓存，提醒不受影响）'}
        </p>
      ) : null}
      <p className="drc-sub">
        同步优先走 Host（可多浏览器共用缓存），Host 半未重启时自动改用本页直连供应商；都拿不到就用内置快照。
      </p>
      <p className="drc-sub">手动调整：单独指定某天放假或补班，优先于内置节假日表。</p>
      <div className="drc-inline">
        <input
          className="drc-input drc-date"
          type="date"
          value={overrideDate}
          aria-label="日期"
          onChange={(event) => setOverrideDate(event.target.value)}
        ></input>
        <select
          className="drc-select"
          value={overrideRest}
          aria-label="放假还是补班"
          onChange={(event) => setOverrideRest(event.target.value)}
        >
          <option value="1">放假</option>
          <option value="0">补班</option>
        </select>
        <button
          type="button"
          className="drc-btn"
          disabled={!/^\d{4}-\d{2}-\d{2}$/.test(overrideDate)}
          onClick={() => {
            update((next) => {
              next.calendar.overrides[overrideDate] = Number(overrideRest)
            })
            setOverrideDate('')
          }}
        >
          添加
        </button>
      </div>
      {overrides.length === 0 ? null : (
        <div className="drc-override-list">
          {overrides.map(([date, rest]) => (
            <span key={date} className="drc-override">
              {date + ' ' + (rest === 1 ? '放假' : '补班')}
              <button
                type="button"
                className="drc-override-x"
                aria-label={'删除 ' + date}
                onClick={() =>
                  update((next) => {
                    delete next.calendar.overrides[date]
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
/** The `settings.section` page. */
function SettingsSection() {
  // 订阅整块「要显示的」状态切片（配置 + 保存/同步进度 + 错误），否则异步状态
  // 变化不会触发重渲染：「保存中…」会卡死、「同步失败」根本不会出现。
  useStore(subscribe, settingsSnapshot, settingsSnapshot)
  // 草稿只在配置本身变化时跟随（保存/同步的状态变化不该覆盖用户正在编辑的草稿）。
  const rev = state.configRev
  const [draft, setDraft] = useState(() => cloneConfig(state.config))
  const [dirty, setDirty] = useState(false)
  const lastRev = useRef(rev)
  const saveState_ = state.saveState
  const hostError = state.error
  useEffect(() => {
    if (lastRev.current === rev) return
    lastRev.current = rev
    if (!dirty) setDraft(cloneConfig(state.config))
  }, [rev, dirty])
  const update = (mutate) => {
    setDraft((current) => {
      const next = cloneConfig(current)
      mutate(next)
      return next
    })
    setDirty(true)
  }
  const nextId = () => {
    let index = draft.items.length + 1
    while (draft.items.some((item) => item.id === 'item-' + index)) index += 1
    return 'item-' + index
  }
  return (
    <div className="drc-settings">
      <div className="drc-sec-head">
        <h2>作息提醒</h2>
        <p>
          到点后在 DSH
          窗口内弹出提醒卡片；平时右上角显示下一条提醒的倒计时，鼠标悬停即展开今日安排。每条可设适用日，工作日判定支持大小周与法定节假日。改完点「保存」写入
          Host 磁盘，换浏览器、清缓存都不会丢。
        </p>
      </div>
      {hostError !== null ? (
        <p className="drc-warn">{'未连上 Host 配置接口（' + hostError + '），修改只会保存在本浏览器。'}</p>
      ) : null}
      <div className="drc-group">
        <label className="drc-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) =>
              update((next) => {
                next.enabled = event.target.checked
              })
            }
          ></input>
          启用提醒
        </label>
        <p className="drc-hint">关闭后不再弹卡片；下面的倒计时开关仍然有效。</p>
      </div>
      <div className="drc-group">
        <div className="drc-group-title">
          <span>{'提醒项（' + draft.items.length + '）'}</span>
          <button
            type="button"
            className="drc-btn"
            disabled={draft.items.length >= 24}
            onClick={() =>
              update((next) => {
                next.items.push({
                  id: nextId(),
                  label: '新提醒',
                  emoji: '⏰',
                  time: '15:00',
                  enabled: true,
                  days: 'every',
                  message: '',
                })
              })
            }
          >
            + 添加提醒项
          </button>
        </div>
        {draft.items.length === 0 ? (
          <p className="drc-empty">还没有提醒项，点右上角「+ 添加提醒项」。</p>
        ) : (
          <div className="drc-item-head">
            <span></span>
            <span>图标</span>
            <span>名称</span>
            <span>时间</span>
            <span>适用日</span>
            <span>开关</span>
            <span>操作</span>
          </div>
        )}
        {draft.items.map((item, index) => (
          <ItemRow
            key={item.id + '#' + index}
            item={item}
            index={index}
            onChange={(at, nextItem) =>
              update((next) => {
                next.items[at] = nextItem
              })
            }
            onRemove={(at) =>
              update((next) => {
                next.items.splice(at, 1)
              })
            }
          ></ItemRow>
        ))}
      </div>
      <div className="drc-group">
        <div className="drc-group-title">
          <span>提醒行为</span>
        </div>
        <div className="drc-options">
          <label className="drc-check">
            <input
              type="checkbox"
              checked={draft.options.showCountdown}
              onChange={(event) =>
                update((next) => {
                  next.options.showCountdown = event.target.checked
                })
              }
            ></input>
            显示常驻倒计时
          </label>
          <label className="drc-check">
            位置
            <select
              className="drc-select"
              value={draft.options.position}
              onChange={(event) =>
                update((next) => {
                  next.options.position = event.target.value
                  // 选了预设就放弃拖拽位置，否则预设看起来不生效。
                  next.options.freePos = null
                })
              }
            >
              {POSITIONS.map((position) => (
                <option key={position.id} value={position.id}>
                  {position.label}
                </option>
              ))}
            </select>
          </label>
          <span className="drc-sub">
            {draft.options.freePos === null ? (
              '当前跟随上面的预设；也可以直接拖动胶囊到任意位置'
            ) : (
              <>
                {'已自定义位置（拖动胶囊可继续微调）'}
                <button
                  type="button"
                  className="drc-btn"
                  onClick={() =>
                    update((next) => {
                      next.options.freePos = null
                    })
                  }
                >
                  回到预设位置
                </button>
              </>
            )}
          </span>
          <label className="drc-check">
            稍后再提醒
            <input
              className="drc-input drc-num"
              type="number"
              min={1}
              max={120}
              value={draft.options.snoozeMinutes}
              onChange={(event) =>
                update((next) => {
                  next.options.snoozeMinutes = Number(event.target.value)
                })
              }
            ></input>
            分钟
          </label>
          <label className="drc-check">
            错过宽限
            <input
              className="drc-input drc-num"
              type="number"
              min={0}
              max={60}
              value={draft.options.graceMinutes}
              onChange={(event) =>
                update((next) => {
                  next.options.graceMinutes = Number(event.target.value)
                })
              }
            ></input>
            分钟
          </label>
        </div>
        <p className="drc-hint">
          宽限 = 页面没开着时错过的容错窗口：超过这个分钟数就不再补弹，避免打开 DSH 时被一串过期提醒糊脸。
        </p>
      </div>
      <CalendarPanel draft={draft} update={update}></CalendarPanel>
      <div className="drc-actions">
        <button
          type="button"
          className="drc-btn drc-btn-primary"
          disabled={saveState_ === 'saving'}
          onClick={() => {
            saveConfig(draft)
              .then(() => {
                setDirty(false)
              })
              .catch(() => {})
          }}
        >
          {saveState_ === 'saving' ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="drc-btn"
          onClick={() => {
            setDraft(cloneConfig(state.config))
            setDirty(false)
          }}
          disabled={!dirty}
        >
          放弃修改
        </button>
        <button
          type="button"
          className="drc-btn"
          onClick={() => {
            const defaults = defaultConfig()
            setDraft(defaults)
            setDirty(true)
          }}
        >
          恢复默认
        </button>
        <span
          className={
            'drc-status' +
            (saveState_ === 'saved' ? ' drc-status-ok' : '') +
            (saveState_ === 'error' ? ' drc-status-err' : '')
          }
        >
          {saveState_ === 'saved'
            ? '已保存'
            : saveState_ === 'error'
              ? '保存失败：' + String(state.saveError) + '（本地已暂存）'
              : dirty
                ? '有未保存的修改'
                : '已是最新'}
        </span>
      </div>
    </div>
  )
}
// ---- plugin -----------------------------------------------------------
export const name = 'reminder-clock'
export const inject = ['slots']
export function apply(ctx) {
  const style = document.createElement('style')
  style.setAttribute('data-dsh-reminder-clock', '')
  style.textContent = CSS
  document.head.appendChild(style)
  ctx.effect(
    () => () => {
      style.remove()
    },
    'reminder-clock: css',
  )
  ctx.effect(() => {
    startEngine()
    return () => {
      stopEngine()
    }
  }, 'reminder-clock: engine')
  // `inject = ['slots']` 保证 apply 只在槽位服务就绪后才跑，所以直接用 `ctx.slots`
  // （官方插件与文档的写法）；服务代理会把注册的销毁挂到本插件的 fiber 上。
  const slots = ctx.slots
  const OverlaySafe = () => (
    <Boundary>
      <OverlayEntry></OverlayEntry>
    </Boundary>
  )
  const SettingsSafe = () => (
    <Boundary>
      <SettingsSection></SettingsSection>
    </Boundary>
  )
  slots.inject('shell.overlay', () =>
    slots.register(
      {
        name: 'shell.overlay',
        id: 'reminder-clock',
        order: 30,
        label: () => '作息提醒',
      },
      OverlaySafe,
    ),
  )
  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'reminder-clock',
        order: 140,
        label: () => '作息提醒',
      },
      SettingsSafe,
    ),
  )
  loadConfig().catch((err) => {
    setState({ status: 'ready', error: messageOf(err) })
  })
  loadHolidays().catch((err) => {
    console.error('reminder-clock: holiday load failed', err)
  })
}
