import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HorizonWatcher } from "../src/horizon-watcher";
import { FakeHorizonClient } from "./fake-horizon";
import { runWatcherContract } from "./watcher-contract";

runWatcherContract("HorizonWatcher (poll)", () => {
  const fake = new FakeHorizonClient();
  const watcher = new HorizonWatcher(fake);
  // Polling has no persistent connection to drop; fetchSince always reads
  // straight from Horizon, so there's nothing to reconnect.
  return { fake, watcher };
});

/** Loads a recorded Horizon operation record and attaches the transaction the
 *  watcher would otherwise have fetched (or read from a join). */
function pathPaymentFixture(name: string): any {
  return {
    ...JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")),
    transaction: async () => ({ memo_type: "text", memo: "ref_path" }),
  };
}

describe("HorizonWatcher path payments (issue 2.17)", () => {
  // The fixture's own destination, so the record is a payment to this account.
  const ACCOUNT = "GDIXIET2FDMTWGW5TADETT6BG4NGMREE775CV7I6DPFAEKJDWOTXZFBN";

  it("passes a strict-receive path payment through unchanged", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new HorizonWatcher(fake);

    fake.addRecord(ACCOUNT, pathPaymentFixture("path-payment-strict-receive.json"));

    const payments = await watcher.fetchSince(ACCOUNT, "");
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      amount: "10.0000000", // delivered, not the 20 spent
      asset: { code: "USDC", issuer: "GCRKWLMECGBERYAJM5F4SMQXLXO7QCXX5B632RJH747JXS6NNJVVIZEV" },
      sourceAmount: "20.0000000",
      sourceAsset: { code: "XLM", issuer: null },
      from: "GCYG5C5AERHKEIDSTJKEOGBQF6QWLYJHIUODZWBVXM3IZINJEHD5UVO7",
      to: ACCOUNT,
      memo: "ref_path",
    });
  });
});
