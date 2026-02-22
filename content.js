(() => {
  const SOURCE = "InstallVideo";
  const MAX_LINKS_PER_VIDEO = 120;
  const MAX_SEGMENTS_PER_VIDEO = 30;

  let localCounter = 1;
  let lastActiveVideoId = null;

  const videoStore = new Map(); // id -> { el, overlay, links: Map(url->link), duration }
  const manifestRequested = new Set();

  injectPageScript();
  installMessageListener();
  scanVideos();
  observeVideoMutations();

  function injectPageScript() {
    const src = chrome.runtime.getURL("page_inject.js");
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
  }

  function installMessageListener() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== SOURCE || !data.type) return;

      switch (data.type) {
        case "IV_MEDIA_PLAY":
          if (data.id) lastActiveVideoId = data.id;
          break;
        case "IV_MEDIA_META":
          handleMediaMeta(data);
          break;
        case "IV_MEDIA_SRC":
          handleMediaSrc(data);
          break;
        case "IV_NET_REQUEST":
          handleNetRequest(data);
          break;
        default:
          break;
      }
    });
  }

  function scanVideos() {
    document.querySelectorAll("video").forEach((video) => ensureOverlay(video));
  }

  function observeVideoMutations() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          if (node.tagName && node.tagName.toLowerCase() === "video") {
            ensureOverlay(node);
          } else if (node.querySelectorAll) {
            node
              .querySelectorAll("video")
              .forEach((video) => ensureOverlay(video));
          }
        }
      }
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }

  function ensureOverlay(video) {
    if (!video || video.dataset.ivOverlayAttached) return;

    const id = ensureVideoId(video);
    if (!id) return;

    const overlay = buildOverlay(id);
    attachOverlay(video, overlay);

    video.dataset.ivOverlayAttached = "1";
    videoStore.set(id, {
      el: video,
      overlay,
      links: new Map(),
      sources: new Set(),
      duration: null,
    });
  }

  function ensureVideoId(video) {
    if (!video.dataset) return null;
    if (!video.dataset.ivId) {
      video.dataset.ivId = `iv-local-${localCounter++}`;
    }
    return video.dataset.ivId;
  }

  function buildOverlay(videoId) {
    const overlay = document.createElement("div");
    overlay.className = "iv-overlay";
    overlay.dataset.ivId = videoId;

    const button = document.createElement("div");
    button.className = "iv-button";
    button.title = "InstallVideo: show links";

    const panel = document.createElement("div");
    panel.className = "iv-panel";

    const title = document.createElement("div");
    title.className = "iv-title";
    title.textContent = "InstallVideo Links";

    const list = document.createElement("div");
    list.className = "iv-list";

    panel.appendChild(title);
    panel.appendChild(list);

    overlay.appendChild(button);
    overlay.appendChild(panel);

    overlay.addEventListener("mouseenter", () => {
      overlay.classList.add("iv-open");
      renderLinks(videoId);
    });

    overlay.addEventListener("mouseleave", () => {
      overlay.classList.remove("iv-open");
    });

    return overlay;
  }

  function attachOverlay(video, overlay) {
    const parent = video.parentElement || video;
    if (!parent) return;

    const computed = window.getComputedStyle(parent);
    if (computed.position === "static" && !parent.dataset.ivPositioned) {
      parent.style.position = "relative";
      parent.dataset.ivPositioned = "1";
    }

    parent.appendChild(overlay);
  }

  function handleMediaMeta(data) {
    const { id, duration, currentSrc } = data;
    if (!id) return;

    const store = ensureStore(id);
    if (store && Number.isFinite(duration)) {
      store.duration = duration;
      updateLinkDuration(id, duration);
    }

    if (currentSrc) {
      if (store && store.sources) {
        store.sources.add(currentSrc);
      }
      addLinkForVideo(id, currentSrc, { source: "media-meta" });
    }
  }

  function handleMediaSrc(data) {
    const { id, url } = data;
    if (!id || !url) return;
    const store = ensureStore(id);
    if (store && store.sources) {
      store.sources.add(url);
    }
    addLinkForVideo(id, url, { source: "media-src" });
  }

  function handleNetRequest(data) {
    const { url, initiatorType } = data;
    if (!url) return;
    const id = findVideoIdForUrl(url) || pickTargetVideoId();
    if (!id) return;

    addLinkForVideo(id, url, { source: "net", initiatorType });
  }

  function pickTargetVideoId() {
    if (lastActiveVideoId && videoStore.has(lastActiveVideoId)) {
      return lastActiveVideoId;
    }
    if (videoStore.size === 1) {
      return Array.from(videoStore.keys())[0];
    }
    return lastActiveVideoId || null;
  }

  function findVideoIdForUrl(url) {
    const origin = safeOrigin(url);
    if (!origin) return null;

    for (const [id, store] of videoStore.entries()) {
      if (!store) continue;

      if (store.sources && store.sources.size) {
        for (const src of store.sources) {
          if (safeOrigin(src) === origin) {
            return id;
          }
        }
      }

      if (store.links && store.links.size) {
        for (const link of store.links.values()) {
          if (link && link.url && safeOrigin(link.url) === origin) {
            return id;
          }
        }
      }
    }
    return null;
  }

  function safeOrigin(value) {
    try {
      return new URL(value, window.location.href).origin;
    } catch (e) {
      return null;
    }
  }

  function ensureStore(id) {
    if (!videoStore.has(id)) {
      const el = document.querySelector(`video[data-iv-id="${id}"]`);
      if (!el) return null;
      ensureOverlay(el);
    }
    return videoStore.get(id);
  }

  function addLinkForVideo(videoId, url, { source, initiatorType } = {}) {
    const store = ensureStore(videoId);
    if (!store) return;

    const cleaned = normalizeUrl(url);
    if (!cleaned) return;

    const classification = classifyUrl(cleaned);
    if (!classification) return;

    const existing = store.links.get(cleaned);
    if (existing) {
      mergeLink(existing, {
        source,
        initiatorType,
        ...classification,
      });
      renderLinks(videoId);
      return;
    }

    if (classification.type === "segment") {
      const segmentCount = countLinksByType(store.links, "segment");
      if (segmentCount >= MAX_SEGMENTS_PER_VIDEO) return;
    }

    if (store.links.size >= MAX_LINKS_PER_VIDEO) {
      evictOldestLinks(store.links, 5);
    }

    const link = {
      url: cleaned,
      source: source || "unknown",
      initiatorType: initiatorType || null,
      addedAt: Date.now(),
      drm: false,
      isLive: false,
      duration: store.duration || null,
      size: null,
      qualities: null,
      ...classification,
    };

    store.links.set(cleaned, link);

    if (link.type === "hls" || link.type === "dash") {
      requestManifestParse(videoId, link.url);
    }

    if (link.type === "file") {
      requestHeadSize(videoId, link.url);
    }

    renderLinks(videoId);
  }

  function normalizeUrl(url) {
    if (typeof url !== "string") return null;
    return url.trim();
  }

  function classifyUrl(url) {
    const lower = url.toLowerCase();
    const stripped = lower.split("?")[0].split("#")[0];

    if (lower.startsWith("blob:")) {
      return { type: "blob", label: "BLOB" };
    }

    if (lower.includes(".m3u8")) {
      return { type: "hls", label: "HLS" };
    }

    if (lower.includes(".mpd")) {
      return { type: "dash", label: "DASH" };
    }

    if (stripped.match(/\.(mp4|webm|mkv|mov|m4v)$/)) {
      return { type: "file", label: "FILE" };
    }

    if (stripped.match(/\.(ts|m4s|aac|mp3|cmfv|cmfa)$/)) {
      return { type: "segment", label: "SEGMENT" };
    }

    if (lower.includes("manifest") || lower.includes("playlist")) {
      return { type: "manifest", label: "MANIFEST" };
    }

    return { type: "other", label: "OTHER" };
  }

  function mergeLink(target, updates) {
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) continue;
      if (target[key] === null || target[key] === undefined) {
        target[key] = value;
      }
    }
  }

  function countLinksByType(map, type) {
    let count = 0;
    for (const link of map.values()) {
      if (link.type === type) count++;
    }
    return count;
  }

  function evictOldestLinks(map, count) {
    const entries = Array.from(map.values()).sort(
      (a, b) => a.addedAt - b.addedAt,
    );
    for (let i = 0; i < Math.min(count, entries.length); i++) {
      map.delete(entries[i].url);
    }
  }

  function requestManifestParse(videoId, url) {
    if (manifestRequested.has(url)) return;
    manifestRequested.add(url);

    chrome.runtime.sendMessage(
      { type: "IV_PARSE_MANIFEST", url },
      (response) => {
        if (!response || !response.ok) return;

        if (response.type === "hls") {
          handleHlsManifest(videoId, url, response);
        } else if (response.type === "dash") {
          handleDashManifest(videoId, url, response);
        }
      },
    );
  }

  function requestHeadSize(videoId, url) {
    chrome.runtime.sendMessage({ type: "IV_HEAD_REQUEST", url }, (response) => {
      if (!response || !response.ok) return;
      const store = ensureStore(videoId);
      if (!store) return;
      const link = store.links.get(url);
      if (!link) return;
      if (Number.isFinite(response.size)) {
        link.size = response.size;
        renderLinks(videoId);
      }
    });
  }

  function handleHlsManifest(videoId, url, result) {
    const store = ensureStore(videoId);
    if (!store) return;

    const manifestLink = store.links.get(url);
    if (manifestLink) {
      manifestLink.drm = !!result.drm;
      manifestLink.isLive = !!result.isLive;
      if (result.duration) manifestLink.duration = result.duration;
      manifestLink.isMaster = !!result.isMaster;
    }

    if (Array.isArray(result.variants) && result.variants.length) {
      result.variants.forEach((variant) => {
        const variantUrl = variant.url;
        if (!variantUrl) return;

        const existing = store.links.get(variantUrl);
        if (existing) {
          mergeLink(existing, {
            type: "hls-variant",
            label: "HLS",
            resolution: variant.resolution || null,
            bandwidth: variant.bandwidth || null,
            codecs: variant.codecs || null,
            drm: !!result.drm,
            isLive: !!result.isLive,
            duration: result.duration || store.duration || null,
          });
          return;
        }

        const link = {
          url: variantUrl,
          type: "hls-variant",
          label: "HLS",
          resolution: variant.resolution || null,
          bandwidth: variant.bandwidth || null,
          codecs: variant.codecs || null,
          drm: !!result.drm,
          isLive: !!result.isLive,
          duration: result.duration || store.duration || null,
          size: estimateSizeFromBandwidth(result.duration, variant.bandwidth),
          addedAt: Date.now(),
          source: "hls-variant",
          initiatorType: null,
        };
        store.links.set(variantUrl, link);
      });
    }

    renderLinks(videoId);
  }

  function handleDashManifest(videoId, url, result) {
    const store = ensureStore(videoId);
    if (!store) return;

    const manifestLink = store.links.get(url);
    if (manifestLink) {
      manifestLink.drm = !!result.drm;
      if (result.duration) manifestLink.duration = result.duration;
      if (
        Array.isArray(result.representations) &&
        result.representations.length
      ) {
        const qualities = result.representations
          .map((rep) => formatDashRep(rep))
          .filter(Boolean);
        manifestLink.qualities = qualities.length ? qualities : null;
      }
    }

    renderLinks(videoId);
  }

  function updateLinkDuration(videoId, duration) {
    const store = ensureStore(videoId);
    if (!store) return;
    for (const link of store.links.values()) {
      if (!link.duration) link.duration = duration;
      if (!link.size && link.bandwidth && link.duration) {
        link.size = estimateSizeFromBandwidth(link.duration, link.bandwidth);
      }
    }
    renderLinks(videoId);
  }

  function estimateSizeFromBandwidth(duration, bandwidth) {
    if (!Number.isFinite(duration) || !Number.isFinite(bandwidth)) return null;
    const bytes = (duration * bandwidth) / 8;
    return Number.isFinite(bytes) ? bytes : null;
  }

  function renderLinks(videoId) {
    const store = ensureStore(videoId);
    if (!store || !store.overlay) return;

    const panel = store.overlay.querySelector(".iv-panel");
    const list = store.overlay.querySelector(".iv-list");
    if (!panel || !list) return;

    list.innerHTML = "";
    const links = Array.from(store.links.values()).sort(
      (a, b) => b.addedAt - a.addedAt,
    );

    if (!links.length) {
      const empty = document.createElement("div");
      empty.className = "iv-empty";
      empty.textContent = "Chưa phát hiện link video.";
      list.appendChild(empty);
      return;
    }

    links.forEach((link) => {
      const item = document.createElement("div");
      item.className = "iv-link";

      const rowTop = document.createElement("div");
      rowTop.className = "iv-row";

      const label = document.createElement("div");
      label.textContent = buildLabel(link);

      const copy = document.createElement("button");
      copy.className = "iv-copy";
      copy.textContent = "Copy";
      copy.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyToClipboard(link.url);
      });

      rowTop.appendChild(label);
      rowTop.appendChild(copy);

      const urlRow = document.createElement("div");
      urlRow.className = "iv-url";
      urlRow.textContent = link.url;

      const metaRow = document.createElement("div");
      metaRow.className = "iv-meta";

      const metaText = document.createElement("span");
      metaText.className = "iv-meta-text";
      metaText.textContent = buildMeta(link);

      const tagWrap = document.createElement("span");
      tagWrap.className = "iv-meta-tags";

      const tags = buildTags(link);
      if (tags.length) {
        tags.forEach((tag) => tagWrap.appendChild(tag));
      }

      metaRow.appendChild(metaText);
      metaRow.appendChild(tagWrap);

      item.appendChild(rowTop);
      item.appendChild(urlRow);
      item.appendChild(metaRow);

      list.appendChild(item);
    });
  }

  function buildLabel(link) {
    const parts = [];
    parts.push(link.label || link.type || "LINK");

    if (link.resolution) parts.push(link.resolution);
    if (link.width && link.height) parts.push(`${link.width}x${link.height}`);
    if (link.bandwidth) parts.push(formatBandwidth(link.bandwidth));
    if (link.type === "blob") parts.push("local");

    return parts.join(" · ");
  }

  function buildMeta(link) {
    const meta = [];
    if (link.duration) meta.push(`Duration: ${formatDuration(link.duration)}`);
    if (link.size) meta.push(`Size: ${formatBytes(link.size)}`);
    if (link.qualities && link.qualities.length) {
      meta.push(`Qualities: ${link.qualities.join(", ")}`);
    }
    if (link.initiatorType) meta.push(`Source: ${link.initiatorType}`);
    return meta.join(" | ") || "—";
  }

  function buildTags(link) {
    const tags = [];
    if (link.drm) tags.push(createTag("DRM", "drm"));
    if (link.isLive) tags.push(createTag("LIVE", "live"));
    return tags;
  }

  function createTag(text, className) {
    const tag = document.createElement("span");
    tag.className = `iv-tag ${className || ""}`.trim();
    tag.textContent = text;
    return tag;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    document.body.removeChild(textarea);
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return "—";
    const sec = Math.round(seconds);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0)
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  function formatBandwidth(bps) {
    if (!Number.isFinite(bps)) return "—";
    const mbps = bps / 1_000_000;
    if (mbps >= 1) return `${mbps.toFixed(2)} Mbps`;
    return `${Math.round(bps / 1000)} Kbps`;
  }

  function formatDashRep(rep) {
    if (!rep) return null;
    const parts = [];
    if (rep.width && rep.height) parts.push(`${rep.width}x${rep.height}`);
    if (rep.bandwidth) parts.push(formatBandwidth(rep.bandwidth));
    return parts.join(" ");
  }
})();
