package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"

	"github.com/ongridio/ongrid/internal/cmdb/biz/classmap"
	bizconnector "github.com/ongridio/ongrid/internal/cmdb/biz/connector"
)

var _ bizconnector.ClassTarget = (*Client)(nil)

// EnsureClass creates the class when absent. For an existing class it adds
// missing attributes and patches the projection-owned metadata; it fails closed
// on parent/abstract/attribute-type conflicts instead of silently changing a
// schema that topocortex cannot change through this endpoint.
func (c *Client) EnsureClass(ctx context.Context, class classmap.Class) (bool, error) {
	if err := c.ready(); err != nil {
		return false, err
	}
	if class.ClassName == "" {
		return false, fmt.Errorf("topocortex connector: class_name is required")
	}
	path := "/api/v1/ontology/classes/" + url.PathEscape(class.ClassName)
	existing, found, err := c.getClass(ctx, path)
	if err != nil {
		return false, err
	}
	if !found {
		if err := c.doJSON(ctx, http.MethodPost, "/api/v1/ontology/classes", class,
			http.StatusOK, http.StatusCreated); err != nil {
			return false, err
		}
		return true, nil
	}

	if existing.ParentClass != class.ParentClass {
		return false, fmt.Errorf(
			"class %s parent conflict: existing %q, desired %q (use the reparent endpoint explicitly)",
			class.ClassName, existing.ParentClass, class.ParentClass)
	}
	if existing.Abstract != class.Abstract {
		return false, fmt.Errorf(
			"class %s abstract conflict: existing %v, desired %v",
			class.ClassName, existing.Abstract, class.Abstract)
	}

	names := make([]string, 0, len(class.Attributes))
	for name := range class.Attributes {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		desired := class.Attributes[name]
		current, exists := existing.Attributes[name]
		if !exists {
			body := map[string]string{"attribute": name, "type": desired}
			if err := c.doJSON(ctx, http.MethodPost, path+"/attributes", body,
				http.StatusOK, http.StatusCreated); err != nil {
				return false, err
			}
			continue
		}
		if current != desired {
			return false, fmt.Errorf(
				"class %s attribute %s type conflict: existing %q, desired %q",
				class.ClassName, name, current, desired)
		}
	}

	patch := map[string]any{
		"indexed_keys":  nonNilStrings(class.IndexedKeys),
		"display_keys":  nonNilStrings(class.DisplayKeys),
		"identity_keys": nonNilStrings(class.IdentityKeys),
	}
	if class.DisplayName != "" {
		patch["display_name"] = class.DisplayName
	}
	if class.Description != "" {
		patch["description"] = class.Description
	}
	if class.Domain != "" {
		patch["domain"] = class.Domain
	}
	if class.Layer != "" {
		patch["layer"] = class.Layer
	}
	if len(class.Constraints) > 0 {
		patch["constraints"] = class.Constraints
	}
	if len(class.Roles) > 0 {
		patch["roles"] = class.Roles
	}
	if len(class.SemanticBindings) > 0 {
		patch["semantic_bindings"] = class.SemanticBindings
	}
	if err := c.doJSON(ctx, http.MethodPatch, path, patch, http.StatusOK); err != nil {
		return false, err
	}
	return false, nil
}

func (c *Client) getClass(ctx context.Context, path string) (*classmap.Class, bool, error) {
	status, body, err := c.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, false, err
	}
	switch status {
	case http.StatusOK:
		var envelope struct {
			Data classmap.Class `json:"data"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			return nil, false, fmt.Errorf("topocortex connector: decode class: %w", err)
		}
		if envelope.Data.ClassName == "" {
			return nil, false, fmt.Errorf("topocortex connector: class response has no class_name")
		}
		return &envelope.Data, true, nil
	case http.StatusNotFound:
		return nil, false, nil
	default:
		return nil, false, responseError(http.MethodGet, path, status, body)
	}
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
