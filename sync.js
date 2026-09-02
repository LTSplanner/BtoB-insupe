/* ============================================================
   複数端末でデータを共有する（Firestore）
   ------------------------------------------------------------
   ・オフラインでもそのまま使えます。書いた内容は端末に貯まり、
     つながったときに自動で送られます（Firestoreのオフライン機能）
   ・window.FIREBASE_CONFIG が null のあいだは、これまでどおり
     「この端末だけ」で動きます
   ============================================================ */
const SDK = 'https://www.gstatic.com/firebasejs/11.6.1/';
const CFG = window.FIREBASE_CONFIG;
const ORG = window.SYNC_ORG || 'lts';
const COLLS = ['members', 'properties', 'assignments', 'offs'];

const app = window.__app;
const tagEl = () => document.getElementById('syncTag');

let state = {
  on: false,          // 同期が有効か
  user: null,         // ログイン中の人
  admins: [],         // 許可されている人のメール
  msg: 'この端末だけ',
  err: ''
};

function status(msg, err) {
  state.msg = msg;
  state.err = err || '';
  const el = tagEl();
  if (el) {
    el.textContent = msg;
    el.style.background = err ? '#7c2d12' : (state.user ? '#065f46' : '#374151');
    el.hidden = false;
  }
  renderPanel();
}

/* ---- 設定が無いときは、これまでどおり端末だけで動く ---- */
if (!CFG || !CFG.apiKey) {
  window.SYNC = { enabled: false, push() {}, renderPanel, state };
  status('この端末だけ');
} else {
  start().catch(e => { console.warn(e); status('同期できません', String(e.message || e)); });
}

async function start() {
  status('接続中…');
  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js')
  ]);

  const fbApp = initializeApp(CFG);
  const auth = authMod.getAuth(fbApp);
  await authMod.setPersistence(auth, authMod.browserLocalPersistence);

  /* 端末の中にデータを持つ＝オフラインでも読めて、書いた内容も貯められる */
  const db = fsMod.initializeFirestore(fbApp, {
    localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() })
  });

  const api = { auth, db, ...authMod, ...fsMod };
  window.SYNC = {
    enabled: true,
    push: (S) => push(api, S),
    renderPanel,
    state,
    login: () => login(api),
    logout: () => api.signOut(auth),
    addAdmin: (mail) => addAdmin(api, mail),
    removeAdmin: (mail) => removeAdmin(api, mail),
    upload: () => upload(api)
  };

  /* スマホでポップアップが閉じられたときの戻り先 */
  api.getRedirectResult(auth).catch(() => {});

  api.onAuthStateChanged(auth, async (u) => {
    state.user = u ? { email: u.email, name: u.displayName || u.email } : null;
    stopWatching();
    if (!u) { status('ログインしてください'); return; }
    status('確認中…');
    try {
      const snap = await api.getDoc(api.doc(db, 'config', 'admins'));
      state.admins = (snap.exists() && snap.data().emails) || [];
    } catch (e) {
      /* オフラインでキャッシュにも無い場合。読めなくても同期は試みる */
      state.admins = [];
    }
    if (state.admins.length && !state.admins.includes(u.email)) {
      status('このアカウントには権限がありません', u.email);
      return;
    }
    state.on = true;
    watch(api);
    status(navigator.onLine ? '同期中' : 'オフライン（あとで同期）');
  });

  window.addEventListener('online', () => { if (state.on) status('同期中'); });
  window.addEventListener('offline', () => { if (state.on) status('オフライン（あとで同期）'); });
}

async function login(api) {
  try {
    await api.signInWithPopup(api.auth, new api.GoogleAuthProvider());
  } catch (e) {
    /* スマホやPWAではポップアップが開けないことがあるので画面遷移に切り替える */
    if (String(e.code || '').indexOf('popup') >= 0) {
      await api.signInWithRedirect(api.auth, new api.GoogleAuthProvider());
    } else {
      status('ログインできません', e.message);
    }
  }
}

/* ============================================================
   受信：サーバーの内容を画面に反映する
   ============================================================ */
let unsubs = [];
let base = null;          // 最後にサーバーと一致していた内容（差分を出すため）
function blankBase() { return { members: {}, properties: {}, assignments: {}, offs: {}, tasks: {}, rules: null }; }
function stopWatching() { unsubs.forEach(f => { try { f(); } catch (e) {} }); unsubs = []; base = null; state.on = false; }

const path = (...p) => [`orgs`, ORG, ...p];

function watch(api) {
  base = blankBase();
  let first = 0;
  COLLS.forEach(c => {
    unsubs.push(api.onSnapshot(api.collection(api.db, ...path(c)), snap => {
      const map = {}, arr = [];
      snap.forEach(d => { const v = { ...d.data(), id: d.id }; map[d.id] = v; arr.push(v); });
      base[c] = map;
      app.setColl(c, arr);
      app.render();
      if (++first === COLLS.length) offerUpload(api);
    }, e => status('同期できません', e.message)));
  });

  unsubs.push(api.onSnapshot(api.doc(api.db, ...path('config', 'rules')), d => {
    if (!d.exists()) return;
    base.rules = d.data();
    app.setRules(d.data());
    app.render();
  }, () => {}));

  unsubs.push(api.onSnapshot(api.collection(api.db, ...path('tasks')), snap => {
    const t = {};
    snap.forEach(d => { t[d.id] = d.data(); });
    base.tasks = JSON.parse(JSON.stringify(t));
    app.setTasks(t);
    app.render();
  }, () => {}));

  unsubs.push(api.onSnapshot(api.doc(api.db, 'config', 'admins'), d => {
    state.admins = (d.exists() && d.data().emails) || [];
    renderPanel();
  }, () => {}));
}

/* サーバーが空でこの端末にデータがあるときは、最初の1回だけアップロードを促す */
let asked = false;
function offerUpload(api) {
  if (asked || !base) return;
  asked = true;
  const empty = COLLS.every(c => Object.keys(base[c]).length === 0);
  const S = app.S;
  if (empty && (S.properties.length || S.members.length)) {
    if (confirm('サーバーにまだデータがありません。\nこの端末の内容（物件' + S.properties.length + '棟・メンバー' + S.members.length + '名）をアップロードして、全員で共有しますか？')) {
      upload(api);
    }
  }
}
function upload(api) { base = blankBase(); push(api, app.S); status('アップロードしました'); }

/* ============================================================
   送信：変わったところだけ書き込む
   ============================================================ */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let timer = null, pending = null;

function push(api, S) {
  if (!state.on || !base) return;
  pending = S;
  clearTimeout(timer);
  timer = setTimeout(() => flush(api), 300);   // 連続操作をまとめて送る
}

function flush(api) {
  const S = pending; pending = null;
  if (!S || !base) return;
  const batch = api.writeBatch(api.db);
  let n = 0;

  COLLS.forEach(c => {
    const cur = {};
    (S[c] || []).forEach(x => { if (x && x.id) cur[x.id] = x; });
    Object.keys(cur).forEach(id => {
      if (!same(cur[id], base[c][id])) {
        const { id: _drop, ...body } = cur[id];
        batch.set(api.doc(api.db, ...path(c, id)), body);
        base[c][id] = cur[id];
        n++;
      }
    });
    Object.keys(base[c]).forEach(id => {
      if (!cur[id]) { batch.delete(api.doc(api.db, ...path(c, id))); delete base[c][id]; n++; }
    });
  });

  if (!same(S.rules, base.rules)) {
    batch.set(api.doc(api.db, ...path('config', 'rules')), S.rules);
    base.rules = JSON.parse(JSON.stringify(S.rules));
    n++;
  }

  const t = S.tasks || {};
  Object.keys(t).forEach(pid => {
    if (!same(t[pid], base.tasks[pid])) {
      batch.set(api.doc(api.db, ...path('tasks', pid)), t[pid]);
      base.tasks[pid] = JSON.parse(JSON.stringify(t[pid]));
      n++;
    }
  });
  Object.keys(base.tasks).forEach(pid => {
    if (!t[pid]) { batch.delete(api.doc(api.db, ...path('tasks', pid))); delete base.tasks[pid]; n++; }
  });

  if (!n) return;
  batch.commit().catch(e => status('同期できません', e.message));
  /* オフラインのときは commit の完了を待たない（つながったときに自動で送られる） */
}

/* ============================================================
   権限の管理（許可リスト）
   ============================================================ */
async function addAdmin(api, mail) {
  mail = (mail || '').trim().toLowerCase();
  if (!mail) return;
  const ref = api.doc(api.db, 'config', 'admins');
  const snap = await api.getDoc(ref);
  const list = (snap.exists() && snap.data().emails) || [];
  if (list.includes(mail)) return alert('すでに追加されています');
  await api.setDoc(ref, { emails: [...list, mail] });
  alert(mail + ' を追加しました。本人がGoogleでログインすれば使えるようになります。');
}
async function removeAdmin(api, mail) {
  const ref = api.doc(api.db, 'config', 'admins');
  const snap = await api.getDoc(ref);
  const list = (snap.exists() && snap.data().emails) || [];
  if (list.length <= 1) return alert('最後の1人は外せません。');
  await api.setDoc(ref, { emails: list.filter(m => m !== mail) });
}

/* ============================================================
   「メンバー / ルール」タブに出す同期パネル
   ============================================================ */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderPanel() {
  const box = document.getElementById('syncPanel');
  if (!box) return;
  const S = window.SYNC || {};

  if (!S.enabled) {
    box.innerHTML = `<div class="card"><h2>データの共有</h2>
      <div class="alert warn">いまは <b>この端末だけ</b> でデータを持っています。
        他のパソコンやスマホとは共有されません。</div>
      <div class="muted">全員で同じデータを見られるようにするには、Firebaseの設定を
        <span class="mono">firebase-config.js</span> に貼り付けてください。手順は
        <span class="mono">セットアップ.md</span> にあります。</div></div>`;
    return;
  }

  if (!state.user) {
    box.innerHTML = `<div class="card"><h2>データの共有</h2>
      <div class="muted" style="margin-bottom:10px">Googleアカウントでログインすると、
        パソコンでもスマホでも同じデータが見られます。オフラインでもそのまま使えます。</div>
      <button class="btn pri" onclick="SYNC.login()">Googleでログイン</button>
      ${state.err ? `<div class="alert err" style="margin-top:10px">${esc(state.err)}</div>` : ''}</div>`;
    return;
  }

  const me = state.user.email;
  box.innerHTML = `<div class="card"><h2>データの共有</h2>
    <div class="alert ${state.err ? 'err' : 'ok'}">
      ${state.err ? '⚠ ' + esc(state.err) : '✓ ' + esc(state.msg) + '（このデータは許可された全員で共有されています）'}
    </div>
    <div class="row" style="justify-content:space-between;align-items:center">
      <div class="muted">ログイン中：<b>${esc(state.user.name)}</b>　<span class="mono">${esc(me)}</span></div>
      <button class="btn sm" onclick="SYNC.logout()">ログアウト</button>
    </div>
    <h3>使える人（権限）</h3>
    <div class="muted">ここに追加した Googleアカウントの人が、同じデータを見て編集できます。</div>
    <div class="scroll" style="margin-top:8px"><table class="grid"><tbody>
      ${state.admins.map(m => `<tr><td class="name"><span class="mono">${esc(m)}</span>${m === me ? ' <span class="badge">自分</span>' : ''}</td>
        <td style="width:90px">${m === me ? '' : `<button class="btn sm danger" onclick="if(confirm('${esc(m)} の権限を外しますか？')){SYNC.removeAdmin('${esc(m)}')}">外す</button>`}</td></tr>`).join('')
      || '<tr><td class="muted">まだ登録されていません</td></tr>'}
    </tbody></table></div>
    <div class="row" style="margin-top:10px">
      <div><label>追加するGoogleアカウント</label><input id="newAdmin" placeholder="imai@example.com" style="width:260px"></div>
      <button class="btn pri" onclick="SYNC.addAdmin(document.getElementById('newAdmin').value)">追加</button>
    </div>
    <h3>データ</h3>
    <div class="row" style="gap:8px">
      <button class="btn" onclick="if(confirm('この端末の内容でサーバーを上書きします。よろしいですか？')){SYNC.upload()}">この端末の内容をアップロード</button>
    </div>
    <div class="muted">※ ふだんは自動で同期されます。使うのは、復元したあとなど手動で押し上げたいときだけです。</div>
  </div>`;
}

window.addEventListener('offline', renderPanel);
window.addEventListener('online', renderPanel);
