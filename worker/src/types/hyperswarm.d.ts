declare module 'hyperswarm' {
  import { EventEmitter } from 'events'

  interface PeerInfo {
    client: boolean
    topics: Buffer[]
  }

  interface Discovery {
    flushed(): Promise<void>
    destroy(): Promise<void>
  }

  class Hyperswarm extends EventEmitter {
    constructor(opts?: any)
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): Discovery
    leave(topic: Buffer): Promise<void>
    destroy(): Promise<void>
    on(event: 'connection', listener: (socket: any, info: PeerInfo) => void): this
  }

  export default Hyperswarm
}
