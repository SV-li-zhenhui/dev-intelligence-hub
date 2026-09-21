import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, app, styles, validator] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../scripts/validate-ui.mjs", import.meta.url), "utf8"),
]);

function cssColor(name) {
  const match = styles.match(new RegExp(`--${name}:\\s*(#[a-f0-9]{6})`, "iu"));
  assert.ok(match, `missing --${name}`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../gu)
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const values = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function cssRule(selector) {
  const start = styles.indexOf(selector);
  assert.ok(start >= 0, `missing CSS selector ${selector}`);
  const end = styles.indexOf("}", start);
  assert.ok(end > start, `unterminated CSS selector ${selector}`);
  return styles.slice(start, end + 1);
}

test("repeated navigation starts with a visible-on-focus skip link", () => {
  const body = html.slice(html.indexOf("<body>"));
  const skipLink = body.indexOf(
    '<a class="skip-link" href="#main-content">跳到主内容</a>',
  );
  const appShell = body.indexOf('<div class="app-shell">');

  assert.ok(skipLink >= 0 && appShell > skipLink);
  assert.match(
    html,
    /<main class="main" id="main-content" tabindex="-1">/u,
  );
  assert.match(
    html,
    /<h1 id="page-title" tabindex="-1">今天需要你推动什么<\/h1>/u,
  );
  assert.match(cssRule(".skip-link {"), /position:\s*(?:absolute|fixed)/u);
  assert.match(cssRule(".skip-link:focus-visible {"), /inset-inline-start:/u);
});

test("client-side view changes update the document title and focus the page heading", () => {
  const renderStart = app.indexOf("function render()");
  const renderEnd = app.indexOf("\nfunction bindSystemStatusView", renderStart);
  const render = app.slice(renderStart, renderEnd);
  const activateStart = app.indexOf("function activateView(view");
  const activateEnd = app.indexOf("\ndocument.querySelectorAll", activateStart);
  const activate = app.slice(activateStart, activateEnd);

  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.match(
    render,
    /document\.title = `\$\{viewTitles\[currentView\]\} · Development Intelligence Hub`/u,
  );
  assert.match(activate, /focusHeading = true/u);
  assert.match(activate, /pageTitle\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(
    app,
    /activateView\("configuration", \{ focusHeading: false \}\)/u,
  );
});

test("secondary text tokens meet normal-text contrast on every page surface", () => {
  for (const foregroundName of ["muted", "faint"]) {
    for (const backgroundName of ["paper", "surface"]) {
      const ratio = contrastRatio(
        cssColor(foregroundName),
        cssColor(backgroundName),
      );
      assert.ok(
        ratio >= 4.5,
        `${foregroundName} on ${backgroundName} contrast ${ratio.toFixed(3)}`,
      );
    }
  }
});

test("dense status and evidence labels remain at least 11px", () => {
  for (const selector of [
    ".section-heading span {",
    ".confirmation-center-panel-heading > span,",
    ".work-graph-card-heading > div > span {",
    ".work-graph-evidence code,",
    ".work-graph-overflow-note {",
  ]) {
    assert.match(cssRule(selector), /(?:font|font-size):\s*11px/u, selector);
  }
});

test("live browser acceptance exercises skip navigation and announced view changes", () => {
  const start = validator.indexOf("async function validate(name, viewport)");
  const end = validator.indexOf("\nawait validate(\"desktop-1440\"", start);
  const liveValidation = validator.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(liveValidation, /page\.keyboard\.press\("Tab"\)/u);
  assert.match(liveValidation, /skipLinkFocused/u);
  assert.match(liveValidation, /skipTargetFocused/u);
  assert.match(liveValidation, /viewTitleUpdated/u);
  assert.match(liveValidation, /viewHeadingFocused/u);
});
