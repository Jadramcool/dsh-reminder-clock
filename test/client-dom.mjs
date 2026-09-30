// 真 React + 真 DOM 冒烟（可选的 `pnpm test:dom`）。
//
//   node test/client-dom.mjs
//
// 为什么单独一个脚本：`test/client-smoke.mjs` 用的是桩 React，它的
// `useSyncExternalStore` 不订阅 store、每次断言都重新渲染一棵新树，所以**结构上**
// 验证不了「异步状态变化到底有没有触发重渲染」——保存失败卡死、同步失败静默这两类
// bug 就是这么漏出去的。这里用真 React 18 + 真 DOM（headless Chrome）盖住那一层。
//
// 驱动的是**真产物** `lib/client.js`：页面先放 `window.__ModuleLoader__` 桩，再加载
// 产物（走真实 handoff 契约），最后用打包进来的 React 实例把它的 factory 实例化。
//
// 依赖本机 Chrome（`CHROME_PATH` 可覆盖）；找不到浏览器时打印 SKIP 并以 0 退出，
// 所以它不进默认的 `pnpm test`，但也不会把「没装 Chrome」变成红灯。
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 本机没装 Chrome 时打印 SKIP 并以 0 退出，所以这个脚本可以安全地放进 CI 的独立 job。
const chromeCandidates = [
  process.env.CHROME_PATH,
  // Windows
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  // Linux（GitHub Actions 的 ubuntu runner 自带 Chrome）
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0)
const chrome = chromeCandidates.find((candidate) => existsSync(candidate))

let failures = 0
function check(ok, label, detail) {
  if (ok) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const bundlePath = join(root, 'lib/client.js')
if (!existsSync(bundlePath)) {
  console.error('lib/client.js is missing; run `pnpm build` first')
  process.exit(1)
}
if (chrome === undefined) {
  console.log('\nclient-dom: SKIPPED — no Chrome/Edge found (set CHROME_PATH to enable)')
  process.exit(0)
}

const workDir = mkdtempSync(join(tmpdir(), 'drc-dom-'))
try {
  // 1) harness 打包（react / react-dom 一起打进来，保证只有一份 React 实例）
  const harness = join(workDir, 'harness.js')
  await build({
    entryPoints: [join(root, 'test/dom-harness.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    jsx: 'automatic',
    charset: 'utf8',
    outfile: harness,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  })

  // 2) 页面：ModuleLoader 桩 → 真产物 → harness
  writeFileSync(join(workDir, 'client.js'), readFileSync(bundlePath, 'utf8'), 'utf8')
  writeFileSync(
    join(workDir, 'index.html'),
    `<!doctype html>
<html><head><meta charset="utf-8"><title>drc-dom</title></head>
<body>
<script>window.__drcDefs = []; window.__ModuleLoader__ = { load: function (def) { window.__drcDefs.push(def); } };</script>
<script src="./client.js"></script>
<script src="./harness.js"></script>
</body></html>
`,
    'utf8',
  )

  // 3) 跑 headless Chrome（虚拟时间会把 harness 里的等待快进掉）
  mkdirSync(join(workDir, 'profile'), { recursive: true })
  const args = [
    // 用裸 `--headless`：Chrome 112+ 它本身就是 new headless，`--headless=new`
    // 在更新的版本上只是别名，裸写法跨版本更稳。
    '--headless',
    '--disable-gpu',
    // 容器/CI 里 /dev/shm 往往很小，不加这个 Chrome 会直接崩。
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--user-data-dir=' + join(workDir, 'profile'),
    '--virtual-time-budget=30000',
    '--dump-dom',
    // CI 容器里的 Chrome 常常起不来命名空间沙箱；这里跑的是本地临时文件页面。
    ...(process.env.CI ? ['--no-sandbox'] : []),
    pathToFileURL(join(workDir, 'index.html')).href,
  ]
  let dom = ''
  try {
    dom = execFileSync(chrome, args, {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    dom = String((err && err.stdout) || '')
    if (dom === '') {
      const code = err && (err.status !== undefined ? err.status : err.code)
      console.error('chrome failed (exit=' + String(code) + ', signal=' + String(err && err.signal) + ')')
      console.error('chrome: ' + chrome)
      console.error('stderr: ' + String((err && err.stderr) || '').slice(-3000))
      console.error('stdout: ' + String((err && err.stdout) || '').slice(0, 1500))
      process.exit(1)
    }
  }

  const match = /<pre id="report">([\s\S]*?)<\/pre>/.exec(dom)
  if (match === null) {
    console.error('the harness produced no report (chrome ' + chrome + ', dom bytes ' + dom.length + ')')
    console.error('--- dom head ---\n' + dom.slice(0, 1500))
    console.error('--- dom tail ---\n' + dom.slice(-1500))
    process.exit(1)
  }
  const decoded = match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
  const report = JSON.parse(decoded)

  console.log('\nReal React ' + report.reactVersion + ' + real DOM, driving lib/client.js')
  check(
    typeof report.reactVersion === 'string' && report.reactVersion.startsWith('18'),
    'real React 18 is in use',
    report.reactVersion,
  )
  check(
    report.moduleId === 'dsh-reminder-clock',
    'the built bundle registered its factory under the package id',
    report.moduleId,
  )

  check(
    report.saveFail.showsFailure === true,
    'a failed save surfaces 「保存失败」 in the settings page',
    report.saveFail,
  )
  check(
    report.saveFail.disabled === false && report.saveFail.text === '保存',
    'a failed save leaves the 保存 button usable again',
    report.saveFail,
  )
  check(report.saveRetry.showsSaved === true, 'a retry then reports 「已保存」', report.saveRetry)

  check(report.syncFail.showsSyncing === true, '立即同步 shows 「同步中…」 while it runs', report.syncFail)
  check(report.syncFail.showsFailure === true, 'a failed 立即同步 surfaces 「同步失败」', report.syncFail)
  check(report.syncFail.disabled === false, 'the sync button returns to normal', report.syncFail)

  check(
    report.drag.immediateClickOpens === false,
    'the click the browser fires right after a drag is still swallowed',
    report.drag,
  )
  check(report.drag.lateClickOpens === true, 'a click after the 350ms window opens the panel', report.drag)

  check(report.missed.showsMissed === true, 'a reminder missed past the grace window reads 「已错过」', report.missed)
  check(report.missed.showsReminded === false, 'nothing claims 「已提醒」 when it never fired', report.missed)

  check(report.consoleNoise.length === 0, 'real React logs no warning or error', report.consoleNoise.slice(0, 4))

  console.log(failures === 0 ? '\nclient-dom: all checks passed' : '\nclient-dom: ' + failures + ' FAILED')
  process.exit(failures === 0 ? 0 : 1)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
