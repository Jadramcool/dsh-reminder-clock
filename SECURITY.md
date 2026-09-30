# 安全策略

## 这个插件会做什么

- 在 DSH 的 Web 服务上注册**两个 loopback-only** 的 JSON 路由：
  - `GET/POST /api/reminder-clock/config` —— 读写作息配置
  - `GET/POST /api/reminder-clock/holidays` —— 读写节假日缓存
  两个路由都套同源信任围栏：远端地址必须是 loopback、`Host` 头必须指向 loopback 授权、`Sec-Fetch-Site: cross-site` 直接拒绝、有 `Origin` 时必须与 `Host` 一致；不满足一律 403。
- 读写 `$DSH_HOME`（默认 `~/.dsh`）下的两个文件：`reminder-clock.json`、`reminder-clock-holidays.json`。写盘是原子写（tmp + rename）。
- 在浏览器里使用 `localStorage` 存配置镜像、当天已提醒记录、静音日期与节假日镜像。
- 唯一的出站请求：`https://timor.tech/api/holiday/year/<年份>`（可关：设置里的「自动同步国家法定节假日」；关掉后自动同步的两层都停，只剩内置快照，手点「立即同步」仍可触发）。Host 侧优先走 DSH 自己的 `web` 服务，因此会尊重你配置的代理 / 白名单。

**不收集遥测，不上传任何使用数据，不读取凭据、会话内容或工作区文件。** 插件只持有"几点提醒你"这份作息配置。

## 报告漏洞

请**不要**开公开 issue。优先用 GitHub 的私密报告通道：
**Security → Report a vulnerability**（<https://github.com/Jadramcool/dsh-reminder-clock/security/advisories/new>）。

如果那条通道不可用，也可以发邮件到 <1051780106@qq.com>，标题带 `[SECURITY]`。

请附上：影响的版本（`package.json` 的 `version`）、复现步骤或 PoC、你判断的影响范围。我会在确认后尽快修，并在 `CHANGELOG.md` 里说明（需要的话给 CVE 申请留出时间）。

## 范围说明

- **在范围内**：绕过 loopback 围栏访问这两个路由；越权读写 `~/.dsh/reminder-clock*.json`；通过 `?year=` 或配置字段造成的资源耗尽 / 越界写入；注入类问题（XSS、原型污染）经插件 UI 或路由抵达页面。
- **不在范围内**：第三方接口 `timor.tech` 自身的可用性 / 数据正确性（数据仅供提醒参考，请以官方发布为准）；需要本机管理员权限或需要预先入侵 DSH 进程的攻击场景；DSH 自身或 React 的漏洞（请报给对应项目）。
