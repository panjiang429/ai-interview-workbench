/* ================= 题库引擎 v3 ================= */
(function(){
const Q = window.QBANK || [];
const CATS = [
  {k:"intro", name:"自我介绍 · 动机 · 规划"},
  {k:"pg",    name:"宝洁八大问"},
  {k:"beh",   name:"通用行为面"},
  {k:"hr",    name:"HR 面深挖"},
  {k:"sit",   name:"情景压力题"},
  {k:"grp",   name:"群面 / 无领导"},
  {k:"case",  name:"Case 面 / 商业实战", multi:["case_size","case_profit","case_enter","case_ab"]},
  {k:"data",  name:"数据岗硬技能", multi:["sql","stat","biz"]},
  {k:"ind",   name:"行业专项", multi:["ind_net","ind_fmcg","ind_fin","ind_cons","ind_mfg","ind_soe"]},
  {k:"ai",    name:"AI 时代面试", multi:["ai_use","ai_cog","ai_biz","ai_pm","ai_ethic","ai_career"]},
  {k:"pro",   name:"专业题库", multi:["ds","op","pm"]},
  {k:"deep",  name:"简历深挖链", multi:["deep_mohu","deep_valeo","deep_gl","deep_other"]},
  {k:"round", name:"分轮次准备", stat:"round"},
  {k:"eng",   name:"英文面试专区", stat:"eng"}
];
const SUBNAME = {
  ind_net:"互联网 / 科技", ind_fmcg:"快消 / 零售", ind_fin:"金融 / 券商 / 银行",
  ind_cons:"咨询 / 四大", ind_mfg:"制造 / 汽车", ind_soe:"国企 / 央企",
  ds:"商业分析 / 数据", op:"运营 / 增长", pm:"产品 / AI 产品",
  case_size:"市场规模估算", case_profit:"利润与成本拆解", case_enter:"进入与竞争", case_ab:"增长诊断与实验",
  ai_use:"AI 工具实操", ai_cog:"AI 认知与判断", ai_biz:"AI+业务落地",
  ai_pm:"AI 产品与评测", ai_ethic:"AI 伦理与边界", ai_career:"AI 时代职业发展",
  sql:"SQL 取数", stat:"统计与实验", biz:"指标体系与看板",
  deep_mohu:"某校园O2O平台 · 市场运营", deep_valeo:"某德系汽车零部件企业 · 项目助理", deep_gl:"某券商资管部 · 产品助理", deep_other:"某头部物流企业 / 学工 / 论文"
};
let cur="pg", curSub=null, search="", dfilter="all", ptimer=null;

function catDef(){ return CATS.find(c=>c.k===cur); }
function subsOf(c){ return c.multi || [c.k]; }
function poolFor(c,sub){ return c.multi ? Q.filter(x=>x.cat===sub) : Q.filter(x=>x.cat===c.k); }
const BLOB = new Map();
function blob(q){
  const k = q.cat+"|"+q.id;
  if(!BLOB.has(k)){
    BLOB.set(k, (q.q+" "+q.en+" "+q.sub+" "+q.id+" "+(q.mine||"")+" "+(q.why||"")+" "+
      (q.sc||[]).map(s=>s.join(" ")).join(" ")+" "+(q.fu||[]).join(" ")+" "+(q.trap||"")+" "+
      (q.var||[]).join(" ")+" "+(q.score?Object.values(q.score).join(" "):"")).toLowerCase());
  }
  return BLOB.get(k);
}
function matchQ(q){
  if(dfilter!=="all"){
    const d=q.dur;
    if(dfilter==="s" && d>45) return false;
    if(dfilter==="m" && (d<60||d>75)) return false;
    if(dfilter==="l" && d<90) return false;
  }
  if(!search) return true;
  return blob(q).includes(search.toLowerCase());
}
function durBadge(d){
  const c = d<=45 ? "dg" : (d<=75 ? "db" : "do");
  return `<span class="dur ${c}" title="建议回答时长">⏱ ${d}s</span>`;
}
function rng(s){ const m=String(s).match(/(\d+)\D+(\d+)/); return m ? [+m[1],+m[2]] : [0,0]; }
function qcard(q, globalSearch){
  const key = q.cat+"-"+q.id;
  const catChip = globalSearch ? `<span class="qno" style="background:#eef2ff;color:#4338ca">${esc(SUBNAME[q.cat]||q.sub)}</span>` : "";
  const rows = (q.sc||[]).map(s=>{
    const tip = String(s[0]).indexOf("⏱")===0;
    if(tip) return `<tr class="segtip"><td class="st">${esc(s[0])}</td><td class="sk">${esc(s[1])}</td><td class="sl">${esc(s[2])}</td></tr>`;
    const r = rng(s[0]);
    return `<tr class="seg" data-a="${r[0]}" data-b="${r[1]}"><td class="st">${esc(s[0])}</td><td class="sk">${esc(s[1])}</td><td class="sl">${esc(s[2])}</td></tr>`;
  }).join("");
  const lv = q.lv ? `<span class="lv" title="难度">${"★".repeat(q.lv)}${"☆".repeat(3-q.lv)}</span>` : "";
  const vars = (q.var||[]).length ? `<div style="margin:8px 12px 0"><b class="small">🔀 变体问法：</b><span class="small muted">${q.var.map(v=>esc(v)).join("　·　")}</span></div>` : "";
  const scoreHtml = q.score ? `<div style="margin:8px 12px 0"><b class="small">📊 评分锚点</b>
    <table class="scrtab"><tr><td class="sb">不及格</td><td>${esc(q.score.bad)}</td></tr>
    <tr><td class="so">合格</td><td>${esc(q.score.ok)}</td></tr>
    <tr><td class="sg">优秀</td><td>${esc(q.score.good)}</td></tr></table></div>` : "";
  return `<details class="qcard" data-key="${key}">
    <summary><span class="qno">${esc(q.id)}</span>${catChip}${lv}<span class="qq">${esc(q.q)}</span>${durBadge(q.dur)}${q.mine?`<span class="mlink" data-mine="${esc(q.mine)}" title="对应个人区素材卡，登录后点击直达">🧩 ${esc(q.mine)}</span>`:""}</summary>
    <p class="en small" style="margin:10px 12px 0"><span class="en-tag">EN</span>${esc(q.en)}</p>
    <p class="small" style="margin:8px 12px 0"><b>🎯 考察点：</b>${esc(q.why)}</p>
    ${q.mine?`<p class="small muted" style="margin:4px 12px 0">🧩 挂载素材：${esc(q.mine)}（个人区素材卡；登录后点 🧩 徽章直达对应卡片）</p>`:""}
    ${vars}
    <div style="margin:8px 12px"><table class="scr"><thead><tr><th style="width:64px">节奏</th><th style="width:96px">要点</th><th>讲稿（照这个节奏练）</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="small" style="margin:8px 12px 2px"><b>🔗 可能的追问</b></p>
    <ul class="small fulist">${(q.fu||[]).map(f=>`<li>${esc(f)}</li>`).join("")}</ul>
    ${scoreHtml}
    <p class="small" style="margin:8px 12px"><b>⚠️ 常见坑：</b>${esc(q.trap)}</p>
    <div data-myver="${key}"></div>
    <div class="prac"><button class="btn sm" data-prac="${key}" data-dur="${q.dur}">▶ 开始计时练习（${q.dur}s）</button><span class="pclock" id="clock-${key}"></span><span class="small muted" id="pseg-${key}"></span></div>
  </details>`;
}
function startPrac(key, dur){
  const card = document.querySelector('details[data-key="'+key+'"]');
  if(card) card.open = true;
  const clock = document.getElementById("clock-"+key), seg = document.getElementById("pseg-"+key);
  if(!clock || !card) return;
  if(ptimer) clearInterval(ptimer);
  const t0 = Date.now();
  const tick = ()=>{
    const el=(Date.now()-t0)/1000, left=Math.max(0,dur-el);
    clock.textContent = left>0 ? ("剩余 "+Math.ceil(left)+"s") : ("超时 +"+Math.floor(el-dur)+"s");
    clock.style.color = left>0 ? (left<10 ? "#d97706" : "#16a34a") : "#dc2626";
    let curName="";
    card.querySelectorAll("tr.seg").forEach(r=>{
      r.classList.remove("on");
      const a=+r.dataset.a, b=+r.dataset.b;
      if(el>=a && el<b){ r.classList.add("on"); curName=r.querySelector(".sk").textContent; }
    });
    seg.textContent = curName ? ("当前："+curName) : "";
    if(el > dur+60){ clearInterval(ptimer); ptimer=null; }
  };
  tick(); ptimer=setInterval(tick,300);
}
function renderNav(){
  document.getElementById("qcatnav").innerHTML = CATS.map(c=>
    `<button class="sbtn ${c.k===cur?"on":""}" data-cat="${c.k}">${c.name}</button>`).join("");
  const c = catDef();
  const sub2 = document.getElementById("qsub2");
  if(!c.stat && subsOf(c).length>1){
    if(!curSub || !subsOf(c).includes(curSub)) curSub = subsOf(c)[0];
    sub2.style.display="";
    sub2.innerHTML = subsOf(c).map(s=>
      `<button class="sbtn ${s===curSub?"on":""}" data-sub="${s}">${SUBNAME[s]||s} (${poolFor(c,s).length})</button>`).join("");
  } else {
    if(!c.stat && subsOf(c).length===1) curSub = c.k;
    sub2.style.display="none"; sub2.innerHTML="";
  }
}
function renderQ(){
  const c = catDef();
  ["round","eng"].forEach(s=>{ const e=document.getElementById("sub-"+s); if(e) e.style.display = (c.stat===s) ? "" : "none"; });
  const area = document.getElementById("qarea");
  if(c.stat){ area.style.display="none"; area.innerHTML=""; return; }
  area.style.display="";
  const searching = search.length>0;
  const pool = searching ? Q.filter(matchQ) : poolFor(c, curSub).filter(matchQ);
  const bySub = {};
  pool.forEach(q=>{ (bySub[q.sub]=bySub[q.sub]||[]).push(q); });
  let html = "";
  if(cur==="grp" && !searching && dfilter==="all") html += GRP_INTRO;
  if(!pool.length) html += `<p class="muted small">没有匹配的题目——换个关键词，或清除时长筛选。搜索时是在<b>全部 ${Q.length} 题</b>里找的。</p>`;
  html += Object.entries(bySub).map(([sub,qs])=>
    `<h3 class="subh">${searching ? (SUBNAME[qs[0].cat]||sub) : esc(sub)} <span class="small muted">${qs.length} 题</span></h3>` + qs.map(q=>qcard(q,searching)).join("")).join("");
  area.innerHTML = html;
  try{ document.dispatchEvent(new CustomEvent("qb:rendered")); }catch(e){}
}
function renderAll(){ renderNav(); renderQ(); }

const GRP_INTRO = `
  <div class="card"><h3 style="margin-top:0">群面流程与时间分配（典型 40 分钟案例讨论）</h3>
    <table><tr><th style="width:100px">阶段</th><th style="width:80px">时间</th><th>你要做的事</th></tr>
    <tr><td>读题</td><td>3–5 min</td><td>抓 3 个关键约束（预算/时间/必须达成的指标），写下自己的初步框架</td></tr>
    <tr><td>破冰</td><td>2 min</td><td>第一个发言的人有天然优势：给框架 + 提议分工与时间分配，别急着给结论</td></tr>
    <tr><td>讨论</td><td>20–25 min</td><td>贡献 2–3 个有信息量的观点，主动回应他人（「补充一下刚才 X 说的」），做推进者而非复读机</td></tr>
    <tr><td>收敛</td><td>5 min</td><td>主动做总结：结论 + 依据 + 风险 + 落地动作</td></tr>
    <tr><td>汇报</td><td>3–5 min</td><td>结构化输出：背景→结论→三条理由→一条风险</td></tr></table></div>
  <div class="grid2">
    <div class="card"><h3>角色怎么选</h3><ul>
      <li><b>Leader（推进者）</b>：适合有框架感、能控节奏的人。风险：抢不到或压不住场会扣分。</li>
      <li><b>Timer（时间官）</b>：最稳的加分位，边报时边推进（「还剩 10 分钟，我们先把方案定下来」）。</li>
      <li><b>Recorder（记录者）</b>：适合做最后总结的人，天然拿到汇报机会。</li>
      <li><b>Idea（观点贡献者）</b>：不想抢角色就把观点做深，2 个高质量观点足以进下一轮。</li></ul></div>
    <div class="card"><h3>黄金话术 & 禁忌</h3>
      <p><b>可用：</b>「我先搭个框架，大家补充」「我们把标准定一下再选方案」「时间还有 8 分钟，建议先收敛到两个方案」「我理解你的意思是……对吗？」</p>
      <p><b>禁忌：</b>全程不发言；打断别人；只反对不提方案；为了表现抢话；最后抢汇报却没参与讨论。</p>
      <p class="small muted">你的可用素材：某校园O2O平台从 0 开拓校区（天然适合「资源有限怎么增长」类案例）、某德系汽车零部件企业跨部门会议机制（适合「多方协调」类案例）。</p></div>
  </div>`;

document.addEventListener("click", e=>{
  const b = e.target.closest("[data-prac]");
  if(b){ startPrac(b.dataset.prac, +b.dataset.dur); return; }
  const m = e.target.closest(".mlink");
  if(m){
    if(typeof session!=="undefined" && session){ jumpStory(m.dataset.mine.split(" / ")[0].trim()); }
    else { alert("素材卡在个人区，请先登录"); openMask(); }
  }
});
document.getElementById("qcatnav").addEventListener("click", e=>{
  const b = e.target.closest("[data-cat]"); if(!b) return;
  cur = b.dataset.cat; curSub = null; renderAll();
});
document.getElementById("qsub2").addEventListener("click", e=>{
  const b = e.target.closest("[data-sub]"); if(!b) return;
  curSub = b.dataset.sub; renderNav(); renderQ();
});
document.getElementById("qSearch").addEventListener("input", e=>{ search = e.target.value.trim(); renderQ(); });
document.getElementById("durFilter").addEventListener("change", e=>{ dfilter = e.target.value; renderQ(); });

document.getElementById("qbCount").textContent = "共 "+Q.length+" 题 · 逐题含建议时长 / 分段讲稿 / 追问应对 / 常见坑 / 计时练习 · "+CATS.length+" 大类";
renderAll();
})();
