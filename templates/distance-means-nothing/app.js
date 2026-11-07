import {CITIES,THEMES,blank,validTz,distanceKm,clockInfo,diffLabel,countdown,daysTogether} from './core.js';
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const KEY='crushify.distance.v1';let S=blank(),scene=null,glOK=false;
const b64e=o=>btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g,'-').replace(/\//g,'_'),b64d=s=>JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g,'+').replace(/_/g,'/')))));
const get=(o,p)=>p.split('.').reduce((a,k)=>a?.[k],o),set=(o,p,v)=>{const k=p.split('.'),l=k.pop();k.reduce((a,x)=>a[x],o)[l]=v};
const merge=d=>{const b=blank();for(const k in b){if(d?.[k]===undefined)continue;b[k]=b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k])?{...b[k],...d[k]}:d[k]}return b};
const publicationData=window.CRUSHIFY_PUBLICATION_DATA;
const recipient=Boolean(publicationData)||location.hash.startsWith('#v=');
try{S=merge(publicationData||(recipient?b64d(location.hash.slice(3)):JSON.parse(localStorage.getItem(KEY)||'null')))}catch{}
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(S))}catch{}};
const th=()=>THEMES[S.theme]||THEMES['midnight-distance'];
// ---------- editor ----------
const tzs=Intl.supportedValuesOf?Intl.supportedValuesOf('timeZone'):['UTC'];
$$('.tz').forEach(s=>s.innerHTML='<option value="">Chọn múi giờ</option>'+tzs.map(z=>`<option>${z}</option>`).join(''));
$('#cities').innerHTML=CITIES.map(c=>`<option value="${c.n}">`).join('');
function bind(){$$('[data-k]').forEach(el=>{el.value=get(S,el.dataset.k)??''});$$('[data-city]').forEach(el=>el.value=S[el.dataset.city].city);
 $('#kmRow').hidden=S.distance.mode!=='manual';listMsgs()}
$$('[data-k]').forEach(el=>el.addEventListener('input',()=>{let v=el.value;if(el.type==='number')v=v?+v:null;set(S,el.dataset.k,v);if(el.dataset.k==='distance.mode')$('#kmRow').hidden=v!=='manual';changed(el.dataset.k==='theme'||el.dataset.k==='animation')}));
$$('[data-city]').forEach(el=>el.addEventListener('input',()=>{const p=S[el.dataset.city],c=CITIES.find(x=>x.n.toLowerCase()===el.value.trim().toLowerCase());
 p.city=el.value;if(c){Object.assign(p,{timezone:c.tz,lat:c.lat,lon:c.lon});$(`[data-k="${el.dataset.city}.timezone"]`).value=c.tz}else{p.lat=p.lon=null}changed()}));
function listMsgs(){const L=$('#msgList');L.innerHTML='';S.messages.forEach((m,i)=>{const d=document.createElement('div');d.className='msg';
 d.innerHTML=`<input class="e" maxlength="4" placeholder="💌" aria-label="Biểu tượng"><input class="t" placeholder="Mở khi em nhớ anh" aria-label="Tiêu đề"><textarea class="c" rows="3" placeholder="Viết lời nhắn của bạn" aria-label="Nội dung"></textarea><button type="button">Xóa</button>`;
 $('.e',d).value=m.emoji||'';$('.t',d).value=m.title||'';$('.c',d).value=m.body||'';
 $('.e',d).oninput=e=>{m.emoji=e.target.value;changed(2)};$('.t',d).oninput=e=>{m.title=e.target.value;changed(2)};$('.c',d).oninput=e=>{m.body=e.target.value;changed(2)};
 $('button',d).onclick=()=>{S.messages.splice(i,1);listMsgs();changed(2)};L.append(d)})}
$('#addMsg').onclick=()=>{S.messages.push({emoji:'💌',title:'',body:''});listMsgs();changed(2)};
let tm;function changed(rebuild){window.dispatchEvent(new Event('crushify:changed'));save();render();clearTimeout(tm);if(rebuild)tm=setTimeout(()=>scene?.apply(S,th()),rebuild===2?400:0)}
// ---------- HUD ----------
const lab=p=>p.name||'';
function render(){const t=th(),r=document.documentElement.style;r.setProperty('--ui',t.c1);
 $('#title h1').textContent=S.headline;const dt=daysTogether(S),km=distanceKm(S);
 $('#sub').textContent=[S.sender.name&&S.receiver.name?`${S.sender.name} & ${S.receiver.name}`:'',dt!=null?`đã bên nhau ${dt.toLocaleString('vi-VN')} ngày`:''].filter(Boolean).join('  ·  ');
 $('#distHint').textContent=S.distance.mode==='manual'?'':km!=null?`Khoảng cách đường chim bay: ${km.toLocaleString('vi-VN')} km`:'Chọn hai thành phố để tính khoảng cách hoặc chuyển sang chế độ tự nhập.';
 const cl=$('#clocks');if(!cl.children.length)cl.innerHTML=['a','b'].map(k=>`<div class="clk ${k}"><b></b><div class="t">--:--:--</div><small></small><small></small></div>`).join('');tick()}
function tick(){const cl=$('#clocks'),[A,B]=[S.sender,S.receiver],ok=validTz(A.timezone)&&validTz(B.timezone);
 [[A,B,0],[B,A,1]].forEach(([p,o,i])=>{const el=cl.children[i],v=validTz(p.timezone);el.hidden=!v;if(!v)return;const c=clockInfo(p.timezone),oc=validTz(o.timezone)?clockInfo(o.timezone):null;
  $('b',el).textContent=`${i?'GIỜ CỦA NGƯỜI ẤY':'GIỜ CỦA BẠN'}${p.name?' · '+p.name:''}`;$('.t',el).innerHTML=`<span class="sun">${c.day?'☀️':'🌙'}</span>${c.time}`;
  const ss=el.querySelectorAll('small');ss[0].textContent=`${p.city||p.timezone} · ${c.date}`;
  ss[1].textContent=ok?`${c.greet} · ${i?diffLabel(A.timezone,B.timezone):diffLabel(B.timezone,A.timezone)}${oc&&oc.ymd!==c.ymd?(c.ymd>oc.ymd?' · đã sang ngày mai':' · vẫn là ngày hôm qua'):''}`:c.greet});
 const n=$('#count'),cd=countdown(S),km=distanceKm(S);let h='';
 if(cd?.done)h='<p>Cuối cùng chúng mình cũng được ở bên nhau.</p>';
 else if(cd)h=`<p>Đếm ngược đến ngày gặp lại…</p>`+[['d','Ngày'],['h','Giờ'],['m','Phút'],['s','Giây']].map(([k,l])=>`<span class="n" data-k="${k}">${String(cd[k]).padStart(2,'0')}<small>${l}</small></span>`).join('')+(cd.d?`<p style="font-size:14px;margin-top:4px">Chỉ còn ${cd.d} ngày nữa là chúng mình gặp lại.</p>`:'');
 if(km!=null)h+=`<div class="dist">${km.toLocaleString('vi-VN')} km cách nhau${S.distance.mode==='manual'?'':' (đường chim bay)'}</div>`;
 const prev=n.dataset.s;if(h!==prev){const old=n.innerHTML;n.innerHTML=h;n.dataset.s=h;if(cd&&!cd.done)$$('.n',n).forEach(e=>{const m=old.match(new RegExp(`data-k="${e.dataset.k}">(\\d+)`));if(m&&m[1]!==e.firstChild.textContent)e.classList.add('pop')})}}
setInterval(()=>!document.hidden&&tick(),1000);
// ---------- panel / phases ----------
const panel=$('#panel');
function open(e,t,b){$('#pe').textContent=e||'';$('#pt').textContent=t||'';$('#pb').textContent=b||'';panel.hidden=false;$('#close').focus()}
$('#close').onclick=()=>{panel.hidden=true;scene?.reset()};
const phase=$('#phase');function say(t){phase.textContent=t;phase.classList.remove('fade');void phase.offsetWidth;phase.classList.add('fade')}
const PH=[()=>'',()=>'Hai thế giới.\nMột trái tim.',()=>'Dẫu cách nhau muôn trùng,\nanh vẫn luôn ở trong tim em.',()=>{phase.textContent='';phase.className=''}];
function onPhase(i){if(i===0)say(`${S.sender.name||'Bạn'}  ·  ${S.receiver.name||'Người ấy'}`);else if(i===1)say('Hai nơi chốn.\nMột trái tim. Khoảng cách chẳng là gì.');else if(i===2)say('Dẫu cách nhau muôn trùng,\nanh vẫn luôn ở trong tim em.');else{phase.textContent='';phase.className=''}}
function onPick(u){if(u.type==='msg'){const m=S.messages[u.index];open(m.emoji,m.title,m.body)}else if(u.type==='link')open('💞',S.headline,S.message||'')
 else if(u.type==='A'||u.type==='B'){const p=u.type==='A'?S.sender:S.receiver;if(p.name||p.city)open('🪐',p.name,p.city)}}
// ---------- tools ----------
const act={rotate(b){const v=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',v);scene?.setAuto(v)},zin:()=>zoom(.8),zout:()=>zoom(1.25),pa:()=>scene?.focusPlanet(0),pb:()=>scene?.focusPlanet(1),link:()=>{scene?.focusLink();onPick({type:'link'})},reset:()=>{panel.hidden=true;scene?.reset()},
 parts(b){const v=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',v);scene?.setParticles(v)},replay:()=>{panel.hidden=true;scene?.start()},skip:()=>scene?.skip(),
 full:()=>document.fullscreenElement?document.exitFullscreen():$('#stage').requestFullscreen?.(),end:()=>{$('#final').hidden=false;$('#sig').textContent=[S.sender.name,S.receiver.name].filter(Boolean).join(' & ')}};
function zoom(k){if(!scene)return;const c=scene.cam,t=scene.ctl.target;c.position.sub(t).multiplyScalar(k).add(t)}
$$('#tools button').forEach(b=>b.onclick=()=>act[b.dataset.a](b));$('#back').onclick=()=>$('#final').hidden=true;
if(!document.fullscreenEnabled&&!document.webkitFullscreenEnabled)$('[data-a=full]').hidden=true;
addEventListener('keydown',e=>{if(e.key==='Escape'){panel.hidden=true;$('#final').hidden=true}});
// ---------- mode / tabs / share ----------
function setView(v){document.body.classList.toggle('view',v);scene?.resize()}
$('#viewAs').onclick=()=>{setView(true);scene?.start();history.replaceState(null,'','#preview')};
$('#copyLink').onclick=async e=>{const d={...S,memories:[]},u=location.href.split('#')[0]+'#v='+b64e(d);try{await navigator.clipboard.writeText(u);e.target.textContent='Đã sao chép liên kết'}catch{prompt('Sao chép liên kết này',u)}setTimeout(()=>e.target.textContent='Sao chép liên kết người nhận',2000)};
const mobileTabs=matchMedia('(max-width:800px)');let mobileTabChosen=false;
const selectMobileTab=stage=>{$$('#tabs button').forEach(b=>{const selected=b.dataset.t===(stage?'stage':'editor');b.classList.toggle('on',selected);b.setAttribute('aria-pressed',String(selected))});document.body.classList.toggle('tab-stage',stage);scene?.resize()};
$$('#tabs button').forEach(b=>b.onclick=()=>{mobileTabChosen=true;selectMobileTab(b.dataset.t==='stage')});
if(recipient||location.hash==='#preview')document.body.classList.add('view');
if(mobileTabs.matches&&!document.body.classList.contains('view'))selectMobileTab(true);
mobileTabs.addEventListener('change',event=>{if(event.matches&&!mobileTabChosen&&!document.body.classList.contains('view'))selectMobileTab(true)});
addEventListener('resize',()=>{if(mobileTabs.matches&&!mobileTabChosen&&!document.body.classList.contains('view'))selectMobileTab(true)});
window.registerCrushifyCustomerEditor({
templateId:'distance-means-nothing',schemaVersion:1,
async serialize(){return structuredClone(S)},
async hydrate(data){S=merge(data);bind();render();scene?.apply(S,th())}
});
// ---------- boot ----------
bind();render();
(async()=>{try{const {DistanceScene}=await import('./DistanceScene.js');scene=new DistanceScene($('#gl'),{onPick,onPhase});glOK=true;scene.apply(S,th());scene.start()}
 catch(err){console.warn('WebGL unavailable, using fallback:',err);document.body.classList.add('nogl');$('#gl').hidden=true;$('#fallback').hidden=false;$('[data-a=skip]').hidden=true;
  const tb=$('#tools');$$('button',tb).forEach(b=>{if(!['end','full'].includes(b.dataset.a))b.hidden=true});
  const mk=()=>{$$('.fbm').forEach(x=>x.remove());S.messages.forEach((m,i)=>{const b=document.createElement('button');b.className='fbm';b.textContent=`${m.emoji||'💌'} ${m.title||'Lời nhắn'}`;b.onclick=()=>open(m.emoji,m.title,m.body);tb.prepend(b)})};mk()}})();
