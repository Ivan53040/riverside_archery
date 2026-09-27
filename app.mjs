
import {normalise,CONNECTIONS} from './tracking/normalise.mjs';
import {renderScale} from './render-policy.mjs';
const $=id=>document.getElementById(id),video=$('camera-video'),overlay=$('camera-overlay'),ctx=overlay.getContext('2d');
const setText=(id,value)=>{const el=$(id),text=String(value);if(el&&el.textContent!==text)el.textContent=text;};
const params=new URLSearchParams(location.search);
const qa=params.get('qa')==='1';
const kiosk=params.get('display')==='1'||params.get('kiosk')==='1';
const perf=params.get('perf')==='1'||kiosk;
const demo={drift:Math.max(0,Math.min(3,Number(params.get('drift')||1))),respawn:Math.max(.2,Math.min(8,Number(params.get('respawn')||2.6)))};
const DWELL_MS=3000;
const dwellState={key:null,since:0};
let unity=null,unityReady=false,worker=null,stream=null,cameraReady=false,busy=false,running=false,loopTimer=0;
let starting=null,generation=0,lastVideoTime=-1,latestFrame=null,swap=false,settingsOpen=false;
let videoFrameCallback=0,trackingDelegate=null,graphicsRenderer='',renderTier=0,currentRenderScale=1;
let perfSampleTime=performance.now(),perfSampleFrames=0,trackingRate=0;
let aboutOpen=false,pointerMode=false;
let discoveredAreas=0,studyAreaTotal=5,kioskRestartTimer=0;
let inputChangedAt=0,inputWasActive=null;
let qaGripVariation=false,qaDwellAtCursor=false,qaCursor={x:.5,y:.5};
let consecutiveErrors=0,lastHud=null,qaTimer=0,qaMissing=false,qaAction="neutral",qaNockAt=0,qaReleaseAt=0,qaPull=0,qaLastTick=0,qaAim={x:.5,y:.5},trackingFrames=0,inferenceMs=0,lastTrackDispatch=0,lastPerfUpdate=0;
const pending=[];
// Short synthesized sounds keep the build self-contained and work without external audio assets.
let audioContext=null;
let soundEnabled=localStorage.getItem('tafe-archery-sound')!=='off';
let soundVolume=Number(localStorage.getItem('tafe-archery-volume')||'.7');
function unlockAudio(){
 try{
  const AudioCtor=window.AudioContext||window.webkitAudioContext;
  if(!AudioCtor)return null;
  if(!audioContext)audioContext=new AudioCtor();
  if(audioContext.state==='suspended')audioContext.resume().catch(()=>{});
  return audioContext;
 }catch(error){return null;}
}
function tone({frequency=440,endFrequency=frequency,duration=.12,type='sine',volume=.08,delay=0}){
 const ac=unlockAudio();if(!ac||!soundEnabled||soundVolume<=0)return;
 const start=ac.currentTime+delay,osc=ac.createOscillator(),gain=ac.createGain();
 osc.type=type;osc.frequency.setValueAtTime(frequency,start);osc.frequency.exponentialRampToValueAtTime(Math.max(30,endFrequency),start+duration);
 gain.gain.setValueAtTime(.0001,start);gain.gain.exponentialRampToValueAtTime(volume*soundVolume,start+.012);gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
 osc.connect(gain).connect(ac.destination);osc.start(start);osc.stop(start+duration+.02);
}
function noiseBurst({duration=.22,volume=.14,delay=0}={}){
 const ac=unlockAudio();if(!ac||!soundEnabled||soundVolume<=0)return;
 const length=Math.max(1,Math.floor(ac.sampleRate*duration)),buffer=ac.createBuffer(1,length,ac.sampleRate),data=buffer.getChannelData(0);
 for(let i=0;i<length;i++)data[i]=(Math.random()*2-1)*(1-i/length);
 const source=ac.createBufferSource(),filter=ac.createBiquadFilter(),gain=ac.createGain(),start=ac.currentTime+delay;
 source.buffer=buffer;filter.type='bandpass';filter.frequency.setValueAtTime(1150,start);filter.frequency.exponentialRampToValueAtTime(260,start+duration);filter.Q.value=.7;
 gain.gain.setValueAtTime(volume*soundVolume,start);gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
 source.connect(filter).connect(gain).connect(ac.destination);source.start(start);source.stop(start+duration+.02);
}
function playWhoosh(){
 noiseBurst({duration:.28,volume:.055});
 tone({frequency:180,endFrequency:720,duration:.24,type:'sine',volume:.045});
}
function playPop(){
 noiseBurst({duration:.18,volume:.16});
 tone({frequency:260,endFrequency:70,duration:.2,type:'triangle',volume:.13});
 tone({frequency:760,endFrequency:180,duration:.1,type:'sine',volume:.06,delay:.025});
}
function playAbout(){
 tone({frequency:520,endFrequency:760,duration:.16,type:'sine',volume:.07});
 tone({frequency:780,endFrequency:1040,duration:.22,type:'sine',volume:.065,delay:.1});
}
function send(command){if(unity)unity.SendMessage('ArcheryPrototype','OnCommand',command);else pending.push(command);}
function sendDemoConfig(){send('demo:drift='+demo.drift+',respawn='+demo.respawn);}
function updatePerformance(h){
 resizeGame(h.qualityTier);
 if(performance.now()-lastPerfUpdate<500)return;
 lastPerfUpdate=performance.now();
 const elapsed=lastPerfUpdate-perfSampleTime;
 trackingRate=elapsed>0?Math.round((trackingFrames-perfSampleFrames)*1000/elapsed):0;
 perfSampleTime=lastPerfUpdate;perfSampleFrames=trackingFrames;
 const fps=Math.round(h.fps||0),track=trackingRate,latency=inferenceMs?Math.round(inferenceMs):0;
 const quality=['HIGH','BALANCED','RECOVERY'][Math.max(0,Math.min(2,h.qualityTier??0))];
 $('perf-fps').textContent=fps;$('perf-track').textContent=track;$('perf-latency').textContent=latency+'ms';$('perf-quality').textContent=quality;
}
function resizeGame(tier=renderTier){
 renderTier=Math.max(0,Math.min(2,tier??0));
 const canvas=$('unity-canvas'),width=canvas.clientWidth,height=canvas.clientHeight;
 if(!width||!height)return;
 currentRenderScale=renderScale(width,height,window.devicePixelRatio||1,renderTier);
 const w=Math.max(1,Math.round(width*currentRenderScale)),h=Math.max(1,Math.round(height*currentRenderScale));
 if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;updateAccelerationStatus();}
}
function updateAccelerationStatus(){
 const software=/swiftshader|llvmpipe|software|microsoft basic render/i.test(graphicsRenderer);
 const graphics=software?'Software graphics':graphicsRenderer?'GPU graphics':'WebGL graphics';
 const tracking=trackingDelegate?trackingDelegate+' hand tracking':'Camera not connected';
 setText('acceleration-status',graphics+' · '+tracking);
 setText('acceleration-hint',software?'Enable graphics acceleration in your browser settings and restart the browser.':'Automatic scene quality keeps the interface sharp and limits rendering work on high-resolution screens.');
}
function inputActive(){return !document.hidden&&document.hasFocus()&&!settingsOpen;}
// Dwell selection: hold the index fingertip over a menu button for 3 seconds to click it.
function dwellTargets(){
 const out=[];
 if(aboutOpen)out.push({key:'about-close',el:$('about-close')});
 if(!$('welcome').hidden)out.push({key:'start',el:$('start')},{key:'fallback-start',el:$('fallback-start')});
 if(!$('result').hidden)out.push({key:'again',el:$('again')});
 if(!$('settings').hidden)out.push({key:'retry-camera',el:$('retry-camera')},{key:'close-settings',el:$('close-settings')});
 return out.filter(t=>t.el&&!t.el.hidden&&!t.el.disabled);
}
function dwellAt(fx,fy,dot){
 dot.hidden=false;dot.style.left=(fx*100)+'%';dot.style.top=(fy*100)+'%';
 let target=null;
 for(const t of dwellTargets()){
  const b=t.el.getBoundingClientRect();
  if(fx*innerWidth>=b.left-12&&fx*innerWidth<=b.right+12&&fy*innerHeight>=b.top-12&&fy*innerHeight<=b.bottom+12){target=t;break;}
 }
 if(!target||dwellState.key!==target.key){
  dwellState.key=target?target.key:null;dwellState.since=target?performance.now():0;
  dot.style.background='conic-gradient(var(--gold) 0deg,#ffffff26 0deg 360deg)';dot.classList.remove('done');
  document.querySelectorAll('.dwelling').forEach(b=>b.classList.remove('dwelling'));
  if(target)target.el.classList.add('dwelling');
  return;
 }
 const p=Math.min(1,(performance.now()-dwellState.since)/DWELL_MS);
 dot.style.background=`conic-gradient(var(--gold) ${p*360}deg,#ffffff26 ${p*360}deg 360deg)`;
 if(p>=1){
  dwellState.key=null;dwellState.since=0;dot.classList.add('done');
  target.el.classList.remove('dwelling');
  target.el.click();
 }
}
function updateDwell(){
 const dot=$('dwell-dot');
 if(document.hidden){dot.hidden=true;return;}
 // While the bow is drawn the hand is a weapon, not a cursor: hide the dwell fingertip until release.
 if(lastHud&&(lastHud.nocked||lastHud.aiming)&&lastHud.state==='playing'){dot.hidden=true;return;}
 const frame=latestFrame&&latestFrame.tracked&&!latestFrame.stale?latestFrame:null;
 const hand=frame&&frame.hands.length?frame.hands[0]:null;
 if(qaDwellAtCursor){
  dwellAt(qaCursor.x,qaCursor.y,dot);return;
 }
 if(!hand){dot.hidden=true;return;}
 // indexTip is already mirrored once by normalise.mjs (1-x), matching the mirrored preview. Mirror again and the finger moves opposite to the cursor.
 const fx=hand.indexTip.x,fy=hand.indexTip.y;
 dwellAt(fx,fy,dot);
}
setInterval(()=>{if(cameraReady||qaTimer||qa)updateDwell();},80);
function trackingMessage(frame){
 if(!inputActive()||frame.timestamp<inputChangedAt)return;
 frame.stale=frame.stale||performance.now()-frame.timestamp>200;
 latestFrame=frame;paintPreview(frame);refreshCameraStatus();
 if(unity)unity.SendMessage('ArcheryPrototype','OnTrackingJson',JSON.stringify(frame));
}
function setCameraStatus(text,error=false){
 $('camera-state').textContent=text;$('camera-state').title=text;$('camera-error').textContent=error?text:'';
 if(starting)$('load-status').textContent=text;
}
function readableError(error){
 const names={NotAllowedError:'Camera access is blocked. Allow the camera in the address bar, then reconnect.',NotFoundError:'No camera found. Connect a webcam and try again.',NotReadableError:'The camera may be in use by another app. Close that app and try again.',OverconstrainedError:'This camera cannot use the requested mode. Choose another camera.'};
 return names[error.name]||'Could not start tracking: '+(error.message||String(error));
}
function refreshCameraStatus(){
 if(!cameraReady&&!qaTimer)return;
 const active=inputActive(),fresh=active&&latestFrame&&!latestFrame.stale&&performance.now()-latestFrame.timestamp<=200;
 const count=fresh&&latestFrame.tracked?latestFrame.hands.filter(h=>h.confidence>=.5).length:0;
 const text=!active?'Tracking paused':count===2?'Both hands detected':count===1?'One hand detected':'Waiting for hands';
 setCameraStatus(text);$('cam-dot').classList.toggle('live',active&&count>0);
 $('cam-dot').classList.toggle('paused',!active);
 $('camera-hint').textContent=active?'LEFT = BOW · RIGHT = STRING · Both hands visible':'Click the game to resume tracking.';
 if(!active){
  paintPreview(null);$('left-status').classList.remove('on');$('right-status').classList.remove('on');
  $('tracking-pill').classList.remove('ready');$('tracking-pill').querySelector('span').textContent='Tracking paused';
 }
}
function syncInputActivity(){
 const active=inputActive();
 if(active!==inputWasActive){
  inputWasActive=active;inputChangedAt=performance.now();latestFrame=null;paintPreview(null);send(active?'visible':'hidden');
 }
 refreshCameraStatus();
}
function updateSoundControls(){
 const enabled=$('sound-enabled'),volume=$('sound-volume'),value=$('sound-volume-value');
 if(enabled)enabled.checked=soundEnabled;
 if(volume){volume.value=String(soundVolume);if(value)value.textContent=Math.round(soundVolume*100)+'%';}
}
function showSettings(){settingsOpen=true;$('settings').hidden=false;updateSoundControls();syncInputActivity();}
function hideSettings(){settingsOpen=false;$('settings').hidden=true;syncInputActivity();}
function showAbout(payload){
 aboutOpen=true;playAbout();$('about-tag').textContent='STUDY AREA · TAFE QUEENSLAND COOMERA';
 $('about-title').textContent=payload.title||'About this study area';
 $('about-body').innerHTML=payload.body||'';
 discoveredAreas=Number.isFinite(payload.discovered)?payload.discovered:discoveredAreas;
 studyAreaTotal=Number.isFinite(payload.total)?payload.total:studyAreaTotal;
 $('about-progress').textContent=`Study areas discovered: ${discoveredAreas} / ${studyAreaTotal}`;
 $('about').hidden=false;syncInputActivity();
}
function hideAbout(){
 aboutOpen=false;$('about').hidden=true;
 dwellState.key=null;dwellState.since=0;$('dwell-dot').hidden=true;
 document.querySelectorAll('.dwelling').forEach(b=>b.classList.remove('dwelling'));
 send('aboutClosed');syncInputActivity();
}
function paintPreview(frame){
 const w=video.videoWidth||640,h=video.videoHeight||360;
 if(overlay.width!==w||overlay.height!==h){overlay.width=w;overlay.height=h;$('camera-viewport').style.aspectRatio=w+' / '+h;}
 ctx.clearRect(0,0,w,h);
 if(!frame?.tracked||frame.stale)return;
 for(const hand of frame.hands){
  if(hand.confidence<.5)continue;
  const colour=hand.side==='left'?'#36f5d0':'#ffe16d';
  ctx.strokeStyle=colour;ctx.fillStyle=colour;ctx.lineWidth=Math.max(2,w/320);
  for(const [a,b] of CONNECTIONS){ctx.beginPath();ctx.moveTo(hand.landmarks[a].x*w,hand.landmarks[a].y*h);ctx.lineTo(hand.landmarks[b].x*w,hand.landmarks[b].y*h);ctx.stroke();}
  for(const p of hand.landmarks){ctx.beginPath();ctx.arc(p.x*w,p.y*h,w/210,0,Math.PI*2);ctx.fill();}
  const text=hand.side.toUpperCase();
  ctx.font='bold '+Math.round(w/42)+'px Segoe UI, sans-serif';
  ctx.fillText(text,Math.max(5,Math.min(w-ctx.measureText(text).width-5,hand.wrist.x*w+8)),Math.min(h-8,Math.max(20,hand.wrist.y*h+25)));
 }
}
async function enumerateCameras(){
 if(!navigator.mediaDevices?.enumerateDevices)return;
 const current=$('camera-select').value,devices=await navigator.mediaDevices.enumerateDevices();
 $('camera-select').replaceChildren(new Option('System default camera',''));
 for(const d of devices.filter(d=>d.kind==='videoinput'))$('camera-select').add(new Option(d.label||'Camera '+$('camera-select').options.length,d.deviceId));
 $('camera-select').value=current;
}
function disposeCamera(){
 generation++;running=false;cameraReady=false;busy=false;clearTimeout(loopTimer);
 if(videoFrameCallback){video.cancelVideoFrameCallback?.(videoFrameCallback);videoFrameCallback=0;}
 trackingDelegate=null;updateAccelerationStatus();
 if(worker){worker.terminate();worker=null;}
 if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
 latestFrame=null;video.srcObject=null;$('cam-dot').classList.remove('live','paused');$('camera-placeholder').hidden=false;
 send('cameraLost');paintPreview(null);
}
function makeWorker(delegate){
 return new Promise((resolve,reject)=>{
  const next=new Worker('tracking/worker.js');
  const watchdog=setTimeout(()=>{next.terminate();reject(Error(delegate+' model initialization timed out'));},delegate==='GPU'?15000:35000);
  next.onerror=event=>{clearTimeout(watchdog);next.terminate();reject(Error(event.message||'Tracking worker failed'));};
  next.onmessage=({data})=>{
   if(data.type==='stage')setCameraStatus(data.text);
   if(data.type==='ready'){clearTimeout(watchdog);next.archeryDelegate=data.delegate;resolve(next);}
   if(data.type==='error'){clearTimeout(watchdog);next.terminate();reject(Error(data.message));}
  };
  next.postMessage({type:'init',delegate});
 });
}
async function startCamera(){
 if(starting)return starting;
 clearInterval(qaTimer);qaTimer=0;
 starting=(async()=>{
  disposeCamera();const token=generation;
  try{
   if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw Error('Open the game through localhost or HTTPS.');
   setCameraStatus('Please allow camera access');
   const device=$('camera-select').value;
   const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30},...(device?{deviceId:{exact:device}}:{facingMode:'user'})}});
   if(token!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
   stream=acquired;video.srcObject=stream;await video.play();
   $('camera-placeholder').hidden=true;
   await enumerateCameras();
   let next;
   try{next=await makeWorker('GPU');}catch(error){setCameraStatus('Loading tracking in compatibility mode');next=await makeWorker('CPU');}
   if(token!==generation){next.terminate();return;}
   worker=next;trackingDelegate=next.archeryDelegate;updateAccelerationStatus();cameraReady=running=true;busy=false;lastVideoTime=-1;lastTrackDispatch=0;consecutiveErrors=0;
   worker.onmessage=({data})=>{
    if(data.type==='result'){
     busy=false;consecutiveErrors=0;trackingFrames++;inferenceMs=data.inferenceMs;
     trackingMessage(normalise(data.result,data.timestamp,swap,video.videoWidth,video.videoHeight));
    }else if(data.type==='dropped'){busy=false;}
    else if(data.type==='error'){
     busy=false;consecutiveErrors++;
     if(consecutiveErrors>=3){const message=readableError(Error(data.message));disposeCamera();setCameraStatus(message,true);showSettings();}
    }
   };
   worker.onerror=event=>{disposeCamera();setCameraStatus(readableError(Error(event.message)),true);showSettings();};
   stream.getVideoTracks()[0].addEventListener('ended',()=>{if(running){disposeCamera();setCameraStatus('Camera disconnected. Please reconnect.',true);showSettings();}});
   refreshCameraStatus();trackLoop();
  }catch(error){
   disposeCamera();setCameraStatus(readableError(error),true);showSettings();throw error;
  }
 })();
 try{return await starting;}finally{starting=null;}
}
async function trackLoop(){
 if(!running)return;
 const cadence=aboutOpen?200:video.requestVideoFrameCallback?0:33;
 // Decode-driven scheduling avoids polling the same camera frame and never queues inference.
 if(video.requestVideoFrameCallback)videoFrameCallback=video.requestVideoFrameCallback(trackLoop);
 else loopTimer=setTimeout(trackLoop,cadence);
 if(busy||!inputActive()||video.readyState<2||video.currentTime===lastVideoTime||performance.now()-lastTrackDispatch<cadence-3)return;
 const token=generation;
 const capturedAt=performance.now();
 busy=true;lastTrackDispatch=capturedAt;lastVideoTime=video.currentTime;
 try{
  const width=640,height=Math.round(video.videoHeight/video.videoWidth*width);
  const bitmap=await createImageBitmap(video,{resizeWidth:width,resizeHeight:height,resizeQuality:'low'});
  if(token!==generation||!worker){bitmap.close();return;}
  worker.postMessage({type:'frame',bitmap,timestamp:capturedAt},[bitmap]);
 }catch(error){busy=false;if(++consecutiveErrors>=3){disposeCamera();setCameraStatus(readableError(error),true);showSettings();}}
}
function updateHud(h){  lastHud=h;updatePerformance(h);
  const learning=h.state==='ready'||h.state==='countdown';
 setText('time',learning?'—':String(Math.floor(Math.ceil(h.seconds)/60)).padStart(2,'0')+':'+String(Math.ceil(h.seconds)%60).padStart(2,'0'));
 setText('time-label',learning?'GET READY':'TIME LEFT');
 setText('arrows',h.arrows);setText('arrow-total',' / '+h.arrowLimit);
 setText('arrow-icons',Array(Math.max(0,h.arrows)).fill('↗').join(' '));
 const targetKind='DRIFTING BALLOONS';
 pointerMode=!!h.pointerMode;
 setText('step-draw',pointerMode?'Aim':'Draw');
 setText('step-aim',pointerMode?'Pop':'Aim');
 setText('step-release',pointerMode?'Discover':'Release');
 discoveredAreas=Number.isFinite(h.discoveredAreas)?h.discoveredAreas:discoveredAreas;
 studyAreaTotal=Number.isFinite(h.studyAreaTotal)?h.studyAreaTotal:studyAreaTotal;
 setText('range-status',(pointerMode?'MOUSE / TOUCH · ':'')+targetKind+' · '+Math.round(h.targetDistance)+' M');
 $('draw-fill').style.width=(h.draw*100)+'%';setText('instruction',h.notice);
 $('reticle').hidden=!(h.nocked&&h.state==='playing');
 $('reticle').style.left=(h.aimX*100)+'%';$('reticle').style.top=(h.aimY*100)+'%';
 $('step-draw').classList.toggle('active',h.nocked&&!h.aiming);
 $('step-aim').classList.toggle('active',h.aiming);
 $('step-release').classList.toggle('active',h.state==='feedback');
 for(const side of ['left','right']){
  $(side+'-status').classList.toggle('on',h[side]);
  $(side+'-status').title=h[side]?side.toUpperCase()+': '+h[side+'Pose']:'Hand not visible';
 }
 $('tracking-pill').classList.toggle('ready',h.tracked);
 $('tracking-pill').querySelector('span').textContent=pointerMode?'Mouse / touch':h.tracked?'Tracking ready':h.state==='paused'?'Tracking paused':'Waiting for hands';
 const gettingReady=h.state==='ready'||h.state==='countdown';
 $('ready-panel').hidden=!gettingReady;$('welcome').hidden=h.state!=='intro';
 $('ready-fill').style.width=(h.progress*100)+'%';
 setText('ready-title',h.state==='countdown'?'Get ready':h.pointerMode?'Ready to explore':'Face the camera');
 setText('ready-copy',h.pointerMode?'Click or tap a balloon to discover a study area.':'Stand on the floor mark, about 1 m away. Hold two fists near your chest with a small visible gap.');
 setText('ready-hint',h.pointerMode?'Five arrows. Five possibilities.':'Starts automatically. Then extend LEFT, draw RIGHT beside your shoulder, hold and release.');
 $('countdown').textContent=h.state==='countdown'?Math.max(1,Math.ceil(h.countdown)):'';
 if(gettingReady&&aboutOpen){aboutOpen=false;$('about').hidden=true;}
 $('result').hidden=h.state!=='complete';
 if(kiosk&&h.state==='complete'&&!kioskRestartTimer){kioskRestartTimer=setTimeout(()=>{kioskRestartTimer=0;send('input:mouse');},4500);}
 if(h.state==='complete'){$('final-score').textContent=h.hits;setText('result-progress',`Study areas discovered: ${discoveredAreas} / ${studyAreaTotal}`);}
 $('paused-banner').hidden=h.state!=='paused';$('paused-banner').textContent=h.notice;
 $('reset-tracking').disabled=pointerMode||!(cameraReady||qaTimer);$('next-player').disabled=!(cameraReady||qaTimer);
 $('unity-canvas').setAttribute('data-state',h.state);$('unity-canvas').setAttribute('data-fps',Math.round(h.fps));
 refreshCameraStatus();
}
window.archeryHost={
 receive(message){
  if(message.type==='hud')updateHud(message);
  else if(message.type==='about')showAbout(message);
  else if(message.type==='shot'){
   playWhoosh();if(message.hit)playPop();
   const node=$('shot-feedback');node.textContent=message.hit?'BALLOON POPPED':'MISS · TRY AGAIN';node.classList.remove('show');void node.offsetWidth;node.classList.add('show');
  }
 },
 get hud(){return lastHud;},
 get diagnostics(){return {running,busy,trackingFrames,trackingRate,inferenceMs,trackingDelegate,graphicsRenderer,renderScale:currentRenderScale,resolution:[$('unity-canvas').width,$('unity-canvas').height],visibility:document.visibilityState,focused:document.hasFocus()};}
};
// A short hands-ready hold starts the round. Every arrow learns its own starting pose.
function startRound(){resetQaPose();send('start');}
async function begin(){
 if(!unityReady)return;
 $('start').disabled=true;$('start').textContent='Connecting camera…';
 try{
  if(!cameraReady)await startCamera();
  if(!cameraReady)return;
   hideSettings();startRound();
 }catch(error){console.warn('[Archery camera]',error.message);}
 finally{$('start').disabled=false;$('start').textContent='Enable camera ↗';}
}
document.addEventListener('pointerdown',unlockAudio,{once:false,passive:true});
document.addEventListener('keydown',unlockAudio,{once:false,passive:true});
$('start').onclick=begin;
$('fallback-start').onclick=()=>{unlockAudio();send('input:mouse');};

$('again').onclick=()=>{if(pointerMode)send('input:mouse');else if(qaTimer||cameraReady)startRound();else begin();};
$('settings-button').onclick=showSettings;$('close-settings').onclick=hideSettings;$('about-close').onclick=hideAbout;
$('sound-enabled').onchange=event=>{soundEnabled=event.target.checked;localStorage.setItem('tafe-archery-sound',soundEnabled?'on':'off');if(soundEnabled){unlockAudio();playAbout();}};
$('sound-volume').oninput=event=>{soundVolume=Math.max(0,Math.min(1,Number(event.target.value)));localStorage.setItem('tafe-archery-volume',String(soundVolume));$('sound-volume-value').textContent=Math.round(soundVolume*100)+'%';};
updateSoundControls();
$('retry-camera').onclick=async()=>{
 const button=$('retry-camera');button.disabled=true;
 try{await startCamera();hideSettings();if(lastHud?.state==='intro')startRound();}catch(error){console.warn(error.message);}finally{button.disabled=false;}
};
$('reset-tracking').onclick=()=>{resetQaPose();hideSettings();send('resetTracking');};
$('next-player').onclick=()=>{resetQaPose();hideSettings();send('nextPlayer');};
$('swap-hands').onchange=()=>{swap=$('swap-hands').checked;send('cameraLost');};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('game').requestFullscreen();}catch(error){console.warn(error.message);}};
document.addEventListener('visibilitychange',syncInputActivity);
window.addEventListener('blur',syncInputActivity);
window.addEventListener('focus',syncInputActivity);
window.addEventListener('pagehide',()=>{clearInterval(qaTimer);qaTimer=0;disposeCamera();});
navigator.mediaDevices?.addEventListener?.('devicechange',()=>enumerateCameras().catch(()=>{}));
// Test controls create complete image/world poses and travel through the production gesture state.
function fakeHand(side,x,y,relaxed=false,size=1,closedAngle=90){
 const world=[{x:0,y:0,z:0}];
 for(let f=0;f<5;f++)for(let j=0;j<4;j++){
  const px=f===0?-.035:(f-2.5)*.018;
  const angle=(relaxed&&f>=1&&f<=2?145:closedAngle)*Math.PI/180;
  world.push({x:px,y:j===0?-.055:j===1?-.09:-.09+Math.cos(angle)*.028*(j-1),z:j<2?0:-Math.sin(angle)*.028*(j-1)});
 }
 const landmarks=world.map(p=>({x:x+p.x*size/(16/9),y:y+p.y*size,z:p.z*size}));
 return {side,wrist:landmarks[0],landmarks,worldLandmarks:world,indexTip:landmarks[8],thumbTip:landmarks[4],handScale:.055*size,pinchRatio:1,confidence:.99};
}
function resetQaPose(){qaMissing=false;qaAction='neutral';qaPull=0;qaAim={x:.5,y:.5};$('qa-drop').textContent='Hide hands';}
function startQa(){
 clearInterval(qaTimer);disposeCamera();resetQaPose();qaLastTick=performance.now();
 $('camera-placeholder').hidden=true;setCameraStatus('Synthetic hands · QA');send('visible');startRound();
 qaTimer=setInterval(()=>{
  if(!inputActive())return;
  const now=performance.now(),dt=Math.min(100,now-qaLastTick);qaLastTick=now;
  let open=false;
  if(qaAction==='draw')qaPull=Math.max(0,Math.min(1,(now-qaNockAt-450)/650));
  else if(qaAction==='release'){
   open=true;
   if(now-qaReleaseAt>400){qaPull=0;qaAim={x:.5,y:.5};}
  }else{qaPull=0;}
  const x=.42-.035*qaPull+(qaAim.x-.5)/2.6,y=.57-.02*qaPull+(qaAim.y-.5)/2.6;
  const grip=qaGripVariation?129:90,drift=qaGripVariation&&qaAction==='draw'&&qaPull>0?4*Math.sin(now/130):0;
  const frame={timestamp:Math.round(now),imageWidth:1280,imageHeight:720,tracked:!qaMissing,stale:false,
   hands:qaMissing?[]:[fakeHand('left',x,y,qaGripVariation&&lastHud?.aiming,1,grip),fakeHand('right',.52+.065*qaPull,.57-.065*qaPull,open,1-.15*qaPull,grip+drift)]};
  // Exercise the same detector-label and preview-mirroring boundary used by webcam frames.
  const detector={landmarks:frame.hands.map(h=>h.landmarks.map(p=>({...p,x:1-p.x}))),
   worldLandmarks:frame.hands.map(h=>h.worldLandmarks.map(p=>({...p,x:-p.x}))),
   handedness:frame.hands.map(h=>[{categoryName:h.side==='left'?'Left':'Right',score:h.confidence}])};
  trackingMessage(normalise(detector,frame.timestamp,swap,frame.imageWidth,frame.imageHeight));
 },33);
}
if(qa){
 $('qa-controls').hidden=false;$('qa-start').onclick=startQa;
 $('qa-grip').onclick=()=>{qaGripVariation=!qaGripVariation;$('qa-grip').textContent='Grip variation: '+(qaGripVariation?'ON':'OFF');};
 $('qa-neutral').onclick=resetQaPose;
 $('qa-draw').onclick=()=>{qaAction='draw';qaNockAt=performance.now();qaAim={x:.5,y:.5};};
 $('qa-release').onclick=()=>{qaAction='release';qaReleaseAt=performance.now();};
 $('qa-drop').onclick=()=>{qaMissing=!qaMissing;if(!qaMissing)resetQaPose();$('qa-drop').textContent=qaMissing?'Restore hands':'Hide hands';};
 $('qa-dwell').onclick=()=>{qaDwellAtCursor=!qaDwellAtCursor;$('qa-dwell').textContent='Dwell at cursor: '+(qaDwellAtCursor?'ON':'OFF');};
 document.addEventListener('pointermove',e=>{qaCursor={x:e.clientX/innerWidth,y:e.clientY/innerHeight};});
 $('qa-time').onclick=()=>unity?.SendMessage('ArcheryPrototype','OnQaAdvance','300');
}
 $('unity-canvas').addEventListener('pointermove',event=>{
  if(!pointerMode||!lastHud||lastHud.state!=='playing'||aboutOpen)return;
  const rect=$('unity-canvas').getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;
  $('reticle').hidden=false;$('reticle').style.left=(x*100)+'%';$('reticle').style.top=(y*100)+'%';
});
$('unity-canvas').addEventListener('pointerdown',event=>{
  const rect=$('unity-canvas').getBoundingClientRect();
  if(pointerMode&&lastHud?.state==='playing'&&!aboutOpen){
   send('pointer:'+((event.clientX-rect.left)/rect.width).toFixed(4)+','+((event.clientY-rect.top)/rect.height).toFixed(4));return;
  }
  if(!qa||qaAction!=='draw'||!lastHud?.aiming)return;
  qaAim={x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height};
 });
async function boot(){
 try{
  resizeGame();
  new ResizeObserver(()=>resizeGame()).observe($('game'));
  window.addEventListener('resize',()=>resizeGame());
  unity=await createUnityInstance($('unity-canvas'),{...window.archeryUnityConfig,matchWebGLToCanvasSize:false,showBanner:(message,type)=>{
   if(type==='error')$('load-status').textContent='Game loading failed: '+message;
  }},progress=>{$('loading-fill').style.width=(progress*100)+'%';$('load-status').textContent='Preparing the range '+Math.round(progress*100)+'%';});
  for(const command of pending)send(command);pending.length=0;
  const gl=$('unity-canvas').getContext('webgl2')||$('unity-canvas').getContext('webgl');
  if(gl){const debug=gl.getExtension('WEBGL_debug_renderer_info');graphicsRenderer=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}
  updateAccelerationStatus();
  if(qa)send('qa');
  unityReady=true;document.body.classList.add('loaded');document.body.classList.toggle('kiosk',kiosk);$('performance-pill').hidden=!perf;$('start').disabled=false;sendDemoConfig();if(kiosk)send('input:mouse');
 $('start').textContent='Enable camera ↗'; $('load-status').textContent='v'+window.archeryUnityConfig.productVersion+' · Face the camera · No calibration';
 }catch(error){$('load-status').textContent='Game loading failed. Please refresh. '+error.message;console.error(error);}
}
if(window.archeryUnityConfig)boot();else window.addEventListener('archery-config',boot,{once:true});


