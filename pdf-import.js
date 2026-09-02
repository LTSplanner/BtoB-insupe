/* ============================================================
   工程表PDFをドラッグ&ドロップして、検査日と報告書の日を読み取る
   ------------------------------------------------------------
   読み取り方
     ・「社内検査」の行を探す
     ・その行の 黄色いマス＝弊社の検査日、次の 赤いマス＝報告書
     ・「最終確認」は先方が行うので使わない
   日付は、上の「9月 10月 …」と「1 2 3 …」の並びから、
   マスの位置がどの日かを割り出しています。
   ============================================================ */
(function () {
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const SCALE = 2;

  let libP = null;
  function lib() {
    if (libP) return libP;
    libP = new Promise((ok, ng) => {
      const s = document.createElement('script');
      s.src = PDFJS;
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; ok(window.pdfjsLib); };
      s.onerror = () => ng(new Error('PDFを読む部品を取り込めませんでした（通信できないときは、一度オンラインで開いてください）'));
      document.head.appendChild(s);
    });
    return libP;
  }

  /* ---- 色の判定 ---- */
  const isYellow = (r, g, b) => r > 200 && g > 190 && b < 130;
  const isRed = (r, g, b) => r > 170 && g < 110 && b < 110;

  /* ---- 住所から物件名をつくる（○○区△△2-30-2 → ○○区△△2丁目） ---- */
  function nameFromAddress(addr) {
    if (!addr) return '';
    let a = addr.replace(/^(東京都|北海道|京都府|大阪府|.{2,3}県)/, '');
    const m = a.match(/^(.+?[市区町村])(.+?)(\d+)(?:[-−‐ー－]|$)/);
    if (m) return m[1] + m[2] + m[3] + '丁目';
    return a;
  }

  /* ============================================================
     PDF → 検査日・報告書・住所
     ============================================================ */
  async function parse(file) {
    const pdfjs = await lib();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: SCALE });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;

    const tc = await page.getTextContent();
    const items = tc.items.filter(it => (it.str || '').trim()).map(it => {
      const p = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
      return { str: it.str.trim(), x: p[0], y: p[1], w: (it.width || 0) * SCALE };
    });
    if (!items.length) throw new Error('PDFから文字を読み取れませんでした（画像だけのPDFかもしれません）');

    /* --- 日付の並び（1 2 3 …）が一番多く並んでいる行を探す --- */
    const rows = {};
    items.forEach(it => {
      if (!/^\d{1,2}$/.test(it.str)) return;
      const key = Math.round(it.y / 6);
      (rows[key] = rows[key] || []).push(it);
    });
    const dayRow = Object.values(rows).sort((a, b) => b.length - a.length)[0];
    if (!dayRow || dayRow.length < 40) throw new Error('日付の行が見つかりませんでした。工程表の形式が違うようです');
    dayRow.sort((a, b) => a.x - b.x);

    /* --- 月ごとのまとまりに分け、上の「9月 10月 …」の位置で月を決める --- */
    const mlab = items.filter(it => /^\d{1,2}月$/.test(it.str)).sort((a, b) => a.x - b.x);
    if (!mlab.length) throw new Error('「○月」の見出しが見つかりませんでした');

    const groups = [];
    let g = [dayRow[0]];
    for (let i = 1; i < dayRow.length; i++) {
      if (+dayRow[i].str < +dayRow[i - 1].str) { groups.push(g); g = [dayRow[i]]; }
      else g.push(dayRow[i]);
    }
    groups.push(g);

    const upd = (items.map(it => it.str).join(' ').match(/(\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})/) || [])[1];
    let year = upd ? 2000 + (+upd) : new Date().getFullYear();

    const cols = [];
    let prevM = null;
    groups.forEach(grp => {
      const x0 = grp[0].x, x1 = grp[grp.length - 1].x;
      /* そのまとまりの上にある「○月」を探す。無ければ日付の並びではない（見出しのゴミ） */
      const lab = mlab.find(m => m.x >= x0 - 40 && m.x <= x1 + 40);
      if (!lab) return;
      const month = +lab.str.replace('月', '');
      if (prevM !== null && month < prevM) year++;   // 12月 → 1月 で年が変わる
      prevM = month;
      const z = n => String(n).padStart(2, '0');
      grp.forEach(it => cols.push({ x: it.x + it.w / 2, date: `${year}-${z(month)}-${z(+it.str)}` }));
    });
    if (cols.length < 40) throw new Error('日付を読み取れませんでした。工程表の形式が違うようです');

    /* --- 「社内検査」の行を探す（行の見出し＝一番左にあるもの） --- */
    const labels = items.filter(it => it.str.indexOf('社内検査') >= 0).sort((a, b) => a.x - b.x);
    if (!labels.length) throw new Error('「社内検査」の行が見つかりませんでした');
    const rowY = Math.round(labels[0].y);

    /* --- その行の色を読む --- */
    const band = [];
    for (let dy = -7; dy <= 7; dy += 2) {
      const y = rowY + dy;
      if (y < 0 || y >= canvas.height) continue;
      band.push(ctx.getImageData(0, y, canvas.width, 1).data);
    }
    const colorAt = x => {
      let y = 0, r = 0;
      band.forEach(row => {
        const i = x * 4;
        if (isYellow(row[i], row[i + 1], row[i + 2])) y++;
        if (isRed(row[i], row[i + 1], row[i + 2])) r++;
      });
      return y > 0 ? 'y' : (r > 0 ? 'r' : '');
    };

    const runs = [];
    let cur = null;
    for (let x = 0; x < canvas.width; x++) {
      const c = colorAt(x);
      if (c && cur && cur.c === c && x - cur.x1 <= 2) { cur.x1 = x; }
      else if (c) { cur = { c: c, x0: x, x1: x }; runs.push(cur); }
      else if (cur && x - cur.x1 > 3) { cur = null; }
    }
    const wide = runs.filter(r => r.x1 - r.x0 >= 4);
    const yellow = wide.filter(r => r.c === 'y');
    const red = wide.filter(r => r.c === 'r');
    if (!yellow.length) throw new Error('「社内検査」の行に黄色いマスが見つかりませんでした');

    /* 縦に走っている黄色い線（節目のガイド）を、マスと間違えないようにする。
       マスの中に書かれた「社内検査」「報告書」の文字の位置を手がかりにする。 */
    const inRow = it => Math.abs(it.y - labels[0].y) < 12;
    const cellInsp = labels.slice(1).find(inRow) || labels[1];
    const cellRep = items.find(it => it.str.indexOf('報告書') >= 0 && inRow(it));
    const runAt = (x, c) => (x == null ? null : wide.find(r => r.c === c && x >= r.x0 - 8 && x <= r.x1 + 8));

    let yRun = cellInsp ? runAt(cellInsp.x, 'y') : null;
    if (!yRun) {
      /* 文字が拾えないときは、上下の行と見比べて「縦線ではない黄色」を選ぶ */
      const guide = x => {
        const far = [rowY - 90, rowY + 90].filter(y => y > 0 && y < canvas.height);
        return far.some(y => {
          const row = ctx.getImageData(0, y, canvas.width, 1).data;
          const i = Math.round(x) * 4;
          return isYellow(row[i], row[i + 1], row[i + 2]);
        });
      };
      yRun = yellow.find(r => !guide((r.x0 + r.x1) / 2));
    }
    if (!yRun) throw new Error('「社内検査」のマスを特定できませんでした');

    let rRun = cellRep ? runAt(cellRep.x, 'r') : null;
    if (!rRun) rRun = red.find(r => r.x0 >= yRun.x1);

    const daysIn = run => cols.filter(c => c.x >= run.x0 - 2 && c.x <= run.x1 + 2).map(c => c.date).sort();
    const insp = daysIn(yRun);
    const rep = rRun ? daysIn(rRun) : [];
    if (!insp.length) throw new Error('検査日を日付に変換できませんでした');

    /* --- 住所と更新日 --- */
    const addrItem = items.find(it => it.str.indexOf('住所') >= 0);
    let address = '';
    if (addrItem) {
      address = items.filter(it => Math.abs(it.y - addrItem.y) < 6 && it.x >= addrItem.x - 1)
        .sort((a, b) => a.x - b.x).map(it => it.str).join('')
        .replace(/^.*住所[：:]\s*/, '').split(/現場|最終更新|担当/)[0].trim();
    }

    return {
      start: insp[0],
      end: insp[insp.length - 1],
      report: rep.length ? rep[rep.length - 1] : '',
      days: insp,
      address: address,
      name: nameFromAddress(address),
      file: file.name,
      /* 確認用の切り抜き画像 */
      thumb: crop(canvas, yRun, rRun, rowY)
    };
  }

  /* 読み取ったあたりを切り抜いて、目で確かめられるようにする */
  function crop(canvas, y0, r0, rowY) {
    const x0 = Math.max(0, y0.x0 - 220), x1 = Math.min(canvas.width, (r0 ? r0.x1 : y0.x1) + 220);
    const top = Math.max(0, rowY - 60), h = Math.min(canvas.height - top, 110);
    const c = document.createElement('canvas');
    c.width = x1 - x0; c.height = h;
    c.getContext('2d').drawImage(canvas, x0, top, x1 - x0, h, 0, 0, x1 - x0, h);
    try { return c.toDataURL('image/png'); } catch (e) { return ''; }
  }

  /* ============================================================
     読み取り結果の確認画面
     ============================================================ */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function sheet(html) {
    let el = document.getElementById('pdfSheet');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pdfSheet';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(17,24,39,.55);display:flex;'
        + 'align-items:flex-start;justify-content:center;padding:24px;overflow:auto;z-index:60';
      el.onclick = e => { if (e.target === el) close(); };
      document.body.appendChild(el);
    }
    el.innerHTML = `<div style="background:var(--panel);border-radius:12px;max-width:760px;width:100%;padding:18px">${html}</div>`;
    el.hidden = false;
    return el;
  }
  function close() { const el = document.getElementById('pdfSheet'); if (el) el.hidden = true; }

  function code(s, e) { return s.replace(/-/g, '').slice(2) + '-' + e.replace(/-/g, '').slice(4); }

  function confirmSheet(r) {
    const rep = r.report ? `(${r.report.replace(/-/g, '').slice(4)})` : '';
    sheet(`
      <h2 style="margin:0 0 4px">工程表を読み取りました</h2>
      <div class="muted" style="margin-bottom:12px"><span class="mono">${esc(r.file)}</span></div>
      ${r.thumb ? `<div style="overflow-x:auto;border:1px solid var(--line);border-radius:8px;margin-bottom:12px">
        <img src="${r.thumb}" style="display:block;max-width:none;height:auto"></div>
        <div class="muted" style="margin-bottom:12px">↑ 読み取ったところです。黄色＝弊社検査、赤＝報告書。ちがっていたら下の日付を直してください。</div>` : ''}
      <div class="row">
        <div><label>物件名</label><input id="pi_name" value="${esc(r.name)}" style="width:220px"></div>
        <div><label>住所</label><input id="pi_addr" value="${esc(r.address)}" style="width:240px"></div>
      </div>
      <div class="row" style="margin-top:8px">
        <div><label>検査開始</label><input type="date" id="pi_s" value="${r.start}"></div>
        <div><label>検査終了</label><input type="date" id="pi_e" value="${r.end}"></div>
        <div><label>報告書提出</label><input type="date" id="pi_r" value="${r.report}"></div>
        <div><label>部屋数（分かれば）</label><input type="number" id="pi_rooms" style="width:80px"></div>
      </div>
      <div class="alert ok" style="margin-top:12px">登録名：<b class="mono" id="pi_code">${esc(window.__app.clientName)}　${code(r.start, r.end)}${rep}　${esc(r.name)}</b></div>
      <div class="muted">検査日：${r.days.map(d => d.slice(5).replace('-', '/')).join('、')}（${r.days.length}日間）</div>
      <div class="row" style="margin-top:14px;gap:8px">
        <button class="btn pri" id="pi_ok">この内容で登録</button>
        <button class="btn" onclick="PDFIMPORT.close()">やめる</button>
      </div>`);
    document.getElementById('pi_ok').onclick = () => {
      const v = id => document.getElementById(id).value;
      if (!v('pi_name')) return alert('物件名を入れてください');
      if (v('pi_s') > v('pi_e')) return alert('検査開始が検査終了より後になっています');
      window.__app.addProperty({
        name: v('pi_name'), address: v('pi_addr'),
        start: v('pi_s'), end: v('pi_e'), report: v('pi_r'),
        rooms: +v('pi_rooms') || null
      });
      close();
    };
  }

  async function handle(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) return alert('PDFファイルを入れてください');
    sheet(`<h2 style="margin:0">読み取り中…</h2><div class="muted">${esc(file.name)}</div>`);
    try {
      confirmSheet(await parse(file));
    } catch (e) {
      sheet(`<h2 style="margin:0 0 8px">読み取れませんでした</h2>
        <div class="alert err">${esc(e.message || e)}</div>
        <div class="muted">工程表の形やレイアウトが違う場合は、「物件」タブから手で登録してください。</div>
        <div class="row" style="margin-top:14px"><button class="btn" onclick="PDFIMPORT.close()">閉じる</button></div>`);
    }
  }

  /* ============================================================
     画面全体でドラッグ&ドロップを受ける
     ============================================================ */
  let veil = null, depth = 0;
  function showVeil(on) {
    if (!veil) {
      veil = document.createElement('div');
      veil.style.cssText = 'position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;'
        + 'background:rgba(37,99,235,.12);border:4px dashed var(--accent);pointer-events:none;font-size:20px;font-weight:700;color:var(--accent)';
      veil.textContent = '工程表のPDFをここに落としてください';
      document.body.appendChild(veil);
    }
    veil.hidden = !on;
  }
  window.addEventListener('dragenter', e => { if (hasFile(e)) { e.preventDefault(); depth++; showVeil(true); } });
  window.addEventListener('dragover', e => { if (hasFile(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (hasFile(e)) { depth = Math.max(0, depth - 1); if (!depth) showVeil(false); } });
  window.addEventListener('drop', e => {
    if (!hasFile(e)) return;
    e.preventDefault(); depth = 0; showVeil(false);
    handle(e.dataTransfer.files[0]);
  });
  function hasFile(e) {
    const t = e.dataTransfer && e.dataTransfer.types;
    return t && Array.prototype.indexOf.call(t, 'Files') >= 0;
  }

  window.PDFIMPORT = { handle, close, pick };
  function pick(input) { handle(input.files[0]); input.value = ''; }
})();
