(()=>{'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const ASSET_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mk=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c};
const SF='"Playfair Display",Georgia,serif',SC='"Dancing Script","Segoe Script",cursive';
const mobile=matchMedia('(max-width:800px)').matches||/Mobi|Android/i.test(navigator.userAgent);
const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
const TH={
'rose-memories':{n:'Kỷ niệm sắc hồng',cover:'#8a1740',paper:'#fbe9ee',ink:'#4a1330',gold:'#f3c98b',acc:'#ff5fa2',light:0xff6fb0,bg:['#3a0a24','#10020a'],pt:0xff8fc4,frame:'#fff6f8',plat:0x6b1a45},
'midnight-diary':{n:'Nhật ký đêm',cover:'#1b1f4b',paper:'#e7e8f6',ink:'#1b1f4b',gold:'#c9d3ff',acc:'#8fa6ff',light:0x7f9bff,bg:['#101650','#03040f'],pt:0x9fb4ff,frame:'#f2f4ff',plat:0x1e2660},
'lavender-dreams':{n:'Giấc mơ oải hương',cover:'#6c4aa6',paper:'#f1eaff',ink:'#3e2a68',gold:'#f0dcff',acc:'#c59bff',light:0xb78cff,bg:['#3a1a6a','#0e0420'],pt:0xd6b3ff,frame:'#faf6ff',plat:0x4b2f86},
'vintage-ivory':{n:'Ngà hoài cổ',cover:'#7a5230',paper:'#f6ecd6',ink:'#4b3420',gold:'#f0cf90',acc:'#e0a85a',light:0xffc27a,bg:['#3a2312','#0f0804'],pt:0xffd49a,frame:'#fdf6e6',plat:0x5a3d22}};
const AN={cinematic:{rot:.07,pm:1,ring:1,spd:1},dreamy:{rot:.03,pm:1.8,ring:1,spd:.6},nostalgic:{rot:.02,pm:.7,ring:.5,spd:.8},minimal:{rot:0,pm:.25,ring:0,spd:1}};
const sky=(a,b,c)=>{const k=mk(480,600),x=k.getContext('2d'),g=x.createLinearGradient(0,0,0,600);g.addColorStop(0,a);g.addColorStop(.6,b);g.addColorStop(1,c);x.fillStyle=g;x.fillRect(0,0,480,600);x.fillStyle='rgba(255,235,210,.9)';x.beginPath();x.arc(240,340,46,0,7);x.fill();x.fillStyle='rgba(20,0,30,.55)';x.beginPath();x.moveTo(0,430);x.quadraticCurveTo(240,370,480,440);x.lineTo(480,600);x.lineTo(0,600);x.fill();return k.toDataURL('image/jpeg',.8)};
const defaults=()=>({templateId:'our-memories',sender:'Minh',receiver:'Linh',nickname:'Bé yêu',albumTitle:'Kỷ niệm đôi mình',subtitle:'Bởi mỗi khoảnh khắc bên em đều là một câu chuyện đẹp.',anniversary:'2024-02-14',theme:'rose-memories',animation:'cinematic',coverImage:sky('#ff9a8b','#a14d8f','#2b1055'),
introduction:'Cuốn album này lưu giữ những điều nhỏ bé mà anh không muốn quên.',story:'Mọi chuyện bắt đầu từ một tách cà phê, rồi lặng lẽ trở thành tất cả.',
chapters:[{id:'first-meet',title:'Lần đầu gặp gỡ',date:'2024-02-14',description:'Ngày mình gặp nhau. Anh vẫn nhớ hôm ấy em mặc gì và anh đã hồi hộp ra sao.',photos:[{url:sky('#ffb38a','#c2507a','#2b1055'),caption:'Ngày đầu tiên bên nhau'},{url:sky('#ffd1a1','#d86a8f','#3a1060'),caption:'Tách cà phê đầu tiên'}]},
{id:'our-journey',title:'Hành trình đôi mình',date:'2025-01-01',description:'Những chuyến đi, những cuộc trò chuyện đêm khuya và cả ngày bình thường hóa thành điều tuyệt vời nhất.',photos:[{url:sky('#7fd1ff','#8a6fd6','#1b1040'),caption:'Hoàng hôn bên nhau'},{url:sky('#ffe08a','#e0707a','#40144f'),caption:'Lạc giữa phố'},{url:sky('#a8e6cf','#5f7fd1','#1c1450'),caption:'Ngày chủ nhật mưa'}]},
{id:'to-infinity',title:'Đến vô cùng',date:'',description:'Mọi điều chúng mình vẫn muốn cùng nhau thực hiện.',photos:[{url:sky('#ffc3e0','#9a5ad6','#20104a'),caption:'Chương tiếp theo'}]}],
closingMessage:'Mong có thêm thật nhiều kỷ niệm và những câu chuyện đẹp vẫn đang chờ chúng mình.',signature:'Minh',music:''});
let D=window.MEMORIES_DATA||defaults();const viewOnly=!!window.MEMORIES_DATA||/mode=view/.test(location.search);
const th=()=>TH[D.theme]||TH['rose-memories'],an=()=>AN[D.animation]||AN.cinematic;
const flat=()=>D.chapters.flatMap((c,ci)=>c.photos.map(p=>(p.ch=ci,p)));
const setFlat=a=>D.chapters.forEach((c,ci)=>c.photos=a.filter(p=>p.ch===ci));
const IM={};let tm;const soon=()=>{window.dispatchEvent(new Event('crushify:changed'));clearTimeout(tm);tm=setTimeout(apply,220)};
function img(u){if(!u)return null;let i=IM[u];if(!i){i=IM[u]=new Image();i.onload=()=>{i.ok=1;soon()};i.src=u}return i.ok?i:null}
function fit(x,i,dx,dy,w,h){if(!i){x.fillStyle='rgba(0,0,0,.15)';x.fillRect(dx,dy,w,h);return}const r=Math.max(w/i.width,h/i.height),sw=w/r,sh=h/r;x.drawImage(i,(i.width-sw)/2,(i.height-sh)/2,sw,sh,dx,dy,w,h)}
function wrap(x,t,px,py,mw,lh){let l='',n=0;for(const k of String(t||'').split(/\s+/)){const s=l?l+' '+k:k;if(x.measureText(s).width>mw&&l){x.fillText(l,px,py+n++*lh);l=k}else l=s}x.fillText(l,px,py+n*lh)}
const fmt=d=>d?new Date(d).toLocaleDateString('vi-VN',{day:'numeric',month:'long',year:'numeric'}):'Một ngày nào đó';
function face(f,idx){const c=mk(512,720),x=c.getContext('2d'),T=th();x.fillStyle=T.paper;x.fillRect(0,0,512,720);
for(let i=0;i<500;i++){x.fillStyle=`rgba(120,90,60,${Math.random()*.05})`;x.fillRect(Math.random()*512,Math.random()*720,2,2)}
const L=idx%2===0,g=x.createLinearGradient(L?512:0,0,L?400:112,0);g.addColorStop(0,'rgba(0,0,0,.3)');g.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=g;x.fillRect(0,0,512,720);
x.fillStyle=T.ink;x.textAlign='center';const hd=(t,y,s)=>{x.font=`italic ${s}px ${SF}`;wrap(x,t,256,y,380,s*1.2)};
if(f.t==='intro'){x.font='60px serif';x.fillStyle=T.cover;x.fillText('♥',256,150);x.fillStyle=T.ink;hd(D.albumTitle,240,46);x.font=`28px ${SC}`;x.fillText(`${D.receiver} & ${D.sender}`,256,320);x.font=`19px ${SF}`;wrap(x,D.introduction,256,390,370,30);x.font=`italic 16px ${SF}`;x.globalAlpha=.75;wrap(x,D.story,256,540,360,26);x.globalAlpha=1}
else if(f.t==='ch'){const c=D.chapters[f.ci];x.font=`16px ${SF}`;x.fillText('CHƯƠNG '+(f.ci+1),256,130);hd(c.title,210,50);x.fillStyle=T.cover;x.fillRect(216,290,80,2);x.fillStyle=T.ink;x.font=`26px ${SC}`;x.fillText(c.date?fmt(c.date):'',256,340);x.font=`19px ${SF}`;wrap(x,c.description,256,400,370,32)}
else if(f.t==='ph'){f.l.forEach((p,k)=>{const y=40+k*335;x.save();x.translate(256,y+150);x.rotate((k?1:-1)*.025);x.fillStyle=T.frame;x.shadowColor='rgba(0,0,0,.3)';x.shadowBlur=12;x.fillRect(-190,-150,380,300);x.shadowBlur=0;fit(x,img(p.url),-176,-136,352,230);x.fillStyle=T.ink;x.font=`26px ${SC}`;x.fillText(p.caption||'',0,120);x.restore()})}
else if(f.t==='end'){x.font='54px serif';x.fillStyle=T.cover;x.fillText('♥',256,170);x.fillStyle=T.ink;x.font=`italic 24px ${SF}`;wrap(x,D.closingMessage,256,250,360,38);x.font=`18px ${SF}`;x.fillText('Thương em thật nhiều,',256,500);x.font=`50px ${SC}`;x.fillText(D.signature,256,570)}
return c}
function coverTex(){const c=mk(512,720),x=c.getContext('2d'),T=th();x.fillStyle=T.cover;x.fillRect(0,0,512,720);for(let i=0;i<2500;i++){x.fillStyle=`rgba(255,255,255,${Math.random()*.06})`;x.fillRect(Math.random()*512,Math.random()*720,1.5,1.5)}
x.strokeStyle=T.gold;x.lineWidth=3;x.strokeRect(34,34,444,652);x.lineWidth=1;x.strokeRect(46,46,420,628);x.textAlign='center';x.fillStyle=T.gold;
const im=img(D.coverImage);if(im){x.save();x.beginPath();x.arc(256,260,125,0,7);x.clip();fit(x,im,131,135,250,250);x.restore();x.lineWidth=4;x.beginPath();x.arc(256,260,128,0,7);x.stroke()}else{x.font='170px serif';x.fillText('♥',256,320)}
x.font=`italic 40px ${SF}`;wrap(x,D.albumTitle,256,470,380,46);x.font=`34px ${SC}`;x.fillText(`${D.sender} ♥ ${D.receiver}`,256,600);x.font=`15px ${SF}`;x.fillText(D.anniversary||'',256,640);return c}
/* ---------- state ---------- */
const S={spread:0,open:false,lb:-1};let gl=false,THREE_,R,scene,camera,renderer,book,leaves=[],NL=0,N=0,faces=[],chStart=[],texs=[],bookMeshes=[],pol,PH=[],G={},fbi=0,snd=false,AC,music;
const W=3,H=4.2,NS=22,DY=.045,cam={th:0,ph:.96,r:11,tx:0,ty:.4,tz:0},g={...cam};
const defR=()=>(11-(S.open?.5:0))*(innerWidth/innerHeight<.8?1.8:1);
const reset=()=>{Object.assign(g,{th:0,ph:.96,r:defR(),tx:0,ty:.4,tz:0})};
function swoosh(){if(!snd)return;try{AC=AC||new(window.AudioContext||window.webkitAudioContext)();const a=AC,n=a.sampleRate*.35,b=a.createBuffer(1,n,a.sampleRate),d=b.getChannelData(0);for(let i=0;i<n;i++)d[i]=(Math.random()*2-1)*(1-i/n);const s=a.createBufferSource(),f=a.createBiquadFilter(),v=a.createGain();s.buffer=b;f.type='bandpass';f.frequency.setValueAtTime(900,a.currentTime);f.frequency.linearRampToValueAtTime(3000,a.currentTime+.3);v.gain.value=.12;s.connect(f);f.connect(v);v.connect(a.destination);s.start()}catch(e){}}
/* ---------- book ---------- */
function buildFaces(){faces=[{t:'intro'}];chStart=[];D.chapters.forEach((c,ci)=>{chStart.push(faces.length);faces.push({t:'ch',ci});for(let i=0;i<c.photos.length;i+=2)faces.push({t:'ph',l:c.photos.slice(i,i+2)})});faces.push({t:'end'});if(faces.length%2===0)faces.splice(faces.length-1,0,{t:'blank'});N=(faces.length-1)/2;NL=N+1}
function bend(L){const t=L.t,e=t*t*(3-2*t),a0=Math.PI*e,lag=.9*Math.sin(a0),d=L.w/NS,P=L.gF.attributes.position,yb=.03+(1-e)*(NL-L.i)*DY+e*L.i*DY;let X=0,Y=0;
for(let i=0;i<=NS;i++){P.setXYZ(i,X,Y+yb,-L.h/2);P.setXYZ(NS+1+i,X,Y+yb,L.h/2);const a=a0-lag*i/NS;X+=d*Math.cos(a);Y+=d*Math.sin(a)}
P.needsUpdate=true;L.gF.computeVertexNormals();L.gB.computeVertexNormals();if(L.i===0)book.position.x=-W/2*(1-e)}
const tex=c=>{const t=new R.CanvasTexture(c);t.anisotropy=4;t.encoding=R.sRGBEncoding;texs.push(t);return t};
function buildBook(){if(book){scene.remove(book);book.traverse(o=>{o.geometry&&o.geometry.dispose();o.material&&o.material.dispose()});texs.forEach(t=>t.dispose())}
texs=[];leaves=[];bookMeshes=[];buildFaces();const T=th();book=new R.Group();
for(let i=0;i<=N;i++){const cv=i===0,w=cv?W*1.04:W,h=cv?H*1.04:H,gF=new R.PlaneGeometry(w,h,NS,1),gB=new R.BufferGeometry();
gB.setAttribute('position',gF.attributes.position);gB.setIndex(gF.index);const uv=gF.attributes.uv.clone();for(let k=0;k<uv.count;k++)uv.setX(k,1-uv.getX(k));gB.setAttribute('uv',uv);
const mF=new R.Mesh(gF,new R.MeshStandardMaterial({map:tex(cv?coverTex():face(faces[2*i-1],2*i-1)),roughness:cv?.45:.85})),mB=new R.Mesh(gB,new R.MeshStandardMaterial({map:tex(face(faces[2*i],2*i)),roughness:.85,side:R.BackSide}));
mF.frustumCulled=mB.frustumCulled=false;book.add(mF,mB);bookMeshes.push(mF,mB);const L={i,w,h,gF,gB,t:i<S.spread?1:0};leaves.push(L);bend(L)}
const cm=new R.MeshStandardMaterial({color:T.cover,roughness:.55}),bc=new R.Mesh(new R.BoxGeometry(W*1.04,.06,H*1.04),cm);bc.position.set(W*.52,-.02,0);
const sp=new R.Mesh(new R.BoxGeometry(.1,NL*DY+.1,H*1.04),cm);sp.position.set(-.04,NL*DY/2,0);book.add(bc,sp);scene.add(book);G.spine=sp}
/* ---------- polaroids ---------- */
function buildPol(){if(pol){scene.remove(pol);pol.traverse(o=>{if(o.material){[].concat(o.material).forEach(m=>{m.map&&m.map.dispose();m.dispose()})}o.geometry&&o.geometry.dispose()})}
pol=new R.Group();PH=flat().slice(0,12);const T=th();PH.forEach((p,i)=>{const c=mk(256,320),x=c.getContext('2d');x.fillStyle=T.frame;x.fillRect(0,0,256,320);for(let k=0;k<200;k++){x.fillStyle=`rgba(120,90,60,${Math.random()*.05})`;x.fillRect(Math.random()*256,Math.random()*320,2,2)}fit(x,img(p.url),14,14,228,238);x.fillStyle=T.ink;x.textAlign='center';x.font=`24px ${SC}`;x.fillText(p.caption||'',128,290);
const t=new R.CanvasTexture(c);t.encoding=R.sRGBEncoding;const e=new R.MeshStandardMaterial({color:T.frame,roughness:.9}),m=new R.Mesh(new R.BoxGeometry(1.05,1.31,.03),[e,e,e,e,new R.MeshStandardMaterial({map:t,roughness:.7}),e]);
const a=i/PH.length*Math.PI*2+.4,r=5.2+Math.random()*1.3;m.userData={pi:i,base:new R.Vector3(Math.cos(a)*r,1.5+(i%3)*.9+Math.random()*.4,Math.sin(a)*r*.8),tilt:(Math.random()-.5)*.5,ph:Math.random()*6};m.position.copy(m.userData.base);pol.add(m)});scene.add(pol)}
/* ---------- scene ---------- */
const glowT=(h)=>{const c=mk(64,64),x=c.getContext('2d');if(h){x.fillStyle='#fff';x.font='54px serif';x.textAlign='center';x.fillText('♥',32,50)}else{const g=x.createRadialGradient(32,32,0,32,32,32);g.addColorStop(0,'#fff');g.addColorStop(.3,'rgba(255,255,255,.5)');g.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=g;x.fillRect(0,0,64,64)}return new R.CanvasTexture(c)};
function pts(n,size,tx,spread,y0,hgt){const ge=new R.BufferGeometry(),p=new Float32Array(n*3);for(let i=0;i<n*3;i+=3){p[i]=(Math.random()-.5)*spread;p[i+1]=y0+Math.random()*hgt;p[i+2]=(Math.random()-.5)*spread}ge.setAttribute('position',new R.BufferAttribute(p,3));const m=new R.Points(ge,new R.PointsMaterial({size,map:tx,transparent:true,depthWrite:false,blending:R.AdditiveBlending}));m.frustumCulled=false;return m}
function initScene(){scene=new R.Scene();scene.fog=new R.Fog(0x10020a,16,70);camera=new R.PerspectiveCamera(45,1,.1,200);
G.amb=new R.HemisphereLight(0xffe3ee,0x2a0618,.95);G.key=new R.DirectionalLight(0xffffff,.7);G.key.position.set(3,9,6);G.pl=new R.PointLight(0xff6fb0,0,14);G.pl.position.set(0,2.2,0);scene.add(G.amb,G.key,G.pl);
const gt=glowT(),ht=glowT(1);
G.stars=pts(mobile?500:1000,1.4,gt,160,-80,160);G.stars.material.sizeAttenuation=false;G.stars.material.size=2;
G.dust=pts(mobile?120:350,.14,gt,24,-1,10);G.hearts=pts(mobile?20:45,.45,ht,18,-1,10);G.burst=pts(160,.22,gt,0,.3,0);G.burst.v=new Float32Array(480);G.burst.life=0;
G.part=new R.Group();G.part.add(G.dust,G.hearts,G.burst);scene.add(G.stars,G.part);
const plm=new R.MeshStandardMaterial({color:0x6b1a45,metalness:.85,roughness:.28});G.plm=plm;
[[5.2,5.5,.3,-.17],[6.6,6.9,.25,-.42],[8,8.3,.2,-.62]].forEach(([a,b,h,y])=>{const m=new R.Mesh(new R.CylinderGeometry(a,b,h,mobile?40:72),plm);m.position.y=y;scene.add(m)});
G.neon=new R.MeshBasicMaterial({color:0xff5fa2,blending:R.AdditiveBlending,transparent:true,opacity:.9});[[5.25,-.03],[6.7,-.28]].forEach(([r,y])=>{const m=new R.Mesh(new R.TorusGeometry(r,.035,8,96),G.neon);m.rotation.x=Math.PI/2;m.position.y=y;scene.add(m)});
const sh=mk(128,128),sx=sh.getContext('2d'),sg=sx.createRadialGradient(64,64,0,64,64,64);sg.addColorStop(0,'rgba(0,0,0,.6)');sg.addColorStop(1,'rgba(0,0,0,0)');sx.fillStyle=sg;sx.fillRect(0,0,128,128);G.shadow=new R.Mesh(new R.PlaneGeometry(9,7),new R.MeshBasicMaterial({map:new R.CanvasTexture(sh),transparent:true,depthWrite:false}));G.shadow.rotation.x=-Math.PI/2;G.shadow.position.y=.005;scene.add(G.shadow);
G.glow=new R.Sprite(new R.SpriteMaterial({map:gt,color:0xff9ad0,blending:R.AdditiveBlending,transparent:true,opacity:0,depthWrite:false}));G.glow.scale.set(9,6,1);G.glow.position.y=.6;scene.add(G.glow);
G.orb=[[4.9,.3,.5,1.6,0],[6,-.4,.35,2.4,2],[7.2,.2,-.28,3.1,4]].map(([r,tl,sp,y,ph])=>{const o=new R.Group();o.rotation.set(tl,0,tl*.6);o.position.y=y;const rg=new R.Mesh(new R.TorusGeometry(r,.012,6,128),G.neon);rg.rotation.x=Math.PI/2;
const ge=new R.BufferGeometry(),n=30,col=new Float32Array(n*3);for(let i=0;i<n;i++)col.fill(1-i/n,i*3,i*3+3);ge.setAttribute('position',new R.BufferAttribute(new Float32Array(n*3),3));ge.setAttribute('color',new R.BufferAttribute(col,3));const c=new R.Points(ge,new R.PointsMaterial({size:.3,map:gt,vertexColors:true,transparent:true,depthWrite:false,blending:R.AdditiveBlending}));c.frustumCulled=false;o.add(rg,c);scene.add(o);return{o,c,r,sp,ph,n}})}
/* ---------- theme / apply ---------- */
function apply(){const T=th(),a=an();document.body.style.setProperty('--b1',T.bg[0]);document.body.style.setProperty('--b2',T.bg[1]);document.body.style.setProperty('--ac',T.acc);
$('#hTitle').textContent=D.albumTitle;$('#hSub').textContent=D.subtitle;$('#hDays').textContent=Math.max(0,Math.floor((Date.now()-new Date(D.anniversary))/864e5)).toLocaleString('vi-VN')+' ngày';$('#hNames').textContent=`${D.sender} & ${D.receiver}`;
const timeline=$('#tl');timeline.replaceChildren();D.chapters.forEach((chapter,i)=>{const button=document.createElement('button'),number=document.createElement('b'),title=document.createElement('span');button.dataset.c=i;number.textContent=i+1;title.textContent=chapter.title;button.append(number,title);button.onclick=()=>goCh(i);timeline.append(button)});
if(gl){scene.fog.color.set(T.bg[1]);G.plm.color.set(T.plat);G.neon.color.set(T.acc);G.neon.opacity=.9*a.ring;G.glow.material.color.set(T.light);G.pl.color.set(T.light);G.part.children.forEach(p=>p.material.color.set(T.pt));G.dust.material.opacity=Math.min(1,a.pm);G.hearts.material.opacity=Math.min(1,a.pm);buildBook();buildPol()}else fbShow(fbi);syncUI()}
function syncUI(){const r=2*S.spread-1;let ci=-1;chStart.forEach((s,i)=>{if(s<=r)ci=i});$$('#tl button').forEach((b,i)=>b.classList.toggle('on',gl?i===ci:i===fbi));$('#replay').hidden=!(gl&&S.open&&S.spread>=NL)}
/* ---------- flow ---------- */
function openAlbum(){if(S.open)return;S.open=true;document.body.classList.add('open');swoosh();if(!gl){fbShow(0);return}S.spread=1;reset();G.burst.life=3;const p=G.burst.geometry.attributes.position.array,v=G.burst.v;for(let i=0;i<p.length;i+=3){p[i]=(Math.random()-.5)*1.5;p[i+1]=.4;p[i+2]=(Math.random()-.5)*2;v[i]=(Math.random()-.5)*1.5;v[i+1]=1+Math.random()*2.5;v[i+2]=(Math.random()-.5)*1.5}syncUI()}
function step(d){if(!S.open)return openAlbum();if(!gl){fbShow(clamp(fbi+d,0,D.chapters.length-1));return}const n=clamp(S.spread+d,1,NL);if(n!==S.spread){S.spread=n;swoosh();syncUI()}}
function goCh(i){if(!S.open)openAlbum();if(!gl)return fbShow(i);const f=chStart[i];S.spread=f%2?(f+1)/2:f/2+1;closeLb();reset();swoosh();syncUI()}
function showPhoto(i){if(!PH.length)return;i=(i+PH.length)%PH.length;S.lb=i;const p=PH[i],c=D.chapters[p.ch];$('#lbImg').src=p.url;$('#lbCap').textContent=p.caption||'';$('#lbDate').textContent=c.date?fmt(c.date):c.title;$('#lb').hidden=false;const w=pol.children[i].userData.base;g.tx=w.x;g.ty=w.y;g.tz=w.z;g.r=5}
function closeLb(){if(S.lb<0)return;S.lb=-1;$('#lb').hidden=true;reset()}
/* ---------- camera / input ---------- */
let ray;const mouse={x:0,y:0};let pts2=new Map(),moved=0,idle=0,pd=0,auto=true;
function bindInput(c){c.addEventListener('pointerdown',e=>{c.setPointerCapture(e.pointerId);pts2.set(e.pointerId,[e.clientX,e.clientY]);moved=0;idle=0;pd=0});
c.addEventListener('pointermove',e=>{const r=c.getBoundingClientRect();mouse.x=(e.clientX-r.left)/r.width*2-1;mouse.y=-((e.clientY-r.top)/r.height*2-1);const o=pts2.get(e.pointerId);if(!o)return;const dx=e.clientX-o[0],dy=e.clientY-o[1];pts2.set(e.pointerId,[e.clientX,e.clientY]);moved+=Math.abs(dx)+Math.abs(dy);idle=0;
if(pts2.size===2){const [a,b]=[...pts2.values()],d=Math.hypot(a[0]-b[0],a[1]-b[1]);if(pd)g.r=clamp(g.r*pd/d,4,18);pd=d}else{g.th-=dx*.006;g.ph=clamp(g.ph-dy*.006,.25,1.45)}});
const up=e=>{if(pts2.size===1&&moved<8)pick(e);pts2.delete(e.pointerId);pd=0};c.addEventListener('pointerup',up);c.addEventListener('pointercancel',e=>pts2.delete(e.pointerId));
c.addEventListener('wheel',e=>{e.preventDefault();g.r=clamp(g.r*(1+e.deltaY*.001),4,18);idle=0},{passive:false})}
function pick(e){const r=renderer.domElement.getBoundingClientRect();ray.setFromCamera({x:(e.clientX-r.left)/r.width*2-1,y:-((e.clientY-r.top)/r.height*2-1)},camera);const h=ray.intersectObjects([...pol.children,...bookMeshes],false)[0];if(!h)return;
if(h.object.userData.pi!==undefined)return showPhoto(h.object.userData.pi);if(!S.open)return openAlbum();step(h.point.x-book.position.x>0?1:-1)}
/* ---------- loop ---------- */
let last=performance.now(),time=0;
function loop(now){requestAnimationFrame(loop);const dt=Math.min(.05,(now-last)/1000);last=now;if(document.hidden)return;const a=an(),mo=$('#motion').checked&&!reduce,T=th();time+=dt*(mo?1:0);idle+=dt;
const sp=dt*(reduce?4:1.15*a.spd);for(const L of leaves){const tg=L.i<S.spread?1:0;if(L.t===tg)continue;if(tg>L.t&&L.i>0&&leaves[L.i-1].t<.3)continue;if(tg<L.t&&L.i<N&&leaves[L.i+1].t>.7)continue;const s=sp*(L.i?1:.7);L.t=tg>L.t?Math.min(tg,L.t+s):Math.max(tg,L.t-s);bend(L)}
if(auto&&mo&&idle>4&&S.lb<0&&!pts2.size)g.th+=dt*a.rot;const k=1-Math.exp(-dt*5);for(const p in cam)cam[p]+=(g[p]-cam[p])*k;
const sn=Math.sin(cam.ph);camera.position.set(cam.tx+cam.r*sn*Math.sin(cam.th)+(mo?mouse.x*.5:0),cam.ty+cam.r*Math.cos(cam.ph)+(mo?mouse.y*.3:0),cam.tz+cam.r*sn*Math.cos(cam.th));camera.lookAt(cam.tx,cam.ty,cam.tz);
const op=leaves[0]?leaves[0].t:0;G.glow.material.opacity=.35*op*(.8+.2*Math.sin(time*2))*(a.ring?1:.5);G.pl.intensity=1.2*op;G.shadow.scale.x=1-.25*(1-op);G.shadow.position.x=book.position.x+W/2*(1-op)*0;
G.stars.rotation.y+=dt*.004*(mo?1:0);
if(G.part.visible){const d=G.dust.geometry.attributes.position.array;for(let i=1;i<d.length;i+=3){d[i]+=dt*.12*a.pm*(mo?1:0);if(d[i]>9)d[i]=-1}G.dust.geometry.attributes.position.needsUpdate=true;
const h=G.hearts.geometry.attributes.position.array;for(let i=0;i<h.length;i+=3){h[i+1]-=dt*.3*(mo?1:0);h[i]+=Math.sin(time+i)*dt*.2;if(h[i+1]<-1)h[i+1]=9}G.hearts.geometry.attributes.position.needsUpdate=true;
if(G.burst.life>0){G.burst.life-=dt;const p=G.burst.geometry.attributes.position.array,v=G.burst.v;for(let i=0;i<p.length;i++)p[i]+=v[i]*dt;G.burst.geometry.attributes.position.needsUpdate=true;G.burst.material.opacity=Math.max(0,G.burst.life/3)}}
G.orb.forEach((o,j)=>{o.o.visible=a.ring>0;const q=o.c.geometry.attributes.position.array;for(let i=0;i<o.n;i++){const an2=o.ph+time*o.sp*a.spd-i*.05*Math.sign(o.sp);q[i*3]=Math.cos(an2)*o.r;q[i*3+1]=0;q[i*3+2]=Math.sin(an2)*o.r}o.c.geometry.attributes.position.needsUpdate=true});
pol.children.forEach(m=>{const u=m.userData;m.position.set(u.base.x,u.base.y+Math.sin(time*.8+u.ph)*.15,u.base.z);m.lookAt(camera.position);m.rotateZ(u.tilt)});
renderer.render(scene,camera)}
function resize(){const s=$('#stage'),w=s.clientWidth,h=s.clientHeight;if(!gl||!w)return;renderer.setPixelRatio(Math.min(devicePixelRatio,mobile?1.5:2));renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();reset()}
/* ---------- 2D fallback ---------- */
function fbShow(i){fbi=i;if(gl)return;const c=D.chapters[i],o=$('#fb'),note=document.createElement('p'),heading=document.createElement('h2'),date=document.createElement('small'),description=document.createElement('p'),grid=document.createElement('div');o.replaceChildren();o.hidden=false;note.className='note';note.textContent='Chế độ 2D: Không thể sử dụng WebGL hoặc Three.js nên album 3D đã tắt.';heading.textContent=c.title;date.textContent=c.date?fmt(c.date):'';description.textContent=c.description;grid.className='grid';for(const photo of c.photos){const figure=document.createElement('figure'),image=document.createElement('img'),caption=document.createElement('figcaption');image.src=photo.url;image.alt='';caption.textContent=photo.caption||'';figure.append(image,caption);grid.append(figure)}o.append(note,heading,date,description,grid);if(i===D.chapters.length-1){const end=document.createElement('p'),signature=document.createElement('em');end.className='end';end.append(document.createTextNode(D.closingMessage+' '),signature);signature.textContent=D.signature;o.append(end)}syncUI()}
/* ---------- editor ---------- */
function editor(){const E=$('#editor');
$$('[data-k]').forEach(i=>{i.value=D[i.dataset.k]||'';i.oninput=()=>{D[i.dataset.k]=i.value;soon()}});
const chs=()=>{$('#chs').innerHTML=D.chapters.map((c,i)=>`<fieldset><input data-i="${i}" data-f="title" value="${c.title}"><input type="date" data-i="${i}" data-f="date" value="${c.date||''}"><textarea data-i="${i}" data-f="description" rows="2">${c.description}</textarea></fieldset>`).join('');$$('#chs [data-f]').forEach(e=>e.oninput=()=>{D.chapters[e.dataset.i][e.dataset.f]=e.value;soon()})};
const phs=()=>{const a=flat();$('#cnt').textContent=a.length+'/12';$('#phs').innerHTML=a.map((p,i)=>`<div class="ph" draggable="true" data-i="${i}"><img src="${p.url}" alt=""><input value="${(p.caption||'').replace(/"/g,'&quot;')}" data-a="cap"><select data-a="ch">${D.chapters.map((c,k)=>`<option value="${k}"${k===p.ch?' selected':''}>${k+1}</option>`).join('')}</select><button data-a="cov" title="Ảnh bìa"${D.coverImage===p.url?' class="on"':''}>★</button><button data-a="del" title="Xóa">×</button></div>`).join('');
$$('#phs .ph').forEach(r=>{const i=+r.dataset.i;r.ondragstart=e=>e.dataTransfer.setData('t',i);r.ondragover=e=>e.preventDefault();r.ondrop=e=>{e.preventDefault();const f=+e.dataTransfer.getData('t'),b=flat(),[m]=b.splice(f,1);b.splice(i,0,m);setFlat(b);phs();soon()};
r.querySelector('[data-a=cap]').oninput=e=>{a[i].caption=e.target.value;soon()};r.querySelector('[data-a=ch]').onchange=e=>{a[i].ch=+e.target.value;setFlat(a);phs();soon()};r.querySelector('[data-a=cov]').onclick=()=>{D.coverImage=a[i].url;D.coverImageAssetId=a[i].asset_id||'';phs();soon()};r.querySelector('[data-a=del]').onclick=()=>{a.splice(i,1);setFlat(a);phs();soon()}})};
$('#up').onchange=e=>{[...e.target.files].slice(0,12-flat().length).forEach(f=>{const u=URL.createObjectURL(f),im=new Image();im.onload=()=>{const s=Math.min(1,900/Math.max(im.width,im.height)),c=mk(im.width*s,im.height*s);c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);D.chapters[1].photos.push({url:c.toDataURL('image/jpeg',.82),caption:''});phs();soon()};im.src=u});e.target.value=''};
$('#themes').innerHTML=Object.entries(TH).map(([k,v])=>`<button data-t="${k}" style="--c:${v.cover}">${v.n}</button>`).join('');$$('#themes button').forEach(b=>b.onclick=()=>{D.theme=b.dataset.t;apply()});
$('#anim').value=D.animation;$('#anim').onchange=e=>{D.animation=e.target.value;apply()};
$('#exp').onclick=()=>{const j=JSON.stringify(D,(k,v)=>k==='ch'?undefined:v,2),a=document.createElement('a');a.href=URL.createObjectURL(new Blob([j],{type:'application/json'}));a.download='our-memories.json';a.click()};
$('#asRecipient').onclick=()=>document.body.classList.add('recipient');$('#backEdit').onclick=()=>document.body.classList.remove('recipient');
$$('#tabs button').forEach(b=>b.onclick=()=>document.body.classList.toggle('pv',b.dataset.v==='pv'));chs();phs()}
/* ---------- boot ---------- */
function ui(){$('#openBtn').onclick=openAlbum;$('#next').onclick=()=>step(1);$('#prev').onclick=()=>step(-1);$('#replay').onclick=()=>{S.spread=1;syncUI()};$('#reset').onclick=()=>{closeLb();reset()};
$('#rot').onclick=e=>{auto=!auto;e.target.classList.toggle('off',!auto)};$('#prt').onclick=e=>{if(gl)G.part.visible=!G.part.visible;e.target.classList.toggle('off',!G.part.visible)};
$('#snd').onclick=e=>{snd=!snd;e.target.textContent=snd?'Tắt âm thanh':'Bật âm thanh';if(D.music){music=music||new Audio(D.music);music.loop=true;snd?music.play().catch(()=>{}):music.pause()}};
$('#lbX').onclick=closeLb;$('#lbN').onclick=()=>showPhoto(S.lb+1);$('#lbP').onclick=()=>showPhoto(S.lb-1);
addEventListener('keydown',e=>{if(e.key==='Escape')closeLb();if(e.key==='ArrowRight')S.lb>=0?showPhoto(S.lb+1):step(1);if(e.key==='ArrowLeft')S.lb>=0?showPhoto(S.lb-1):step(-1)});
if(viewOnly){document.body.classList.add('recipient','locked')}else editor();
document.fonts&&document.fonts.ready.then(soon)}
function start(){try{R=window.THREE;ray=new R.Raycaster();renderer=new R.WebGLRenderer({canvas:$('#c'),antialias:!mobile,alpha:true,powerPreference:'high-performance'});renderer.outputEncoding=R.sRGBEncoding;gl=true;initScene();bindInput(renderer.domElement);new ResizeObserver(resize).observe($('#stage'));resize();requestAnimationFrame(loop)}catch(e){console.warn('WebGL unavailable',e);gl=false;fallback()}ui();apply()}
function fallback(){$('#c').hidden=true;document.body.classList.add('twod')}
function load(u,ok,no){const s=u.shift();if(!s)return no();const e=document.createElement('script');e.src=s;e.onload=ok;e.onerror=()=>load(u,ok,no);document.head.appendChild(e)}
if(window.THREE)start();else load(['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js','https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js','vendor/three.min.js'],start,()=>{fallback();ui();apply()});
window.registerCrushifyCustomerEditor({
templateId:'our-memories',schemaVersion:1,
async serialize(upload){const cover=D.coverImageAssetId||(ASSET_ID.test(D.coverImage)?D.coverImage:D.coverImage?await upload(D.coverImage):'');if(cover)D.coverImageAssetId=cover;
const chapters=[];for(const chapter of D.chapters){const photos=[];for(const photo of chapter.photos){const asset_id=photo.asset_id||(ASSET_ID.test(photo.url)?photo.url:await upload(photo.url));photo.asset_id=asset_id;photos.push({asset_id,caption:photo.caption||''})}chapters.push({id:chapter.id,title:chapter.title,date:chapter.date||'',description:chapter.description||'',photos})}
return{templateId:'our-memories',sender:D.sender,receiver:D.receiver,nickname:D.nickname,albumTitle:D.albumTitle,subtitle:D.subtitle,anniversary:D.anniversary||'',theme:D.theme,animation:D.animation,coverImage:cover,introduction:D.introduction,story:D.story,chapters,closingMessage:D.closingMessage,signature:D.signature,music:D.music||''}},
async hydrate(data,assetUrl){D=structuredClone(data);const coverId=D.coverImage;D.coverImageAssetId=coverId||'';D.coverImage=coverId?await assetUrl(coverId):'';
for(const chapter of D.chapters)for(const photo of chapter.photos){photo.url=await assetUrl(photo.asset_id);photo.asset_id=photo.asset_id}
editor();apply()
}});
})();
