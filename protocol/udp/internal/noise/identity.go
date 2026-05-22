package noise

import (
	"errors"
	"strings"

	"golang.org/x/crypto/hkdf"
	"crypto/sha256"
)

// WalletIdentityMessage is the canonical message a user signs with their
// Ethereum wallet to derive their Noise IK static keypair. The same
// wallet across devices that signs this same message produces the same
// X25519 keypair (because ECDSA-secp256k1 personal_sign is deterministic
// under RFC 6979, which all mainstream wallet libs implement).
//
// The message is wrapped in the EIP-191 personal_sign prefix by the
// wallet itself, so we only need to provide the inner text here.
func WalletIdentityMessage(walletAddress string) string {
	return strings.Join([]string{
		"Blockchain VPN — Noise identity derivation",
		"Wallet: " + strings.ToLower(walletAddress),
		"Version: 1",
		"This signature derives your private VPN identity key.",
		"Sign once per wallet; the resulting key never leaves your device.",
	}, "\n")
}

// DeriveStaticFromSignature converts a wallet's personal_sign signature
// of WalletIdentityMessage into a Noise IK static keypair, via:
//
//	seed = HKDF-Extract(salt="blockchain-vpn-noise-v1", ikm=signature)
//	priv = seed (clamped by curve25519.ScalarBaseMult internally)
//	pub  = ScalarBaseMult(priv)
//
// The signature is the standard 65-byte (r||s||v) Ethereum personal_sign
// output. Any byte slice will work for testing, but production callers
// must pass a real wallet signature.
//
// Returns ErrShortSignature if the signature is fewer than 65 bytes
// (defensive — a wallet that returns a short signature is broken).
func DeriveStaticFromSignature(signature []byte) (Keypair, error) {
	if len(signature) < 65 {
		return Keypair{}, ErrShortSignature
	}

	const salt = "blockchain-vpn-noise-v1"
	r := hkdf.New(sha256.New, signature, []byte(salt), nil)

	var seed [32]byte
	if n, err := r.Read(seed[:]); err != nil || n != 32 {
		return Keypair{}, errors.New("noise: hkdf read failed")
	}
	return KeypairFromSeed(seed), nil
}

// ErrShortSignature is returned by DeriveStaticFromSignature for
// signatures shorter than 65 bytes.
var ErrShortSignature = errors.New("noise: wallet signature must be at least 65 bytes")
