import type { Horizon } from "@stellar/stellar-sdk";
import type { AssetRef, NormalizedPayment } from "@checkout/core";

// Operation types that move value to a recipient and carry a destination asset/amount.
const VALUE_TYPES = new Set([
  "payment",
  "path_payment_strict_receive",
  "path_payment_strict_send",
]);

// Of those, the ones that also carry a paid-in (source) side.
const PATH_PAYMENT_TYPES = new Set([
  "path_payment_strict_receive",
  "path_payment_strict_send",
]);

type AnyRecord = Horizon.ServerApi.PaymentOperationRecord | Horizon.ServerApi.OperationRecord;

interface AssetFields {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

interface ValueFields extends AssetFields {
  to?: string;
  from?: string;
  amount?: string;
  // Path payments only: the side the payer actually spent. Horizon reports the
  // *delivered* amount/asset in `amount`/`asset_*` above, so these never
  // describe what the recipient got.
  source_amount?: string;
  source_asset_type?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  // Present when the operation's destination was specified as an SEP-23
  // M-address; Horizon still normalizes `to` to the underlying G-address.
  to_muxed_id?: string;
}

export type OperationWithTransaction = { transaction_hash: string; transaction: () => Promise<Horizon.ServerApi.TransactionRecord> };

/** Resolves an operation record's parent transaction. Injected so the watcher
 *  can supply a per-tick memoized/batched implementation (see horizon-watcher.ts)
 *  instead of every record hitting Horizon independently. */
export type FetchTransaction = (record: OperationWithTransaction) => Promise<Horizon.ServerApi.TransactionRecord>;

const defaultFetchTransaction: FetchTransaction = (record) => record.transaction();

export function isValuePayment(record: AnyRecord): boolean {
  return VALUE_TYPES.has(record.type);
}

function assetOf(r: AssetFields): AssetRef {
  if (r.asset_type === "native" || r.asset_type === undefined) {
    return { code: "XLM", issuer: null };
  }
  return { code: r.asset_code ?? "", issuer: r.asset_issuer ?? null };
}

/**
 * Convert a raw Horizon record into a NormalizedPayment.
 * The memo lives on the *transaction*, not the operation, so we fetch it via
 * `fetchTransaction` — with `join=transactions` on the originating query
 * (see horizon-watcher.ts) this resolves from data already in hand, no
 * follow-up request. Returns null for non-value operations (e.g. create_account).
 *
 * A transaction-fetch failure is NOT downgraded to a `no_memo` outcome — it
 * throws, so a transient Horizon blip retries the whole tick instead of
 * silently parking a matchable payment as unmatched.
 */
export async function normalizePayment(
  record: AnyRecord,
  fetchTransaction: FetchTransaction = defaultFetchTransaction,
): Promise<NormalizedPayment | null> {
  if (!isValuePayment(record)) return null;
  const isPathPayment = PATH_PAYMENT_TYPES.has(record.type);
  const r = record as unknown as ValueFields &
    OperationWithTransaction & {
      paging_token: string;
      created_at: string;
    };

  const tx = await fetchTransaction(r);
  const memoType = tx.memo_type ?? null;
  const memo = memoType && memoType !== "none" ? (tx.memo ?? null) : null;

  // Path payments settle on the delivered side (`amount`/`asset_*`); the paid-in
  // side is carried alongside for receipts and CSV export (issues 2.17, 4.66,
  // 5.50), never for settlement. Plain payments have no source side.
  return {
    txHash: r.transaction_hash,
    pagingToken: r.paging_token,
    from: r.from ?? "",
    to: r.to ?? "",
    amount: r.amount ?? "0",
    asset: assetOf(r),
    sourceAsset: isPathPayment
      ? assetOf({
          asset_type: r.source_asset_type,
          asset_code: r.source_asset_code,
          asset_issuer: r.source_asset_issuer,
        })
      : null,
    sourceAmount: isPathPayment ? (r.source_amount ?? null) : null,
    memo,
    memoType,
    toMuxedId: r.to_muxed_id ?? null,
    createdAt: r.created_at,
    // Horizon exposes the sequence as `ledger_attr` on the transaction record;
    // plain `ledger` is the method that fetches the ledger itself.
    ledger: tx.ledger_attr ?? 0,
  };
}
