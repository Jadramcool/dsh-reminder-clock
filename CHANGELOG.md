# Changelog

本文件记录用户可感知的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-09-30

首个公开发布。相对"能跑起来"的第一版，发布前修掉的口径问题也列在下面，方便使用者判断行为。

### Added

- **浮层提醒**：`shell.overlay` 里的常驻倒计时胶囊、到点提醒卡片（知道了 / N 分钟后再说 / 今天不再提醒）、悬停或点击展开的今日安排面板（含最近一个节假日倒计时）。
- **设置页**（`settings.section`）：增删任意提醒项，配置图标、名称、时间、**适用日**、启用开关；提醒文案做成行内二级配置（每行 `▸` 展开），窄面板下主表格不会被挤扁。
- **工作日判定**：可按「每天 / 仅工作日 / 仅休息日」过滤；工作日支持**大小周**（大周/小周各自勾选上班的星期，选「本周是大周还是小周」后自动交替）与**国家法定节假日**（含调休补班），并可逐日手动指定「放假 / 补班」，优先级最高。
- **浮层位置**：右下（默认，面板向上弹出、胶囊原地不动）与右上两个预设；也可以直接拖动胶囊到任意位置（按锚边 + 像素偏移保存，窗口缩放后仍贴同一边；拖到预设附近自动吸附，设置页可一键回到预设）。
- **Host 侧持久化**：`GET/POST /api/reminder-clock/config`，原子写（tmp + rename）`~/.dsh/reminder-clock.json`，换浏览器 / 清缓存都不丢；两个路由都带 loopback 同源围栏（socket + Host 头 + `Sec-Fetch-Site` + Origin 不一致即 403）。
- **节假日三层同步**：Host 路由（优先走 Host 自己的 `web` 服务，落盘缓存、多浏览器共用）→ 浏览器直连供应商 → 内置快照 + localStorage 镜像；自动同步静默降级，只有手点「立即同步」且两层都失败才报错。
- **构建与测试**：esbuild 管线把 host/client 两个产物从同一份源码产出，`src/shared/config.mjs` 被内联进两个产物；`pnpm test`（host 真 HTTP + client 真 React SSR/桩驱动，289 项）与可选的 `pnpm test:dom`（真 React 18 + headless Chrome 驱动真产物，13 项）。

### Fixed

- **设置页异步状态不落地**：只订阅 `configRev` 导致保存失败后按钮永久卡在「保存中…」、同步失败完全无提示；改为订阅组合切片，并给「保存中」加了 12 秒兜底超时。
- **「已提醒」谎报**：过了宽限窗口、今天根本没弹过的提醒，面板里改标「已错过」；只有真弹过的才显示「已提醒」。
- **拖拽吞掉下一次点击**：改为只吞拖拽结束后 350ms 内那一次 click（触摸拖动超过浏览器 click slop 时不会补 click，标记不再留死）。
- **节假日缓存丢更新**：写盘前重新读磁盘再合并，两个请求交错不会再互相覆盖年份。
- **`?year=` 范围**：只接受内置快照覆盖的年份再放宽一年，避免被拿来对第三方接口做无限放大。
- **两半配置契约漂移**：常量、归一化、出厂默认值收进 `src/shared/config.mjs` 一份（例如带空格的时间 `" 09:00 "` 在两边都归一成 `09:00`）。
- 面板改为带标签的 `role="region"`（非模态浮层没有焦点管理，原来用 `role="dialog"` 语义不准）。

[Unreleased]: https://github.com/Jadramcool/dsh-reminder-clock/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Jadramcool/dsh-reminder-clock/releases/tag/v0.1.0
