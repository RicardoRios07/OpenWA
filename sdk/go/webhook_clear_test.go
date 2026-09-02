package openwa

import (
	"encoding/json"
	"testing"
)

// The server distinguishes ABSENT (leave the field alone) from an explicit empty/null value (clear
// it): webhook.service.ts applies `if (dto.filters !== undefined)`, and reads an empty secret and an
// empty headers map as "clear". Every field on UpdateWebhookRequest carried `omitempty` over a value
// type, so the three "clear this" values marshalled away to nothing and the stored values survived —
// while the JavaScript, Python, PHP and (for secret/headers) Java clients transmit them and the
// server acts on them.
func TestUpdateWebhookRequestTransmitsClearingValues(t *testing.T) {
	empty := ""
	noHeaders := map[string]string{}
	body, err := json.Marshal(UpdateWebhookRequest{
		Secret:       &empty,
		Headers:      &noHeaders,
		ClearFilters: true,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var got map[string]json.RawMessage
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := got["secret"]; !ok {
		t.Errorf("secret was dropped from the body: %s", body)
	}
	if _, ok := got["headers"]; !ok {
		t.Errorf("headers was dropped from the body: %s", body)
	}
	if v, ok := got["filters"]; !ok || string(v) != "null" {
		t.Errorf("filters should marshal to an explicit null, got %q in %s", string(v), body)
	}
}

// Negative twin: a request that sets nothing must stay empty, or every update would clear the
// fields it did not mention.
func TestUpdateWebhookRequestOmitsUnsetFields(t *testing.T) {
	body, err := json.Marshal(UpdateWebhookRequest{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(body) != "{}" {
		t.Errorf("an empty update must marshal to {}, got %s", body)
	}
}

// The same shape for templates: header and footer are cleared with an empty string.
func TestUpdateTemplateRequestTransmitsEmptyHeaderAndFooter(t *testing.T) {
	empty := ""
	body, err := json.Marshal(UpdateTemplateRequest{Header: &empty, Footer: &empty})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, field := range []string{"header", "footer"} {
		if v, ok := got[field]; !ok || string(v) != `""` {
			t.Errorf("%s should marshal to an empty string, got %q in %s", field, string(v), body)
		}
	}
}
