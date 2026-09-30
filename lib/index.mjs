// src/index.mjs
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// src/holidays.mjs
var BUNDLED_HOLIDAYS_PROVIDER = "https://timor.tech/api/holiday/year/";
var BUNDLED_HOLIDAYS = {
  2025: {
    "01-01": [1, "元旦"],
    "01-26": [0, "春节前补班"],
    "01-28": [1, "除夕"],
    "01-29": [1, "初一"],
    "01-30": [1, "初二"],
    "01-31": [1, "初三"],
    "02-01": [1, "初四"],
    "02-02": [1, "初五"],
    "02-03": [1, "初六"],
    "02-04": [1, "初七"],
    "02-08": [0, "春节后补班"],
    "04-04": [1, "清明节"],
    "04-05": [1, "清明节"],
    "04-06": [1, "清明节"],
    "04-27": [0, "劳动节前补班"],
    "05-01": [1, "劳动节"],
    "05-02": [1, "劳动节"],
    "05-03": [1, "劳动节"],
    "05-04": [1, "劳动节"],
    "05-05": [1, "劳动节"],
    "05-31": [1, "端午节"],
    "06-01": [1, "端午节"],
    "06-02": [1, "端午节"],
    "09-28": [0, "国庆节前补班"],
    "10-01": [1, "国庆节"],
    "10-02": [1, "国庆节"],
    "10-03": [1, "国庆节"],
    "10-04": [1, "国庆节"],
    "10-05": [1, "国庆节"],
    "10-06": [1, "中秋节"],
    "10-07": [1, "国庆节"],
    "10-08": [1, "国庆节"],
    "10-11": [0, "国庆节后补班"]
  },
  2026: {
    "01-01": [1, "元旦"],
    "01-02": [1, "元旦"],
    "01-03": [1, "元旦"],
    "01-04": [0, "元旦后补班"],
    "02-14": [0, "春节前补班"],
    "02-15": [1, "春节"],
    "02-16": [1, "除夕"],
    "02-17": [1, "初一"],
    "02-18": [1, "初二"],
    "02-19": [1, "初三"],
    "02-20": [1, "初四"],
    "02-21": [1, "初五"],
    "02-22": [1, "初六"],
    "02-23": [1, "初七"],
    "02-28": [0, "春节后补班"],
    "04-04": [1, "清明节"],
    "04-05": [1, "清明节"],
    "04-06": [1, "清明节"],
    "05-01": [1, "劳动节"],
    "05-02": [1, "劳动节"],
    "05-03": [1, "劳动节"],
    "05-04": [1, "劳动节"],
    "05-05": [1, "劳动节"],
    "05-09": [0, "劳动节后补班"],
    "06-19": [1, "端午节"],
    "06-20": [1, "端午节"],
    "06-21": [1, "端午节"],
    "09-20": [0, "中秋节前补班"],
    "09-25": [1, "中秋节"],
    "09-26": [1, "中秋节"],
    "09-27": [1, "中秋节"],
    "10-01": [1, "国庆节"],
    "10-02": [1, "国庆节"],
    "10-03": [1, "国庆节"],
    "10-04": [1, "国庆节"],
    "10-05": [1, "国庆节"],
    "10-06": [1, "国庆节"],
    "10-07": [1, "国庆节"],
    "10-10": [0, "国庆节后补班"]
  }
};

// src/shared/config.mjs
var MAX_ITEMS = 24;
var MAX_CALENDAR_OVERRIDES = 400;
var TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
var DAY_POLICY_IDS = ["every", "workday", "restday"];
var LEGACY_DAY_POLICIES = { lunch: "workday", offwork: "workday" };
var DEFAULT_BIG_WORKDAYS = [1, 2, 3, 4, 5, 6];
var DEFAULT_SMALL_WORKDAYS = [1, 2, 3, 4, 5];
var POSITION_IDS = ["bottom-right", "top-right"];
var FREE_ANCHORS = ["left", "right"];
var FREE_VANCHORS = ["top", "bottom"];
var FREE_POS_MAX = 2e4;
function safeString(value, fallback, max) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, max);
}
function safeEmoji(value, fallback) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length === 0) return fallback;
  return Array.from(raw).slice(0, 2).join("");
}
function clampInt(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function normalizeDate(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return void 0;
  const ms = Date.parse(trimmed + "T00:00:00Z");
  if (!Number.isFinite(ms)) return void 0;
  return new Date(ms).toISOString().slice(0, 10) === trimmed ? trimmed : void 0;
}
function normalizeWorkdays(value, fallback) {
  if (!Array.isArray(value)) return fallback.slice();
  const seen = /* @__PURE__ */ new Set();
  for (const entry of value) {
    const day = typeof entry === "number" ? entry : Number(entry);
    if (!Number.isInteger(day) || day < 1 || day > 7) continue;
    seen.add(day);
  }
  if (seen.size === 0) return fallback.slice();
  return Array.from(seen).sort((a, b) => a - b);
}
function normalizeItem(raw, index) {
  const src = typeof raw === "object" && raw !== null ? raw : {};
  const id = safeString(src.id, "item-" + (index + 1), 48).replace(/[^A-Za-z0-9_-]/g, "-");
  const time = typeof src.time === "string" && TIME_RE.test(src.time.trim()) ? src.time.trim() : "12:00";
  return {
    id,
    label: safeString(src.label, "提醒", 24),
    emoji: safeEmoji(src.emoji, "⏰"),
    time,
    enabled: src.enabled !== false,
    days: DAY_POLICY_IDS.includes(src.days) ? src.days : LEGACY_DAY_POLICIES[id] || "every",
    message: typeof src.message === "string" ? src.message.trim().slice(0, 120) : ""
  };
}
function normalizeFreePos(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const anchor = FREE_ANCHORS.includes(raw.anchor) ? raw.anchor : null;
  const vAnchor = FREE_VANCHORS.includes(raw.vAnchor) ? raw.vAnchor : null;
  if (anchor === null || vAnchor === null) return null;
  return {
    anchor,
    x: clampInt(raw.x, 0, FREE_POS_MAX, 16),
    vAnchor,
    y: clampInt(raw.y, 0, FREE_POS_MAX, 52)
  };
}
function normalizeCalendar(raw) {
  const src = typeof raw === "object" && raw !== null ? raw : {};
  const rawCycle = typeof src.cycle === "object" && src.cycle !== null ? src.cycle : null;
  const anchor = rawCycle === null ? void 0 : normalizeDate(rawCycle.anchor);
  const overrides = {};
  const rawOverrides = typeof src.overrides === "object" && src.overrides !== null ? src.overrides : {};
  for (const [key, value] of Object.entries(rawOverrides).slice(0, MAX_CALENDAR_OVERRIDES)) {
    const date = normalizeDate(key);
    if (date === void 0) continue;
    if (value === 1 || value === true) overrides[date] = 1;
    else if (value === 0 || value === false) overrides[date] = 0;
  }
  return {
    cycle: anchor === void 0 ? null : { anchor, anchorKind: rawCycle.anchorKind === "small" ? "small" : "big" },
    bigWorkdays: normalizeWorkdays(src.bigWorkdays, DEFAULT_BIG_WORKDAYS),
    smallWorkdays: normalizeWorkdays(src.smallWorkdays, DEFAULT_SMALL_WORKDAYS),
    overrides,
    sync: src.sync !== false
  };
}
function defaultConfig() {
  return {
    version: 1,
    enabled: true,
    items: [
      {
        id: "lunch",
        label: "午餐",
        emoji: "🍚",
        time: "12:00",
        enabled: true,
        days: "workday",
        message: "干饭干饭！干饭不积极，思想有问题！"
      },
      {
        id: "offwork",
        label: "下班",
        emoji: "🌇",
        time: "18:00",
        enabled: true,
        days: "workday",
        message: "牛马收工~"
      }
    ],
    options: { showCountdown: true, snoozeMinutes: 5, graceMinutes: 3, position: "bottom-right", freePos: null },
    calendar: {
      cycle: null,
      bigWorkdays: DEFAULT_BIG_WORKDAYS.slice(),
      smallWorkdays: DEFAULT_SMALL_WORKDAYS.slice(),
      overrides: {},
      sync: true
    }
  };
}
function normalizeConfig(raw) {
  const src = typeof raw === "object" && raw !== null ? raw : {};
  const rawItems = Array.isArray(src.items) ? src.items.slice(0, MAX_ITEMS) : null;
  let items = rawItems === null ? defaultConfig().items.map(normalizeItem) : rawItems.map(normalizeItem);
  const seen = /* @__PURE__ */ new Set();
  items = items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const rawOptions = typeof src.options === "object" && src.options !== null ? src.options : {};
  return {
    version: 1,
    enabled: src.enabled !== false,
    items,
    options: {
      showCountdown: rawOptions.showCountdown !== false,
      snoozeMinutes: clampInt(rawOptions.snoozeMinutes, 1, 120, 5),
      graceMinutes: clampInt(rawOptions.graceMinutes, 0, 60, 3),
      position: POSITION_IDS.includes(rawOptions.position) ? rawOptions.position : "bottom-right",
      freePos: normalizeFreePos(rawOptions.freePos)
    },
    calendar: normalizeCalendar(src.calendar)
  };
}

// src/index.mjs
var name = "reminder-clock";
var inject = ["webServer"];
var MAX_JSON_BODY_BYTES = 256 * 1024;
var HOLIDAY_CACHE_VERSION = 1;
var HOLIDAY_SYNC_TIMEOUT_MS = 6e3;
var HOLIDAY_SYNC_ATTEMPTS = 3;
var HOLIDAY_SYNC_BACKOFF_MS = [0, 400, 1200];
var HOLIDAY_MAX_DAYS = 400;
var HOLIDAY_MAX_YEARS = 6;
var SNAPSHOT_YEARS = Object.keys(BUNDLED_HOLIDAYS).map((year) => Number(year)).filter((year) => Number.isInteger(year)).sort((a, b) => a - b);
var HOLIDAY_MIN_YEAR = SNAPSHOT_YEARS.length > 0 ? SNAPSHOT_YEARS[0] : 1970;
var HOLIDAY_MAX_YEAR = (SNAPSHOT_YEARS.length > 0 ? SNAPSHOT_YEARS[SNAPSHOT_YEARS.length - 1] : 9999) + 1;
var HOLIDAY_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv;
  return join(homedir(), ".dsh");
}
function configPath() {
  return join(dshHome(), "reminder-clock.json");
}
function isIPv4Loopback(v4) {
  const parts = v4.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function isLoopbackAddress(address) {
  if (address === void 0) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice("::ffff:".length));
  return isIPv4Loopback(normalized);
}
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return isIPv4Loopback(hostname);
}
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket && request.socket.remoteAddress)) return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}
function writeJson(res, status, body) {
  if (res.writableEnded === true || res.destroyed === true) return;
  const payload = JSON.stringify(body);
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer"
    });
    res.end(payload);
  } catch {
  }
}
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) return void 0;
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function readConfig() {
  try {
    const text = readFileSync(configPath(), "utf8");
    return normalizeConfig(JSON.parse(text));
  } catch (err) {
    if (err && err.code !== "ENOENT") console.error("reminder-clock: config read failed", err);
    return void 0;
  }
}
function writeConfig(config) {
  const target = configPath();
  const tmp = join(dirname(target), "reminder-clock.json.tmp-" + process.pid);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, target);
}
function holidayCachePath() {
  return join(dshHome(), "reminder-clock-holidays.json");
}
function normalizeHolidayDays(raw) {
  const out = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw).slice(0, HOLIDAY_MAX_DAYS)) {
    if (!/^\d{2}-\d{2}$/.test(key)) continue;
    let rest = null;
    let name2 = "";
    if (Array.isArray(value)) {
      if (value[0] === 1 || value[0] === true) rest = 1;
      else if (value[0] === 0 || value[0] === false) rest = 0;
      if (typeof value[1] === "string") name2 = value[1];
    } else if (typeof value === "object" && value !== null) {
      if (typeof value.rest === "number") rest = value.rest === 1 ? 1 : 0;
      else if (typeof value.holiday === "boolean") rest = value.holiday ? 1 : 0;
      if (typeof value.name === "string") name2 = value.name;
    }
    if (rest === null) continue;
    out[key] = [rest, name2.trim().slice(0, 24)];
  }
  return out;
}
function readHolidayCache() {
  const empty = { years: {}, fetchedAt: null, provider: BUNDLED_HOLIDAYS_PROVIDER };
  try {
    const parsed = JSON.parse(readFileSync(holidayCachePath(), "utf8"));
    const rawYears = typeof parsed === "object" && parsed !== null && typeof parsed.years === "object" && parsed.years !== null ? parsed.years : {};
    const years = {};
    for (const [year, days] of Object.entries(rawYears)) {
      if (!/^\d{4}$/.test(year)) continue;
      const normalized = normalizeHolidayDays(days);
      if (Object.keys(normalized).length > 0) years[year] = normalized;
    }
    return {
      years,
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null,
      provider: typeof parsed.provider === "string" ? parsed.provider : BUNDLED_HOLIDAYS_PROVIDER
    };
  } catch (err) {
    if (err && err.code !== "ENOENT") console.error("reminder-clock: holiday cache read failed", err);
    return empty;
  }
}
function writeHolidayCache(cache) {
  const target = holidayCachePath();
  const tmp = join(dirname(target), "reminder-clock-holidays.json.tmp-" + process.pid);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    tmp,
    JSON.stringify(
      {
        version: HOLIDAY_CACHE_VERSION,
        provider: cache.provider,
        fetchedAt: cache.fetchedAt,
        years: cache.years
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  renameSync(tmp, target);
}
function compactProviderPayload(payload) {
  const map = payload !== null && typeof payload === "object" ? payload.holiday : null;
  const out = {};
  if (typeof map !== "object" || map === null) return out;
  for (const [key, entry] of Object.entries(map)) {
    if (typeof entry !== "object" || entry === null) continue;
    const mmdd = typeof entry.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date.slice(5) : key;
    if (!/^\d{2}-\d{2}$/.test(mmdd)) continue;
    out[mmdd] = [
      entry.holiday === true ? 1 : 0,
      String(entry.name || "").trim().slice(0, 24)
    ];
  }
  return out;
}
function createTextFetcher(ctx) {
  return async (url, signal) => {
    const web = typeof ctx.get === "function" ? ctx.get("web") : void 0;
    if (web !== void 0 && web !== null && typeof web.fetch === "function") {
      try {
        const result = await web.fetch({ url }, signal);
        const body = result !== null && typeof result === "object" ? result.body : null;
        const text = body !== null && typeof body === "object" && typeof body.content === "string" ? body.content : "";
        const status = result !== null && typeof result === "object" && typeof result.statusCode === "number" ? result.statusCode : 0;
        return { status, text, via: "web" };
      } catch (err) {
        throw new Error("web-service: " + String(err && err.message || err));
      }
    }
    if (typeof fetch !== "function") throw new Error("fetch-unavailable");
    const res = await fetch(url, { headers: { accept: "application/json" }, signal });
    return { status: res.status, text: await res.text(), via: "fetch" };
  };
}
async function fetchHolidayYear(year, fetcher, signal) {
  const result = await fetcher(BUNDLED_HOLIDAYS_PROVIDER + year, signal);
  if (result.status < 200 || result.status >= 300) throw new Error("HTTP " + result.status);
  let payload = null;
  try {
    payload = JSON.parse(result.text);
  } catch {
    throw new Error("bad-payload");
  }
  const days = compactProviderPayload(payload);
  if (Object.keys(days).length === 0) throw new Error("empty-payload");
  return days;
}
async function fetchHolidayYearTimed(year, fetcher) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller === null ? null : setTimeout(() => controller.abort(), HOLIDAY_SYNC_TIMEOUT_MS);
  try {
    return await fetchHolidayYear(year, fetcher, controller === null ? void 0 : controller.signal);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
var HOLIDAY_BENIGN_ERRORS = ["empty-payload", "HTTP 404"];
function isBenignHolidayError(message) {
  return HOLIDAY_BENIGN_ERRORS.some((needle) => message.includes(needle));
}
function isRetryableHolidayError(message) {
  if (isBenignHolidayError(message)) return false;
  if (message.includes("HTTP 4")) return false;
  return true;
}
function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
async function fetchHolidayYearWithRetry(year, fetcher) {
  let lastError = null;
  for (let attempt = 0; attempt < HOLIDAY_SYNC_ATTEMPTS; attempt += 1) {
    await sleep(HOLIDAY_SYNC_BACKOFF_MS[attempt] || 0);
    try {
      return await fetchHolidayYearTimed(year, fetcher);
    } catch (err) {
      lastError = err;
      const message = String(err && err.message || err);
      if (!isRetryableHolidayError(message)) throw err;
    }
  }
  throw lastError === null ? new Error("sync-failed") : lastError;
}
function parseYears(searchParams, now) {
  const raw = searchParams.get("year");
  const list = typeof raw === "string" ? raw.split(",") : [];
  const years = [];
  for (const entry of list) {
    const year = clampInt(entry, 0, 9999, 0);
    if (year < HOLIDAY_MIN_YEAR || year > HOLIDAY_MAX_YEAR) continue;
    if (!years.includes(year)) years.push(year);
    if (years.length >= HOLIDAY_MAX_YEARS) break;
  }
  if (years.length === 0) {
    years.push(now.getFullYear(), now.getFullYear() + 1);
  }
  return years;
}
async function handleConfigRoute(req, res) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: "loopback-only" });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const stored = readConfig();
    writeJson(res, 200, {
      ok: true,
      config: stored === void 0 ? defaultConfig() : stored,
      source: stored === void 0 ? "default" : "disk"
    });
    return;
  }
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  const body = await readJsonBody(req);
  if (body === void 0) {
    writeJson(res, 400, { ok: false, error: "invalid-json-body" });
    return;
  }
  const config = normalizeConfig(body.config);
  try {
    writeConfig(config);
  } catch (err) {
    console.error("reminder-clock: config write failed", err);
    writeJson(res, 500, { ok: false, error: "write-failed", config });
    return;
  }
  writeJson(res, 200, { ok: true, config, source: "disk" });
}
async function handleHolidaysRoute(req, res, fetcher) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: "loopback-only" });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  const now = /* @__PURE__ */ new Date();
  const years = parseYears(new URL(req.url || "/", "http://localhost").searchParams, now);
  const refresh = req.method === "POST";
  const config = readConfig() || defaultConfig();
  const cache = readHolidayCache();
  const fetchedMs = cache.fetchedAt === null ? NaN : Date.parse(cache.fetchedAt);
  const cacheStale = !Number.isFinite(fetchedMs) || now.getTime() - fetchedMs > HOLIDAY_CACHE_MAX_AGE_MS;
  const result = {};
  let syncError = null;
  const synced = await Promise.all(
    years.map(async (year) => {
      const bundled = BUNDLED_HOLIDAYS[year] || {};
      const cached = cache.years[year];
      const fallback = cached !== void 0 ? cached : bundled;
      const needsSync = refresh || config.calendar.sync && (cached === void 0 || cacheStale || Object.keys(fallback).length === 0);
      if (!needsSync) {
        return {
          year,
          days: fallback,
          source: cached !== void 0 ? "cache" : Object.keys(bundled).length > 0 ? "bundled" : "none",
          fetched: null
        };
      }
      try {
        return { year, days: await fetchHolidayYearWithRetry(year, fetcher), source: "network", fetched: true };
      } catch (err) {
        const message = String(err && err.message || err);
        if (isBenignHolidayError(message)) {
          return { year, days: fallback, source: Object.keys(bundled).length > 0 ? "bundled" : "none", fetched: null };
        }
        return { year, days: fallback, source: "error", fetched: null, error: message };
      }
    })
  );
  const fetched = {};
  for (const entry of synced) {
    if (entry.fetched === true) {
      fetched[entry.year] = entry.days;
    } else if (entry.error !== void 0 && syncError === null) {
      syncError = entry.error;
    }
    result[entry.year] = {
      days: entry.days,
      source: entry.source === "error" ? Object.keys(BUNDLED_HOLIDAYS[entry.year] || {}).length > 0 ? "bundled" : "none" : entry.source
    };
  }
  if (Object.keys(fetched).length > 0) {
    const merged = readHolidayCache();
    merged.years = Object.assign({}, merged.years, fetched);
    merged.fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
    merged.provider = BUNDLED_HOLIDAYS_PROVIDER;
    try {
      writeHolidayCache(merged);
      cache.years = merged.years;
      cache.fetchedAt = merged.fetchedAt;
      cache.provider = merged.provider;
    } catch (err) {
      console.error("reminder-clock: holiday cache write failed", err);
    }
  }
  const payload = {
    ok: !(refresh && syncError !== null),
    years: result,
    fetchedAt: cache.fetchedAt,
    provider: BUNDLED_HOLIDAYS_PROVIDER,
    syncEnabled: config.calendar.sync,
    syncError
  };
  if (refresh && syncError !== null) payload.error = "sync-failed";
  writeJson(res, refresh && syncError !== null ? 502 : 200, payload);
}
function apply(ctx) {
  const webServer = ctx.webServer;
  const fetcher = createTextFetcher(ctx);
  const routes = [
    { kind: "exact", path: "/api/reminder-clock/config", handler: handleConfigRoute },
    {
      kind: "exact",
      path: "/api/reminder-clock/holidays",
      handler: (req, res) => handleHolidaysRoute(req, res, fetcher)
    }
  ];
  const disposers = routes.map((route) => webServer.register(route));
  ctx.effect(
    () => () => {
      for (const dispose of disposers) dispose();
    },
    "reminder-clock: routes"
  );
}
export {
  apply,
  inject,
  name
};
