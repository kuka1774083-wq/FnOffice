const ids=['onlyOfficeUrl','onlyOfficePort','distinguishMobile','browserOnlyOfficeMode','onlyOfficeImage','callbackImage','publicBaseUrl','jwtSecret','jwtHeader','jwtInBody','coEditingMode','forceSave','maxGlobalDocuments','maxUserDocuments','sessionTtlMinutes'];
// The gateway opens the root entry at /app/FnOffice (without a trailing slash).
// Relative URLs would therefore resolve to /app/api/* and leave every setting
// field empty. Keep API calls anchored to the registered gateway prefix.
const apiBase='/app/FnOffice';
async function load(preserveStatus=false){
  const status=document.getElementById('status');
  try{
    const r=await fetch(`${apiBase}/api/config`,{cache:'no-store'});
    const c=await r.json();
    if(!r.ok) throw new Error(c.message||c.error||`HTTP ${r.status}`);
    document.getElementById('appVersion').textContent=`版本 ${c.appVersion||'未知'}`;
    for(const id of ids){const e=document.getElementById(id);if(e.type==='checkbox')e.checked=!!c[id];else e.value=c[id]??'';}
    try { const h=await fetch(`${apiBase}/api/health`,{cache:'no-store'}); const health=await h.json(); document.getElementById('onlyOfficeVersion').textContent=health.onlyOfficeVersion||(health.reason==='onlyoffice_unreachable'?'服务未连接':'未配置'); } catch { document.getElementById('onlyOfficeVersion').textContent='未配置'; }
    if(!preserveStatus) status.textContent='';
  }catch(e){status.textContent=`读取设置失败：${e.message}`;}
}
document.getElementById('save').onclick=async()=>{
  const c={};for(const id of ids){const e=document.getElementById(id);c[id]=e.type==='checkbox'?e.checked:e.type==='number'?Number(e.value):e.value;}
  const status=document.getElementById('status');
  status.textContent='正在保存…';
  const r=await fetch(`${apiBase}/api/config`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(c)});
  if(r.ok){
    status.textContent='已保存并同步 OnlyOffice。';
    await load(true);
    window.setTimeout(()=>{if(status.textContent==='已保存并同步 OnlyOffice。')status.textContent='';},5000);
  } else status.textContent='保存失败，请确认管理员权限和端口。';
};
const testButton=document.getElementById('testConnection');
if(testButton) testButton.onclick=async()=>{const status=document.getElementById('status');status.textContent='正在测试…';try{const r=await fetch(`${apiBase}/api/health`);const d=await r.json();status.textContent=r.ok?'OnlyOffice 已连接。':`OnlyOffice 未连接：${d.reason||'服务未就绪'}`;}catch(e){status.textContent=`连接测试失败：${e.message}`;}};
const sessionsBox=document.getElementById('onlineSessions');
async function loadSessions(){if(!sessionsBox)return;try{const r=await fetch(`${apiBase}/api/online-sessions`);const d=await r.json();if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);sessionsBox.textContent=d.sessions.length?d.sessions.map(s=>`${s.online?'在线':'离线'} | ${s.username} | ${s.path} | 空闲 ${s.idleSeconds}s${s.forceSavePending?' | 正在保存':''}`).join('\n'):'当前没有编辑会话';}catch(e){sessionsBox.textContent=`读取失败：${e.message}`;}}
const refreshSessions=document.getElementById('refreshSessions');
if(refreshSessions)refreshSessions.onclick=loadSessions;
loadSessions();
setInterval(loadSessions,10000);
const copyButton=document.getElementById('copyCompose');
if(copyButton) copyButton.onclick=async()=>{const target=document.getElementById('composeExample');const status=document.getElementById('tutorialStatus');try{await navigator.clipboard.writeText(target.textContent);status.textContent='已复制，可直接粘贴到飞牛 Docker Compose 配置。';}catch{status.textContent='浏览器禁止自动复制，请手动选择下方 YAML。';}};
load();
