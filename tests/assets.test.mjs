/** The suite for `app/js/assets/registry.js`: the pinned mainnet entries, the load-time invariants `validateRegistry` enforces, and the lookups and payable-address checks derived from it. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ASSETS,
	ASSET_FAMILIES,
	ASSET_REGISTRY,
	assetsOnChain,
	assetFamily,
	DEFAULT_CHAIN_ID,
	getAsset,
	isAssetFamily,
	isSupportedAsset,
	isSupportedChain,
	requireAsset,
	requireAssetFamily,
	requireChain,
	requireEvmChain,
	requirePayableAddress,
	SUPPORTED_CHAIN_IDS,
	SUPPORTED_EVM_CHAIN_IDS,
	UnpayableAddressError,
	UnsupportedAssetError,
	UnsupportedAssetFamilyError,
	UnsupportedChainError,
	UnsupportedEvmChainError,
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

test("the registry ships the Ethereum mainnet assets and the two privacy-chain native coins", () => {
	assert.deepEqual(Object.keys(ASSET_REGISTRY), ["eth", "usdc", "usdt", "zec", "xmr"]);
	assert.equal(DEFAULT_CHAIN_ID, "0x1", "the default stays the first registry entry");
	assert.deepEqual([...SUPPORTED_CHAIN_IDS], ["0x1", "zcash", "monero"]);
	assert.deepEqual([...SUPPORTED_EVM_CHAIN_IDS], ["0x1"], "a privacy chain's slug is not an EVM chain id");

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

	// The two privacy chains are the chain's own coin, paid on the network slug their family spells and over that family's address grammar.
	const zec = requireAsset("zec");
	assert.equal(zec.symbol, "ZEC");
	assert.equal(zec.name, "Zcash");
	assert.equal(zec.decimals, 8);
	assert.equal(zec.family, "zcash");
	assert.equal(zec.kind, "native");
	assert.equal(zec.address, null);
	assert.equal(zec.chainId, "zcash");

	const xmr = requireAsset("xmr");
	assert.equal(xmr.symbol, "XMR");
	assert.equal(xmr.name, "Monero");
	assert.equal(xmr.decimals, 12);
	assert.equal(xmr.family, "monero");
	assert.equal(xmr.kind, "native");
	assert.equal(xmr.address, null);
	assert.equal(xmr.chainId, "monero");
});

test("every registry entry is internally consistent", () => {
	for (const [key, asset] of Object.entries(ASSET_REGISTRY)) {
		assert.equal(asset.id, key, "the key is the id an invoice stores");
		assert.ok(Number.isInteger(asset.decimals) && asset.decimals >= 0);
		assert.ok(["evm", "zcash", "monero"].includes(asset.family), `${key} states a family a rule knows`);
		if (asset.family === "evm") {
			assert.match(asset.chainId, CANONICAL_CHAIN_ID, `${key} is an EVM asset, paid on a canonical chain id`);
		} else {
			assert.equal(asset.chainId, asset.family, `${key} is paid on the network slug its own family spells`);
		}
		assert.ok(asset.symbol.length > 0 && asset.name.length > 0);
		if (asset.kind === "native") {
			assert.equal(asset.address, null);
		} else {
			assert.ok(isAddress(asset.address), `${key} contract address`);
			assert.equal(asset.address, toChecksumAddress(asset.address));
		}
	}
	assert.equal(ASSETS.length, 5);
	assert.ok(ASSETS.includes(ASSET_REGISTRY.eth));
	assert.ok(ASSETS.includes(ASSET_REGISTRY.zec) && ASSETS.includes(ASSET_REGISTRY.xmr));
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
	assert.throws(() => requireAsset("dai"), /unsupported asset "dai" — expected one of eth, usdc, usdt, zec, xmr/);
	assert.throws(() => requireAsset("__proto__"), UnsupportedAssetError);
});

test("the registry resolves an asset's family once, for every reader that acts on it", () => {
	// `payment/links.ts` picks a link's scheme with this resolution and `wallet/payment.ts` decides the injected-wallet path with it, so what it returns is what those readers act on: a stated name, the EVM default for an absent field, and a typed refusal — never an unresolved value a switch of theirs could fall out of.
	for (const [entry, family] of [
		[{ family: "evm" }, "evm"],
		[{ family: "zcash" }, "zcash"],
		[{ family: "monero" }, "monero"],
		[{}, "evm"],
		[{ family: undefined }, "evm"],
	]) {
		assert.equal(requireAssetFamily(entry), family, JSON.stringify(entry));
		assert.equal(requireAssetFamily(entry), assetFamily(entry), "the resolution narrows what `assetFamily` resolves");
	}
	for (const asset of ASSETS) {
		assert.equal(requireAssetFamily(asset), asset.family, `${asset.id} resolves to the family its own entry states`);
	}

	// A stated family no rule carries is refused by name — an explicit `null` included — with this module's own typed class, so a reader never has to read a message to tell a refusal from an unresolved value.
	for (const family of ["bitcoin", "", "Zcash", 42, true, {}, null]) {
		assert.throws(() => requireAssetFamily({ family }), UnsupportedAssetFamilyError, JSON.stringify(family));
	}
	assert.throws(
		() => requireAssetFamily({ family: "bitcoin" }),
		/assets: unsupported asset family "bitcoin" — expected one of evm, zcash, monero/,
	);
	assert.throws(() => requireAssetFamily({ family: null }), /assets: unsupported asset family null — expected one of evm, zcash, monero/);

	// The name set is one statement: the predicate that resolution judges with and the map the load-time gate checks are the same object, so the two cannot admit different names.
	for (const name of Object.keys(ASSET_FAMILIES)) {
		assert.equal(isAssetFamily(name), true, name);
	}
	for (const value of ["Zcash", "erc-20", "", 42, true, null, undefined, {}, "constructor", "toString"]) {
		assert.equal(isAssetFamily(value), false, JSON.stringify(value));
	}
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
	assert.equal(isSupportedChain("zcash"), true, "a privacy chain's network is supported too");
	assert.equal(requireChain("zcash"), "zcash");
	assert.equal(requireChain("monero"), "monero");
	assert.throws(() => requireChain("0x89"), UnsupportedChainError);
	assert.throws(() => requireChain("0x89"), /unsupported chain "0x89" — expected one of 0x1, zcash, monero/);
});

test("assetsOnChain filters by chain id", () => {
	assert.deepEqual(
		assetsOnChain("0x1").map((asset) => asset.id),
		["eth", "usdc", "usdt"],
	);
	assert.deepEqual(
		assetsOnChain("zcash").map((asset) => asset.id),
		["zec"],
		"a privacy chain's assets are found under its own network slug",
	);
	assert.deepEqual(assetsOnChain("monero").map((asset) => asset.id), ["xmr"]);
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
	for (const chainId of [1, null, {}, true]) {
		assert.throws(
			() => validateRegistry({ bad: { ...erc20Asset("bad", "0x1", USDC), chainId } }),
			/non-canonical chain id/,
			`chainId ${String(chainId)}`,
		);
	}
	assert.doesNotThrow(() => validateRegistry({ ok: erc20Asset("ok", "0x1", USDC) }));
});

test("validateRegistry rejects a key that does not match the entry's id", () => {
	assert.throws(
		() => validateRegistry({ eth: erc20Asset("ether", "0x1", USDC) }),
		/registry key "eth" does not match the asset id "ether"/,
	);
	assert.doesNotThrow(() => validateRegistry({ ether: erc20Asset("ether", "0x1", USDC) }));
});

test("validateRegistry rejects a native asset that carries a contract address", () => {
	for (const address of [USDC, USDC_LOWER, ZERO_ADDRESS]) {
		assert.throws(
			() => validateRegistry({ bad: { ...nativeAsset("bad", "0x1"), address } }),
			/native bad must not carry a contract address/,
			address,
		);
	}
	assert.doesNotThrow(() => validateRegistry({ ok: { ...nativeAsset("ok", "0x1"), address: null } }));
});

test("validateRegistry rejects an ERC-20 address that is not a contract address or is not EIP-55 checksummed", () => {
	// A uniformly-cased spelling is a well-formed address but carries no checksum, so it is refused here and the error names the checksummed spelling to paste instead.
	assert.throws(
		() => validateRegistry({ bad: erc20Asset("bad", "0x1", USDC_LOWER) }),
		/assets: bad address must be EIP-55 checksummed, expected 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, got 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/,
	);
	// The same address with one letter's case flipped: still a well-formed 40-hex address, but no longer the spelling its own checksum encodes.
	const brokenChecksum = `0xa${USDC.slice(3)}`;
	assert.notEqual(brokenChecksum, toChecksumAddress(brokenChecksum), "a mixed-case spelling whose checksum contradicts it");
	assert.throws(() => validateRegistry({ bad: erc20Asset("bad", "0x1", brokenChecksum) }), /must be EIP-55 checksummed/);

	for (const address of ["", "0x1234", USDC.slice(0, 41), USDC.slice(0, 40)]) {
		assert.throws(
			() => validateRegistry({ bad: { ...erc20Asset("bad", "0x1", USDC), address } }),
			/needs a 0x-prefixed 40-hex contract address/,
			JSON.stringify(address),
		);
	}
	assert.doesNotThrow(() => validateRegistry({ ok: erc20Asset("ok", "0x1", USDC) }));
});

test("validateRegistry rejects decimals outside 0–255", () => {
	for (const decimals of [-1, 256, 1.5, "18", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(
			() => validateRegistry({ bad: { ...erc20Asset("bad", "0x1", USDC), decimals } }),
			/invalid decimals/,
			`decimals ${String(decimals)}`,
		);
	}
	assert.doesNotThrow(() => validateRegistry({ ok: { ...erc20Asset("ok", "0x1", USDC), decimals: 0 } }));
	assert.doesNotThrow(() => validateRegistry({ ok: { ...erc20Asset("ok", "0x1", USDC), decimals: 255 } }));
});

test("validateRegistry rejects a kind no kind rule admits", () => {
	// The dispatcher's token-contract guard is keyed on `kind`, so a misspelled one has to fail here rather than pass load and then skip that guard.
	for (const kind of ["erc21", "ERC-20", "", 42, null, true, {}, undefined]) {
		assert.throws(
			() => validateRegistry({ bad: { ...erc20Asset("bad", "0x1", USDC), kind } }),
			/unknown kind/,
			`kind ${String(kind)}`,
		);
	}
	assert.throws(
		() => validateRegistry({ bad: { ...erc20Asset("bad", "0x1", USDC), kind: "erc21" } }),
		/assets: bad has an unknown kind "erc21" — expected one of native, erc20/,
	);
	assert.doesNotThrow(() => validateRegistry({ ok: erc20Asset("ok", "0x1", USDC) }));
	assert.doesNotThrow(() => validateRegistry({ ok: nativeAsset("ok", "0x1") }));
});

test("validateRegistry reports a malformed entry with its own error, not an engine TypeError", () => {
	for (const [entry, expected] of [
		[null, /registry entry "bad" must be an asset object, got null/],
		[42, /registry entry "bad" must be an asset object, got 42/],
		[{ ...erc20Asset("bad", "0x1", USDC), id: 7 }, /registry entry "bad" must carry a string id, got 7/],
		[{ ...erc20Asset("bad", "0x1", USDC), address: 42 }, /assets: bad has a non-string address 42/],
		[{ ...erc20Asset("bad", "0x1", USDC), address: null }, /needs a 0x-prefixed 40-hex contract address/],
	]) {
		assert.throws(() => validateRegistry({ bad: entry }), expected, JSON.stringify(entry));
	}
});

test("validateRegistry rejects a family no family rule admits and defaults an absent one to EVM", () => {
	// The families the payout-address dispatcher has rules for are the ones an entry may state, so a misspelled one fails at load instead of inside the dispatcher once a user has pasted an address.
	// Each family is admitted on the network that family spells: an EVM entry on an EVM chain id, a privacy family on its own slug.
	for (const [family, chainId] of [["evm", "0x1"], ["zcash", "zcash"], ["monero", "monero"]]) {
		assert.doesNotThrow(
			() => validateRegistry({ ok: { ...nativeAsset("ok", chainId), family } }),
			`family ${family}`,
		);
	}

	// An entry that states no family is the default EVM one, and the load-time gate reads that default through the same resolution the payout-address dispatcher applies — so an entry this gate admits is not one the dispatcher then refuses. Only an absent field is "no family stated".
	assert.equal(assetFamily({}), "evm");
	assert.equal(assetFamily({ family: undefined }), "evm");
	assert.equal(assetFamily({ family: "monero" }), "monero");
	assert.doesNotThrow(() => validateRegistry({ ok: erc20Asset("ok", "0x1", USDC) }));
	assert.doesNotThrow(() => validateRegistry({ ok: nativeAsset("ok", "0x1") }));

	// A stated family that is not a name is a malformed statement rather than a missing one: an explicit `null` is passed through as stated, so it reaches the same refusal as any other value that is not a family name instead of being read as the absence of one.
	assert.equal(assetFamily({ family: null }), null);
	assert.throws(
		() => validateRegistry({ bad: { ...erc20Asset("bad", "0x1", USDC), family: null } }),
		/assets: bad has an unknown family null — expected one of evm, zcash, monero, or no family for the default evm/,
	);

	for (const family of ["Zcash", "erc-20", "bitcoin", "", 42, true, {}, null]) {
		assert.throws(
			() => validateRegistry({ bad: { ...erc20Asset("bad", "0x1", USDC), family } }),
			/unknown family/,
			`family ${JSON.stringify(family)}`,
		);
	}
	assert.throws(
		() => validateRegistry({ bad: { ...erc20Asset("bad", "0x1", USDC), family: "bitcoin" } }),
		/assets: bad has an unknown family "bitcoin" — expected one of evm, zcash, monero, or no family for the default evm/,
	);

	// The family is validated like every other field, so the entry's own checks still run after it.
	assert.throws(
		() => validateRegistry({ bad: { ...erc20Asset("bad", "0x1", USDC), family: "evm", decimals: -1 } }),
		/invalid decimals/,
	);
});

test("validateRegistry refuses a non-EVM family entry that classifies itself as a contract token", () => {
	// The family is what the dispatcher validates a payee against, and only an EVM asset is paid by a transfer to a contract, so an entry that states a privacy family yet classifies itself as an erc20, or carries a contract address, would be validated as that family's native payee while the payment path read the contract address as a token.
	assert.throws(
		() => validateRegistry({ zec: { ...erc20Asset("zec", "zcash", USDC), family: "zcash" } }),
		/assets: zec states the non-EVM family "zcash" with kind "erc20" — a non-EVM asset must be kind "native"/,
	);
	assert.throws(
		() => validateRegistry({ xmr: { ...nativeAsset("xmr", "monero"), family: "monero", address: USDC } }),
		/assets: xmr states the non-EVM family "monero" with a contract address "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" — a non-EVM asset must carry no contract address/,
	);
	// The native coin of a privacy family is admitted on its own network: kind "native" and no contract address.
	assert.doesNotThrow(() => validateRegistry({ zec: { ...nativeAsset("zec", "zcash"), family: "zcash" } }));
	assert.doesNotThrow(() => validateRegistry({ xmr: { ...nativeAsset("xmr", "monero"), family: "monero" } }));
	// An EVM entry may still be a contract token.
	assert.doesNotThrow(() => validateRegistry({ usdc: { ...erc20Asset("usdc", "0x1", USDC), family: "evm" } }));
});

test("a non-EVM family is bound to the one network slug it spells", () => {
	// The family picks the address rules and the payment path, the slug is the network the invoice names; they are two statements about one entry, so an entry whose statements disagree is refused rather than paid on a network its address grammar does not belong to.
	assert.doesNotThrow(() => validateRegistry({ zec: { ...nativeAsset("zec", "zcash"), family: "zcash" } }));
	assert.doesNotThrow(() => validateRegistry({ xmr: { ...nativeAsset("xmr", "monero"), family: "monero" } }));
	assert.throws(
		() => validateRegistry({ zec: { ...nativeAsset("zec", "0x1"), family: "zcash" } }),
		/assets: zec states the zcash family on the network "0x1" — expected the zcash network slug "zcash"/,
		"an EVM chain id cannot carry a privacy family",
	);
	assert.throws(
		() => validateRegistry({ zec: { ...nativeAsset("zec", "monero"), family: "zcash" } }),
		/expected the zcash network slug "zcash"/,
		"another family's slug is not this family's network",
	);
	// An EVM entry keeps the canonical chain id the wallet flow needs, so a network slug under the EVM family fails as the non-canonical id it is.
	assert.throws(() => validateRegistry({ eth: nativeAsset("eth", "zcash") }), /non-canonical chain id/);
	assert.doesNotThrow(() => validateRegistry({ eth: nativeAsset("eth", "0x1") }));
});

test("the shipped privacy-chain entries collide with no transfer target", () => {
	// The duplicate-target key is the EVM transfer target read as the entry states its network, so the two distinct slugs and the absent contract addresses key the new entries as `zcash:` and `monero:` — keys no other entry can hold. That is what keeps the check from blocking them; the rule the key exists for still fires for two EVM entries claiming one target.
	assert.doesNotThrow(() => validateRegistry(ASSET_REGISTRY));
	const targets = ASSETS.map((asset) => `${asset.chainId}:${asset.address ?? ""}`);
	assert.equal(new Set(targets).size, targets.length, "every shipped entry pays a distinct target");
	assert.ok(targets.includes("zcash:") && targets.includes("monero:"), "a privacy-chain coin is keyed by its own network slug");
});

test("requireEvmChain keeps the EVM chain ids and refuses a privacy chain by name", () => {
	assert.equal(requireEvmChain("0x1"), "0x1");
	assert.equal(requireEvmChain(DEFAULT_CHAIN_ID), "0x1");
	for (const slug of ["zcash", "monero"]) {
		assert.throws(() => requireEvmChain(slug), UnsupportedEvmChainError, slug);
		assert.throws(() => requireEvmChain(slug), /expected an EVM chain, one of 0x1/, slug);
	}
	// An unknown network keeps the unsupported-chain refusal, so the two mistakes stay separable by class.
	assert.throws(() => requireEvmChain("0x89"), UnsupportedChainError);
	assert.throws(() => requireEvmChain("0x89"), /unsupported chain "0x89"/);
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
