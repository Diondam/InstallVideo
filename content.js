(() => {
  const SOURCE = "InstallVideo";
  const MAX_LINKS_PER_VIDEO = 120;
  const MAX_SEGMENTS_PER_VIDEO = 30;
  const MAX_MANIFEST_PROBE_URLS = 20;
  const MANIFEST_PROBE_NAMES = [
    "master.m3u8",
    "index.m3u8",
    "playlist.m3u8",
    "manifest.m3u8",
    "stream.m3u8",
    "dash.mpd",
    "manifest.mpd",
  ];
  const SETTINGS_KEY = "ivDownloadSettings";
  const DEFAULT_SETTINGS = {
    downloadSubfolder: "",
    askEachTime: false,
  };

  let localCounter = 1;
  let lastActiveVideoId = null;
  let floatingInfoEl = null;
  let extensionSettings = { ...DEFAULT_SETTINGS };
  const netUrlOwner = new Map();
  const expandedGroupKeys = new Set();

  const videoStore = new Map(); // id -> { el, overlay, links: Map(url->link), duration }
  const manifestRequested = new Set();

  initSettings();
  injectPageScript();
  installMessageListener();
  scanVideos();
  observeVideoMutations();

  function initSettings() {
    chrome.storage.local.get(SETTINGS_KEY, (data) => {
      const saved = data && data[SETTINGS_KEY] ? data[SETTINGS_KEY] : null;
      extensionSettings = {
        ...DEFAULT_SETTINGS,
        ...(saved && typeof saved === "object" ? saved : {}),
      };
    });
  }

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
       segmentProbeBases: new Set(),
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
    overlay.dataset.ivPinned = "0";

    const button = document.createElement("button");
    button.className = "iv-button";
    button.type = "button";
    button.title = "InstallVideo: toggle panel";
    button.setAttribute("aria-label", "Download links");

    const panel = document.createElement("div");
    panel.className = "iv-panel";

    const titleBar = document.createElement("div");
    titleBar.className = "iv-titlebar";

    const title = document.createElement("div");
    title.className = "iv-title";
    title.textContent = "InstallVideo Links";

    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "iv-settings-btn";
    settingsBtn.title = "Cài đặt thư mục tải";
    settingsBtn.setAttribute("aria-label", "Cài đặt thư mục tải");
    settingsBtn.textContent = "";
    settingsBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDownloadSettings();
    });

    titleBar.appendChild(title);
    titleBar.appendChild(settingsBtn);

    const list = document.createElement("div");
    list.className = "iv-list";

    panel.appendChild(titleBar);
    panel.appendChild(list);

    overlay.appendChild(button);
    overlay.appendChild(panel);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isPinned = overlay.dataset.ivPinned === "1";
      if (isPinned) {
        overlay.dataset.ivPinned = "0";
        overlay.classList.remove("iv-pinned");
        overlay.classList.remove("iv-open");
      } else {
        overlay.dataset.ivPinned = "1";
        overlay.classList.add("iv-pinned");
        overlay.classList.add("iv-open");
        renderLinks(videoId);
      }
    });

    overlay.addEventListener("mouseenter", () => {
      overlay.classList.add("iv-open");
      renderLinks(videoId);
    });

    overlay.addEventListener("mouseleave", () => {
      if (overlay.dataset.ivPinned === "1") return;
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

  function openDownloadSettings() {
    const currentFolder = extensionSettings.downloadSubfolder || "";
    const input = window.prompt(
      "Nhập thư mục con để lưu trong Downloads (vd: InstallVideo).\nĐể trống = lưu trực tiếp vào Downloads mặc định.",
      currentFolder,
    );
    if (input === null) return;

    const normalizedFolder = normalizeSubfolder(input);
    const askEachTime = window.confirm(
      "Bạn có muốn bật hộp thoại chọn nơi lưu cho MỖI lần tải không?\nOK = Có, Cancel = Không",
    );

    extensionSettings = {
      downloadSubfolder: normalizedFolder,
      askEachTime,
    };

    chrome.storage.local.set({ [SETTINGS_KEY]: extensionSettings });
  }

  function normalizeSubfolder(value) {
    if (!value || typeof value !== "string") return "";
    return value
      .trim()
      .replace(/\\+/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.\./g, "")
      .replace(/\s+/g, " ");
  }

  function handleMediaMeta(data) {
    const { id, duration, currentSrc } = data;
    if (!id) return;
    lastActiveVideoId = id;

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
    lastActiveVideoId = id;
    const store = ensureStore(id);
    if (store && store.sources) {
      store.sources.add(url);
    }
    addLinkForVideo(id, url, { source: "media-src" });
  }

  function handleNetRequest(data) {
    const { id: hintedId, url, initiatorType } = data;
    if (!url) return;
    const normalized = normalizeUrl(url);
    if (!normalized) return;

    const id =
      resolveHintedVideoId(hintedId) ||
      netUrlOwner.get(normalized) ||
      pickTargetVideoId() ||
      findVideoIdForUrl(normalized);

    if (!id) return;

    addLinkForVideo(id, normalized, { source: "net", initiatorType });
  }

  function resolveHintedVideoId(id) {
    if (!id) return null;
    return videoStore.has(id) ? id : null;
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
    const parsed = safeParsedUrl(url);
    if (!parsed) return null;

    let bestId = null;
    let bestScore = 0;

    for (const [id, store] of videoStore.entries()) {
      if (!store) continue;

      let score = 0;

      if (store.sources && store.sources.size) {
        for (const src of store.sources) {
          const s = safeParsedUrl(src);
          if (!s) continue;
          if (s.href === parsed.href) score = Math.max(score, 100);
          else if (s.host === parsed.host) score = Math.max(score, 30);
          else if (s.origin === parsed.origin) score = Math.max(score, 20);
        }
      }

      if (store.links && store.links.size) {
        for (const link of store.links.values()) {
          const l = link && link.url ? safeParsedUrl(link.url) : null;
          if (!l) continue;
          if (l.href === parsed.href) score = Math.max(score, 90);
          else if (l.host === parsed.host) score = Math.max(score, 25);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    return bestScore >= 25 ? bestId : null;
  }

  function safeParsedUrl(value) {
    try {
      return new URL(value, window.location.href);
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
    netUrlOwner.set(cleaned, videoId);

    if (link.type === "hls" || link.type === "dash") {
      requestManifestParse(videoId, link.url);
    }

    if (link.type === "file") {
      requestHeadSize(videoId, link.url);
    }
 
      if (classification.type === "segment") {
        requestSegmentManifestInference(videoId, link.url);
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
 
       function requestSegmentManifestInference(videoId, segmentUrl) {
         const store = ensureStore(videoId);
         if (!store || !segmentUrl) return;
 
         const baseKey = getSegmentBaseKey(segmentUrl);
         if (!baseKey) return;
 
         if (!store.segmentProbeBases) {
           store.segmentProbeBases = new Set();
         }
         if (store.segmentProbeBases.has(baseKey)) return;
         store.segmentProbeBases.add(baseKey);
 
         const probes = buildManifestProbeUrls(segmentUrl).slice(0, MAX_MANIFEST_PROBE_URLS);
         if (!probes.length) return;
 
         chrome.runtime.sendMessage(
           { type: "IV_PROBE_MANIFESTS", urls: probes },
           (response) => {
             if (!response || !response.ok || !Array.isArray(response.results)) return;
             applyInferredManifestCandidates(videoId, response.results);
           },
         );
       }
 
       function applyInferredManifestCandidates(videoId, candidates) {
         const store = ensureStore(videoId);
         if (!store) return;
 
         let changed = false;
 
         for (const item of candidates) {
           if (!item || !item.url) continue;
           const inferredType = item.type === "dash" ? "dash" : "hls";
           const classification = inferredType === "dash"
             ? { type: "dash", label: "DASH" }
             : { type: "hls", label: "HLS" };
 
           const existing = store.links.get(item.url);
           if (existing) {
             mergeLink(existing, {
               ...classification,
               source: "segment-infer",
               inferScore: Number.isFinite(item.score) ? item.score : null,
               inferReason: Array.isArray(item.reasons) ? item.reasons.join(",") : null,
             });
             changed = true;
           } else {
             const link = {
               url: item.url,
               source: "segment-infer",
               initiatorType: null,
               addedAt: Date.now(),
               drm: false,
               isLive: false,
               duration: store.duration || null,
               size: null,
               qualities: null,
               inferScore: Number.isFinite(item.score) ? item.score : null,
               inferReason: Array.isArray(item.reasons) ? item.reasons.join(",") : null,
               ...classification,
             };
             store.links.set(item.url, link);
             netUrlOwner.set(item.url, videoId);
             changed = true;
           }
 
           requestManifestParse(videoId, item.url);
         }
 
         if (changed) {
           renderLinks(videoId);
         }
       }
 
       function getSegmentBaseKey(segmentUrl) {
         try {
           const parsed = new URL(segmentUrl, window.location.href);
           const parts = parsed.pathname.split("/").filter(Boolean);
           if (!parts.length) return `${parsed.origin}/`;
           parts.pop();
           return `${parsed.origin}/${parts.join("/")}/`;
         } catch (e) {
           return null;
         }
       }
 
       function buildManifestProbeUrls(segmentUrl) {
         let parsed;
         try {
           parsed = new URL(segmentUrl, window.location.href);
         } catch (e) {
           return [];
         }
 
         const results = new Set();
         const paths = parsed.pathname.split("/").filter(Boolean);
         if (!paths.length) return [];
 
         const fileName = paths[paths.length - 1] || "";
         const dirParts = paths.slice(0, -1);
 
         const parentBases = [];
         for (let i = dirParts.length; i >= Math.max(0, dirParts.length - 2); i--) {
           const prefix = dirParts.slice(0, i).join("/");
           parentBases.push(`${parsed.origin}/${prefix ? `${prefix}/` : ""}`);
         }
 
         for (const base of parentBases) {
           for (const name of MANIFEST_PROBE_NAMES) {
             results.add(new URL(name, base).toString());
           }
         }
 
         const normalized = fileName.replace(/\.([a-z0-9]{2,5})$/i, "");
         const stripped = normalized
           .replace(/[_-]?(seg|segment|chunk|frag|part)[_-]?\d+$/i, "")
           .replace(/[_-]?\d{2,6}$/i, "")
           .trim();
 
         if (stripped) {
           for (const base of parentBases) {
             results.add(new URL(`${stripped}.m3u8`, base).toString());
             results.add(new URL(`${stripped}.mpd`, base).toString());
           }
         }
 
         return Array.from(results);
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

    const groups = groupLinksByFormat(links);
    for (const group of groups) {
      const groupKey = `${videoId}:${group.name}`;
      const isExpanded = expandedGroupKeys.has(groupKey);

      const section = document.createElement("div");
      section.className = "iv-group";

      const heading = document.createElement("div");
      heading.className = "iv-group-title";
      const headingText = document.createElement("span");
      headingText.className = "iv-group-label";
      headingText.textContent = `${group.name} (${group.items.length})`;

      const hiddenCount = Math.max(0, group.items.length - 1);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "iv-group-toggle";
      toggle.textContent = isExpanded
        ? "Collapse"
        : hiddenCount > 0
          ? `Expand +${hiddenCount}`
          : "Expand";
      toggle.disabled = group.items.length <= 1;
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (expandedGroupKeys.has(groupKey)) {
          expandedGroupKeys.delete(groupKey);
        } else {
          expandedGroupKeys.add(groupKey);
        }
        renderLinks(videoId);
      });

      heading.appendChild(headingText);
      heading.appendChild(toggle);
      section.appendChild(heading);

      const visibleItems = isExpanded ? group.items : group.items.slice(0, 1);

      visibleItems.forEach((link) => {
        const item = document.createElement("div");
        item.className = "iv-item";

        const copy = document.createElement("button");
        copy.className = "iv-copy-mini";
        copy.type = "button";
        copy.textContent = "";
        copy.title = "Copy link";
        copy.setAttribute("aria-label", "Copy link");
        copy.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          copyToClipboard(link.url);
        });

        const canDownloadManifest =
          link.type === "hls" ||
          link.type === "hls-variant" ||
          (typeof link.url === "string" && link.url.toLowerCase().includes(".m3u8"));

        const downloadBtn = document.createElement("button");
        downloadBtn.className = "iv-download-mini";
        downloadBtn.type = "button";
        downloadBtn.textContent = "";
        downloadBtn.title = "Tải m3u8";
        downloadBtn.setAttribute("aria-label", "Tải m3u8");
        downloadBtn.disabled = !canDownloadManifest;
        downloadBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!canDownloadManifest) return;
          downloadM3u8Link(link);
        });

        const main = document.createElement("div");
        main.className = "iv-main";

        const name = document.createElement("div");
        name.className = "iv-name";
        name.textContent = getCompactFileName(link.url);

        const quick = document.createElement("div");
        quick.className = "iv-quick";
        quick.textContent = buildCompactMeta(link);

        main.appendChild(name);
        main.appendChild(quick);

        const infoWrap = document.createElement("div");
        infoWrap.className = "iv-info-wrap";

        const infoBtn = document.createElement("button");
        infoBtn.className = "iv-info-btn";
        infoBtn.type = "button";
        infoBtn.textContent = "";
        infoBtn.setAttribute("aria-label", "More info");

        infoBtn.addEventListener("mouseenter", () => {
          showFloatingInfo(link, infoBtn);
        });
        infoBtn.addEventListener("mousemove", (event) => {
          moveFloatingInfo(event.clientX, event.clientY);
        });
        infoBtn.addEventListener("mouseleave", () => {
          hideFloatingInfo();
        });

        infoWrap.appendChild(infoBtn);

        item.appendChild(copy);
        item.appendChild(downloadBtn);
        item.appendChild(main);
        item.appendChild(infoWrap);

        section.appendChild(item);
      });

      list.appendChild(section);
    }
  }

  function groupLinksByFormat(links) {
    const order = ["HLS", "DASH", "FILE", "SEGMENT", "BLOB", "MANIFEST", "OTHER"];
    const map = new Map();
    for (const link of links) {
      const key = getGroupName(link);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(link);
    }

    return Array.from(map.entries())
      .sort((a, b) => {
        const ai = order.indexOf(a[0]);
        const bi = order.indexOf(b[0]);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      })
      .map(([name, items]) => ({ name, items: sortGroupItems(name, items) }));
  }

  function sortGroupItems(groupName, items) {
    const arr = Array.isArray(items) ? [...items] : [];
    if (groupName === "HLS") {
      arr.sort((a, b) => compareHlsPriority(b, a));
      return arr;
    }
    arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return arr;
  }

  function compareHlsPriority(a, b) {
    const qa = getHlsQualityMetrics(a);
    const qb = getHlsQualityMetrics(b);
    if (qa.bandwidth !== qb.bandwidth) return qa.bandwidth - qb.bandwidth;
    if (qa.pixels !== qb.pixels) return qa.pixels - qb.pixels;
    if (qa.variantRank !== qb.variantRank) return qa.variantRank - qb.variantRank;
    return (qa.addedAt || 0) - (qb.addedAt || 0);
  }

  function getHlsQualityMetrics(link) {
    const bandwidth = Number.isFinite(link?.bandwidth) ? link.bandwidth : 0;
    let width = Number.isFinite(link?.width) ? link.width : 0;
    let height = Number.isFinite(link?.height) ? link.height : 0;

    if ((!width || !height) && link?.resolution) {
      const match = String(link.resolution).match(/(\d+)\s*x\s*(\d+)/i);
      if (match) {
        width = Number(match[1]) || 0;
        height = Number(match[2]) || 0;
      }
    }

    const pixels = width * height;
    const variantRank = link?.type === "hls-variant" ? 1 : 0;
    return {
      bandwidth,
      pixels,
      variantRank,
      addedAt: link?.addedAt || 0,
    };
  }

  function getGroupName(link) {
    if (!link) return "OTHER";
    if (link.type === "hls" || link.type === "hls-variant") return "HLS";
    if (link.type === "dash") return "DASH";
    if (link.type === "file") return "FILE";
    if (link.type === "segment") return "SEGMENT";
    if (link.type === "blob") return "BLOB";
    if (link.type === "manifest") return "MANIFEST";
    return "OTHER";
  }

  function getCompactFileName(url) {
    const fallback = "(no-name)";
    if (!url) return fallback;
    try {
      const parsed = new URL(url, window.location.href);
      const fileName = parsed.pathname.split("/").filter(Boolean).pop() || fallback;
      if (fileName.length <= 28) return fileName;
      return `...${fileName.slice(-25)}`;
    } catch (e) {
      if (url.length <= 28) return url;
      return `...${url.slice(-25)}`;
    }
  }

  function buildCompactMeta(link) {
    const parts = [];
    if (link.duration) parts.push(formatDuration(link.duration));
    if (link.size) parts.push(formatBytes(link.size));
    if (link.resolution) parts.push(link.resolution);
    if (link.width && link.height) parts.push(`${link.width}x${link.height}`);
    if (link.bandwidth) parts.push(formatBandwidth(link.bandwidth));
    if (link.isLive) parts.push("LIVE");
    if (link.drm) parts.push("DRM");
    return parts.join(" · ") || "—";
  }

  function ensureFloatingInfo() {
    if (floatingInfoEl) return floatingInfoEl;
    const el = document.createElement("div");
    el.className = "iv-floating-info";
    document.documentElement.appendChild(el);
    floatingInfoEl = el;
    return el;
  }

  function showFloatingInfo(link, anchor) {
    const el = ensureFloatingInfo();
    renderFloatingInfo(link, el);
    el.classList.add("iv-show");

    if (anchor && anchor.getBoundingClientRect) {
      const rect = anchor.getBoundingClientRect();
      moveFloatingInfo(rect.right + 8, rect.top + 8);
    }
  }

  function renderFloatingInfo(link, container) {
    container.innerHTML = "";

    const header = document.createElement("div");
    header.className = "iv-fi-head";
    header.textContent = link.label || link.type || "LINK";
    container.appendChild(header);

    appendInfoRow(container, "URL", link.url, "url");
    appendInfoRow(container, "Duration", link.duration ? formatDuration(link.duration) : null);
    appendInfoRow(container, "Size", link.size ? formatBytes(link.size) : null);
    appendInfoRow(container, "Bandwidth", link.bandwidth ? formatBandwidth(link.bandwidth) : null);
    appendInfoRow(container, "Resolution", link.resolution || null);
    appendInfoRow(
      container,
      "Frame",
      link.width && link.height ? `${link.width}x${link.height}` : null,
    );
    appendInfoRow(container, "Codecs", link.codecs || null, "code");
    appendInfoRow(
      container,
      "Qualities",
      Array.isArray(link.qualities) && link.qualities.length
        ? link.qualities.join(", ")
        : null,
      "quality",
    );
    appendInfoRow(container, "Source", link.initiatorType || null);
    appendInfoRow(container, "DRM", link.drm ? "yes" : "no", link.drm ? "warn" : "ok");
    appendInfoRow(container, "Live", link.isLive ? "yes" : "no", link.isLive ? "live" : "ok");
  }

  function appendInfoRow(container, key, value, tone) {
    if (value === null || value === undefined || value === "") return;
    const row = document.createElement("div");
    row.className = "iv-fi-row";

    const k = document.createElement("span");
    k.className = "iv-fi-key";
    k.textContent = key;

    const v = document.createElement("span");
    v.className = `iv-fi-val ${tone ? `is-${tone}` : ""}`.trim();
    v.textContent = String(value);

    row.appendChild(k);
    row.appendChild(v);
    container.appendChild(row);
  }

  function moveFloatingInfo(clientX, clientY) {
    if (!floatingInfoEl || !floatingInfoEl.classList.contains("iv-show")) return;

    const pad = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const maxW = Math.min(440, Math.floor(vw * 0.7));
    floatingInfoEl.style.maxWidth = `${maxW}px`;

    let left = clientX + 12;
    let top = clientY + 12;

    const rect = floatingInfoEl.getBoundingClientRect();
    if (left + rect.width > vw - pad) {
      left = Math.max(pad, clientX - rect.width - 12);
    }
    if (top + rect.height > vh - pad) {
      top = Math.max(pad, vh - rect.height - pad);
    }

    floatingInfoEl.style.left = `${left}px`;
    floatingInfoEl.style.top = `${top}px`;
  }

  function hideFloatingInfo() {
    if (!floatingInfoEl) return;
    floatingInfoEl.classList.remove("iv-show");
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

  function downloadM3u8Link(link) {
    if (!link || !link.url) return;

    const fileName = buildDownloadFileName(link.url);
    const safeFolder = normalizeSubfolder(extensionSettings.downloadSubfolder || "");
    const filename = safeFolder ? `${safeFolder}/${fileName}` : fileName;

    chrome.runtime.sendMessage(
      {
        type: "IV_DOWNLOAD_URL",
        url: link.url,
        filename,
        saveAs: !!extensionSettings.askEachTime,
      },
      (response) => {
        if (!response || !response.ok) {
          const reason = response && response.error ? `\n${response.error}` : "";
          window.alert(`Không thể tải m3u8.${reason}`);
        }
      },
    );
  }

  function buildDownloadFileName(url) {
    try {
      const parsed = new URL(url, window.location.href);
      const raw = parsed.pathname.split("/").filter(Boolean).pop() || "playlist.m3u8";
      const clean = raw.replace(/[<>:"|?*\\]/g, "_");
      if (clean.toLowerCase().endsWith(".m3u8")) return clean;
      return `${clean || "playlist"}.m3u8`;
    } catch (e) {
      return `playlist-${Date.now()}.m3u8`;
    }
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
