(()=> {
"use strict";
const $=id=>document.getElementById(id);
const canvas=$("universeCanvas");
const ctx=canvas.getContext("2d",{alpha:false});
if(!ctx){canvas.insertAdjacentHTML("afterend",'<p style="color:white;padding:30px">Trình duyệt không hỗ trợ Canvas.</p>');return;}

// All core visuals are drawn locally with Canvas 2D. No Three.js/WebGL CDN is required.
const defaults={
 nameA:"Minh",nameB:"Linh",headlineInput:"You are my favorite universe.",
 startDate:"2024-02-14",
 mainMessage:"Giữa hàng tỷ vì sao ngoài kia, điều may mắn nhất của mình là tìm thấy cậu. Cảm ơn vì đã cùng mình viết nên những ngày thật đẹp.",
 memoryTitle0:"First Orbit",memoryTitle1:"Our Journey",memoryTitle2:"To Infinity",
 memoryText0:"Ngày hai thế giới bắt đầu tiến lại gần nhau. Từ một cuộc gặp tưởng bình thường, mọi thứ dần trở nên đặc biệt.",
 memoryText1:"Những điều nhỏ bé nhất lại là thứ mình nhớ lâu nhất: những lần đi dạo, những câu chuyện chẳng có hồi kết.",
 memoryText2:"Mình không biết tương lai sẽ đưa chúng ta đến đâu, chỉ mong những vì sao sau này vẫn có hai đứa cạnh nhau."
};
const fields=Object.keys(defaults);
let memories=[0,1,2].map(i=>({title:defaults["memoryTitle"+i],text:defaults["memoryText"+i]}));
let W=0,H=0,DPR=1,unit=24,centerX=0,centerY=0;
let yaw=-.12,pitch=.56,targetYaw=yaw,targetPitch=pitch,zoom=1,targetZoom=1,autoRotate=true,dragging=false,lastX=0,lastY=0,downX=0,downY=0;
let hitAreas=[],photoURLs=[];
const rand=(a,b)=>a+Math.random()*(b-a);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const bgStars=Array.from({length:850},()=>({x:Math.random(),y:Math.random(),r:rand(.25,1.2),a:rand(.18,.75),phase:rand(0,6.28)}));
const dust=Array.from({length:2300},()=>({x:rand(-1,1),y:rand(-1,1),z:rand(-1,1),r:rand(.35,1.1),a:rand(.15,.75),phase:rand(0,6.28)}));
const disk=[];
for(let i=0;i<7200;i++){
 const arm=i%4, radius=Math.pow(Math.random(),.72)*14.2+.12;
 const angle=arm*Math.PI/2+radius*.78+rand(-.33,.33);
 const x=Math.cos(angle)*radius+rand(-.14,.14),z=Math.sin(angle)*radius+rand(-.14,.14);
 const colorPick=Math.random();
 disk.push({x,y:rand(-.11,.11),z,r:rand(.45,1.65),alpha:rand(.28,.95),phase:rand(0,6.28),color:radius<3.5?(colorPick>.18?"255,110,190":"255,220,244"):(colorPick>.55?"255,82,169":colorPick>.24?"186,111,255":"255,177,224")});
}
// A filled 3D particle heart: the silhouette is sampled radially, with depth and a soft luminous edge.
const heart=[];
for(let i=0;i<5800;i++){
 const t=Math.random()*Math.PI*2,rad=Math.sqrt(Math.random());
 const rawX=16*Math.pow(Math.sin(t),3);
 const rawY=13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t);
 const edge=Math.pow(rad,1.2);
 heart.push({
  x:rawX*.225*rad,
  y:5.25+rawY*.225*rad,
  z:rand(-.55,.55)*(1-rad)+Math.sin(t*3)*.10,
  r:rand(.55,1.8)*(0.68+edge*.5),
  alpha:rand(.55,1),
  phase:rand(0,6.28),
  color:Math.random()>.16?"255,91,184":Math.random()>.5?"255,190,231":"255,239,250"
 });
}
const heartGlints=Array.from({length:90},()=>({a:rand(0,6.28),r:rand(.4,4),phase:rand(0,6.28)}));
const nodes=[
 {index:0,angle:-.65,radius:9.3,color:"#ff75c2",icon:"✦"},
 {index:1,angle:2.7,radius:10.8,color:"#91a5ff",icon:"♡"},
 {index:2,angle:5.15,radius:8.4,color:"#ffd08a",icon:"✧"}
];
let time=0;

function resize(){
 const rect=canvas.getBoundingClientRect();W=rect.width;H=rect.height;DPR=Math.min(window.devicePixelRatio||1,1.6);
 canvas.width=Math.round(W*DPR);canvas.height=Math.round(H*DPR);
 ctx.setTransform(DPR,0,0,DPR,0,0);
 unit=Math.min(W*.034,H*.034);
 centerX=W*.5;centerY=H*.665;
}
function rotatePoint(p){
 const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
 const x=p.x*cy+p.z*sy,z0=-p.x*sy+p.z*cy;
 const y=p.y*cp-z0*sp,z=z0*cp+p.y*sp;
 const perspective=32/(32+z*.22);
 return {x:centerX+x*unit*zoom*perspective,y:centerY-y*unit*zoom*perspective,scale:unit*zoom*perspective,depth:z};
}
function glow(x,y,r,color,alpha=1){
 const g=ctx.createRadialGradient(x,y,0,x,y,r);
 g.addColorStop(0,color.replace("ALPHA",String(.26*alpha)));
 g.addColorStop(.45,color.replace("ALPHA",String(.09*alpha)));
 g.addColorStop(1,color.replace("ALPHA","0"));
 ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
}
function drawBackground(){
 ctx.fillStyle="#030309";ctx.fillRect(0,0,W,H);
 const wash=ctx.createRadialGradient(centerX,centerY-40,5,centerX,centerY,Math.max(W,H)*.56);
 wash.addColorStop(0,"rgba(88,24,78,.30)");wash.addColorStop(.45,"rgba(34,18,53,.20)");wash.addColorStop(1,"rgba(3,3,9,0)");
 ctx.fillStyle=wash;ctx.fillRect(0,0,W,H);
 for(const s of bgStars){const tw=.55+.45*Math.sin(time*1.1+s.phase);ctx.fillStyle=`rgba(231,211,255,${s.a*tw})`;ctx.beginPath();ctx.arc(s.x*W,s.y*H,s.r,0,Math.PI*2);ctx.fill();}
}
function drawProjectedRing(radius,color,width,alpha,verticalOffset=0){
 ctx.beginPath();let first=true;
 for(let i=0;i<=180;i++){const a=i/180*Math.PI*2,p=rotatePoint({x:Math.cos(a)*radius,y:verticalOffset,z:Math.sin(a)*radius});if(first){ctx.moveTo(p.x,p.y);first=false}else ctx.lineTo(p.x,p.y);}
 ctx.closePath();ctx.strokeStyle=color;ctx.globalAlpha=alpha;ctx.lineWidth=width;ctx.shadowColor=color;ctx.shadowBlur=13;ctx.stroke();ctx.shadowBlur=0;ctx.globalAlpha=1;
}
function drawDisk(){
 // Diffuse nebula above the galactic plane.
 const c=rotatePoint({x:0,y:0,z:0});
 ctx.save();ctx.globalCompositeOperation="screen";
 const neb=ctx.createRadialGradient(c.x,c.y,0,c.x,c.y,unit*15*zoom);
 neb.addColorStop(0,"rgba(255,55,157,.20)");neb.addColorStop(.22,"rgba(190,42,156,.12)");neb.addColorStop(.62,"rgba(91,48,156,.055)");neb.addColorStop(1,"rgba(0,0,0,0)");
 ctx.fillStyle=neb;ctx.beginPath();ctx.ellipse(c.x,c.y,unit*15*zoom,unit*5.5*zoom,-.05,0,Math.PI*2);ctx.fill();ctx.restore();

 const projected=disk.map(p=>({p,s:rotatePoint(p)})).sort((a,b)=>a.s.depth-b.s.depth);
 ctx.save();ctx.globalCompositeOperation="lighter";
 for(const {p,s} of projected){
  const tw=.55+.45*Math.sin(time*1.3+p.phase);
  const r=Math.max(.45,p.r*s.scale*.055);
  ctx.fillStyle=`rgba(${p.color},${p.alpha*tw*.72})`;
  ctx.beginPath();ctx.arc(s.x,s.y,r,0,Math.PI*2);ctx.fill();
 }
 // Dusty outer ring and central accretion disc.
 drawProjectedRing(3.1,"#e74dba",1.1,.34);
 drawProjectedRing(2.35,"#ff68c0",1.8,.66);
 drawProjectedRing(1.62,"#ff9bd9",2.1,.72);
 drawProjectedRing(1.02,"#ffd4ef",1.3,.82);
 ctx.restore();

 const core=rotatePoint({x:0,y:.02,z:0});
 const rx=unit*1.22*zoom,ry=unit*.48*zoom;
 const g=ctx.createRadialGradient(core.x,core.y,1,core.x,core.y,unit*2.3*zoom);
 g.addColorStop(0,"rgba(0,0,0,.98)");g.addColorStop(.44,"rgba(7,3,16,.94)");g.addColorStop(.68,"rgba(249,59,170,.28)");g.addColorStop(1,"rgba(249,59,170,0)");
 ctx.fillStyle=g;ctx.beginPath();ctx.ellipse(core.x,core.y,rx*1.7,ry*1.8,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle="#05030b";ctx.beginPath();ctx.ellipse(core.x,core.y,rx*.45,ry*.46,0,0,Math.PI*2);ctx.fill();
 // Central bright lens flare.
 ctx.fillStyle="rgba(255,205,240,.85)";ctx.beginPath();ctx.ellipse(core.x,core.y,rx*.17,Math.max(1,ry*.13),0,0,Math.PI*2);ctx.fill();
}
function drawFloatingLabels(){
 hitAreas=[];
 nodes.forEach((n,i)=>{
  const a=n.angle+time*(i===1?-.025:.018);
  const pos={x:Math.cos(a)*n.radius,y:.35+Math.sin(time*1.2+i)*.16,z:Math.sin(a)*n.radius};
  const p=rotatePoint(pos);
  const radius=Math.max(7,unit*.28*zoom);
  ctx.shadowColor=n.color;ctx.shadowBlur=18;
  const grd=ctx.createRadialGradient(p.x-radius*.35,p.y-radius*.4,1,p.x,p.y,radius);
  grd.addColorStop(0,"#fff6ff");grd.addColorStop(.28,n.color);grd.addColorStop(1,"#39133d");
  ctx.fillStyle=grd;ctx.beginPath();ctx.arc(p.x,p.y,radius,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle="rgba(255,220,245,.65)";ctx.lineWidth=1;ctx.stroke();ctx.shadowBlur=0;
  ctx.font=`${Math.max(10,unit*.35)}px "DM Sans",sans-serif`;ctx.textAlign="center";ctx.fillStyle="#ffe1f2";ctx.shadowColor="#ff70bd";ctx.shadowBlur=9;ctx.fillText(memories[i].title.toUpperCase(),p.x,p.y+radius+15);ctx.shadowBlur=0;
  hitAreas.push({x:p.x,y:p.y,r:Math.max(17,radius+9),index:i});
 });
 // floating tiny hearts and comet labels on the orbital plane
 for(let i=0;i<9;i++){
  const a=time*.12+i*Math.PI*2/9, r=7.2+(i%3)*1.65;
  const p=rotatePoint({x:Math.cos(a)*r,y:.55+Math.sin(time+i)*.35,z:Math.sin(a)*r});
  ctx.save();ctx.translate(p.x,p.y);ctx.rotate(Math.sin(a)*.22);ctx.font=`${Math.max(11,unit*.45)}px serif`;ctx.fillStyle=i%2?"#ff88c8":"#ffc2e6";ctx.globalAlpha=.6+.25*Math.sin(time*2+i);ctx.shadowColor="#ff4aaa";ctx.shadowBlur=12;ctx.fillText(i%3===0?"♥":i%3===1?"✦":"♡",0,0);ctx.restore();
 }
}
function drawHeart(){
 const sorted=heart.map(p=>({p,s:rotatePoint(p)})).sort((a,b)=>a.s.depth-b.s.depth);
 ctx.save();ctx.globalCompositeOperation="lighter";
 // soft luminous aura behind the heart silhouette
 const upper=rotatePoint({x:0,y:5.4,z:-.35});
 const aura=ctx.createRadialGradient(upper.x,upper.y,unit*.3,upper.x,upper.y,unit*5.2*zoom);
 aura.addColorStop(0,"rgba(255,79,175,.25)");aura.addColorStop(.4,"rgba(226,51,163,.12)");aura.addColorStop(1,"rgba(120,30,130,0)");
 ctx.fillStyle=aura;ctx.beginPath();ctx.arc(upper.x,upper.y,unit*5.2*zoom,0,Math.PI*2);ctx.fill();
 for(const {p,s} of sorted){
  const tw=.63+.37*Math.sin(time*2.1+p.phase);
  const r=Math.max(.55,p.r*s.scale*.07);
  ctx.fillStyle=`rgba(${p.color},${p.alpha*tw})`;
  ctx.beginPath();ctx.arc(s.x,s.y,r,0,Math.PI*2);ctx.fill();
 }
 // A narrow particle stem visually connects the heart tip to the galaxy core.
 const tip=rotatePoint({x:0,y:1.35,z:0});
 const base=rotatePoint({x:0,y:.2,z:0});
 const grad=ctx.createLinearGradient(tip.x,tip.y,base.x,base.y);grad.addColorStop(0,"rgba(255,100,190,0)");grad.addColorStop(.5,"rgba(255,105,195,.55)");grad.addColorStop(1,"rgba(255,190,230,0)");
 ctx.strokeStyle=grad;ctx.lineWidth=2;ctx.shadowColor="#ff4eae";ctx.shadowBlur=15;ctx.beginPath();ctx.moveTo(tip.x,tip.y);ctx.lineTo(base.x,base.y);ctx.stroke();ctx.shadowBlur=0;
 for(const g of heartGlints){const p=rotatePoint({x:Math.cos(g.a+time*.08)*g.r,y:5.1+Math.sin(g.a+time*.08)*g.r,z:Math.sin(g.a+time*.08)*.5});const pulse=.4+.6*Math.sin(time*2+g.phase);ctx.fillStyle=`rgba(255,220,246,${pulse})`;ctx.fillRect(p.x,p.y,1.4,1.4);}
 ctx.restore();
}
function draw(){
 time+=.012;
 if(autoRotate&&!dragging)targetYaw+=.00075;
 yaw+=(targetYaw-yaw)*.075;pitch+=(targetPitch-pitch)*.075;zoom+=(targetZoom-zoom)*.09;
 drawBackground();drawDisk();drawFloatingLabels();drawHeart();
 requestAnimationFrame(draw);
}
resize();window.addEventListener("resize",resize);draw();

function updateContent(){
 const a=$("nameA").value.trim()||"Bạn",b=$("nameB").value.trim()||"Người ấy",headline=$("headlineInput").value.trim()||"You are my favorite universe.",message=$("mainMessage").value.trim();
 $("heroNameA").textContent=a;$("heroNameB").textContent=b;$("previewNameA").textContent=a;$("previewNameB").textContent=b;
 // Keep user text as text, not executable markup.
 $("heroHeadline").textContent=headline;$("previewHeadline").textContent=headline;$("heroMessage").textContent=message;$("previewMessage").textContent=message;
 const days=daysTogether();$("dayCount").textContent=days.toLocaleString("vi-VN");$("previewDays").textContent=days.toLocaleString("vi-VN");
 [0,1,2].forEach(i=>{memories[i]={title:$("memoryTitle"+i).value.trim()||"A memory",text:$("memoryText"+i).value.trim()};$("memoryCardTitle"+i).textContent=memories[i].title;$("memoryCardDesc"+i).textContent=memories[i].text;});
}
function daysTogether(){const raw=$("startDate").value;if(!raw)return 0;const date=new Date(raw+"T00:00:00");if(Number.isNaN(date.getTime())||date>new Date())return 0;return Math.max(0,Math.floor((Date.now()-date.getTime())/86400000));}
fields.forEach(id=>$(id).addEventListener("input",updateContent));$("startDate").addEventListener("change",updateContent);updateContent();

function openStory(title,text,label){$("modalTitle").textContent=title;$("modalText").textContent=text;$("modalEyebrow").textContent=label;$("storyModal").classList.add("open");}
function closeStory(){$("storyModal").classList.remove("open");}
$("closeModal").addEventListener("click",closeStory);$("modalDone").addEventListener("click",closeStory);$("storyModal").addEventListener("click",e=>{if(e.target===$("storyModal"))closeStory();});document.addEventListener("keydown",e=>{if(e.key==="Escape")closeStory();});
$("openLetter").addEventListener("click",()=>openStory("Gửi "+($("nameB").value.trim()||"người thương"),$("mainMessage").value,"A LETTER FROM "+($("nameA").value||"YOUR PERSON").toUpperCase()));
document.querySelectorAll("[data-memory]").forEach(el=>el.addEventListener("click",()=>{const i=Number(el.dataset.memory);openStory(memories[i].title,memories[i].text,"MEMORY ORBIT 0"+(i+1));}));
$("jumpEditor").addEventListener("click",()=>$("editor").scrollIntoView({behavior:"smooth"}));

const draftKey="crushify-our-universe-v4";
function saveDraft(){try{const data={};fields.forEach(id=>data[id]=$(id).value);localStorage.setItem(draftKey,JSON.stringify(data));$("saveStatus").textContent="Đã lưu bản nháp trên thiết bị này.";}catch(e){$("saveStatus").textContent="Trình duyệt không cho phép lưu nháp ở chế độ hiện tại.";}}
$("saveDraft").addEventListener("click",saveDraft);
$("restoreDefaults").addEventListener("click",()=>{fields.forEach(id=>$(id).value=defaults[id]);updateContent();try{localStorage.removeItem(draftKey);$("saveStatus").textContent="Đã khôi phục nội dung mẫu.";}catch(e){$("saveStatus").textContent="Đã khôi phục nội dung mẫu, nhưng không thể xóa bản nháp đã lưu."; }});
try{const draft=JSON.parse(localStorage.getItem(draftKey)||"null");if(draft&&typeof draft==="object"&&!Array.isArray(draft)){fields.forEach(id=>{if(typeof draft[id]==="string")$(id).value=draft[id];});updateContent();}else if(draft!==null){$("saveStatus").textContent="Bản nháp đã lưu không hợp lệ nên không thể khôi phục.";}}catch(e){$("saveStatus").textContent="Không thể khôi phục bản nháp đã lưu trên thiết bị này.";}

$("photoUpload").addEventListener("change",e=>{
 photoURLs.forEach(URL.revokeObjectURL);photoURLs=[];
 const box=$("photoPreview");box.replaceChildren();
 [...e.target.files].slice(0,4).forEach(file=>{if(!file.type.startsWith("image/"))return;const url=URL.createObjectURL(file);photoURLs.push(url);const img=document.createElement("img");img.src=url;img.alt="Ảnh kỷ niệm";box.append(img);});
});

function pickAt(x,y){for(let i=hitAreas.length-1;i>=0;i--){const h=hitAreas[i];if(Math.hypot(x-h.x,y-h.y)<h.r){const n=memories[h.index];openStory(n.title,n.text,"MEMORY ORBIT 0"+(h.index+1));return true;}}return false;}
canvas.addEventListener("pointerdown",e=>{dragging=true;downX=lastX=e.clientX;downY=lastY=e.clientY;canvas.setPointerCapture?.(e.pointerId);});
canvas.addEventListener("pointermove",e=>{if(!dragging)return;const dx=e.clientX-lastX,dy=e.clientY-lastY;targetYaw+=dx*.006;targetPitch=clamp(targetPitch+dy*.004,-.16,1.18);lastX=e.clientX;lastY=e.clientY;});
canvas.addEventListener("pointerup",e=>{if(Math.hypot(e.clientX-downX,e.clientY-downY)<7){const r=canvas.getBoundingClientRect();pickAt(e.clientX-r.left,e.clientY-r.top);}dragging=false;});
canvas.addEventListener("pointercancel",()=>dragging=false);
canvas.addEventListener("wheel",e=>{targetZoom=clamp(targetZoom+Math.sign(e.deltaY)*-.07,.68,1.55);},{passive:true});
$("autoRotate").addEventListener("click",()=>{autoRotate=!autoRotate;$("autoRotate").classList.toggle("active",autoRotate);$("autoRotate").setAttribute("aria-pressed",String(autoRotate));});
$("zoomIn").addEventListener("click",()=>targetZoom=clamp(targetZoom+.12,.68,1.55));
$("zoomOut").addEventListener("click",()=>targetZoom=clamp(targetZoom-.12,.68,1.55));
$("resetScene").addEventListener("click",()=>{targetYaw=-.12;targetPitch=.56;targetZoom=1;autoRotate=true;$("autoRotate").classList.add("active");});
})();
