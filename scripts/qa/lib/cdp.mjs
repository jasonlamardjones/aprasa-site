// Minimal Chrome DevTools Protocol client — zero npm dependencies.
//
// Why not Playwright/Puppeteer: this repository has no package.json and no
// dependency tree at all; every existing script is plain Node with node:*
// imports. Introducing a browser-automation dependency (and its download step)
// would be a larger architectural change than the QA layer justifies. Node 22+
// ships a global WebSocket, and both the GitHub Actions ubuntu runner image and
// local developer machines already have a Chrome/Chromium binary, so the whole
// browser layer needs is a small CDP speaker.
//
// Scope is deliberately tiny: launch headless, open one page, navigate, wait
// for quiet, evaluate an expression, screenshot, collect console/network
// events, and gate outbound requests through the Fetch domain so the browser
// stays read-only. No input synthesis and no mutation of anything observed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  process.env.APRASA_QA_CHROME,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

// Every CDP command is individually bounded. Relying on the job timeout alone
// means a single wedged command burns the whole 30-minute budget and produces
// no report at all; a per-command deadline turns that into one failed check.
export const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  // Playwright-style layout: pick any chrome-linux/chrome under the browsers dir.
  const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersRoot && fs.existsSync(browsersRoot)) {
    for (const entry of fs.readdirSync(browsersRoot)) {
      const guess = path.join(browsersRoot, entry, 'chrome-linux', 'chrome');
      if (fs.existsSync(guess)) return guess;
    }
  }
  return null;
}

class CdpSession {
  constructor(ws, sessionId, targetId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params = {}, options = {}) {
    return this.ws.sendCommand(method, params, this.sessionId, options);
  }

  /** Closing the tab frees its renderer; one tab per route keeps state isolated. */
  close() {
    return this.ws.sendCommand('Target.closeTarget', { targetId: this.targetId });
  }
}

class CdpBrowser {
  constructor(process_, ws, userDataDir) {
    this.process = process_;
    this.ws = ws;
    this.userDataDir = userDataDir;
  }

  send(method, params = {}, options = {}) {
    return this.ws.sendCommand(method, params, undefined, options);
  }

  /** Subscribe to every protocol event on this connection, session included. */
  on(listener) {
    return this.ws.on(listener);
  }

  async newPage() {
    const { targetId } = await this.ws.sendCommand('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.ws.sendCommand('Target.attachToTarget', { targetId, flatten: true });
    return new CdpSession(this.ws, sessionId, targetId);
  }

  async close() {
    try {
      this.ws.socket.close();
    } catch {
      /* the socket may already be gone; the kill below is what matters */
    }
    this.process.kill('SIGKILL');
    removeProfileDir(this.userDataDir);
  }
}

/**
 * Temporary profile removal is best-effort: Chrome may still be unlinking its
 * own files as we go, and a leftover directory in the OS temp dir is never
 * worth failing a QA run over.
 */
function removeProfileDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort */
  }
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('close', () => {
      // Reject anything still outstanding rather than leaving a caller hanging
      // on a socket that will never answer.
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('cdp: connection closed before the command completed'));
      }
      this.pending.clear();
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
        return;
      }
      if (message.method) for (const listener of this.listeners) listener(message);
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendCommand(method, params = {}, sessionId, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp: ${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

export async function launchBrowser({ executablePath = findChrome(), timeoutMs = 30000 } = {}) {
  if (!executablePath) throw new Error('cdp: no Chrome/Chromium binary found (set APRASA_QA_CHROME)');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-qa-chrome-'));
  const child = spawn(
    executablePath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  // Everything from here to the returned browser is failure-cleanup territory:
  // an exception must never leave an orphaned Chrome process holding a
  // temporary profile directory for the rest of the job.
  const abandon = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    removeProfileDir(userDataDir);
  };

  let stderr = '';
  let endpoint;
  try {
    endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`cdp: browser did not expose a debugging endpoint within ${timeoutMs}ms`)),
        timeoutMs
      );
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`cdp: browser exited (code ${code}) before exposing a debugging endpoint`));
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        const match = stderr.match(/ws:\/\/[^\s]+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
  } catch (error) {
    abandon();
    throw error;
  }

  let socket;
  try {
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cdp: websocket did not open within ${timeoutMs}ms`)), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('cdp: websocket connection failed'));
      }, { once: true });
    });
  } catch (error) {
    try {
      socket?.close();
    } catch {
      /* nothing to close */
    }
    abandon();
    throw error;
  }

  return new CdpBrowser(child, new CdpConnection(socket), userDataDir);
}

export { CdpSession };
