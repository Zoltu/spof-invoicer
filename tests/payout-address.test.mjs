/** The suite for `app/js/wallet/payout-address.js`: the family dispatch, the rules it shares with `assets/registry.js`'s loader — a non-EVM family's kind, contract address, and network, an EVM asset's stated `kind` and its EIP-55 checksummed contract address, a stated `decimals`, and the canonical EVM chain id — the default EVM family an asset stating none is read as, the EVM branch's two guards and the fail-closed token-contract check that keeps the second one from passing unread, total over the kinds that can reach it so no kind skips it by name and total over an asset that states no kind at all, which is refused rather than classified by the contract address it carries, its own clause for a non-string address, which the invoice validator wraps under the field path it read the value from, the address-shape clause it reads from `wallet/address.ts` rather than restating, the refusals of an address that belongs to another family, the mainnet unified address the Zcash branch accepts and the testnet one it refuses by name, the Zcash branch's TEX vector accepted and its testnet spelling refused by name, and the shape checks that keep a `null` or primitive asset and a non-string address inside the module's own error contract; the privacy-chain branches are driven with the minimal `family`-only assets they need, which is the one place this dispatcher is laxer than the loader, and the shape rules both readers apply as one statement — an asset the loader admits for its shape being one the dispatcher accepts, and the fault either reports being the other's own wording of the same rule. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSET_REGISTRY, UnpayableAddressError, validateRegistry } from "../app/js/assets/registry.js";
import { createInvoice } from "../app/js/invoice/model.js";
import { InvalidChecksumError, addressShapeMessage, normalizeAddress, toChecksumAddress } from "../app/js/wallet/address.js";
import { InvalidMoneroAddressError } from "../app/js/wallet/monero-address.js";
import { UnreadableTokenContractError, UnsupportedPayoutFamilyError, requirePayoutAddress } from "../app/js/wallet/payout-address.js";
import { InvalidZcashAddressError, TestnetTexAddressError, TestnetUnifiedAddressError } from "../app/js/wallet/zcash-address.js";
import { ZEC_TEX_PAYEE, ZEC_TEX_TESTNET_PAYEE } from "./helpers/payee-vectors.mjs";
import { refusalError, refusalMessage } from "./helpers/refusals.mjs";
import { USDC, USDC_LOWER } from "./helpers/tokens.mjs";

const EVM_ETH = ASSET_REGISTRY.eth;
const EVM_USDC = ASSET_REGISTRY.usdc;
const ZCASH = { family: "zcash" };
const MONERO = { family: "monero" };

/** The first EIP-55 vector: its checksummed spelling and the lower-case form a wallet sends. */
const PAYEE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const PAYEE_LOWER = PAYEE.toLowerCase();

/** The all-zero address, which a transfer must never target. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A mainnet Sapling address, one of the Zcash forms this module accepts. */
const ZCASH_ADDRESS = "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9slya";

/** A mainnet unified address: a Bech32m container the Zcash branch accepts on its checksum, human-readable part, and length, reading nothing behind it. */
const UNIFIED_ADDRESS = "u1qpatys4zruk99pg59gcscrt7y6akvl9vrhcfyhm9yxvxz7h87q6n8cgrzzpe9zru68uq39uhmlpp5uefxu0su5uqyqfe5zp3tycn0ecl";

/** A testnet unified address, which the Zcash branch refuses by name so no testnet container reaches a mainnet-only invoice. */
const UNIFIED_TESTNET = "utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s";

const MONERO_ADDRESS = "46BeWrHpwXmHDpDEUmZBWZfoQpdc6HaERCNmx1pEYL2rAcuwufPN9rXHHtyUA4QVy66qeFQkn6sfK8aHYjA3jk3o1Bv16em";

/** A mixed-case spelling of USDC whose checked case contradicts the EIP-55 checksum its body encodes. */
const USDC_BROKEN_CHECKSUM = `0xa${USDC.slice(3)}`;

/** The EVM branch's refusal of a non-string value: this module's own clause, which the invoice validator wraps under the field path it read the value from. */
const EVM_NON_STRING_CLAUSE = "must be a 0x-prefixed 40-hex payout address";

test("the EVM branch returns the checksummed address, keeping the invoice path's guards", () => {
	assert.equal(requirePayoutAddress(PAYEE, EVM_ETH), PAYEE);
	assert.equal(requirePayoutAddress(PAYEE_LOWER, EVM_ETH), PAYEE, "uniform case is re-encoded");
	assert.equal(requirePayoutAddress(PAYEE, EVM_USDC), PAYEE);

	assert.throws(() => requirePayoutAddress(USDC, EVM_USDC), UnpayableAddressError, "the token's own contract");
	assert.throws(() => requirePayoutAddress(ZERO_ADDRESS, EVM_USDC), UnpayableAddressError);
	assert.throws(() => requirePayoutAddress(`${PAYEE.slice(0, 3)}${PAYEE[3].toUpperCase()}${PAYEE.slice(4)}`, EVM_ETH), InvalidChecksumError);
	assert.throws(() => requirePayoutAddress("0x1234", EVM_ETH), /expected a 0x-prefixed 40-hex address/);
});

test("the Zcash and Monero branches validate against their own syntax", () => {
	assert.equal(requirePayoutAddress(ZCASH_ADDRESS, ZCASH), ZCASH_ADDRESS);
	assert.equal(requirePayoutAddress(MONERO_ADDRESS, MONERO), MONERO_ADDRESS);

	assert.equal(requirePayoutAddress(ZEC_TEX_PAYEE, ZCASH), ZEC_TEX_PAYEE, "a mainnet TEX address is a payable Zcash payee, stored in the spelling the payee wrote");
	assert.equal(requirePayoutAddress(ZEC_TEX_PAYEE.toUpperCase(), ZCASH), ZEC_TEX_PAYEE, "and either spelling BIP-173 gives it is the one address");
	assert.throws(() => requirePayoutAddress(ZEC_TEX_TESTNET_PAYEE, ZCASH), TestnetTexAddressError, "a testnet TEX address is refused by name");

	assert.equal(requirePayoutAddress(UNIFIED_ADDRESS, ZCASH), UNIFIED_ADDRESS, "a mainnet unified address is a payable Zcash payee");
	assert.equal(requirePayoutAddress(UNIFIED_ADDRESS.toUpperCase(), ZCASH), UNIFIED_ADDRESS, "and either spelling BIP-173 gives it is the one address");
	assert.throws(() => requirePayoutAddress(UNIFIED_TESTNET, ZCASH), TestnetUnifiedAddressError, "a testnet unified address is refused by name");

	assert.throws(() => requirePayoutAddress(PAYEE, ZCASH), InvalidZcashAddressError);
	assert.throws(() => requirePayoutAddress(PAYEE, MONERO), InvalidMoneroAddressError);
	assert.throws(() => requirePayoutAddress(MONERO_ADDRESS, ZCASH), InvalidZcashAddressError);
	assert.throws(() => requirePayoutAddress(ZCASH_ADDRESS, MONERO), InvalidMoneroAddressError);
	assert.throws(() => requirePayoutAddress(null, ZCASH), TypeError);
	assert.throws(() => requirePayoutAddress(null, MONERO), TypeError);
});

test("the invoice validator keeps the validator's own refusal as the cause of the field error it raises", () => {
	// The model words a payout-address refusal for the field a payee pasted into and wraps the message another module built; the class that raised it travels with the refusal, so a surface that acts on the kind of refusal — a network refusal, say — reads the class rather than matching the wording.
	const testnet = refusalError(() =>
		createInvoice({
			id: "INV-0001",
			issued: "2026-10-03",
			payee: { name: "Studio Example", address: UNIFIED_TESTNET },
			chainId: "zcash",
			asset: "zec",
			items: [{ description: "Design work", quantity: "2", unitPrice: "150.00" }],
		}),
	);
	assert.equal(testnet.name, "InvalidInvoiceError");
	assert.equal(testnet.path, "payee.address");
	assert.ok(testnet.cause instanceof TestnetUnifiedAddressError, "the cause is the class the Zcash validator raised for a testnet container");
	assert.ok(testnet.cause instanceof InvalidZcashAddressError, "and it is still catchable as the family's own refusal");

	// An EVM refusal travels the same way, so the boundary is not one family's special case.
	const checksum = refusalError(() =>
		createInvoice({
			id: "INV-0001",
			issued: "2026-10-03",
			payee: { name: "Studio Example", address: USDC_BROKEN_CHECKSUM },
			chainId: "0x1",
			asset: "usdc",
			items: [{ description: "Design work", quantity: "2", unitPrice: "150.00" }],
		}),
	);
	assert.equal(checksum.name, "InvalidInvoiceError");
	assert.ok(checksum.cause instanceof InvalidChecksumError, "the EVM branch's own checksum refusal is the cause of the field error");
});

test("the EVM branch refuses a non-string address with the invoice validator's own clause", () => {
	for (const value of [null, undefined, 42, {}, [], true]) {
		assert.throws(() => requirePayoutAddress(value, EVM_ETH), TypeError, String(value));
		assert.throws(() => requirePayoutAddress(value, EVM_ETH), /must be a 0x-prefixed 40-hex payout address, got /, String(value));
	}
	assert.equal(refusalMessage(() => requirePayoutAddress(42, EVM_ETH)), `${EVM_NON_STRING_CLAUSE}, got 42`);

	// The invoice path prefixes the same clause with the field path it read the value from, so a value refused by either validator reads the same to the user.
	const invoiceMessage = refusalMessage(() =>
		createInvoice({
			id: "INV-0001",
			issued: "2026-10-03",
			payee: { name: "Studio Example", address: 42 },
			chainId: "0x1",
			asset: "usdc",
			items: [{ description: "Design work", quantity: "2", unitPrice: "150.00" }],
		}),
	);
	assert.equal(invoiceMessage, `invoice: payee.address: ${refusalMessage(() => requirePayoutAddress(42, EVM_ETH))}`);
});

test("a non-string address for a privacy-chain family is refused by this module's own message", () => {
	for (const value of [null, undefined, 42, {}, [], true]) {
		for (const asset of [ZCASH, MONERO]) {
			assert.throws(() => requirePayoutAddress(value, asset), TypeError, String(value));
			assert.throws(() => requirePayoutAddress(value, asset), /payout-address: expected a payout address string, got/);
		}
	}
});

test("an asset that carries no known family is refused by this module's own message", () => {
	for (const asset of [null, undefined, 42, "zcash"]) {
		assert.throws(() => requirePayoutAddress(PAYEE, asset), TypeError);
		assert.throws(() => requirePayoutAddress(PAYEE, asset), /payout-address: expected an asset carrying a family, got/);
	}

	assert.throws(() => requirePayoutAddress(PAYEE, { family: 42 }), TypeError);
	assert.throws(() => requirePayoutAddress(PAYEE, { family: 42 }), /payout-address: expected an asset family of evm, zcash, monero, got 42/);

	// An asset stating no family is read through the registry's own resolution, which is the resolution the load-time gate admits such an entry by: the default EVM rules, not a refusal for a family the gate never required. Only an absent field states none; an explicit `null` is a family of the wrong type, refused here as the registry's load-time gate refuses it.
	assert.equal(requirePayoutAddress(PAYEE, { kind: "native" }), PAYEE);
	// Those default EVM rules require a stated kind, so a family-less asset carrying a contract address is refused for the kind it never states rather than inferred to be a token from the address.
	assert.throws(() => requirePayoutAddress(PAYEE, { address: USDC }), TypeError);
	assert.throws(() => requirePayoutAddress(PAYEE, { address: USDC }), /payout-address: expected an asset kind of native, erc20, got undefined/);
	// The default EVM rules still require an asset they can classify: a family-less asset that states no kind is refused, whether or not it carries a contract address.
	for (const asset of [{}, [], { address: null }]) {
		assert.throws(() => requirePayoutAddress(PAYEE, asset), TypeError, JSON.stringify(asset));
		assert.throws(() => requirePayoutAddress(PAYEE, asset), /expected an asset kind of native, erc20, got undefined/, JSON.stringify(asset));
	}
	assert.throws(() => requirePayoutAddress(PAYEE, { family: null }), TypeError, "a stated null is not a family");
	assert.throws(() => requirePayoutAddress(PAYEE, { family: null }), /payout-address: expected an asset family of evm, zcash, monero, got null/);
	assert.throws(() => requirePayoutAddress("0x1234", {}), /address: expected a 0x-prefixed 40-hex address/, "and the EVM rules still run");
	assert.throws(() => requirePayoutAddress(PAYEE, { family: "bitcoin" }), UnsupportedPayoutFamilyError);
	assert.throws(() => requirePayoutAddress(PAYEE, { family: "bitcoin" }), /expected an asset family of evm, zcash, monero/);

	// The family is a caller-supplied string, so the refusal echoes it boundedly rather than in full.
	const longFamily = "b".repeat(200);
	const message = refusalMessage(() => requirePayoutAddress(PAYEE, { family: longFamily }));
	assert.throws(() => requirePayoutAddress(PAYEE, { family: longFamily }), UnsupportedPayoutFamilyError);
	assert.equal(message.includes(longFamily), false, "the family trails as a bounded preview");
	assert.equal(message.includes("(200 characters)"), true, "the preview reports the value's full length");
});

test("the asset shape is checked before the address is, so a missing asset never reaches a validator", () => {
	assert.throws(() => requirePayoutAddress(PAYEE, null), /expected an asset carrying a family/, "a null asset is refused, not dereferenced");
	assert.throws(() => requirePayoutAddress(PAYEE, null), TypeError, "and the refusal is this module's TypeError");
});

test("an ERC-20 asset whose own contract address the loader's rule does not admit is refused, not skipped", () => {
	// The EVM branch's last guard keeps funds from being sent to the token's own contract, and it can only do that against a contract address the loader admits: `requirePayableAddress` reports "not the token's contract" — not an error — for a value it cannot compare, so an address that is missing, unshaped, or not the EIP-55 checksummed spelling `assets/registry.js`'s `isChecksummedContractAddress` admits fails closed here instead.
	for (const asset of [
		{ family: "evm", kind: "erc20" },
		{ family: "evm", kind: "erc20", address: null },
		{ family: "evm", kind: "erc20", address: "0x1234" },
		{ family: "evm", kind: "erc20", address: 42 },
		{ family: "evm", kind: "erc20", address: USDC.slice(0, 41) },
		{ family: "evm", kind: "erc20", address: USDC_LOWER },
		{ family: "evm", kind: "erc20", address: USDC_BROKEN_CHECKSUM },
	]) {
		assert.throws(() => requirePayoutAddress(PAYEE, asset), UnreadableTokenContractError, JSON.stringify(asset));
		assert.match(
			refusalMessage(() => requirePayoutAddress(PAYEE, asset)),
			/^payout-address: cannot check a transfer against the token's own contract address — expected an erc20 asset carrying an EIP-55 checksummed 0x-prefixed 40-hex contract address, got /,
			JSON.stringify(asset),
		);
	}
	assert.equal(
		refusalMessage(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "erc20" })),
		"payout-address: cannot check a transfer against the token's own contract address — expected an erc20 asset carrying an EIP-55 checksummed 0x-prefixed 40-hex contract address, got undefined",
	);
	// The checksum spelling is the rule the loader states, not one this module invented: the loader refuses the same uniformly-cased and wrongly-cased addresses at load.
	assert.notEqual(USDC_BROKEN_CHECKSUM, toChecksumAddress(USDC_BROKEN_CHECKSUM), "a mixed-case spelling whose checksum contradicts it");
	assert.throws(() => validateRegistry({ usdc: { ...EVM_USDC, address: USDC_LOWER } }), /must be EIP-55 checksummed/);
	assert.throws(() => validateRegistry({ usdc: { ...EVM_USDC, address: USDC_BROKEN_CHECKSUM } }), /must be EIP-55 checksummed/);

	// With a readable contract address the guard runs as before, on a partial asset as on a registry one.
	assert.equal(requirePayoutAddress(PAYEE, { family: "evm", kind: "erc20", address: USDC }), PAYEE);
	assert.throws(() => requirePayoutAddress(USDC, { family: "evm", kind: "erc20", address: USDC }), UnpayableAddressError);
	assert.throws(() => requirePayoutAddress(ZERO_ADDRESS, { family: "evm", kind: "erc20", address: USDC }), UnpayableAddressError);

	// A native coin has no contract address to compare against, so a partial asset that states its kind and carries no address is still validated for its address alone.
	assert.equal(requirePayoutAddress(PAYEE, { family: "evm", kind: "native" }), PAYEE);
	assert.equal(requirePayoutAddress(PAYEE, { family: "evm", kind: "native", address: null }), PAYEE);
	assert.throws(() => requirePayoutAddress("0x1234", { family: "evm", kind: "native" }), TypeError, "the address rules still run");
	assert.throws(() => requirePayoutAddress("0x1234", { family: "evm", kind: "native" }), /address: expected a 0x-prefixed 40-hex address/);
});

test("an asset that states no kind is refused, not classified by the contract address it carries", () => {
	// `assets/registry.js`'s `assetKind` would read a contract-carrying entry as a token, but the loader requires every entry to state its kind and the guard that keeps funds from reaching a token's own contract is keyed on it, so a caller-built asset is held to the same rule here: the kind is never inferred from the presence of an address.
	for (const asset of [{ family: "evm" }, { family: "evm", address: null }, { family: "evm", address: USDC }]) {
		assert.throws(() => requirePayoutAddress(PAYEE, asset), TypeError, JSON.stringify(asset));
		assert.throws(() => requirePayoutAddress(PAYEE, asset), /payout-address: expected an asset kind of native, erc20, got undefined/, JSON.stringify(asset));
	}
	assert.throws(() => requirePayoutAddress(USDC, { family: "evm", address: USDC }), TypeError, "the token's own contract is not accepted for an asset that states no kind either");

	// A kind the asset does state still decides, but a stated `native` is believed only when the entry carries no contract address: an entry that states `native` yet carries one contradicts its own label, so it is refused rather than read as a coin, and a stated `erc20` still needs its contract address to be the loader's checksummed spelling.
	assert.equal(requirePayoutAddress(PAYEE, { family: "evm", kind: "native", address: null }), PAYEE);
	assert.equal(requirePayoutAddress(PAYEE, { family: "evm", kind: "erc20", address: USDC }), PAYEE);
	assert.throws(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "native", address: USDC }), TypeError, "a stated native carrying a contract address is refused, not read as a coin");
	assert.throws(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "native", address: USDC }), /payout-address: expected a native asset carrying no contract address, got /);
	assert.throws(() => requirePayoutAddress(USDC, { family: "evm", kind: "native", address: USDC }), TypeError, "the stated label cannot exempt the token's own contract from the guard");
	assert.throws(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "erc20", address: "0x1234" }), UnreadableTokenContractError);
});

test("a stated decimals the loader's rule refuses is refused here too", () => {
	// `validateRegistry` admits only a non-negative safe integer no greater than `MAX_DECIMALS`, and this dispatcher is handed caller-built assets too, so a stated value outside that rule is refused off the loader's own statement rather than trusted.
	for (const decimals of [-1, 256, 1.5, "18", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, {}]) {
		assert.throws(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "native", decimals }), TypeError, `decimals ${String(decimals)}`);
		assert.throws(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "native", decimals }), /payout-address: the asset states the field decimals as /, `decimals ${String(decimals)}`);
		assert.throws(() => requirePayoutAddress(ZCASH_ADDRESS, { family: "zcash", decimals }), TypeError, `zcash decimals ${String(decimals)}`);
	}
	assert.equal(
		refusalMessage(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "native", decimals: 256 })),
		"payout-address: the asset states the field decimals as 256, and an asset must state its decimals as an integer from 0 to 255",
	);

	// The bound is inclusive, and an absent field makes no statement to contradict: the loader's own maximum is admitted, and a partial asset without the field stays valid — the one part of the loader's decimals rule this dispatcher does not apply.
	for (const decimals of [0, 8, 255]) {
		assert.equal(requirePayoutAddress(PAYEE, { family: "evm", kind: "native", decimals }), PAYEE, `decimals ${decimals}`);
	}
	assert.equal(requirePayoutAddress(PAYEE, { family: "evm", kind: "native" }), PAYEE);
	assert.equal(requirePayoutAddress(ZCASH_ADDRESS, { family: "zcash" }), ZCASH_ADDRESS);
	assert.equal(requirePayoutAddress(PAYEE, EVM_ETH), PAYEE, "the registry's own entry states its decimals");
});

test("the token-contract guard is total over the kinds that can reach it", () => {
	// A kind no rule knows would otherwise skip the guard by name: `requirePayableAddress` reads the funds-locking check off `kind` itself, so a misspelled or non-string kind is refused here even when the contract address it carries is perfectly readable.
	for (const kind of ["erc21", "ERC-20", "", 42, null, true, {}]) {
		const asset = { family: "evm", kind, address: USDC };
		assert.throws(() => requirePayoutAddress(PAYEE, asset), TypeError, `kind ${String(kind)}`);
		assert.throws(() => requirePayoutAddress(PAYEE, asset), /payout-address: expected an asset kind of native, erc20, got/, `kind ${String(kind)}`);
	}
	assert.equal(
		refusalMessage(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "erc-20", address: USDC })),
		'payout-address: expected an asset kind of native, erc20, got "erc-20"',
	);

	// The registry holds an entry to the same two names at load, so the kind that reaches this guard is always one it knows.
	assert.equal(requirePayoutAddress(PAYEE, { family: "evm", kind: "native", address: null }), PAYEE);
	assert.throws(() => requirePayoutAddress(USDC, { family: "evm", kind: "erc20", address: USDC }), UnpayableAddressError, "a known kind still runs the guard");
});

test("the EVM branch refuses a value that is not an address with a bounded echo of it", () => {
	// `wallet/address.ts` renders the rejected value with `describe`, which escapes a string in full, so the dispatcher reads that clause and renders it with a bounded preview instead: a paste 200,000 characters long reads no longer than one that just crosses the preview.
	const flood = `0x${"g".repeat(200_000)}`;
	const message = refusalMessage(() => requirePayoutAddress(flood, EVM_ETH));
	assert.match(message, /^address: expected a 0x-prefixed 40-hex address, got "0x/);
	assert.equal(message.includes(flood), false, "the whole paste is not echoed");
	assert.equal(message.includes("(200002 characters)"), true, "the preview reports the value's full length");

	const acrossTheBound = refusalMessage(() => requirePayoutAddress(`0x${"g".repeat(60)}`, EVM_ETH));
	assert.ok(
		Math.abs(message.length - acrossTheBound.length) < 20,
		`the refusal does not grow with the paste: ${message.length} characters for the flood, ${acrossTheBound.length} for one that just crosses the preview`,
	);

	// A value that fits the preview reads exactly as `wallet/address.ts` renders it, so the dispatcher's wrapper changes nothing for a user-typed paste.
	assert.equal(refusalMessage(() => requirePayoutAddress("0x1234", EVM_ETH)), 'address: expected a 0x-prefixed 40-hex address, got "0x1234"');
});

test("the address-shape clause is one statement, read by both layers", () => {
	// `wallet/address.ts` states the clause and this module reads it rather than restating it, so rewording one copy cannot leave the two layers refusing the same paste in different words.
	assert.equal(addressShapeMessage("0x1234"), "address: expected a 0x-prefixed 40-hex address, got 0x1234");
	assert.equal(refusalMessage(() => normalizeAddress("0x1234")), addressShapeMessage('"0x1234"'), "the module that states the clause builds its own refusal from it");
	assert.equal(refusalMessage(() => requirePayoutAddress("0x1234", EVM_ETH)), addressShapeMessage('"0x1234"'), "and so does the dispatcher's EVM branch");
	assert.equal(refusalMessage(() => requirePayoutAddress("0x1234", {})), addressShapeMessage('"0x1234"'), "as do the default EVM rules an asset stating no family is read as");
});

test("an asset whose family contradicts its contract-address fields is refused before its grammar runs", () => {
	// `assets/registry.ts` refuses a non-EVM entry that states a contract token's kind or carries a contract address, and this dispatcher is handed the structural assets its callers build too: without the same rule here a `{ family: "zcash", address: <an ERC-20 contract> }` asset would be dispatched to the Zcash grammar with its contract address silently ignored, certifying a payee for an invoice the asset never described.
	for (const family of ["zcash", "monero"]) {
		for (const address of [USDC, "0x1234", "0x", 42, true]) {
			const asset = { family, address };
			assert.throws(() => requirePayoutAddress(ZCASH_ADDRESS, asset), TypeError, JSON.stringify(asset));
			assert.throws(() => requirePayoutAddress(ZCASH_ADDRESS, asset), new RegExp(`payout-address: the ${family} asset carries the field address `), JSON.stringify(asset));
		}
		assert.throws(() => requirePayoutAddress(ZCASH_ADDRESS, { family, kind: "erc20" }), TypeError, `${family} erc20`);
		assert.throws(() => requirePayoutAddress(ZCASH_ADDRESS, { family, kind: "erc20" }), new RegExp(`payout-address: the ${family} asset states the field kind as "erc20"`));
	}

	// The refusal names the field it contradicts and trails a bounded preview of the value.
	assert.equal(
		refusalMessage(() => requirePayoutAddress(UNIFIED_ADDRESS, { family: "zcash", address: USDC })),
		`payout-address: the zcash asset carries the field address ${JSON.stringify(USDC)}, and a non-EVM asset must carry no contract address`,
	);
	assert.equal(
		refusalMessage(() => requirePayoutAddress(MONERO_ADDRESS, { family: "monero", kind: "erc20" })),
		'payout-address: the monero asset states the field kind as "erc20", and a non-EVM asset must state it as "native"',
	);

	// An asset that states the native kind, with the address declared absent or simply left out, is dispatched to its family's grammar as before.
	assert.equal(requirePayoutAddress(ZCASH_ADDRESS, { family: "zcash", kind: "native" }), ZCASH_ADDRESS);
	assert.equal(requirePayoutAddress(ZCASH_ADDRESS, { family: "zcash", kind: "native", address: null }), ZCASH_ADDRESS);
	assert.equal(requirePayoutAddress(MONERO_ADDRESS, { family: "monero", kind: "native" }), MONERO_ADDRESS);

	// The EVM family's own contradictory shapes never reach the token-contract guard unread: a stated `native` may carry no contract address, and an address the loader's rule does not admit is unreadable to the guard that keeps funds from reaching the token's contract.
	assert.throws(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "native", address: ZCASH_ADDRESS }), TypeError);
	assert.throws(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "native", address: ZCASH_ADDRESS }), /expected a native asset carrying no contract address/);
	assert.throws(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "erc20", address: ZCASH_ADDRESS }), UnreadableTokenContractError);
	assert.throws(() => requirePayoutAddress(PAYEE, { family: "evm", address: ZCASH_ADDRESS }), TypeError, "and an asset that states no kind is refused for the kind before any of that");
});

test("a non-EVM asset whose stated network is not its family's slug is refused before its grammar runs", () => {
	// The dispatcher applies the registry's slug rule off the same pairing, so an asset that states the zcash family on another network is refused rather than dispatched to the Zcash grammar with the network it names silently ignored.
	assert.throws(() => requirePayoutAddress(UNIFIED_ADDRESS, { family: "zcash", chainId: "0x1" }), TypeError);
	assert.equal(
		refusalMessage(() => requirePayoutAddress(UNIFIED_ADDRESS, { family: "zcash", chainId: "0x1" })),
		'payout-address: the zcash asset states the field chainId as "0x1", and a non-EVM asset must state the zcash network slug "zcash"',
	);
	assert.equal(
		refusalMessage(() => requirePayoutAddress(MONERO_ADDRESS, { family: "monero", chainId: "zcash" })),
		'payout-address: the monero asset states the field chainId as "zcash", and a non-EVM asset must state the monero network slug "monero"',
	);

	// Anything the family does not name is a contradiction, whatever its type.
	for (const chainId of ["0x1", "0x89", "monero", "", null, 42, true, {}]) {
		assert.throws(() => requirePayoutAddress(ZCASH_ADDRESS, { family: "zcash", chainId }), TypeError, `chainId ${String(chainId)}`);
	}

	// A stated slug is the family's own, and an absent field makes no statement to contradict, so the minimal assets the privacy-chain branches are driven with stay valid.
	assert.equal(requirePayoutAddress(ZCASH_ADDRESS, { family: "zcash", chainId: "zcash" }), ZCASH_ADDRESS);
	assert.equal(requirePayoutAddress(MONERO_ADDRESS, { family: "monero", chainId: "monero" }), MONERO_ADDRESS);
	assert.equal(requirePayoutAddress(ZCASH_ADDRESS, { family: "zcash" }), ZCASH_ADDRESS);
	assert.equal(requirePayoutAddress(ZCASH_ADDRESS, ASSET_REGISTRY.zec), ZCASH_ADDRESS, "the registry's own entry states its slug");
	assert.equal(requirePayoutAddress(MONERO_ADDRESS, ASSET_REGISTRY.xmr), MONERO_ADDRESS);
});

test("an EVM asset whose stated chainId is not a canonical EVM chain id is refused before its branch runs", () => {
	// `validateRegistry` holds an EVM entry to a canonical `0x` quantity, and this dispatcher is handed the structural assets its callers build too: a privacy chain's slug, or a quantity spelled another way, would otherwise be validated on the EVM rules for an invoice the asset never placed on a chain the wallet can be asked to switch to.
	for (const chainId of ["zcash", "monero", "1", "0x01", "0X1", "0x", "", null, 42, true, {}]) {
		const asset = { family: "evm", kind: "native", chainId };
		assert.throws(() => requirePayoutAddress(PAYEE, asset), TypeError, `chainId ${String(chainId)}`);
		assert.throws(() => requirePayoutAddress(PAYEE, asset), /payout-address: the evm asset states the field chainId as /, `chainId ${String(chainId)}`);
	}
	assert.equal(
		refusalMessage(() => requirePayoutAddress(PAYEE, { family: "evm", kind: "native", chainId: "zcash" })),
		'payout-address: the evm asset states the field chainId as "zcash", and an EVM asset must state a canonical EVM chain id like "0x1"',
	);

	// A canonical quantity is the shape the registry requires of an EVM entry, and an absent field makes no statement to contradict.
	assert.equal(requirePayoutAddress(PAYEE, { family: "evm", kind: "native", chainId: "0x1" }), PAYEE);
	assert.equal(requirePayoutAddress(PAYEE, { family: "evm", kind: "native", chainId: "0x89" }), PAYEE);
	assert.equal(requirePayoutAddress(PAYEE, { family: "evm", kind: "native" }), PAYEE);
	assert.equal(requirePayoutAddress(PAYEE, EVM_ETH), PAYEE, "the registry's own entry states its canonical chain id");

	// The registry's own rule is unchanged, and still refuses the entry at load.
	assert.throws(() => validateRegistry({ eth: { ...EVM_ETH, chainId: "zcash" } }), /non-canonical chain id/);
});

test("an asset the loader admits for its shape is one the dispatcher accepts, and one it refuses is refused here", () => {
	// Both readers apply `assets/registry.js`'s one statement of the family-shape rules, so an asset the load-time gate blesses is not the asset that then fails inside the payer's view-model build, and each refusal is that same fault in the reader's own words.
	for (const [key, address] of [["eth", PAYEE], ["zec", ZCASH_ADDRESS], ["xmr", MONERO_ADDRESS]]) {
		const entry = ASSET_REGISTRY[key];
		assert.doesNotThrow(() => validateRegistry({ [key]: entry }), key);
		assert.equal(requirePayoutAddress(address, entry), address, key);
	}

	// A shape the loader refuses is one this module refuses before its branch runs, each naming the field the entry contradicts.
	const broken = { ...ASSET_REGISTRY.zec, kind: "erc20" };
	assert.throws(() => validateRegistry({ zec: broken }), /non-EVM asset must be kind "native"/);
	assert.throws(() => requirePayoutAddress(ZCASH_ADDRESS, broken), /non-EVM asset must state it as "native"/);
});
