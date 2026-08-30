// Live browser / render QA.
//
// Deterministic failures only: geometry, image decode state, presence of the
// page shell, first-party script errors, failed same-origin requests. No
// subjective design scoring and no screenshot pixel-diff baselines — those are
// brittle and would generate exactly the noise this layer must avoid.
// Screenshots are collected as evidence, never compared.

import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './cdp.mjs';
import { classifyConsoleMessage, classifyNetworkFailure, isBrowserImplicitRequest, isSameOrigin } from './qa-classify.mjs';

export const VIEWPORTS = Object.freeze([
  { name: 'mobile', width: 375, height: 812, deviceScaleFactor: 2, mobile: true },
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
]);

// A one-pixel tolerance absorbs sub-pixel layout rounding, which differs
// harmlessly between Chrome builds and device scale factors.
const OVERFLOW_TOLERANCE_PX = 1;
const MIN_MAIN_TEXT_CHARS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs inside the page. Returns only serialisable primitives, and caps the
 * offender list so a pathological DOM cannot produce an unbounded report.
 */
// Shared in-page predicate: is this image something the browser actually
// renders? A PRASA ships locale-variant images that CSS hides on the other
// locale (img.lang-only-pt on an EN page), and Chrome legitimately never loads
// an image the page never displays. Judging those as broken or unsettled is a
// pure false positive, so they are out of scope for the render checks.
// checkVisibility() covers display:none, visibility, and content-visibility
// skipped subtrees; the box-size test is the fallback on older engines.
const IS_RENDERED_FN = `const IS_RENDERED = (el) => {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true });
  }
  return el.offsetParent !== null;
};`;

const PAGE_PROBE = `(() => {
  ${IS_RENDERED_FN}
  const doc = document.documentElement;
  // clientWidth, not innerWidth. Under Chrome mobile emulation innerWidth
  // expands to the overflowing content width (an overflowing 375px page
  // reports innerWidth 908), which silently hides exactly the defect this
  // check exists to find. clientWidth stays at the device width in both
  // mobile and desktop emulation.
  const viewportWidth = doc.clientWidth || window.innerWidth;
  const offenders = [];
  const all = document.querySelectorAll('body *');
  const limit = Math.min(all.length, 4000);
  for (let i = 0; i < limit; i += 1) {
    const el = all[i];
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const overflowBy = Math.round(rect.right - viewportWidth);
    if (overflowBy > 1) {
      offenders.push({
        selector: el.tagName.toLowerCase()
          + (el.id ? '#' + el.id : '')
          + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        overflow_px: overflowBy,
      });
    }
  }
  offenders.sort((a, b) => b.overflow_px - a.overflow_px);

  const images = [...document.images].slice(0, 200).map((img) => {
    const rect = img.getBoundingClientRect();
    return {
      src: img.currentSrc || img.src,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: Math.round(rect.width),
      renderedHeight: Math.round(rect.height),
      rendered: IS_RENDERED(img),
      hasAltAttribute: img.hasAttribute('alt'),
      alt: img.getAttribute('alt'),
      loading: img.getAttribute('loading'),
    };
  });

  const main = document.querySelector('main#main');
  return {
    lang: doc.getAttribute('lang'),
    title: document.title,
    innerWidth: window.innerWidth,
    documentScrollWidth: doc.scrollWidth,
    bodyScrollWidth: document.body ? document.body.scrollWidth : 0,
    viewportWidth,
    overflowOffenders: offenders.slice(0, 5),
    images,
    hasHeader: Boolean(document.querySelector('header.site-header')),
    hasSiteNav: Boolean(document.querySelector('header.site-header nav.site-nav')),
    hasFooter: Boolean(document.querySelector('footer.site-footer')),
    hasMain: Boolean(main),
    mainTextLength: main ? main.innerText.replace(/\\s+/g, ' ').trim().length : 0,
    h1: document.querySelector('main#main h1') ? document.querySelector('main#main h1').textContent : null,
    h3s: [...document.querySelectorAll('main#main h3')].slice(0, 60).map((h) => h.textContent),
  };
})()`;

/** Steps through the whole document so every lazy image enters the viewport. */
const SCROLL_SWEEP = `(async () => {
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  const total = document.documentElement.scrollHeight;
  for (let y = 0; y <= total; y += step) {
    window.scrollTo(0, y);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  window.scrollTo(0, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return true;
})()`;

// Only rendered images gate the settle wait. Including hidden locale-variant
// images here would burn the entire budget on every page, because they never
// load by design.
const IMAGES_SETTLED = `(() => {
  ${IS_RENDERED_FN}
  return [...document.images].filter(IS_RENDERED).every((image) => image.complete);
})()`;

/**
 * Bounded wait for image decode to finish. A failed image also reports
 * complete === true (with naturalWidth 0), so this terminates on broken images
 * too and hands them to the render check rather than timing out on them.
 */
async function waitForImages(session, { settleMs, budgetMs }) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    await sleep(settleMs);
    const settled = (await session.send('Runtime.evaluate', { expression: IMAGES_SETTLED, returnByValue: true })).result.value;
    if (settled === true || Date.now() >= deadline) return Boolean(settled);
  }
}

/**
 * Sweep, wait, and on failure sweep once more. Markup injected late (for
 * example after a render-blocking external stylesheet finally resolves) can
 * add images the first sweep never saw, so a single bounded retry is the
 * difference between a real broken-image finding and a timing artefact. This
 * is bounded on purpose: a persistently broken image still surfaces.
 */
async function settleLazyImages(session, { settleMs, budgetMs }) {
  await session.send('Runtime.evaluate', { expression: SCROLL_SWEEP, awaitPromise: true, returnByValue: true });
  if (await waitForImages(session, { settleMs, budgetMs })) return true;
  await session.send('Runtime.evaluate', { expression: SCROLL_SWEEP, awaitPromise: true, returnByValue: true });
  return waitForImages(session, { settleMs, budgetMs });
}

async function collectPage(session, url, viewport, { navigationTimeoutMs, settleMs, imageSettleBudgetMs, baseUrl }) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const responses = [];
  const requestUrls = new Map();

  const off = session.ws.on((message) => {
    if (message.sessionId !== session.sessionId) return;
    const { method, params } = message;
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails ?? {};
      pageErrors.push({
        text: details.exception?.description ?? details.text ?? 'uncaught exception',
        sourceUrl: details.url || details.stackTrace?.callFrames?.[0]?.url || null,
      });
    } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      consoleErrors.push({
        text: (params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' '),
        sourceUrl: params.stackTrace?.callFrames?.[0]?.url ?? null,
      });
    } else if (method === 'Log.entryAdded' && params.entry?.level === 'error') {
      consoleErrors.push({ text: params.entry.text, sourceUrl: params.entry.url ?? null });
    } else if (method === 'Network.requestWillBeSent') {
      requestUrls.set(params.requestId, params.request.url);
    } else if (method === 'Network.responseReceived') {
      responses.push({ url: params.response.url, status: params.response.status, type: params.type });
    } else if (method === 'Network.loadingFailed') {
      failedRequests.push({
        url: requestUrls.get(params.requestId) ?? null,
        errorText: params.errorText,
        type: params.type,
        canceled: Boolean(params.canceled),
      });
    }
  });

  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Log.enable');
  await session.send('Network.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
  });

  const loaded = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), navigationTimeoutMs);
    const stop = session.ws.on((message) => {
      if (message.sessionId === session.sessionId && message.method === 'Page.loadEventFired') {
        clearTimeout(timer);
        stop();
        resolve('load');
      }
    });
  });

  const navigation = await session.send('Page.navigate', { url });
  const loadOutcome = await loaded;
  await sleep(settleMs);

  // First measurement, then a lazy-load pass. A single jump to the bottom is
  // not enough: `loading="lazy"` images in the middle of a long page never
  // enter the viewport that way and would be reported as unsettled, which is a
  // pure false positive. Sweeping the page in viewport-sized steps triggers
  // every deferred image, then a bounded poll waits for them to finish before
  // the second measurement. Overflow is taken from both passes and only
  // reported when they agree, which is the reproducibility requirement.
  const first = (await session.send('Runtime.evaluate', { expression: PAGE_PROBE, returnByValue: true })).result.value;
  const imagesSettled = await settleLazyImages(session, { settleMs, budgetMs: imageSettleBudgetMs });
  const second = (await session.send('Runtime.evaluate', { expression: PAGE_PROBE, returnByValue: true })).result.value;

  let screenshot = null;
  try {
    const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    screenshot = shot.data;
  } catch {
    screenshot = null;
  }

  off();

  return {
    navigation,
    loadOutcome,
    first,
    second,
    imagesSettled,
    consoleErrors,
    pageErrors,
    failedRequests,
    responses,
    screenshot,
    baseUrl,
  };
}

function overflowOf(probe) {
  const widest = Math.max(probe.documentScrollWidth, probe.bodyScrollWidth);
  return widest - probe.viewportWidth;
}

/**
 * Turn one collected page into checks + issues. `emit` is the shared
 * check/issue recorder supplied by the runner.
 */
function evaluatePage({ page, route, locale, viewport, baseUrl, requiredMedia, emit, screenshotPath }) {
  const id = `${route}@${viewport.name}`;
  const evidenceBase = { route, viewport: viewport.name, screenshot: screenshotPath };

  if (!page.first || !page.second) {
    emit.check({ id: `browser:probe:${id}`, name: 'page probe executed', status: 'FAIL', route, locale, observed: page.loadOutcome });
    emit.issue({
      code: 'BROWSER_PROBE_FAILED',
      severity: 'ERROR',
      category: 'RENDER',
      check: 'browser probe',
      route,
      locale,
      observed: `load outcome ${page.loadOutcome}`,
      expected: 'page probe returns layout state',
      evidence: evidenceBase,
      resolver_class: 'TECHNICAL',
      retryable: true,
    });
    return;
  }

  const probe = page.second;

  // --- navigation shell ---------------------------------------------------
  const shellOk = probe.hasHeader && probe.hasSiteNav && probe.hasFooter;
  emit.check({
    id: `browser:shell:${id}`,
    name: 'navigation shell present',
    status: shellOk ? 'PASS' : 'FAIL',
    route,
    locale,
    observed: { header: probe.hasHeader, siteNav: probe.hasSiteNav, footer: probe.hasFooter },
    expected: 'header.site-header + nav.site-nav + footer.site-footer',
  });
  if (!shellOk) {
    emit.issue({
      code: 'NAVIGATION_SHELL_MISSING',
      severity: 'ERROR',
      category: 'RENDER',
      check: 'navigation shell present',
      route,
      locale,
      observed: { header: probe.hasHeader, siteNav: probe.hasSiteNav, footer: probe.hasFooter },
      expected: 'header.site-header, nav.site-nav and footer.site-footer all present',
      evidence: evidenceBase,
      resolver_class: 'TECHNICAL',
    });
  }

  // --- primary content ----------------------------------------------------
  const contentOk = probe.hasMain && probe.mainTextLength >= MIN_MAIN_TEXT_CHARS;
  emit.check({
    id: `browser:content:${id}`,
    name: 'primary content rendered',
    status: contentOk ? 'PASS' : 'FAIL',
    route,
    locale,
    observed: { hasMain: probe.hasMain, mainTextLength: probe.mainTextLength },
    expected: `main#main with at least ${MIN_MAIN_TEXT_CHARS} rendered characters`,
  });
  if (!contentOk) {
    emit.issue({
      code: 'PRIMARY_CONTENT_BLANK',
      severity: 'ERROR',
      category: 'RENDER',
      check: 'primary content rendered',
      route,
      locale,
      observed: { hasMain: probe.hasMain, mainTextLength: probe.mainTextLength },
      expected: `main#main with at least ${MIN_MAIN_TEXT_CHARS} rendered characters`,
      evidence: evidenceBase,
      resolver_class: 'TECHNICAL',
    });
  }

  // --- horizontal overflow (must reproduce across both measurements) -------
  const firstOverflow = overflowOf(page.first);
  const secondOverflow = overflowOf(probe);
  const reproducible = firstOverflow > OVERFLOW_TOLERANCE_PX && secondOverflow > OVERFLOW_TOLERANCE_PX;
  const transient = !reproducible && (firstOverflow > OVERFLOW_TOLERANCE_PX || secondOverflow > OVERFLOW_TOLERANCE_PX);
  emit.check({
    id: `browser:overflow:${id}`,
    name: 'no horizontal page overflow',
    status: reproducible ? 'FAIL' : transient ? 'WARN' : 'PASS',
    route,
    locale,
    observed: {
      first_pass_overflow_px: firstOverflow,
      second_pass_overflow_px: secondOverflow,
      viewport_width: probe.viewportWidth,
      inner_width: probe.innerWidth,
    },
    expected: `document width <= viewport width + ${OVERFLOW_TOLERANCE_PX}px`,
  });
  if (reproducible) {
    emit.issue({
      code: 'HORIZONTAL_OVERFLOW',
      severity: 'ERROR',
      category: 'RENDER',
      check: 'no horizontal page overflow',
      route,
      locale,
      observed: `document is ${secondOverflow}px wider than the ${probe.viewportWidth}px viewport`,
      expected: `document width <= viewport width + ${OVERFLOW_TOLERANCE_PX}px`,
      evidence: { ...evidenceBase, offenders: probe.overflowOffenders, first_pass_overflow_px: firstOverflow },
      resolver_class: 'TECHNICAL',
    });
  } else if (transient) {
    emit.issue({
      code: 'HORIZONTAL_OVERFLOW_NOT_REPRODUCIBLE',
      severity: 'WARNING',
      category: 'RENDER',
      check: 'no horizontal page overflow',
      route,
      locale,
      observed: { first_pass_overflow_px: firstOverflow, second_pass_overflow_px: secondOverflow },
      expected: 'no overflow on either measurement pass',
      evidence: { ...evidenceBase, offenders: probe.overflowOffenders },
      resolver_class: 'TECHNICAL',
      deterministic: false,
      retryable: true,
    });
  }

  // --- rendered images ----------------------------------------------------
  const requiredMediaSet = new Set(requiredMedia ?? []);
  const unsettled = [];
  for (const image of probe.images) {
    if (!image.src) continue;
    // Alt is a markup contract and applies to every img, rendered or not.
    if (!image.hasAltAttribute) {
      const isRequiredForAlt = [...requiredMediaSet].some((asset) => image.src.endsWith(asset));
      emit.issue({
        code: isRequiredForAlt ? 'REQUIRED_MEDIA_ALT_MISSING' : 'IMAGE_ALT_ATTRIBUTE_MISSING',
        severity: isRequiredForAlt ? 'ERROR' : 'WARNING',
        category: 'MEDIA',
        check: 'img carries an alt attribute',
        route,
        locale,
        observed: { src: image.src, alt: null },
        expected: 'an alt attribute is present (empty is allowed for decorative images)',
        evidence: evidenceBase,
        resolver_class: 'MEDIA',
      });
    }
    // Everything below judges rendering, so it applies only to images the
    // browser actually renders.
    if (!image.rendered) continue;
    const sameOrigin = isSameOrigin(image.src, baseUrl);
    const isRequired = [...requiredMediaSet].some((asset) => image.src.endsWith(asset));
    if (image.complete && image.naturalWidth === 0) {
      const classification = sameOrigin
        ? { severity: 'ERROR', code: 'IMAGE_RENDER_BROKEN', resolver_class: 'MEDIA' }
        : { severity: 'WARNING', code: 'EXTERNAL_IMAGE_RENDER_BROKEN', resolver_class: 'EXTERNAL_DEPENDENCY' };
      emit.issue({
        code: classification.code,
        severity: classification.severity,
        category: 'MEDIA',
        check: 'rendered image has non-zero natural dimensions',
        route,
        locale,
        observed: { src: image.src, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight },
        expected: 'naturalWidth > 0 and naturalHeight > 0',
        evidence: { ...evidenceBase, required_media: isRequired },
        resolver_class: classification.resolver_class,
        auto_remediation_candidate: sameOrigin,
      });
    } else if (!image.complete) {
      unsettled.push({ src: image.src, loading: image.loading, required_media: isRequired });
    }
  }

  // A broken image reports complete === true with naturalWidth 0, so an
  // incomplete image means "still loading", never "broken" — most often a
  // script-injected card image on a page whose third-party stylesheet was slow.
  // Recorded once per route/viewport at INFO for traceability; it never
  // degrades the run, and the canonical media assets are independently proven
  // over HTTP in the live-HTTP domain.
  if (unsettled.length) {
    emit.issue({
      code: 'IMAGE_NOT_SETTLED',
      severity: 'INFO',
      category: 'MEDIA',
      check: 'rendered image has non-zero natural dimensions',
      route,
      locale,
      observed: `${unsettled.length} rendered image(s) had not finished loading within the settle budget`,
      expected: 'every rendered image finished loading within the bounded settle budget',
      evidence: { ...evidenceBase, images: unsettled.slice(0, 20) },
      resolver_class: 'MEDIA',
      deterministic: false,
      retryable: true,
    });
  }
  emit.check({
    id: `browser:images:${id}`,
    name: 'rendered images decoded',
    status: probe.images.some((image) => image.rendered && image.complete && image.naturalWidth === 0) ? 'FAIL' : 'PASS',
    route,
    locale,
    observed: {
      images: probe.images.length,
      rendered: probe.images.filter((image) => image.rendered).length,
      settled: page.imagesSettled,
    },
    expected: 'every rendered image decodes to non-zero dimensions',
  });

  // --- console / page errors ---------------------------------------------
  for (const error of page.pageErrors) {
    const classification = classifyConsoleMessage({ text: error.text, sourceUrl: error.sourceUrl, baseUrl, kind: 'pageerror' });
    emit.issue({
      code: classification.code,
      severity: classification.severity,
      category: classification.category,
      check: 'no severe first-party page errors',
      route,
      locale,
      observed: error.text?.slice(0, 500) ?? null,
      expected: 'no uncaught first-party exception',
      evidence: { ...evidenceBase, source_url: error.sourceUrl, party: classification.party },
      resolver_class: classification.resolver_class,
    });
  }
  for (const error of page.consoleErrors) {
    const classification = classifyConsoleMessage({ text: error.text, sourceUrl: error.sourceUrl, baseUrl, kind: 'console' });
    emit.issue({
      code: classification.code,
      severity: classification.severity,
      category: classification.category,
      check: 'no severe first-party console errors',
      route,
      locale,
      observed: error.text?.slice(0, 500) ?? null,
      expected: 'no first-party console error',
      evidence: { ...evidenceBase, source_url: error.sourceUrl, party: classification.party },
      resolver_class: classification.resolver_class,
    });
  }
  emit.check({
    id: `browser:console:${id}`,
    name: 'console and page errors classified',
    status: 'PASS',
    route,
    locale,
    observed: { console_errors: page.consoleErrors.length, page_errors: page.pageErrors.length },
    expected: 'each message classified as first-party or external',
  });

  // --- network ------------------------------------------------------------
  const networkFailures = [
    ...page.failedRequests.filter((request) => request.url && !request.canceled).map((request) => ({ url: request.url, detail: request.errorText })),
    ...page.responses.filter((response) => response.status >= 400).map((response) => ({ url: response.url, detail: `HTTP ${response.status}` })),
  ];
  for (const failure of networkFailures) {
    const required = [...requiredMediaSet].some((asset) => failure.url.endsWith(asset))
      || /\.(css|js)(\?|$)/.test(failure.url);
    const classification = classifyNetworkFailure({ url: failure.url, baseUrl, required });
    emit.issue({
      code: classification.code,
      severity: classification.severity,
      category: classification.category,
      check: 'required same-origin requests succeed',
      route,
      locale,
      observed: { url: failure.url, detail: failure.detail },
      expected: 'request succeeds',
      evidence: { ...evidenceBase, party: classification.party, purpose: classification.purpose ?? null, required },
      resolver_class: classification.resolver_class,
      retryable: classification.party !== 'first-party',
    });
  }
  emit.check({
    id: `browser:network:${id}`,
    name: 'network failures classified',
    status: networkFailures.some((failure) => isSameOrigin(failure.url, baseUrl) && !isBrowserImplicitRequest(failure.url)) ? 'FAIL' : 'PASS',
    route,
    locale,
    observed: { failures: networkFailures.length },
    expected: 'no failed same-origin request',
  });
}

export async function runBrowserChecks({ baseUrl, routes, viewports = VIEWPORTS, requiredMedia = [], screenshotDir, emit, navigationTimeoutMs = 30000, settleMs = 400, imageSettleBudgetMs = 8000, notes = [] }) {
  let browser;
  try {
    browser = await launchBrowser();
  } catch (error) {
    notes.push(`browser QA skipped: ${error.message}`);
    emit.check({
      id: 'browser:launch',
      name: 'headless browser available',
      status: 'SKIP',
      observed: String(error.message),
      expected: 'a Chrome/Chromium binary is available',
    });
    emit.issue({
      code: 'BROWSER_UNAVAILABLE',
      severity: 'WARNING',
      category: 'RENDER',
      check: 'headless browser available',
      observed: String(error.message),
      expected: 'a Chrome/Chromium binary is available',
      evidence: {},
      resolver_class: 'TECHNICAL',
      retryable: true,
    });
    return [];
  }

  const screenshots = [];
  try {
    if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
    for (const page of routes) {
      for (const viewport of viewports) {
        const session = await browser.newPage();
        const url = new URL(page.route, baseUrl).toString();
        const collected = await collectPage(session, url, viewport, { navigationTimeoutMs, settleMs, imageSettleBudgetMs, baseUrl });
        let screenshotPath = null;
        if (collected.screenshot && screenshotDir) {
          const safe = page.route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home';
          screenshotPath = path.join(screenshotDir, `${safe}--${viewport.name}.png`);
          fs.writeFileSync(screenshotPath, Buffer.from(collected.screenshot, 'base64'));
          screenshots.push(screenshotPath);
        }
        evaluatePage({
          page: collected,
          route: page.route,
          locale: page.locale,
          viewport,
          baseUrl,
          requiredMedia,
          emit,
          screenshotPath,
        });
        await session.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }
  return screenshots;
}
