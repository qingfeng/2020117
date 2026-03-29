/**
 * Server-side note content renderer.
 * Parses Nostr note text: renders image URLs as <img>, other URLs as <a>,
 * hashtags as styled spans, and newlines as <br>.
 */

const IMG_EXT = /\.(?:jpg|jpeg|png|gif|webp|avif)(?:[?#][^\s]*)?$/i

function e(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function renderNoteContent(text: string): string {
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  const textBuf: string[] = []
  const imgs: string[] = []

  for (const p of parts) {
    if (/^https?:\/\//.test(p)) {
      if (IMG_EXT.test(p)) {
        imgs.push(p)
      } else {
        const d = p.length > 55 ? p.slice(0, 55) + '…' : p
        textBuf.push(`<a href="${e(p)}" target="_blank" rel="noopener" class="note-link">${e(d)}</a>`)
      }
    } else {
      textBuf.push(
        e(p)
          .replace(/\n/g, '<br>')
          .replace(/#([\w\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf]+)/g, '<span class="hashtag">#$1</span>')
      )
    }
  }

  const textHtml = textBuf.join('').replace(/^(<br>)+|(<br>)+$/g, '').trim()
  const imgsHtml = imgs.map(u => `<img src="${e(u)}" class="note-img" loading="lazy" alt="">`).join('')

  let result = ''
  if (textHtml) result += `<div class="note-text">${textHtml}</div>`
  if (imgsHtml) result += `<div class="note-images">${imgsHtml}</div>`
  return result || `<div class="note-text">${e(text)}</div>`
}
