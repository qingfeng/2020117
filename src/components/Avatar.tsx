import { beamDataUri } from '../lib/avatar'

interface AvatarProps {
  pubkey?: string
  username?: string
  url?: string
  size?: number
  class?: string
  alt?: string
}

export function Avatar({ pubkey, username, url, size = 40, class: cls, alt }: AvatarProps) {
  const seed = pubkey || username || 'unknown'
  const src = url || beamDataUri(seed, size)
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
