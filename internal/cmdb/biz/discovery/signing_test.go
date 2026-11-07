package discovery

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func TestSigningKeyFromEnvUsesADedicatedSeed(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ONGRID_CMDB_DISCOVERY_SIGNING_KEY", base64.StdEncoding.EncodeToString(seed))
	t.Setenv("ONGRID_JWT_SECRET", "some-jwt-secret")

	key, keyID, err := SigningKeyFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	want := ed25519.NewKeyFromSeed(seed)
	if !key.Equal(want) || keyID == "" {
		t.Fatalf("derived key = %v key_id = %q", key, keyID)
	}

	t.Setenv("ONGRID_CMDB_DISCOVERY_SIGNING_KEY", "not-base64")
	if _, _, err := SigningKeyFromEnv(); err == nil {
		t.Fatal("a malformed dedicated seed was silently ignored")
	}
}

func TestSigningKeyFromEnvFallsBackToDeploymentSecret(t *testing.T) {
	t.Setenv("ONGRID_CMDB_DISCOVERY_SIGNING_KEY", "")
	t.Setenv("ONGRID_SECRET_KEY", "")
	t.Setenv("ONGRID_JWT_SECRET", "deployment-secret")
	key, keyID, err := SigningKeyFromEnv()
	if err != nil || key == nil || keyID == "" {
		t.Fatalf("derived = %v, %q, %v", key, keyID, err)
	}
	again, againID, err := SigningKeyFromEnv()
	if err != nil || !key.Equal(again) || keyID != againID {
		t.Fatal("the derived key is not stable across calls")
	}
}
