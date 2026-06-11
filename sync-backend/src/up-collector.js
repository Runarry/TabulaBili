import { BiliApiError, BilibiliClient } from './bilibili-client.js';
import { buildRulePortrait } from './up-portrait-rules.js';

const DEFAULT_COLLECT_OPTIONS = {
  maxTargets: 1,
  includeArchives: false,
  includeKnownVideos: true,
  maxPages: 0,
  existingMaxPages: 0,
  pageSize: 5,
  maxVideos: 20,
  requestIntervalMs: 3000,
  successRefreshHours: 24
};

const RETRY_BASE_MS = {
  rate_limited: 30 * 60 * 1000,
  http_429: 30 * 60 * 1000,
  risk_control: 6 * 60 * 60 * 1000,
  timeout: 10 * 60 * 1000,
  network: 10 * 60 * 1000,
  server_error: 20 * 60 * 1000,
  business_error: 60 * 60 * 1000,
  unknown: 30 * 60 * 1000
};

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeCollectOptions(options = {}) {
  const merged = { ...DEFAULT_COLLECT_OPTIONS, ...options };
  return {
    maxTargets: clampInt(merged.maxTargets, 1, 50),
    includeArchives: normalizeBoolean(merged.includeArchives, DEFAULT_COLLECT_OPTIONS.includeArchives),
    includeKnownVideos: normalizeBoolean(merged.includeKnownVideos, DEFAULT_COLLECT_OPTIONS.includeKnownVideos),
    maxPages: clampInt(merged.maxPages, 0, 10),
    existingMaxPages: clampInt(merged.existingMaxPages, 0, 10),
    pageSize: clampInt(merged.pageSize, 1, 50),
    maxVideos: clampInt(merged.maxVideos, 1, 200),
    requestIntervalMs: Math.max(0, Number(merged.requestIntervalMs || 0)),
    successRefreshHours: Math.max(1, Number(merged.successRefreshHours || 24))
  };
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === false) return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function clampInt(value, min, max) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function addHours(date, hours) {
  return new Date(date.getTime() + Number(hours || 0) * 60 * 60 * 1000).toISOString();
}

function compactError(error) {
  const source = error || {};
  return {
    type: source.type || (source instanceof BiliApiError ? 'bili_error' : 'unknown'),
    message: String(source.message || source || 'unknown error').slice(0, 1000),
    code: source.code ?? null,
    status: source.status ?? 0,
    retryable: source.retryable !== false,
    endpoint: String(source.endpoint || ''),
    hint: String(source.hint || '')
  };
}

function getBackoffAt(error, failureCount, now = new Date()) {
  const info = compactError(error);
  const base = RETRY_BASE_MS[info.type] || RETRY_BASE_MS.unknown;
  const multiplier = Math.min(32, 2 ** Math.max(0, Number(failureCount || 0)));
  const jitter = Math.trunc(base * 0.1);
  const delay = Math.min(24 * 60 * 60 * 1000, base * multiplier + jitter);
  return new Date(now.getTime() + delay).toISOString();
}

function normalizeProfile({ mid, cardData, relationData, navData, capturedAt = nowIso() }) {
  const card = cardData && cardData.card || {};
  const official = card.Official || card.official || {};
  const level = card.level_info || card.levelInfo || {};
  const vip = card.vip || {};
  return {
    mid: String(card.mid || mid || ''),
    name: String(card.name || ''),
    face: String(card.face || ''),
    sign: String(card.sign || ''),
    level: Number(level.current_level || level.currentLevel || 0),
    officialType: Number(official.type || 0),
    officialTitle: String(official.title || official.desc || ''),
    vipType: Number(vip.type || 0),
    vipStatus: Number(vip.status || 0),
    followerCount: Number(
      relationData && relationData.follower
      || cardData && cardData.follower
      || 0
    ),
    followingCount: Number(
      relationData && relationData.following
      || cardData && cardData.following
      || 0
    ),
    archiveCount: Number(navData && (navData.video || navData.archive_count) || cardData && cardData.archive_count || 0),
    articleCount: Number(navData && navData.article || cardData && cardData.article_count || 0),
    albumCount: Number(navData && navData.album || 0),
    favoriteCount: Number(navData && (navData.favourite || navData.favorite) || 0),
    likeCount: Number(cardData && cardData.like_num || 0),
    capturedAt,
    cardJson: cardData || {},
    relationJson: relationData || {},
    navJson: navData || {}
  };
}

function archiveItems(data) {
  const list = data && data.list && data.list.vlist;
  return Array.isArray(list) ? list : [];
}

function normalizeArchiveVideo(item, mid) {
  const pubdate = Number(item.created || item.pubdate || 0);
  return {
    bvid: String(item.bvid || ''),
    aid: String(item.aid || ''),
    mid: String(item.mid || mid || ''),
    title: String(item.title || ''),
    description: String(item.description || ''),
    coverUrl: String(item.pic || ''),
    tname: String(item.typename || item.tname || ''),
    tid: Number(item.typeid || item.tid || 0),
    duration: Number(item.duration || 0),
    pubdate,
    publishedAt: pubdate > 0 ? new Date(pubdate * 1000).toISOString() : '',
    ownerName: String(item.author || ''),
    viewCount: Number(item.play || 0),
    danmakuCount: Number(item.video_review || 0),
    replyCount: Number(item.comment || item.review || 0),
    favoriteCount: Number(item.favorites || 0),
    likeCount: 0,
    coinCount: 0,
    shareCount: 0,
    tags: [],
    rawJson: item
  };
}

function normalizeViewVideo(view, tags = []) {
  const stat = view && view.stat || {};
  const owner = view && view.owner || {};
  const pubdate = Number(view && view.pubdate || 0);
  return {
    bvid: String(view && view.bvid || ''),
    aid: String(view && view.aid || ''),
    mid: String(owner.mid || ''),
    title: String(view && view.title || ''),
    description: String(view && (view.desc || view.description) || ''),
    coverUrl: String(view && view.pic || ''),
    tname: String(view && view.tname || ''),
    tid: Number(view && view.tid || 0),
    duration: Number(view && view.duration || 0),
    pubdate,
    publishedAt: pubdate > 0 ? new Date(pubdate * 1000).toISOString() : '',
    ownerName: String(owner.name || ''),
    copyright: Number(view && view.copyright || 0),
    videos: Number(view && view.videos || 0),
    viewCount: Number(stat.view || 0),
    danmakuCount: Number(stat.danmaku || 0),
    replyCount: Number(stat.reply || 0),
    favoriteCount: Number(stat.favorite || 0),
    coinCount: Number(stat.coin || 0),
    shareCount: Number(stat.share || 0),
    likeCount: Number(stat.like || 0),
    tags,
    pages: Array.isArray(view && view.pages) ? view.pages : [],
    rawJson: view || {}
  };
}

function normalizeTags(data) {
  const rows = Array.isArray(data) ? data : [];
  return rows.map((item) => ({
    tagId: String(item.tag_id || item.tagId || ''),
    tagName: String(item.tag_name || item.tagName || item.name || '')
  })).filter((item) => item.tagName);
}

function normalizeSeedBvids(value) {
  const rows = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,，;；]+/);
  return rows
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      return String(item && item.bvid || '').trim();
    })
    .filter(Boolean);
}

class UpCollector {
  constructor(options = {}) {
    if (!options.storage) throw new Error('storage is required');
    this.storage = options.storage;
    this.client = options.client || new BilibiliClient(options.bilibili || {});
  }

  async throttle(options) {
    await sleep(Number(options.requestIntervalMs || 0));
  }

  async runBatch(options = {}) {
    const collectOptions = normalizeCollectOptions(options);
    const run = await this.storage.createCollectorRun({
      kind: 'batch',
      status: 'running',
      options: collectOptions,
      startedAt: nowIso()
    });
    const results = [];
    let status = 'succeeded';
    try {
      const targets = await this.storage.listDueUpTargets({
        limit: collectOptions.maxTargets,
        now: nowIso()
      });
      for (const target of targets.items || []) {
        try {
          const result = await this.collectMid(target.mid, {
            ...collectOptions,
            createRun: true
          });
          if (result.ok === false || result.status !== 'succeeded') status = 'partial_failed';
          results.push(result);
        } catch (error) {
          status = 'partial_failed';
          results.push({ mid: target.mid, ok: false, error: compactError(error) });
        }
      }
      const updatedRun = await this.storage.updateCollectorRun(run.runId, {
        status,
        finishedAt: nowIso(),
        targetCount: (targets.items || []).length,
        collectedCount: results.filter((item) => item.ok !== false).length,
        videoCount: results.reduce((sum, item) => sum + Number(item.videoCount || 0), 0)
      });
      return { run: updatedRun, results };
    } catch (error) {
      await this.storage.updateCollectorRun(run.runId, {
        status: 'failed',
        finishedAt: nowIso(),
        error: compactError(error)
      });
      throw error;
    }
  }

  async collectMid(mid, options = {}) {
    const collectOptions = normalizeCollectOptions(options);
    const startedAt = nowIso();
    const targetMid = String(mid || '').trim();
    const run = options.createRun === false ? null : await this.storage.createCollectorRun({
      kind: 'up_collect',
      mid: targetMid,
      status: 'running',
      startedAt,
      options: collectOptions
    });
    await this.storage.updateUpTargetStatus(targetMid, {
      status: 'running',
      updatedAt: startedAt
    });

    try {
      const target = await this.storage.getUpTarget(targetMid);
      const known = Boolean(target && target.lastCollectedAt);
      const capturedAt = nowIso();
      const cardData = await this.client.fetchUpCard(targetMid);
      await this.throttle(collectOptions);
      const relationData = await this.client.fetchRelationStat(targetMid);
      await this.throttle(collectOptions);
      const navData = await this.client.fetchNavNum(targetMid);
      const profile = normalizeProfile({ mid: targetMid, cardData, relationData, navData, capturedAt });
      await this.storage.saveUpProfileSnapshot(profile);

      let videoCount = 0;
      let pagesFetched = 0;
      const stageErrors = [];
      const bvids = new Set();

      for (const bvid of normalizeSeedBvids(target && target.seedBvid)) {
        if (bvids.size >= collectOptions.maxVideos) break;
        bvids.add(bvid);
      }

      if (collectOptions.includeKnownVideos && bvids.size < collectOptions.maxVideos && typeof this.storage.listKnownUpBvids === 'function') {
        const knownBvids = await this.storage.listKnownUpBvids(targetMid, {
          limit: collectOptions.maxVideos - bvids.size
        });
        for (const item of knownBvids.items || []) {
          if (bvids.size >= collectOptions.maxVideos) break;
          const bvid = String(item && item.bvid || item || '').trim();
          if (bvid) bvids.add(bvid);
        }
      }

      const maxPages = collectOptions.includeArchives
        ? (known ? collectOptions.existingMaxPages : collectOptions.maxPages)
        : 0;
      for (let page = 1; page <= maxPages && bvids.size < collectOptions.maxVideos; page += 1) {
        try {
          await this.throttle(collectOptions);
          const pageSize = Math.min(collectOptions.pageSize, collectOptions.maxVideos - bvids.size);
          const archive = await this.client.fetchArchivePage(targetMid, page, pageSize);
          pagesFetched += 1;
          const items = archiveItems(archive);
          if (!items.length) break;
          for (const item of items) {
            if (bvids.size >= collectOptions.maxVideos) break;
            const archiveVideo = normalizeArchiveVideo(item, targetMid);
            if (!archiveVideo.bvid || bvids.has(archiveVideo.bvid)) continue;
            bvids.add(archiveVideo.bvid);
            await this.storage.upsertUpVideo(archiveVideo);
          }
          if (items.length < pageSize) break;
        } catch (error) {
          stageErrors.push({ stage: 'archive', error: compactError(error) });
          break;
        }
      }

      const videoErrors = [];
      for (const bvid of bvids) {
        try {
          await this.throttle(collectOptions);
          const view = await this.client.fetchVideoView(bvid);
          await this.throttle(collectOptions);
          let tags = [];
          try {
            tags = normalizeTags(await this.client.fetchVideoTags(bvid));
          } catch (error) {
            videoErrors.push({ bvid, stage: 'tags', error: compactError(error) });
          }
          const video = normalizeViewVideo(view, tags);
          if (video.mid && video.mid !== targetMid) {
            videoErrors.push({
              bvid,
              stage: 'view',
              error: {
                type: 'up_mismatch',
                message: `视频 ${bvid} 属于 UP ${video.mid}，不是目标 UP ${targetMid}`,
                retryable: false,
                code: null,
                status: 0,
                endpoint: '/x/web-interface/view',
                hint: ''
              }
            });
            continue;
          }
          video.mid = targetMid;
          await this.storage.upsertUpVideo(video);
          await this.storage.saveVideoMetricSnapshot(video);
          videoCount += 1;
        } catch (error) {
          videoErrors.push({ bvid, stage: 'view', error: compactError(error) });
        }
      }
      stageErrors.push(...videoErrors);

      const partial = stageErrors.length > 0;
      const status = partial ? 'partial' : 'succeeded';
      const failureCount = partial ? Number(target && target.failureCount || 0) + 1 : 0;
      const error = stageErrors[0] && stageErrors[0].error;
      await this.storage.updateUpTargetStatus(targetMid, {
        status: partial ? 'partial' : 'ready',
        name: profile.name,
        lastCollectedAt: nowIso(),
        nextCollectAfter: partial
          ? getBackoffAt(error, failureCount)
          : addHours(new Date(), collectOptions.successRefreshHours),
        lastErrorType: partial ? error.type : '',
        lastErrorMessage: partial ? error.message : '',
        failureCount,
        updatedAt: nowIso()
      });
      if (run) {
        await this.storage.updateCollectorRun(run.runId, {
          status,
          finishedAt: nowIso(),
          targetCount: 1,
          collectedCount: 1,
          videoCount,
          error: partial ? error : null,
          options: {
            ...collectOptions,
            pagesFetched,
            stageErrors,
            seedBvidCount: bvids.size
          }
        });
      }
      return {
        ok: true,
        partial,
        mid: targetMid,
        runId: run && run.runId,
        status,
        profile,
        pagesFetched,
        videoCount,
        error: partial ? error : null,
        stageErrors,
        videoErrors
      };
    } catch (error) {
      const target = await this.storage.getUpTarget(targetMid);
      const info = compactError(error);
      const failureCount = Number(target && target.failureCount || 0) + 1;
      await this.storage.updateUpTargetStatus(targetMid, {
        status: 'backoff',
        nextCollectAfter: getBackoffAt(info, failureCount),
        lastErrorType: info.type,
        lastErrorMessage: info.message,
        failureCount,
        updatedAt: nowIso()
      });
      if (run) {
        await this.storage.updateCollectorRun(run.runId, {
          status: 'failed',
          finishedAt: nowIso(),
          targetCount: 1,
          collectedCount: 0,
          videoCount: 0,
          error: info
        });
      }
      throw error;
    }
  }
}

async function generateUpPortrait({ storage, mid, llmProvider, now = new Date() }) {
  const profile = await storage.getLatestUpProfileSnapshot(mid);
  const videosResult = await storage.listUpVideos({ mid, limit: 100, includeTotal: false, sort: 'pubdate' });
  const videos = videosResult.items || [];
  const rulePortrait = buildRulePortrait({ profile, videos, now });
  try {
    const llmPortrait = await llmProvider.generatePortrait({
      profile,
      videos,
      rulePortrait
    });
    const saved = await storage.saveUpPortrait({
      mid: String(mid),
      rulePortrait,
      llmPortrait,
      llmError: null
    });
    return { ok: true, portrait: saved };
  } catch (error) {
    const info = {
      type: error && error.type || 'llm_error',
      message: String(error && error.message || error || 'LLM error').slice(0, 1000),
      status: error && error.status || 0
    };
    const saved = await storage.saveUpPortrait({
      mid: String(mid),
      rulePortrait,
      llmPortrait: null,
      llmError: info
    });
    return { ok: false, error: info, portrait: saved };
  }
}

export {
  DEFAULT_COLLECT_OPTIONS,
  UpCollector,
  compactError,
  generateUpPortrait,
  getBackoffAt,
  normalizeArchiveVideo,
  normalizeCollectOptions,
  normalizeProfile,
  normalizeTags,
  normalizeViewVideo
};
