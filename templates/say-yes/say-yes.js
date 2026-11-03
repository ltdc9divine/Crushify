(()=>{'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],clamp=(v,a,b)=>Math.min(b,Math.max(a,v)),rnd=(a,b)=>a+Math.random()*(b-a),ease=t=>t*t*(3-2*t);
const mk=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c};
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const hx=n=>'#'+n.toString(16).padStart(6,'0');
const mobile=matchMedia('(max-width:800px)').matches||/Mobi|Android/i.test(navigator.userAgent),reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
const TH={
'rose-proposal':{n:'Lời tỏ tình sắc hồng',A:0xff2f7d,B:0xff9ac8,C:0xb06bff,box:0x7a0f2e,plat:0x6b1a45,neon:0xff4fa0,gem:0xffd0e8,pal:[0xff5fa2,0xff9ac8,0xffd0e8,0xb06bff],petal:0xff4d88,bg:['#3a0a24','#10020a'],ac:'#ff5fa2'},
'midnight-romance':{n:'Tình yêu đêm',A:0x4b6bff,B:0x9fb4ff,C:0x9d6bff,box:0x14194a,plat:0x1e2660,neon:0x6f8cff,gem:0xcfe0ff,pal:[0x8fa6ff,0xc9d3ff,0xffffff,0xb78cff],petal:0x7f9bff,bg:['#101650','#03040f'],ac:'#8fa6ff'},
'lavender-dream':{n:'Giấc mơ oải hương',A:0xa86bff,B:0xe2c3ff,C:0xff7fd1,box:0x4b2f86,plat:0x4b2f86,neon:0xc59bff,gem:0xf2e0ff,pal:[0xc59bff,0xe2c3ff,0xff9ad8,0xffffff],petal:0xd9a8ff,bg:['#3a1a6a','#0e0420'],ac:'#c59bff'},
'golden-promise':{n:'Lời hẹn sắc vàng',A:0xffa920,B:0xffe0a0,C:0xff6f91,box:0x5a1020,plat:0x5a3d22,neon:0xffc060,gem:0xfff2c0,pal:[0xffc060,0xffe0a0,0xfff2c0,0xff8fa0],petal:0xffb347,bg:['#3a2312','#0f0804'],ac:'#ffc060'}};
const AN={cinematic:{rot:.08,pm:1,fw:1,spd:1},magical:{rot:.12,pm:1.8,fw:1.7,spd:1.1},dreamy:{rot:.04,pm:1.2,fw:.7,spd:.7},minimal:{rot:0,pm:.3,fw:.4,spd:1}};
const sky=(a,b,c)=>{const k=mk(480,600),x=k.getContext('2d'),g=x.createLinearGradient(0,0,0,600);g.addColorStop(0,a);g.addColorStop(.6,b);g.addColorStop(1,c);x.fillStyle=g;x.fillRect(0,0,480,600);x.fillStyle='rgba(255,235,210,.9)';x.beginPath();x.arc(240,340,46,0,7);x.fill();return k.toDataURL('image/jpeg',.7)};
const defaults=()=>({templateId:'say-yes',sender:'Minh',receiver:'Linh',nickname:'Bé yêu',question:'Em sẽ đồng ý bên anh chứ?',subtitle:'Anh có điều này muốn hỏi em…',yesLabel:'EM ĐỒNG Ý ♡',noLabel:'EM XIN TỪ CHỐI',yesHeadline:'EM ĐÃ KHIẾN VŨ TRỤ CỦA ANH TRỌN VẸN.',yesMessage:'Cảm ơn em đã đồng ý. Mỗi ngày bên em đều là ngày tuyệt vời nhất.',letter:'Từ lần đầu gặp em, anh đã biết em thật đặc biệt.\nEm khiến những ngày bình thường trở nên kỳ diệu, và anh muốn cùng em viết thêm thật nhiều kỷ niệm.',signature:'Minh',specialDate:'2026-02-14',noMessage:'Cảm ơn em đã thành thật. Dù câu trả lời thế nào, anh vẫn mong em luôn hạnh phúc.',noBackLabel:'Quay lại',showNoMessage:true,theme:'rose-proposal',animation:'cinematic',particles:true,autoRotate:true,music:'',photos:[{url:sky('#ffb38a','#c2507a','#2b1055'),caption:'Ngày mình gặp nhau'},{url:sky('#7fd1ff','#8a6fd6','#1b1040'),caption:'Hoàng hôn đôi mình'}]});
const viewOnly=!!window.SAYYES_DATA||/mode=view/.test(location.search);
let D=window.SAYYES_DATA||defaults();
if(!viewOnly&&!window.SAYYES_DATA){try{const d=JSON.parse(localStorage.getItem('sayyes-draft'));if(d)D=Object.assign(defaults(),d)}catch(e){}}
const th=()=>TH[D.theme]||TH['rose-proposal'],an=()=>AN[D.animation]||AN.cinematic;
const fmt=d=>d?new Date(d).toLocaleDateString('vi-VN',{day:'numeric',month:'long',year:'numeric'}):'';
/* ---------- state ---------- */
let gl=false,R,scene,camera,renderer,ray,pm,envRT,snd=false,AC,music,auto=true,partOn=true,lidOpen=true;
const S={ph:'intro',T:0,box:0,lid:0,kick:0,fw:0,cel:0,pa:0,pc:0,ph2:0},G={},cam={th:0,ph:1.28,r:22,tx:0,ty:1.3,tz:0},g={...cam};
const defR=()=>11*(innerWidth/innerHeight<.8?1.9:1);
const reset=()=>Object.assign(g,{th:0,ph:1.28,r:defR(),tx:0,ty:innerWidth/innerHeight<.8?.6:1.3,tz:0});
/* ---------- sound (WebAudio, no external audio) ---------- */
function tone(f,t0=0,d=.6,v=.07){if(!snd)return;try{AC=AC||new(window.AudioContext||window.webkitAudioContext)();const a=AC,o=a.createOscillator(),n=a.createGain(),t=a.currentTime+t0;o.frequency.value=f;n.gain.setValueAtTime(0,t);n.gain.linearRampToValueAtTime(v,t+.02);n.gain.exponentialRampToValueAtTime(.001,t+d);o.connect(n);n.connect(a.destination);o.start(t);o.stop(t+d+.05)}catch(e){}}
const chime=()=>[523,659,784,1047,1319].forEach((f,i)=>tone(f,i*.12,1.3));
function boom(){if(!snd)return;try{AC=AC||new(window.AudioContext||window.webkitAudioContext)();const a=AC,n=a.sampleRate*.5,b=a.createBuffer(1,n,a.sampleRate),d=b.getChannelData(0);for(let i=0;i<n;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/n,3);const s=a.createBufferSource(),f=a.createBiquadFilter(),v=a.createGain();s.buffer=b;f.type='lowpass';f.frequency.value=500;v.gain.value=.15;s.connect(f);f.connect(v);v.connect(a.destination);s.start()}catch(e){}}
/* ---------- particle pool (one draw call each) ---------- */
function pool(n,tx){const ge=new R.BufferGeometry(),P=new Float32Array(n*3),C=new Float32Array(n*4),Z=new Float32Array(n),V=new Float32Array(n*3),L=new Float32Array(n),M=new Float32Array(n),S0=new Float32Array(n),Gr=new Float32Array(n);
ge.setAttribute('position',new R.BufferAttribute(P,3));ge.setAttribute('aC',new R.BufferAttribute(C,4));ge.setAttribute('aS',new R.BufferAttribute(Z,1));
const mat=new R.ShaderMaterial({uniforms:{map:{value:tx},uK:{value:400}},vertexShader:'attribute float aS;attribute vec4 aC;uniform float uK;varying vec4 vC;void main(){vC=aC;vec4 m=modelViewMatrix*vec4(position,1.);gl_PointSize=aS*uK/-m.z;gl_Position=projectionMatrix*m;}',fragmentShader:'uniform sampler2D map;varying vec4 vC;void main(){float a=texture2D(map,gl_PointCoord).a;gl_FragColor=vec4(vC.rgb,vC.a*a);}',transparent:true,depthWrite:false,blending:R.AdditiveBlending});
const pt=new R.Points(ge,mat);pt.frustumCulled=false;let k=0;
return{pt,mat,emit(x,y,z,vx,vy,vz,life,size,c,gr=0){const i=k,j=i*3;k=(k+1)%n;P[j]=x;P[j+1]=y;P[j+2]=z;V[j]=vx;V[j+1]=vy;V[j+2]=vz;L[i]=M[i]=life;S0[i]=size;Gr[i]=gr;C[i*4]=c.r;C[i*4+1]=c.g;C[i*4+2]=c.b;C[i*4+3]=1;Z[i]=size},
clear(){L.fill(0);Z.fill(0);ge.attributes.aS.needsUpdate=true},
update(dt){for(let i=0;i<n;i++){if(L[i]<=0)continue;L[i]-=dt;if(L[i]<=0){Z[i]=0;continue}const f=L[i]/M[i],j=i*3;V[j+1]+=Gr[i]*dt;P[j]+=V[j]*dt;P[j+1]+=V[j+1]*dt;P[j+2]+=V[j+2]*dt;V[j]*=.992;V[j+2]*=.992;C[i*4+3]=Math.min(1,f*2.5);Z[i]=S0[i]*(.35+.65*f)}
ge.attributes.position.needsUpdate=ge.attributes.aC.needsUpdate=ge.attributes.aS.needsUpdate=true}}}
const spr=h=>{const c=mk(64,64),x=c.getContext('2d');if(h){x.fillStyle='#fff';x.shadowColor='#fff';x.shadowBlur=6;x.font='52px serif';x.textAlign='center';x.fillText('♥',32,50)}else{const q=x.createRadialGradient(32,32,0,32,32,32);q.addColorStop(0,'rgba(255,255,255,1)');q.addColorStop(.25,'rgba(255,255,255,.55)');q.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=q;x.fillRect(0,0,64,64)}return new R.CanvasTexture(c)};
/* ---------- crystal heart ---------- */
const HV='varying vec3 vN,vV;void main(){vN=normalize(normalMatrix*normal);vec4 m=modelViewMatrix*vec4(position,1.);vV=-m.xyz;gl_Position=projectionMatrix*m;}';
const HF='uniform vec3 uA,uB,uC;uniform float uT,uP;varying vec3 vN,vV;void main(){vec3 n=normalize(vN),v=normalize(vV);float d=abs(dot(n,v)),f=pow(1.-d,2.);vec3 ir=.5+.5*cos(6.2831*(vec3(n.x*.8+n.y*.5,n.y*.7+n.z*.6,n.z*.9+n.x*.4)+uT*.05+vec3(0.,.33,.67)));vec3 c=mix(uA,uB,f)*(.55+.7*uP)+ir*uC*.55*f+uB*.6*pow(d,6.)*uP;gl_FragColor=vec4(c,.4+.5*f+.15*uP);}';
function mkHeart(){const s=new R.Shape();s.moveTo(0,-1.2);s.bezierCurveTo(-.2,-.9,-1.4,-.2,-1.4,.5);s.bezierCurveTo(-1.4,1.3,-.4,1.6,0,.9);s.bezierCurveTo(.4,1.6,1.4,1.3,1.4,.5);s.bezierCurveTo(1.4,-.2,.2,-.9,0,-1.2);
let ge=new R.ExtrudeGeometry(s,{depth:.5,bevelEnabled:true,bevelThickness:.28,bevelSize:.24,bevelSegments:3,curveSegments:12});ge.center();ge.computeVertexNormals();
G.hu={uA:{value:new R.Color()},uB:{value:new R.Color()},uC:{value:new R.Color()},uT:{value:0},uP:{value:.4}};
const m=new R.Mesh(ge,new R.ShaderMaterial({uniforms:G.hu,vertexShader:HV,fragmentShader:HF,transparent:true,depthWrite:false,side:R.DoubleSide}));m.renderOrder=2;
G.core=new R.Mesh(ge,new R.MeshBasicMaterial({color:0xff4fa0,transparent:true,opacity:.55,blending:R.AdditiveBlending,depthWrite:false}));G.core.scale.setScalar(.62);
const grp=new R.Group();grp.add(G.core,m);grp.position.y=3.4;grp.scale.setScalar(.001);m.userData.heart=1;G.hm=m;G.heart=grp;scene.add(grp)}
/* ---------- ring box ---------- */
function mkBox(){const b=new R.Group(),vel=new R.MeshStandardMaterial({color:0x7a0f2e,roughness:.95,metalness:0}),gold=new R.MeshStandardMaterial({color:0xf5d27a,metalness:1,roughness:.16});G.vel=vel;
const base=new R.Mesh(new R.BoxGeometry(1,.5,1),vel);base.position.y=.25;const cu=new R.Mesh(new R.BoxGeometry(.86,.1,.86),new R.MeshStandardMaterial({color:0xffe9ef,roughness:1}));cu.position.y=.5;b.add(base,cu);
const trim=new R.Mesh(new R.BoxGeometry(1.03,.04,1.03),gold);trim.position.y=.5;b.add(trim);
const lidP=new R.Group();lidP.position.set(0,.5,-.5);const lid=new R.Mesh(new R.BoxGeometry(1,.25,1),vel);lid.position.set(0,.125,.5);const lt=new R.Mesh(new R.BoxGeometry(1.03,.04,1.03),gold);lt.position.set(0,.02,.5);lidP.add(lid,lt);b.add(lidP);G.lidP=lidP;
const ring=new R.Mesh(new R.TorusGeometry(.26,.05,16,40),gold);ring.position.y=.82;b.add(ring);
G.gemM=new R.MeshStandardMaterial({color:0xffffff,emissive:0xffd0e8,emissiveIntensity:1,metalness:.2,roughness:.05,flatShading:true});const gem=new R.Mesh(new R.OctahedronGeometry(.12),G.gemM);gem.position.y=1.12;gem.scale.y=1.3;b.add(gem);G.gem=gem;
G.gl=new R.Sprite(new R.SpriteMaterial({map:spr(),color:0xffd0e8,blending:R.AdditiveBlending,transparent:true,depthWrite:false,opacity:0}));G.gl.scale.set(1.6,1.6,1);G.gl.position.y=1.12;b.add(G.gl);
b.traverse(o=>o.userData.box=1);b.position.set(0,-1.4,1.9);b.scale.setScalar(1.25);G.box=b;scene.add(b)}
/* ---------- scene ---------- */
function setEnv(){const T=th(),c=mk(256,128),x=c.getContext('2d'),q=x.createLinearGradient(0,0,0,128);q.addColorStop(0,'#05020a');q.addColorStop(.45,hx(T.A));q.addColorStop(.6,hx(T.C));q.addColorStop(1,'#05020a');x.fillStyle=q;x.fillRect(0,0,256,128);x.fillStyle='#fff';[[30,50,18,8],[110,40,26,6],[190,60,16,10],[240,45,12,6]].forEach(a=>x.fillRect(...a));
const t=new R.CanvasTexture(c);t.mapping=R.EquirectangularReflectionMapping;t.encoding=R.sRGBEncoding;pm=pm||new R.PMREMGenerator(renderer);const rt=pm.fromEquirectangular(t);envRT&&envRT.dispose();envRT=rt;scene.environment=rt.texture;t.dispose()}
function initScene(){scene=new R.Scene();scene.fog=new R.FogExp2(0x10020a,.01);camera=new R.PerspectiveCamera(45,1,.1,400);
G.key=new R.DirectionalLight(0xffffff,.5);G.key.position.set(4,8,6);G.hL=new R.PointLight(0xff4fa0,2.4,18);G.hL.position.set(0,3.4,0);G.rL=new R.PointLight(0xffd0e8,0,7);G.rL.position.set(0,1.6,2.4);scene.add(new R.HemisphereLight(0xffffff,0x200010,.3),G.key,G.hL,G.rL);
const gt=spr(),ht=spr(1);
const sp=new Float32Array((mobile?700:1400)*3);for(let i=0;i<sp.length;i+=3){const v=new R.Vector3(rnd(-1,1),rnd(-1,1),rnd(-1,1)).normalize().multiplyScalar(rnd(90,160));sp[i]=v.x;sp[i+1]=v.y;sp[i+2]=v.z}
const sg=new R.BufferGeometry();sg.setAttribute('position',new R.BufferAttribute(sp,3));G.stars=new R.Points(sg,new R.PointsMaterial({size:1.8,sizeAttenuation:false,transparent:true,opacity:.8,fog:false,depthWrite:false}));scene.add(G.stars);
G.neb=[[-22,10,-60],[26,0,-70],[0,22,-80]].map(p=>{const s=new R.Sprite(new R.SpriteMaterial({map:gt,blending:R.AdditiveBlending,transparent:true,opacity:.28,depthWrite:false,fog:false}));s.position.set(...p);s.scale.setScalar(90);scene.add(s);return s});
G.plm=new R.MeshStandardMaterial({color:0x6b1a45,metalness:.9,roughness:.25});G.neon=new R.MeshBasicMaterial({color:0xff4fa0,blending:R.AdditiveBlending,transparent:true,opacity:.95});
[[4.2,4.5,.3,-.15],[5.4,5.7,.25,-.4],[6.6,6.9,.2,-.6]].forEach(([a,b,h,y])=>{const m=new R.Mesh(new R.CylinderGeometry(a,b,h,mobile?40:80),G.plm);m.position.y=y;scene.add(m)});
[[4.25,0],[5.45,-.27],[6.65,-.5]].forEach(([r,y])=>{const m=new R.Mesh(new R.TorusGeometry(r,.03,8,100),G.neon);m.rotation.x=Math.PI/2;m.position.y=y;scene.add(m)});
G.orb=[[2.8,.5,.3],[3.4,-.4,-.2],[4.1,.15,.5]].map(([r,a,b])=>{const m=new R.Mesh(new R.TorusGeometry(r,.012,6,128),G.neon);m.position.y=3.4;m.rotation.set(a,0,b);scene.add(m);return m});
G.er=[0,1,2].map(()=>{const m=new R.Mesh(new R.TorusGeometry(1,.05,8,96),new R.MeshBasicMaterial({color:0xff9ac8,transparent:true,opacity:0,blending:R.AdditiveBlending,depthWrite:false}));m.rotation.x=Math.PI/2;m.position.y=1;m.visible=false;m.t=-1;scene.add(m);return m});
mkHeart();mkBox();
G.P=pool(mobile?2500:6000,gt);G.H=pool(mobile?1000:2500,ht);scene.add(G.P.pt,G.H.pt);
const pg=new R.CircleGeometry(.13,8);pg.scale(1,1.5,1);G.NP=mobile?70:160;G.petals=new R.InstancedMesh(pg,new R.MeshStandardMaterial({color:0xff4d88,side:R.DoubleSide,roughness:.6,emissive:0x301020}),G.NP);G.petals.frustumCulled=false;
G.pd=Array.from({length:G.NP},()=>({x:rnd(-9,9),y:rnd(-1,9),z:rnd(-8,6),s:rnd(.4,1),p:rnd(0,6),r:rnd(0,6)}));scene.add(G.petals);G.dm=new R.Object3D();setEnv()}
/* ---------- theme / texts ---------- */
const col=n=>new R.Color(n);
function apply(){const T=th(),a=an(),b=document.body;b.style.setProperty('--b1',T.bg[0]);b.style.setProperty('--b2',T.bg[1]);b.style.setProperty('--ac',T.ac);
$('#qSub').textContent=(D.receiver?D.receiver+', ':'')+D.subtitle;$('#qMain').textContent=D.question;$('#yesB').textContent=D.yesLabel;$('#noB').textContent=D.noLabel;
$('#yesH').textContent=D.yesHeadline;$('#yesM').textContent=D.yesMessage;$('#yesL').textContent=D.letter;$('#yesS').textContent=D.signature;$('#yesN').textContent=`${D.sender} ♥ ${D.receiver}`+(D.specialDate?' · '+fmt(D.specialDate):'');
$('#yesPh').innerHTML=D.photos.slice(0,6).map(p=>`<figure><img src="${esc(p.url)}" alt=""><figcaption>${esc(p.caption)}</figcaption></figure>`).join('');
$('#noM').textContent=D.showNoMessage?D.noMessage:'';$('#noBack').textContent=D.noBackLabel||'Quay lại';partOn=D.particles!==false;auto=D.autoRotate!==false;
if(!gl)return;G.hu.uA.value.set(T.A);G.hu.uB.value.set(T.B);G.hu.uC.value.set(T.C);G.core.material.color.set(T.A);G.hL.color.set(T.A);G.rL.color.set(T.gem);G.vel.color.set(T.box);G.plm.color.set(T.plat);G.neon.color.set(T.neon);G.gemM.emissive.set(T.gem);G.gl.material.color.set(T.gem);G.petals.material.color.set(T.petal);
G.neb.forEach((s,i)=>s.material.color.set([T.A,T.C,T.B][i]));scene.fog.color.set(T.bg[1]);G.pal=T.pal.map(col);if(G.envT!==D.theme){G.envT=D.theme;setEnv()}}
/* ---------- flow ---------- */
const show=(id,on)=>$(id).classList.toggle('on',on);
function setPhase(p){S.ph=p;document.body.dataset.ph=p}
function yes(){if(S.ph==='yes')return;setPhase('yes');S.cel=0;S.kick=1.2;chime();if(!gl){return}const pal=G.pal,n=mobile?350:800;for(let i=0;i<n;i++){const v=new R.Vector3(rnd(-1,1),rnd(-1,1),rnd(-1,1)).normalize().multiplyScalar(rnd(1.5,7)),c=pal[i%pal.length];G.H.emit(0,3.4,0,v.x,v.y+1,v.z,rnd(3,5.5),rnd(.3,.65),c,-.2)}
G.er.forEach((r,i)=>{r.t=-i*.4;r.visible=true;r.position.y=1.5+i*.4});G.fw=0;g.r=Math.min(9,defR()*.75);g.tx=0;g.ty=2.4;g.tz=0;G.gl.material.opacity=1}
function no(){if(S.ph==='no')return;setPhase('no');tone(392,0,1.4,.05);tone(523,.2,1.6,.04)}
function back(){setPhase('intro');S.ph2=1}
function closeAll(){setPhase('closed')}
function replay(){setPhase('intro');S.T=0;S.box=S.lid=0;S.ph2=0;G.P&&G.P.clear();G.H&&G.H.clear();document.body.classList.remove('fade','ask');if(!gl)document.body.classList.add('ask');void document.body.offsetWidth;document.body.classList.add('fade');if(gl){G.er.forEach(r=>{r.visible=false;r.t=-1});cam.r=22;reset()}else S.T=7}
function pick(e){const r=renderer.domElement.getBoundingClientRect();ray.setFromCamera({x:(e.clientX-r.left)/r.width*2-1,y:-((e.clientY-r.top)/r.height*2-1)},camera);const h=ray.intersectObjects([G.hm,G.box],true)[0];if(!h)return;
if(h.object.userData.heart){focus('heart');S.kick=.8;for(let i=0;i<40;i++)G.P.emit(rnd(-1.4,1.4),3.4+rnd(-1.2,1.4),rnd(-.5,.5),rnd(-1,1),rnd(0,2),rnd(-1,1),1.4,.2,G.pal[i%G.pal.length],-.5);tone(1200,0,.4)}
else if(h.object.userData.box){focus('box');lidOpen=!lidOpen;tone(lidOpen?660:440,0,.4)}}
function focus(w){if(w==='heart'){g.tx=0;g.ty=3.4;g.tz=0;g.r=7}else{g.tx=0;g.ty=1;g.tz=1.9;g.r=4.6}}
/* ---------- camera input ---------- */
const mouse={x:0,y:0},pts2=new Map();let moved=0,idle=0,pd=0;
function bindInput(c){c.addEventListener('pointerdown',e=>{c.setPointerCapture(e.pointerId);pts2.set(e.pointerId,[e.clientX,e.clientY]);moved=0;idle=0;pd=0});
c.addEventListener('pointermove',e=>{const r=c.getBoundingClientRect();mouse.x=(e.clientX-r.left)/r.width*2-1;mouse.y=-((e.clientY-r.top)/r.height*2-1);const o=pts2.get(e.pointerId);if(!o)return;const dx=e.clientX-o[0],dy=e.clientY-o[1];pts2.set(e.pointerId,[e.clientX,e.clientY]);moved+=Math.abs(dx)+Math.abs(dy);idle=0;
if(pts2.size===2){const[a,b]=[...pts2.values()],d=Math.hypot(a[0]-b[0],a[1]-b[1]);if(pd)g.r=clamp(g.r*pd/d,4,20);pd=d}else{g.th-=dx*.006;g.ph=clamp(g.ph-dy*.006,.4,1.55)}});
c.addEventListener('pointerup',e=>{if(pts2.size===1&&moved<8)pick(e);pts2.delete(e.pointerId);pd=0});c.addEventListener('pointercancel',e=>pts2.delete(e.pointerId));
c.addEventListener('wheel',e=>{e.preventDefault();g.r=clamp(g.r*(1+e.deltaY*.001),4,20);idle=0},{passive:false})}
/* ---------- loop ---------- */
let last=performance.now(),ac=0,rc=0,fwT=0;
const pc=()=>G.pal[(Math.random()*G.pal.length)|0];
function loop(now){requestAnimationFrame(loop);const dt=Math.min(.05,(now-last)/1000);last=now;if(document.hidden)return;const a=an(),mo=!reduce,T=S.T+=dt*a.spd;const yes_=S.ph==='yes';
// intro timeline
const hs=ease(clamp((T-.5)/2.5,0,1));S.kick*=Math.exp(-dt*1.6);G.heart.scale.setScalar(Math.max(.001,hs*(1+.04*Math.sin(T*2.4)+S.kick*.25)));G.heart.rotation.y=Math.sin(T*.5)*.6+(yes_?T*.5:0);G.heart.rotation.z=Math.sin(T*.7)*.05;
G.hu.uT.value=T;G.hu.uP.value=.35+.2*Math.sin(T*2.4)+S.kick+(yes_?.5:0);G.core.material.opacity=.45+.2*Math.sin(T*2.4)+S.kick*.4;G.hL.intensity=(1.2+.6*Math.sin(T*2.4))*hs+S.kick*4;
if(T<4)g.r=22+(defR()-22)*ease(T/4);
S.box+=((T>3?1:0)-S.box)*Math.min(1,dt*.9);S.lid+=((T>4.5&&lidOpen?1:0)-S.lid)*Math.min(1,dt*1.3);G.box.position.y=-1.4+1.7*ease(clamp(S.box,0,1));G.box.rotation.y=Math.sin(T*.4)*.12;G.lidP.rotation.x=-1.95*ease(clamp(S.lid,0,1));
const gl2=S.lid*(.7+.3*Math.sin(T*3))+(yes_?.6:0);G.gl.material.opacity=clamp(gl2,0,1);G.gemM.emissiveIntensity=.6+gl2*1.4;G.gem.rotation.y=T*1.2;G.rL.intensity=gl2*1.8;
if(S.ph==='intro'&&T>6.8&&!document.body.classList.contains('ask'))document.body.classList.add('ask');
// camera
if(auto&&mo&&idle>3&&!pts2.size&&S.ph!=='closed')g.th+=dt*(yes_?a.rot*1.5:a.rot);const k=1-Math.exp(-dt*(T<4?2:5));for(const p in cam)cam[p]+=(g[p]-cam[p])*k;
const sn=Math.sin(cam.ph);camera.position.set(cam.tx+cam.r*sn*Math.sin(cam.th)+(mo?mouse.x*.5:0),cam.ty+cam.r*Math.cos(cam.ph)+(mo?mouse.y*.3:0),cam.tz+cam.r*sn*Math.cos(cam.th));camera.lookAt(cam.tx,cam.ty,cam.tz);
// rings / orbits
G.orb.forEach((o,i)=>{o.rotation.y=T*(.3+i*.15)*(i%2?-1:1);o.material.opacity=1;o.scale.setScalar(hs)});G.neb.forEach((s,i)=>s.material.opacity=.22+.06*Math.sin(T*.3+i));G.stars.rotation.y+=dt*.004;
G.er.forEach(r=>{if(!r.visible)return;r.t+=dt;if(r.t<0)return;const s=1+r.t*9;r.scale.setScalar(s);r.material.opacity=Math.max(0,1-r.t/1.8);if(r.t>1.8)r.visible=false});
// emitters
const pm2=partOn?a.pm:0,pal=G.pal;
if(partOn||yes_){ac+=dt*(mobile?25:60)*Math.max(pm2,yes_?1.5:0);while(ac>1){ac--;G.P.emit(rnd(-10,10),rnd(-1,8),rnd(-9,6),rnd(-.1,.1),rnd(.1,.4),rnd(-.1,.1),rnd(5,9),rnd(.06,.16),pal[3%pal.length],0)}
 rc+=dt*(yes_?14:2.5)*Math.max(pm2,.5);while(rc>1){rc--;const q=rnd(0,6.28),r=rnd(1,6);G.H.emit(Math.cos(q)*r,.2,Math.sin(q)*r,rnd(-.2,.2),rnd(.6,1.2),rnd(-.2,.2),rnd(5,7),rnd(.22,.4),pc(),0)}
 if(hs>.5){for(let i=0;i<(mobile?1:2)*pm2;i++){const v=new R.Vector3(rnd(-1,1),rnd(-1,1),rnd(-1,1)).normalize().multiplyScalar(rnd(1.7,2.5));G.P.emit(v.x,3.4+v.y,v.z*.5,v.x*.2,v.y*.2+.2,v.z*.2,1.6,rnd(.1,.2),pc(),0)}}}
if(T>4.5||yes_){const q=T*1.5,hx2=Math.cos(q)*2.9,hz=Math.sin(q)*2.9,hy=3.4+Math.sin(q*.7)*.8;for(let i=0;i<3;i++)G.P.emit(hx2+rnd(-.05,.05),hy,hz,rnd(-.2,.2),rnd(-.2,.2),rnd(-.2,.2),.9,.28,pal[1],0)}
if(hs>.8)for(let s=0;s<2;s++){const q=T*1.1+s*Math.PI;G.P.emit(Math.cos(q)*4.25,.05,Math.sin(q)*4.25,0,.2,0,.7,.2,pal[0],0)}
if(yes_){S.cel+=dt;fwT-=dt;if(fwT<=0&&(S.cel<12||Math.random()<.01)){fwT=.5/a.fw;const c=pc(),x=rnd(-9,9),y=rnd(3,9),z=rnd(-8,-1);G.P.emit(x,y,z,0,0,0,.3,1.6,c,0);const n=mobile?50:110;for(let i=0;i<n;i++){const v=new R.Vector3(rnd(-1,1),rnd(-1,1),rnd(-1,1)).normalize().multiplyScalar(rnd(2.5,5.5));G.P.emit(x,y,z,v.x,v.y,v.z,rnd(1.3,2),.2,c,-2.2)}boom()}}
G.P.update(dt);G.H.update(dt);
// petals
const cnt=Math.round(G.NP*(partOn||yes_?clamp(pm2,0,1)*(yes_?1:.55)*clamp((T-4)/3,0,1)+(yes_?.45:0):0));G.petals.count=Math.min(G.NP,cnt);const d=G.dm;
for(let i=0;i<G.petals.count;i++){const p=G.pd[i];p.y-=dt*(.35+p.s*.4)*(yes_?1.6:1);p.x+=Math.sin(T*p.s+p.p)*dt*.5;if(p.y<-1){p.y=9;p.x=rnd(-9,9)}d.position.set(p.x,p.y,p.z);d.rotation.set(T*p.s+p.r,T*.7*p.s+p.p,p.r);d.updateMatrix();G.petals.setMatrixAt(i,d.matrix)}G.petals.instanceMatrix.needsUpdate=true;
renderer.render(scene,camera)}
function resize(){const s=$('#stage'),w=s.clientWidth,h=s.clientHeight;if(!gl||!w)return;renderer.setPixelRatio(Math.min(devicePixelRatio,mobile?1.5:2));renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();const k=renderer.domElement.height/(2*Math.tan(camera.fov*Math.PI/360));G.P.mat.uniforms.uK.value=G.H.mat.uniforms.uK.value=k;if(S.ph!=='yes'&&!pts2.size)reset()}
/* ---------- editor ---------- */
function editor(){$$('[data-k]').forEach(i=>{const k=i.dataset.k;if(i.type==='checkbox'){i.checked=D[k]!==false;i.onchange=()=>{D[k]=i.checked;apply()}}else{i.value=D[k]==null?'':D[k];i.oninput=i.onchange=()=>{D[k]=i.value;apply()}}});
const phs=()=>{$('#cnt').textContent=D.photos.length+'/6';$('#phs').innerHTML=D.photos.map((p,i)=>`<div class="ph" draggable="true" data-i="${i}"><img src="${esc(p.url)}" alt=""><input value="${esc(p.caption)}"><button title="Xóa">×</button></div>`).join('');
$$('#phs .ph').forEach(r=>{const i=+r.dataset.i;r.ondragstart=e=>e.dataTransfer.setData('t',i);r.ondragover=e=>e.preventDefault();r.ondrop=e=>{e.preventDefault();const f=+e.dataTransfer.getData('t'),[m]=D.photos.splice(f,1);D.photos.splice(i,0,m);phs();apply()};r.querySelector('input').oninput=e=>{D.photos[i].caption=e.target.value;apply()};r.querySelector('button').onclick=()=>{D.photos.splice(i,1);phs();apply()}})};
$('#up').onchange=e=>{[...e.target.files].slice(0,6-D.photos.length).forEach(f=>{const u=URL.createObjectURL(f),im=new Image();im.onload=()=>{const s=Math.min(1,720/Math.max(im.width,im.height)),c=mk(im.width*s,im.height*s);c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);D.photos.push({url:c.toDataURL('image/jpeg',.75),caption:''});phs();apply()};im.src=u});e.target.value=''};
$('#themes').innerHTML=Object.entries(TH).map(([k,v])=>`<button data-t="${k}" style="--c:${hx(v.A)}">${v.n}</button>`).join('');$$('#themes button').forEach(b=>b.onclick=()=>{D.theme=b.dataset.t;apply()});
$('#anim').value=D.animation;$('#anim').onchange=e=>{D.animation=e.target.value;apply()};
$('#exp').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(D,null,2)],{type:'application/json'}));a.download='say-yes.json';a.click()};
$('#save').onclick=()=>{try{localStorage.setItem('sayyes-draft',JSON.stringify(D));$('#msg').textContent='Đã lưu bản nháp trên trình duyệt này.'}catch(e){$('#msg').textContent='Không lưu được (ảnh quá lớn). Hãy xóa bớt ảnh hoặc xuất JSON.'}};
$('#asRecipient').onclick=()=>{document.body.classList.add('recipient','pv');replay()};$('#backEdit').onclick=()=>document.body.classList.remove('recipient');
$$('#tabs button').forEach(b=>b.onclick=()=>{document.body.classList.toggle('pv',b.dataset.v==='pv');setTimeout(resize,50)});phs()}
function ui(){$('#yesB').onclick=yes;$('#noB').onclick=no;$('#noBack').onclick=back;$('#noClose').onclick=closeAll;$('#yesRe').onclick=()=>{S.cel=0;yes_replay()};$('#reset').onclick=reset;$('#hHeart').onclick=()=>focus('heart');$('#hBox').onclick=()=>focus('box');$('#replay').onclick=replay;
$('#rot').onclick=e=>{auto=!auto;e.target.classList.toggle('off',!auto)};$('#prt').onclick=e=>{partOn=!partOn;e.target.classList.toggle('off',!partOn)};
$('#snd').onclick=e=>{snd=!snd;e.target.textContent=snd?'Tắt âm thanh':'Bật âm thanh';if(D.music){music=music||new Audio(D.music);music.loop=true;snd?music.play().catch(()=>{}):music.pause()}};
if(viewOnly)document.body.classList.add('recipient','locked');else editor();document.body.classList.add('fade')}
function yes_replay(){S.ph='intro';yes()}
function start(){try{R=window.THREE;ray=new R.Raycaster();renderer=new R.WebGLRenderer({canvas:$('#c'),antialias:!mobile,alpha:true,powerPreference:'high-performance'});renderer.outputEncoding=R.sRGBEncoding;gl=true;initScene();bindInput(renderer.domElement);new ResizeObserver(resize).observe($('#stage'));ui();apply();resize();reset();if(reduce)S.T=7;requestAnimationFrame(loop)}catch(e){console.warn('WebGL unavailable',e);gl=false;fallback()}}
function fallback(){gl=false;$('#c').hidden=true;document.body.classList.add('twod','ask');ui();apply();$('#note').hidden=false}
function load(u,ok,no){const s=u.shift();if(!s)return no();const e=document.createElement('script');e.src=s;e.onload=ok;e.onerror=()=>load(u,ok,no);document.head.appendChild(e)}
if(window.THREE)start();else load(['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js','https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js','vendor/three.min.js'],start,fallback);
})();
