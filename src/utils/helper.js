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
import bigNumber from "bignumber.js";
import { tronObj } from "./blockchain";

// Resolve the current provider at call time. Browser integrations replace
// tronObj.tronWeb after connecting a wallet; module-scope caching would keep
// reads pointed at the fallback RPC/network.
const getTronWeb = () => tronObj.tronWeb;

bigNumber.config({ EXPONENTIAL_AT: 1e9 });
bigNumber.prototype._toFixed = function (...arg) {
  return new bigNumber(this.toFixed(...arg)).toString();
};
bigNumber.prototype._toFixedNew = function (...arg) {
  return new bigNumber(this).isNaN()
    ? "0"
    : new bigNumber(this.toFixed(...arg)).toString();
};
bigNumber.prototype._toBg = function () {
  return this;
};
bigNumber.prototype._toHex = function () {
  return `0x${this.toString(16)}`;
};

export const toBigNumber = (...args) => getTronWeb().toBigNumber(...args);

export const BigNumber = bigNumber;

export const toDecimal = (...args) => getTronWeb().toDecimal(...args);

export const getTrxBalance = async (address) => {
  return await getTronWeb().trx.getUnconfirmedBalance(address);
};

export const getAccount = async (address) => {
  return await getTronWeb().trx.getAccount(address);
};

export const formatNumber = (
  number,
  decimals = false,
  {
    cutZero = true,
    miniText = false,
    miniTextValue = miniText,
    needDolar = false,
    round = false,
    per = false,
    uint = false,
    showNegative = false,
    defaultSymbol = false,
    reverseMiniTextDolarSymbolOrder = false,
    roundMode = "", //'ROUND_HALF_UP'
  } = {},
) => {
  if (number === "--" || BigNumber(number).isNaN()) return "--";
  if (defaultSymbol && !BigNumber(number).gt(0)) return "--";

  if (
    ((!number && !BigNumber(number).eq(0)) || BigNumber(number).lt(0)) &&
    !showNegative
  ) {
    // if (!number || BigNumber(number).lte(0)) {
    if (needDolar) {
      if (reverseMiniTextDolarSymbolOrder) return "$< 0.01";
      return "< $0.01";
    } else if (per) {
      return "< 1";
    } else {
      return "< 0.001";
    }
  }

  if ((BigNumber(number).lt(0) && uint) || BigNumber(number).eq(0)) {
    return `${needDolar ? "$" : ""}0`;
  }

  if (miniText || miniText === 0) {
    // if (BigNumber(number).gte(0) && BigNumber(number).lt(miniText)) {
    if (!BigNumber(number).gte(miniText) && !showNegative) {
      if (reverseMiniTextDolarSymbolOrder)
        return `${needDolar ? "$" : ""}< ${miniTextValue ? miniTextValue : miniText}`;
      return `< ${needDolar ? "$" : ""}${miniTextValue ? miniTextValue : miniText}`;
    }
    if (showNegative) {
      const negativeMiniText = BigNumber(0).minus(miniText);
      if (
        !BigNumber(number).gte(miniText) &&
        BigNumber(number).gt(negativeMiniText)
      ) {
        if (reverseMiniTextDolarSymbolOrder)
          return `${needDolar ? "$" : ""}< ${miniTextValue ? miniTextValue : miniText}`;
        return `< ${needDolar ? "$" : ""}${miniTextValue ? miniTextValue : miniText}`;
      }
    }
  }

  const tronWeb = getTronWeb();
  tronWeb.BigNumber.config({
    ROUNDING_MODE: tronWeb.BigNumber.ROUND_HALF_UP,
    FORMAT: {
      decimalSeparator: ".",
      groupSeparator: per ? "" : ",",
      groupSize: 3,
    },
  });
  let object = toBigNumber(number);

  // If rounding, use BigNumber's .toFormat() method
  // if (round) return decimals ? object.toFormat(decimals) : object.toFormat();

  if (decimals || decimals === 0) {
    decimals = Number(decimals);
    const d = toBigNumber(10).pow(decimals);
    let property = tronWeb.BigNumber.ROUND_DOWN;
    if (round) {
      property = tronWeb.BigNumber.ROUND_HALF_UP;
      if (roundMode) property = tronWeb.BigNumber[roundMode];
    }
    object = object.times(d).integerValue(property).div(d).toFixed(decimals);
  } else {
    object = object.valueOf();
  }
  const parts = object.toString().split(".");
  if (cutZero) {
    parts[1] = parts[1] ? parts[1].replace(/0+?$/, "") : "";
  }

  let res =
    parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (parts[1] ? `.${parts[1]}` : "");

  if (per) {
    res = parts[0] + (parts[1] ? `.${parts[1]}` : "");
  }

  if (isNaN(parseFloat(res))) {
    res = 0;
  }

  if (
    needDolar &&
    (((miniText || miniText === 0) && BigNumber(number).gte(miniText)) ||
      !miniText)
  ) {
    res = "$" + res;
  }

  return res;
};

// Sole entry point that turns a human-readable token amount into a uint256
// ABI value (deposit/redeem/supply/withdraw/borrow/repay/liquidate). Guard the
// boundary so malformed input can't reach the signing path:
//  - decimals must be a finite non-negative integer (it often comes from an
//    untrusted on-chain decimals() read); NaN/undefined -> 10^NaN = NaN
//  - amount must be finite and non-negative; a leading '-' would otherwise flow
//    to uint256 encoding and two's-complement wrap (approve -> ~MAX_UINT256)
//  - floor any sub-decimal precision (ROUND_DOWN) and emit an integer string,
//    never a fractional "0.1" that breaks ABI encoding
export const toChainAmount = (amount, decimals) => {
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 77) {
    throw new Error(`toChainAmount: invalid decimals ${decimals}`);
  }
  const a = new BigNumber(amount);
  if (!a.isFinite() || a.lt(0)) {
    throw new Error(`toChainAmount: invalid amount ${amount}`);
  }
  return a
    .times(new BigNumber(10).pow(d))
    .integerValue(BigNumber.ROUND_DOWN)
    .toFixed(0);
};
