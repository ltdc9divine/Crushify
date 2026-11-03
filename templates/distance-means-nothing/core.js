// Pure logic: no DOM, no WebGL. Safe to unit test.
export const CITIES=[
['Thành phố Hồ Chí Minh','Asia/Ho_Chi_Minh',10.8231,106.6297],['Hà Nội','Asia/Ho_Chi_Minh',21.0285,105.8542],
['Tokyo','Asia/Tokyo',35.6762,139.6503],['Seoul','Asia/Seoul',37.5665,126.978],['Singapore','Asia/Singapore',1.3521,103.8198],
['Sydney','Australia/Sydney',-33.8688,151.2093],['London','Europe/London',51.5074,-0.1278],['Paris','Europe/Paris',48.8566,2.3522],
['Berlin','Europe/Berlin',52.52,13.405],['New York','America/New_York',40.7128,-74.006],['Los Angeles','America/Los_Angeles',34.0522,-118.2437],
['Toronto','America/Toronto',43.6532,-79.3832]].map(([n,tz,lat,lon])=>({n,tz,lat,lon}));
export const THEMES={
'midnight-distance':{bg:'#080D20',a:['#1b3a8a','#6C8DFF'],b:['#5a1f6e','#E77AC8'],c1:'#6C8DFF',c2:'#E77AC8',heart:'#A898FF',dust:'#F6F1FF'},
'blue-aurora':{bg:'#041421',a:['#0b4a6e','#4ee0c8'],b:['#1d2e8a','#8fb4ff'],c1:'#4ee0c8',c2:'#8fb4ff',heart:'#9ff3ff',dust:'#e6fbff'},
'rose-galaxy':{bg:'#1a0a24',a:['#6e1d5a','#ff8fcf'],b:['#4a1d8a','#c79bff'],c1:'#ff8fcf',c2:'#c79bff',heart:'#ffb3e6',dust:'#fff0fa'},
'golden-horizon':{bg:'#140d1c',a:['#7a3a12','#ffc46b'],b:['#2a3a7a','#ff9a8b'],c1:'#ffc46b',c2:'#ff8fa3',heart:'#ffe2a0',dust:'#fff6e0'}};
const P=()=>({name:'',city:'',timezone:'',lat:null,lon:null});
export const blank=()=>({templateId:'distance',sender:P(),receiver:P(),anniversary:'',nextMeeting:{date:'',time:'',timezone:''},
headline:'Xa mặt không cách lòng',message:'',theme:'midnight-distance',animation:'cinematic',distance:{mode:'coordinates',distanceKm:null},messages:[],memories:[]});
export const validTz=tz=>{try{new Intl.DateTimeFormat('en',{timeZone:tz});return !!tz}catch{return false}};
export function haversine(a,b,c,d){const r=x=>x*Math.PI/180,h=Math.sin(r(c-a)/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(r(d-b)/2)**2;return 12742*Math.asin(Math.sqrt(h))}
// Returns km or null. Never invents a number.
export function distanceKm(s){const n=s.distance;
 if(n.mode==='manual')return n.distanceKm>0?Math.round(n.distanceKm):null;
 const[a,b]=[s.sender,s.receiver];
 return [a.lat,a.lon,b.lat,b.lon].every(Number.isFinite)?Math.round(haversine(a.lat,a.lon,b.lat,b.lon)):null}
export function offsetMin(tz,d){const o={};new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'})
 .formatToParts(d).forEach(p=>o[p.type]=+p.value);return(Date.UTC(o.year,o.month-1,o.day,o.hour,o.minute,o.second)-Math.floor(d/1000)*1000)/6e4}
// Wall-clock time in tz -> UTC ms (DST-safe, two-pass).
export function zonedToUtc(date,time,tz){const[y,m,d]=date.split('-').map(Number),[h,mi]=(time||'00:00').split(':').map(Number);
 let t=Date.UTC(y,m-1,d,h,mi),o=offsetMin(tz,new Date(t));t-=o*6e4;const o2=offsetMin(tz,new Date(t));if(o2!==o)t-=(o2-o)*6e4;return t}
export function clockInfo(tz,now=new Date()){
 const f=(opt)=>new Intl.DateTimeFormat('vi-VN',{timeZone:tz,...opt}).format(now);
 const hour=+new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'numeric',hourCycle:'h23'}).format(now);
 return{time:f({hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}),date:f({weekday:'short',day:'numeric',month:'short'}),
 ymd:new Intl.DateTimeFormat('en-CA',{timeZone:tz}).format(now),day:hour>=6&&hour<18,greet:hour<5?'Đêm khuya':hour<12?'Buổi sáng':hour<18?'Buổi chiều':hour<22?'Buổi tối':'Đêm nay'}}
export function diffLabel(a,b,now=new Date()){const m=offsetMin(b,now)-offsetMin(a,now),h=Math.abs(m)/60;
 return m===0?'Cùng múi giờ':`${Number.isInteger(h)?h:h.toFixed(1)} giờ ${m>0?'sớm hơn':'muộn hơn'}`}
export function countdown(s,now=Date.now()){const n=s.nextMeeting;if(!n.date||!validTz(n.timezone))return null;
 const ms=zonedToUtc(n.date,n.time,n.timezone)-now;if(ms<=0)return{done:true};const t=Math.floor(ms/1e3);
 return{done:false,d:Math.floor(t/86400),h:Math.floor(t%86400/3600),m:Math.floor(t%3600/60),s:t%60}}
export function daysTogether(s,now=new Date()){if(!s.anniversary||!validTz(s.sender.timezone))return null;
 const t=clockInfo(s.sender.timezone,now).ymd;return Math.max(0,Math.round((Date.parse(t)-Date.parse(s.anniversary))/864e5))}
