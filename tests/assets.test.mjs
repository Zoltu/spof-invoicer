/** The suite for `app/js/assets/registry.js`: the pinned mainnet entries, the load-time invariants `validateRegistry` enforces, and the lookups and payable-address checks derived from it. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ASSETS,
	ASSET_REGISTRY,
	assetsOnChain,
	DEFAULT_CHAIN_ID,
	getAsset,
	isSupportedAsset,
	isSupportedChain,
	requireAsset,
	requireChain,
	requirePayableAddress,
	SUPPORTED_CHAIN_IDS,
	UnpayableAddressError,
	UnsupportedAssetError,
	UnsupportedChainError,
	validateRegistry,
} from "../app/js/assets/registry.js";
import { isAddress, toChecksumAddress, ZERO_ADDRESS } from "../app/js/wallet/address.js";
import { USDC, USDC_LOWER, USDT } from "./helpers/tokens.mjs";

const CANONICAL_CHAIN_ID = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;

function nativeAsset(id, chainId) {
	return { id, symbol: id.toUpperCase(), name: id, chainId, decimals: 18, kind: "native", address: null };
}

function erc20Asset(id, chainId, address) {
	return { id, symbol: id.toUpperCase(), name: id, chainId, decimals: 6, kind: "erc20", address };
}

test("mainnet ships ETH, USDC, and USDT", () => {
	assert.deepEqual(Object.keys(ASSET_REGISTRY), ["eth", "usdc", "usdt"]);
	assert.equal(DEFAULT_CHAIN_ID, "0x1");
	assert.deepEqual([...SUPPORTED_CHAIN_IDS], ["0x1"]);

	const eth = requireAsset("eth");
	assert.equal(eth.symbol, "ETH");
	assert.equal(eth.decimals, 18);
	assert.equal(eth.kind, "native");
	assert.equal(eth.address, null);
	assert.equal(eth.chainId, "0x1");

	const usdc = requireAsset("usdc");
	assert.equal(usdc.symbol, "USDC");
	assert.equal(usdc.name, "USD Coin");
	assert.equal(usdc.decimals, 6);
	assert.equal(usdc.kind, "erc20");
	assert.equal(usdc.address, USDC);
	assert.equal(usdc.chainId, "0x1");

	const usdt = requireAsset("usdt");
	assert.equal(usdt.symbol, "USDT");
	assert.equal(usdt.decimals, 6);
	assert.equal(usdt.kind, "erc20");
	assert.equal(usdt.address, USDT);
});

test("every registry entry is internally consistent", () => {
	for (const [key, asset] of Object.entries(ASSET_REGISTRY)) {
		assert.equal(asset.id, key, "the key is the id an invoice stores");
		assert.ok(Number.isInteger(asset.decimals) && asset.decimals >= 0);
		assert.match(asset.chainId, CANONICAL_CHAIN_ID);
		assert.ok(asset.symbol.length > 0 && asset.name.length > 0);
		if (asset.kind === "native") {
			assert.equal(asset.address, null);
		} else {
			assert.ok(isAddress(asset.address), `${key} contract address`);
			assert.equal(asset.address, toChecksumAddress(asset.address));
		}
	}
	assert.equal(ASSETS.length, 3);
	assert.ok(ASSETS.includes(ASSET_REGISTRY.eth));
});

test("the registry and every nested entry are frozen", () => {
	assert.ok(Object.isFrozen(ASSET_REGISTRY));
	assert.ok(Object.isFrozen(ASSETS));
	assert.ok(ASSETS.every(Object.isFrozen), "each asset object is deep-frozen, not just the registry");
	assert.ok(Object.isFrozen(ASSET_REGISTRY.usdc));

	assert.throws(() => {
		ASSET_REGISTRY.usdc = null;
	}, TypeError);
	assert.throws(() => {
		ASSET_REGISTRY.usdc.address = ZERO_ADDRESS;
	}, TypeError);
	assert.equal(requireAsset("usdc").address, USDC, "a rejected nested write leaves the entry intact");
	assert.equal(requireAsset("eth").symbol, "ETH", "a rejected write leaves the registry intact");
});

test("lookups are exact and null-safe", () => {
	assert.equal(getAsset("eth"), ASSET_REGISTRY.eth);
	assert.equal(getAsset("ETH"), undefined, "ids are lower case");
	assert.equal(getAsset("dai"), undefined);
	assert.equal(getAsset(""), undefined);
	assert.equal(getAsset("__proto__"), undefined, "prototype keys are not assets");
	assert.equal(getAsset("constructor"), undefined);
	assert.equal(getAsset("toString"), undefined);
	assert.equal(isSupportedAsset("usdc"), true);
	assert.equal(isSupportedAsset("usdc "), false);
});

test("requireAsset throws a typed error naming the supported ids", () => {
	assert.throws(() => requireAsset("dai"), UnsupportedAssetError);
	assert.throws(() => requireAsset("dai"), /unsupported asset "dai" — expected one of eth, usdc, usdt/);
	assert.throws(() => requireAsset("__proto__"), UnsupportedAssetError);
});

test("requirePayableAddress rejects the zero address and the token's own contract", () => {
	const usdc = requireAsset("usdc");
	const eth = requireAsset("eth");
	const recipient = "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb";

	assert.equal(requirePayableAddress(recipient, usdc), recipient.toLowerCase());
	assert.equal(
		requirePayableAddress(recipient, eth),
		recipient.toLowerCase(),
		"a contract address may still receive the native coin",
	);

	assert.throws(() => requirePayableAddress(ZERO_ADDRESS, usdc), UnpayableAddressError);
	assert.throws(() => requirePayableAddress(ZERO_ADDRESS, usdc), /zero address burns the transfer/);
	assert.throws(() => requirePayableAddress(USDC, usdc), UnpayableAddressError);
	assert.throws(() => requirePayableAddress(USDC, usdc), /own contract address/);
	assert.throws(() => requirePayableAddress(USDC_LOWER, usdc), /own contract address/, "casing does not matter");
	assert.throws(() => requirePayableAddress("0x1234", usdc), /expected a 0x-prefixed 40-hex address/);
});

test("chains are supported only where an asset exists", () => {
	assert.equal(isSupportedChain("0x1"), true);
	assert.equal(isSupportedChain("0x89"), false);
	assert.equal(isSupportedChain("1"), false);
	assert.equal(requireChain("0x1"), "0x1");
	assert.throws(() => requireChain("0x89"), UnsupportedChainError);
	assert.throws(() => requireChain("0x89"), /unsupported chain "0x89" — expected one of 0x1/);
});

test("assetsOnChain filters by chain id", () => {
	assert.deepEqual(
		assetsOnChain("0x1").map((asset) => asset.id),
		["eth", "usdc", "usdt"],
	);
	assert.deepEqual(assetsOnChain("0x89"), []);
});

test("validateRegistry rejects a non-canonical chain id", () => {
	for (const chainId of ["0x", "0X1", "1", "0x01", "0xG", ""]) {
		assert.throws(
			() => validateRegistry({ bad: erc20Asset("bad", chainId, USDC) }),
			/non-canonical chain id/,
			`chainId ${JSON.stringify(chainId)}`,
		);
	}
	assert.doesNotThrow(() => validateRegistry({ ok: erc20Asset("ok", "0x1", USDC) }));
});

test("validateRegistry rejects duplicate (chainId, address) pairs", () => {
	assert.throws(
		() => validateRegistry({ a: erc20Asset("a", "0x1", USDC), b: erc20Asset("b", "0x1", USDC) }),
		/duplicates the \(chainId, address\) pair/,
	);
	assert.throws(
		() => validateRegistry({ a: erc20Asset("a", "0x1", USDC), b: erc20Asset("b", "0x1", USDC_LOWER) }),
		/duplicates/,
		"the address comparison ignores casing",
	);
	assert.throws(
		() => validateRegistry({ a: nativeAsset("a", "0x1"), b: nativeAsset("b", "0x1") }),
		/duplicates/,
		"one native coin per chain",
	);
	assert.doesNotThrow(() => validateRegistry({ a: erc20Asset("a", "0x1", USDC), b: erc20Asset("b", "0x89", USDC) }));
});
