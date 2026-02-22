(function () {
  const SOURCE = "InstallVideo";
  let counter = 1;
  let activeVideoId = null;
  const observed = new WeakSet();

  function post(type, payload) {
    window.postMessage({ source: SOURCE, type, ...payload }, "*");
  }

  function ensureId(el) {
    if (!el.dataset) return null;
    if (!el.dataset.ivId) {
      el.dataset.ivId = `iv-${counter++}`;
    }
    return el.dataset.ivId;
  }

  function registerVideo(el) {
    if (!el || observed.has(el)) return;
    observed.add(el);
    const id = ensureId(el);
    if (!id) return;

    const markActive = () => {
      activeVideoId = id;
    };

    el.addEventListener("mouseenter", markActive, { passive: true });
    el.addEventListener("pointerdown", markActive, { passive: true });
    el.addEventListener("playing", markActive, { passive: true });

    el.addEventListener("play", () => {
      activeVideoId = id;
      post("IV_MEDIA_PLAY", { id });
    });

    el.addEventListener("loadedmetadata", () => {
      activeVideoId = id;
      post("IV_MEDIA_META", {
        id,
        duration: Number.isFinite(el.duration) ? el.duration : null,
        currentSrc: el.currentSrc || el.src || null
      });
    });

    const src = el.currentSrc || el.src;
    if (src) {
      post("IV_MEDIA_SRC", { id, url: src });
    }
  }

  function isVideoLikeUrl(url) {
    if (!url || typeof url !== "string") return false;
    const lower = url.toLowerCase();
    return (
      lower.includes(".m3u8") ||
      lower.includes(".mpd") ||
      lower.match(/\.(mp4|webm|mkv|mov|m4v)(\?|$)/) ||
      lower.match(/\.(ts|m4s|aac|mp3)(\?|$)/) ||
      lower.includes("manifest") ||
      lower.includes("playlist")
    );
  }

  function handleUrl(url, initiatorType, videoId) {
    if (!isVideoLikeUrl(url)) return;
    post("IV_NET_REQUEST", { url, initiatorType, id: videoId || activeVideoId || null });
  }

  function patchFetch() {
    const originalFetch = window.fetch;
    if (!originalFetch) return;
    window.fetch = function (...args) {
      try {
        const input = args[0];
        const url = typeof input === "string" ? input : input && input.url;
        if (url) handleUrl(url, "fetch", null);
      } catch (e) {}
      return originalFetch.apply(this, args);
    };
  }

  function patchXHR() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__iv_url = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      if (this.__iv_url) {
        handleUrl(this.__iv_url, "xmlhttprequest", null);
      }
      return originalSend.apply(this, args);
    };
  }

  function patchMediaSrc() {
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
      if (desc && desc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, "src", {
          get() {
            return desc.get.call(this);
          },
          set(value) {
            const id = ensureId(this);
            if (id && value) {
              activeVideoId = id;
              post("IV_MEDIA_SRC", { id, url: String(value) });
            }
            return desc.set.call(this, value);
          }
        });
      }
    } catch (e) {}

    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this instanceof HTMLMediaElement && name === "src") {
        const id = ensureId(this);
        if (id && value) {
          activeVideoId = id;
          post("IV_MEDIA_SRC", { id, url: String(value) });
        }
      }
      return originalSetAttribute.call(this, name, value);
    };
  }

  function observeResources() {
    if (!window.PerformanceObserver) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry && entry.name) {
            handleUrl(entry.name, entry.initiatorType, null);
          }
        }
      });
      observer.observe({ type: "resource", buffered: true });
    } catch (e) {}
  }

  function scanVideos() {
    const videos = document.querySelectorAll("video");
    videos.forEach(registerVideo);
  }

  function observeVideos() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node && node.nodeType === 1) {
            if (node.tagName && node.tagName.toLowerCase() === "video") {
              registerVideo(node);
            } else if (node.querySelectorAll) {
              node.querySelectorAll("video").forEach(registerVideo);
            }
          }
        }
      }
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  patchFetch();
  patchXHR();
  patchMediaSrc();
  observeResources();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      scanVideos();
      observeVideos();
    });
  } else {
    scanVideos();
    observeVideos();
  }
})();
