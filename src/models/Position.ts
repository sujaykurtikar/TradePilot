/**
 * Mirrors one entry of `positions[]` from `GET /v1/paper/chart/state`
 * (IMPLEMENTATION_PLAN.md §2), plus local reconciliation state for the
 * post-trade drag flow (§P6t).
 *
 * Per §3 (R-OCO): `sl`/`tp` here are OUR managed levels, enforced by
 * `services/trade_management/manager.py` server-side — never the broker's.
 * The widget must always show the *engine's* view, never a locally-cached
 * guess.
 */

export interface Position {
  readonly positionId: string;
  readonly account: string;
  readonly symbol: string;
  readonly optionType: 'CE' | 'PE' | null;
  readonly strike: number | null;
  readonly entrySpot: number | null;
  readonly sl: number | null;
  readonly tp: number | null;
  readonly delta: number | null;
  readonly unrealizedPnl: number | null;
}

/**
 * §P6t: a pill's authoritative price is always the server's last-confirmed
 * value. A locally-dragged-but-unconfirmed level must be visually
 * distinguishable from a confirmed one, and must snap back on rejection.
 */
export type RiskLevelReconciliationState =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'pending'; readonly optimisticPrice: number }
  | { readonly kind: 'rejected'; readonly reason: string; readonly revertedToPrice: number };

export interface DraggablePosition extends Position {
  readonly slState: RiskLevelReconciliationState;
  readonly tpState: RiskLevelReconciliationState;
}
