package discovery

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// Discovery secret envelopes.
//
// THE RELAY MUST NOT SEE A CLOUD CREDENTIAL. Hilbert encrypts the secret part
// of a task to the euler's X25519 public key; riemann forwards opaque bytes.
// The composition is deliberately standard-library only:
//
//	X25519 ECDH -> HKDF-SHA256 -> AES-256-GCM
//
// The AAD binds the envelope to one euler, task and revision, so moving it to
// another task fails authentication instead of decrypting.
const secretEnvelopeAlg = "x25519-hkdf-sha256-aes-256-gcm"

type secretEnvelopeWire struct {
	Alg             string `json:"alg"`
	KeyID           string `json:"key_id"`
	EphemeralPublic string `json:"ephemeral_public"`
	Salt            string `json:"salt"`
	Nonce           string `json:"nonce"`
	Ciphertext      string `json:"ciphertext"`
}

func eulerKeyID(publicKey []byte) string {
	sum := sha256.Sum256(publicKey)
	return hex.EncodeToString(sum[:8])
}

// sealSecretEnvelope encrypts plaintext to one euler. It returns the JSON
// envelope plus the key id/algorithm the task carries for diagnostics.
func sealSecretEnvelope(publicKey, plaintext, aad []byte) ([]byte, string, string, error) {
	if len(publicKey) != 32 {
		return nil, "", "", fmt.Errorf("euler public key must be 32 bytes, got %d", len(publicKey))
	}
	curve := ecdh.X25519()
	peer, err := curve.NewPublicKey(publicKey)
	if err != nil {
		return nil, "", "", fmt.Errorf("parse euler public key: %w", err)
	}
	ephemeral, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", "", fmt.Errorf("generate ephemeral key: %w", err)
	}
	shared, err := ephemeral.ECDH(peer)
	if err != nil {
		return nil, "", "", fmt.Errorf("derive shared secret: %w", err)
	}
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		return nil, "", "", fmt.Errorf("generate salt: %w", err)
	}
	key, err := hkdf.Key(sha256.New, shared, salt, "nexus-discovery-secret-v1", 32)
	if err != nil {
		return nil, "", "", fmt.Errorf("derive envelope key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, "", "", fmt.Errorf("create envelope cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, "", "", fmt.Errorf("create envelope AEAD: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, "", "", fmt.Errorf("generate nonce: %w", err)
	}
	ciphertext := gcm.Seal(nil, nonce, plaintext, aad)
	wire := secretEnvelopeWire{
		Alg:             secretEnvelopeAlg,
		KeyID:           eulerKeyID(publicKey),
		EphemeralPublic: base64.StdEncoding.EncodeToString(ephemeral.PublicKey().Bytes()),
		Salt:            base64.StdEncoding.EncodeToString(salt),
		Nonce:           base64.StdEncoding.EncodeToString(nonce),
		Ciphertext:      base64.StdEncoding.EncodeToString(ciphertext),
	}
	raw, err := json.Marshal(wire)
	if err != nil {
		return nil, "", "", fmt.Errorf("marshal envelope: %w", err)
	}
	return raw, wire.KeyID, wire.Alg, nil
}

// secretFingerprint lets a task revision change when a credential changes
// without putting the credential itself into the revision payload.
func secretFingerprint(secrets map[string]string) string {
	if len(secrets) == 0 {
		return ""
	}
	raw, _ := json.Marshal(secrets)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
