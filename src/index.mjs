/**
 * dsh-reminder-clock — host half.
 *
 * Owns one thing: the reminder schedule, persisted as JSON on the Host disk so
 * it survives a browser cache wipe, a different browser, and a port change.
 *
 *   GET  /api/reminder-clock/config    -> { ok, config, source }
 *   POST /api/reminder-clock/config    <- { config }  -> { ok, config }
 *   GET  /api/reminder-clock/holidays?year=2026,2027   -> { ok, years, fetchedAt, provider }
 *   POST /api/reminder-clock/holidays?year=2026        -> force a network re-sync, same shape
 *
 * Both routes are loopback-only (browser same-origin fence): the socket must be
 * loopback, the Host header must name a loopback authority, and a present Origin
 * must match it. Nothing here reads credentials or session data, and the files
 * only ever hold a local clock schedule plus a public holiday calendar.
 *
 * The holiday route talks to the network: it retrieves the national statutory
 * holiday arrangement, caches it on disk, and falls back to the snapshot bundled
 * in ./holidays.mjs. Retrieval prefers the Host's own `web` service
 * (`ctx.get('web').fetch`) so a configured fetch provider/proxy is respected,
 * and falls back to global fetch. It stays offline while `calendar.sync` is
 * false (an explicit POST still syncs).
 *
 * Zero third-party runtime dependencies: node:fs / node:os / node:path, plus
 * either the `web` service or global fetch.
 *
 * The client half lives in ./client/index.js (served at
 * /plugins/dsh-reminder-clock/client.js through the package ./client export).
 * It mirrors this route's job — it can also reach the provider directly — so a
 * Host that predates the route still gets a synced calendar.
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { BUNDLED_HOLIDAYS, BUNDLED_HOLIDAYS_PROVIDER } from './holidays.mjs'
// 配置契约与客户端共用一份（esbuild 会把它内联进两个产物）。
import { clampInt, defaultConfig, normalizeConfig } from './shared/config.mjs'

/** Stable cordis plugin name. */
export const name = 'reminder-clock'

/** Services required before the routes can mount. */
export const inject = ['webServer']

/** Cap on JSON request bodies (a schedule is tiny). */
const MAX_JSON_BODY_BYTES = 256 * 1024

/** Runtime holiday cache shape + limits. */
const HOLIDAY_CACHE_VERSION = 1
/** Per-attempt timeout for one provider request. */
const HOLIDAY_SYNC_TIMEOUT_MS = 6000
/** The provider link is flaky, so a transport failure is worth another attempt. */
const HOLIDAY_SYNC_ATTEMPTS = 3
const HOLIDAY_SYNC_BACKOFF_MS = [0, 400, 1200]
const HOLIDAY_MAX_DAYS = 400
const HOLIDAY_MAX_YEARS = 6
/**
 * `?year=` 只接受「内置快照覆盖的年份」再往后放宽一年。
 *
 * 这正是这个插件真正可能用到的年份（快照由 `pnpm fetch-holidays` 每年刷新，
 * 窗口跟着自动前移）。不夹住的话，一个 loopback 页面就能拿任意年份（1970、
 * 2999…）反复逼 host 去打供应商接口。
 */
const SNAPSHOT_YEARS = Object.keys(BUNDLED_HOLIDAYS)
  .map((year) => Number(year))
  .filter((year) => Number.isInteger(year))
  .sort((a, b) => a - b)
const HOLIDAY_MIN_YEAR = SNAPSHOT_YEARS.length > 0 ? SNAPSHOT_YEARS[0] : 1970
const HOLIDAY_MAX_YEAR = (SNAPSHOT_YEARS.length > 0 ? SNAPSHOT_YEARS[SNAPSHOT_YEARS.length - 1] : 9999) + 1
const HOLIDAY_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** DSH home: `$DSH_HOME`, else `~/.dsh` (where the other profiles keep state). */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** Absolute path of the persisted schedule. */
function configPath() {
  return join(dshHome(), 'reminder-clock.json')
}

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** Whether a socket remote address names the loopback range. */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** Request-level trust fence: loopback socket + Host header + same-origin markers. */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket && request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res, status, body) {
  // The requester may already have gone away (the browser aborts a slow
  // holidays GET and falls back to its own fetch), so never write into a dead
  // socket.
  if (res.writableEnded === true || res.destroyed === true) return
  const payload = JSON.stringify(body)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end(payload)
  } catch {
    // A reset socket is not a plugin failure.
  }
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Read the persisted schedule; `undefined` when the file is absent or unreadable. */
function readConfig() {
  try {
    const text = readFileSync(configPath(), 'utf8')
    return normalizeConfig(JSON.parse(text))
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('reminder-clock: config read failed', err)
    return undefined
  }
}

/**
 * Atomically persist the schedule (tmp file + rename on the same volume).
 * @param config - normalized schedule
 */
function writeConfig(config) {
  const target = configPath()
  const tmp = join(dirname(target), 'reminder-clock.json.tmp-' + process.pid)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
  renameSync(tmp, target)
}

/** Absolute path of the runtime holiday cache. */
function holidayCachePath() {
  return join(dshHome(), 'reminder-clock-holidays.json')
}

/** Sanitize one year of holiday data into `{ 'MM-DD': [1|0, name] }`. */
function normalizeHolidayDays(raw) {
  const out = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [key, value] of Object.entries(raw).slice(0, HOLIDAY_MAX_DAYS)) {
    if (!/^\d{2}-\d{2}$/.test(key)) continue
    let rest = null
    let name = ''
    if (Array.isArray(value)) {
      if (value[0] === 1 || value[0] === true) rest = 1
      else if (value[0] === 0 || value[0] === false) rest = 0
      if (typeof value[1] === 'string') name = value[1]
    } else if (typeof value === 'object' && value !== null) {
      if (typeof value.rest === 'number') rest = value.rest === 1 ? 1 : 0
      else if (typeof value.holiday === 'boolean') rest = value.holiday ? 1 : 0
      if (typeof value.name === 'string') name = value.name
    }
    if (rest === null) continue
    out[key] = [rest, name.trim().slice(0, 24)]
  }
  return out
}

/** Read the on-disk holiday cache (empty shape when absent or unreadable). */
function readHolidayCache() {
  const empty = { years: {}, fetchedAt: null, provider: BUNDLED_HOLIDAYS_PROVIDER }
  try {
    const parsed = JSON.parse(readFileSync(holidayCachePath(), 'utf8'))
    const rawYears =
      typeof parsed === 'object' && parsed !== null && typeof parsed.years === 'object' && parsed.years !== null
        ? parsed.years
        : {}
    const years = {}
    for (const [year, days] of Object.entries(rawYears)) {
      if (!/^\d{4}$/.test(year)) continue
      const normalized = normalizeHolidayDays(days)
      if (Object.keys(normalized).length > 0) years[year] = normalized
    }
    return {
      years,
      fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null,
      provider: typeof parsed.provider === 'string' ? parsed.provider : BUNDLED_HOLIDAYS_PROVIDER,
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('reminder-clock: holiday cache read failed', err)
    return empty
  }
}

/** Atomically persist the holiday cache. */
function writeHolidayCache(cache) {
  const target = holidayCachePath()
  const tmp = join(dirname(target), 'reminder-clock-holidays.json.tmp-' + process.pid)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    tmp,
    JSON.stringify(
      {
        version: HOLIDAY_CACHE_VERSION,
        provider: cache.provider,
        fetchedAt: cache.fetchedAt,
        years: cache.years,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  renameSync(tmp, target)
}

/** `timor.tech` payload -> `{ 'MM-DD': [1|0, name] }`. */
function compactProviderPayload(payload) {
  const map = payload !== null && typeof payload === 'object' ? payload.holiday : null
  const out = {}
  if (typeof map !== 'object' || map === null) return out
  for (const [key, entry] of Object.entries(map)) {
    if (typeof entry !== 'object' || entry === null) continue
    const mmdd = typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date.slice(5) : key
    if (!/^\d{2}-\d{2}$/.test(mmdd)) continue
    out[mmdd] = [
      entry.holiday === true ? 1 : 0,
      String(entry.name || '')
        .trim()
        .slice(0, 24),
    ]
  }
  return out
}

/**
 * Build the outbound text fetcher used by the holiday route.
 *
 * Prefers the Host's `web` service so a configured fetch provider (proxy, UA,
 * allow-list) is respected; falls back to global fetch when that service or its
 * provider is unavailable. The service is resolved per call, because it may
 * mount after this plugin does. Both paths return `{ status, text, via }` and
 * throw only when the transport itself failed.
 *
 * @param ctx - host plugin context.
 * @returns async (url, signal) => { status, text, via }
 */
function createTextFetcher(ctx) {
  return async (url, signal) => {
    const web = typeof ctx.get === 'function' ? ctx.get('web') : undefined
    if (web !== undefined && web !== null && typeof web.fetch === 'function') {
      try {
        const result = await web.fetch({ url }, signal)
        const body = result !== null && typeof result === 'object' ? result.body : null
        const text = body !== null && typeof body === 'object' && typeof body.content === 'string' ? body.content : ''
        const status =
          result !== null && typeof result === 'object' && typeof result.statusCode === 'number' ? result.statusCode : 0
        return { status, text, via: 'web' }
      } catch (err) {
        // The service answered with an error (no provider configured, provider
        // down, allow-list refusal). Do NOT silently retry outside it: the
        // service exists precisely to own outbound policy.
        throw new Error('web-service: ' + String((err && err.message) || err))
      }
    }
    if (typeof fetch !== 'function') throw new Error('fetch-unavailable')
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal })
    return { status: res.status, text: await res.text(), via: 'fetch' }
  }
}

/**
 * Retrieve one year from the provider (the plugin's only network call).
 *
 * @param year - four-digit year.
 * @param fetcher - outbound text fetcher from createTextFetcher.
 * @param signal - timeout signal.
 * @returns `{ 'MM-DD': [1|0, name] }`.
 * @throws when the transport failed, the year is unpublished, or the payload is empty.
 */
async function fetchHolidayYear(year, fetcher, signal) {
  const result = await fetcher(BUNDLED_HOLIDAYS_PROVIDER + year, signal)
  if (result.status < 200 || result.status >= 300) throw new Error('HTTP ' + result.status)
  let payload = null
  try {
    payload = JSON.parse(result.text)
  } catch {
    throw new Error('bad-payload')
  }
  const days = compactProviderPayload(payload)
  if (Object.keys(days).length === 0) throw new Error('empty-payload')
  return days
}

/** Run `fetchHolidayYear` under one timeout for the whole request. */
async function fetchHolidayYearTimed(year, fetcher) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), HOLIDAY_SYNC_TIMEOUT_MS)
  try {
    return await fetchHolidayYear(year, fetcher, controller === null ? undefined : controller.signal)
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Provider answers that only mean "nothing published for this year yet". */
const HOLIDAY_BENIGN_ERRORS = ['empty-payload', 'HTTP 404']

/** True when a failed year should not fail the whole sync. */
function isBenignHolidayError(message) {
  return HOLIDAY_BENIGN_ERRORS.some((needle) => message.includes(needle))
}

/**
 * Whether another attempt could help. A 4xx or an unpublished year is the
 * provider's verdict; everything else (connect timeout, reset, 5xx, a `web`
 * service hiccup) is worth retrying, because this link is measurably flaky.
 */
function isRetryableHolidayError(message) {
  if (isBenignHolidayError(message)) return false
  if (message.includes('HTTP 4')) return false
  return true
}

/** Wait `ms` (0 resolves immediately). */
function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** One year, retried across transient failures. */
async function fetchHolidayYearWithRetry(year, fetcher) {
  let lastError = null
  for (let attempt = 0; attempt < HOLIDAY_SYNC_ATTEMPTS; attempt += 1) {
    await sleep(HOLIDAY_SYNC_BACKOFF_MS[attempt] || 0)
    try {
      return await fetchHolidayYearTimed(year, fetcher)
    } catch (err) {
      lastError = err
      const message = String((err && err.message) || err)
      if (!isRetryableHolidayError(message)) throw err
    }
  }
  throw lastError === null ? new Error('sync-failed') : lastError
}

/**
 * `?year=2026,2027` -> 去重、按顺序、最多 HOLIDAY_MAX_YEARS 个**合法年份**
 * （没给参数、或一个都不合法时 = 今年 + 明年）。
 *
 * 合法 = 落在 `[HOLIDAY_MIN_YEAR, HOLIDAY_MAX_YEAR]`（内置快照的覆盖范围 +1）。
 */
function parseYears(searchParams, now) {
  const raw = searchParams.get('year')
  const list = typeof raw === 'string' ? raw.split(',') : []
  const years = []
  for (const entry of list) {
    const year = clampInt(entry, 0, 9999, 0)
    if (year < HOLIDAY_MIN_YEAR || year > HOLIDAY_MAX_YEAR) continue
    if (!years.includes(year)) years.push(year)
    if (years.length >= HOLIDAY_MAX_YEARS) break
  }
  if (years.length === 0) {
    years.push(now.getFullYear(), now.getFullYear() + 1)
  }
  return years
}

/** GET/POST /api/reminder-clock/config. */
async function handleConfigRoute(req, res) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'loopback-only' })
    return
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const stored = readConfig()
    writeJson(res, 200, {
      ok: true,
      config: stored === undefined ? defaultConfig() : stored,
      source: stored === undefined ? 'default' : 'disk',
    })
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const body = await readJsonBody(req)
  if (body === undefined) {
    writeJson(res, 400, { ok: false, error: 'invalid-json-body' })
    return
  }
  const config = normalizeConfig(body.config)
  try {
    writeConfig(config)
  } catch (err) {
    console.error('reminder-clock: config write failed', err)
    writeJson(res, 500, { ok: false, error: 'write-failed', config })
    return
  }
  writeJson(res, 200, { ok: true, config, source: 'disk' })
}

/**
 * GET/POST /api/reminder-clock/holidays?year=2026,2027.
 *
 * GET serves the cached/bundled calendar and only reaches the network when the
 * cache is missing or older than a month (and `calendar.sync` allows it); POST
 * always re-syncs. A failed sync never breaks the route: the cached or bundled
 * calendar is still served, with `syncError` reported.
 */
async function handleHolidaysRoute(req, res, fetcher) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'loopback-only' })
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const now = new Date()
  const years = parseYears(new URL(req.url || '/', 'http://localhost').searchParams, now)
  const refresh = req.method === 'POST'
  const config = readConfig() || defaultConfig()
  const cache = readHolidayCache()
  const fetchedMs = cache.fetchedAt === null ? NaN : Date.parse(cache.fetchedAt)
  const cacheStale = !Number.isFinite(fetchedMs) || now.getTime() - fetchedMs > HOLIDAY_CACHE_MAX_AGE_MS
  const result = {}
  let syncError = null
  // Years are independent, so ask for them in parallel: on a slow link that is
  // one round trip instead of two.
  const synced = await Promise.all(
    years.map(async (year) => {
      const bundled = BUNDLED_HOLIDAYS[year] || {}
      const cached = cache.years[year]
      const fallback = cached !== undefined ? cached : bundled
      const needsSync =
        refresh || (config.calendar.sync && (cached === undefined || cacheStale || Object.keys(fallback).length === 0))
      if (!needsSync) {
        return {
          year,
          days: fallback,
          source: cached !== undefined ? 'cache' : Object.keys(bundled).length > 0 ? 'bundled' : 'none',
          fetched: null,
        }
      }
      try {
        return { year, days: await fetchHolidayYearWithRetry(year, fetcher), source: 'network', fetched: true }
      } catch (err) {
        const message = String((err && err.message) || err)
        if (isBenignHolidayError(message)) {
          // The provider simply has nothing for this year yet (next year's
          // schedule is published late in the year): keep the fallback and do
          // not fail the whole sync.
          return { year, days: fallback, source: Object.keys(bundled).length > 0 ? 'bundled' : 'none', fetched: null }
        }
        return { year, days: fallback, source: 'error', fetched: null, error: message }
      }
    }),
  )
  // 本次真正从网络取到的年份。写盘时要「合并」而不是整体覆盖。
  const fetched = {}
  for (const entry of synced) {
    if (entry.fetched === true) {
      fetched[entry.year] = entry.days
    } else if (entry.error !== undefined && syncError === null) {
      syncError = entry.error
    }
    result[entry.year] = {
      days: entry.days,
      source:
        entry.source === 'error'
          ? Object.keys(BUNDLED_HOLIDAYS[entry.year] || {}).length > 0
            ? 'bundled'
            : 'none'
          : entry.source,
    }
  }
  if (Object.keys(fetched).length > 0) {
    // 读-改-写会丢更新：两个请求交错时（两个浏览器、或页面 GET 撞上设置页
    // POST），后写者会拿自己那份过期快照覆盖掉别人刚抓到的年份。所以写之前
    // 重新读一次磁盘，只把本次拿到的年份合并进去。
    const merged = readHolidayCache()
    merged.years = Object.assign({}, merged.years, fetched)
    merged.fetchedAt = new Date().toISOString()
    merged.provider = BUNDLED_HOLIDAYS_PROVIDER
    try {
      writeHolidayCache(merged)
      cache.years = merged.years
      cache.fetchedAt = merged.fetchedAt
      cache.provider = merged.provider
    } catch (err) {
      console.error('reminder-clock: holiday cache write failed', err)
    }
  }
  const payload = {
    ok: !(refresh && syncError !== null),
    years: result,
    fetchedAt: cache.fetchedAt,
    provider: BUNDLED_HOLIDAYS_PROVIDER,
    syncEnabled: config.calendar.sync,
    syncError,
  }
  if (refresh && syncError !== null) payload.error = 'sync-failed'
  writeJson(res, refresh && syncError !== null ? 502 : 200, payload)
}

/**
 * Mount the /api/reminder-clock routes.
 *
 * `inject = ['webServer']` 保证 apply 只在服务就绪后才跑，所以直接读 `ctx.webServer`
 * 这个（按调用者 fiber 绑定、且带类型）的服务属性；`ctx.get('webServer')` 那种
 * 免 inject 的可选访问在这里是多余的一层。
 *
 * @param ctx - host plugin context carrying webServer.
 */
export function apply(ctx) {
  const webServer = ctx.webServer
  const fetcher = createTextFetcher(ctx)

  const routes = [
    { kind: 'exact', path: '/api/reminder-clock/config', handler: handleConfigRoute },
    {
      kind: 'exact',
      path: '/api/reminder-clock/holidays',
      handler: (req, res) => handleHolidaysRoute(req, res, fetcher),
    },
  ]

  const disposers = routes.map((route) => webServer.register(route))
  ctx.effect(
    () => () => {
      for (const dispose of disposers) dispose()
    },
    'reminder-clock: routes',
  )
}
