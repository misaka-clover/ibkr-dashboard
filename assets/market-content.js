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
  function validDate(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value.slice(0,4) !== "0000" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
  function validUtc(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number(value.slice(11,13)) < 24 && Number(value.slice(14,16)) < 60 && Number(value.slice(17,19)) < 60 && Number.isFinite(Date.parse(value)) && validDate(value.slice(0, 10)); }
  // Schema UTC timestamps allow six fractional digits; Date alone truncates
  // microseconds. Use integer microseconds for all admission/order comparisons.
  function utcMicros(value) {
    if (!validUtc(value)) fail("utc");
    var fraction = value.slice(19, -1);
    return BigInt(Date.parse(value.slice(0,19) + "Z")) * 1000n + BigInt((fraction ? fraction.slice(1) : "").padEnd(6,"0"));
  }
  function compareUtc(a, b) { var x = utcMicros(a), y = utcMicros(b); return x < y ? -1 : x > y ? 1 : 0; }
  function clockMicros(now) {
    if (validUtc(now)) return utcMicros(now);
    var clock = now === undefined ? Date.now() : +new Date(now);
    if (!Number.isFinite(clock)) fail("clock");
    return BigInt(clock) * 1000n;
  }
  function parseJson(text) {
    // Validate JSON grammar first, then inspect every raw key before returning
    // the parsed object. JSON.parse alone silently discards earlier duplicates.
    var parsed = JSON.parse(text), at = 0;
    function space() { while (/\s/.test(text[at] || "") && at < text.length) at++; }
    function string() {
      var start = at++;
      while (text[at] !== '"') { if (text[at] === "\\") at++; at++; }
      at++; return JSON.parse(text.slice(start,at));
    }
    function value() {
      space(); var c = text[at];
      if (c === '"') { string(); return; }
      if (c === "{") {
        at++; space(); var keys = new Set();
        if (text[at] === "}") { at++; return; }
        while (true) {
          space(); var key = string();
          if (keys.has(key)) fail("duplicate_key"); keys.add(key);
          space(); at++; value(); space();
          if (text[at++] === "}") return;
        }
      }
      if (c === "[") {
        at++; space(); if (text[at] === "]") { at++; return; }
        while (true) { value(); space(); if (text[at++] === "]") return; }
      }
      while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
    }
    value(); return parsed;
  }
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
      if (/data\/private|\/Users\/|account(?:Id|Number|Alias)|orderId|tradeId|contractId|connectorEnvelope|bearer\s+|(?:access|refresh)[_-]?token|<\/?(?:script|iframe|img)\b|\b[UDF]\d{5,}\b/i.test(value)) fail(path);
    }
  }
  function fixtureUrl(value) { return https(value) && new URL(value).hostname.endsWith(".invalid"); }
  function admittedUrl(value, hosts) {
    if (!https(value)) return false;
    var u = new URL(value);
    return (!u.port || u.port === "443") && hosts.includes(u.hostname) && !u.hash && !u.search;
  }
  function evidenceUrl(value, hosts, contract, calendarResult) {
    if (!calendarResult && admittedUrl(value,hosts)) return true;
    if (!https(value)) return false;
    var u=new URL(value), rule=contract.calendarResultAdmissions && contract.calendarResultAdmissions.BLS || {};
    if (u.hostname!=='fred.stlouisfed.org') return admittedUrl(value,hosts);
    if (!hosts.includes(u.hostname) || u.port && u.port!=='443' || u.hash || !(rule.secondaryPaths||[]).includes(u.pathname)) return false;
    var keys=[...u.searchParams.keys()];
    if (keys.some(function(k){return !['id','cosd','coed'].includes(k) || u.searchParams.getAll(k).length!==1;}) || !u.searchParams.get('id')) return false;
    var series=u.searchParams.get('id').split(',');
    if (new Set(series).size!==series.length || series.some(function(k){return !(rule.series||[]).includes(k);})) return false;
    return ['cosd','coed'].every(function(k){return !u.searchParams.has(k) || validDate(u.searchParams.get(k));});
  }
  function comparableMetric(event, metric, contract) {
    var expectation=event.expectation,result=event.result,definition=contract && contract.metricDefinitions && contract.metricDefinitions[metric.metricKey] || {unit:metric.unit,observationBasis:metric.metricKey+'_v1'};
    if (!expectation || expectation.status!=='reviewed' && expectation.status!=='reviewed_single_secondary' || !result || compareUtc(expectation.retrievedAt,result.publishedAt)>0 || !definition || metric.unit!==definition.unit || !metric.periodLabel) return null;
    return expectation.metrics.find(function(forecast){return forecast.metricKey===metric.metricKey && forecast.periodLabel===metric.periodLabel && forecast.unit===metric.unit && (forecast.observationBasis||definition.observationBasis)===(metric.observationBasis||definition.observationBasis) && (metric.observationBasis||definition.observationBasis)===definition.observationBasis && forecast.consensus!==null;}) || null;
  }
  function sameValue(a,b) {
    if (a===b) return true;
    if (!a || !b || typeof a!==typeof b || typeof a!=='object' || Array.isArray(a)!==Array.isArray(b)) return false;
    var keys=Object.keys(a),other=Object.keys(b);
    return keys.length===other.length && keys.every(function(k){return Object.prototype.hasOwnProperty.call(b,k) && sameValue(a[k],b[k]);});
  }
  function legacyProjectAssessment(item,contract) {
    var result=item.result||{},expected=(contract.legacyProjectResultAssessments||{})[item.eventId];
    if (item.expectation!==null || result.assessmentOrigin!=='reviewed_project_analysis' || !result.assessment || result.assessment.surpriseClass!=='not_comparable' || !expected) return false;
    var periods=[...new Set(expected.result.metrics.map(function(m){return m.periodLabel;}).filter(Boolean))];
    var period=expected.periodLabel || (periods.length===1?periods[0]:null);
    if (period===null || item.identityPeriod!==period) return false;
    var current={};['eventId','originatingAgency','eventType','periodLabel','result'].forEach(function(k){current[k]=item[k];});
    return sameValue(current,expected);
  }
  function validateCalendarItem(item, admission, sources, contract, verified) {
    var allowed=admission && admission.role==='official_secondary'?['single_official_secondary','cross_checked_primary','source_conflict','unverified']:['primary_official','cross_checked_primary','source_conflict','unverified'];
    if (!admission || !admission.uses.includes('calendar') || admission.agency!==item.originatingAgency || contract.calendarTypes[item.eventType]!==item.originatingAgency || !admittedUrl(item.sourceUrl,admission.hosts) || !admittedUrl(item.originatingAgencyUrl,admission.originatingHosts||admission.hosts) || !allowed.includes(item.verificationStatus) || item.originalTimezone!=='America/New_York' || item.status==='scheduled' && !item.scheduledAtUtc) fail('calendar.admission');
    if (verified===null || utcMicros(item.lastVerifiedAt)>verified) fail('calendar.source');
    item.meetingMaterials.forEach(function(m){if(m.sourceUrl && !admittedUrl(m.sourceUrl,admission.hosts)) fail('calendar.material_source');});
    var expectation=item.expectation,result=item.result;
    if (expectation) {
      var source=contract.expectationSourceAdmissions && contract.expectationSourceAdmissions[expectation.provider];
      if (!source || source.providerLicenseConfirmed!==true || !source.publicUseEvidence || !(source.eventTypes||[]).includes(item.eventType) || !admittedUrl(expectation.sourceUrl,source.hosts)) fail('calendar.expectation_public_use_pending');
      if (expectation.status!=='reviewed' || utcMicros(expectation.retrievedAt)>verified || expectation.sourcePageUpdatedDate && expectation.sourcePageUpdatedDate>expectation.retrievedAt.slice(0,10)) fail('calendar.expectation');
      var metricKeys=new Set();expectation.metrics.forEach(function(m){var d=contract.metricDefinitions && contract.metricDefinitions[m.metricKey];if(metricKeys.has(m.metricKey)||!d||!(source.metricKeys||[]).includes(m.metricKey)||m.unit!==d.unit)fail('calendar.expectation_metric');metricKeys.add(m.metricKey);});
    }
    if (['released','revised'].includes(item.status) && (!result || result.status!==item.status)) fail('calendar.result_missing');
    if (!result) return;
    var rule=contract.calendarResultAdmissions && contract.calendarResultAdmissions[item.originatingAgency] || {}, secondary=result.sourceRole==='official_secondary_result', hosts=(secondary?rule.secondaryHosts:rule.primaryHosts)||admission.hosts;
    if (secondary && (result.sourceId!=='fred-bls-results'||!sources.has('fred-bls-results')) || !evidenceUrl(result.sourceUrl,hosts,contract,true) || !['released','revised'].includes(item.status) || compareUtc(result.publishedAt,result.retrievedAt)>0 || utcMicros(result.retrievedAt)>verified || !result.metrics.length || result.metrics.some(function(m){return m.actual===null;})) fail('calendar.result');
    var keys=new Set();result.metrics.forEach(function(m){var d=contract.metricDefinitions && contract.metricDefinitions[m.metricKey];if(keys.has(m.metricKey)||!d||m.unit!==d.unit||(m.observationBasis!==undefined&&m.observationBasis!==d.observationBasis))fail('calendar.result_metric');keys.add(m.metricKey);});
    var assessment=result.assessment,neutral=contract.publicResultAssessment;
    if (!neutral || Object.keys(assessment).length!==Object.keys(neutral).length || Object.keys(neutral).some(function(k){return assessment[k]!==neutral[k];})) {
      if (!expectation && !legacyProjectAssessment(item,contract)) fail('calendar.expectation_assessment_pending');
      if (result.assessmentOrigin!=='reviewed_project_analysis' || !result.evidenceSha256 || !assessment.summaryZh.trim() || !assessment.transmissionPathZh.trim()) fail('calendar.expectation_assessment_pending');
      if (assessment.surpriseClass!=='not_comparable' && !result.metrics.some(function(m){return comparableMetric(item,m,contract);})) fail('calendar.comparison_basis');
    }
  }
  function sourceAdmission(source, contract) {
    var admission = contract.sourceAdmissions && contract.sourceAdmissions[source.id];
    return admission && ["name", "url", "role", "redistribution"].every(function (k) { return source[k] === admission[k]; }) ? admission : null;
  }
  function validateManifest(manifest, contract, now) {
    var production = contract && contract.contractId === "market-content-public-v1" && contract.status === "public_existing_sources_only";
    if (!production && (!contract || contract.contractId !== "market-content-candidate-v1" || contract.status !== "synthetic_candidate_not_publication_authority")) fail("contract");
    if (!manifest || manifest.synthetic !== !production || domains.some(function (d) { return contract.paths[d] !== "data/market/" + d + ".json"; })) fail("candidate_scope");
    shape(manifest, contract.definitions.manifest, contract, "manifest");
    if (utcMicros(manifest.generatedAt) > clockMicros(now)) fail("manifest.future_generation");
    if (manifest.contentVersion === 1 ? manifest.previousVersion !== null || manifest.previousManifestSha256 !== null : manifest.previousVersion !== manifest.contentVersion - 1 || !manifest.previousManifestSha256) fail("manifest.predecessor");
    var ids = new Set();
    manifest.sources.forEach(function (s) { if (production ? !sourceAdmission(s, contract) || ids.has(s.id) : !/^synthetic-[a-z0-9-]+$/.test(s.id) || ids.has(s.id) || !fixtureUrl(s.url)) fail("manifest.sources"); ids.add(s.id); });
    return manifest;
  }
  function validateDomain(domain, payload, manifest, contract) {
    shape(payload, contract.definitions[domain], contract, domain);
    var production = manifest.synthetic === false;
    var meta = manifest.packages[domain];
    ["revision", "observedThrough", "verifiedAt", "status"].forEach(function (key) { if (payload[key] !== meta[key]) fail(domain + ".metadata"); });
    var generated = utcMicros(manifest.generatedAt), verified = payload.verifiedAt === null ? null : utcMicros(payload.verifiedAt);
    if (verified !== null && verified > generated || payload.observedThrough && (verified === null || payload.observedThrough > payload.verifiedAt.slice(0, 10))) fail(domain + ".cutoff");
    if ((payload.status === "pass" || payload.status === "warning" || payload.status === "empty") && verified === null) fail(domain + ".verification");
    if (payload.status === "pass" && !payload.observedThrough) fail(domain + ".cutoff_missing");
    var sources = new Map(manifest.sources.map(function (s) { return [s.id, s]; }));
    if (domain === "snapshot") {
      var total = 0;
      Object.keys(payload.data.series).forEach(function (key) {
        var series = payload.data.series[key], prior = "";
        if (series.unit !== (key === "twoYear" || key === "tenYear" || key === "thirtyYear" ? "percent" : key === "cnnFearGreed" ? "points" : "index")) fail("snapshot.unit");
        series.points.forEach(function (p) {
          var source = sources.get(p[key === "cnnFearGreed" ? 4 : 2]);
          var admission = source && production && sourceAdmission(source, contract);
          if (production && (!admission || admission.series !== key || !admission.uses.includes("series"))) fail("public.source_scope");
          if (!source || p[0] <= prior || !payload.observedThrough || p[0] > payload.observedThrough || p[1] <= 0 && key !== "cnnFearGreed") fail("snapshot.observation");
          if (key === "cnnFearGreed" && (p[3] !== source.role || (p[3] === "legacy" ? p[0] >= contract.cnnBoundaryDate : p[0] < contract.cnnBoundaryDate))) fail("snapshot.cnn_source_boundary");
          prior = p[0]; total++;
        });
      });
      (payload.data.valuationObservations || []).forEach(function (v, i, list) {
        var rule = contract.valuationSourceAdmissions && contract.valuationSourceAdmissions[v.sourceId];
        var definition = contract.valuationDefinitions && contract.valuationDefinitions[v.metric];
        if (!production || !rule || !definition || !rule.metrics.includes(v.metric) || !admittedUrl(v.sourceUrl, rule.hosts) || !sources.has(v.sourceId)) fail("valuation.public_use");
        if (Object.keys(definition).some(function (k) { return v[k] !== definition[k]; }) || !payload.observedThrough || verified === null || v.date > payload.observedThrough || utcMicros(v.verifiedAt) > verified || v.date > v.verifiedAt.slice(0,10)) fail("valuation.definition_or_cutoff");
        if (list.slice(0,i).some(function (p) { return p.metric === v.metric && p.date === v.date; })) fail("valuation.duplicate");
        total++;
      });
      if (manifest.synthetic === false && (total ? payload.status !== "warning" : payload.status !== "unavailable")) fail("public.snapshot_status");
      if ((payload.status === "empty" || payload.status === "unavailable") && total) fail("snapshot.empty");
      if (payload.status === "pass" && Object.values(payload.data.series).some(function (s) { return !s.points.length; })) fail("snapshot.incomplete");
    } else {
      var ids = new Set(), items = payload.data.items.concat(payload.data.archivedItems || []);
      var windowItems=domain === "news" ? payload.data.items : items;
      if (payload.status === "empty" && windowItems.length || payload.status === "unavailable" && items.length || payload.status === "pass" && !windowItems.length) fail(domain + ".empty");
      items.forEach(function (item) {
        if (!item.eventId.trim() || ids.has(item.eventId)) fail(domain + ".duplicate"); ids.add(item.eventId);
        if (domain === "news") {
          if (production) {
            var publisher = contract.newsPublishers[item.publisher];
            if (!publisher || !admittedUrl(item.canonicalUrl, publisher.hosts) || !item.title.trim() || !item.titleZh.trim() || !item.summaryZh.trim() || !item.factBasis.trim() || !item.inference.trim() || !item.transmissionPath.trim()) fail("news.publisher_or_summary");
            if (item.accessStatus === "primary_release_reviewed" && !["Federal Reserve","BLS","BEA","Census"].includes(item.publisher)) fail("news.access_role");
            var matchedPrimary = false;
            item.sourceVerification.forEach(function (v) {
              var hosts = v.sourceType === "media_crosscheck" ? [].concat.apply([], Object.values(contract.newsPublishers).map(function (p) { return p.hosts; })) : contract.verificationHosts[v.sourceType] || [];
              if (!evidenceUrl(v.url, hosts,contract) || compareUtc(v.checkedAt,item.verifiedAt) > 0) fail("news.source");
              if (["primary_official","issuer_official"].includes(v.sourceType) && v.status === "matched") matchedPrimary = true;
            });
            if (item.factStatus === "confirmed_primary" && !matchedPrimary || item.sourceVerification.some(function (v) { return v.status === "conflict"; })) fail("news.evidence_status");
          }
          if (item.accessStatus === "metadata_only") fail("news.full_review_required");
          if (!production && !fixtureUrl(item.canonicalUrl) || !payload.observedThrough || item.publishedAt.slice(0, 10) > payload.observedThrough || compareUtc(item.publishedAt,item.verifiedAt) > 0 || (verified === null || utcMicros(item.verifiedAt) > verified) || item.updatedAt && (compareUtc(item.updatedAt,item.verifiedAt) > 0 || compareUtc(item.updatedAt,item.publishedAt) < 0)) fail("news.times");
          item.sourceVerification.forEach(function (v) { if (!production && !fixtureUrl(v.url) || (verified === null || utcMicros(v.checkedAt) > verified)) fail("news.source"); });
        } else {
          if (['released','revised'].includes(item.status) && !item.result) fail('calendar.result_missing');
          var calendarAdmission = production && sources.has(item.sourceId) && sourceAdmission(sources.get(item.sourceId), contract);
          if (production && payload.status === "pass" && (["source_conflict","unverified"].includes(item.verificationStatus) || item.status === "unverified")) fail("calendar.conflicted_domain");
          if (production) validateCalendarItem(item,calendarAdmission,sources,contract,verified);
          else {
            if (!sources.has(item.sourceId) || !fixtureUrl(item.sourceUrl) || !fixtureUrl(item.originatingAgencyUrl) || verified===null || utcMicros(item.lastVerifiedAt)>verified) fail('calendar.source');
            if (item.result && (!fixtureUrl(item.result.sourceUrl) || compareUtc(item.result.publishedAt,item.result.retrievedAt)>0 || verified===null || utcMicros(item.result.retrievedAt)>verified || !item.result.metrics.length || item.result.metrics.some(function(m){return m.actual===null;}))) fail('calendar.result');
            if (item.expectation && (!fixtureUrl(item.expectation.sourceUrl) || verified===null || utcMicros(item.expectation.retrievedAt)>verified)) fail('calendar.expectation');
          }

        }
      });
    }
    if (production && (domain==='calendar'||domain==='news')) {
      var expected=[],all=payload.data.items.concat(payload.data.archivedItems||[]);
      if(domain==='calendar') new Set(all.map(function(e){return e.sourceId;})).forEach(function(id){var a=sourceAdmission(sources.get(id),contract);if(a.attribution)expected.push([id,a.attribution,a.publicUseEvidence,a.modifiedContentLabel]);});
      if(domain==='calendar' && all.some(function(e){return e.result&&e.result.sourceRole==='official_secondary_result';})){var a=contract.calendarResultAdmissions.BLS;expected.push(['fred-bls-results',a.attribution,a.secondaryPublicUseEvidence,'项目计算的 BLS 统计变化；通过 FRED 取得，不代表直接审阅 BLS 发布页。']);}
      if((payload.data.attributions||[]).length!==expected.length)fail('source_attribution');
      expected.forEach(function(a){if(!(payload.data.attributions||[]).some(function(x){return x.sourceId===a[0]&&x.text===a[1]&&x.termsUrl===a[2]&&x.modificationNotice===a[3];}))fail('source_attribution');});
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
  function groupMeetings(events) {
    var labels={fomc_sep:'经济预测摘要',fomc_press_conference:'主席发布会',fomc_minutes:'会议纪要'},decisions=new Map();
    events.forEach(function(e){if(e.eventType==='fomc_decision' && (e.identityPeriod||e.periodLabel))decisions.set(e.identityPeriod||e.periodLabel,e);});
    var grouped=[];events.forEach(function(e){var decision=labels[e.eventType]&&decisions.get(e.identityPeriod||e.periodLabel);if(!decision){grouped.push(e);return;}var material={label:labels[e.eventType],eventType:e.eventType,scheduledAtUtc:e.scheduledAtUtc,status:e.status,sourceUrl:e.sourceUrl};decision.meetingMaterials=(decision.meetingMaterials||[]).filter(function(m){return m.eventType!==e.eventType;}).concat([material]);});return grouped;
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
      archive.publicValuationObservations = (payload.data.valuationObservations || []).map(function (v) {
        return Object.assign({}, v, { sourceName: contract.sourceAdmissions[v.sourceId].name });
      });
      return archive;
    }
    if (domain === "news") return { status: payload.status, retrievedAt: payload.verifiedAt, observedThrough: payload.observedThrough, message: payload.message, viewSummaries: { market_headlines: payload.data.summaryZh }, items: payload.data.items, archivedItems: payload.data.archivedItems || [], attributions: payload.data.attributions || [] };
    function adaptedEvent(event) { return event.expectation && event.expectation.status === "reviewed" ? Object.assign({}, event, { expectation: Object.assign({}, event.expectation, { status: "reviewed_single_secondary" }) }) : event; }
    return { status: payload.status, verifiedAt: payload.verifiedAt, observedThrough: payload.observedThrough, message: payload.message, attributions: payload.data.attributions || [], events: { upcoming: payload.data.items.map(adaptedEvent), recent: (payload.data.archivedItems || []).map(adaptedEvent), undated: [] } };
  }
  async function digest(bytes) { var hash = await globalThis.crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(hash), function (x) { return x.toString(16).padStart(2, "0"); }).join(""); }
  async function load(config) {
    if (!config || !["market-static-candidate-v1", "market-static-public-v1"].includes(config.mode) || config.manifest !== "data/market/manifest.json" || config.contract !== "assets/market-content-contract.json") fail("configuration");
    async function bytes(path) { var r = await fetch(path, { credentials: "omit", cache: "no-store", redirect: "error" }); if (!r.ok) throw new Error("content_unavailable"); var b = await r.arrayBuffer(); if (b.byteLength > 8 * 1024 * 1024) fail("size"); return new Uint8Array(b); }
    function decode(b) { return parseJson(new TextDecoder("utf-8", { fatal: true }).decode(b)); }
    var initial = await Promise.all([bytes(config.manifest), bytes(config.contract)]), contract = decode(initial[1]), manifest = validateManifest(decode(initial[0]), contract), result = {};
    await Promise.all(domains.map(async function (domain) {
      try { var raw = await bytes(contract.paths[domain]); if (await digest(raw) !== manifest.packages[domain].sha256) fail("digest"); result[domain] = adapt(domain, validateDomain(domain, decode(raw), manifest, contract), contract, manifest.generatedAt); }
      catch (_) { result[domain] = domain === "snapshot" ? emptyArchive() : { status: "unavailable", message: "该域静态内容不可用或未通过完整性校验。", items: [] }; }
    }));
    if (manifest.synthetic !== (config.mode === "market-static-candidate-v1")) fail("mode_scope");
    result.synthetic = manifest.synthetic; return result;
  }
  return { legacyProjectAssessment: legacyProjectAssessment, utcMicros: utcMicros, groupMeetings: groupMeetings, comparableMetric: comparableMetric, parseJson: parseJson, compareUtc: compareUtc, number: number, validDate: validDate, validUtc: validUtc, shape: shape, validateManifest: validateManifest, validateDomain: validateDomain, freshness: freshness, eventOrder: eventOrder, nextEvent: nextEvent, emptyArchive: emptyArchive, adapt: adapt, load: load };
}));
