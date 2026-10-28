package ci

import "testing"

// THE IPAM MODELS ARE ADDRESSED BY THE CONSOLE'S NAMES. A deployment built from
// these specs has to accept `name` on a scope or subnet; the port's first spec
// said `scope_name`/`subnet_name`, and the console's create call then failed on
// every fresh installation.
func TestIPAMBuiltinModelsUseTheConsoleContract(t *testing.T) {
	specs := map[string]BuiltinModelSpec{}
	for _, spec := range IPAMBuiltinModels() {
		specs[spec.Name] = spec
	}

	for _, name := range []string{string(ModelIPAMScope), string(ModelIPAMSubnet)} {
		spec, ok := specs[name]
		if !ok {
			t.Fatalf("model %s is missing", name)
		}
		if spec.UniqueKey != "name" {
			t.Fatalf("%s unique key = %q, want name", name, spec.UniqueKey)
		}
	}

	address, ok := specs[string(ModelIPAMAddress)]
	if !ok {
		t.Fatal("the address model is missing")
	}
	attrs := map[string]bool{}
	for _, attr := range address.Attributes {
		attrs[attr.Name] = true
	}
	for _, want := range []string{AttrIP, AttrAssignStatus, AttrIsUsed, AttrDescription, AttrUsage, AttrUseObj, AttrMACAddress, AttrGateway, AttrSubnetMask} {
		if !attrs[want] {
			t.Fatalf("the address model does not declare %s", want)
		}
	}
}
