// Read-only enforcement for the production browser.
//
// The browser executes the real production JavaScript, so "this layer is
// read-only" cannot rest on the fact that *our* code never writes: page code,
// analytics, beacons, a future service worker or an injected third-party tag
// could all issue a mutating request. Repository permissions do not constrain
// what a page does inside Chrome either. So the guarantee is enforced at the
// network layer, before transmission, and the same interception point confines
// top-level navigation to the pinned origin.
//
// Two independent layers, both recording deterministic evidence:
//
//   1. CDP Fetch interception (authoritative). Every request the renderer
//      makes is paused at the Request stage and either continued or failed
//      with BlockedByClient. Nothing is transmitted for a blocked request.
//      Because each redirect hop re-pauses, the origin rule is applied per hop
//      rather than to the final URL only.
//   2. An in-page guard installed on every new document. It cancels form
//      submissions and neutralises navigator.sendBeacon, which are the two
//      paths that can otherwise start a mutation during unload, when
//      interception is least reliable.
//
// Service workers are handled by bypassing them for page traffic
// (Network.setBypassServiceWorker) and by auto-attaching to any worker target
// the page spawns and gating it through the same Fetch rule, so a worker
// cannot become an unintercepted side channel. The guard deliberately does not
// monkey-patch serviceWorker.register: rejecting that promise inside the page
// would surface as a first-party page error, which is precisely the kind of
// false defect this layer exists to avoid.

/** The only methods production QA traffic may use. */
export const READ_ONLY_METHODS = Object.freeze(['GET', 'HEAD']);

export const BLOCK_REASONS = Object.freeze({
  NON_READ_ONLY_METHOD: 'NON_READ_ONLY_METHOD',
  OFF_ORIGIN_TOP_LEVEL_NAVIGATION: 'OFF_ORIGIN_TOP_LEVEL_NAVIGATION',
});

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The whole policy, as a pure function, so it can be asserted directly rather
 * than only observed through a live browser.
 *
 * OPTIONS is not special-cased: the production site is static and never needs a
 * preflight, so a page-generated OPTIONS is not "safe read-only behaviour" here
 * and is blocked with everything else that is not GET or HEAD.
 */
export function decideBrowserRequest({ method, url, baseUrl, isTopLevelDocument = false }) {
  const normalized = String(method ?? 'GET').toUpperCase();
  if (!READ_ONLY_METHODS.includes(normalized)) {
    return { allow: false, reason: BLOCK_REASONS.NON_READ_ONLY_METHOD, method: normalized };
  }
  if (isTopLevelDocument && originOf(url) !== originOf(baseUrl)) {
    return { allow: false, reason: BLOCK_REASONS.OFF_ORIGIN_TOP_LEVEL_NAVIGATION, method: normalized };
  }
  return { allow: true, reason: null, method: normalized };
}

// Installed before any document script runs, on every document in the page.
// Both overrides report through a CDP binding so the attempt is recorded even
// though nothing reaches the network.
const PAGE_GUARD_SOURCE = `(() => {
  const report = (kind, detail) => {
    try { window.__aprasaQaGuard(JSON.stringify({ kind: kind, detail: detail })); } catch (e) { /* binding absent */ }
  };
  window.addEventListener('submit', (event) => {
    const form = event.target;
    event.preventDefault();
    event.stopImmediatePropagation();
    report('FORM_SUBMISSION', {
      action: (form && form.action) || null,
      method: String((form && form.getAttribute('method')) || 'GET').toUpperCase(),
    });
  }, true);
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function (url) {
      report('SEND_BEACON', { url: String(url) });
      return false;
    };
  }
})();`;

export const GUARD_BINDING_NAME = '__aprasaQaGuard';

/**
 * Attach the read-only guard to one CDP session.
 *
 * `record` receives every blocked attempt as
 * { source, reason, method, url, resourceType, frameId, topLevel }.
 * `blockedNetworkIds` collects the Network-domain request ids of blocked
 * requests so the caller can tell "we blocked this" apart from "the site is
 * broken" when Network.loadingFailed arrives for the same request.
 */
export async function installReadOnlyGuard(session, { baseUrl, record, notes = [] }) {
  const blockedNetworkIds = new Set();
  const blockedUrls = new Set();

  let mainFrameId = null;
  try {
    const tree = await session.send('Page.getFrameTree');
    mainFrameId = tree?.frameTree?.frame?.id ?? null;
  } catch {
    // Without a frame id every Document request is treated as top level, which
    // is the conservative direction: it can only block more, never less.
  }

  const isTopLevel = (params) => params.resourceType === 'Document'
    && (mainFrameId === null || params.frameId === mainFrameId);

  const handle = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params;
    const sessionId = message.sessionId;
    const send = (method, args) => session.ws.sendCommand(method, args, sessionId);
    let decision;
    try {
      decision = decideBrowserRequest({
        method: params.request?.method,
        url: params.request?.url,
        baseUrl,
        isTopLevelDocument: isTopLevel(params),
      });
    } catch {
      decision = { allow: true, reason: null, method: 'GET' };
    }

    try {
      if (decision.allow) {
        await send('Fetch.continueRequest', { requestId: params.requestId });
        return;
      }
      // Nothing is transmitted: the request is failed at the interception
      // point, before it reaches the network stack.
      //
      // The error reason is chosen for what it does to the page. A top-level
      // navigation failed with BlockedByClient commits a Chrome error page,
      // which destroys the document we were measuring and turns our own
      // enforcement into NAVIGATION_SHELL_MISSING and PRIMARY_CONTENT_BLANK.
      // Aborted is the semantics we actually want for a cancelled navigation:
      // the request never leaves, and the current document stays put so the
      // render checks still judge the real page.
      const errorReason = decision.reason === BLOCK_REASONS.OFF_ORIGIN_TOP_LEVEL_NAVIGATION
        ? 'Aborted'
        : 'BlockedByClient';
      await send('Fetch.failRequest', { requestId: params.requestId, errorReason });
      if (params.networkId) blockedNetworkIds.add(params.networkId);
      if (params.request?.url) blockedUrls.add(params.request.url);
      record({
        source: 'cdp-fetch-interception',
        reason: decision.reason,
        method: decision.method,
        url: params.request?.url ?? null,
        resourceType: params.resourceType ?? null,
        frameId: params.frameId ?? null,
        topLevel: isTopLevel(params),
      });
    } catch (error) {
      // A paused request that is never answered wedges the page, so a failure
      // to answer is itself worth recording.
      notes.push(`browser guard could not answer a paused request: ${error.message}`);
    }
  };

  const handleBinding = (message) => {
    if (message.method !== 'Runtime.bindingCalled') return;
    if (message.params?.name !== GUARD_BINDING_NAME) return;
    let payload;
    try {
      payload = JSON.parse(message.params.payload);
    } catch {
      return;
    }
    const detail = payload.detail ?? {};
    record({
      source: 'in-page-guard',
      // Both guarded paths are mutation attempts: a beacon is a POST by
      // definition, and a form submission is a navigation the QA layer never
      // derived from repository data.
      reason: BLOCK_REASONS.NON_READ_ONLY_METHOD,
      method: payload.kind === 'SEND_BEACON' ? 'POST' : (detail.method ?? 'GET'),
      url: detail.url ?? detail.action ?? null,
      resourceType: payload.kind === 'FORM_SUBMISSION' ? 'Document' : 'Beacon',
      frameId: null,
      topLevel: payload.kind === 'FORM_SUBMISSION',
      guard_kind: payload.kind,
    });
  };

  const off = session.ws.on((message) => {
    if (message.sessionId && message.sessionId !== session.sessionId) {
      // Worker sessions are attached below and share this connection; their
      // paused requests are answered by the same rule.
      if (message.method === 'Fetch.requestPaused') void handle(message);
      return;
    }
    if (message.method === 'Fetch.requestPaused') void handle(message);
    else if (message.method === 'Runtime.bindingCalled') handleBinding(message);
    else if (message.method === 'Target.attachedToTarget') void adoptWorker(message);
  });

  async function adoptWorker(message) {
    const { sessionId, targetInfo } = message.params ?? {};
    if (!sessionId) return;
    try {
      await session.ws.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
    } catch (error) {
      notes.push(`browser guard could not gate ${targetInfo?.type ?? 'worker'} target: ${error.message}`);
    }
    try {
      await session.ws.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId);
    } catch {
      /* the target may not be waiting */
    }
  }

  // Order matters: interception must be live before anything navigates.
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  try {
    await session.send('Network.setBypassServiceWorker', { bypass: true });
  } catch (error) {
    notes.push(`browser guard could not bypass service workers: ${error.message}`);
  }
  try {
    await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  } catch (error) {
    notes.push(`browser guard could not auto-attach worker targets: ${error.message}`);
  }
  try {
    await session.send('Runtime.addBinding', { name: GUARD_BINDING_NAME });
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_GUARD_SOURCE });
  } catch (error) {
    notes.push(`browser guard could not install the in-page guard: ${error.message}`);
  }

  return {
    blockedNetworkIds,
    blockedUrls,
    dispose: off,
  };
}
