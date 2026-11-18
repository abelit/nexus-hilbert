package main

import (
	"context"

	iambizuser "github.com/ongridio/ongrid/internal/iam/biz/user"
)

// iamIdentityResolver supplies the values a configured center filter may
// substitute for the caller. It lives in the composition root because the
// manager biz package may not import internal/iam.
//
// Only IAM fields are available here: email, phone and display name. A
// DingTalk user id would need an explicit binding (imbridge) and is left
// empty, which makes an identity rule on it void rather than widen the query.
type iamIdentityResolver struct {
	users *iambizuser.Usecase
}

func (r iamIdentityResolver) Resolve(ctx context.Context, userID uint64) (map[string][]string, error) {
	if r.users == nil || userID == 0 {
		return map[string][]string{}, nil
	}
	user, err := r.users.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := map[string][]string{}
	if user.Email != "" {
		out["email"] = []string{user.Email}
	}
	if user.Phone != "" {
		out["phone"] = []string{user.Phone}
	}
	if user.DisplayName != "" {
		out["username"] = []string{user.DisplayName}
	}
	return out, nil
}
