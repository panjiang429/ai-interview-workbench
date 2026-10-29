/* ===================================================================
   revise.js v6 · 「反问修改」引擎
   适用于：素材卡 / 岗位方向 / 自我介绍 / 题库每题
   机制：用户一句话指令 → 云端 LLM 按指令重写 → 版本历史保留可回退
   修改指令优先级最高；数字与事实只来自原内容或用户输入，禁止编造
   =================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);

  /* ---------------- 快捷指令 ---------------- */
  const STORY_QUICK = [
    ["数字和口径不对，实际是：", "校准数字"],
    ["A 行动写得太笼统，补上当时具体做法：", "补细节"],
    ["这张卡面试主打的点应该是：", "改重点"],
    ["深挖问答再补 2 条面试官会追的：", "补追问"],
    ["语气改自然一点，像我自己说话", "更口语"],
  ];
  const DIR_QUICK = [
    ["这个方向的定位不对，实际主打：", "改定位"],
    ["高频问答再补 2 道更可能被问的：", "补问答"],
    ["面试前清单再具体一点，加上：", "细化清单"],
    ["英文定位改成更顺口的：", "改英文"],
    ["gap 应对换成更贴近我情况的说法：", "改 gap"],
  ];
  const INTRO_QUICK = [
    ["这段和我的真实经历不符，实际是：", "改事实"],
    ["改口语一点，别像背的", "更口语"],
    ["压缩到 30 秒以内", "压时长"],
    ["重点突出这个能力：", "改重点"],
    ["数字换成：", "校准数字"],
  ];
  const Q_QUICK = [
    ["按我的素材卡把这道题的讲稿改成我的版本", "生成我的版本"],
    ["和我的真实经历不符，实际是：", "改事实"],
    ["结合目标岗位（岗位是：", "贴岗位"],
    ["改成更口语的说法", "更口语"],
  ];

  /* ---------------- 提示词 ---------------- */
  const SYS_CARD = `你是面试教练，正在按学生的要求修改一张面试素材卡（STAR 结构）。
铁律：
1. 学生的修改指令优先级最高。涉及个人经历的事实，一律以学生说的为准。
2. 只改指令涉及的字段；指令没提到的字段原样保留，不许重写。
3. S/T/A/R 各保持 1-3 句的密度；depth 数组每项 {q,a}；tags 数组 3-5 个。
4. sources 数组原样保留，禁止增删改。
5. 数字只能来自原卡或学生输入，禁止编造新数字。
只输出 JSON：{"note":"一句话说明改了什么","card":{整卡字段}}`;

  const SYS_DIR = `你是面试教练，正在按学生的要求修改一张「岗位方向讲法」卡。
铁律：
1. 学生指令优先级最高；只改指令涉及的部分。
2. 保留字段结构：position/skill/challenge/bonus/gap/jdkeys/viewer/line 为字符串；qa 与 depth 类似（{q,a}，4-5 条）；gapqa 是 {q,a}；plan 是字符串数组（4 条左右）；en 是一句英文定位；stories 是素材卡编号数组，除非指令要求否则不动。
3. 内容要具体、可执行，禁止空话。
只输出 JSON：{"note":"一句话说明改了什么","dir":{整卡字段}}`;

  const SYS_INTRO = `你是面试教练，正在按学生的要求修改一段自我介绍（中英双语块）。
铁律：
1. 学生指令优先级最高；事实以学生说的为准。
2. 保持 cn（中文）与 en（英文）双版本同步改，口径一致。
3. 字数：30 秒版约 80-100 汉字，1 分钟版约 180-230 汉字。
4. 数字只能来自原文或学生输入。
只输出 JSON：{"note":"一句话说明改了什么","block":{"cn":"","en":""}}`;

  const SYS_Q = `你是面试教练，把题库里的通用讲稿改写成「候选人第一人称、可以照着背」的个性化版本。
铁律：
1. 学生的修改指令优先级最高；事实以学生的素材卡为准。
2. 只能使用候选人素材里的真实经历与数字，禁止编造；素材不够时用通用框架并留「【替换成你的例子】」占位。
3. 输出 text 是连贯的多段口语稿（段间用空行），总长对齐题库建议时长（约每分钟 200 字）。
4. 保留原讲稿的结构节奏，但语言要像学生本人在说话。
只输出 JSON：{"note":"一句话说明改了什么","text":""}`;

  /* ---------------- LLM ---------------- */
  let ACTIVE = null;
  function parseJSON(raw) {
    let t = String(raw || "").trim();
    t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("模型没有返回 JSON");
    let body = t.slice(a, b + 1);
    try { return JSON.parse(body); } catch (e) {}
    body = body.replace(/,\s*([}\]])/g, "$1");
    try { return JSON.parse(body); } catch (e) { throw new Error("JSON 解析失败：" + e.message); }
  }
  async function llmJSON(system, user, onTick) {
    if (DEMO_MODE) { alert("演示版（GitHub 静态版）不开放 AI 修改——完整版支持 AI 按你的指令重写并保留版本历史。"); throw new Error("demo-mode"); }
    const ctl = new AbortController();
    ACTIVE = ctl;
    try {
      const stream = cloud.llm.chat.completions.create({
        model: "auto",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        stream: true,
        temperature: 0.55,
        signal: ctl.signal,
      });
      let text = "";
      for await (const chunk of stream) {
        const d = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || {};
        if (d.content) { text += d.content; if (onTick) onTick(text); }
      }
      return parseJSON(text);
    } finally {
      if (ACTIVE === ctl) ACTIVE = null;
    }
  }

  /* ---------------- 工具 ---------------- */
  function e(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function items() { return (typeof ITEMS !== "undefined" && ITEMS) || []; }
  function findItem(sid) { return items().find((x) => x.sid === sid); }
  const BUSY = {};

  function status(box, txt, ok) {
    const el = box.querySelector(".rstat");
    if (el) { el.textContent = txt || ""; el.className = "rstat small " + (ok ? "ok" : "muted"); }
  }
  function revboxHtml(kind, sid, quicks, btnLabel) {
    return `<div class="revbox" data-rk="${kind}" data-rs="${e(sid)}">
      <div class="revhead">✏️ 这里哪里不对？说一句，AI 按你的话改（旧版本保留可回退）</div>
      <div class="qchips">${quicks.map((q) => `<button type="button" class="qchip" data-qc="${e(q[0])}">${e(q[1])}</button>`).join("")}</div>
      <textarea class="revinput" placeholder="例如：R 里的数字口径不对，其实是……；这段太像 AI 写的，改自然点；补上我当时具体怎么做的"></textarea>
      <div class="revacts"><button type="button" class="btn sm" data-ract="go">${e(btnLabel || "按我的要求改")}</button><span class="rstat small muted"></span></div>
    </div>`;
  }
  function versHtml(revs, cur, kind, sid) {
    if (!revs || revs.length < 1) return "";
    const btns = [`<button type="button" class="vbtn${cur < 0 ? " on" : ""}" data-ract="rver" data-n="-1" data-rk="${kind}" data-rs="${e(sid)}">模板原版</button>`];
    revs.forEach((v, n) => btns.push(`<button type="button" class="vbtn${n === cur ? " on" : ""}" data-ract="rver" data-n="${n}" data-rk="${kind}" data-rs="${e(sid)}" title="${e(v.note || "")}">${e((v.label || ("改 " + (n + 1))).slice(0, 10))}</button>`));
    return `<div class="vers"><b>版本</b>${btns.join("")}</div>`;
  }

  /* ---------------- 版本管理 ---------------- */
  function ensureRevs(p, baseFields) {
    if (!p._revs) {
      p._revs = [{ label: "模板原版", note: "", ts: new Date().toISOString(), payload: baseFields }];
      p._cur = -1;
    }
    return p._revs;
  }
  function currentFields(p, fields) {
    const o = {};
    fields.forEach((f) => { if (p[f] !== undefined) o[f] = p[f]; });
    return o;
  }
  function applyFields(p, newObj, fields) {
    fields.forEach((f) => { if (newObj && newObj[f] !== undefined) p[f] = newObj[f]; });
  }

  async function saveItem(sid) {
    if (DEMO_MODE) return;
    const it = findItem(sid);
    if (!it) return;
    const r = await cloud.database.from("jp_items").update({ payload: it.payload, updated_at: new Date().toISOString() }).eq("sid", sid).select();
    if (r && r.error) throw new Error(r.error.message || "云端保存失败");
  }

  /* ---------------- 素材卡修改 ---------------- */
  const STORY_FIELDS = ["id", "title", "period", "role", "tags", "use", "S", "T", "A", "R", "depth", "risk", "sources"];
  async function reviseStory(sid, cmd, box) {
    const it = findItem(sid);
    if (!it || !it.payload) return;
    const p = it.payload;
    ensureRevs(p, currentFields(p, STORY_FIELDS));
    status(box, "AI 正在按你的要求改这张卡…");
    const out = await llmJSON(SYS_CARD,
      `【学生的修改要求】\n${cmd}\n\n【当前素材卡】\n${JSON.stringify(currentFields(p, STORY_FIELDS), null, 1)}\n\n按学生要求改，输出 JSON。`,
      (t) => status(box, "AI 正在改…已接收 " + String(t).length + " 字"));
    const card = out.card || {};
    if (!card.S && !card.A) throw new Error("模型没有返回卡片内容");
    applyFields(p, card, STORY_FIELDS.filter((f) => f !== "id"));
    p._revs.push({ label: (out.note || "按指令修改").slice(0, 14), note: out.note || "", ts: new Date().toISOString(), payload: currentFields(p, STORY_FIELDS) });
    p._cur = p._revs.length - 1;
    await saveItem(sid);
    if (typeof renderStories === "function") renderStories();
  }
  function switchVersion(kind, sid, n, rerender) {
    const it = findItem(sid);
    if (!it || !it.payload || !it.payload._revs) return;
    const p = it.payload;
    const idx = Number(n);
    if (idx >= 0) applyFields(p, (p._revs[idx] || {}).payload, Object.keys((p._revs[idx] || {}).payload || {}));
    else applyFields(p, (p._revs[0] || {}).payload, Object.keys((p._revs[0] || {}).payload || {}));
    p._cur = idx;
    saveItem(sid).catch(() => {});
    rerender();
  }

  /* ---------------- 岗位方向修改 ---------------- */
  const DIR_FIELDS = ["key", "title", "position", "stories", "skill", "challenge", "bonus", "gap", "jdkeys", "viewer", "line", "qa", "gapqa", "en", "plan"];
  async function reviseDir(sid, cmd, box) {
    const it = findItem(sid);
    if (!it || !it.payload) return;
    const p = it.payload;
    ensureRevs(p, currentFields(p, DIR_FIELDS));
    status(box, "AI 正在按你的要求改这个方向…");
    const out = await llmJSON(SYS_DIR,
      `【学生的修改要求】\n${cmd}\n\n【当前岗位方向卡】\n${JSON.stringify(currentFields(p, DIR_FIELDS), null, 1)}\n\n按学生要求改，输出 JSON。`,
      (t) => status(box, "AI 正在改…已接收 " + String(t).length + " 字"));
    const dir = out.dir || {};
    if (!dir.position && !dir.line) throw new Error("模型没有返回内容");
    applyFields(p, dir, DIR_FIELDS);
    p._revs.push({ label: (out.note || "按指令修改").slice(0, 14), note: out.note || "", ts: new Date().toISOString(), payload: currentFields(p, DIR_FIELDS) });
    p._cur = p._revs.length - 1;
    await saveItem(sid);
    if (typeof renderDirections === "function") renderDirections();
  }

  /* ---------------- 自我介绍修改 ---------------- */
  async function reviseIntro(field, cmd, box) {
    const it = findItem("INTROS");
    if (!it || !it.payload) return;
    const p = it.payload;
    const block = p[field];
    if (!block || typeof block !== "object") return;
    if (!p._revs) { p._revs = {}; p._cur = {}; }
    if (!p._revs[field]) { p._revs[field] = [{ label: "模板原版", note: "", block: { cn: block.cn, en: block.en } }]; p._cur[field] = -1; }
    status(box, "AI 正在按你的要求改这段自我介绍…");
    const out = await llmJSON(SYS_INTRO,
      `【学生的修改要求】\n${cmd}\n\n【当前自我介绍（中英）】\n中文：${block.cn}\n英文：${block.en}\n\n按学生要求改，输出 JSON。`,
      (t) => status(box, "AI 正在改…已接收 " + String(t).length + " 字"));
    const nb = out.block || {};
    if (!nb.cn && !nb.en) throw new Error("模型没有返回内容");
    p._revs[field].push({ label: (out.note || "按指令修改").slice(0, 14), note: out.note || "", block: { cn: nb.cn, en: nb.en } });
    p._cur[field] = p._revs[field].length - 1;
    p[field] = { cn: nb.cn || block.cn, en: nb.en || block.en };
    await saveItem("INTROS");
    if (typeof renderIntros === "function") renderIntros();
  }
  function switchIntro(field, n) {
    const it = findItem("INTROS");
    if (!it || !it.payload) return;
    const p = it.payload;
    const revs = (p._revs || {})[field];
    if (!revs) return;
    const idx = Number(n);
    const src = idx >= 0 ? revs[idx] : revs[0];
    if (src && src.block) p[field] = { cn: src.block.cn, en: src.block.en };
    p._cur[field] = idx;
    saveItem("INTROS").catch(() => {});
    if (typeof renderIntros === "function") renderIntros();
  }

  /* ---------------- 题库 · 我的版本 ---------------- */
  function qeditsMap() {
    const m = {};
    items().filter((x) => x.kind === "qedit").forEach((x) => { const qid = x.payload && x.payload.qid; if (qid) m[qid] = x; });
    return m;
  }
  function qByKey(key) {
    const bank = (window.QBANK || []);
    const k = String(key);
    const i = k.indexOf("-");
    if (i < 0) return null;
    const cat = k.slice(0, i), id = k.slice(i + 1);
    return bank.find((x) => x.cat === cat && x.id === id);
  }
  function briefFor(mine) {
    const pick = String(mine || "").split(/[,，、\s]+/).filter(Boolean);
    const ss = items().filter((x) => x.kind === "story").map((x) => x.payload || {});
    const chosen = ss.filter((s) => pick.includes(s.id));
    const pool = chosen.length ? chosen : ss.slice(0, 2);
    return pool.map((s) => `[${s.id}] ${s.title}（${s.period || ""}｜${s.role || ""}）\n  S：${s.S || ""}\n  T：${s.T || ""}\n  A：${s.A || ""}\n  R：${s.R || ""}`).join("\n\n");
  }
  function myVerHtml(key) {
    const q = qByKey(key);
    if (!q) return "";
    const it = qeditsMap()[key];
    let html = "";
    if (it && it.payload && it.payload.versions && it.payload.versions.length) {
      const p = it.payload;
      const cur = p.versions[p.cur] || p.versions[0];
      html += `<div class="lbl" style="margin:10px 12px 0"><b>⭐ 我的版本</b> <span class="small muted">（按我的素材与要求生成，可继续改）</span></div>`;
      html += versQHtml(p, key);
      html += `<div class="mytext">${String(cur.text || "").split(/\n{2,}/).map((x) => `<p>${e(x)}</p>`).join("")}</div>`;
      if (cur.note) html += `<p class="small muted" style="margin:2px 12px 0">最近一次修改：${e(cur.note)}</p>`;
    }
    html += revboxHtml("q", key, Q_QUICK, it ? "按我的要求改这题" : "✍️ 生成我的版本");
    return `<div class="myver">${html}</div>`;
  }
  function versQHtml(p, key) {
    if (!p.versions || p.versions.length < 2) return "";
    const btns = p.versions.map((v, n) => `<button type="button" class="vbtn${n === p.cur ? " on" : ""}" data-ract="qver" data-n="${n}" data-key="${e(key)}" title="${e(v.note || "")}">${e((v.label || ("v" + (n + 1))).slice(0, 12))}</button>`);
    return `<div class="vers" style="margin:4px 12px 0"><b>版本</b>${btns.join("")}</div>`;
  }
  function hydrateMyVer() {
    document.querySelectorAll("[data-myver]").forEach((el) => {
      const key = el.getAttribute("data-myver");
      el.innerHTML = myVerHtml(key);
    });
  }
  async function reviseQ(key, cmd, box) {
    const q = qByKey(key);
    if (!q) return;
    if (BUSY[key]) return;
    BUSY[key] = true;
    try {
      const it = qeditsMap()[key];
      const curText = it && it.payload && it.payload.versions ? (it.payload.versions[it.payload.cur] || {}).text : null;
      status(box, curText ? "AI 正在按你的要求改…" : "AI 正在按你的素材生成我的版本…");
      const scTxt = (q.sc || []).map((s) => s.join("：")).join("\n");
      const out = await llmJSON(SYS_Q,
        `【题目】${q.q}\n【英文问法】${q.en || ""}\n【题库通用讲稿要点】\n${scTxt}\n【常见追问】${(q.fu || []).join("；")}\n\n【学生的修改要求】\n${cmd}\n\n【候选人素材（唯一事实来源）】\n${briefFor(q.mine) || "（无指定素材卡，用通用框架+占位）"}${curText ? "\n\n【当前我的版本（在此基础上改）】\n" + curText : ""}\n\n输出 JSON。`,
        (t) => status(box, "AI 正在写…已接收 " + String(t).length + " 字"));
      if (!out.text) throw new Error("模型没有返回内容");
      const label = (out.note || (cmd.slice(0, 10) || "我的版本")).slice(0, 14);
      if (it) {
        const p = it.payload;
        p.versions.push({ label, note: out.note || "", text: out.text });
        p.cur = p.versions.length - 1;
        const r = await cloud.database.from("jp_items").update({ payload: p, updated_at: new Date().toISOString() }).eq("sid", it.sid).select();
        if (r && r.error) throw new Error(r.error.message || "云端保存失败");
      } else {
        const payload = { qid: key, versions: [{ label, note: out.note || "", text: out.text }], cur: 0 };
        const owner_name = (typeof session !== "undefined" && session && session.user && session.user.name) || null;
        const r = await cloud.database.from("jp_items").insert({ sid: "QE-" + key, kind: "qedit", payload, owner_name }).select();
        if (r && r.error) throw new Error(r.error.message || "云端保存失败");
        if (typeof loadData === "function") await loadData();
      }
      const holder = document.querySelector(`[data-myver="${key}"]`);
      if (holder) holder.innerHTML = myVerHtml(key);
      status(box, "已生成（旧版本保留可切换）", true);
    } catch (err) {
      status(box, "失败：" + ((err && err.message) || ""), false);
    } finally {
      BUSY[key] = false;
    }
  }
  function switchQ(key, n) {
    const it = qeditsMap()[key];
    if (!it || !it.payload) return;
    it.payload.cur = Number(n);
    saveItem(it.sid).catch(() => {});
    const holder = document.querySelector(`[data-myver="${key}"]`);
    if (holder) holder.innerHTML = myVerHtml(key);
  }

  /* ---------------- 事件委托 ---------------- */
  document.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".revbox .qchip");
    if (chip) {
      const box = chip.closest(".revbox");
      const ta = box.querySelector(".revinput");
      if (ta) { ta.value = (chip.getAttribute("data-qc") || "") + ta.value; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      return;
    }
    const btn = ev.target.closest("[data-ract]");
    if (!btn) return;
    const act = btn.getAttribute("data-ract");
    if (act === "go") {
      const box = btn.closest(".revbox");
      if (!box) return;
      const kind = box.getAttribute("data-rk");
      const sid = box.getAttribute("data-rs");
      const ta = box.querySelector(".revinput");
      const cmd = (ta && ta.value.trim()) || "";
      if (!cmd) { if (ta) ta.focus(); status(box, "先写一句要改什么"); return; }
      if (typeof session === "undefined" || !session) { if (typeof openMask === "function") openMask(); return; }
      if (DEMO_MODE) { status(box, "演示版（GitHub 静态版）不开放 AI 修改——完整版支持 AI 按你的指令重写并保留版本历史"); return; }
      if (!cloud) { status(box, "云端不可用，请刷新页面重试"); return; }
      if (BUSY[sid]) return;
      BUSY[sid] = true;
      const runner = kind === "story" ? reviseStory : kind === "dir" ? reviseDir : kind === "intro" ? reviseIntro : null;
      const finish = () => { BUSY[sid] = false; };
      if (!runner) { finish(); return; }
      Promise.resolve(runner(sid, cmd, box)).then(finish).catch((err) => { status(box, "失败：" + ((err && err.message) || ""), false); finish(); });
    } else if (act === "rver") {
      const kind = btn.getAttribute("data-rk");
      const sid = btn.getAttribute("data-rs");
      const n = btn.getAttribute("data-n");
      if (kind === "story") switchVersion(kind, sid, n, () => renderStories());
      else if (kind === "dir") switchVersion(kind, sid, n, () => renderDirections());
      else if (kind === "intro") switchIntro(sid, n);
    } else if (act === "qver") {
      switchQ(btn.getAttribute("data-key"), btn.getAttribute("data-n"));
    }
  });
  /* 题库生成/修改按钮（revbox 里 data-rk="q"） */
  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest('.revbox[data-rk="q"] [data-ract="go"]');
    if (!btn) return;
    const box = btn.closest(".revbox");
    const key = box.getAttribute("data-rs");
    const ta = box.querySelector(".revinput");
    const cmd = (ta && ta.value.trim()) || "";
    if (!cmd) { if (ta) ta.focus(); status(box, "先写一句要改什么"); return; }
    if (typeof session === "undefined" || !session) { if (typeof openMask === "function") openMask(); return; }
    if (DEMO_MODE) { status(box, "演示版（GitHub 静态版）不开放 AI 修改——完整版支持 AI 按你的指令重写并保留版本历史"); return; }
      if (!cloud) { status(box, "云端不可用，请刷新页面重试"); return; }
    reviseQ(key, cmd, box);
  }, true);

  /* 题库重渲染后的水合 */
  document.addEventListener("qb:rendered", hydrateMyVer);

  /* 导出 */
  window.RV = { hydrateMyVer, myVerHtml, STORY_QUICK, DIR_QUICK, INTRO_QUICK, Q_QUICK, revboxHtml, versHtml };
})();
