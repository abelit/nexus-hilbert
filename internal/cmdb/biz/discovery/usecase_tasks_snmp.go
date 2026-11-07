package discovery

import (
	"encoding/json"
	"fmt"
	"strings"
)

// snmpNodeCommunitiesSecret is the envelope entry that carries node-level
// communities. The envelope itself is map[string]string, so the per-node map
// is encoded as JSON rather than changing the wire contract.
const snmpNodeCommunitiesSecret = "node_communities"

// extractSNMPCommunities moves node-level communities out of the task
// parameters and into the secret envelope.
//
// THE NODES ARRAY IS NOT A SECRET KEY, but each element may carry a community.
// Leaving it in params would hand the credential to every relay and to the
// task signature payload; removing only the top-level `community` would seal
// one credential and leak the rest. The returned problem is a target-level
// configuration warning, not a transport failure: an SNMP target with no node
// or no community cannot work, but it must not stop the other targets in the
// same snapshot.
func extractSNMPCommunities(opened map[string]any, secrets map[string]string) (string, error) {
	defaultCommunity := plainTextValue(opened["community"])
	raw, present := opened["nodes"]
	if !present || raw == nil {
		if snmpCIDRConfigured(opened["cidr"]) {
			return "SNMP CIDR discovery is not implemented; add nodes explicitly", nil
		}
		if defaultCommunity == "" {
			return "SNMP target has no nodes or community", nil
		}
		return "SNMP target has no nodes", nil
	}
	nodes, ok := nodeMaps(raw)
	if !ok {
		return "", fmt.Errorf("%w: SNMP nodes must be a list", ErrTargetIncomplete)
	}
	if len(nodes) == 0 {
		if snmpCIDRConfigured(opened["cidr"]) {
			return "SNMP CIDR discovery is not implemented; add nodes explicitly", nil
		}
		return "SNMP target has no nodes", nil
	}

	sanitized := make([]any, 0, len(nodes))
	communities := make(map[string]string, len(nodes))
	for index, node := range nodes {
		ip := plainTextValue(node["ip"])
		if ip == "" {
			return "", fmt.Errorf("%w: SNMP node %d has no ip", ErrTargetIncomplete, index+1)
		}
		copy := make(map[string]any, len(node))
		for key, value := range node {
			if key == AccountCommunityKey || key == "has_community" {
				continue
			}
			copy[key] = value
		}
		if community := plainTextValue(node[AccountCommunityKey]); community != "" {
			communities[ip] = community
		}
		sanitized = append(sanitized, copy)
	}
	opened["nodes"] = sanitized
	if len(communities) > 0 {
		encoded, err := json.Marshal(communities)
		if err != nil {
			return "", err
		}
		secrets[snmpNodeCommunitiesSecret] = string(encoded)
	}
	if defaultCommunity == "" && len(communities) == 0 {
		return "SNMP target has no community", nil
	}
	return "", nil
}

// snmpCIDRConfigured reports whether the operator asked for range discovery
// even though the collector does not implement it yet. The warning names the
// real gap instead of pretending no nodes were configured.
func snmpCIDRConfigured(raw any) bool {
	switch value := raw.(type) {
	case string:
		return strings.TrimSpace(value) != ""
	case []any:
		return len(value) > 0
	case []string:
		return len(value) > 0
	default:
		return false
	}
}

// plainTextValue reads a scalar from a decoded JSON map. A missing value and
// the string "<nil>" (which fmt.Sprint produces for nil) both mean empty.
func plainTextValue(value any) string {
	if value == nil {
		return ""
	}
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "<nil>" {
		return ""
	}
	return text
}
