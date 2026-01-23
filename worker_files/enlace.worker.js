(() => {
  const DEFAULT_CONFIG = {
    assetRegistry: "worker_files/worker.assets.json",
    workerEndpoint: "https://enlace.grabem-holdem-nuts-right.workers.dev",
    workerEndpointAssetId: "asset_01J7Y2D4XABCD3EFGHJKMNPRTA",
    allowedOrigins: [
      "https://www.chattia.io",
      "https://chattia.io",
      "https://chattiavato-a11y.github.io",
    ],
    allowedOriginAssetIds: [
      "asset_01J7Y2D4XABCD3EFGHJKMNPRTB",
      "asset_01J7Y2D4XABCD3EFGHJKMNPRTC",
      "asset_01J7Y2D4XABCD3EFGHJKMNPRTD",
    ],
  };

  const CONFIG_URL = "worker_files/worker.config.json";
  let config = { ...DEFAULT_CONFIG };
  let originToAssetId = new Map();
  let configPromise = null;

  const rebuildOriginMap = () => {
    originToAssetId = new Map();
    config.allowedOrigins.forEach((origin, index) => {
      const assetId = config.allowedOriginAssetIds[index] || "";
      if (origin && assetId) {
        originToAssetId.set(origin, assetId);
      }
    });
  };

  const getAssetIdForOrigin = (origin = window.location.origin) =>
    originToAssetId.get(origin) || "";

  const loadAssetRegistry = async (registryUrl) => {
    const response = await fetch(registryUrl, { cache: "no-store" });
    if (!response.ok) return [];
    const registry = await response.json();
    if (Array.isArray(registry.assets)) return registry.assets;
    if (Array.isArray(registry)) return registry;
    return [];
  };

  const resolveAssetUrl = (assets, assetId) => {
    if (!assetId) return "";
    const asset = assets.find((entry) => entry.asset_id === assetId);
    return asset?.serving?.primary_url || asset?.source?.origin_url || "";
  };

  const loadConfig = async () => {
    try {
      const response = await fetch(CONFIG_URL, { cache: "no-store" });
      if (!response.ok) {
        rebuildOriginMap();
        return;
      }
      const data = await response.json();
      config = {
        ...config,
        ...data,
        allowedOrigins: Array.isArray(data.allowedOrigins)
          ? data.allowedOrigins
          : config.allowedOrigins,
        allowedOriginAssetIds: Array.isArray(data.allowedOriginAssetIds)
          ? data.allowedOriginAssetIds
          : config.allowedOriginAssetIds,
      };

      if (data.workerEndpointAssetId) {
        const registryUrl = data.assetRegistry || config.assetRegistry;
        const assets = await loadAssetRegistry(registryUrl);
        const resolved = resolveAssetUrl(assets, data.workerEndpointAssetId);
        if (resolved) {
          config.workerEndpoint = resolved;
        }
      }
    } catch (error) {
      console.warn("Unable to load Enlace repo config.", error);
    } finally {
      rebuildOriginMap();
    }
  };

  const init = async () => {
    if (!configPromise) {
      configPromise = loadConfig();
    }
    await configPromise;
  };

  const getEndpoint = () => config.workerEndpoint;
  const getConfig = () => ({ ...config });

  const buildHeaders = ({ accept, contentType, extraHeaders } = {}) => {
    const assetId = getAssetIdForOrigin();
    if (!assetId) {
      throw new Error(
        `Origin not registered: ${window.location.origin}. Add it to worker.config.json allowedOrigins + allowedOriginAssetIds.`
      );
    }
    const headers = new Headers();
    if (accept) headers.set("Accept", accept);
    if (contentType) headers.set("Content-Type", contentType);
    headers.set("x-ops-asset-id", assetId);
    if (extraHeaders) {
      Object.entries(extraHeaders).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          headers.set(key, value);
        }
      });
    }
    return headers;
  };

  const postChat = async (payload, options = {}) => {
    await init();
    const endpoint = getEndpoint();
    if (!endpoint) throw new Error("Worker endpoint not configured.");
    return fetch(`${endpoint}/api/chat`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: buildHeaders({
        accept: "text/event-stream",
        contentType: "application/json",
      }),
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  };

  const postVoiceSTT = async (blob, options = {}) => {
    await init();
    const endpoint = getEndpoint();
    if (!endpoint) throw new Error("Worker endpoint not configured.");
    return fetch(`${endpoint}/api/voice?mode=stt`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: buildHeaders({
        accept: "application/json",
        contentType: blob?.type || "audio/webm",
      }),
      body: blob,
      signal: options.signal,
    });
  };

  const postVoiceStream = async (payload, options = {}) => {
    await init();
    const endpoint = getEndpoint();
    if (!endpoint) throw new Error("Worker endpoint not configured.");
    return fetch(`${endpoint}/api/voice`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: buildHeaders({
        accept: "text/event-stream",
        contentType: "application/json",
      }),
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  };

  const postTTS = async (payload, options = {}) => {
    await init();
    const endpoint = getEndpoint();
    if (!endpoint) throw new Error("Worker endpoint not configured.");
    return fetch(`${endpoint}/api/tts`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: buildHeaders({
        accept: "audio/mpeg",
        contentType: "application/json",
      }),
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  };

  window.EnlaceRepo = {
    init,
    getConfig,
    getEndpoint,
    buildHeaders,
    postChat,
    postVoiceSTT,
    postVoiceStream,
    postTTS,
  };
})();
