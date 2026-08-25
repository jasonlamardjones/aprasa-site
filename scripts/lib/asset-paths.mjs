// Shared path-deepening helpers used by every PT static-page builder
// (build-static-pages.mjs, build-mindelo-pt.mjs). A PT page always lives
// exactly one directory deeper than its EN counterpart, so a reference to
// a shared root-level asset (assets/**, prasa-launch.css/js) needs exactly
// one extra "../" hop. This must be applied identically to plain
// href/src attributes AND to srcset's comma-separated "url descriptor"
// candidate list — missing the srcset case was a real, confirmed defect
// (a 375/768/1440-viewport responsive <source> silently 404ing from every
// PT page that used one, while the <img> fallback looked correct).

const SHARED_ASSET_PREFIX = /^((?:\.\.\/)*)(assets\/|prasa-launch\.css|prasa-launch\.js)/;

function deepenOneUrl(url) {
  const m = url.match(SHARED_ASSET_PREFIX);
  if (!m) return url;
  const [, ups, target] = m;
  return `../${ups}${target}${url.slice(m[0].length)}`;
}

export function deepenSharedAssetPaths(html) {
  html = html.replace(/((?:href|src)=")((?:\.\.\/)*)(assets\/|prasa-launch\.css|prasa-launch\.js)/g, (m, p1, ups, target) => `${p1}../${ups}${target}`);
  html = html.replace(/srcset="([^"]*)"/g, (m, value) => {
    const candidates = value.split(',').map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return candidate;
      const spaceIdx = trimmed.indexOf(' ');
      const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
      return `${deepenOneUrl(url)}${descriptor}`;
    });
    return `srcset="${candidates.join(', ')}"`;
  });
  return html;
}
