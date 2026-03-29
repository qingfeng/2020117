/**
 * Beam avatar generator — a TypeScript reimplementation of boring-avatars beam variant (MIT)
 * Produces deterministic SVG avatars from a seed string (pubkey/username).
 */

const COLORS = ['#92A1C6', '#146A7C', '#F0AB3D', '#C271B4', '#C20D90']

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

function getUnit(n: number, range: number, index: number): number {
  const v = n % (range * (index + 1))
  return index % 2 === 0 ? v : -v
}

function getColor(n: number): string {
  return COLORS[Math.abs(n) % COLORS.length]
}

function getContrast(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? '#000' : '#fff'
}

export function beamSvg(seed: string, sizePx = 40): string {
  const n = hashCode(seed)
  const S = 36
  const cx = S / 2

  const backgroundColor = getColor(n + 13)
  const wrapColor       = getColor(n)
  const faceColor       = getContrast(getColor(n))
  const wrapRotation    = getUnit(n, 360, 0)
  const wrapTranslateX  = getUnit(n, 8, 1)
  const wrapTranslateY  = getUnit(n, 8, 2)
  const eyeSpread       = getUnit(n, 5, 3)
  const mouthSpread     = getUnit(n, 3, 4)
  const faceRotate      = getUnit(n, 10, 5)
  const faceTranslateX  = getUnit(n, 4, 6) > 2 ? getUnit(n, 4, 6) : getUnit(n, 2, 7) + 1
  const faceTranslateY  = getUnit(n, 4, 8) > 2 ? getUnit(n, 4, 8) : getUnit(n, 2, 9) + 1
  const isMouthOpen     = getUnit(n, 2, 10) > 0

  const mouthPath = isMouthOpen
    ? `M15 ${19 + mouthSpread}c2 1 4 1 6 0`
    : `M13 ${19 + mouthSpread}c2-1 4-1 6 0M13 ${19 + mouthSpread}c2 1 4 1 6 0`

  const id = `ba${n & 0xffff}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${sizePx}" height="${sizePx}" fill="none">`
    + `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${S}" height="${S}">`
    + `<rect width="${S}" height="${S}" rx="${S * 2}" fill="#fff"/></mask>`
    + `<g mask="url(#${id})">`
    + `<rect width="${S}" height="${S}" fill="${backgroundColor}"/>`
    + `<rect x="0" y="0" width="${S}" height="${S}" transform="translate(${wrapTranslateX} ${wrapTranslateY}) rotate(${wrapRotation} ${cx} ${cx})" fill="${wrapColor}" rx="6"/>`
    + `<g transform="translate(${faceTranslateX} ${faceTranslateY}) rotate(${faceRotate} ${cx} ${cx})">`
    + `<path d="${mouthPath}" stroke="${faceColor}" fill="none" stroke-linecap="round"/>`
    + `<rect x="${cx - 1 - eyeSpread}" y="14" width="1.5" height="2" rx="1" fill="${faceColor}"/>`
    + `<rect x="${cx + eyeSpread}" y="14" width="1.5" height="2" rx="1" fill="${faceColor}"/>`
    + `</g></g></svg>`
}

/** Returns a data: URI suitable for use in <img src="..."> */
export function beamDataUri(seed: string, sizePx = 40): string {
  return `data:image/svg+xml,${encodeURIComponent(beamSvg(seed, sizePx))}`
}

/**
 * Inline JS snippet for client-side use (paste into <script> blocks).
 * Provides: beamAvatar(seed, size?) → data: URI string
 */
export const BEAM_AVATAR_JS = `function beamAvatar(seed,size){
const C=['#92A1C6','#146A7C','#F0AB3D','#C271B4','#C20D90'];
let h=0;for(let i=0;i<seed.length;i++){h=((h<<5)-h+seed.charCodeAt(i))|0}h=Math.abs(h);
const u=(n,r,i)=>{const v=n%(r*(i+1));return i%2===0?v:-v};
const col=n=>C[Math.abs(n)%5];
const ctr=hex=>{const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return(r*299+g*587+b*114)/1000>=128?'#000':'#fff'};
const S=36,cx=18,bg=col(h+13),wc=col(h),fc=ctr(col(h));
const wx=u(h,8,1),wy=u(h,8,2),wr=u(h,360,0);
const es=u(h,5,3),ms=u(h,3,4),fr=u(h,10,5);
const fx=u(h,4,6)>2?u(h,4,6):u(h,2,7)+1,fy=u(h,4,8)>2?u(h,4,8):u(h,2,9)+1;
const open=u(h,2,10)>0;
const id='ba'+(h&65535);
const mp=open?'M15 '+(19+ms)+'c2 1 4 1 6 0':'M13 '+(19+ms)+'c2-1 4-1 6 0M13 '+(19+ms)+'c2 1 4 1 6 0';
const sz=size||40;
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="'+sz+'" height="'+sz+'" fill="none"><mask id="'+id+'" maskUnits="userSpaceOnUse" x="0" y="0" width="36" height="36"><rect width="36" height="36" rx="72" fill="#fff"/></mask><g mask="url(#'+id+')" ><rect width="36" height="36" fill="'+bg+'"/><rect x="0" y="0" width="36" height="36" transform="translate('+wx+' '+wy+') rotate('+wr+' '+cx+' '+cx+')" fill="'+wc+'" rx="6"/><g transform="translate('+fx+' '+fy+') rotate('+fr+' '+cx+' '+cx+')"><path d="'+mp+'" stroke="'+fc+'" fill="none" stroke-linecap="round"/><rect x="'+(cx-1-es)+'" y="14" width="1.5" height="2" rx="1" fill="'+fc+'"/><rect x="'+(cx+es)+'" y="14" width="1.5" height="2" rx="1" fill="'+fc+'"/></g></g></svg>';
return 'data:image/svg+xml,'+encodeURIComponent(svg);
}`
