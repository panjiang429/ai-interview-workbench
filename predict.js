/* ===================================================================
   predict.js · AI 押题引擎 v5
   两阶段：① 标题单（含 5 分钟骨架）→ ② 逐题生成长讲稿（900–1100 字）
   每题支持「按我的要求改」：带指令重写、保留多版本、云端自动保存
   =================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const ROUNDS = ["电话初筛", "HR 面", "业务一面", "业务二面", "交叉面 / 总监面", "高管终面", "群面 / 无领导"];
  const DIRS = [
    ["A", "商分 / 数据分析"],
    ["B", "运营 / 市场增长"],
    ["C", "AI 产品 / 数据产品"],
    ["D", "项目管理 / PMO"],
    ["E", "证券 / 金融研究"],
    ["F", "供应链 / 物流"],
    ["G", "综合管培 / 未定"],
  ];
  const TIERS = [
    ["must", "必考", "tag-must", "🔴"],
    ["high", "高频", "tag-high", "🟠"],
    ["maybe", "可能", "tag-maybe", "🟡"],
  ];
  const QUICK = [
    ["和我的真实经历不符，实际是：", "改事实"],
    ["这段太书面了，改成我平时说话的口吻", "更口语"],
    ["压缩到 3 分钟，砍掉次要细节", "压到 3 分钟"],
    ["再展开，讲到 5 分钟，每段补一个具体细节", "扩到 5 分钟"],
    ["数字和口径要更准确，按素材卡来", "校准数字"],
    ["结尾加一句反问面试官的话", "加反问"],
    ["加重「为什么选这家公司」的动机部分", "加重动机"],
  ];

  let MODELS = [];
  let PACK = null;
  let META = null;
  let RECID = null;
  let running = false;
  const BUSY = {};

  function e(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function notify(txt, ok) {
    const m = $("pMsg");
    if (!m) return;
    m.textContent = txt || "";
    m.className = "msg " + (ok ? "ok" : "err");
  }
  function chars(s) { return String(s || "").replace(/\s/g, "").length; }
  function secByChars(n) { return Math.round((n / 210) * 60); }
  function mmss(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m}分${String(s).padStart(2, "0")}秒` : `${s}秒`;
  }

  /* ---------------- 候选人档案 ---------------- */
  function stories() {
    const items = (typeof ITEMS !== "undefined" && ITEMS) || [];
    return items.filter((x) => x.kind === "story").map((x) => x.payload || {}).filter((s) => s.id);
  }
  function cardLine(s) {
    return `[${s.id}] ${s.title}（${s.period || ""}｜${s.role || ""}）\n  S：${clip(s.S, 90)}\n  A：${clip(s.A, 150)}\n  R：${clip(s.R, 120)}`;
  }
  function clip(t, n) {
    const x = String(t || "").replace(/\s+/g, " ");
    return x.length > n ? x.slice(0, n) + "…" : x;
  }
  /** 全场档案：只给标题+结果，控制长度 */
  function briefAll() {
    const ss = stories();
    if (!ss.length) return "";
    return ss.map((s) => `[${s.id}] ${s.title}｜${s.period || ""}｜结果：${clip(s.R, 100)}`).join("\n");
  }
  /** 单题档案：给指定卡的完整信息 */
  function briefFor(ids) {
    const ss = stories();
    const pick = String(ids || "").split(/[,，、\s]+/).filter(Boolean);
    const chosen = ss.filter((s) => pick.includes(s.id));
    const pool = chosen.length ? chosen : ss.slice(0, 3);
    return pool.map((s) => {
      const d = Array.isArray(s.depth) ? s.depth.map((x) => `  · 追问「${x.q}」→ ${x.a}`).join("\n") : "";
      return `[${s.id}] ${s.title}（${s.period || ""}｜${s.role || ""}）\n  S：${s.S || ""}\n  T：${s.T || ""}\n  A：${s.A || ""}\n  R：${s.R || ""}${d ? "\n  深挖：\n" + d : ""}`;
    }).join("\n\n");
  }
  function profileHead() {
    return "候选人画像：某港校商务信息系统硕士 2027 届；本科某双一流高校工商管理，加权均分 86.59/100，GPA 3.37。\n技能：Python / SQL / R / FineBI / Tableau；提示词工程与 AI 工作流；主修企业生成式人工智能、系统分析与设计、数据可视化。";
  }

  /* ---------------- 提示词 ---------------- */
  const SYS_QUESTIONS = `你是中国校招面试的资深面试官兼求职教练，服务对象是 2027 届硕士应届生J同学。任务是"押题"：预测目标公司目标岗位真实会问到的问题，输出题单（这一步不写讲稿）。

铁律（违反输出作废）：
1. 只能使用候选人档案里真实存在的经历、数字、课程，严禁编造新的公司/项目/数字/证书/论文结论。
2. 题目必须贴合"这家公司 × 这个岗位"：优先业务场景题、岗位专业题、简历深挖题、动机匹配题；通用性格题最多 1 道。
3. dur 代表这题值得讲多久（秒），只能取 180 / 240 / 300。
4. brief 是这道题的 5 分钟回答骨架，5–7 段；每段 {h: 段标题 ≤10 字, pt: 这段要讲什么 ≤45 字，必须点明用哪张素材卡或哪个数字}。
5. probes 给 2–3 条面试官在这个回答之后最可能追的问题（要像真人问话，不要教科书式）。
6. AI 时代题型：must 里至少 1 道 AI 相关题（AI 工具使用/认知/业务落地，参考素材卡 S51–S56）；若 JD 里出现 AI/大模型/Agent/数智化等词，must 里至少 2 道 AI 题。
7. 若下方提供「历史复盘教训」，则押题必须针对性布防：教训里提到被问倒的题型，同类型题必须进 must，且 probes 里要有那道翻车题的变体。
8. 只输出 JSON，不要 markdown 代码块，不要任何解释。`;

  function promptQuestions(f) {
    return `【候选人档案（这是唯一事实来源，编号必须原样引用）】
${profileHead()}
${briefAll()}

【目标岗位】
公司：${f.company}
岗位：${f.role}
面试轮次：${f.round}
岗位方向：${f.dirLabel}
面试日期：${f.date || "未定"}

【JD / 岗位描述】
${f.jd || "（未提供，按该公司该岗位的通用要求推断）"}

【公司与岗位情报（候选人收集的官网/新闻/宣讲/面经，可能为空）】
${f.intel || "（未提供）"}

【历史复盘教训（候选人过往面试被问倒/总结的教训，可能为空——非空时押题必须针对性布防）】
${(window.RECS||[]).filter(x=>x.kind==="review").sort((a,b)=>b.id-a.id).slice(0,3).map(x=>{const p=x.payload||{};return "· "+(p.company||"?")+" "+(p.date||"")+"：被问倒——"+((p.miss||"无").replace(/\n/g,"；"))+"；教训——"+((p.lesson||"无").replace(/\n/g,"；"));}).join("\n")||"（暂无复盘记录）"}

【输出要求】
生成 ${f.count} 道题，按 must / high / maybe 分档（must≈45%，high≈35%，maybe≈20%），档内按"被问概率 × 对结果影响"降序。
fit.job：该岗位最看重的 3 件事（顿号分隔，每件 ≤8 字）。
fit.match：候选人最硬的一条证据（带数字）。
fit.gap：最可能被质疑的短板（诚实、具体，别写套话）。
fit.angle：一句话人设（≤24 字）。

严格输出：
{"fit":{"job":"","match":"","gap":"","angle":""},"must":[{"q":"中文题目","en":"English version","why":"这题在筛什么+为什么这家公司会问","dur":300,"mine":"S1,S3","brief":[{"h":"","pt":""}],"probes":["",""]}],"high":[],"maybe":[]}`;
  }

  const SYS_SCRIPT = `你是资深面试教练，正在为学生写一段"可以直接念出来"的面试口述稿。

铁律（违反输出作废）：
1. 总字数 900–1100 个汉字（按 200 字/分钟约 4.5–5.5 分钟）。
2. 分 6–8 段，每段 {t: 时间轴如 "0–45s", h: 段标题 ≤10 字, s: 逐字稿 120–200 字, tip: 说法提示 ≤28 字（语速/停顿/重音/表情）}。
3. 第一人称口语：可以有"其实""当时""我印象特别深""说白了"这类自然连接，禁止"综上所述""赋能""闭环抓手"等书面套话。
4. 每段都要落到具体动作或数字；数字只能来自候选人档案，档案里没有的数字一律不写。
5. 结构顺序：开场先给结论 → 背景与任务 → 动作一（怎么想的+怎么做的）→ 动作二 → 结果与验证 → 复盘（学到什么/如果重来会怎么改）→ 落到目标岗位。
6. 全程不出现"这个问题我想从三个方面回答"这类播报式过渡。
7. 只输出 JSON：{"segs":[{"t":"","h":"","s":"","tip":""}]}`;

  function promptScript(it, f, durSec) {
    const words = Math.round((durSec / 60) * 205);
    const lo = Math.round(words * 0.9), hi = Math.round(words * 1.1);
    return `【题目】${it.q}
【英文版】${it.en || "（无）"}
【这题在筛什么】${it.why || ""}
【目标时长】${durSec} 秒（约 ${lo}–${hi} 字）
【已定的骨架（可按内容微调，但主线不变）】
${(it.brief || []).map((b, i) => `${i + 1}. ${b.h}：${b.pt}`).join("\n") || "（无，自行设计）"}

【可用素材（唯一事实来源，必须原样使用其中的数字）】
${briefFor(it.mine)}

【目标岗位】${f.company} · ${f.role}｜${f.round}｜方向：${f.dirLabel}
${f.jd ? "【JD 要点】\n" + clip(f.jd, 700) : ""}

请按铁律写 ${durSec} 秒的口述稿。记住：这是给学生照着练的口语稿，不是答题要点。`;
  }

  const SYS_REVISE = `你是面试教练，正在按学生的要求修改一段已成稿的口述稿。

铁律：
1. 学生的修改指令优先级最高。涉及个人经历的事实，一律以学生说的为准，即使与档案冲突——因为学生本人才是亲历者。
2. 保留原有的段落结构与时间轴逻辑；只有指令明确要求改变时长时才重排时间轴。
3. 字数按目标时长控制：5 分钟≈900–1100 字，4 分钟≈750–880 字，3 分钟≈550–650 字，90 秒≈280–330 字。
4. 不要整篇推倒重写成模板文：保留原稿里有个性的表达和真实细节，只改指令涉及的部分。
5. 只输出 JSON：{"note":"一句话说明改了什么","segs":[{"t":"","h":"","s":"","tip":""}]}`;

  function promptRevise(it, cmd, cur, durSec) {
    const words = Math.round((durSec / 60) * 205);
    return `【原题】${it.q}
【目标岗位】${META.company} · ${META.role}
【当前时长】${durSec} 秒（目标 ${Math.round(words * 0.9)}–${Math.round(words * 1.1)} 字）
【学生这次的修改要求】
${cmd}

【当前讲稿（JSON）】
${JSON.stringify({ segs: cur }, null, 0)}

【可用事实（学生指令之外的补充依据）】
${briefFor(it.mine)}

按学生要求改，输出 JSON。`;
  }

  /* ---------------- 模型 ---------------- */
  async function loadModels(force) {
    const sel = $("pModel");
    if (!sel) return;
    if (MODELS.length && !force) return;
    if (!cloud || !cloud.llm) {
      sel.innerHTML = `<option value="auto">Auto（默认）</option>`;
      return;
    }
    try {
      const list = await cloud.llm.models.list();
      MODELS = (list || []).filter((m) => m && m.enabled !== false && m.disabled !== true && m.id);
      if (!MODELS.length) { sel.innerHTML = `<option value="auto">Auto</option>`; return; }
      const prefer = ["glm-5.3-flash", "deepseek-v4-flash", "minimax-m3.1-flash", "auto"];
      let def = "";
      for (const p of prefer) { const hit = MODELS.find((m) => m.id === p); if (hit) { def = hit.id; break; } }
      if (!def) def = MODELS[0].id;
      sel.innerHTML = MODELS.map((m) => `<option value="${e(m.id)}"${m.id === def ? " selected" : ""}>${e(m.name || m.id)}</option>`).join("");
    } catch (err) {
      sel.innerHTML = `<option value="auto">Auto</option>`;
    }
  }

  /* ---------------- JSON ---------------- */
  function parseJSON(raw) {
    let t = String(raw || "").trim();
    t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("模型没有返回 JSON");
    let body = t.slice(a, b + 1);
    try { return JSON.parse(body); } catch (err) {}
    body = body.replace(/,\s*([}\]])/g, "$1");
    try { return JSON.parse(body); } catch (err) { throw new Error("JSON 解析失败：" + err.message); }
  }

  function normalizePack(raw) {
    const p = raw || {};
    const fit = p.fit || p["岗位画像"] || {};
    const out = {
      fit: {
        job: fit.job || fit["岗位最看重"] || "",
        match: fit.match || fit["匹配点"] || "",
        gap: fit.gap || fit["短板"] || "",
        angle: fit.angle || fit["定位"] || "",
      },
      must: [], high: [], maybe: [],
    };
    const pick = (...keys) => { for (const k of keys) { if (Array.isArray(p[k]) && p[k].length) return p[k]; } return []; };
    out.must = pick("must", "必考", "必考题", "core");
    out.high = pick("high", "高频", "高频题", "likely");
    out.maybe = pick("maybe", "可能", "可能题", "bonus", "possible");
    if (!out.must.length && !out.high.length && !out.maybe.length && Array.isArray(p.questions)) {
      p.questions.forEach((q) => {
        const tier = String(q.tier || q.level || q["优先级"] || "").toLowerCase();
        const bucket = /必|must|core/.test(tier) ? out.must : /高|high|likely/.test(tier) ? out.high : out.maybe;
        bucket.push(q);
      });
    }
    ["must", "high", "maybe"].forEach((k) => {
      out[k] = out[k].map((it) => ({
        q: it.q || it.question || it["题目"] || "",
        en: it.en || it.english || "",
        why: it.why || it.reason || it["考察点"] || "",
        dur: Number(it.dur || it["时长"] || 300) || 300,
        mine: it.mine || it.story || "",
        brief: (Array.isArray(it.brief) ? it.brief : []).map((b) => (typeof b === "string" ? { h: "", pt: b } : { h: b.h || b["段"] || "", pt: b.pt || b.point || b["要点"] || "" })),
        probes: (Array.isArray(it.probes) ? it.probes : []).map((x) => (typeof x === "string" ? x : x.q || x["追问"] || "")).filter(Boolean),
        script: null,
      })).filter((x) => x.q);
    });
    return out;
  }

  function normalizeScript(raw) {
    const segs = (raw && (raw.segs || raw["段落"] || raw.steps)) || [];
    const out = segs.map((x) => (typeof x === "string"
      ? { t: "", h: "", s: x, tip: "" }
      : { t: x.t || x.time || x["时间"] || "", h: x.h || x.head || x["标题"] || "", s: x.s || x.say || x.text || x["内容"] || "", tip: x.tip || x["提示"] || "" }))
      .filter((x) => x.s);
    if (!out.length) throw new Error("模型没有返回段落");
    return out;
  }

  /* ---------------- LLM ---------------- */
  let ACTIVE = null;
  async function llmJSON(system, user, onTick) {
    const model = ($("pModel") && $("pModel").value) || "auto";
    const ctl = new AbortController();
    ACTIVE = ctl;
    const timer = setInterval(() => { try { onTick && onTick(); } catch (x) {} }, 400);
    try {
      const stream = cloud.llm.chat.completions.create({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        stream: true,
        temperature: 0.65,
        signal: ctl.signal,
      });
      let text = "";
      for await (const chunk of stream) {
        const d = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || {};
        if (d.content) { text += d.content; if (onTick) onTick(text); }
      }
      return { json: parseJSON(text), raw: text, model };
    } finally {
      clearInterval(timer);
      if (ACTIVE === ctl) ACTIVE = null;
    }
  }

  /* ---------------- 题单 ---------------- */
  async function runPredict() {
  if (DEMO_MODE) { alert("演示版（GitHub 静态版）不开放 AI 押题——完整版支持云端 AI 生成题单与 5 分钟长稿。"); return; }
    if (running) return;
    if (!session) { notify("请先登录（押题要读你的个人素材卡）"); if (typeof openMask === "function") openMask(); return; }
    if (!cloud) { notify(cloudErr || "云端不可用，请用线上链接访问"); return; }
    if (!stories().length) { notify("云端素材卡为空，请刷新页面重新登录以同步素材"); return; }
    const company = $("pCompany").value.trim();
    const role = $("pRole").value.trim();
    if (!company || !role) { notify("公司、岗位必填"); return; }
    const dirKey = $("pDir").value;
    const f = {
      company, role,
      round: $("pRound").value,
      dirLabel: (DIRS.find((d) => d[0] === dirKey) || ["", "未定"])[1],
      date: $("pDate").value.trim(),
      jd: $("pJD").value.trim(),
      intel: $("pIntel").value.trim(),
      count: ($("pCount") && $("pCount").value) || "12",
      dur: Number(($("pDur") && $("pDur").value) || 300),
    };
    notify("");
    $("pResult").innerHTML = "";
    $("pProgress").classList.add("on");
    $("pThink").textContent = "";
    setRunning(true);
    const t0 = Date.now();
    let len = 0;
    try {
      const r = await llmJSON(SYS_QUESTIONS, promptQuestions(f), (txt) => {
        if (typeof txt === "string") len = txt.length;
        $("pProgTxt").innerHTML = `正在出题单 · <b>${Math.round((Date.now() - t0) / 1000)}s</b> · 已接收 <b>${len}</b> 字`;
      });
      const pack = normalizePack(r.json);
      // 按用户选择的时长覆盖 dur
      ["must", "high", "maybe"].forEach((k) => pack[k].forEach((it) => { if (!it.dur || it.dur < 120) it.dur = f.dur; }));
      PACK = pack;
      META = { ...f, model: r.model };
      renderPack(pack, META, "pResult", true);
      $("pProgress").classList.remove("on");
      await insertRecord();
      renderHistory();
      notify(`题单已生成（${countAll(pack)} 题，按 5 分钟标准备稿）· 点每题里的「生成 5 分钟讲稿」开始写稿`, true);
    } catch (err) {
      notify("生成失败：" + ((err && err.message) || "未知错误"));
    } finally {
      setRunning(false);
    }
  }

  function countAll(p) { return (p.must || []).length + (p.high || []).length + (p.maybe || []).length; }

  function setRunning(on) {
    running = on;
    const b = $("pRunBtn"), s = $("pStopBtn");
    if (b) { b.disabled = on; b.textContent = on ? "生成中…" : "⚡ 生成押题清单"; }
    if (s) s.style.display = on ? "" : "none";
  }

  async function insertRecord() {
    try {
      const owner_name = (session && session.user && session.user.name) || null;
      const r = await cloud.database.from("jp_records").insert({ kind: "predict", payload: { ...META, pack: PACK }, owner_name }).select();
      if (r.error) { notify("题单已生成，但保存失败：" + (r.error.message || "")); return; }
      RECID = (r.data && r.data[0] && r.data[0].id) || null;
      if (typeof loadData === "function") await loadData();
    } catch (err) { notify("题单已生成，但保存失败：" + (err.message || "")); }
  }

  async function persist() {
    if (!RECID || !PACK) return;
    try {
      const r = await cloud.database.from("jp_records").update({ payload: { ...META, pack: PACK } }).eq("id", RECID);
      if (r && r.error) notify("本地已更新，云端保存失败：" + (r.error.message || ""));
      else { const row = (typeof RECS !== "undefined" ? RECS : []).find((x) => String(x.id) === String(RECID)); if (row) row.payload = { ...META, pack: PACK }; }
    } catch (err) { notify("本地已更新，云端保存失败：" + (err.message || "")); }
  }

  /* ---------------- 单题讲稿 ---------------- */
  function get(tier, i) { return PACK && PACK[tier] && PACK[tier][i]; }
  function repaint(tier, i) {
    const key = `${tier}:${i}`;
    const old = document.querySelector(`.pcard[data-key="${key}"]`);
    if (!old) return;
    const wasOpen = old.classList.contains("open");
    const holder = document.createElement("div");
    holder.innerHTML = cardHtml(get(tier, i), tier, i);
    const fresh = holder.firstElementChild;
    if (fresh && wasOpen) fresh.classList.add("open");
    if (fresh) old.replaceWith(fresh);
  }
  function curSegs(it) {
    if (!it || !it.script) return null;
    const v = it.script.versions[it.script.cur] || it.script.versions[0];
    return v ? v.segs : null;
  }

  async function genScript(tier, i) {
    const it = get(tier, i);
    if (!it || BUSY[tier + i]) return;
    BUSY[tier + i] = true;
    const card = document.querySelector(`.pcard[data-key="${tier}:${i}"]`);
    const box = card && card.querySelector(".pb");
    const dur = it.dur || 300;
    const ph = box && box.querySelector('[data-slot="script"]');
    if (ph) ph.innerHTML = `<div class="writing"><span class="dotload"></span> 正在写 ${mmss(dur)} 讲稿…<span data-cnt class="small muted"></span></div>`;
    card && card.classList.add("open");
    try {
      const r = await llmJSON(SYS_SCRIPT, promptScript(it, META, dur), (txt) => {
        const c = typeof txt === "string" ? chars(txt) : 0;
        const el = ph && ph.querySelector("[data-cnt]");
        if (el) el.textContent = ` 已 ${c} 字`;
      });
      it.script = { versions: [{ label: "初稿", segs: normalizeScript(r.json) }], cur: 0 };
      await persist();
      repaint(tier, i);
      notify("讲稿已生成并保存", true);
    } catch (err) {
      if (ph) ph.innerHTML = `<p class="msg err">生成失败：${e((err && err.message) || "")}　<button class="btn ghost sm" data-act="gen" data-key="${tier}:${i}">重试</button></p>`;
    } finally {
      BUSY[tier + i] = false;
    }
  }

  async function reviseScript(tier, i, cmd) {
    const it = get(tier, i);
    if (!it || !cmd || BUSY[tier + i]) return;
    const segs = curSegs(it);
    if (!segs) { notify("先生成讲稿，再按你的要求改"); return; }
    BUSY[tier + i] = true;
    const card = document.querySelector(`.pcard[data-key="${tier}:${i}"]`);
    const slot = card && card.querySelector('[data-slot="script"]');
    if (slot) slot.insertAdjacentHTML("afterbegin", `<div class="writing" data-writing><span class="dotload"></span> 按你的要求重写中…<span data-cnt class="small muted"></span></div>`);
    const dur = it.dur || 300;
    try {
      const r = await llmJSON(SYS_REVISE, promptRevise(it, cmd, segs, dur), (txt) => {
        const el = slot && slot.querySelector("[data-cnt]");
        if (el) el.textContent = ` 已 ${chars(txt)} 字`;
      });
      const news = normalizeScript(r.json);
      const note = (r.json && r.json.note) || "";
      const label = note ? note.slice(0, 12) : "改：" + cmd.slice(0, 8);
      it.script.versions.push({ label, note, segs: news });
      it.script.cur = it.script.versions.length - 1;
      await persist();
      repaint(tier, i);
      notify(note ? "已改：" + note : "已按你的要求改好（旧版本保留，可切换对比）", true);
    } catch (err) {
      const w = slot && slot.querySelector("[data-writing]");
      if (w) w.outerHTML = `<p class="msg err">改写失败：${e((err && err.message) || "")}</p>`;
    } finally {
      BUSY[tier + i] = false;
    }
  }

  async function swapQuestion(tier, i) {
    const it = get(tier, i);
    if (!it || BUSY[tier + i]) return;
    BUSY[tier + i] = true;
    notify("正在换一道同档位的新题…");
    try {
      const f = { ...META, count: 6 };
      const r = await llmJSON(SYS_QUESTIONS, promptQuestions(f) + `\n\n【额外要求】只输出 2 道与下列题目不重复的新题，放在 must 数组里，档位保持 ${tier}。已问过的题目：\n${["must", "high", "maybe"].flatMap((k) => (PACK[k] || []).map((x) => "· " + x.q)).join("\n")}`, null);
      const p2 = normalizePack(r.json);
      const cand = (p2.must || [])[0];
      if (!cand) throw new Error("没有拿到新题");
      cand.dur = it.dur;
      PACK[tier][i] = cand;
      await persist();
      repaint(tier, i);
      notify("已换题：" + cand.q.slice(0, 30), true);
    } catch (err) {
      notify("换题失败：" + ((err && err.message) || ""));
    } finally {
      BUSY[tier + i] = false;
    }
  }

  async function batchMust() {
    if (!PACK) return;
    const todo = PACK.must.map((it, i) => [it, i]).filter(([it]) => !it.script);
    if (!todo.length) { notify("必考题的讲稿都已经写好了"); return; }
    notify(`开始顺序生成 ${todo.length} 篇必考讲稿，可以离开这一页，回来还在`);
    for (const [, i] of todo) {
      await genScript("must", i);
    }
    notify("必考讲稿已全部生成", true);
  }

  /* ---------------- 渲染 ---------------- */
  function durBadge(sec) {
    const n = Number(sec) || 300;
    const cls = n >= 280 ? "do" : n >= 200 ? "db" : "dg";
    return `<span class="dur ${cls}">⏱ ${mmss(n)}</span>`;
  }

  function segsHtml(segs, it) {
    const total = segs.reduce((a, s) => a + chars(s.s), 0);
    return `<div class="segs">
      ${segs.map((s) => `<div class="seg">
        <div class="segh"><span class="st">${e(s.t)}</span><b>${e(s.h)}</b><span class="segw">${chars(s.s)} 字</span></div>
        <p class="segtext">${e(s.s)}</p>
        ${s.tip ? `<div class="segtip">💬 ${e(s.tip)}</div>` : ""}
      </div>`).join("")}
      <div class="segfoot">全文 ${total} 字 · 按 210 字/分钟约 <b>${mmss(secByChars(total))}</b>${total < 700 ? " · ⚠️ 偏短，建议再扩写" : ""}</div>
    </div>`;
  }

  function versHtml(it, tier, i) {
    const v = it.script;
    if (!v || v.versions.length < 2) return "";
    return `<div class="vers"><b>版本</b>${v.versions.map((x, n) =>
      `<button class="vbtn${n === v.cur ? " on" : ""}" data-act="ver" data-key="${tier}:${i}" data-ver="${n}" title="${e(x.note || "")}">${e(x.label)}</button>`).join("")}</div>`;
  }

  function cardHtml(it, tier, i) {
    const meta = TIERS.find((t) => t[0] === tier) || TIERS[0];
    const key = `${tier}:${i}`;
    const segs = curSegs(it);
    const mine = String(it.mine || "").split(/[,，、\s]+/).filter(Boolean)
      .map((s) => `<span class="chip" data-act="jump" data-sid="${e(s)}">🧩 ${e(s)}</span>`).join("");
    const brief = (it.brief || []).map((b) => `<li><b>${e(b.h)}</b>　${e(b.pt)}</li>`).join("");
    const probes = (it.probes || []).map((x) => `<span class="probe">${e(x)}</span>`).join("");
    return `<div class="pcard ${segs ? "hasScript" : ""}" data-key="${key}">
      <div class="ph" data-act="toggle" data-key="${key}">
        <span class="n">${String(i + 1).padStart(2, "0")}</span>
        <span class="chip ${meta[2]}">${meta[3]} ${meta[1]}</span>
        <span class="t">${e(it.q)}</span>
        ${durBadge(it.dur)}
        <span class="stflag">${segs ? "已成稿 " + chars(segs.map((s) => s.s).join("")) + " 字" : "待备稿"}</span>
      </div>
      <div class="pb">
        ${it.en ? `<p class="enq"><span class="en-tag">EN</span>${e(it.en)}</p>` : ""}
        ${it.why ? `<div class="lbl">考察点 / 为什么押这题</div><p class="small">${e(it.why)}</p>` : ""}
        ${brief ? `<div class="lbl">5 分钟骨架</div><ol class="brieflist">${brief}</ol>` : ""}
        ${probes ? `<div class="lbl">可能的追问</div><div class="probes">${probes}</div>` : ""}
        ${mine ? `<div class="lbl">挂载素材</div><div>${mine}</div>` : ""}

        <div data-slot="script">${segs ? `<div class="lbl">口述稿 <span class="small muted">（可直接照着练）</span></div>${versHtml(it, tier, i)}${segsHtml(segs, it)}` : ""}</div>

        <div class="pacts">
          ${segs
            ? `<button class="btn ghost sm" data-act="gen" data-key="${key}">重写整篇</button>
               <button class="btn ghost sm" data-act="copy" data-key="${key}">复制讲稿</button>`
            : `<button class="btn sm" data-act="gen" data-key="${key}">✍️ 生成 ${mmss(it.dur || 300)} 讲稿</button>`}
          <button class="btn ghost sm" data-act="swap" data-key="${key}">换一道题</button>
        </div>

        <div class="revbox">
          <div class="revhead">✏️ 哪里不对，直接说，我按你的真实情况改</div>
          <div class="qchips">${QUICK.map((q) => `<button class="qchip" data-act="qc" data-key="${key}" data-qc="${e(q[0])}">${e(q[1])}</button>`).join("")}</div>
          <textarea class="revinput" data-rev="${key}" placeholder="例如：楼栋分级其实是按开通率不是单量；我在某德系汽车零部件企业只管会议和看板，不负责进度；这段话太书面了，改口语一些；压到 3 分钟"></textarea>
          <div class="revacts">
            <button class="btn sm" data-act="revise" data-key="${key}">按我的要求改这题</button>
            <span class="small muted">改完保留旧版本，可切换对比、可再改</span>
          </div>
        </div>
      </div>
    </div>`;
  }

  function renderPack(pack, meta, hostId) {
    const host = $(hostId);
    if (!host) return;
    const fit = pack.fit || {};
    let html = "";
    if (fit.job || fit.match || fit.angle) {
      html += `<div class="fit"><h3>🎯 岗位画像 × 你的定位</h3><div class="rows">
        ${fit.job ? `<b>岗位最看重</b><span>${e(fit.job)}</span>` : ""}
        ${fit.match ? `<b>你的最强项</b><span>${e(fit.match)}</span>` : ""}
        ${fit.gap ? `<b>可能被质疑</b><span>${e(fit.gap)}</span>` : ""}
        ${fit.angle ? `<b>一句话人设</b><span>${e(fit.angle)}</span>` : ""}
      </div></div>`;
    }
    html += `<div class="packbar">
      <span class="chip pub">押题包</span>
      <b>${e(meta.company)} · ${e(meta.role)}</b>
      <span class="small muted">${e(meta.round || "")}${meta.date ? "｜" + e(meta.date) : ""}｜${countAll(pack)} 题｜备稿标准 ${mmss(meta.dur || 300)}｜${e(meta.model || "auto")}</span>
      <span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn sm" data-act="batch" data-host="${hostId}">批量生成必考讲稿</button>
      </span>
    </div>
    <div class="mini-tip">每题两阶段：先有骨架，再生成 900–1100 字的 5 分钟口述稿；稿子不对就在框里说哪里不对，我按你的真实情况改。</div>`;
    if (hostId === "pResult") {
      TIERS.forEach(([key, label, cls, dot]) => {
        const arr = pack[key] || [];
        if (!arr.length) return;
        html += `<div class="tier"><h3>${dot} ${label}</h3><span class="cnt">${arr.length} 题</span></div>`;
        arr.forEach((it, i) => { html += cardHtml(it, key, i); });
      });
    }
    host.innerHTML = html;
    if (hostId === "pResult") {
      const f = host.querySelector(".pcard");
      if (f) f.classList.add("open");
    }
  }

  /* ---------------- 事件委托 ---------------- */
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const key = el.dataset.key || "";
    const [tier, iStr] = key.split(":");
    const i = Number(iStr);
    if (act === "toggle") {
      const c = el.closest(".pcard");
      if (c) c.classList.toggle("open");
    } else if (act === "gen") {
      ev.stopPropagation(); genScript(tier, i);
    } else if (act === "revise") {
      ev.stopPropagation();
      const box = el.closest(".revbox");
      const ta = box && box.querySelector("[data-rev]");
      const cmd = ta ? ta.value.trim() : "";
      if (!cmd) { ta && ta.focus(); notify("先写一句要改什么，再点改"); return; }
      reviseScript(tier, i, cmd);
    } else if (act === "qc") {
      ev.stopPropagation();
      const box = el.closest(".revbox");
      const ta = box && box.querySelector("[data-rev]");
      if (ta) { ta.value = el.dataset.qc + ta.value; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    } else if (act === "ver") {
      ev.stopPropagation();
      const it = get(tier, i);
      if (!it || !it.script) return;
      it.script.cur = Number(el.dataset.ver) || 0;
      repaint(tier, i);
    } else if (act === "copy") {
      ev.stopPropagation(); copyCard(key);
    } else if (act === "swap") {
      ev.stopPropagation(); swapQuestion(tier, i);
    } else if (act === "batch") {
      ev.stopPropagation(); batchMust();
    } else if (act === "jump") {
      ev.stopPropagation();
      if (typeof jumpStory === "function") jumpStory(el.dataset.sid);
    }
  });

  function copyCard(key) {
    const [tier, i] = key.split(":");
    const it = get(tier, Number(i));
    const segs = curSegs(it);
    if (!it || !segs) return;
    const txt = `【${it.q}】\n` + segs.map((s) => `${s.t ? "[" + s.t + "] " : ""}${s.h ? s.h + "：" : ""}${s.s}`).join("\n\n");
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(
      () => notify("已复制整篇讲稿", true),
      () => notify("复制失败，请手动选中")
    );
  }

  /* ---------------- 历史 ---------------- */
  function renderHistory() {
    loadModels();
    const box = $("predictList");
    if (!box) return;
    if (!session) { box.innerHTML = typeof gateHtml === "function" ? gateHtml("AI 押题") : ""; return; }
    const rows = (typeof RECS !== "undefined" ? RECS : []).filter((x) => x.kind === "predict");
    let html = `<h3 style="margin-top:22px">📚 历史押题包（${rows.length}）</h3>`;
    if (!rows.length) {
      box.innerHTML = html + `<div class="empty">还没有押题包。上面填公司和岗位，点「生成押题清单」——先拿到题单和 5 分钟骨架，再逐题生成口述稿。</div>`;
      return;
    }
    html += rows.map((r) => {
      const p = r.payload || {};
      const pk = p.pack || {};
      const n = countAll(pk);
      const done = ["must", "high", "maybe"].reduce((a, k) => a + (pk[k] || []).filter((x) => x.script).length, 0);
      const when = r.created_at ? new Date(r.created_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      return `<div class="record">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <b>${e(p.company || "—")} · ${e(p.role || "")}</b>
          <span class="small muted">${e(p.round || "")}${p.date ? "｜" + e(p.date) : ""}｜${n} 题｜已成稿 ${done}</span>
          <span class="small muted">${when}</span>
          <span style="margin-left:auto;display:flex;gap:6px">
            <button class="btn ghost sm" data-act="hist" data-id="${r.id}">查看</button>
            <button class="btn del sm" onclick="delRec(${r.id},'predict')">删除</button>
          </span>
        </div>
        <div id="hist-${r.id}"></div>
      </div>`;
    }).join("");
    box.innerHTML = html;
  }

  function viewHist(id) {
    const r = (typeof RECS !== "undefined" ? RECS : []).find((x) => String(x.id) === String(id));
    if (!r || !r.payload || !r.payload.pack) return;
    const host = $("hist-" + id);
    if (!host) return;
    if (host.innerHTML) { host.innerHTML = ""; return; }
    PACK = r.payload.pack;
    META = r.payload;
    RECID = r.id;
    renderPack(r.payload.pack, r.payload, "hist-" + id);
  }

  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act='hist']");
    if (el) viewHist(el.dataset.id);
  });

  /* ---------------- init ---------------- */
  function init() {
    const r = $("pRound");
    if (r && !r.options.length) r.innerHTML = ROUNDS.map((x) => `<option>${x}</option>`).join("");
    const d = $("pDir");
    if (d && !d.options.length) d.innerHTML = DIRS.map((x) => `<option value="${x[0]}">${x[1]}</option>`).join("");
    loadModels();
    ["pCompany", "pRole"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") runPredict(); });
    });
  }

  window.JPAI = { render: renderHistory, run: runPredict, stop: () => {}, toggle: () => {}, copy: () => {}, view: viewHist };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
