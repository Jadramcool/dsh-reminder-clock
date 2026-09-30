// 真 React + 真 DOM 冒烟——由 test/client-dom.mjs 用 esbuild 打包后在 headless Chrome 里跑。
//
// 页面里先加载**真产物** lib/client.js（连同 `window.__ModuleLoader__.load` handoff
// 契约），这里再用打包进来的 React 实例把它的 factory 实例化：react 只有一份，
// 所以插件里的 hooks 与这里的 createRoot 共用同一个实例（两份 React 会直接报错）。
//
// 负责的是桩 React 测不了的那一类：`useSyncExternalStore` 的订阅语义（保存/同步这些
// 异步状态到底有没有落到 DOM 上）、真实事件下的拖拽吞点击窗口、以及面板文案。
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'

type HarnessWindow = {
  __drcDefs?: { id: string; factory: (require: (spec: string) => unknown) => any }[]
  __drcReact?: { react: typeof React; jsxRuntime: typeof jsxRuntime; createRoot: typeof createRoot }
}

const w = window as unknown as HarnessWindow
w.__drcReact = { react: React, jsxRuntime, createRoot }

const lines: string[] = []
const say = (text: string) => {
  lines.push(text)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const consoleNoise: string[] = []
const origError = console.error.bind(console)
const origWarn = console.warn.bind(console)
console.error = (...args: unknown[]) => {
  consoleNoise.push('error: ' + args.map((a) => String(a)).join(' '))
  origError(...args)
}
console.warn = (...args: unknown[]) => {
  consoleNoise.push('warn: ' + args.map((a) => String(a)).join(' '))
  origWarn(...args)
}

/** 一次真实往返的延迟：同步返回的 fetch 会让 React 把两次渲染合并，掩盖订阅问题。 */
const ROUND_TRIP_MS = 60
/** fail = host 写盘/同步都失败；ok = 都成功。 */
let mode: 'fail' | 'ok' = 'fail'
const fetchLog: string[] = []

const config = {
  version: 1,
  enabled: true,
  items: [
    { id: 'lunch', label: '午餐', emoji: '🍚', time: '11:30', enabled: true, days: 'every', message: '干饭' },
    { id: 'offwork', label: '下班', emoji: '🌇', time: '23:40', enabled: true, days: 'every', message: '' },
  ],
  options: { showCountdown: true, snoozeMinutes: 5, graceMinutes: 3, position: 'bottom-right', freePos: null },
  calendar: { cycle: null, bigWorkdays: [1, 2, 3, 4, 5, 6], smallWorkdays: [1, 2, 3, 4, 5], overrides: {}, sync: true },
}

const payload = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

;(window as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string }) => {
  const method = (init && init.method) || 'GET'
  fetchLog.push(method + ' ' + url)
  await sleep(ROUND_TRIP_MS)
  if (String(url).startsWith('/api/reminder-clock/config')) {
    if (method === 'POST') {
      if (mode === 'fail') return payload(500, { ok: false, error: 'write-failed' })
      return payload(200, { ok: true, config, source: 'disk' })
    }
    return payload(200, { ok: true, config, source: 'disk' })
  }
  if (String(url).startsWith('/api/reminder-clock/holidays')) {
    if (mode === 'fail') return payload(502, { ok: false, error: 'sync-failed', syncError: 'HTTP 404' })
    return payload(200, {
      ok: true,
      years: { 2026: { '10-01': [1, '国庆节'] } },
      fetchedAt: new Date().toISOString(),
      provider: 'https://timor.tech/api/holiday/year/',
      syncEnabled: true,
      syncError: null,
    })
  }
  return payload(500, {})
}

// ---- 最小 cordis ctx（真实运行时由 DSH 提供；这里只需要 slots + effect 的形状）----
let overlayComponent: any = null
let settingsComponent: any = null
const slots = {
  inject: (_key: string, callback: () => unknown) => {
    callback()
    return () => {}
  },
  register: (options: { name: string }, component: unknown) => {
    if (options.name === 'shell.overlay') overlayComponent = component
    if (options.name === 'settings.section') settingsComponent = component
    return () => {}
  },
}
const ctx = {
  slots,
  effect: (callback: () => unknown) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
}

const report = {
  reactVersion: React.version,
  moduleId: null as string | null,
  saveFail: { text: '', disabled: true, showsFailure: false },
  saveRetry: { showsSaved: false },
  syncFail: { text: '', disabled: true, showsFailure: false, showsSyncing: false },
  drag: { immediateClickOpens: false, lateClickOpens: false },
  missed: { panelText: '', showsMissed: false, showsReminded: false },
  consoleNoise: consoleNoise,
}

const flush = (status: string) => {
  say(status)
}

const run = async () => {
  const definitions = (window as unknown as HarnessWindow).__drcDefs || []
  const definition = definitions.find((entry) => entry.id === 'dsh-reminder-clock')
  if (definition === undefined) throw new Error('lib/client.js did not register a dsh-reminder-clock factory')
  report.moduleId = definition.id
  const plugin = definition.factory((spec) => {
    if (spec === 'react') return React
    if (spec === 'react/jsx-runtime') return jsxRuntime
    throw new Error('unexpected require: ' + spec)
  })
  if (typeof plugin.apply !== 'function') throw new Error('the built factory does not export apply()')
  flush('module ok: ' + report.moduleId + ' / react ' + report.reactVersion)
  plugin.apply(ctx)
  if (settingsComponent === null || overlayComponent === null)
    throw new Error('the plugin registered no slot components')
  flush('slots registered')

  // ---- 设置页：写盘失败必须可见，且按钮要回到可用 ----
  const host = document.createElement('div')
  document.body.appendChild(host)
  const mountSettings = () => {
    const node = document.createElement('div')
    host.appendChild(node)
    createRoot(node).render(React.createElement(settingsComponent))
    return node
  }
  mountSettings()
  await sleep(1200) // 等首次加载完成
  const buttonByText = (root: ParentNode, label: string) =>
    Array.from(root.querySelectorAll('button')).find((b) => (b.textContent || '').trim().startsWith(label)) as
      HTMLButtonElement | undefined
  const save = buttonByText(host, '保存')!
  save.click()
  await sleep(900)
  report.saveFail = {
    text: (save.textContent || '').trim(),
    disabled: save.disabled,
    showsFailure: host.innerText.includes('保存失败'),
  }
  flush('save-fail sampled')

  mode = 'ok'
  save.click()
  await sleep(700)
  report.saveRetry = { showsSaved: host.innerText.includes('已保存') }
  flush('save-retry sampled')

  // ---- 节假日「立即同步」全失败也必须可见 ----
  mode = 'fail'
  const sync = buttonByText(host, '立即同步')!
  sync.click()
  await sleep(120)
  const syncing = (sync.textContent || '').trim()
  await sleep(1200)
  report.syncFail = {
    text: (sync.textContent || '').trim(),
    disabled: sync.disabled,
    showsFailure: host.innerText.includes('同步失败'),
    showsSyncing: syncing.includes('同步中'),
  }
  flush('sync-fail sampled')

  // ---- 浮层：拖拽后的点击窗口 + 已错过文案 ----
  const overlayHost = document.createElement('div')
  document.body.appendChild(overlayHost)
  createRoot(overlayHost).render(React.createElement(overlayComponent))
  await sleep(400)
  const pill = document.querySelector('.drc-pill') as HTMLButtonElement | null
  if (pill === null) throw new Error('the countdown pill did not render')
  // 无头环境没有真实指针，捕捉 API 直接抹掉（逻辑上不影响拖拽换算）。
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.setPointerCapture = () => {}
  proto.releasePointerCapture = () => {}
  const pointer = (x: number, y: number, extra: Record<string, unknown> = {}) =>
    ({
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: x,
      clientY: y,
      ...extra,
    }) as PointerEventInit
  const drag = (x1: number, y1: number, x2: number, y2: number) => {
    pill.dispatchEvent(new PointerEvent('pointerdown', pointer(x1, y1, { button: 0, buttons: 1 })))
    pill.dispatchEvent(new PointerEvent('pointermove', pointer(x2, y2, { buttons: 1 })))
    pill.dispatchEvent(new PointerEvent('pointerup', pointer(x2, y2, { button: 0 })))
  }
  const panelOpen = () => document.querySelector('.drc-panel') !== null
  drag(100, 100, 130, 120)
  await sleep(60)
  pill.click() // 浏览器紧跟着补的那次 click：应该被吞掉
  await sleep(100)
  report.drag.immediateClickOpens = panelOpen()
  if (panelOpen()) {
    pill.click()
    await sleep(100)
  }
  drag(200, 200, 240, 230)
  await sleep(500) // 触摸拖动根本不会补 click；窗口过期后的点击必须照常生效
  pill.click()
  await sleep(200)
  report.drag.lateClickOpens = panelOpen()
  const panel = document.querySelector('.drc-panel') as HTMLElement | null
  report.missed = {
    panelText: panel === null ? '' : panel.innerText.replace(/\s+/g, ' '),
    showsMissed: panel !== null && panel.innerText.includes('已错过'),
    showsReminded: panel !== null && panel.innerText.includes('已提醒'),
  }
  flush('drag + panel sampled')
}

window.addEventListener('load', () => {
  run()
    .catch((err) => {
      report.consoleNoise.push('harness: ' + String((err && (err as Error).stack) || err))
    })
    .then(() => {
      report.consoleNoise = consoleNoise
      const pre = document.createElement('pre')
      pre.id = 'report'
      pre.textContent = JSON.stringify(report)
      document.body.appendChild(pre)
      document.title = 'DONE'
    })
})
