/*
 * Copyright 2026 Justlend V2 Utils. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { depositToVault, redeemFromVault, supplyCollateral, withdrawCollateral, borrow, repay, depositTrxToVault, redeemTrxFromVault, supplyTrxAsCollateral, borrowTrx, repayWithTrx, withdrawTrxCollateral, estimateSupplyTrxGas, approve, getAllowance, getMerkleRoot, isClaimed, multiClaim, depositTrxToWtrx, withdrawTrxFromWtrx, getLoanTokenAmountNeed, liquidate, requiresAllowanceReset } from '../utils/systemV2';
import * as blockchain from '../utils/blockchain';
import Config from '../config';
import BigNumber from 'bignumber.js';

describe('justlend v2 utils systemV2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.window = {
      defaultAccount: 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3'
    };

    // Pin the network explicitly so address resolution is deterministic and
    // independent of the production default host (which now defaults to
    // mainnet). These cases assert against Config.contracts.nile.*.
    blockchain.tronObj.network = 'nile';

    // These tests assert the ABI-encoded args handed to the chain layer, not
    // on-chain execution. Stub the write/estimate paths so the suite is fully
    // deterministic and runs offline — no Nile round-trip, and no dependency on
    // the test account actually holding a position (which is what made the
    // borrow/repay/withdraw cases REVERT before).
    vi.spyOn(blockchain, 'triggerV2').mockResolvedValue({
      result: { result: true },
      transaction: { txID: `0x${'0'.repeat(64)}` },
    });
    vi.spyOn(blockchain, 'triggerEnergy').mockResolvedValue({ energy_used: 31000 });

    // Read paths go through `view`, which already returns [] on any network
    // error, so the getter tests fall back to their safe defaults offline.
  });

  it('depositToVault', async () => {
    const vaultAddress = 'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW';
    const amount = 100;
    const decimals = 6;
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    const result = await depositToVault(vaultAddress, amount, decimals, receiver);

    expect(blockchain.triggerV2).toHaveBeenCalled();
    
    if (result && result.result) {
      expect(result.result.result).toBe(true);
    }
  });

  it('redeemFromVault (Withdraw)', async () => {
    const vaultAddress = 'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW';
    const assets = 50;
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const owner = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    await redeemFromVault(vaultAddress, assets, 6, receiver, owner, null);

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "withdraw(uint256,address,address)",
      expect.arrayContaining([
        { type: "uint256", value: "50000000" }
      ]),
      {}
    );
  });

  it('redeemFromVault (Redeem)', async () => {
    const vaultAddress = 'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW';
    const shares = "1000000";
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const owner = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    await redeemFromVault(vaultAddress, null, 6, receiver, owner, shares);

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "redeem(uint256,address,address)", 
      expect.arrayContaining([
        { type: "uint256", value: shares }
      ]),
      {}
    );
  });

  it('supplyCollateral', async () => {
    const marketParams = {
      borrowAddress: 'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS', 
      collateralAddress: 'TW714k8Ni3g7yiHUUckXXuSdCPqFmNXZis', 
      oracle: 'TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG',
      irm: 'TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC',
      lltv: "0.9"
    };
    const amount = 200;
    const decimals = 8;
    const onBehalf = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    const result = await supplyCollateral(
      marketParams,
      amount,
      decimals,
      onBehalf,
    );

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
      [
        {
          type: "(address,address,address,address,uint256)",
          value: [
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            "900000000000000000" // 0.9 * 1e18
          ]
        },
        { type: "uint256", value: "20000000000" }, // 200 * 1e8
        { type: "address", value: onBehalf },
        { type: "bytes", value: "0x" }
      ],
      {}
    );

    if (result && result.result) {
      expect(result.result.result).toBe(true);
    }
  });
  
  it('withdrawCollateral', async () => {
    const marketParams = {
      borrowAddress: 'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS', 
      collateralAddress: 'TW714k8Ni3g7yiHUUckXXuSdCPqFmNXZis', 
      oracle: 'TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG',
      irm: 'TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC',
      lltv: "0.9"
    };

    const amount = 0.1;
    const decimals = 8;
    const onBehalf = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    const result = await withdrawCollateral(
      marketParams,
      amount,
      decimals,
      onBehalf,
      receiver,
    );

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "withdrawCollateral((address,address,address,address,uint256),uint256,address,address)",
      [
        {
          type: "(address,address,address,address,uint256)",
          value: [
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            "900000000000000000" // 0.9 * 1e18
          ]
        },
        { type: "uint256", value: "10000000" },
        { type: "address", value: onBehalf },
        { type: "address", value: receiver }
      ],
      {}
    );

    if (result && result.result) {
      expect(result.result.result).toBe(true);
    }
  });

  it('borrow', async () => {
    const marketParams = {
      borrowAddress: 'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS', 
      collateralAddress: 'TW714k8Ni3g7yiHUUckXXuSdCPqFmNXZis', 
      oracle: 'TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG',
      irm: 'TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC',
      lltv: "0.9"
    };
    const amount = 100;
    const decimals = 6;
    const onBehalf = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    const result = await borrow(
      marketParams,
      amount,
      decimals,
      onBehalf,
      receiver,
    );

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "borrow((address,address,address,address,uint256),uint256,uint256,address,address)",
      [
        {
          type: "(address,address,address,address,uint256)",
          value: [
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            "900000000000000000"
          ]
        },
        { type: "uint256", value: "100000000" },
        { type: "uint256", value: 0 },
        { type: "address", value: onBehalf },
        { type: "address", value: receiver }
      ],
      {}
    );

    if (result && result.result) {
      expect(result.result.result).toBe(true);
    }
  });
  
  it('repay (repayment by amount): When sharesAmount is not passed, amount should be correctly converted and shares should be set to 0', async () => {
    const marketParams = {
      borrowAddress: 'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS', 
      collateralAddress: 'TW714k8Ni3g7yiHUUckXXuSdCPqFmNXZis', 
      oracle: 'TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG',
      irm: 'TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC',
      lltv: "0.9"
    };
    const amount = 300;
    const decimals = 6;
    const onBehalf = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    await repay(marketParams, amount, decimals, null, onBehalf);

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
       expect.any(String),
      "repay((address,address,address,address,uint256),uint256,uint256,address,bytes)",
      [
        {
          type: "(address,address,address,address,uint256)",
          value: expect.any(Array)
        },
        { type: "uint256", value: "300000000" }, 
        { type: "uint256", value: 0 },
        { type: "address", value: onBehalf },
        { type: "bytes", value: "0x" }
      ],
      {}
    );
  });

  it('repay (repayment by shares): When sharesAmount is passed, assets should be set to 0', async () => {
    const marketParams = {
      borrowAddress: 'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS', 
      collateralAddress: 'TW714k8Ni3g7yiHUUckXXuSdCPqFmNXZis', 
      oracle: 'TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG',
      irm: 'TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC',
      lltv: "0.9"
    };
    const sharesAmount = "500000000";
    const onBehalf = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    await repay(marketParams, null, 6, sharesAmount, onBehalf);

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "repay((address,address,address,address,uint256),uint256,uint256,address,bytes)",
      [
        {
          type: "(address,address,address,address,uint256)",
          value: expect.any(Array)
        },
        { type: "uint256", value: 0 },
        { type: "uint256", value: sharesAmount },
        { type: "address", value: onBehalf },
        { type: "bytes", value: "0x" }
      ],
      {}
    );
  });

  it('depositTrxToVault', async () => {
    const vaultAddress = 'TKSz9jGAqLazTbDCm7fS21Dzy7JJ5aeWoS';
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const amount = 100;

    const result = await depositTrxToVault(
      vaultAddress,
      receiver,
      amount
    );

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "deposit(address,address)",
      [
        { type: "address", value: vaultAddress },
        { type: "address", value: receiver }
      ],
      { callValue : "100000000" } // 100 * 1e6
    );

    if (result && result.result) {
      expect(result.result.result).toBe(true);
    }
  });

  it('payable TRX helpers keep the validated amount authoritative over options.callValue', async () => {
    const vaultAddress = 'TKSz9jGAqLazTbDCm7fS21Dzy7JJ5aeWoS';
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const marketParams = {
      borrowAddress: 'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS',
      collateralAddress: 'TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a',
      oracle: 'TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG',
      irm: 'TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC',
      lltv: '0.9'
    };

    await depositTrxToVault(vaultAddress, receiver, 1, undefined, { callValue: '999999999', feeLimit: 7 });
    expect(blockchain.triggerV2).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), expect.any(Array), { callValue: '1000000', feeLimit: 7 }
    );

    await supplyTrxAsCollateral(marketParams, receiver, 1, undefined, { callValue: '999999999', feeLimit: 7 });
    expect(blockchain.triggerV2).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), expect.any(Array), { callValue: '1000000', feeLimit: 7 }
    );

    await depositTrxToWtrx(1, undefined, { callValue: '999999999', feeLimit: 7 });
    expect(blockchain.triggerV2).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), expect.any(Array), { callValue: '1000000', feeLimit: 7 }
    );
  });

  it('redeemTrxFromVault (Withdraw)', async () => {
    const vaultAddress = 'TKSz9jGAqLazTbDCm7fS21Dzy7JJ5aeWoS';
    const assets = 150;
    const vaultShareDecimals = 6;
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const owner = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    await redeemTrxFromVault(
      vaultAddress,
      assets,
      vaultShareDecimals,
      null, // shares set null
      receiver,
      owner,
    );

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "withdraw(address,uint256,address,address)",
      [
        { type: "address", value: vaultAddress },
        { type: "uint256", value: "150000000" }, // (150 * 10^6)
        { type: "address", value: receiver },
        { type: "address", value: owner }
      ],
      {}
    );
  });

  it('redeemTrxFromVault (Redeem)', async () => {
    const vaultAddress = 'TKSz9jGAqLazTbDCm7fS21Dzy7JJ5aeWoS';
    const shares = "200000000";
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const owner = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    await redeemTrxFromVault(
      vaultAddress,
      null, // assets set null
      null, // vaultShareDecimals set null
      shares,
      receiver,
      owner,
    );

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "redeem(address,uint256,address,address)",
      [
        { type: "address", value: vaultAddress },
        { type: "uint256", value: shares },
        { type: "address", value: receiver },
        { type: "address", value: owner }
      ],
      {}
    );
  });

  it('supplyTrxAsCollateral', async () => {
    const marketParams = {
      borrowAddress: "TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS", 
      collateralAddress: "TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a", 
      oracle: "TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG",
      irm: "TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC",
      lltv: "0.9" 
    };
    const onBehalf = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const amount = 500;

    const result = await supplyTrxAsCollateral(
      marketParams,
      onBehalf,
      amount,
    );

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "supplyCollateral((address,address,address,address,uint256),address,bytes)", 
      [
        {
          type: "(address,address,address,address,uint256)",
          value: [
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            "900000000000000000" // 0.9 * 1e18
          ]
        },
        { type: "address", value: onBehalf },
        { type: "bytes", value: "0x" }
      ],
      { callValue: "500000000" }
    );

    if (result && result.result) {
      expect(result.result.result).toBe(true);
    }
  });

  it('borrowTrx', async () => {
    const marketParams = {
      borrowAddress: "TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a", 
      collateralAddress: "TZ8du1HkatTWDbS6FLZei4dQfjfpSm9mxp", 
      oracle: "TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG",
      irm: "TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC",
      lltv: "0.9" 
    };
    const amount = 500;
    const onBehalf = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    const result = await borrowTrx(
      marketParams,
      amount,
      onBehalf,
      receiver,
    );

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "borrow((address,address,address,address,uint256),uint256,uint256,address,address)",
      [
        {
          type: "(address,address,address,address,uint256)",
          value: expect.any(Array)
        },
        { type: "uint256", value: "500000000" },
        { type: "uint256", value: 0 },
        { type: "address", value: onBehalf },
        { type: "address", value: receiver }
      ],
      {}
    );

    if (result && result.result) {
      expect(result.result.result).toBe(true);
    }
  });

  it('repayWithTrx (repayment by amount): Should correctly convert the TRX amount and call the proxy contract.', async () => {
    const marketParams = {
      borrowAddress: "TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a", 
      collateralAddress: "TZ8du1HkatTWDbS6FLZei4dQfjfpSm9mxp", 
      oracle: "TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG",
      irm: "TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC",
      lltv: "0.9" 
    };
    const amount = 200;
    const onBehalf = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    await repayWithTrx(marketParams, amount, null, onBehalf);

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "repay((address,address,address,address,uint256),uint256,uint256,address,bytes)",
      [
        {
          type: "(address,address,address,address,uint256)",
          value: expect.any(Array)
        },
        { type: "uint256", value: "200000000" },
        { type: "uint256", value: 0 },
        { type: "address", value: onBehalf },
        { type: "bytes", value: "0x" }
      ],
      {
         "callValue": "200000000",
      }
    );
  });

  it('repayWithTrx (repayment by shares): When sharesAmount is passed, the assets field should be 0.', async () => {
     const marketParams = {
      borrowAddress: "TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a", 
      collateralAddress: "TZ8du1HkatTWDbS6FLZei4dQfjfpSm9mxp", 
      oracle: "TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG",
      irm: "TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC",
      lltv: "0.9" 
    };
    const sharesAmount = "50000000000000000";
    const onBehalf = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    await repayWithTrx(marketParams, 0, sharesAmount, onBehalf,"50009391493");

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "repay((address,address,address,address,uint256),uint256,uint256,address,bytes)",
      [
        {
          type: "(address,address,address,address,uint256)",
          value: expect.any(Array)
        },
        { type: "uint256", value: 0 },
        { type: "uint256", value: sharesAmount },
        { type: "address", value: onBehalf },
        { type: "bytes", value: "0x" }
      ],
      {
         "callValue": "50009391493",
      }
    );
  });

  it('repayWithTrx validates raw-SUN shares call value and prevents options from overriding it', async () => {
    const marketParams = {
      borrowAddress: "TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a",
      collateralAddress: "TZ8du1HkatTWDbS6FLZei4dQfjfpSm9mxp",
      oracle: "TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG",
      irm: "TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC",
      lltv: "0.9"
    };

    for (const invalid of ["-1", "1.5"]) {
      await expect(
        repayWithTrx(
          marketParams,
          0,
          "50000000000000000",
          'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3',
          invalid
        )
      ).rejects.toThrow(/invalid sharesCallValueAmount/);
    }
    expect(blockchain.triggerV2).not.toHaveBeenCalled();

    await repayWithTrx(
      marketParams,
      0,
      "50000000000000000",
      'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3',
      "42",
      undefined,
      { callValue: "-1", feeLimit: 7 }
    );
    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Array),
      { callValue: "42", feeLimit: 7 }
    );
  });

  it('withdrawTrxCollateral', async () => {
    const marketParams = {
      borrowAddress: "TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS",
      collateralAddress: "TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a",
      oracle: "TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG",
      irm: 'TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC',
      lltv: "0.9"
    };
    const amount = 100; 
    const onBehalf = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    const result = await withdrawTrxCollateral(
      marketParams,
      amount,
      onBehalf,
      receiver,
    );

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      "withdrawCollateral((address,address,address,address,uint256),uint256,address,address)",
      [
        {
          type: "(address,address,address,address,uint256)",
          value: [
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            expect.stringMatching(/^0x/),
            "900000000000000000" // 0.9 * 1e18
          ]
        },
        // (100 * 10^6)
        { type: "uint256", value: "100000000" },
        { type: "address", value: onBehalf },
        { type: "address", value: receiver }
      ],
      {}
    );

    if (result && result.result) {
      expect(result.result.result).toBe(true);
    }
  });

  it('estimateSupplyTrxGas', async () => {
    const vaultAddress = 'TKSz9jGAqLazTbDCm7fS21Dzy7JJ5aeWoS';
    const amount = 100;
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';

    const energyUsed = await estimateSupplyTrxGas(
      vaultAddress,
      amount,
      receiver,
    );

    expect(typeof energyUsed).toBe('number');
  });

  it('approve', async () => {
    const assetAddress = 'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS'; 
    const vaultAddress = 'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW';

    const result = await approve(
      assetAddress,
      vaultAddress,
      { unlimited: true }
    );

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      assetAddress,
      "approve(address,uint256)",
      [
        { type: "address", value: vaultAddress },
        {
          type: "uint256",
          value: expect.stringMatching(/^(0x)?f+$/i)
        },
      ],
      {}
    );

    if (result && result.result) {
      expect(result.result.result).toBe(true);
    }
  });

  it('getAllowance returns a BigNumber on a successful read', async () => {
    // A successful allowance read returns a 1-element array (encoded uint256).
    vi.spyOn(blockchain, 'view').mockResolvedValueOnce([
      '00000000000000000000000000000000000000000000000000000000000003e8', // 1000
    ]);
    const allowance = await getAllowance(
      'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS',
      'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3',
      'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW'
    );
    expect(allowance instanceof BigNumber).toBe(true);
    expect(allowance.toString()).toBe('1000');
  });

  it('getAllowance throws (fail-closed) when the read fails — no sentinel 0', async () => {
    vi.spyOn(blockchain, 'view').mockResolvedValueOnce([]); // view returns [] on failure
    await expect(
      getAllowance(
        'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS',
        'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3',
        'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW'
      )
    ).rejects.toThrow(/Failed to read allowance/);
  });

  it('requiresAllowanceReset flags TetherToken-class tokens, not others', () => {
    expect(requiresAllowanceReset('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true); // USDT
    expect(requiresAllowanceReset('TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS')).toBe(false);
  });

  it('approve resets a USDT-class token to 0 before re-approving when allowance > 0', async () => {
    const usdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const spender = 'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW';
    // current allowance = 500 (non-zero) → must reset to 0 first
    vi.spyOn(blockchain, 'view').mockResolvedValueOnce([
      '00000000000000000000000000000000000000000000000000000000000001f4',
    ]);

    await approve(usdt, spender, { unlimited: true });

    // first call: approve(spender, 0)
    expect(blockchain.triggerV2).toHaveBeenNthCalledWith(
      1, usdt, 'approve(address,uint256)',
      [{ type: 'address', value: spender }, { type: 'uint256', value: '0' }], {}
    );
    // second call: approve(spender, MAX)
    expect(blockchain.triggerV2).toHaveBeenNthCalledWith(
      2, usdt, 'approve(address,uint256)',
      [{ type: 'address', value: spender }, { type: 'uint256', value: expect.stringMatching(/^(0x)?f+$/i) }], {}
    );
  });

  it('approve conservatively resets a USDT-class token when the allowance read fails', async () => {
    const usdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const spender = 'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW';
    vi.spyOn(blockchain, 'view').mockResolvedValueOnce([]); // read fails → conservative reset

    await approve(usdt, spender, { unlimited: true });

    expect(blockchain.triggerV2).toHaveBeenCalledTimes(2); // reset(0) + approve(MAX)
    expect(blockchain.triggerV2).toHaveBeenNthCalledWith(
      1, usdt, 'approve(address,uint256)',
      [{ type: 'address', value: spender }, { type: 'uint256', value: '0' }], {}
    );
  });

  it('approve honors an explicit exact amount (no unlimited)', async () => {
    const token = 'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS'; // not a reset-list token
    const spender = 'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW';

    await approve(token, spender, { amount: '12345' });

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      token, 'approve(address,uint256)',
      [{ type: 'address', value: spender }, { type: 'uint256', value: '12345' }], {}
    );
  });

  it('approve requires an explicit amount or unlimited opt-in (no silent MAX default)', async () => {
    const tokenAddress = 'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS'; // gitleaks:allow -- public TRON address fixture
    const spender = 'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW';
    await expect(approve(tokenAddress, spender)).rejects.toThrow(/exact .*amount.*unlimited/i);
    expect(blockchain.triggerV2).not.toHaveBeenCalled();
  });

  it('approve rejects a malformed token/spender address before signing', async () => {
    await expect(approve('not-an-address', 'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW'))
      .rejects.toThrow(/Invalid TRON/);
    expect(blockchain.triggerV2).not.toHaveBeenCalled();
  });

  it('getMerkleRoot', async () => {
    const merkleIndex = 0;
    vi.spyOn(blockchain, 'view').mockResolvedValueOnce([
      'a'.repeat(64),
    ]);

    const root = await getMerkleRoot(merkleIndex);

    expect(root).toBe(`0x${'a'.repeat(64)}`);
  });

  it('getMerkleRoot (custom merkleDistributor address)', async () => {
    const merkleIndex = 0;
    const merkleDistributor = Config.contracts.nile.MerkleDistributor;
    vi.spyOn(blockchain, 'view').mockResolvedValueOnce([
      'b'.repeat(64),
    ]);

    const root = await getMerkleRoot(merkleIndex, merkleDistributor);

    expect(root).toBe(`0x${'b'.repeat(64)}`);
  });

  it('isClaimed', async () => {
    const merkleIndex = 0;
    const index = 0;
    vi.spyOn(blockchain, 'view').mockResolvedValueOnce(['1']);

    const claimed = await isClaimed(merkleIndex, index);

    expect(typeof claimed).toBe('boolean');
    expect(claimed).toBe(true);
  });

  it('merkle reads fail closed instead of returning not-found sentinels', async () => {
    vi.spyOn(blockchain, 'view').mockResolvedValue([]);
    await expect(getMerkleRoot(0)).rejects.toThrow(/Failed to read merkle root/);
    await expect(isClaimed(0, 1)).rejects.toThrow(/Failed to read claim status/);
  });

  it('value-moving entry points reject malformed addresses before preflight', async () => {
    await expect(
      depositToVault('not-an-address', 1, 6, 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3')
    ).rejects.toThrow(/Invalid TRON/);
    expect(blockchain.triggerV2).not.toHaveBeenCalled();
  });

  it('multiClaim (single token)', async () => {
    const claims = [
      {
        merkleIndex: '0',
        index: '1',
        amount: '1000000',
        merkleProof: [
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        ],
      },
    ];

    await multiClaim(claims).catch(() => {});

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      expect.any(String),
      'multiClaim((uint256,uint256,uint256,bytes32[])[])',
      [
        {
          type: '(uint256,uint256,uint256,bytes32[])[]',
          value: [
            [
              '0',
              '1',
              '1000000',
              [
                '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
              ],
            ],
          ],
        },
      ],
      {}
    );
  });

  it('depositTrxToWtrx', async () => {
    const amount = 100;

    await depositTrxToWtrx(amount).catch(() => {});

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      Config.contracts.nile.WtrxContractProxy,
      'deposit()',
      [],
      { callValue: '100000000' } // 100 * 1e6
    );
  });

  it('depositTrxToWtrx (custom WtrxContractProxy address)', async () => {
    const amount = 50;
    const wtrxContractProxy = Config.contracts.main.WtrxContractProxy;

    await depositTrxToWtrx(amount, wtrxContractProxy).catch(() => {});

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      wtrxContractProxy,
      'deposit()',
      [],
      { callValue: '50000000' }
    );
  });

  it('withdrawTrxFromWtrx', async () => {
    const amount = 100;

    await withdrawTrxFromWtrx(amount).catch(() => {});

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      Config.contracts.nile.WtrxContractProxy,
      'withdraw(uint256)',
      [{ type: 'uint256', value: '100000000' }], // 100 * 1e6
      {}
    );
  });

  it('withdrawTrxFromWtrx (custom WtrxContractProxy address)', async () => {
    const amount = 50;
    const wtrxContractProxy = Config.contracts.main.WtrxContractProxy;

    await withdrawTrxFromWtrx(amount, wtrxContractProxy).catch(() => {});

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      wtrxContractProxy,
      'withdraw(uint256)',
      [{ type: 'uint256', value: '50000000' }],
      {}
    );
  });

  it('getLoanTokenAmountNeed (by seizedAssets) returns a BigNumber on a successful read', async () => {
    const marketId =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const seizedAssets = 100;
    const decimals = 6;

    // A successful read returns a 1-element array (encoded uint256).
    vi.spyOn(blockchain, 'view').mockResolvedValueOnce([
      '00000000000000000000000000000000000000000000000000000000000003e8', // 1000
    ]);

    const need = await getLoanTokenAmountNeed(
      marketId,
      seizedAssets,
      null,
      decimals
    );

    expect(need instanceof BigNumber).toBe(true);
    expect(need.toString()).toBe('1000');
  });

  it('getLoanTokenAmountNeed (by repaidShares) returns a BigNumber on a successful read', async () => {
    const marketId =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const repaidShares = '500000000';

    vi.spyOn(blockchain, 'view').mockResolvedValueOnce([
      '00000000000000000000000000000000000000000000000000000000000003e8', // 1000
    ]);

    const need = await getLoanTokenAmountNeed(
      marketId,
      0,
      repaidShares,
      6
    );

    expect(need instanceof BigNumber).toBe(true);
    expect(need.toString()).toBe('1000');
  });

  it('getLoanTokenAmountNeed throws (fail-closed) when the read fails — no sentinel 0', async () => {
    const marketId =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    vi.spyOn(blockchain, 'view').mockResolvedValueOnce([]); // view returns [] on failure
    await expect(
      getLoanTokenAmountNeed(marketId, 100, null, 6)
    ).rejects.toThrow(/Failed to read loanTokenAmountNeed/);
  });

  it('liquidate (by seizedAssets)', async () => {
    const marketId =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const borrower = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const seizedAssets = 100;
    const decimals = 6;

    await liquidate(marketId, borrower, seizedAssets, null, decimals).catch(
      () => {}
    );

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      Config.contracts.nile.PublicLiquidatorProxy,
      'liquidate(bytes32,address,uint256,uint256)',
      [
        { type: 'bytes32', value: marketId },
        { type: 'address', value: borrower },
        { type: 'uint256', value: '100000000' }, // 100 * 1e6
        { type: 'uint256', value: 0 },
      ],
      {}
    );
  });

  it('liquidate (by repaidShares)', async () => {
    const marketId =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const borrower = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const repaidShares = '500000000';

    await liquidate(marketId, borrower, 0, repaidShares, 6).catch(() => {});

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      Config.contracts.nile.PublicLiquidatorProxy,
      'liquidate(bytes32,address,uint256,uint256)',
      [
        { type: 'bytes32', value: marketId },
        { type: 'address', value: borrower },
        { type: 'uint256', value: 0 },
        { type: 'uint256', value: repaidShares },
      ],
      {}
    );
  });

  it('multiClaim (multi-token / NEW USDD)', async () => {
    const claims = [
      {
        merkleIndex: '0',
        index: '1',
        amount: ['1000000', '2000000'],
        merkleProof: [
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        ],
      },
    ];
    const merkleDistributor = Config.contracts.nile.MerkleDistributor;

    await multiClaim(claims, merkleDistributor).catch(() => {});

    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      merkleDistributor,
      'multiClaim((uint256,uint256,uint256[],bytes32[])[])',
      [
        {
          type: '(uint256,uint256,uint256[],bytes32[])[]',
          value: [
            [
              '0',
              '1',
              ['1000000', '2000000'],
              [
                '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
              ],
            ],
          ],
        },
      ],
      {}
    );
  });

  // ---- amount-construction boundary-guard regressions (Low·DeFi 20260708) ----
  // Every scaled uint256/callValue sink now shares toChainAmount's guard, so a
  // negative amount is rejected before it can two's-complement-wrap a uint256 —
  // closing approve's negative→~MAX_UINT256 unlimited-approval footgun (which
  // approve(MAX) pre-exec simulates OK and can't backstop) and the TRX
  // callValue/asset paths — with no broadcast attempted.
  it('approve rejects a negative amount before it can two’s-complement-wrap a uint256', async () => {
    const tokenAddress = 'TPYwAC9Y4uUcT2QH3WPPjqxzJSJWymMoMS'; // gitleaks:allow -- public TRON address fixture
    const spender = 'THwTBAmVoZTp4NY6HxJUHGDFGerDn9vuEW';
    await expect(approve(tokenAddress, spender, { amount: '-1' })).rejects.toThrow(/invalid amount/);
    expect(blockchain.triggerV2).not.toHaveBeenCalled();
  });

  it('depositTrxToVault rejects a negative TRX amount before it reaches the callValue', async () => {
    const vaultAddress = 'TKSz9jGAqLazTbDCm7fS21Dzy7JJ5aeWoS';
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    await expect(depositTrxToVault(vaultAddress, receiver, '-1')).rejects.toThrow(/invalid TRX amount/);
    expect(blockchain.triggerV2).not.toHaveBeenCalled();
  });

  it('borrowTrx rejects a negative TRX amount before it can two’s-complement-wrap the asset uint256', async () => {
    const marketParams = {
      borrowAddress: 'TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a',
      collateralAddress: 'TZ8du1HkatTWDbS6FLZei4dQfjfpSm9mxp',
      oracle: 'TFYLvDFSEW6dKSnWb3mt76hkHAgxPktrnG',
      irm: 'TQYeFiTVNfJ6jfqjyfL2s93VLG1huaMEzC',
      lltv: '0.9',
    };
    const onBehalf = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    const receiver = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    await expect(borrowTrx(marketParams, '-1', onBehalf, receiver)).rejects.toThrow(/invalid TRX amount/);
    expect(blockchain.triggerV2).not.toHaveBeenCalled();
  });
});
