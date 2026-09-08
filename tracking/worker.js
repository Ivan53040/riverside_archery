// Classic worker: MediaPipe's WASM bootstrap can use importScripts; ESM is imported dynamically.
let task=null,working=false;
async function loadModel(){
 const response=await fetch(new URL('./vendor/hand_landmarker.task',self.location));
 if(!response.ok)throw Error('Hand model download failed ('+response.status+')');
 const total=Number(response.headers.get('content-length'))||0;
 if(!response.body)return new Uint8Array(await response.arrayBuffer());
 const reader=response.body.getReader(),chunks=[];let received=0,lastPercent=-1;
 while(true){
  const {value,done}=await reader.read();if(done)break;
  chunks.push(value);received+=value.byteLength;
  const percent=total?Math.min(100,Math.floor(received/total*100)):-1;
  if(percent!==lastPercent||!total){
   self.postMessage({type:'stage',text:total?'Loading hand model '+percent+'%':'Loading hand model '+(received/1048576).toFixed(1)+' MB'});
   lastPercent=percent;
  }
 }
 const bytes=new Uint8Array(received);let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return bytes;
}
self.onmessage=async({data})=>{
 if(data.type==='init'){
  try{
   self.postMessage({type:'stage',text:'Loading tracking engine'});
   const {HandLandmarker,FilesetResolver}=await import('./vendor/vision_bundle.mjs');
   const files=await FilesetResolver.forVisionTasks(new URL('./vendor/',self.location).href);
   const model=await loadModel();
   self.postMessage({type:'stage',text:'Starting two-hand tracking'});
   const options={baseOptions:{modelAssetBuffer:model,delegate:data.delegate||'GPU'},
    runningMode:'VIDEO',numHands:2,minHandDetectionConfidence:.60,minHandPresenceConfidence:.60,minTrackingConfidence:.60};
   task=await HandLandmarker.createFromOptions(files,options);
   self.postMessage({type:'ready',delegate:options.baseOptions.delegate});
  }catch(error){self.postMessage({type:'error',message:error.message||String(error),init:true});}
  return;
 }
 if(data.type==='frame'){
  if(!task||working){data.bitmap?.close();self.postMessage({type:'dropped'});return;}
  working=true;
  try{
   const start=performance.now(),result=task.detectForVideo(data.bitmap,data.timestamp);
   self.postMessage({type:'result',result,timestamp:data.timestamp,inferenceMs:performance.now()-start});
  }catch(error){self.postMessage({type:'error',message:error.message||String(error)});}
  finally{data.bitmap.close();working=false;}
 }
};


