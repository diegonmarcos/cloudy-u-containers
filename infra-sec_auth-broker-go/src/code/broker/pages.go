package broker

// The two sign-in pages, byte for byte as the Python service serves them (placeholders __LABEL__ and __PREFIX__).

const devicePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in with __LABEL__</title><style>
:root{--bg:#f6f7f9;--fg:#15171a;--card:#fff;--line:#d9dde3;--acc:#2b6cb0}
@media (prefers-color-scheme:dark){:root{--bg:#101215;--fg:#e8eaed;--card:#181b20;--line:#2c3139;--acc:#7fb2ee}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}
main{width:min(92vw,380px);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:1.15rem;margin:0 0 12px}#code{font:700 2rem/1.2 ui-monospace,monospace;letter-spacing:.12em;text-align:center;margin:14px 0}
a{color:var(--acc)}#st{font-size:.85rem;opacity:.8;min-height:1.2em}</style></head><body><main>
<h1>Sign in with __LABEL__</h1><div id="body">Requesting a code&hellip;</div><div id="st"></div></main>
<script>(function(){
var P="__PREFIX__",RD=new URLSearchParams(location.search).get("rd")||"/",$=function(i){return document.getElementById(i)};
function post(u,b){return fetch(P+u,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Requested-With":"sso"},body:JSON.stringify(b||{})}).then(function(r){return r.json().then(function(j){j._s=r.status;return j})})}
function fail(m){$("st").textContent=m;$("body").innerHTML='<a href="'+P+'/start?rd='+encodeURIComponent(RD)+'">Try again</a>'}
post("/device").then(function(d){
 if(!d.sid){return fail("Could not start sign-in ("+(d.error||d._s)+").")}
 $("body").innerHTML='Open <a id="l" target="_blank" rel="noopener"></a> and enter this code:<div id="code"></div>';
 $("l").href=d.verification_uri;$("l").textContent=d.verification_uri;$("code").textContent=d.user_code;
 $("st").textContent="Waiting for approval…";
 var t=setInterval(function(){post("/poll",{sid:d.sid,rd:RD}).then(function(r){
  if(r.status==="pending")return;clearInterval(t);
  if(r.status==="ok"){$("st").textContent="Signed in.";location.href=r.rd||"/";return}
  fail(r.status==="forbidden"?"This account is not allowed.":r.status==="expired"?"The code expired.":"Sign-in was denied.")
 }).catch(function(){})},Math.max(d.interval,3)*1000+500)
}).catch(function(){fail("Network error.")});
})();</script></body></html>`

const emailPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in with Email code</title><style>
:root{--bg:#f6f7f9;--fg:#15171a;--card:#fff;--line:#d9dde3;--acc:#2b6cb0}
@media (prefers-color-scheme:dark){:root{--bg:#101215;--fg:#e8eaed;--card:#181b20;--line:#2c3139;--acc:#7fb2ee}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}
main{width:min(92vw,380px);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:1.15rem;margin:0 0 12px}input,button{font:inherit;width:100%;box-sizing:border-box;padding:10px;margin:6px 0;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
button{background:var(--acc);color:#fff;border:0;cursor:pointer}a{color:var(--acc)}#st{font-size:.85rem;opacity:.85;min-height:1.2em}</style></head><body><main>
<h1>Sign in with Email code</h1>
<form id="f1"><label>Email address<input id="em" type="email" autocomplete="email" required></label><button type="submit">Send code</button></form>
<form id="f2" hidden><label>6-digit code<input id="cd" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button type="submit">Sign in</button></form>
<div id="st" role="status"></div></main>
<script>(function(){
var P="__PREFIX__",RD=new URLSearchParams(location.search).get("rd")||"/",$=function(i){return document.getElementById(i)},sid="";
function post(u,b){return fetch(P+u,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Requested-With":"sso"},body:JSON.stringify(b)}).then(function(r){return r.json().then(function(j){j._s=r.status;return j})})}
$("f1").onsubmit=function(e){e.preventDefault();$("st").textContent="Sending…";
 post("/request",{email:$("em").value}).then(function(d){
  if(!d.sid){$("st").textContent=d._s===429?"Too many requests. Try later.":"Could not start sign-in.";return}
  sid=d.sid;$("f1").hidden=true;$("f2").hidden=false;$("cd").focus();
  $("st").textContent="If the address is allowed, a code was sent. It is valid for 10 minutes."}).catch(function(){$("st").textContent="Network error."})};
$("f2").onsubmit=function(e){e.preventDefault();
 post("/verify",{sid:sid,code:$("cd").value,rd:RD}).then(function(r){
  if(r.status==="ok"){$("st").textContent="Signed in.";location.href=r.rd||"/";return}
  if(r.status==="wrong"){$("st").textContent="Wrong code.";return}
  $("st").innerHTML='Code expired or locked. <a href="'+P+'/start?rd='+encodeURIComponent(RD)+'">Start again</a>';$("f2").hidden=true
 }).catch(function(){$("st").textContent="Network error."})};
})();</script></body></html>`
