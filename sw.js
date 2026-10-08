import { logger } from '@lark-apaas/client-toolkit-lite';
/**
 * Service Worker —— 静态资源 + 3D 模型/纹理缓存（v2）
 * 策略：
 *  1. 同源静态资源（JS/CSS/字体/图片）→ Stale-While-Revalidate
 *  2. 3D 模型 / 纹理（glb/gltf/webp/png/jpg）→ Cache First（大文件不重复下载）
 *  3. 第三方 CDN 资源 → Network First + 缓存备份（避免跨域缓存污染）
 *  4. HTML 入口 → Network First（保证最新）
 *
 * v5-solo (2026-10-09):
 *  - 版本升级，触发所有客户端重新安装 SW
 *  - activate 时清理所有旧版本缓存（v1/v2/v3-ground/v4-verify）
 *  - v3.27 solo模式+diag时序修复：每层创建完重应用显隐，杜绝时序问题
 *
 * 安全约束：
 *  - 仅在 production 构建 + 同源时生效
 *  - 模型/纹理缓存最大容量，超出 LRU 淘汰（跳过活跃白名单）
 */

const CACHE_VERSION = 'v5-solo';
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const ASSET_CACHE = `assets-${CACHE_VERSION}`;
const MAX_ASSET_ENTRIES = 200;
const LRU_TRIM_RATIO = 0.7; // 超量后删到 70%

// 静态资源后缀（Stale-While-Revalidate）
const STATIC_EXTENSIONS = [
  '.js', '.css', '.woff', '.woff2', '.ttf', '.otf',
  '.svg', '.ico',
];

// 3D 模型/纹理后缀（Cache First，大体量大文件）
const ASSET_EXTENSIONS = [
  '.glb', '.gltf', '.bin', '.fbx', '.obj', '.mtl',
  '.webp', '.png', '.jpg', '.jpeg',
  '.hdr', '.ktx2', '.dds', '.tga', '.basis', '.exr',
  '.wasm', '.mp3', '.wav', '.ogg',
];

// 第三方 CDN 域名（Network First）
const THIRD_PARTY_DOMAINS = [
  'aka.doubaocdn.com',
  'bytednsdoc.com',
];

// ===== 活跃白名单（3D 场景使用中的资源，禁止淘汰） =====
const activeAssets = new Set();
const ACTIVE_TTL_MS = 10 * 60 * 1000; // 活跃标记 10 分钟 TTL
const activeTimestamps = new Map(); // url -> 添加时间

function isActive(url) {
  if (!activeAssets.has(url)) return false;
  const ts = activeTimestamps.get(url) || 0;
  if (Date.now() - ts > ACTIVE_TTL_MS) {
    activeAssets.delete(url);
    activeTimestamps.delete(url);
    return false;
  }
  return true;
}

function markActive(urls) {
  if (!Array.isArray(urls)) return;
  const now = Date.now();
  for (const u of urls) {
    activeAssets.add(u);
    activeTimestamps.set(u, now);
  }
}

function clearActive(urls) {
  if (!Array.isArray(urls)) return;
  for (const u of urls) {
    activeAssets.delete(u);
    activeTimestamps.delete(u);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(() => {
      self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k))
      );
    }).then(() => {
      self.clients.claim();
    })
  );
});

// ===== 消息通道：接收页面侧的活跃白名单通知 =====
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  if (data.type === 'MARK_ACTIVE') {
    markActive(data.urls);
  } else if (data.type === 'CLEAR_ACTIVE') {
    clearActive(data.urls);
  } else if (data.type === 'PING') {
    event.source?.postMessage?.({ type: 'PONG', activeCount: activeAssets.size });
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 只缓存 GET 请求
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === location.origin;
  const ext = getExtension(url.pathname);

  // HTML 入口 → Network First
  if (isSameOrigin && (url.pathname === '/' || url.pathname.endsWith('.html') || !ext)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 3D 模型 / 大纹理 → Cache First（体积大，节省带宽）
  if (ASSET_EXTENSIONS.includes(ext)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // 同源静态资源 → Stale-While-Revalidate
  if (isSameOrigin && STATIC_EXTENSIONS.includes(ext)) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  // 第三方 CDN 图片/模型 → Network First + 缓存备份
  if (THIRD_PARTY_DOMAINS.some((d) => url.hostname === d || url.hostname.endsWith(d))) {
    event.respondWith(networkFirstWithCache(request, ASSET_CACHE));
    return;
  }

  // 其他请求走网络
});

// ===== 缓存策略 =====

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(async (cache) => {
    const cached = await cache.match(request);
    const fetchPromise = fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          cache.put(request, response.clone());
        }
        return response;
      })
      .catch(() => cached || Response.error());
    return cached || fetchPromise;
  });
}

function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then(async (cache) => {
    const cached = await cache.match(request);
    // 命中 → 更新活跃时间（用于 LRU 排序）
    if (cached) {
      touchLru(request.url, cacheName);
      return cached;
    }

    try {
      const response = await fetch(request);
      if (response && response.status === 200) {
        cache.put(request, response.clone());
        touchLru(request.url, cacheName);
        trimCache(cacheName);
      }
      return response;
    } catch (err) {
      logger.warn('[SW.cacheFirst] 下载失败:', { arg0: request.url, arg1: String(err) });
      return cached || Response.error();
    }
  });
}

function networkFirst(request) {
  return fetch(request)
    .then((response) => response)
    .catch(async () => {
      const cached = await caches.match(request);
      return cached || Response.error();
    });
}

function networkFirstWithCache(request, cacheName) {
  return caches.open(cacheName).then(async (cache) => {
    try {
      const response = await fetch(request);
      if (response && response.status === 200) {
        cache.put(request, response.clone());
        touchLru(request.url, cacheName);
        trimCache(cacheName);
      }
      return response;
    } catch (err) {
      logger.warn('[SW.networkFirstWithCache] 网络失败，回退缓存:', { arg0: request.url, arg1: String(err) });
      const cached = await cache.match(request);
      return cached || Response.error();
    }
  });
}

// ===== LRU 管理 =====
// 简单的访问时间记录（用 url -> timestamp Map 存内存，SW 生命周期内有效）
const lruTimestamps = new Map(); // cacheName:url -> timestamp

function touchLru(url, cacheName) {
  lruTimestamps.set(`${cacheName}:${url}`, Date.now());
}

function getLruTime(url, cacheName) {
  return lruTimestamps.get(`${cacheName}:${url}`) || 0;
}

/**
 * 精确 LRU 淘汰：超出 MAX_ASSET_ENTRIES 时删除最久未访问的
 * 跳过活跃白名单中的资源（正在被 3D 场景使用）
 */
async function trimCache(cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();

    if (keys.length <= MAX_ASSET_ENTRIES) return;

    // 按 LRU 时间排序（最老在前）
    const entries = keys.map((req) => ({
      url: req.url,
      request: req,
      time: getLruTime(req.url, cacheName),
      active: isActive(req.url),
    }));

    // 活跃的跳过，按时间从老到新
    const toCheck = entries
      .filter((e) => !e.active)
      .sort((a, b) => a.time - b.time);

    const targetCount = Math.floor(MAX_ASSET_ENTRIES * LRU_TRIM_RATIO);
    const toDelete = keys.length - targetCount;

    if (toDelete <= 0) return;

    let deleted = 0;
    for (const entry of toCheck) {
      if (deleted >= toDelete) break;
      cache.delete(entry.request);
      lruTimestamps.delete(`${cacheName}:${entry.url}`);
      deleted++;
    }

    logger.info(`[SW.trimCache] 淘汰 ${deleted}/${keys.length} 条，活跃白名单 ${activeAssets.size} 条`);
  } catch (err) {
    logger.warn('[SW.trimCache] LRU 淘汰异常:', String(err));
  }
}

// ===== 工具 =====

function getExtension(path) {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return '';
  return path.slice(idx).toLowerCase();
}
