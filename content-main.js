const nativeFetch = window.fetch;
const FEED_API_PATH = '/x/web-interface/wbi/index/top/feed/rcmd';
const MAX_REFILL_PAGES = 3;
const WBI_KEY_CACHE_MS = 10 * 60 * 1000;
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32,
  15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52
];

let blockerConfig = { enabled: true, rules: [] };
let cachedWbiMixinKey = '';
let cachedWbiMixinKeyTime = 0;

window.addEventListener('tabula_blocker_config', (event) => {
  const detail = typeof event.detail === 'string' ? event.detail : '';
  if (!detail) return;

  try {
    const parsed = JSON.parse(detail);
    blockerConfig = normalizeBlockerConfig(parsed);
  } catch (error) {
    console.warn('[TabulaBili] Failed to parse blocker config:', error);
  }
});

window.dispatchEvent(new CustomEvent('tabula_blocker_config_request'));

window.fetch = async function(...args) {
  const requestUrl = getFetchUrl(args[0]);

  if (!isFeedApiUrl(requestUrl)) {
    return nativeFetch(...args);
  }

  const currentMode = document.documentElement.getAttribute('data-tabula-mode') || 'pure';

  if (currentMode !== 'pure' && currentMode !== 'origin') {
    await prepareNetworkState();
  }

  const response = await nativeFetch(...args);
  return filterFeedResponse(response, args, requestUrl, currentMode);
};

function normalizeBlockerConfig(value) {
  const rules = Array.isArray(value && value.rules) ? value.rules : [];

  return {
    enabled: !value || value.enabled !== false,
    rules: rules
      .filter((rule) => rule && (rule.type === 'up_name_exact' || rule.type === 'title_regex'))
      .map((rule) => ({
        id: typeof rule.id === 'string' ? rule.id : '',
        type: rule.type,
        pattern: typeof rule.pattern === 'string' ? rule.pattern.trim() : '',
        enabled: rule.enabled !== false
      }))
      .filter((rule) => rule.pattern)
  };
}

function getFetchUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

function isFeedApiUrl(url) {
  return typeof url === 'string' && url.includes(FEED_API_PATH);
}

function compileBlockRules() {
  if (!blockerConfig.enabled || !blockerConfig.rules.length) return [];

  const compiled = [];
  for (const rule of blockerConfig.rules) {
    if (!rule.enabled || !rule.pattern) continue;

    if (rule.type === 'up_name_exact') {
      compiled.push({ type: rule.type, pattern: rule.pattern.trim() });
      continue;
    }

    try {
      compiled.push({ type: rule.type, regex: new RegExp(rule.pattern, 'i') });
    } catch (error) {
      console.warn('[TabulaBili] Ignored invalid blocker regex:', error);
    }
  }

  return compiled;
}

async function filterFeedResponse(response, originalArgs, originalUrl, currentMode) {
  const compiledRules = compileBlockRules();
  if (!compiledRules.length) return response;

  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  const items = payload && payload.data && Array.isArray(payload.data.item)
    ? payload.data.item
    : null;
  if (!items) return response;

  const targetLength = items.length;
  const seenKeys = new Set();
  const initial = filterItems(items, compiledRules, seenKeys, targetLength);
  const filteredItems = initial.items;

  if (initial.blocked > 0 && filteredItems.length < targetLength) {
    try {
      await refillItems({
        output: filteredItems,
        targetLength,
        seenKeys,
        compiledRules,
        originalArgs,
        originalUrl,
        currentMode
      });
    } catch (error) {
      console.warn('[TabulaBili] Failed to refill filtered feed:', error);
    }
  }

  if (initial.blocked === 0 && filteredItems.length === items.length) {
    return response;
  }

  payload.data.item = filteredItems;
  return createJsonResponse(response, payload);
}

function filterItems(items, compiledRules, seenKeys, maxItems) {
  const output = [];
  let blocked = 0;

  for (const item of items) {
    if (shouldBlockItem(item, compiledRules)) {
      blocked += 1;
      continue;
    }

    const key = getItemKey(item);
    if (key) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }

    output.push(item);
    if (output.length >= maxItems) break;
  }

  return { items: output, blocked };
}

function shouldBlockItem(item, compiledRules) {
  const title = getItemTitle(item);
  const upName = getItemUpName(item);

  if (!title && !upName) return false;

  for (const rule of compiledRules) {
    if (rule.type === 'up_name_exact' && upName && upName.trim() === rule.pattern) {
      return true;
    }

    if (rule.type === 'title_regex' && title && rule.regex.test(title)) {
      return true;
    }
  }

  return false;
}

function getItemTitle(item) {
  return getString(item && item.title)
    || getString(item && item.args && item.args.title);
}

function getItemUpName(item) {
  return getString(item && item.owner && item.owner.name)
    || getString(item && item.args && item.args.up_name)
    || getString(item && item.author);
}

function getItemKey(item) {
  const key = getString(item && item.bvid)
    || getString(item && item.aid)
    || getString(item && item.uri)
    || getString(item && item.id);
  return key ? key : '';
}

function getString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

async function refillItems(options) {
  for (let pageOffset = 1; pageOffset <= MAX_REFILL_PAGES; pageOffset += 1) {
    if (options.output.length >= options.targetLength) return;

    const refillUrl = await buildSignedRefillUrl(options.originalUrl, pageOffset);
    if (!refillUrl) return;

    if (options.currentMode !== 'pure' && options.currentMode !== 'origin') {
      await prepareNetworkState();
    }

    const refillResponse = await nativeFetch(refillUrl, buildRefillInit(options.originalArgs));
    if (!refillResponse.ok) continue;

    let payload;
    try {
      payload = await refillResponse.clone().json();
    } catch {
      continue;
    }

    const items = payload && payload.data && Array.isArray(payload.data.item)
      ? payload.data.item
      : [];
    if (!items.length) return;

    const remaining = options.targetLength - options.output.length;
    const filtered = filterItems(items, options.compiledRules, options.seenKeys, remaining);
    options.output.push(...filtered.items);
  }
}

function buildRefillInit(originalArgs) {
  const input = originalArgs[0];
  const explicitInit = originalArgs[1] && typeof originalArgs[1] === 'object'
    ? originalArgs[1]
    : {};
  const init = {};

  if (input instanceof Request) {
    copyRequestOption(init, input, 'cache');
    copyRequestOption(init, input, 'credentials');
    copyRequestOption(init, input, 'integrity');
    copyRequestOption(init, input, 'keepalive');
    copyRequestOption(init, input, 'mode');
    copyRequestOption(init, input, 'redirect');
    copyRequestOption(init, input, 'referrer');
    copyRequestOption(init, input, 'referrerPolicy');
    copyRequestOption(init, input, 'signal');
    init.headers = new Headers(input.headers);
  }

  Object.assign(init, explicitInit);
  if (explicitInit.headers) init.headers = new Headers(explicitInit.headers);

  init.method = 'GET';
  delete init.body;
  return init;
}

function copyRequestOption(target, request, name) {
  if (request[name] !== undefined) target[name] = request[name];
}

async function buildSignedRefillUrl(originalUrl, pageOffset) {
  const url = new URL(originalUrl, location.href);
  const params = url.searchParams;
  params.delete('w_rid');
  params.delete('wts');

  incrementNumericParam(params, 'fresh_idx', pageOffset);
  incrementNumericParam(params, 'fresh_idx_1h', pageOffset);
  incrementNumericParam(params, 'brush', pageOffset);
  if (!params.has('fresh_idx')) params.set('fresh_idx', String(pageOffset));

  params.set('wts', String(Math.round(Date.now() / 1000)));

  const mixinKey = await getWbiMixinKey();
  if (!mixinKey) return '';

  url.search = buildSignedQuery(params, mixinKey);
  return url.href;
}

function incrementNumericParam(params, name, amount) {
  if (!params.has(name)) return;

  const current = Number.parseInt(params.get(name), 10);
  if (Number.isFinite(current)) {
    params.set(name, String(current + amount));
  }
}

async function getWbiMixinKey() {
  const now = Date.now();
  if (cachedWbiMixinKey && now - cachedWbiMixinKeyTime < WBI_KEY_CACHE_MS) {
    return cachedWbiMixinKey;
  }

  const response = await nativeFetch('https://api.bilibili.com/x/web-interface/nav', {
    credentials: 'omit'
  });
  if (!response.ok) return '';

  const payload = await response.json();
  const imgUrl = payload && payload.data && payload.data.wbi_img && payload.data.wbi_img.img_url;
  const subUrl = payload && payload.data && payload.data.wbi_img && payload.data.wbi_img.sub_url;
  const rawKey = `${extractWbiFileKey(imgUrl)}${extractWbiFileKey(subUrl)}`;
  if (rawKey.length < 64) return '';

  cachedWbiMixinKey = MIXIN_KEY_ENC_TAB.map((index) => rawKey[index]).join('').slice(0, 32);
  cachedWbiMixinKeyTime = now;
  return cachedWbiMixinKey;
}

function extractWbiFileKey(url) {
  if (!url) return '';

  try {
    const pathname = new URL(url, location.href).pathname;
    const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
    const dotIndex = filename.indexOf('.');
    return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  } catch {
    const match = String(url).match(/\/([^/.]+)\.[^/.]+$/);
    return match ? match[1] : '';
  }
}

function buildSignedQuery(params, mixinKey) {
  const entries = [];
  params.forEach((value, key) => {
    entries.push([key, value]);
  });

  entries.sort((a, b) => a[0].localeCompare(b[0]));

  const query = entries
    .map(([key, value]) => {
      const sanitized = String(value).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(sanitized)}`;
    })
    .join('&');

  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

function createJsonResponse(sourceResponse, payload) {
  const headers = new Headers(sourceResponse.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.set('content-type', 'application/json;charset=utf-8');

  return new Response(JSON.stringify(payload), {
    status: sourceResponse.status,
    statusText: sourceResponse.statusText,
    headers
  });
}

function prepareNetworkState() {
  return new Promise((resolve) => {
    const eventId = Math.random().toString(36).substring(2);
    const fallbackTimer = window.setTimeout(() => {
      window.removeEventListener('tabula_network_ready', onNetworkReady);
      resolve();
    }, 1200);

    function onNetworkReady(e) {
      const detail = e.detail;
      const readyEventId = typeof detail === 'string' ? detail : detail && detail.eventId;

      if (readyEventId === eventId) {
        window.clearTimeout(fallbackTimer);
        window.removeEventListener('tabula_network_ready', onNetworkReady);
        resolve();
      }
    }

    window.addEventListener('tabula_network_ready', onNetworkReady);
    window.dispatchEvent(new CustomEvent('tabula_request_triggered', { detail: eventId }));
  });
}

function md5(input) {
  const x = convertToWordArray(utf8Encode(input));
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let k = 0; k < x.length; k += 16) {
    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;

    a = ff(a, b, c, d, x[k], 7, 0xd76aa478);
    d = ff(d, a, b, c, x[k + 1], 12, 0xe8c7b756);
    c = ff(c, d, a, b, x[k + 2], 17, 0x242070db);
    b = ff(b, c, d, a, x[k + 3], 22, 0xc1bdceee);
    a = ff(a, b, c, d, x[k + 4], 7, 0xf57c0faf);
    d = ff(d, a, b, c, x[k + 5], 12, 0x4787c62a);
    c = ff(c, d, a, b, x[k + 6], 17, 0xa8304613);
    b = ff(b, c, d, a, x[k + 7], 22, 0xfd469501);
    a = ff(a, b, c, d, x[k + 8], 7, 0x698098d8);
    d = ff(d, a, b, c, x[k + 9], 12, 0x8b44f7af);
    c = ff(c, d, a, b, x[k + 10], 17, 0xffff5bb1);
    b = ff(b, c, d, a, x[k + 11], 22, 0x895cd7be);
    a = ff(a, b, c, d, x[k + 12], 7, 0x6b901122);
    d = ff(d, a, b, c, x[k + 13], 12, 0xfd987193);
    c = ff(c, d, a, b, x[k + 14], 17, 0xa679438e);
    b = ff(b, c, d, a, x[k + 15], 22, 0x49b40821);

    a = gg(a, b, c, d, x[k + 1], 5, 0xf61e2562);
    d = gg(d, a, b, c, x[k + 6], 9, 0xc040b340);
    c = gg(c, d, a, b, x[k + 11], 14, 0x265e5a51);
    b = gg(b, c, d, a, x[k], 20, 0xe9b6c7aa);
    a = gg(a, b, c, d, x[k + 5], 5, 0xd62f105d);
    d = gg(d, a, b, c, x[k + 10], 9, 0x02441453);
    c = gg(c, d, a, b, x[k + 15], 14, 0xd8a1e681);
    b = gg(b, c, d, a, x[k + 4], 20, 0xe7d3fbc8);
    a = gg(a, b, c, d, x[k + 9], 5, 0x21e1cde6);
    d = gg(d, a, b, c, x[k + 14], 9, 0xc33707d6);
    c = gg(c, d, a, b, x[k + 3], 14, 0xf4d50d87);
    b = gg(b, c, d, a, x[k + 8], 20, 0x455a14ed);
    a = gg(a, b, c, d, x[k + 13], 5, 0xa9e3e905);
    d = gg(d, a, b, c, x[k + 2], 9, 0xfcefa3f8);
    c = gg(c, d, a, b, x[k + 7], 14, 0x676f02d9);
    b = gg(b, c, d, a, x[k + 12], 20, 0x8d2a4c8a);

    a = hh(a, b, c, d, x[k + 5], 4, 0xfffa3942);
    d = hh(d, a, b, c, x[k + 8], 11, 0x8771f681);
    c = hh(c, d, a, b, x[k + 11], 16, 0x6d9d6122);
    b = hh(b, c, d, a, x[k + 14], 23, 0xfde5380c);
    a = hh(a, b, c, d, x[k + 1], 4, 0xa4beea44);
    d = hh(d, a, b, c, x[k + 4], 11, 0x4bdecfa9);
    c = hh(c, d, a, b, x[k + 7], 16, 0xf6bb4b60);
    b = hh(b, c, d, a, x[k + 10], 23, 0xbebfbc70);
    a = hh(a, b, c, d, x[k + 13], 4, 0x289b7ec6);
    d = hh(d, a, b, c, x[k], 11, 0xeaa127fa);
    c = hh(c, d, a, b, x[k + 3], 16, 0xd4ef3085);
    b = hh(b, c, d, a, x[k + 6], 23, 0x04881d05);
    a = hh(a, b, c, d, x[k + 9], 4, 0xd9d4d039);
    d = hh(d, a, b, c, x[k + 12], 11, 0xe6db99e5);
    c = hh(c, d, a, b, x[k + 15], 16, 0x1fa27cf8);
    b = hh(b, c, d, a, x[k + 2], 23, 0xc4ac5665);

    a = ii(a, b, c, d, x[k], 6, 0xf4292244);
    d = ii(d, a, b, c, x[k + 7], 10, 0x432aff97);
    c = ii(c, d, a, b, x[k + 14], 15, 0xab9423a7);
    b = ii(b, c, d, a, x[k + 5], 21, 0xfc93a039);
    a = ii(a, b, c, d, x[k + 12], 6, 0x655b59c3);
    d = ii(d, a, b, c, x[k + 3], 10, 0x8f0ccc92);
    c = ii(c, d, a, b, x[k + 10], 15, 0xffeff47d);
    b = ii(b, c, d, a, x[k + 1], 21, 0x85845dd1);
    a = ii(a, b, c, d, x[k + 8], 6, 0x6fa87e4f);
    d = ii(d, a, b, c, x[k + 15], 10, 0xfe2ce6e0);
    c = ii(c, d, a, b, x[k + 6], 15, 0xa3014314);
    b = ii(b, c, d, a, x[k + 13], 21, 0x4e0811a1);
    a = ii(a, b, c, d, x[k + 4], 6, 0xf7537e82);
    d = ii(d, a, b, c, x[k + 11], 10, 0xbd3af235);
    c = ii(c, d, a, b, x[k + 2], 15, 0x2ad7d2bb);
    b = ii(b, c, d, a, x[k + 9], 21, 0xeb86d391);

    a = addUnsigned(a, aa);
    b = addUnsigned(b, bb);
    c = addUnsigned(c, cc);
    d = addUnsigned(d, dd);
  }

  return wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d);
}

function utf8Encode(input) {
  return unescape(encodeURIComponent(input));
}

function convertToWordArray(input) {
  const wordArray = [];
  const messageLength = input.length;
  const wordCount = (((messageLength + 8) - ((messageLength + 8) % 64)) / 64 + 1) * 16;

  for (let i = 0; i < wordCount; i += 1) {
    wordArray[i] = 0;
  }

  for (let i = 0; i < messageLength; i += 1) {
    wordArray[i >> 2] |= input.charCodeAt(i) << ((i % 4) * 8);
  }

  wordArray[messageLength >> 2] |= 0x80 << ((messageLength % 4) * 8);
  wordArray[wordCount - 2] = messageLength << 3;
  wordArray[wordCount - 1] = messageLength >>> 29;
  return wordArray;
}

function wordToHex(value) {
  let output = '';
  for (let i = 0; i <= 3; i += 1) {
    output += (`0${((value >>> (i * 8)) & 255).toString(16)}`).slice(-2);
  }
  return output;
}

function rotateLeft(value, shift) {
  return (value << shift) | (value >>> (32 - shift));
}

function addUnsigned(x, y) {
  return (x + y) >>> 0;
}

function cmn(q, a, b, x, s, t) {
  return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, q), addUnsigned(x, t)), s), b);
}

function ff(a, b, c, d, x, s, t) {
  return cmn((b & c) | ((~b) & d), a, b, x, s, t);
}

function gg(a, b, c, d, x, s, t) {
  return cmn((b & d) | (c & (~d)), a, b, x, s, t);
}

function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | (~d)), a, b, x, s, t);
}
