/**
 * 两半共用的配置契约：常量、归一化、出厂默认值。
 *
 * host（`src/index.mjs`）用它校验落盘的 JSON，client（`src/client/index.tsx`）
 * 用它兜住 localStorage 镜像与旧 Host 的响应——规则必须一模一样。以前两半各抄
 * 一份，已经漂移过（host 会 `trim()` 时间、client 不会，于是 `" 09:00 "` 在 host
 * 是 `09:00`、在 client 变成 `12:00`），所以收到这一个文件里。
 *
 * 构建时 esbuild 会把本文件**内联进两个产物**（和 `src/holidays.mjs` 一样），
 * 所以它既不产生运行时依赖，也不新增分发文件。
 */

/** 提醒项数量上限（host 与 client 同一口径）。 */
export const MAX_ITEMS = 24
/** 手动「放假 / 补班」日期的条数上限。 */
export const MAX_CALENDAR_OVERRIDES = 400
/** `HH:MM`，24 小时制，必须补零。 */
export const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/** 每个提醒项的适用日：每天 / 仅工作日 / 仅休息日。 */
export const DAY_POLICY_IDS = ['every', 'workday', 'restday']

/**
 * `days` 出现之前的老数据怎么升级：两条出厂提醒都变成「仅工作日」，
 * 这样升级后日历特性立刻生效，而不会在周日还提醒下班。
 */
export const LEGACY_DAY_POLICIES = { lunch: 'workday', offwork: 'workday' }

/** 没配大小周时的工作日（1 = 周一 … 7 = 周日）。 */
export const DEFAULT_BIG_WORKDAYS = [1, 2, 3, 4, 5, 6]
export const DEFAULT_SMALL_WORKDAYS = [1, 2, 3, 4, 5]

/**
 * 浮层位置预设。只保留右侧两个：左边是工作区侧边栏，窗口底部是输入框。
 * `bottom-right` 是默认值（它的面板向上弹，胶囊自身不动）。
 */
export const POSITION_IDS = ['bottom-right', 'top-right']

/** 拖拽位置的锚边，以及像素偏移的上限。 */
export const FREE_ANCHORS = ['left', 'right']
export const FREE_VANCHORS = ['top', 'bottom']
export const FREE_POS_MAX = 20000

/**
 * 去空白 + 截断的字符串，空则回退。
 * @param {unknown} value
 * @param {string} fallback
 * @param {number} max
 * @returns {string}
 */
export function safeString(value, fallback, max) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0) return fallback
  return trimmed.slice(0, max)
}

/**
 * emoji 安全的截断（不会把代理对切开）。
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
export function safeEmoji(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw.length === 0) return fallback
  return Array.from(raw).slice(0, 2).join('')
}

/**
 * 取整并夹到 [min, max]。
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * `YYYY-MM-DD`，且必须是真实存在的日期（`2026-02-31` 会被拒）。
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeDate(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined
  const ms = Date.parse(trimmed + 'T00:00:00Z')
  if (!Number.isFinite(ms)) return undefined
  return new Date(ms).toISOString().slice(0, 10) === trimmed ? trimmed : undefined
}

/**
 * 去重升序的 1..7 星期列表；越界项丢弃，空列表回退到默认。
 * @param {unknown} value
 * @param {number[]} fallback
 * @returns {number[]}
 */
export function normalizeWorkdays(value, fallback) {
  if (!Array.isArray(value)) return fallback.slice()
  const seen = new Set()
  for (const entry of value) {
    const day = typeof entry === 'number' ? entry : Number(entry)
    if (!Number.isInteger(day) || day < 1 || day > 7) continue
    seen.add(day)
  }
  if (seen.size === 0) return fallback.slice()
  return Array.from(seen).sort((a, b) => a - b)
}

/**
 * 单条提醒项。
 * @param {unknown} raw
 * @param {number} index
 * @returns {{ id: string, label: string, emoji: string, time: string, enabled: boolean, days: string, message: string }}
 */
export function normalizeItem(raw, index) {
  const src = typeof raw === 'object' && raw !== null ? raw : {}
  const id = safeString(src.id, 'item-' + (index + 1), 48).replace(/[^A-Za-z0-9_-]/g, '-')
  const time = typeof src.time === 'string' && TIME_RE.test(src.time.trim()) ? src.time.trim() : '12:00'
  return {
    id,
    label: safeString(src.label, '提醒', 24),
    emoji: safeEmoji(src.emoji, '⏰'),
    time,
    enabled: src.enabled !== false,
    days: DAY_POLICY_IDS.includes(src.days) ? src.days : LEGACY_DAY_POLICIES[id] || 'every',
    message: typeof src.message === 'string' ? src.message.trim().slice(0, 120) : '',
  }
}

/**
 * 拖拽后的浮层位置，`null` 表示用角落预设。
 *
 * 存的是「锚边 + 到边的像素距离」而不是绝对坐标，所以窗口缩放后仍贴同一边：
 *   `{ anchor: 'left'|'right', x, vAnchor: 'top'|'bottom', y }`
 * @param {unknown} raw
 * @returns {{ anchor: string, x: number, vAnchor: string, y: number } | null}
 */
export function normalizeFreePos(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const anchor = FREE_ANCHORS.includes(raw.anchor) ? raw.anchor : null
  const vAnchor = FREE_VANCHORS.includes(raw.vAnchor) ? raw.vAnchor : null
  if (anchor === null || vAnchor === null) return null
  return {
    anchor,
    x: clampInt(raw.x, 0, FREE_POS_MAX, 16),
    vAnchor,
    y: clampInt(raw.y, 0, FREE_POS_MAX, 52),
  }
}

/**
 * 日历块：大小周锚点、法定节假日开关、手动覆盖。
 * @param {unknown} raw
 * @returns {{ cycle: { anchor: string, anchorKind: string } | null, bigWorkdays: number[], smallWorkdays: number[], overrides: Record<string, number>, sync: boolean }}
 */
export function normalizeCalendar(raw) {
  const src = typeof raw === 'object' && raw !== null ? raw : {}
  const rawCycle = typeof src.cycle === 'object' && src.cycle !== null ? src.cycle : null
  const anchor = rawCycle === null ? undefined : normalizeDate(rawCycle.anchor)
  const overrides = {}
  const rawOverrides = typeof src.overrides === 'object' && src.overrides !== null ? src.overrides : {}
  for (const [key, value] of Object.entries(rawOverrides).slice(0, MAX_CALENDAR_OVERRIDES)) {
    const date = normalizeDate(key)
    if (date === undefined) continue
    if (value === 1 || value === true) overrides[date] = 1
    else if (value === 0 || value === false) overrides[date] = 0
  }
  return {
    cycle: anchor === undefined ? null : { anchor, anchorKind: rawCycle.anchorKind === 'small' ? 'small' : 'big' },
    bigWorkdays: normalizeWorkdays(src.bigWorkdays, DEFAULT_BIG_WORKDAYS),
    smallWorkdays: normalizeWorkdays(src.smallWorkdays, DEFAULT_SMALL_WORKDAYS),
    overrides,
    sync: src.sync !== false,
  }
}

/**
 * 出厂默认作息：午餐 12:00、下班 18:00，都只在工作日提醒。
 * 客户端与 host 必须给出同一份（host 在文件缺失时用它回响应，client 在
 * 首次加载、设置页「恢复默认」时用它）。
 * @returns {object}
 */
export function defaultConfig() {
  return {
    version: 1,
    enabled: true,
    items: [
      {
        id: 'lunch',
        label: '午餐',
        emoji: '🍚',
        time: '12:00',
        enabled: true,
        days: 'workday',
        message: '干饭干饭！干饭不积极，思想有问题！',
      },
      {
        id: 'offwork',
        label: '下班',
        emoji: '🌇',
        time: '18:00',
        enabled: true,
        days: 'workday',
        message: '牛马收工~',
      },
    ],
    options: { showCountdown: true, snoozeMinutes: 5, graceMinutes: 3, position: 'bottom-right', freePos: null },
    calendar: {
      cycle: null,
      bigWorkdays: DEFAULT_BIG_WORKDAYS.slice(),
      smallWorkdays: DEFAULT_SMALL_WORKDAYS.slice(),
      overrides: {},
      sync: true,
    },
  }
}

/**
 * 整份配置的归一化：不抛异常，也不会返回客户端渲染不了的形状。
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeConfig(raw) {
  const src = typeof raw === 'object' && raw !== null ? raw : {}
  const rawItems = Array.isArray(src.items) ? src.items.slice(0, MAX_ITEMS) : null
  let items = rawItems === null ? defaultConfig().items.map(normalizeItem) : rawItems.map(normalizeItem)
  const seen = new Set()
  items = items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  const rawOptions = typeof src.options === 'object' && src.options !== null ? src.options : {}
  return {
    version: 1,
    enabled: src.enabled !== false,
    items,
    options: {
      showCountdown: rawOptions.showCountdown !== false,
      snoozeMinutes: clampInt(rawOptions.snoozeMinutes, 1, 120, 5),
      graceMinutes: clampInt(rawOptions.graceMinutes, 0, 60, 3),
      position: POSITION_IDS.includes(rawOptions.position) ? rawOptions.position : 'bottom-right',
      freePos: normalizeFreePos(rawOptions.freePos),
    },
    calendar: normalizeCalendar(src.calendar),
  }
}
