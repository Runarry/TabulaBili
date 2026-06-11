const DAY_MS = 24 * 60 * 60 * 1000;
const COMMERCIAL_KEYWORDS = [
  '商务', '合作', '赞助', '广告', '推广', '品牌', '抽奖', '福利', '优惠',
  '团购', '课程', '店铺', '链接', '橱窗', '同款', '测评', '开箱'
];
const SERIES_PATTERNS = [
  /第\s*[0-9一二三四五六七八九十百]+\s*[期集话]/i,
  /\b(ep|episode|part|vol)\.?\s*\d+\b/i,
  /[#＃]\s*\d+/,
  /合集|系列|连载|番外|教程\d+/i
];
const STOP_WORDS = new Set([
  '一个', '这个', '那个', '什么', '怎么', '如何', '可以', '真的', '不是', '没有',
  '我们', '你们', '他们', '今天', '视频', '投稿', 'bilibili', '哔哩哔哩'
]);

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function ratio(numerator, denominator) {
  const top = toNumber(numerator);
  const bottom = toNumber(denominator);
  return bottom > 0 ? top / bottom : 0;
}

function median(values) {
  const numbers = values.map(toNumber).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  if (numbers.length % 2) return numbers[middle];
  return (numbers[middle - 1] + numbers[middle]) / 2;
}

function average(values) {
  const numbers = values.map(toNumber);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getVideoPublishedAt(video) {
  const publishedAt = String(video.publishedAt || video.published_at || '').trim();
  if (publishedAt) return publishedAt;
  const pubdate = toNumber(video.pubdate);
  return pubdate > 0 ? new Date(pubdate * 1000).toISOString() : '';
}

function getVideoMs(video) {
  const time = Date.parse(getVideoPublishedAt(video));
  return Number.isFinite(time) ? time : 0;
}

function countBy(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = String(getKey(item) || '').trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

function normalizeTagName(tag) {
  if (typeof tag === 'string') return tag.trim();
  return String(tag && (tag.tagName || tag.tag_name || tag.name) || '').trim();
}

function getVideoTags(video) {
  return parseJsonArray(video.tagsJson || video.tags_json || video.tags)
    .map(normalizeTagName)
    .filter(Boolean);
}

function tokenizeText(text) {
  return String(text || '')
    .toLowerCase()
    .match(/[\u4e00-\u9fa5]{2,8}|[a-z0-9][a-z0-9_-]{1,24}/g) || [];
}

function topKeywords(videos, limit = 20) {
  const counts = new Map();
  for (const video of videos) {
    const tokens = [
      ...tokenizeText(video.title),
      ...getVideoTags(video).map((tag) => tag.toLowerCase())
    ];
    for (const token of tokens) {
      if (STOP_WORDS.has(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit);
}

function getMainCategory(videos) {
  const categories = countBy(videos, (video) => video.tname || video.category || video.typename);
  return categories[0] || { key: '', count: 0 };
}

function getPublishFrequency(videos, nowMs) {
  const times = videos.map(getVideoMs).filter(Boolean).sort((a, b) => a - b);
  const recent90 = times.filter((time) => nowMs - time <= 90 * DAY_MS);
  const intervals = [];
  for (let index = 1; index < times.length; index += 1) {
    intervals.push((times[index] - times[index - 1]) / DAY_MS);
  }
  return {
    videosPerWeek90d: recent90.length / (90 / 7),
    averageIntervalDays: average(intervals),
    medianIntervalDays: median(intervals)
  };
}

function getActiveCounts(videos, nowMs) {
  const counts = { last7d: 0, last30d: 0, last90d: 0 };
  for (const video of videos) {
    const time = getVideoMs(video);
    if (!time) continue;
    const age = nowMs - time;
    if (age <= 7 * DAY_MS) counts.last7d += 1;
    if (age <= 30 * DAY_MS) counts.last30d += 1;
    if (age <= 90 * DAY_MS) counts.last90d += 1;
  }
  return counts;
}

function getInteractionMetrics(videos) {
  const totals = videos.reduce((sum, video) => ({
    views: sum.views + toNumber(video.viewCount || video.statView),
    likes: sum.likes + toNumber(video.likeCount || video.statLike),
    coins: sum.coins + toNumber(video.coinCount || video.statCoin),
    favorites: sum.favorites + toNumber(video.favoriteCount || video.statFavorite),
    replies: sum.replies + toNumber(video.replyCount || video.statReply),
    danmaku: sum.danmaku + toNumber(video.danmakuCount || video.statDanmaku),
    shares: sum.shares + toNumber(video.shareCount || video.statShare)
  }), {
    views: 0,
    likes: 0,
    coins: 0,
    favorites: 0,
    replies: 0,
    danmaku: 0,
    shares: 0
  });

  return {
    likeRate: ratio(totals.likes, totals.views),
    coinRate: ratio(totals.coins, totals.views),
    favoriteRate: ratio(totals.favorites, totals.views),
    replyRate: ratio(totals.replies, totals.views),
    danmakuRate: ratio(totals.danmaku, totals.views),
    shareRate: ratio(totals.shares, totals.views),
    totals
  };
}

function getSeriesSignal(videos) {
  let patternCount = 0;
  const prefixCounts = new Map();
  for (const video of videos) {
    const title = String(video.title || '');
    if (SERIES_PATTERNS.some((pattern) => pattern.test(title))) patternCount += 1;
    const prefix = title
      .replace(/[【\[][^】\]]+[】\]]/g, '')
      .replace(/[0-9一二三四五六七八九十百]+/g, '')
      .slice(0, 8)
      .trim();
    if (prefix.length >= 3) prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
  }
  const repeatedPrefixCount = [...prefixCounts.values()].filter((count) => count >= 3).reduce((sum, count) => sum + count, 0);
  return {
    seriesVideoRatio: ratio(patternCount + repeatedPrefixCount, videos.length),
    patternCount,
    repeatedPrefixCount
  };
}

function getCommercialSignal(videos) {
  const hits = [];
  for (const video of videos) {
    const text = `${video.title || ''} ${video.description || video.desc || ''}`;
    const matched = COMMERCIAL_KEYWORDS.filter((keyword) => text.includes(keyword));
    if (matched.length) {
      hits.push({
        bvid: video.bvid,
        title: video.title || '',
        keywords: [...new Set(matched)]
      });
    }
  }
  return {
    hasCommercialClues: hits.length > 0,
    commercialVideoRatio: ratio(hits.length, videos.length),
    examples: hits.slice(0, 5)
  };
}

function buildRulePortrait({ profile = null, videos = [], now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const sortedVideos = [...videos].sort((a, b) => getVideoMs(b) - getVideoMs(a));
  const viewCounts = sortedVideos.map((video) => toNumber(video.viewCount || video.statView));
  const medianView = median(viewCounts);
  const averageView = average(viewCounts);
  const viralThreshold = Math.max(100000, medianView * 3);
  const viralCount = viewCounts.filter((value) => value >= viralThreshold && value > 0).length;
  const mainCategory = getMainCategory(sortedVideos);
  const tagRows = countBy(sortedVideos.flatMap(getVideoTags), (tag) => tag).slice(0, 20);
  const keywords = topKeywords(sortedVideos);
  const interaction = getInteractionMetrics(sortedVideos);
  const activeCounts = getActiveCounts(sortedVideos, safeNowMs);
  const publishFrequency = getPublishFrequency(sortedVideos, safeNowMs);
  const series = getSeriesSignal(sortedVideos);
  const commercial = getCommercialSignal(sortedVideos);
  const latestVideo = sortedVideos[0] || null;

  return {
    version: 1,
    generatedAt: new Date(safeNowMs).toISOString(),
    mid: String(profile && profile.mid || sortedVideos[0] && sortedVideos[0].mid || ''),
    name: String(profile && profile.name || ''),
    videoCount: sortedVideos.length,
    mainCategory: mainCategory.key,
    categoryDistribution: countBy(sortedVideos, (video) => video.tname || video.category || video.typename).slice(0, 10),
    topTags: tagRows,
    keywords,
    activity: {
      latestPublishedAt: latestVideo ? getVideoPublishedAt(latestVideo) : '',
      ...activeCounts,
      ...publishFrequency
    },
    performance: {
      medianView,
      averageView,
      viralThreshold,
      viralCount,
      viralRate: ratio(viralCount, sortedVideos.length)
    },
    interaction: {
      likeRate: interaction.likeRate,
      coinRate: interaction.coinRate,
      favoriteRate: interaction.favoriteRate,
      replyRate: interaction.replyRate,
      danmakuRate: interaction.danmakuRate,
      shareRate: interaction.shareRate
    },
    series,
    commercial,
    evidence: [
      mainCategory.key ? `主分区 ${mainCategory.key}，样本 ${mainCategory.count} 条` : '',
      sortedVideos.length ? `样本视频 ${sortedVideos.length} 条，中位播放 ${Math.round(medianView)}` : '',
      keywords[0] ? `高频关键词：${keywords.slice(0, 5).map((item) => item.key).join('、')}` : '',
      commercial.hasCommercialClues ? `检测到 ${commercial.examples.length} 条商业合作关键词样例` : ''
    ].filter(Boolean)
  };
}

export {
  buildRulePortrait,
  median,
  ratio,
  topKeywords
};
