/* Dashboard-owned candidate contract/runtime. No account, broker or write access. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MarketContent = factory();
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  var domains = ["snapshot", "news", "calendar"];
  function fail(path) { throw new Error("market_content_invalid:" + path); }
  function number(value) {
    if (!["number", "string"].includes(typeof value) || (typeof value === "string" && !value.trim())) return null;
    var parsed = Number(value); return Number.isFinite(parsed) ? parsed : null;
  }
  function validDate(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
  function validUtc(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && validDate(value.slice(0, 10)); }
  function https(value) { try { var u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !/^(?:localhost|127\.|\[::1\])/.test(u.hostname) && !/(?:token|secret|signature|api_key)=/i.test(u.search); } catch (_) { return false; } }
  function shape(value, rule, contract, path) {
    path = path || "$";
    if (rule.$ref) return shape(value, contract.definitions[rule.$ref], contract, path);
    if (rule.anyOf) { if (value === null) return; return shape(value, rule.anyOf[1], contract, path); }
    if (rule.enum) { if (!rule.enum.some(function (v) { return v === value; })) fail(path); return; }
    var type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if ((rule.type === "integer" ? type !== "number" || !Number.isSafeInteger(value) : type !== rule.type)) fail(path);
    if (type === "object") {
      Object.keys(value).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(rule.properties, k)) fail(path + "." + k); shape(value[k], rule.properties[k], contract, path + "." + k); });
      rule.required.forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(value, k)) fail(path + "." + k); });
    } else if (type === "array") {
      if (value.length < (rule.minItems || 0) || value.length > rule.maxItems) fail(path);
      value.forEach(function (v, i) { shape(v, rule.prefixItems ? rule.prefixItems[i] : rule.items, contract, path + "[" + i + "]"); });
    } else if (type === "number") {
      if (!Number.isFinite(value) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)) fail(path);
    } else if (type === "string") {
      if (value.length > (rule.maxLength || 10000) || (rule.pattern && !new RegExp(rule.pattern).test(value))) fail(path);
      if (rule.format === "date" && !validDate(value) || rule.format === "utc" && !validUtc(value) || rule.format === "https" && !https(value)) fail(path);
      if (/data\/private|\/Users\/|account(?:Id|Number|Alias)|orderId|tradeId|contractId|connectorEnvelope|bearer\s+|(?:access|refresh)[_-]?token|<\/?(?:script|iframe|img)\b|\b[UD]\d{5,}\b/i.test(value)) fail(path);
    }
  }
  function fixtureUrl(value) { return https(value) && new URL(value).hostname.endsWith(".invalid"); }
  function validateManifest(manifest, contract, now) {
    var production = contract && contract.contractId === "market-content-public-v1" && contract.status === "public_existing_sources_only";
    if (!production && (!contract || contract.contractId !== "market-content-candidate-v1" || contract.status !== "synthetic_candidate_not_publication_authority")) fail("contract");
    if (!manifest || manifest.synthetic !== !production || domains.some(function (d) { return contract.paths[d] !== "data/market/" + d + ".json"; })) fail("candidate_scope");
    shape(manifest, contract.definitions.manifest, contract, "manifest");
    if (Date.parse(manifest.generatedAt) > (now === undefined ? Date.now() : +new Date(now))) fail("manifest.future_generation");
    if (manifest.contentVersion === 1 ? manifest.previousVersion !== null || manifest.previousManifestSha256 !== null : manifest.previousVersion !== manifest.contentVersion - 1 || !manifest.previousManifestSha256) fail("manifest.predecessor");
    var ids = new Set();
    manifest.sources.forEach(function (s) { if (production ? s.id !== "fred-dgs10" || s.name !== "FRED DGS10" || s.url !== "https://fred.stlouisfed.org/series/DGS10" || s.role !== "official_primary" || s.redistribution !== "public" || ids.has(s.id) : !/^synthetic-[a-z0-9-]+$/.test(s.id) || ids.has(s.id) || !fixtureUrl(s.url)) fail("manifest.sources"); ids.add(s.id); });
    return manifest;
  }
  function validateDomain(domain, payload, manifest, contract) {
    shape(payload, contract.definitions[domain], contract, domain);
    if (manifest.synthetic === false) {
      if (domain === "snapshot") Object.keys(payload.data.series).forEach(function (key) { if (key !== "tenYear" && payload.data.series[key].points.length || key === "tenYear" && payload.data.series[key].points.some(function (p) { return p[2] !== "fred-dgs10"; })) fail("public.source_scope"); });
      else if (payload.status !== "unavailable" || payload.data.items.length || payload.verifiedAt !== null || payload.observedThrough !== null) fail("public.unadmitted_domain");
    }
    var meta = manifest.packages[domain];
    ["revision", "observedThrough", "verifiedAt", "status"].forEach(function (key) { if (payload[key] !== meta[key]) fail(domain + ".metadata"); });
    var generated = Date.parse(manifest.generatedAt), verified = payload.verifiedAt && Date.parse(payload.verifiedAt);
    if (verified && verified > generated || payload.observedThrough && (!verified || payload.observedThrough > payload.verifiedAt.slice(0, 10))) fail(domain + ".cutoff");
    if ((payload.status === "pass" || payload.status === "warning" || payload.status === "empty") && !verified) fail(domain + ".verification");
    if (payload.status === "pass" && !payload.observedThrough) fail(domain + ".cutoff_missing");
    var sources = new Map(manifest.sources.map(function (s) { return [s.id, s]; }));
    if (domain === "snapshot") {
      var total = 0;
      Object.keys(payload.data.series).forEach(function (key) {
        var series = payload.data.series[key], prior = "";
        if (series.unit !== (key === "twoYear" || key === "tenYear" || key === "thirtyYear" ? "percent" : key === "cnnFearGreed" ? "points" : "index")) fail("snapshot.unit");
        series.points.forEach(function (p) {
          var source = sources.get(p[key === "cnnFearGreed" ? 4 : 2]);
          if (!source || p[0] <= prior || !payload.observedThrough || p[0] > payload.observedThrough || p[1] <= 0 && key !== "cnnFearGreed") fail("snapshot.observation");
          if (key === "cnnFearGreed" && (p[3] !== source.role || (p[3] === "legacy" ? p[0] >= contract.cnnBoundaryDate : p[0] < contract.cnnBoundaryDate))) fail("snapshot.cnn_source_boundary");
          prior = p[0]; total++;
        });
      });
      if ((payload.status === "empty" || payload.status === "unavailable") && total) fail("snapshot.empty");
      if (payload.status === "pass" && Object.values(payload.data.series).some(function (s) { return !s.points.length; })) fail("snapshot.incomplete");
    } else {
      var ids = new Set(), items = payload.data.items;
      if ((payload.status === "empty" || payload.status === "unavailable") && items.length || payload.status === "pass" && !items.length) fail(domain + ".empty");
      items.forEach(function (item) {
        if (ids.has(item.eventId)) fail(domain + ".duplicate"); ids.add(item.eventId);
        if (domain === "news") {
          if (item.accessStatus === "metadata_only") fail("news.full_review_required");
          if (!fixtureUrl(item.canonicalUrl) || payload.observedThrough && item.publishedAt.slice(0, 10) > payload.observedThrough || Date.parse(item.publishedAt) > Date.parse(item.verifiedAt) || Date.parse(item.verifiedAt) > verified || item.updatedAt && Date.parse(item.updatedAt) > Date.parse(item.verifiedAt)) fail("news.times");
          item.sourceVerification.forEach(function (v) { if (!fixtureUrl(v.url) || Date.parse(v.checkedAt) > verified) fail("news.source"); });
        } else {
          if (!sources.has(item.sourceId) || !fixtureUrl(item.sourceUrl) || !fixtureUrl(item.originatingAgencyUrl) || Date.parse(item.lastVerifiedAt) > verified) fail("calendar.source");
          if (item.status === "released" || item.status === "revised") { if (!item.result || item.result.status !== item.status) fail("calendar.result_missing"); }
          if (item.result) {
            if (!fixtureUrl(item.result.sourceUrl) || Date.parse(item.result.publishedAt) > Date.parse(item.result.retrievedAt) || Date.parse(item.result.retrievedAt) > verified || !item.result.metrics.length || item.result.metrics.some(function (m) { return m.actual === null; })) fail("calendar.result");
          }
          if (item.expectation && (!fixtureUrl(item.expectation.sourceUrl) || Date.parse(item.expectation.retrievedAt) > verified)) fail("calendar.expectation");
        }
      });
    }
    return payload;
  }
  function freshness(value, maxAgeDays, now) {
    var date = value && Date.parse(value.length === 10 ? value + "T23:59:59Z" : value), clock = now === undefined ? Date.now() : +new Date(now);
    if (!date || !Number.isFinite(date) || !Number.isFinite(clock) || date > clock + (value.length === 10 ? 86400000 : 0)) return "unavailable";
    return clock - date > maxAgeDays * 86400000 ? "stale" : "fresh";
  }
  function eventOrder(a, b) {
    var ta = Date.parse(a.scheduledAtUtc), tb = Date.parse(b.scheduledAtUtc);
    if (!Number.isFinite(ta)) ta = Infinity; if (!Number.isFinite(tb)) tb = Infinity;
    return ta - tb || (a.importance === "critical" ? 0 : 1) - (b.importance === "critical" ? 0 : 1) || String(a.eventId || a.eventKey || a.title).localeCompare(String(b.eventId || b.eventKey || b.title));
  }
  function nextEvent(events, now) {
    var clock = now === undefined ? Date.now() : +new Date(now);
    return events.filter(function (e) { return e.status === "scheduled" && Date.parse(e.scheduledAtUtc) >= clock && ["primary_official", "cross_checked_primary", "single_official_secondary"].includes(e.verificationStatus); }).sort(eventOrder)[0] || null;
  }
  function emptyArchive() {
    return { status: "unavailable", series: { spx: [], ndx: [], vix: [], vxn: [], twoYear: [], tenYear: [], thirtyYear: [], cnnFearGreed: [] }, snapshot: {}, marketDataThrough: {}, quality: {} };
  }
  function adapt(domain, payload, contract, generatedAt) {
    if (domain === "snapshot") {
      var archive = emptyArchive(); archive.status = payload.status; archive.asOf = payload.observedThrough; archive.generatedAt = generatedAt || null; archive.verifiedAt = payload.verifiedAt;
      Object.keys(payload.data.series).forEach(function (key) {
        var points = payload.data.series[key].points;
        archive.series[key] = points.map(function (p) { return p.slice(0, key === "cnnFearGreed" ? 4 : 2); });
        var last = points[points.length - 1]; archive.snapshot[key] = last ? { date: last[0], value: last[1], rating: key === "cnnFearGreed" ? last[2] : null } : {};
        archive.marketDataThrough[key] = last ? last[0] : null;
      });
      var cnn = archive.series.cnnFearGreed, snap = archive.snapshot.cnnFearGreed;
      var currentPublisher = cnn.filter(function (p) { return p[3] === "publisher"; }).pop();
      snap = archive.snapshot.cnnFearGreed = currentPublisher ? { date: currentPublisher[0], value: currentPublisher[1], rating: currentPublisher[2] } : {};
      function before(days) { if (!snap.date) return null; var d = new Date(snap.date); d.setUTCDate(d.getUTCDate() - days); var p = cnn.filter(function (p) { return p[0] <= d.toISOString().slice(0, 10); }).pop(); return p ? { date: p[0], value: p[1] } : null; }
      snap.previousClose = cnn.length > 1 ? { date: cnn[cnn.length - 2][0], value: cnn[cnn.length - 2][1] } : null;
      snap.oneWeek = before(7); snap.oneMonth = before(30); snap.oneYear = before(365);
      var legacy = cnn.filter(function (p) { return p[3] === "legacy"; });
      archive.quality.cnnFearGreed = { boundaryDate: contract.cnnBoundaryDate, legacy: { through: legacy.length ? legacy[legacy.length - 1][0] : null } };
      return archive;
    }
    if (domain === "news") return { status: payload.status, retrievedAt: payload.verifiedAt, observedThrough: payload.observedThrough, message: payload.message, viewSummaries: { market_headlines: payload.data.summaryZh }, items: payload.data.items };
    return { status: payload.status, verifiedAt: payload.verifiedAt, observedThrough: payload.observedThrough, message: payload.message, events: { upcoming: payload.data.items, recent: [], undated: [] } };
  }
  async function digest(bytes) { var hash = await globalThis.crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(hash), function (x) { return x.toString(16).padStart(2, "0"); }).join(""); }
  async function load(config) {
    if (!config || !["market-static-candidate-v1", "market-static-public-v1"].includes(config.mode) || config.manifest !== "data/market/manifest.json" || config.contract !== "assets/market-content-contract.json") fail("configuration");
    async function bytes(path) { var r = await fetch(path, { credentials: "omit", cache: "no-store", redirect: "error" }); if (!r.ok) throw new Error("content_unavailable"); var b = await r.arrayBuffer(); if (b.byteLength > 8 * 1024 * 1024) fail("size"); return new Uint8Array(b); }
    function decode(b) { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b)); }
    var initial = await Promise.all([bytes(config.manifest), bytes(config.contract)]), contract = decode(initial[1]), manifest = validateManifest(decode(initial[0]), contract), result = {};
    await Promise.all(domains.map(async function (domain) {
      try { var raw = await bytes(contract.paths[domain]); if (await digest(raw) !== manifest.packages[domain].sha256) fail("digest"); result[domain] = adapt(domain, validateDomain(domain, decode(raw), manifest, contract), contract, manifest.generatedAt); }
      catch (_) { result[domain] = domain === "snapshot" ? emptyArchive() : { status: "unavailable", message: "该域静态内容不可用或未通过完整性校验。", items: [] }; }
    }));
    if (manifest.synthetic !== (config.mode === "market-static-candidate-v1")) fail("mode_scope");
    result.synthetic = manifest.synthetic; return result;
  }
  return { number: number, validDate: validDate, validUtc: validUtc, shape: shape, validateManifest: validateManifest, validateDomain: validateDomain, freshness: freshness, eventOrder: eventOrder, nextEvent: nextEvent, emptyArchive: emptyArchive, adapt: adapt, load: load };
}));
