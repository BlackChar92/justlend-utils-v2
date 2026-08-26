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
import { TronWeb, utils as TronWebUtils } from "tronweb";
import Config from "../config";

const chain = Config.chain;

export const MAX_UINT256 =
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const mainchain = new TronWeb({
  fullHost: chain.fullHost,
});

export const tronObj = {
  tronWeb: mainchain,
  // Sender address for write transactions. Set this in Node; in the browser it
  // can stay null and fall back to the wallet-injected `window.defaultAccount`.
  defaultAccount: null,
  // Optional explicit network ("main" | "nile" | "shasta"). When null the
  // network is inferred from the node host.
  network: null,
};

// Resolve the sender address for a write tx: an explicitly configured account
// wins, otherwise fall back to the browser-injected global. Throws a clear
// error instead of letting `undefined` reach TronWeb as a cryptic failure
// (and is safe to evaluate in Node, where `window` is not defined).
export const getDefaultAccount = () => {
  if (tronObj.defaultAccount) return tronObj.defaultAccount;
  if (typeof window !== "undefined" && window?.defaultAccount) {
    return window.defaultAccount;
  }
  throw new Error(
    "No sender address configured: set tronObj.defaultAccount (Node) or " +
      "window.defaultAccount (browser) before sending a transaction",
  );
};

export const getNetworkType = () => {
  // An explicit, validated override wins over host inference. This is required
  // for operator-controlled proxies/private nodes whose hostname does not prove
  // which chain they serve.
  if (tronObj.network !== null && tronObj.network !== undefined && tronObj.network !== "") {
    const explicit = String(tronObj.network).trim().toLowerCase();
    if (!["main", "nile", "shasta"].includes(explicit)) {
      throw new Error(
        `Unsupported tronObj.network "${tronObj.network}": expected main, nile, or shasta`,
      );
    }
    return explicit;
  }

  const host = tronObj.tronWeb?.fullNode?.host;
  if (typeof host !== "string" || !host.trim()) {
    throw new Error(
      "Unable to infer TRON network from an empty provider host; set tronObj.network explicitly",
    );
  }

  let hostname;
  try {
    hostname = new URL(host).hostname.toLowerCase();
  } catch {
    throw new Error(
      `Unable to infer TRON network from provider host "${host}"; set tronObj.network explicitly`,
    );
  }

  if (["api.trongrid.io", "api.tronstack.io"].includes(hostname)) return "main";
  if (hostname === "nile.trongrid.io") return "nile";
  if (["api.shasta.trongrid.io", "shasta.trongrid.io"].includes(hostname)) return "shasta";

  throw new Error(
    `Unknown TRON provider host "${hostname}"; set tronObj.network explicitly before using contract helpers`,
  );
};

export const triggerSmartContract = async (
  address,
  functionSelector,
  options = {},
  parameters = [],
  issuerAddress = getDefaultAccount(),
  extension,
  revertCheck = false,
) => {
  try {
    let walletTronWeb = tronObj?.tronWeb;
    if (!walletTronWeb) return;

    if (revertCheck) {
      const transaction =
        await walletTronWeb.transactionBuilder.triggerConstantContract(
          address,
          functionSelector,
          Object.assign({ feeLimit: Config.feeLimit }, options),
          parameters,
          issuerAddress,
        );

      const constant_result =
        transaction?.constant_result && transaction.constant_result[0];
      if (
        constant_result &&
        TronWebUtils.bytes.hextoString(constant_result)?.indexOf("REVERT") > -1
      ) {
        throw new Error("REVERT");
      }
    }

    const transaction =
      await walletTronWeb.transactionBuilder.triggerSmartContract(
        address,
        functionSelector,
        Object.assign({ feeLimit: Config.feeLimit }, options),
        parameters,
        issuerAddress,
      );

    if (extension) {
      const payload = transaction.transaction.__payload__;
      transaction.transaction =
        await walletTronWeb.transactionBuilder.extendExpiration(
          transaction.transaction,
          extension,
        );
      if (payload) {
        transaction.transaction.__payload__ = payload;
      }
    }

    if (!transaction.result || !transaction.result.result) {
      throw new Error(
        "Unknown trigger error: " + JSON.stringify(transaction.transaction),
      );
    }
    return transaction;
  } catch (error) {
    throw error;
  }
};

export const sendRawTransaction = async (signedTransaction) => {
  try {
    const result =
      await tronObj.tronWeb.trx.sendRawTransaction(signedTransaction);
    return result;
  } catch (error) {
    throw error;
  }
};

export const sign = async (transaction) => {
  try {
    const tronweb = tronObj.tronWeb;
    const signedTransaction = await tronweb.trx.sign(
      transaction?.transaction || transaction,
    );
    return signedTransaction;
  } catch (error) {
    console.log(error, "signerr");
    throw error;
  }
};

export const triggerV2 = async (
  address,
  functionSelector,
  parameters = [],
  options = {},
  extension = false,
) => {
  try {
    const preExecOptions = Object.assign({ feeLimit: Config.feeLimit, _isConstant: true }, options);
    await triggerSmartContract(address, functionSelector, preExecOptions, parameters);
  } catch (preError) {
    console.error(`Pre-execution error ${address}`, preError);
    throw preError;
  }
  try {
    const transaction = await triggerSmartContract(
      address,
      functionSelector,
      Object.assign({ feeLimit: Config.feeLimit }, options),
      parameters,
      addressToHex(getDefaultAccount()),
      extension,
      true,
    );
    const signedTransaction = await sign(transaction);
    const result = await sendRawTransaction(signedTransaction);

    // TronWeb 6's sendRawTransaction returns `{ ...result, transaction: signed }`
    // on BOTH success and failure — so `transaction.txID` always exists and is a
    // false success signal. The node's broadcast verdict is `result.result === true`;
    // use it as the sole criterion (fail-closed) and surface the failure code.
    if (!result?.result) {
      const reason = result?.code || result?.message || "broadcast rejected by node";
      throw new Error(`Broadcast failed: ${reason} — ${JSON.stringify(result)}`);
    }

    return result;
  } catch (error) {
    console.error(`triggerV2 error: ${error?.message ?? error}`);
    throw error;
  }
};

export const view = async (address, functionSelector, parameters = []) => {
  try {
    let walletTronWeb = tronObj?.tronWeb;
    const result = await walletTronWeb.transactionBuilder.triggerSmartContract(
      address,
      functionSelector,
      { _isConstant: true },
      parameters,
    );
    return result && result.result ? result.constant_result : [];
  } catch (error) {
    console.log(
      `view error ${address} - ${functionSelector}`,
      error.message ? error.message : error,
    );
    return [];
  }
};

export const triggerEnergy = async (
  address,
  functionSelector,
  parameters = [],
  options = {},
) => {
  try {
    const transaction = await triggerSmartContract(
      address,
      functionSelector,
      Object.assign({ feeLimit: Config.feeLimit }, options),
      parameters,
    );

    return transaction;
  } catch (error) {
    console.log(
      `trigger error ${address} - ${functionSelector}`,
      error.message ? error.message : error,
    );
    return {};
  }
};

export const addressToHex = (addr) => {
  return tronObj.tronWeb.address.toHex(addr);
};

export const tronHexToAbiHex = (tronBase58) => {
  const tronHex = TronWeb.address.toHex(tronBase58);
  if (tronHex.startsWith("41")) {
    return "0x" + tronHex.slice(2);
  }
  return tronHex;
};

// Reject malformed token/spender/recipient addresses before they reach a
// signing path, with a clear error instead of a late, opaque TronWeb failure.
export const assertTronAddress = (addr, label = "address") => {
  if (!TronWeb.isAddress(addr)) {
    throw new Error(`Invalid TRON ${label}: ${addr}`);
  }
  return addr;
};
