// Derived WhatsApp destinations for the page runtimes.
//
// data/contact-channels.json is the ONE place the canonical A PRASA WhatsApp
// Business number lives. Nothing else — runtime, generator or test — may carry
// it as an independent literal; everything derives from here, so the number can
// only ever be changed in one place.
//
// Exactly two destination forms are authorized, and they are two forms of the
// SAME account, not two destinations:
//   shortLink     the incumbent governed short code, used when no quick action
//                 is selected. Unchanged since the launcher shipped.
//   numberBaseUrl https://wa.me/<canonical digits>, to which the runtime appends
//                 a single `text` parameter carrying a governed prefill.
//
// The builder writes both into a small JSON island beside the governed
// i18n-strings block, so the runtime never has to know the number itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = path.join(root, 'data', 'contact-channels.json');

export const CONTACT_CONFIG_BLOCK = /<script type="application\/json" id="contact-config">[\s\S]*?<\/script>\n?/;

let cached = null;

export function loadContactChannels() {
  if (cached) return cached;
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const wa = raw?.whatsapp;
  if (!wa) throw new Error('contact-channels.json: missing whatsapp section');

  const number = wa.whatsapp_business_number;
  // Fail loudly at build time rather than shipping a malformed destination.
  if (typeof number !== 'string' || !/^[0-9]{8,15}$/.test(number)) {
    throw new Error(`contact-channels.json: whatsapp_business_number must be 8-15 digits in international form, got ${JSON.stringify(number)}`);
  }
  const expectedBase = `https://wa.me/${number}`;
  if (wa.number_base_url !== expectedBase) {
    throw new Error(`contact-channels.json: number_base_url ${JSON.stringify(wa.number_base_url)} does not derive from whatsapp_business_number (${expectedBase})`);
  }
  if (typeof wa.short_link !== 'string' || !wa.short_link.startsWith('https://wa.me/message/')) {
    throw new Error(`contact-channels.json: short_link is not a wa.me short code: ${JSON.stringify(wa.short_link)}`);
  }
  if ((wa.display || '').replace(/\D/g, '') !== number) {
    throw new Error('contact-channels.json: display number and whatsapp_business_number disagree');
  }

  cached = { number, shortLink: wa.short_link, numberBaseUrl: expectedBase };
  return cached;
}

/** The payload the page runtimes read. Deliberately only the two destinations. */
export function contactConfigPayload() {
  const { shortLink, numberBaseUrl } = loadContactChannels();
  return { shortLink, numberBaseUrl };
}

export function renderContactConfigBlock() {
  return `<script type="application/json" id="contact-config">${JSON.stringify(contactConfigPayload())}</script>\n`;
}

export function applyContactConfig(html) {
  const block = renderContactConfigBlock();
  if (CONTACT_CONFIG_BLOCK.test(html)) return html.replace(CONTACT_CONFIG_BLOCK, block);
  return html.replace('</head>', `${block}</head>`);
}
