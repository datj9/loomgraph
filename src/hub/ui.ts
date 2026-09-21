// The loomgraph hub web UI: one self-contained HTML document, served by lg-hub
// on the same loopback origin as the API. No build step, no external requests,
// no framework - the same posture as the handoff HTML renderer.
//
// Auth: the browser holds a token the user pasted (minted with `lg-hub member
// add`), kept in localStorage and sent as `Authorization: Bearer`. There is no
// login endpoint and no loopback bypass; the API's token check is the only gate.
//
// Untrusted data (runs and events pushed by other members) is rendered with
// textContent / DOM nodes only - never innerHTML - so a hostile transcript
// cannot inject markup into this page.

const STYLE = `
:root { color-scheme: dark; --bg:#12141a; --panel:#1b1f29; --line:#2c3140; --fg:#e6e8ee; --muted:#8891a6; --accent:#6ea8fe; --ok:#5bd6a0; --bad:#ff8a8a; --warn:#f0dfae; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
header { display:flex; align-items:center; gap:.75rem; padding:.9rem 1.25rem; border-bottom:1px solid var(--line); }
header h1 { font-size:1.05rem; margin:0; letter-spacing:.02em; }
header .sp { flex:1; }
nav { display:flex; gap:.25rem; padding:.5rem 1rem; border-bottom:1px solid var(--line); }
nav button { background:none; border:0; color:var(--muted); padding:.4rem .8rem; border-radius:6px; cursor:pointer; font:inherit; }
nav button.active { background:var(--panel); color:var(--fg); }
main { max-width:60rem; margin:0 auto; padding:1.25rem; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:1rem 1.25rem; margin:0 0 1rem; }
h2 { font-size:1rem; margin:.2rem 0 .8rem; }
table { width:100%; border-collapse:collapse; }
th,td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
tr.click { cursor:pointer; }
tr.click:hover td { background:#20252f; }
.muted { color:var(--muted); }
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
.pill { display:inline-block; padding:.05rem .5rem; border-radius:999px; font-size:12px; border:1px solid var(--line); }
.pill.running,.pill.pending { color:var(--accent); border-color:var(--accent); }
.pill.succeeded { color:var(--ok); border-color:var(--ok); }
.pill.failed { color:var(--bad); border-color:var(--bad); }
.pill.paused { color:var(--warn); border-color:var(--warn); }
button.btn { background:var(--accent); color:#0a0d14; border:0; padding:.45rem .9rem; border-radius:6px; cursor:pointer; font:inherit; font-weight:600; }
button.ghost { background:none; border:1px solid var(--line); color:var(--fg); }
button.danger { background:none; border:1px solid var(--bad); color:var(--bad); }
input,select { background:#0f1219; border:1px solid var(--line); color:var(--fg); padding:.45rem .6rem; border-radius:6px; font:inherit; }
.row { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; }
.token-input { width:min(28rem,100%); }
.err { color:var(--bad); }
.ev { border-left:3px solid var(--line); padding:.35rem .75rem; margin:.35rem 0; background:#0f1219; border-radius:0 4px 4px 0; }
.ev .k { color:var(--accent); }
pre { white-space:pre-wrap; word-break:break-word; margin:.4rem 0; }
a.link { color:var(--accent); cursor:pointer; text-decoration:none; }
.notice { background:#153021; border:1px solid #2c6b48; color:#bfe9cf; padding:.6rem .8rem; border-radius:6px; }
`;

const SCRIPT = `
const TOKEN_KEY = "lg-hub-token";
let token = localStorage.getItem(TOKEN_KEY) || "";
let current = "runs";
const view = document.getElementById("view");
const nav = document.getElementById("nav");

function el(tag, attrs, children) {
  const n = document.createElement(tag);
  attrs = attrs || {};
  for (const k in attrs) {
    const v = attrs[k];
    if (v === null || v === undefined) continue;
    if (k === "text") n.textContent = v;
    else if (k === "class") n.className = v;
    else if (k.slice(0,2) === "on" && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  const list = children == null ? [] : (Array.isArray(children) ? children : [children]);
  for (const c of list) {
    if (c === null || c === undefined) continue;
    n.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
  return n;
}
function clear(node){ while (node.firstChild) node.removeChild(node.firstChild); }
function fmtTime(s){ if(!s) return ""; return String(s).replace("T"," ").replace(/\\.\\d+Z$/,"Z").slice(0,19); }

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ "content-type":"application/json", authorization:"Bearer "+token }, opts.headers||{});
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401) { token=""; localStorage.removeItem(TOKEN_KEY); renderGate("Token rejected. Paste a valid token."); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error((data && data.error) || ("HTTP "+res.status));
  return data;
}

function setActive(){ for (const b of nav.querySelectorAll("button")) b.classList.toggle("active", b.dataset.tab === current); }
function showError(msg){ view.appendChild(el("p",{class:"err",text:"Error: "+msg})); }

function renderGate(msg){
  current = "gate"; setActive(); clear(view);
  const input = el("input",{type:"password",placeholder:"lgt_...",class:"token-input mono"});
  const connect = () => { const t=input.value.trim(); if(!t) return; token=t; localStorage.setItem(TOKEN_KEY,token); route("runs"); };
  input.addEventListener("keydown", e => { if(e.key==="Enter") connect(); });
  view.appendChild(el("section",{class:"card"},[
    el("h2",{text:"Connect to the hub"}),
    el("p",{class:"muted",text: msg || "Paste a token. Mint one with: lg-hub member add ui --scopes read,admin"}),
    el("div",{class:"row"},[ input, el("button",{class:"btn",text:"Connect",onclick:connect}) ]),
  ]));
}

async function renderRuns(){
  clear(view);
  view.appendChild(el("h2",{text:"Runs"}));
  let data;
  try { data = await api("/v1/runs"); } catch(e){ if(e.message!=="unauthorized") showError(e.message); return; }
  const runs = data.runs || [];
  if (!runs.length){ view.appendChild(el("p",{class:"muted",text:"No runs yet. Runs pushed to the hub by any member appear here."})); return; }
  const rows = runs.map(r => el("tr",{class:"click",onclick:()=>renderRunDetail(r.member,r.runId)},[
    el("td",{class:"mono",text:r.member}),
    el("td",{text:r.graphName||"(unnamed)"}),
    el("td",{},[ el("span",{class:"pill "+r.status,text:r.status}) ]),
    el("td",{class:"mono muted",text:(r.runId||"").slice(0,12)}),
    el("td",{class:"muted",text:fmtTime(r.updatedAt)}),
  ]));
  const table = el("table",{},[
    el("thead",{},el("tr",{},[el("th",{text:"member"}),el("th",{text:"graph"}),el("th",{text:"status"}),el("th",{text:"run"}),el("th",{text:"updated"})])),
    el("tbody",{},rows),
  ]);
  view.appendChild(el("section",{class:"card"},table));
}

async function renderRunDetail(member,runId){
  clear(view);
  view.appendChild(el("div",{class:"row"},[ el("a",{class:"link",text:"< runs",onclick:renderRuns}), el("span",{class:"muted mono",text:member+" / "+runId.slice(0,12)}) ]));
  let data;
  try { data = await api("/v1/runs/"+encodeURIComponent(member)+"/"+encodeURIComponent(runId)); } catch(e){ if(e.message!=="unauthorized") showError(e.message); return; }
  const st = data.state || {};
  const nodes = st.nodes || {};
  const nodeRows = Object.keys(nodes).map(id => { const n=nodes[id]||{}; return el("tr",{},[
    el("td",{class:"mono",text:id}), el("td",{},[el("span",{class:"pill "+(n.status||""),text:n.status||"?"})]),
    el("td",{class:"muted",text:(n.attempts!=null?("attempt "+n.attempts):"")}),
  ]); });
  view.appendChild(el("section",{class:"card"},[
    el("h2",{text:"State"}),
    el("div",{class:"row"},[ el("span",{class:"pill "+(st.status||""),text:st.status||"?"}), el("span",{class:"muted",text:"graph: "+(st.graphName||"?")}), el("span",{class:"muted",text:"seq: "+(st.seq!=null?st.seq:"?")}) ]),
    nodeRows.length ? el("table",{},[el("thead",{},el("tr",{},[el("th",{text:"node"}),el("th",{text:"status"}),el("th",{text:""})])), el("tbody",{},nodeRows)]) : el("p",{class:"muted",text:"No node state recorded."}),
  ]));
  const events = data.events || [];
  const evNodes = events.map(line => {
    let ev={}; try { ev=JSON.parse(line); } catch(e){ ev={kind:"(unparseable)",raw:line}; }
    return el("div",{class:"ev"},[ el("span",{class:"k mono",text:(ev.kind||"?")}), el("span",{class:"muted mono",text:(ev.nodeId?(" "+ev.nodeId):"")+(ev.seq!=null?("  #"+ev.seq):"")}) ]);
  });
  view.appendChild(el("section",{class:"card"},[ el("h2",{text:"Events ("+events.length+")"}), evNodes.length?el("div",{},evNodes):el("p",{class:"muted",text:"No events."}) ]));
}

async function renderFeed(){
  clear(view);
  view.appendChild(el("h2",{text:"Activity"}));
  let data;
  try { data = await api("/v1/feed?limit=100"); } catch(e){ if(e.message!=="unauthorized") showError(e.message); return; }
  const items = data.items || [];
  if(!items.length){ view.appendChild(el("p",{class:"muted",text:"No activity yet."})); return; }
  const rows = items.map(it => el("div",{class:"ev"},[
    el("span",{class:"muted mono",text:fmtTime(it.ts)}), el("span",{class:"k mono",text:"  "+it.kind}), el("span",{class:"muted",text:"  "+it.member}),
  ]));
  view.appendChild(el("section",{class:"card"},rows));
}

async function renderMembers(){
  clear(view);
  view.appendChild(el("h2",{text:"Members"}));
  let data;
  try { data = await api("/v1/members"); }
  catch(e){ if(e.message==="unauthorized") return; showError(e.message==="forbidden"?"This token lacks the admin scope. Mint one with --scopes read,admin.":e.message); return; }
  const members = data.members || [];
  const rows = members.map(m => el("tr",{},[
    el("td",{class:"mono",text:m.keyId}), el("td",{text:m.member}),
    el("td",{},[ m.revokedAt ? el("span",{class:"pill failed",text:"revoked"}) : el("span",{class:"pill succeeded",text:"active"}) ]),
    el("td",{}, m.revokedAt ? null : el("button",{class:"danger",text:"revoke",onclick:async()=>{ try{ await api("/v1/members/"+encodeURIComponent(m.keyId)+"/revoke",{method:"POST"}); renderMembers(); }catch(e){ showError(e.message);} }})),
  ]));
  const table = el("table",{},[ el("thead",{},el("tr",{},[el("th",{text:"key id"}),el("th",{text:"name"}),el("th",{text:"status"}),el("th",{text:""})])), el("tbody",{},rows) ]);
  view.appendChild(el("section",{class:"card"},members.length?table:el("p",{class:"muted",text:"No members."})));

  const nameIn = el("input",{placeholder:"member name"});
  const scopeIn = el("input",{placeholder:"scopes (comma)",value:"ingest,read",class:"mono"});
  const out = el("div",{});
  const add = async () => {
    const name = nameIn.value.trim(); if(!name) return;
    const scopes = scopeIn.value.split(",").map(s=>s.trim()).filter(Boolean);
    try {
      const res = await api("/v1/members",{method:"POST",body:JSON.stringify({member:name,scopes})});
      clear(out);
      out.appendChild(el("div",{class:"notice"},[ el("div",{text:"Token for "+name+" (shown once, copy it now):"}), el("pre",{class:"mono",text:res.token}) ]));
      nameIn.value="";
      renderMembersRoster();
    } catch(e){ clear(out); out.appendChild(el("p",{class:"err",text:e.message})); }
  };
  view.appendChild(el("section",{class:"card"},[
    el("h2",{text:"Add member"}),
    el("div",{class:"row"},[ nameIn, scopeIn, el("button",{class:"btn",text:"Create + mint token",onclick:add}) ]),
    out,
  ]));
  async function renderMembersRoster(){ /* refresh roster table only, cheap re-render */ renderMembers(); }
}

function route(tab){ current = tab; setActive();
  if(!token){ renderGate(); return; }
  if(tab==="runs") renderRuns();
  else if(tab==="activity") renderFeed();
  else if(tab==="members") renderMembers();
}

for (const b of nav.querySelectorAll("button")) b.addEventListener("click", ()=>route(b.dataset.tab));
document.getElementById("logout").addEventListener("click", ()=>{ token=""; localStorage.removeItem(TOKEN_KEY); renderGate(); });

if(!token) renderGate(); else route("runs");
`;

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>loomgraph hub</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>loomgraph hub</h1>
  <span class="sp"></span>
  <button id="logout" class="ghost">disconnect</button>
</header>
<nav id="nav">
  <button data-tab="runs">Runs</button>
  <button data-tab="activity">Activity</button>
  <button data-tab="members">Members</button>
</nav>
<main id="view"></main>
<script type="module">${SCRIPT}</script>
</body>
</html>
`;
