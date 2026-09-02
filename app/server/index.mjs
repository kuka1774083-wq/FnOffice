import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { URL } from 'node:url';

const onlyOfficeHttpAgent = new http.Agent({keepAlive:true,maxSockets:100,keepAliveMsecs:30000});
const onlyOfficeHttpsAgent = new https.Agent({keepAlive:true,maxSockets:100,keepAliveMsecs:30000});

const appDest = process.env.TRIM_APPDEST || path.resolve(process.cwd());
const appName = path.basename(appDest);
const volumeRoot = path.dirname(path.dirname(appDest));
const persistentEtcDir = path.join(volumeRoot, '@appconf', appName);
const persistentVarDir = path.join(volumeRoot, '@appdata', appName);
const etcDir = process.env.TRIM_PKGETC || (fs.existsSync(persistentEtcDir) ? persistentEtcDir : path.join(appDest, 'etc'));
const varDir = process.env.TRIM_PKGVAR || (fs.existsSync(persistentVarDir) ? persistentVarDir : path.join(appDest, 'var'));
const tmpDir = process.env.TRIM_PKGTMP || path.join(appDest, 'tmp');
const socketPath = process.env.FNOFFICE_SOCKET || path.join(appDest, 'app.sock');
const configPath = path.join(etcDir, 'config.json');
const sessionsPath = path.join(varDir, 'sessions.json');
const sharesPath = path.join(varDir, 'shares.json');
const packageRoot = fs.existsSync(path.join(appDest,'app')) ? path.join(appDest,'app') : appDest;
// Keep this build-time value in sync with manifest. fnOS deploys application
// files separately from the manifest, so reading it at runtime is unreliable.
const appVersion = '0.6.1.0';
const uiDir = path.join(packageRoot,'ui');
const composeDir = path.join(packageRoot,'docker');
const bridgeDir = path.join(composeDir,'onlyoffice','bridge');
const fontsDir = path.join(composeDir,'onlyoffice','fonts');
const disabledFontsDir = path.join(composeDir,'onlyoffice','fonts-disabled');
const allowedExt = new Set(['doc','docx','docm','dot','dotx','odt','rtf','pdf','xls','xlsx','xlsm','xlt','xltx','ods','csv','ppt','pptx','pptm','pot','potx','odp']);
const defaults = { installOnlyOffice:false, onlyOfficePort:18081, onlyOfficeUrl:'http://127.0.0.1:18081', browserOnlyOfficeMode:'auto', distinguishMobile:false, onlyOfficeImage:'docker.m.daocloud.io/onlyoffice/documentserver:latest', callbackImage:'docker.m.daocloud.io/nginx:alpine', publicBaseUrl:'', internalCallbackBaseUrl:'http://callback-relay:9000', useInternalCallbackRelay:true, documentKeyRevision:'bridge-v2', jwtSecret:'', jwtHeader:'Authorization', jwtInBody:false, editorLanguage:'zh-CN', coEditingMode:'fast', forceSave:true, maxGlobalDocuments:50, maxUserDocuments:10, sessionTtlMinutes:30, verifyTls:true };
// Document Server caches conversion failures by document key. A process
// restart invalidates all in-memory sessions, so include a boot generation in
// the key as well. It remains stable for every user editing the same file
// during this process lifetime, preserving co-editing while preventing a
// failed key from poisoning the next FnOffice run.
const documentBootGeneration = crypto.randomBytes(12).toString('hex');
const sessions = new Map();
// Shares are persisted independently from editor sessions. Revoking a link
// only disables it: keeping its token lets the owner deliberately reuse the
// same address later, while a "new link" always receives a fresh token.
const shares = new Map(Object.entries(readJson(sharesPath, {})));
const IDLE_FORCE_SAVE_MS = 5 * 60 * 1000;

await Promise.all([fsp.mkdir(etcDir,{recursive:true}),fsp.mkdir(varDir,{recursive:true}),fsp.mkdir(tmpDir,{recursive:true}),fsp.mkdir(composeDir,{recursive:true}),fsp.mkdir(bridgeDir,{recursive:true}),fsp.mkdir(fontsDir,{recursive:true}),fsp.mkdir(disabledFontsDir,{recursive:true})]);
let config = {...defaults, ...readJson(configPath, {})};
// Existing installations created before 0.4.52 have their former defaults
// persisted as 10 / 3.  Migrate only that exact untouched pair once: values
// customized by an administrator are preserved.
if (config.concurrencyDefaultsVersion !== 2) {
  if (Number(config.maxGlobalDocuments) === 10 && Number(config.maxUserDocuments) === 3) {
    config.maxGlobalDocuments = defaults.maxGlobalDocuments;
    config.maxUserDocuments = defaults.maxUserDocuments;
  }
  config.concurrencyDefaultsVersion = 2;
  await writeJson(configPath, config);
}
// Both callback delivery and protected source-file download use the
// Docker-internal HTTP relay. It remains available when the browser-facing
// fnOS gateway is not routable from Docker, and nginx preserves HTTP framing
// between Document Server and the application's Unix socket.
if (config.useInternalCallbackRelay !== true) {
  config.useInternalCallbackRelay = true;
  await writeJson(configPath, config);
}
config.onlyOfficePort = Number(config.onlyOfficePort) || defaults.onlyOfficePort;
// A process restart also tears down the Document Server websocket.  Restoring
// those old sessions would reuse a document key that may already be cached as
// a failed download by OnlyOffice, so start with a clean session set.  Remove
// only FnOffice-owned bridge files; source documents are never touched.
try {
  for (const name of await fsp.readdir(bridgeDir)) await fsp.rm(path.join(bridgeDir,name),{force:true});
  await writeJson(sessionsPath,{});
} catch {}

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fallback; } }
async function writeJson(file, value) { const tmp=`${file}.tmp-${process.pid}`; await fsp.writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600}); await fsp.rename(tmp,file); }
const runtimeLogFile = path.join(process.env.TRIM_PKGHOME || path.join(appDest, 'home'), 'logs', 'fnoffice.log');
try { fs.mkdirSync(path.dirname(runtimeLogFile), {recursive:true}); } catch {}
function log(level, message, details='') {
  const suffix = details ? ` ${details}` : '';
  const line = `[${new Date().toISOString()}] [${level}] ${message}${suffix}\n`;
  try { fs.appendFileSync(runtimeLogFile, line); } catch {}
  if (level === 'ERROR') console.error(message, details);
  else console.log(message, details);
}
async function persistSessions() { await writeJson(sessionsPath,Object.fromEntries(sessions)); }
async function persistShares() { await writeJson(sharesPath,Object.fromEntries(shares)); }
async function dropSession(id,reason='') {
  const session=sessions.get(id);
  if(!session) return false;
  sessions.delete(id);
  await removeBridge(session);
  await persistSessions();
  log('INFO','session cleaned',`id=${id}${reason?` reason=${reason}`:''}`);
  return true;
}
function json(res,status,data) { const out=JSON.stringify(data); res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(out)}); res.end(out); }
function userFrom(req) { return {uid:String(req.headers['x-trim-userid']||''),username:String(req.headers['x-trim-username']||'飞牛用户'),isAdmin:String(req.headers['x-trim-isadmin']||'').toLowerCase()==='true'}; }
function publicBase(req) {
  const forwardedProto=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim();
  const forwardedHost=String(req.headers['x-forwarded-host']||'').split(',')[0].trim();
  const proto=forwardedProto||((req.socket&&req.socket.encrypted)?'https':'http');
  const host=forwardedHost||String(req.headers.host||'').trim();
  return host?`${proto}://${host}`:String(config.publicBaseUrl||'http://localhost').replace(/\/$/, '');
}
function shareUrl(req,token) { return `${publicBase(req)}/app/FnOffice/share/${encodeURIComponent(token)}`; }
function normalizeShareToken(token) { try { return decodeURIComponent(String(token||'')).trim(); } catch { return String(token||'').trim(); } }
function sharesFor(ownerUid,file) { return [...shares.values()].filter(s=>s&&String(s.ownerUid)===String(ownerUid)&&s.path===file).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)); }
function publicShare(share,req) { return {active:share.active===true,permissions:{read:true,download:share.permissions?.download===true,write:share.permissions?.write===true},createdAt:share.createdAt,revokedAt:share.revokedAt||null,url:shareUrl(req,share.token)}; }
async function validShare(token,need='read') {
  const normalizedToken=normalizeShareToken(token); const share=shares.get(normalizedToken);
  if(!share||share.active!==true||share.permissions?.read!==true) return null;
  if(need==='download'&&share.permissions?.download!==true) return null;
  if(need==='write'&&share.permissions?.write!==true) return null;
  if(!(await checkAcl(share.path,{uid:share.ownerUid},need==='write'?'write':'read'))) return null;
  return share;
}
function sessionAllowed(session,who,shareToken='') { const expected=Buffer.from(String(session?.shareToken||'')); const received=Buffer.from(String(shareToken||'')); return Boolean(session&&(who.isAdmin||(who.uid&&String(session.uid)===String(who.uid))||(expected.length>0&&expected.length===received.length&&crypto.timingSafeEqual(expected,received)))); }
async function sendAttachment(res,file,downloadName) {
  try {
    const stat=await fsp.stat(file);
    if(!stat.isFile()) throw new Error('file_not_found');
    const ext=extOf(file); const mime={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',doc:'application/msword',pdf:'application/pdf',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',ppt:'application/vnd.ms-powerpoint'}[ext]||'application/octet-stream';
    const safe=String(downloadName||path.basename(file)).replace(/[\\\r\n"]/g,'_');
    res.writeHead(200,{'content-type':mime,'content-length':stat.size,'content-disposition':`attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(downloadName||path.basename(file))}`,'cache-control':'no-store','x-content-type-options':'nosniff'});
    fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
  } catch(error) { json(res,error?.code==='EACCES'?403:404,{error:error?.code==='EACCES'?'file_access_denied':'file_not_found'}); }
}
function isMobileUserAgent(req) {
  const hints=[req.headers['user-agent'],req.headers['sec-ch-ua-mobile'],req.headers['x-trim-client'],req.headers['x-trim-device'],req.headers['x-trim-platform']].map(value=>String(value||'').toLowerCase()).join(' ');
  return /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|phone|tablet|\?1/.test(hints);
}
function canonicalFile(p) { if(!p||!p.startsWith('/')) throw new Error('invalid path'); const n=path.posix.normalize(p); if(n==='/'||n.includes('..')) throw new Error('invalid path'); const ext=path.posix.extname(n).slice(1).toLowerCase(); if(!allowedExt.has(ext)) throw new Error('unsupported extension'); return n; }
function extOf(file) { return path.extname(file).slice(1).toLowerCase(); }
function docType(ext) { return ['xls','xlsx','xlsm','xlt','xltx','ods','csv'].includes(ext)?'cell':['ppt','pptx','pptm','pot','potx','odp'].includes(ext)?'slide':'word'; }
function docKey(file,stat,nonce=crypto.randomBytes(12).toString('hex')) { return `FnOffice-${crypto.createHash('sha256').update(`${config?.documentKeyRevision||'legacy'}:${documentBootGeneration}:${nonce}:${file}:${stat.size}:${stat.mtimeMs}`).digest('base64url').slice(0,64)}`; }
function anonUser(uid) { return crypto.createHash('sha256').update(uid).digest('hex').slice(0,32); }
function sign(value, expires=Date.now()+600000) { const payload=`${expires}:${value}`; const sig=crypto.createHmac('sha256',config.jwtSecret||'development-secret').update(payload).digest('hex'); return `${expires}.${sig}`; }
function validSign(value, token) { try { const [e,s]=String(token||'').split('.'); const expires=Number(e); if(!expires||expires<Date.now()) return false; const expected=crypto.createHmac('sha256',config.jwtSecret||'development-secret').update(`${expires}:${value}`).digest('hex'); return crypto.timingSafeEqual(Buffer.from(s),Buffer.from(expected)); } catch { return false; } }
function jwt(payload,secret) { const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url'); const h=b({alg:'HS256',typ:'JWT'}), p=b(payload); const s=crypto.createHmac('sha256',secret).update(`${h}.${p}`).digest('base64url'); return `${h}.${p}.${s}`; }
function verifyJwt(value,secret) { try { const [h,p,s]=String(value||'').replace(/^Bearer\s+/i,'').split('.'); if(!h||!p||!s)return false; const expected=crypto.createHmac('sha256',secret).update(`${h}.${p}`).digest('base64url'); return crypto.timingSafeEqual(Buffer.from(s),Buffer.from(expected)); } catch { return false; } }
function onlyOfficeCommand(command) {
  return new Promise((resolve,reject)=>{
    try {
      const target=new URL('/coauthoring/CommandService.ashx',config.onlyOfficeUrl);
      const client=target.protocol==='https:'?https:http;
      const payload={...command};
      const token=config.jwtSecret?jwt(payload,config.jwtSecret):'';
      if(config.jwtSecret && config.jwtInBody) payload.token=token;
      const body=JSON.stringify(payload);
      const headers={'content-type':'application/json','content-length':Buffer.byteLength(body)};
      if(config.jwtSecret && !config.jwtInBody) headers[String(config.jwtHeader||'Authorization')]=`Bearer ${token}`;
      const req=client.request({hostname:target.hostname,port:target.port|| (target.protocol==='https:'?443:80),path:`${target.pathname}${target.search}`,method:'POST',headers,rejectUnauthorized:config.verifyTls,timeout:10000},res=>{
        const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(res.statusCode!==200)return reject(new Error(`OnlyOffice command HTTP ${res.statusCode}`));if(Number(data.error||0)!==0)return reject(new Error(`OnlyOffice command error ${data.error}`));resolve(data);}catch(e){reject(e);}});
      });
      req.on('timeout',()=>req.destroy(new Error('OnlyOffice command timeout')));
      req.on('error',reject); req.end(body);
    } catch(e) { reject(e); }
  });
}
async function forceSaveSession(session,reason='') {
  if(!session||!sessions.has(session.id)) return false;
  // An automatic/idle force-save may already be in flight.  Reuse it briefly,
  // but allow a toolbar download to retry when the previous request has been
  // waiting too long; otherwise the download could return the pre-edit file.
  if(session.forceSaveRequestedAt) {
    const age=Date.now()-Number(session.forceSaveRequestedAt);
    if(age<3000) return true;
    session.forceSaveRequestedAt=0;
  }
  session.forceSaveRequestedAt=Date.now();
  try {
    const result=await onlyOfficeCommand({c:'forcesave',key:session.key});
    log('INFO','force save requested',`id=${session.id} key=${session.key} reason=${reason} response=${JSON.stringify(result).slice(0,300)}`);
    return true;
  } catch(error) {
    session.forceSaveRequestedAt=0;
    log('ERROR','force save request failed',`id=${session.id} reason=${reason} ${error.message}`);
    return false;
  }
}
function wait(ms) { return new Promise(resolve=>setTimeout(resolve,ms)); }
// A Document Server force-save is asynchronous: it replies to the command
// first and delivers the edited bytes through the callback shortly after.
// Wait for that callback before serving a user-requested download, so the
// toolbar download reflects the current editor state instead of the last
// already-written source file.
async function saveLatestBeforeDownload(file) {
  const started=Date.now();
  const targets=[...sessions.values()].filter(s=>s.active&&s.path===file&&!s.error);
  const byKey=new Map(); for(const session of targets) if(!byKey.has(session.key)) byKey.set(session.key,session);
  if(!byKey.size) return false;
  await Promise.all([...byKey.values()].map(session=>forceSaveSession(session,'toolbar_download').catch(()=>false)));
  const deadline=Date.now()+30000;
  while(Date.now()<deadline) {
    if(targets.some(session=>Number(session.lastSavedAt||0)>=started)) return true;
    await wait(250);
  }
  log('WARN','download save wait timed out',`file=${file} sessions=${targets.length}`);
  return false;
}
async function readBody(req) { const chunks=[]; for await(const c of req) chunks.push(c); return Buffer.concat(chunks); }
async function trimApi(req,data={}) {
  const token=process.env.TRIM_API_TOKEN;
  if(!token) throw new Error('TRIM_API_TOKEN is unavailable');
  const body=JSON.stringify({reqId:crypto.randomUUID(),req,appName:'FnOffice',data});
  return new Promise((resolve,reject)=>{
    const upstream=http.request({socketPath:'/var/run/trim_open_gateway_apiscope.socket',path:'/api/v1/trimapp',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),authorization:`Bearer ${token}`},timeout:5000},response=>{
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(response.statusCode!==200||result.code!==0)return reject(new Error(result.msg||`fnOS API ${response.statusCode||'failed'}`));resolve(result.data);}catch(error){reject(error);}});
    });
    upstream.on('timeout',()=>upstream.destroy(new Error(`${req} timed out`)));
    upstream.on('error',reject);
    upstream.end(body);
  });
}
async function checkAcl(file,user,mode='read') {
  if(!user?.uid) return false;
  if(process.env.FNOS_DEV_MODE==='true'||!process.env.TRIM_API_TOKEN){try{await fsp.access(file,mode==='write'?fs.constants.W_OK:fs.constants.R_OK);return true;}catch{return false;}}
  const uid=Number(user.uid);
  if(!Number.isSafeInteger(uid)||uid<0) return false;
  try { const records=await trimApi('trim.file.checkUserACL',{uid,path:file}); const record=Array.isArray(records)?records.find(item=>item?.path===file)||records[0]:undefined; return mode==='write'?record?.writable===true:record?.readable===true; }
  catch(error) { console.error(`FnOffice ACL check failed for ${file}:`,error.message); return false; }
}
async function atomicReplace(file,contents,session) {
  if(!(await checkAcl(file,{uid:session.uid},'write'))) throw new Error('file_write_denied');
  const temp=path.join(path.dirname(file),`.${path.basename(file)}.fnoffice-${session.id}.tmp`);
  try { await fsp.writeFile(temp,Buffer.from(contents),{mode:0o600,flag:'wx'}); await fsp.rename(temp,file); }
  finally { await fsp.rm(temp,{force:true}).catch(()=>{}); }
}
function bridgePath(session) { return path.join(bridgeDir,`${session.id}.${extOf(session.path)}`); }
async function removeBridge(session) { if(session?.bridgeFile) await fsp.rm(session.bridgeFile,{force:true}).catch(()=>{}); }
async function syncCompose() { const env=`ONLYOFFICE_PORT=${config.onlyOfficePort}\nONLYOFFICE_IMAGE=${config.onlyOfficeImage||defaults.onlyOfficeImage}\nCALLBACK_IMAGE=${config.callbackImage||defaults.callbackImage}\nJWT_SECRET=${config.jwtSecret}\nFNOFFICE_APPDEST=${appDest}\n`; await fsp.writeFile(path.join(composeDir,'.env'),env,{mode:0o600}); }
function probeOnlyOffice() { return new Promise(resolve=>{ try { const u=new URL(config.onlyOfficeUrl); const client=u.protocol==='https:'?https:http; const req=client.request({hostname:u.hostname,port:u.port|| (u.protocol==='https:'?443:80),path:'/healthcheck',method:'GET',rejectUnauthorized:config.verifyTls,timeout:3000},r=>{r.resume();resolve(r.statusCode===200);}); req.on('timeout',()=>{req.destroy();resolve(false);}); req.on('error',()=>resolve(false)); req.end(); } catch { resolve(false); } }); }
async function detectOnlyOfficeVersion() {
  try {
    const base=new URL(config.onlyOfficeUrl);
    const client=base.protocol==='https:'?https:http;
    // Only query the dedicated metadata endpoint. Parsing the public welcome
    // page can mistake the base OS version (for example Ubuntu 24.04) for
    // the Document Server version.
    for (const endpoint of ['/info/info.json']) {
      const body=await new Promise((resolve,reject)=>{
        const req=client.request({hostname:base.hostname,port:base.port|| (base.protocol==='https:'?443:80),path:endpoint,method:'GET',rejectUnauthorized:config.verifyTls,timeout:3000},r=>{const chunks=[];r.on('data',c=>{if(Buffer.concat(chunks).length<128*1024)chunks.push(c);});r.on('end',()=>resolve({status:r.statusCode||0,text:Buffer.concat(chunks).toString('utf8')}));});
        req.on('timeout',()=>{req.destroy(new Error('timeout'));}); req.on('error',reject); req.end();
      });
      if (body.status<200||body.status>=300) continue;
      try { const parsed=JSON.parse(body.text); const value=parsed.version||parsed.buildVersion||parsed.productVersion||parsed.build_number||parsed.buildNumber; if(value&&!/^24\.04(?:\.|$)/.test(String(value))) return String(value); } catch {}
      const match=body.text.match(/(?:buildVersion|productVersion)\s*["':= ]+v?([0-9]+(?:\.[0-9]+){1,3})/i); if(match&&!/^24\.04(?:\.|$)/.test(match[1])) return match[1];
    }
  } catch {}
  return '';
}
function detectDockerOnlyOfficeVersion() {
  if (config.installOnlyOffice!==true) return Promise.resolve('');
  return new Promise(resolve=>execFile('docker',['inspect','-f','{{json .Config.Labels}}','fnoffice-onlyoffice'],{timeout:3000},(error,stdout)=>{
    if (!error) {
      try {
        const labels=JSON.parse(String(stdout||'').trim()||'{}');
        const value=String(labels['org.opencontainers.image.version']||labels['version']||'').trim();
        if (value&&!/^24\.04(?:\.|$)/.test(value)) return resolve(value);
      } catch {}
    }
    execFile('docker',['exec','fnoffice-onlyoffice','dpkg-query','-W','-f=${Version}','onlyoffice-documentserver'],{timeout:3000},(packageError,packageStdout)=>{const value=String(packageStdout||'').trim();resolve(packageError||/^24\.04(?:\.|$)/.test(value)?'':value);});
  }));
}
function isPrivateBrowserHost(hostname) {
  const h=String(hostname||'').toLowerCase().replace(/^\[|\]$/g,'');
  if(h==='localhost'||h==='::1'||h==='127.0.0.1') return true;
  if(h.includes(':')) return h.startsWith('fc')||h.startsWith('fd')||h.startsWith('fe80:');
  const p=h.split('.').map(Number);
  if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255)) return false;
  return p[0]===10 || p[0]===127 || p[0]===169&&p[1]===254 || p[0]===192&&p[1]===168 || p[0]===172&&p[1]>=16&&p[1]<=31;
}
function browserOnlyOfficeUrl(req, raw) {
  // Direct port access works best on a local/private IP. fnConnect, public
  // domains and reverse proxies generally expose only the FnOffice gateway,
  // so those browsers must use the same-origin HTTP/WebSocket proxy instead
  // of trying to reach the internal OnlyOffice port directly.
  const mode=String(config.browserOnlyOfficeMode||'auto').toLowerCase();
  // An administrator may publish FnOffice through a reverse-proxy hostname
  // that has more complete WebSocket support than a direct fnOS gateway port.
  // Use that known public gateway for browser-side Document Server traffic,
  // while source downloads and callbacks remain on the private Docker relay.
  // This lets a document opened at :5666/:5667 use the same proven editor
  // route as the configured public hostname without exposing any file URL.
  let publicGateway='';
  try {
    const publicBase=String(config.publicBaseUrl||'').trim();
    if (publicBase) publicGateway=`${new URL(publicBase).origin}${new URL(publicBase).pathname.replace(/\/$/,'')}/app/FnOffice/onlyoffice`;
  } catch {}
  try {
    const forwardedProto=String(req.headers['x-forwarded-proto']||raw.protocol||'http').split(',')[0].trim();
    const incoming=new URL(`${forwardedProto}://${String(req.headers['x-forwarded-host']||req.headers.host||'localhost').trim()}`);
    if(mode==='gateway' || (mode!=='direct' && !isPrivateBrowserHost(incoming.hostname))) return publicGateway||'/app/FnOffice/onlyoffice';
    const host=incoming.hostname.includes(':')?`[${incoming.hostname}]`:incoming.hostname;
    return `${incoming.protocol}//${host}:${config.onlyOfficePort}`;
  } catch { return '/app/FnOffice/onlyoffice'; }
}
function onlyOfficeProxyHeaders(req, target, upgrade=false) {
  const u=new URL(target);
  const requestHost=String(req.headers.host||u.host).split(',')[0].trim()||u.host;
  const forwardedHost=String(req.headers['x-forwarded-host']||'').split(',')[0].trim();
  let browserOrigin;
  // The direct fnOS gateway can strip the port from both Host and
  // X-Forwarded-Host before a gateway-app request reaches this Unix socket.
  // Browser Origin (WebSocket) and Referer (HTTP assets) retain the actual
  // public origin, so prefer an explicit port from either one.
  for (const value of [req.headers.origin,req.headers.referer]) {
    try {
      const candidate=new URL(String(value||''));
      if (candidate.port) { browserOrigin=candidate; break; }
    } catch {}
  }
  // fnOS's direct :5666/:5667 gateway forwards X-Forwarded-Host without its
  // non-default port.  Document Server uses this value when constructing
  // cache/files URLs; accepting the stripped header made it emit URLs on
  // port 80/443 (for example http://host/app/.../Editor.bin), which cannot
  // reach the direct gateway.  Retain the original Host whenever it carries
  // the missing explicit port.  Reverse proxies that supply a real public
  // host/port continue to use their forwarded value.
  const hostHasPort=/^\[[^\]]+\]:\d+$/.test(requestHost)||/^[^:]+:\d+$/.test(requestHost);
  const forwardedHasPort=/^\[[^\]]+\]:\d+$/.test(forwardedHost)||/^[^:]+:\d+$/.test(forwardedHost);
  const incomingHost=browserOrigin?.host||(forwardedHost&&(!hostHasPort||forwardedHasPort)?forwardedHost:requestHost);
  const incomingProto=browserOrigin?.protocol.replace(/:$/,'')||String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim()||'http';
  const headers={...req.headers,host:incomingHost};
  // Document Server is behind both the fnOS gateway and FnOffice's path
  // proxy. Keep the public origin and prefix explicit, or it can create a
  // follow-up download URL without `/app/FnOffice/onlyoffice` after the
  // source document has been fetched.
  headers['x-forwarded-host']=incomingHost;
  headers['x-forwarded-proto']=incomingProto;
  headers['x-forwarded-port']=incomingHost.includes(':')?incomingHost.slice(incomingHost.lastIndexOf(':')+1):(incomingProto==='https'?'443':'80');
  headers['x-forwarded-prefix']='/app/FnOffice/onlyoffice';
  if(upgrade) { headers.connection='Upgrade'; headers.upgrade=String(req.headers.upgrade||'websocket'); }
  // The fnOS gateway may attach its own Authorization header to every
  // browser request.  OnlyOffice, however, needs its JWT on editor API and
  // document-download requests.  Preserve a header when it is a valid JWT
  // for our configured secret; otherwise remove the gateway credential so it
  // cannot be mistaken for an OnlyOffice token.  This distinction is vital
  // on public/fnConnect access where the browser-facing gateway and
  // Document Server share the same origin.
  const jwtHeaderName=String(config.jwtHeader||'Authorization').toLowerCase();
  const incomingJwt=headers[jwtHeaderName] || headers.authorization;
  const keepJwt=Boolean(config.jwtSecret && incomingJwt && verifyJwt(incomingJwt,config.jwtSecret));
  if (!keepJwt) {
    delete headers.authorization;
    delete headers[jwtHeaderName];
  }
  delete headers['x-trim-userid'];
  delete headers['x-trim-username'];
  delete headers['x-trim-isadmin'];
  return headers;
}
function normalizeOnlyOfficeDownload(raw) {
  try {
    const source=new URL(String(raw),config.onlyOfficeUrl);
    const base=new URL(config.onlyOfficeUrl);
    // Document Server reports its public, gateway-routed URL.  The callback
    // fetches the generated file from the container directly, where the
    // `/app/FnOffice/onlyoffice` prefix does not exist.
    const gatewayPrefix='/app/FnOffice/onlyoffice';
    let pathname=source.pathname;
    if(pathname===gatewayPrefix) pathname='/';
    else if(pathname.startsWith(`${gatewayPrefix}/`)) pathname=pathname.slice(gatewayPrefix.length);
    return new URL(`${pathname}${source.search}`,base).toString();
  } catch { return String(raw||''); }
}
// Containers are created by the privileged installation callback with
// `docker run`; the gateway process must not create or alter Compose projects.
async function restartCompose() { return; }
function restartOnlyOffice() {
  return new Promise((resolve,reject)=>execFile('docker',['restart','fnoffice-onlyoffice'],{timeout:30000},(error,stdout,stderr)=>{
    if(error){log('WARN','font manager could not restart OnlyOffice',error.message);return reject(error);}
    execFile('docker',['exec','fnoffice-onlyoffice','fc-cache','-f'],{timeout:60000},cacheError=>{if(cacheError)log('WARN','font cache refresh failed',cacheError.message);resolve(String(stdout||'').trim());});
  }));
}
function dockerRun(args,timeout=30000){
  return new Promise((resolve,reject)=>{
    execFile('docker',args,{timeout},(error,stdout)=>error?reject(error):resolve(String(stdout||'')));
  });
}
async function syncFontsToContainer(){
  try {
    const mounts=await dockerRun(['inspect','-f','{{range .Mounts}}{{.Destination}} {{end}}','fnoffice-onlyoffice']);
    if(String(mounts).includes('/usr/share/fonts/truetype/custom')) return;
    // Older containers may not have the font volume yet. Copy the active set
    // into the container so the manager also works before the next reinstall.
    await dockerRun(['exec','fnoffice-onlyoffice','sh','-c','rm -rf /usr/share/fonts/truetype/custom && mkdir -p /usr/share/fonts/truetype/custom']);
    for(const name of await listFonts().then(x=>x.enabled)) await dockerRun(['cp',path.join(fontsDir,name),`fnoffice-onlyoffice:/usr/share/fonts/truetype/custom/${name}`]);
  } catch(error) { log('WARN','font sync to OnlyOffice failed',error.message); throw error; }
}
const fontExtension=/\.(ttf|otf|ttc|woff|woff2)$/i;
function safeFontName(value){const name=path.basename(String(value||''));return fontExtension.test(name)&&name.length<=180&&!/[\r\n]/.test(name)?name:'';}
async function listFonts(){const read=async dir=>{try{return (await fsp.readdir(dir,{withFileTypes:true})).filter(e=>e.isFile()&&fontExtension.test(e.name)).map(e=>e.name).sort((a,b)=>a.localeCompare(b));}catch{return []}};return {enabled:await read(fontsDir),disabled:await read(disabledFontsDir)};}
async function readMultipartFiles(req){const type=String(req.headers['content-type']||'');const match=type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);if(!match)throw new Error('multipart_boundary_missing');const boundary=Buffer.from(`--${match[1]||match[2]}`);const body=await readBody(req);const files=[];let cursor=0;while(cursor<body.length){const start=body.indexOf(boundary,cursor);if(start<0)break;const headerStart=start+boundary.length;if(body.subarray(headerStart,headerStart+2).toString()==='--')break;const contentStart=body.indexOf(Buffer.from('\r\n\r\n'),headerStart);if(contentStart<0)break;let dataEnd=body.indexOf(boundary,contentStart+4);if(dataEnd<0)dataEnd=body.length;if(dataEnd>=2&&body[dataEnd-2]===13&&body[dataEnd-1]===10)dataEnd-=2;const disposition=body.subarray(headerStart,contentStart).toString();const nameMatch=disposition.match(/filename="([^"]*)"/i);if(nameMatch){const name=safeFontName(nameMatch[1]);const data=body.subarray(contentStart+4,dataEnd);if(name&&data.length)files.push({name,data});}cursor=dataEnd;}if(!files.length)throw new Error('font_file_missing');return files;}
function proxyHttp(req,res,target,pathName) {
  const u=new URL(target); const client=u.protocol==='https:'?https:http;
  const headers=onlyOfficeProxyHeaders(req,target);
  log('INFO','onlyoffice proxy request',`${req.method} ${pathName} host=${u.host}`);
  const r=client.request({hostname:u.hostname,port:u.port|| (u.protocol==='https:'?443:80),method:req.method,path:pathName,headers,rejectUnauthorized:config.verifyTls,agent:u.protocol==='https:'?onlyOfficeHttpsAgent:onlyOfficeHttpAgent},up=>{
    log('INFO','onlyoffice proxy response',`${req.method} ${pathName} status=${up.statusCode||0}`);
    res.writeHead(up.statusCode||502,up.headers); up.pipe(res);
  });
  r.on('error',e=>{ log('ERROR','onlyoffice proxy failed',`${req.method} ${pathName} ${e.message}`); if(!res.headersSent) json(res,502,{error:'onlyoffice_unreachable',message:e.message}); else res.destroy(e); });
  req.on('aborted',()=>r.destroy(new Error('client_aborted')));
  req.pipe(r);
}
function proxyUpgrade(req,socket,head,target,pathName) {
  const u=new URL(target);
  const client=u.protocol==='https:'?https:http;
  log('INFO','onlyoffice websocket request',`${req.method} ${pathName} host=${u.host} mode=http-upgrade`);
  const headers=onlyOfficeProxyHeaders(req,target,true);
  // The fnOS gateway can proxy an HTTP upgrade but does not reliably retain
  // Socket.IO's permessage-deflate negotiation after the Unix-socket hop.
  // Let the browser and Document Server use plain WebSocket frames instead.
  // This changes only the transport encoding; it does not affect JWT or data.
  delete headers['sec-websocket-extensions'];
  delete headers['content-length'];
  const upstream=client.request({hostname:u.hostname,port:u.port||(u.protocol==='https:'?443:80),method:req.method,path:pathName,headers,rejectUnauthorized:config.verifyTls,agent:false});
  let upstreamSocket;
  const closeBoth=(error,label)=>{
    if(error) log('ERROR',label,`${pathName} ${error.message}`);
    try{socket.destroy();}catch{}
    try{upstream.destroy();}catch{}
    try{upstreamSocket?.destroy();}catch{}
  };
  upstream.once('upgrade',(response,connected,upstreamHead)=>{
    upstreamSocket=connected;
    let responseHead=`HTTP/${response.httpVersion||'1.1'} ${response.statusCode||101} ${response.statusMessage||'Switching Protocols'}\r\n`;
    for(let i=0;i<(response.rawHeaders||[]).length;i+=2) responseHead+=`${response.rawHeaders[i]}: ${response.rawHeaders[i+1]}\r\n`;
    socket.write(`${responseHead}\r\n`);
    if(head.length) connected.write(head);
    if(upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(connected);
    connected.pipe(socket);
    socket.setTimeout(0);
    connected.setTimeout(0);
     log('INFO','onlyoffice websocket upgraded',`${pathName} status=${response.statusCode||101}`);
    connected.on('close',()=>log('INFO','onlyoffice websocket upstream close',pathName));
  });
  upstream.once('response',response=>{response.resume();closeBoth(new Error(`upstream refused upgrade: ${response.statusCode||0}`),'onlyoffice websocket upgrade failed');});
  upstream.on('error',e=>closeBoth(e,'onlyoffice websocket connect failed'));
  socket.on('error',e=>closeBoth(e,'onlyoffice websocket client error'));
  socket.on('close',()=>{log('INFO','onlyoffice websocket client close',pathName);try{upstreamSocket?.destroy();}catch{}});
  upstream.end();
}
function serveFile(res,file,type) { res.writeHead(200,{'content-type':type,'cache-control':'no-cache'}); return fs.createReadStream(file).on('error',()=>{ if(!res.headersSent) json(res,404,{error:'ui_not_found'}); else res.destroy(); }).pipe(res); }

async function handle(req,res) {
  log('INFO', 'request', `${req.method} ${req.url}`);
  const raw=new URL(req.url,'http://localhost');
  const prefix='/app/FnOffice';
  const normalized=raw.pathname.startsWith(prefix)?(raw.pathname.slice(prefix.length)||'/'):raw.pathname;
  const u=new URL(normalized+(raw.search||''),'http://localhost');
  // The settings entry is registered as administrator-only in the fnOS UI
  // config.  Keep the server-side route protected as well so a direct URL
  // cannot bypass that gateway visibility rule.
  const who=userFrom(req);
  if (u.pathname.startsWith('/share') || u.pathname==='/api/shares' || u.pathname==='/api/share-records') return json(res,404,{error:'sharing_removed'});
  if ((u.pathname==='/fonts'||u.pathname==='/api/fonts'||u.pathname==='/api/fonts/upload'||u.pathname==='/api/fonts/action')&&!who.isAdmin) {
    return u.pathname==='/fonts'?json(res,403,{error:'admin_required'}):json(res,403,{error:'admin_required'});
  }
  if ((u.pathname==='/' || u.pathname==='/settings' || u.pathname==='/api/config') && !who.isAdmin) {
    if (u.pathname==='/api/config') return json(res,403,{error:'admin_required'});
    res.writeHead(403, {'content-type':'text/plain; charset=utf-8', 'cache-control':'no-store'});
    return res.end('FnOffice 设置仅管理员可访问');
  }
  if(u.pathname==='/api/health'){const connected=await probeOnlyOffice();const version=(connected?await detectOnlyOfficeVersion():'')||await detectDockerOnlyOfficeVersion();log('INFO','health',`connected=${connected} version=${version||'unknown'} onlyOffice=${config.onlyOfficeUrl}`);return json(res,connected?200:503,{ok:connected,onlyOfficeUrl:config.onlyOfficeUrl,onlyOfficePort:config.onlyOfficePort,onlyOfficeVersion:version||null,reason:connected?'ready':'onlyoffice_unreachable'});}
  if(u.pathname==='/api/config'&&req.method==='GET'){const who=userFrom(req);return json(res,200,{...config,appVersion,jwtSecret:who.isAdmin?config.jwtSecret:(config.jwtSecret?'********':'')});}
  if(u.pathname==='/api/config'&&req.method==='PUT'){const who=userFrom(req);if(!who.isAdmin)return json(res,403,{error:'admin_required'});const old={...config};try{const next=JSON.parse((await readBody(req)).toString()||'{}');const port=Number(next.onlyOfficePort);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('invalid port');if(next.jwtSecret==='********')next.jwtSecret=old.jwtSecret;const oldLocal=`http://127.0.0.1:${old.onlyOfficePort}`;const shouldSyncLocal=!next.onlyOfficeUrl||next.onlyOfficeUrl===oldLocal;config={...old,...next,onlyOfficePort:port,onlyOfficeUrl:shouldSyncLocal?`http://127.0.0.1:${port}`:next.onlyOfficeUrl};await writeJson(configPath,config);await syncCompose();await restartCompose();return json(res,200,{...config,jwtSecret:config.jwtSecret?'********':''});}catch(e){config=old;await writeJson(configPath,config);return json(res,400,{error:'config_update_failed',message:e.message});}}
  if(u.pathname==='/api/fonts'&&req.method==='GET') return json(res,200,await listFonts());
  if(u.pathname==='/api/fonts/upload'&&req.method==='POST') { try { const files=await readMultipartFiles(req); const uploaded=[]; for(const {name,data} of files){try{await fsp.writeFile(path.join(fontsDir,name),data,{flag:'wx',mode:0o644});uploaded.push(name);}catch(e){if(e.code!=='EEXIST')throw e;}} if(!uploaded.length)throw new Error('font_already_exists'); await syncFontsToContainer(); await restartOnlyOffice(); return json(res,200,{ok:true,names:uploaded,fonts:await listFonts()}); } catch(e) { return json(res,400,{error:'font_upload_failed',message:e.message}); } }
  if(u.pathname==='/api/fonts/action'&&req.method==='POST') { try { const input=JSON.parse((await readBody(req)).toString()||'{}'); const name=safeFontName(input.name); if(!name)throw new Error('unsupported_font'); const action=String(input.action||''); const active=path.join(fontsDir,name), disabled=path.join(disabledFontsDir,name); if(action==='disable'){await fsp.rename(active,disabled);} else if(action==='enable'){await fsp.rename(disabled,active);} else if(action==='delete'){await fsp.rm(active,{force:true});await fsp.rm(disabled,{force:true});} else throw new Error('invalid_action'); await syncFontsToContainer(); if(!String(await dockerRun(['inspect','-f','{{range .Mounts}}{{.Destination}} {{end}}','fnoffice-onlyoffice'])).includes('/usr/share/fonts/truetype/custom')) await dockerRun(['exec','fnoffice-onlyoffice','sh','-c',`rm -f '/usr/share/fonts/truetype/custom/${name.replace(/'/g,"'\\''")}'`]); await restartOnlyOffice(); return json(res,200,{ok:true,fonts:await listFonts()}); } catch(e) { return json(res,400,{error:'font_action_failed',message:e.message}); } }
  if(u.pathname==='/api/shares'&&req.method==='GET') {
    try {
      const file=canonicalFile(u.searchParams.get('path'));
      if(!who.uid||!(await checkAcl(file,who,'write'))) return json(res,403,{error:'file_owner_required'});
      const history=sharesFor(who.uid,file); const active=history.find(s=>s.active===true);
      return json(res,200,{active:active?publicShare(active,req):null,previous:history[0]?publicShare(history[0],req):null,hasPrevious:history.length>0});
    } catch(error) { return json(res,400,{error:'invalid_share_request',message:error.message}); }
  }
  if(u.pathname==='/api/shares'&&req.method==='PUT') {
    try {
      const input=JSON.parse((await readBody(req)).toString()||'{}'); const file=canonicalFile(input.path);
      if(!who.uid||!(await checkAcl(file,who,'write'))) return json(res,403,{error:'file_owner_required'});
      const history=sharesFor(who.uid,file); const latest=history[0]; const mode=input.mode==='reuse'?'reuse':'new';
      let share=mode==='reuse'?latest:null;
      if(!share) {
        const token=crypto.randomBytes(24).toString('base64url');
        share={token,path:file,ownerUid:who.uid,ownerUsername:who.username,createdAt:Date.now(),permissions:{read:true,download:false,write:false}};
        shares.set(token,share);
      }
      share.active=true; share.revokedAt=null; share.updatedAt=Date.now();
      share.permissions={read:true,download:input.permissions?.download===true,write:input.permissions?.write===true};
      await persistShares(); log('INFO','share enabled',`token=${share.token.slice(0,8)} owner=${who.uid} file=${file} write=${share.permissions.write} download=${share.permissions.download}`);
      return json(res,200,{share:publicShare(share,req),reused:mode==='reuse'&&Boolean(latest)});
    } catch(error) { log('ERROR','share enable failed',error.message); return json(res,400,{error:'share_enable_failed',message:error.message}); }
  }
  if(u.pathname==='/api/shares'&&req.method==='DELETE') {
    try {
      const file=canonicalFile(u.searchParams.get('path'));
      if(!who.uid||!(await checkAcl(file,who,'write'))) return json(res,403,{error:'file_owner_required'});
      const active=sharesFor(who.uid,file).find(s=>s.active===true);
      if(!active) return json(res,404,{error:'share_not_found'});
      active.active=false; active.revokedAt=Date.now(); active.updatedAt=Date.now(); await persistShares();
      log('INFO','share revoked',`token=${active.token.slice(0,8)} owner=${who.uid} file=${file}`);
      return json(res,200,{ok:true,previous:publicShare(active,req)});
    } catch(error) { return json(res,400,{error:'share_revoke_failed',message:error.message}); }
  }
  if(u.pathname==='/api/share-records'&&req.method==='GET') {
    const includeAll=who.isAdmin&&u.searchParams.get('all')==='1';
    const owner=includeAll?'':who.uid;
    if(!who.uid&&!includeAll)return json(res,403,{error:'login_required'});
    const q=String(u.searchParams.get('q')||'').toLowerCase(); const status=String(u.searchParams.get('status')||'all');
    const ownerFilter=String(u.searchParams.get('owner')||'').toLowerCase(); const from=Date.parse(u.searchParams.get('from')||'')||0; const to=Date.parse(u.searchParams.get('to')||'')||Infinity;
    const records=[...shares.values()].filter(s=>s&&(!owner||String(s.ownerUid)===owner)&&(!q||s.path.toLowerCase().includes(q)||path.basename(s.path).toLowerCase().includes(q))&&(!ownerFilter||String(s.ownerUsername||'').toLowerCase().includes(ownerFilter)||String(s.ownerUid).toLowerCase().includes(ownerFilter))&&Number(s.createdAt||0)>=from&&Number(s.createdAt||0)<=to).filter(s=>status==='all'||(status==='revoked'&&!s.active)||(status==='readonly'&&s.active&&!s.permissions.download&&!s.permissions.write)||(status==='download'&&s.active&&s.permissions.download)||(status==='editable'&&s.active&&s.permissions.write));
    records.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
    const out=[]; for(const s of records){let size=0;try{size=(await fsp.stat(s.path)).size;}catch{} out.push({...publicShare(s,req),token:s.token,path:s.path,fileName:path.basename(s.path),ownerUid:s.ownerUid,ownerUsername:s.ownerUsername,size});}
    return json(res,200,{records:out,admin:includeAll});
  }
  if(u.pathname==='/api/share-records'&&req.method==='DELETE') {
    const token=String(u.searchParams.get('token')||''); const s=shares.get(token);
    if(!s||(!who.isAdmin&&String(s.ownerUid)!==String(who.uid)))return json(res,404,{error:'share_not_found'});
    shares.delete(token); await persistShares();
    for(const [id,session] of sessions) if(session.shareToken===token) await dropSession(id,'share_record_cleared');
    return json(res,200,{ok:true});
  }
  const publicDownload=u.pathname.match(/^\/share\/([^/]+)\/download\/?$/);
  if(publicDownload&&req.method==='GET') { const share=await validShare(publicDownload[1],'download'); if(!share)return json(res,404,{error:'share_not_found'}); await saveLatestBeforeDownload(share.path); return sendAttachment(res,share.path,path.basename(share.path)); }
  const publicOpen=u.pathname.match(/^\/share\/([^/]+)\/?$/);
  if(publicOpen&&req.method==='GET') { const share=await validShare(publicOpen[1],'read'); if(!share){log('WARN','share token rejected',`token=${normalizeShareToken(publicOpen[1]).slice(0,12)} host=${req.headers.host||''}`);res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});return res.end('分享链接不存在、已撤回或无权访问。');} return serveFile(res,path.join(uiDir,'open.html'),'text/html; charset=utf-8'); }
  if (u.pathname==='/api/editor-session' && req.method==='POST') {
    try {
      const input=JSON.parse((await readBody(req)).toString()||'{}');
      const shareToken=normalizeShareToken(input.shareToken); const share=shareToken?await validShare(shareToken,'read'):null;
      if(shareToken&&!share) return json(res,404,{error:'share_not_found'});
      const editorUser=share?{uid:String(share.ownerUid),username:'共享访客',isAdmin:false}:who;
      const file=share?share.path:canonicalFile(input.path);
      if (!share&&!(await checkAcl(file,editorUser))) return json(res,403,{error:'file_access_denied'});
      const stat=await fsp.stat(file);
      // Keep one OnlyOffice document key for all currently active editors of
      // the same source file so co-editing remains enabled.  A fresh key is
      // generated after the previous attempt has been cleaned up (for
      // example, when OnlyOffice reports its -4 download error), preventing a
      // cached failed conversion from poisoning the next retry.
       const same=[...sessions.values()].find(s=>s.path===file&&s.active&&!s.error&&s.size===stat.size&&s.mtimeMs===stat.mtimeMs&&Date.now()-s.lastSeen<60000);
      const key=same?.key||docKey(file,stat);
      const global=new Set([...sessions.values()].filter(s=>s.active).map(s=>s.key));
      const mine=new Set([...sessions.values()].filter(s=>s.active&&s.uid===editorUser.uid).map(s=>s.key));
      if (!same&&global.size>=config.maxGlobalDocuments) return json(res,429,{error:'global_limit'});
      if (!same&&mine.size>=config.maxUserDocuments) return json(res,429,{error:'user_limit'});
      if (!(await probeOnlyOffice())) return json(res,503,{error:'onlyoffice_unreachable',message:'OnlyOffice 尚未就绪，请在 Docker 中确认容器和端口后重试。'});
      const id=crypto.randomUUID();
        const now=Date.now();
        const session={id,path:file,key,uid:editorUser.uid,username:editorUser.username,shareToken:share?.token||'',shareWritable:share?.permissions?.write===true,active:true,size:stat.size,mtimeMs:stat.mtimeMs,createdAt:now,lastSeen:now,lastActivityAt:now,forceSaveRequestedAt:0,idleSaveCompletedAt:0};
       session.bridgeFile=bridgePath(session);
       await fsp.copyFile(file,session.bridgeFile);
       await fsp.chmod(session.bridgeFile,0o644);
       sessions.set(id,session); await persistSessions();
      const gatewayBase=(config.publicBaseUrl||`${raw.protocol}//${req.headers.host||'localhost'}`).replace(/\/$/,'');
      const relayBase=(config.useInternalCallbackRelay?config.internalCallbackBaseUrl:gatewayBase).replace(/\/$/,'');
       // Keep a real extension in the signed download URL. Document Server's
       // converter uses both the configured fileType and the source URL/name
       // while determining the input format; a bare `/download` URL can be
       // misclassified as an unknown binary on newer Document Server builds.
       // The request is still served exclusively by the Docker-internal relay.
      // The automatically installed relay mounts this private, per-session
      // bridge directory read-only.  Let Document Server fetch its source
      // directly from nginx instead of proxying a large response through the
      // fnOS Unix socket.  Some public gateways preserve the request but
      // truncate or reframe that proxied download after the WebSocket upgrade;
      // Document Server then reports the misleading editor error -4 even when
      // the application logged a complete response.  The UUID is unguessable
      // and the file is removed as soon as the session ends.  Manual Docker
      // deployments retain the signed application relay for compatibility
      // with older Compose examples that do not mount the bridge directory.
      const bridgeName=path.basename(session.bridgeFile);
      const download=config.installOnlyOffice===true&&config.useInternalCallbackRelay
        ? `${relayBase}/fnoffice-files/${encodeURIComponent(bridgeName)}`
        : `${relayBase}/app/FnOffice/internal/storage/${id}/download/source.${extOf(file)}?token=${encodeURIComponent(sign(id))}`;
      const callback=`${relayBase}/app/FnOffice/internal/onlyoffice/callback/${id}?token=${encodeURIComponent(sign(id))}`;
      const payload={document:{fileType:extOf(file),key,title:path.basename(file),url:download},documentType:docType(extOf(file))};
      const mobileClient=isMobileUserAgent(req);
      const mobile=Boolean(config.distinguishMobile)&&mobileClient;
      const customization={forcesave:config.forceSave,mobileLayout:mobile};
      // Keep the desktop editor type when mobile-layout detection is disabled,
      // but start mobile clients with their side panels closed. hideRightMenu
      // is the documented OnlyOffice option; the layout values are supported
      // by newer Document Server builds and ignored harmlessly by older ones.
      if (mobileClient) {
        customization.hideRightMenu=true;
        customization.layout={leftMenu:{mode:'hidden'},rightMenu:{mode:'hidden'}};
      }
      const visitorId=String(input.visitorId||'').slice(0,100);
      const editor={callbackUrl:callback,lang:config.editorLanguage||'zh-CN',mode:share&&!share.permissions.write?'view':'edit',coEditing:{mode:config.coEditingMode,change:false},user:{id:anonUser(share?`share:${share.token}:${visitorId||id}`:editorUser.uid),name:share?'共享访客':editorUser.username},customization};
      log('INFO','editor-session',`id=${id} uid=${editorUser.uid} shared=${Boolean(share)} file=${file} relayBase=${relayBase} source=${download.includes('/fnoffice-files/')?'bridge-static':'application-relay'} download=${download}`);
      // Do not expose the server-side OnlyOffice address (often 127.0.0.1)
      // to the browser. The client receives only the gateway/direct URL that
      // browserOnlyOfficeUrl() selected for its actual request origin.
      return json(res,200,{sessionId:id,path:file,browserOnlyOfficeUrl:browserOnlyOfficeUrl(req,raw),editorConfig:{...payload,type:mobile?'mobile':'desktop',editorConfig:editor,token:config.jwtSecret?jwt({...payload,type:mobile?'mobile':'desktop',editorConfig:editor},config.jwtSecret):undefined}});
    } catch(e) {
      log('ERROR','session creation failed',e.stack||e.message);
      return json(res,400,{error:'session_create_failed',message:e.message});
     }
   }
  const em=u.pathname.match(/^\/api\/editor-session\/([^/]+)\/error$/);
  if (em&&req.method==='POST') {
    const session=sessions.get(em[1]);
    if(!session) return json(res,200,{ok:true,alreadyClosed:true});
    let detail={};
    try { detail=JSON.parse((await readBody(req)).toString()||'{}'); } catch {}
    if(!sessionAllowed(session,who,detail.shareToken)) return json(res,403,{error:'session_owner_required'});
    const code=String(detail.code||'unknown').slice(0,32);
    await dropSession(session.id,`editor_error=${code}`);
    return json(res,200,{ok:true});
  }
  const hm=u.pathname.match(/^\/api\/editor-session\/([^/]+)\/heartbeat$/);
  if(hm&&req.method==='POST') {
    const session=sessions.get(hm[1]);
    if(!session) return json(res,404,{error:'session_not_found'});
    let detail={}; try { detail=JSON.parse((await readBody(req)).toString()||'{}'); } catch {}
    if(!sessionAllowed(session,who,detail.shareToken)) return json(res,403,{error:'session_owner_required'});
    const activity=Number(detail.lastActivityAt); const previous=session.lastActivityAt||session.lastSeen;
    session.lastSeen=Date.now();
    session.active=true;
    if(Number.isFinite(activity)&&activity>0&&activity>=previous) session.lastActivityAt=activity;
    if(session.lastActivityAt>previous) { session.idleSaveCompletedAt=0; session.forceSaveRequestedAt=0; }
    await persistSessions();
    return json(res,200,{ok:true,lastSeen:session.lastSeen,idleSeconds:Math.max(0,Math.floor((Date.now()-session.lastActivityAt)/1000))});
  }
  const fm=u.pathname.match(/^\/api\/editor-session\/([^/]+)\/force-save$/);
  if(fm&&req.method==='POST') {
    const session=sessions.get(fm[1]);
    if(!session) return json(res,404,{error:'session_not_found'});
    let detail={}; try { detail=JSON.parse((await readBody(req)).toString()||'{}'); } catch {}
    if(!sessionAllowed(session,who,detail.shareToken)) return json(res,403,{error:'session_owner_required'});
    const requested=await forceSaveSession(session,'editor_close');
    await persistSessions();
    return json(res,requested?200:503,{ok:requested,requested});
  }
  if(u.pathname==='/api/online-sessions'&&req.method==='GET') {
    if(!who.isAdmin) return json(res,403,{error:'admin_required'});
    const now=Date.now();
    return json(res,200,{sessions:[...sessions.values()].map(s=>({id:s.id,path:s.path,uid:s.uid,username:s.username,createdAt:s.createdAt,lastSeen:s.lastSeen,lastActivityAt:s.lastActivityAt,idleSeconds:Math.max(0,Math.floor((now-(s.lastActivityAt||s.lastSeen))/1000)),online:now-s.lastSeen<30000,forceSavePending:Boolean(s.forceSaveRequestedAt)}))});
  }
  const sm=u.pathname.match(/^\/internal\/storage\/([^/]+)\/download(?:\/[^/]+)?$/);if(sm&&(req.method==='GET'||req.method==='HEAD')){
    const s=sessions.get(sm[1]); if(!s||!validSign(s.id,u.searchParams.get('token')))return json(res,403,{error:'invalid_token'});
    try {
      if(!(await checkAcl(s.path,{uid:s.uid},'read')))return json(res,403,{error:'file_access_denied'});
      const handle=await fsp.open(s.path,'r'); const st=await handle.stat();
      const ext=extOf(s.path); const mime={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',doc:'application/msword',pdf:'application/pdf',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',ppt:'application/vnd.ms-powerpoint'}[ext]||'application/octet-stream';
      let start=0; let end=st.size-1; let status=200;
      const range=String(req.headers.range||'');
      const rm=range.match(/^bytes=(\d*)-(\d*)$/);
      if(rm){
        if(rm[1]===''&&rm[2]!==''){const suffix=Number(rm[2]);start=Math.max(0,st.size-suffix);} else {start=Number(rm[1]||0);end=rm[2]===''?end:Number(rm[2]);}
        if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||start>end||start>=st.size){await handle.close();res.writeHead(416,{'content-range':`bytes */${st.size}`});return res.end();}
        end=Math.min(end,st.size-1); status=206;
      }
      const length=end-start+1;
      // Keep the Document Server request signature in the application log. It
      // deliberately excludes its bearer token and all file contents, but lets
      // us distinguish a request made by the converter from a browser retry.
      log('INFO','document download',`id=${s.id} method=${req.method} bytes=${length} range=${range||'none'} ua=${String(req.headers['user-agent']||'-').slice(0,160)} accept=${String(req.headers.accept||'-').slice(0,160)} encoding=${String(req.headers['accept-encoding']||'-').slice(0,80)} host=${String(req.headers.host||'-').slice(0,120)}`);
      // Nginx is an HTTP-aware Unix-socket relay. Use the smallest
      // length-delimited response that Document Server accepts: it does not
      // need Content-Disposition and some converter builds mis-handle a
      // UTF-8 filename parameter received through an upstream relay.
      // Never reflect the original filename here: it may contain non-ASCII
      // characters that older converter releases parse incorrectly. The
      // stable extension-bearing name is enough for format detection.
      const headers={'content-type':mime,'content-length':length,'content-disposition':`inline; filename="source.${ext}"`,'accept-ranges':'bytes','cache-control':'no-store','x-content-type-options':'nosniff'};
      if(status===206)headers['content-range']=`bytes ${start}-${end}/${st.size}`;
      res.writeHead(status,headers);
      if(req.method==='HEAD'){await handle.close();return res.end();}
      const stream=handle.createReadStream({start,end}); stream.on('close',()=>handle.close().catch(()=>{})); stream.on('error',error=>{log('ERROR','document download failed',`${s.path} ${error.message}`);if(!res.writableEnded)res.destroy(error);}); stream.pipe(res);
    } catch(error){log('ERROR','cannot open document',`${s.path} ${error.message}`);json(res,error?.code==='EACCES'?403:404,{error:error?.code==='EACCES'?'file_access_denied':'file_not_found'});}
    return;
  }
  const cm=u.pathname.match(/^\/internal\/onlyoffice\/callback\/([^/]+)$/);if(cm&&req.method==='POST'){const s=sessions.get(cm[1]);if(!s||!validSign(s.id,u.searchParams.get('token')))return json(res,403,{error:'invalid_token'});const auth=req.headers[String(config.jwtHeader||'Authorization').toLowerCase()];if(auth&&config.jwtSecret&&!verifyJwt(auth,config.jwtSecret))return json(res,403,{error:'invalid_jwt'});try{const data=JSON.parse((await readBody(req)).toString()||'{}');const status=Number(data.status);s.lastSeen=Date.now();log('INFO','callback',`id=${s.id} status=${status} url=${data.url||''}`);if([2,6].includes(status)&&data.url){const editedUrl=normalizeOnlyOfficeDownload(data.url);const edited=await fetch(editedUrl).then(r=>{if(!r.ok)throw new Error(`download ${r.status}`);return r.arrayBuffer();});log('INFO','callback download',`id=${s.id} bytes=${edited.byteLength} url=${editedUrl}`);await atomicReplace(s.path,edited,s);s.forceSaveRequestedAt=0;s.lastSavedAt=Date.now();if(status===2) await dropSession(s.id,'saved'); else {s.idleSaveCompletedAt=Date.now();await persistSessions();log('INFO','callback saved',`id=${s.id} file=${s.path} mode=forcesave`);}}else if(status===4){await dropSession(s.id,'callback_closed');}else if([3,7].includes(status)){s.error=String(status);s.forceSaveRequestedAt=0;await persistSessions();}return json(res,200,{error:0});}catch(e){log('ERROR','callback save failed',`${s.path} ${e.stack||e.message}`);s.forceSaveRequestedAt=0;await persistSessions().catch(()=>{});return json(res,500,{error:1,message:e.message});}}
  if(u.pathname.startsWith('/onlyoffice/')) return proxyHttp(req,res,config.onlyOfficeUrl,u.pathname.replace('/onlyoffice','')+(u.search||''));
  if(u.pathname==='/'||u.pathname==='/settings'||u.pathname==='/open'||u.pathname==='/fonts'||u.pathname==='/auth-callback.html'){const file=path.join(uiDir,u.pathname==='/open'?'open.html':u.pathname==='/fonts'?'fonts.html':u.pathname==='/auth-callback.html'?'auth-callback.html':'index.html');return serveFile(res,file,'text/html; charset=utf-8');}
  if(['/settings.js','/open.js','/fonts.js','/auth-callback.js','/trim-web-app.js'].includes(u.pathname))return serveFile(res,path.join(uiDir,u.pathname.slice(1)),'application/javascript; charset=utf-8');
  if(u.pathname==='/style.css')return serveFile(res,path.join(uiDir,'style.css'),'text/css; charset=utf-8');
  return json(res,404,{error:'not_found'});
}

try{if(fs.existsSync(socketPath))fs.unlinkSync(socketPath);}catch{}
const server=http.createServer((req,res)=>handle(req,res).catch(e=>{console.error(`FnOffice request failed: ${e.stack||e.message}`);json(res,500,{error:'internal_error',message:e.message});}));
server.on('upgrade',(req,socket,head)=>{const raw=new URL(req.url,'http://localhost');const p=raw.pathname.startsWith('/app/FnOffice')?(raw.pathname.slice('/app/FnOffice'.length)||'/'):raw.pathname;if(p.startsWith('/onlyoffice/'))proxyUpgrade(req,socket,head,config.onlyOfficeUrl,p.replace('/onlyoffice','')+(raw.search||''));else {log('WARN','unknown websocket path',p);socket.destroy();}});
server.on('clientError',(error,socket)=>{log('ERROR','gateway client error',error.message);try{socket.destroy();}catch{}});
const listenTarget=process.platform==='win32'?{host:'127.0.0.1',port:Number(process.env.FNOFFICE_DEV_PORT||0)}:socketPath;
server.listen(listenTarget,async()=>{if(typeof listenTarget==='string'){try{fs.chmodSync(socketPath,0o666);}catch{};console.log(`FnOffice listening on ${socketPath}`);}else console.log(`FnOffice development listener on ${JSON.stringify(server.address())}`);await syncCompose();await restartCompose();});
  setInterval(async()=>{const now=Date.now();const cutoff=now-60000;let changed=false;for(const [id,s] of sessions){if(s.lastSeen<cutoff){sessions.delete(id);await removeBridge(s);changed=true;log('INFO','session cleaned','id='+id+' reason=heartbeat_lost');continue;}s.active=true;if(now-(s.lastActivityAt||s.lastSeen)>=IDLE_FORCE_SAVE_MS&&!s.idleSaveCompletedAt&&!s.forceSaveRequestedAt){const peer=[...sessions.values()].find(other=>other.id!==s.id&&other.active&&other.key===s.key&&other.forceSaveRequestedAt);if(!peer) await forceSaveSession(s,'idle_5m');}}if(changed)await persistSessions();},10000).unref();
