package ci

import "testing"

// History names instances with the show attribute, falling back to the unique
// one. A password, link or file attribute must never supply that name: the
// history page is readable by any authenticated caller, and the normal read
// path hides these values for the same reason.
func TestHistoryNameAttributeSkipsSensitiveAttributes(t *testing.T) {
	safe := AttributeSpec{ID: 1, Name: "hostname"}
	secret := AttributeSpec{ID: 2, Name: "password", IsPassword: true}

	cases := []struct {
		name   string
		show   AttributeSpec
		unique AttributeSpec
		want   AttributeSpec
	}{
		{name: "safe show wins", show: safe, unique: AttributeSpec{ID: 3}, want: safe},
		{name: "password show falls back to the unique attribute", show: secret, unique: safe, want: safe},
		{name: "file show is sensitive too", show: AttributeSpec{ID: 4, IsFile: true}, unique: safe, want: safe},
		{name: "link show is sensitive too", show: AttributeSpec{ID: 5, IsLink: true}, unique: safe, want: safe},
		{name: "missing show falls back", show: AttributeSpec{}, unique: safe, want: safe},
		{name: "both sensitive yield no name", show: secret, unique: AttributeSpec{ID: 6, IsPassword: true}, want: AttributeSpec{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := historyNameAttribute(tc.show, tc.unique); got.ID != tc.want.ID {
				t.Fatalf("attribute = %+v, want %+v", got, tc.want)
			}
		})
	}
}
