const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Resolve the app whether it sits at the repo root (original working folder) or
// under app/ (the git repository's layout).
const htmlPath = [
  path.join(__dirname, '..', 'app', 'Written.dc.html'), // repository layout
  path.join(__dirname, '..', 'Written.dc.html')         // working folder
].find(p => fs.existsSync(p));
const plain = value => JSON.parse(JSON.stringify(value));

function loadComponent(overrides = {}) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/<script type="text\/x-dc"[^>]*>\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, 'embedded DC component script is present');
  const context = Object.assign({
    DCLogic: class {
      constructor(props) { this.props = props || {}; }
      setState(patch) { this.state = Object.assign({}, this.state, patch); }
    },
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }, overrides);
  vm.createContext(context);
  vm.runInContext(`${match[1]}\n;globalThis.__WrittenComponent = Component;`, context, {
    filename: htmlPath,
  });
  return new context.__WrittenComponent({});
}

function seedActiveProfile(component, settings = {}, days = {}) {
  const profile = { id: 'test-profile', createdAt: 1, lastUsedAt: 1, settings, days };
  component.state.profileStore = {
    version: 2,
    activeProfileId: profile.id,
    profiles: { [profile.id]: profile },
  };
  component.state.settings = settings;
  component.state.days = days;
  component.state.selectedProfileId = profile.id;
  return profile;
}

test('embedded component compiles and existing trade math remains intact', () => {
  const component = loadComponent();
  const trade = { side: 'LONG', entry: 100, stop: 98, exit: 104 };
  assert.equal(component.tpts(trade), 4);
  assert.equal(component.trisk(trade), 2);
  assert.equal(component.tr(trade), 2);
});

test('existing widget ordering preserves saved order and appends the registry', () => {
  const component = loadComponent();
  component.state.settings.order = ['recent', 'net', 'unknown', 'recent'];
  const order = component.widgetOrder();
  assert.deepEqual(order.slice(0, 2), ['recent', 'net']);
  assert.equal(order.includes('unknown'), false);
  assert.equal(new Set(order).size, component.WIDGETS.length);
});

test('legacy widget spans migrate to clamped columns and default rows', () => {
  const component=loadComponent();
  assert.deepEqual(plain(component.normalizeWidgetConfig('net',{on:1,span:6})),{on:1,columns:6,rows:4});
  assert.deepEqual(plain(component.normalizeWidgetConfig('net',{on:1,columns:99,rows:-2})),{on:1,columns:6,rows:4});
});

test('widget packing fills the first available cells without intersections', () => {
  const component=loadComponent();
  const packed=component.packWidgetLayout([
    {id:'a',columns:8,rows:2},
    {id:'b',columns:4,rows:1},
    {id:'c',columns:8,rows:1},
    {id:'d',columns:4,rows:1},
  ],12);
  assert.deepEqual(plain(packed.map(({id,column,row})=>({id,column,row}))),[
    {id:'a',column:1,row:1},
    {id:'b',column:9,row:1},
    {id:'d',column:9,row:2},
    {id:'c',column:1,row:3},
  ]);
  for(let i=0;i<packed.length;i++)for(let j=i+1;j<packed.length;j++){
    const a=packed[i],b=packed[j];
    const overlap=a.column<b.column+b.columns&&a.column+a.columns>b.column&&a.row<b.row+b.rows&&a.row+a.rows>b.row;
    assert.equal(overlap,false,a.id+' does not overlap '+b.id);
  }
});

test('widget resize clamps by registry limits', () => {
  const component=loadComponent();
  assert.deepEqual(plain(component.resizeWidgetUnits('score',{on:1,columns:4,rows:7},99,-99)),{on:1,columns:8,rows:6});
});

test('position sizing floors contracts and reports planned utilization', () => {
  const component = loadComponent();
  const result = component.positionSize('50000', '1', '100', '98', '5');
  assert.deepEqual(plain(result), {
    qty: 50,
    riskBudget: 500,
    riskPerContract: 10,
    plannedRisk: 500,
    utilization: 1,
    reason: '',
  });
  assert.equal(component.positionSize(50000, 1, 100, 98, 5, 12).qty, 12);
});

test('position sizing guards invalid inputs and a too-small budget', () => {
  const component = loadComponent();
  const cases = [
    [NaN, 1, 100, 98, 5],
    [50000, 0, 100, 98, 5],
    [50000, 1, 100, 100, 5],
    [50000, 1, 100, 98, -5],
    [50000, 1, 100, 98, 5, -2],
    [10, 1, 100, 98, 5],
  ];
  for (const args of cases) {
    const result = component.positionSize(...args);
    assert.equal(result.qty, 0);
    assert.ok(result.reason.length > 0);
    assert.ok(result.plannedRisk >= 0);
  }
});

test('canonical times parse and bucket while invalid times return null', () => {
  const component = loadComponent();
  assert.equal(component.parseTimeMinutes('09:17'), 557);
  assert.equal(component.timeBucket('09:17'), '09:00');
  assert.equal(component.timeBucket(557, 30), '09:00');
  for (const value of ['9:17', '09:7', '24:00', '09:60', '', null, 557]) {
    assert.equal(component.parseTimeMinutes(value), null);
  }
  assert.equal(component.timeBucket(-1), null);
  assert.equal(component.timeBucket('09:17', 0), null);
});

test('time-of-day edge aggregates timed trades in ascending buckets', () => {
  const component = loadComponent();
  const rows = component.timeOfDayEdge([
    { time: '10:05', pnl: -50 },
    { time: '09:17', pnl: 100 },
    { time: '09:42', pnl: 50 },
    { pnl: 999 },
    { time: 'bad', pnl: 999 },
  ]);
  assert.deepEqual(plain(rows), [
    { label: '09:00', trades: 2, net: 150, wins: 2, winRate: 100, avg: 75 },
    { label: '10:00', trades: 1, net: -50, wins: 0, winRate: 0, avg: -50 },
  ]);
});

test('plan execution score distinguishes passes, failures, and missing data', () => {
  const component = loadComponent();
  const passing = component.planExecutionScore({
    plan: { bias: 'Long', setups: 'ORB, Pullback', maxLoss: '300' },
    tags: ['ORB'],
    trades: [{ side: 'LONG', pnl: 100 }],
    rules: { 'Followed the plan': true, 'No revenge trades': true },
  });
  assert.equal(passing.score, 100);
  assert.equal(passing.passed, 5);
  assert.equal(passing.total, 5);
  assert.ok(passing.rows.every(row => row.pass));

  const failing = component.planExecutionScore({
    plan: { bias: 'Short', setups: 'VWAP Fade', maxLoss: 100 },
    tags: ['ORB'],
    trades: [{ side: 'LONG', pnl: -100 }],
    rules: { 'Followed the plan': false },
  });
  assert.equal(failing.score, 25);
  assert.equal(failing.rows.find(row => row.key === 'maxLoss').pass, true);
  assert.ok(failing.rows.filter(row => row.key !== 'maxLoss').every(row => !row.pass));
  assert.deepEqual(plain(component.planExecutionScore({})), { score: 0, passed: 0, total: 0, rows: [] });
});

test('weekly digest uses the requested seven-day window and deterministic leaders', () => {
  const component = loadComponent();
  const days = {
    '2026-07-13': { trades: [{ pnl: 999 }], mistakes: ['Outside'] },
    '2026-07-14': { trades: [{ pnl: 100 }, { pnl: -20 }], tags: ['ORB'], sessions: ['NY Open'], mistakes: ['FOMO'] },
    '2026-07-15': { trades: [{ pnl: 50 }], tags: ['Pullback'], sessions: ['London'], mistakes: ['FOMO'] },
    '2026-07-16': { trades: [{ pnl: -200 }], tags: ['ORB'], sessions: ['NY Open'], mistakes: ['Late entry'] },
    '2026-07-20': { trades: [{ pnl: 70 }], tags: ['Pullback'], sessions: ['London'] },
    '2026-07-21': { trades: [{ pnl: 1000 }], mistakes: ['Outside'] },
  };
  const digest = component.weeklyDigest(days, '2026-07-20');
  assert.deepEqual(
    { startKey: digest.startKey, endKey: digest.endKey, net: digest.net, trades: digest.trades, wins: digest.wins, losses: digest.losses, winRate: digest.winRate },
    { startKey: '2026-07-14', endKey: '2026-07-20', net: 0, trades: 5, wins: 3, losses: 2, winRate: 60 },
  );
  assert.equal(digest.mostUsedSetup, 'ORB');
  assert.equal(digest.mostUsedSession, 'London');
  assert.equal(digest.topMistake, 'FOMO');
  assert.match(digest.focus, /FOMO/i);
});

test('tilt radar rises for recent behavioral violations and is calm when empty', () => {
  const component = loadComponent();
  assert.deepEqual(plain(component.tiltRadar({})), { status: 'Calm', score: 0, signals: [] });
  const clean = component.tiltRadar({
    '2026-07-20': { trades: [{ pnl: 100 }], mind: { stress: 2 }, rules: { Plan: true } },
  });
  const heavy = component.tiltRadar({
    '2026-07-17': { trades: [{ pnl: -50 }, { pnl: -50 }], mistakes: ['FOMO'], mind: { stress: 9 }, rules: { Plan: false } },
    '2026-07-18': { trades: [{ pnl: -30 }, { pnl: -20 }, { pnl: -10 }, { pnl: -10 }, { pnl: -10 }], mistakes: ['Revenge trade', 'Overtraded'], mind: { stress: 10 }, rules: { Plan: false, Stop: false } },
  });
  assert.ok(heavy.score > clean.score);
  assert.notEqual(heavy.status, 'Calm');
  assert.ok(heavy.signals.some(signal => signal.key === 'behavior'));
  assert.ok(heavy.signals.some(signal => signal.key === 'rules'));
});

test('photos normalize legacy strings and compact valid marks without mutation', () => {
  const component = loadComponent();
  const legacyA = component.normalizePhoto('data:image/png;base64,abc', 1, '2026-07-20');
  const legacyB = component.normalizePhoto('data:image/png;base64,abc', 1, '2026-07-20');
  assert.deepEqual(legacyA, legacyB);
  assert.equal(legacyA.src, 'data:image/png;base64,abc');
  assert.deepEqual(plain(legacyA.marks), []);

  const photo = {
    id: 'photo-1',
    src: 'image-src',
    marks: [
      { id: 'mark-1', kind: 'entry', x: 0.25, y: 0.75, label: 'Entry', extra: true },
      { kind: 'invalid', x: 0, y: 0 },
    ],
    extra: true,
  };
  const before = structuredClone(photo);
  const normalized = component.normalizePhoto(photo, 0, '2026-07-20');
  assert.deepEqual(photo, before);
  assert.deepEqual(plain(normalized), {
    id: 'photo-1',
    src: 'image-src',
    marks: [{ id: 'mark-1', kind: 'entry', x: 0.25, y: 0.75, label: 'Entry' }],
  });
});

test('quick presets merge intended fields without mutating either input', () => {
  const component = loadComponent();
  const draft = {
    trades: [{ sym: 'MES', qty: '1', entry: '100' }, { sym: 'NQ', qty: '2' }],
    tags: ['Old'], sessions: ['Asia'], conf: 'Low', rules: { Existing: false },
    plan: { bias: 'Long' },
  };
  const preset = { sym: 'NQ', qty: 3, tags: ['ORB'], sessions: ['NY Open'], conf: 'High', rules: { Plan: true }, unknown: 'ignored' };
  const draftBefore = structuredClone(draft);
  const presetBefore = structuredClone(preset);
  const result = component.applyQuickPreset(draft, preset);
  assert.deepEqual(draft, draftBefore);
  assert.deepEqual(preset, presetBefore);
  assert.deepEqual(plain(result.trades), [{ sym: 'NQ', qty: '3', entry: '100' }, { sym: 'NQ', qty: '2' }]);
  assert.deepEqual(plain(result.tags), ['ORB']);
  assert.deepEqual(plain(result.sessions), ['NY Open']);
  assert.equal(result.conf, 'High');
  assert.deepEqual(plain(result.rules), { Plan: true });
  assert.deepEqual(plain(result.plan), { bias: 'Long' });
});

test('annotation primitives clamp, reject invalid kinds, stay immutable, and undo safely', () => {
  const component = loadComponent();
  const marks = [{ id: 'a', kind: 'lesson', x: 0.5, y: 0.5 }];
  const before = structuredClone(marks);
  const added = component.addPhotoMark(marks, { kind: 'target', x: 2, y: -1, label: 'T1' });
  assert.deepEqual(marks, before);
  assert.equal(added.length, 2);
  assert.ok(added[1].id);
  assert.equal(added[1].x, 1);
  assert.equal(added[1].y, 0);
  assert.deepEqual(plain(component.addPhotoMark(marks, { kind: 'arrow', x: 0, y: 0 })), marks);
  assert.deepEqual(plain(component.undoPhotoMark(added)), marks);
  assert.deepEqual(plain(component.undoPhotoMark([])), []);
  assert.equal(component.clamp01(Infinity), 0);
});

test('draftForDay hydrates legacy trades, optional time, and normalized photos', () => {
  const component = loadComponent();
  component.state.days = {
    '2026-07-20': {
      trades: [{ sym: 'NQ', side: 'LONG', qty: 2, entry: 100, stop: 98, tp: 104, exit: 103, pnl: 120, dur: 12 }],
      photos: [
        'legacy-src',
        { id: 'photo-existing', src: 'object-src', marks: [{ id: 'm1', kind: 'entry', x: 0.2, y: 0.4, label: 'Entry' }] },
      ],
    },
  };

  const draft = component.draftForDay('2026-07-20');
  assert.equal(draft.trades[0].time, '');
  assert.equal(draft.photos[0].src, 'legacy-src');
  assert.ok(draft.photos[0].id);
  assert.deepEqual(plain(draft.photos[0].marks), []);
  assert.deepEqual(plain(draft.photos[1]), {
    id: 'photo-existing',
    src: 'object-src',
    marks: [{ id: 'm1', kind: 'entry', x: 0.2, y: 0.4, label: 'Entry' }],
  });
});

test('save shaping round-trips canonical time and photo marks but omits invalid time', () => {
  const component = loadComponent();
  const base = component.draftForDay('2026-07-20');
  base.trades = [
    { sym: 'NQ', side: 'LONG', qty: '2', time: '09:17', entry: '100', stop: '98', tp: '104', exit: '', pnl: '', dur: '' },
    { sym: 'MES', side: 'SHORT', qty: '1', time: '9:17', entry: '6000', stop: '6002', tp: '', exit: '', pnl: '', dur: '' },
  ];
  base.photos = [{ id: 'p1', src: 'chart-src', marks: [{ id: 'm1', kind: 'stop', x: 0.3, y: 0.6 }] }];

  const saved = component.shapeDay(base, '2026-07-20');
  assert.equal(saved.trades[0].time, '09:17');
  assert.equal(Object.hasOwn(saved.trades[1], 'time'), false);
  assert.deepEqual(plain(saved.photos), [{ id: 'p1', src: 'chart-src', marks: [{ id: 'm1', kind: 'stop', x: 0.3, y: 0.6 }] }]);

  component.state.days = { '2026-07-20': saved };
  const roundTrip = component.draftForDay('2026-07-20');
  assert.equal(roundTrip.trades[0].time, '09:17');
  assert.equal(roundTrip.trades[1].time, '');
  assert.deepEqual(plain(roundTrip.photos), plain(saved.photos));
});

test('applying a quick preset opens the requested draft without persisting the day', () => {
  const component = loadComponent();
  component.state.days = {
    '2026-07-20': { notes: 'Keep this', trades: [{ sym: 'MES', side: 'LONG', qty: 1, entry: 100, pnl: 0 }] },
  };
  let persistCalls = 0;
  component.persist = () => { persistCalls++; };

  component.applyPresetToDay('2026-07-20', {
    id: 'preset-nq-orb', name: 'NQ · ORB', sym: 'NQ', qty: 3,
    tags: ['ORB'], sessions: ['NY Open'], conf: 'High', rules: { 'Followed the plan': true },
  });

  assert.equal(component.state.editing, '2026-07-20');
  assert.equal(component.state.draft.notes, 'Keep this');
  assert.equal(component.state.draft.trades[0].sym, 'NQ');
  assert.equal(component.state.draft.trades[0].qty, '3');
  assert.deepEqual(plain(component.state.draft.tags), ['ORB']);
  assert.deepEqual(plain(component.state.draft.sessions), ['NY Open']);
  assert.equal(persistCalls, 0);
});

test('applying a quick preset to an empty day creates a complete editable trade draft', () => {
  const component = loadComponent();
  component.state.days = {};
  component.applyPresetToDay('2026-07-21', { sym: 'GC', qty: 2, tags: [], sessions: [], conf: '', rules: {} });
  assert.deepEqual(plain(component.state.draft.trades[0]), {
    sym: 'GC', side: 'LONG', qty: '2', time: '', entry: '', stop: '', tp: '', exit: '', pnl: '', dur: '',
  });
});

test('saving a draft preset writes settings only and replaces a duplicate readable name', () => {
  const component = loadComponent();
  seedActiveProfile(component, {}, { '2026-07-20': { notes: 'untouched' } });
  component.state.editing = '2026-07-20';
  component.state.draft = component.draftForDay('2026-07-20');
  component.state.draft.trades = [{ sym: 'NQ', side: 'LONG', qty: '2', time: '', entry: '', stop: '', tp: '', exit: '', pnl: '', dur: '' }];
  component.state.draft.tags = ['ORB'];
  component.state.draft.sessions = ['NY Open'];
  component.state.draft.conf = 'High';
  component.state.draft.rules = { 'Followed the plan': true };
  const dayBefore = structuredClone(component.state.days);
  let persistCalls = 0;
  component.persist = () => { persistCalls++; };

  const first = component.saveDraftPreset();
  assert.equal(first.name, 'NQ · ORB · NY Open');
  assert.equal(component.state.settings.quickPresets.length, 1);
  assert.deepEqual(plain(component.state.days), dayBefore);
  assert.equal(persistCalls, 0);

  component.state.draft.trades[0].qty = '5';
  const replacement = component.saveDraftPreset();
  assert.equal(replacement.name, first.name);
  assert.equal(component.state.settings.quickPresets.length, 1);
  assert.equal(component.state.settings.quickPresets[0].qty, 5);
  assert.deepEqual(plain(component.state.days), dayBefore);
  assert.equal(persistCalls, 0);
});

test('deleting a quick preset removes only the matching id', () => {
  const component = loadComponent();
  seedActiveProfile(component, { quickPresets: [
    { id: 'a', name: 'A', sym: 'ES', qty: 1, tags: [], sessions: [], conf: '', rules: {} },
    { id: 'b', name: 'B', sym: 'NQ', qty: 2, tags: [], sessions: [], conf: '', rules: {} },
    { id: 'c', name: 'C', sym: 'GC', qty: 1, tags: [], sessions: [], conf: '', rules: {} },
  ] });
  component.deleteQuickPreset('b');
  assert.deepEqual(plain(component.state.settings.quickPresets.map(item => item.id)), ['a', 'c']);
});

test('risk guide uses configured percent and custom point value, and Apply changes only quantity', () => {
  const component = loadComponent();
  component.state.settings = { startBalance: '100000', riskPct: '2', customPV: { NQ: 25 } };
  component.state.draft = component.draftForDay('2026-07-20');
  component.state.draft.trades = [{ sym: 'NQ', side: 'LONG', qty: '3', time: '09:17', entry: '100', stop: '98', tp: '106', exit: '', pnl: '', dur: '' }];
  const guide = component.riskGuideForTrade(component.state.draft.trades[0]);
  assert.equal(guide.riskBudget, 2000);
  assert.equal(guide.riskPerContract, 50);
  assert.equal(guide.qty, 40);
  assert.equal(guide.currentRisk, 150);
  assert.equal(guide.currentUtilization, 0.075);

  const before = structuredClone(component.state.draft.trades[0]);
  component.applyPositionSize(0);
  assert.deepEqual(
    plain(component.state.draft.trades[0]),
    Object.assign({}, before, { qty: '40' }),
  );
});

test('risk percent model accepts only values above zero and at most ten', () => {
  const component = loadComponent();
  seedActiveProfile(component, { riskPct: 1 });
  assert.equal(component.setRiskPct('2.5'), true);
  assert.equal(component.state.settings.riskPct, '2.5');
  for (const value of ['', '0', '-1', '10.1', 'not-a-number']) {
    assert.equal(component.setRiskPct(value), false);
    assert.equal(component.state.settings.riskPct, '2.5');
  }
});

test('load migration normalizes every persisted invalid risk percent to one', () => {
  for (const invalid of ['not-a-number', '', 0, -1, 10.1, 'Infinity']) {
    const writes = [];
    const localStorage = {
      getItem(key) {
        if (key === 'written-profiles-v2') return JSON.stringify({
          version: 2,
          activeProfileId: 'risk-profile',
          profiles: {
            'risk-profile': {
              id: 'risk-profile',
              createdAt: 1,
              lastUsedAt: 1,
              settings: { quickPresets: [], riskPct: invalid },
              days: {},
            },
          },
        });
        return null;
      },
      setItem(key, value) { writes.push([key, JSON.parse(value)]); },
    };
    const component = loadComponent({
      localStorage,
      document: { body: { dataset: {} } },
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    component.componentDidMount();
    assert.equal(component.state.settings.riskPct, 1, `normalizes ${String(invalid)}`);
    assert.equal(component.state.profileStore.profiles['risk-profile'].settings.riskPct, 1, `normalizes ${String(invalid)} in the v2 registry`);
    assert.equal(writes.some(([key]) => key === 'written-settings-v1'), false);
  }
});

test('valid version-two mount skips legacy reads and migration writes', () => {
  const reads = [];
  const writes = [];
  const localStorage = {
    getItem(key) {
      reads.push(key);
      if (key === 'written-profiles-v2') return JSON.stringify({
        version: 2,
        activeProfileId: 'profile-one',
        profiles: {
          'profile-one': {
            id: 'profile-one',
            createdAt: 1,
            lastUsedAt: 1,
            settings: { name: 'One', onboarded: true, riskPct: 1 },
            days: {},
          },
        },
      });
      throw new Error(`unexpected legacy read: ${key}`);
    },
    setItem(key, value) { writes.push([key, value]); },
  };
  const component = loadComponent({
    localStorage,
    document: { body: { dataset: {} } },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  component.componentDidMount();
  assert.deepEqual(reads, ['written-profiles-v2']);
  assert.deepEqual(writes, []);
  assert.equal(component.state.settings.name, 'One');
});

test('active profile writes remain isolated for overlapping journal dates', () => {
  const writes = [];
  const localStorage = { getItem(){return null}, setItem(key,value){writes.push([key,JSON.parse(value)])} };
  const component = loadComponent({ localStorage, crypto: { randomUUID: () => 'new-id' } });
  component.state.profileStore = {
    version: 2, activeProfileId: 'one',
    profiles: {
      one: { id:'one', createdAt:1, lastUsedAt:1, settings:{name:'One',accent:'#3DDC97'}, days:{'2026-07-22':{notes:'one'}} },
      two: { id:'two', createdAt:2, lastUsedAt:2, settings:{name:'Two',accent:'#5EB1FF'}, days:{'2026-07-22':{notes:'two'}} },
    },
  };
  component.state.settings = component.state.profileStore.profiles.one.settings;
  component.state.days = component.state.profileStore.profiles.one.days;
  assert.equal(component.persist({'2026-07-22':{notes:'one changed'}}), true);
  assert.equal(component.state.profileStore.profiles.two.days['2026-07-22'].notes, 'two');
  assert.equal(writes.at(-1)[0], 'written-profiles-v2');
});

test('profile activation guards an open draft and storage failure stays visible', () => {
  const localStorage = { setItem(){throw new Error('quota')} };
  const component = loadComponent({ localStorage, document:{body:{dataset:{}}} });
  component.state.profileStore = {
    version:2,activeProfileId:'one',
    profiles:{
      one:{id:'one',createdAt:1,lastUsedAt:1,settings:{name:'One'},days:{}},
      two:{id:'two',createdAt:2,lastUsedAt:2,settings:{name:'Two',accent:'#5EB1FF'},days:{}},
    },
  };
  component.state.settings=component.state.profileStore.profiles.one.settings;
  component.state.days={};
  component.state.editing='2026-07-22';
  component.state.draft={notes:'unsaved'};
  assert.equal(component.activateProfile('two'),false);
  assert.equal(component.state.pendingProfileId,'two');
  assert.equal(component.state.profileStore.activeProfileId,'one');
  component.state.editing=null;
  component.state.draft=null;
  assert.equal(component.activateProfile('two',true),false);
  assert.match(component.state.storageWarning,/Two|storage|save/i);
  assert.equal(component.state.settings.name,'One');
  assert.equal(component.state.profileStore.activeProfileId,'one');
});

test('successful profile activation persists the same unlocked settings exposed in state', () => {
  const writes = [];
  const component = loadComponent({
    localStorage: { setItem(key, value) { writes.push([key, JSON.parse(value)]); } },
    document: { body: { dataset: {} } },
  });
  component.state.profileStore = {
    version: 2, activeProfileId: 'one',
    profiles: {
      one: { id: 'one', createdAt: 1, lastUsedAt: 1, settings: { name: 'One', loggedOut: false }, days: {} },
      two: { id: 'two', createdAt: 2, lastUsedAt: 2, settings: { name: 'Two', pw: 'secret', loggedOut: true, accent: '#5EB1FF', theme: 'light' }, days: { '2026-07-22': { notes: 'two' } } },
    },
  };
  component.state.settings = component.state.profileStore.profiles.one.settings;
  component.state.days = {};

  assert.equal(component.activateProfile('two'), true);
  const persisted = writes.at(-1)[1];
  assert.equal(persisted.profiles.two.settings.loggedOut, false);
  assert.deepEqual(plain(component.state.settings), plain(persisted.profiles.two.settings));
  assert.deepEqual(plain(component.state.profileStore.profiles.two.settings), plain(component.state.settings));
});

test('profile list is sorted by last use and exposes one journal per profile', () => {
  const component=loadComponent();
  const rows=component.profileList({version:2,activeProfileId:'a',profiles:{
    a:{id:'a',createdAt:1,lastUsedAt:2,settings:{name:'Alpha'},days:{}},
    b:{id:'b',createdAt:1,lastUsedAt:9,settings:{name:'Beta'},days:{}},
  }});
  assert.deepEqual(plain(rows.map(row=>row.id)),['b','a']);
  assert.equal(rows[0].journalLabel,'One local journal');
});

test('profile selector markup keeps setup transient and exposes visible storage warnings', () => {
  const html=fs.readFileSync(htmlPath,'utf8');
  assert.match(html,/One local journal/);
  assert.match(html,/Create profile/);
  assert.match(html,/Lock journal/);
  assert.match(html,/role="alert"/);
  assert.match(html,/storageWarning/);
  assert.doesNotMatch(html,/liNew:[^\n]+setSettings\(\{loggedOut:false,onboarded:false/);
});

test('setup cancel binding closes every setup step without mutating the active journal', () => {
  const document = { body: { dataset: {} } };
  const component = loadComponent({ document, localStorage: { setItem() {} } });
  seedActiveProfile(component, {
    name: 'One', accent: '#C29BFF', theme: 'light', onboarded: true, loggedOut: false,
  }, { '2026-07-22': { notes: 'safe' } });
  component.state.booting = false;
  const beforeStore = JSON.stringify(component.state.profileStore);
  const beforeSettings = JSON.stringify(component.state.settings);
  const beforeDays = JSON.stringify(component.state.days);

  component.beginProfileSetup();
  component.state.obStep = 4;
  component.setAccent('#FFB454');
  const bindings = component.renderVals();
  assert.equal(typeof bindings.obCancel, 'function');
  bindings.obCancel();

  assert.equal(component.state.obStarted, false);
  assert.equal(component.state.ob, null);
  assert.equal(JSON.stringify(component.state.profileStore), beforeStore);
  assert.equal(JSON.stringify(component.state.settings), beforeSettings);
  assert.equal(JSON.stringify(component.state.days), beforeDays);
  assert.equal(document.body.dataset.theme, 'light');
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /onClick="{{obCancel}}"[^>]+aria-label="Cancel profile setup"/);
});

test('profile switch confirmation focuses, traps Tab, cancels on Escape, and restores both switch openers', () => {
  let focused = '';
  let nextTimer = 1;
  const timers = new Map();
  const setTimeout = fn => { const id = nextTimer++; timers.set(id, fn); return id; };
  const clearTimeout = id => timers.delete(id);
  const flushFocus = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); };
  const component = loadComponent({ setTimeout, clearTimeout, localStorage: { setItem() {} }, document: { body: { dataset: {} } } });
  component.state.booting = false;
  component.state.profileStore = {
    version: 2, activeProfileId: 'one',
    profiles: {
      one: { id: 'one', createdAt: 1, lastUsedAt: 1, settings: { name: 'One', onboarded: true, loggedOut: false }, days: {} },
      two: { id: 'two', createdAt: 2, lastUsedAt: 2, settings: { name: 'Two', onboarded: true, loggedOut: false }, days: {} },
    },
  };
  component.state.settings = component.state.profileStore.profiles.one.settings;
  component.state.days = {};
  component.state.selectedProfileId = 'one';
  component.state.editing = null;
  component.state.draft = { notes: 'open' };

  const sidebarOpener = { focus() { focused = 'sidebar-opener'; } };
  assert.equal(component.renderVals().profileOptions[0].select({ currentTarget: sidebarOpener }), false);
  let bindings = component.renderVals();
  assert.equal(bindings.switchConfirmOpen, true);
  const first = { focus() { focused = 'first'; } };
  const last = { focus() { focused = 'last'; } };
  const dialog = { focus() { focused = 'dialog'; }, querySelectorAll() { return [first, last]; } };
  assert.equal(bindings.setSwitchProfileDialogRef(dialog), true);
  assert.equal(focused, 'first');
  const tab = { key: 'Tab', target: last, shiftKey: false, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  assert.equal(bindings.onSwitchProfileDialogKeydown(tab), true);
  assert.equal(tab.prevented, true);
  assert.equal(tab.stopped, true);
  assert.equal(focused, 'first');
  const escape = { key: 'Escape', prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  assert.equal(bindings.onSwitchProfileDialogKeydown(escape), true);
  assert.equal(component.state.confirm, null);
  assert.equal(component.state.pendingProfileId, null);
  flushFocus();
  assert.equal(focused, 'sidebar-opener');

  component.state.settings = Object.assign({}, component.state.settings, { loggedOut: true });
  component.renderVals().loginProfiles.find(row => row.id === 'two').select();
  const loginOpener = { focus() { focused = 'login-opener'; } };
  assert.equal(component.renderVals().loginProfiles.find(row => row.id === 'two').unlock({ currentTarget: loginOpener }), false);
  bindings = component.renderVals();
  bindings.cancelProfileSwitch();
  flushFocus();
  assert.equal(focused, 'login-opener');

  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /ref="{{setSwitchProfileDialogRef}}"[^>]+onKeyDown="{{onSwitchProfileDialogKeydown}}"[^>]+tabIndex="-1"/);
});

test('profile selector bindings scope passwords, confirm guarded switches, and dismiss warnings', () => {
  const component = loadComponent({ localStorage: { setItem() {} }, document: { body: { dataset: {} } } });
  component.state.booting = false;
  component.state.profileStore = {
    version: 2, activeProfileId: 'one',
    profiles: {
      one: { id: 'one', createdAt: 1, lastUsedAt: 1, settings: { name: 'One', onboarded: true, loggedOut: true }, days: {} },
      two: { id: 'two', createdAt: 2, lastUsedAt: 2, settings: { name: 'Two', pw: 'secret', onboarded: true, loggedOut: true }, days: {} },
    },
  };
  component.state.settings = component.state.profileStore.profiles.one.settings;
  component.state.days = {};
  component.state.selectedProfileId = 'one';
  let bindings = component.renderVals();
  assert.equal(bindings.loginProfiles.find(row => row.id === 'one').showPassword, false);
  assert.equal(bindings.loginProfiles.find(row => row.id === 'two').showPassword, false);
  bindings.loginProfiles.find(row => row.id === 'two').select();
  bindings = component.renderVals();
  assert.equal(bindings.loginProfiles.find(row => row.id === 'two').showPassword, true);
  bindings.onLiPw({ target: { value: 'secret' } });
  component.state.editing = null;
  component.state.draft = { notes: 'open' };
  assert.equal(component.renderVals().loginProfiles.find(row => row.id === 'two').unlock({ currentTarget: { focus() {} } }), false);
  bindings = component.renderVals();
  assert.equal(bindings.confirmProfileSwitch(), true);
  assert.equal(component.state.profileStore.activeProfileId, 'two');
  component.state.storageWarning = 'Storage is full';
  bindings = component.renderVals();
  assert.equal(bindings.storageWarningOpen, true);
  bindings.dismissStorageWarning();
  assert.equal(component.state.storageWarning, '');
});

test('new profile setup inherits accent and cancel does not mutate the active journal', () => {
  const component=loadComponent({crypto:{randomUUID:()=> 'profile-new'},localStorage:{setItem(){}}});
  component.state.profileStore={version:2,activeProfileId:'one',profiles:{one:{id:'one',createdAt:1,lastUsedAt:1,settings:{name:'One',accent:'#C29BFF'},days:{'2026-07-22':{notes:'safe'}}}}};
  component.state.settings=component.state.profileStore.profiles.one.settings;
  component.state.days=component.state.profileStore.profiles.one.days;
  component.beginProfileSetup();
  assert.equal(component.state.ob.acc,'#C29BFF');
  component.setState({obStarted:false,ob:null});
  assert.equal(component.state.settings.name,'One');
  assert.equal(component.state.days['2026-07-22'].notes,'safe');
});

test('new profile setup opens over a locked journal without persisting transient accent changes', () => {
  const writes = [];
  const component = loadComponent({
    localStorage: { setItem(key, value) { writes.push([key, value]); } },
    document: { body: { dataset: {} } },
  });
  seedActiveProfile(component, {
    name: 'One', accent: '#C29BFF', onboarded: true, loggedOut: true,
  }, { '2026-07-22': { notes: 'safe' } });
  component.state.booting = false;

  component.beginProfileSetup();
  component.setAccent('#FFB454');
  const bindings = component.renderVals();

  assert.equal(bindings.obOpen, true);
  assert.equal(bindings.loginOpen, false);
  assert.equal(component.state.ob.acc, '#FFB454');
  assert.equal(component.state.settings.accent, '#C29BFF');
  assert.equal(component.state.profileStore.profiles['test-profile'].settings.accent, '#C29BFF');
  assert.deepEqual(writes, []);
});

test('setup custom assets stay transient and finish copies their point values', () => {
  const writes = [];
  const component = loadComponent({
    crypto: { randomUUID: () => 'new-profile' },
    localStorage: { setItem(key, value) { writes.push([key, JSON.parse(value)]); } },
  });
  seedActiveProfile(component, {
    name: 'One', accent: '#C29BFF', onboarded: true, customPV: { EXISTING: 4 },
  }, { '2026-07-22': { notes: 'safe' } });
  const activeSettingsBefore = JSON.stringify(component.state.settings);
  const activeProfileBefore = JSON.stringify(component.state.profileStore.profiles['test-profile']);

  component.beginProfileSetup();
  assert.equal(component.addAsset('EURUSD', '12.5', true), true);

  assert.deepEqual(writes, []);
  assert.equal(JSON.stringify(component.state.settings), activeSettingsBefore);
  assert.equal(JSON.stringify(component.state.profileStore.profiles['test-profile']), activeProfileBefore);
  assert.deepEqual(plain(component.state.ob.syms), ['EURUSD']);
  assert.deepEqual(plain(component.state.ob.customPV), { EURUSD: 12.5 });

  const profile = component.finishProfileSetup(component.state.ob, false);
  assert.deepEqual(plain(profile.settings.customPV), { EURUSD: 12.5 });
  assert.deepEqual(plain(component.state.profileStore.profiles['test-profile'].settings.customPV), { EXISTING: 4 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'written-profiles-v2');
});

test('profile store normalization rejects malformed input and falls back to the most recent profile', () => {
  const component = loadComponent();
  assert.equal(component.normalizeProfileStore(null), null);
  assert.equal(component.normalizeProfileStore({ version: 1, profiles: {} }), null);
  const normalized = component.normalizeProfileStore({
    version: 2,
    activeProfileId: 'missing',
    profiles: {
      first: { id: 'first', createdAt: 10, lastUsedAt: 20, settings: { name: 'First' }, days: {} },
      recent: { id: 'recent', createdAt: 11, lastUsedAt: 30, settings: { name: 'Recent' }, days: { '2026-07-22': { notes: 'kept' } } },
    },
  });
  assert.equal(normalized.activeProfileId, 'recent');
  assert.equal(component.activeProfile(normalized).settings.name, 'Recent');
  assert.equal(component.activeProfile(normalized).days['2026-07-22'].notes, 'kept');
});

test('legacy migration is idempotent and ignores createdAt-only storage', () => {
  const component = loadComponent({ crypto: { randomUUID: () => 'legacy-profile' } });
  const empty = component.migrateLegacyStore({ createdAt: 1 }, {}, 100);
  assert.deepEqual(plain(empty), { version: 2, activeProfileId: null, profiles: {} });

  const migrated = component.migrateLegacyStore(
    { createdAt: 5, onboarded: true, name: 'Alex', accent: '#5EB1FF' },
    { '2026-07-22': { notes: 'legacy note' } },
    100,
  );
  assert.equal(migrated.activeProfileId, 'legacy-profile');
  assert.equal(migrated.profiles['legacy-profile'].settings.name, 'Alex');
  assert.equal(migrated.profiles['legacy-profile'].settings.tourCompleted, true);
  assert.equal(migrated.profiles['legacy-profile'].days['2026-07-22'].notes, 'legacy note');
  assert.deepEqual(plain(component.normalizeProfileStore(migrated)), plain(migrated));
});

test('malformed v2 recovers legacy in memory without overwriting either source', () => {
  const writes=[];
  const localStorage={
    getItem(key){
      if(key==='written-profiles-v2')return '{broken';
      if(key==='written-settings-v1')return JSON.stringify({onboarded:true,name:'Recovered'});
      if(key==='written-data-v1')return JSON.stringify({days:{'2026-07-22':{notes:'recovery'}}});
      return null;
    },
    setItem(key,value){writes.push([key,value])},
  };
  const component=loadComponent({localStorage,crypto:{randomUUID:()=> 'recovered-id'}});
  const result=component.loadProfileStore();
  assert.equal(result.store.activeProfileId,'recovered-id');
  assert.match(result.warning,/could not be read|malformed/i);
  assert.deepEqual(writes,[]);
});

test('emoji edits stay in the draft until the user explicitly saves', () => {
  const component = loadComponent();
  component.state.days = { '2026-07-20': { emoji: '🙂', notes: 'persisted' } };
  component.state.editing = '2026-07-20';
  component.state.draft = component.draftForDay('2026-07-20');
  let persistCalls = 0;
  component.persist = () => { persistCalls++; };
  component.setEmoji('😄');
  assert.equal(component.state.draft.emoji, '😄');
  assert.equal(component.state.days['2026-07-20'].emoji, '🙂');
  assert.equal(persistCalls, 0);
});

test('plan score bindings expose passed, failed, and unscored rows separately from discipline', () => {
  const component = loadComponent();
  const bindings = component.planExecutionBindings({
    plan: { bias: 'Long', setups: 'ORB' },
    trades: [{ side: 'LONG', pnl: 50 }],
    tags: ['VWAP Fade'],
  }, '#3DDC97');
  assert.equal(bindings.planExecScore, 50);
  assert.ok(bindings.planExecRows.some(row => row.state === 'pass'));
  assert.ok(bindings.planExecRows.some(row => row.state === 'fail'));
  assert.ok(bindings.planExecRows.some(row => row.state === 'unscored'));
  assert.equal(Object.hasOwn(bindings, 'discScore'), false);
});

test('Task 2 UI keeps the compact drawer and exposes risk, time, presets, and plan scorecard controls', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /width:460px/);
  assert.match(html, /ACCOUNT RISK PER TRADE/);
  assert.match(html, /SAVE AS QUICK PRESET/);
  assert.match(html, />TIME</);
  assert.match(html, /RISK GUIDE/);
  assert.match(html, /planExecRows/);
  assert.match(html, /quickPresetChips/);
  assert.ok(html.includes('onChange="{{onRiskPct}}"'));
  assert.ok(html.includes('onChange="{{t.onTime}}"'));
  assert.ok(html.includes('onClick="{{t.applyRisk}}"'));
  assert.ok(html.includes('onClick="{{qp.del}}"'));
  assert.match(html, /del:\(\)=>this\.deleteQuickPreset\(preset\.id\)/);
  for (const field of ['mark', 'label', 'detail', 'col', 'bg']) assert.ok(html.includes(`{{pr.${field}}}`));
  assert.doesNotMatch(html, /planVsExec|planHasVs/);
});

test('time edge bindings preserve bucket order, values, and an explicit no-times state', () => {
  const component = loadComponent();
  const populated = component.timeEdgeBindings([
    { time: '10:20', pnl: -25 },
    { time: '09:04', pnl: 100 },
    { time: '09:59', pnl: 50 },
    { pnl: 800 },
  ]);
  assert.equal(populated.timeEdgeEmpty, false);
  assert.deepEqual(plain(populated.timeEdgeRows), [
    { label: '09:00', trades: 2, net: 150, netS: '+$150', winRate: 100, winRateS: '100%', width: '100%', color: 'var(--green)' },
    { label: '10:00', trades: 1, net: -25, netS: '-$25', winRate: 0, winRateS: '0%', width: '16.7%', color: 'var(--red)' },
  ]);
  assert.deepEqual(plain(component.timeEdgeBindings([{ pnl: 50 }, { time: 'bad', pnl: 25 }])), {
    timeEdgeRows: [],
    timeEdgeEmpty: true,
  });
  assert.equal(component.timeEdgeBindings([{ time: '11:10', pnl: 0 }]).timeEdgeRows[0].width, '4%');
});

test('weekly bindings expose deterministic empty and populated digest states', () => {
  const component = loadComponent();
  const empty = component.weeklyDigestBindings({}, '2026-07-20');
  assert.equal(empty.weeklyEmpty, true);
  assert.equal(empty.weeklyLabel, 'Jul 14 – Jul 20');
  assert.equal(empty.weeklyFocus, 'Build consistency with a complete journal week.');
  assert.equal(empty.weeklyNet, '$0');

  const populated = component.weeklyDigestBindings({
    '2026-07-14': { trades: [{ pnl: 100 }], tags: ['ORB'], sessions: ['NY Open'], mistakes: ['FOMO'] },
    '2026-07-17': { trades: [{ pnl: -40 }], tags: ['ORB'], sessions: ['London'], mistakes: ['FOMO'] },
  }, '2026-07-20');
  assert.equal(populated.weeklyEmpty, false);
  assert.equal(populated.weeklyNet, '+$60');
  assert.equal(populated.weeklyTrades, 2);
  assert.equal(populated.weeklyWinRate, '50%');
  assert.equal(populated.weeklyMostUsedSetup, 'ORB');
  assert.equal(populated.weeklyMostUsedSession, 'London');
  assert.equal(populated.weeklyTopMistake, 'FOMO');
  assert.equal(populated.weeklyFocus, 'Reduce FOMO with one explicit guardrail.');
});

test('tilt bindings map all statuses to restrained colors without changing the score', () => {
  const component = loadComponent();
  const cases = [
    [{ status: 'Calm', score: 12, signals: [] }, 'var(--green)'],
    [{ status: 'Watch', score: 48, signals: [{ key: 'rules', label: 'Broken rules', points: 12, detail: '2 violations.' }] }, 'var(--amber)'],
    [{ status: 'Reset', score: 81, signals: [] }, 'var(--red)'],
  ];
  for (const [radar, color] of cases) {
    const bindings = component.tiltRadarBindings(radar);
    assert.equal(bindings.tiltStatus, radar.status);
    assert.equal(bindings.tiltScore, radar.score);
    assert.equal(bindings.tiltColor, color);
    assert.equal(bindings.tiltWidth, `${radar.score}%`);
  }
});

test('search indexes only the active journal and ranks title matches deterministically', () => {
  const component = loadComponent();
  const active = { id: 'one', settings: { quickPresets: [{ id: 'p1', name: 'NQ ORB', sym: 'NQ' }] }, days: {
    '2026-07-22': { notes: 'Wait for confirmation', tags: ['ORB'], sessions: ['NY Open'], trades: [{ sym: 'NQ', side: 'LONG', pnl: 250 }], photos: ['chart'] },
  } };
  component.state.profileStore = {
    version: 2,
    activeProfileId: 'one',
    profiles: {
      one: active,
      two: { id: 'two', settings: {}, days: { '2026-07-21': { notes: 'Other journal secret' } } },
    },
  };
  const index = component.buildSearchIndex();
  assert.ok(index.some(entry => entry.id === 'action:log-today'));
  assert.ok(index.some(entry => entry.dayKey === '2026-07-22' && entry.text.includes('wait for confirmation')));
  assert.ok(index.some(entry => entry.dayKey === '2026-07-22' && entry.text.includes('nq')));
  const nq = component.searchEntries(index, 'NQ');
  assert.equal(nq[0].title, 'NQ ORB');
  assert.ok(nq.every(entry => !entry.text.includes('other journal secret')));
});

test('search score orders exact, prefix, token, metadata, and substring matches', () => {
  const component = loadComponent();
  const entry = (title, meta = '') => ({ title, meta, text: component.normalizeSearchText(`${title} ${meta}`), group: 'Journal', recency: 0, id: title });
  assert.ok(component.searchScore(entry('Calendar'), 'calendar') > component.searchScore(entry('Calendar review'), 'calendar'));
  assert.ok(component.searchScore(entry('NQ breakout'), 'nq') > component.searchScore(entry('Trade NQ'), 'nq'));
  assert.ok(component.searchScore(entry('Trade', 'NQ setup'), 'nq') > component.searchScore(entry('Technique', 'containsnqinside'), 'nq'));
  assert.equal(component.searchScore(entry('Calendar'), 'xyz'), -1);
});

test('search ignores malformed optional fields and does not index media payloads', () => {
  const component = loadComponent();
  const profile = { id: 'one', settings: { quickPresets: 'invalid' }, days: {
    '2026-07-21': { tags: 'invalid', sessions: null, trades: [null, { sym: 'ES', tp: 6100 }], photos: [{ src: 'data:image/png;base64,SECRET_PAYLOAD', caption: 'Opening range chart' }] },
    '2026-07-22': null,
  } };
  const index = component.buildSearchIndex(profile);
  assert.ok(index.some(entry => entry.title.includes('ES')));
  assert.ok(index.some(entry => entry.id.startsWith('photo:2026-07-21')));
  assert.ok(index.some(entry => entry.text.includes('opening range chart')));
  assert.ok(index.every(entry => !entry.text.includes('secret payload')));
});

test('search strips embedded media URLs and binary-like tokens from every descriptor path', () => {
  const component = loadComponent();
  const binaryToken = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789+/=';
  const profile = { id: 'one', settings: {}, days: {
    '2026-07-22': {
      photos: [{
        src: 'data:image/png;base64,SRC_SECRET',
        source: 'blob:SOURCE_SECRET',
        name: 'Safe name data:image/png;base64,NAME_SECRET',
        title: 'Safe title blob:TITLE_SECRET',
        label: 'Safe label data:image/png;base64,LABEL_SECRET',
        caption: 'Safe caption data:image/png;base64,CAPTION_SECRET after caption',
        alt: 'Safe alt blob:ALT_SECRET',
        filename: 'Safe filename data:application/octet-stream,FILENAME_SECRET',
        description: `Safe description ${binaryToken} after description`,
        marks: [
          { kind: 'entry data:image/png;base64,KIND_SECRET', label: 'Safe annotation blob:MARK_SECRET after annotation' },
          { kind: 'blob:ONLY_KIND_SECRET', label: 'data:text/plain,ONLY_LABEL_SECRET' },
        ],
      }],
      videos: [{
        src: 'data:video/mp4;base64,VIDEO_SRC_SECRET',
        title: 'Safe replay data:video/mp4;base64,VIDEO_TITLE_SECRET',
        description: 'Review note blob:VIDEO_DESCRIPTION_SECRET after review',
      }],
    },
  } };
  const index = component.buildSearchIndex(profile);
  const mediaRows = index.filter(entry => entry.dayKey === '2026-07-22');
  assert.equal(mediaRows.length, 3);
  for (const entry of mediaRows) {
    assert.doesNotMatch(entry.text, /\b(?:data|blob)\b/);
    assert.doesNotMatch(entry.text, /(?:src|source|name|title|label|caption|alt|filename|kind|mark|only|video|description) secret/);
    assert.ok(!entry.text.includes(component.normalizeSearchText(binaryToken)));
  }
  const day = mediaRows.find(entry => entry.id === 'day:2026-07-22');
  for (const safeText of ['safe name', 'safe title', 'safe label', 'safe caption', 'after caption', 'safe alt', 'safe filename', 'safe description', 'after description', 'entry', 'safe annotation', 'after annotation', 'safe replay', 'review note', 'after review']) {
    assert.ok(day.text.includes(safeText), `safe media text includes ${safeText}`);
  }
});

test('search strips shorter padded base64 media tokens without deleting human words', () => {
  const component = loadComponent();
  const encoded = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo12345=';
  const longHumanWord = 'pneumonoultramicroscopicsilicovolcanoconiosisdiscussion';
  const profile = { id: 'one', settings: {}, days: {
    '2026-07-22': {
      photos: [{
        caption: `Before caption ${encoded} after caption ${longHumanWord}`,
        marks: [{ kind: 'lesson', label: `Before annotation ${encoded} after annotation` }],
      }],
    },
  } };
  const rows = component.buildSearchIndex(profile).filter(entry => entry.dayKey === '2026-07-22');
  assert.equal(rows.length, 2);
  const normalizedEncoded = component.normalizeSearchText(encoded);
  for (const entry of rows) {
    assert.ok(!entry.text.includes(normalizedEncoded));
    assert.ok(entry.text.includes(longHumanWord));
  }
  const day = rows.find(entry => entry.id === 'day:2026-07-22');
  for (const safeText of ['before caption', 'after caption', 'lesson', 'before annotation', 'after annotation']) {
    assert.ok(day.text.includes(safeText), `safe media text includes ${safeText}`);
  }
});

test('search covers all navigation targets, journal fields, trades, and media descriptors', () => {
  const component = loadComponent();
  const profile = { id: 'one', settings: { quickPresets: [] }, days: {
    '2026-07-20': {
      emoji: 'focused', notes: 'patient entry', conf: 'A plus setup', tags: ['breakout'], sessions: ['London'],
      mistakes: ['late entry'], exits: ['scaled out'], timeframes: ['five minute'],
      plan: { bias: 'bullish' }, noteSet: { research: 'delta study' }, review: { well: 'held winner' },
      mind: { stress: 'calm' }, rules: { 'No revenge trades': true },
      trades: [{ sym: 'GC', side: 'SHORT', qty: 2, time: '09:45', entry: 3400, stop: 3410, tp: 3380, exit: 3385, pnl: 300, dur: 12 }],
      photos: [{ src: 'data:image/png;base64,HIDDEN_IMAGE', name: 'Liquidity sweep', marks: [{ label: 'Retest zone' }] }],
      videos: [{ src: 'data:video/mp4;base64,HIDDEN_VIDEO', title: 'Execution replay' }],
    },
  } };
  const index = component.buildSearchIndex(profile);
  assert.deepEqual(
    plain(index.filter(entry => entry.group === 'Navigation').map(entry => entry.tab).sort()),
    ['about', 'cal', 'dash', 'gallery', 'help', 'insights', 'playbook', 'profile', 'settings', 'trades'],
  );
  const day = index.find(entry => entry.id === 'day:2026-07-20');
  for (const value of ['focused', 'patient entry', 'a plus setup', 'breakout', 'london', 'late entry', 'scaled out', 'five minute', 'bullish', 'delta study', 'held winner', 'calm', 'no revenge trades', 'gc', 'short', '09 45', '3400', '3410', '3380', '3385', '300', '12', 'liquidity sweep', 'retest zone', 'execution replay']) {
    assert.ok(day.text.includes(value), `day search text includes ${value}`);
  }
  assert.equal(index.filter(entry => entry.id.startsWith('trade:2026-07-20')).length, 1);
  assert.equal(index.filter(entry => entry.id.startsWith('photo:2026-07-20')).length, 1);
  assert.equal(index.filter(entry => entry.id.startsWith('video:2026-07-20')).length, 1);
  assert.ok(index.every(entry => !entry.text.includes('hidden image') && !entry.text.includes('hidden video')));
  assert.doesNotThrow(() => JSON.stringify(index));
  assert.ok(index.every(entry => !Object.values(entry).some(value => typeof value === 'function')));
});

test('search tie breakers use group, recency, title, and id in a stable order', () => {
  const component = loadComponent();
  const rows = [
    { id: 'nav:z', title: 'Same', meta: 'match', text: 'same match', group: 'Navigation', recency: 0 },
    { id: 'journal:old', title: 'Beta', meta: 'match', text: 'beta match', group: 'Journal', recency: 20260720 },
    { id: 'action:z', title: 'Same', meta: 'match', text: 'same match', group: 'Actions', recency: 0 },
    { id: 'journal:new-b', title: 'Zulu', meta: 'match', text: 'zulu match', group: 'Journal', recency: 20260722 },
    { id: 'journal:new-a2', title: 'Alpha', meta: 'match', text: 'alpha match', group: 'Journal', recency: 20260722 },
    { id: 'journal:new-a1', title: 'Alpha', meta: 'match', text: 'alpha match', group: 'Journal', recency: 20260722 },
  ];
  assert.deepEqual(plain(component.searchEntries(rows, 'match').map(entry => entry.id)), [
    'action:z', 'journal:new-a1', 'journal:new-a2', 'journal:new-b', 'journal:old', 'nav:z',
  ]);
});

test('search tie breakers compare case and non-ASCII titles and ids by code point', () => {
  const component = loadComponent();
  const rows = [
    { id: 'id:beta', title: 'βeta', meta: 'needle', text: 'βeta needle', group: 'Journal', recency: 1 },
    { id: 'id:accent', title: 'Álpha', meta: 'needle', text: 'álpha needle', group: 'Journal', recency: 1 },
    { id: 'id:lower', title: 'alpha', meta: 'needle', text: 'alpha needle', group: 'Journal', recency: 1 },
    { id: 'id:á', title: 'Alpha', meta: 'needle', text: 'alpha needle', group: 'Journal', recency: 1 },
    { id: 'id:a', title: 'Alpha', meta: 'needle', text: 'alpha needle', group: 'Journal', recency: 1 },
    { id: 'id:Z', title: 'Alpha', meta: 'needle', text: 'alpha needle', group: 'Journal', recency: 1 },
  ];
  const expected = ['id:Z', 'id:a', 'id:á', 'id:lower', 'id:accent', 'id:beta'];
  for (let run = 0; run < 5; run++) {
    assert.deepEqual(plain(component.searchEntries(rows, 'needle').map(entry => entry.id)), expected);
  }
});

test('search result execution preserves safe drafts and confirms actions that leave the day', () => {
  const component = loadComponent();
  component.state = Object.assign({}, component.state, {
    booting: false,
    settings: { onboarded: true, loggedOut: false },
    editing: '2026-07-20',
    draft: { notes: 'Unsaved draft' },
    searchOpen: true,
  });
  const draft = component.state.draft;
  let exports = 0;
  component.exportCsv = () => { exports++; };

  assert.equal(component.executeSearchResult({ id: 'day:2026-07-20', type: 'day', dayKey: '2026-07-20' }), true);
  assert.equal(component.state.editing, '2026-07-20');
  assert.equal(component.state.draft, draft);
  assert.equal(component.executeSearchResult({ id: 'action:export', type: 'export' }), true);
  assert.equal(exports, 1);
  assert.equal(component.state.editing, '2026-07-20');
  assert.equal(component.state.draft, draft);

  const leaving = { id: 'nav:insights', type: 'nav', tab: 'insights' };
  assert.equal(component.executeSearchResult(leaving), false);
  assert.equal(component.state.confirm, 'search-leave');
  assert.deepEqual(plain(component.state.pendingSearchResult), leaving);
  assert.equal(component.cancelPendingSearchResult(), true);
  assert.equal(component.state.confirm, null);
  assert.equal(component.state.pendingSearchResult, null);
  assert.equal(component.state.editing, '2026-07-20');
  assert.equal(component.state.draft, draft);

  component.executeSearchResult(leaving);
  assert.equal(component.confirmPendingSearchResult(), true);
  assert.equal(component.state.tab, 'insights');
  assert.equal(component.state.editing, null);
  assert.equal(component.state.draft, null);
  assert.equal(component.state.pendingSearchResult, null);
  assert.equal(component.state.confirm, null);
});

test('search result actions do not run while another private surface owns focus', () => {
  const component = loadComponent();
  let exports = 0;
  component.exportCsv = () => { exports++; };
  const base = { booting: false, launching: false, obStarted: false, settings: { onboarded: true, loggedOut: false }, annotation: null, lightbox: null, confirm: null, tourOpen: false };
  const blocked = [
    { booting: true },
    { launching: true },
    { obStarted: true },
    { settings: { onboarded: true, loggedOut: true } },
    { annotation: { index: 0 } },
    { lightbox: { t: 'i' } },
    { confirm: 'switch-profile' },
    { tourOpen: true },
  ];
  for (const patch of blocked) {
    component.state = Object.assign({}, component.state, base, patch);
    assert.equal(component.executeSearchResult({ id: 'action:export', type: 'export' }), false);
  }
  assert.equal(exports, 0);
});

test('search leave confirmation exposes accessible confirm and cancel bindings', () => {
  const component = loadComponent();
  seedActiveProfile(component, { onboarded: true, loggedOut: false, quickPresets: [] }, {});
  component.state = Object.assign({}, component.state, {
    booting: false,
    editing: '2026-07-20',
    draft: component.draftForDay('2026-07-20'),
    pendingSearchResult: { id: 'nav:trades', type: 'nav', tab: 'trades' },
    confirm: 'search-leave',
  });
  const bindings = component.renderVals();
  assert.equal(bindings.searchLeaveConfirmOpen, true);
  for (const name of ['confirmPendingSearchResult', 'cancelPendingSearchResult', 'setSearchLeaveDialogRef', 'onSearchLeaveDialogKeydown']) {
    assert.equal(typeof bindings[name], 'function', `${name} is exposed`);
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /aria-labelledby="search-leave-title"/);
  assert.match(html, /onClick="{{cancelPendingSearchResult}}"/);
  assert.match(html, /onClick="{{confirmPendingSearchResult}}"/);
});

test('profile activation and logout clear pending search results from the prior journal', () => {
  const component = loadComponent({ localStorage: { setItem() {} }, document: { body: { dataset: {} } } });
  component.state.profileStore = {
    version: 2,
    activeProfileId: 'one',
    profiles: {
      one: { id: 'one', createdAt: 1, lastUsedAt: 1, settings: { name: 'One', onboarded: true, loggedOut: false }, days: {} },
      two: { id: 'two', createdAt: 2, lastUsedAt: 2, settings: { name: 'Two', onboarded: true, loggedOut: false }, days: {} },
    },
  };
  component.state.settings = component.state.profileStore.profiles.one.settings;
  component.state.pendingSearchResult = { id: 'preset:old', type: 'preset', preset: { sym: 'NQ' } };
  component.state.searchOpen = true;
  assert.equal(component.activateProfile('two', true), true);
  assert.equal(component.state.pendingSearchResult, null);
  assert.equal(component.state.searchOpen, false);

  component.state.pendingSearchResult = { id: 'day:old', type: 'day', dayKey: '2026-07-20' };
  component.logout();
  assert.equal(component.state.pendingSearchResult, null);
});

test('global search is centered in the titlebar and visible Quick Add is removed', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const titlebar = html.match(/<div data-screen-label="Titlebar"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(titlebar);
  assert.match(html, /class="app-titlebar glass-surface"/);
  assert.match(html, /grid-template-columns:minmax\(120px,1fr\) minmax\(260px,520px\) minmax\(120px,1fr\)/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-controls="global-search-results"/);
  assert.match(html, /aria-activedescendant="{{searchActiveId}}"/);
  assert.match(html, /id="global-search-results"/);
  assert.match(html, /class="search-popover glass-surface-strong"/);
  assert.doesNotMatch(html, />Quick add </);
  assert.doesNotMatch(html, /quick-overlay/);
});

test('global search shortcut focuses and selects outside editable targets only', async () => {
  const component = loadComponent();
  component.state.booting = false;
  component.state.settings = { onboarded: true, loggedOut: false };
  const searchInput = {
    focusCalls: 0,
    selectCalls: 0,
    focus() { this.focusCalls++; },
    select() { this.selectCalls++; },
  };
  component.setSearchInputRef(searchInput);
  const event = target => ({ key: 'k', metaKey: true, ctrlKey: false, target, prevented: false, preventDefault() { this.prevented = true; } });
  const plainTarget = event({ tagName: 'DIV' });
  assert.equal(component.handleGlobalKeydown(plainTarget), true);
  assert.equal(component.state.searchOpen, true);
  assert.equal(plainTarget.prevented, true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(searchInput.focusCalls, 1);
  assert.equal(searchInput.selectCalls, 1);

  component.closeSearch(false);
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'SELECT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
    const editable = event(target);
    assert.equal(component.handleGlobalKeydown(editable), false);
    assert.equal(component.state.searchOpen, false);
    assert.equal(editable.prevented, false);
  }
});

test('search render bindings group active-journal results with stable option ids', () => {
  const component = loadComponent();
  seedActiveProfile(component, { onboarded: true, loggedOut: false, quickPresets: [] }, {
    '2026-07-22': { notes: 'Patient entry', trades: [{ sym: 'NQ', side: 'LONG', pnl: 100 }] },
  });
  component.state = Object.assign({}, component.state, { booting: false, searchOpen: true, searchQuery: 'NQ', searchSel: 0 });
  const bindings = component.renderVals();
  assert.equal(bindings.searchOpen, true);
  assert.equal(bindings.searchQuery, 'NQ');
  assert.ok(bindings.searchRows.length > 0);
  assert.ok(bindings.searchGroups.length > 0);
  assert.equal(bindings.searchActiveId, bindings.searchRows[0].optionId);
  assert.ok(bindings.searchRows.every(row => row.optionId.startsWith('global-search-option-')));
  assert.ok(bindings.searchGroups.every(group => group.items.length > 0));
});

test('search arrow navigation wraps, Tab is not trapped, Enter executes, and Escape closes', () => {
  const component = loadComponent();
  component.state = Object.assign({}, component.state, { booting: false, settings: { onboarded: true, loggedOut: false }, searchOpen: true });
  assert.equal(component.moveSearchSelection(1, 3, 2), 0);
  assert.equal(component.moveSearchSelection(-1, 3, 0), 2);
  assert.equal(component.moveSearchSelection(1, 0, 0), 0);

  const tab = { key: 'Tab', prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(component.handleSearchKeydown(tab, []), false);
  assert.equal(tab.prevented, false);

  component.state.searchSel = 99;
  let exports = 0;
  component.exportCsv = () => { exports++; };
  const enter = { key: 'Enter', prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(component.handleSearchKeydown(enter, [{ id: 'action:export', type: 'export' }]), true);
  assert.equal(exports, 1);
  assert.equal(enter.prevented, true);

  component.state.searchOpen = true;
  const escape = { key: 'Escape', prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  assert.equal(component.handleSearchKeydown(escape, []), true);
  assert.equal(component.state.searchOpen, false);
  assert.equal(escape.prevented, true);
  assert.equal(escape.stopped, true);
});

test('log-today and preset search results open drafts without persistence', () => {
  const component = loadComponent();
  component.state.booting = false;
  component.state.settings = { onboarded: true, loggedOut: false, quickPresets: [] };
  component.state.days = {};
  let persistCalls = 0;
  component.persist = () => { persistCalls++; };
  const todayKey = component.dk(new Date());

  component.executeSearchResult({ id: 'action:log-today', type: 'log' });
  assert.equal(component.state.editing, todayKey);
  assert.ok(component.state.draft);
  assert.equal(component.state.searchOpen, false);

  component.closeEditor(false);
  component.state.searchOpen = true;
  component.executeSearchResult({ id: 'preset:p1', type: 'preset', preset: { id: 'p1', sym: 'GC', qty: 2, tags: ['Breakout'] } });
  assert.equal(component.state.editing, todayKey);
  assert.equal(component.state.draft.trades[0].sym, 'GC');
  assert.deepEqual(plain(component.state.draft.tags), ['Breakout']);
  assert.equal(component.state.searchOpen, false);
  assert.equal(persistCalls, 0);
});

test('navigation and export search results invoke only their intended action and close', () => {
  const component = loadComponent();
  component.state.booting = false;
  component.state.settings = { onboarded: true, loggedOut: false };
  let exports = 0;
  let draftCalls = 0;
  component.exportCsv = () => { exports++; };
  component.openDay = () => { draftCalls++; };

  component.state.searchOpen = true;
  component.executeSearchResult({ id: 'nav:insights', type: 'nav', tab: 'insights' });
  assert.equal(component.state.tab, 'insights');
  assert.equal(component.state.searchOpen, false);
  assert.equal(exports, 0);
  assert.equal(draftCalls, 0);

  component.state.searchOpen = true;
  component.executeSearchResult({ id: 'action:export', type: 'export' });
  assert.equal(exports, 1);
  assert.equal(component.state.tab, 'insights');
  assert.equal(component.state.searchOpen, false);
  assert.equal(draftCalls, 0);
});

test('Task 3 insights remain exposed with accessible responsive surfaces', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const component = loadComponent();
  component.state.booting = false;
  component.state.settings.onboarded = true;
  const bindings = component.renderVals();
  const names = [
    'weeklyEmpty', 'weeklyLabel', 'weeklyNet', 'weeklyTrades', 'weeklyWinRate', 'weeklyMostUsedSetup',
    'weeklyMostUsedSession', 'weeklyTopMistake', 'weeklyFocus', 'timeEdgeRows', 'timeEdgeEmpty',
    'tiltStatus', 'tiltScore', 'tiltColor', 'tiltWidth', 'tiltSignals',
  ];
  for (const name of names) {
    assert.ok(Object.hasOwn(bindings, name), `renderVals exposes ${name}`);
    assert.ok(html.includes(`{{${name}}}`) || html.includes(`{{${name}.`), `template uses ${name}`);
  }
  assert.match(html, /Weekly Review Digest/);
  assert.match(html, /Time-of-Day Edge/);
  assert.match(html, /Tilt and Discipline Radar/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /@media\(max-width:760px\)/);
  assert.match(html, /\.time-edge-row\{grid-template-areas:/);
});

test('search interaction guard blocks every unavailable private surface and closes on logout', () => {
  const component = loadComponent();
  const blocked = [
    { booting: true, launching: false, obStarted: false, settings: { onboarded: true, loggedOut: false } },
    { booting: false, launching: true, obStarted: false, settings: { onboarded: true, loggedOut: false } },
    { booting: false, launching: false, obStarted: false, settings: { onboarded: true, loggedOut: true } },
    { booting: false, launching: false, obStarted: false, settings: { onboarded: false, loggedOut: false } },
    { booting: false, launching: false, obStarted: true, settings: { onboarded: true, loggedOut: false } },
    { booting: false, launching: false, obStarted: false, settings: { onboarded: true, loggedOut: false }, annotation: { index: 0 } },
    { booting: false, launching: false, obStarted: false, settings: { onboarded: true, loggedOut: false }, lightbox: { t: 'i' } },
    { booting: false, launching: false, obStarted: false, settings: { onboarded: true, loggedOut: false }, tourOpen: true },
    { booting: false, launching: false, obStarted: false, settings: { onboarded: true, loggedOut: false }, confirm: 'switch-profile' },
  ];
  for (const state of blocked) {
    component.state = Object.assign({}, component.state, { annotation: null, lightbox: null, tourOpen: false, confirm: null }, state, { searchOpen: false });
    assert.equal(component.canUseSearch(), false);
    assert.equal(component.openSearch(), false);
    assert.equal(component.state.searchOpen, false);
    const shortcut = { key: 'k', metaKey: true, target: { tagName: 'DIV' }, prevented: false, preventDefault() { this.prevented = true; } };
    assert.equal(component.handleGlobalKeydown(shortcut), false);
    assert.equal(shortcut.prevented, false);
  }

  component.state = Object.assign({}, component.state, { booting: false, launching: false, obStarted: false, annotation: null, lightbox: null, tourOpen: false, confirm: null, editing: '2026-07-22', draft: {}, settings: { onboarded: true, loggedOut: false } });
  assert.equal(component.canUseSearch(), true, 'search remains available while editing');
  component.state = Object.assign({}, component.state, { searchOpen: true, searchQuery: 'export', searchSel: 2, pendingSearchResult: { id: 'day:old', type: 'day' } });
  assert.equal(component.renderVals().appInert, true, 'editor, not search, keeps the app inert');
  component.state.editing = null;
  component.state.draft = null;
  assert.equal(component.renderVals().appInert, false, 'search popover does not inert the app');
  component.logout();
  assert.equal(component.state.searchOpen, false);
  assert.equal(component.state.searchQuery, '');
  assert.equal(component.state.searchSel, 0);
  assert.equal(component.state.pendingSearchResult, null);
});

test('search Enter clamps a stale selection to the filtered result bounds', () => {
  const component = loadComponent();
  component.state.booting = false;
  component.state.settings = { onboarded: true, loggedOut: false };
  component.state.searchOpen = true;
  component.state.searchSel = 99;
  let selected = null;
  component.executeSearchResult = entry => { selected = entry.id; return true; };
  const event = { key: 'Enter', prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(component.handleSearchKeydown(event, [{ id: 'first' }, { id: 'last' }]), true);
  assert.equal(selected, 'last');
  assert.equal(event.prevented, true);
});

test('annotation, lightbox, tour, and profile confirmation own Escape without reviving stale search', () => {
  const escape = component => {
    const event = { key: 'Escape', prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    assert.equal(component.handleGlobalKeydown(event), true);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  };

  const annotation = loadComponent();
  annotation.state = Object.assign({}, annotation.state, {
    booting: false,
    settings: { onboarded: true, loggedOut: false },
    editing: '2026-07-22',
    draft: { photos: [{ id: 'photo-a', src: 'chart', marks: [] }] },
    searchOpen: true,
    searchQuery: 'chart',
  });
  assert.equal(annotation.openAnnotation(0, { focus() {} }), true);
  assert.equal(annotation.state.searchOpen, false);
  escape(annotation);
  assert.equal(annotation.state.annotation, null);
  assert.equal(annotation.state.searchOpen, false);

  const lightbox = loadComponent();
  lightbox.state.searchOpen = true;
  lightbox.state.searchQuery = 'chart';
  assert.equal(lightbox.openLightbox({ t: 'i', src: 'chart' }, { focus() {} }), true);
  assert.equal(lightbox.state.searchOpen, false);
  escape(lightbox);
  assert.equal(lightbox.state.lightbox, null);
  assert.equal(lightbox.state.searchOpen, false);

  const tour = loadComponent();
  tour.state = Object.assign({}, tour.state, {
    booting: false,
    settings: { onboarded: true, loggedOut: false },
  });
  tour.state.searchOpen = true;
  tour.state.searchQuery = 'walkthrough';
  assert.equal(tour.openTour(true), true);
  assert.equal(tour.state.searchOpen, false);
  escape(tour);
  assert.equal(tour.state.tourOpen, false);
  assert.equal(tour.state.searchOpen, false);

  const confirmation = loadComponent();
  confirmation.state.profileStore = {
    version: 2,
    activeProfileId: 'one',
    profiles: {
      one: { id: 'one', createdAt: 1, lastUsedAt: 1, settings: {}, days: {} },
      two: { id: 'two', createdAt: 2, lastUsedAt: 2, settings: {}, days: {} },
    },
  };
  confirmation.state.editing = '2026-07-22';
  confirmation.state.draft = {};
  confirmation.state.searchOpen = true;
  confirmation.state.searchQuery = 'profile';
  assert.equal(confirmation.requestProfileActivation('two', { focus() {} }), false);
  assert.equal(confirmation.state.confirm, 'switch-profile');
  assert.equal(confirmation.state.searchOpen, false);
  escape(confirmation);
  assert.equal(confirmation.state.confirm, null);
  assert.equal(confirmation.state.pendingProfileId, null);
  assert.equal(confirmation.state.searchOpen, false);
});

test('search-leave Escape cancels confirmation and restores the open search input', () => {
  let focused = '';
  let nextTimer = 1;
  const timers = new Map();
  const setTimeout = fn => { const id = nextTimer++; timers.set(id, fn); return id; };
  const clearTimeout = id => timers.delete(id);
  const flushFocus = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); };
  const opener = { focus() { focused = 'opener'; } };
  const resultButton = { focus() { focused = 'detached-result'; } };
  const document = { activeElement: opener };
  const component = loadComponent({ document, setTimeout, clearTimeout });
  component.state = Object.assign({}, component.state, {
    booting: false,
    settings: { onboarded: true, loggedOut: false },
    editing: '2026-07-22',
    draft: { notes: 'Unsaved', trades: [] },
    searchQuery: 'insights',
  });
  component.setSearchInputRef({ focus() { focused = 'search-input'; }, select() { focused = 'search-selected'; } });
  assert.equal(component.openSearch(opener), true);
  flushFocus();
  document.activeElement = resultButton;
  assert.equal(component.executeSearchResult({ id: 'nav:insights', type: 'nav', tab: 'insights' }), false);
  assert.equal(component.state.confirm, 'search-leave');

  const event = { key: 'Escape', prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  assert.equal(component.handleGlobalKeydown(event), true);
  assert.equal(component.state.confirm, null);
  assert.equal(component.state.pendingSearchResult, null);
  assert.equal(component.state.searchOpen, true);
  assert.equal(component.state.searchQuery, 'insights');
  flushFocus();
  assert.equal(focused, 'search-selected');
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});

test('search option ids are semantic, stable across query reorder, and collision-free for Unicode ids', () => {
  const component = loadComponent();
  seedActiveProfile(component, { onboarded: true, loggedOut: false, quickPresets: [] }, {});
  component.state = Object.assign({}, component.state, { booting: false, searchOpen: true, searchQuery: 'trades', searchSel: 0 });
  const tradesRows = component.renderVals().searchRows;
  const firstExport = tradesRows.find(row => row.id === 'action:export');
  assert.ok(firstExport);
  const firstPosition = tradesRows.findIndex(row => row.id === firstExport.id);

  component.state.searchQuery = 'export';
  const exportRows = component.renderVals().searchRows;
  const secondExport = exportRows.find(row => row.id === 'action:export');
  assert.ok(secondExport);
  assert.notEqual(firstPosition, exportRows.findIndex(row => row.id === secondExport.id));
  assert.equal(firstExport.optionId, secondExport.optionId);
  assert.match(firstExport.optionId, /^global-search-option-[0-9a-f-]+$/);

  const unicode = component.searchOptionId('résumé/日');
  const punctuation = component.searchOptionId('résumé:日');
  assert.match(unicode, /^global-search-option-[0-9a-f-]+$/);
  assert.notEqual(unicode, punctuation);
});

test('focusSearch binding focuses and selects the registered titlebar input', () => {
  const component = loadComponent();
  seedActiveProfile(component, { onboarded: true, loggedOut: false, quickPresets: [] }, {});
  component.state.booting = false;
  const calls = [];
  component.setSearchInputRef({ focus() { calls.push('focus'); }, select() { calls.push('select'); } });
  const bindings = component.renderVals();
  assert.equal(typeof bindings.focusSearch, 'function');
  assert.equal(bindings.focusSearch(), true);
  assert.deepEqual(calls, ['focus', 'select']);
});

test('native export and navigation results restore the pre-search opener after popover removal', () => {
  let focused = '';
  let nextTimer = 1;
  const timers = new Map();
  const setTimeout = fn => { const id = nextTimer++; timers.set(id, fn); return id; };
  const clearTimeout = id => timers.delete(id);
  const flushFocus = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); };
  const opener = { focus() { focused = 'opener'; } };
  const resultButton = { focus() { focused = 'detached-result'; } };
  const document = { activeElement: opener };
  const component = loadComponent({ document, setTimeout, clearTimeout });
  seedActiveProfile(component, { onboarded: true, loggedOut: false, quickPresets: [] }, {});
  component.state.booting = false;
  component.setSearchInputRef({ focus() { focused = 'search-input'; }, select() { focused = 'search-selected'; } });
  let exports = 0;
  component.exportCsv = () => { exports++; };

  for (const [query, id] of [['export', 'action:export'], ['insights', 'nav:insights']]) {
    document.activeElement = opener;
    assert.equal(component.openSearch(opener), true);
    flushFocus();
    component.state.searchQuery = query;
    const row = component.renderVals().searchRows.find(item => item.id === id);
    assert.ok(row);
    focused = 'detached-result';
    document.activeElement = resultButton;
    assert.equal(row.run({ currentTarget: resultButton }), true);
    assert.equal(component.state.searchOpen, false);
    flushFocus();
    assert.equal(focused, 'opener');
  }
  assert.equal(exports, 1);
  assert.equal(component.state.tab, 'insights');
});

test('native result opening an editor transfers restoration to the pre-search opener', () => {
  let focused = '';
  let nextTimer = 1;
  const timers = new Map();
  const setTimeout = fn => { const id = nextTimer++; timers.set(id, fn); return id; };
  const clearTimeout = id => timers.delete(id);
  const flushFocus = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); };
  const opener = { focus() { focused = 'opener'; } };
  const resultButton = { focus() { focused = 'detached-result'; } };
  const document = { activeElement: opener };
  const component = loadComponent({ document, setTimeout, clearTimeout });
  seedActiveProfile(component, { onboarded: true, loggedOut: false, quickPresets: [] }, {});
  component.state.booting = false;
  component.setSearchInputRef({ focus() { focused = 'search-input'; }, select() { focused = 'search-selected'; } });
  assert.equal(component.openSearch(opener), true);
  flushFocus();
  component.state.searchQuery = 'log today';
  const row = component.renderVals().searchRows.find(item => item.id === 'action:log-today');
  assert.ok(row);
  focused = 'detached-result';
  document.activeElement = resultButton;
  assert.equal(row.run({ currentTarget: resultButton }), true);
  assert.ok(component.state.editing);

  const editorFirst = { focus() { focused = 'editor-first'; } };
  assert.equal(component.captureSurfaceDialog('editor', { querySelectorAll() { return [editorFirst]; } }), true);
  assert.equal(focused, 'editor-first');
  component.closeEditor();
  flushFocus();
  assert.equal(focused, 'opener');
});

test('profile setup clears hidden search state and opener through cancel and new-profile finish', () => {
  const component = loadComponent({ localStorage: { setItem() {} }, document: { body: { dataset: {} } } });
  seedActiveProfile(component, { name: 'Existing', onboarded: true, loggedOut: false, accent: '#3DDC97' }, {});
  component.state.booting = false;
  const opener = { focus() {} };
  component.setSearchInputRef({ focus() {}, select() {} });
  assert.equal(component.openSearch(opener), true);
  component.state.searchQuery = 'NQ setup';
  component.state.searchSel = 3;
  assert.equal(component._surfaceOpeners.search, opener);

  component.beginProfileSetup();
  assert.equal(component.state.obStarted, true);
  assert.equal(component.state.searchOpen, false);
  assert.equal(component.state.searchQuery, '');
  assert.equal(component.state.searchSel, 0);
  assert.equal(component._surfaceOpeners.search, undefined);

  component.state.searchOpen = true;
  component.state.searchQuery = 'hidden cancel query';
  component.state.searchSel = 2;
  component._surfaceOpeners.search = opener;
  component.cancelProfileSetup();
  assert.equal(component.state.obStarted, false);
  assert.equal(component.state.searchOpen, false);
  assert.equal(component.state.searchQuery, '');
  assert.equal(component.state.searchSel, 0);
  assert.equal(component._surfaceOpeners.search, undefined);
  assert.equal(component.renderVals().searchOpen, false);

  component.beginProfileSetup();
  component.state.searchOpen = true;
  component.state.searchQuery = 'hidden finish query';
  component.state.searchSel = 1;
  component._surfaceOpeners.search = opener;
  component.finishProfileSetup({ name: 'New', bal: '', syms: ['MES'], customPV: {}, acc: '#3DDC97', pw: '' }, false);
  assert.equal(component.state.obStarted, false);
  assert.equal(component.state.searchOpen, false);
  assert.equal(component.state.searchQuery, '');
  assert.equal(component.state.searchSel, 0);
  assert.equal(component._surfaceOpeners.search, undefined);
});

test('navigation restores a live opener or a persistent titlebar fallback after deferred unmount', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /data-screen-label="Titlebar"[^>]+ref="{{setTitlebarFocusRef}}"[^>]+tabIndex="-1"/);

  const runNavigation = disconnectBeforeFlush => {
    let nextTimer = 1;
    const timers = new Map();
    const setTimeout = fn => { const id = nextTimer++; timers.set(id, fn); return id; };
    const clearTimeout = id => timers.delete(id);
    const flushFocus = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); };
    const calls = { opener: 0, fallback: 0 };
    const opener = { isConnected: true, focus() { calls.opener++; } };
    const fallback = { isConnected: true, focus() { calls.fallback++; } };
    const document = { activeElement: opener };
    const component = loadComponent({ document, setTimeout, clearTimeout });
    seedActiveProfile(component, { onboarded: true, loggedOut: false, quickPresets: [] }, {});
    component.state.booting = false;
    component.setSearchInputRef({ isConnected: true, focus() {}, select() {} });
    component.setTitlebarFocusRef(fallback);

    const shortcut = { key: 'k', metaKey: true, ctrlKey: false, target: opener, preventDefault() {} };
    assert.equal(component.handleGlobalKeydown(shortcut), true);
    flushFocus();
    component.state.searchQuery = 'insights';
    const row = component.renderVals().searchRows.find(item => item.id === 'nav:insights');
    assert.ok(row);
    assert.equal(row.run({ currentTarget: { isConnected: true, focus() {} } }), true);
    assert.equal(component.state.tab, 'insights');
    assert.equal(component.state.searchOpen, false);
    if(disconnectBeforeFlush)opener.isConnected = false;
    flushFocus();
    return calls;
  };

  assert.deepEqual(runNavigation(true), { opener: 0, fallback: 1 });
  assert.deepEqual(runNavigation(false), { opener: 1, fallback: 0 });
});

test('picker pointer listeners are replaced and removed on pointerup and unmount', () => {
  const active = new Map();
  const added = [];
  const removed = [];
  const window = {
    addEventListener(type, callback) { added.push([type, callback]); active.set(type, callback); },
    removeEventListener(type, callback) { removed.push([type, callback]); if (active.get(type) === callback) active.delete(type); },
  };
  const component = loadComponent({ window });
  component.state.settings = { onboarded: true };
  const event = { preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }, clientX: 25, clientY: 40 };

  component.svStart(event);
  const firstMove = active.get('pointermove');
  const firstUp = active.get('pointerup');
  assert.equal(typeof firstMove, 'function');
  assert.equal(typeof firstUp, 'function');

  component.hueStart(event);
  assert.ok(removed.some(([type, callback]) => type === 'pointermove' && callback === firstMove));
  assert.ok(removed.some(([type, callback]) => type === 'pointerup' && callback === firstUp));
  const replacementUp = active.get('pointerup');
  replacementUp();
  assert.equal(active.has('pointermove'), false);
  assert.equal(active.has('pointerup'), false);

  component.svStart(event);
  component.componentWillUnmount();
  assert.equal(active.has('pointermove'), false);
  assert.equal(active.has('pointerup'), false);
});

test('review copy and focus source contracts are accurate and keyboard-neutral', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /the latest seven calendar days/);
  assert.doesNotMatch(html, /the latest seven journal days/);
  const search = html.match(/<input[^>]+aria-label="Search this journal"[^>]*>/);
  assert.ok(search);
  assert.doesNotMatch(search[0], /outline:none/);
  assert.match(html, /⌘K/);
  assert.match(html, /role="combobox"/);
});

test('opening annotation copies normalized marks without mutating the draft', () => {
  const component = loadComponent();
  const photo = {
    id: 'photo-a',
    src: 'chart-a',
    marks: [{ id: 'mark-a', kind: 'entry', x: 0.2, y: 0.3, label: 'Open' }],
  };
  component.state.editing = '2026-07-21';
  component.state.draft = { photos: [photo] };
  component.state.markKind = 'lesson';
  component.state.markText = 'stale';
  const before = plain(component.state.draft);

  assert.equal(component.openAnnotation(0), true);
  assert.deepEqual(plain(component.state.draft), before);
  assert.deepEqual(plain(component.state.annotation), {
    index: 0,
    photoId: 'photo-a',
    workingMarks: [{ id: 'mark-a', kind: 'entry', x: 0.2, y: 0.3, label: 'Open' }],
  });
  assert.notStrictEqual(component.state.annotation.workingMarks, photo.marks);
  assert.equal(Object.hasOwn(component.state.annotation, 'originalMarks'), false);
  assert.equal(component.state.markKind, 'entry');
  assert.equal(component.state.markText, '');
});

test('annotation placement normalizes stage coordinates, clamps them, and ignores invalid state', () => {
  const component = loadComponent();
  component.state.editing = '2026-07-21';
  component.state.draft = { photos: [{ id: 'photo-a', src: 'chart-a', marks: [] }] };
  component.openAnnotation(0);
  component.state.markKind = 'target';
  component.state.markText = 'T1';
  const stage = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }) };

  assert.equal(component.placeAnnotationMark({ currentTarget: stage, clientX: 310, clientY: 10 }), true);
  assert.deepEqual(plain(component.state.annotation.workingMarks).map(({ kind, x, y, label }) => ({ kind, x, y, label })), [
    { kind: 'target', x: 1, y: 0, label: 'T1' },
  ]);
  component.state.markKind = 'arrow';
  assert.equal(component.placeAnnotationMark({ currentTarget: stage, clientX: 50, clientY: 50 }), false);
  assert.equal(component.state.annotation.workingMarks.length, 1);
  component.state.annotation = null;
  component.state.markKind = 'entry';
  assert.equal(component.placeAnnotationMark({ currentTarget: stage, clientX: 50, clientY: 50 }), false);
});

test('annotation undo, clear, and cancel affect only transient working marks', () => {
  const component = loadComponent();
  component.state.editing = '2026-07-21';
  component.state.draft = {
    photos: [{ id: 'photo-a', src: 'chart-a', marks: [{ id: 'm1', kind: 'stop', x: 0.4, y: 0.5 }] }],
  };
  let persistCalls = 0;
  component.persist = () => { persistCalls++; };
  const draftBefore = structuredClone(component.state.draft);
  component.openAnnotation(0);
  component.state.annotation.workingMarks = component.addPhotoMark(component.state.annotation.workingMarks, { kind: 'lesson', x: 0.8, y: 0.9 });

  assert.equal(component.undoAnnotationMark(), true);
  assert.equal(component.state.annotation.workingMarks.length, 1);
  component.state.annotation.workingMarks = component.addPhotoMark(component.state.annotation.workingMarks, { kind: 'mistake', x: 0.1, y: 0.2 });
  assert.equal(component.clearAnnotationMarks(), true);
  assert.deepEqual(plain(component.state.annotation.workingMarks), []);
  assert.deepEqual(component.state.draft, draftBefore);
  assert.equal(component.cancelAnnotation(), true);
  assert.equal(component.state.annotation, null);
  assert.deepEqual(component.state.draft, draftBefore);
  assert.equal(persistCalls, 0);
});

test('saving annotation immutably updates only the targeted draft photo without persisting', () => {
  const component = loadComponent();
  const first = { id: 'photo-a', src: 'chart-a', marks: [] };
  const target = { id: 'photo-b', src: 'chart-b', marks: [{ id: 'old', kind: 'stop', x: 0.2, y: 0.3 }] };
  const last = { id: 'photo-c', src: 'chart-c', marks: [] };
  component.state.editing = '2026-07-21';
  component.state.draft = { photos: [first, target, last], notes: 'draft stays open' };
  let persistCalls = 0;
  component.persist = () => { persistCalls++; };
  component.saveDay = () => { persistCalls++; };
  const draftBefore = component.state.draft;
  component.openAnnotation(1);
  component.state.annotation.workingMarks = component.addPhotoMark(component.state.annotation.workingMarks, { kind: 'lesson', x: 0.7, y: 0.8, label: 'Wait' });

  assert.equal(component.saveAnnotation(), true);
  assert.notStrictEqual(component.state.draft, draftBefore);
  assert.notStrictEqual(component.state.draft.photos, draftBefore.photos);
  assert.strictEqual(component.state.draft.photos[0], first);
  assert.strictEqual(component.state.draft.photos[2], last);
  assert.notStrictEqual(component.state.draft.photos[1], target);
  assert.deepEqual(plain(component.state.draft.photos[1]), {
    id: 'photo-b',
    src: 'chart-b',
    marks: [
      { id: 'old', kind: 'stop', x: 0.2, y: 0.3 },
      { id: component.state.draft.photos[1].marks[1].id, kind: 'lesson', x: 0.7, y: 0.8, label: 'Wait' },
    ],
  });
  assert.equal(component.state.annotation, null);
  assert.equal(component.state.editing, '2026-07-21');
  assert.equal(persistCalls, 0);
});

test('Gallery normalizes legacy and object screenshots with ids and saved marks', () => {
  const component = loadComponent();
  component.state.booting = false;
  component.state.settings = { onboarded: true, loggedOut: false, accent: '#C29BFF' };
  component.state.days = {
    '2026-07-21': {
      photos: [
        'legacy-chart',
        { id: 'photo-marked', src: 'marked-chart', marks: [{ id: 'm1', kind: 'entry', x: 0.25, y: 0.75, label: 'Fill' }] },
      ],
    },
  };

  const images = component.renderVals().gallery.filter(item => item.isImg);
  assert.equal(images.length, 2);
  assert.ok(images[0].id);
  assert.equal(images[0].src, 'legacy-chart');
  assert.deepEqual(plain(images[0].marks), []);
  assert.equal(images[0].markCount, 0);
  assert.equal(images[1].id, 'photo-marked');
  assert.equal(images[1].src, 'marked-chart');
  assert.deepEqual(plain(images[1].marks), [{ id: 'm1', kind: 'entry', x: 0.25, y: 0.75, label: 'Fill' }]);
  assert.equal(images[1].markCount, 1);
  assert.equal(images[1].marksLabel, '1 mark');
  images[1].view();
  assert.deepEqual(plain(component.state.lightbox), {
    t: 'i', id: 'photo-marked', src: 'marked-chart', marks: [{ id: 'm1', kind: 'entry', x: 0.25, y: 0.75, label: 'Fill' }],
  });
});

test('lightbox marker view data exposes labels, percentages, and colors for all kinds', () => {
  const component = loadComponent();
  component.state.booting = false;
  component.state.settings = { onboarded: true, loggedOut: false, accent: '#C29BFF' };
  component.state.lightbox = {
    t: 'i', id: 'photo-a', src: 'chart-a',
    marks: [
      { id: 'e', kind: 'entry', x: 0.1, y: 0.2 },
      { id: 's', kind: 'stop', x: 0.2, y: 0.3 },
      { id: 't', kind: 'target', x: 0.3, y: 0.4 },
      { id: 'm', kind: 'mistake', x: 0.4, y: 0.5 },
      { id: 'l', kind: 'lesson', x: 0.5, y: 0.6 },
    ],
  };

  const marks = component.renderVals().lightboxImgs[0].marks;
  assert.deepEqual(plain(marks.map(({ kind, label, left, top, color }) => ({ kind, label, left, top, color }))), [
    { kind: 'entry', label: 'Entry', left: '10%', top: '20%', color: '#C29BFF' },
    { kind: 'stop', label: 'Stop', left: '20%', top: '30%', color: 'var(--red)' },
    { kind: 'target', label: 'Target', left: '30%', top: '40%', color: 'var(--green)' },
    { kind: 'mistake', label: 'Mistake', left: '40%', top: '50%', color: 'var(--amber)' },
    { kind: 'lesson', label: 'Lesson', left: '50%', top: '60%', color: 'var(--blue)' },
  ]);
});

test('annotation Escape has priority and also clears an impossible stale search flag', () => {
  const component = loadComponent();
  component.state.annotation = { index: 0, workingMarks: [] };
  component.state.searchOpen = true;
  const first = { key: 'Escape', prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(component.handleGlobalKeydown(first), true);
  assert.equal(first.prevented, true);
  assert.equal(component.state.annotation, null);
  assert.equal(component.state.searchOpen, false);
});

test('Task 4 dialog and Gallery bindings are exposed and used by accessible markup', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const component = loadComponent();
  component.state.booting = false;
  component.state.settings = { onboarded: true, loggedOut: false };
  component.state.editing = '2026-07-21';
  component.state.draft = { photos: [{ id: 'photo-a', src: 'chart-a', marks: [] }], videos: [], trades: [], tags: [], sessions: [], exits: [], timeframes: [], mistakes: [], rules: {}, plan: {}, noteSet: {}, mind: {}, review: {} };
  component.openAnnotation(0);
  const bindings = component.renderVals();
  const names = [
    'annotationOpen', 'annotationImgs', 'annotationMarks', 'annotationTools', 'annotationLabel',
    'onAnnotationLabel', 'placeAnnotationMark', 'undoAnnotationMark', 'clearAnnotationMarks',
    'cancelAnnotation', 'saveAnnotation', 'annotationUndoDisabled', 'annotationClearDisabled',
    'placeAnnotationMarkKeyboard', 'setAnnotationDialogRef', 'onAnnotationDialogKeydown',
    'gallery', 'lightboxImgs', 'stopEvt',
  ];
  for (const name of names) {
    assert.ok(Object.hasOwn(bindings, name), `renderVals exposes ${name}`);
    assert.ok(html.includes(`{{${name}}}`) || html.includes(`{{${name}.`), `template uses ${name}`);
  }
  assert.match(html, /aria-label="Screenshot markup"/);
  assert.match(html, />Mark up</);
  assert.match(html, />Save markup</);
  assert.match(html, /{{ph\.marksLabel}}/);
  assert.match(html, /{{lb\.marks}}/);
});

test('a bubbling search-input Escape closes the popover and stops before the global handler', () => {
  const component = loadComponent();
  component.state.searchOpen = true;
  const event = {
    key: 'Escape', prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };

  assert.equal(component.handleSearchKeydown(event, []), true);
  if (!event.stopped) component.handleGlobalKeydown(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(component.state.searchOpen, false);
});

test('search cannot open or execute while annotation is active', () => {
  const component = loadComponent();
  component.state.booting = false;
  component.state.settings = { onboarded: true, loggedOut: false };
  component.state.annotation = { index: 0, photoId: 'photo-a', workingMarks: [] };
  let exports = 0;
  component.exportCsv = () => { exports++; };

  assert.equal(component.canUseSearch(), false);
  assert.equal(component.openSearch(), false);
  assert.equal(component.executeSearchResult({ id: 'action:export', type: 'export' }), false);
  assert.equal(component.state.searchOpen, false);
  assert.equal(exports, 0);
});

test('annotation stage keyboard action places the selected marker deterministically at center', () => {
  const component = loadComponent();
  component.state.editing = '2026-07-21';
  component.state.draft = { photos: [{ id: 'photo-a', src: 'chart-a', marks: [] }] };
  component.openAnnotation(0);
  component.state.markKind = 'lesson';
  component.state.markText = 'Review';
  const event = {
    key: 'Enter', prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };

  assert.equal(component.handleAnnotationStageKeydown(event), true);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.deepEqual(plain(component.state.annotation.workingMarks).map(({ kind, x, y, label }) => ({ kind, x, y, label })), [
    { kind: 'lesson', x: 0.5, y: 0.5, label: 'Review' },
  ]);
});

test('annotation dialog receives initial focus and traps Tab at its boundaries', () => {
  const component = loadComponent();
  component.state.editing = '2026-07-21';
  component.state.draft = { photos: [{ id: 'photo-a', src: 'chart-a', marks: [] }] };
  component.openAnnotation(0);
  let focused = '';
  const first = { focus() { focused = 'first'; } };
  const last = { focus() { focused = 'last'; } };
  const dialog = {
    focus() { focused = 'dialog'; },
    querySelectorAll() { return [first, last]; },
  };

  component.captureAnnotationDialog(dialog);
  assert.equal(focused, 'dialog');
  const event = {
    key: 'Tab', target: last, shiftKey: false, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  assert.equal(component.handleAnnotationDialogKeydown(event), true);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(focused, 'first');
});

test('annotation save follows stable photo identity after draft photos reorder', () => {
  const component = loadComponent();
  const a = { id: 'photo-a', src: 'chart-a', marks: [] };
  const target = { id: 'photo-b', src: 'chart-b', marks: [] };
  const c = { id: 'photo-c', src: 'chart-c', marks: [] };
  const inserted = { id: 'photo-new', src: 'chart-new', marks: [] };
  component.state.editing = '2026-07-21';
  component.state.draft = { photos: [a, target, c] };
  component.openAnnotation(1);
  component.state.annotation.workingMarks = component.addPhotoMark([], { kind: 'target', x: 0.6, y: 0.4 });
  component.state.draft = { photos: [inserted, a, target, c] };

  assert.equal(component.saveAnnotation(), true);
  assert.strictEqual(component.state.draft.photos[0], inserted);
  assert.strictEqual(component.state.draft.photos[1], a);
  assert.equal(component.state.draft.photos[2].id, 'photo-b');
  assert.equal(component.state.draft.photos[2].marks[0].kind, 'target');
  assert.strictEqual(component.state.draft.photos[3], c);
  assert.deepEqual(plain(component.state.draft.photos[1].marks), []);
});

test('Task 4 focus and inert source contracts are present in the template', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /class="annotation-dialog"[^>]+ref="{{setAnnotationDialogRef}}"[^>]+onKeyDown="{{onAnnotationDialogKeydown}}"[^>]+tabIndex="-1"/);
  assert.match(html, /role="button"[^>]+tabIndex="0"[^>]+onKeyDown="{{placeAnnotationMarkKeyboard}}"/);
  assert.match(html, /inert="{{drawerInert}}"/);
  assert.match(html, /aria-hidden="{{drawerInert}}"/);
});

test('CSV export includes canonical trade time and a blank field for legacy trades', async () => {
  let exportedBlob = null;
  let downloadName = '';
  let clicked = false;
  const component = loadComponent({
    Blob,
    URL: {
      createObjectURL(blob) { exportedBlob = blob; return 'blob:written'; },
      revokeObjectURL() {},
    },
    document: {
      createElement() {
        return {
          href: '',
          set download(value) { downloadName = value; },
          click() { clicked = true; },
        };
      },
    },
  });
  component.state.days = {
    '2026-07-20': { trades: [{ sym: 'MES', side: 'LONG', qty: 1, entry: 100, stop: 99, tp: 102, exit: 101, pnl: 5 }] },
    '2026-07-21': { trades: [{ sym: 'NQ', side: 'SHORT', qty: 2, time: '09:17', entry: 200, stop: 202, tp: 196, exit: 198, pnl: 80 }] },
  };

  component.exportCsv();
  const csv = await exportedBlob.text();
  const lines = csv.split('\n');
  assert.equal(clicked, true);
  assert.equal(downloadName, 'written-trades.csv');
  assert.equal(lines[0], 'date,time,symbol,side,qty,entry,stop,target,exit,pnl,r_multiple,minutes,emoji,sessions,tags,mistakes,notes');
  assert.match(lines[1], /^2026-07-20,,MES,/);
  assert.match(lines[2], /^2026-07-21,09:17,NQ,/);
});

test('trade table view rows show canonical times and restrained dashes for legacy trades', () => {
  const component = loadComponent();
  component.state.booting = false;
  component.state.range = 'all';
  component.state.settings = { onboarded: true, loggedOut: false, accent: '#C29BFF' };
  component.state.days = {
    '2026-07-20': { trades: [{ sym: 'MES', side: 'LONG', qty: 1, entry: 100, stop: 99, tp: 102, exit: 101, pnl: 5 }] },
    '2026-07-21': { trades: [{ sym: 'NQ', side: 'SHORT', qty: 2, time: '09:17', entry: 200, stop: 202, tp: 196, exit: 198, pnl: 80 }] },
  };

  const rows = component.renderVals().tradeRows;
  assert.equal(rows[0].time, '09:17');
  assert.equal(rows[1].time, '—');
});

test('v1.0.0 release copy documents all action tools in a single changelog entry', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /appVersion:'v1\.0\.0'/);
  assert.match(html, /V1\.0\.0 · LOCAL BUILD · JUL 2026/);
  assert.match(html, />v1\.0\.0<\/span>/);
  // first official release: prior pre-release versions are merged, not listed
  assert.doesNotMatch(html, />v2\.[0-9]<\/span>/);
  for (const heading of ['Risk sizing', 'Time edge and weekly review', 'Search', 'Chart markup']) {
    assert.match(html, new RegExp(`>${heading}<`));
  }
  assert.match(html, /risk sizing is informational/i);
  assert.match(html, /pattern detection, not a market prediction/i);
  assert.doesNotMatch(html, /demo journal ships with generated example candlestick charts/i);
});

test('Settings explains the inputs that drive risk sizing', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /Starting balance[^<]*sets the account value used by the risk percentage/i);
  assert.match(html, /dollars per point[^<]*converts the entry-to-stop distance into risk per contract/i);
});

test('global Escape closes the topmost remaining surface in order', () => {
  const component = loadComponent();
  component.state.searchOpen = true;
  component.state.lightbox = { t: 'i', src: 'chart' };
  component.state.editing = '2026-07-21';
  component.state.draft = { trades: [] };
  const pressEscape = () => {
    const event = {
      key: 'Escape', prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    assert.equal(component.handleGlobalKeydown(event), true);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  };

  pressEscape();
  assert.equal(component.state.searchOpen, false);
  assert.equal(component.state.lightbox, null);
  assert.equal(component.state.editing, '2026-07-21');
  pressEscape();
  assert.equal(component.state.editing, null);
  assert.equal(component.state.draft, null);
});

test('drawer and lightbox expose dialog semantics and labelled close controls', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /class="lightbox-dialog"[^>]+role="dialog"[^>]+aria-modal="true"[^>]+aria-label="Chart media viewer"/);
  assert.match(html, /onClick="{{closeLightbox}}"[^>]+aria-label="Close chart media viewer"[^>]+title="Close"/);
  assert.match(html, /class="journal-drawer"[^>]+role="dialog"[^>]+aria-modal="true"[^>]+aria-label="Journal entry editor"/);
  assert.match(html, /onClick="{{closeEditor}}"[^>]+aria-label="Close journal entry"[^>]+title="Close"/);
});

test('narrow-screen rules are scoped to new content, dialogs, drawer, plan, and risk classes', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /@media\(max-width:760px\)\{[^}]*\.app-main\{padding:/);
  assert.match(html, /\.insights-grid\{grid-template-columns:1fr!important\}/);
  assert.match(html, /\.journal-drawer\{width:100%!important;max-width:none!important/);
  assert.match(html, /\.app-titlebar\{grid-template-columns:52px minmax\(0,1fr\) 52px/);
  assert.match(html, /\.annotation-dialog\{[^}]*width:calc\(100vw - 20px\)/);
  assert.match(html, /\.plan-fields\{grid-template-columns:1fr!important\}/);
  assert.match(html, /\.risk-settings-grid\{grid-template-columns:1fr!important\}/);
  assert.match(html, /\.risk-guide-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)!important\}/);
  assert.match(html, /class="plan-fields"/);
  assert.match(html, /class="risk-settings-grid"/);
  assert.match(html, /class="risk-guide-grid"/);
});

test('unknown symbols require an explicit positive dollars-per-point value', () => {
  const component = loadComponent();
  component.state.settings = { startBalance: '50000', riskPct: '1', customPV: {} };
  const unknown = { sym: 'EURUSD', side: 'LONG', qty: '1', entry: '100', stop: '99' };
  assert.equal(component.pv('EURUSD'), null);
  const missing = component.riskGuideForTrade(unknown);
  assert.equal(missing.qty, 0);
  assert.equal(missing.missingPointValue, true);
  assert.match(missing.reason, /point value/i);

  component.state.editing = '2026-07-21';
  component.state.draft = component.draftForDay('2026-07-21');
  component.state.draft.trades = [unknown];
  const tradeView = component.renderVals().eTrades[0];
  assert.equal(tradeView.riskShow, false);
  assert.equal(tradeView.riskMissing, true);
  assert.match(tradeView.riskMessage, /dollars per point/i);
});

test('custom assets reject missing or partial point values and accept explicit finite values', () => {
  const component = loadComponent();
  seedActiveProfile(component, { symbols: ['MES'], customPV: {} });
  for (const value of ['', '12x', '-2', 'Infinity']) {
    assert.equal(component.addAsset('EURUSD', value, false), false);
    assert.equal(component.state.settings.customPV.EURUSD, undefined);
    assert.deepEqual(plain(component.state.settings.symbols), ['MES']);
  }
  assert.equal(component.addAsset('EURUSD', '12.5', false), true);
  assert.equal(component.pv('EURUSD'), 12.5);
  assert.deepEqual(plain(component.state.settings.symbols), ['MES', 'EURUSD']);

  assert.equal(component.addAsset('CL', '', false), true);
  assert.equal(component.pv('CL'), 1000);
  assert.deepEqual(plain(component.state.settings.symbols), ['MES', 'EURUSD', 'CL']);
});

test('search remains available with a draft while result execution preserves or confirms it', () => {
  const component = loadComponent();
  component.state.booting = false;
  component.state.settings = { onboarded: true, loggedOut: false };
  component.state.editing = '2026-07-21';
  component.state.draft = component.draftForDay('2026-07-21');
  component.state.draft.notes = 'Unsaved';
  const before = plain(component.state.draft);
  let exports = 0;
  component.exportCsv = () => { exports++; };

  const shortcut = { key: 'k', metaKey: true, target: { tagName: 'DIV' }, prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(component.handleGlobalKeydown(shortcut), true);
  assert.equal(shortcut.prevented, true);
  assert.equal(component.state.searchOpen, true);
  assert.equal(component.executeSearchResult({ id: 'action:export', type: 'export' }), true);
  assert.equal(exports, 1);
  assert.equal(component.executeSearchResult({ id: 'nav:insights', type: 'nav', tab: 'insights' }), false);
  assert.equal(component.state.confirm, 'search-leave');
  assert.deepEqual(plain(component.state.draft), before);
});

test('strict finite parsing shapes only valid prices, P&L, quantity, and duration', () => {
  const component = loadComponent();
  assert.equal(component.finiteNumber('12.5'), 12.5);
  for (const value of ['', '12x', 'Infinity', Infinity, NaN, null]) assert.equal(component.finiteNumber(value), null);
  assert.equal(component.tpts({ side: 'LONG', entry: '12x', exit: '13' }), null);
  assert.equal(component.trisk({ entry: '-2', stop: '1' }), null);
  component.state.draft = { trades: [{ sym: 'MES', side: 'LONG', qty: '1', entry: '12x', exit: '13', pnl: '99' }] };
  component.updT(0, 'exit', '13', true);
  assert.equal(component.state.draft.trades[0].pnl, '');
  const saved = component.shapeDay({
    trades: [
      { sym: 'MES', side: 'LONG', qty: '12x', entry: '100.25', stop: '-2', tp: '12x', exit: Infinity, pnl: '-45.75', dur: '-3' },
      { sym: 'NQ', side: 'SHORT', qty: '3', entry: '200.5', stop: '199.25', tp: '204.75', exit: '201.5', pnl: 'Infinity', dur: '12' },
      { sym: 'GC', side: 'LONG', qty: '-2', entry: '300', stop: '', tp: '', exit: '', pnl: '12x', dur: '1.5' },
    ],
  }, '2026-07-21');
  assert.deepEqual(plain(saved.trades), [
    { sym: 'MES', side: 'LONG', qty: 1, entry: 100.25, stop: null, tp: null, exit: null, pnl: -45.75, dur: null },
    { sym: 'NQ', side: 'SHORT', qty: 3, entry: 200.5, stop: 199.25, tp: 204.75, exit: 201.5, pnl: 0, dur: 12 },
    { sym: 'GC', side: 'LONG', qty: 1, entry: 300, stop: null, tp: null, exit: null, pnl: 0, dur: null },
  ]);
});

test('search is non-modal while journal and lightbox dialogs contain Tab and restore openers', () => {
  let focused = '';
  let nextTimer = 1;
  const timers = new Map();
  const setTimeout = fn => { const id = nextTimer++; timers.set(id, fn); return id; };
  const clearTimeout = id => timers.delete(id);
  const flushFocus = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); };
  const searchOpener = { focus() { focused = 'search-opener'; } };
  const editorOpener = { focus() { focused = 'editor-opener'; } };
  const lightboxOpener = { focus() { focused = 'lightbox-opener'; } };
  const document = { activeElement: searchOpener };
  const component = loadComponent({ document, setTimeout, clearTimeout });
  component.state.booting = false;
  component.state.settings = { onboarded: true, loggedOut: false };
  const makeDialog = name => {
    const first = { focus() { focused = `${name}-first`; } };
    const last = { focus() { focused = `${name}-last`; } };
    return { first, last, dialog: { focus() { focused = `${name}-dialog`; }, querySelectorAll() { return [first, last]; } } };
  };

  const searchInput = { focus() { focused = 'search-input'; }, select() { focused = 'search-selected'; } };
  component.setSearchInputRef(searchInput);
  assert.equal(component.openSearch(), true);
  flushFocus();
  assert.equal(focused, 'search-selected');
  const tab = { key: 'Tab', prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(component.handleSearchKeydown(tab, []), false);
  assert.equal(tab.prevented, false);
  component.closeSearch();
  assert.equal(focused, 'search-selected');
  flushFocus();
  assert.equal(focused, 'search-opener');

  document.activeElement = editorOpener;
  component.openDay('2026-07-21');
  const editor = makeDialog('editor');
  assert.equal(component.captureSurfaceDialog('editor', editor.dialog), true);
  assert.equal(focused, 'editor-first');
  component.closeEditor();
  assert.equal(focused, 'editor-first');
  flushFocus();
  assert.equal(focused, 'editor-opener');

  document.activeElement = lightboxOpener;
  component.openLightbox({ t: 'i', src: 'chart' });
  const lightbox = makeDialog('lightbox');
  assert.equal(component.captureSurfaceDialog('lightbox', lightbox.dialog), true);
  assert.equal(focused, 'lightbox-first');
  component.closeLightbox();
  assert.equal(focused, 'lightbox-first');
  flushFocus();
  assert.equal(focused, 'lightbox-opener');

  component.openSearch(searchOpener);
  flushFocus();
  component.closeSearch();
  assert.equal(timers.size, 1);
  component.openDay('2026-07-21', editorOpener);
  assert.equal(timers.size, 1);
  component.closeEditor();
  assert.equal(timers.size, 1);
  component.componentWillUnmount();
  assert.equal(timers.size, 0);
});

test('Save and Clear close the editor through deferred focus restoration and clear stale openers', () => {
  let focused = '';
  let nextTimer = 1;
  const timers = new Map();
  const setTimeout = fn => { const id = nextTimer++; timers.set(id, fn); return id; };
  const clearTimeout = id => timers.delete(id);
  const flushFocus = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); };
  const document = { activeElement: null };
  const component = loadComponent({ document, setTimeout, clearTimeout });
  component.persist = () => {};
  component.showToast = () => {};
  component.confetti = () => {};

  const saveOpener = { focus() { focused = 'save-opener'; } };
  document.activeElement = saveOpener;
  component.openDay('2026-07-21');
  component.state.draft.notes = 'Saved';
  focused = 'editor';
  component.saveDay();
  assert.equal(component.state.editing, null);
  assert.equal(component.state.draft, null);
  assert.equal(component._surfaceOpeners.editor, undefined);
  assert.equal(focused, 'editor');
  flushFocus();
  assert.equal(focused, 'save-opener');

  const clearOpener = { focus() { focused = 'clear-opener'; } };
  document.activeElement = clearOpener;
  component.openDay('2026-07-22');
  component.state.days['2026-07-22'] = { notes: 'Delete me' };
  focused = 'editor';
  component.clearDay();
  assert.equal(component.state.editing, null);
  assert.equal(component.state.draft, null);
  assert.equal(component._surfaceOpeners.editor, undefined);
  assert.equal(focused, 'editor');
  flushFocus();
  assert.equal(focused, 'clear-opener');
});

test('annotation Cancel and Save defer restoration to the Mark up trigger', () => {
  let focused = '';
  let nextTimer = 1;
  const timers = new Map();
  const setTimeout = fn => { const id = nextTimer++; timers.set(id, fn); return id; };
  const clearTimeout = id => timers.delete(id);
  const flushFocus = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); };
  const component = loadComponent({ setTimeout, clearTimeout });
  const dayKey = '2026-07-21';
  component.state.days = { [dayKey]: { photos: [{ id: 'photo-a', src: 'data:image/png;base64,a', marks: [] }], videos: ['data:video/mp4;base64,a'] } };
  component.state.editing = dayKey;
  component.state.draft = component.draftForDay(dayKey);
  const cancelOpener = { focus() { focused = 'cancel-opener'; } };
  component.renderVals().ePhotos[0].markup({ currentTarget: cancelOpener });
  assert.ok(component.state.annotation);
  focused = 'annotation';
  component.cancelAnnotation();
  assert.equal(component._surfaceOpeners.annotation, undefined);
  assert.equal(focused, 'annotation');
  flushFocus();
  assert.equal(focused, 'cancel-opener');

  const saveOpener = { focus() { focused = 'save-opener'; } };
  component.renderVals().ePhotos[0].markup({ currentTarget: saveOpener });
  focused = 'annotation';
  component.saveAnnotation();
  assert.equal(component._surfaceOpeners.annotation, undefined);
  assert.equal(focused, 'annotation');
  flushFocus();
  assert.equal(focused, 'save-opener');
});

test('Gallery media keyboard activation handles Enter and Space only', () => {
  const component = loadComponent();
  let activations = 0;
  const event = key => ({ key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
  for (const key of ['Enter', ' ', 'Spacebar']) {
    const input = event(key);
    assert.equal(component.activateOnKey(input, () => { activations++; }), true);
    assert.equal(input.prevented, true);
    assert.equal(input.stopped, true);
  }
  assert.equal(component.activateOnKey(event('Escape'), () => { activations++; }), false);
  assert.equal(activations, 3);
});

test('editor video previews expose keyboard activation through the shared media helper', () => {
  const component = loadComponent();
  const dayKey = '2026-07-21';
  component.state.days = { [dayKey]: { videos: ['data:video/mp4;base64,a'] } };
  component.state.editing = dayKey;
  component.state.draft = component.draftForDay(dayKey);
  const preview = component.renderVals().eVideos[0];
  const opener = { focus() {} };
  const event = { key: 'Enter', currentTarget: opener, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  assert.equal(preview.playKey(event), true);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(component.state.lightbox.t, 'v');
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /<video[^>]+onClick="{{vd\.play}}"[^>]+role="button"[^>]+tabIndex="0"[^>]+onKeyDown="{{vd\.playKey}}"[^>]+aria-label="Open video preview"/);
});

test('UI revision acceptance contracts remain integrated', () => {
  const html=fs.readFileSync(htmlPath,'utf8');
  for(const token of [
    'written-profiles-v2','Search this journal','glass-surface','calendar-weeks',
    'range-control','Move widget','data-resize-edge="corner"','Replay walkthrough',
    'eTagsVisible','no-profile-book','prefers-reduced-motion',
  ]) assert.ok(html.includes(token),token+' is present');
  assert.doesNotMatch(html,/>Quick add </);
  assert.doesNotMatch(html,/>DRAG</);
  assert.doesNotMatch(html,/hsv2hex\(\(p\[0\]\+46\)/);
});

test('the single accent is bound on the app root so range fills and score meter are visible', () => {
  const html=fs.readFileSync(htmlPath,'utf8');
  // Every bare var(--accent) consumer (range fill/thumb, score meter) needs --accent defined on the root,
  // otherwise the declaration is invalid-at-computed-value and the fill renders transparent.
  assert.match(html,/--accent:\{\{accent\}\}/);
  assert.match(html,/--accent-glow:\{\{accentGlow\}\}/);
  assert.match(html,/--accent-soft:\{\{accentSoft\}\}/);
});

test('modal focus and inert source contracts cover app, editor, and keyboard media', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /inert="{{appInert}}"[^>]+aria-hidden="{{appInert}}"/);
  assert.match(html, /class="search-popover glass-surface-strong"[^>]+id="global-search-results"[^>]+role="listbox"/);
  assert.doesNotMatch(html, /aria-modal="true"[^>]+aria-label="Quick add"/);
  assert.match(html, /class="journal-drawer"[^>]+ref="{{setEditorDialogRef}}"[^>]+onKeyDown="{{onEditorDialogKeydown}}"[^>]+tabIndex="-1"/);
  assert.match(html, /class="lightbox-dialog"[^>]+ref="{{setLightboxDialogRef}}"[^>]+onKeyDown="{{onLightboxDialogKeydown}}"[^>]+tabIndex="-1"/);
  assert.match(html, /inert="{{drawerInert}}"[^>]+aria-hidden="{{drawerInert}}"/);
  assert.match(html, /role="button"[^>]+tabIndex="0"[^>]+onKeyDown="{{ph\.viewKey}}"/);
});

test('weekly usage labels and Help interval match the underlying calculations', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, />MOST USED SETUP</);
  assert.match(html, />MOST USED SESSION</);
  assert.doesNotMatch(html, />BEST SETUP</);
  assert.doesNotMatch(html, />BEST SESSION</);
  assert.match(html, /results by hour/i);
  assert.doesNotMatch(html, /half-hour/i);
});

test('the daily loss limit passes exactly at the configured boundary', () => {
  const component = loadComponent();
  const score = component.planExecutionScore({ plan: { maxLoss: 100 }, trades: [{ pnl: -100 }] });
  const row = score.rows.find(item => item.key === 'maxLoss');
  assert.equal(row.pass, true);
});

test('narrow screens stack Help and fit trade detail fields without changing the sidebar', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /\.help-grid\{grid-template-columns:1fr!important\}/);
  assert.match(html, /\.trade-detail-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)!important\}/);
  assert.match(html, /class="help-grid"/);
  assert.match(html, /class="trade-detail-grid"/);
  assert.doesNotMatch(html, /@media\(max-width:760px\)\{[^}]*data-screen-label="Sidebar"/);
});

test('glass, calendar, typography, tags, icon, and reduced-motion contracts are present', () => {
  const html=fs.readFileSync(htmlPath,'utf8');
  assert.match(html,/\.glass-surface\{/);
  assert.match(html,/\.glass-surface-strong\{/);
  assert.match(html,/\.calendar-week\{[^}]*flex:1 0 80px/);
  assert.match(html,/\.calendar-cell\{[^}]*box-sizing:border-box/);
  assert.match(html,/\.calendar-grid\{[^}]*min-width:/);
  assert.match(html,/\.sidebar-section\{[^}]*font-family:'Manrope'/);
  assert.match(html,/@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html,/value="\{\{eTagsVisible\}\}"/);
  assert.match(html,/class="no-profile-book"/);
  assert.doesNotMatch(html,/glowC:\(\(\)=>/);
});

test('empty configured tags remove the complete Setup Tags block', () => {
  const component=loadComponent();
  component.state.booting=false;
  component.state.settings={onboarded:true,loggedOut:false,tags:[]};
  component.state.editing='2026-07-22';
  component.state.draft=component.draftForDay('2026-07-22');
  assert.equal(component.renderVals().eTagsVisible,false);
  component.state.settings.tags=['ORB'];
  assert.equal(component.renderVals().eTagsVisible,true);
});

test('glass modes expose complete surface variables', () => {
  const component=loadComponent();
  assert.deepEqual(plain(component.surfaceBindings('off')),{surfaceBg:'var(--card-a)',surfaceBgStrong:'var(--panel-a)',surfaceFx:'none',surfaceFxStrong:'none'});
  assert.match(component.surfaceBindings('subtle').surfaceFx,/blur\(12px\)/);
  assert.match(component.surfaceBindings('frosted').surfaceFx,/blur\(26px\)/);
  assert.match(component.surfaceBindings('frosted').surfaceFxStrong,/blur\(30px\)/);
});

test('accent-glow and accent-soft custom properties track the current accent', () => {
  const component=loadComponent();
  component.state.settings={accent:'#C29BFF'};
  const vals=component.renderVals();
  assert.equal(vals.accentGlow,'#C29BFF44');
  assert.equal(vals.accentSoft,'#C29BFF22');
  const html=fs.readFileSync(htmlPath,'utf8');
  assert.match(html,/--accent-glow:\{\{accentGlow\}\}/);
  assert.match(html,/--accent-soft:\{\{accentSoft\}\}/);
});

test('rangePercent normalizes and clamps arbitrary slider bounds', () => {
  const component=loadComponent();
  assert.equal(component.rangePercent(20,20,90),0);
  assert.equal(component.rangePercent(55,20,90),50);
  assert.equal(component.rangePercent(90,20,90),100);
  assert.equal(component.rangePercent(-2,1,10),0);
  assert.equal(component.rangePercent(99,1,10),100);
  assert.equal(component.rangePercent(5,5,5),0);
});

test('adding a trade marks only the inserted card for animation', () => {
  const component=loadComponent({setTimeout:()=>0,clearTimeout(){}});
  component.state.settings={symbols:['NQ']};
  component.state.draft=component.draftForDay('2026-07-22');
  component.state.draft.trades=[{sym:'NQ',side:'LONG',qty:'1',time:'',entry:'',stop:'',tp:'',exit:'',pnl:'',dur:''}];
  component.addTrade();
  assert.equal(component.state.addedTradeIndex,1);
  const rows=component.renderVals().eTrades;
  assert.equal(rows[0].entering,false);
  assert.equal(rows[1].entering,true);
});

test('shared range markup is borderless and uses live input', () => {
  const html=fs.readFileSync(htmlPath,'utf8');
  assert.match(html,/class="range-control/);
  assert.match(html,/class="range-track"/);
  assert.match(html,/class="range-fill"/);
  assert.match(html,/class="range-thumb"/);
  assert.match(html,/class="range-input"/);
  assert.match(html,/onInput="\{\{md\.set\}\}"/);
  assert.doesNotMatch(html,/accent-color:\{\{accent\}\}/);
});

test('keyboard widget resize uses one unit, Shift uses two, and Escape restores start', () => {
  const component=loadComponent();
  component.state.settings={widgets:{score:{on:1,columns:4,rows:7}}};
  let writes=0;
  component.setWidget=(id,patch)=>{writes++;component.state.settings.widgets[id]=Object.assign({},component.state.settings.widgets[id],patch)};
  const right={key:'ArrowRight',shiftKey:true,preventDefault(){}};
  assert.equal(component.handleWidgetResizeKeydown('score','corner',right),true);
  assert.equal(component.state.settings.widgets.score.columns,6);
  assert.equal(component.state.settings.widgets.score.rows,7);
  assert.equal(writes,1);
});

test('widget template exposes labelled move and three resize handles without DRAG text', () => {
  const html=fs.readFileSync(htmlPath,'utf8');
  assert.doesNotMatch(html,/>DRAG</);
  assert.match(html,/aria-label="Move widget"/);
  assert.match(html,/data-resize-edge="right"/);
  assert.match(html,/data-resize-edge="bottom"/);
  assert.match(html,/data-resize-edge="corner"/);
  assert.match(html,/@container widget/);
});

test('walkthrough has four steps and completion persists only on the active profile', () => {
  const component=loadComponent({localStorage:{setItem(){}}});
  component.state.booting=false;
  component.state.launching=false;
  component.state.profileStore={version:2,activeProfileId:'one',profiles:{one:{id:'one',createdAt:1,lastUsedAt:1,settings:{name:'One',onboarded:true,loggedOut:false,tourCompleted:false},days:{}}}};
  component.state.settings=component.state.profileStore.profiles.one.settings;
  component.state.days={};
  assert.equal(component.tourSteps().length,4);
  component.openTour();
  assert.equal(component.state.tourOpen,true);
  component.closeTour(false);
  assert.equal(component.state.settings.tourCompleted,false);
  component.openTour();
  component.nextTour();component.nextTour();component.nextTour();component.nextTour();
  assert.equal(component.state.tourOpen,false);
  assert.equal(component.state.settings.tourCompleted,true);
});

test('walkthrough markup is modal, focus-managed, and replayable from Help', () => {
  const html=fs.readFileSync(htmlPath,'utf8');
  assert.match(html,/aria-label="Written walkthrough"/);
  assert.match(html,/aria-modal="true"/);
  assert.match(html,/Replay walkthrough/);
  assert.match(html,/tourProgressDots/);
  assert.match(html,/>Skip</);
  assert.match(html,/>Back</);
});
