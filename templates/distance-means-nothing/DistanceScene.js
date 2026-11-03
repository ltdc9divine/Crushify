import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
const V3=(x,y,z)=>new THREE.Vector3(x,y,z),C=h=>new THREE.Color(h);
const MOBILE=matchMedia('(max-width:800px)').matches,RM=matchMedia('(prefers-reduced-motion:reduce)').matches;
const MODES={cinematic:{sp:1,bloom:.9,intro:1,pt:1},dreamy:{sp:.55,bloom:1.5,intro:1,pt:1},cosmic:{sp:1.8,bloom:1.1,intro:1,pt:1},minimal:{sp:.6,bloom:0,intro:0,pt:.35}};
const ease=t=>t*t*(3-2*t),clamp=(t)=>Math.min(1,Math.max(0,t));
const NOISE=`float h(vec3 p){p=fract(p*.3183099+.1);p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float n(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float a=.5,s=0.;for(int i=0;i<5;i++){s+=a*n(p);p*=2.03;a*=.5;}return s;}`;
const PLANET_V=`varying vec3 vN,vP;void main(){vN=normalize(mat3(modelMatrix)*normal);vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const PLANET_F=NOISE+`uniform vec3 uLo,uHi,uLight;uniform float uSeed,uT;varying vec3 vN,vP;
void main(){float e=fbm(vP*.9+uSeed);float land=smoothstep(.48,.56,e);
vec3 col=mix(uLo*.8,mix(uLo,uHi,smoothstep(.5,.8,e)),land);
float cl=smoothstep(.55,.8,fbm(vP*1.4+uSeed*2.+uT*.03));col=mix(col,vec3(1),cl*.45);
float d=dot(normalize(vN),normalize(uLight)),day=smoothstep(-.15,.35,d);
float city=step(.74,n(vP*14.+uSeed))*land*(1.-day)*(1.-cl);
gl_FragColor=vec4(col*(.1+.95*day)+uHi*city*2.4,1.);}`;
const ATMO_V=`varying vec3 vN;void main(){vN=normalize(normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const ATMO_F=`uniform vec3 uC;varying vec3 vN;void main(){gl_FragColor=vec4(uC,pow(1.-abs(vN.z),2.6)*.9);}`;
const RIB_V=`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const RIB_F=`uniform vec3 c1,c2;uniform float uT,uReveal,uA;varying vec2 vUv;
void main(){float p=smoothstep(.8,1.,sin((vUv.x*4.-uT*.5)*6.2832)*.5+.5);float vis=smoothstep(uReveal,uReveal-.05,vUv.x);
gl_FragColor=vec4(mix(c1,c2,vUv.x)*(1.+p*1.5),(.3+p*.7)*uA*vis);}`;
const PART_V=`attribute vec4 a;uniform vec3 P0,P1,P2;uniform float uT,uReveal,uSize,uPix;varying float vA,vK;
vec3 B(float t){float u=1.-t;return u*u*P0+2.*u*t*P1+t*t*P2;}
void main(){float t=fract(a.x+uT*a.y*.05);vec3 p=B(t),tg=normalize(B(min(t+.01,1.))-p+1e-5);
vec3 s=normalize(cross(tg,vec3(0,1,0))),u=cross(tg,s);float g=a.z+uT*.8*a.y,r=a.w*(.35+.65*sin(t*3.14159));
p+=(s*cos(g)+u*sin(g))*r;vK=t;vA=step(t,uReveal)*sin(t*3.14159);
vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=uSize*uPix/-mv.z;}`;
const PART_F=`uniform vec3 c1,c2;uniform float uHeart;varying float vA,vK;
void main(){vec2 q=gl_PointCoord-.5;float a=1.;
if(uHeart>.5){float x=q.x*2.6,y=-q.y*2.6-.1;a=step(pow(x*x+y*y-1.,3.)-x*x*y*y*y,0.);}else a=smoothstep(.5,.1,length(q));
gl_FragColor=vec4(mix(c1,c2,vK)*1.6,a*vA);if(gl_FragColor.a<.01)discard;}`;
function glow(){const c=document.createElement('canvas');c.width=c.height=64;const g=c.getContext('2d'),r=g.createRadialGradient(32,32,0,32,32,32);
 r.addColorStop(0,'#fff');r.addColorStop(.3,'rgba(255,255,255,.6)');r.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=r;g.fillRect(0,0,64,64);return new THREE.CanvasTexture(c)}
function emoji(e){const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d');g.font='88px serif';g.textAlign='center';g.textBaseline='middle';g.fillText(e||'💌',64,70);
 return new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),depthWrite:false}))}
function free(o){o.traverse(x=>{x.geometry?.dispose();const m=x.material;(Array.isArray(m)?m:[m]).forEach(k=>{k?.map?.dispose();k?.dispose()})})}
const PL=[[V3(-10,-1.5,-4),2.6,3.1,.4],[V3(10,1.5,5),2.1,7.7,-.3]];
export class DistanceScene{
 constructor(el,cb={}){
  this.el=el;this.cb=cb;this.t=0;this.items=[];this.tw=null;this.mode=MODES.cinematic;this.clock=new THREE.Clock();this.particlesOn=true;
  const r=this.r=new THREE.WebGLRenderer({antialias:!MOBILE,powerPreference:'high-performance'}); // throws without WebGL
  r.setPixelRatio(Math.min(devicePixelRatio,MOBILE?1.5:2));el.appendChild(r.domElement);
  const S=this.scene=new THREE.Scene(),cam=this.cam=new THREE.PerspectiveCamera(50,1,.1,500);
  this.ctl=new OrbitControls(cam,r.domElement);Object.assign(this.ctl,{enableDamping:true,dampingFactor:.06,minDistance:6,maxDistance:80,enablePan:false,autoRotateSpeed:.5});
  S.add(new THREE.AmbientLight(0xffffff,.7));this.light=new THREE.PointLight(0xffffff,60,60,1.6);S.add(this.light);
  this.heartPos=V3(0,3.5,-1);
  this.U={uT:{value:0},uReveal:{value:1},c1:{value:C('#fff')},c2:{value:C('#fff')},P0:{value:PL[0][0].clone()},P1:{value:V3(0,7,-2.5)},P2:{value:PL[1][0].clone()}};
  this.curve=new THREE.QuadraticBezierCurve3(this.U.P0.value,this.U.P1.value,this.U.P2.value);
  this.planets=PL.map(([p,rad,seed,tilt],i)=>this.planet(p,rad,seed,tilt,i));
  this.connection();this.crystal();this.rings();this.sky();
  this.capG=new THREE.Group();this.capG.position.copy(this.heartPos);this.capG.rotation.x=.35;S.add(this.capG);
  try{const c=this.comp=new EffectComposer(r);c.addPass(new RenderPass(S,cam));this.bloom=new UnrealBloomPass(new THREE.Vector2(256,256),.9,.6,.2);c.addPass(this.bloom);c.addPass(new OutputPass())}catch{this.comp=null}
  this.ro=new ResizeObserver(()=>this.resize());this.ro.observe(el);this.resize();
  const d=r.domElement;d.addEventListener('pointerdown',e=>this.down=[e.clientX,e.clientY]);
  d.addEventListener('pointerup',e=>{if(this.down&&Math.hypot(e.clientX-this.down[0],e.clientY-this.down[1])<6)this.pick(e)});
  this.vis=()=>{document.hidden?r.setAnimationLoop(null):(this.clock.getDelta(),r.setAnimationLoop(()=>this.frame()))};
  document.addEventListener('visibilitychange',this.vis);this.vis();
 }
 planet(pos,rad,seed,tilt,i){
  const g=new THREE.Group();g.position.copy(pos);g.rotation.z=tilt;
  const mat=new THREE.ShaderMaterial({uniforms:{uLo:{value:C('#000')},uHi:{value:C('#fff')},uLight:{value:this.heartPos.clone().sub(pos).normalize().add(V3(0,.15,.5))},uSeed:{value:seed},uT:{value:0}},vertexShader:PLANET_V,fragmentShader:PLANET_F});
  const m=new THREE.Mesh(new THREE.SphereGeometry(rad,64,48),mat);m.userData={type:i?'B':'A'};g.add(m);
  const am=new THREE.ShaderMaterial({uniforms:{uC:{value:C('#fff')}},vertexShader:ATMO_V,fragmentShader:ATMO_F,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false});
  g.add(new THREE.Mesh(new THREE.SphereGeometry(rad*1.14,48,32),am));this.scene.add(g);return{g,m,mat,am,pos}}
 connection(){
  const mk=(vs,fs,x)=>new THREE.ShaderMaterial({uniforms:{...this.U,...x},vertexShader:vs,fragmentShader:fs,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false});
  this.rib=[.09,.28].map((rad,i)=>{const m=new THREE.Mesh(new THREE.TubeGeometry(this.curve,140,rad,8),mk(RIB_V,RIB_F,{uA:{value:i?.18:1}}));if(!i)m.userData={type:'link'};this.scene.add(m);return m});
  const N=MOBILE?700:1800,H=16,build=(n,hr)=>{const a=new Float32Array(n*4);for(let i=0;i<n;i++)a.set([Math.random(),.5+Math.random(),Math.random()*6.28,hr?.5+Math.random()*.8:.15+Math.random()*.9],i*4);
   const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(n*3),3));g.setAttribute('a',new THREE.BufferAttribute(a,4));g.boundingSphere=new THREE.Sphere(V3(0,0,0),100);return g};
  const pm=h=>mk(PART_V,PART_F,{uSize:{value:h?260:90},uPix:{value:this.r.getPixelRatio()},uHeart:{value:h}});
  this.stream=new THREE.Points(build(N),pm(0));this.hearts=new THREE.Points(build(H,1),pm(1));this.stream.frustumCulled=this.hearts.frustumCulled=false;this.N=N;this.scene.add(this.stream,this.hearts)}
 crystal(){
  const s=new THREE.Shape();s.moveTo(0,-1);s.bezierCurveTo(-1.6,.2,-1.2,1.3,0,.6);s.bezierCurveTo(1.2,1.3,1.6,.2,0,-1);
  const g=new THREE.ExtrudeGeometry(s,{depth:.5,bevelEnabled:true,bevelSize:.12,bevelThickness:.15,bevelSegments:2});g.center();
  this.heart=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:'#fff',emissive:'#fff',emissiveIntensity:.9,metalness:.3,roughness:.1,flatShading:true,transparent:true,opacity:.88}));
  this.heart.add(new THREE.LineSegments(new THREE.EdgesGeometry(g,20),new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.6})));
  this.heart.position.copy(this.heartPos);this.heart.userData={type:'link'};this.light.position.copy(this.heartPos);this.scene.add(this.heart)}
 rings(){this.ringG=new THREE.Group();this.ringG.position.copy(this.heartPos);this.scene.add(this.ringG);this.sats=[];
  [[5,.4,0],[11,-.5,.3],[18,.2,-.4]].forEach(([r,rx,rz],i)=>{const g=new THREE.Group();g.rotation.set(rx,0,rz);
   const pts=new THREE.EllipseCurve(0,0,r,r*.75).getPoints(120).map(p=>V3(p.x,0,p.y));
   g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({transparent:true,opacity:.28})));
   for(let k=0;k<3;k++){const m=new THREE.Mesh(new THREE.SphereGeometry(.12+k*.04,12,12),new THREE.MeshBasicMaterial());g.add(m);this.sats.push({m,r,a:Math.random()*6.28,sp:(.5-i*.12)*(k%2?1:-1)})}
   this.ringG.add(g)})}
 sky(){const tex=glow(),mk=(n,R,sz)=>{const p=new Float32Array(n*3);for(let i=0;i<n;i++){const v=V3(Math.random()-.5,Math.random()-.5,Math.random()-.5).normalize().multiplyScalar(R[0]+Math.random()*R[1]);p.set([v.x,v.y,v.z],i*3)}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(p,3));const o=new THREE.Points(g,new THREE.PointsMaterial({size:sz,map:tex,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,opacity:.9}));this.scene.add(o);return o};
  this.stars=mk(MOBILE?1500:4000,[90,120],1.6);this.dust=mk(MOBILE?250:700,[8,30],.35);this.partMax=[this.dust.geometry.attributes.position.count,this.stars.geometry.attributes.position.count]}
 setTheme(t){this.scene.background=C(t.bg);const[A,B]=this.planets;
  [[A,t.a],[B,t.b]].forEach(([p,c])=>{p.mat.uniforms.uLo.value.set(c[0]);p.mat.uniforms.uHi.value.set(c[1]);p.am.uniforms.uC.value.set(c[1])});
  this.U.c1.value.set(t.c1);this.U.c2.value.set(t.c2);this.heart.material.color.set(t.heart);this.heart.material.emissive.set(t.heart);this.light.color.set(t.heart);
  this.ringG.traverse(o=>{if(o.isLineLoop)o.material.color.set(t.c1);if(o.isMesh)o.material.color.set(t.dust)});this.stars.material.color.set(t.dust);this.dust.material.color.set(t.heart);
  this.capG.children.forEach(c=>c.material?.emissive?.set(t.heart))}
 setAnimation(k){const m=this.mode=MODES[k]||MODES.cinematic;this.bloom&&(this.bloom.strength=m.bloom);
  this.stream.geometry.setDrawRange(0,Math.floor(this.N*m.pt));this.stars.geometry.setDrawRange(0,Math.floor(this.partMax[1]*(m.pt<1?.5:1)))}
 setMessages(list){this.items.forEach(i=>this.capG.remove(i.o));this.capG.children.slice().forEach(c=>{free(c);this.capG.remove(c)});this.items=[];
  list.forEach((m,i)=>{const g=new THREE.Group(),b=new THREE.Mesh(new THREE.CapsuleGeometry(.3,.5,4,12),new THREE.MeshStandardMaterial({color:'#fff',emissive:this.th?.heart||'#fff',emissiveIntensity:.8}));
   b.userData={type:'msg',index:i};b.rotation.z=1.2;g.add(b);const e=emoji(m.emoji);e.scale.setScalar(1.1);e.position.y=.8;g.add(e);this.capG.add(g);
   this.items.push({o:g,a:i/list.length*6.28,sp:.12+.02*(i%3),r:8.5,paused:false,m:b})})}
 apply(s,theme){this.th=theme;this.setTheme(theme);this.setAnimation(s.animation);this.setMessages(s.messages)}
 pick(e){const b=this.r.domElement.getBoundingClientRect(),rc=new THREE.Raycaster();rc.setFromCamera(V3((e.clientX-b.left)/b.width*2-1,-((e.clientY-b.top)/b.height)*2+1,0),this.cam);
  const hit=rc.intersectObjects([this.heart,this.rib[0],...this.planets.map(p=>p.m),...this.items.map(i=>i.m)],false)[0];if(!hit)return;
  const u=hit.object.userData;this.items.forEach(i=>i.paused=false);const p=hit.object.getWorldPosition(V3(0,0,0));
  if(u.type==='msg')this.items.find(i=>i.m===hit.object).paused=true;
  this.focus(u.type==='link'?this.curve.getPoint(.5):p,u.type==='link'?4:u.type==='msg'?4:9);this.cb.onPick?.(u)}
 focus(p,d=8){this.ctl.autoRotate=false;const dir=this.cam.position.clone().sub(p).normalize();this.tw={a:this.cam.position.clone(),b:p.clone().add(dir.multiplyScalar(d)),ta:this.ctl.target.clone(),tb:p.clone(),t:0}}
 focusPlanet(i){this.focus(this.planets[i].g.position,9)}focusLink(){this.focus(this.curve.getPoint(.5),5)}
 reset(){this.items.forEach(i=>i.paused=false);this.tw={a:this.cam.position.clone(),b:this.home.clone(),ta:this.ctl.target.clone(),tb:V3(0,1,0),t:0}}
 setAuto(v){this.ctl.autoRotate=v}setParticles(v){this.particlesOn=v;[this.stream,this.hearts,this.stars,this.dust].forEach(o=>o.visible=v)}
 start(){this.reset();if(this.mode.intro&&!RM){this.intro={t:0,dur:9,ph:-1};this.ctl.enabled=false}else{this.cam.position.copy(this.home);this.ctl.target.set(0,1,0);this.cb.onPhase?.(3)}}
 skip(){if(this.intro)this.intro.t=this.intro.dur}
 resize(){const w=this.el.clientWidth||1,h=this.el.clientHeight||1;this.r.setSize(w,h);this.comp?.setSize(w,h);this.cam.aspect=w/h;this.cam.updateProjectionMatrix();
  this.home=V3(0,6,32*(w/h<.8?1.7:1));for(const o of [this.stream,this.hearts])o.material.uniforms.uPix.value=this.r.getPixelRatio();if(!this.intro&&!this.tw&&!this.homed){this.cam.position.copy(this.home);this.homed=1}}
 frame(){const dt=Math.min(this.clock.getDelta(),.05),sp=this.mode.sp*(RM?.3:1);this.t+=dt*sp;const t=this.t,[A,B]=this.planets;
  let sc=1,rev=1,hs=1,I=this.intro;
  if(I){I.t+=dt;sc=ease(clamp(I.t/2.5));rev=clamp((I.t-2.5)/2.5);hs=ease(clamp((I.t-4.5)/1.5));
   const ph=I.t<2.5?0:I.t<5.5?1:I.t<I.dur?2:3;if(ph!==I.ph){I.ph=ph;this.cb.onPhase?.(ph)}
   this.cam.position.lerpVectors(V3(0,3,62),this.home,ease(clamp(I.t/I.dur)));this.cam.lookAt(0,1,0);
   if(I.t>=I.dur){this.intro=null;this.ctl.enabled=true;this.ctl.target.set(0,1,0)}}
  this.planets.forEach((p,i)=>{p.g.scale.setScalar(Math.max(sc,.001));p.g.position.x=p.pos.x*(1+(1-sc)*(i?1:1)*1.2);p.mat.uniforms.uT.value=t});
  A.m.rotation.y+=dt*sp*.12;B.m.rotation.y-=dt*sp*.09;this.U.uT.value=t;this.U.uReveal.value=rev;
  this.heart.scale.setScalar(Math.max(hs,.001)*(1+Math.sin(t*2.2)*.06)*.9);this.heart.rotation.y+=dt*sp*.6;
  this.stars.rotation.y+=dt*sp*.004;this.dust.rotation.y-=dt*sp*.01;
  this.sats.forEach(s=>{s.a+=dt*sp*s.sp;s.m.position.set(Math.cos(s.a)*s.r,0,Math.sin(s.a)*s.r*.75)});
  this.items.forEach(i=>{if(!i.paused)i.a+=dt*sp*i.sp;i.o.position.set(Math.cos(i.a)*i.r,0,Math.sin(i.a)*i.r*.75)});
  if(this.tw){const w=this.tw;w.t=Math.min(1,w.t+dt/1.4);const k=ease(w.t);this.cam.position.lerpVectors(w.a,w.b,k);this.ctl.target.lerpVectors(w.ta,w.tb,k);if(w.t>=1)this.tw=null}
  this.ctl.update();(this.comp&&this.mode.bloom>0?this.comp.render():this.r.render(this.scene,this.cam))}
 dispose(){this.r.setAnimationLoop(null);document.removeEventListener('visibilitychange',this.vis);this.ro.disconnect();free(this.scene);this.ctl.dispose();this.comp?.dispose?.();this.r.dispose();this.r.domElement.remove()}
}
