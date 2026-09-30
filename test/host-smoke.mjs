// Host-half smoke test: real HTTP server, real disk, no browser.
//   node test/host-smoke.mjs
//
// Covers the /api/reminder-clock routes (config + holidays), config
// normalization, the atomic write, the holiday cache/sync, the loopback fence,
// and method/body rejection.
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(ok, label, detail) {
  if (ok) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const home = mkdtempSync(join(tmpdir(), 'drc-home-'))
process.env.DSH_HOME = home
const configFile = join(home, 'reminder-clock.json')
const holidayFile = join(home, 'reminder-clock-holidays.json')

const mod = await import('../lib/index.mjs')
check(mod.name === 'reminder-clock', 'module exports the stable plugin name')
check(Array.isArray(mod.inject) && mod.inject.includes('webServer'), 'module injects webServer')

const routes = []
const disposers = []
const ctx = {
  // 插件用 `inject = ['webServer']` + `ctx.webServer`（官方写法）；`get` 只留着
  // 供 `createTextFetcher` 读可选的 `web` 服务。
  webServer: {
    register(route) {
      routes.push(route)
      return () => disposers.push(route.path)
    },
  },
  get(name) {
    return name === 'webServer' ? ctx.webServer : undefined
  },
  effect(run) {
    run()
  },
}
mod.apply(ctx)
check(
  routes.length === 2,
  'two exact routes registered',
  routes.map((r) => r.path),
)
check(
  routes.some((r) => r.path === '/api/reminder-clock/config'),
  'config route registered',
)
check(
  routes.some((r) => r.path === '/api/reminder-clock/holidays'),
  'holidays route registered',
)

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  const route = routes.find((candidate) => candidate.kind === 'exact' && candidate.path === pathname)
  if (route === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  Promise.resolve()
    .then(() => route.handler(req, res))
    .catch((err) => {
      res.writeHead(500).end(String(err))
    })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

const post = (body, headers = {}) =>
  fetch(base + '/api/reminder-clock/config', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body,
  })

/**
 * Intercept only the holiday provider, so the test's own HTTP calls keep using
 * the real fetch. Returns a restore function.
 */
function stubProvider(handler) {
  const real = globalThis.fetch
  globalThis.fetch = (url, init) => (String(url).includes('timor.tech') ? handler(url, init) : real(url, init))
  return () => {
    globalThis.fetch = real
  }
}

/** Minimal Response-like for the provider stub (the host reads text bodies). */
function providerResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  }
}

console.log('\nGET /api/reminder-clock/config (no file yet)')
{
  const res = await fetch(base + '/api/reminder-clock/config')
  const body = await res.json()
  check(res.status === 200, 'answers 200')
  check(body.ok === true && body.source === 'default', 'reports the factory default', body.source)
  check(body.config.items.length === 2, 'default has two items', body.config.items)
  check(body.config.items[0].time === '12:00' && body.config.items[1].time === '18:00', 'defaults are 12:00 / 18:00')
  check(body.config.options.position === 'bottom-right', 'default position is bottom-right')
  check(body.config.options.openOnHover === undefined, 'hover-to-open is no longer configurable')
  check(
    body.config.items[0].days === 'workday' && body.config.items[1].days === 'workday',
    'both shipped defaults only remind on workdays',
    body.config.items.map((item) => item.days),
  )
  check(!readFileSafe(), 'a read never writes the file')
}

console.log('\nPOST /api/reminder-clock/config (persist)')
{
  const desired = {
    enabled: true,
    items: [
      { id: 'lunch', label: '午餐', emoji: '🍜', time: '11:45', enabled: true, message: '去吃饭' },
      { id: 'offwork', label: '下班', emoji: '🌇', time: '17:30', enabled: false, message: '' },
    ],
    options: { showCountdown: false, snoozeMinutes: 10, graceMinutes: 0, position: 'bottom-right' },
  }
  const res = await post(JSON.stringify({ config: desired }))
  const body = await res.json()
  check(res.status === 200 && body.ok === true, 'answers 200 ok')
  check(body.config.items[0].time === '11:45' && body.config.items[1].enabled === false, 'echoes the normalized save')
  check(body.config.options.position === 'bottom-right', 'keeps a valid position')
  const onDisk = JSON.parse(readFileSafe() ?? '{}')
  check(onDisk.items?.[0]?.time === '11:45', 'wrote the change to disk')
  check(!readFileSafe().includes('tmp-'), 'no temp file content leaked into the target')
}

console.log('\nGET again')
{
  const res = await fetch(base + '/api/reminder-clock/config')
  const body = await res.json()
  check(body.source === 'disk', 'now served from disk', body.source)
  check(body.config.items[0].emoji === '🍜', 'disk value wins over the default')
}

console.log('\nNormalization of hostile input')
{
  const res = await post(
    JSON.stringify({
      config: {
        items: [
          { id: 'dup', label: '第一', time: '99:99', emoji: 'x', enabled: true },
          { id: 'dup', label: '第二', time: '07:05' },
          { id: 'bad id!', time: '08:00' },
        ],
        options: { snoozeMinutes: 9999, graceMinutes: -3, position: 'nope' },
      },
    }),
  )
  const body = await res.json()
  check(
    body.config.items.length === 2,
    'duplicate ids collapse',
    body.config.items.map((i) => i.id),
  )
  check(body.config.items[0].time === '12:00', 'invalid HH:MM falls back to 12:00')
  check(body.config.items[0].label === '第一', 'first row keeps its label')
  check(body.config.items[1].id === 'bad-id-', 'ids are slugged', body.config.items[1].id)
  check(body.config.options.snoozeMinutes === 120, 'snooze is clamped to 120')
  check(body.config.options.graceMinutes === 0, 'grace is clamped to 0')
  check(body.config.options.position === 'bottom-right', 'unknown position falls back to the default')
  check(body.config.items[0].emoji === 'x', 'emoji survives')
  check(body.config.items[0].days === 'every', 'a row with no days policy reminds every day')
  check(body.config.items[1].days === 'every', 'slugged rows default to every day')
}

console.log('\nConfig: 工作日 / 大小周 / 节假日')
{
  const res = await post(
    JSON.stringify({
      config: {
        items: [
          { id: 'lunch', time: '12:00', days: 'restday' },
          { id: 'offwork', time: '18:00' },
          { id: 'junk', time: '09:00', days: 'nonsense' },
        ],
        calendar: {
          cycle: { anchor: '2026-01-12', anchorKind: 'small' },
          bigWorkdays: [6, 6, 7, 9, 0, '3'],
          smallWorkdays: [],
          overrides: { '2026-10-01': 1, '2026-10-10': 0, '2026-10-11': 'x', nope: 1 },
          sync: false,
        },
      },
    }),
  )
  const body = await res.json()
  const calendar = body.config.calendar
  check(body.config.items[0].days === 'restday', 'keeps an explicit days policy')
  check(body.config.items[1].days === 'workday', 'the legacy 下班 row becomes workday-only')
  check(body.config.items[2].days === 'every', 'an unknown days policy falls back to every day')
  check(
    calendar.cycle.anchor === '2026-01-12' && calendar.cycle.anchorKind === 'small',
    'keeps the 大小周 anchor',
    calendar.cycle,
  )
  check(calendar.bigWorkdays.join(',') === '3,6,7', 'workday list is deduped/sorted/1..7', calendar.bigWorkdays)
  check(calendar.smallWorkdays.join(',') === '1,2,3,4,5', 'an empty workday list falls back', calendar.smallWorkdays)
  check(calendar.overrides['2026-10-01'] === 1 && calendar.overrides['2026-10-10'] === 0, 'keeps manual overrides')
  check(calendar.overrides['2026-10-11'] === undefined && calendar.overrides.nope === undefined, 'drops junk overrides')
  check(calendar.sync === false, 'keeps the sync switch off')
  check(JSON.parse(readFileSafe()).calendar.cycle.anchor === '2026-01-12', 'calendar reaches disk')

  const reset = await post(JSON.stringify({ config: { items: [{ id: 'offwork', time: '18:00' }] } }))
  const resetBody = await reset.json()
  check(resetBody.config.calendar.cycle === null, 'no cycle normalizes to null')
  check(resetBody.config.calendar.overrides['2026-10-01'] === undefined, 'a config without a calendar block resets it')
  check(resetBody.config.calendar.sync === true, 'sync defaults back on')

  // 这一条放最后：它的 POST 会把磁盘上的 calendar 块清掉。
  const legacyRows = await post(
    JSON.stringify({
      config: {
        items: [
          { id: 'lunch', time: '12:00' },
          { id: 'offwork', time: '18:00' },
        ],
      },
    }),
  )
  const legacyDays = (await legacyRows.json()).config.items.map((item) => item.days)
  check(
    legacyDays.join(',') === 'workday,workday',
    'rows written before `days` existed default to workdays',
    legacyDays,
  )
}

console.log('\nConfig: 拖拽位置（freePos）')
{
  const dragged = await post(
    JSON.stringify({
      config: {
        items: [{ id: 'lunch', time: '12:00' }],
        options: { position: 'bottom-right', freePos: { anchor: 'right', x: 120.7, vAnchor: 'bottom', y: 48 } },
      },
    }),
  )
  const draggedBody = await dragged.json()
  check(
    draggedBody.config.options.freePos.anchor === 'right' && draggedBody.config.options.freePos.vAnchor === 'bottom',
    'keeps a dragged position',
    draggedBody.config.options.freePos,
  )
  check(
    draggedBody.config.options.freePos.x === 121 && draggedBody.config.options.freePos.y === 48,
    'rounds the insets',
    draggedBody.config.options.freePos,
  )
  check(
    draggedBody.config.options.position === 'bottom-right',
    'the corner preset is kept alongside',
    draggedBody.config.options.position,
  )

  const junk = await post(
    JSON.stringify({
      config: {
        items: [{ id: 'lunch', time: '12:00' }],
        options: { freePos: { anchor: 'sideways', x: 10, vAnchor: 'top', y: 10 } },
      },
    }),
  )
  check((await junk.json()).config.options.freePos === null, 'an unknown anchor falls back to presets')

  const clamped = await post(
    JSON.stringify({
      config: {
        items: [{ id: 'lunch', time: '12:00' }],
        options: { freePos: { anchor: 'left', x: -50, vAnchor: 'top', y: 999999 } },
      },
    }),
  )
  const clampedPos = (await clamped.json()).config.options.freePos
  check(clampedPos.x === 0 && clampedPos.y === 20000, 'insets are clamped', clampedPos)

  const cleared = await post(JSON.stringify({ config: { items: [{ id: 'lunch', time: '12:00' }] } }))
  check((await cleared.json()).config.options.freePos === null, 'a config without freePos resets to presets')

  // 只有两个右侧预设：老的左上/左下落回右上。
  const legacy = await post(
    JSON.stringify({
      config: { items: [{ id: 'lunch', time: '12:00' }], options: { position: 'top-left' } },
    }),
  )
  check((await legacy.json()).config.options.position === 'bottom-right', 'a removed preset falls back to the default')
}

console.log('\nGET /api/reminder-clock/holidays (bundled, offline)')
{
  // No cache on disk and no reachable provider: the bundled snapshot must answer.
  const restore = stubProvider(() => Promise.reject(new Error('offline')))
  const res = await fetch(base + '/api/reminder-clock/holidays?year=2026,2027')
  const body = await res.json()
  restore()
  check(res.status === 200 && body.ok === true, 'answers 200 ok')
  check(body.years['2026'].source === 'bundled', '2026 comes from the bundled snapshot', body.years['2026'].source)
  check(
    body.years['2026'].days['01-01'][0] === 1 && body.years['2026'].days['01-01'][1] === '元旦',
    'bundled 元旦 is a rest day',
  )
  check(body.years['2026'].days['01-04'][0] === 0, 'bundled 补班 day is a workday')
  check(body.years['2027'].source === 'none', 'an unpublished year reports none', body.years['2027'])
  check(body.provider.includes('timor.tech'), 'reports the provider', body.provider)
}

console.log('\nPOST /api/reminder-clock/holidays (network sync + cache)')
{
  let called = 0
  const restore = stubProvider(async (url) => {
    called += 1
    if (!String(url).includes('2026')) throw new Error('HTTP 404')
    return providerResponse({
      code: 0,
      holiday: {
        '10-01': { holiday: true, name: '国庆节', date: '2026-10-01' },
        '10-10': { holiday: false, name: '国庆节后补班', date: '2026-10-10' },
        bogus: { holiday: true, name: 'no date' },
      },
    })
  })
  const res = await fetch(base + '/api/reminder-clock/holidays?year=2026,2027', { method: 'POST' })
  const body = await res.json()
  restore()
  check(res.status === 200 && body.ok === true, 'answers 200 ok')
  check(called === 2, 'asked the provider once per requested year', called)
  check(body.years['2026'].source === 'network', '2026 now comes from the network', body.years['2026'].source)
  check(
    body.years['2026'].days['10-01'][0] === 1 && body.years['2026'].days['10-10'][0] === 0,
    'parsed rest + make-up days',
  )
  check(body.years['2026'].days.bogus === undefined, 'drops entries without a usable date')
  check(typeof body.fetchedAt === 'string', 'stamps fetchedAt', body.fetchedAt)
  const cache = JSON.parse(readFileSync(holidayFile, 'utf8'))
  check(cache.years['2026']['10-01'][1] === '国庆节', 'cache file holds the fetched year')
}

console.log('\nGET /api/reminder-clock/holidays (cache wins, no network)')
{
  let called = 0
  const restore = stubProvider(() => {
    called += 1
    return Promise.reject(new Error('must not be called'))
  })
  const res = await fetch(base + '/api/reminder-clock/holidays?year=2026')
  const body = await res.json()
  restore()
  check(body.years['2026'].source === 'cache', 'served from the disk cache', body.years['2026'].source)
  check(body.years['2026'].days['10-01'][1] === '国庆节', 'cached value survives')
  check(called === 0, 'a fresh cache does not hit the network', called)
}

console.log('\nhost stays offline when 自动同步 is off')
{
  const off = await post(
    JSON.stringify({ config: { items: [{ id: 'lunch', time: '12:00' }], calendar: { sync: false } } }),
  )
  check((await off.json()).config.calendar.sync === false, 'sync switch is off on disk')
  rmSync(holidayFile, { force: true })
  let called = 0
  const restore = stubProvider(() => {
    called += 1
    return Promise.reject(new Error('must not be called'))
  })
  const res = await fetch(base + '/api/reminder-clock/holidays?year=2026')
  const body = await res.json()
  restore()
  check(called === 0, 'no network call while sync is off', called)
  check(body.years['2026'].source === 'bundled', 'falls back to the bundled snapshot')
  check(body.syncEnabled === false, 'reports syncEnabled false')

  const forcedRestore = stubProvider(async () =>
    providerResponse({
      code: 0,
      holiday: { '05-01': { holiday: true, name: '劳动节', date: '2026-05-01' } },
    }),
  )
  const forced = await fetch(base + '/api/reminder-clock/holidays?year=2026', { method: 'POST' })
  const forcedBody = await forced.json()
  forcedRestore()
  check(forcedBody.years['2026'].days['05-01'][1] === '劳动节', 'an explicit POST still syncs while auto-sync is off')
  const restoreSync = await post(JSON.stringify({ config: { items: [{ id: 'lunch', time: '12:00' }] } }))
  check((await restoreSync.json()).config.calendar.sync === true, 'sync restored for the remaining checks')
}

console.log('\nSync failure keeps serving the fallback')
{
  rmSync(holidayFile, { force: true })
  const restore = stubProvider(() => Promise.reject(new Error('dns failure')))
  const res = await fetch(base + '/api/reminder-clock/holidays?year=2026', { method: 'POST' })
  const body = await res.json()
  restore()
  check(res.status === 502, 'a forced sync that fails answers 502', res.status)
  check(body.ok === false && body.error === 'sync-failed', 'reports sync-failed', body.error)
  check(
    body.years['2026'].days['01-01'] !== undefined,
    'still returns the bundled calendar',
    Object.keys(body.years['2026'].days).length,
  )
  check(
    typeof body.syncError === 'string' && body.syncError.includes('dns'),
    'passes the reason through',
    body.syncError,
  )
}

console.log('\nShared config contract + holiday cache + year window')
{
  // 两半共用 src/shared/config.mjs：时间必须 trim（以前 host 会 trim、client 不会，
  // 于是 `" 09:00 "` 在 host 是 09:00、在 client 变成 12:00）。
  const padded = await post(JSON.stringify({ config: { items: [{ id: 'lunch', time: ' 09:00 ' }] } }))
  check((await padded.json()).config.items[0].time === '09:00', 'a padded time is trimmed, not replaced by 12:00')

  // 年份窗口 = 内置快照覆盖范围（2025…2026）+1；越界年份被忽略，不会去打供应商。
  const asked = []
  const restore = stubProvider(async (url) => {
    asked.push(String(url).slice(-4))
    return providerResponse({
      code: 0,
      holiday: { '05-01': { holiday: true, name: '劳动节', date: String(url).slice(-4) + '-05-01' } },
    })
  })
  const outOfRange = await fetch(base + '/api/reminder-clock/holidays?year=1999,2999')
  const outOfRangeBody = await outOfRange.json()
  check(
    !('1999' in outOfRangeBody.years) && !('2999' in outOfRangeBody.years),
    'out-of-window years are dropped from the answer',
    Object.keys(outOfRangeBody.years),
  )
  check(!asked.includes('1999') && !asked.includes('2999'), 'out-of-window years never reach the provider', asked)
  check(
    Object.keys(outOfRangeBody.years).length === 2,
    'falls back to this year and the next',
    Object.keys(outOfRangeBody.years),
  )
  restore()

  // 两个请求交错（年份不重叠）时，后写者不能把先写者刚抓到的年份覆盖掉。
  rmSync(holidayFile, { force: true })
  const slow = stubProvider(async (url) => {
    if (String(url).includes('2026')) await new Promise((resolve) => setTimeout(resolve, 120))
    const year = String(url).slice(-4)
    return providerResponse({
      code: 0,
      holiday: { '01-01': { holiday: true, name: '元旦', date: year + '-01-01' } },
    })
  })
  const [first, second] = await Promise.all([
    fetch(base + '/api/reminder-clock/holidays?year=2025', { method: 'POST' }),
    fetch(base + '/api/reminder-clock/holidays?year=2026', { method: 'POST' }),
  ])
  slow()
  await first.json()
  await second.json()
  const raced = JSON.parse(readFileSync(holidayFile, 'utf8'))
  check(
    raced.years['2025'] !== undefined && raced.years['2026'] !== undefined,
    'overlapping syncs merge instead of losing a year',
    Object.keys(raced.years),
  )
}

console.log('\nHolidays route rejects bad calls')
{
  const put = await fetch(base + '/api/reminder-clock/holidays', { method: 'PUT' })
  check(put.status === 405, 'PUT -> 405', put.status)
  const rawStatus = new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: '/api/reminder-clock/holidays',
        method: 'GET',
        headers: { host: 'evil.example.com' },
        setHost: false,
      },
      (res) => {
        res.resume()
        resolve(res.statusCode)
      },
    )
    req.on('error', reject)
    req.end()
  })
  check((await rawStatus) === 403, 'the holidays route carries the same fence')
}

console.log('\nHost prefers the DSH `web` service for outbound calls')
{
  // A fresh module instance (query string) so this ctx registers its own routes.
  const modWeb = await import('../lib/index.mjs?web-service')
  const webRoutes = []
  const webCalls = []
  const webCtx = {
    webServer: {
      register(route) {
        webRoutes.push(route)
        return () => {}
      },
    },
    get(name) {
      if (name === 'web') {
        return {
          async fetch(request) {
            webCalls.push(request.url)
            if (request.url.includes('2027')) throw new Error('WEB_PROVIDER_UNAVAILABLE')
            return {
              url: request.url,
              statusCode: 200,
              truncated: false,
              body: {
                kind: 'text',
                content: JSON.stringify({
                  code: 0,
                  holiday: { '05-01': { holiday: true, name: '劳动节', date: '2026-05-01' } },
                }),
              },
            }
          },
        }
      }
      return undefined
    },
    effect() {},
  }
  modWeb.apply(webCtx)
  check(
    webRoutes.length === 2,
    'the web-service instance mounts both routes',
    webRoutes.map((r) => r.path),
  )

  const webServer = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const route = webRoutes.find((candidate) => candidate.kind === 'exact' && candidate.path === pathname)
    if (route === undefined) {
      res.writeHead(404).end('no route')
      return
    }
    Promise.resolve()
      .then(() => route.handler(req, res))
      .catch((err) => {
        res.writeHead(500).end(String(err))
      })
  })
  await new Promise((resolve) => webServer.listen(0, '127.0.0.1', resolve))
  const webBase = 'http://127.0.0.1:' + webServer.address().port

  // Count global fetch usage: the route's own provider call must NOT appear here.
  const realFetch = globalThis.fetch
  let globalCalls = 0
  globalThis.fetch = (url, init) => {
    globalCalls += 1
    return realFetch(url, init)
  }
  const res = await fetch(webBase + '/api/reminder-clock/holidays?year=2026', { method: 'POST' })
  const body = await res.json()
  // A provider failure inside the service must surface as a failed sync (the
  // plugin must not silently bypass the service with its own fetch).
  const bad = await fetch(webBase + '/api/reminder-clock/holidays?year=2027', { method: 'POST' })
  const badBody = await bad.json()
  globalThis.fetch = realFetch
  await new Promise((resolve) => webServer.close(resolve))

  check(res.status === 200 && body.ok === true, 'the route answers 200 through the service', res.status)
  check(
    webCalls.length > 0 && webCalls.every((url) => url.includes('timor.tech')),
    'every provider call went through the web service',
    webCalls,
  )
  check(webCalls.filter((url) => url.includes('2026')).length === 1, 'a good year is fetched once', webCalls)
  check(
    webCalls.filter((url) => url.includes('2027')).length === 3,
    'a failing year is retried (transport is flaky)',
    webCalls,
  )
  check(globalCalls === 2, 'no global fetch besides the test requests themselves', globalCalls)
  check(
    body.years['2026'].source === 'network' && body.years['2026'].days['05-01'][1] === '劳动节',
    'the service body was parsed',
    body.years['2026'],
  )
  check(bad.status === 502, 'a service failure stays a sync failure', bad.status)
  check(
    typeof badBody.syncError === 'string' && badBody.syncError.includes('web-service'),
    'the service error is reported',
    badBody.syncError,
  )
  check(badBody.years['2027'].source === 'none', 'the unavailable year reports none', badBody.years['2027'])
}

console.log('\nRejection paths')
{
  const bad = await post('{not json')
  check(bad.status === 400, 'unparseable body -> 400', bad.status)
  const put = await fetch(base + '/api/reminder-clock/config', { method: 'PUT' })
  check(put.status === 405, 'PUT -> 405', put.status)
  const missing = await fetch(base + '/api/other')
  check(missing.status === 404, 'unknown path -> 404', missing.status)
}

console.log('\nLoopback fence')
{
  // fetch() cannot forge Host (forbidden header), so drive raw http.request with
  // setHost:false to prove the handler itself refuses a non-loopback authority.
  const rawStatus = (headers) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: '/api/reminder-clock/config',
          method: 'GET',
          headers,
          setHost: false,
        },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        },
      )
      req.on('error', reject)
      req.end()
    })
  const port = server.address().port
  check((await rawStatus({ host: '127.0.0.1:' + port })) === 200, 'loopback Host passes the fence')
  check((await rawStatus({ host: 'evil.example.com' })) === 403, 'forged Host authority -> 403')
  const res = await fetch(base + '/api/reminder-clock/config', { headers: { 'sec-fetch-site': 'cross-site' } })
  check(res.status === 403, 'cross-site marker -> 403', res.status)
  check(
    (await rawStatus({ host: '127.0.0.1:' + port, origin: 'http://evil.example.com' })) === 403,
    'cross-origin Origin -> 403',
  )
  check(
    (await rawStatus({ host: '127.0.0.1:' + port, origin: 'http://127.0.0.1:' + port })) === 200,
    'same-origin Origin passes',
  )
}

console.log('\nDisposal')
{
  check(disposers.length === 0, 'routes stay mounted while the fiber lives')
  const dispose = []
  const teardown = []
  const ctx2 = {
    webServer: { register: () => () => dispose.push('removed') },
    get: () => undefined,
    effect: (run) => {
      teardown.push(run())
    },
  }
  mod.apply(ctx2)
  check(dispose.length === 0, 'disposer is not run by apply itself')
  for (const run of teardown) run()
  check(dispose.length === 2, 'fiber teardown disposes both routes', dispose)
}

await new Promise((resolve) => server.close(resolve))
rmSync(home, { recursive: true, force: true })

console.log(failures === 0 ? '\nhost-smoke: all checks passed' : '\nhost-smoke: ' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

function readFileSafe() {
  try {
    return readFileSync(configFile, 'utf8')
  } catch {
    return undefined
  }
}
