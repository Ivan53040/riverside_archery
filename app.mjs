
import {normalise,CONNECTIONS} from './tracking/normalise.mjs';
const $=id=>document.getElementById(id),video=$('camera-video'),overlay=$('camera-overlay'),ctx=overlay.getContext('2d');
const qa=new URLSearchParams(location.search).get('qa')==='1';
let unity=null,unityReady=false,worker=null,stream=null,cameraReady=false,busy=false,running=false,loopTimer=0;
let starting=null,generation=0,lastVideoTime=-1,latestFrame=null,swap=false,settingsOpen=false,difficultyOpen=false;
let inputChangedAt=0,inputWasActive=null;
let qaGripVariation=false;
let consecutiveErrors=0,lastHud=null,qaTimer=0,qaMissing=false,qaAction="neutral",qaNockAt=0,qaReleaseAt=0,qaPull=0,qaLastTick=0,qaAim={x:.5,y:.5},trackingFrames=0,inferenceMs=0;
const pending=[];
function send(command){if(unity)unity.SendMessage('ArcheryPrototype','OnCommand',command);else pending.push(command);}
function inputActive(){return !document.hidden&&document.hasFocus()&&!settingsOpen;}
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
 $('camera-hint').textContent=active?'Both hands visible · Good light · About 1 m':'Click the game to resume tracking.';
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
function showSettings(){settingsOpen=true;$('settings').hidden=false;syncInputActivity();}
function hideSettings(){settingsOpen=false;$('settings').hidden=true;syncInputActivity();}
function showDifficulty(){difficultyOpen=true;$('difficulty').hidden=false;$('welcome').hidden=true;$('result').hidden=true;syncInputActivity();}
function hideDifficulty(){difficultyOpen=false;$('difficulty').hidden=true;syncInputActivity();}
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
   if(data.type==='ready'){clearTimeout(watchdog);resolve(next);}
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
   const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30},...(device?{deviceId:{exact:device}}:{facingMode:'user'})}});
   if(token!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
   stream=acquired;video.srcObject=stream;await video.play();
   $('camera-placeholder').hidden=true;
   await enumerateCameras();
   let next;
   try{next=await makeWorker('GPU');}catch(error){setCameraStatus('Loading tracking in compatibility mode');next=await makeWorker('CPU');}
   if(token!==generation){next.terminate();return;}
   worker=next;cameraReady=running=true;busy=false;lastVideoTime=-1;consecutiveErrors=0;
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
 loopTimer=setTimeout(trackLoop,33);
 if(busy||!inputActive()||video.readyState<2||video.currentTime===lastVideoTime)return;
 const token=generation;
 busy=true;lastVideoTime=video.currentTime;
 try{
  const width=640,height=Math.round(video.videoHeight/video.videoWidth*width);
  const bitmap=await createImageBitmap(video,{resizeWidth:width,resizeHeight:height,resizeQuality:'low'});
  if(token!==generation||!worker){bitmap.close();return;}
  worker.postMessage({type:'frame',bitmap,timestamp:performance.now()},[bitmap]);
 }catch(error){busy=false;if(++consecutiveErrors>=3){disposeCamera();setCameraStatus(readableError(error),true);showSettings();}}
}
function updateHud(h){
 lastHud=h;
 const learning=(h.state==='calibrating'||h.state==='countdown')&&!h.tutorialComplete;
 $('time').textContent=String(Math.floor(Math.ceil(h.seconds)/60)).padStart(2,'0')+':'+String(Math.ceil(h.seconds)%60).padStart(2,'0');
 $('time-label').textContent=learning?'TUTORIAL':'TIME LEFT';if(learning)$('time').textContent='—';
 $('score').textContent=String(h.score).padStart(2,'0');$('arrows').textContent=h.infiniteArrows?'∞':h.arrows;
 $('arrow-total').textContent=h.infiniteArrows?'':' / '+h.arrowLimit;
 $('arrow-icons').textContent=h.infiniteArrows?'∞':Array(Math.max(0,h.arrows)).fill('↗').join(' ');$('best').textContent=h.best;
 const targetKind=h.movingTarget?(h.respawnOnHit?'MOVING · RESPAWNS':'MOVING TARGET'):'STATIONARY TARGET';
 $('range-status').textContent=h.difficulty.toUpperCase()+' · '+targetKind+' · '+Math.round(h.targetDistance)+' M';
 $('draw-fill').style.width=(h.draw*100)+'%';$('instruction').textContent=h.notice;
 $('reticle').hidden=!(h.nocked&&(h.state==='playing'||h.practicing));
 $('reticle').style.left=(h.aimX*100)+'%';$('reticle').style.top=(h.aimY*100)+'%';
 $('step-draw').classList.toggle('active',h.nocked&&!h.aiming);
 $('step-aim').classList.toggle('active',h.aiming);
 $('step-release').classList.toggle('active',h.state==='feedback');
 for(const side of ['left','right']){
  $(side+'-status').classList.toggle('on',h[side]);
  $(side+'-status').title=h[side]?side.toUpperCase()+': '+h[side+'Pose']:'Hand not visible';
 }
 $('tracking-pill').classList.toggle('ready',h.tracked);
 $('tracking-pill').querySelector('span').textContent=h.tracked?'Tracking ready':h.state==='paused'?'Tracking paused':'Waiting for hands';
 const calibrating=h.state==='calibrating'||h.state==='countdown';
 $('calibration').hidden=!calibrating||difficultyOpen;$('welcome').hidden=h.state!=='intro'||difficultyOpen;
 $('calibration-fill').style.width=(h.progress*100)+'%';
 const lessons={
  Stance:['Turn about 30°','Stand about 1 m away. Turn slightly to keep both hands visible. Use empty hands; 30° is a guide.',0],
  Hands:['Bring your fists together','Close both hands near your chest, leaving a small visible gap. Match LEFT and RIGHT in the mirrored preview.',1],
  Draw:['Push, draw and hold','Push your LEFT fist forward. Pull your RIGHT fist back beside your cheek. Keep both closed and hold the pose.',2],
  Return:['Return to the start','Bring both closed fists close together again. Your comfortable draw distance is now saved.',1],
  Practice:h.aiming?['Aim, then release','Move your LEFT fist to aim at the centre target. Keep it steady and unfold your RIGHT index and middle fingers to shoot.',3]:['Try your first shot','Bring your fists together to load. Push LEFT forward, pull RIGHT back and hold. Hit the centre target to finish the tutorial.',h.nocked?2:1],
  Success:['Nice shot!','Tutorial complete. Bring your fists together for '+h.difficulty+' mode.',3],
  Complete:['Get ready','Keep your fists together. The round starts after the countdown: '+Math.round(h.duration)+' seconds and '+(h.infiniteArrows?'unlimited arrows':h.arrowLimit+' arrows')+'.',1]
 };
 const lesson=lessons[h.tutorialStage]||lessons.Stance;
 $('calibration-title').textContent=lesson[0];
 $('calibration-copy').textContent=lesson[1];
 $('tutorial-art').style.backgroundPosition=(lesson[2]%2*100)+'% '+(Math.floor(lesson[2]/2)*100)+'%';
 $('tutorial-art').setAttribute('aria-label',lesson[1]);
 $('stance-badge').hidden=h.tutorialStage!=='Stance';$('tutorial-ready').hidden=h.tutorialStage!=='Stance';
 $('tutorial-note').textContent=h.tutorialComplete?'Calibration saved · Ready for the round':'Unlimited practice · No timer · No arrows used';
 $('calibration-fill').parentElement.hidden=!['Hands','Draw','Return'].includes(h.tutorialStage);
 const stages=['Stance','Hands','Draw','Return','Practice','Success','Complete'],stageIndex=stages.indexOf(h.tutorialStage);
 for(const node of document.querySelectorAll('[data-stage]')){
  const index=stages.indexOf(node.dataset.stage);node.classList.toggle('active',index===stageIndex);node.classList.toggle('done',index<stageIndex);
 }
 $('countdown').textContent=h.state==='countdown'?Math.max(1,Math.ceil(h.countdown)):'';
 $('result').hidden=h.state!=='complete'||difficultyOpen;
 if(h.state==='complete'){
  $('result-mode').textContent=h.difficulty.toUpperCase();$('final-score').textContent=h.score;
  $('final-total').hidden=h.infiniteArrows;$('final-total').textContent='/ '+(h.arrowLimit*10);
  $('final-hits').textContent=h.infiniteArrows?String(h.hits):h.hits+' / '+h.arrowLimit;$('final-best').textContent=h.best;
 }
 $('paused-banner').hidden=h.state!=='paused';$('paused-banner').textContent=h.notice;
 $('recalibrate').disabled=!(cameraReady||qaTimer);
 $('unity-canvas').setAttribute('data-state',h.state);$('unity-canvas').setAttribute('data-fps',Math.round(h.fps));
 refreshCameraStatus();
}
window.archeryHost={
 receive(message){
  if(message.type==='hud')updateHud(message);
  else if(message.type==='shot'){
   const node=$('shot-feedback');node.textContent=message.practice?(message.hit?'PRACTICE HIT':'TRY AGAIN'):(message.hit?'+'+message.points+'  HIT':'MISS · NEXT SHOT');node.classList.remove('show');void node.offsetWidth;node.classList.add('show');
  }
 },
 get hud(){return lastHud;},
 get diagnostics(){return {running,busy,trackingFrames,inferenceMs,visibility:document.visibilityState,focused:document.hasFocus()};}
};
async function begin(){
 if(!unityReady)return;
 $('start').disabled=true;$('start').textContent='Connecting camera…';
 try{
  if(!cameraReady)await startCamera();
  if(!cameraReady)return;
   hideSettings();showDifficulty();
 }catch(error){console.warn('[Archery camera]',error.message);}
 finally{$('start').disabled=false;$('start').textContent='Enable camera ↗';}
}
$('start').onclick=begin;
 $('tutorial-ready').onclick=()=>send('tutorial-ready');
$('again').onclick=()=>{resetQaPose();if(qaTimer||cameraReady)showDifficulty();else begin();};
for(const option of document.querySelectorAll('.mode-option'))option.onclick=()=>{resetQaPose();hideDifficulty();send('mode:'+option.dataset.mode);};
$('settings-button').onclick=showSettings;$('close-settings').onclick=hideSettings;
$('retry-camera').onclick=async()=>{
 const button=$('retry-camera');button.disabled=true;
 try{await startCamera();hideSettings();if(lastHud?.state==='intro'||lastHud?.state==='complete')showDifficulty();}catch(error){console.warn(error.message);}finally{button.disabled=false;}
};
$('recalibrate').onclick=()=>{resetQaPose();hideSettings();send('recalibrate');};
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
 $('camera-placeholder').hidden=true;setCameraStatus('Synthetic hands · QA');send('visible');showDifficulty();
 qaTimer=setInterval(()=>{
  if(!inputActive())return;
  const now=performance.now(),dt=Math.min(100,now-qaLastTick);qaLastTick=now;
  let open=false;
  if(lastHud?.state==='calibrating'&&!lastHud.calibrated){
   const desired=lastHud.calibrationStage==='Draw'?1:0;
   qaPull+=Math.max(-dt/650,Math.min(dt/650,desired-qaPull));qaAim={x:.5,y:.5};qaAction='neutral';
  }else if(qaAction==='draw')qaPull=Math.max(0,Math.min(1,(now-qaNockAt-450)/650));
  else if(qaAction==='release'){
   open=true;
   if(now-qaReleaseAt>400){qaPull=0;qaAim={x:.5,y:.5};}
  }else{qaPull=0;}
  const x=.37-.10*qaPull+(qaAim.x-.5)/2.6,y=.57-.025*qaPull+(qaAim.y-.5)/2.6;
  const grip=qaGripVariation?129:90,drift=qaGripVariation&&qaAction==='draw'&&qaPull>0?4*Math.sin(now/130):0;
  const frame={timestamp:Math.round(now),imageWidth:1280,imageHeight:720,tracked:!qaMissing,stale:false,
   hands:qaMissing?[]:[fakeHand('left',x,y,qaGripVariation&&lastHud?.aiming,1,grip),fakeHand('right',.47+.23*qaPull,.57-.08*qaPull,open,1-.15*qaPull,grip+drift)]};
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
 $('qa-time').onclick=()=>unity?.SendMessage('ArcheryPrototype','OnQaAdvance','300');
 $('unity-canvas').addEventListener('pointerdown',event=>{
  if(qaAction!=='draw'||!lastHud?.aiming)return;
  const rect=$('unity-canvas').getBoundingClientRect();qaAim={x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height};
 });
}
async function boot(){
 try{
  unity=await createUnityInstance($('unity-canvas'),{...window.archeryUnityConfig,showBanner:(message,type)=>{
   if(type==='error')$('load-status').textContent='Game loading failed: '+message;
  }},progress=>{$('loading-fill').style.width=(progress*100)+'%';$('load-status').textContent='Preparing the range '+Math.round(progress*100)+'%';});
  for(const command of pending)send(command);pending.length=0;
  if(qa)send('qa');
  unityReady=true;document.body.classList.add('loaded');$('start').disabled=false;
 $('start').textContent='Enable camera ↗';$('load-status').textContent='v'+window.archeryUnityConfig.productVersion+' · Four modes · Guided calibration';
 }catch(error){$('load-status').textContent='Game loading failed. Please refresh. '+error.message;console.error(error);}
}
if(window.archeryUnityConfig)boot();else window.addEventListener('archery-config',boot,{once:true});


