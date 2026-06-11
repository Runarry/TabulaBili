import { getSampleId, mergeAggregate, toEventRow } from '../report-aggregate.js';
import {
  buildReportAnalytics,
  eventMatchesAnalyticsOptions,
  eventMatchesReportEventOptions,
  filterReportAnalyticsSection,
  filterSamples,
  getDailyMetricDelta,
  normalizeAnalyticsOptions,
  normalizeAnalyticsSection,
  normalizeEventListOptions,
  normalizeLimit,
  normalizeOffset,
  normalizeSampleListOptions,
  normalizeStoredEvent,
  sortSamples
} from './helpers.js';

function createRunId(kind = 'run') {
  return `${kind}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeMid(value) {
  const mid = String(value || '').trim();
  return /^\d+$/.test(mid) ? mid : '';
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getVideoOrderValue(video, sort) {
  if (sort === 'views') return Number(video.viewCount || 0);
  if (sort === 'likes') return Number(video.likeCount || 0);
  return Number(video.pubdate || 0);
}

class MemoryStorage {
  constructor() {
    this.config = null;
    this.batches = new Map();
    this.events = new Map();
    this.samples = new Map();
    this.dailyMetrics = new Map();
    this.upTargets = new Map();
    this.upProfileSnapshots = [];
    this.upVideos = new Map();
    this.videoMetricSnapshots = [];
    this.collectorRuns = new Map();
    this.upPortraits = new Map();
  }

  async getConfig() {
    return this.config;
  }

  async saveConfig(config) {
    this.config = config;
  }

  async saveReportBatch(batch) {
    if (this.batches.has(batch.batchId)) {
      return { duplicateBatch: true, eventCount: batch.events.length, duplicateEventCount: batch.events.length };
    }

    let duplicateEventCount = 0;
    const receivedAt = new Date().toISOString();
    this.batches.set(batch.batchId, {
      batchId: batch.batchId,
      clientId: batch.clientId,
      capturedAt: batch.capturedAt,
      receivedAt,
      eventCount: batch.events.length,
      duplicateEventCount: 0,
      raw: batch
    });

    for (const event of batch.events) {
      if (this.events.has(event.eventId)) {
        duplicateEventCount += 1;
        continue;
      }
      const sampleId = getSampleId(event);
      const existingAggregate = sampleId ? this.samples.get(sampleId) : null;
      const eventRow = toEventRow(event, batch, receivedAt, existingAggregate);
      this.events.set(event.eventId, eventRow);
      this.incrementDailyMetrics(eventRow);
      if (!sampleId) continue;
      this.samples.set(sampleId, mergeAggregate(existingAggregate, event));
    }
    const storedBatch = this.batches.get(batch.batchId);
    if (storedBatch) storedBatch.duplicateEventCount = duplicateEventCount;

    return { duplicateBatch: false, eventCount: batch.events.length, duplicateEventCount };
  }

  async getReportSummary() {
    return {
      batchCount: this.batches.size,
      eventCount: this.events.size,
      duplicateEventCount: [...this.batches.values()].reduce((sum, batch) => sum + Number(batch.duplicateEventCount || 0), 0),
      sampleCount: this.samples.size
    };
  }

  async listReportBatches(options = {}) {
    const limit = normalizeLimit(options.limit, 200);
    const offset = normalizeOffset(options.offset);
    const includeTotal = options.includeTotal !== false;
    const rows = [...this.batches.values()]
      .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
      .slice(offset, offset + limit + (includeTotal ? 0 : 1))
      .map(({ raw, ...item }) => item);
    const items = rows.slice(0, limit);
    if (!includeTotal) return { items, hasMore: rows.length > limit };
    return { items, total: this.batches.size };
  }

  async listReportSamples(options = {}) {
    const query = normalizeSampleListOptions(options);
    const includeTotal = options.includeTotal !== false;
    const filtered = sortSamples(filterSamples([...this.samples.values()], query, [...this.events.values()]), query.sort);
    const rows = filtered.slice(query.offset, query.offset + query.limit + (includeTotal ? 0 : 1));
    const items = rows.slice(0, query.limit);
    if (!includeTotal) return { items, hasMore: rows.length > query.limit };
    return { items, total: filtered.length };
  }

  async listReportEvents(options = {}) {
    const query = normalizeEventListOptions(options);
    const filtered = [...this.events.values()]
      .map(normalizeStoredEvent)
      .filter((event) => eventMatchesReportEventOptions(event, query))
      .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
    return { items: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length };
  }

  async getReportAnalytics(options = {}) {
    const query = normalizeAnalyticsOptions(options);
    const section = normalizeAnalyticsSection(options.section);
    const events = [...this.events.values()].filter((event) => eventMatchesAnalyticsOptions(event, query));
    return filterReportAnalyticsSection(buildReportAnalytics({
      events,
      range: query
    }), section);
  }

  async cleanupReports(options = {}) {
    const before = String(options.before || '');
    const dryRun = options.dryRun !== false;
    const plan = this.getCleanupPlan(before);
    const matched = {
      events: plan.eventIds.length,
      batches: plan.batchIds.length,
      orphanSamples: plan.orphanSampleIds.length
    };
    if (dryRun) return { before, dryRun, matched, deleted: { events: 0, batches: 0, orphanSamples: 0 } };

    for (const id of plan.eventIds) this.events.delete(id);
    for (const id of plan.batchIds) this.batches.delete(id);
    for (const id of plan.orphanSampleIds) this.samples.delete(id);
    return { before, dryRun, matched, deleted: { ...matched } };
  }

  getCleanupPlan(before) {
    const eventIds = [];
    const batchIds = [];
    const remainingSampleIds = new Set();

    for (const [id, event] of this.events.entries()) {
      if (String(event.capturedAt || '') < before) eventIds.push(id);
      else if (event.sampleId) remainingSampleIds.add(event.sampleId);
    }
    for (const [id, batch] of this.batches.entries()) {
      if (String(batch.receivedAt || '') < before) batchIds.push(id);
    }

    const orphanSampleIds = [...this.samples.keys()].filter((id) => !remainingSampleIds.has(id));
    return { eventIds, batchIds, orphanSampleIds };
  }

  incrementDailyMetrics(eventRow) {
    const delta = getDailyMetricDelta(eventRow);
    if (!delta) return;
    const key = JSON.stringify([delta.date, delta.clientId, delta.mode, delta.source, delta.category]);
    const current = this.dailyMetrics.get(key) || {
      date: delta.date,
      clientId: delta.clientId,
      mode: delta.mode,
      source: delta.source,
      category: delta.category,
      impressions: 0,
      clicks: 0,
      feedbacks: 0,
      negativeFeedbacks: 0
    };
    current.impressions += delta.impressions;
    current.clicks += delta.clicks;
    current.feedbacks += delta.feedbacks;
    current.negativeFeedbacks += delta.negativeFeedbacks;
    this.dailyMetrics.set(key, current);
  }

  async importUpTargets(mids, options = {}) {
    const now = new Date().toISOString();
    const normalized = [...new Set((Array.isArray(mids) ? mids : []).map(normalizeMid).filter(Boolean))];
    let imported = 0;
    let existing = 0;
    const items = [];
    for (const mid of normalized) {
      const current = this.upTargets.get(mid);
      if (current) existing += 1;
      else imported += 1;
      const target = {
        mid,
        name: current && current.name || '',
        seedSource: options.source || options.seedSource || current && current.seedSource || 'manual',
        seedBvid: options.seedBvid || options.bvid || current && current.seedBvid || '',
        note: options.note || current && current.note || '',
        status: current && current.status || 'pending',
        priority: Math.max(Number(current && current.priority || 0), Number(options.priority || 0)),
        createdAt: current && current.createdAt || now,
        updatedAt: now,
        lastCollectedAt: current && current.lastCollectedAt || '',
        nextCollectAfter: current && current.nextCollectAfter || '',
        lastErrorType: current && current.lastErrorType || '',
        lastErrorMessage: current && current.lastErrorMessage || '',
        failureCount: Number(current && current.failureCount || 0)
      };
      this.upTargets.set(mid, target);
      items.push(clone(target));
    }
    return {
      items,
      imported,
      existing,
      skipped: (Array.isArray(mids) ? mids.length : 0) - normalized.length
    };
  }

  async getUpTarget(mid) {
    return clone(this.upTargets.get(String(mid)) || null);
  }

  async listUpTargets(options = {}) {
    const limit = normalizeLimit(options.limit, 500, 50);
    const offset = normalizeOffset(options.offset);
    const includeTotal = options.includeTotal !== false;
    const q = String(options.q || '').trim().toLowerCase();
    const status = String(options.status || '').trim();
    const filtered = [...this.upTargets.values()]
      .filter((target) => !q || `${target.mid} ${target.name}`.toLowerCase().includes(q))
      .filter((target) => !status || status === 'all' || target.status === status)
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const rows = filtered.slice(offset, offset + limit + (includeTotal ? 0 : 1));
    const items = rows.slice(0, limit).map(clone);
    if (!includeTotal) return { items, hasMore: rows.length > limit };
    return { items, total: filtered.length };
  }

  async listDueUpTargets(options = {}) {
    const limit = normalizeLimit(options.limit, 50, 1);
    const now = String(options.now || new Date().toISOString());
    const items = [...this.upTargets.values()]
      .filter((target) => target.status !== 'running')
      .filter((target) => !target.nextCollectAfter || target.nextCollectAfter <= now)
      .sort((a, b) =>
        Number(b.priority || 0) - Number(a.priority || 0)
        || Number(Boolean(a.lastCollectedAt)) - Number(Boolean(b.lastCollectedAt))
        || String(a.lastCollectedAt).localeCompare(String(b.lastCollectedAt))
        || String(a.updatedAt).localeCompare(String(b.updatedAt)))
      .slice(0, limit)
      .map(clone);
    return { items, total: items.length };
  }

  async updateUpTargetStatus(mid, fields = {}) {
    const targetMid = normalizeMid(mid);
    if (!targetMid) throw new Error('invalid_mid');
    const now = fields.updatedAt || new Date().toISOString();
    const current = this.upTargets.get(targetMid) || {
      mid: targetMid,
      name: '',
      seedSource: '',
      seedBvid: '',
      note: '',
      status: 'pending',
      priority: 0,
      createdAt: now,
      updatedAt: now,
      lastCollectedAt: '',
      nextCollectAfter: '',
      lastErrorType: '',
      lastErrorMessage: '',
      failureCount: 0
    };
    const next = { ...current, updatedAt: now };
    for (const key of ['name', 'status', 'lastCollectedAt', 'nextCollectAfter', 'lastErrorType', 'lastErrorMessage', 'failureCount']) {
      if (Object.hasOwn(fields, key)) next[key] = fields[key];
    }
    this.upTargets.set(targetMid, next);
    return clone(next);
  }

  async saveUpProfileSnapshot(profile = {}) {
    const capturedAt = profile.capturedAt || new Date().toISOString();
    const snapshot = { ...clone(profile), capturedAt, id: this.upProfileSnapshots.length + 1 };
    this.upProfileSnapshots.push(snapshot);
    await this.updateUpTargetStatus(snapshot.mid, { name: snapshot.name || '', updatedAt: capturedAt });
    return clone(snapshot);
  }

  async getLatestUpProfileSnapshot(mid) {
    const rows = this.upProfileSnapshots
      .filter((snapshot) => String(snapshot.mid) === String(mid))
      .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)) || Number(b.id || 0) - Number(a.id || 0));
    return clone(rows[0] || null);
  }

  async upsertUpVideo(video = {}) {
    const now = new Date().toISOString();
    const bvid = String(video.bvid || '');
    if (!bvid || !video.mid) throw new Error('invalid_video');
    const current = this.upVideos.get(bvid);
    const next = {
      ...(current || {}),
      ...clone(video),
      bvid,
      mid: String(video.mid),
      firstSeenAt: current && current.firstSeenAt || now,
      lastSeenAt: now
    };
    for (const key of ['viewCount', 'danmakuCount', 'replyCount', 'favoriteCount', 'coinCount', 'shareCount', 'likeCount']) {
      next[key] = Math.max(Number(current && current[key] || 0), Number(video[key] || 0));
    }
    this.upVideos.set(bvid, next);
    return clone(next);
  }

  async saveVideoMetricSnapshot(video = {}) {
    this.videoMetricSnapshots.push({
      bvid: String(video.bvid || ''),
      mid: String(video.mid || ''),
      capturedAt: video.capturedAt || new Date().toISOString(),
      viewCount: Number(video.viewCount || 0),
      danmakuCount: Number(video.danmakuCount || 0),
      replyCount: Number(video.replyCount || 0),
      favoriteCount: Number(video.favoriteCount || 0),
      coinCount: Number(video.coinCount || 0),
      shareCount: Number(video.shareCount || 0),
      likeCount: Number(video.likeCount || 0)
    });
  }

  async listUpVideos(options = {}) {
    const limit = normalizeLimit(options.limit, 500, 50);
    const offset = normalizeOffset(options.offset);
    const includeTotal = options.includeTotal !== false;
    const mid = String(options.mid || '').trim();
    const q = String(options.q || '').trim().toLowerCase();
    const filtered = [...this.upVideos.values()]
      .filter((video) => !mid || String(video.mid) === mid)
      .filter((video) => !q || `${video.bvid} ${video.title || ''} ${video.tname || ''}`.toLowerCase().includes(q))
      .sort((a, b) => getVideoOrderValue(b, options.sort) - getVideoOrderValue(a, options.sort));
    const rows = filtered.slice(offset, offset + limit + (includeTotal ? 0 : 1));
    const items = rows.slice(0, limit).map(clone);
    if (!includeTotal) return { items, hasMore: rows.length > limit };
    return { items, total: filtered.length };
  }

  async listKnownUpBvids(mid, options = {}) {
    const limit = normalizeLimit(options.limit, 500, 50);
    const rows = new Map();
    for (const sample of this.samples.values()) {
      if (String(sample.upMid || '') !== String(mid) || !sample.bvid) continue;
      const current = rows.get(sample.bvid);
      if (!current || String(sample.lastSeenAt || '') > String(current.lastSeenAt || '')) {
        rows.set(sample.bvid, {
          bvid: sample.bvid,
          lastSeenAt: sample.lastSeenAt || '',
          source: 'sample'
        });
      }
    }
    for (const video of this.upVideos.values()) {
      if (String(video.mid || '') !== String(mid) || !video.bvid) continue;
      const current = rows.get(video.bvid);
      if (!current || String(video.lastSeenAt || '') > String(current.lastSeenAt || '')) {
        rows.set(video.bvid, {
          bvid: video.bvid,
          lastSeenAt: video.lastSeenAt || '',
          source: 'up_video'
        });
      }
    }
    const items = [...rows.values()]
      .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
      .slice(0, limit)
      .map(clone);
    return { items, total: rows.size };
  }

  async createCollectorRun(run = {}) {
    const runId = run.runId || createRunId(run.kind || 'collector');
    const item = {
      runId,
      kind: String(run.kind || ''),
      mid: String(run.mid || ''),
      status: String(run.status || 'pending'),
      startedAt: run.startedAt || new Date().toISOString(),
      finishedAt: run.finishedAt || '',
      targetCount: Number(run.targetCount || 0),
      collectedCount: Number(run.collectedCount || 0),
      videoCount: Number(run.videoCount || 0),
      errorType: run.error && run.error.type || run.errorType || '',
      errorMessage: run.error && run.error.message || run.errorMessage || '',
      options: clone(run.options || {})
    };
    this.collectorRuns.set(runId, item);
    return clone(item);
  }

  async updateCollectorRun(runId, fields = {}) {
    const current = this.collectorRuns.get(String(runId));
    if (!current) return null;
    const next = { ...current };
    for (const key of ['status', 'finishedAt', 'targetCount', 'collectedCount', 'videoCount']) {
      if (Object.hasOwn(fields, key)) next[key] = fields[key];
    }
    if (Object.hasOwn(fields, 'error')) {
      next.errorType = fields.error && fields.error.type || '';
      next.errorMessage = fields.error && fields.error.message || '';
    }
    if (Object.hasOwn(fields, 'options')) next.options = clone(fields.options || {});
    this.collectorRuns.set(String(runId), next);
    return clone(next);
  }

  async getCollectorRun(runId) {
    return clone(this.collectorRuns.get(String(runId)) || null);
  }

  async saveUpPortrait(portrait = {}) {
    const llm = portrait.llmPortrait || {};
    const error = portrait.llmError || {};
    const item = {
      mid: String(portrait.mid || ''),
      rulePortrait: clone(portrait.rulePortrait || {}),
      llmPortrait: clone(llm),
      summary: String(llm.summary || ''),
      contentPositioning: String(llm.contentPositioning || ''),
      audienceHypothesis: String(llm.audienceHypothesis || ''),
      contentStyle: String(llm.contentStyle || ''),
      commercialFit: String(llm.commercialFit || ''),
      risks: clone(llm.risks || []),
      evidence: clone(llm.evidence || []),
      provider: String(llm.provider || ''),
      model: String(llm.model || ''),
      promptVersion: String(llm.promptVersion || ''),
      generatedAt: String(llm.generatedAt || ''),
      llmErrorType: String(error.type || ''),
      llmErrorMessage: String(error.message || ''),
      updatedAt: new Date().toISOString()
    };
    this.upPortraits.set(item.mid, item);
    return clone(item);
  }

  async getUpPortrait(mid) {
    return clone(this.upPortraits.get(String(mid)) || null);
  }

  async getUpProfile(mid) {
    const videos = [...this.upVideos.values()].filter((video) => String(video.mid) === String(mid));
    return {
      target: await this.getUpTarget(mid),
      profile: await this.getLatestUpProfileSnapshot(mid),
      videoStats: {
        videoCount: videos.length,
        averageView: videos.length ? videos.reduce((sum, video) => sum + Number(video.viewCount || 0), 0) / videos.length : 0,
        maxView: videos.reduce((max, video) => Math.max(max, Number(video.viewCount || 0)), 0),
        totalView: videos.reduce((sum, video) => sum + Number(video.viewCount || 0), 0)
      },
      portrait: await this.getUpPortrait(mid)
    };
  }

  async listUpProfiles(options = {}) {
    const limit = normalizeLimit(options.limit, 500, 50);
    const offset = normalizeOffset(options.offset);
    const includeTotal = options.includeTotal !== false;
    const q = String(options.q || '').trim().toLowerCase();
    const items = [];
    for (const target of this.upTargets.values()) {
      const profile = await this.getLatestUpProfileSnapshot(target.mid);
      const portrait = await this.getUpPortrait(target.mid);
      const videos = [...this.upVideos.values()].filter((video) => String(video.mid) === String(target.mid));
      const name = profile && profile.name || target.name || '';
      const haystack = `${target.mid} ${name} ${portrait && portrait.summary || ''}`.toLowerCase();
      if (q && !haystack.includes(q)) continue;
      items.push({
        target: clone({ ...target, name }),
        mid: target.mid,
        name,
        face: profile && profile.face || '',
        followerCount: Number(profile && profile.followerCount || 0),
        archiveCount: Number(profile && profile.archiveCount || 0),
        videoCount: videos.length,
        averageView: videos.length ? videos.reduce((sum, video) => sum + Number(video.viewCount || 0), 0) / videos.length : 0,
        maxView: videos.reduce((max, video) => Math.max(max, Number(video.viewCount || 0)), 0),
        summary: portrait && portrait.summary || '',
        portraitUpdatedAt: portrait && portrait.updatedAt || ''
      });
    }
    items.sort((a, b) => String(b.target.updatedAt).localeCompare(String(a.target.updatedAt)));
    const rows = items.slice(offset, offset + limit + (includeTotal ? 0 : 1));
    if (!includeTotal) return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    return { items: rows.slice(0, limit), total: items.length };
  }
}

export { MemoryStorage };
