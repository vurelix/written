// Render smoke harness — implementation plan rev.8 §D3.
//
// Targets the BUILT renderer over file://, so the CSP that build-renderer.js injects
// is exercised as it ships. Everything here is invisible to the Node vm logic suite.
'use strict';

const path = require('node:path');
const { test, expect } = require('@playwright/test');

const RENDERER = 'file://' + path.resolve(__dirname, '..', 'renderer', 'index.html');
const STORE_KEY = 'written-profiles-v2';
const SEARCH_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';

// Widgets that scroll their own content on purpose. A blanket clipping assertion
// would flag these; anything NOT on this list must fit inside its card.
const INTENTIONAL_SCROLLERS = new Set(['recent', 'checklist']);

function profileFixture({ widgets, extraSettings } = {}) {
  const settings = {
    onboarded: true,
    loggedOut: false,
    accent: '#3DDC97',
    theme: 'dark',
    riskPct: 1,
    quickPresets: [],
    tourCompleted: true,
  };
  if (widgets) settings.widgets = widgets;
  if (extraSettings) Object.assign(settings, extraSettings);
  return {
    version: 2,
    activeProfileId: 'smoke',
    profiles: {
      smoke: {
        id: 'smoke',
        createdAt: 1,
        lastUsedAt: 2,
        settings,
        days: {
          '2026-07-20': { emoji: '🙂', trades: [{ sym: 'MES', side: 'LONG', qty: 1, entry: 100, pnl: 120 }] },
          '2026-07-21': { emoji: '🙁', trades: [{ sym: 'NQ', side: 'SHORT', qty: 2, entry: 200, pnl: -45 }] },
          '2026-07-22': { emoji: '😄', trades: [{ sym: 'MES', side: 'LONG', qty: 1, entry: 100, pnl: 60 }] },
        },
      },
    },
  };
}

// Collects failures rather than asserting inline, so one run reports everything.
//
// Console errors are judged AFTER hydration, not from first paint. The dc-runtime
// streams raw `{{binding}}` text into SVG attributes before it hydrates, and Chromium
// logs a parse error for each one ("<circle> attribute cx: Expected length, {{dot.cx}}").
// Those are unavoidable artifacts of the runtime's placeholder markup.
//
// Filtering them by MESSAGE would be wrong: a binding that is never exposed leaves
// `{{name}}` in the DOM permanently, and that is a real defect this project has hit
// before. So instead we ignore the pre-hydration phase and assert separately that no
// placeholder survives into the rendered DOM.
function watch(page) {
  const all = [];
  page.on('pageerror', e => all.push({ at: Date.now(), text: `pageerror: ${e.message}` }));
  page.on('console', m => {
    if (m.type() === 'error') all.push({ at: Date.now(), text: `console: ${m.text()}` });
  });
  return {
    since: from => all.filter(e => e.at >= from).map(e => e.text),
    all: () => all.map(e => e.text),
  };
}

async function boot(page, store) {
  await page.addInitScript(([key, value]) => {
    window.localStorage.setItem(key, value);
  }, [STORE_KEY, JSON.stringify(store)]);
  await page.goto(RENDERER);
  // Readiness is a rendered screen, never a fixed timeout. Without a seeded profile
  // the app shows Login/Setup and every geometry assertion below passes vacuously.
  await page.waitForSelector('[data-screen-label="Dashboard"]', { timeout: 15000 });
}

test.describe('built renderer', () => {
  test('boots to the dashboard with no errors after hydration', async ({ page }) => {
    const errors = watch(page);
    await boot(page, profileFixture());
    const hydrated = Date.now();
    await page.waitForTimeout(500);
    expect(errors.since(hydrated), 'clean console once hydrated').toEqual([]);
  });

  test('no unresolved {{binding}} placeholders survive into the DOM', async ({ page }) => {
    // Guards the "binding must be an exposed name" failure mode: an unexposed {{name}}
    // renders as literal text with no error of any kind.
    await boot(page, profileFixture());
    await page.waitForTimeout(500);
    const leaked = await page.evaluate(() => {
      const out = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const m = n.nodeValue && n.nodeValue.match(/\{\{[^}]+\}\}/g);
        if (m) out.push(...m);
      }
      document.querySelectorAll('*').forEach(el => {
        for (const attr of el.attributes) {
          const m = attr.value && attr.value.match(/\{\{[^}]+\}\}/g);
          if (m) out.push(...m.map(x => `${attr.name}=${x}`));
        }
      });
      return [...new Set(out)];
    });
    expect(leaked, 'every binding resolved').toEqual([]);
  });

  test('accent-driven fills resolve to real colours', async ({ page }) => {
    // Invalid CSS declarations are dropped SILENTLY, so a console check cannot catch
    // them. This is the class of bug that has shipped twice in this file: a var()
    // token concatenated into an invalid colour, rendering the element transparent.
    await boot(page, profileFixture());
    const accent = await page.evaluate(() => {
      const root = document.querySelector('[data-screen-label="Titlebar"]').closest('div[style*="--accent"]')
        || document.body.firstElementChild;
      return getComputedStyle(root).getPropertyValue('--accent').trim();
    });
    expect(accent, '--accent is bound on the app root').toBe('#3DDC97');
  });

  test('background glow off leaves no aurora on screen', async ({ page }) => {
    // MUST run in perf mode "full". perf.css blanket-kills animation-name in reduced/max,
    // and reduced is both the shipped default AND what perf.js falls back to over file://
    // where there is no desktopPrefs bridge. Under that fallback every assertion here
    // passes whether or not the fix exists — which is exactly how this bug survived: it
    // only ever manifests for users who switch View -> Performance Mode -> Full.
    const bootFull = async settings => {
      await page.addInitScript(() => {
        window.desktopPrefs = {
          validModes: ['full', 'reduced', 'max'],
          defaultMode: 'full',
          getPerfMode: () => 'full',
        };
      });
      await boot(page, profileFixture({ extraSettings: settings }));
      expect(await page.getAttribute('html', 'data-perf'), 'running in full perf mode').toBe('full');
    };

    // This has to be a RENDERED check. The binding said opacity:0 the whole time the bug
    // was live — glowpulse animates opacity, and a running animation's computed value
    // beats an inline author style, so only getComputedStyle sees the truth.
    const read = () => page.evaluate(() => {
      const container = document.querySelector('.bg-aurora');
      if (!container) return null;
      return [...container.children].map(el => {
        const cs = getComputedStyle(el);
        return { opacity: cs.opacity, animationName: cs.animationName };
      });
    });

    await bootFull({ glow: 'off' });
    // Sample well into the 9-13s glowpulse cycle: at t=0 the keyframe happens to sit at
    // .85, so an immediate read could pass against a still-animating element.
    await page.waitForTimeout(800);

    const off = await read();
    expect(off, '.bg-aurora container is present').not.toBeNull();
    expect(off.length, 'three aurora blobs').toBe(3);
    for (const layer of off) {
      expect(layer.opacity, 'aurora blob is fully transparent').toBe('0');
      expect(layer.animationName, 'aurora blob is not animating').toBe('none');
    }

    // Positive control — without it this test would still pass if the layers vanished
    // entirely, if the selector silently matched nothing, or if animations were globally
    // disabled by the environment (which is what happened the first time it was written).
    await bootFull({ glow: 'soft' });
    await page.waitForTimeout(800);
    const on = await read();
    expect(on.length).toBe(3);
    for (const layer of on) {
      expect(Number(layer.opacity), 'aurora blob is visible when glow is on').toBeGreaterThan(0);
      expect(layer.animationName).toContain('glowpulse');
    }
  });

  test('a followed checklist rule stays readable on both themes', async ({ page }) => {
    // Regression: the followed label took accentInk (#07130C for bright accents), which
    // is the ink for text sitting ON an accent fill. The label sits on the page
    // background, so on the dark theme it went effectively invisible.
    //
    // Asserted on contrast rather than on an exact colour, so any future mechanism that
    // dims this text — a cascade override, a theme token change — still trips the test.
    const today = (d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date());

    for (const theme of ['dark', 'light']) {
      await boot(page, profileFixture({
        widgets: { checklist: { on: 1, columns: 8, rows: 12 } },
        extraSettings: { theme, checklist: { [today]: { 0: true } } },
      }));
      await page.waitForSelector('[data-widget-id="checklist"]', { timeout: 15000 });

      const ratio = await page.evaluate(() => {
        // sRGB relative luminance, WCAG 2.x.
        const lum = c => {
          const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3)
            .map(Number)
            .map(v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        // Walk up for the first non-transparent backdrop the label actually sits on.
        const backdrop = el => {
          for (let n = el; n; n = n.parentElement) {
            const bg = getComputedStyle(n).backgroundColor;
            const a = bg.match(/[\d.]+/g);
            if (a && (a.length < 4 || Number(a[3]) > 0.9)) return bg;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        const widget = document.querySelector('[data-widget-id="checklist"]');
        const ticked = [...widget.querySelectorAll('button')]
          .find(b => (b.textContent || '').includes('✓'));
        if (!ticked) return null;
        const label = ticked.lastElementChild;
        const l1 = lum(getComputedStyle(label).color);
        const l2 = lum(backdrop(label));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      });

      expect(ratio, `a followed rule was found on ${theme}`).not.toBeNull();
      expect(ratio, `followed rule label contrast on ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('focus rings use the chosen accent on overlays outside the app shell', async ({ page }) => {
    // Regression: the focus-visible rule read var(--focus-accent,#3DDC97), and
    // --focus-accent was only ever declared on .app-main and .annotation-overlay. The
    // Setup Wizard, Login, Splash and Launching screens are fixed-position SIBLINGS of
    // .app-main, so they never inherited it and every focus ring there fell back to the
    // hardcoded green — which is --green, not the user's accent.
    //
    // A purple accent is used deliberately: with the default green accent the bug is
    // invisible, because the fallback happens to equal the correct answer.
    const ACCENT = '#C29BFF';
    const EXPECTED = 'rgb(194, 155, 255)';

    const outlineOfFocused = () => page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { color: cs.outlineColor, width: cs.outlineWidth, tag: el.tagName };
    });

    // 1) Outside the app shell — the surface that was broken.
    await page.addInitScript(([key, value]) => {
      window.localStorage.setItem(key, value);
    }, [STORE_KEY, JSON.stringify(profileFixture({ extraSettings: { accent: ACCENT, loggedOut: true } }))]);
    await page.goto(RENDERER);
    await page.waitForSelector('[data-screen-label="Login"]', { timeout: 15000 });

    await page.keyboard.press('Tab');
    const onLogin = await outlineOfFocused();
    expect(onLogin, 'keyboard focus landed on a Login control').not.toBeNull();
    expect(onLogin.color, 'Login focus ring tracks the accent').toBe(EXPECTED);
    expect(onLogin.width).toBe('2px');

    // 2) Inside the app shell — the surface that always worked. Without this the test
    // would still pass if the rule stopped producing an outline anywhere at all.
    await boot(page, profileFixture({ extraSettings: { accent: ACCENT } }));
    await page.keyboard.press('Tab');
    const inApp = await outlineOfFocused();
    expect(inApp, 'keyboard focus landed on an in-app control').not.toBeNull();
    expect(inApp.color, 'in-app focus ring tracks the accent').toBe(EXPECTED);
  });

  test('note tab labels sit centred whether or not the tab has content', async ({ page }) => {
    // Reported as "right-side padding shifts the text". The padding is actually
    // symmetric (6px 12px) — the culprit was the 5px status dot, which stayed in flow
    // even when empty (only its background went transparent). Dot + 6px gap pushed every
    // label 11px right of centre, which reads exactly like extra padding on the right.
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Calendar', exact: true }).click();
    await page.waitForSelector('.calendar-cell', { timeout: 15000 });
    await page.locator('.calendar-cell').filter({ hasText: /\S/ }).first().click();
    await page.waitForSelector('button:has-text("Psychology")', { timeout: 15000 });

    const offsets = await page.evaluate(() => {
      const names = ['Market', 'Lessons', 'Psychology', 'Homework', 'Ideas', 'Research'];
      return names.map(name => {
        const btn = [...document.querySelectorAll('button')]
          .find(b => b.textContent.trim() === name && getComputedStyle(b).borderRadius === '999px');
        if (!btn) return { name, missing: true };
        // The dc-runtime wraps the interpolated label in its own span, so the label is
        // an element, and a filled tab has the dot span in front of it.
        const spans = [...btn.querySelectorAll('span')];
        const label = spans[spans.length - 1];
        const box = btn.getBoundingClientRect();
        const text = label.getBoundingClientRect();
        return {
          name,
          spans: spans.length,
          // Positive means the label sits right of the button's centre.
          offset: ((text.left + text.right) / 2) - ((box.left + box.right) / 2),
        };
      });
    });

    expect(offsets.filter(o => o.missing), 'every note tab was found').toEqual([]);
    // A day with no notes: no tab is filled, so no tab carries a dot and every label is
    // genuinely centred. Before the fix each one sat ~5.5px right of centre.
    for (const tab of offsets) {
      expect(tab.spans, `${tab.name} has no dot when empty`).toBe(1);
      expect(Math.abs(tab.offset), `${tab.name} label is centred`).toBeLessThanOrEqual(1);
    }
  });

  test('insights sliders sweep from zero when the page is opened', async ({ page }) => {
    // The fills were computed unconditionally, so the very first render already carried
    // the final width and the CSS transition had nothing to animate from — the sliders
    // just appeared, filled. Sampling every frame is the only way to see the difference:
    // the settled value is identical either way.
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page, profileFixture());

    await page.evaluate(() => {
      window.__fillSamples = [];
      const tick = () => {
        const el = document.querySelector('.range-fill');
        if (el) window.__fillSamples.push(el.getBoundingClientRect().width);
        window.__fillRaf = requestAnimationFrame(tick);
      };
      tick();
    });

    await page.getByRole('button', { name: 'Insights', exact: true }).click();
    await page.waitForSelector('.range-control', { timeout: 15000 });
    await page.waitForTimeout(700); // the fill transition is 320ms

    const samples = await page.evaluate(() => {
      cancelAnimationFrame(window.__fillRaf);
      return window.__fillSamples;
    });

    expect(samples.length, 'frames were sampled').toBeGreaterThan(5);
    const settled = samples[samples.length - 1];
    expect(settled, 'the slider ends up filled').toBeGreaterThan(10);
    // It must have started at zero...
    expect(Math.min(...samples), 'the fill starts empty').toBeLessThanOrEqual(1);
    // ...and passed through intermediate widths rather than snapping. A jump straight to
    // the final value would show only two distinct widths.
    const distinct = new Set(samples.map(w => Math.round(w))).size;
    expect(distinct, 'the fill animates through intermediate widths').toBeGreaterThanOrEqual(5);
  });

  test('command palette owns focus and restores its titlebar trigger', async ({ page }) => {
    await boot(page, profileFixture());
    const trigger = page.getByRole('button', { name: 'Search this journal' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox', { name: 'Search this journal' });
    await expect(input).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(input).toBeFocused();
    await page.locator('.command-palette-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('titlebar search shortcut computes the native symbol font stack', async ({ page }) => {
    await boot(page, profileFixture());
    const fontFamily = await page.locator('.global-search-trigger kbd').evaluate(element =>
      getComputedStyle(element).fontFamily
    );
    expect(fontFamily).toContain('Apple Color Emoji');
    expect(fontFamily).toContain('Segoe UI Emoji');
    expect(fontFamily).toContain('Segoe UI Symbol');
    expect(fontFamily).toContain('system-ui');
    expect(fontFamily).not.toContain('Manrope');
  });

  test('Windows scroll hides the titlebar and the command palette follows its offset', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'desktopPlatform', { value: 'win32', configurable: true });
    });
    await boot(page, profileFixture());
    const appRoot = page.locator('[data-screen-label="Titlebar"]').locator('..');
    await expect(appRoot).toHaveCSS('--titlebar-offset', '44px');

    await page.evaluate(() => window.scrollTo(0, 100));
    await expect(appRoot).toHaveCSS('--titlebar-offset', '0px');
    await expect.poll(() => page.locator('[data-screen-label="Titlebar"]').evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1);

    await page.keyboard.press('Control+K');
    const backdrop = page.locator('.command-palette-backdrop');
    await expect(backdrop).toBeVisible();
    await expect.poll(() => backdrop.evaluate(el => el.getBoundingClientRect().top)).toBe(0);
    await page.keyboard.press('Escape');

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(appRoot).toHaveCSS('--titlebar-offset', '44px');
    await expect.poll(() => page.locator('[data-screen-label="Titlebar"]').evaluate(el => el.getBoundingClientRect().top)).toBe(0);
  });

  test('alignment sweep keeps profile, risk settings, and insights geometry even', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page, profileFixture());
    const rootTokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return [style.getPropertyValue('--accent').trim(), style.getPropertyValue('--accent-ink').trim()];
    });
    expect(rootTokens).toEqual(['#3DDC97', '#07130C']);

    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    const profileCenterDelta = await page.locator('[data-screen-label="Profile"]').evaluate(el => {
      const own = el.getBoundingClientRect();
      const parent = el.parentElement.getBoundingClientRect();
      return Math.abs((own.left + own.right) / 2 - (parent.left + parent.right) / 2);
    });
    expect(profileCenterDelta, 'profile grid is centered in the 1440p content column').toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const fieldControlTops = await page.$$eval('.risk-setting-field', fields =>
      fields.map(field => field.lastElementChild.getBoundingClientRect().top)
    );
    expect(fieldControlTops).toHaveLength(2);
    expect(Math.abs(fieldControlTops[0] - fieldControlTops[1]), 'balance and risk controls share a baseline').toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: 'Insights', exact: true }).click();
    const splitWidths = await page.$$eval('.risk-analytics-split > div', els =>
      els.map(el => el.getBoundingClientRect().width)
    );
    expect(splitWidths).toHaveLength(2);
    expect(Math.abs(splitWidths[0] - splitWidths[1]), 'risk analytics uses an even split').toBeLessThanOrEqual(1);
    const changeRights = await page.$$eval('.expectancy-change', els =>
      els.map(el => el.getBoundingClientRect().right)
    );
    expect(changeRights).toHaveLength(3);
    expect(Math.max(...changeRights) - Math.min(...changeRights), 'expectancy changes share a right edge').toBeLessThanOrEqual(1);
  });

  test('the dashboard never scrolls the document horizontally', async ({ page }) => {
    for (const size of [
      { width: 900, height: 650 },
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
      { width: 2560, height: 1440 },
    ]) {
      await page.setViewportSize(size);
      await boot(page, profileFixture());
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `no horizontal overflow at ${size.width}x${size.height}`).toBeLessThanOrEqual(1);
    }
  });

  test('widgets never overlap each other', async ({ page }) => {
    await boot(page, profileFixture());
    const boxes = await page.$$eval('.dashboard-widget', els =>
      els.map(el => {
        const r = el.getBoundingClientRect();
        return { id: el.getAttribute('data-widget-id'), x: r.x, y: r.y, w: r.width, h: r.height };
      })
    );
    expect(boxes.length).toBeGreaterThan(0);
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        if (hit) overlaps.push(`${a.id} overlaps ${b.id}`);
      }
    }
    expect(overlaps).toEqual([]);
  });

  test('widget content is not silently clipped', async ({ page }) => {
    // .dashboard-widget is overflow:hidden, so document-scroll and intersection checks
    // above pass happily while content is cut off INSIDE a card.
    await boot(page, profileFixture());
    const clipped = await page.$$eval('.dashboard-widget', (els, scrollers) =>
      els
        .map(el => ({
          id: el.getAttribute('data-widget-id'),
          dx: el.scrollWidth - el.clientWidth,
          dy: el.scrollHeight - el.clientHeight,
        }))
        .filter(w => !scrollers.includes(w.id) && (w.dx > 1 || w.dy > 1)),
      [...INTENTIONAL_SCROLLERS]
    );
    expect(clipped, 'no widget clips its own content').toEqual([]);
  });

  test('the consistency widget fits at every supported size extreme', async ({ page }) => {
    // The four corners of the resize range declared in the widget registry.
    const sizes = [
      { columns: 6, rows: 6 },
      { columns: 12, rows: 6 },
      { columns: 6, rows: 12 },
      { columns: 12, rows: 12 },
    ];
    await boot(page, profileFixture({
      widgets: { heatmap: { on: 1, ...sizes[0] } },
    }));

    for (const size of sizes) {
      const store = profileFixture({
        widgets: { heatmap: { on: 1, ...size } },
      });
      await page.evaluate(([key, value]) => {
        window.localStorage.setItem(key, value);
      }, [STORE_KEY, JSON.stringify(store)]);
      await page.reload();
      await page.waitForSelector('[data-widget-id="heatmap"]', { timeout: 15000 });
      const overflow = await page.$eval('[data-widget-id="heatmap"]', el => ({
        dx: el.scrollWidth - el.clientWidth,
        dy: el.scrollHeight - el.clientHeight,
      }));
      expect(overflow, `consistency fits at ${size.columns}x${size.rows}`).toEqual({ dx: 0, dy: 0 });
    }

  });

  test('the consistency heatmap is legible at its default size', async ({ page }) => {
    // Reported as "too small". The grid CSS is fully responsive — the cause was the
    // registry default of 8x7, which left cells at 19.8px. The size-extremes test above
    // would never have caught it: it only ever asserts overflow, and only at the corners
    // of the range. This asserts the DEFAULT, which is what users actually see.
    //
    // Its own test on a clean page, deliberately. Reusing the page above fails: the app
    // flushes its own store on unload, so a localStorage write followed by reload gets
    // clobbered and the widget comes back at the wrong size.
    //
    // Omitting columns/rows is also deliberate — normalizeWidgetConfig then falls back to
    // the registry defaults, so this tracks them rather than restating them.
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page, profileFixture({ widgets: { heatmap: { on: 1 } } }));
    await page.waitForSelector('[data-widget-id="heatmap"] .consistency-cell', { timeout: 15000 });

    const cell = await page.$eval('[data-widget-id="heatmap"] .consistency-cell', el => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    // 19.8px at the old 8x7 default, 30.7px at 10x9.
    expect(cell.width, 'heatmap cells are legible at the default size').toBeGreaterThanOrEqual(28);
    expect(Math.abs(cell.width - cell.height), 'cells stay square').toBeLessThanOrEqual(1);
  });

  test('profile customization stretches to the all-time record row height', async ({ page }) => {
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.waitForSelector('[data-screen-label="Profile"]');
    const heights = await page.$$eval(
      '[data-screen-label="Profile"] > .glass-surface',
      els => els.slice(0, 2).map(el => el.getBoundingClientRect().height)
    );
    expect(heights).toHaveLength(2);
    expect(Math.abs(heights[0] - heights[1]), 'cards share the first grid row height').toBeLessThanOrEqual(1);
  });

  test('Help categories reveal treasure-map articles and open one focus-managed modal', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Help', exact: true }).click();

    const gettingStarted = page.getByRole('button', { name: 'Getting Started' });
    const dashboard = page.getByRole('button', { name: 'Dashboard and Insights' });
    await gettingStarted.click();
    await expect(gettingStarted).toHaveAttribute('aria-expanded', 'true');
    await dashboard.click();
    await expect(gettingStarted).toHaveAttribute('aria-expanded', 'false');
    await expect(dashboard).toHaveAttribute('aria-expanded', 'true');

    await gettingStarted.click();
    const articleNode = page.getByRole('button', { name: 'How do I journal a trading day?' });
    await articleNode.focus();
    await articleNode.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'How do I journal a trading day?' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
    const closeButton = dialog.getByRole('button', { name: 'Close Help article' });
    await expect(closeButton).toBeFocused();
    const backdrop = page.locator('.help-article-backdrop');
    const titlebar = page.locator('[data-screen-label="Titlebar"]');
    const appShell = page.locator('[data-screen-label="Sidebar"]').locator('..');
    await expect.poll(() => backdrop.evaluate(element => element.getBoundingClientRect().top)).toBe(0);
    await expect(titlebar).toHaveAttribute('inert', '');
    await expect(titlebar).toHaveAttribute('aria-hidden', 'true');
    await expect(appShell).toHaveAttribute('inert', '');
    await expect(appShell).toHaveAttribute('aria-hidden', 'true');
    expect(await dialog.evaluate(element => !!element.closest('[inert]'))).toBe(false);

    await page.keyboard.press(SEARCH_SHORTCUT);
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(closeButton).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(closeButton).toBeFocused();
    await dialog.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(articleNode).toBeFocused();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    await expect(gettingStarted).toHaveAttribute('aria-expanded', 'true');
    await expect(titlebar).not.toHaveAttribute('inert', '');
    await expect(appShell).not.toHaveAttribute('inert', '');

    await articleNode.click();
    await dialog.getByRole('button', { name: 'Close Help article' }).click();
    await expect(dialog).toBeHidden();
    await articleNode.click();
    await page.locator('.help-article-backdrop').click({ position: { x: 4, y: 4 } });
    await expect(dialog).toBeHidden();
  });

  test('Help search reveals its matching category without opening an article', async ({ page }) => {
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Help', exact: true }).click();

    const search = page.getByRole('searchbox', { name: 'Search Help' });
    await search.fill('active only in memory');
    await expect(page.getByRole('button', { name: 'Data and Troubleshooting' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.help-article-backdrop')).toHaveAttribute('data-open', 'false');
  });

  test('Help treasure map fits narrow screens and gives every route node space', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 800 });
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    const gettingStarted = page.getByRole('button', { name: 'Getting Started' });
    await gettingStarted.click();
    await expect(gettingStarted).toHaveAttribute('aria-expanded', 'true');
    const controlledPanelId = await gettingStarted.getAttribute('aria-controls');
    expect(controlledPanelId).toBeTruthy();
    const openPanel = page.locator(`#${controlledPanelId}`);
    await expect(openPanel).toHaveAttribute('data-open', 'true');
    await expect(openPanel).toHaveCSS('opacity', '1');

    const overflow = await page.locator('[data-screen-label="Help"]').evaluate(el => ({
      own: el.scrollWidth - el.clientWidth,
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(overflow.own).toBeLessThanOrEqual(1);
    expect(overflow.document).toBeLessThanOrEqual(1);

    await expect(openPanel.locator('.help-route-svg-mobile')).toBeVisible();
    await expect(openPanel.locator('.help-route-svg-wide')).toBeHidden();
    const routeNodes = openPanel.locator('.help-route-node');
    await expect(routeNodes).toHaveCount(3);
    const nodeGeometry = await routeNodes.evaluateAll(elements =>
      elements.map(el => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width }))
    );
    expect(nodeGeometry.every(item => item.height > 0 && item.width > 0)).toBe(true);
  });

  test('Performance settings stay visible and update the renderer mode', async ({ page }) => {
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Settings', exact: true }).click();

    await expect(page.getByText('Performance', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Maximum performance' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-perf', 'max');
  });

  test('Economic calendar is absent from dashboard add-widget controls', async ({ page }) => {
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Edit layout' }).click();

    const addWidgetHeading = page.getByText('ADD A WIDGET', { exact: true });
    await expect(addWidgetHeading).toHaveCount(1);
    await expect(addWidgetHeading).toBeVisible();
    const addWidgetControls = addWidgetHeading.locator('..');
    await expect(addWidgetControls).toBeVisible();
    await expect(addWidgetControls.getByRole('button', { name: 'Consistency heatmap' })).toBeVisible();
    await expect(addWidgetControls.getByRole('button', { name: 'Economic calendar' })).toHaveCount(0);
    await expect(addWidgetControls.getByText('Economic calendar', { exact: true })).toHaveCount(0);
  });

  test('Help category transitions stop under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.getByRole('button', { name: 'Getting Started' }).click();
    const duration = await page.locator('.help-category-panel').first().evaluate(element =>
      getComputedStyle(element).transitionDuration
    );
    expect(duration.split(',').every(value => parseFloat(value) <= 0.001)).toBe(true);
  });

  test('the walkthrough coachmark is never visible before it is positioned', async ({ page }) => {
    // Regression: tourSpotlight is nulled on open AND on every step change, and the
    // bindings fell back to top/left 50% + translate(-50%,-50%). Re-measurement is
    // deliberately slow (target polling, scrollIntoView, waiting out ancestor
    // animations, rect-stability polling), so the panel sat dead-centre for a long,
    // very visible window and then jumped to its anchor.
    //
    // The invariant asserted here is simply: VISIBLE IMPLIES POSITIONED. Sampling every
    // frame is what makes it meaningful — a poll or an awaited assertion would step
    // straight over the offending frames, which is how the existing walkthrough test
    // missed this.
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page, profileFixture());

    await page.evaluate(() => {
      window.__tourSamples = [];
      const tick = () => {
        const el = document.querySelector('.tour-coachmark');
        if (el) {
          const cs = getComputedStyle(el);
          // transform stays at the centring fallback until a real position lands,
          // at which point the binding switches it to 'none'.
          window.__tourSamples.push({ opacity: Number(cs.opacity), positioned: cs.transform === 'none' });
        }
        window.__tourRaf = requestAnimationFrame(tick);
      };
      tick();
    });

    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.getByRole('button', { name: 'Getting Started' }).click();
    await page.getByRole('button', { name: 'What does the interactive walkthrough cover?' }).click();
    await page.getByRole('button', { name: 'Replay walkthrough' }).click();

    const dialog = page.getByRole('dialog', { name: 'Written walkthrough' });
    await expect(dialog).toContainText('Read the dashboard');
    for (const title of ['Log the trading day', 'Find repeated patterns', 'Grade each setup']) {
      await dialog.getByRole('button', { name: 'Next' }).click();
      await expect(dialog).toContainText(title);
    }

    const samples = await page.evaluate(() => {
      cancelAnimationFrame(window.__tourRaf);
      return window.__tourSamples;
    });

    const leaked = samples.filter(s => s.opacity > 0.01 && !s.positioned);
    expect(leaked.length, `coachmark painted at the centred fallback on ${leaked.length} frame(s)`).toBe(0);

    // Guard against the test passing because nothing was ever sampled: the unpositioned
    // state must genuinely have occurred, and the panel must genuinely have been shown.
    expect(samples.some(s => !s.positioned), 'the unpositioned state was exercised').toBe(true);
    expect(samples.some(s => s.opacity > 0.9 && s.positioned), 'the panel became visible').toBe(true);
  });

  test('walkthrough spotlights stable targets across four separately mounted tabs', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.getByRole('button', { name: 'Getting Started' }).click();
    await page.getByRole('button', { name: 'What does the interactive walkthrough cover?' }).click();
    await page.getByRole('button', { name: 'Replay walkthrough' }).click();

    const dialog = page.getByRole('dialog', { name: 'Written walkthrough' });
    await expect(page.locator('.tour-spotlight')).toBeVisible();
    await page.locator('.tour-spotlight').evaluate(el => {
      window.__initialTourSpotlight = el;
    });
    const assertStep = async ({ title, screen, target }) => {
      await expect(dialog).toContainText(title);
      await expect(page.locator(`[data-screen-label="${screen}"]`)).toBeVisible();
      await expect(page.locator('.tour-spotlight')).toBeVisible();
      await expect.poll(async () => page.evaluate(selector => {
        const spotlight = document.querySelector('.tour-spotlight');
        const subject = document.querySelector(selector);
        const overlay = document.querySelector('.tour-overlay');
        if (!spotlight || !subject || !overlay) return false;
        const a = spotlight.getBoundingClientRect();
        const b = subject.getBoundingClientRect();
        return a.left <= b.left + 1 && a.top <= b.top + 1
          && a.right >= b.right - 1 && a.bottom >= b.bottom - 1
          && b.left >= 12 && b.top >= 12
          && b.right <= window.innerWidth - 12 && b.bottom <= window.innerHeight - 12
          && !!subject.closest('[aria-hidden="true"]')
          && getComputedStyle(overlay).pointerEvents === 'auto';
      }, target), `spotlight covers ${target} without enabling the app`).toBe(true);
      expect(await page.evaluate(() =>
        document.querySelector('.tour-spotlight') === window.__initialTourSpotlight
      ), 'the same spotlight node stays mounted across steps').toBe(true);
    };

    await assertStep({
      title: 'Read the dashboard',
      screen: 'Dashboard',
      target: '[data-screen-label="Dashboard"] .dashboard-widget',
    });
    await page.evaluate(() => {
      window.__tourMoveSamples = [];
      const capture = () => {
        const el = document.querySelector('.tour-spotlight');
        if (el) {
          const box = el.getBoundingClientRect();
          window.__tourMoveSamples.push({
            left: Math.round(box.left * 10) / 10,
            top: Math.round(box.top * 10) / 10,
            width: Math.round(box.width * 10) / 10,
            height: Math.round(box.height * 10) / 10,
          });
        }
        window.__tourMoveRaf = requestAnimationFrame(capture);
      };
      capture();
    });
    await dialog.getByRole('button', { name: 'Next' }).click();
    await assertStep({
      title: 'Log the trading day',
      screen: 'Calendar',
      target: '[data-screen-label="Calendar"] .calendar-scroll',
    });
    const moveSamples = await page.evaluate(() => {
      cancelAnimationFrame(window.__tourMoveRaf);
      return window.__tourMoveSamples;
    });
    const uniqueMoveFrames = new Set(moveSamples.map(sample =>
      [sample.left, sample.top, sample.width, sample.height].join(':')
    ));
    expect(uniqueMoveFrames.size, 'spotlight movement interpolates over multiple frames').toBeGreaterThanOrEqual(3);
    await expect(page.locator('.tour-spotlight')).toHaveClass(/is-actionable/);
    await dialog.getByRole('button', { name: 'Next' }).click();
    await assertStep({
      title: 'Find repeated patterns',
      screen: 'Insights',
      target: '[data-screen-label="Insights"] .insights-full',
    });
    await dialog.getByRole('button', { name: 'Next' }).click();
    await assertStep({
      title: 'Grade each setup',
      screen: 'Playbook',
      target: '[data-screen-label="Playbook"]',
    });

    await dialog.getByRole('button', { name: 'Finish' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.app-main')).toBeFocused();
    const completed = await page.evaluate(key => {
      const store = JSON.parse(window.localStorage.getItem(key));
      return store.profiles[store.activeProfileId].settings.tourCompleted;
    }, STORE_KEY);
    expect(completed).toBe(true);
  });

  test('walkthrough action glow becomes a static affordance under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.getByRole('button', { name: 'Getting Started' }).click();
    await page.getByRole('button', { name: 'What does the interactive walkthrough cover?' }).click();
    await page.getByRole('button', { name: 'Replay walkthrough' }).click();

    const dialog = page.getByRole('dialog', { name: 'Written walkthrough' });
    await dialog.getByRole('button', { name: 'Next' }).click();
    const spotlight = page.locator('.tour-spotlight');
    await expect(spotlight).toHaveClass(/is-actionable/);
    await expect.poll(async () => spotlight.evaluate(el => {
      const style = getComputedStyle(el);
      return {
        animationName: style.animationName,
        borderWidth: parseFloat(style.borderTopWidth),
      };
    })).toEqual({ animationName: 'none', borderWidth: 3 });
  });

  test('the Electron persistence banner surfaces a failed disk write', async ({ page }) => {
    // Plain Chromium cannot exercise store-shim.js at all: it returns immediately when
    // window.desktopStore is absent. Install a faithful REJECTING bridge matching
    // preload.js's surface. The ordinary localStorage fixture is ignored in this mode,
    // because the shim hydrates its cache from readSync() and overrides getItem for the
    // three journal keys — so the fixture must arrive through readSync().
    const store = JSON.stringify(profileFixture());
    await page.addInitScript(([key, value]) => {
      const envelope = JSON.stringify({ [key]: value });
      window.desktopStore = {
        readSync: () => envelope,
        write: () => Promise.reject(new Error('smoke: simulated disk failure')),
        writeSync: () => false,
        onFlushRequest: () => {},
      };
    }, [STORE_KEY, store]);

    await page.goto(RENDERER);
    await page.waitForSelector('[data-screen-label="Dashboard"]', { timeout: 15000 });

    // An unchanged payload short-circuits before any write, so mutate first.
    await page.evaluate(key => {
      const parsed = JSON.parse(window.localStorage.getItem(key));
      parsed.profiles.smoke.settings.riskPct = 2;
      window.localStorage.setItem(key, JSON.stringify(parsed));
    }, STORE_KEY);

    // DEBOUNCE_MS is 250 in store-shim.js.
    // store-shim.js renders a role="alert" banner reading "Could not save your journal
    // to disk…" — the app's own writeProfileStore warning is unreachable in Electron
    // because the shim's setItem override never throws.
    await page.waitForSelector('[role="alert"]', { timeout: 8000 });
    const text = await page.$eval('[role="alert"]', el => el.textContent);
    expect(text).toMatch(/Could not save your journal to disk/i);
    // The shim reschedules every 250ms with lastWritten unchanged, so stop here rather
    // than letting the retry loop run for the rest of the suite.
    await page.close();
  });
});
