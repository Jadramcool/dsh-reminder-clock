# 贡献指南

欢迎 issue 与 PR。这个插件很小，改动请尽量克制、可验证。

## 环境

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node | `^22.19.0` 或 `>=24` | 见 `package.json` 的 `engines.node` |
| pnpm | 11.x | 见 `packageManager`；`pnpm-workspace.yaml` 的 `allowBuilds` 是 pnpm 11 放行 esbuild 构建脚本用的 |
| DSH | `>=0.2.0-rc.1` | 手动验证 UI 时才需要（开发于 0.2.0-rc.2） |
| Chrome / Edge | 任意近期版本 | 只有 `pnpm test:dom` 需要；可用 `CHROME_PATH` 指定 |

## 常用命令

```bash
pnpm install
pnpm build          # src/* -> lib/*（host + client 两个产物）
pnpm dev            # 同上，watch：存盘即重建
pnpm typecheck      # tsc --noEmit
pnpm format:check   # prettier 校验（README / CHANGELOG 的表格是手排的，不在校验范围内）
pnpm test           # 构建 + host smoke（真 HTTP/真磁盘）+ client smoke（真 React SSR/桩驱动）
pnpm test:dom       # 可选：真 React 18 + headless Chrome 驱动真产物；没装浏览器会 SKIP
pnpm fetch-holidays # 重抓当年 + 明年节假日，重写 src/holidays.mjs
```

CI（`.github/workflows/ci.yml`）跑的就是 `pnpm typecheck` + `pnpm format:check` + `pnpm test`（Node 22 与 24 各一遍），`pnpm test:dom` 单独一个 job。

## 提交 PR 前

- [ ] `pnpm test` 全绿；动了 UI 的交互或异步状态，再跑一次 `pnpm test:dom`。
- [ ] `pnpm format:check` 通过（没装 prettier 插件就 `npx prettier --write` 你改过的文件）。
- [ ] **重新构建并提交 `lib/`**：`lib/` 是生成物但**故意入库**（DSH 启动要求插件已有现成的 `lib/client.js`，git / link 安装不会自动构建）。CI 之后会校验它，所以 `pnpm build` 后请把 `lib/` 一起提交。
- [ ] 改了行为就更新 `README.md`（功能表 / 配置项）与 `CHANGELOG.md` 的 `Unreleased`。
- [ ] 新增界面文案保持中文；改动用户可感知的行为请在 PR 描述里写清"之前 / 现在"。

## 改代码时的几条约定

- **配置契约只有一份**：常量、归一化、出厂默认值都在 `src/shared/config.mjs`，host 与 client 各自 import，esbuild 会把它内联进两个产物。**不要**在任一边复制一份——这个仓库以前就是因为两边各写一份而漂移过（例如时间 trim）。
- **host 半是 `packages: 'external'` 的 ESM**：只用 `node:` 内置模块，不要引入第三方运行时依赖；写盘一律走 `writeConfig` / `writeHolidayCache` 的原子写。
- **client 半的外部依赖只有 `react` / `react/jsx-runtime`**（DSH loader 的 platform seed 模块），其余必须在构建时打进 bundle；不要 `require('@deepseek-ai/dsh-client-*')`。
- **资源归属**：样式、定时器、监听器都在 `apply()` 里用 `ctx.effect(...)` 注册并返回清理函数，服务用已声明的 `inject` + `ctx.slots` / `ctx.webServer` 访问（不要用 `ctx.get()` 绕开注入）。
- **z-index / 主题**：只用 `--dsw-alias-*` 主题 token，别写死颜色（图标、插画除外），类名统一 `drc-` 前缀。
- **数据来源**：节假日快照是 `scripts/fetch-holidays.mjs` 从公开接口抓的派生数据，改动抓取/归一化逻辑时请一并更新文件头的来源说明。

## 每年做一次（维护者）

- `pnpm fetch-holidays` → `pnpm build` → 提交产物。快照不更新，host 的年份窗口会与新一年脱节（同步请求会被忽略，测试里的年份断言也会红），详见 README 的「每年做一次」。
- 复核 `engines.dsh` 是否覆盖你实际在用的 DSH 版本（插件市场就是拿这个字段判断兼容性的）。

## 许可

提交即表示你同意以 [MIT](LICENSE) 授权你的贡献。
