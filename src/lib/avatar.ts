/**
 * Beam avatar generator — TypeScript port of boring-avatars beam variant (MIT)
 * https://github.com/boringdesigners/boring-avatars
 */

const COLORS = ['#92A1C6', '#146A7C', '#F0AB3D', '#C271B4', '#C20D90']
const SIZE = 36

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

function getDigit(n: number, pos: number): number {
  return Math.floor((n / Math.pow(10, pos)) % 10)
}

function getBoolean(n: number, pos: number): boolean {
  return (getDigit(n, pos) % 2) === 0
}

function getUnit(n: number, range: number, index?: number): number {
  const value = n % range
  if (index && (getDigit(n, index) % 2) === 0) return -value
  return value
}

function getColor(n: number): string {
  return COLORS[n % COLORS.length]
}

function getContrast(hex: string): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? '#000000' : '#FFFFFF'
}

export function beamSvg(seed: string, sizePx = 40): string {
  const n = hashCode(seed)
  const S = SIZE
  const cx = S / 2 // 18

  const wrapperColor    = getColor(n)
  const backgroundColor = getColor(n + 13)
  const faceColor       = getContrast(wrapperColor)

  const preTranslateX   = getUnit(n, 10, 1)
  const wrapTranslateX  = preTranslateX < 5 ? preTranslateX + S / 9 : preTranslateX
  const preTranslateY   = getUnit(n, 10, 2)
  const wrapTranslateY  = preTranslateY < 5 ? preTranslateY + S / 9 : preTranslateY
  const wrapRotate      = getUnit(n, 360)          // no index → always positive
  const wrapScale       = 1 + getUnit(n, S / 12) / 10 // S/12=3 → scale 1.0–1.2
  const isCircle        = getBoolean(n, 1)
  const isMouthOpen     = getBoolean(n, 2)
  const eyeSpread       = getUnit(n, 5)             // no index → always positive
  const mouthSpread     = getUnit(n, 3)             // no index → always positive
  const faceRotate      = getUnit(n, 10, 3)
  const faceTranslateX  = wrapTranslateX > S / 6 ? wrapTranslateX / 2 : getUnit(n, 8, 1)
  const faceTranslateY  = wrapTranslateY > S / 6 ? wrapTranslateY / 2 : getUnit(n, 7, 2)

  const wrapRx = isCircle ? S : S / 6
  const id = `ba${n & 0xffff}`

  const mouth = isMouthOpen
    ? `<path d="M15 ${19 + mouthSpread}c2 1 4 1 6 0" stroke="${faceColor}" fill="none" stroke-linecap="round"/>`
    : `<path d="M13,${19 + mouthSpread} a1,0.75 0 0,0 10,0" fill="${faceColor}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${sizePx}" height="${sizePx}" fill="none">`
    + `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${S}" height="${S}">`
    + `<rect width="${S}" height="${S}" rx="${S * 2}" fill="#fff"/></mask>`
    + `<g mask="url(#${id})">`
    + `<rect width="${S}" height="${S}" fill="${backgroundColor}"/>`
    + `<rect x="0" y="0" width="${S}" height="${S}" transform="translate(${wrapTranslateX} ${wrapTranslateY}) rotate(${wrapRotate} ${cx} ${cx}) scale(${wrapScale})" fill="${wrapperColor}" rx="${wrapRx}"/>`
    + `<g transform="translate(${faceTranslateX} ${faceTranslateY}) rotate(${faceRotate} ${cx} ${cx})">`
    + mouth
    + `<rect x="${14 - eyeSpread}" y="14" width="1.5" height="2" rx="1" fill="${faceColor}"/>`
    + `<rect x="${20 + eyeSpread}" y="14" width="1.5" height="2" rx="1" fill="${faceColor}"/>`
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
const S=36,cx=18;
const dig=(n,p)=>Math.floor((n/Math.pow(10,p))%10);
const bool=(n,p)=>(dig(n,p)%2)===0;
const unit=(n,r,i)=>{const v=n%r;return(i&&(dig(n,i)%2)===0)?-v:v};
const col=n=>C[n%5];
const ctr=hex=>{const s=hex.startsWith('#')?hex.slice(1):hex;const r=parseInt(s.slice(0,2),16),g=parseInt(s.slice(2,4),16),b=parseInt(s.slice(4,6),16);return(r*299+g*587+b*114)/1000>=128?'#000000':'#FFFFFF'};
const wc=col(h),bg=col(h+13),fc=ctr(wc);
const ptx=unit(h,10,1),wx=ptx<5?ptx+S/9:ptx;
const pty=unit(h,10,2),wy=pty<5?pty+S/9:pty;
const wr=unit(h,360),ws=1+unit(h,3)/10;
const circ=bool(h,1),openM=bool(h,2);
const es=unit(h,5),ms=unit(h,3),fr=unit(h,10,3);
const ftx=wx>S/6?wx/2:unit(h,8,1),fty=wy>S/6?wy/2:unit(h,7,2);
const rx=circ?S:S/6;
const id='ba'+(h&65535);
const sz=size||40;
const mouth=openM
?'<path d="M15 '+(19+ms)+'c2 1 4 1 6 0" stroke="'+fc+'" fill="none" stroke-linecap="round"/>'
:'<path d="M13,'+(19+ms)+' a1,0.75 0 0,0 10,0" fill="'+fc+'"/>';
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="'+sz+'" height="'+sz+'" fill="none">'
+'<mask id="'+id+'" maskUnits="userSpaceOnUse" x="0" y="0" width="36" height="36">'
+'<rect width="36" height="36" rx="72" fill="#fff"/></mask>'
+'<g mask="url(#'+id+')">'
+'<rect width="36" height="36" fill="'+bg+'"/>'
+'<rect x="0" y="0" width="36" height="36" transform="translate('+wx+' '+wy+') rotate('+wr+' '+cx+' '+cx+') scale('+ws+')" fill="'+wc+'" rx="'+rx+'"/>'
+'<g transform="translate('+ftx+' '+fty+') rotate('+fr+' '+cx+' '+cx+')">'
+mouth
+'<rect x="'+(14-es)+'" y="14" width="1.5" height="2" rx="1" fill="'+fc+'"/>'
+'<rect x="'+(20+es)+'" y="14" width="1.5" height="2" rx="1" fill="'+fc+'"/>'
+'</g></g></svg>';
return 'data:image/svg+xml,'+encodeURIComponent(svg);
}`
