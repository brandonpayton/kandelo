/**
 * Unified Service Worker — dual-mode file that serves as both:
 *
 * 1. Page bootstrap script (when loaded via <script> tag):
 *    Detects if crossOriginIsolated is false, registers itself as a SW,
 *    then reloads the page so SharedArrayBuffer works.
 *
 * 2. Service Worker (when registered):
 *    - Adds COOP/COEP/CORP headers to ALL fetch responses → enables SharedArrayBuffer
 *    - Handles HTTP bridge for nginx/wordpress/lamp demos (MessagePort from page)
 *    - Includes cookie jar for WordPress sessions
 *    - Revalidates navigation requests to ensure fresh HTML (cache busting)
 *    - Auto-restores bridge after browser terminates and restarts the SW
 */

// ============================================================
// Mode 1: Page script — register this file as a service worker
// ============================================================
if (typeof window !== "undefined") {
  if ("serviceWorker" in navigator) {
    // document.currentScript is the deployment-owned authority for this
    // classic bootstrap. Its directory, not the page URL or a message, owns
    // the registration scope.
    var bootstrapScriptUrl = document.currentScript && document.currentScript.src;
    if (bootstrapScriptUrl) {
      var expectedBootstrapScriptUrl = new URL(bootstrapScriptUrl).href;
      var expectedBootstrapScopePath = new URL(
        "./",
        expectedBootstrapScriptUrl,
      ).pathname;
      var expectedBootstrapScopeUrl = new URL(
        expectedBootstrapScopePath,
        window.location.href,
      ).href;

      function waitForBootstrapActive(registration) {
        return new Promise(function (resolve, reject) {
          var observedWorkers = [];
          function cleanup() {
            registration.removeEventListener("updatefound", check);
            observedWorkers.forEach(function (worker) {
              worker.removeEventListener("statechange", check);
            });
          }
          function observe(worker) {
            if (!worker || observedWorkers.indexOf(worker) !== -1) return;
            observedWorkers.push(worker);
            worker.addEventListener("statechange", check);
          }
          function check() {
            observe(registration.installing);
            observe(registration.waiting);
            observe(registration.active);
            if (!registration.active) return;
            cleanup();
            if (registration.active.scriptURL !== expectedBootstrapScriptUrl) {
              reject(new Error("registered service worker active script mismatch"));
              return;
            }
            resolve(registration);
          }
          registration.addEventListener("updatefound", check);
          check();
        });
      }

      function waitForBootstrapController(registration) {
        return new Promise(function (resolve) {
          function check() {
            var controller = navigator.serviceWorker.controller;
            if (!controller || controller.scriptURL !== expectedBootstrapScriptUrl) {
              return;
            }
            navigator.serviceWorker.removeEventListener(
              "controllerchange",
              check,
            );
            resolve(registration);
          }
          navigator.serviceWorker.addEventListener("controllerchange", check);
          check();
        });
      }

      navigator.serviceWorker
        .register(expectedBootstrapScriptUrl, {
          scope: expectedBootstrapScopePath,
          updateViaCache: "none",
        })
        .then(function (registration) {
          if (registration.scope !== expectedBootstrapScopeUrl) {
            throw new Error("registered service worker scope mismatch");
          }
          return waitForBootstrapActive(registration);
        })
        .then(waitForBootstrapController)
        .then(function (registration) {
          if (window.crossOriginIsolated) {
            return registration.update();
          }
          window.location.reload();
        })
        .catch(function (err) {
          console.warn("[COI SW] registration failed:", err);
        });
    }
  }
  // Stop executing — the rest is service worker code
} else {
  // ============================================================
  // Mode 2: Service Worker
  // ============================================================

  // The registration scope is the durable ownership authority. Keep this
  // validator equivalent to normalizeDeploymentBase in kandelo-session: the
  // classic worker cannot import the TypeScript helper at runtime.
  function normalizeScopePath(value) {
    if (
      typeof value !== "string" || value === "" ||
      !value.startsWith("/") || !value.endsWith("/")
    ) {
      throw new Error("service worker registration scope path is invalid");
    }
    var sentinelOrigin = "https://kandelo.invalid";
    var parsed = new URL(value, sentinelOrigin);
    if (parsed.origin !== sentinelOrigin || parsed.pathname !== value) {
      throw new Error("service worker registration scope path is invalid");
    }
    if (value === "/") return value;

    var segments = value.slice(1, -1).split("/");
    if (segments.some(function (segment) { return segment === ""; })) {
      throw new Error("service worker registration scope path is invalid");
    }
    var percentEscape = /%[0-9a-f]{2}/i;
    segments.forEach(function (segment) {
      var decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch (_error) {
        throw new Error("service worker registration scope path is invalid");
      }
      if (
        decoded === "." || decoded === ".." || decoded.indexOf("/") !== -1 ||
        decoded.indexOf("\\") !== -1 || decoded.indexOf("\0") !== -1 ||
        percentEscape.test(decoded)
      ) {
        throw new Error("service worker registration scope path is invalid");
      }
    });
    return value;
  }

  function registrationScopePath() {
    var registrationUrl = new URL(self.registration.scope);
    var workerUrl = new URL(self.location.href);
    if (
      (registrationUrl.protocol !== "http:" &&
        registrationUrl.protocol !== "https:") ||
      (workerUrl.protocol !== "http:" && workerUrl.protocol !== "https:") ||
      registrationUrl.origin === "null" || workerUrl.origin === "null" ||
      registrationUrl.origin !== workerUrl.origin ||
      registrationUrl.username !== "" || registrationUrl.password !== "" ||
      registrationUrl.search !== "" || registrationUrl.hash !== ""
    ) {
      throw new Error("service worker registration scope authority is invalid");
    }
    return normalizeScopePath(registrationUrl.pathname);
  }

  var SCOPE_PATH = registrationScopePath();
  var CACHE_NAMESPACE = "kandelo-sw:" + encodeURIComponent(SCOPE_PATH) + ":";
  var BRIDGE_CACHE = CACHE_NAMESPACE + "bridge-v2";
  var BRIDGE_AUTHORITY_KEY = "bridge-authority-v1";
  var SECONDARY_AUTHORITIES_KEY = "bridge-secondary-authorities-v1";
  var SECONDARY_AUTHORITY_LIMIT = 4;
  var BRIDGE_AUTHORITY_VERSION = 1;
  var BRIDGE_AUTHORITY_MAX_BYTES = 64 * 1024;
  var BRIDGE_AUTHORITY_MAX_COOKIES = 32;
  var BRIDGE_APP_PREFIX_MAX_BYTES = 4096;
  var BRIDGE_COOKIE_NAME_MAX_BYTES = 256;
  var BRIDGE_COOKIE_VALUE_MAX_BYTES = 4096;
  var BRIDGE_COOKIE_PATH_MAX_BYTES = 4096;
  var BRIDGE_REVISION_LIMIT = Number.MAX_SAFE_INTEGER;
  var COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  var INVALID_COOKIE_FIELD_PATTERN = /[\u0000-\u001f\u007f;]/;
  // Grouped builds replace this authenticated manifest digest. Ungrouped
  // deployments retain the established cache name.
  var LAZY_ASSET_CACHE_VERSION = null /*__KANDELO_VFS_LAZY_CACHE_VERSION__*/;
  var LAZY_ASSET_CACHE = CACHE_NAMESPACE +
    (LAZY_ASSET_CACHE_VERSION === null
      ? "lazy-assets-v1"
      : "lazy-assets-v1:" + LAZY_ASSET_CACHE_VERSION);
  var SESSION_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function utf8ByteLength(value) {
    return new TextEncoder().encode(value).byteLength;
  }

  function isValidAppPrefix(value) {
    if (
      typeof value !== "string" ||
      utf8ByteLength(value) > BRIDGE_APP_PREFIX_MAX_BYTES
    ) {
      return false;
    }
    try {
      var normalized = normalizeScopePath(value);
      return normalized !== SCOPE_PATH && normalized.startsWith(SCOPE_PATH);
    } catch (_error) {
      return false;
    }
  }

  function isValidSessionId(value) {
    return typeof value === "string" && SESSION_ID_PATTERN.test(value);
  }

  function isBridgeMessagePort(value) {
    return value && typeof value.postMessage === "function";
  }

  function postInvalidScopeConfig(target) {
    if (!isBridgeMessagePort(target)) return;
    target.postMessage({
      type: "bridge-error",
      code: "invalid-scope-config",
    });
  }

  // --- Bridge state (MessagePort-based HTTP protocol) ---
  var bridgePort = null;
  var pendingRequests = new Map();
  var nextRequestId = 0;
  var appPrefix = SCOPE_PATH + "app/";
  // Set to true once a bridge has been configured (via init-bridge or cache restore).
  // Used to distinguish "never configured" from "configured but SW restarted".
  var bridgeConfigured = false;
  var appClientIds = new Set();
  // Two same-profile windows share this one worker. Live bridges that a later
  // registration displaced are kept here by sessionId so their own clients
  // keep routing to their own machine instead of the machine that registered
  // last. Secondary jars are in-memory only; the durable authority always
  // belongs to the current bridge.
  var secondaryBridges = new Map();
  // SW client id → owning sessionId. A page maps itself on init-bridge and
  // the documents it navigates inherit the mapping in markAppClient.
  var clientSessions = new Map();

  // --- Bridge restoration state ---
  // Single in-flight restoration promise, shared by concurrent fetch events
  var bridgeRestorePromise = null;
  // Advances with a successful queued init commit. Restoration and init use
  // the mutation queue's order rather than changing intent around a claimed put.
  var bridgeIntentVersion = 0;
  // Changes only when a different live bridge/session is installed. Cookie
  // writes capture this epoch so obsolete ports cannot persist into a successor.
  var liveBridgeEpoch = 0;
  // Restoration resolves at the authority commit, but a demoted machine's
  // answer — the only thing that can map that machine's clients — may still
  // be in postMessage transit. A fetch whose client is unmapped while an
  // attempt is open waits for its own mapping (or this grace), never for the
  // whole attempt. clientId → resolvers.
  var clientMappingWaiters = new Map();
  var openRestorationAttempts = 0;
  var CLIENT_MAPPING_GRACE_MS = 1000;

  function resolveClientMappingWaiters(clientId) {
    var waiters = clientMappingWaiters.get(clientId);
    if (!waiters) return;
    clientMappingWaiters.delete(clientId);
    waiters.forEach(function (waiter) {
      waiter();
    });
  }

  function flushClientMappingWaiters() {
    var flushed = [];
    clientMappingWaiters.forEach(function (waiters) {
      flushed.push.apply(flushed, waiters);
    });
    clientMappingWaiters.clear();
    flushed.forEach(function (waiter) {
      waiter();
    });
  }

  function waitForClientMapping(clientId) {
    if (!clientId || clientSessions.has(clientId)) return Promise.resolve();
    if (openRestorationAttempts === 0) return Promise.resolve();
    return new Promise(function (resolve) {
      var grace;
      function settle() {
        clearTimeout(grace);
        var waiters = clientMappingWaiters.get(clientId);
        if (waiters) {
          var index = waiters.indexOf(settle);
          if (index !== -1) waiters.splice(index, 1);
          if (waiters.length === 0) clientMappingWaiters.delete(clientId);
        }
        resolve();
      }
      grace = setTimeout(settle, CLIENT_MAPPING_GRACE_MS);
      var waiters = clientMappingWaiters.get(clientId);
      if (!waiters) {
        waiters = [];
        clientMappingWaiters.set(clientId, waiters);
      }
      waiters.push(settle);
    });
  }
  // The only record restart trusts. Legacy records are migration inputs and
  // cleanup candidates, never authority once this record exists.
  var durableAuthority = null;
  var legacyBridgeMigrationAllowed = false;
  var bridgeStorageReadable = true;

  // Names used only to recognize the Task 3 pre-authority cookie records during
  // one-time migration and best-effort cleanup. New state is never split across
  // these keys. (No ":" in the legacy key — a "name:rest" string parses as a
  // URL scheme when Cache Storage resolves it.)
  var COOKIE_JAR_KEY_PREFIX = "cookie-jar-";
  // The session whose cookie jar is currently loaded in memory. Learned from
  // the page via init-bridge / bridge-restored; null until the bridge connects.
  var currentSessionId = null;
  // Resolves once the current session's jar has been installed.
  var cookieJarReady = Promise.resolve();

  // Eagerly validate the complete authority so its prefix can identify bridged
  // requests after a worker restart. The jar stays durable-only until a client
  // explicitly restores the exact authority prefix and session.
  var appPrefixReady = caches.open(BRIDGE_CACHE).then(function (cache) {
    return cache.match(BRIDGE_AUTHORITY_KEY).then(function (response) {
      if (response) {
        return response.text().then(function (text) {
          var authority = bridgeAuthorityFromJson(text);
          if (authority) {
            durableAuthority = authority;
            appPrefix = authority.appPrefix;
            bridgeConfigured = true;
          }
          // A present-but-invalid authority is quarantined. Never combine it
          // with older prefix/jar records to manufacture hybrid restart state.
        });
      }
      legacyBridgeMigrationAllowed = true;
      // Accept the Task 3 pre-authority record only as a migration input when
      // the complete authority key is genuinely absent.
      return cache.match("app-prefix").then(function (legacyResponse) {
        return legacyResponse ? legacyResponse.text() : null;
      }).then(function (prefix) {
        if (isValidAppPrefix(prefix)) {
          appPrefix = prefix;
          bridgeConfigured = true;
        }
      });
    });
  }).catch(function () {
    // Without a complete read, a later init cannot safely replace unknown
    // authority bytes with an empty jar. Fail transitions until worker restart.
    bridgeStorageReadable = false;
  });
  // Every authoritative write and live bridge transition uses this one queue.
  var stateMutationQueue = appPrefixReady;

  // --- Cookie jar ---
  // (Set-Cookie on synthetic SW responses is ignored by the browser,
  // so the SW stores cookies and injects them into outgoing requests)
  //
  // Keyed by name AND path: cookies are identified by (name, domain, path) per
  // RFC 6265. WordPress sets the same auth cookie name for both /wp-admin
  // (ADMIN_COOKIE_PATH) and /wp-content/plugins (PLUGINS_COOKIE_PATH); keying by
  // name alone would drop one, breaking auth for that subtree. Domain is always
  // this origin, so name + path is a sufficient key.
  var cookieJar = new Map();

  function cookieKey(cookie) {
    return cookie.name + "\n" + cookie.path;
  }

  function isValidCookieRecord(cookie) {
    return Boolean(cookie) &&
      typeof cookie.name === "string" &&
      COOKIE_NAME_PATTERN.test(cookie.name) &&
      utf8ByteLength(cookie.name) <= BRIDGE_COOKIE_NAME_MAX_BYTES &&
      typeof cookie.value === "string" &&
      !INVALID_COOKIE_FIELD_PATTERN.test(cookie.value) &&
      utf8ByteLength(cookie.value) <= BRIDGE_COOKIE_VALUE_MAX_BYTES &&
      typeof cookie.path === "string" && cookie.path.startsWith(SCOPE_PATH) &&
      !INVALID_COOKIE_FIELD_PATTERN.test(cookie.path) &&
      utf8ByteLength(cookie.path) <= BRIDGE_COOKIE_PATH_MAX_BYTES &&
      (cookie.expires === undefined || (
        typeof cookie.expires === "number" && isFinite(cookie.expires)
      ));
  }

  function parseSetCookie(header) {
    var parts = header.split(";").map(function (s) {
      return s.trim();
    });
    if (parts.length === 0) return null;
    var eqIdx = parts[0].indexOf("=");
    if (eqIdx < 0) return null;
    var name = parts[0].slice(0, eqIdx);
    var value = parts[0].slice(eqIdx + 1);
    var path = "/";
    var expires;
    for (var i = 1; i < parts.length; i++) {
      var lower = parts[i].toLowerCase();
      if (lower.startsWith("path=")) {
        path = parts[i].slice(5);
      } else if (lower.startsWith("expires=")) {
        var d = new Date(parts[i].slice(8));
        if (!isNaN(d.getTime())) expires = d.getTime();
      } else if (lower.startsWith("max-age=")) {
        var seconds = parseInt(parts[i].slice(8));
        if (!isNaN(seconds)) expires = Date.now() + seconds * 1000;
      }
    }
    return { name: name, value: value, path: path, expires: expires };
  }

  // Returns true if the jar was mutated, so callers can persist it.
  function storeCookies(targetJar, targetAppPrefix, setCookieValues) {
    var mutated = false;
    for (var j = 0; j < setCookieValues.length; j++) {
      var cookie = parseSetCookie(setCookieValues[j]);
      if (!cookie) continue;
      // Prepend app prefix to cookie path so it matches browser-side URLs.
      // WordPress sets paths like "/" or "/wp-admin/" but the browser sees
      // "/app/" or "/app/wp-admin/".
      var prefix = targetAppPrefix.slice(0, -1); // "/app" (or "/base/app")
      if (!cookie.path.startsWith(prefix)) {
        cookie.path = prefix + cookie.path;
      }
      if (!isValidCookieRecord(cookie)) continue;
      // Identify by name + path so same-name cookies on different paths coexist.
      var key = cookieKey(cookie);
      if (cookie.expires !== undefined && cookie.expires < Date.now()) {
        if (targetJar.delete(key)) mutated = true;
      } else {
        var existing = targetJar.get(key);
        if (!existing && targetJar.size >= BRIDGE_AUTHORITY_MAX_COOKIES) {
          continue;
        }
        if (
          !existing || existing.value !== cookie.value ||
          existing.expires !== cookie.expires
        ) {
          targetJar.set(key, cookie);
          mutated = true;
        }
      }
    }
    return mutated;
  }

  function matchCookiesForPath(jar, path, onExpiredKeys) {
    var matches = [];
    var expiredKeys = [];
    jar.forEach(function (cookie, key) {
      if (cookie.expires !== undefined && cookie.expires < Date.now()) {
        expiredKeys.push(key);
        return;
      }
      if (path.startsWith(cookie.path)) {
        matches.push(cookie);
      }
    });
    if (expiredKeys.length > 0) {
      onExpiredKeys(expiredKeys);
    }
    // RFC 6265: when several cookies match, list longer paths first.
    matches.sort(function (a, b) {
      return b.path.length - a.path.length;
    });
    return matches
      .map(function (cookie) {
        return cookie.name + "=" + cookie.value;
      })
      .join("; ");
  }

  function getCookiesForPath(path, bridgeEpoch, sessionId) {
    // Expiration persistence uses the same authority queue and epoch guard as
    // Set-Cookie. It is non-blocking for this outgoing request.
    return matchCookiesForPath(cookieJar, path, function (expiredKeys) {
      scheduleCookieJarMutation(
        bridgeEpoch,
        sessionId,
        function (nextJar) {
          var mutated = false;
          expiredKeys.forEach(function (key) {
            if (nextJar.delete(key)) mutated = true;
          });
          return mutated;
        },
      ).catch(function () {});
    });
  }

  function secondaryCookiesForPath(bridge, path) {
    return matchCookiesForPath(bridge.cookieJar, path, function (expiredKeys) {
      expiredKeys.forEach(function (key) {
        bridge.cookieJar.delete(key);
      });
    });
  }

  // --- Authoritative bridge persistence (survives SW termination/restart) ---
  function cookieJarKeyFor(sessionId) {
    if (!isValidSessionId(sessionId)) {
      throw new Error("service worker bridge session id is invalid");
    }
    return COOKIE_JAR_KEY_PREFIX + sessionId;
  }

  function cookieRecordsFromJar(jar) {
    var records = [];
    jar.forEach(function (cookie) {
      records.push(cookie);
    });
    return records;
  }

  function cookieJarFromRecords(records) {
    if (
      !Array.isArray(records) ||
      records.length > BRIDGE_AUTHORITY_MAX_COOKIES
    ) {
      return null;
    }
    var restored = new Map();
    var now = Date.now();
    for (var i = 0; i < records.length; i++) {
      var cookie = records[i];
      if (!isValidCookieRecord(cookie)) return null;
      if (cookie.expires !== undefined && cookie.expires < now) continue;
      restored.set(cookieKey(cookie), cookie);
    }
    return restored;
  }

  function cloneCookieJar(jar) {
    var clone = new Map();
    jar.forEach(function (cookie, key) {
      clone.set(key, {
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        expires: cookie.expires,
      });
    });
    return clone;
  }

  function cookieJarFromJson(text) {
    if (!text) return new Map();
    try {
      return cookieJarFromRecords(JSON.parse(text)) || new Map();
    } catch (_error) {
      return new Map();
    }
  }

  function bridgeAuthorityFromJson(text) {
    if (
      !text || utf8ByteLength(text) > BRIDGE_AUTHORITY_MAX_BYTES
    ) {
      return null;
    }
    try {
      var record = JSON.parse(text);
      if (
        !record || record.version !== BRIDGE_AUTHORITY_VERSION ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 ||
        record.revision >= BRIDGE_REVISION_LIMIT ||
        !isValidAppPrefix(record.appPrefix) ||
        !isValidSessionId(record.sessionId)
      ) {
        return null;
      }
      var restoredJar = cookieJarFromRecords(record.cookies);
      if (!restoredJar) return null;
      return {
        version: BRIDGE_AUTHORITY_VERSION,
        revision: record.revision,
        appPrefix: record.appPrefix,
        sessionId: record.sessionId,
        cookieJar: restoredJar,
      };
    } catch (_error) {
      return null;
    }
  }

  function nextBridgeAuthority(nextAppPrefix, nextSessionId, nextCookieJar) {
    var nextRevision = durableAuthority ? durableAuthority.revision + 1 : 1;
    if (
      !Number.isSafeInteger(nextRevision) || nextRevision < 0 ||
      nextRevision >= BRIDGE_REVISION_LIMIT
    ) {
      throw new Error("service worker bridge revision limit reached");
    }
    return {
      version: BRIDGE_AUTHORITY_VERSION,
      revision: nextRevision,
      appPrefix: nextAppPrefix,
      sessionId: nextSessionId,
      cookieJar: nextCookieJar,
    };
  }

  function bridgeAuthorityResponse(authority) {
    var text = JSON.stringify({
      version: authority.version,
      revision: authority.revision,
      appPrefix: authority.appPrefix,
      sessionId: authority.sessionId,
      cookies: cookieRecordsFromJar(authority.cookieJar),
    });
    if (!bridgeAuthorityFromJson(text)) {
      throw new Error("service worker bridge authority is outside its bounds");
    }
    return new Response(text, {
      headers: { "Content-Type": "application/json" },
    });
  }

  function writeBridgeAuthority(authority) {
    // Validate and materialize all bytes before Cache Storage is touched.
    var response = bridgeAuthorityResponse(authority);
    return caches.open(BRIDGE_CACHE).then(function (cache) {
      // This replacement is the sole durable linearization point. The response
      // contains the complete prefix/session/jar authority restart will trust.
      return cache.put(
        BRIDGE_AUTHORITY_KEY,
        response,
      ).then(function () {
        return cache;
      });
    });
  }

  function enqueueStateMutation(operation) {
    var mutation = stateMutationQueue.then(operation);
    stateMutationQueue = mutation.catch(function () {});
    return mutation;
  }

  // Sessions whose live bridge was demoted rather than ended. A restarted
  // worker trusts a restoration answer only against a durable record —
  // without these, a demoted machine's answer is indistinguishable from a
  // stale one, and its page loses its bridge whenever the browser reclaims
  // an idle worker while two machines share this scope.
  function readSecondaryAuthorities() {
    return caches.open(BRIDGE_CACHE).then(function (cache) {
      return cache.match(SECONDARY_AUTHORITIES_KEY);
    }).then(function (response) {
      if (!response) return [];
      return response.text().then(function (text) {
        try {
          var records = JSON.parse(text);
          if (!Array.isArray(records)) return [];
          return records.filter(function (record) {
            return record && isValidAppPrefix(record.appPrefix) &&
              isValidSessionId(record.sessionId);
          });
        } catch (_error) {
          return [];
        }
      });
    }).catch(function () {
      return [];
    });
  }

  function writeSecondaryAuthorities(records) {
    return caches.open(BRIDGE_CACHE).then(function (cache) {
      return cache.put(
        SECONDARY_AUTHORITIES_KEY,
        new Response(JSON.stringify(records), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }).catch(function () {});
  }

  function recordSecondaryAuthority(recordedAppPrefix, recordedSessionId) {
    return readSecondaryAuthorities().then(function (records) {
      var kept = records.filter(function (record) {
        return record.sessionId !== recordedSessionId;
      });
      kept.push({
        appPrefix: recordedAppPrefix,
        sessionId: recordedSessionId,
      });
      return writeSecondaryAuthorities(
        kept.slice(-SECONDARY_AUTHORITY_LIMIT),
      );
    });
  }

  function eraseSecondaryAuthority(erasedSessionId) {
    return readSecondaryAuthorities().then(function (records) {
      var kept = records.filter(function (record) {
        return record.sessionId !== erasedSessionId;
      });
      if (kept.length === records.length) return undefined;
      return writeSecondaryAuthorities(kept);
    });
  }

  function readLegacyCookieJarForSession(sessionId) {
    return caches.open(BRIDGE_CACHE).then(function (cache) {
      return cache.match(cookieJarKeyFor(sessionId));
    }).then(function (response) {
      return response ? response.text().then(cookieJarFromJson) : new Map();
    });
  }

  function bridgeCacheEntryName(request) {
    return new URL(request.url).pathname.split("/").pop() || "";
  }

  function startLegacyBridgeCleanup(cache) {
    return cache.keys().then(function (requests) {
      return requests.filter(function (request) {
        var name = bridgeCacheEntryName(request);
        return name === "app-prefix" ||
          name.indexOf(COOKIE_JAR_KEY_PREFIX) === 0;
      }).reduce(function (ready, request) {
        return ready.then(function () {
          return cache.delete(request);
        });
      }, Promise.resolve());
    }).catch(function () {
      // Legacy cleanup is never part of authority or readiness correctness.
    });
  }

  function prepareBridgeTransition(nextAppPrefix, nextSessionId) {
    if (!bridgeStorageReadable) {
      return Promise.reject(
        new Error("service worker bridge authority could not be read"),
      );
    }
    var jarReady;
    if (durableAuthority) {
      jarReady = Promise.resolve(
        durableAuthority.sessionId === nextSessionId
          ? cloneCookieJar(durableAuthority.cookieJar)
          : new Map(),
      );
    } else if (legacyBridgeMigrationAllowed) {
      jarReady = readLegacyCookieJarForSession(nextSessionId);
    } else {
      jarReady = Promise.resolve(new Map());
    }
    return jarReady.then(function (nextCookieJar) {
      return nextBridgeAuthority(
        nextAppPrefix,
        nextSessionId,
        nextCookieJar,
      );
    });
  }

  function scheduleCookieJarMutation(
    bridgeEpoch,
    sessionId,
    mutateJar,
  ) {
    return enqueueStateMutation(function () {
      if (
        bridgeEpoch !== liveBridgeEpoch || sessionId !== currentSessionId ||
        !durableAuthority || durableAuthority.sessionId !== sessionId
      ) {
        return false;
      }
      var nextJar = cloneCookieJar(cookieJar);
      if (!mutateJar(nextJar, appPrefix)) return false;
      var authority = nextBridgeAuthority(appPrefix, sessionId, nextJar);
      return writeBridgeAuthority(authority).then(function () {
        // No await follows the durable commit. Keep its in-memory mirror even
        // if a synchronous navigation reset advanced the live epoch meanwhile,
        // but never let that obsolete write repopulate the cleared live jar.
        durableAuthority = authority;
        if (
          bridgeEpoch === liveBridgeEpoch && sessionId === currentSessionId
        ) {
          cookieJar = nextJar;
          return true;
        }
        return false;
      });
    });
  }

  // Forget the in-memory session so the next page's requests carry no cookies
  // until it establishes its own session. Durable authority remains available
  // for an explicit, validated restoration.
  function resetSessionState() {
    liveBridgeEpoch += 1;
    currentSessionId = null;
    cookieJar = new Map();
    cookieJarReady = Promise.resolve();
  }

  // --- Bridge port setup ---
  function wireBridgePort(port) {
    port.onmessage = function (event) {
      var msg = event.data;
      if (msg && msg.type === "http-response") {
        var pending = pendingRequests.get(msg.requestId);
        if (pending) {
          pendingRequests.delete(msg.requestId);
          pending.resolve({
            status: msg.status,
            headers: msg.headers,
            body: msg.body,
          });
        }
      } else if (msg && msg.type === "http-error") {
        var pending2 = pendingRequests.get(msg.requestId);
        if (pending2) {
          pendingRequests.delete(msg.requestId);
          pending2.reject(new Error(msg.error || "Bridge request failed"));
        }
      }
    };
  }

  // A newcomer must not strand a still-open page: the displaced bridge moves
  // to the secondary registry so clients mapped to its session keep routing
  // to their own machine. The caller chooses the jar the demoted bridge
  // keeps: the live jar on a replacement init, an empty jar on a navigation
  // reset (the reset's promise is that no cookie survives it).
  function demoteCurrentBridge(jar) {
    if (!bridgePort || !currentSessionId) return;
    secondaryBridges.set(currentSessionId, {
      port: bridgePort,
      appPrefix: appPrefix,
      sessionId: currentSessionId,
      cookieJar: jar,
    });
    // Captured now: the caller reassigns both the moment this returns. The
    // write queues behind the running mutation rather than racing it.
    var recordedPrefix = appPrefix;
    var recordedSession = currentSessionId;
    enqueueStateMutation(function () {
      return recordSecondaryAuthority(recordedPrefix, recordedSession);
    });
  }

  // A page boots one machine at a time, so when a page replaces its own
  // bridge the previous machine is dead: its port must not survive as a
  // secondary and no demotion record may claim it is a live machine.
  function retireCurrentBridge() {
    if (!bridgePort || !currentSessionId) return;
    var retired = currentSessionId;
    clientSessions.forEach(function (owner, clientId) {
      if (owner === retired) clientSessions.delete(clientId);
    });
    bridgePort = null;
  }

  function commitBridgeState(port, authority) {
    if (currentSessionId !== authority.sessionId) {
      demoteCurrentBridge(cookieJar);
    }
    secondaryBridges.delete(authority.sessionId);
    // The committed session is the primary again; a demotion record left
    // standing would let a stale restoration answer shadow it after the next
    // worker restart.
    enqueueStateMutation(function () {
      return eraseSecondaryAuthority(authority.sessionId);
    });
    appPrefix = authority.appPrefix;
    bridgeConfigured = true;
    currentSessionId = authority.sessionId;
    cookieJar = authority.cookieJar;
    cookieJarReady = Promise.resolve();
    liveBridgeEpoch += 1;
    wireBridgePort(port);
    bridgePort = port;
  }

  function scheduleBridgeTransition(
    port,
    replyPort,
    nextAppPrefix,
    nextSessionId,
    initiatorPriorSession,
  ) {
    return enqueueStateMutation(function () {
      return prepareBridgeTransition(nextAppPrefix, nextSessionId).then(
        function (authority) {
          return writeBridgeAuthority(authority).then(function (cache) {
            // cache.put above is the commit point. Do not await anything between
            // it and in-memory authority, live bridge, and readiness.
            durableAuthority = authority;
            legacyBridgeMigrationAllowed = false;
            bridgeIntentVersion += 1;
            if (
              initiatorPriorSession &&
              initiatorPriorSession === currentSessionId
            ) {
              retireCurrentBridge();
            }
            commitBridgeState(port, authority);
            replyPort.postMessage({ type: "bridge-ready" });
            // Legacy bytes are no longer authoritative; cleanup is best effort.
            startLegacyBridgeCleanup(cache);
          });
        },
      );
    });
  }

  function bridgeFetchOn(port, request) {
    var requestId = nextRequestId++;
    return new Promise(function (resolve, reject) {
      pendingRequests.set(requestId, { resolve: resolve, reject: reject });
      port.postMessage({
        type: "http-request",
        requestId: requestId,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
      });
    });
  }

  function bridgeFetch(request) {
    if (!bridgePort) {
      return Promise.reject(new Error("Bridge port not initialized"));
    }
    return bridgeFetchOn(bridgePort, request);
  }

  // --- Bridge restoration ---
  // When the browser terminates and restarts this SW, bridgePort is lost.
  // These functions ask a client page to re-establish the bridge.

  function ensureBridge() {
    if (bridgePort) return Promise.resolve(true);
    if (bridgeRestorePromise) return bridgeRestorePromise;

    bridgeRestorePromise = requestBridgeFromClient().then(function (result) {
      bridgeRestorePromise = null;
      return result;
    }).catch(function () {
      bridgeRestorePromise = null;
      return false;
    });
    return bridgeRestorePromise;
  }

  function requestBridgeFromClient() {
    var restoreObservation = {
      intent: bridgeIntentVersion,
      authorityRevision: durableAuthority ? durableAuthority.revision : null,
      liveEpoch: liveBridgeEpoch,
    };
    return self.clients.matchAll({ type: "window" }).then(function (allClients) {
      if (allClients.length === 0) return false;

      return new Promise(function (resolve) {
        var attemptState = "discovering";
        var responsePorts = [];
        var candidateQueue = Promise.resolve();
        var timeout;
        openRestorationAttempts += 1;

        function closeResponsePorts() {
          responsePorts.forEach(function (port) {
            port.onmessage = null;
            port.close();
          });
          responsePorts = [];
        }

        function finish(result) {
          if (attemptState === "settled") return;
          attemptState = "settled";
          clearTimeout(timeout);
          closeResponsePorts();
          openRestorationAttempts -= 1;
          flushClientMappingWaiters();
          resolve(result);
        }

        function attemptIsDiscovering() {
          return attemptState === "discovering";
        }

        function attemptAcceptsCandidates() {
          return attemptState !== "settled";
        }

        function claimAttemptForCommit() {
          if (!attemptIsDiscovering()) return false;
          // Cache.put cannot be canceled. Once this queued candidate owns the
          // commit, discovery timeout and later candidates must stand behind it.
          attemptState = "committing";
          clearTimeout(timeout);
          return true;
        }

        // The committed authority answers the fetch that started this
        // attempt immediately — a hold here would let a pending init
        // overtake the fetch this attempt already committed a bridge for.
        // But it is not the only machine that answered: the other machines'
        // candidates may still be in postMessage transit, so the attempt
        // keeps listening. Each late candidate that matches a demotion
        // record installs as a secondary and maps its clients; a fetch
        // whose client is not yet mapped waits on that mapping in
        // fetchRestoredAppRequest, never on this attempt.
        function beginLingering() {
          if (attemptState !== "discovering" && attemptState !== "committing") {
            return;
          }
          attemptState = "lingering";
          clearTimeout(timeout);
          timeout = setTimeout(function () {
            finish(true);
          }, 5000);
          resolve(true);
        }

        timeout = setTimeout(function () {
          if (attemptIsDiscovering()) finish(false);
        }, 5000);

        allClients.forEach(function (client) {
          var ch = new MessageChannel();
          responsePorts.push(ch.port1);
          ch.port1.onmessage = function (event) {
            var data = event.data;
            var candidatePort = event.ports[0];
            if (!attemptAcceptsCandidates()) {
              if (candidatePort && typeof candidatePort.close === "function") {
                candidatePort.close();
              }
              return;
            }
            if (data && data.type === "bridge-restored") {
              if (
                !isValidAppPrefix(data.appPrefix) ||
                !isValidSessionId(data.sessionId) ||
                !isBridgeMessagePort(candidatePort)
              ) {
                postInvalidScopeConfig(event.source);
                if (
                  candidatePort && typeof candidatePort.close === "function"
                ) {
                  candidatePort.close();
                }
                return;
              }
              // The answering window is a client of the session it answers
              // for. The map died with the terminated worker; this rebuilds
              // it. An existing mapping is never overwritten: an init-bridge
              // is the client's freshest declaration, and a delayed
              // restoration answer must not displace it.
              if (!clientSessions.has(client.id)) {
                clientSessions.set(client.id, data.sessionId);
              }
              // Candidates are evaluated in arrival order. A well-formed but
              // stale tab does not settle the attempt or starve later clients.
              candidateQueue = candidateQueue.then(function () {
                if (!attemptAcceptsCandidates()) {
                  candidatePort.close();
                  return;
                }
                return scheduleBridgeRestoration(
                  candidatePort,
                  data.appPrefix,
                  data.sessionId,
                  restoreObservation,
                  attemptIsDiscovering,
                  claimAttemptForCommit,
                ).then(function (result) {
                  if (!result.installed) candidatePort.close();
                  if (result.satisfied) beginLingering();
                  else if (attemptState === "committing") finish(false);
                  // The mapping decision for this candidate's client is
                  // final; a fetch waiting on it routes now.
                  resolveClientMappingWaiters(client.id);
                });
              }).catch(function () {
                candidatePort.close();
                if (attemptState === "committing") finish(false);
              });
            }
          };
          try {
            client.postMessage({ type: "need-bridge" }, [ch.port2]);
          } catch (_error) {
            ch.port1.close();
          }
        });
      });
    });
  }

  function restorationObservationIsCurrent(observation) {
    return observation.intent === bridgeIntentVersion &&
      observation.liveEpoch === liveBridgeEpoch &&
      observation.authorityRevision === (
        durableAuthority ? durableAuthority.revision : null
      );
  }

  // A restoration candidate for a session other than the authority's is
  // trusted only against a durable demotion record — the same rule the
  // authority itself follows. A recorded session is a live machine whose
  // demoted bridge died with the terminated worker; reinstall it as a
  // secondary so its own clients keep routing to their machine. An
  // unrecorded one is a stale answer and its port is discarded. Its cookie
  // jar died with the worker — secondary jars are in-memory only. Runs
  // inside the state mutation that evaluates the candidate.
  function maybeInstallRecordedSecondary(
    port,
    candidateAppPrefix,
    candidateSessionId,
  ) {
    if (candidateSessionId === currentSessionId) {
      return Promise.resolve(false);
    }
    return readSecondaryAuthorities().then(function (records) {
      var recorded = records.some(function (record) {
        return record.sessionId === candidateSessionId &&
          record.appPrefix === candidateAppPrefix;
      });
      if (!recorded || candidateSessionId === currentSessionId) return false;
      wireBridgePort(port);
      secondaryBridges.set(candidateSessionId, {
        port: port,
        appPrefix: candidateAppPrefix,
        sessionId: candidateSessionId,
        cookieJar: new Map(),
      });
      return true;
    });
  }

  function scheduleBridgeRestoration(
    port,
    restoredAppPrefix,
    restoredSessionId,
    observation,
    isAttemptActive,
    claimAttemptForCommit,
  ) {
    return enqueueStateMutation(function () {
      // Both intent and committed/live observations must still match. This
      // catches an init that was already pending when restoration began.
      if (
        !isAttemptActive() ||
        !restorationObservationIsCurrent(observation)
      ) {
        // The authority already committed (its commit advanced the epoch) or
        // an init won the race. A candidate that answers for a recorded
        // demoted session still installs beside the winner; anything else is
        // discarded exactly as before.
        var lateSatisfied = Boolean(bridgePort);
        return maybeInstallRecordedSecondary(
          port,
          restoredAppPrefix,
          restoredSessionId,
        ).then(function (installed) {
          return { satisfied: lateSatisfied, installed: installed };
        });
      }

      if (durableAuthority) {
        if (
          durableAuthority.appPrefix !== restoredAppPrefix ||
          durableAuthority.sessionId !== restoredSessionId
        ) {
          // Not the authority — a live demoted machine answering for itself,
          // or a stale tab. The demotion record tells them apart.
          return maybeInstallRecordedSecondary(
            port,
            restoredAppPrefix,
            restoredSessionId,
          ).then(function (installed) {
            return { satisfied: false, installed: installed };
          });
        }
        if (!claimAttemptForCommit()) {
          return { satisfied: Boolean(bridgePort), installed: false };
        }
        commitBridgeState(port, durableAuthority);
        return { satisfied: true, installed: true };
      }

      // Migrate the prior Task 3 records only when no full authority exists.
      // The cached prefix must agree with the client before reading its jar.
      if (!bridgeConfigured || appPrefix !== restoredAppPrefix) {
        return { satisfied: false, installed: false };
      }
      return readLegacyCookieJarForSession(restoredSessionId).then(
        function (restoredJar) {
          if (
            !isAttemptActive() ||
            !restorationObservationIsCurrent(observation)
          ) {
            return { satisfied: Boolean(bridgePort), installed: false };
          }
          var authority = nextBridgeAuthority(
            restoredAppPrefix,
            restoredSessionId,
            restoredJar,
          );
          if (!claimAttemptForCommit()) {
            return { satisfied: Boolean(bridgePort), installed: false };
          }
          return writeBridgeAuthority(authority).then(function (cache) {
            durableAuthority = authority;
            legacyBridgeMigrationAllowed = false;
            commitBridgeState(port, authority);
            startLegacyBridgeCleanup(cache);
            return { satisfied: true, installed: true };
          });
        },
      );
    });
  }

  // --- Lifecycle ---
  self.addEventListener("install", function () {
    self.skipWaiting();
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(
      // Delete only obsolete versions owned by this exact registration scope.
      // Legacy and sibling caches are outside this worker's proven authority.
      caches.keys().then(function (names) {
        return Promise.all(
          names.filter(function (name) {
            return name.startsWith(CACHE_NAMESPACE) &&
              name !== BRIDGE_CACHE && name !== LAZY_ASSET_CACHE;
          }).map(function (name) {
            return caches.delete(name);
          }),
        );
      }).then(function () {
        return self.clients.claim();
      }),
    );
  });

  // --- Configuration via postMessage ---
  self.addEventListener("message", function (event) {
    var msg = event.data;
    if (msg && msg.type === "init-bridge") {
      var port = event.ports[0];
      var replyPort = event.ports[1];
      if (
        !isValidAppPrefix(msg.appPrefix) ||
        !isValidSessionId(msg.sessionId) ||
        !isBridgeMessagePort(port) || !isBridgeMessagePort(replyPort)
      ) {
        postInvalidScopeConfig(replyPort);
        return;
      }

      // The registering page's own requests must keep routing to its bridge
      // even after another page registers. event.source is that page's client.
      // Its prior mapping tells the transition whether the displaced bridge
      // belongs to this same page — a dead machine to retire, not demote.
      var initiatorPriorSession = null;
      if (event.source && event.source.id) {
        initiatorPriorSession = clientSessions.get(event.source.id) || null;
        clientSessions.set(event.source.id, msg.sessionId);
      }

      // waitUntil owns preparation and the single authority replacement. Live
      // state and readiness advance synchronously only after that put commits.
      event.waitUntil(
        scheduleBridgeTransition(
          port,
          replyPort,
          msg.appPrefix,
          msg.sessionId,
          initiatorPriorSession,
        ).catch(function () {
          replyPort.postMessage({
            type: "bridge-error",
            code: "bridge-init-failed",
          });
        }),
      );
    }
  });

  // --- Blob-URL iframe interceptor (injected at build time) ---
  // Source of the reusable DOM patch in public/blob-iframe-interceptor.js.
  // We inline it into every bridged HTML document (see
  // injectBlobIframeInterceptor) so that apps which mount iframes from
  // `blob:` URLs — e.g. the WordPress block/site editor canvas — render
  // those iframes as service-worker-controlled `about:srcdoc` documents
  // instead. Without this, a blob: document is not SW-controlled, so its
  // subresource requests (load-scripts.php/load-styles.php, block assets)
  // escape the bridge and 404 against the static origin.
  var BLOB_IFRAME_INTERCEPTOR_SRC = "__BLOB_IFRAME_INTERCEPTOR__";

  // Insert the interceptor as the first <head> child so it runs before any
  // app script creates a blob iframe. Idempotent and HTML-only.
  function injectBlobIframeInterceptor(html) {
    if (
      !BLOB_IFRAME_INTERCEPTOR_SRC ||
      BLOB_IFRAME_INTERCEPTOR_SRC.indexOf("__BLOB_IFRAME") === 0 ||
      html.indexOf("__kandeloBlobIframePatched") !== -1
    ) {
      return html;
    }
    var tag = "<script>" + BLOB_IFRAME_INTERCEPTOR_SRC + "</script>";
    var headMatch = html.match(/<head[^>]*>/i);
    if (headMatch) {
      var at = headMatch.index + headMatch[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
    var htmlMatch = html.match(/<html[^>]*>/i);
    if (htmlMatch) {
      var htmlAt = htmlMatch.index + htmlMatch[0].length;
      return html.slice(0, htmlAt) + tag + html.slice(htmlAt);
    }
    return tag + html;
  }

  // --- Complete CORS proxy profile (injected at build time) ---
  var CORS_PROXY_CONFIG = "__CORS_PROXY_CONFIG__";
  var corsProxyWarningKeys = new Set();

  function normalizedCorsProxyConfig() {
    if (!CORS_PROXY_CONFIG || typeof CORS_PROXY_CONFIG !== "object") return null;
    if (
      typeof CORS_PROXY_CONFIG.url !== "string" ||
      !Array.isArray(CORS_PROXY_CONFIG.allowedRequestHeaderNames) ||
      typeof CORS_PROXY_CONFIG.allowAnonymousGetHeaderOmission !== "boolean"
    ) {
      return null;
    }
    return CORS_PROXY_CONFIG;
  }

  function normalizedCorsProxyUrl() {
    var config = normalizedCorsProxyConfig();
    return config ? new URL(config.url, self.location.href).href : "";
  }

  function isCorsProxyFetchUrl(targetUrl) {
    var proxyUrl = normalizedCorsProxyUrl();
    return proxyUrl && targetUrl.startsWith(proxyUrl);
  }

  function corsProxyTargetUrl(fetchUrl) {
    var proxyUrl = normalizedCorsProxyUrl();
    if (!proxyUrl || !fetchUrl.startsWith(proxyUrl)) return null;
    var suffix = fetchUrl.slice(proxyUrl.length);
    if (!suffix) return null;
    try {
      var targetUrl = proxyUrl.endsWith("?")
        ? suffix
        : decodeURIComponent(suffix);
      var target = new URL(targetUrl);
      return target.protocol === "http:" || target.protocol === "https:"
        ? target.href
        : null;
    } catch (_error) {
      return null;
    }
  }

  function corsProxyFetchUrl(targetUrl) {
    var proxyUrl = normalizedCorsProxyUrl();
    if (targetUrl.startsWith(proxyUrl)) {
      return targetUrl;
    }
    return proxyUrl + (
      proxyUrl.endsWith("?") ? targetUrl : encodeURIComponent(targetUrl)
    );
  }

  function proxyAllowedHeaderNames(config) {
    var allowed = new Set();
    config.allowedRequestHeaderNames.forEach(function (name) {
      allowed.add(String(name).toLowerCase());
    });
    return allowed;
  }

  // Request-header names the browser sets or forbids on every fetch(): a guest
  // value can never reach the origin regardless of the proxy allow-list, so
  // dropping them is the browser's own constraint, not a proxy-imposed loss.
  // Omitted for ANY method so body-bearing protocols (git smart-HTTP's
  // git-upload-pack POST, whose request carries content-length/accept-encoding/
  // user-agent) traverse the proxy instead of failing before dispatch.
  // Credential names (authorization/cookie/cookie2/proxy-authorization) are
  // NOT dropped here — they must still fail loudly. Kept in sync with
  // BROWSER_CONTROLLED_REQUEST_HEADER_NAMES in
  // host/src/networking/browser-cors-proxy.ts.
  var BROWSER_CONTROLLED_REQUEST_HEADER_NAMES = new Set([
    "accept-charset", "accept-encoding", "access-control-request-headers",
    "access-control-request-method", "connection", "content-length", "date",
    "dnt", "expect", "host", "keep-alive", "origin", "permissions-policy",
    "referer", "te", "trailer", "transfer-encoding", "upgrade", "via",
    "accept-language", "user-agent",
  ]);

  function isBrowserManagedRequestHeader(name) {
    return BROWSER_CONTROLLED_REQUEST_HEADER_NAMES.has(name) ||
      name.indexOf("proxy-") === 0 || name.indexOf("sec-") === 0;
  }

  function proxyProjectionFailure(request, targetUrl, unsupportedNames) {
    var targetOrigin = new URL(targetUrl).origin;
    return new Response(
      "Browser CORS proxy " + normalizedCorsProxyUrl() + " cannot relay " +
        request.method + " request to " + targetOrigin +
        " with unsupported request headers: " + unsupportedNames.join(", "),
      {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
  }

  function projectCorsProxyRequest(request, outgoingUrl, targetUrl) {
    var config = normalizedCorsProxyConfig();
    if (!config) return Promise.resolve(request);
    var allowed = proxyAllowedHeaderNames(config);
    var headers = new Headers();
    var unsupported = [];
    var credential = false;
    request.headers.forEach(function (value, name) {
      var lower = name.toLowerCase();
      if (allowed.has(lower)) {
        headers.append(name, value);
      } else if (
        lower === "authorization" || lower === "cookie" ||
        lower === "cookie2" || lower === "proxy-authorization"
      ) {
        // Credentials are never silently dropped, even though some match the
        // browser-managed prefixes below — surface them so the request fails
        // loudly instead of going out unauthenticated.
        unsupported.push(lower);
        credential = true;
      } else if (isBrowserManagedRequestHeader(lower)) {
        // Fetch adds these fields independently of the Headers supplied by
        // callers. Do not copy them into the proxy request or classify them as
        // application-owned unsupported occurrences; Fetch will manage the
        // outer request's own values.
      } else {
        unsupported.push(lower);
      }
    });
    var diagnosticNames = Array.from(new Set(unsupported)).sort();
    if (diagnosticNames.length > 0) {
      var canOmit = config.allowAnonymousGetHeaderOmission &&
        request.method === "GET" && !credential;
      if (!canOmit) {
        return Promise.resolve(
          proxyProjectionFailure(request, targetUrl, diagnosticNames),
        );
      }
      var targetOrigin = new URL(targetUrl).origin;
      var warningKey = targetOrigin + "\n" + diagnosticNames.join("\n");
      if (!corsProxyWarningKeys.has(warningKey)) {
        corsProxyWarningKeys.add(warningKey);
        console.warn(
          "Browser CORS proxy omitted unsupported request headers for " +
            targetOrigin + ": " + diagnosticNames.join(", "),
        );
      }
    }
    var init = {
      method: request.method,
      headers: headers,
      credentials: "omit",
      mode: "cors",
      redirect: request.redirect,
    };
    if (request.method === "GET" || request.method === "HEAD") {
      return Promise.resolve(new Request(outgoingUrl, init));
    }
    return request.arrayBuffer().then(function (body) {
      if (body.byteLength > 0) init.body = body;
      return new Request(outgoingUrl, init);
    });
  }

  /**
   * Check if a URL is cross-origin relative to the service worker's origin.
   */
  function isCrossOrigin(url) {
    return url.origin !== self.location.origin;
  }

  function isCanonicalPagesVfsRequest(request, url) {
    if (
      request.method !== "GET" || request.mode === "navigate" ||
      isCrossOrigin(url) || url.search || url.hash
    ) return false;
    var scriptPath = new URL(self.location.href).pathname;
    var basePath = scriptPath.slice(0, scriptPath.lastIndexOf("/") + 1);
    if (!url.pathname.startsWith(basePath)) return false;
    var relative = url.pathname.slice(basePath.length);
    var match = relative.match(
      /^products\/([a-z0-9][a-z0-9._-]{0,127})\/sha256-([0-9a-f]{64})\/([a-z0-9][a-z0-9._-]{0,127})-([1-9][0-9]*)\.vfs\.zst$/,
    );
    return match !== null && match[1] === match[3];
  }

  function isScopedLazyVfsRequest(request, url) {
    return request.method === "GET" &&
      request.mode !== "navigate" &&
      !isCrossOrigin(url) &&
      !isAppPath(url.pathname) &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.startsWith(SCOPE_PATH + "vfs-groups/");
  }

  function cacheCompleteLazyVfsResponse(request, response) {
    if (response.status !== 200 || response.type !== "basic" || response.body === null) {
      return Promise.resolve(response);
    }
    // Keep the native response intact: rebuilding it would remove the
    // authenticated Content-Length the lazy VFS integrity check consumes.
    return response.clone().arrayBuffer().then(function () {
      return caches.open(LAZY_ASSET_CACHE).then(function (cache) {
        return cache.put(request, response.clone());
      });
    }).then(function () {
      return response;
    });
  }

  function fetchScopedLazyVfsRequest(request) {
    return caches.keys().then(function (cacheNames) {
      if (cacheNames.indexOf(LAZY_ASSET_CACHE) === -1) return null;
      return caches.open(LAZY_ASSET_CACHE).then(function (cache) {
        return cache.match(request);
      });
    }).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        return cacheCompleteLazyVfsResponse(request, response);
      });
    });
  }

  function appRootPath() {
    return appPrefix.endsWith("/") ? appPrefix.slice(0, -1) : appPrefix;
  }

  function appBasePath() {
    var root = appRootPath();
    var idx = root.lastIndexOf("/");
    return idx > 0 ? root.slice(0, idx) : "";
  }

  function isAppPath(pathname) {
    return pathname === appRootPath() || pathname.startsWith(appPrefix);
  }

  function stripAppPath(pathname) {
    if (pathname === appRootPath()) return "/";
    return pathname.slice(appRootPath().length);
  }

  function getRequestReferer(request) {
    // In a service worker, the Referer header is not reliably exposed
    // through Headers. Request.referrer is the fetch-owned source of truth;
    // keep the header fallback for engines that expose it.
    return request.referrer || request.headers.get("referer") || "";
  }

  function getAppReferer(request) {
    var referer = getRequestReferer(request);
    if (!referer) return null;
    try {
      var refererUrl = new URL(referer);
      if (
        refererUrl.origin === self.location.origin &&
        isAppPath(refererUrl.pathname)
      ) {
        return refererUrl;
      }
    } catch (e) {
      /* malformed referer — ignore */
    }
    return null;
  }

  function isNavigationRequest(request) {
    return request.mode === "navigate" || request.destination === "document";
  }

  function isAppClient(event) {
    return event.clientId && appClientIds.has(event.clientId);
  }

  function secondaryBridgeFor(event) {
    if (!event.clientId) return null;
    var sessionId = clientSessions.get(event.clientId);
    if (!sessionId || sessionId === currentSessionId) return null;
    return secondaryBridges.get(sessionId) || null;
  }

  function secondaryBridgeIsLive(bridge) {
    return secondaryBridges.get(bridge.sessionId) === bridge;
  }

  function dropSecondaryBridge(sessionId) {
    secondaryBridges.delete(sessionId);
    clientSessions.forEach(function (owner, clientId) {
      if (owner === sessionId) clientSessions.delete(clientId);
    });
    enqueueStateMutation(function () {
      return eraseSecondaryAuthority(sessionId);
    });
  }

  function isAppInitiatedRequest(event, request) {
    return getAppReferer(request) !== null || isAppClient(event);
  }

  function shouldRedirectIntoApp(event, request, url) {
    return !isAppPath(url.pathname) && isAppInitiatedRequest(event, request);
  }

  function markAppClient(event, request, servingSessionId) {
    var appReferer = getAppReferer(request);
    // The session this document belongs to: an in-frame navigation carries
    // the frame document's client id, but Chromium hands a parent-created
    // iframe navigation an empty clientId — there the request's owner is
    // whichever session served it, which is what the caller routed by.
    var ownerSession = clientSessions.get(event.clientId) || servingSessionId;
    if (isNavigationRequest(request)) {
      if (event.resultingClientId) {
        appClientIds.add(event.resultingClientId);
        if (ownerSession) {
          clientSessions.set(event.resultingClientId, ownerSession);
        }
      }
      if (appReferer !== null && event.clientId) {
        appClientIds.add(event.clientId);
        if (ownerSession && !clientSessions.has(event.clientId)) {
          clientSessions.set(event.clientId, ownerSession);
        }
      }
      return;
    }

    // A shell page may fetch /app/ as a readiness probe. That must not turn
    // the shell page into an app client, or later gallery navigations are
    // redirected under /app/. Only subresource/fetch requests from a document
    // already inside appPrefix should mark their client.
    if (appReferer !== null && event.clientId) {
      appClientIds.add(event.clientId);
      if (ownerSession && !clientSessions.has(event.clientId)) {
        clientSessions.set(event.clientId, ownerSession);
      }
    }
  }

  function pathInsideApp(pathname) {
    var base = appBasePath();
    if (base && pathname === base) return "/";
    if (base && pathname.startsWith(base + "/")) {
      return pathname.slice(base.length);
    }
    return pathname;
  }

  function redirectIntoApp(url) {
    var redirectUrl = new URL(url.href);
    redirectUrl.pathname = appRootPath() + pathInsideApp(url.pathname);
    return new Response(null, {
      status: 307,
      headers: appRedirectHeaders(redirectUrl.href),
    });
  }

  function appRedirectHeaders(location) {
    var headers = new Headers();
    headers.set("Location", location);
    addAppIsolationHeaders(headers);
    return headers;
  }

  function addAppIsolationHeaders(headers) {
    if (!headers.has("Cross-Origin-Embedder-Policy")) {
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    }
    if (!headers.has("Cross-Origin-Resource-Policy")) {
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
    }
    return headers;
  }

  /**
   * Fetch a cross-origin URL, routing through the CORS proxy if configured.
   * The body must first be readable through CORS. The synthetic response then
   * carries the policy headers needed by the cross-origin-isolated page.
   */
  function corsSafeResponseHeaders(response) {
    var headers = new Headers();
    [
      "Accept-Ranges",
      "Cache-Control",
      "Content-Length",
      "Content-Range",
      "Content-Type",
      "ETag",
      "Expires",
      "Last-Modified",
    ].forEach(function (name) {
      var value = response.headers.get(name);
      if (value) headers.set(name, value);
    });

    // The page is cross-origin isolated. Cross-origin fetch() requests are
    // allowed by COEP when they pass CORS, and this synthetic response is the
    // response the page sees. Do not depend on the proxy or upstream server to
    // provide these policy headers.
    headers.set("Access-Control-Allow-Origin", self.location.origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Expose-Headers", [
      "Accept-Ranges",
      "Content-Length",
      "Content-Range",
      "Content-Type",
      "ETag",
      "Last-Modified",
      "X-Playground-Cors-Proxy",
    ].join(", "));
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.append("Vary", "Origin");
    return headers;
  }

  function isNullBodyStatus(status) {
    return status === 204 || status === 205 || status === 304;
  }

  function responseBodyForStatus(status, body) {
    return isNullBodyStatus(status) ? null : body;
  }

  function responseWithHeaders(response, headers) {
    return new Response(responseBodyForStatus(response.status, response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: headers,
    });
  }

  function fetchCrossOrigin(request) {
    var targetUrl = request.url;

    // The page and worker runtime may already be deliberately fetching the
    // configured CORS proxy. Do not wrap that request in the same proxy again.
    if (isCorsProxyFetchUrl(targetUrl)) {
      var proxiedTargetUrl = corsProxyTargetUrl(targetUrl) || targetUrl;
      return projectCorsProxyRequest(request, targetUrl, proxiedTargetUrl).then(function (projected) {
        if (projected instanceof Response) return projected;
        return fetch(projected);
      }).then(function (response) {
        var headers = corsSafeResponseHeaders(response);
        return responseWithHeaders(response, headers);
      });
    }

    // If we have a CORS proxy, route reads through it. The proxy exists to
    // make CORS-less GET/HEAD subresources readable under COEP; its only POST
    // authority is the reviewed git-upload-pack boundary, and that traffic
    // targets the proxy URL deliberately. A body-bearing page request belongs
    // to a server that speaks CORS itself — the signalling piplet, for one —
    // so wrapping it turns a working direct request into a relay refusal.
    if (
      normalizedCorsProxyConfig() &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      var proxyUrl = corsProxyFetchUrl(targetUrl);
      return projectCorsProxyRequest(request, proxyUrl, targetUrl).then(function (projected) {
        if (projected instanceof Response) return projected;
        return fetch(projected);
      }).then(function (response) {
        var headers = corsSafeResponseHeaders(response);
        return responseWithHeaders(response, headers);
      });
    }

    // No proxy: try a normal CORS fetch. Policy headers are useful only after
    // CORS has made the response body readable; they cannot un-opaque a body.
    return fetch(request).then(function (response) {
      if (response.type === "opaque" || response.type === "opaqueredirect") {
        return response;
      }
      var headers = corsSafeResponseHeaders(response);
      return responseWithHeaders(response, headers);
    });
  }

  /**
   * Fetch a same-origin request and add COI headers.
   */
  function fetchWithCoiHeaders(request) {
    // Navigation requests (HTML pages): revalidate with the server so
    // deploys take effect immediately. Vite's content-hashed asset
    // filenames handle JS/CSS/wasm cache busting, but only if the
    // HTML referencing them is fresh.
    var fetchOptions =
      request.mode === "navigate"
        ? new Request(request, { cache: "no-cache" })
        : request;

    return fetch(fetchOptions).then(function (response) {
      // Can't modify opaque or redirect responses
      if (
        response.type === "opaque" ||
        response.type === "opaqueredirect"
      ) {
        return response;
      }
      var headers = new Headers(response.headers);
      if (!headers.has("Cross-Origin-Opener-Policy")) {
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
      }
      if (!headers.has("Cross-Origin-Embedder-Policy")) {
        headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      }
      if (!headers.has("Cross-Origin-Resource-Policy")) {
        headers.set("Cross-Origin-Resource-Policy", "same-origin");
      }
      // fetch() auto-decompresses the body, so the stream is already decoded.
      // When the original response had Content-Encoding, remove it along with
      // Content-Length (which reflects the compressed size, not the decoded body).
      // Firefox throws NS_ERROR_CORRUPTED_CONTENT if Content-Encoding is kept
      // on an already-decoded body.  Only strip when Content-Encoding was present
      // so that uncompressed responses preserve their Content-Length (needed by
      // HEAD requests that check file sizes).
      if (headers.has("Content-Encoding")) {
        headers.delete("Content-Encoding");
        headers.delete("Content-Length");
      }
      return responseWithHeaders(response, headers);
    });
  }

  function fetchRestoredAppRequest(event, request, url) {
    markAppClient(event, request);
    return ensureBridge().then(function (restored) {
      if (restored) {
        // Restoration resolves at the authority commit, but the answer that
        // maps this fetch's client to a demoted machine may still be in
        // transit. Wait for that mapping (or a short grace), then route: a
        // client owned by a demoted bridge goes to its own machine here,
        // exactly as it does on the live path — not to the machine that
        // holds the durable authority.
        return waitForClientMapping(event.clientId).then(function () {
          var secondaryBridge = secondaryBridgeFor(event);
          if (secondaryBridge) {
            markAppClient(event, request, secondaryBridge.sessionId);
            return handleAppRequest(request, url, secondaryBridge);
          }
          return handleAppRequest(request, url);
        });
      }
      return new Response(
        "Service worker bridge unavailable — please reload the page",
        {
          status: 503,
          headers: {
            "Content-Type": "text/plain",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        },
      );
    });
  }

  // --- Fetch interception ---
  self.addEventListener("fetch", function (event) {
    var url = new URL(event.request.url);

    // A top-level navigation to a same-origin, non-app page means a new machine
    // instance is (re)initializing. Forget the previous session's cookies so
    // they can never be served to the new page during the window before it
    // establishes its own session (init-bridge). The kept-alive SW would
    // otherwise serve the prior session's jar to the reloaded page.
    if (
      event.request.mode === "navigate" &&
      !isCrossOrigin(url) &&
      !isAppPath(url.pathname)
    ) {
      var navigatorSession = clientSessions.get(event.clientId);
      if (navigatorSession && secondaryBridges.has(navigatorSession)) {
        // A page that owns a demoted bridge is leaving; only its session
        // ends. The live session belongs to another window and stays intact.
        dropSecondaryBridge(navigatorSession);
      } else {
        // Another window may still own the live session. Demote its bridge —
        // jarless, so the reset keeps its promise that no cookie survives —
        // before the live state is cleared for the incoming page.
        if (navigatorSession !== currentSessionId) {
          demoteCurrentBridge(new Map());
        }
        resetSessionState();
      }
    }

    // Group assets have an immutable deployment-local identity. Cache only
    // their complete native responses before bridge/proxy/header rewriting.
    if (isScopedLazyVfsRequest(event.request, url)) {
      // A restarted worker initially has the default app prefix. Load its
      // durable authority before deciding a VFS-group path is cache-owned.
      event.respondWith(appPrefixReady.then(function () {
        if (isScopedLazyVfsRequest(event.request, url)) {
          return fetchScopedLazyVfsRequest(event.request);
        }
        if (bridgeConfigured && isAppPath(url.pathname)) {
          return fetchRestoredAppRequest(event, event.request, url);
        }
        return fetchWithCoiHeaders(event.request);
      }));
      return;
    }

    // A client owned by a demoted bridge routes to its own machine, not to
    // the machine that registered last.
    var secondaryBridge = secondaryBridgeFor(event);
    if (secondaryBridge && isAppPath(url.pathname)) {
      markAppClient(event, event.request, secondaryBridge.sessionId);
      event.respondWith(handleAppRequest(event.request, url, secondaryBridge));
      return;
    }

    // Fast path: bridge is active and the URL matches app prefix.
    if (bridgePort && isAppPath(url.pathname)) {
      markAppClient(event, event.request, currentSessionId);
      event.respondWith(handleAppRequest(event.request, url));
      return;
    }

    // Cross-origin requests — route through CORS proxy if available
    if (isCrossOrigin(url)) {
      event.respondWith(fetchCrossOrigin(event.request));
      return;
    }

    // A native same-origin Response retains its authenticated Content-Length
    // and streaming body. Reconstructing it below strips that forbidden
    // response header in browsers. Exact canonical Pages VFS paths need no
    // additional CORP/COEP headers because they are same-origin resources.
    if (isCanonicalPagesVfsRequest(event.request, url)) {
      event.respondWith(fetch(event.request));
      return;
    }

    // A bridge-owned document can still create root-relative or relative
    // requests that resolve outside appPrefix. Redirect those requests back
    // into the browser-visible app namespace so the generic app bridge can
    // handle them without app-specific path allowlists.
    if (bridgePort && shouldRedirectIntoApp(event, event.request, url)) {
      event.respondWith(redirectIntoApp(url));
      return;
    }

    // Bridge may need restoration (SW was terminated and restarted by browser).
    // Wait for cached appPrefix to load, then check if this URL should go
    // through the bridge.
    if (!bridgePort) {
      event.respondWith(
        appPrefixReady.then(function () {
          if (bridgeConfigured && shouldRedirectIntoApp(event, event.request, url)) {
            return redirectIntoApp(url);
          }
          if (bridgeConfigured && isAppPath(url.pathname)) {
            return fetchRestoredAppRequest(event, event.request, url);
          }
          return fetchWithCoiHeaders(event.request);
        })
      );
      return;
    }

    // Same-origin requests — pass through but add COI headers
    event.respondWith(fetchWithCoiHeaders(event.request));
  });

  function handleAppRequest(request, url, secondaryBridge) {
    return (async function () {
      try {
        // The session this request belongs to. If the session switches while
        // the request is in flight (page reload / new instance), we must not
        // inject or store this request's cookies into the new session.
        var reqSessionId = secondaryBridge
          ? secondaryBridge.sessionId
          : currentSessionId;
        var reqBridgeEpoch = liveBridgeEpoch;
        var reqAppPrefix = secondaryBridge
          ? secondaryBridge.appPrefix
          : appPrefix;
        // Strip appPrefix so nginx sees the original path.
        var hasAppPrefix = isAppPath(url.pathname);
        var appPath = hasAppPrefix
          ? stripAppPath(url.pathname)
          : url.pathname;

        var headers = {};
        request.headers.forEach(function (value, key) {
          headers[key] = value;
        });
        headers["host"] = url.host;
        headers["x-forwarded-host"] = url.host;
        headers["x-forwarded-prefix"] = appRootPath();
        headers["x-forwarded-proto"] = url.protocol.replace(":", "");
        headers["x-forwarded-uri"] = url.pathname + url.search;

        // Inject cookies from our jar. Wait for the current session's jar to
        // finish loading so we don't send an empty jar during the async load
        // right after the bridge (re)connects. Skip if the session changed
        // out from under this request. Secondary jars are in-memory only and
        // usable only while their bridge is still registered.
        if (!secondaryBridge) await cookieJarReady;
        var cookiePath = hasAppPrefix
          ? url.pathname
          : reqAppPrefix.slice(0, -1) + url.pathname;
        var jarCookies;
        if (secondaryBridge) {
          jarCookies = secondaryBridgeIsLive(secondaryBridge)
            ? secondaryCookiesForPath(secondaryBridge, cookiePath)
            : "";
        } else {
          jarCookies =
            reqSessionId === currentSessionId &&
              reqBridgeEpoch === liveBridgeEpoch
              ? getCookiesForPath(cookiePath, reqBridgeEpoch, reqSessionId)
              : "";
        }
        if (jarCookies) {
          var existing = headers["cookie"];
          headers["cookie"] = existing
            ? existing + "; " + jarCookies
            : jarCookies;
        }

        var body = null;
        if (request.method !== "GET" && request.method !== "HEAD") {
          var ab = await request.arrayBuffer();
          if (ab.byteLength > 0) {
            body = new Uint8Array(ab);
          }
        }

        var bridgeRequest = {
          method: request.method,
          url: appPath + url.search,
          headers: headers,
          body: body,
        };
        var bridgeResp = await (secondaryBridge
          ? bridgeFetchOn(secondaryBridge.port, bridgeRequest)
          : bridgeFetch(bridgeRequest));


        // Store cookies from bridge response
        var rawSetCookie =
          bridgeResp.headers["Set-Cookie"] ||
          bridgeResp.headers["set-cookie"];
        // Only store into the jar if this request still belongs to a live
        // session — an in-flight response from a superseded or dropped
        // session must not pollute another session's jar.
        if (rawSetCookie && secondaryBridge) {
          if (secondaryBridgeIsLive(secondaryBridge)) {
            storeCookies(
              secondaryBridge.cookieJar,
              secondaryBridge.appPrefix,
              rawSetCookie.split("\n"),
            );
          }
        } else if (
          rawSetCookie && reqSessionId === currentSessionId &&
          reqBridgeEpoch === liveBridgeEpoch
        ) {
          // Await the flush so the (possibly new login) cookie is durable
          // before we hand back the response — otherwise the SW could be
          // terminated before the write lands and drop the fresh session.
          await scheduleCookieJarMutation(
            reqBridgeEpoch,
            reqSessionId,
            function (nextJar, targetAppPrefix) {
              return storeCookies(
                nextJar,
                targetAppPrefix,
                rawSetCookie.split("\n"),
              );
            },
          );
        }

        // Build Response
        var respHeaders = new Headers();
        for (var key in bridgeResp.headers) {
          var lower = key.toLowerCase();
          if (
            lower === "transfer-encoding" ||
            lower === "connection" ||
            lower === "keep-alive" ||
            // Never hand Set-Cookie back to the browser. The SW cookie jar
            // (captured above via storeCookies) is the authoritative store and
            // replays cookies on outgoing requests. Forwarding Set-Cookie would
            // let the browser persist Kandelo cookies in its own cookie store,
            // where they would accumulate across sessions and outlive the
            // machine instance they belong to.
            lower === "set-cookie"
          ) {
            continue;
          }
          respHeaders.set(key, bridgeResp.headers[key]);
        }

        // Rewrite redirect Location: match protocol to request (avoid mixed
        // content on HTTPS) and add app prefix if missing.
        if (bridgeResp.status >= 300 && bridgeResp.status < 400) {
          var location =
            bridgeResp.headers["Location"] || bridgeResp.headers["location"];
          if (location) {
            try {
              var locUrl = new URL(location, url.origin);
              if (locUrl.hostname === url.hostname) {
                locUrl.protocol = url.protocol;
                if (!locUrl.pathname.startsWith(reqAppPrefix)) {
                  locUrl.pathname = reqAppPrefix.slice(0, -1) + locUrl.pathname;
                }
              }
              var redirectStatus = bridgeResp.status;
              if (
                (redirectStatus === 301 || redirectStatus === 302) &&
                request.method !== "GET" &&
                request.method !== "HEAD"
              ) {
                redirectStatus = 303;
              }
              respHeaders.set("Location", locUrl.toString());
              addAppIsolationHeaders(respHeaders);
              return new Response(null, {
                status: redirectStatus,
                headers: respHeaders,
              });
            } catch (e) {
              /* leave as-is */
            }
          }
        }
        rewriteAppUrlHeader(respHeaders, "Link", url);

        // COEP/CORP for cross-origin isolation
        addAppIsolationHeaders(respHeaders);

        var body = bridgeResp.body;
        if (shouldRewriteAppResponseBody(respHeaders)) {
          var text = new TextDecoder().decode(body);
          var rewritten = rewriteSameHostAppUrls(text, url);
          // Inject the blob-iframe interceptor into HTML documents so that
          // app-created `blob:` iframes (e.g. the WordPress editor canvas)
          // render as SW-controlled about:srcdoc documents and their
          // subresource requests stay on the bridge instead of escaping to
          // the static origin. See injectBlobIframeInterceptor.
          var contentType = (respHeaders.get("Content-Type") || "").toLowerCase();
          if (contentType.indexOf("text/html") === 0) {
            rewritten = injectBlobIframeInterceptor(rewritten);
          }
          if (rewritten !== text) {
            body = new TextEncoder().encode(rewritten);
            respHeaders.delete("Content-Length");
          }
        }

        return new Response(responseBodyForStatus(bridgeResp.status, body), {
          status: bridgeResp.status,
          headers: respHeaders,
        });
      } catch (err) {
        return new Response("Bridge error: " + err, {
          status: 502,
          headers: {
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        });
      }
    })();
  }

  function shouldRewriteAppResponseBody(headers) {
    if (headers.has("Content-Encoding")) return false;
    var contentType = (headers.get("Content-Type") || "").toLowerCase();
    return (
      contentType.indexOf("text/html") === 0 ||
      contentType.indexOf("text/css") === 0 ||
      contentType.indexOf("text/javascript") === 0 ||
      contentType.indexOf("application/javascript") === 0 ||
      contentType.indexOf("application/x-javascript") === 0 ||
      contentType.indexOf("application/json") === 0 ||
      contentType.indexOf("+json") !== -1 ||
      contentType.indexOf("application/xml") === 0 ||
      contentType.indexOf("text/xml") === 0 ||
      contentType.indexOf("+xml") !== -1 ||
      contentType.indexOf("image/svg+xml") === 0
    );
  }

  function rewriteAppUrlHeader(headers, name, requestUrl) {
    var value = headers.get(name);
    if (!value) return;
    var rewritten = rewriteSameHostAppUrls(value, requestUrl);
    if (rewritten !== value) {
      headers.set(name, rewritten);
    }
  }

  function rewriteSameHostAppUrls(text, requestUrl) {
    var rootPath = appRootPath();
    var publicOrigin = requestUrl.protocol + "//" + requestUrl.host + "/";
    var publicBase = requestUrl.protocol + "//" + requestUrl.host + rootPath + "/";
    var hostPattern = escapeRegExp(requestUrl.host);
    var appPathPattern = escapeRegExp(rootPath.slice(1));
    var plain = new RegExp(
      "http://" + hostPattern + "/(?!" + appPathPattern + "(?:/|$))",
      "g",
    );
    var escapedAppPathPattern = appPathPattern.replace(/\//g, "\\\\/");
    var escaped = new RegExp(
      "http:\\\\/\\\\/" + hostPattern + "\\\\/(?!" + escapedAppPathPattern + "(?:\\\\/|$))",
      "g",
    );
    var encodedAppPathPattern = appPathPattern.replace(/\//g, "%2F");
    var encoded = new RegExp(
      "http%3A%2F%2F" + hostPattern + "%2F(?!" + encodedAppPathPattern + "(?:%2F|$))",
      "gi",
    );
    return text
      .replace(plain, publicBase)
      .replace(escaped, publicBase.replace(/\//g, "\\/"))
      .replace(encoded, encodeURIComponent(publicBase))
      .replace(new RegExp("http://" + hostPattern + "/", "g"), publicOrigin)
      .replace(
        new RegExp("http:\\\\/\\\\/" + hostPattern + "\\\\/", "g"),
        publicOrigin.replace(/\//g, "\\/"),
      )
      .replace(
        new RegExp("http%3A%2F%2F" + hostPattern + "%2F", "gi"),
        encodeURIComponent(publicOrigin),
      );
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
