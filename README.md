# ⏰ dsh-reminder-clock — DSH 作息提醒

> **到点提醒你别硬扛。** DSH 窗口内弹出提醒卡片，平时在角落安静显示「距离下一条提醒还有多久」。时间、文案、位置全部可视化配置，写到 Host 磁盘，换浏览器 / 清缓存都不会丢。

```text
🍚 午餐  1:23:45          ← 常驻倒计时胶囊，鼠标悬停立刻展开今日安排
─────────────────────────
今日提醒      09-30 周三 · 工作日   ← 悬停/点击展开的面板
🍚 午餐   12:00  每天      已提醒
🌇 下班   18:00  仅工作日  还有 5:02:11
🎉 国庆节  7 天假           明天开始      ← 最近一个节假日倒计时
─────────────────────────
🍚 午餐  12:00 到点了      ← 到点弹出的提醒卡片
干饭干饭！干饭不积极，思想有问题！
   今天不再提醒   5 分钟后再说   知道了
```

休息日（周末 / 法定节假日 / 大小周的小周周六）里不适用「仅工作日」的项，会标成 `今日不提醒`，倒计时直接跳到下一个工作日。

---

## ✨ 功能

| 能力 | 说明 |
|---|---|
| 🔔 到点提醒 | 每条提醒项到点弹一次卡片，带「知道了 / N 分钟后再说 / 今天不再提醒」 |
| 🖱️ 悬浮即展开 | 鼠标移到倒计时胶囊上直接展开今日安排弹窗（悬停意图延迟 130ms，移开 240ms 后自动收起，鼠标从胶囊移到弹窗不会闪掉）；点击同样可开合。**这是固定行为，没有开关** |
| ⏱️ 常驻倒计时 | 角落胶囊显示下一条提醒的剩余时间，可整条关掉；休息日会自动跳过，显示「明天」或更远 |
| 🧩 自定义提醒项 | 设置页里增删任意条：图标、名称、时间、**适用日**、启用开关；**提醒文案是行内二级配置**——点每行左边的 `▸` 展开（可留空，已设文案的箭头会变蓝），这样主表格在窄面板下也不会被挤扁 |
| 🗓️ 工作日感知 | 每条可选「每天 / 仅工作日 / 仅休息日」；工作日 = 周一~周五，叠加下面的排班与节假日规则 |
| 🔁 大小周排班 | 可开关的交替大小周：大周 / 小周各自勾选上班的星期；启用时选「本周是大周还是小周」，之后自动交替 |
| 🇨🇳 法定节假日 | 内置 2025–2026 节假日快照（含调休补班）永远可用；在此之上按「Host 路由 → 本页直连供应商 → 内置快照」三层自动取新数据，缓存 30 天，还能手动加「某天放假 / 某天补班」覆盖 |
| 🎉 节假日倒计时 | 面板里今日安排下方常驻一行「最近的一个假期」：`🎉 国庆节  7 天假  明天开始`；假期进行中显示 `假期第 3/9 天`（带强调描边）；准确区间 `10-01 周四 – 10-07 周三，共 7 天` 走 `aria-label`（悬浮层不挂原生 tooltip，鼠标悬停不会有那种系统提示） |
| 🖐️ 拖拽定位 | 直接拖动胶囊把浮层放到任意位置（拖动时整个浮层一起走，含展开的面板）；松手位置存成「锚边 + 像素偏移」，窗口缩放后仍贴同一边、也不会跑到屏幕外；**拖到预设附近（±72px）自动吸附回预设**，设置里随时可「回到预设位置」。位移超过 4px 才算拖动，所以点击开关面板照旧 |
| 🗓️ 每天只响一次 | 同一个提醒项每天只弹一次，刷新页面不会重复弹 |
| 🛡️ 错过宽限 | 页面没开着时错过的提醒，超过宽限分钟数就不再补弹，避免一开 DSH 被一串过期提醒糊脸 |
| 💾 Host 磁盘持久化 | `~/.dsh/reminder-clock.json`；浏览器 localStorage 只作首屏兜底 |
| 🎨 跟随主题 | 全部用 DSH 主题 token，深浅色自动适配；窗口不可见/后台不额外消耗 |

**默认两条**：`🍚 午餐 12:00`（文案「干饭干饭！干饭不积极，思想有问题！」）、`🌇 下班 18:00`（文案「牛马收工~」），**都只在工作日提醒**（周末与法定节假日不响）。**时间、适用日、大小周、节假日在 设置 → 作息提醒 里改。**

### 工作日怎么判定

优先级从高到低，先命中先算：

1. **手动调整**（设置里加的 `2026-10-10 补班` / `2026-10-01 放假`）
2. **法定节假日 / 调休补班**（内置快照或联网同步的数据）
3. **大小周**（启用了才参与判断：本大周按大周的工作日列表，本小周按小周的）
4. 兜底：**周一~周五上班，周六周日休息**

判定结果只有「工作日 / 休息日」两种，再由每条提醒的**适用日**决定今天要不要响。

---

## 🏗️ 架构

| 半 | 源码 → 产物 | 职责 |
|---|---|---|
| 🖥️ Host | `src/index.mjs` → `lib/index.mjs` | `GET/POST /api/reminder-clock/config` + `GET/POST /api/reminder-clock/holidays`，**loopback-only** JSON 路由，原子写 `~/.dsh/reminder-clock.json`（tmp + rename），配置全量校验/归一 |
| 🌐 Client | `src/client/index.tsx` → `lib/client.js` | **TSX + JSX**（`react-jsx` 自动 runtime），esbuild 打成浏览器 CJS 后包进 ModuleLoader handoff 契约；注入 `shell.overlay`（倒计时胶囊 + 提醒卡片）与 `settings.section`（设置页），1 秒 tick 驱动提醒引擎 |
| 📅 节假日数据 | `src/holidays.mjs`（由 `scripts/fetch-holidays.mjs` 生成） | 年度节假日快照，构建时被 **esbuild 同时打进两个产物**，所以断网、host 未重启也能正确判定 |
| 📐 配置契约 | `src/shared/config.mjs` | 常量 + 归一化 + 出厂默认值**只有一份**，两个产物各自内联：以前两半各抄一份，已经漂移过（host 会 `trim()` 时间、client 不会，`" 09:00 "` 在两边会变成不同结果） |

- 🧰 **源码语言**：client 用 TSX（可以直接写 JSX，类型检查 `pnpm typecheck` 目前是绿灯的宽松基线）；host 仍是 `.mjs`，但构建走同一个 esbuild 管线，想换成 `src/index.ts` 只需改名（Node 24 也原生支持类型擦除）。
- 🪶 **零第三方运行时依赖**：host 只用 `node:fs` / `node:os` / `node:path`；client 的外部依赖只有 `react` / `react/jsx-runtime`——它们是 DSH loader 的 **platform seed 模块**，其余一律打包进 bundle（loader 的 `require` 遇到未知模块会直接抛错）。
- 🔒 路由带浏览器同源信任围栏（loopback socket + Host 头 + Origin 一致），任何越权请求 403。
- 🧱 client 侧所有渲染包在 ErrorBoundary 里：提醒坏了也绝不会带崩整个 DSH 界面。
- 🕐 触发语义：`0 <= 现在 - 目标时间 <= 宽限分钟` 且当天未触发过且「今天适用」→ 弹卡片；提醒项每天只弹一次；「稍后」以内存 + 当天记录为准。过了宽限窗口没弹成的项，在今日面板里标「已错过」（只有真弹过的才标「已提醒」，不谎报）。
- 🌐 节假日同步是**三层降级**，任何一层挂掉都只是「用旧数据」，提醒本身绝不受影响：
  1. **Host 路由** `GET/POST /api/reminder-clock/holidays` — 走 Host 自己的 `web` 服务（尊重你配置的 fetch provider / 代理 / 白名单），落盘缓存 `~/.dsh/reminder-clock-holidays.json`，多浏览器共用；
  2. **本页直连供应商** — 供应商对 CORS 全开放（`Access-Control-Allow-Origin: *`），所以 Host 半还没重启（路由 404/401）或 Host 本身没网时，浏览器自己取一次，存 localStorage；**这一层不需要任何 Host 代码**；
  3. **内置快照 + 本地镜像** — 兜底，断网/离线永远可用。
- 🚦 自动加载**静默降级**：拿不到新数据不会弹错误提示，只在设置页显示当前数据源（`Host 磁盘缓存` / `浏览器直连` / `内置快照`…）。只有你手点「立即同步」且两层都失败时才报错，并明确告诉你「继续用已有快照，提醒不受影响」。
- 🔁 取数节奏与容错：`calendar.sync` 开着时，运行时数据超过 30 天、或需要的年份（今年 / 明年）缺失才去取；缺年份那种情况（明年通知还没发布）最多**一天试一次**，避免每次开页面都打接口。今年+明年并行取；单次请求 6–8 秒硬超时（任何一层都别想卡住首屏）；**传输层失败**（连接超时 / 连接重置 / 5xx）会自动重试——Host 侧 3 次递增退避、浏览器侧立刻再来一次，而「这一年还没公布 / 404」这种结论不重试。这条链路实测确实会闪断（同一分钟内 undici 三连测 1 次超时 2 次成功），所以重试是必要的。
- 🧯 Host 侧也是软失败：接口 404 / 该年还没公布 → 只影响那一年（保留快照）；真网络故障 → 该路由返回 502 但照样带上已有日历；`web` 服务报错不会偷偷绕过它自己再 fetch 一次。
- 🧮 `?year=` 只接受**内置快照覆盖的年份再往后放宽一年**（快照每年刷新，窗口自动前移）：一个 loopback 页面没法拿任意年份反复逼 Host 去打供应商接口。
- 🧷 磁盘缓存写盘前会**重新读一次再合并**（只并入本次真取到的年份），所以两个请求交错（两个浏览器、或页面 GET 撞上设置页 POST）不会互相覆盖丢年份。
- 🌐 client 侧不再把「下一次点击」的状态留成死标记：拖拽结束后只吞 350ms 内的那次 click（触摸拖动超过 click slop 时浏览器根本不补 click）。

---

## 🛠️ 构建与测试

```bash
pnpm install        # devDeps：esbuild / typescript / @types/react / prettier / react / react-dom
pnpm build          # src/index.mjs -> lib/index.mjs，src/client/index.tsx -> lib/client.js
pnpm dev            # 同上，但 watch：存盘即重建（配合 client HMR，改 UI 不用手动跑构建）
pnpm typecheck      # tsc --noEmit（宽松基线，当前 0 error）
pnpm test           # build + host 真 HTTP/真磁盘 + client 真 React SSR/驱动式交互
pnpm test:dom       # 真 React 18 + 真 DOM（headless Chrome）驱动真产物 lib/client.js
pnpm fetch-holidays              # 抓今年 + 明年的节假日，重写 src/holidays.mjs
pnpm fetch-holidays 2027 2028    # 也可以指定年份
```

> `pnpm test:dom` 是**可选**的：它需要本机 Chrome（可用 `CHROME_PATH` 指定），找不到就打
> `SKIPPED` 并正常退出，所以没进 `pnpm test`。它专门盖住桩 React 结构上测不了的一层——
> `useSyncExternalStore` 的**订阅语义**（保存失败卡死、同步失败静默），以及真实 PointerEvent
> 下的拖拽吞点击窗口。

构建管线（`scripts/build.mjs`，esbuild JS API）：

| 产物 | 输入 / 处理 | 校验 |
|---|---|---|
| `lib/index.mjs` | `src/index.mjs`，`platform=node format=esm packages=external`，`./holidays.mjs` 内联 | 写完后**真 import 一次**，确认 `name === 'reminder-clock'`、`inject` 含 `webServer`、`apply` 是函数 |
| `lib/client.js` | `src/client/index.tsx`，`format=cjs jsx=automatic platform=browser`，`react` / `react/jsx-runtime` 保持 external，其余全部打进；再用 `window.__ModuleLoader__.load({ id, factory })` 包装 | 确认 handoff 存在、确认用了 JSX 自动 runtime、确认每个节假日年份都进了产物 |

> `lib/` 是生成物，别直接改；`lib/holidays.mjs` 这个中间产物已经取消（两个产物各自内联了快照）。但 `lib/` **故意入库**：DSH 启动要求插件已有现成的 `lib/client.js`（缺了会激活失败），而 git / link 安装不会自动构建，所以改完源码要 `pnpm build` 并把产物一起提交；`pnpm pack` 也会通过 `prepack` 重新构建，保证发 npm 的是最新的。

`test/host-smoke.mjs` 起真 HTTP server 打真路由（含节假日路由的 bundled / cache / network / 同步关闭 / 502 / 围栏 / 405，以及「优先走 Host 的 `web` 服务」和「服务报错不偷偷绕过」）；`test/client-smoke.mjs` Pass A 用真 React 服务端渲染两个槽位（连 `react/jsx-runtime` 都是真的），Pass B 用微型 stub React 直接点按钮，覆盖「到点 → 关闭 → 不重复弹 → 稍后 → 再弹 → 当天静音 → 设置保存 → 浮层同步」全链路，Pass C 覆盖悬停开合、Pass D 覆盖「悬停是固定行为、旧配置里的 `openOnHover` 已失效」、Pass E 覆盖旧 Host 不回退 `calendar` / `items[].days`，Pass F 覆盖工作日 / 周末 / 大小周交替 / 法定节假日 / 调休补班 / 手动覆盖 / 适用日过滤 / 设置页交互，Pass G 覆盖同步的三层降级（Host 404 → 直连 → 快照）与手动同步的成功/失败反馈，Pass H/I 覆盖节假日倒计时与拖拽定位，Pass J 覆盖「提醒文案收进行内二级配置」，Pass K 覆盖「已错过」文案与「保存失败后按钮回到可用」，Pass L 覆盖「两半共用同一套配置归一化」。`test/client-dom.mjs`（`pnpm test:dom`）用真 React 18 + 真 DOM 驱动真产物，断言保存/同步失败的可见性与拖拽点击窗口。

> 注意桩 React 的 `useSyncExternalStore` 不订阅 store（每次断言都重新渲染一棵新树），所以它验证不了**订阅语义**：设置页「保存中… / 保存失败 / 同步失败」这类异步状态的可见性由 `pnpm test:dom` 负责。改这块时别只看 `pnpm test` 绿。

## 🗓️ 每年做一次

- `pnpm fetch-holidays` —— 拉当年 + 明年的节假日，重写 `src/holidays.mjs`，然后 `pnpm build` 并提交产物。**不做这一步会有实际后果**：host 的 `?year=` 只接受内置快照覆盖的年份再放宽一年（窗口跟着快照走），快照一年不更新，新一年的同步请求会被忽略，测试里针对快照年份的断言也会红。
- 顺手看一眼 `engines.dsh` 是否还覆盖你实际在用的 DSH 版本（插件市场就是拿这个字段 + `peerDependencies` 里的 `@deepseek-ai/*` 判断兼容性的）。
- 每季度（或发现重试日志变多时）挑一台机器复跑一次 `pnpm test` 与 `pnpm test:dom` —— 供应商链路是外部依赖，最好主动体检。

## 🔁 本地改动怎么进 DSH

插件在本机 profile 里是**符号链接**装法（`~/.dsh/profiles/desktop/node_modules/dsh-reminder-clock` → 本仓库目录），所以这里的文件就是 DSH 读的文件，改完不需要重装。三条通路：

| 改什么 | 怎么让它生效 | 生效时机 |
|---|---|---|
| **UI / client 半**（`src/client/index.tsx`） | `pnpm build`（或让 `pnpm dev` 一直开着）→ 产出新的 `lib/client.js` | DSH 的 client-hmr 监听这个产物，实测**约 3 秒**浏览器就执行了新 bundle，**不用刷新页面** |
| **Host 半**（`src/index.mjs`） | `pnpm build` → 需要**重启 DSH** | Node 的 ESM 模块缓存；`plugin_manager` 禁用/启用插件**不会**重新加载模块（实测过）。重启前 client 侧照常工作：`days` / `calendar` / 开关值走 localStorage 镜像，节假日自动走「本页直连」 |
| **配置 / 数据** | 不用构建 | 设置页保存即写 `~/.dsh/reminder-clock.json`；节假日缓存在 `~/.dsh/reminder-clock-holidays.json` + 浏览器 localStorage |

其它注意点：

- **新增运行时依赖**：client 侧会被 esbuild 打进 bundle，什么都不用做；host 侧是 `packages: 'external'`，要装进 profile（`dsh plugin --profile desktop add link:<路径>` 或该 profile 的 `pnpm install`）。只动 `devDependencies`（构建/测试用）不影响线上。
- **构建失败不会破坏线上**：`lib/*` 只在构建成功后才写；`test` 里的两个 smoke 会拿真实产物跑，所以「改坏了」在本地就会红。
- **验证线上到底跑的是哪份**：设置页 → 作息提醒（能看见新加的控件就说明 client 已是新版）；`curl http://127.0.0.1:19387/api/reminder-clock/config`（返回体里有没有新字段 → host 半是否已重启）。
- **回滚**：`lib/` 全部可再生（`pnpm build`），源码在 git 里（仓库：<https://github.com/Jadramcool/dsh-reminder-clock>）。

## 📦 安装

前置：DSH **0.2.0-rc.1 以上**（本项目验证于 0.2.0-rc.2）、Node `^22.19` 或 `>=24`、pnpm 11（`packageManager` 已写进 `package.json`）。

```bash
# ① 本机正在开发：直接链到本仓库（改完不用重装）
dsh plugin --profile desktop add link:<本仓库路径>

# ② 从 npm 装（发布之后；也是插件市场的做法）
dsh plugin --profile desktop add dsh-reminder-clock

# ③ 让 Agent 装：plugin_manager → install_bundle，target 给 npm 包名或本地包目录
```

装完刷新 DSH 页面即可：右上/右下角出现倒计时胶囊，**设置 → 作息提醒** 出现配置页。

## 🗑️ 卸载

```bash
dsh plugin --profile desktop remove dsh-reminder-clock
rm ~/.dsh/reminder-clock.json
```

---

## ⚙️ 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关，关掉后不再弹卡片 |
| `items[].emoji` | `🍚` / `🌇` | 图标（最多 2 个字符） |
| `items[].label` | `午餐` / `下班` | 名称 |
| `items[].time` | `12:00` / `18:00` | 24 小时 `HH:MM` |
| `items[].message` | 见上 | 卡片正文，可留空 |
| `items[].enabled` | `true` | 单条开关 |
| `items[].days` | `workday` | 适用日：`every` 每天 / `workday` 仅工作日 / `restday` 仅休息日。默认两条都是 `workday`；旧配置里没写 `days` 的「午餐 / 下班」也按 `workday` 处理 |
| `options.showCountdown` | `true` | 是否常驻显示倒计时胶囊 |
| `options.snoozeMinutes` | `5` | 「稍后再提醒」的间隔 |
| `options.graceMinutes` | `3` | 错过后的补弹宽限窗口 |
| `options.position` | `bottom-right` | 浮层位置预设，只保留右侧两个：**右下**（默认，`bottom:10 / right:16`，用 `column-reverse` → **面板向上弹、胶囊原地不动**）、**右上**（`top:80 / right:16`，面板向下弹）。偏移量集中在客户端源码的 `POSITION_ANCHORS` 一处，CSS 与拖拽吸附共用它；左侧不设预设——左边是工作区侧栏 |
| `options.freePos` | `null` | 拖拽出来的位置：`{ anchor: 'left'\|'right', x, vAnchor: 'top'\|'bottom', y }`，x/y 是离对应两条边的像素距离；`null` = 用上面的预设。存锚边而不是绝对坐标，是为了窗口缩放后仍贴同一边 |
| `calendar.cycle` | `null` | 大小周：`null` 关闭；`{ anchor: '2026-01-12', anchorKind: 'big' \| 'small' }` 表示 anchor 那一周（按周一对齐）是大周还是小周，之后逐周交替 |
| `calendar.bigWorkdays` | `[1..6]` | 大周上班的星期（1=周一 … 7=周日） |
| `calendar.smallWorkdays` | `[1..5]` | 小周上班的星期 |
| `calendar.overrides` | `{}` | 手动覆盖：`{ '2026-10-10': 0, '2026-10-01': 1 }`，`1` = 放假，`0` = 补班 |
| `calendar.sync` | `true` | 是否自动联网同步法定节假日（关掉后自动同步的**两层**都停，只剩内置快照；「立即同步」按钮仍可手工触发） |

> 浮层位置可换：只有**右下（默认）**和右上两个预设 —— 右下用 `column-reverse`，所以面板是**向上**弹出的，胶囊自己不会往上跑；右上则向下弹。也可以直接拖动胶囊到任意位置（拖到预设附近会吸附回去）。
> 旧版本写下的配置没有 `calendar` / `days`：升级后 `下班` 会按「仅工作日」处理（`午餐` 保持每天），`calendar` 取默认值。

## 📄 License

[MIT](LICENSE) © 2026 jdm
