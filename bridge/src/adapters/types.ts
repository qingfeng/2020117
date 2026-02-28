/**
 * Lightning backend adapter interface.
 *
 * Every backend (Lightning.Pub, LND, Alby Hub, CLN, LNbits)
 * implements this interface. The bridge calls these methods
 * without knowing which backend is behind them.
 */

export interface LightningAdapter {
  /** Create a sub-account for a user. */
  createUser(params: { user_id: string }): Promise<{ ok: true }>

  /** Get user balance. */
  getBalance(params: { user_id: string }): Promise<{ balance_sats: number }>

  /** Generate a Lightning invoice for deposits. */
  createInvoice(params: {
    user_id: string
    amount_sats: number
    memo?: string
    payer_id?: string
  }): Promise<{ bolt11: string }>

  /** Pay a Lightning invoice (debit user balance). */
  payInvoice(params: {
    user_id: string
    bolt11: string
  }): Promise<{ preimage: string; amount_sats: number }>

  /** Internal transfer between two users. */
  internalTransfer(params: {
    from_user_id: string
    to_user_id: string
    amount_sats: number
  }): Promise<{ ok: true }>
}
