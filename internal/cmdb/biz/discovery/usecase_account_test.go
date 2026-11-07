package discovery

import (
	"context"
	"errors"
	"strings"
	"testing"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	discoverymodel "github.com/ongridio/ongrid/internal/cmdb/model/discovery"
	"github.com/ongridio/ongrid/internal/pkg/secretbox"
)

// The credential posture: sealed on the way in, never returned, and only the
// owner may replace one.
//
// THIS IS THE PART THAT MUST NOT BE GOT WRONG. A read that returns a secret is
// a credential dump behind one page load; a write that re-seals a stored
// ciphertext destroys the credential while leaving a value that still looks
// sealed, so nothing reports it.

func TestRenderAccountStripsTheCredentials(t *testing.T) {
	sealed, err := secretbox.Encrypt("hunter2")
	if err != nil {
		t.Fatal(err)
	}
	row := discoverymodel.Account{
		Name: "aliyun",
		Config: map[string]any{
			"access_key":       "AKIA",
			AccountSecretKey:   sealed,
			AccountPasswordKey: sealed,
			"region":           "cn-hangzhou",
		},
	}
	view := renderAccount(row)

	if view.HasSecret != true || view.HasPassword != true {
		t.Fatalf("the flags are wrong: %+v", view)
	}
	if _, leaked := view.Config[AccountSecretKey]; leaked {
		t.Fatalf("the secret was returned: %v", view.Config)
	}
	if _, leaked := view.Config[AccountPasswordKey]; leaked {
		t.Fatalf("the password was returned: %v", view.Config)
	}
	// The non-secret parts are still there: a console draws them.
	if view.Config["access_key"] != "AKIA" || view.Config["region"] != "cn-hangzhou" {
		t.Fatalf("the config lost a real field: %v", view.Config)
	}
	// And nothing in the returned document holds the plaintext.
	for k, v := range view.Config {
		if strings.Contains(strings.ToLower(toString(v)), "hunter2") {
			t.Fatalf("%s carries the plaintext", k)
		}
	}
}

func toString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func TestSealAccountConfigTellsThreeCasesApart(t *testing.T) {
	stored, err := secretbox.Encrypt("old-secret")
	if err != nil {
		t.Fatal(err)
	}

	// 1. The key is ABSENT: the credential is kept, because a read never
	//    returned it and a round-tripped form therefore never sends it back.
	got, err := sealAccountConfig(map[string]any{"access_key": "AKIA"}, map[string]any{
		"access_key": "OLD", AccountSecretKey: stored, "region": "cn",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got[AccountSecretKey] != stored {
		t.Fatalf("an unmentioned secret was not kept: %v", got[AccountSecretKey])
	}

	// 2. The key is PRESENT AND EMPTY: the credential is cleared, which is how
	//    an operator removes one.
	got, err = sealAccountConfig(map[string]any{AccountSecretKey: ""}, map[string]any{
		AccountSecretKey: stored,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, still := got[AccountSecretKey]; still {
		t.Fatalf("an explicitly emptied secret survived: %v", got)
	}

	// 3. The key is PRESENT WITH A VALUE: it is replaced and sealed.
	got, err = sealAccountConfig(map[string]any{AccountSecretKey: "brand-new"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	sealed, _ := got[AccountSecretKey].(string)
	if sealed == "brand-new" {
		t.Fatal("a new secret was stored in the clear")
	}
	plain, err := secretbox.Decrypt(sealed)
	if err != nil || plain != "brand-new" {
		t.Fatalf("the new secret does not round-trip: %q, %v", plain, err)
	}

	// 4. A CALLER THAT SENT THE STORED CIPHERTEXT BACK means "leave it".
	//    cantor's read path handed the ciphertext out whenever decryption
	//    failed, so a client that round-trips what it read sends one — and
	//    sealing it again is how a credential is destroyed while still looking
	//    sealed.
	got, err = sealAccountConfig(map[string]any{AccountSecretKey: stored}, map[string]any{
		AccountSecretKey: stored,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got[AccountSecretKey] != stored {
		t.Fatalf("a carried ciphertext was re-sealed: %v", got[AccountSecretKey])
	}
	plain, err = secretbox.Decrypt(got[AccountSecretKey].(string))
	if err != nil || plain != "old-secret" {
		t.Fatalf("the carried credential no longer decrypts: %q, %v", plain, err)
	}
}

func newAccountUsecase(t *testing.T) (*Usecase, *stubRepo) {
	t.Helper()
	repo := newStub()
	row := discoverymodel.Rule{Name: "aliyun", IsInner: true}
	row.ID = 1
	repo.rules = append(repo.rules, row)
	return NewUsecase(repo), repo
}

func TestOnlyTheOwnerReplacesACredential(t *testing.T) {
	uc, repo := newAccountUsecase(t)
	owner := model.ID(7)
	repo.accounts = []discoverymodel.Account{{
		Name: "shared", UID: idp(owner), Config: map[string]any{},
	}}
	repo.accounts[0].ID = 55

	other := Actor{UserID: 9}
	_, err := uc.UpsertAccounts(context.Background(), "aliyun", []AccountInput{
		{ID: 55, Name: "shared", Config: map[string]any{AccountSecretKey: "mine-now"}},
	}, other)
	if !errors.Is(err, ErrAccountSecretNotYours) {
		t.Fatalf("err = %v, want a not-yours refusal", err)
	}

	// An ordinary field is not a credential, so anyone may edit it — the rule
	// cannot be "nobody but the owner may touch the row", because the row
	// carries the account's name and region too.
	if _, err := uc.UpsertAccounts(context.Background(), "aliyun", []AccountInput{
		{ID: 55, Name: "shared", Config: map[string]any{"region": "cn-beijing"}},
	}, Actor{UserID: 9, IsAdmin: true}); err != nil {
		t.Fatalf("an administrative edit of a non-credential field: %v", err)
	}

	// The owner may.
	if _, err := uc.UpsertAccounts(context.Background(), "aliyun", []AccountInput{
		{ID: 55, Name: "shared", Config: map[string]any{AccountSecretKey: "mine"}},
	}, Actor{UserID: owner}); err != nil {
		t.Fatalf("the owner was refused: %v", err)
	}
}

func TestRenderAccountStripsAndFlagsEveryCredential(t *testing.T) {
	sealedKey, err := secretbox.Encrypt("access-key-id")
	if err != nil {
		t.Fatal(err)
	}
	sealedCommunity, err := secretbox.Encrypt("public")
	if err != nil {
		t.Fatal(err)
	}
	view := renderAccount(discoverymodel.Account{Config: map[string]any{
		AccountKeyKey:       sealedKey,
		AccountCommunityKey: sealedCommunity,
		"region":            "cn-north",
	}})
	if !view.HasKey || !view.HasCommunity {
		t.Fatalf("flags = %+v", view)
	}
	if _, present := view.Config[AccountKeyKey]; present {
		t.Fatalf("access key was returned: %+v", view.Config)
	}
	if _, present := view.Config[AccountCommunityKey]; present {
		t.Fatalf("community was returned: %+v", view.Config)
	}
	if view.Config["region"] != "cn-north" {
		t.Fatalf("an ordinary field went missing: %+v", view.Config)
	}
}

func TestClearingACredentialNeedsOwnership(t *testing.T) {
	owner := model.ID(1)
	prior := discoverymodel.Account{UID: &owner}
	// PRESENT AND EMPTY IS A CLEAR, not an omission. It must take the same
	// ownership check as replacing the value.
	if mayWriteCredential(prior, map[string]any{AccountSecretKey: ""}, Actor{UserID: 2}) {
		t.Fatal("a non-owner cleared a credential")
	}
	if !mayWriteCredential(prior, map[string]any{AccountSecretKey: ""}, Actor{UserID: 1}) {
		t.Fatal("the owner could not clear the credential")
	}
	if mayWriteCredential(prior, map[string]any{AccountKeyKey: "new"}, Actor{UserID: 2}) {
		t.Fatal("a non-owner replaced an access key")
	}
}

func TestSealAccountConfigNormalizesTheReference(t *testing.T) {
	sealed, err := sealAccountConfig(map[string]any{"reference": "5"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if sealed["_reference"] != "5" {
		t.Fatalf("reference was not normalized: %+v", sealed)
	}
	if _, present := sealed["reference"]; present {
		t.Fatalf("the legacy key survived: %+v", sealed)
	}

	cleared, err := sealAccountConfig(map[string]any{"_reference": ""}, sealed)
	if err != nil {
		t.Fatal(err)
	}
	if _, present := cleared["_reference"]; present {
		t.Fatalf("an empty reference was not cleared: %+v", cleared)
	}
}

func TestAccountNeedsAName(t *testing.T) {
	uc, _ := newAccountUsecase(t)
	_, err := uc.UpsertAccounts(context.Background(), "aliyun", []AccountInput{
		{Config: map[string]any{AccountSecretKey: "x"}},
	}, Actor{UserID: 7})
	if !errors.Is(err, ErrAccountNameRequired) {
		t.Fatalf("err = %v", err)
	}
	_, err = uc.UpsertAccounts(context.Background(), "aliyun", []AccountInput{
		{Name: "a"}, {Name: "a"},
	}, Actor{UserID: 7})
	if !errors.Is(err, ErrAccountNameRequired) {
		t.Fatalf("a duplicated account name was accepted: %v", err)
	}
}
