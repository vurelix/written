// Render smoke harness — implementation plan rev.8 §D3.
//
// Targets the BUILT renderer over file://, so the CSP that build-renderer.js injects
// is exercised as it ships. Everything here is invisible to the Node vm logic suite.
'use strict';

const path = require('node:path');
const { test, expect } = require('@playwright/test');

const RENDERER = 'file://' + path.resolve(__dirname, '..', 'renderer', 'index.html');
const STORE_KEY = 'written-profiles-v2';

// Widgets that scroll their own content on purpose. A blanket clipping assertion
// would flag these; anything NOT on this list must fit inside its card.
const INTENTIONAL_SCROLLERS = new Set(['recent', 'econ', 'checklist']);

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
    const sizes = [
      { columns: 6, rows: 6 },
      { columns: 12, rows: 6 },
      { columns: 6, rows: 10 },
      { columns: 12, rows: 10 },
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

  test('Help FAQ searches answers, keeps one answer open, and resets on navigation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Help', exact: true }).click();

    const search = page.getByRole('searchbox', { name: 'Search Help' });
    const questions = page.locator('.help-question');
    const answers = page.locator('.help-answer');
    await expect(questions).toHaveCount(21);
    await expect(page.locator('.help-answer:not([hidden])')).toHaveCount(0);

    await search.fill('active only in memory');
    await expect(search).toBeFocused();
    await expect(page.locator('.help-result-status')).toHaveText('1 result');
    const warningQuestion = page.getByRole('button', { name: 'What should I do when Written reports a storage warning?' });
    await expect(warningQuestion).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#help-faq-a-storage-warning')).toBeVisible();

    await warningQuestion.click();
    await expect(warningQuestion).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.help-answer:not([hidden])')).toHaveCount(0);

    await search.fill('journal');
    await expect.poll(async () => Number((await page.locator('.help-result-status').textContent()).match(/\d+/)[0])).toBeGreaterThan(1);
    await expect(page.locator('.help-answer:not([hidden])')).toHaveCount(1);
    await page.getByRole('button', { name: 'How do Quick Presets work?' }).click();
    await expect(page.locator('.help-answer:not([hidden])')).toHaveCount(1);
    await expect(page.locator('#help-faq-a-quick-presets')).toBeVisible();

    await page.getByRole('button', { name: 'Clear Help search' }).click();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('');
    await expect(questions).toHaveCount(21);
    await expect(page.locator('.help-answer:not([hidden])')).toHaveCount(0);

    await search.fill('no matching help answer phrase');
    await expect(page.getByText('No Help answers match that search.')).toBeVisible();
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await expect(search).toHaveValue('');
    await expect(questions).toHaveCount(21);
    await expect(page.locator('.help-answer:not([hidden])')).toHaveCount(0);

    const journalQuestion = page.getByRole('button', { name: 'How do I journal a trading day?' });
    await journalQuestion.focus();
    await journalQuestion.press('Enter');
    await expect(journalQuestion).toHaveAttribute('aria-expanded', 'true');
    await journalQuestion.press('Space');
    await expect(journalQuestion).toHaveAttribute('aria-expanded', 'false');

    const idrefs = await answers.evaluateAll(elements => elements.map(answer => {
      const button = document.getElementById(answer.getAttribute('aria-labelledby'));
      return {
        answerId: answer.id,
        buttonControls: button && button.getAttribute('aria-controls'),
      };
    }));
    expect(idrefs).toHaveLength(21);
    expect(idrefs.every(item => item.answerId === item.buttonControls)).toBe(true);
  });

  test('Help FAQ fits narrow screens and uses shared sequential answer spacing', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 800 });
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Help', exact: true }).click();

    const overflow = await page.locator('[data-screen-label="Help"]').evaluate(el => ({
      own: el.scrollWidth - el.clientWidth,
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(overflow.own).toBeLessThanOrEqual(1);
    expect(overflow.document).toBeLessThanOrEqual(1);

    const measure = async questionName => {
      await page.getByRole('button', { name: questionName }).click();
      return page.locator('.help-answer:not([hidden])').evaluate(el => {
        const style = getComputedStyle(el);
        return {
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          paddingBottom: style.paddingBottom,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        };
      });
    };
    const journal = await measure('How do I journal a trading day?');
    const metrics = await measure('What do the core trading metrics mean?');
    expect(metrics).toEqual(journal);

    const questionGeometry = await page.$$eval('.help-question', elements =>
      elements.map(el => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width }))
    );
    expect(questionGeometry.every(item => item.height >= 44 && item.width > 0)).toBe(true);
  });

  test('walkthrough spotlights stable targets across four separately mounted tabs', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page, profileFixture());
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.getByRole('button', { name: 'What does the interactive walkthrough cover?' }).click();
    await page.getByRole('button', { name: 'Replay walkthrough' }).click();

    const dialog = page.getByRole('dialog', { name: 'Written walkthrough' });
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
    };

    await assertStep({
      title: 'Read the dashboard',
      screen: 'Dashboard',
      target: '[data-screen-label="Dashboard"] .dashboard-widget',
    });
    await dialog.getByRole('button', { name: 'Next' }).click();
    await assertStep({
      title: 'Log the trading day',
      screen: 'Calendar',
      target: '[data-screen-label="Calendar"] .calendar-scroll',
    });
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
