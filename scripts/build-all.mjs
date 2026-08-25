#!/usr/bin/env node
// Single canonical orchestrator for the full EN/PT localization build.
// Running the individual generators by hand in the wrong order is exactly
// how pt/index.html previously ended up with English Things-to-Do event
// content baked into its generated-event regions (see the comment below on
// why the order matters) — this script exists so there is one obviously
// correct entry point instead of a sequence someone has to remember.
//
// Usage: node scripts/build-all.mjs [--as-of=YYYY-MM-DD]
// Defaults --as-of to data/things-to-do-currentness.json's own as_of value,
// matching what the Things-to-Do CI workflow already does.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const asOfArg = process.argv.find((a) => a.startsWith('--as-of='));
const asOf = asOfArg ? asOfArg.split('=')[1] : JSON.parse(fs.readFileSync(path.join(root, 'data', 'things-to-do-currentness.json'), 'utf8')).as_of;

function run(script, args) {
  console.log(`\n[build-all] node ${script} ${args.join(' ')}`);
  execFileSync('node', [script, ...args], { cwd: root, stdio: 'inherit' });
}

// Ordering invariant — DO NOT reorder without re-reading why each step is
// where it is:
//
// 1. build-locale-data.mjs must run first: every later step reads
//    data/locales/locale-data.generated.json.
//
// 2. generate-things-to-do.mjs --locale=en establishes the canonical EN
//    Home + EN detail pages. This is the source build-static-pages.mjs
//    derives every PT static page FROM in step 3, so it must be fresh
//    before that derivation happens.
//
// 3. build-static-pages.mjs derives pt/index.html (and every other static
//    PT page) from the EN sources. Its localizer deliberately passes
//    Things-to-Do's <!-- BEGIN/END GENERATED EVENT --> regions through
//    UNCHANGED (that content is generate-things-to-do.mjs's territory, not
//    the static-page localizer's) — which means immediately after this
//    step, pt/index.html's event regions still hold English content
//    (a verbatim copy of whatever was in EN index.html). That is expected
//    and temporary: step 4 corrects it.
//
// 4. generate-things-to-do.mjs --locale=pt --home=pt/index.html runs LAST
//    and ONLY rewrites the content between each record's own
//    BEGIN/END GENERATED EVENT markers inside pt/index.html, leaving
//    everything else on that page — the chrome, prose, hreflang, nav,
//    lang-switch step 3 just wrote — untouched. This is what actually
//    replaces the temporary English event content with the governed PT
//    presentation. Running this BEFORE step 3 (as an earlier, incorrect
//    version of this pipeline did by invoking the scripts in the wrong
//    order) means step 3's from-EN derivation runs *after* the correct PT
//    fill and clobbers it right back to English — that was the root cause
//    of the defect this ordering exists to prevent.
//
// 5/6. Mindelo Essentials and the sitemap are independent of the Home
//    event-region ordering above and can run last.
//
// 7. validate-training-opportunities-currentness.mjs runs last, against both
//    the EN and PT Home output this run just produced, using the same
//    resolved --as-of as every other step above. This is the canonical gate
//    for the hand-authored (non-Things-to-Do) Home opportunity records: it
//    fails the build if either Home surface still presents a record past its
//    governed end date, so a stale opportunity can't ship unnoticed through
//    the one script that already builds the full site. It is intentionally
//    separate from the Things-to-Do currentness system above and does not
//    change that system's semantics.

run('scripts/build-locale-data.mjs', []);
run('scripts/generate-things-to-do.mjs', [`--as-of=${asOf}`, '--locale=en', '--write']);
run('scripts/build-static-pages.mjs', ['--write']);
run('scripts/generate-things-to-do.mjs', [`--as-of=${asOf}`, '--locale=pt', '--home=pt/index.html', '--write']);
run('scripts/build-mindelo-pt.mjs', ['--write']);
run('scripts/build-sitemap.mjs', ['--write']);
run('scripts/validate-training-opportunities-currentness.mjs', [`--as-of=${asOf}`, '--home=index.html', '--home=pt/index.html']);

console.log('\n[build-all] done.');
