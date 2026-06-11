import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BiliApiError, BilibiliClient } from '../src/bilibili-client.js';
import { OpenAICompatibleProvider } from '../src/llm-provider.js';
import { createApp } from '../src/router.js';
import { MemoryStorage } from '../src/storage/memory.js';
import { UpCollector, generateUpPortrait } from '../src/up-collector.js';
import { buildRulePortrait } from '../src/up-portrait-rules.js';

let SqliteStorage = null;
let sqliteSkip = false;
try {
  ({ SqliteStorage } = await import('../src/storage/sqlite.js'));
} catch (error) {
  if (error && error.code === 'ERR_MODULE_NOT_FOUND') sqliteSkip = 'better-sqlite3 unavailable';
  else throw error;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function makeFakeBiliClient() {
  return {
    async fetchUpCard(mid) {
      return {
        card: {
          mid,
          name: '测试UP',
          face: 'https://example.test/face.jpg',
          sign: '公开签名',
          level_info: { current_level: 6 },
          Official: { type: 0, title: '' },
          vip: { type: 2, status: 1 }
        },
        follower: 1000,
        following: 12,
        archive_count: 2,
        like_num: 3000
      };
    },
    async fetchRelationStat() {
      return { follower: 1200, following: 15 };
    },
    async fetchNavNum() {
      return { video: 2, article: 1, album: 0, favourite: 5 };
    },
    async fetchArchivePage(mid) {
      return {
        list: {
          vlist: [
            { bvid: 'BV_FAKE_1', aid: 1, mid, title: 'AI工具教程 第1期', created: 1780000000, typename: '科技', play: 100, video_review: 2 },
            { bvid: 'BV_FAKE_2', aid: 2, mid, title: 'AI工具教程 第2期', created: 1780100000, typename: '科技', play: 200, video_review: 4 }
          ]
        }
      };
    },
    async fetchVideoView(bvid) {
      const index = bvid.endsWith('_2') ? 2 : 1;
      return {
        bvid,
        aid: index,
        title: `AI工具教程 第${index}期`,
        desc: index === 2 ? '商务合作请联系' : '公开简介',
        tname: '科技',
        tid: 36,
        pubdate: 1780000000 + index * 10000,
        duration: 300,
        owner: { mid: '42', name: '测试UP' },
        stat: {
          view: index * 1000,
          danmaku: index * 10,
          reply: index * 5,
          favorite: index * 20,
          coin: index * 15,
          share: index,
          like: index * 80
        },
        pages: []
      };
    },
    async fetchVideoTags() {
      return [
        { tag_id: 1, tag_name: 'AI' },
        { tag_id: 2, tag_name: '教程' }
      ];
    }
  };
}

test('Bilibili client unwraps successful responses and classifies API failures', async () => {
  const okClient = new BilibiliClient({
    fetcher: async (url) => {
      assert.match(String(url), /\/x\/web-interface\/card\?mid=42$/);
      return jsonResponse({ code: 0, data: { card: { mid: '42' } } });
    },
    timeoutMs: 100
  });
  assert.deepEqual(await okClient.fetchUpCard('42'), { card: { mid: '42' } });

  const limitedClient = new BilibiliClient({
    fetcher: async () => jsonResponse({ code: -799, message: '请求过于频繁' }),
    timeoutMs: 100
  });
  await assert.rejects(
    () => limitedClient.fetchArchivePage('42', 1, 30),
    (error) => error instanceof BiliApiError && error.type === 'rate_limited' && error.retryable === true
  );

  const riskClient = new BilibiliClient({
    fetcher: async () => new Response('<html>blocked</html>', { status: 412 }),
    timeoutMs: 100
  });
  await assert.rejects(
    () => riskClient.fetchUpCard('42'),
    (error) =>
      error instanceof BiliApiError
      && error.type === 'risk_control'
      && error.status === 412
      && /风控/.test(error.message)
      && /退避/.test(error.hint)
  );

  const networkClient = new BilibiliClient({
    fetcher: async () => {
      throw new Error('offline');
    },
    timeoutMs: 100
  });
  await assert.rejects(
    () => networkClient.fetchVideoView('BV1'),
    (error) => error instanceof BiliApiError && error.type === 'network'
  );
});

test('UP target import deduplicates UIDs', async () => {
  const storage = new MemoryStorage();
  const result = await storage.importUpTargets(['42', '42', 'bad', ' 43 '], { source: 'test' });
  assert.equal(result.imported, 2);
  assert.equal(result.existing, 0);
  assert.equal(result.skipped, 2);

  const duplicate = await storage.importUpTargets(['42'], { source: 'test' });
  assert.equal(duplicate.imported, 0);
  assert.equal(duplicate.existing, 1);
  assert.equal((await storage.listUpTargets()).total, 2);
});

test('SQLite storage initializes UP portrait schema and persists facts', { skip: sqliteSkip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabulabili-up-'));
  const storage = new SqliteStorage(join(dir, 'test.db'));
  try {
    await storage.importUpTargets(['42']);
    await storage.saveUpProfileSnapshot({ mid: '42', name: '测试UP', capturedAt: '2026-06-01T00:00:00.000Z' });
    await storage.upsertUpVideo({
      bvid: 'BV_SQLITE',
      mid: '42',
      title: 'SQLite 测试视频',
      tname: '科技',
      publishedAt: '2026-06-01T00:00:00.000Z',
      viewCount: 123
    });
    await storage.saveUpPortrait({
      mid: '42',
      rulePortrait: { mainCategory: '科技' },
      llmPortrait: { summary: '摘要', provider: 'mock', model: 'm' }
    });

    const profile = await storage.getUpProfile('42');
    assert.equal(profile.profile.name, '测试UP');
    assert.equal(profile.videoStats.videoCount, 1);
    assert.equal(profile.portrait.summary, '摘要');
  } finally {
    storage.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collector records status transitions and stores profile/video facts', async () => {
  const storage = new MemoryStorage();
  await storage.importUpTargets(['42'], { source: 'test' });
  const collector = new UpCollector({
    storage,
    client: makeFakeBiliClient()
  });

  const result = await collector.collectMid('42', {
    includeArchives: true,
    maxPages: 1,
    maxVideos: 2,
    requestIntervalMs: 0
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.videoCount, 2);
  const target = await storage.getUpTarget('42');
  assert.equal(target.status, 'ready');
  assert.equal(target.failureCount, 0);
  assert.equal(target.name, '测试UP');
  const profile = await storage.getLatestUpProfileSnapshot('42');
  assert.equal(profile.followerCount, 1200);
  const videos = await storage.listUpVideos({ mid: '42' });
  assert.equal(videos.total, 2);
  assert.equal(videos.items[0].tags[0].tagName, 'AI');
  const run = await storage.getCollectorRun(result.runId);
  assert.equal(run.status, 'succeeded');
});

test('collector defaults to known BVID seeds and skips archive search', async () => {
  const storage = new MemoryStorage();
  await storage.importUpTargets(['42'], { source: 'test' });
  await storage.saveReportBatch({
    batchId: 'seed-batch',
    clientId: 'c1',
    capturedAt: '2026-06-01T00:00:00.000Z',
    events: [
      {
        eventId: 'seed-e1',
        id: 'BV_SEED_1',
        bvid: 'BV_SEED_1',
        title: '已知视频',
        upName: '测试UP',
        upMid: '42',
        capturedAt: '2026-06-01T00:00:00.000Z'
      }
    ]
  });
  let archiveCalls = 0;
  const collector = new UpCollector({
    storage,
    client: {
      async fetchUpCard(mid) {
        return { card: { mid, name: '测试UP' }, follower: 10 };
      },
      async fetchRelationStat() {
        return { follower: 10, following: 1 };
      },
      async fetchNavNum() {
        return { video: 1 };
      },
      async fetchArchivePage() {
        archiveCalls += 1;
        throw new Error('archive should not be called by default');
      },
      async fetchVideoView(bvid) {
        return {
          bvid,
          aid: 1,
          title: '已知视频',
          desc: '',
          tname: '科技',
          tid: 36,
          pubdate: 1780000000,
          owner: { mid: '42', name: '测试UP' },
          stat: {
            view: 1000,
            danmaku: 1,
            reply: 2,
            favorite: 3,
            coin: 4,
            share: 5,
            like: 6
          }
        };
      },
      async fetchVideoTags() {
        return [{ tag_id: 1, tag_name: '种子' }];
      }
    }
  });

  const result = await collector.collectMid('42', {
    maxVideos: 1,
    requestIntervalMs: 0
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.videoCount, 1);
  assert.equal(archiveCalls, 0);
  const videos = await storage.listUpVideos({ mid: '42' });
  assert.equal(videos.total, 1);
  assert.equal(videos.items[0].bvid, 'BV_SEED_1');
  const target = await storage.getUpTarget('42');
  assert.equal(target.status, 'ready');
});

test('batch collector marks run partial when archive enhancement fails', async () => {
  const storage = new MemoryStorage();
  await storage.importUpTargets(['42'], { source: 'test' });
  const collector = new UpCollector({
    storage,
    client: {
      async fetchUpCard(mid) {
        return { card: { mid, name: '测试UP' } };
      },
      async fetchRelationStat() {
        return { follower: 1, following: 0 };
      },
      async fetchNavNum() {
        return { video: 1 };
      },
      async fetchArchivePage() {
        throw new BiliApiError('B站风控拦截（HTTP 412）', {
          status: 412,
          type: 'risk_control',
          endpoint: '/x/space/arc/search'
        });
      }
    }
  });

  const result = await collector.runBatch({
    maxTargets: 1,
    includeArchives: true,
    maxPages: 1,
    maxVideos: 1,
    requestIntervalMs: 0
  });

  assert.equal(result.run.status, 'partial_failed');
  assert.equal(result.run.targetCount, 1);
  assert.equal(result.run.collectedCount, 1);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].partial, true);
  assert.equal(result.results[0].error.type, 'risk_control');
  const target = await storage.getUpTarget('42');
  assert.equal(target.status, 'partial');
});

test('rule portrait calculates median, activity and interaction rates', () => {
  const now = new Date('2026-06-11T00:00:00.000Z');
  const portrait = buildRulePortrait({
    now,
    profile: { mid: '42', name: '测试UP' },
    videos: [
      {
        bvid: 'BV1',
        mid: '42',
        title: 'AI工具教程 第1期',
        description: '',
        tname: '科技',
        publishedAt: '2026-06-10T00:00:00.000Z',
        viewCount: 100,
        likeCount: 10,
        coinCount: 5,
        favoriteCount: 4,
        replyCount: 2,
        danmakuCount: 1,
        shareCount: 1,
        tags: [{ tagName: 'AI' }]
      },
      {
        bvid: 'BV2',
        mid: '42',
        title: 'AI工具教程 第2期 商务合作',
        description: '品牌合作',
        tname: '科技',
        publishedAt: '2026-06-01T00:00:00.000Z',
        viewCount: 300,
        likeCount: 30,
        coinCount: 15,
        favoriteCount: 6,
        replyCount: 3,
        danmakuCount: 2,
        shareCount: 2,
        tags: [{ tagName: '教程' }]
      }
    ]
  });

  assert.equal(portrait.mainCategory, '科技');
  assert.equal(portrait.performance.medianView, 200);
  assert.equal(portrait.activity.last7d, 1);
  assert.equal(portrait.activity.last30d, 2);
  assert.equal(portrait.interaction.likeRate, 0.1);
  assert.equal(portrait.commercial.hasCommercialClues, true);
  assert.ok(portrait.series.seriesVideoRatio > 0);
});

test('OpenAI-compatible LLM provider builds request and parses portrait JSON', async () => {
  let captured = null;
  const provider = new OpenAICompatibleProvider({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'key',
    model: 'deepseek-chat',
    timeoutMs: 100,
    fetcher: async (url, init) => {
      captured = { url: String(url), init };
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: '稳定科技教程 UP',
                contentPositioning: 'AI 工具教程',
                audienceHypothesis: '推断受众为效率工具用户',
                contentStyle: '系列化',
                commercialFit: 'SaaS 工具',
                risks: ['样本有限'],
                evidence: ['科技分区占比高']
              })
            }
          }
        ]
      });
    }
  });

  const result = await provider.generatePortrait({
    profile: { mid: '42' },
    videos: [],
    rulePortrait: { mainCategory: '科技' }
  });
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(JSON.parse(captured.init.body).model, 'deepseek-chat');
  assert.equal(result.summary, '稳定科技教程 UP');
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, 'deepseek-chat');

  const failingProvider = new OpenAICompatibleProvider({
    baseUrl: 'https://llm.example/v1',
    apiKey: 'key',
    model: 'm',
    fetcher: async () => jsonResponse({ error: { message: 'bad' } }, 500)
  });
  await assert.rejects(() => failingProvider.generatePortrait({}), /LLM HTTP 500/);
});

test('portrait generation records LLM failures without deleting rule portrait', async () => {
  const storage = new MemoryStorage();
  await storage.importUpTargets(['42']);
  await storage.saveUpProfileSnapshot({ mid: '42', name: '测试UP', capturedAt: '2026-06-01T00:00:00.000Z' });
  await storage.upsertUpVideo({
    bvid: 'BV1',
    mid: '42',
    title: 'AI工具教程',
    tname: '科技',
    publishedAt: '2026-06-01T00:00:00.000Z',
    viewCount: 100
  });

  const result = await generateUpPortrait({
    storage,
    mid: '42',
    llmProvider: {
      async generatePortrait() {
        throw Object.assign(new Error('provider down'), { type: 'network', status: 503 });
      }
    },
    now: new Date('2026-06-11T00:00:00.000Z')
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'network');
  const portrait = await storage.getUpPortrait('42');
  assert.equal(portrait.rulePortrait.mainCategory, '科技');
  assert.equal(portrait.llmErrorType, 'network');
});

test('UP portrait API requires auth and returns basic structures', async () => {
  const storage = new MemoryStorage();
  await storage.importUpTargets(['42']);
  await storage.saveUpProfileSnapshot({ mid: '42', name: '测试UP', capturedAt: '2026-06-01T00:00:00.000Z' });
  await storage.upsertUpVideo({
    bvid: 'BV1',
    mid: '42',
    title: 'AI工具教程',
    tname: '科技',
    publishedAt: '2026-06-01T00:00:00.000Z',
    viewCount: 100
  });
  const app = createApp({
    secret: 'secret',
    storage,
    llmProvider: {
      async generatePortrait() {
        return {
          summary: '科技教程 UP',
          contentPositioning: 'AI 教程',
          audienceHypothesis: '推断受众为工具用户',
          contentStyle: '清晰',
          commercialFit: '效率工具',
          risks: ['样本少'],
          evidence: ['科技分区'],
          provider: 'mock',
          model: 'mock-model',
          promptVersion: 'test',
          generatedAt: '2026-06-11T00:00:00.000Z'
        };
      }
    }
  });
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };

  const rejected = await app.fetch(new Request('http://local/api/up-targets'));
  assert.equal(rejected.status, 401);

  const imported = await app.fetch(new Request('http://local/api/up-targets/import', {
    method: 'POST',
    headers,
    body: JSON.stringify({ mids: '42,43' })
  }));
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).existing, 1);

  const list = await app.fetch(new Request('http://local/api/up-profiles?includeTotal=0', { headers }));
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.items.some((item) => item.mid === '42'), true);

  const generated = await app.fetch(new Request('http://local/api/up-profiles/42/portrait/generate', {
    method: 'POST',
    headers
  }));
  assert.equal(generated.status, 200);
  assert.equal((await generated.json()).portrait.summary, '科技教程 UP');

  const detail = await app.fetch(new Request('http://local/api/up-profiles/42', { headers }));
  const detailBody = await detail.json();
  assert.equal(detailBody.profile.name, '测试UP');
  assert.equal(detailBody.rulePortrait.mainCategory, '科技');
  assert.equal(detailBody.portrait.provider, 'mock');

  const videos = await app.fetch(new Request('http://local/api/up-videos?mid=42', { headers }));
  assert.equal((await videos.json()).total, 1);
});

test('collect API surfaces Bilibili 412 as risk-control with hint', async () => {
  const storage = new MemoryStorage();
  const app = createApp({
    secret: 'secret',
    storage,
    biliClient: {
      async fetchUpCard() {
        throw new BiliApiError('B站风控拦截（HTTP 412）', {
          status: 412,
          type: 'risk_control',
          endpoint: '/x/web-interface/card'
        });
      }
    }
  });
  const response = await app.fetch(new Request('http://local/api/up-targets/42/collect', {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ maxPages: 1, maxVideos: 1 })
  }));
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'risk_control');
  assert.equal(body.status, 412);
  assert.match(body.hint, /风控/);
  const target = await storage.getUpTarget('42');
  assert.equal(target.status, 'backoff');
  assert.equal(target.lastErrorType, 'risk_control');
});
