package discovery

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestSecretEnvelopeRoundTrip(t *testing.T) {
	curve := ecdh.X25519()
	privateKey, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := privateKey.PublicKey().Bytes()
	aad := []byte("0xabc|t:1|sha256:rev")
	plaintext := []byte(`{"secret":"s3cr3t","password":"pw"}`)

	raw, keyID, alg, err := sealSecretEnvelope(publicKey, plaintext, aad)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if keyID == "" || alg != secretEnvelopeAlg {
		t.Fatalf("keyID=%q alg=%q", keyID, alg)
	}
	var wire secretEnvelopeWire
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("envelope JSON: %v", err)
	}

	// The reader mirrors euler's open implementation.
	ephemeral, err := base64.StdEncoding.DecodeString(wire.EphemeralPublic)
	if err != nil {
		t.Fatal(err)
	}
	salt, _ := base64.StdEncoding.DecodeString(wire.Salt)
	nonce, _ := base64.StdEncoding.DecodeString(wire.Nonce)
	ciphertext, _ := base64.StdEncoding.DecodeString(wire.Ciphertext)
	peer, err := curve.NewPublicKey(ephemeral)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := privateKey.ECDH(peer)
	if err != nil {
		t.Fatal(err)
	}
	key, err := hkdf.Key(sha256.New, shared, salt, "nexus-discovery-secret-v1", 32)
	if err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	got, err := gcm.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if string(got) != string(plaintext) {
		t.Fatalf("plaintext = %s", got)
	}

	// A different task's AAD must not open the envelope.
	if _, err := gcm.Open(nil, nonce, ciphertext, []byte("other")); err == nil {
		t.Fatal("envelope opened with the wrong AAD")
	}
}

func TestSecretFingerprintChangesWithSecret(t *testing.T) {
	a := secretFingerprint(map[string]string{"secret": "a"})
	b := secretFingerprint(map[string]string{"secret": "b"})
	if a == "" || a == b {
		t.Fatalf("fingerprints = %q / %q", a, b)
	}
	if secretFingerprint(nil) != "" {
		t.Fatal("empty secrets should have an empty fingerprint")
	}
}
