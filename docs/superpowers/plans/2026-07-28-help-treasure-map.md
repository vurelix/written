# Help Treasure Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat Help FAQ with exclusive animated category dropdowns and treasure-map article nodes that open an accessible modal, while disabling Economic calendar, using native platform symbols, and restoring Performance settings.

**Architecture:** Keep `app/Written.dc.html` as the source of truth because this project intentionally uses one embedded DC component. Add explicit category and article state, reuse the existing shared modal focus helpers, and derive responsive SVG route data in the Help render view model. Regenerate `desktop/renderer/index.html` only through the existing build script.

**Tech Stack:** Embedded SugarCube/DC component, HTML, CSS, inline SVG, Node.js built-in test runner, Electron 31, Playwright.

## Global Constraints

- Allow at most one Help category and one Help article modal to be open.
- Keep category bodies mounted so `aria-controls` targets remain valid.
- Use a curved dotted SVG route on wide layouts and a vertical route on narrow layouts.
- Respect `prefers-reduced-motion: reduce`.
- Do not add an economic-calendar provider or dependency.
- Retain dormant Economic calendar rendering and sample data for later reactivation.
- Use `Apple Color Emoji`, `Segoe UI Emoji`, `Segoe UI Symbol`, and `system-ui` for native glyphs.
- Keep accessible names independent of visible glyphs.
- Preserve Full effects, Reduced motion, and Maximum performance modes.
- Never edit `desktop/renderer/index.html` directly.

## File map

- `app/Written.dc.html`: canonical UI, state, Help behavior, widget registry, symbol styling, and Performance control.
- `test/written.logic.test.cjs`: deterministic component-state, render-binding, markup, and regression tests.
- `desktop/test/smoke.spec.js`: browser interaction, animation, accessibility, responsive-layout, and focus tests.
- `desktop/renderer/index.html`: generated desktop renderer updated by `desktop/scripts/build-renderer.js`.
- `desktop/test/help-treasure-map-wide.png`: temporary Playwright screenshot used for inspection, not committed.
- `desktop/test/help-treasure-map-narrow.png`: temporary Playwright screenshot used for inspection, not committed.

---

### Task 1: Disable Economic Calendar at the widget registry boundary

**Files:**
- Modify: `test/written.logic.test.cjs`
- Modify: `app/Written.dc.html:1842-1869`
- Modify: `desktop/test/smoke.spec.js:15`

**Interfaces:**
- Consumes: `Component.WIDGETS`, `widgetRegistry(id)`, `widgetOrder()`, and `renderVals()`.
- Produces: a widget registry in which `widgetRegistry('econ')` returns `null`; persisted `econ` entries cannot enter `widgetOrder()`, `dashWidgets`, or `addableWidgets`.

- [ ] **Step 1: Add a failing logic regression test**

Add this near the existing widget registry tests:

```js
test('Economic calendar is dormant and ignored by current and persisted widget layouts', () => {
  const component = loadComponent();
  seedActiveProfile(component, {
    onboarded: true,
    loggedOut: false,
    order: ['econ', 'net'],
    widgets: {
      econ: { on: 1, columns: 4, rows: 9 },
      net: { on: 1, columns: 3, rows: 4 },
    },
  });
  component.state.booting = false;

  assert.equal(component.widgetRegistry('econ'), null);
  assert.equal(component.widgetOrder().includes('econ'), false);

  const values = component.renderVals();
  assert.equal(values.dashWidgets.some(widget => widget.id === 'econ'), false);
  assert.equal(values.addableWidgets.some(widget => widget.id === 'econ'), false);
});
```

- [ ] **Step 2: Run the test and verify the current registry fails it**

Run:

```bash
node --test --test-name-pattern="Economic calendar is dormant" test/written.logic.test.cjs
```

Expected: FAIL because `widgetRegistry('econ')` still returns the Economic calendar descriptor.

- [ ] **Step 3: Remove only the live registry entry**

In `Component` construction, delete this descriptor from `this.WIDGETS`:

```js
{id:'econ',label:'Economic calendar',minColumns:4,maxColumns:8,defaultColumns:4,minRows:7,maxRows:12,defaultRows:9},
```

Keep `this.ECON`, the `econRows` calculation, and the dormant `sc-if` renderer branch unchanged. Existing `widgetOrder()` already filters saved IDs against `this.WIDGETS`, so no migration or layout-version bump is required.

In `desktop/test/smoke.spec.js`, remove `'econ'` from the intentional-scroller set:

```js
const INTENTIONAL_SCROLLERS = new Set(['recent', 'checklist']);
```

- [ ] **Step 4: Run the widget tests**

Run:

```bash
node --test --test-name-pattern="widget|Economic calendar" test/written.logic.test.cjs
```

Expected: PASS.

- [ ] **Step 5: Commit the disabled registry**

```bash
git add app/Written.dc.html test/written.logic.test.cjs desktop/test/smoke.spec.js
git commit -m "Disable economic calendar widget"
```

---

### Task 2: Restore Performance settings and native platform glyphs

**Files:**
- Modify: `test/written.logic.test.cjs`
- Modify: `app/Written.dc.html:36-61`
- Modify: `app/Written.dc.html:1038-1072`
- Modify: `app/Written.dc.html:2215-2231`
- Modify: `app/Written.dc.html:3996-4004`

**Interfaces:**
- Consumes: `syncPerfMode()`, `setPerfMode(mode)`, `searchHintKey()`, and `window.desktopPrefs`.
- Produces: an always-rendered Performance control and reusable `.native-symbol` and `.native-emoji` classes.

- [ ] **Step 1: Add failing markup and behavior tests**

Add:

```js
test('Performance controls render with and without the desktop bridge', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, />Performance<\/div>[\s\S]*Full effects[\s\S]*Reduced motion[\s\S]*Maximum performance/);
  assert.doesNotMatch(html, /<sc-if value="\{\{perfAvailable\}\}"[^>]*>[\s\S]*?>Performance<\/div>/);

  const attrs = new Map([['data-perf', 'reduced']]);
  const component = loadComponent({
    document: {
      documentElement: {
        getAttribute(name) { return attrs.get(name) || null; },
        setAttribute(name, value) { attrs.set(name, value); },
      },
    },
    window: {},
  });
  component.syncPerfMode();
  assert.equal(component.state.perfMode, 'reduced');
  component.setPerfMode('max');
  assert.equal(attrs.get('data-perf'), 'max');
});

test('native symbol classes prefer the operating system glyph fonts', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /\.native-symbol\{[^}]*font-family:'Apple Color Emoji','Segoe UI Emoji','Segoe UI Symbol',system-ui,sans-serif/);
  assert.match(html, /\.native-emoji\{[^}]*font-family:'Apple Color Emoji','Segoe UI Emoji','Segoe UI Symbol',system-ui,sans-serif/);
  assert.match(html, /class="[^"]*native-symbol[^"]*"/);
  assert.match(html, /class="[^"]*native-emoji[^"]*"/);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
node --test --test-name-pattern="Performance controls|native symbol classes" test/written.logic.test.cjs
```

Expected: FAIL because the Performance section is gated and the native glyph classes do not exist.

- [ ] **Step 3: Add the shared native glyph classes**

Add:

```css
.native-symbol,.native-emoji{font-family:'Apple Color Emoji','Segoe UI Emoji','Segoe UI Symbol',system-ui,sans-serif;font-style:normal;font-variant:normal;line-height:1}
```

Add `class="native-symbol"` to the buttons or spans that visibly render `✕`, `✓`, `●`, `{{pe.mark}}`, `{{dr.mark}}`, `{{er.mark}}`, `{{os.num}}`, and `{{it.mk}}`. Add `class="native-emoji"` to the buttons or spans that visibly render `{{em}}`, `{{e.emoji}}`, `{{d.emoji}}`, or other values sourced from `this.EMO`. Add `class="native-symbol"` to the titlebar shortcut `<kbd>`. Keep every current `aria-label`, `title`, or surrounding accessible label unchanged.

- [ ] **Step 4: Remove the Performance visibility gate**

Delete only the opening `<sc-if value="{{perfAvailable}}" hint-placeholder-val="{{true}}">` and its matching closing `</sc-if>`, leaving this content directly in the Settings card:

```html
<div style="padding:16px 0 18px;border-bottom:1px solid var(--grid)">
  <div style="font-size:13px;font-weight:600">Performance</div>
  <div style="font-size:11.5px;color:var(--tx-faint);margin-top:2px">{{perfHint}}</div>
  <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
    <sc-for list="{{perfOpts}}" as="pf" hint-placeholder-count="3">
      <button onClick="{{pf.set}}" style="border:1px solid {{pf.bd}};background:{{pf.bg}};color:{{pf.fg}};font-size:12px;font-weight:600;padding:8px 15px;border-radius:9px;cursor:pointer;transition:all .15s">{{pf.label}}</button>
    </sc-for>
  </div>
</div>
```

Remove the unused `perfAvailable` binding from `renderVals()`. Do not change the three `perfOpts` values.

- [ ] **Step 5: Run focused and platform tests**

Run:

```bash
node --test --test-name-pattern="Performance controls|native symbol classes|search shortcut hint" test/written.logic.test.cjs
```

Expected: PASS, including `⌘K` on macOS and `Ctrl K` elsewhere.

- [ ] **Step 6: Commit the settings and symbol changes**

```bash
git add app/Written.dc.html test/written.logic.test.cjs
git commit -m "Restore performance settings and native symbols"
```

---

### Task 3: Replace Help question state with category and modal state

**Files:**
- Modify: `test/written.logic.test.cjs:3203-3462`
- Modify: `app/Written.dc.html:1813`
- Modify: `app/Written.dc.html:2311-2347`
- Modify: `app/Written.dc.html:2416-2434`
- Modify: `app/Written.dc.html:3833-3877`

**Interfaces:**
- Consumes: `helpFaqData()`, `filterHelpFaq(groups, query)`, `rememberSurfaceFocus(name, opener)`, `captureSurfaceDialog(name, element)`, `handleSurfaceDialogKeydown(name, event, close)`, and `setStateAndRestoreSurface(patch, name, restore)`.
- Produces:
  - `helpCategoryForArticle(articleId): string|null`
  - `toggleHelpCategory(categoryId): boolean`
  - `openHelpArticle(articleId, opener): boolean`
  - `closeHelpArticle(restore = true): boolean`
  - state keys `helpOpenCategoryId`, `helpOpenArticleId`, and `helpReturnCategoryId`
  - group bindings `buttonId`, `panelId`, `open`, `collapsed`, `toggle`, and `questions`
  - article bindings `number`, `open`, and modal-safe block data

- [ ] **Step 1: Replace the old Help state tests with failing category and modal tests**

Add:

```js
test('Help keeps one category open and one article modal open', () => {
  const component = loadComponent();
  component.state.helpOpenCategoryId = null;
  component.state.helpOpenArticleId = null;

  assert.equal(component.toggleHelpCategory('getting-started'), true);
  assert.equal(component.state.helpOpenCategoryId, 'getting-started');
  assert.equal(component.toggleHelpCategory('dashboard-insights'), true);
  assert.equal(component.state.helpOpenCategoryId, 'dashboard-insights');

  const opener = { focus() {} };
  assert.equal(component.openHelpArticle('quick-presets', opener), true);
  assert.equal(component.state.helpOpenCategoryId, 'getting-started');
  assert.equal(component.state.helpOpenArticleId, 'quick-presets');

  assert.equal(component.toggleHelpCategory('dashboard-insights'), true);
  assert.equal(component.state.helpOpenArticleId, null);
  assert.equal(component.state.helpOpenCategoryId, 'dashboard-insights');
});

test('Help search opens only the first matching category and never a modal', () => {
  const component = loadComponent();
  component.state.helpOpenCategoryId = 'getting-started';
  component.state.helpOpenArticleId = null;
  component.state.helpReturnCategoryId = null;

  const result = component.setHelpQuery('active only in memory');
  assert.equal(result.groups[0].key, 'data-troubleshooting');
  assert.equal(component.state.helpOpenCategoryId, 'data-troubleshooting');
  assert.equal(component.state.helpOpenArticleId, null);
  assert.equal(component.state.helpReturnCategoryId, 'getting-started');

  component.setHelpQuery('');
  assert.equal(component.state.helpOpenCategoryId, 'getting-started');
  assert.equal(component.state.helpReturnCategoryId, null);
});

test('Help article modal reuses shared focus containment and restoration', () => {
  let focused = '';
  const component = loadComponent();
  component.setState = function setState(patch, callback) {
    this.state = Object.assign({}, this.state, patch);
    if (callback) callback();
  };
  const opener = { isConnected: true, focus() { focused = 'opener'; } };
  const close = { focus() { focused = 'close'; } };
  const action = { focus() { focused = 'action'; } };
  const dialog = {
    focus() { focused = 'dialog'; },
    querySelectorAll() { return [close, action]; },
  };

  assert.equal(component.openHelpArticle('journal-day', opener), true);
  assert.equal(component.captureSurfaceDialog('helpArticle', dialog), true);
  assert.equal(focused, 'close');
  assert.equal(component.handleSurfaceDialogKeydown('helpArticle', {
    key: 'Tab',
    target: action,
    preventDefault() {},
    stopPropagation() {},
  }, () => component.closeHelpArticle()), true);
  assert.equal(focused, 'close');
  component.closeHelpArticle();
  assert.equal(focused, 'opener');
});
```

Update the existing `setTab`, clear-search, transient-state, render-binding, and markup tests to use the three new state names instead of `helpOpenId`.

- [ ] **Step 2: Run the focused tests and verify missing methods fail**

Run:

```bash
node --test --test-name-pattern="Help keeps one category|Help search opens only|Help article modal|setTab resets Help|clearing Help search|Help interactions remain transient" test/written.logic.test.cjs
```

Expected: FAIL because category and article methods are not defined.

- [ ] **Step 3: Add explicit Help state and state transitions**

Replace `helpOpenId:null` in initial state with:

```js
helpOpenCategoryId:null,helpOpenArticleId:null,helpReturnCategoryId:null
```

Implement:

```js
helpCategoryForArticle(articleId){
  const group=this.helpFaqData().find(item=>item.questions.some(question=>question.id===articleId));
  return group?group.key:null;
}
toggleHelpCategory(categoryId){
  if(typeof categoryId!=='string'||!this.helpFaqData().some(group=>group.key===categoryId))return false;
  if(this.state.helpOpenArticleId)this.takeSurfaceFocus('helpArticle');
  this.setState({
    helpOpenCategoryId:this.state.helpOpenCategoryId===categoryId?null:categoryId,
    helpOpenArticleId:null,
  });
  return true;
}
openHelpArticle(articleId,opener){
  const categoryId=this.helpCategoryForArticle(articleId);
  if(!categoryId)return false;
  this.rememberSurfaceFocus('helpArticle',opener);
  this.setState({helpOpenCategoryId:categoryId,helpOpenArticleId:articleId});
  return true;
}
closeHelpArticle(restore=true){
  return this.setStateAndRestoreSurface({helpOpenArticleId:null},'helpArticle',restore);
}
```

Update `setTab()` so navigation clears all three Help keys and consumes the modal opener without restoring focus to a hidden Help node:

```js
if(tab!=='help'&&this.state.helpOpenArticleId)this.takeSurfaceFocus('helpArticle');
this.setState(Object.assign(
  {},
  extra&&typeof extra==='object'?extra:{},
  {tab,helpQuery:'',helpOpenCategoryId:null,helpOpenArticleId:null,helpReturnCategoryId:null}
));
```

- [ ] **Step 4: Implement search state without opening a modal**

Update `setHelpQuery()` to preserve the current category only when entering search, open `result.groups[0].key` for non-empty matches, close any modal, and restore a valid saved category or the first category when the query clears:

```js
setHelpQuery(rawQuery){
  const helpQuery=String(rawQuery==null?'':rawQuery);
  const result=this.filterHelpFaq(this.helpFaqData(),helpQuery);
  const entering=!this.normalizeHelpText(this.state.helpQuery)&&!!result.normalized;
  const returnId=entering?this.state.helpOpenCategoryId:this.state.helpReturnCategoryId;
  const validReturn=this.helpFaqData().some(group=>group.key===returnId);
  const openId=result.normalized
    ?(result.groups[0]?result.groups[0].key:null)
    :(validReturn?returnId:(result.groups[0]?result.groups[0].key:null));
  if(this.state.helpOpenArticleId)this.takeSurfaceFocus('helpArticle');
  this.setState({
    helpQuery,
    helpOpenCategoryId:openId,
    helpOpenArticleId:null,
    helpReturnCategoryId:result.normalized?returnId:null,
  });
  return result;
}
```

Update `clearHelpSearch()` to call `setHelpQuery('')` and focus the stable search ref after commit without duplicating the state rules.

- [ ] **Step 5: Add category and modal view-model bindings**

Each filtered group must expose:

```js
const open=S.helpOpenCategoryId===group.key;
return {
  key:group.key,
  label:group.label,
  buttonId:'help-category-button-'+group.key,
  panelId:'help-category-panel-'+group.key,
  open,
  collapsed:!open,
  caretTransform:open?'rotate(180deg)':'none',
  toggle:()=>this.toggleHelpCategory(group.key),
  questions:group.questions.map((question,index)=>({
    id:question.id,
    number:String(index+1),
    question:question.question,
    open:event=>this.openHelpArticle(question.id,event),
    blocks:question.blocks.map(helpBlock),
    hasAction:!!question.action,
    action:question.action
      ?{label:question.action.label,run:question.action.id==='tour'?replayTour:()=>false}
      :{label:'',run:()=>false},
  })),
};
```

Build a `helpArticle` binding by finding `S.helpOpenArticleId` in the unfiltered FAQ graph. Expose:

```js
helpArticleOpen:!!selectedHelpArticle,
helpArticleClosed:!selectedHelpArticle,
helpArticleTitle:selectedHelpArticle?selectedHelpArticle.question:'',
helpArticleBlocks:selectedHelpArticle?selectedHelpArticle.blocks.map(helpBlock):[],
helpArticleHasAction:!!(selectedHelpArticle&&selectedHelpArticle.action),
helpArticleAction:selectedHelpArticle&&selectedHelpArticle.action
  ?{label:selectedHelpArticle.action.label,run:selectedHelpArticle.action.id==='tour'?replayTour:()=>false}
  :{label:'',run:()=>false},
closeHelpArticle:()=>this.closeHelpArticle(),
setHelpArticleDialogRef:element=>this.captureSurfaceDialog('helpArticle',element),
onHelpArticleDialogKeydown:event=>this.handleSurfaceDialogKeydown('helpArticle',event,()=>this.closeHelpArticle()),
stopHelpArticleClick:event=>event.stopPropagation(),
```

- [ ] **Step 6: Run the complete logic suite**

Run:

```bash
node --test test/written.logic.test.cjs
```

Expected: all tests PASS.

- [ ] **Step 7: Commit the Help state model**

```bash
git add app/Written.dc.html test/written.logic.test.cjs
git commit -m "Add Help category and article modal state"
```

---

### Task 4: Build the animated treasure-map UI and article modal

**Files:**
- Modify: `test/written.logic.test.cjs:3392-3462`
- Modify: `app/Written.dc.html:55`
- Modify: `app/Written.dc.html:1169-1221`
- Modify: `app/Written.dc.html` narrow-screen and reduced-motion media queries

**Interfaces:**
- Consumes: the category and article bindings produced by Task 3.
- Produces:
  - `helpRouteModel(count): {viewBox:string,path:string,mobileViewBox:string,mobilePath:string,nodes:Array<{left:string,top:string}>}`
  - mounted accordion panels with valid ID references
  - `.help-route-node` buttons
  - one mounted `.help-article-dialog`

- [ ] **Step 1: Add failing route and markup tests**

Add:

```js
test('Help route model orders nodes and handles one-node categories', () => {
  const component = loadComponent();
  assert.deepEqual(plain(component.helpRouteModel(1)), {
    viewBox: '0 0 1000 220',
    path: '',
    mobileViewBox: '0 0 72 100',
    mobilePath: '',
    nodes: [{ left: '8%', top: '50%' }],
  });
  const route = component.helpRouteModel(4);
  assert.equal(route.nodes.length, 4);
  assert.match(route.path, /^M /);
  assert.match(route.path, / C /);
  assert.equal(route.mobilePath, 'M 36 12 V 288');
});

test('Help markup exposes exclusive category controls and an accessible article modal', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /class="help-category-toggle"[^>]+aria-expanded="\{\{category\.open\}\}"[^>]+aria-controls="\{\{category\.panelId\}\}"/);
  assert.match(html, /id="\{\{category\.panelId\}\}"[^>]+aria-labelledby="\{\{category\.buttonId\}\}"[^>]+inert="\{\{category\.collapsed\}\}"/);
  assert.match(html, /class="help-route-node[^"]*"[^>]+onClick="\{\{faq\.open\}\}"/);
  assert.match(html, /class="help-route-svg help-route-svg-wide"/);
  assert.match(html, /class="help-route-svg help-route-svg-mobile"/);
  assert.match(html, /class="help-article-dialog[^"]*"[^>]+role="dialog"[^>]+aria-modal="true"[^>]+aria-labelledby="help-article-title"/);
  assert.match(html, /ref="\{\{setHelpArticleDialogRef\}\}"[^>]+onKeyDown="\{\{onHelpArticleDialogKeydown\}\}"/);
});

test('Help CSS defines tweened dropdowns, treasure-map hover, modal exit, and reduced motion', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /\.help-category-panel\{[^}]*grid-template-rows:0fr[^}]*transition:/);
  assert.match(html, /\.help-category-panel\[data-open="true"\]\{[^}]*grid-template-rows:1fr/);
  assert.match(html, /\.help-route-node:hover/);
  assert.match(html, /\.help-route-node:focus-visible/);
  assert.match(html, /\.help-article-backdrop\{[^}]*visibility:hidden[^}]*opacity:0[^}]*transition:/);
  assert.match(html, /\.help-article-backdrop\[data-open="true"\]\{[^}]*visibility:visible[^}]*opacity:1/);
  assert.match(html, /body:has\(\.help-article-backdrop\[data-open="true"\]\)\{overflow:hidden\}/);
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{[^}]*\.help-category-panel/);
});
```

- [ ] **Step 2: Run the route and markup tests and verify they fail**

Run:

```bash
node --test --test-name-pattern="Help route model|Help markup exposes|Help CSS defines" test/written.logic.test.cjs
```

Expected: FAIL because `helpRouteModel` and the new markup do not exist.

- [ ] **Step 3: Implement deterministic route geometry**

Add:

```js
helpRouteModel(count){
  const total=Math.max(0,Math.floor(Number(count)||0));
  if(!total)return{viewBox:'0 0 1000 220',path:'',mobileViewBox:'0 0 72 100',mobilePath:'',nodes:[]};
  if(total===1)return{viewBox:'0 0 1000 220',path:'',mobileViewBox:'0 0 72 100',mobilePath:'',nodes:[{left:'8%',top:'50%'}]};
  const nodes=Array.from({length:total},(_,index)=>{
    const left=8+(84*index/(total-1));
    const top=index%2===0?34:68;
    return{left:left.toFixed(2).replace(/\.?0+$/,'')+'%',top:top+'%'};
  });
  const px=node=>({x:Number(node.left.slice(0,-1))*10,y:Number(node.top.slice(0,-1))*2.2});
  const first=px(nodes[0]);
  let path='M '+first.x+' '+first.y;
  for(let index=1;index<nodes.length;index++){
    const previous=px(nodes[index-1]),current=px(nodes[index]);
    const middle=(previous.x+current.x)/2;
    path+=' C '+middle+' '+previous.y+', '+middle+' '+current.y+', '+current.x+' '+current.y;
  }
  const mobileEnd=12+(total-1)*92;
  return{
    viewBox:'0 0 1000 220',
    path,
    mobileViewBox:'0 0 72 '+(mobileEnd+12),
    mobilePath:'M 36 12 V '+mobileEnd,
    nodes,
  };
}
```

For each group, call `const route=this.helpRouteModel(group.questions.length)` and expose:

```js
routeViewBox:route.viewBox,
routePath:route.path,
mobileRouteViewBox:route.mobileViewBox,
mobileRoutePath:route.mobilePath,
```

Attach `left:route.nodes[index].left` and `top:route.nodes[index].top` to each question binding.

- [ ] **Step 4: Replace the Help category markup**

Use a native category button and keep its panel mounted:

```html
<section class="help-category glass-surface">
  <h2>
    <button id="{{category.buttonId}}" class="help-category-toggle" onClick="{{category.toggle}}" aria-expanded="{{category.open}}" aria-controls="{{category.panelId}}">
      <span>{{category.label}}</span>
      <svg class="help-caret" aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="transform:{{category.caretTransform}}"><path d="M4 6.5 8 10.5 12 6.5"></path></svg>
    </button>
  </h2>
  <div id="{{category.panelId}}" class="help-category-panel" data-open="{{category.open}}" aria-labelledby="{{category.buttonId}}" aria-hidden="{{category.collapsed}}" inert="{{category.collapsed}}">
    <div class="help-category-panel-inner">
      <div class="help-route">
        <svg class="help-route-svg help-route-svg-wide" aria-hidden="true" viewBox="{{category.routeViewBox}}" preserveAspectRatio="none"><path d="{{category.routePath}}"></path></svg>
        <svg class="help-route-svg help-route-svg-mobile" aria-hidden="true" viewBox="{{category.mobileRouteViewBox}}" preserveAspectRatio="none"><path d="{{category.mobileRoutePath}}"></path></svg>
        <sc-for list="{{category.questions}}" as="faq" hint-placeholder-count="4">
          <button class="help-route-node" style="left:{{faq.left}};top:{{faq.top}}" onClick="{{faq.open}}" aria-haspopup="dialog">
            <span class="help-route-number native-symbol" aria-hidden="true">{{faq.number}}</span>
            <span class="help-route-label">{{faq.question}}</span>
          </button>
        </sc-for>
      </div>
    </div>
  </div>
</section>
```

- [ ] **Step 5: Add the always-mounted modal**

After the category loop, add a backdrop whose hidden state uses `visibility`, `opacity`, `pointer-events`, `aria-hidden`, and `inert`, not `display:none`:

```html
<div class="help-article-backdrop" data-open="{{helpArticleOpen}}" aria-hidden="{{helpArticleClosed}}" inert="{{helpArticleClosed}}" onClick="{{closeHelpArticle}}">
  <div class="help-article-dialog glass-surface-strong" ref="{{setHelpArticleDialogRef}}" onKeyDown="{{onHelpArticleDialogKeydown}}" onClick="{{stopHelpArticleClick}}" tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="help-article-title">
    <div class="help-article-header">
      <h2 id="help-article-title">{{helpArticleTitle}}</h2>
      <button class="help-article-close native-symbol" onClick="{{closeHelpArticle}}" aria-label="Close Help article">✕</button>
    </div>
    <div class="help-article-content">
      <sc-for list="{{helpArticleBlocks}}" as="block" hint-placeholder-count="2">
        <sc-if value="{{block.isPara}}" hint-placeholder-val="{{true}}">
          <p><sc-for list="{{block.runs}}" as="run" hint-placeholder-count="3"><sc-if value="{{run.strong}}" hint-placeholder-val="{{false}}"><strong>{{run.text}}</strong></sc-if><sc-if value="{{run.plain}}" hint-placeholder-val="{{true}}"><span>{{run.text}}</span></sc-if></sc-for></p>
        </sc-if>
        <sc-if value="{{block.isSteps}}" hint-placeholder-val="{{false}}">
          <ol class="help-steps">
            <sc-for list="{{block.steps}}" as="step" hint-placeholder-count="5">
              <li><sc-for list="{{step.runs}}" as="run" hint-placeholder-count="3"><sc-if value="{{run.strong}}" hint-placeholder-val="{{false}}"><strong>{{run.text}}</strong></sc-if><sc-if value="{{run.plain}}" hint-placeholder-val="{{true}}"><span>{{run.text}}</span></sc-if></sc-for></li>
            </sc-for>
          </ol>
        </sc-if>
      </sc-for>
      <sc-if value="{{helpArticleHasAction}}" hint-placeholder-val="{{false}}">
        <button class="help-answer-action" onClick="{{helpArticleAction.run}}">{{helpArticleAction.label}}</button>
      </sc-if>
    </div>
  </div>
</div>
```

- [ ] **Step 6: Add animation, treasure-map, responsive, and reduced-motion styles**

Implement these concrete selectors and behaviors:

```css
.help-category{border-radius:16px;overflow:hidden}
.help-category h2{margin:0}
.help-category-toggle{width:100%;min-height:58px;display:flex;align-items:center;justify-content:space-between;gap:14px;border:0;background:transparent;color:var(--tx);padding:16px 20px;text-align:left;font-size:14px;font-weight:750;cursor:pointer;transition:background .16s ease,color .16s ease}
.help-category-toggle:hover{background:var(--chip2);color:var(--accent)}
.help-category-toggle:focus-visible,.help-route-node:focus-visible,.help-article-close:focus-visible{outline:2px solid var(--accent);outline-offset:-3px}
.help-category-panel{display:grid;grid-template-rows:0fr;opacity:0;transform:translateY(-6px);transition:grid-template-rows .26s cubic-bezier(.2,.8,.2,1),opacity .2s ease,transform .26s cubic-bezier(.2,.8,.2,1)}
.help-category-panel[data-open="true"]{grid-template-rows:1fr;opacity:1;transform:none}
.help-category-panel-inner{min-height:0;overflow:hidden}
.help-route{position:relative;min-height:250px;margin:0 20px 20px}
.help-route-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.help-route-svg path{fill:none;stroke:var(--bd3);stroke-width:3;stroke-linecap:round;stroke-dasharray:4 10;transition:stroke .18s ease,filter .18s ease}
.help-route:has(.help-route-node:hover) .help-route-svg path,.help-route:has(.help-route-node:focus-visible) .help-route-svg path{stroke:var(--accent);filter:drop-shadow(0 0 5px var(--accent-soft))}
.help-route-node{position:absolute;transform:translate(-50%,-50%);width:min(190px,22%);border:0;background:transparent;color:var(--tx);padding:0;cursor:pointer;text-align:center;transition:transform .16s cubic-bezier(.2,.8,.2,1),filter .16s ease,color .16s ease}
.help-route-node:hover,.help-route-node:focus-visible{transform:translate(-50%,-56%) scale(1.035);color:var(--accent);filter:drop-shadow(0 10px 16px var(--sh))}
.help-route-number{width:42px;height:42px;margin:0 auto 9px;border:2px solid currentColor;border-radius:50%;display:grid;place-items:center;background:var(--surface-strong);font-size:15px;font-weight:800;box-shadow:0 0 0 5px var(--accent-soft)}
.help-route-label{display:block;font-size:12px;font-weight:700;line-height:1.4}
.help-route-svg-mobile{display:none}
.help-article-backdrop{position:fixed;inset:var(--titlebar-offset) 0 0;z-index:125;display:grid;place-items:center;padding:20px;background:var(--ovl);backdrop-filter:blur(7px);visibility:hidden;opacity:0;pointer-events:none;transition:visibility 0s linear .2s,opacity .2s ease}
.help-article-backdrop[data-open="true"]{visibility:visible;opacity:1;pointer-events:auto;transition-delay:0s}
.help-article-dialog{width:min(680px,calc(100vw - 32px));max-height:min(720px,calc(100vh - var(--titlebar-offset) - 40px));overflow:auto;border-radius:18px;box-shadow:0 30px 90px var(--sh);transform:translateY(10px) scale(.975);opacity:0;transition:transform .2s cubic-bezier(.2,.8,.2,1),opacity .18s ease}
.help-article-backdrop[data-open="true"] .help-article-dialog{transform:none;opacity:1}
.help-article-header{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:20px 22px;border-bottom:1px solid var(--bd);background:var(--surface-strong);z-index:1}
.help-article-header h2{margin:0;font-size:17px}
.help-article-close{width:34px;height:34px;flex:none;border:1px solid var(--bd2);border-radius:10px;background:var(--chip);color:var(--tx-dim);cursor:pointer}
.help-article-content{padding:20px 22px 24px;color:var(--tx-mid);font-size:12.5px;line-height:1.7}
body:has(.help-article-backdrop[data-open="true"]){overflow:hidden}
```

At the existing narrow-screen breakpoint, show the mobile SVG, lay nodes in document flow, and remove desktop positioning:

```css
.help-route{min-height:0;margin:0 14px 18px;padding:14px 0}
.help-route-svg-wide{display:none}
.help-route-svg-mobile{display:block;left:0;width:72px;height:100%}
.help-route-node{position:relative;left:auto!important;top:auto!important;transform:none;width:100%;min-height:76px;display:grid;grid-template-columns:54px minmax(0,1fr);align-items:center;text-align:left}
.help-route-node:hover,.help-route-node:focus-visible{transform:translateX(4px)}
.help-route-number{margin:0}
```

In the reduced-motion query, set category, node, route, backdrop, dialog, and caret transition durations to `0.01ms` and remove node/dialog transforms.

- [ ] **Step 7: Run logic tests and regenerate the renderer**

Run:

```bash
node --test test/written.logic.test.cjs
cd desktop
npm run build:renderer
npm run verify:renderer
```

Expected: all logic tests PASS and renderer verification reports no drift.

- [ ] **Step 8: Commit the Help presentation**

```bash
git add app/Written.dc.html desktop/renderer/index.html test/written.logic.test.cjs
git commit -m "Build animated Help treasure map"
```

---

### Task 5: Add browser coverage and perform visual verification

**Files:**
- Modify: `desktop/test/smoke.spec.js:550-665`
- Verify: `app/Written.dc.html`
- Verify: `desktop/renderer/index.html`

**Interfaces:**
- Consumes: all behavior and selectors from Tasks 1 through 4.
- Produces: browser-level regression coverage for category exclusivity, modal behavior, focus, responsive layout, calendar disablement, Performance visibility, and reduced motion.

- [ ] **Step 1: Replace the old Help accordion smoke test**

Write a Playwright test with these exact interactions:

```js
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
  await expect(dialog.getByRole('button', { name: 'Close Help article' })).toBeFocused();
  await dialog.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(articleNode).toBeFocused();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await expect(gettingStarted).toHaveAttribute('aria-expanded', 'true');

  await articleNode.click();
  await dialog.getByRole('button', { name: 'Close Help article' }).click();
  await expect(dialog).toBeHidden();
  await articleNode.click();
  await page.locator('.help-article-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeHidden();
});
```

- [ ] **Step 2: Add search, responsive, settings, and disabled-widget browser assertions**

Add tests that:

```js
await search.fill('active only in memory');
await expect(page.getByRole('button', { name: 'Data and Troubleshooting' })).toHaveAttribute('aria-expanded', 'true');
await expect(page.locator('.help-article-backdrop')).toHaveAttribute('data-open', 'false');
```

At `720x800`, assert no horizontal overflow, `.help-route-svg-mobile` is visible, `.help-route-svg-wide` is hidden, and every `.help-route-node` has a positive width and height.

In Settings, assert `page.getByText('Performance', { exact: true })` is visible and clicking Maximum performance sets `<html data-perf="max">`.

In dashboard edit mode, assert no button or text named Economic calendar is visible in the add-widget controls.

- [ ] **Step 3: Add a reduced-motion assertion**

Use:

```js
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.getByRole('button', { name: 'Getting Started' }).click();
const duration = await page.locator('.help-category-panel').first().evaluate(element =>
  getComputedStyle(element).transitionDuration
);
expect(duration.split(',').every(value => parseFloat(value) <= 0.001)).toBe(true);
```

- [ ] **Step 4: Run focused browser tests**

Run:

```bash
cd desktop
npx playwright test --grep="Help|Performance|Economic calendar"
```

Expected: PASS.

- [ ] **Step 5: Run the complete automated verification**

Run from the repository root:

```bash
node --test test/written.logic.test.cjs
cd desktop
npm run test:smoke
```

Expected: all Node logic tests and all Playwright smoke tests PASS.

- [ ] **Step 6: Inspect wide and narrow screenshots**

Open Help at `1280x800`, expand Getting Started, and save `desktop/test/help-treasure-map-wide.png`. Open Help at `720x800`, expand the same category, and save `desktop/test/help-treasure-map-narrow.png`.

Inspect both images for:

- route dots meeting the numbered nodes without crossing labels;
- no clipped card shadows or modal edges;
- readable wrapping for the longest article title;
- one obvious open category;
- consistent native glyph rendering;
- no horizontal page overflow.

Delete the two temporary screenshots after inspection.

- [ ] **Step 7: Commit browser coverage**

```bash
git add desktop/test/smoke.spec.js
git commit -m "Test Help treasure map interactions"
```

- [ ] **Step 8: Confirm the final diff is clean and generated files match**

Run:

```bash
git status --short
cd desktop
npm run verify:renderer
```

Expected: no uncommitted changes and renderer verification passes.
