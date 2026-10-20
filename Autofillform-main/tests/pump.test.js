/* Mô phỏng logic pump() để kiểm tra race condition & index (JTBD C2) */
const MAX_CONCURRENT_TABS = 10;

function simulate(total, aiDelayMs, concurrency=1) {
  const state = {
    isRunning: true, isPumping: false, resolvingCount: 0, nextIndex: 0,
    queue: Array.from({length: total}, (_, i) => i),
    activeTabs: new Map(), stats: {success:0, failed:0}, log: [],
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function pump() {
    if (!state.isRunning || state.isPumping) return;
    state.isPumping = true;
    try {
      while (state.isRunning &&
             (state.activeTabs.size + state.resolvingCount) < MAX_CONCURRENT_TABS &&
             state.queue.length > 0) {
        const raw = state.queue.shift();
        const index = ++state.nextIndex;
        state.resolvingCount++;
        let resolved;
        try { resolved = await sleep(aiDelayMs).then(() => raw); }
        finally { state.resolvingCount = Math.max(0, state.resolvingCount - 1); }
        if (!state.isRunning) { state.queue.unshift(raw); state.nextIndex--; return; }
        const tabId = 1000 + index;
        state.activeTabs.set(tabId, {index});
        state.log.push(index);
      }
    } finally { state.isPumping = false; }
  }
  return {state, pump};
}

(async () => {
  const assert = require('assert');
  // 25 forms, AI chậm 50ms
  const {state, pump} = simulate(25, 50);
  await pump();
  assert.strictEqual(state.activeTabs.size, 10, 'phai dung 10 tab');
  assert.deepStrictEqual(state.log, [1,2,3,4,5,6,7,8,9,10], 'index tu 1..10 khong trung/nhay coc');
  assert.strictEqual(state.nextIndex, 10);
  console.log('C2 OK: 10 tab, index lien tu', state.log.join(','));

  // index khong trung khi nhieu luong pump chay song song
  const s2 = {
    isRunning: true, isPumping: false, resolvingCount: 0, nextIndex: 0,
    queue: Array.from({length: 25}, (_, i) => i), activeTabs: new Map(), log: [],
  };
  const sleep2 = (ms)=>new Promise(r=>setTimeout(r,ms));
  async function pump2() {
    if (!s2.isRunning || s2.isPumping) return;
    s2.isPumping = true;
    try {
      while (s2.isRunning && (s2.activeTabs.size + s2.resolvingCount) < MAX_CONCURRENT_TABS && s2.queue.length > 0) {
        const raw = s2.queue.shift();
        const index = ++s2.nextIndex;
        s2.resolvingCount++;
        await sleep2(20);
        s2.resolvingCount--;
        s2.activeTabs.set(1000+index, {index});
        s2.log.push(index);
      }
    } finally { s2.isPumping = false; }
  }
  // chay 5 luong pump dong thoi
  await Promise.all([pump2(),pump2(),pump2(),pump2(),pump2()]);
  assert.ok(s2.activeTabs.size <= 10, 'khong vuot 10 tab');
  assert.strictEqual(new Set(s2.log).size, s2.log.length, 'index khong trung');
  console.log('C2 OK (race): tab=', s2.activeTabs.size, 'index=', s2.log.join(','));
  console.log('\nALL PUMP TESTS PASSED');
})();
