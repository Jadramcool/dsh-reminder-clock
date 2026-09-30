// Client-half smoke test: no browser, no bundler.
//   node test/client-smoke.mjs
//
// Pass A renders both slot occupants through real React's server renderer, so
// hook usage and element shapes are validated by React itself.
// Pass B drives the same module through a tiny stub React so clicks can be
// invoked directly: firing, dismissing, snoozing, muting, panel toggle, and the
// settings -> host -> overlay save path.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(ok, label, detail) {
  if (ok) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

// The built bundle: `npm test` builds first, and this is what the browser runs
// (it carries the inlined holiday snapshot too).
const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// Real React is optional: Pass A needs react + react-dom/server, Pass B does
// not. Prefer this package's devDependencies, then the live DSH profile.
function resolveReact() {
  const candidates = [
    process.env.DRC_REACT_ROOT,
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(homedir(), '.dsh', 'profiles', 'node_modules'),
  ].filter((root) => typeof root === 'string' && root.length > 0)
  for (const root of candidates) {
    try {
      const requireFrom = createRequire(join(root, 'noop.js'))
      return {
        React: requireFrom('react'),
        server: requireFrom('react-dom/server'),
        jsxRuntime: requireFrom('react/jsx-runtime'),
      }
    } catch {
      // try the next root
    }
  }
  return null
}

const reactPair = resolveReact()
if (reactPair === null) {
  console.log('client-smoke: react/react-dom unavailable; run `pnpm install` first')
  process.exit(2)
}
const React = reactPair.React
const { renderToStaticMarkup } = reactPair.server

/** Fixed local wall clock: 2026-01-15, stepped by the test. */
const DAY = { year: 2026, month: 0, date: 15 }

/** The real Date, captured before any instance patches the global. */
const RealDate = Date

/**
 * Load one isolated instance of the client bundle.
 * @param react - the React surface handed to `require('react')`.
 * @param hour/minute/second - initial local clock.
 * @param fetchImpl - fetch stub.
 */
function createInstance({ react, jsxRuntime, hour = 11, minute = 59, second = 58, fetchImpl, seedStorage }) {
  let nowMs = new RealDate(DAY.year, DAY.month, DAY.date, hour, minute, second).getTime()
  class Clock extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowMs)
      else super(...args)
    }

    static now() {
      return nowMs
    }
  }

  const storage = new Map()
  const timers = new Map()
  const timeouts = new Map()
  let nextTimerId = 1
  for (const [key, value] of Object.entries(seedStorage || {})) storage.set(key, JSON.stringify(value))
  const styles = []
  const documentStub = {
    head: {
      appendChild(node) {
        styles.push(node)
      },
    },
    createElement() {
      return {
        style: {},
        dataset: {},
        textContent: '',
        setAttribute() {},
        remove() {
          this.removed = true
        },
      }
    },
  }
  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => {
        storage.set(key, String(value))
      },
      removeItem: (key) => {
        storage.delete(key)
      },
    },
    setInterval: (fn) => {
      const id = nextTimerId++
      timers.set(id, fn)
      return id
    },
    clearInterval: (id) => {
      timers.delete(id)
    },
    setTimeout: (fn, delay) => {
      const id = nextTimerId++
      timeouts.set(id, { fn, delay })
      return id
    },
    clearTimeout: (id) => {
      timeouts.delete(id)
    },
    location: { href: 'http://127.0.0.1:19387/' },
    innerWidth: 1280,
    innerHeight: 800,
  }
  let captured = null
  const calls = []

  // The bundle reads the global Date at call time (tick, Date.now), so the fake
  // clock must stay installed for the whole instance lifetime.
  globalThis.Date = Clock
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'fetch', 'console', SOURCE)(
      windowStub,
      documentStub,
      async (url, init) => {
        calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body })
        return fetchImpl(url, init)
      },
      console,
    )
  } catch (err) {
    globalThis.Date = RealDate
    throw err
  }

  // The bundle is built with the JSX automatic runtime, so its factory asks for
  // `react/jsx-runtime` as well as `react`. Real React comes from the caller;
  // the stub surface gets an adapter that funnels jsx/jsxs into createElement.
  const runtime = jsxRuntime ?? {
    Fragment: react.Fragment ?? Symbol.for('react.fragment'),
    jsx: (type, props, key) => {
      const next = Object.assign({}, props)
      const children = next.children
      delete next.children
      if (key !== undefined) next.key = key
      return children === undefined ? react.createElement(type, next) : react.createElement(type, next, children)
    },
    jsxs: (type, props, key) => {
      const next = Object.assign({}, props)
      const children = next.children
      delete next.children
      if (key !== undefined) next.key = key
      return children === undefined ? react.createElement(type, next) : react.createElement(type, next, children)
    },
  }

  const plugin = captured.factory((spec) => {
    if (spec === 'react') return react
    if (spec === 'react/jsx-runtime') return runtime
    throw new Error('unexpected require: ' + spec)
  })

  const registered = new Map()
  const effects = []
  const slots = {
    inject(key, callback) {
      callback()
    },
    register(options, Component) {
      registered.set(options.name + ':' + options.id, { options, Component })
      return () => registered.delete(options.name + ':' + options.id)
    },
  }
  const ctx = {
    // 插件声明 `inject = ['slots']` 并直接读 `ctx.slots`（官方写法）。
    slots,
    get: (name) => (name === 'slots' ? slots : undefined),
    effect(run) {
      effects.push(run())
    },
  }

  return {
    plugin,
    ctx,
    calls,
    registered,
    styles,
    storage: {
      get: (key) => (storage.has(key) ? JSON.parse(storage.get(key)) : undefined),
      raw: storage,
    },
    /** Local wall-clock time as ms. */
    now: () => new Date(nowMs).getTime(),
    /** Jump the clock and run one engine step. */
    at(hour, minute, second) {
      nowMs = new RealDate(DAY.year, DAY.month, DAY.date, hour, minute, second).getTime()
      for (const fn of Array.from(timers.values())) fn()
    },
    /** Jump to an arbitrary local date/time and run one engine step. */
    atDate(year, monthIndex, date, hour, minute, second = 0) {
      nowMs = new RealDate(year, monthIndex, date, hour, minute, second).getTime()
      for (const fn of Array.from(timers.values())) fn()
    },
    /** Force one engine step at the current clock. */
    tick() {
      for (const fn of Array.from(timers.values())) fn()
    },
    engineRunning: () => timers.size > 0,
    /** Tear down: stop the engine timers and restore the real Date. */
    dispose() {
      for (const id of Array.from(timers.keys())) timers.delete(id)
      for (const id of Array.from(timeouts.keys())) timeouts.delete(id)
      if (globalThis.Date === Clock) globalThis.Date = RealDate
    },
    /** Run pending window timeouts at or under `maxDelay` (hover timers, not the 2.4s save reset). */
    flushTimers(maxDelay = 400) {
      for (const [id, entry] of Array.from(timeouts)) {
        if (entry.delay <= maxDelay) {
          timeouts.delete(id)
          entry.fn()
        }
      }
    },
    pendingTimers: () => Array.from(timeouts.values()).map((entry) => entry.delay),
    unmount: () => {
      effects.forEach((dispose) => {
        if (typeof dispose === 'function') dispose()
      })
      if (globalThis.Date === Clock) globalThis.Date = RealDate
    },
  }
}

/** Minimal stub React: plain element trees, per-component hook cells. */
function createStubReact() {
  const cells = new Map()
  let currentKey = null
  let cursor = 0
  function reserve(initial) {
    if (!cells.has(currentKey)) cells.set(currentKey, [])
    const list = cells.get(currentKey)
    const index = cursor++
    if (list[index] === undefined) list[index] = typeof initial === 'function' ? initial() : initial
    return { list, index }
  }
  function createElement(type, props, ...children) {
    const flattened = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: Object.assign({}, props, flattened === undefined ? {} : { children: flattened }) }
  }
  class Component {
    constructor(props) {
      this.props = props
    }
    setState() {}
  }
  return {
    createElement,
    Component,
    useSyncExternalStore: (subscribeFn, getSnapshot) => getSnapshot(),
    useState: (initial) => {
      const { list, index } = reserve(initial)
      return [
        list[index],
        (value) => {
          list[index] = typeof value === 'function' ? value(list[index]) : value
        },
      ]
    },
    useRef: (initial) => {
      const { list, index } = reserve(() => ({ current: initial }))
      return list[index]
    },
    useEffect: () => {},
    __begin: (type, key) => {
      // Key by type AND key so two instances of the same component (e.g. two
      // ItemRows) do not share one hook cell — real React keeps them apart too.
      currentKey = key === undefined ? type : String(type) + '::' + String(key)
      cursor = 0
    },
    __reset: () => {
      cursor = 0
    },
  }
}

/** Expand function and class components into a plain host-element tree. */
function expand(node, react) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child) => expand(child, react))
  if (typeof node.type === 'function') {
    if (react.__begin !== undefined) react.__begin(node.type, node.props.key)
    if (node.type.prototype && typeof node.type.prototype.render === 'function') {
      const instance = new node.type(node.props || {})
      return expand(instance.render(), react)
    }
    return expand(node.type(node.props || {}), react)
  }
  const props = Object.assign({}, node.props)
  if (props.children !== undefined) props.children = expand(props.children, react)
  return { type: node.type, props }
}

/** All text of a subtree, flattened. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  return textOf(node.props && node.props.children)
}

/** First descendant matching a predicate. */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return find(node.props && node.props.children, predicate)
}

/** Every descendant matching a predicate. */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.props && node.props.children, predicate, out)
  return out
}

/** Clickable element whose text contains `label`. */
function buttonByText(tree, label) {
  return find(tree, (node) => node.type === 'button' && textOf(node).includes(label))
}

const DEFAULT_HOST_CONFIG = {
  version: 1,
  enabled: true,
  items: [
    { id: 'lunch', label: '午餐', emoji: '🍚', time: '12:00', enabled: true, message: '该吃午饭了。' },
    { id: 'offwork', label: '下班', emoji: '🌇', time: '18:00', enabled: true, message: '收工回家。' },
  ],
  options: { showCountdown: true, snoozeMinutes: 5, graceMinutes: 3, position: 'top-right' },
}

const okFetch = async (url, init) => {
  const method = (init && init.method) || 'GET'
  if (String(url).indexOf('/holidays') >= 0) {
    return { ok: true, status: 200, json: async () => HOLIDAYS_EMPTY }
  }
  const config = method === 'POST' ? JSON.parse(init.body).config : DEFAULT_HOST_CONFIG
  return { ok: true, status: 200, json: async () => ({ ok: true, config, source: 'disk' }) }
}

/** The holiday route answering with no runtime data (the bundle snapshot stands in). */
const HOLIDAYS_EMPTY = { ok: true, years: {}, fetchedAt: null, provider: 'test', syncEnabled: true, syncError: null }

// ---------------------------------------------------------------------------
console.log('\nPas A — real React server render')
{
  const instance = createInstance({ react: React, jsxRuntime: reactPair.jsxRuntime, fetchImpl: okFetch })
  check(instance.plugin.name === 'reminder-clock', 'plugin exposes its stable name')
  check(instance.plugin.inject.includes('slots'), 'plugin injects slots')
  instance.plugin.apply(instance.ctx)
  check(instance.registered.has('shell.overlay:reminder-clock'), 'registers the shell.overlay occupant')
  check(instance.registered.has('settings.section:reminder-clock'), 'registers the settings.section page')
  check(instance.styles.length === 1 && instance.styles[0].textContent.includes('.drc-root'), 'injects one stylesheet')
  // 提醒项表格的列宽：末尾不能再用 `auto`（会被压到 min-content，中文逐字竖排）。
  const cssText = instance.styles[0].textContent
  const itemRule = /\.drc-item\{[^}]*\}/.exec(cssText)?.[0] ?? ''
  check(!/\bauto auto\b/.test(itemRule), '提醒项栅格末尾是固定列宽，不用 auto', itemRule)
  check(
    /white-space:nowrap/.test(/\.drc-btn\{[^}]*\}/.exec(cssText)?.[0] ?? '') &&
      /\.drc-item-head span\{white-space:nowrap\}/.test(cssText),
    '按钮与表头都不换行（避免「删除」「操作」竖排）',
  )
  check(instance.engineRunning(), 'starts the 1s engine')

  const overlay = instance.registered.get('shell.overlay:reminder-clock').Component
  const settings = instance.registered.get('settings.section:reminder-clock').Component

  const idle = renderToStaticMarkup(React.createElement(overlay))
  check(idle.includes('午餐'), 'idle overlay shows the next item', idle.slice(0, 160))
  check(idle.includes('00:02'), 'idle overlay counts down to 12:00:00', idle.match(/drc-pill-time[^>]*>([^<]*)</)?.[1])
  // 悬停不弹浏览器原生 tip：整个浮层（胶囊 + 卡片）都不挂 title，信息走 aria-label。
  check(!/title="/.test(idle), 'the pill carries no native tooltip', idle.slice(0, 200))

  instance.at(12, 0, 0)
  const fired = renderToStaticMarkup(React.createElement(overlay))
  check(fired.includes('到点了') && fired.includes('知道了'), 'fired overlay renders the alert card')
  check(fired.includes('5 分钟后再说'), 'alert offers snooze with the configured minutes')
  check(fired.includes('今天不再提醒'), 'alert offers mute-today')
  check(!/title="/.test(fired), 'the alert card carries no native tooltip', fired.match(/title="[^"]*"/)?.[0])

  const settingsHtml = renderToStaticMarkup(React.createElement(settings))
  check(settingsHtml.includes('作息提醒'), 'settings page renders its heading')
  check(settingsHtml.includes('显示常驻倒计时'), 'settings page renders the behaviour group')
  check(settingsHtml.includes('type="time"'), 'settings page renders a time input')
}

// ---------------------------------------------------------------------------
console.log('\nPass B — driven interactions')
const stub = createStubReact()
{
  const instance = createInstance({ react: stub, fetchImpl: okFetch })
  instance.plugin.apply(instance.ctx)
  // Let the initial GET settle so the rest of the run drives the host config.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const overlay = instance.registered.get('shell.overlay:reminder-clock').Component
  const settings = instance.registered.get('settings.section:reminder-clock').Component
  const render = (Component) => {
    stub.__reset()
    return expand(React.createElement(Component), stub)
  }

  let tree = render(overlay)
  check(textOf(tree).includes('午餐'), 'pill shows lunch')
  check(textOf(tree).includes('00:02'), 'pill counts down 2 seconds before noon')

  // Open the schedule panel from the pill.
  buttonByText(tree, '00:02').props.onClick()
  tree = render(overlay)
  check(textOf(tree).includes('今日提醒'), 'clicking the pill opens the schedule panel')
  check(textOf(tree).includes('12:00') && textOf(tree).includes('18:00'), 'panel lists both items')

  // Fire lunch.
  instance.at(12, 0, 1)
  tree = render(overlay)
  check(textOf(tree).includes('知道了'), 'lunch fires at 12:00')
  check(
    JSON.stringify(instance.storage.get('dsh.reminderClock.fired.v1')).includes('lunch'),
    'the fire is recorded per day',
  )

  // Dismiss, then confirm it does not fire again inside the grace window.
  buttonByText(tree, '知道了').props.onClick()
  tree = render(overlay)
  check(!textOf(tree).includes('知道了'), 'dismiss closes the alert card')
  instance.at(12, 0, 2)
  tree = render(overlay)
  check(!textOf(tree).includes('知道了'), 'no re-fire for an already-fired item')
  const nextPill = textOf(tree)
  check(
    nextPill.includes('18:00') || nextPill.includes('下班'),
    'pill moves on to the next item',
    nextPill.slice(0, 80),
  )

  // Snooze path: move the clock to just before 18:00, fire, snooze, re-fire.
  instance.at(18, 0, 1)
  tree = render(overlay)
  check(textOf(tree).includes('🌇') || textOf(tree).includes('下班'), 'off-work fires at 18:00')
  buttonByText(tree, '5 分钟后再说').props.onClick()
  tree = render(overlay)
  check(!textOf(tree).includes('5 分钟后再说'), 'snooze closes the alert card')
  check(textOf(tree).includes('稍后'), 'pill marks the pending snooze')
  instance.at(18, 5, 2)
  tree = render(overlay)
  check(textOf(tree).includes('下班'), 'snooze re-fires after the configured minutes')
  check(textOf(tree).includes('知道了'), 'snoozed alert is the full card again')

  // Mute today.
  buttonByText(tree, '今天不再提醒').props.onClick()
  tree = render(overlay)
  check(!textOf(tree).includes('知道了'), 'mute closes the alert card')
  check(instance.storage.get('dsh.reminderClock.muted.v1') !== undefined, 'mute is persisted for today')
  check(
    textOf(tree).includes('未设置提醒') || textOf(tree).includes('午餐'),
    'overlay still renders after mute',
    textOf(tree).slice(0, 80),
  )
  instance.at(18, 6, 0)
  tree = render(overlay)
  check(!textOf(tree).includes('知道了'), 'a muted day never fires again')

  // Settings -> host -> live overlay.
  tree = render(settings)
  check(textOf(tree).includes('未连上 Host 配置接口') === false, 'an online fetch leaves no failure notice')
  const timeInput = find(tree, (node) => node.type === 'input' && node.props.type === 'time')
  check(timeInput !== null, 'settings exposes the first time input')
  timeInput.props.onChange({ target: { value: '11:45' } })
  tree = render(settings)
  const labelInput = find(tree, (node) => node.type === 'input' && node.props.placeholder === '名称')
  labelInput.props.onChange({ target: { value: '午饭' } })
  tree = render(settings)
  check(textOf(tree).includes('有未保存的修改'), 'edits mark the draft dirty')
  buttonByText(tree, '保存').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = render(settings)
  check(textOf(tree).includes('已保存'), 'save reports success', textOf(tree).slice(-120))
  const posted = instance.calls.filter((call) => call.method === 'POST').pop()
  check(
    posted !== undefined && posted.body.includes('11:45') && posted.body.includes('午饭'),
    'the edit reached the host route',
  )
  check(
    instance.storage.get('dsh.reminderClock.v1').items[0].time === '11:45',
    'the local mirror keeps the saved value',
  )
}

// ---------------------------------------------------------------------------
console.log('\nOffline fallback')
{
  const instance = createInstance({
    react: stub,
    hour: 9,
    minute: 0,
    second: 0,
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  instance.plugin.apply(instance.ctx)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const settings = instance.registered.get('settings.section:reminder-clock').Component
  stub.__reset()
  const tree = expand(React.createElement(settings), stub)
  check(
    textOf(tree).includes('未连上 Host 配置接口'),
    'offline settings page warns that edits stay local',
    textOf(tree).slice(0, 160),
  )
  const overlay = instance.registered.get('shell.overlay:reminder-clock').Component
  stub.__reset()
  const overlayTree = expand(React.createElement(overlay), stub)
  check(textOf(overlayTree).includes('午餐'), 'overlay still renders without the host')
  check(
    /[0-9]:[0-9]{2}:[0-9]{2}/.test(textOf(overlayTree)),
    'overlay still counts down without the host',
    textOf(overlayTree).slice(0, 80),
  )
}

// ---------------------------------------------------------------------------
console.log('\nPass C — hover opens the panel')
{
  const instance = createInstance({ react: stub, fetchImpl: okFetch })
  instance.plugin.apply(instance.ctx)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const overlay = instance.registered.get('shell.overlay:reminder-clock').Component
  const render = () => {
    stub.__reset()
    return expand(React.createElement(overlay), stub)
  }
  const pillOf = (tree) => find(tree, (node) => node.type === 'button' && node.props['aria-expanded'] !== undefined)

  check(!textOf(render()).includes('今日提醒'), 'panel starts closed')
  pillOf(render()).props.onMouseEnter()
  check(!textOf(render()).includes('今日提醒'), 'hover does not open before the intent delay', instance.pendingTimers())
  instance.flushTimers(200)
  check(textOf(render()).includes('今日提醒'), 'hover opens the schedule panel')
  check(
    find(render(), (node) => node.type === 'button' && textOf(node) === '收起') === null,
    'the panel has no separate collapse button',
  )

  // 非模态浮层不带焦点管理，所以是带标签的 `region` 而不是 `dialog`。
  const panel = find(
    render(),
    (node) => node.type === 'div' && String(node.props.className || '').indexOf('drc-panel') === 0,
  )
  check(
    panel !== null && panel.props.role === 'region' && typeof panel.props['aria-label'] === 'string',
    'panel is a labelled region (non-modal, no focus management)',
    panel === null ? null : panel.props.role,
  )
  check(panel !== null && typeof panel.props.onMouseEnter === 'function', 'panel carries the hover handlers')
  pillOf(render()).props.onMouseLeave()
  panel.props.onMouseEnter()
  instance.flushTimers(400)
  check(textOf(render()).includes('今日提醒'), 'moving from the pill into the panel keeps it open')
  panel.props.onMouseLeave()
  check(textOf(render()).includes('今日提醒'), 'leaving does not close instantly')
  instance.flushTimers(400)
  check(!textOf(render()).includes('今日提醒'), 'leaving closes it after the delay')

  pillOf(render()).props.onClick()
  check(textOf(render()).includes('今日提醒'), 'clicking the pill opens it again')
  pillOf(render()).props.onClick()
  check(!textOf(render()).includes('今日提醒'), 'clicking the pill again closes it, so no collapse button is needed')
}

console.log('\nPass D — 悬停展开是固定行为，没有开关')
{
  // 老配置里可能还留着 openOnHover:false，现在这个键被彻底忽略：悬停照样展开。
  const offFetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    const config =
      method === 'POST'
        ? JSON.parse(init.body).config
        : Object.assign({}, DEFAULT_HOST_CONFIG, {
            options: Object.assign({}, DEFAULT_HOST_CONFIG.options, { openOnHover: false }),
          })
    return { ok: true, status: 200, json: async () => ({ ok: true, config, source: 'disk' }) }
  }
  const instance = createInstance({ react: stub, fetchImpl: offFetch })
  instance.plugin.apply(instance.ctx)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const overlay = instance.registered.get('shell.overlay:reminder-clock').Component
  const render = () => {
    stub.__reset()
    return expand(React.createElement(overlay), stub)
  }
  const tree = render()
  check(textOf(tree).includes('午餐'), 'pill still renders')
  find(tree, (node) => node.type === 'button' && node.props['aria-expanded'] !== undefined).props.onMouseEnter()
  instance.flushTimers(400)
  check(textOf(render()).includes('今日提醒'), '悬停照常展开（旧的 openOnHover:false 不再起作用）')
  find(render(), (node) => node.type === 'button' && node.props['aria-expanded'] !== undefined).props.onClick()
  check(!textOf(render()).includes('今日提醒'), 'click still toggles it shut')
  const settings = instance.registered.get('settings.section:reminder-clock').Component
  stub.__reset()
  const settingsTree = expand(React.createElement(settings), stub)
  const optionLabels = findAll(
    settingsTree,
    (node) => typeof node.props?.className === 'string' && node.props.className.indexOf('drc-check') === 0,
  ).map((node) => textOf(node))
  check(!optionLabels.some((label) => label.includes('悬停')), '设置页不再有悬停开关', optionLabels)
  const draft = instance.storage.get('dsh.reminderClock.v1')
  check(
    draft === undefined || draft.options.openOnHover === undefined,
    '配置里不再有 openOnHover 字段',
    draft && draft.options,
  )
}

console.log('\nPass E — 旧 Host 半不会回退浏览器持有的字段')
{
  // 旧 Host：归一化会把它不认识的 calendar / items[].days 丢掉，GET 与 POST 回声都没有这些键。
  const legacyConfig = {
    version: 1,
    enabled: true,
    items: [
      { id: 'lunch', label: '午餐', emoji: '🍚', time: '12:00', enabled: true, message: '该吃午饭了。' },
      { id: 'offwork', label: '下班', emoji: '🌇', time: '18:00', enabled: true, message: '' },
    ],
    options: { showCountdown: true, snoozeMinutes: 5, graceMinutes: 3, position: 'top-right' },
  }
  const legacyFetch = async (url) => {
    if (String(url).indexOf('/holidays') >= 0) return { ok: true, status: 200, json: async () => HOLIDAYS_EMPTY }
    return { ok: true, status: 200, json: async () => ({ ok: true, config: legacyConfig, source: 'disk' }) }
  }
  const seeded = JSON.parse(JSON.stringify(DEFAULT_HOST_CONFIG))
  seeded.options.openOnHover = true
  seeded.items[0].days = 'every'
  seeded.calendar = {
    cycle: { anchor: '2026-01-12', anchorKind: 'big' },
    bigWorkdays: [1, 2, 3, 4, 5, 6],
    smallWorkdays: [1, 2, 3, 4, 5],
    overrides: {},
    sync: true,
  }
  const instance = createInstance({
    react: stub,
    fetchImpl: legacyFetch,
    seedStorage: { 'dsh.reminderClock.v1': seeded },
  })
  instance.plugin.apply(instance.ctx)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const settings = instance.registered.get('settings.section:reminder-clock').Component
  const settingsTree = () => {
    stub.__reset()
    return expand(React.createElement(settings), stub)
  }
  let tree = settingsTree()
  const cycleToggle = find(tree, (node) => node.type === 'input' && node.props['aria-label'] === '启用大小周排班')
  check(cycleToggle !== null && cycleToggle.props.checked === true, '旧 Host 丢掉的 calendar 从镜像里补回来')
  const daySelects = findAll(tree, (node) => node.type === 'select' && node.props['aria-label'] === '适用日')
  check(
    daySelects.length > 0 && daySelects[0].props.value === 'every',
    '旧 Host 丢掉的 items[].days 也从镜像里补回来',
    daySelects.map((node) => node.props.value),
  )

  buttonByText(settingsTree(), '保存').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const mirrored = instance.storage.get('dsh.reminderClock.v1')
  check(
    mirrored.calendar.cycle !== null,
    '保存后镜像里仍保留 calendar（不被旧 Host 的清空回声覆盖）',
    mirrored.calendar,
  )
  check(mirrored.items[0].days === 'every', '保存后镜像里仍保留 items[].days', mirrored.items[0].days)
}

// ---------------------------------------------------------------------------
console.log('\nPass F — 工作日 / 大小周 / 法定节假日')
{
  // 2026 的日历事实：01-15 周四（普通工作日）、01-17 周六（周末）、01-04 周日补班、
  // 01-01 元旦放假、02-14 周六补班；本周周一 = 01-12，下一周周一 = 01-19。
  const base = {
    version: 1,
    enabled: true,
    items: [
      { id: 'lunch', label: '午餐', emoji: '🍚', time: '12:00', enabled: true, days: 'every', message: '该吃午饭了。' },
      {
        id: 'offwork',
        label: '下班',
        emoji: '🌇',
        time: '18:00',
        enabled: true,
        days: 'workday',
        message: '收工回家。',
      },
    ],
    options: { showCountdown: true, openOnHover: true, snoozeMinutes: 5, graceMinutes: 3, position: 'top-right' },
    calendar: {
      cycle: null,
      bigWorkdays: [1, 2, 3, 4, 5, 6],
      smallWorkdays: [1, 2, 3, 4, 5],
      overrides: {},
      sync: true,
    },
  }
  const withCalendar = (patch) =>
    Object.assign({}, base, {
      calendar: Object.assign({}, base.calendar, patch),
    })
  const fetchOf = (config) => async (url, init) => {
    const method = (init && init.method) || 'GET'
    if (String(url).indexOf('/holidays') >= 0) return { ok: true, status: 200, json: async () => HOLIDAYS_EMPTY }
    const body = method === 'POST' ? JSON.parse(init.body).config : config
    return { ok: true, status: 200, json: async () => ({ ok: true, config: body, source: 'disk' }) }
  }
  const launch = async (config) => {
    const instance = createInstance({ react: stub, fetchImpl: fetchOf(config) })
    instance.plugin.apply(instance.ctx)
    await new Promise((resolve) => setTimeout(resolve, 20))
    return instance
  }
  const view = (instance) => {
    const component = instance.registered.get('shell.overlay:reminder-clock').Component
    stub.__reset()
    return expand(React.createElement(component), stub)
  }
  const text = (instance) => textOf(view(instance))
  const fired = (instance) => text(instance).includes('知道了')

  // --- 普通工作日 / 周末
  let instance = await launch(base)
  instance.atDate(2026, 0, 15, 17, 0)
  check(text(instance).includes('下班') && !text(instance).includes('明天'), '周四 17:00 的下一条是当天 18:00 下班')
  instance.atDate(2026, 0, 17, 17, 0)
  check(!text(instance).includes('下班'), '周六的下一条不是「下班」', text(instance).slice(0, 120))
  check(
    text(instance).includes('午餐') && text(instance).includes('明天'),
    '周六跳过休息日、指向周日午餐',
    text(instance).slice(0, 120),
  )
  instance.dispose()

  // --- 法定节假日与调休补班
  instance = await launch(base)
  instance.atDate(2026, 0, 1, 18, 0)
  check(!fired(instance), '元旦当天 18:00 不弹下班提醒', text(instance).slice(0, 120))
  instance.dispose()

  instance = await launch(base)
  instance.atDate(2026, 0, 4, 18, 0)
  check(fired(instance) && text(instance).includes('下班'), '调休补班的周日 18:00 照常弹下班')
  instance.dispose()

  instance = await launch(base)
  instance.atDate(2026, 1, 14, 18, 0)
  check(fired(instance), '补班的周六（02-14）照常弹下班')
  instance.dispose()

  instance = await launch(base)
  instance.atDate(2026, 0, 17, 18, 0)
  check(!fired(instance), '普通周六 18:00 不弹下班')
  instance.dispose()

  // --- 大小周
  const bigThisWeek = withCalendar({ cycle: { anchor: '2026-01-12', anchorKind: 'big' } })
  instance = await launch(bigThisWeek)
  instance.atDate(2026, 0, 17, 18, 0)
  check(fired(instance), '大周的周六要上班，18:00 弹下班')
  instance.dispose()

  instance = await launch(bigThisWeek)
  instance.atDate(2026, 0, 24, 18, 0)
  check(!fired(instance), '下一周轮到小周，周六不弹下班')
  instance.dispose()

  const smallThisWeek = withCalendar({ cycle: { anchor: '2026-01-12', anchorKind: 'small' } })
  instance = await launch(smallThisWeek)
  instance.atDate(2026, 0, 17, 18, 0)
  check(!fired(instance), '把本周设成小周，同一个周六就不弹了')
  instance.dispose()

  // --- 手动调整优先
  instance = await launch(withCalendar({ overrides: { '2026-01-17': 1 } }))
  instance.atDate(2026, 0, 17, 18, 0)
  check(!fired(instance), '手动放假覆盖周末/工作日判断')
  instance.dispose()

  instance = await launch(withCalendar({ overrides: { '2026-01-17': 0 } }))
  instance.atDate(2026, 0, 17, 18, 0)
  check(fired(instance), '手动补班把周六变成工作日')
  instance.dispose()

  // --- 仅休息日
  const restOnly = JSON.parse(JSON.stringify(base))
  restOnly.items[0].days = 'restday'
  instance = await launch(restOnly)
  instance.atDate(2026, 0, 17, 12, 0)
  check(fired(instance) && text(instance).includes('午餐'), '「仅休息日」的午餐在周六 12:00 弹出')
  instance.dispose()

  instance = await launch(restOnly)
  instance.atDate(2026, 0, 15, 12, 0)
  check(!fired(instance), '「仅休息日」的午餐在工作日不弹')
  instance.dispose()

  // --- 面板与设置页
  instance = await launch(base)
  instance.atDate(2026, 0, 17, 17, 0)
  find(view(instance), (node) => node.type === 'button' && node.props['aria-expanded'] !== undefined).props.onClick()
  const panelText = text(instance)
  check(
    panelText.includes('休息日') && panelText.includes('周末'),
    '面板标出今天是休息日·周末',
    panelText.slice(0, 200),
  )
  check(panelText.includes('今日不提醒'), '不适用的项标成「今日不提醒」', panelText.slice(0, 200))
  check(panelText.includes('仅工作日'), '每行带适用日标签')
  instance.dispose()

  // --- 设置页
  instance = await launch(base)
  const renderSettings = () => {
    const component = instance.registered.get('settings.section:reminder-clock').Component
    stub.__reset()
    return expand(React.createElement(component), stub)
  }
  let settingsTree = renderSettings()
  let settingsText = textOf(settingsTree)
  check(settingsText.includes('启用大小周排班'), '设置页有大小周开关')
  check(settingsText.includes('自动同步国家法定节假日'), '设置页有节假日同步开关')
  check(settingsText.includes('适用日'), '提醒项表格有适用日列')
  check(
    settingsText.includes('节假日：') && settingsText.includes('内置快照'),
    '设置页显示节假日来源',
    settingsText.length,
  )
  check(
    find(settingsTree, (node) => node.type === 'input' && node.props['aria-label'] === '日期') !== null,
    '设置页有手动调整的日期输入',
  )
  const weekdaysBefore = findAll(settingsTree, (node) => node.type === 'button' && node.props['aria-label'] === '周六')
  check(weekdaysBefore.length === 0, '未启用大小周时不显示工作日按钮')
  const cycleToggle = find(
    settingsTree,
    (node) => node.type === 'input' && node.props['aria-label'] === '启用大小周排班',
  )
  check(cycleToggle !== null, '大小周开关可定位')
  cycleToggle.props.onChange({ target: { checked: true } })
  settingsTree = renderSettings()
  settingsText = textOf(settingsTree)
  check(
    settingsText.includes('本周') && settingsText.includes('之后大小周交替'),
    '勾上大小周后出现本周选择',
    settingsText.slice(0, 200),
  )
  const weekdaysAfter = findAll(
    settingsTree,
    (node) => node.type === 'button' && node.props['aria-label'] === '周六' && node.props['aria-pressed'] === true,
  )
  check(weekdaysAfter.length >= 1, '大周默认把周六算作工作日')
  const dateInput = find(settingsTree, (node) => node.type === 'input' && node.props.type === 'date')
  dateInput.props.onChange({ target: { value: '2026-10-01' } })
  settingsTree = renderSettings()
  find(settingsTree, (node) => node.type === 'button' && textOf(node) === '添加').props.onClick()
  check(textOf(renderSettings()).includes('2026-10-01 放假'), '手动调整能加一条放假')
  settingsTree = renderSettings()
  const syncButton = buttonByText(settingsTree, '立即同步')
  check(syncButton !== null, '设置页有「立即同步」按钮')
  syncButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(textOf(renderSettings()).includes('已同步'), '手动同步后给出反馈')
  instance.dispose()
}

// ---------------------------------------------------------------------------
console.log('\nPass G — 节假日同步：Host → 浏览器直连 → 内置快照')
{
  const baseConfig = {
    version: 1,
    enabled: true,
    items: [
      {
        id: 'offwork',
        label: '下班',
        emoji: '🌇',
        time: '18:00',
        enabled: true,
        days: 'workday',
        message: '收工回家。',
      },
    ],
    options: { showCountdown: true, openOnHover: true, snoozeMinutes: 5, graceMinutes: 3, position: 'top-right' },
    calendar: {
      cycle: null,
      bigWorkdays: [1, 2, 3, 4, 5, 6],
      smallWorkdays: [1, 2, 3, 4, 5],
      overrides: {},
      sync: true,
    },
  }
  // 2027 尚不在内置快照里（今天 = 2026-01-15，需要的年份是 2026 + 2027），
  // 所以「补年份」这条路径一定会被触发。2027-01-01 是周五，官方是元旦放假。
  const providerPayload = (year) => ({
    code: 0,
    holiday:
      year === 2027
        ? { '01-01': { holiday: true, name: '元旦', date: '2027-01-01' } }
        : { '10-01': { holiday: true, name: '国庆节', date: '2026-10-01' } },
  })

  /** `layers` names the sources allowed to answer. */
  const layeredFetch = (layers) => {
    const calls = { host: 0, provider: 0 }
    const flaked = new Set()
    const impl = async (url, init) => {
      const target = String(url)
      if (target.includes('timor.tech')) {
        calls.provider += 1
        if (!layers.includes('browser')) throw new Error('offline')
        // `flaky` drops the very first attempt for 2026 (a connect reset).
        if (layers.includes('flaky') && target.includes('2026') && !flaked.has('2026')) {
          flaked.add('2026')
          throw new Error('ECONNRESET')
        }
        const year = Number(target.slice(target.lastIndexOf('/') + 1))
        return { ok: true, status: 200, json: async () => providerPayload(year) }
      }
      if (target.includes('/api/reminder-clock/holidays')) {
        calls.host += 1
        if (!layers.includes('host')) return { ok: false, status: 404, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => HOLIDAYS_EMPTY }
      }
      const method = (init && init.method) || 'GET'
      const config = method === 'POST' ? JSON.parse(init.body).config : baseConfig
      return { ok: true, status: 200, json: async () => ({ ok: true, config, source: 'disk' }) }
    }
    return { impl, calls }
  }
  const launch = async (layers) => {
    const stubFetch = layeredFetch(layers)
    const instance = createInstance({ react: stub, fetchImpl: stubFetch.impl })
    instance.plugin.apply(instance.ctx)
    await new Promise((resolve) => setTimeout(resolve, 30))
    return { instance, calls: stubFetch.calls }
  }
  const settingsView = (instance) => {
    const component = instance.registered.get('settings.section:reminder-clock').Component
    stub.__reset()
    return expand(React.createElement(component), stub)
  }
  const settingsText = (instance) => textOf(settingsView(instance))
  const overlayText = (instance) => {
    const component = instance.registered.get('shell.overlay:reminder-clock').Component
    stub.__reset()
    return textOf(expand(React.createElement(component), stub))
  }
  const clickSync = async (instance) => {
    const button = find(settingsView(instance), (node) => node.type === 'button' && textOf(node) === '立即同步')
    check(button !== null, '「立即同步」按钮可定位')
    button.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 30))
  }

  // --- 旧 Host（路由 404）自动直连供应商
  let run = await launch(['browser'])
  let text = settingsText(run.instance)
  check(run.calls.host === 1 && run.calls.provider >= 1, 'Host 路由不可用时自动直连供应商', run.calls)
  check(text.includes('节假日：浏览器直连'), '状态显示浏览器直连', text.slice(0, 220))
  check(text.includes('2027'), '直连抓到的 2027 进入覆盖范围')
  check(!text.includes('同步失败'), '自动降级不弹错误')
  run.instance.atDate(2027, 0, 1, 18, 0)
  check(!overlayText(run.instance).includes('知道了'), '直连拿到的 2027 元旦被当作休息日（下班不提醒）')
  run.instance.dispose()

  // --- 直连偶发失败（连接重置）会立刻重试一次
  run = await launch(['browser', 'flaky'])
  text = settingsText(run.instance)
  check(run.calls.provider === 3, '直连失败的那一年会重试一次', run.calls)
  check(text.includes('节假日：浏览器直连'), '重试成功后仍是直连数据源', text.slice(0, 220))
  check(!text.includes('同步失败'), '重试成功不报错')
  run.instance.dispose()

  // --- 两层都拿不到：静默回到内置快照
  run = await launch([])
  text = settingsText(run.instance)
  check(run.calls.host === 1 && run.calls.provider >= 1, '两层都试过', run.calls)
  check(text.includes('节假日：内置快照'), '两层都失败时用内置快照', text.slice(0, 220))
  check(!text.includes('同步失败'), '自动加载失败保持静默（不吓人）')
  run.instance.dispose()

  // --- Host 可用时不该再直连
  run = await launch(['host'])
  text = settingsText(run.instance)
  check(text.includes('节假日：Host'), 'Host 可用时以 Host 为准', text.slice(0, 220))
  check(run.calls.provider === 0, 'Host 成功就不直连供应商', run.calls)
  run.instance.dispose()

  // --- 手动「立即同步」：Host 404，直连成功
  run = await launch(['browser'])
  await clickSync(run.instance)
  text = settingsText(run.instance)
  check(text.includes('已同步（浏览器直连）'), '手动同步走直连并反馈通道', text.slice(0, 240))
  check(!text.includes('同步失败'), '成功时不显示失败')
  run.instance.dispose()

  // --- 手动「立即同步」：全失败才报错
  run = await launch([])
  await clickSync(run.instance)
  text = settingsText(run.instance)
  check(text.includes('同步失败'), '手动同步全失败才报错', text.slice(0, 240))
  check(text.includes('offline'), '报出具体原因')
  check(text.includes('内置快照'), '失败后仍保留可用日历')
  run.instance.dispose()
}

// ---------------------------------------------------------------------------
console.log('\nPass H — 面板里的「最近节假日倒计时」')
{
  const baseConfig = {
    version: 1,
    enabled: true,
    items: [
      {
        id: 'offwork',
        label: '下班',
        emoji: '🌇',
        time: '18:00',
        enabled: true,
        days: 'workday',
        message: '收工回家。',
      },
    ],
    options: { showCountdown: true, openOnHover: true, snoozeMinutes: 5, graceMinutes: 3, position: 'top-right' },
    calendar: {
      cycle: null,
      bigWorkdays: [1, 2, 3, 4, 5, 6],
      smallWorkdays: [1, 2, 3, 4, 5],
      overrides: {},
      sync: true,
    },
  }
  const fetchOf = (config) => async (url, init) => {
    const method = (init && init.method) || 'GET'
    if (String(url).indexOf('/holidays') >= 0) return { ok: true, status: 200, json: async () => HOLIDAYS_EMPTY }
    const body = method === 'POST' ? JSON.parse(init.body).config : config
    return { ok: true, status: 200, json: async () => ({ ok: true, config: body, source: 'disk' }) }
  }
  const launch = async (config) => {
    const instance = createInstance({ react: stub, fetchImpl: fetchOf(config) })
    instance.plugin.apply(instance.ctx)
    await new Promise((resolve) => setTimeout(resolve, 30))
    return instance
  }
  /** Open the panel (hover-equivalent click) and return the rendered tree. */
  const panel = (instance) => {
    const component = instance.registered.get('shell.overlay:reminder-clock').Component
    stub.__reset()
    const tree = expand(React.createElement(component), stub)
    const pill = find(tree, (node) => node.type === 'button' && node.props['aria-expanded'] !== undefined)
    if (pill !== null) pill.props.onClick()
    stub.__reset()
    return expand(React.createElement(component), stub)
  }
  const holidayLine = (instance) =>
    find(
      panel(instance),
      (node) => typeof node.props?.className === 'string' && node.props.className.indexOf('drc-holiday') === 0,
    )

  // 2026-01-15：元旦(01-01~03)已过，最近的是春节 02-15~23（除夕+初一到初七，9 天）。
  let instance = await launch(baseConfig)
  instance.atDate(2026, 0, 15, 10, 0)
  let line = holidayLine(instance)
  let lineText = line === null ? '' : textOf(line)
  check(line !== null, '面板里有节假日倒计时那一行')
  check(lineText.includes('春节'), '最近的假期是春节', lineText)
  check(lineText.includes('9 天假'), '春节按连续放假日合并成 9 天（不是逐日一条）', lineText)
  check(lineText.includes('还有 31 天'), '从 01-15 到 02-15 是 31 天', lineText)
  check(
    line.props['aria-label'].includes('02-15 周日 – 02-23 周一') && line.props['aria-label'].includes('共 9 天'),
    '节假日行的辅助说明带准确区间（走 aria-label，不弹原生 tip）',
    line.props['aria-label'],
  )
  check(line.props.title === undefined, '节假日行不再挂原生 title', line.props.title)
  instance.dispose()

  // 假期进行中：2026-02-17 是春节第 3 天，还剩 6 天。
  instance = await launch(baseConfig)
  instance.atDate(2026, 1, 17, 10, 0)
  const ongoingPanel = panel(instance)
  line = find(
    ongoingPanel,
    (node) => typeof node.props?.className === 'string' && node.props.className.indexOf('drc-holiday') === 0,
  )
  lineText = line === null ? '' : textOf(line)
  check(lineText.includes('春节') && lineText.includes('还剩 6 天'), '假期中显示剩余天数', lineText)
  check(lineText.includes('02-15'), '节假日行给出首日日期', lineText)
  // 顶栏徽章也要用统一的假名（数据里 02-17 是「初一」）。
  const panelText = textOf(ongoingPanel)
  check(
    panelText.includes('休息日') && panelText.includes('春节') && !panelText.includes('初一'),
    '徽章用「春节」而不是逐日的「初一」',
    panelText.slice(0, 160),
  )
  instance.dispose()

  // 明天开始：2026-09-30 → 国庆 10-01~07。
  instance = await launch(baseConfig)
  instance.atDate(2026, 8, 30, 10, 0)
  line = holidayLine(instance)
  lineText = line === null ? '' : textOf(line)
  check(
    lineText.includes('国庆节') && lineText.includes('明天开始') && lineText.includes('7 天假'),
    '国庆前一天显示「明天开始」',
    lineText,
  )
  instance.dispose()

  // 跨节日的连休：2025-10-01~08（国庆 + 中秋 + 国庆）合并成一段，名字取首日。
  instance = await launch(baseConfig)
  instance.atDate(2025, 9, 6, 10, 0)
  line = holidayLine(instance)
  lineText = line === null ? '' : textOf(line)
  check(lineText.includes('国庆节') && lineText.includes('8 天假'), '国庆中秋连休合成 8 天', lineText)
  check(line.props['aria-label'].includes('含 中秋节'), '辅助说明点出段内还有中秋', line.props['aria-label'])
  instance.dispose()

  // 手动标的放假优先，且比春节更近就先显示它。
  const withOverride = JSON.parse(JSON.stringify(baseConfig))
  withOverride.calendar.overrides['2026-01-20'] = 1
  instance = await launch(withOverride)
  instance.atDate(2026, 0, 15, 10, 0)
  line = holidayLine(instance)
  lineText = line === null ? '' : textOf(line)
  check(lineText.includes('手动放假') && lineText.includes('还有 5 天'), '手动放假插进倒计时', lineText)
  instance.dispose()

  // 完全没有该年数据（2027 未收录）也不能崩，只是没有这一行。
  instance = await launch(baseConfig)
  instance.atDate(2027, 0, 15, 10, 0)
  check(holidayLine(instance) === null, '没有可用节假日数据时不显示该行（也不报错）')
  instance.dispose()

  // 两层都拿不到（Host 401 + 供应商掉线）→ 走内置快照，但面板里**不再**显示数据源那行。
  const offlineFetch = async (url, init) => {
    const target = String(url)
    if (target.indexOf('timor.tech') >= 0) throw new Error('offline')
    if (target.indexOf('/api/reminder-clock/holidays') >= 0) return { ok: false, status: 401, json: async () => ({}) }
    const method = (init && init.method) || 'GET'
    const config = method === 'POST' ? JSON.parse(init.body).config : baseConfig
    return { ok: true, status: 200, json: async () => ({ ok: true, config, source: 'disk' }) }
  }
  const offline = createInstance({ react: stub, fetchImpl: offlineFetch })
  offline.plugin.apply(offline.ctx)
  await new Promise((resolve) => setTimeout(resolve, 40))
  offline.atDate(2026, 0, 15, 10, 0)
  const offlineText = textOf(panel(offline))
  check(!offlineText.includes('内置快照'), '面板不再显示「节假日数据：内置快照」那行', offlineText.slice(0, 200))
  check(offlineText.includes('春节'), '快照兜底时倒计时照常显示', offlineText.slice(0, 200))
  offline.dispose()

  // 对齐契约：提醒行与节假日行都是同一套 5 列栅格（表情/名称/时间/标签/状态）。
  instance = await launch(baseConfig)
  instance.atDate(2026, 0, 15, 10, 0)
  const tree = panel(instance)
  const rows = findAll(
    tree,
    (node) =>
      node.type === 'div' && typeof node.props?.className === 'string' && node.props.className.indexOf('drc-row') === 0,
  )
  const layoutRow = find(
    tree,
    (node) =>
      node.type === 'div' &&
      typeof node.props?.className === 'string' &&
      node.props.className.indexOf('drc-holiday') === 0,
  )
  check(
    rows.length >= 1 && rows.every((row) => findAll(row, (node) => node.type === 'span').length === 5),
    '提醒行都是 5 列',
    rows.map((row) => findAll(row, (node) => node.type === 'span').length),
  )
  check(
    findAll(layoutRow, (node) => node.type === 'span').length === 5,
    '节假日行用同一套 5 列栅格',
    findAll(layoutRow, (node) => node.type === 'span').length,
  )
  instance.dispose()
}

// ---------------------------------------------------------------------------
console.log('\nPass I — 拖拽定位 + 四个角落预设')
{
  const baseConfig = {
    version: 1,
    enabled: true,
    items: [
      {
        id: 'offwork',
        label: '下班',
        emoji: '🌇',
        time: '18:00',
        enabled: true,
        days: 'workday',
        message: '收工回家。',
      },
    ],
    options: {
      showCountdown: true,
      openOnHover: true,
      snoozeMinutes: 5,
      graceMinutes: 3,
      position: 'top-right',
      freePos: null,
    },
    calendar: {
      cycle: null,
      bigWorkdays: [1, 2, 3, 4, 5, 6],
      smallWorkdays: [1, 2, 3, 4, 5],
      overrides: {},
      sync: true,
    },
  }
  const fetchOf = (config) => async (url, init) => {
    const method = (init && init.method) || 'GET'
    if (String(url).indexOf('/holidays') >= 0) return { ok: true, status: 200, json: async () => HOLIDAYS_EMPTY }
    const body = method === 'POST' ? JSON.parse(init.body).config : config
    return { ok: true, status: 200, json: async () => ({ ok: true, config: body, source: 'disk' }) }
  }
  const launch = async (config, options = {}) => {
    const instance = createInstance(Object.assign({ react: stub, fetchImpl: fetchOf(config) }, options))
    instance.plugin.apply(instance.ctx)
    await new Promise((resolve) => setTimeout(resolve, 30))
    return instance
  }
  const view = (instance) => {
    const component = instance.registered.get('shell.overlay:reminder-clock').Component
    stub.__reset()
    return expand(React.createElement(component), stub)
  }
  const pillOf = (tree) => find(tree, (node) => node.type === 'button' && node.props['aria-expanded'] !== undefined)
  /** 最近一次保存到 Host 的 config。 */
  const lastSaved = (instance) => {
    const posts = instance.calls.filter((call) => call.method === 'POST')
    return posts.length === 0 ? null : JSON.parse(posts[posts.length - 1].body).config
  }
  /** 从 (x1,y1) 拖到 (x2,y2)；测试环境没有真实 DOM，rect 由 pointer 起点代替。 */
  const drag = (instance, from, to) => {
    const pill = pillOf(view(instance))
    pill.props.onPointerDown({ button: 0, pointerId: 1, clientX: from[0], clientY: from[1] })
    pill.props.onPointerMove({ pointerId: 1, clientX: (from[0] + to[0]) / 2, clientY: from[1] })
    pill.props.onPointerMove({ pointerId: 1, clientX: to[0], clientY: to[1] })
    pill.props.onPointerUp({ pointerId: 1, clientX: to[0], clientY: to[1] })
  }

  // 拖到视口中偏左 → 存成「左 / 上」锚点，并让根节点用自由定位。
  let instance = await launch(baseConfig)
  drag(instance, [200, 100], [500, 300])
  await new Promise((resolve) => setTimeout(resolve, 20))
  let saved = lastSaved(instance)
  check(
    saved !== null && saved.options.freePos !== null,
    '拖拽后写入自由位置',
    saved === null ? null : saved.options.freePos,
  )
  check(
    saved.options.freePos.anchor === 'left' && saved.options.freePos.vAnchor === 'top',
    '靠左靠上 → 左/上锚点',
    saved.options.freePos,
  )
  check(
    saved.options.freePos.x === 500 && saved.options.freePos.y === 300,
    '记下离锚边的像素距离',
    saved.options.freePos,
  )
  check(saved.options.position === 'top-right', '预设值保留（回到预设时要用）', saved.options.position)
  let root = view(instance)
  check(
    typeof root.props.className === 'string' && root.props.className.indexOf('drc-free') >= 0,
    '根节点切到自由定位类',
    root.props.className,
  )
  check(root.props.style.left === '500px' && root.props.style.top === '300px', '内联样式按锚点定位', root.props.style)
  instance.dispose()

  // 拖到右下 → 上锚点失效、改用 bottom/right，弹窗朝内展开。
  instance = await launch(baseConfig)
  drag(instance, [900, 500], [1150, 700])
  await new Promise((resolve) => setTimeout(resolve, 20))
  saved = lastSaved(instance)
  check(
    saved.options.freePos.anchor === 'right' && saved.options.freePos.vAnchor === 'bottom',
    '靠右靠下 → 右/下锚点',
    saved.options.freePos,
  )
  check(
    saved.options.freePos.x === 130 && saved.options.freePos.y === 100,
    '右/下锚点记的是到边的距离',
    saved.options.freePos,
  )
  root = view(instance)
  check(
    root.props.className.indexOf('drc-free-right') > 0 && root.props.className.indexOf('drc-free-up') > 0,
    '根节点带上朝向类',
    root.props.className,
  )
  check(
    root.props.style.right === '130px' && root.props.style.bottom === '100px',
    '样式用 right/bottom',
    root.props.style,
  )
  instance.dispose()

  // 抖一下就松手 = 点击，不该写位置，而且面板照常开合。
  instance = await launch(baseConfig)
  const pill = pillOf(view(instance))
  pill.props.onPointerDown({ button: 0, pointerId: 1, clientX: 200, clientY: 100 })
  pill.props.onPointerMove({ pointerId: 1, clientX: 202, clientY: 101 })
  pill.props.onPointerUp({ pointerId: 1, clientX: 202, clientY: 101 })
  pill.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(lastSaved(instance) === null, '小于阈值的位移不写位置', lastSaved(instance))
  check(pillOf(view(instance)).props['aria-expanded'] === true, '抖动后仍按点击处理（面板打开）')
  instance.dispose()

  // 拖动结束后的那次 click 会被吞掉（否则面板刚拖完就弹出来）。
  instance = await launch(baseConfig)
  drag(instance, [200, 100], [500, 300])
  pillOf(view(instance)).props.onClick()
  const afterDragClick = view(instance)
  check(
    find(
      afterDragClick,
      (node) => typeof node.props?.className === 'string' && node.props.className.indexOf('drc-panel') === 0,
    ) === null,
    '拖动后的 click 被吞掉，面板不弹',
  )
  instance.dispose()

  // 触摸拖动超过浏览器 click slop 时那次 click 不会来：时间窗过期后，
  // 下一次点击必须照常打开面板（标记不能留死把点击一直吃掉）。
  instance = await launch(baseConfig)
  drag(instance, [200, 100], [500, 300])
  instance.at(11, 59, 59) // 时钟前进 1s，超过吞点击的时间窗（350ms）
  pillOf(view(instance)).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(pillOf(view(instance)).props['aria-expanded'] === true, '拖拽 350ms 之后的点击不再被吞', view(instance))
  instance.dispose()

  // 拖到右上预设附近 → 吸附回预设，清掉自由位置（预设锚点：right 16 / top 136）。
  instance = await launch(baseConfig)
  drag(instance, [1100, 160], [1210, 120])
  await new Promise((resolve) => setTimeout(resolve, 20))
  saved = lastSaved(instance)
  check(saved.options.freePos === null, '贴近预设就吸附，不再用自由位置', saved.options.freePos)
  check(saved.options.position === 'top-right', '吸附成右上预设', saved.options.position)
  instance.dispose()

  // 左侧已经没有预设：拖到左上角会留成自由位置（左/上锚点），不会再吸附。
  instance = await launch(baseConfig)
  drag(instance, [120, 120], [12, 12])
  await new Promise((resolve) => setTimeout(resolve, 20))
  saved = lastSaved(instance)
  check(
    saved.options.freePos !== null &&
      saved.options.freePos.anchor === 'left' &&
      saved.options.freePos.vAnchor === 'top',
    '左侧没有预设，拖过去就是自由位置',
    saved.options.freePos,
  )
  check(saved.options.position === 'top-right', '预设值保持不变', saved.options.position)
  instance.dispose()

  // 已有自由位置时，根节点直接用自由定位（不用上一次的角落预设）。
  const placed = JSON.parse(JSON.stringify(baseConfig))
  placed.options.freePos = { anchor: 'left', x: 40, vAnchor: 'bottom', y: 60 }
  instance = await launch(placed)
  root = view(instance)
  check(
    root.props.style.left === '40px' && root.props.style.bottom === '60px',
    '启动时沿用已保存的自由位置',
    root.props.style,
  )
  instance.dispose()

  // 设置页：选预设 / 「回到预设位置」都会清掉自由位置。
  instance = await launch(placed)
  const renderSettings = () => {
    const component = instance.registered.get('settings.section:reminder-clock').Component
    stub.__reset()
    return expand(React.createElement(component), stub)
  }
  let settingsTree = renderSettings()
  check(textOf(settingsTree).includes('已自定义位置'), '设置页显示当前是自定义位置', textOf(settingsTree).slice(0, 120))
  find(settingsTree, (node) => node.type === 'button' && textOf(node) === '回到预设位置').props.onClick()
  settingsTree = renderSettings()
  check(textOf(settingsTree).includes('当前跟随上面的预设'), '「回到预设位置」后回到预设提示')
  const presetSelect = find(settingsTree, (node) => node.type === 'select' && node.props.value === 'top-right')
  check(presetSelect !== null, '位置预设选择器在', presetSelect === null ? null : presetSelect.props.value)
  const presetOptions = findAll(settingsTree, (node) => node.type === 'option').filter(
    (node) =>
      node.props.value === 'top-right' ||
      node.props.value === 'bottom-right' ||
      node.props.value === 'top-left' ||
      node.props.value === 'bottom-left',
  )
  check(
    presetOptions.length === 2 && presetOptions.every((node) => node.props.value.endsWith('-right')),
    '只保留右上/右下两个预设',
    presetOptions.map((node) => node.props.value),
  )
  presetSelect.props.onChange({ target: { value: 'bottom-right' } })
  settingsTree = renderSettings()
  check(
    textOf(settingsTree).includes('当前跟随上面的预设'),
    '切换预设后仍然是预设模式（不会残留自定义位置）',
    textOf(settingsTree).slice(0, 120),
  )
  instance.dispose()

  // 默认位置是右下；右下的面板向上弹、胶囊原地不动（column-reverse），
  // 两个预设的偏移都由 POSITION_ANCHORS 生成，CSS 与吸附共用一张表。
  const noPosition = JSON.parse(JSON.stringify(baseConfig))
  delete noPosition.options.position
  instance = await launch(noPosition)
  const defaultRoot = view(instance)
  check(
    typeof defaultRoot.props.className === 'string' && defaultRoot.props.className.indexOf('pos-bottom-right') >= 0,
    'Host 没给 position 时默认渲染成右下',
    defaultRoot.props.className,
  )
  const cssText = instance.styles[0].textContent
  const bottomRightRule = /\.drc-root\.pos-bottom-right\{[^}]*\}/.exec(cssText)
  check(
    bottomRightRule !== null && bottomRightRule[0].indexOf('flex-direction:column-reverse') >= 0,
    '右下预设用 column-reverse：面板向上弹，胶囊不被顶上去',
    bottomRightRule === null ? null : bottomRightRule[0],
  )
  check(
    bottomRightRule !== null && /bottom:\d+px/.test(bottomRightRule[0]) && /right:\d+px/.test(bottomRightRule[0]),
    '右下预设的偏移来自 POSITION_ANCHORS',
    bottomRightRule === null ? null : bottomRightRule[0],
  )
  instance.dispose()

  // 吸附也认右下（测试视口 1280x800：right 16 / bottom 10 → 落点 left 1264 / top 790）。
  instance = await launch(baseConfig)
  drag(instance, [1200, 800], [1264, 790])
  await new Promise((resolve) => setTimeout(resolve, 20))
  saved = lastSaved(instance)
  check(
    saved.options.freePos === null && saved.options.position === 'bottom-right',
    '拖到右下预设附近吸附回右下',
    saved.options,
  )
  instance.dispose()

  // 旧 Host 半（响应里根本没有 freePos 这个键）不能把镜像里的拖拽位置抹掉；
  // 但新 Host 明确回 null 时，null 说了算（那是「回到预设位置」的回声）。
  const mirrored = { anchor: 'right', x: 24, vAnchor: 'bottom', y: 36 }
  const seeded = JSON.parse(JSON.stringify(baseConfig))
  seeded.options.freePos = mirrored
  const olderHostConfig = JSON.parse(JSON.stringify(baseConfig))
  delete olderHostConfig.options.freePos
  instance = await launch(olderHostConfig, { seedStorage: { 'dsh.reminderClock.v1': seeded } })
  const mirroredRoot = view(instance)
  check(
    mirroredRoot.props.style !== undefined &&
      mirroredRoot.props.style.right === '24px' &&
      mirroredRoot.props.style.bottom === '36px',
    '旧 Host 也不会抹掉镜像里的拖拽位置',
    mirroredRoot.props.style,
  )
  instance.dispose()

  instance = await launch(baseConfig, { seedStorage: { 'dsh.reminderClock.v1': seeded } })
  check(
    view(instance).props.style === undefined,
    '新 Host 明确回 null 时以 Host 为准（回到预设）',
    view(instance).props.style,
  )
  instance.dispose()
}

// ---------------------------------------------------------------------------
console.log('\nPass J — 提醒文案收进二级配置（行内展开）')
{
  const baseConfig = {
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
        message: '该吃午饭了。',
      },
      {
        id: 'offwork',
        label: '下班',
        emoji: '🌇',
        time: '18:00',
        enabled: true,
        days: 'workday',
        message: '收工回家。',
      },
    ],
    options: { showCountdown: true, snoozeMinutes: 5, graceMinutes: 3, position: 'bottom-right', freePos: null },
    calendar: {
      cycle: null,
      bigWorkdays: [1, 2, 3, 4, 5, 6],
      smallWorkdays: [1, 2, 3, 4, 5],
      overrides: {},
      sync: true,
    },
  }
  const fetchOf = (config) => async (url, init) => {
    const method = (init && init.method) || 'GET'
    if (String(url).indexOf('/holidays') >= 0) return { ok: true, status: 200, json: async () => HOLIDAYS_EMPTY }
    const body = method === 'POST' ? JSON.parse(init.body).config : config
    return { ok: true, status: 200, json: async () => ({ ok: true, config: body, source: 'disk' }) }
  }
  const instance = createInstance({ react: stub, fetchImpl: fetchOf(baseConfig) })
  instance.plugin.apply(instance.ctx)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const renderSettings = () => {
    const component = instance.registered.get('settings.section:reminder-clock').Component
    stub.__reset()
    return expand(React.createElement(component), stub)
  }
  const messageInputs = (tree) => findAll(tree, (node) => node.props?.['aria-label'] === '提醒文案')
  const expanders = (tree) =>
    findAll(
      tree,
      (node) => node.type === 'button' && String(node.props['aria-label'] || '').indexOf('的提醒文案设置') > 0,
    )

  let tree = renderSettings()
  check(messageInputs(tree).length === 0, '默认折叠：表格里没有提醒文案输入框', messageInputs(tree).length)
  check(!textOf(tree).includes('提醒文案\n'), '表头不再有「提醒文案」这一列')
  const buttons = expanders(tree)
  check(buttons.length === 2, '每一行都有一个展开箭头', buttons.length)
  check(buttons[0].props.className.indexOf('drc-more-set') > 0, '已设文案的行箭头有提示色', buttons[0].props.className)

  buttons[0].props.onClick()
  tree = renderSettings()
  check(messageInputs(tree).length === 1, '只展开被点的那一行', messageInputs(tree).length)
  check(
    messageInputs(tree)[0].props.value === '该吃午饭了。',
    '展开后带出该行原来的文案',
    messageInputs(tree)[0].props.value,
  )

  expanders(tree)[1].props.onClick()
  tree = renderSettings()
  check(
    messageInputs(tree).length === 2 && messageInputs(tree)[1].props.value === '收工回家。',
    '两行的展开状态互不影响',
    messageInputs(tree).map((node) => node.props.value),
  )

  messageInputs(tree)[0].props.onChange({ target: { value: '去吃饭，别硬扛。' } })
  tree = renderSettings()
  check(messageInputs(tree)[0].props.value === '去吃饭，别硬扛。', '展开区里改文案会进草稿')
  buttonByText(tree, '保存').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const posts = instance.calls.filter((call) => call.method === 'POST')
  const saved = JSON.parse(posts[posts.length - 1].body).config
  check(saved.items[0].message === '去吃饭，别硬扛。', '保存后文案落到 Host', saved.items[0].message)
  check(saved.items[1].message === '收工回家。', '没展开的那一行文案没被碰', saved.items[1].message)
  instance.dispose()
}

// ---------------------------------------------------------------------------
console.log('\nPass K — 设置页异步状态 + 「已错过」文案')
{
  const baseConfig = {
    version: 1,
    enabled: true,
    items: [
      { id: 'lunch', label: '午餐', emoji: '🍚', time: '11:30', enabled: true, days: 'every', message: '干饭' },
      { id: 'offwork', label: '下班', emoji: '🌇', time: '18:00', enabled: true, days: 'every', message: '' },
    ],
    options: { showCountdown: true, snoozeMinutes: 5, graceMinutes: 3, position: 'bottom-right', freePos: null },
    calendar: {
      cycle: null,
      bigWorkdays: [1, 2, 3, 4, 5, 6],
      smallWorkdays: [1, 2, 3, 4, 5],
      overrides: {},
      sync: true,
    },
  }
  let failPost = false
  const instance = createInstance({
    react: stub,
    hour: 15, // 11:30 早就过了（超出 3 分钟宽限），18:00 还没到
    minute: 0,
    second: 0,
    fetchImpl: async (url, init) => {
      const method = (init && init.method) || 'GET'
      if (String(url).indexOf('/holidays') >= 0) return { ok: true, status: 200, json: async () => HOLIDAYS_EMPTY }
      if (method === 'POST' && failPost) return { ok: false, status: 500, json: async () => ({ ok: false }) }
      const body = method === 'POST' ? JSON.parse(init.body).config : baseConfig
      return { ok: true, status: 200, json: async () => ({ ok: true, config: body, source: 'disk' }) }
    },
  })
  instance.plugin.apply(instance.ctx)
  await new Promise((resolve) => setTimeout(resolve, 30))

  const view = (slot) => {
    stub.__reset()
    return expand(React.createElement(instance.registered.get(slot + ':reminder-clock').Component), stub)
  }
  const openPanel = () => {
    const pill = find(
      view('shell.overlay'),
      (node) => node.type === 'button' && node.props['aria-expanded'] !== undefined,
    )
    pill.props.onClick()
    return textOf(view('shell.overlay'))
  }

  // 过了宽限窗口、今天根本没弹过 → 不能说「已提醒」。
  const panel = openPanel()
  check(panel.includes('已错过'), '超出宽限没弹过的提醒标「已错过」', panel)
  check(!panel.includes('已提醒'), '没弹过的提醒不再谎报「已提醒」', panel)
  check(panel.includes('午餐') && panel.includes('下班'), '两行都还在', panel)

  // 真的到点弹过 → 才是「已提醒」。
  instance.at(18, 0, 0)
  check(textOf(view('shell.overlay')).includes('知道了'), '到点照常弹卡片')
  buttonByText(view('shell.overlay'), '知道了').props.onClick()
  instance.at(18, 1, 0)
  const after = textOf(view('shell.overlay'))
  check(after.includes('已提醒'), '真弹过的提醒标「已提醒」', after)
  check(after.includes('已错过'), '午餐仍然是「已错过」', after)

  // 保存失败必须落到页面上，而且按钮要回到可用（否则只能刷新页面）。
  failPost = true
  const settings = () => view('settings.section')
  const timeInput = find(settings(), (node) => node.type === 'input' && node.props.type === 'time')
  timeInput.props.onChange({ target: { value: '11:45' } })
  buttonByText(settings(), '保存').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const failed = settings()
  check(textOf(failed).includes('保存失败'), '保存失败会显示出来', textOf(failed).slice(-140))
  check(buttonByText(failed, '保存').props.disabled === false, '保存失败后按钮恢复可用')
  failPost = false
  buttonByText(settings(), '保存').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 40))
  check(textOf(settings()).includes('已保存'), '重试后保存成功', textOf(settings()).slice(-140))
  check(instance.storage.get('dsh.reminderClock.v1').items[0].time === '11:45', '成功那次写进了本地镜像')
  instance.dispose()
}

// ---------------------------------------------------------------------------
console.log('\nPass L — 两半共用同一套配置归一化')
{
  const instance = createInstance({
    react: stub,
    hour: 9,
    minute: 0,
    second: 0,
    fetchImpl: async (url, init) => {
      const method = (init && init.method) || 'GET'
      if (String(url).indexOf('/holidays') >= 0) return { ok: true, status: 200, json: async () => HOLIDAYS_EMPTY }
      const config = {
        items: [
          { id: 'lunch', label: '午餐', emoji: '🍚', time: ' 09:00 ', enabled: true, days: 'every', message: '' },
        ],
        options: {},
        calendar: {},
      }
      const body = method === 'POST' ? JSON.parse(init.body).config : config
      return { ok: true, status: 200, json: async () => ({ ok: true, config: body, source: 'disk' }) }
    },
  })
  instance.plugin.apply(instance.ctx)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const settings = instance.registered.get('settings.section:reminder-clock').Component
  stub.__reset()
  const tree = expand(React.createElement(settings), stub)
  const timeInput = find(tree, (node) => node.type === 'input' && node.props.type === 'time')
  check(
    timeInput.props.value === '09:00',
    '带空格的时间被 trim 成 09:00（旧 client 会变成 12:00）',
    timeInput.props.value,
  )
  check(
    instance.storage.get('dsh.reminderClock.v1').items[0].time === '09:00',
    '本地镜像存的是同一套归一化结果',
    instance.storage.get('dsh.reminderClock.v1').items[0].time,
  )
  instance.dispose()
}

console.log(failures === 0 ? '\nclient-smoke: all checks passed' : '\nclient-smoke: ' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
