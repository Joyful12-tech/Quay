import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizePayment } from "../src/normalize";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/** Loads a recorded Horizon operation record from test/fixtures. */
function loadFixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function record(over: Record<string, unknown> = {}) {
  return {
    type: "payment",
    paging_token: "1",
    transaction_hash: "tx1",
    created_at: "2026-01-01T00:00:00Z",
    to: DEST,
    from: "GBUYER",
    amount: "10",
    asset_type: "native",
    transaction: async () => ({ memo_type: "none", memo: undefined }),
    ...over,
  };
}

describe("normalizePayment", () => {
  it("sets toMuxedId to null for an ordinary G-address payment", async () => {
    const payment = await normalizePayment(record() as any);
    expect(payment?.toMuxedId).toBeNull();
  });

  it("decodes to_muxed_id when the payer sent to an M-address", async () => {
    const payment = await normalizePayment(record({ to_muxed_id: "123456789" }) as any);
    expect(payment?.toMuxedId).toBe("123456789");
    // `to` still resolves to the underlying G-address regardless of muxing.
    expect(payment?.to).toBe(DEST);
  });

  it("returns null for non-value operations regardless of muxing", async () => {
    const payment = await normalizePayment(record({ type: "create_account", to_muxed_id: "1" }) as any);
    expect(payment).toBeNull();
  });

  it("leaves sourceAsset and sourceAmount null for a plain payment", async () => {
    const payment = await normalizePayment(record() as any);
    expect(payment?.sourceAsset).toBeNull();
    expect(payment?.sourceAmount).toBeNull();
  });

  // Issues 2.17 / 4.66 / 5.50. The fixtures are real Horizon testnet records
  // (provenance in each file's `_fixture_source`). Horizon puts the *delivered*
  // asset and amount in `asset_*`/`amount`, and the paid-in side in
  // `source_asset_*`/`source_amount` — so normalization must read the former for
  // settlement. A refactor that preferred `source_amount` would settle a link
  // for the wrong amount (20 vs 10 below) and nothing else would notice.
  describe("path payments settle on the delivered (destination) side", () => {
    const withMemo = (name: string) => ({
      ...loadFixture(name),
      transaction: async () => ({ memo_type: "text", memo: "ref_path" }),
    });

    it("path_payment_strict_receive: amount and asset are what the recipient got", async () => {
      // Payer spent 20 XLM to deliver 10 USDC.
      const payment = await normalizePayment(withMemo("path-payment-strict-receive.json"));

      expect(payment?.amount).toBe("10.0000000");
      expect(payment?.asset).toEqual({
        code: "USDC",
        issuer: "GCRKWLMECGBERYAJM5F4SMQXLXO7QCXX5B632RJH747JXS6NNJVVIZEV",
      });
      expect(payment?.to).toBe("GDIXIET2FDMTWGW5TADETT6BG4NGMREE775CV7I6DPFAEKJDWOTXZFBN");

      // The paid-in side is carried through too, for receipts and CSV export.
      expect(payment?.sourceAmount).toBe("20.0000000");
      expect(payment?.sourceAsset).toEqual({ code: "XLM", issuer: null });
    });

    it("path_payment_strict_send: amount and asset are what the recipient got", async () => {
      // Payer sent 10 IOM to deliver 20 ECO.
      const payment = await normalizePayment(withMemo("path-payment-strict-send.json"));

      expect(payment?.amount).toBe("20.0000000");
      expect(payment?.asset).toEqual({
        code: "ECO",
        issuer: "GBINSDAFTE3II244THL2EACS6VLE5OVZMS7UI6N42Z7ZU5X4KMQ2GOEW",
      });
      expect(payment?.to).toBe("GDQGJR37GVEIUO2FB6DLM74POUQZRXQIOBLBEOK44S6BZIZAKXEWITWC");

      expect(payment?.sourceAmount).toBe("10.0000000");
      expect(payment?.sourceAsset).toEqual({
        code: "IOM",
        issuer: "GBINSDAFTE3II244THL2EACS6VLE5OVZMS7UI6N42Z7ZU5X4KMQ2GOEW",
      });

      // Muxed destinations keep decoding while the path fields are carried.
      expect(payment?.toMuxedId).toBe("444444444444");
    });
  });
});
