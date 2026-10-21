#!/usr/bin/env node
// Bounded October 2026 hold, Spotlight and media-contract regressions.
// Mutations run only in a throwaway copy; production eligibility is untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-october-freshness-'));
fs.cpSync(root, sandbox, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
const read = (file) => fs.readFileSync(path.join(sandbox, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const write = (file, value) => fs.writeFileSync(path.join(sandbox, file), JSON.stringify(value, null, 2) + '\n');
const run = (file, args = []) => spawnSync(process.execPath, [file, ...args], { cwd: sandbox, encoding: 'utf8' });
let passed = 0;
function check(name, test) { test(); passed++; console.log(`PASS — ${name}`); }
const trainingFile = 'data/training-opportunities.json';
const training = json(trainingFile);
const held = ['academia-crescer', 'kafe-djan-djan'];
const reason = 'PENDING_CURRENTNESS_VERIFICATION';
const region = (html, id) => html.match(new RegExp(`<!-- BEGIN GENERATED TRAINING: ${id} -->([\\s\\S]*?)<!-- END GENERATED TRAINING: ${id} -->`))?.[1];
const card = (html) => html.match(/<article\b[^>]*data-local-spotlight="true"[\s\S]*?<\/article>/g) ?? [];
const esc = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
try {
  check('canonical validator accepts both bounded REVIEW-DUE holds', () => {
    assert.equal(run('scripts/validate-training-opportunities-data.mjs').status, 0);
    for (const id of held) {
      const row = training.records.find((record) => record.id === id);
      assert.equal(row.publication_state, 'REVIEW-DUE');
      assert.equal(row.ordinary_publication_eligibility, 'NOT_ELIGIBLE');
      assert.equal(row.ordinary_publication_reason, reason);
      assert.ok(row.source.provenance);
    }
  });
  check('existing paid-service exclusion and approved Learning Spotlight exception remain intact', () => {
    for (const id of ['myrtle', 'start-cv']) {
      const row = training.records.find((record) => record.id === id);
      assert.equal(row.ordinary_publication_eligibility, 'NOT_ELIGIBLE');
      assert.equal(row.ordinary_publication_reason, 'PAID_LOCAL_SERVICE_TRAINING');
    }
    for (const file of ['index.html', 'pt/index.html']) {
      assert.equal(region(read(file), 'myrtle')?.trim(), '');
      assert.match(region(read(file), 'start-cv'), /data-learning-spotlight="start-cv"/);
    }
  });
  for (const locale of ['en', 'pt']) {
    const file = locale === 'en' ? 'index.html' : 'pt/index.html';
    check(`${locale}: held regions empty and Start CV retained`, () => {
      for (const id of held) assert.equal(region(read(file), id)?.trim(), '');
      assert.match(region(read(file), 'start-cv'), /data-learning-spotlight="start-cv"/);
    });
    check(`${locale}: exact frozen Spotlight copy, checked date, links and no detail route`, () => {
      const cards = card(read(file));
      assert.equal(cards.length, 1);
      const html = cards[0];
      for (const row of json('data/locales/pt-overlay-haliotis-local-spotlight.source.json').rows) {
        assert.ok(html.includes(esc(locale === 'en' ? row.source_en : row.pt)), row.key);
      }
      for (const key of ['spotlight.local.label', 'spotlight.local.disclosure']) {
        assert.ok(html.includes(esc(json('data/locales/locale-data.generated.json').keys[key][locale])));
      }
      assert.match(html, /data-checked="2026-09-27"/);
      assert.equal((html.match(new RegExp(`href="https://haliotis.pt/${locale}/centros/cabo-verde/"`, 'g')) ?? []).length, 2);
      assert.doesNotMatch(html, /href="(?:\.\.\/)?things-to-do\/|Green Line|green-line|<img/);
    });
  }
  check('timestamps never restore either hold; other REVIEW-DUE records remain visible', () => {
    const data = structuredClone(training);
    for (const row of data.records) if (held.includes(row.id)) row.checked_at = '2026-10-21';
    const control = data.records.find((row) => row.id === 'hp-life');
    control.publication_state = 'REVIEW-DUE';
    control.checked_at = '2020-01-01';
    write(trainingFile, data);
    for (const locale of ['en', 'pt']) {
      const file = locale === 'en' ? 'index.html' : 'pt/index.html';
      assert.equal(run('scripts/generate-training-opportunities.mjs', [`--locale=${locale}`, `--home=${file}`, '--as-of=2027-12-31', '--write']).status, 0);
      for (const id of held) assert.equal(region(read(file), id)?.trim(), '');
      assert.match(region(read(file), 'hp-life'), /<article/);
    }
    write(trainingFile, training);
  });
  check('pending reason on an unauthorized record is rejected', () => {
    const data = structuredClone(training);
    Object.assign(data.records.find((row) => row.id === 'hp-life'), { publication_state: 'REVIEW-DUE', ordinary_publication_eligibility: 'NOT_ELIGIBLE', ordinary_publication_reason: reason });
    write(trainingFile, data);
    assert.equal(run('scripts/validate-training-opportunities-data.mjs').status, 1);
    write(trainingFile, training);
  });
  for (const state of ['CURRENT', 'EXPIRED', 'WITHDRAWN', 'TEMPORARILY_UNAVAILABLE']) {
    check(`pending hold cannot substitute factual state ${state}`, () => {
      const data = structuredClone(training);
      data.records.find((row) => row.id === held[0]).publication_state = state;
      write(trainingFile, data);
      assert.equal(run('scripts/validate-training-opportunities-data.mjs').status, 1);
      write(trainingFile, training);
    });
  }
  const manifestFile = 'internal/provider-media-manifest.json';
  const manifest = json(manifestFile);
  const green = manifest.records.find((row) => row.title === 'Green Line Tours — São Vicente Guided Tours');
  check('media validator accepts preserved Green Line detail and final Haliotis fallback', () => {
    const haliotis = manifest.records.find((row) => row.title === 'Diving & Snorkeling with Haliotis');
    assert.equal(haliotis.media_type, 'editorial-fallback');
    assert.equal(haliotis.media_state, 'fallback-final');
    assert.equal(haliotis.media_asset, null);
    assert.equal(run('scripts/validate-card-media.mjs').status, 0);
  });
  for (const mutation of ['missing-active-record', 'duplicate-active-record', 'provider-asset-substitution']) {
    check(`active Spotlight media integrity fails closed: ${mutation}`, () => {
      const data = structuredClone(manifest);
      const row = data.records.find((record) => record.title === 'Diving & Snorkeling with Haliotis');
      if (mutation === 'missing-active-record') data.records = data.records.filter((record) => record !== row);
      if (mutation === 'duplicate-active-record') data.records.push(structuredClone(row));
      if (mutation === 'provider-asset-substitution') Object.assign(row, {
        media_type: 'provider-owned', media_state: 'authentic-present',
        media_asset: green.media_asset, media_source: green.media_source,
        media_alt: green.media_alt, media_checked_date: green.media_checked_date,
      });
      write(manifestFile, data);
      assert.equal(run('scripts/validate-card-media.mjs').status, 1);
      write(manifestFile, manifest);
    });
  }
  for (const mutation of ['missing-page', 'wrong-title', 'wrong-provider', 'invalid-route']) {
    check(`retained-detail binding fails closed: ${mutation}`, () => {
      const data = structuredClone(manifest);
      const row = data.records.find((item) => item.title === green.title);
      if (mutation === 'missing-page') row.retained_detail_page = 'things-to-do/missing/index.html';
      if (mutation === 'wrong-title') row.title = 'Another provider';
      if (mutation === 'wrong-provider') row.source_url = 'https://example.invalid/';
      if (mutation === 'invalid-route') row.retained_detail_page = '../index.html';
      write(manifestFile, data);
      assert.equal(run('scripts/validate-card-media.mjs').status, 1);
      write(manifestFile, manifest);
    });
  }
  check('another existing page cannot authorize an arbitrary historical media record', () => {
    const data = structuredClone(manifest);
    const row = structuredClone(green);
    row.title = 'Unapproved historical provider';
    row.retained_detail_page = 'things-to-do/unapproved-history/index.html';
    const file = path.join(sandbox, row.retained_detail_page);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<h1>${row.title}</h1><a href="${row.source_url}">Provider</a>`);
    data.records.push(row);
    write(manifestFile, data);
    assert.equal(run('scripts/validate-card-media.mjs').status, 1);
    write(manifestFile, manifest);
  });
  for (const mutation of ['missing-rendered-image', 'wrong-rendered-asset', 'wrong-alt', 'missing-asset-file']) {
    check(`historical media integrity fails closed: ${mutation}`, () => {
      const file = path.join(sandbox, green.retained_detail_page);
      const original = fs.readFileSync(file, 'utf8');
      const assetFile = path.join(sandbox, green.media_asset);
      const asset = fs.readFileSync(assetFile);
      if (mutation === 'missing-rendered-image') fs.writeFileSync(file, original.replace(/<div class="record-media">[\s\S]*?<\/div>/, ''));
      if (mutation === 'wrong-rendered-asset') fs.writeFileSync(file, original.replace('../../' + green.media_asset, '../../assets/brand/A_PRASA_Symbol_v2_Primary_Green.svg'));
      if (mutation === 'wrong-alt') fs.writeFileSync(file, original.replace(`alt="${green.media_alt}"`, 'alt="Unapproved provider claim"'));
      if (mutation === 'missing-asset-file') fs.rmSync(assetFile);
      assert.equal(run('scripts/validate-card-media.mjs').status, 1);
      fs.writeFileSync(file, original);
      fs.writeFileSync(assetFile, asset);
    });
  }
  check('altered Haliotis outbound target blocks PT generation', () => {
    const file = 'index.html';
    const html = read(file);
    fs.writeFileSync(path.join(sandbox, file), html.replace('https://haliotis.pt/en/centros/cabo-verde/', 'https://example.invalid/'));
    assert.equal(run('scripts/build-static-pages.mjs', ['--write']).status, 1);
    fs.writeFileSync(path.join(sandbox, file), html);
  });
  check('generated Haliotis PT drift is rejected by localization validation', () => {
    const file = 'data/locales/locale-data.generated.json';
    const data = json(file);
    data.keys['home.haliotis_spotlight.checked'].pt = 'Revisto em 21 de outubro de 2026';
    write(file, data);
    assert.equal(run('scripts/validate-locale-contract.mjs').status, 1);
  });
  check('unapproved Haliotis localization change is rejected', () => {
    const file = 'data/locales/pt-overlay-haliotis-local-spotlight.source.json';
    const data = json(file);
    data.rows[0].pt += ' changed';
    write(file, data);
    assert.equal(run('scripts/build-locale-data.mjs').status, 1);
  });
  console.log(`October Home freshness: ${passed}/${passed} checks passed.`);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
