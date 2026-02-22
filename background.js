const cache = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "IV_PARSE_MANIFEST") {
    const url = message.url;
    if (!url) return;
    if (cache.has(url)) {
      sendResponse(cache.get(url));
      return true;
    }
    fetchManifest(url)
      .then((result) => {
        cache.set(url, result);
        sendResponse(result);
      })
      .catch((error) => {
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (message.type === "IV_HEAD_REQUEST") {
    const url = message.url;
    if (!url) return;
    fetch(url, { method: "HEAD" })
      .then((response) => {
        const size = response.headers.get("content-length");
        sendResponse({ ok: true, size: size ? Number(size) : null });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (message.type === "IV_PROBE_MANIFESTS") {
    const urls = Array.isArray(message.urls) ? message.urls : [];
    if (!urls.length) {
      sendResponse({ ok: true, results: [] });
      return true;
    }

    probeManifestCandidates(urls)
      .then((results) => {
        sendResponse({ ok: true, results });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: String(error), results: [] });
      });
    return true;
  }

  if (message.type === "IV_DOWNLOAD_URL") {
    const url = message.url;
    const filename = message.filename;
    const saveAs = !!message.saveAs;
    if (!url) {
      sendResponse({ ok: false, error: "Missing url" });
      return true;
    }

    chrome.downloads.download(
      {
        url,
        filename: filename || undefined,
        saveAs,
        conflictAction: "uniquify",
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, downloadId: Number(downloadId) || null });
      },
    );
    return true;
  }
});

async function probeManifestCandidates(urls) {
  const unique = Array.from(new Set(urls)).slice(0, 20);
  const results = [];

  for (const url of unique) {
    const hit = await probeManifest(url);
    if (hit) results.push(hit);
  }

  return results.sort((a, b) => b.score - a.score);
}

async function probeManifest(url) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-4095",
      },
    });
  } catch (error) {
    return null;
  }

  if (!response || !response.ok) return null;

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  let bodyStart = "";
  try {
    bodyStart = (await response.text()).slice(0, 2048).toLowerCase();
  } catch (error) {
    bodyStart = "";
  }

  const lowerUrl = String(url).toLowerCase();
  const hasHlsSig =
    lowerUrl.includes(".m3u8") ||
    contentType.includes("mpegurl") ||
    bodyStart.includes("#extm3u");
  const hasDashSig =
    lowerUrl.includes(".mpd") ||
    contentType.includes("dash+xml") ||
    bodyStart.includes("<mpd") ||
    bodyStart.includes("<mpd ");

  if (!hasHlsSig && !hasDashSig) return null;

  let score = 40;
  const reasons = ["reachable"];

  if (hasHlsSig) {
    score += 45;
    reasons.push("hls-signature");
  }
  if (hasDashSig) {
    score += 45;
    reasons.push("dash-signature");
  }

  if (/master|playlist|manifest|index|stream/.test(lowerUrl)) {
    score += 10;
    reasons.push("manifest-like-name");
  }

  return {
    url,
    type: hasHlsSig ? "hls" : "dash",
    score,
    reasons,
  };
}

async function fetchManifest(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (url.includes(".m3u8") || text.includes("#EXTM3U")) {
    return { ok: true, type: "hls", url, ...parseM3u8(text, url) };
  }
  if (url.includes(".mpd") || text.includes("<MPD")) {
    return { ok: true, type: "dash", url, ...parseMpd(text) };
  }
  return { ok: true, type: "unknown", url };
}

function parseM3u8(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  let currentInfo = null;
  let duration = 0;
  let hasEndList = false;
  let drm = false;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY")) drm = true;
    if (line.startsWith("#EXT-X-ENDLIST")) hasEndList = true;
    if (line.startsWith("#EXTINF:")) {
      const match = line.match(/#EXTINF:([0-9.]+)/);
      if (match) duration += Number(match[1]);
    }
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      currentInfo = parseM3u8Attributes(line);
      continue;
    }
    if (currentInfo && line && !line.startsWith("#")) {
      const resolved = new URL(line, baseUrl).toString();
      variants.push({ url: resolved, ...currentInfo });
      currentInfo = null;
    }
  }

  const isMaster = variants.length > 0;
  const isLive = !hasEndList && duration === 0;
  return { variants, duration: duration || null, isLive, drm, isMaster };
}

function parseM3u8Attributes(line) {
  const attributes = {};
  const parts = line.split(":");
  if (parts.length < 2) return attributes;
  const attrText = parts.slice(1).join(":");
  const regex = /([A-Z0-9-]+)=(("[^"]+")|[^,]+)/g;
  let match;
  while ((match = regex.exec(attrText))) {
    const key = match[1];
    let value = match[2];
    if (value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1);
    }
    attributes[key] = value;
  }
  const resolution = attributes.RESOLUTION || null;
  const bandwidth = attributes.BANDWIDTH ? Number(attributes.BANDWIDTH) : null;
  const codecs = attributes.CODECS || null;
  return { resolution, bandwidth, codecs };
}

function parseMpd(text) {
  const drm = /ContentProtection|cenc:pssh/i.test(text);
  const duration = parseIsoDuration(extractAttribute(text, "mediaPresentationDuration"));
  const representations = [];
  const regex = /<Representation\b([^>]+)>/g;
  let match;
  while ((match = regex.exec(text))) {
    const attrs = match[1];
    const width = toNumber(extractAttribute(attrs, "width"));
    const height = toNumber(extractAttribute(attrs, "height"));
    const bandwidth = toNumber(extractAttribute(attrs, "bandwidth"));
    const id = extractAttribute(attrs, "id");
    representations.push({ id, width, height, bandwidth });
  }
  return { representations, duration, drm };
}

function extractAttribute(text, name) {
  const regex = new RegExp(`${name}="([^"]+)"`, "i");
  const match = text.match(regex);
  return match ? match[1] : null;
}

function parseIsoDuration(value) {
  if (!value) return null;
  const match = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function toNumber(value) {
  if (!value) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
