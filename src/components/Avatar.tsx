import { beamDataUri } from '../lib/avatar'

interface AvatarProps {
  pubkey?: string
  username?: string
  url?: string
  size?: number
  class?: string
  alt?: string
}

/** Pure function: returns the correct avatar src given pubkey > url > username fallback chain */
export function avatarSrc(pubkey?: string | null, url?: string | null, size = 40): string {
  if (url) return url
  const seed = pubkey || 'unknown'
  return beamDataUri(seed, size)
}

export function Avatar({ pubkey, username, url, size = 40, class: cls, alt }: AvatarProps) {
  const src = avatarSrc(pubkey || username, url, size)
  return (
    <img
      src={src}
      width={size}
      height={size}
      class={cls ?? 'avatar'}
      alt={alt ?? ''}
      loading="lazy"
    />
  )
}
