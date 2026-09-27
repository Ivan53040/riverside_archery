// Keep UI at native resolution; spend the pixel budget on the 3D scene separately.
export function renderScale(width,height,deviceScale=1,tier=0){
 const budget=2560*1440;
 const quality=[1,.85,.7][Math.max(0,Math.min(2,tier))];
 return Math.min(deviceScale,1.5,Math.sqrt(budget/Math.max(1,width*height)))*quality;
}
