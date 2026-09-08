export const CONNECTIONS=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const complete=points=>Array.isArray(points)&&points.length===21&&points.every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.z));
export function normalise(result,timestamp,swap=false,imageWidth=1280,imageHeight=720) {
 const aspect=imageWidth/imageHeight;
 const distance=(a,b)=>Math.hypot((a.x-b.x)*aspect,a.y-b.y);
 const hands=(result.landmarks||[]).flatMap((landmarks,i)=>{
  const world=result.worldLandmarks?.[i],label=result.handedness?.[i]?.[0];
  if(!complete(landmarks)||!complete(world))return [];
  // Keep the detector's hand labels. Mirroring the preview must not exchange the player's hand roles.
  let side=label?.categoryName==='Left'?'left':label?.categoryName==='Right'?'right':'';
  if(swap)side=side==='left'?'right':side==='right'?'left':'';
  if(!side)return [];
  const points=landmarks.map(p=>({x:1-p.x,y:p.y,z:p.z}));
  // World landmarks describe the shape of each hand, not its distance from the webcam.
  const worldLandmarks=world.map(p=>({x:-p.x,y:p.y,z:p.z}));
  const wrist=points[0],scale=Math.max(.0001,distance(points[0],points[9]),distance(points[5],points[17]));
  return [{side,wrist,thumbTip:points[4],indexTip:points[8],landmarks:points,worldLandmarks,handScale:scale,
   pinchRatio:distance(points[4],points[8])/scale,confidence:label.score||0}];
 });
 const unique=new Set(hands.map(h=>h.side)).size===hands.length;
 return {timestamp:Math.round(timestamp),imageWidth,imageHeight,tracked:unique&&hands.length>0,stale:false,hands:unique?hands:[]};
}
