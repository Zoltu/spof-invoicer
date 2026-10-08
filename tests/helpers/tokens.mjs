/**
 * Shared token fixtures: the Ethereum-mainnet USDC and USDT contract addresses as the registry pins them (EIP-55 checksummed), and the lower-case forms a wallet sends on the wire.
 */

/** The EIP-55-checksummed USDC contract address on Ethereum mainnet, as the registry pins it. */
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** The EIP-55-checksummed USDT contract address on Ethereum mainnet, as the registry pins it. */
export const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

/** USDC's lower-case address body, the spelling a wallet sends on the wire. */
export const USDC_LOWER = USDC.toLowerCase();

/** USDT's lower-case address body, the spelling a wallet sends on the wire. */
export const USDT_LOWER = USDT.toLowerCase();
